import { isRecord } from "./parsing.js";
import type { WebSearchProvider } from "./config.js";

export type BraveWebSearchResult = {
	readonly title?: unknown;
	readonly url?: unknown;
	readonly description?: unknown;
	readonly age?: unknown;
	readonly page_age?: unknown;
	readonly language?: unknown;
	readonly profile?: { readonly name?: unknown; readonly url?: unknown } | null;
	readonly meta_url?: { readonly hostname?: unknown } | null;
};
export type BraveWebSearchResponse = {
	readonly query?: { readonly original?: unknown; readonly altered?: unknown } | null;
	readonly web?: { readonly results?: readonly BraveWebSearchResult[] | null } | null;
};
export type ExaWebSearchResult = {
	readonly title?: unknown;
	readonly url?: unknown;
	readonly publishedDate?: unknown;
	readonly author?: unknown;
	readonly text?: unknown;
	readonly highlights?: unknown;
	readonly summary?: unknown;
};
export type ExaWebSearchResponse = {
	readonly requestId?: unknown;
	readonly results?: readonly ExaWebSearchResult[] | null;
	readonly output?: unknown;
	readonly costDollars?: unknown;
};
export type NormalizedSearchResult = {
	readonly title: string;
	readonly url: string;
	readonly description?: string | undefined;
	readonly highlights?: readonly string[] | undefined;
	readonly source?: string | undefined;
	readonly age?: string | undefined;
	readonly pageDate?: string;
	readonly language?: string | undefined;
};

const HTML_ENTITY_REPLACEMENTS: Readonly<Partial<Record<string, string>>> = {
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
	if (named !== undefined) {
		return named;
	}
	const decimalMatch = /^#(\d+)$/.exec(entity)?.[1];
	const hexMatch = /^#x([0-9a-f]+)$/i.exec(entity)?.[1];
	let codePoint: number | undefined;
	if (decimalMatch !== undefined) {
		codePoint = Number.parseInt(decimalMatch, 10);
	} else if (hexMatch !== undefined) {
		codePoint = Number.parseInt(hexMatch, 16);
	}
	if (codePoint === undefined || !Number.isFinite(codePoint)) {
		return `&${entity};`;
	}
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return `&${entity};`;
	}
}

export function decodeHtmlEntities(value: string): string {
	return value.replace(/&([a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);/gi, (_match, entity: string) =>
		decodeHtmlEntity(entity),
	);
}

function stripDecodedHtmlTags(value: string): string {
	return value
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(
			/<\/?([a-z][a-z0-9-]*)(\s[^>]*)?>/gi,
			(match: string, tagName: string, attributes: string | undefined) => {
				if (
					(attributes !== undefined && attributes.length > 0) ||
					match.startsWith("</") ||
					HTML_TAG_NAMES_TO_STRIP.has(tagName.toLowerCase())
				) {
					return " ";
				}
				return match;
			},
		);
}

export function cleanSearchText(value: unknown, maxLength = 500): string | undefined {
	if (typeof value !== "string") {
		return;
	}
	const cleaned = stripDecodedHtmlTags(decodeHtmlEntities(value.replace(/<[^>]*>/g, " ")))
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length === 0) {
		return;
	}
	if (cleaned.length <= maxLength) {
		return cleaned;
	}
	return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeSearchUrl(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return;
	}
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return;
		}
		return url.toString();
	} catch {
		return;
	}
}

function getHostname(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return;
	}
}

function normalizeHighlightList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return;
	}
	const highlights = value
		.map((entry: unknown) => cleanSearchText(entry, 320))
		.filter((entry) => entry !== undefined)
		.slice(0, 3);
	return highlights.length > 0 ? highlights : undefined;
}

export function normalizeBraveSearchResult(
	result: BraveWebSearchResult,
): NormalizedSearchResult | undefined {
	const title = cleanSearchText(result.title, 180);
	const url = normalizeSearchUrl(result.url);
	if (title === undefined || url === undefined) {
		return;
	}
	const pageDate = cleanSearchText(result.page_age, 80);
	return {
		title,
		url,
		description: cleanSearchText(result.description, 320),
		source:
			cleanSearchText(result.profile?.name, 120) ?? cleanSearchText(result.meta_url?.hostname, 120),
		age: cleanSearchText(result.age, 80),
		...(pageDate !== undefined ? { pageDate } : {}),
		language: cleanSearchText(result.language, 40),
	};
}

export function normalizeExaSearchResult(
	result: ExaWebSearchResult,
): NormalizedSearchResult | undefined {
	const title = cleanSearchText(result.title, 180);
	const url = normalizeSearchUrl(result.url);
	if (title === undefined || url === undefined) {
		return;
	}
	const highlights = normalizeHighlightList(result.highlights);
	const pageDate = cleanSearchText(result.publishedDate, 80);
	return {
		title,
		url,
		description:
			cleanSearchText(result.summary, 320) ?? highlights?.[0] ?? cleanSearchText(result.text, 320),
		highlights,
		source: cleanSearchText(result.author, 120) ?? cleanSearchText(getHostname(url), 120),
		...(pageDate !== undefined ? { pageDate } : {}),
	};
}

export function getProviderLabel(provider: WebSearchProvider): string {
	return provider === "exa" ? "Exa" : "Brave";
}

function formatResultLines(
	result: NormalizedSearchResult,
	index: number,
	provider: WebSearchProvider,
): string[] {
	const lines = [`${index + 1}. ${result.title}`, `   URL: ${result.url}`];
	if (result.source !== undefined) {
		lines.push(`   Source: ${result.source}`);
	}
	if (result.pageDate !== undefined) {
		lines.push(`   ${provider === "exa" ? "Published" : "Page date"}: ${result.pageDate}`);
	}
	if (result.age !== undefined) {
		lines.push(`   Age: ${result.age}`);
	}
	if (result.description !== undefined) {
		lines.push(`   Summary: ${result.description}`);
	}
	if (result.highlights && result.highlights.length > 1) {
		lines.push("   Highlights:", ...result.highlights.map((highlight) => `   - ${highlight}`));
	}
	lines.push("");
	return lines;
}

export function formatSearchResults(
	provider: WebSearchProvider,
	query: string,
	results: readonly NormalizedSearchResult[],
): string {
	const providerLabel = getProviderLabel(provider);
	if (results.length === 0) {
		return `No ${providerLabel} web results found for: ${query}`;
	}
	return [
		`${providerLabel} web search results for: ${query}`,
		"",
		...results.flatMap((result, index) => formatResultLines(result, index, provider)),
	]
		.join("\n")
		.trimEnd();
}

export function dedupeSearchResults(
	results: readonly NormalizedSearchResult[],
): NormalizedSearchResult[] {
	const seen = new Set<string>();
	return results.filter((result) => {
		if (seen.has(result.url)) {
			return false;
		}
		seen.add(result.url);
		return true;
	});
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return isRecord(value) && !Array.isArray(value);
}

function isOptionalRecord(
	value: unknown,
): value is Readonly<Record<string, unknown>> | null | undefined {
	return value === undefined || value === null || isJsonObject(value);
}

function isBraveSearchResult(value: unknown): value is BraveWebSearchResult {
	return isJsonObject(value) && isOptionalRecord(value.profile) && isOptionalRecord(value.meta_url);
}

function isBraveSearchResponse(value: unknown): value is BraveWebSearchResponse {
	if (!isJsonObject(value) || !isOptionalRecord(value.query) || !isOptionalRecord(value.web)) {
		return false;
	}
	const results = value.web?.results;
	return (
		results === undefined ||
		results === null ||
		(Array.isArray(results) && results.every(isBraveSearchResult))
	);
}

function isExaSearchResponse(value: unknown): value is ExaWebSearchResponse {
	if (!isJsonObject(value)) {
		return false;
	}
	const results = value.results;
	return (
		results === undefined ||
		results === null ||
		(Array.isArray(results) && results.every((result: unknown) => isJsonObject(result)))
	);
}

/** Validate every consumed container while retaining extension fields and loose leaf values. */
export function parseBraveSearchResponse(value: unknown): BraveWebSearchResponse {
	if (!isBraveSearchResponse(value)) {
		throw new Error("Brave search response has invalid result structure");
	}
	return value;
}

export function parseExaSearchResponse(value: unknown): ExaWebSearchResponse {
	if (!isExaSearchResponse(value)) {
		throw new Error("Exa search response has invalid result structure");
	}
	return value;
}
