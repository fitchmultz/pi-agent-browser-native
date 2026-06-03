/**
 * Purpose: Provide the optional Brave-backed `agent_browser_web_search` companion tool.
 * Responsibilities: Define strict search input schema, resolve the configured Brave credential lazily, call Brave Search with cancellation/timeout, normalize compact results, and keep secrets out of content/details.
 * Scope: Live web search only; browser automation remains in the `agent_browser` tool.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveBraveApiKey, type AgentBrowserConfigState } from "./config.js";

export const AGENT_BROWSER_WEB_SEARCH_TOOL_NAME = "agent_browser_web_search";
export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const DEFAULT_SEARCH_RESULT_COUNT = 5;
export const MAX_SEARCH_RESULT_COUNT = 10;
export const SEARCH_REQUEST_TIMEOUT_MS = 15_000;

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

export type NormalizedSearchResult = {
	title: string;
	url: string;
	description?: string;
	source?: string;
	age?: string;
	language?: string;
};

export const AgentBrowserWebSearchParams = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description: "Search query to run with Brave Search.",
		}),
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
				description: "Optional search language code, such as en or en-US.",
			}),
		),
		safesearch: Type.Optional(
			StringEnum(["off", "moderate", "strict"] as const, {
				description: "Optional Brave safe-search setting. Defaults to Brave's API default.",
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

export function normalizeSearchResult(result: BraveWebSearchResult): NormalizedSearchResult | undefined {
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

export function formatSearchResults(query: string, results: NormalizedSearchResult[]): string {
	if (results.length === 0) {
		return `No Brave web results found for: ${query}`;
	}
	const lines = [`Brave web search results for: ${query}`, ""];
	results.forEach((result, index) => {
		lines.push(`${index + 1}. ${result.title}`);
		lines.push(`   URL: ${result.url}`);
		if (result.source) lines.push(`   Source: ${result.source}`);
		if (result.age) lines.push(`   Age: ${result.age}`);
		if (result.description) lines.push(`   Summary: ${result.description}`);
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
	freshness?: "pd" | "pw" | "pm" | "py";
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

function redactSearchSecret(text: string, apiKey: string): string {
	return apiKey ? text.split(apiKey).join("[REDACTED]") : text;
}

export async function fetchBraveSearchJson(url: URL, apiKey: string, signal?: AbortSignal): Promise<BraveWebSearchResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("Brave search timed out")), SEARCH_REQUEST_TIMEOUT_MS);
	const abort = () => controller.abort(signal?.reason ?? new Error("Brave search cancelled"));
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetch(url, {
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": apiKey,
			},
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			const errorPreview = cleanSearchText(redactSearchSecret(text, apiKey), 300);
			throw new Error(`Brave search failed with HTTP ${response.status}: ${errorPreview ? redactSearchSecret(errorPreview, apiKey) : response.statusText}`);
		}
		try {
			return JSON.parse(text) as BraveWebSearchResponse;
		} catch (error) {
			throw new Error(`Brave search returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

export function createAgentBrowserWebSearchTool(configState: AgentBrowserConfigState) {
	return defineTool({
		name: AGENT_BROWSER_WEB_SEARCH_TOOL_NAME,
		label: "Agent Browser Web Search",
		description: `Search the web with Brave Search when configured. Returns up to ${MAX_SEARCH_RESULT_COUNT} concise web results.`,
		promptSnippet: "Search the live web with Brave Search for current or external web information.",
		promptGuidelines: [
			"Use agent_browser_web_search when live web search would help answer the task, find current external information, or discover candidate URLs for agent_browser.",
			"Prefer agent_browser_web_search over opening a search engine results page with agent_browser when a quick result list is enough.",
			"After using agent_browser_web_search, cite result URLs in the final answer when web evidence informed the answer.",
		],
		parameters: AgentBrowserWebSearchParams,
		async execute(_toolCallId, params, signal) {
			const resolvedCredential = await resolveBraveApiKey(configState, { signal });
			if (!resolvedCredential) {
				throw new Error("Brave Search credential source is configured but did not resolve. Run pi-agent-browser-config web-search status for setup details.");
			}
			const query = params.query.trim();
			if (!query) throw new Error("query must not be blank");
			const count = Math.min(Math.max(params.count ?? DEFAULT_SEARCH_RESULT_COUNT, 1), MAX_SEARCH_RESULT_COUNT);
			const offset = Math.max(params.offset ?? 0, 0);
			const url = buildBraveSearchUrl({
				query,
				count,
				offset,
				country: params.country,
				searchLang: params.searchLang,
				safesearch: params.safesearch,
				freshness: params.freshness,
			});
			const data = await fetchBraveSearchJson(url, resolvedCredential.value, signal);
			const results = (data.web?.results ?? [])
				.map(normalizeSearchResult)
				.filter((result): result is NormalizedSearchResult => Boolean(result));
			const returnedQuery = cleanSearchText(data.query?.altered, 300) ?? cleanSearchText(data.query?.original, 300) ?? query;
			return {
				content: [{ type: "text", text: formatSearchResults(returnedQuery, results) }],
				details: {
					provider: "brave",
					query,
					returnedQuery,
					count,
					offset,
					fetchedAt: new Date().toISOString(),
					results,
				},
			};
		},
	});
}
