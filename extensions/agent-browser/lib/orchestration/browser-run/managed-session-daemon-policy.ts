/**
 * Purpose: Coordinate wrapper-owned managed-session daemon inspection, reuse, and cleanup policy.
 * Responsibilities: Serialize daemon policy decisions, verify live restore keys, and close owned sessions with snapshot cleanup.
 * Scope: Managed-session daemon policy only; page state and browser-result shaping live in sibling modules.
 * Usage: Called by browser-run preparation, Electron host probes, result handling, and extension shutdown cleanup.
 * Invariants/Assumptions: Every owned daemon decision holds the cross-process policy lock until its caller finishes the related operation.
 */

import { rm } from "node:fs/promises";

import { acquireManagedSessionPolicyLock, type ManagedSessionPolicyLock } from "../../managed-session-policy-lock.js";
import {
	type ManagedSessionRestoreState,
	type OwnedManagedSessionContext,
	pruneOwnedManagedSessionRestoreSnapshots,
} from "../../managed-session-restore.js";
import { isManagedSessionRestoreKey } from "../../managed-session-storage.js";
import { isRecord } from "../../parsing.js";
import { runAgentBrowserProcess } from "../../process.js";
import { getAgentBrowserErrorText, parseAgentBrowserEnvelope } from "../../results.js";
import { redactInvocationArgs } from "../../runtime.js";

const MANAGED_SESSION_DAEMON_INSPECTION_TIMEOUT_MS = 5_000;

export type ManagedSessionDaemonInspection =
	| { restoreKey: string | null; status: "active" }
	| { status: "inactive" | "missing-binary" | "unknown" };

export async function inspectManagedSessionDaemon(options: {
	cwd: string;
	allowManagedSessionTarget?: boolean;
	namespace?: string;
	sessionName: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<ManagedSessionDaemonInspection> {
	const processResult = await runAgentBrowserProcess({
		allowManagedSessionTarget: options.allowManagedSessionTarget,
		args: ["--json", "--namespace", options.namespace ?? "", "--session", options.sessionName, "session", "info"],
		cwd: options.cwd,
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? MANAGED_SESSION_DAEMON_INSPECTION_TIMEOUT_MS,
	});
	try {
		if ((processResult.spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { status: "missing-binary" };
		if (processResult.aborted || processResult.spawnError || processResult.exitCode !== 0) return { status: "unknown" };
		const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
		const data = parsed.parseError || parsed.envelope?.success === false ? undefined : parsed.envelope?.data;
		if (!isRecord(data) || typeof data.active !== "boolean") return { status: "unknown" };
		if (!data.active) return { status: "inactive" };
		if (!isRecord(data.runtime)) return { status: "unknown" };
		if (typeof data.runtime.restoreKey === "string" && data.runtime.restoreKey.length > 0) return { restoreKey: data.runtime.restoreKey, status: "active" };
		return data.runtime.restoreKey === null ? { restoreKey: null, status: "active" } : { status: "unknown" };
	} finally {
		if (processResult.stdoutSpillPath) await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
	}
}

export async function acquireOwnedManagedSessionDaemonPolicy(options: {
	context: OwnedManagedSessionContext;
	mode?: "close" | "reuse";
	signal?: AbortSignal;
}): Promise<{ error?: string; lock?: ManagedSessionPolicyLock }> {
	const { context, signal } = options;
	if (!context.cwd) return { error: "Managed-session policy validation requires the wrapper-owned session cwd." };
	const lock = await acquireManagedSessionPolicyLock({
		namespace: context.namespace,
		sessionName: context.sessionName,
		signal,
	});
	if (!lock) {
		return signal?.aborted
			? {}
			: {
				error: "Managed-session policy coordination is unavailable or busy. Retry after the current operation finishes, repair the private policy-lock directory, and on POSIX verify that /bin/ps or /usr/bin/ps is available.",
			};
	}

	try {
		const daemon = await inspectManagedSessionDaemon({
			allowManagedSessionTarget: true,
			cwd: context.cwd,
			namespace: context.namespace,
			sessionName: context.sessionName,
			signal,
		});
		if (daemon.status === "inactive") context.restoreState.forgetDaemonRestoreKey(context.sessionName, context.namespace);
		if (options.mode === "close") {
			if (daemon.status === "active") context.restoreState.recordDaemonRestoreKey(context.sessionName, context.namespace, daemon.restoreKey);
			return { lock };
		}

		const stickyDisabled = context.restoreState.isDisabled(context.sessionName, context.namespace);
		const hasKnownDaemonRestoreKey = context.restoreState.hasDaemonRestoreKey(context.sessionName, context.namespace);
		const knownDaemonRestoreKey = context.restoreState.getDaemonRestoreKey(context.sessionName, context.namespace);
		const requestedDaemonRestoreKey = context.restoreDecision === "enabled" && stickyDisabled
			? knownDaemonRestoreKey ?? null
			: context.expectedDaemonRestoreKey;
		if (daemon.status === "unknown") {
			return {
				error: "The wrapper could not verify this managed session's live daemon restore policy. Retry, close that session, or use sessionMode: \"fresh\".",
				lock,
			};
		}
		const restoreDisabledPolicyNeedsProvenance = stickyDisabled || context.restoreDecision !== "enabled";
		const activePolicyMatches = daemon.status === "active"
			&& (!restoreDisabledPolicyNeedsProvenance || hasKnownDaemonRestoreKey)
			&& daemon.restoreKey === requestedDaemonRestoreKey;
		if (activePolicyMatches) context.restoreState.recordDaemonRestoreKey(context.sessionName, context.namespace, daemon.restoreKey);
		return !["inactive", "missing-binary"].includes(daemon.status) && !activePolicyMatches
			? {
				error: [
					"This wrapper-owned session's live daemon does not match the requested managed-restore policy.",
					"Close that session first, retry with sessionMode: \"fresh\", or use a distinct explicit --session.",
				].join(" "),
				lock,
			}
			: { lock };
	} catch (error) {
		await lock.release();
		throw error;
	}
}

export async function closeManagedSession(options: {
	cwd: string;
	namespace?: string;
	policyLock?: ManagedSessionPolicyLock;
	restoreState: ManagedSessionRestoreState;
	sessionName: string;
	timeoutMs: number;
}): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	let stdoutSpillPath: string | undefined;
	const closeArgs = [...(options.namespace ? ["--namespace", options.namespace] : []), "--session", options.sessionName, "close"];
	const policyLock = options.policyLock ?? await acquireManagedSessionPolicyLock({
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: controller.signal,
		timeoutMs: Math.min(options.timeoutMs, 1_000),
	});
	if (!policyLock) {
		clearTimeout(timer);
		return "Managed-session policy coordination is unavailable or busy; cleanup did not run. Retry after the current operation finishes or repair the private policy-lock directory.";
	}
	try {
		const daemon = await inspectManagedSessionDaemon({
			allowManagedSessionTarget: true,
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: controller.signal,
			timeoutMs: Math.min(options.timeoutMs, 2_000),
		});
		if (daemon.status === "active") options.restoreState.recordDaemonRestoreKey(options.sessionName, options.namespace, daemon.restoreKey);
		const daemonRestoreKey = options.restoreState.getDaemonRestoreKey(options.sessionName, options.namespace);
		const ownedRestoreKey = !options.restoreState.isDisabled(options.sessionName, options.namespace)
			&& isManagedSessionRestoreKey(daemonRestoreKey) ? daemonRestoreKey : null;
		const processResult = await runAgentBrowserProcess({
			args: closeArgs,
			cwd: options.cwd,
			env: { AGENT_BROWSER_JSON: "1" },
			managedSessionRestoreState: options.restoreState,
			ownedManagedSession: true,
			signal: controller.signal,
		});
		stdoutSpillPath = processResult.stdoutSpillPath;
		if (!processResult.aborted && !processResult.spawnError && processResult.exitCode === 0) {
			const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
			const data = parsed.envelope?.success === true && isRecord(parsed.envelope.data) ? parsed.envelope.data : undefined;
			options.restoreState.clear(options.sessionName, options.namespace);
			pruneOwnedManagedSessionRestoreSnapshots({
				cwd: options.cwd,
				namespace: options.namespace,
				restoreKey: ownedRestoreKey,
				statePath: typeof data?.statePath === "string" ? data.statePath : undefined,
			});
		}
		return getAgentBrowserErrorText({
			aborted: processResult.aborted,
			command: "close",
			effectiveArgs: redactInvocationArgs(closeArgs),
			exitCode: processResult.exitCode,
			plainTextInspection: false,
			spawnError: processResult.spawnError,
			stderr: processResult.stderr,
			timedOut: processResult.timedOut,
			timeoutMs: processResult.timeoutMs,
		});
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		if (stdoutSpillPath) await rm(stdoutSpillPath, { force: true }).catch(() => undefined);
		if (!options.policyLock) await policyLock.release();
	}
}
