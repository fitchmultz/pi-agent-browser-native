import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanupSecureTempArtifacts } from "../temp.js";
import { getActiveElectronRecords, getSessionContextKey } from "./browser-run/session-state.js";
import { loadAgentBrowserConfigSync } from "../config.js";
import { getOffBranchOwnedElectronLaunchRecords } from "./extension-electron-ownership.js";
import { shouldIncludeProjectConfig } from "./extension-prompt.js";
import { notifyRecordingPersistence } from "./extension-recording.js";
import { recoverScriptSessionLeasesWithinQueue } from "./extension-script-leases.js";
import {
	readTransferableManagedSessionKeys,
	restoreBranchBackedState,
} from "./extension-branch-restore.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import { readShutdownRecovery, type ShutdownRecovery } from "./extension-shutdown-recovery.js";
import { BrowserShutdownCleanup, resetAfterShutdown } from "./extension-shutdown-cleanup.js";

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
		let branch = await restoreBranchBackedState(runtime, ctx, { resetRuntimeOwnership });
		const recovery = readShutdownRecovery(branch, runtime.branch.ownerSessionId);
		if (recovery.managed.size > 0 || recovery.electron.size > 0) {
			await this.cleanup(ctx, "quit", recovery);
			branch = await restoreBranchBackedState(runtime, ctx, { resetRuntimeOwnership: false });
		}
		if (resetRuntimeOwnership) {
			runtime.electron.childProcesses = new Map(
				[...runtime.electron.childProcesses].filter(([id]) =>
					runtime.electron.ownedRecords.has(id),
				),
			);
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

	async cleanup(
		ctx: ExtensionContext | undefined,
		scope: ShutdownScope,
		recovery?: ShutdownRecovery,
	): ReturnType<BrowserShutdownCleanup["run"]> {
		const { runtime } = this;
		const quitting = scope === "quit";
		const active = getActiveElectronRecords(runtime.electron.records);
		const preserved = quitting
			? active
					.filter((record) => !runtime.electron.ownedRecords.has(record.launchId))
					.map((record) => record.userDataDir)
			: active.map((record) => record.userDataDir);
		const selected = quitting
			? runtime.electron.ownedRecords
			: getOffBranchOwnedElectronLaunchRecords(
					runtime.electron.ownedRecords,
					runtime.electron.records,
				);
		const records = recovery
			? new Map([...selected].filter(([id]) => recovery.electron.has(id)))
			: selected;
		const keepKeys = recovery
			? new Set([...runtime.managed.owned.keys()].filter((key) => !recovery.managed.has(key)))
			: new Set(await this.retainedManagedSessionKeys(ctx, scope));
		const result = await new BrowserShutdownCleanup(runtime, ctx).run(records, keepKeys, preserved);
		runtime.recordings.flush();
		notifyRecordingPersistence(runtime.recordings.dirty, ctx);
		return result;
	}

	async shutdown(ctx: ExtensionContext | undefined, scope: ShutdownScope): Promise<void> {
		this.runtime.branch.invalidate();
		const { preservePaths, pending } = await this.runtime.managedSessionExecutionQueue.run(() =>
			this.runtime.artifacts.queue.run(() => this.cleanup(ctx, scope)),
		);
		resetAfterShutdown(this.runtime, pending);
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
