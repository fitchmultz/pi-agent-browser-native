/**
 * Purpose: Provide shared test harness utilities for the pi-agent-browser extension test suites.
 * Responsibilities: Build fake pi extension contexts, run registered extension events/tools, patch process env safely, create fake agent-browser binaries, read invocation logs, and manage child-process fixtures.
 * Scope: Test-only utilities for `test/agent-browser.*.test.ts`; production code must not import this module.
 * Usage: Import focused helpers from `./helpers/agent-browser-harness.js` inside Node test-runner suites.
 * Invariants/Assumptions: Helpers preserve caller-owned cleanup responsibilities and restore patched environment variables after each run. `writeFakeAgentBrowserBinary` installs a Unix shell-script launcher or a Windows `agent-browser.cmd` that runs the same Node script body; pass `platform: "win32"` to assert Windows launcher layout from non-Windows hosts (spawn/PATHEXT behavior still needs a real Windows runner).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { execPath as nodeExecPath, platform as processPlatform } from "node:process";

import type {
	AgentToolResult,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

import agentBrowserExtension from "../../extensions/agent-browser/index.js";

export const TEST_SESSION_ID = "12345678-1234-5678-9abc-def012345678";
export const DOWNLOAD_FIXTURE_CONTENT = "download contract fixture report\n";
export const DOWNLOAD_FIXTURE_FILENAME = "pi-agent-browser-wait-download-contract.txt";

export interface FixtureServer {
	baseUrl: string;
	close: () => Promise<void>;
}

function sendFixtureHtml(response: ServerResponse, html: string): void {
	response.writeHead(200, {
		"cache-control": "no-store",
		"content-type": "text/html; charset=utf-8",
	});
	response.end(html);
}

export async function startAgentBrowserContractFixtureServer(): Promise<FixtureServer> {
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/" || url.pathname === "/contract") {
			sendFixtureHtml(
				response,
				`<!doctype html>
<html lang="en">
<head>
	<title>Agent Browser Contract Fixture</title>
	<style>
		body { min-height: 2200px; }
		#drop-target { border: 2px dashed #666; margin-top: 1rem; padding: 1rem; }
		#far-target { margin-top: 1600px; }
	</style>
</head>
<body>
	<main id="main">
		<h1>Agent Browser Contract Fixture</h1>
		<p id="status">Ready for real upstream contract validation.</p>
		<a id="next-link" href="/next">Go to next fixture page</a>
		<button id="mark-ready" type="button" onclick="document.body.dataset.clicked='yes'; document.getElementById('status').textContent='Clicked';">Mark ready</button>
		<button id="double-action" type="button" ondblclick="document.getElementById('status').textContent='Double clicked';">Double action</button>
		<label for="name-input">Name</label>
		<input id="name-input" placeholder="Name input" />
		<label for="notes-input">Notes</label>
		<textarea id="notes-input"></textarea>
		<button id="focus-target" type="button" onfocus="document.body.dataset.focused='yes';">Focus target</button>
		<label><input id="agree-checkbox" type="checkbox" /> Agree to terms</label>
		<select id="flavor-select" aria-label="Flavor">
			<option value="vanilla">Vanilla</option>
			<option value="chocolate">Chocolate</option>
		</select>
		<input id="file-input" type="file" aria-label="Upload file" />
		<div id="drag-source" draggable="true" ondragstart="event.dataTransfer.setData('text/plain', 'fixture-dragged')">Drag source</div>
		<div id="drop-target" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.body.dataset.dropped=event.dataTransfer.getData('text/plain') || 'yes'; this.textContent='Dropped';">Drop target</div>
		<button id="hover-target" type="button" onmouseover="document.body.dataset.hovered='yes';">Hover target</button>
		<button id="keyboard-target" type="button" onclick="document.getElementById('name-input').focus();">Keyboard target</button>
		<div id="far-target" tabindex="0">Far scroll target</div>
	</main>
</body>
</html>`,
			);
			return;
		}

		if (url.pathname === "/next") {
			sendFixtureHtml(
				response,
				`<!doctype html>
<html lang="en">
<head><title>Next Contract Fixture</title></head>
<body><main><h1>Next Contract Fixture</h1><p>Navigation target.</p></main></body>
</html>`,
			);
			return;
		}

		if (url.pathname === "/download") {
			sendFixtureHtml(
				response,
				`<!doctype html>
<html lang="en">
<head><title>Download Contract Fixture</title></head>
<body>
	<main>
		<h1>Download Contract Fixture</h1>
		<button id="delayed-download" type="button" onclick="setTimeout(() => { window.location.href = '/download-file'; }, 1000);">Export report</button>
		<button id="delayed-anchor-download" type="button" onclick="setTimeout(() => {
			const link = document.createElement('a');
			link.href = '/download-file';
			link.download = '${DOWNLOAD_FIXTURE_FILENAME}';
			document.body.appendChild(link);
			link.click();
			link.remove();
		}, 1000);">Export report with anchor</button>
		<a id="direct-download" href="/download-file" download="${DOWNLOAD_FIXTURE_FILENAME}">Direct report</a>
	</main>
</body>
</html>`,
			);
			return;
		}

		if (url.pathname === "/download-file") {
			response.writeHead(200, {
				"cache-control": "no-store",
				"content-disposition": `attachment; filename="${DOWNLOAD_FIXTURE_FILENAME}"`,
				"content-type": "text/plain; charset=utf-8",
			});
			response.end(DOWNLOAD_FIXTURE_CONTENT);
			return;
		}

		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		response.end("not found");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address() as AddressInfo | null;
	assert.ok(address, "expected fixture server to bind to a local port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
	};
}

export function buildUserBranch(prompt = ""): unknown[] {
	return prompt.length === 0
		? []
		: [{ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } }];
}

export function createToolBranchEntry(options: { details: Record<string, unknown>; isError?: boolean }): unknown {
	return {
		type: "message",
		message: {
			isError: options.isError,
			details: options.details,
			toolName: "agent_browser",
		},
	};
}

export type AgentBrowserToolParams = {
	args?: string[];
	semanticAction?: {
		action: "check" | "click" | "fill" | "select" | "uncheck";
		locator?: "alt" | "label" | "placeholder" | "role" | "testid" | "text" | "title";
		value?: string;
		values?: string[];
		selector?: string;
		text?: string;
		role?: string;
		name?: string;
		session?: string;
	};
	job?: {
		steps: Array<{
			action: "open" | "click" | "fill" | "select" | "wait" | "assertText" | "assertUrl" | "waitForDownload" | "screenshot";
			url?: string;
			selector?: string;
			text?: string;
			value?: string;
			values?: string[];
			path?: string;
			milliseconds?: number;
		}>;
	};
	qa?: ({
		attached: true;
		expectedText?: string | string[];
		expectedSelector?: string;
		screenshotPath?: string;
		checkConsole?: boolean;
		checkErrors?: boolean;
		checkNetwork?: boolean;
	} | {
		attached?: false;
		url: string;
		expectedText?: string | string[];
		expectedSelector?: string;
		screenshotPath?: string;
		checkConsole?: boolean;
		checkErrors?: boolean;
		checkNetwork?: boolean;
	});
	sourceLookup?: {
		selector?: string;
		reactFiberId?: string;
		componentName?: string;
		includeDomHints?: boolean;
		maxWorkspaceFiles?: number;
	};
	networkSourceLookup?: {
		filter?: string;
		requestId?: string;
		session?: string;
		url?: string;
		maxWorkspaceFiles?: number;
	};
	electron?: {
		action: "list" | "launch" | "status" | "cleanup" | "probe";
		query?: string;
		maxResults?: number;
		appPath?: string;
		appName?: string;
		bundleId?: string;
		executablePath?: string;
		appArgs?: string[];
		handoff?: "connect" | "tabs" | "snapshot";
		targetType?: "page" | "webview" | "any";
		timeoutMs?: number;
		allow?: string[];
		deny?: string[];
		launchId?: string;
		all?: boolean;
	};
	sessionMode?: "auto" | "fresh";
	stdin?: string;
};

export interface AgentBrowserToolRenderContext {
	args: AgentBrowserToolParams;
	argsComplete: boolean;
	cwd: string;
	executionStarted: boolean;
	expanded: boolean;
	invalidate: () => void;
	isError: boolean;
	isPartial: boolean;
	lastComponent: Component | undefined;
	showImages: boolean;
	state: unknown;
	toolCallId: string;
}

export type RegisteredTool = {
	description: string;
	parameters: TSchema;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<unknown>;
	name: string;
	promptGuidelines: string[];
	promptSnippet: string;
	renderCall?: (args: AgentBrowserToolParams, theme: Theme, context: AgentBrowserToolRenderContext) => Component;
	renderResult?: (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: AgentBrowserToolRenderContext,
	) => Component;
};

function adaptRegisteredTool<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): RegisteredTool {
	const sourceRenderCall = tool.renderCall;
	const sourceRenderResult = tool.renderResult;

	return {
		description: tool.description,
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			type ExecuteArgs = Parameters<typeof tool.execute>;
			return tool.execute(
				toolCallId,
				params as ExecuteArgs[1],
				signal,
				onUpdate as ExecuteArgs[3],
				ctx as ExecuteArgs[4],
			);
		},
		name: tool.name,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines ?? [],
		promptSnippet: tool.promptSnippet ?? "",
		renderCall: sourceRenderCall === undefined
			? undefined
			: (args, theme, context) => {
				type RenderCallArgs = Parameters<typeof sourceRenderCall>;
				return sourceRenderCall(args as RenderCallArgs[0], theme, context as RenderCallArgs[2]);
			},
		renderResult: sourceRenderResult === undefined
			? undefined
			: (result, options, theme, context) => {
				type RenderResultArgs = Parameters<typeof sourceRenderResult>;
				return sourceRenderResult(result as RenderResultArgs[0], options, theme, context as RenderResultArgs[3]);
			},
	};
}

export function createExtensionHarness(options: {
	branch?: unknown[];
	cwd: string;
	prompt?: string;
	sessionDir?: string;
	sessionFile?: string;
}) {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	let registeredTool: RegisteredTool | undefined;

	agentBrowserExtension({
		on(event, handler) {
			const existingHandlers = handlers.get(event) ?? [];
			existingHandlers.push(handler as (...args: unknown[]) => unknown);
			handlers.set(event, existingHandlers);
		},
		registerTool(tool) {
			registeredTool = adaptRegisteredTool(tool);
		},
	} as Parameters<typeof agentBrowserExtension>[0]);

	assert.ok(registeredTool, "expected the extension to register the agent_browser tool");

	let branch = options.branch ?? buildUserBranch(options.prompt);
	const sessionDir = options.sessionDir ?? (options.sessionFile ? dirname(options.sessionFile) : undefined);
	const ctx = {
		cwd: options.cwd,
		sessionManager: {
			getBranch: () => branch,
			getSessionDir: () => sessionDir,
			getSessionFile: () => options.sessionFile,
			getSessionId: () => TEST_SESSION_ID,
		},
	} as const;

	return {
		ctx,
		handlers,
		setBranch(nextBranch: unknown[]) {
			branch = nextBranch;
		},
		tool: registeredTool,
	};
}

export async function runExtensionEvent(
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
	eventName: string,
	...args: unknown[]
): Promise<void> {
	for (const handler of handlers.get(eventName) ?? []) {
		await handler(...args);
	}
}

export async function runExtensionEventResults<T>(
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
	eventName: string,
	...args: unknown[]
): Promise<T[]> {
	const results: T[] = [];
	for (const handler of handlers.get(eventName) ?? []) {
		const result = await handler(...args);
		if (result !== undefined) {
			results.push(result as T);
		}
	}
	return results;
}

export async function executeRegisteredTool(
	tool: NonNullable<ReturnType<typeof createExtensionHarness>["tool"]>,
	ctx: ReturnType<typeof createExtensionHarness>["ctx"],
	params: unknown,
) {
	return (await tool.execute("test-tool-call", params, new AbortController().signal, undefined, ctx)) as {
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	};
}

const patchedEnvScope = new AsyncLocalStorage<boolean>();
let patchedEnvQueue: Promise<void> = Promise.resolve();

async function runWithPatchedEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(patch)) {
		previousValues.set(name, process.env[name]);
		if (value === undefined) {
			delete process.env[name];
		} else if (processPlatform === "win32" && name.toLowerCase() === "path" && previousValues.get(name)) {
			const previousPath = previousValues.get(name) ?? "";
			const posixStyleSuffix = `:${previousPath}`;
			process.env[name] = value.endsWith(posixStyleSuffix)
				? `${value.slice(0, -posixStyleSuffix.length)};${previousPath}`
				: value;
		} else {
			process.env[name] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [name, value] of previousValues) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}
}

export async function withPatchedEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	if (patchedEnvScope.getStore()) {
		return await runWithPatchedEnv(patch, run);
	}

	const queuedRun = patchedEnvQueue
		.catch(() => undefined)
		.then(() => patchedEnvScope.run(true, () => runWithPatchedEnv(patch, run)));
	patchedEnvQueue = queuedRun.then(() => undefined, () => undefined);
	return await queuedRun;
}

/** Fake script body that spawns a detached descendant inheriting stdio (stdio-linger regressions). */
export function buildStdioLingerFakeScript(options: { afterSpawnBody: string }): string {
	return `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const linger = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000); setInterval(() => undefined, 1000);"], {
	cwd: tmpdir(),
	detached: true,
	stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(process.env.PI_AGENT_BROWSER_TEST_LINGER_PID_PATH, String(linger.pid));
linger.unref();
${options.afterSpawnBody}`;
}

export async function writeFakeAgentBrowserBinary(
	tempDir: string,
	scriptBody: string,
	platform: NodeJS.Platform = processPlatform,
): Promise<string> {
	const scriptPath = join(tempDir, "agent-browser-fake.cjs");
	await writeFile(scriptPath, `${scriptBody}\n`, "utf8");

	if (platform === "win32") {
		const launcherPath = join(tempDir, "agent-browser.cmd");
		await writeFile(
			launcherPath,
			`@ECHO OFF\r\n"${nodeExecPath.replaceAll('"', '""')}" "${scriptPath.replaceAll('"', '""')}" %*\r\n`,
			"utf8",
		);
		return launcherPath;
	}

	const fakeAgentBrowserPath = join(tempDir, "agent-browser");
	await writeFile(fakeAgentBrowserPath, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
	await chmod(fakeAgentBrowserPath, 0o755);
	return fakeAgentBrowserPath;
}

export interface InvocationLogEntry {
	agentcoreApiKey?: string | null;
	apiKey?: string | null;
	args: string[];
	browserbaseApiKey?: string | null;
	browserlessApiKey?: string | null;
	browserUseApiKey?: string | null;
	event?: string;
	idleTimeout?: string | null;
	iosDevice?: string | null;
	kernelApiKey?: string | null;
	model?: string | null;
	sessionName?: string;
	socketDir?: string | null;
	stdin?: string | null;
}

export async function readInvocationLog(logPath: string): Promise<InvocationLogEntry[]> {
	try {
		const text = await readFile(logPath, "utf8");
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as InvocationLogEntry);
	} catch (error) {
		const errorWithCode = error as NodeJS.ErrnoException;
		if (errorWithCode.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

export async function readChildStdoutJsonLine<T>(child: ReturnType<typeof spawn>, timeoutMs = 15_000): Promise<T> {
	assert.ok(child.stdout, "expected child stdout pipe");
	assert.ok(child.stderr, "expected child stderr pipe");
	let stdout = "";
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	return await new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`Timed out waiting for child stdout JSON line. stdout=${stdout} stderr=${stderr}`));
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			const firstLine = stdout.split("\n").find((line) => line.trim().length > 0);
			if (!firstLine) return;
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(firstLine) as T);
			} catch (error) {
				reject(error);
			}
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`Child exited before stdout JSON line: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

export async function stopChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
	try {
		await once(child, "exit");
	} finally {
		clearTimeout(timeout);
	}
}

