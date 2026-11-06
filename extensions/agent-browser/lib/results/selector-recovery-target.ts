export type SelectorRecoveryActionName = "check" | "click" | "fill" | "select" | "uncheck";

export interface SelectorRecoveryCompiledAction {
	readonly action: SelectorRecoveryActionName;
	readonly args: readonly string[];
	readonly locator?: string;
	readonly selector?: string;
	readonly values?: readonly string[];
}

export interface VisibleRefFallbackTarget {
	readonly action: SelectorRecoveryActionName;
	readonly optionValues?: readonly string[];
	readonly roles: readonly string[];
	readonly text?: string | undefined;
	readonly targetName: string;
}

const SELECTOR_RECOVERY_ACTION_NAMES: readonly SelectorRecoveryActionName[] = [
	"check",
	"click",
	"fill",
	"select",
	"uncheck",
];

function isSelectorRecoveryActionName(action: unknown): action is SelectorRecoveryActionName {
	return SELECTOR_RECOVERY_ACTION_NAMES.some((name) => name === action);
}

function getFindNameFlagValue(args: readonly string[], startIndex: number): string | undefined {
	const index = args.indexOf("--name", startIndex);
	const name = index >= 0 ? args.at(index + 1) : undefined;
	return name !== undefined && name.length > 0 ? name : undefined;
}

function collectFindTrailingValues(args: readonly string[], startIndex: number): string[] {
	const values: string[] = [];
	for (const token of args.slice(startIndex)) {
		if (token.length === 0 || token.startsWith("-")) {
			break;
		}
		values.push(token);
	}
	return values;
}

function getSelectTarget(
	args: readonly string[],
	index: number,
	locator: string,
	value: string,
): VisibleRefFallbackTarget | undefined {
	const optionValues = collectFindTrailingValues(args, index + 4);
	if (locator === "role") {
		if (!/^(?:combobox|listbox)$/i.test(value)) {
			return undefined;
		}
		const targetName = getFindNameFlagValue(args, index + 4);
		return targetName !== undefined
			? { action: "select", optionValues, roles: [value.toLowerCase()], targetName }
			: undefined;
	}
	return locator === "label"
		? { action: "select", optionValues, roles: ["combobox", "listbox"], targetName: value }
		: undefined;
}

function getTextTarget(
	action: SelectorRecoveryActionName,
	locator: string,
	targetName: string,
	text: string | undefined,
): VisibleRefFallbackTarget | undefined {
	if (locator === "text" && action === "click") {
		return { action, roles: ["button", "link"], targetName };
	}
	if ((locator === "text" || locator === "placeholder") && action === "fill") {
		return { action, roles: ["searchbox", "textbox"], targetName, text };
	}
	return locator === "label" && action === "fill"
		? { action, roles: ["textbox"], targetName, text }
		: undefined;
}

export function getFindVisibleRefFallbackTarget(
	args: readonly string[],
): VisibleRefFallbackTarget | undefined {
	const index = args[0] === "--session" ? 2 : 0;
	if (args[index] !== "find") {
		return undefined;
	}
	const locator = args.at(index + 1);
	const value = args.at(index + 2);
	const action = args.at(index + 3);
	if (
		locator === undefined ||
		locator.length === 0 ||
		value === undefined ||
		value.length === 0 ||
		!isSelectorRecoveryActionName(action)
	) {
		return undefined;
	}
	return getFindActionTarget(args, { index, locator, value, action });
}

function getFindActionTarget(
	args: readonly string[],
	command: {
		readonly index: number;
		readonly locator: string;
		readonly value: string;
		readonly action: SelectorRecoveryActionName;
	},
): VisibleRefFallbackTarget | undefined {
	const { index, locator, value, action } = command;
	if (action === "select") {
		return getSelectTarget(args, index, locator, value);
	}
	const text = action === "fill" ? args.at(index + 4) : undefined;
	if (action === "fill" && (text === undefined || text.length === 0)) {
		return undefined;
	}
	if (locator === "role") {
		const targetName = getFindNameFlagValue(args, index + 4);
		return targetName !== undefined ? { action, roles: [value], targetName, text } : undefined;
	}
	return getTextTarget(action, locator, value, text);
}
