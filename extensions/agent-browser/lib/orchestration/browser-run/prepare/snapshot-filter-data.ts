import { isRecord } from "../../../parsing.js";
import type { SessionRefSnapshot } from "../../../session-page-state.js";

export interface SnapshotFilterRequest {
	readonly cleanArgs: readonly string[];
	readonly diff: boolean;
	readonly role?: string | undefined;
	readonly search?: string | undefined;
	readonly viewport: boolean;
}

export function hasSnapshotText(value: string | undefined): value is string {
	return value !== undefined && value !== "";
}

function filterOperand(
	tokens: readonly string[],
	index: number,
): { readonly role?: string; readonly search?: string } | undefined {
	const token = tokens[index];
	if (token !== "--search" && token !== "--filter") {
		return undefined;
	}
	const value = tokens.at(index + 1);
	if (value === undefined || value.startsWith("-")) {
		return undefined;
	}
	if (token === "--search") {
		return { search: value };
	}
	const role = /^role=(.+)$/i.exec(value.trim())?.at(1);
	return hasSnapshotText(role) ? { role: role.trim().toLowerCase() } : {};
}

export function snapshotHasTextFilters(
	request: Pick<SnapshotFilterRequest, "role" | "search">,
): boolean {
	return hasSnapshotText(request.role) || hasSnapshotText(request.search);
}

export function parseSnapshotFilterRequest(
	commandTokens: readonly string[],
): SnapshotFilterRequest | undefined {
	if (commandTokens[0] !== "snapshot") {
		return undefined;
	}
	const cleanArgs: string[] = [];
	let role: string | undefined;
	let search: string | undefined;
	const tokens = commandTokens.entries();
	for (const [index, token] of tokens) {
		// Wrapper filters require the complete native tree, never a revision-relative patch.
		if (["--delta", "--full", "--viewport", "--diff"].includes(token)) {
			continue;
		}
		const operand = filterOperand(commandTokens, index);
		if (operand) {
			if (operand.search !== undefined) {
				search = operand.search;
			}
			if (operand.role !== undefined) {
				role = operand.role;
			}
			tokens.next();
		} else {
			cleanArgs.push(token);
		}
	}
	const viewport = commandTokens.includes("--viewport");
	const diff = commandTokens.includes("--diff");
	return snapshotHasTextFilters({ role, search }) || viewport || diff
		? { cleanArgs, diff, role, search, viewport }
		: undefined;
}

export interface SnapshotDiffSummary {
	readonly addedRefs: readonly string[];
	readonly changedRefs: readonly string[];
	readonly removedRefs: readonly string[];
	readonly summary: string;
	readonly unchangedRefs: number;
}

export function buildSnapshotDiff(
	previous: SessionRefSnapshot | undefined,
	current: SessionRefSnapshot | undefined,
): SnapshotDiffSummary | undefined {
	if (!current) {
		return undefined;
	}
	const currentRefs = new Map(Object.entries(current.refs ?? {}));
	const previousRefs = new Map(Object.entries(previous?.refs ?? {}));
	if (!previous) {
		return {
			addedRefs: [...currentRefs.keys()],
			changedRefs: [],
			removedRefs: [],
			summary: `Snapshot diff: no previous snapshot; ${currentRefs.size} current refs recorded.`,
			unchangedRefs: 0,
		};
	}
	const addedRefs: string[] = [];
	const changedRefs: string[] = [];
	let unchangedRefs = 0;
	for (const [refId, currentRef] of currentRefs) {
		const previousRef = previousRefs.get(refId);
		if (!previousRef) {
			addedRefs.push(refId);
		} else if (previousRef.role !== currentRef.role || previousRef.name !== currentRef.name) {
			changedRefs.push(refId);
		} else {
			unchangedRefs += 1;
		}
	}
	const removedRefs = [...previousRefs.keys()].filter((refId) => !currentRefs.has(refId));
	return {
		addedRefs,
		changedRefs,
		removedRefs,
		summary: `Snapshot diff: +${addedRefs.length} / -${removedRefs.length} / Δ${changedRefs.length} refs versus previous snapshot.`,
		unchangedRefs,
	};
}

export interface FilteredSnapshot {
	readonly data: Readonly<Record<string, unknown>>;
	readonly matchedRefs: number;
	readonly totalRefs: number;
	readonly totalLines: number;
	readonly visibleLines: number;
}

function refMatches(value: unknown, request: SnapshotFilterRequest): boolean {
	if (!isRecord(value)) {
		return false;
	}
	const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
	const name = typeof value.name === "string" ? value.name : "";
	const search = request.search?.trim().toLowerCase();
	return (
		(!hasSnapshotText(request.role) || role === request.role) &&
		(!hasSnapshotText(search) || `${role} ${name}`.toLowerCase().includes(search))
	);
}

function snapshotLineMatches(
	line: string,
	refs: ReadonlySet<string>,
	search: string | undefined,
): boolean {
	return (
		(hasSnapshotText(search) && line.toLowerCase().includes(search)) ||
		[...refs].some((refId) => line.includes(`[ref=${refId}]`) || line.includes(`ref=${refId}`))
	);
}

function filterDescription(request: SnapshotFilterRequest): string {
	return [
		hasSnapshotText(request.role) ? `role=${request.role}` : undefined,
		hasSnapshotText(request.search) ? `search=${JSON.stringify(request.search)}` : undefined,
	]
		.filter((part) => part !== undefined)
		.join(", ");
}

export function filterSnapshotData(
	data: unknown,
	request: SnapshotFilterRequest,
): FilteredSnapshot | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	const refs = isRecord(data.refs) ? data.refs : {};
	const snapshot = typeof data.snapshot === "string" ? data.snapshot : "";
	const lines = snapshot.split(/\r?\n/);
	if (!hasSnapshotText(request.role) && !hasSnapshotText(request.search)) {
		const totalLines = lines.filter((line) => line.length > 0).length;
		return {
			data,
			matchedRefs: Object.keys(refs).length,
			totalRefs: Object.keys(refs).length,
			totalLines,
			visibleLines: totalLines,
		};
	}
	const matchingRefs = Object.entries(refs).filter(([, value]) => refMatches(value, request));
	const ids = new Set(matchingRefs.map(([id]) => id));
	const visibleLines = lines.filter((line) =>
		snapshotLineMatches(line, ids, request.search?.trim().toLowerCase()),
	);
	return {
		data: {
			...data,
			refs: Object.fromEntries(matchingRefs),
			snapshot:
				visibleLines.length > 0
					? visibleLines.join("\n")
					: `(no snapshot lines matched ${filterDescription(request)})`,
		},
		matchedRefs: matchingRefs.length,
		totalRefs: Object.keys(refs).length,
		totalLines: lines.filter((line) => line.length > 0).length,
		visibleLines: visibleLines.length,
	};
}
