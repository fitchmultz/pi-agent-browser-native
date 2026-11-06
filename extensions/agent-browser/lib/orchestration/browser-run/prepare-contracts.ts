import type { CompatibilityWorkaround } from "../../runtime-contracts.js";

/** Process controls shared by the preparation probes; no browser state ownership. */
export interface PreparationProcessFacts {
	readonly cwd: string;
	readonly signal?: AbortSignal | undefined;
	readonly timeoutMs?: number | undefined;
}

/** Immutable launch facts captured before preparation begins. */
export interface PreparationSessionFacts {
	readonly managedSessionActive: boolean;
	readonly managedSessionName: string;
	readonly managedSessionNamespace?: string | undefined;
	readonly managedSessionCompatibilityWorkaround?: CompatibilityWorkaround | undefined;
	readonly managedSessionHeadedAutosaveDisabled?: boolean | undefined;
	readonly managedSessionHeadedAutosaveInterval?: string | undefined;
}
