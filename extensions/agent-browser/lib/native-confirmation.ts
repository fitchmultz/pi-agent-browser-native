import { getExplicitNavigationTarget } from "./page-target-navigation.js";
import { isRecord } from "./parsing.js";
import type { ReadConfirmation } from "./results/evidence-contracts.js";

function isNonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function confirmationIdentity(
	value: Readonly<Record<string, unknown>>,
): { id: string; sessionName: string; namespace?: string | undefined } | undefined {
	if (
		!isNonemptyString(value.id) ||
		!isNonemptyString(value.sessionName) ||
		(value.namespace !== undefined && typeof value.namespace !== "string")
	) {
		return undefined;
	}
	return { id: value.id, sessionName: value.sessionName, namespace: value.namespace };
}

function guardedProvenance(
	value: Readonly<Record<string, unknown>>,
): { command: string; action: string; refSnapshotFresh?: true } | undefined {
	if (!isNonemptyString(value.command) || !isNonemptyString(value.action)) {
		return undefined;
	}
	const fresh =
		value.state === "cleared" &&
		value.command === "snapshot" &&
		value.action === "snapshot" &&
		value.refSnapshotFresh === true;
	return {
		command: value.command,
		action: value.action,
		...(fresh ? { refSnapshotFresh: true } : {}),
	};
}

function explicitReadCapabilities(value: unknown): ReadConfirmation["capabilities"] {
	return isRecord(value) && value.readRequiresConfirmation === true
		? { readRequiresConfirmation: true }
		: undefined;
}

export function parseReadConfirmation(value: unknown): ReadConfirmation | undefined {
	if (
		!isRecord(value) ||
		(value.source !== "native-explicit-url-read" && value.source !== "native-guarded-action") ||
		(value.state !== "pending" && value.state !== "cleared")
	) {
		return undefined;
	}
	const identity = confirmationIdentity(value);
	if (identity === undefined) {
		return undefined;
	}
	if (value.source === "native-explicit-url-read") {
		const capabilities = explicitReadCapabilities(value.capabilities);
		return {
			...identity,
			source: value.source,
			state: value.state,
			...(capabilities !== undefined ? { capabilities } : {}),
		};
	}
	const provenance = guardedProvenance(value);
	return provenance === undefined
		? undefined
		: { ...identity, ...provenance, source: value.source, state: value.state };
}

export interface NativePendingConfirmation {
	readonly id: string;
	readonly action: string;
	readonly capabilities?: ReadConfirmation["capabilities"];
}

function parsePendingControl(value: unknown): NativePendingConfirmation | undefined {
	if (
		!isRecord(value) ||
		value.confirmation_required !== true ||
		!isNonemptyString(value.confirmation_id) ||
		!isNonemptyString(value.action)
	) {
		return undefined;
	}
	return {
		id: value.confirmation_id,
		action: value.action,
		capabilities: explicitReadCapabilities(value.capabilities),
	};
}

const TAB_TRANSPORT_KEYS = new Set([
	"confirmation_required",
	"confirmation_id",
	"action",
	"capabilities",
	"after_confirmation",
	"guidance",
]);

function matchesTabContinuation(after: unknown, commandTokens: readonly string[]): boolean {
	return (
		Array.isArray(after) &&
		after.length === 2 &&
		after[0] === "open" &&
		isNonemptyString(after[1]) &&
		after[1] === getExplicitNavigationTarget(commandTokens)
	);
}

export function getNativeTabContinuationGuidance(
	commandTokens: readonly string[],
	data: unknown,
): string | undefined {
	if (commandTokens[0] !== "tab" || commandTokens[1] !== "new" || !isRecord(data)) {
		return undefined;
	}
	const pending = parsePendingControl(data);
	if (
		pending?.action !== "tab_new" ||
		!Object.keys(data).every((key) => TAB_TRANSPORT_KEYS.has(key))
	) {
		return undefined;
	}
	if (!matchesTabContinuation(data.after_confirmation, commandTokens)) {
		return undefined;
	}
	// Transport prose only: approval creates the tab; the continuation is never stored or executed.
	return typeof data.guidance === "string" && data.guidance.trim().length > 0
		? data.guidance
		: undefined;
}

export function getNativePendingControl(
	commandTokens: readonly string[],
	data: unknown,
): NativePendingConfirmation | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	// Only native control fields and validated tab transport. Page output is never provenance.
	const controlKeys = new Set([
		"confirmation_required",
		"confirmation_id",
		"action",
		"capabilities",
	]);
	if (
		!Object.keys(data).every((key) => controlKeys.has(key)) &&
		getNativeTabContinuationGuidance(commandTokens, data) === undefined
	) {
		return undefined;
	}
	return parsePendingControl(data);
}

export function getConfirmedNativeResult(
	data: unknown,
	current: ReadConfirmation,
): Readonly<Record<string, unknown>> | undefined {
	const action = current.source === "native-explicit-url-read" ? "read" : current.action;
	return isRecord(data) &&
		data.confirmed === true &&
		data.action === action &&
		isRecord(data.result)
		? data.result
		: undefined;
}

export function isSuccessfulNativeConfirmedClose(
	commandTokens: readonly string[],
	data: unknown,
): boolean {
	if (
		commandTokens[0] !== "confirm" ||
		commandTokens.length !== 2 ||
		!isRecord(data) ||
		data.confirmed !== true ||
		data.action !== "close"
	) {
		return false;
	}
	return (
		isRecord(data.result) &&
		data.result.success === true &&
		isRecord(data.result.data) &&
		data.result.data.closed === true
	);
}
