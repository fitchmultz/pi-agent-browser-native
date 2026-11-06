import type { ProcessBrowserOutputInput, PreparedBrowserRun, BrowserRunState } from "./types.js";
import type { LifecycleOutputPhase } from "./process-output-lifecycle-phase-contracts.js";

export type CloseAllClosesManagedSessionInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "closeAllApplied"
		| "nestedBatchRemainsActive"
		| "managedSessionActive"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "sessionStateKey"
	>
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } };

export type ManagedCloseTargetInput = Readonly<
	Pick<LifecycleOutputPhase, "managedSessionName" | "managedSessionNamespace">
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
		| "nestedBatchRemainsActive"
		| "sessionStateKey"
		| "succeeded"
	>
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } };

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
> & {
	readonly input: Readonly<
		Pick<ProcessBrowserOutputInput, "cwd" | "implicitSessionCloseTimeoutMs" | "processResult">
	> & {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "ownedManagedSessionContext" | "sessionMode">
		>;
	} & { readonly state: BrowserRunState };
};
export type ApplyManagedLaunchPolicyInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "managedTransitionSucceeded"
		| "managedSessionCompatibilityWorkaround"
		| "managedSessionHeadedAutosaveDisabled"
		| "managedSessionHeadedAutosaveInterval"
	>
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
		| "priorManagedSessionName"
		| "priorManagedSessionNamespace"
		| "rawCloseStatePath"
		| "freshSessionOrdinal"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd">> & {
		readonly state: BrowserRunState;
	};
};
export type UpdateManagedLaunchDirectoryInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		"managedTransitionSucceeded" | "priorManagedSessionActive" | "managedSessionCwd"
	>
> & {
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
		| "freshSessionOrdinal"
		| "managedSessionCompatibilityWorkaround"
		| "managedSessionCwd"
		| "managedSessionHeadedAutosaveDisabled"
		| "managedSessionHeadedAutosaveInterval"
	>
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
		| "managedSessionOutcome"
		| "networkRoutesBySession"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "implicitSessionCloseTimeoutMs">> & {
		readonly state: BrowserRunState;
	};
};
