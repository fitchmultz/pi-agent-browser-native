/**
 * Purpose: Shared argv flag-shape metadata and helpers for command discovery and sessionless policy checks.
 * Responsibilities: Own global/command value-flag sets and boolean/value-flag validation used during argv parsing.
 * Scope: Pure token grammar; command semantics and subprocess execution live elsewhere.
 */

import { isKnownCommandToken } from "./command-taxonomy.js";

export const GLOBAL_VALUE_FLAGS = [
	"--session",
	"--namespace",
	"--cdp",
	"--config",
	"--profile",
	"--session-name",
	"--restore-save",
	"--restore-check-url",
	"--restore-check-text",
	"--restore-check-fn",
	"--proxy",
	"--proxy-bypass",
	"--headers",
	"--executable-path",
	"--extension",
	"--init-script",
	"--enable",
	"--provider",
	"-p",
	"--engine",
	"--state",
	"--download-path",
	"--screenshot-dir",
	"--screenshot-format",
	"--screenshot-quality",
	"--color-scheme",
	"--device",
	"--args",
	"--user-agent",
	"--allowed-domains",
	"--action-policy",
	"--confirm-actions",
	"--max-output",
	"--model",
	"--idle-timeout",
] as const;

export const COMMAND_VALUE_FLAGS = [
	"--baseline",
	"--body",
	"--categories",
	"--curl",
	"--depth",
	"-d",
	"--domain",
	"--expires",
	"--filter",
	"--fn",
	"--label",
	"--load",
	"--method",
	"--name",
	"--older-than",
	"--output",
	"--prefix",
	"--path",
	"--port",
	"--resource-type",
	"--resource-types",
	"--sameSite",
	"--scope",
	"--selector",
	"-s",
	"--status",
	"--text",
	"--threshold",
	"--timeout",
	"--type",
	"--url",
	"--username",
	"--password",
	"--wait-until",
] as const;

export const OPTIONAL_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(["--restore"]);
export const VALUE_FLAGS: ReadonlySet<string> = new Set([...GLOBAL_VALUE_FLAGS, ...COMMAND_VALUE_FLAGS]);
export const PREVALIDATED_VALUE_FLAGS: ReadonlySet<string> = new Set(GLOBAL_VALUE_FLAGS);
export const GLOBAL_VALUE_FLAGS_ALLOWING_DASH_VALUE: ReadonlySet<string> = new Set(["--args"]);
export const GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES: ReadonlySet<string> = new Set([
	"--allow-file-access",
	"--annotate",
	"--auto-connect",
	"--confirm-interactive",
	"--content-boundaries",
	"--debug",
	"--headed",
	"--ignore-https-errors",
	"--json",
	"--no-auto-dialog",
	"--quiet",
	"-q",
	"--verbose",
	"-v",
]);

export function getFlagName(token: string): string {
	return token.split("=", 1)[0] ?? token;
}

export function isNonFlagToken(token: string | undefined): token is string {
	return typeof token === "string" && !token.startsWith("-");
}

export function hasOnlyBooleanFlags(tokens: readonly string[], allowedFlags: ReadonlySet<string>): boolean {
	return tokens.every((token) => token.startsWith("-") && allowedFlags.has(getFlagName(token)));
}

export function hasOnlyOptionFlags(
	tokens: readonly string[],
	allowedBooleanFlags: ReadonlySet<string>,
	allowedValueFlags: ReadonlySet<string>,
): boolean {
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token.startsWith("-")) return false;
		const flagName = getFlagName(token);
		if (allowedBooleanFlags.has(flagName)) continue;
		if (!allowedValueFlags.has(flagName)) return false;
		if (token.includes("=")) continue;
		const value = tokens[index + 1];
		if (!isNonFlagToken(value)) return false;
		index += 1;
	}
	return true;
}

export function optionalGlobalValueFlagConsumesNext(flag: string, nextToken: string | undefined): boolean {
	if (!OPTIONAL_GLOBAL_VALUE_FLAGS.has(flag) || nextToken === undefined || nextToken.startsWith("-")) return false;
	return !isKnownCommandToken(nextToken);
}

export function stripSessionlessShapeGlobalFlags(commandTokens: readonly string[]): string[] {
	const stripped: string[] = [];
	for (let index = 0; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		const flagName = getFlagName(token);
		if (token === "--json") continue;
		if ((flagName === "--session" || flagName === "--namespace") && !token.includes("=")) {
			index += 1;
			continue;
		}
		if (token.startsWith("--session=") || token.startsWith("--namespace=")) continue;
		stripped.push(token);
	}
	return stripped;
}
