/**
 * Purpose: Provide the optional provider-backed `agent_browser_web_search` companion tool.
 * Responsibilities: Define strict search input schema, resolve configured Brave/Exa credentials lazily, call the selected search API with cancellation/timeout, normalize compact results, and keep secrets out of content/details.
 * Scope: Live web search only; browser automation remains in the `agent_browser` tool.
 */

import { JsonSchema, type JsonSchemaBuilder } from "./json-schema.js";
import { WEB_SEARCH_PROMPT_GUIDELINE } from "./playbook.js";
import { StringEnum as localStringEnum, type StringEnumBuilder } from "./string-enum-schema.js";
import {
	DEFAULT_WEB_SEARCH_PROVIDER,
	WEB_SEARCH_PROVIDERS,
	resolvePreferredWebSearchCredential,
	type AgentBrowserConfigState,
	type WebSearchProvider,
} from "./config.js";

export const AGENT_BROWSER_WEB_SEARCH_TOOL_NAME = "agent_browser_web_search";
export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
export const DEFAULT_SEARCH_RESULT_COUNT = 5;
export const MAX_SEARCH_RESULT_COUNT = 10;
export const SEARCH_REQUEST_TIMEOUT_MS = 15_000;
export const EXA_DEEP_SEARCH_REQUEST_TIMEOUT_MS = 45_000;
export const WEB_SEARCH_MIN_REQUEST_INTERVAL_MS = 1_100;
export const EXA_SEARCH_TYPES = ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"] as const;
export type ExaSearchType = typeof EXA_SEARCH_TYPES[number];
export const WEB_SEARCH_PROVIDER_PARAM_VALUES = ["auto", ...WEB_SEARCH_PROVIDERS] as const;
export type WebSearchProviderParam = typeof WEB_SEARCH_PROVIDER_PARAM_VALUES[number];

type SearchFreshness = "pd" | "pw" | "pm" | "py";

export type BraveWebSearchResult = {
	title?: unknown;
	url?: unknown;
	description?: unknown;
	age?: unknown;
	language?: unknown;
	profile?: {
		name?: unknown;
		url?: unknown;
	};
	meta_url?: {
		hostname?: unknown;
	};
};

export type BraveWebSearchResponse = {
	query?: {
		original?: unknown;
		altered?: unknown;
	};
	web?: {
		results?: BraveWebSearchResult[];
	};
};

export type ExaWebSearchResult = {
	title?: unknown;
	url?: unknown;
	publishedDate?: unknown;
	author?: unknown;
	text?: unknown;
	highlights?: unknown;
	summary?: unknown;
};

export type ExaWebSearchResponse = {
	requestId?: unknown;
	searchType?: unknown;
	results?: ExaWebSearchResult[];
	output?: unknown;
	costDollars?: unknown;
};

export type NormalizedSearchResult = {
	title: string;
	url: string;
	description?: string;
	highlights?: string[];
	source?: string;
	age?: string;
	language?: string;
};

type WebSearchToolDetails = {
	provider: WebSearchProvider;
	query: string;
	returnedQuery: string;
	count: number;
	offset: number;
	fetchedAt: string;
	results: NormalizedSearchResult[];
	searchType?: string;
	requestId?: string;
};

type WebSearchExecutionParams = {
	country?: string;
	count: number;
	freshness?: SearchFreshness;
	offset: number;
	query: string;
	safesearch?: "off" | "moderate" | "strict";
	searchLang?: string;
	searchType?: ExaSearchType;
};

type NormalizedProviderResponse = {
	extraDetails?: Pick<WebSearchToolDetails, "requestId" | "searchType">;
	results: NormalizedSearchResult[];
	returnedQuery: string;
};

export interface WebSearchProviderAdapter<Request = unknown, Response = unknown> {
	buildRequest(params: WebSearchExecutionParams): Request;
	fetchJson(request: Request, apiKey: string, signal?: AbortSignal): Promise<Response>;
	normalizeResponse(response: Response, params: WebSearchExecutionParams): NormalizedProviderResponse;
	provider: WebSearchProvider;
}

export function createAgentBrowserWebSearchParamsSchema(
	Type: JsonSchemaBuilder = JsonSchema,
	StringEnum: StringEnumBuilder = localStringEnum,
) {
	return Type.Object(
		{
		query: Type.String({
			minLength: 1,
			description: "Search query to run with the configured Exa or Brave web search provider.",
		}),
		provider: Type.Optional(
			StringEnum(WEB_SEARCH_PROVIDER_PARAM_VALUES, {
				description: `Optional provider override. auto uses configured keys and preferredProvider; when both Exa and Brave are available, the default preferred provider is ${DEFAULT_WEB_SEARCH_PROVIDER}.`,
			}),
		),
		searchType: Type.Optional(
			StringEnum(EXA_SEARCH_TYPES, {
				description: "Optional Exa search type. Defaults to auto; ignored by Brave. Use deep/deep-reasoning only for harder research because they are slower.",
			}),
		),
		count: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: MAX_SEARCH_RESULT_COUNT,
				description: `Number of web results to return. Defaults to ${DEFAULT_SEARCH_RESULT_COUNT}; max ${MAX_SEARCH_RESULT_COUNT}.`,
			}),
		),
		offset: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 9,
				description: "Zero-based result offset for pagination. Defaults to 0.",
			}),
		),
		country: Type.Optional(
			Type.String({
				pattern: "^[A-Za-z]{2}$",
				description: "Optional 2-letter country code, such as US or GB.",
			}),
		),
		searchLang: Type.Optional(
			Type.String({
				minLength: 2,
				maxLength: 8,
				description: "Optional Brave search language code, such as en or en-US.",
			}),
		),
		safesearch: Type.Optional(
			StringEnum(["off", "moderate", "strict"] as const, {
				description: "Optional search safety setting. Brave forwards this as safesearch; Exa maps moderate/strict to moderation=true.",
			}),
		),
		freshness: Type.Optional(
			StringEnum(["pd", "pw", "pm", "py"] as const, {
				description: "Optional freshness window: pd=past day, pw=past week, pm=past month, py=past year.",
			}),
		),
		},
		{ additionalProperties: false },
	);
}

export const AgentBrowserWebSearchParams = createAgentBrowserWebSearchParamsSchema();

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};

const HTML_TAG_NAMES_TO_STRIP = new Set([
	"a",
	"abbr",
	"address",
	"article",
	"aside",
	"audio",
	"b",
	"base",
	"blockquote",
	"body",
	"br",
	"button",
	"canvas",
	"code",
	"div",
	"em",
	"embed",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"header",
	"html",
	"i",
	"iframe",
	"img",
	"input",
	"li",
	"link",
	"main",
	"mark",
	"math",
	"meta",
	"nav",
	"object",
	"ol",
	"option",
	"p",
	"pre",
	"script",
	"section",
	"select",
	"source",
	"span",
	"strong",
	"style",
	"svg",
	"table",
	"tbody",
	"td",
	"textarea",
	"tfoot",
	"th",
	"thead",
	"tr",
	"u",
	"ul",
	"video",
]);

function decodeHtmlEntity(entity: string): string {
	const named = HTML_ENTITY_REPLACEMENTS[entity.toLowerCase()];
	if (named !== undefined) return named;
	const decimalMatch = /^#(\d+)$/.exec(entity);
	const hexMatch = /^#x([0-9a-f]+)$/i.exec(entity);
	const codePoint = decimalMatch ? Number.parseInt(decimalMatch[1] ?? "", 10) : hexMatch ? Number.parseInt(hexMatch[1] ?? "", 16) : undefined;
	if (codePoint === undefined || !Number.isFinite(codePoint)) return `&${entity};`;
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return `&${entity};`;
	}
}

export function decodeHtmlEntities(value: string): string {
	return value.replace(/&([a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);/gi, (_match, entity: string) => decodeHtmlEntity(entity));
}

function stripDecodedHtmlTags(value: string): string {
	return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<\/?([a-z][a-z0-9-]*)(\s[^>]*)?>/gi, (match, tagName: string, attributes: string | undefined) => {
		if (attributes || match.startsWith("</") || HTML_TAG_NAMES_TO_STRIP.has(tagName.toLowerCase())) return " ";
		return match;
	});
}

export function cleanSearchText(value: unknown, maxLength = 500): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = stripDecodedHtmlTags(decodeHtmlEntities(value.replace(/<[^>]*>/g, " ")))
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function normalizeSearchUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function getHostname(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

function normalizeHighlightList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const highlights = value
		.map((entry) => cleanSearchText(entry, 320))
		.filter((entry): entry is string => Boolean(entry))
		.slice(0, 3);
	return highlights.length > 0 ? highlights : undefined;
}

export function normalizeBraveSearchResult(result: BraveWebSearchResult): NormalizedSearchResult | undefined {
	const title = cleanSearchText(result.title, 180);
	const url = normalizeSearchUrl(result.url);
	if (!title || !url) return undefined;
	return {
		title,
		url,
		description: cleanSearchText(result.description, 320),
		source: cleanSearchText(result.profile?.name, 120) ?? cleanSearchText(result.meta_url?.hostname, 120),
		age: cleanSearchText(result.age, 80),
		language: cleanSearchText(result.language, 40),
	};
}

export function normalizeExaSearchResult(result: ExaWebSearchResult): NormalizedSearchResult | undefined {
	const title = cleanSearchText(result.title, 180);
	const url = normalizeSearchUrl(result.url);
	if (!title || !url) return undefined;
	const highlights = normalizeHighlightList(result.highlights);
	return {
		title,
		url,
		description: cleanSearchText(result.summary, 320) ?? highlights?.[0] ?? cleanSearchText(result.text, 320),
		highlights,
		source: cleanSearchText(result.author, 120) ?? cleanSearchText(getHostname(url), 120),
		age: cleanSearchText(result.publishedDate, 80),
	};
}

function getProviderLabel(provider: WebSearchProvider): string {
	return provider === "exa" ? "Exa" : "Brave";
}

export function formatSearchResults(provider: WebSearchProvider, query: string, results: NormalizedSearchResult[]): string {
	const providerLabel = getProviderLabel(provider);
	if (results.length === 0) {
		return `No ${providerLabel} web results found for: ${query}`;
	}
	const lines = [`${providerLabel} web search results for: ${query}`, ""];
	results.forEach((result, index) => {
		lines.push(`${index + 1}. ${result.title}`);
		lines.push(`   URL: ${result.url}`);
		if (result.source) lines.push(`   Source: ${result.source}`);
		if (result.age) lines.push(`   Age: ${result.age}`);
		if (result.description) lines.push(`   Summary: ${result.description}`);
		if (result.highlights && result.highlights.length > 1) {
			lines.push("   Highlights:");
			for (const highlight of result.highlights) lines.push(`   - ${highlight}`);
		}
		lines.push("");
	});
	return lines.join("\n").trimEnd();
}

export function buildBraveSearchUrl(params: {
	query: string;
	count: number;
	offset: number;
	country?: string;
	searchLang?: string;
	safesearch?: "off" | "moderate" | "strict";
	freshness?: SearchFreshness;
}): URL {
	const url = new URL(BRAVE_SEARCH_ENDPOINT);
	url.searchParams.set("q", params.query);
	url.searchParams.set("count", String(params.count));
	url.searchParams.set("offset", String(params.offset));
	if (params.country) url.searchParams.set("country", params.country.toUpperCase());
	if (params.searchLang) url.searchParams.set("search_lang", params.searchLang);
	if (params.safesearch) url.searchParams.set("safesearch", params.safesearch);
	if (params.freshness) url.searchParams.set("freshness", params.freshness);
	return url;
}

const FRESHNESS_DAYS: Record<SearchFreshness, number> = {
	pd: 1,
	pw: 7,
	pm: 31,
	py: 365,
};

function getStartPublishedDate(freshness: SearchFreshness | undefined, now: () => Date): string | undefined {
	if (!freshness) return undefined;
	const days = FRESHNESS_DAYS[freshness];
	return new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function buildExaSearchRequestBody(params: {
	query: string;
	count: number;
	offset: number;
	country?: string;
	safesearch?: "off" | "moderate" | "strict";
	freshness?: SearchFreshness;
	searchType?: ExaSearchType;
}, now: () => Date = () => new Date()): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: params.query,
		type: params.searchType ?? "auto",
		numResults: Math.min(params.count + params.offset, 100),
		contents: { highlights: true },
	};
	if (params.country) body.userLocation = params.country.toUpperCase();
	if (params.safesearch && params.safesearch !== "off") body.moderation = true;
	const startPublishedDate = getStartPublishedDate(params.freshness, now);
	if (startPublishedDate) body.startPublishedDate = startPublishedDate;
	return body;
}

function redactSearchSecret(text: string, apiKey: string): string {
	return apiKey ? text.split(apiKey).join("[REDACTED]") : text;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Web search cancelled"));
	return new Promise((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(signal?.reason ?? new Error("Web search cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export class WebSearchRequestGate {
	private lastRequestStartedAt = 0;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepWithAbort,
	) {}

	run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
		const runTask = async () => {
			const elapsedMs = this.lastRequestStartedAt === 0 ? WEB_SEARCH_MIN_REQUEST_INTERVAL_MS : this.now() - this.lastRequestStartedAt;
			const waitMs = Math.max(0, WEB_SEARCH_MIN_REQUEST_INTERVAL_MS - elapsedMs);
			if (waitMs > 0) await this.sleep(waitMs, signal);
			if (signal?.aborted) throw signal.reason ?? new Error("Web search cancelled");
			this.lastRequestStartedAt = this.now();
			return task();
		};
		const result = this.tail.then(runTask, runTask);
		this.tail = result.catch(() => undefined);
		return result;
	}
}

function formatSearchHttpError(provider: WebSearchProvider, status: number, statusText: string, body: string, apiKey: string): string {
	const providerLabel = getProviderLabel(provider);
	const errorPreview = cleanSearchText(redactSearchSecret(body, apiKey), 300);
	if (status === 429) {
		const preview = errorPreview ? ` Upstream details: ${redactSearchSecret(errorPreview, apiKey)}` : "";
		return `${providerLabel} search rate limit exceeded (HTTP 429). Do not issue parallel or repeated agent_browser_web_search calls; use one high-signal query, inspect those results, then wait before retrying or ask the user to adjust their ${providerLabel} API plan/limits.${preview}`;
	}
	return `${providerLabel} search failed with HTTP ${status}: ${errorPreview ? redactSearchSecret(errorPreview, apiKey) : statusText}`;
}

async function fetchSearchJson<T>(options: {
	apiKey: string;
	cancelMessage: string;
	init?: RequestInit;
	invalidJsonMessage: string;
	provider: WebSearchProvider;
	request: string | URL;
	signal?: AbortSignal;
	timeoutMessage: string;
	timeoutMs: number;
}): Promise<T> {
	if (options.signal?.aborted) {
		throw options.signal.reason ?? new Error(options.cancelMessage);
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(options.timeoutMessage)), options.timeoutMs);
	const abort = () => controller.abort(options.signal?.reason ?? new Error(options.cancelMessage));
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetch(options.request, {
			...(options.init ?? {}),
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(formatSearchHttpError(options.provider, response.status, response.statusText, text, options.apiKey));
		}
		try {
			return JSON.parse(text) as T;
		} catch (error) {
			throw new Error(`${options.invalidJsonMessage}: ${error instanceof Error ? error.message : String(error)}`);
		}
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}

export async function fetchBraveSearchJson(url: URL, apiKey: string, signal?: AbortSignal): Promise<BraveWebSearchResponse> {
	return fetchSearchJson<BraveWebSearchResponse>({
		apiKey,
		cancelMessage: "Brave search cancelled",
		init: {
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": apiKey,
			},
		},
		invalidJsonMessage: "Brave search returned invalid JSON",
		provider: "brave",
		request: url,
		signal,
		timeoutMessage: "Brave search timed out",
		timeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
	});
}

function getExaRequestTimeoutMs(searchType: ExaSearchType | undefined): number {
	return searchType?.startsWith("deep") ? EXA_DEEP_SEARCH_REQUEST_TIMEOUT_MS : SEARCH_REQUEST_TIMEOUT_MS;
}

export async function fetchExaSearchJson(body: Record<string, unknown>, apiKey: string, signal?: AbortSignal, timeoutMs = SEARCH_REQUEST_TIMEOUT_MS): Promise<ExaWebSearchResponse> {
	return fetchSearchJson<ExaWebSearchResponse>({
		apiKey,
		cancelMessage: "Exa search cancelled",
		init: {
			body: JSON.stringify(body),
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"x-api-key": apiKey,
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
}

const BRAVE_WEB_SEARCH_ADAPTER: WebSearchProviderAdapter<URL, BraveWebSearchResponse> = {
	provider: "brave",
	buildRequest(params) {
		return buildBraveSearchUrl({
			query: params.query,
			count: params.count,
			offset: params.offset,
			country: params.country,
			searchLang: params.searchLang,
			safesearch: params.safesearch,
			freshness: params.freshness,
		});
	},
	fetchJson(request, apiKey, signal) {
		return fetchBraveSearchJson(request, apiKey, signal);
	},
	normalizeResponse(response, params) {
		return {
			results: (response.web?.results ?? [])
				.map(normalizeBraveSearchResult)
				.filter((result): result is NormalizedSearchResult => Boolean(result)),
			returnedQuery: cleanSearchText(response.query?.altered, 300) ?? cleanSearchText(response.query?.original, 300) ?? params.query,
		};
	},
};

type ExaSearchRequest = {
	body: Record<string, unknown>;
	timeoutMs: number;
};

const EXA_WEB_SEARCH_ADAPTER: WebSearchProviderAdapter<ExaSearchRequest, ExaWebSearchResponse> = {
	provider: "exa",
	buildRequest(params) {
		const searchType = params.searchType ?? "auto";
		return {
			body: buildExaSearchRequestBody({
				query: params.query,
				count: params.count,
				offset: params.offset,
				country: params.country,
				safesearch: params.safesearch,
				freshness: params.freshness,
				searchType,
			}),
			timeoutMs: getExaRequestTimeoutMs(searchType),
		};
	},
	fetchJson(request, apiKey, signal) {
		return fetchExaSearchJson(request.body, apiKey, signal, request.timeoutMs);
	},
	normalizeResponse(response, params) {
		const searchType = params.searchType ?? "auto";
		return {
			extraDetails: {
				requestId: cleanSearchText(response.requestId, 120),
				searchType: cleanSearchText(response.searchType, 80) ?? searchType,
			},
			results: (response.results ?? [])
				.map(normalizeExaSearchResult)
				.filter((result): result is NormalizedSearchResult => Boolean(result))
				.slice(params.offset, params.offset + params.count),
			returnedQuery: params.query,
		};
	},
};

export const WEB_SEARCH_PROVIDER_ADAPTERS: Readonly<Record<WebSearchProvider, WebSearchProviderAdapter>> = {
	exa: EXA_WEB_SEARCH_ADAPTER,
	brave: BRAVE_WEB_SEARCH_ADAPTER,
};

export function getWebSearchProviderAdapter(provider: WebSearchProvider): WebSearchProviderAdapter {
	return WEB_SEARCH_PROVIDER_ADAPTERS[provider];
}

function buildMissingCredentialError(provider: WebSearchProviderParam): string {
	if (provider === "brave") return "agent_browser_web_search provider brave was requested but no BRAVE_API_KEY/config credential resolved.";
	if (provider === "exa") return "agent_browser_web_search provider exa was requested but no EXA_API_KEY/config credential resolved.";
	return "No Exa or Brave web search credential resolved. Configure webSearch.exaApiKey or webSearch.braveApiKey, or load EXA_API_KEY/BRAVE_API_KEY in the runtime environment.";
}

type AgentBrowserWebSearchParamsInput = {
	country?: string;
	count?: number;
	freshness?: SearchFreshness;
	offset?: number;
	provider?: WebSearchProviderParam;
	query: string;
	safesearch?: "off" | "moderate" | "strict";
	searchLang?: string;
	searchType?: ExaSearchType;
};

export function createAgentBrowserWebSearchTool(
	configState: AgentBrowserConfigState,
	options: { loadConfigState?: (ctx: { cwd: string; isProjectTrusted?: () => boolean }) => AgentBrowserConfigState } = {},
) {
	const requestGate = new WebSearchRequestGate();
	return {
		name: AGENT_BROWSER_WEB_SEARCH_TOOL_NAME,
		label: "Agent Browser Web Search",
		description: `Search the web with Exa or Brave when configured. Returns up to ${MAX_SEARCH_RESULT_COUNT} concise web results.`,
		promptSnippet: "Search the live web with Exa or Brave for current or external information.",
		promptGuidelines: [
			WEB_SEARCH_PROMPT_GUIDELINE,
			"agent_browser_web_search chooses Exa or Brave from configured keys; when both are available, Exa is preferred by default unless webSearch.preferredProvider says otherwise. Use provider only when the user/config calls for a specific provider.",
			"Prefer agent_browser_web_search over opening or typing into public search engine result pages with agent_browser when a quick result list is enough; browser-automated search forms are often anti-bot/CAPTCHA-gated, and this tool is the fallback for discovery rather than a CAPTCHA bypass.",
			"Do not issue parallel or repeated agent_browser_web_search calls; use one high-signal query, inspect the results, then only run a focused follow-up if needed. If the provider returns HTTP 429, stop searching and tell the user the API plan/rate limit needs time or a plan change.",
			"After using agent_browser_web_search, cite result URLs in the final answer when web evidence informed the answer.",
		],
		parameters: AgentBrowserWebSearchParams,
		async execute(_toolCallId: string, params: AgentBrowserWebSearchParamsInput, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd: string; isProjectTrusted?: () => boolean }) {
			const runtimeConfigState = ctx ? options.loadConfigState?.(ctx) ?? configState : configState;
			if (runtimeConfigState.errors.length > 0) {
				throw new Error(`agent_browser_web_search config is invalid: ${runtimeConfigState.errors.join("; ")}`);
			}
			if (!runtimeConfigState.webSearchEnabled) {
				throw new Error("agent_browser_web_search is disabled by pi-agent-browser-native config.");
			}
			const requestedProvider = params.provider ?? "auto";
			const resolved = await resolvePreferredWebSearchCredential(runtimeConfigState, { provider: requestedProvider, signal });
			if (!resolved) throw new Error(buildMissingCredentialError(requestedProvider));
			const query = params.query.trim();
			if (!query) throw new Error("query must not be blank");
			const count = Math.min(Math.max(params.count ?? DEFAULT_SEARCH_RESULT_COUNT, 1), MAX_SEARCH_RESULT_COUNT);
			const offset = Math.max(params.offset ?? 0, 0);
			const adapter = getWebSearchProviderAdapter(resolved.provider);
			const executionParams: WebSearchExecutionParams = {
				country: params.country,
				count,
				freshness: params.freshness,
				offset,
				query,
				safesearch: params.safesearch,
				searchLang: params.searchLang,
				searchType: params.searchType ?? "auto",
			};
			const request = adapter.buildRequest(executionParams);
			const data = await requestGate.run(signal, () => adapter.fetchJson(request, resolved.credential.value, signal));
			const normalized = adapter.normalizeResponse(data, executionParams);
			const details: WebSearchToolDetails = {
				provider: adapter.provider,
				query,
				returnedQuery: normalized.returnedQuery,
				count,
				offset,
				...normalized.extraDetails,
				fetchedAt: new Date().toISOString(),
				results: normalized.results,
			};
			return {
				content: [{ type: "text" as const, text: formatSearchResults(adapter.provider, normalized.returnedQuery, normalized.results) }],
				details,
			};
		},
	};
}
