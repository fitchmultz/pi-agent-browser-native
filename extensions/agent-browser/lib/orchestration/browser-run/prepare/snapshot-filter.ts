import { isRecord } from "../../../parsing.js";
import { buildAgentBrowserResultCategoryDetails } from "../../../results/categories.js";
import { buildSnapshotPresentation } from "../../../results/snapshot.js";
import { extractRefSnapshotFromData, type SessionRefSnapshot } from "../../../session-page-state.js";
import { redactSensitiveText, type CompatibilityWorkaround } from "../../../runtime.js";
import { collectScrollPositionSnapshot } from "../diagnostics.js";
import { buildSessionDetailFields, runSessionCommandData } from "../session-state.js";
import type { SessionArtifactManifest } from "../../../results/contracts.js";
import type { PersistentSessionArtifactStore } from "../../../temp.js";
import type { AgentBrowserToolResult, BrowserRunOptions } from "../types.js";

export interface SnapshotFilterResult {
	artifactManifest?: SessionArtifactManifest;
	result: AgentBrowserToolResult;
}

interface SnapshotFilterRequest {
	cleanArgs: string[];
	diff?: boolean;
	role?: string;
	search?: string;
	viewport?: boolean;
}

function parseSnapshotFilterRequest(commandTokens: string[]): SnapshotFilterRequest | undefined {
	if (commandTokens[0] !== "snapshot") return undefined;
	const cleanArgs: string[] = [];
	let role: string | undefined;
	let search: string | undefined;
	for (let index = 0; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--viewport") continue;
		if (token === "--diff") continue;
		if (token === "--search") {
			const value = commandTokens[index + 1];
			if (typeof value === "string" && !value.startsWith("-")) {
				search = value;
				index += 1;
				continue;
			}
		}
		if (token === "--filter") {
			const value = commandTokens[index + 1];
			if (typeof value === "string" && !value.startsWith("-")) {
				const roleMatch = /^role=(.+)$/i.exec(value.trim());
				if (roleMatch?.[1]) role = roleMatch[1].trim().toLowerCase();
				index += 1;
				continue;
			}
		}
		cleanArgs.push(token);
	}
	const viewport = commandTokens.includes("--viewport");
	const diff = commandTokens.includes("--diff");
	if (!search && !role && !viewport && !diff) return undefined;
	return { cleanArgs, diff, role, search, viewport };
}

interface RenderedTextSearchMatch {
	kind: "text" | "validation";
	name?: string;
	offscreen: boolean;
	ref?: string;
	role?: string;
	tagName: string;
	text: string;
}

interface RenderedTextSearchResult {
	matches: RenderedTextSearchMatch[];
	totalMatches: number;
	truncated: boolean;
}

const RENDERED_TEXT_SEARCH_MAX_MATCHES = 8;

function buildRenderedTextSearchEval(search: string): string {
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

function extractRenderedTextSearchResult(data: unknown): RenderedTextSearchResult | undefined {
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	if (!isRecord(result) || !Array.isArray(result.matches)) return undefined;
	const matches = result.matches.flatMap((value): RenderedTextSearchMatch[] => {
		if (!isRecord(value) || (value.kind !== "text" && value.kind !== "validation") || typeof value.offscreen !== "boolean" || typeof value.tagName !== "string" || typeof value.text !== "string") return [];
		return [{
			kind: value.kind,
			...(typeof value.name === "string" ? { name: redactSensitiveText(value.name) } : {}),
			offscreen: value.offscreen,
			...(typeof value.role === "string" ? { role: value.role } : {}),
			tagName: value.tagName,
			text: redactSensitiveText(value.text),
		}];
	}).slice(0, RENDERED_TEXT_SEARCH_MAX_MATCHES);
	const totalMatches = typeof result.totalMatches === "number" && Number.isInteger(result.totalMatches) && result.totalMatches >= matches.length ? result.totalMatches : matches.length;
	return { matches, totalMatches, truncated: result.truncated === true || totalMatches > matches.length };
}

function attachRenderedTextMatchRefs(matches: RenderedTextSearchMatch[], snapshotData: unknown): RenderedTextSearchMatch[] {
	if (!isRecord(snapshotData) || !isRecord(snapshotData.refs)) return matches;
	const refs = snapshotData.refs;
	return matches.map((match) => {
		if (!match.name) return match;
		const normalizedName = match.name.replace(/\s+/g, " ").trim().toLowerCase();
		const candidates = Object.entries(refs).filter(([, value]) => {
			if (!isRecord(value) || typeof value.name !== "string") return false;
			const nameMatches = value.name.replace(/\s+/g, " ").trim().toLowerCase() === normalizedName;
			return nameMatches && (!match.role || typeof value.role !== "string" || value.role.toLowerCase() === match.role.toLowerCase());
		});
		return candidates.length === 1 ? { ...match, ref: candidates[0][0] } : match;
	});
}

function formatRenderedTextSearchMatches(result: RenderedTextSearchResult | undefined): string | undefined {
	if (!result || result.matches.length === 0) return undefined;
	const lines = result.matches.map((match) => {
		const context = [match.kind === "validation" ? "validation" : undefined, match.offscreen ? "outside viewport" : undefined, match.role, match.tagName, match.ref ? `@${match.ref}` : undefined].filter(Boolean).join(", ");
		return `- ${JSON.stringify(match.text)}${context ? ` (${context})` : ""}`;
	});
	if (result.truncated) lines.push(`- ... (${result.totalMatches - result.matches.length} additional rendered-text matches omitted)`);
	return ["Rendered page text matches:", ...lines].join("\n");
}

interface SnapshotDiffSummary {
	addedRefs: string[];
	changedRefs: string[];
	removedRefs: string[];
	summary: string;
	unchangedRefs: number;
}

function buildSnapshotDiff(previous: SessionRefSnapshot | undefined, current: SessionRefSnapshot | undefined): SnapshotDiffSummary | undefined {
	if (!current) return undefined;
	const currentRefs = current.refs ?? {};
	const previousRefs = previous?.refs ?? {};
	if (!previous) return { addedRefs: Object.keys(currentRefs), changedRefs: [], removedRefs: [], summary: `Snapshot diff: no previous snapshot; ${Object.keys(currentRefs).length} current refs recorded.`, unchangedRefs: 0 };
	const addedRefs: string[] = [];
	const removedRefs: string[] = [];
	const changedRefs: string[] = [];
	let unchangedRefs = 0;
	for (const refId of Object.keys(currentRefs)) {
		const currentRef = currentRefs[refId];
		const previousRef = previousRefs[refId];
		if (!previousRef) {
			addedRefs.push(refId);
			continue;
		}
		if (previousRef.role !== currentRef.role || previousRef.name !== currentRef.name) changedRefs.push(refId);
		else unchangedRefs += 1;
	}
	for (const refId of Object.keys(previousRefs)) if (!currentRefs[refId]) removedRefs.push(refId);
	return { addedRefs, changedRefs, removedRefs, summary: `Snapshot diff: +${addedRefs.length} / -${removedRefs.length} / Δ${changedRefs.length} refs versus previous snapshot.`, unchangedRefs };
}

function filterSnapshotData(data: unknown, request: SnapshotFilterRequest): { data: Record<string, unknown>; matchedRefs: number; totalRefs: number; totalLines: number; visibleLines: number } | undefined {
	if (!isRecord(data)) return undefined;
	const refs = isRecord(data.refs) ? data.refs : {};
	const snapshot = typeof data.snapshot === "string" ? data.snapshot : "";
	const normalizedSearch = request.search?.trim().toLowerCase();
	const matchingRefIds = new Set<string>();
	for (const [refId, refValue] of Object.entries(refs)) {
		if (!isRecord(refValue)) continue;
		const role = typeof refValue.role === "string" ? refValue.role.toLowerCase() : "";
		const name = typeof refValue.name === "string" ? refValue.name : "";
		const roleMatches = request.role ? role === request.role : true;
		const searchMatches = normalizedSearch ? `${role} ${name}`.toLowerCase().includes(normalizedSearch) : true;
		if (roleMatches && searchMatches) matchingRefIds.add(refId);
	}
	const lines = snapshot.split(/\r?\n/);
	const visibleLines = lines.filter((line) => {
		const normalizedLine = line.toLowerCase();
		if (normalizedSearch && normalizedLine.includes(normalizedSearch)) return true;
		return [...matchingRefIds].some((refId) => line.includes(`[ref=${refId}]`) || line.includes(`ref=${refId}`));
	});
	const filteredRefs = Object.fromEntries(Object.entries(refs).filter(([refId]) => matchingRefIds.has(refId)));
	const description = [request.role ? `role=${request.role}` : undefined, request.search ? `search=${JSON.stringify(request.search)}` : undefined].filter((part): part is string => part !== undefined).join(", ");
	const filteredSnapshot = visibleLines.length > 0 ? visibleLines.join("\n") : `(no snapshot lines matched ${description})`;
	return {
		data: { ...data, refs: filteredRefs, snapshot: filteredSnapshot },
		matchedRefs: Object.keys(filteredRefs).length,
		totalRefs: Object.keys(refs).length,
		totalLines: lines.filter((line) => line.length > 0).length,
		visibleLines: visibleLines.length,
	};
}

export async function trySnapshotFilter(options: {
	artifactManifest?: SessionArtifactManifest;
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	managedSessionRestoreDisabled: () => boolean;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	redactedArgs: string[];
	previousRefSnapshot?: SessionRefSnapshot;
	sessionMode: "auto" | "fresh";
	namespace?: string;
	sessionName?: string;
	sessionStateKey?: string;
	sessionPageState: BrowserRunOptions["state"]["sessionPageState"];
	sessionPageStateUpdate: ReturnType<BrowserRunOptions["state"]["sessionPageState"]["beginUpdate"]>;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<SnapshotFilterResult | undefined> {
	const request = parseSnapshotFilterRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	const snapshotData = await runSessionCommandData({ args: request.cleanArgs, cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal });
	const filtered = request.role || request.search ? filterSnapshotData(snapshotData, request) : isRecord(snapshotData) ? { data: snapshotData, matchedRefs: isRecord(snapshotData.refs) ? Object.keys(snapshotData.refs).length : 0, totalLines: typeof snapshotData.snapshot === "string" ? snapshotData.snapshot.split(/\r?\n/).filter((line) => line.length > 0).length : 0, totalRefs: isRecord(snapshotData.refs) ? Object.keys(snapshotData.refs).length : 0, visibleLines: typeof snapshotData.snapshot === "string" ? snapshotData.snapshot.split(/\r?\n/).filter((line) => line.length > 0).length : 0 } : undefined;
	if (!filtered) return undefined;
	const renderedTextSearch = request.search
		? extractRenderedTextSearchResult(await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal, stdin: buildRenderedTextSearchEval(request.search) }))
		: undefined;
	if (renderedTextSearch) renderedTextSearch.matches = attachRenderedTextMatchRefs(renderedTextSearch.matches, snapshotData);
	const viewport = request.viewport ? await collectScrollPositionSnapshot({ cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal }) : undefined;
	const fullSnapshot = extractRefSnapshotFromData(snapshotData);
	const diff = request.diff ? buildSnapshotDiff(options.previousRefSnapshot, fullSnapshot) : undefined;
	if (fullSnapshot) options.sessionPageState.applyRefSnapshot({ sessionName: options.sessionStateKey ?? options.sessionName, snapshot: fullSnapshot, update: options.sessionPageStateUpdate });
	const presentation = await buildSnapshotPresentation(filtered.data, options.persistentArtifactStore, options.artifactManifest);
	const summary = request.role || request.search
		? `Snapshot filter: ${filtered.matchedRefs}/${filtered.totalRefs} direct refs matched${request.role ? ` role=${request.role}` : ""}${request.search ? ` search ${JSON.stringify(request.search)}` : ""}; ${filtered.visibleLines} surrounding snapshot line${filtered.visibleLines === 1 ? "" : "s"} shown.`
		: request.diff
			? diff?.summary ?? "Snapshot diff unavailable."
			: "Snapshot viewport metadata collected.";
	const viewportText = viewport ? `Viewport: ${viewport.innerWidth}×${viewport.innerHeight}, scroll ${viewport.scrollX},${viewport.scrollY}, document ${viewport.scrollWidth}×${viewport.scrollHeight}, sampled scroll containers ${viewport.containers.length}/${viewport.containerCount}.` : undefined;
	const diffText = diff && (request.role || request.search) ? diff.summary : undefined;
	const renderedTextSearchText = formatRenderedTextSearchMatches(renderedTextSearch);
	const prefix = [summary, renderedTextSearchText, diffText, viewportText].filter((line): line is string => line !== undefined).join("\n\n");
	if (presentation.content[0]?.type === "text") presentation.content[0] = { ...presentation.content[0], text: `${prefix}\n\n${presentation.content[0].text}` };
	return {
		artifactManifest: presentation.artifactManifest,
		result: {
			content: presentation.content,
			details: {
				args: options.redactedArgs,
				artifactManifest: presentation.artifactManifest,
				artifactRetentionSummary: presentation.artifactRetentionSummary,
				command: "snapshot",
				compatibilityWorkaround: options.compatibilityWorkaround,
				data: presentation.data,
				effectiveArgs: options.effectiveArgs,
				fullOutputPath: presentation.fullOutputPath,
				fullOutputPaths: presentation.fullOutputPaths,
				refSnapshot: fullSnapshot,
				sessionMode: options.sessionMode,
				snapshotDiff: diff,
				snapshotFilter: request.role || request.search ? { cleanArgs: request.cleanArgs, matchedRefs: filtered.matchedRefs, renderedTextMatches: renderedTextSearch?.matches, renderedTextTotalMatches: renderedTextSearch?.totalMatches, renderedTextTruncated: renderedTextSearch?.truncated, role: request.role, search: request.search, totalLines: filtered.totalLines, totalRefs: filtered.totalRefs, visibleLines: filtered.visibleLines } : undefined,
				snapshotViewport: viewport,
				...buildAgentBrowserResultCategoryDetails({ args: options.effectiveArgs, command: "snapshot", succeeded: true }),
				...buildSessionDetailFields(options.sessionName, options.usedImplicitSession, options.namespace, options.managedSessionRestoreDisabled()),
				summary,
			},
			isError: false,
		},
	};
}
