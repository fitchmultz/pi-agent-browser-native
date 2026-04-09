/**
 * Purpose: Turn upstream agent-browser JSON output into pi-friendly tool content and details.
 * Responsibilities: Parse the upstream JSON envelope, format content text for the model, derive concise summaries, compact oversized snapshot output into a browser-aware preview, and attach inline image artifacts when the result points to an image file.
 * Scope: Output shaping only; subprocess execution and pi tool registration live elsewhere.
 * Usage: Imported by the extension entrypoint after the upstream command has finished executing.
 * Invariants/Assumptions: Upstream `agent-browser --json` responses follow the `{ success, data, error }` envelope shape observed on the local development machine.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandInfo } from "./runtime.js";
import { getImageMimeType } from "./runtime.js";

const SNAPSHOT_INLINE_MAX_CHARS = 6_000;
const SNAPSHOT_INLINE_MAX_LINES = 80;
const SNAPSHOT_INLINE_MAX_REFS = 60;
const SNAPSHOT_PRIMARY_PREVIEW_LINES = 10;
const SNAPSHOT_SECTION_PREVIEW_LINES = 4;
const SNAPSHOT_MAX_ADDITIONAL_SECTIONS = 5;
const SNAPSHOT_KEY_REF_MAX_LINES = 20;
const SNAPSHOT_OTHER_REF_MAX_LINES = 12;
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
	button: 6,
	textbox: 7,
	combobox: 8,
	checkbox: 9,
	radio: 10,
	tab: 11,
	option: 12,
	link: 13,
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

export interface AgentBrowserEnvelope {
	data?: unknown;
	error?: unknown;
	success?: boolean;
}

export interface AgentBrowserBatchResult {
	command?: string[];
	error?: unknown;
	result?: unknown;
	success?: boolean;
}

export interface ToolPresentation {
	content: Array<{ text: string; type: "text" } | { data: string; mimeType: string; type: "image" }>;
	data?: unknown;
	fullOutputPath?: string;
	imagePath?: string;
	summary: string;
}

interface SnapshotRefEntry {
	id: string;
	name: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function getSnapshotText(data: Record<string, unknown>): string | undefined {
	return typeof data.snapshot === "string" ? data.snapshot : undefined;
}

function getTabSummary(data: Record<string, unknown>): string | undefined {
	const tabs = Array.isArray(data.tabs) ? data.tabs : undefined;
	if (!tabs) return undefined;

	const lines = tabs.map((tab, index) => {
		if (!isRecord(tab)) return `${index}: <invalid tab>`;
		const marker = tab.active === true ? "*" : "-";
		const title = typeof tab.title === "string" ? tab.title : "(untitled)";
		const url = typeof tab.url === "string" ? tab.url : "(no url)";
		const tabIndex = typeof tab.index === "number" ? tab.index : index;
		return `${marker} [${tabIndex}] ${title} — ${url}`;
	});
	return lines.join("\n");
}

function getStreamSummary(data: Record<string, unknown>): string | undefined {
	if (typeof data.enabled !== "boolean" || typeof data.connected !== "boolean") {
		return undefined;
	}

	const lines = [
		`Enabled: ${data.enabled}`,
		`Connected: ${data.connected}`,
		`Screencasting: ${data.screencasting === true}`,
	];
	if (typeof data.port === "number") {
		lines.push(`Port: ${data.port}`);
	}
	return lines.join("\n");
}

function getPageSummary(data: Record<string, unknown>): string | undefined {
	const title = typeof data.title === "string" ? data.title : undefined;
	const url = typeof data.url === "string" ? data.url : undefined;
	if (!title && !url) return undefined;
	if (title && url) return `${title}\n${url}`;
	return title ?? url;
}

function getScreenshotSummary(data: Record<string, unknown>): string | undefined {
	return typeof data.path === "string" ? `Saved image: ${data.path}` : undefined;
}

function formatBatchContent(data: AgentBrowserBatchResult[]): string {
	return data
		.map((item, index) => {
			const command = Array.isArray(item.command) ? item.command.join(" ") : `step-${index + 1}`;
			if (item.success === false) {
				return `${command}\nError: ${stringifyUnknown(item.error)}`;
			}
			return `${command}\n${stringifyUnknown(item.result)}`;
		})
		.join("\n\n");
}

function formatSummary(commandInfo: CommandInfo, data: unknown): string {
	if (Array.isArray(data) && commandInfo.command === "batch") {
		const successCount = data.filter((item) => isRecord(item) && item.success !== false).length;
		return `Batch: ${successCount}/${data.length} succeeded`;
	}
	if (isRecord(data)) {
		if (commandInfo.command === "snapshot") {
			const origin = typeof data.origin === "string" ? data.origin : "page";
			const refs = isRecord(data.refs) ? Object.keys(data.refs).length : 0;
			return `Snapshot: ${refs} refs on ${origin}`;
		}
		if (commandInfo.command === "tab" && Array.isArray(data.tabs)) {
			return `Tabs: ${data.tabs.length}`;
		}
		if (commandInfo.command === "stream" && commandInfo.subcommand === "status") {
			const port = typeof data.port === "number" ? ` on port ${data.port}` : "";
			return `Stream ${data.enabled === true ? "enabled" : "disabled"}${port}`;
		}
		if (commandInfo.command === "screenshot" && typeof data.path === "string") {
			return `Screenshot saved: ${data.path}`;
		}
		const pageSummary = getPageSummary(data);
		if (pageSummary) {
			return pageSummary.split("\n", 1)[0] ?? "agent-browser result";
		}
	}

	if (typeof data === "string" && data.length > 0) {
		return data.split("\n", 1)[0] ?? data;
	}

	const primaryCommand = commandInfo.command ?? "agent-browser";
	return `${primaryCommand} completed`;
}

function getSnapshotOrigin(data: Record<string, unknown>): string {
	return typeof data.origin === "string" ? data.origin : "(unknown origin)";
}

function formatRawSnapshotText(data: Record<string, unknown>): string {
	const origin = getSnapshotOrigin(data);
	const refs = isRecord(data.refs) ? Object.keys(data.refs).length : 0;
	const snapshot = getSnapshotText(data);
	if (!snapshot) {
		return `Origin: ${origin}\nRefs: ${refs}\n\n(no interactive elements)`;
	}
	return `Origin: ${origin}\nRefs: ${refs}\n\n${snapshot}`;
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function formatPreviewLine(line: SnapshotLine, baseDepth: number): string {
	const leadingWhitespace = (line.raw.match(/^\s*/) ?? [""])[0].length;
	const stripChars = Math.min(leadingWhitespace, Math.max(0, baseDepth) * 2);
	return truncateText(line.raw.slice(stripChars), SNAPSHOT_LINE_MAX_CHARS);
}

function compareRefIds(left: string, right: string): number {
	const leftMatch = left.match(/^(?:[a-zA-Z]+)?(\d+)$/);
	const rightMatch = right.match(/^(?:[a-zA-Z]+)?(\d+)$/);
	if (leftMatch && rightMatch) {
		return Number(leftMatch[1]) - Number(rightMatch[1]);
	}
	return left.localeCompare(right);
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
			return { id, name, role } satisfies SnapshotRefEntry;
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
	return ordered.map(([role, count]) => `${role} ${count}`).join(", ");
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
	for (let index = 0; index < snapshotLines.length && selected.size < 6; index += 1) {
		if (!isNoiseSnapshotLine(snapshotLines[index])) selected.add(index);
	}
	for (let index = 0; index < snapshotLines.length && selected.size < 18; index += 1) {
		const line = snapshotLines[index];
		if (isNoiseSnapshotLine(line)) continue;
		if (SNAPSHOT_SIGNAL_ROLES.has(line.role)) {
			selected.add(index);
		}
	}
	const chosenLines = [...selected]
		.sort((left, right) => left - right)
		.slice(0, 18)
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

function shouldCompactSnapshot(rawText: string, data: Record<string, unknown>): boolean {
	const snapshot = getSnapshotText(data) ?? "";
	const refEntries = getSnapshotRefEntries(data);
	return (
		rawText.length > SNAPSHOT_INLINE_MAX_CHARS ||
		countLines(snapshot) > SNAPSHOT_INLINE_MAX_LINES ||
		refEntries.length > SNAPSHOT_INLINE_MAX_REFS
	);
}

async function writeSnapshotSpillFile(data: Record<string, unknown>): Promise<string> {
	const path = join(tmpdir(), `${SNAPSHOT_SPILL_FILE_PREFIX}-${randomBytes(8).toString("hex")}.json`);
	await writeFile(path, JSON.stringify(data, null, 2), "utf8");
	return path;
}

async function buildSnapshotPresentation(data: Record<string, unknown>): Promise<ToolPresentation> {
	const summary = formatSummary({ command: "snapshot" }, data);
	const rawText = formatRawSnapshotText(data);
	if (!shouldCompactSnapshot(rawText, data)) {
		return {
			content: [{ type: "text", text: rawText }],
			data,
			summary,
		};
	}

	const fullOutputPath = await writeSnapshotSpillFile(data);
	const refEntries = getSnapshotRefEntries(data);
	const roleCounts = getSnapshotRoleCounts(refEntries);
	const roleCountsText = formatRoleCounts(roleCounts);
	const snapshot = getSnapshotText(data) ?? "(no interactive elements)";
	const snapshotLines = parseSnapshotLines(snapshot);
	const snapshotSegments = buildSnapshotSegments(snapshotLines);
	const primarySegment = choosePrimarySegment(snapshotSegments);
	const additionalSegments = chooseAdditionalSegments(snapshotSegments, primarySegment);
	const primaryPreview = primarySegment ? buildSegmentPreview(primarySegment, SNAPSHOT_PRIMARY_PREVIEW_LINES) : undefined;
	const additionalPreviews = additionalSegments
		.map((segment) => ({
			preview: buildSegmentPreview(segment, SNAPSHOT_SECTION_PREVIEW_LINES),
			segment,
		}))
		.filter(({ preview }) => preview.lines.length > 0);
	const fallbackPreview =
		!primaryPreview || primaryPreview.lines.length === 0 ? buildFallbackSnapshotOutline(snapshotLines) : undefined;

	const previewRefIds = new Set<string>([
		...(primaryPreview?.refIds ?? []),
		...additionalPreviews.flatMap(({ preview }) => preview.refIds),
		...(fallbackPreview?.refIds ?? []),
	]);
	const focusRefIds = new Set<string>([
		...(primarySegment ? getMeaningfulSegmentLines(primarySegment).flatMap((line) => (line.ref ? [line.ref] : [])) : []),
		...additionalSegments.flatMap((segment) => getMeaningfulSegmentLines(segment).flatMap((line) => (line.ref ? [line.ref] : []))),
		...(fallbackPreview?.refIds ?? []),
	]);
	const lineOrderByRef = buildRefLineOrderMap(snapshotLines);
	const rankedRefEntries = rankRefEntries(refEntries, previewRefIds, focusRefIds, lineOrderByRef);
	const visibleRankedRefEntries = rankedRefEntries.filter(
		(entry) => !isNoiseName(entry.name) && !isChromeSectionName(entry.name) && !(entry.role === "heading" && entry.name.length <= 2),
	);
	const keyRefEntries = visibleRankedRefEntries.slice(0, SNAPSHOT_KEY_REF_MAX_LINES);
	const keyRefIdSet = new Set(keyRefEntries.map((entry) => entry.id));
	const otherRefEntries = visibleRankedRefEntries
		.filter((entry) => !keyRefIdSet.has(entry.id))
		.slice(0, SNAPSHOT_OTHER_REF_MAX_LINES);
	const omittedOtherRefs = Math.max(0, visibleRankedRefEntries.length - keyRefEntries.length - otherRefEntries.length);
	const origin = getSnapshotOrigin(data);

	const lines: string[] = [
		`Origin: ${origin}`,
		`Refs: ${refEntries.length}`,
		...(roleCountsText ? [`Roles: ${roleCountsText}`] : []),
		"",
		`Compact snapshot view. Full raw snapshot: ${fullOutputPath}`,
	];

	if (fallbackPreview) {
		lines.push(
			"",
			"Compact outline:",
			...(fallbackPreview.lines.length > 0 ? fallbackPreview.lines : ["(no interactive elements)"]),
		);
		if (fallbackPreview.omittedCount > 0) {
			lines.push(`- ... (${fallbackPreview.omittedCount} additional snapshot lines omitted; use the spill file for everything)`);
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
		}
	}

	lines.push("", "Key refs:", ...(keyRefEntries.length > 0 ? keyRefEntries.map(formatCompactRef) : ["(no refs)"]));
	if (otherRefEntries.length > 0) {
		lines.push("", "Other refs:", ...otherRefEntries.map(formatCompactRef));
	}
	if (omittedOtherRefs > 0) {
		lines.push(`- ... (${omittedOtherRefs} additional refs in the full snapshot file)`);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		data: {
			compacted: true,
			fullOutputPath,
			origin,
			previewRefIds: [...previewRefIds],
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
		},
		fullOutputPath,
		summary: `${summary} (compact)`,
	};
}

function formatContentText(commandInfo: CommandInfo, data: unknown): string {
	if (Array.isArray(data) && commandInfo.command === "batch") {
		return formatBatchContent(data as AgentBrowserBatchResult[]);
	}
	if (typeof data === "string") {
		return data;
	}
	if (typeof data === "number" || typeof data === "boolean") {
		return String(data);
	}
	if (!isRecord(data)) {
		return stringifyUnknown(data);
	}

	if (commandInfo.command === "snapshot") {
		return formatRawSnapshotText(data);
	}
	if (commandInfo.command === "tab") {
		const tabSummary = getTabSummary(data);
		if (tabSummary) return tabSummary;
	}
	if (commandInfo.command === "stream" && commandInfo.subcommand === "status") {
		const streamSummary = getStreamSummary(data);
		if (streamSummary) return streamSummary;
	}
	if (commandInfo.command === "screenshot") {
		const screenshotSummary = getScreenshotSummary(data);
		if (screenshotSummary) return screenshotSummary;
	}

	const pageSummary = getPageSummary(data);
	if (pageSummary) {
		return pageSummary;
	}

	return stringifyUnknown(data);
}

export function parseAgentBrowserEnvelope(stdout: string): { envelope?: AgentBrowserEnvelope; parseError?: string } {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) {
		return { parseError: "agent-browser returned no JSON output." };
	}

	try {
		const parsed = JSON.parse(trimmed) as AgentBrowserEnvelope | AgentBrowserBatchResult[];
		if (Array.isArray(parsed)) {
			return { envelope: { success: parsed.every((item) => !isRecord(item) || item.success !== false), data: parsed } };
		}
		if (!isRecord(parsed)) {
			return { parseError: "agent-browser returned JSON, but it was not an object envelope." };
		}
		return { envelope: parsed };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { parseError: `agent-browser returned invalid JSON: ${message}` };
	}
}

export function getAgentBrowserErrorText(options: {
	aborted: boolean;
	envelope?: AgentBrowserEnvelope;
	exitCode: number;
	parseError?: string;
	plainTextInspection: boolean;
	spawnError?: Error;
	stderr: string;
}): string | undefined {
	const { aborted, envelope, exitCode, parseError, plainTextInspection, spawnError, stderr } = options;
	if (plainTextInspection) return undefined;
	if (parseError) return parseError;
	if (aborted) return "agent-browser was aborted.";
	if (spawnError) return spawnError.message;
	if (envelope?.success === false) {
		return typeof envelope.error === "string" ? envelope.error : JSON.stringify(envelope.error, null, 2);
	}
	if (exitCode !== 0) {
		return stderr.trim() || `agent-browser exited with code ${exitCode}.`;
	}
	return undefined;
}

export async function buildToolPresentation(options: {
	commandInfo: CommandInfo;
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	errorText?: string;
}): Promise<ToolPresentation> {
	const { commandInfo, cwd, envelope, errorText } = options;
	if (errorText) {
		return {
			content: [{ type: "text", text: errorText }],
			summary: errorText,
		};
	}

	const data = envelope?.data;
	const summary = formatSummary(commandInfo, data);
	const presentation =
		commandInfo.command === "snapshot" && isRecord(data)
			? await buildSnapshotPresentation(data)
			: {
					content: [{ type: "text" as const, text: formatContentText(commandInfo, data) }],
					data,
					summary,
			  };

	const imagePath = extractImagePath(cwd, data);
	if (!imagePath) {
		return presentation;
	}

	const mimeType = getImageMimeType(imagePath);
	if (!mimeType) {
		return presentation;
	}

	try {
		const file = await readFile(imagePath);
		presentation.content.push({ type: "image", data: file.toString("base64"), mimeType });
		presentation.imagePath = imagePath;
		return presentation;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		presentation.content[0] = {
			type: "text",
			text: `${presentation.content[0]?.type === "text" ? presentation.content[0].text : ""}\n\nImage attachment failed: ${message}`,
		};
		presentation.imagePath = imagePath;
		return presentation;
	}
}

function extractImagePath(cwd: string, data: unknown): string | undefined {
	if (typeof data === "string") {
		const mimeType = getImageMimeType(data);
		return mimeType ? resolve(cwd, data) : undefined;
	}
	if (!isRecord(data) || typeof data.path !== "string") {
		return undefined;
	}
	const mimeType = getImageMimeType(data.path);
	return mimeType ? resolve(cwd, data.path) : undefined;
}
