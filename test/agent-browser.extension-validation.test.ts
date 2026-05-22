/**
 * Purpose: Verify extension entrypoint validation and error contracts for the pi-agent-browser tool.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run this file alone with `npx tsx --test test/agent-browser.extension-validation.test.ts` (the `npm test` script uses a glob, so `npm test -- <path>` still runs the full suite). Full gate: `npm run verify`.
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

type RenderThemeColor = Parameters<Theme["fg"]>[0];
type RenderThemeBg = Parameters<Theme["bg"]>[0];

const PLAIN_RENDER_FG_COLORS = {
	accent: "#ffffff",
	bashMode: "#ffffff",
	border: "#ffffff",
	borderAccent: "#ffffff",
	borderMuted: "#ffffff",
	customMessageLabel: "#ffffff",
	customMessageText: "#ffffff",
	dim: "#ffffff",
	error: "#ffffff",
	mdCode: "#ffffff",
	mdCodeBlock: "#ffffff",
	mdCodeBlockBorder: "#ffffff",
	mdHeading: "#ffffff",
	mdHr: "#ffffff",
	mdLink: "#ffffff",
	mdLinkUrl: "#ffffff",
	mdListBullet: "#ffffff",
	mdQuote: "#ffffff",
	mdQuoteBorder: "#ffffff",
	muted: "#ffffff",
	success: "#ffffff",
	syntaxComment: "#ffffff",
	syntaxFunction: "#ffffff",
	syntaxKeyword: "#ffffff",
	syntaxNumber: "#ffffff",
	syntaxOperator: "#ffffff",
	syntaxPunctuation: "#ffffff",
	syntaxString: "#ffffff",
	syntaxType: "#ffffff",
	syntaxVariable: "#ffffff",
	text: "#ffffff",
	thinkingHigh: "#ffffff",
	thinkingLow: "#ffffff",
	thinkingMedium: "#ffffff",
	thinkingMinimal: "#ffffff",
	thinkingOff: "#ffffff",
	thinkingText: "#ffffff",
	thinkingXhigh: "#ffffff",
	toolDiffAdded: "#ffffff",
	toolDiffContext: "#ffffff",
	toolDiffRemoved: "#ffffff",
	toolOutput: "#ffffff",
	toolTitle: "#ffffff",
	userMessageText: "#ffffff",
	warning: "#ffffff",
} satisfies Record<RenderThemeColor, string>;

const PLAIN_RENDER_BG_COLORS = {
	customMessageBg: "#000000",
	selectedBg: "#000000",
	toolErrorBg: "#000000",
	toolPendingBg: "#000000",
	toolSuccessBg: "#000000",
	userMessageBg: "#000000",
} satisfies Record<RenderThemeBg, string>;

class PlainRenderTheme extends Theme {
	constructor() {
		super(PLAIN_RENDER_FG_COLORS, PLAIN_RENDER_BG_COLORS, "truecolor", { name: "plain-render-test" });
	}

	override fg(color: RenderThemeColor, text: string): string {
		return `<${color}>${text}</${color}>`;
	}

	override bg(_color: RenderThemeBg, text: string): string {
		return text;
	}

	override bold(text: string): string {
		return `**${text}**`;
	}

	override italic(text: string): string {
		return text;
	}

	override underline(text: string): string {
		return text;
	}

	override inverse(text: string): string {
		return text;
	}

	override strikethrough(text: string): string {
		return text;
	}
}

const PLAIN_RENDER_THEME = new PlainRenderTheme();

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

async function writeFakeMacElectronApp(options: {
	applicationsDir: string;
	bundleId: string;
	executableName?: string;
	name: string;
}): Promise<{ appPath: string; executablePath: string }> {
	const executableName = options.executableName ?? options.name;
	const appPath = join(options.applicationsDir, `${options.name}.app`);
	const executablePath = join(appPath, "Contents", "MacOS", executableName);
	await mkdir(join(appPath, "Contents", "Frameworks", "Electron Framework.framework"), { recursive: true });
	await mkdir(join(appPath, "Contents", "Resources"), { recursive: true });
	await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
	await writeFile(join(appPath, "Contents", "Resources", "app.asar"), "asar", "utf8");
	await writeFile(executablePath, "#!/bin/sh\n", "utf8");
	await chmod(executablePath, 0o755);
	await writeFile(join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key><string>${options.name}</string>
	<key>CFBundleName</key><string>${options.name}</string>
	<key>CFBundleIdentifier</key><string>${options.bundleId}</string>
	<key>CFBundleExecutable</key><string>${executableName}</string>
</dict>
</plist>
`, "utf8");
	return { appPath, executablePath };
}

async function writeFakeLinuxElectronBinary(root: string, appName: string): Promise<string> {
	const appDirectory = join(root, appName);
	const executablePath = join(appDirectory, appName);
	await mkdir(join(appDirectory, "resources"), { recursive: true });
	await writeFile(executablePath, "#!/bin/sh\n", "utf8");
	await chmod(executablePath, 0o755);
	await writeFile(join(appDirectory, "resources", "app.asar"), "asar", "utf8");
	await writeFile(join(appDirectory, "chrome_100_percent.pak"), "pak", "utf8");
	return executablePath;
}

function electronAppNames(apps: ElectronAppDiscovery[]): string[] {
	return apps.map((app) => app.name).sort();
}

function isTestPidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTestPidExit(pid: number | undefined, timeoutMs = 2_000): Promise<boolean> {
	const deadlineMs = Date.now() + timeoutMs;
	while (Date.now() <= deadlineMs) {
		if (!isTestPidAlive(pid)) return true;
		await sleepMs(50);
	}
	return !isTestPidAlive(pid);
}

async function stopTestPid(pid: number | undefined): Promise<void> {
	if (!pid || !isTestPidAlive(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	if (await waitForTestPidExit(pid, 1_000)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Best-effort test cleanup only.
	}
	await waitForTestPidExit(pid, 1_000);
}

interface FakeElectronLaunchLogEntry {
	args: string[];
	mode: "invalid-cdp" | "no-port-file" | "normal";
	pid: number;
	port?: number;
	userDataDir: string;
}

async function readOptionalFakeElectronLaunchLog(path: string): Promise<FakeElectronLaunchLogEntry[]> {
	try {
		const text = (await readFile(path, "utf8")).trim();
		return text.length > 0 ? text.split("\n").map((line) => JSON.parse(line) as FakeElectronLaunchLogEntry) : [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function writeFakeLaunchableElectronApp(options: {
	applicationsDir: string;
	bundleId: string;
	includeWebview?: boolean;
	launchLogPath: string;
	mode?: "invalid-cdp" | "no-port-file" | "normal";
	name: string;
	writeLaunchLog?: boolean;
}): Promise<{ appPath: string; executablePath: string }> {
	const app = await writeFakeMacElectronApp(options);
	const mode = options.mode ?? "normal";
	await writeFile(app.executablePath, `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const mode = ${JSON.stringify(mode)};
const includeWebview = ${JSON.stringify(options.includeWebview === true)};
const writeLaunchLog = ${JSON.stringify(options.writeLaunchLog !== false)};
const args = process.argv.slice(2);
const userDataArg = args.find((arg) => arg.startsWith("--user-data-dir="));
const userDataDir = userDataArg && userDataArg.slice("--user-data-dir=".length);
if (!userDataDir) throw new Error("missing --user-data-dir");
if (!args.includes("--remote-debugging-port=0")) throw new Error("missing --remote-debugging-port=0");
const server = http.createServer((request, response) => {
	const port = server.address().port;
	if (request.url === "/json/version") {
		if (mode === "invalid-cdp") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end("not-json");
			return;
		}
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ Browser: "Electron/Fake", "Protocol-Version": "1.3", "User-Agent": "FakeElectron", webSocketDebuggerUrl: ` + "`ws://127.0.0.1:${port}/devtools/browser/fake`" + ` }));
	return;
	}
	if (request.url === "/json/list") {
	response.writeHead(200, { "content-type": "application/json" });
	const targets = [{ id: "page-1", type: "page", title: "Demo Electron", url: "app://demo", webSocketDebuggerUrl: ` + "`ws://127.0.0.1:${port}/devtools/page/page-1`" + ` }];
	if (includeWebview) targets.push({ id: "webview-1", type: "webview", title: "Demo Webview", url: "app://webview", webSocketDebuggerUrl: ` + "`ws://127.0.0.1:${port}/devtools/page/webview-1`" + ` });
	response.end(JSON.stringify(targets));
	return;
	}
	response.writeHead(404);
	response.end("not found");
});
server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	if (mode !== "no-port-file") fs.writeFileSync(path.join(userDataDir, "DevToolsActivePort"), String(port) + "\\n/devtools/browser/fake\\n");
	if (writeLaunchLog) fs.appendFileSync(${JSON.stringify(options.launchLogPath)}, JSON.stringify({ args, mode, pid: process.pid, port, userDataDir }) + "\\n");
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`, "utf8");
	await chmod(app.executablePath, 0o755);
	return app;
}

function fakeAgentBrowserLifecycleScript(logPath: string, options: {
	sessionTitle?: string;
	sessionUrl?: string;
	snapshotTitle?: string;
	snapshotUrl?: string;
	tabTitle?: string;
	tabUrl?: string;
} = {}): string {
	const sessionTitle = options.sessionTitle ?? "Demo Electron";
	const sessionUrl = options.sessionUrl ?? "app://demo";
	const snapshotTitle = options.snapshotTitle ?? "Demo Electron";
	const snapshotUrl = options.snapshotUrl ?? "app://demo";
	const tabTitle = options.tabTitle ?? "Demo Electron";
	const tabUrl = options.tabUrl ?? "app://demo";
	return `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS || null }) + "\\n");
const valueFlags = new Set(["--session", "--profile", "--state", "--session-name", "--cdp", "--provider", "-p", "--device", "--user-agent"]);
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
let data = { ok: true };
if (command === "connect") data = { connected: true, endpoint: subcommand };
else if (command === "get" && subcommand === "title") data = { result: ${JSON.stringify(sessionTitle)}, title: ${JSON.stringify(sessionTitle)} };
else if (command === "get" && subcommand === "url") data = { result: ${JSON.stringify(sessionUrl)}, url: ${JSON.stringify(sessionUrl)} };
else if (command === "eval") data = { result: { focusedElement: { id: "run-button", name: "Run", role: "button", tagName: "button" } } };
else if (command === "tab" && subcommand === "list") data = { tabs: [{ active: true, index: 0, tabId: "page-1", title: ${JSON.stringify(tabTitle)}, type: "page", url: ${JSON.stringify(tabUrl)} }] };
else if (command === "snapshot") data = { origin: ${JSON.stringify(snapshotUrl)}, title: ${JSON.stringify(snapshotTitle)}, url: ${JSON.stringify(snapshotUrl)}, refs: { e1: { role: "button", name: "Run" } }, snapshot: "- button \\\"Run\\\" [ref=e1]" };
else if (command === "close") data = { closed: true };
process.stdout.write(JSON.stringify({ success: true, data }));`;
}

test("agentBrowserExtension keeps concise browser guidance plus installed doc pointers in tool metadata", async () => {
	await withPatchedEnv({ BRAVE_API_KEY: "demo-key" }, async () => {
		const harness = createExtensionHarness({ cwd: process.cwd() });
		assert.deepEqual([...harness.handlers.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start", "tool_call", "tool_result"]);
		assert.equal(harness.tool.name, "agent_browser");
		assert.match(harness.tool.description, /authenticated\/profile-based browser work/);
		assert.match(harness.tool.promptSnippet, /real web workflows/);
		const parameterSchema = harness.tool.parameters as { properties?: { args?: { description?: string } } };
		assert.match(parameterSchema.properties?.args?.description ?? "", /networkSourceLookup, or electron/);

		const docsGuideline = buildInstalledDocsGuideline({
			readmePath: join(process.cwd(), "README.md"),
			commandReferencePath: join(process.cwd(), "docs", "COMMAND_REFERENCE.md"),
			toolContractPath: join(process.cwd(), "docs", "TOOL_CONTRACT.md"),
		});
		const guidelineText = harness.tool.promptGuidelines.join("\n");
		const requiredGuidelines = [
			...TOOL_PROMPT_GUIDELINES_PREFIX,
			docsGuideline,
			BRAVE_SEARCH_PROMPT_GUIDELINE,
			TOOL_PROMPT_GUIDELINES_SUFFIX[0],
		];
		for (const guideline of requiredGuidelines) {
			assert.equal(
				harness.tool.promptGuidelines.includes(guideline),
				true,
				`missing concise runtime guideline: ${guideline}`,
			);
		}
		assert.match(guidelineText, /Use exactly one input mode/);
		assert.match(guidelineText, /Common flow: open, snapshot -i/);
		assert.match(guidelineText, /Respect explicit stop boundaries/);
		assert.match(guidelineText, /exact user path/);
		assert.match(guidelineText, /signed-in\/account-specific content/);
		assert.match(guidelineText, /reading several known refs\/selectors/);
		assert.match(guidelineText, /record stop needs ffmpeg/);
		assert.match(guidelineText, /For dashboards, verify scroll/);
		assert.match(guidelineText, /When details\.nextActions is present/);
		assert.equal(harness.tool.promptGuidelines.includes(SHARED_BROWSER_PLAYBOOK_GUIDELINES[12]), false);
		assert.equal(harness.tool.promptGuidelines.includes(QUICK_START_GUIDELINES[0]), false);
		assert.ok(harness.tool.promptGuidelines.length <= 15, "promptGuidelines should stay bounded");
		assert.ok(
			guidelineText.length < 4_500,
			"promptGuidelines should point to docs instead of carrying the full command reference/playbook",
		);
		assert.equal(
			WRAPPER_TAB_RECOVERY_BEHAVIOR.some((line) => line.includes("For sessions with observed tab-drift risk")),
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

test("agentBrowserExtension reports no-op scroll diagnostics with recovery next actions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-noop-scroll-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "scroll-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--profile", "--state", "--session-name", "--cdp", "--provider", "-p", "--device"]);
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
const amount = args[commandIndex + 2];
let state = { moved: false };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "scroll" && amount === "701") {
  state.moved = true;
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
const snapshot = {
  scrollX: 0,
  scrollY: state.moved ? 701 : 0,
  innerHeight: 600,
  innerWidth: 800,
  scrollHeight: 1600,
  scrollWidth: 800,
  containerCount: 1,
  containers: [{ id: "0:main.dashboard", scrollTop: state.moved ? 701 : 0, scrollLeft: 0 }]
};
const data = command === "eval" ? { result: snapshot } : { scrolled: true };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check scroll recovery diagnostics." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const noopResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "down", "700"], sessionMode: "fresh" });
			assert.equal(noopResult.isError, false);
			assert.match(noopResult.content[0]?.text ?? "", /Scroll diagnostic: no observed scroll movement/);
			const noopDetails = noopResult.details as {
				nextActions: Array<{ id: string; params?: { args: string[] } }>;
				pageChangeSummary: { nextActionIds: string[] };
				scrollNoop: { before: { containers: Array<{ id: string }> }; reason: string };
			};
			assert.equal(noopDetails.scrollNoop.reason, "no-observed-scroll-position-change");
			assert.equal(noopDetails.scrollNoop.before.containers[0]?.id, "sample-0");
			assert.deepEqual(
				noopDetails.nextActions.map((action) => action.id).filter((id) => id.includes("noop-scroll")),
				["inspect-after-noop-scroll", "verify-noop-scroll-visually"],
			);
			const scrollRecoveryActions = noopDetails.nextActions.filter((action) => action.id.includes("noop-scroll"));
			assert.ok(scrollRecoveryActions.every((action) => action.params?.args[0] === "--session"));
			assert.deepEqual(
				noopDetails.pageChangeSummary.nextActionIds.filter((id) => id.includes("noop-scroll")),
				["inspect-after-noop-scroll", "verify-noop-scroll-visually"],
			);

			const movedResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "down", "701"] });
			assert.equal(movedResult.isError, false);
			const movedDetails = movedResult.details as { scrollNoop?: unknown };
			assert.equal(movedDetails.scrollNoop, undefined);
			assert.doesNotMatch(movedResult.content[0]?.text ?? "", /Scroll diagnostic/);

			const evalCallsBeforeLaunchScopedScroll = (await readInvocationLog(logPath)).filter((entry) => entry.args.includes("eval")).length;
			const launchScopedResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--profile", "Default", "scroll", "down", "700"], sessionMode: "fresh" });
			assert.equal(launchScopedResult.isError, false);
			assert.equal((launchScopedResult.details as { scrollNoop?: unknown }).scrollNoop, undefined);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, evalCallsBeforeLaunchScopedScroll);
			assert.ok(invocations.some((entry) => entry.args.includes("--profile") && entry.args.includes("scroll")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports focused combobox diagnostics with option-opening next actions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-combobox-focus-"));
	const statePath = join(tempDir, "combobox-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
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
const target = args[commandIndex + 1];
const value = args[commandIndex + 2];
const action = args[commandIndex + 3];
const nameIndex = args.indexOf("--name");
const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
let state = { mode: "none" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "find" && target === "role" && value === "combobox" && action === "click") {
  state.mode = name === "MissingExpanded" ? "combo-missing" : name === "Open" ? "combo-open" : name === "OptionsVisible" ? "combo-options" : "combo";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
} else if (command === "click") {
  state.mode = "textbox";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
let result = { ok: true, command, target };
if (command === "eval") {
  result = state.mode === "combo"
    ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "false", hasPopup: "listbox", name: "Datasource", tagName: "input" } }
    : state.mode === "combo-missing"
      ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", hasPopup: "listbox", name: "MissingExpanded", tagName: "input" } }
      : state.mode === "combo-open"
        ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "true", hasPopup: "listbox", name: "Open", tagName: "input" } }
        : state.mode === "combo-options"
          ? { comboboxLike: true, visibleListboxCount: 1, visibleOptionCount: 2, activeElement: { role: "combobox", expanded: "false", hasPopup: "listbox", name: "OptionsVisible", tagName: "input" } }
          : { comboboxLike: false, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "textbox", name: "Search", tagName: "input" } };
}
process.stdout.write(JSON.stringify({ success: true, data: command === "eval" ? { result } : result }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check combobox recovery diagnostics." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const comboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "role", value: "combobox", name: "Datasource" }, sessionMode: "fresh" });
			assert.equal(comboboxResult.isError, false);
			assert.match(comboboxResult.content[0]?.text ?? "", /Combobox diagnostic: focused combobox did not expose visible options/);
			const details = comboboxResult.details as {
				comboboxFocus: { reason: string; activeElement: { name?: string; role?: string } };
				nextActions: Array<{ id: string; params?: { args: string[] } }>;
			};
			assert.equal(details.comboboxFocus.reason, "focused-combobox-without-visible-options");
			assert.equal(details.comboboxFocus.activeElement.role, "combobox");
			assert.equal(details.comboboxFocus.activeElement.name, "Datasource");
			const comboboxActionIds = details.nextActions.map((action) => action.id).filter((id) => id.includes("combobox"));
			assert.deepEqual(comboboxActionIds, ["inspect-focused-combobox", "try-open-combobox-with-arrow", "try-open-combobox-with-enter"]);
			assert.ok(details.nextActions.filter((action) => action.id.includes("combobox")).every((action) => action.params?.args[0] === "--session"));
			const openComboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "role", value: "combobox", name: "Open" } });
			assert.equal(openComboboxResult.isError, false);
			assert.match(openComboboxResult.content[0]?.text ?? "", /Combobox diagnostic: focused combobox did not expose visible options/);
			assert.equal((openComboboxResult.details as { comboboxFocus?: { activeElement?: { name?: string; expanded?: string } } }).comboboxFocus?.activeElement?.name, "Open");
			assert.equal((openComboboxResult.details as { comboboxFocus?: { activeElement?: { name?: string; expanded?: string } } }).comboboxFocus?.activeElement?.expanded, "true");

			for (const name of ["MissingExpanded", "OptionsVisible"]) {
				const negativeComboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "role", value: "combobox", name } });
				assert.equal(negativeComboboxResult.isError, false, name);
				assert.equal((negativeComboboxResult.details as { comboboxFocus?: unknown }).comboboxFocus, undefined, name);
				assert.doesNotMatch(negativeComboboxResult.content[0]?.text ?? "", /Combobox diagnostic/, name);
			}

			const textboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@text"] });
			assert.equal(textboxResult.isError, false);
			assert.equal((textboxResult.details as { comboboxFocus?: unknown }).comboboxFocus, undefined);
			assert.doesNotMatch(textboxResult.content[0]?.text ?? "", /Combobox diagnostic/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves combobox diagnostics after semanticAction visible-ref resolution", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-combobox-visible-ref-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "combobox-visible-ref-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session"]);
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
let state = { mode: "none" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "open") {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Grafana", url: "https://grafana.example.test/" } }));
} else if (command === "snapshot") {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://grafana.example.test/",
    refs: { e65: { role: "combobox", name: "Job" } },
    snapshot: '- combobox "Job" [ref=e65]'
  } }));
} else if (command === "click") {
  state.mode = args[commandIndex + 1] === "@e65" ? "combo" : "other";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[commandIndex + 1] } }));
} else if (command === "eval") {
  const result = state.mode === "combo"
    ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "true", hasPopup: "listbox", name: "Job", tagName: "input" } }
    : { comboboxLike: false, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "textbox", name: "Other", tagName: "input" } };
  process.stdout.write(JSON.stringify({ success: true, data: { result } }));
} else if (command === "get" && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Grafana" } }));
} else if (command === "get" && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://grafana.example.test/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check visible-ref combobox recovery diagnostics." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://grafana.example.test/"] });
			assert.equal(open.isError, false);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", value: "combobox", name: "Job" },
			});
			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Combobox diagnostic: focused combobox did not expose visible options/);
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-2), ["click", "@e65"]);
			assert.equal((result.details?.comboboxFocus as { activeElement?: { role?: string; name?: string } } | undefined)?.activeElement?.role, "combobox");
			assert.equal((result.details?.comboboxFocus as { activeElement?: { role?: string; name?: string } } | undefined)?.activeElement?.name, "Job");
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("snapshot")));
			assert.ok(invocations.some((entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e65"));
			assert.equal(invocations.some((entry) => entry.args.includes("find")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns after record start when ffmpeg is missing", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-recording-ffmpeg-"));
	const nodeBinDir = dirname(process.execPath);
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
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
process.stdout.write(JSON.stringify({ success: true, data: { command, subcommand, path: args[commandIndex + 2] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${nodeBinDir}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Record a browser workflow." });
			await mkdir(join(tempDir, "ffmpeg"));
			const missingResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "demo.webm"] });
			assert.equal(missingResult.isError, false);
			assert.match(missingResult.content[0]?.text ?? "", /Recording dependency warning: ffmpeg not found on PATH/);
			const missingDetails = missingResult.details as { recordingDependencyWarning?: { reason?: string; command?: string; dependency?: string } };
			assert.deepEqual(missingDetails.recordingDependencyWarning, {
				command: "record start",
				dependency: "ffmpeg",
				message: "record start can begin recording, but record stop needs ffmpeg on PATH to encode the WebM output.",
				reason: "ffmpeg-missing-for-recording",
				recommendations: [
					"Install ffmpeg before relying on this recording workflow; on macOS with Homebrew, brew install ffmpeg or brew install ffmpeg-full.",
					"If ffmpeg was just installed, restart pi or ensure the PATH visible to pi includes the ffmpeg binary before running record stop.",
				],
			});

			await rm(join(tempDir, "ffmpeg"), { recursive: true, force: true });
			await writeFile(join(tempDir, "ffmpeg"), "#!/bin/sh\nexit 0\n", "utf8");
			await chmod(join(tempDir, "ffmpeg"), 0o755);
			const presentResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "demo.webm"] });
			assert.equal(presentResult.isError, false);
			assert.equal((presentResult.details as { recordingDependencyWarning?: unknown }).recordingDependencyWarning, undefined);
			assert.doesNotMatch(presentResult.content[0]?.text ?? "", /Recording dependency warning/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
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

			let networkRequestsResult: Awaited<ReturnType<typeof executeRegisteredTool>> | undefined;
			for (const args of commands) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args] });
				assert.equal(result.isError, false, args.join(" "));
				assert.doesNotMatch(result.content[0]?.text ?? "", /route-secret|clipboard-secret|chat-secret/);
				assert.doesNotMatch(JSON.stringify(result.details), /route-secret|clipboard-secret|chat-secret/);
				if (args[0] === "network" && args[1] === "requests") networkRequestsResult = result;
			}

			const networkNextActions = networkRequestsResult?.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(networkNextActions?.map((action) => action.id), ["inspect-network-request", "filter-network-requests-by-path", "start-network-har-capture"]);
			assert.deepEqual(networkNextActions?.[0]?.params?.args?.slice(-3), ["network", "request", "n1"]);
			assert.deepEqual(networkNextActions?.[1]?.params?.args?.slice(-4), ["network", "requests", "--filter", "/app.js"]);

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

test("agentBrowserExtension accepts action-specific electron schema and routes list without upstream spawn", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-schema-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: "should not run" }));`,
	);
	if (process.platform === "darwin") {
		await mkdir(join(tempDir, "Applications"), { recursive: true });
		await writeFakeMacElectronApp({ applicationsDir: join(tempDir, "Applications"), bundleId: "md.obsidian", name: "Obsidian" });
	} else if (process.platform === "linux") {
		const executablePath = await writeFakeLinuxElectronBinary(tempDir, "obsidian");
		const desktopDir = join(tempDir, ".local", "share", "applications");
		await mkdir(desktopDir, { recursive: true });
		await writeFile(join(desktopDir, "obsidian.desktop"), `[Desktop Entry]\nType=Application\nName=Obsidian\nExec=${executablePath}\n`, "utf8");
	}

	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list" } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", maxResults: 10, query: "code" } }), true);
			assert.equal(Check(harness.tool.parameters, {
				electron: {
					action: "launch",
					allow: ["Code"],
					appArgs: ["--safe-mode"],
					appName: "Code",
					deny: ["Slack"],
					handoff: "tabs",
					targetType: "webview",
					timeoutMs: 1_000,
				},
			}), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", launchId: "launch-1", timeoutMs: 1_000 } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", timeoutMs: 1_000 } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "cleanup", all: true, timeoutMs: 1_000 } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", all: true, launchId: "launch-1" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "cleanup", all: true, launchId: "launch-1" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", all: false } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "cleanup", all: false } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: {} }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "probe" } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "probe", launchId: "launch-1", timeoutMs: 1_000 } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "probe", timeoutMs: 0 } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "probe", handoff: "tabs" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", handoff: "tabs" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "cleanup", handoff: "tabs" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", launchId: "launch-1" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", query: 42 } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", query: "" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", maxResults: "10" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", maxResults: 1.5 } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "launch", allow: [""] } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "launch", appName: "Code", appPath: "/Applications/Visual Studio Code.app" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "launch", appName: "Code", launchId: "launch-1" } }), false);

			const listResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "list", maxResults: 1, query: "__piab_no_matching_electron_app__" },
			});
			assert.equal(listResult.isError, false);
			assert.match(listResult.content[0]?.text ?? "", /Electron apps \(0 found\):/);
			assert.deepEqual(listResult.details?.compiledElectron, { action: "list", maxResults: 1, query: "__piab_no_matching_electron_app__" });
			assert.equal((listResult.details?.electron as { action?: string; status?: string } | undefined)?.action, "list");
			assert.equal((listResult.details?.electron as { action?: string; status?: string } | undefined)?.status, "succeeded");
			assert.equal(listResult.details?.resultCategory, "success");
			if (process.platform === "darwin" || process.platform === "linux") {
				const sensitiveListResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "list", maxResults: 5, query: "Obsidian" },
				});
				assert.equal(sensitiveListResult.isError, false);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /Obsidian.*\[likely sensitive: notes\]/);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /Review likely-sensitive apps and use caller-owned allow\/deny policy before launch\./);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /Profile note: electron\.launch starts an isolated temporary profile/);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /For already-authenticated desktop app content, do not stop here/);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /launch the normal app with --remote-debugging-port=<port>/);
				const electronDetails = sensitiveListResult.details?.electron as { apps?: Array<{ name?: string; sensitivity?: { categories?: string[]; level?: string } }>; profileIsolation?: { reusesExistingSignedInProfile?: boolean; attachesToAlreadyRunningApp?: boolean; hostDebugLaunchExample?: string }; sensitiveAppCount?: number } | undefined;
				assert.ok((electronDetails?.sensitiveAppCount ?? 0) >= 1);
				assert.equal(electronDetails?.profileIsolation?.reusesExistingSignedInProfile, false);
				assert.equal(electronDetails?.profileIsolation?.attachesToAlreadyRunningApp, false);
				assert.match(electronDetails?.profileIsolation?.hostDebugLaunchExample ?? "", /open -a <App Name> --args --remote-debugging-port=9222/);
				assert.ok(electronDetails?.apps?.some((app) => app.name === "Obsidian" && app.sensitivity?.level === "likely-sensitive" && app.sensitivity.categories?.includes("notes")));
			}
			assert.deepEqual(await readInvocationLog(logPath), []);

			const missingAction = await executeRegisteredTool(harness.tool, harness.ctx, { electron: {} });
			assert.equal(missingAction.isError, true);
			assert.match(missingAction.content[0]?.text ?? "", /electron\.action must be one of: list, launch, status, cleanup, probe/);
			assert.equal(missingAction.details?.failureCategory, "validation-error");

			const unknownAction = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "bogus" } });
			assert.equal(unknownAction.isError, true);
			assert.match(unknownAction.content[0]?.text ?? "", /electron\.action must be one of/);

			const statusWithHandoff = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "status", handoff: "tabs" } });
			assert.equal(statusWithHandoff.isError, true);
			assert.match(statusWithHandoff.content[0]?.text ?? "", /electron\.status does not support electron\.handoff/);

			for (const action of ["status", "cleanup"] as const) {
				const allFalse = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action, all: false } });
				assert.equal(allFalse.isError, true, action);
				assert.match(allFalse.content[0]?.text ?? "", /electron\.all must be true when provided/);
				assert.equal(allFalse.details?.failureCategory, "validation-error");
			}

			const probeWithListField = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", query: "demo" } });
			assert.equal(probeWithListField.isError, true);
			assert.match(probeWithListField.content[0]?.text ?? "", /electron\.probe only supports action, launchId, and timeoutMs; remove electron\.query/);

			const probeWithoutSession = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", launchId: "launch-1" } });
			assert.equal(probeWithoutSession.isError, true);
			assert.deepEqual(probeWithoutSession.details?.compiledElectron, { action: "probe", launchId: "launch-1" });
			assert.match(probeWithoutSession.content[0]?.text ?? "", /No wrapper-tracked Electron launch found for launchId launch-1/);
			assert.equal(probeWithoutSession.details?.failureCategory, "validation-error");

			const badQuery = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "list", query: 7 } });
			assert.equal(badQuery.isError, true);
			assert.match(badQuery.content[0]?.text ?? "", /electron\.query must be a non-empty string/);

			const listWithLaunchField = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "list", appName: "Code" } });
			assert.equal(listWithLaunchField.isError, true);
			assert.match(listWithLaunchField.content[0]?.text ?? "", /electron\.list only supports query and maxResults; remove electron\.appName/);

			const missingLaunchTarget = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch" } });
			assert.equal(missingLaunchTarget.isError, true);
			assert.match(missingLaunchTarget.content[0]?.text ?? "", /electron\.launch requires exactly one of appPath, appName, bundleId, or executablePath/);
			assert.equal(missingLaunchTarget.details?.failureCategory, "validation-error");

			const reservedAppArg = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: "/Applications/Demo.app", appArgs: ["--remote-debugging-port=9222"] } });
			assert.equal(reservedAppArg.isError, true);
			assert.match(reservedAppArg.content[0]?.text ?? "", /electron\.appArgs must not include wrapper-owned launch flag --remote-debugging-port=9222/);
			assert.equal(reservedAppArg.details?.failureCategory, "validation-error");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension launches Electron with isolated profile, snapshot handoff, status, and cleanup", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-launch-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.DemoElectron", launchLogPath, name: "Demo Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "launch", appArgs: ["--fixture-mode"], appPath: app.appPath },
			});
			assert.equal(launchResult.isError, false);
			assert.match(launchResult.content[0]?.text ?? "", /Electron launch: Demo Electron attached/);
			assert.match(launchResult.content[0]?.text ?? "", /Identifiers: launchId .* sessionName .* for browser snapshot\/tab commands/);
			assert.match(launchResult.content[0]?.text ?? "", /Profile note: electron\.launch starts an isolated temporary profile/);
			assert.match(launchResult.content[0]?.text ?? "", /does not reuse the app's normal signed-in profile/);
			assert.match(launchResult.content[0]?.text ?? "", /do not stop here: if host tools are allowed/);
			assert.match(launchResult.content[0]?.text ?? "", /then run agent_browser connect <port>/);
			assert.match(launchResult.content[0]?.text ?? "", /Snapshot handoff: 1 interactive ref/);
			assert.match(launchResult.content[0]?.text ?? "", /Cleanup: use details\.nextActions cleanup-electron-launch or call electron\.cleanup with launchId/);
			const launchDetails = launchResult.details as {
				effectiveArgs: string[];
				electron: { handoff?: { refSnapshot?: { refIds: string[] } }; identifiers?: { appName?: string; launchId?: string; sessionName?: string }; launch: { launchId: string; port: number; sessionName: string; userDataDir: string }; profileIsolation?: { reusesExistingSignedInProfile?: boolean; attachesToAlreadyRunningApp?: boolean; hostDebugLaunchExample?: string } };
				nextActions: Array<{ id: string; params?: { args?: string[]; electron?: { action: string; launchId?: string } } }>;
				refSnapshot: { refIds: string[] };
				sessionMode: string;
			};
			assert.equal(launchDetails.sessionMode, "fresh");
			assert.deepEqual(launchDetails.electron.identifiers, { appName: "Demo Electron", launchId: launchDetails.electron.launch.launchId, sessionName: launchDetails.electron.launch.sessionName });
			assert.equal(launchDetails.electron.profileIsolation?.reusesExistingSignedInProfile, false);
			assert.equal(launchDetails.electron.profileIsolation?.attachesToAlreadyRunningApp, false);
			assert.match(launchDetails.electron.profileIsolation?.hostDebugLaunchExample ?? "", /agent_browser connect 9222/);
			assert.equal(launchDetails.effectiveArgs.at(-2), "connect");
			assert.match(launchDetails.effectiveArgs.at(-1) ?? "", /\/devtools\/page\/page-1$/);
			assert.deepEqual(launchDetails.refSnapshot.refIds, ["e1"]);
			assert.deepEqual(launchDetails.electron.handoff?.refSnapshot?.refIds, ["e1"]);
			assert.ok(launchDetails.nextActions.some((action) => action.id === "cleanup-electron-launch" && action.params?.electron?.launchId === launchDetails.electron.launch.launchId));
			assert.ok(launchDetails.nextActions.some((action) => action.id === "snapshot-electron-session" && action.params?.args?.includes("snapshot")));

			const launchLog = (await readFile(launchLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; userDataDir: string });
			assert.equal(launchLog.length, 1);
			assert.equal(launchLog[0]?.args.includes("--remote-debugging-port=0"), true);
			assert.equal(launchLog[0]?.args.includes("--fixture-mode"), true);
			assert.equal(launchLog[0]?.userDataDir, launchDetails.electron.launch.userDataDir);
			assert.match(launchDetails.electron.launch.userDataDir, /electron-profile-/);
			await stat(launchDetails.electron.launch.userDataDir);

			const invocationsAfterLaunch = await readInvocationLog(upstreamLogPath);
			assert.deepEqual(invocationsAfterLaunch.map((entry) => entry.args.at(-2)), ["connect", "tab", "snapshot"]);
			assert.equal(invocationsAfterLaunch[0]?.args.includes("--session"), true);

			const statusResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "status", launchId: launchDetails.electron.launch.launchId },
			});
			assert.equal(statusResult.isError, false);
			assert.match(statusResult.content[0]?.text ?? "", /debug port alive/);
			assert.match(statusResult.content[0]?.text ?? "", /Identifiers: launchId .*; sessionName/);
			assert.deepEqual((statusResult.details?.electron as { identifiers?: unknown } | undefined)?.identifiers, launchDetails.electron.identifiers);
			assert.equal(((statusResult.details?.electron as { targets?: unknown[] } | undefined)?.targets ?? []).length, 1);

			await rm(upstreamLogPath, { force: true });
			const probeResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", timeoutMs: 1_000 } });
			assert.equal(probeResult.isError, false);
			assert.match(probeResult.content[0]?.text ?? "", /Electron probe: Demo Electron — app:\/\/demo/);
			assert.match(probeResult.content[0]?.text ?? "", /Focused: button\/button "Run" \(#run-button\)/);
			assert.match(probeResult.content[0]?.text ?? "", /Snapshot: 1 interactive ref\(s\)/);
			const probeDetails = probeResult.details as {
				electron: { action?: string; identifiers?: { appName?: string; launchId?: string; sessionName?: string }; probe?: { focusedElement?: { id?: string }; refSnapshot?: unknown; snapshot?: { refIds?: string[] }; title?: string; url?: string } };
				sessionName?: string;
				sessionTabTarget?: { title?: string; url?: string };
			};
			assert.deepEqual(probeResult.details?.compiledElectron, { action: "probe", timeoutMs: 1_000 });
			assert.equal(probeDetails.electron.action, "probe");
			assert.deepEqual(probeDetails.electron.identifiers, launchDetails.electron.identifiers);
			assert.equal(probeDetails.electron.probe?.title, "Demo Electron");
			assert.equal(probeDetails.electron.probe?.url, "app://demo");
			assert.equal(probeDetails.electron.probe?.focusedElement?.id, "run-button");
			assert.deepEqual(probeDetails.electron.probe?.snapshot?.refIds, ["e1"]);
			assert.equal(probeDetails.electron.probe?.refSnapshot, undefined);
			assert.equal(probeDetails.sessionName, launchDetails.electron.launch.sessionName);
			assert.deepEqual(probeDetails.sessionTabTarget, { title: "Demo Electron", url: "app://demo" });
			const probeInvocations = await readInvocationLog(upstreamLogPath);
			assert.deepEqual(probeInvocations.map((entry) => entry.args.at(-2)), ["get", "get", "eval", "tab", "snapshot"]);

			const broadTextResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", "body"] });
			assert.equal(broadTextResult.isError, false);
			assert.match(broadTextResult.content[0]?.text ?? "", /Broad Electron get text selector warning: selector "body" may read the entire app shell/);
			const broadTextDetails = broadTextResult.details as { electronGetTextScopeWarning?: { electronContext?: { launchId?: string; sessionName?: string }; selector?: string }; nextActions?: Array<{ id?: string; params?: { args?: string[] } }> };
			assert.equal(broadTextDetails.electronGetTextScopeWarning?.selector, "body");
			assert.deepEqual(broadTextDetails.electronGetTextScopeWarning?.electronContext, { launchId: launchDetails.electron.launch.launchId, sessionName: launchDetails.electron.launch.sessionName, url: "app://demo" });
			assert.ok(broadTextDetails.nextActions?.some((action) => action.id === "snapshot-for-electron-text-scope" && action.params?.args?.includes("snapshot")));

			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "cleanup", launchId: launchDetails.electron.launch.launchId },
			});
			assert.equal(cleanupResult.isError, false);
			assert.match(cleanupResult.content[0]?.text ?? "", /fully cleaned/);
			await assert.rejects(stat(launchDetails.electron.launch.userDataDir));
			const finalInvocations = await readInvocationLog(upstreamLogPath);
			assert.equal(finalInvocations.some((entry) => entry.args.at(-1) === "close"), true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports Electron session mismatch and launchId-aware probe", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-mismatch-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	let launchedPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.MismatchElectron", launchLogPath, name: "Mismatch Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath, {
			sessionTitle: "Blank Page",
			sessionUrl: "about:blank",
			tabTitle: "Blank Page",
			tabUrl: "about:blank",
		}));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } });
			assert.equal(launchResult.isError, false);
			const launchDetails = launchResult.details as {
				electron: { launch: { launchId: string; pid: number; sessionName: string; userDataDir: string } };
			};
			launchedPid = launchDetails.electron.launch.pid;
			const { launchId, sessionName } = launchDetails.electron.launch;

			await rm(upstreamLogPath, { force: true });
			const currentUrlResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(currentUrlResult.isError, false);
			assert.match(currentUrlResult.content[0]?.text ?? "", /Electron session mismatch: managed session .* is on about:blank, but launch .* still has live target Demo Electron/);
			const currentUrlDetails = currentUrlResult.details as {
				electronSessionMismatch?: { launchId?: string; reason?: string; managedSession?: { url?: string }; liveTarget?: { url?: string } };
				nextActions?: Array<{ id: string; params?: { args?: string[]; electron?: { action?: string; launchId?: string }; sessionMode?: string } }>;
			};
			assert.equal(currentUrlDetails.electronSessionMismatch?.launchId, launchId);
			assert.equal(currentUrlDetails.electronSessionMismatch?.reason, "managed-session-about-blank-while-launch-target-live");
			assert.equal(currentUrlDetails.electronSessionMismatch?.managedSession?.url, "about:blank");
			assert.equal(currentUrlDetails.electronSessionMismatch?.liveTarget?.url, "app://demo");
			const currentUrlActionIds = new Set(currentUrlDetails.nextActions?.map((action) => action.id));
			for (const actionId of ["status-electron-launch", "probe-electron-launch", "reattach-electron-launch", "cleanup-electron-launch", "snapshot-electron-session"]) {
				assert.equal(currentUrlActionIds.has(actionId), true, actionId);
			}
			assert.ok(currentUrlDetails.nextActions?.some((action) => action.id === "reattach-electron-launch" && action.params?.sessionMode === "fresh" && action.params?.args?.[0] === "connect"));

			const statusResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "status", launchId } });
			assert.equal(statusResult.isError, false);
			assert.match(statusResult.content[0]?.text ?? "", /Electron session mismatch: managed session .* is on about:blank, but launch .* still has live target Demo Electron/);
			const statusDetails = statusResult.details as {
				electron?: { managedSession?: { url?: string }; sessionMismatch?: { reason?: string; liveTarget?: { url?: string } } };
				nextActions?: Array<{ id: string; params?: { electron?: { action?: string; launchId?: string } } }>;
			};
			assert.equal(statusDetails.electron?.managedSession?.url, "about:blank");
			assert.equal(statusDetails.electron?.sessionMismatch?.reason, "managed-session-about-blank-while-launch-target-live");
			assert.equal(statusDetails.electron?.sessionMismatch?.liveTarget?.url, "app://demo");
			assert.ok(statusDetails.nextActions?.some((action) => action.id === "probe-electron-launch" && action.params?.electron?.launchId === launchId));
			assert.ok(statusDetails.nextActions?.some((action) => action.id === "reattach-electron-launch"));
			const statusActionIds = statusDetails.nextActions?.map((action) => action.id) ?? [];
			assert.deepEqual(statusActionIds.slice(0, 3), ["status-electron-launch", "probe-electron-launch", "reattach-electron-launch"]);
			assert.ok(statusActionIds.indexOf("reattach-electron-launch") < statusActionIds.indexOf("snapshot-electron-session"));

			await rm(upstreamLogPath, { force: true });
			const currentProbeResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", timeoutMs: 1_000 } });
			assert.equal(currentProbeResult.isError, false);
			assert.match(currentProbeResult.content[0]?.text ?? "", /Probe context: current managed session .* maps to Electron launch/);
			assert.match(currentProbeResult.content[0]?.text ?? "", /Electron session mismatch: managed session .* is on about:blank, but launch .* still has live target Demo Electron/);
			const currentProbeDetails = currentProbeResult.details as {
				electron?: { probeContext?: { launchId?: string; mode?: string; sessionName?: string }; sessionMismatch?: { reason?: string } };
			};
			assert.equal(currentProbeDetails.electron?.probeContext?.mode, "current-managed-session");
			assert.equal(currentProbeDetails.electron?.probeContext?.launchId, launchId);
			assert.equal(currentProbeDetails.electron?.probeContext?.sessionName, sessionName);
			assert.equal(currentProbeDetails.electron?.sessionMismatch?.reason, "managed-session-about-blank-while-launch-target-live");

			await rm(upstreamLogPath, { force: true });
			const launchProbeResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", launchId, timeoutMs: 1_000 } });
			assert.equal(launchProbeResult.isError, false);
			assert.match(launchProbeResult.content[0]?.text ?? "", /Probe context: wrapper launch .* session/);
			const launchProbeDetails = launchProbeResult.details as {
				compiledElectron?: { action?: string; launchId?: string; timeoutMs?: number };
				electron?: { probeContext?: { launchId?: string; mode?: string; sessionName?: string } };
				usedImplicitSession?: boolean;
			};
			assert.deepEqual(launchProbeDetails.compiledElectron, { action: "probe", launchId, timeoutMs: 1_000 });
			assert.equal(launchProbeDetails.electron?.probeContext?.mode, "launchId");
			assert.equal(launchProbeDetails.electron?.probeContext?.sessionName, sessionName);
			assert.equal(launchProbeDetails.usedImplicitSession, false);
			const launchProbeInvocations = await readInvocationLog(upstreamLogPath);
			assert.equal(launchProbeInvocations.every((entry) => entry.args.includes("--session") && entry.args.includes(sessionName)), true);

			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId } });
			assert.equal(cleanupResult.isError, false);
			await assert.rejects(stat(launchDetails.electron.launch.userDataDir));
			assert.equal(await waitForTestPidExit(launchDetails.electron.launch.pid), true, "electron.cleanup should terminate the launched fake Electron process");
		});
	} finally {
		await stopTestPid(launchedPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension surfaces Electron post-command death and fill verification", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-post-command-health-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const statePath = join(tempDir, "agent-browser-state.json");
	const basePath = process.env.PATH ?? "";
	let launchedPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.HealthElectron", launchLogPath, name: "Health Electron" });
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(upstreamLogPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--profile", "--state", "--session-name", "--cdp", "--provider", "-p", "--device", "--user-agent"]);
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
const readState = () => {
	try { return JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch { return { blank: false }; }
};
const write = (data) => process.stdout.write(JSON.stringify({ success: true, data }));
const currentPage = () => readState().blank ? { title: "Blank Page", url: "about:blank" } : { title: "Demo Electron", url: "app://demo" };
const readLaunch = () => fs.readFileSync(${JSON.stringify(launchLogPath)}, "utf8").trim().split("\\n").map((line) => JSON.parse(line)).at(-1);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (command === "connect") write({ connected: true, endpoint: subcommand });
else if (command === "get" && subcommand === "title") write({ result: currentPage().title, title: currentPage().title });
else if (command === "get" && subcommand === "url") write({ result: currentPage().url, url: currentPage().url });
else if (command === "get" && subcommand === "value") write({ result: "" });
else if (command === "eval") write({ result: { focusedElement: { id: "name-input", role: "textbox", tagName: "input", valueLength: 0 } } });
else if (command === "tab" && subcommand === "list") write({ tabs: [{ active: true, index: 0, tabId: "page-1", title: currentPage().title, type: "page", url: currentPage().url }] });
else if (command === "snapshot") write({ origin: currentPage().url, title: currentPage().title, url: currentPage().url, refs: { e1: { role: "textbox", name: "File name" } }, snapshot: "- textbox \\\"File name\\\" [ref=e1]" });
else if (command === "fill") write({ filled: subcommand, title: "Demo Electron", url: "app://demo" });
else if (command === "click") {
	const launch = readLaunch();
	fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ blank: true }));
	try { process.kill(launch.pid, "SIGTERM"); } catch {}
	const deadline = Date.now() + 1000;
	const finish = () => {
		if (!pidAlive(launch.pid) || Date.now() > deadline) write({ clicked: subcommand, title: "Blank Page", url: "about:blank" });
		else setTimeout(finish, 25);
	};
	finish();
}
else if (command === "close") write({ closed: true });
else write({ ok: true, title: currentPage().title, url: currentPage().url });`,
		);
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } });
			assert.equal(launchResult.isError, false);
			const launch = (launchResult.details?.electron as { launch: { launchId: string; pid: number; sessionName: string; userDataDir: string } }).launch;
			launchedPid = launch.pid;

			const fillResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["fill", "@e1", "agent-browser-smoke.txt"] });
			assert.equal(fillResult.isError, false);
			assert.match(fillResult.content[0]?.text ?? "", /Fill verification warning: fill @e1 reported success/);
			assert.match(fillResult.content[0]?.text ?? "", /Electron ref freshness:/);
			const fillDetails = fillResult.details as {
				fillVerification?: { actual?: string; expected?: string; selector?: string; status?: string };
				electronRefFreshness?: { launchId?: string };
				nextActions?: Array<{ id: string; params?: { args?: string[] } }>;
			};
			assert.deepEqual(fillDetails.fillVerification, {
				actual: "",
				expected: "agent-browser-smoke.txt",
				nextActionIds: ["inspect-after-fill-verification", "verify-filled-value"],
				selector: "@e1",
				status: "mismatch",
				summary: "Fill verification warning: fill @e1 reported success, but get value returned an empty value.",
			});
			assert.equal(fillDetails.electronRefFreshness?.launchId, launch.launchId);
			assert.ok(fillDetails.nextActions?.some((action) => action.id === "inspect-after-fill-verification" && action.params?.args?.includes("snapshot")));
			assert.ok(fillDetails.nextActions?.some((action) => action.id === "refresh-electron-refs-after-rerender"));

			const clickResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(clickResult.isError, true);
			assert.equal(clickResult.details?.failureCategory, "tab-drift");
			assert.match(clickResult.content[0]?.text ?? "", /Electron lifecycle warning: click command completed, but launch .* is no longer healthy/);
			assert.match(clickResult.content[0]?.text ?? "", /debug port dead, pid dead/);
			const clickDetails = clickResult.details as {
				electronPostCommandHealth?: { launchId?: string; reason?: string; status?: { pidAlive?: boolean; portAlive?: boolean } };
				nextActions?: Array<{ id: string; params?: { electron?: { action?: string; launchId?: string } } }>;
			};
			assert.equal(clickDetails.electronPostCommandHealth?.launchId, launch.launchId);
			assert.equal(clickDetails.electronPostCommandHealth?.reason, "process-dead");
			assert.equal(clickDetails.electronPostCommandHealth?.status?.pidAlive, false);
			assert.equal(clickDetails.electronPostCommandHealth?.status?.portAlive, false);
			assert.ok(clickDetails.nextActions?.some((action) => action.id === "status-electron-launch" && action.params?.electron?.launchId === launch.launchId));
			assert.ok(clickDetails.nextActions?.some((action) => action.id === "cleanup-electron-launch" && action.params?.electron?.launchId === launch.launchId));

			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: launch.launchId } });
			assert.equal(cleanupResult.isError, false);
			await assert.rejects(stat(launch.userDataDir));
		});
	} finally {
		await stopTestPid(launchedPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension applies electron.probe timeoutMs to bounded subprocess probes", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-probe-timeout-"));
	const logPath = join(tempDir, "agent-browser.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
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
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, command }) + "\\n");
if (command === "connect") {
	process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
	return;
}
setTimeout(() => {
	process.stdout.write(JSON.stringify({ success: true, data: { result: "late" } }));
}, 200);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const connectResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["connect", "9222"] });
			assert.equal(connectResult.isError, false);
			const connectNextActions = connectResult.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined;
			const connectedSessionName = connectResult.details?.sessionName as string | undefined;
			assert.ok(connectedSessionName);
			assert.deepEqual(connectNextActions?.map((action) => action.id), ["list-connected-session-tabs"]);
			assert.deepEqual(connectNextActions?.map((action) => action.params?.args), [
				["--session", connectedSessionName, "tab", "list"],
			]);

			const probeResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", timeoutMs: 25 } });
			assert.equal(probeResult.isError, false);
			assert.deepEqual(probeResult.details?.compiledElectron, { action: "probe", timeoutMs: 25 });
			assert.equal((probeResult.details?.electron as { status?: string } | undefined)?.status, "partial");
			assert.match(probeResult.content[0]?.text ?? "", /Some probe commands did not return data/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension recommends tab recovery after No active page snapshot failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-no-active-page-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
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
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, command }) + "\\n");
const snapshotStatePath = ${JSON.stringify(join(tempDir, "snapshot-count.txt"))};
function nextSnapshotCount() {
  let count = 0;
  try { count = Number(fs.readFileSync(snapshotStatePath, "utf8")) || 0; } catch {}
  count += 1;
  fs.writeFileSync(snapshotStatePath, String(count));
  return count;
}
if (command === "connect") {
  process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
} else if (command === "snapshot") {
  const snapshotCount = nextSnapshotCount();
  if (snapshotCount === 1) {
    process.stdout.write(JSON.stringify({ success: true, data: {
      origin: "https://active.example/",
      refs: { e1: { role: "button", name: "Old action" } },
      snapshot: '- button "Old action" [ref=e1]'
    } }));
  } else if (snapshotCount === 2) {
    process.stdout.write(JSON.stringify({ success: false, error: "No active page" }));
    process.exit(1);
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: {
      origin: "https://active.example/",
      refs: { e2: { role: "button", name: "Fresh action" } },
      snapshot: '- button "Fresh action" [ref=e2]'
    } }));
  }
} else if (command === "click") {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const connectResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["connect", "9222"] });
			assert.equal(connectResult.isError, false);
			const sessionName = connectResult.details?.sessionName as string | undefined;
			assert.ok(sessionName);

			const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));
			assert.deepEqual((initialSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);
			assert.equal("order" in ((initialSnapshot.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const snapshotResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshotResult.isError, true);
			assert.equal(snapshotResult.details?.command, "snapshot");
			assert.equal(snapshotResult.details?.failureCategory, "upstream-error");
			assert.equal(snapshotResult.details?.refSnapshot, undefined);
			assert.equal((snapshotResult.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "no-active-page");
			assert.equal("order" in ((snapshotResult.details?.refSnapshotInvalidation as Record<string, unknown> | undefined) ?? {}), false);
			const nextActions = snapshotResult.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["list-tabs-after-no-active-page"]);
			assert.deepEqual(nextActions?.map((action) => action.params?.args), [
				["--session", sessionName, "tab", "list"],
			]);

			const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(staleClick.isError, true);
			assert.equal(staleClick.details?.failureCategory, "stale-ref");
			assert.deepEqual(staleClick.details?.refIds, ["e1"]);
			assert.equal((staleClick.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "no-active-page");
			assert.equal("order" in ((staleClick.details?.refSnapshotInvalidation as Record<string, unknown> | undefined) ?? {}), false);
			assert.match((staleClick.content[0] as { text: string }).text, /latest snapshot for this session reported No active page/);
			const staleNextActions = staleClick.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(staleNextActions?.map((action) => action.id), ["refresh-interactive-refs"]);
			assert.deepEqual(staleNextActions?.map((action) => action.params?.args), [
				["--session", sessionName, "snapshot", "-i"],
			]);

			const batchWithInlineSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["snapshot", "-i"], ["click", "@e1"]]),
			});
			assert.equal(batchWithInlineSnapshot.isError, true);
			assert.equal(batchWithInlineSnapshot.details?.failureCategory, "stale-ref");
			assert.deepEqual(batchWithInlineSnapshot.details?.refIds, ["e1"]);
			assert.match((batchWithInlineSnapshot.content[0] as { text: string }).text, /latest snapshot for this session reported No active page/);

			const freshSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(freshSnapshot.isError, false, JSON.stringify(freshSnapshot));
			assert.equal(freshSnapshot.details?.refSnapshotInvalidation, undefined);
			assert.deepEqual((freshSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e2"]);
			assert.equal("order" in ((freshSnapshot.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const freshClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e2"] });
			assert.equal(freshClick.isError, false, JSON.stringify(freshClick));
			assert.equal((freshClick.details?.data as { clicked?: string } | undefined)?.clicked, "@e2");

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(
				invocations
					.map((entry) => entry.args.find((token) => ["connect", "snapshot", "click"].includes(token)))
					.filter((command): command is string => command !== undefined),
				["connect", "snapshot", "snapshot", "snapshot", "click"],
			);
			assert.equal(invocations.filter((entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e2").length, 1);
			assert.equal(invocations.filter((entry) => entry.args.includes("@e1")).length, 0);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension invalidates refs after No active page snapshot failures inside batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-no-active-page-batch-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const valueFlags = new Set(["--session"]);
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
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, command, stdin }) + "\\n");
if (command === "connect") {
	process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
} else if (command === "snapshot") {
	process.stdout.write(JSON.stringify({ success: true, data: {
	origin: "https://active.example/",
	refs: { e1: { role: "button", name: "Old action" } },
	snapshot: '- button "Old action" [ref=e1]'
	} }));
} else if (command === "batch") {
	const steps = JSON.parse(stdin || "[]");
	process.stdout.write(JSON.stringify(steps.map((step) => {
		if (step[0] === "snapshot" && step.includes("--recover")) {
			return { command: step, success: true, result: {
				origin: "https://active.example/",
				refs: { e2: { role: "button", name: "Recovered action" } },
				snapshot: '- button "Recovered action" [ref=e2]'
			} };
		}
		return step[0] === "snapshot"
			? { command: step, success: false, error: "No active page" }
			: { command: step, success: true, result: { ok: true } };
	})));
	process.exit(1);
} else if (command === "click") {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const connectResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["connect", "9222"] });
			assert.equal(connectResult.isError, false);
			const sessionName = connectResult.details?.sessionName as string | undefined;
			assert.ok(sessionName);

			const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));
			assert.deepEqual((initialSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);
			assert.equal("order" in ((initialSnapshot.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const batchSnapshotFailure = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["snapshot", "-i"]]),
			});
			assert.equal(batchSnapshotFailure.isError, true, JSON.stringify(batchSnapshotFailure));
			assert.equal(batchSnapshotFailure.details?.refSnapshot, undefined);
			assert.equal((batchSnapshotFailure.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "no-active-page");
			assert.equal("order" in ((batchSnapshotFailure.details?.refSnapshotInvalidation as Record<string, unknown> | undefined) ?? {}), false);
			const nextActions = batchSnapshotFailure.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["list-tabs-after-no-active-page"]);
			assert.deepEqual(nextActions?.map((action) => action.params?.args), [
				["--session", sessionName, "tab", "list"],
			]);

			const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(staleClick.isError, true);
			assert.equal(staleClick.details?.failureCategory, "stale-ref");
			assert.deepEqual(staleClick.details?.refIds, ["e1"]);
			assert.equal((staleClick.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "no-active-page");
			assert.equal("order" in ((staleClick.details?.refSnapshotInvalidation as Record<string, unknown> | undefined) ?? {}), false);

			const batchSnapshotRecovery = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["snapshot", "-i"], ["snapshot", "-i", "--recover"]]),
			});
			assert.equal(batchSnapshotRecovery.isError, true, JSON.stringify(batchSnapshotRecovery));
			assert.equal(batchSnapshotRecovery.details?.refSnapshotInvalidation, undefined);
			assert.deepEqual((batchSnapshotRecovery.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e2"]);
			assert.equal("order" in ((batchSnapshotRecovery.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const recoveredClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e2"] });
			assert.equal(recoveredClick.isError, false, JSON.stringify(recoveredClick));
			assert.equal((recoveredClick.details?.data as { clicked?: string } | undefined)?.clicked, "@e2");

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(
				invocations
					.map((entry) => entry.args.find((token) => ["connect", "snapshot", "batch", "click"].includes(token)))
					.filter((command): command is string => command !== undefined),
				["connect", "snapshot", "batch", "batch", "click"],
			);
			assert.equal(invocations.filter((entry) => entry.args.includes("@e1")).length, 0);
			assert.equal(invocations.filter((entry) => entry.args.includes("@e2")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension supports Electron launch handoff modes", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-handoff-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.HandoffElectron", launchLogPath, name: "Handoff Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			for (const [handoff, expectedCommands] of [["connect", ["connect"]], ["tabs", ["connect", "tab"]]] as const) {
				await rm(upstreamLogPath, { force: true });
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath, handoff } });
				assert.equal(result.isError, false, handoff);
				assert.match(result.content[0]?.text ?? "", handoff === "tabs" ? /safer diagnostic starting point; no interactive refs were captured/ : /Connect handoff completed: run snapshot -i before using interactive refs/);
				const commands = (await readInvocationLog(upstreamLogPath)).map((entry) => entry.args.find((token) => ["connect", "tab", "snapshot"].includes(token))).filter(Boolean);
				assert.deepEqual(commands, expectedCommands, handoff);
				const launchId = ((result.details?.electron as { launch?: { launchId: string } } | undefined)?.launch?.launchId);
				assert.ok(launchId);
				await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId } });
			}
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension targets Electron webviews and keeps host cleanup after close failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-webview-close-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.WebviewElectron", includeWebview: true, launchLogPath, name: "Webview Electron" });
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(upstreamLogPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session"]);
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
if (command === "close") {
	process.stdout.write(JSON.stringify({ success: false, error: "close boom" }));
	process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));`,
		);
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath, handoff: "connect", targetType: "webview" } });
			assert.equal(launchResult.isError, false);
			const launchDetails = launchResult.details as { effectiveArgs: string[]; electron: { launch: { launchId: string; pid: number; userDataDir: string } } };
			assert.match(launchDetails.effectiveArgs.at(-1) ?? "", /\/devtools\/page\/webview-1$/);

			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: launchDetails.electron.launch.launchId, timeoutMs: 1_000 } });
			assert.equal(cleanupResult.isError, true);
			assert.equal(cleanupResult.details?.failureCategory, "cleanup-failed");
			assert.match(cleanupResult.content[0]?.text ?? "", /managed-session: failed/);
			await assert.rejects(stat(launchDetails.electron.launch.userDataDir));
			assert.equal(isTestPidAlive(launchDetails.electron.launch.pid), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks Electron launch by caller policy without spawning", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-policy-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.PolicyElectron", launchLogPath, name: "Policy Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "launch", appPath: app.appPath, deny: ["Policy Electron"] },
			});
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "policy-blocked");
			assert.match(result.content[0]?.text ?? "", /deny policy: Policy Electron/);
			assert.deepEqual(await readInvocationLog(upstreamLogPath), []);
			await assert.rejects(readFile(launchLogPath, "utf8"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension cleans Electron resources when launch fails before upstream attach", { concurrency: false }, async () => {
	for (const { expectedCategory, mode, timeoutMs, writeLaunchLog } of [
		{ expectedCategory: "timeout", mode: "no-port-file", timeoutMs: 500, writeLaunchLog: false },
		{ expectedCategory: "upstream-error", mode: "invalid-cdp", timeoutMs: 1_500, writeLaunchLog: true },
	] as const) {
		const tempDir = await mkdtemp(join(tmpdir(), `pi-agent-browser-electron-failed-${mode}-`));
		const applicationsDir = join(tempDir, "Applications");
		const launchLogPath = join(tempDir, "electron-launch.log");
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: `com.example.${mode}`, launchLogPath, mode, name: `Failed ${mode}`, writeLaunchLog });
			await withPatchedEnv({ PATH: dirname(process.execPath) }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "launch", appPath: app.appPath, timeoutMs },
				});
				assert.equal(result.isError, true, mode);
				assert.equal(result.details?.failureCategory, expectedCategory, mode);
				assert.match(result.content[0]?.text ?? "", /Electron launch diagnostics:/, mode);
				assert.match(result.content[0]?.text ?? "", /Retry guidance: increase electron\.timeoutMs/, mode);
				const diagnostics = ((result.details?.electron as { failure?: { diagnostics?: { cdpVersionReached?: boolean; devToolsActivePort?: { found?: boolean; port?: number }; pid?: number; pidAlive?: boolean; timeoutMs?: number; userDataDir?: string } } } | undefined)?.failure?.diagnostics);
				const diagnosticPid = diagnostics?.pid;
				const diagnosticUserDataDir = diagnostics?.userDataDir;
				assert.ok(typeof diagnosticPid === "number", mode);
				assert.equal(diagnostics?.pidAlive, true, mode);
				assert.equal(diagnostics?.timeoutMs, timeoutMs, mode);
				assert.ok(typeof diagnosticUserDataDir === "string", mode);
				const launchLogs = await readOptionalFakeElectronLaunchLog(launchLogPath);
				const launchLog = launchLogs.find((entry) => entry.pid === diagnosticPid);
				if (mode === "no-port-file") {
					assert.equal(launchLogs.length, 0, mode);
					assert.equal(diagnostics?.devToolsActivePort?.found, false, mode);
					assert.match(result.content[0]?.text ?? "", /DevToolsActivePort: missing/, mode);
				} else {
					assert.ok(launchLog, mode);
					assert.equal(diagnostics?.userDataDir, launchLog.userDataDir, mode);
					assert.equal(diagnostics?.devToolsActivePort?.found, true, mode);
					assert.equal(diagnostics?.devToolsActivePort?.port, launchLog.port, mode);
					assert.equal(diagnostics?.cdpVersionReached, false, mode);
					assert.match(result.content[0]?.text ?? "", /CDP \/json\/version: did not return a valid payload/, mode);
				}
				await assert.rejects(stat(diagnosticUserDataDir));
				assert.equal(isTestPidAlive(diagnosticPid), false, mode);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	}
});

test("agentBrowserExtension cleans Electron resources when upstream connect cannot spawn", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-missing-upstream-"));
	const applicationsDir = join(tempDir, "Applications");
	const emptyBinDir = join(tempDir, "empty-bin");
	const nodeOnlyBinDir = join(tempDir, "node-only-bin");
	const launchLogPath = join(tempDir, "electron-launch.log");
	try {
		await mkdir(applicationsDir, { recursive: true });
		await mkdir(emptyBinDir, { recursive: true });
		await mkdir(nodeOnlyBinDir, { recursive: true });
		await symlink(process.execPath, join(nodeOnlyBinDir, "node"), "file");
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.MissingUpstreamElectron", launchLogPath, name: "Missing Upstream Electron" });
		// Put a `node` shim on PATH so the fake Electron `#!/usr/bin/env node` launcher can start, but keep
		// `agent-browser` off PATH so upstream `connect` fails with ENOENT (missing-binary) instead of picking up
		// a real binary from the Node install directory.
		const pathSeparator = process.platform === "win32" ? ";" : ":";
		const isolatedPath = `${nodeOnlyBinDir}${pathSeparator}${emptyBinDir}`;
		await withPatchedEnv({ PATH: isolatedPath }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } });
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "missing-binary");
			assert.match(result.content[0]?.text ?? "", /Electron cleanup after failed attach/);
			const [launchLog] = (await readFile(launchLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number; userDataDir: string });
			assert.ok(launchLog);
			await assert.rejects(stat(launchLog.userDataDir));
			assert.equal(isTestPidAlive(launchLog.pid), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps restored Electron profile when process ownership is unverified", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const userDataDir = await createSecureTempDirectory("electron-profile-");
	try {
		const cleanupResult = await cleanupElectronLaunchResources({
			record: {
				appName: "Unverified Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-unverified-test",
				launchedByWrapper: true,
				pid: process.pid,
				port: 9,
				userDataDir,
				version: 1,
			},
			timeoutMs: 50,
		});
		assert.equal(cleanupResult.partial, true);
		assert.equal(cleanupResult.steps.find((step) => step.resource === "process")?.state, "failed");
		assert.equal(cleanupResult.steps.find((step) => step.resource === "user-data-dir")?.state, "skipped");
		assert.deepEqual(cleanupResult.remainingResources.sort(), ["process", "user-data-dir"]);
		await stat(userDataDir);
	} finally {
		await cleanupSecureTempArtifacts();
	}
});


test("agentBrowserExtension restores Electron launch records and cleans them on shutdown", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-restore-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	let launchedPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.RestoreElectron", launchLogPath, name: "Restore Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const firstHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);
			const launchResult = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, { electron: { action: "launch", appPath: app.appPath, handoff: "connect" } });
			assert.equal(launchResult.isError, false);
			const launch = (launchResult.details?.electron as { launch: { launchId: string; pid: number; userDataDir: string } }).launch;
			launchedPid = launch.pid;

			const restoredHarness = createExtensionHarness({ cwd: tempDir, branch: [createToolBranchEntry({ details: launchResult.details as Record<string, unknown> })] });
			await runExtensionEvent(restoredHarness.handlers, "session_start", { reason: "resume" }, restoredHarness.ctx);
			const statusResult = await executeRegisteredTool(restoredHarness.tool, restoredHarness.ctx, { electron: { action: "status", launchId: launch.launchId as string } });
			assert.equal(statusResult.isError, false);
			assert.match(statusResult.content[0]?.text ?? "", /debug port alive/);

			await runExtensionEvent(restoredHarness.handlers, "session_shutdown", { reason: "reload" }, restoredHarness.ctx);
			await assert.rejects(stat(launch.userDataDir));
			assert.equal(await waitForTestPidExit(launch.pid), true, "restored shutdown cleanup should terminate the wrapper-owned Electron process");
		});
	} finally {
		await stopTestPid(launchedPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects electron mixed with other input modes and caller stdin", async () => {
	const harness = createExtensionHarness({ cwd: process.cwd() });
	const conflicts: Array<{ label: string; params: AgentBrowserToolParams }> = [
		{ label: "args", params: { args: ["open", "https://example.test/"], electron: { action: "list" } } },
		{ label: "semanticAction", params: { semanticAction: { action: "click", locator: "text", value: "Export" }, electron: { action: "list" } } },
		{ label: "job", params: { job: { steps: [{ action: "open", url: "https://example.test/" }] }, electron: { action: "list" } } },
		{ label: "qa", params: { qa: { url: "https://example.test/" }, electron: { action: "list" } } },
		{ label: "sourceLookup", params: { sourceLookup: { componentName: "Panel" }, electron: { action: "list" } } },
		{ label: "networkSourceLookup", params: { networkSourceLookup: { url: "/api" }, electron: { action: "list" } } },
	];
	for (const conflict of conflicts) {
		const result = await executeRegisteredTool(harness.tool, harness.ctx, conflict.params);
		assert.equal(result.isError, true, conflict.label);
		assert.match(result.content[0]?.text ?? "", /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);
		assert.equal(result.details?.failureCategory, "validation-error");
	}

	const stdinResult = await executeRegisteredTool(harness.tool, harness.ctx, {
		electron: { action: "list" },
		stdin: "[]",
	});
	assert.equal(stdinResult.isError, true);
	assert.match(stdinResult.content[0]?.text ?? "", /Do not provide stdin with electron; electron mode is host-only or manages its own input\./);
	assert.doesNotMatch(stdinResult.content[0]?.text ?? "", /job, qa, sourceLookup, or networkSourceLookup/);
	assert.equal(stdinResult.details?.failureCategory, "validation-error");
});

test("electron discovery finds macOS Electron app bundles with query filtering", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-macos-"));
	try {
		const applicationsDir = join(tempDir, "Applications");
		await mkdir(applicationsDir, { recursive: true });
		const alpha = await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.example.Alpha", executableName: "AlphaBin", name: "Alpha App" });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.example.Beta", executableName: "BetaBin", name: "Beta App" });
		const nonElectronPath = join(applicationsDir, "Plain App.app");
		await mkdir(join(nonElectronPath, "Contents", "Resources"), { recursive: true });
		await writeFile(join(nonElectronPath, "Contents", "Resources", "app.asar"), "asar", "utf8");

		const all = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
		});
		assert.deepEqual(electronAppNames(all.apps), ["Alpha App", "Beta App"]);
		assert.equal(all.omittedCount, 0);
		assert.equal(all.apps.find((app) => app.name === "Alpha App")?.bundleId, "com.example.Alpha");
		assert.equal(all.apps.find((app) => app.name === "Alpha App")?.appPath, alpha.appPath);
		assert.equal(all.apps.find((app) => app.name === "Alpha App")?.executablePath, alpha.executablePath);
		assert.equal(all.apps.every((app) => app.platform === "darwin"), true);

		const byName = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
			query: "beta",
		});
		assert.deepEqual(electronAppNames(byName.apps), ["Beta App"]);
		const byBundleId = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
			query: "com.example.alpha",
		});
		assert.deepEqual(electronAppNames(byBundleId.apps), ["Alpha App"]);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("electron discovery annotates likely sensitive apps without blocking discovery", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-sensitive-"));
	try {
		const applicationsDir = join(tempDir, "Applications");
		await mkdir(applicationsDir, { recursive: true });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "md.obsidian", executableName: "Obsidian", name: "Obsidian" });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.tinyspeck.slackmacgap", executableName: "Slack", name: "Slack" });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.microsoft.VSCode", executableName: "Code", name: "Visual Studio Code" });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.example.Plain", executableName: "Plain", name: "Plain Electron" });

		const result = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
		});

		assert.equal(result.apps.length, 4);
		const byName = new Map(result.apps.map((app) => [app.name, app]));
		assert.deepEqual(byName.get("Obsidian")?.sensitivity, {
			categories: ["notes"],
			level: "likely-sensitive",
			reason: "App name, bundle id, desktop id, or path matched common private-data app patterns; discovery still does not enforce policy.",
		});
		assert.deepEqual(byName.get("Slack")?.sensitivity?.categories, ["chat"]);
		assert.deepEqual(byName.get("Visual Studio Code")?.sensitivity?.categories, ["developer-workspace"]);
		assert.equal(byName.get("Plain Electron")?.sensitivity, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("electron discovery scans Linux desktop files and applies Electron evidence gates", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-linux-"));
	try {
		const desktopDir = join(tempDir, "applications");
		const appRoot = join(tempDir, "opt");
		await mkdir(desktopDir, { recursive: true });
		const electronExecutable = await writeFakeLinuxElectronBinary(appRoot, "demo-electron");
		const realElectronExecutable = await realpath(electronExecutable);
		const plainExecutable = join(appRoot, "plain", "plain");
		await mkdir(dirname(plainExecutable), { recursive: true });
		await writeFile(plainExecutable, "#!/bin/sh\n", "utf8");
		await chmod(plainExecutable, 0o755);

		await writeFile(join(desktopDir, "demo.desktop"), `[Desktop Entry]
Type=Application
Name=Demo Electron
Comment=Demo comment
Exec=${electronExecutable} %U --ignored-field-code %F
Icon=demo-icon
`, "utf8");
		await writeFile(join(desktopDir, "plain.desktop"), `[Desktop Entry]
Type=Application
Name=Plain Binary
Exec=${plainExecutable} %U
`, "utf8");
		await writeFile(join(desktopDir, "hidden.desktop"), `[Desktop Entry]
Type=Application
Name=Hidden Electron
Hidden=true
Exec=${electronExecutable}
`, "utf8");
		await writeFile(join(desktopDir, "nodisplay.desktop"), `[Desktop Entry]
Type=Application
Name=No Display Electron
NoDisplay=true
Exec=${electronExecutable}
`, "utf8");
		await writeFile(join(desktopDir, "link.desktop"), `[Desktop Entry]
Type=Link
Name=Link Electron
Exec=${electronExecutable}
`, "utf8");

		const result = await discoverElectronApps({
			locations: { linuxDesktopDirectories: [desktopDir], pathEnv: "" },
			platform: "linux",
		});
		assert.deepEqual(electronAppNames(result.apps), ["Demo Electron"]);
		const app = result.apps[0];
		assert.equal(app?.platform, "linux");
		assert.equal(app?.executablePath, realElectronExecutable);
		assert.equal(app?.comment, "Demo comment");
		assert.equal(app?.icon, "demo-icon");
		assert.equal(app?.desktopId, "demo");
		assert.equal(app?.packageSource, "desktop");

		const binDir = join(tempDir, "bin");
		await mkdir(binDir, { recursive: true });
		const symlinkPath = join(binDir, "demo-link");
		await symlink(electronExecutable, symlinkPath);
		await writeFile(join(desktopDir, "symlink.desktop"), `[Desktop Entry]
Type=Application
Name=Symlink Electron
Exec=${symlinkPath}
`, "utf8");
		const symlinkResult = await discoverElectronApps({
			locations: { linuxDesktopDirectories: [desktopDir], pathEnv: "" },
			platform: "linux",
			query: "symlink",
		});
		assert.deepEqual(electronAppNames(symlinkResult.apps), ["Symlink Electron"]);
		assert.equal(symlinkResult.apps[0]?.executablePath, realElectronExecutable);

		const flatpakUserAppDirectory = join(tempDir, "flatpak", "app");
		const flatpakExecutable = await writeFakeLinuxElectronBinary(join(flatpakUserAppDirectory, "com.example.Flat", "current", "active", "files"), "flat-electron");
		const realFlatpakExecutable = await realpath(flatpakExecutable);
		await writeFile(join(desktopDir, "com.example.Flat.desktop"), `[Desktop Entry]
Type=Application
Name=Flatpak Electron
Exec=/usr/bin/flatpak run com.example.Flat
`, "utf8");
		const flatpakResult = await discoverElectronApps({
			locations: { flatpakUserAppDirectory, linuxDesktopDirectories: [desktopDir], pathEnv: "" },
			platform: "linux",
			query: "flatpak",
		});
		assert.deepEqual(electronAppNames(flatpakResult.apps), ["Flatpak Electron"]);
		assert.equal(flatpakResult.apps[0]?.executablePath, realFlatpakExecutable);
		assert.equal(flatpakResult.apps[0]?.packageSource, "flatpak");
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("electron discovery caps results, clamps maxResults, and reports omittedCount", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-cap-"));
	try {
		const applicationsDir = join(tempDir, "Applications");
		await mkdir(applicationsDir, { recursive: true });
		for (let index = 0; index < ELECTRON_DISCOVERY_MAX_RESULTS + 2; index += 1) {
			const suffix = String(index).padStart(3, "0");
			await writeFakeMacElectronApp({ applicationsDir, bundleId: `com.example.Cap${suffix}`, executableName: `Cap${suffix}`, name: `Cap App ${suffix}` });
		}

		const clamped = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			maxResults: ELECTRON_DISCOVERY_MAX_RESULTS + 1_000,
			platform: "darwin",
		});
		assert.equal(clamped.maxResults, ELECTRON_DISCOVERY_MAX_RESULTS);
		assert.equal(clamped.apps.length, ELECTRON_DISCOVERY_MAX_RESULTS);
		assert.equal(clamped.omittedCount, 2);

		const smallCap = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			maxResults: 3,
			platform: "darwin",
		});
		assert.equal(smallCap.apps.length, 3);
		assert.equal(smallCap.omittedCount, ELECTRON_DISCOVERY_MAX_RESULTS - 1);
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

			const roleOnlyClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", role: "button", name: "Continue without Signing In" },
			});
			assert.equal(roleOnlyClickResult.isError, false);
			assert.deepEqual(roleOnlyClickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "role",
				args: ["find", "role", "button", "click", "--name", "Continue without Signing In"],
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

			const selectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", selector: "#flavor-select", value: "chocolate", session: "named" },
			});
			assert.equal(selectResult.isError, false);
			assert.deepEqual(selectResult.details?.compiledSemanticAction, {
				action: "select",
				selector: "#flavor-select",
				values: ["chocolate"],
				args: ["--session", "named", "select", "#flavor-select", "chocolate"],
			});
			assert.equal(selectResult.details?.sessionName, "named");

			const invocationLog = await readInvocationLog(logPath);
			const invocations = invocationLog.filter((entry) => entry.args.includes("find"));
			assert.deepEqual(invocations[0]?.args.slice(-6), ["find", "role", "button", "click", "--name", "Export"]);
			assert.deepEqual(invocations[1]?.args.slice(-6), ["find", "role", "button", "click", "--name", "Continue without Signing In"]);
			assert.deepEqual(invocations[2]?.args.slice(-5), ["find", "label", "Email", "fill", "user@example.test"]);
			assert.deepEqual(invocations[3]?.args.slice(-4), ["find", "text", "Close", "click"]);
			assert.deepEqual(invocations[4]?.args.slice(-6), ["--session", "named", "find", "text", "Close", "click"]);
			const selectInvocation = invocationLog.find((entry) => entry.args.includes("select"));
			assert.deepEqual(selectInvocation?.args.slice(-5), ["--session", "named", "select", "#flavor-select", "chocolate"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension resolves semantic role clicks through current visible snapshot refs when available", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-visible-ref-"));
	const logPath = join(tempDir, "invocations.log");
	const snapshotCountPath = join(tempDir, "snapshot-count.txt");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Docs", url: "https://docs.example.test/" } }));
} else if (args.includes("snapshot")) {
  const statePath = ${JSON.stringify(snapshotCountPath)};
  const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
  fs.writeFileSync(statePath, String(count + 1));
  const refs = count === 0
    ? { e2: { role: "button", name: "Old Search Documentation" } }
    : { e17: { role: "button", name: "Search Documentation ⌘ K" } };
  const snapshot = count === 0
    ? '- button "Old Search Documentation" [ref=e2]'
    : '- button "Search Documentation ⌘ K" [ref=e17]';
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://docs.example.test/",
    refs,
    snapshot
  } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e17" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Docs" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://docs.example.test/" } }));
} else if (args.includes("find")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "[data-agent-browser-located='true']" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://docs.example.test/"] });
			assert.equal(open.isError, false);
			const oldSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(oldSnapshot.isError, false);
			assert.deepEqual((oldSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e2"]);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", value: "button", name: "Search Documentation" },
			});
			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.compiledSemanticAction, {
				action: "click",
				locator: "role",
				args: ["find", "role", "button", "click", "--name", "Search Documentation"],
			});
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-2), ["click", "@e17"]);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("snapshot")));
			assert.ok(invocations.some((entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e17"));
			assert.equal(invocations.some((entry) => entry.args.includes("find")), false);
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
						{ action: "select", selector: "#theme", values: ["dark", "compact"] },
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
				["select", "#theme", "dark", "compact"],
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
			assert.deepEqual(upstreamSteps.slice(0, 8), compiledJob?.steps?.slice(0, 8).map((step) => step.args));
			assert.equal(upstreamSteps[8]?.[0], "screenshot");
			assert.match(upstreamSteps[8]?.[1] ?? "", /job\.png$/);
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
    if (name === "open") {
      const url = String(command[1] || "");
      mode = url.includes("fail") ? "fail" : url.includes("favicon") ? "favicon" : "clean";
      return { command, success: true, result: { title: "QA Page", url } };
    }
    if (name === "network") {
      if (command.includes("--clear")) { staleNetwork = false; return { command, success: true, result: { requests: [] } }; }
      if (staleNetwork || mode === "fail") return { command, success: true, result: { requests: [{ method: "GET", resourceType: "fetch", status: 500, url: "https://example.test/api" }] } };
      if (mode === "favicon") return { command, success: true, result: { requests: [{ method: "GET", mimeType: "image/x-icon", status: 404, url: "https://example.test/favicon.ico" }] } };
      return { command, success: true, result: { requests: [] } };
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
			assert.equal(Check(harness.tool.parameters, { qa: { attached: true, expectedText: "Welcome" } }), true);
			assert.equal(Check(harness.tool.parameters, { qa: { attached: true, url: "https://example.test/" } }), false);
			assert.equal(Check(harness.tool.parameters, { qa: { expectedText: "Welcome" } }), false);
			const attachedWithoutSession = await executeRegisteredTool(harness.tool, harness.ctx, { qa: { attached: true, expectedText: "Welcome" } });
			assert.equal(attachedWithoutSession.isError, true);
			assert.match(attachedWithoutSession.content[0]?.text ?? "", /qa\.attached requires an active attached session/);
			assert.equal(attachedWithoutSession.details?.failureCategory, "validation-error");

			const cleanResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://example.test/",
					expectedText: ["Welcome"],
				},
			});
			assert.equal(cleanResult.isError, false);
			assert.deepEqual((cleanResult.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, []);

			const benignNetworkResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://favicon.example.test/",
					expectedText: ["Welcome"],
				},
			});
			assert.equal(benignNetworkResult.isError, false);
			assert.deepEqual((benignNetworkResult.details?.qaPreset as { failedChecks?: string[]; warnings?: string[] } | undefined)?.failedChecks, []);
			assert.deepEqual((benignNetworkResult.details?.qaPreset as { warnings?: string[] } | undefined)?.warnings, ["1 benign network request failure(s) ignored"]);
			assert.match((benignNetworkResult.content[0] as { text: string }).text, /QA preset passed with warnings: 1 benign network request failure\(s\) ignored\./);
			assert.match((benignNetworkResult.content[0] as { text: string }).text, /Network failure summary: 0 actionable, 1 benign low-impact \(1 total\)\./);
			assert.match((benignNetworkResult.content[0] as { text: string }).text, /404 GET https:\/\/example.test\/favicon.ico \(image\/x-icon\).*\[benign: low-impact browser icon asset\]/);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://fail.example.test/",
					expectedText: ["Welcome"],
					expectedSelector: "main",
					screenshotPath: "qa.png",
				},
				sessionMode: "fresh",
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "qa-failure");
			const [realPiFailurePatch] = await runExtensionEventResults<{ content?: Array<{ text?: string; type: string }>; isError?: boolean }>(
				harness.handlers,
				"tool_result",
				{ content: result.content, details: result.details, isError: false, toolName: "agent_browser" },
			);
			assert.equal(realPiFailurePatch?.isError, true);
			assert.match(realPiFailurePatch?.content?.[0]?.text ?? "", /Result category: failure; failureCategory: qa-failure; Pi tool isError: true\./);

			const jsonFailureText = JSON.stringify({ error: "boom", success: false }, null, 2);
			const [jsonFailurePatch] = await runExtensionEventResults<{ content?: Array<{ text?: string; type: string }>; isError?: boolean }>(
				harness.handlers,
				"tool_result",
				{
					content: [{ type: "text", text: jsonFailureText }],
					details: { args: ["--json", "get", "url"], failureCategory: "upstream-error", resultCategory: "failure" },
					input: { args: ["--json", "get", "url"] },
					isError: false,
					toolName: "agent_browser",
				},
			);
			assert.equal(jsonFailurePatch?.isError, true);
			assert.equal(jsonFailurePatch?.content, undefined);
			assert.deepEqual(JSON.parse(jsonFailureText), { error: "boom", success: false });

			const [proseJsonArgsFailurePatch] = await runExtensionEventResults<{ content?: Array<{ text?: string; type: string }>; isError?: boolean }>(
				harness.handlers,
				"tool_result",
				{
					content: [{ type: "text", text: "Wrapper validation failed before upstream JSON output was available." }],
					details: { args: ["--json", "get", "url"], failureCategory: "validation-error", resultCategory: "failure" },
					input: { args: ["--json", "get", "url"] },
					isError: false,
					toolName: "agent_browser",
				},
			);
			assert.equal(proseJsonArgsFailurePatch?.isError, true);
			assert.match(proseJsonArgsFailurePatch?.content?.[0]?.text ?? "", /Result category: failure; failureCategory: validation-error; Pi tool isError: true\./);

			const managedSessionOutcome = result.details?.managedSessionOutcome as { sessionMode?: string; status?: string; succeeded?: boolean } | undefined;
			assert.equal(managedSessionOutcome?.sessionMode, "fresh");
			assert.equal(managedSessionOutcome?.status, "replaced");
			assert.equal(managedSessionOutcome?.succeeded, false);
			assert.match((result.content[0] as { text: string }).text, /Managed session outcome: Managed session .* was replaced by .*/);
			assert.deepEqual((result.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, [
				"1 actionable failed network request(s)",
				"1 console error message(s)",
				"1 page error(s)",
			]);
			const compiledQaPreset = result.details?.compiledQaPreset as { steps?: Array<{ args: string[] }> } | undefined;
			assert.deepEqual(compiledQaPreset?.steps?.map((step) => step.args), [
				["network", "requests", "--clear"],
				["console", "--clear"],
				["errors", "--clear"],
				["open", "https://fail.example.test/"],
				["wait", "--load", "domcontentloaded"],
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
			assert.deepEqual(invocations[2]?.args.slice(-1), ["batch"]);

			const attachedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					attached: true,
					expectedText: "Welcome",
					expectedSelector: "main",
				},
			});
			assert.equal(attachedResult.isError, false);
			assert.match((attachedResult.content[0] as { text: string }).text, /QA attached target: .* — QA Page — https:\/\/fail\.example\.test\//);
			assert.equal((attachedResult.details?.qaAttachedTarget as { title?: string; url?: string } | undefined)?.title, "QA Page");
			assert.equal((attachedResult.details?.qaAttachedTarget as { title?: string; url?: string } | undefined)?.url, "https://fail.example.test/");
			const attachedCompiledQaPreset = attachedResult.details?.compiledQaPreset as { checks?: { attached?: boolean; url?: string }; steps?: Array<{ args: string[] }> } | undefined;
			assert.equal(attachedCompiledQaPreset?.checks?.attached, true);
			assert.equal(attachedCompiledQaPreset?.checks?.url, undefined);
			assert.deepEqual(attachedCompiledQaPreset?.steps?.map((step) => step.args), [
				["network", "requests", "--clear"],
				["console", "--clear"],
				["errors", "--clear"],
				["wait", "--load", "domcontentloaded"],
				["wait", "--text", "Welcome"],
				["wait", "main"],
				["network", "requests"],
				["console"],
				["errors"],
			]);
			const attachedInvocation = [...await readInvocationLog(logPath)].reverse().find((entry) => entry.args.at(-1) === "batch" && entry.stdin?.trim().startsWith("["));
			assert.ok(attachedInvocation);
			const attachedSteps = JSON.parse(attachedInvocation.stdin ?? "[]") as string[][];
			assert.equal(attachedSteps.some((step) => step[0] === "open"), false);

			const attachedFreshResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: { attached: true, expectedText: "Welcome" },
				sessionMode: "fresh",
			});
			assert.equal(attachedFreshResult.isError, true);
			assert.match(attachedFreshResult.content[0]?.text ?? "", /qa\.attached cannot be used with sessionMode=fresh/);
			assert.equal(attachedFreshResult.details?.failureCategory, "validation-error");

			const attachedWithUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: { attached: true, url: "https://example.test/" },
			});
			assert.equal(attachedWithUrl.isError, true);
			assert.match(attachedWithUrl.content[0]?.text ?? "", /qa\.url must be omitted when qa\.attached is true/);
			assert.equal(attachedWithUrl.details?.failureCategory, "validation-error");
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

test("agentBrowserExtension explains packaged Electron sourceLookup no-candidate boundaries", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-source-lookup-electron-"));
	const applicationsDir = join(tempDir, "Applications");
	const logPath = join(tempDir, "invocations.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.PackagedElectron", launchLogPath, name: "Packaged Electron" });
		await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
	fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
	const valueFlags = new Set(["--session"]);
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
	if (command === "connect") {
	process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
	return;
	}
	if (command === "tab" && subcommand === "list") {
	process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ active: true, title: "Packaged Electron", type: "page", url: "app://packaged" }] } }));
	return;
	}
	if (command === "snapshot") {
	process.stdout.write(JSON.stringify({ success: true, data: { origin: "app://packaged", title: "Packaged Electron", url: "app://packaged", refs: { e1: { role: "button", name: "Save" } }, snapshot: "- button \\\"Save\\\" [ref=e1]" } }));
	return;
	}
	if (command === "batch") {
	const steps = JSON.parse(stdin || "[]");
	const results = steps.map((step) => ({ command: step, success: true, result: step[0] === "get" && step[1] === "html" ? "<button>Save</button>" : { ok: true } }));
	process.stdout.write(JSON.stringify(results));
	return;
	}
	if (command === "close") {
	process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
	return;
	}
	process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`);

		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } });
			assert.equal(launchResult.isError, false);
			const launch = (launchResult.details?.electron as { launch: { appPath?: string; executablePath?: string; launchId: string; sessionName: string; userDataDir: string } }).launch;

			const lookupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: { componentName: "MissingPackagedComponent", selector: "#save" },
			});
			assert.equal(lookupResult.isError, false);
			assert.match(lookupResult.content[0]?.text ?? "", /Source lookup found no candidate locations/);
			assert.match(lookupResult.content[0]?.text ?? "", /workspace scan was limited/);
			assert.match(lookupResult.content[0]?.text ?? "", /packaged Electron app code may live outside/);
			const sourceLookup = lookupResult.details?.sourceLookup as {
				electronContext?: { appName?: string; appPath?: string; executablePath?: string; launchId?: string; sessionName?: string; url?: string };
				limitations?: string[];
				status?: string;
				workspaceRoot?: string;
			} | undefined;
			assert.equal(sourceLookup?.status, "no-candidates");
			assert.equal(sourceLookup?.workspaceRoot, tempDir);
			assert.deepEqual(sourceLookup?.electronContext, {
				appName: "Packaged Electron",
				appPath: launch.appPath,
				executablePath: launch.executablePath,
				launchId: launch.launchId,
				sessionName: launch.sessionName,
				url: "app://packaged",
			});
			assert.ok(sourceLookup?.limitations?.some((item) => item.includes("Pi tool session cwd")));
			assert.ok(sourceLookup?.limitations?.some((item) => item.includes("app.asar")));
			const nextActions = lookupResult.details?.nextActions as Array<{ id: string; params?: { args?: string[]; electron?: { action?: string; launchId?: string } } }> | undefined;
			const actionIds = new Set(nextActions?.map((action) => action.id));
			assert.equal(actionIds.has("snapshot-electron-session"), true);
			assert.equal(actionIds.has("probe-electron-launch"), true);
			assert.equal(actionIds.has("list-electron-tabs"), true);
			assert.ok(nextActions?.some((action) => action.id === "probe-electron-launch" && action.params?.electron?.launchId === launch.launchId));
			assert.ok(nextActions?.some((action) => action.id === "snapshot-electron-session" && action.params?.args?.includes(launch.sessionName)));

			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: launch.launchId } });
			assert.equal(cleanupResult.isError, false);
			await assert.rejects(stat(launch.userDataDir));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not add packaged Electron sourceLookup guidance for plain file pages", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-source-lookup-file-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	const fileUrl = `file://${join(tempDir, "plain.html")}`;
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
	fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
	const valueFlags = new Set(["--session"]);
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
	if (command === "snapshot") {
		process.stdout.write(JSON.stringify({ success: true, data: { origin: ${JSON.stringify(fileUrl)}, title: "Plain file", url: ${JSON.stringify(fileUrl)}, refs: { e1: { role: "button", name: "Save" } }, snapshot: "- button \\\"Save\\\" [ref=e1]" } }));
		return;
	}
	if (command === "batch") {
		const steps = JSON.parse(stdin || "[]");
		const results = steps.map((step) => ({ command: step, success: true, result: step[0] === "get" && step[1] === "html" ? "<button>Save</button>" : { ok: true } }));
		process.stdout.write(JSON.stringify(results));
		return;
	}
	process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshotResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"], sessionMode: "fresh" });
			assert.equal(snapshotResult.isError, false);
			assert.equal((snapshotResult.details?.refSnapshot as { target?: { url?: string } } | undefined)?.target?.url, fileUrl);

			const lookupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: { componentName: "MissingLocalComponent", selector: "#save" },
			});
			assert.equal(lookupResult.isError, false);
			assert.match(lookupResult.content[0]?.text ?? "", /Source lookup found no candidate locations\./);
			assert.doesNotMatch(lookupResult.content[0]?.text ?? "", /packaged Electron|app\.asar|workspace scan was limited/);
			const sourceLookup = lookupResult.details?.sourceLookup as { electronContext?: unknown; status?: string; workspaceRoot?: string } | undefined;
			assert.equal(sourceLookup?.status, "no-candidates");
			assert.equal(sourceLookup?.electronContext, undefined);
			assert.equal(sourceLookup?.workspaceRoot, undefined);
			const nextActions = lookupResult.details?.nextActions as Array<{ id: string }> | undefined;
			assert.equal(nextActions?.some((action) => ["snapshot-electron-session", "probe-electron-launch", "list-electron-tabs"].includes(action.id)) ?? false, false);
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

			const sessionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				networkSourceLookup: { requestId: "req-1", session: "named" },
			});
			assert.equal(sessionResult.isError, false);
			const sessionCompiled = sessionResult.details?.compiledNetworkSourceLookup as { args?: string[]; steps?: Array<{ args: string[] }> } | undefined;
			assert.deepEqual(sessionCompiled?.args, ["--session", "named", "batch"]);
			assert.deepEqual(sessionCompiled?.steps?.map((step) => step.args), [["network", "request", "req-1"]]);

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-1), ["batch"]);
			assert.deepEqual(invocations[2]?.args.slice(-3), ["--session", "named", "batch"]);
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
			assert.match((ambiguous.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);
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
			assert.match((ambiguousJobArgs.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);

			const ambiguousJobSemanticAction = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/" }] },
				semanticAction: { action: "click", locator: "text", value: "Export" },
			});
			assert.equal(ambiguousJobSemanticAction.isError, true);
			assert.match((ambiguousJobSemanticAction.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);

			const invalidJobAction = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "unknown" }] },
			});
			assert.equal(invalidJobAction.isError, true);
			assert.match((invalidJobAction.content[0] as { text: string }).text, /action must be one of/);

			const missingJobText = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/" }, { action: "assertText" }] },
			});
			assert.equal(missingJobText.isError, true);
			assert.match((missingJobText.content[0] as { text: string }).text, /job step assertText requires a non-empty text string/);

			const invalidJobWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "wait", milliseconds: 0 }] },
			});
			assert.equal(invalidJobWait.isError, true);
			assert.match((invalidJobWait.content[0] as { text: string }).text, /wait requires a positive integer milliseconds/);

			const invalidJobSelect = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "select", selector: "#flavor" }] },
			});
			assert.equal(invalidJobSelect.isError, true);
			assert.match((invalidJobSelect.content[0] as { text: string }).text, /job\.steps\[0\]\.value or job\.steps\[0\]\.values is required for select/);

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
			assert.match((sourceLookupWithArgs.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);

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
			assert.match((networkSourceLookupWithArgs.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);

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

			const mismatchedRoleValue = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", role: "button", value: "link" },
			});
			assert.equal(mismatchedRoleValue.isError, true);
			assert.match((mismatchedRoleValue.content[0] as { text: string }).text, /semanticAction\.role must match value/);
			assert.equal(mismatchedRoleValue.details?.failureCategory, "validation-error");

			const emptySession = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Export", session: "" },
			});
			assert.equal(emptySession.isError, true);
			assert.match((emptySession.content[0] as { text: string }).text, /semanticAction\.session must be a non-empty string/);
			assert.equal(emptySession.details?.failureCategory, "validation-error");

			const selectWithoutSelector = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", value: "chocolate" },
			});
			assert.equal(selectWithoutSelector.isError, true);
			assert.match((selectWithoutSelector.content[0] as { text: string }).text, /semanticAction\.selector is required for select/);
			assert.equal(selectWithoutSelector.details?.failureCategory, "validation-error");

			const selectWithoutValue = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", selector: "#flavor" },
			});
			assert.equal(selectWithoutValue.isError, true);
			assert.match((selectWithoutValue.content[0] as { text: string }).text, /semanticAction\.value or semanticAction\.values is required for select/);
			assert.equal(selectWithoutValue.details?.failureCategory, "validation-error");

			const selectWithLocator = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", locator: "placeholder", selector: "#flavor", value: "chocolate" },
			});
			assert.equal(selectWithLocator.isError, true);
			assert.match((selectWithLocator.content[0] as { text: string }).text, /locator, role, and name are not supported for select/);
			assert.equal(selectWithLocator.details?.failureCategory, "validation-error");

			const invocations = await readInvocationLog(logPath).catch(() => []);
			assert.deepEqual(invocations.filter((entry) => entry.args.includes("find")), []);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns rich input recovery when semanticAction fill misses current editable refs", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-candidates-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://search.example/",
    refs: {
      e6: { role: "searchbox", name: "Search Wikipedia", editable: false },
      e7: { role: "searchbox", name: "Search Wikipedia" },
      e8: { role: "generic", name: "Search Wikipedia", contentEditable: true },
      e9: { role: "textbox", name: "Search Wikipedia advanced" },
      e10: { role: "button", name: "Search Wikipedia" },
      e11: { role: "textbox", name: "Composer" },
      e12: { role: "button", name: "Composer" },
      e13: { role: "unknown", name: "Search Wikipedia", editable: true },
      e14: { role: "generic", name: "Search Wikipedia", contenteditable: false }
    },
    snapshot: '- searchbox "Search Wikipedia" [ref=e6] editable=false\\n- searchbox "Search Wikipedia" [ref=e7]\\n- generic "Search Wikipedia" [ref=e8] contenteditable=true\\n- textbox "Search Wikipedia advanced" [ref=e9]\\n- button "Search Wikipedia" [ref=e10]\\n- textbox "Composer" [ref=e11]\\n- button "Composer" [ref=e12]\\n- generic "Search Wikipedia" [ref=e13] editable\\n- generic "Search Wikipedia" [ref=e14] contenteditable=false'
  } }));
  process.exit(0);
} else if (args.includes("find") || args.includes("select")) {
  process.stdout.write(JSON.stringify({ success: false, error: "selector not found" }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: "ok" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "placeholder", value: "Search Wikipedia", text: "- [ ] item" },
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "selector-not-found");
			const text = result.content[0] as { text: string };
			assert.match(text.text, /Current snapshot ref fallback:/);
			assert.match(text.text, /@e7 searchbox "Search Wikipedia"/);
			assert.doesNotMatch(text.text, /@e6/);
			assert.match(text.text, /@e8 textbox "Search Wikipedia"/);
			assert.match(text.text, /@e13 textbox "Search Wikipedia"/);
			assert.doesNotMatch(text.text, /@e9/);
			assert.doesNotMatch(text.text, /@e14/);
			assert.match(text.text, /Rich input recovery:/);
			assert.doesNotMatch(text.text, /Agent-browser candidate fallbacks:/);
			assert.doesNotMatch(text.text, /- \[ \] item/);
			const visibleRefFallback = result.details?.visibleRefFallback as { candidates?: Array<{ args?: string[]; editableEvidence?: boolean }>; target?: { text?: string } } | undefined;
			assert.equal(visibleRefFallback?.target?.text, undefined);
			assert.ok(visibleRefFallback?.candidates?.every((candidate) => candidate.args === undefined));
			assert.ok(visibleRefFallback?.candidates?.every((candidate) => candidate.editableEvidence === undefined));
			const richInputRecovery = result.details?.richInputRecovery as { candidates?: Array<{ clickArgs?: string[]; focusArgs?: string[]; ref?: string; role?: string }>; inputMethodHint?: string; nextActionIds?: string[] } | undefined;
			assert.deepEqual(richInputRecovery?.candidates?.map((candidate) => ({ clickArgs: candidate.clickArgs, focusArgs: candidate.focusArgs, ref: candidate.ref, role: candidate.role })), [
				{ clickArgs: ["click", "@e7"], focusArgs: ["focus", "@e7"], ref: "@e7", role: "searchbox" },
				{ clickArgs: ["click", "@e8"], focusArgs: ["focus", "@e8"], ref: "@e8", role: "textbox" },
				{ clickArgs: ["click", "@e13"], focusArgs: ["focus", "@e13"], ref: "@e13", role: "textbox" },
			]);
			assert.match(richInputRecovery?.inputMethodHint ?? "", /keyboard inserttext or keyboard type/);
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] }; reason?: string; safety?: string }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), [
				"refresh-interactive-refs",
				"focus-current-editable-ref-1",
				"click-current-editable-ref-1",
				"focus-current-editable-ref-2",
				"click-current-editable-ref-2",
				"focus-current-editable-ref-3",
				"click-current-editable-ref-3",
			]);
			assert.deepEqual(nextActions?.[1]?.params?.args?.slice(-2), ["focus", "@e7"]);
			assert.deepEqual(nextActions?.[2]?.params?.args?.slice(-2), ["click", "@e7"]);
			assert.deepEqual(nextActions?.[3]?.params?.args?.slice(-2), ["focus", "@e8"]);
			assert.deepEqual(nextActions?.[4]?.params?.args?.slice(-2), ["click", "@e8"]);
			assert.deepEqual(nextActions?.[5]?.params?.args?.slice(-2), ["focus", "@e13"]);
			assert.deepEqual(nextActions?.[6]?.params?.args?.slice(-2), ["click", "@e13"]);
			assert.match(nextActions?.[1]?.safety ?? "", /Several editable refs share/);
			const invocationsAfterFirstMiss = await readInvocationLog(logPath);
			assert.equal(invocationsAfterFirstMiss.length, 3);
			assert.deepEqual(invocationsAfterFirstMiss.map((entry) => entry.args.slice(3)), [
				["snapshot", "-i"],
				["find", "placeholder", "Search Wikipedia", "fill", "- [ ] item"],
				["snapshot", "-i"],
			]);
			for (const action of nextActions ?? []) {
				assert.ok(!action.params?.args?.includes("- [ ] item"));
				assert.ok(!action.params?.args?.includes("Enter"));
				assert.doesNotMatch(action.id ?? "", /submit/i);
				assert.doesNotMatch(action.reason ?? "", /agent browser/);
			}

			const rawDashFillMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["find", "placeholder", "Search Wikipedia", "fill", "- [ ] item"],
			});
			assert.equal(rawDashFillMiss.isError, true);
			assert.equal(rawDashFillMiss.details?.failureCategory, "selector-not-found");
			assert.match((rawDashFillMiss.content[0] as { text: string }).text, /Current snapshot ref fallback:/);
			assert.match((rawDashFillMiss.content[0] as { text: string }).text, /Rich input recovery:/);
			assert.match((rawDashFillMiss.content[0] as { text: string }).text, /@e7 searchbox "Search Wikipedia"/);
			assert.doesNotMatch((rawDashFillMiss.content[0] as { text: string }).text, /- \[ \] item/);
			const rawVisibleRefFallback = rawDashFillMiss.details?.visibleRefFallback as { candidates?: Array<{ args?: string[]; editableEvidence?: boolean }>; target?: { text?: string } } | undefined;
			assert.equal(rawVisibleRefFallback?.target?.text, undefined);
			assert.ok(rawVisibleRefFallback?.candidates?.every((candidate) => candidate.args === undefined));
			assert.ok(rawVisibleRefFallback?.candidates?.every((candidate) => candidate.editableEvidence === undefined));
			const rawNextActions = rawDashFillMiss.details?.nextActions as Array<{ params?: { args?: string[] } }> | undefined;
			for (const action of rawNextActions ?? []) {
				assert.ok(!action.params?.args?.includes("- [ ] item"));
			}

			const clickMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Search Wikipedia" },
			});
			assert.equal(clickMiss.isError, true);
			assert.equal(clickMiss.details?.failureCategory, "selector-not-found");
			assert.equal(clickMiss.details?.richInputRecovery, undefined);
			assert.match((clickMiss.content[0] as { text: string }).text, /Agent-browser candidate fallbacks:/);
			assert.doesNotMatch((clickMiss.content[0] as { text: string }).text, /try-searchbox-name-candidate|try-textbox-name-candidate|try-labeled-textbox-candidate/);
			const clickNextActions = clickMiss.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(clickNextActions?.map((action) => action.id), [
				"refresh-interactive-refs",
				"try-current-visible-ref",
				"try-button-name-candidate",
				"try-link-name-candidate",
			]);
			assert.deepEqual(clickNextActions?.[1]?.params?.args?.slice(-2), ["click", "@e10"]);
			assert.deepEqual(clickNextActions?.[2]?.params?.args, ["find", "role", "button", "click", "--name", "Search Wikipedia"]);
			assert.deepEqual(clickNextActions?.[3]?.params?.args, ["find", "role", "link", "click", "--name", "Search Wikipedia"]);
			assert.ok(!JSON.stringify(clickNextActions).includes("agent browser"));

			const textFillMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "text", value: "Composer", text: "private smoke prompt" },
			});
			assert.equal(textFillMiss.isError, true);
			assert.equal(textFillMiss.details?.failureCategory, "selector-not-found");
			assert.match((textFillMiss.content[0] as { text: string }).text, /Rich input recovery:/);
			assert.match((textFillMiss.content[0] as { text: string }).text, /@e11 textbox "Composer"/);
			assert.doesNotMatch((textFillMiss.content[0] as { text: string }).text, /private smoke prompt/);
			const textFillRecovery = textFillMiss.details?.richInputRecovery as { candidates?: Array<{ clickArgs?: string[]; focusArgs?: string[]; ref?: string; role?: string }> } | undefined;
			assert.deepEqual(textFillRecovery?.candidates?.map((candidate) => ({ clickArgs: candidate.clickArgs, focusArgs: candidate.focusArgs, ref: candidate.ref, role: candidate.role })), [
				{ clickArgs: ["click", "@e11"], focusArgs: ["focus", "@e11"], ref: "@e11", role: "textbox" },
			]);
			const textFillNextActions = textFillMiss.details?.nextActions as Array<{ id?: string; params?: { args?: string[] }; reason?: string; safety?: string }> | undefined;
			assert.deepEqual(textFillNextActions?.map((action) => action.id), ["refresh-interactive-refs", "focus-current-editable-ref", "click-current-editable-ref"]);
			for (const action of textFillNextActions ?? []) {
				assert.ok(!action.params?.args?.includes("private smoke prompt"));
				assert.ok(!action.params?.args?.includes("Enter"));
				assert.doesNotMatch(action.id ?? "", /submit/i);
				assert.doesNotMatch(action.reason ?? "", /private smoke prompt/);
			}

			const selectMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", selector: "find", values: ["role", "button", "click", "--name", "Search Wikipedia"] },
			});
			assert.equal(selectMiss.isError, true);
			assert.equal(selectMiss.details?.failureCategory, "selector-not-found");
			assert.doesNotMatch((selectMiss.content[0] as { text: string }).text, /Current snapshot ref fallback|Agent-browser candidate fallbacks|@e10/);
			const selectMissNextActions = selectMiss.details?.nextActions as Array<{ id?: string }> | undefined;
			assert.deepEqual(selectMissNextActions?.map((action) => action.id), ["refresh-interactive-refs"]);

			const rawSelectMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["select", "find", "role", "button", "click", "--name", "Search Wikipedia"],
			});
			assert.equal(rawSelectMiss.isError, true);
			assert.equal(rawSelectMiss.details?.failureCategory, "selector-not-found");
			assert.doesNotMatch((rawSelectMiss.content[0] as { text: string }).text, /Current snapshot ref fallback|@e10/);
			const rawSelectMissNextActions = rawSelectMiss.details?.nextActions as Array<{ id?: string }> | undefined;
			assert.deepEqual(rawSelectMissNextActions?.map((action) => action.id), ["refresh-interactive-refs"]);

		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension suggests current snapshot refs when raw find role locators miss", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-find-ref-fallback-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://login.example/",
    refs: {
      e3: { role: "button", name: "Login" },
      e4: { role: "button", name: "Cancel" },
      e5: { role: "link", name: "Login" },
      e6: { role: "button", name: "Login later" }
    },
    snapshot: '- button "Login" [ref=e3]\\n- button "Cancel" [ref=e4]\\n- link "Login" [ref=e5]\\n- button "Login later" [ref=e6]'
  } }));
} else if (args.includes("find")) {
  process.stdout.write(JSON.stringify({ success: false, error: "Element not found" }));
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["find", "role", "button", "click", "--name", "Login"],
			});
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "selector-not-found");
			assert.match((result.content[0] as { text: string }).text, /Current snapshot ref fallback:/);
			assert.match((result.content[0] as { text: string }).text, /@e3 button "Login"/);
			assert.doesNotMatch((result.content[0] as { text: string }).text, /@e5 link "Login"/);
			assert.doesNotMatch((result.content[0] as { text: string }).text, /@e6 button "Login later"/);

			const visibleRefFallback = result.details?.visibleRefFallback as { candidates?: Array<{ ref?: string; role?: string; name?: string }> } | undefined;
			assert.deepEqual(visibleRefFallback?.candidates, [
				{
					action: "click",
					args: ["click", "@e3"],
					name: "Login",
					reason: 'Current snapshot shows button "Login" at @e3, matching the failed click locator exactly.',
					ref: "@e3",
					role: "button",
				},
			]);
			assert.deepEqual((result.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e3", "e4", "e5", "e6"]);

			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] }; safety?: string }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["refresh-interactive-refs", "try-current-visible-ref"]);
			assert.deepEqual(nextActions?.[1]?.params?.args?.slice(-2), ["click", "@e3"]);
			assert.match(nextActions?.[1]?.safety ?? "", /current snapshot/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("find")).length, 1);
			assert.equal(invocations.filter((entry) => entry.args.includes("snapshot")).length, 2);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns a safe semantic retry action only for stale-ref find shorthand failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-stale-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("find") || args.includes("select")) {
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

			const selectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", selector: "@e4", value: "find" },
			});
			assert.equal(selectResult.isError, true);
			assert.equal(selectResult.details?.failureCategory, "stale-ref");
			const selectNextActions = selectResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(selectNextActions?.map((action) => action.id), ["refresh-interactive-refs"]);
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

test("agentBrowserExtension keeps network request diagnostics from replacing the active page target", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-request-target-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const appTarget = "https://app.example/";
const apiTarget = "https://app.example/api/data";
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: appTarget,
    refs: { e1: { role: "button", name: "Refresh data" } },
    snapshot: '- button "Refresh data" [ref=e1]'
  } }));
} else if (args.includes("network") && args.includes("request")) {
  process.stdout.write(JSON.stringify({ success: true, data: { id: "42", method: "GET", status: 500, url: apiTarget, error: "server error" } }));
} else if (args.includes("errors")) {
  process.stdout.write(JSON.stringify({ success: true, data: { errors: [], url: "https://cdn.example/app.js" } }));
} else if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  process.stdout.write(JSON.stringify(steps.map((step) => {
    if (step[0] === "network" && step[1] === "request") {
      return { command: step, success: true, result: { id: step[2], method: "GET", status: 500, url: apiTarget, error: "server error" } };
    }
    if (step[0] === "network" && step[1] === "requests") {
      return { command: step, success: true, result: { requests: [{ id: "42", method: "GET", status: 500, url: apiTarget, error: "server error" }] } };
    }
    return { command: step, success: true, result: { ok: step[0] } };
  })));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.deepEqual(snapshot.details?.sessionTabTarget, { title: undefined, url: "https://app.example/" });

			const networkRequest = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["network", "request", "42"] });
			assert.equal(networkRequest.isError, false, JSON.stringify(networkRequest));
			assert.deepEqual(networkRequest.details?.sessionTabTarget, { title: undefined, url: "https://app.example/" });
			assert.deepEqual((networkRequest.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);

			const pageErrors = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["errors"] });
			assert.equal(pageErrors.isError, false, JSON.stringify(pageErrors));
			assert.deepEqual(pageErrors.details?.sessionTabTarget, { title: undefined, url: "https://app.example/" });

			const clickAfterNetworkRequest = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(clickAfterNetworkRequest.isError, false, JSON.stringify(clickAfterNetworkRequest));
			assert.notEqual(clickAfterNetworkRequest.details?.failureCategory, "stale-ref");
			assert.equal((clickAfterNetworkRequest.details?.data as { clicked?: string } | undefined)?.clicked, "@e1");

			const networkSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, { networkSourceLookup: { requestId: "42" } });
			assert.equal(networkSourceLookup.isError, false, JSON.stringify(networkSourceLookup));
			assert.deepEqual(networkSourceLookup.details?.sessionTabTarget, { title: undefined, url: "https://app.example/" });
			assert.deepEqual((networkSourceLookup.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);

			const clickAfterNetworkSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(clickAfterNetworkSourceLookup.isError, false, JSON.stringify(clickAfterNetworkSourceLookup));
			assert.notEqual(clickAfterNetworkSourceLookup.details?.failureCategory, "stale-ref");

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 2);
			assert.equal(invocations.filter((entry) => entry.args.includes("network") && entry.args.includes("request")).length, 1);
			assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension ignores restored diagnostic session targets that contain request URLs", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-request-restore-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const appTarget = { title: undefined, url: "https://app.example/" };
			const harness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://app.example/"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: appTarget,
						},
						isError: false,
					}),
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "snapshot", "-i"],
							command: "snapshot",
							refSnapshot: { refIds: ["e1"], target: appTarget },
							sessionName: "named",
							sessionTabTarget: appTarget,
						},
						isError: false,
					}),
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "network", "request", "42"],
							command: "network",
							refSnapshot: { refIds: ["e1"], target: appTarget },
							sessionName: "named",
							sessionTabTarget: { title: undefined, url: "https://app.example/api/data" },
							subcommand: "request",
						},
						isError: false,
					}),
					createToolBranchEntry({
						details: {
							args: ["batch"],
							command: "batch",
							compiledNetworkSourceLookup: { args: ["batch"], query: { requestId: "42" }, steps: [], stdin: "[]" },
							data: [
								{
									command: ["network", "request", "42"],
									result: { error: "server error", id: "42", status: 500, url: "https://app.example/api/data" },
									success: true,
								},
							],
							refSnapshot: { refIds: ["e1"], target: appTarget },
							sessionName: "named",
							sessionTabTarget: { title: undefined, url: "https://app.example/api/data" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "click", "@e1"] });
			assert.equal(click.isError, false, JSON.stringify(click));
			assert.notEqual(click.details?.failureCategory, "stale-ref");
			assert.deepEqual(click.details?.sessionTabTarget, appTarget);
			assert.deepEqual((click.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);
			assert.equal("order" in ((click.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension restores empty successful batch snapshots as ref state", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-empty-ref-restore-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("click")) {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const appTarget = { title: undefined, url: "https://empty.example/" };
			const harness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "snapshot", "-i"],
							command: "snapshot",
							refSnapshotInvalidation: { reason: "no-active-page", summary: "The latest snapshot for this session reported No active page. Old page-scoped refs are invalid until snapshot -i succeeds." },
							sessionName: "named",
						},
						isError: true,
					}),
					createToolBranchEntry({
						details: {
							args: ["batch"],
							command: "batch",
							data: [{ command: ["snapshot", "-i"], result: { origin: appTarget.url, refs: {}, snapshot: "" }, success: true }],
							refSnapshot: { refIds: [], target: appTarget },
							sessionName: "named",
							sessionTabTarget: appTarget,
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "click", "@e1"] });
			assert.equal(click.isError, true);
			assert.equal(click.details?.failureCategory, "stale-ref");
			assert.deepEqual(click.details?.refIds, ["e1"]);
			assert.deepEqual((click.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, []);
			assert.equal(click.details?.refSnapshotInvalidation, undefined);
			assert.match((click.content[0] as { text: string }).text, /was not present in the latest snapshot/);

			const invocations = await readInvocationLog(logPath).catch(() => []);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 0);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension treats successful snapshots without refs as empty ref state", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-missing-refs-snapshot-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "snapshot-count.txt");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
	let count = 0;
	try { count = Number(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
	count += 1;
	fs.writeFileSync(${JSON.stringify(statePath)}, String(count));
	if (count === 1) {
	process.stdout.write(JSON.stringify({ success: true, data: {
		origin: "https://missing-refs.example/",
		refs: { e1: { role: "button", name: "Old Search" } },
		snapshot: '- button "Old Search" [ref=e1]'
	} }));
	} else {
	process.stdout.write(JSON.stringify({ success: true, data: {
		origin: "https://missing-refs.example/",
		snapshot: 'No interactive controls are visible.'
	} }));
	}
} else if (args.includes("click")) {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(firstSnapshot.isError, false, JSON.stringify(firstSnapshot));
			assert.deepEqual((firstSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);

			const emptySnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(emptySnapshot.isError, false, JSON.stringify(emptySnapshot));
			assert.deepEqual((emptySnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, []);

			const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(staleClick.isError, true, JSON.stringify(staleClick));
			assert.equal(staleClick.details?.failureCategory, "stale-ref");
			assert.match((staleClick.content[0] as { text: string }).text, /was not present in the latest snapshot/);
			assert.deepEqual((staleClick.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, []);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 0);
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

test("agentBrowserExtension allows same-snapshot form fills before a batch click", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-form-fills-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://login.example/",
    refs: {
      e3: { role: "button", name: "Login" },
      e4: { role: "textbox", name: "Username" },
      e5: { role: "textbox", name: "Password" }
    },
    snapshot: '- textbox "Username" [ref=e4]\\n- textbox "Password" [ref=e5]\\n- button "Login" [ref=e3]'
  } }));
} else if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  process.stdout.write(JSON.stringify(steps.map((step) => ({ command: step, success: true, result: { ok: step[0] } }))));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));

			const sameFormBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([
					["fill", "@e4", "standard_user"],
					["fill", "@e5", "secret_sauce"],
					["click", "@e3"],
				]),
			});
			assert.equal(sameFormBatch.isError, false, JSON.stringify(sameFormBatch));

			const clickThenFill = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([
					["click", "@e3"],
					["fill", "@e4", "standard_user"],
				]),
			});
			assert.equal(clickThenFill.isError, true);
			assert.equal(clickThenFill.details?.failureCategory, "stale-ref");
			assert.match((clickThenFill.content[0] as { text: string }).text, /after an earlier batch step can navigate or mutate/);

			const invocations = await readInvocationLog(logPath);
			const batchInvocations = invocations.filter((entry) => entry.args.includes("batch"));
			assert.equal(batchInvocations.length, 1);
			assert.deepEqual(JSON.parse(String(batchInvocations[0]?.stdin ?? "[]")), [
				["fill", "@e4", "standard_user"],
				["fill", "@e5", "secret_sauce"],
				["click", "@e3"],
			]);
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

test("agentBrowserExtension warns when eval stdin returns an empty object from a function-shaped snippet", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-eval-stdin-hint-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
const trimmed = stdin.trim();
if (trimmed === "(() => [])()") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: [], origin: "https://example.com/" } }));
} else if (trimmed === "(() => [1])()") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: [1], origin: "https://example.com/" } }));
} else if (trimmed.startsWith("() =>")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: {}, origin: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Example Domain" }, origin: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const functionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "() => ({ title: document.title })",
			});
			assert.equal(functionResult.isError, false);
			assert.match((functionResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.match((functionResult.content[0] as { text: string }).text, /\(\{ title: document\.title \}\)/);
			assert.deepEqual(functionResult.details?.evalStdinHint, {
				reason: "eval --stdin received a function-shaped snippet and the upstream JSON result was an empty object, which often means the function itself was returned or serialized instead of invoked.",
				suggestion: "Pass a plain expression such as `({ title: document.title })`, or invoke the function explicitly, for example `(() => ({ title: document.title }))()`.",
			});

			const jsonFunctionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--json", "eval", "--stdin"],
				stdin: "() => ({ title: document.title })",
			});
			assert.equal(jsonFunctionResult.isError, false);
			const jsonFunctionText = (jsonFunctionResult.content[0] as { text: string }).text;
			assert.doesNotMatch(jsonFunctionText, /Eval stdin hint:/);
			assert.deepEqual(JSON.parse(jsonFunctionText), {
				data: { origin: "https://example.com/", result: {} },
				success: true,
			});
			assert.deepEqual(jsonFunctionResult.details?.evalStdinHint, functionResult.details?.evalStdinHint);

			const emptyArrayIifeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "(() => [])()",
			});
			assert.equal(emptyArrayIifeResult.isError, false);
			assert.doesNotMatch((emptyArrayIifeResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.equal(emptyArrayIifeResult.details?.evalStdinHint, undefined);

			const nonEmptyArrayIifeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "(() => [1])()",
			});
			assert.equal(nonEmptyArrayIifeResult.isError, false);
			assert.doesNotMatch((nonEmptyArrayIifeResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.equal(nonEmptyArrayIifeResult.details?.evalStdinHint, undefined);

			const expressionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "({ title: document.title })",
			});
			assert.equal(expressionResult.isError, false);
			assert.doesNotMatch((expressionResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.equal(expressionResult.details?.evalStdinHint, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports managed-session outcomes after failed fresh launches", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-managed-session-outcome-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("https://fail.test")) {
  console.error("simulated launch failure");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ success: true, data: { title: "ok", url: args.at(-1) || "about:blank" } }));`,
	);

	try {
		const missingBinaryDir = await mkdtemp(join(tempDir, "missing-agent-browser-"));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://previous.test"] });
			assert.equal(firstResult.isError, false);
			const previousSessionName = firstResult.details?.sessionName as string;
			assert.ok(previousSessionName);

			const failedFreshResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://fail.test"], sessionMode: "fresh" });
			assert.equal(failedFreshResult.isError, true);
			const preservedOutcome = failedFreshResult.details?.managedSessionOutcome as { activeAfter?: boolean; activeBefore?: boolean; attemptedSessionName?: string; currentSessionName?: string; previousSessionName?: string; sessionMode?: string; status?: string; succeeded?: boolean; summary?: string } | undefined;
			assert.equal(preservedOutcome?.status, "preserved");
			assert.equal(preservedOutcome?.activeBefore, true);
			assert.equal(preservedOutcome?.activeAfter, true);
			assert.equal(preservedOutcome?.currentSessionName, previousSessionName);
			assert.equal(preservedOutcome?.previousSessionName, previousSessionName);
			assert.equal(preservedOutcome?.sessionMode, "fresh");
			assert.match(preservedOutcome?.attemptedSessionName ?? "", /-fresh-/);
			assert.equal(preservedOutcome?.succeeded, false);
			assert.match((failedFreshResult.content[0] as { text: string }).text, /Managed session outcome: Fresh managed session .* failed before becoming current; previous managed session .* was preserved\./);

			await withPatchedEnv({ PATH: missingBinaryDir }, async () => {
				const missingBinaryResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://missing-binary.test"], sessionMode: "fresh" });
				assert.equal(missingBinaryResult.isError, true);
				assert.equal(missingBinaryResult.details?.failureCategory, "missing-binary");
				const missingBinaryOutcome = missingBinaryResult.details?.managedSessionOutcome as { activeAfter?: boolean; activeBefore?: boolean; currentSessionName?: string; previousSessionName?: string; sessionMode?: string; status?: string } | undefined;
				assert.equal(missingBinaryOutcome?.status, "preserved");
				assert.equal(missingBinaryOutcome?.activeBefore, true);
				assert.equal(missingBinaryOutcome?.activeAfter, true);
				assert.equal(missingBinaryOutcome?.currentSessionName, previousSessionName);
				assert.equal(missingBinaryOutcome?.previousSessionName, previousSessionName);
				assert.equal(missingBinaryOutcome?.sessionMode, "fresh");
				assert.match((missingBinaryResult.content[0] as { text: string }).text, /Managed session outcome: Fresh managed session .* failed before becoming current; previous managed session .* was preserved\./);
			});

			const followupResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(followupResult.isError, false);
			assert.equal(followupResult.details?.sessionName, previousSessionName);

			const abandonedHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(abandonedHarness.handlers, "session_start", { reason: "new" }, abandonedHarness.ctx);
			const abandonedResult = await executeRegisteredTool(abandonedHarness.tool, abandonedHarness.ctx, { args: ["open", "https://fail.test"], sessionMode: "fresh" });
			assert.equal(abandonedResult.isError, true);
			const abandonedOutcome = abandonedResult.details?.managedSessionOutcome as { activeAfter?: boolean; activeBefore?: boolean; status?: string; summary?: string } | undefined;
			assert.equal(abandonedOutcome?.status, "abandoned");
			assert.equal(abandonedOutcome?.activeBefore, false);
			assert.equal(abandonedOutcome?.activeAfter, false);
			assert.match((abandonedResult.content[0] as { text: string }).text, /no previous managed session was active/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports partial progress and artifacts after job timeout", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-job-timeout-progress-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.test/secret-token/results?token=url-secret" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Results page export secret-token Authorization: Bearer title-secret" } }));
} else if (args.includes("batch")) {
  const stdin = fs.readFileSync(0, "utf8");
  const steps = JSON.parse(stdin);
  const screenshotStep = steps.find((step) => step[0] === "screenshot");
  const screenshot = screenshotStep?.filter((token) => !String(token).startsWith('-')).at(-1);
  if (screenshot && screenshot !== 'screenshot') {
    fs.mkdirSync(path.dirname(path.resolve(screenshot)), { recursive: true });
    fs.writeFileSync(path.resolve(screenshot), "fake image");
  }
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		// Keep the watchdog short enough to exercise timeout progress, but not so short that
		// immediate helper probes (`get url` / `get title`) flake under full release-suite load.
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "500" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: {
					steps: [
						{ action: "open", url: "https://example.test" },
						{ action: "screenshot", path: "dogfood/secret-token/filled.png" },
						{ action: "waitForDownload", path: "dogfood/export.csv" },
						{ action: "wait", milliseconds: 500 },
					],
				},
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "timeout");
			assert.equal(result.details?.timedOut, true);
			const timeoutProgress = result.details?.timeoutPartialProgress as { artifacts?: Array<{ exists?: boolean; path?: string; sizeBytes?: number; stepIndex?: number }>; currentPage?: { title?: string; url?: string }; steps?: Array<{ args?: string[]; index?: number }> } | undefined;
			assert.equal(timeoutProgress?.currentPage?.url, "https://example.test/secret-token/results?token=%5BREDACTED%5D");
			assert.equal(timeoutProgress?.currentPage?.title, "Results page export secret-token Authorization: Bearer [REDACTED]");
			assert.deepEqual(timeoutProgress?.artifacts?.map((artifact) => ({ exists: artifact.exists, path: artifact.path, stepIndex: artifact.stepIndex })), [
				{ exists: true, path: "dogfood/secret-token/filled.png", stepIndex: 2 },
				{ exists: false, path: "dogfood/export.csv", stepIndex: 3 },
			]);
			assert.deepEqual(timeoutProgress?.steps?.map((step) => step.args?.[0]), ["open", "screenshot", "wait", "wait"]);
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /Timeout partial progress:/);
			assert.match(text, /Current page: \[REDACTED\] — https:\/\/example.test\/\[REDACTED\]\/results\?token=%5BREDACTED%5D/);
			assert.match(text, /Artifact from step 2: dogfood\/\[REDACTED\]\/filled\.png \(exists, 10 bytes\)/);
			assert.doesNotMatch(text, /url-secret|title-secret|secret-token/);
			assert.match(text, /Artifact from step 3: dogfood\/export\.csv \(missing\)/);

			const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["screenshot", "--full-page", "dogfood/option-full-page.png"], ["wait", "--download", "dogfood/download.csv", "--timeout", "1000"]]),
			});
			assert.equal(batchResult.isError, true);
			const batchProgress = batchResult.details?.timeoutPartialProgress as { artifacts?: Array<{ exists?: boolean; path?: string; stepIndex?: number }> } | undefined;
			assert.deepEqual(batchProgress?.artifacts?.map((artifact) => ({ exists: artifact.exists, path: artifact.path, stepIndex: artifact.stepIndex })), [
				{ exists: true, path: "dogfood/option-full-page.png", stepIndex: 1 },
				{ exists: false, path: "dogfood/download.csv", stepIndex: 2 },
			]);

			const waitNoPathResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["wait", "--download", "--timeout", "1000"]]),
			});
			assert.equal(waitNoPathResult.isError, true);
			const waitNoPathProgress = waitNoPathResult.details?.timeoutPartialProgress as { artifacts?: Array<{ path?: string }> } | undefined;
			assert.deepEqual(waitNoPathProgress?.artifacts, []);
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

test("agentBrowserExtension reports artifact lifecycle guidance on close", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-artifact-cleanup-"));
	const screenshotPath = join(tempDir, "artifact.png");
	const deletedScreenshotPath = join(tempDir, "deleted-artifact.png");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("screenshot")) {
  const outputPath = args[args.length - 1];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from("89504e470d0a1a0a", "hex"));
  process.stdout.write(JSON.stringify({ success: true, data: { path: outputPath } }));
} else if (args.includes("close")) {
  if (args.includes("--fail")) {
    process.stdout.write(JSON.stringify({ success: false, error: "close failed" }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
  }
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const screenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", screenshotPath] });
			assert.equal(screenshot.isError, false);
			const deletedScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", deletedScreenshotPath] });
			assert.equal(deletedScreenshot.isError, false);
			await rm(deletedScreenshotPath, { force: true });
			assert.equal((deletedScreenshot.details?.artifactManifest as { liveCount?: number } | undefined)?.liveCount, 2);

			const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(close.isError, false);
			const text = (close.content[0] as { text: string }).text;
			assert.match(text, /Artifact lifecycle:/);
			assert.match(text, /Closing the browser session does not delete explicit screenshots/);
			assert.match(text, /artifact\.png/);
			assert.doesNotMatch(text, /deleted-artifact\.png/);
			assert.deepEqual(close.details?.artifactCleanup, {
				explicitArtifactPaths: [screenshotPath],
				note: "Closing the browser session does not delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings; clean existing paths with host file tools when no longer needed.",
				owner: "host-file-tools",
				summary: String(close.details?.artifactRetentionSummary),
			});

			const failedClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close", "--fail"] });
			assert.equal(failedClose.isError, true);
			assert.doesNotMatch((failedClose.content[0] as { text: string }).text, /Artifact lifecycle:/);
			assert.equal(failedClose.details?.artifactCleanup, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns when get text may read hidden selector matches", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-get-text-visibility-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("get") && args.includes("text")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "npm init playwright@latest", origin: "https://docs.example/" } }));
} else if (args.includes("eval")) {
  const isAmbiguous = stdin.includes('.ambiguous-language-bash');
  process.stdout.write(JSON.stringify({ success: true, data: { result: JSON.stringify(isAmbiguous
    ? { selector: '.ambiguous-language-bash', matchCount: 2, visibleCount: 2, firstMatchVisible: true, firstTextPreview: "first visible", firstVisibleTextPreview: "first visible" }
    : { selector: '[href*="token=page-secret"]', matchCount: 2, visibleCount: 1, firstMatchVisible: false, firstTextPreview: "npm init playwright@latest", firstVisibleTextPreview: "yarn create playwright Authorization: Bearer visible-secret" }) } }));
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify({ success: true, data: [{ command: ["get", "text", ".ambiguous-language-bash"], success: true, result: { result: "first visible" } }, { command: ["get", "text", ".language-bash"], success: true, result: { result: "npm init playwright@latest" } }] }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", ".language-bash"] });
			assert.equal(result.isError, false);
			assert.match((result.content[0] as { text: string }).text, /npm init playwright@latest/);
			assert.match((result.content[0] as { text: string }).text, /Selector text visibility warning:/);
			assert.match((result.content[0] as { text: string }).text, /Next action: use details\.nextActions inspect-visible-text-candidates before trusting this selector text\./);
			assert.match((result.content[0] as { text: string }).text, /yarn create playwright/);
			assert.doesNotMatch((result.content[0] as { text: string }).text, /visible-secret|page-secret/);
			assert.deepEqual(result.details?.selectorTextVisibility, {
				firstMatchVisible: false,
				firstVisibleTextPreview: "yarn create playwright Authorization: Bearer [REDACTED]",
				matchCount: 2,
				selector: ".language-bash",
				summary: 'Selector ".language-bash" matched 2 elements; the first match is hidden while 1 visible match exists.',
				visibleCount: 1,
			});
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[]; stdin?: string } }> | undefined;
			assert.equal(nextActions?.at(-1)?.id, "inspect-visible-text-candidates");
			assert.deepEqual(nextActions?.at(-1)?.params?.args, ["--session", result.details?.sessionName as string, "eval", "--stdin"]);
			assert.match(nextActions?.at(-1)?.params?.stdin ?? "", /querySelectorAll/);

			const secretSelectorResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", '[href*="token=visible-secret"]'] });
			assert.equal(secretSelectorResult.isError, false);
			assert.doesNotMatch((secretSelectorResult.content[0] as { text: string }).text, /Selector text visibility warning|visible-secret/);
			assert.equal(secretSelectorResult.details?.selectorTextVisibility, undefined);
			const unquotedSecretSelectorResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", "[data-token=visible-secret]"] });
			assert.equal(unquotedSecretSelectorResult.isError, false);
			assert.doesNotMatch((unquotedSecretSelectorResult.content[0] as { text: string }).text, /Selector text visibility warning|visible-secret/);
			assert.equal(unquotedSecretSelectorResult.details?.selectorTextVisibility, undefined);
			let invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);

			const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: JSON.stringify([["get", "text", ".ambiguous-language-bash"], ["get", "text", ".language-bash"]]) });
			assert.equal(batchResult.isError, false);
			assert.match((batchResult.content[0] as { text: string }).text, /Selector text visibility warning:/);
			assert.match((batchResult.content[0] as { text: string }).text, /Selector "\.language-bash" matched 2 elements; the first match is hidden/);
			assert.match((batchResult.content[0] as { text: string }).text, /Selector "\.ambiguous-language-bash" matched 2 elements; get text reads the first upstream match/);
			assert.match((batchResult.content[0] as { text: string }).text, /Next action: use details\.nextActions inspect-visible-text-candidates before trusting this selector text\./);
			assert.match((batchResult.content[0] as { text: string }).text, /Next action: use details\.nextActions inspect-visible-text-candidates-2 before trusting this selector text\./);
			assert.equal((batchResult.details?.selectorTextVisibility as { selector?: string } | undefined)?.selector, ".language-bash");
			assert.deepEqual((batchResult.details?.selectorTextVisibilityAll as Array<{ selector?: string }> | undefined)?.map((entry) => entry.selector), [".language-bash", ".ambiguous-language-bash"]);
			invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 3);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension surfaces likely overlay blockers after a no-op click", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-overlay-blocker-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Blocked Search", url: "https://blocked.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e9" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Blocked Search", url: "https://blocked.example/" } } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://blocked.example/",
    refs: {
      e5: { role: "button", name: "×" },
      e6: { role: "button", name: "Donate now" },
      e7: { role: "dialog", name: "Donation banner" }
    },
    snapshot: '- dialog "Donation banner" [ref=e7]\\n  - button "×" [ref=e5]\\n  - button "Donate now" [ref=e6]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://blocked.example/"] });
			assert.equal(open.isError, false);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e9"] });
			assert.equal(click.isError, false);
			const text = click.content[0] as { text: string };
			assert.match(text.text, /Possible overlay blockers:/);
			assert.match(text.text, /@e5 button "×"/);
			assert.doesNotMatch(text.text, /Agent-browser candidate fallbacks:/);
			const overlayBlockers = click.details?.overlayBlockers as { candidates?: Array<{ ref?: string; args?: string[] }> } | undefined;
			assert.equal(overlayBlockers?.candidates?.[0]?.ref, "@e5");
			assert.deepEqual((click.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e5", "e6", "e7"]);
			const nextActions = click.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["inspect-after-mutation", "inspect-overlay-state", "try-overlay-blocker-candidate-1"]);
			assert.deepEqual(nextActions?.[1]?.params?.args, ["--session", click.details?.sessionName as string, "snapshot", "-i"]);
			assert.deepEqual(nextActions?.[2]?.params?.args, ["--session", click.details?.sessionName as string, "click", "@e5"]);

			const closeCandidateArgs = nextActions?.[2]?.params?.args;
			assert.ok(closeCandidateArgs);
			const closeCandidate = await executeRegisteredTool(harness.tool, harness.ctx, { args: closeCandidateArgs });
			assert.equal(closeCandidate.isError, false);
			assert.notEqual(closeCandidate.details?.failureCategory, "stale-ref");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not report overlay blockers from unrelated page chrome after a successful same-page click", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-overlay-noise-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Repo", url: "https://repo.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e9" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Repo", url: "https://repo.example/" } } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://repo.example/",
    refs: {
      e1: { role: "link", name: "Skip to content" },
      e2: { role: "button", name: "Privacy choices" },
      e3: { role: "button", name: "Close banner" }
    },
    snapshot: '- link "Skip to content" [ref=e1]\\n- button "Privacy choices" [ref=e2]\\n- button "Close banner" [ref=e3]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://repo.example/"] });
			assert.equal(open.isError, false);
			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e9"] });
			assert.equal(click.isError, false);
			const text = click.content[0] as { text: string };
			assert.doesNotMatch(text.text, /Possible overlay blockers:/);
			assert.equal(click.details?.overlayBlockers, undefined);
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
			const nextActions = result.details?.nextActions as Array<{ id: string; params?: { args: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["list-tabs-for-tab-drift-recovery"]);
			assert.deepEqual(nextActions?.map((action) => action.params?.args), [
				["--session", "named", "tab", "list"],
			]);
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
