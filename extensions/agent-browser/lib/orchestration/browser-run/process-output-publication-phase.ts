import type { FinalRecoveryState } from "./types.js";
import type { NativeOutputEvidence } from "./process-output-native-phase-contracts.js";
import type { PageOutputEvidence } from "./process-output-page-phase-contracts.js";
import type { LifecycleOutputEvidence } from "./process-output-lifecycle-phase-contracts.js";
import type {
	PublicationOutputPhase,
	PublicationOutputEvidence,
} from "./process-output-publication-phase-contracts.js";
import { renderNativePresentation, reclassifyPresentation } from "./process-output-presentation.js";
import { bindOutputDaemonReceipt, publishConfirmedSnapshot } from "./process-output-receipts.js";
import {
	analyzeOutputChecks,
	renderAttachedQaBanner,
	collectEvalGuidance,
} from "./process-output-analysis.js";
import { collectPublicationWarnings, recoverFinalOutput } from "./process-output-publication.js";
function createPublicationOutputPhase(
	input: PublicationOutputPhase["input"],
	native: NativeOutputEvidence,
	page: PageOutputEvidence,
	lifecycle: LifecycleOutputEvidence,
): PublicationOutputPhase {
	return {
		input,
		aboutBlankSessionMismatch: lifecycle.aboutBlankSessionMismatch,
		activeNetworkRoutes: page.activeNetworkRoutes,
		artifactCleanup: undefined,
		artifactManifest: lifecycle.artifactManifest,
		authoritativePageState: undefined,
		batchRefSnapshotState: page.batchRefSnapshotState,
		batchScreenshotArtifactRequests: native.batchScreenshotArtifactRequests,
		commandClosesSession: lifecycle.commandClosesSession,
		confirmationFromHelper: lifecycle.confirmationFromHelper,
		confirmedEffects: page.confirmedEffects,
		currentRefSnapshot: lifecycle.currentRefSnapshot,
		currentRefSnapshotInvalidation: lifecycle.currentRefSnapshotInvalidation,
		currentSessionTabTarget: lifecycle.currentSessionTabTarget,
		currentSessionTabTargetUnknown: undefined,
		electronHandoff: lifecycle.electronHandoff,
		electronPostCommandHealth: page.electronPostCommandHealth,
		electronSessionMismatch: page.electronSessionMismatch,
		errorText: lifecycle.errorText,
		evalResultWarning: undefined,
		evalStdinHint: undefined,
		inspectionText: native.inspectionText,
		managedSessionOutcome: lifecycle.managedSessionOutcome,
		navigationSummary: page.navigationSummary,
		diagnostics: page.diagnostics,
		networkRoutesBySession: lifecycle.networkRoutesBySession,
		networkSourceLookup: undefined,
		operationCwd: input.operationCwd ?? input.cwd,
		parseError: lifecycle.parseError,
		parseFailureOutput: native.parseFailureOutput,
		parseSucceeded: lifecycle.parseSucceeded,
		persistentArtifactStore: native.persistentArtifactStore,
		plainTextInspection: lifecycle.plainTextInspection,
		plainTextUpgrade: lifecycle.plainTextUpgrade,
		presentation: { content: [], summary: "" },
		presentationEnvelope: lifecycle.presentationEnvelope,
		processSucceeded: lifecycle.processSucceeded,
		qaAttachedTarget: undefined,
		qaPreset: undefined,
		readConfirmationEvent: lifecycle.readConfirmationEvent,
		recordingStopRecovery: lifecycle.recordingStopRecovery,
		redactedContent: [],
		resultArtifactManifest: undefined,
		screenshotArtifactRequest: native.screenshotArtifactRequest,
		sessionStateKey: lifecycle.sessionStateKey,
		sessionTabCorrection: lifecycle.sessionTabCorrection,
		sourceLookup: undefined,
		succeeded: lifecycle.succeeded,
		textOutput: lifecycle.textOutput,
		unobservedMutation: page.unobservedMutation,
	};
}
export async function publishOutputEffects(
	input: PublicationOutputPhase["input"],
	native: NativeOutputEvidence,
	page: PageOutputEvidence,
	lifecycle: LifecycleOutputEvidence,
): Promise<{
	readonly publication: PublicationOutputEvidence;
	readonly recovery: FinalRecoveryState;
}> {
	const draft = createPublicationOutputPhase(input, native, page, lifecycle);
	await renderNativePresentation(draft);
	reclassifyPresentation(draft);
	await analyzeOutputChecks(draft);
	renderAttachedQaBanner(draft);
	collectEvalGuidance(draft);
	const [, recovery] = await Promise.all([
		collectPublicationWarnings(draft),
		recoverFinalOutput(draft),
	]);
	await bindOutputDaemonReceipt(draft);
	publishConfirmedSnapshot(draft);
	return { publication: draft, recovery };
}
