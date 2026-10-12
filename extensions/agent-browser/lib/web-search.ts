import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "./json-schema.js";
import {
	AGENT_BROWSER_NAMESPACE,
	AGENT_BROWSER_OUTPUT_SCHEMA,
	finalizeAgentBrowserNativeResult,
} from "./native-output.js";
import { redactSensitiveText } from "./runtime.js";
import {
	resolvePreferredWebSearchCredential,
	type AgentBrowserConfigState,
	type WebSearchProvider,
} from "./config.js";
import {
	AgentBrowserWebSearchParams,
	DEFAULT_SEARCH_RESULT_COUNT,
	MAX_SEARCH_RESULT_COUNT,
	type AgentBrowserWebSearchParamsInput,
	type WebSearchProviderParam,
} from "./web-search-schema.js";
import { WebSearchRequestGate } from "./web-search-request.js";
import { WebSearchLocalError, prepareWebSearchRequest } from "./web-search-providers.js";
import {
	dedupeSearchResults,
	formatSearchResults,
	type NormalizedSearchResult,
} from "./web-search-results.js";

export { EXA_SEARCH_TYPES, type ExaSearchType } from "./config.js";
export {
	AgentBrowserWebSearchParams,
	createAgentBrowserWebSearchParamsSchema,
	type ExaSearchCategory,
	type WebSearchProviderParam,
} from "./web-search-schema.js";
export { WEB_SEARCH_MIN_REQUEST_INTERVAL_MS, WebSearchRequestGate } from "./web-search-request.js";
export {
	EXA_SEARCH_SYSTEM_PROMPT,
	buildBraveSearchUrl,
	buildExaSearchRequestBody,
	fetchBraveSearchJson,
	fetchExaSearchJson,
} from "./web-search-providers.js";
export {
	cleanSearchText,
	decodeHtmlEntities,
	normalizeBraveSearchResult,
	normalizeExaSearchResult,
	type BraveWebSearchResult,
	type BraveWebSearchResponse,
	type ExaWebSearchResult,
	type ExaWebSearchResponse,
	type NormalizedSearchResult,
} from "./web-search-results.js";

export const AGENT_BROWSER_WEB_SEARCH_TOOL_NAME = "agent_browser_web_search";
type WebSearchToolDetails = {
	readonly provider: WebSearchProvider;
	readonly query: string;
	readonly returnedQuery: string;
	readonly count: number;
	readonly offset: number;
	readonly fetchedAt: string;
	readonly results: readonly NormalizedSearchResult[];
	readonly duplicatesRemoved?: number;
	readonly searchType?: string;
	readonly requestId?: string;
};
type WebSearchContext = { readonly cwd: string; readonly isProjectTrusted: () => boolean };
type WebSearchOptions = {
	readonly loadConfigState?: (ctx: WebSearchContext) => AgentBrowserConfigState;
};
type WebSearchTool = {
	readonly name: string;
	readonly namespace: typeof AGENT_BROWSER_NAMESPACE;
	readonly outputSchema: typeof AGENT_BROWSER_OUTPUT_SCHEMA;
	readonly label: string;
	readonly description: string;
	readonly promptSnippet: string;
	readonly parameters: TSchema;
	readonly execute: (
		toolCallId: string,
		params: AgentBrowserWebSearchParamsInput,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: WebSearchContext,
	) => Promise<AgentToolResult<Record<string, unknown>>>;
};

function buildMissingCredentialError(provider: WebSearchProviderParam): string {
	if (provider === "brave") {
		return "agent_browser_web_search provider brave was requested but no BRAVE_API_KEY/config credential resolved.";
	}
	if (provider === "exa") {
		return "agent_browser_web_search provider exa was requested but no EXA_API_KEY/config credential resolved.";
	}
	return "No Exa or Brave web search credential resolved. Configure webSearch.exaApiKey or webSearch.braveApiKey, or load EXA_API_KEY/BRAVE_API_KEY in the runtime environment.";
}

function validateRuntimeConfig(state: AgentBrowserConfigState): void {
	if (state.errors.length > 0) {
		throw new WebSearchLocalError(
			`agent_browser_web_search config is invalid: ${state.errors.join("; ")}`,
		);
	}
	if (!state.webSearchEnabled) {
		throw new WebSearchLocalError(
			"agent_browser_web_search is disabled by pi-agent-browser-native config.",
		);
	}
}

function validateProviderParams(
	provider: WebSearchProvider,
	params: AgentBrowserWebSearchParamsInput,
): void {
	if (provider !== "brave") {
		return;
	}
	const exaOnlyFields = [
		params.includeDomains ? "includeDomains" : undefined,
		params.excludeDomains ? "excludeDomains" : undefined,
		params.category !== undefined ? "category" : undefined,
		params.additionalQueries ? "additionalQueries" : undefined,
		params.highlightsDynamic === true ? "highlightsDynamic" : undefined,
	].filter((field) => field !== undefined);
	if (exaOnlyFields.length > 0) {
		throw new WebSearchLocalError(
			`${exaOnlyFields.join(", ")} ${exaOnlyFields.length === 1 ? "requires" : "require"} provider exa; resolved provider was brave.`,
		);
	}
}

async function runWebSearch(
	state: AgentBrowserConfigState,
	params: AgentBrowserWebSearchParamsInput,
	gate: WebSearchRequestGate,
	signal?: AbortSignal,
): Promise<WebSearchToolDetails> {
	validateRuntimeConfig(state);
	const requestedProvider = params.provider ?? "auto";
	const resolved = await resolvePreferredWebSearchCredential(state, {
		provider: requestedProvider,
		signal,
	});
	if (!resolved) {
		throw new WebSearchLocalError(buildMissingCredentialError(requestedProvider));
	}
	validateProviderParams(resolved.provider, params);
	const query = params.query.trim();
	if (query.length === 0) {
		throw new WebSearchLocalError("query must not be blank");
	}
	const count = Math.min(
		Math.max(params.count ?? DEFAULT_SEARCH_RESULT_COUNT, 1),
		MAX_SEARCH_RESULT_COUNT,
	);
	const offset = Math.max(params.offset ?? 0, 0);
	const executionParams = {
		additionalQueries: params.additionalQueries,
		category: params.category,
		country: params.country,
		count,
		excludeDomains: params.excludeDomains,
		freshness: params.freshness,
		highlightsDynamic: params.highlightsDynamic,
		includeDomains: params.includeDomains,
		offset,
		query,
		safesearch: params.safesearch,
		searchLang: params.searchLang,
		searchType: params.searchType ?? state.config.webSearch?.defaultSearchType ?? "auto",
	};
	const request = prepareWebSearchRequest(
		resolved.provider,
		executionParams,
		resolved.credential.value,
		signal,
	);
	const normalized = await gate.run(signal, request);
	const results = dedupeSearchResults(normalized.results);
	const duplicatesRemoved = normalized.results.length - results.length;
	return {
		provider: resolved.provider,
		query,
		returnedQuery: normalized.returnedQuery,
		count,
		offset,
		...normalized.extraDetails,
		fetchedAt: new Date().toISOString(),
		results,
		duplicatesRemoved: duplicatesRemoved > 0 ? duplicatesRemoved : undefined,
	};
}

async function presentSearchSuccess(
	details: WebSearchToolDetails,
	params: AgentBrowserWebSearchParamsInput,
): Promise<AgentToolResult<Record<string, unknown>>> {
	const duplicateNotice =
		details.duplicatesRemoved !== undefined
			? `\n\nDuplicate URLs removed: ${details.duplicatesRemoved}.`
			: "";
	const result: AgentToolResult<Record<string, unknown>> = await finalizeAgentBrowserNativeResult(
		{
			content: [
				{
					type: "text",
					text: `${formatSearchResults(details.provider, details.returnedQuery, details.results)}${duplicateNotice}`,
				},
			],
			details: { data: details },
		},
		params,
	);
	// Keep the finalized spill receipt while flattening the documented search details shape.
	const finalizedManifest = result.details.artifactManifest;
	return finalizedManifest === undefined
		? { ...result, details }
		: { ...result, details: { ...details, artifactManifest: finalizedManifest } };
}

function failureCategory(
	error: unknown,
	signal?: AbortSignal,
): "aborted" | "validation-error" | "upstream-error" {
	if (signal?.aborted === true) {
		return "aborted";
	}
	return error instanceof WebSearchLocalError ? "validation-error" : "upstream-error";
}

export function createAgentBrowserWebSearchTool(
	configState: AgentBrowserConfigState,
	options: WebSearchOptions = {},
): WebSearchTool {
	const requestGate = new WebSearchRequestGate();
	return {
		name: AGENT_BROWSER_WEB_SEARCH_TOOL_NAME,
		namespace: AGENT_BROWSER_NAMESPACE,
		outputSchema: AGENT_BROWSER_OUTPUT_SCHEMA,
		label: "Agent Browser Web Search",
		description: `Search the live web with Exa or Brave for current or external information. For Exa research tasks, use searchType deep-lite or deeper. Returns up to ${MAX_SEARCH_RESULT_COUNT} concise web results.`,
		promptSnippet: "Search the live web with Exa or Brave for current or external information.",
		parameters: AgentBrowserWebSearchParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const state = ctx ? (options.loadConfigState?.(ctx) ?? configState) : configState;
				const details = await runWebSearch(state, params, requestGate, signal);
				return await presentSearchSuccess(details, params);
			} catch (error) {
				const message = redactSensitiveText(
					error instanceof Error ? error.message : "Unknown web search failure",
				).slice(0, 1_000);
				return finalizeAgentBrowserNativeResult(
					{
						content: [{ type: "text", text: message }],
						details: {
							error: message,
							resultCategory: "failure",
							failureCategory: failureCategory(error, signal),
						},
						isError: true,
					},
					params,
				);
			}
		},
	};
}
