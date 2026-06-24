import type { AgentToolResult, Theme, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Text, truncateToWidth } from "@earendil-works/pi-tui";

import {
	compileAgentBrowserElectron,
	compileAgentBrowserJob,
	compileAgentBrowserNetworkSourceLookup,
	compileAgentBrowserQaPreset,
	compileAgentBrowserSemanticAction,
	compileAgentBrowserSourceLookup,
} from "./input-modes.js";
import { isRecord } from "./parsing.js";
import { redactInvocationArgs } from "./runtime.js";

const TUI_INVOCATION_PREVIEW_MAX_CHARS = 160;
const TUI_COLLAPSED_OUTPUT_MAX_LINES = 12;
const ANSI_CONTROL_SEQUENCE_PATTERN = /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|P[^\x1B]*(?:\x1B\\)|_[^\x1B]*(?:\x1B\\)|\^[^\x1B]*(?:\x1B\\)|[@-Z\\-_])/g;
const JSON_TOKEN_PATTERN = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g;
const UNSAFE_DISPLAY_CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

function sanitizeDisplayText(value: string): string {
	return value
		.replace(ANSI_CONTROL_SEQUENCE_PATTERN, "")
		.replace(/\r/g, "")
		.replace(UNSAFE_DISPLAY_CONTROL_PATTERN, "�");
}

function replaceTabsForDisplay(value: string): string {
	return value.replaceAll("\t", "    ");
}

function trimTrailingBlankLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim().length === 0) {
		end -= 1;
	}
	return lines.slice(0, end);
}

function isJsonDocumentText(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

function colorizeJsonLine(line: string, theme: Theme): string {
	let output = "";
	let cursor = 0;
	for (const match of line.matchAll(JSON_TOKEN_PATTERN)) {
		const token = match[0];
		const index = match.index ?? 0;
		output += line.slice(cursor, index);
		const color = token.startsWith('"')
			? /"\s*$/.test(token) && line.slice(index + token.length).trimStart().startsWith(":")
				? "syntaxVariable"
				: "syntaxString"
			: /^[{}\[\],:]$/.test(token)
				? "syntaxPunctuation"
				: "syntaxType";
		output += theme.fg(color, token);
		cursor = index + token.length;
	}
	return output + line.slice(cursor);
}

function getPrimaryTextContent(result: AgentToolResult<unknown>): string {
	const textContent = result.content.find((item) => item.type === "text");
	return textContent?.type === "text" ? textContent.text : "";
}

function colorizeToolOutputLines(outputText: string, theme: Theme, isError: boolean): string[] {
	const normalizedLines = trimTrailingBlankLines(replaceTabsForDisplay(sanitizeDisplayText(outputText)).split("\n"));
	const normalizedText = normalizedLines.join("\n");
	if (normalizedText.length === 0) return [];
	const isJsonDocument = !isError && isJsonDocumentText(normalizedText);
	return normalizedLines.map((line) => {
		if (line.length === 0) {
			return "";
		}
		if (isJsonDocument) return colorizeJsonLine(line, theme);
		return isError ? theme.fg("error", line) : theme.fg("toolOutput", line);
	});
}

// ponytail: "app.tools.expand" is a host-registered keybinding id (coding-agent augments pi-tui's
// Keybindings via declaration merging); getKeys returns [] before the host registers its ids
// (bare-node tests), so fall back to the stock ctrl+o. pi-tui is already a runtime import at
// the entrypoint, so getKeybindings() adds no startup tax.
function formatExpandHint(theme: Theme): string {
	const key = getKeybindings().getKeys("app.tools.expand")[0] ?? "ctrl+o";
	return `${theme.fg("dim", key)} ${theme.fg("muted", "to expand")}`;
}

function formatVisualTruncationNotice(remainingLines: number, totalLines: number, theme: Theme, width: number): string {
	const notice = `${theme.fg("muted", `... (${remainingLines} more lines, ${totalLines} total, `)}${formatExpandHint(theme)}${theme.fg("muted", ")")}`;
	return truncateToWidth(notice, Math.max(0, width));
}

function getStructuredModeInvocation(input: Record<string, unknown>): { mode?: string; rawArgs: string[] } {
	if (Array.isArray(input.args)) return { rawArgs: input.args.filter((value): value is string => typeof value === "string") };
	if (input.semanticAction !== undefined) return { mode: "semanticAction", rawArgs: compileAgentBrowserSemanticAction(input.semanticAction).compiled?.args ?? [] };
	if (input.job !== undefined) return { mode: "job", rawArgs: compileAgentBrowserJob(input.job).compiled?.args ?? [] };
	if (input.qa !== undefined) return { mode: "qa", rawArgs: compileAgentBrowserQaPreset(input.qa).compiled?.args ?? [] };
	if (input.sourceLookup !== undefined) return { mode: "sourceLookup", rawArgs: compileAgentBrowserSourceLookup(input.sourceLookup).compiled?.args ?? [] };
	if (input.networkSourceLookup !== undefined) return { mode: "networkSourceLookup", rawArgs: compileAgentBrowserNetworkSourceLookup(input.networkSourceLookup).compiled?.args ?? [] };
	if (input.electron !== undefined) {
		const electron = compileAgentBrowserElectron(input.electron);
		return { mode: "electron", rawArgs: electron.compiled ? ["electron", electron.compiled.action] : [] };
	}
	return { rawArgs: [] };
}

function formatInvocationPreview(rawArgs: string[]): string {
	const redactedArgs = redactInvocationArgs(rawArgs);
	const invocation = sanitizeDisplayText(redactedArgs.join(" ")).replace(/\s+/g, " ").trim();
	return invocation.length > TUI_INVOCATION_PREVIEW_MAX_CHARS
		? `${invocation.slice(0, TUI_INVOCATION_PREVIEW_MAX_CHARS - 3)}...`
		: invocation;
}

export function formatAgentBrowserRenderCall(args: unknown, theme: Theme): string {
	const input = isRecord(args) ? args : {};
	const { mode, rawArgs } = getStructuredModeInvocation(input);
	const invocationPreview = formatInvocationPreview(rawArgs);
	let text = theme.fg("toolTitle", theme.bold("agent_browser"));
	if (mode) {
		text += ` ${theme.fg("accent", mode)}`;
		if (invocationPreview.length > 0) {
			text += ` ${theme.fg("dim", "→")} ${theme.fg("accent", invocationPreview)}`;
		}
	} else if (invocationPreview.length > 0) {
		text += ` ${theme.fg("accent", invocationPreview)}`;
	}
	if (input.sessionMode === "fresh") {
		text += theme.fg("dim", " sessionMode=fresh");
	}
	if (typeof input.stdin === "string") {
		text += theme.fg("dim", " + stdin");
	}
	return text;
}

export function formatAgentBrowserRenderResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	isError: boolean,
): string {
	if (options.isPartial) {
		return theme.fg("warning", "Running agent-browser...");
	}

	const outputText = getPrimaryTextContent(result);
	const failureCategoryNotice = formatModelVisibleFailureCategoryNotice(result.details);
	const outputLines = colorizeToolOutputLines(outputText, theme, isError);
	if (failureCategoryNotice && outputLines.length > 0) {
		outputLines.unshift(theme.fg("error", failureCategoryNotice), "");
	}
	if (outputLines.length === 0) {
		const details = isRecord(result.details) ? result.details : undefined;
		const rawSummary = typeof details?.summary === "string" ? details.summary : isError ? "agent-browser failed" : "Done";
		const sanitizedSummary = sanitizeDisplayText(rawSummary).trim();
		const summary = sanitizedSummary.length > 0 ? sanitizedSummary : isError ? "agent-browser failed" : "Done";
		return isError ? theme.fg("error", summary) : theme.fg("success", summary);
	}

	return `\n${outputLines.join("\n")}`;
}

function formatModelVisibleFailureCategoryNotice(details: unknown): string | undefined {
	if (!isRecord(details) || details.resultCategory !== "failure") return undefined;
	const failureCategory = typeof details.failureCategory === "string" && details.failureCategory.length > 0
		? details.failureCategory
		: undefined;
	return `Result category: failure${failureCategory ? `; failureCategory: ${failureCategory}` : ""}; Pi tool isError: true.`;
}

type AgentBrowserToolContent = AgentToolResult<unknown>["content"];
type AgentBrowserToolContentItem = AgentBrowserToolContent[number];

export type AgentBrowserToolResultPatch = {
	content?: AgentBrowserToolContent;
	isError?: boolean;
};

function agentBrowserToolResultRequestedJson(event: ToolResultEvent): boolean {
	const details = isRecord(event.details) ? event.details : undefined;
	const detailArgs = Array.isArray(details?.args) ? details.args : undefined;
	const inputArgs = isRecord(event.input) && Array.isArray(event.input.args) ? event.input.args : undefined;
	return detailArgs?.includes("--json") === true || inputArgs?.includes("--json") === true;
}

function agentBrowserToolResultHasParseableJsonContent(content: AgentBrowserToolContent): boolean {
	return content.some((item) => {
		if (item.type !== "text" || typeof item.text !== "string") return false;
		const text = item.text.trim();
		if (text.length === 0) return false;
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	});
}

function appendModelVisibleFailureCategoryNotice(content: AgentBrowserToolContent, notice: string): AgentBrowserToolContent | undefined {
	const noticeContent: AgentBrowserToolContentItem = { type: "text", text: notice };
	const textIndex = content.findIndex((item) => item.type === "text" && typeof item.text === "string");
	if (textIndex === -1) return [noticeContent, ...content];
	const textItem = content[textIndex];
	if (textItem.type !== "text" || typeof textItem.text !== "string" || textItem.text.includes(notice)) return undefined;
	return content.map((item, index) => index === textIndex
		? { ...item, text: `${textItem.text}\n\n${notice}` }
		: item);
}

export function buildAgentBrowserToolResultPatch(event: ToolResultEvent): AgentBrowserToolResultPatch | undefined {
	if (event.toolName !== "agent_browser") return undefined;
	const preservesParseableJson = agentBrowserToolResultRequestedJson(event) && agentBrowserToolResultHasParseableJsonContent(event.content);
	const notice = preservesParseableJson ? undefined : formatModelVisibleFailureCategoryNotice(event.details);
	const content = notice ? appendModelVisibleFailureCategoryNotice(event.content, notice) : undefined;
	const shouldMarkError = isRecord(event.details) && event.details.resultCategory === "failure" && event.isError !== true;
	if (!shouldMarkError && !content) return undefined;
	return {
		...(content ? { content } : {}),
		...(shouldMarkError ? { isError: true } : {}),
	};
}

export class AgentBrowserResultComponent {
	private expanded = false;
	private theme: Theme | undefined;
	private readonly text = new Text("", 0, 0);

	setState(value: string, expanded: boolean, theme: Theme): void {
		this.text.setText(value);
		this.expanded = expanded;
		this.theme = theme;
	}

	render(width: number): string[] {
		const lines = this.text.render(width);
		if (this.expanded || lines.length <= TUI_COLLAPSED_OUTPUT_MAX_LINES) {
			return lines;
		}
		const theme = this.theme;
		if (!theme) {
			return lines.slice(0, TUI_COLLAPSED_OUTPUT_MAX_LINES);
		}
		const hiddenLineCount = lines.length - TUI_COLLAPSED_OUTPUT_MAX_LINES;
		return [
			...lines.slice(0, TUI_COLLAPSED_OUTPUT_MAX_LINES),
			formatVisualTruncationNotice(hiddenLineCount, lines.length, theme, width),
		];
	}

	invalidate(): void {
		this.text.invalidate();
	}
}
