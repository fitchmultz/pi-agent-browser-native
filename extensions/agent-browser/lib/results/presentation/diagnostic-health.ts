import { sanitizeRenderedFirstLine, sanitizeRenderedSingleLine } from "../../display-sanitize.js";
import { isRecord } from "../../parsing.js";
import {
	firstLine,
	getArrayField,
	getStringField,
	redactModelFacingText,
	stringifyModelFacing,
} from "./common.js";

type Data = Readonly<Record<string, unknown>>;

export function formatDashboardText(data: Data): string | undefined {
	const lines: string[] = [];
	if (typeof data.port === "number") {
		lines.push(`Port: ${data.port}`);
	}
	if (typeof data.pid === "number") {
		lines.push(`PID: ${data.pid}`);
	}
	if (typeof data.stopped === "boolean") {
		lines.push(`Stopped: ${data.stopped}`);
	}
	const reason = getStringField(data, "reason");
	if (reason !== undefined) {
		lines.push(`Reason: ${sanitizeRenderedSingleLine(redactModelFacingText(reason))}`);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function doctorCheckLines(item: unknown, index: number): string[] {
	if (!isRecord(item)) {
		return [`${index + 1}. ${stringifyModelFacing(item)}`];
	}
	const status = getStringField(item, "status") ?? "info";
	const label = [getStringField(item, "category"), getStringField(item, "id")]
		.filter(Boolean)
		.join("/");
	const message =
		getStringField(item, "message") ??
		getStringField(item, "name") ??
		getStringField(item, "title") ??
		getStringField(item, "check") ??
		stringifyModelFacing(item);
	const lines = [
		`${index + 1}. [${sanitizeRenderedSingleLine(redactModelFacingText(status))}]${label.length > 0 ? ` ${sanitizeRenderedSingleLine(redactModelFacingText(label))}:` : ""} ${firstLine(sanitizeRenderedFirstLine(redactModelFacingText(message)), 220)}`,
	];
	const fix = getStringField(item, "fix");
	if (fix !== undefined) {
		lines.push(`   fix: ${sanitizeRenderedSingleLine(redactModelFacingText(fix))}`);
	}
	return lines;
}

function doctorSummary(data: Data): string[] {
	const lines: string[] = [];
	const status = getStringField(data, "status") ?? getStringField(data, "result");
	if (status !== undefined) {
		lines.push(`Status: ${sanitizeRenderedSingleLine(redactModelFacingText(status))}`);
	}
	if (isRecord(data.summary)) {
		const summary = data.summary;
		const parts = ["pass", "warn", "fail"].flatMap((key) =>
			typeof summary[key] === "number" ? [`${key}:${summary[key]}`] : [],
		);
		if (parts.length > 0) {
			lines.push(`Summary: ${parts.join(", ")}`);
		}
	}
	return lines;
}

export function formatDoctorText(data: Data): string | undefined {
	const lines = doctorSummary(data);
	const checks = getArrayField(data, "checks");
	if (checks) {
		lines.push(`Checks: ${checks.length}`, ...checks.slice(0, 30).flatMap(doctorCheckLines));
		if (checks.length > 30) {
			lines.push(`... (${checks.length - 30} additional checks omitted from preview)`);
		}
	}
	for (const key of ["issues", "problems"]) {
		const items = getArrayField(data, key);
		if (items) {
			lines.push(`${key}: ${items.length}`);
		}
	}
	if (lines.length > 0) {
		return lines.join("\n");
	}
	const keys = Object.keys(data).filter((key) => key !== "success");
	return keys.length > 0
		? `Doctor diagnostics returned unrecognized fields: ${keys.map(redactModelFacingText).join(", ")}. See details.data for structured diagnostics.`
		: undefined;
}
