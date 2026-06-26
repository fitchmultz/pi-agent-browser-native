import { isRecord } from "../../../parsing.js";
import { buildAgentBrowserResultCategoryDetails } from "../../../results.js";
import { buildSnapshotPresentation } from "../../../results/snapshot.js";
import { extractRefSnapshotFromData, type SessionRefSnapshot } from "../../../session-page-state.js";
import type { CompatibilityWorkaround } from "../../../runtime.js";
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
	const prefix = [summary, diffText, viewportText].filter((line): line is string => line !== undefined).join("\n");
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
				snapshotFilter: request.role || request.search ? { cleanArgs: request.cleanArgs, matchedRefs: filtered.matchedRefs, role: request.role, search: request.search, totalLines: filtered.totalLines, totalRefs: filtered.totalRefs, visibleLines: filtered.visibleLines } : undefined,
				snapshotViewport: viewport,
				...buildAgentBrowserResultCategoryDetails({ args: options.effectiveArgs, command: "snapshot", succeeded: true }),
				...buildSessionDetailFields(options.sessionName, options.usedImplicitSession, options.namespace),
				summary,
			},
			isError: false,
		},
	};
}
