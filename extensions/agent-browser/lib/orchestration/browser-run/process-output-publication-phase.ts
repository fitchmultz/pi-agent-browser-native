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
		ownStepPageCheck: page.ownStepPageCheck,
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
	draft.presentation = await renderNativePresentation(draft);
	const { presentationUpdate: classification, ...reclassified } = reclassifyPresentation(draft);
	Object.assign(draft, reclassified);
	Object.assign(draft.presentation, classification);
	const { presentationUpdate, ...analysis } = await analyzeOutputChecks(draft);
	Object.assign(draft, analysis);
	Object.assign(draft.presentation, presentationUpdate);
	const banner = renderAttachedQaBanner(draft);
	draft.managedSessionOutcome = banner.managedSessionOutcome;
	if (banner.content) {
		draft.presentation.content = banner.content;
	}
	Object.assign(draft, collectEvalGuidance(draft));
	const [warnings, recovery] = await Promise.all([
		collectPublicationWarnings(draft),
		recoverFinalOutput(draft),
	]);
	Object.assign(draft, warnings, {
		currentRefSnapshot: recovery.currentRefSnapshot,
		currentRefSnapshotInvalidation: recovery.currentRefSnapshotInvalidation,
	});
	Object.assign(draft, await bindOutputDaemonReceipt(draft));
	const snapshot = publishConfirmedSnapshot(draft);
	Object.assign(draft, snapshot);
	if (snapshot.readConfirmationEvent) {
		draft.presentation.readConfirmation = snapshot.readConfirmationEvent;
	}
	return { publication: draft, recovery };
}
