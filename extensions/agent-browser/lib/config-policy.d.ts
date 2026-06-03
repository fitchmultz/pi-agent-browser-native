export const AGENT_BROWSER_CONFIG_ENV: "PI_AGENT_BROWSER_CONFIG";
export const BRAVE_API_KEY_ENV: "BRAVE_API_KEY";
export const EXA_API_KEY_ENV: "EXA_API_KEY";
export const CONFIG_RELATIVE_PATH: readonly [".pi", "config", "pi-agent-browser-native", "config.json"];
export const GLOBAL_CONFIG_RELATIVE_PATH: readonly [".pi", "config", "pi-agent-browser-native", "config.json"];
export const SECRET_COMMAND_TIMEOUT_MS: 15000;

export type BrowserDefaultProfilePolicy = "explicit-only" | "authenticated-only" | "always";
export type AgentBrowserConfigScope = "global" | "project" | "override" | "env-fallback";
export type CredentialSourceKind = "literal" | "env" | "command";
export type WebSearchProvider = "exa" | "brave";
export type WebSearchProviderDescriptor = {
	provider: WebSearchProvider;
	apiKeyEnv: string;
	configKey: "exaApiKey" | "braveApiKey";
	label: string;
};

export const WEB_SEARCH_PROVIDER_DESCRIPTORS: Readonly<Record<WebSearchProvider, WebSearchProviderDescriptor>>;
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[];
export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProvider;
export const WEB_SEARCH_PROVIDER_CONFIG_KEYS: Readonly<Record<WebSearchProvider, "exaApiKey" | "braveApiKey">>;
export const WEB_SEARCH_PROVIDER_ENV_VARS: Readonly<Record<WebSearchProvider, string>>;

export interface BrowserDefaultProfileConfig {
	name: string;
	policy?: BrowserDefaultProfilePolicy;
}

export interface AgentBrowserConfig {
	version?: 1;
	webSearch?: {
		enabled?: boolean;
		preferredProvider?: WebSearchProvider;
		braveApiKey?: string;
		exaApiKey?: string;
	};
	browser?: {
		defaultProfile?: BrowserDefaultProfileConfig;
		executablePath?: string;
		defaultLaunchArgs?: string[];
	};
}

export interface ConfigLayer {
	config: AgentBrowserConfig;
	path: string;
	scope: Exclude<AgentBrowserConfigScope, "env-fallback">;
}

export interface CredentialSource {
	kind: CredentialSourceKind;
	provider?: WebSearchProvider;
	rawValue: string;
	scope: AgentBrowserConfigScope;
}

export interface AgentBrowserConfigState {
	browserDefaultProfile?: Required<BrowserDefaultProfileConfig>;
	browserDefaultProfileScope?: ConfigLayer["scope"];
	browserExecutablePath?: string;
	browserExecutablePathScope?: ConfigLayer["scope"];
	trustedBrowserDefaultProfile?: Required<BrowserDefaultProfileConfig>;
	trustedBrowserDefaultProfileScope?: Exclude<ConfigLayer["scope"], "project">;
	trustedBrowserExecutablePath?: string;
	trustedBrowserExecutablePathScope?: Exclude<ConfigLayer["scope"], "project">;
	config: AgentBrowserConfig;
	webSearchCredentialSources: Partial<Record<WebSearchProvider, CredentialSource>>;
	webSearchEnabled: boolean;
	webSearchPreferredProvider: WebSearchProvider;
	errors: string[];
	layers: ConfigLayer[];
	paths: {
		global: string;
		project: string;
		override?: string;
	};
	warnings: string[];
}

export function isWebSearchProvider(value: unknown): value is WebSearchProvider;
export function getWebSearchProviderDescriptor(provider: WebSearchProvider): WebSearchProviderDescriptor;
export function getWebSearchProviderLabel(provider: WebSearchProvider): string;
export function getWebSearchProviderEnvVar(provider: WebSearchProvider): string;
export function getWebSearchProviderConfigKey(provider: WebSearchProvider): "exaApiKey" | "braveApiKey";
export function getGlobalAgentBrowserConfigPath(env?: NodeJS.ProcessEnv): string;
export function getProjectAgentBrowserConfigPath(cwd?: string): string;
export function getAgentBrowserConfigPaths(options?: { cwd?: string; env?: NodeJS.ProcessEnv }): AgentBrowserConfigState["paths"];
export function mergeAgentBrowserConfig(base: AgentBrowserConfig, override: AgentBrowserConfig): AgentBrowserConfig;
export function validateWebSearchProvider(value: unknown, path: string, errors: string[]): WebSearchProvider | undefined;
export function isPlaintextCredentialValue(rawValue: string): boolean;
export function isProjectSafeCredentialValueForProvider(rawValue: string, provider: WebSearchProvider): boolean;
export function validateAgentBrowserConfig(value: unknown, path: string, scope: ConfigLayer["scope"], errors: string[], warnings: string[]): AgentBrowserConfig | undefined;
export function parseAgentBrowserConfigLayer(raw: string, path: string, scope: ConfigLayer["scope"], errors: string[], warnings: string[]): ConfigLayer | undefined;
export function classifyCredentialSource(rawValue: string, scope: AgentBrowserConfigScope, provider?: WebSearchProvider): CredentialSource | undefined;
export function buildWebSearchCredentialSources(options: { env: NodeJS.ProcessEnv; layers: ConfigLayer[]; mergedConfig: AgentBrowserConfig }): Partial<Record<WebSearchProvider, CredentialSource>>;
export function buildAgentBrowserConfigState(options: {
	env: NodeJS.ProcessEnv;
	layers: ConfigLayer[];
	mergedConfig: AgentBrowserConfig;
	paths: AgentBrowserConfigState["paths"];
	errors: string[];
	warnings: string[];
}): AgentBrowserConfigState;
export function loadAgentBrowserConfigStateSync(options?: { cwd?: string; env?: NodeJS.ProcessEnv }): AgentBrowserConfigState;
export function resolveEnvInterpolations(rawValue: string, env: NodeJS.ProcessEnv): string | undefined;
export function getWebSearchProviderOrder(state: AgentBrowserConfigState, requestedProvider?: WebSearchProvider | "auto"): WebSearchProvider[];
export function getWebSearchCredentialSource(state: AgentBrowserConfigState, provider: WebSearchProvider): CredentialSource | undefined;
export function hasPotentialCredentialSource(source: CredentialSource | undefined, env: NodeJS.ProcessEnv): boolean;
export function canRegisterWebSearchTool(state: AgentBrowserConfigState, env?: NodeJS.ProcessEnv): boolean;
export function getCredentialSourceSummary(source: CredentialSource | undefined, provider?: WebSearchProvider): string;
export function formatBrowserProfileStatus(state: AgentBrowserConfigState): string;
export function formatBrowserExecutableStatus(state: AgentBrowserConfigState): string;
export function summarizeConfigFiles(state: AgentBrowserConfigState, exists?: (path: string) => boolean): Array<{ scope: string; path: string; exists: boolean }>;
