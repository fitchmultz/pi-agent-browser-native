import { projectUpstreamGlobalFlags } from "../argv-grammar.js";
import { isStringArray } from "../input-modes/shared.js";
import { isRecord } from "../parsing.js";
import type { AgentBrowserEnvelope } from "../results/contracts.js";
import { stringifyUnknown } from "../results/text.js";

export type BatchCommandStep = string[];

export function isNativeBatchOption(token: string): boolean {
	return token === "--bail" || token === "--omit-command";
}

/** Bare open's native launch action drops prior launch options. URL reads lazily launch without navigating. */
export function normalizeUrlLessOpen(
	args: readonly string[],
	stdin?: string,
	batchStep = false,
): { args: readonly string[]; stdin?: string } {
	const { tokens, indices } = batchStep
		? { tokens: args, indices: args.map((_, index) => index) }
		: projectUpstreamGlobalFlags(args);
	if (tokens[0] === "open" && !tokens.slice(1).some((token) => !token.startsWith("--"))) {
		const index = indices[0];
		return { args: [...args.slice(0, index), "get", "url", ...args.slice(index + 1)], stdin };
	}
	if (tokens[0] !== "batch") {
		return { args, stdin };
	}
	if (tokens.slice(1).some((token) => !isNativeBatchOption(token))) {
		return { args: normalizeRawBatchRows(args, tokens, indices), stdin };
	}
	const steps = parseUserBatchStdin(stdin).steps;
	if (steps === undefined || steps.length === 0) {
		return { args, stdin };
	}
	const normalized = steps.map((step) => normalizeUrlLessOpen(step, undefined, true).args);
	return {
		args,
		stdin: normalized.some((step, index) => step !== steps[index])
			? JSON.stringify(normalized)
			: stdin,
	};
}

function normalizeRawBatchRows(
	args: readonly string[],
	tokens: readonly string[],
	indices: readonly number[],
): readonly string[] {
	let normalized: string[] | undefined;
	for (const [offset, token] of tokens.slice(1).entries()) {
		if (isNativeBatchOption(token)) {
			continue;
		}
		const step = parseBatchCommandArgument(token).step;
		if (step === undefined) {
			continue;
		}
		const row = normalizeUrlLessOpen(step, undefined, true).args;
		if (row === step) {
			continue;
		}
		normalized ??= [...args];
		normalized[indices[offset + 1]] = row
			.map((word) => `'${word.replaceAll("'", "'\\''")}'`)
			.join(" ");
	}
	return normalized ?? args;
}

const BATCH_STDIN_EXAMPLE =
	' Example: { "args": ["batch"], "stdin": "[[\\"get\\",\\"title\\"],[\\"get\\",\\"url\\"]]" }';

// Mirrors upstream commands::shell_words_split for policy inspection.
class BatchWords {
	private token = "";
	private readonly tokens: string[] = [];
	private inDoubleQuote = false;
	private inSingleQuote = false;

	private consumeQuote(character: string): boolean {
		if (character === '"' && !this.inSingleQuote) {
			this.inDoubleQuote = !this.inDoubleQuote;
			return true;
		}
		if (character === "'" && !this.inDoubleQuote) {
			this.inSingleQuote = !this.inSingleQuote;
			return true;
		}
		return false;
	}

	private finishWord(): void {
		if (this.token.length > 0) {
			this.tokens.push(this.token);
			this.token = "";
		}
	}

	consume(character: string, next: string | undefined): boolean {
		if (character === "\\" && !this.inSingleQuote) {
			if (next !== undefined) {
				this.token += next;
				return true;
			}
			return false;
		}
		if (this.consumeQuote(character)) {
			return false;
		}
		if (character === " " && !this.inDoubleQuote && !this.inSingleQuote) {
			this.finishWord();
		} else {
			this.token += character;
		}
		return false;
	}

	finish(): { error?: string; step?: BatchCommandStep } {
		this.finishWord();
		return this.tokens.length > 0 ? { step: this.tokens } : { error: "batch command is empty" };
	}
}

export function parseBatchCommandArgument(command: string): {
	error?: string;
	step?: BatchCommandStep;
} {
	const words = new BatchWords();
	for (let index = 0; index < command.length; index++) {
		if (words.consume(command[index], command.at(index + 1))) {
			index++;
		}
	}
	return words.finish();
}

function validateUserBatchStep(
	step: unknown,
	index: number,
): { error: string; ok: false } | { ok: true; step: BatchCommandStep } {
	if (!Array.isArray(step)) {
		return {
			error: `agent_browser batch stdin step ${index} must be an array of string command tokens.${BATCH_STDIN_EXAMPLE}`,
			ok: false,
		};
	}
	if (!isStringArray(step)) {
		const invalidTokenIndex = step.findIndex((token) => typeof token !== "string");
		return {
			error: `agent_browser batch stdin step ${index} token ${invalidTokenIndex} must be a string.${BATCH_STDIN_EXAMPLE}`,
			ok: false,
		};
	}
	return { ok: true, step };
}

export function parseBatchStdinJsonArray(stdin: string | undefined): {
	error?: string;
	steps?: unknown[];
} {
	if (stdin === undefined) {
		return { steps: [] };
	}
	try {
		const parsed: unknown = JSON.parse(stdin);
		if (!Array.isArray(parsed)) {
			return {
				error: `agent_browser batch stdin must be a JSON array of command steps.${BATCH_STDIN_EXAMPLE}`,
			};
		}
		return { steps: parsed };
	} catch (error) {
		const message = error instanceof Error ? error.message : stringifyUnknown(error);
		return {
			error: `agent_browser batch stdin could not be parsed as JSON: ${message}.${BATCH_STDIN_EXAMPLE}`,
		};
	}
}

export function parseUserBatchStdin(stdin: string | undefined): {
	error?: string;
	steps?: BatchCommandStep[];
} {
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error !== undefined || parsed.steps === undefined) {
		return parsed.error !== undefined ? { error: parsed.error } : { steps: [] };
	}
	const steps: BatchCommandStep[] = [];
	for (const [index, rawStep] of parsed.steps.entries()) {
		const validated = validateUserBatchStep(rawStep, index);
		if (!validated.ok) {
			return { error: validated.error };
		}
		steps.push(validated.step);
	}
	return { steps };
}

/**
 * The batch steps upstream will actually execute: run_batch uses raw batch
 * arguments exclusively when any exist and reads stdin only otherwise.
 * Upstream filters only exact `--bail` and `--omit-command` tokens, so an equals form such as
 * `--bail=true` stays a raw command (an unknown-command row) and keeps stdin
 * ignored.
 */
export function getUpstreamEffectiveBatchSteps(
	commandTokens: readonly string[],
	stdin: string | undefined,
): BatchCommandStep[] {
	return getUpstreamBatchInputSteps(commandTokens, stdin).filter((step) => step.length > 0);
}

function getUpstreamBatchInputSteps(
	commandTokens: readonly string[],
	stdin: string | undefined,
): BatchCommandStep[] {
	if (commandTokens[0] !== "batch") {
		return [];
	}
	const argumentSteps = commandTokens.slice(1).flatMap((command) => {
		if (isNativeBatchOption(command)) {
			return [];
		}
		const step = parseBatchCommandArgument(command).step;
		return step ? [step] : [];
	});
	if (commandTokens.slice(1).some((token) => !isNativeBatchOption(token))) {
		return argumentSteps;
	}
	return parseUserBatchStdin(stdin).steps ?? [];
}

/** Restore native indexed receipts before command-specific effects and redaction, not from row order. */
export function resolveIndexedBatchCommands(
	envelope: AgentBrowserEnvelope | undefined,
	commandTokens: readonly string[],
	stdin?: string,
): AgentBrowserEnvelope | undefined {
	if (
		commandTokens[0] !== "batch" ||
		!commandTokens.slice(1).includes("--omit-command") ||
		!Array.isArray(envelope?.data) ||
		!envelope.data.some(
			(row: unknown) => isRecord(row) && row.command === undefined && row.index !== undefined,
		)
	) {
		return envelope;
	}
	// Native indexes retain skipped empty stdin rows, unlike the effective dispatched-command list.
	const steps = getUpstreamBatchInputSteps(commandTokens, stdin);
	const data = envelope.data.map((row: unknown) => {
		if (
			!isRecord(row) ||
			row.command !== undefined ||
			typeof row.index !== "number" ||
			!Number.isSafeInteger(row.index) ||
			row.index < 0
		) {
			return row;
		}
		const command = steps.at(row.index);
		return command !== undefined && command.length > 0 ? { ...row, command } : row;
	});
	return { ...envelope, data };
}
