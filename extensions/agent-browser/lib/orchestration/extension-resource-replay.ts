import { isAbsolute } from "node:path";
import { getBrowserResultMessage } from "../browser-transcript.js";
import { canUseHeadlessCompatibilityUserAgent, extractUpstreamCommandTokens } from "../runtime.js";
import {
	extractExplicitSessionName,
	isAgentBrowserSessionIdentityKeyInNamespace,
	isUpstreamEnvFlagEnabled,
} from "../argv-grammar.js";
import { isRecord } from "../parsing.js";
import { getAgentBrowserProcessEnvironment } from "../process-environment.js";
import { isCloseCommand, resultClosedNamespace } from "../command-taxonomy.js";
import { hasLaunchScopedFlagToken } from "../launch-scoped-flags.js";
import { getActiveElectronRecords, getSessionContextKey } from "./browser-run/session-state.js";
import { isSuccessfulNativeConfirmedClose } from "../read-confirmation.js";
import { getRecognizedCompatibilityWorkaround } from "./extension-managed-ownership.js";
import {
	getCleanupResultClosedManagedSessionIdentities,
	isElectronLaunchRecord,
} from "./extension-electron-ownership.js";
import type {
	ManagedSessionLaunchState,
	BranchManagedResourceEvents,
} from "./extension-resource-contracts.js";

interface ResourceReplayRow {
	readonly details: Readonly<Record<string, unknown>>;
	readonly succeeded: boolean;
	readonly args: readonly string[];
	readonly command: string | undefined;
	readonly sessionName: string | undefined;
	readonly namespace: string | undefined;
	readonly sessionMode: "fresh" | "auto" | undefined;
	readonly usedImplicitSession: boolean;
	readonly explicitSessionName: string | undefined;
	readonly closeAllApplied: boolean;
	readonly outcome: Readonly<Record<string, unknown>> | undefined;
	readonly outcomeSucceeded: boolean;
	readonly outcomeStatus: string | undefined;
	readonly outcomeCurrentSessionName: string | undefined;
	readonly outcomeAttemptedSessionName: string | undefined;
	readonly closesSession: boolean;
}
function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function stringArgs(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const args: unknown[] = value;
	return args.every((arg): arg is string => typeof arg === "string") ? args : undefined;
}
function parseOutcomeFacts(
	outcome: Readonly<Record<string, unknown>> | undefined,
): Pick<
	ResourceReplayRow,
	"outcomeSucceeded" | "outcomeStatus" | "outcomeCurrentSessionName" | "outcomeAttemptedSessionName"
> {
	return {
		outcomeSucceeded: outcome?.succeeded === true,
		outcomeStatus: stringValue(outcome?.status),
		outcomeCurrentSessionName: stringValue(outcome?.currentSessionName),
		outcomeAttemptedSessionName: stringValue(outcome?.attemptedSessionName),
	};
}
function parseResourceRow(entry: unknown): ResourceReplayRow | undefined {
	const message = getBrowserResultMessage(entry);
	const details = isRecord(message?.details) ? message.details : undefined;
	if (!message || !details) {
		return undefined;
	}
	const args = stringArgs(details.args) ?? [];
	const command = stringValue(details.command) ?? extractUpstreamCommandTokens(args)[0];
	const resultTokens = extractUpstreamCommandTokens(getToolResultArgs(details));
	const succeeded = getSuccessfulToolResult(details, message);
	const outcome = getManagedSessionOutcome(details);
	return {
		details,
		succeeded,
		args,
		command,
		sessionName: stringValue(details.sessionName),
		namespace: stringValue(details.namespace),
		sessionMode:
			details.sessionMode === "fresh" || details.sessionMode === "auto"
				? details.sessionMode
				: undefined,
		usedImplicitSession: details.usedImplicitSession === true,
		explicitSessionName: extractExplicitSessionName(args),
		closeAllApplied: resultClosedNamespace(details, resultTokens, succeeded),
		outcome,
		...parseOutcomeFacts(outcome),
		closesSession:
			isCloseCommand(command) || isSuccessfulNativeConfirmedClose(resultTokens, details.data),
	};
}
class BranchResourceReplay {
	readonly events = {
		electronLaunchActiveRanks: new Map<string, number>(),
		electronLaunchCleanupRanks: new Map<string, number>(),
		managedSessionActiveIdentities: new Map<string, { namespace?: string; sessionName: string }>(),
		managedSessionActiveRanks: new Map<string, number>(),
		managedSessionCloseRanks: new Map<string, number>(),
		managedSessionLaunchState: new Map<string, ManagedSessionLaunchState>(),
	};
	eventRank = 0;
	retainedLaunchAfterFailure(key: string, row: ResourceReplayRow): boolean {
		const outcome = row.outcome;
		return (
			outcome?.activeAfter === true &&
			typeof outcome.currentSessionName === "string" &&
			getSessionContextKey(
				outcome.currentSessionName,
				stringValue(outcome.currentSessionNamespace),
			) === key
		);
	}
	restoreLaunchCompatibility(
		launch: Readonly<ManagedSessionLaunchState>,
		key: string,
		row: ResourceReplayRow,
	): ManagedSessionLaunchState {
		const workaround = getRecognizedCompatibilityWorkaround(row.details.compatibilityWorkaround);
		const status = row.outcome?.status;
		const retained =
			workaround !== undefined &&
			this.retainedLaunchAfterFailure(key, row) &&
			typeof status === "string" &&
			["created", "replaced", "unchanged"].includes(status);
		if (!row.succeeded && !retained) {
			return launch;
		}
		if (workaround) {
			return { ...launch, compatibilityWorkaround: workaround };
		}
		if (!canUseHeadlessCompatibilityUserAgent(getToolResultArgs(row.details))) {
			return { ...launch, compatibilityWorkaround: undefined };
		}
		return launch;
	}
	restoreLaunchAutosave(
		prior: Readonly<ManagedSessionLaunchState>,
		key: string,
		row: ResourceReplayRow,
	): ManagedSessionLaunchState {
		if (!row.succeeded && !this.retainedLaunchAfterFailure(key, row)) {
			return prior;
		}
		const launch = { ...prior };
		const details = row.details;
		if (typeof details.managedSessionHeadedAutosaveDisabled === "boolean") {
			launch.headedManagedAutosaveDisabled = details.managedSessionHeadedAutosaveDisabled;
		}
		if (typeof details.managedSessionHeadedAutosaveInterval === "string") {
			launch.headedManagedAutosaveInterval = details.managedSessionHeadedAutosaveInterval;
		} else if (details.managedSessionHeadedAutosaveDisabled === true) {
			launch.headedManagedAutosaveInterval = "0";
		}
		return launch;
	}
	restoreLaunch(row: ResourceReplayRow): void {
		const { sessionName, namespace, details } = row;
		if (sessionName === undefined || sessionName === "") {
			return;
		}
		const key = getSessionContextKey(sessionName, namespace) ?? sessionName;
		const launch = this.events.managedSessionLaunchState.get(key) ?? {
			compatibilityWorkaround: undefined,
			headedManagedAutosaveDisabled: false,
		};
		if (typeof details.managedSessionCwd === "string" && isAbsolute(details.managedSessionCwd)) {
			launch.cwd = details.managedSessionCwd;
		}
		if (typeof details.managedSessionSocketDir === "string") {
			launch.socketDir = details.managedSessionSocketDir;
		}
		const compatible = this.restoreLaunchCompatibility(launch, key, row);
		this.events.managedSessionLaunchState.set(
			key,
			this.restoreLaunchAutosave(compatible, key, row),
		);
	}
	restoreOutcomes(row: ResourceReplayRow): void {
		if (
			row.outcome?.activeAfter === true &&
			["created", "replaced", "unchanged"].includes(row.outcomeStatus ?? "")
		) {
			this.markActive(row.outcomeCurrentSessionName, row.namespace);
		}
		if (row.outcomeSucceeded && row.outcomeStatus === "closed") {
			this.markClosed(
				getSessionContextKey(
					row.outcomeAttemptedSessionName ?? row.outcomeCurrentSessionName ?? row.sessionName,
					row.namespace,
				),
			);
		}
		this.restoreReplacementClose(row);
	}
	restoreReplacementClose(row: ResourceReplayRow): void {
		const { outcome, outcomeStatus, namespace } = row;
		if (!outcome || outcomeStatus !== "replaced" || outcome.replacedSessionClosed === false) {
			return;
		}
		this.markClosed(
			getSessionContextKey(
				stringValue(outcome.replacedSessionName),
				stringValue(outcome.replacedSessionNamespace) ?? namespace,
			),
		);
	}
	isImplicitManagedLaunch(row: ResourceReplayRow): boolean {
		return (
			((row.explicitSessionName === undefined || row.explicitSessionName === "") &&
				(row.usedImplicitSession || row.sessionMode === "fresh")) ||
			row.details.managedSessionHeadedAutosaveDisabled === true ||
			typeof row.details.managedSessionHeadedAutosaveInterval === "string"
		);
	}
	restoreCommandActivity(row: ResourceReplayRow): void {
		if (!row.succeeded) {
			return;
		}
		if (row.closesSession) {
			this.markClosed(
				getSessionContextKey(
					row.explicitSessionName ??
						row.sessionName ??
						row.outcomeAttemptedSessionName ??
						row.outcomeCurrentSessionName,
					row.namespace,
				),
			);
		} else if (this.isImplicitManagedLaunch(row)) {
			this.markActive(row.sessionName, row.namespace);
		}
	}
	restoreNamespaceCloseAll(row: ResourceReplayRow): void {
		if (!row.closeAllApplied) {
			return;
		}
		for (const key of this.events.managedSessionActiveIdentities.keys()) {
			if (isAgentBrowserSessionIdentityKeyInNamespace(key, row.namespace)) {
				this.events.managedSessionCloseRanks.set(key, this.eventRank);
			}
		}
	}
	restoreElectronCleanupResult(result: unknown, row: ResourceReplayRow): void {
		if (isRecord(result) && isElectronLaunchRecord(result.record)) {
			this.events.electronLaunchCleanupRanks.set(result.record.launchId, this.eventRank);
		}
		for (const identity of getCleanupResultClosedManagedSessionIdentities(result, row.namespace)) {
			this.markClosed(
				getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName,
			);
		}
	}
	restoreElectronLaunch(value: unknown): void {
		if (
			isElectronLaunchRecord(value) &&
			getActiveElectronRecords(new Map([[value.launchId, value]])).length > 0
		) {
			this.events.electronLaunchActiveRanks.set(value.launchId, this.eventRank);
		}
	}
	restoreElectron(row: ResourceReplayRow): void {
		const electron = isRecord(row.details.electron) ? row.details.electron : undefined;
		this.restoreElectronLaunch(electron?.launch);
		const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
		this.restoreElectronCleanupRecords(cleanup?.records);
		for (const result of Array.isArray(cleanup?.results) ? cleanup.results : []) {
			this.restoreElectronCleanupResult(result, row);
		}
	}
	restoreElectronCleanupRecords(records: unknown): void {
		if (!Array.isArray(records)) {
			return;
		}
		for (const record of records) {
			if (isElectronLaunchRecord(record)) {
				this.events.electronLaunchCleanupRanks.set(record.launchId, this.eventRank);
			}
		}
	}
	markActive(sessionName: string | undefined, namespace: string | undefined): void {
		if (sessionName === undefined || sessionName === "") {
			return;
		}
		const key = getSessionContextKey(sessionName, namespace) ?? sessionName;
		this.events.managedSessionActiveIdentities.set(key, { namespace, sessionName });
		this.events.managedSessionActiveRanks.set(key, this.eventRank);
	}
	markClosed(key: string | undefined): void {
		if (key !== undefined && key !== "") {
			this.events.managedSessionCloseRanks.set(key, this.eventRank);
		}
	}
	apply(row: ResourceReplayRow): void {
		this.eventRank += 1;
		this.restoreLaunch(row);
		this.restoreOutcomes(row);
		this.restoreCommandActivity(row);
		this.restoreNamespaceCloseAll(row);
		this.restoreElectron(row);
	}
}
export function collectBranchManagedResourceEvents(
	branch: readonly unknown[],
): BranchManagedResourceEvents {
	const replay = new BranchResourceReplay();
	for (const entry of branch) {
		const row = parseResourceRow(entry);
		if (row) {
			replay.apply(row);
		}
	}
	return replay.events;
}
export function getToolResultArgs(details: Readonly<Record<string, unknown>>): string[] {
	return stringArgs(details.args) ?? stringArgs(details.effectiveArgs) ?? [];
}
export function isAttachedBrowserInvocation(
	args: readonly string[],
	env: NodeJS.ProcessEnv = getAgentBrowserProcessEnvironment(),
): boolean {
	return (
		extractUpstreamCommandTokens([...args])[0] === "connect" ||
		hasLaunchScopedFlagToken([...args], "--cdp") ||
		hasLaunchScopedFlagToken([...args], "--auto-connect") ||
		env.AGENT_BROWSER_CDP !== undefined ||
		isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_AUTO_CONNECT)
	);
}
export function getManagedSessionOutcome(
	details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
	return isRecord(details.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
}
export function getSuccessfulToolResult(
	details: Readonly<Record<string, unknown>>,
	message: Readonly<Record<string, unknown>>,
): boolean {
	const messageIsError = typeof message.isError === "boolean" ? message.isError : undefined;
	const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
	return messageIsError === undefined ? exitCode === undefined || exitCode === 0 : !messageIsError;
}
