import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgvDescriptor } from "../argv-descriptor.js";
import { getFlagName } from "../argv-grammar.js";
import { needsManagedSession } from "../command-policy.js";
import { isCloseCommand } from "../command-taxonomy.js";
import { LAUNCH_SCOPED_FLAGS, MANAGED_RESTORE_INCOMPATIBLE_FLAGS } from "../launch-scoped-flags.js";
import { isRecord } from "../parsing.js";
import { validateToolArgs } from "../runtime.js";
import type { AgentBrowserFailureCategory, AgentBrowserNextAction, AgentBrowserResultCategory, AgentBrowserSuccessCategory } from "../results/contracts.js";

export const AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES = 64 * 1_024;
export const AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000;
export const AGENT_BROWSER_SCRIPT_NAMESPACE = "";
export const AGENT_BROWSER_SCRIPT_MAX_TIMEOUT_MS = 300_000;
export const AGENT_BROWSER_SCRIPT_MAX_CALLS = 25;
export const AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES = 64 * 1_024;
export const AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES = 1 * 1_024 * 1_024;
export const AGENT_BROWSER_SCRIPT_IPC_CUMULATIVE_MAX_BYTES = 8 * 1_024 * 1_024;
export const AGENT_BROWSER_SCRIPT_SPILL_MAX_BYTES = 1 * 1_024 * 1_024;

function findPackageRoot(startDir: string): string {
	let currentDir = startDir;
	for (;;) {
		if (existsSync(join(currentDir, "package.json"))) return currentDir;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) throw new Error("Unable to resolve the pi-agent-browser-native package root.");
		currentDir = parentDir;
	}
}

function resolveScriptWorkerPath(): string {
	const workerPath = join(findPackageRoot(dirname(fileURLToPath(import.meta.url))), "dist", "extensions", "agent-browser", "script-worker.js");
	if (!existsSync(workerPath)) throw new Error("Compiled script worker is missing; run npm run build or reinstall pi-agent-browser-native.");
	return workerPath;
}

const SCRIPT_SESSION_NAME_PATTERN = /^piab-script-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCRIPT_ALLOWED_LAUNCH_FLAG = "--allowed-domains";
const SCRIPT_FORBIDDEN_COMMANDS = new Set(["attach", "auth", "batch", "connect", "script", "session", "state"]);
const SCRIPT_FORBIDDEN_FLAGS = new Set<string>([
	...LAUNCH_SCOPED_FLAGS.filter((flag) => flag !== SCRIPT_ALLOWED_LAUNCH_FLAG),
	...MANAGED_RESTORE_INCOMPATIBLE_FLAGS.filter((flag) => flag !== SCRIPT_ALLOWED_LAUNCH_FLAG),
	"--namespace",
	"--session",
]);

export interface CompiledAgentBrowserScript {
	code: string;
}

export interface AgentBrowserScriptBrowserParams {
	args: string[];
	stdin?: string;
	timeoutMs?: number;
}

export interface AgentBrowserScriptBrowserEnvelope {
	data: unknown;
	details?: Record<string, unknown>;
	error?: string;
	failureCategory?: AgentBrowserFailureCategory;
	nextActions?: AgentBrowserNextAction[];
	ok: boolean;
	resultCategory: AgentBrowserResultCategory;
	successCategory?: AgentBrowserSuccessCategory;
	summary: string;
	text: string;
}

export interface AgentBrowserScriptStepSummary {
	failureCategory?: AgentBrowserFailureCategory;
	index: number;
	ok: boolean;
	resultCategory: AgentBrowserResultCategory;
	successCategory?: AgentBrowserSuccessCategory;
	summary: string;
}

export interface AgentBrowserScriptRunResult {
	aborted?: boolean;
	callCount: number;
	data?: unknown;
	emitCount: number;
	error?: string;
	failureCategory?: AgentBrowserFailureCategory;
	ok: boolean;
	rejectedCallCount: number;
	steps: AgentBrowserScriptStepSummary[];
	timedOut?: boolean;
}

export interface RunAgentBrowserScriptOptions {
	beforeFirstCall?: () => void;
	code: string;
	dispatch: (params: AgentBrowserScriptBrowserParams, signal: AbortSignal) => Promise<AgentBrowserScriptBrowserEnvelope>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

type ScriptChildMessage =
	| { type: "ready" }
	| { id: number; params: unknown; type: "call" }
	| { type: "emit"; value: unknown }
	| { error?: { message?: unknown; name?: unknown }; hasValue?: boolean; type: "complete"; value?: unknown };

type ScriptParentMessage =
	| { code: string; type: "start" }
	| { envelope: AgentBrowserScriptBrowserEnvelope; id: number; type: "response" };

export function compileAgentBrowserScript(input: unknown): { compiled?: CompiledAgentBrowserScript; error?: string } {
	if (typeof input !== "string") return { error: "script must be a string." };
	const bytes = Buffer.byteLength(input, "utf8");
	return bytes > AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES
		? { error: `script must be ${AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES} bytes or less.` }
		: { compiled: { code: input } };
}

export function createAgentBrowserScriptSessionName(): string {
	return `piab-script-${randomUUID()}`;
}

export function createAgentBrowserScriptCloseArgs(sessionName: string): string[] {
	return ["--namespace", AGENT_BROWSER_SCRIPT_NAMESPACE, "--session", sessionName, "close"];
}

export function isAgentBrowserScriptSessionName(value: unknown): value is string {
	return typeof value === "string" && SCRIPT_SESSION_NAME_PATTERN.test(value);
}

function getScriptCallPolicyError(args: string[]): string | undefined {
	const descriptor = parseArgvDescriptor(args);
	const command = descriptor.commandInfo.command;
	if (!command) return "script browser call args must contain an agent-browser command.";
	if (isCloseCommand(command)) return "script browser calls cannot close, quit, or exit their isolated session.";
	if (SCRIPT_FORBIDDEN_COMMANDS.has(command)) return `script browser calls cannot use ${command}.`;
	if (!needsManagedSession(descriptor)) return `script browser calls cannot use sessionless/local command ${command}.`;
	for (const token of args) {
		const flag = getFlagName(token);
		if (SCRIPT_FORBIDDEN_FLAGS.has(flag)) {
			return `script browser calls cannot use ${flag}; the parent owns the isolated session identity and launch policy.`;
		}
	}
	return undefined;
}

export function validateAgentBrowserScriptBrowserParams(input: unknown): { params?: AgentBrowserScriptBrowserParams; error?: string; policyBlocked?: boolean } {
	if (!isRecord(input)) return { error: "script browser(params) requires an object." };
	const unsupportedField = Object.keys(input).find((field) => !["args", "stdin", "timeoutMs"].includes(field));
	if (unsupportedField) return { error: `script browser(params) does not support ${unsupportedField}; use only args, stdin, and timeoutMs.` };
	if (!Array.isArray(input.args) || input.args.length === 0 || input.args.some((arg) => typeof arg !== "string")) {
		return { error: "script browser(params).args must be a non-empty string array." };
	}
	if (input.stdin !== undefined && typeof input.stdin !== "string") {
		return { error: "script browser(params).stdin must be a string when provided." };
	}
	if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
		return { error: "script browser(params).timeoutMs must be a positive integer when provided." };
	}
	const params: AgentBrowserScriptBrowserParams = {
		args: input.args,
		stdin: input.stdin as string | undefined,
		timeoutMs: input.timeoutMs as number | undefined,
	};
	const policyError = getScriptCallPolicyError(params.args);
	if (policyError) return { error: policyError, policyBlocked: true };
	const validationError = validateToolArgs(params.args);
	return validationError ? { error: validationError } : { params };
}

function buildRejectedCallEnvelope(error: string, policyBlocked: boolean): AgentBrowserScriptBrowserEnvelope {
	return {
		data: null,
		details: { failureCategory: policyBlocked ? "policy-blocked" : "validation-error", resultCategory: "failure" },
		error,
		failureCategory: policyBlocked ? "policy-blocked" : "validation-error",
		ok: false,
		resultCategory: "failure",
		summary: error,
		text: error,
	};
}

function normalizeBrowserEnvelope(value: AgentBrowserScriptBrowserEnvelope): AgentBrowserScriptBrowserEnvelope {
	if (!isRecord(value)
		|| typeof value.ok !== "boolean"
		|| typeof value.text !== "string"
		|| typeof value.summary !== "string"
		|| (value.resultCategory !== "success" && value.resultCategory !== "failure")) {
		return buildRejectedCallEnvelope("The ordinary agent_browser executor returned an invalid script envelope.", false);
	}
	return {
		data: value.data ?? null,
		details: isRecord(value.details) ? value.details : undefined,
		error: typeof value.error === "string" ? value.error : undefined,
		failureCategory: value.failureCategory as AgentBrowserFailureCategory | undefined,
		nextActions: Array.isArray(value.nextActions) ? value.nextActions as AgentBrowserNextAction[] : undefined,
		ok: value.ok,
		resultCategory: value.resultCategory,
		successCategory: value.successCategory as AgentBrowserSuccessCategory | undefined,
		summary: value.summary,
		text: value.text,
	};
}

function buildStepSummary(index: number, envelope: AgentBrowserScriptBrowserEnvelope): AgentBrowserScriptStepSummary {
	return {
		failureCategory: envelope.failureCategory,
		index,
		ok: envelope.ok,
		resultCategory: envelope.resultCategory,
		successCategory: envelope.successCategory,
		summary: envelope.summary,
	};
}

function buildFailedRun(options: {
	aborted?: boolean;
	callCount: number;
	emitCount: number;
	error: string;
	failureCategory: AgentBrowserFailureCategory;
	rejectedCallCount: number;
	steps: AgentBrowserScriptStepSummary[];
	timedOut?: boolean;
}): AgentBrowserScriptRunResult {
	return { ...options, ok: false };
}

function describeScriptError(error: { message?: unknown; name?: unknown } | undefined): string {
	const name = typeof error?.name === "string" && error.name.length > 0 ? error.name.slice(0, 80) : "Error";
	const message = typeof error?.message === "string" && error.message.length > 0
		? error.message.replace(/[\r\n]+/g, " ").slice(0, 400)
		: "Script execution failed.";
	return `${name}: ${message}`;
}

function isScriptChildMessage(value: unknown): value is ScriptChildMessage {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "ready") return true;
	if (value.type === "call") return typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0;
	if (value.type === "emit") return true;
	return value.type === "complete";
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
}

function terminateChild(child: ChildProcessWithoutNullStreams): NodeJS.Timeout {
	child.stdin.destroy();
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	return setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 250);
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		promise.catch(() => undefined),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		}),
	]);
	if (timer) clearTimeout(timer);
}

function serializeFinalOutput(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return JSON.stringify(value);
}

export async function runAgentBrowserScript(options: RunAgentBrowserScriptOptions): Promise<AgentBrowserScriptRunResult> {
	const compiled = compileAgentBrowserScript(options.code);
	if (compiled.error) {
		return buildFailedRun({ callCount: 0, emitCount: 0, error: compiled.error, failureCategory: "validation-error", rejectedCallCount: 0, steps: [] });
	}
	const timeoutMs = options.timeoutMs ?? AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > AGENT_BROWSER_SCRIPT_MAX_TIMEOUT_MS) {
		return buildFailedRun({ callCount: 0, emitCount: 0, error: `script timeoutMs must be between 1 and ${AGENT_BROWSER_SCRIPT_MAX_TIMEOUT_MS}.`, failureCategory: "validation-error", rejectedCallCount: 0, steps: [] });
	}
	if (options.signal?.aborted) {
		return buildFailedRun({ aborted: true, callCount: 0, emitCount: 0, error: "Script execution was aborted.", failureCategory: "aborted", rejectedCallCount: 0, steps: [] });
	}

	let workerPath: string;
	try {
		workerPath = resolveScriptWorkerPath();
	} catch (error) {
		const message = error instanceof Error ? error.message : "Compiled script worker is missing.";
		return buildFailedRun({ callCount: 0, emitCount: 0, error: message, failureCategory: "missing-binary", rejectedCallCount: 0, steps: [] });
	}

	const child = spawn(process.execPath, [
		"--permission",
		"--max-old-space-size=64",
		workerPath,
		String(AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES),
		String(AGENT_BROWSER_SCRIPT_IPC_CUMULATIVE_MAX_BYTES),
	], {
		env: {},
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.on("error", () => undefined);
	let stdoutBuffer = Buffer.alloc(0);
	let stderrBytes = 0;
	let cumulativeBytes = 0;
	let callCount = 0;
	let rejectedCallCount = 0;
	let leaseStarted = false;
	let ready = false;
	let stopping = false;
	let activeCallController: AbortController | undefined;
	const emissions: unknown[] = [];
	const steps: AgentBrowserScriptStepSummary[] = [];
	const messages: ScriptChildMessage[] = [];
	let draining = false;
	let drainPromise = Promise.resolve();
	let resolveResult!: (result: AgentBrowserScriptRunResult) => void;
	const resultPromise = new Promise<AgentBrowserScriptRunResult>((resolve) => {
		resolveResult = resolve;
	});
	const childExit = waitForChildExit(child);
	let timeout: NodeJS.Timeout | undefined;
	let killTimer: NodeJS.Timeout | undefined;

	const sendParentMessage = async (message: ScriptParentMessage): Promise<void> => {
		const line = `${JSON.stringify(message)}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes > AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES || cumulativeBytes + bytes > AGENT_BROWSER_SCRIPT_IPC_CUMULATIVE_MAX_BYTES) {
			throw new Error("Script IPC limit exceeded.");
		}
		cumulativeBytes += bytes;
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(line, (error) => error ? reject(error) : resolve());
		});
	};

	const finish = async (result: AgentBrowserScriptRunResult, waitForDrain: boolean): Promise<void> => {
		if (stopping) return;
		stopping = true;
		if (timeout) clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortListener);
		activeCallController?.abort();
		killTimer = terminateChild(child);
		if (waitForDrain) await settleWithin(drainPromise, 5_000);
		await settleWithin(childExit, 1_000);
		clearTimeout(killTimer);
		resolveResult(result);
	};

	const fail = (error: string, failureCategory: AgentBrowserFailureCategory, flags: { aborted?: boolean; timedOut?: boolean } = {}, waitForDrain = false): Promise<void> => finish(buildFailedRun({
		...flags,
		callCount,
		emitCount: emissions.length,
		error,
		failureCategory,
		rejectedCallCount,
		steps,
	}), waitForDrain);

	const abortListener = () => {
		void fail("Script execution was aborted.", "aborted", { aborted: true }, true);
	};
	options.signal?.addEventListener("abort", abortListener, { once: true });
	timeout = setTimeout(() => {
		void fail(`Script execution timed out after ${timeoutMs}ms.`, "timeout", { timedOut: true }, true);
	}, timeoutMs);

	const drainMessages = async (): Promise<void> => {
		if (draining) return;
		draining = true;
		try {
			while (!stopping && messages.length > 0) {
				const message = messages.shift() as ScriptChildMessage;
				if (message.type === "ready") {
					if (ready) {
						await fail("Sandbox sent a duplicate ready message.", "upstream-error");
						return;
					}
					ready = true;
					try {
						await sendParentMessage({ code: options.code, type: "start" });
					} catch {
						await fail("Unable to start the script sandbox.", "upstream-error");
						return;
					}
					continue;
				}
				if (!ready) {
					await fail("Sandbox sent a message before it was ready.", "upstream-error");
					return;
				}
				if (message.type === "emit") {
					if (!Object.hasOwn(message, "value")) {
						await fail("emit(value) requires a JSON-serializable value; undefined and functions are not supported.", "validation-error");
						return;
					}
					emissions.push(message.value);
					continue;
				}
				if (message.type === "complete") {
					if (message.error) {
						await fail(describeScriptError(message.error), "script-error");
						return;
					}
					const data = emissions.length === 0
						? message.hasValue ? message.value : undefined
						: emissions.length === 1 ? emissions[0] : emissions;
					let serialized: string | undefined;
					try {
						serialized = serializeFinalOutput(data);
					} catch {
						await fail("Final script output must be JSON-serializable.", "validation-error");
						return;
					}
					if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES) {
						await fail(`Final script output exceeds ${AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES} bytes.`, "validation-error");
						return;
					}
					await finish({ callCount, data, emitCount: emissions.length, ok: true, rejectedCallCount, steps }, false);
					return;
				}

				callCount += 1;
				if (callCount > AGENT_BROWSER_SCRIPT_MAX_CALLS) {
					await fail(`Script browser call limit exceeded (${AGENT_BROWSER_SCRIPT_MAX_CALLS}).`, "validation-error");
					return;
				}
				const validated = validateAgentBrowserScriptBrowserParams(message.params);
				let envelope: AgentBrowserScriptBrowserEnvelope;
				if (!validated.params) {
					rejectedCallCount += 1;
					envelope = buildRejectedCallEnvelope(validated.error ?? "Invalid script browser call.", validated.policyBlocked === true);
				} else {
					if (!leaseStarted) {
						try {
							options.beforeFirstCall?.();
							leaseStarted = true;
						} catch {
							await fail("Unable to persist the isolated script session lease.", "upstream-error");
							return;
						}
					}
					activeCallController = new AbortController();
					try {
						envelope = normalizeBrowserEnvelope(await options.dispatch(validated.params, activeCallController.signal));
					} catch {
						envelope = buildRejectedCallEnvelope("The ordinary agent_browser executor failed while dispatching this call.", false);
					} finally {
						activeCallController = undefined;
					}
					if (stopping) return;
				}
				steps.push(buildStepSummary(callCount - 1, envelope));
				try {
					await sendParentMessage({ envelope, id: message.id, type: "response" });
				} catch {
					await fail("Unable to return a browser result to the script sandbox.", "upstream-error");
					return;
				}
			}
		} finally {
			draining = false;
			if (!stopping && messages.length > 0) scheduleDrain();
		}
	};

	function scheduleDrain(): void {
		if (draining || stopping) return;
		drainPromise = drainMessages();
	}

	child.stdout.on("data", (chunk: Buffer) => {
		if (stopping) return;
		stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
		if (stdoutBuffer.length > AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES) {
			void fail("Script IPC message limit exceeded.", "validation-error", {}, true);
			return;
		}
		for (;;) {
			const newline = stdoutBuffer.indexOf(10);
			if (newline < 0) break;
			const lineBuffer = stdoutBuffer.subarray(0, newline);
			stdoutBuffer = stdoutBuffer.subarray(newline + 1);
			const bytes = lineBuffer.length + 1;
			if (bytes > AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES || cumulativeBytes + bytes > AGENT_BROWSER_SCRIPT_IPC_CUMULATIVE_MAX_BYTES) {
				void fail("Script IPC limit exceeded.", "validation-error", {}, true);
				return;
			}
			cumulativeBytes += bytes;
			try {
				const parsed = JSON.parse(lineBuffer.toString("utf8")) as unknown;
				if (!isScriptChildMessage(parsed)) throw new Error("invalid message");
				messages.push(parsed);
			} catch {
				void fail("Sandbox returned an invalid IPC message.", "upstream-error", {}, true);
				return;
			}
		}
		scheduleDrain();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		if (stderrBytes > AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES && !stopping) {
			void fail("Sandbox stderr limit exceeded.", "upstream-error", {}, true);
		}
	});
	child.once("error", () => {
		if (!stopping) void fail("Unable to start the script sandbox.", "upstream-error", {}, true);
	});
	child.once("exit", () => {
		if (!stopping) void fail("Script sandbox exited before completion.", "upstream-error", {}, true);
	});

	return await resultPromise;
}
