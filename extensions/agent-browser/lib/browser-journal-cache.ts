import type { FileHandle } from "node:fs/promises";
import { scanJournalMetadata, type JournalEntry } from "./browser-journal-reader.js";

export interface JournalFingerprint {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}
interface PublishedMetadata {
	readonly captured: JournalFingerprint;
	readonly entries: readonly JournalEntry[];
}
const MAX_CACHED_JOURNALS = 4;
const journals = new Map<string, PublishedMetadata>();

export function sameJournalFingerprint(
	left: JournalFingerprint,
	right: JournalFingerprint,
): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

export async function readPublishedJournalMetadata(
	file: FileHandle,
	path: string,
	captured: JournalFingerprint,
): Promise<readonly JournalEntry[]> {
	const previous = journals.get(path);
	journals.delete(path);
	if (previous && sameJournalFingerprint(previous.captured, captured)) {
		journals.set(path, previous);
		return previous.entries;
	}
	// Any change rescans the whole file: append alone cannot prove an unchanged prefix.
	const entries = await scanJournalMetadata(file, Number(captured.size));
	journals.set(path, { captured, entries });
	if (journals.size > MAX_CACHED_JOURNALS) {
		const oldest = journals.keys().next().value;
		if (oldest !== undefined) {
			journals.delete(oldest);
		}
	}
	return entries;
}
