import { resolve } from "node:path";
import { getAgentBrowserSessionIdentityKey } from "../../argv-grammar.js";
import { getRecordCommandOperands } from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import { extractEnvelopeErrorText } from "../../results/envelope.js";
import type {
	ActiveRecordingReservation,
	RecordingReceipt,
	RecordingRecovery,
} from "../../results/evidence-contracts.js";
import { getRecordingReceipt } from "../../results/recording.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { diagnosticErrorText } from "./diagnostic-values.js";
import { runSessionCommandData } from "./session-state.js";
import type {
	RecordingRecoveryOptions,
	RecordingRecoveryPlan,
} from "./recording-recovery-contracts.js";

export function isRecordingStop(tokens: readonly string[]): boolean {
	return tokens[0] === "record" && tokens[1] === "stop";
}

function rowError(row: unknown): unknown {
	return isRecord(row) ? row.error : undefined;
}

function rowResult(row: unknown): Readonly<Record<string, unknown>> | undefined {
	return isRecord(row) && isRecord(row.result) ? row.result : undefined;
}

function stopNeedsRecovery(options: RecordingRecoveryOptions, row: unknown): boolean {
	return (
		options.processResult.timedOut ||
		/no recording in progress/i.test(
			extractEnvelopeErrorText(rowError(row) ?? options.envelope?.error) ?? "",
		)
	);
}

function reservationForStart(
	options: RecordingRecoveryOptions,
	step: readonly string[],
	row: unknown,
): ActiveRecordingReservation | undefined {
	if (step[0] !== "record" || !["start", "restart"].includes(step[1] ?? "")) {
		return undefined;
	}
	if (isRecord(row) && row.success === false) {
		return undefined;
	}
	return buildStartReservation(options, step, rowResult(row));
}

function buildStartReservation(
	options: RecordingRecoveryOptions,
	step: readonly string[],
	started: Readonly<Record<string, unknown>> | undefined,
): ActiveRecordingReservation | undefined {
	const path =
		typeof started?.path === "string" ? started.path : getRecordCommandOperands(step).path;
	if (
		path === undefined ||
		path === "" ||
		options.sessionName === undefined ||
		options.sessionName === ""
	) {
		return undefined;
	}
	return {
		absolutePath: resolve(options.cwd, path),
		cwd: options.cwd,
		path,
		namespace: options.namespace,
		sessionName: options.sessionName,
		recordingId: typeof started?.recordingId === "string" ? started.recordingId : undefined,
		startedAtMs: options.artifactRunStartedAtMs,
	};
}

function recoverySource(options: RecordingRecoveryOptions): {
	readonly batch: boolean;
	readonly rows?: readonly unknown[];
	readonly steps: readonly (readonly string[])[];
} {
	const batch = options.commandTokens[0] === "batch";
	return {
		batch,
		steps: batch
			? getUpstreamEffectiveBatchSteps(options.commandTokens, options.stdin)
			: [options.commandTokens],
		rows: batch && Array.isArray(options.envelope?.data) ? options.envelope.data : undefined,
	};
}

function originalAttempt(
	options: RecordingRecoveryOptions,
	stopRow: unknown,
): RecordingRecovery["attempt"] {
	const error = options.processResult.timedOut
		? `Record stop timed out after ${options.processResult.timeoutMs ?? "undefined"} ms.`
		: (extractEnvelopeErrorText(rowError(stopRow) ?? options.envelope?.error) ??
			"Record stop did not return a receipt.");
	return {
		success: false,
		exitCode: options.processResult.exitCode,
		timedOut: options.processResult.timedOut,
		error,
		parseError: options.parseError,
	};
}

function recordingAttemptWasInterrupted(options: RecordingRecoveryOptions): boolean {
	return (
		options.processResult.aborted ||
		(options.signal?.aborted ?? false) ||
		!options.processResult.agentBrowserStarted
	);
}

export function planRecordingRecovery(
	options: RecordingRecoveryOptions,
): RecordingRecoveryPlan | undefined {
	if (recordingAttemptWasInterrupted(options)) {
		return undefined;
	}
	const { batch, steps, rows } = recoverySource(options);
	const stopPosition = steps.reduce(
		(last, step, position) =>
			isRecordingStop(step) && stopNeedsRecovery(options, rows?.at(position)) ? position : last,
		-1,
	);
	if (stopPosition < 0) {
		return undefined;
	}
	let expected = options.reservation;
	for (const [position, step] of steps.slice(0, stopPosition).entries()) {
		expected = reservationForStart(options, step, rows?.at(position)) ?? expected;
	}

	return {
		batch,
		rows,
		stopPosition,
		expected,
		attempt: originalAttempt(options, rows?.at(stopPosition)),
	};
}

function receiptMatches(
	receipt: RecordingReceipt,
	expected: ActiveRecordingReservation,
	nowMs: number,
): boolean {
	if (resolve(expected.cwd, receipt.path) !== expected.absolutePath) {
		return false;
	}
	if (expected.recordingId !== undefined && expected.recordingId !== "") {
		return receipt.recordingId === expected.recordingId;
	}
	const startedAtMs = Date.parse(receipt.capture.startedAt ?? "");
	return (
		expected.startedAtMs !== undefined &&
		startedAtMs >= expected.startedAtMs &&
		startedAtMs <= nowMs
	);
}

function sameNativeSession(info: unknown, options: RecordingRecoveryOptions): boolean {
	if (!isRecord(info) || typeof info.session !== "string" || options.sessionName === undefined) {
		return false;
	}
	return (
		getAgentBrowserSessionIdentityKey(
			info.session,
			typeof info.namespace === "string" ? info.namespace : undefined,
		) === getAgentBrowserSessionIdentityKey(options.sessionName, options.namespace)
	);
}

export interface RecordingReceiptEvidence {
	readonly current?: RecordingReceipt;
	readonly data?: unknown;
	readonly receipt?: RecordingReceipt;
	readonly reason: string;
	readonly status: RecordingRecovery["status"];
}

function reconcileNativeReceipts(
	info: unknown,
	options: RecordingRecoveryOptions,
	expected: ActiveRecordingReservation | undefined,
): RecordingReceiptEvidence {
	const recordings = nativeRecordingState(info);
	const current = getRecordingReceipt(recordings?.current);
	const unavailable: RecordingReceiptEvidence = {
		current,
		status: "unavailable",
		reason:
			"Native session info did not provide a matching recording receipt. File presence alone cannot prove successful recording finalization.",
	};
	if (!recordings) {
		return unavailable;
	}
	if (!sameNativeSession(info, options)) {
		return {
			current,
			status: "mismatch",
			reason:
				"Native session info reported a different namespace/session; its recording receipt was not used.",
		};
	}
	if (!expected) {
		return unavailable;
	}
	for (const candidate of [recordings.current, recordings.last]) {
		const receipt = getRecordingReceipt(candidate);
		if (receipt && receiptMatches(receipt, expected, Date.now())) {
			return { ...unavailable, receipt, data: candidate };
		}
	}
	return {
		current,
		status: "mismatch",
		reason:
			"Native recording IDs, paths or capture windows did not match this attempt; unrelated receipt measurements were not used.",
	};
}

function nativeRecordingState(info: unknown): Readonly<Record<string, unknown>> | undefined {
	const runtime = isRecord(info) && isRecord(info.runtime) ? info.runtime : undefined;
	return isRecord(runtime?.recording) ? runtime.recording : undefined;
}

export async function collectRecordingReceiptEvidence(
	options: RecordingRecoveryOptions,
	expected: ActiveRecordingReservation | undefined,
): Promise<RecordingReceiptEvidence> {
	try {
		const info = await runSessionCommandData({
			args: ["session", "info"],
			cwd: options.cwd,
			namespace: options.namespace,
			pinNamespace: true,
			sessionName: options.sessionName,
			signal: options.signal,
			timeoutMs: 2_000,
		});
		return reconcileNativeReceipts(info, options, expected);
	} catch (error) {
		return {
			status: "unavailable",
			reason: `Native session info was unavailable: ${diagnosticErrorText(error)}. File presence alone cannot prove successful recording finalization.`,
		};
	}
}

export function anotherTakeUsesPath(
	evidence: RecordingReceiptEvidence,
	expected: ActiveRecordingReservation | undefined,
): boolean {
	const { current, receipt } = evidence;
	return (
		current !== undefined &&
		receipt !== undefined &&
		expected !== undefined &&
		current.recordingId !== receipt.recordingId &&
		resolve(expected.cwd, current.path) === expected.absolutePath
	);
}

function encodedOutputIsComplete(receipt: RecordingReceipt): boolean {
	return (
		receipt.success === true &&
		receipt.output.encoderSucceeded === true &&
		receipt.output.encodedFrames !== null &&
		receipt.output.encodedFrames > 0 &&
		receipt.file.exists === true &&
		receipt.file.sizeBytes !== null &&
		receipt.file.sizeBytes > 0
	);
}

export function recordingHasTerminalMeasurements(
	evidence: RecordingReceiptEvidence,
	expected: ActiveRecordingReservation | undefined,
): boolean {
	const receipt = evidence.receipt;
	return (
		receipt !== undefined &&
		encodedOutputIsComplete(receipt) &&
		Number.isFinite(Date.parse(receipt.capture.startedAt ?? "")) &&
		Number.isFinite(Date.parse(receipt.capture.endedAt ?? "")) &&
		!anotherTakeUsesPath(evidence, expected)
	);
}
