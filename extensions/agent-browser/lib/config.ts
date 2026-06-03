/**
 * Purpose: Load pi-agent-browser-native package configuration from Pi-scoped global, project, or explicit paths.
 * Responsibilities: Resolve config paths, validate the v1 JSON shape, merge layers, classify credential sources, resolve secrets without exposing values, and provide redacted status for tools/CLIs.
 * Scope: Package-owned configuration only; browser command execution and web-search API calls live in focused modules.
 * Usage: The extension reads this at startup to decide optional tool registration; scripts/config.mjs mirrors the file locations for user setup.
 * Invariants/Assumptions: Raw project-local plaintext credentials are unsafe and rejected; command credentials are resolved lazily at execution time.
 */

import { exec as execCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);

export const AGENT_BROWSER_CONFIG_ENV = "PI_AGENT_BROWSER_CONFIG";
export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
export const EXA_API_KEY_ENV = "EXA_API_KEY";
export const CONFIG_RELATIVE_PATH = [".pi", "config", "pi-agent-browser-native", "config.json"] as const;
export const GLOBAL_CONFIG_RELATIVE_PATH = [".pi", "config", "pi-agent-browser-native", "config.json"] as const;
export const SECRET_COMMAND_TIMEOUT_MS = 15_000;

export type BrowserDefaultProfilePolicy = "explicit-only" | "authenticated-only" | "always";
export type AgentBrowserConfigScope = "global" | "project" | "override" | "env-fallback";
export type CredentialSourceKind = "literal" | "env" | "command";
export const WEB_SEARCH_PROVIDERS = ["exa", "brave"] as const;
export type WebSearchProvider = typeof WEB_SEARCH_PROVIDERS[number];
export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProvider = "exa";

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

export interface ResolvedCredential {
	source: CredentialSource;
	value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

export function getGlobalAgentBrowserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
	return join(home, ...GLOBAL_CONFIG_RELATIVE_PATH);
}

export function getProjectAgentBrowserConfigPath(cwd = process.cwd()): string {
	return resolve(cwd, ...CONFIG_RELATIVE_PATH);
}

export function getAgentBrowserConfigPaths(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const env = options.env ?? process.env;
	const override = env[AGENT_BROWSER_CONFIG_ENV]?.trim();
	return {
		global: getGlobalAgentBrowserConfigPath(env),
		project: getProjectAgentBrowserConfigPath(options.cwd),
		override: override ? resolve(override) : undefined,
	};
}

function mergeConfig(base: AgentBrowserConfig, override: AgentBrowserConfig): AgentBrowserConfig {
	return {
		...base,
		...override,
		browser: {
			...(base.browser ?? {}),
			...(override.browser ?? {}),
			defaultProfile: override.browser?.defaultProfile ?? base.browser?.defaultProfile,
		},
		webSearch: {
			...(base.webSearch ?? {}),
			...(override.webSearch ?? {}),
		},
	};
}

function validateString(value: unknown, path: string, errors: string[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		errors.push(`${path} must be a string.`);
		return undefined;
	}
	return value;
}

function validateStringArray(value: unknown, path: string, errors: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		errors.push(`${path} must be an array of strings.`);
		return undefined;
	}
	return value;
}

function validateBoolean(value: unknown, path: string, errors: string[]): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		errors.push(`${path} must be a boolean.`);
		return undefined;
	}
	return value;
}

function validateWebSearchProvider(value: unknown, path: string, errors: string[]): WebSearchProvider | undefined {
	if (value === undefined) return undefined;
	const provider = validateString(value, path, errors)?.trim();
	if (provider === undefined) return undefined;
	if (!(WEB_SEARCH_PROVIDERS as readonly string[]).includes(provider)) {
		errors.push(`${path} must be one of ${WEB_SEARCH_PROVIDERS.join(", ")}.`);
		return undefined;
	}
	return provider as WebSearchProvider;
}

function validateBrowserDefaultProfile(value: unknown, path: string, errors: string[]): BrowserDefaultProfileConfig | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		errors.push(`${path} must be an object.`);
		return undefined;
	}
	const name = validateString(value.name, `${path}.name`, errors)?.trim();
	if (!name) {
		errors.push(`${path}.name must not be blank.`);
		return undefined;
	}
	const rawPolicy = validateString(value.policy, `${path}.policy`, errors);
	const policy = rawPolicy ?? "authenticated-only";
	if (!(["explicit-only", "authenticated-only", "always"] as const).includes(policy as BrowserDefaultProfilePolicy)) {
		errors.push(`${path}.policy must be one of explicit-only, authenticated-only, always.`);
		return undefined;
	}
	return { name, policy: policy as BrowserDefaultProfilePolicy };
}

function validateConfig(value: unknown, path: string, scope: ConfigLayer["scope"], errors: string[], warnings: string[]): AgentBrowserConfig | undefined {
	if (!isRecord(value)) {
		errors.push(`${path} must contain a JSON object.`);
		return undefined;
	}
	if (value.version !== undefined && value.version !== 1) {
		errors.push(`${path}.version must be 1 when present.`);
	}
	const config: AgentBrowserConfig = value.version === 1 ? { version: 1 } : {};

	if (value.webSearch !== undefined) {
		if (!isRecord(value.webSearch)) {
			errors.push(`${path}.webSearch must be an object.`);
		} else {
			const webSearch: NonNullable<AgentBrowserConfig["webSearch"]> = {};
			const enabled = validateBoolean(value.webSearch.enabled, `${path}.webSearch.enabled`, errors);
			if (enabled !== undefined) webSearch.enabled = enabled;
			const preferredProvider = validateWebSearchProvider(value.webSearch.preferredProvider, `${path}.webSearch.preferredProvider`, errors);
			if (preferredProvider) webSearch.preferredProvider = preferredProvider;
			const braveApiKey = validateString(value.webSearch.braveApiKey, `${path}.webSearch.braveApiKey`, errors);
			if (braveApiKey !== undefined) {
				webSearch.braveApiKey = braveApiKey;
				if (scope === "project" && !isProjectSafeCredentialValue(braveApiKey)) {
					errors.push(`${path}.webSearch.braveApiKey must be exactly $ENV_VAR or ${"${ENV_VAR}"} in project-local config; plaintext, interpolation literals, malformed env references, and command-backed project secrets are not allowed.`);
				}
			}
			const exaApiKey = validateString(value.webSearch.exaApiKey, `${path}.webSearch.exaApiKey`, errors);
			if (exaApiKey !== undefined) {
				webSearch.exaApiKey = exaApiKey;
				if (scope === "project" && !isProjectSafeCredentialValue(exaApiKey)) {
					errors.push(`${path}.webSearch.exaApiKey must be exactly $ENV_VAR or ${"${ENV_VAR}"} in project-local config; plaintext, interpolation literals, malformed env references, and command-backed project secrets are not allowed.`);
				}
			}
			if (Object.keys(webSearch).length > 0) config.webSearch = webSearch;
		}
	}

	if (value.browser !== undefined) {
		if (!isRecord(value.browser)) {
			errors.push(`${path}.browser must be an object.`);
		} else {
			config.browser = {};
			const defaultProfile = validateBrowserDefaultProfile(value.browser.defaultProfile, `${path}.browser.defaultProfile`, errors);
			if (defaultProfile) {
				config.browser.defaultProfile = defaultProfile;
				if (scope === "project" && defaultProfile.policy !== "explicit-only") {
					warnings.push(`${path}.browser.defaultProfile is project-local; authenticated/always profile prompt guidance is emitted only from global or override config.`);
				}
			}
			const executablePath = validateString(value.browser.executablePath, `${path}.browser.executablePath`, errors)?.trim();
			if (executablePath) {
				config.browser.executablePath = executablePath;
				if (scope === "project") {
					warnings.push(`${path}.browser.executablePath is project-local; executable launch prompt guidance is emitted only from global or override config.`);
				}
			}
			const defaultLaunchArgs = validateStringArray(value.browser.defaultLaunchArgs, `${path}.browser.defaultLaunchArgs`, errors);
			if (defaultLaunchArgs) {
				config.browser.defaultLaunchArgs = defaultLaunchArgs;
				warnings.push(`${path}.browser.defaultLaunchArgs is recorded for future use; current releases do not auto-inject default launch args.`);
			}
		}
	}

	for (const key of Object.keys(value)) {
		if (!["version", "webSearch", "browser"].includes(key)) {
			warnings.push(`${path}.${key} is not a recognized pi-agent-browser-native config field and was ignored.`);
		}
	}
	return config;
}

function parseConfigLayer(raw: string, path: string, scope: ConfigLayer["scope"], errors: string[], warnings: string[]): ConfigLayer | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		errors.push(`Could not parse ${scope} config ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	const config = validateConfig(parsed, path, scope, errors, warnings);
	return config ? { config, path, scope } : undefined;
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
	return parseConfigLayer(raw, path, scope, errors, warnings);
}

function readConfigLayerSync(path: string, scope: ConfigLayer["scope"], errors: string[], warnings: string[]): ConfigLayer | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		errors.push(`Could not read ${scope} config ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	return parseConfigLayer(raw, path, scope, errors, warnings);
}

export function isPlaintextCredentialValue(rawValue: string): boolean {
	const trimmed = rawValue.trim();
	return Boolean(trimmed) && !trimmed.startsWith("!") && !trimmed.startsWith("$");
}

export function isProjectSafeCredentialValue(rawValue: string): boolean {
	const trimmed = rawValue.trim();
	return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(trimmed);
}

export function classifyCredentialSource(rawValue: string, scope: AgentBrowserConfigScope, provider?: WebSearchProvider): CredentialSource | undefined {
	const trimmed = rawValue.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("!")) return { kind: "command", provider, rawValue: trimmed, scope };
	if (trimmed.includes("$")) return { kind: "env", provider, rawValue: trimmed, scope };
	return { kind: "literal", provider, rawValue: trimmed, scope };
}

function getBrowserDefaultProfile(config: AgentBrowserConfig): Required<BrowserDefaultProfileConfig> | undefined {
	const profile = config.browser?.defaultProfile;
	if (!profile?.name.trim()) return undefined;
	return { name: profile.name.trim(), policy: profile.policy ?? "authenticated-only" };
}

function getBrowserExecutablePath(config: AgentBrowserConfig): string | undefined {
	const executablePath = config.browser?.executablePath?.trim();
	return executablePath || undefined;
}

function getBrowserDefaultProfileScope(layers: ConfigLayer[]): ConfigLayer["scope"] | undefined {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (layer?.config.browser?.defaultProfile !== undefined) return layer.scope;
	}
	return undefined;
}

function getBrowserExecutablePathScope(layers: ConfigLayer[]): ConfigLayer["scope"] | undefined {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (layer?.config.browser?.executablePath !== undefined) return layer.scope;
	}
	return undefined;
}

function getTrustedBrowserDefaultProfile(layers: ConfigLayer[]): { profile: Required<BrowserDefaultProfileConfig>; scope: Exclude<ConfigLayer["scope"], "project"> } | undefined {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (!layer || layer.scope === "project") continue;
		const profile = getBrowserDefaultProfile(layer.config);
		if (profile) return { profile, scope: layer.scope };
	}
	return undefined;
}

function getTrustedBrowserExecutablePath(layers: ConfigLayer[]): { executablePath: string; scope: Exclude<ConfigLayer["scope"], "project"> } | undefined {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (!layer || layer.scope === "project") continue;
		const executablePath = getBrowserExecutablePath(layer.config);
		if (executablePath) return { executablePath, scope: layer.scope };
	}
	return undefined;
}

function getWebSearchCredentialScope(layers: ConfigLayer[], key: "braveApiKey" | "exaApiKey"): AgentBrowserConfigScope {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (layer?.config.webSearch?.[key] !== undefined) return layer.scope;
	}
	return "global";
}

function buildWebSearchCredentialSources(options: { env: NodeJS.ProcessEnv; layers: ConfigLayer[]; mergedConfig: AgentBrowserConfig }): Partial<Record<WebSearchProvider, CredentialSource>> {
	const sources: Partial<Record<WebSearchProvider, CredentialSource>> = {};
	const braveApiKey = options.mergedConfig.webSearch?.braveApiKey;
	if (braveApiKey !== undefined) {
		sources.brave = classifyCredentialSource(braveApiKey, getWebSearchCredentialScope(options.layers, "braveApiKey"), "brave");
	}
	const exaApiKey = options.mergedConfig.webSearch?.exaApiKey;
	if (exaApiKey !== undefined) {
		sources.exa = classifyCredentialSource(exaApiKey, getWebSearchCredentialScope(options.layers, "exaApiKey"), "exa");
	}
	if (!sources.brave && options.env[BRAVE_API_KEY_ENV]?.trim()) {
		sources.brave = { kind: "literal", provider: "brave", rawValue: options.env[BRAVE_API_KEY_ENV] ?? "", scope: "env-fallback" };
	}
	if (!sources.exa && options.env[EXA_API_KEY_ENV]?.trim()) {
		sources.exa = { kind: "literal", provider: "exa", rawValue: options.env[EXA_API_KEY_ENV] ?? "", scope: "env-fallback" };
	}
	return sources;
}

function buildConfigState(options: {
	env: NodeJS.ProcessEnv;
	layers: ConfigLayer[];
	mergedConfig: AgentBrowserConfig;
	paths: AgentBrowserConfigState["paths"];
	errors: string[];
	warnings: string[];
}): AgentBrowserConfigState {
	const webSearchCredentialSources = buildWebSearchCredentialSources(options);
	const trustedBrowserDefaultProfile = getTrustedBrowserDefaultProfile(options.layers);
	const trustedBrowserExecutablePath = getTrustedBrowserExecutablePath(options.layers);
	return {
		browserDefaultProfile: getBrowserDefaultProfile(options.mergedConfig),
		browserDefaultProfileScope: getBrowserDefaultProfileScope(options.layers),
		browserExecutablePath: getBrowserExecutablePath(options.mergedConfig),
		browserExecutablePathScope: getBrowserExecutablePathScope(options.layers),
		trustedBrowserDefaultProfile: trustedBrowserDefaultProfile?.profile,
		trustedBrowserDefaultProfileScope: trustedBrowserDefaultProfile?.scope,
		trustedBrowserExecutablePath: trustedBrowserExecutablePath?.executablePath,
		trustedBrowserExecutablePathScope: trustedBrowserExecutablePath?.scope,
		config: options.mergedConfig,
		webSearchCredentialSources,
		webSearchEnabled: options.mergedConfig.webSearch?.enabled !== false,
		webSearchPreferredProvider: options.mergedConfig.webSearch?.preferredProvider ?? DEFAULT_WEB_SEARCH_PROVIDER,
		errors: options.errors,
		layers: options.layers,
		paths: options.paths,
		warnings: options.warnings,
	};
}

export async function loadAgentBrowserConfig(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<AgentBrowserConfigState> {
	const env = options.env ?? process.env;
	const paths = getAgentBrowserConfigPaths({ cwd: options.cwd, env });
	const errors: string[] = [];
	const warnings: string[] = [];
	const layerCandidates = [
		{ path: paths.global, scope: "global" as const },
		{ path: paths.project, scope: "project" as const },
		...(paths.override ? [{ path: paths.override, scope: "override" as const }] : []),
	];
	const layers: ConfigLayer[] = [];
	let mergedConfig: AgentBrowserConfig = {};
	for (const candidate of layerCandidates) {
		const layer = await readConfigLayer(candidate.path, candidate.scope, errors, warnings);
		if (!layer) continue;
		layers.push(layer);
		mergedConfig = mergeConfig(mergedConfig, layer.config);
	}
	return buildConfigState({ env, errors, layers, mergedConfig, paths, warnings });
}

export function loadAgentBrowserConfigSync(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): AgentBrowserConfigState {
	const env = options.env ?? process.env;
	const paths = getAgentBrowserConfigPaths({ cwd: options.cwd, env });
	const errors: string[] = [];
	const warnings: string[] = [];
	const layerCandidates = [
		{ path: paths.global, scope: "global" as const },
		{ path: paths.project, scope: "project" as const },
		...(paths.override ? [{ path: paths.override, scope: "override" as const }] : []),
	];
	const layers: ConfigLayer[] = [];
	let mergedConfig: AgentBrowserConfig = {};
	for (const candidate of layerCandidates) {
		const layer = readConfigLayerSync(candidate.path, candidate.scope, errors, warnings);
		if (!layer) continue;
		layers.push(layer);
		mergedConfig = mergeConfig(mergedConfig, layer.config);
	}
	return buildConfigState({ env, errors, layers, mergedConfig, paths, warnings });
}

function resolveEnvInterpolations(rawValue: string, env: NodeJS.ProcessEnv): string | undefined {
	let output = "";
	for (let index = 0; index < rawValue.length; index += 1) {
		const char = rawValue[index];
		if (char !== "$") {
			output += char;
			continue;
		}
		const next = rawValue[index + 1];
		if (next === "$") {
			output += "$";
			index += 1;
			continue;
		}
		if (next === "!") {
			output += "!";
			index += 1;
			continue;
		}
		let name = "";
		if (next === "{") {
			const end = rawValue.indexOf("}", index + 2);
			if (end === -1) return undefined;
			name = rawValue.slice(index + 2, end);
			index = end;
		} else {
			const match = rawValue.slice(index + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
			if (!match) {
				output += "$";
				continue;
			}
			name = match[1] ?? "";
			index += name.length;
		}
		if (!name) return undefined;
		const value = env[name];
		if (value === undefined) return undefined;
		output += value;
	}
	return output;
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

export function getWebSearchProviderOrder(state: AgentBrowserConfigState, requestedProvider?: WebSearchProvider | "auto"): WebSearchProvider[] {
	if (requestedProvider && requestedProvider !== "auto") return [requestedProvider];
	const preferred = state.webSearchPreferredProvider;
	return [preferred, ...WEB_SEARCH_PROVIDERS.filter((provider) => provider !== preferred)];
}

export function getWebSearchCredentialSource(state: AgentBrowserConfigState, provider: WebSearchProvider): CredentialSource | undefined {
	return state.webSearchCredentialSources[provider];
}

export async function resolveWebSearchCredential(
	state: AgentBrowserConfigState,
	provider: WebSearchProvider,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ResolvedCredential | undefined> {
	return resolveCredentialSource(getWebSearchCredentialSource(state, provider), options);
}

export async function resolvePreferredWebSearchCredential(
	state: AgentBrowserConfigState,
	options: { env?: NodeJS.ProcessEnv; provider?: WebSearchProvider | "auto"; signal?: AbortSignal } = {},
): Promise<{ provider: WebSearchProvider; credential: ResolvedCredential } | undefined> {
	for (const provider of getWebSearchProviderOrder(state, options.provider)) {
		const credential = await resolveWebSearchCredential(state, provider, options);
		if (credential) return { provider, credential };
	}
	return undefined;
}

function hasPotentialCredentialSource(source: CredentialSource | undefined, env: NodeJS.ProcessEnv): boolean {
	if (!source) return false;
	if (source.kind === "command") return true;
	if (source.kind === "env") return Boolean(resolveEnvInterpolations(source.rawValue, env)?.trim());
	return Boolean(source.rawValue.trim());
}

export function canRegisterWebSearchTool(state: AgentBrowserConfigState, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!state.webSearchEnabled || state.errors.length > 0) return false;
	return WEB_SEARCH_PROVIDERS.some((provider) => hasPotentialCredentialSource(state.webSearchCredentialSources[provider], env));
}

export async function hasResolvableCredentialSource(
	state: AgentBrowserConfigState,
	options: { env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
	if (!state.webSearchEnabled || state.errors.length > 0) return false;
	for (const provider of WEB_SEARCH_PROVIDERS) {
		const source = state.webSearchCredentialSources[provider];
		if (!source) continue;
		if (source.kind === "command") return true;
		if ((await resolveCredentialSource(source, options))?.value) return true;
	}
	return false;
}

export function getCredentialSourceSummary(source: CredentialSource | undefined, provider?: WebSearchProvider): string {
	if (!source) return "not configured";
	if (source.kind === "command") return `configured via command (${source.scope})`;
	if (source.kind === "env") return `configured via environment interpolation (${source.scope})`;
	if (source.scope === "env-fallback") {
		const envName = (provider ?? source.provider) === "exa" ? EXA_API_KEY_ENV : BRAVE_API_KEY_ENV;
		return `configured via ${envName} environment fallback`;
	}
	return `configured as plaintext ${source.scope} value [redacted]`;
}
