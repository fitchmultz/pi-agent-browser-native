import type { ProcessBrowserOutputInput, PreparedBrowserRun, BrowserRunState } from "./types.js";
import type { LifecycleOutputPhase } from "./process-output-lifecycle-phase-contracts.js";
import type { PublicationOutputPhase } from "./process-output-publication-phase-contracts.js";
import { buildOutputStatePatch } from "./process-output-ownership.js";
import { isStringArray } from "../../results/presentation/content.js";
import { extractAgentBrowserLifecycle } from "../../results/presentation/common.js";
import { detectConfirmationRequired } from "../../results/confirmation.js";
import { isSuccessfulNativeConfirmedClose } from "../../read-confirmation.js";
import { extractRefSnapshotFromData } from "../../session-page-state.js";
import { isRecord } from "../../parsing.js";
import { redactInvocationArgs } from "../../runtime-redaction.js";
import {
	inspectManagedSessionDaemon,
	type ManagedSessionDaemonInspection,
} from "./managed-session-daemon-policy.js";

type ObservedBatchStepsInput = Readonly<Pick<LifecycleOutputPhase, "presentationEnvelope">>;
type CommitObservedLifecycleInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "artifactManifest"
		| "closeAllApplied"
		| "directClose"
		| "electronFailedConnectCleanup"
		| "electronLaunchRecord"
		| "freshSessionOrdinal"
		| "managedSessionActive"
		| "managedSessionCompatibilityWorkaround"
		| "managedSessionCwd"
		| "managedSessionHeadedAutosaveDisabled"
		| "managedSessionHeadedAutosaveInterval"
		| "managedSessionName"
		| "managedSessionNamespace"
		| "managedSessionOutcome"
		| "networkRoutesBySession"
		| "presentationEnvelope"
		| "readConfirmationEvent"
		| "resultHeadedManagedAutosaveDisabled"
		| "resultHeadedManagedAutosaveInterval"
		| "succeeded"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "compatibilityWorkaround"
				| "executionPlan"
				| "ownedManagedSessionContext"
				| "readConfirmation"
				| "redactedArgs"
				| "sessionMode"
			>
		>;
		readonly state: BrowserRunState;
	};
};
type ManagedLaunchRetainedInput = Readonly<
	Pick<PublicationOutputPhase, "managedSessionOutcome" | "succeeded">
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } };
type NeedsDaemonReceiptInput = Readonly<
	Pick<PublicationOutputPhase, "commandClosesSession" | "managedSessionOutcome" | "succeeded">
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "ownedManagedSessionContext">
		>;
		readonly state: BrowserRunState;
	};
};
type BindDaemonEvidenceInput = {
	readonly input: {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "ownedManagedSessionContext">
		>;
		readonly state: BrowserRunState;
	};
};
type DaemonReceiptIdentityInput = Readonly<Pick<PublicationOutputPhase, "sessionStateKey">> & {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> };
};
type DaemonAutosaveIntervalInput = {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "ownedManagedSessionContext">>;
	};
};
type BindOutputDaemonReceiptInput = Readonly<
	Pick<
		PublicationOutputPhase,
		"commandClosesSession" | "managedSessionOutcome" | "sessionStateKey" | "succeeded"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "processResult" | "signal">> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "executionPlan"
				| "ownedManagedSessionContext"
				| "priorRefSnapshotState"
				| "processTimeoutMs"
			>
		>;
		readonly state: BrowserRunState;
	};
};
type ConfirmedSnapshotEvidenceCompleteInput = Readonly<
	Pick<
		PublicationOutputPhase,
		| "currentRefSnapshot"
		| "parseSucceeded"
		| "processSucceeded"
		| "sessionStateKey"
		| "unobservedMutation"
	>
>;
type LastRowConfirmedSnapshotInput = Readonly<
	Pick<PublicationOutputPhase, "confirmedEffects" | "presentationEnvelope">
>;
type MarkFreshConfirmedSnapshotInput = Readonly<
	Pick<
		PublicationOutputPhase,
		| "confirmedEffects"
		| "currentRefSnapshot"
		| "parseSucceeded"
		| "presentationEnvelope"
		| "processSucceeded"
		| "sessionStateKey"
		| "unobservedMutation"
	>
> &
	Readonly<Pick<PublicationOutputPhase, "readConfirmationEvent">> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "sessionPageStateUpdate">> & {
			readonly state: BrowserRunState;
		};
	};
type PublishConfirmedSnapshotInput = Readonly<
	Pick<
		PublicationOutputPhase,
		| "authoritativePageState"
		| "confirmedEffects"
		| "currentRefSnapshot"
		| "parseSucceeded"
		| "presentationEnvelope"
		| "processSucceeded"
		| "sessionStateKey"
		| "unobservedMutation"
	>
> &
	Readonly<Pick<PublicationOutputPhase, "readConfirmationEvent">> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "sessionPageStateUpdate">> & {
			readonly state: BrowserRunState;
		};
	};

type ObservedBatchStep = {
	readonly command: readonly string[] | undefined;
	readonly success: boolean;
	readonly lifecycle: ReturnType<typeof extractAgentBrowserLifecycle>;
};

function observedBatchCommand(
	row: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
	if (!isStringArray(row.command)) {
		return;
	}
	return isSuccessfulNativeConfirmedClose(row.command, row.result)
		? ["close"]
		: redactInvocationArgs(row.command);
}

function observedBatchSteps(draft: ObservedBatchStepsInput): ObservedBatchStep[] | undefined {
	const data: unknown = draft.presentationEnvelope?.data;
	if (!Array.isArray(data)) {
		return;
	}
	return data.flatMap((row: unknown) => {
		if (!isRecord(row)) {
			return [];
		}
		return [
			{
				command: observedBatchCommand(row),
				success: row.success === true && !detectConfirmationRequired(row.result),
				lifecycle: extractAgentBrowserLifecycle(row.result),
			},
		];
	});
}

export function commitObservedLifecycle(draft: CommitObservedLifecycleInput): void {
	const { prepared, state, processResult } = draft.input;
	// Native ownership must be committed before rendering or result export can fail.
	state.applyPatch(buildOutputStatePatch(draft));
	state.recordBrowserEffects({
		args: prepared.redactedArgs,
		command: draft.directClose ? "close" : prepared.executionPlan.commandInfo.command,
		subcommand: draft.directClose ? undefined : prepared.executionPlan.commandInfo.subcommand,
		sessionName: prepared.executionPlan.sessionName,
		namespace: prepared.executionPlan.namespace,
		sessionMode: prepared.sessionMode,
		usedImplicitSession: prepared.executionPlan.usedImplicitSession,
		agentBrowserStarted: processResult.agentBrowserStarted,
		nativeSucceeded: draft.succeeded,
		managedSessionOutcome: draft.managedSessionOutcome,
		managedSessionCwd: prepared.ownedManagedSessionContext?.cwd ?? draft.managedSessionCwd,
		compatibilityWorkaround: prepared.compatibilityWorkaround,
		managedSessionHeadedAutosaveDisabled: draft.resultHeadedManagedAutosaveDisabled,
		managedSessionHeadedAutosaveInterval: draft.resultHeadedManagedAutosaveInterval,
		managedSessionRestoreDisabled: state.managedSessionRestoreState.isDisabled(
			prepared.executionPlan.sessionName,
			prepared.executionPlan.namespace,
		),
		closeAllApplied: draft.closeAllApplied,
		readConfirmation:
			draft.readConfirmationEvent ??
			prepared.readConfirmation ??
			state.observedBrowserEffects?.readConfirmation,
		electron: draft.electronLaunchRecord
			? { launch: draft.electronLaunchRecord, cleanup: draft.electronFailedConnectCleanup }
			: undefined,
		batchSteps: observedBatchSteps(draft),
	});
}

function managedLaunchRetained(draft: ManagedLaunchRetainedInput): boolean {
	return (
		draft.succeeded ||
		(draft.managedSessionOutcome?.activeAfter === true &&
			draft.managedSessionOutcome.currentSessionName ===
				draft.input.prepared.executionPlan.sessionName)
	);
}

function needsDaemonReceipt(draft: NeedsDaemonReceiptInput): boolean {
	const { prepared, state, processResult } = draft.input;
	const owned = prepared.ownedManagedSessionContext;
	return (
		owned !== undefined &&
		owned.reuseOnly !== true &&
		!draft.commandClosesSession &&
		processResult.agentBrowserStarted &&
		managedLaunchRetained(draft) &&
		!state.managedSessionRestoreState.getDaemonReceipt(
			prepared.executionPlan.sessionName,
			prepared.executionPlan.namespace,
		)
	);
}

function bindDaemonEvidence(
	draft: BindDaemonEvidenceInput,
	daemon: Readonly<ManagedSessionDaemonInspection>,
	sessionKey: string,
	newSnapshot: boolean,
): Pick<PublicationOutputPhase, "currentRefSnapshot"> | undefined {
	const { prepared, state } = draft.input;
	let snapshotUpdate: Pick<PublicationOutputPhase, "currentRefSnapshot"> | undefined;
	if (newSnapshot) {
		state.sessionPageState.bindSnapshotGeneration(
			sessionKey,
			daemon.status === "active" ? daemon.generation : undefined,
		);
		snapshotUpdate = { currentRefSnapshot: state.sessionPageState.get(sessionKey).refSnapshot };
	}
	if (
		prepared.ownedManagedSessionContext &&
		daemon.status === "active" &&
		daemon.generation !== undefined &&
		daemon.generation.length > 0
	) {
		state.managedSessionRestoreState.recordDaemonRestoreKey(
			prepared.executionPlan.sessionName,
			prepared.executionPlan.namespace,
			daemon.restoreKey,
			daemon.generation,
		);
	}
	return snapshotUpdate;
}

function hasNewSnapshot(
	page: PublicationOutputPhase["authoritativePageState"],
	prior: PreparedBrowserRun["priorRefSnapshotState"],
): boolean {
	const snapshot = page?.refSnapshot;
	return snapshot !== undefined && snapshot.snapshotId !== prior?.snapshotId;
}

function daemonReceiptIdentity(
	draft: DaemonReceiptIdentityInput,
): { readonly sessionKey: string; readonly sessionName: string } | undefined {
	const sessionKey = draft.sessionStateKey;
	const sessionName = draft.input.prepared.executionPlan.sessionName;
	if (
		sessionKey === undefined ||
		sessionKey.length === 0 ||
		sessionName === undefined ||
		sessionName.length === 0
	) {
		return;
	}
	return { sessionKey, sessionName };
}

function daemonAutosaveInterval(draft: DaemonAutosaveIntervalInput): string | undefined {
	const owned = draft.input.prepared.ownedManagedSessionContext;
	return (
		owned?.headedManagedAutosaveInterval ??
		(owned?.headedManagedAutosaveDisabled === true ? "0" : undefined)
	);
}

export async function bindOutputDaemonReceipt(
	draft: BindOutputDaemonReceiptInput,
): Promise<
	Pick<PublicationOutputPhase, "authoritativePageState"> &
		Partial<Pick<PublicationOutputPhase, "currentRefSnapshot">>
> {
	const sessionKey = draft.sessionStateKey;
	const { prepared, state, cwd, signal } = draft.input;
	const authoritativePageState =
		sessionKey !== undefined && sessionKey.length > 0
			? state.sessionPageState.get(sessionKey)
			: undefined;
	const newSnapshot = hasNewSnapshot(authoritativePageState, prepared.priorRefSnapshotState);
	const receiptNeeded = needsDaemonReceipt(draft);
	const identity = daemonReceiptIdentity(draft);
	if (!identity || (!newSnapshot && !receiptNeeded)) {
		return { authoritativePageState };
	}
	const { sessionKey: key, sessionName } = identity;
	const daemon = await inspectManagedSessionDaemon({
		cwd,
		namespace: prepared.executionPlan.namespace,
		sessionName,
		signal,
		includeGeneration: true,
		headedManagedAutosaveInterval: daemonAutosaveInterval(draft),
		timeoutMs: prepared.processTimeoutMs,
	});
	return { authoritativePageState, ...bindDaemonEvidence(draft, daemon, key, newSnapshot) };
}

function confirmedSnapshotEvidenceComplete(draft: ConfirmedSnapshotEvidenceCompleteInput): boolean {
	return (
		draft.sessionStateKey !== undefined &&
		draft.sessionStateKey.length > 0 &&
		draft.currentRefSnapshot !== undefined &&
		draft.processSucceeded &&
		draft.parseSucceeded &&
		!draft.unobservedMutation
	);
}

function lastRowConfirmedSnapshot(draft: LastRowConfirmedSnapshotInput): boolean {
	const data: unknown = draft.presentationEnvelope?.data;
	const lastIndex = Array.isArray(data) ? data.length - 1 : 0;
	return draft.confirmedEffects.some(
		(effect) =>
			effect.command === "snapshot" &&
			effect.succeeded &&
			effect.index === lastIndex &&
			extractRefSnapshotFromData(effect.data) !== undefined,
	);
}

function markFreshConfirmedSnapshot(
	draft: MarkFreshConfirmedSnapshotInput,
): PublicationOutputPhase["readConfirmationEvent"] {
	const confirmation = draft.readConfirmationEvent;
	if (
		confirmation?.state !== "cleared" ||
		confirmation.command !== "snapshot" ||
		confirmation.action !== "snapshot"
	) {
		return;
	}
	if (!confirmedSnapshotEvidenceComplete(draft) || !lastRowConfirmedSnapshot(draft)) {
		return;
	}
	const readConfirmationEvent: PublicationOutputPhase["readConfirmationEvent"] = {
		...confirmation,
		refSnapshotFresh: true,
	};
	draft.input.state.sessionPageState.applyReadConfirmation(
		readConfirmationEvent,
		draft.input.sessionPageStateUpdate,
	);
	draft.input.state.recordReadConfirmation(readConfirmationEvent);
	return readConfirmationEvent;
}

export function publishConfirmedSnapshot(
	draft: PublishConfirmedSnapshotInput,
): Pick<PublicationOutputPhase, "currentSessionTabTargetUnknown"> &
	Partial<Pick<PublicationOutputPhase, "currentSessionTabTarget" | "readConfirmationEvent">> {
	const readConfirmationEvent = markFreshConfirmedSnapshot(draft);
	return {
		...(readConfirmationEvent ? { readConfirmationEvent } : {}),
		...(draft.sessionStateKey !== undefined && draft.sessionStateKey.length > 0
			? { currentSessionTabTarget: draft.authoritativePageState?.tabTarget }
			: {}),
		currentSessionTabTargetUnknown:
			draft.authoritativePageState?.tabTargetUnknown === true ? true : undefined,
	};
}
