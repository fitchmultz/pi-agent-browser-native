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
	"--capture",
	"--action-policy",
	"--confirm-actions",
	"--max-output",
	"--model",
	"--idle-timeout",
	"--input-mode",
] as const;

const COMMAND_VALUE_FLAGS = [
	"--allow-origin",
	"--allow-write",
	"--allowed-origins",
	"--baseline",
	"--body",
	"--capability",
	"--categories",
	"--contact-sheet-threshold",
	"--content",
	"--curl",
	"--depth",
	"-d",
	"--description",
	"--domain",
	"--expires",
	"--fields",
	"--filter",
	"--fps",
	"--frame",
	"--from",
	"--fn",
	"--label",
	"--limit",
	"--load",
	"--method",
	"--name",
	"--older-than",
	"--origin",
	"--output",
	"--param",
	"--payload",
	"--prefix",
	"--path",
	"--port",
	"--params",
	"--ref",
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
	"--to",
	"--tools",
	"--type",
	"--url",
	"--username",
	"--password",
	"--wait-until",
	"--where",
] as const;

const OPTIONAL_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(["--restore"]);
/** Upstream stops global-flag and help parsing at this marker; later tokens are literal command text. */
export const END_OF_OPTIONS = "--";
export const INSPECTION_FLAGS: ReadonlySet<string> = new Set(["--help", "-h", "--version", "-V"]);
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
	"--no-auto-connect",
	"--no-auto-dialog",
	"--no-ca-cert",
	"--no-pin-tab",
	"--no-webmcp",
	"--offline",
	"--pin-tab",
	"--quick",
	"--fix",
	"--relaunch",
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
		if (token === END_OF_OPTIONS) {
			break;
		}
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

function booleanFlagArgument(next: string | undefined): { enabled: boolean; width: 1 | 2 } {
	return { enabled: next !== "false", width: next === "true" || next === "false" ? 2 : 1 };
}

/**
 * Mirror upstream's auto-connect pair: `--auto-connect [true|false]` sets the mode and an enabled
 * `--no-auto-connect` returns the session to a local launch; `--no-auto-connect false` changes nothing.
 */
export function getAutoConnectFlagValue(args: readonly string[]): boolean | undefined {
	let autoConnect: boolean | undefined;
	const entries = args.entries();
	for (const [index, token] of entries) {
		if (token === END_OF_OPTIONS) {
			break;
		}
		if (token === "--auto-connect" || token === "--no-auto-connect") {
			const { enabled, width } = booleanFlagArgument(args[index + 1]);
			if (token === "--auto-connect") {
				autoConnect = enabled;
			} else if (enabled) {
				autoConnect = false;
			}
			if (width === 2) {
				entries.next();
			}
			continue;
		}
		if (globalFlagWidth(token, args[index + 1], false) === 2) {
			entries.next();
		}
	}
	return autoConnect;
}

/** Match upstream env_var_is_truthy exactly: lowercase only, without trimming or accepting "off". */
export function isUpstreamEnvFlagEnabled(value: string | undefined): boolean {
	return value !== undefined && !["", "0", "false", "no"].includes(value.toLowerCase());
}

/** Mirror upstream global parsing: full argv up to the end-of-options marker; only global value payloads are skipped. */
export function scanUpstreamGlobalFlagOccurrences(
	args: readonly string[],
	targetFlag: string,
): UpstreamGlobalFlagOccurrence[] {
	const occurrences: UpstreamGlobalFlagOccurrence[] = [];
	const entries = args.entries();
	for (const [index, token] of entries) {
		if (token === END_OF_OPTIONS) {
			break;
		}
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
		if (token === END_OF_OPTIONS) {
			break;
		}
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
		if (token === END_OF_OPTIONS) {
			// Upstream keeps the marker and every later token as literal command text.
			tokens.push(
				...args.slice(index).map((literal, offset) => ({ index: index + offset, token: literal })),
			);
			break;
		}
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

/** Mirror upstream clean_args: remove global flags wherever they appear before the end-of-options marker. */
export function stripUpstreamGlobalFlags(args: readonly string[]): string[] {
	return projectUpstreamGlobalFlags(args).map(({ token }) => token);
}

/**
 * Tokens upstream still reads as options: everything before its end-of-options marker.
 * A `--` consumed as a global flag's value is not the marker, so this follows upstream's own scan.
 */
export function beforeEndOfOptions(args: readonly string[]): readonly string[] {
	const entries = args.entries();
	for (const [index, token] of entries) {
		if (token === END_OF_OPTIONS) {
			return args.slice(0, index);
		}
		if (globalFlagWidth(token, args[index + 1], false) === 2) {
			entries.next();
		}
	}
	return args;
}

/** Mirror upstream is_global_flag: a batch item token that belongs on the outer invocation. */
export function isUpstreamGlobalFlagToken(token: string): boolean {
	return (
		INSPECTION_FLAGS.has(token) ||
		(token !== END_OF_OPTIONS && globalFlagWidth(token, undefined, false) > 0)
	);
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
