import { JsonSchema as Type, type TSchema } from "./json-schema.js";
import { StringEnum } from "./string-enum-schema.js";
import {
	DEFAULT_WEB_SEARCH_PROVIDER,
	EXA_SEARCH_TYPES,
	WEB_SEARCH_PROVIDERS,
	type ExaSearchType,
} from "./config.js";

export const DEFAULT_SEARCH_RESULT_COUNT = 5;
export const MAX_SEARCH_RESULT_COUNT = 10;
const WEB_SEARCH_PROVIDER_PARAM_VALUES = ["auto", ...WEB_SEARCH_PROVIDERS] as const;
export type WebSearchProviderParam = (typeof WEB_SEARCH_PROVIDER_PARAM_VALUES)[number];
export type SearchFreshness = "pd" | "pw" | "pm" | "py";
const EXA_SEARCH_CATEGORIES = [
	"company",
	"people",
	"publication",
	"news",
	"personal site",
	"financial report",
] as const;
export type ExaSearchCategory = (typeof EXA_SEARCH_CATEGORIES)[number];
const MAX_EXA_DOMAIN_FILTERS = 20;
const MAX_EXA_ADDITIONAL_QUERIES = 10;

export type AgentBrowserWebSearchParamsInput = {
	readonly additionalQueries?: readonly string[];
	readonly category?: ExaSearchCategory;
	readonly country?: string;
	readonly count?: number;
	readonly excludeDomains?: readonly string[];
	readonly freshness?: SearchFreshness;
	readonly highlightsDynamic?: boolean;
	readonly includeDomains?: readonly string[];
	readonly offset?: number;
	readonly provider?: WebSearchProviderParam;
	readonly query: string;
	readonly safesearch?: "off" | "moderate" | "strict";
	readonly searchLang?: string;
	readonly searchType?: ExaSearchType;
};
export type WebSearchExecutionParams = AgentBrowserWebSearchParamsInput & {
	readonly count: number;
	readonly offset: number;
};

function createExaFilterProperties(): Record<string, TSchema> {
	return {
		includeDomains: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: MAX_EXA_DOMAIN_FILTERS,
				description: `Exa only. Limit results to 1–${MAX_EXA_DOMAIN_FILTERS} hostnames, path prefixes (exa.ai/docs), or wildcard subdomains (*.substack.com).`,
			}),
		),
		excludeDomains: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: MAX_EXA_DOMAIN_FILTERS,
				description: `Exa only. Exclude 1–${MAX_EXA_DOMAIN_FILTERS} hostnames, path prefixes, or wildcard subdomains. Not compatible with category company or people.`,
			}),
		),
		category: Type.Optional(
			StringEnum(EXA_SEARCH_CATEGORIES, {
				description:
					"Exa-only result category. company and people cannot be combined with freshness or excludeDomains.",
			}),
		),
		additionalQueries: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: MAX_EXA_ADDITIONAL_QUERIES,
				description: `Exa only. Add 1–${MAX_EXA_ADDITIONAL_QUERIES} query variations when the effective searchType is deep-lite, deep, or deep-reasoning.`,
			}),
		),
		highlightsDynamic: Type.Optional(
			Type.Boolean({
				description:
					"Exa-only research preview. Allocate one highlight budget across all results; the wrapper sends the required Exa-Beta header. Regular per-page highlights remain the default.",
			}),
		),
	};
}

export function createAgentBrowserWebSearchParamsSchema(): TSchema {
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
					description:
						"Exa mode; omitted uses webSearch.defaultSearchType, then auto. instant (~250ms) is only for trivial lookups; fast (~450ms) favors latency; auto (~1s) is balanced. Pass searchType: deep-lite (~4s) for research before implementation unless config already defaults it; do not assume auto is deep enough. deep (4–15s) handles hard multi-source research; deep-reasoning (12–40s) is only for the hardest work. Brave ignores this field.",
				}),
			),
			...createExaFilterProperties(),
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
					description:
						"Optional search safety setting. Brave forwards this as safesearch; Exa maps moderate/strict to moderation=true.",
				}),
			),
			freshness: Type.Optional(
				StringEnum(["pd", "pw", "pm", "py"] as const, {
					description:
						"Optional freshness window: pd=past day, pw=past week, pm=past month, py=past year.",
				}),
			),
		},
		{ additionalProperties: false },
	);
}

export const AgentBrowserWebSearchParams = createAgentBrowserWebSearchParamsSchema();
