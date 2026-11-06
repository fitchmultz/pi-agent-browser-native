import type { BrowserRunState, BrowserRunStateSnapshot, BrowserRunStatePatch } from "./types.js";

// Presence checks preserve deliberate clearing of optional launch context.
type ManagedLaunchPatch = Pick<
	BrowserRunStatePatch,
	| "managedSessionCompatibilityWorkaround"
	| "managedSessionHeadedAutosaveDisabled"
	| "managedSessionHeadedAutosaveInterval"
>;
type ManagedIdentityPatch = Pick<
	BrowserRunStatePatch,
	| "managedSessionCwd"
	| "managedSessionName"
	| "managedSessionNamespace"
	| "managedSessionActive"
	| "freshSessionOrdinal"
>;

function managedLaunchUpdate(patch: ManagedLaunchPatch): ManagedLaunchPatch {
	return {
		...("managedSessionCompatibilityWorkaround" in patch
			? { managedSessionCompatibilityWorkaround: patch.managedSessionCompatibilityWorkaround }
			: {}),
		...(patch.managedSessionHeadedAutosaveDisabled !== undefined
			? { managedSessionHeadedAutosaveDisabled: patch.managedSessionHeadedAutosaveDisabled }
			: {}),
		...("managedSessionHeadedAutosaveInterval" in patch
			? { managedSessionHeadedAutosaveInterval: patch.managedSessionHeadedAutosaveInterval }
			: {}),
	};
}

function managedIdentityUpdate(patch: ManagedIdentityPatch): ManagedIdentityPatch {
	return {
		...(patch.managedSessionCwd !== undefined
			? { managedSessionCwd: patch.managedSessionCwd }
			: {}),
		...(patch.managedSessionName !== undefined
			? { managedSessionName: patch.managedSessionName }
			: {}),
		...("managedSessionNamespace" in patch
			? { managedSessionNamespace: patch.managedSessionNamespace }
			: {}),
		...(patch.managedSessionActive !== undefined
			? { managedSessionActive: patch.managedSessionActive }
			: {}),
		...(patch.freshSessionOrdinal !== undefined
			? { freshSessionOrdinal: patch.freshSessionOrdinal }
			: {}),
	};
}

/** Capture one invocation's state; helpers publish through this owner before rendering can fail. */
export function createBrowserRunState(initial: Readonly<BrowserRunStateSnapshot>): BrowserRunState {
	return {
		...initial,
		applyPatch(patch) {
			if (!patch) {
				return;
			}
			if ("artifactManifest" in patch) {
				this.artifactManifest = patch.artifactManifest;
			}
			if (patch.networkRoutesBySession) {
				this.networkRoutesBySession = patch.networkRoutesBySession;
			}
			Object.assign(this, managedLaunchUpdate(patch), managedIdentityUpdate(patch));
		},
		recordConfirmationPolicy(mayBeEstablished) {
			if (this.confirmationPolicyMayBeEstablished !== true) {
				this.confirmationPolicyMayBeEstablished = mayBeEstablished;
			}
		},
		recordReadConfirmation(confirmation) {
			this.observedBrowserEffects = {
				...this.observedBrowserEffects,
				readConfirmation: confirmation,
			};
		},
		recordBrowserEffects(effects) {
			this.observedBrowserEffects = effects;
		},
	};
}
