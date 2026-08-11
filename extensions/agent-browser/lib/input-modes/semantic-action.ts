import { isRecord } from "../parsing.js";
import { getSelectValues } from "./shared.js";
import {
	AGENT_BROWSER_SEMANTIC_ACTIONS,
	AGENT_BROWSER_SEMANTIC_LOCATORS,
	type AgentBrowserSemanticActionName,
	type AgentBrowserSemanticLocator,
	type CompiledAgentBrowserSemanticAction,
} from "./types.js";

export function getCompiledSemanticActionCommandIndex(compiled: CompiledAgentBrowserSemanticAction): number {
	return compiled.args[0] === "--session" ? 2 : 0;
}

export function getCompiledSemanticActionSessionPrefix(compiled: CompiledAgentBrowserSemanticAction): string[] {
	const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
	return commandIndex > 0 ? compiled.args.slice(0, commandIndex) : [];
}

export function isCompiledSemanticActionFindCommand(compiled: CompiledAgentBrowserSemanticAction | undefined): boolean {
	if (!compiled || compiled.action === "select") return false;
	return compiled.args[getCompiledSemanticActionCommandIndex(compiled)] === "find";
}

export function compileAgentBrowserSemanticAction(input: unknown): { compiled?: CompiledAgentBrowserSemanticAction; error?: string } {
	if (!isRecord(input)) {
		return { error: "semanticAction must be an object." };
	}
	const action = input.action;
	const locator = input.locator;
	const value = input.value;
	const values = input.values;
	const selector = input.selector;
	const text = input.text;
	const role = input.role;
	const name = typeof input.name === "string" && input.name.trim().length === 0 ? undefined : input.name;
	const session = input.session;
	if (typeof action !== "string" || !AGENT_BROWSER_SEMANTIC_ACTIONS.includes(action as AgentBrowserSemanticActionName)) {
		return { error: `semanticAction.action must be one of: ${AGENT_BROWSER_SEMANTIC_ACTIONS.join(", ")}.` };
	}
	if (session !== undefined && (typeof session !== "string" || session.trim().length === 0)) {
		return { error: "semanticAction.session must be a non-empty string when provided." };
	}
	if (action === "select") {
		if (text !== undefined) {
			return { error: "semanticAction.text is not supported for select; use value or values for option values." };
		}
		if (typeof selector === "string" && selector.trim().length > 0) {
			if (locator !== undefined || role !== undefined || name !== undefined) {
				return { error: "semanticAction.selector cannot be combined with locator, role, or name for select; use selector plus value/values, or locator fields plus values." };
			}
			const selectedValues = getSelectValues(input, "semanticAction");
			if (selectedValues.error) return { error: selectedValues.error };
			const args = typeof session === "string" ? ["--session", session, "select", selector, ...(selectedValues.values as string[])] : ["select", selector, ...(selectedValues.values as string[])];
			return { compiled: { action: "select", selector, values: selectedValues.values, args } };
		}
		if (selector !== undefined) {
			return { error: "semanticAction.selector must be a non-empty string when provided." };
		}
		if (locator === undefined) {
			return { error: "semanticAction.selector or semanticAction.locator is required for select." };
		}
		if (locator !== "role" && locator !== "label") {
			return { error: "semanticAction select locator must be role or label; use selector plus value/values for other targets." };
		}
		if (locator === "role") {
			if (typeof role !== "string" || !/^(?:combobox|listbox)$/i.test(role)) {
				return { error: "semanticAction.role must be combobox or listbox for locator=role select." };
			}
			if (typeof name !== "string" || name.trim().length === 0) {
				return { error: "semanticAction.name is required for locator=role select." };
			}
			const optionValues = getSelectValues({ value, values }, "semanticAction");
			if (optionValues.error) return { error: optionValues.error };
			const args = typeof session === "string"
				? ["--session", session, "find", "role", role, "select", ...(optionValues.values as string[]), "--name", name]
				: ["find", "role", role, "select", ...(optionValues.values as string[]), "--name", name];
			return { compiled: { action: "select", locator: "role", values: optionValues.values, args } };
		}
		if (typeof value !== "string" || value.trim().length === 0) {
			return { error: "semanticAction.value must be the accessible label text for locator=label select." };
		}
		if (role !== undefined || name !== undefined) {
			return { error: "semanticAction.role and name are only supported for locator=role select." };
		}
		const optionValues = getSelectValues({ values }, "semanticAction");
		if (optionValues.error) {
			return { error: optionValues.error.includes("required")
				? "semanticAction.values is required for locator=label select (value is the label text)."
				: optionValues.error };
		}
		const args = typeof session === "string"
			? ["--session", session, "find", "label", value, "select", ...(optionValues.values as string[])]
			: ["find", "label", value, "select", ...(optionValues.values as string[])];
		return { compiled: { action: "select", locator: "label", values: optionValues.values, args } };
	}
	if (values !== undefined) {
		return { error: "semanticAction.values is only supported for select actions." };
	}
	if (selector !== undefined) {
		if (typeof selector !== "string" || selector.trim().length === 0) {
			return { error: "semanticAction.selector must be a non-empty string when provided." };
		}
		if (locator !== undefined || value !== undefined || role !== undefined || name !== undefined) {
			return { error: "semanticAction.selector cannot be combined with locator, value, role, or name; use selector for a direct click/check/fill target or locator fields for find-based actions." };
		}
		if (text !== undefined && typeof text !== "string") {
			return { error: "semanticAction.text must be a string when provided." };
		}
		if (action === "fill" && (typeof text !== "string" || text.length === 0)) {
			return { error: `semanticAction.text is required for ${action}.` };
		}
		if (action !== "fill" && text !== undefined) {
			return { error: "semanticAction.text is only supported for fill actions." };
		}
		const directArgs = typeof session === "string" ? ["--session", session, action, selector] : [action, selector];
		if (action === "fill") directArgs.push(text as string);
		return { compiled: { action: action as AgentBrowserSemanticActionName, selector, args: directArgs } };
	}
	if (typeof locator !== "string" || !AGENT_BROWSER_SEMANTIC_LOCATORS.includes(locator as AgentBrowserSemanticLocator)) {
		return { error: `semanticAction.locator must be one of: ${AGENT_BROWSER_SEMANTIC_LOCATORS.join(", ")}.` };
	}
	if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
		return { error: "semanticAction.value must be a non-empty string when provided." };
	}
	if (role !== undefined && (typeof role !== "string" || role.trim().length === 0)) {
		return { error: "semanticAction.role must be a non-empty string when provided." };
	}
	const locatorValue = locator === "role" && typeof role === "string" ? role : value;
	if (typeof locatorValue !== "string" || locatorValue.trim().length === 0) {
		return { error: locator === "role" ? "semanticAction.value or semanticAction.role must be a non-empty string for locator=role." : "semanticAction.value must be a non-empty string." };
	}
	if (text !== undefined && typeof text !== "string") {
		return { error: "semanticAction.text must be a string when provided." };
	}
	if (action === "fill" && (typeof text !== "string" || text.length === 0)) {
		return { error: `semanticAction.text is required for ${action}.` };
	}
	if (action !== "fill" && text !== undefined) {
		return { error: "semanticAction.text is only supported for fill actions." };
	}
	if (role !== undefined && locator !== "role") {
		return { error: "semanticAction.role is only supported for locator=role." };
	}
	if (role !== undefined && value !== undefined && role !== value) {
		return { error: "semanticAction.role must match value when both are provided for locator=role." };
	}
	if (name !== undefined && (locator !== "role" || typeof name !== "string" || name.length === 0)) {
		return { error: "semanticAction.name is only supported as a non-empty string for locator=role." };
	}
	const args = typeof session === "string" ? ["--session", session, "find", locator, locatorValue, action] : ["find", locator, locatorValue, action];
	if (action === "fill") {
		args.push(text as string);
	}
	if (locator === "role" && typeof name === "string") {
		args.push("--name", name);
	}
	return { compiled: { action: action as AgentBrowserSemanticActionName, locator: locator as AgentBrowserSemanticLocator, args } };
}
