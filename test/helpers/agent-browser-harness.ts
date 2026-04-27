/**
 * Purpose: Provide shared test harness utilities for the pi-agent-browser extension test suites.
 * Responsibilities: Build fake pi extension contexts, run registered extension events/tools, patch process env safely, create fake agent-browser binaries, read invocation logs, and manage child-process fixtures.
 * Scope: Test-only utilities for `test/agent-browser.*.test.ts`; production code must not import this module.
 * Usage: Import focused helpers from `./helpers/agent-browser-harness.js` inside Node test-runner suites.
 * Invariants/Assumptions: Helpers preserve caller-owned cleanup responsibilities and restore patched environment variables after each run.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import agentBrowserExtension from "../../extensions/agent-browser/index.js";

export const TEST_SESSION_ID = "12345678-1234-5678-9abc-def012345678";

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
<head><title>Agent Browser Contract Fixture</title></head>
<body>
	<main id="main">
		<h1>Agent Browser Contract Fixture</h1>
		<p id="status">Ready for real upstream contract validation.</p>
		<a id="next-link" href="/next">Go to next fixture page</a>
		<button id="mark-ready" type="button" onclick="document.body.dataset.clicked='yes'; document.getElementById('status').textContent='Clicked';">Mark ready</button>
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

export type RegisteredTool = {
	description: string;
	execute: (
		toolCallId: string,
		params: { args: string[]; sessionMode?: "auto" | "fresh"; stdin?: string },
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<unknown>;
	name: string;
	promptGuidelines: string[];
	promptSnippet: string;
};

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
			registeredTool = tool as unknown as RegisteredTool;
		},
	} as Parameters<typeof agentBrowserExtension>[0]);

	assert.ok(registeredTool, "expected the extension to register the agent_browser tool");

	const branch = options.branch ?? buildUserBranch(options.prompt);
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

	return { ctx, handlers, tool: registeredTool };
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
	params: { args: string[]; sessionMode?: "auto" | "fresh"; stdin?: string },
) {
	return (await tool.execute("test-tool-call", params, new AbortController().signal, undefined, ctx)) as {
		content: Array<{ type: string; text?: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	};
}

export async function withPatchedEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(patch)) {
		previousValues.set(name, process.env[name]);
		if (value === undefined) {
			delete process.env[name];
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

export async function writeFakeAgentBrowserBinary(tempDir: string, scriptBody: string): Promise<string> {
	const fakeAgentBrowserPath = join(tempDir, "agent-browser");
	await writeFile(fakeAgentBrowserPath, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
	await chmod(fakeAgentBrowserPath, 0o755);
	return fakeAgentBrowserPath;
}

export interface InvocationLogEntry {
	args: string[];
	event?: string;
	idleTimeout?: string | null;
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

export async function readChildStdoutJsonLine<T>(child: ReturnType<typeof spawn>, timeoutMs = 5_000): Promise<T> {
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

