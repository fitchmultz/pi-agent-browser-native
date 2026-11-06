import type { ToolPresentation } from "./contracts.js";
import { getSnapshotOrigin, getSnapshotText } from "./snapshot-content.js";
import {
	isHighValueControlEntry,
	selectHighValueControlEntries,
} from "./snapshot-high-value-controls.js";
import {
	enrichSnapshotRefEntries,
	getSnapshotRefEntries,
	type SnapshotRefEntry,
} from "./snapshot-refs.js";
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
	type SnapshotLine,
	type SnapshotPreview,
	type SnapshotSegment,
} from "./snapshot-segments.js";
import { compareRefIds, countLines, truncateText } from "./text.js";

const PRIMARY_PREVIEW_LINES = 8;
const SECTION_PREVIEW_LINES = 2;
const KEY_REF_MAX_LINES = 8;
const OTHER_REF_MAX_LINES = 4;
const HIGH_VALUE_REF_MAX_LINES = 10;

interface AdditionalPreview {
	readonly preview: SnapshotPreview;
	readonly segment: SnapshotSegment;
}

interface PagePreview {
	readonly useStructured: boolean;
	readonly primarySegment?: SnapshotSegment | undefined;
	readonly primaryPreview?: SnapshotPreview | undefined;
	readonly additionalSegments: readonly SnapshotSegment[];
	readonly additionalPreviews: readonly AdditionalPreview[];
	readonly fallbackPreview?: SnapshotPreview | undefined;
	readonly omittedAdditionalSectionCount: number;
}

interface RefSelection {
	readonly key: readonly SnapshotRefEntry[];
	readonly other: readonly SnapshotRefEntry[];
	readonly highValue: readonly SnapshotRefEntry[];
	readonly omittedHighValueControls: number;
	readonly omittedNonHighlightedRefs: number;
}

function getSnapshotRoleCounts(entries: readonly SnapshotRefEntry[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of entries) {
		counts[entry.role] = (counts[entry.role] ?? 0) + 1;
	}
	return counts;
}

function formatRoleCounts(counts: Readonly<Record<string, number>>): string | undefined {
	const entries = Object.entries(counts);
	if (entries.length === 0) {
		return undefined;
	}
	const ordered = entries.sort((left, right) =>
		right[1] !== left[1]
			? right[1] - left[1]
			: getSnapshotRolePriority(left[0]) - getSnapshotRolePriority(right[0]),
	);
	const visible = ordered.slice(0, 4).map(([role, count]) => `${role} ${count}`);
	const omitted = Math.max(0, ordered.length - visible.length);
	if (omitted > 0) {
		visible.push(`+${omitted} more`);
	}
	return visible.join(", ");
}

function rankRefEntries(
	entries: readonly SnapshotRefEntry[],
	preview: readonly string[],
	focus: readonly string[],
	lines: readonly SnapshotLine[],
): SnapshotRefEntry[] {
	const previewIds = new Set(preview);
	const focusIds = new Set(focus);
	const order = buildRefLineOrderMap(lines);
	const refBucket = (id: string): number => {
		if (previewIds.has(id)) {
			return 0;
		}
		return focusIds.has(id) ? 1 : 2;
	};
	return [...entries].sort((left, right) => {
		const bucketDifference = refBucket(left.id) - refBucket(right.id);
		if (bucketDifference !== 0) {
			return bucketDifference;
		}
		const roleDifference = getSnapshotRolePriority(left.role) - getSnapshotRolePriority(right.role);
		if (roleDifference !== 0) {
			return roleDifference;
		}
		const nameDifference = Number(left.name.length === 0) - Number(right.name.length === 0);
		if (nameDifference !== 0) {
			return nameDifference;
		}
		const lineDifference =
			(order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
			(order.get(right.id) ?? Number.MAX_SAFE_INTEGER);
		return lineDifference !== 0 ? lineDifference : compareRefIds(left.id, right.id);
	});
}

function getFallbackPreview(
	lines: readonly SnapshotLine[],
	structured: boolean,
	primary: SnapshotPreview | undefined,
): SnapshotPreview | undefined {
	return !structured || !primary || primary.lines.length === 0
		? buildFallbackSnapshotOutline(lines)
		: undefined;
}

function buildPagePreview(
	lines: readonly SnapshotLine[],
	entries: readonly SnapshotRefEntry[],
): PagePreview {
	const useStructured = canUseStructuredSnapshotPreview(lines, entries);
	const segments = useStructured ? buildSnapshotSegments(lines) : [];
	const primarySegment = useStructured ? choosePrimarySegment(segments) : undefined;
	const additionalSegments = useStructured
		? chooseAdditionalSegments(segments, primarySegment)
		: [];
	const additionalSegmentCount = primarySegment ? Math.max(0, segments.length - 1) : 0;
	const primaryPreview = primarySegment
		? buildSegmentPreview(primarySegment, PRIMARY_PREVIEW_LINES)
		: undefined;
	return {
		useStructured,
		primarySegment,
		primaryPreview,
		additionalSegments,
		additionalPreviews: additionalSegments
			.map((segment) => ({ segment, preview: buildSegmentPreview(segment, SECTION_PREVIEW_LINES) }))
			.filter(({ preview }) => preview.lines.length > 0),
		fallbackPreview: getFallbackPreview(lines, useStructured, primaryPreview),
		omittedAdditionalSectionCount: Math.max(0, additionalSegmentCount - additionalSegments.length),
	};
}

function getPreviewRefIds(page: PagePreview): string[] {
	return [
		...new Set([
			...(page.primaryPreview?.refIds ?? []),
			...page.additionalPreviews.flatMap(({ preview }) => preview.refIds),
			...(page.fallbackPreview?.refIds ?? []),
		]),
	];
}

function getFocusRefIds(page: PagePreview): string[] {
	const primary =
		page.useStructured && page.primarySegment ? getMeaningfulSegmentLines(page.primarySegment) : [];
	const additional = page.useStructured
		? page.additionalSegments.flatMap(getMeaningfulSegmentLines)
		: [];
	return [
		...new Set(
			[...primary, ...additional]
				.flatMap((line) => (line.ref !== undefined && line.ref.length > 0 ? [line.ref] : []))
				.concat(page.fallbackPreview?.refIds ?? []),
		),
	];
}

function selectCompactRefs(entries: readonly SnapshotRefEntry[]): RefSelection {
	const visible = entries.filter(
		(entry) =>
			!isNoiseName(entry.name) &&
			!isChromeSectionName(entry.name) &&
			!(entry.role === "heading" && entry.name.length <= 2),
	);
	const key = visible.slice(0, KEY_REF_MAX_LINES);
	const keyIds = new Set(key.map((entry) => entry.id));
	const other = visible.filter((entry) => !keyIds.has(entry.id)).slice(0, OTHER_REF_MAX_LINES);
	const displayedIds = new Set([...key, ...other].map((entry) => entry.id));
	const omitted = visible.filter((entry) => !displayedIds.has(entry.id));
	const highValueCandidates = omitted.filter(
		(entry) =>
			isHighValueControlEntry(entry) &&
			!isNoiseName(entry.name) &&
			!isChromeSectionName(entry.name),
	);
	const highValue = selectHighValueControlEntries(highValueCandidates, HIGH_VALUE_REF_MAX_LINES);
	return {
		key,
		other,
		highValue,
		omittedHighValueControls: Math.max(0, highValueCandidates.length - highValue.length),
		omittedNonHighlightedRefs: Math.max(0, omitted.length - highValueCandidates.length),
	};
}

function formatCompactRef(entry: SnapshotRefEntry): string {
	const suffix = entry.name.length > 0 ? ` "${truncateText(entry.name, 96)}"` : "";
	return `- ${entry.id} ${entry.role}${suffix}`;
}

function formatAdditionalPreviews(page: PagePreview): string[] {
	if (page.additionalPreviews.length === 0) {
		return [];
	}
	const lines = ["", "Additional sections:"];
	page.additionalPreviews.forEach(({ preview }, index) => {
		if (index > 0) {
			lines.push("");
		}
		lines.push(...preview.lines);
		if (preview.omittedCount > 0) {
			lines.push(`- ... (${preview.omittedCount} more lines in this section)`);
		}
	});
	if (page.omittedAdditionalSectionCount > 0) {
		lines.push(`- ... (${page.omittedAdditionalSectionCount} more sections omitted)`);
	}
	return lines;
}

function formatFallbackPreview(
	preview: SnapshotPreview,
	fullOutputPath: string | undefined,
): string[] {
	const lines = [
		"",
		"Compact outline:",
		...(preview.lines.length > 0 ? preview.lines : ["(no interactive elements)"]),
	];
	if (preview.omittedCount > 0) {
		const source =
			fullOutputPath !== undefined && fullOutputPath.length > 0
				? `full output path: ${fullOutputPath}`
				: "the full redacted snapshot was omitted";
		lines.push(`- ... (${preview.omittedCount} additional snapshot lines omitted; ${source})`);
	}
	return lines;
}

function formatPagePreview(page: PagePreview, fullOutputPath: string | undefined): string[] {
	if (page.fallbackPreview) {
		return formatFallbackPreview(page.fallbackPreview, fullOutputPath);
	}
	const lines = [
		"",
		"Primary content:",
		...(page.primaryPreview?.lines ?? ["(no interactive elements)"]),
	];
	if ((page.primaryPreview?.omittedCount ?? 0) > 0) {
		lines.push(
			`- ... (${page.primaryPreview?.omittedCount ?? "undefined"} more lines in this section)`,
		);
	}
	return [...lines, ...formatAdditionalPreviews(page)];
}

function formatRefSelection(selection: RefSelection): string[] {
	const lines = [
		"",
		"Key refs:",
		...(selection.key.length > 0 ? selection.key.map(formatCompactRef) : ["(no refs)"]),
	];
	if (selection.other.length > 0) {
		lines.push("", "Other refs:", ...selection.other.map(formatCompactRef));
	}
	if (selection.omittedNonHighlightedRefs > 0) {
		lines.push(`- ... (${selection.omittedNonHighlightedRefs} additional refs omitted)`);
	}
	if (selection.highValue.length > 0) {
		lines.push("", "Omitted high-value controls:", ...selection.highValue.map(formatCompactRef));
		if (selection.omittedHighValueControls > 0) {
			lines.push(
				`- ... (${selection.omittedHighValueControls} additional high-value controls omitted)`,
			);
		}
	}
	return lines;
}

function getPreviewSections(page: PagePreview): Readonly<Record<string, unknown>>[] {
	const primary = page.primarySegment
		? [
				{
					linesShown: page.primaryPreview?.lines.length ?? 0,
					omittedLines: page.primaryPreview?.omittedCount ?? 0,
					role: page.primarySegment.root.role,
					title: page.primarySegment.root.name,
				},
			]
		: [];
	return [
		...primary,
		...page.additionalPreviews.map(({ preview, segment }) => ({
			linesShown: preview.lines.length,
			omittedLines: preview.omittedCount,
			role: segment.root.role,
			title: segment.root.name,
		})),
	];
}

export function buildCompactSnapshotView(
	data: Readonly<Record<string, unknown>>,
	fullOutputPath: string | undefined,
	spillErrorText: string | undefined,
): Pick<ToolPresentation, "content" | "data"> {
	const snapshot = getSnapshotText(data) ?? "(no interactive elements)";
	const snapshotLines = parseSnapshotLines(snapshot);
	const refEntries = enrichSnapshotRefEntries(getSnapshotRefEntries(data), snapshotLines);
	const roleCounts = getSnapshotRoleCounts(refEntries);
	const roleCountsText = formatRoleCounts(roleCounts);
	const page = buildPagePreview(snapshotLines, refEntries);
	const previewRefIds = getPreviewRefIds(page);
	const ranked = rankRefEntries(
		refEntries,
		previewRefIds,
		getFocusRefIds(page),
		page.useStructured ? snapshotLines : [],
	);
	const refs = selectCompactRefs(ranked);
	const origin = getSnapshotOrigin(data);
	const lines = [
		`Origin: ${origin}`,
		`Refs: ${refEntries.length}`,
		...(roleCountsText !== undefined ? [`Top roles: ${roleCountsText}`] : []),
		"",
		"Compact snapshot view.",
		"Viewport note: compact snapshots are DOM/signal-prioritized, not guaranteed to start with the currently scrolled viewport; use the full redacted snapshot, a screenshot, or listed high-value refs when viewport context matters.",
		...formatPagePreview(page, fullOutputPath),
		...formatRefSelection(refs),
		"",
		fullOutputPath !== undefined && fullOutputPath.length > 0
			? `Full redacted snapshot path: ${fullOutputPath}`
			: `Full redacted snapshot unavailable: ${spillErrorText ?? "temp spill file could not be created."}`,
	];
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		data: {
			compacted: true,
			fullOutputPath,
			origin,
			previewMode: page.fallbackPreview ? "outline" : "structured",
			viewportOrdering: "dom-signal-prioritized",
			spillError: spillErrorText,
			previewRefIds,
			highValueControlRefIds: refs.highValue.map((entry) => entry.id),
			additionalSectionsOmitted: page.omittedAdditionalSectionCount,
			previewSections: getPreviewSections(page),
			refCount: refEntries.length,
			roleCounts,
			snapshotLineCount: countLines(snapshot),
			structuredPreviewUsed: !page.fallbackPreview,
		},
	};
}
