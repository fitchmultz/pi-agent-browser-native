import { constants, openSync, closeSync, fstatSync } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];
import parser, { type Token } from "stream-json/parser.js";

import { BROWSER_TRANSITION_ENTRY, BROWSER_RESULT_TOOLS, applyArtifactChanges, getBrowserRecord, snapshotFromDefinition, type BrowserRecord } from "./browser-transcript.js";
import { isRecord } from "./parsing.js";

export interface JournalRange { offset: number; length: number }
export interface JournalEntry extends JournalRange { value: Record<string, unknown> }
const CHUNK_BYTES = 64 * 1024;
const ENVELOPE_MAX_BYTES = 16 * 1024 * 1024;

function selectedPath(path: Array<string | number>, fields: string[][]): boolean {
	const matches = (field: string, key: string | number | undefined) => field === key || field === "*" && typeof key === "number";
	return fields.some(field => field.every((key, index) => matches(key, path[index])) || path.every((key, index) => matches(field[index], key)));
}

/** Validate discarded values too; the parser never packs their strings or numbers. */
export async function projectJson(input: AsyncIterable<Uint8Array>, fields: string[][], maxBytes = ENVELOPE_MAX_BYTES): Promise<Record<string, unknown> | undefined> {
	async function* decode() {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		for await (const chunk of input) yield decoder.decode(chunk, { stream: true });
		const tail = decoder.decode();
		if (tail) yield tail;
	}
	const stack: Array<{ path: Array<string | number>; key?: string; index: number; value?: Record<string, unknown> | unknown[] }> = [];
	let root: unknown;
	let literal: { value: string; selected: boolean; number: boolean } | undefined;
	let inKey = false;
	let keyText = "";
	let bytes = 0;
	const reserve = (size: number) => {
		bytes += size;
		if (bytes > maxBytes) throw new Error("Selected journal envelope exceeds its bounded read size.");
	};
	const path = () => stack.length ? [...stack.at(-1)!.path, stack.at(-1)!.key ?? stack.at(-1)!.index] : [];
	const excluded = () => stack.length > 0 && stack.at(-1)!.value === undefined;
	const put = (value: unknown) => {
		const parent = stack.at(-1);
		if (!parent) root = value;
		else {
			if (parent.value && value !== undefined) {
				if (Array.isArray(parent.value)) parent.value[parent.index] = value;
				else Object.defineProperty(parent.value, parent.key!, { value, writable: true, enumerable: true, configurable: true });
			}
			parent.key = undefined;
			parent.index += 1;
		}
	};
	const consume = (token: Token) => {
		if (token.name === "startKey") { inKey = true; keyText = ""; return; }
		if (token.name === "endKey") { inKey = false; stack.at(-1)!.key = keyText; return; }
		if (inKey) {
			if (token.name === "stringChunk" && !excluded()) {
				const wholeContainer = fields.some(field => field.every((key, index) => stack.at(-1)!.path[index] === key || key === "*" && typeof stack.at(-1)!.path[index] === "number"));
				if (wholeContainer || keyText.length <= 1024) {
					if (wholeContainer) reserve(Buffer.byteLength(token.value));
					keyText += token.value;
				}
			}
			return;
		}
		if (token.name === "startObject" || token.name === "startArray") {
			if (stack.length >= 1024) throw new Error("Journal JSON nesting exceeds 1024 levels.");
			// Excluded containers cannot contain a requested descendant. Validate their tokens
			// without allocating a path/key for each ref in an old repeated map.
			const currentPath = excluded() ? [] : path();
			const selected = !excluded() && selectedPath(currentPath, fields);
			if (selected) reserve(32);
			stack.push({ path: currentPath, index: 0, value: selected ? token.name === "startObject" ? {} : [] : undefined });
		} else if (token.name === "endObject" || token.name === "endArray") put(stack.pop()!.value);
		else if (token.name === "startString" || token.name === "startNumber") literal = { value: "", selected: !excluded() && selectedPath(path(), fields), number: token.name === "startNumber" };
		else if (token.name === "stringChunk" || token.name === "numberChunk") {
			if (literal?.selected) { reserve(Buffer.byteLength(token.value)); literal.value += token.value; }
		} else if (token.name === "endString" || token.name === "endNumber") {
			put(literal?.selected ? literal.number ? Number(literal.value) : literal.value : undefined);
			literal = undefined;
		} else if (token.name === "trueValue" || token.name === "falseValue" || token.name === "nullValue") {
			const selected = !excluded() && selectedPath(path(), fields);
			if (selected) reserve(8);
			put(selected ? token.name === "nullValue" ? null : token.name === "trueValue" : undefined);
		}
	};
	const sink = new Writable({ objectMode: true, write(token: Token, _encoding, done) {
		try { consume(token); done(); } catch (error) { done(error as Error); }
	} });
	await pipeline(Readable.from(decode()), parser.asStream({ packValues: false, streamValues: true }), sink);
	return isRecord(root) ? root : undefined;
}

export async function* readRange(file: FileHandle, range: JournalRange): AsyncGenerator<Uint8Array> {
	let position = range.offset;
	const end = range.offset + range.length;
	while (position < end) {
		const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
		if (!bytesRead) throw new Error("Journal changed or truncated during read.");
		position += bytesRead;
		yield buffer.subarray(0, bytesRead);
	}
}

/** Byte framing, not readline: even a single discarded value may exceed V8's string limit. */
export async function* journalRanges(file: FileHandle, end: number, sealed = false, offset = 0): AsyncGenerator<JournalRange> {
	let position = offset;
	let start = offset;
	let nonblank = false;
	while (position < end) {
		const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
		if (!bytesRead) throw new Error("Journal truncated during read.");
		for (let index = 0; index < bytesRead; index++) {
			const byte = buffer[index];
			if (byte === 10) {
				if (nonblank) yield { offset: start, length: position + index + 1 - start };
				start = position + index + 1;
				nonblank = false;
			} else if (![9, 13, 32].includes(byte)) nonblank = true;
		}
		position += bytesRead;
	}
	if (nonblank && sealed) yield { offset: start, length: end - start };
}

const STRUCTURAL_FIELDS = [["type"], ["id"], ["parentId"], ["timestamp"], ["version"], ["customType"], ["data", "event", "version"], ["data", "snapshot", "id"], ["message", "toolName"], ["message", "details", "browserEventVersion"], ["message", "details", "sessionName"], ["message", "details", "artifactManifest", "version"], ["message", "details", "electron", "action"]];
const REPLAY_CUSTOM_TYPES = new Set([BROWSER_TRANSITION_ENTRY, "agent-browser-recording-reservation", "agent-browser-script-session"]);

export async function scanJournalMetadata(file: FileHandle, end: number, sealed = false): Promise<JournalEntry[]> {
	const entries: JournalEntry[] = [];
	for await (const range of journalRanges(file, end, sealed)) {
		const value = await projectJson(readRange(file, range), STRUCTURAL_FIELDS);
		if (!value) throw new Error(`Expected a journal object at byte ${range.offset}.`);
		entries.push({ ...range, value });
	}
	return entries;
}

function branchEntries(entries: JournalEntry[], leaf: string | null): JournalEntry[] {
	const byId = new Map<string, JournalEntry>();
	for (const entry of entries) {
		const id = entry.value.id;
		if (typeof id !== "string" || byId.has(id)) throw new Error("Journal has a missing or duplicate native entry identity.");
		byId.set(id, entry);
	}
	const branch: JournalEntry[] = [];
	const seen = new Set<string>();
	while (leaf !== null) {
		if (seen.has(leaf)) throw new Error("Journal ancestry contains a cycle.");
		seen.add(leaf);
		const entry = byId.get(leaf);
		if (!entry) throw new Error(`Selected journal entry ${leaf} is not persisted; browser work requires a committed conversation.`);
		branch.push(entry);
		if (entry.value.parentId !== null && typeof entry.value.parentId !== "string") throw new Error("Invalid journal parent identity.");
		leaf = entry.value.parentId as string | null;
	}
	return branch.reverse();
}

export async function readBrowserEntries(manager: ReadonlySessionManager, physical = false): Promise<unknown[]> {
	const inMemory = () => {
		const entries: unknown[] = physical ? manager.getEntries() : [];
		if (!physical) {
			const seen = new Set<string>();
			let leaf = manager.getLeafId();
			while (leaf !== null) {
				if (seen.has(leaf)) throw new Error("In-memory journal ancestry contains a cycle.");
				seen.add(leaf);
				const entry = manager.getEntry(leaf);
				if (!entry || entry.parentId !== null && typeof entry.parentId !== "string") throw new Error("In-memory journal ancestry is incomplete.");
				entries.push(entry);
				leaf = entry.parentId;
			}
			entries.reverse();
		}
		for (const entry of entries) {
			if (isRecord(entry) && entry.type === "custom" && [BROWSER_TRANSITION_ENTRY, "agent-browser-script-session"].includes(String(entry.customType)) && !getBrowserRecord(entry)) {
				throw new Error("Legacy browser records require stopped separate-copy conversion before replay.");
			}
			if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && BROWSER_RESULT_TOOLS.has(String(entry.message.toolName))
				&& isRecord(entry.message.details) && entry.message.details.browserEventVersion !== 1 && !getBrowserRecord(entry)) {
				throw new Error("Legacy browser observations require stopped separate-copy conversion before replay.");
			}
		}
		return entries;
	};
	const path = manager.getSessionFile();
	if (!path) {
		// Public in-memory ancestry is the only fallback. No writable SessionManager is constructed.
		return inMemory();
	}
	const leaf = physical ? null : manager.getLeafId();
	let file: FileHandle;
	try { file = await open(path, constants.O_RDONLY); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return inMemory();
		throw error;
	}
	try {
		const captured = await file.stat();
		if (!captured.isFile()) throw new Error("Pi session journal is not a regular file.");
		const metadata = await scanJournalMetadata(file, captured.size);
		const header = metadata.find(entry => entry.value.type === "session");
		if (header?.value.id !== (manager.getHeader()?.id ?? manager.getSessionId())) throw new Error("Pi session journal identity does not match the active session.");
		const publicManager = manager as Omit<ReadonlySessionManager, "getEntryMetadata" | "iterateEntryMetadata"> & {
			getEntryMetadata?: (id: string) => unknown;
			iterateEntryMetadata?: (options?: { branchFrom?: string | null }) => Iterable<{ id: string; parentId: string | null }>;
		};
		const selected = physical ? metadata.filter(entry => entry.value.type !== "session") : branchEntries(metadata.filter(entry => entry.value.type !== "session"), leaf);
		if (publicManager.iterateEntryMetadata) {
			const native = new Map([...publicManager.iterateEntryMetadata(physical ? {} : { branchFrom: leaf })].map(entry => [entry.id, entry.parentId]));
			for (const entry of selected) if (typeof entry.value.id !== "string" || native.get(entry.value.id) !== entry.value.parentId) throw new Error("Published browser journal ancestry differs from the native selected boundary.");
		}
		const projected: unknown[] = [];
		const definitions = new Map<string, JournalEntry>();
		for (const entry of selected) {
			const { value } = entry;
			const definition = isRecord(value.data) && isRecord(value.data.snapshot) ? value.data.snapshot.id : undefined;
			if (typeof definition === "string") {
				if (definitions.has(definition)) throw new Error("Browser snapshot identity is defined more than once on this ancestry.");
				definitions.set(definition, entry);
			}
			const legacy = value.type === "custom" && (value.customType === BROWSER_TRANSITION_ENTRY || value.customType === "agent-browser-script-session")
				&& !(isRecord(value.data) && isRecord(value.data.event) && value.data.event.version === 1);
			const message = isRecord(value.message) ? value.message : undefined;
			const legacyResult = message && typeof message.toolName === "string" && BROWSER_RESULT_TOOLS.has(message.toolName)
				&& (!isRecord(message.details) || message.details.browserEventVersion !== 1)
				&& !(isRecord(value.data) && isRecord(value.data.event) && value.data.event.version === 1)
				&& isRecord(message.details) && (message.details.sessionName !== undefined || message.details.artifactManifest !== undefined || message.details.electron !== undefined);
			if (legacy || legacyResult) throw new Error("This session contains legacy browser records. Convert a stopped separate copy with npm exec --package pi-agent-browser-native -- pi-agent-browser-convert before resuming browser work; the original journal is retained.");
			if (value.type === "custom" && REPLAY_CUSTOM_TYPES.has(String(value.customType)) || isRecord(value.data) && isRecord(value.data.event) || definition !== undefined) {
				const fields = value.customType === BROWSER_TRANSITION_ENTRY || value.type === "message" ? [["data", "event"], ["data", "snapshot", "id"]] : [["data"]];
				const body = await projectJson(readRange(file, entry), fields);
				projected.push({ ...value, ...body });
			}
		}
		// Resolve only the definitions that actually win on this ancestry. An unresolved begin
		// retains an inaccessible candidate ID; it does not request historical ref payloads.
		const { SessionPageState } = await import("./session-page-state.js");
		const reduced = SessionPageState.fromBranch(projected);
		const winners = new Set((physical ? [] : [...reduced.views().values()]).flatMap(page => page.refSnapshot?.snapshotId ? [page.refSnapshot.snapshotId] : []));
		for (const id of winners) {
			const entry = definitions.get(id);
			if (!entry) throw new Error(`Browser snapshot ${id} has no ancestral definition; inspect and take a fresh snapshot.`);
			// ponytail: a requested individual snapshot must fit its consumer's memory. Metadata
			// scans skip unlimited unrelated values; upgrade with native per-value paging if needed.
			const native = publicManager.getEntryMetadata && typeof entry.value.id === "string" ? manager.getEntry(entry.value.id) : undefined;
			const body = native && isRecord(native) && isRecord(native.data) ? { data: native.data }
				: await projectJson(readRange(file, entry), [["data", "snapshot"]], Infinity);
			const destination = projected.find(candidate => isRecord(candidate) && candidate.id === entry.value.id);
			if (!isRecord(destination) || !isRecord(destination.data) || !isRecord(body?.data)) throw new Error("Winning browser snapshot could not be read.");
			destination.data.snapshot = body.data.snapshot;
			if (!isRecord(body.data.snapshot) || body.data.snapshot.id !== id) throw new Error("Winning browser snapshot identity is invalid.");
			snapshotFromDefinition(body.data.snapshot as unknown as NonNullable<BrowserRecord["snapshot"]>);
		}
		let manifest;
		for (const entry of projected) manifest = applyArtifactChanges(manifest, getBrowserRecord(entry)?.event.artifacts);
		const current = await file.stat();
		const currentPath = await stat(path);
		if (current.dev !== captured.dev || current.ino !== captured.ino || current.size < captured.size || currentPath.dev !== captured.dev || currentPath.ino !== captured.ino) throw new Error("Pi journal replaced or truncated during replay.");
		return projected;
	} finally { await file.close(); }
}

/** A filename is not durability evidence on official Pi before its first conversation. */
export function requirePublishedBrowserJournal(manager: ReadonlySessionManager): void {
	const path = manager.getSessionFile();
	if (!path) throw new Error("Browser code requires a published Pi conversation; relaunch without --no-session.");
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size === 0) throw new Error("Pi conversation has not been published yet.");
	} catch (error) {
		throw new Error("Browser work requires an actually published Pi conversation before dispatch; send a user message first.", { cause: error });
	} finally { if (fd !== undefined) closeSync(fd); }
}

/** Observation-only artifact receipts are optional until Pi publishes its journal. */
export function hasPublishedBrowserJournal(manager: ReadonlySessionManager): boolean {
	try { requirePublishedBrowserJournal(manager); return true; }
	catch { return false; }
}

export interface BrowserBranch {
	readonly sessionId: string;
	anchorId: string | null;
	isCurrent(): boolean;
}

/** Capture before waiting: native selection precedes sequential session_tree handlers. */
export function captureBrowserBranch(manager: ReadonlySessionManager, isGenerationCurrent: () => boolean): BrowserBranch {
	const sessionId = manager.getSessionId();
	const branch: BrowserBranch = { sessionId, anchorId: manager.getLeafId(), isCurrent() {
		if (!isGenerationCurrent() || manager.getSessionId() !== sessionId) return false;
		let leaf = manager.getLeafId();
		// Empty selection is not a universal ancestor of other independent roots.
		let current = branch.anchorId === null && leaf === null;
		const seen = new Set<string>();
		while (leaf !== null) {
			if (typeof leaf !== "string" || seen.has(leaf)) throw new Error("Selected Pi journal ancestry is invalid or cyclic.");
			seen.add(leaf);
			const entry = manager.getEntry(leaf);
			if (!entry || entry.id !== leaf || entry.parentId !== null && typeof entry.parentId !== "string") throw new Error("Selected Pi journal ancestry is incomplete.");
			if (leaf === branch.anchorId) current = true;
			leaf = entry.parentId;
		}
		return current;
	} };
	return branch;
}

/** A withdrawn branch returns false; required publication faults still throw. */
export async function appendBrowserRecord(manager: ReadonlySessionManager, append: () => void, expected: BrowserRecord, branch: BrowserBranch): Promise<boolean> {
	if (!manager.getSessionFile()) {
		if (!branch.isCurrent()) return false;
		append();
		if (branch.anchorId === null) branch.anchorId = manager.getLeafId();
		return branch.isCurrent();
	}
	requirePublishedBrowserJournal(manager);
	const path = manager.getSessionFile()!;
	const beforeFile = await open(path, constants.O_RDONLY);
	let file: FileHandle | undefined;
	try {
		const before = await beforeFile.stat();
		// Native navigation changes the leaf before its awaited session_tree handlers.
		if (!branch.isCurrent()) return false;
		append();
		const nativeId = manager.getLeafId();
		if (branch.anchorId === null) branch.anchorId = nativeId;
		// Native repair can flush several accepted records or replace the journal.
		// Reopen its published locator and frame records instead of parsing the suffix as one value.
		file = await open(path, constants.O_RDONLY);
		const after = await file.stat();
		const sameFile = after.dev === before.dev && after.ino === before.ino;
		if (!after.isFile() || sameFile && after.size <= before.size) throw new Error("Pi did not publish the browser event.");
		let matches = 0;
		const fields = [["type"], ["id"], ["customType"], ["data", "event", "version"], ["data", "event", "operationId"], ["data", "event", "phase"], ["data", "event", "toolCallId"], ["data", "event", "commandIndex"]];
		for await (const range of journalRanges(file, after.size, false, sameFile ? before.size : 0)) {
			const value = await projectJson(readRange(file, range), fields);
			const event = isRecord(value?.data) && isRecord(value.data.event) ? value.data.event : undefined;
			if (value?.type === "session" && value.id !== (manager.getHeader()?.id ?? manager.getSessionId())) throw new Error("Pi repaired journal identity differs from the active session.");
			if (value?.id === nativeId && value?.type === "custom" && value.customType === BROWSER_TRANSITION_ENTRY
				&& event?.version === 1 && event.operationId === expected.event.operationId && event.phase === expected.event.phase
				&& event.toolCallId === expected.event.toolCallId && event.commandIndex === expected.event.commandIndex) matches += 1;
		}
		const current = await stat(path);
		if (matches !== 1 || current.dev !== after.dev || current.ino !== after.ino || current.size < after.size) throw new Error("Pi browser append has no matching published journal receipt.");
	} finally { await file?.close(); await beforeFile.close(); }
	return branch.isCurrent();
}
