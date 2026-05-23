/**
 * Purpose: Parse raw agent-browser snapshot text into previewable sections.
 * Responsibilities: Identify signal lines, rank content segments, build structured previews, and provide raw-outline fallback previews.
 * Scope: Snapshot text/section planning only; ref enrichment, high-value control ranking, spill files, and final presentation live elsewhere.
 * Usage: Snapshot presentation uses this module before selecting displayed refs.
 * Invariants/Assumptions: Parsing is best-effort and must stay resilient to upstream snapshot text format changes.
 */

import type { SnapshotLineRefInfo, SnapshotRefEntry } from "./snapshot-refs.js";
import { normalizeWhitespace, truncateText } from "./text.js";

const SNAPSHOT_MAX_ADDITIONAL_SECTIONS = 2;
const SNAPSHOT_FALLBACK_PREVIEW_MAX_LINES = 12;
const SNAPSHOT_LINE_MAX_CHARS = 140;

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

export interface SnapshotLine extends SnapshotLineRefInfo {
	depth: number;
	headingLevel?: number;
	index: number;
	name: string;
	raw: string;
	ref?: string;
	role: string;
}

export interface SnapshotSegment {
	endIndexExclusive: number;
	lines: SnapshotLine[];
	root: SnapshotLine;
	score: number;
	startIndex: number;
}

export interface SnapshotPreview {
	omittedCount: number;
	refIds: string[];
	lines: string[];
}

export function getSnapshotRolePriority(role: string): number {
	return SNAPSHOT_ROLE_PRIORITY[role] ?? 50;
}

export function parseSnapshotLines(snapshot: string): SnapshotLine[] {
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

export function isNoiseName(name: string): boolean {
	return SNAPSHOT_NOISE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function isChromeSectionName(name: string): boolean {
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

	score += 120 - getSnapshotRolePriority(root.role) * 8;
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

export function buildSnapshotSegments(snapshotLines: SnapshotLine[]): SnapshotSegment[] {
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

export function choosePrimarySegment(segments: SnapshotSegment[]): SnapshotSegment | undefined {
	if (segments.length === 0) return undefined;
	return (
		segments.find((segment) => segment.root.role === "main" || segment.root.role === "article") ??
		segments.find((segment) => segment.root.role === "heading" && segment.root.headingLevel === 1) ??
		segments.find((segment) => segment.score >= 90) ??
		[...segments].sort((left, right) => right.score - left.score || left.startIndex - right.startIndex)[0]
	);
}

export function chooseAdditionalSegments(segments: SnapshotSegment[], primary: SnapshotSegment | undefined): SnapshotSegment[] {
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

export function getMeaningfulSegmentLines(segment: SnapshotSegment): SnapshotLine[] {
	return segment.lines.filter((line) => {
		if (isNoiseSnapshotLine(line)) return false;
		if (line.role === "generic" && !line.ref && line.name.length === 0) return false;
		if (line.role === "link" && line.name.length === 0) return false;
		return true;
	});
}

function formatPreviewLine(line: SnapshotLine, baseDepth: number): string {
	const leadingWhitespace = (line.raw.match(/^\s*/) ?? [""])[0].length;
	const stripChars = Math.min(leadingWhitespace, Math.max(0, baseDepth) * 2);
	return truncateText(line.raw.slice(stripChars), SNAPSHOT_LINE_MAX_CHARS);
}

export function buildSegmentPreview(segment: SnapshotSegment, maxLines: number): SnapshotPreview {
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

export function buildFallbackSnapshotOutline(snapshotLines: SnapshotLine[]): SnapshotPreview {
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

export function buildRefLineOrderMap(snapshotLines: SnapshotLine[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const line of snapshotLines) {
		if (!line.ref || map.has(line.ref)) continue;
		map.set(line.ref, line.index);
	}
	return map;
}

export function canUseStructuredSnapshotPreview(snapshotLines: SnapshotLine[], refEntries: SnapshotRefEntry[]): boolean {
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
