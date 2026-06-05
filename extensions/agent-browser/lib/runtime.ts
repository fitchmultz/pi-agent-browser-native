/**
 * Purpose: Build safe, deterministic agent-browser invocations and persisted session state for the pi-agent-browser extension.
 * Responsibilities: Validate raw tool arguments, derive extension-managed session names from the pi session identity, restore managed-session state from persisted tool details, redact sensitive invocation text, classify browser-oriented prompts, and build the effective CLI argument list passed to the upstream agent-browser binary.
 * Scope: Pure runtime-planning helpers only; no subprocess execution or filesystem access lives here.
 * Usage: Imported by the extension entrypoint and unit tests before spawning the upstream CLI.
 * Invariants/Assumptions: The wrapper stays thin, preserves upstream command vocabulary, keeps plain-text inspection stateless,
 * and only injects wrapper-owned flags: `--json`, an extension-managed `--session` when appropriate, and the narrow
 * OpenAI/ChatGPT headless compatibility `--user-agent` when that workaround applies.
 */

import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

import {
	extractCommandTokens,
	findCommandStartIndex,
	parseArgvDescriptor,
	parseCommandInfo,
	type CommandInfo,
} from "./argv-descriptor.js";
import {
	GLOBAL_VALUE_FLAGS_ALLOWING_DASH_VALUE,
	PREVALIDATED_VALUE_FLAGS,
} from "./argv-grammar.js";
import { needsManagedSession } from "./command-policy.js";
import { isCloseCommand, isOpenNavigationCommand } from "./command-taxonomy.js";
import { LAUNCH_SCOPED_FLAG_DEFINITIONS, LAUNCH_SCOPED_FLAG_LABEL, LAUNCH_SCOPED_TAB_CORRECTION_FLAGS } from "./launch-scoped-flags.js";

export type { CommandInfo } from "./argv-descriptor.js";
export { extractCommandTokens, findCommandStartIndex, parseArgvDescriptor, parseCommandInfo } from "./argv-descriptor.js";

import { isRecord } from "./parsing.js";

const OPENAI_HEADLESS_COMPAT_HOSTS = new Set(["chat.com", "chat.openai.com", "chatgpt.com"]);
const AGENT_BROWSER_IDLE_TIMEOUT_ENV = "AGENT_BROWSER_IDLE_TIMEOUT_MS";
const IMPLICIT_SESSION_IDLE_TIMEOUT_ENV = "PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS";
const IMPLICIT_SESSION_CLOSE_TIMEOUT_ENV = "PI_AGENT_BROWSER_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS";
const DEFAULT_IMPLICIT_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS = 5_000;
const INSPECTION_FLAGS = new Set(["--help", "-h", "--version", "-V"]);
const SENSITIVE_VALUE_FLAGS = new Set(["--body", "--headers", "--password", "--proxy"]);
const SENSITIVE_QUERY_PARAM_PATTERN =
	/^(?:access(?:_|-)?token|api(?:_|-)?key|auth|authorization|bearer|client(?:_|-)?secret|code|cookie|id(?:_|-)?token|key|pass(?:word)?|refresh(?:_|-)?token|secret|sentry(?:_|-)?key|session(?:_|-)?id|sig(?:nature)?|token|write(?:_|-)?key)$/i;
const SENSITIVE_FIELD_NAME_PATTERN =
	/^(?:access(?:_|-)?token|api(?:_|-)?key|auth(?:orization)?|bearer|client(?:_|-)?secret|cookie|id(?:_|-)?token|pass(?:word)?|proxy(?:_|-)?authorization|refresh(?:_|-)?token|secret|sentry(?:_|-)?key|session(?:_|-)?id|set(?:_|-)?cookie|sig(?:nature)?|token|write(?:_|-)?key|x(?:_|-)?api(?:_|-)?key)$/i;

const DEFAULT_HEADLESS_COMPAT_USER_AGENT_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
	darwin: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
	linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
	win32: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
};
const FALLBACK_HEADLESS_COMPAT_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const SHELL_OPERATOR_TOKENS = new Set(["&&", "||", "|", ";", ">", ">>", "<"]);
const MAX_PROJECT_SLUG_LENGTH = 24;
const SESSION_NAME_CWD_HASH_LENGTH = 8;
const SESSION_NAME_SESSION_ID_LENGTH = 12;

export type SessionMode = "auto" | "fresh";

export interface SessionRecoveryHint {
	exampleArgs: string[];
	exampleParams: { args: string[]; sessionMode: "fresh" };
	reason: string;
	recommendedSessionMode: "fresh";
}

export interface InvalidValueFlagDetails {
	flag: string;
	index: number;
	reason: "missing-value" | "unexpected-flag";
	receivedToken?: string;
}

export interface CompatibilityWorkaround {
	id: "chatgpt-headless-user-agent";
	reason: string;
}

export interface OpenResultTabCorrection {
	selectedTab: string;
	selectionKind: "index" | "label" | "tabId";
	targetTitle?: string;
	targetUrl: string;
}

export interface ExecutionPlan {
	commandInfo: CommandInfo;
	compatibilityWorkaround?: CompatibilityWorkaround;
	effectiveArgs: string[];
	invalidValueFlag?: InvalidValueFlagDetails;
	managedSessionName?: string;
	plainTextInspection: boolean;
	recoveryHint?: SessionRecoveryHint;
	sessionName?: string;
	startupScopedFlags: string[];
	usedImplicitSession: boolean;
	validationError?: string;
}

export interface ManagedSessionState {
	active: boolean;
	replacedSessionName?: string;
	sessionName: string;
}

export interface RestoredManagedSessionState extends ManagedSessionState {
	closedSessionName?: string;
	freshSessionOrdinal: number;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function shouldRedactQueryParam(name: string): boolean {
	return SENSITIVE_QUERY_PARAM_PATTERN.test(name);
}

function redactUrlToken(token: string): string {
	let parsed: URL;
	try {
		parsed = new URL(token);
	} catch {
		return token;
	}

	if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
		return token;
	}

	let mutated = false;
	if (parsed.username.length > 0) {
		parsed.username = "[REDACTED]";
		mutated = true;
	}
	if (parsed.password.length > 0) {
		parsed.password = "[REDACTED]";
		mutated = true;
	}

	for (const [name] of parsed.searchParams) {
		if (shouldRedactQueryParam(name)) {
			parsed.searchParams.set(name, "[REDACTED]");
			mutated = true;
		}
	}

	const hashText = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
	if (hashText.includes("=")) {
		const hashParams = new URLSearchParams(hashText);
		for (const [name] of hashParams) {
			if (shouldRedactQueryParam(name)) {
				hashParams.set(name, "[REDACTED]");
				mutated = true;
			}
		}
		if (mutated) {
			parsed.hash = `#${hashParams.toString()}`;
		}
	}

	return parsed.toString();
}

function redactLooseUrlMatches(text: string): string {
	return text.replace(/\b(?:https?|wss?):\/\/[^\s"'`<>\])]+/g, (match) => redactUrlToken(match));
}

function findBalancedJsonEnd(text: string, startIndex: number): number | undefined {
	const opener = text[startIndex];
	const closer = opener === "{" ? "}" : opener === "[" ? "]" : undefined;
	if (!closer) return undefined;
	const stack = [closer];
	let inString = false;
	let escaped = false;
	for (let index = startIndex + 1; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			stack.push("}");
			continue;
		}
		if (char === "[") {
			stack.push("]");
			continue;
		}
		if (char === "}" || char === "]") {
			if (stack.pop() !== char) return undefined;
			if (stack.length === 0) return index;
		}
	}
	return undefined;
}

function redactEmbeddedStructuredText(text: string): string {
	let output = "";
	let cursor = 0;
	while (cursor < text.length) {
		const char = text[cursor];
		if (char !== "{" && char !== "[") {
			output += char;
			cursor += 1;
			continue;
		}
		const endIndex = findBalancedJsonEnd(text, cursor);
		if (endIndex === undefined) {
			output += char;
			cursor += 1;
			continue;
		}
		const candidate = text.slice(cursor, endIndex + 1);
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const redacted = typeof parsed === "string" ? redactSensitiveText(parsed) : JSON.stringify(redactSensitiveValue(parsed));
			const original = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
			output += redacted === original ? candidate : redacted;
		} catch {
			output += candidate;
		}
		cursor = endIndex + 1;
	}
	return output;
}

function redactStandaloneBasicCredential(text: string): string {
	return text.replace(/\b(Basic)\s+([A-Za-z0-9+/=]{12,})/gi, (match, label: string, credential: string) => {
		if (!/[0-9+/=]/.test(credential)) return match;
		return `${label} [REDACTED]`;
	});
}

function credentialTrailingPunctuation(credential: string): string {
	return credential.match(/^(.+?)([,.]+)$/)?.[2] ?? "";
}

function isBearerHelpPlaceholder(label: string, credential: string, trailing: string): boolean {
	return label.toLowerCase() === "authorization bearer" && credential.toLowerCase() === "token" && trailing === ")";
}

function formatRedactedCredential(label: string, credential: string, trailing = ""): string {
	return `${label} [REDACTED]${credentialTrailingPunctuation(credential)}${trailing}`;
}

function redactBearerCredentials(text: string): string {
	return text
		.replace(/\b(Authorization\s*:\s*Bearer)\s+([^\s"',)\[\]]+)([),.]?)/gi, (_match, label: string, credential: string, trailing: string) => {
			return formatRedactedCredential(label, credential, trailing);
		})
		.replace(/\b((?:Authorization\s+)?Bearer)\s+([^\s"',)\[\]]+)([),.]?)/gi, (match, label: string, credential: string, trailing: string) => {
			if (isBearerHelpPlaceholder(label, credential, trailing)) return match;
			return formatRedactedCredential(label, credential, trailing);
		});
}

export function redactSensitiveText(text: string): string {
	return redactEmbeddedStructuredText(
		redactStandaloneBasicCredential(
			redactBearerCredentials(redactLooseUrlMatches(text))
				.replace(/\b(Authorization\s*:\s*Basic)\s+[^\s",]+/gi, "$1 [REDACTED]")
				.replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\n\r"]+/gi, "$1: [REDACTED]"),
		),
	);
}

export function redactSensitiveValue(value: unknown): unknown {
	if (typeof value === "string") {
		return redactSensitiveText(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactSensitiveValue(item));
	}
	if (!isRecord(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => {
			if (SENSITIVE_FIELD_NAME_PATTERN.test(key)) {
				return [key, "[REDACTED]"];
			}
			return [key, redactSensitiveValue(entryValue)];
		}),
	);
}

function redactFlagValue(flag: string, value: string): string {
	if (SENSITIVE_VALUE_FLAGS.has(flag)) {
		return "[REDACTED]";
	}
	return redactUrlToken(value);
}

export function redactInvocationArgs(args: string[]): string[] {
	const redacted: string[] = [];
	let pendingValueFlag: string | undefined;

	for (const token of args) {
		if (pendingValueFlag) {
			redacted.push(redactFlagValue(pendingValueFlag, token));
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

	const commandStartIndex = findCommandStartIndex(args);
	if (commandStartIndex !== undefined && args[commandStartIndex] === "set" && args[commandStartIndex + 1] === "credentials") {
		for (const index of [commandStartIndex + 2, commandStartIndex + 3]) {
			if (redacted[index] !== undefined) {
				redacted[index] = "[REDACTED]";
			}
		}
	}

	if (commandStartIndex !== undefined && args[commandStartIndex] === "cookies" && args[commandStartIndex + 1] === "set" && redacted[commandStartIndex + 3] !== undefined) {
		redacted[commandStartIndex + 3] = "[REDACTED]";
	}

	if (
		commandStartIndex !== undefined
		&& args[commandStartIndex] === "storage"
		&& ["local", "session"].includes(args[commandStartIndex + 1] ?? "")
		&& args[commandStartIndex + 2] === "set"
		&& redacted[commandStartIndex + 4] !== undefined
	) {
		redacted[commandStartIndex + 4] = "[REDACTED]";
	}

	if (commandStartIndex !== undefined && args[commandStartIndex] === "clipboard" && args[commandStartIndex + 1] === "write") {
		for (let index = commandStartIndex + 2; index < redacted.length; index += 1) {
			redacted[index] = "[REDACTED]";
		}
	}

	return redacted;
}

export function isPlainTextInspectionArgs(args: string[]): boolean {
	return args.some((token) => INSPECTION_FLAGS.has(token));
}

function parseTimeoutMs(rawValue: string | undefined, minimumValue: number): number | undefined {
	if (typeof rawValue !== "string") return undefined;
	const normalizedValue = rawValue.trim();
	if (!/^\d+$/.test(normalizedValue)) return undefined;
	const parsedValue = Number(normalizedValue);
	if (!Number.isSafeInteger(parsedValue) || parsedValue < minimumValue) {
		return undefined;
	}
	return parsedValue;
}

export function getImplicitSessionIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	return parseTimeoutMs(env[IMPLICIT_SESSION_IDLE_TIMEOUT_ENV], 0) ??
		parseTimeoutMs(env[AGENT_BROWSER_IDLE_TIMEOUT_ENV], 0) ??
		DEFAULT_IMPLICIT_SESSION_IDLE_TIMEOUT_MS;
}

export function getImplicitSessionCloseTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	return parseTimeoutMs(env[IMPLICIT_SESSION_CLOSE_TIMEOUT_ENV], 0) ?? DEFAULT_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS;
}

export function resolveManagedSessionState(options: {
	command?: string;
	managedSessionName?: string;
	priorActive: boolean;
	priorSessionName: string;
	succeeded: boolean;
}): ManagedSessionState {
	const { command, managedSessionName, priorActive, priorSessionName, succeeded } = options;
	if (!managedSessionName) {
		return { active: priorActive, sessionName: priorSessionName };
	}
	if (isCloseCommand(command) && managedSessionName === priorSessionName) {
		return { active: succeeded ? false : priorActive, sessionName: priorSessionName };
	}
	if (!succeeded) {
		return { active: priorActive, sessionName: priorSessionName };
	}
	return {
		active: true,
		replacedSessionName: priorActive && priorSessionName !== managedSessionName ? priorSessionName : undefined,
		sessionName: managedSessionName,
	};
}

function isRestorableManagedSessionName(sessionName: string, fallbackSessionName: string): boolean {
	return sessionName === fallbackSessionName || sessionName.startsWith(`${fallbackSessionName}-fresh-`);
}

function getManagedSessionRestoreRank(options: {
	fallbackSessionName: string;
	freshSessionRanks: Map<string, number>;
	sessionName: string;
}): number | undefined {
	const { fallbackSessionName, freshSessionRanks, sessionName } = options;
	if (sessionName === fallbackSessionName) {
		return 0;
	}
	if (!sessionName.startsWith(`${fallbackSessionName}-fresh-`)) {
		return undefined;
	}
	const existingRank = freshSessionRanks.get(sessionName);
	if (existingRank !== undefined) {
		return existingRank;
	}
	const nextRank = freshSessionRanks.size + 1;
	freshSessionRanks.set(sessionName, nextRank);
	return nextRank;
}

function getRestorableManagedSessionName(value: unknown, fallbackSessionName: string): string | undefined {
	return typeof value === "string" && isRestorableManagedSessionName(value, fallbackSessionName) ? value : undefined;
}

function getElectronCleanupClosedManagedSessionNames(details: Record<string, unknown>, fallbackSessionName: string): string[] {
	const electron = isRecord(details.electron) ? details.electron : undefined;
	const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
	const results = Array.isArray(cleanup?.results) ? cleanup.results : [];
	const closedSessionNames = new Set<string>();
	for (const result of results) {
		if (!isRecord(result) || !Array.isArray(result.steps)) continue;
		const record = isRecord(result.record) ? result.record : undefined;
		for (const step of result.steps) {
			if (!isRecord(step) || step.resource !== "managed-session") continue;
			if (step.state !== "removed" && step.state !== "already-gone") continue;
			const sessionName = getRestorableManagedSessionName(step.sessionName, fallbackSessionName)
				?? getRestorableManagedSessionName(record?.sessionName, fallbackSessionName);
			if (sessionName) closedSessionNames.add(sessionName);
		}
	}
	return [...closedSessionNames];
}

export function restoreManagedSessionStateFromBranch(
	branch: unknown[],
	fallbackSessionName: string,
): RestoredManagedSessionState {
	let restoredState: ManagedSessionState = {
		active: false,
		sessionName: fallbackSessionName,
	};
	let activeRestoreRank = 0;
	let closedSessionName: string | undefined;
	let freshSessionOrdinal = 0;
	const freshSessionRanks = new Map<string, number>();

	const applyManagedClose = (sessionName: string): void => {
		const restoreRank = getManagedSessionRestoreRank({
			fallbackSessionName,
			freshSessionRanks,
			sessionName,
		});
		if (restoreRank === undefined || sessionName !== restoredState.sessionName) return;
		restoredState = { active: false, sessionName: restoredState.sessionName };
		closedSessionName = sessionName;
	};

	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") {
			continue;
		}
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") {
			continue;
		}
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) {
			continue;
		}
		const args = isStringArray(details.args) ? details.args : [];
		if (isPlainTextInspectionArgs(args)) {
			continue;
		}

		for (const sessionName of getElectronCleanupClosedManagedSessionNames(details, fallbackSessionName)) {
			applyManagedClose(sessionName);
		}

		const explicitSessionName = extractExplicitSessionName(args);
		const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
		const sessionMode = details.sessionMode === "fresh" || details.sessionMode === "auto" ? details.sessionMode : undefined;
		const usedImplicitSession = details.usedImplicitSession === true;
		const command = typeof details.command === "string" ? details.command : parseCommandInfo(args).command;
		const commandClosesSession = isCloseCommand(command);
		const outcome = typeof details.managedSessionOutcome === "object" && details.managedSessionOutcome !== null ? details.managedSessionOutcome as Record<string, unknown> : undefined;
		const outcomeStatus = typeof outcome?.status === "string" ? outcome.status : undefined;
		const outcomeCurrentSessionName = typeof outcome?.currentSessionName === "string" ? outcome.currentSessionName : undefined;
		const outcomeAttemptedSessionName = getRestorableManagedSessionName(outcome?.attemptedSessionName, fallbackSessionName);
		const outcomeClosedSessionName = outcomeStatus === "closed" && outcome?.succeeded === true
			? outcomeAttemptedSessionName ?? getRestorableManagedSessionName(outcomeCurrentSessionName, fallbackSessionName) ?? getRestorableManagedSessionName(sessionName, fallbackSessionName)
			: undefined;
		const restorableDetailSessionName = getRestorableManagedSessionName(sessionName, fallbackSessionName);
		const explicitCloseSessionName = commandClosesSession && explicitSessionName && restorableDetailSessionName === explicitSessionName
			? restorableDetailSessionName
			: undefined;
		const managedSessionName =
			!explicitSessionName &&
			restorableDetailSessionName &&
			(usedImplicitSession || sessionMode === "fresh")
				? restorableDetailSessionName
				: commandClosesSession
					? outcomeClosedSessionName ?? explicitCloseSessionName
					: undefined;
		if (!managedSessionName) {
			continue;
		}

		const restoreRank = getManagedSessionRestoreRank({
			fallbackSessionName,
			freshSessionRanks,
			sessionName: managedSessionName,
		});
		if (restoreRank === undefined) {
			continue;
		}
		freshSessionOrdinal = Math.max(freshSessionOrdinal, restoreRank);

		const messageIsError = typeof message.isError === "boolean" ? message.isError : undefined;
		const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
		const outcomeActiveAfter = outcome?.activeAfter === true;
		const outcomeRepresentsActiveCurrentSession = outcomeActiveAfter && outcomeCurrentSessionName === managedSessionName && (outcomeStatus === "created" || outcomeStatus === "replaced" || outcomeStatus === "unchanged");
		const succeeded = outcomeRepresentsActiveCurrentSession ? true : messageIsError === undefined ? exitCode === undefined || exitCode === 0 : !messageIsError;
		if (commandClosesSession) {
			if (succeeded) applyManagedClose(managedSessionName);
			continue;
		}
		const staleCompletion = succeeded && restoreRank < activeRestoreRank;
		if (staleCompletion) {
			continue;
		}

		restoredState = resolveManagedSessionState({
			command,
			managedSessionName,
			priorActive: restoredState.active,
			priorSessionName: restoredState.sessionName,
			succeeded,
		});
		if (succeeded && restoredState.active) {
			activeRestoreRank = restoreRank;
			closedSessionName = undefined;
		}
	}

	return {
		...restoredState,
		...(closedSessionName ? { closedSessionName } : {}),
		freshSessionOrdinal,
	};
}

export function createEphemeralSessionSeed(): string {
	return randomUUID();
}

function createCwdHash(cwd: string): string {
	return createHash("sha256").update(`cwd:${cwd}`).digest("hex").slice(0, SESSION_NAME_CWD_HASH_LENGTH);
}

export function createImplicitSessionName(
	sessionId: string | undefined,
	cwd: string,
	ephemeralSeed: string,
): string {
	const slug =
		basename(cwd)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, MAX_PROJECT_SLUG_LENGTH) || "project";
	const cwdHash = createCwdHash(cwd);
	const stableSessionId = sessionId?.replace(/-/g, "").slice(0, SESSION_NAME_SESSION_ID_LENGTH);
	if (stableSessionId && stableSessionId.length > 0) {
		return `piab-${slug}-${stableSessionId}-${cwdHash}`;
	}

	const digest = createHash("sha256")
		.update(`ephemeral:${cwd}:${ephemeralSeed}`)
		.digest("hex")
		.slice(0, SESSION_NAME_SESSION_ID_LENGTH);
	return `piab-${slug}-${digest}-${cwdHash}`;
}

export function createFreshSessionName(baseSessionName: string, ephemeralSeed: string, ordinal: number): string {
	const suffix = createHash("sha256")
		.update(`fresh:${baseSessionName}:${ephemeralSeed}:${ordinal}`)
		.digest("hex")
		.slice(0, 10);
	return `${baseSessionName}-fresh-${suffix}`;
}

function getSingleKeyCommandValidationError(args: string[]): string | undefined {
	const { commandInfo, commandTokens } = parseArgvDescriptor(args);
	const command = commandInfo.command;
	if (command !== "press" && command !== "key" && command !== "keydown" && command !== "keyup") return undefined;
	if (commandTokens.length === 2) return undefined;
	const label = command === "key" ? "key/press" : command;
	return `agent-browser ${label} accepts exactly one key argument. Do not pass a selector or ref to ${label}; focus or click the target first, then run ${command} <key> (for example: focus @e1, then press Enter).`;
}

export function validateToolArgs(args: string[]): string | undefined {
	if (args.length === 0) {
		return "`args` must contain at least one agent-browser command token.";
	}

	const shellOperator = args.find((token) => SHELL_OPERATOR_TOKENS.has(token));
	if (shellOperator) {
		return `Do not pass shell operators like \`${shellOperator}\`. Pass exact agent-browser CLI arguments only.`;
	}

	const sessionModeArg = args.find((token) => token === "--session-mode" || token.startsWith("--session-mode="));
	if (sessionModeArg) {
		return "Do not pass `--session-mode` in args. Use the top-level agent_browser `sessionMode` field instead, for example { args: [\"--profile\", \"Default\", \"open\", \"https://example.com\"], sessionMode: \"fresh\" }.";
	}

	return getSingleKeyCommandValidationError(args);
}

function getInvalidValueFlagDetails(args: string[]): InvalidValueFlagDetails | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (!token.startsWith("-")) {
			continue;
		}
		const normalizedToken = token.split("=", 1)[0] ?? token;
		if (!PREVALIDATED_VALUE_FLAGS.has(normalizedToken)) {
			continue;
		}
		if (token.includes("=")) {
			const value = token.slice(token.indexOf("=") + 1).trim();
			if (value.length === 0) {
				return {
					flag: normalizedToken,
					index,
					reason: "missing-value",
				};
			}
			continue;
		}
		const receivedToken = args[index + 1];
		if (receivedToken === undefined) {
			return {
				flag: normalizedToken,
				index,
				reason: "missing-value",
			};
		}
		if (receivedToken.startsWith("-") && !GLOBAL_VALUE_FLAGS_ALLOWING_DASH_VALUE.has(normalizedToken)) {
			return {
				flag: normalizedToken,
				index,
				reason: "unexpected-flag",
				receivedToken,
			};
		}
		index += 1;
	}
	return undefined;
}

function formatInvalidValueFlagError(details: InvalidValueFlagDetails): string {
	if (details.reason === "unexpected-flag" && details.receivedToken) {
		return `Flag \`${details.flag}\` requires a value, but received \`${details.receivedToken}\` instead. Pass a non-flag value immediately after \`${details.flag}\`.`;
	}
	return `Flag \`${details.flag}\` requires a value immediately after it. Pass a non-flag token like \`${details.flag} demo\`.`;
}

function hasFlagToken(args: string[], flag: string): boolean {
	return args.some((token) => token === flag || token.startsWith(`${flag}=`));
}

function getFlagValue(args: string[], flag: string): string | undefined {
	for (const [index, token] of args.entries()) {
		if (token === flag) {
			return args[index + 1];
		}
		if (token.startsWith(`${flag}=`)) {
			return token.slice(flag.length + 1);
		}
	}
	return undefined;
}

function isBooleanFlagEnabled(args: string[], flag: string): boolean {
	for (const [index, token] of args.entries()) {
		if (token === flag) {
			const nextToken = args[index + 1]?.trim().toLowerCase();
			if (nextToken === "false") {
				return false;
			}
			return true;
		}
		if (token.startsWith(`${flag}=`)) {
			return token.slice(flag.length + 1).trim().toLowerCase() !== "false";
		}
	}
	return false;
}

function normalizeComparableUrl(url: string): string | undefined {
	const normalizedUrl = url.trim();
	if (normalizedUrl.length === 0) {
		return undefined;
	}
	try {
		const parsedUrl = new URL(normalizedUrl);
		parsedUrl.hash = "";
		return parsedUrl.toString();
	} catch {
		return undefined;
	}
}

function normalizeTabSelectionValue(value: string | undefined): string | undefined {
	const normalizedValue = value?.trim();
	return normalizedValue && normalizedValue.length > 0 ? normalizedValue : undefined;
}

function extractTabSelection(tab: { index?: number; label?: string; tabId?: string }): Pick<OpenResultTabCorrection, "selectedTab" | "selectionKind"> | undefined {
	const tabId = normalizeTabSelectionValue(tab.tabId);
	if (tabId) {
		return { selectedTab: tabId, selectionKind: "tabId" };
	}
	const label = normalizeTabSelectionValue(tab.label);
	if (label) {
		return { selectedTab: label, selectionKind: "label" };
	}
	if (typeof tab.index === "number" && Number.isInteger(tab.index) && tab.index >= 0) {
		return { selectedTab: String(tab.index), selectionKind: "index" };
	}
	return undefined;
}

function parseComparableNavigationUrl(url: string): URL | undefined {
	try {
		return new URL(url);
	} catch {
		try {
			return new URL(`https://${url}`);
		} catch {
			return undefined;
		}
	}
}

function getDefaultHeadlessCompatUserAgent(platform: NodeJS.Platform = process.platform): string {
	return DEFAULT_HEADLESS_COMPAT_USER_AGENT_BY_PLATFORM[platform] ?? FALLBACK_HEADLESS_COMPAT_USER_AGENT;
}

function getCompatibilityWorkaround(args: string[], commandInfo: CommandInfo): CompatibilityWorkaround | undefined {
	if (!commandInfo.command || !isOpenNavigationCommand(commandInfo.command) || !commandInfo.subcommand) {
		return undefined;
	}
	if (hasFlagToken(args, "--user-agent")) {
		return undefined;
	}
	if (isBooleanFlagEnabled(args, "--headed")) {
		return undefined;
	}
	if (hasFlagToken(args, "--cdp") || hasFlagToken(args, "--provider") || hasFlagToken(args, "-p") || isBooleanFlagEnabled(args, "--auto-connect")) {
		return undefined;
	}
	const engine = getFlagValue(args, "--engine");
	if (engine && engine !== "chrome") {
		return undefined;
	}
	const parsedTargetUrl = parseComparableNavigationUrl(commandInfo.subcommand);
	if (!parsedTargetUrl || !["http:", "https:"].includes(parsedTargetUrl.protocol)) {
		return undefined;
	}
	const hostname = parsedTargetUrl.hostname.toLowerCase();
	if (!OPENAI_HEADLESS_COMPAT_HOSTS.has(hostname)) {
		return undefined;
	}
	return {
		id: "chatgpt-headless-user-agent",
		reason:
			"OpenAI web properties currently challenge the default headless Chrome user agent; inject a normal Chrome user agent to preserve the default headless workflow without requiring headed mode or auto-connect.",
	};
}

export function extractExplicitSessionName(args: string[]): string | undefined {
	for (const [index, token] of args.entries()) {
		if (token === "--session") {
			return args[index + 1];
		}
		if (token.startsWith("--session=")) {
			return token.slice("--session=".length);
		}
	}
	return undefined;
}

function hasLaunchScopedFlagToken(args: string[], flag: string): boolean {
	const commandStartIndex = findCommandStartIndex(args);
	const command = commandStartIndex === undefined ? undefined : args[commandStartIndex];
	return args.some((token, index) => {
		if (token !== flag && !token.startsWith(`${flag}=`)) return false;
		if (flag === "--auto-connect") return isBooleanFlagEnabled(args, flag);
		if (flag === "--state" && command === "wait" && commandStartIndex !== undefined && index > commandStartIndex) {
			return false;
		}
		return true;
	});
}

export function getStartupScopedFlags(args: string[]): string[] {
	return LAUNCH_SCOPED_FLAG_DEFINITIONS
		.map((definition) => definition.flag)
		.filter((flag) => hasLaunchScopedFlagToken(args, flag));
}

export function hasLaunchScopedTabCorrectionFlag(args: string[]): boolean {
	return args.some((token) => {
		for (const flag of LAUNCH_SCOPED_TAB_CORRECTION_FLAGS) {
			if (token === flag || token.startsWith(`${flag}=`)) return true;
		}
		return false;
	});
}

export function buildExecutionPlan(
	args: string[],
	options: {
		freshSessionName: string;
		managedSessionActive: boolean;
		managedSessionName: string;
		sessionMode: SessionMode;
	},
): ExecutionPlan {
	const invalidValueFlag = getInvalidValueFlagDetails(args);
	const startupScopedFlags = getStartupScopedFlags(args);
	const plainTextInspection = isPlainTextInspectionArgs(args);
	const argvDescriptor = parseArgvDescriptor(args);
	const commandTokens = argvDescriptor.commandTokens;
	const commandInfo = argvDescriptor.commandInfo;
	const commandNeedsManagedSession = !plainTextInspection && needsManagedSession(argvDescriptor);
	const effectiveArgs = plainTextInspection ? [...args] : args.includes("--json") ? [] : ["--json"];
	if (invalidValueFlag) {
		return {
			commandInfo: {},
			effectiveArgs,
			invalidValueFlag,
			plainTextInspection: false,
			startupScopedFlags: [],
			usedImplicitSession: false,
			validationError: formatInvalidValueFlagError(invalidValueFlag),
		};
	}

	if (plainTextInspection) {
		return {
			commandInfo,
			effectiveArgs,
			plainTextInspection,
			startupScopedFlags,
			usedImplicitSession: false,
		};
	}

	const explicitSessionName = extractExplicitSessionName(args);
	const shouldCreateFreshManagedSession =
		!explicitSessionName && options.sessionMode === "fresh" && commandInfo.command !== undefined && !isCloseCommand(commandInfo.command);
	const compatibilityWorkaround = getCompatibilityWorkaround(args, commandInfo);
	let managedSessionName: string | undefined;
	let recoveryHint: SessionRecoveryHint | undefined;
	let sessionName = explicitSessionName;
	let usedImplicitSession = false;
	let validationError: string | undefined;

	if (!explicitSessionName && options.sessionMode === "auto" && commandNeedsManagedSession) {
		if (options.managedSessionActive && startupScopedFlags.length > 0) {
			recoveryHint = {
				exampleArgs: args,
				exampleParams: { args, sessionMode: "fresh" },
				reason:
					`Launch-scoped flags (${LAUNCH_SCOPED_FLAG_LABEL}) need a fresh upstream launch once the extension-managed session is already active.`,
				recommendedSessionMode: "fresh",
			};
			validationError = [
				`The current extension-managed agent-browser session is already running, so launch-scoped flags ${startupScopedFlags.join(", ")} would be ignored by upstream agent-browser.`,
				"Retry this call with `sessionMode: \"fresh\"` to force a fresh upstream launch, or pass an explicit `--session ...` if you want to name the new session yourself.",
			].join(" ");
		} else {
			effectiveArgs.push("--session", options.managedSessionName);
			managedSessionName = options.managedSessionName;
			sessionName = options.managedSessionName;
			usedImplicitSession = true;
		}
	} else if (shouldCreateFreshManagedSession && commandNeedsManagedSession) {
		effectiveArgs.push("--session", options.freshSessionName);
		managedSessionName = options.freshSessionName;
		sessionName = options.freshSessionName;
	}

	if (compatibilityWorkaround) {
		effectiveArgs.push("--user-agent", getDefaultHeadlessCompatUserAgent());
	}
	effectiveArgs.push(...args);

	return {
		commandInfo,
		compatibilityWorkaround,
		effectiveArgs,
		managedSessionName,
		plainTextInspection,
		recoveryHint,
		sessionName,
		startupScopedFlags,
		usedImplicitSession,
		validationError,
	};
}

export function chooseOpenResultTabCorrection(options: {
	activeTabIndex?: number;
	tabs: Array<{ active?: boolean; index?: number; label?: string; tabId?: string; title?: string; url?: string }>;
	targetTitle?: string;
	targetUrl?: string;
}): OpenResultTabCorrection | undefined {
	const normalizedTargetUrl =
		typeof options.targetUrl === "string" ? normalizeComparableUrl(options.targetUrl) : undefined;
	if (!normalizedTargetUrl) {
		return undefined;
	}

	const tabsWithIndices = options.tabs.map((tab, index) => ({
		...tab,
		index: typeof tab.index === "number" ? tab.index : index,
		label: normalizeTabSelectionValue(tab.label),
		tabId: normalizeTabSelectionValue(tab.tabId),
	}));
	const activeTab =
		tabsWithIndices.find((tab) => tab.active === true) ??
		(typeof options.activeTabIndex === "number" ? tabsWithIndices.find((tab) => tab.index === options.activeTabIndex) : undefined);
	if (activeTab && normalizeComparableUrl(activeTab.url ?? "") === normalizedTargetUrl) {
		return undefined;
	}

	const matchingTabs = tabsWithIndices.filter((tab) => normalizeComparableUrl(tab.url ?? "") === normalizedTargetUrl);
	if (matchingTabs.length === 0) {
		return undefined;
	}
	const trimmedTargetTitle = typeof options.targetTitle === "string" ? options.targetTitle.trim() : "";
	const titledMatch =
		trimmedTargetTitle.length === 0
			? undefined
			: matchingTabs.find((tab) => typeof tab.title === "string" && tab.title.trim() === trimmedTargetTitle);
	const selectedTab = titledMatch ?? matchingTabs[0];
	const tabSelection = extractTabSelection(selectedTab);
	return tabSelection
		? {
			...tabSelection,
			targetTitle: trimmedTargetTitle.length > 0 ? trimmedTargetTitle : undefined,
			targetUrl: normalizedTargetUrl,
		}
		: undefined;
}
