import { extractUpstreamCommandTokens, parseCommandInfo } from "./argv-descriptor.js";
import { canonicalizeAgentBrowserNamespace, extractExplicitSessionName } from "./argv-grammar.js";
import { getSuccessfulBatchCloseLifecycle } from "./batch-lifecycle.js";
import { getBrowserResultMessage } from "./browser-transcript.js";
import { isCloseCommand, resultClosedNamespace } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";
import { isPlainTextInspectionArgs } from "./runtime-args-validation.js";
import { getRestorableManagedSessionName } from "./runtime-session-identity.js";

export interface ReplayIdentity {
	readonly namespace?: string;
	readonly sessionName: string;
}

export interface ManagedReplayEvent {
	readonly cleanupSessions: readonly ReplayIdentity[];
	readonly namespace?: string;
	readonly detailSessionName?: string;
	readonly restoreDisabled: boolean;
	readonly closeAllApplied: boolean;
	readonly managedSessionName?: string;
	readonly closesSession: boolean;
	readonly closeSucceeded: boolean;
	readonly command?: string;
	readonly succeeded: boolean;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function cleanupSession(
	step: unknown,
	record: Readonly<Record<string, unknown>> | undefined,
	fallbackNamespace: string | undefined,
	fallbackSessionName: string,
): ReplayIdentity | undefined {
	if (
		!isRecord(step) ||
		step.resource !== "managed-session" ||
		(step.state !== "removed" && step.state !== "already-gone")
	) {
		return;
	}
	const sessionName =
		getRestorableManagedSessionName(step.sessionName, fallbackSessionName) ??
		getRestorableManagedSessionName(record?.sessionName, fallbackSessionName);
	if (sessionName === undefined || sessionName.length === 0) {
		return;
	}
	return { namespace: text(step.namespace) ?? fallbackNamespace, sessionName };
}

function cleanupSessionsForResult(
	result: unknown,
	detailsNamespace: string | undefined,
	fallbackSessionName: string,
): ReplayIdentity[] {
	if (!isRecord(result) || !Array.isArray(result.steps)) {
		return [];
	}
	const record = isRecord(result.record) ? result.record : undefined;
	const namespace = text(record?.namespace) ?? detailsNamespace;
	const closedSessions: ReplayIdentity[] = [];
	for (const step of result.steps) {
		const identity = cleanupSession(step, record, namespace, fallbackSessionName);
		if (identity) {
			closedSessions.push(identity);
		}
	}
	return closedSessions;
}

function getElectronCleanupClosedManagedSessions(
	details: Readonly<Record<string, unknown>>,
	fallbackSessionName: string,
): ReplayIdentity[] {
	const electron = isRecord(details.electron) ? details.electron : undefined;
	const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
	const results: readonly unknown[] = Array.isArray(cleanup?.results) ? cleanup.results : [];
	return results.flatMap((result) =>
		cleanupSessionsForResult(result, text(details.namespace), fallbackSessionName),
	);
}

function outcomeClosedSession(
	outcome: Readonly<Record<string, unknown>> | undefined,
	sessionName: string | undefined,
	fallbackSessionName: string,
): string | undefined {
	if (outcome?.status !== "closed" || outcome.succeeded !== true) {
		return;
	}
	return (
		getRestorableManagedSessionName(outcome.attemptedSessionName, fallbackSessionName) ??
		getRestorableManagedSessionName(outcome.currentSessionName, fallbackSessionName) ??
		getRestorableManagedSessionName(sessionName, fallbackSessionName)
	);
}

function selectManagedReplaySession(options: {
	readonly closedSessionName?: string;
	readonly explicitSessionName?: string;
	readonly restorableDetailSessionName?: string;
	readonly usedImplicitSession: boolean;
	readonly freshSession: boolean;
	readonly closesSession: boolean;
}): string | undefined {
	if (options.closedSessionName !== undefined) {
		return options.closedSessionName;
	}
	const { explicitSessionName, restorableDetailSessionName } = options;
	if ((explicitSessionName ?? "").length > 0) {
		return options.closesSession && restorableDetailSessionName === explicitSessionName
			? restorableDetailSessionName
			: undefined;
	}
	if (options.usedImplicitSession || options.freshSession) {
		return (restorableDetailSessionName ?? "").length > 0 ? restorableDetailSessionName : undefined;
	}
	return;
}

function replaySucceeded(options: {
	readonly outcome?: Readonly<Record<string, unknown>>;
	readonly managedSessionName?: string;
	readonly nestedBatchRemainsActive: boolean;
	readonly messageIsError: unknown;
	readonly exitCode: unknown;
}): boolean {
	const { outcome } = options;
	const activeCurrent =
		outcome?.activeAfter === true &&
		outcome.currentSessionName === options.managedSessionName &&
		["created", "replaced", "unchanged"].includes(text(outcome.status) ?? "");
	if (activeCurrent || options.nestedBatchRemainsActive) {
		return true;
	}
	if (typeof options.messageIsError === "boolean") {
		return !options.messageIsError;
	}
	return typeof options.exitCode !== "number" || options.exitCode === 0;
}

export function decodeManagedReplayEvent(
	entry: unknown,
	fallbackSessionName: string,
): ManagedReplayEvent | undefined {
	const message = getBrowserResultMessage(entry);
	if (!message || !isRecord(message.details)) {
		return;
	}
	const details = message.details;
	const args: readonly string[] =
		Array.isArray(details.args) && details.args.every((item: unknown) => typeof item === "string")
			? details.args
			: [];
	if (isPlainTextInspectionArgs(args)) {
		return;
	}
	return decodeLifecycleEvent(details, args, message.isError, fallbackSessionName);
}

function decodeLifecycleEvent(
	details: Readonly<Record<string, unknown>>,
	args: readonly string[],
	messageIsError: unknown,
	fallbackSessionName: string,
): ManagedReplayEvent {
	const sessionName = text(details.sessionName);
	const namespace = canonicalizeAgentBrowserNamespace(text(details.namespace));
	const command = text(details.command) ?? parseCommandInfo(args).command;
	const lifecycle = getSuccessfulBatchCloseLifecycle(details.batchSteps);
	const nestedBatchEndsClosed = lifecycle?.endsClosed === true;
	const nestedBatchRemainsActive = lifecycle?.endsClosed === false;
	const closesSession = isCloseCommand(command) || nestedBatchEndsClosed;
	const outcome = isRecord(details.managedSessionOutcome)
		? details.managedSessionOutcome
		: undefined;
	const closedSessionName = outcomeClosedSession(outcome, sessionName, fallbackSessionName);
	const outcomeClosed = (closedSessionName ?? "").length > 0;
	const restorableDetailSessionName = getRestorableManagedSessionName(
		sessionName,
		fallbackSessionName,
	);
	const managedSessionName = selectManagedReplaySession({
		closedSessionName,
		explicitSessionName: extractExplicitSessionName(args),
		restorableDetailSessionName,
		usedImplicitSession: details.usedImplicitSession === true,
		freshSession: details.sessionMode === "fresh",
		closesSession,
	});
	const succeeded = replaySucceeded({
		outcome,
		managedSessionName,
		nestedBatchRemainsActive,
		messageIsError,
		exitCode: details.exitCode,
	});
	return {
		cleanupSessions: getElectronCleanupClosedManagedSessions(details, fallbackSessionName),
		namespace,
		detailSessionName: sessionName,
		restoreDisabled: details.managedSessionRestoreDisabled === true,
		closeAllApplied: resultClosedNamespace(
			details,
			extractUpstreamCommandTokens(args),
			messageIsError !== true,
		),
		managedSessionName,
		closesSession: closesSession || outcomeClosed,
		closeSucceeded: nestedBatchEndsClosed || outcomeClosed || succeeded,
		command,
		succeeded,
	};
}
