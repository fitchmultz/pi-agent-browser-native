/**
 * Purpose: Build safe, deterministic agent-browser invocations for the pi-agent-browser extension.
 * Responsibilities: Validate raw tool arguments, derive extension-managed session names from the pi session identity, resolve managed-session timeout/state helpers, detect explicit session usage, and build the effective CLI argument list passed to the upstream agent-browser binary.
 * Scope: Pure runtime-planning helpers only; no subprocess execution or filesystem access lives here.
 * Usage: Imported by the extension entrypoint and unit tests before spawning the upstream CLI.
 * Invariants/Assumptions: The wrapper stays thin, preserves upstream command vocabulary, and only injects `--json` plus an extension-managed `--session` when appropriate.
 */

import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

const STARTUP_SCOPED_FLAGS = ["--cdp", "--profile", "--session-name"] as const;
const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
const AGENT_BROWSER_IDLE_TIMEOUT_ENV = "AGENT_BROWSER_IDLE_TIMEOUT_MS";
const IMPLICIT_SESSION_IDLE_TIMEOUT_ENV = "PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS";
const IMPLICIT_SESSION_CLOSE_TIMEOUT_ENV = "PI_AGENT_BROWSER_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS";
const DEFAULT_IMPLICIT_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS = 5_000;
const LEGACY_BASH_ALLOW_PATTERNS = [
	/\b(?:bash-oriented workflow|bash workflow)\b/i,
	/\b(?:use|via|through|with)\s+bash\b/i,
	/\bnpx\s+agent-browser\b/i,
	/\bagent-browser\s+--(?:help|version)\b/i,
	/\bdebug(?:ging)?\b.*\b(?:agent[_ -]?browser|agent_browser|browser integration)\b/i,
];

const GLOBAL_FLAGS_WITH_VALUES = new Set([
	"--session",
	"--cdp",
	"--config",
	"--profile",
	"--session-name",
	"--proxy",
	"--proxy-bypass",
	"--headers",
	"--executable-path",
	"--extension",
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
	"--port",
]);
const SHELL_OPERATOR_TOKENS = new Set(["&&", "||", "|", ";", ">", ">>", "<"]);
const MAX_PROJECT_SLUG_LENGTH = 24;
const SESSION_NAME_CWD_HASH_LENGTH = 8;
const SESSION_NAME_SESSION_ID_LENGTH = 12;

export interface CommandInfo {
	command?: string;
	subcommand?: string;
}

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

export interface ExecutionPlan {
	commandInfo: CommandInfo;
	effectiveArgs: string[];
	invalidValueFlag?: InvalidValueFlagDetails;
	managedSessionName?: string;
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

export interface PromptPolicy {
	allowLegacyAgentBrowserBash: boolean;
}

export function hasUsableBraveApiKey(apiKey: string | null | undefined = process.env[BRAVE_API_KEY_ENV]): boolean {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
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

export function getImplicitSessionIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): string {
	return String(
		parseTimeoutMs(env[IMPLICIT_SESSION_IDLE_TIMEOUT_ENV], 0) ??
			parseTimeoutMs(env[AGENT_BROWSER_IDLE_TIMEOUT_ENV], 0) ??
			DEFAULT_IMPLICIT_SESSION_IDLE_TIMEOUT_MS,
	);
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
	if (command === "close" && managedSessionName === priorSessionName) {
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

export function validateToolArgs(args: string[]): string | undefined {
	if (args.length === 0) {
		return "`args` must contain at least one agent-browser command token.";
	}

	const shellOperator = args.find((token) => SHELL_OPERATOR_TOKENS.has(token));
	if (shellOperator) {
		return `Do not pass shell operators like \`${shellOperator}\`. Pass exact agent-browser CLI arguments only.`;
	}

	return undefined;
}

function getInvalidValueFlagDetails(args: string[]): InvalidValueFlagDetails | undefined {
	for (const [index, token] of args.entries()) {
		if (!token.startsWith("-")) {
			continue;
		}
		const normalizedToken = token.split("=", 1)[0] ?? token;
		if (!GLOBAL_FLAGS_WITH_VALUES.has(normalizedToken)) {
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
		if (receivedToken.startsWith("-")) {
			return {
				flag: normalizedToken,
				index,
				reason: "unexpected-flag",
				receivedToken,
			};
		}
		continue;
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

export function getStartupScopedFlags(args: string[]): string[] {
	return STARTUP_SCOPED_FLAGS.filter((flag) => hasFlagToken(args, flag));
}

export function buildPromptPolicy(prompt: string): PromptPolicy {
	return {
		allowLegacyAgentBrowserBash: LEGACY_BASH_ALLOW_PATTERNS.some((pattern) => pattern.test(prompt)),
	};
}

function getMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((item) => {
			if (typeof item !== "object" || item === null) return "";
			return item.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

export function getLatestUserPrompt(branch: unknown[]): string {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message") {
			continue;
		}
		const message = "message" in entry ? entry.message : undefined;
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user") {
			continue;
		}
		return getMessageText("content" in message ? message.content : undefined);
	}
	return "";
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
	const effectiveArgs = args.includes("--json") ? [] : ["--json"];
	const invalidValueFlag = getInvalidValueFlagDetails(args);
	if (invalidValueFlag) {
		return {
			commandInfo: {},
			effectiveArgs,
			invalidValueFlag,
			startupScopedFlags: [],
			usedImplicitSession: false,
			validationError: formatInvalidValueFlagError(invalidValueFlag),
		};
	}

	const commandInfo = parseCommandInfo(args);
	const explicitSessionName = extractExplicitSessionName(args);
	const startupScopedFlags = getStartupScopedFlags(args);
	const shouldCreateFreshManagedSession =
		!explicitSessionName && options.sessionMode === "fresh" && commandInfo.command !== undefined && commandInfo.command !== "close";
	let managedSessionName: string | undefined;
	let recoveryHint: SessionRecoveryHint | undefined;
	let sessionName = explicitSessionName;
	let usedImplicitSession = false;
	let validationError: string | undefined;

	if (!explicitSessionName && options.sessionMode === "auto") {
		if (options.managedSessionActive && startupScopedFlags.length > 0) {
			recoveryHint = {
				exampleArgs: args,
				exampleParams: { args, sessionMode: "fresh" },
				reason:
					"Startup-scoped flags like --profile, --session-name, and --cdp need a fresh upstream launch once the extension-managed session is already active.",
				recommendedSessionMode: "fresh",
			};
			validationError = [
				`The current extension-managed agent-browser session is already running, so startup-scoped flags ${startupScopedFlags.join(", ")} would be ignored by upstream agent-browser.`,
				"Retry this call with `sessionMode: \"fresh\"` to force a fresh upstream launch, or pass an explicit `--session ...` if you want to name the new session yourself.",
			].join(" ");
		} else {
			effectiveArgs.push("--session", options.managedSessionName);
			managedSessionName = options.managedSessionName;
			sessionName = options.managedSessionName;
			usedImplicitSession = true;
		}
	} else if (shouldCreateFreshManagedSession) {
		effectiveArgs.push("--session", options.freshSessionName);
		managedSessionName = options.freshSessionName;
		sessionName = options.freshSessionName;
	}

	effectiveArgs.push(...args);

	return {
		commandInfo,
		effectiveArgs,
		managedSessionName,
		recoveryHint,
		sessionName,
		startupScopedFlags,
		usedImplicitSession,
		validationError,
	};
}

export function parseCommandInfo(args: string[]): CommandInfo {
	const commands: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token.startsWith("--session=")) {
			continue;
		}
		if (token.startsWith("-")) {
			const normalizedToken = token.split("=", 1)[0] ?? token;
			if (GLOBAL_FLAGS_WITH_VALUES.has(normalizedToken) && !token.includes("=")) {
				index += 1;
			}
			continue;
		}
		commands.push(token);
		if (commands.length === 2) {
			break;
		}
	}

	return { command: commands[0], subcommand: commands[1] };
}

