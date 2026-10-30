import type {
	OwnedManagedSessionStore,
	OwnedManagedSession,
} from "./extension-resource-contracts.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CompatibilityWorkaround } from "../runtime.js";
import { isRecord } from "../parsing.js";
import { closeManagedSession } from "./browser-run/managed-session-daemon-policy.js";
import { getActiveElectronRecords, getSessionContextKey } from "./browser-run/session-state.js";
import type { ElectronLaunchRecord } from "./electron-host/index.js";
import type { ManagedSessionRestoreState } from "../managed-session-restore.js";

interface ManagedSessionTrackingOptions {
	readonly branchOwned?: boolean;
	readonly compatibilityWorkaround?: CompatibilityWorkaround;
	readonly headedManagedAutosaveDisabled?: boolean;
	readonly headedManagedAutosaveInterval?: string;
	readonly namespace?: string;
	readonly socketDir?: string;
}

function inheritedLaunchSettings(
	existing: OwnedManagedSession | undefined,
	options: ManagedSessionTrackingOptions,
): Pick<
	OwnedManagedSession,
	| "compatibilityWorkaround"
	| "headedManagedAutosaveDisabled"
	| "headedManagedAutosaveInterval"
	| "socketDir"
> {
	return {
		compatibilityWorkaround: Object.hasOwn(options, "compatibilityWorkaround")
			? options.compatibilityWorkaround
			: existing?.compatibilityWorkaround,
		headedManagedAutosaveDisabled:
			options.headedManagedAutosaveDisabled ?? existing?.headedManagedAutosaveDisabled,
		headedManagedAutosaveInterval:
			options.headedManagedAutosaveInterval ?? existing?.headedManagedAutosaveInterval,
		socketDir: options.socketDir ?? existing?.socketDir,
	};
}

export function trackOwnedManagedSession(
	sessions: OwnedManagedSessionStore,
	sessionName: string | undefined,
	cwd: string,
	options: ManagedSessionTrackingOptions = {},
): void {
	if (sessionName === undefined || sessionName === "") {
		return;
	}
	const key = getSessionContextKey(sessionName, options.namespace) ?? sessionName;
	const existing = sessions.get(key);
	const branchOwned = existing && !existing.branchOwned ? false : options.branchOwned === true;
	sessions.set(key, {
		branchOwned,
		...inheritedLaunchSettings(existing, options),
		cwd,
		namespace: options.namespace,
		sessionName,
	});
}

export function untrackOwnedManagedSession(
	sessions: OwnedManagedSessionStore,
	sessionName: string | undefined,
	namespace?: string,
): void {
	if (sessionName === undefined || sessionName === "") {
		return;
	}
	sessions.delete(
		sessionName.includes("\u0000")
			? sessionName
			: (getSessionContextKey(sessionName, namespace) ?? sessionName),
	);
}

export function untrackOwnedManagedSessionFromBranchClose(
	sessions: OwnedManagedSessionStore,
	sessionName: string | undefined,
	activeBranchRank: number | undefined,
	closeBranchRank: number | undefined,
): void {
	if (sessionName === undefined || sessionName === "" || closeBranchRank === undefined) {
		return;
	}
	const owner = sessions.get(sessionName);
	if (owner?.branchOwned !== true) {
		return;
	}
	if (activeBranchRank !== undefined && closeBranchRank <= activeBranchRank) {
		return;
	}
	sessions.delete(sessionName);
}

function getOutcomeLaunchSettings(
	details: Readonly<Record<string, unknown>>,
): ManagedSessionTrackingOptions {
	return {
		compatibilityWorkaround: getRecognizedCompatibilityWorkaround(details.compatibilityWorkaround),
		headedManagedAutosaveDisabled: details.managedSessionHeadedAutosaveDisabled === true,
		headedManagedAutosaveInterval:
			typeof details.managedSessionHeadedAutosaveInterval === "string"
				? details.managedSessionHeadedAutosaveInterval
				: undefined,
		namespace: typeof details.namespace === "string" ? details.namespace : undefined,
		socketDir:
			typeof details.managedSessionSocketDir === "string"
				? details.managedSessionSocketDir
				: undefined,
	};
}

function outcomeCreatesOwner(outcome: Readonly<Record<string, unknown>>): boolean {
	return (
		outcome.activeAfter === true &&
		(outcome.status === "created" ||
			outcome.status === "replaced" ||
			outcome.status === "unchanged")
	);
}

function retireOutcomeOwner(
	sessions: OwnedManagedSessionStore,
	outcome: Readonly<Record<string, unknown>>,
	details: Readonly<Record<string, unknown>>,
	current: string | undefined,
): void {
	if (outcome.succeeded !== true || outcome.status !== "closed") {
		return;
	}
	const attempted =
		typeof outcome.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
	const namespace = typeof details.namespace === "string" ? details.namespace : undefined;
	untrackOwnedManagedSession(sessions, attempted ?? current, namespace);
}
export function syncOwnedManagedSessionsFromResult(
	sessions: OwnedManagedSessionStore,
	result: AgentToolResult<unknown>,
	cwd: string,
): void {
	const details = isRecord(result.details) ? result.details : undefined;
	if (!details || !isRecord(details.managedSessionOutcome)) {
		return;
	}
	const outcome = details.managedSessionOutcome;
	const current =
		typeof outcome.currentSessionName === "string" ? outcome.currentSessionName : undefined;
	if (outcomeCreatesOwner(outcome)) {
		trackOwnedManagedSession(sessions, current, cwd, getOutcomeLaunchSettings(details));
	}
	retireOutcomeOwner(sessions, outcome, details, current);
}

export async function closeOwnedManagedSessionsExcept(
	sessions: OwnedManagedSessionStore,
	pages: Readonly<{
		getConfirmActions: (key: string) => string | undefined;
		hasAttachment: (key: string) => boolean;
	}>,
	settings: Readonly<{ restore: ManagedSessionRestoreState; timeoutMs: number }>,
	options: {
		readonly keepKeys: ReadonlySet<string>;
		readonly onClosed?: (owner: OwnedManagedSession) => void;
	},
): Promise<void> {
	// Snapshot ownership before awaiting: callbacks may add owners during shutdown cleanup.
	const owners = Array.from(sessions);
	for (const [key, owner] of owners) {
		if (options.keepKeys.has(key)) {
			continue;
		}
		// Session close and its durable cleanup callback must finish before the next owner is retired.
		// oxlint-disable-next-line no-await-in-loop
		const error = await closeManagedSession({
			confirmActions: pages.getConfirmActions(key) ?? process.env.AGENT_BROWSER_CONFIRM_ACTIONS,
			cwd: owner.cwd,
			headedManagedAutosaveInterval: owner.headedManagedAutosaveInterval,
			namespace: owner.namespace,
			preserveAttachedBrowserSession: pages.hasAttachment(key),
			restoreState: settings.restore,
			sessionName: owner.sessionName,
			socketDir: owner.socketDir,
			timeoutMs: settings.timeoutMs,
		});
		if (error === undefined || error === "") {
			sessions.delete(key);
			options.onClosed?.(owner);
		}
	}
}

export function shouldSerializeBrowserCommand(
	sessions: ReadonlyMap<string, OwnedManagedSession>,
	electronRecords: ReadonlyMap<string, ElectronLaunchRecord>,
	options: {
		readonly namespace?: string;
		readonly explicitSessionName?: string;
		readonly managedSessionName: string;
	},
): boolean {
	const session = options.explicitSessionName;
	if (session === undefined || session === "" || session === options.managedSessionName) {
		return true;
	}
	if (sessions.has(getSessionContextKey(session, options.namespace) ?? session)) {
		return true;
	}
	return getActiveElectronRecords(electronRecords).some((record) => record.sessionName === session);
}

export function getRecognizedCompatibilityWorkaround(
	value: unknown,
): CompatibilityWorkaround | undefined {
	const workaround = isRecord(value) ? value : undefined;
	return (workaround?.id === "chatgpt-headless-user-agent" ||
		workaround?.id === "cloudflare-headless-user-agent") &&
		typeof workaround.reason === "string"
		? { id: workaround.id, reason: workaround.reason }
		: undefined;
}
