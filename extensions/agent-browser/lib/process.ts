/**
 * Purpose: Execute the upstream agent-browser binary for the pi-agent-browser extension.
 * Responsibilities: Spawn the agent-browser subprocess without a shell, forward a curated environment surface, stream optional stdin, bound in-memory output buffering, spill oversized stdout safely to a private temp file under a disk budget, and honor abort signals.
 * Scope: Process execution only; argument planning, output formatting, and pi tool registration live elsewhere.
 * Usage: Called by the extension tool after argument validation and session planning are complete.
 * Invariants/Assumptions: The binary name is always `agent-browser`, the wrapper never shells out, and callers handle semantic success/error interpretation.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { env as processEnv, platform as processPlatform } from "node:process";

import { openSecureTempFile, writeSecureTempChunk } from "./temp.js";

const MAX_BUFFERED_STDOUT_BYTES = 512 * 1_024;
const MAX_BUFFERED_STDERR_CHARS = 32_000;
const MAX_BUFFERED_STDOUT_TAIL_CHARS = 32_000;
const PROCESS_STDOUT_SPILL_FILE_PREFIX = "process-stdout";
const AGENT_BROWSER_SOCKET_DIR_ENV = "AGENT_BROWSER_SOCKET_DIR";
const AGENT_BROWSER_DEFAULT_TIMEOUT_ENV = "AGENT_BROWSER_DEFAULT_TIMEOUT";
const PI_AGENT_BROWSER_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS";
const DEFAULT_AGENT_BROWSER_SOCKET_DIR_PREFIX = "/tmp/piab";
export const SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS = 25_000;
const DEFAULT_AGENT_BROWSER_PROCESS_TIMEOUT_MS = 28_000;
/** Grace period after `exit` before resolving when `close` is delayed by inherited stdio handles. */
const EXIT_STDIO_GRACE_MS = 100;
const httpProxyEnvName = "http_proxy";
const httpsProxyEnvName = "https_proxy";
const allProxyEnvName = "all_proxy";
const noProxyEnvName = "no_proxy";
const INHERITED_ENV_NAMES = new Set([
	"ALL_PROXY",
	"APPDATA",
	"CI",
	"COLORTERM",
	"COMSPEC",
	"DBUS_SESSION_BUS_ADDRESS",
	"DISPLAY",
	"FORCE_COLOR",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOCALAPPDATA",
	"LOGNAME",
	"NO_COLOR",
	"NO_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"OS",
	"PATH",
	"PATHEXT",
	"PWD",
	"SHELL",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"TZ",
	"USER",
	"USERNAME",
	"USERPROFILE",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	httpProxyEnvName,
	httpsProxyEnvName,
	allProxyEnvName,
	noProxyEnvName,
]);
const INHERITED_ENV_PREFIXES = [
	"AGENT_BROWSER_",
	"AGENTCORE_",
	"AI_GATEWAY_",
	"BROWSERBASE_",
	"BROWSERLESS_",
	"BROWSER_USE_",
	"KERNEL_",
	"XDG_",
] as const;

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

function resolveSpawnedChildExitCode(input: {
	closeCode?: number | null;
	exitCode?: number | null;
	useExitFallback: boolean;
	timedOut: boolean;
	spawnError?: Error;
}): number {
	return (
		input.closeCode ??
		(input.useExitFallback ? input.exitCode : undefined) ??
		(input.timedOut ? 124 : input.spawnError ? 127 : 0)
	);
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
		if (
			value !== undefined &&
			(INHERITED_ENV_NAMES.has(name) || INHERITED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
		) {
			childEnv[name] = value;
		}
	}

	if (!overrides) {
		clampUpstreamDefaultTimeout(childEnv);
		return childEnv;
	}

	for (const [name, value] of Object.entries(overrides)) {
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

		const child = spawn("agent-browser", args, {
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
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 2_000);
		};
		const recordStdinError = (error: unknown) => {
			const stdinError = error instanceof Error ? error : new Error(String(error));
			const errorCode = (stdinError as NodeJS.ErrnoException).code;
			if (errorCode === "EPIPE" || errorCode === "ERR_STREAM_DESTROYED") {
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
			finish(127);
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
