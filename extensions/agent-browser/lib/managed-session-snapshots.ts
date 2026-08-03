/**
 * Purpose: Retain only wrapper-owned managed-restore snapshots after successful close operations.
 * Responsibilities: Persist atomic per-snapshot ownership records, self-heal malformed records, and apply age/count retention without deleting unproven paths.
 * Scope: Snapshot ownership and pruning only; restore eligibility and daemon policy live in sibling modules.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
	createManagedSessionRestoreKey,
	directoryContainsSymlink,
	ensureManagedSessionRestoreStorageIsSecure,
	ensureOwnerOnlyDirectory,
	getManagedRestoreSessionsDirectory,
	hasManagedSessionRestoreProjectIdentity,
	isManagedSessionRestoreKey,
	resolveManagedSessionRestoreHome,
} from "./managed-session-storage.js";

const OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP = 2;
const OWNED_RESTORE_SNAPSHOT_MAX_RECORDS = 256;
const OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES = 16 * 1_024;
const OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX = ".pi-agent-browser-owned-snapshots-v2";
const OWNED_RESTORE_SNAPSHOT_TEMP_MAX_AGE_MS = 30_000;
const OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function pathExistsOrIsUnreadable(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

function validateOwnedSnapshotPath(options: {
	home: string;
	namespace?: string;
	path: string;
	restoreKey: string;
}): string | undefined {
	if (!isAbsolute(options.path)) return undefined;
	let path: string;
	try {
		path = realpathSync(options.path);
	} catch {
		return undefined;
	}
	const directory = getManagedRestoreSessionsDirectory(options.home, options.namespace);
	const name = basename(path);
	if (dirname(path) !== directory || !name.startsWith(`${options.restoreKey}-`)) return undefined;
	if (!/\.json(?:\.enc)?$/.test(name)) return undefined;
	try {
		const entry = lstatSync(path);
		return !entry.isSymbolicLink() && entry.isFile() ? path : undefined;
	} catch {
		return undefined;
	}
}

function getManifestDirectory(directory: string, restoreKey: string): string {
	return join(directory, `${OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX}-${restoreKey}`);
}

function ensureManifestDirectory(path: string, platform: NodeJS.Platform): boolean {
	if (platform !== "win32") return ensureOwnerOnlyDirectory(path, platform) && !directoryContainsSymlink(path);
	try {
		mkdirSync(path, { recursive: true });
		const entry = lstatSync(path);
		return !entry.isSymbolicLink() && entry.isDirectory() && !directoryContainsSymlink(path);
	} catch {
		return false;
	}
}

function getRecordPath(directory: string, snapshotPath: string): string {
	const digest = createHash("sha256").update(snapshotPath).digest("hex");
	return join(directory, `${digest}.json`);
}

function writeRecord(directory: string, snapshotPath: string, platform: NodeJS.Platform): boolean {
	const content = JSON.stringify(snapshotPath);
	if (Buffer.byteLength(content) > OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES) return false;
	const path = getRecordPath(directory, snapshotPath);
	try {
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() || !entry.isFile()) return false;
		if (entry.size <= OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES && JSON.parse(readFileSync(path, "utf8")) === snapshotPath) {
			if (platform !== "win32" && (entry.mode & 0o077) !== 0) return false;
			return true;
		}
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) return false;
		try { unlinkSync(path); } catch {}
	}
	const temporaryPath = join(directory, `.tmp-${process.pid}-${randomUUID()}`);
	try {
		writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, path);
		if (platform !== "win32") chmodSync(path, 0o600);
		return true;
	} catch {
		try {
			const entry = lstatSync(path);
			return !entry.isSymbolicLink()
				&& entry.isFile()
				&& entry.size <= OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES
				&& (platform === "win32" || (entry.mode & 0o077) === 0)
				&& JSON.parse(readFileSync(path, "utf8")) === snapshotPath;
		} catch {
			return false;
		}
	} finally {
		try { unlinkSync(temporaryPath); } catch {}
	}
}

function readRecord(options: {
	home: string;
	namespace?: string;
	path: string;
	platform: NodeJS.Platform;
	restoreKey: string;
}): string | undefined {
	try {
		const entry = lstatSync(options.path);
		if (entry.isSymbolicLink() || !entry.isFile() || entry.size > OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES) return undefined;
		if (options.platform !== "win32" && (entry.mode & 0o077) !== 0) return undefined;
		const parsed = JSON.parse(readFileSync(options.path, "utf8")) as unknown;
		if (typeof parsed !== "string" || !isAbsolute(parsed)) return undefined;
		const snapshotPath = validateOwnedSnapshotPath({ home: options.home, namespace: options.namespace, path: parsed, restoreKey: options.restoreKey });
		return snapshotPath && getRecordPath(dirname(options.path), snapshotPath) === options.path ? snapshotPath : undefined;
	} catch {
		return undefined;
	}
}

function scanOwnedSnapshots(options: {
	home: string;
	manifestDirectory: string;
	namespace?: string;
	platform: NodeJS.Platform;
	restoreKey: string;
}): Array<{ mtimeMs: number; path: string; recordPath: string }> {
	const snapshots: Array<{ mtimeMs: number; path: string; recordPath: string }> = [];
	for (const entry of readdirSync(options.manifestDirectory, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.startsWith(".tmp-")) {
			const temporaryPath = join(options.manifestDirectory, entry.name);
			try {
				if (Date.now() - lstatSync(temporaryPath).mtimeMs > OWNED_RESTORE_SNAPSHOT_TEMP_MAX_AGE_MS) unlinkSync(temporaryPath);
			} catch {}
			continue;
		}
		if (!entry.isFile() || !/^[a-f\d]{64}\.json$/.test(entry.name)) continue;
		const recordPath = join(options.manifestDirectory, entry.name);
		const path = readRecord({ ...options, path: recordPath });
		if (!path) {
			try { unlinkSync(recordPath); } catch {}
			continue;
		}
		try {
			snapshots.push({ mtimeMs: lstatSync(path).mtimeMs, path, recordPath });
		} catch {
			try { unlinkSync(recordPath); } catch {}
		}
	}
	return snapshots.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
}

/** After an owned close, expire only close-proven snapshots while retaining two fallbacks. */
export function pruneOwnedManagedSessionRestoreSnapshots(options: {
	cwd: string;
	namespace?: string;
	parentEnv?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	restoreKey?: string | null;
	statePath?: string;
}): number {
	const parentEnv = options.parentEnv ?? process.env;
	const platform = options.platform ?? process.platform;
	const restoreKey = options.restoreKey === undefined
		? hasManagedSessionRestoreProjectIdentity(options.cwd) ? createManagedSessionRestoreKey(options.cwd) : undefined
		: isManagedSessionRestoreKey(options.restoreKey) ? options.restoreKey : undefined;
	if (!restoreKey) return 0;
	const home = resolveManagedSessionRestoreHome(parentEnv, platform);
	if (!home) return 0;
	const directory = getManagedRestoreSessionsDirectory(home, options.namespace);
	const manifestDirectory = getManifestDirectory(directory, restoreKey);
	if (!options.statePath && !pathExistsOrIsUnreadable(manifestDirectory)) return 0;
	if (!ensureManagedSessionRestoreStorageIsSecure(parentEnv, platform, options.namespace)) return 0;
	if (!ensureManifestDirectory(manifestDirectory, platform)) return 0;
	if (options.statePath) {
		const ownedPath = validateOwnedSnapshotPath({ home, namespace: options.namespace, path: options.statePath, restoreKey });
		if (ownedPath && !writeRecord(manifestDirectory, ownedPath, platform)) return 0;
	}

	const staleBefore = Date.now() - OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS;
	let removed = 0;
	for (let pass = 0; pass <= OWNED_RESTORE_SNAPSHOT_MAX_RECORDS; pass += 1) {
		const snapshots = scanOwnedSnapshots({ home, manifestDirectory, namespace: options.namespace, platform, restoreKey });
		const candidates = snapshots.filter((snapshot, index) =>
			index >= OWNED_RESTORE_SNAPSHOT_MAX_RECORDS
			|| (index >= OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP && snapshot.mtimeMs < staleBefore));
		if (candidates.length === 0) break;
		let changed = false;
		for (const snapshot of candidates) {
			try {
				const current = lstatSync(snapshot.path);
				if (current.isSymbolicLink() || !current.isFile() || current.mtimeMs !== snapshot.mtimeMs) continue;
				unlinkSync(snapshot.path);
				try { unlinkSync(snapshot.recordPath); } catch {}
				removed += 1;
				changed = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					try { unlinkSync(snapshot.recordPath); } catch {}
					changed = true;
				}
			}
		}
		if (!changed) break;
	}
	return removed;
}
