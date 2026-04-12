/**
 * Purpose: Render parsed agent-browser results into concise pi-facing summaries, text content, and optional inline image attachments.
 * Responsibilities: Format command summaries, delegate snapshot-specific rendering to the snapshot module, attach inline images within size limits, and keep generic record formatting distinct from envelope parsing.
 * Scope: Presentation shaping only; upstream stdout parsing and snapshot compaction internals live in separate modules.
 * Usage: Imported by the public `lib/results.ts` facade and consumed by the extension entrypoint after envelope parsing.
 * Invariants/Assumptions: Presentation logic should stay close to upstream data while remaining small enough to reason about without mixing in snapshot-parser or envelope-parser internals.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { CommandInfo } from "../runtime.js";
import { buildSnapshotPresentation, formatRawSnapshotText, formatSnapshotSummary } from "./snapshot.js";
import { type AgentBrowserBatchResult, type AgentBrowserEnvelope, type ToolPresentation, isRecord, parsePositiveInteger, stringifyUnknown } from "./shared.js";

const IMAGE_EXTENSION_TO_MIME_TYPE: Record<string, string> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

const INLINE_IMAGE_MAX_BYTES_ENV = "PI_AGENT_BROWSER_INLINE_IMAGE_MAX_BYTES";
const DEFAULT_INLINE_IMAGE_MAX_BYTES = 5 * 1_024 * 1_024;

function getImageMimeType(filePath: string): string | undefined {
	const extension = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
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

	return await attachInlineImage(presentation, imagePath);
}
