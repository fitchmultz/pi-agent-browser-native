import { constants, openSync, closeSync, fstatSync, type Stats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { BrowserJournalManager } from "./browser-journal-contracts.js";
export type { BrowserBranchManager, BrowserJournalManager } from "./browser-journal-contracts.js";

import { BROWSER_TRANSITION_ENTRY, type BrowserRecord } from "./browser-transcript-contracts.js";
import { isRecord } from "./parsing.js";

import { journalRanges, projectJson, readRange } from "./browser-journal-reader.js";
export {
	journalRanges,
	projectJson,
	readRange,
	scanJournalMetadata,
	type JournalRange,
	type JournalEntry,
} from "./browser-journal-reader.js";
export { readBrowserEntries } from "./browser-journal-replay.js";

/** A filename is not durability evidence on official Pi before its first conversation. */
export function requirePublishedBrowserJournal(manager: BrowserJournalManager): void {
	const path = manager.getSessionFile();
	if (path === undefined || path.length === 0) {
		throw new Error(
			"Browser code requires a published Pi conversation; relaunch without --no-session.",
		);
	}
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY);
		const entry = fstatSync(fd);
		if (!entry.isFile() || entry.size === 0) {
			throw new Error("Pi conversation has not been published yet.");
		}
	} catch (error) {
		throw new Error(
			"Browser work requires an actually published Pi conversation before dispatch; send a user message first.",
			{ cause: error },
		);
	} finally {
		if (fd !== undefined) {
			closeSync(fd);
		}
	}
}

/** Observation-only artifact receipts are optional until Pi publishes its journal. */
export function hasPublishedBrowserJournal(manager: BrowserJournalManager): boolean {
	try {
		requirePublishedBrowserJournal(manager);
		return true;
	} catch {
		return false;
	}
}

import type { BrowserBranch } from "./browser-journal-branch.js";
export { captureBrowserBranch, type BrowserBranch } from "./browser-journal-branch.js";

const RECEIPT_FIELDS = [
	["type"],
	["id"],
	["customType"],
	...["version", "operationId", "phase", "toolCallId", "commandIndex"].map((field) => [
		"data",
		"event",
		field,
	]),
];
function matchesReceipt(
	value: Readonly<Record<string, unknown>>,
	receipt: { readonly nativeId: string | null; readonly expected: BrowserRecord },
): boolean {
	if (
		value.id !== receipt.nativeId ||
		value.type !== "custom" ||
		value.customType !== BROWSER_TRANSITION_ENTRY ||
		!isRecord(value.data) ||
		!isRecord(value.data.event)
	) {
		return false;
	}
	const event = value.data.event;
	const expected = receipt.expected.event;
	const identity = {
		operationId: expected.operationId,
		phase: expected.phase,
		toolCallId: expected.toolCallId,
		commandIndex: expected.commandIndex,
	};
	return (
		event.version === 1 &&
		Object.entries(identity).every(([key, fieldValue]) => event[key] === fieldValue)
	);
}
async function countPublishedReceipts(
	file: FileHandle,
	journal: { readonly after: Stats; readonly start: number; readonly sessionId: string },
	receipt: { readonly nativeId: string | null; readonly expected: BrowserRecord },
): Promise<number> {
	let matches = 0;
	for await (const range of journalRanges(file, journal.after.size, false, journal.start)) {
		const value = await projectJson(readRange(file, range), RECEIPT_FIELDS);
		if (!value) {
			continue;
		}
		if (value.type === "session" && value.id !== journal.sessionId) {
			throw new Error("Pi repaired journal identity differs from the active session.");
		}
		if (matchesReceipt(value, receipt)) {
			matches++;
		}
	}
	return matches;
}
async function verifyAppend(
	file: FileHandle,
	path: string,
	before: Stats,
	receipt: {
		readonly nativeId: string | null;
		readonly expected: BrowserRecord;
		readonly sessionId: string;
	},
): Promise<void> {
	const after = await file.stat();
	const sameFile = after.dev === before.dev && after.ino === before.ino;
	if (!after.isFile() || (sameFile && after.size <= before.size)) {
		throw new Error("Pi did not publish the browser event.");
	}
	const matches = await countPublishedReceipts(
		file,
		{ after, start: sameFile ? before.size : 0, sessionId: receipt.sessionId },
		receipt,
	);
	const current = await stat(path);
	if (
		matches !== 1 ||
		current.dev !== after.dev ||
		current.ino !== after.ino ||
		current.size < after.size
	) {
		throw new Error("Pi browser append has no matching published journal receipt.");
	}
}
async function appendPublishedRecord(
	manager: BrowserJournalManager,
	path: string,
	operation: {
		readonly append: () => void;
		readonly expected: BrowserRecord;
		readonly branch: BrowserBranch;
	},
): Promise<boolean> {
	const beforeFile = await open(path, constants.O_RDONLY);
	let file: FileHandle | undefined;
	try {
		const before = await beforeFile.stat();
		// Native navigation changes the leaf before its awaited session_tree handlers.
		if (!operation.branch.isCurrent()) {
			return false;
		}
		operation.branch.append(operation.append);
		const nativeId = manager.getLeafId();
		// Native repair may flush several records or replace the file. Reopen and frame the actual journal.
		file = await open(path, constants.O_RDONLY);
		await verifyAppend(file, path, before, {
			nativeId,
			expected: operation.expected,
			sessionId: manager.getHeader()?.id ?? manager.getSessionId(),
		});
	} finally {
		await Promise.all([file?.close(), beforeFile.close()]);
	}
	return operation.branch.isCurrent();
}
/** A withdrawn branch returns false; required publication faults still throw. */
export async function appendBrowserRecord(
	manager: BrowserJournalManager,
	append: () => void,
	expected: BrowserRecord,
	branch: BrowserBranch,
): Promise<boolean> {
	if ((manager.getSessionFile() ?? "").length === 0) {
		if (!branch.isCurrent()) {
			return false;
		}
		branch.append(append);
		return branch.isCurrent();
	}
	requirePublishedBrowserJournal(manager);
	const path = manager.getSessionFile();
	if (path === undefined || path.length === 0) {
		throw new Error("Pi conversation has no published journal locator.");
	}
	return appendPublishedRecord(manager, path, { append, expected, branch });
}
