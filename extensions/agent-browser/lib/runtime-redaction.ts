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

const SENSITIVE_VALUE_FLAGS = new Set(["--body", "--headers", "--password", "--proxy"]);

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
			return ["local", "session"].includes(subcommand) && args[start + 2] === "set"
				? [start + 4]
				: [];
		case "clipboard":
			return subcommand === "write"
				? args.slice(start + 2).map((_, index) => start + 2 + index)
				: [];
		default:
			return [];
	}
}

function redactBatchRows(args: readonly string[]): ReadonlyMap<number, string> {
	const batch = projectUpstreamGlobalFlags(args);
	const replacements = new Map<number, string>();
	if (batch.tokens[0] !== "batch") {
		return replacements;
	}
	for (let index = 1; index < batch.tokens.length; index++) {
		if (isNativeBatchOption(batch.tokens[index])) {
			continue;
		}
		const step = parseBatchCommandArgument(batch.tokens[index]).step;
		if (!step) {
			continue;
		}
		const safe = redactInvocationArgs(step);
		if (safe.some((token, offset) => token !== step[offset])) {
			replacements.set(
				batch.indices[index],
				safe.map((token) => `'${token.replaceAll("'", "'\\''")}'`).join(" "),
			);
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
