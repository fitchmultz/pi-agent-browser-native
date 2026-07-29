/**
 * Purpose: Track process-owned managed and explicit browser sessions for shutdown cleanup.
 * Responsibilities: Maintain disjoint ownership registries, sync from tool results, and close owned sessions.
 * Scope: Ownership bookkeeping only; spawn/execution stay in the browser-run entrypoint.
 */

import { isCloseCommand, isOpenNavigationCommand } from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import { extractCommandTokens } from "../../runtime.js";
import { closeManagedSession, getSessionContextKey } from "./session-state.js";
import type { AgentBrowserToolResult } from "./types.js";

export type OwnedManagedSession = {
	branchOwned: boolean;
	cwd: string;
	namespace?: string;
	sessionName: string;
};

function getToolResultArgs(details: Record<string, unknown>): string[] {
	if (Array.isArray(details.args) && details.args.every((arg) => typeof arg === "string")) return details.args;
	if (Array.isArray(details.effectiveArgs) && details.effectiveArgs.every((arg) => typeof arg === "string")) return details.effectiveArgs;
	return [];
}

export function trackOwnedManagedSession(
	sessions: Map<string, OwnedManagedSession>,
	sessionName: string | undefined,
	cwd: string,
	options: { branchOwned?: boolean; namespace?: string } = {},
): void {
	if (!sessionName) return;
	const key = getSessionContextKey(sessionName, options.namespace) ?? sessionName;
	const existing = sessions.get(key);
	const branchOwned = existing && !existing.branchOwned ? false : options.branchOwned === true;
	sessions.set(key, { branchOwned, cwd, namespace: options.namespace, sessionName });
}

export function untrackOwnedManagedSession(sessions: Map<string, OwnedManagedSession>, sessionName: string | undefined, namespace?: string): void {
	if (!sessionName) return;
	if (sessionName.includes("\u0000")) sessions.delete(sessionName);
	else sessions.delete(getSessionContextKey(sessionName, namespace) ?? sessionName);
}

export function untrackOwnedManagedSessionFromBranchClose(
	sessions: Map<string, OwnedManagedSession>,
	sessionName: string | undefined,
	activeBranchRank: number | undefined,
	closeBranchRank: number | undefined,
): void {
	if (!sessionName || closeBranchRank === undefined) return;
	const ownedSession = sessions.get(sessionName);
	if (!ownedSession?.branchOwned) return;
	if (activeBranchRank !== undefined && closeBranchRank <= activeBranchRank) return;
	sessions.delete(sessionName);
}

export function syncOwnedManagedSessionsFromResult(
	sessions: Map<string, OwnedManagedSession>,
	explicitCleanupSessions: Map<string, OwnedManagedSession>,
	result: AgentBrowserToolResult,
	cwd: string,
): void {
	const details = isRecord(result.details) ? result.details : undefined;
	const outcome = isRecord(details?.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
	if (!outcome) return;
	const namespace = isRecord(details) && typeof details.namespace === "string" ? details.namespace : undefined;
	const succeeded = outcome.succeeded === true;
	const status = typeof outcome.status === "string" ? outcome.status : undefined;
	const currentSessionName = typeof outcome.currentSessionName === "string" ? outcome.currentSessionName : undefined;
	const attemptedSessionName = typeof outcome.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
	if (outcome.activeAfter === true && (status === "created" || status === "replaced" || status === "unchanged")) {
		trackOwnedManagedSession(sessions, currentSessionName, cwd, { namespace });
		untrackOwnedManagedSession(explicitCleanupSessions, currentSessionName, namespace);
	}
	if (succeeded && status === "closed") {
		untrackOwnedManagedSession(sessions, attemptedSessionName ?? currentSessionName, namespace);
	}
}

export function syncExplicitCleanupSessionsFromResult(
	sessions: Map<string, OwnedManagedSession>,
	managedSessions: Map<string, OwnedManagedSession>,
	result: AgentBrowserToolResult,
	cwd: string,
): void {
	const details = isRecord(result.details) ? result.details : undefined;
	const namespace = isRecord(details) && typeof details.namespace === "string" ? details.namespace : undefined;
	const sessionName = typeof details?.sessionName === "string" ? details.sessionName : undefined;
	const command = typeof details?.command === "string" ? details.command : extractCommandTokens(getToolResultArgs(details ?? {})).at(0);
	const toolSucceeded = result.isError !== true && details?.resultCategory !== "failure";
	const usedImplicitSession = details?.usedImplicitSession === true;
	const outcome = isRecord(details?.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
	if (outcome?.succeeded === true && outcome.status === "closed") {
		const closedName = typeof outcome.attemptedSessionName === "string"
			? outcome.attemptedSessionName
			: typeof outcome.currentSessionName === "string"
				? outcome.currentSessionName
				: undefined;
		untrackOwnedManagedSession(sessions, closedName, namespace);
	}
	if (toolSucceeded && sessionName && isCloseCommand(command)) {
		untrackOwnedManagedSession(sessions, sessionName, namespace);
		return;
	}
	if (!toolSucceeded || !sessionName || usedImplicitSession || !isOpenNavigationCommand(command)) return;
	const key = getSessionContextKey(sessionName, namespace) ?? sessionName;
	if (managedSessions.has(key) || outcome) return;
	trackOwnedManagedSession(sessions, sessionName, cwd, { namespace });
}

export async function closeOwnedManagedSessionsExcept(
	sessions: Map<string, OwnedManagedSession>,
	keepSessionName: string | undefined,
	timeoutMs: number,
	keepNamespace?: string,
): Promise<void> {
	const keepKey = getSessionContextKey(keepSessionName, keepNamespace);
	for (const [key, owner] of [...sessions]) {
		if (key === keepKey) continue;
		const error = await closeManagedSession({ cwd: owner.cwd, namespace: owner.namespace, sessionName: owner.sessionName, timeoutMs });
		if (!error) sessions.delete(key);
	}
}

export async function closeOwnedManagedSessions(sessions: Map<string, OwnedManagedSession>, timeoutMs: number): Promise<void> {
	await closeOwnedManagedSessionsExcept(sessions, undefined, timeoutMs);
}
