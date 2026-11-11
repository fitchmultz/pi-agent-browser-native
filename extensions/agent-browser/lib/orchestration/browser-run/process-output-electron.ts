import type {
	ProcessBrowserOutputInput,
	PreparedBrowserRun,
	BrowserRunState,
	ElectronHandoffSummary,
} from "./types.js";
import type { LifecycleOutputPhase } from "./process-output-lifecycle-phase-contracts.js";
import { cleanupElectronLaunchResources } from "../../electron/cleanup.js";
import type { ElectronLaunchRecord, ElectronLaunchSuccess } from "../../electron/launch.js";
import { createFreshSessionName } from "../../runtime-session-identity.js";
import { closeManagedSession } from "./managed-session-daemon-policy.js";
import { buildManagedSessionOutcome } from "./session-state.js";
import { collectElectronHandoff } from "./diagnostics.js";

type CollectLaunchHandoffInput = {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledElectron" | "executionPlan">>;
	};
};
type RecordElectronOwnershipInput = { readonly input: { readonly state: BrowserRunState } };
type RetireFailedElectronSessionInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "freshSessionOrdinal"
		| "managedSessionActive"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "networkRoutesBySession"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">>;
		readonly state: BrowserRunState;
	};
};
type FailedHandoffOutcomeInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "priorManagedSessionActive"
		| "priorManagedSessionName"
		| "priorManagedSessionNamespace"
		| "replacedManagedSessionName"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan" | "sessionMode">>;
	};
};
type CleanupFailedHandoffInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "priorManagedSessionActive"
		| "priorManagedSessionName"
		| "priorManagedSessionNamespace"
		| "replacedManagedSessionName"
		| "sessionStateKey"
		| "freshSessionOrdinal"
		| "managedSessionActive"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "networkRoutesBySession"
	>
> & {
	readonly input: Readonly<
		Pick<
			ProcessBrowserOutputInput,
			"cwd" | "implicitSessionCloseTimeoutMs" | "preserveAttachedBrowserSession"
		>
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				"executionPlan" | "managedSessionPolicyLock" | "ownedManagedSessionContext" | "sessionMode"
			>
		>;
		readonly state: BrowserRunState;
	};
};
type ApplyHandoffSnapshotInput = Readonly<Pick<LifecycleOutputPhase, "sessionStateKey">> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "sessionPageStateUpdate">> & {
		readonly state: BrowserRunState;
	};
};
type ReconcileElectronHandoffInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "priorManagedSessionActive"
		| "priorManagedSessionName"
		| "priorManagedSessionNamespace"
		| "replacedManagedSessionName"
		| "sessionStateKey"
		| "freshSessionOrdinal"
		| "managedSessionActive"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "networkRoutesBySession"
		| "succeeded"
	>
> & {
	readonly input: Readonly<
		Pick<
			ProcessBrowserOutputInput,
			| "cwd"
			| "implicitSessionCloseTimeoutMs"
			| "preserveAttachedBrowserSession"
			| "sessionPageStateUpdate"
			| "signal"
		>
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "compiledElectron"
				| "electronFailedConnectCleanup"
				| "electronHandoff"
				| "electronLaunch"
				| "executionPlan"
				| "managedSessionPolicyLock"
				| "ownedManagedSessionContext"
				| "sessionMode"
			>
		>;
		readonly state: BrowserRunState;
	};
};

function handoffExceptionMessage(error: unknown): string {
	// Unstructured thrown objects may hold credentials; only an explicit public string is safe to retain.
	return typeof error === "string" ? error : "Electron handoff failed with a non-Error exception.";
}

async function collectLaunchHandoff(
	draft: CollectLaunchHandoffInput,
	sessionName: string,
): Promise<ElectronHandoffSummary> {
	const { prepared, cwd, signal } = draft.input;
	const handoff =
		prepared.compiledElectron?.action === "launch" ? prepared.compiledElectron.handoff : "connect";
	try {
		return await collectElectronHandoff({
			cwd,
			handoff,
			namespace: prepared.executionPlan.namespace,
			sessionName,
			signal,
		});
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : handoffExceptionMessage(error),
			failureCategory: signal?.aborted === true ? "aborted" : "upstream-error",
			handoff,
		};
	}
}

function recordElectronOwnership(
	draft: RecordElectronOwnershipInput,
	launch: ElectronLaunchSuccess,
	record: ElectronLaunchRecord,
): void {
	draft.input.state.electronLaunchRecords.set(record.launchId, record);
	draft.input.state.electronChildProcesses.set(record.launchId, launch.child);
}

function retireFailedElectronSession(
	draft: RetireFailedElectronSessionInput,
	sessionName: string,
	sessionKey: string,
): Omit<RetireFailedElectronSessionInput, "input"> {
	draft.input.state.closedManagedSessionNames.add(sessionKey);
	const networkRoutesBySession = new Map(draft.networkRoutesBySession);
	networkRoutesBySession.delete(sessionKey);
	// The failed-handoff close is automatic, so the lifecycle fold never sees a close
	// command for this session. The session is freshly minted, so no prior trace owner
	// can exist today; the close still owns the cleanup, so clear it like every close.
	draft.input.state.traceOwnership.clearSession(sessionKey);
	draft.input.state.sessionPageState.clearSession(sessionKey);
	let { managedSessionActive, freshSessionOrdinal, managedSessionName, managedSessionNamespace } =
		draft;
	if (
		managedSessionName === sessionName &&
		managedSessionNamespace === draft.input.prepared.executionPlan.namespace
	) {
		managedSessionActive = false;
		freshSessionOrdinal += 1;
		managedSessionName = createFreshSessionName(
			draft.input.state.managedSessionBaseName,
			draft.input.state.ephemeralSessionSeed,
			freshSessionOrdinal,
		);
		managedSessionNamespace = undefined;
	}
	return {
		networkRoutesBySession,
		managedSessionActive,
		freshSessionOrdinal,
		managedSessionName,
		managedSessionNamespace,
	};
}

function failedHandoffOutcome(
	draft: FailedHandoffOutcomeInput,
	current: Readonly<
		Pick<
			LifecycleOutputPhase,
			"managedSessionActive" | "managedSessionName" | "managedSessionNamespace"
		>
	>,
	sessionName: string,
): LifecycleOutputPhase["managedSessionOutcome"] {
	return buildManagedSessionOutcome({
		activeAfter: current.managedSessionActive,
		activeBefore: draft.priorManagedSessionActive,
		attemptedSessionName: sessionName,
		command: draft.input.prepared.executionPlan.commandInfo.command,
		currentSessionName: current.managedSessionName,
		currentSessionNamespace: current.managedSessionNamespace,
		previousSessionName: draft.priorManagedSessionName,
		replacedSessionName: draft.replacedManagedSessionName,
		replacedSessionNamespace: draft.priorManagedSessionNamespace,
		sessionMode: draft.input.prepared.sessionMode,
		succeeded: false,
	});
}

async function cleanupFailedHandoff(
	draft: CleanupFailedHandoffInput,
	launch: ElectronLaunchSuccess,
	record: ElectronLaunchRecord,
	sessionName: string,
): Promise<
	Pick<
		LifecycleOutputPhase,
		"electronFailedConnectCleanup" | "electronLaunchRecord" | "managedSessionOutcome"
	> &
		Partial<Omit<RetireFailedElectronSessionInput, "input">>
> {
	const sessionKey = draft.sessionStateKey ?? sessionName;
	const { prepared, state, cwd, implicitSessionCloseTimeoutMs } = draft.input;
	const closeError = await closeManagedSession({
		confirmActions:
			state.sessionPageState.get(sessionKey).confirmActions ??
			process.env.AGENT_BROWSER_CONFIRM_ACTIONS,
		cwd,
		headedManagedAutosaveInterval:
			prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval,
		namespace: prepared.executionPlan.namespace,
		policyLock: prepared.managedSessionPolicyLock,
		preserveAttachedBrowserSession: draft.input.preserveAttachedBrowserSession,
		restoreState: state.managedSessionRestoreState,
		sessionName,
		timeoutMs: implicitSessionCloseTimeoutMs,
	});
	const electronFailedConnectCleanup = await cleanupElectronLaunchResources({
		child: launch.child,
		record,
		timeoutMs: implicitSessionCloseTimeoutMs,
	});
	const electronLaunchRecord = electronFailedConnectCleanup.record;
	if (electronFailedConnectCleanup.partial) {
		recordElectronOwnership(draft, launch, electronLaunchRecord);
	} else {
		state.electronLaunchRecords.delete(electronLaunchRecord.launchId);
		state.electronChildProcesses.delete(electronLaunchRecord.launchId);
	}
	const retirement =
		closeError === undefined || closeError.length === 0
			? retireFailedElectronSession(draft, sessionName, sessionKey)
			: undefined;
	return {
		electronFailedConnectCleanup,
		electronLaunchRecord,
		managedSessionOutcome: failedHandoffOutcome(draft, retirement ?? draft, sessionName),
		...retirement,
	};
}

function applyHandoffSnapshot(
	draft: ApplyHandoffSnapshotInput,
	sessionName: string,
	handoff: ElectronHandoffSummary,
):
	| Partial<
			Pick<
				LifecycleOutputPhase,
				"currentRefSnapshot" | "currentRefSnapshotInvalidation" | "currentSessionTabTarget"
			>
	  >
	| undefined {
	const snapshot = handoff.refSnapshot;
	if (!snapshot) {
		return;
	}
	const sessionKey = draft.sessionStateKey ?? sessionName;
	const { state, sessionPageStateUpdate } = draft.input;
	const refUpdate = state.sessionPageState.applyRefSnapshot({
		sessionName: sessionKey,
		snapshot,
		update: sessionPageStateUpdate,
	});
	const result = {
		currentRefSnapshot: refUpdate.refSnapshot,
		currentRefSnapshotInvalidation: refUpdate.refSnapshotInvalidation,
	};
	if (!snapshot.target) {
		return result;
	}
	const targetUpdate = state.sessionPageState.applyTabTarget({
		sessionName: sessionKey,
		target: snapshot.target,
		update: sessionPageStateUpdate,
	});
	return { ...result, currentSessionTabTarget: targetUpdate.tabTarget };
}

export async function reconcileElectronHandoff(
	draft: ReconcileElectronHandoffInput,
): Promise<
	Pick<LifecycleOutputPhase, "electronFailedConnectCleanup" | "electronHandoff"> &
		Partial<
			Pick<
				LifecycleOutputPhase,
				| "currentRefSnapshot"
				| "currentRefSnapshotInvalidation"
				| "currentSessionTabTarget"
				| "electronLaunchRecord"
				| "freshSessionOrdinal"
				| "managedSessionActive"
				| "managedSessionName"
				| "managedSessionNamespace"
				| "managedSessionOutcome"
				| "networkRoutesBySession"
				| "presentationEnvelope"
				| "succeeded"
			>
		>
> {
	const { prepared, implicitSessionCloseTimeoutMs } = draft.input;
	const initial = {
		electronFailedConnectCleanup: prepared.electronFailedConnectCleanup,
		electronHandoff: prepared.electronHandoff,
	};
	const launch = prepared.electronLaunch;
	if (!launch) {
		return initial;
	}
	const sessionName = prepared.executionPlan.sessionName;
	if (!draft.succeeded || sessionName === undefined || sessionName.length === 0) {
		const electronFailedConnectCleanup = await cleanupElectronLaunchResources({
			child: launch.child,
			record: launch.record,
			timeoutMs: implicitSessionCloseTimeoutMs,
		});
		return {
			...initial,
			electronFailedConnectCleanup,
			electronLaunchRecord: electronFailedConnectCleanup.record,
		};
	}
	const record = { ...launch.record, namespace: prepared.executionPlan.namespace, sessionName };
	const handoff = await collectLaunchHandoff(draft, sessionName);
	if (handoff.error !== undefined && handoff.error.length > 0) {
		return {
			electronHandoff: handoff,
			succeeded: false,
			presentationEnvelope: { error: handoff.error, success: false },
			...(await cleanupFailedHandoff(draft, launch, record, sessionName)),
		};
	}
	recordElectronOwnership(draft, launch, record);
	return {
		...initial,
		electronLaunchRecord: record,
		electronHandoff: handoff,
		...applyHandoffSnapshot(draft, sessionName, handoff),
	};
}
