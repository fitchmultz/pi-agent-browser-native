import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { redactSensitiveText } from "../runtime.js";
import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
import { appendBrowserTransition, getBrowserRecord } from "../browser-transcript.js";
import { isRecord } from "../parsing.js";
import { withIsolatedAgentBrowserEnvironment } from "../process-environment.js";
import { closeManagedSession } from "./browser-run/managed-session-daemon-policy.js";
import {
	trackOwnedManagedSession,
	untrackOwnedManagedSession,
} from "./extension-managed-ownership.js";
import type { OwnedManagedSessionStore } from "./extension-resource-contracts.js";
import type { ManagedSessionRestoreState } from "../managed-session-restore.js";

// Earlier releases ran browser scripts in isolated `piab-script-*` sessions and recorded a
// cleanup lease for each. Startup still closes leases an older session left outstanding.
const SCRIPT_NAMESPACE = "";
const SCRIPT_SESSION_NAME_PATTERN =
	/^piab-script-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ScriptSessionCleanupState = "active" | "closed" | "failed";

export interface ScriptSessionLease {
	ownerSessionId?: string | undefined;
	cleanup: ScriptSessionCleanupState;
	closeCommandArgs: string[];
	launchAttempted: true;
	sessionName: string;
}

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

function isScriptSessionName(value: unknown): value is string {
	return typeof value === "string" && SCRIPT_SESSION_NAME_PATTERN.test(value);
}

function createScriptCloseArgs(sessionName: string): string[] {
	return ["--namespace", SCRIPT_NAMESPACE, "--session", sessionName, "close"];
}

// The offline converter retains outstanding isolated-session cleanup facts in canonical events.
export function getScriptSessionLeasesFromBranch(
	branch: readonly unknown[],
	ownerSessionId?: string,
): Map<string, ScriptSessionLease> {
	const leases = new Map<string, ScriptSessionLease>();
	for (const entry of branch) {
		const lease = parseScriptLease(
			getBrowserRecord(entry)?.event.state.scriptLease,
			ownerSessionId,
		);
		if (lease !== undefined) {
			leases.set(lease.sessionName, lease);
		}
	}
	return leases;
}

function parseScriptLease(
	value: unknown,
	ownerSessionId: string | undefined,
): ScriptSessionLease | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (ownerSessionId !== undefined && value.ownerSessionId !== ownerSessionId) {
		return undefined;
	}
	const { closeCommandArgs, launchAttempted, sessionName } = value;
	const cleanup = (["active", "closed", "failed"] as const).find(
		(state) => state === value.cleanup,
	);
	if (!isScriptSessionName(sessionName)) {
		return undefined;
	}
	if (cleanup === undefined) {
		return undefined;
	}
	const expected = createScriptCloseArgs(sessionName);
	if (launchAttempted !== true || !matchesCloseCommand(closeCommandArgs, expected)) {
		return undefined;
	}
	return {
		cleanup,
		closeCommandArgs: expected,
		launchAttempted: true,
		sessionName,
		ownerSessionId: typeof value.ownerSessionId === "string" ? value.ownerSessionId : undefined,
	};
}

function matchesCloseCommand(value: unknown, expected: readonly string[]): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((token, index) => token === expected[index])
	);
}

function appendScriptSessionLease(
	pi: ExtensionAPI,
	sessionName: string,
	cleanup: ScriptSessionCleanupState,
	ownerSessionId: string,
): void {
	appendBrowserTransition(pi, {
		event: {
			version: 1,
			phase: "state",
			operationId: randomUUID(),
			toolCallId: "cleanup",
			commandIndex: 0,
			isError: cleanup !== "closed",
			state: {
				scriptLease: {
					cleanup,
					closeCommandArgs: createScriptCloseArgs(sessionName),
					launchAttempted: true,
					sessionName,
					ownerSessionId,
				},
			},
		},
	});
}

async function closeScriptSessionLeaseWithinQueue(
	resources: ScriptLeaseResources,
	sessionName: string,
	cwd: string,
): Promise<string | undefined> {
	const closeError = await withIsolatedAgentBrowserEnvironment(() =>
		closeManagedSession({
			confirmActions: resources.sessions.getConfirmActions(
				getAgentBrowserSessionIdentityKey(sessionName, SCRIPT_NAMESPACE),
			),
			cwd,
			namespace: SCRIPT_NAMESPACE,
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
	untrackOwnedManagedSession(resources.managed.owned, sessionName, SCRIPT_NAMESPACE);
	resources.managed.restore.clear(sessionName, SCRIPT_NAMESPACE);
	resources.recordings.retire(sessionName, SCRIPT_NAMESPACE);
	resources.sessions.clear(sessionName, SCRIPT_NAMESPACE);
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
			.filter(isScriptSessionName),
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
			namespace: SCRIPT_NAMESPACE,
		});
		resources.managed.restore.disable(sessionName, SCRIPT_NAMESPACE);
		// Each isolated lease must close and persist its terminal record before the next cleanup.
		await closeScriptSessionLeaseWithinQueue(resources, sessionName, ctx.cwd);
	}
}
