/**
 * Purpose: Verify extension entrypoint artifact fallback and parse-spill contracts.
 * Responsibilities: Assert download verification fallback, stale-ref guidance, direct/wrapper fallback failures, and oversized parse-spill handling.
 * Scope: Integration-style Node test-runner coverage split out of the broad extension-validation suite.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-artifacts-fallbacks.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	cleanupSecureTempArtifacts,
} from "../extensions/agent-browser/lib/temp.js";
import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension leaves download execution upstream-owned on local and remote pages", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-native-download-"));
	const logPath = join(tempDir, "invocations.log");
	await writeFakeAgentBrowserBinary(tempDir, `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("download")) {
  const path = args.at(-1);
  fs.writeFileSync(path, "native-download");
  console.log(JSON.stringify({ success: true, data: { path } }));
} else {
  console.log(JSON.stringify({ success: true, data: { url: process.env.PI_AGENT_BROWSER_TEST_PAGE_URL } }));
}
`);
	try {
		for (const url of ["http://127.0.0.1:12345/", "https://fixture.test/"]) {
			await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH}`, PI_AGENT_BROWSER_TEST_PAGE_URL: url }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				const path = join(tempDir, "downloads", "report.csv");
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["download", "#export", path] });
				assert.equal(result.isError, false, result.content[0]?.text);
				assert.equal(await readFile(path, "utf8"), "native-download");
				assert.equal((result.details?.artifactVerification as { verified?: boolean })?.verified, true);
			});
		}
		const invocations = await readInvocationLog(logPath);
		assert.equal(invocations.filter(call => call.args.includes("download")).length, 2);
		assert.equal(invocations.some(call => call.args.includes("eval")), false, "download must not be replaced with an in-page fetch");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("agentBrowserExtension returns retry next actions for failed direct download verification", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-direct-download-failure-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: false, error: "Download not verified: file missing at /tmp/export.csv" }));
process.exit(1);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["download", "@e1", "/tmp/export.csv"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "download-not-verified");
			const nextActions = result.details?.nextActions as Array<{ params?: { args: string[] } }> | undefined;
			assert.deepEqual(nextActions?.[0]?.params?.args, ["--session", result.details?.sessionName, "wait", "--download", "/tmp/export.csv"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps stale-ref guidance after same-tab verification", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stale-ref-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://example.com/" } }));
  process.exit(0);
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: false, error: "Could not locate element with role=button name=Old" }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
  { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: true },
  { tabId: "t2", title: "Other", url: "https://other.example/", active: false }
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
			assert.match(text, /(?:@ref may be stale|ref may be stale)/);
			assert.match(text, /snapshot/);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "stale-ref");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps per-step stale-ref guidance for a verified user batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stale-batch-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://example.com/" } }));
  process.exit(0);
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["click", "@e4"], success: false, error: "Could not locate element with role=button name=Old" }
  ]));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
  { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: true },
  { tabId: "t2", title: "Other", url: "https://other.example/", active: false }
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
			assert.match(text, /refresh-interactive-refs/);
			assert.match(text, /snapshot/);
			assert.equal((result.details?.batchSteps as Array<{ failureCategory: string }>)[0].failureCategory, "stale-ref");
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
			assert.match(text, /^agent-browser --args --no-startup-window --json --session \S+ open https:\/\/example\.com\/? reported failure \(exit code 1\)\.$/m);
			assert.match(text, /inspect-page-after-navigation-error/);
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(0, 5), ["--args", "--no-startup-window", "--json", "--session", result.details?.sessionName]);
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-2), ["open", "https://example.com"]);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "upstream-error");
			const implicitAction = (result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined)?.find((action) => action.id === "inspect-page-after-navigation-error");
			assert.deepEqual(implicitAction?.params?.args, ["--session", result.details?.sessionName, "get", "url"]);

			const namedResult = await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "prod" }, async () => executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--namespace", "", "--session", "named", "open", "https://example.com"],
			}));
			const namedAction = (namedResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined)?.find((action) => action.id === "inspect-page-after-navigation-error");
			assert.equal(namedResult.details?.namespace, "");
			assert.deepEqual(namedResult.details?.effectiveArgs, ["--args", "--no-startup-window", "--json", "--namespace", "", "--session", "named", "open", "https://example.com"]);
			assert.deepEqual(namedAction?.params?.args, ["--namespace", "", "--session", "named", "get", "url"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension discards oversized malformed output instead of persisting browser secrets", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-dir-"));
	const sessionFile = join(sessionDir, "session.jsonl");
	const basePath = process.env.PATH ?? "";
	const sentinel = "RQ-0006-parse-failure-sentinel";
	const restoreKey = `piab-r2-${"a".repeat(32)}`;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write("x".repeat(600000) + ${JSON.stringify(restoreKey + sentinel)});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionDir, sessionFile });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["state", "show", "caller-owned.json"],
			});

			assert.equal(result.isError, true);
			assert.match(String(result.details?.parseError ?? ""), /invalid JSON/i);
			assert.equal(result.details?.fullOutputPath, undefined);
			assert.match(String(result.details?.fullOutputUnavailable ?? ""), /discarded because it may contain sensitive browser data/);
			assert.equal(result.details?.artifactManifest, undefined);
			assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
			assert.doesNotMatch(JSON.stringify(result), /piab-r2-[a-f\d]{32}/);
			await runExtensionEvent(harness.handlers, "session_shutdown");
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension discards malformed spills when only a session directory is available", { concurrency: false }, async () => {
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
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["snapshot", "-i"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.fullOutputPath, undefined);
			assert.match(String(result.details?.fullOutputUnavailable ?? ""), /discarded because it may contain sensitive browser data/);
			assert.equal(result.details?.artifactManifest, undefined);
			assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension discards malformed spills without session artifacts", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	const sentinel = "RQ-0006-temp-parse-failure-sentinel";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write("x".repeat(600000) + ${JSON.stringify(sentinel)});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "document.body.innerText",
			});

			assert.equal(result.isError, true);
			assert.match(String(result.details?.parseError ?? ""), /invalid JSON/i);
			assert.equal(result.details?.fullOutputPath, undefined);
			assert.match(String(result.details?.fullOutputUnavailable ?? ""), /discarded because it may contain sensitive browser data/);
			assert.equal(result.details?.artifactManifest, undefined);
			assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
	}
});
