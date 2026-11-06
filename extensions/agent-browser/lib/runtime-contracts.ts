import type { CommandInfo } from "./argv-descriptor.js";
import type { AgentBrowserSessionIdentity } from "./session-identity.js";

export type SessionMode = "auto" | "fresh";

export interface SessionRecoveryHint {
	readonly exampleArgs: readonly string[];
	readonly exampleParams: { readonly args: readonly string[]; readonly sessionMode: "fresh" };
	readonly reason: string;
	readonly recommendedSessionMode: "fresh";
}

export interface InvalidValueFlagDetails {
	readonly flag: string;
	readonly index: number;
	readonly reason: "missing-value" | "unexpected-flag" | "unsupported-assignment";
	readonly receivedToken?: string | undefined;
}

export interface CompatibilityWorkaround {
	readonly id: "chatgpt-headless-user-agent" | "cloudflare-headless-user-agent";
	readonly reason: string;
}

export interface OpenResultTabCorrection {
	readonly selectedTab: string;
	readonly selectionKind: "index" | "label" | "tabId" | "targetId";
	readonly targetTitle?: string | undefined;
	readonly targetUrl: string;
}

export interface ExecutionPlan {
	readonly commandInfo: CommandInfo;
	readonly compatibilityWorkaround?: CompatibilityWorkaround | undefined;
	readonly effectiveArgs: readonly string[];
	readonly invalidValueFlag?: InvalidValueFlagDetails;
	readonly managedSessionName?: string | undefined;
	readonly namespace?: string | undefined;
	readonly plainTextInspection: boolean;
	readonly recoveryHint?: SessionRecoveryHint | undefined;
	readonly sessionName?: string | undefined;
	readonly startupScopedFlags: readonly string[];
	readonly usedImplicitSession: boolean;
	readonly validationError?: string | undefined;
}

export interface ExecutionPlanOptions {
	readonly freshSessionName: string;
	readonly browserIndependentReadConfirmation?: boolean;
	readonly managedSessionActive: boolean;
	readonly managedSessionCompatibilityWorkaround?: CompatibilityWorkaround | undefined;
	readonly managedSessionName: string;
	readonly managedSessionNamespace?: string | undefined;
	readonly sessionMode: SessionMode;
	readonly stdin?: string | undefined;
}

export interface ManagedSessionState {
	readonly active: boolean;
	readonly namespace?: string;
	readonly replacedSessionName?: string | undefined;
	readonly sessionName: string;
}

export interface RestoredManagedSessionState extends ManagedSessionState {
	readonly closedSessionName?: string;
	readonly freshSessionOrdinal: number;
	readonly managedSessionRestoreDisabledIdentities: readonly AgentBrowserSessionIdentity[];
}
