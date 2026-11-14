import { hash, randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	directoryContainsSymlink,
	ensureOwnerOnlyDirectory,
	getManagedRestoreSessionsDirectory,
	resolveManagedSessionRestoreCheckoutRoot,
} from "./managed-session-storage.js";
import { getErrorCode } from "./process-errors.js";
export const OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP = 2;
export const OWNED_RESTORE_SNAPSHOT_MAX_RECORDS = 256;
export const OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES = 16 * 1_024;
export const OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX = ".pi-agent-browser-owned-snapshots-v2";
export const OWNED_RESTORE_SNAPSHOT_LINEAGE_DIRECTORY = ".checkout-lineage-v1";
export const OWNED_RESTORE_SNAPSHOT_TEMP_MAX_AGE_MS = 30_000;
export const OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export function pathExistsOrIsUnreadable(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		return getErrorCode(error) !== "ENOENT";
	}
}
export function validateOwnedSnapshotPath(options: {
	readonly home: string;
	readonly namespace?: string | undefined;
	readonly path: string;
	readonly restoreKey: string;
}): string | undefined {
	if (!isAbsolute(options.path)) {
		return undefined;
	}
	let path: string;
	try {
		path = realpathSync(options.path);
	} catch {
		return undefined;
	}
	const directory = getManagedRestoreSessionsDirectory(options.home, options.namespace);
	const name = basename(path);
	if (
		dirname(path) !== directory ||
		!name.startsWith(`${options.restoreKey}-`) ||
		!/\.json(?:\.enc)?$/.test(name)
	) {
		return undefined;
	}
	try {
		const entry = lstatSync(path);
		return !entry.isSymbolicLink() && entry.isFile() ? path : undefined;
	} catch {
		return undefined;
	}
}
export function getManifestDirectory(directory: string, restoreKey: string): string {
	return join(directory, `${OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX}-${restoreKey}`);
}
export function ensureManifestDirectory(path: string, platform: NodeJS.Platform): boolean {
	if (platform !== "win32") {
		return ensureOwnerOnlyDirectory(path, platform) && !directoryContainsSymlink(path);
	}
	try {
		mkdirSync(path, { recursive: true });
		const entry = lstatSync(path);
		return !entry.isSymbolicLink() && entry.isDirectory() && !directoryContainsSymlink(path);
	} catch {
		return false;
	}
}
export function getCheckoutLineageHash(cwd: string, platform: NodeJS.Platform): string | undefined {
	const root = resolveManagedSessionRestoreCheckoutRoot(cwd, platform);
	if (root === undefined || root.length === 0) {
		return undefined;
	}
	return hash(
		"sha256",
		`managed-snapshot-lineage-v1:${platform}:${platform === "win32" ? root.toLowerCase() : root}`,
		"hex",
	);
}
function privateOwnedDirectory(entry: Stats, platform: NodeJS.Platform): boolean {
	if (platform === "win32") {
		return true;
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	return uid !== undefined && entry.uid === uid && (entry.mode & 0o077) === 0;
}
export function manifestHasLineage(
	directory: string,
	lineage: string,
	platform: NodeJS.Platform,
): boolean {
	const lineageDirectory = join(directory, OWNED_RESTORE_SNAPSHOT_LINEAGE_DIRECTORY);
	try {
		const directoryEntry = lstatSync(lineageDirectory);
		if (
			directoryEntry.isSymbolicLink() ||
			!directoryEntry.isDirectory() ||
			directoryContainsSymlink(lineageDirectory) ||
			!privateOwnedDirectory(directoryEntry, platform)
		) {
			return false;
		}
		const entry = lstatSync(join(lineageDirectory, lineage));
		if (entry.isSymbolicLink() || !entry.isFile() || entry.size !== 0) {
			return false;
		}
		return platform === "win32" || (entry.mode & 0o077) === 0;
	} catch {
		return false;
	}
}
export function ensureManifestLineage(
	directory: string,
	lineage: string,
	platform: NodeJS.Platform,
): boolean {
	const lineageDirectory = join(directory, OWNED_RESTORE_SNAPSHOT_LINEAGE_DIRECTORY);
	if (!ensureManifestDirectory(lineageDirectory, platform)) {
		return false;
	}
	const path = join(lineageDirectory, lineage);
	try {
		writeFileSync(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
		if (platform !== "win32") {
			chmodSync(path, 0o600);
		}
	} catch (error) {
		if (getErrorCode(error) !== "EEXIST") {
			return false;
		}
	}
	return manifestHasLineage(directory, lineage, platform);
}
export function removeManifestLineages(directory: string, platform: NodeJS.Platform): void {
	const lineageDirectory = join(directory, OWNED_RESTORE_SNAPSHOT_LINEAGE_DIRECTORY);
	try {
		if (!ensureManifestDirectory(lineageDirectory, platform)) {
			return;
		}
		for (const entry of readdirSync(lineageDirectory, { withFileTypes: true })) {
			if (entry.isFile() && /^[a-f\d]{64}$/.test(entry.name)) {
				unlinkSync(join(lineageDirectory, entry.name));
			}
		}
		rmdirSync(lineageDirectory);
	} catch {
		/* Unreadable or concurrently changed ownership evidence remains intact. */
	}
}
function getRecordPath(directory: string, snapshotPath: string): string {
	return join(directory, `${hash("sha256", snapshotPath, "hex")}.json`);
}
function discardRecord(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* Unreadable or concurrently changed ownership evidence remains intact. */
	}
}
function recordFileValid(entry: Stats, platform: NodeJS.Platform): boolean {
	return (
		!entry.isSymbolicLink() &&
		entry.isFile() &&
		entry.size <= OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES &&
		(platform === "win32" || (entry.mode & 0o077) === 0)
	);
}
function existingRecord(
	path: string,
	snapshotPath: string,
	platform: NodeJS.Platform,
): boolean | undefined {
	try {
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() || !entry.isFile()) {
			return false;
		}
		if (
			entry.size <= OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES &&
			JSON.parse(readFileSync(path, "utf8")) === snapshotPath
		) {
			return platform === "win32" || (entry.mode & 0o077) === 0;
		}
		unlinkSync(path);
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) {
			return false;
		}
		discardRecord(path);
	}
	return undefined;
}
function verifyRecord(path: string, snapshotPath: string, platform: NodeJS.Platform): boolean {
	try {
		return (
			recordFileValid(lstatSync(path), platform) &&
			JSON.parse(readFileSync(path, "utf8")) === snapshotPath
		);
	} catch {
		return false;
	}
}
function publishRecord(
	path: string,
	snapshotPath: string,
	content: string,
	platform: NodeJS.Platform,
): boolean {
	const temporaryPath = join(dirname(path), `.tmp-${process.pid}-${randomUUID()}`);
	try {
		writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, path);
		if (platform !== "win32") {
			chmodSync(path, 0o600);
		}
		return true;
	} catch {
		return verifyRecord(path, snapshotPath, platform);
	} finally {
		discardRecord(temporaryPath);
	}
}
export function writeRecord(
	directory: string,
	snapshotPath: string,
	platform: NodeJS.Platform,
): boolean {
	const content = JSON.stringify(snapshotPath);
	if (Buffer.byteLength(content) > OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES) {
		return false;
	}
	const path = getRecordPath(directory, snapshotPath);
	const existing = existingRecord(path, snapshotPath, platform);
	return existing ?? publishRecord(path, snapshotPath, content, platform);
}
interface RecordOptions {
	readonly home: string;
	readonly namespace?: string | undefined;
	readonly path: string;
	readonly platform: NodeJS.Platform;
	readonly restoreKey: string;
}
function readRecord(options: RecordOptions): string | undefined {
	try {
		if (!recordFileValid(lstatSync(options.path), options.platform)) {
			return undefined;
		}
		const parsed: unknown = JSON.parse(readFileSync(options.path, "utf8"));
		if (typeof parsed !== "string" || !isAbsolute(parsed)) {
			return undefined;
		}
		const path = validateOwnedSnapshotPath({
			home: options.home,
			namespace: options.namespace,
			path: parsed,
			restoreKey: options.restoreKey,
		});
		return path !== undefined &&
			path.length > 0 &&
			getRecordPath(dirname(options.path), path) === options.path
			? path
			: undefined;
	} catch {
		return undefined;
	}
}
function removeExpiredTemporary(path: string): void {
	try {
		if (Date.now() - lstatSync(path).mtimeMs > OWNED_RESTORE_SNAPSHOT_TEMP_MAX_AGE_MS) {
			unlinkSync(path);
		}
	} catch {
		/* Concurrent mutation or unreadable ownership evidence remains intact. */
	}
}
interface SnapshotReceipt {
	readonly mtimeMs: number;
	readonly path: string;
	readonly recordPath: string;
}
function snapshotReceipt(path: string, recordPath: string): SnapshotReceipt | undefined {
	try {
		return { mtimeMs: lstatSync(path).mtimeMs, path, recordPath };
	} catch {
		discardRecord(recordPath);
		return undefined;
	}
}
export function scanOwnedSnapshots(options: {
	readonly home: string;
	readonly manifestDirectory: string;
	readonly namespace?: string | undefined;
	readonly platform: NodeJS.Platform;
	readonly restoreKey: string;
}): SnapshotReceipt[] {
	const snapshots: SnapshotReceipt[] = [];
	for (const entry of readdirSync(options.manifestDirectory, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.startsWith(".tmp-")) {
			removeExpiredTemporary(join(options.manifestDirectory, entry.name));
			continue;
		}
		if (!entry.isFile() || !/^[a-f\d]{64}\.json$/.test(entry.name)) {
			continue;
		}
		const recordPath = join(options.manifestDirectory, entry.name);
		const path = readRecord({ ...options, path: recordPath });
		if (path === undefined || path.length === 0) {
			discardRecord(recordPath);
			continue;
		}
		const receipt = snapshotReceipt(path, recordPath);
		if (receipt) {
			snapshots.push(receipt);
		}
	}
	return snapshots.sort((left, right) => {
		const time = right.mtimeMs - left.mtimeMs;
		return time === 0 ? left.path.localeCompare(right.path) : time;
	});
}
