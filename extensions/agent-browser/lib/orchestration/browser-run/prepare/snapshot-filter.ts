import { buildAgentBrowserResultCategoryDetails } from "../../../results/categories.js";
import { buildSnapshotPresentation } from "../../../results/snapshot.js";
import {
	extractRefSnapshotFromData,
	type SessionRefSnapshot,
} from "../../../session-page-state.js";
import { redactSensitiveValue } from "../../../runtime-redaction.js";
import type { CompatibilityWorkaround } from "../../../runtime-contracts.js";
import { collectScrollPositionSnapshot } from "../interaction-diagnostics.js";
import { buildSessionDetailFields, runSessionCommandData } from "../session-state.js";
import type { SessionArtifactManifest, ToolPresentation } from "../../../results/contracts.js";
import type { ToolPresentationObservation } from "../../../results/presentation/observation-contracts.js";
import type { PersistentSessionArtifactStore } from "../../../temp.js";
import type { AgentBrowserToolResult, BrowserRunOptions } from "../types.js";
import type { ScrollPositionSnapshot } from "../observation-types.js";
import {
	attachRenderedTextMatchRefs,
	buildRenderedTextSearchEval,
	extractRenderedTextSearchResult,
	formatRenderedTextSearchMatches,
	type RenderedTextSearchResult,
} from "./snapshot-rendered-text.js";
import {
	buildSnapshotDiff,
	filterSnapshotData,
	hasSnapshotText,
	parseSnapshotFilterRequest,
	type FilteredSnapshot,
	type SnapshotDiffSummary,
	type SnapshotFilterRequest,
} from "./snapshot-filter-data.js";

export interface SnapshotFilterResult {
	readonly artifactManifest?: SessionArtifactManifest;
	readonly result: AgentBrowserToolResult;
}

interface SnapshotReadOptions {
	readonly cwd: string;
	readonly namespace?: string;
	readonly sessionName?: string;
	readonly signal?: AbortSignal;
}

interface SnapshotFilterOptions extends SnapshotReadOptions {
	readonly modelVisible?: boolean;
	readonly artifactManifest?: SessionArtifactManifest;
	readonly commandTokens: readonly string[];
	readonly compatibilityWorkaround?: CompatibilityWorkaround;
	readonly effectiveArgs: readonly string[];
	readonly managedSessionRestoreDisabled: () => boolean;
	readonly persistentArtifactStore?: PersistentSessionArtifactStore;
	readonly redactedArgs: readonly string[];
	readonly previousRefSnapshot?: SessionRefSnapshot;
	readonly sessionMode: "auto" | "fresh";
	readonly sessionStateKey?: string;
	readonly sessionPageState: BrowserRunOptions["state"]["sessionPageState"];
	readonly sessionPageStateUpdate: BrowserRunOptions["sessionPageStateUpdate"];
	readonly usedImplicitSession: boolean;
}

interface SnapshotFilterEvidence {
	readonly filtered: FilteredSnapshot;
	readonly fullSnapshot?: SessionRefSnapshot;
	readonly diff?: SnapshotDiffSummary;
	readonly renderedTextSearch?: RenderedTextSearchResult;
	readonly viewport?: ScrollPositionSnapshot;
}

async function collectRenderedText(
	options: SnapshotReadOptions,
	request: SnapshotFilterRequest,
	snapshotData: unknown,
): Promise<RenderedTextSearchResult | undefined> {
	if (!hasSnapshotText(request.search)) {
		return undefined;
	}
	const data = await runSessionCommandData({
		...options,
		args: ["eval", "--stdin"],
		stdin: buildRenderedTextSearchEval(request.search),
	});
	const result = extractRenderedTextSearchResult(data);
	return result
		? { ...result, matches: attachRenderedTextMatchRefs(result.matches, snapshotData) }
		: undefined;
}

async function collectSnapshotEvidence(
	options: SnapshotFilterOptions & { readonly sessionName: string },
	request: SnapshotFilterRequest,
): Promise<SnapshotFilterEvidence | undefined> {
	const snapshotData = await runSessionCommandData({
		args: request.cleanArgs,
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
	});
	const filtered = filterSnapshotData(snapshotData, request);
	if (!filtered) {
		return undefined;
	}
	const renderedTextSearch = await collectRenderedText(
		{
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: options.signal,
		},
		request,
		snapshotData,
	);
	const viewport = request.viewport
		? await collectScrollPositionSnapshot({
				cwd: options.cwd,
				namespace: options.namespace,
				sessionName: options.sessionName,
				signal: options.signal,
			})
		: undefined;
	const fullSnapshot = extractRefSnapshotFromData(snapshotData);
	const diff = request.diff
		? buildSnapshotDiff(options.previousRefSnapshot, fullSnapshot)
		: undefined;
	if (fullSnapshot) {
		if (fullSnapshot.target) {
			options.sessionPageState.applyTabTarget({
				sessionName: options.sessionStateKey ?? options.sessionName,
				target: fullSnapshot.target,
				update: options.sessionPageStateUpdate,
			});
		}
		options.sessionPageState.applyRefSnapshot({
			sessionName: options.sessionStateKey ?? options.sessionName,
			snapshot: fullSnapshot,
			update: options.sessionPageStateUpdate,
		});
	}
	return { filtered, renderedTextSearch, viewport, fullSnapshot, diff };
}

function snapshotFilterSummary(
	request: SnapshotFilterRequest,
	evidence: SnapshotFilterEvidence,
): string {
	if (hasSnapshotText(request.role) || hasSnapshotText(request.search)) {
		const role = hasSnapshotText(request.role) ? ` role=${request.role}` : "";
		const search = hasSnapshotText(request.search)
			? ` search ${JSON.stringify(request.search)}`
			: "";
		return `Snapshot filter: ${evidence.filtered.matchedRefs}/${evidence.filtered.totalRefs} direct refs matched${role}${search}; ${evidence.filtered.visibleLines} surrounding snapshot line${evidence.filtered.visibleLines === 1 ? "" : "s"} shown.`;
	}
	return request.diff
		? (evidence.diff?.summary ?? "Snapshot diff unavailable.")
		: "Snapshot viewport metadata collected.";
}

function viewportText(viewport: ScrollPositionSnapshot | undefined): string | undefined {
	return viewport
		? `Viewport: ${viewport.innerWidth}×${viewport.innerHeight}, scroll ${viewport.scrollX},${viewport.scrollY}, document ${viewport.scrollWidth}×${viewport.scrollHeight}, sampled scroll containers ${viewport.containers.length}/${viewport.containerCount}.`
		: undefined;
}

function snapshotPrefix(
	request: SnapshotFilterRequest,
	evidence: SnapshotFilterEvidence,
	summary: string,
): string {
	const diffText =
		hasSnapshotText(request.role) || hasSnapshotText(request.search)
			? evidence.diff?.summary
			: undefined;
	return [
		summary,
		formatRenderedTextSearchMatches(evidence.renderedTextSearch),
		diffText,
		viewportText(evidence.viewport),
	]
		.filter((line) => line !== undefined)
		.join("\n\n");
}

async function presentSnapshotFilter(
	options: Pick<
		SnapshotFilterOptions,
		"modelVisible" | "persistentArtifactStore" | "artifactManifest"
	>,
	evidence: SnapshotFilterEvidence,
	prefix: string,
): Promise<ToolPresentation> {
	const presentation: ToolPresentation =
		options.modelVisible === false
			? { content: [], data: redactSensitiveValue(evidence.filtered.data), summary: "Snapshot" }
			: await buildSnapshotPresentation(
					evidence.filtered.data,
					options.persistentArtifactStore,
					options.artifactManifest,
				);
	const first = presentation.content.at(0);
	const content = [...presentation.content];
	if (first?.type === "text") {
		content[0] = { ...first, text: `${prefix}\n\n${first.text}` };
	}
	return { ...presentation, content };
}

function snapshotFilterDetails(
	request: SnapshotFilterRequest,
	evidence: SnapshotFilterEvidence,
): Readonly<Record<string, unknown>> | undefined {
	if (!hasSnapshotText(request.role) && !hasSnapshotText(request.search)) {
		return undefined;
	}
	return {
		cleanArgs: request.cleanArgs,
		matchedRefs: evidence.filtered.matchedRefs,
		renderedTextMatches: evidence.renderedTextSearch?.matches,
		renderedTextTotalMatches: evidence.renderedTextSearch?.totalMatches,
		renderedTextTruncated: evidence.renderedTextSearch?.truncated,
		role: request.role,
		search: request.search,
		totalLines: evidence.filtered.totalLines,
		totalRefs: evidence.filtered.totalRefs,
		visibleLines: evidence.filtered.visibleLines,
	};
}

function snapshotToolResult(
	options: Pick<
		SnapshotFilterOptions,
		| "redactedArgs"
		| "compatibilityWorkaround"
		| "effectiveArgs"
		| "sessionMode"
		| "sessionName"
		| "sessionPageState"
		| "sessionStateKey"
		| "usedImplicitSession"
		| "namespace"
		| "managedSessionRestoreDisabled"
	>,
	request: SnapshotFilterRequest,
	evidence: SnapshotFilterEvidence,
	presentation: ToolPresentationObservation,
): AgentBrowserToolResult {
	const summary = snapshotFilterSummary(request, evidence);
	return {
		content: [...presentation.content],
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
			refSnapshot: evidence.fullSnapshot,
			sessionMode: options.sessionMode,
			sessionTabTarget: options.sessionPageState.get(options.sessionStateKey ?? options.sessionName)
				.tabTarget,
			snapshotDiff: evidence.diff,
			snapshotFilter: snapshotFilterDetails(request, evidence),
			snapshotViewport: evidence.viewport,
			...buildAgentBrowserResultCategoryDetails({
				args: options.effectiveArgs,
				command: "snapshot",
				succeeded: true,
			}),
			...buildSessionDetailFields(
				options.sessionName,
				options.usedImplicitSession,
				options.namespace,
				options.managedSessionRestoreDisabled(),
			),
			summary,
		},
		isError: false,
	};
}

export async function trySnapshotFilter(
	options: SnapshotFilterOptions,
): Promise<SnapshotFilterResult | undefined> {
	const request = parseSnapshotFilterRequest(options.commandTokens);
	if (!request || !hasSnapshotText(options.sessionName)) {
		return undefined;
	}
	const evidence = await collectSnapshotEvidence(
		{ ...options, sessionName: options.sessionName },
		request,
	);
	if (!evidence) {
		return undefined;
	}
	const summary = snapshotFilterSummary(request, evidence);
	const presentation = await presentSnapshotFilter(
		options,
		evidence,
		snapshotPrefix(request, evidence, summary),
	);
	return {
		artifactManifest: presentation.artifactManifest,
		result: snapshotToolResult(options, request, evidence, presentation),
	};
}
