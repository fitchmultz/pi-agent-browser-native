import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { redactSensitiveText } from "../runtime.js";
import type { AgentBrowserFailureCategory } from "../results/contracts.js";
import type {
	AgentBrowserScriptBrowserEnvelope,
	AgentBrowserScriptRunResult,
	AgentBrowserScriptStepSummary,
	RunAgentBrowserScriptOptions,
} from "./script-types.js";
import { validateAgentBrowserScriptBrowserParams } from "./script-validation.js";
import {
	describeScriptError,
	isScriptChildMessage,
	normalizeBrowserEnvelope,
	rejectedCallEnvelope,
	SCRIPT_FINAL_OUTPUT_MAX_BYTES,
	SCRIPT_IPC_CUMULATIVE_MAX_BYTES,
	SCRIPT_IPC_MESSAGE_MAX_BYTES,
	SCRIPT_MAX_CALLS,
	type ScriptChildMessage,
	type ScriptParentMessage,
} from "./script-protocol.js";

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
}

function terminateChild(child: ChildProcessWithoutNullStreams): NodeJS.Timeout {
	child.stdin.destroy();
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
	}
	return setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}, 250);
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		promise.catch(() => {
			// Dispatch failures are returned as observations; this wait only bounds child exit.
		}),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		}),
	]);
	if (timer !== undefined) {
		clearTimeout(timer);
	}
}

function emissionData(emissions: readonly unknown[]): unknown {
	if (emissions.length === 0) {
		return undefined;
	}
	return emissions.length === 1 ? emissions[0] : emissions;
}

function serializeFinalOutput(value: unknown): string | undefined {
	if (value === undefined) {
		return;
	}
	return JSON.stringify(value);
}

// One owner for child events, ordered dispatch, abort, and final reaping.
class ScriptChildRun {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly childExit: Promise<void>;
	private readonly resultPromise: Promise<AgentBrowserScriptRunResult>;
	private resolveResult!: (result: AgentBrowserScriptRunResult) => void;
	private stdoutBuffer = Buffer.alloc(0);
	private stderrBytes = 0;
	private cumulativeBytes = 0;
	private callCount = 0;
	private rejectedCallCount = 0;
	private ready = false;
	private stopping = false;
	private activeCallController: AbortController | undefined;
	private readonly emissions: unknown[] = [];
	private readonly steps: AgentBrowserScriptStepSummary[] = [];
	private readonly failures: AgentBrowserScriptBrowserEnvelope[] = [];
	private readonly messages: ScriptChildMessage[] = [];
	private draining = false;
	private drainPromise = Promise.resolve();
	private timeout: NodeJS.Timeout | undefined;

	constructor(
		private readonly options: RunAgentBrowserScriptOptions,
		nodePath: string,
		workerPath: string,
	) {
		this.child = spawn(
			nodePath,
			[
				"--permission",
				"--max-old-space-size=64",
				workerPath,
				String(SCRIPT_IPC_MESSAGE_MAX_BYTES),
				String(SCRIPT_IPC_CUMULATIVE_MAX_BYTES),
			],
			{ env: {}, stdio: ["pipe", "pipe", "pipe"] },
		);
		this.child.stdin.on("error", () => {
			// The write callback and child lifecycle report pipe failure; consume the stream event.
		});
		this.resultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
		this.childExit = waitForChildExit(this.child);
	}

	run(timeoutMs: number): Promise<AgentBrowserScriptRunResult> {
		this.options.signal?.addEventListener("abort", this.abortListener, { once: true });
		this.timeout = setTimeout(() => {
			this.failFromEvent(`Script execution timed out after ${timeoutMs}ms.`, "timeout", {
				timedOut: true,
			});
		}, timeoutMs);
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.receiveStdout(chunk);
		});
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderrBytes += chunk.length;
			if (this.stderrBytes > SCRIPT_IPC_MESSAGE_MAX_BYTES && !this.stopping) {
				this.failFromEvent("Sandbox stderr limit exceeded.", "upstream-error");
			}
		});
		this.child.once("error", () => {
			if (!this.stopping) {
				this.failFromEvent("Unable to start the script sandbox.", "upstream-error");
			}
		});
		this.child.once("exit", () => {
			if (!this.stopping) {
				this.failFromEvent("Script sandbox exited before completion.", "upstream-error");
			}
		});
		return this.resultPromise;
	}

	private readonly abortListener = (): void => {
		const timedOut =
			this.options.signal?.reason instanceof Error &&
			this.options.signal.reason.name === "TimeoutError";
		this.failFromEvent(
			timedOut ? "Browser code deadline exceeded." : "Browser code was aborted.",
			timedOut ? "timeout" : "aborted",
			timedOut ? { timedOut: true } : { aborted: true },
		);
	};

	private result(): AgentBrowserScriptRunResult {
		return {
			callCount: this.callCount,
			emitCount: this.emissions.length,
			failures: this.failures,
			ok: true,
			rejectedCallCount: this.rejectedCallCount,
			steps: this.steps,
		};
	}

	private async send(message: ScriptParentMessage): Promise<void> {
		const line = `${JSON.stringify(message)}\n`;
		this.countBytes(Buffer.byteLength(line, "utf8"));
		await new Promise<void>((resolve, reject) => {
			this.child.stdin.write(line, (error) => {
				if (error !== undefined && error !== null) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	private countBytes(bytes: number): void {
		if (
			bytes > SCRIPT_IPC_MESSAGE_MAX_BYTES ||
			this.cumulativeBytes + bytes > SCRIPT_IPC_CUMULATIVE_MAX_BYTES
		) {
			throw new Error("Script IPC limit exceeded.");
		}
		this.cumulativeBytes += bytes;
	}

	private async finish(result: AgentBrowserScriptRunResult, waitForDrain: boolean): Promise<void> {
		if (this.stopping) {
			return;
		}
		this.stopping = true;
		if (this.timeout !== undefined) {
			clearTimeout(this.timeout);
		}
		this.options.signal?.removeEventListener("abort", this.abortListener);
		this.activeCallController?.abort(
			result.timedOut === true
				? new DOMException("Browser code deadline exceeded.", "TimeoutError")
				: this.options.signal?.reason,
		);
		const killTimer = terminateChild(this.child);
		try {
			// The caller holds the browser lease until dispatch actually settles.
			if (waitForDrain) {
				await this.drainPromise;
			}
			await settleWithin(this.childExit, 1_000);
		} finally {
			clearTimeout(killTimer);
		}
		this.resolveResult(result);
	}

	private fail(
		error: string,
		failureCategory: AgentBrowserFailureCategory,
		flags: { readonly aborted?: boolean; readonly timedOut?: boolean } = {},
		waitForDrain = false,
	): Promise<void> {
		const result = this.result();
		return this.finish(
			{
				...result,
				...flags,
				...(this.emissions.length > 0 ? { data: emissionData(this.emissions) } : {}),
				error,
				failureCategory,
				ok: false,
			},
			waitForDrain,
		);
	}

	private failFromEvent(
		message: string,
		category: AgentBrowserFailureCategory,
		flags: { readonly aborted?: boolean; readonly timedOut?: boolean } = {},
	): void {
		this.fail(message, category, flags, true).catch((failure: unknown) => {
			// This event-owned shutdown must settle the public result even if reaping fails.
			this.resolveResult({
				...this.result(),
				...flags,
				ok: false,
				failureCategory: category,
				error: `${message} ${failure instanceof Error ? failure.message : "Sandbox cleanup failed."}`,
			});
		});
	}

	private async drainMessages(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			while (!this.stopping && this.messages.length > 0) {
				const message = this.messages.shift();
				if (message === undefined) {
					break;
				}
				// Every reply/emit depends on the preceding message and browser dispatch.
				await this.handleMessage(message);
			}
		} finally {
			this.draining = false;
			if (!this.stopping && this.messages.length > 0) {
				this.scheduleDrain();
			}
		}
	}

	private async handleMessage(message: ScriptChildMessage): Promise<void> {
		if (message.type === "ready") {
			if (this.ready) {
				await this.fail("Sandbox sent a duplicate ready message.", "upstream-error");
				return;
			}
			this.ready = true;
			try {
				await this.send({ code: this.options.code, type: "start" });
			} catch {
				await this.fail("Unable to start the script sandbox.", "upstream-error");
			}
			return;
		}
		if (!this.ready) {
			await this.fail("Sandbox sent a message before it was ready.", "upstream-error");
			return;
		}
		switch (message.type) {
			case "emit":
				if (!Object.hasOwn(message, "value")) {
					await this.fail(
						"emit(value) requires a JSON-serializable value; undefined and functions are not supported.",
						"validation-error",
					);
				} else {
					this.emissions.push(message.value);
				}
				return;
			case "image":
				await this.emitImage(message.value);
				return;
			case "complete":
				await this.complete(message);
				return;
			case "call":
				await this.browserCall(message);
				return;
		}
	}

	private async emitImage(value: unknown): Promise<void> {
		try {
			if (this.options.emitImage === undefined) {
				throw new Error("Image emission is unavailable.");
			}
			await this.options.emitImage(value);
		} catch (error) {
			await this.fail(
				error instanceof Error ? error.message : "Invalid image handle.",
				"validation-error",
			);
		}
	}

	private async complete(
		message: Extract<ScriptChildMessage, { type: "complete" }>,
	): Promise<void> {
		if (message.error !== undefined) {
			await this.fail(describeScriptError(message.error), "script-error");
			return;
		}
		let data = emissionData(this.emissions);
		if (this.emissions.length === 0 && message.hasValue === true) {
			data = message.value;
		}
		let serialized: string | undefined;
		try {
			serialized = serializeFinalOutput(data);
		} catch {
			await this.fail("Final script output must be JSON-serializable.", "validation-error");
			return;
		}
		if (
			serialized !== undefined &&
			Buffer.byteLength(serialized, "utf8") > SCRIPT_FINAL_OUTPUT_MAX_BYTES
		) {
			await this.fail(
				`Final script output exceeds ${SCRIPT_FINAL_OUTPUT_MAX_BYTES} bytes.`,
				"validation-error",
			);
			return;
		}
		await this.finish({ ...this.result(), data }, false);
	}

	private async dispatch(params: unknown): Promise<AgentBrowserScriptBrowserEnvelope> {
		const validated = validateAgentBrowserScriptBrowserParams(params);
		if (validated.params === undefined) {
			this.rejectedCallCount += 1;
			return rejectedCallEnvelope(validated.error ?? "Invalid script browser call.");
		}
		this.activeCallController = new AbortController();
		try {
			return normalizeBrowserEnvelope(
				await this.options.dispatch(validated.params, this.activeCallController.signal),
			);
		} catch (error) {
			return rejectedCallEnvelope(
				redactSensitiveText(
					error instanceof Error
						? error.message
						: "The browser executor failed while dispatching this call.",
				),
			);
		} finally {
			this.activeCallController = undefined;
		}
	}

	private async browserCall(message: Extract<ScriptChildMessage, { type: "call" }>): Promise<void> {
		this.callCount += 1;
		if (this.callCount > SCRIPT_MAX_CALLS) {
			await this.fail(
				`Script browser call limit exceeded (${SCRIPT_MAX_CALLS}).`,
				"validation-error",
			);
			return;
		}
		const envelope = await this.dispatch(message.params);
		this.steps.push({
			failureCategory: envelope.failureCategory,
			index: this.callCount - 1,
			ok: envelope.success,
			resultCategory: envelope.resultCategory,
			successCategory: envelope.successCategory,
			summary:
				envelope.summary ??
				(typeof envelope.error === "string" ? envelope.error : "Browser call completed."),
		});
		if (!envelope.success) {
			this.failures.push({ ...envelope, index: this.callCount - 1 });
		}
		if (this.stopping) {
			return;
		}
		try {
			await this.send({ envelope, id: message.id, type: "response" });
		} catch {
			await this.fail(
				"Unable to return a browser result within the code IPC limit. Narrow the native extraction or use agent_browser with outputPath; already-dispatched effects are not rolled back.",
				"upstream-error",
			);
		}
	}

	private scheduleDrain(): void {
		if (this.draining || this.stopping) {
			return;
		}
		this.drainPromise = this.drainMessages().catch((error: unknown) => {
			// Unexpected drain failures still go through the same child termination owner.
			return this.fail(
				error instanceof Error ? error.message : "Sandbox message dispatch failed.",
				"upstream-error",
			);
		});
	}

	private receiveStdout(chunk: Buffer): void {
		if (this.stopping) {
			return;
		}
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
		if (this.stdoutBuffer.length > SCRIPT_IPC_MESSAGE_MAX_BYTES) {
			this.failFromEvent("Script IPC message limit exceeded.", "validation-error");
			return;
		}
		for (;;) {
			const newline = this.stdoutBuffer.indexOf(10);
			if (newline < 0) {
				break;
			}
			const lineBuffer = this.stdoutBuffer.subarray(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
			try {
				this.countBytes(lineBuffer.length + 1);
			} catch {
				this.failFromEvent("Script IPC limit exceeded.", "validation-error");
				return;
			}
			try {
				const parsed: unknown = JSON.parse(lineBuffer.toString("utf8"));
				if (!isScriptChildMessage(parsed)) {
					throw new Error("invalid message");
				}
				this.messages.push(parsed);
			} catch {
				this.failFromEvent("Sandbox returned an invalid IPC message.", "upstream-error");
				return;
			}
		}
		this.scheduleDrain();
	}
}

export function runScriptChild(
	options: RunAgentBrowserScriptOptions,
	nodePath: string,
	workerPath: string,
	timeoutMs: number,
): Promise<AgentBrowserScriptRunResult> {
	return new ScriptChildRun(options, nodePath, workerPath).run(timeoutMs);
}
