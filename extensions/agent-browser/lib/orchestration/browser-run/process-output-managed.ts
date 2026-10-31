import type {
	CloseAllClosesManagedSessionInput,
	ManagedCloseTargetInput,
	ResolveManagedCloseTargetInput,
	FailedBatchEstablishedBrowserInput,
	TimedOutBatchEstablishedPageInput,
	FailedFreshSessionMayHaveStartedInput,
	InspectFailedFreshDaemonInput,
	InspectFailedFreshLaunchInput,
	ExecutionTargetsManagedSessionInput,
	ApplyManagedLaunchPolicyInput,
	RetireManagedRestorePoolInput,
	UpdateManagedLaunchDirectoryInput,
	ApplyManagedTransitionInput,
	RetireReplacedSessionInput,
} from "./process-output-managed-contracts.js";
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
		getSessionContextKey(draft.priorManagedSessionName, draft.priorManagedSessionNamespace) ??
		draft.priorManagedSessionName;
	return (
		draft.closeAllApplied &&
		draft.priorManagedSessionActive &&
		isAgentBrowserSessionIdentityKeyInNamespace(
			priorKey,
			draft.input.prepared.executionPlan.namespace,
		)
	);
}

function managedCloseTarget(
	draft: ManagedCloseTargetInput,
	closesPrior: boolean,
): string | undefined {
	if (closesPrior) {
		return draft.priorManagedSessionName;
	}
	const { executionPlan } = draft.input.prepared;
	if (
		draft.closeCommandSucceeded &&
		executionPlan.sessionName === draft.priorManagedSessionName &&
		executionPlan.namespace === draft.priorManagedSessionNamespace
	) {
		return executionPlan.sessionName;
	}
	return executionPlan.managedSessionName;
}

export function resolveManagedCloseTarget(draft: ResolveManagedCloseTargetInput): void {
	draft.priorManagedSessionActive = draft.managedSessionActive;
	draft.priorManagedSessionCwd = draft.managedSessionCwd;
	draft.priorManagedSessionHeadedAutosaveInterval = draft.managedSessionHeadedAutosaveInterval;
	draft.priorManagedSessionName = draft.managedSessionName;
	draft.priorManagedSessionNamespace = draft.managedSessionNamespace;
	const closesPrior = closeAllClosesManagedSession(draft);
	draft.commandClosesSession = draft.directClose || draft.nestedBatchClosed || closesPrior;
	draft.closeCommandSucceeded =
		(draft.directClose && draft.succeeded) || draft.nestedBatchClosed || closesPrior;
	draft.managedCloseSessionName = managedCloseTarget(draft, closesPrior);
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
): Promise<void> {
	const batchStarted = failedBatchEstablishedBrowser(draft);
	const timeoutPage = timedOutBatchEstablishedPage(draft);
	const daemon = await inspectFailedFreshDaemon(draft);
	// Only an explicitly inactive daemon proves a started fresh command did not establish ownership.
	const failedFreshStarted = daemon !== undefined && daemon.status !== "inactive";
	draft.managedTransitionSucceeded =
		draft.succeeded ||
		draft.nestedBatchClosed ||
		draft.nestedBatchRemainsActive ||
		batchStarted ||
		timeoutPage ||
		failedFreshStarted;
}

function executionTargetsManagedSession(draft: ExecutionTargetsManagedSessionInput): boolean {
	const { executionPlan } = draft.input.prepared;
	return (
		executionPlan.sessionName !== undefined &&
		executionPlan.sessionName.length > 0 &&
		getAgentBrowserSessionIdentityKey(executionPlan.sessionName, executionPlan.namespace) ===
			getAgentBrowserSessionIdentityKey(draft.managedSessionName, draft.managedSessionNamespace)
	);
}

function applyManagedLaunchPolicy(draft: ApplyManagedLaunchPolicyInput): void {
	if (!draft.managedSessionActive) {
		draft.managedSessionCompatibilityWorkaround = undefined;
		draft.managedSessionHeadedAutosaveDisabled = false;
		draft.managedSessionHeadedAutosaveInterval = undefined;
		return;
	}
	const { prepared } = draft.input;
	const owned = prepared.ownedManagedSessionContext;
	if (
		!draft.managedTransitionSucceeded ||
		!executionTargetsManagedSession(draft) ||
		!owned ||
		owned.reuseOnly === true
	) {
		return;
	}
	draft.managedSessionCompatibilityWorkaround = prepared.compatibilityWorkaround;
	draft.managedSessionHeadedAutosaveDisabled = owned.headedManagedAutosaveDisabled === true;
	draft.managedSessionHeadedAutosaveInterval = owned.headedManagedAutosaveInterval;
}

function retireManagedRestorePool(draft: RetireManagedRestorePoolInput): void {
	if (
		!draft.closeCommandSucceeded ||
		draft.managedCloseSessionName !== draft.priorManagedSessionName ||
		draft.managedSessionActive
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
	draft.freshSessionOrdinal += 1;
	draft.managedSessionName = createFreshSessionName(
		draft.input.state.managedSessionBaseName,
		draft.input.state.ephemeralSessionSeed,
		draft.freshSessionOrdinal,
	);
	draft.managedSessionNamespace = undefined;
}

function updateManagedLaunchDirectory(draft: UpdateManagedLaunchDirectoryInput): void {
	const sessionName = draft.input.prepared.executionPlan.managedSessionName;
	if (
		sessionName === undefined ||
		sessionName.length === 0 ||
		!draft.managedTransitionSucceeded ||
		!draft.managedSessionActive
	) {
		return;
	}
	if (
		!draft.priorManagedSessionActive ||
		(draft.replacedManagedSessionName !== undefined && draft.replacedManagedSessionName.length > 0)
	) {
		draft.managedSessionCwd = draft.input.cwd;
	}
	draft.managedSessionNamespace = draft.input.prepared.executionPlan.namespace;
}

export function applyManagedTransition(draft: ApplyManagedTransitionInput): void {
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
	draft.replacedManagedSessionName = next.replacedSessionName;
	draft.managedSessionActive = next.active;
	draft.managedSessionName = next.sessionName;
	draft.managedSessionNamespace = next.namespace;
	applyManagedLaunchPolicy(draft);
	retireManagedRestorePool(draft);
	draft.managedSessionOutcome = buildManagedSessionOutcome({
		activeAfter: draft.managedSessionActive,
		activeBefore: draft.priorManagedSessionActive,
		attemptedSessionName: draft.managedCloseSessionName,
		command,
		currentSessionName: draft.managedSessionName,
		currentSessionNamespace: draft.managedSessionNamespace,
		previousSessionName: draft.priorManagedSessionName,
		replacedSessionName: draft.replacedManagedSessionName,
		replacedSessionNamespace: draft.priorManagedSessionNamespace,
		sessionMode: prepared.sessionMode,
		succeeded: draft.managedTransitionSucceeded,
	});
	updateManagedLaunchDirectory(draft);
}

export async function retireReplacedSession(draft: RetireReplacedSessionInput): Promise<void> {
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
	if (draft.managedSessionOutcome) {
		draft.managedSessionOutcome = {
			...draft.managedSessionOutcome,
			replacedSessionClosed: closed,
			summary: closed
				? draft.managedSessionOutcome.summary
				: `${draft.managedSessionOutcome.summary} Previous session ${sessionName} remains wrapper-owned because automatic close failed; retry an explicit close.`,
		};
	}
	if (!closed) {
		return;
	}
	const routes = new Map(draft.networkRoutesBySession);
	routes.delete(sessionKey);
	draft.networkRoutesBySession = routes;
	state.sessionPageState.clearSession(sessionKey);
	state.attachedSessionKeys.delete(sessionKey);
	state.closedManagedSessionNames.add(sessionKey);
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
