import { isRecord } from "../parsing.js";
import { getFullSnapshotData, getSnapshotRefRecord } from "./snapshot-refs.js";
import { stringifyUnknown } from "./text.js";

export function getSnapshotText(data: Readonly<Record<string, unknown>>): string | undefined {
	const full = getFullSnapshotData(data);
	if (typeof full?.snapshot === "string") {
		return full.snapshot;
	}
	return isRecord(data.snapshot) ? JSON.stringify(data.snapshot) : undefined;
}

export function getSnapshotOrigin(data: Readonly<Record<string, unknown>>): string {
	return typeof data.origin === "string" ? data.origin : "(unknown origin)";
}

export function formatSnapshotSummary(data: Readonly<Record<string, unknown>>): string {
	const origin = typeof data.origin === "string" ? data.origin : "page";
	if (isRecord(data.snapshot) && data.snapshot.kind !== "full") {
		return `Snapshot ${stringifyUnknown(data.snapshot.kind)}: revision ${stringifyUnknown(data.snapshot.revision)} on ${origin}`;
	}
	return `Snapshot: ${Object.keys(getSnapshotRefRecord(data) ?? {}).length} refs on ${origin}`;
}

export function formatRawSnapshotText(data: Readonly<Record<string, unknown>>): string {
	const origin = getSnapshotOrigin(data);
	const refs = Object.keys(getSnapshotRefRecord(data) ?? {}).length;
	const snapshot = getSnapshotText(data);
	if (isRecord(data.snapshot) && data.snapshot.kind !== "full") {
		return `Origin: ${origin}\n${formatSnapshotSummary(data)}\n\n${snapshot ?? "undefined"}`;
	}
	if (snapshot === undefined || snapshot.length === 0) {
		return `Origin: ${origin}\nRefs: ${refs}\n\n(no interactive elements)`;
	}
	return `Origin: ${origin}\nRefs: ${refs}\n\n${snapshot}`;
}
