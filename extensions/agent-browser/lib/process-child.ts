import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { platform as processPlatform } from "node:process";
import { constants } from "node:os";
import { spawn as crossSpawn } from "cross-spawn";
import { appendProcessOutputTail, ProcessStdout } from "./process-stdout.js";
import { getErrorCode, normalizeProcessError } from "./process-errors.js";

const MAX_BUFFERED_STDERR_CHARS = 32_000;
const EXIT_STDIO_GRACE_MS = 100;
export interface ProcessRunResult {
	readonly aborted: boolean;
	/** True once the agent-browser command, not merely the Windows shell, has started. */
	readonly agentBrowserStarted: boolean;
	readonly exitCode: number;
	readonly exitSignal?: NodeJS.Signals;
	readonly spawnError?: Error;
	readonly stderr: string;
	readonly stdout: string;
	readonly stdoutSpillPath?: string;
	readonly timedOut: boolean;
	readonly timeoutMs?: number;
}
export interface BrowserChildOptions {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly stockLauncher?: string;
	readonly signal?: AbortSignal;
	readonly stdin?: string;
	readonly timeoutMs: number;
	readonly deadlineExpired: () => boolean;
	readonly policyError: () => string | undefined;
	readonly onStarted: () => void;
}

async function terminateSpawnedChild(
	child: ChildProcessWithoutNullStreams,
	signal: NodeJS.Signals,
): Promise<void> {
	if (processPlatform === "win32" && child.pid !== undefined && child.pid !== 0) {
		// Observe taskkill before completing; keep the shell alive while traversing descendants.
		const killed = await new Promise<boolean>((resolve) => {
			const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
			killer.once("error", () => resolve(false));
			killer.once("close", (code) => resolve(code === 0));
		});
		if (killed) {
			return;
		}
	}
	child.kill(signal);
}

export function resolveSpawnedChildExitCode(input: {
	readonly closeCode?: number | null;
	readonly exitCode?: number | null;
	readonly exitSignal?: NodeJS.Signals | null;
	readonly useExitFallback: boolean;
	readonly timedOut: boolean;
	readonly spawnError?: Error;
}): number {
	// Close -> wrapper timeout -> post-exit fallback -> spawn failure.
	if (input.closeCode !== null && input.closeCode !== undefined) {
		return input.closeCode;
	}
	if (input.timedOut) {
		return 124;
	}
	if (input.useExitFallback && input.exitCode !== null && input.exitCode !== undefined) {
		return input.exitCode;
	}
	if (input.exitSignal) {
		return 128 + constants.signals[input.exitSignal];
	}
	return input.spawnError ? 127 : 0;
}

function destroySpawnedChildStreams(child: ChildProcessWithoutNullStreams): void {
	child.stdin.destroy();
	child.stdout.destroy();
	child.stderr.destroy();
}

class ChildCompletion {
	private exited = false;
	private exitCode: number | null = null;
	private exitSignal: NodeJS.Signals | null = null;
	private timer: NodeJS.Timeout | undefined;
	private completed = false;
	constructor(
		child: ChildProcessWithoutNullStreams,
		private readonly complete: (exitCode: number, exitSignal?: NodeJS.Signals) => void,
		private readonly context: () => { readonly timedOut: boolean; readonly spawnError?: Error },
	) {
		child.once("exit", (code, signal) => {
			this.exited = true;
			this.exitCode = code;
			this.exitSignal = signal;
			this.timer = setTimeout(() => {
				destroySpawnedChildStreams(child);
				this.finish();
			}, EXIT_STDIO_GRACE_MS);
			this.timer.unref();
		});
		child.once("close", (code, signal) => {
			this.exitSignal = signal ?? this.exitSignal;
			this.finish(code);
		});
	}
	private finish(closeCode?: number | null): void {
		if (this.completed) {
			return;
		}
		this.completed = true;
		this.clear();
		const context = this.context();
		this.complete(
			resolveSpawnedChildExitCode({
				closeCode,
				exitCode: this.exitCode,
				exitSignal: this.exitSignal,
				useExitFallback: this.exited,
				timedOut: context.timedOut,
				spawnError: context.spawnError,
			}),
			this.exitSignal ?? undefined,
		);
	}
	clear(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}

class BrowserChild {
	private aborted = false;
	private agentBrowserStarted = false;
	private settled = false;
	private spawnError: Error | undefined;
	private exitSignal: NodeJS.Signals | undefined;
	private stderr = "";
	private readonly stdout = new ProcessStdout();
	private pendingTermination: Promise<void> | undefined;
	private killTimer: NodeJS.Timeout | undefined;
	private timeoutTimer: NodeJS.Timeout | undefined;
	private abortListener: (() => void) | undefined;
	private timedOut = false;
	private completion: ChildCompletion | undefined;
	private readonly child: ChildProcessWithoutNullStreams;
	constructor(
		private readonly options: BrowserChildOptions,
		private readonly resolve: (result: ProcessRunResult) => void,
	) {
		const spawnBrowser =
			processPlatform === "win32" &&
			(options.stockLauncher === undefined || options.stockLauncher.length === 0)
				? crossSpawn
				: spawn;
		this.child = spawnBrowser(options.stockLauncher ?? "agent-browser", options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	start(): void {
		this.observe();
		this.watchBudget();
		this.writeStdin();
	}
	private started(): void {
		this.agentBrowserStarted = true;
		this.options.onStarted();
	}
	private observe(): void {
		const child = this.child;
		if (processPlatform !== "win32") {
			child.once("spawn", () => {
				this.started();
			});
		}
		child.stdin.on("error", (error: unknown) => {
			this.recordStdinError(error);
		});
		child.once("error", (error: Error) => {
			this.spawnError = error;
			this.finish(
				resolveSpawnedChildExitCode({
					useExitFallback: false,
					timedOut: this.timedOut,
					spawnError: this.spawnError,
				}),
			);
		});
		this.completion = new ChildCompletion(
			child,
			(code, signal) => {
				this.finish(code, signal);
			},
			() => ({ timedOut: this.timedOut, spawnError: this.spawnError }),
		);
		child.stdout.on("data", (chunk: Buffer | string) => {
			this.stdout.queue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			this.stderr = appendProcessOutputTail(
				this.stderr,
				chunk.toString(),
				MAX_BUFFERED_STDERR_CHARS,
			);
		});
	}
	private watchBudget(): void {
		if (this.options.timeoutMs > 0) {
			this.timeoutTimer = setTimeout(() => {
				this.terminate("timeout");
			}, this.options.timeoutMs);
			this.timeoutTimer.unref();
		}
		const signal = this.options.signal;
		if (signal) {
			this.abortListener = () => {
				this.terminate(this.options.deadlineExpired() ? "timeout" : "abort");
			};
			signal.addEventListener("abort", this.abortListener, { once: true });
			if (signal.aborted) {
				this.abortListener();
			}
		}
	}
	private terminate(reason: "abort" | "timeout"): void {
		if (this.settled) {
			return;
		}
		if (reason === "abort") {
			this.aborted = true;
		} else {
			this.timedOut = true;
		}
		if (this.pendingTermination) {
			return;
		}
		this.pendingTermination = terminateSpawnedChild(this.child, "SIGTERM");
		// Windows taskkill already forces the tree; don't remove its root concurrently.
		if (processPlatform !== "win32") {
			this.killTimer = setTimeout(() => {
				this.pendingTermination = terminateSpawnedChild(this.child, "SIGKILL");
			}, 2_000);
		}
	}
	private recordStdinError(error: unknown): void {
		const stdinError = normalizeProcessError(error);
		const code = getErrorCode(stdinError);
		if (code === "EPIPE" || code === "EOF" || code === "ERR_STREAM_DESTROYED") {
			return;
		}
		this.spawnError ??= stdinError;
	}
	private writeStdin(): void {
		if (this.aborted || this.options.signal?.aborted === true) {
			this.child.stdin.destroy();
			return;
		}
		try {
			if (this.options.stdin !== undefined && this.options.stdin.length > 0) {
				this.child.stdin.write(this.options.stdin);
			}
			this.child.stdin.end();
		} catch (error) {
			this.recordStdinError(error);
			this.child.stdin.destroy();
		}
	}
	private finish(exitCode: number, exitSignal?: NodeJS.Signals): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.exitSignal = exitSignal;
		if (this.abortListener) {
			this.options.signal?.removeEventListener("abort", this.abortListener);
			this.abortListener = undefined;
		}
		if (this.killTimer) {
			clearTimeout(this.killTimer);
		}
		if (this.timeoutTimer) {
			clearTimeout(this.timeoutTimer);
		}
		this.completion?.clear();
		// The completion path owns spill/termination rejection and always settles the outer operation.
		this.collectResult(exitCode)
			.then(this.resolve)
			.catch((error: unknown) => {
				this.spawnError ??= normalizeProcessError(error);
				destroySpawnedChildStreams(this.child);
				this.resolve(this.result(exitCode, ""));
			});
	}
	private async collectResult(exitCode: number): Promise<ProcessRunResult> {
		await this.stdout.drain();
		await this.pendingTermination;
		const output = await this.stdout.finish();
		if (processPlatform === "win32" && !this.spawnError) {
			this.started();
		}
		this.spawnError ??= output.error;
		destroySpawnedChildStreams(this.child);
		return this.result(exitCode, output.stdout, output.stdoutSpillPath);
	}
	private result(exitCode: number, stdout: string, stdoutSpillPath?: string): ProcessRunResult {
		return {
			aborted: this.aborted,
			agentBrowserStarted: this.agentBrowserStarted,
			exitCode,
			exitSignal: this.exitSignal,
			spawnError: this.spawnError,
			stderr: this.stderr,
			stdout,
			stdoutSpillPath,
			timedOut: this.timedOut,
			timeoutMs: this.timedOut ? this.options.timeoutMs : undefined,
		};
	}
}

export function runBrowserChild(options: BrowserChildOptions): Promise<ProcessRunResult> {
	return new Promise((resolve) => {
		const error = options.policyError();
		if (error !== undefined && error.length > 0) {
			resolve({
				aborted: false,
				agentBrowserStarted: false,
				exitCode: 1,
				spawnError: new Error(error),
				stderr: "",
				stdout: "",
				timedOut: false,
			});
			return;
		}
		const child = new BrowserChild(options, resolve);
		child.start();
	});
}
