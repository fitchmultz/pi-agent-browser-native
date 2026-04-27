/**
 * Purpose: Parse upstream agent-browser output and turn failure envelopes into actionable error text.
 * Responsibilities: Read inline or spilled stdout, parse observed JSON envelope shapes, normalize batch arrays, and extract the most useful error text from nested upstream failures.
 * Scope: Envelope parsing and error derivation only; content rendering and snapshot compaction live in separate modules.
 * Usage: Imported by the public `lib/results.ts` facade and by tests through that facade.
 * Invariants/Assumptions: Upstream `agent-browser --json` responses follow the observed `{ success, data, error }` envelope shape or the array shape returned by `batch --json`.
 */

import { readFile } from "node:fs/promises";

import { type AgentBrowserBatchResult, type AgentBrowserEnvelope, isRecord, stringifyUnknown } from "./shared.js";

function hasStructuredBatchStepFailure(data: unknown): data is AgentBrowserBatchResult[] {
	return Array.isArray(data) && data.some((item) => isRecord(item) && item.success === false);
}

async function readEnvelopeSource(options: { stdout: string; stdoutPath?: string }): Promise<string> {
	if (!options.stdoutPath) {
		return options.stdout;
	}

	try {
		return await readFile(options.stdoutPath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`agent-browser output spill file could not be read: ${message}`);
	}
}

function extractEnvelopeErrorText(error: unknown): string | undefined {
	if (typeof error === "string") {
		return error.trim() || undefined;
	}
	if (typeof error === "number" || typeof error === "boolean") {
		return String(error);
	}
	if (Array.isArray(error)) {
		const parts = error.map((item) => extractEnvelopeErrorText(item) ?? stringifyUnknown(item)).filter((item) => item.length > 0);
		return parts.length > 0 ? parts.join("\n") : undefined;
	}
	if (!isRecord(error)) {
		return error == null ? undefined : stringifyUnknown(error);
	}

	for (const key of ["message", "error", "details", "cause", "stderr"] as const) {
		const value = extractEnvelopeErrorText(error[key]);
		if (value) return value;
	}

	const fallback = stringifyUnknown(error).trim();
	return fallback.length > 0 && fallback !== "{}" ? fallback : undefined;
}

export async function parseAgentBrowserEnvelope(options: string | { stdout: string; stdoutPath?: string }): Promise<{
	envelope?: AgentBrowserEnvelope;
	parseError?: string;
}> {
	let stdout: string;
	try {
		stdout = typeof options === "string" ? options : await readEnvelopeSource(options);
	} catch (error) {
		return { parseError: error instanceof Error ? error.message : String(error) };
	}

	const trimmed = stdout.trim();
	if (trimmed.length === 0) {
		return { parseError: "agent-browser returned no JSON output." };
	}

	try {
		const parsed = JSON.parse(trimmed) as AgentBrowserEnvelope | AgentBrowserBatchResult[];
		if (Array.isArray(parsed)) {
			return { envelope: { success: parsed.every((item) => !isRecord(item) || item.success !== false), data: parsed } };
		}
		if (!isRecord(parsed)) {
			return { parseError: "agent-browser returned JSON, but it was not an object envelope." };
		}
		if (!("success" in parsed)) {
			return { parseError: "agent-browser returned an invalid JSON envelope: missing boolean success field." };
		}
		if (typeof parsed.success !== "boolean") {
			return { parseError: "agent-browser returned an invalid JSON envelope: success field must be boolean." };
		}
		return { envelope: parsed as AgentBrowserEnvelope };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { parseError: `agent-browser returned invalid JSON: ${message}` };
	}
}

function buildInvocationLabel(options: { command?: string; effectiveArgs?: string[] }): string {
	if (options.effectiveArgs && options.effectiveArgs.length > 0) {
		return `agent-browser ${options.effectiveArgs.join(" ")}`;
	}
	if (options.command && options.command.trim().length > 0) {
		return `agent-browser ${options.command.trim()}`;
	}
	return "agent-browser";
}

function appendWrapperRecoveryHint(message: string, wrapperRecoveryHint?: string): string {
	const hint = wrapperRecoveryHint?.trim();
	return hint ? `${message}\n${hint}` : message;
}

function buildFailureFallback(options: { command?: string; effectiveArgs?: string[]; exitCode: number; wrapperRecoveryHint?: string }): string {
	const invocation = buildInvocationLabel(options);
	const exitSuffix = options.exitCode !== 0 ? ` (exit code ${options.exitCode})` : "";
	return appendWrapperRecoveryHint(`${invocation} reported failure${exitSuffix}.`, options.wrapperRecoveryHint);
}

function buildExitCodeFallback(options: { command?: string; effectiveArgs?: string[]; exitCode: number; wrapperRecoveryHint?: string }): string {
	const invocation = buildInvocationLabel(options);
	return appendWrapperRecoveryHint(`${invocation} exited with code ${options.exitCode}.`, options.wrapperRecoveryHint);
}

export function getAgentBrowserErrorText(options: {
	aborted: boolean;
	command?: string;
	effectiveArgs?: string[];
	envelope?: AgentBrowserEnvelope;
	exitCode: number;
	parseError?: string;
	plainTextInspection: boolean;
	spawnError?: Error;
	stderr: string;
	wrapperRecoveryHint?: string;
}): string | undefined {
	const { aborted, envelope, exitCode, parseError, plainTextInspection, spawnError, stderr } = options;
	if (plainTextInspection) return undefined;
	if (aborted) return "agent-browser was aborted.";
	if (spawnError) return spawnError.message;
	if (parseError) return parseError;
	if (envelope?.success === false) {
		if (hasStructuredBatchStepFailure(envelope.data) && envelope.error === undefined) {
			return undefined;
		}
		return extractEnvelopeErrorText(envelope.error) ?? (stderr.trim() || buildFailureFallback(options));
	}
	if (exitCode !== 0) {
		return stderr.trim() || buildExitCodeFallback(options);
	}
	return undefined;
}
