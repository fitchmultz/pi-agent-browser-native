import type {
	AgentBrowserFailureCategory,
	AgentBrowserResultCategory,
	AgentBrowserSuccessCategory,
	FileArtifactMetadata,
} from "./contracts.js";
import type { AgentBrowserRecoveryContext } from "./action-contracts.js";

export interface PageWedgedRecoveryHint {
	readonly replaced: boolean;
	readonly lastUrl?: string | undefined;
}

export interface AgentBrowserNextActionOptions {
	readonly artifacts?: readonly FileArtifactMetadata[] | undefined;
	readonly args?: readonly string[] | undefined;
	readonly command?: string | undefined;
	readonly confirmationId?: string | undefined;
	readonly electron?: {
		readonly launchId?: string;
		readonly sessionName?: string | undefined;
		readonly status?: "active" | "cleaned" | "dead" | "failed" | "partial" | "succeeded";
	};
	readonly failureCategory?: AgentBrowserFailureCategory | undefined;
	readonly overlayBlockedClick?: boolean;
	readonly pageWedged?: PageWedgedRecoveryHint | undefined;
	readonly resultCategory: AgentBrowserResultCategory;
	readonly recovery?: AgentBrowserRecoveryContext;
	readonly savedFilePath?: string | undefined;
	readonly sessionName?: string | undefined;
	readonly subcommand?: string | undefined;
	readonly successCategory?: AgentBrowserSuccessCategory | undefined;
}
