import type {
	SessionPageStateView,
	SessionRefSnapshotInvalidation,
	SessionTabTarget,
} from "./session-page-types.js";
import type { SessionArtifactManifestEntry } from "./results/contracts.js";
export const BROWSER_TRANSITION_ENTRY = "agent-browser-transition";
export const BROWSER_RESULT_TOOLS = new Set([
	"agent_browser",
	"agent_browser_code",
	"agent_browser_action",
	"agent_browser_qa",
	"agent_browser_electron",
	"agent_browser_source",
	"agent_browser_network_source",
]);
export const BROWSER_STATE_FIELDS = [
	"args",
	"command",
	"subcommand",
	"sessionName",
	"namespace",
	"sessionMode",
	"usedImplicitSession",
	"managedSessionSocketDir",
	"managedSessionDaemon",
	"ownerSessionId",
	"agentBrowserStarted",
	"resultCategory",
	"exitCode",
	"closeAllApplied",
	"attachedBrowserSession",
	"readConfirmation",
	"compatibilityWorkaround",
	"managedSessionHeadedAutosaveDisabled",
	"managedSessionHeadedAutosaveInterval",
	"managedSessionOutcome",
	"managedSessionCwd",
	"managedSessionRestoreDisabled",
	"nativeSucceeded",
] as const;

export interface BrowserSnapshotReference {
	readonly isContentEditable?: boolean;
	readonly isEditable?: boolean;
	readonly name?: string;
	readonly role?: string;
}
export interface BrowserSnapshot {
	readonly id: string;
	readonly refs: Readonly<Record<string, BrowserSnapshotReference>>;
	readonly target?: SessionTabTarget | undefined;
	readonly generation?: string | undefined;
}
export type BrowserRefDisposition =
	| { readonly kind: "reuse"; readonly snapshotId: string }
	| { readonly kind: "replace"; readonly snapshotId: string }
	| {
			readonly kind: "invalidate";
			readonly invalidation?: SessionRefSnapshotInvalidation | undefined;
	  }
	| {
			readonly kind: "unknown";
			readonly invalidation?: SessionRefSnapshotInvalidation | undefined;
	  };
export interface BrowserPageChange {
	readonly key: string;
	readonly confirmActions?: string | null;
	readonly refs: BrowserRefDisposition;
	readonly target?: SessionTabTarget | undefined;
	readonly unknown?: true | undefined;
	readonly reopenPending?: boolean | undefined;
	readonly pinningReason?: SessionPageStateView["pinningReason"];
	readonly clear?: true;
}
export interface BrowserArtifactChanges {
	readonly upserts: readonly SessionArtifactManifestEntry[];
	readonly removals: readonly string[];
	readonly maxEntries: number;
	readonly updatedAtMs: number;
}
export interface BrowserEvent {
	readonly version: 1;
	readonly phase: "begin" | "finish" | "state";
	readonly operationId: string;
	readonly toolCallId: string;
	readonly commandIndex: number;
	readonly isError: boolean;
	readonly state: Readonly<Record<string, unknown>>;
	readonly pages?: readonly BrowserPageChange[];
	readonly artifacts?: BrowserArtifactChanges | undefined;
}
export interface BrowserRecord {
	readonly event: BrowserEvent;
	/** Raw definition/header evidence until the winning definition's consuming boundary validates it. */
	readonly snapshot?: unknown;
}
