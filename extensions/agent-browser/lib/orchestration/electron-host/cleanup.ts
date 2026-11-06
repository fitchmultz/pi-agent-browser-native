import {
	cleanupElectronLaunchResources,
	type ElectronCleanupResult,
	type ElectronCleanupStep,
} from "../../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import { getSessionPageStateKey } from "../../session-page-state.js";
import { closeManagedSession } from "../browser-run/managed-session-daemon-policy.js";
import { getActiveElectronRecords } from "../browser-run/session-state.js";
import type { ElectronHostLaunchCleanupState } from "./contracts.js";

type CleanupOptions = ElectronHostLaunchCleanupState & {
	readonly cwd: string;
	readonly timeoutMs: number;
};
async function closeElectronManagedSession(
	options: CleanupOptions,
	record: ElectronLaunchRecord,
): Promise<string | undefined> {
	if (record.sessionName === undefined || record.sessionName.length === 0) {
		return;
	}
	const sessionKey =
		getSessionPageStateKey(record.sessionName, record.namespace) ?? record.sessionName;
	const owner = options.ownedManagedSessions.get(sessionKey);
	return closeManagedSession({
		confirmActions:
			options.sessionPageState.get(sessionKey).confirmActions ??
			process.env.AGENT_BROWSER_CONFIRM_ACTIONS,
		cwd: options.cwd,
		headedManagedAutosaveInterval: owner?.headedManagedAutosaveInterval,
		namespace: record.namespace,
		preserveAttachedBrowserSession: options.attachedSessionKeys.has(sessionKey),
		restoreState: options.managedSessionRestoreState,
		sessionName: record.sessionName,
		socketDir: owner?.socketDir,
		timeoutMs: options.timeoutMs,
	});
}
function managedSessionStep(
	record: ElectronLaunchRecord,
	error: string | undefined,
): ElectronCleanupStep | undefined {
	if (record.sessionName === undefined || record.sessionName.length === 0) {
		return;
	}
	return error !== undefined && error.length > 0
		? { error, resource: "managed-session", sessionName: record.sessionName, state: "failed" }
		: { resource: "managed-session", sessionName: record.sessionName, state: "removed" };
}
async function cleanupTrackedLaunch(
	options: CleanupOptions,
	record: ElectronLaunchRecord,
): Promise<ElectronCleanupResult> {
	const closeError = await closeElectronManagedSession(options, record);
	const step = managedSessionStep(record, closeError);
	const cleanup = await cleanupElectronLaunchResources({
		child: options.electronChildProcesses.get(record.launchId),
		record,
		timeoutMs: options.timeoutMs,
	});
	const steps = step ? [step, ...cleanup.steps] : [...cleanup.steps];
	if (closeError !== undefined && closeError.length > 0) {
		return {
			...cleanup,
			partial: true,
			record: { ...cleanup.record, cleanupState: "partial" },
			remainingResources: [...new Set(["managed-session", ...cleanup.remainingResources])],
			steps,
			summary: `Electron cleanup for ${record.launchId} is partial; managed session close failed.`,
		};
	}
	const clearedSession = record.sessionName !== undefined && record.sessionName.length > 0;
	return {
		...cleanup,
		record: clearedSession ? { ...cleanup.record, sessionName: undefined } : cleanup.record,
		steps,
	};
}
export async function cleanupTrackedElectronHostLaunches(
	options: CleanupOptions & { readonly records: readonly ElectronLaunchRecord[] },
): Promise<ElectronCleanupResult[]> {
	const results: ElectronCleanupResult[] = [];
	for (const record of options.records) {
		// Close the managed connection before its process/profile, and publish each
		// terminal record before proceeding to the next owned launch.
		const result = await cleanupTrackedLaunch(options, record);
		results.push(result);
		options.electronLaunchRecords.set(record.launchId, result.record);
		if (!result.partial) {
			options.electronChildProcesses.delete(record.launchId);
		}
	}
	return results;
}
export async function cleanupActiveElectronHostLaunches(
	options: CleanupOptions,
): Promise<ElectronCleanupResult[]> {
	const activeRecords = getActiveElectronRecords(options.electronLaunchRecords);
	return activeRecords.length > 0
		? cleanupTrackedElectronHostLaunches({ ...options, records: activeRecords })
		: [];
}
