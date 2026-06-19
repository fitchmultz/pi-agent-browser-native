/**
 * Purpose: Verify extension pass-through, artifact-path normalization, JSON, missing-binary, and trace/profiler validation contracts.
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
	WEB_SEARCH_PROMPT_GUIDELINE,
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

const stripWrapperPrefix = (args: string[]) => {
	const stripped = [...args];
	if (stripped[0] === "--json") stripped.shift();
	if (stripped[0] === "--session") stripped.splice(0, 2);
	return stripped;
};

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

test("agentBrowserExtension passes through plugin list/show and blocks bare mcp one-shots", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-plugin-mcp-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const commandIndex = args.indexOf("plugin");
const command = commandIndex >= 0 ? "plugin" : args.includes("mcp") ? "mcp" : "unknown";
const subcommand = command === "plugin" ? (args[commandIndex + 1] || "list") : undefined;
if (command === "mcp" && args.includes("--help")) {
  process.stdout.write("agent-browser mcp - Start an MCP stdio server\\nUsage: agent-browser mcp [--tools <profiles>]\\n");
} else if (subcommand === "list") {
  process.stdout.write(JSON.stringify({ plugins: [{ name: "demo", capabilities: ["command.run"] }] }));
} else if (subcommand === "show") {
  process.stdout.write(JSON.stringify({ plugin: { name: args[commandIndex + 2], capabilities: ["command.run"] } }));
} else {
  process.stdout.write(JSON.stringify({ success: false, error: "unexpected command" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Exercise plugin and MCP passthrough." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const pluginList = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["plugin", "list"] });
			const pluginShow = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["plugin", "show", "demo"] });
			const bareMcp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["mcp", "--tools", "core"] });
			const mcpHelp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["mcp", "--help"] });
			const mcpHelpWord = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["mcp", "help"] });

			assert.equal(pluginList.isError, false);
			assert.deepEqual(pluginList.details?.data, { plugins: [{ name: "demo", capabilities: ["command.run"] }] });
			assert.equal(pluginList.details?.sessionName, undefined);
			assert.equal(pluginList.details?.usedImplicitSession, undefined);
			assert.equal(pluginShow.isError, false);
			assert.deepEqual(pluginShow.details?.data, { plugin: { name: "demo", capabilities: ["command.run"] } });
			assert.equal(pluginShow.details?.sessionName, undefined);
			assert.equal(bareMcp.isError, true);
			assert.match(bareMcp.content[0]?.text ?? "", /external MCP clients/);
			assert.equal(mcpHelp.isError, false);
			assert.equal(mcpHelp.details?.inspection, true);
			assert.match(mcpHelp.content[0]?.text ?? "", /Start an MCP stdio server/);
			assert.equal(mcpHelpWord.isError, true);
			assert.match(mcpHelpWord.content[0]?.text ?? "", /external MCP clients/);

			assert.deepEqual(await readInvocationLog(logPath), [
				{ args: ["--json", "plugin", "list"] },
				{ args: ["--json", "plugin", "show", "demo"] },
				{ args: ["mcp", "--help"] },
			]);
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
					const userArgs = stripWrapperPrefix(entry.args);
					return entry.args[1] === "--session" && userArgs.length > 0 && userArgs[0] !== "close";
				});
				const sessionfulProviderCommands = providerCommands.filter((args) => !(args[0] === "-p" && args[1] === "ios" && args[2] === "device"));
				assert.deepEqual(providerInvocations.map((entry) => stripWrapperPrefix(entry.args)), sessionfulProviderCommands.map((args) => [...args]));
				assert.deepEqual(invocations.find((entry) => entry.args.includes("device") && entry.args.includes("list"))?.args, ["--json", "-p", "ios", "device", "list"]);
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
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
let commandIndex = args[0] === "--json" ? 1 : 0;
if (args[commandIndex] === "--session") commandIndex += 2;
const command = args[commandIndex] || "unknown";
const artifactPath = command === "download" || command === "screenshot" || command === "pdf" || (command === "wait" && args.includes("--download")) ? args[args.length - 1] : undefined;
if (artifactPath) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, "artifact");
}
const data = artifactPath ? { path: artifactPath } : { ok: true, command };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	const commands = [
		["open", "https://example.test"],
		["goto", "https://example.test/next"],
		["navigate", "https://example.test/again"],
		["back"],
		["forward"],
		["reload"],
		["click", "#button", "--new-tab"],
		["dblclick", "#button"],
		["fill", "#name", "Ada"],
		["type", "#name", " Lovelace"],
		["press", "Enter"],
		["key", "Escape"],
		["keydown", "Shift"],
		["keyup", "Shift"],
		["keyboard", "type", "hello"],
		["keyboard", "inserttext", "raw text"],
		["hover", "#button"],
		["focus", "#name"],
		["check", "#agree"],
		["uncheck", "#agree"],
		["select", "#flavor", "vanilla"],
		["drag", "#source", "#target"],
		["upload", "#file", join(tempDir, "upload.txt")],
		["scroll", "down", "250", "--selector", "#panel"],
		["scrollintoview", "#target"],
		["scrollinto", "#target"],
		["wait", "#ready"],
		["wait", "--url", "**/ready"],
		["wait", "--load", "networkidle"],
		["wait", "--fn", "window.ready === true"],
		["wait", "--text", "Ready"],
		["wait", "--download", downloadPath],
		["screenshot", join(tempDir, "screen.png")],
		["pdf", join(tempDir, "page.pdf")],
		["snapshot", "--compact", "--depth", "3", "--urls"],
		["snapshot", "--interactive", "--selector", "main", "--cursor"],
		["eval", "document.title"],
		["eval", "-b", "ZG9jdW1lbnQudGl0bGU="],
		["connect", "9222"],
		["get", "url"],
		["get", "cdp-url"],
		["get", "box", "#button"],
		["get", "styles", "#button"],
		["is", "visible", "#button"],
		["find", "role", "button", "click", "--name", "Submit"],
		["find", "first", ".item", "click"],
		["find", "last", ".item", "hover"],
		["find", "nth", "2", ".card", "click", "--exact"],
		["mouse", "move", "10", "20"],
		["mouse", "wheel", "100"],
		["set", "media", "dark", "reduced-motion"],
		["tap", "#button"],
		["swipe", "up", "200"],
		["pushstate", "/spa/route"],
		["removeinitscript", "init-1"],
		["download", "#direct-download", downloadPath],
		["tab", "new"],
		["tab", "0"],
		["tab", "close"],
		["close"],
		["open", "https://example.test/reopened"],
		["quit"],
		["open", "https://example.test/reopened-again"],
		["exit"],
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
				invocations
					.map((entry) => stripWrapperPrefix(entry.args))
					.filter((args) => !(args.length === 2 && args[0] === "eval" && args[1] === "--stdin")),
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
		["auth", "remove", "demo"],
		["state", "save", statePath],
		["state", "load", statePath],
		["state", "list"],
		["state", "clear", "-a"],
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

			let storageSetResult: Awaited<ReturnType<typeof executeRegisteredTool>> | undefined;
			for (const args of commands) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args] });
				assert.equal(result.isError, false, args.join(" "));
				assert.doesNotMatch(result.content[0]?.text ?? "", /cookie-secret|cookie-get-secret|storage-secret/);
				assert.doesNotMatch(JSON.stringify(result.details), /cookie-secret|cookie-get-secret|storage-secret/);
				if (args[0] === "storage" && args[1] === "local" && args[2] === "set") storageSetResult = result;
			}
			assert.match(storageSetResult?.content[0]?.text ?? "", /theme: dark/);
			assert.match(JSON.stringify(storageSetResult?.details), /"value":"dark"/);

			const jsonResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--json", "cookies", "set", "sid", "json-cookie-secret", "--url", "https://example.test"] });
			assert.equal(jsonResult.isError, false);
			for (const item of jsonResult.content) {
				if (item.type === "text") assert.doesNotMatch(item.text ?? "", /json-cookie-secret/);
			}

			const invocations = await readInvocationLog(logPath);
			const userInvocations = invocations
				.map((entry) => stripWrapperPrefix(entry.args))
				.filter((args) => !(args[0] === "tab" && args[1] === "list"))
				.filter((args) => !(args.includes("cookies") && args.includes("set") && args.includes("json-cookie-secret")));
			assert.deepEqual(userInvocations, commands.map((args) => [...args]));
			assert.ok(invocations.every((entry) => entry.args.includes("--json")));
			assert.ok(invocations.every((entry) => {
				const userArgs = stripWrapperPrefix(entry.args);
				const isSessionlessAuth = userArgs[0] === "auth" && ["save", "list", "show", "delete", "remove"].includes(userArgs[1] ?? "");
				const isSessionlessState = userArgs[0] === "state" && (userArgs[1] === "list" || (userArgs[1] === "clear" && userArgs[2] === "-a"));
				return isSessionlessAuth || isSessionlessState ? !entry.args.includes("--session") : entry.args.includes("--session");
			}));
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
if (command === "network" && subcommand === "unroute") data = { unrouted: args[commandIndex + 2] || "all" };
if (command === "network" && subcommand === "requests") data = { requests: [{ method: "GET", requestId: "n1", status: 200, url: "https://example.test/app.js" }] };
if (command === "network" && subcommand === "request") data = { requestId: args[commandIndex + 2], status: 200, url: "https://example.test/app.js", responseBody: "ok" };
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
if (command === "react") data = { ok: true, subcommand, components: [] };
if (command === "vitals" || command === "web-vitals") data = { lcp: 123, cls: 0, command };
if (command === "dashboard") data = subcommand === "stop" ? { stopped: true } : { pid: 123, port: 4848 };
if (command === "chat") data = { response: "chat done", model: args[args.indexOf("--model") + 1] || process.env.AI_GATEWAY_MODEL || "default" };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	const commands = [
		["network", "route", "**/api", "--body", '{"token":"route-secret"}', "--resource-type", "fetch"],
		["network", "unroute", "**/api"],
		["network", "requests", "--filter", "example"],
		["network", "request", "n1"],
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
		["console", "--clear"],
		["errors"],
		["errors", "--clear"],
		["highlight", "#target"],
		["inspect"],
		["clipboard", "write", "Authorization: Bearer clipboard-secret"],
		["clipboard", "read"],
		["clipboard", "copy"],
		["clipboard", "paste"],
		["stream", "enable", "--port", "7777"],
		["stream", "status"],
		["stream", "disable"],
		["react", "tree"],
		["react", "inspect", "fiber-1"],
		["react", "renders", "start"],
		["react", "renders", "stop", "--json"],
		["react", "suspense", "--only-dynamic", "--json"],
		["vitals", "https://example.test", "--json"],
		["web-vitals", "https://example.test", "--json"],
		["--model", "anthropic/model-flag", "dashboard", "start", "--port", "4848"],
		["dashboard", "stop"],
		["chat", "Summarize Authorization: Bearer chat-secret", "--model", "anthropic/chat-flag"],
	] as const;

	try {
		await withPatchedEnv({ AI_GATEWAY_API_KEY: "ai-gateway-key", AI_GATEWAY_MODEL: "anthropic/env-model", PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Exercise non-core browser workflows." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			let networkRequestsResult: Awaited<ReturnType<typeof executeRegisteredTool>> | undefined;
			for (const args of commands) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args] });
				assert.equal(result.isError, false, args.join(" "));
				assert.doesNotMatch(result.content[0]?.text ?? "", /route-secret|clipboard-secret|chat-secret/);
				assert.doesNotMatch(JSON.stringify(result.details), /route-secret|clipboard-secret|chat-secret/);
				if (args[0] === "network" && args[1] === "requests") networkRequestsResult = result;
			}

			const networkNextActions = networkRequestsResult?.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(networkNextActions?.map((action) => action.id), ["inspect-network-request", "filter-network-requests-by-path", "clear-network-requests-before-repro", "start-network-har-capture"]);
			assert.deepEqual(networkNextActions?.[0]?.params?.args?.slice(-3), ["network", "request", "n1"]);
			assert.deepEqual(networkNextActions?.[1]?.params?.args?.slice(-4), ["network", "requests", "--filter", "/app.js"]);
			assert.deepEqual(networkNextActions?.[2]?.params?.args?.slice(-3), ["network", "requests", "--clear"]);

			const invocations = await readInvocationLog(logPath);
			const userInvocations = invocations.map((entry) => stripWrapperPrefix(entry.args));
			assert.deepEqual(userInvocations, commands.map((args) => [...args]));
			assert.ok(invocations.every((entry) => entry.args.includes("--json")));
			assert.ok(invocations.every((entry) => {
				const userArgs = stripWrapperPrefix(entry.args);
				const commandIndex = userArgs.findIndex((arg, index) => {
					if (arg.startsWith("--")) return false;
					return userArgs[index - 1] !== "--model" && userArgs[index - 1] !== "--port";
				});
				const command = userArgs[commandIndex];
				return command === "dashboard" ? !entry.args.includes("--session") : entry.args.includes("--session");
			}));
			assert.ok(invocations.some((entry) => entry.args.includes("chat") && entry.args.includes("--model") && entry.model === "anthropic/env-model"));
			assert.ok(invocations.some((entry) => entry.args.includes("dashboard") && entry.apiKey === "ai-gateway-key"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension treats stream enable already-enabled as idempotent no-op", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stream-idempotent-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: false, error: "Streaming is already enabled for this session" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Enable stream." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["stream", "enable"] });
			assert.equal(result.isError, false);
			assert.equal(result.details?.resultCategory, "success");
			assert.equal(result.details?.successCategory, "completed");
			assert.equal((result.details?.data as { alreadyEnabled?: unknown } | undefined)?.alreadyEnabled, true);
			assert.match(result.content[0]?.text ?? "", /idempotent no-op/);
			assert.deepEqual((result.details?.nextActions as Array<{ id?: string }> | undefined)?.map((action) => action.id), ["check-stream-status-after-noop", "disable-existing-stream-when-done"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not mask non-exact stream enable failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stream-real-failure-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: false, error: "Streaming is already enabled but health check failed" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Enable stream." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["stream", "enable"] });
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "upstream-error");
			assert.match(result.content[0]?.text ?? "", /health check failed/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports unfulfilled routed network mocks", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-route-diagnostics-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
const commandIndex = args.findIndex((arg, index) => arg === "network" && args[index + 1]);
const subcommand = args[commandIndex + 1];
const data = subcommand === "route"
  ? { routed: args[commandIndex + 2] }
  : { requests: [{ method: "GET", requestId: "mock-1", resourceType: "fetch", status: 404, url: "https://example.test/api/mock" }] };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Mock network route." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const routeResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["network", "route", "**/api/**", "--body", "{}", "--resource-type", "fetch"] });
			assert.equal(routeResult.isError, false);

			const requestsResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["network", "requests"] });
			assert.equal(requestsResult.isError, false);
			assert.match(requestsResult.content[0]?.text ?? "", /Network route diagnostics/);
			assert.deepEqual((requestsResult.details?.networkRouteDiagnostics as Array<{ reason?: string }> | undefined)?.map((item) => item.reason), ["unfulfilled-routed-request"]);
			assert.deepEqual((requestsResult.details?.nextActions as Array<{ id?: string }> | undefined)?.slice(0, 2).map((action) => action.id), ["inspect-routed-network-request", "start-network-har-capture-for-route-mock"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports routed network mocks inside and after batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-route-diagnostics-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", () => {
  const commandIndex = args.findIndex((arg) => arg === "batch" || arg === "network");
  const command = args[commandIndex];
  if (command === "batch") {
    const steps = JSON.parse(stdin);
    const data = steps.map((step) => step[0] === "network" && step[1] === "route"
      ? { command: step, success: true, result: { routed: step[2] } }
      : { command: step, success: true, result: { requests: [{ method: "GET", requestId: "batch-mock-1", resourceType: "fetch", url: "https://example.test/api/batch" }] } });
    process.stdout.write(JSON.stringify({ success: true, data }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { requests: [{ method: "GET", requestId: "later-mock-1", resourceType: "fetch", url: "https://example.test/api/batch" }] } }));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Mock network route in a batch." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["network", "route", "**/api/**", "--body", "{}"], ["network", "requests"]]),
			});
			assert.equal(batchResult.isError, false);
			const batchSteps = batchResult.details?.batchSteps as Array<{ networkRouteDiagnostics?: Array<{ reason?: string }> }> | undefined;
			assert.deepEqual(batchSteps?.[1]?.networkRouteDiagnostics?.map((item) => item.reason), ["pending-routed-request"]);

			const requestsResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["network", "requests"] });
			assert.equal(requestsResult.isError, false);
			assert.deepEqual((requestsResult.details?.networkRouteDiagnostics as Array<{ reason?: string }> | undefined)?.map((item) => item.reason), ["pending-routed-request"]);
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

test("agentBrowserExtension creates parent directories for state save artifacts", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-state-save-path-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const path = args[args.length - 1];
fs.writeFileSync(path, JSON.stringify({ ok: true }));
process.stdout.write(JSON.stringify({ success: true, data: { path } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Save browser state." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const statePath = join(tempDir, "missing", "parents", "fixture-state.json");
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["state", "save", statePath] });

			assert.equal(result.isError, false, JSON.stringify(result));
			assert.equal(await readFile(statePath, "utf8"), JSON.stringify({ ok: true }));
			const [invocation] = await readInvocationLog(logPath);
			assert.equal(invocation.args.at(-1), statePath);
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
