import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import {
	extractStringResultField,
	type SessionRefSnapshot,
} from "../../session-page-observation.js";
import { getGuardedRefUsage, runSessionCommandData } from "./session-state.js";
import {
	commandTimeoutNeedsActivePageUrl,
	getCommandAwareProcessTimeoutMs,
} from "./prepare/wait-timeouts.js";
import type { PreparationProcessFacts } from "./prepare-contracts.js";

const DIALOG_TRIGGER_TEXT_PATTERN = /\b(?:alert|confirm|dialog|prompt)\b/i;

function getPositiveIntegerEnv(name: string): number | undefined {
	const value = getAgentBrowserProcessEnvironment()[name];
	if (value === undefined || value === "" || !/^\d+$/.test(value.trim())) {
		return undefined;
	}
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function commandTextLooksLikeDialogTrigger(
	commandTokens: readonly string[],
	refSnapshot?: SessionRefSnapshot,
): boolean {
	if (commandTokens.some((token) => DIALOG_TRIGGER_TEXT_PATTERN.test(token))) {
		return true;
	}
	for (const refId of new Set(getGuardedRefUsage(commandTokens))) {
		const ref = refSnapshot?.refs?.[refId];
		if (ref && DIALOG_TRIGGER_TEXT_PATTERN.test(`${ref.role} ${ref.name}`)) {
			return true;
		}
	}
	return false;
}

function likelyDialogTrigger(
	commandTokens: readonly string[],
	refSnapshot?: SessionRefSnapshot,
	stdin?: string,
): boolean {
	const command = commandTokens[0];
	if (command === "eval" && typeof stdin === "string" && DIALOG_TRIGGER_TEXT_PATTERN.test(stdin)) {
		return true;
	}
	const clickable =
		command === "click" ||
		command === "tap" ||
		(command === "find" && commandTokens.includes("click"));
	return clickable && commandTextLooksLikeDialogTrigger(commandTokens, refSnapshot);
}

function getDialogAwareProcessTimeoutMs(
	commandTokens: readonly string[],
	refSnapshot?: SessionRefSnapshot,
	stdin?: string,
): number | undefined {
	if (commandTokens[0] === "dialog") {
		return getPositiveIntegerEnv("PI_AGENT_BROWSER_DIALOG_PROCESS_TIMEOUT_MS") ?? 5000;
	}
	if (likelyDialogTrigger(commandTokens, refSnapshot, stdin)) {
		return getPositiveIntegerEnv("PI_AGENT_BROWSER_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS") ?? 8000;
	}
	return undefined;
}

export async function prepareProcessTimeout(
	process: PreparationProcessFacts,
	request: {
		readonly commandTokens: readonly string[];
		readonly namespace?: string;
		readonly sessionName?: string;
		readonly stdin?: string;
		readonly pageUrl?: string;
		readonly refSnapshot?: SessionRefSnapshot;
	},
): Promise<number | undefined> {
	let pageUrl = request.pageUrl;
	if (
		process.timeoutMs === undefined &&
		pageUrl === undefined &&
		request.sessionName !== undefined &&
		request.sessionName !== "" &&
		commandTimeoutNeedsActivePageUrl(request.commandTokens, request.stdin)
	) {
		try {
			const data = await runSessionCommandData({
				args: ["get", "url"],
				cwd: process.cwd,
				namespace: request.namespace,
				sessionName: request.sessionName,
				signal: process.signal,
			});
			pageUrl = extractStringResultField(data, "result") ?? extractStringResultField(data, "url");
		} catch {
			// Timeout selection is advisory; failed URL inspection retains native defaults.
		}
	}
	return (
		process.timeoutMs ??
		getDialogAwareProcessTimeoutMs(request.commandTokens, request.refSnapshot, request.stdin) ??
		getCommandAwareProcessTimeoutMs(request.commandTokens, request.stdin, pageUrl)
	);
}
