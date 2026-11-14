import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, VALUE_FLAGS } from "../../../argv-grammar.js";
import { isOpenNavigationCommand } from "../../../command-taxonomy.js";
import { getExplicitReadUrl, isBrowserIndependentRead } from "../../../command-policy.js";
import { getAgentBrowserProcessTimeoutMs } from "../../../process.js";
import { getUpstreamEffectiveBatchSteps } from "../../batch-stdin.js";

const POSITIONAL_VALUE_FLAGS = new Set([...VALUE_FLAGS, "--llms"]);

const COMMAND_PROCESS_TIMEOUT_GRACE_MS = 5_000;

function parseMillisecondsToken(token: string | undefined): number | undefined {
	if (token === undefined || !/^\d+$/.test(token)) {
		return undefined;
	}
	const parsed = Number(token);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function supportsCommandTimeout(commandTokens: readonly string[]): boolean {
	const [command, subcommand] = commandTokens;
	return (
		command === "wait" ||
		command === "read" ||
		(command === "flow" && (subcommand === "save" || subcommand === "run")) ||
		(command === "webmcp" && (subcommand === "invoke" || subcommand === "result"))
	);
}

function findCommandTimeoutMs(commandTokens: readonly string[]): number | undefined {
	if (!supportsCommandTimeout(commandTokens)) {
		return undefined;
	}
	const operands = commandTokens.slice(1).values();
	for (const token of operands) {
		if (token === "--timeout") {
			return parseMillisecondsToken(operands.next().value);
		}
		if (token.startsWith("--timeout=")) {
			return parseMillisecondsToken(token.slice("--timeout=".length));
		}
	}
	const firstWaitArgument = commandTokens[0] === "wait" ? commandTokens.at(1) : undefined;
	return firstWaitArgument !== undefined &&
		firstWaitArgument !== "" &&
		!firstWaitArgument.startsWith("-")
		? parseMillisecondsToken(firstWaitArgument)
		: undefined;
}

export function findFirstPositionalArgument(commandTokens: readonly string[]): string | undefined {
	const entries = commandTokens.entries();
	entries.next();
	for (const [index, token] of entries) {
		const [flag = token] = token.split("=", 1);
		if (POSITIONAL_VALUE_FLAGS.has(flag)) {
			if (!token.includes("=")) {
				entries.next();
			}
			continue;
		}
		if (
			GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(flag) &&
			["true", "false"].includes(commandTokens[index + 1] ?? "")
		) {
			entries.next();
			continue;
		}
		if (!token.startsWith("-")) {
			return token;
		}
	}
	return undefined;
}

function readUsesActivePageUrl(commandTokens: readonly string[]): boolean {
	return (
		!isBrowserIndependentRead(commandTokens) &&
		commandTokens.some(
			(token) => token === "--require-md" || token === "--llms" || token.startsWith("--llms="),
		)
	);
}

function readRequestBudget(
	commandTokens: readonly string[],
	activePageUrl: string | undefined,
): number {
	const target = getExplicitReadUrl(commandTokens) ?? activePageUrl;
	if (target === undefined) {
		return 1;
	}
	let url: URL;
	try {
		url = new URL(target.includes("://") ? target : `https://${target}`);
	} catch {
		return 1;
	}
	const ancestorCount = url.pathname.split("/").filter(Boolean).length + 1;
	if (commandTokens.some((token) => token === "--llms" || token.startsWith("--llms="))) {
		return ancestorCount;
	}
	if (commandTokens.includes("--raw")) {
		return 1;
	}
	return ancestorCount + 3;
}

function commandTimeoutBudgetMs(
	commandTokens: readonly string[],
	activePageUrl: string | undefined,
): number | undefined {
	const timeoutMs = findCommandTimeoutMs(commandTokens);
	if (timeoutMs === undefined) {
		return undefined;
	}
	return commandTokens[0] === "read"
		? timeoutMs * readRequestBudget(commandTokens, activePageUrl)
		: timeoutMs;
}

function findCommandTimeoutBudgetMs(
	commandTokens: readonly string[],
	stdin: string | undefined,
	activePageUrl: string | undefined,
): number | undefined {
	const directTimeout = commandTimeoutBudgetMs(commandTokens, activePageUrl);
	if (directTimeout !== undefined) {
		return directTimeout;
	}
	if (commandTokens[0] !== "batch") {
		return undefined;
	}
	let batchTimeoutTotal = 0;
	let batchPageUrl = activePageUrl;
	for (const step of getUpstreamEffectiveBatchSteps(commandTokens, stdin)) {
		batchTimeoutTotal += commandTimeoutBudgetMs(step, batchPageUrl) ?? 0;
		if (isOpenNavigationCommand(step[0])) {
			batchPageUrl = findFirstPositionalArgument(step);
		}
	}
	return batchTimeoutTotal === 0 ? undefined : batchTimeoutTotal;
}

function activeReadNeedsPageUrl(commandTokens: readonly string[]): boolean {
	return (
		commandTokens[0] === "read" &&
		findCommandTimeoutMs(commandTokens) !== undefined &&
		readUsesActivePageUrl(commandTokens)
	);
}

export function commandTimeoutNeedsActivePageUrl(
	commandTokens: readonly string[],
	stdin?: string,
): boolean {
	if (commandTokens[0] === "read") {
		return activeReadNeedsPageUrl(commandTokens);
	}
	if (commandTokens[0] !== "batch") {
		return false;
	}
	let hasKnownPageUrl = false;
	for (const step of getUpstreamEffectiveBatchSteps(commandTokens, stdin)) {
		if (isOpenNavigationCommand(step[0]) && (findFirstPositionalArgument(step) ?? "") !== "") {
			hasKnownPageUrl = true;
		}
		if (!hasKnownPageUrl && activeReadNeedsPageUrl(step)) {
			return true;
		}
	}
	return false;
}

export function getCommandAwareProcessTimeoutMs(
	commandTokens: readonly string[],
	stdin?: string,
	activePageUrl?: string,
): number | undefined {
	const timeoutBudgetMs = findCommandTimeoutBudgetMs(commandTokens, stdin, activePageUrl);
	if (timeoutBudgetMs === undefined) {
		return undefined;
	}
	const neededTimeoutMs = timeoutBudgetMs + COMMAND_PROCESS_TIMEOUT_GRACE_MS;
	const defaultProcessTimeoutMs = getAgentBrowserProcessTimeoutMs();
	return neededTimeoutMs > defaultProcessTimeoutMs ? neededTimeoutMs : undefined;
}
