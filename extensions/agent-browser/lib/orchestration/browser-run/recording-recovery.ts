import { resolve } from "node:path";

import { getAgentBrowserSessionIdentityKey } from "../../argv-grammar.js";
import { getRecordCommandOperands } from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import type { ActiveRecordingReservation } from "../../recording-reservations.js";
import { isPendingRecordingArtifact, mergeSessionArtifactManifest } from "../../results/artifact-manifest.js";
import type { AgentBrowserEnvelope, AgentBrowserNextAction, SessionArtifactManifest, ToolPresentation } from "../../results/contracts.js";
import { extractEnvelopeErrorText } from "../../results/envelope.js";
import { appendUniqueAgentBrowserNextActions } from "../../results/next-actions.js";
import { buildToolPresentation } from "../../results/presentation.js";
import { buildArtifactVerificationSummary, buildManifestEntriesForFileArtifacts } from "../../results/presentation/artifacts.js";
import { getRecordingReceipt, type RecordingReceipt } from "../../results/recording.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { runSessionCommandData } from "./session-state.js";
import type { AgentBrowserProcessResult } from "./types.js";

export interface RecordingRecovery {
	attempt: { success: false; exitCode: number; timedOut: boolean; error: string; parseError?: string };
	expected?: ActiveRecordingReservation;
	healed: boolean;
	namespace?: string;
	receipt?: RecordingReceipt;
	reason: string;
	sessionName?: string;
	source: "session-info";
	status: "recovered" | "pending" | "failed" | "unverified" | "unavailable" | "mismatch";
}

export interface RecordingStopRecoveryResult {
	batch: boolean;
	envelope?: AgentBrowserEnvelope;
	partialBatch: boolean;
	stopIndex: number;
	presentation: ToolPresentation;
	recovery: RecordingRecovery;
}

function isStop(tokens: readonly string[]): boolean {
	return tokens[0] === "record" && tokens[1] === "stop";
}

function receiptMatches(receipt: RecordingReceipt, expected: ActiveRecordingReservation, nowMs: number): boolean {
	if (resolve(expected.cwd, receipt.path) !== expected.absolutePath) return false;
	if (expected.recordingId) return receipt.recordingId === expected.recordingId;
	const startedAtMs = Date.parse(receipt.capture.startedAt ?? "");
	return expected.startedAtMs !== undefined && startedAtMs >= expected.startedAtMs && startedAtMs <= nowMs;
}

export async function recoverRecordingStop(options: {
	artifactManifest?: SessionArtifactManifest;
	artifactRunStartedAtMs: number;
	commandTokens: string[];
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	namespace?: string;
	parseError?: string;
	processResult: AgentBrowserProcessResult;
	reservation?: ActiveRecordingReservation;
	sessionName?: string;
	signal?: AbortSignal;
	stdin?: string;
}): Promise<RecordingStopRecoveryResult | undefined> {
	const batch = options.commandTokens[0] === "batch";
	const steps = batch ? getUpstreamEffectiveBatchSteps(options.commandTokens, options.stdin) : [options.commandTokens];
	const rows = batch && Array.isArray(options.envelope?.data) ? options.envelope.data : undefined;
	const stopIndex = steps.reduce((last, step, index) => isStop(step) && (options.processResult.timedOut
		|| /no recording in progress/i.test(extractEnvelopeErrorText(rows?.[index]?.error ?? options.envelope?.error) ?? "")) ? index : last, -1);
	if (stopIndex < 0 || options.processResult.aborted || options.signal?.aborted || !options.processResult.agentBrowserStarted) return undefined;
	let expected = options.reservation;
	for (let index = 0; index < stopIndex; index += 1) {
		const step = steps[index];
		if (step[0] !== "record" || !["start", "restart"].includes(step[1])) continue;
		const row = rows?.[index];
		if (isRecord(row) && row.success === false) continue;
		const started = isRecord(row) && isRecord(row.result) ? row.result : undefined;
		const path = typeof started?.path === "string" ? started.path : getRecordCommandOperands(step).path;
		if (path && options.sessionName) expected = {
			absolutePath: resolve(options.cwd, path), cwd: options.cwd, path, namespace: options.namespace, sessionName: options.sessionName,
			recordingId: typeof started?.recordingId === "string" ? started.recordingId : undefined, startedAtMs: options.artifactRunStartedAtMs,
		};
	}
	const attemptError = options.processResult.timedOut
		? `Record stop timed out after ${options.processResult.timeoutMs} ms.`
		: extractEnvelopeErrorText(rows?.[stopIndex]?.error ?? options.envelope?.error) ?? "Record stop did not return a receipt.";
	const recovery: RecordingRecovery = {
		attempt: { success: false, exitCode: options.processResult.exitCode, timedOut: options.processResult.timedOut, error: attemptError, parseError: options.parseError },
		expected, healed: false, namespace: options.namespace, sessionName: options.sessionName, source: "session-info", status: "unavailable",
		reason: "Native session info did not provide a matching recording receipt. File presence alone cannot prove successful recording finalization.",
	};
	let info: unknown;
	try {
		info = await runSessionCommandData({ args: ["session", "info"], cwd: options.cwd, namespace: options.namespace, pinNamespace: true, sessionName: options.sessionName, signal: options.signal, timeoutMs: 2_000 });
	} catch (error) {
		recovery.reason = `Native session info was unavailable: ${error instanceof Error ? error.message : String(error)}. File presence alone cannot prove successful recording finalization.`;
	}
	const runtime = isRecord(info) && isRecord(info.runtime) ? info.runtime : undefined;
	const recordings = isRecord(runtime?.recording) ? runtime.recording : undefined;
	const sameSession = isRecord(info) && typeof info.session === "string" && options.sessionName !== undefined
		&& getAgentBrowserSessionIdentityKey(info.session, typeof info.namespace === "string" ? info.namespace : undefined)
			=== getAgentBrowserSessionIdentityKey(options.sessionName, options.namespace);
	const current = getRecordingReceipt(recordings?.current);
	let matchedData: unknown;
	if (recordings && sameSession && expected) {
		for (const candidate of [recordings.current, recordings.last]) {
			const receipt = getRecordingReceipt(candidate);
			if (!receipt || !receiptMatches(receipt, expected, Date.now())) continue;
			recovery.receipt = receipt;
			matchedData = candidate;
			break;
		}
		if (!recovery.receipt) { recovery.status = "mismatch"; recovery.reason = "Native recording IDs, paths or capture windows did not match this attempt; unrelated receipt measurements were not used."; }
	} else if (recordings && !sameSession) {
		recovery.status = "mismatch";
		recovery.reason = "Native session info reported a different namespace/session; its recording receipt was not used.";
	}
	const receipt = recovery.receipt;
	const currentUsesSamePath = current && receipt && current.recordingId !== receipt.recordingId && expected
		&& resolve(expected.cwd, current.path) === expected.absolutePath;
	const terminalMeasurements = receipt?.success === true && receipt.output.encoderSucceeded === true
		&& receipt.output.encodedFrames !== null && receipt.output.encodedFrames > 0
		&& receipt.file.exists === true && receipt.file.sizeBytes !== null && receipt.file.sizeBytes > 0
		&& Number.isFinite(Date.parse(receipt.capture.startedAt ?? "")) && Number.isFinite(Date.parse(receipt.capture.endedAt ?? ""))
		&& !currentUsesSamePath;
	const data = matchedData ?? (expected ? { path: expected.absolutePath, recordingId: expected.recordingId, success: null } : undefined);
	const presentation = await buildToolPresentation({
		artifactManifest: options.artifactManifest, artifactMinUpdatedAtMs: expected?.startedAtMs ?? options.artifactRunStartedAtMs, artifactMaxUpdatedAtMs: Date.now(),
		artifactRequest: expected ? { path: expected.path, absolutePath: expected.absolutePath, status: terminalMeasurements ? undefined : "unverified" } : undefined,
		commandInfo: { command: "record", subcommand: "stop" }, cwd: expected?.cwd ?? options.cwd,
		envelope: { success: receipt?.success === true, data }, namespace: options.namespace, sessionName: options.sessionName,
		recordingPending: receipt ? receipt.success === null : options.processResult.timedOut,
	});
	const file = presentation.artifacts?.[0];
	const stopVerified = terminalMeasurements && presentation.artifactVerification?.verified === true && file?.sizeBytes === receipt?.file.sizeBytes;
	if (receipt) {
		recovery.status = stopVerified ? "recovered" : receipt.success === null ? "pending" : receipt.success === false ? "failed" : "unverified";
		recovery.reason = stopVerified ? "Native terminal success and encoder measurements match the expected recording and the verified file."
			: receipt.success === null ? "The matching native take is still pending; no terminal success was reported."
			: receipt.success === false ? `The matching native receipt reports failure: ${receipt.error ?? "unknown encoder/capture failure"}.`
			: currentUsesSamePath ? "Another active recording uses this path. The previous receipt cannot verify the new take's file."
			: "A matching receipt was found, but successful encoding and a matching fresh file could not both be verified.";
	}
	let envelope = options.envelope;
	if (rows) {
		const updatedRows = rows.map((row, index) => index === stopIndex && isRecord(row) ? { ...row, result: data, success: stopVerified === true, error: stopVerified ? undefined : row.error } : row);
		recovery.healed = stopVerified === true && !options.processResult.timedOut && updatedRows.every(row => isRecord(row) && row.success === true);
		envelope = { success: recovery.healed, data: updatedRows, error: recovery.healed ? undefined : options.envelope?.error };
	} else if (!batch) {
		recovery.healed = stopVerified === true;
		envelope = { success: recovery.healed, data, error: recovery.healed ? undefined : attemptError };
	}
	if (!recovery.healed) {
		presentation.resultCategory = "failure";
		presentation.failureCategory = options.processResult.timedOut ? "timeout" : "upstream-error";
		presentation.successCategory = undefined;
		presentation.summary = `${attemptError} ${recovery.reason}`;
	}
	const followups: AgentBrowserNextAction[] = options.sessionName && !recovery.healed ? [{
		id: "inspect-recording-receipt", tool: "agent_browser", params: { args: ["--namespace", options.namespace ?? "", "--session", options.sessionName, "session", "info"] },
		reason: "Inspect the native current/last recording receipts for this exact session.", safety: "Read-only status; does not launch or retarget the browser. Do not infer encoding success from an existing file.",
	}] : [];
	if (current && receipt && current.recordingId === receipt.recordingId && recovery.status === "pending" && options.sessionName) followups.push({
		id: "stop-pending-recording", tool: "agent_browser", params: { args: ["--namespace", options.namespace ?? "", "--session", options.sessionName, "record", "stop"] },
		reason: `Finalize the still-current native recording ${receipt.recordingId}; it has not reported a terminal outcome.`, safety: "Run only while this same recording remains current. No repeated stop was dispatched during recovery.",
	});
	presentation.nextActions = followups;
	presentation.recordingRecovery = recovery;
	const text = `Recording receipt recovery (${recovery.status}): ${recovery.reason}\nOriginal attempt: ${attemptError}`;
	presentation.content.unshift({ type: "text", text });
	return { batch, envelope, partialBatch: batch && !rows, stopIndex, presentation, recovery };
}

export function mergeRecordingRecoveryPresentation(base: ToolPresentation, result: RecordingStopRecoveryResult): ToolPresentation {
	if (!result.batch) return result.presentation;
	const artifacts = result.partialBatch ? [...(base.artifacts ?? []), ...(result.presentation.artifacts ?? [])] : base.artifacts;
	const laterRecording = base.batchSteps?.slice(result.stopIndex + 1).some(step => step.artifacts?.some(isPendingRecordingArtifact));
	const unrelatedFailure = base.batchFailure && !isStop(base.batchFailure.failedStep.command ?? []);
	const nextActions = (base.nextActions ?? []).filter(action => action.id === "stop-pending-recording" ? laterRecording : unrelatedFailure);
	appendUniqueAgentBrowserNextActions(nextActions, result.presentation.nextActions);
	return {
		...base, artifacts, artifactVerification: buildArtifactVerificationSummary(artifacts ?? []),
		batchSteps: base.batchSteps?.map((step) => step.index === result.stopIndex ? { ...step, artifacts: result.presentation.artifacts, artifactVerification: result.presentation.artifactVerification } : step),
		artifactManifest: result.partialBatch ? mergeSessionArtifactManifest({ base: base.artifactManifest, entries: buildManifestEntriesForFileArtifacts(result.presentation.artifacts ?? []) }) : base.artifactManifest,
		content: [...base.content, ...(result.partialBatch ? result.presentation.content : result.presentation.content.slice(0, 1))],
		nextActions,
		recordingRecovery: result.recovery,
	};
}
