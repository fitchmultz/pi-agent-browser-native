/**
 * Purpose: Verify extension integration for presentation artifacts and non-recovery tab targeting behavior.
 * Responsibilities: Assert persisted snapshot spills, batch rendering, click/open enrichment, and routine tab-target state handling.
 * Scope: Integration-style Node test-runner coverage around fake agent-browser executions; process wrapper and resume-state suites cover adjacent concerns.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-tabs.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests run serially where they patch env or secure temp state and do not require a real browser.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	cleanupSecureTempArtifacts
} from "../extensions/agent-browser/lib/temp.js";
import {
	TEST_SESSION_ID,
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension persists compact snapshot spill files for persisted sessions across shutdown cleanup", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-dir-"));
	const sessionFile = join(sessionDir, "session.jsonl");
	const basePath = process.env.PATH ?? "";
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Extension persisted control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => `- generic \"Extension persisted snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n");
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: ${JSON.stringify({ origin: "https://example.com/persisted-extension", refs, snapshot })} }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionDir, sessionFile });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(result.isError, false);
			const spillPath = result.details?.fullOutputPath as string | undefined;
			assert.equal(typeof spillPath, "string");
			assert.equal(spillPath?.startsWith(join(sessionDir, ".pi-agent-browser-artifacts", TEST_SESSION_ID)), true);
			const manifest = result.details?.artifactManifest as { entries?: Array<{ path?: string; retentionState?: string; storageScope?: string }>; liveCount?: number } | undefined;
			assert.equal(manifest?.liveCount, 1);
			assert.equal(manifest?.entries?.[0]?.path, spillPath);
			assert.equal(manifest?.entries?.[0]?.retentionState, "live");
			assert.equal(manifest?.entries?.[0]?.storageScope, "persistent-session");
			assert.match(String(result.details?.artifactRetentionSummary), /1 live, 0 evicted/);
			await runExtensionEvent(harness.handlers, "session_shutdown");
			assert.match(await readFile(String(spillPath), "utf8"), /Extension persisted snapshot row 120/);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension restores artifact manifest from branch history and reports later evictions", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-manifest-resume-"));
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-manifest-resume-"));
	const sessionFile = join(sessionDir, "session.jsonl");
	const basePath = process.env.PATH ?? "";
	const counterPath = join(tempDir, "counter.txt");
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Resume manifest control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const buildData = (label: string) => ({
		origin: `https://example.com/${label}`,
		refs,
		snapshot: Array.from({ length: 120 }, (_, index) => `- generic \"${label} resume manifest row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n"),
	});
	const firstData = buildData("first");
	const secondData = buildData("second");
	const budgetBytes = Math.max(
		Buffer.byteLength(JSON.stringify(firstData, null, 2)),
		Buffer.byteLength(JSON.stringify(secondData, null, 2)),
	) + 512;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`
const fs = require("node:fs");
const counterPath = ${JSON.stringify(counterPath)};
const count = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, "utf8") : "0") + 1;
fs.writeFileSync(counterPath, String(count));
const data = count === 1 ? ${JSON.stringify(firstData)} : ${JSON.stringify(secondData)};
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: String(budgetBytes) }, async () => {
			const firstHarness = createExtensionHarness({ cwd: tempDir, sessionDir, sessionFile });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);
			const firstResult = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(firstResult.isError, false);
			const firstPath = firstResult.details?.fullOutputPath as string | undefined;
			assert.equal(typeof firstPath, "string");
			assert.equal((firstResult.details?.artifactManifest as { liveCount?: number } | undefined)?.liveCount, 1);
			await runExtensionEvent(firstHarness.handlers, "session_shutdown");

			const resumedHarness = createExtensionHarness({
				branch: [createToolBranchEntry({ details: firstResult.details as Record<string, unknown> })],
				cwd: tempDir,
				sessionDir,
				sessionFile,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);
			const secondResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(secondResult.isError, false);
			const secondPath = secondResult.details?.fullOutputPath as string | undefined;
			assert.equal(typeof secondPath, "string");
			assert.equal(await readFile(String(firstPath), "utf8").then(() => true, () => false), false);
			assert.match(await readFile(String(secondPath), "utf8"), /second resume manifest row 120/);
			const manifest = secondResult.details?.artifactManifest as { entries?: Array<{ path?: string; retentionState?: string }>; evictedCount?: number; liveCount?: number } | undefined;
			assert.equal(manifest?.liveCount, 1);
			assert.equal(manifest?.evictedCount, 1);
			assert.equal(manifest?.entries?.some((entry) => entry.path === firstPath && entry.retentionState === "evicted"), true);
			assert.equal(manifest?.entries?.some((entry) => entry.path === secondPath && entry.retentionState === "live"), true);
			assert.match(String(secondResult.details?.artifactRetentionSummary), /1 live, 1 evicted/);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves rich batch rendering and inline screenshot attachments", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const imagePath = join(tempDir, "batched.png");
	const basePath = process.env.PATH ?? "";
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify([
  { command: ["open", "https://example.com"], success: true, result: { title: "Example Domain", url: "https://example.com/" } },
  { command: ["screenshot"], success: true, result: { path: "batched.png" } }
]));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: "[]" });
			assert.equal(result.isError, false);
			assert.equal(result.content[0]?.type, "text");
			assert.equal(result.content[1]?.type, "image");
			assert.match((result.content[0] as { text: string }).text, /Step 2 — screenshot/);
			assert.match((result.content[0] as { text: string }).text, /1 inline image attachment below/);
			assert.equal((result.details?.imagePath as string | undefined)?.endsWith("batched.png"), true);
			assert.deepEqual(result.details?.imagePaths, [imagePath]);
			assert.equal(Array.isArray(result.details?.batchSteps), true);
			assert.equal((result.details?.batchSteps as Array<{ imagePath?: string }>)[1]?.imagePath, imagePath);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves mixed batch failure rendering while still marking the tool call as an error", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify([
  { command: ["open", "https://example.com"], success: true, result: { title: "Example Domain", url: "https://example.com/" } },
  { command: ["click", "@zzz"], success: false, error: "Unknown ref: zzz" }
]));
process.exitCode = 1;`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: "[]" });
			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Batch failed: 1\/2 succeeded/);
			assert.match((result.content[0] as { text: string }).text, /First failing step: 2 — click @zzz/);
			assert.match((result.content[0] as { text: string }).text, /Step 1 — open https:\/\/example.com\/? \(succeeded\)/);
			assert.match((result.content[0] as { text: string }).text, /Example Domain/);
			assert.match((result.content[0] as { text: string }).text, /Step 2 — click @zzz \(failed\)/);
			assert.match((result.content[0] as { text: string }).text, /Error: Unknown ref: zzz/);
			assert.match((result.content[0] as { text: string }).text, /snapshot -i/);
			assert.match((result.content[0] as { text: string }).text, /find role\|text\|label/);
			assert.match((result.content[0] as { text: string }).text, /scrollintoview/);
			assert.equal((result.details?.summary as string | undefined)?.includes("Batch failed: 1/2 succeeded"), true);
			assert.equal((result.details?.exitCode as number | undefined) ?? 0, 1);
			assert.equal((result.details?.batchFailure as { failedStep?: { index?: number; commandText?: string } } | undefined)?.failedStep?.index, 1);
			assert.equal(
				(result.details?.batchFailure as { failedStep?: { index?: number; commandText?: string } } | undefined)?.failedStep
					?.commandText,
				"click @zzz",
			);
			assert.equal(Array.isArray(result.details?.batchSteps), true);
			assert.equal((result.details?.stderr as string | undefined) ?? "", "");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension enriches click results with a post-navigation title and url summary", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: true, href: "https://example.com/docs" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Destination Docs", url: "https://example.com/docs" } } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "click", "@e2"],
			});
			assert.equal(result.isError, false);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Clicked: true/);
			assert.match((result.content[0] as { text: string }).text, /Href: https:\/\/example.com\/docs/);
			assert.match((result.content[0] as { text: string }).text, /Current page:/);
			assert.match((result.content[0] as { text: string }).text, /Destination Docs/);
			assert.equal(
				(result.details?.navigationSummary as { title?: string; url?: string } | undefined)?.title,
				"Destination Docs",
			);
			assert.equal(
				(result.details?.navigationSummary as { title?: string; url?: string } | undefined)?.url,
				"https://example.com/docs",
			);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.equal(invocations[0]?.args.includes("click"), true);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "eval", "--stdin"]);
			assert.equal(invocations[1]?.stdin, "({ title: document.title, url: location.href })");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension avoids routine tab-list probes for ordinary same-session clicks", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-no-routine-tab-list-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://example.com/", refs: { e1: { role: "link", name: "Docs" } }, snapshot: '- link "Docs" [ref=e1]' } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Docs", url: "https://example.com/docs" } } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com/"],
				sessionMode: "fresh",
			});
			assert.equal(open.isError, false, JSON.stringify(open));
			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(click.isError, false, JSON.stringify(click));
			assert.deepEqual(click.details?.navigationSummary, { title: "Docs", url: "https://example.com/docs" });

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations.map((entry) => entry.args.slice(-2).join(" ")), [
				"open https://example.com/",
				"snapshot -i",
				"eval --stdin",
				"click @e1",
				"eval --stdin",
			]);
			assert.equal(invocations.some((entry) => entry.args.includes("tab") && entry.args.includes("list")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not treat arbitrary batch eval title/url results as session navigation", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-eval-target-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://example.com/", refs: { e1: { role: "button", name: "Add" } }, snapshot: '- button "Add" [ref=e1]' } }));
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["eval", "({ title: document.querySelector('a').textContent, url: document.querySelector('a').href })"], success: true, result: { origin: "https://example.com/", result: { title: "Product details", url: "https://example.com/products/1" } } }
  ]));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Example Domain", url: "https://example.com/" } } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com/"],
				sessionMode: "fresh",
			});
			assert.equal(open.isError, false, JSON.stringify(open));
			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			const extraction = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["eval", "({ title: document.querySelector('a').textContent, url: document.querySelector('a').href })"]]),
			});
			assert.equal(extraction.isError, false, JSON.stringify(extraction));
			assert.deepEqual(extraction.details?.sessionTabTarget, { title: undefined, url: "https://example.com/" });

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(click.isError, false, JSON.stringify(click));
			assert.notEqual(click.details?.failureCategory, "stale-ref");
			assert.deepEqual(click.details?.sessionTabTarget, { title: "Example Domain", url: "https://example.com/" });
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
