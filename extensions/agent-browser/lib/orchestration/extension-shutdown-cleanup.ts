import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ElectronCleanupResult } from "../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../electron/launch.js";
import { getSessionContextKey } from "./browser-run/session-state.js";
import { cleanupActiveElectronHostLaunches } from "./electron-host/index.js";
import {
	getCleanupResultsClosedManagedSessionIdentities,
	getCleanupResultsPreservedUserDataDirs,
	syncElectronCleanupManagedSessions,
} from "./extension-electron-ownership.js";
import { closeOwnedManagedSessionsExcept } from "./extension-managed-ownership.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import { ShutdownRecoveryJournal, type ShutdownRecovery } from "./extension-shutdown-recovery.js";

/** Ordered cleanup publication shares the normal ownership/page/Electron replay contracts. */
export class BrowserShutdownCleanup {
	readonly journal: ShutdownRecoveryJournal;
	constructor(
		readonly runtime: BrowserRuntime,
		readonly ctx: ExtensionContext | undefined,
		preserveResume: ReadonlySet<string>,
	) {
		this.journal = new ShutdownRecoveryJournal(runtime, ctx, preserveResume);
	}
	async prepareElectron(
		records: ReadonlyMap<string, ElectronLaunchRecord>,
		keepKeys: Set<string>,
	): Promise<void> {
		for (const record of records.values()) {
			await this.journal.electron(record);
			const key = getSessionContextKey(record.sessionName, record.namespace);
			const owner = key === undefined ? undefined : this.runtime.managed.owned.get(key);
			if (owner) {
				await this.journal.managed(owner, false);
			}
			// The launch owns its connection attempt; a failure is not retried twice in one pass.
			if (key !== undefined) {
				keepKeys.add(key);
			}
		}
	}
	async publishElectron(results: readonly ElectronCleanupResult[]): Promise<void> {
		for (const result of results) {
			this.runtime.electron.ownedRecords.set(result.record.launchId, result.record);
			if (this.runtime.electron.records.has(result.record.launchId)) {
				this.runtime.electron.records.set(result.record.launchId, result.record);
			}
			await this.journal.electron(result.record, result);
			if (result.partial) {
				this.journal.notify(
					`Retry agent_browser_electron with action "cleanup", launchId ${JSON.stringify(result.record.launchId)}. ${result.summary}`,
				);
			}
		}
		for (const identity of getCleanupResultsClosedManagedSessionIdentities(results)) {
			const key = getSessionContextKey(identity.sessionName, identity.namespace);
			const owner = key === undefined ? undefined : this.runtime.managed.owned.get(key);
			if (owner) {
				await this.journal.managed(owner, true);
			}
			this.retireManaged(identity.sessionName, identity.namespace);
		}
		syncElectronCleanupManagedSessions(this.runtime.managed.owned, results);
	}
	retireManaged(sessionName: string, namespace?: string): void {
		const { runtime } = this;
		runtime.recordings.retire(sessionName, namespace);
		runtime.sessions.clear(sessionName, namespace);
		if (
			getSessionContextKey(runtime.managed.name, runtime.managed.namespace) ===
			getSessionContextKey(sessionName, namespace)
		) {
			runtime.managed.active = false;
		}
	}
	async run(
		records: Map<string, ElectronLaunchRecord>,
		keepKeys: Set<string>,
		preserved: readonly string[],
	): Promise<{ preservePaths: string[]; pending: ShutdownRecovery }> {
		const { runtime, journal } = this;
		await this.prepareElectron(records, keepKeys);
		const results = await cleanupActiveElectronHostLaunches({
			attachedSessionKeys: runtime.sessions.attached,
			cwd: this.ctx?.cwd ?? runtime.managed.cwd,
			electronChildProcesses: runtime.electron.childProcesses,
			electronLaunchRecords: records,
			managedSessionRestoreState: runtime.managed.restore,
			ownedManagedSessions: runtime.managed.owned,
			sessionPageState: runtime.sessions.pages,
			timeoutMs: runtime.implicitSessionCloseTimeoutMs,
		});
		await this.publishElectron(results);
		await closeOwnedManagedSessionsExcept(
			runtime.managed.owned,
			runtime.sessions,
			{
				restore: runtime.managed.restore,
				timeoutMs: runtime.implicitSessionCloseTimeoutMs,
			},
			{
				keepKeys,
				onClosing: (owner) => journal.managed(owner, false),
				onClosed: async (owner) => {
					await journal.managed(owner, true);
					this.retireManaged(owner.sessionName, owner.namespace);
				},
				onFailed: (owner, error) =>
					journal.notify(
						`Retry agent_browser with args ${JSON.stringify(["--namespace", owner.namespace ?? "", "--session", owner.sessionName, "close"])}. ${error}`,
					),
			},
		);
		return {
			pending: journal.pending,
			preservePaths: [
				...new Set([...preserved, ...getCleanupResultsPreservedUserDataDirs(results)]),
			],
		};
	}
}

/** Reset presentation/transfer state, but keep failed owners and their close context in this instance. */
export function resetAfterShutdown(runtime: BrowserRuntime, pending: ShutdownRecovery): void {
	const managed = [...runtime.managed.owned].filter(([key]) => pending.managed.has(key));
	const electron = [...runtime.electron.ownedRecords].filter(([id]) => pending.electron.has(id));
	const children = runtime.electron.childProcesses;
	runtime.managed.reset();
	for (const [key, owner] of managed) {
		runtime.managed.owned.set(key, owner);
	}
	if (managed.length === 0 && electron.length === 0) {
		runtime.sessions.reset();
	}
	const { artifacts } = runtime;
	artifacts.manifest = undefined;
	runtime.recordings.resetIfClean();
	runtime.electron.reset();
	for (const [id, record] of electron) {
		runtime.electron.ownedRecords.set(id, record);
		const child = children.get(id);
		if (child) {
			runtime.electron.childProcesses.set(id, child);
		}
	}
}
