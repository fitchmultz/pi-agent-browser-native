/**
 * Purpose: Turn upstream agent-browser JSON output into pi-friendly tool content and details.
 * Responsibilities: Parse the upstream JSON envelope, format content text for the model, derive concise summaries, and attach inline image artifacts when the result points to an image file.
 * Scope: Output shaping only; subprocess execution and pi tool registration live elsewhere.
 * Usage: Imported by the extension entrypoint after the upstream command has finished executing.
 * Invariants/Assumptions: Upstream `agent-browser --json` responses follow the `{ success, data, error }` envelope shape observed on the local development machine.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { CommandInfo } from "./runtime.js";
import { getImageMimeType } from "./runtime.js";

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
	imagePath?: string;
	summary: string;
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
		const origin = typeof data.origin === "string" ? data.origin : "(unknown origin)";
		const refs = isRecord(data.refs) ? Object.keys(data.refs).length : 0;
		const snapshot = getSnapshotText(data);
		if (snapshot) {
			return `Origin: ${origin}\nRefs: ${refs}\n\n${snapshot}`;
		}
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
	const text = formatContentText(commandInfo, data);
	const summary = formatSummary(commandInfo, data);
	const content: ToolPresentation["content"] = [{ type: "text", text }];

	const imagePath = extractImagePath(cwd, data);
	if (!imagePath) {
		return { content, summary };
	}

	const mimeType = getImageMimeType(imagePath);
	if (!mimeType) {
		return { content, summary };
	}

	try {
		const file = await readFile(imagePath);
		content.push({ type: "image", data: file.toString("base64"), mimeType });
		return { content, imagePath, summary };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		content[0] = { type: "text", text: `${text}\n\nImage attachment failed: ${message}` };
		return { content, imagePath, summary };
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
