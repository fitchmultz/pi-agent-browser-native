import { sanitizeRenderedSingleLine } from "../../display-sanitize.js";
import { isRecord } from "../../parsing.js";
import {
	firstLine,
	getArrayField,
	getStringField,
	redactModelFacingText,
	stringifyModelFacing,
} from "./common.js";

type Data = Readonly<Record<string, unknown>>;

function violationLine(item: unknown, index: number): string {
	if (!isRecord(item)) {
		return `${index + 1}. ${stringifyModelFacing(item)}`;
	}
	const id = sanitizeRenderedSingleLine(
		redactModelFacingText(getStringField(item, "id") ?? "rule"),
	);
	const impact = sanitizeRenderedSingleLine(
		redactModelFacingText(getStringField(item, "impact") ?? "unknown"),
	);
	const help = firstLine(
		sanitizeRenderedSingleLine(redactModelFacingText(getStringField(item, "help") ?? ""))
			.replace(/\s+/g, " ")
			.trim(),
		160,
	);
	const nodeCount =
		typeof item.nodeCount === "number" ? item.nodeCount : getArrayField(item, "nodes")?.length;
	const nodePart =
		typeof nodeCount === "number" ? `, ${nodeCount} node${nodeCount === 1 ? "" : "s"}` : "";
	return `${index + 1}. [${impact}] ${id}${nodePart}${help.length > 0 ? ` — ${help}` : ""}`;
}

function countSummary(
	counts: Data | undefined,
	violationCount: number,
	incompleteCount: number,
): string {
	const parts = [
		`${violationCount} violation${violationCount === 1 ? "" : "s"}`,
		`${incompleteCount} incomplete`,
	];
	if (typeof counts?.passes === "number") {
		parts.push(`${counts.passes} passes`);
	}
	if (typeof counts?.inapplicable === "number") {
		parts.push(`${counts.inapplicable} inapplicable`);
	}
	return `A11y audit: ${parts.join(", ")}.`;
}

function auditHeader(data: Data): string[] {
	const lines: string[] = [];
	const axeVersion = getStringField(data, "axeVersion");
	if (axeVersion !== undefined) {
		lines.push(`axe-core ${sanitizeRenderedSingleLine(redactModelFacingText(axeVersion))}`);
	}
	const url = getStringField(data, "url");
	if (url !== undefined) {
		lines.push(`URL: ${sanitizeRenderedSingleLine(redactModelFacingText(url))}`);
	}
	return lines;
}

function auditCounts(
	counts: Data | undefined,
	violations: readonly unknown[],
	incomplete: readonly unknown[],
): { readonly violations: number; readonly incomplete: number } {
	return {
		violations: typeof counts?.violations === "number" ? counts.violations : violations.length,
		incomplete: typeof counts?.incomplete === "number" ? counts.incomplete : incomplete.length,
	};
}

export function formatA11yText(data: Data): string | undefined {
	const counts = isRecord(data.counts) ? data.counts : undefined;
	const violations = getArrayField(data, "violations") ?? [];
	const incomplete = getArrayField(data, "incomplete") ?? [];
	if (!counts && violations.length === 0 && incomplete.length === 0) {
		return undefined;
	}
	const lines = auditHeader(data);
	const observedCounts = auditCounts(counts, violations, incomplete);
	const incompleteCount = observedCounts.incomplete;
	lines.push(countSummary(counts, observedCounts.violations, incompleteCount));
	const preview = violations.slice(0, 10).map(violationLine);
	lines.push(...preview);
	if (violations.length > preview.length) {
		lines.push(
			`... (${violations.length - preview.length} additional violations omitted from preview)`,
		);
	}
	if (incompleteCount > 0) {
		lines.push(
			`${incompleteCount} incomplete check${incompleteCount === 1 ? "" : "s"} need manual review (see details.data.incomplete).`,
		);
	}
	return lines.join("\n");
}
