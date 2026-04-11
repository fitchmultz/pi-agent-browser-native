/**
 * Purpose: Build safe, deterministic agent-browser invocations for the pi-agent-browser extension.
 * Responsibilities: Validate raw tool arguments, derive implicit session names from the pi session identity, detect explicit session usage, and build the effective CLI argument list passed to the upstream agent-browser binary.
 * Scope: Pure runtime-planning helpers only; no subprocess execution or filesystem access lives here.
 * Usage: Imported by the extension entrypoint and unit tests before spawning the upstream CLI.
 * Invariants/Assumptions: The wrapper stays thin, preserves upstream command vocabulary, and only injects `--json` plus an implicit `--session` when appropriate.
 */

import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

const STARTUP_SCOPED_FLAGS = ["--cdp", "--profile", "--session-name"] as const;
const INSPECTION_ALLOW_PATTERNS = [
	/\bagent[_ -]?browser\s+--(?:help|version)\b/i,
	/\bagent[_ -]?browser\b.*\b(?:help|version|docs?|documentation|tool contract|tool guidance|tool description)\b/i,
	/\b(?:help|version|docs?|documentation|tool contract|tool guidance|tool description)\b.*\bagent[_ -]?browser\b/i,
	/\bdebug(?:ging)?\b.*\b(?:agent[_ -]?browser|agent_browser|browser integration)\b/i,
	/\bwhy\s+(?:isn't|is not|doesn't|does not)\b.*\b(?:agent[_ -]?browser|agent_browser)\b/i,
];
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
const IMAGE_EXTENSION_TO_MIME_TYPE: Record<string, string> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};
const MAX_PROJECT_SLUG_LENGTH = 24;

export interface CommandInfo {
	command?: string;
	subcommand?: string;
}

export interface ExecutionPlan {
	commandInfo: CommandInfo;
	effectiveArgs: string[];
	sessionName?: string;
	startupScopedFlags: string[];
	usedImplicitSession: boolean;
	validationError?: string;
}

export interface PromptPolicy {
	allowAgentBrowserInspection: boolean;
	allowLegacyAgentBrowserBash: boolean;
}

export function createEphemeralSessionSeed(): string {
	return randomUUID();
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
	const stableSessionId = sessionId?.replace(/-/g, "").slice(0, 12);
	if (stableSessionId && stableSessionId.length > 0) {
		return `piab-${slug}-${stableSessionId}`;
	}

	const digest = createHash("sha256").update(`ephemeral:${cwd}:${ephemeralSeed}`).digest("hex").slice(0, 12);
	return `piab-${slug}-${digest}`;
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
		allowAgentBrowserInspection: INSPECTION_ALLOW_PATTERNS.some((pattern) => pattern.test(prompt)),
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
	options: { implicitSessionActive: boolean; implicitSessionName: string; useActiveSession: boolean },
): ExecutionPlan {
	const commandInfo = parseCommandInfo(args);
	const explicitSessionName = extractExplicitSessionName(args);
	const startupScopedFlags = getStartupScopedFlags(args);
	const effectiveArgs = args.includes("--json") ? [] : ["--json"];
	let sessionName = explicitSessionName;
	let usedImplicitSession = false;
	let validationError: string | undefined;

	if (!explicitSessionName && options.useActiveSession) {
		if (options.implicitSessionActive && startupScopedFlags.length > 0) {
			validationError = [
				`The current implicit agent-browser session is already running, so startup-scoped flags ${startupScopedFlags.join(", ")} would be ignored by upstream agent-browser.`,
				"Reuse the existing implicit session without those flags, or start a fresh upstream session explicitly with `--session ...` (or `useActiveSession: false`) for a new launch.",
			].join(" ");
		} else {
			effectiveArgs.push("--session", options.implicitSessionName);
			sessionName = options.implicitSessionName;
			usedImplicitSession = true;
		}
	}

	effectiveArgs.push(...args);

	return {
		commandInfo,
		effectiveArgs,
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

export function getImageMimeType(filePath: string): string | undefined {
	const extension = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
	return IMAGE_EXTENSION_TO_MIME_TYPE[extension];
}
