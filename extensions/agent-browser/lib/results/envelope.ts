import { readFile } from "node:fs/promises";

import { isRecord } from "../parsing.js";
import { detectConfirmationRequired } from "./confirmation.js";
import type { AgentBrowserEnvelope } from "./contracts.js";
import { decodeAgentBrowserEnvelope, type EnvelopeParseResult } from "./envelope-decoding.js";
import { stringifyUnknown } from "./text.js";

function hasStructuredBatchStepFailure(data: unknown): boolean {
	return Array.isArray(data) && data.some((item) => isRecord(item) && item.success === false);
}

async function readEnvelopeSource(options: {
	readonly stdout: string;
	readonly stdoutPath?: string;
}): Promise<string> {
	if (options.stdoutPath === undefined || options.stdoutPath.length === 0) {
		return options.stdout;
	}

	try {
		return await readFile(options.stdoutPath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : stringifyUnknown(error);
		throw new Error(`agent-browser output spill file could not be read: ${message}`, {
			cause: error,
		});
	}
}

export function extractEnvelopeErrorText(error: unknown): string | undefined {
	if (typeof error === "string") {
		const trimmed = error.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof error === "number" || typeof error === "boolean") {
		return String(error);
	}
	if (Array.isArray(error)) {
		const parts = error
			.map((item) => extractEnvelopeErrorText(item) ?? stringifyUnknown(item))
			.filter((item) => item.length > 0);
		return parts.length > 0 ? parts.join("\n") : undefined;
	}
	if (!isRecord(error)) {
		return error === null || error === undefined ? undefined : stringifyUnknown(error);
	}

	return extractStructuredEnvelopeErrorText(error);
}

function extractStructuredEnvelopeErrorText(
	error: Readonly<Record<string, unknown>>,
): string | undefined {
	for (const key of ["message", "error", "details", "cause", "stderr"] as const) {
		const value = extractEnvelopeErrorText(error[key]);
		if ((value ?? "") !== "") {
			return value;
		}
	}

	const fallback = stringifyUnknown(error).trim();
	return fallback.length > 0 && fallback !== "{}" ? fallback : undefined;
}

type EnvelopeSourceOptions = {
	readonly stdout: string;
	readonly stdoutPath?: string;
	readonly plainText?: boolean;
	readonly textOutput?: boolean;
};

function getEnvelopeOutputMode(options: string | EnvelopeSourceOptions): {
	readonly plainText: boolean;
	readonly textOutput: boolean;
} {
	return typeof options === "string"
		? { plainText: false, textOutput: false }
		: { plainText: options.plainText === true, textOutput: options.textOutput === true };
}

export async function parseAgentBrowserEnvelope(
	options: string | EnvelopeSourceOptions,
): Promise<EnvelopeParseResult> {
	let stdout: string;
	try {
		stdout = typeof options === "string" ? options : await readEnvelopeSource(options);
	} catch (error) {
		return { parseError: error instanceof Error ? error.message : stringifyUnknown(error) };
	}

	// ponytail: native text has no machine receipts; use JSON mode for structured evidence.
	// JSON-looking page text must never become an envelope, confirmation, or batch row.
	const { plainText, textOutput } = getEnvelopeOutputMode(options);
	if (textOutput) {
		return { envelope: { success: true, data: stdout } };
	}
	const trimmed = stdout.trim();
	if (trimmed.length === 0 && !plainText) {
		return { parseError: "agent-browser returned no JSON output." };
	}

	try {
		const parsed: unknown = JSON.parse(trimmed);
		return decodeAgentBrowserEnvelope(parsed);
	} catch (error) {
		if (plainText) {
			return { envelope: { success: true, data: trimmed } };
		}
		const message = error instanceof Error ? error.message : stringifyUnknown(error);
		return { parseError: `agent-browser returned invalid JSON: ${message}` };
	}
}

function buildInvocationLabel(options: {
	readonly command?: string;
	readonly effectiveArgs?: readonly string[];
}): string {
	if (options.effectiveArgs && options.effectiveArgs.length > 0) {
		return `agent-browser ${options.effectiveArgs.join(" ")}`;
	}
	if (options.command !== undefined && options.command.trim().length > 0) {
		return `agent-browser ${options.command.trim()}`;
	}
	return "agent-browser";
}

function appendWrapperRecoveryHint(message: string, wrapperRecoveryHint?: string): string {
	const hint = wrapperRecoveryHint?.trim();
	return hint !== undefined && hint.length > 0 ? `${message}\n${hint}` : message;
}

function buildFailureFallback(options: {
	readonly command?: string;
	readonly effectiveArgs?: readonly string[];
	readonly exitCode: number;
	readonly wrapperRecoveryHint?: string;
}): string {
	const invocation = buildInvocationLabel(options);
	const exitSuffix = options.exitCode !== 0 ? ` (exit code ${options.exitCode})` : "";
	return appendWrapperRecoveryHint(
		`${invocation} reported failure${exitSuffix}.`,
		options.wrapperRecoveryHint,
	);
}

function buildExitCodeFallback(options: {
	readonly command?: string;
	readonly effectiveArgs?: readonly string[];
	readonly exitCode: number;
	readonly wrapperRecoveryHint?: string;
}): string {
	const invocation = buildInvocationLabel(options);
	return appendWrapperRecoveryHint(
		`${invocation} exited with code ${options.exitCode}.`,
		options.wrapperRecoveryHint,
	);
}

function buildWatchdogTimeoutMessage(options: { readonly timeoutMs?: number }): string {
	const timeoutText =
		options.timeoutMs === undefined
			? "the wrapper watchdog"
			: `the ${options.timeoutMs}ms wrapper watchdog`;
	const ipcTiming =
		options.timeoutMs !== undefined && options.timeoutMs <= 30_000
			? "before the upstream CLI entered its 30s IPC retry path"
			: "after waiting beyond the upstream CLI's 30s IPC retry window";
	return [
		`agent-browser exceeded ${timeoutText} and was stopped ${ipcTiming}.`,
		"Prefer a condition wait or split long work into shorter calls; for legitimately long opens or captures, pass agent_browser timeoutMs with a bounded higher value and inspect details.timeoutPartialProgress before retrying.",
	].join(" ");
}

function isUpstreamIpcReadTimeoutMessage(message: string): boolean {
	return /Failed to read: Resource temporarily unavailable(?: \(os error \d+\))?.*daemon may be busy or unresponsive/i.test(
		message,
	);
}

function buildUpstreamIpcReadTimeoutMessage(): string {
	return [
		"agent-browser hit the upstream CLI 30s IPC read timeout while waiting for the daemon response.",
		'The daemon may still be alive; do not blindly retry a non-idempotent command. Prefer a shorter command, split long waits, or retry with sessionMode: "fresh" after checking tab list.',
	].join(" ");
}

function maybeAppendStaleRefHint(message: string, args?: readonly string[]): string {
	const usedRef = args?.some((arg) => /^@e\d+\b/.test(arg)) ?? false;
	if (!usedRef || !/could not locate element|element not found|no element/i.test(message)) {
		return message;
	}
	return [
		message,
		'This @ref may be stale after navigation, scrolling, or a DOM update. Run `agent_browser` with `{ "args": ["snapshot", "-i"] }` again and retry with a current ref, or use a stable `find` locator.',
	].join("\n");
}

interface AgentBrowserErrorOptions {
	readonly aborted: boolean;
	readonly command?: string;
	readonly effectiveArgs?: readonly string[];
	readonly envelope?: Readonly<AgentBrowserEnvelope>;
	readonly exitCode: number;
	readonly exitSignal?: NodeJS.Signals;
	readonly parseError?: string;
	readonly plainTextInspection: boolean;
	readonly spawnError?: Error;
	readonly staleRefArgs?: readonly string[];
	readonly stderr: string;
	readonly timedOut?: boolean;
	readonly timeoutMs?: number;
	readonly wrapperRecoveryHint?: string;
}

function getTransportErrorText(options: AgentBrowserErrorOptions): string | undefined {
	if (options.timedOut === true) {
		return buildWatchdogTimeoutMessage(options);
	}
	if (options.aborted) {
		return "agent-browser was aborted.";
	}
	if (options.spawnError) {
		return options.spawnError.message;
	}
	if ((options.parseError ?? "") !== "") {
		return malformedProcessErrorText(options);
	}
	return undefined;
}

function malformedProcessErrorText(options: AgentBrowserErrorOptions): string | undefined {
	if (options.exitCode === 0 && !options.exitSignal) {
		return options.parseError;
	}
	const signalText = options.exitSignal ? `Signal: ${options.exitSignal}.` : undefined;
	const oomHint =
		options.exitSignal === "SIGKILL" || options.exitCode === 137
			? "SIGKILL may indicate an OOM kill or an external stop. Inspect the host kernel log and cgroup memory.events before retrying; the command may have executed."
			: undefined;
	return [
		buildExitCodeFallback(options),
		signalText,
		options.stderr.trim(),
		options.stderr.trim().length > 0 ? undefined : options.parseError,
		oomHint,
	]
		.filter(Boolean)
		.join("\n");
}

function getEnvelopeDataError(data: unknown): unknown {
	if (typeof data === "string") {
		return data;
	}
	return isRecord(data) ? data.error : undefined;
}

function getFailedEnvelopeFallback(
	options: AgentBrowserErrorOptions,
	errorText: string | undefined,
): string {
	const stderr = options.stderr.trim();
	return errorText ?? (stderr.length > 0 ? stderr : buildFailureFallback(options));
}

function getFailedEnvelopeErrorText(
	options: AgentBrowserErrorOptions,
	envelope: Readonly<AgentBrowserEnvelope>,
): string | undefined {
	const explicitErrorText = extractEnvelopeErrorText(envelope.error);
	if (
		(hasStructuredBatchStepFailure(envelope.data) || detectConfirmationRequired(envelope.data)) &&
		explicitErrorText === undefined
	) {
		return undefined;
	}
	const envelopeErrorText =
		explicitErrorText ?? extractEnvelopeErrorText(getEnvelopeDataError(envelope.data));
	if (
		envelopeErrorText !== undefined &&
		envelopeErrorText.length > 0 &&
		isUpstreamIpcReadTimeoutMessage(envelopeErrorText)
	) {
		return buildUpstreamIpcReadTimeoutMessage();
	}
	const fallback = getFailedEnvelopeFallback(options, envelopeErrorText);
	return maybeAppendStaleRefHint(fallback, options.staleRefArgs ?? options.effectiveArgs);
}

export function getAgentBrowserErrorText(options: AgentBrowserErrorOptions): string | undefined {
	if (options.plainTextInspection) {
		return undefined;
	}
	const transportErrorText = getTransportErrorText(options);
	if (transportErrorText !== undefined) {
		return transportErrorText;
	}
	if (options.envelope?.success === false) {
		return getFailedEnvelopeErrorText(options, options.envelope);
	}
	if (options.exitCode !== 0) {
		const stderr = options.stderr.trim();
		return stderr.length > 0 ? stderr : buildExitCodeFallback(options);
	}
	return undefined;
}
