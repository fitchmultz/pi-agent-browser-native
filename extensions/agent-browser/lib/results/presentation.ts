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
import { parseCommandInfo, type CommandInfo } from "../runtime.js";
import {
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
	type FileArtifactKind,
	type FileArtifactMetadata,
	type ToolPresentation,
	countLines,
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
	}
	return lines.join("\n");
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
				if (!isRecord(item)) return `${index + 1}. ${stringifyUnknown(item)}`;
				const name = getStringField(item, "name") ?? getStringField(item, "session") ?? getStringField(item, "id") ?? `(session ${index + 1})`;
				const active = item.active === true ? " *active*" : "";
				const details = [getStringField(item, "url"), getStringField(item, "title")].filter(Boolean).join(" — ");
				return details ? `${index + 1}. ${name}${active} — ${details}` : `${index + 1}. ${name}${active}`;
			})
			.join("\n");
	}
	const session = getStringField(data, "session");
	return session ? `Current session: ${session}` : undefined;
}

function formatProfilesText(profiles: unknown[], label: string): string {
	if (profiles.length === 0) return `No ${label}.`;
	return profiles
		.map((item, index) => {
			if (!isRecord(item)) return `${index + 1}. ${stringifyUnknown(item)}`;
			const name = getStringField(item, "name") ?? getStringField(item, "profile") ?? `(unnamed ${index + 1})`;
			const directory = getStringField(item, "directory") ?? getStringField(item, "path");
			return directory ? `${index + 1}. ${name} (${directory})` : `${index + 1}. ${name}`;
		})
		.join("\n");
}

function formatAuthShowText(data: Record<string, unknown>): string | undefined {
	const lines = AUTH_SHOW_SAFE_FIELDS.flatMap((key) => {
		const value = data[key];
		return typeof value === "string" && value.trim().length > 0 ? [`${key}: ${value.trim()}`] : [];
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatNetworkRequestsText(data: Record<string, unknown>): string | undefined {
	const requests = getArrayField(data, "requests");
	if (!requests) return undefined;
	if (requests.length === 0) return "No network requests captured.";
	const shown = requests.slice(0, DIAGNOSTIC_REQUEST_PREVIEW_LIMIT).map((item, index) => {
		if (!isRecord(item)) return `${index + 1}. ${stringifyUnknown(item)}`;
		const method = getStringField(item, "method") ?? "GET";
		const status = typeof item.status === "number" ? String(item.status) : "pending";
		const type = getStringField(item, "resourceType") ?? getStringField(item, "mimeType");
		const url = getStringField(item, "url") ?? "(no url)";
		return `${index + 1}. ${status} ${method} ${truncateText(url, 180)}${type ? ` (${type})` : ""}`;
	});
	if (requests.length > shown.length) {
		shown.push(`... (${requests.length - shown.length} additional requests omitted from preview)`);
	}
	return shown.join("\n");
}

function formatConsoleText(data: Record<string, unknown>): string | undefined {
	const messages = getArrayField(data, "messages");
	if (!messages) return undefined;
	if (messages.length === 0) return "No console messages.";
	const shown = messages.slice(0, DIAGNOSTIC_LOG_PREVIEW_LIMIT).map((item, index) => {
		if (!isRecord(item)) return `${index + 1}. ${stringifyUnknown(item)}`;
		const type = getStringField(item, "type") ?? "message";
		const text = getStringField(item, "text") ?? stringifyUnknown(item);
		return `${index + 1}. [${type}] ${firstLine(text, 220)}`;
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
		if (!isRecord(item)) return `${index + 1}. ${stringifyUnknown(item)}`;
		const text = getStringField(item, "text") ?? stringifyUnknown(item);
		const location = [
			getStringField(item, "url"),
			typeof item.line === "number" ? `line ${item.line}` : undefined,
			typeof item.column === "number" ? `column ${item.column}` : undefined,
		]
			.filter(Boolean)
			.join(":");
		return location ? `${index + 1}. ${firstLine(text, 220)} (${location})` : `${index + 1}. ${firstLine(text, 220)}`;
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
	if (reason) lines.push(`Reason: ${reason}`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatDoctorText(data: Record<string, unknown>): string | undefined {
	const lines: string[] = [];
	const status = getStringField(data, "status") ?? getStringField(data, "result");
	if (status) lines.push(`Status: ${status}`);
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

async function buildFileArtifactMetadata(options: {
	commandInfo: CommandInfo;
	cwd: string;
	path: string;
}): Promise<FileArtifactMetadata | undefined> {
	const kind = getArtifactKind(options.commandInfo);
	if (!kind) {
		return undefined;
	}

	const absolutePath = resolve(options.cwd, options.path);
	const extension = extname(options.path).toLowerCase() || undefined;
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
		command: options.commandInfo.command,
		exists,
		extension,
		kind,
		mediaType: extension ? ARTIFACT_EXTENSION_TO_MEDIA_TYPE[extension] : undefined,
		path: options.path,
		sizeBytes,
		subcommand: options.commandInfo.subcommand,
	};
}

async function extractFileArtifacts(commandInfo: CommandInfo, cwd: string, data: unknown): Promise<FileArtifactMetadata[]> {
	const candidates = extractPathStrings(data);
	const artifacts = await Promise.all(candidates.map((path) => buildFileArtifactMetadata({ commandInfo, cwd, path })));
	return artifacts.filter((artifact): artifact is FileArtifactMetadata => artifact !== undefined);
}

function formatArtifactLabel(artifact: FileArtifactMetadata): string {
	switch (artifact.kind) {
		case "download":
			return "Downloaded file";
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
			return "Saved recording";
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
	return artifacts.map((artifact) => {
		const suffix = [
			artifact.mediaType,
			typeof artifact.sizeBytes === "number" ? formatByteCount(artifact.sizeBytes) : undefined,
			artifact.exists === false ? "not found on disk" : undefined,
		].filter((item): item is string => item !== undefined).join(", ");
		return suffix ? `${formatArtifactLabel(artifact)}: ${artifact.path} (${suffix})` : `${formatArtifactLabel(artifact)}: ${artifact.path}`;
	});
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
	if (commandInfo.command === "get") {
		return `${formatGetSummaryLabel(commandInfo.subcommand)}: ${scalarResult.split("\n", 1)[0] ?? scalarResult}`;
	}
	if (commandInfo.command === "eval") {
		return `Eval result: ${scalarResult.split("\n", 1)[0] ?? scalarResult}`;
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
	return origin && origin !== scalarResult ? `${scalarResult}\n\nOrigin: ${origin}` : scalarResult;
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
		lines.push(`Href: ${actionData.href}`);
	}
	if (typeof actionData.navigated === "boolean") {
		lines.push(`Navigated: ${actionData.navigated}`);
	}
	if (lines.length > 0) {
		return lines.join("\n");
	}

	const actionText = stringifyUnknown(actionData).trim();
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

function formatBatchStepError(error: unknown): string {
	const errorText = stringifyUnknown(error).trim();
	return errorText.length > 0 ? `Error: ${errorText}` : "Error: batch step failed.";
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
	cwd: string;
	index: number;
	item: AgentBrowserBatchResult;
	persistentArtifactStore?: PersistentSessionArtifactStore;
}): Promise<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> {
	const { cwd, index, item, persistentArtifactStore } = options;
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
		commandInfo: parseCommandInfo(command ?? []),
		cwd,
		envelope: { data: item.result, success: true },
		persistentArtifactStore,
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
			success: true,
			summary: presentation.summary,
			text,
		},
		presentation,
	};
}

async function buildBatchPresentation(options: {
	cwd: string;
	data: AgentBrowserBatchResult[];
	persistentArtifactStore?: PersistentSessionArtifactStore;
	summary: string;
}): Promise<ToolPresentation> {
	const { cwd, data, persistentArtifactStore, summary } = options;
	const steps: Array<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> = [];
	const protectedPersistentPaths: string[] = [];
	for (const [index, item] of data.entries()) {
		const step = await buildBatchStepPresentation({
			cwd,
			index,
			item,
			persistentArtifactStore: persistentArtifactStore
				? { ...persistentArtifactStore, protectedPaths: protectedPersistentPaths }
				: undefined,
		});
		steps.push(step);
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

	return {
		artifacts: artifacts.length > 0 ? artifacts : undefined,
		batchFailure,
		batchSteps: steps.map((step) => step.details),
		content: [{ type: "text", text }, ...images],
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
		return data;
	}
	if (typeof data === "number" || typeof data === "boolean") {
		return String(data);
	}
	if (Array.isArray(data) && commandInfo.command === "profiles") {
		return formatProfilesText(data, "Chrome profiles");
	}
	if (!isRecord(data)) {
		return stringifyUnknown(data);
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
		return pageSummary;
	}

	return stringifyUnknown(data);
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

async function writeLargeOutputSpillFile(options: {
	data: unknown;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	text: string;
}): Promise<string> {
	const payload =
		typeof options.data === "string"
			? options.data
			: typeof options.data === "number" || typeof options.data === "boolean"
				? String(options.data)
				: options.data === undefined
					? options.text
					: stringifyUnknown(options.data);
	const isStructuredPayload = typeof options.data !== "string" && typeof options.data !== "number" && typeof options.data !== "boolean";
	const fileOptions = {
		content: payload,
		prefix: LARGE_OUTPUT_FILE_PREFIX,
		suffix: isStructuredPayload ? ".json" : ".txt",
	};
	return options.persistentArtifactStore
		? await writePersistentSessionArtifactFile({ ...fileOptions, store: options.persistentArtifactStore })
		: await writeSecureTempFile(fileOptions);
}

async function compactLargePresentationOutput(options: {
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
	let spillErrorText: string | undefined;
	try {
		fullOutputPath = await writeLargeOutputSpillFile({
			data: options.data,
			persistentArtifactStore: options.persistentArtifactStore,
			text,
		});
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
	return options.presentation;
}

export async function buildToolPresentation(options: {
	commandInfo: CommandInfo;
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	errorText?: string;
	persistentArtifactStore?: PersistentSessionArtifactStore;
}): Promise<ToolPresentation> {
	const { commandInfo, cwd, envelope, errorText, persistentArtifactStore } = options;
	if (errorText) {
		return {
			content: [{ type: "text", text: errorText }],
			summary: errorText,
		};
	}

	const data = envelope?.data;
	const artifacts = await extractFileArtifacts(commandInfo, cwd, data);
	const artifactSummary = formatArtifactSummary(artifacts);
	const summary = artifactSummary ?? formatSummary(commandInfo, data);
	const artifactText = artifacts.length > 0 ? formatArtifactMetadataLines(artifacts).join("\n") : undefined;
	const presentation =
		commandInfo.command === "batch" && Array.isArray(data)
			? await buildBatchPresentation({ cwd, data: data as AgentBrowserBatchResult[], persistentArtifactStore, summary })
			: commandInfo.command === "snapshot" && isRecord(data)
				? await buildSnapshotPresentation(data, persistentArtifactStore)
				: {
						artifacts: artifacts.length > 0 ? artifacts : undefined,
						content: [{ type: "text" as const, text: artifactText ?? formatContentText(commandInfo, data) }],
						data,
						summary,
				  };
	if (artifacts.length > 0 && !presentation.artifacts) {
		presentation.artifacts = artifacts;
	}

	const imagePath = extractImagePath(commandInfo, cwd, data);
	const presentationWithImage = imagePath ? await attachInlineImage(presentation, imagePath) : presentation;
	return await compactLargePresentationOutput({
		commandInfo,
		data,
		persistentArtifactStore,
		presentation: presentationWithImage,
	});
}
