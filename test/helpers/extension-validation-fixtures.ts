/**
 * Purpose: Share extension-validation fixtures that are too large for the focused test suites.
 * Responsibilities: Provide a plain TUI render theme plus fake Electron app/process fixtures.
 * Scope: Test-only helpers for agent-browser extension validation.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Theme } from "@earendil-works/pi-coding-agent";

import type { ElectronAppDiscovery } from "../../extensions/agent-browser/lib/electron/discovery.js";
import type { AgentBrowserToolParams, AgentBrowserToolRenderContext } from "./agent-browser-harness.js";

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
	thinkingMax: "#ffffff",
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

export const PLAIN_RENDER_THEME = new PlainRenderTheme();

export function createRenderContext(options: {
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

export async function writeFakeMacElectronApp(options: {
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

export async function writeFakeLinuxElectronBinary(root: string, appName: string): Promise<string> {
	const appDirectory = join(root, appName);
	const executablePath = join(appDirectory, appName);
	await mkdir(join(appDirectory, "resources"), { recursive: true });
	await writeFile(executablePath, "#!/bin/sh\n", "utf8");
	await chmod(executablePath, 0o755);
	await writeFile(join(appDirectory, "resources", "app.asar"), "asar", "utf8");
	await writeFile(join(appDirectory, "chrome_100_percent.pak"), "pak", "utf8");
	return executablePath;
}

export function electronAppNames(apps: ElectronAppDiscovery[]): string[] {
	return apps.map((app) => app.name).sort();
}

export function isTestPidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForTestPidExit(pid: number | undefined, timeoutMs = 2_000): Promise<boolean> {
	const deadlineMs = Date.now() + timeoutMs;
	while (Date.now() <= deadlineMs) {
		if (!isTestPidAlive(pid)) return true;
		await sleepMs(50);
	}
	return !isTestPidAlive(pid);
}

export async function stopTestPid(pid: number | undefined): Promise<void> {
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

export async function readOptionalFakeElectronLaunchLog(path: string): Promise<FakeElectronLaunchLogEntry[]> {
	try {
		const text = (await readFile(path, "utf8")).trim();
		return text.length > 0 ? text.split("\n").map((line) => JSON.parse(line) as FakeElectronLaunchLogEntry) : [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function writeFakeLaunchableElectronApp(options: {
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

export function fakeAgentBrowserLifecycleScript(logPath: string, options: {
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
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device", "--user-agent"]);
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
