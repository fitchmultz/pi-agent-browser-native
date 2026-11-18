import type { CommandInfo } from "../../argv-descriptor.js";
import { sanitizeRenderedFirstLine, sanitizeRenderedSingleLine } from "../../display-sanitize.js";
import { isRecord } from "../../parsing.js";
import {
	firstLine,
	getArrayField,
	getStringField,
	redactModelFacingText,
	stringifyModelFacing,
} from "./common.js";
import { isClearDiagnosticCommand } from "./diagnostic-summary.js";

type Data = Readonly<Record<string, unknown>>;
const LOG_PREVIEW_LIMIT = 80;

function consoleLine(item: unknown, index: number): string {
	if (!isRecord(item)) {
		return `${index + 1}. ${stringifyModelFacing(item)}`;
	}
	const type = sanitizeRenderedSingleLine(
		redactModelFacingText(getStringField(item, "type") ?? "message"),
	);
	const text = getStringField(item, "text") ?? stringifyModelFacing(item);
	return `${index + 1}. [${type}] ${firstLine(sanitizeRenderedSingleLine(redactModelFacingText(text)).replace(/\s+/g, " ").trim(), 220)}`;
}

export function formatConsoleText(data: Data, command: CommandInfo): string | undefined {
	const messages = getArrayField(data, "messages");
	if (isClearDiagnosticCommand(command) && data.cleared === true && !messages) {
		return "Console buffer cleared.";
	}
	if (!messages) {
		return undefined;
	}
	if (isClearDiagnosticCommand(command)) {
		return messages.length === 0
			? "Console buffer cleared; no prior message rows were returned. This reset output is not evidence of current-page console activity."
			: `Console buffer cleared; upstream returned ${messages.length} cleared/stale message row${messages.length === 1 ? "" : "s"}. Treat these as reset output, not current-page console errors.`;
	}
	if (messages.length === 0) {
		return "No console messages. Scope: upstream session aggregate unless the upstream command output says it was cleared or filtered for this page.";
	}
	const shown = [
		"Scope: upstream session aggregate unless the upstream command output says it was cleared or filtered for this page; do not attribute old messages to the current page without URL/time evidence.",
		...messages.slice(0, LOG_PREVIEW_LIMIT).map(consoleLine),
	];
	const previewedCount = Math.min(messages.length, LOG_PREVIEW_LIMIT);
	if (messages.length > previewedCount) {
		shown.push(
			`... (${messages.length - previewedCount} additional console messages omitted from preview)`,
		);
	}
	return shown.join("\n");
}

function errorLine(item: unknown, index: number): string {
	if (!isRecord(item)) {
		return `${index + 1}. ${stringifyModelFacing(item)}`;
	}
	const text = getStringField(item, "text") ?? stringifyModelFacing(item);
	const location = [
		getStringField(item, "url"),
		typeof item.line === "number" ? `line ${item.line}` : undefined,
		typeof item.column === "number" ? `column ${item.column}` : undefined,
	]
		.filter((part) => part !== undefined && part.length > 0)
		.map((part) => sanitizeRenderedSingleLine(redactModelFacingText(part ?? "")))
		.join(":");
	const safeText = firstLine(sanitizeRenderedFirstLine(redactModelFacingText(text)), 220);
	return location.length > 0
		? `${index + 1}. ${safeText} (${location})`
		: `${index + 1}. ${safeText}`;
}

export function formatErrorsText(data: Data, command: CommandInfo): string | undefined {
	const errors = getArrayField(data, "errors");
	if (!errors) {
		return undefined;
	}
	if (isClearDiagnosticCommand(command)) {
		return errors.length === 0
			? "Page error buffer cleared; no prior error rows were returned. This reset output is not evidence of current-page errors."
			: `Page error buffer cleared; upstream returned ${errors.length} cleared/stale error row${errors.length === 1 ? "" : "s"}. Treat these as reset output, not current-page errors.`;
	}
	if (errors.length === 0) {
		return "No page errors.";
	}
	const shown = errors.slice(0, LOG_PREVIEW_LIMIT).map(errorLine);
	if (errors.length > shown.length) {
		shown.push(`... (${errors.length - shown.length} additional errors omitted from preview)`);
	}
	return shown.join("\n");
}
