import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, VALUE_FLAGS } from "../../../argv-grammar.js";
import { isOpenNavigationCommand } from "../../../command-taxonomy.js";
import { getAgentBrowserProcessTimeoutMs } from "../../../process.js";
import { parseValidBatchStepEntries } from "../../batch-stdin.js";

const POSITIONAL_VALUE_FLAGS = new Set([...VALUE_FLAGS, "--llms"]);

const COMMAND_PROCESS_TIMEOUT_GRACE_MS = 5_000;

function parseMillisecondsToken(token: string | undefined): number | undefined {
	if (token === undefined || !/^\d+$/.test(token)) {
		return undefined;
	}
	const parsed = Number(token);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function findCommandTimeoutMs(commandTokens: string[]): number | undefined {
	if (commandTokens[0] !== "wait" && commandTokens[0] !== "read") return undefined;
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--timeout") return parseMillisecondsToken(commandTokens[index + 1]);
		if (token.startsWith("--timeout=")) return parseMillisecondsToken(token.slice("--timeout=".length));
	}
	const firstWaitArgument = commandTokens[0] === "wait" ? commandTokens[1] : undefined;
	return firstWaitArgument && !firstWaitArgument.startsWith("-") ? parseMillisecondsToken(firstWaitArgument) : undefined;
}

function findFirstPositionalArgument(commandTokens: string[]): string | undefined {
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		const flag = token.split("=", 1)[0];
		if (POSITIONAL_VALUE_FLAGS.has(flag)) {
			if (!token.includes("=")) index += 1;
			continue;
		}
		if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(flag) && ["true", "false"].includes(commandTokens[index + 1] ?? "")) {
			index += 1;
			continue;
		}
		if (!token.startsWith("-")) return token;
	}
	return undefined;
}

function readUsesActivePageUrl(commandTokens: string[]): boolean {
	return findFirstPositionalArgument(commandTokens) === undefined && commandTokens.some((token) => token === "--require-md" || token === "--llms" || token.startsWith("--llms="));
}

function readRequestBudget(commandTokens: string[], activePageUrl: string | undefined): number {
	const target = findFirstPositionalArgument(commandTokens) ?? activePageUrl;
	if (target === undefined) return 1;
	let url: URL;
	try {
		url = new URL(target.includes("://") ? target : `https://${target}`);
	} catch {
		return 1;
	}
	const ancestorCount = url.pathname.split("/").filter(Boolean).length + 1;
	if (commandTokens.some((token) => token === "--llms" || token.startsWith("--llms="))) return ancestorCount;
	if (commandTokens.includes("--raw")) return 1;
	return ancestorCount + 3;
}

function commandTimeoutBudgetMs(commandTokens: string[], activePageUrl: string | undefined): number | undefined {
	const timeoutMs = findCommandTimeoutMs(commandTokens);
	if (timeoutMs === undefined) return undefined;
	return commandTokens[0] === "read" ? timeoutMs * readRequestBudget(commandTokens, activePageUrl) : timeoutMs;
}

function findCommandTimeoutBudgetMs(commandTokens: string[], stdin: string | undefined, activePageUrl: string | undefined): number | undefined {
	const directTimeout = commandTimeoutBudgetMs(commandTokens, activePageUrl);
	if (directTimeout !== undefined) return directTimeout;
	if (commandTokens[0] !== "batch" || stdin === undefined) return undefined;
	let batchTimeoutTotal = 0;
	let batchPageUrl = activePageUrl;
	for (const { step } of parseValidBatchStepEntries(stdin)) {
		batchTimeoutTotal += commandTimeoutBudgetMs(step, batchPageUrl) ?? 0;
		if (isOpenNavigationCommand(step[0])) batchPageUrl = findFirstPositionalArgument(step);
	}
	return batchTimeoutTotal === 0 ? undefined : batchTimeoutTotal;
}

export function commandTimeoutNeedsActivePageUrl(commandTokens: string[], stdin: string | undefined): boolean {
	if (commandTokens[0] === "read") return findCommandTimeoutMs(commandTokens) !== undefined && readUsesActivePageUrl(commandTokens);
	if (commandTokens[0] !== "batch" || stdin === undefined) return false;
	let hasKnownPageUrl = false;
	for (const { step } of parseValidBatchStepEntries(stdin)) {
		if (isOpenNavigationCommand(step[0]) && findFirstPositionalArgument(step)) hasKnownPageUrl = true;
		if (!hasKnownPageUrl && findCommandTimeoutMs(step) !== undefined && step[0] === "read" && readUsesActivePageUrl(step)) return true;
	}
	return false;
}

export function getCommandAwareProcessTimeoutMs(commandTokens: string[], stdin: string | undefined, activePageUrl?: string): number | undefined {
	const timeoutBudgetMs = findCommandTimeoutBudgetMs(commandTokens, stdin, activePageUrl);
	if (timeoutBudgetMs === undefined) return undefined;
	const neededTimeoutMs = timeoutBudgetMs + COMMAND_PROCESS_TIMEOUT_GRACE_MS;
	const defaultProcessTimeoutMs = getAgentBrowserProcessTimeoutMs();
	return neededTimeoutMs > defaultProcessTimeoutMs ? neededTimeoutMs : undefined;
}
