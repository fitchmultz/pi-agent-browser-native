// @ts-check
/**
 * Purpose: Canonical pi-agent-browser-native config policy shared by runtime and setup CLI.
 * Responsibilities: Own config paths, provider descriptors, project-local credential safety, layer validation/merge, status projection, and redacted summaries.
 * Scope: Pure configuration policy plus synchronous status loading; secret command execution and browser/web-search runtime calls live elsewhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** @typedef {"explicit-only" | "authenticated-only" | "always"} BrowserDefaultProfilePolicy */
/** @typedef {"global" | "project" | "override" | "env-fallback"} AgentBrowserConfigScope */
/** @typedef {"global" | "project" | "override"} ConfigLayerScope */
/** @typedef {"literal" | "env" | "command"} CredentialSourceKind */
/** @typedef {"exa" | "brave"} WebSearchProvider */
/** @typedef {"exaApiKey" | "braveApiKey"} WebSearchProviderConfigKey */
/** @typedef {{ provider: WebSearchProvider; apiKeyEnv: string; configKey: WebSearchProviderConfigKey; label: string }} WebSearchProviderDescriptor */
/** @typedef {{ name: string; policy?: BrowserDefaultProfilePolicy }} BrowserDefaultProfileConfig */
/** @typedef {{ enabled?: boolean; preferredProvider?: WebSearchProvider; braveApiKey?: string; exaApiKey?: string }} WebSearchConfig */
/** @typedef {{ defaultProfile?: BrowserDefaultProfileConfig; executablePath?: string; defaultLaunchArgs?: string[] }} BrowserConfig */
/** @typedef {{ version?: 1; webSearch?: WebSearchConfig; browser?: BrowserConfig }} AgentBrowserConfig */
/** @typedef {{ config: AgentBrowserConfig; path: string; scope: ConfigLayerScope }} ConfigLayer */
/** @typedef {{ kind: CredentialSourceKind; provider?: WebSearchProvider; rawValue: string; scope: AgentBrowserConfigScope }} CredentialSource */
/** @typedef {{ global: string; project: string; override?: string }} AgentBrowserConfigPaths */
/** @typedef {{ browserDefaultProfile?: Required<BrowserDefaultProfileConfig>; browserDefaultProfileScope?: ConfigLayerScope; browserExecutablePath?: string; browserExecutablePathScope?: ConfigLayerScope; trustedBrowserDefaultProfile?: Required<BrowserDefaultProfileConfig>; trustedBrowserDefaultProfileScope?: Exclude<ConfigLayerScope, "project">; trustedBrowserExecutablePath?: string; trustedBrowserExecutablePathScope?: Exclude<ConfigLayerScope, "project">; config: AgentBrowserConfig; webSearchCredentialSources: Partial<Record<WebSearchProvider, CredentialSource>>; webSearchEnabled: boolean; webSearchPreferredProvider: WebSearchProvider; errors: string[]; layers: ConfigLayer[]; paths: AgentBrowserConfigPaths; warnings: string[] }} AgentBrowserConfigState */
/** @typedef {{ scope: string; path: string; exists: boolean }} ConfigFileSummary */

export const AGENT_BROWSER_CONFIG_ENV = "PI_AGENT_BROWSER_CONFIG";
export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
export const EXA_API_KEY_ENV = "EXA_API_KEY";
export const CONFIG_RELATIVE_PATH = /** @type {const} */ ([".pi", "config", "pi-agent-browser-native", "config.json"]);
export const GLOBAL_CONFIG_RELATIVE_PATH = /** @type {const} */ ([".pi", "config", "pi-agent-browser-native", "config.json"]);
export const SECRET_COMMAND_TIMEOUT_MS = 15_000;

/** @type {Readonly<Record<WebSearchProvider, WebSearchProviderDescriptor>>} */
export const WEB_SEARCH_PROVIDER_DESCRIPTORS = Object.freeze({
	exa: Object.freeze({
		provider: "exa",
		apiKeyEnv: EXA_API_KEY_ENV,
		configKey: "exaApiKey",
		label: "Exa",
	}),
	brave: Object.freeze({
		provider: "brave",
		apiKeyEnv: BRAVE_API_KEY_ENV,
		configKey: "braveApiKey",
		label: "Brave Search",
	}),
});
/** @type {readonly WebSearchProvider[]} */
export const WEB_SEARCH_PROVIDERS = Object.freeze(["exa", "brave"]);
/** @type {WebSearchProvider} */
export const DEFAULT_WEB_SEARCH_PROVIDER = "exa";
/** @type {Readonly<Record<WebSearchProvider, WebSearchProviderConfigKey>>} */
export const WEB_SEARCH_PROVIDER_CONFIG_KEYS = Object.freeze({
	exa: WEB_SEARCH_PROVIDER_DESCRIPTORS.exa.configKey,
	brave: WEB_SEARCH_PROVIDER_DESCRIPTORS.brave.configKey,
});
/** @type {Readonly<Record<WebSearchProvider, string>>} */
export const WEB_SEARCH_PROVIDER_ENV_VARS = Object.freeze({
	exa: WEB_SEARCH_PROVIDER_DESCRIPTORS.exa.apiKeyEnv,
	brave: WEB_SEARCH_PROVIDER_DESCRIPTORS.brave.apiKeyEnv,
});

/**
 * @param {unknown} value
 * @returns {value is WebSearchProvider}
 */
export function isWebSearchProvider(value) {
	return typeof value === "string" && WEB_SEARCH_PROVIDERS.includes(/** @type {WebSearchProvider} */ (value));
}

/**
 * @param {WebSearchProvider} provider
 * @returns {WebSearchProviderDescriptor}
 */
export function getWebSearchProviderDescriptor(provider) {
	const descriptor = WEB_SEARCH_PROVIDER_DESCRIPTORS[provider];
	if (!descriptor) throw new Error(`Unknown web-search provider: ${String(provider)}`);
	return descriptor;
}

/** @param {WebSearchProvider} provider */
export function getWebSearchProviderLabel(provider) {
	return getWebSearchProviderDescriptor(provider).label;
}

/** @param {WebSearchProvider} provider */
export function getWebSearchProviderEnvVar(provider) {
	return getWebSearchProviderDescriptor(provider).apiKeyEnv;
}

/**
 * @param {WebSearchProvider} provider
 * @returns {WebSearchProviderConfigKey}
 */
export function getWebSearchProviderConfigKey(provider) {
	return getWebSearchProviderDescriptor(provider).configKey;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function getGlobalAgentBrowserConfigPath(env = process.env) {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
	return join(home, ...GLOBAL_CONFIG_RELATIVE_PATH);
}

/** @param {string} [cwd] */
export function getProjectAgentBrowserConfigPath(cwd = process.cwd()) {
	return resolve(cwd, ...CONFIG_RELATIVE_PATH);
}

/**
 * @param {{ cwd?: string; env?: NodeJS.ProcessEnv }} [options]
 * @returns {AgentBrowserConfigPaths}
 */
export function getAgentBrowserConfigPaths(options = {}) {
	const env = options.env ?? process.env;
	const override = env[AGENT_BROWSER_CONFIG_ENV]?.trim();
	return {
		global: getGlobalAgentBrowserConfigPath(env),
		project: getProjectAgentBrowserConfigPath(options.cwd),
		...(override ? { override: resolve(override) } : {}),
	};
}

/**
 * @param {AgentBrowserConfig} base
 * @param {AgentBrowserConfig} override
 * @returns {AgentBrowserConfig}
 */
export function mergeAgentBrowserConfig(base, override) {
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 */
function validateString(value, path, errors) {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		errors.push(`${path} must be a string.`);
		return undefined;
	}
	return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @returns {string[] | undefined}
 */
function validateStringArray(value, path, errors) {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		errors.push(`${path} must be an array of strings.`);
		return undefined;
	}
	return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 */
function validateBoolean(value, path, errors) {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		errors.push(`${path} must be a boolean.`);
		return undefined;
	}
	return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @returns {WebSearchProvider | undefined}
 */
export function validateWebSearchProvider(value, path, errors) {
	if (value === undefined) return undefined;
	const provider = validateString(value, path, errors)?.trim();
	if (provider === undefined) return undefined;
	if (!isWebSearchProvider(provider)) {
		errors.push(`${path} must be one of ${WEB_SEARCH_PROVIDERS.join(", ")}.`);
		return undefined;
	}
	return provider;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @returns {BrowserDefaultProfileConfig | undefined}
 */
function validateBrowserDefaultProfile(value, path, errors) {
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
	if (!["explicit-only", "authenticated-only", "always"].includes(policy)) {
		errors.push(`${path}.policy must be one of explicit-only, authenticated-only, always.`);
		return undefined;
	}
	return { name, policy: /** @type {BrowserDefaultProfilePolicy} */ (policy) };
}

/** @param {string} rawValue */
export function isPlaintextCredentialValue(rawValue) {
	const trimmed = rawValue.trim();
	return Boolean(trimmed) && !trimmed.startsWith("!") && !trimmed.startsWith("$");
}

/**
 * @param {string} rawValue
 * @param {WebSearchProvider} provider
 */
export function isProjectSafeCredentialValueForProvider(rawValue, provider) {
	const envName = getWebSearchProviderEnvVar(provider);
	const trimmed = rawValue.trim();
	return trimmed === `$${envName}` || trimmed === `\${${envName}}`;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ConfigLayerScope} scope
 * @param {string[]} errors
 * @param {string[]} warnings
 * @returns {AgentBrowserConfig | undefined}
 */
export function validateAgentBrowserConfig(value, path, scope, errors, warnings) {
	if (!isRecord(value)) {
		errors.push(`${path} must contain a JSON object.`);
		return undefined;
	}
	if (value.version !== undefined && value.version !== 1) {
		errors.push(`${path}.version must be 1 when present.`);
	}
	/** @type {AgentBrowserConfig} */
	const config = value.version === 1 ? { version: 1 } : {};

	if (value.webSearch !== undefined) {
		if (!isRecord(value.webSearch)) {
			errors.push(`${path}.webSearch must be an object.`);
		} else {
			/** @type {NonNullable<AgentBrowserConfig["webSearch"]>} */
			const webSearch = {};
			const enabled = validateBoolean(value.webSearch.enabled, `${path}.webSearch.enabled`, errors);
			if (enabled !== undefined) webSearch.enabled = enabled;
			const preferredProvider = validateWebSearchProvider(value.webSearch.preferredProvider, `${path}.webSearch.preferredProvider`, errors);
			if (preferredProvider) webSearch.preferredProvider = preferredProvider;
			for (const provider of WEB_SEARCH_PROVIDERS) {
				const descriptor = getWebSearchProviderDescriptor(provider);
				const apiKey = validateString(value.webSearch[descriptor.configKey], `${path}.webSearch.${descriptor.configKey}`, errors);
				if (apiKey !== undefined) {
					webSearch[descriptor.configKey] = apiKey;
					if (scope === "project" && !isProjectSafeCredentialValueForProvider(apiKey, provider)) {
						errors.push(`${path}.webSearch.${descriptor.configKey} must be exactly $${descriptor.apiKeyEnv} or \${${descriptor.apiKeyEnv}} in project-local config; plaintext, custom env aliases, interpolation literals, malformed env references, and command-backed project secrets are not allowed.`);
					}
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

/**
 * @param {string} raw
 * @param {string} path
 * @param {ConfigLayerScope} scope
 * @param {string[]} errors
 * @param {string[]} warnings
 * @returns {ConfigLayer | undefined}
 */
export function parseAgentBrowserConfigLayer(raw, path, scope, errors, warnings) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		errors.push(`Could not parse ${scope} config ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	const config = validateAgentBrowserConfig(parsed, path, scope, errors, warnings);
	return config ? { config, path, scope } : undefined;
}

/**
 * @param {string} rawValue
 * @param {AgentBrowserConfigScope} scope
 * @param {WebSearchProvider} [provider]
 * @returns {CredentialSource | undefined}
 */
export function classifyCredentialSource(rawValue, scope, provider) {
	const trimmed = rawValue.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("!")) return { kind: "command", provider, rawValue: trimmed, scope };
	if (trimmed.includes("$")) return { kind: "env", provider, rawValue: trimmed, scope };
	return { kind: "literal", provider, rawValue: trimmed, scope };
}

/**
 * @param {AgentBrowserConfig} config
 * @returns {Required<BrowserDefaultProfileConfig> | undefined}
 */
function getBrowserDefaultProfile(config) {
	const profile = config.browser?.defaultProfile;
	if (!profile?.name.trim()) return undefined;
	return { name: profile.name.trim(), policy: profile.policy ?? "authenticated-only" };
}

/** @param {AgentBrowserConfig} config */
function getBrowserExecutablePath(config) {
	const executablePath = config.browser?.executablePath?.trim();
	return executablePath || undefined;
}

/**
 * @param {ConfigLayer[]} layers
 * @returns {ConfigLayerScope | undefined}
 */
function getBrowserDefaultProfileScope(layers) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (layer?.config.browser?.defaultProfile !== undefined) return layer.scope;
	}
	return undefined;
}

/**
 * @param {ConfigLayer[]} layers
 * @returns {ConfigLayerScope | undefined}
 */
function getBrowserExecutablePathScope(layers) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (layer?.config.browser?.executablePath !== undefined) return layer.scope;
	}
	return undefined;
}

/**
 * @param {ConfigLayer[]} layers
 * @returns {{ profile: Required<BrowserDefaultProfileConfig>; scope: Exclude<ConfigLayerScope, "project"> } | undefined}
 */
function getTrustedBrowserDefaultProfile(layers) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (!layer || layer.scope === "project") continue;
		const profile = getBrowserDefaultProfile(layer.config);
		if (profile) return { profile, scope: /** @type {Exclude<ConfigLayerScope, "project">} */ (layer.scope) };
	}
	return undefined;
}

/**
 * @param {ConfigLayer[]} layers
 * @returns {{ executablePath: string; scope: Exclude<ConfigLayerScope, "project"> } | undefined}
 */
function getTrustedBrowserExecutablePath(layers) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (!layer || layer.scope === "project") continue;
		const executablePath = getBrowserExecutablePath(layer.config);
		if (executablePath) return { executablePath, scope: /** @type {Exclude<ConfigLayerScope, "project">} */ (layer.scope) };
	}
	return undefined;
}

/**
 * @param {ConfigLayer[]} layers
 * @param {WebSearchProviderConfigKey} key
 * @returns {AgentBrowserConfigScope}
 */
function getWebSearchCredentialScope(layers, key) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (layer?.config.webSearch?.[key] !== undefined) return layer.scope;
	}
	return "global";
}

/**
 * @param {{ env: NodeJS.ProcessEnv; layers: ConfigLayer[]; mergedConfig: AgentBrowserConfig }} options
 * @returns {Partial<Record<WebSearchProvider, CredentialSource>>}
 */
export function buildWebSearchCredentialSources(options) {
	/** @type {Partial<Record<WebSearchProvider, CredentialSource>>} */
	const sources = {};
	for (const provider of WEB_SEARCH_PROVIDERS) {
		const descriptor = getWebSearchProviderDescriptor(provider);
		const apiKey = options.mergedConfig.webSearch?.[descriptor.configKey];
		if (apiKey !== undefined) {
			sources[provider] = classifyCredentialSource(apiKey, getWebSearchCredentialScope(options.layers, descriptor.configKey), provider);
		}
		if (!sources[provider] && options.env[descriptor.apiKeyEnv]?.trim()) {
			sources[provider] = { kind: "literal", provider, rawValue: options.env[descriptor.apiKeyEnv] ?? "", scope: "env-fallback" };
		}
	}
	return sources;
}

/**
 * @param {{ env: NodeJS.ProcessEnv; layers: ConfigLayer[]; mergedConfig: AgentBrowserConfig; paths: AgentBrowserConfigPaths; errors: string[]; warnings: string[] }} options
 * @returns {AgentBrowserConfigState}
 */
export function buildAgentBrowserConfigState(options) {
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

/**
 * @param {string} path
 * @param {ConfigLayerScope} scope
 * @param {string[]} errors
 * @param {string[]} warnings
 * @returns {ConfigLayer | undefined}
 */
function readConfigLayerSync(path, scope, errors, warnings) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		errors.push(`Could not read ${scope} config ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	return parseAgentBrowserConfigLayer(raw, path, scope, errors, warnings);
}

/**
 * @param {{ cwd?: string; env?: NodeJS.ProcessEnv }} [options]
 * @returns {AgentBrowserConfigState}
 */
export function loadAgentBrowserConfigStateSync(options = {}) {
	const env = options.env ?? process.env;
	const paths = getAgentBrowserConfigPaths({ cwd: options.cwd, env });
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];
	/** @type {Array<{ path: string; scope: ConfigLayerScope }>} */
	const layerCandidates = [
		{ path: paths.global, scope: "global" },
		{ path: paths.project, scope: "project" },
		...(paths.override ? [{ path: paths.override, scope: /** @type {ConfigLayerScope} */ ("override") }] : []),
	];
	/** @type {ConfigLayer[]} */
	const layers = [];
	/** @type {AgentBrowserConfig} */
	let mergedConfig = {};
	for (const candidate of layerCandidates) {
		const layer = readConfigLayerSync(candidate.path, candidate.scope, errors, warnings);
		if (!layer) continue;
		layers.push(layer);
		mergedConfig = mergeAgentBrowserConfig(mergedConfig, layer.config);
	}
	return buildAgentBrowserConfigState({ env, errors, layers, mergedConfig, paths, warnings });
}

/**
 * @param {string} rawValue
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveEnvInterpolations(rawValue, env) {
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

/**
 * @param {AgentBrowserConfigState} state
 * @param {WebSearchProvider | "auto"} [requestedProvider]
 * @returns {WebSearchProvider[]}
 */
export function getWebSearchProviderOrder(state, requestedProvider) {
	if (requestedProvider && requestedProvider !== "auto") return [requestedProvider];
	const preferred = state.webSearchPreferredProvider;
	return [preferred, ...WEB_SEARCH_PROVIDERS.filter((provider) => provider !== preferred)];
}

/**
 * @param {AgentBrowserConfigState} state
 * @param {WebSearchProvider} provider
 */
export function getWebSearchCredentialSource(state, provider) {
	return state.webSearchCredentialSources[provider];
}

/**
 * @param {CredentialSource | undefined} source
 * @param {NodeJS.ProcessEnv} env
 */
export function hasPotentialCredentialSource(source, env) {
	if (!source) return false;
	if (source.kind === "command") return true;
	if (source.kind === "env") return Boolean(resolveEnvInterpolations(source.rawValue, env)?.trim());
	return Boolean(source.rawValue.trim());
}

/**
 * @param {AgentBrowserConfigState} state
 * @param {NodeJS.ProcessEnv} [env]
 */
export function canRegisterWebSearchTool(state, env = process.env) {
	if (!state.webSearchEnabled || state.errors.length > 0) return false;
	return WEB_SEARCH_PROVIDERS.some((provider) => hasPotentialCredentialSource(state.webSearchCredentialSources[provider], env));
}

/**
 * @param {CredentialSource | undefined} source
 * @param {WebSearchProvider} [provider]
 */
export function getCredentialSourceSummary(source, provider) {
	if (!source) return "not configured";
	if (source.kind === "command") return `configured via command (${source.scope})`;
	if (source.kind === "env") return `configured via environment interpolation (${source.scope})`;
	if (source.scope === "env-fallback") {
		return `configured via ${getWebSearchProviderEnvVar(provider ?? source.provider ?? DEFAULT_WEB_SEARCH_PROVIDER)} environment fallback`;
	}
	return `configured as plaintext ${source.scope} value [redacted]`;
}

/** @param {AgentBrowserConfigState} state */
export function formatBrowserProfileStatus(state) {
	const profile = state.browserDefaultProfile;
	if (!profile) return "not configured";
	const scope = state.browserDefaultProfileScope ?? "unknown";
	const base = `${profile.name} (policy: ${profile.policy}; ${scope})`;
	if (scope !== "project") return base;
	const trustedText = state.trustedBrowserDefaultProfile ? `; trusted guidance: ${state.trustedBrowserDefaultProfile.name} (${state.trustedBrowserDefaultProfileScope})` : "";
	return `${base}; ignored for prompt guidance${trustedText}`;
}

/** @param {AgentBrowserConfigState} state */
export function formatBrowserExecutableStatus(state) {
	const executablePath = state.browserExecutablePath;
	if (!executablePath) return "not configured";
	const scope = state.browserExecutablePathScope ?? "unknown";
	if (scope !== "project") return `${executablePath} (${scope})`;
	const trustedText = state.trustedBrowserExecutablePath ? `; trusted guidance: ${state.trustedBrowserExecutablePath} (${state.trustedBrowserExecutablePathScope})` : "";
	return `${executablePath} (${scope}; ignored for prompt guidance${trustedText})`;
}

/**
 * @param {AgentBrowserConfigState} state
 * @param {(path: string) => boolean} [exists]
 * @returns {ConfigFileSummary[]}
 */
export function summarizeConfigFiles(state, exists = existsSync) {
	return [
		["global", state.paths.global],
		["project", state.paths.project],
		...(state.paths.override ? [["override", state.paths.override]] : []),
	].map(([scope, path]) => ({ scope, path, exists: exists(path) }));
}
