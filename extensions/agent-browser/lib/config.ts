import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

import {
	SECRET_COMMAND_TIMEOUT_MS,
	getWebSearchCredentialSource,
	getWebSearchProviderOrder,
	loadAgentBrowserConfigStateSync,
	resolveEnvInterpolations,
	type AgentBrowserConfigLoadOptions,
	type AgentBrowserConfigState,
	type CredentialSource,
	type WebSearchProvider,
} from "./config-policy.js";

export {
	AGENT_BROWSER_CONFIG_ENV,
	BRAVE_API_KEY_ENV,
	CONFIG_RELATIVE_PATH,
	DEFAULT_WEB_SEARCH_PROVIDER,
	EXA_API_KEY_ENV,
	EXA_SEARCH_TYPES,
	GLOBAL_CONFIG_RELATIVE_PATH,
	SECRET_COMMAND_TIMEOUT_MS,
	WEB_SEARCH_PROVIDER_CONFIG_KEYS,
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
	getWebSearchProviderDescriptor,
	getWebSearchProviderLabel,
	getWebSearchProviderOrder,
	hasPotentialCredentialSource,
	isWebSearchProvider,
	loadAgentBrowserConfigStateSync,
	mergeAgentBrowserConfig,
	parseAgentBrowserConfigJson,
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
	ExaSearchType,
	WebSearchProvider,
	WebSearchProviderDescriptor,
} from "./config-policy.js";

// Node's callback-oriented exec returns ChildProcess; promisify intentionally ignores that return.
// oxlint-disable-next-line typescript/strict-void-return
const exec = promisify(execCallback);

export interface ResolvedCredential {
	readonly source: CredentialSource;
	readonly value: string;
}

export function loadAgentBrowserConfigSync(
	options: AgentBrowserConfigLoadOptions = {},
): AgentBrowserConfigState {
	return loadAgentBrowserConfigStateSync(options);
}

async function resolveCommandCredential(
	rawValue: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const command = rawValue.slice(1).trim();
	if (command.length === 0) {
		return undefined;
	}
	try {
		const result = await exec(command, {
			signal,
			timeout: SECRET_COMMAND_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		const value = result.stdout.trim();
		return value.length > 0 ? value : undefined;
	} catch (error) {
		if (signal?.aborted === true) {
			throw error;
		}
		// The native exec error contains the secret command/stdout/stderr; never expose it as a cause.
		// oxlint-disable-next-line eslint/preserve-caught-error
		throw new Error(
			"Credential command failed without exposing command output. Check pi-agent-browser-config web-search status and the configured secret manager command.",
		);
	}
}

async function resolveCredentialSource(
	source: CredentialSource | undefined,
	options: { readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal } = {},
): Promise<ResolvedCredential | undefined> {
	if (!source) {
		return undefined;
	}
	let value: string | undefined;
	if (source.kind === "command") {
		value = await resolveCommandCredential(source.rawValue, options.signal);
	} else if (source.kind === "env") {
		value = resolveEnvInterpolations(source.rawValue, options.env ?? process.env)?.trim();
	} else {
		value = source.rawValue.trim();
	}
	return value !== undefined && value.length > 0 ? { source, value } : undefined;
}

export async function resolveWebSearchCredential(
	state: AgentBrowserConfigState,
	provider: WebSearchProvider,
	options: { readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal } = {},
): Promise<ResolvedCredential | undefined> {
	if (!state.webSearchEnabled || state.errors.length > 0) {
		return undefined;
	}
	return resolveCredentialSource(getWebSearchCredentialSource(state, provider), options);
}

export async function resolvePreferredWebSearchCredential(
	state: AgentBrowserConfigState,
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly provider?: WebSearchProvider | "auto";
		readonly signal?: AbortSignal;
	} = {},
): Promise<
	{ readonly provider: WebSearchProvider; readonly credential: ResolvedCredential } | undefined
> {
	if (!state.webSearchEnabled || state.errors.length > 0) {
		return undefined;
	}
	for (const provider of getWebSearchProviderOrder(state, options.provider)) {
		// Resolve in configured preference order; later secret commands must not run once a key resolves.
		// oxlint-disable-next-line no-await-in-loop
		const credential = await resolveWebSearchCredential(state, provider, options);
		if (credential) {
			return { provider, credential };
		}
	}
	return undefined;
}
