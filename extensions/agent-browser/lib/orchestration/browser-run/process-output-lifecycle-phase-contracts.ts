import type {
	AboutBlankSessionMismatch,
	ProcessBrowserOutputInput,
	TimeoutPartialProgress,
	ManagedSessionOutcome,
	ElectronHandoffSummary,
	PreparedBrowserRun,
	BrowserRunState,
} from "./types.js";
import type { ElectronCleanupResult } from "../../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type {
	AgentBrowserEnvelope,
	NetworkRouteRecord,
	SessionArtifactManifest,
} from "../../results/contracts.js";
import type {
	SessionRefSnapshot,
	SessionRefSnapshotInvalidation,
	SessionTabTarget,
} from "../../session-page-state.js";
import type { ReadConfirmation } from "../../read-confirmation.js";
import type { RecordingStopRecoveryResult } from "./recording-recovery.js";
import type { CompatibilityWorkaround, OpenResultTabCorrection } from "../../runtime-contracts.js";
// This phase owns managed/Electron transitions and commits native ownership before rendering.
export interface LifecycleOutputPhase {
	readonly input: Readonly<
		Pick<
			ProcessBrowserOutputInput,
			| "cwd"
			| "implicitSessionCloseTimeoutMs"
			| "preserveAttachedBrowserSession"
			| "processResult"
			| "sessionPageStateUpdate"
			| "signal"
		>
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "commandTokens"
				| "compatibilityWorkaround"
				| "compiledElectron"
				| "electronFailedConnectCleanup"
				| "electronHandoff"
				| "electronLaunch"
				| "executionPlan"
				| "managedSessionPolicyLock"
				| "ownedManagedSessionContext"
				| "readConfirmation"
				| "redactedArgs"
				| "redactedProcessArgs"
				| "runtimeToolStdin"
				| "sessionMode"
				| "sessionTabPinningReason"
			>
		>;
	} & { readonly state: BrowserRunState };
	readonly aboutBlankSessionMismatch: AboutBlankSessionMismatch | undefined;
	readonly artifactManifest: SessionArtifactManifest | undefined;
	readonly closeAllApplied: boolean;
	closeCommandSucceeded: boolean;
	commandClosesSession: boolean;
	confirmationFromHelper: boolean;
	currentRefSnapshot: SessionRefSnapshot | undefined;
	currentRefSnapshotInvalidation: SessionRefSnapshotInvalidation | undefined;
	currentSessionTabTarget: SessionTabTarget | undefined;
	readonly directClose: boolean;
	electronFailedConnectCleanup: ElectronCleanupResult | undefined;
	electronHandoff: ElectronHandoffSummary | undefined;
	electronLaunchRecord: ElectronLaunchRecord | undefined;
	errorText: string | undefined;
	freshSessionOrdinal: number;
	managedCloseSessionName: string | undefined;
	managedSessionActive: boolean;
	managedSessionCompatibilityWorkaround: CompatibilityWorkaround | undefined;
	managedSessionCwd: string;
	managedSessionHeadedAutosaveInterval: string | undefined;
	managedSessionName: string;
	managedSessionNamespace: string | undefined;
	managedSessionOutcome: ManagedSessionOutcome | undefined;
	managedTransitionSucceeded: boolean;
	readonly nestedBatchClosed: boolean;
	readonly nestedBatchRemainsActive: boolean;
	networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
	readonly observedSessionTabTarget: SessionTabTarget | undefined;
	readonly openResultTabCorrection: OpenResultTabCorrection | undefined;
	readonly parseError: string | undefined;
	readonly parseSucceeded: boolean;
	readonly plainTextInspection: boolean;
	readonly plainTextUpgrade: boolean;
	presentationEnvelope: AgentBrowserEnvelope | undefined;
	priorManagedSessionActive: boolean;
	priorManagedSessionCwd: string;
	priorManagedSessionHeadedAutosaveInterval: string | undefined;
	priorManagedSessionName: string;
	priorManagedSessionNamespace: string | undefined;
	readonly processSucceeded: boolean;
	readonly rawCloseStatePath: string | undefined;
	readConfirmationEvent: ReadConfirmation | undefined;
	readonly recordingStopRecovery: RecordingStopRecoveryResult | undefined;
	replacedManagedSessionName: string | undefined;
	resultHeadedManagedAutosaveInterval: string | undefined;
	readonly sessionStateKey: string | undefined;
	readonly sessionTabCorrection: OpenResultTabCorrection | undefined;
	succeeded: boolean;
	readonly textOutput: boolean;
	readonly timeoutPartialProgress: TimeoutPartialProgress | undefined;
}
export type LifecycleOutputEvidence = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "aboutBlankSessionMismatch"
		| "artifactManifest"
		| "closeAllApplied"
		| "commandClosesSession"
		| "confirmationFromHelper"
		| "currentRefSnapshot"
		| "currentRefSnapshotInvalidation"
		| "currentSessionTabTarget"
		| "electronFailedConnectCleanup"
		| "electronHandoff"
		| "electronLaunchRecord"
		| "errorText"
		| "freshSessionOrdinal"
		| "managedSessionActive"
		| "managedSessionCompatibilityWorkaround"
		| "managedSessionCwd"
		| "managedSessionHeadedAutosaveInterval"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "managedSessionOutcome"
		| "networkRoutesBySession"
		| "openResultTabCorrection"
		| "parseError"
		| "parseSucceeded"
		| "plainTextInspection"
		| "plainTextUpgrade"
		| "presentationEnvelope"
		| "processSucceeded"
		| "readConfirmationEvent"
		| "recordingStopRecovery"
		| "resultHeadedManagedAutosaveInterval"
		| "sessionStateKey"
		| "sessionTabCorrection"
		| "succeeded"
		| "textOutput"
		| "timeoutPartialProgress"
	>
>;
