import { getAgentBrowserProcessTimeoutMs } from "../../../process.js";
import { parseValidBatchStepEntries } from "../../batch-stdin.js";

const WAIT_PROCESS_TIMEOUT_GRACE_MS = 5_000;

function parseMillisecondsToken(token: string | undefined): number | undefined {
	if (token === undefined || !/^\d+$/.test(token)) {
		return undefined;
	}
	const parsed = Number(token);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function findWaitTimeoutMs(commandTokens: string[]): number | undefined {
	if (commandTokens[0] !== "wait") {
		return undefined;
	}
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--timeout") {
			return parseMillisecondsToken(commandTokens[index + 1]);
		}
		if (token.startsWith("--timeout=")) {
			return parseMillisecondsToken(token.slice("--timeout=".length));
		}
	}
	const firstWaitArgument = commandTokens[1];
	if (firstWaitArgument && !firstWaitArgument.startsWith("-")) {
		return parseMillisecondsToken(firstWaitArgument);
	}
	return undefined;
}

function findWaitTimeoutBudgetMs(commandTokens: string[], stdin: string | undefined): number | undefined {
	const directWaitTimeout = findWaitTimeoutMs(commandTokens);
	if (directWaitTimeout !== undefined) {
		return directWaitTimeout;
	}
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return undefined;
	}
	let batchWaitTimeoutTotal = 0;
	for (const { step } of parseValidBatchStepEntries(stdin)) {
		const waitTimeout = findWaitTimeoutMs(step);
		if (waitTimeout !== undefined) {
			batchWaitTimeoutTotal += waitTimeout;
		}
	}
	return batchWaitTimeoutTotal === 0 ? undefined : batchWaitTimeoutTotal;
}

export function getWaitAwareProcessTimeoutMs(commandTokens: string[], stdin: string | undefined): number | undefined {
	const waitTimeoutBudgetMs = findWaitTimeoutBudgetMs(commandTokens, stdin);
	if (waitTimeoutBudgetMs === undefined) return undefined;
	const neededTimeoutMs = waitTimeoutBudgetMs + WAIT_PROCESS_TIMEOUT_GRACE_MS;
	const defaultProcessTimeoutMs = getAgentBrowserProcessTimeoutMs();
	return neededTimeoutMs > defaultProcessTimeoutMs ? neededTimeoutMs : undefined;
}
