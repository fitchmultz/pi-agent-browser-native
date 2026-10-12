import { isRecord } from "./parsing.js";
import type { WebSearchProvider, ExaSearchType } from "./config.js";
import type { SearchFreshness, WebSearchExecutionParams } from "./web-search-schema.js";
import { fetchSearchJson, SEARCH_REQUEST_TIMEOUT_MS } from "./web-search-request.js";
import {
	cleanSearchText,
	normalizeBraveSearchResult,
	normalizeExaSearchResult,
	parseBraveSearchResponse,
	parseExaSearchResponse,
	type BraveWebSearchResponse,
	type ExaWebSearchResponse,
	type NormalizedSearchResult,
} from "./web-search-results.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const EXA_DYNAMIC_HIGHLIGHTS_BETA = "dynamic-highlights-2026-08-28";
export const EXA_SEARCH_SYSTEM_PROMPT =
	"Prefer primary, official sources. Respect any requested version or date. Avoid duplicate or equivalent results.";

/** Local validation/config failures, not provider outages; reported as `validation-error`. */
export class WebSearchLocalError extends Error {}

export type NormalizedProviderResponse = {
	readonly extraDetails?: { readonly requestId?: string; readonly searchType?: string };
	readonly results: readonly NormalizedSearchResult[];
	readonly returnedQuery: string;
};
interface WebSearchProviderAdapter<Request, Response> {
	readonly buildRequest: (params: WebSearchExecutionParams) => Request;
	readonly fetchJson: (request: Request, apiKey: string, signal?: AbortSignal) => Promise<Response>;
	readonly normalizeResponse: (
		response: Response,
		params: WebSearchExecutionParams,
	) => NormalizedProviderResponse;
	readonly provider: WebSearchProvider;
}

export function buildBraveSearchUrl(params: WebSearchExecutionParams): URL {
	const url = new URL(BRAVE_SEARCH_ENDPOINT);
	url.searchParams.set("q", params.query);
	url.searchParams.set("count", String(params.count));
	url.searchParams.set("offset", String(params.offset));
	if (params.country !== undefined && params.country.length > 0) {
		url.searchParams.set("country", params.country.toUpperCase());
	}
	if (params.searchLang !== undefined && params.searchLang.length > 0) {
		url.searchParams.set("search_lang", params.searchLang);
	}
	if (params.safesearch !== undefined) {
		url.searchParams.set("safesearch", params.safesearch);
	}
	if (params.freshness !== undefined) {
		url.searchParams.set("freshness", params.freshness);
	}
	return url;
}

const FRESHNESS_DAYS: Readonly<Record<SearchFreshness, number>> = { pd: 1, pw: 7, pm: 31, py: 365 };
function getStartPublishedDate(
	freshness: SearchFreshness | undefined,
	now: () => Date,
): string | undefined {
	if (freshness === undefined) {
		return;
	}
	return new Date(now().getTime() - FRESHNESS_DAYS[freshness] * 24 * 60 * 60 * 1000).toISOString();
}

function hasEntries(values: readonly string[] | undefined): boolean {
	return values !== undefined && values.length > 0;
}

function validateExaFilters(params: WebSearchExecutionParams, searchType: ExaSearchType): void {
	if (hasEntries(params.additionalQueries) && !searchType.startsWith("deep")) {
		throw new WebSearchLocalError(
			`additionalQueries requires deep-lite, deep, or deep-reasoning; received ${searchType}.`,
		);
	}
	if (
		(params.category === "company" || params.category === "people") &&
		(params.freshness !== undefined || hasEntries(params.excludeDomains))
	) {
		throw new WebSearchLocalError(
			`category ${params.category} cannot be combined with freshness or excludeDomains.`,
		);
	}
}

function exaContentFilters(params: WebSearchExecutionParams): Record<string, unknown> {
	return {
		...(hasEntries(params.includeDomains) ? { includeDomains: params.includeDomains } : {}),
		...(hasEntries(params.excludeDomains) ? { excludeDomains: params.excludeDomains } : {}),
		...(hasEntries(params.additionalQueries)
			? { additionalQueries: params.additionalQueries }
			: {}),
		...(params.safesearch !== undefined && params.safesearch !== "off" ? { moderation: true } : {}),
	};
}

export function buildExaSearchRequestBody(
	params: WebSearchExecutionParams,
	now: () => Date = () => new Date(),
): Record<string, unknown> {
	const searchType = params.searchType ?? "auto";
	validateExaFilters(params, searchType);
	const startPublishedDate = getStartPublishedDate(params.freshness, now);
	return {
		query: params.query,
		type: searchType,
		numResults: Math.min(params.count + params.offset, 100),
		contents: { highlights: params.highlightsDynamic === true ? { dynamic: true } : true },
		systemPrompt: EXA_SEARCH_SYSTEM_PROMPT,
		...(params.category !== undefined ? { category: params.category } : {}),
		...(params.country !== undefined && params.country.length > 0
			? { userLocation: params.country.toUpperCase() }
			: {}),
		...exaContentFilters(params),
		...(startPublishedDate !== undefined ? { startPublishedDate } : {}),
	};
}

export async function fetchBraveSearchJson(
	url: URL,
	apiKey: string,
	signal?: AbortSignal,
): Promise<BraveWebSearchResponse> {
	const data = await fetchSearchJson({
		cancelMessage: "Brave search cancelled",
		init: { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
		invalidJsonMessage: "Brave search returned invalid JSON",
		provider: "brave",
		request: url,
		signal,
		timeoutMessage: "Brave search timed out",
		timeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
	});
	return parseBraveSearchResponse(data);
}

function getExaRequestTimeoutMs(searchType: ExaSearchType | undefined): number {
	switch (searchType) {
		case "deep-lite":
			return 45_000;
		case "deep":
			return 60_000;
		case "deep-reasoning":
			return 90_000;
		case "auto":
		case "fast":
		case "instant":
		case undefined:
			return SEARCH_REQUEST_TIMEOUT_MS;
	}
}

function usesDynamicHighlights(body: Readonly<Record<string, unknown>>): boolean {
	const contents = body.contents;
	return (
		isRecord(contents) &&
		!Array.isArray(contents) &&
		isRecord(contents.highlights) &&
		!Array.isArray(contents.highlights) &&
		contents.highlights.dynamic === true
	);
}

export async function fetchExaSearchJson(
	body: Readonly<Record<string, unknown>>,
	apiKey: string,
	signal?: AbortSignal,
	timeoutMs = SEARCH_REQUEST_TIMEOUT_MS,
): Promise<ExaWebSearchResponse> {
	const data = await fetchSearchJson({
		cancelMessage: "Exa search cancelled",
		init: {
			body: JSON.stringify(body),
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				...(usesDynamicHighlights(body) ? { "Exa-Beta": EXA_DYNAMIC_HIGHLIGHTS_BETA } : {}),
			},
			method: "POST",
		},
		invalidJsonMessage: "Exa search returned invalid JSON",
		provider: "exa",
		request: EXA_SEARCH_ENDPOINT,
		signal,
		timeoutMessage: "Exa search timed out",
		timeoutMs,
	});
	return parseExaSearchResponse(data);
}

const BRAVE_WEB_SEARCH_ADAPTER: WebSearchProviderAdapter<URL, BraveWebSearchResponse> = {
	provider: "brave",
	buildRequest(params) {
		// Brave offsets count pages; fetch the prefix and slice by result like Exa.
		return buildBraveSearchUrl({ ...params, count: params.count + params.offset, offset: 0 });
	},
	fetchJson: fetchBraveSearchJson,
	normalizeResponse(response, params) {
		return {
			results: (response.web?.results ?? [])
				.map(normalizeBraveSearchResult)
				.filter((result) => result !== undefined)
				.slice(params.offset, params.offset + params.count),
			returnedQuery:
				cleanSearchText(response.query?.altered, 300) ??
				cleanSearchText(response.query?.original, 300) ??
				params.query,
		};
	},
};

type ExaSearchRequest = {
	readonly body: Readonly<Record<string, unknown>>;
	readonly timeoutMs: number;
};
const EXA_WEB_SEARCH_ADAPTER: WebSearchProviderAdapter<ExaSearchRequest, ExaWebSearchResponse> = {
	provider: "exa",
	buildRequest(params) {
		return {
			body: buildExaSearchRequestBody(params),
			timeoutMs: getExaRequestTimeoutMs(params.searchType ?? "auto"),
		};
	},
	fetchJson(request, apiKey, signal) {
		return fetchExaSearchJson(request.body, apiKey, signal, request.timeoutMs);
	},
	normalizeResponse(response, params) {
		return {
			extraDetails: {
				requestId: cleanSearchText(response.requestId, 120),
				searchType: params.searchType ?? "auto",
			},
			results: (response.results ?? [])
				.map(normalizeExaSearchResult)
				.filter((result) => result !== undefined)
				.slice(params.offset, params.offset + params.count),
			returnedQuery: params.query,
		};
	},
};
/** Build before queueing so local validation fails without consuming a request slot. */
export function prepareWebSearchRequest(
	provider: WebSearchProvider,
	params: WebSearchExecutionParams,
	apiKey: string,
	signal?: AbortSignal,
): () => Promise<NormalizedProviderResponse> {
	if (provider === "exa") {
		const request = EXA_WEB_SEARCH_ADAPTER.buildRequest(params);
		return async () => {
			const response = await EXA_WEB_SEARCH_ADAPTER.fetchJson(request, apiKey, signal);
			return EXA_WEB_SEARCH_ADAPTER.normalizeResponse(response, params);
		};
	}
	const request = BRAVE_WEB_SEARCH_ADAPTER.buildRequest(params);
	return async () => {
		const response = await BRAVE_WEB_SEARCH_ADAPTER.fetchJson(request, apiKey, signal);
		return BRAVE_WEB_SEARCH_ADAPTER.normalizeResponse(response, params);
	};
}
