import type { BrowserRunStatePatch, ProcessBrowserOutputInput } from "./types.js";
import type { NetworkRouteRecord, SessionArtifactManifest } from "../../results/contracts.js";
import type { CompatibilityWorkaround } from "../../runtime-contracts.js";
export interface BrowserOutputOwnershipSnapshot {
	readonly artifactManifest: SessionArtifactManifest | undefined;
	readonly freshSessionOrdinal: number;
	readonly managedSessionActive: boolean;
	readonly managedSessionCompatibilityWorkaround: CompatibilityWorkaround | undefined;
	readonly managedSessionHeadedAutosaveInterval: string | null | undefined;
	readonly managedSessionCwd: string;
	readonly managedSessionName: string;
	readonly managedSessionNamespace: string | undefined;
	readonly networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
}
export function captureBrowserOutputOwnership(
	input: Pick<ProcessBrowserOutputInput, "state">,
): BrowserOutputOwnershipSnapshot {
	return {
		artifactManifest: input.state.artifactManifest,
		freshSessionOrdinal: input.state.freshSessionOrdinal,
		managedSessionActive: input.state.managedSessionActive,
		managedSessionCompatibilityWorkaround: input.state.managedSessionCompatibilityWorkaround,
		managedSessionHeadedAutosaveInterval: input.state.managedSessionHeadedAutosaveInterval,
		managedSessionCwd: input.state.managedSessionCwd,
		managedSessionName: input.state.managedSessionName,
		managedSessionNamespace: input.state.managedSessionNamespace,
		networkRoutesBySession: input.state.networkRoutesBySession,
	};
}
export function buildOutputStatePatch(draft: BrowserOutputOwnershipSnapshot): BrowserRunStatePatch {
	return {
		artifactManifest: draft.artifactManifest,
		freshSessionOrdinal: draft.freshSessionOrdinal,
		managedSessionActive: draft.managedSessionActive,
		managedSessionCompatibilityWorkaround: draft.managedSessionCompatibilityWorkaround,
		managedSessionHeadedAutosaveInterval: draft.managedSessionHeadedAutosaveInterval,
		managedSessionCwd: draft.managedSessionCwd,
		managedSessionName: draft.managedSessionName,
		managedSessionNamespace: draft.managedSessionNamespace,
		networkRoutesBySession: draft.networkRoutesBySession,
	};
}
