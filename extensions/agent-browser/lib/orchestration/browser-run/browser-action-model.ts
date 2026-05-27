/**
 * Purpose: Normalize planned browser argv into a small action model for prompt-derived guards.
 * Responsibilities: Map command tokens and batch stdin steps to click-like and keyboard-submit actions with target labels.
 * Scope: Best-effort finalizing-action detection only; does not model eval, generic fill/type, or non-Enter keyboard flows.
 */

import type { SessionRefSnapshot } from "../../session-page-state.js";
import { parseValidBatchStepEntries } from "../batch-stdin.js";

const FINAL_ACTION_PATTERN = /\b(?:finish|place\s+(?:the\s+)?order|submit\s+(?:the\s+)?order|complete\s+(?:the\s+)?order|confirm\s+(?:the\s+)?order|purchase|buy\s+now|pay\s+now|finali[sz]e|submit\s+payment|checkout\s+complete)\b/i;

const CLICK_LIKE_COMMANDS = new Set(["click", "dblclick", "tap"]);
const FIND_CLICK_ACTIONS = new Set(["click", "dblclick", "tap"]);
const KEYBOARD_SUBMIT_KEYS = new Set(["enter", "return"]);

export type BrowserFinalizingActionKind = "click-like" | "keyboard-submit";

export interface BrowserFinalizingAction {
	command: string[];
	kind: BrowserFinalizingActionKind;
	stepIndex?: number;
	targetLabel?: string;
}

export const STOP_BOUNDARY_GUARD_SCOPE = {
	covered: [
		"standalone click, dblclick, and tap",
		"find … click|dblclick|tap",
		"batch steps with the click-like shapes above",
		"press <key> and key <key> when key is Enter or Return",
	],
	excluded: [
		"eval --stdin and other scripted activation",
		"fill, type, select, drag, and upload without an explicit click-like command",
		"keyboard type/inserttext and keyboard shortcuts other than Enter/Return",
		"semanticAction and job/qa compiled plans unless their batch stdin contains a covered step",
	],
} as const;

function normalizeTargetText(value: string): string {
	return value
		.replace(/[_-]+/g, " ")
		.replace(/[\[\]{}()#.'\"=:/]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function matchesFinalActionLabel(value: string | undefined): boolean {
	return value !== undefined && FINAL_ACTION_PATTERN.test(normalizeTargetText(value));
}

function parseRefId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	const candidate = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed.startsWith("ref=") ? trimmed.slice(4) : trimmed;
	return /^e\d+$/.test(candidate) ? candidate : undefined;
}

function getRefTargetLabel(refSnapshot: SessionRefSnapshot | undefined, refId: string | undefined): string | undefined {
	if (!refId) return undefined;
	const ref = refSnapshot?.refs?.[refId];
	return ref ? [ref.role, ref.name].filter(Boolean).join(" ") : undefined;
}

function getFlagValue(tokens: string[], flag: string): string | undefined {
	for (const [index, token] of tokens.entries()) {
		if (token === flag) return tokens[index + 1];
		if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
	}
	return undefined;
}

function getClickLikeTargetLabel(command: string[], refSnapshot: SessionRefSnapshot | undefined): string | undefined {
	const target = command[1];
	return getRefTargetLabel(refSnapshot, parseRefId(target)) ?? target;
}

function getFindClickTargetLabel(command: string[]): string | undefined {
	if (command[0] !== "find") return undefined;
	const actionIndex = command.findIndex((token, index) => index >= 3 && FIND_CLICK_ACTIONS.has(token));
	if (actionIndex === -1) return undefined;
	return getFlagValue(command, "--name") ?? command[2];
}

function getKeyboardSubmitKey(command: string[]): string | undefined {
	const commandName = command[0];
	if (commandName === "press" || commandName === "key") return command[1];
	return undefined;
}

function collectActionsFromCommand(command: string[], refSnapshot: SessionRefSnapshot | undefined, stepIndex?: number): BrowserFinalizingAction[] {
	const actions: BrowserFinalizingAction[] = [];
	if (CLICK_LIKE_COMMANDS.has(command[0] ?? "")) {
		actions.push({
			command,
			kind: "click-like",
			stepIndex,
			targetLabel: getClickLikeTargetLabel(command, refSnapshot),
		});
		return actions;
	}
	if (command[0] === "find") {
		const actionIndex = command.findIndex((token, index) => index >= 3 && FIND_CLICK_ACTIONS.has(token));
		if (actionIndex !== -1) {
			actions.push({
				command,
				kind: "click-like",
				stepIndex,
				targetLabel: getFindClickTargetLabel(command),
			});
		}
		return actions;
	}
	const submitKey = getKeyboardSubmitKey(command)?.trim().toLowerCase();
	if (submitKey && KEYBOARD_SUBMIT_KEYS.has(submitKey)) {
		actions.push({
			command,
			kind: "keyboard-submit",
			stepIndex,
			targetLabel: submitKey,
		});
	}
	return actions;
}

export function collectBrowserFinalizingActions(options: {
	commandTokens: string[];
	refSnapshot?: SessionRefSnapshot;
	stdin?: string;
}): BrowserFinalizingAction[] {
	const actions = collectActionsFromCommand(options.commandTokens, options.refSnapshot);
	if (options.commandTokens[0] !== "batch") return actions;
	for (const { index, step } of parseValidBatchStepEntries(options.stdin)) {
		actions.push(...collectActionsFromCommand(step, options.refSnapshot, index));
	}
	return actions;
}

export function shouldBlockFinalizingAction(action: BrowserFinalizingAction): boolean {
	if (action.kind === "keyboard-submit") return true;
	return matchesFinalActionLabel(action.targetLabel);
}

export function findBlockedFinalizingAction(options: {
	commandTokens: string[];
	refSnapshot?: SessionRefSnapshot;
	stdin?: string;
}): BrowserFinalizingAction | undefined {
	for (const action of collectBrowserFinalizingActions(options)) {
		if (!shouldBlockFinalizingAction(action)) continue;
		return action;
	}
	return undefined;
}
