import { constants, type Stats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { BrowserJournalManager } from "./browser-journal-contracts.js";
import {
	BROWSER_TRANSITION_ENTRY,
	BROWSER_RESULT_TOOLS,
	applyArtifactChanges,
	getBrowserRecord,
	snapshotFromDefinition,
	type BrowserRecord,
} from "./browser-transcript.js";
import { isRecord } from "./parsing.js";
import { getErrorCode } from "./process-errors.js";
import { BrowserConversionBranches } from "./browser-conversion-branches.js";
import {
	convertBrowserEntries,
	convertLegacyBrowserEntry,
	emptyProjection,
	type LegacyProjection,
} from "./browser-legacy-projection.js";
import { LEGACY_BROWSER_FIELDS } from "./browser-legacy-fields.js";
import { legacySnapshot } from "./browser-legacy-pages.js";
import { NATIVE_RECORD_BYTES, projectJsonBytes } from "./browser-journal-projection.js";
import {
	projectJson,
	readRange,
	scanJournalMetadata,
	type JournalEntry,
} from "./browser-journal-reader.js";
const REPLAY_CUSTOM_TYPES = new Set([
	BROWSER_TRANSITION_ENTRY,
	"agent-browser-recording-reservation",
	"agent-browser-script-session",
]);

interface JournalIndex {
	readonly path: string;
	readonly header: ReturnType<BrowserJournalManager["getHeader"]>;
	readonly captured: Stats;
	readonly metadata: readonly JournalEntry[];
}
// One structural index per live native manager; no payloads, refs or cross-manager ownership.
const journalIndexes = new WeakMap<BrowserJournalManager, JournalIndex>();

function appendCompatible(previous: Stats, current: Stats): boolean {
	return (
		previous.dev === current.dev &&
		previous.ino === current.ino &&
		current.size >= previous.size &&
		(current.size > previous.size ||
			(current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs))
	);
}

async function readJournalIndex(
	manager: BrowserJournalManager,
	file: FileHandle,
	path: string,
	captured: Stats,
): Promise<JournalIndex> {
	const previous = journalIndexes.get(manager);
	// A failed read/replay cannot leave an admitted prefix behind.
	journalIndexes.delete(manager);
	const reusable =
		previous?.path === path &&
		appendCompatible(previous.captured, captured) &&
		previous.header === manager.getHeader();
	// Both native hosts append records and replace header objects on reseed. An ordinary
	// same-size edit, rotation or truncation falls back to the full validating scanner.
	const prefix = reusable ? previous.metadata : [];
	const last = prefix.at(-1);
	const offset = last ? last.offset + last.length : 0;
	const suffix =
		reusable && captured.size === previous.captured.size
			? []
			: await scanJournalMetadata(file, captured.size, false, offset);
	return { path, header: manager.getHeader(), captured, metadata: [...prefix, ...suffix] };
}

function branchEntries(
	entries: readonly JournalEntry[],
	selectedLeaf: string | null,
): JournalEntry[] {
	const byId = new Map<string, JournalEntry>();
	for (const entry of entries) {
		const id = entry.value.id;
		if (typeof id !== "string" || byId.has(id)) {
			throw new Error("Journal has a missing or duplicate native entry identity.");
		}
		byId.set(id, entry);
	}
	const branch: JournalEntry[] = [];
	const seen = new Set<string>();
	let leaf = selectedLeaf;
	while (leaf !== null) {
		if (seen.has(leaf)) {
			throw new Error("Journal ancestry contains a cycle.");
		}
		seen.add(leaf);
		const entry = byId.get(leaf);
		if (!entry) {
			throw new Error(
				`Selected journal entry ${leaf} is not persisted; browser work requires a committed conversation.`,
			);
		}
		const parent = entry.value.parentId;
		if (parent !== null && typeof parent !== "string") {
			throw new Error("Invalid journal parent identity.");
		}
		branch.push(entry);
		leaf = parent;
	}
	return branch.reverse();
}
function canonicalVersion(entry: Readonly<Record<string, unknown>>): boolean {
	return isRecord(entry.data) && isRecord(entry.data.event) && entry.data.event.version === 1;
}
function legacyCustom(entry: Readonly<Record<string, unknown>>): boolean {
	return (
		entry.type === "custom" &&
		(entry.customType === BROWSER_TRANSITION_ENTRY ||
			entry.customType === "agent-browser-script-session") &&
		!canonicalVersion(entry)
	);
}
function browserMessage(
	entry: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
	const message = isRecord(entry.message) ? entry.message : undefined;
	return message &&
		typeof message.toolName === "string" &&
		BROWSER_RESULT_TOOLS.has(message.toolName)
		? message
		: undefined;
}
function legacyBrowserResult(entry: Readonly<Record<string, unknown>>): boolean {
	const message = browserMessage(entry);
	if (
		!message ||
		!isRecord(message.details) ||
		message.details.browserEventVersion === 1 ||
		canonicalVersion(entry)
	) {
		return false;
	}
	return (
		message.details.sessionName !== undefined ||
		message.details.artifactManifest !== undefined ||
		message.details.electron !== undefined
	);
}
function inMemoryEntries(manager: BrowserJournalManager, physical: boolean): unknown[] {
	const entries: unknown[] = physical ? manager.getEntries() : [];
	if (!physical) {
		const seen = new Set<string>();
		let leaf = manager.getLeafId();
		while (leaf !== null) {
			if (seen.has(leaf)) {
				throw new Error("In-memory journal ancestry contains a cycle.");
			}
			seen.add(leaf);
			const entry = manager.getEntry(leaf);
			if (!isRecord(entry) || (entry.parentId !== null && typeof entry.parentId !== "string")) {
				throw new Error("In-memory journal ancestry is incomplete.");
			}
			entries.push(entry);
			leaf = entry.parentId;
		}
		entries.reverse();
	}
	return convertBrowserEntries(entries, legacyOwner(manager));
}

function legacyOwner(manager: BrowserJournalManager): string | undefined {
	const header = manager.getHeader();
	// A legacy fork without an explicit cleanup owner cannot acquire its parent's leases.
	return header?.parentSession !== undefined ? undefined : (header?.id ?? manager.getSessionId());
}

function replayFields(value: Readonly<Record<string, unknown>>, legacy: boolean): string[][] {
	if (legacy) {
		return LEGACY_BROWSER_FIELDS;
	}
	return value.customType === BROWSER_TRANSITION_ENTRY || value.type === "message"
		? [
				["data", "event"],
				["data", "snapshot", "id"],
			]
		: [["data"]];
}
function projectedRecord(value: Readonly<Record<string, unknown>>, record: BrowserRecord): unknown {
	return {
		...value,
		...(value.type === "custom" ? { customType: BROWSER_TRANSITION_ENTRY } : {}),
		data: {
			...record,
			...(isRecord(record.snapshot) ? { snapshot: { id: record.snapshot.id } } : {}),
		},
	};
}
function winningSnapshot(
	body: Readonly<Record<string, unknown>> | undefined,
	source: Readonly<{ legacy: boolean; root: string; id: string }>,
): unknown {
	if (!source.legacy) {
		return isRecord(body?.data) ? body.data.snapshot : undefined;
	}
	const value = body?.[source.root];
	return isRecord(value) && isRecord(value.details)
		? legacySnapshot(value.details.refSnapshot, source.id)
		: undefined;
}

/** A record the framer could retain uses the same native-or-token projection as the metadata scan. */
async function projectEntryBody(
	file: FileHandle,
	entry: JournalEntry,
	fields: readonly (readonly string[])[],
	maxBytes?: number,
): Promise<Record<string, unknown> | undefined> {
	if (entry.length > NATIVE_RECORD_BYTES) {
		return projectJson(readRange(file, entry), fields, maxBytes);
	}
	const parts: Uint8Array[] = [];
	for await (const part of readRange(file, entry)) {
		parts.push(part);
	}
	return projectJsonBytes(Buffer.concat(parts), fields, maxBytes);
}

class PublishedJournalReplay {
	private readonly projected: unknown[] = [];
	private readonly definitions = new Map<string, { entry: JournalEntry; legacy: boolean }>();
	private readonly branches: BrowserConversionBranches | undefined;
	constructor(
		private readonly file: FileHandle,
		entries: readonly JournalEntry[],
		private readonly ownerSessionId: string | undefined,
	) {
		if (entries.some(({ value }) => legacyCustom(value) || legacyBrowserResult(value))) {
			this.branches = new BrowserConversionBranches(entries.map(({ value }) => value.parentId));
		}
	}
	private parentProjection(parentId: unknown): LegacyProjection {
		return typeof parentId === "string"
			? (this.branches?.get(parentId) ?? emptyProjection())
			: emptyProjection();
	}
	async project(entries: readonly JournalEntry[]): Promise<void> {
		for (const entry of entries) {
			// Preserve journal order and bound selected envelope memory during replay.
			// oxlint-disable-next-line no-await-in-loop
			await this.projectEntry(entry);
		}
	}
	private async projectEntry(entry: JournalEntry): Promise<void> {
		const { value } = entry;
		const parent = this.parentProjection(value.parentId);
		const legacy = legacyCustom(value) || legacyBrowserResult(value);
		if (!legacy && !replayRelevant(value)) {
			this.advance(value, parent);
			return;
		}
		// Legacy maps are read one entry at a time, then discarded like non-winning native definitions.
		const body = await projectEntryBody(
			this.file,
			entry,
			replayFields(value, legacy),
			legacy ? Infinity : undefined,
		);
		const candidate = { ...value, ...body };
		const record = this.normalizeRecord(candidate, parent);
		this.rememberSnapshot(entry, legacy, record?.snapshot);
		this.projected.push(record ? projectedRecord(value, record) : candidate);
	}
	private normalizeRecord(
		candidate: Readonly<Record<string, unknown>>,
		parent: LegacyProjection,
	): BrowserRecord | undefined {
		const conversion = this.branches
			? convertLegacyBrowserEntry(candidate, parent, this.ownerSessionId)
			: undefined;
		this.advance(candidate, conversion?.projection ?? parent);
		return conversion?.record ?? getBrowserRecord(candidate);
	}
	private rememberSnapshot(entry: JournalEntry, legacy: boolean, snapshot: unknown): void {
		if (isRecord(snapshot) && typeof snapshot.id === "string") {
			if (this.definitions.has(snapshot.id)) {
				throw new Error("Browser snapshot identity is defined more than once on this ancestry.");
			}
			this.definitions.set(snapshot.id, { entry, legacy });
		}
	}
	private advance(value: Readonly<Record<string, unknown>>, projection: LegacyProjection): void {
		if (typeof value.id === "string") {
			this.branches?.advance(value.id, value.parentId, projection);
		}
	}
	async resolveWinningDefinitions(physical: boolean): Promise<unknown[]> {
		const { SessionPageState } = await import("./session-page-state.js");
		const reduced = SessionPageState.fromBranch(this.projected);
		const winners = new Set(
			(physical ? [] : [...reduced.views().values()]).flatMap((page) =>
				page.refSnapshot?.snapshotId !== undefined && page.refSnapshot.snapshotId.length > 0
					? [page.refSnapshot.snapshotId]
					: [],
			),
		);
		for (const id of winners) {
			// Each winning snapshot is materialized once, without retaining unrelated historical ref maps.
			// oxlint-disable-next-line no-await-in-loop
			await this.resolveDefinition(id);
		}
		let manifest;
		for (const entry of this.projected) {
			manifest = applyArtifactChanges(manifest, getBrowserRecord(entry)?.event.artifacts);
		}
		return this.projected;
	}
	private async resolveDefinition(id: string): Promise<void> {
		const definition = this.definitions.get(id);
		if (!definition) {
			throw new Error(
				`Browser snapshot ${id} has no ancestral definition; inspect and take a fresh snapshot.`,
			);
		}
		// ponytail: a requested individual snapshot must fit the consumer's memory; upgrade with native per-value paging if needed.
		const { entry, legacy } = definition;
		const root = entry.value.type === "message" ? "message" : "data";
		const body = await projectEntryBody(
			this.file,
			entry,
			legacy ? [[root, "details", "refSnapshot"]] : [["data", "snapshot"]],
			Infinity,
		);
		const resolved = winningSnapshot(body, { root, legacy, id });
		const destination = this.projected.find(
			(candidate) => isRecord(candidate) && candidate.id === entry.value.id,
		);
		if (!isRecord(destination) || !isRecord(destination.data)) {
			throw new Error("Winning browser snapshot could not be read.");
		}
		destination.data.snapshot = resolved;
		if (!isRecord(resolved) || resolved.id !== id) {
			throw new Error("Winning browser snapshot identity is invalid.");
		}
		snapshotFromDefinition(resolved);
	}
}
function replayRelevant(value: Readonly<Record<string, unknown>>): boolean {
	return (
		(value.type === "custom" &&
			typeof value.customType === "string" &&
			REPLAY_CUSTOM_TYPES.has(value.customType)) ||
		(isRecord(value.data) && isRecord(value.data.event)) ||
		(isRecord(value.data) && isRecord(value.data.snapshot) && value.data.snapshot.id !== undefined)
	);
}
async function verifyCapturedFile(file: FileHandle, path: string, captured: Stats): Promise<void> {
	const current = await file.stat();
	const currentPath = await stat(path);
	if (
		current.dev !== captured.dev ||
		current.ino !== captured.ino ||
		current.size < captured.size ||
		currentPath.dev !== captured.dev ||
		currentPath.ino !== captured.ino
	) {
		throw new Error("Pi journal replaced or truncated during replay.");
	}
}
function validateJournalHeader(index: JournalIndex, manager: BrowserJournalManager): void {
	const header = index.metadata.find((entry) => entry.value.type === "session");
	if (header?.value.id !== (index.header?.id ?? manager.getSessionId())) {
		throw new Error("Pi session journal identity does not match the active session.");
	}
}
async function openPublishedJournal(path: string): Promise<FileHandle | undefined> {
	try {
		return await open(path, constants.O_RDONLY);
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}
export async function readBrowserEntries(
	manager: BrowserJournalManager,
	physical = false,
): Promise<unknown[]> {
	const path = manager.getSessionFile();
	if (path === undefined || path.length === 0) {
		journalIndexes.delete(manager);
		return inMemoryEntries(manager, physical);
	}
	const leaf = physical ? null : manager.getLeafId();
	let file: FileHandle | undefined;
	try {
		file = await openPublishedJournal(path);
		if (!file) {
			journalIndexes.delete(manager);
			return inMemoryEntries(manager, physical);
		}
		const captured = await file.stat();
		if (!captured.isFile()) {
			throw new Error("Pi session journal is not a regular file.");
		}
		const index = await readJournalIndex(manager, file, path, captured);
		const { metadata } = index;
		validateJournalHeader(index, manager);
		const records = metadata.filter((entry) => entry.value.type !== "session");
		const selected = physical ? records : branchEntries(records, leaf);
		const replay = new PublishedJournalReplay(file, selected, legacyOwner(manager));
		await replay.project(selected);
		const entries = await replay.resolveWinningDefinitions(physical);
		await verifyCapturedFile(file, path, captured);
		journalIndexes.set(manager, index);
		return entries;
	} catch (error) {
		journalIndexes.delete(manager);
		throw error;
	} finally {
		await file?.close();
	}
}
