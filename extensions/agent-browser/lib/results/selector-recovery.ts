/**
 * Purpose: Own pure selector-miss recovery diagnostics for visible refs and rich editable inputs.
 * Responsibilities: Parse find/semantic action targets, match current snapshot refs, build public diagnostics, text, and safe nextActions.
 * Scope: Selector recovery policy only; subprocess snapshot probing and result orchestration stay in the extension entrypoint.
 * Usage: The extension entrypoint supplies command tokens plus snapshot data after a selector-not-found failure.
 * Invariants/Assumptions: Fill recovery must never echo or auto-submit the user-provided fill text; keyboard insertion remains a separate explicit action.
 */

import { isRecord } from "../parsing.js";
import { extractRefSnapshotFromData, type SessionRefSnapshot } from "../session-page-state.js";
import { getEditableRefEvidence } from "./editable-ref-evidence.js";
import { type AgentBrowserNextAction, withOptionalSessionArgs } from "./next-actions.js";
import {
	getAgentBrowserRichInputRecoveryNextActionId,
	getAgentBrowserRichInputRecoveryNextActionIds,
} from "./recovery-actions.js";
import {
	getSnapshotLineTextByRef,
	getSnapshotRefRecord,
	getSnapshotRefRole,
} from "./snapshot-refs.js";
import { compareRefIds } from "./text.js";

export type SelectorRecoveryActionName = "check" | "click" | "fill" | "select" | "uncheck";

export interface SelectorRecoveryCompiledAction {
	action: SelectorRecoveryActionName;
	args: string[];
	locator?: string;
	selector?: string;
	values?: string[];
}

export interface VisibleRefFallbackCandidate {
	action: SelectorRecoveryActionName;
	args?: string[];
	editableEvidence?: boolean;
	name: string;
	reason: string;
	ref: string;
	role: string;
}

export interface VisibleRefFallbackDiagnostic {
	candidates: VisibleRefFallbackCandidate[];
	snapshot: SessionRefSnapshot;
	summary: string;
	target: {
		action: SelectorRecoveryActionName;
		roles: string[];
		targetName: string;
	};
}

export interface PublicVisibleRefFallbackCandidate {
	action: SelectorRecoveryActionName;
	args?: string[];
	name: string;
	reason: string;
	ref: string;
	role: string;
}

export interface PublicVisibleRefFallbackDiagnostic {
	candidates: PublicVisibleRefFallbackCandidate[];
	snapshot: SessionRefSnapshot;
	summary: string;
	target: VisibleRefFallbackDiagnostic["target"];
}

export interface VisibleRefFallbackTarget {
	action: SelectorRecoveryActionName;
	roles: string[];
	text?: string;
	targetName: string;
}

export interface RichInputRecoveryCandidate {
	clickArgs: string[];
	focusArgs: string[];
	name: string;
	reason: string;
	ref: string;
	role: string;
}

export interface RichInputRecoveryDiagnostic {
	candidates: RichInputRecoveryCandidate[];
	inputMethodHint: string;
	nextActionIds: string[];
	summary: string;
	target: {
		roles: string[];
		targetName: string;
	};
}

const SELECTOR_RECOVERY_ACTION_NAMES = new Set<SelectorRecoveryActionName>(["check", "click", "fill", "select", "uncheck"]);
const VISIBLE_REF_FALLBACK_CANDIDATE_LIMIT = 3;
const EDITABLE_CONTROL_ROLES = new Set(["combobox", "searchbox", "textbox"]);
const RICH_INPUT_RECOVERY_EDITABLE_ROLES = new Set(["searchbox", "textbox"]);
const RICH_INPUT_RECOVERY_HINT = "After the editable ref is focused, use keyboard inserttext or keyboard type with the intended text in a separate call, and do not press Enter or otherwise submit unless the user flow explicitly calls for it.";

function isSelectorRecoveryActionName(action: string): action is SelectorRecoveryActionName {
	return SELECTOR_RECOVERY_ACTION_NAMES.has(action as SelectorRecoveryActionName);
}

function getFindNameFlagValue(args: string[], startIndex: number): string | undefined {
	const nameFlagIndex = args.indexOf("--name", startIndex);
	const name = nameFlagIndex >= 0 ? args[nameFlagIndex + 1] : undefined;
	return name && !name.startsWith("-") ? name : undefined;
}

function getFindVisibleRefFallbackTarget(args: string[], options: { allowLeadingDashFillText?: boolean } = {}): VisibleRefFallbackTarget | undefined {
	const findIndex = args[0] === "--session" ? 2 : 0;
	if (args[findIndex] !== "find") return undefined;
	const locator = args[findIndex + 1];
	const value = args[findIndex + 2];
	const action = args[findIndex + 3];
	if (!locator || !value || !isSelectorRecoveryActionName(action) || action === "select") return undefined;
	const text = action === "fill" ? args[findIndex + 4] : undefined;
	if (action === "fill" && (!text || (!options.allowLeadingDashFillText && text.startsWith("-")))) return undefined;
	if (locator === "role") {
		const targetName = getFindNameFlagValue(args, findIndex + 4);
		return targetName ? { action, roles: [value], targetName, text } : undefined;
	}
	if (locator === "text" && action === "click") {
		return { action, roles: ["button", "link"], targetName: value };
	}
	if (locator === "text" && action === "fill") {
		return { action, roles: ["searchbox", "textbox"], targetName: value, text };
	}
	if (locator === "label" && action === "fill") {
		return { action, roles: ["textbox"], targetName: value, text };
	}
	if (locator === "placeholder" && action === "fill") {
		return { action, roles: ["searchbox", "textbox"], targetName: value, text };
	}
	return undefined;
}

export function getVisibleRefFallbackTarget(options: {
	commandTokens: string[];
	compiledSemanticAction?: SelectorRecoveryCompiledAction;
}): VisibleRefFallbackTarget | undefined {
	return getFindVisibleRefFallbackTarget(options.commandTokens, { allowLeadingDashFillText: true }) ?? (options.compiledSemanticAction ? getFindVisibleRefFallbackTarget(options.compiledSemanticAction.args, { allowLeadingDashFillText: true }) : undefined);
}

function getVisibleRefFallbackCandidates(target: VisibleRefFallbackTarget, snapshotData: unknown): VisibleRefFallbackCandidate[] {
	const refs = getSnapshotRefRecord(snapshotData);
	if (!refs) return [];
	const snapshotLineByRef = getSnapshotLineTextByRef(snapshotData);
	const roleOrder = target.roles.map((role) => role.toLowerCase());
	const targetName = normalizeSemanticActionAccessibleName(target.targetName);
	const candidates = Object.entries(refs).flatMap(([ref, entry]): VisibleRefFallbackCandidate[] => {
		if (!/^e\d+$/.test(ref) || !isRecord(entry)) return [];
		const snapshotLine = snapshotLineByRef.get(ref);
		const editableEvidence = getEditableRefEvidence({ ref: entry, text: snapshotLine });
		const role = getSnapshotRefRole(entry, editableEvidence);
		const name = typeof entry.name === "string" ? entry.name : undefined;
		if (!role || !name || !roleOrder.includes(role.toLowerCase()) || normalizeSemanticActionAccessibleName(name) !== targetName) return [];
		if (target.action === "fill" && editableEvidence === false && EDITABLE_CONTROL_ROLES.has(role.toLowerCase())) return [];
		const directRefArgs = target.action === "fill" ? undefined : [target.action, `@${ref}`];
		return [{
			action: target.action,
			...(directRefArgs ? { args: directRefArgs } : {}),
			name,
			reason: `Current snapshot shows ${role} ${JSON.stringify(name)} at @${ref}, matching the failed ${target.action} locator exactly.`,
			ref: `@${ref}`,
			role,
			...(editableEvidence !== undefined ? { editableEvidence } : {}),
		}];
	});
	candidates.sort((left, right) => roleOrder.indexOf(left.role.toLowerCase()) - roleOrder.indexOf(right.role.toLowerCase()) || compareRefIds(left.ref.slice(1), right.ref.slice(1)));
	return candidates.slice(0, VISIBLE_REF_FALLBACK_CANDIDATE_LIMIT);
}

export function buildVisibleRefFallbackDiagnosticFromSnapshot(options: {
	snapshotData: unknown;
	target: VisibleRefFallbackTarget;
}): VisibleRefFallbackDiagnostic | undefined {
	const snapshot = extractRefSnapshotFromData(options.snapshotData);
	if (!snapshot) return undefined;
	const candidates = getVisibleRefFallbackCandidates(options.target, options.snapshotData);
	if (candidates.length === 0) return undefined;
	return {
		candidates,
		snapshot,
		summary: candidates.length === 1
			? `Current snapshot has one exact visible ref match for ${options.target.action} ${JSON.stringify(options.target.targetName)}.`
			: `Current snapshot has ${candidates.length} exact visible ref matches for ${options.target.action} ${JSON.stringify(options.target.targetName)}; choose only if the intended control is unambiguous.`,
		target: { action: options.target.action, roles: options.target.roles, targetName: options.target.targetName },
	};
}

export function buildVisibleRefFallbackNextActions(options: { diagnostic: VisibleRefFallbackDiagnostic; sessionName?: string }): AgentBrowserNextAction[] {
	const ambiguous = options.diagnostic.candidates.length > 1;
	return options.diagnostic.candidates.flatMap((candidate, index) => candidate.args ? [{
		id: ambiguous ? `try-current-visible-ref-${index + 1}` : "try-current-visible-ref",
		params: { args: withOptionalSessionArgs(options.sessionName, candidate.args) },
		reason: candidate.reason,
		safety: ambiguous
			? "Several current refs share the same exact role/name. Inspect the snapshot and use only the ref that clearly matches the intended target."
			: "Use only while this current snapshot still represents the page; refresh refs first if the page changed.",
		tool: "agent_browser" as const,
	}] : []);
}

export function formatVisibleRefFallbackText(diagnostic: VisibleRefFallbackDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	return [
		"Current snapshot ref fallback:",
		...diagnostic.candidates.map((candidate) => `- ${candidate.ref}${candidate.role ? ` ${candidate.role}` : ""} ${JSON.stringify(candidate.name)}: ${candidate.reason}`),
	].join("\n");
}

export function sanitizeVisibleRefFallbackDiagnostic(diagnostic: VisibleRefFallbackDiagnostic): PublicVisibleRefFallbackDiagnostic {
	return {
		candidates: diagnostic.candidates.map(({ editableEvidence: _editableEvidence, ...candidate }) => candidate),
		snapshot: diagnostic.snapshot,
		summary: diagnostic.summary,
		target: diagnostic.target,
	};
}

function isRichInputRecoveryCandidate(candidate: VisibleRefFallbackCandidate): boolean {
	return candidate.action === "fill" && candidate.editableEvidence !== false && RICH_INPUT_RECOVERY_EDITABLE_ROLES.has(candidate.role.toLowerCase());
}

export function buildRichInputRecoveryDiagnostic(diagnostic: VisibleRefFallbackDiagnostic | undefined): RichInputRecoveryDiagnostic | undefined {
	if (!diagnostic || diagnostic.target.action !== "fill") return undefined;
	const candidates = diagnostic.candidates.filter(isRichInputRecoveryCandidate).map((candidate): RichInputRecoveryCandidate => ({
		clickArgs: ["click", candidate.ref],
		focusArgs: ["focus", candidate.ref],
		name: candidate.name,
		reason: `Current snapshot shows editable ${candidate.role} ${JSON.stringify(candidate.name)} at ${candidate.ref}; focus or click it before keyboard insertion instead of retrying fill with copied text.`,
		ref: candidate.ref,
		role: candidate.role,
	}));
	if (candidates.length === 0) return undefined;
	return {
		candidates,
		inputMethodHint: RICH_INPUT_RECOVERY_HINT,
		nextActionIds: getAgentBrowserRichInputRecoveryNextActionIds(candidates.length),
		summary: candidates.length === 1
			? "Fill locator missed, but the current snapshot has one exact editable ref candidate for safe keyboard-based recovery."
			: `Fill locator missed, but the current snapshot has ${candidates.length} exact editable ref candidates; choose only if the intended input is unambiguous.`,
		target: { roles: diagnostic.target.roles, targetName: diagnostic.target.targetName },
	};
}

export function buildRichInputRecoveryNextActions(options: { diagnostic: RichInputRecoveryDiagnostic; sessionName?: string }): AgentBrowserNextAction[] {
	const candidateCount = options.diagnostic.candidates.length;
	const ambiguous = candidateCount > 1;
	return options.diagnostic.candidates.flatMap((candidate, index): AgentBrowserNextAction[] => {
		const focusId = getAgentBrowserRichInputRecoveryNextActionId("focus", index, candidateCount);
		const clickId = getAgentBrowserRichInputRecoveryNextActionId("click", index, candidateCount);
		const safety = ambiguous
			? `Several editable refs share the same exact name. Inspect the current snapshot and use only the ${candidate.ref} ${candidate.role} if it is clearly the intended input. No fill text or submit key is included.`
			: "Does not include fill text or submit the form. After focus/click succeeds, use keyboard inserttext or keyboard type with the intended text only if this is the right input.";
		return [
			{
				id: focusId,
				params: { args: withOptionalSessionArgs(options.sessionName, candidate.focusArgs) },
				reason: candidate.reason,
				safety,
				tool: "agent_browser" as const,
			},
			{
				id: clickId,
				params: { args: withOptionalSessionArgs(options.sessionName, candidate.clickArgs) },
				reason: `Click ${candidate.ref} to focus the editable ${candidate.role} before keyboard insertion when focus alone is insufficient.`,
				safety: `${safety} A click may run normal focus/click handlers, but this action does not press Enter or auto-submit.`,
				tool: "agent_browser" as const,
			},
		];
	});
}

export function formatRichInputRecoveryText(diagnostic: RichInputRecoveryDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	return [
		"Rich input recovery:",
		...diagnostic.candidates.map((candidate, index) => {
			const [focusId, clickId] = diagnostic.nextActionIds.slice(index * 2, index * 2 + 2);
			return `- ${candidate.ref} ${candidate.role} ${JSON.stringify(candidate.name)}: use ${focusId} or ${clickId}; then use keyboard inserttext/type with the intended text.`;
		}),
		`- ${diagnostic.inputMethodHint}`,
	].join("\n");
}

export function normalizeSemanticActionAccessibleName(name: string): string {
	return name.replace(/\s+/g, " ").trim().toLowerCase();
}
