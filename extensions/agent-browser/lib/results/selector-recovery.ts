import { isRecord } from "../parsing.js";
import { extractRefSnapshotFromData } from "../session-page-observation.js";
import type { SessionRefSnapshot } from "../session-page-types.js";
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
	normalizeAccessibleName,
} from "./snapshot-refs.js";
import { compareRefIds } from "./text.js";

import {
	getFindVisibleRefFallbackTarget,
	type SelectorRecoveryActionName,
	type SelectorRecoveryCompiledAction,
	type VisibleRefFallbackTarget,
} from "./selector-recovery-target.js";
export type {
	SelectorRecoveryActionName,
	SelectorRecoveryCompiledAction,
	VisibleRefFallbackTarget,
} from "./selector-recovery-target.js";

export interface VisibleRefFallbackCandidate {
	readonly action: SelectorRecoveryActionName;
	readonly args?: readonly string[];
	readonly editableEvidence?: boolean;
	readonly name: string;
	readonly reason: string;
	readonly ref: string;
	readonly role: string;
}

export interface VisibleRefFallbackDiagnostic {
	readonly candidates: readonly VisibleRefFallbackCandidate[];
	readonly snapshot: SessionRefSnapshot;
	readonly summary: string;
	readonly target: {
		readonly action: SelectorRecoveryActionName;
		readonly roles: readonly string[];
		readonly targetName: string;
	};
}

export type PublicVisibleRefFallbackCandidate = Omit<
	VisibleRefFallbackCandidate,
	"editableEvidence"
>;

export type PublicVisibleRefFallbackDiagnostic = Omit<
	VisibleRefFallbackDiagnostic,
	"candidates"
> & {
	readonly candidates: readonly PublicVisibleRefFallbackCandidate[];
};

export interface RichInputRecoveryCandidate {
	readonly clickArgs: readonly string[];
	readonly focusArgs: readonly string[];
	readonly name: string;
	readonly reason: string;
	readonly ref: string;
	readonly role: string;
}

export interface RichInputRecoveryDiagnostic {
	readonly candidates: readonly RichInputRecoveryCandidate[];
	readonly inputMethodHint: string;
	readonly nextActionIds: readonly string[];
	readonly summary: string;
	readonly target: {
		readonly roles: readonly string[];
		readonly targetName: string;
	};
}

const VISIBLE_REF_FALLBACK_CANDIDATE_LIMIT = 3;
const EDITABLE_CONTROL_ROLES = new Set(["combobox", "searchbox", "textbox"]);
const RICH_INPUT_RECOVERY_EDITABLE_ROLES = new Set(["searchbox", "textbox"]);
const RICH_INPUT_RECOVERY_HINT =
	"After the editable ref is focused, use keyboard type when a framework-controlled editor requires real key events. keyboard inserttext is paste-like and needs separate application-state verification. Do not press Enter or otherwise submit unless the user flow explicitly calls for it.";

export function getVisibleRefFallbackTarget(options: {
	readonly commandTokens: readonly string[];
	readonly compiledSemanticAction?: SelectorRecoveryCompiledAction | undefined;
}): VisibleRefFallbackTarget | undefined {
	return (
		getFindVisibleRefFallbackTarget(options.commandTokens) ??
		(options.compiledSemanticAction
			? getFindVisibleRefFallbackTarget(options.compiledSemanticAction.args)
			: undefined)
	);
}

function getDirectRefFallbackArgs(
	target: VisibleRefFallbackTarget,
	ref: string,
): readonly string[] | undefined {
	if (target.action === "fill") {
		return undefined;
	}
	if (target.action === "select") {
		return target.optionValues && target.optionValues.length > 0
			? ["select", `@${ref}`, ...target.optionValues]
			: undefined;
	}
	return [target.action, `@${ref}`];
}

function getCandidateEditableEvidence(
	snapshot: SessionRefSnapshot | undefined,
	ref: string,
	entry: Readonly<Record<string, unknown>>,
	line: string | undefined,
): boolean | undefined {
	return snapshot
		? snapshot.refs?.[ref]?.isEditable
		: getEditableRefEvidence({ ref: entry, text: line });
}

function matchesFallbackName(name: string | undefined, targetName: string): name is string {
	return name !== undefined && name.length > 0 && normalizeAccessibleName(name) === targetName;
}

function isDisallowedEditableFill(
	action: SelectorRecoveryActionName,
	evidence: boolean | undefined,
	role: string,
): boolean {
	return action === "fill" && evidence === false && EDITABLE_CONTROL_ROLES.has(role.toLowerCase());
}

function getVisibleRefFallbackCandidates(
	target: VisibleRefFallbackTarget,
	snapshotData: unknown,
	refSnapshot?: SessionRefSnapshot,
): VisibleRefFallbackCandidate[] {
	const refs = refSnapshot?.refs ?? getSnapshotRefRecord(snapshotData);
	if (!refs) {
		return [];
	}
	const snapshotLineByRef = getSnapshotLineTextByRef(snapshotData);
	const roleOrder = target.roles.map((role) => role.toLowerCase());
	const targetName = normalizeAccessibleName(target.targetName);
	const candidates = Object.entries(refs).flatMap(([ref, entry]): VisibleRefFallbackCandidate[] => {
		if (!/^e\d+$/.test(ref) || !isRecord(entry)) {
			return [];
		}
		const snapshotLine = snapshotLineByRef.get(ref);
		const editableEvidence = getCandidateEditableEvidence(refSnapshot, ref, entry, snapshotLine);
		const role = getSnapshotRefRole(entry, editableEvidence);
		const name = typeof entry.name === "string" ? entry.name : undefined;
		if (!matchesFallbackName(name, targetName) || !roleOrder.includes(role.toLowerCase())) {
			return [];
		}
		if (isDisallowedEditableFill(target.action, editableEvidence, role)) {
			return [];
		}
		const directRefArgs = getDirectRefFallbackArgs(target, ref);
		return [
			{
				action: target.action,
				...(directRefArgs ? { args: directRefArgs } : {}),
				name,
				reason: `Current snapshot shows ${role} ${JSON.stringify(name)} at @${ref}, matching the failed ${target.action} locator exactly.`,
				ref: `@${ref}`,
				role,
				...(editableEvidence !== undefined ? { editableEvidence } : {}),
			},
		];
	});
	candidates.sort((left, right) => {
		const difference =
			roleOrder.indexOf(left.role.toLowerCase()) - roleOrder.indexOf(right.role.toLowerCase());
		return difference !== 0 ? difference : compareRefIds(left.ref.slice(1), right.ref.slice(1));
	});
	return candidates.slice(0, VISIBLE_REF_FALLBACK_CANDIDATE_LIMIT);
}

export function buildVisibleRefFallbackDiagnosticFromSnapshot(options: {
	readonly snapshotData: unknown;
	readonly target: VisibleRefFallbackTarget;
}): VisibleRefFallbackDiagnostic | undefined {
	const snapshot = extractRefSnapshotFromData(options.snapshotData);
	if (!snapshot) {
		return undefined;
	}
	const candidates = getVisibleRefFallbackCandidates(options.target, options.snapshotData);
	if (candidates.length === 0) {
		return undefined;
	}
	return {
		candidates,
		snapshot,
		summary:
			candidates.length === 1
				? `Current snapshot has one exact visible ref match for ${options.target.action} ${JSON.stringify(options.target.targetName)}.`
				: `Current snapshot has ${candidates.length} exact visible ref matches for ${options.target.action} ${JSON.stringify(options.target.targetName)}; choose only if the intended control is unambiguous.`,
		target: {
			action: options.target.action,
			roles: options.target.roles,
			targetName: options.target.targetName,
		},
	};
}

export interface VisibleRefActionResolution {
	readonly args: readonly string[];
	readonly snapshot: SessionRefSnapshot;
}

function resolveFillCandidateArgs(
	candidates: readonly VisibleRefFallbackCandidate[],
	text: string | undefined,
	allowFill: boolean | undefined,
): readonly string[] | undefined {
	if (allowFill !== true || candidates.length !== 1 || text === undefined) {
		return undefined;
	}
	const candidate = candidates.at(0);
	if (
		!candidate ||
		candidate.editableEvidence === false ||
		!EDITABLE_CONTROL_ROLES.has(candidate.role.toLowerCase())
	) {
		return undefined;
	}
	return ["fill", candidate.ref, text];
}

function resolveSelectCandidateArgs(
	candidates: readonly VisibleRefFallbackCandidate[],
	values: readonly string[] | undefined,
): readonly string[] | undefined {
	if (candidates.length !== 1 || !values || values.length === 0) {
		return undefined;
	}
	const candidate = candidates.at(0);
	return candidate ? ["select", candidate.ref, ...values] : undefined;
}

function resolveCandidateArgs(
	target: VisibleRefFallbackTarget,
	candidates: readonly VisibleRefFallbackCandidate[],
	allowFill: boolean | undefined,
	selectValues: readonly string[] | undefined,
): readonly string[] | undefined {
	if (target.action === "fill") {
		return resolveFillCandidateArgs(candidates, target.text, allowFill);
	}
	if (target.action === "select") {
		return resolveSelectCandidateArgs(candidates, selectValues);
	}
	return candidates.find((candidate) => candidate.args !== undefined)?.args;
}

export function resolveVisibleRefActionFromSnapshot(options: {
	readonly allowFill?: boolean;
	readonly compiledAction: SelectorRecoveryCompiledAction;
	readonly refSnapshot?: SessionRefSnapshot | undefined;
	readonly snapshotData?: unknown;
}): VisibleRefActionResolution | undefined {
	const target = getFindVisibleRefFallbackTarget(options.compiledAction.args);
	if (!target) {
		return undefined;
	}
	const snapshot = options.refSnapshot ?? extractRefSnapshotFromData(options.snapshotData);
	if (!snapshot) {
		return undefined;
	}
	const selectOptionValues =
		options.compiledAction.values && options.compiledAction.values.length > 0
			? options.compiledAction.values
			: target.optionValues;
	const effectiveTarget =
		target.action === "select" && selectOptionValues
			? { ...target, optionValues: selectOptionValues }
			: target;
	const candidates = getVisibleRefFallbackCandidates(
		effectiveTarget,
		options.snapshotData,
		options.refSnapshot,
	);
	const args = resolveCandidateArgs(
		effectiveTarget,
		candidates,
		options.allowFill,
		selectOptionValues,
	);
	return args ? { args, snapshot } : undefined;
}

export function buildVisibleRefFallbackNextActions(options: {
	readonly diagnostic: VisibleRefFallbackDiagnostic;
	readonly sessionName?: string | undefined;
}): AgentBrowserNextAction[] {
	const ambiguous = options.diagnostic.candidates.length > 1;
	return options.diagnostic.candidates.flatMap((candidate, index) =>
		candidate.args
			? [
					{
						id: ambiguous ? `try-current-visible-ref-${index + 1}` : "try-current-visible-ref",
						params: { args: withOptionalSessionArgs(options.sessionName, candidate.args) },
						reason: candidate.reason,
						safety: ambiguous
							? "Several current refs share the same exact role/name. Inspect the snapshot and use only the ref that clearly matches the intended target."
							: "Use only while this current snapshot still represents the page; refresh refs first if the page changed.",
						tool: "agent_browser" as const,
					},
				]
			: [],
	);
}

export function formatVisibleRefFallbackText(
	diagnostic: VisibleRefFallbackDiagnostic | undefined,
): string | undefined {
	if (!diagnostic) {
		return undefined;
	}
	return [
		"Current snapshot ref fallback:",
		...diagnostic.candidates.map(
			(candidate) =>
				`- ${candidate.ref}${candidate.role.length > 0 ? ` ${candidate.role}` : ""} ${JSON.stringify(candidate.name)}: ${candidate.reason}`,
		),
	].join("\n");
}

export function sanitizeVisibleRefFallbackDiagnostic(
	diagnostic: VisibleRefFallbackDiagnostic,
): PublicVisibleRefFallbackDiagnostic {
	return {
		candidates: diagnostic.candidates.map(
			({ editableEvidence: _editableEvidence, ...candidate }) => candidate,
		),
		snapshot: diagnostic.snapshot,
		summary: diagnostic.summary,
		target: diagnostic.target,
	};
}

function isRichInputRecoveryCandidate(candidate: VisibleRefFallbackCandidate): boolean {
	return (
		candidate.action === "fill" &&
		candidate.editableEvidence !== false &&
		RICH_INPUT_RECOVERY_EDITABLE_ROLES.has(candidate.role.toLowerCase())
	);
}

export function buildRichInputRecoveryDiagnostic(
	diagnostic: VisibleRefFallbackDiagnostic | undefined,
): RichInputRecoveryDiagnostic | undefined {
	if (!diagnostic || diagnostic.target.action !== "fill") {
		return undefined;
	}
	const candidates = diagnostic.candidates
		.filter(isRichInputRecoveryCandidate)
		.map((candidate): RichInputRecoveryCandidate => ({
			clickArgs: ["click", candidate.ref],
			focusArgs: ["focus", candidate.ref],
			name: candidate.name,
			reason: `Current snapshot shows editable ${candidate.role} ${JSON.stringify(candidate.name)} at ${candidate.ref}; focus or click it before keyboard insertion instead of retrying fill with copied text.`,
			ref: candidate.ref,
			role: candidate.role,
		}));
	if (candidates.length === 0) {
		return undefined;
	}
	return {
		candidates,
		inputMethodHint: RICH_INPUT_RECOVERY_HINT,
		nextActionIds: getAgentBrowserRichInputRecoveryNextActionIds(candidates.length),
		summary:
			candidates.length === 1
				? "Fill locator missed, but the current snapshot has one exact editable ref candidate for safe keyboard-based recovery."
				: `Fill locator missed, but the current snapshot has ${candidates.length} exact editable ref candidates; choose only if the intended input is unambiguous.`,
		target: { roles: diagnostic.target.roles, targetName: diagnostic.target.targetName },
	};
}

export function buildRichInputRecoveryNextActions(options: {
	readonly diagnostic: RichInputRecoveryDiagnostic;
	readonly sessionName?: string | undefined;
}): AgentBrowserNextAction[] {
	const candidateCount = options.diagnostic.candidates.length;
	const ambiguous = candidateCount > 1;
	return options.diagnostic.candidates.flatMap((candidate, index): AgentBrowserNextAction[] => {
		const focusId = getAgentBrowserRichInputRecoveryNextActionId("focus", index, candidateCount);
		const clickId = getAgentBrowserRichInputRecoveryNextActionId("click", index, candidateCount);
		const safety = ambiguous
			? `Several editable refs share the same exact name. Inspect the current snapshot and use only the ${candidate.ref} ${candidate.role} if it is clearly the intended input. No fill text or submit key is included.`
			: "Does not include fill text or submit the form. After focus/click succeeds, use keyboard type for framework-controlled editors; use keyboard inserttext only with separate application-state verification.";
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

export function formatRichInputRecoveryText(
	diagnostic: RichInputRecoveryDiagnostic | undefined,
): string | undefined {
	if (!diagnostic) {
		return undefined;
	}
	return [
		"Rich input recovery:",
		...diagnostic.candidates.map((candidate, index) => {
			const focusId = diagnostic.nextActionIds.at(index * 2);
			const clickId = diagnostic.nextActionIds.at(index * 2 + 1);
			return `- ${candidate.ref} ${candidate.role} ${JSON.stringify(candidate.name)}: use ${focusId ?? "undefined"} or ${clickId ?? "undefined"}; then use keyboard type for framework-controlled editors, or paste-like keyboard inserttext only with separate application-state verification.`;
		}),
		`- ${diagnostic.inputMethodHint}`,
	].join("\n");
}
