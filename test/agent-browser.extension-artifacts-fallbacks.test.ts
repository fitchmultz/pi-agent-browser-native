/**
 * Purpose: Verify extension entrypoint artifact fallback and parse-spill contracts.
 * Responsibilities: Assert download verification fallback, stale-ref guidance, direct/wrapper fallback failures, and oversized parse-spill handling.
 * Scope: Integration-style Node test-runner coverage split out of the broad extension-validation suite.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-artifacts-fallbacks.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	cleanupSecureTempArtifacts,
	createSecureTempDirectory,
} from "../extensions/agent-browser/lib/temp.js";
import {
	TEST_SESSION_ID,
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension returns retry next actions for failed direct download verification", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-direct-download-failure-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: false, error: "Download not verified: file missing at /tmp/export.csv" }));
process.exit(1);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["download", "@e1", "/tmp/export.csv"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "download-not-verified");
			const nextActions = result.details?.nextActions as Array<{ params?: { args: string[] } }> | undefined;
			assert.deepEqual(nextActions?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps stale-ref guidance when tab pinning wraps a command in batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stale-ref-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["tab", "t1"], success: true, result: { tabId: "t1" } },
    { command: ["click", "@e4"], success: false, error: "Could not locate element with role=button name=Old" }
  ]));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
  { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
  { tabId: "t2", title: "Other", url: "https://other.example/", active: true }
] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({
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
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "click", "@e4"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /Could not locate element/);
			assert.match(text, /@ref may be stale/);
			assert.match(text, /snapshot/);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "stale-ref");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps stale-ref guidance for user batch stdin wrapped by tab pinning", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stale-batch-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["tab", "t1"], success: true, result: { tabId: "t1" } },
    { command: ["click", "@e4"], success: false, error: "Could not locate element with role=button name=Old" }
  ]));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
  { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
  { tabId: "t2", title: "Other", url: "https://other.example/", active: true }
] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({
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
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "batch"],
				stdin: JSON.stringify([["click", "@e4"]]),
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /Could not locate element/);
			assert.match(text, /@ref may be stale/);
			assert.match(text, /snapshot/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports direct fallback failures with the effective invocation", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: false, data: { title: "Wrong page" } }));
process.exit(1);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /^agent-browser --json --session \S+ open https:\/\/example\.com\/? reported failure \(exit code 1\)\.$/);
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(0, 3), ["--json", "--session", result.details?.sessionName]);
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-2), ["open", "https://example.com/"]);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "upstream-error");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports wrapper-assisted fallback failures with effective batch context", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["tab", "t1"], success: true, result: { tabId: "t1" } },
    { command: ["get", "title"], success: false, result: { title: "Wrong page" } }
  ]));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
  { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
  { tabId: "t2", title: "Other", url: "https://other.example/", active: true }
] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({
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
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "get", "title"],
			});

			assert.equal(result.isError, true, JSON.stringify(result));
			assert.equal(result.content[0]?.type, "text");
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /agent-browser --json --session named batch reported failure \(exit code 1\)\./);
			assert.match(text, /Wrapper recovery hint:/);
			assert.match(text, /tab list/);
			assert.deepEqual(result.details?.effectiveArgs, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String((await readInvocationLog(logPath))[1]?.stdin ?? "[]")), [["tab", "t1"], ["get", "title"]]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves full spilled stdout for oversized parse failures", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-dir-"));
	const sessionFile = join(sessionDir, "session.jsonl");
	const basePath = process.env.PATH ?? "";
	const sentinel = "RQ-0006-parse-failure-sentinel";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write("x".repeat(600000) + ${JSON.stringify(sentinel)});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionDir, sessionFile });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["snapshot", "-i"],
			});

			assert.equal(result.isError, true);
			assert.match(String(result.details?.parseError ?? ""), /invalid JSON/i);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Full output path: /);
			assert.equal(typeof result.details?.fullOutputPath, "string");
			assert.equal(result.details?.fullOutputUnavailable, undefined);
			const fullOutputPath = result.details?.fullOutputPath as string;
			assert.equal(fullOutputPath.startsWith(join(sessionDir, ".pi-agent-browser-artifacts", TEST_SESSION_ID)), true);
			const manifest = result.details?.artifactManifest as { entries?: Array<{ path?: string; retentionState?: string; storageScope?: string }>; liveCount?: number } | undefined;
			assert.equal(manifest?.liveCount, 1);
			assert.equal(manifest?.entries?.[0]?.path, fullOutputPath);
			assert.equal(manifest?.entries?.[0]?.retentionState, "live");
			assert.equal(manifest?.entries?.[0]?.storageScope, "persistent-session");
			assert.match(String(result.details?.artifactRetentionSummary), /1 live, 0 evicted/);
			const stats = await stat(fullOutputPath);
			assert.ok(stats.size > 512 * 1024);
			assert.match(await readFile(fullOutputPath, "utf8"), new RegExp(`${sentinel}$`));
			await runExtensionEvent(harness.handlers, "session_shutdown");
			assert.match(await readFile(fullOutputPath, "utf8"), new RegExp(`${sentinel}$`));
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension persists parse-failure output when only a session directory is available", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-dir-only-"));
	const basePath = process.env.PATH ?? "";
	const sentinel = "RQ-0006-session-dir-only-sentinel";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write("x".repeat(600000) + ${JSON.stringify(sentinel)});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["snapshot", "-i"],
			});

			assert.equal(result.isError, true);
			const fullOutputPath = result.details?.fullOutputPath;
			assert.equal(typeof fullOutputPath, "string");
			if (typeof fullOutputPath !== "string") assert.fail("expected fullOutputPath to be a string");
			assert.equal(fullOutputPath.startsWith(join(sessionDir, ".pi-agent-browser-artifacts", TEST_SESSION_ID)), true);
			const manifest = result.details?.artifactManifest as { entries?: Array<{ path?: string; retentionState?: string; storageScope?: string }>; liveCount?: number } | undefined;
			assert.equal(manifest?.liveCount, 1);
			assert.equal(manifest?.entries?.[0]?.path, fullOutputPath);
			assert.equal(manifest?.entries?.[0]?.retentionState, "live");
			assert.equal(manifest?.entries?.[0]?.storageScope, "persistent-session");
			assert.match(await readFile(fullOutputPath, "utf8"), new RegExp(`${sentinel}$`));
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns temp full-output path for oversized parse failures without session artifacts", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	const sentinel = "RQ-0006-temp-parse-failure-sentinel";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write("x".repeat(600000) + ${JSON.stringify(sentinel)});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "document.body.innerText",
			});

			assert.equal(result.isError, true);
			assert.match(String(result.details?.parseError ?? ""), /invalid JSON/i);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Full output path: /);
			assert.equal(typeof result.details?.fullOutputPath, "string");
			assert.equal(result.details?.fullOutputUnavailable, undefined);
			const fullOutputPath = result.details?.fullOutputPath as string;
			const manifest = result.details?.artifactManifest as { entries?: Array<{ path?: string; retentionState?: string; storageScope?: string }>; liveCount?: number } | undefined;
			assert.equal(manifest?.liveCount, 0);
			assert.equal(manifest?.entries?.[0]?.path, fullOutputPath);
			assert.equal(manifest?.entries?.[0]?.retentionState, "ephemeral");
			assert.equal(manifest?.entries?.[0]?.storageScope, "process-temp");
			assert.match(String(result.details?.artifactRetentionSummary), /0 live, 0 evicted, 1 ephemeral/);
			const stats = await stat(fullOutputPath);
			assert.ok(stats.size > 512 * 1024);
			assert.match(await readFile(fullOutputPath, "utf8"), new RegExp(`${sentinel}$`));
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
	}
});
