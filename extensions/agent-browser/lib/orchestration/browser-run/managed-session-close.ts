import { rm } from "node:fs/promises";

import {
	acquireManagedSessionPolicyLock,
	type ManagedSessionPolicyLock,
} from "../../managed-session-policy-lock.js";
import {
	type ManagedSessionRestoreState,
	pruneOwnedManagedSessionRestoreSnapshots,
} from "../../managed-session-restore.js";
import { isManagedSessionRestoreKey } from "../../managed-session-storage.js";
import { isRecord } from "../../parsing.js";
import { withAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { runAgentBrowserProcess, type ProcessRunResult } from "../../process.js";
import { getAgentBrowserErrorText, parseAgentBrowserEnvelope } from "../../results/envelope.js";
import { detectConfirmationRequired } from "../../results/confirmation.js";
import type { AgentBrowserEnvelope } from "../../results/contracts.js";
import { stringifyUnknown } from "../../results/text.js";
import { redactInvocationArgs } from "../../runtime-redaction.js";
import {
	getHeadedManagedAutosaveEnv,
	inspectManagedSessionDaemon,
} from "./managed-session-daemon-inspection.js";

interface ManagedSessionCloseOptions {
	readonly confirmActions?: string;
	readonly cwd: string;
	readonly headedManagedAutosaveInterval?: string;
	readonly namespace?: string;
	readonly policyLock?: ManagedSessionPolicyLock;
	readonly preserveAttachedBrowserSession?: boolean;
	readonly restoreState: ManagedSessionRestoreState;
	readonly sessionName: string;
	readonly socketDir?: string;
	readonly timeoutMs: number;
}

interface CloseLifecycle {
	readonly signal: AbortSignal;
	readonly enterPhase: (phase: string) => void;
	readonly clearTimer: () => void;
}

function getCloseArgs(options: ManagedSessionCloseOptions): string[] {
	return [
		...(options.namespace !== undefined ? ["--namespace", options.namespace] : []),
		"--session",
		options.sessionName,
		"close",
	];
}

async function inspectCloseRestoreKey(
	options: ManagedSessionCloseOptions,
	signal: AbortSignal,
): Promise<string | null> {
	const daemon = await inspectManagedSessionDaemon({
		cwd: options.cwd,
		headedManagedAutosaveInterval: options.headedManagedAutosaveInterval,
		namespace: options.namespace,
		preserveAttachedBrowserSession: options.preserveAttachedBrowserSession,
		sessionName: options.sessionName,
		signal,
		timeoutMs: Math.min(options.timeoutMs, 2_000),
	});
	if (daemon.status === "active") {
		options.restoreState.recordDaemonRestoreKey(
			options.sessionName,
			options.namespace,
			daemon.restoreKey,
		);
	}
	const daemonRestoreKey = options.restoreState.getDaemonRestoreKey(
		options.sessionName,
		options.namespace,
	);
	return !options.restoreState.isDisabled(options.sessionName, options.namespace) &&
		isManagedSessionRestoreKey(daemonRestoreKey)
		? daemonRestoreKey
		: null;
}

function confirmedClosedData(
	processResult: ProcessRunResult,
	envelope: AgentBrowserEnvelope | undefined,
): Readonly<Record<string, unknown>> | undefined {
	return !processResult.aborted &&
		!processResult.spawnError &&
		processResult.exitCode === 0 &&
		envelope?.success === true &&
		isRecord(envelope.data) &&
		envelope.data.closed === true
		? envelope.data
		: undefined;
}

async function finishManagedClose(
	options: ManagedSessionCloseOptions,
	processResult: ProcessRunResult,
	ownedRestoreKey: string | null,
): Promise<string | undefined> {
	const parsed = await parseAgentBrowserEnvelope({
		stdout: processResult.stdout,
		stdoutPath: processResult.stdoutSpillPath,
	});
	const closedData = confirmedClosedData(processResult, parsed.envelope);
	if (closedData) {
		options.restoreState.clear(options.sessionName, options.namespace);
		pruneOwnedManagedSessionRestoreSnapshots({
			cwd: options.cwd,
			namespace: options.namespace,
			restoreKey: ownedRestoreKey,
			statePath: typeof closedData.statePath === "string" ? closedData.statePath : undefined,
		});
	}
	const pending = detectConfirmationRequired(parsed.envelope?.data);
	if (pending) {
		return `Native close requires confirmation (${pending.id}); the session remains wrapper-owned.`;
	}
	return getAgentBrowserErrorText({
		aborted: processResult.aborted,
		command: "close",
		effectiveArgs: redactInvocationArgs(getCloseArgs(options)),
		envelope: parsed.envelope,
		exitCode: processResult.exitCode,
		parseError: parsed.parseError,
		plainTextInspection: false,
		spawnError: processResult.spawnError,
		stderr: processResult.stderr,
		timedOut: processResult.timedOut,
		timeoutMs: processResult.timeoutMs,
	});
}

async function closeUnderPolicy(
	options: ManagedSessionCloseOptions,
	lifecycle: CloseLifecycle,
): Promise<string | undefined> {
	lifecycle.enterPhase("daemon inspection");
	const ownedRestoreKey = await inspectCloseRestoreKey(options, lifecycle.signal);
	lifecycle.enterPhase("native close");
	const processResult = await runAgentBrowserProcess({
		args: getCloseArgs(options),
		cwd: options.cwd,
		env: {
			AGENT_BROWSER_JSON: "1",
			...getHeadedManagedAutosaveEnv(options.headedManagedAutosaveInterval),
		},
		managedSessionRestoreState: options.restoreState,
		ownedManagedSession: true,
		preserveAttachedBrowserSession: options.preserveAttachedBrowserSession,
		signal: lifecycle.signal,
	});
	lifecycle.clearTimer();
	try {
		return await finishManagedClose(options, processResult, ownedRestoreKey);
	} finally {
		if (processResult.stdoutSpillPath !== undefined && processResult.stdoutSpillPath !== "") {
			await rm(processResult.stdoutSpillPath, { force: true }).catch(() => {
				// A spill removal failure must not replace the native close result.
			});
		}
	}
}

async function closeWithDeadline(options: ManagedSessionCloseOptions): Promise<string | undefined> {
	const controller = new AbortController();
	let phase = "policy coordination";
	// Phase time is diagnostic elapsed time, so it uses the monotonic clock like the timer itself.
	let phaseStartedAt = performance.now();
	let timeoutError: string | undefined;
	const timer = setTimeout(() => {
		timeoutError = `Managed-session cleanup timed out after ${options.timeoutMs} ms during ${phase} (${Math.round(performance.now() - phaseStartedAt)} ms in this phase).`;
		controller.abort();
	}, options.timeoutMs);
	const lifecycle: CloseLifecycle = {
		signal: controller.signal,
		enterPhase: (nextPhase) => {
			phase = nextPhase;
			phaseStartedAt = performance.now();
		},
		clearTimer: () => {
			clearTimeout(timer);
		},
	};
	let policyLock: ManagedSessionPolicyLock | undefined;
	try {
		policyLock =
			options.policyLock ??
			(await acquireManagedSessionPolicyLock({
				namespace: options.namespace,
				sessionName: options.sessionName,
				signal: controller.signal,
				timeoutMs: Math.min(options.timeoutMs, 1_000),
			}));
		if (!policyLock) {
			return (
				timeoutError ??
				"Managed-session policy coordination is unavailable or busy; cleanup did not run. Retry after the current operation finishes or repair the private policy-lock directory."
			);
		}
		try {
			const closeError = await closeUnderPolicy(options, lifecycle);
			// The deadline callback can update timeoutError while any close phase is suspended.
			return timeoutError ?? closeError;
		} catch (error) {
			return timeoutError ?? (error instanceof Error ? error.message : stringifyUnknown(error));
		}
	} finally {
		clearTimeout(timer);
		if (options.policyLock === undefined && policyLock) {
			await policyLock.release();
		}
	}
}

export function closeManagedSession(
	options: ManagedSessionCloseOptions,
): Promise<string | undefined> {
	return withAgentBrowserProcessEnvironment(
		{
			AGENT_BROWSER_CONFIRM_ACTIONS: options.confirmActions,
			...(options.socketDir !== undefined && options.socketDir !== ""
				? { PI_AGENT_BROWSER_SOCKET_DIR: options.socketDir }
				: {}),
		},
		() => closeWithDeadline(options),
	);
}
