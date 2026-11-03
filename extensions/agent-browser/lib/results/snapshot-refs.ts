import { isRecord } from "../parsing.js";
import { getEditableRefEvidence } from "./editable-ref-evidence.js";
import { compareRefIds, normalizeWhitespace } from "./text.js";

export interface SnapshotRefEntry {
	readonly id: string;
	readonly isEditable?: boolean;
	readonly lineIndex?: number;
	readonly name: string;
	readonly refData?: Readonly<Record<string, unknown>>;
	readonly role: string;
}

export interface SnapshotLineRefInfo {
	readonly index: number;
	readonly name: string;
	readonly raw: string;
	readonly ref?: string;
	readonly role: string;
}

/** Project native delta full responses onto the ordinary snapshot shape for local readers. */
export function getFullSnapshotData(data: unknown): Record<string, unknown> | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	if (!isRecord(data.snapshot)) {
		return data;
	}
	return data.snapshot.kind === "full"
		? { ...data, snapshot: data.snapshot.tree, refs: data.snapshot.refs }
		: undefined;
}

export function getSnapshotRefRecord(data: unknown): Record<string, unknown> | undefined {
	const full = getFullSnapshotData(data);
	return full && isRecord(full.refs) ? full.refs : undefined;
}

export function getSnapshotLineTextByRef(data: unknown): Map<string, string> {
	const full = getFullSnapshotData(data);
	const snapshot = typeof full?.snapshot === "string" ? full.snapshot : "";
	const lineByRef = new Map<string, string>();
	for (const line of snapshot.split("\n")) {
		const ref = line.match(/\bref=([^,\]\s]+)/)?.[1];
		if (ref === undefined || ref.length === 0 || lineByRef.has(ref)) {
			continue;
		}
		lineByRef.set(ref, line);
	}
	return lineByRef;
}

export function getSnapshotRefEntries(data: Readonly<Record<string, unknown>>): SnapshotRefEntry[] {
	const refs = getSnapshotRefRecord(data);
	if (!refs) {
		return [];
	}

	return Object.entries(refs)
		.map(([id, value]) => {
			if (!isRecord(value)) {
				return { id, name: "", role: "unknown" } satisfies SnapshotRefEntry;
			}
			const name = typeof value.name === "string" ? normalizeWhitespace(value.name) : "";
			const role = typeof value.role === "string" && value.role.length > 0 ? value.role : "unknown";
			const isEditable = getEditableRefEvidence({ ref: value });
			return { id, isEditable, name, refData: value, role } satisfies SnapshotRefEntry;
		})
		.sort((a, b) => compareRefIds(a.id, b.id));
}

function isEditableSnapshotLine(line: SnapshotLineRefInfo): boolean | undefined {
	const editableEvidence = getEditableRefEvidence({ text: line.raw });
	if (editableEvidence !== undefined) {
		return editableEvidence;
	}
	return line.role === "searchbox" || line.role === "textbox" || line.role === "combobox"
		? true
		: undefined;
}

export function normalizeAccessibleName(name: string): string {
	return normalizeWhitespace(name).toLowerCase();
}

export function getSnapshotRefRole(
	entry: { readonly role?: unknown },
	editableEvidence: boolean | undefined,
): string {
	const rawRole = typeof entry.role === "string" && entry.role.length > 0 ? entry.role : "unknown";
	const normalizedRole = rawRole.toLowerCase();
	if ((normalizedRole === "generic" || normalizedRole === "unknown") && editableEvidence === true) {
		return "textbox";
	}
	return rawRole;
}

function getSnapshotRefFallbackRole(role: string, line: SnapshotLineRefInfo | undefined): string {
	if (role !== "unknown" && role !== "generic") {
		return role;
	}
	return line && line.role !== "unknown" ? line.role : role;
}

function resolveSnapshotRefEditableEvidence(
	evidence: boolean | undefined,
	line: SnapshotLineRefInfo | undefined,
): boolean {
	if (evidence !== undefined) {
		return evidence;
	}
	return (
		line !== undefined &&
		isEditableSnapshotLine(line) === true &&
		!["unknown", "generic"].includes(line.role)
	);
}

export function enrichSnapshotRefEntries(
	refEntries: readonly SnapshotRefEntry[],
	snapshotLines: readonly SnapshotLineRefInfo[],
): SnapshotRefEntry[] {
	const lineByRef = new Map<string, SnapshotLineRefInfo>();
	for (const line of snapshotLines) {
		if (line.ref === undefined || line.ref.length === 0 || lineByRef.has(line.ref)) {
			continue;
		}
		lineByRef.set(line.ref, line);
	}

	return refEntries.map((entry) => {
		const line = lineByRef.get(entry.id);
		const editableEvidence = getEditableRefEvidence({ ref: entry.refData, text: line?.raw });
		const isEditable = resolveSnapshotRefEditableEvidence(editableEvidence, line);
		const roleFromRefOrLine = getSnapshotRefFallbackRole(entry.role, line);
		const role = getSnapshotRefRole({ role: roleFromRefOrLine }, isEditable);
		return {
			...entry,
			isEditable,
			lineIndex: line?.index,
			name: entry.name.length > 0 ? entry.name : (line?.name ?? ""),
			role,
		} satisfies SnapshotRefEntry;
	});
}
