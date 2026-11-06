import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	ensureManagedSessionRestoreStorageIsSecure,
	getManagedRestoreSessionsDirectory,
	isManagedSessionRestoreKey,
	resolveManagedSessionRestoreHome,
} from "./managed-session-storage.js";
import { getErrorCode } from "./process-errors.js";
import {
	OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP,
	OWNED_RESTORE_SNAPSHOT_MAX_RECORDS,
	OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX,
	OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS,
	pathExistsOrIsUnreadable,
	validateOwnedSnapshotPath,
	getManifestDirectory,
	ensureManifestDirectory,
	getCheckoutLineageHash,
	manifestHasLineage,
	ensureManifestLineage,
	removeManifestLineages,
	writeRecord,
	scanOwnedSnapshots,
} from "./managed-session-snapshot-records.js";

type Snapshot = Readonly<{ mtimeMs: number; path: string; recordPath: string }>;
interface SnapshotScope {
	readonly home: string;
	readonly namespace?: string | undefined;
	readonly platform: NodeJS.Platform;
	readonly restoreKey: string;
	readonly directory: string;
	readonly manifestDirectory: string;
	readonly hasCurrentManifest: boolean;
	readonly lineage?: string | undefined;
}
interface PruneOptions {
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly parentEnv?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly restoreKey: string | null;
	readonly statePath?: string | undefined;
}

function discardRecord(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* Ownership records are best-effort after the snapshot is absent. */
	}
}
function removeSnapshot(snapshot: Snapshot): {
	readonly removed: number;
	readonly changed: boolean;
} {
	try {
		const current = lstatSync(snapshot.path);
		if (current.isSymbolicLink() || !current.isFile() || current.mtimeMs !== snapshot.mtimeMs) {
			return { removed: 0, changed: false };
		}
		unlinkSync(snapshot.path);
		discardRecord(snapshot.recordPath);
		return { removed: 1, changed: true };
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") {
			discardRecord(snapshot.recordPath);
			return { removed: 0, changed: true };
		}
		return { removed: 0, changed: false };
	}
}
function captureScope(options: PruneOptions): SnapshotScope | undefined {
	const parentEnv = options.parentEnv ?? process.env;
	const platform = options.platform ?? process.platform;
	const restoreKey = options.restoreKey;
	if (!isManagedSessionRestoreKey(restoreKey)) {
		return undefined;
	}
	const home = resolveManagedSessionRestoreHome(parentEnv, platform);
	if (home === undefined || home.length === 0) {
		return undefined;
	}
	const directory = getManagedRestoreSessionsDirectory(home, options.namespace);
	const manifestDirectory = getManifestDirectory(directory, restoreKey);
	const hasCurrentManifest = pathExistsOrIsUnreadable(manifestDirectory);
	if (!ensureManagedSessionRestoreStorageIsSecure(parentEnv, platform, options.namespace)) {
		return undefined;
	}
	const hasStatePath = options.statePath !== undefined && options.statePath.length > 0;
	const lineage = getCheckoutLineageHash(options.cwd, platform);
	if (!prepareManifest(manifestDirectory, lineage, platform, hasStatePath || hasCurrentManifest)) {
		return undefined;
	}
	return {
		home,
		namespace: options.namespace,
		platform,
		restoreKey,
		directory,
		manifestDirectory,
		hasCurrentManifest,
		lineage,
	};
}
function prepareManifest(
	directory: string,
	lineage: string | undefined,
	platform: NodeJS.Platform,
	needed: boolean,
): boolean {
	return (
		!needed ||
		(ensureManifestDirectory(directory, platform) &&
			prepareLineage(directory, lineage, platform, true))
	);
}
function prepareLineage(
	directory: string,
	lineage: string | undefined,
	platform: NodeJS.Platform,
	needed: boolean,
): boolean {
	return (
		!needed ||
		(lineage !== undefined &&
			lineage.length > 0 &&
			ensureManifestLineage(directory, lineage, platform))
	);
}
function recordClosedSnapshot(scope: SnapshotScope, statePath: string | undefined): boolean {
	if (statePath === undefined || statePath.length === 0) {
		return true;
	}
	const path = validateOwnedSnapshotPath({ ...scope, path: statePath });
	return (
		path === undefined ||
		path.length === 0 ||
		writeRecord(scope.manifestDirectory, path, scope.platform)
	);
}
function pruneCurrentScope(scope: SnapshotScope, staleBefore: number): number {
	let removed = 0;
	for (let pass = 0; pass <= OWNED_RESTORE_SNAPSHOT_MAX_RECORDS; pass += 1) {
		const snapshots = scanOwnedSnapshots(scope);
		const candidates = snapshots.filter(
			(snapshot, index) =>
				index >= OWNED_RESTORE_SNAPSHOT_MAX_RECORDS ||
				(index >= OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP && snapshot.mtimeMs < staleBefore),
		);
		if (candidates.length === 0) {
			break;
		}
		let changed = false;
		for (const snapshot of candidates) {
			const result = removeSnapshot(snapshot);
			removed += result.removed;
			changed ||= result.changed;
		}
		if (!changed) {
			break;
		}
	}
	return removed;
}
function removeEmptyManifest(directory: string, platform: NodeJS.Platform): void {
	try {
		if (readdirSync(directory).filter((name) => /^[a-f\d]{64}\.json$/.test(name)).length === 0) {
			removeManifestLineages(directory, platform);
		}
		if (readdirSync(directory).length === 0) {
			rmdirSync(directory);
		}
	} catch {
		/* Unknown/concurrently modified entries keep the manifest intact. */
	}
}
function pruneOtherManifest(scope: SnapshotScope, name: string, staleBefore: number): number {
	const restoreKey = name.slice(`${OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX}-`.length);
	// The predicate also validates the restore-key format on this untrusted directory name.
	if (!isManagedSessionRestoreKey(restoreKey) || restoreKey === scope.restoreKey) {
		return 0;
	}
	const directory = join(scope.directory, name);
	if (!ensureManifestDirectory(directory, scope.platform)) {
		return 0;
	}
	if (
		scope.lineage === undefined ||
		!manifestHasLineage(directory, scope.lineage, scope.platform)
	) {
		return 0;
	}
	let snapshots: ReturnType<typeof scanOwnedSnapshots>;
	try {
		snapshots = scanOwnedSnapshots({ ...scope, manifestDirectory: directory, restoreKey });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const snapshot of snapshots) {
		if (snapshot.mtimeMs < staleBefore) {
			removed += removeSnapshot(snapshot).removed;
		}
	}
	removeEmptyManifest(directory, scope.platform);
	return removed;
}
function pruneExpiredOtherRestoreKeys(scope: SnapshotScope, staleBefore: number): number {
	let entries;
	try {
		entries = readdirSync(scope.directory, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (
			entry.isDirectory() &&
			entry.name.startsWith(`${OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX}-`)
		) {
			removed += pruneOtherManifest(scope, entry.name, staleBefore);
		}
	}
	return removed;
}
/** After an owned close, expire only close-proven snapshots while retaining two fallbacks. */
export function pruneOwnedManagedSessionRestoreSnapshots(options: PruneOptions): number {
	const scope = captureScope(options);
	if (!scope || !recordClosedSnapshot(scope, options.statePath)) {
		return 0;
	}
	const staleBefore = Date.now() - OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS;
	const current =
		(options.statePath !== undefined && options.statePath.length > 0) || scope.hasCurrentManifest;
	let removed = current ? pruneCurrentScope(scope, staleBefore) : 0;
	if (scope.lineage === undefined || scope.lineage.length === 0) {
		return removed;
	}
	removed += pruneExpiredOtherRestoreKeys(scope, staleBefore);
	return removed;
}
