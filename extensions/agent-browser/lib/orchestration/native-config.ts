import { readFile, rm } from "node:fs/promises";
import { isRecord } from "../parsing.js";
import { isUpstreamEnvFlagEnabled } from "../argv-grammar.js";
import { runAgentBrowserProcess } from "../process.js";
import { parseAgentBrowserEnvelope } from "../results/envelope.js";

export interface NativeDefaults {
	readonly session?: string | undefined;
	readonly namespace?: string | undefined;
	readonly profile?: unknown;
	readonly executablePath?: unknown;
	readonly [key: string]: unknown;
}

// Native local launch defaults must keep their launch-time argument policy stable.
const VALUE_DEFAULTS = [
	"executablePath",
	"profile",
	"state",
	"proxy",
	"args",
	"userAgent",
	"caCert",
	"colorScheme",
	"downloadPath",
	"engine",
	"allowedDomains",
];
const BOOLEAN_DEFAULTS = ["headed", "allowFileAccess", "webgpu", "noWebmcp"];
const ARRAY_DEFAULTS = ["extensions", "initScripts", "enable"];

export function nativeEnvName(key: string): string {
	return `AGENT_BROWSER_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

function nativeBooleanDefault(
	config: NativeDefaults,
	env: Readonly<NodeJS.ProcessEnv>,
	key: string,
): boolean {
	const value = env[nativeEnvName(key)];
	if (key === "hideScrollbars") {
		return value === undefined ? config[key] === false : !isUpstreamEnvFlagEnabled(value);
	}
	return value === undefined ? config[key] === true : isUpstreamEnvFlagEnabled(value);
}

export function hasLocalLaunchDefaults(
	config: NativeDefaults,
	env: Readonly<NodeJS.ProcessEnv>,
): boolean {
	return (
		VALUE_DEFAULTS.some(
			(key) => env[nativeEnvName(key)] !== undefined || config[key] !== undefined,
		) ||
		BOOLEAN_DEFAULTS.some(
			(key) => isUpstreamEnvFlagEnabled(env[nativeEnvName(key)]) || config[key] === true,
		) ||
		ARRAY_DEFAULTS.some(
			(key) =>
				(env[nativeEnvName(key)] ?? "").length > 0 ||
				(Array.isArray(config[key]) && config[key].length > 0),
		) ||
		nativeBooleanDefault(config, env, "clearCaCert") ||
		nativeBooleanDefault(config, env, "hideScrollbars") ||
		["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some(
			(key) => env[key] !== undefined,
		)
	);
}

function localFlag(key: string): string {
	switch (key) {
		case "extensions":
			return "--extension";
		case "initScripts":
			return "--init-script";
		case "clearCaCert":
			return "--no-ca-cert";
		default:
			return `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
	}
}

export const LOCAL_LAUNCH_DEFAULT_FLAGS: readonly string[] = [
	...VALUE_DEFAULTS,
	...BOOLEAN_DEFAULTS,
	...ARRAY_DEFAULTS,
	"hideScrollbars",
	"clearCaCert",
].map(localFlag);

interface NativeIdentityRead {
	readonly cwd: string;
	readonly signal?: AbortSignal | undefined;
	readonly rootFallback: boolean;
	readonly browserCommand: boolean;
}

function requestsLaunch(config: NativeDefaults, options: NativeIdentityRead): boolean {
	const browserLaunch =
		options.browserCommand &&
		(hasLocalLaunchDefaults(config, {}) ||
			["cdp", "autoConnect", "provider"].some((key) => config[key] !== undefined));
	const rootLaunch =
		options.rootFallback &&
		["restore", "sessionName", "state", "allowedDomains", "profile", "executablePath"].some(
			(key) => config[key] !== undefined,
		);
	return browserLaunch || rootLaunch;
}

async function readConfigFile(path: string): Promise<NativeDefaults | undefined> {
	try {
		const config: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(config)) {
			return undefined;
		}
		// Only identity is interpreted here; native validates every launch/config field.
		return {
			...config,
			session: typeof config.session === "string" ? config.session : undefined,
			namespace: typeof config.namespace === "string" ? config.namespace : undefined,
		};
	} catch {
		return undefined;
	}
}

function needsIdentityInspection(config: NativeDefaults, options: NativeIdentityRead): boolean {
	return (
		requestsLaunch(config, options) ||
		config.confirmActions !== undefined ||
		config.session !== undefined ||
		config.namespace !== undefined
	);
}

function resolvedIdentity(config: NativeDefaults, data: unknown): NativeDefaults {
	if (!isRecord(data) || typeof data.session !== "string") {
		throw new Error(
			"Native agent-browser session inspection returned no session name; the browser command was not run.",
		);
	}
	const { session: _session, namespace: _namespace, ...defaults } = config;
	return {
		...defaults,
		...(config.session !== undefined ? { session: data.session } : {}),
		...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
	};
}

// Native `session` reports resolution, not whether a name was configured.
async function readNativeIdentity(
	path: string,
	options: NativeIdentityRead,
): Promise<NativeDefaults> {
	const config = await readConfigFile(path);
	if (config === undefined) {
		return {};
	}
	if (!needsIdentityInspection(config, options)) {
		return {};
	}
	const result = await runAgentBrowserProcess({
		args: ["--config", path, "--json", "session"],
		cwd: options.cwd,
		signal: options.signal,
		timeoutMs: 5_000,
	});
	try {
		if (result.aborted || result.timedOut || result.spawnError !== undefined) {
			throw new Error(
				"Could not resolve native agent-browser session configuration; the browser command was not run.",
			);
		}
		if (result.exitCode !== 0) {
			return {};
		} // Discovered invalid files are native-ignored; explicit paths fail on the real command.
		const parsed = await parseAgentBrowserEnvelope({
			stdout: result.stdout,
			stdoutPath: result.stdoutSpillPath,
		});
		return resolvedIdentity(config, parsed.envelope?.data);
	} finally {
		if (result.stdoutSpillPath !== undefined && result.stdoutSpillPath.length > 0) {
			await rm(result.stdoutSpillPath, { force: true });
		}
	}
}

export async function loadNativeIdentity(
	paths: readonly string[],
	options: NativeIdentityRead,
): Promise<NativeDefaults> {
	const identity: NativeDefaults = {};
	for (const path of paths) {
		// Project defaults override global defaults; native validation must finish in that layer order.
		Object.assign(identity, await readNativeIdentity(path, options));
	}
	return identity;
}
