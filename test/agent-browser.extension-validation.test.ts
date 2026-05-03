/**
 * Purpose: Verify extension entrypoint validation and error contracts for the pi-agent-browser tool.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npm test -- test/agent-browser.extension-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	BRAVE_SEARCH_PROMPT_GUIDELINE,
	QUICK_START_GUIDELINES,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	TOOL_PROMPT_GUIDELINES_PREFIX,
	TOOL_PROMPT_GUIDELINES_SUFFIX,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
} from "../extensions/agent-browser/lib/playbook.js";
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
	runExtensionEventResults,
	withPatchedEnv,
	writeFakeAgentBrowserBinary
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension keeps the full browser playbook in tool metadata and only injects a minimal browser prompt when relevant", async () => {
	await withPatchedEnv({ BRAVE_API_KEY: "demo-key" }, async () => {
		const harness = createExtensionHarness({ cwd: process.cwd() });
		assert.deepEqual([...harness.handlers.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start", "tool_call"]);
		assert.equal(harness.tool.name, "agent_browser");
		assert.match(harness.tool.description, /authenticated\/profile-based browser work/);
		assert.match(harness.tool.promptSnippet, /real web workflows/);

		const expectedGuidelines = [
			...TOOL_PROMPT_GUIDELINES_PREFIX,
			...QUICK_START_GUIDELINES,
			SHARED_BROWSER_PLAYBOOK_GUIDELINES[0],
			BRAVE_SEARCH_PROMPT_GUIDELINE,
			...SHARED_BROWSER_PLAYBOOK_GUIDELINES.slice(1),
			...TOOL_PROMPT_GUIDELINES_SUFFIX,
		];
		for (const guideline of expectedGuidelines) {
			assert.equal(
				harness.tool.promptGuidelines.includes(guideline),
				true,
				`missing canonical playbook guideline: ${guideline}`,
			);
		}
		assert.equal(
			WRAPPER_TAB_RECOVERY_BEHAVIOR.some((line) => line.includes("After a successful command")),
			true,
		);

		const [genericTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
			harness.handlers,
			"before_agent_start",
			{ prompt: "Please review the repository architecture.", systemPrompt: "Base system prompt" },
			harness.ctx,
		);
		assert.equal(genericTurn, undefined);

		const [browserTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
			harness.handlers,
			"before_agent_start",
			{ prompt: "Open https://example.com and take a snapshot.", systemPrompt: "Base system prompt" },
			harness.ctx,
		);
		assert.equal(typeof browserTurn?.systemPrompt, "string");
		assert.equal(browserTurn?.systemPrompt.includes("Base system prompt"), true);
		assert.equal(browserTurn?.systemPrompt.includes("Project rule: when browser automation is needed"), true);
		assert.equal(browserTurn?.systemPrompt.includes("Quick start:"), false);
		assert.equal(browserTurn?.systemPrompt.includes("Browser operating playbook:"), false);
	});
});

test("agentBrowserExtension blocks direct and wrapped agent-browser bash unless the prompt, env, or package dev cwd explicitly allows it", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-bash-policy-"));
	const defaultHarness = createExtensionHarness({ cwd: tempDir, prompt: "Open a page and summarize it." });
	for (const command of [
		"agent-browser open https://example.com",
		"FOO=bar agent-browser --version",
		"FOO=\"bar baz\" agent-browser --version",
		"PATH=/tmp:$PATH agent-browser open https://example.com",
		"echo ready\nagent-browser open https://example.com",
		"which agent-browser && agent-browser open https://example.com",
		"cat <<'EOF'\nwhich agent-browser\nEOF\nagent-browser open https://example.com",
		"env agent-browser --version",
		"npx --yes agent-browser open https://example.com",
		"pnpm dlx agent-browser open https://example.com",
		"/opt/homebrew/bin/agent-browser open https://example.com",
	]) {
		const [blocked] = await runExtensionEventResults<{ block: boolean; reason?: string }>(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command } },
			defaultHarness.ctx,
		);
		assert.equal(blocked?.block, true, command);
		assert.match(blocked?.reason ?? "", /Use the native agent_browser tool instead of bash/i);
	}

	const inspectionAllowed = await runExtensionEventResults(
		defaultHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "which agent-browser" } },
		defaultHarness.ctx,
	);
	assert.deepEqual(inspectionAllowed, []);

	for (const command of [
		"echo agent-browser",
		"grep agent-browser README.md",
		"printf '%s\\n' agent-browser",
		"echo ok && grep agent-browser README.md",
		"cat <<'EOF'\nagent-browser open https://example.com\nEOF",
	]) {
		const innocuousResults = await runExtensionEventResults(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command } },
			defaultHarness.ctx,
		);
		assert.deepEqual(innocuousResults, [], command);
	}

	const debugHarness = createExtensionHarness({ cwd: tempDir, prompt: "Please debug the browser integration via bash." });
	const debugAllowed = await runExtensionEventResults(
		debugHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "npx --yes agent-browser open https://example.com" } },
		debugHarness.ctx,
	);
	assert.deepEqual(debugAllowed, []);

	await withPatchedEnv({ PI_AGENT_BROWSER_ALLOW_DIRECT_BASH: "1" }, async () => {
		const envAllowed = await runExtensionEventResults(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
			defaultHarness.ctx,
		);
		assert.deepEqual(envAllowed, []);
	});

	const packageDevDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-package-dev-"));
	await writeFile(join(packageDevDir, "package.json"), JSON.stringify({ name: "pi-agent-browser-native" }), "utf8");
	const packageDevHarness = createExtensionHarness({ cwd: packageDevDir, prompt: "Open a page and summarize it." });
	const packageDevAllowed = await runExtensionEventResults(
		packageDevHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
		packageDevHarness.ctx,
	);
	assert.deepEqual(packageDevAllowed, []);

	await rm(tempDir, { force: true, recursive: true });
	await rm(packageDevDir, { force: true, recursive: true });
});

test("agentBrowserExtension keeps successful plain-text inspection stateless and machine-readable", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write("agent-browser 9.9.9\\n");`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Open a page and summarize it." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--version"],
			});

			assert.equal(result.isError, false);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /agent-browser 9\.9\.9/);
			assert.equal(result.details?.inspection, true);
			assert.equal(result.details?.stdout, "agent-browser 9.9.9");
			assert.equal(result.details?.parseError, undefined);
			assert.equal(result.details?.sessionName, undefined);
			assert.equal(result.details?.usedImplicitSession, undefined);
			assert.deepEqual(await readInvocationLog(logPath), [{ args: ["--version"] }]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension normalizes and repairs explicit screenshot artifact paths", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-screenshot-path-"));
	const logPath = join(tempDir, "invocations.log");
	const upstreamTempPath = join(tempDir, "upstream-temp.png");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const commandIndex = args.indexOf("screenshot");
const requestedPath = args[commandIndex + 1];
fs.mkdirSync(path.dirname(${JSON.stringify(upstreamTempPath)}), { recursive: true });
fs.writeFileSync(${JSON.stringify(upstreamTempPath)}, "fake-png");
process.stdout.write(JSON.stringify({ success: true, data: { path: ${JSON.stringify(upstreamTempPath)} }, error: null }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Take a screenshot." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "warden-vfr", "screenshot", ".dogfood/run/foo.png"],
			});

			const expectedPath = join(tempDir, ".dogfood/run/foo.png");
			assert.equal(result.isError, false);
			assert.equal(await readFile(expectedPath, "utf8"), "fake-png");
			const text = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
			assert.match(text, /Saved image: \.dogfood\/run\/foo\.png/);
			assert.match(text, /Artifact type: image/);
			assert.match(text, /Requested path: \.dogfood\/run\/foo\.png/);
			assert.match(text, new RegExp(`Absolute path: ${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(text, /Exists: true/);
			assert.match(text, /Status: repaired-from-temp/);
			assert.match(text, new RegExp(`Temp path: ${upstreamTempPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(text, /Session: warden-vfr/);
			assert.match(text, new RegExp(`CWD: ${tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

			const artifacts = result.details?.artifacts as Array<Record<string, unknown>> | undefined;
			assert.equal(artifacts?.[0]?.requestedPath, ".dogfood/run/foo.png");
			assert.equal(artifacts?.[0]?.absolutePath, expectedPath);
			assert.equal(artifacts?.[0]?.cwd, tempDir);
			assert.equal(artifacts?.[0]?.session, "warden-vfr");
			assert.equal(artifacts?.[0]?.status, "repaired-from-temp");

			const [invocation] = await readInvocationLog(logPath);
			assert.equal(invocation.args.at(-1), expectedPath);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension renders explicit --json tool content as JSON", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-json-visible-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: { connected: true, enabled: true, port: 9223, screencasting: false }, error: null }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check stream status." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["stream", "status", "--json"],
			});

			const text = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
			const parsed = JSON.parse(text) as { data?: { wsUrl?: string; frameFormat?: string } };
			assert.equal(parsed.data?.wsUrl, "ws://127.0.0.1:9223");
			assert.equal(parsed.data?.frameFormat, "JSON messages with base64 JPEG frame data");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks per-step batch screenshot annotation foot-guns", async () => {
	const harness = createExtensionHarness({ cwd: process.cwd(), prompt: "Take annotated screenshots." });
	const result = await executeRegisteredTool(harness.tool, harness.ctx, {
		args: ["batch"],
		stdin: '[["screenshot","--annotate","/tmp/foo.png"]]',
	});

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text ?? "" : "", /put --annotate in top-level args/i);
});

test("agentBrowserExtension normalizes and repairs batch screenshot artifact paths", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-screenshot-path-"));
	const logPath = join(tempDir, "invocations.log");
	const upstreamTempPath = join(tempDir, "upstream-batch-temp.png");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin: JSON.parse(stdin) }) + "\\n");
  fs.mkdirSync(path.dirname(${JSON.stringify(upstreamTempPath)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(upstreamTempPath)}, "fake-batch-png");
  process.stdout.write(JSON.stringify([{ command: ["screenshot", ".dogfood/run/good-batch.png"], success: true, error: null, result: { path: ${JSON.stringify(upstreamTempPath)} } }]));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Take a batch screenshot." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--annotate", "batch"],
				stdin: '[["screenshot",".dogfood/run/good-batch.png"]]',
			});

			const expectedPath = join(tempDir, ".dogfood/run/good-batch.png");
			assert.equal(result.isError, false);
			assert.equal(await readFile(expectedPath, "utf8"), "fake-batch-png");
			const text = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
			assert.match(text, /Step 1 — screenshot/);
			assert.match(text, /Saved image: \.dogfood\/run\/good-batch\.png/);
			assert.match(text, /Requested path: \.dogfood\/run\/good-batch\.png/);
			assert.match(text, /Status: repaired-from-temp/);
			assert.match(text, new RegExp(`Temp path: ${upstreamTempPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

			const artifacts = result.details?.artifacts as Array<Record<string, unknown>> | undefined;
			assert.equal(artifacts?.[0]?.requestedPath, ".dogfood/run/good-batch.png");
			assert.equal(artifacts?.[0]?.absolutePath, expectedPath);
			assert.equal(artifacts?.[0]?.status, "repaired-from-temp");

			const [invocation] = await readInvocationLog(logPath);
			assert.deepEqual(invocation.stdin, [["screenshot", expectedPath]]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension guards wrapper-known trace and profiler ownership", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-trace-owner-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: { started: true }, error: null }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Capture a trace." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const traceStart = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "debug-session", "trace", "start"],
			});
			assert.equal(traceStart.isError, false);

			const profilerStart = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "debug-session", "profiler", "start"],
			});
			assert.equal(profilerStart.isError, true);
			assert.match(profilerStart.content[0]?.type === "text" ? profilerStart.content[0].text ?? "" : "", /Wrapper believes trace tracing is active/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports the documented missing agent-browser binary contract", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-missing-bin-"));

	try {
		await withPatchedEnv({ PATH: tempDir }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Open a page and summarize it." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--version"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /agent-browser is required but was not found on PATH\./);
			assert.match(text, /This project does not bundle agent-browser\./);
			assert.match(text, /pi-agent-browser-doctor/);
			assert.match(text, /package\/PATH diagnostics/);
			assert.match(text, /https:\/\/agent-browser\.dev\//);
			assert.match(text, /https:\/\/github\.com\/vercel-labs\/agent-browser/);
			assert.match(String(result.details?.spawnError ?? ""), /ENOENT/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

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

test("agentBrowserExtension rejects dangling value-taking flags before spawning agent-browser", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { args } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /requires a value immediately after it/i);
			assert.equal(
				(result.details?.invalidValueFlag as { flag?: string; reason?: string } | undefined)?.flag,
				"--session",
			);
			assert.equal(
				(result.details?.invalidValueFlag as { flag?: string; reason?: string } | undefined)?.reason,
				"missing-value",
			);
			assert.deepEqual(await readInvocationLog(logPath), []);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

const MISSING_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: missing boolean success field.";

test("agentBrowserExtension rejects malformed JSON envelopes that omit success", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ error: "boom" }));`,
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
			assert.equal((result.content[0] as { text: string }).text, MISSING_SUCCESS_PARSE_ERROR);
			assert.equal(result.details?.parseError, MISSING_SUCCESS_PARSE_ERROR);
			assert.equal(result.details?.summary, MISSING_SUCCESS_PARSE_ERROR);
			assert.doesNotMatch(String(result.details?.summary ?? ""), /^open completed$/i);
			assert.equal(result.details?.error, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension forwards wait --download saved-file metadata in details", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-wait-download-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: { path: "/tmp/export.csv", elapsedMs: 64 } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "--download", "/tmp/export.csv"],
			});

			assert.equal(result.isError, false);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Download completed: \/tmp\/export\.csv/);
			assert.equal(result.details?.savedFilePath, "/tmp/export.csv");
			assert.deepEqual(result.details?.savedFile, {
				command: "wait",
				kind: "download",
				metadata: { elapsedMs: 64 },
				path: "/tmp/export.csv",
				subcommand: "--download",
			});
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

