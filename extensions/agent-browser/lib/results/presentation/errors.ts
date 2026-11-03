import { isOpenNavigationCommand } from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import { extractUpstreamCommandTokens, type CommandInfo } from "../../argv-descriptor.js";
import { redactSensitiveText } from "../../runtime-redaction.js";
import { buildBrowserProfileConfigRecovery } from "./browser-profile-recovery.js";
import { redactModelFacingText } from "./common.js";
import { buildAgentBrowserNextActions } from "../action-recommendations.js";
import {
	buildAgentBrowserResultCategoryDetails,
	reportsUnsupportedSelectorDialect,
} from "../categories.js";
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

const KEYBOARD_PRESS_ERROR_HINT = [
	"Agent-browser keyboard hint: upstream keyboard commands are `keyboard type <text>` and `keyboard inserttext <text>`; `keyboard press` is not a supported subcommand in the targeted upstream version.",
	'For Enter in text fields, use `keyboard type "\\n"` after focusing the intended control, then verify with a fresh snapshot, URL, or page-state check.',
].join(" ");

function getSelectorRecoveryHint(
	errorText: string,
	command: string | undefined,
): string | undefined {
	const normalized = errorText.trim();
	if (normalized.length === 0) {
		return undefined;
	}

	if (
		/\bUnknown ref\b|\bstale ref\b|\bref\b.*\b(?:not found|missing|expired)\b/i.test(normalized)
	) {
		return STALE_REF_ERROR_HINT;
	}

	return reportsUnsupportedSelectorDialect({ command, errorText: normalized })
		? SELECTOR_DIALECT_ERROR_HINT
		: undefined;
}

function getClipboardPermissionHint(
	commandInfo: CommandInfo,
	errorText: string,
): string | undefined {
	if (commandInfo.command !== "clipboard") {
		return undefined;
	}
	if (
		!/\bNotAllowedError\b|\bclipboard\b.*\bpermission denied\b|\bpermission denied\b.*\bclipboard\b/i.test(
			errorText,
		)
	) {
		return undefined;
	}
	return CLIPBOARD_PERMISSION_ERROR_HINT;
}

function getKeyboardPressHint(commandInfo: CommandInfo, errorText: string): string | undefined {
	if (commandInfo.command !== "keyboard" || commandInfo.subcommand !== "press") {
		return undefined;
	}
	if (!/\bunknown\s+subcommand\b|\bvalid options?\b/i.test(errorText)) {
		return undefined;
	}
	return KEYBOARD_PRESS_ERROR_HINT;
}

export function isOverlayBlockedClickError(
	command: string | undefined,
	errorText: string | undefined,
	args?: readonly string[],
): boolean {
	const tokens = args ? extractUpstreamCommandTokens(args) : [];
	const action =
		tokens[0] === "find"
			? (tokens[tokens[1] === "nth" ? 4 : 3] ?? "click")
			: (tokens[0] ?? command);
	return (
		action === "click" &&
		errorText !== undefined &&
		/\bis covered by\b[\s\S]*\bat its click point\b/i.test(errorText)
	);
}

export function redactClipboardPermissionEcho(commandInfo: CommandInfo, errorText: string): string {
	if (commandInfo.command !== "clipboard") {
		return errorText;
	}
	return errorText
		.replace(/(\b(?:read|write)\s+permission denied\b(?:\s+for)?\s+)([\s\S]+)$/gi, "$1[REDACTED]")
		.replace(
			/(\bFailed to execute '[^']+' on 'Clipboard':\s*)([\s\S]+)$/gi,
			(match, prefix: string, suffix: string) => {
				if (!/\bpermission denied\b/i.test(suffix)) {
					return match;
				}
				return `${prefix}${suffix.replace(/(\bpermission denied\b(?:\s+for)?\s+)([\s\S]+)$/i, "$1[REDACTED]")}`;
			},
		);
}

export function getClipboardWritePayloadCandidates(commandTokens: readonly string[]): string[] {
	if (commandTokens[0] !== "clipboard" || commandTokens[1] !== "write") {
		return [];
	}
	const payloadTokens = commandTokens.slice(2).filter((value) => value.length > 0);
	return [
		...new Set([...payloadTokens, payloadTokens.join(" ")].filter((value) => value.length > 0)),
	];
}

function shouldRedactClipboardPayloadField(
	key: string,
	value: string,
	payloadCandidates: readonly string[],
): boolean {
	return payloadCandidates.some((candidate) => {
		if (value === candidate) {
			return true;
		}
		if (candidate.length < 8 || !/payload|clipboard|argument/i.test(key)) {
			return false;
		}
		return value.includes(candidate);
	});
}

export function redactClipboardPermissionErrorValue(
	commandInfo: CommandInfo,
	value: unknown,
	payloadCandidates: readonly string[] = [],
): unknown {
	if (commandInfo.command !== "clipboard") {
		return value;
	}
	if (typeof value === "string") {
		return payloadCandidates.includes(value)
			? "[REDACTED]"
			: redactClipboardPermissionEcho(commandInfo, value);
	}
	if (Array.isArray(value)) {
		return value.map((item) =>
			redactClipboardPermissionErrorValue(commandInfo, item, payloadCandidates),
		);
	}
	if (!isRecord(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => [
			key,
			typeof entryValue === "string" &&
			shouldRedactClipboardPayloadField(key, entryValue, payloadCandidates)
				? "[REDACTED]"
				: redactClipboardPermissionErrorValue(commandInfo, entryValue, payloadCandidates),
		]),
	);
}

interface CommandSuggestion {
	readonly args?: readonly string[];
	readonly description: string;
	readonly id?: string;
}

const UNKNOWN_COMMAND_SUGGESTIONS: Readonly<Partial<Record<string, readonly CommandSuggestion[]>>> =
	{
		attr: [
			{
				description:
					"Use `get attr <selector> <name>` to read an attribute from a selector or current `@ref`.",
			},
		],
		count: [{ description: "Use `get count <selector>` to count matching elements." }],
		html: [
			{
				description:
					"Use `get html <selector>` to read element HTML from a selector or current `@ref`; use `get html body` when you need whole-page body HTML.",
			},
		],
		text: [
			{
				description:
					"Use `get text <selector>` to read text from a selector or current `@ref`; run `snapshot -i` first when you need a safe `@ref`.",
			},
		],
		title: [
			{
				args: ["get", "title"],
				description: "Use `get title` to read the current page title.",
				id: "use-get-title",
			},
		],
		url: [
			{
				args: ["get", "url"],
				description: "Use `get url` to read the current page URL.",
				id: "use-get-url",
			},
		],
		value: [
			{
				description:
					"Use `get value <selector>` to read form control value from a selector or current `@ref`.",
			},
		],
	};

function getUnknownCommandSuggestions(
	command: string | undefined,
	errorText: string,
): readonly CommandSuggestion[] {
	if (command === undefined || command.length === 0) {
		return [];
	}
	const normalizedCommand = command.trim().toLowerCase();
	if (
		!/\bunknown\s+command\b|\bunknown\s+subcommand\b|\bunrecognized\s+command\b/i.test(errorText)
	) {
		return [];
	}
	return UNKNOWN_COMMAND_SUGGESTIONS[normalizedCommand] ?? [];
}

function formatUnknownCommandSuggestionText(
	suggestions: readonly CommandSuggestion[],
): string | undefined {
	if (suggestions.length === 0) {
		return undefined;
	}
	return [
		"Agent-browser hint: This looks like a getter shortcut, but upstream getter commands are grouped under `get`.",
		...suggestions.map((suggestion) => suggestion.description),
	].join(" ");
}

function buildUnknownCommandSuggestionActions(
	suggestions: readonly CommandSuggestion[],
	sessionName: string | undefined,
): AgentBrowserNextAction[] | undefined {
	const actions = suggestions
		.filter(
			(
				suggestion,
			): suggestion is CommandSuggestion & {
				readonly args: readonly string[];
				readonly id: string;
			} => suggestion.args !== undefined && suggestion.id !== undefined,
		)
		.map((suggestion) => ({
			id: suggestion.id,
			params: { args: withOptionalSessionArgs(sessionName, suggestion.args) },
			reason: suggestion.description,
			safety: "Read-only getter command; safe to retry when you intended to inspect page state.",
			tool: "agent_browser" as const,
		}));
	return actions.length > 0 ? actions : undefined;
}

function getLocalhostNavigationHint(
	commandInfo: CommandInfo,
	errorText: string,
): string | undefined {
	if (
		!isOpenNavigationCommand(commandInfo.command) ||
		commandInfo.subcommand === undefined ||
		commandInfo.subcommand.length === 0
	) {
		return undefined;
	}
	if (
		!/\bnet::ERR_(?:EMPTY_RESPONSE|CONNECTION_REFUSED|ADDRESS_UNREACHABLE|TIMED_OUT|CONNECTION_RESET)\b/i.test(
			errorText,
		)
	) {
		return undefined;
	}

	let targetUrl: URL;
	try {
		targetUrl = new URL(commandInfo.subcommand);
	} catch {
		return undefined;
	}

	if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(targetUrl.hostname.toLowerCase())) {
		return undefined;
	}

	return [
		"Agent-browser local fixture hint: the browser process could not read a loopback URL from its own network namespace or browser host.",
		"Verify the server is still running and bound to an address the browser host can reach; if curl works from the shell but browser navigation fails, try the other loopback alias, add a proxy bypass for localhost/127.0.0.1 if a proxy is configured, or use a browser-host-reachable URL.",
		"Use file:// only for static fallback fixtures and clean up any temporary server process outside agent_browser when the check is done.",
	].join(" ");
}

export function appendSelectorRecoveryHint(errorText: string, command: string | undefined): string {
	const hint = getSelectorRecoveryHint(errorText, command);
	if (hint === undefined || hint.length === 0 || errorText.includes("Agent-browser hint:")) {
		return errorText;
	}
	return `${errorText}\n\n${hint}`;
}

function buildHintedErrorText(
	commandInfo: CommandInfo,
	errorText: string,
	unknownSuggestion: string | undefined,
	profileHint: string | undefined,
): string {
	const selectorHinted = appendSelectorRecoveryHint(errorText, commandInfo.command);
	return [
		selectorHinted,
		unknownSuggestion !== undefined &&
		unknownSuggestion.length > 0 &&
		!selectorHinted.includes("Agent-browser hint:")
			? unknownSuggestion
			: undefined,
		profileHint,
		getLocalhostNavigationHint(commandInfo, errorText),
		getClipboardPermissionHint(commandInfo, errorText),
		getKeyboardPressHint(commandInfo, errorText),
	]
		.filter((part) => part !== undefined && part.length > 0)
		.join("\n\n");
}

export function buildErrorPresentation(options: {
	readonly args?: readonly string[];
	readonly commandInfo: CommandInfo;
	readonly errorText: string;
	readonly presentationCommand?: string;
	readonly sessionName?: string;
}): ToolPresentation {
	const { args, commandInfo, errorText, presentationCommand, sessionName } = options;
	const safeErrorText = redactModelFacingText(
		redactSensitiveText(redactClipboardPermissionEcho(commandInfo, errorText)),
	);
	const unknownCommandSuggestions = getUnknownCommandSuggestions(
		commandInfo.command,
		safeErrorText,
	);
	const unknownCommandSuggestionText =
		formatUnknownCommandSuggestionText(unknownCommandSuggestions);
	const browserProfileConfigRecovery = buildBrowserProfileConfigRecovery({
		args,
		commandInfo,
		errorText: safeErrorText,
	});
	const hintedErrorText = buildHintedErrorText(
		commandInfo,
		safeErrorText,
		unknownCommandSuggestionText,
		browserProfileConfigRecovery?.hint,
	);
	const categoryDetails = buildAgentBrowserResultCategoryDetails({
		args: [commandInfo.command, commandInfo.subcommand].filter(
			(item): item is string => item !== undefined,
		),
		command: commandInfo.command,
		errorText: hintedErrorText,
		succeeded: false,
	});
	const nextActions = [
		...(buildUnknownCommandSuggestionActions(unknownCommandSuggestions, sessionName) ?? []),
		...(browserProfileConfigRecovery?.actions ?? []),
		...(browserProfileConfigRecovery
			? []
			: (buildAgentBrowserNextActions({
					args,
					command: commandInfo.command,
					failureCategory: categoryDetails.failureCategory,
					overlayBlockedClick: isOverlayBlockedClickError(
						presentationCommand ?? commandInfo.command,
						safeErrorText,
						args ?? commandInfo.commandTokens,
					),
					resultCategory: "failure",
					sessionName,
					subcommand: commandInfo.subcommand,
				}) ?? [])),
	];
	return {
		...categoryDetails,
		content: [{ type: "text", text: hintedErrorText }],
		nextActions: nextActions.length > 0 ? nextActions : undefined,
		summary: hintedErrorText,
	};
}
