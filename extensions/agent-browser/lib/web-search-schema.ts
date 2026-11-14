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
	readonly additionalQueries?: readonly string[] | undefined;
	readonly category?: ExaSearchCategory | undefined;
	readonly country?: string | undefined;
	readonly count?: number;
	readonly excludeDomains?: readonly string[] | undefined;
	readonly freshness?: SearchFreshness | undefined;
	readonly highlightsDynamic?: boolean | undefined;
	readonly includeDomains?: readonly string[] | undefined;
	readonly offset?: number;
	readonly provider?: WebSearchProviderParam;
	readonly query: string;
	readonly safesearch?: "off" | "moderate" | "strict" | undefined;
	readonly searchLang?: string | undefined;
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
				description:
					"Exa only. Hostnames, path prefixes (exa.ai/docs), or wildcard subdomains (*.substack.com) to search.",
			}),
		),
		excludeDomains: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: MAX_EXA_DOMAIN_FILTERS,
				description:
					"Exa only. Hostnames, path prefixes, or wildcard subdomains to skip; not with category company or people.",
			}),
		),
		category: Type.Optional(
			StringEnum(EXA_SEARCH_CATEGORIES, {
				description:
					"Exa only. company and people cannot combine with freshness or excludeDomains.",
			}),
		),
		additionalQueries: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: MAX_EXA_ADDITIONAL_QUERIES,
				description:
					"Exa only, with searchType deep-lite, deep, or deep-reasoning. Extra query variations.",
			}),
		),
		highlightsDynamic: Type.Optional(
			Type.Boolean({
				description: "Exa preview: share one highlight budget across results instead of per page.",
			}),
		),
	};
}

export function createAgentBrowserWebSearchParamsSchema(): TSchema {
	return Type.Object(
		{
			query: Type.String({
				minLength: 1,
				description: "Search query.",
			}),
			provider: Type.Optional(
				StringEnum(WEB_SEARCH_PROVIDER_PARAM_VALUES, {
					description: `Provider override. auto follows configured keys and preferredProvider (${DEFAULT_WEB_SEARCH_PROVIDER} when both have keys).`,
				}),
			),
			searchType: Type.Optional(
				StringEnum(EXA_SEARCH_TYPES, {
					description:
						"Exa only. Default: webSearch.defaultSearchType, else auto (~1s). instant and fast favor latency. Pass searchType: deep-lite (~4s) for research before implementation; deep (4–15s) or deep-reasoning (12–40s) only for hard multi-source work.",
				}),
			),
			...createExaFilterProperties(),
			count: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_SEARCH_RESULT_COUNT,
					description: `Results to return (default ${DEFAULT_SEARCH_RESULT_COUNT}).`,
				}),
			),
			offset: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: 9,
					description: "Pagination offset (default 0).",
				}),
			),
			country: Type.Optional(
				Type.String({
					pattern: "^[A-Za-z]{2}$",
					description: "2-letter country code, such as US.",
				}),
			),
			searchLang: Type.Optional(
				Type.String({
					minLength: 2,
					maxLength: 8,
					description: "Brave only. Language code, such as en-US.",
				}),
			),
			safesearch: Type.Optional(
				StringEnum(["off", "moderate", "strict"] as const, {
					description: "Brave safesearch; Exa maps moderate and strict to moderation.",
				}),
			),
			freshness: Type.Optional(
				StringEnum(["pd", "pw", "pm", "py"] as const, {
					description: "pd, pw, pm, py: past day, week, month, or year.",
				}),
			),
		},
		{ additionalProperties: false },
	);
}

export const AgentBrowserWebSearchParams = createAgentBrowserWebSearchParamsSchema();
