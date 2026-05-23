/**
 * Purpose: Share small presentation formatting and redaction helpers across result presentation modules.
 * Responsibilities: Normalize scalar fields, stringify model-facing values, and apply sensitive-text redaction.
 * Scope: Leaf helpers only; command-family formatting lives in sibling modules.
 */

import { redactSensitiveText, redactSensitiveValue } from "../../runtime.js";
import { stringifyUnknown, truncateText } from "../text.js";

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
	return /(?:@|\b(?:api[_-]?key|auth|authorization|basic|bearer|cookie|pass(?:word)?|secret|session[_-]?id|token)\b)/i.test(text)
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

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function firstLine(value: string, maxChars = 160): string {
	return truncateText(value.split("\n", 1)[0] ?? value, maxChars);
}
