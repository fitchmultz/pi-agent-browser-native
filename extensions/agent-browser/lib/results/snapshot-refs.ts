/**
 * Purpose: Own canonical parsing and enrichment of refs from agent-browser snapshot payloads.
 * Responsibilities: Read structured refs, correlate them with raw snapshot lines, and infer editable/ref role evidence once for consumers.
 * Scope: Snapshot ref metadata only; section preview, high-value ranking, and presentation assembly live in neighboring modules.
 * Usage: Imported by snapshot presentation and recovery diagnostics that need consistent ref/name/role/editable evidence.
 * Invariants/Assumptions: Snapshot text parsing is best-effort and must tolerate upstream formatting changes by preserving structured ref data when line parsing fails.
 */

import { isRecord } from "../parsing.js";
import { getEditableRefEvidence } from "./editable-ref-evidence.js";
import { compareRefIds, normalizeWhitespace } from "./text.js";

export interface SnapshotRefEntry {
	id: string;
	isEditable?: boolean;
	lineIndex?: number;
	name: string;
	refData?: Record<string, unknown>;
	role: string;
}

export interface SnapshotLineRefInfo {
	index: number;
	name: string;
	raw: string;
	ref?: string;
	role: string;
}

export function getSnapshotRefRecord(data: unknown): Record<string, unknown> | undefined {
	return isRecord(data) && isRecord(data.refs) ? data.refs : undefined;
}

export function getSnapshotLineTextByRef(data: unknown): Map<string, string> {
	const snapshot = isRecord(data) && typeof data.snapshot === "string" ? data.snapshot : "";
	const lineByRef = new Map<string, string>();
	for (const line of snapshot.split("\n")) {
		const ref = line.match(/\bref=([^,\]\s]+)/)?.[1];
		if (!ref || lineByRef.has(ref)) continue;
		lineByRef.set(ref, line);
	}
	return lineByRef;
}

export function getSnapshotRefEntries(data: Record<string, unknown>): SnapshotRefEntry[] {
	const refs = getSnapshotRefRecord(data);
	if (!refs) return [];

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
	if (editableEvidence !== undefined) return editableEvidence;
	return line.role === "searchbox" || line.role === "textbox" || line.role === "combobox" ? true : undefined;
}

export function getSnapshotRefRole(entry: { role?: unknown }, editableEvidence: boolean | undefined): string {
	const rawRole = typeof entry.role === "string" && entry.role.length > 0 ? entry.role : "unknown";
	const normalizedRole = rawRole.toLowerCase();
	if ((normalizedRole === "generic" || normalizedRole === "unknown") && editableEvidence === true) {
		return "textbox";
	}
	return rawRole;
}

export function enrichSnapshotRefEntries(refEntries: SnapshotRefEntry[], snapshotLines: SnapshotLineRefInfo[]): SnapshotRefEntry[] {
	const lineByRef = new Map<string, SnapshotLineRefInfo>();
	for (const line of snapshotLines) {
		if (!line.ref || lineByRef.has(line.ref)) continue;
		lineByRef.set(line.ref, line);
	}

	return refEntries.map((entry) => {
		const line = lineByRef.get(entry.id);
		const lineRole = line && line.role !== "unknown" ? line.role : undefined;
		const editableEvidence = getEditableRefEvidence({ ref: entry.refData, text: line?.raw });
		const hasEditableRole = line ? isEditableSnapshotLine(line) === true && !["unknown", "generic"].includes(line.role) : false;
		const isEditable = editableEvidence === true || (editableEvidence !== false && hasEditableRole);
		const roleFromRefOrLine = entry.role !== "unknown" && entry.role !== "generic" ? entry.role : lineRole ?? entry.role;
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
