/**
 * Purpose: Execute the upstream agent-browser binary for the pi-agent-browser extension.
 * Responsibilities: Spawn the agent-browser subprocess, forward parent environment variables plus wrapper overrides, stream optional stdin, bound in-memory output buffering, spill oversized stdout safely to a private temp file under a disk budget, and honor abort signals.
 * Scope: Process execution only; argument planning, output formatting, and pi tool registration live elsewhere.
 * Usage: Called by the extension tool after argument validation and session planning are complete.
 * Invariants/Assumptions: The binary name is always `agent-browser`; Windows routes through PowerShell to invoke npm launchers with escaped argv; callers handle semantic success/error interpretation.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { env as processEnv, platform as processPlatform } from "node:process";

import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, GLOBAL_VALUE_FLAGS, getFlagName } from "./argv-grammar.js";
import { openSecureTempFile, writeSecureTempChunk } from "./temp.js";

const MAX_BUFFERED_STDOUT_BYTES = 512 * 1_024;
const MAX_BUFFERED_STDERR_CHARS = 32_000;
const MAX_BUFFERED_STDOUT_TAIL_CHARS = 32_000;
const PROCESS_STDOUT_SPILL_FILE_PREFIX = "process-stdout";
const AGENT_BROWSER_SOCKET_DIR_ENV = "AGENT_BROWSER_SOCKET_DIR";
const AGENT_BROWSER_DEFAULT_TIMEOUT_ENV = "AGENT_BROWSER_DEFAULT_TIMEOUT";
const PI_AGENT_BROWSER_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS";
const DEFAULT_AGENT_BROWSER_SOCKET_DIR_PREFIX = "/tmp/piab";
export const SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS = 35_000;
const DEFAULT_AGENT_BROWSER_PROCESS_TIMEOUT_MS = 35_000;
/** Grace period after `exit` before resolving when `close` is delayed by inherited stdio handles. */
const EXIT_STDIO_GRACE_MS = 100;

export interface ProcessRunResult {
	aborted: boolean;
	exitCode: number;
	spawnError?: Error;
	stderr: string;
	stdout: string;
	stdoutSpillPath?: string;
	timedOut: boolean;
	timeoutMs?: number;
}

function appendTail(text: string, addition: string, maxChars: number): string {
	const combined = text + addition;
	return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

function quoteWindowsPowerShellArg(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

const WINDOWS_LEADING_GLOBAL_VALUE_FLAGS = new Set<string>(GLOBAL_VALUE_FLAGS);

/** Exported for unit tests that lock Windows launcher argv ordering. */
export function reorderWindowsLeadingGlobalArgs(args: string[]): string[] {
	const leadingGlobals: string[] = [];
	let index = 0;
	while (index < args.length && args[index]?.startsWith("-")) {
		const token = args[index];
		const flagName = getFlagName(token);
		leadingGlobals.push(token);
		index += 1;
		if (WINDOWS_LEADING_GLOBAL_VALUE_FLAGS.has(flagName) && !token.includes("=") && index < args.length) {
			leadingGlobals.push(args[index]);
			index += 1;
			continue;
		}
		if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(flagName) && ["true", "false"].includes(args[index] ?? "")) {
			leadingGlobals.push(args[index]);
			index += 1;
		}
	}
	if (leadingGlobals.length === 0 || index >= args.length) return args;
	return [args[index], ...leadingGlobals, ...args.slice(index + 1)];
}

function buildAgentBrowserSpawnCommand(args: string[]): { command: string; args: string[] } {
	if (processPlatform !== "win32") {
		return { command: "agent-browser", args };
	}
	const commandLine = ["&", "agent-browser", ...reorderWindowsLeadingGlobalArgs(args).map(quoteWindowsPowerShellArg)].join(" ");
	return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", commandLine] };
}

function terminateSpawnedChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (processPlatform === "win32" && child.pid) {
		const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		killer.on("error", () => undefined);
		killer.unref();
	}
	child.kill(signal);
}

/** Exported for unit tests that lock subprocess exit-code precedence. */
export function resolveSpawnedChildExitCode(input: {
	closeCode?: number | null;
	exitCode?: number | null;
	useExitFallback: boolean;
	timedOut: boolean;
	spawnError?: Error;
}): number {
	// Precedence: observed `close` code when present, then wrapper timeout (124), then
	// post-`exit` fallback when inherited stdio delays `close`, then spawn failure (127).
	if (input.closeCode !== null && input.closeCode !== undefined) {
		return input.closeCode;
	}
	if (input.timedOut) {
		return 124;
	}
	if (input.useExitFallback && input.exitCode !== null && input.exitCode !== undefined) {
		return input.exitCode;
	}
	return input.spawnError ? 127 : 0;
}

interface SpawnedChildCompletionWatcher {
	clear: () => void;
}

function watchSpawnedChildCompletion(
	child: ChildProcessWithoutNullStreams,
	options: {
		graceMs: number;
		onComplete: (exitCode: number) => void;
		getContext: () => { timedOut: boolean; spawnError?: Error };
	},
): SpawnedChildCompletionWatcher {
	let exited = false;
	let exitCode: number | null = null;
	let postExitTimer: NodeJS.Timeout | undefined;
	// `completed` suppresses duplicate exit/close callbacks; `settled` in `finish` guards async spill cleanup.
	let completed = false;

	const complete = (closeCode?: number | null) => {
		if (completed) return;
		completed = true;
		if (postExitTimer) {
			clearTimeout(postExitTimer);
			postExitTimer = undefined;
		}
		const context = options.getContext();
		options.onComplete(
			resolveSpawnedChildExitCode({
				closeCode,
				exitCode,
				useExitFallback: exited,
				timedOut: context.timedOut,
				spawnError: context.spawnError,
			}),
		);
	};

	child.once("exit", (code) => {
		exited = true;
		exitCode = code;
		postExitTimer = setTimeout(() => {
			destroySpawnedChildStreams(child);
			complete(undefined);
		}, options.graceMs);
		postExitTimer.unref?.();
	});
	child.once("close", (code) => {
		complete(code);
	});

	return {
		clear: () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
		},
	};
}

function destroySpawnedChildStreams(child: ChildProcessWithoutNullStreams): void {
	child.stdin?.destroy();
	child.stdout?.destroy();
	child.stderr?.destroy();
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) {
		return undefined;
	}
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function clampUpstreamDefaultTimeout(childEnv: NodeJS.ProcessEnv): void {
	const requestedTimeout = parsePositiveIntegerEnv(childEnv[AGENT_BROWSER_DEFAULT_TIMEOUT_ENV]);
	if (requestedTimeout === undefined || requestedTimeout > SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS) {
		childEnv[AGENT_BROWSER_DEFAULT_TIMEOUT_ENV] = String(SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS);
	}
}

export function getAgentBrowserProcessTimeoutMs(env: NodeJS.ProcessEnv = processEnv): number {
	return parsePositiveIntegerEnv(env[PI_AGENT_BROWSER_PROCESS_TIMEOUT_ENV]) ?? DEFAULT_AGENT_BROWSER_PROCESS_TIMEOUT_MS;
}

export function getAgentBrowserSocketDir(
	platform: NodeJS.Platform = processPlatform,
	uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): string | undefined {
	if (platform === "win32") {
		return undefined;
	}
	return `${DEFAULT_AGENT_BROWSER_SOCKET_DIR_PREFIX}${typeof uid === "number" ? `-${uid}` : ""}`;
}

async function ensureAgentBrowserSocketDir(socketDir: string): Promise<boolean> {
	try {
		await mkdir(socketDir, { recursive: true, mode: 0o700 });
		await chmod(socketDir, 0o700).catch(() => undefined);
		return true;
	} catch {
		return false;
	}
}

export function buildAgentBrowserProcessEnv(
	baseEnv: NodeJS.ProcessEnv = processEnv,
	overrides: NodeJS.ProcessEnv | undefined = undefined,
): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(baseEnv)) {
		if (value !== undefined) childEnv[name] = value;
	}

	for (const [name, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) {
			delete childEnv[name];
		} else {
			childEnv[name] = value;
		}
	}
	clampUpstreamDefaultTimeout(childEnv);
	return childEnv;
}

export async function runAgentBrowserProcess(options: {
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	stdin?: string;
	timeoutMs?: number;
}): Promise<ProcessRunResult> {
	const { args, cwd, env, signal, stdin } = options;
	const timeoutMs = options.timeoutMs ?? getAgentBrowserProcessTimeoutMs();
	const explicitSocketDir = env?.[AGENT_BROWSER_SOCKET_DIR_ENV];
	let effectiveEnv = explicitSocketDir === undefined ? { ...env, [AGENT_BROWSER_SOCKET_DIR_ENV]: undefined } : env;
	const requestedSocketDir = explicitSocketDir ?? getAgentBrowserSocketDir();
	if (requestedSocketDir && (await ensureAgentBrowserSocketDir(requestedSocketDir))) {
		effectiveEnv = { ...env, [AGENT_BROWSER_SOCKET_DIR_ENV]: requestedSocketDir };
	}

	return await new Promise<ProcessRunResult>((resolve) => {
		let aborted = false;
		let settled = false;
		let spawnError: Error | undefined;
		let stderr = "";
		let stdoutBuffers: Buffer[] = [];
		let stdoutBufferedBytes = 0;
		let stdoutTail = "";
		let stdoutSpillHandle: Awaited<ReturnType<typeof openSecureTempFile>>["fileHandle"] | undefined;
		let stdoutSpillPath: string | undefined;
		let pendingStdoutWrite = Promise.resolve();
		let stdoutSpillError: Error | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;
		let timedOut = false;
		let completionWatcher: SpawnedChildCompletionWatcher | undefined;

		const queueStdoutChunk = (buffer: Buffer) => {
			stdoutTail = appendTail(stdoutTail, buffer.toString("utf8"), MAX_BUFFERED_STDOUT_TAIL_CHARS);
			if (stdoutSpillError) return;
			if (!stdoutSpillPath && stdoutBufferedBytes + buffer.length <= MAX_BUFFERED_STDOUT_BYTES) {
				stdoutBuffers.push(buffer);
				stdoutBufferedBytes += buffer.length;
				return;
			}

			pendingStdoutWrite = pendingStdoutWrite
				.then(async () => {
					if (stdoutSpillError) return;
					if (!stdoutSpillHandle || !stdoutSpillPath) {
						const tempFile = await openSecureTempFile(PROCESS_STDOUT_SPILL_FILE_PREFIX, ".json");
						stdoutSpillHandle = tempFile.fileHandle;
						stdoutSpillPath = tempFile.path;
						if (stdoutBuffers.length > 0) {
							await writeSecureTempChunk({
								content: Buffer.concat(stdoutBuffers),
								fileHandle: stdoutSpillHandle,
								path: stdoutSpillPath,
							});
							stdoutBuffers = [];
							stdoutBufferedBytes = 0;
						}
					}
					await writeSecureTempChunk({ content: buffer, fileHandle: stdoutSpillHandle, path: stdoutSpillPath });
				})
				.catch((error) => {
					stdoutSpillError = error instanceof Error ? error : new Error(String(error));
				});
		};

		const removeAbortListener = () => {
			if (!signal || !abortListener) return;
			signal.removeEventListener("abort", abortListener);
			abortListener = undefined;
		};

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			void pendingStdoutWrite.finally(async () => {
				removeAbortListener();
				if (killTimer) {
					clearTimeout(killTimer);
				}
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
				}
				completionWatcher?.clear();
				if (stdoutSpillHandle) {
					await stdoutSpillHandle.close().catch(() => undefined);
				}
				if (!spawnError && stdoutSpillError) {
					spawnError = stdoutSpillError;
				}
				// Idempotent teardown: streams may already be destroyed by the post-`exit` fallback.
				destroySpawnedChildStreams(child);
				resolve({
					aborted,
					exitCode,
					spawnError,
					stderr,
					stdout: stdoutSpillPath ? stdoutTail : Buffer.concat(stdoutBuffers).toString("utf8"),
					stdoutSpillPath,
					timedOut,
					timeoutMs: timedOut ? timeoutMs : undefined,
				});
			});
		};

		const spawnCommand = buildAgentBrowserSpawnCommand(args);
		const child = spawn(spawnCommand.command, spawnCommand.args, {
			cwd,
			env: buildAgentBrowserProcessEnv(processEnv, effectiveEnv),
			stdio: ["pipe", "pipe", "pipe"],
		});

		const terminateChild = (reason: "abort" | "timeout") => {
			if (settled) return;
			if (reason === "abort") {
				aborted = true;
			} else {
				timedOut = true;
			}
			terminateSpawnedChild(child, "SIGTERM");
			killTimer = setTimeout(() => {
				terminateSpawnedChild(child, "SIGKILL");
			}, 2_000);
		};
		const recordStdinError = (error: unknown) => {
			const stdinError = error instanceof Error ? error : new Error(String(error));
			const errorCode = (stdinError as NodeJS.ErrnoException).code;
			if (errorCode === "EPIPE" || errorCode === "EOF" || errorCode === "ERR_STREAM_DESTROYED") {
				return;
			}
			if (!spawnError) {
				spawnError = stdinError;
			}
		};
		const writeChildStdin = () => {
			if (aborted || signal?.aborted) {
				child.stdin.destroy();
				return;
			}
			try {
				if (stdin) {
					child.stdin.write(stdin);
				}
				child.stdin.end();
			} catch (error) {
				recordStdinError(error);
				child.stdin.destroy();
			}
		};

		child.stdin.on("error", recordStdinError);
		child.once("error", (error) => {
			spawnError = error instanceof Error ? error : new Error(String(error));
			finish(
				resolveSpawnedChildExitCode({
					useExitFallback: false,
					timedOut,
					spawnError,
				}),
			);
		});
		completionWatcher = watchSpawnedChildCompletion(child, {
			graceMs: EXIT_STDIO_GRACE_MS,
			onComplete: finish,
			getContext: () => ({ timedOut, spawnError }),
		});
		child.stdout.on("data", (chunk: Buffer | string) => {
			queueStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr = appendTail(stderr, chunk.toString(), MAX_BUFFERED_STDERR_CHARS);
		});

		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => terminateChild("timeout"), timeoutMs);
			timeoutTimer.unref?.();
		}

		if (signal) {
			if (signal.aborted) {
				terminateChild("abort");
			} else {
				abortListener = () => terminateChild("abort");
				signal.addEventListener("abort", abortListener, { once: true });
			}
		}

		writeChildStdin();
	});
}
