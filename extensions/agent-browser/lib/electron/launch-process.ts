import { spawn, type ChildProcess } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord } from "../parsing.js";
import { stringifyUnknown } from "../results/text.js";
import { waitForElectronPoll } from "./launch-monitor.js";

// ponytail: bound failure reads, not lifetime log growth; noisy long-lived apps need rotation if observed.
const OUTPUT_TAIL_BYTES = 4096;

interface CapturedStream {
	readonly tail?: string;
	readonly truncated?: boolean;
	readonly error?: string;
}

interface OutputEvidence {
	readonly stdoutTail?: string;
	readonly stdoutTruncated?: boolean;
	readonly stdoutError?: string;
	readonly stderrTail?: string;
	readonly stderrTruncated?: boolean;
	readonly stderrError?: string;
}

async function closeOutputHandle(file: FileHandle): Promise<string | undefined> {
	try {
		await file.close();
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : stringifyUnknown(error);
	}
}

async function readOutputTail(path: string): Promise<CapturedStream> {
	let file: FileHandle | undefined;
	let result: CapturedStream;
	try {
		file = await open(path, "r");
		const { size } = await file.stat();
		const buffer = Buffer.alloc(Math.min(size, OUTPUT_TAIL_BYTES));
		const { bytesRead } = await file.read(
			buffer,
			0,
			buffer.length,
			Math.max(0, size - buffer.length),
		);
		result = {
			tail: buffer.subarray(0, bytesRead).toString("utf8"),
			truncated: size > buffer.length,
		};
	} catch (error) {
		result = { error: error instanceof Error ? error.message : stringifyUnknown(error) };
	}
	if (file !== undefined) {
		const closeError = await closeOutputHandle(file);
		if (closeError !== undefined) {
			result = {
				...result,
				error: [result.error, `Output reader close failed: ${closeError}`]
					.filter((entry) => entry !== undefined && entry.length > 0)
					.join("; "),
			};
		}
	}
	return result;
}

function streamLines(stream: "stdout" | "stderr", capture: CapturedStream): string[] {
	const lines: string[] = [];
	if (capture.tail !== undefined) {
		const truncated = capture.truncated === true ? ` (last ${OUTPUT_TAIL_BYTES} bytes)` : "";
		lines.push(`App ${stream}${truncated}: ${capture.tail.length > 0 ? capture.tail : "(empty)"}`);
	}
	if (capture.error !== undefined && capture.error.length > 0) {
		lines.push(`App ${stream} capture error: ${capture.error}`);
	}
	return lines;
}

/** Owns child listeners and file handles from spawn through failed-launch termination. */
export class ElectronLaunchProcess {
	private process: ChildProcess | undefined;
	private spawnFailure: Error | undefined;
	private exitedCode: number | null = null;
	private exitedSignal: NodeJS.Signals | null = null;
	private capturedOutput = false;
	private outputCloseError: string | undefined;

	constructor(private readonly userDataDir: string) {}

	get child(): ChildProcess | undefined {
		return this.process;
	}
	get spawnError(): Error | undefined {
		return this.spawnFailure;
	}
	get exitCode(): number | null {
		return this.exitedCode;
	}
	get exitSignal(): NodeJS.Signals | null {
		return this.exitedSignal;
	}
	get outputCaptured(): boolean {
		return this.capturedOutput;
	}
	get cleanupError(): string | undefined {
		return this.outputCloseError;
	}

	readonly childExit = (): {
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
	} => ({ code: this.exitedCode, signal: this.exitedSignal });
	readonly childSpawnError = (): Error | undefined => this.spawnFailure;
	private readonly onError = (error: Error): void => {
		this.spawnFailure = error;
	};
	private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		this.exitedCode = code;
		this.exitedSignal = signal;
	};

	async spawn(
		executablePath: string,
		args: readonly string[],
		signal?: AbortSignal,
	): Promise<void> {
		const handles: FileHandle[] = [];
		try {
			// Open in native stdout/stderr order; a partial open still owns its first handle.
			handles.push(await open(join(this.userDataDir, "stdout.log"), "wx", 0o600));
			handles.push(await open(join(this.userDataDir, "stderr.log"), "wx", 0o600));
			signal?.throwIfAborted();
			this.process = spawn(executablePath, args, {
				cwd: dirname(executablePath),
				detached: process.platform !== "win32",
				stdio: ["ignore", handles[0].fd, handles[1].fd],
			});
			this.capturedOutput = true;
			this.process.once("error", this.onError);
			this.process.once("exit", this.onExit);
			this.process.unref();
		} catch (error) {
			this.spawnFailure = error instanceof Error ? error : new Error(stringifyUnknown(error));
		} finally {
			const errors = await Promise.all(handles.map(closeOutputHandle));
			const messages = errors
				.filter((error) => error !== undefined)
				.map((error) => `Output handle close failed: ${error}`);
			this.outputCloseError = messages.length > 0 ? messages.join("; ") : undefined;
		}
	}

	pidAlive(): boolean | undefined {
		const child = this.process;
		if (child?.pid === undefined || child.pid === 0) {
			return undefined;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			return false;
		}
		try {
			process.kill(child.pid, 0);
			return true;
		} catch (error) {
			return isRecord(error) && error.code === "EPERM";
		}
	}

	/** Waits for exit until deadlineMs, a performance.now() timestamp unaffected by wall-clock steps. */
	private async waitForExit(deadlineMs: number): Promise<boolean> {
		const child = this.process;
		if (child === undefined) {
			return true;
		}
		while (performance.now() <= deadlineMs) {
			if (child.exitCode !== null || child.signalCode !== null) {
				return true;
			}
			// Observe exit between sleeps; simultaneous waits cannot establish the grace window.
			// oxlint-disable-next-line no-await-in-loop
			await waitForElectronPoll(50);
		}
		return child.exitCode !== null || child.signalCode !== null;
	}

	private signalChild(signal: NodeJS.Signals): string | undefined {
		try {
			this.process?.kill(signal);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : stringifyUnknown(error);
		}
	}

	async terminate(): Promise<string | undefined> {
		const child = this.process;
		if (
			child?.pid === undefined ||
			child.pid === 0 ||
			child.exitCode !== null ||
			child.signalCode !== null
		) {
			return undefined;
		}
		const terminateError = this.signalChild("SIGTERM");
		if (terminateError !== undefined) {
			return terminateError;
		}
		if (await this.waitForExit(performance.now() + 1_000)) {
			return undefined;
		}
		const killError = this.signalChild("SIGKILL");
		if (killError !== undefined) {
			return killError;
		}
		if (await this.waitForExit(performance.now() + 1_000)) {
			return undefined;
		}
		return `PID ${child.pid} remained alive after failed Electron launch cleanup.`;
	}

	async readOutput(): Promise<{
		readonly evidence: OutputEvidence;
		readonly lines: readonly string[];
	}> {
		if (!this.capturedOutput) {
			return { evidence: {}, lines: [] };
		}
		const [stdout, stderr] = await Promise.all([
			readOutputTail(join(this.userDataDir, "stdout.log")),
			readOutputTail(join(this.userDataDir, "stderr.log")),
		]);
		return {
			evidence: {
				stdoutTail: stdout.tail,
				stdoutTruncated: stdout.truncated,
				stdoutError: stdout.error,
				stderrTail: stderr.tail,
				stderrTruncated: stderr.truncated,
				stderrError: stderr.error,
			},
			lines: [...streamLines("stdout", stdout), ...streamLines("stderr", stderr)],
		};
	}
}
