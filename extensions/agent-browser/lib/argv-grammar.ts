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
	"--content",
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
	"--tags",
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
	"--hide-scrollbars",
	"--ignore-https-errors",
	"--json",
	"--no-auto-dialog",
	"--quiet",
	"-q",
	"--verbose",
	"-v",
	"--webgpu",
]);

export interface UpstreamGlobalFlagOccurrence {
	index: number;
	value?: string;
}

const SESSION_COMPONENT_ALPHANUMERIC = /^[\p{Alphabetic}\p{Number}]$/u;

/** Match upstream's last-wins, case-sensitive boolean semantics; only exact `false` disables a present flag. */
export function isBooleanFlagEnabled(args: string[], flag: string): boolean {
	let enabled = false;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === flag) {
			enabled = args[index + 1] !== "false";
			if (["true", "false"].includes(args[index + 1] ?? "")) index += 1;
			continue;
		}
		if (PREVALIDATED_VALUE_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token) && ["true", "false"].includes(args[index + 1] ?? "")) index += 1;
	}
	return enabled;
}

/** Mirror upstream sanitize_session_component for namespace/socket/state identity. */
export function canonicalizeAgentBrowserNamespace(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	let normalized = "";
	let lastWasSeparator = false;
	for (const character of value) {
		if (SESSION_COMPONENT_ALPHANUMERIC.test(character)) {
			normalized += character.toLowerCase();
			lastWasSeparator = false;
		} else if (character === "-" || character === "_") {
			if (normalized && !lastWasSeparator) {
				normalized += character;
				lastWasSeparator = true;
			}
		} else if (normalized && !lastWasSeparator) {
			normalized += "-";
			lastWasSeparator = true;
		}
	}
	return normalized.replace(/[-_]+$/u, "") || undefined;
}

function foldAgentBrowserFilesystemIdentity(value: string, platform: NodeJS.Platform): string {
	if (platform !== "darwin" && platform !== "win32") return value;
	// APFS aliases include full Unicode folds such as ß/SS and ς/Σ, not just ASCII case.
	return value.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}

export function getAgentBrowserSessionIdentityKey(sessionName: string, namespace?: string, platform: NodeJS.Platform = process.platform): string {
	const canonicalNamespace = canonicalizeAgentBrowserNamespace(namespace);
	const identityNamespace = canonicalNamespace ? foldAgentBrowserFilesystemIdentity(canonicalNamespace, platform) : undefined;
	const canonicalSessionName = foldAgentBrowserFilesystemIdentity(sessionName, platform);
	return identityNamespace ? `${identityNamespace}\0${canonicalSessionName}` : canonicalSessionName;
}

/** Mirror upstream 0.33.2 global parsing: full argv, no `--` sentinel, and only global value payloads are skipped. */
export function scanUpstreamGlobalFlagOccurrences(args: string[], targetFlag: string): UpstreamGlobalFlagOccurrence[] {
	const occurrences: UpstreamGlobalFlagOccurrence[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === targetFlag) {
			occurrences.push({ index, value: args[index + 1] });
			index += 1;
			continue;
		}
		if (PREVALIDATED_VALUE_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token) && ["true", "false"].includes(args[index + 1] ?? "")) index += 1;
	}
	return occurrences;
}

export function extractExplicitSessionName(args: string[]): string | undefined {
	return scanUpstreamGlobalFlagOccurrences(args, "--session").at(-1)?.value;
}

export function extractExplicitNamespace(args: string[]): string | undefined {
	return canonicalizeAgentBrowserNamespace(scanUpstreamGlobalFlagOccurrences(args, "--namespace").at(-1)?.value);
}

export function resolveAgentBrowserNamespace(args: string[], envValue: string | undefined): string | undefined {
	const occurrences = scanUpstreamGlobalFlagOccurrences(args, "--namespace");
	if (occurrences.length > 0) return canonicalizeAgentBrowserNamespace(occurrences.at(-1)?.value) ?? "";
	return canonicalizeAgentBrowserNamespace(envValue);
}

/** Mirror upstream's optional restore value and full-argv last-wins parsing. */
export function extractRequestedRestoreKey(args: string[], sessionName: string, envValue: string | undefined): string | null {
	let restoreKey = envValue || null;
	let seenCommand = false;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token.startsWith("--restore=")) {
			restoreKey = token.slice("--restore=".length) || sessionName;
			continue;
		}
		if (token === "--restore") {
			if (!seenCommand && optionalGlobalValueFlagConsumesNext(token, args[index + 1])) {
				restoreKey = args[index + 1] as string;
				index += 1;
			} else {
				restoreKey = sessionName;
			}
			continue;
		}
		if (PREVALIDATED_VALUE_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token) && ["true", "false"].includes(args[index + 1] ?? "")) {
			index += 1;
			continue;
		}
		if (isKnownCommandToken(token)) seenCommand = true;
	}
	return restoreKey;
}

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
