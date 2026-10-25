import type { FileHandle } from "node:fs/promises";
import {
	JOURNAL_CHUNK_BYTES,
	NATIVE_RECORD_BYTES,
	projectJson,
	projectJsonBytes,
} from "./browser-journal-projection.js";
export { projectJson } from "./browser-journal-projection.js";
export interface JournalRange {
	readonly offset: number;
	readonly length: number;
}
/** A framed record carries its bytes when small enough to retain while framing. */
export interface JournalRecord extends JournalRange {
	readonly bytes?: Uint8Array;
}
export interface JournalEntry extends JournalRange {
	readonly value: Readonly<Record<string, unknown>>;
}

export async function* readRange(
	file: FileHandle,
	range: JournalRange,
): AsyncGenerator<Uint8Array> {
	let position = range.offset;
	const end = range.offset + range.length;
	while (position < end) {
		const buffer = Buffer.allocUnsafe(Math.min(JOURNAL_CHUNK_BYTES, end - position));
		// The next range read depends on the bytes actually returned by this read.
		// oxlint-disable-next-line no-await-in-loop
		const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
		if (bytesRead === 0) {
			throw new Error("Journal changed or truncated during read.");
		}
		position += bytesRead;
		yield buffer.subarray(0, bytesRead);
	}
}

function hasContent(buffer: Uint8Array, start: number, end: number): boolean {
	for (let index = start; index < end; index++) {
		const byte = buffer[index];
		if (byte !== 9 && byte !== 13 && byte !== 32) {
			return true;
		}
	}
	return false;
}

/** Byte framing, not readline: even one discarded value can exceed V8's string limit. */
class JournalLineFramer {
	private start: number;
	private nonblank = false;
	private parts: Buffer[] | undefined = [];
	private held = 0;
	constructor(offset: number) {
		this.start = offset;
	}
	*accept(buffer: Buffer, position: number): Generator<JournalRecord> {
		let index = 0;
		while (index < buffer.length) {
			const newline = buffer.indexOf(10, index);
			const end = newline === -1 ? buffer.length : newline;
			this.nonblank ||= hasContent(buffer, index, end);
			this.hold(buffer.subarray(index, newline === -1 ? end : end + 1));
			if (newline === -1) {
				return;
			}
			const record = this.take(position + newline + 1);
			if (record) {
				yield record;
			}
			index = newline + 1;
		}
	}
	final(end: number, sealed: boolean): JournalRecord | undefined {
		return sealed ? this.take(end) : undefined;
	}
	private hold(part: Buffer): void {
		this.held += part.length;
		if (this.held > NATIVE_RECORD_BYTES) {
			this.parts = undefined;
		} else {
			this.parts?.push(part);
		}
	}
	private take(next: number): JournalRecord | undefined {
		let record: JournalRecord | undefined;
		if (this.nonblank) {
			const range = { offset: this.start, length: next - this.start };
			record = this.parts ? { ...range, bytes: Buffer.concat(this.parts) } : range;
		}
		this.start = next;
		this.nonblank = false;
		this.parts = [];
		this.held = 0;
		return record;
	}
}
export async function* journalRanges(
	file: FileHandle,
	end: number,
	sealed = false,
	offset = 0,
): AsyncGenerator<JournalRecord> {
	let position = offset;
	const framer = new JournalLineFramer(offset);
	while (position < end) {
		const buffer = Buffer.allocUnsafe(Math.min(JOURNAL_CHUNK_BYTES, end - position));
		// Byte offsets and line framing depend on the preceding read's actual length.
		// oxlint-disable-next-line no-await-in-loop
		const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
		if (bytesRead === 0) {
			throw new Error("Journal truncated during read.");
		}
		yield* framer.accept(buffer.subarray(0, bytesRead), position);
		position += bytesRead;
	}
	const final = framer.final(end, sealed);
	if (final) {
		yield final;
	}
}

const STRUCTURAL_FIELDS = [
	["type"],
	["id"],
	["parentId"],
	["timestamp"],
	["version"],
	["customType"],
	["data", "event", "version"],
	["data", "snapshot", "id"],
	["message", "toolName"],
	["message", "details", "browserEventVersion"],
	["message", "details", "sessionName"],
	["message", "details", "artifactManifest", "version"],
	["message", "details", "electron", "action"],
];
export async function scanJournalMetadata(
	file: FileHandle,
	end: number,
	sealed = false,
): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const range of journalRanges(file, end, sealed)) {
		const value = range.bytes
			? await projectJsonBytes(range.bytes, STRUCTURAL_FIELDS)
			: await projectJson(readRange(file, range), STRUCTURAL_FIELDS);
		if (!value) {
			throw new Error(`Expected a journal object at byte ${range.offset}.`);
		}
		// Retained record bytes are framing scratch, not metadata.
		entries.push({ offset: range.offset, length: range.length, value });
	}
	return entries;
}
