import type { NativeOutputEvidence } from "./process-output-native-phase-contracts.js";
import type { BrowserOutputOwnershipSnapshot } from "./process-output-ownership.js";
import type { PageOutputEvidence } from "./process-output-page-phase-contracts.js";
import type {
	LifecycleOutputPhase,
	LifecycleOutputEvidence,
} from "./process-output-lifecycle-phase-contracts.js";
import { observeFinalHelperConfirmation } from "./process-output-confirmation.js";
import { reconcileOutputPinning } from "./process-output-refs.js";
import {
	resolveManagedCloseTarget,
	inspectFailedFreshLaunch,
	resolveManagedTransition,
	retireReplacedSession,
} from "./process-output-managed.js";
import { reconcileElectronHandoff } from "./process-output-electron.js";
import { resolveOutputError } from "./process-output-errors.js";
import { commitObservedLifecycle } from "./process-output-receipts.js";
function createLifecycleOutputPhase(
	input: LifecycleOutputPhase["input"],
	native: NativeOutputEvidence,
	page: PageOutputEvidence,
	ownership: BrowserOutputOwnershipSnapshot,
): LifecycleOutputPhase {
	return {
		input,
		aboutBlankSessionMismatch: page.aboutBlankSessionMismatch,
		artifactManifest: native.artifactManifest,
		closeAllApplied: native.closeAllApplied,
		closeCommandSucceeded: false,
		commandClosesSession: false,
		confirmationFromHelper: page.confirmationFromHelper,
		currentRefSnapshot: page.currentRefSnapshot,
		currentRefSnapshotInvalidation: page.currentRefSnapshotInvalidation,
		currentSessionTabTarget: page.currentSessionTabTarget,
		directClose: page.directClose,
		electronFailedConnectCleanup: undefined,
		electronHandoff: undefined,
		electronLaunchRecord: undefined,
		errorText: undefined,
		freshSessionOrdinal: ownership.freshSessionOrdinal,
		managedCloseSessionName: undefined,
		managedSessionActive: ownership.managedSessionActive,
		managedSessionCompatibilityWorkaround: ownership.managedSessionCompatibilityWorkaround,
		managedSessionCwd: ownership.managedSessionCwd,
		managedSessionHeadedAutosaveDisabled: ownership.managedSessionHeadedAutosaveDisabled,
		managedSessionHeadedAutosaveInterval: ownership.managedSessionHeadedAutosaveInterval,
		managedSessionName: ownership.managedSessionName,
		managedSessionNamespace: ownership.managedSessionNamespace,
		managedSessionOutcome: undefined,
		managedTransitionSucceeded: false,
		nestedBatchClosed: page.nestedBatchClosed,
		nestedBatchRemainsActive: native.nestedBatchRemainsActive,
		networkRoutesBySession: page.networkRoutesBySession,
		observedSessionTabTarget: page.observedSessionTabTarget,
		openResultTabCorrection: page.openResultTabCorrection,
		parseError: native.parseError,
		parseSucceeded: native.parseSucceeded,
		plainTextInspection: native.plainTextInspection,
		plainTextUpgrade: native.plainTextUpgrade,
		presentationEnvelope: page.presentationEnvelope,
		priorManagedSessionActive: false,
		priorManagedSessionCwd: "",
		priorManagedSessionHeadedAutosaveInterval: undefined,
		priorManagedSessionName: "",
		priorManagedSessionNamespace: undefined,
		processSucceeded: page.processSucceeded,
		rawCloseStatePath: native.rawCloseStatePath,
		readConfirmationEvent: page.readConfirmationEvent,
		recordingStopRecovery: page.recordingStopRecovery,
		replacedManagedSessionName: undefined,
		resultHeadedManagedAutosaveDisabled: false,
		resultHeadedManagedAutosaveInterval: undefined,
		sessionStateKey: page.sessionStateKey,
		sessionTabCorrection: page.sessionTabCorrection,
		succeeded: page.succeeded,
		textOutput: page.textOutput,
		timeoutPartialProgress: page.timeoutPartialProgress,
	};
}
export async function commitLifecycleEffects(
	input: LifecycleOutputPhase["input"],
	native: NativeOutputEvidence,
	page: PageOutputEvidence,
	ownership: BrowserOutputOwnershipSnapshot,
): Promise<LifecycleOutputEvidence> {
	const draft = createLifecycleOutputPhase(input, native, page, ownership);
	Object.assign(draft, resolveManagedCloseTarget(draft));
	draft.managedTransitionSucceeded = await inspectFailedFreshLaunch(draft);
	Object.assign(draft, resolveManagedTransition(draft));
	reconcileOutputPinning(draft);
	Object.assign(draft, await retireReplacedSession(draft));
	Object.assign(draft, await reconcileElectronHandoff(draft));
	Object.assign(draft, resolveOutputError(draft));
	Object.assign(draft, observeFinalHelperConfirmation(draft));
	commitObservedLifecycle(draft);
	return {
		aboutBlankSessionMismatch: draft.aboutBlankSessionMismatch,
		artifactManifest: draft.artifactManifest,
		closeAllApplied: draft.closeAllApplied,
		commandClosesSession: draft.commandClosesSession,
		confirmationFromHelper: draft.confirmationFromHelper,
		currentRefSnapshot: draft.currentRefSnapshot,
		currentRefSnapshotInvalidation: draft.currentRefSnapshotInvalidation,
		currentSessionTabTarget: draft.currentSessionTabTarget,
		electronFailedConnectCleanup: draft.electronFailedConnectCleanup,
		electronHandoff: draft.electronHandoff,
		electronLaunchRecord: draft.electronLaunchRecord,
		errorText: draft.errorText,
		freshSessionOrdinal: draft.freshSessionOrdinal,
		managedSessionActive: draft.managedSessionActive,
		managedSessionCompatibilityWorkaround: draft.managedSessionCompatibilityWorkaround,
		managedSessionCwd: draft.managedSessionCwd,
		managedSessionHeadedAutosaveDisabled: draft.managedSessionHeadedAutosaveDisabled,
		managedSessionHeadedAutosaveInterval: draft.managedSessionHeadedAutosaveInterval,
		managedSessionName: draft.managedSessionName,
		managedSessionNamespace: draft.managedSessionNamespace,
		managedSessionOutcome: draft.managedSessionOutcome,
		networkRoutesBySession: draft.networkRoutesBySession,
		openResultTabCorrection: draft.openResultTabCorrection,
		parseError: draft.parseError,
		parseSucceeded: draft.parseSucceeded,
		plainTextInspection: draft.plainTextInspection,
		plainTextUpgrade: draft.plainTextUpgrade,
		presentationEnvelope: draft.presentationEnvelope,
		processSucceeded: draft.processSucceeded,
		readConfirmationEvent: draft.readConfirmationEvent,
		recordingStopRecovery: draft.recordingStopRecovery,
		resultHeadedManagedAutosaveDisabled: draft.resultHeadedManagedAutosaveDisabled,
		resultHeadedManagedAutosaveInterval: draft.resultHeadedManagedAutosaveInterval,
		sessionStateKey: draft.sessionStateKey,
		sessionTabCorrection: draft.sessionTabCorrection,
		succeeded: draft.succeeded,
		textOutput: draft.textOutput,
		timeoutPartialProgress: draft.timeoutPartialProgress,
	};
}
