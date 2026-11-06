import type {
	CloseAllClosesManagedSessionInput,
	ManagedCloseTargetInput,
	ResolveManagedCloseTargetInput,
	FailedBatchEstablishedBrowserInput,
	TimedOutBatchEstablishedPageInput,
	FailedFreshSessionMayHaveStartedInput,
	InspectFailedFreshDaemonInput,
	InspectFailedFreshLaunchInput,
	ApplyManagedLaunchPolicyInput,
	RetireManagedRestorePoolInput,
	UpdateManagedLaunchDirectoryInput,
	ApplyManagedTransitionInput,
	RetireReplacedSessionInput,
} from "./process-output-managed-contracts.js";
import type { ManagedSessionState } from "../../runtime-contracts.js";
import type { PreparedBrowserRun } from "./types.js";
import type { LifecycleOutputPhase } from "./process-output-lifecycle-phase-contracts.js";
import {
	createFreshSessionName,
	resolveManagedSessionState,
} from "../../runtime-session-identity.js";
import {
	closeManagedSession,
	inspectManagedSessionDaemon,
	type ManagedSessionDaemonInspection,
} from "./managed-session-daemon-policy.js";
import {
	getAgentBrowserSessionIdentityKey,
	isAgentBrowserSessionIdentityKeyInNamespace,
} from "../../argv-grammar.js";
import { isOpenNavigationCommand } from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import { pruneOwnedManagedSessionRestoreSnapshots } from "../../managed-session-restore.js";
import { isManagedSessionRestoreKey } from "../../managed-session-storage.js";
import { buildManagedSessionOutcome, getSessionContextKey } from "./session-state.js";
function closeAllClosesManagedSession(draft: CloseAllClosesManagedSessionInput): boolean {
	const priorKey =
		getSessionContextKey(draft.managedSessionName, draft.managedSessionNamespace) ??
		draft.managedSessionName;
	const targetsPrior =
		draft.closeAllApplied &&
		draft.managedSessionActive &&
		isAgentBrowserSessionIdentityKeyInNamespace(
			priorKey,
			draft.input.prepared.executionPlan.namespace,
		);
	const retainsPrior =
		targetsPrior && draft.nestedBatchRemainsActive && draft.sessionStateKey === priorKey;
	return targetsPrior && !retainsPrior;
}

function managedCloseTarget(
	draft: ManagedCloseTargetInput,
	closesPrior: boolean,
	closeCommandSucceeded: boolean,
): string | undefined {
	if (closesPrior) {
		return draft.managedSessionName;
	}
	const { executionPlan } = draft.input.prepared;
	if (
		closeCommandSucceeded &&
		executionPlan.sessionName === draft.managedSessionName &&
		executionPlan.namespace === draft.managedSessionNamespace
	) {
		return executionPlan.sessionName;
	}
	return executionPlan.managedSessionName;
}

export function resolveManagedCloseTarget(
	draft: ResolveManagedCloseTargetInput,
): Pick<
	LifecycleOutputPhase,
	| "priorManagedSessionActive"
	| "priorManagedSessionCwd"
	| "priorManagedSessionHeadedAutosaveInterval"
	| "priorManagedSessionName"
	| "priorManagedSessionNamespace"
	| "commandClosesSession"
	| "closeCommandSucceeded"
	| "managedCloseSessionName"
> {
	const closesPrior = closeAllClosesManagedSession(draft);
	const closeCommandSucceeded =
		(draft.directClose && draft.succeeded) || draft.nestedBatchClosed || closesPrior;
	return {
		priorManagedSessionActive: draft.managedSessionActive,
		priorManagedSessionCwd: draft.managedSessionCwd,
		priorManagedSessionHeadedAutosaveInterval: draft.managedSessionHeadedAutosaveInterval,
		priorManagedSessionName: draft.managedSessionName,
		priorManagedSessionNamespace: draft.managedSessionNamespace,
		commandClosesSession: draft.directClose || draft.nestedBatchClosed || closesPrior,
		closeCommandSucceeded,
		managedCloseSessionName: managedCloseTarget(draft, closesPrior, closeCommandSucceeded),
	};
}

function failedBatchEstablishedBrowser(draft: FailedBatchEstablishedBrowserInput): boolean {
	const { prepared } = draft.input;
	return (
		!draft.succeeded &&
		draft.processSucceeded &&
		draft.parseSucceeded &&
		prepared.sessionMode === "fresh" &&
		prepared.executionPlan.commandInfo.command === "batch" &&
		batchStartedManagedBrowser(draft.presentationEnvelope?.data)
	);
}

function timedOutBatchEstablishedPage(draft: TimedOutBatchEstablishedPageInput): boolean {
	const { prepared, processResult } = draft.input;
	return (
		!draft.succeeded &&
		processResult.timedOut &&
		prepared.sessionMode === "fresh" &&
		prepared.executionPlan.commandInfo.command === "batch" &&
		draft.timeoutPartialProgress?.liveUrlRecovered === true
	);
}

function failedFreshSessionMayHaveStarted(draft: FailedFreshSessionMayHaveStartedInput): boolean {
	const { prepared, processResult } = draft.input;
	const spawnMayHaveRun =
		processResult.agentBrowserStarted ||
		(!processResult.aborted && processResult.spawnError === undefined);
	return (
		!draft.succeeded &&
		spawnMayHaveRun &&
		prepared.sessionMode === "fresh" &&
		prepared.executionPlan.managedSessionName === prepared.executionPlan.sessionName
	);
}

async function inspectFailedFreshDaemon(
	draft: InspectFailedFreshDaemonInput,
): Promise<ManagedSessionDaemonInspection | undefined> {
	const { prepared, cwd, implicitSessionCloseTimeoutMs } = draft.input;
	const sessionName = prepared.executionPlan.sessionName;
	if (
		!failedFreshSessionMayHaveStarted(draft) ||
		sessionName === undefined ||
		sessionName.length === 0
	) {
		return;
	}
	const daemon = await inspectManagedSessionDaemon({
		cwd,
		headedManagedAutosaveInterval:
			prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval,
		namespace: prepared.executionPlan.namespace,
		sessionName,
		timeoutMs: Math.min(implicitSessionCloseTimeoutMs, 2_000),
	});
	if (daemon.status === "active") {
		draft.input.state.managedSessionRestoreState.recordDaemonRestoreKey(
			prepared.executionPlan.sessionName,
			prepared.executionPlan.namespace,
			daemon.restoreKey,
		);
	}
	return daemon;
}

export async function inspectFailedFreshLaunch(
	draft: InspectFailedFreshLaunchInput,
): Promise<boolean> {
	const batchStarted = failedBatchEstablishedBrowser(draft);
	const timeoutPage = timedOutBatchEstablishedPage(draft);
	const daemon = await inspectFailedFreshDaemon(draft);
	// Only an explicitly inactive daemon proves a started fresh command did not establish ownership.
	const failedFreshStarted = daemon !== undefined && daemon.status !== "inactive";
	return (
		draft.succeeded ||
		draft.nestedBatchClosed ||
		draft.nestedBatchRemainsActive ||
		batchStarted ||
		timeoutPage ||
		failedFreshStarted
	);
}

function executionTargetsManagedSession(
	executionPlan: PreparedBrowserRun["executionPlan"],
	next: ManagedSessionState,
): boolean {
	return (
		executionPlan.sessionName !== undefined &&
		executionPlan.sessionName.length > 0 &&
		getAgentBrowserSessionIdentityKey(executionPlan.sessionName, executionPlan.namespace) ===
			getAgentBrowserSessionIdentityKey(next.sessionName, next.namespace)
	);
}

function resolveManagedLaunchPolicy(
	draft: ApplyManagedLaunchPolicyInput,
	next: ManagedSessionState,
): Pick<
	LifecycleOutputPhase,
	| "managedSessionCompatibilityWorkaround"
	| "managedSessionHeadedAutosaveDisabled"
	| "managedSessionHeadedAutosaveInterval"
> {
	if (!next.active) {
		return {
			managedSessionCompatibilityWorkaround: undefined,
			managedSessionHeadedAutosaveDisabled: false,
			managedSessionHeadedAutosaveInterval: undefined,
		};
	}
	const { prepared } = draft.input;
	const owned = prepared.ownedManagedSessionContext;
	if (
		!draft.managedTransitionSucceeded ||
		!executionTargetsManagedSession(prepared.executionPlan, next) ||
		!owned ||
		owned.reuseOnly === true
	) {
		return {
			managedSessionCompatibilityWorkaround: draft.managedSessionCompatibilityWorkaround,
			managedSessionHeadedAutosaveDisabled: draft.managedSessionHeadedAutosaveDisabled,
			managedSessionHeadedAutosaveInterval: draft.managedSessionHeadedAutosaveInterval,
		};
	}
	return {
		managedSessionCompatibilityWorkaround: prepared.compatibilityWorkaround,
		managedSessionHeadedAutosaveDisabled: owned.headedManagedAutosaveDisabled === true,
		managedSessionHeadedAutosaveInterval: owned.headedManagedAutosaveInterval,
	};
}

function retireManagedRestorePool(
	draft: RetireManagedRestorePoolInput,
	activeAfter: boolean,
):
	| Pick<
			LifecycleOutputPhase,
			"freshSessionOrdinal" | "managedSessionName" | "managedSessionNamespace"
	  >
	| undefined {
	if (
		!draft.closeCommandSucceeded ||
		draft.managedCloseSessionName !== draft.priorManagedSessionName ||
		activeAfter
	) {
		return;
	}
	const { managedSessionRestoreState } = draft.input.state;
	const daemonKey = managedSessionRestoreState.getDaemonRestoreKey(
		draft.managedCloseSessionName,
		draft.priorManagedSessionNamespace,
	);
	const ownedKey =
		!managedSessionRestoreState.isDisabled(
			draft.managedCloseSessionName,
			draft.priorManagedSessionNamespace,
		) && isManagedSessionRestoreKey(daemonKey)
			? daemonKey
			: null;
	managedSessionRestoreState.clear(
		draft.managedCloseSessionName,
		draft.priorManagedSessionNamespace,
	);
	pruneOwnedManagedSessionRestoreSnapshots({
		cwd: draft.input.cwd,
		namespace: draft.priorManagedSessionNamespace,
		restoreKey: ownedKey,
		statePath: draft.rawCloseStatePath,
	});
	const freshSessionOrdinal = draft.freshSessionOrdinal + 1;
	return {
		freshSessionOrdinal,
		managedSessionName: createFreshSessionName(
			draft.input.state.managedSessionBaseName,
			draft.input.state.ephemeralSessionSeed,
			freshSessionOrdinal,
		),
		managedSessionNamespace: undefined,
	};
}

function resolveManagedLaunchDirectory(
	draft: UpdateManagedLaunchDirectoryInput,
	next: ManagedSessionState,
): Pick<LifecycleOutputPhase, "managedSessionCwd" | "managedSessionNamespace"> | undefined {
	const sessionName = draft.input.prepared.executionPlan.managedSessionName;
	if (
		sessionName === undefined ||
		sessionName.length === 0 ||
		!draft.managedTransitionSucceeded ||
		!next.active
	) {
		return undefined;
	}
	const newLaunch =
		!draft.priorManagedSessionActive ||
		(next.replacedSessionName !== undefined && next.replacedSessionName.length > 0);
	return {
		managedSessionCwd: newLaunch ? draft.input.cwd : draft.managedSessionCwd,
		managedSessionNamespace: draft.input.prepared.executionPlan.namespace,
	};
}

export function resolveManagedTransition(
	draft: ApplyManagedTransitionInput,
): Pick<
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
> {
	const { prepared, state } = draft.input;
	const command = draft.commandClosesSession ? "close" : prepared.executionPlan.commandInfo.command;
	const next = resolveManagedSessionState({
		command,
		managedSessionName: draft.managedCloseSessionName,
		managedSessionNamespace: prepared.executionPlan.namespace,
		priorActive: draft.priorManagedSessionActive,
		priorNamespace: draft.priorManagedSessionNamespace,
		priorSessionName: draft.priorManagedSessionName,
		succeeded: draft.managedTransitionSucceeded,
	});
	if (
		!draft.managedTransitionSucceeded &&
		prepared.sessionMode === "fresh" &&
		prepared.executionPlan.managedSessionName !== undefined &&
		prepared.executionPlan.managedSessionName.length > 0
	) {
		state.managedSessionRestoreState.clear(
			prepared.executionPlan.managedSessionName,
			prepared.executionPlan.namespace,
		);
	}
	const policy = resolveManagedLaunchPolicy(draft, next);
	const identity = retireManagedRestorePool(draft, next.active) ?? {
		freshSessionOrdinal: draft.freshSessionOrdinal,
		managedSessionName: next.sessionName,
		managedSessionNamespace: next.namespace,
	};
	const managedSessionOutcome = buildManagedSessionOutcome({
		activeAfter: next.active,
		activeBefore: draft.priorManagedSessionActive,
		attemptedSessionName: draft.managedCloseSessionName,
		command,
		currentSessionName: identity.managedSessionName,
		currentSessionNamespace: identity.managedSessionNamespace,
		previousSessionName: draft.priorManagedSessionName,
		replacedSessionName: next.replacedSessionName,
		replacedSessionNamespace: draft.priorManagedSessionNamespace,
		sessionMode: prepared.sessionMode,
		succeeded: draft.managedTransitionSucceeded,
	});
	return {
		...identity,
		...policy,
		managedSessionActive: next.active,
		managedSessionCwd: draft.managedSessionCwd,
		managedSessionOutcome,
		replacedManagedSessionName: next.replacedSessionName,
		...resolveManagedLaunchDirectory(draft, next),
	};
}

export async function retireReplacedSession(
	draft: RetireReplacedSessionInput,
): Promise<
	Pick<LifecycleOutputPhase, "managedSessionOutcome" | "networkRoutesBySession"> | undefined
> {
	const sessionName = draft.replacedManagedSessionName;
	if (sessionName === undefined || sessionName.length === 0) {
		return;
	}
	const sessionKey =
		getSessionContextKey(sessionName, draft.priorManagedSessionNamespace) ?? sessionName;
	const { state } = draft.input;
	const closeError = await closeManagedSession({
		confirmActions:
			state.sessionPageState.get(sessionKey).confirmActions ??
			process.env.AGENT_BROWSER_CONFIRM_ACTIONS,
		cwd: draft.priorManagedSessionCwd,
		headedManagedAutosaveInterval: draft.priorManagedSessionHeadedAutosaveInterval,
		namespace: draft.priorManagedSessionNamespace,
		preserveAttachedBrowserSession: state.attachedSessionKeys.has(sessionKey),
		restoreState: state.managedSessionRestoreState,
		sessionName,
		socketDir: state.ownedManagedSessions.get(sessionKey)?.socketDir,
		timeoutMs: draft.input.implicitSessionCloseTimeoutMs,
	});
	const closed = (closeError ?? "").length === 0;
	const managedSessionOutcome = draft.managedSessionOutcome
		? {
				...draft.managedSessionOutcome,
				replacedSessionClosed: closed,
				summary: closed
					? draft.managedSessionOutcome.summary
					: `${draft.managedSessionOutcome.summary} Previous session ${sessionName} remains wrapper-owned because automatic close failed; retry an explicit close.`,
			}
		: undefined;
	if (!closed) {
		return { managedSessionOutcome, networkRoutesBySession: draft.networkRoutesBySession };
	}
	const routes = new Map(draft.networkRoutesBySession);
	routes.delete(sessionKey);
	state.sessionPageState.clearSession(sessionKey);
	state.attachedSessionKeys.delete(sessionKey);
	state.closedManagedSessionNames.add(sessionKey);
	return { managedSessionOutcome, networkRoutesBySession: routes };
}

function batchStartedManagedBrowser(data: unknown): boolean {
	if (!Array.isArray(data)) {
		return false;
	}
	return data.some((entry: unknown) => {
		if (!isRecord(entry) || entry.success !== true || !Array.isArray(entry.command)) {
			return false;
		}
		const command = typeof entry.command[0] === "string" ? entry.command[0] : undefined;
		return (
			command === "connect" ||
			command === "goto" ||
			command === "navigate" ||
			isOpenNavigationCommand(command)
		);
	});
}
