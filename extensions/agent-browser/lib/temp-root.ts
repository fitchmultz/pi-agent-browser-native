import { randomInt } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { enqueueTempMutation } from "./temp-mutation-queue.js";
import {
	TEMP_ROOT_MARKER_FILE_NAME,
	getCurrentProcessUid,
	readTempRootOwnershipMarker,
	getProtectedTempChildName,
	getPersistedProtectedChildPaths,
	persistProtectedTempChildren,
	getExistingProtectedChildren,
	removeTempRootChildrenExcept,
	getMarkerOwnerLiveness,
	refreshSecureTempRootLease,
	writeSecureTempRootOwnershipMarker,
	type TempRootOwnershipRecord,
} from "./temp-root-ownership.js";
export {
	refreshSecureTempRootLease,
	writeSecureTempRootOwnershipMarker,
} from "./temp-root-ownership.js";

const TEMP_ROOT_PREFIX = "pi-agent-browser-";
const STALE_TEMP_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const STALE_TEMP_ROOT_BATCH_SIZE = 8;
let lastTempGcName: string | undefined;
let sessionTempRootPromise: Promise<string> | undefined;
let exitCleanupRegistered = false;
const ownedTempRoots = new Set<string>();
const protectedTempChildren = new Set<string>();

function markerMatchesUid(marker: TempRootOwnershipRecord, uid: number | undefined): boolean {
	return uid === undefined || marker.ownerUid === undefined || marker.ownerUid === uid;
}
async function pruneTempRoot(
	path: string,
	currentUid: number | undefined,
	cutoffTime: number,
): Promise<void> {
	const marker = await readTempRootOwnershipMarker(path);
	if (!marker || !markerMatchesUid(marker, currentUid)) {
		return;
	}
	if ((marker.leaseUpdatedAtMs ?? marker.createdAtMs) >= cutoffTime) {
		return;
	}
	// Preserve ambiguous owner liveness; never delete another live process's files.
	if ((await getMarkerOwnerLiveness(marker)) !== "dead") {
		return;
	}
	const stats = await stat(path).catch(() => undefined);
	if (stats?.isDirectory() !== true) {
		return;
	}
	const protectedChildren = await getExistingProtectedChildren(
		path,
		getPersistedProtectedChildPaths(path, marker),
	);
	if (protectedChildren.size > 0) {
		await removeTempRootChildrenExcept(path, protectedChildren);
		return;
	}
	await rm(path, { force: true, recursive: true }).catch(() => {
		/* Stale-root cleanup is best-effort. */
	});
}
async function pruneStaleTempRoots(currentTempRoot: string): Promise<void> {
	const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
	const cutoffTime = Date.now() - STALE_TEMP_ROOT_MAX_AGE_MS;
	const currentUid = getCurrentProcessUid();
	// ponytail: list/sort all names; stream directories if enumeration becomes the bottleneck.
	const candidates = entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_ROOT_PREFIX))
		.map((entry) => entry.name)
		.sort();
	if (candidates.length === 0) {
		return;
	}
	const previousName = lastTempGcName;
	const start =
		previousName === undefined
			? randomInt(candidates.length)
			: Math.max(
					0,
					candidates.findIndex((name) => name > previousName),
				);
	const batch = Array.from(
		{ length: Math.min(STALE_TEMP_ROOT_BATCH_SIZE, candidates.length) },
		(_, offset) => candidates[(start + offset) % candidates.length],
	);
	lastTempGcName = batch.at(-1);
	await Promise.all(
		batch.map(async (name) => {
			const path = join(tmpdir(), name);
			if (path !== currentTempRoot) {
				await pruneTempRoot(path, currentUid, cutoffTime);
			}
		}),
	);
}
function getProtectedChildrenForRoot(tempRoot: string): Set<string> {
	const normalizedTempRoot = resolve(tempRoot);
	return new Set(
		[...protectedTempChildren].filter(
			(path) => dirname(path) === normalizedTempRoot && existsSync(path),
		),
	);
}
function removeTempRootChildrenExceptSync(
	tempRoot: string,
	protectedChildren: ReadonlySet<string>,
): void {
	for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
		if (entry.name === TEMP_ROOT_MARKER_FILE_NAME) {
			continue;
		}
		const entryPath = join(tempRoot, entry.name);
		if (protectedChildren.has(resolve(entryPath))) {
			continue;
		}
		rmSync(entryPath, { force: true, recursive: true });
	}
}
function registerExitCleanup(): void {
	if (exitCleanupRegistered) {
		return;
	}
	exitCleanupRegistered = true;
	process.once("exit", () => {
		for (const tempRoot of ownedTempRoots) {
			try {
				const protectedChildren = getProtectedChildrenForRoot(tempRoot);
				if (protectedChildren.size === 0) {
					rmSync(tempRoot, { force: true, recursive: true });
				} else {
					removeTempRootChildrenExceptSync(tempRoot, protectedChildren);
				}
			} catch {
				/* Best-effort process-exit cleanup. */
			}
		}
	});
}
export async function preserveSecureTempDirectory(path: string): Promise<void> {
	await enqueueTempMutation(async () => {
		const childPath = resolve(path);
		const tempRoot = dirname(childPath);
		if (
			!ownedTempRoots.has(tempRoot) ||
			getProtectedTempChildName(tempRoot, childPath) === undefined ||
			!(await stat(childPath)).isDirectory()
		) {
			throw new Error(
				`Cannot preserve ${path}; expected an existing child directory of a currently owned temp root.`,
			);
		}
		protectedTempChildren.add(childPath);
		await persistProtectedTempChildren(tempRoot, new Set([childPath]));
		if (
			!getPersistedProtectedChildPaths(tempRoot, await readTempRootOwnershipMarker(tempRoot)).has(
				childPath,
			)
		) {
			throw new Error(`Could not persist temp directory preservation for ${path}.`);
		}
	});
}
function rememberPreservedPaths(tempRoot: string, paths: readonly string[]): void {
	for (const path of paths) {
		const childName = getProtectedTempChildName(tempRoot, path);
		if (childName !== undefined && childName.length > 0) {
			protectedTempChildren.add(resolve(join(tempRoot, childName)));
		}
	}
}
function forgetMissingPreservedPaths(
	tempRoot: string,
	preservedChildren: ReadonlySet<string>,
): void {
	for (const path of protectedTempChildren) {
		if (dirname(path) === tempRoot && !preservedChildren.has(path)) {
			protectedTempChildren.delete(path);
		}
	}
}
export async function cleanupSecureTempArtifacts(
	options: { readonly preservePaths?: readonly string[] } = {},
): Promise<void> {
	await enqueueTempMutation(async () => {
		const tempRoot = await sessionTempRootPromise?.catch(() => undefined);
		if (tempRoot === undefined || tempRoot.length === 0) {
			return;
		}
		const normalizedTempRoot = resolve(tempRoot);
		rememberPreservedPaths(normalizedTempRoot, options.preservePaths ?? []);
		const preservedChildren = await getExistingProtectedChildren(
			normalizedTempRoot,
			protectedTempChildren,
		);
		forgetMissingPreservedPaths(normalizedTempRoot, preservedChildren);
		if (preservedChildren.size === 0) {
			sessionTempRootPromise = undefined;
			ownedTempRoots.delete(tempRoot);
			await rm(tempRoot, { force: true, recursive: true }).catch(() => {
				/* Cleanup failure cannot revive retired ownership. */
			});
			return;
		}
		await persistProtectedTempChildren(tempRoot, preservedChildren);
		await removeTempRootChildrenExcept(tempRoot, preservedChildren);
		await refreshSecureTempRootLease(tempRoot).catch(() => {
			/* Cleanup retains existing ownership evidence on failed renewal. */
		});
	});
}
async function allocateSessionTempRoot(): Promise<string> {
	const tempRoot = await mkdtemp(join(tmpdir(), TEMP_ROOT_PREFIX));
	try {
		await chmod(tempRoot, 0o700).catch(() => {
			/* mkdtemp already creates a private root. */
		});
		await writeSecureTempRootOwnershipMarker(tempRoot);
		ownedTempRoots.add(tempRoot);
		registerExitCleanup();
		return tempRoot;
	} catch (error) {
		await rm(tempRoot, { force: true, recursive: true }).catch(() => {
			/* Preserve the allocation failure if private-root cleanup also fails. */
		});
		throw error;
	}
}
export async function getSessionTempRoot(): Promise<string> {
	sessionTempRootPromise ??= allocateSessionTempRoot().catch((error: unknown) => {
		sessionTempRootPromise = undefined;
		throw error;
	});
	const tempRoot = await sessionTempRootPromise;
	await refreshSecureTempRootLease(tempRoot).catch(() => {
		/* A failed refresh leaves the existing marker. */
	});
	await pruneStaleTempRoots(tempRoot).catch(() => {
		/* GC cannot prevent using the owned root. */
	});
	return tempRoot;
}
export async function getSecureTempChildDirectoryValidationError(
	path: string,
	childPrefix: string,
): Promise<string | undefined> {
	const parentDirectory = dirname(path);
	const childName = path.slice(parentDirectory.length + 1);
	if (!childName.startsWith(childPrefix)) {
		return `Refusing to remove ${path}; expected wrapper temp child prefix ${childPrefix}.`;
	}
	const marker = await readTempRootOwnershipMarker(parentDirectory);
	if (!marker) {
		return `Refusing to remove ${path}; parent directory is not a pi-agent-browser owned temp root.`;
	}
	const currentUid = getCurrentProcessUid();
	if (!markerMatchesUid(marker, currentUid)) {
		return `Refusing to remove ${path}; parent temp root is owned by uid ${marker.ownerUid ?? "unknown"}, not current uid ${currentUid ?? "unknown"}.`;
	}
	return undefined;
}
