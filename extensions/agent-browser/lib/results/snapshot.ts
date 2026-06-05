/**
 * Purpose: Compact large agent-browser snapshots into actionable pi-facing previews while preserving access to the raw payload when budgets allow.
 * Responsibilities: Parse the current raw snapshot text format, detect when structured parsing is trustworthy, derive primary/additional content sections, rank high-value refs, and fall back to raw-outline previews when the upstream snapshot text format is unfamiliar.
 * Scope: Snapshot-specific rendering only; generic envelope parsing, non-snapshot summaries, and image attachment live in neighboring modules.
 * Usage: Imported by the focused presentation module for snapshot content and summary rendering.
 * Invariants/Assumptions: Snapshot compaction should stay helpful even if upstream snapshot text formatting shifts, so structured parsing is best-effort and always has a resilient raw-outline fallback.
 */

import { isRecord } from "../parsing.js";
import type { PersistentSessionArtifactStore } from "../temp.js";
import type {
	SessionArtifactManifest,
	ToolPresentation,
} from "./contracts.js";
import { isHighValueControlEntry, selectHighValueControlEntries } from "./snapshot-high-value-controls.js";
import {
	buildFallbackSnapshotOutline,
	buildRefLineOrderMap,
	buildSegmentPreview,
	buildSnapshotSegments,
	canUseStructuredSnapshotPreview,
	chooseAdditionalSegments,
	choosePrimarySegment,
	getMeaningfulSegmentLines,
	getSnapshotRolePriority,
	isChromeSectionName,
	isNoiseName,
	parseSnapshotLines,
} from "./snapshot-segments.js";
import { applySnapshotArtifactManifest, writeSnapshotSpillFile, type SnapshotSpillWriteResult } from "./snapshot-spill.js";
import {
	enrichSnapshotRefEntries,
	getSnapshotRefEntries,
	type SnapshotLineRefInfo,
	type SnapshotRefEntry,
} from "./snapshot-refs.js";
import { compareRefIds, countLines, truncateText } from "./text.js";

const SNAPSHOT_INLINE_MAX_CHARS = 6_000;
const SNAPSHOT_INLINE_MAX_LINES = 80;
const SNAPSHOT_INLINE_MAX_REFS = 60;
const SNAPSHOT_PRIMARY_PREVIEW_LINES = 8;
const SNAPSHOT_SECTION_PREVIEW_LINES = 2;
const SNAPSHOT_KEY_REF_MAX_LINES = 8;
const SNAPSHOT_OTHER_REF_MAX_LINES = 4;
const SNAPSHOT_HIGH_VALUE_REF_MAX_LINES = 10;
const SNAPSHOT_ROLE_COUNT_MAX_ENTRIES = 4;
const SNAPSHOT_NAME_MAX_CHARS = 96;
function getSnapshotText(data: Record<string, unknown>): string | undefined {
	return typeof data.snapshot === "string" ? data.snapshot : undefined;
}

function getSnapshotOrigin(data: Record<string, unknown>): string {
	return typeof data.origin === "string" ? data.origin : "(unknown origin)";
}

function getSnapshotRoleCounts(refEntries: SnapshotRefEntry[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of refEntries) {
		counts[entry.role] = (counts[entry.role] ?? 0) + 1;
	}
	return counts;
}

function formatRoleCounts(roleCounts: Record<string, number>): string | undefined {
	const entries = Object.entries(roleCounts);
	if (entries.length === 0) return undefined;

	const ordered = entries.sort((left, right) => {
		if (right[1] !== left[1]) return right[1] - left[1];
		return getSnapshotRolePriority(left[0]) - getSnapshotRolePriority(right[0]);
	});
	const visibleEntries = ordered.slice(0, SNAPSHOT_ROLE_COUNT_MAX_ENTRIES).map(([role, count]) => `${role} ${count}`);
	const omittedEntries = Math.max(0, ordered.length - visibleEntries.length);
	if (omittedEntries > 0) {
		visibleEntries.push(`+${omittedEntries} more`);
	}
	return visibleEntries.join(", ");
}

function rankRefEntries(
	refEntries: SnapshotRefEntry[],
	previewRefIds: Set<string>,
	focusRefIds: Set<string>,
	lineOrderByRef: Map<string, number>,
): SnapshotRefEntry[] {
	return [...refEntries].sort((left, right) => {
		const leftBucket = previewRefIds.has(left.id) ? 0 : focusRefIds.has(left.id) ? 1 : 2;
		const rightBucket = previewRefIds.has(right.id) ? 0 : focusRefIds.has(right.id) ? 1 : 2;
		if (leftBucket !== rightBucket) return leftBucket - rightBucket;

		const rolePriority = getSnapshotRolePriority(left.role) - getSnapshotRolePriority(right.role);
		if (rolePriority !== 0) return rolePriority;

		const leftHasName = left.name.length > 0 ? 0 : 1;
		const rightHasName = right.name.length > 0 ? 0 : 1;
		if (leftHasName !== rightHasName) return leftHasName - rightHasName;

		const leftLineOrder = lineOrderByRef.get(left.id) ?? Number.MAX_SAFE_INTEGER;
		const rightLineOrder = lineOrderByRef.get(right.id) ?? Number.MAX_SAFE_INTEGER;
		if (leftLineOrder !== rightLineOrder) return leftLineOrder - rightLineOrder;

		return compareRefIds(left.id, right.id);
	});
}

function formatCompactRef(entry: SnapshotRefEntry): string {
	const suffix = entry.name.length > 0 ? ` "${truncateText(entry.name, SNAPSHOT_NAME_MAX_CHARS)}"` : "";
	return `- ${entry.id} ${entry.role}${suffix}`;
}

function shouldCompactSnapshot(rawText: string, data: Record<string, unknown>): boolean {
	const snapshot = getSnapshotText(data) ?? "";
	const refEntries = getSnapshotRefEntries(data);
	return (
		rawText.length > SNAPSHOT_INLINE_MAX_CHARS ||
		countLines(snapshot) > SNAPSHOT_INLINE_MAX_LINES ||
		refEntries.length > SNAPSHOT_INLINE_MAX_REFS
	);
}

export function formatSnapshotSummary(data: Record<string, unknown>): string {
	const origin = typeof data.origin === "string" ? data.origin : "page";
	const refs = isRecord(data.refs) ? Object.keys(data.refs).length : 0;
	return `Snapshot: ${refs} refs on ${origin}`;
}

export function formatRawSnapshotText(data: Record<string, unknown>): string {
	const origin = getSnapshotOrigin(data);
	const refs = isRecord(data.refs) ? Object.keys(data.refs).length : 0;
	const snapshot = getSnapshotText(data);
	if (!snapshot) {
		return `Origin: ${origin}\nRefs: ${refs}\n\n(no interactive elements)`;
	}
	return `Origin: ${origin}\nRefs: ${refs}\n\n${snapshot}`;
}

export async function buildSnapshotPresentation(
	data: Record<string, unknown>,
	persistentArtifactStore: PersistentSessionArtifactStore | undefined = undefined,
	artifactManifest: SessionArtifactManifest | undefined = undefined,
): Promise<ToolPresentation> {
	const summary = formatSnapshotSummary(data);
	const rawText = formatRawSnapshotText(data);
	if (!shouldCompactSnapshot(rawText, data)) {
		return {
			content: [{ type: "text", text: rawText }],
			data,
			summary,
		};
	}

	let fullOutputPath: string | undefined;
	let spill: SnapshotSpillWriteResult | undefined;
	let spillErrorText: string | undefined;
	try {
		spill = await writeSnapshotSpillFile(data, persistentArtifactStore);
		fullOutputPath = spill.path;
	} catch (error) {
		spillErrorText = error instanceof Error ? error.message : String(error);
	}

	const snapshot = getSnapshotText(data) ?? "(no interactive elements)";
	const snapshotLines = parseSnapshotLines(snapshot);
	const refEntries = enrichSnapshotRefEntries(getSnapshotRefEntries(data), snapshotLines);
	const roleCounts = getSnapshotRoleCounts(refEntries);
	const roleCountsText = formatRoleCounts(roleCounts);
	const useStructuredPreview = canUseStructuredSnapshotPreview(snapshotLines, refEntries);
	const snapshotSegments = useStructuredPreview ? buildSnapshotSegments(snapshotLines) : [];
	const primarySegment = useStructuredPreview ? choosePrimarySegment(snapshotSegments) : undefined;
	const additionalSegments = useStructuredPreview ? chooseAdditionalSegments(snapshotSegments, primarySegment) : [];
	const additionalSegmentCount = useStructuredPreview && primarySegment ? Math.max(0, snapshotSegments.length - 1) : 0;
	const omittedAdditionalSectionCount = Math.max(0, additionalSegmentCount - additionalSegments.length);
	const primaryPreview = primarySegment ? buildSegmentPreview(primarySegment, SNAPSHOT_PRIMARY_PREVIEW_LINES) : undefined;
	const additionalPreviews = additionalSegments
		.map((segment) => ({
			preview: buildSegmentPreview(segment, SNAPSHOT_SECTION_PREVIEW_LINES),
			segment,
		}))
		.filter(({ preview }) => preview.lines.length > 0);
	const fallbackPreview =
		!useStructuredPreview || !primaryPreview || primaryPreview.lines.length === 0 ? buildFallbackSnapshotOutline(snapshotLines) : undefined;

	const previewRefIds = new Set<string>([
		...(primaryPreview?.refIds ?? []),
		...additionalPreviews.flatMap(({ preview }) => preview.refIds),
		...(fallbackPreview?.refIds ?? []),
	]);
	const focusRefIds = new Set<string>([
		...(useStructuredPreview && primarySegment
			? getMeaningfulSegmentLines(primarySegment).flatMap((line) => (line.ref ? [line.ref] : []))
			: []),
		...(useStructuredPreview
			? additionalSegments.flatMap((segment) => getMeaningfulSegmentLines(segment).flatMap((line) => (line.ref ? [line.ref] : [])))
			: []),
		...(fallbackPreview?.refIds ?? []),
	]);
	const lineOrderByRef = useStructuredPreview ? buildRefLineOrderMap(snapshotLines) : new Map<string, number>();
	const rankedRefEntries = rankRefEntries(refEntries, previewRefIds, focusRefIds, lineOrderByRef);
	const visibleRankedRefEntries = rankedRefEntries.filter(
		(entry) => !isNoiseName(entry.name) && !isChromeSectionName(entry.name) && !(entry.role === "heading" && entry.name.length <= 2),
	);
	const keyRefEntries = visibleRankedRefEntries.slice(0, SNAPSHOT_KEY_REF_MAX_LINES);
	const keyRefIdSet = new Set(keyRefEntries.map((entry) => entry.id));
	const otherRefEntries = visibleRankedRefEntries
		.filter((entry) => !keyRefIdSet.has(entry.id))
		.slice(0, SNAPSHOT_OTHER_REF_MAX_LINES);
	const displayedRefIdSet = new Set([...keyRefEntries, ...otherRefEntries].map((entry) => entry.id));
	const omittedRefEntries = visibleRankedRefEntries.filter((entry) => !displayedRefIdSet.has(entry.id));
	const highValueControlEntries = omittedRefEntries.filter(
		(entry) => isHighValueControlEntry(entry) && !isNoiseName(entry.name) && !isChromeSectionName(entry.name),
	);
	const visibleHighValueControlEntries = selectHighValueControlEntries(highValueControlEntries, SNAPSHOT_HIGH_VALUE_REF_MAX_LINES);
	const omittedHighValueControls = Math.max(0, highValueControlEntries.length - visibleHighValueControlEntries.length);
	const omittedNonHighlightedRefs = Math.max(0, omittedRefEntries.length - highValueControlEntries.length);
	const origin = getSnapshotOrigin(data);

	const lines: string[] = [
		`Origin: ${origin}`,
		`Refs: ${refEntries.length}`,
		...(roleCountsText ? [`Top roles: ${roleCountsText}`] : []),
		"",
		"Compact snapshot view.",
		"Viewport note: compact snapshots are DOM/signal-prioritized, not guaranteed to start with the currently scrolled viewport; use the full raw snapshot, a screenshot, or listed high-value refs when viewport context matters.",
	];

	if (fallbackPreview) {
		lines.push(
			"",
			"Compact outline:",
			...(fallbackPreview.lines.length > 0 ? fallbackPreview.lines : ["(no interactive elements)"]),
		);
		if (fallbackPreview.omittedCount > 0) {
			lines.push(
				`- ... (${fallbackPreview.omittedCount} additional snapshot lines omitted; ${fullOutputPath ? `full output path: ${fullOutputPath}` : "the full raw snapshot was omitted"})`,
			);
		}
	} else {
		lines.push("", "Primary content:", ...(primaryPreview?.lines ?? ["(no interactive elements)"]));
		if ((primaryPreview?.omittedCount ?? 0) > 0) {
			lines.push(`- ... (${primaryPreview?.omittedCount} more lines in this section)`);
		}

		if (additionalPreviews.length > 0) {
			lines.push("", "Additional sections:");
			additionalPreviews.forEach(({ preview }, index) => {
				if (index > 0) lines.push("");
				lines.push(...preview.lines);
				if (preview.omittedCount > 0) {
					lines.push(`- ... (${preview.omittedCount} more lines in this section)`);
				}
			});
			if (omittedAdditionalSectionCount > 0) {
				lines.push(`- ... (${omittedAdditionalSectionCount} more sections omitted)`);
			}
		}
	}

	lines.push("", "Key refs:", ...(keyRefEntries.length > 0 ? keyRefEntries.map(formatCompactRef) : ["(no refs)"]));
	if (otherRefEntries.length > 0) {
		lines.push("", "Other refs:", ...otherRefEntries.map(formatCompactRef));
	}
	if (omittedNonHighlightedRefs > 0) {
		lines.push(`- ... (${omittedNonHighlightedRefs} additional refs omitted)`);
	}
	if (visibleHighValueControlEntries.length > 0) {
		lines.push("", "Omitted high-value controls:", ...visibleHighValueControlEntries.map(formatCompactRef));
		if (omittedHighValueControls > 0) {
			lines.push(`- ... (${omittedHighValueControls} additional high-value controls omitted)`);
		}
	}

	lines.push(
		"",
		fullOutputPath
			? `Full raw snapshot path: ${fullOutputPath}`
			: `Full raw snapshot unavailable: ${spillErrorText ?? "temp spill file could not be created."}`,
	);

	const manifestFields = applySnapshotArtifactManifest({
		baseManifest: artifactManifest,
		command: "snapshot",
		fullOutputPath,
		spill,
	});
	if (manifestFields.artifactRetentionSummary) {
		lines.push("", manifestFields.artifactRetentionSummary);
	}

	return {
		...manifestFields,
		content: [{ type: "text", text: lines.join("\n") }],
		data: {
			compacted: true,
			fullOutputPath,
			origin,
			previewMode: fallbackPreview ? "outline" : "structured",
			viewportOrdering: "dom-signal-prioritized",
			spillError: spillErrorText,
			previewRefIds: [...previewRefIds],
			highValueControlRefIds: visibleHighValueControlEntries.map((entry) => entry.id),
			additionalSectionsOmitted: omittedAdditionalSectionCount,
			previewSections: [
				...(primarySegment
					? [
						{
							linesShown: primaryPreview?.lines.length ?? 0,
							omittedLines: primaryPreview?.omittedCount ?? 0,
							role: primarySegment.root.role,
							title: primarySegment.root.name,
						},
					  ]
					: []),
				...additionalPreviews.map(({ preview, segment }) => ({
					linesShown: preview.lines.length,
					omittedLines: preview.omittedCount,
					role: segment.root.role,
					title: segment.root.name,
				})),
			],
			refCount: refEntries.length,
			roleCounts,
			snapshotLineCount: countLines(snapshot),
			structuredPreviewUsed: !fallbackPreview,
		},
		fullOutputPath,
		summary: `${summary} (compact)`,
	};
}
