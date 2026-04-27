/**
 * Purpose: Verify extension integration for presentation artifacts and tab targeting behavior.
 * Responsibilities: Assert persisted snapshot spills, batch rendering, click/open enrichment, restored-tab focus correction, and post-command re-selection.
 * Scope: Integration-style Node test-runner coverage around fake agent-browser executions; process wrapper and resume-state suites cover adjacent concerns.
 * Usage: Run with `npm test -- test/agent-browser.extension-tabs.test.ts` or via `npm run verify`.
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
			await runExtensionEvent(harness.handlers, "session_shutdown");
			assert.match(await readFile(String(spillPath), "utf8"), /Extension persisted snapshot row 120/);
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
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: true, href: "https://example.com/docs" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: "Destination Docs" }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: "https://example.com/docs" }));
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
			assert.equal(invocations.length, 3);
			assert.equal(invocations[0]?.args.includes("click"), true);
			assert.equal(invocations[1]?.args.includes("title"), true);
			assert.equal(invocations[2]?.args.includes("url"), true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension re-selects the navigated tab after profiled opens when restored tabs steal focus", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
    { tabId: "t2", title: "Grok", url: "https://grok.com/", active: true }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", title: "Example Domain", url: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "--profile", "Default", "open", "https://example.com"],
			});
			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.openResultTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.deepEqual(invocations[0]?.args, [
				"--json",
				"--session",
				"named",
				"--profile",
				"Default",
				"open",
				"https://example.com",
			]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "t1"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension pins the intended tab inside a follow-up command when reconnect drift would otherwise steal focus", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  let active = gemini;
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? exampleSite : gemini;
      return { command: step, success: true, result: active };
    }
    if (command === "click") {
      return { command: step, success: true, result: { clicked: rest[0] } };
    }
    if (command === "get" && rest[0] === "title") {
      return { command: step, success: true, result: active.title };
    }
    if (command === "get" && rest[0] === "url") {
      return { command: step, success: true, result: active.url };
    }
    return { command: step, success: true, result: active };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: false },
    { tabId: "t2", title: gemini.title, url: gemini.url, active: true }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: exampleSite }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.indexOf("click") + 1] } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: gemini.title }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: gemini.url }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: gemini }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const initialOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "--profile", "Default", "open", "https://example.com"],
			});
			assert.equal(initialOpen.isError, false, JSON.stringify(initialOpen));

			const clickedSelector = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(clickedSelector.isError, false);
			assert.equal(
				(clickedSelector.details?.navigationSummary as { title?: string } | undefined)?.title,
				"Example Domain",
			);
			assert.equal(
				(clickedSelector.details?.navigationSummary as { url?: string } | undefined)?.url,
				"https://example.com/",
			);
			assert.deepEqual(clickedSelector.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});
			assert.match((clickedSelector.content[0] as { text: string }).text, /Current page:/);
			assert.match((clickedSelector.content[0] as { text: string }).text, /Example Domain/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 5);
			assert.deepEqual(invocations[0]?.args, [
				"--json",
				"--session",
				"named",
				"--profile",
				"Default",
				"open",
				"https://example.com",
			]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "t1"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[4]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[4]?.stdin ?? "[]")), [
				["tab", "t1"],
				["click", "@e9"],
				["get", "title"],
				["get", "url"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps newer explicit-session tab target after overlapping opens", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const slow = { title: "Slow First", url: "https://example.com/slow-first" };
const fast = { title: "Fast Second", url: "https://example.com/fast-second" };
if (args.includes("https://example.com/slow-first")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  process.stdout.write(JSON.stringify({ success: true, data: slow }));
} else if (args.includes("https://example.com/fast-second")) {
  process.stdout.write(JSON.stringify({ success: true, data: fast }));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: slow.title, url: slow.url, active: true },
    { tabId: "t2", title: fast.title, url: fast.url, active: false }
  ] } }));
} else if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  const results = steps.map((step) => {
    const [command, subcommand] = step;
    if (command === "tab") {
      return { command: step, success: true, result: subcommand === "t2" ? fast : slow };
    }
    if (command === "click") {
      return { command: step, success: true, result: { clicked: subcommand } };
    }
    if (command === "get" && subcommand === "title") {
      return { command: step, success: true, result: fast.title };
    }
    if (command === "get" && subcommand === "url") {
      return { command: step, success: true, result: fast.url };
    }
    return { command: step, success: true, result: fast };
  });
  process.stdout.write(JSON.stringify(results));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: fast }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const slowOpenPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "open", "https://example.com/slow-first"],
			});
			await delay(5);
			const fastOpenPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "open", "https://example.com/fast-second"],
			});

			const [slowOpen, fastOpen] = await Promise.all([slowOpenPromise, fastOpenPromise]);
			assert.equal(slowOpen.isError, false, JSON.stringify(slowOpen));
			assert.equal(fastOpen.isError, false, JSON.stringify(fastOpen));

			const clickedSelector = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(clickedSelector.isError, false, JSON.stringify(clickedSelector));
			assert.deepEqual(clickedSelector.details?.sessionTabCorrection, {
				selectedTab: "t2",
				selectionKind: "tabId",
				targetTitle: "Fast Second",
				targetUrl: "https://example.com/fast-second",
			});
			assert.equal(
				(clickedSelector.details?.navigationSummary as { title?: string; url?: string } | undefined)?.title,
				"Fast Second",
			);
			assert.equal(
				(clickedSelector.details?.navigationSummary as { title?: string; url?: string } | undefined)?.url,
				"https://example.com/fast-second",
			);

			const invocations = await readInvocationLog(logPath);
			assert.equal(
				invocations.some((entry) =>
					entry.args.join("\u0000") === ["--json", "--session", "named", "open", "https://example.com/slow-first"].join("\u0000"),
				),
				true,
			);
			assert.equal(
				invocations.some((entry) =>
					entry.args.join("\u0000") === ["--json", "--session", "named", "open", "https://example.com/fast-second"].join("\u0000"),
				),
				true,
			);
			assert.deepEqual(invocations.at(-2)?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations.at(-1)?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations.at(-1)?.stdin ?? "[]")), [
				["tab", "t2"],
				["click", "@e9"],
				["get", "title"],
				["get", "url"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension re-selects the intended tab after a successful command when focus drifts afterward", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "tab-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
let state = { active: "example", tabListCount: 0 };
try {
  state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
} catch {}
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
if (args.includes("tab") && args.includes("list")) {
  state.tabListCount += 1;
  const activeKey = state.tabListCount === 1 ? "example" : state.active;
  const activeSite = activeKey === "example" ? exampleSite : gemini;
  const inactiveSite = activeKey === "example" ? gemini : exampleSite;
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: activeKey === "example" ? "t1" : "t2", title: activeSite.title, url: activeSite.url, active: true },
    { tabId: activeKey === "example" ? "t2" : "t1", title: inactiveSite.title, url: inactiveSite.url, active: false }
  ] } }));
} else if (args.includes("click")) {
  state.active = "gemini";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.indexOf("click") + 1], title: exampleSite.title, url: exampleSite.url } }));
} else if (args.includes("tab") && args.includes("t1")) {
  state.active = "example";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else {
  save();
  process.stdout.write(JSON.stringify({ success: true, data: exampleSite }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const clickedSelector = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(clickedSelector.isError, false, JSON.stringify(clickedSelector));
			assert.deepEqual(clickedSelector.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 4);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "click", "@e9"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "tab", "t1"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

