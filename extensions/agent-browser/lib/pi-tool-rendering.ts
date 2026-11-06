import type { AgentToolResult, KeybindingHints, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

import { compileAgentBrowserElectron } from "./input-modes/electron.js";
import { compileAgentBrowserQaPreset } from "./input-modes/job.js";
import {
	compileAgentBrowserNetworkSourceLookup,
	compileAgentBrowserSourceLookup,
} from "./input-modes/lookups.js";
import { compileAgentBrowserSemanticAction } from "./input-modes/semantic-action.js";
import { isRecord } from "./parsing.js";
import { redactInvocationArgs } from "./runtime-redaction.js";
import { isBooleanFlagEnabled } from "./argv-grammar.js";

const TUI_INVOCATION_PREVIEW_MAX_CHARS = 160;
const TUI_COLLAPSED_OUTPUT_MAX_LINES = 12;
const ANSI_CONTROL_SEQUENCE_PATTERN =
	// Strip terminal escape/control sequences from untrusted browser text, not printable content.
	/\x1B(?:\][^\x07\x1B\r\n\u2028\u2029]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|P[^\x1B\r\n\u2028\u2029]*(?:\x1B\\)|_[^\x1B\r\n\u2028\u2029]*(?:\x1B\\)|\^[^\x1B\r\n\u2028\u2029]*(?:\x1B\\)|[@-Z\\-_])/g;
const JSON_TOKEN_PATTERN =
	/"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g;
// Replace C0/C1 display controls so browser text cannot execute terminal controls.
const UNSAFE_DISPLAY_CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;
const UNSAFE_DISPLAY_DIRECTIONAL_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const UNSAFE_DISPLAY_ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/g;

function sanitizeDisplayText(value: string, markRemovedSequences = false): string {
	let sanitized = value
		.replace(/\r\n?/g, "\n")
		.replace(ANSI_CONTROL_SEQUENCE_PATTERN, markRemovedSequences ? "�" : "")
		.replace(UNSAFE_DISPLAY_CONTROL_PATTERN, "�")
		.replace(UNSAFE_DISPLAY_DIRECTIONAL_PATTERN, "�");
	if (markRemovedSequences) {
		sanitized = sanitized
			.replace(/[\u2028\u2029]/g, "\n")
			.replace(UNSAFE_DISPLAY_ZERO_WIDTH_PATTERN, "�");
	}
	return sanitized;
}

function replaceTabsForDisplay(value: string): string {
	return value.replaceAll("\t", "    ");
}

function trimTrailingBlankLines(lines: readonly string[]): string[] {
	return lines.slice(0, lines.findLastIndex((line) => line.trim().length > 0) + 1);
}

function isJsonDocumentText(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
		return false;
	}
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

function jsonTokenColor(token: string, remainder: string): Parameters<Theme["fg"]>[0] {
	if (token.startsWith('"')) {
		return /"\s*$/.test(token) && remainder.trimStart().startsWith(":")
			? "syntaxVariable"
			: "syntaxString";
	}
	return /^[{}[\],:]$/.test(token) ? "syntaxPunctuation" : "syntaxType";
}

function colorizeJsonLine(line: string, theme: Theme): string {
	let output = "";
	let cursor = 0;
	for (const match of line.matchAll(JSON_TOKEN_PATTERN)) {
		const token = match[0];
		const index = match.index;
		output += line.slice(cursor, index);
		const color = jsonTokenColor(token, line.slice(index + token.length));
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
	const normalizedLines = trimTrailingBlankLines(
		replaceTabsForDisplay(sanitizeDisplayText(outputText)).split("\n"),
	);
	const normalizedText = normalizedLines.join("\n");
	if (normalizedText.length === 0) {
		return [];
	}
	const isJsonDocument = !isError && isJsonDocumentText(normalizedText);
	return normalizedLines.map((line) => {
		if (line.length === 0) {
			return "";
		}
		if (isJsonDocument) {
			return colorizeJsonLine(line, theme);
		}
		return isError ? theme.fg("error", line) : theme.fg("toolOutput", line);
	});
}

function formatVisualTruncationNotice(
	hidden: { readonly remainingLines: number; readonly totalLines: number },
	expandKey: string,
	theme: Theme,
	width: number,
): string {
	const expandHint = `${theme.fg("dim", expandKey)} ${theme.fg("muted", "to expand")}`;
	const notice = `${theme.fg("muted", `... (${hidden.remainingLines} more lines, ${hidden.totalLines} total, `)}${expandHint}${theme.fg("muted", ")")}`;
	return truncateToWidth(notice, Math.max(0, width));
}

function compiledArgs(result: {
	readonly compiled?: { readonly args: readonly string[] };
}): readonly string[] {
	return result.compiled?.args ?? [];
}

function getStructuredModeInvocation(input: Readonly<Record<string, unknown>>): {
	readonly mode?: string;
	readonly rawArgs: readonly string[];
	readonly scriptSource?: string;
} {
	if (typeof input.code === "string") {
		return { mode: "code", rawArgs: [], scriptSource: input.code };
	}
	if (Array.isArray(input.args)) {
		return {
			rawArgs: input.args.filter((value: unknown): value is string => typeof value === "string"),
		};
	}
	if (input.semanticAction !== undefined) {
		return {
			mode: "semanticAction",
			rawArgs: compiledArgs(compileAgentBrowserSemanticAction(input.semanticAction)),
		};
	}
	if (input.qa !== undefined) {
		return { mode: "qa", rawArgs: compiledArgs(compileAgentBrowserQaPreset(input.qa)) };
	}
	if (input.sourceLookup !== undefined) {
		return {
			mode: "sourceLookup",
			rawArgs: compiledArgs(compileAgentBrowserSourceLookup(input.sourceLookup)),
		};
	}
	if (input.networkSourceLookup !== undefined) {
		return {
			mode: "networkSourceLookup",
			rawArgs: compiledArgs(compileAgentBrowserNetworkSourceLookup(input.networkSourceLookup)),
		};
	}
	if (input.electron !== undefined) {
		const electron = compileAgentBrowserElectron(input.electron);
		return {
			mode: "electron",
			rawArgs: electron.compiled ? ["electron", electron.compiled.action] : [],
		};
	}
	return { rawArgs: [] };
}

function formatInvocationPreview(rawArgs: readonly string[]): string {
	const redactedArgs = redactInvocationArgs(rawArgs);
	const invocation = sanitizeDisplayText(redactedArgs.join(" ")).replace(/\s+/g, " ").trim();
	return invocation.length > TUI_INVOCATION_PREVIEW_MAX_CHARS
		? `${invocation.slice(0, TUI_INVOCATION_PREVIEW_MAX_CHARS - 3)}...`
		: invocation;
}

function formatScriptSourceForDisplay(source: string, expanded: boolean): string {
	const sanitizedSource = replaceTabsForDisplay(sanitizeDisplayText(source, true));
	if (expanded) {
		return sanitizedSource;
	}
	const preview = sanitizedSource.replace(/\n/g, " ↵ ").replace(/\s+/g, " ").trim();
	return preview.length > TUI_INVOCATION_PREVIEW_MAX_CHARS
		? `${preview.slice(0, TUI_INVOCATION_PREVIEW_MAX_CHARS - 3)}...`
		: preview;
}

function formatInvocationDetail(
	mode: string | undefined,
	preview: string,
	expandedCode: boolean,
	theme: Theme,
): string {
	let text = mode !== undefined && mode !== "code" ? ` ${theme.fg("accent", mode)}` : "";
	if (mode !== undefined && expandedCode) {
		return text + `\n${theme.fg("dim", "Source:")}\n${theme.fg("accent", preview)}`;
	}
	if (preview.length === 0) {
		return text;
	}
	if (mode !== undefined) {
		text += ` ${theme.fg("dim", "→")}`;
	}
	return text + ` ${theme.fg("accent", preview)}`;
}

export function formatAgentBrowserRenderCall(
	args: unknown,
	theme: Theme,
	expanded = false,
): string {
	const input = isRecord(args) ? args : {};
	const { mode, rawArgs, scriptSource } = getStructuredModeInvocation(input);
	const invocationPreview =
		scriptSource === undefined
			? formatInvocationPreview(rawArgs)
			: formatScriptSourceForDisplay(scriptSource, expanded);
	let text = theme.fg(
		"toolTitle",
		theme.bold(mode === "code" ? "agent_browser_code" : "agent_browser"),
	);
	text += formatInvocationDetail(
		mode,
		invocationPreview,
		scriptSource !== undefined && expanded,
		theme,
	);
	if (input.sessionMode === "fresh") {
		text += theme.fg("dim", " sessionMode=fresh");
	}
	if (typeof input.stdin === "string") {
		text += theme.fg("dim", " + stdin");
	}
	return text;
}

function formatAgentBrowserRenderResult(
	result: AgentToolResult<unknown>,
	options: { readonly expanded: boolean; readonly isPartial: boolean },
	theme: Theme,
	isError: boolean,
): string {
	if (options.isPartial) {
		return theme.fg("warning", "Running agent-browser...");
	}

	const outputText = getPrimaryTextContent(result);
	const failureCategoryNotice = formatModelVisibleFailureCategoryNotice(result.details);
	const outputLines = colorizeToolOutputLines(outputText, theme, isError);
	if (failureCategoryNotice !== undefined && outputLines.length > 0) {
		outputLines.unshift(theme.fg("error", failureCategoryNotice), "");
	}
	if (outputLines.length === 0) {
		return formatEmptyResultSummary(result.details, theme, isError);
	}

	return `\n${outputLines.join("\n")}`;
}

function formatEmptyResultSummary(details: unknown, theme: Theme, isError: boolean): string {
	const fallback = isError ? "agent-browser failed" : "Done";
	const rawSummary =
		isRecord(details) && typeof details.summary === "string" ? details.summary : fallback;
	const sanitizedSummary = sanitizeDisplayText(rawSummary).trim();
	const summary = sanitizedSummary.length > 0 ? sanitizedSummary : fallback;
	return isError ? theme.fg("error", summary) : theme.fg("success", summary);
}

function formatModelVisibleFailureCategoryNotice(details: unknown): string | undefined {
	if (!isRecord(details) || details.resultCategory !== "failure") {
		return undefined;
	}
	const failureCategory =
		typeof details.failureCategory === "string" && details.failureCategory.length > 0
			? details.failureCategory
			: undefined;
	return `Result category: failure${failureCategory !== undefined ? `; failureCategory: ${failureCategory}` : ""}; Pi tool isError: true.`;
}

type AgentBrowserToolContent = AgentToolResult<unknown>["content"];

function agentBrowserToolResultRequestedJson(
	result: AgentToolResult<unknown>,
	input: unknown,
): boolean {
	const details = isRecord(result.details) ? result.details : undefined;
	const detailArgs = Array.isArray(details?.args) ? details.args : undefined;
	const inputArgs = isRecord(input) && Array.isArray(input.args) ? input.args : undefined;
	return (
		isBooleanFlagEnabled(detailArgs ?? [], "--json") ||
		isBooleanFlagEnabled(inputArgs ?? [], "--json")
	);
}

function agentBrowserToolResultHasParseableJsonContent(result: AgentToolResult<unknown>): boolean {
	return result.content.some((item) => {
		if (item.type !== "text" || typeof item.text !== "string") {
			return false;
		}
		const text = item.text.trim();
		if (text.length === 0) {
			return false;
		}
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	});
}

function appendModelVisibleFailureCategoryNotice(
	result: AgentToolResult<unknown>,
	notice: string,
): AgentBrowserToolContent | undefined {
	const content = result.content;
	for (const [index, item] of content.entries()) {
		if (item.type !== "text" || typeof item.text !== "string") {
			continue;
		}
		if (item.text.includes(notice)) {
			return undefined;
		}
		const updatedContent = [...content];
		updatedContent[index] = { ...item, text: `${item.text}\n\n${notice}` };
		return updatedContent;
	}
	return [{ type: "text", text: notice }, ...content];
}

export type FinalizedToolResult<Details = unknown> = AgentToolResult<Details> & {
	isError: boolean;
};

export function finalizeAgentBrowserFailure<Details>(
	result: AgentToolResult<Details>,
	input: unknown,
): FinalizedToolResult<Details> {
	const failed =
		result.isError === true ||
		(isRecord(result.details) && result.details.resultCategory === "failure");
	const preservesParseableJson =
		((isRecord(input) && "code" in input) || agentBrowserToolResultRequestedJson(result, input)) &&
		agentBrowserToolResultHasParseableJsonContent(result);
	const notice = preservesParseableJson
		? undefined
		: formatModelVisibleFailureCategoryNotice(result.details);
	const content =
		notice !== undefined ? appendModelVisibleFailureCategoryNotice(result, notice) : undefined;
	return {
		...result,
		content: content ?? result.content,
		isError: failed,
	};
}

/** Host render-context fields the result component reads on each render pass. */
export type AgentBrowserResultRenderContext = Pick<KeybindingHints, "keyText"> & {
	readonly isError: boolean;
};

export class AgentBrowserResultComponent {
	private expanded = false;
	private expandKey = "";
	private theme: Theme | undefined;
	private readonly text = new Text("", 0, 0);
	private value: string | undefined;
	private formatKey: unknown[] | undefined;

	setResult(
		result: AgentToolResult<unknown>,
		options: { readonly expanded: boolean; readonly isPartial: boolean },
		theme: Theme,
		context: AgentBrowserResultRenderContext,
	): void {
		const { isError } = context;
		// Pi injects the host's current keybinding text; resolve it per pass so rebinding applies.
		this.expandKey = context.keyText("app.tools.expand");
		const details = isRecord(result.details) ? result.details : undefined;
		// Theme is a stable proxy in Pi; its resolved colors identify theme/terminal-color changes.
		const key = [
			getPrimaryTextContent(result),
			details?.summary,
			details?.resultCategory,
			details?.failureCategory,
			options.isPartial,
			isError,
			theme,
			theme.colors,
			Reflect.get(theme, "fg"),
		];
		const previousKey = this.formatKey;
		if (!previousKey || key.some((value, index) => value !== previousKey[index])) {
			this.formatKey = key;
			this.setState(
				formatAgentBrowserRenderResult(result, options, theme, isError),
				options.expanded,
				theme,
			);
		} else {
			this.expanded = options.expanded;
			this.theme = theme;
		}
	}

	setState(value: string, expanded: boolean, theme: Theme): void {
		if (value !== this.value) {
			this.text.setText(value);
			this.value = value;
		}
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
			formatVisualTruncationNotice(
				{ remainingLines: hiddenLineCount, totalLines: lines.length },
				this.expandKey,
				theme,
				width,
			),
		];
	}

	invalidate(): void {
		this.text.invalidate();
	}
}
