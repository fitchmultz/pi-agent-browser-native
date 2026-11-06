import { extractUpstreamCommandTokens, findCommandStartIndex } from "./argv-descriptor.js";
import { projectUpstreamGlobalFlags } from "./argv-grammar.js";
import { isNativeBatchOption, parseBatchCommandArgument } from "./orchestration/batch-stdin.js";
import { isRecord } from "./parsing.js";
import {
	isSensitiveFieldName,
	redactBearerCredentials,
	redactEnvSecretAssignments,
	redactStandaloneBasicCredential,
} from "./redaction-fields.js";
import { redactEmbeddedStructuredText, redactSerializedJson } from "./redaction-json.js";
import { redactLooseUrls, redactUrlToken } from "./redaction-url.js";

const SENSITIVE_VALUE_FLAGS = new Set([
	"--body",
	"--cdp-headers",
	"--headers",
	"--password",
	"--proxy",
]);

export function redactSensitiveText(text: string): string {
	// Redact JSON string literals before text heuristics consume their escapes.
	// Non-JSON stays whole so assignments and headers retain their credential context.
	const serialized = redactSerializedJson(text, redactSensitiveText);
	if (serialized !== undefined) {
		return serialized;
	}
	const embedded = redactEmbeddedStructuredText(text, redactSensitiveText);
	const credentials = redactStandaloneBasicCredential(
		redactBearerCredentials(redactLooseUrls(embedded)),
	)
		.replace(/\b(Authorization\s*:\s*Basic)\s+[^\s",]+/gi, "$1 [REDACTED]")
		.replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\n\r"]+/gi, "$1: [REDACTED]");
	return redactEmbeddedStructuredText(redactEnvSecretAssignments(credentials), redactSensitiveText);
}

export function redactSensitiveValue(value: unknown): unknown {
	if (typeof value === "string") {
		return redactSensitiveText(value);
	}
	if (Array.isArray(value)) {
		return value.map((item: unknown) => redactSensitiveValue(item));
	}
	if (!isRecord(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => [
			key,
			isSensitiveFieldName(key) ? "[REDACTED]" : redactSensitiveValue(entryValue),
		]),
	);
}

function redactFlagTokens(args: readonly string[]): string[] {
	const redacted: string[] = [];
	let pendingValueFlag: string | undefined;
	for (const token of args) {
		if (pendingValueFlag !== undefined) {
			redacted.push(
				SENSITIVE_VALUE_FLAGS.has(pendingValueFlag) ? "[REDACTED]" : redactUrlToken(token),
			);
			pendingValueFlag = undefined;
			continue;
		}
		const normalizedToken = token.split("=", 1)[0] ?? token;
		if (SENSITIVE_VALUE_FLAGS.has(normalizedToken)) {
			if (token.includes("=")) {
				redacted.push(`${normalizedToken}=[REDACTED]`);
			} else {
				redacted.push(token);
				pendingValueFlag = normalizedToken;
			}
			continue;
		}
		redacted.push(redactSensitiveText(redactUrlToken(token)));
	}
	return redacted;
}

function sensitiveOperandIndices(args: readonly string[], start: number): number[] {
	const command = args[start];
	const subcommand = args[start + 1];
	switch (command) {
		case "set":
			return subcommand === "credentials" ? [start + 2, start + 3] : [];
		case "cookies":
			return subcommand === "set" && !extractUpstreamCommandTokens(args).slice(2).includes("--curl")
				? [start + 3]
				: [];
		case "storage":
			return (subcommand === "local" || subcommand === "session") && args[start + 2] === "set"
				? [start + 4]
				: [];
		case "clipboard":
			return subcommand === "write"
				? args.slice(start + 2).map((_, index) => start + 2 + index)
				: [];
		case undefined:
		default:
			return [];
	}
}

function redactBatchRows(args: readonly string[]): ReadonlyMap<number, string> {
	const [command, ...operands] = projectUpstreamGlobalFlags(args);
	const replacements = new Map<number, string>();
	if (command?.token !== "batch") {
		return replacements;
	}
	for (const { index, token } of operands) {
		if (isNativeBatchOption(token)) {
			continue;
		}
		const step = parseBatchCommandArgument(token).step;
		if (!step) {
			continue;
		}
		const safe = redactInvocationArgs(step);
		if (safe.some((word, offset) => word !== step[offset])) {
			replacements.set(index, safe.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" "));
		}
	}
	return replacements;
}

export function redactInvocationArgs(args: readonly string[]): string[] {
	const redacted = redactFlagTokens(args);
	const start = findCommandStartIndex(args);
	if (start !== undefined) {
		for (const index of sensitiveOperandIndices(args, start)) {
			if (index < redacted.length) {
				redacted[index] = "[REDACTED]";
			}
		}
	}
	for (const [index, replacement] of redactBatchRows(args)) {
		redacted[index] = replacement;
	}
	return redacted;
}
