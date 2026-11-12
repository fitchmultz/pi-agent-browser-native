import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendBrowserRecord, readBrowserEntries } from "../browser-journal.js";
import { collectTransferableManagedSessionKeys } from "./extension-branch-restore.js";
import { convertBrowserEntries, legacyCleanupOwner } from "../browser-legacy-projection.js";
import {
	appendBrowserTransition,
	getBrowserRecord,
	type BrowserRecord,
} from "../browser-transcript.js";
import type { ElectronCleanupResult } from "../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../electron/launch.js";
import type { OwnedManagedSession } from "./extension-resource-contracts.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import { getSessionContextKey } from "./browser-run/session-state.js";

export interface ShutdownRecovery {
	readonly managed: ReadonlySet<string>;
	readonly electron: ReadonlySet<string>;
	readonly preserveResume: ReadonlySet<string>;
}

/** Only unfinished shutdown attempts are retried; transferred branch resources have no marker. */
export function readShutdownRecovery(
	branch: readonly unknown[],
	ownerSessionId: string,
): ShutdownRecovery {
	const managed = new Set<string>();
	const electron = new Set<string>();
	const preserveResume = new Set<string>();
	for (const entry of branch) {
		const state = getBrowserRecord(entry)?.event.state;
		if (state?.ownerSessionId !== ownerSessionId || typeof state.shutdownCleanup !== "boolean") {
			continue;
		}
		applyCleanupMarker({ managed, electron, preserveResume }, state);
	}
	return { managed, electron, preserveResume };
}

function applyCleanupMarker(
	pending: { managed: Set<string>; electron: Set<string>; preserveResume: Set<string> },
	state: BrowserRecord["event"]["state"],
): void {
	const key =
		typeof state.sessionName === "string"
			? getSessionContextKey(
					state.sessionName,
					typeof state.namespace === "string" ? state.namespace : undefined,
				)
			: undefined;
	const launchId = state.shutdownLaunchId;
	const set = typeof launchId === "string" ? pending.electron : pending.managed;
	const identity = typeof launchId === "string" ? launchId : key;
	if (identity === undefined) {
		return;
	}
	if (state.shutdownCleanup === true) {
		pending.preserveResume.delete(identity);
		set.delete(identity);
	} else {
		set.add(identity);
		if (state.shutdownPreserveResume === true) {
			pending.preserveResume.add(identity);
		} else {
			pending.preserveResume.delete(identity);
		}
	}
}

/** Live ancestry classifies cleanup only; it cannot authorize normal browser dispatch or prove durability. */
async function readShutdownClassificationBranch(
	ctx: ExtensionContext,
): Promise<readonly unknown[]> {
	try {
		return await readBrowserEntries(ctx.sessionManager);
	} catch {
		notifyShutdownRecoveryWarning(
			ctx,
			"Browser shutdown cleanup could not read the journal. Classifying the selected native in-memory branch for best-effort cleanup; recovery in another instance is not confirmed.",
		);
		const manager = ctx.sessionManager;
		return convertBrowserEntries(
			manager.getBranch(),
			legacyCleanupOwner(manager.getHeader() ?? { id: manager.getSessionId() }),
		);
	}
}

/** Native daemon shutdown does not retire branch-visible cold-resume ownership or page state. */
export async function readShutdownResumeKeys(
	runtime: BrowserRuntime,
	ctx: ExtensionContext | undefined,
	recovery: ShutdownRecovery | undefined,
	records: ReadonlyMap<string, ElectronLaunchRecord>,
): Promise<Set<string>> {
	if (!ctx) {
		return new Set();
	}
	let keys: Set<string>;
	try {
		const branch = await readShutdownClassificationBranch(ctx);
		keys = collectTransferableManagedSessionKeys(branch, {
			baseName: runtime.managed.baseName,
			ownerSessionId: runtime.branch.ownerSessionId,
		});
		const pending = recovery ?? readShutdownRecovery(branch, runtime.branch.ownerSessionId);
		for (const key of pending.managed) {
			if (!pending.preserveResume.has(key)) {
				keys.delete(key);
			}
		}
	} catch {
		notifyShutdownRecoveryWarning(
			ctx,
			"Browser shutdown cleanup could not classify the selected branch. Continuing best-effort cleanup without assuming any additional cold-resume owners; recovery in another instance is not confirmed.",
		);
		keys = new Set(recovery?.preserveResume);
	}
	// Electron cleanup destroys the owned app, not just its native connection daemon.
	for (const record of records.values()) {
		const key = getSessionContextKey(record.sessionName, record.namespace);
		if (key !== undefined) {
			keys.delete(key);
		}
	}
	return keys;
}

export function notifyShutdownRecoveryWarning(
	ctx: ExtensionContext | undefined,
	warning: string,
): void {
	if (ctx?.hasUI === true) {
		ctx.ui.notify(warning, "warning");
	} else {
		console.warn(warning);
	}
}

export class ShutdownRecoveryJournal {
	private publicationFailed = false;
	readonly pending = {
		managed: new Set<string>(),
		electron: new Set<string>(),
		preserveResume: new Set<string>(),
	};
	constructor(
		readonly runtime: BrowserRuntime,
		readonly ctx: ExtensionContext | undefined,
		readonly preserveResume: ReadonlySet<string>,
	) {}
	async append(
		state: BrowserRecord["event"]["state"],
		pages?: BrowserRecord["event"]["pages"],
	): Promise<void> {
		const record: BrowserRecord = {
			event: {
				version: 1,
				phase: "state",
				operationId: randomUUID(),
				toolCallId: "shutdown-cleanup",
				commandIndex: 0,
				isError: state.shutdownCleanup !== true,
				state: { ...state, ownerSessionId: this.runtime.branch.ownerSessionId },
				...(pages ? { pages } : {}),
			},
		};
		applyCleanupMarker(this.pending, state);
		try {
			if (
				!this.ctx ||
				!(await appendBrowserRecord(
					this.ctx.sessionManager,
					() => appendBrowserTransition(this.runtime.pi, record),
					record,
					this.runtime.branch.capture(this.ctx),
				))
			) {
				throw new Error(
					"Shutdown cleanup ownership could not be published in the active Pi journal.",
				);
			}
		} catch (error) {
			this.publicationFailed = true;
			notifyShutdownRecoveryWarning(
				this.ctx,
				`Browser shutdown cleanup journal publication failed for ${JSON.stringify(state.shutdownLaunchId ?? { sessionName: state.sessionName, namespace: state.namespace })}: ${String(error)}. Continuing best-effort cleanup; failed resources remain owned in this instance. Recovery in another instance is not confirmed.`,
			);
		}
	}
	managedPages(owner: OwnedManagedSession, closed: boolean): BrowserRecord["event"]["pages"] {
		const key = getSessionContextKey(owner.sessionName, owner.namespace) ?? owner.sessionName;
		if (this.preserveResume.has(key)) {
			return undefined;
		}
		return [
			closed
				? { key, clear: true, refs: { kind: "invalidate" } }
				: {
						key,
						confirmActions: this.runtime.sessions.getConfirmActions(key) ?? null,
						unknown: true,
						refs: { kind: "unknown" },
					},
		];
	}
	async managed(owner: OwnedManagedSession, closed: boolean): Promise<void> {
		const key = getSessionContextKey(owner.sessionName, owner.namespace) ?? owner.sessionName;
		const preserveResume = this.preserveResume.has(key);
		const retire = closed && !preserveResume;
		await this.append(
			{
				shutdownCleanup: closed,
				shutdownPreserveResume: preserveResume,
				command: retire ? "close" : "shutdown-cleanup",
				args: ["--session", owner.sessionName, ...(retire ? ["close"] : [])],
				sessionName: owner.sessionName,
				namespace: owner.namespace,
				managedSessionCwd: owner.cwd,
				managedSessionSocketDir: owner.socketDir,
				compatibilityWorkaround: owner.compatibilityWorkaround,
				managedSessionHeadedAutosaveDisabled: owner.headedManagedAutosaveDisabled,
				managedSessionHeadedAutosaveInterval: owner.headedManagedAutosaveInterval,
				managedSessionRestoreDisabled: this.runtime.managed.restore.isDisabled(
					owner.sessionName,
					owner.namespace,
				),
				managedSessionDaemon: this.runtime.managed.restore.getDaemonReceipt(
					owner.sessionName,
					owner.namespace,
				),
				attachedBrowserSession: this.runtime.sessions.hasAttachment(key),
				managedSessionOutcome:
					preserveResume && closed
						? undefined
						: {
								status: closed ? "closed" : "unchanged",
								succeeded: closed,
								activeAfter: !closed,
								currentSessionName: owner.sessionName,
								currentSessionNamespace: owner.namespace,
								attemptedSessionName: owner.sessionName,
							},
			},
			this.managedPages(owner, closed),
		);
	}
	async electron(record: ElectronLaunchRecord, result?: ElectronCleanupResult): Promise<void> {
		await this.append({
			shutdownCleanup: result !== undefined && !result.partial,
			shutdownLaunchId: record.launchId,
			electron: {
				cleanup: { records: [result?.record ?? record], results: result ? [result] : [] },
			},
		});
	}
	notify(message: string): void {
		const recovery = this.publicationFailed
			? "Recovery in another instance is not confirmed; keep Pi open and retry cleanup."
			: "Resuming this Pi conversation with the extension retries cleanup.";
		notifyShutdownRecoveryWarning(
			this.ctx,
			`Browser shutdown cleanup incomplete. ${message} Ownership is retained. ${recovery}`,
		);
	}
}
