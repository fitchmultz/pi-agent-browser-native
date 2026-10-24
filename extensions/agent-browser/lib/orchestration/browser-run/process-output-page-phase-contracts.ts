import type {
	AboutBlankSessionMismatch,
	ProcessBrowserOutputInput,
	NavigationSummary,
	ClickDispatchDiagnostic,
	ElectronPostCommandHealthDiagnostic,
	ElectronSessionMismatch,
	TimeoutPartialProgress,
	PreparedBrowserRun,
	BrowserRunState,
} from "./types.js";
import type { ElectronLaunchStatus } from "../../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type { AgentBrowserEnvelope, NetworkRouteRecord } from "../../results/contracts.js";
import type {
	SessionRefSnapshot,
	SessionRefSnapshotInvalidation,
	BatchRefSnapshotState,
	SessionTabTarget,
} from "../../session-page-state.js";
import type { ReadConfirmation } from "../../read-confirmation.js";
import type { RecordingStopRecoveryResult } from "./recording-recovery.js";
import type { SuccessfulBatchCloseLifecycle } from "../../batch-lifecycle.js";
import type { OpenResultTabCorrection } from "../../runtime-contracts.js";
import type { PageDiagnostics } from "./process-output-diagnostics.js";
// Page observation owns only derived target/ref/diagnostic outputs; native facts are borrowed.
export interface PageOutputPhase {
	readonly input: Readonly<
		Pick<
			ProcessBrowserOutputInput,
			| "cwd"
			| "electronPostCommandStatusSettleMs"
			| "operationCwd"
			| "processResult"
			| "sessionPageStateUpdate"
			| "signal"
		>
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "callerColdLaunch"
				| "clickDispatchProbe"
				| "commandTokens"
				| "compiledJob"
				| "compiledSemanticAction"
				| "executionPlan"
				| "priorRefSnapshotState"
				| "priorSessionTabTarget"
				| "priorSessionTabTargetUnknown"
				| "readConfirmation"
				| "resolvedSemanticActionRefSnapshot"
				| "runtimeToolStdin"
				| "scrollPositionBefore"
				| "sessionTabCorrection"
				| "sessionTabPinningReason"
				| "shouldProbeScrollNoop"
			>
		>;
	} & { readonly state: BrowserRunState };
	aboutBlankSessionMismatch: AboutBlankSessionMismatch | undefined;
	activeNetworkRoutes: readonly NetworkRouteRecord[] | undefined;
	diagnostics: PageDiagnostics;
	readonly batchCommandSteps: readonly (readonly string[])[];
	batchRefSnapshotState: BatchRefSnapshotState | undefined;
	readonly browserIndependentRead: boolean;
	clickDispatchDiagnostic: ClickDispatchDiagnostic | undefined;
	confirmationFromHelper: boolean;
	readonly confirmedCommand: string | undefined;
	readonly confirmedData: unknown;
	readonly confirmedEffects: readonly {
		readonly command: string;
		readonly data: unknown;
		readonly index: number;
		readonly succeeded: boolean;
	}[];
	currentRefSnapshot: SessionRefSnapshot | undefined;
	currentRefSnapshotInvalidation: SessionRefSnapshotInvalidation | undefined;
	currentSessionTabTarget: SessionTabTarget | undefined;
	readonly destinationTransition: boolean;
	readonly directClose: boolean;
	readonly dispatchedCommands: readonly (readonly string[])[];
	electronPostCommandHealth: ElectronPostCommandHealthDiagnostic | undefined;
	electronRecordForCommand: ElectronLaunchRecord | undefined;
	electronSessionMismatch: ElectronSessionMismatch | undefined;
	electronStatusAfterCommand: ElectronLaunchStatus | undefined;
	failedTransitionReverification: boolean;
	readonly nativeCommandMayHaveExecuted: boolean;
	navigationSummary: NavigationSummary | undefined;
	readonly nestedBatchClose: SuccessfulBatchCloseLifecycle | undefined;
	readonly nestedBatchClosed: boolean;
	networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
	observedSessionTabTarget: SessionTabTarget | undefined;
	openResultTabCorrection: OpenResultTabCorrection | undefined;
	presentationEnvelope: AgentBrowserEnvelope | undefined;
	readonly processSucceeded: boolean;
	readConfirmation: ReadConfirmation | undefined;
	readConfirmationEvent: ReadConfirmation | undefined;
	readonly recordingStopRecovery: RecordingStopRecoveryResult | undefined;
	resultingPageState: {
		readonly currentPageUrl?: string | undefined;
		readonly pageTargetMayHaveChanged: boolean;
		readonly pageUrlUnknown: boolean;
	};
	readonly sessionStateKey: string | undefined;
	sessionTabCorrection: OpenResultTabCorrection | undefined;
	succeeded: boolean;
	tabTransition: boolean;
	readonly textOutput: boolean;
	timeoutPartialProgress: TimeoutPartialProgress | undefined;
	trustsReportedPageTarget: boolean;
	readonly unobservedMutation: boolean;
	unsettledWebMcpMutation: boolean;
}
export type PageOutputEvidence = Readonly<
	Pick<
		PageOutputPhase,
		| "aboutBlankSessionMismatch"
		| "activeNetworkRoutes"
		| "diagnostics"
		| "batchRefSnapshotState"
		| "clickDispatchDiagnostic"
		| "confirmationFromHelper"
		| "confirmedEffects"
		| "currentRefSnapshot"
		| "currentRefSnapshotInvalidation"
		| "currentSessionTabTarget"
		| "directClose"
		| "electronPostCommandHealth"
		| "electronSessionMismatch"
		| "navigationSummary"
		| "nestedBatchClosed"
		| "networkRoutesBySession"
		| "observedSessionTabTarget"
		| "openResultTabCorrection"
		| "presentationEnvelope"
		| "processSucceeded"
		| "readConfirmationEvent"
		| "recordingStopRecovery"
		| "sessionStateKey"
		| "sessionTabCorrection"
		| "succeeded"
		| "textOutput"
		| "timeoutPartialProgress"
		| "unobservedMutation"
		| "unsettledWebMcpMutation"
	>
>;
