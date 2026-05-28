/**
 * Purpose: Create private temporary and persisted spill files for the pi-agent-browser extension without leaking artifacts broadly on disk.
 * Responsibilities: Maintain a process-private temp root, stamp explicit ownership/protected-child markers, enforce an aggregate temp-artifact disk budget, create securely permissioned temp files, create session-scoped persisted spill files for resumable sessions, prune explicitly owned stale temp roots from prior runs without deleting protected children, and best-effort clean all owned roots on process exit.
 * Scope: Artifact lifecycle helpers only; callers decide what data to write and when to delete or retain long-lived references.
 * Usage: Imported by result/process helpers when they need secure spill files instead of world-readable shared tmp paths.
 * Invariants/Assumptions: Temp artifacts live under the OS temp directory, each active run uses a dedicated 0700 directory, files are created with exclusive 0600 permissions, session-scoped persisted artifacts stay under the pi session directory, and stale pruning only touches roots with an explicit pi-agent-browser ownership marker.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { isRecord, parsePositiveInteger } from "./parsing.js";

const TEMP_ROOT_PREFIX = "pi-agent-browser-";
const TEMP_ROOT_MARKER_FILE_NAME = ".pi-agent-browser-owner.json";
const TEMP_ROOT_MARKER_KIND = "pi-agent-browser-temp-root";
const TEMP_ROOT_MARKER_VERSION = 1;
const STALE_TEMP_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const TEMP_ROOT_MAX_BYTES_ENV = "PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES";
const DEFAULT_TEMP_ROOT_MAX_BYTES = 32 * 1_024 * 1_024;
const SESSION_ARTIFACT_MAX_BYTES_ENV = "PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES";
const DEFAULT_SESSION_ARTIFACT_MAX_BYTES = 32 * 1_024 * 1_024;
const SESSION_ARTIFACTS_ROOT_DIR_NAME = ".pi-agent-browser-artifacts";
const PROCESS_START_IDENTITY_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

export interface PersistentSessionArtifactStore {
	protectedPaths?: readonly string[];
	sessionDir: string;
	sessionId: string;
}

export interface PersistentSessionArtifactEviction {
	mtimeMs: number;
	path: string;
	sizeBytes: number;
}

export interface PersistentSessionArtifactWriteResult {
	evictedArtifacts: PersistentSessionArtifactEviction[];
	path: string;
}

interface TempRootOwnershipRecord {
	createdAtMs: number;
	kind: string;
	leaseUpdatedAtMs?: number;
	ownerPid?: number;
	ownerProcessStartIdentity?: string;
	ownerUid?: number;
	protectedChildNames?: readonly string[];
	version: number;
}

interface TempRootOwnershipMarkerOptions {
	createdAtMs?: number;
	leaseUpdatedAtMs?: number;
	ownerPid?: number;
	ownerProcessStartIdentity?: string;
}

type ProcessLiveness = "alive" | "dead" | "unknown";

let sessionTempRootPromise: Promise<string> | undefined;
let exitCleanupRegistered = false;
let tempMutationQueue = Promise.resolve();
const ownedTempRoots = new Set<string>();
const protectedTempChildren = new Set<string>();

function getCurrentProcessUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isProtectedTempChildName(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value === "" || value === "." || value === ".." || value === TEMP_ROOT_MARKER_FILE_NAME) return false;
	if (value.includes("/") || value.includes("\\")) return false;
	return basename(value) === value;
}

function isTempRootOwnershipRecord(value: unknown): value is TempRootOwnershipRecord {
	if (!isRecord(value)) return false;
	if (value.kind !== TEMP_ROOT_MARKER_KIND || value.version !== TEMP_ROOT_MARKER_VERSION) return false;
	if (!isPositiveFiniteNumber(value.createdAtMs)) return false;
	if (value.leaseUpdatedAtMs !== undefined && !isPositiveFiniteNumber(value.leaseUpdatedAtMs)) return false;
	if (value.ownerPid !== undefined) {
		if (typeof value.ownerPid !== "number" || !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0) return false;
	}
	if (value.ownerProcessStartIdentity !== undefined) {
		if (typeof value.ownerProcessStartIdentity !== "string" || value.ownerProcessStartIdentity.trim() === "") return false;
	}
	if (value.ownerUid !== undefined) {
		if (typeof value.ownerUid !== "number" || !Number.isSafeInteger(value.ownerUid) || value.ownerUid < 0) return false;
	}
	if (value.protectedChildNames !== undefined) {
		if (!Array.isArray(value.protectedChildNames)) return false;
		if (!value.protectedChildNames.every(isProtectedTempChildName)) return false;
	}
	return true;
}

function getTempArtifactByteLength(content: string | Uint8Array): number {
	return typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
}

function enqueueTempMutation<T>(task: () => Promise<T>): Promise<T> {
	const nextTask = tempMutationQueue.then(task, task);
	tempMutationQueue = nextTask.then(
		() => undefined,
		() => undefined,
	);
	return nextTask;
}

async function listArtifactFiles(directory: string, excludedNames: ReadonlySet<string> = new Set()): Promise<Array<{ mtimeMs: number; path: string; size: number }>> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const files: Array<{ mtimeMs: number; path: string; size: number }> = [];
	for (const entry of entries) {
		if (!entry.isFile() || excludedNames.has(entry.name)) continue;
		const path = join(directory, entry.name);
		const stats = await stat(path).catch(() => undefined);
		if (stats?.isFile()) {
			files.push({ mtimeMs: stats.mtimeMs, path, size: stats.size });
		}
	}
	return files;
}

async function getTempRootArtifactBytes(tempRoot: string): Promise<number> {
	const files = await listArtifactFiles(tempRoot, new Set([TEMP_ROOT_MARKER_FILE_NAME]));
	return files.reduce((totalBytes, file) => totalBytes + file.size, 0);
}

async function readTempRootOwnershipMarker(tempRoot: string): Promise<TempRootOwnershipRecord | undefined> {
	try {
		const markerText = await readFile(join(tempRoot, TEMP_ROOT_MARKER_FILE_NAME), "utf8");
		const parsed = JSON.parse(markerText) as unknown;
		return isTempRootOwnershipRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function getProtectedTempChildName(tempRoot: string, childPath: string): string | undefined {
	const normalizedTempRoot = resolve(tempRoot);
	const normalizedChildPath = resolve(childPath);
	if (dirname(normalizedChildPath) !== normalizedTempRoot) return undefined;
	const childName = basename(normalizedChildPath);
	return isProtectedTempChildName(childName) ? childName : undefined;
}

function normalizeProtectedChildNames(names: Iterable<string>): string[] {
	return [...new Set([...names].filter(isProtectedTempChildName))].sort();
}

function getPersistedProtectedChildPaths(tempRoot: string, ownershipMarker: TempRootOwnershipRecord | undefined): Set<string> {
	const normalizedTempRoot = resolve(tempRoot);
	return new Set((ownershipMarker?.protectedChildNames ?? []).map((childName) => resolve(join(normalizedTempRoot, childName))));
}

async function writeTempRootOwnershipMarkerRecord(
	tempRoot: string,
	markerRecord: TempRootOwnershipRecord,
	options: { flag?: "wx" } = {},
): Promise<string> {
	const markerPath = join(tempRoot, TEMP_ROOT_MARKER_FILE_NAME);
	await writeFile(markerPath, JSON.stringify(markerRecord, null, 2), {
		encoding: "utf8",
		flag: options.flag,
		mode: 0o600,
	});
	await chmod(markerPath, 0o600).catch(() => undefined);
	return markerPath;
}

async function persistProtectedTempChildren(tempRoot: string, protectedChildren: ReadonlySet<string>): Promise<void> {
	if (protectedChildren.size === 0) return;
	const ownershipMarker = await readTempRootOwnershipMarker(tempRoot);
	if (!ownershipMarker) return;
	const childNames = normalizeProtectedChildNames([
		...(ownershipMarker.protectedChildNames ?? []),
		...[...protectedChildren]
			.map((path) => getProtectedTempChildName(tempRoot, path))
			.filter((childName): childName is string => childName !== undefined),
	]);
	if (childNames.length === 0) return;
	await writeTempRootOwnershipMarkerRecord(tempRoot, {
		...ownershipMarker,
		leaseUpdatedAtMs: Date.now(),
		protectedChildNames: childNames,
	});
}

async function getExistingProtectedChildren(
	tempRoot: string,
	protectedChildren: ReadonlySet<string>,
): Promise<Set<string>> {
	const normalizedTempRoot = resolve(tempRoot);
	const existingChildren = new Set<string>();
	for (const path of protectedChildren) {
		const normalizedPath = resolve(path);
		if (dirname(normalizedPath) !== normalizedTempRoot) continue;
		if (await stat(normalizedPath).then((stats) => stats.isDirectory(), () => false)) {
			existingChildren.add(normalizedPath);
		}
	}
	return existingChildren;
}

async function removeTempRootChildrenExcept(tempRoot: string, protectedChildren: ReadonlySet<string>): Promise<void> {
	const entries = await readdir(tempRoot, { withFileTypes: true }).catch(() => []);
	await Promise.all(entries.map(async (entry) => {
		if (entry.name === TEMP_ROOT_MARKER_FILE_NAME) return;
		const entryPath = join(tempRoot, entry.name);
		if (protectedChildren.has(resolve(entryPath))) return;
		await rm(entryPath, { force: true, recursive: true }).catch(() => undefined);
	}));
}

async function getProcessStartIdentity(pid: number | undefined): Promise<string | undefined> {
	if (pid === undefined) return undefined;
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
			timeout: PROCESS_START_IDENTITY_TIMEOUT_MS,
		});
		const identity = stdout.trim().replace(/\s+/g, " ");
		return identity || undefined;
	} catch {
		return undefined;
	}
}

export async function writeSecureTempRootOwnershipMarker(
	tempRoot: string,
	options: TempRootOwnershipMarkerOptions = {},
): Promise<string> {
	const createdAtMs = options.createdAtMs ?? Date.now();
	const ownerPid = options.ownerPid ?? process.pid;
	const markerRecord: TempRootOwnershipRecord = {
		createdAtMs,
		kind: TEMP_ROOT_MARKER_KIND,
		leaseUpdatedAtMs: options.leaseUpdatedAtMs ?? createdAtMs,
		ownerPid,
		ownerProcessStartIdentity: options.ownerProcessStartIdentity ?? (await getProcessStartIdentity(ownerPid)),
		ownerUid: getCurrentProcessUid(),
		version: TEMP_ROOT_MARKER_VERSION,
	};
	return await writeTempRootOwnershipMarkerRecord(tempRoot, markerRecord, { flag: "wx" });
}

async function refreshSecureTempRootLease(tempRoot: string): Promise<void> {
	const ownershipMarker = await readTempRootOwnershipMarker(tempRoot);
	if (!ownershipMarker) return;
	if (ownershipMarker.ownerPid !== process.pid) return;
	const currentUid = getCurrentProcessUid();
	if (currentUid !== undefined && ownershipMarker.ownerUid !== undefined && ownershipMarker.ownerUid !== currentUid) return;
	const currentProcessStartIdentity = await getProcessStartIdentity(process.pid);
	if (
		ownershipMarker.ownerProcessStartIdentity !== undefined &&
		currentProcessStartIdentity !== undefined &&
		ownershipMarker.ownerProcessStartIdentity !== currentProcessStartIdentity
	) {
		return;
	}
	const refreshedMarker: TempRootOwnershipRecord = {
		...ownershipMarker,
		leaseUpdatedAtMs: Date.now(),
		ownerPid: process.pid,
		ownerProcessStartIdentity: currentProcessStartIdentity ?? ownershipMarker.ownerProcessStartIdentity,
		ownerUid: currentUid,
	};
	await writeTempRootOwnershipMarkerRecord(tempRoot, refreshedMarker);
}

async function getMarkerOwnerLiveness(ownershipMarker: TempRootOwnershipRecord): Promise<ProcessLiveness> {
	const pid = ownershipMarker.ownerPid;
	if (pid === undefined) return "unknown";
	try {
		process.kill(pid, 0);
	} catch (error) {
		const errorWithCode = error as NodeJS.ErrnoException;
		if (errorWithCode.code === "ESRCH") return "dead";
		if (errorWithCode.code !== "EPERM") return "unknown";
	}

	const currentProcessStartIdentity = await getProcessStartIdentity(pid);
	if (ownershipMarker.ownerProcessStartIdentity === undefined || currentProcessStartIdentity === undefined) {
		return "unknown";
	}
	return ownershipMarker.ownerProcessStartIdentity === currentProcessStartIdentity ? "alive" : "dead";
}

async function pruneStaleTempRoots(currentTempRoot: string | undefined): Promise<void> {
	const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
	const cutoffTime = Date.now() - STALE_TEMP_ROOT_MAX_AGE_MS;
	const currentUid = getCurrentProcessUid();

	await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_ROOT_PREFIX))
			.map(async (entry) => {
				const path = join(tmpdir(), entry.name);
				if (path === currentTempRoot) return;

				const ownershipMarker = await readTempRootOwnershipMarker(path);
				if (!ownershipMarker) return;
				if (
					currentUid !== undefined &&
					ownershipMarker.ownerUid !== undefined &&
					ownershipMarker.ownerUid !== currentUid
				) {
					return;
				}
				const staleTimestampMs = ownershipMarker.leaseUpdatedAtMs ?? ownershipMarker.createdAtMs;
				if (staleTimestampMs >= cutoffTime) return;
				// Preserve roots when owner liveness cannot be proven; safe cleanup beats deleting another live process's files.
				if ((await getMarkerOwnerLiveness(ownershipMarker)) !== "dead") return;

				const stats = await stat(path).catch(() => undefined);
				if (!stats?.isDirectory()) return;
				const protectedChildren = await getExistingProtectedChildren(
					path,
					getPersistedProtectedChildPaths(path, ownershipMarker),
				);
				if (protectedChildren.size > 0) {
					await removeTempRootChildrenExcept(path, protectedChildren);
					return;
				}
				await rm(path, { force: true, recursive: true }).catch(() => undefined);
			}),
	);
}

function getProtectedChildrenForRoot(tempRoot: string): Set<string> {
	const normalizedTempRoot = resolve(tempRoot);
	return new Set(
		[...protectedTempChildren].filter((path) => dirname(path) === normalizedTempRoot && existsSync(path)),
	);
}

function removeTempRootChildrenExceptSync(tempRoot: string, protectedChildren: ReadonlySet<string>): void {
	for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
		if (entry.name === TEMP_ROOT_MARKER_FILE_NAME) continue;
		const entryPath = join(tempRoot, entry.name);
		if (protectedChildren.has(resolve(entryPath))) continue;
		rmSync(entryPath, { force: true, recursive: true });
	}
}

function registerExitCleanup(): void {
	if (exitCleanupRegistered) return;
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
				// Best-effort cleanup only.
			}
		}
	});
}

export function getSecureTempRootMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInteger(env[TEMP_ROOT_MAX_BYTES_ENV]) ?? DEFAULT_TEMP_ROOT_MAX_BYTES;
}

export function getPersistentSessionArtifactMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInteger(env[SESSION_ARTIFACT_MAX_BYTES_ENV]) ?? DEFAULT_SESSION_ARTIFACT_MAX_BYTES;
}

async function assertSecureTempRootBudget(tempRoot: string, additionalBytes: number): Promise<void> {
	if (additionalBytes <= 0) return;
	const currentBytes = await getTempRootArtifactBytes(tempRoot);
	const maxBytes = getSecureTempRootMaxBytes();
	const nextBytes = currentBytes + additionalBytes;
	if (nextBytes > maxBytes) {
		throw new Error(`pi-agent-browser temp spill budget exceeded (${nextBytes} bytes > ${maxBytes} byte limit).`);
	}
}

export async function cleanupSecureTempArtifacts(options: { preservePaths?: readonly string[] } = {}): Promise<void> {
	await enqueueTempMutation(async () => {
		const tempRoot = await sessionTempRootPromise?.catch(() => undefined);
		if (!tempRoot) return;
		const normalizedTempRoot = resolve(tempRoot);
		for (const path of options.preservePaths ?? []) {
			const childName = getProtectedTempChildName(normalizedTempRoot, path);
			if (childName) protectedTempChildren.add(resolve(join(normalizedTempRoot, childName)));
		}
		const preservedChildren = await getExistingProtectedChildren(normalizedTempRoot, protectedTempChildren);
		for (const path of protectedTempChildren) {
			if (dirname(path) === normalizedTempRoot && !preservedChildren.has(path)) protectedTempChildren.delete(path);
		}
		if (preservedChildren.size === 0) {
			sessionTempRootPromise = undefined;
			ownedTempRoots.delete(tempRoot);
			await rm(tempRoot, { force: true, recursive: true }).catch(() => undefined);
			return;
		}
		await persistProtectedTempChildren(tempRoot, preservedChildren);
		await removeTempRootChildrenExcept(tempRoot, preservedChildren);
		await refreshSecureTempRootLease(tempRoot).catch(() => undefined);
	});
}

async function ensurePersistentSessionArtifactDir(store: PersistentSessionArtifactStore): Promise<string> {
	const rootDir = join(store.sessionDir, SESSION_ARTIFACTS_ROOT_DIR_NAME);
	const sessionDir = join(rootDir, store.sessionId);
	await mkdir(rootDir, { recursive: true, mode: 0o700 });
	await chmod(rootDir, 0o700).catch(() => undefined);
	await mkdir(sessionDir, { recursive: true, mode: 0o700 });
	await chmod(sessionDir, 0o700).catch(() => undefined);
	return sessionDir;
}

async function prunePersistentSessionArtifactsToBudget(
	sessionArtifactDir: string,
	additionalBytes: number,
	protectedPaths: ReadonlySet<string>,
): Promise<PersistentSessionArtifactEviction[]> {
	if (additionalBytes <= 0) return [];
	const maxBytes = getPersistentSessionArtifactMaxBytes();
	let files = await listArtifactFiles(sessionArtifactDir);
	let totalBytes = files.reduce((total, file) => total + file.size, 0);
	if (totalBytes + additionalBytes <= maxBytes) {
		return [];
	}
	const evictedArtifacts: PersistentSessionArtifactEviction[] = [];
	files = files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
	for (const file of files) {
		if (protectedPaths.has(file.path)) {
			continue;
		}
		await rm(file.path, { force: true }).catch(() => undefined);
		evictedArtifacts.push({ mtimeMs: file.mtimeMs, path: file.path, sizeBytes: file.size });
		totalBytes -= file.size;
		if (totalBytes + additionalBytes <= maxBytes) {
			return evictedArtifacts;
		}
	}
	throw new Error(`pi-agent-browser persisted spill budget exceeded (${totalBytes + additionalBytes} bytes > ${maxBytes} byte limit).`);
}

async function getSessionTempRoot(): Promise<string> {
	if (!sessionTempRootPromise) {
		sessionTempRootPromise = (async () => {
			await pruneStaleTempRoots(undefined);
			const tempRoot = await mkdtemp(join(tmpdir(), TEMP_ROOT_PREFIX));
			await chmod(tempRoot, 0o700).catch(() => undefined);
			await writeSecureTempRootOwnershipMarker(tempRoot);
			ownedTempRoots.add(tempRoot);
			registerExitCleanup();
			return tempRoot;
		})();
	}

	const tempRoot = await sessionTempRootPromise;
	await refreshSecureTempRootLease(tempRoot).catch(() => undefined);
	await pruneStaleTempRoots(tempRoot).catch(() => undefined);
	return tempRoot;
}

export async function openSecureTempFile(prefix: string, suffix: string): Promise<{ fileHandle: Awaited<ReturnType<typeof open>>; path: string }> {
	const tempRoot = await getSessionTempRoot();
	const path = join(tempRoot, `${prefix}-${randomBytes(8).toString("hex")}${suffix}`);
	const fileHandle = await open(path, "wx", 0o600);
	return { fileHandle, path };
}

export async function writeSecureTempChunk(options: {
	content: string | Uint8Array;
	fileHandle: Awaited<ReturnType<typeof open>>;
	path: string;
}): Promise<void> {
	const { content, fileHandle, path } = options;
	await enqueueTempMutation(async () => {
		const tempRoot = dirname(path);
		await refreshSecureTempRootLease(tempRoot).catch(() => undefined);
		await assertSecureTempRootBudget(tempRoot, getTempArtifactByteLength(content));
		await fileHandle.appendFile(content);
	});
}

export async function writeSecureTempFile(options: {
	content: string | Uint8Array;
	prefix: string;
	suffix: string;
}): Promise<string> {
	const { content, prefix, suffix } = options;
	const { fileHandle, path } = await openSecureTempFile(prefix, suffix);
	try {
		await writeSecureTempChunk({ content, fileHandle, path });
	} catch (error) {
		await rm(path, { force: true }).catch(() => undefined);
		throw error;
	} finally {
		await fileHandle.close();
	}
	return path;
}

export async function createSecureTempDirectory(prefix: string): Promise<string> {
	const tempRoot = await getSessionTempRoot();
	await assertSecureTempRootBudget(tempRoot, 0);
	const directory = await mkdtemp(join(tempRoot, prefix));
	await chmod(directory, 0o700).catch(() => undefined);
	await refreshSecureTempRootLease(tempRoot).catch(() => undefined);
	return directory;
}

export async function getSecureTempChildDirectoryValidationError(path: string, childPrefix: string): Promise<string | undefined> {
	const parentDirectory = dirname(path);
	const childName = path.slice(parentDirectory.length + 1);
	if (!childName.startsWith(childPrefix)) {
		return `Refusing to remove ${path}; expected wrapper temp child prefix ${childPrefix}.`;
	}
	const ownershipMarker = await readTempRootOwnershipMarker(parentDirectory);
	if (!ownershipMarker) {
		return `Refusing to remove ${path}; parent directory is not a pi-agent-browser owned temp root.`;
	}
	const currentUid = getCurrentProcessUid();
	if (currentUid !== undefined && ownershipMarker.ownerUid !== undefined && ownershipMarker.ownerUid !== currentUid) {
		return `Refusing to remove ${path}; parent temp root is owned by uid ${ownershipMarker.ownerUid}, not current uid ${currentUid}.`;
	}
	return undefined;
}

export async function writePersistentSessionArtifactFile(options: {
	content: string | Uint8Array;
	prefix: string;
	store: PersistentSessionArtifactStore;
	suffix: string;
}): Promise<PersistentSessionArtifactWriteResult> {
	const { content, prefix, store, suffix } = options;
	return await enqueueTempMutation(async () => {
		const artifactDir = await ensurePersistentSessionArtifactDir(store);
		const evictedArtifacts = await prunePersistentSessionArtifactsToBudget(
			artifactDir,
			getTempArtifactByteLength(content),
			new Set((store.protectedPaths ?? []).filter((path) => dirname(path) === artifactDir)),
		);
		const path = join(artifactDir, `${prefix}-${randomBytes(8).toString("hex")}${suffix}`);
		const fileHandle = await open(path, "wx", 0o600);
		try {
			await fileHandle.writeFile(content);
		} catch (error) {
			await rm(path, { force: true }).catch(() => undefined);
			throw error;
		} finally {
			await fileHandle.close().catch(() => undefined);
		}
		return { evictedArtifacts, path };
	});
}

export async function getSecureTempDebugState(): Promise<{ currentTempRoot?: string; ownedTempRoots: string[] }> {
	return {
		currentTempRoot: await sessionTempRootPromise?.catch(() => undefined),
		ownedTempRoots: [...ownedTempRoots].sort(),
	};
}
