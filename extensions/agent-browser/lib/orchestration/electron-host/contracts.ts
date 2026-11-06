import type { ChildProcess } from "node:child_process";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type { CompiledAgentBrowserElectron } from "../../input-modes/types.js";
import type { ManagedSessionRestoreState } from "../../managed-session-restore.js";
import type { SessionPageState, SessionRefSnapshot } from "../../session-page-state.js";
import type { OwnedManagedSessionReference } from "../browser-run/types.js";

// These stores belong to the extension runtime. Cleanup replaces launch records
// and retires child handles; observations receive readonly views instead.
export type ElectronHostLaunchRecords = Map<string, ElectronLaunchRecord>;
export type ElectronHostChildProcesses = Map<string, ChildProcess>;
export type ElectronManagedSessionOwner = Readonly<
	Pick<
		OwnedManagedSessionReference,
		"headedManagedAutosaveDisabled" | "headedManagedAutosaveInterval" | "socketDir"
	>
>;
export interface ElectronHostLaunchCleanupState {
	readonly sessionPageState: SessionPageState;
	readonly attachedSessionKeys: ReadonlySet<string>;
	readonly electronChildProcesses: ElectronHostChildProcesses;
	readonly electronLaunchRecords: ElectronHostLaunchRecords;
	readonly managedSessionRestoreState: ManagedSessionRestoreState;
	readonly ownedManagedSessions: ReadonlyMap<string, ElectronManagedSessionOwner>;
}
export interface ElectronHostInput extends ElectronHostLaunchCleanupState {
	readonly compiledElectron?: CompiledAgentBrowserElectron | undefined;
	readonly cwd: string;
	readonly implicitSessionCloseTimeoutMs: number;
	readonly managedSessionActive: boolean;
	readonly managedSessionName: string;
	readonly managedSessionNamespace?: string | undefined;
	readonly redactedCompiledElectron?: CompiledAgentBrowserElectron | undefined;
	readonly signal?: AbortSignal | undefined;
}
export interface ElectronHostObservationInput {
	readonly electronLaunchRecords: ReadonlyMap<string, ElectronLaunchRecord>;
	readonly cwd: string;
	readonly managedSessionActive: boolean;
	readonly managedSessionName: string;
	readonly managedSessionNamespace?: string | undefined;
	readonly managedSessionRestoreState: ManagedSessionRestoreState;
	readonly ownedManagedSessions: ReadonlyMap<string, ElectronManagedSessionOwner>;
	readonly sessionPageState: SessionPageState;
	readonly attachedSessionKeys: ReadonlySet<string>;
	readonly signal?: AbortSignal | undefined;
}
export interface ElectronManagedSessionInspection {
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly sessionName: string;
	readonly signal?: AbortSignal | undefined;
	readonly timeoutMs?: number | undefined;
}
export interface ElectronManagedSessionPolicy extends ElectronManagedSessionInspection {
	readonly confirmActions?: string | undefined;
	readonly electronLaunchRecord?: ElectronLaunchRecord | undefined;
	readonly headedManagedAutosaveDisabled?: boolean | undefined;
	readonly headedManagedAutosaveInterval?: string | undefined;
	readonly restoreState: ManagedSessionRestoreState;
}
export interface ElectronProbeContext {
	readonly launchId?: string | undefined;
	readonly mode: "current-managed-session" | "launchId";
	readonly note?: string | undefined;
	readonly sessionName: string;
}
export interface ElectronProbeFocusedElement {
	readonly ariaLabel?: string | undefined;
	readonly id?: string | undefined;
	readonly isContentEditable?: boolean | undefined;
	readonly name?: string | undefined;
	readonly placeholder?: string | undefined;
	readonly role?: string | undefined;
	readonly tagName?: string | undefined;
	readonly textLength?: number | undefined;
	readonly textPreview?: string | undefined;
	readonly title?: string | undefined;
	readonly type?: string | undefined;
	readonly valueLength?: number | undefined;
}
export interface ElectronProbeTab {
	readonly active?: boolean | undefined;
	readonly index?: number;
	readonly tabId?: string | undefined;
	readonly title?: string | undefined;
	readonly type?: string | undefined;
	readonly url?: string | undefined;
}
export interface ElectronProbeSnapshotSummary {
	readonly lineCount: number;
	readonly omittedLineCount?: number | undefined;
	readonly omittedRefCount?: number | undefined;
	readonly refCount: number;
	readonly refIds: readonly string[];
	readonly text?: string | undefined;
}
export interface ElectronProbeResult {
	readonly activeTab?: ElectronProbeTab | undefined;
	readonly errors?: readonly string[] | undefined;
	readonly focusedElement?: ElectronProbeFocusedElement | undefined;
	readonly refSnapshot?: SessionRefSnapshot | undefined;
	readonly sessionName: string;
	readonly snapshot?: ElectronProbeSnapshotSummary | undefined;
	readonly status: "partial" | "succeeded";
	readonly summary: string;
	readonly tabs?:
		| {
				readonly omittedCount?: number | undefined;
				readonly shown: readonly ElectronProbeTab[];
				readonly total: number;
		  }
		| undefined;
	readonly title?: string | undefined;
	readonly url?: string | undefined;
}
