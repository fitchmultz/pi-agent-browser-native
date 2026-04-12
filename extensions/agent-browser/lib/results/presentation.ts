/**
 * Purpose: Render parsed agent-browser results into concise pi-facing summaries, text content, and optional inline image attachments.
 * Responsibilities: Format command summaries, delegate snapshot-specific rendering to the snapshot module, attach inline images within size limits, and keep generic record formatting distinct from envelope parsing.
 * Scope: Presentation shaping only; upstream stdout parsing and snapshot compaction internals live in separate modules.
 * Usage: Imported by the public `lib/results.ts` facade and consumed by the extension entrypoint after envelope parsing.
 * Invariants/Assumptions: Presentation logic should stay close to upstream data while remaining small enough to reason about without mixing in snapshot-parser or envelope-parser internals.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { parseCommandInfo, type CommandInfo } from "../runtime.js";
import { buildSnapshotPresentation, formatRawSnapshotText, formatSnapshotSummary } from "./snapshot.js";
import {
	type AgentBrowserBatchResult,
	type AgentBrowserEnvelope,
	type BatchFailurePresentationDetails,
	type BatchStepPresentationDetails,
	type ToolPresentation,
	isRecord,
	parsePositiveInteger,
	stringifyUnknown,
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

interface NavigationSummary {
	title?: string;
	url?: string;
}

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
}): Promise<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> {
	const { cwd, index, item } = options;
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
	summary: string;
}): Promise<ToolPresentation> {
	const { cwd, data, summary } = options;
	const steps: Array<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> = [];
	for (const [index, item] of data.entries()) {
		steps.push(await buildBatchStepPresentation({ cwd, index, item }));
	}

	const batchFailure = getBatchFailureDetails(steps);
	const images = steps.flatMap((step) => getPresentationImages(step.presentation));
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
	if (Array.isArray(data) && commandInfo.command === "batch") {
		const successCount = data.filter((item) => isRecord(item) && item.success !== false).length;
		return successCount === data.length ? `Batch: ${successCount}/${data.length} succeeded` : `Batch failed: ${successCount}/${data.length} succeeded`;
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
	if (typeof data === "string") {
		return data;
	}
	if (typeof data === "number" || typeof data === "boolean") {
		return String(data);
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
		commandInfo.command === "batch" && Array.isArray(data)
			? await buildBatchPresentation({ cwd, data: data as AgentBrowserBatchResult[], summary })
			: commandInfo.command === "snapshot" && isRecord(data)
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
