/**
 * Purpose: Verify extension entrypoint validation and error contracts for the pi-agent-browser tool.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npm test -- test/agent-browser.extension-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";

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
	writeFakeAgentBrowserBinary,
	type AgentBrowserToolParams,
	type AgentBrowserToolRenderContext,
} from "./helpers/agent-browser-harness.js";

const PLAIN_RENDER_THEME = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `**${text}**`,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

function createRenderContext(options: {
	args: AgentBrowserToolParams;
	expanded?: boolean;
	isError?: boolean;
	lastComponent?: AgentBrowserToolRenderContext["lastComponent"];
}): AgentBrowserToolRenderContext {
	return {
		args: options.args,
		argsComplete: true,
		cwd: process.cwd(),
		executionStarted: true,
		expanded: options.expanded ?? false,
		invalidate: () => undefined,
		isError: options.isError ?? false,
		isPartial: false,
		lastComponent: options.lastComponent,
		showImages: true,
		state: {},
		toolCallId: "render-test",
	};
}

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

test("agentBrowserExtension renders long TUI output compactly without changing model-facing content", async () => {
	const harness = createExtensionHarness({ cwd: process.cwd(), prompt: "Inspect a page." });
	const renderCall = harness.tool.renderCall;
	const renderResult = harness.tool.renderResult;
	assert.ok(renderCall, "expected agent_browser to register custom call rendering");
	assert.ok(renderResult, "expected agent_browser to register custom result rendering");

	const params: AgentBrowserToolParams = {
		args: ["eval", "--stdin"],
		sessionMode: "fresh",
		stdin: "document.body.innerText",
	};
	const callText = renderCall(params, PLAIN_RENDER_THEME, createRenderContext({ args: params })).render(200).join("\n");
	assert.match(callText, /<toolTitle>\*\*agent_browser\*\*<\/toolTitle>/);
	assert.match(callText, /<accent>eval --stdin<\/accent>/);
	assert.match(callText, /sessionMode=fresh/);
	assert.match(callText, /\+ stdin/);
	assert.doesNotMatch(callText, /document\.body/);

	const maliciousParams: AgentBrowserToolParams = {
		args: ["open", "\x1B]0;pwned\x07https://example.com/\x1B[31m"],
		stdin: "secret stdin must not render",
	};
	const maliciousCallText = renderCall(maliciousParams, PLAIN_RENDER_THEME, createRenderContext({ args: maliciousParams }))
		.render(200)
		.join("\n");
	assert.doesNotMatch(maliciousCallText, /[\x00\x07\x1B]/);
	assert.match(maliciousCallText, /https:\/\/example\.com\//);
	assert.doesNotMatch(maliciousCallText, /secret stdin/);

	const longText = JSON.stringify(
		{
			origin: "https://example.com/",
			result: Array.from({ length: 25 }, (_, index) => ({
				href: `https://example.com/${index}`,
				i: index,
				text: `item-${index}`,
			})),
		},
		null,
		2,
	);
	const longResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: longText }],
		details: { summary: "large JSON result" },
	};
	const collapsedComponent = renderResult(
		longResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	);
	const collapsedText = collapsedComponent.render(80).join("\n");
	assert.match(collapsedText, /\.\.\. \(\d+ more lines, \d+ total,/);
	assert.doesNotMatch(collapsedText, /item-24/);
	assert.match(longText, /item-24/, "renderer must not mutate model-facing content");

	const expandedComponent = renderResult(
		longResult,
		{ expanded: true, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params, expanded: true, lastComponent: collapsedComponent }),
	);
	const expandedText = expandedComponent.render(80).join("\n");
	assert.match(expandedText, /item-24/);
	assert.doesNotMatch(expandedText, /\.\.\. \(\d+ more lines/);

	const scalarResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "Clicked: true\x1B[31m red\x1B[0m\nHref: https://example.com/next\x1B]0;pwned\x07\nNull\x00byte" }],
		details: { summary: "click completed" },
	};
	const scalarText = renderResult(
		scalarResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(120)
		.join("\n");
	assert.doesNotMatch(scalarText, /[\x00\x07\x1B]/);
	assert.match(scalarText, /<toolOutput>Clicked: true red<\/toolOutput>/);
	assert.match(scalarText, /Null�byte/);

	const fallbackResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "\x1B[31m\x1B[0m" }],
		details: { summary: "\x1B]0;pwned\x07summary ok" },
	};
	const fallbackText = renderResult(
		fallbackResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(120)
		.join("\n");
	assert.doesNotMatch(fallbackText, /[\x00\x07\x1B]/);
	assert.match(fallbackText, /<success>summary ok<\/success>/);
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
if (args.includes("--version")) {
  process.stdout.write("agent-browser 9.9.9\\n");
} else {
  process.stdout.write("Usage: agent-browser " + args.join(" ") + "\\nExample: agent-browser open https://example.com\\n");
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Open a page and summarize it." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const version = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--version"],
			});
			const rootHelp = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--help"],
			});
			const commandHelp = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["snapshot", "--help"],
			});

			assert.equal(version.isError, false);
			assert.equal(version.content[0]?.type, "text");
			assert.match((version.content[0] as { text: string }).text, /agent-browser 9\.9\.9/);
			assert.equal(version.details?.inspection, true);
			assert.equal(version.details?.stdout, "agent-browser 9.9.9");
			assert.equal(version.details?.parseError, undefined);
			assert.equal(version.details?.sessionName, undefined);
			assert.equal(version.details?.usedImplicitSession, undefined);
			assert.equal(rootHelp.isError, false);
			assert.equal(rootHelp.details?.inspection, true);
			assert.equal(rootHelp.details?.sessionName, undefined);
			assert.match((rootHelp.content[0] as { text: string }).text, /Usage: agent-browser --help/);
			assert.equal(commandHelp.isError, false);
			assert.equal(commandHelp.details?.inspection, true);
			assert.equal(commandHelp.details?.sessionName, undefined);
			assert.match((commandHelp.content[0] as { text: string }).text, /Usage: agent-browser snapshot --help/);
			assert.deepEqual(await readInvocationLog(logPath), [{ args: ["--version"] }, { args: ["--help"] }, { args: ["snapshot", "--help"] }]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps skills inspection flows stateless and useful", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-skills-inspection-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const commandStart = args.indexOf("skills");
const subcommand = args[commandStart + 1];
if (subcommand === "list") {
  process.stdout.write(JSON.stringify({ success: true, data: [{ name: "core", description: "Core usage guide" }] }));
} else if (subcommand === "get") {
  process.stdout.write(JSON.stringify({ success: true, data: { content: ${JSON.stringify("# Core\n\n```bash\nagent-browser snapshot -i\n```")} } }));
} else if (subcommand === "path") {
  process.stdout.write(JSON.stringify({ success: true, data: "/tmp/agent-browser-skills/core" }));
} else {
  process.stdout.write(JSON.stringify({ success: false, error: "unexpected skills command" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Inspect agent-browser skills." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const list = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["skills", "list"] });
			const get = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["skills", "get", "core", "--full"] });
			const path = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["skills", "path", "core"] });

			assert.equal(list.isError, false);
			assert.match((list.content[0] as { text: string }).text, /1\. core — Core usage guide/);
			assert.equal(list.details?.sessionName, undefined);
			assert.equal(list.details?.usedImplicitSession, undefined);
			assert.equal(get.isError, false);
			assert.match((get.content[0] as { text: string }).text, /agent_browser \{ "args": \["snapshot","-i"\] \}/);
			assert.equal(path.isError, false);
			assert.equal(path.details?.summary, "agent-browser skill path");
			assert.match((path.content[0] as { text: string }).text, /\/tmp\/agent-browser-skills\/core/);

			assert.deepEqual(await readInvocationLog(logPath), [
				{ args: ["--json", "skills", "list"] },
				{ args: ["--json", "skills", "get", "core", "--full"] },
				{ args: ["--json", "skills", "path", "core"] },
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension passes through provider and specialized skill workflows", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-provider-matrix-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  agentcoreApiKey: process.env.AGENTCORE_API_KEY || null,
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY || null,
  browserlessApiKey: process.env.BROWSERLESS_API_KEY || null,
  browserUseApiKey: process.env.BROWSER_USE_API_KEY || null,
  iosDevice: process.env.AGENT_BROWSER_IOS_DEVICE || null,
  kernelApiKey: process.env.KERNEL_API_KEY || null
}) + "\\n");
const skillIndex = args.indexOf("skills");
if (skillIndex >= 0 && args[skillIndex + 1] === "get") {
  process.stdout.write(JSON.stringify({ success: true, data: { name: args[skillIndex + 2], body: "Use native agent_browser args for provider setup." } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true, args } }));
}`,
	);

	const providerCommands = [
		["-p", "ios", "device", "list"],
		["-p", "ios", "--device", "iPhone 15 Pro", "tap", "@e1"],
		["--provider", "browserbase", "open", "https://example.com"],
		["--provider", "kernel", "open", "https://example.com"],
		["--provider", "browseruse", "open", "https://example.com"],
		["--provider", "browserless", "open", "https://example.com"],
		["--provider", "agentcore", "open", "https://example.com"],
	] as const;
	const skillCommands = [
		["skills", "get", "electron"],
		["skills", "get", "slack"],
		["skills", "get", "dogfood"],
		["skills", "get", "vercel-sandbox"],
		["skills", "get", "agentcore"],
	] as const;

	try {
		await withPatchedEnv(
			{
				AGENT_BROWSER_IOS_DEVICE: "iPhone 15 Pro",
				AGENTCORE_API_KEY: "agentcore-key",
				BROWSERBASE_API_KEY: "browserbase-key",
				BROWSERLESS_API_KEY: "browserless-key",
				BROWSER_USE_API_KEY: "browser-use-key",
				KERNEL_API_KEY: "kernel-key",
				PATH: `${tempDir}:${basePath}`,
			},
			async () => {
				const harness = createExtensionHarness({ cwd: tempDir, prompt: "Exercise provider and specialized skill passthrough." });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				for (const args of providerCommands) {
					const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args], sessionMode: "fresh" });
					assert.equal(result.isError, false, args.join(" "));
					assert.doesNotMatch(JSON.stringify(result.details), /agentcore-key|browserbase-key|browserless-key|browser-use-key|kernel-key/);
				}
				for (const args of skillCommands) {
					const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args] });
					assert.equal(result.isError, false, args.join(" "));
					assert.equal(result.details?.sessionName, undefined, args.join(" "));
					assert.equal(result.details?.usedImplicitSession, undefined, args.join(" "));
				}

				const invocations = await readInvocationLog(logPath);
				const providerInvocations = invocations.filter((entry) => {
					const userArgs = entry.args.slice(3);
					return entry.args[1] === "--session" && userArgs.length > 0 && userArgs[0] !== "close";
				});
				assert.deepEqual(providerInvocations.map((entry) => entry.args.slice(3)), providerCommands.map((args) => [...args]));
				assert.ok(providerInvocations.every((entry) => entry.args[0] === "--json" && entry.args[1] === "--session"));
				assert.ok(providerInvocations.some((entry) => entry.iosDevice === "iPhone 15 Pro"));
				assert.ok(providerInvocations.some((entry) => entry.agentcoreApiKey === "agentcore-key"));
				assert.ok(providerInvocations.some((entry) => entry.browserbaseApiKey === "browserbase-key"));
				assert.ok(providerInvocations.some((entry) => entry.browserlessApiKey === "browserless-key"));
				assert.ok(providerInvocations.some((entry) => entry.browserUseApiKey === "browser-use-key"));
				assert.ok(providerInvocations.some((entry) => entry.kernelApiKey === "kernel-key"));
				assert.deepEqual(invocations.filter((entry) => entry.args[1] === "skills").map((entry) => entry.args), skillCommands.map((args) => ["--json", ...args]));
			},
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension passes through core command coverage fallback matrix", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-core-matrix-"));
	const logPath = join(tempDir, "invocations.log");
	const downloadPath = join(tempDir, "download.txt");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const command = args.find((arg, index) => arg !== "--json" && args[index - 1] !== "--session" && arg !== "--session" && args[index - 2] !== "--session") || "unknown";
const data = command === "download" ? { path: args[args.length - 1] } : { ok: true, command };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	const commands = [
		["connect", "9222"],
		["download", "#direct-download", downloadPath],
		["get", "url"],
		["snapshot", "--compact"],
		["tab", "new"],
		["tab", "0"],
		["tab", "close"],
	] as const;

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Exercise core browser commands." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			for (const args of commands) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args] });
				assert.equal(result.isError, false, args.join(" "));
			}

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(
				invocations.map((entry) => entry.args.slice(3)),
				commands.map((args) => [...args]),
			);
			assert.ok(invocations.every((entry) => entry.args[0] === "--json" && entry.args[1] === "--session"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension passes through stateful browser-context workflow commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stateful-matrix-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const commandIndex = args.findIndex((arg) => !arg.startsWith("--") && args[args.indexOf("--session") + 1] !== arg);
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
if (command === "state" && subcommand === "save") fs.writeFileSync(args[commandIndex + 2], "{}");
const data = command === "auth" && subcommand === "list" ? { profiles: [{ name: "demo" }] }
  : command === "auth" && subcommand === "show" ? { name: "demo", url: "https://example.test", username: "user@example.test" }
  : command === "cookies" && (subcommand === undefined || subcommand === "get") ? { cookies: [{ name: "sid", domain: "example.test", path: "/", value: "cookie-get-secret" }] }
  : command === "cookies" && subcommand === "set" ? { name: args[commandIndex + 2], value: args[commandIndex + 3], domain: "example.test" }
  : command === "storage" ? { type: args[commandIndex + 1], entries: [{ key: args[commandIndex + 3] || "theme", value: args[commandIndex + 4] || "storage-secret" }] }
  : command === "dialog" ? { open: subcommand === "status", accepted: subcommand === "accept", dismissed: subcommand === "dismiss" }
  : command === "frame" ? { frame: subcommand }
  : command === "state" && subcommand === "list" ? { states: [{ name: "state.json" }] }
  : command === "state" ? { path: args[commandIndex + 2], loaded: subcommand === "load" }
  : { ok: true, command, subcommand };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	const commands = [
		["auth", "save", "demo", "--url", "https://example.test", "--username", "user@example.test"],
		["auth", "login", "demo"],
		["auth", "list"],
		["auth", "show", "demo"],
		["auth", "delete", "demo"],
		["state", "save", statePath],
		["state", "load", statePath],
		["state", "list"],
		["cookies", "get"],
		["cookies", "set", "sid", "cookie-secret", "--url", "https://example.test"],
		["cookies", "clear"],
		["storage", "local", "set", "theme", "dark"],
		["storage", "session", "get", "theme"],
		["storage", "local", "clear"],
		["dialog", "status"],
		["dialog", "accept", "prompt text"],
		["dialog", "dismiss"],
		["frame", "#child-frame"],
		["frame", "main"],
		["confirm", "c_demo"],
		["deny", "c_demo"],
	] as const;

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Exercise stateful browser workflows." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			for (const args of commands) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args] });
				assert.equal(result.isError, false, args.join(" "));
				assert.doesNotMatch(result.content[0]?.text ?? "", /cookie-secret|cookie-get-secret|storage-secret|dark/);
				assert.doesNotMatch(JSON.stringify(result.details), /cookie-secret|cookie-get-secret|storage-secret|dark/);
			}

			const jsonResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--json", "cookies", "set", "sid", "json-cookie-secret", "--url", "https://example.test"] });
			assert.equal(jsonResult.isError, false);
			for (const item of jsonResult.content) {
				if (item.type === "text") assert.doesNotMatch(item.text ?? "", /json-cookie-secret/);
			}

			const invocations = await readInvocationLog(logPath);
			const userInvocations = invocations
				.map((entry) => entry.args.slice(3))
				.filter((args) => !(args[0] === "tab" && args[1] === "list"))
				.filter((args) => !(args[0] === "cookies" && args[1] === "set" && args[3] === "json-cookie-secret"));
			assert.deepEqual(userInvocations, commands.map((args) => [...args]));
			assert.ok(invocations.every((entry) => entry.args.includes("--json") && entry.args.includes("--session")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension passes through non-core network debug diff stream dashboard and chat families", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-non-core-matrix-"));
	const logPath = join(tempDir, "invocations.log");
	const harPath = join(tempDir, "network.har");
	const tracePath = join(tempDir, "trace.zip");
	const profilePath = join(tempDir, "profile.cpuprofile");
	const recordingPath = join(tempDir, "recording.webm");
	const diffPath = join(tempDir, "diff.png");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, model: process.env.AI_GATEWAY_MODEL || null, apiKey: process.env.AI_GATEWAY_API_KEY || null }) + "\\n");
const valueFlags = new Set(["--session", "--model", "--port", "--body", "--resource-type", "--baseline"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
function ensureFile(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
let data = { ok: true, command, subcommand };
if (command === "network" && subcommand === "route") data = { routed: args[commandIndex + 2] };
if (command === "network" && subcommand === "requests") data = { requests: [{ method: "GET", requestId: "n1", status: 200, url: "https://example.test/app.js" }] };
if (command === "network" && subcommand === "har") {
  const action = args[commandIndex + 2];
  data = action === "stop" ? { path: args[commandIndex + 3] || ${JSON.stringify(harPath)}, requestCount: 1, state: "stopped" } : { state: "started" };
  if (data.path) ensureFile(data.path, "{}");
}
if (command === "diff" && subcommand === "snapshot") data = { added: 1, removed: 0 };
if (command === "diff" && subcommand === "screenshot") { data = { diffPath: ${JSON.stringify(diffPath)}, mismatchPixels: 0 }; ensureFile(data.diffPath, "fake-png"); }
if (command === "diff" && subcommand === "url") data = { differenceCount: 0 };
if (command === "trace") { data = subcommand === "stop" ? { path: args[commandIndex + 2] || ${JSON.stringify(tracePath)}, state: "stopped" } : { state: "started" }; if (data.path) ensureFile(data.path, "trace"); }
if (command === "profiler") { data = subcommand === "stop" ? { path: args[commandIndex + 2] || ${JSON.stringify(profilePath)}, state: "stopped" } : { state: "started" }; if (data.path) ensureFile(data.path, "profile"); }
if (command === "record") { data = subcommand === "start" ? { path: args[commandIndex + 2] || ${JSON.stringify(recordingPath)} } : { path: ${JSON.stringify(recordingPath)} }; if (subcommand === "stop") ensureFile(data.path, "video"); }
if (command === "console") data = { messages: [{ text: "hello", type: "log" }] };
if (command === "errors") data = { errors: [{ text: "boom", url: "https://example.test/app.js", line: 1 }] };
if (command === "highlight") data = { highlighted: subcommand };
if (command === "inspect") data = { opened: true };
if (command === "clipboard") data = { text: subcommand === "read" ? "clipboard text" : "written" };
if (command === "stream") data = { connected: subcommand === "enable" || subcommand === "status", enabled: subcommand !== "disable", port: 7777, screencasting: subcommand !== "disable" };
if (command === "dashboard") data = subcommand === "stop" ? { stopped: true } : { pid: 123, port: 4848 };
if (command === "chat") data = { response: "chat done", model: args[args.indexOf("--model") + 1] || process.env.AI_GATEWAY_MODEL || "default" };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	const commands = [
		["network", "route", "**/api", "--body", '{"token":"route-secret"}', "--resource-type", "fetch"],
		["network", "requests", "--filter", "example"],
		["network", "har", "start"],
		["network", "har", "stop", harPath],
		["diff", "snapshot"],
		["diff", "screenshot", "--baseline", join(tempDir, "baseline.png")],
		["diff", "url", "https://example.test/a", "https://example.test/b"],
		["trace", "start"],
		["trace", "stop", tracePath],
		["profiler", "start"],
		["profiler", "stop", profilePath],
		["record", "start", recordingPath],
		["record", "stop"],
		["console"],
		["errors"],
		["highlight", "#target"],
		["inspect"],
		["clipboard", "write", "Authorization: Bearer clipboard-secret"],
		["clipboard", "read"],
		["stream", "enable", "--port", "7777"],
		["stream", "status"],
		["stream", "disable"],
		["--model", "anthropic/model-flag", "dashboard", "start", "--port", "4848"],
		["dashboard", "stop"],
		["chat", "Summarize Authorization: Bearer chat-secret", "--model", "anthropic/chat-flag"],
	] as const;

	try {
		await withPatchedEnv({ AI_GATEWAY_API_KEY: "ai-gateway-key", AI_GATEWAY_MODEL: "anthropic/env-model", PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Exercise non-core browser workflows." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			for (const args of commands) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args] });
				assert.equal(result.isError, false, args.join(" "));
				assert.doesNotMatch(result.content[0]?.text ?? "", /route-secret|clipboard-secret|chat-secret/);
				assert.doesNotMatch(JSON.stringify(result.details), /route-secret|clipboard-secret|chat-secret/);
			}

			const invocations = await readInvocationLog(logPath);
			const userInvocations = invocations.map((entry) => entry.args.slice(3));
			assert.deepEqual(userInvocations, commands.map((args) => [...args]));
			assert.ok(invocations.every((entry) => entry.args.includes("--json") && entry.args.includes("--session")));
			assert.ok(invocations.some((entry) => entry.args.includes("chat") && entry.args.includes("--model") && entry.model === "anthropic/env-model"));
			assert.ok(invocations.some((entry) => entry.args.includes("dashboard") && entry.apiKey === "ai-gateway-key"));
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
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "missing-binary");
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

test("agentBrowserExtension compiles semantic actions to upstream find commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-action-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { args, title: "Clicked", url: "https://example.test/" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const clickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", value: "button", name: "Export" },
			});
			assert.equal(clickResult.isError, false);
			assert.deepEqual(clickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "role",
				args: ["find", "role", "button", "click", "--name", "Export"],
			});

			const fillResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "label", value: "Email", text: "user@example.test" },
			});
			assert.equal(fillResult.isError, false);
			assert.deepEqual(fillResult.details?.compiledSemanticAction, {
				action: "fill",
				locator: "label",
				args: ["find", "label", "Email", "fill", "user@example.test"],
			});

			const textClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Close" },
			});
			assert.equal(textClickResult.isError, false);
			assert.deepEqual(textClickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "text",
				args: ["find", "text", "Close", "click"],
			});

			const sessionClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Close", session: "named" },
			});
			assert.equal(sessionClickResult.isError, false);
			assert.deepEqual(sessionClickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "text",
				args: ["--session", "named", "find", "text", "Close", "click"],
			});
			assert.equal(sessionClickResult.details?.sessionName, "named");

			const invocations = (await readInvocationLog(logPath)).filter((entry) => entry.args.includes("find"));
			assert.deepEqual(invocations[0]?.args.slice(-6), ["find", "role", "button", "click", "--name", "Export"]);
			assert.deepEqual(invocations[1]?.args.slice(-5), ["find", "label", "Email", "fill", "user@example.test"]);
			assert.deepEqual(invocations[2]?.args.slice(-4), ["find", "text", "Close", "click"]);
			assert.deepEqual(invocations[3]?.args.slice(-6), ["--session", "named", "find", "text", "Close", "click"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension compiles constrained jobs to upstream batch commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-job-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const steps = JSON.parse(stdin);
  process.stdout.write(JSON.stringify(steps.map((command) => ({ command, success: true, result: { command } }))));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: {
					steps: [
						{ action: "open", url: "https://example.test/" },
						{ action: "fill", selector: "#email", text: "user@example.test" },
						{ action: "click", selector: "#submit" },
						{ action: "assertText", text: "Welcome" },
						{ action: "assertUrl", url: "**/dashboard" },
						{ action: "wait", milliseconds: 250 },
						{ action: "waitForDownload", path: "report.csv" },
						{ action: "screenshot", path: "job.png" },
					],
				},
			});

			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.args, ["batch"]);
			const effectiveArgs = result.details?.effectiveArgs as string[] | undefined;
			assert.deepEqual(effectiveArgs?.slice(0, 2), ["--json", "--session"]);
			assert.match(effectiveArgs?.[2] ?? "", /^piab-pi-agent-browser-job-/);
			assert.equal(effectiveArgs?.[3], "batch");
			const compiledJob = result.details?.compiledJob as { args?: string[]; stdin?: string; steps?: Array<{ action: string; args: string[] }> } | undefined;
			assert.deepEqual(compiledJob?.args, ["batch"]);
			const expectedCompiledSteps = [
				["open", "https://example.test/"],
				["fill", "#email", "user@example.test"],
				["click", "#submit"],
				["wait", "--text", "Welcome"],
				["wait", "--url", "**/dashboard"],
				["wait", "250"],
				["wait", "--download", "report.csv"],
				["screenshot", "job.png"],
			];
			assert.deepEqual(compiledJob?.steps?.map((step) => step.args), expectedCompiledSteps);
			assert.deepEqual(JSON.parse(compiledJob?.stdin ?? "[]"), expectedCompiledSteps);
			const redactedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://user:secret@example.test/path?token=abc&ok=1#access_token=xyz" }] },
			});
			const redactedCompiledJob = redactedResult.details?.compiledJob as { stdin?: string; steps?: Array<{ args: string[] }> } | undefined;
			assert.match(redactedCompiledJob?.stdin ?? "", /%5BREDACTED%5D/);
			assert.doesNotMatch(redactedCompiledJob?.stdin ?? "", /secret|token=abc|access_token=xyz/);
			assert.deepEqual(JSON.parse(redactedCompiledJob?.stdin ?? "[]"), redactedCompiledJob?.steps?.map((step) => step.args));

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-1), ["batch"]);
			const upstreamSteps = JSON.parse(invocations[0]?.stdin ?? "[]") as string[][];
			assert.deepEqual(upstreamSteps.slice(0, 7), compiledJob?.steps?.slice(0, 7).map((step) => step.args));
			assert.equal(upstreamSteps[7]?.[0], "screenshot");
			assert.match(upstreamSteps[7]?.[1] ?? "", /job\.png$/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension compiles lightweight QA presets and fails diagnostics", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-qa-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
let mode = "clean";
let staleNetwork = true;
let staleConsole = true;
let staleErrors = true;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const steps = JSON.parse(stdin);
  const results = steps.map((command) => {
    const name = command[0];
    if (name === "open") mode = String(command[1] || "").includes("fail") ? "fail" : "clean";
    if (name === "network") {
      if (command.includes("--clear")) { staleNetwork = false; return { command, success: true, result: { requests: [] } }; }
      return { command, success: true, result: staleNetwork || mode === "fail" ? { requests: [{ method: "GET", status: 500, url: "https://example.test/api" }] } : { requests: [] } };
    }
    if (name === "console") {
      if (command.includes("--clear")) { staleConsole = false; return { command, success: true, result: { messages: [] } }; }
      return { command, success: true, result: staleConsole || mode === "fail" ? { messages: [{ type: "error", text: "boom" }] } : { messages: [] } };
    }
    if (name === "errors") {
      if (command.includes("--clear")) { staleErrors = false; return { command, success: true, result: { errors: [] } }; }
      return { command, success: true, result: staleErrors || mode === "fail" ? { errors: [{ text: "page boom" }] } : { errors: [] } };
    }
    return { command, success: true, result: { ok: true } };
  });
  process.stdout.write(JSON.stringify(results));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const cleanResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://example.test/",
					expectedText: ["Welcome"],
				},
			});
			assert.equal(cleanResult.isError, false);
			assert.deepEqual((cleanResult.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, []);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://fail.example.test/",
					expectedText: ["Welcome"],
					expectedSelector: "main",
					screenshotPath: "qa.png",
				},
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "qa-failure");
			assert.deepEqual((result.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, [
				"1 failed network request(s)",
				"1 console error message(s)",
				"1 page error(s)",
			]);
			const compiledQaPreset = result.details?.compiledQaPreset as { steps?: Array<{ args: string[] }> } | undefined;
			assert.deepEqual(compiledQaPreset?.steps?.map((step) => step.args), [
				["network", "requests", "--clear"],
				["console", "--clear"],
				["errors", "--clear"],
				["open", "https://fail.example.test/"],
				["wait", "--load", "networkidle"],
				["wait", "--text", "Welcome"],
				["wait", "main"],
				["network", "requests"],
				["console"],
				["errors"],
				["screenshot", "qa.png"],
			]);
			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-1), ["batch"]);
			assert.deepEqual(invocations[1]?.args.slice(-1), ["batch"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension compiles experimental source lookups and reports candidate evidence", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-source-lookup-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await mkdir(join(tempDir, "src"), { recursive: true });
	await writeFile(join(tempDir, "src", "Panel.tsx"), "export function Panel() { return <button>Save</button>; }\n");
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const steps = JSON.parse(stdin);
  const results = steps.map((command) => {
    if (command[0] === "get" && command[1] === "html") {
      return { command, success: true, result: "<button data-source-file='src/Button.tsx' data-source-line='17' data-source-column='5'>Save</button>" };
    }
    if (command[0] === "react" && command[1] === "inspect") {
      return { command, success: true, result: { name: "Button", source: { fileName: "src/Button.tsx", lineNumber: 17, columnNumber: 5 } } };
    }
    if (command[0] === "react" && command[1] === "tree") {
      return { command, success: true, result: "0 1 App\\n1 2 Panel" };
    }
    return { command, success: true, result: { ok: true } };
  });
  process.stdout.write(JSON.stringify(results));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: {
					selector: "#save",
					reactFiberId: "2",
					componentName: "Panel",
				},
			});

			assert.equal(result.isError, false);
			const compiledSourceLookup = result.details?.compiledSourceLookup as { steps?: Array<{ args: string[] }>; stdin?: string } | undefined;
			assert.deepEqual(compiledSourceLookup?.steps?.map((step) => step.args), [
				["is", "visible", "#save"],
				["get", "html", "#save"],
				["react", "inspect", "2"],
				["react", "tree"],
			]);
			assert.deepEqual(JSON.parse(compiledSourceLookup?.stdin ?? "[]"), compiledSourceLookup?.steps?.map((step) => step.args));
			const sourceLookup = result.details?.sourceLookup as { status?: string; candidates?: Array<{ source?: string; file?: string; line?: number; column?: number; confidence?: string; componentName?: string }> } | undefined;
			assert.equal(sourceLookup?.status, "candidates-found");
			assert.ok(sourceLookup?.candidates?.some((candidate) => candidate.source === "react-inspect" && candidate.file === "src/Button.tsx" && candidate.line === 17 && candidate.confidence === "high"));
			assert.ok(sourceLookup?.candidates?.some((candidate) => candidate.source === "dom-attribute" && candidate.file === "src/Button.tsx" && candidate.line === 17 && candidate.column === 5));
			assert.ok(sourceLookup?.candidates?.some((candidate) => candidate.source === "workspace-search" && candidate.componentName === "Panel" && candidate.file?.endsWith("src/Panel.tsx")));
			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-1), ["batch"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension compiles experimental network source lookups and reports failed-request candidates", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-source-lookup-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await mkdir(join(tempDir, "src"), { recursive: true });
	await writeFile(join(tempDir, "src", "api.ts"), "export const endpoint = 'https://user:pass@app.test/api/fail?token=secret&ok=1';\n");
	await writeFile(join(tempDir, "src", "ok.ts"), "export const endpoint = 'https://app.test/api/ok';\n");
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const steps = JSON.parse(stdin);
  const results = steps.map((command) => {
    if (command[0] === "network" && command[1] === "request") {
      return { command, success: true, result: { id: "req-1", method: "GET", url: "https://user:pass@app.test/api/fail?token=secret&ok=1", status: 500, initiator: "src/api.ts:1:22" } };
    }
    if (command[0] === "network" && command[1] === "requests") {
      return { command, success: true, result: { requests: [
        { id: "req-1", method: "GET", url: "https://user:pass@app.test/api/fail?token=secret&ok=1", status: 500, initiator: { stack: "at load (src/api.ts:1:22)" } },
        { id: "req-ok", method: "GET", url: "https://app.test/api/ok", status: 200, initiator: { stack: "at ok (src/ok.ts:1:22)" } }
      ] } };
    }
    return { command, success: true, result: {} };
  });
  process.stdout.write(JSON.stringify(results));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				networkSourceLookup: { requestId: "req-1", url: "https://user:pass@app.test/api/fail?token=secret&ok=1" },
			});

			assert.equal(result.isError, false);
			const compiled = result.details?.compiledNetworkSourceLookup as { steps?: Array<{ args: string[] }>; stdin?: string } | undefined;
			assert.deepEqual(compiled?.steps?.[0]?.args, ["network", "request", "req-1"]);
			assert.deepEqual(compiled?.steps?.[1]?.args.slice(0, 3), ["network", "requests", "--filter"]);
			assert.match(compiled?.steps?.[1]?.args[3] ?? "", /api\/fail/);
			assert.match(compiled?.steps?.[1]?.args[3] ?? "", /REDACTED/);
			const compiledStdinSteps = JSON.parse(compiled?.stdin ?? "[]") as string[][];
			assert.deepEqual(compiledStdinSteps[0], ["network", "request", "req-1"]);
			assert.deepEqual(compiledStdinSteps[1]?.slice(0, 3), ["network", "requests", "--filter"]);
			assert.doesNotMatch(compiled?.stdin ?? "", /secret|user:pass|ok=1/);
			assert.doesNotMatch(JSON.stringify(result.details?.compiledNetworkSourceLookup), /secret|user:pass|ok=1/);
			const lookup = result.details?.networkSourceLookup as { status?: string; failedRequests?: Array<{ status?: number; url?: string }>; candidates?: Array<{ source?: string; file?: string; line?: number; requestUrl?: string }> } | undefined;
			assert.equal(lookup?.status, "failed-requests-found");
			assert.equal(lookup?.failedRequests?.[0]?.status, 500);
			assert.doesNotMatch(JSON.stringify(lookup), /secret|user:pass|ok=1/);
			assert.doesNotMatch(JSON.stringify(result), /secret|user:pass|ok=1/);
			assert.ok(lookup?.candidates?.some((candidate) => candidate.source === "initiator" && candidate.file === "src/api.ts" && candidate.line === 1));
			assert.ok(lookup?.candidates?.some((candidate) => candidate.source === "workspace-search" && candidate.file?.endsWith("src/api.ts") && candidate.line === 1));
			assert.equal(lookup?.candidates?.some((candidate) => candidate.file === "src/ok.ts" || candidate.file?.endsWith("src/ok.ts")), false);

			const requestOnlyResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				networkSourceLookup: { requestId: "req-1" },
			});
			assert.equal(requestOnlyResult.isError, false);
			const requestOnlyCompiled = requestOnlyResult.details?.compiledNetworkSourceLookup as { steps?: Array<{ args: string[] }> } | undefined;
			assert.deepEqual(requestOnlyCompiled?.steps?.map((step) => step.args), [["network", "request", "req-1"]]);

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-1), ["batch"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects ambiguous or incomplete semantic actions before spawning agent-browser", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-action-invalid-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: "should not run" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const ambiguous = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["click", "@e1"],
				semanticAction: { action: "click", locator: "text", value: "Export" },
			});
			assert.equal(ambiguous.isError, true);
			assert.match((ambiguous.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, or networkSourceLookup/);
			assert.equal(ambiguous.details?.resultCategory, "failure");
			assert.equal(ambiguous.details?.failureCategory, "validation-error");

			const jobWithStdin = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/" }] },
				stdin: "[]",
			});
			assert.equal(jobWithStdin.isError, true);
			assert.match((jobWithStdin.content[0] as { text: string }).text, /Do not provide stdin with job/);
			assert.equal(jobWithStdin.details?.failureCategory, "validation-error");

			const ambiguousJobArgs = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.test/"],
				job: { steps: [{ action: "open", url: "https://example.test/" }] },
			});
			assert.equal(ambiguousJobArgs.isError, true);
			assert.match((ambiguousJobArgs.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, or networkSourceLookup/);

			const ambiguousJobSemanticAction = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/" }] },
				semanticAction: { action: "click", locator: "text", value: "Export" },
			});
			assert.equal(ambiguousJobSemanticAction.isError, true);
			assert.match((ambiguousJobSemanticAction.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, or networkSourceLookup/);

			const invalidJobAction = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "unknown" as never }] },
			});
			assert.equal(invalidJobAction.isError, true);
			assert.match((invalidJobAction.content[0] as { text: string }).text, /action must be one of/);

			const missingJobText = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/" }, { action: "assertText" as never }] },
			});
			assert.equal(missingJobText.isError, true);
			assert.match((missingJobText.content[0] as { text: string }).text, /job step assertText requires a non-empty text string/);

			const invalidJobWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "wait", milliseconds: 0 }] },
			});
			assert.equal(invalidJobWait.isError, true);
			assert.match((invalidJobWait.content[0] as { text: string }).text, /wait requires a positive integer milliseconds/);

			const invalidSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: {},
			});
			assert.equal(invalidSourceLookup.isError, true);
			assert.match((invalidSourceLookup.content[0] as { text: string }).text, /sourceLookup requires selector, reactFiberId, or componentName/);

			const oversizedSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: { componentName: "Panel", maxWorkspaceFiles: 5001 },
			});
			assert.equal(oversizedSourceLookup.isError, true);
			assert.match((oversizedSourceLookup.content[0] as { text: string }).text, /maxWorkspaceFiles must be 5000 or less/);

			const sourceLookupWithArgs = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["react", "tree"],
				sourceLookup: { componentName: "Panel" },
			});
			assert.equal(sourceLookupWithArgs.isError, true);
			assert.match((sourceLookupWithArgs.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, or networkSourceLookup/);

			const sourceLookupWithStdin = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: { componentName: "Panel" },
				stdin: "[]",
			});
			assert.equal(sourceLookupWithStdin.isError, true);
			assert.match((sourceLookupWithStdin.content[0] as { text: string }).text, /Do not provide stdin with job, qa, sourceLookup, or networkSourceLookup/);

			const networkSourceLookupWithArgs = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["network", "requests"],
				networkSourceLookup: { url: "/api/fail" },
			});
			assert.equal(networkSourceLookupWithArgs.isError, true);
			assert.match((networkSourceLookupWithArgs.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, or networkSourceLookup/);

			const networkSourceLookupWithStdin = await executeRegisteredTool(harness.tool, harness.ctx, {
				networkSourceLookup: { url: "/api/fail" },
				stdin: "[]",
			});
			assert.equal(networkSourceLookupWithStdin.isError, true);
			assert.match((networkSourceLookupWithStdin.content[0] as { text: string }).text, /Do not provide stdin with job, qa, sourceLookup, or networkSourceLookup/);

			const emptyNetworkSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, {
				networkSourceLookup: {},
			});
			assert.equal(emptyNetworkSourceLookup.isError, true);
			assert.match((emptyNetworkSourceLookup.content[0] as { text: string }).text, /networkSourceLookup requires requestId, filter, or url/);

			const missingText = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "label", value: "Email" },
			});
			assert.equal(missingText.isError, true);
			assert.match((missingText.content[0] as { text: string }).text, /semanticAction\.text is required for fill/);
			assert.equal(missingText.details?.failureCategory, "validation-error");

			const unsupportedRoleName = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Export", name: "Export" },
			});
			assert.equal(unsupportedRoleName.isError, true);
			assert.match((unsupportedRoleName.content[0] as { text: string }).text, /semanticAction\.name is only supported/);
			assert.equal(unsupportedRoleName.details?.failureCategory, "validation-error");

			const emptySession = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Export", session: "" },
			});
			assert.equal(emptySession.isError, true);
			assert.match((emptySession.content[0] as { text: string }).text, /semanticAction\.session must be a non-empty string/);
			assert.equal(emptySession.details?.failureCategory, "validation-error");

			const invocations = await readInvocationLog(logPath).catch(() => []);
			assert.deepEqual(invocations.filter((entry) => entry.args.includes("find")), []);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns semantic locator candidates when semanticAction misses", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-candidates-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("find")) {
  process.stdout.write(JSON.stringify({ success: false, error: "Element not found" }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: "ok" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "placeholder", value: "Search Wikipedia", text: "agent browser", session: "find" },
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "selector-not-found");
			const text = result.content[0] as { text: string };
			assert.match(text.text, /Agent-browser candidate fallbacks:/);
			assert.match(text.text, /try-searchbox-name-candidate/);
			assert.match(text.text, /"searchbox"/);
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] }; reason?: string }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), [
				"refresh-interactive-refs",
				"try-searchbox-name-candidate",
				"try-textbox-name-candidate",
			]);
			assert.deepEqual(nextActions?.[1]?.params?.args, ["--session", "find", "find", "role", "searchbox", "fill", "agent browser", "--name", "Search Wikipedia"]);
			assert.deepEqual(nextActions?.[2]?.params?.args, ["--session", "find", "find", "role", "textbox", "fill", "agent browser", "--name", "Search Wikipedia"]);
			assert.match(nextActions?.[1]?.reason ?? "", /accessible name/);

			const selectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", locator: "placeholder", value: "Country", text: "United States" },
			});
			assert.equal(selectResult.isError, true);
			assert.equal(selectResult.details?.failureCategory, "selector-not-found");
			const selectNextActions = selectResult.details?.nextActions as Array<{ id?: string }> | undefined;
			assert.deepEqual(selectNextActions?.map((action) => action.id), ["refresh-interactive-refs"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns a safe semantic retry action for stale-ref failures with compiled targets", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-stale-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("find")) {
  process.stdout.write(JSON.stringify({ success: false, error: "Unknown ref @e4 while resolving locator" }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: "ok" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Export" },
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "stale-ref");
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] }; safety?: string }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["refresh-interactive-refs", "retry-semantic-action-after-stale-ref"]);
			assert.deepEqual(nextActions?.[1]?.params?.args, ["find", "text", "Export", "click"]);
			assert.match(nextActions?.[1]?.safety ?? "", /prior action did not execute|direct stale @refs/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks page-scoped ref reuse after navigation before upstream can recycle it", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-generation-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://first.example/",
    refs: { e1: { role: "button", name: "Old Search" } },
    snapshot: '- button "Old Search" [ref=e1]'
  } }));
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Second", url: "https://second.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "recycled ref" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);
			assert.deepEqual((snapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);

			const currentClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(currentClick.isError, false);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://second.example/"] });
			assert.equal(open.isError, false);

			const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(staleClick.isError, true);
			assert.equal(staleClick.details?.failureCategory, "stale-ref");
			assert.match((staleClick.content[0] as { text: string }).text, /came from a snapshot for https:\/\/first\.example\//);
			assert.match((staleClick.content[0] as { text: string }).text, /current session target is https:\/\/second\.example\//);
			const nextActions = staleClick.details?.nextActions as Array<{ params?: { args?: string[] } }> | undefined;
			assert.deepEqual(nextActions?.[0]?.params?.args, ["--session", staleClick.details?.sessionName as string, "snapshot", "-i"]);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks stale refs after page-changing steps inside a batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin: null }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://first.example/",
    refs: { e1: { role: "button", name: "Old Search" } },
    snapshot: '- button "Old Search" [ref=e1]'
  } }));
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([{ command: ["open", "https://second.example/"], success: true, result: { title: "Second", url: "https://second.example/" } }, { command: ["click", "@e1"], success: true, result: { clicked: "recycled" } }]));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);

			const staleBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["open", "https://second.example/"], ["click", "@e1"]]),
			});
			assert.equal(staleBatch.isError, true);
			assert.equal(staleBatch.details?.failureCategory, "stale-ref");
			assert.match((staleBatch.content[0] as { text: string }).text, /after an earlier batch step can navigate or mutate/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 0);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allows batch stdin ref steps after snapshot following an invalidating step", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-snapshot-reset-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["open", "https://second.example/"], success: true, result: { title: "Second", url: "https://second.example/" } },
    { command: ["snapshot", "-i"], success: true, result: {
      origin: "https://second.example/",
      refs: { e7: { role: "button", name: "Go" } },
      snapshot: '- button "Go" [ref=e7]'
    } },
    { command: ["click", "@e7"], success: true, result: { clicked: "ok" } }
  ]));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://first.example/",
    refs: { e1: { role: "button", name: "Old" } },
    snapshot: '- button "Old" [ref=e1]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);

			const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["open", "https://second.example/"], ["snapshot", "-i"], ["click", "@e7"]]),
			});
			assert.equal(batch.isError, false);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension records snapshot refs returned inside a successful batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-snapshot-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([{ command: ["snapshot", "-i"], success: true, result: {
    origin: "https://batched.example/",
    refs: { e7: { role: "button", name: "Batched" } },
    snapshot: '- button "Batched" [ref=e7]'
  } }]));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "batched ref" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const batchSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["snapshot", "-i"]]),
			});
			assert.equal(batchSnapshot.isError, false);
			assert.deepEqual((batchSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e7"]);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e7"] });
			assert.equal(click.isError, false);
			assert.equal((click.details?.data as { clicked?: string } | undefined)?.clicked, "batched ref");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects refs absent from the latest same-page snapshot", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-missing-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://same.example/",
    refs: { e2: { role: "button", name: "Current" } },
    snapshot: '- button "Current" [ref=e2]'
  } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "unexpected" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);

			const missingRefClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(missingRefClick.isError, true);
			assert.equal(missingRefClick.details?.failureCategory, "stale-ref");
			assert.match((missingRefClick.content[0] as { text: string }).text, /was not present in the latest snapshot/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 0);
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
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "validation-error");
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
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "parse-failure");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects waits that would cross the upstream IPC read-timeout budget", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-wait-timeout-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), stdin: null }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const directWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "31000"],
			});
			const downloadWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "--download", "/tmp/export.csv", "--timeout", "30000"],
			});
			const batchWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["wait", "26000"]]),
			});

			for (const result of [directWait, downloadWait, batchWait]) {
				assert.equal(result.isError, true);
				assert.equal(result.content[0]?.type, "text");
				assert.match((result.content[0] as { text: string }).text, /30s IPC read timeout/);
				assert.match(String(result.details?.validationError ?? ""), /25000ms or less/);
				assert.equal(result.details?.resultCategory, "failure");
				assert.equal(result.details?.failureCategory, "timeout");
			}
			assert.deepEqual(await readInvocationLog(logPath), []);
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
			assert.equal(result.details?.resultCategory, "success");
			assert.equal(result.details?.successCategory, "artifact-unverified");
			assert.equal((result.details?.artifactVerification as { missingCount?: number; verified?: boolean } | undefined)?.missingCount, 1);
			assert.equal((result.details?.artifactVerification as { missingCount?: number; verified?: boolean } | undefined)?.verified, false);
			assert.deepEqual((result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined)?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
			assert.equal((result.details?.pageChangeSummary as { changeType?: string; savedFilePath?: string } | undefined)?.changeType, "artifact");
			assert.equal((result.details?.pageChangeSummary as { changeType?: string; savedFilePath?: string } | undefined)?.savedFilePath, "/tmp/export.csv");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns tab-drift next actions for early tab re-selection failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tab-drift-next-actions-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "target", title: "Example Domain", url: "https://example.com/", active: false }
  ] } }));
} else if (args.includes("tab") && args.includes("target")) {
  process.stdout.write(JSON.stringify({ success: false, error: "tab vanished" }));
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
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
				args: ["--session", "named", "eval", "--stdin"],
				stdin: "document.title",
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "tab-drift");
			const nextActions = result.details?.nextActions as Array<{ params?: { args: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.params?.args), [["tab", "list"], ["snapshot", "-i"]]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
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

