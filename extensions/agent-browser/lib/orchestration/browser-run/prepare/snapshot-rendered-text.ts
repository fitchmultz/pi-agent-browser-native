import { isRecord } from "../../../parsing.js";
import { normalizeAccessibleName } from "../../../results/snapshot-refs.js";
import { redactSensitiveText } from "../../../runtime-redaction.js";

interface RenderedTextSearchMatch {
	readonly kind: "text" | "validation";
	readonly name?: string;
	readonly offscreen: boolean;
	readonly ref?: string;
	readonly role?: string;
	readonly tagName: string;
	readonly text: string;
}

export interface RenderedTextSearchResult {
	readonly matches: readonly RenderedTextSearchMatch[];
	readonly totalMatches: number;
	readonly truncated: boolean;
}

const RENDERED_TEXT_SEARCH_MAX_MATCHES = 8;

export function buildRenderedTextSearchEval(search: string): string {
	return `(() => {
  const query = ${JSON.stringify(search.trim().toLowerCase())};
  const limit = ${RENDERED_TEXT_SEARCH_MAX_MATCHES};
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const attributeTextOf = (element) => [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("placeholder")].filter(Boolean).join(" ");
  const searchableTextOf = (element) => normalize([attributeTextOf(element), element.textContent].filter(Boolean).join(" "));
  const renderedTextOf = (element) => normalize([attributeTextOf(element), element instanceof HTMLElement ? element.innerText : element.textContent].filter(Boolean).join(" "));
  const isRendered = (element) => {
    if (!(element instanceof Element) || element.getClientRects().length === 0) return false;
    const visibility = getComputedStyle(element).visibility;
    if (visibility === "hidden" || visibility === "collapse") return false;
    for (let current = element; current; current = current.parentElement) {
      if (Number(getComputedStyle(current).opacity) === 0) return false;
    }
    return true;
  };
  const validationPattern = /(?:^|[-_\\s])(?:error|invalid|validation|warning)(?:$|[-_\\s])/i;
  const validationAncestor = (element) => {
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      const role = current.getAttribute("role");
      const live = current.getAttribute("aria-live");
      const descriptor = [current.id, current.className, current.getAttribute("data-testid")].map(normalize).join(" ");
      if (["alert", "alertdialog", "status"].includes(role || "") || current.getAttribute("aria-invalid") === "true" || (live && live !== "off") || validationPattern.test(descriptor)) return current;
    }
    return null;
  };
  const candidates = Array.from(document.querySelectorAll("body *")).filter((element) => searchableTextOf(element).toLowerCase().includes(query));
  const candidateSet = new Set(candidates);
  const minimal = candidates.filter((element) => !Array.from(element.children).some((child) => candidateSet.has(child)));
  const rendered = minimal.filter((element) => isRendered(element) && renderedTextOf(element).toLowerCase().includes(query));
  const matches = rendered.map((element, index) => {
    const semantic = validationAncestor(element);
    const source = semantic || element;
    const text = renderedTextOf(element);
    const matchIndex = text.toLowerCase().indexOf(query);
    const start = Math.max(0, matchIndex - 80);
    const snippet = text.slice(start, start + 240);
    const rect = element.getBoundingClientRect();
    const name = normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder")) || undefined;
    return {
      index,
      kind: semantic ? "validation" : "text",
      name,
      offscreen: rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth,
      role: source.getAttribute("role") || undefined,
      tagName: element.tagName.toLowerCase(),
      text: snippet,
    };
  }).sort((left, right) => (left.kind === right.kind ? left.index - right.index : left.kind === "validation" ? -1 : 1));
  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    const key = [match.kind, match.role, match.name, match.text].join("\\n");
    if (seen.has(key)) continue;
    seen.add(key);
    const { index, ...visible } = match;
    unique.push(visible);
  }
  return { matches: unique.slice(0, limit), totalMatches: unique.length, truncated: unique.length > limit };
})()`;
}

export function extractRenderedTextSearchResult(
	data: unknown,
): RenderedTextSearchResult | undefined {
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	if (!isRecord(result) || !Array.isArray(result.matches)) {
		return undefined;
	}
	const matches = result.matches
		.flatMap((value): RenderedTextSearchMatch[] => {
			if (
				!isRecord(value) ||
				(value.kind !== "text" && value.kind !== "validation") ||
				typeof value.offscreen !== "boolean" ||
				typeof value.tagName !== "string" ||
				typeof value.text !== "string"
			) {
				return [];
			}
			return [
				{
					kind: value.kind,
					...(typeof value.name === "string" ? { name: redactSensitiveText(value.name) } : {}),
					offscreen: value.offscreen,
					...(typeof value.role === "string" ? { role: value.role } : {}),
					tagName: value.tagName,
					text: redactSensitiveText(value.text),
				},
			];
		})
		.slice(0, RENDERED_TEXT_SEARCH_MAX_MATCHES);
	const totalMatches =
		typeof result.totalMatches === "number" &&
		Number.isInteger(result.totalMatches) &&
		result.totalMatches >= matches.length
			? result.totalMatches
			: matches.length;
	return {
		matches,
		totalMatches,
		truncated: result.truncated === true || totalMatches > matches.length,
	};
}

export function attachRenderedTextMatchRefs(
	matches: readonly RenderedTextSearchMatch[],
	snapshotData: unknown,
): RenderedTextSearchMatch[] {
	if (!isRecord(snapshotData) || !isRecord(snapshotData.refs)) {
		return [...matches];
	}
	const refs = snapshotData.refs;
	return matches.map((match) => {
		if (match.name === undefined || match.name === "") {
			return match;
		}
		const normalizedName = normalizeAccessibleName(match.name);
		const candidates = Object.entries(refs).filter(([, value]) => {
			if (!isRecord(value) || typeof value.name !== "string") {
				return false;
			}
			const nameMatches = normalizeAccessibleName(value.name) === normalizedName;
			return (
				nameMatches &&
				(match.role === undefined ||
					match.role === "" ||
					typeof value.role !== "string" ||
					value.role.toLowerCase() === match.role.toLowerCase())
			);
		});
		return candidates.length === 1 ? { ...match, ref: candidates[0][0] } : match;
	});
}

export function formatRenderedTextSearchMatches(
	result: RenderedTextSearchResult | undefined,
): string | undefined {
	if (!result || result.matches.length === 0) {
		return undefined;
	}
	const lines = result.matches.map((match) => {
		const context = [
			match.kind === "validation" ? "validation" : undefined,
			match.offscreen ? "outside viewport" : undefined,
			match.role,
			match.tagName,
			match.ref !== undefined && match.ref !== "" ? `@${match.ref}` : undefined,
		]
			.filter(Boolean)
			.join(", ");
		return `- ${JSON.stringify(match.text)}${context !== "" ? ` (${context})` : ""}`;
	});
	if (result.truncated) {
		lines.push(
			`- ... (${result.totalMatches - result.matches.length} additional rendered-text matches omitted)`,
		);
	}
	return ["Rendered page text matches:", ...lines].join("\n");
}
