import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./parsing.js";

const DIRECT_AGENT_BROWSER_BASH_BYPASS_ENV = "PI_AGENT_BROWSER_ALLOW_DIRECT_BASH";
const DIRECT_AGENT_BROWSER_EXECUTABLE_PATTERN = /^(?:[.~]|\.\.?|\/)?(?:[^\s;&|]+\/)?agent-browser$/;
const HARMLESS_AGENT_BROWSER_INSPECTION_PATTERN =
	/^\s*(?:command\s+-v|which|type\s+-P)\s+agent-browser\s*$/;
const PACKAGE_NAME = "pi-agent-browser-native";

type ShellQuoteState = "double" | "single" | undefined;
interface Heredoc {
	readonly delimiter: string;
	readonly stripTabs: boolean;
}

function isShellAssignmentToken(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function stripOuterQuotes(token: string): string {
	if (
		token.length >= 2 &&
		((token.startsWith('"') && token.endsWith('"')) ||
			(token.startsWith("'") && token.endsWith("'")))
	) {
		return token.slice(1, -1);
	}
	return token;
}

function skipAssignments(tokens: readonly string[], start: number): number {
	let index = start;
	for (const [position, token] of tokens.entries()) {
		if (position < start) {
			continue;
		}
		if (!isShellAssignmentToken(token)) {
			break;
		}
		index += 1;
	}
	return index;
}

function skipRunnerOptions(tokens: readonly string[], start: number): number {
	let index = start;
	while (tokens[index]?.startsWith("-") === true) {
		index += 1;
	}
	return index;
}

function separatorWidth(command: string, index: number): number {
	const char = command.charAt(index);
	if (char !== "\n" && char !== "|" && char !== ";" && char !== "&") {
		return 0;
	}
	const operator = command.slice(index, index + 2);
	return operator === "&&" || operator === "||" ? 2 : 1;
}

function segmentLaunchesAgentBrowser(tokens: readonly string[]): boolean {
	let index = skipAssignments(tokens, 0);
	if (index >= tokens.length) {
		return false;
	}
	if (tokens[index] === "env") {
		index = skipAssignments(tokens, index + 1);
	}
	if (tokens[index] === "npx" || tokens[index] === "bunx") {
		index = skipRunnerOptions(tokens, index + 1);
	}
	if (tokens[index] === "pnpm" || tokens[index] === "yarn") {
		if (tokens[index + 1] !== "dlx") {
			return false;
		}
		index = skipRunnerOptions(tokens, index + 2);
	}
	return DIRECT_AGENT_BROWSER_EXECUTABLE_PATTERN.test(tokens[index] ?? "");
}

/** Owns only the best-effort lexical scan, not shell execution or authorization. */
class ShellLaunchScanner {
	private currentToken = "";
	private quoteState: ShellQuoteState;
	private awaitingHeredocDelimiter: { readonly stripTabs: boolean } | undefined;
	private pendingHeredoc: Heredoc | undefined;
	private pendingHeredocLine = "";
	private segmentTokens: string[] = [];

	private flushToken(): void {
		const token = this.currentToken;
		this.currentToken = "";
		if (token.length === 0) {
			return;
		}
		if (this.awaitingHeredocDelimiter) {
			this.pendingHeredoc = {
				delimiter: stripOuterQuotes(token),
				stripTabs: this.awaitingHeredocDelimiter.stripTabs,
			};
			this.awaitingHeredocDelimiter = undefined;
			return;
		}
		this.segmentTokens.push(token);
	}

	private flushSegment(): boolean {
		this.flushToken();
		const launches = segmentLaunchesAgentBrowser(this.segmentTokens);
		this.segmentTokens = [];
		return launches;
	}

	private consumeHeredoc(char: string): boolean {
		const heredoc = this.pendingHeredoc;
		if (!heredoc) {
			return false;
		}
		if (char !== "\n") {
			this.pendingHeredocLine += char;
			return true;
		}
		const candidate = heredoc.stripTabs
			? this.pendingHeredocLine.replace(/^\t+/, "")
			: this.pendingHeredocLine;
		if (candidate === heredoc.delimiter) {
			this.pendingHeredoc = undefined;
		}
		this.pendingHeredocLine = "";
		return true;
	}

	private consumeQuoted(command: string, index: number): number | undefined {
		const char = command.charAt(index);
		if (this.quoteState === undefined) {
			return undefined;
		}
		this.currentToken += char;
		if (this.quoteState === "double" && char === "\\" && index + 1 < command.length) {
			this.currentToken += command.charAt(index + 1);
			return index + 1;
		}
		if (
			(this.quoteState === "single" && char === "'") ||
			(this.quoteState === "double" && char === '"')
		) {
			this.quoteState = undefined;
		}
		return index;
	}

	private consumeTokenCharacter(command: string, index: number): number | undefined {
		const char = command.charAt(index);
		if (char === "'" || char === '"') {
			this.currentToken += char;
			this.quoteState = char === "'" ? "single" : "double";
			return index;
		}
		if (char === "\\" && index + 1 < command.length) {
			this.currentToken += char + command.charAt(index + 1);
			return index + 1;
		}
		if (char !== "\n" && /\s/.test(char)) {
			this.flushToken();
			return index;
		}
		if (command.slice(index, index + 2) === "<<") {
			this.flushToken();
			const stripTabs = command[index + 2] === "-";
			this.awaitingHeredocDelimiter = { stripTabs };
			return index + (stripTabs ? 2 : 1);
		}
		return undefined;
	}

	scan(command: string): boolean {
		for (let index = 0; index < command.length; index += 1) {
			if (this.consumeHeredoc(command.charAt(index))) {
				continue;
			}
			const consumed =
				this.consumeQuoted(command, index) ?? this.consumeTokenCharacter(command, index);
			if (consumed !== undefined) {
				index = consumed;
				continue;
			}
			const width = separatorWidth(command, index);
			if (width > 0) {
				if (this.flushSegment()) {
					return true;
				}
				index += width - 1;
				continue;
			}
			this.currentToken += command.charAt(index);
		}
		return this.flushSegment();
	}
}

// Best-effort detection for common direct launches only. This is an ergonomics guard,
// not a general-purpose bash parser or security boundary.
export function looksLikeDirectAgentBrowserBash(command: string): boolean {
	return new ShellLaunchScanner().scan(command);
}

export function isHarmlessAgentBrowserInspectionCommand(command: string): boolean {
	return HARMLESS_AGENT_BROWSER_INSPECTION_PATTERN.test(command);
}

function isTruthyEnvValue(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

async function isPackageDevelopmentCwd(cwd: string): Promise<boolean> {
	try {
		const packageJson: unknown = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
		return isRecord(packageJson) && packageJson.name === PACKAGE_NAME;
	} catch {
		return false;
	}
}

export async function isDirectAgentBrowserBashAllowed(cwd: string): Promise<boolean> {
	return (
		isTruthyEnvValue(process.env[DIRECT_AGENT_BROWSER_BASH_BYPASS_ENV]) ||
		(await isPackageDevelopmentCwd(cwd))
	);
}
