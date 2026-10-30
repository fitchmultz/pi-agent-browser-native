import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { cleanupSecureTempArtifacts } from "../temp.js";
import { getActiveElectronRecords, getSessionContextKey } from "./browser-run/session-state.js";
import { cleanupActiveElectronHostLaunches } from "./electron-host/index.js";
import { loadAgentBrowserConfigSync } from "../config.js";
import { closeOwnedManagedSessionsExcept } from "./extension-managed-ownership.js";
import {
	getCleanupResultsClosedManagedSessionIdentities,
	getCleanupResultsPreservedUserDataDirs,
	getOffBranchOwnedElectronLaunchRecords,
	syncElectronCleanupManagedSessions,
} from "./extension-electron-ownership.js";
import { shouldIncludeProjectConfig } from "./extension-prompt.js";
import { notifyRecordingPersistence } from "./extension-recording.js";
import { recoverScriptSessionLeasesWithinQueue } from "./extension-script-leases.js";
import {
	readTransferableManagedSessionKeys,
	restoreBranchBackedState,
} from "./extension-branch-restore.js";
import type { BrowserRuntime } from "./extension-runtime.js";

/**
 * `quit` ends process-lifetime ownership. `restart` is a managed worker replacement: the fork
 * reports `handoff` (committed) or `provisional` (unready replacement that may roll back) and the
 * next worker restores ownership from the same branch. `replace` is in-process replacement such
 * as `/reload`.
 */
type ShutdownScope = "quit" | "restart" | "replace";

class BrowserLifecycle {
	constructor(readonly runtime: BrowserRuntime) {}

	async restore(ctx: ExtensionContext, resetRuntimeOwnership: boolean): Promise<void> {
		const { runtime } = this;
		const branch = await restoreBranchBackedState(runtime, ctx, { resetRuntimeOwnership });
		if (resetRuntimeOwnership) {
			runtime.electron.childProcesses = new Map<string, ChildProcess>();
			runtime.prompt.registerWebSearch(
				loadAgentBrowserConfigSync({
					cwd: ctx.cwd,
					includeProjectConfig: shouldIncludeProjectConfig(ctx),
				}),
			);
		}
		await recoverScriptSessionLeasesWithinQueue(runtime, ctx, branch);
		runtime.recordings.flush();
		notifyRecordingPersistence(runtime.recordings.dirty, ctx);
	}

	start(ctx: ExtensionContext): Promise<void> {
		return this.runtime.managedSessionExecutionQueue.run(() =>
			this.runtime.artifacts.queue.run(() => this.restore(ctx, true)),
		);
	}

	async tree(ctx: ExtensionContext): Promise<void> {
		this.runtime.branch.invalidateRestore();
		await this.runtime.code.settle();
		await this.runtime.managedSessionExecutionQueue.run(() =>
			this.runtime.artifacts.queue.run(() => this.restore(ctx, false)),
		);
	}

	async retainedManagedSessionKeys(
		ctx: ExtensionContext | undefined,
		scope: ShutdownScope,
	): Promise<ReadonlySet<string>> {
		const { managed } = this.runtime;
		if (scope === "quit") {
			return new Set();
		}
		if (scope === "restart" && ctx) {
			try {
				return await readTransferableManagedSessionKeys(this.runtime, ctx);
			} catch {
				// An unreadable journal cannot prove transfer; keep in-process replacement retention.
			}
		}
		return managed.active
			? new Set([getSessionContextKey(managed.name, managed.namespace) ?? managed.name])
			: new Set();
	}

	async cleanup(ctx: ExtensionContext | undefined, scope: ShutdownScope): Promise<string[]> {
		const { runtime } = this;
		const quitting = scope === "quit";
		const active = getActiveElectronRecords(runtime.electron.records);
		const preserved = quitting
			? active
					.filter((record) => !runtime.electron.ownedRecords.has(record.launchId))
					.map((record) => record.userDataDir)
			: active.map((record) => record.userDataDir);
		const records = quitting
			? runtime.electron.ownedRecords
			: getOffBranchOwnedElectronLaunchRecords(
					runtime.electron.ownedRecords,
					runtime.electron.records,
				);
		const results = await cleanupActiveElectronHostLaunches({
			attachedSessionKeys: runtime.sessions.attached,
			cwd: ctx?.cwd ?? runtime.managed.cwd,
			electronChildProcesses: runtime.electron.childProcesses,
			electronLaunchRecords: records,
			managedSessionRestoreState: runtime.managed.restore,
			ownedManagedSessions: runtime.managed.owned,
			sessionPageState: runtime.sessions.pages,
			timeoutMs: runtime.implicitSessionCloseTimeoutMs,
		});
		const preservePaths = [
			...new Set([...preserved, ...getCleanupResultsPreservedUserDataDirs(results)]),
		];
		syncElectronCleanupManagedSessions(runtime.managed.owned, results);
		for (const identity of getCleanupResultsClosedManagedSessionIdentities(results)) {
			runtime.recordings.retire(identity.sessionName, identity.namespace);
		}
		await closeOwnedManagedSessionsExcept(
			runtime.managed.owned,
			runtime.sessions,
			{
				restore: runtime.managed.restore,
				timeoutMs: runtime.implicitSessionCloseTimeoutMs,
			},
			{
				keepKeys: await this.retainedManagedSessionKeys(ctx, scope),
				onClosed: (owner) => runtime.recordings.retire(owner.sessionName, owner.namespace),
			},
		);
		runtime.recordings.flush();
		notifyRecordingPersistence(runtime.recordings.dirty, ctx);
		return preservePaths;
	}

	reset(): void {
		const { runtime } = this;
		runtime.managed.reset();
		runtime.sessions.reset();
		runtime.artifacts.manifest = undefined;
		runtime.recordings.resetIfClean();
		runtime.electron.reset();
	}

	async shutdown(ctx: ExtensionContext | undefined, scope: ShutdownScope): Promise<void> {
		await this.runtime.code.settle();
		this.runtime.branch.invalidate();
		const preservePaths = await this.runtime.managedSessionExecutionQueue.run(() =>
			this.runtime.artifacts.queue.run(() => this.cleanup(ctx, scope)),
		);
		this.reset();
		await cleanupSecureTempArtifacts({ preservePaths });
	}
}

function getShutdownScope(
	event: { readonly reason?: string; readonly disposition?: string } | undefined,
): ShutdownScope {
	if (event?.reason !== "quit") {
		return "replace";
	}
	return event.disposition === "handoff" || event.disposition === "provisional"
		? "restart"
		: "quit";
}
export function registerBrowserLifecycle(runtime: BrowserRuntime): void {
	const lifecycle = new BrowserLifecycle(runtime);
	runtime.pi.on("session_start", (_event, ctx) => lifecycle.start(ctx));
	runtime.pi.on("session_tree", (_event, ctx) => lifecycle.tree(ctx));
	runtime.pi.on("session_shutdown", (event, ctx) =>
		lifecycle.shutdown(ctx, getShutdownScope(event)),
	);
}
