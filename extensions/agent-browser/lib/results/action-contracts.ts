export type AgentBrowserRecoveryKind =
	| "about-blank"
	| "connected-session"
	| "no-active-page"
	| "tab-drift";

export interface AgentBrowserRecoveryContext {
	readonly kind: AgentBrowserRecoveryKind;
	readonly recoveryApplied?: boolean | undefined;
	readonly selectedTab?: string | undefined;
	readonly sessionName?: string | undefined;
	readonly targetTitle?: string | undefined;
	readonly targetUrl?: string | undefined;
}

export interface AgentBrowserNextAction {
	readonly artifactPath?: string;
	readonly id: string;
	readonly params?: {
		readonly args?: readonly string[];
		readonly action?: "cleanup" | "list" | "launch" | "probe" | "status";
		readonly all?: boolean;
		readonly handoff?: "connect" | "snapshot" | "tabs";
		readonly launchId?: string;
		readonly filter?: string;
		readonly namespace?: string;
		readonly requestId?: string;
		readonly session?: string;
		readonly url?: string;
		readonly sessionMode?: "auto" | "fresh";
		readonly stdin?: string;
	};
	readonly reason: string;
	readonly safety?: string;
	readonly tool: "agent_browser" | "agent_browser_electron" | "agent_browser_network_source";
}
