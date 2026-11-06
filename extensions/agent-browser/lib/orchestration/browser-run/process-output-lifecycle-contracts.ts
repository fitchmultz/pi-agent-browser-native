import type { ProcessBrowserOutputInput, PreparedBrowserRun, BrowserRunState } from "./types.js";
import type { NativeOutputPhase } from "./process-output-native-phase-contracts.js";
export type ObserveCloseLifecycleInput = Readonly<
	Pick<
		NativeOutputPhase,
		| "batchCommandSteps"
		| "confirmedData"
		| "directClose"
		| "dispatchedCommands"
		| "presentationEnvelope"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
	};
};
export type RedactNativeEnvelopeInput = Readonly<
	Pick<NativeOutputPhase, "parseError" | "presentationEnvelope">
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "exactSensitiveValues">>;
	};
};
export type ClassifyNativeExecutionInput = Readonly<
	Pick<
		NativeOutputPhase,
		"nativeCommandMayHaveExecuted" | "parseError" | "recordingStopRecovery" | "presentationEnvelope"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">>;
		readonly state: BrowserRunState;
	};
};
export type ObserveInterruptedMutationInput = Readonly<
	Pick<
		NativeOutputPhase,
		| "batchCommandSteps"
		| "directCloseAllRequested"
		| "nestedBatchClosesAll"
		| "parseSucceeded"
		| "plainTextInspection"
		| "presentationEnvelope"
		| "succeeded"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
	};
};
export type ApplyCloseAndTraceLifecycleInput = Readonly<
	Pick<
		NativeOutputPhase,
		| "batchCommandSteps"
		| "closeAllApplied"
		| "directClose"
		| "dispatchedCommands"
		| "nestedBatchClose"
		| "nestedBatchRemainsActive"
		| "presentationEnvelope"
		| "sessionStateKey"
		| "succeeded"
		| "networkRoutesBySession"
	>
> & {
	readonly input: Readonly<
		Pick<ProcessBrowserOutputInput, "processResult" | "sessionPageStateUpdate">
	> & { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } & {
		readonly state: BrowserRunState;
	};
};

export type ObserveNativePolicyExecutionInput = Readonly<Pick<NativeOutputPhase, "parsed">> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "commandTokens" | "readConfirmation" | "runtimeToolStdin">
		>;
	};
};

export type NormalizeStreamEnableNoopInput = Readonly<
	Pick<NativeOutputPhase, "presentationEnvelope">
> & {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> };
};
export type ClearReopenedTabLatchInput = Readonly<
	Pick<NativeOutputPhase, "dispatchedCommands" | "sessionStateKey">
> & {
	readonly input: Readonly<
		Pick<ProcessBrowserOutputInput, "processResult" | "sessionPageStateUpdate">
	> & { readonly state: BrowserRunState };
};
export type ApplyOutputCloseScopeInput = Readonly<
	Pick<
		NativeOutputPhase,
		| "closeAllApplied"
		| "nestedBatchClose"
		| "nestedBatchRemainsActive"
		| "sessionStateKey"
		| "networkRoutesBySession"
	>
> & {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } & {
		readonly state: BrowserRunState;
	};
};
export type RestoreConfirmActionsAfterRelaunchInput = Readonly<
	Pick<NativeOutputPhase, "nestedBatchRemainsActive" | "sessionStateKey">
> & { readonly input: { readonly state: BrowserRunState } };
export type FoldTraceOwnershipInput = Readonly<
	Pick<
		NativeOutputPhase,
		"batchCommandSteps" | "directClose" | "presentationEnvelope" | "sessionStateKey" | "succeeded"
	>
> & {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } & {
		readonly state: BrowserRunState;
	};
};

export type FoldBatchTraceRowInput = Readonly<
	Pick<NativeOutputPhase, "batchCommandSteps" | "sessionStateKey">
> & { readonly input: { readonly state: BrowserRunState } };
export type PruneNamespaceNetworkRoutesInput = Readonly<
	Pick<NativeOutputPhase, "networkRoutesBySession">
> & {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> };
};
