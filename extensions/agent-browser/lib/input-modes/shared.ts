/**
 * Purpose: Hold tiny shared parsing helpers for structured agent_browser input modes.
 * Responsibilities: Normalize common select values, batch result rows, and workspace scan limits.
 * Scope: Generic input-mode helpers only; mode-specific policy stays in the owning module.
 */

import { isRecord } from "../parsing.js";
import { SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES, SOURCE_LOOKUP_MAX_WORKSPACE_FILES } from "./types.js";

export function getSelectValues(input: Record<string, unknown>, context: string): { values?: string[]; error?: string } {
	const rawValue = input.value;
	const rawValues = input.values;
	if (rawValue !== undefined && rawValues !== undefined) {
		return { error: `${context}.value and ${context}.values cannot both be provided for select.` };
	}
	if (rawValues !== undefined) {
		if (!Array.isArray(rawValues) || rawValues.length === 0 || rawValues.some((value) => typeof value !== "string" || value.trim().length === 0)) {
			return { error: `${context}.values must be a non-empty array of non-empty strings for select.` };
		}
		return { values: rawValues };
	}
	if (typeof rawValue === "string" && rawValue.trim().length > 0) {
		return { values: [rawValue] };
	}
	return { error: `${context}.value or ${context}.values is required for select.` };
}

export function getBatchResultItems(data: unknown): Array<Record<string, unknown>> {
	return Array.isArray(data) ? data.filter(isRecord) : [];
}

export function getCommandNameFromBatchItem(item: Record<string, unknown>): string | undefined {
	const command = item.command;
	return Array.isArray(command) && typeof command[0] === "string" ? command[0] : undefined;
}

export function validateLookupMaxWorkspaceFiles(value: unknown, fieldName: string): { value?: number; error?: string } {
	if (value === undefined) return { value: SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES };
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return { error: `${fieldName} must be a positive integer when provided.` };
	}
	if (value > SOURCE_LOOKUP_MAX_WORKSPACE_FILES) {
		return { error: `${fieldName} must be ${SOURCE_LOOKUP_MAX_WORKSPACE_FILES} or less.` };
	}
	return { value };
}
