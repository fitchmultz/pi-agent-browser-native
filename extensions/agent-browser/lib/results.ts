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
const SNAPSHOT_OUTLINE_MAX_LINES = 18;
const SNAPSHOT_KEY_REF_MAX_LINES = 28;
const SNAPSHOT_OTHER_REF_MAX_LINES = 24;
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
const SNAPSHOT_ROLE_PRIORITY: Record<string, number> = {
	article: 0,
	dialog: 1,
	menu: 2,
	menuitem: 3,
	region: 4,
	main: 5,
	heading: 6,
	navigation: 7,
	button: 8,
	textbox: 9,
	combobox: 10,
	checkbox: 11,
	radio: 12,
	tab: 13,
	option: 14,
	link: 15,
	listitem: 16,
	row: 17,
	gridcell: 18,
	generic: 99,
};

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
	return `${text.slice(0, maxChars - 1)}…`;
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

function compareRefIds(left: string, right: string): number {
	const leftMatch = left.match(/^(?:[a-zA-Z]+)?(\d+)$/);
	const rightMatch = right.match(/^(?:[a-zA-Z]+)?(\d+)$/);
	if (leftMatch && rightMatch) {
		return Number(leftMatch[1]) - Number(rightMatch[1]);
	}
	return left.localeCompare(right);
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

function getRolePriority(role: string): number {
	return SNAPSHOT_ROLE_PRIORITY[role] ?? 50;
}

function isSignalSnapshotLine(line: string): boolean {
	const trimmed = line.trimStart();
	const roleMatch = trimmed.match(/^-\s+([^\s"]+)/);
	const role = roleMatch?.[1];
	if (!role) return false;
	if (SNAPSHOT_SIGNAL_ROLES.has(role)) return true;
	return /\[ref=/.test(trimmed) && /".+"/.test(trimmed);
}

function getSnapshotIndentDepth(line: string): number {
	const indent = line.match(/^\s*/)?.[0].length ?? 0;
	return Math.floor(indent / 2);
}

function buildCompactSnapshotOutline(snapshot: string): string[] {
	const lines = snapshot.split("\n").filter((line) => line.length > 0);
	if (lines.length <= SNAPSHOT_OUTLINE_MAX_LINES) {
		return lines.map((line) => truncateText(line, SNAPSHOT_LINE_MAX_CHARS));
	}

	const selected = new Set<number>();
	for (let index = 0; index < lines.length && selected.size < Math.min(6, SNAPSHOT_OUTLINE_MAX_LINES); index += 1) {
		selected.add(index);
	}

	for (let index = 0; index < lines.length && selected.size < SNAPSHOT_OUTLINE_MAX_LINES; index += 1) {
		if (isSignalSnapshotLine(lines[index])) {
			selected.add(index);
		}
	}

	for (let index = 0; index < lines.length && selected.size < SNAPSHOT_OUTLINE_MAX_LINES; index += 1) {
		if (getSnapshotIndentDepth(lines[index]) <= 1) {
			selected.add(index);
		}
	}

	return [...selected]
		.sort((left, right) => left - right)
		.slice(0, SNAPSHOT_OUTLINE_MAX_LINES)
		.map((index) => truncateText(lines[index], SNAPSHOT_LINE_MAX_CHARS));
}

function compareRefsBySignal(left: SnapshotRefEntry, right: SnapshotRefEntry): number {
	const rolePriority = getRolePriority(left.role) - getRolePriority(right.role);
	if (rolePriority !== 0) return rolePriority;
	if ((left.name.length > 0) !== (right.name.length > 0)) {
		return left.name.length > 0 ? -1 : 1;
	}
	if (left.name !== right.name) {
		return left.name.localeCompare(right.name);
	}
	return compareRefIds(left.id, right.id);
}

function formatCompactRef(entry: SnapshotRefEntry): string {
	const suffix = entry.name.length > 0 ? ` "${truncateText(entry.name, SNAPSHOT_NAME_MAX_CHARS)}"` : "";
	return `- ${entry.id} ${entry.role}${suffix}`;
}

function shouldCompactSnapshot(rawText: string, data: Record<string, unknown>): boolean {
	const snapshot = getSnapshotText(data) ?? "";
	const refEntries = getSnapshotRefEntries(data);
	return rawText.length > SNAPSHOT_INLINE_MAX_CHARS || countLines(snapshot) > SNAPSHOT_INLINE_MAX_LINES || refEntries.length > 60;
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
	const outlineLines = buildCompactSnapshotOutline(snapshot);
	const rankedRefs = [...refEntries].sort(compareRefsBySignal);
	const keyRefs = rankedRefs.slice(0, SNAPSHOT_KEY_REF_MAX_LINES);
	const keyRefIds = new Set(keyRefs.map((entry) => entry.id));
	const remainingRefs = refEntries.filter((entry) => !keyRefIds.has(entry.id));
	const shownOtherRefs = remainingRefs.slice(0, SNAPSHOT_OTHER_REF_MAX_LINES);
	const omittedSnapshotLines = Math.max(0, countLines(snapshot) - outlineLines.length);
	const omittedRefs = Math.max(0, remainingRefs.length - shownOtherRefs.length);
	const origin = getSnapshotOrigin(data);

	const lines = [
		`Origin: ${origin}`,
		`Refs: ${refEntries.length}`,
		...(roleCountsText ? [`Roles: ${roleCountsText}`] : []),
		"",
		`Compact snapshot view. Full raw snapshot: ${fullOutputPath}`,
		"",
		"Key structure:",
		...(outlineLines.length > 0 ? outlineLines : ["(no interactive elements)"]),
		...(omittedSnapshotLines > 0
			? [`- ... (${omittedSnapshotLines} additional snapshot lines omitted; use read on the full snapshot file for everything)`]
			: []),
		"",
		"Key refs:",
		...(keyRefs.length > 0 ? keyRefs.map(formatCompactRef) : ["(no refs)"]),
	];

	if (shownOtherRefs.length > 0) {
		lines.push("", "Other refs:", ...shownOtherRefs.map(formatCompactRef));
	}
	if (omittedRefs > 0) {
		lines.push(`- ... (${omittedRefs} additional refs in the full snapshot file)`);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		data: {
			compacted: true,
			fullOutputPath,
			origin,
			previewRefs: keyRefs,
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
