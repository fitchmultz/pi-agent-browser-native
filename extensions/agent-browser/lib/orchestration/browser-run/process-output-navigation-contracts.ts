import type { ProcessBrowserOutputInput, PreparedBrowserRun, BrowserRunState } from "./types.js";
import type { PageOutputPhase } from "./process-output-page-phase-contracts.js";
export type VerifyClickDispatchInput = Pick<
	PageOutputPhase,
	"clickDispatchDiagnostic" | "presentationEnvelope" | "succeeded"
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "clickDispatchProbe" | "executionPlan">>;
	};
};
export type ResolveResultingPageStateInput = Readonly<
	Pick<
		PageOutputPhase,
		| "confirmedEffects"
		| "dispatchedCommands"
		| "nativeCommandMayHaveExecuted"
		| "presentationEnvelope"
		| "sessionStateKey"
	>
> &
	Pick<PageOutputPhase, "resultingPageState" | "tabTransition"> & {
		readonly input: {
			readonly prepared: Readonly<
				Pick<
					PreparedBrowserRun,
					"executionPlan" | "priorSessionTabTarget" | "priorSessionTabTargetUnknown"
				>
			>;
		} & { readonly state: BrowserRunState };
	};
export type HasNativeNavigationEvidenceInput = Readonly<
	Pick<PageOutputPhase, "confirmedEffects" | "dispatchedCommands" | "presentationEnvelope">
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } };
export type NavigationObservationRequestedInput = Readonly<
	Pick<
		PageOutputPhase,
		| "confirmedEffects"
		| "destinationTransition"
		| "dispatchedCommands"
		| "presentationEnvelope"
		| "tabTransition"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				"callerColdLaunch" | "compiledSemanticAction" | "executionPlan" | "runtimeToolStdin"
			>
		>;
	};
};
export type CanObserveSuccessfulNavigationInput = Readonly<
	Pick<
		PageOutputPhase,
		| "confirmedEffects"
		| "directClose"
		| "nestedBatchClosed"
		| "processSucceeded"
		| "readConfirmation"
		| "succeeded"
	>
>;
export type HasFailedPageTransitionInput = Readonly<
	Pick<PageOutputPhase, "confirmedEffects" | "dispatchedCommands">
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } };
export type CanReverifyFailedNavigationInput = Readonly<
	Pick<
		PageOutputPhase,
		| "confirmedEffects"
		| "directClose"
		| "dispatchedCommands"
		| "nativeCommandMayHaveExecuted"
		| "navigationSummary"
		| "nestedBatchClosed"
		| "readConfirmation"
		| "succeeded"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">>;
	};
};
export type MergeObservedNavigationInput = Readonly<
	Pick<PageOutputPhase, "navigationSummary" | "textOutput">
> &
	Pick<PageOutputPhase, "presentationEnvelope"> & {
		readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> };
	};
export type ObserveNavigationTargetInput = Readonly<
	Pick<
		PageOutputPhase,
		| "confirmedEffects"
		| "destinationTransition"
		| "directClose"
		| "dispatchedCommands"
		| "nativeCommandMayHaveExecuted"
		| "nestedBatchClosed"
		| "processSucceeded"
		| "readConfirmation"
		| "sessionStateKey"
		| "succeeded"
		| "textOutput"
	>
> &
	Pick<
		PageOutputPhase,
		| "failedTransitionReverification"
		| "navigationSummary"
		| "presentationEnvelope"
		| "resultingPageState"
		| "tabTransition"
	> & {
		readonly input: Readonly<
			Pick<ProcessBrowserOutputInput, "cwd" | "processResult" | "signal">
		> & {
			readonly prepared: Readonly<
				Pick<
					PreparedBrowserRun,
					| "callerColdLaunch"
					| "compiledSemanticAction"
					| "executionPlan"
					| "priorSessionTabTarget"
					| "priorSessionTabTargetUnknown"
					| "runtimeToolStdin"
				>
			>;
		} & { readonly state: BrowserRunState };
	};
export type CorrectRestoredOpenTabInput = Readonly<
	Pick<PageOutputPhase, "presentationEnvelope" | "succeeded">
> &
	Pick<PageOutputPhase, "openResultTabCorrection"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
			readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
		};
	};
export type VerifiesCurrentUrlInput = Readonly<
	Pick<PageOutputPhase, "presentationEnvelope" | "readConfirmationEvent">
> & {
	readonly input: {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "commandTokens" | "executionPlan" | "readConfirmation">
		>;
	};
};
export type HasFailedWebMcpSettlementInput = Readonly<
	Pick<PageOutputPhase, "presentationEnvelope" | "succeeded">
> & {
	readonly input: {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "priorSessionTabTargetUnknown">
		>;
	};
};
export type ObserveWebMcpTargetInput = Readonly<
	Pick<
		PageOutputPhase,
		"presentationEnvelope" | "readConfirmationEvent" | "resultingPageState" | "succeeded"
	>
> &
	Pick<PageOutputPhase, "trustsReportedPageTarget" | "unsettledWebMcpMutation"> & {
		readonly input: {
			readonly prepared: Readonly<
				Pick<
					PreparedBrowserRun,
					"commandTokens" | "executionPlan" | "priorSessionTabTargetUnknown" | "readConfirmation"
				>
			>;
		};
	};
export type ObservedPageTargetInput = Readonly<
	Pick<
		PageOutputPhase,
		| "failedTransitionReverification"
		| "navigationSummary"
		| "succeeded"
		| "trustsReportedPageTarget"
		| "unobservedMutation"
		| "unsettledWebMcpMutation"
	>
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens">> } };
export type ReportedPageTargetInput = {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
	};
};
export type ResolveObservedTargetIdentityInput = Readonly<
	Pick<
		PageOutputPhase,
		"browserIndependentRead" | "directClose" | "nestedBatchClosed" | "readConfirmation"
	>
> &
	Pick<PageOutputPhase, "observedSessionTabTarget"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
			readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
		};
	};
export type FallbackPageTargetInput = Readonly<
	Pick<
		PageOutputPhase,
		| "destinationTransition"
		| "directClose"
		| "navigationSummary"
		| "resultingPageState"
		| "succeeded"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "priorSessionTabTarget">
		>;
	};
};
export type ResolveObservedPageTargetInput = Readonly<
	Pick<
		PageOutputPhase,
		| "browserIndependentRead"
		| "destinationTransition"
		| "directClose"
		| "failedTransitionReverification"
		| "navigationSummary"
		| "nestedBatchClose"
		| "nestedBatchClosed"
		| "presentationEnvelope"
		| "readConfirmation"
		| "resultingPageState"
		| "succeeded"
		| "textOutput"
		| "trustsReportedPageTarget"
		| "unobservedMutation"
		| "unsettledWebMcpMutation"
	>
> &
	Pick<PageOutputPhase, "currentSessionTabTarget" | "observedSessionTabTarget"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
			readonly prepared: Readonly<
				Pick<PreparedBrowserRun, "commandTokens" | "executionPlan" | "priorSessionTabTarget">
			>;
		};
	};
export type ProcessCannotVerifyPageInput = Readonly<
	Pick<PageOutputPhase, "nativeCommandMayHaveExecuted">
> & { readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> };
