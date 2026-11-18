import { sanitizeRenderedSingleLine } from "../../display-sanitize.js";
import { isRecord } from "../../parsing.js";
import { redactSensitiveText, redactSensitiveValue } from "../../runtime-redaction.js";
import { stringifyUnknown, truncateText } from "../text.js";

const UNTITLED_PAGE_SUMMARY = "(untitled page)";
export const LIGHTPANDA_IMAGE_REASON =
	"Lightpanda screenshot is a text-rendered page representation, not a graphical capture; CSS/mouse coordinate mapping is unknown.";

export function stringifyModelFacing(value: unknown): string {
	return stringifyUnknown(redactSensitiveValue(value));
}

export function redactModelFacingText(text: string): string {
	return redactSensitiveText(text);
}

export function getArrayField(
	data: Readonly<Record<string, unknown>>,
	key: string,
): unknown[] | undefined {
	return Array.isArray(data[key]) ? data[key] : undefined;
}

export function getStringField(
	data: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function formatWebMcpCatalogUpdate(catalog: Readonly<Record<string, unknown>>): string {
	return `WebMCP catalog update (page-provided, untrusted; use webmcp list for schemas):\n${JSON.stringify(redactSensitiveValue(catalog))}`;
}

function getPageIdentitySummary(data: Readonly<Record<string, unknown>>): string | undefined {
	const rawTitle = typeof data.title === "string" ? data.title : undefined;
	const rawUrl = typeof data.url === "string" ? data.url : undefined;
	if (rawTitle === undefined && rawUrl === undefined) {
		return undefined;
	}
	const parts = [rawTitle, rawUrl]
		.map((part) => (part === undefined ? "" : sanitizeRenderedSingleLine(part).trim()))
		.filter((part) => part.length > 0);
	return parts.length > 0 ? parts.join("\n") : UNTITLED_PAGE_SUMMARY;
}

export function getPageSummary(data: Readonly<Record<string, unknown>>): string | undefined {
	const summary = getPageIdentitySummary(data);
	if (summary === undefined) {
		return undefined;
	}
	const webmcp = isRecord(data.webmcp) ? data.webmcp : undefined;
	return webmcp?.available === true &&
		typeof webmcp.toolCount === "number" &&
		Number.isInteger(webmcp.toolCount) &&
		webmcp.toolCount > 0
		? `${summary}\n\nWebMCP tools are available on this page (experimental). Run webmcp list to view them.`
		: summary;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function firstLine(value: string, maxChars = 160): string {
	return truncateText(value.split("\n", 1)[0] ?? value, maxChars);
}
