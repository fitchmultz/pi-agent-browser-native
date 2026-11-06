import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { redactSensitiveText } from "../runtime.js";
import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
import { withIsolatedAgentBrowserEnvironment } from "../process-environment.js";
import { closeManagedSession } from "./browser-run/managed-session-daemon-policy.js";
import {
	AGENT_BROWSER_SCRIPT_NAMESPACE,
	isAgentBrowserScriptSessionName,
} from "../input-modes/script.js";
import { appendScriptSessionLease, getScriptSessionLeasesFromBranch } from "./script-mode.js";
import {
	trackOwnedManagedSession,
	untrackOwnedManagedSession,
} from "./extension-managed-ownership.js";
import type { OwnedManagedSessionStore } from "./extension-resource-contracts.js";
import type { ManagedSessionRestoreState } from "../managed-session-restore.js";

interface ScriptLeaseResources {
	readonly pi: ExtensionAPI;
	readonly managed: Readonly<{
		owned: OwnedManagedSessionStore;
		restore: ManagedSessionRestoreState;
	}>;
	readonly sessions: Readonly<{
		getConfirmActions: (key: string) => string | undefined;
		clear: (sessionName: string, namespace?: string) => void;
	}>;
	readonly recordings: Readonly<{ retire: (sessionName: string, namespace?: string) => void }>;
	readonly branch: Readonly<{ ownerSessionId: string }>;
	readonly implicitSessionCloseTimeoutMs: number;
}

export async function closeScriptSessionLeaseWithinQueue(
	resources: ScriptLeaseResources,
	sessionName: string,
	cwd: string,
): Promise<string | undefined> {
	const closeError = await withIsolatedAgentBrowserEnvironment(() =>
		closeManagedSession({
			confirmActions: resources.sessions.getConfirmActions(
				getAgentBrowserSessionIdentityKey(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE),
			),
			cwd,
			namespace: AGENT_BROWSER_SCRIPT_NAMESPACE,
			restoreState: resources.managed.restore,
			sessionName,
			timeoutMs: resources.implicitSessionCloseTimeoutMs,
		}),
	);
	if (closeError !== undefined && closeError !== "") {
		try {
			appendScriptSessionLease(
				resources.pi,
				sessionName,
				"failed",
				resources.branch.ownerSessionId,
			);
		} catch {
			// Retain the prior outstanding lease so the next startup retries cleanup.
		}
		return redactSensitiveText(closeError);
	}
	try {
		appendScriptSessionLease(resources.pi, sessionName, "closed", resources.branch.ownerSessionId);
	} catch {
		resources.managed.restore.disable(sessionName);
		return "The isolated session closed, but its durable cleanup record could not be saved.";
	}
	untrackOwnedManagedSession(resources.managed.owned, sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
	resources.managed.restore.clear(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
	resources.recordings.retire(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
	resources.sessions.clear(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
	return undefined;
}

export async function recoverScriptSessionLeasesWithinQueue(
	resources: ScriptLeaseResources,
	ctx: ExtensionContext,
	branch: readonly unknown[],
): Promise<void> {
	const pendingSessionNames = new Set(
		[...resources.managed.owned.values()]
			.map((session) => session.sessionName)
			.filter(isAgentBrowserScriptSessionName),
	);
	for (const lease of getScriptSessionLeasesFromBranch(
		branch,
		ctx.sessionManager.getSessionId(),
	).values()) {
		if (lease.cleanup !== "closed") {
			pendingSessionNames.add(lease.sessionName);
		}
	}
	for (const sessionName of pendingSessionNames) {
		trackOwnedManagedSession(resources.managed.owned, sessionName, ctx.cwd, {
			branchOwned: true,
			namespace: AGENT_BROWSER_SCRIPT_NAMESPACE,
		});
		resources.managed.restore.disable(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
		// Each isolated lease must close and persist its terminal record before the next cleanup.
		await closeScriptSessionLeaseWithinQueue(resources, sessionName, ctx.cwd);
	}
}
