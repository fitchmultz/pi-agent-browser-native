/**
 * Purpose: Detect upstream guarded-action confirmation-needed result shapes without creating wrapper-owned confirmation state.
 * Responsibilities: Recognize confirmation-required markers, extract the pending upstream confirmation id, and optionally surface a short upstream action label.
 * Scope: Pure result-shape detection shared by presentation and error derivation; command execution, approval state, and redaction stay in their existing modules.
 * Usage: Imported by result presentation to render recovery commands and by envelope error handling to avoid hiding actionable confirmation payloads behind generic failure text.
 * Invariants/Assumptions: Detection must be conservative: a confirmation marker and a non-empty upstream id are both required before a result is treated as actionable.
 */

import { isRecord } from "../parsing.js";

export interface ConfirmationRequiredPresentation {
	id: string;
	actionText?: string;
}

const CONFIRMATION_REQUIRED_FIELD_NAMES = [
	"confirmation_required",
	"confirmationRequired",
	"requires_confirmation",
	"requiresConfirmation",
] as const;
const CONFIRMATION_REQUIRED_RECORD_FIELD_NAMES = ["confirmation", "pendingConfirmation", "pending_confirmation"] as const;
const CONFIRMATION_ID_FIELD_NAMES = ["confirmation_id", "confirmationId", "id"] as const;
const CONFIRMATION_ACTION_TEXT_FIELD_NAMES = ["action", "description", "message", "summary"] as const;
const CONFIRMATION_REQUIRED_MARKER = "confirmation_required";

function getTrimmedStringField(data: Record<string, unknown>, fieldNames: readonly string[]): string | undefined {
	for (const fieldName of fieldNames) {
		const value = data[fieldName];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function hasConfirmationRequiredMarker(data: Record<string, unknown>): boolean {
	return CONFIRMATION_REQUIRED_FIELD_NAMES.some((fieldName) => data[fieldName] === true)
		|| data.type === CONFIRMATION_REQUIRED_MARKER
		|| data.status === CONFIRMATION_REQUIRED_MARKER
		|| data.kind === CONFIRMATION_REQUIRED_MARKER;
}

function getNestedConfirmationRecord(data: Record<string, unknown>): Record<string, unknown> | undefined {
	for (const fieldName of CONFIRMATION_REQUIRED_RECORD_FIELD_NAMES) {
		const value = data[fieldName];
		if (isRecord(value)) {
			return value;
		}
	}
	return undefined;
}

export function detectConfirmationRequired(data: unknown): ConfirmationRequiredPresentation | undefined {
	if (!isRecord(data)) {
		return undefined;
	}

	const nestedRecord = getNestedConfirmationRecord(data);
	const candidateRecords = nestedRecord ? [data, nestedRecord] : [data];
	if (!candidateRecords.some(hasConfirmationRequiredMarker)) {
		return undefined;
	}

	for (const record of candidateRecords) {
		const id = getTrimmedStringField(record, CONFIRMATION_ID_FIELD_NAMES);
		if (!id) {
			continue;
		}
		return {
			actionText: getTrimmedStringField(record, CONFIRMATION_ACTION_TEXT_FIELD_NAMES),
			id,
		};
	}
	return undefined;
}
