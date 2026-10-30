import { format } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionPageState } from "../session-page-state.js";
import { getBrowserRecord, type BrowserRecord } from "../browser-transcript.js";
import { readBrowserEntries } from "../browser-journal.js";
import {
	createFreshSessionName,
	isRestorableManagedSessionName,
	restoreManagedSessionStateFromBranch,
} from "../runtime.js";
import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
import type { TraceOwner } from "./browser-run/types.js";
import { getActiveElectronRecords, getSessionContextKey } from "./browser-run/session-state.js";
import {
	restoreElectronLaunchRecordsFromBranch,
	type ElectronLaunchRecord,
} from "./electron-host/index.js";
import type { NetworkRouteRecord } from "../results/contracts.js";
import { restoreArtifactManifestFromBranch } from "./extension-result-state.js";
import {
	trackOwnedManagedSession,
	untrackOwnedManagedSessionFromBranchClose,
} from "./extension-managed-ownership.js";
import { collectBranchManagedResourceEvents } from "./extension-resource-replay.js";
import { collectPendingOwnedBrowserIntents } from "./extension-intent-replay.js";
import { restoreAttachedSessionKeysFromBranch } from "./extension-attachment-replay.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import type {
	BranchManagedResourceEvents,
	ManagedSessionLaunchState,
} from "./extension-resource-contracts.js";

interface PreviousBranchRuntime {
	readonly active: boolean;
	readonly sessionName: string;
	readonly freshOrdinal: number;
	readonly attachedKeys: ReadonlySet<string>;
	readonly pageState: SessionPageState;
}
interface BranchRestorationInput {
	readonly previous: PreviousBranchRuntime;
	readonly branch: readonly unknown[];
	readonly resetRuntimeOwnership: boolean;
}
function isActiveOnBranch(events: BranchManagedResourceEvents, key: string): boolean {
	const active = events.managedSessionActiveRanks.get(key);
	const closed = events.managedSessionCloseRanks.get(key);
	return active !== undefined && (closed === undefined || closed < active);
}
/** Transcript-proven active wrapper identities that restore reclaims for this base name. */
function* restorableBranchManagedIdentities(
	events: BranchManagedResourceEvents,
	baseName: string,
): Generator<readonly [string, Readonly<{ sessionName: string; namespace?: string }>]> {
	for (const [key, identity] of events.managedSessionActiveIdentities) {
		if (
			isActiveOnBranch(events, key) &&
			isRestorableManagedSessionName(identity.sessionName, baseName)
		) {
			yield [key, identity];
		}
	}
}
function getOwnerKey(sessionName: string, namespace: unknown): string {
	return (
		getSessionContextKey(sessionName, typeof namespace === "string" ? namespace : undefined) ??
		sessionName
	);
}
async function readBranchForRestore(
	runtime: BrowserRuntime,
	ctx: ExtensionContext,
	resetRuntimeOwnership: boolean,
): Promise<BranchRestorationInput> {
	runtime.branch.beginRestore(ctx.sessionManager.getSessionId());
	runtime.prompt.restore(ctx);
	const previous = {
		active: runtime.managed.active,
		sessionName: runtime.managed.name,
		freshOrdinal: runtime.managed.freshOrdinal,
		attachedKeys: runtime.sessions.attached,
		pageState: runtime.sessions.pages,
	};
	runtime.managed.initializeBase(
		ctx.sessionManager.getSessionId(),
		ctx.cwd,
		runtime.ephemeralSessionSeed,
	);
	try {
		const branch = await readBrowserEntries(ctx.sessionManager);
		runtime.branch.setReplayError(undefined);
		return { previous, branch, resetRuntimeOwnership };
	} catch (error) {
		runtime.branch.setReplayError(error instanceof Error ? error.message : format("%s", error));
		runtime.sessions.pages.reset();
		throw error;
	}
}
function headedLaunchTracking(launch: Readonly<ManagedSessionLaunchState> | undefined): Readonly<{
	headedManagedAutosaveDisabled: boolean;
	headedManagedAutosaveInterval?: string;
	socketDir?: string;
}> {
	return {
		headedManagedAutosaveDisabled: launch?.headedManagedAutosaveDisabled ?? false,
		headedManagedAutosaveInterval: launch?.headedManagedAutosaveInterval,
		socketDir: launch?.socketDir,
	};
}
class BrowserBranchRestoration {
	readonly branchResourceEvents: BranchManagedResourceEvents;
	readonly restoredState: ReturnType<typeof restoreManagedSessionStateFromBranch>;
	constructor(
		readonly runtime: BrowserRuntime,
		readonly ctx: ExtensionContext,
		readonly input: BranchRestorationInput,
	) {
		this.branchResourceEvents = collectBranchManagedResourceEvents(input.branch);
		this.restoredState = restoreManagedSessionStateFromBranch(
			[...input.branch],
			runtime.managed.baseName,
		);
	}
	currentLaunch(): Readonly<ManagedSessionLaunchState> | undefined {
		return this.branchResourceEvents.managedSessionLaunchState.get(
			getSessionContextKey(this.runtime.managed.name, this.runtime.managed.namespace) ??
				this.runtime.managed.name,
		);
	}
	restoreManagedState(): void {
		this.runtime.managed.restore.replace(
			[...this.restoredState.managedSessionRestoreDisabledIdentities],
			{
				preserveDaemonRestoreKeys: !this.input.resetRuntimeOwnership,
			},
		);
		this.runtime.managed.active = this.restoredState.active;
	}
	alreadyReservedPostClose(ordinal: number, shouldReserve: boolean): boolean {
		return (
			shouldReserve &&
			!this.input.resetRuntimeOwnership &&
			!this.input.previous.active &&
			this.input.previous.freshOrdinal > this.restoredState.freshSessionOrdinal &&
			this.input.previous.freshOrdinal === ordinal &&
			this.input.previous.sessionName ===
				createFreshSessionName(
					this.runtime.managed.baseName,
					this.runtime.ephemeralSessionSeed,
					ordinal,
				)
		);
	}
	reserveSession(): void {
		const restoredFreshSessionOrdinal = this.input.resetRuntimeOwnership
			? this.restoredState.freshSessionOrdinal
			: Math.max(this.input.previous.freshOrdinal, this.restoredState.freshSessionOrdinal);
		const shouldReservePostCloseSession =
			!this.restoredState.active &&
			this.restoredState.closedSessionName === this.restoredState.sessionName;
		const alreadyReservedPostCloseSession = this.alreadyReservedPostClose(
			restoredFreshSessionOrdinal,
			shouldReservePostCloseSession,
		);
		const nextFreshSessionOrdinal =
			shouldReservePostCloseSession && !alreadyReservedPostCloseSession
				? restoredFreshSessionOrdinal + 1
				: restoredFreshSessionOrdinal;
		if (!shouldReservePostCloseSession) {
			this.runtime.managed.name = this.restoredState.sessionName;
		} else if (alreadyReservedPostCloseSession) {
			this.runtime.managed.name = this.input.previous.sessionName;
		} else {
			this.runtime.managed.name = createFreshSessionName(
				this.runtime.managed.baseName,
				this.runtime.ephemeralSessionSeed,
				nextFreshSessionOrdinal,
			);
		}
		this.runtime.managed.freshOrdinal = nextFreshSessionOrdinal;
		this.runtime.managed.namespace = shouldReservePostCloseSession
			? undefined
			: this.restoredState.namespace;
	}
	restoreLaunchState(): void {
		const currentLaunch = this.currentLaunch();
		this.runtime.managed.compatibilityWorkaround = this.runtime.managed.active
			? currentLaunch?.compatibilityWorkaround
			: undefined;
		this.runtime.managed.headedAutosaveDisabled =
			this.runtime.managed.active && currentLaunch?.headedManagedAutosaveDisabled === true;
		this.runtime.managed.headedAutosaveInterval = this.runtime.managed.active
			? currentLaunch?.headedManagedAutosaveInterval
			: undefined;
		this.runtime.managed.cwd = currentLaunch?.cwd ?? this.ctx.cwd;
	}
	restoreRecordingState(): void {
		this.runtime.sessions.pages = SessionPageState.fromBranch([...this.input.branch]);
		this.runtime.sessions.traces = new Map<string, TraceOwner>();
		this.runtime.artifacts.manifest = restoreArtifactManifestFromBranch(this.input.branch);
		this.runtime.recordings.restore(this.input.branch);
	}
	restoreAttachments(): void {
		this.runtime.sessions.attached = restoreAttachedSessionKeysFromBranch(this.input.branch);
		this.runtime.sessions.routes = new Map<string, NetworkRouteRecord[]>();
		this.runtime.electron.records = restoreElectronLaunchRecordsFromBranch([...this.input.branch]);
		for (const record of getActiveElectronRecords(this.runtime.electron.records)) {
			if (record.sessionName !== undefined && record.sessionName !== "") {
				this.runtime.sessions.attached.add(
					getSessionContextKey(record.sessionName, record.namespace) ?? record.sessionName,
				);
			}
		}
	}
	restoreOwnershipRanks(): void {
		if (this.input.resetRuntimeOwnership) {
			this.runtime.managed.owned.clear();
			this.runtime.electron.resetOwnership();
		} else {
			for (const [sessionName, closeRank] of this.branchResourceEvents.managedSessionCloseRanks) {
				untrackOwnedManagedSessionFromBranchClose(
					this.runtime.managed.owned,
					sessionName,
					this.branchResourceEvents.managedSessionActiveRanks.get(sessionName),
					closeRank,
				);
			}
			this.runtime.electron.removeInactive(
				this.runtime.electron.records,
				this.branchResourceEvents.electronLaunchActiveRanks,
				this.branchResourceEvents.electronLaunchCleanupRanks,
			);
		}
	}
	restoreManagedOwners(): void {
		for (const [sessionKey, identity] of restorableBranchManagedIdentities(
			this.branchResourceEvents,
			this.runtime.managed.baseName,
		)) {
			this.restoreBranchManagedOwner(sessionKey, identity);
		}
		if (this.restoredState.active) {
			trackOwnedManagedSession(
				this.runtime.managed.owned,
				this.restoredState.sessionName,
				this.runtime.managed.cwd,
				{
					branchOwned: true,
					compatibilityWorkaround: this.runtime.managed.compatibilityWorkaround,
					headedManagedAutosaveDisabled: this.runtime.managed.headedAutosaveDisabled,
					headedManagedAutosaveInterval: this.runtime.managed.headedAutosaveInterval,
					namespace: this.restoredState.namespace,
					socketDir: this.currentLaunch()?.socketDir,
				},
			);
		}
	}
	sessionActiveOnBranch(key: string): boolean {
		return isActiveOnBranch(this.branchResourceEvents, key);
	}
	restoreBranchManagedOwner(
		key: string,
		identity: Readonly<{ sessionName: string; namespace?: string }>,
	): void {
		const launch = this.branchResourceEvents.managedSessionLaunchState.get(key);
		trackOwnedManagedSession(
			this.runtime.managed.owned,
			identity.sessionName,
			launch?.cwd ?? this.ctx.cwd,
			{
				branchOwned: true,
				compatibilityWorkaround: launch?.compatibilityWorkaround,
				headedManagedAutosaveDisabled: launch?.headedManagedAutosaveDisabled ?? false,
				headedManagedAutosaveInterval: launch?.headedManagedAutosaveInterval,
				namespace: identity.namespace,
				socketDir: launch?.socketDir,
			},
		);
	}
	restoreInterruptedIntents(): void {
		for (const begin of collectPendingOwnedBrowserIntents(
			this.input.branch,
			this.runtime.branch.ownerSessionId,
		)) {
			if (typeof begin.state.sessionName !== "string") {
				continue;
			}
			// The persisted wrapper-selected intent proves cleanup scope, not launch success.
			trackOwnedManagedSession(
				this.runtime.managed.owned,
				begin.state.sessionName,
				typeof begin.state.managedSessionCwd === "string"
					? begin.state.managedSessionCwd
					: this.ctx.cwd,
				{
					branchOwned: true,
					namespace: typeof begin.state.namespace === "string" ? begin.state.namespace : undefined,
					socketDir:
						typeof begin.state.managedSessionSocketDir === "string"
							? begin.state.managedSessionSocketDir
							: undefined,
				},
			);
		}
	}
	restoreElectronOwners(): void {
		for (const record of getActiveElectronRecords(this.runtime.electron.records)) {
			this.restoreElectronOwner(record);
		}
		this.runtime.electron.mergeActive(
			new Map(
				[...this.runtime.electron.records].filter(
					([, record]) => record.ownerSessionId === this.runtime.branch.ownerSessionId,
				),
			),
			{ markBranchOwned: true },
		);
	}
	restoreElectronOwner(record: Readonly<ElectronLaunchRecord>): void {
		const session = record.sessionName;
		if (
			session === undefined ||
			session === "" ||
			!isRestorableManagedSessionName(session, this.runtime.managed.baseName)
		) {
			return;
		}
		const key = getSessionContextKey(session) ?? session;
		if (!this.sessionActiveOnBranch(key)) {
			return;
		}
		const launch = this.branchResourceEvents.managedSessionLaunchState.get(key);
		trackOwnedManagedSession(this.runtime.managed.owned, session, launch?.cwd ?? this.ctx.cwd, {
			branchOwned: true,
			...headedLaunchTracking(launch),
		});
	}
	restoreDaemonReceipts(): void {
		for (const entry of this.input.branch) {
			const event = getBrowserRecord(entry)?.event;
			if (event && event.phase !== "begin") {
				this.restoreDaemonReceipt(event.state);
			}
		}
	}
	restoreDaemonReceipt(state: BrowserRecord["event"]["state"]): void {
		if (
			state.ownerSessionId !== this.runtime.branch.ownerSessionId ||
			typeof state.sessionName !== "string"
		) {
			return;
		}
		const namespace = typeof state.namespace === "string" ? state.namespace : undefined;
		const key = getAgentBrowserSessionIdentityKey(state.sessionName, namespace);
		if (
			this.runtime.managed.owned.has(key) &&
			!this.runtime.managed.restore.hasDaemonRestoreKey(state.sessionName, namespace)
		) {
			this.runtime.managed.restore.restoreDaemonReceipt(
				state.sessionName,
				namespace,
				state.managedSessionDaemon,
			);
		}
	}
	preserveLiveOwners(): void {
		if (!this.input.resetRuntimeOwnership) {
			// Off-branch live owners still need their established setting for cleanup.
			for (const key of this.runtime.managed.owned.keys()) {
				if (!this.branchResourceEvents.managedSessionActiveIdentities.has(key)) {
					this.runtime.sessions.pages.setConfirmActions(
						key,
						this.input.previous.pageState.get(key).confirmActions,
					);
				}
			}
			for (const sessionKey of this.input.previous.attachedKeys) {
				if (this.runtime.managed.owned.has(sessionKey)) {
					this.runtime.sessions.attached.add(sessionKey);
				}
			}
			for (const record of this.runtime.electron.ownedRecords.values()) {
				const sessionKey = getSessionContextKey(record.sessionName);
				if (
					sessionKey !== undefined &&
					sessionKey !== "" &&
					this.input.previous.attachedKeys.has(sessionKey)
				) {
					this.runtime.sessions.attached.add(sessionKey);
				}
			}
		}
	}
	run(): unknown[] {
		this.restoreManagedState();
		this.reserveSession();
		this.restoreLaunchState();
		this.restoreRecordingState();
		this.restoreAttachments();
		this.restoreOwnershipRanks();
		this.restoreManagedOwners();
		this.restoreInterruptedIntents();
		this.restoreElectronOwners();
		this.restoreDaemonReceipts();
		this.preserveLiveOwners();
		return [...this.input.branch];
	}
}
export async function restoreBranchBackedState(
	runtime: BrowserRuntime,
	ctx: ExtensionContext,
	options: { readonly resetRuntimeOwnership: boolean },
): Promise<unknown[]> {
	const input = await readBranchForRestore(runtime, ctx, options.resetRuntimeOwnership);
	return new BrowserBranchRestoration(runtime, ctx, input).run();
}

/**
 * Managed identities that a replacement worker's `session_start` restore of the active branch
 * owns again (branch-active identities, the current session, and interrupted owned intents).
 * Read-only: a managed restart keeps exactly these and closes only what cannot transfer.
 */
export async function readTransferableManagedSessionKeys(
	runtime: BrowserRuntime,
	ctx: ExtensionContext,
): Promise<Set<string>> {
	const branch = await readBrowserEntries(ctx.sessionManager);
	const { baseName } = runtime.managed;
	const keys = new Set<string>();
	for (const [key] of restorableBranchManagedIdentities(
		collectBranchManagedResourceEvents(branch),
		baseName,
	)) {
		keys.add(key);
	}
	const current = restoreManagedSessionStateFromBranch([...branch], baseName);
	if (current.active) {
		keys.add(getOwnerKey(current.sessionName, current.namespace));
	}
	for (const begin of collectPendingOwnedBrowserIntents(branch, runtime.branch.ownerSessionId)) {
		if (typeof begin.state.sessionName === "string") {
			keys.add(getOwnerKey(begin.state.sessionName, begin.state.namespace));
		}
	}
	return keys;
}
