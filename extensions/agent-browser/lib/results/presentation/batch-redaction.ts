import { extractUpstreamCommandTokens } from "../../argv-descriptor.js";
import { redactSensitiveText, redactSensitiveValue } from "../../runtime-redaction.js";
import { isRecord } from "../../parsing.js";
import {
	getClipboardWritePayloadCandidates,
	redactClipboardPermissionErrorValue,
} from "./errors.js";

export function hasModelFacingArgRedaction(args: readonly string[] | undefined): boolean {
	return (
		args?.some(
			(arg) => arg === "[REDACTED]" || arg.includes("%5BREDACTED%5D") || arg.includes("[REDACTED]"),
		) === true
	);
}

function getPasswordValues(tokens: readonly string[]): string[] {
	const values: string[] = [];
	for (const [index, token] of tokens.entries()) {
		const next = tokens.at(index + 1);
		if (token === "--password" && next !== undefined && next.length > 0) {
			values.push(next);
		} else if (token.startsWith("--password=")) {
			values.push(token.slice("--password=".length));
		}
	}
	return values;
}

function getStatefulValue(tokens: readonly string[]): string | undefined {
	if (tokens[0] === "cookies" && tokens[1] === "set" && !tokens.slice(2).includes("--curl")) {
		return tokens.at(3);
	}
	if (
		tokens[0] === "storage" &&
		["local", "session"].includes(tokens[1] ?? "") &&
		tokens[2] === "set"
	) {
		return tokens.at(4);
	}
	return undefined;
}

function getStatefulCommandSensitiveValues(command: readonly string[] | undefined): string[] {
	if (!command) {
		return [];
	}
	const tokens = extractUpstreamCommandTokens(command);
	const statefulValue = getStatefulValue(tokens);
	const values = getPasswordValues(tokens);
	if (statefulValue !== undefined) {
		values.unshift(statefulValue);
	}
	return values.filter((value) => value.length > 0);
}

function redactExactValues(value: unknown, sensitiveValues: readonly string[]): unknown {
	if (sensitiveValues.length === 0) {
		return redactSensitiveValue(value);
	}
	if (typeof value === "string") {
		let redacted = value;
		for (const sensitive of sensitiveValues) {
			redacted = redacted.split(sensitive).join("[REDACTED]");
		}
		return redactSensitiveText(redacted);
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactExactValues(item, sensitiveValues));
	}
	if (!isRecord(value)) {
		return value;
	}
	return redactSensitiveValue(
		Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, redactExactValues(item, sensitiveValues)]),
		),
	);
}

export function redactBatchStepErrorData(
	command: readonly string[] | undefined,
	value: unknown,
): unknown {
	return command?.[0] === "clipboard"
		? redactSensitiveValue(
				redactClipboardPermissionErrorValue(
					{ command: "clipboard", subcommand: command[1] },
					value,
					getClipboardWritePayloadCandidates(command),
				),
			)
		: redactExactValues(value, getStatefulCommandSensitiveValues(command));
}
