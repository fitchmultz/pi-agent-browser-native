import { redactSensitiveText, redactSensitiveValue } from "../../runtime.js";
import { stringifyUnknown, truncateText } from "../text.js";

const UNTITLED_PAGE_SUMMARY = "(untitled page)";

export function stringifyModelFacing(value: unknown): string {
	return stringifyUnknown(redactSensitiveValue(value));
}

export function parseJsonPreviewString(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

export function redactModelFacingText(text: string): string {
	const parsed = parseJsonPreviewString(text);
	if (parsed !== text) {
		return stringifyModelFacing(parsed);
	}
	return redactSensitiveText(text);
}

export function redactModelFacingTextIfSensitive(text: string): string {
	return /(?:@|\b(?:access[_-]?key|api[_-]?key|auth|authorization|basic|bearer|connection[_-]?string|cookie|database[_-]?url|db[_-]?url|mongo(?:db)?[_-]?uri|pass(?:word)?|private[_-]?key|redis[_-]?url|secret|session[_-]?id|token)\b)/i.test(text)
		? redactModelFacingText(text)
		: text;
}

export function getArrayField(data: Record<string, unknown>, key: string): unknown[] | undefined {
	return Array.isArray(data[key]) ? data[key] : undefined;
}

export function getStringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// `lifecycle` is upstream launch/reuse bookkeeping, never page content, so it must not be the
// answer an agent reads when a command has no dedicated presenter.
export function omitUpstreamLifecycle(data: Record<string, unknown>): Record<string, unknown> {
	const { lifecycle: _lifecycle, ...rest } = data;
	return rest;
}

export function getPageSummary(data: Record<string, unknown>): string | undefined {
	const title = typeof data.title === "string" ? data.title : undefined;
	const url = typeof data.url === "string" ? data.url : undefined;
	if (title === undefined && url === undefined) return undefined;
	if (title && url) return `${title}\n${url}`;
	if (url) return url;
	return title || UNTITLED_PAGE_SUMMARY;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function firstLine(value: string, maxChars = 160): string {
	return truncateText(value.split("\n", 1)[0] ?? value, maxChars);
}
