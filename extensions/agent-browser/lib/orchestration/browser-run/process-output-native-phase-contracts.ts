import type {
	ParseFailureOutput,
	ProcessBrowserOutputInput,
	ScreenshotArtifactRequest,
	PreparedBrowserRun,
	BrowserRunState,
} from "./types.js";
import type {
	AgentBrowserEnvelope,
	NetworkRouteRecord,
	SessionArtifactManifest,
} from "../../results/contracts.js";
import type { ReadConfirmation } from "../../read-confirmation.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import type { RecordingStopRecoveryResult } from "./recording-recovery.js";
import type { SuccessfulBatchCloseLifecycle } from "../../batch-lifecycle.js";
// This call owns native receipt reduction. The transferred recording presentation is an
// assembly handle; all published native evidence and borrowed ownership fields stay readonly.
export interface NativeOutputPhase {
	readonly input: Readonly<
		Pick<
			ProcessBrowserOutputInput,
			| "artifactRunStartedAtMs"
			| "ctx"
			| "cwd"
			| "modelVisible"
			| "processResult"
			| "sessionPageStateUpdate"
			| "signal"
		>
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "commandTokens"
				| "exactSensitiveValues"
				| "executionPlan"
				| "preparedArgs"
				| "processArgs"
				| "readConfirmation"
				| "runtimeToolArgs"
				| "runtimeToolStdin"
			>
		>;
	} & { readonly state: BrowserRunState };
	readonly artifactManifest: SessionArtifactManifest | undefined;
	batchCommandSteps: readonly (readonly string[])[];
	batchScreenshotArtifactRequests: readonly (ScreenshotArtifactRequest | undefined)[] | undefined;
	browserIndependentRead: boolean;
	closeAllApplied: boolean;
	confirmedCommand: string | undefined;
	confirmedData: unknown;
	confirmedEffects: readonly {
		readonly command: string;
		readonly data: unknown;
		readonly index: number;
		readonly succeeded: boolean;
	}[];
	destinationTransition: boolean;
	directClose: boolean;
	directCloseAllRequested: boolean;
	dispatchedCommands: readonly (readonly string[])[];
	inspectionText: string | undefined;
	nativeCommandMayHaveExecuted: boolean;
	nestedBatchClose: SuccessfulBatchCloseLifecycle | undefined;
	nestedBatchClosed: boolean;
	nestedBatchRemainsActive: boolean;
	networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
	parseError: string | undefined;
	parseFailureOutput: ParseFailureOutput;
	parseSucceeded: boolean;
	parsed: {
		readonly envelope?: AgentBrowserEnvelope | undefined;
		readonly parseError?: string | undefined;
	};
	persistentArtifactStore: PersistentSessionArtifactStore | undefined;
	plainTextInspection: boolean;
	plainTextUpgrade: boolean;
	presentationEnvelope: AgentBrowserEnvelope | undefined;
	processSucceeded: boolean;
	rawCloseStatePath: string | undefined;
	readConfirmation: ReadConfirmation | undefined;
	readConfirmationEvent: ReadConfirmation | undefined;
	recordingStopRecovery: RecordingStopRecoveryResult | undefined;
	screenshotArtifactRequest: ScreenshotArtifactRequest | undefined;
	sessionStateKey: string | undefined;
	succeeded: boolean;
	textOutput: boolean;
	unobservedMutation: boolean;
}
export type NativeOutputEvidence = Readonly<
	Pick<
		NativeOutputPhase,
		| "artifactManifest"
		| "batchCommandSteps"
		| "batchScreenshotArtifactRequests"
		| "browserIndependentRead"
		| "closeAllApplied"
		| "confirmedCommand"
		| "confirmedData"
		| "confirmedEffects"
		| "destinationTransition"
		| "directClose"
		| "dispatchedCommands"
		| "inspectionText"
		| "nativeCommandMayHaveExecuted"
		| "nestedBatchClose"
		| "nestedBatchClosed"
		| "nestedBatchRemainsActive"
		| "networkRoutesBySession"
		| "parseError"
		| "parseFailureOutput"
		| "parseSucceeded"
		| "persistentArtifactStore"
		| "plainTextInspection"
		| "plainTextUpgrade"
		| "presentationEnvelope"
		| "processSucceeded"
		| "rawCloseStatePath"
		| "readConfirmation"
		| "readConfirmationEvent"
		| "recordingStopRecovery"
		| "screenshotArtifactRequest"
		| "sessionStateKey"
		| "succeeded"
		| "textOutput"
		| "unobservedMutation"
	>
>;
