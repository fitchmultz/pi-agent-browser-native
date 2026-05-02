/**
 * Purpose: Render parsed agent-browser results into concise pi-facing summaries, text content, and optional inline image attachments.
 * Responsibilities: Format command summaries, delegate snapshot-specific rendering to the snapshot module, attach inline images within size limits, and keep generic record formatting distinct from envelope parsing.
 * Scope: Presentation shaping only; upstream stdout parsing and snapshot compaction internals live in separate modules.
 * Usage: Imported by the public `lib/results.ts` facade and consumed by the extension entrypoint after envelope parsing.
 * Invariants/Assumptions: Presentation logic should stay close to upstream data while remaining small enough to reason about without mixing in snapshot-parser or envelope-parser internals.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { isRecord, parsePositiveInteger } from "../parsing.js";
import { parseCommandInfo, redactSensitiveText, redactSensitiveValue, type CommandInfo } from "../runtime.js";
import {
	type PersistentSessionArtifactEviction,
	type PersistentSessionArtifactStore,
	writePersistentSessionArtifactFile,
	writeSecureTempFile,
} from "../temp.js";
import { detectConfirmationRequired, type ConfirmationRequiredPresentation } from "./confirmation.js";
import { buildSnapshotPresentation, formatRawSnapshotText, formatSnapshotSummary } from "./snapshot.js";
import {
	type AgentBrowserBatchResult,
	type AgentBrowserEnvelope,
	type BatchFailurePresentationDetails,
	type BatchStepPresentationDetails,
	type ArtifactStorageScope,
	type FileArtifactKind,
	type FileArtifactMetadata,
	type SavedFilePresentationDetails,
	type SessionArtifactManifest,
	type SessionArtifactManifestEntry,
	type ToolPresentation,
	buildEvictedSessionArtifactEntries,
	countLines,
	formatSessionArtifactRetentionSummary,
	mergeSessionArtifactManifest,
	stringifyUnknown,
	truncateText,
} from "./shared.js";

const IMAGE_EXTENSION_TO_MIME_TYPE: Record<string, string> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

const INLINE_IMAGE_MAX_BYTES_ENV = "PI_AGENT_BROWSER_INLINE_IMAGE_MAX_BYTES";
const DEFAULT_INLINE_IMAGE_MAX_BYTES = 5 * 1_024 * 1_024;
const NAVIGATION_SUMMARY_COMMANDS = new Set(["back", "click", "dblclick", "forward", "reload"]);
const NAVIGATION_SUMMARY_FIELD = "navigationSummary";
const LARGE_OUTPUT_INLINE_MAX_CHARS = 8_000;
const LARGE_OUTPUT_INLINE_MAX_LINES = 120;
const LARGE_OUTPUT_PREVIEW_MAX_CHARS = 2_500;
const LARGE_OUTPUT_PREVIEW_MAX_LINES = 40;
const LARGE_OUTPUT_FILE_PREFIX = "pi-agent-browser-output";
const DIAGNOSTIC_REQUEST_PREVIEW_LIMIT = 40;
const DIAGNOSTIC_LOG_PREVIEW_LIMIT = 80;
const NETWORK_BODY_PREVIEW_MAX_CHARS = 280;
const NETWORK_ERROR_PREVIEW_MAX_CHARS = 220;
const NETWORK_PREVIEW_FIELD_CANDIDATES = {
	request: ["postData"] as const,
	response: ["responseBody"] as const,
	error: ["error", "failureText", "errorText"] as const,
};
const AUTH_SHOW_SAFE_FIELDS = ["name", "profile", "url", "username", "createdAt", "updatedAt"] as const;

interface NavigationSummary {
	title?: string;
	url?: string;
}

function getImageMimeType(filePath: string): string | undefined {
	const extension = extname(filePath).toLowerCase();
	return IMAGE_EXTENSION_TO_MIME_TYPE[extension];
}

function getInlineImageMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInteger(env[INLINE_IMAGE_MAX_BYTES_ENV]) ?? DEFAULT_INLINE_IMAGE_MAX_BYTES;
}

function formatByteCount(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
	return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function appendPresentationNotice(presentation: ToolPresentation, message: string): void {
	const existingText = presentation.content[0]?.type === "text" ? presentation.content[0].text : "";
	presentation.content[0] = {
		type: "text",
		text: existingText.length > 0 ? `${existingText}\n\n${message}` : message,
	};
}

function shouldAppendArtifactRetentionNotice(entries: SessionArtifactManifestEntry[]): boolean {
	return entries.some((entry) => entry.retentionState === "evicted" || entry.storageScope !== "explicit-path");
}

function getManifestEntryKey(entry: SessionArtifactManifestEntry): string {
	return entry.storageScope === "explicit-path" && entry.absolutePath ? `${entry.storageScope}:${entry.absolutePath}` : `${entry.storageScope}:${entry.path}`;
}

function manifestHasNewNoticeWorthyEntries(base: SessionArtifactManifest | undefined, current: SessionArtifactManifest | undefined): boolean {
	if (!current) return false;
	const baseKeys = new Set((base?.entries ?? []).map(getManifestEntryKey));
	return current.entries.some((entry) => !baseKeys.has(getManifestEntryKey(entry)) && (entry.retentionState === "evicted" || entry.storageScope !== "explicit-path"));
}

function applyArtifactManifest(presentation: ToolPresentation, baseManifest: SessionArtifactManifest | undefined, entries: SessionArtifactManifestEntry[]): ToolPresentation {
	if (entries.length === 0) return presentation;
	const artifactManifest = mergeSessionArtifactManifest({ base: baseManifest, entries });
	if (!artifactManifest) return presentation;
	presentation.artifactManifest = artifactManifest;
	presentation.artifactRetentionSummary = formatSessionArtifactRetentionSummary(artifactManifest);
	if (shouldAppendArtifactRetentionNotice(entries)) {
		appendPresentationNotice(presentation, presentation.artifactRetentionSummary);
	}
	return presentation;
}

function stringifyModelFacing(value: unknown): string {
	return stringifyUnknown(redactSensitiveValue(value));
}

function redactModelFacingText(text: string): string {
	const parsed = parseJsonPreviewString(text);
	if (parsed !== text) {
		return stringifyModelFacing(parsed);
	}
	return redactSensitiveText(text);
}

function redactModelFacingTextIfSensitive(text: string): string {
	return /(?:@|\b(?:api[_-]?key|auth|authorization|basic|bearer|cookie|pass(?:word)?|secret|session[_-]?id|token)\b)/i.test(text)
		? redactModelFacingText(text)
		: text;
}

function getTabSummary(data: Record<string, unknown>): string | undefined {
	const tabs = Array.isArray(data.tabs) ? data.tabs : undefined;
	if (!tabs) return undefined;

	const lines = tabs.map((tab, index) => {
		if (!isRecord(tab)) return `${index}: <invalid tab>`;
		const marker = tab.active === true ? "*" : "-";
		const title = typeof tab.title === "string" ? tab.title : "(untitled)";
		const url = typeof tab.url === "string" ? tab.url : "(no url)";
		const tabSelector =
			typeof tab.tabId === "string" && tab.tabId.trim().length > 0
				? tab.tabId.trim()
				: typeof tab.label === "string" && tab.label.trim().length > 0
					? tab.label.trim()
					: typeof tab.index === "number"
						? String(tab.index)
						: String(index);
		return `${marker} [${tabSelector}] ${title} — ${url}`;
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
		lines.push(`WebSocket URL: ${getStreamWebSocketUrl(data.port)}`);
		lines.push(`Frame format: JSON messages with base64 JPEG frame data`);
	}
	return lines.join("\n");
}

function getStreamWebSocketUrl(port: number): string {
	return `ws://127.0.0.1:${port}`;
}

function enrichStreamStatusData(commandInfo: CommandInfo, data: unknown): unknown {
	if (commandInfo.command !== "stream" || commandInfo.subcommand !== "status" || !isRecord(data) || typeof data.port !== "number") {
		return data;
	}
	return {
		...data,
		frameFormat: "JSON messages with base64 JPEG frame data",
		wsUrl: getStreamWebSocketUrl(data.port),
	};
}

function getArrayField(data: Record<string, unknown>, key: string): unknown[] | undefined {
	return Array.isArray(data[key]) ? data[key] : undefined;
}

function getStringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function firstLine(value: string, maxChars = 160): string {
	return truncateText(value.split("\n", 1)[0] ?? value, maxChars);
}

function formatDiagnosticSummary(commandInfo: CommandInfo, data: Record<string, unknown>): string | undefined {
	if (commandInfo.command === "session") {
		const sessions = getArrayField(data, "sessions");
		if (sessions) return `Sessions: ${sessions.length}`;
		const session = getStringField(data, "session");
		if (session) return `Session: ${session}`;
	}

	if (commandInfo.command === "profiles") {
		const profiles = getArrayField(data, "profiles");
		if (profiles) return `Chrome profiles: ${profiles.length}`;
	}

	if (commandInfo.command === "auth") {
		const profiles = getArrayField(data, "profiles");
		if (profiles) return `Auth profiles: ${profiles.length}`;
		const name = getStringField(data, "name") ?? getStringField(data, "profile") ?? commandInfo.subcommand;
		if (name && commandInfo.subcommand === "show") return `Auth profile: ${name}`;
	}

	if (commandInfo.command === "network" && commandInfo.subcommand === "requests") {
		const requests = getArrayField(data, "requests");
		if (requests) return `Network requests: ${requests.length}`;
	}

	if (commandInfo.command === "console") {
		const messages = getArrayField(data, "messages");
		if (messages) return `Console messages: ${messages.length}`;
	}

	if (commandInfo.command === "errors") {
		const errors = getArrayField(data, "errors");
		if (errors) return `Page errors: ${errors.length}`;
	}

	if (commandInfo.command === "dashboard") {
		if (typeof data.port === "number") return `Dashboard running on port ${data.port}`;
		if (data.stopped === true) return "Dashboard stopped";
		if (data.stopped === false) {
			const reason = getStringField(data, "reason");
			return reason ? `Dashboard not stopped: ${reason}` : "Dashboard not stopped";
		}
	}

	if (commandInfo.command === "doctor") {
		const status = getStringField(data, "status") ?? getStringField(data, "result");
		if (status) return `Doctor: ${status}`;
		const checks = getArrayField(data, "checks") ?? getArrayField(data, "issues") ?? getArrayField(data, "problems");
		if (checks) return `Doctor: ${formatCount(checks.length, "item")}`;
	}

	return undefined;
}

function formatSessionText(data: Record<string, unknown>): string | undefined {
	const sessions = getArrayField(data, "sessions");
	if (sessions) {
		if (sessions.length === 0) return "No active sessions.";
		return sessions
			.map((item, index) => {
				if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
				const name = redactModelFacingText(getStringField(item, "name") ?? getStringField(item, "session") ?? getStringField(item, "id") ?? `(session ${index + 1})`);
				const active = item.active === true ? " *active*" : "";
				const details = [getStringField(item, "url"), getStringField(item, "title")]
					.flatMap((detail) => (detail ? [redactModelFacingTextIfSensitive(detail)] : []))
					.join(" — ");
				return details ? `${index + 1}. ${name}${active} — ${details}` : `${index + 1}. ${name}${active}`;
			})
			.join("\n");
	}
	const session = getStringField(data, "session");
	return session ? `Current session: ${redactModelFacingText(session)}` : undefined;
}

function formatProfilesText(profiles: unknown[], label: string): string {
	if (profiles.length === 0) return `No ${label}.`;
	return profiles
		.map((item, index) => {
			if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
			const name = redactModelFacingText(getStringField(item, "name") ?? getStringField(item, "profile") ?? `(unnamed ${index + 1})`);
			const directory = getStringField(item, "directory") ?? getStringField(item, "path");
			return directory ? `${index + 1}. ${name} (${redactModelFacingText(directory)})` : `${index + 1}. ${name}`;
		})
		.join("\n");
}

function formatSkillsListText(skills: unknown[]): string {
	if (skills.length === 0) return "No agent-browser skills found.";
	return skills
		.map((item, index) => {
			if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
			const name = redactModelFacingText(getStringField(item, "name") ?? `(skill ${index + 1})`);
			const description = getStringField(item, "description");
			return description ? `${index + 1}. ${name} — ${redactModelFacingText(description)}` : `${index + 1}. ${name}`;
		})
		.join("\n");
}

function getSkillContent(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (isRecord(data) && typeof data.content === "string") return data.content;
	if (!Array.isArray(data)) return undefined;
	const content = data.flatMap((item) => (isRecord(item) && typeof item.content === "string" ? [item.content] : []));
	return content.length > 0 ? content.join("\n\n") : undefined;
}

function splitShellWords(input: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let quote: 'single' | 'double' | undefined;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (quote === "single") {
			if (char === "'") quote = undefined;
			else current += char;
			continue;
		}
		if (quote === "double") {
			if (char === '"') quote = undefined;
			else if (char === "\\" && index + 1 < input.length) {
				index += 1;
				current += input[index];
			} else current += char;
			continue;
		}
		if (char === "'") {
			quote = "single";
			continue;
		}
		if (char === '"') {
			quote = "double";
			continue;
		}
		if (char === "\\" && index + 1 < input.length) {
			index += 1;
			current += input[index];
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote) return undefined;
	if (current.length > 0) words.push(current);
	return words;
}

function formatNativeAgentBrowserCall(args: string[], stdin?: string): string {
	return stdin === undefined
		? `agent_browser { "args": ${JSON.stringify(args)} }`
		: `agent_browser { "args": ${JSON.stringify(args)}, "stdin": ${JSON.stringify(stdin)} }`;
}

function formatNativeSkillContent(content: string): string {
	const lines = content.replace(/^allowed-tools:.*agent-browser.*\n?/gim, "").replace(/^```bash\s*$/gim, "```text").split("\n");
	const output: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const commandMatch = /^(\s*)agent-browser\s+(.+?)\s*$/.exec(line);
		if (!commandMatch) {
			output.push(line);
			continue;
		}
		const indent = commandMatch[1];
		const rawArgsText = commandMatch[2];
		const heredocMatch = /^(.*?)\s+(<<-?)['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/.exec(rawArgsText);
		const argsText = heredocMatch?.[1] ?? rawArgsText;
		const args = splitShellWords(argsText);
		if (!args) {
			output.push(line);
			continue;
		}
		if (!heredocMatch) {
			output.push(`${indent}${formatNativeAgentBrowserCall(args)}`);
			continue;
		}
		const stripsLeadingTabs = heredocMatch[2] === "<<-";
		const delimiter = heredocMatch[3];
		const stdinLines: string[] = [];
		let cursor = index + 1;
		while (cursor < lines.length) {
			const candidate = stripsLeadingTabs ? lines[cursor].replace(/^\t+/, "") : lines[cursor];
			if (candidate === delimiter) break;
			stdinLines.push(candidate);
			cursor += 1;
		}
		if (cursor >= lines.length) {
			output.push(line);
			continue;
		}
		output.push(`${indent}${formatNativeAgentBrowserCall(args, stdinLines.join("\n"))}`);
		index = cursor;
	}
	return output.join("\n");
}

function formatSkillsText(commandInfo: CommandInfo, data: unknown): string | undefined {
	if (commandInfo.command !== "skills") return undefined;
	if (commandInfo.subcommand === "list" && Array.isArray(data)) return formatSkillsListText(data);
	const content = getSkillContent(data);
	if (content) {
		const note = [
			"Pi native-tool note: upstream skill text was adapted for this native tool.",
			"Use args for CLI tokens and stdin only for batch or eval --stdin; do not pipe heredocs through bash unless the user explicitly asks for a bash workflow.",
		].join("\n");
		return `${note}\n\n${redactModelFacingText(formatNativeSkillContent(content))}`;
	}
	if (typeof data === "string") return redactModelFacingText(formatNativeSkillContent(data));
	return undefined;
}

function formatAuthShowText(data: Record<string, unknown>): string | undefined {
	const lines = AUTH_SHOW_SAFE_FIELDS.flatMap((key) => {
		const value = data[key];
		return typeof value === "string" && value.trim().length > 0 ? [`${key}: ${redactModelFacingText(value.trim())}`] : [];
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function getPreviewCandidate(item: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		const value = item[key];
		if (value !== undefined && value !== null && value !== "") return value;
	}
	return undefined;
}

function parseJsonPreviewString(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

function formatNetworkPreviewValue(value: unknown, maxChars: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	const previewValue = typeof value === "string" ? parseJsonPreviewString(value) : value;
	const redacted = redactSensitiveValue(previewValue);
	const raw = typeof redacted === "string" ? redacted : stringifyUnknown(redacted);
	const normalized = raw.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return undefined;
	return truncateText(redactSensitiveText(normalized), maxChars);
}

function appendNetworkPreview(lines: string[], label: string, value: unknown, maxChars: number): void {
	const preview = formatNetworkPreviewValue(value, maxChars);
	if (!preview) return;
	lines.push(`   ${label}: ${preview}`);
}

function formatNetworkRequestLine(item: Record<string, unknown>, index: number): string[] {
	const method = getStringField(item, "method") ?? "GET";
	const status = typeof item.status === "number" ? String(item.status) : "pending";
	const type = getStringField(item, "resourceType") ?? getStringField(item, "mimeType");
	const url = getStringField(item, "url") ?? "(no url)";
	const requestId = getStringField(item, "requestId") ?? getStringField(item, "id");
	const idText = requestId ? ` [${redactSensitiveText(requestId)}]` : "";
	const lines = [`${index + 1}. ${status} ${method} ${truncateText(redactSensitiveText(url), 180)}${type ? ` (${type})` : ""}${idText}`];
	appendNetworkPreview(lines, "Payload", getPreviewCandidate(item, NETWORK_PREVIEW_FIELD_CANDIDATES.request), NETWORK_BODY_PREVIEW_MAX_CHARS);
	appendNetworkPreview(lines, "Response", getPreviewCandidate(item, NETWORK_PREVIEW_FIELD_CANDIDATES.response), NETWORK_BODY_PREVIEW_MAX_CHARS);
	appendNetworkPreview(lines, "Error", getPreviewCandidate(item, NETWORK_PREVIEW_FIELD_CANDIDATES.error), NETWORK_ERROR_PREVIEW_MAX_CHARS);
	return lines;
}

function formatNetworkRequestsText(data: Record<string, unknown>): string | undefined {
	const requests = getArrayField(data, "requests");
	if (!requests) return undefined;
	if (requests.length === 0) return "No network requests captured.";
	const shown = requests.slice(0, DIAGNOSTIC_REQUEST_PREVIEW_LIMIT).flatMap((item, index) => {
		if (!isRecord(item)) return [`${index + 1}. ${stringifyModelFacing(item)}`];
		return formatNetworkRequestLine(item, index);
	});
	if (requests.length > DIAGNOSTIC_REQUEST_PREVIEW_LIMIT) {
		shown.push(`... (${requests.length - DIAGNOSTIC_REQUEST_PREVIEW_LIMIT} additional requests omitted from preview)`);
	}
	return shown.join("\n");
}

function formatNetworkRequestText(data: Record<string, unknown>): string | undefined {
	if (!getStringField(data, "url") && !getStringField(data, "requestId") && !getStringField(data, "id")) {
		return undefined;
	}
	return formatNetworkRequestLine(data, 0).join("\n");
}

function formatConsoleText(data: Record<string, unknown>): string | undefined {
	const messages = getArrayField(data, "messages");
	if (!messages) return undefined;
	if (messages.length === 0) return "No console messages.";
	const shown = messages.slice(0, DIAGNOSTIC_LOG_PREVIEW_LIMIT).map((item, index) => {
		if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
		const type = redactModelFacingText(getStringField(item, "type") ?? "message");
		const text = getStringField(item, "text") ?? stringifyModelFacing(item);
		return `${index + 1}. [${type}] ${firstLine(redactModelFacingText(text).replace(/\s+/g, " ").trim(), 220)}`;
	});
	if (messages.length > shown.length) {
		shown.push(`... (${messages.length - shown.length} additional console messages omitted from preview)`);
	}
	return shown.join("\n");
}

function formatErrorsText(data: Record<string, unknown>): string | undefined {
	const errors = getArrayField(data, "errors");
	if (!errors) return undefined;
	if (errors.length === 0) return "No page errors.";
	const shown = errors.slice(0, DIAGNOSTIC_LOG_PREVIEW_LIMIT).map((item, index) => {
		if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
		const text = getStringField(item, "text") ?? stringifyModelFacing(item);
		const location = [
			getStringField(item, "url"),
			typeof item.line === "number" ? `line ${item.line}` : undefined,
			typeof item.column === "number" ? `column ${item.column}` : undefined,
		]
			.filter(Boolean)
			.map((item) => redactModelFacingText(String(item)))
			.join(":");
		const safeText = firstLine(redactModelFacingText(text), 220);
		return location ? `${index + 1}. ${safeText} (${location})` : `${index + 1}. ${safeText}`;
	});
	if (errors.length > shown.length) {
		shown.push(`... (${errors.length - shown.length} additional errors omitted from preview)`);
	}
	return shown.join("\n");
}

function formatDashboardText(data: Record<string, unknown>): string | undefined {
	const lines: string[] = [];
	if (typeof data.port === "number") lines.push(`Port: ${data.port}`);
	if (typeof data.pid === "number") lines.push(`PID: ${data.pid}`);
	if (typeof data.stopped === "boolean") lines.push(`Stopped: ${data.stopped}`);
	const reason = getStringField(data, "reason");
	if (reason) lines.push(`Reason: ${redactModelFacingText(reason)}`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatDoctorText(data: Record<string, unknown>): string | undefined {
	const lines: string[] = [];
	const status = getStringField(data, "status") ?? getStringField(data, "result");
	if (status) lines.push(`Status: ${redactModelFacingText(status)}`);
	for (const key of ["checks", "issues", "problems"] as const) {
		const items = getArrayField(data, key);
		if (items) lines.push(`${key}: ${items.length}`);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatDiagnosticText(commandInfo: CommandInfo, data: Record<string, unknown>): string | undefined {
	if (commandInfo.command === "session") return formatSessionText(data);
	if (commandInfo.command === "profiles") {
		const profiles = getArrayField(data, "profiles");
		if (profiles) return formatProfilesText(profiles, "Chrome profiles");
	}
	if (commandInfo.command === "auth") {
		const profiles = getArrayField(data, "profiles");
		if (profiles) return formatProfilesText(profiles, "auth profiles");
		if (commandInfo.subcommand === "show") return formatAuthShowText(data);
	}
	if (commandInfo.command === "network" && commandInfo.subcommand === "requests") return formatNetworkRequestsText(data);
	if (commandInfo.command === "network" && commandInfo.subcommand === "request") return formatNetworkRequestText(data);
	if (commandInfo.command === "console") return formatConsoleText(data);
	if (commandInfo.command === "errors") return formatErrorsText(data);
	if (commandInfo.command === "dashboard") return formatDashboardText(data);
	if (commandInfo.command === "doctor") return formatDoctorText(data);
	return undefined;
}

function getPageSummary(data: Record<string, unknown>): string | undefined {
	const title = typeof data.title === "string" ? data.title : undefined;
	const url = typeof data.url === "string" ? data.url : undefined;
	if (!title && !url) return undefined;
	if (title && url) return `${title}\n${url}`;
	return title ?? url;
}

function formatConfirmationRequiredSummary(confirmation: ConfirmationRequiredPresentation): string {
	return `Confirmation required: ${confirmation.id}`;
}

function formatConfirmationRequiredText(confirmation: ConfirmationRequiredPresentation): string {
	const lines = [
		"Confirmation required.",
		`Pending confirmation id: ${confirmation.id}`,
	];
	if (confirmation.actionText) {
		lines.push(`Action: ${confirmation.actionText}`);
	}
	lines.push(
		"",
		"Next steps:",
		`- Approve: { "args": ["confirm", "${confirmation.id}"] }`,
		`- Deny: { "args": ["deny", "${confirmation.id}"] }`,
	);
	return lines.join("\n");
}

function getScreenshotSummary(data: Record<string, unknown>): string | undefined {
	return typeof data.path === "string" ? `Saved image: ${data.path}` : undefined;
}

const PATH_FIELD_CANDIDATES = [
	"path",
	"file",
	"filePath",
	"outputPath",
	"downloadPath",
	"harPath",
	"tracePath",
	"profilePath",
	"videoPath",
] as const;

const ARTIFACT_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
	".cpuprofile": "application/json",
	".har": "application/json",
	".html": "text/html",
	".json": "application/json",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".webm": "video/webm",
	".zip": "application/zip",
	...IMAGE_EXTENSION_TO_MIME_TYPE,
};

function getArtifactKind(commandInfo: CommandInfo): FileArtifactKind | undefined {
	if (commandInfo.command === "screenshot") return "image";
	if (commandInfo.command === "pdf") return "pdf";
	if (commandInfo.command === "download") return "download";
	if (commandInfo.command === "wait" && commandInfo.subcommand === "--download") return "download";
	if (commandInfo.command === "trace") return "trace";
	if (commandInfo.command === "profiler") return "profile";
	if (commandInfo.command === "record") return "video";
	if (commandInfo.command === "network" && commandInfo.subcommand === "har") return "har";
	return undefined;
}

function extractPathStrings(data: unknown): string[] {
	if (typeof data === "string") {
		return data.trim().length > 0 ? [data] : [];
	}
	if (!isRecord(data)) {
		return [];
	}

	const paths: string[] = [];
	for (const key of PATH_FIELD_CANDIDATES) {
		const value = data[key];
		if (typeof value === "string" && value.trim().length > 0) {
			paths.push(value);
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string" && item.trim().length > 0) {
					paths.push(item);
				}
			}
		}
	}
	return [...new Set(paths)];
}

interface ArtifactRequestContext {
	absolutePath: string;
	path: string;
	status?: FileArtifactMetadata["status"];
	tempPath?: string;
}

async function buildFileArtifactMetadata(options: {
	artifactRequest?: ArtifactRequestContext;
	commandInfo: CommandInfo;
	cwd: string;
	path: string;
	sessionName?: string;
}): Promise<FileArtifactMetadata | undefined> {
	const kind = getArtifactKind(options.commandInfo);
	if (!kind) {
		return undefined;
	}

	const absolutePath = options.artifactRequest?.absolutePath ?? resolve(options.cwd, options.path);
	const displayPath = options.artifactRequest?.path ?? options.path;
	const extension = extname(absolutePath || options.path).toLowerCase() || undefined;
	let exists: boolean | undefined;
	let sizeBytes: number | undefined;
	try {
		const fileStats = await stat(absolutePath);
		exists = true;
		sizeBytes = fileStats.size;
	} catch {
		exists = false;
	}

	return {
		absolutePath,
		artifactType: kind,
		command: options.commandInfo.command,
		cwd: options.cwd,
		exists,
		extension,
		kind,
		mediaType: extension ? ARTIFACT_EXTENSION_TO_MEDIA_TYPE[extension] : undefined,
		path: displayPath,
		requestedPath: options.artifactRequest?.path,
		session: options.sessionName,
		sizeBytes,
		status: options.artifactRequest?.status ?? (exists === false ? "missing" : "saved"),
		subcommand: options.commandInfo.subcommand,
		tempPath: options.artifactRequest?.tempPath,
	};
}

async function extractFileArtifacts(options: {
	artifactRequest?: ArtifactRequestContext;
	commandInfo: CommandInfo;
	cwd: string;
	data: unknown;
	sessionName?: string;
}): Promise<FileArtifactMetadata[]> {
	const candidates = extractPathStrings(options.data);
	const artifacts = await Promise.all(candidates.map((path) => buildFileArtifactMetadata({ ...options, path })));
	return artifacts.filter((artifact): artifact is FileArtifactMetadata => artifact !== undefined);
}

function buildManifestEntriesForFileArtifacts(artifacts: FileArtifactMetadata[], nowMs = Date.now()): SessionArtifactManifestEntry[] {
	return artifacts.map((artifact) => ({
		absolutePath: artifact.absolutePath,
		command: artifact.command,
		createdAtMs: nowMs,
		cwd: artifact.cwd,
		exists: artifact.exists,
		extension: artifact.extension,
		kind: artifact.kind,
		mediaType: artifact.mediaType,
		path: artifact.path,
		requestedPath: artifact.requestedPath,
		retentionState: artifact.exists === false ? "missing" : "live",
		session: artifact.session,
		sizeBytes: artifact.sizeBytes,
		storageScope: "explicit-path",
		subcommand: artifact.subcommand,
	}));
}

function isRecordingStartArtifact(artifact: FileArtifactMetadata): boolean {
	return artifact.command === "record" && artifact.subcommand === "start" && artifact.kind === "video";
}

function isManifestFileArtifact(artifact: FileArtifactMetadata): boolean {
	return !isRecordingStartArtifact(artifact);
}

function formatArtifactLabel(artifact: FileArtifactMetadata): string {
	switch (artifact.kind) {
		case "download":
			return artifact.command === "wait" && artifact.subcommand === "--download" ? "Download completed" : "Downloaded file";
		case "file":
			return "Saved file";
		case "har":
			return "Saved HAR";
		case "image":
			return "Saved image";
		case "pdf":
			return "Saved PDF";
		case "profile":
			return "Saved profile";
		case "trace":
			return "Saved trace";
		case "video":
			return isRecordingStartArtifact(artifact) ? "Recording started; output will be written on stop" : "Saved recording";
	}
}

function formatArtifactSummary(artifacts: FileArtifactMetadata[]): string | undefined {
	if (artifacts.length === 0) {
		return undefined;
	}
	if (artifacts.length === 1) {
		const artifact = artifacts[0];
		return `${formatArtifactLabel(artifact)}: ${artifact.path}`;
	}
	return `Saved ${artifacts.length} artifacts: ${artifacts.map((artifact) => `${artifact.kind} ${artifact.path}`).join(", ")}`;
}

function formatArtifactMetadataLines(artifacts: FileArtifactMetadata[]): string[] {
	return artifacts.map((artifact, index) => {
		if (isRecordingStartArtifact(artifact)) {
			return [
				`${formatArtifactLabel(artifact)}: ${artifact.path}`,
				`Artifact type: ${artifact.kind}`,
				`Requested path: ${artifact.requestedPath ?? artifact.path}`,
				`Absolute path: ${artifact.absolutePath}`,
				`Exists: ${artifact.exists === true}`,
				`Status: ${artifact.status ?? (artifact.exists === false ? "missing" : "saved")}`,
				artifact.session ? `Session: ${artifact.session}` : undefined,
				artifact.cwd ? `CWD: ${artifact.cwd}` : undefined,
				`Machine data: details.artifacts[${index}]`,
			].filter((item): item is string => item !== undefined).join("\n");
		}

		return [
			`${formatArtifactLabel(artifact)}: ${artifact.path}`,
			`Artifact type: ${artifact.kind}`,
			`Requested path: ${artifact.requestedPath ?? artifact.path}`,
			`Absolute path: ${artifact.absolutePath}`,
			`Exists: ${artifact.exists === true}`,
			artifact.exists === false ? "not found on disk" : undefined,
			typeof artifact.sizeBytes === "number" ? `Size: ${formatByteCount(artifact.sizeBytes)}` : undefined,
			typeof artifact.sizeBytes === "number" ? `Size bytes: ${artifact.sizeBytes}` : undefined,
			`Status: ${artifact.status ?? (artifact.exists === false ? "missing" : "saved")}`,
			artifact.tempPath ? `Temp path: ${artifact.tempPath}` : undefined,
			artifact.mediaType ? `Media type: ${artifact.mediaType}` : undefined,
			artifact.session ? `Session: ${artifact.session}` : undefined,
			artifact.cwd ? `CWD: ${artifact.cwd}` : undefined,
			`Machine data: details.artifacts[${index}]`,
		].filter((item): item is string => item !== undefined).join("\n");
	});
}

function isDownloadWaitCommand(commandInfo: CommandInfo): boolean {
	return commandInfo.command === "wait" && commandInfo.subcommand === "--download";
}

function extractSavedFilePath(data: Record<string, unknown>): string | undefined {
	return typeof data.path === "string" && data.path.trim().length > 0 ? data.path : undefined;
}

function getSavedFileDetails(commandInfo: CommandInfo, data: Record<string, unknown>): SavedFilePresentationDetails | undefined {
	const path = extractSavedFilePath(data);
	if (!path) {
		return undefined;
	}
	const savedFileCommand = isDownloadWaitCommand(commandInfo)
		? "wait"
		: commandInfo.command === "download" || commandInfo.command === "pdf"
			? commandInfo.command
			: undefined;
	if (!savedFileCommand) {
		return undefined;
	}

	const { path: _path, ...metadata } = data;
	const details: SavedFilePresentationDetails = {
		command: savedFileCommand,
		kind: savedFileCommand === "pdf" ? "pdf" : "download",
		path,
	};
	if (Object.keys(metadata).length > 0) {
		details.metadata = metadata;
	}
	if (commandInfo.subcommand) {
		details.subcommand = commandInfo.subcommand;
	}
	return details;
}

function getScalarExtractionResult(data: Record<string, unknown>): string | undefined {
	const { result } = data;
	if (typeof result === "string") {
		return result.trim().length > 0 ? result : undefined;
	}
	if (typeof result === "number" || typeof result === "boolean") {
		return String(result);
	}
	return undefined;
}

function getExtractionOrigin(data: Record<string, unknown>): string | undefined {
	if (typeof data.origin === "string" && data.origin.trim().length > 0) {
		return data.origin.trim();
	}
	if (typeof data.url === "string" && data.url.trim().length > 0) {
		return data.url.trim();
	}
	return undefined;
}

function formatGetSummaryLabel(subcommand: string | undefined): string {
	if (!subcommand) {
		return "Get result";
	}
	if (subcommand.toLowerCase() === "url") {
		return "URL";
	}
	return `${subcommand.slice(0, 1).toUpperCase()}${subcommand.slice(1)}`;
}

function formatExtractionSummary(commandInfo: CommandInfo, data: Record<string, unknown>): string | undefined {
	const scalarResult = getScalarExtractionResult(data);
	if (!scalarResult) {
		return undefined;
	}
	const safeScalarResult = redactModelFacingText(scalarResult);
	const firstResultLine = safeScalarResult.split("\n", 1)[0] ?? safeScalarResult;
	if (commandInfo.command === "get") {
		return `${formatGetSummaryLabel(commandInfo.subcommand)}: ${firstResultLine}`;
	}
	if (commandInfo.command === "eval") {
		return `Eval result: ${firstResultLine}`;
	}
	return undefined;
}

function formatExtractionText(commandInfo: CommandInfo, data: Record<string, unknown>): string | undefined {
	if (commandInfo.command !== "get" && commandInfo.command !== "eval") {
		return undefined;
	}
	const scalarResult = getScalarExtractionResult(data);
	if (!scalarResult) {
		return undefined;
	}
	const origin = getExtractionOrigin(data);
	const safeScalarResult = redactModelFacingText(scalarResult);
	const safeOrigin = origin ? redactModelFacingText(origin) : undefined;
	return safeOrigin && safeOrigin !== safeScalarResult ? `${safeScalarResult}\n\nOrigin: ${safeOrigin}` : safeScalarResult;
}

function isNavigationObservableCommand(command: string | undefined): boolean {
	return command !== undefined && NAVIGATION_SUMMARY_COMMANDS.has(command);
}

function isNavigationSummary(value: unknown): value is NavigationSummary {
	return isRecord(value) && (typeof value.title === "string" || typeof value.url === "string");
}

function getNavigationSummary(data: Record<string, unknown>): NavigationSummary | undefined {
	const candidate = data[NAVIGATION_SUMMARY_FIELD];
	return isNavigationSummary(candidate) ? candidate : undefined;
}

function formatNavigationSummary(summary: NavigationSummary): string | undefined {
	const title = typeof summary.title === "string" && summary.title.trim().length > 0 ? summary.title.trim() : undefined;
	const url = typeof summary.url === "string" && summary.url.trim().length > 0 ? summary.url.trim() : undefined;
	if (!title && !url) return undefined;
	if (title && url) return `${title}\n${url}`;
	return title ?? url;
}

function stripNavigationSummary(data: Record<string, unknown>): Record<string, unknown> {
	const { [NAVIGATION_SUMMARY_FIELD]: _navigationSummary, ...rest } = data;
	return rest;
}

function formatNavigationActionResult(data: Record<string, unknown>): string | undefined {
	const actionData = stripNavigationSummary(data);
	const lines: string[] = [];
	if (typeof actionData.clicked === "string" || typeof actionData.clicked === "boolean") {
		lines.push(`Clicked: ${String(actionData.clicked)}`);
	}
	if (typeof actionData.href === "string") {
		lines.push(`Href: ${redactModelFacingText(actionData.href)}`);
	}
	if (typeof actionData.navigated === "boolean") {
		lines.push(`Navigated: ${actionData.navigated}`);
	}
	if (lines.length > 0) {
		return lines.join("\n");
	}

	const actionText = stringifyModelFacing(actionData).trim();
	if (actionText.length === 0 || actionText === "{}") {
		return undefined;
	}
	return actionText;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function getPresentationText(presentation: ToolPresentation): string {
	return presentation.content
		.filter((part): part is Extract<ToolPresentation["content"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.text.trim())
		.filter((text) => text.length > 0)
		.join("\n\n");
}

function getPresentationImages(presentation: ToolPresentation): Array<Extract<ToolPresentation["content"][number], { type: "image" }>> {
	return presentation.content.filter(
		(part): part is Extract<ToolPresentation["content"][number], { type: "image" }> => part.type === "image",
	);
}

function getPresentationPaths(options: {
	primaryPath?: string;
	secondaryPaths?: string[];
}): string[] {
	return options.secondaryPaths ?? (options.primaryPath ? [options.primaryPath] : []);
}

function formatBatchStepCommand(command: string[] | undefined, index: number): string {
	return command && command.length > 0 ? command.join(" ") : `step-${index + 1}`;
}

const STALE_REF_ERROR_HINT = [
	"Agent-browser hint: This ref may be stale after navigation, scrolling, or re-rendering.",
	"Run `snapshot -i` again and retry with a current `@e…` ref; for less ref churn, use `find role|text|label|placeholder|alt|title|testid ...` or `scrollintoview` before interacting with off-screen elements.",
].join(" ");

const SELECTOR_DIALECT_ERROR_HINT = [
	"Agent-browser hint: This selector may use an unsupported selector dialect.",
	"Prefer refs from `snapshot -i`, or use supported `find role|text|label|placeholder|alt|title|testid ...` locators; use `scrollintoview` before interacting with off-screen elements.",
].join(" ");

function getSelectorRecoveryHint(errorText: string): string | undefined {
	const normalized = errorText.trim();
	if (normalized.length === 0) {
		return undefined;
	}

	if (/\bUnknown ref\b|\bstale ref\b|\bref\b.*\b(?:not found|missing|expired)\b/i.test(normalized)) {
		return STALE_REF_ERROR_HINT;
	}

	const mentionsPlaywrightSelectorDialect = /(?:\btext=|:has-text\(|\bgetByRole\b|\bgetByText\b)/i.test(normalized);
	const reportsSelectorMatchFailure =
		/\b(?:no elements? found|failed to find|could not find|unable to find)\b.*\b(?:selector|locator)\b/i.test(normalized) ||
		/\b(?:selector|locator)\b.*\b(?:no elements? found|not found|missing|failed to find|could not find|unable to find)\b/i.test(
			normalized,
		);

	if (
		/\b(?:unsupported|unknown|invalid)\s+(?:selector|locator)\b/i.test(normalized) ||
		/\bfailed to parse selector\b/i.test(normalized) ||
		/\bselector\b.*\b(?:parse|syntax|unsupported|invalid)\b/i.test(normalized) ||
		(mentionsPlaywrightSelectorDialect && reportsSelectorMatchFailure)
	) {
		return SELECTOR_DIALECT_ERROR_HINT;
	}

	return undefined;
}

function appendSelectorRecoveryHint(errorText: string): string {
	const hint = getSelectorRecoveryHint(errorText);
	if (!hint || errorText.includes("Agent-browser hint:")) {
		return errorText;
	}
	return `${errorText}\n\n${hint}`;
}

function formatBatchStepError(error: unknown): string {
	const errorText = stringifyModelFacing(error).trim();
	const formattedErrorText = errorText.length > 0 ? `Error: ${errorText}` : "Error: batch step failed.";
	return appendSelectorRecoveryHint(formattedErrorText);
}

function getBatchFailureDetails(steps: Array<{ details: BatchStepPresentationDetails }>): BatchFailurePresentationDetails | undefined {
	const failedSteps = steps.filter((step) => step.details.success === false);
	if (failedSteps.length === 0) {
		return undefined;
	}
	const successCount = steps.length - failedSteps.length;
	return {
		failedStep: failedSteps[0].details,
		failureCount: failedSteps.length,
		successCount,
		totalCount: steps.length,
	};
}

async function buildBatchStepPresentation(options: {
	artifactManifest?: SessionArtifactManifest;
	artifactRequest?: ArtifactRequestContext;
	cwd: string;
	index: number;
	item: AgentBrowserBatchResult;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
}): Promise<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> {
	const { artifactManifest, artifactRequest, cwd, index, item, persistentArtifactStore, sessionName } = options;
	const command = isStringArray(item.command) ? item.command : undefined;
	const commandText = formatBatchStepCommand(command, index);

	if (item.success === false) {
		const errorText = formatBatchStepError(item.error);
		const presentation: ToolPresentation = {
			content: [{ type: "text", text: errorText }],
			summary: errorText,
		};
		return {
			details: {
				artifacts: presentation.artifacts,
				command,
				commandText,
				data: item.error,
				index,
				success: false,
				summary: errorText,
				text: errorText,
			},
			presentation,
		};
	}

	const presentation = await buildToolPresentation({
		artifactManifest,
		artifactRequest,
		commandInfo: parseCommandInfo(command ?? []),
		cwd,
		envelope: { data: item.result, success: true },
		persistentArtifactStore,
		sessionName,
	});
	const fullOutputPaths = getPresentationPaths({
		primaryPath: presentation.fullOutputPath,
		secondaryPaths: presentation.fullOutputPaths,
	});
	const imagePaths = getPresentationPaths({
		primaryPath: presentation.imagePath,
		secondaryPaths: presentation.imagePaths,
	});
	const text = getPresentationText(presentation) || presentation.summary;

	return {
		details: {
			artifacts: presentation.artifacts,
			command,
			commandText,
			data: presentation.data,
			fullOutputPath: fullOutputPaths[0],
			fullOutputPaths: fullOutputPaths.length > 0 ? fullOutputPaths : undefined,
			imagePath: imagePaths[0],
			imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
			index,
			savedFile: presentation.savedFile,
			savedFilePath: presentation.savedFilePath,
			success: true,
			summary: presentation.summary,
			text,
		},
		presentation,
	};
}

async function buildBatchPresentation(options: {
	artifactManifest?: SessionArtifactManifest;
	artifactRequests?: Array<ArtifactRequestContext | undefined>;
	cwd: string;
	data: AgentBrowserBatchResult[];
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
	summary: string;
}): Promise<ToolPresentation> {
	const { artifactRequests, cwd, data, persistentArtifactStore, sessionName, summary } = options;
	const steps: Array<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> = [];
	const protectedPersistentPaths: string[] = [];
	let currentArtifactManifest = options.artifactManifest;
	for (const [index, item] of data.entries()) {
		const step = await buildBatchStepPresentation({
			artifactManifest: currentArtifactManifest,
			artifactRequest: artifactRequests?.[index],
			cwd,
			index,
			item,
			persistentArtifactStore: persistentArtifactStore
				? { ...persistentArtifactStore, protectedPaths: protectedPersistentPaths }
				: undefined,
			sessionName,
		});
		steps.push(step);
		currentArtifactManifest = step.presentation.artifactManifest ?? currentArtifactManifest;
		protectedPersistentPaths.push(
			...getPresentationPaths({
				primaryPath: step.presentation.fullOutputPath,
				secondaryPaths: step.presentation.fullOutputPaths,
			}),
		);
	}

	const batchFailure = getBatchFailureDetails(steps);
	const images = steps.flatMap((step) => getPresentationImages(step.presentation));
	const artifacts = steps.flatMap((step) => step.presentation.artifacts ?? []);
	const fullOutputPaths = steps.flatMap((step) => getPresentationPaths({
		primaryPath: step.presentation.fullOutputPath,
		secondaryPaths: step.presentation.fullOutputPaths,
	}));
	const imagePaths = steps.flatMap((step) => getPresentationPaths({
		primaryPath: step.presentation.imagePath,
		secondaryPaths: step.presentation.imagePaths,
	}));
	const stepText =
		steps.length === 0
			? "(no batch steps)"
			: steps
				.map(({ details, presentation }) => {
					const inlineImageCount = getPresentationImages(presentation).length;
					const status = details.success ? "succeeded" : "failed";
					const lines = [`Step ${details.index + 1} — ${details.commandText} (${status})`];
					if (details.text.length > 0) {
						lines.push(details.text);
					}
					if (inlineImageCount > 0) {
						lines.push(`(${inlineImageCount} inline image attachment${inlineImageCount === 1 ? "" : "s"} below)`);
					}
					return lines.join("\n");
				})
				.join("\n\n");
	const failureHeader =
		batchFailure === undefined
			? undefined
			: [
					summary,
					`First failing step: ${batchFailure.failedStep.index + 1} — ${batchFailure.failedStep.commandText}`,
					batchFailure.failureCount > 1
						? `${batchFailure.failureCount} steps failed. See the per-step results below.`
						: "See the per-step results below.",
				].join("\n");
	const text = failureHeader ? `${failureHeader}\n\n${stepText}` : stepText;

	const artifactRetentionSummary = currentArtifactManifest ? formatSessionArtifactRetentionSummary(currentArtifactManifest) : undefined;
	const contentText = artifactRetentionSummary && manifestHasNewNoticeWorthyEntries(options.artifactManifest, currentArtifactManifest) ? `${text}\n\n${artifactRetentionSummary}` : text;

	return {
		artifactManifest: currentArtifactManifest,
		artifactRetentionSummary,
		artifacts: artifacts.length > 0 ? artifacts : undefined,
		batchFailure,
		batchSteps: steps.map((step) => step.details),
		content: [{ type: "text", text: contentText }, ...images],
		data,
		fullOutputPath: fullOutputPaths[0],
		fullOutputPaths: fullOutputPaths.length > 0 ? fullOutputPaths : undefined,
		imagePath: imagePaths[0],
		imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
		summary,
	};
}

function formatSummary(commandInfo: CommandInfo, data: unknown): string {
	const confirmationRequired = detectConfirmationRequired(data);
	if (confirmationRequired) {
		return formatConfirmationRequiredSummary(confirmationRequired);
	}

	if (Array.isArray(data) && commandInfo.command === "batch") {
		const successCount = data.filter((item) => isRecord(item) && item.success !== false).length;
		return successCount === data.length ? `Batch: ${successCount}/${data.length} succeeded` : `Batch failed: ${successCount}/${data.length} succeeded`;
	}
	if (Array.isArray(data) && commandInfo.command === "profiles") {
		return `Chrome profiles: ${data.length}`;
	}
	if (Array.isArray(data) && commandInfo.command === "skills" && commandInfo.subcommand === "list") {
		return `agent-browser skills: ${data.length}`;
	}
	if (commandInfo.command === "skills" && commandInfo.subcommand === "get") {
		return "agent-browser skill loaded";
	}
	if (isRecord(data)) {
		const navigationSummary = getNavigationSummary(data);
		if (navigationSummary && isNavigationObservableCommand(commandInfo.command)) {
			const navigationText = formatNavigationSummary(navigationSummary);
			if (navigationText) {
				return `${commandInfo.command ?? "navigation"} → ${navigationText.split("\n", 1)[0] ?? navigationText}`;
			}
		}
		if (commandInfo.command === "snapshot") {
			return formatSnapshotSummary(data);
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
		const diagnosticSummary = formatDiagnosticSummary(commandInfo, data);
		if (diagnosticSummary) {
			return diagnosticSummary;
		}
		const extractionSummary = formatExtractionSummary(commandInfo, data);
		if (extractionSummary) {
			return extractionSummary;
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

function formatContentText(commandInfo: CommandInfo, data: unknown): string {
	const confirmationRequired = detectConfirmationRequired(data);
	if (confirmationRequired) {
		return formatConfirmationRequiredText(confirmationRequired);
	}

	if (typeof data === "string") {
		return redactModelFacingText(data);
	}
	if (typeof data === "number" || typeof data === "boolean") {
		return String(data);
	}
	if (Array.isArray(data) && commandInfo.command === "profiles") {
		return formatProfilesText(data, "Chrome profiles");
	}
	if (Array.isArray(data) && commandInfo.command === "skills") {
		return formatSkillsText(commandInfo, data) ?? stringifyModelFacing(data);
	}
	if (!isRecord(data)) {
		return stringifyModelFacing(data);
	}

	const navigationSummary = getNavigationSummary(data);
	if (navigationSummary && isNavigationObservableCommand(commandInfo.command)) {
		const navigationText = formatNavigationSummary(navigationSummary);
		if (navigationText) {
			const actionText = formatNavigationActionResult(data);
			return actionText ? `${actionText}\n\nCurrent page:\n${navigationText}` : `Current page:\n${navigationText}`;
		}
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
	const skillsText = formatSkillsText(commandInfo, data);
	if (skillsText) {
		return skillsText;
	}
	const extractionText = formatExtractionText(commandInfo, data);
	if (extractionText) {
		return extractionText;
	}

	const diagnosticText = formatDiagnosticText(commandInfo, data);
	if (diagnosticText) {
		return diagnosticText;
	}

	const pageSummary = getPageSummary(data);
	if (pageSummary) {
		return redactModelFacingText(pageSummary);
	}

	return stringifyModelFacing(data);
}

function isTrustedScreenshotOutput(commandInfo: CommandInfo): boolean {
	return commandInfo.command === "screenshot";
}

function extractImagePath(commandInfo: CommandInfo, cwd: string, data: unknown): string | undefined {
	if (!isTrustedScreenshotOutput(commandInfo)) {
		return undefined;
	}
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

function sanitizeModelFacingPresentation(presentation: ToolPresentation): ToolPresentation {
	presentation.content = presentation.content.map((item) => {
		if (item.type !== "text") return item;
		const parsed = parseJsonPreviewString(item.text);
		return parsed === item.text ? item : { ...item, text: stringifyModelFacing(parsed) };
	});
	presentation.summary = redactModelFacingText(presentation.summary);
	return presentation;
}

async function attachInlineImage(presentation: ToolPresentation, imagePath: string): Promise<ToolPresentation> {
	const mimeType = getImageMimeType(imagePath);
	if (!mimeType) {
		return presentation;
	}

	try {
		const fileStats = await stat(imagePath);
		const inlineImageMaxBytes = getInlineImageMaxBytes();
		if (fileStats.size > inlineImageMaxBytes) {
			appendPresentationNotice(
				presentation,
				`Image attachment skipped: ${formatByteCount(fileStats.size)} exceeds the inline limit of ${formatByteCount(inlineImageMaxBytes)}.`,
			);
			presentation.imagePath = imagePath;
			return presentation;
		}

		const file = await readFile(imagePath);
		presentation.content.push({ type: "image", data: file.toString("base64"), mimeType });
		presentation.imagePath = imagePath;
		return presentation;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		appendPresentationNotice(presentation, `Image attachment failed: ${message}`);
		presentation.imagePath = imagePath;
		return presentation;
	}
}

function shouldCompactLargeOutput(text: string): boolean {
	return text.length > LARGE_OUTPUT_INLINE_MAX_CHARS || countLines(text) > LARGE_OUTPUT_INLINE_MAX_LINES;
}

function buildLargeOutputPreview(text: string): { omittedLineCount: number; previewText: string } {
	const lines = text.split("\n");
	const previewLines: string[] = [];
	let previewChars = 0;
	for (const line of lines) {
		if (previewLines.length >= LARGE_OUTPUT_PREVIEW_MAX_LINES || previewChars >= LARGE_OUTPUT_PREVIEW_MAX_CHARS) {
			break;
		}
		const remainingChars = LARGE_OUTPUT_PREVIEW_MAX_CHARS - previewChars;
		const previewLine = truncateText(line, Math.max(40, remainingChars));
		previewLines.push(previewLine);
		previewChars += previewLine.length + 1;
	}
	return {
		omittedLineCount: Math.max(0, lines.length - previewLines.length),
		previewText: previewLines.join("\n"),
	};
}

interface LargeOutputSpillWriteResult {
	evictedArtifacts: PersistentSessionArtifactEviction[];
	path: string;
	storageScope: ArtifactStorageScope;
}

async function writeLargeOutputSpillFile(options: {
	data: unknown;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	text: string;
}): Promise<LargeOutputSpillWriteResult> {
	const payload =
		typeof options.data === "string"
			? redactModelFacingText(options.data)
			: typeof options.data === "number" || typeof options.data === "boolean"
				? String(options.data)
				: options.data === undefined
					? redactModelFacingText(options.text)
					: stringifyModelFacing(options.data);
	const isStructuredPayload = typeof options.data !== "string" && typeof options.data !== "number" && typeof options.data !== "boolean";
	const fileOptions = {
		content: payload,
		prefix: LARGE_OUTPUT_FILE_PREFIX,
		suffix: isStructuredPayload ? ".json" : ".txt",
	};
	if (options.persistentArtifactStore) {
		const result = await writePersistentSessionArtifactFile({ ...fileOptions, store: options.persistentArtifactStore });
		return { ...result, storageScope: "persistent-session" };
	}
	return { evictedArtifacts: [], path: await writeSecureTempFile(fileOptions), storageScope: "process-temp" };
}

function buildSpillArtifactEntries(options: {
	commandInfo: CommandInfo;
	evictedArtifacts: PersistentSessionArtifactEviction[];
	path: string;
	storageScope: ArtifactStorageScope;
}): SessionArtifactManifestEntry[] {
	const nowMs = Date.now();
	return [
		{
			command: options.commandInfo.command,
			createdAtMs: nowMs,
			kind: "spill",
			path: options.path,
			retentionState: options.storageScope === "persistent-session" ? "live" : "ephemeral",
			storageScope: options.storageScope,
			subcommand: options.commandInfo.subcommand,
		},
		...buildEvictedSessionArtifactEntries(options.evictedArtifacts, nowMs),
	];
}

async function compactLargePresentationOutput(options: {
	artifactManifest?: SessionArtifactManifest;
	commandInfo: CommandInfo;
	data: unknown;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	presentation: ToolPresentation;
}): Promise<ToolPresentation> {
	const text = getPresentationText(options.presentation);
	if (text.length === 0 || !shouldCompactLargeOutput(text)) {
		return options.presentation;
	}

	let fullOutputPath: string | undefined;
	let spill: LargeOutputSpillWriteResult | undefined;
	let spillErrorText: string | undefined;
	try {
		spill = await writeLargeOutputSpillFile({
			data: options.data,
			persistentArtifactStore: options.persistentArtifactStore,
			text,
		});
		fullOutputPath = spill.path;
	} catch (error) {
		spillErrorText = error instanceof Error ? error.message : String(error);
	}

	const { omittedLineCount, previewText } = buildLargeOutputPreview(text);
	const commandLabel = options.commandInfo.command ?? "agent-browser";
	const lines = [
		`Large ${commandLabel} output compacted.`,
		"",
		"Preview:",
		previewText,
	];
	if (omittedLineCount > 0) {
		lines.push(`- ... (${omittedLineCount} additional lines omitted)`);
	}
	lines.push(
		"",
		fullOutputPath
			? `Full output path: ${fullOutputPath}`
			: `Full output unavailable: ${spillErrorText ?? "spill file could not be created."}`,
	);

	const firstTextIndex = options.presentation.content.findIndex((part) => part.type === "text");
	const compactedText = lines.join("\n");
	if (firstTextIndex >= 0) {
		options.presentation.content[firstTextIndex] = { type: "text", text: compactedText };
	} else {
		options.presentation.content.unshift({ type: "text", text: compactedText });
	}
	options.presentation.data = {
		compacted: true,
		fullOutputPath,
		outputCharCount: text.length,
		outputLineCount: countLines(text),
		previewCharCount: previewText.length,
		previewLineCount: countLines(previewText),
		spillError: spillErrorText,
	};
	options.presentation.fullOutputPath = fullOutputPath;
	options.presentation.summary = `${options.presentation.summary} (compact)`;
	if (fullOutputPath && spill) {
		return applyArtifactManifest(
			options.presentation,
			options.presentation.artifactManifest ?? options.artifactManifest,
			buildSpillArtifactEntries({
				commandInfo: options.commandInfo,
				evictedArtifacts: spill.evictedArtifacts,
				path: fullOutputPath,
				storageScope: spill.storageScope,
			}),
		);
	}
	return options.presentation;
}

export async function buildToolPresentation(options: {
	artifactManifest?: SessionArtifactManifest;
	artifactRequest?: ArtifactRequestContext;
	batchArtifactRequests?: Array<ArtifactRequestContext | undefined>;
	commandInfo: CommandInfo;
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	errorText?: string;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
}): Promise<ToolPresentation> {
	const { artifactManifest, artifactRequest, commandInfo, cwd, envelope, errorText, persistentArtifactStore, sessionName } = options;
	if (errorText) {
		const hintedErrorText = appendSelectorRecoveryHint(redactModelFacingText(errorText));
		return {
			content: [{ type: "text", text: hintedErrorText }],
			summary: hintedErrorText,
		};
	}

	const data = enrichStreamStatusData(commandInfo, envelope?.data);
	const artifacts = await extractFileArtifacts({ artifactRequest, commandInfo, cwd, data, sessionName });
	const artifactSummary = formatArtifactSummary(artifacts);
	const summary = artifactSummary ?? formatSummary(commandInfo, data);
	const artifactText = artifacts.length > 0 ? formatArtifactMetadataLines(artifacts).join("\n") : undefined;
	const presentation =
		commandInfo.command === "batch" && Array.isArray(data)
			? await buildBatchPresentation({ artifactManifest, artifactRequests: options.batchArtifactRequests, cwd, data: data as AgentBrowserBatchResult[], persistentArtifactStore, sessionName, summary })
			: commandInfo.command === "snapshot" && isRecord(data)
				? await buildSnapshotPresentation(data, persistentArtifactStore, artifactManifest)
				: {
						artifacts: artifacts.length > 0 ? artifacts : undefined,
						content: [{ type: "text" as const, text: artifactText ?? formatContentText(commandInfo, data) }],
						data,
						summary,
				  };
	if (artifacts.length > 0 && !presentation.artifacts) {
		presentation.artifacts = artifacts;
	}
	if (isRecord(data)) {
		const savedFile = getSavedFileDetails(commandInfo, data);
		if (savedFile) {
			presentation.savedFile = savedFile;
			presentation.savedFilePath = savedFile.path;
		}
	}

	const imagePath = artifactRequest?.absolutePath ?? extractImagePath(commandInfo, cwd, data);
	const presentationWithImage = imagePath ? await attachInlineImage(presentation, imagePath) : presentation;
	const compactedPresentation = await compactLargePresentationOutput({
		artifactManifest,
		commandInfo,
		data,
		persistentArtifactStore,
		presentation: presentationWithImage,
	});
	return sanitizeModelFacingPresentation(
		applyArtifactManifest(
			compactedPresentation,
			compactedPresentation.artifactManifest ?? artifactManifest,
			buildManifestEntriesForFileArtifacts(artifacts.filter(isManifestFileArtifact)),
		),
	);
}
