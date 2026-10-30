import {
	isPendingRecordingArtifact,
	mergeSessionArtifactManifest,
} from "../../results/artifact-manifest.js";
import type { ToolPresentationObservation } from "../../results/presentation/observation-contracts.js";
import type { ToolPresentation } from "../../results/contracts.js";
import type { RecordingRecovery } from "../../results/evidence-contracts.js";
import { appendUniqueAgentBrowserNextActions } from "../../results/next-actions.js";
import {
	buildArtifactVerificationSummary,
	buildManifestEntriesForFileArtifacts,
} from "../../results/presentation/artifacts.js";
import {
	collectRecordingReceiptEvidence,
	isRecordingStop,
	planRecordingRecovery,
	recordingHasTerminalMeasurements,
} from "./recording-receipt-reconciliation.js";
import {
	classifyRecordingRecovery,
	finishRecordingPresentation,
	presentRecordingReceipt,
	repairRecordingEnvelope,
	recordingRecoveryData,
} from "./recording-recovery-presentation.js";
import type {
	RecordingRecoveryOptions,
	RecordingStopRecoveryResult,
	RecordingStopRecoveryObservation,
} from "./recording-recovery-contracts.js";

export type { RecordingStopRecoveryResult } from "./recording-recovery-contracts.js";
export type { RecordingRecovery } from "../../results/evidence-contracts.js";

export async function recoverRecordingStop(
	options: RecordingRecoveryOptions,
): Promise<RecordingStopRecoveryResult | undefined> {
	const plan = planRecordingRecovery(options);
	if (!plan) {
		return undefined;
	}
	const evidence = await collectRecordingReceiptEvidence(options, plan.expected);
	const terminalMeasurements = recordingHasTerminalMeasurements(evidence, plan.expected);
	const presentation = await presentRecordingReceipt(options, plan, evidence, terminalMeasurements);
	const verified =
		terminalMeasurements &&
		presentation.artifactVerification?.verified === true &&
		presentation.artifacts?.at(0)?.sizeBytes === evidence.receipt?.file.sizeBytes;
	const data = recordingRecoveryData(plan, evidence);
	const repaired = repairRecordingEnvelope(options, plan, data, verified);
	const recovery: RecordingRecovery = {
		attempt: plan.attempt,
		expected: plan.expected,
		healed: repaired.healed,
		namespace: options.namespace,
		sessionName: options.sessionName,
		source: "session-info",
		receipt: evidence.receipt,
		...classifyRecordingRecovery(evidence, plan, verified),
	};
	return {
		batch: plan.batch,
		envelope: repaired.envelope,
		partialBatch: plan.batch && plan.rows === undefined,
		stopPosition: plan.stopPosition,
		presentation: finishRecordingPresentation(options, presentation, evidence, recovery),
		recovery,
	};
}

function mergeRecoveryNextActions(
	base: ToolPresentationObservation,
	result: RecordingStopRecoveryObservation,
): NonNullable<ToolPresentation["nextActions"]> {
	const laterRecording =
		base.batchSteps
			?.slice(result.stopPosition + 1)
			.some((step) => step.artifacts?.some(isPendingRecordingArtifact) === true) === true;
	const unrelatedFailure =
		base.batchFailure !== undefined && !isRecordingStop(base.batchFailure.failedStep.command ?? []);
	const nextActions = (base.nextActions ?? []).filter((action) =>
		action.id === "stop-pending-recording" ? laterRecording : unrelatedFailure,
	);
	appendUniqueAgentBrowserNextActions(nextActions, result.presentation.nextActions);
	return nextActions;
}

export function mergeRecordingRecoveryPresentation(
	base: ToolPresentationObservation,
	result: RecordingStopRecoveryObservation,
): ToolPresentation {
	if (!result.batch) {
		return { ...result.presentation, content: [...result.presentation.content] };
	}
	const artifacts = result.partialBatch
		? [...(base.artifacts ?? []), ...(result.presentation.artifacts ?? [])]
		: base.artifacts;
	return {
		...base,
		artifacts,
		artifactVerification: buildArtifactVerificationSummary(artifacts ?? []),
		batchSteps: base.batchSteps?.map((step, position) =>
			position === result.stopPosition
				? {
						...step,
						artifacts: result.presentation.artifacts,
						artifactVerification: result.presentation.artifactVerification,
					}
				: step,
		),
		artifactManifest: result.partialBatch
			? mergeSessionArtifactManifest({
					base: base.artifactManifest,
					entries: buildManifestEntriesForFileArtifacts(result.presentation.artifacts ?? []),
				})
			: base.artifactManifest,
		content: [
			...base.content,
			...(result.partialBatch
				? result.presentation.content
				: result.presentation.content.slice(0, 1)),
		],
		nextActions: mergeRecoveryNextActions(base, result),
		recordingRecovery: result.recovery,
	};
}
