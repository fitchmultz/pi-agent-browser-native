// @ts-check

import {
	EXA_SEARCH_TYPES,
	WEB_SEARCH_PROVIDERS,
	getWebSearchProviderDescriptor,
	isWebSearchProvider,
} from "./config-providers.js";

/** @typedef {import("./config-providers.js").WebSearchProvider} WebSearchProvider */
/** @typedef {import("./config-providers.js").ExaSearchType} ExaSearchType */
/** @typedef {"explicit-only" | "authenticated-only" | "always"} BrowserDefaultProfilePolicy */
/** @typedef {"global" | "project" | "override"} ConfigLayerScope */
/** @typedef {{ readonly name: string; readonly policy?: BrowserDefaultProfilePolicy }} BrowserDefaultProfileConfig */
/** @typedef {{ readonly enabled?: boolean; readonly preferredProvider?: WebSearchProvider; readonly defaultSearchType?: ExaSearchType; readonly braveApiKey?: string; readonly exaApiKey?: string }} WebSearchConfig */
/** @typedef {{ readonly defaultProfile?: BrowserDefaultProfileConfig; readonly executablePath?: string }} BrowserConfig */
/** @typedef {{ readonly version?: 1; readonly webSearch?: WebSearchConfig; readonly browser?: BrowserConfig }} AgentBrowserConfig */
/** @typedef {{ readonly config: AgentBrowserConfig; readonly path: string; readonly scope: ConfigLayerScope }} ConfigLayer */
/** Validation deliberately appends diagnostics to the caller's collectors.
 * @typedef {string[]} ConfigDiagnostics */

/** @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>} */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value
 * @param {string} path
 * @param {ConfigDiagnostics} errors */
function validateString(value, path, errors) {
	if (value === undefined) {
		return;
	}
	if (typeof value !== "string") {
		errors.push(`${path} must be a string.`);
		return;
	}
	return value;
}

/** @param {unknown} value
 * @param {string} path
 * @param {ConfigDiagnostics} errors */
function validateBoolean(value, path, errors) {
	if (value === undefined) {
		return;
	}
	if (typeof value !== "boolean") {
		errors.push(`${path} must be a boolean.`);
		return;
	}
	return value;
}

/** @param {unknown} value
 * @param {string} path
 * @param {ConfigDiagnostics} errors
 * @returns {WebSearchProvider | undefined} */
export function validateWebSearchProvider(value, path, errors) {
	if (value === undefined) {
		return;
	}
	const provider = validateString(value, path, errors)?.trim();
	if (provider === undefined) {
		return;
	}
	if (!isWebSearchProvider(provider)) {
		errors.push(`${path} must be one of ${WEB_SEARCH_PROVIDERS.join(", ")}.`);
		return;
	}
	return provider;
}

/** @param {unknown} value
 * @param {string} path
 * @param {ConfigDiagnostics} errors
 * @returns {ExaSearchType | undefined} */
function validateExaSearchType(value, path, errors) {
	if (value === undefined) {
		return;
	}
	const searchType = validateString(value, path, errors)?.trim();
	if (searchType === undefined) {
		return;
	}
	const supported = EXA_SEARCH_TYPES.find((candidate) => candidate === searchType);
	if (supported === undefined) {
		errors.push(`${path} must be one of ${EXA_SEARCH_TYPES.join(", ")}.`);
	}
	return supported;
}

/** @param {unknown} value
 * @param {string} path
 * @param {ConfigDiagnostics} errors
 * @returns {BrowserDefaultProfileConfig | undefined} */
function validateBrowserDefaultProfile(value, path, errors) {
	if (value === undefined) {
		return;
	}
	if (!isRecord(value)) {
		errors.push(`${path} must be an object.`);
		return;
	}
	const name = validateString(value.name, `${path}.name`, errors)?.trim();
	if (name === undefined || name.length === 0) {
		errors.push(`${path}.name must not be blank.`);
		return;
	}
	const policy = validateString(value.policy, `${path}.policy`, errors) ?? "authenticated-only";
	if (policy !== "explicit-only" && policy !== "authenticated-only" && policy !== "always") {
		errors.push(`${path}.policy must be one of explicit-only, authenticated-only, always.`);
		return;
	}
	return { name, policy };
}

/** @param {unknown} value
 * @param {string} path
 * @param {ConfigDiagnostics} errors
 * @returns {WebSearchConfig | undefined} */
function validateWebSearchConfig(value, path, errors) {
	if (value === undefined) {
		return;
	}
	if (!isRecord(value)) {
		errors.push(`${path} must be an object.`);
		return;
	}
	const enabled = validateBoolean(value.enabled, `${path}.enabled`, errors);
	const preferredProvider = validateWebSearchProvider(
		value.preferredProvider,
		`${path}.preferredProvider`,
		errors,
	);
	const defaultSearchType = validateExaSearchType(
		value.defaultSearchType,
		`${path}.defaultSearchType`,
		errors,
	);
	/** @type {Partial<Record<import("./config-providers.js").WebSearchProviderConfigKey, string>>} */
	const keys = {};
	for (const provider of WEB_SEARCH_PROVIDERS) {
		const { configKey } = getWebSearchProviderDescriptor(provider);
		const apiKey = validateString(value[configKey], `${path}.${configKey}`, errors);
		if (apiKey !== undefined) {
			keys[configKey] = apiKey;
		}
	}
	const config = {
		...(enabled !== undefined ? { enabled } : {}),
		...(preferredProvider !== undefined ? { preferredProvider } : {}),
		...(defaultSearchType !== undefined ? { defaultSearchType } : {}),
		...keys,
	};
	return Object.keys(config).length > 0 ? config : undefined;
}

/** @param {unknown} value
 * @param {string} path
 * @param {ConfigDiagnostics} errors
 * @returns {BrowserConfig | undefined} */
function validateBrowserConfig(value, path, errors) {
	if (value === undefined) {
		return;
	}
	if (!isRecord(value)) {
		errors.push(`${path} must be an object.`);
		return;
	}
	const defaultProfile = validateBrowserDefaultProfile(
		value.defaultProfile,
		`${path}.defaultProfile`,
		errors,
	);
	const executablePath = validateString(
		value.executablePath,
		`${path}.executablePath`,
		errors,
	)?.trim();
	return {
		...(defaultProfile !== undefined ? { defaultProfile } : {}),
		...(executablePath !== undefined && executablePath.length > 0 ? { executablePath } : {}),
	};
}

/** @param {unknown} value
 * @param {string} path
 * @param {ConfigDiagnostics} errors
 * @param {ConfigDiagnostics} warnings
 * @returns {AgentBrowserConfig | undefined} */
export function validateAgentBrowserConfig(value, path, errors, warnings) {
	if (!isRecord(value)) {
		errors.push(`${path} must contain a JSON object.`);
		return;
	}
	if (value.version !== undefined && value.version !== 1) {
		errors.push(`${path}.version must be 1 when present.`);
	}
	const webSearch = validateWebSearchConfig(value.webSearch, `${path}.webSearch`, errors);
	const browser = validateBrowserConfig(value.browser, `${path}.browser`, errors);
	for (const key of Object.keys(value)) {
		if (!["version", "webSearch", "browser"].includes(key)) {
			warnings.push(
				`${path}.${key} is not a recognized pi-agent-browser-native config field and was ignored.`,
			);
		}
	}
	return {
		...(value.version === 1 ? { version: 1 } : {}),
		...(webSearch !== undefined ? { webSearch } : {}),
		...(browser !== undefined ? { browser } : {}),
	};
}

/** Parse config without retaining native token previews or source-bearing error causes.
 * @param {string} raw
 * @returns {{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }} */
export function parseAgentBrowserConfigJson(raw) {
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (error) {
		const location =
			error instanceof Error
				? error.message.match(/at position \d+(?: \(line \d+ column \d+\))?/)?.[0]
				: undefined;
		return {
			ok: false,
			error: location === undefined ? "Invalid JSON." : `Invalid JSON ${location}.`,
		};
	}
}

/** @param {string} raw
 * @param {string} path
 * @param {ConfigLayerScope} scope
 * @param {ConfigDiagnostics} errors
 * @param {ConfigDiagnostics} warnings
 * @returns {ConfigLayer | undefined} */
export function parseAgentBrowserConfigLayer(raw, path, scope, errors, warnings) {
	const parsed = parseAgentBrowserConfigJson(raw);
	if (!parsed.ok) {
		errors.push(`Could not parse ${scope} config ${path}: ${parsed.error}`);
		return;
	}
	const config = validateAgentBrowserConfig(parsed.value, path, errors, warnings);
	return config ? { config, path, scope } : undefined;
}

/** @param {unknown} value */
export function describeUnknownError(value) {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "bigint":
		case "boolean":
		case "symbol":
			return String(value);
		case "undefined":
			return "undefined";
		case "object":
			return value === null ? "null" : Object.prototype.toString.call(value);
		case "function":
			return value.toString();
	}
}
