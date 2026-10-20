import { getAgentBrowserSessionIdentityKey } from "../../argv-grammar.js";
import { inspectElectronLaunchStatus, type ElectronLaunchStatus } from "../../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import {
	acquireManagedSessionPolicyLock,
	type ManagedSessionPolicyLock,
} from "../../managed-session-policy-lock.js";
import {
	type ManagedSessionRestoreState,
	type OwnedManagedSessionContext,
	withOwnedManagedSessionContext,
} from "../../managed-session-restore.js";
import { isRecord } from "../../parsing.js";
import { withAttachedBrowserSessionContext } from "../../process.js";
import { runSessionCommandData } from "./session-state.js";
import {
	getHeadedManagedAutosaveEnv,
	inspectManagedSessionDaemon,
	type ManagedSessionDaemonInspection,
} from "./managed-session-daemon-inspection.js";

export { closeManagedSession } from "./managed-session-close.js";
export {
	getRunningHeadedAutosavePolicyChangeError,
	inspectManagedSessionDaemon,
} from "./managed-session-daemon-inspection.js";
export type { ManagedSessionDaemonInspection } from "./managed-session-daemon-inspection.js";

interface DaemonPolicyOptions {
	readonly context: OwnedManagedSessionContext;
	readonly electronLaunchRecord?: ElectronLaunchRecord;
	readonly electronVerificationTimeoutMs?: number;
	readonly mode?: "close" | "reuse";
	readonly includeGeneration?: boolean;
	readonly signal?: AbortSignal;
}

interface DaemonPolicyResult {
	readonly cleanupOnlyReason?: "restore-disabled-daemon-without-provenance";
	readonly daemonStatus?: ManagedSessionDaemonInspection["status"];
	readonly generationInspection?: ManagedSessionDaemonInspection;
	readonly error?: string;
	readonly lock?: ManagedSessionPolicyLock;
}

type DaemonReceipt = Readonly<ReturnType<ManagedSessionRestoreState["getDaemonReceipt"]>>;

function hasElectronAttachmentIdentity(record: ElectronLaunchRecord): boolean {
	return (
		record.webSocketDebuggerUrl !== undefined &&
		record.webSocketDebuggerUrl !== "" &&
		record.sessionName !== undefined &&
		record.sessionName !== ""
	);
}

function restoredAttachmentTarget(
	context: OwnedManagedSessionContext,
	record: ElectronLaunchRecord | undefined,
): { readonly cwd: string; readonly record: ElectronLaunchRecord } | undefined {
	const cwd = context.cwd;
	if (cwd === undefined || cwd === "" || !record || !hasElectronAttachmentIdentity(record)) {
		return undefined;
	}
	if (
		record.cleanupState === "cleaned" ||
		getAgentBrowserSessionIdentityKey(record.sessionName ?? "", record.namespace) !==
			getAgentBrowserSessionIdentityKey(context.sessionName, context.namespace)
	) {
		return undefined;
	}
	return { cwd, record };
}

function attachmentStatusMatches(
	record: ElectronLaunchRecord,
	status: ElectronLaunchStatus,
): boolean {
	return (
		status.pidAlive === true &&
		status.userDataDirState === "present" &&
		status.version?.webSocketDebuggerUrl === record.webSocketDebuggerUrl
	);
}

function attachmentConnectionMatches(
	connection: unknown,
	record: ElectronLaunchRecord,
	status: ElectronLaunchStatus,
): boolean {
	return (
		isRecord(connection) &&
		typeof connection.cdpUrl === "string" &&
		(connection.cdpUrl === record.webSocketDebuggerUrl ||
			status.targets.some((target) => target.webSocketDebuggerUrl === connection.cdpUrl))
	);
}

async function verifyRestoredElectronAttachment(options: DaemonPolicyOptions): Promise<boolean> {
	const { context, signal } = options;
	const attachment = restoredAttachmentTarget(context, options.electronLaunchRecord);
	if (!attachment) {
		return false;
	}
	const status = await inspectElectronLaunchStatus(attachment.record, signal);
	if (signal?.aborted === true || !attachmentStatusMatches(attachment.record, status)) {
		return false;
	}
	// This metadata probe must not grant daemon provenance just by spawning.
	const connection = await withAttachedBrowserSessionContext(true, () =>
		withOwnedManagedSessionContext(undefined, () =>
			runSessionCommandData({
				args: ["get", "cdp-url"],
				cwd: attachment.cwd,
				env: getHeadedManagedAutosaveEnv(context.headedManagedAutosaveInterval),
				namespace: context.namespace,
				pinNamespace: true,
				sessionName: context.sessionName,
				signal,
				timeoutMs: options.electronVerificationTimeoutMs,
			}),
		),
	);
	return (
		// The abort callback can change this signal during the awaited CDP read; static narrowing does not model it.
		// oxlint-disable-next-line typescript/no-unnecessary-condition
		!(signal?.aborted ?? false) &&
		attachmentConnectionMatches(connection, attachment.record, status)
	);
}

function reconcileDaemonReceipt(
	context: OwnedManagedSessionContext,
	daemon: ManagedSessionDaemonInspection,
	receipt: DaemonReceipt,
): void {
	if (daemon.status === "inactive") {
		context.restoreState.forgetDaemonRestoreKey(context.sessionName, context.namespace);
	}
	if (
		daemon.status !== "active" ||
		receipt === undefined ||
		context.restoreState.hasDaemonRestoreKey(context.sessionName, context.namespace)
	) {
		return;
	}
	if (daemon.generation === receipt.generation && daemon.restoreKey === receipt.restoreKey) {
		context.restoreState.recordDaemonRestoreKey(
			context.sessionName,
			context.namespace,
			daemon.restoreKey,
			daemon.generation,
		);
	} else {
		context.restoreState.forgetDaemonRestoreKey(context.sessionName, context.namespace);
	}
}

function daemonPolicyMismatch(
	daemon: ManagedSessionDaemonInspection,
	restoreDisabledPolicyNeedsProvenance: boolean,
	hasKnownDaemonRestoreKey: boolean,
): DaemonPolicyResult {
	return {
		cleanupOnlyReason:
			daemon.status === "active" &&
			restoreDisabledPolicyNeedsProvenance &&
			!hasKnownDaemonRestoreKey
				? "restore-disabled-daemon-without-provenance"
				: undefined,
		daemonStatus: daemon.status,
		error: [
			"This wrapper-owned session's live daemon does not match the requested managed-restore policy.",
			'Close that session first, retry with sessionMode: "fresh", or use a distinct explicit --session.',
		].join(" "),
	};
}

async function validateReusableDaemonPolicy(
	options: DaemonPolicyOptions,
	daemon: ManagedSessionDaemonInspection,
): Promise<DaemonPolicyResult> {
	const { context } = options;
	const stickyDisabled = context.restoreState.isDisabled(context.sessionName, context.namespace);
	let hasKnownDaemonRestoreKey = context.restoreState.hasDaemonRestoreKey(
		context.sessionName,
		context.namespace,
	);
	const knownDaemonRestoreKey = context.restoreState.getDaemonRestoreKey(
		context.sessionName,
		context.namespace,
	);
	const requestedDaemonRestoreKey =
		context.restoreDecision === "enabled" && stickyDisabled
			? (knownDaemonRestoreKey ?? null)
			: context.expectedDaemonRestoreKey;
	if (daemon.status === "unknown") {
		return {
			error:
				'The wrapper could not verify this managed session\'s live daemon restore policy. Retry, close that session, or use sessionMode: "fresh".',
		};
	}
	const restoreDisabledPolicyNeedsProvenance =
		stickyDisabled || context.restoreDecision !== "enabled";
	const verifyAttachment =
		daemon.status === "active" &&
		restoreDisabledPolicyNeedsProvenance &&
		!hasKnownDaemonRestoreKey &&
		daemon.restoreKey === requestedDaemonRestoreKey;
	if (verifyAttachment) {
		hasKnownDaemonRestoreKey = await verifyRestoredElectronAttachment(options);
	}
	return finishReusableDaemonPolicy(
		context,
		daemon,
		{
			restoreDisabledPolicyNeedsProvenance,
			requestedDaemonRestoreKey,
			includeGeneration: options.includeGeneration,
			verifyAttachment,
		},
		hasKnownDaemonRestoreKey,
	);
}

function finishReusableDaemonPolicy(
	context: OwnedManagedSessionContext,
	daemon: ManagedSessionDaemonInspection,
	policy: {
		readonly restoreDisabledPolicyNeedsProvenance: boolean;
		readonly requestedDaemonRestoreKey: OwnedManagedSessionContext["expectedDaemonRestoreKey"];
		readonly includeGeneration?: boolean;
		readonly verifyAttachment: boolean;
	},
	hasKnownDaemonRestoreKey: boolean,
): DaemonPolicyResult {
	const activePolicyMatches =
		daemon.status === "active" &&
		(!policy.restoreDisabledPolicyNeedsProvenance || hasKnownDaemonRestoreKey) &&
		daemon.restoreKey === policy.requestedDaemonRestoreKey;
	if (activePolicyMatches) {
		context.restoreState.recordDaemonRestoreKey(
			context.sessionName,
			context.namespace,
			daemon.restoreKey,
		);
	}
	return !["inactive", "missing-binary"].includes(daemon.status) && !activePolicyMatches
		? daemonPolicyMismatch(
				daemon,
				policy.restoreDisabledPolicyNeedsProvenance,
				hasKnownDaemonRestoreKey,
			)
		: {
				daemonStatus: daemon.status,
				// The native CDP provenance helper can change the browser; never reuse its preceding sample.
				generationInspection:
					policy.includeGeneration === true && !policy.verifyAttachment ? daemon : undefined,
			};
}

function daemonGenerationRequired(
	context: OwnedManagedSessionContext,
	receipt: DaemonReceipt,
	includeGeneration: boolean | undefined,
): boolean {
	return (
		includeGeneration === true ||
		(receipt !== undefined &&
			!context.restoreState.hasDaemonRestoreKey(context.sessionName, context.namespace))
	);
}

export async function acquireOwnedManagedSessionDaemonPolicy(
	options: DaemonPolicyOptions,
): Promise<DaemonPolicyResult> {
	const { context, signal } = options;
	if (context.cwd === undefined || context.cwd === "") {
		return { error: "Managed-session policy validation requires the wrapper-owned session cwd." };
	}
	const lock = await acquireManagedSessionPolicyLock({
		namespace: context.namespace,
		sessionName: context.sessionName,
		signal,
	});
	if (!lock) {
		return signal?.aborted === true
			? {}
			: {
					error:
						"Managed-session policy coordination is unavailable or busy. Retry after the current operation finishes, repair the private policy-lock directory, and on POSIX verify that /bin/ps, /usr/bin/ps, or ps through PATH is available.",
				};
	}
	try {
		const receipt = context.restoreState.getDaemonReceipt(context.sessionName, context.namespace);
		const daemon = await inspectManagedSessionDaemon({
			cwd: context.cwd,
			includeGeneration: daemonGenerationRequired(context, receipt, options.includeGeneration),
			headedManagedAutosaveInterval: context.headedManagedAutosaveInterval,
			namespace: context.namespace,
			sessionName: context.sessionName,
			signal,
		});
		reconcileDaemonReceipt(context, daemon, receipt);
		if (options.mode === "close") {
			if (daemon.status === "active") {
				context.restoreState.recordDaemonRestoreKey(
					context.sessionName,
					context.namespace,
					daemon.restoreKey,
				);
			}
			return { daemonStatus: daemon.status, lock };
		}
		return { ...(await validateReusableDaemonPolicy(options, daemon)), lock };
	} catch (error) {
		await lock.release();
		throw error;
	}
}
