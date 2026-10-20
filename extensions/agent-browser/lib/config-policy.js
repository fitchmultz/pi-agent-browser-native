// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
	DEFAULT_WEB_SEARCH_PROVIDER,
	WEB_SEARCH_PROVIDERS,
	getWebSearchProviderDescriptor,
	getWebSearchProviderEnvVar,
} from "./config-providers.js";
import { parseAgentBrowserConfigLayer, describeUnknownError } from "./config-validation.js";
export * from "./config-providers.js";
export {
	parseAgentBrowserConfigJson,
	parseAgentBrowserConfigLayer,
	validateAgentBrowserConfig,
	validateWebSearchProvider,
} from "./config-validation.js";

/** @typedef {import("./config-providers.js").WebSearchProvider} WebSearchProvider */
/** @typedef {import("./config-providers.js").ExaSearchType} ExaSearchType */
/** @typedef {import("./config-providers.js").WebSearchProviderConfigKey} WebSearchProviderConfigKey */
/** @typedef {import("./config-providers.js").WebSearchProviderDescriptor} WebSearchProviderDescriptor */
/** @typedef {import("./config-validation.js").BrowserDefaultProfilePolicy} BrowserDefaultProfilePolicy */
/** @typedef {import("./config-validation.js").BrowserDefaultProfileConfig} BrowserDefaultProfileConfig */
/** @typedef {import("./config-validation.js").BrowserConfig} BrowserConfig */
/** @typedef {import("./config-validation.js").WebSearchConfig} WebSearchConfig */
/** @typedef {import("./config-validation.js").ConfigLayerScope} ConfigLayerScope */
/** @typedef {import("./config-validation.js").AgentBrowserConfig} AgentBrowserConfig */
/** @typedef {import("./config-validation.js").ConfigLayer} ConfigLayer */
/** @typedef {"global" | "project" | "override" | "env-fallback"} AgentBrowserConfigScope */
/** @typedef {"literal" | "env" | "command"} CredentialSourceKind */
/** @typedef {{ readonly kind: CredentialSourceKind; readonly provider?: WebSearchProvider; readonly rawValue: string; readonly scope: AgentBrowserConfigScope }} CredentialSource */
/** @typedef {{ readonly global: string; readonly project: string; readonly override?: string }} AgentBrowserConfigPaths */
/** @typedef {{ readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly includeProjectConfig?: boolean }} AgentBrowserConfigLoadOptions */
/** @typedef {{ readonly browserDefaultProfile?: Required<BrowserDefaultProfileConfig>; readonly browserDefaultProfileScope?: ConfigLayerScope; readonly browserExecutablePath?: string; readonly browserExecutablePathScope?: ConfigLayerScope; readonly trustedBrowserDefaultProfile?: Required<BrowserDefaultProfileConfig>; readonly trustedBrowserDefaultProfileScope?: ConfigLayerScope; readonly trustedBrowserExecutablePath?: string; readonly trustedBrowserExecutablePathScope?: ConfigLayerScope; readonly config: AgentBrowserConfig; readonly webSearchCredentialSources: Readonly<Partial<Record<WebSearchProvider, CredentialSource>>>; readonly webSearchEnabled: boolean; readonly webSearchPreferredProvider: WebSearchProvider; readonly errors: readonly string[]; readonly layers: readonly ConfigLayer[]; readonly paths: AgentBrowserConfigPaths; readonly projectConfigIncluded: boolean; readonly warnings: readonly string[] }} AgentBrowserConfigState */
/** @typedef {{ readonly scope: string; readonly path: string; readonly exists: boolean }} ConfigFileSummary */

const CONFIG_DIR_NAME = ".pi";

export const AGENT_BROWSER_CONFIG_ENV = "PI_AGENT_BROWSER_CONFIG";

export const CONFIG_RELATIVE_PATH = /** @type {const} */ ([
	CONFIG_DIR_NAME,
	"config",
	"pi-agent-browser-native",
	"config.json",
]);
export const GLOBAL_CONFIG_RELATIVE_PATH = /** @type {const} */ ([
	CONFIG_DIR_NAME,
	"config",
	"pi-agent-browser-native",
	"config.json",
]);
export const SECRET_COMMAND_TIMEOUT_MS = 15_000;

/** @param {NodeJS.ProcessEnv} [env] */
export function getGlobalAgentBrowserConfigPath(env = process.env) {
	const home =
		[env.HOME?.trim(), env.USERPROFILE?.trim()].find(
			(value) => value !== undefined && value.length > 0,
		) ?? homedir();
	return join(home, ...GLOBAL_CONFIG_RELATIVE_PATH);
}

/** @param {string} [cwd] */
export function getProjectAgentBrowserConfigPath(cwd = process.cwd()) {
	return resolve(cwd, ...CONFIG_RELATIVE_PATH);
}

/**
 * @param {{ readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }} [options]
 * @returns {AgentBrowserConfigPaths}
 */
export function getAgentBrowserConfigPaths(options = {}) {
	const env = options.env ?? process.env;
	const override = env[AGENT_BROWSER_CONFIG_ENV]?.trim();
	return {
		global: getGlobalAgentBrowserConfigPath(env),
		project: getProjectAgentBrowserConfigPath(options.cwd),
		...(override !== undefined && override.length > 0 ? { override: resolve(override) } : {}),
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
			...base.browser,
			...override.browser,
			defaultProfile: override.browser?.defaultProfile ?? base.browser?.defaultProfile,
		},
		webSearch: {
			...base.webSearch,
			...override.webSearch,
		},
	};
}

/**
 * @param {string} rawValue
 * @param {AgentBrowserConfigScope} scope
 * @param {WebSearchProvider} [provider]
 * @returns {CredentialSource | undefined}
 */
export function classifyCredentialSource(rawValue, scope, provider) {
	const trimmed = rawValue.trim();
	if (trimmed.length === 0) {
		return;
	}
	if (trimmed.startsWith("!")) {
		return { kind: "command", provider, rawValue: trimmed, scope };
	}
	if (trimmed.includes("$")) {
		return { kind: "env", provider, rawValue: trimmed, scope };
	}
	return { kind: "literal", provider, rawValue: trimmed, scope };
}

/**
 * @param {AgentBrowserConfig} config
 * @returns {Required<BrowserDefaultProfileConfig> | undefined}
 */
function getBrowserDefaultProfile(config) {
	const profile = config.browser?.defaultProfile;
	if (!profile || profile.name.trim().length === 0) {
		return;
	}
	return { name: profile.name.trim(), policy: profile.policy ?? "authenticated-only" };
}

/** @param {AgentBrowserConfig} config */
function getBrowserExecutablePath(config) {
	const executablePath = config.browser?.executablePath?.trim();
	return executablePath !== undefined && executablePath.length > 0 ? executablePath : undefined;
}

/**
 * @param {readonly ConfigLayer[]} layers
 * @returns {ConfigLayerScope | undefined}
 */
function getBrowserDefaultProfileScope(layers) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers.at(index);
		if (layer?.config.browser?.defaultProfile !== undefined) {
			return layer.scope;
		}
	}
	return;
}

/**
 * @param {readonly ConfigLayer[]} layers
 * @returns {ConfigLayerScope | undefined}
 */
function getBrowserExecutablePathScope(layers) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers.at(index);
		if (layer?.config.browser?.executablePath !== undefined) {
			return layer.scope;
		}
	}
	return;
}

/**
 * @param {readonly ConfigLayer[]} layers
 * @returns {{ profile: Required<BrowserDefaultProfileConfig>; scope: ConfigLayerScope } | undefined}
 */
function getTrustedBrowserDefaultProfile(layers) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers.at(index);
		if (!layer) {
			continue;
		}
		const profile = getBrowserDefaultProfile(layer.config);
		if (profile) {
			return { profile, scope: layer.scope };
		}
	}
	return;
}

/**
 * @param {readonly ConfigLayer[]} layers
 * @returns {{ executablePath: string; scope: ConfigLayerScope } | undefined}
 */
function getTrustedBrowserExecutablePath(layers) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers.at(index);
		if (!layer) {
			continue;
		}
		const executablePath = getBrowserExecutablePath(layer.config);
		if (executablePath !== undefined && executablePath.length > 0) {
			return { executablePath, scope: layer.scope };
		}
	}
	return;
}

/**
 * @param {readonly ConfigLayer[]} layers
 * @param {WebSearchProviderConfigKey} key
 * @returns {AgentBrowserConfigScope}
 */
function getWebSearchCredentialScope(layers, key) {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers.at(index);
		if (layer?.config.webSearch?.[key] !== undefined) {
			return layer.scope;
		}
	}
	return "global";
}

/**
 * @param {{ readonly env: NodeJS.ProcessEnv; readonly layers: readonly ConfigLayer[]; readonly mergedConfig: AgentBrowserConfig }} options
 * @returns {Partial<Record<WebSearchProvider, CredentialSource>>}
 */
export function buildWebSearchCredentialSources(options) {
	/** @type {Partial<Record<WebSearchProvider, CredentialSource>>} */
	const sources = {};
	for (const provider of WEB_SEARCH_PROVIDERS) {
		const descriptor = getWebSearchProviderDescriptor(provider);
		const apiKey = options.mergedConfig.webSearch?.[descriptor.configKey];
		if (apiKey !== undefined) {
			sources[provider] = classifyCredentialSource(
				apiKey,
				getWebSearchCredentialScope(options.layers, descriptor.configKey),
				provider,
			);
		}
		if (!sources[provider] && (options.env[descriptor.apiKeyEnv]?.trim().length ?? 0) > 0) {
			sources[provider] = {
				kind: "literal",
				provider,
				rawValue: options.env[descriptor.apiKeyEnv] ?? "",
				scope: "env-fallback",
			};
		}
	}
	return sources;
}

/**
 * @param {{ readonly env: NodeJS.ProcessEnv; readonly layers: readonly ConfigLayer[]; readonly mergedConfig: AgentBrowserConfig; readonly paths: AgentBrowserConfigPaths; readonly errors: readonly string[]; readonly warnings: readonly string[]; readonly projectConfigIncluded?: boolean }} options
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
		webSearchPreferredProvider:
			options.mergedConfig.webSearch?.preferredProvider ?? DEFAULT_WEB_SEARCH_PROVIDER,
		errors: options.errors,
		layers: options.layers,
		paths: options.paths,
		projectConfigIncluded:
			options.projectConfigIncluded ?? options.layers.some((layer) => layer.scope === "project"),
		warnings: options.warnings,
	};
}

/**
 * @param {string} path
 * @param {ConfigLayerScope} scope
 * @param {import("./config-validation.js").ConfigDiagnostics} errors
 * @param {import("./config-validation.js").ConfigDiagnostics} warnings
 * @returns {ConfigLayer | undefined}
 */
function readConfigLayerSync(path, scope, errors, warnings) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return;
		}
		errors.push(
			`Could not read ${scope} config ${path}: ${error instanceof Error ? error.message : describeUnknownError(error)}`,
		);
		return;
	}
	return parseAgentBrowserConfigLayer(raw, path, scope, errors, warnings);
}

/**
 * @param {AgentBrowserConfigLoadOptions} [options]
 * @returns {AgentBrowserConfigState}
 */
export function loadAgentBrowserConfigStateSync(options = {}) {
	const env = options.env ?? process.env;
	const paths = getAgentBrowserConfigPaths({ cwd: options.cwd, env });
	const includeProjectConfig = options.includeProjectConfig !== false;
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];
	/** @type {Array<{ path: string; scope: ConfigLayerScope }>} */
	const layerCandidates = [{ path: paths.global, scope: "global" }];
	if (includeProjectConfig) {
		layerCandidates.push({ path: paths.project, scope: "project" });
	}
	if (paths.override !== undefined && paths.override.length > 0) {
		layerCandidates.push({ path: paths.override, scope: "override" });
	}
	/** @type {ConfigLayer[]} */
	const layers = [];
	/** @type {AgentBrowserConfig} */
	let mergedConfig = {};
	for (const candidate of layerCandidates) {
		const layer = readConfigLayerSync(candidate.path, candidate.scope, errors, warnings);
		if (!layer) {
			continue;
		}
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
		if (next === "$" || next === "!") {
			output += next;
			index += 1;
			continue;
		}
		let name = "";
		if (next === "{") {
			const end = rawValue.indexOf("}", index + 2);
			if (end === -1) {
				return;
			}
			name = rawValue.slice(index + 2, end);
			index = end;
		} else {
			const match = rawValue.slice(index + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
			if (!match) {
				output += "$";
				continue;
			}
			name = match[1];
			index += name.length;
		}
		if (name.length === 0) {
			return;
		}
		const value = env[name];
		if (value === undefined) {
			return;
		}
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
	if (requestedProvider !== undefined && requestedProvider !== "auto") {
		return [requestedProvider];
	}
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
	if (!source) {
		return false;
	}
	if (source.kind === "command") {
		return true;
	}
	if (source.kind === "env") {
		return Boolean(resolveEnvInterpolations(source.rawValue, env)?.trim());
	}
	return Boolean(source.rawValue.trim());
}

/**
 * @param {AgentBrowserConfigState} state
 * @param {NodeJS.ProcessEnv} [env]
 */
export function canRegisterWebSearchTool(state, env = process.env) {
	if (!state.webSearchEnabled || state.errors.length > 0) {
		return false;
	}
	return WEB_SEARCH_PROVIDERS.some((provider) =>
		hasPotentialCredentialSource(state.webSearchCredentialSources[provider], env),
	);
}

/**
 * @param {CredentialSource | undefined} source
 * @param {WebSearchProvider} [provider]
 */
export function getCredentialSourceSummary(source, provider) {
	if (!source) {
		return "not configured";
	}
	if (source.kind === "command") {
		return `configured via command (${source.scope})`;
	}
	if (source.kind === "env") {
		return `configured via environment interpolation (${source.scope})`;
	}
	if (source.scope === "env-fallback") {
		return `configured via ${getWebSearchProviderEnvVar(provider ?? source.provider ?? DEFAULT_WEB_SEARCH_PROVIDER)} environment fallback`;
	}
	return `configured as plaintext ${source.scope} value [redacted]`;
}

/** @param {AgentBrowserConfigState} state */
export function formatBrowserProfileStatus(state) {
	const profile = state.browserDefaultProfile;
	if (!profile) {
		return "not configured";
	}
	const scope = state.browserDefaultProfileScope ?? "unknown";
	return `${profile.name} (policy: ${profile.policy}; ${scope})`;
}

/** @param {AgentBrowserConfigState} state */
export function formatBrowserExecutableStatus(state) {
	const executablePath = state.browserExecutablePath;
	if (executablePath === undefined || executablePath.length === 0) {
		return "not configured";
	}
	const scope = state.browserExecutablePathScope ?? "unknown";
	return `${executablePath} (${scope})`;
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
		...(state.paths.override !== undefined && state.paths.override.length > 0
			? [["override", state.paths.override]]
			: []),
	].map(([scope, path]) => ({ scope, path, exists: exists(path) }));
}
