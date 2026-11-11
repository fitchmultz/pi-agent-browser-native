import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendBrowserRecord } from "../browser-journal.js";
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
}

/** Only unfinished shutdown attempts are retried; transferred branch resources have no marker. */
export function readShutdownRecovery(
	branch: readonly unknown[],
	ownerSessionId: string,
): ShutdownRecovery {
	const managed = new Set<string>();
	const electron = new Set<string>();
	for (const entry of branch) {
		const state = getBrowserRecord(entry)?.event.state;
		if (state?.ownerSessionId !== ownerSessionId || typeof state.shutdownCleanup !== "boolean") {
			continue;
		}
		applyCleanupMarker({ managed, electron }, state);
	}
	return { managed, electron };
}

function applyCleanupMarker(
	pending: { managed: Set<string>; electron: Set<string> },
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
		set.delete(identity);
	} else {
		set.add(identity);
	}
}

export class ShutdownRecoveryJournal {
	readonly pending = { managed: new Set<string>(), electron: new Set<string>() };
	constructor(
		readonly runtime: BrowserRuntime,
		readonly ctx: ExtensionContext | undefined,
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
			this.warn(
				`Browser shutdown cleanup journal publication failed for ${JSON.stringify(state.shutdownLaunchId ?? { sessionName: state.sessionName, namespace: state.namespace })}. Ownership remains in this instance. Keep Pi open and retry cleanup after journal writes recover; recovery in another instance is not confirmed.`,
			);
			throw error;
		}
		applyCleanupMarker(this.pending, state);
	}
	async managed(owner: OwnedManagedSession, closed: boolean): Promise<void> {
		const key = getSessionContextKey(owner.sessionName, owner.namespace) ?? owner.sessionName;
		await this.append(
			{
				shutdownCleanup: closed,
				command: closed ? "close" : "shutdown-cleanup",
				args: ["--session", owner.sessionName, ...(closed ? ["close"] : [])],
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
				managedSessionOutcome: {
					status: closed ? "closed" : "unchanged",
					succeeded: closed,
					activeAfter: !closed,
					currentSessionName: owner.sessionName,
					currentSessionNamespace: owner.namespace,
					attemptedSessionName: owner.sessionName,
				},
			},
			[
				closed
					? { key, clear: true, refs: { kind: "invalidate" } }
					: {
							key,
							confirmActions: this.runtime.sessions.getConfirmActions(key) ?? null,
							unknown: true,
							refs: { kind: "unknown" },
						},
			],
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
		this.warn(
			`Browser shutdown cleanup incomplete. ${message} Ownership is retained; resuming this Pi conversation with the extension retries cleanup.`,
		);
	}
	warn(warning: string): void {
		if (this.ctx?.hasUI === true) {
			this.ctx.ui.notify(warning, "warning");
		} else {
			console.warn(warning);
		}
	}
}
