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
export const CONFIG_RELATIVE_PATH = [".pi", "config", "pi-agent-browser-native", "config.json"] as const;
export const GLOBAL_CONFIG_RELATIVE_PATH = [".pi", "config", "pi-agent-browser-native", "config.json"] as const;
export const SECRET_COMMAND_TIMEOUT_MS = 15_000;

export type BrowserDefaultProfilePolicy = "explicit-only" | "authenticated-only" | "always";
export type AgentBrowserConfigScope = "global" | "project" | "override" | "env-fallback";
export type CredentialSourceKind = "literal" | "env" | "command";

export interface BrowserDefaultProfileConfig {
	name: string;
	policy?: BrowserDefaultProfilePolicy;
}

export interface AgentBrowserConfig {
	version?: 1;
	webSearch?: {
		braveApiKey?: string;
	};
	browser?: {
		defaultProfile?: BrowserDefaultProfileConfig;
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
	rawValue: string;
	scope: AgentBrowserConfigScope;
}

export interface AgentBrowserConfigState {
	browserDefaultProfile?: Required<BrowserDefaultProfileConfig>;
	config: AgentBrowserConfig;
	credentialSource?: CredentialSource;
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
			const braveApiKey = validateString(value.webSearch.braveApiKey, `${path}.webSearch.braveApiKey`, errors);
			if (braveApiKey !== undefined) {
				config.webSearch = { braveApiKey };
				if (scope === "project" && !isProjectSafeCredentialValue(braveApiKey)) {
					errors.push(`${path}.webSearch.braveApiKey must be exactly $ENV_VAR or ${"${ENV_VAR}"} in project-local config; plaintext, interpolation literals, malformed env references, and command-backed project secrets are not allowed.`);
				}
			}
		}
	}

	if (value.browser !== undefined) {
		if (!isRecord(value.browser)) {
			errors.push(`${path}.browser must be an object.`);
		} else {
			config.browser = {};
			const defaultProfile = validateBrowserDefaultProfile(value.browser.defaultProfile, `${path}.browser.defaultProfile`, errors);
			if (defaultProfile) config.browser.defaultProfile = defaultProfile;
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

export function classifyCredentialSource(rawValue: string, scope: AgentBrowserConfigScope): CredentialSource | undefined {
	const trimmed = rawValue.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("!")) return { kind: "command", rawValue: trimmed, scope };
	if (trimmed.includes("$")) return { kind: "env", rawValue: trimmed, scope };
	return { kind: "literal", rawValue: trimmed, scope };
}

function getBrowserDefaultProfile(config: AgentBrowserConfig): Required<BrowserDefaultProfileConfig> | undefined {
	const profile = config.browser?.defaultProfile;
	if (!profile?.name.trim()) return undefined;
	return { name: profile.name.trim(), policy: profile.policy ?? "authenticated-only" };
}

function buildConfigState(options: {
	env: NodeJS.ProcessEnv;
	layers: ConfigLayer[];
	mergedConfig: AgentBrowserConfig;
	paths: AgentBrowserConfigState["paths"];
	errors: string[];
	warnings: string[];
}): AgentBrowserConfigState {
	let credentialScope: AgentBrowserConfigScope = "global";
	for (let index = options.layers.length - 1; index >= 0; index -= 1) {
		const layer = options.layers[index];
		if (layer?.config.webSearch?.braveApiKey !== undefined) {
			credentialScope = layer.scope;
			break;
		}
	}
	let credentialSource = options.mergedConfig.webSearch?.braveApiKey === undefined
		? undefined
		: classifyCredentialSource(options.mergedConfig.webSearch.braveApiKey, credentialScope);
	if (!credentialSource && options.env[BRAVE_API_KEY_ENV]?.trim()) {
		credentialSource = { kind: "literal", rawValue: options.env[BRAVE_API_KEY_ENV] ?? "", scope: "env-fallback" };
	}
	return {
		browserDefaultProfile: getBrowserDefaultProfile(options.mergedConfig),
		config: options.mergedConfig,
		credentialSource,
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

export async function resolveBraveApiKey(
	state: AgentBrowserConfigState,
	options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ResolvedCredential | undefined> {
	return resolveCredentialSource(state.credentialSource, options);
}

export function canRegisterWebSearchTool(state: AgentBrowserConfigState, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!state.credentialSource || state.errors.length > 0) return false;
	if (state.credentialSource.kind === "command") return true;
	if (state.credentialSource.kind === "env") return Boolean(resolveEnvInterpolations(state.credentialSource.rawValue, env)?.trim());
	return Boolean(state.credentialSource.rawValue.trim());
}

export async function hasResolvableCredentialSource(
	state: AgentBrowserConfigState,
	options: { env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
	if (!state.credentialSource || state.errors.length > 0) return false;
	if (state.credentialSource.kind === "command") return true;
	return Boolean((await resolveCredentialSource(state.credentialSource, options))?.value);
}

export function getCredentialSourceSummary(source: CredentialSource | undefined): string {
	if (!source) return "not configured";
	if (source.kind === "command") return `configured via command (${source.scope})`;
	if (source.kind === "env") return `configured via environment interpolation (${source.scope})`;
	if (source.scope === "env-fallback") return `configured via ${BRAVE_API_KEY_ENV} environment fallback`;
	return `configured as plaintext ${source.scope} value [redacted]`;
}
