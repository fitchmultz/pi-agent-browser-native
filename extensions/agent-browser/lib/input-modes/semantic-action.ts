/**
 * Purpose: Compile semanticAction shorthand inputs into upstream agent-browser commands.
 * Responsibilities: Validate shorthand locator/action fields and expose compiled-command helpers.
 * Scope: semanticAction mode only.
 */

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
	if (!compiled) return false;
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
	const name = input.name;
	const session = input.session;
	if (typeof action !== "string" || !AGENT_BROWSER_SEMANTIC_ACTIONS.includes(action as AgentBrowserSemanticActionName)) {
		return { error: `semanticAction.action must be one of: ${AGENT_BROWSER_SEMANTIC_ACTIONS.join(", ")}.` };
	}
	if (session !== undefined && (typeof session !== "string" || session.trim().length === 0)) {
		return { error: "semanticAction.session must be a non-empty string when provided." };
	}
	if (action === "select") {
		if (locator !== undefined || role !== undefined || name !== undefined) {
			return { error: "semanticAction.locator, role, and name are not supported for select; use selector plus value or values." };
		}
		if (text !== undefined) {
			return { error: "semanticAction.text is not supported for select; use value or values for option values." };
		}
		if (typeof selector !== "string" || selector.trim().length === 0) {
			return { error: "semanticAction.selector is required for select." };
		}
		const selectedValues = getSelectValues(input, "semanticAction");
		if (selectedValues.error) return { error: selectedValues.error };
		const args = typeof session === "string" ? ["--session", session, "select", selector, ...(selectedValues.values as string[])] : ["select", selector, ...(selectedValues.values as string[])];
		return { compiled: { action: "select", selector, values: selectedValues.values, args } };
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
