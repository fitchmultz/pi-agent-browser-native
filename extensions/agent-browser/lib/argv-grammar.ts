import { isKnownCommandToken } from "./command-taxonomy.js";
import { canonicalizeAgentBrowserNamespace } from "./session-identity.js";
export {
	canonicalizeAgentBrowserNamespace,
	foldAgentBrowserFilesystemIdentity,
	getAgentBrowserSessionIdentityKey,
	isAgentBrowserSessionIdentityKeyInNamespace,
	deleteIdentityKeysInNamespace,
} from "./session-identity.js";

export const GLOBAL_VALUE_FLAGS = [
	"--session",
	"--namespace",
	"--cdp",
	"--cdp-headers",
	"--config",
	"--profile",
	"--session-name",
	"--restore-save",
	"--restore-check-url",
	"--restore-check-text",
	"--restore-check-fn",
	"--proxy",
	"--proxy-bypass",
	"--ca-cert",
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
	"--input-mode",
] as const;

const COMMAND_VALUE_FLAGS = [
	"--allowed-origins",
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
	"--frame",
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
	"--params",
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

const OPTIONAL_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(["--restore"]);
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
	...GLOBAL_VALUE_FLAGS,
	...COMMAND_VALUE_FLAGS,
]);
export const PREVALIDATED_VALUE_FLAGS: ReadonlySet<string> = new Set(GLOBAL_VALUE_FLAGS);
export const GLOBAL_VALUE_FLAGS_ALLOWING_DASH_VALUE: ReadonlySet<string> = new Set([
	"--args",
	"--session",
]);
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
	"--no-ca-cert",
	"--no-pin-tab",
	"--no-webmcp",
	"--offline",
	"--pin-tab",
	"--quick",
	"--fix",
	"--quiet",
	"-q",
	"--verbose",
	"-v",
	"--use-system-ca",
	"--webgpu",
]);

export interface UpstreamGlobalFlagOccurrence {
	readonly index: number;
	readonly value?: string | undefined;
}

/** Match upstream's last-wins, case-sensitive boolean semantics; only exact `false` disables a present flag. */
export function getBooleanFlagValue(args: readonly string[], flag: string): boolean | undefined {
	let enabled: boolean | undefined;
	const entries = args.entries();
	for (const [index, token] of entries) {
		if (token === flag) {
			enabled = args[index + 1] !== "false";
			if (["true", "false"].includes(args[index + 1] ?? "")) {
				entries.next();
			}
			continue;
		}
		if (PREVALIDATED_VALUE_FLAGS.has(token)) {
			entries.next();
			continue;
		}
		if (
			GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token) &&
			["true", "false"].includes(args[index + 1] ?? "")
		) {
			entries.next();
		}
	}
	return enabled;
}

export function isBooleanFlagEnabled(args: readonly string[], flag: string): boolean {
	return getBooleanFlagValue(args, flag) ?? false;
}

/** Match upstream env_var_is_truthy exactly: lowercase only, without trimming or accepting "off". */
export function isUpstreamEnvFlagEnabled(value: string | undefined): boolean {
	return value !== undefined && !["", "0", "false", "no"].includes(value.toLowerCase());
}

/** Mirror upstream global parsing: full argv, no `--` sentinel, and only global value payloads are skipped. */
export function scanUpstreamGlobalFlagOccurrences(
	args: readonly string[],
	targetFlag: string,
): UpstreamGlobalFlagOccurrence[] {
	const occurrences: UpstreamGlobalFlagOccurrence[] = [];
	const entries = args.entries();
	for (const [index, token] of entries) {
		if (token === targetFlag) {
			occurrences.push({ index, value: args[index + 1] });
			entries.next();
			continue;
		}
		if (PREVALIDATED_VALUE_FLAGS.has(token)) {
			entries.next();
			continue;
		}
		if (
			GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token) &&
			["true", "false"].includes(args[index + 1] ?? "")
		) {
			entries.next();
		}
	}
	return occurrences;
}

export function extractExplicitSessionName(args: readonly string[]): string | undefined {
	return scanUpstreamGlobalFlagOccurrences(args, "--session").at(-1)?.value;
}

export function extractExplicitNamespace(args: readonly string[]): string | undefined {
	return canonicalizeAgentBrowserNamespace(
		scanUpstreamGlobalFlagOccurrences(args, "--namespace").at(-1)?.value,
	);
}

export function resolveAgentBrowserNamespace(
	args: readonly string[],
	envValue: string | undefined,
): string | undefined {
	const occurrences = scanUpstreamGlobalFlagOccurrences(args, "--namespace");
	if (occurrences.length > 0) {
		return canonicalizeAgentBrowserNamespace(occurrences.at(-1)?.value) ?? "";
	}
	return canonicalizeAgentBrowserNamespace(envValue);
}

function getRestoreFlag(
	token: string,
	next: string | undefined,
	seenCommand: boolean,
	sessionName: string,
): { key: string; consumed: number } | undefined {
	if (token.startsWith("--restore=")) {
		const requested = token.slice("--restore=".length);
		return { key: requested.length > 0 ? requested : sessionName, consumed: 0 };
	}
	if (token !== "--restore") {
		return undefined;
	}
	if (!seenCommand && optionalGlobalValueFlagConsumesNext(token, next) && next !== undefined) {
		return { key: next, consumed: 1 };
	}
	return { key: sessionName, consumed: 0 };
}

/** Mirror upstream's optional restore value and full-argv last-wins parsing. */
export function extractRequestedRestoreKey(
	args: readonly string[],
	sessionName: string,
	envValue?: string,
): string | null {
	let restoreKey = envValue !== undefined && envValue.length > 0 ? envValue : null;
	let seenCommand = false;
	const entries = args.entries();
	for (const [index, token] of entries) {
		const restore = getRestoreFlag(token, args[index + 1], seenCommand, sessionName);
		if (restore !== undefined) {
			restoreKey = restore.key;
			if (restore.consumed === 1) {
				entries.next();
			}
			continue;
		}
		if (globalFlagWidth(token, args[index + 1], seenCommand) === 2) {
			entries.next();
			continue;
		}
		if (isKnownCommandToken(token)) {
			seenCommand = true;
		}
	}
	return restoreKey;
}

function getFlagName(token: string): string {
	return token.split("=", 1).at(0) ?? token;
}

export function isNonFlagToken(token: string | undefined): token is string {
	return typeof token === "string" && !token.startsWith("-");
}

export function hasOnlyBooleanFlags(
	tokens: readonly string[],
	allowedFlags: ReadonlySet<string>,
): boolean {
	return tokens.every((token) => token.startsWith("-") && allowedFlags.has(getFlagName(token)));
}

export function hasOnlyOptionFlags(
	tokens: readonly string[],
	allowedBooleanFlags: ReadonlySet<string>,
	allowedValueFlags: ReadonlySet<string>,
): boolean {
	const entries = tokens.entries();
	for (const [index, token] of entries) {
		if (!token.startsWith("-")) {
			return false;
		}
		const flagName = getFlagName(token);
		if (allowedBooleanFlags.has(flagName)) {
			continue;
		}
		if (!allowedValueFlags.has(flagName)) {
			return false;
		}
		if (token.includes("=")) {
			continue;
		}
		const value = tokens.at(index + 1);
		if (!isNonFlagToken(value)) {
			return false;
		}
		entries.next();
	}
	return true;
}

export function optionalGlobalValueFlagConsumesNext(
	flag: string,
	nextToken: string | undefined,
): boolean {
	if (
		!OPTIONAL_GLOBAL_VALUE_FLAGS.has(flag) ||
		nextToken === undefined ||
		nextToken.startsWith("-")
	) {
		return false;
	}
	return !isKnownCommandToken(nextToken);
}

function globalFlagWidth(token: string, next: string | undefined, seenCommand: boolean): number {
	if (token.startsWith("--restore=")) {
		return 1;
	}
	if (token === "--restore") {
		return !seenCommand && optionalGlobalValueFlagConsumesNext(token, next) ? 2 : 1;
	}
	if (PREVALIDATED_VALUE_FLAGS.has(token)) {
		return 2;
	}
	if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token)) {
		return ["true", "false"].includes(next ?? "") ? 2 : 1;
	}
	return 0;
}

export interface IndexedArgvToken {
	readonly index: number;
	readonly token: string;
}

export function projectUpstreamGlobalFlags(args: readonly string[]): IndexedArgvToken[] {
	const tokens: IndexedArgvToken[] = [];
	let seenCommand = false;
	const entries = args.entries();
	for (const [index, token] of entries) {
		const width = globalFlagWidth(token, args[index + 1], seenCommand);
		if (width > 0) {
			if (width === 2) {
				entries.next();
			}
			continue;
		}
		tokens.push({ index, token });
		if (isKnownCommandToken(token)) {
			seenCommand = true;
		}
	}
	return tokens;
}

/** Mirror upstream clean_args: remove global flags wherever they appear before command parsing. */
export function stripUpstreamGlobalFlags(args: readonly string[]): string[] {
	return projectUpstreamGlobalFlags(args).map(({ token }) => token);
}

export function stripSessionlessShapeGlobalFlags(commandTokens: readonly string[]): string[] {
	const stripped: string[] = [];
	const entries = commandTokens.values();
	for (const token of entries) {
		const flagName = getFlagName(token);
		if (token === "--json") {
			continue;
		}
		if ((flagName === "--session" || flagName === "--namespace") && !token.includes("=")) {
			entries.next();
			continue;
		}
		if (token.startsWith("--session=") || token.startsWith("--namespace=")) {
			continue;
		}
		stripped.push(token);
	}
	return stripped;
}
