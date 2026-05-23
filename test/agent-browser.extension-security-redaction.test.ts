/**
 * Purpose: Verify extension redaction, auth password stdin, and confirmation recovery contracts.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Theme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import {
	BRAVE_SEARCH_PROMPT_GUIDELINE,
	QUICK_START_GUIDELINES,
	buildInstalledDocsGuideline,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	TOOL_PROMPT_GUIDELINES_PREFIX,
	TOOL_PROMPT_GUIDELINES_SUFFIX,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
} from "../extensions/agent-browser/lib/playbook.js";
import {
	discoverElectronApps,
	ELECTRON_DISCOVERY_MAX_RESULTS,
	type ElectronAppDiscovery,
} from "../extensions/agent-browser/lib/electron/discovery.js";
import {
	cleanupElectronLaunchResources,
} from "../extensions/agent-browser/lib/electron/cleanup.js";
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
	runExtensionEventResults,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
	type AgentBrowserToolParams,
	type AgentBrowserToolRenderContext,
} from "./helpers/agent-browser-harness.js";

import {
	PLAIN_RENDER_THEME,
	createRenderContext,
	electronAppNames,
	fakeAgentBrowserLifecycleScript,
	isTestPidAlive,
	readOptionalFakeElectronLaunchLog,
	stopTestPid,
	waitForTestPidExit,
	writeFakeLaunchableElectronApp,
	writeFakeLinuxElectronBinary,
	writeFakeMacElectronApp,
} from "./helpers/extension-validation-fixtures.js";

test("agentBrowserExtension redacts sensitive args in updates and persisted details", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: { title: "ok", url: "https://user:pass@example.com/?token=abc" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const updates: unknown[] = [];
			const result = (await harness.tool.execute(
				"test-tool-call",
				{ args: ["--headers", '{"Authorization":"Bearer s3cr3t-demo"}', "open", "https://user:pass@example.com/?token=abc"] },
				new AbortController().signal,
				(update) => updates.push(update),
				harness.ctx,
			)) as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean };

			assert.equal(result.isError, false);
			assert.equal(Array.isArray(updates), true);
			const update = updates[0] as { content?: Array<{ text?: string }>; details?: Record<string, unknown> } | undefined;
			assert.match(update?.content?.[0]?.text ?? "", /\[REDACTED\]/);
			assert.doesNotMatch(update?.content?.[0]?.text ?? "", /s3cr3t-demo/);
			assert.doesNotMatch(update?.content?.[0]?.text ?? "", /user:pass/);
			assert.deepEqual(result.details?.args, [
				"--headers",
				"[REDACTED]",
				"open",
				"https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/?token=%5BREDACTED%5D",
			]);
			assert.equal(JSON.stringify(result.details?.effectiveArgs).includes("s3cr3t-demo"), false);
			assert.equal(JSON.stringify(result.details?.effectiveArgs).includes("user:pass"), false);
			assert.equal(JSON.stringify(result.details?.data).includes("user:pass"), false);
			assert.equal(JSON.stringify(result.content).includes("user:pass"), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allows auth password stdin without echoing the secret in tool details", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-auth-stdin-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
process.stderr.write("stderr echo: " + stdin);
process.stdout.write(JSON.stringify({ success: true, data: { saved: true, echoed: stdin, nested: { arbitrary: stdin } } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const updates: unknown[] = [];
			const result = (await harness.tool.execute(
				"test-tool-call",
				{ args: ["auth", "save", "demo", "--password-stdin"], stdin: "pin" },
				new AbortController().signal,
				(update) => updates.push(update),
				harness.ctx,
			)) as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean };

			assert.equal(result.isError, false);
			const [invocation] = await readInvocationLog(logPath);
			assert.deepEqual(invocation?.args, ["--json", "--session", result.details?.sessionName, "auth", "save", "demo", "--password-stdin"]);
			assert.equal(invocation?.stdin, "pin");
			assert.equal(JSON.stringify(updates).includes("pin"), false);
			assert.equal(JSON.stringify(result.details).includes("pin"), false);
			assert.equal(JSON.stringify(result.content).includes("pin"), false);
			assert.equal(JSON.stringify(result.details).includes("[REDACTED]"), true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension redacts auth password stdin echoed in upstream failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-auth-error-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
process.stderr.write("stderr echo: " + stdin);
process.stdout.write(JSON.stringify({ success: false, error: "error echo: " + stdin, data: { arbitrary: stdin } }));
process.exit(1);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["auth", "save", "demo", "--password-stdin"],
				stdin: "super-secret-password",
			});

			assert.equal(result.isError, true);
			assert.equal(JSON.stringify(result.content).includes("super-secret-password"), false);
			assert.equal(JSON.stringify(result.details).includes("super-secret-password"), false);
			assert.match(JSON.stringify(result.content), /\[REDACTED\]/);
			assert.match(JSON.stringify(result.details), /\[REDACTED\]/);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "upstream-error");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension redacts auth password stdin in preserved parse-failure spill files", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-auth-parse-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
process.stdout.write("invalid-json " + stdin + " " + "x".repeat(600000));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["auth", "save", "demo", "--password-stdin"],
				stdin: "super-secret-password",
			});

			assert.equal(result.isError, true);
			assert.equal(JSON.stringify(result.content).includes("super-secret-password"), false);
			assert.equal(JSON.stringify(result.details).includes("super-secret-password"), false);
			assert.equal(typeof result.details?.fullOutputPath, "string");
			const fullOutput = await readFile(String(result.details?.fullOutputPath), "utf8");
			assert.doesNotMatch(fullOutput, /super-secret-password/);
			assert.match(fullOutput, /\[REDACTED\]/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension renders confirmation recovery and redacts sensitive confirmation context", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-confirm-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: false, data: { confirmation_required: true, confirmation_id: "c_sensitive", action: "POST https://user:pass@example.com/delete?token=secret Authorization: Bearer raw-token" } }));
process.exit(1);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--confirm-actions", "click", "click", "@danger"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /Confirmation required\./);
			assert.match(text, /Pending confirmation id: c_sensitive/);
			assert.match(text, /\["confirm", "c_sensitive"\]/);
			assert.match(text, /\["deny", "c_sensitive"\]/);
			assert.match(String(result.details?.summary ?? ""), /Confirmation required: c_sensitive/);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "confirmation-required");
			const nextActions = result.details?.nextActions as Array<{ params?: { args: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.params?.args), [["confirm", "c_sensitive"], ["deny", "c_sensitive"]]);
			assert.doesNotMatch(JSON.stringify(result.content), /user:pass|raw-token|token=secret/);
			assert.doesNotMatch(JSON.stringify(result.details), /user:pass|raw-token|token=secret/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension passes confirm and deny recovery calls through to upstream", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-confirm-deny-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("confirm")) process.stdout.write(JSON.stringify({ success: true, data: "Action confirmed" }));
else if (args.includes("deny")) process.stdout.write(JSON.stringify({ success: true, data: "Action denied" }));
else process.stdout.write(JSON.stringify({ success: true, data: "ok" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const confirmed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["confirm", "c_demo"] });
			assert.equal(confirmed.isError, false);
			assert.match((confirmed.content[0] as { text: string }).text, /Action confirmed/);

			const denied = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["deny", "c_demo"] });
			assert.equal(denied.isError, false);
			assert.match((denied.content[0] as { text: string }).text, /Action denied/);

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-2), ["confirm", "c_demo"]);
			assert.deepEqual(invocations[1]?.args.slice(-2), ["deny", "c_demo"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
