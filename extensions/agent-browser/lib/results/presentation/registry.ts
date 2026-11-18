import type { CompiledAgentBrowserSemanticAction } from "../../input-modes/types.js";
import { isRecord } from "../../parsing.js";
import { getNativeTabContinuationGuidance } from "../../read-confirmation.js";
import type { CommandInfo } from "../../argv-descriptor.js";
import {
	detectConfirmationRequired,
	type ConfirmationRequiredPresentation,
} from "../confirmation.js";
import { getPageSummary, redactModelFacingText, stringifyModelFacing } from "./common.js";
import { omitUpstreamLifecycle } from "./lifecycle.js";
import { formatDiagnosticSummary, formatDiagnosticText } from "./diagnostics.js";
import {
	formatExtractionSummary,
	formatExtractionText,
	formatNavigationActionResult,
	formatNavigationSummary,
	getNavigationSummary,
	isNavigationObservableCommand,
} from "./navigation.js";
import {
	formatSemanticActionPresentationSummary,
	formatSemanticActionPresentationText,
	resolvePresentationCommandInfo,
} from "./semantic-action.js";
import { COMMAND_PRESENTERS } from "./command-presenters.js";

type PresentationMode = "summary" | "text";

function formatConfirmationRequiredText(confirmation: ConfirmationRequiredPresentation): string {
	const lines = ["Confirmation required.", `Pending confirmation id: ${confirmation.id}`];
	if (confirmation.actionText !== undefined && confirmation.actionText.length > 0) {
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

function formatBatchSummary(data: unknown): string | undefined {
	if (!Array.isArray(data)) {
		return undefined;
	}
	const count = data.filter((item) => isRecord(item) && item.success !== false).length;
	return count === data.length
		? `Batch: ${count}/${data.length} succeeded`
		: `Batch failed: ${count}/${data.length} succeeded`;
}

function firstNonemptyResult(
	formatters: readonly (() => string | undefined)[],
): string | undefined {
	for (const format of formatters) {
		const result = format();
		if (result !== undefined && result.length > 0) {
			return result;
		}
	}
	return undefined;
}

function formatObservedNavigation(
	mode: PresentationMode,
	command: CommandInfo,
	data: Readonly<Record<string, unknown>>,
): string | undefined {
	const navigation = getNavigationSummary(data);
	if (!navigation || !isNavigationObservableCommand(command.command, command.subcommand)) {
		return undefined;
	}
	const text = formatNavigationSummary(navigation);
	if (text === undefined || text.length === 0) {
		return undefined;
	}
	if (mode === "summary") {
		return `${command.command ?? "navigation"} → ${text.split("\n", 1).at(0) ?? text}`;
	}
	const action = formatNavigationActionResult(data);
	return action !== undefined && action.length > 0
		? `${action}\n\nCurrent page:\n${text}`
		: `Current page:\n${text}`;
}

function formatPageAction(
	mode: PresentationMode,
	command: CommandInfo,
	data: Readonly<Record<string, unknown>>,
	compiled: CompiledAgentBrowserSemanticAction | undefined,
): string | undefined {
	if (compiled) {
		const format =
			mode === "summary"
				? formatSemanticActionPresentationSummary
				: formatSemanticActionPresentationText;
		const text = format(compiled, data);
		if (text !== undefined && text.length > 0) {
			return text;
		}
	}
	return formatObservedNavigation(mode, resolvePresentationCommandInfo(command, compiled), data);
}

function formatPageContentFallback(
	mode: PresentationMode,
	data: Readonly<Record<string, unknown>>,
): string | undefined {
	const page = getPageSummary(data);
	if (page !== undefined && page.length > 0) {
		return mode === "summary"
			? (page.split("\n", 1).at(0) ?? "agent-browser result")
			: redactModelFacingText(page);
	}
	if (mode === "text") {
		const { navigationSummary: _navigationSummary, ...content } = omitUpstreamLifecycle(data);
		if (Object.keys(content).length > 0) {
			return stringifyModelFacing(content);
		}
	}
	return undefined;
}

function formatPageFallback(
	mode: PresentationMode,
	command: CommandInfo,
	data: Readonly<Record<string, unknown>>,
): string | undefined {
	const diagnostic = mode === "summary" ? formatDiagnosticSummary : formatDiagnosticText;
	const extraction = mode === "summary" ? formatExtractionSummary : formatExtractionText;
	const formatters = mode === "summary" ? [diagnostic, extraction] : [extraction, diagnostic];
	return (
		firstNonemptyResult(formatters.map((format) => () => format(command, data))) ??
		formatPageContentFallback(mode, data)
	);
}

function formatNativeCommand(
	mode: PresentationMode,
	command: CommandInfo,
	data: unknown,
): string | undefined {
	const presenter = command.command !== undefined ? COMMAND_PRESENTERS[command.command] : undefined;
	const format = mode === "summary" ? presenter?.summary : presenter?.text;
	return format?.(command, data);
}

export function formatPresentationSummary(
	command: CommandInfo,
	data: unknown,
	compiled?: CompiledAgentBrowserSemanticAction,
): string {
	const confirmation = detectConfirmationRequired(data);
	if (confirmation) {
		return `Confirmation required: ${confirmation.id}`;
	}
	const text = firstNonemptyResult([
		() => (command.command === "batch" ? formatBatchSummary(data) : undefined),
		() => (isRecord(data) ? formatPageAction("summary", command, data, compiled) : undefined),
		() => formatNativeCommand("summary", command, data),
	]);
	if (text !== undefined) {
		return text;
	}
	if (isRecord(data)) {
		const fallback = formatPageFallback("summary", command, data);
		if (fallback !== undefined) {
			return fallback;
		}
	}
	if (typeof data === "string" && data.length > 0) {
		return data.split("\n", 1).at(0) ?? data;
	}
	return `${resolvePresentationCommandInfo(command, compiled).command ?? command.command ?? "agent-browser"} completed`;
}

function formatPageResultText(
	command: CommandInfo,
	data: Readonly<Record<string, unknown>>,
	compiled?: CompiledAgentBrowserSemanticAction,
): string {
	const action = formatPageAction("text", command, data, compiled);
	const text =
		action !== undefined && action.length > 0 ? action : formatPageFallback("text", command, data);
	return (
		text ??
		`${resolvePresentationCommandInfo(command, compiled).command ?? command.command ?? "agent-browser"} completed`
	);
}

function formatContentValue(data: unknown): string {
	if (typeof data === "string") {
		return redactModelFacingText(data);
	}
	if (typeof data === "number" || typeof data === "boolean") {
		return String(data);
	}
	return stringifyModelFacing(data);
}

export function formatPresentationContentText(
	command: CommandInfo,
	data: unknown,
	compiled?: CompiledAgentBrowserSemanticAction,
): string {
	const confirmation = detectConfirmationRequired(data);
	if (confirmation) {
		return [
			formatConfirmationRequiredText(confirmation),
			getNativeTabContinuationGuidance(command.commandTokens ?? [], data),
		]
			.filter(Boolean)
			.join("\n\n");
	}
	const native = formatNativeCommand("text", command, data);
	if (native !== undefined && native.length > 0) {
		return native;
	}
	return isRecord(data) ? formatPageResultText(command, data, compiled) : formatContentValue(data);
}
