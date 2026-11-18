import type { AgentToolResult, KeybindingHints, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";

import { sanitizeRenderedLine, sanitizeRenderedSingleLine } from "./display-sanitize.js";

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
const JSON_TOKEN_PATTERN =
	/"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g;

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

function getPrimaryTextContent(result: unknown): string {
	const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
	const textContent = content.find(
		(item): item is { readonly type: "text"; readonly text: string } =>
			isRecord(item) && item.type === "text" && typeof item.text === "string",
	);
	return textContent ? textContent.text : "";
}

function colorizeToolOutputLines(outputText: string, theme: Theme, isError: boolean): string[] {
	const normalizedLines = trimTrailingBlankLines(
		outputText.replace(/\r\n?/g, "\n").split("\n").map(sanitizeRenderedLine),
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
	expandHint: string,
	theme: Theme,
	width: number,
): string {
	const separator = expandHint.length > 0 ? ", " : "";
	const notice = `${theme.fg("muted", `... (${hidden.remainingLines} more lines, ${hidden.totalLines} total${separator}`)}${expandHint}${theme.fg("muted", ")")}`;
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
} {
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
	const invocation = sanitizeRenderedSingleLine(redactedArgs.join(" ")).replace(/\s+/g, " ").trim();
	return stripTerminalSequences(
		truncateToWidth(invocation, TUI_INVOCATION_PREVIEW_MAX_CHARS, "..."),
	);
}

function formatInvocationDetail(mode: string | undefined, preview: string, theme: Theme): string {
	let text = mode === undefined ? "" : ` ${theme.fg("accent", mode)}`;
	if (preview.length === 0) {
		return text;
	}
	if (mode !== undefined) {
		text += ` ${theme.fg("dim", "→")}`;
	}
	return text + ` ${theme.fg("accent", preview)}`;
}

export function formatAgentBrowserRenderCall(args: unknown, theme: Theme): string {
	const input = isRecord(args) ? args : {};
	const { mode, rawArgs } = getStructuredModeInvocation(input);
	let text = theme.fg("toolTitle", theme.bold("agent_browser"));
	text += formatInvocationDetail(mode, formatInvocationPreview(rawArgs), theme);
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

	const rawResult: unknown = result;
	const details: unknown = isRecord(rawResult) ? rawResult.details : undefined;
	const effectiveError = isError || isFailureDetails(details);
	const outputText = getPrimaryTextContent(rawResult);
	const failureCategoryNotice = formatModelVisibleFailureCategoryNotice(details);
	const outputLines = colorizeToolOutputLines(outputText, theme, effectiveError);
	if (failureCategoryNotice !== undefined && outputLines.length > 0) {
		outputLines.unshift(
			theme.fg("error", sanitizeRenderedSingleLine(failureCategoryNotice).trim()),
			"",
		);
	}
	if (outputLines.length === 0) {
		return formatEmptyResultSummary(details, theme, effectiveError, failureCategoryNotice);
	}

	return `\n${outputLines.join("\n")}`;
}

function isFailureDetails(details: unknown): boolean {
	return (
		isRecord(details) &&
		(details.resultCategory === "failure" ||
			(typeof details.error === "string" && details.error.trim().length > 0))
	);
}

function getFallbackSummaryText(details: unknown): string | undefined {
	if (!isRecord(details)) {
		return undefined;
	}
	let raw: string | undefined;
	if (typeof details.summary === "string") {
		raw = details.summary;
	} else if (typeof details.error === "string") {
		raw = details.error;
	}
	if (raw === undefined) {
		return undefined;
	}
	const sanitized = sanitizeRenderedSingleLine(raw).trim();
	return sanitized.length > 0 ? sanitized : undefined;
}

function formatEmptyResultSummary(
	details: unknown,
	theme: Theme,
	isError: boolean,
	failureCategoryNotice: string | undefined,
): string {
	const effectiveError = isError || isFailureDetails(details);
	const fallback = effectiveError ? "agent-browser failed" : "Done";
	const summary = getFallbackSummaryText(details);
	if (failureCategoryNotice !== undefined) {
		const safeNotice = sanitizeRenderedSingleLine(failureCategoryNotice).trim();
		const body =
			summary !== undefined && summary !== safeNotice ? `${safeNotice}\n\n${summary}` : safeNotice;
		return theme.fg("error", body);
	}
	const text = summary ?? fallback;
	return effectiveError ? theme.fg("error", text) : theme.fg("success", text);
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
		agentBrowserToolResultRequestedJson(result, input) &&
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
export type AgentBrowserResultRenderContext = Pick<KeybindingHints, "keyHint"> & {
	readonly isError: boolean;
};

function buildResultFormatKey(
	rawResult: unknown,
	isPartial: boolean,
	isError: boolean,
	theme: Theme,
): unknown[] {
	const details =
		isRecord(rawResult) && isRecord(rawResult.details) ? rawResult.details : undefined;
	// Theme is a stable proxy in Pi; its resolved colors identify theme/terminal-color changes.
	return [
		getPrimaryTextContent(rawResult),
		details?.summary,
		details?.error,
		details?.resultCategory,
		details?.failureCategory,
		isPartial,
		isError,
		theme,
		theme.colors,
		Reflect.get(theme, "fg"),
	];
}

export class AgentBrowserResultComponent {
	private expanded = false;
	private expandContext: AgentBrowserResultRenderContext | undefined;
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
		// Pi injects the host's current keybinding helpers; store so render applies rebinding lazily.
		this.expandContext = context;
		const key = buildResultFormatKey(result, options.isPartial, isError, theme);
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

	render(width: number): ReturnType<Component["render"]> {
		const lines = this.text.render(width);
		if (this.expanded || lines.length <= TUI_COLLAPSED_OUTPUT_MAX_LINES) {
			return lines;
		}
		const theme = this.theme;
		const context = this.expandContext;
		if (!theme || !context) {
			return lines.slice(0, TUI_COLLAPSED_OUTPUT_MAX_LINES);
		}
		const hiddenLineCount = lines.length - TUI_COLLAPSED_OUTPUT_MAX_LINES;
		return [
			...lines.slice(0, TUI_COLLAPSED_OUTPUT_MAX_LINES),
			formatVisualTruncationNotice(
				{ remainingLines: hiddenLineCount, totalLines: lines.length },
				context.keyHint("app.tools.expand", "to expand"),
				theme,
				width,
			),
		];
	}

	invalidate(): void {
		this.text.invalidate();
	}
}
