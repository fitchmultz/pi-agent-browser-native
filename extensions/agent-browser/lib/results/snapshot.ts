/**
 * Purpose: Compact large agent-browser snapshots into actionable pi-facing previews while preserving access to the raw payload when budgets allow.
 * Responsibilities: Parse the current raw snapshot text format, detect when structured parsing is trustworthy, derive primary/additional content sections, rank high-value refs, and fall back to raw-outline previews when the upstream snapshot text format is unfamiliar.
 * Scope: Snapshot-specific rendering only; generic envelope parsing, non-snapshot summaries, and image attachment live in neighboring modules.
 * Usage: Imported by the focused presentation module for snapshot content and summary rendering.
 * Invariants/Assumptions: Snapshot compaction should stay helpful even if upstream snapshot text formatting shifts, so structured parsing is best-effort and always has a resilient raw-outline fallback.
 */

import { isRecord } from "../parsing.js";
import {
	type PersistentSessionArtifactEviction,
	type PersistentSessionArtifactStore,
	writePersistentSessionArtifactFile,
	writeSecureTempFile,
} from "../temp.js";
import type {
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
	ToolPresentation,
} from "./contracts.js";
import {
	buildEvictedSessionArtifactEntries,
	formatSessionArtifactRetentionSummary,
	mergeSessionArtifactManifest,
} from "./artifact-manifest.js";
import { getEditableRefEvidence } from "./editable-ref-evidence.js";
import { compareRefIds, countLines, normalizeWhitespace, truncateText } from "./text.js";

const SNAPSHOT_INLINE_MAX_CHARS = 6_000;
const SNAPSHOT_INLINE_MAX_LINES = 80;
const SNAPSHOT_INLINE_MAX_REFS = 60;
const SNAPSHOT_PRIMARY_PREVIEW_LINES = 8;
const SNAPSHOT_SECTION_PREVIEW_LINES = 2;
const SNAPSHOT_MAX_ADDITIONAL_SECTIONS = 2;
const SNAPSHOT_KEY_REF_MAX_LINES = 8;
const SNAPSHOT_OTHER_REF_MAX_LINES = 4;
const SNAPSHOT_HIGH_VALUE_REF_MAX_LINES = 10;
const SNAPSHOT_HIGH_VALUE_EDITABLE_REF_FILL_TARGET_LINES = 4;
const SNAPSHOT_HIGH_VALUE_SURFACE_REF_FILL_TARGET_LINES = 3;
const SNAPSHOT_HIGH_VALUE_PRIMARY_ACTION_REF_FILL_TARGET_LINES = 3;
const SNAPSHOT_ROLE_COUNT_MAX_ENTRIES = 4;
const SNAPSHOT_FALLBACK_PREVIEW_MAX_LINES = 12;
const SNAPSHOT_NAME_MAX_CHARS = 96;
const SNAPSHOT_LINE_MAX_CHARS = 140;
const SNAPSHOT_SPILL_FILE_PREFIX = "pi-agent-browser-snapshot";
const SNAPSHOT_SIGNAL_ROLES = new Set([
	"article",
	"banner",
	"button",
	"checkbox",
	"combobox",
	"dialog",
	"gridcell",
	"heading",
	"link",
	"listitem",
	"main",
	"menu",
	"menuitem",
	"navigation",
	"option",
	"radio",
	"region",
	"row",
	"searchbox",
	"tab",
	"textbox",
]);
const SNAPSHOT_SEGMENT_ROOT_ROLES = new Set(["article", "dialog", "heading", "main", "menu", "region"]);
const SNAPSHOT_ROLE_PRIORITY: Record<string, number> = {
	article: 0,
	main: 1,
	dialog: 2,
	menu: 3,
	region: 4,
	heading: 5,
	searchbox: 6,
	textbox: 7,
	combobox: 8,
	button: 9,
	checkbox: 10,
	radio: 11,
	tab: 12,
	option: 13,
	link: 14,
	listitem: 14,
	row: 15,
	gridcell: 16,
	navigation: 17,
	generic: 99,
	unknown: 100,
};
const SNAPSHOT_NOISE_NAME_PATTERNS = [
	/^skip to /i,
	/^ad$/i,
	/^don't want to see ads\??$/i,
	/keyboard shortcuts/i,
	/\bpromoted\b/i,
	/\bsponsored\b/i,
];
const SNAPSHOT_CHROME_SECTION_PATTERNS = [
	/^primary$/i,
	/^footer$/i,
	/^navigation$/i,
	/\bwhat['’]?s happening\b/i,
	/\brelevant people\b/i,
	/\btrending\b/i,
	/\brelated\b/i,
	/\brecommended\b/i,
	/\bsuggested\b/i,
];
const SNAPSHOT_HIGH_VALUE_CONTROL_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"menuitem",
	"option",
	"radio",
	"searchbox",
	"tab",
	"textbox",
]);
const SNAPSHOT_HIGH_VALUE_CONTROL_ROLE_PRIORITY: Record<string, number> = {
	searchbox: 0,
	textbox: 1,
	combobox: 2,
	button: 3,
	tab: 4,
	checkbox: 5,
	radio: 6,
	option: 7,
	menuitem: 8,
};
const SNAPSHOT_SURFACE_CONTROL_NAME_PATTERNS = [
	/\b(?:agents?|browser|canvas|chat|editor|panel|pane|preview|surface|tab|terminal|thread|view|window|workspace)\b/i,
];
const SNAPSHOT_PRIMARY_ACTION_BUTTON_NAME_PATTERNS = [
	/^(?:add|apply|ask|attach|choose|confirm|connect|continue|create|deploy|done|download|go|insert|launch|log in|new|next|ok|open|publish|refresh|retry|run|save|search|select|send|sign in|sign up|start|submit|upload)$/i,
	/^(?:add|apply|ask|confirm|connect|continue|create|launch|new|open|refresh|retry|run|save|search|send|start|submit)\b/i,
];

interface SnapshotRefEntry {
	id: string;
	isEditable?: boolean;
	lineIndex?: number;
	name: string;
	refData?: Record<string, unknown>;
	role: string;
}

interface SnapshotLine {
	depth: number;
	headingLevel?: number;
	index: number;
	name: string;
	raw: string;
	ref?: string;
	role: string;
}

interface SnapshotSegment {
	endIndexExclusive: number;
	lines: SnapshotLine[];
	root: SnapshotLine;
	score: number;
	startIndex: number;
}

interface SnapshotPreview {
	omittedCount: number;
	refIds: string[];
	lines: string[];
}

function getSnapshotText(data: Record<string, unknown>): string | undefined {
	return typeof data.snapshot === "string" ? data.snapshot : undefined;
}

function getSnapshotOrigin(data: Record<string, unknown>): string {
	return typeof data.origin === "string" ? data.origin : "(unknown origin)";
}

function formatPreviewLine(line: SnapshotLine, baseDepth: number): string {
	const leadingWhitespace = (line.raw.match(/^\s*/) ?? [""])[0].length;
	const stripChars = Math.min(leadingWhitespace, Math.max(0, baseDepth) * 2);
	return truncateText(line.raw.slice(stripChars), SNAPSHOT_LINE_MAX_CHARS);
}

function getRolePriority(role: string): number {
	return SNAPSHOT_ROLE_PRIORITY[role] ?? 50;
}

function getSnapshotRefEntries(data: Record<string, unknown>): SnapshotRefEntry[] {
	const refs = isRecord(data.refs) ? data.refs : undefined;
	if (!refs) return [];

	return Object.entries(refs)
		.map(([id, value]) => {
			if (!isRecord(value)) {
				return { id, name: "", role: "unknown" } satisfies SnapshotRefEntry;
			}
			const name = typeof value.name === "string" ? normalizeWhitespace(value.name) : "";
			const role = typeof value.role === "string" && value.role.length > 0 ? value.role : "unknown";
			const isEditable = getEditableRefEvidence({ ref: value });
			return { id, isEditable, name, refData: value, role } satisfies SnapshotRefEntry;
		})
		.sort((a, b) => compareRefIds(a.id, b.id));
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
		return getRolePriority(left[0]) - getRolePriority(right[0]);
	});
	const visibleEntries = ordered.slice(0, SNAPSHOT_ROLE_COUNT_MAX_ENTRIES).map(([role, count]) => `${role} ${count}`);
	const omittedEntries = Math.max(0, ordered.length - visibleEntries.length);
	if (omittedEntries > 0) {
		visibleEntries.push(`+${omittedEntries} more`);
	}
	return visibleEntries.join(", ");
}

function parseSnapshotLines(snapshot: string): SnapshotLine[] {
	return snapshot
		.split("\n")
		.filter((line) => line.length > 0)
		.map((raw, index) => {
			const trimmed = raw.trimStart();
			const depth = Math.floor(((raw.match(/^\s*/) ?? [""])[0].length ?? 0) / 2);
			const role = trimmed.match(/^[-*]\s+([^\s"]+)/)?.[1] ?? "unknown";
			const name = normalizeWhitespace(trimmed.match(/"([^"]*)"/)?.[1] ?? "");
			const ref = trimmed.match(/\bref=([^,\]\s]+)/)?.[1];
			const headingLevel = trimmed.match(/\blevel=(\d+)/)?.[1];
			return {
				depth,
				headingLevel: headingLevel ? Number(headingLevel) : undefined,
				index,
				name,
				raw,
				ref,
				role,
			} satisfies SnapshotLine;
		});
}

function isNoiseName(name: string): boolean {
	return SNAPSHOT_NOISE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function isChromeSectionName(name: string): boolean {
	return SNAPSHOT_CHROME_SECTION_PATTERNS.some((pattern) => pattern.test(name));
}

function isNoiseSnapshotLine(line: SnapshotLine): boolean {
	if (line.name.length > 0 && isNoiseName(line.name)) return true;
	const loweredRaw = line.raw.toLowerCase();
	return loweredRaw.includes("promoted") || loweredRaw.includes("sponsored");
}

function isPotentialSegmentRootLine(line: SnapshotLine): boolean {
	if (!SNAPSHOT_SEGMENT_ROOT_ROLES.has(line.role)) return false;
	if (isNoiseSnapshotLine(line)) return false;
	if (line.role === "heading") {
		return line.name.length > 0 && (line.headingLevel ?? 99) <= 3;
	}
	if (line.role === "region") {
		return line.name.length > 0;
	}
	return true;
}

function scoreSegment(segment: SnapshotSegment): number {
	const { root } = segment;
	const distinctRefs = new Set(segment.lines.flatMap((line) => (line.ref ? [line.ref] : []))).size;
	let score = 0;

	score += 120 - getRolePriority(root.role) * 8;
	score += Math.min(distinctRefs, 16);
	score += Math.min(segment.lines.length, 12);
	score -= Math.min(root.index, 60) / 3;
	score -= root.depth * 6;

	if (root.role === "heading") {
		if (root.headingLevel === 1) score += 40;
		else if (root.headingLevel === 2) score += 22;
		else if (root.headingLevel === 3) score += 12;
	}
	if (root.name.length > 0) score += 10;
	if (root.name.length <= 2) score -= 18;
	if (isChromeSectionName(root.name)) score -= 45;
	if (isNoiseName(root.name)) score -= 1000;
	return score;
}

function buildSnapshotSegments(snapshotLines: SnapshotLine[]): SnapshotSegment[] {
	const roots: SnapshotLine[] = [];
	const stack: SnapshotLine[] = [];

	for (const line of snapshotLines) {
		stack.length = line.depth;
		if (isPotentialSegmentRootLine(line)) {
			const normalizedName = normalizeWhitespace(line.name.toLowerCase());
			let duplicateAncestor: SnapshotLine | undefined;
			for (let index = stack.length - 1; index >= 0; index -= 1) {
				const ancestor = stack[index];
				if (
					normalizedName.length > 0 &&
					normalizeWhitespace(ancestor.name.toLowerCase()) === normalizedName &&
					SNAPSHOT_SEGMENT_ROOT_ROLES.has(ancestor.role)
				) {
					duplicateAncestor = ancestor;
					break;
				}
			}
			if (!duplicateAncestor) {
				roots.push(line);
			}
		}
		stack[line.depth] = line;
	}

	return roots.map((root, index) => {
		let endIndexExclusive = snapshotLines.length;
		for (let nextIndex = index + 1; nextIndex < roots.length; nextIndex += 1) {
			const candidate = roots[nextIndex];
			if (candidate.depth <= root.depth) {
				endIndexExclusive = candidate.index;
				break;
			}
		}
		const lines = snapshotLines.slice(root.index, endIndexExclusive);
		const segment: SnapshotSegment = {
			endIndexExclusive,
			lines,
			root,
			score: 0,
			startIndex: root.index,
		};
		segment.score = scoreSegment(segment);
		return segment;
	});
}

function choosePrimarySegment(segments: SnapshotSegment[]): SnapshotSegment | undefined {
	if (segments.length === 0) return undefined;
	return (
		segments.find((segment) => segment.root.role === "main" || segment.root.role === "article") ??
		segments.find((segment) => segment.root.role === "heading" && segment.root.headingLevel === 1) ??
		segments.find((segment) => segment.score >= 90) ??
		[...segments].sort((left, right) => right.score - left.score || left.startIndex - right.startIndex)[0]
	);
}

function chooseAdditionalSegments(segments: SnapshotSegment[], primary: SnapshotSegment | undefined): SnapshotSegment[] {
	if (!primary) return [];

	const seenNames = new Set<string>([normalizeWhitespace(primary.root.name.toLowerCase())]);
	const rankedCandidates = segments
		.filter((segment) => segment !== primary && segment.score >= 45)
		.sort((left, right) => {
			const leftDistance = Math.abs(left.startIndex - primary.startIndex);
			const rightDistance = Math.abs(right.startIndex - primary.startIndex);
			if (leftDistance !== rightDistance) return leftDistance - rightDistance;
			if (right.score !== left.score) return right.score - left.score;
			return left.startIndex - right.startIndex;
		});

	const chosen: SnapshotSegment[] = [];
	for (const segment of rankedCandidates) {
		if (chosen.length >= SNAPSHOT_MAX_ADDITIONAL_SECTIONS) break;
		if (isChromeSectionName(segment.root.name)) continue;
		if (segment.root.role === "heading" && segment.root.name.length <= 2) continue;
		const nameKey = normalizeWhitespace(segment.root.name.toLowerCase());
		if (nameKey && seenNames.has(nameKey)) continue;
		chosen.push(segment);
		if (nameKey) seenNames.add(nameKey);
	}

	return chosen.sort((left, right) => left.startIndex - right.startIndex);
}

function getMeaningfulSegmentLines(segment: SnapshotSegment): SnapshotLine[] {
	return segment.lines.filter((line) => {
		if (isNoiseSnapshotLine(line)) return false;
		if (line.role === "generic" && !line.ref && line.name.length === 0) return false;
		if (line.role === "link" && line.name.length === 0) return false;
		return true;
	});
}

function buildSegmentPreview(segment: SnapshotSegment, maxLines: number): SnapshotPreview {
	const meaningfulLines = getMeaningfulSegmentLines(segment);
	if (meaningfulLines.length === 0) {
		return { omittedCount: 0, refIds: [], lines: [] };
	}

	const previewLines: SnapshotLine[] = [];
	const previewRefIds = new Set<string>();
	const seenPreviewKeys = new Set<string>();
	const rootDepth = segment.root.depth;

	for (const line of meaningfulLines) {
		if (previewLines.length >= maxLines) break;
		if (line !== segment.root) {
			const relativeDepth = line.depth - rootDepth;
			if (segment.root.role !== "heading" && relativeDepth > 2) continue;
			if (segment.root.name.length > 0 && line.name === segment.root.name && (line.role === "heading" || line.role === "link")) {
				continue;
			}
		}

		const key = `${line.role}:${line.name}:${line.ref ?? ""}:${line.depth}`;
		if (seenPreviewKeys.has(key)) continue;
		seenPreviewKeys.add(key);
		previewLines.push(line);
		if (line.ref) previewRefIds.add(line.ref);
	}

	return {
		omittedCount: Math.max(0, meaningfulLines.length - previewLines.length),
		refIds: [...previewRefIds],
		lines: previewLines.map((line) => formatPreviewLine(line, rootDepth)),
	};
}

function buildFallbackSnapshotOutline(snapshotLines: SnapshotLine[]): SnapshotPreview {
	const selected = new Set<number>();
	for (let index = 0; index < snapshotLines.length && selected.size < 4; index += 1) {
		if (!isNoiseSnapshotLine(snapshotLines[index])) selected.add(index);
	}
	for (let index = 0; index < snapshotLines.length && selected.size < SNAPSHOT_FALLBACK_PREVIEW_MAX_LINES; index += 1) {
		const line = snapshotLines[index];
		if (isNoiseSnapshotLine(line)) continue;
		if (SNAPSHOT_SIGNAL_ROLES.has(line.role) || line.ref || line.name.length > 0) {
			selected.add(index);
		}
	}
	const chosenLines = [...selected]
		.sort((left, right) => left - right)
		.slice(0, SNAPSHOT_FALLBACK_PREVIEW_MAX_LINES)
		.map((index) => snapshotLines[index]);
	return {
		omittedCount: Math.max(0, snapshotLines.length - chosenLines.length),
		refIds: chosenLines.flatMap((line) => (line.ref ? [line.ref] : [])),
		lines: chosenLines.map((line) => truncateText(line.raw, SNAPSHOT_LINE_MAX_CHARS)),
	};
}

function buildRefLineOrderMap(snapshotLines: SnapshotLine[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const line of snapshotLines) {
		if (!line.ref || map.has(line.ref)) continue;
		map.set(line.ref, line.index);
	}
	return map;
}

function isEditableSnapshotLine(line: SnapshotLine): boolean | undefined {
	const editableEvidence = getEditableRefEvidence({ text: line.raw });
	if (editableEvidence !== undefined) return editableEvidence;
	return line.role === "searchbox" || line.role === "textbox" || line.role === "combobox" ? true : undefined;
}

function enrichSnapshotRefEntries(refEntries: SnapshotRefEntry[], snapshotLines: SnapshotLine[]): SnapshotRefEntry[] {
	const lineByRef = new Map<string, SnapshotLine>();
	for (const line of snapshotLines) {
		if (!line.ref || lineByRef.has(line.ref)) continue;
		lineByRef.set(line.ref, line);
	}

	return refEntries.map((entry) => {
		const line = lineByRef.get(entry.id);
		const lineRole = line && line.role !== "unknown" ? line.role : undefined;
		const editableEvidence = getEditableRefEvidence({ ref: entry.refData, text: line?.raw });
		const hasEditableRole = line ? isEditableSnapshotLine(line) === true && !["unknown", "generic"].includes(line.role) : false;
		const isEditable = editableEvidence === true || (editableEvidence !== false && hasEditableRole);
		const roleFromRefOrLine = entry.role !== "unknown" && entry.role !== "generic" ? entry.role : lineRole ?? entry.role;
		const role = isEditable && (roleFromRefOrLine === "unknown" || roleFromRefOrLine === "generic") ? "textbox" : roleFromRefOrLine;
		return {
			...entry,
			isEditable,
			lineIndex: line?.index,
			name: entry.name.length > 0 ? entry.name : (line?.name ?? ""),
			role,
		} satisfies SnapshotRefEntry;
	});
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

		const rolePriority = getRolePriority(left.role) - getRolePriority(right.role);
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

function getHighValueControlRole(entry: SnapshotRefEntry): string {
	return entry.isEditable === true && (entry.role === "unknown" || entry.role === "generic") ? "textbox" : entry.role;
}

function isEditableControlRef(entry: SnapshotRefEntry): boolean {
	if (entry.isEditable === false) return false;
	const role = getHighValueControlRole(entry);
	return entry.isEditable === true || role === "searchbox" || role === "textbox" || role === "combobox";
}

function isNamedSurfaceControlRef(entry: SnapshotRefEntry): boolean {
	if (entry.name.length === 0) return false;
	const role = getHighValueControlRole(entry);
	if (role === "tab") return true;
	if (role !== "button" && role !== "menuitem" && role !== "option") return false;
	return SNAPSHOT_SURFACE_CONTROL_NAME_PATTERNS.some((pattern) => pattern.test(entry.name));
}

function isPrimaryActionButtonRef(entry: SnapshotRefEntry): boolean {
	return (
		getHighValueControlRole(entry) === "button" &&
		entry.name.length > 0 &&
		SNAPSHOT_PRIMARY_ACTION_BUTTON_NAME_PATTERNS.some((pattern) => pattern.test(entry.name))
	);
}

type HighValueControlCategory = "editable" | "named-surface" | "primary-action" | "role";

interface HighValueControlCategoryRule {
	bucketKey(entry: SnapshotRefEntry, role: string): string;
	fillTarget?: number;
	id: HighValueControlCategory;
	matches(entry: SnapshotRefEntry, role: string): boolean;
	priority: number;
}

interface HighValueControlScore {
	category: HighValueControlCategory;
	categoryPriority: number;
	diversityBucketKey: string;
	fillTarget?: number;
	lineIndex: number;
	namePriority: 0 | 1;
	refId: string;
	role: string;
	rolePriority: number;
	roundRobinBucketKey: string;
}

interface HighValueControlCandidate {
	entry: SnapshotRefEntry;
	score: HighValueControlScore;
}

const SNAPSHOT_HIGH_VALUE_CONTROL_CATEGORY_RULES: readonly HighValueControlCategoryRule[] = [
	{
		bucketKey: () => "editable",
		fillTarget: SNAPSHOT_HIGH_VALUE_EDITABLE_REF_FILL_TARGET_LINES,
		id: "editable",
		matches: (entry) => isEditableControlRef(entry),
		priority: 0,
	},
	{
		bucketKey: () => "named-surface",
		fillTarget: SNAPSHOT_HIGH_VALUE_SURFACE_REF_FILL_TARGET_LINES,
		id: "named-surface",
		matches: (entry) => isNamedSurfaceControlRef(entry),
		priority: 1,
	},
	{
		bucketKey: () => "primary-action",
		fillTarget: SNAPSHOT_HIGH_VALUE_PRIMARY_ACTION_REF_FILL_TARGET_LINES,
		id: "primary-action",
		matches: (entry) => isPrimaryActionButtonRef(entry),
		priority: 2,
	},
	{
		bucketKey: (_entry, role) => role,
		id: "role",
		matches: () => true,
		priority: 3,
	},
] as const;

function isEligibleHighValueControlRef(entry: SnapshotRefEntry, role: string): boolean {
	if (!SNAPSHOT_HIGH_VALUE_CONTROL_ROLES.has(role)) return false;
	if (entry.isEditable === false && (role === "searchbox" || role === "textbox" || role === "combobox")) return false;
	if (isNoiseName(entry.name) || isChromeSectionName(entry.name)) return false;
	return entry.name.length > 0 || isEditableControlRef(entry);
}

function getHighValueControlCategoryRule(entry: SnapshotRefEntry, role: string): HighValueControlCategoryRule | undefined {
	return SNAPSHOT_HIGH_VALUE_CONTROL_CATEGORY_RULES.find((rule) => rule.matches(entry, role));
}

function classifyHighValueControlRef(entry: SnapshotRefEntry): HighValueControlCandidate | undefined {
	const role = getHighValueControlRole(entry);
	if (!isEligibleHighValueControlRef(entry, role)) return undefined;

	const rule = getHighValueControlCategoryRule(entry, role);
	if (!rule) return undefined;

	return {
		entry,
		score: {
			category: rule.id,
			categoryPriority: rule.priority,
			diversityBucketKey: `${rule.priority}:${rule.bucketKey(entry, role)}`,
			fillTarget: rule.fillTarget,
			lineIndex: entry.lineIndex ?? Number.MAX_SAFE_INTEGER,
			namePriority: entry.name.length > 0 ? 0 : 1,
			refId: entry.id,
			role,
			rolePriority: SNAPSHOT_HIGH_VALUE_CONTROL_ROLE_PRIORITY[role] ?? 50,
			roundRobinBucketKey: `${rule.priority}:${role}`,
		},
	};
}

function compareHighValueControlCandidates(left: HighValueControlCandidate, right: HighValueControlCandidate): number {
	return (
		left.score.categoryPriority - right.score.categoryPriority ||
		left.score.rolePriority - right.score.rolePriority ||
		left.score.namePriority - right.score.namePriority ||
		left.score.lineIndex - right.score.lineIndex ||
		compareRefIds(left.score.refId, right.score.refId)
	);
}

function takeHighValueCandidate(
	candidate: HighValueControlCandidate,
	selected: HighValueControlCandidate[],
	selectedIds: Set<string>,
): void {
	selected.push(candidate);
	selectedIds.add(candidate.entry.id);
}

function takeFirstPerDiversityBucket(
	candidates: HighValueControlCandidate[],
	selected: HighValueControlCandidate[],
	selectedIds: Set<string>,
	limit: number,
): void {
	const seenBuckets = new Set<string>();
	for (const candidate of candidates) {
		if (selected.length >= limit) break;
		if (seenBuckets.has(candidate.score.diversityBucketKey)) continue;
		seenBuckets.add(candidate.score.diversityBucketKey);
		takeHighValueCandidate(candidate, selected, selectedIds);
	}
}

function topUpHighValueCategory(
	candidates: HighValueControlCandidate[],
	selected: HighValueControlCandidate[],
	selectedIds: Set<string>,
	category: HighValueControlCategory,
	target: number,
	limit: number,
): void {
	let count = selected.filter((candidate) => candidate.score.category === category).length;
	for (const candidate of candidates) {
		if (selected.length >= limit || count >= target) break;
		if (selectedIds.has(candidate.entry.id) || candidate.score.category !== category) continue;
		takeHighValueCandidate(candidate, selected, selectedIds);
		count += 1;
	}
}

function buildRemainingHighValueBuckets(
	candidates: HighValueControlCandidate[],
	selectedIds: Set<string>,
): HighValueControlCandidate[][] {
	const buckets = new Map<string, HighValueControlCandidate[]>();
	for (const candidate of candidates) {
		if (selectedIds.has(candidate.entry.id)) continue;
		const bucket = buckets.get(candidate.score.roundRobinBucketKey);
		if (bucket) bucket.push(candidate);
		else buckets.set(candidate.score.roundRobinBucketKey, [candidate]);
	}
	return [...buckets.values()].sort((left, right) => compareHighValueControlCandidates(left[0], right[0]));
}

function roundRobinHighValueBuckets(
	buckets: HighValueControlCandidate[][],
	selected: HighValueControlCandidate[],
	selectedIds: Set<string>,
	limit: number,
): void {
	let bucketIndex = 0;
	while (selected.length < limit && buckets.some((bucket) => bucket.length > 0)) {
		const bucket = buckets[bucketIndex % buckets.length];
		const candidate = bucket.shift();
		if (candidate) takeHighValueCandidate(candidate, selected, selectedIds);
		bucketIndex += 1;
	}
}

function selectHighValueControlEntries(entries: SnapshotRefEntry[], limit: number): SnapshotRefEntry[] {
	const candidates = entries
		.map(classifyHighValueControlRef)
		.filter((candidate): candidate is HighValueControlCandidate => Boolean(candidate))
		.sort(compareHighValueControlCandidates);
	const selected: HighValueControlCandidate[] = [];
	const selectedIds = new Set<string>();

	takeFirstPerDiversityBucket(candidates, selected, selectedIds, limit);

	// Diversity runs first so scarce lower-role controls stay visible; fill targets only top up dominant classes when capacity remains.
	for (const rule of SNAPSHOT_HIGH_VALUE_CONTROL_CATEGORY_RULES) {
		if (rule.fillTarget === undefined) continue;
		topUpHighValueCategory(candidates, selected, selectedIds, rule.id, rule.fillTarget, limit);
	}

	roundRobinHighValueBuckets(buildRemainingHighValueBuckets(candidates, selectedIds), selected, selectedIds, limit);
	return selected.map((candidate) => candidate.entry);
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

function canUseStructuredSnapshotPreview(snapshotLines: SnapshotLine[], refEntries: SnapshotRefEntry[]): boolean {
	if (snapshotLines.length === 0) return false;
	const linesWithRecognizedRoles = snapshotLines.filter((line) => line.role !== "unknown").length;
	const linesWithNames = snapshotLines.filter((line) => line.name.length > 0).length;
	const parsedRefIds = new Set(snapshotLines.flatMap((line) => (line.ref ? [line.ref] : [])));
	return (
		linesWithRecognizedRoles >= Math.min(snapshotLines.length, 3) ||
		linesWithNames >= Math.min(snapshotLines.length, 3) ||
		parsedRefIds.size >= Math.min(refEntries.length, 3)
	);
}

interface SnapshotSpillWriteResult {
	evictedArtifacts: PersistentSessionArtifactEviction[];
	path: string;
	storageScope: "persistent-session" | "process-temp";
}

async function writeSnapshotSpillFile(
	data: Record<string, unknown>,
	persistentArtifactStore: PersistentSessionArtifactStore | undefined,
): Promise<SnapshotSpillWriteResult> {
	const options = {
		content: JSON.stringify(data, null, 2),
		prefix: SNAPSHOT_SPILL_FILE_PREFIX,
		suffix: ".json",
	};
	if (persistentArtifactStore) {
		const result = await writePersistentSessionArtifactFile({ ...options, store: persistentArtifactStore });
		return { ...result, storageScope: "persistent-session" };
	}
	return { evictedArtifacts: [], path: await writeSecureTempFile(options), storageScope: "process-temp" };
}

function applySnapshotArtifactManifest(options: {
	baseManifest?: SessionArtifactManifest;
	command?: string;
	fullOutputPath?: string;
	spill?: SnapshotSpillWriteResult;
}): { artifactManifest?: SessionArtifactManifest; artifactRetentionSummary?: string } {
	if (!options.fullOutputPath || !options.spill) return {};
	const nowMs = Date.now();
	const entries: SessionArtifactManifestEntry[] = [
		{
			command: options.command,
			createdAtMs: nowMs,
			kind: "spill",
			path: options.fullOutputPath,
			retentionState: options.spill.storageScope === "persistent-session" ? "live" : "ephemeral",
			storageScope: options.spill.storageScope,
		},
		...buildEvictedSessionArtifactEntries(options.spill.evictedArtifacts, nowMs),
	];
	const artifactManifest = mergeSessionArtifactManifest({ base: options.baseManifest, entries, nowMs });
	return artifactManifest ? { artifactManifest, artifactRetentionSummary: formatSessionArtifactRetentionSummary(artifactManifest) } : {};
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
	const omittedHighValueControlEntries = visibleRankedRefEntries.filter((entry) => !displayedRefIdSet.has(entry.id));
	const visibleHighValueControlEntries = selectHighValueControlEntries(omittedHighValueControlEntries, SNAPSHOT_HIGH_VALUE_REF_MAX_LINES);
	const omittedHighValueControls = Math.max(0, omittedHighValueControlEntries.length - visibleHighValueControlEntries.length);
	const omittedNonHighlightedRefs = Math.max(
		0,
		visibleRankedRefEntries.length - keyRefEntries.length - otherRefEntries.length - omittedHighValueControlEntries.length,
	);
	const origin = getSnapshotOrigin(data);

	const lines: string[] = [
		`Origin: ${origin}`,
		`Refs: ${refEntries.length}`,
		...(roleCountsText ? [`Top roles: ${roleCountsText}`] : []),
		"",
		"Compact snapshot view.",
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
