import type { SnapshotRefEntry } from "./snapshot-refs.js";
import { compareRefIds } from "./text.js";

const SNAPSHOT_HIGH_VALUE_EDITABLE_REF_FILL_TARGET_LINES = 4;
const SNAPSHOT_HIGH_VALUE_SURFACE_REF_FILL_TARGET_LINES = 3;
const SNAPSHOT_HIGH_VALUE_PRIMARY_ACTION_REF_FILL_TARGET_LINES = 3;
const SNAPSHOT_HIGH_VALUE_NAMED_LINK_REF_FILL_TARGET_LINES = 6;
const SNAPSHOT_HIGH_VALUE_LINK_NAME_MAX_LENGTH = 80;

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

function getHighValueControlRole(entry: SnapshotRefEntry): string {
	return entry.isEditable === true && (entry.role === "unknown" || entry.role === "generic")
		? "textbox"
		: entry.role;
}

function isEditableControlRef(entry: SnapshotRefEntry): boolean {
	if (entry.isEditable === false) {
		return false;
	}
	const role = getHighValueControlRole(entry);
	return (
		entry.isEditable === true || role === "searchbox" || role === "textbox" || role === "combobox"
	);
}

function isNamedSurfaceControlRef(entry: SnapshotRefEntry): boolean {
	if (entry.name.length === 0) {
		return false;
	}
	const role = getHighValueControlRole(entry);
	if (role === "tab") {
		return true;
	}
	if (role !== "button" && role !== "menuitem" && role !== "option") {
		return false;
	}
	return SNAPSHOT_SURFACE_CONTROL_NAME_PATTERNS.some((pattern) => pattern.test(entry.name));
}

function isPrimaryActionButtonRef(entry: SnapshotRefEntry): boolean {
	return (
		getHighValueControlRole(entry) === "button" &&
		entry.name.length > 0 &&
		SNAPSHOT_PRIMARY_ACTION_BUTTON_NAME_PATTERNS.some((pattern) => pattern.test(entry.name))
	);
}

type HighValueControlCategory =
	| "editable"
	| "named-surface"
	| "primary-action"
	| "named-link"
	| "role";

interface HighValueControlCategoryRule {
	readonly bucketKey: (entry: SnapshotRefEntry, role: string) => string;
	readonly fillTarget?: number;
	readonly id: HighValueControlCategory;
	readonly matches: (entry: SnapshotRefEntry, role: string) => boolean;
	readonly priority: number;
}

interface HighValueControlScore {
	readonly category: HighValueControlCategory;
	readonly categoryPriority: number;
	readonly diversityBucketKey: string;
	readonly lineIndex: number;
	readonly namePriority: 0 | 1;
	readonly refId: string;
	readonly role: string;
	readonly rolePriority: number;
	readonly roundRobinBucketKey: string;
}

interface HighValueControlCandidate {
	readonly entry: SnapshotRefEntry;
	readonly score: HighValueControlScore;
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
		bucketKey: () => "named-link",
		fillTarget: SNAPSHOT_HIGH_VALUE_NAMED_LINK_REF_FILL_TARGET_LINES,
		id: "named-link",
		matches: (entry) => getHighValueControlRole(entry) === "link" && isNamedActionLinkRef(entry),
		priority: 3,
	},
	{
		bucketKey: (_entry, role) => role,
		id: "role",
		matches: () => true,
		priority: 4,
	},
] as const;

function isNamedActionLinkRef(entry: SnapshotRefEntry): boolean {
	return entry.name.length > 0 && entry.name.length <= SNAPSHOT_HIGH_VALUE_LINK_NAME_MAX_LENGTH;
}

export function isHighValueControlEntry(entry: SnapshotRefEntry): boolean {
	const role = getHighValueControlRole(entry);
	if (!SNAPSHOT_HIGH_VALUE_CONTROL_ROLES.has(role)) {
		return false;
	}
	if (role === "link") {
		return isNamedActionLinkRef(entry);
	}
	if (
		entry.isEditable === false &&
		(role === "searchbox" || role === "textbox" || role === "combobox")
	) {
		return false;
	}
	return entry.name.length > 0 || isEditableControlRef(entry);
}

function getHighValueControlCategoryRule(
	entry: SnapshotRefEntry,
	role: string,
): HighValueControlCategoryRule | undefined {
	return SNAPSHOT_HIGH_VALUE_CONTROL_CATEGORY_RULES.find((rule) => rule.matches(entry, role));
}

function classifyHighValueControlRef(
	entry: SnapshotRefEntry,
): HighValueControlCandidate | undefined {
	if (!isHighValueControlEntry(entry)) {
		return undefined;
	}
	const role = getHighValueControlRole(entry);
	const rule = getHighValueControlCategoryRule(entry, role);
	if (!rule) {
		return undefined;
	}

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

function compareHighValueControlCandidates(
	left: HighValueControlCandidate,
	right: HighValueControlCandidate,
): number {
	const differences = [
		left.score.categoryPriority - right.score.categoryPriority,
		left.score.rolePriority - right.score.rolePriority,
		left.score.namePriority - right.score.namePriority,
		left.score.lineIndex - right.score.lineIndex,
	];
	return (
		differences.find((difference) => difference !== 0 && !Number.isNaN(difference)) ??
		compareRefIds(left.score.refId, right.score.refId)
	);
}

class HighValueSelection {
	private readonly selected: HighValueControlCandidate[] = [];
	private readonly selectedIds = new Set<string>();

	private readonly candidates: readonly HighValueControlCandidate[];
	private readonly limit: number;

	constructor(candidates: readonly HighValueControlCandidate[], limit: number) {
		this.candidates = candidates;
		this.limit = limit;
	}

	private take(candidate: HighValueControlCandidate): void {
		this.selected.push(candidate);
		this.selectedIds.add(candidate.entry.id);
	}

	private takeFirstPerDiversityBucket(): void {
		const seenBuckets = new Set<string>();
		for (const candidate of this.candidates) {
			if (this.selected.length >= this.limit) {
				break;
			}
			if (!seenBuckets.has(candidate.score.diversityBucketKey)) {
				seenBuckets.add(candidate.score.diversityBucketKey);
				this.take(candidate);
			}
		}
	}

	private topUp(category: HighValueControlCategory, target: number): void {
		let count = this.selected.filter((candidate) => candidate.score.category === category).length;
		for (const candidate of this.candidates) {
			if (this.selected.length >= this.limit || count >= target) {
				break;
			}
			if (!this.selectedIds.has(candidate.entry.id) && candidate.score.category === category) {
				this.take(candidate);
				count += 1;
			}
		}
	}

	private buildRemainingBuckets(): HighValueControlCandidate[][] {
		const buckets = new Map<string, [HighValueControlCandidate, ...HighValueControlCandidate[]]>();
		for (const candidate of this.candidates) {
			if (this.selectedIds.has(candidate.entry.id)) {
				continue;
			}
			const key = candidate.score.roundRobinBucketKey;
			const bucket = buckets.get(key);
			if (bucket) {
				bucket.push(candidate);
			} else {
				buckets.set(key, [candidate]);
			}
		}
		return [...buckets.values()].sort((left, right) =>
			compareHighValueControlCandidates(left[0], right[0]),
		);
	}

	private fillRemaining(): void {
		const buckets = this.buildRemainingBuckets();
		while (this.selected.length < this.limit && buckets.some((bucket) => bucket.length > 0)) {
			for (const bucket of buckets) {
				if (this.selected.length >= this.limit) {
					break;
				}
				const candidate = bucket.shift();
				if (candidate) {
					this.take(candidate);
				}
			}
		}
	}

	select(): SnapshotRefEntry[] {
		this.takeFirstPerDiversityBucket();
		for (const rule of SNAPSHOT_HIGH_VALUE_CONTROL_CATEGORY_RULES) {
			if (rule.fillTarget !== undefined) {
				this.topUp(rule.id, rule.fillTarget);
			}
		}
		this.fillRemaining();
		return this.selected.map((candidate) => candidate.entry);
	}
}

export function selectHighValueControlEntries(
	entries: readonly SnapshotRefEntry[],
	limit: number,
): SnapshotRefEntry[] {
	const candidates = entries
		.map(classifyHighValueControlRef)
		.filter((candidate) => candidate !== undefined)
		.sort(compareHighValueControlCandidates);
	return new HighValueSelection(candidates, limit).select();
}
