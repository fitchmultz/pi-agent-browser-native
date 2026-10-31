import type { BrowserOutputOwnershipSnapshot } from "./process-output-ownership.js";
import type {
	NativeOutputPhase,
	NativeOutputEvidence,
} from "./process-output-native-phase-contracts.js";
import {
	parseNativeOutput,
	repairOutputScreenshots,
	resolveDispatchedCommands,
} from "./process-output-native.js";
import { foldReadConfirmations } from "./process-output-confirmation.js";
import {
	observeCloseLifecycle,
	redactNativeEnvelope,
	classifyNativeExecution,
	observeInterruptedMutation,
	applyCloseAndTraceLifecycle,
} from "./process-output-lifecycle.js";
function createNativeOutputPhase(
	input: NativeOutputPhase["input"],
	ownership: Readonly<
		Pick<BrowserOutputOwnershipSnapshot, "artifactManifest" | "networkRoutesBySession">
	>,
): NativeOutputPhase {
	return {
		input,
		artifactManifest: ownership.artifactManifest,
		batchCommandSteps: [],
		batchScreenshotArtifactRequests: undefined,
		browserIndependentRead: false,
		closeAllApplied: false,
		confirmedCommand: undefined,
		confirmedData: undefined,
		confirmedEffects: [],
		destinationTransition: false,
		directClose: false,
		directCloseAllRequested: false,
		dispatchedCommands: [],
		inspectionText: undefined,
		nativeCommandMayHaveExecuted: false,
		nestedBatchClose: undefined,
		nestedBatchClosed: false,
		nestedBatchRemainsActive: false,
		networkRoutesBySession: ownership.networkRoutesBySession,
		parseError: undefined,
		parseFailureOutput: {},
		parseSucceeded: false,
		parsed: {},
		persistentArtifactStore: undefined,
		plainTextInspection: false,
		plainTextUpgrade: false,
		presentationEnvelope: undefined,
		processSucceeded: false,
		rawCloseStatePath: undefined,
		readConfirmation: undefined,
		readConfirmationEvent: undefined,
		recordingStopRecovery: undefined,
		screenshotArtifactRequest: undefined,
		sessionStateKey: undefined,
		succeeded: false,
		textOutput: false,
		unobservedMutation: false,
	};
}
export async function observeNativeEffects(
	input: NativeOutputPhase["input"],
	ownership: Readonly<
		Pick<BrowserOutputOwnershipSnapshot, "artifactManifest" | "networkRoutesBySession">
	>,
): Promise<NativeOutputEvidence> {
	const draft = createNativeOutputPhase(input, ownership);
	await parseNativeOutput(draft);
	await repairOutputScreenshots(draft);
	resolveDispatchedCommands(draft);
	foldReadConfirmations(draft);
	observeCloseLifecycle(draft);
	redactNativeEnvelope(draft);
	classifyNativeExecution(draft);
	observeInterruptedMutation(draft);
	applyCloseAndTraceLifecycle(draft);
	return {
		artifactManifest: draft.artifactManifest,
		batchCommandSteps: draft.batchCommandSteps,
		batchScreenshotArtifactRequests: draft.batchScreenshotArtifactRequests,
		browserIndependentRead: draft.browserIndependentRead,
		closeAllApplied: draft.closeAllApplied,
		confirmedCommand: draft.confirmedCommand,
		confirmedData: draft.confirmedData,
		confirmedEffects: draft.confirmedEffects,
		destinationTransition: draft.destinationTransition,
		directClose: draft.directClose,
		dispatchedCommands: draft.dispatchedCommands,
		inspectionText: draft.inspectionText,
		nativeCommandMayHaveExecuted: draft.nativeCommandMayHaveExecuted,
		nestedBatchClose: draft.nestedBatchClose,
		nestedBatchClosed: draft.nestedBatchClosed,
		nestedBatchRemainsActive: draft.nestedBatchRemainsActive,
		networkRoutesBySession: draft.networkRoutesBySession,
		parseError: draft.parseError,
		parseFailureOutput: draft.parseFailureOutput,
		parseSucceeded: draft.parseSucceeded,
		persistentArtifactStore: draft.persistentArtifactStore,
		plainTextInspection: draft.plainTextInspection,
		plainTextUpgrade: draft.plainTextUpgrade,
		presentationEnvelope: draft.presentationEnvelope,
		processSucceeded: draft.processSucceeded,
		rawCloseStatePath: draft.rawCloseStatePath,
		readConfirmation: draft.readConfirmation,
		readConfirmationEvent: draft.readConfirmationEvent,
		recordingStopRecovery: draft.recordingStopRecovery,
		screenshotArtifactRequest: draft.screenshotArtifactRequest,
		sessionStateKey: draft.sessionStateKey,
		succeeded: draft.succeeded,
		textOutput: draft.textOutput,
		unobservedMutation: draft.unobservedMutation,
	};
}
