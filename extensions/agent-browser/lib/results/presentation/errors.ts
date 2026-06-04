import { isOpenNavigationCommand } from "../../command-taxonomy.js";
import { redactSensitiveText, type CommandInfo } from "../../runtime.js";
import { buildBrowserProfileConfigRecovery } from "./browser-profile-recovery.js";
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

const CLIPBOARD_PERMISSION_ERROR_HINT = [
	"Agent-browser clipboard hint: Clipboard read/write access is environment-dependent and often fails in headless, managed, remote-profile, or file:// sessions.",
	"If you see `NotAllowedError` or `permission denied`, treat it as a browser/OS permission limitation rather than proof that page state changed.",
	"When possible, prefer page-native reads (`snapshot -i`, `get text`, `eval --stdin`) or direct input (`keyboard inserttext` / `keyboard type`) instead of relying on OS clipboard access.",
	"If true clipboard access is required, retry in a browser/profile/session with explicit clipboard permission on a normal http(s) page.",
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

function getClipboardPermissionHint(commandInfo: CommandInfo, errorText: string): string | undefined {
	if (commandInfo.command !== "clipboard") return undefined;
	if (!/\bNotAllowedError\b|\bclipboard\b.*\bpermission denied\b|\bpermission denied\b.*\bclipboard\b/i.test(errorText)) {
		return undefined;
	}
	return CLIPBOARD_PERMISSION_ERROR_HINT;
}

export function redactClipboardPermissionEcho(commandInfo: CommandInfo, errorText: string): string {
	if (commandInfo.command !== "clipboard") return errorText;
	return errorText
		.replace(/(\b(?:read|write)\s+permission denied\b(?:\s+for)?\s+)([\s\S]+)$/gi, "$1[REDACTED]")
		.replace(/(\bFailed to execute '[^']+' on 'Clipboard':\s*)([\s\S]+)$/gi, (match, prefix: string, suffix: string) => {
			if (!/\bpermission denied\b/i.test(suffix)) return match;
			return `${prefix}${suffix.replace(/(\bpermission denied\b(?:\s+for)?\s+)([\s\S]+)$/i, "$1[REDACTED]")}`;
		});
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

function getLocalhostNavigationHint(commandInfo: CommandInfo, errorText: string): string | undefined {
	if (!commandInfo.command || !isOpenNavigationCommand(commandInfo.command) || !commandInfo.subcommand) return undefined;
	if (!/\bnet::ERR_(?:EMPTY_RESPONSE|CONNECTION_REFUSED|ADDRESS_UNREACHABLE|TIMED_OUT|CONNECTION_RESET)\b/i.test(errorText)) return undefined;

	let targetUrl: URL;
	try {
		targetUrl = new URL(commandInfo.subcommand);
	} catch {
		return undefined;
	}

	if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(targetUrl.hostname.toLowerCase())) return undefined;

	return [
		"Agent-browser local fixture hint: the browser process could not read a loopback URL from its own network namespace or browser host.",
		"Verify the server is still running and bound to an address the browser host can reach; if curl works from the shell but browser navigation fails, try the other loopback alias, add a proxy bypass for localhost/127.0.0.1 if a proxy is configured, or use a browser-host-reachable URL.",
		"Use file:// only for static fallback fixtures and clean up any temporary server process outside agent_browser when the check is done.",
	].join(" ");
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
	const safeErrorText = redactModelFacingText(
		redactSensitiveText(redactClipboardPermissionEcho(commandInfo, errorText)),
	);
	const selectorHintedErrorText = appendSelectorRecoveryHint(safeErrorText);
	const unknownCommandSuggestions = getUnknownCommandSuggestions(commandInfo.command, safeErrorText);
	const unknownCommandSuggestionText = formatUnknownCommandSuggestionText(unknownCommandSuggestions);
	const browserProfileConfigRecovery = buildBrowserProfileConfigRecovery({ args, commandInfo, errorText: safeErrorText });
	const localhostNavigationHint = getLocalhostNavigationHint(commandInfo, safeErrorText);
	const clipboardPermissionHint = getClipboardPermissionHint(commandInfo, safeErrorText);
	const hintedErrorParts = [
		selectorHintedErrorText,
		unknownCommandSuggestionText && !selectorHintedErrorText.includes("Agent-browser hint:") ? unknownCommandSuggestionText : undefined,
		browserProfileConfigRecovery?.hint,
		localhostNavigationHint,
		clipboardPermissionHint,
	].filter((part): part is string => Boolean(part));
	const hintedErrorText = hintedErrorParts.join("\n\n");
	const categoryDetails = buildAgentBrowserResultCategoryDetails({
		args: [commandInfo.command, commandInfo.subcommand].filter((item): item is string => item !== undefined),
		command: commandInfo.command,
		errorText: hintedErrorText,
		succeeded: false,
	});
	const nextActions = [
		...(buildUnknownCommandSuggestionActions(unknownCommandSuggestions, sessionName) ?? []),
		...(browserProfileConfigRecovery?.actions ?? []),
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
