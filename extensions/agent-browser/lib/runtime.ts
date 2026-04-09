/**
 * Purpose: Build safe, deterministic agent-browser invocations for the pi-agent-browser extension.
 * Responsibilities: Validate raw tool arguments, derive implicit session names from the pi session identity, detect explicit session usage, and build the effective CLI argument list passed to the upstream agent-browser binary.
 * Scope: Pure runtime-planning helpers only; no subprocess execution or filesystem access lives here.
 * Usage: Imported by the extension entrypoint and unit tests before spawning the upstream CLI.
 * Invariants/Assumptions: The wrapper stays thin, preserves upstream command vocabulary, and only injects `--json` plus an implicit `--session` when appropriate.
 */

import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

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
	usedImplicitSession: boolean;
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

export function buildExecutionPlan(
	args: string[],
	options: { implicitSessionName: string; useActiveSession: boolean },
): ExecutionPlan {
	const explicitSessionName = extractExplicitSessionName(args);
	const effectiveArgs = args.includes("--json") ? [] : ["--json"];
	let sessionName = explicitSessionName;
	let usedImplicitSession = false;

	if (!explicitSessionName && options.useActiveSession) {
		effectiveArgs.push("--session", options.implicitSessionName);
		sessionName = options.implicitSessionName;
		usedImplicitSession = true;
	}

	effectiveArgs.push(...args);

	return {
		commandInfo: parseCommandInfo(args),
		effectiveArgs,
		sessionName,
		usedImplicitSession,
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
			if (GLOBAL_FLAGS_WITH_VALUES.has(token)) {
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
