/**
 * Purpose: Define structured agent_browser input-mode constants and TypeScript contracts.
 * Responsibilities: Share schema enums and compiled input-mode result types across input-mode modules.
 * Scope: Types and constants only; validation and compilation live in sibling modules.
 */

export const DEFAULT_SESSION_MODE = "auto" as const;

export const AGENT_BROWSER_SEMANTIC_ACTIONS = ["check", "click", "fill", "select"] as const;

export const AGENT_BROWSER_SEMANTIC_LOCATORS = ["alt", "label", "placeholder", "role", "testid", "text", "title"] as const;

export const AGENT_BROWSER_JOB_STEP_ACTIONS = ["open", "click", "fill", "select", "wait", "assertText", "assertUrl", "waitForDownload", "screenshot"] as const;

export const AGENT_BROWSER_QA_LOAD_STATES = ["domcontentloaded", "load", "networkidle"] as const;

export const AGENT_BROWSER_ELECTRON_ACTIONS = ["list", "launch", "status", "cleanup", "probe"] as const;

export const AGENT_BROWSER_ELECTRON_HANDOFFS = ["connect", "tabs", "snapshot"] as const;

export const AGENT_BROWSER_ELECTRON_TARGET_TYPES = ["page", "webview", "any"] as const;

export const AGENT_BROWSER_ELECTRON_LIST_FIELDS = new Set(["action", "query", "maxResults"]);

export const AGENT_BROWSER_ELECTRON_PROBE_FIELDS = new Set(["action", "launchId", "timeoutMs"]);

export const AGENT_BROWSER_ELECTRON_RESERVED_APP_ARGS = ["--user-data-dir", "--remote-debugging-port", "--remote-debugging-address", "--remote-debugging-pipe"] as const;

export const SOURCE_LOOKUP_WORKSPACE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

export const SOURCE_LOOKUP_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "out", "tmp", "temp"]);

export const SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES = 2_000;

export const SOURCE_LOOKUP_MAX_WORKSPACE_FILES = 5_000;

export type AgentBrowserSemanticActionName = (typeof AGENT_BROWSER_SEMANTIC_ACTIONS)[number];

export type AgentBrowserSemanticLocator = (typeof AGENT_BROWSER_SEMANTIC_LOCATORS)[number];

export type AgentBrowserJobStepAction = (typeof AGENT_BROWSER_JOB_STEP_ACTIONS)[number];

export type AgentBrowserQaLoadState = (typeof AGENT_BROWSER_QA_LOAD_STATES)[number];

export type AgentBrowserElectronAction = (typeof AGENT_BROWSER_ELECTRON_ACTIONS)[number];

export type AgentBrowserSourceLookupStatus = "candidates-found" | "no-candidates" | "unsupported";

export type AgentBrowserNetworkSourceLookupStatus = "failed-requests-found" | "no-failed-requests" | "no-candidates";

export type CompiledAgentBrowserElectron =
	| {
		action: "list";
		maxResults?: number;
		query?: string;
	}
	| {
		action: "launch";
		allow?: string[];
		appArgs?: string[];
		deny?: string[];
		appName?: string;
		appPath?: string;
		bundleId?: string;
		executablePath?: string;
		handoff: "connect" | "snapshot" | "tabs";
		targetType: "any" | "page" | "webview";
		timeoutMs?: number;
	}
	| {
		action: "cleanup" | "status";
		all?: boolean;
		launchId?: string;
		timeoutMs?: number;
	}
	| {
		action: "probe";
		launchId?: string;
		timeoutMs?: number;
	};

export interface AgentBrowserSemanticActionInput {
	action: AgentBrowserSemanticActionName;
	locator?: AgentBrowserSemanticLocator;
	value?: string;
	values?: string[];
	selector?: string;
	text?: string;
	role?: string;
	name?: string;
	session?: string;
}

export interface CompiledAgentBrowserSemanticAction {
	action: AgentBrowserSemanticActionName;
	locator?: AgentBrowserSemanticLocator;
	selector?: string;
	values?: string[];
	args: string[];
}

export interface CompiledAgentBrowserJobStep {
	action: AgentBrowserJobStepAction;
	args: string[];
}

export interface CompiledAgentBrowserJob {
	args: string[];
	stdin: string;
	steps: CompiledAgentBrowserJobStep[];
}

export interface CompiledAgentBrowserQaPreset extends CompiledAgentBrowserJob {
	checks: {
		checkConsole: boolean;
		checkErrors: boolean;
		checkNetwork: boolean;
		loadState: AgentBrowserQaLoadState;
		expectedText: string[];
		expectedSelector?: string;
		screenshotPath?: string;
		attached: boolean;
		url?: string;
	};
}

export interface CompiledAgentBrowserSourceLookupStep {
	action: "dom" | "react";
	args: string[];
}

export interface CompiledAgentBrowserSourceLookup {
	args: string[];
	stdin: string;
	steps: CompiledAgentBrowserSourceLookupStep[];
	query: {
		componentName?: string;
		includeDomHints: boolean;
		maxWorkspaceFiles: number;
		reactFiberId?: string;
		selector?: string;
	};
}

export interface AgentBrowserSourceLookupCandidate {
	column?: number;
	componentName?: string;
	confidence: "high" | "medium" | "low";
	evidence: string[];
	file?: string;
	line?: number;
	source: "react-inspect" | "dom-attribute" | "workspace-search";
}

export interface AgentBrowserSourceLookupElectronContext {
	appName?: string;
	appPath?: string;
	executablePath?: string;
	launchId?: string;
	sessionName?: string;
	url?: string;
}

export interface AgentBrowserSourceLookupAnalysis {
	candidates: AgentBrowserSourceLookupCandidate[];
	electronContext?: AgentBrowserSourceLookupElectronContext;
	limitations: string[];
	status: AgentBrowserSourceLookupStatus;
	summary: string;
	workspaceRoot?: string;
}

export interface AgentBrowserSourceLookupAnalysisContext {
	electronContext?: AgentBrowserSourceLookupElectronContext;
	workspaceRoot: string;
}

export interface CompiledAgentBrowserNetworkSourceLookup {
	args: string[];
	stdin: string;
	steps: Array<{ action: "network"; args: string[] }>;
	query: {
		filter?: string;
		maxWorkspaceFiles: number;
		requestId?: string;
		session?: string;
		url?: string;
	};
}

export interface AgentBrowserNetworkSourceLookupRequest {
	error?: string;
	method?: string;
	requestId?: string;
	status?: number;
	url?: string;
}

export interface AgentBrowserNetworkSourceLookupCandidate {
	confidence: "high" | "medium" | "low";
	evidence: string[];
	file?: string;
	line?: number;
	requestUrl?: string;
	source: "initiator" | "workspace-search";
}

export interface AgentBrowserNetworkSourceLookupAnalysis {
	candidates: AgentBrowserNetworkSourceLookupCandidate[];
	failedRequests: AgentBrowserNetworkSourceLookupRequest[];
	limitations: string[];
	status: AgentBrowserNetworkSourceLookupStatus;
	summary: string;
}

export interface AgentBrowserQaPresetAnalysis {
	failedChecks: string[];
	passed: boolean;
	summary: string;
	warnings: string[];
}
