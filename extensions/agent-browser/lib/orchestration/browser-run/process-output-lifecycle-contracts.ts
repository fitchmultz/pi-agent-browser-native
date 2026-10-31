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
> &
	Pick<
		NativeOutputPhase,
		| "destinationTransition"
		| "directCloseAllRequested"
		| "nestedBatchClose"
		| "nestedBatchClosed"
		| "nestedBatchRemainsActive"
		| "rawCloseStatePath"
	> & {
		readonly input: {
			readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
		};
	};
export type RedactNativeEnvelopeInput = Readonly<Pick<NativeOutputPhase, "parseError">> &
	Pick<NativeOutputPhase, "parseFailureOutput" | "presentationEnvelope"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
			readonly prepared: Readonly<Pick<PreparedBrowserRun, "exactSensitiveValues">>;
		};
	};
export type ClassifyNativeExecutionInput = Readonly<
	Pick<NativeOutputPhase, "parseError" | "parsed" | "recordingStopRecovery">
> &
	Pick<
		NativeOutputPhase,
		| "browserIndependentRead"
		| "inspectionText"
		| "nativeCommandMayHaveExecuted"
		| "parseSucceeded"
		| "plainTextInspection"
		| "presentationEnvelope"
		| "processSucceeded"
		| "succeeded"
	> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
			readonly prepared: Readonly<
				Pick<
					PreparedBrowserRun,
					"commandTokens" | "executionPlan" | "readConfirmation" | "runtimeToolStdin"
				>
			>;
		} & { readonly state: BrowserRunState };
	};
export type ObserveInterruptedMutationInput = Readonly<
	Pick<
		NativeOutputPhase,
		| "batchCommandSteps"
		| "directCloseAllRequested"
		| "parseSucceeded"
		| "plainTextInspection"
		| "presentationEnvelope"
		| "succeeded"
	>
> &
	Pick<NativeOutputPhase, "closeAllApplied" | "sessionStateKey" | "unobservedMutation"> & {
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
	>
> &
	Pick<NativeOutputPhase, "networkRoutesBySession"> & {
		readonly input: Readonly<
			Pick<ProcessBrowserOutputInput, "processResult" | "sessionPageStateUpdate">
		> & { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } & {
			readonly state: BrowserRunState;
		};
	};
export type ObserveCloseStatePathInput = Readonly<
	Pick<
		NativeOutputPhase,
		"confirmedData" | "directClose" | "nestedBatchClose" | "presentationEnvelope"
	>
> &
	Pick<NativeOutputPhase, "rawCloseStatePath">;
export type ClassifyNativeEnvelopeInput = Readonly<
	Pick<NativeOutputPhase, "nativeCommandMayHaveExecuted" | "parseError" | "recordingStopRecovery">
> &
	Pick<
		NativeOutputPhase,
		| "inspectionText"
		| "parseSucceeded"
		| "plainTextInspection"
		| "presentationEnvelope"
		| "processSucceeded"
		| "succeeded"
	> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
			readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">>;
		} & { readonly state: BrowserRunState };
	};
export type ObserveNativePolicyExecutionInput = Readonly<Pick<NativeOutputPhase, "parsed">> &
	Pick<NativeOutputPhase, "browserIndependentRead" | "nativeCommandMayHaveExecuted"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
			readonly prepared: Readonly<
				Pick<PreparedBrowserRun, "commandTokens" | "readConfirmation" | "runtimeToolStdin">
			>;
		};
	};
export type ObserveNativeConfirmationPolicyInput = Readonly<
	Pick<NativeOutputPhase, "nativeCommandMayHaveExecuted">
> & { readonly input: { readonly state: BrowserRunState } };
export type NormalizeStreamEnableNoopInput = Readonly<Pick<NativeOutputPhase, "processSucceeded">> &
	Pick<NativeOutputPhase, "presentationEnvelope"> & {
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
	Pick<NativeOutputPhase, "closeAllApplied" | "nestedBatchClose" | "sessionStateKey">
> &
	Pick<NativeOutputPhase, "networkRoutesBySession"> & {
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
export type ResolveEnvelopeSuccessInput = Readonly<
	Pick<
		NativeOutputPhase,
		| "parseSucceeded"
		| "plainTextInspection"
		| "presentationEnvelope"
		| "processSucceeded"
		| "recordingStopRecovery"
	>
> &
	Pick<NativeOutputPhase, "succeeded">;
export type FoldBatchTraceRowInput = Readonly<
	Pick<NativeOutputPhase, "batchCommandSteps" | "sessionStateKey">
> & { readonly input: { readonly state: BrowserRunState } };
export type PruneNamespaceNetworkRoutesInput = Pick<NativeOutputPhase, "networkRoutesBySession"> & {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> };
};
