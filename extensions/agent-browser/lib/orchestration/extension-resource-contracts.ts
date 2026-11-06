import type { CompatibilityWorkaround } from "../runtime-contracts.js";

import type { AgentBrowserSessionIdentity } from "../session-identity.js";

export interface OwnedManagedSession extends AgentBrowserSessionIdentity {
	readonly branchOwned: boolean;
	readonly compatibilityWorkaround?: CompatibilityWorkaround | undefined;
	readonly cwd: string;
	readonly headedManagedAutosaveDisabled?: boolean | undefined;
	readonly headedManagedAutosaveInterval?: string | undefined;
	readonly socketDir?: string | undefined;
}
/** Mutable cleanup registry; entries are readonly and changes belong to its explicit mutators. */
export type OwnedManagedSessionStore = Map<string, OwnedManagedSession>;
/** Successful cwd/PATH probes retained for one extension runtime. */
export type ValidatedUpstreamPaths = Set<string>;
export type ManagedSessionLaunchState = {
	-readonly [K in keyof LaunchSettings]?: LaunchSettings[K];
};
type LaunchSettings = Pick<
	OwnedManagedSession,
	| "cwd"
	| "compatibilityWorkaround"
	| "headedManagedAutosaveDisabled"
	| "headedManagedAutosaveInterval"
	| "socketDir"
>;
export interface BranchManagedResourceEvents {
	readonly electronLaunchActiveRanks: ReadonlyMap<string, number>;
	readonly electronLaunchCleanupRanks: ReadonlyMap<string, number>;
	readonly managedSessionActiveIdentities: ReadonlyMap<string, AgentBrowserSessionIdentity>;
	readonly managedSessionActiveRanks: ReadonlyMap<string, number>;
	readonly managedSessionCloseRanks: ReadonlyMap<string, number>;
	readonly managedSessionLaunchState: ReadonlyMap<string, Readonly<ManagedSessionLaunchState>>;
}
export type ElectronClosedManagedSessionIdentity = AgentBrowserSessionIdentity;
