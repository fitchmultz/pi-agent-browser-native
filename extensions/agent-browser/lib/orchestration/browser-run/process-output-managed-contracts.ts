import type { ProcessBrowserOutputInput, PreparedBrowserRun, BrowserRunState } from "./types.js";
import type { LifecycleOutputPhase } from "./process-output-lifecycle-phase-contracts.js";
export type CloseAllClosesManagedSessionInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "closeAllApplied"
		| "priorManagedSessionActive"
		| "priorManagedSessionName"
		| "priorManagedSessionNamespace"
	>
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } };
export type ManagedCloseTargetInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		"closeCommandSucceeded" | "priorManagedSessionName" | "priorManagedSessionNamespace"
	>
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } };
export type ResolveManagedCloseTargetInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "closeAllApplied"
		| "directClose"
		| "managedSessionActive"
		| "managedSessionCwd"
		| "managedSessionHeadedAutosaveInterval"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "nestedBatchClosed"
		| "succeeded"
	>
> &
	Pick<
		LifecycleOutputPhase,
		| "closeCommandSucceeded"
		| "commandClosesSession"
		| "managedCloseSessionName"
		| "priorManagedSessionActive"
		| "priorManagedSessionCwd"
		| "priorManagedSessionHeadedAutosaveInterval"
		| "priorManagedSessionName"
		| "priorManagedSessionNamespace"
	> & {
		readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> };
	};
export type FailedBatchEstablishedBrowserInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		"parseSucceeded" | "presentationEnvelope" | "processSucceeded" | "succeeded"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan" | "sessionMode">>;
	};
};
export type TimedOutBatchEstablishedPageInput = Readonly<
	Pick<LifecycleOutputPhase, "succeeded" | "timeoutPartialProgress">
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan" | "sessionMode">>;
	};
};
export type FailedFreshSessionMayHaveStartedInput = Readonly<
	Pick<LifecycleOutputPhase, "succeeded">
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan" | "sessionMode">>;
	};
};
export type InspectFailedFreshDaemonInput = Readonly<Pick<LifecycleOutputPhase, "succeeded">> & {
	readonly input: Readonly<
		Pick<ProcessBrowserOutputInput, "cwd" | "implicitSessionCloseTimeoutMs" | "processResult">
	> & {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "ownedManagedSessionContext" | "sessionMode">
		>;
	} & { readonly state: BrowserRunState };
};
export type InspectFailedFreshLaunchInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "nestedBatchClosed"
		| "nestedBatchRemainsActive"
		| "parseSucceeded"
		| "presentationEnvelope"
		| "processSucceeded"
		| "succeeded"
		| "timeoutPartialProgress"
	>
> &
	Pick<LifecycleOutputPhase, "managedTransitionSucceeded"> & {
		readonly input: Readonly<
			Pick<ProcessBrowserOutputInput, "cwd" | "implicitSessionCloseTimeoutMs" | "processResult">
		> & {
			readonly prepared: Readonly<
				Pick<PreparedBrowserRun, "executionPlan" | "ownedManagedSessionContext" | "sessionMode">
			>;
		} & { readonly state: BrowserRunState };
	};
export type ExecutionTargetsManagedSessionInput = Readonly<
	Pick<LifecycleOutputPhase, "managedSessionName" | "managedSessionNamespace">
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } };
export type ApplyManagedLaunchPolicyInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "managedSessionActive"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "managedTransitionSucceeded"
	>
> &
	Pick<
		LifecycleOutputPhase,
		| "managedSessionCompatibilityWorkaround"
		| "managedSessionHeadedAutosaveDisabled"
		| "managedSessionHeadedAutosaveInterval"
	> & {
		readonly input: {
			readonly prepared: Readonly<
				Pick<
					PreparedBrowserRun,
					"compatibilityWorkaround" | "executionPlan" | "ownedManagedSessionContext"
				>
			>;
		};
	};
export type RetireManagedRestorePoolInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "closeCommandSucceeded"
		| "managedCloseSessionName"
		| "managedSessionActive"
		| "priorManagedSessionName"
		| "priorManagedSessionNamespace"
		| "rawCloseStatePath"
	>
> &
	Pick<
		LifecycleOutputPhase,
		"freshSessionOrdinal" | "managedSessionName" | "managedSessionNamespace"
	> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd">> & {
			readonly state: BrowserRunState;
		};
	};
export type UpdateManagedLaunchDirectoryInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "managedSessionActive"
		| "managedTransitionSucceeded"
		| "priorManagedSessionActive"
		| "replacedManagedSessionName"
	>
> &
	Pick<LifecycleOutputPhase, "managedSessionCwd" | "managedSessionNamespace"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd">> & {
			readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">>;
		};
	};
export type ApplyManagedTransitionInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "closeCommandSucceeded"
		| "commandClosesSession"
		| "managedCloseSessionName"
		| "managedTransitionSucceeded"
		| "priorManagedSessionActive"
		| "priorManagedSessionName"
		| "priorManagedSessionNamespace"
		| "rawCloseStatePath"
	>
> &
	Pick<
		LifecycleOutputPhase,
		| "freshSessionOrdinal"
		| "managedSessionActive"
		| "managedSessionCompatibilityWorkaround"
		| "managedSessionCwd"
		| "managedSessionHeadedAutosaveDisabled"
		| "managedSessionHeadedAutosaveInterval"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "managedSessionOutcome"
		| "replacedManagedSessionName"
	> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd">> & {
			readonly prepared: Readonly<
				Pick<
					PreparedBrowserRun,
					"compatibilityWorkaround" | "executionPlan" | "ownedManagedSessionContext" | "sessionMode"
				>
			>;
		} & { readonly state: BrowserRunState };
	};
export type RetireReplacedSessionInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "priorManagedSessionCwd"
		| "priorManagedSessionHeadedAutosaveInterval"
		| "priorManagedSessionNamespace"
		| "replacedManagedSessionName"
	>
> &
	Pick<LifecycleOutputPhase, "managedSessionOutcome" | "networkRoutesBySession"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "implicitSessionCloseTimeoutMs">> & {
			readonly state: BrowserRunState;
		};
	};
