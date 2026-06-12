/**
 * Purpose: Load pi-agent-browser-native package configuration from Pi-scoped global, project, or explicit paths.
 * Responsibilities: Resolve config layers, resolve secrets without exposing values, and provide redacted status for tools/CLIs.
 * Scope: Package-owned configuration only; canonical config policy lives in config-policy.js, browser command execution and web-search API calls live in focused modules.
 * Invariants/Assumptions: Credential sources from loaded config are passed through to the runtime; command credentials are resolved lazily at execution time and displayed values stay redacted.
 */

import { exec as execCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
	SECRET_COMMAND_TIMEOUT_MS,
	buildAgentBrowserConfigState,
	getAgentBrowserConfigPaths,
	getWebSearchCredentialSource,
	getWebSearchProviderOrder,
	loadAgentBrowserConfigStateSync,
	mergeAgentBrowserConfig,
	parseAgentBrowserConfigLayer,
	resolveEnvInterpolations,
} from "./config-policy.js";
import type {
	AgentBrowserConfig,
	AgentBrowserConfigLoadOptions,
	AgentBrowserConfigScope,
	AgentBrowserConfigState,
	BrowserDefaultProfileConfig,
	BrowserDefaultProfilePolicy,
	ConfigLayer,
	CredentialSource,
	CredentialSourceKind,
	WebSearchProvider,
} from "./config-policy.js";

export {
	AGENT_BROWSER_CONFIG_ENV,
	BRAVE_API_KEY_ENV,
	CONFIG_RELATIVE_PATH,
	DEFAULT_WEB_SEARCH_PROVIDER,
	EXA_API_KEY_ENV,
	GLOBAL_CONFIG_RELATIVE_PATH,
	SECRET_COMMAND_TIMEOUT_MS,
	WEB_SEARCH_PROVIDER_CONFIG_KEYS,
	WEB_SEARCH_PROVIDER_DESCRIPTORS,
	WEB_SEARCH_PROVIDER_ENV_VARS,
	WEB_SEARCH_PROVIDERS,
	buildAgentBrowserConfigState,
	buildWebSearchCredentialSources,
	canRegisterWebSearchTool,
	classifyCredentialSource,
	formatBrowserExecutableStatus,
	formatBrowserProfileStatus,
	getAgentBrowserConfigPaths,
	getCredentialSourceSummary,
	getGlobalAgentBrowserConfigPath,
	getProjectAgentBrowserConfigPath,
	getWebSearchCredentialSource,
	getWebSearchProviderConfigKey,
	getWebSearchProviderDescriptor,
	getWebSearchProviderEnvVar,
	getWebSearchProviderLabel,
	getWebSearchProviderOrder,
	hasPotentialCredentialSource,
	isPlaintextCredentialValue,
	isProjectSafeCredentialValueForProvider,
	isWebSearchProvider,
	loadAgentBrowserConfigStateSync,
	mergeAgentBrowserConfig,
	parseAgentBrowserConfigLayer,
	resolveEnvInterpolations,
	summarizeConfigFiles,
	validateAgentBrowserConfig,
	validateWebSearchProvider,
} from "./config-policy.js";
export type {
	AgentBrowserConfig,
	AgentBrowserConfigLoadOptions,
	AgentBrowserConfigScope,
	AgentBrowserConfigState,
	BrowserDefaultProfileConfig,
	BrowserDefaultProfilePolicy,
	ConfigLayer,
	CredentialSource,
	CredentialSourceKind,
	WebSearchProvider,
	WebSearchProviderDescriptor,
} from "./config-policy.js";

const exec = promisify(execCallback);

export interface ResolvedCredential {
	source: CredentialSource;
	value: string;
}

async function readConfigLayer(path: string, scope: ConfigLayer["scope"], errors: string[], warnings: string[]): Promise<ConfigLayer | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		errors.push(`Could not read ${scope} config ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	return parseAgentBrowserConfigLayer(raw, path, scope, errors, warnings);
}

export async function loadAgentBrowserConfig(options: AgentBrowserConfigLoadOptions = {}): Promise<AgentBrowserConfigState> {
	const env = options.env ?? process.env;
	const paths = getAgentBrowserConfigPaths({ cwd: options.cwd, env });
	const includeProjectConfig = options.includeProjectConfig !== false;
	const errors: string[] = [];
	const warnings: string[] = [];
	const layerCandidates = [
		{ path: paths.global, scope: "global" as const },
		...(includeProjectConfig ? [{ path: paths.project, scope: "project" as const }] : []),
		...(paths.override ? [{ path: paths.override, scope: "override" as const }] : []),
	];
	const layers: ConfigLayer[] = [];
	let mergedConfig: AgentBrowserConfig = {};
	for (const candidate of layerCandidates) {
		const layer = await readConfigLayer(candidate.path, candidate.scope, errors, warnings);
		if (!layer) continue;
		layers.push(layer);
		mergedConfig = mergeAgentBrowserConfig(mergedConfig, layer.config);
	}
	return buildAgentBrowserConfigState({
		env,
		errors,
		layers,
		mergedConfig,
		paths,
		projectConfigIncluded: includeProjectConfig,
		warnings,
	});
}

export function loadAgentBrowserConfigSync(options: AgentBrowserConfigLoadOptions = {}): AgentBrowserConfigState {
	return loadAgentBrowserConfigStateSync(options);
}

async function resolveCommandCredential(rawValue: string, signal?: AbortSignal): Promise<string | undefined> {
	const command = rawValue.slice(1).trim();
	if (!command) return undefined;
	try {
		const result = await exec(command, {
			signal,
			timeout: SECRET_COMMAND_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		const value = result.stdout.trim();
		return value.length > 0 ? value : undefined;
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new Error("Credential command failed without exposing command output. Check pi-agent-browser-config web-search status and the configured secret manager command.");
	}
}

export async function resolveCredentialSource(
	source: CredentialSource | undefined,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ResolvedCredential | undefined> {
	if (!source) return undefined;
	let value: string | undefined;
	if (source.kind === "command") {
		value = await resolveCommandCredential(source.rawValue, options.signal);
	} else if (source.kind === "env") {
		value = resolveEnvInterpolations(source.rawValue, options.env ?? process.env)?.trim();
	} else {
		value = source.rawValue.trim();
	}
	return value ? { source, value } : undefined;
}

export async function resolveWebSearchCredential(
	state: AgentBrowserConfigState,
	provider: WebSearchProvider,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ResolvedCredential | undefined> {
	if (!state.webSearchEnabled || state.errors.length > 0) return undefined;
	return resolveCredentialSource(getWebSearchCredentialSource(state, provider), options);
}

export async function resolvePreferredWebSearchCredential(
	state: AgentBrowserConfigState,
	options: { env?: NodeJS.ProcessEnv; provider?: WebSearchProvider | "auto"; signal?: AbortSignal } = {},
): Promise<{ provider: WebSearchProvider; credential: ResolvedCredential } | undefined> {
	if (!state.webSearchEnabled || state.errors.length > 0) return undefined;
	for (const provider of getWebSearchProviderOrder(state, options.provider)) {
		const credential = await resolveWebSearchCredential(state, provider, options);
		if (credential) return { provider, credential };
	}
	return undefined;
}

export async function hasResolvableCredentialSource(
	state: AgentBrowserConfigState,
	options: { env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
	if (!state.webSearchEnabled || state.errors.length > 0) return false;
	for (const provider of getWebSearchProviderOrder(state)) {
		const source = getWebSearchCredentialSource(state, provider);
		if (!source) continue;
		if (source.kind === "command") return true;
		if ((await resolveCredentialSource(source, options))?.value) return true;
	}
	return false;
}
