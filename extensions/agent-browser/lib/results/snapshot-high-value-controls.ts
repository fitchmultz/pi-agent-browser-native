/**
 * Purpose: Select the omitted snapshot refs most likely to be actionable controls.
 * Responsibilities: Classify editable, surface, primary-action, and role-based control refs with deterministic diversity and top-up rules.
 * Scope: High-value control ranking only; snapshot parsing, noise filtering, and presentation text live in neighboring modules.
 * Usage: Snapshot presentation passes already-visible, non-noise omitted refs and receives the bounded high-value subset to surface.
 * Invariants/Assumptions: Ranking must preserve scarce control categories before filling dominant buckets so dense desktop hosts stay navigable.
 */

import type { SnapshotRefEntry } from "./snapshot-refs.js";
import { compareRefIds } from "./text.js";

const SNAPSHOT_HIGH_VALUE_EDITABLE_REF_FILL_TARGET_LINES = 4;
const SNAPSHOT_HIGH_VALUE_SURFACE_REF_FILL_TARGET_LINES = 3;
const SNAPSHOT_HIGH_VALUE_PRIMARY_ACTION_REF_FILL_TARGET_LINES = 3;

const SNAPSHOT_HIGH_VALUE_CONTROL_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"link",
	"menuitem",
	"option",
	"radio",
	"searchbox",
	"tab",
	"textbox",
]);

const SNAPSHOT_HIGH_VALUE_CONTROL_ROLE_PRIORITY: Record<string, number> = {
	searchbox: 0,
	textbox: 1,
	combobox: 2,
	button: 3,
	link: 4,
	tab: 5,
	checkbox: 6,
	radio: 7,
	option: 8,
	menuitem: 9,
};

const SNAPSHOT_SURFACE_CONTROL_NAME_PATTERNS = [
	/\b(?:agents?|browser|canvas|chat|editor|panel|pane|preview|surface|tab|terminal|thread|view|window|workspace)\b/i,
];

const SNAPSHOT_PRIMARY_ACTION_BUTTON_NAME_PATTERNS = [
	/^(?:add|apply|ask|attach|choose|confirm|connect|continue|create|deploy|done|download|go|insert|launch|log in|new|next|ok|open|publish|refresh|retry|run|save|search|select|send|sign in|sign up|start|submit|upload)$/i,
	/^(?:add|apply|ask|confirm|connect|continue|create|launch|new|open|refresh|retry|run|save|search|send|start|submit)\b/i,
];

const SNAPSHOT_HIGH_VALUE_LINK_NAME_PATTERNS = [
	/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i,
];

function getHighValueControlRole(entry: SnapshotRefEntry): string {
	return entry.isEditable === true && (entry.role === "unknown" || entry.role === "generic") ? "textbox" : entry.role;
}

function isEditableControlRef(entry: SnapshotRefEntry): boolean {
	if (entry.isEditable === false) return false;
	const role = getHighValueControlRole(entry);
	return entry.isEditable === true || role === "searchbox" || role === "textbox" || role === "combobox";
}

function isNamedSurfaceControlRef(entry: SnapshotRefEntry): boolean {
	if (entry.name.length === 0) return false;
	const role = getHighValueControlRole(entry);
	if (role === "tab") return true;
	if (role !== "button" && role !== "menuitem" && role !== "option") return false;
	return SNAPSHOT_SURFACE_CONTROL_NAME_PATTERNS.some((pattern) => pattern.test(entry.name));
}

function isPrimaryActionButtonRef(entry: SnapshotRefEntry): boolean {
	return (
		getHighValueControlRole(entry) === "button" &&
		entry.name.length > 0 &&
		SNAPSHOT_PRIMARY_ACTION_BUTTON_NAME_PATTERNS.some((pattern) => pattern.test(entry.name))
	);
}

type HighValueControlCategory = "editable" | "named-surface" | "primary-action" | "role";

interface HighValueControlCategoryRule {
	bucketKey(entry: SnapshotRefEntry, role: string): string;
	fillTarget?: number;
	id: HighValueControlCategory;
	matches(entry: SnapshotRefEntry, role: string): boolean;
	priority: number;
}

interface HighValueControlScore {
	category: HighValueControlCategory;
	categoryPriority: number;
	diversityBucketKey: string;
	lineIndex: number;
	namePriority: 0 | 1;
	refId: string;
	role: string;
	rolePriority: number;
	roundRobinBucketKey: string;
}

interface HighValueControlCandidate {
	entry: SnapshotRefEntry;
	score: HighValueControlScore;
}

const SNAPSHOT_HIGH_VALUE_CONTROL_CATEGORY_RULES: readonly HighValueControlCategoryRule[] = [
	{
		bucketKey: () => "editable",
		fillTarget: SNAPSHOT_HIGH_VALUE_EDITABLE_REF_FILL_TARGET_LINES,
		id: "editable",
		matches: (entry) => isEditableControlRef(entry),
		priority: 0,
	},
	{
		bucketKey: () => "named-surface",
		fillTarget: SNAPSHOT_HIGH_VALUE_SURFACE_REF_FILL_TARGET_LINES,
		id: "named-surface",
		matches: (entry) => isNamedSurfaceControlRef(entry),
		priority: 1,
	},
	{
		bucketKey: () => "primary-action",
		fillTarget: SNAPSHOT_HIGH_VALUE_PRIMARY_ACTION_REF_FILL_TARGET_LINES,
		id: "primary-action",
		matches: (entry) => isPrimaryActionButtonRef(entry),
		priority: 2,
	},
	{
		bucketKey: (_entry, role) => role,
		id: "role",
		matches: () => true,
		priority: 3,
	},
] as const;

function isHighValueLinkRef(entry: SnapshotRefEntry): boolean {
	return entry.name.length > 0 && SNAPSHOT_HIGH_VALUE_LINK_NAME_PATTERNS.some((pattern) => pattern.test(entry.name));
}

export function isHighValueControlEntry(entry: SnapshotRefEntry): boolean {
	const role = getHighValueControlRole(entry);
	if (!SNAPSHOT_HIGH_VALUE_CONTROL_ROLES.has(role)) return false;
	if (role === "link") return isHighValueLinkRef(entry);
	if (entry.isEditable === false && (role === "searchbox" || role === "textbox" || role === "combobox")) return false;
	return entry.name.length > 0 || isEditableControlRef(entry);
}

function getHighValueControlCategoryRule(entry: SnapshotRefEntry, role: string): HighValueControlCategoryRule | undefined {
	return SNAPSHOT_HIGH_VALUE_CONTROL_CATEGORY_RULES.find((rule) => rule.matches(entry, role));
}

function classifyHighValueControlRef(entry: SnapshotRefEntry): HighValueControlCandidate | undefined {
	if (!isHighValueControlEntry(entry)) return undefined;
	const role = getHighValueControlRole(entry);
	const rule = getHighValueControlCategoryRule(entry, role);
	if (!rule) return undefined;

	return {
		entry,
		score: {
			category: rule.id,
			categoryPriority: rule.priority,
			diversityBucketKey: `${rule.priority}:${rule.bucketKey(entry, role)}`,
			lineIndex: entry.lineIndex ?? Number.MAX_SAFE_INTEGER,
			namePriority: entry.name.length > 0 ? 0 : 1,
			refId: entry.id,
			role,
			rolePriority: SNAPSHOT_HIGH_VALUE_CONTROL_ROLE_PRIORITY[role] ?? 50,
			roundRobinBucketKey: `${rule.priority}:${role}`,
		},
	};
}

function compareHighValueControlCandidates(left: HighValueControlCandidate, right: HighValueControlCandidate): number {
	return (
		left.score.categoryPriority - right.score.categoryPriority ||
		left.score.rolePriority - right.score.rolePriority ||
		left.score.namePriority - right.score.namePriority ||
		left.score.lineIndex - right.score.lineIndex ||
		compareRefIds(left.score.refId, right.score.refId)
	);
}

function takeHighValueCandidate(
	candidate: HighValueControlCandidate,
	selected: HighValueControlCandidate[],
	selectedIds: Set<string>,
): void {
	selected.push(candidate);
	selectedIds.add(candidate.entry.id);
}

function takeFirstPerDiversityBucket(
	candidates: HighValueControlCandidate[],
	selected: HighValueControlCandidate[],
	selectedIds: Set<string>,
	limit: number,
): void {
	const seenBuckets = new Set<string>();
	for (const candidate of candidates) {
		if (selected.length >= limit) break;
		if (seenBuckets.has(candidate.score.diversityBucketKey)) continue;
		seenBuckets.add(candidate.score.diversityBucketKey);
		takeHighValueCandidate(candidate, selected, selectedIds);
	}
}

function topUpHighValueCategory(
	candidates: HighValueControlCandidate[],
	selected: HighValueControlCandidate[],
	selectedIds: Set<string>,
	category: HighValueControlCategory,
	target: number,
	limit: number,
): void {
	let count = selected.filter((candidate) => candidate.score.category === category).length;
	for (const candidate of candidates) {
		if (selected.length >= limit || count >= target) break;
		if (selectedIds.has(candidate.entry.id) || candidate.score.category !== category) continue;
		takeHighValueCandidate(candidate, selected, selectedIds);
		count += 1;
	}
}

function buildRemainingHighValueBuckets(
	candidates: HighValueControlCandidate[],
	selectedIds: Set<string>,
): HighValueControlCandidate[][] {
	const buckets = new Map<string, HighValueControlCandidate[]>();
	for (const candidate of candidates) {
		if (selectedIds.has(candidate.entry.id)) continue;
		const bucket = buckets.get(candidate.score.roundRobinBucketKey);
		if (bucket) bucket.push(candidate);
		else buckets.set(candidate.score.roundRobinBucketKey, [candidate]);
	}
	return [...buckets.values()].sort((left, right) => compareHighValueControlCandidates(left[0], right[0]));
}

function roundRobinHighValueBuckets(
	buckets: HighValueControlCandidate[][],
	selected: HighValueControlCandidate[],
	selectedIds: Set<string>,
	limit: number,
): void {
	let bucketIndex = 0;
	while (selected.length < limit && buckets.some((bucket) => bucket.length > 0)) {
		const bucket = buckets[bucketIndex % buckets.length];
		const candidate = bucket.shift();
		if (candidate) takeHighValueCandidate(candidate, selected, selectedIds);
		bucketIndex += 1;
	}
}

export function selectHighValueControlEntries(entries: SnapshotRefEntry[], limit: number): SnapshotRefEntry[] {
	const candidates = entries
		.map(classifyHighValueControlRef)
		.filter((candidate): candidate is HighValueControlCandidate => Boolean(candidate))
		.sort(compareHighValueControlCandidates);
	const selected: HighValueControlCandidate[] = [];
	const selectedIds = new Set<string>();

	takeFirstPerDiversityBucket(candidates, selected, selectedIds, limit);

	for (const rule of SNAPSHOT_HIGH_VALUE_CONTROL_CATEGORY_RULES) {
		if (rule.fillTarget === undefined) continue;
		topUpHighValueCategory(candidates, selected, selectedIds, rule.id, rule.fillTarget, limit);
	}

	roundRobinHighValueBuckets(buildRemainingHighValueBuckets(candidates, selectedIds), selected, selectedIds, limit);
	return selected.map((candidate) => candidate.entry);
}
