import type {
	AgentBrowserEnvelope,
	AgentBrowserNextAction,
	ToolPresentation,
} from "../../results/contracts.js";
import type { ToolPresentationObservation } from "../../results/presentation/observation-contracts.js";
import type { RecordingRecovery } from "../../results/evidence-contracts.js";
import { buildToolPresentation } from "../../results/presentation.js";
import { isRecord } from "../../parsing.js";
import {
	anotherTakeUsesPath,
	type RecordingReceiptEvidence,
} from "./recording-receipt-reconciliation.js";
import type {
	RecordingRecoveryOptions,
	RecordingRecoveryPlan,
} from "./recording-recovery-contracts.js";

export function recordingRecoveryData(
	plan: RecordingRecoveryPlan,
	evidence: RecordingReceiptEvidence,
): unknown {
	return (
		evidence.data ??
		(plan.expected
			? { path: plan.expected.absolutePath, recordingId: plan.expected.recordingId, success: null }
			: undefined)
	);
}

export async function presentRecordingReceipt(
	options: RecordingRecoveryOptions,
	plan: RecordingRecoveryPlan,
	evidence: RecordingReceiptEvidence,
	terminalMeasurements: boolean,
): Promise<ToolPresentation> {
	const expected = plan.expected;
	const data = recordingRecoveryData(plan, evidence);
	return buildToolPresentation({
		modelVisible: options.modelVisible,
		artifactManifest: options.artifactManifest,
		artifactMinUpdatedAtMs: expected?.startedAtMs ?? options.artifactRunStartedAtMs,
		artifactMaxUpdatedAtMs: Date.now(),
		artifactRequest: expected
			? {
					path: expected.path,
					absolutePath: expected.absolutePath,
					status: terminalMeasurements ? undefined : "unverified",
				}
			: undefined,
		commandInfo: { command: "record", subcommand: "stop" },
		cwd: expected?.cwd ?? options.cwd,
		envelope: { success: evidence.receipt?.success === true, data },
		namespace: options.namespace,
		sessionName: options.sessionName,
		recordingPending: evidence.receipt
			? evidence.receipt.success === null
			: options.processResult.timedOut,
	});
}

export function classifyRecordingRecovery(
	evidence: RecordingReceiptEvidence,
	plan: RecordingRecoveryPlan,
	verified: boolean,
): Pick<RecordingRecovery, "status" | "reason"> {
	const receipt = evidence.receipt;
	if (!receipt) {
		return { status: evidence.status, reason: evidence.reason };
	}
	if (verified) {
		return {
			status: "recovered",
			reason:
				"Native terminal success and encoder measurements match the expected recording and the verified file.",
		};
	}
	if (receipt.success === null) {
		return {
			status: "pending",
			reason: "The matching native take is still pending; no terminal success was reported.",
		};
	}
	if (!receipt.success) {
		return {
			status: "failed",
			reason: `The matching native receipt reports failure: ${receipt.error ?? "unknown encoder/capture failure"}.`,
		};
	}
	return {
		status: "unverified",
		reason: anotherTakeUsesPath(evidence, plan.expected)
			? "Another active recording uses this path. The previous receipt cannot verify the new take's file."
			: "A matching receipt was found, but successful encoding and a matching fresh file could not both be verified.",
	};
}

export function repairRecordingEnvelope(
	options: RecordingRecoveryOptions,
	plan: RecordingRecoveryPlan,
	data: unknown,
	verified: boolean,
): { readonly envelope?: AgentBrowserEnvelope; readonly healed: boolean } {
	if (plan.rows) {
		const rows = plan.rows.map((row, position) =>
			position === plan.stopPosition && isRecord(row)
				? { ...row, result: data, success: verified, error: verified ? undefined : row.error }
				: row,
		);
		const healed =
			verified &&
			!options.processResult.timedOut &&
			rows.every((row) => isRecord(row) && row.success === true);
		return {
			healed,
			envelope: {
				success: healed,
				data: rows,
				error: healed ? undefined : options.envelope?.error,
			},
		};
	}
	if (!plan.batch) {
		return {
			healed: verified,
			envelope: { success: verified, data, error: verified ? undefined : plan.attempt.error },
		};
	}
	return { healed: false, envelope: options.envelope };
}

function recordingSessionArgs(
	options: RecordingRecoveryOptions,
	command: readonly string[],
): string[] {
	return [
		"--namespace",
		options.namespace ?? "",
		"--session",
		options.sessionName ?? "",
		...command,
	];
}

function pendingTakeIsCurrent(
	evidence: RecordingReceiptEvidence,
	recovery: RecordingRecovery,
): boolean {
	return (
		evidence.current !== undefined &&
		evidence.receipt !== undefined &&
		evidence.current.recordingId === evidence.receipt.recordingId &&
		recovery.status === "pending"
	);
}

function buildRecordingFollowups(
	options: RecordingRecoveryOptions,
	evidence: RecordingReceiptEvidence,
	recovery: RecordingRecovery,
): AgentBrowserNextAction[] {
	if (options.sessionName === undefined || options.sessionName === "") {
		return [];
	}
	const actions: AgentBrowserNextAction[] = recovery.healed
		? []
		: [
				{
					id: "inspect-recording-receipt",
					tool: "agent_browser",
					params: { args: recordingSessionArgs(options, ["session", "info"]) },
					reason: "Inspect the native current/last recording receipts for this exact session.",
					safety:
						"Read-only status; does not launch or retarget the browser. Do not infer encoding success from an existing file.",
				},
			];
	if (pendingTakeIsCurrent(evidence, recovery)) {
		actions.push({
			id: "stop-pending-recording",
			tool: "agent_browser",
			params: { args: recordingSessionArgs(options, ["record", "stop"]) },
			reason: `Finalize the still-current native recording ${evidence.receipt?.recordingId ?? "null"}; it has not reported a terminal outcome.`,
			safety:
				"Run only while this same recording remains current. No repeated stop was dispatched during recovery.",
		});
	}
	return actions;
}

export function finishRecordingPresentation(
	options: RecordingRecoveryOptions,
	presentation: ToolPresentationObservation,
	evidence: RecordingReceiptEvidence,
	recovery: RecordingRecovery,
): ToolPresentation {
	const content = [...presentation.content];
	if (options.modelVisible !== false) {
		content.unshift({
			type: "text",
			text: `Recording receipt recovery (${recovery.status}): ${recovery.reason}\nOriginal attempt: ${recovery.attempt.error}`,
		});
	}
	const failure: Partial<
		Pick<ToolPresentation, "resultCategory" | "failureCategory" | "successCategory" | "summary">
	> = recovery.healed
		? {}
		: {
				resultCategory: "failure",
				failureCategory: options.processResult.timedOut ? "timeout" : "upstream-error",
				successCategory: undefined,
				summary: `${recovery.attempt.error} ${recovery.reason}`,
			};
	return {
		...presentation,
		...failure,
		content,
		nextActions: buildRecordingFollowups(options, evidence, recovery),
		recordingRecovery: recovery,
	};
}
