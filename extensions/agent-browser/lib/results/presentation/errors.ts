import type { CommandInfo } from "../../runtime.js";
import { redactModelFacingText } from "./common.js";
import { buildAgentBrowserNextActions } from "../action-recommendations.js";
import { buildAgentBrowserResultCategoryDetails } from "../categories.js";
import type { AgentBrowserNextAction, ToolPresentation } from "../contracts.js";
import { withOptionalSessionArgs } from "../next-actions.js";

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
	if (normalized.length === 0) return undefined;

	if (/\bUnknown ref\b|\bstale ref\b|\bref\b.*\b(?:not found|missing|expired)\b/i.test(normalized)) {
		return STALE_REF_ERROR_HINT;
	}

	const mentionsPlaywrightSelectorDialect = /(?:\btext=|:has-text\(|\bgetByRole\b|\bgetByText\b)/i.test(normalized);
	const reportsSelectorMatchFailure =
		/\b(?:no elements? found|failed to find|could not find|unable to find)\b.*\b(?:selector|locator)\b/i.test(normalized) ||
		/\b(?:selector|locator)\b.*\b(?:no elements? found|not found|missing|failed to find|could not find|unable to find)\b/i.test(normalized);

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

interface CommandSuggestion {
	args?: string[];
	description: string;
	id?: string;
}

const UNKNOWN_COMMAND_SUGGESTIONS: Record<string, CommandSuggestion[]> = {
	attr: [{ description: "Use `get attr <selector> <name>` to read an attribute from a selector or current `@ref`." }],
	count: [{ description: "Use `get count <selector>` to count matching elements." }],
	html: [{ description: "Use `get html <selector>` to read element HTML, or `get html` for the page when upstream supports it." }],
	text: [{ description: "Use `get text <selector>` to read text from a selector or current `@ref`; run `snapshot -i` first when you need a safe `@ref`." }],
	title: [{ args: ["get", "title"], description: "Use `get title` to read the current page title.", id: "use-get-title" }],
	url: [{ args: ["get", "url"], description: "Use `get url` to read the current page URL.", id: "use-get-url" }],
	value: [{ description: "Use `get value <selector>` to read form control value from a selector or current `@ref`." }],
};

function getUnknownCommandSuggestions(command: string | undefined, errorText: string): CommandSuggestion[] {
	if (!command) return [];
	const normalizedCommand = command.trim().toLowerCase();
	if (!/\bunknown\s+command\b|\bunknown\s+subcommand\b|\bunrecognized\s+command\b/i.test(errorText)) return [];
	return UNKNOWN_COMMAND_SUGGESTIONS[normalizedCommand] ?? [];
}

function formatUnknownCommandSuggestionText(suggestions: CommandSuggestion[]): string | undefined {
	if (suggestions.length === 0) return undefined;
	return ["Agent-browser hint: This looks like a getter shortcut, but upstream getter commands are grouped under `get`.", ...suggestions.map((suggestion) => suggestion.description)].join(" ");
}

function buildUnknownCommandSuggestionActions(suggestions: CommandSuggestion[], sessionName: string | undefined): AgentBrowserNextAction[] | undefined {
	const actions = suggestions
		.filter((suggestion): suggestion is CommandSuggestion & { args: string[]; id: string } => suggestion.args !== undefined && suggestion.id !== undefined)
		.map((suggestion) => ({
			id: suggestion.id,
			params: { args: withOptionalSessionArgs(sessionName, suggestion.args) },
			reason: suggestion.description,
			safety: "Read-only getter command; safe to retry when you intended to inspect page state.",
			tool: "agent_browser" as const,
		}));
	return actions.length > 0 ? actions : undefined;
}

export function appendSelectorRecoveryHint(errorText: string): string {
	const hint = getSelectorRecoveryHint(errorText);
	if (!hint || errorText.includes("Agent-browser hint:")) return errorText;
	return `${errorText}\n\n${hint}`;
}

export function buildErrorPresentation(options: {
	args?: string[];
	commandInfo: CommandInfo;
	errorText: string;
	sessionName?: string;
}): ToolPresentation {
	const { args, commandInfo, errorText, sessionName } = options;
	const safeErrorText = redactModelFacingText(errorText);
	const selectorHintedErrorText = appendSelectorRecoveryHint(safeErrorText);
	const unknownCommandSuggestions = getUnknownCommandSuggestions(commandInfo.command, safeErrorText);
	const unknownCommandSuggestionText = formatUnknownCommandSuggestionText(unknownCommandSuggestions);
	const hintedErrorText = unknownCommandSuggestionText && !selectorHintedErrorText.includes("Agent-browser hint:")
		? `${selectorHintedErrorText}\n\n${unknownCommandSuggestionText}`
		: selectorHintedErrorText;
	const categoryDetails = buildAgentBrowserResultCategoryDetails({
		args: [commandInfo.command, commandInfo.subcommand].filter((item): item is string => item !== undefined),
		command: commandInfo.command,
		errorText: hintedErrorText,
		succeeded: false,
	});
	const nextActions = [
		...(buildUnknownCommandSuggestionActions(unknownCommandSuggestions, sessionName) ?? []),
		...(buildAgentBrowserNextActions({
			args,
			command: commandInfo.command,
			failureCategory: categoryDetails.failureCategory,
			resultCategory: "failure",
		}) ?? []),
	];
	return {
		...categoryDetails,
		content: [{ type: "text", text: hintedErrorText }],
		nextActions: nextActions.length > 0 ? nextActions : undefined,
		summary: hintedErrorText,
	};
}
