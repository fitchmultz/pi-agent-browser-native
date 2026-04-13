/**
 * Purpose: Create private temporary and persisted spill files for the pi-agent-browser extension without leaking artifacts broadly on disk.
 * Responsibilities: Maintain a process-private temp root, stamp explicit ownership markers, enforce an aggregate temp-artifact disk budget, create securely permissioned temp files, create session-scoped persisted spill files for resumable sessions, prune explicitly owned stale temp roots from prior runs, and best-effort clean all owned roots on process exit.
 * Scope: Artifact lifecycle helpers only; callers decide what data to write and when to delete or retain long-lived references.
 * Usage: Imported by result/process helpers when they need secure spill files instead of world-readable shared tmp paths.
 * Invariants/Assumptions: Temp artifacts live under the OS temp directory, each active run uses a dedicated 0700 directory, files are created with exclusive 0600 permissions, session-scoped persisted artifacts stay under the pi session directory, and stale pruning only touches roots with an explicit pi-agent-browser ownership marker.
 */

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

export interface PersistentSessionArtifactStore {
	protectedPaths?: readonly string[];
	sessionDir: string;
	sessionId: string;
}

interface TempRootOwnershipRecord {
	createdAtMs: number;
	kind: string;
	ownerUid?: number;
	version: number;
}

let sessionTempRootPromise: Promise<string> | undefined;
let exitCleanupRegistered = false;
let tempMutationQueue = Promise.resolve();
const ownedTempRoots = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getCurrentProcessUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function parsePositiveInteger(rawValue: string | undefined): number | undefined {
	if (typeof rawValue !== "string") return undefined;
	const normalizedValue = rawValue.trim();
	if (!/^\d+$/.test(normalizedValue)) return undefined;
	const parsedValue = Number(normalizedValue);
	if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) return undefined;
	return parsedValue;
}

function isTempRootOwnershipRecord(value: unknown): value is TempRootOwnershipRecord {
	if (!isRecord(value)) return false;
	if (value.kind !== TEMP_ROOT_MARKER_KIND || value.version !== TEMP_ROOT_MARKER_VERSION) return false;
	if (typeof value.createdAtMs !== "number" || !Number.isFinite(value.createdAtMs) || value.createdAtMs <= 0) return false;
	return value.ownerUid === undefined || typeof value.ownerUid === "number";
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

export async function writeSecureTempRootOwnershipMarker(tempRoot: string, createdAtMs = Date.now()): Promise<string> {
	const markerPath = join(tempRoot, TEMP_ROOT_MARKER_FILE_NAME);
	const markerRecord: TempRootOwnershipRecord = {
		createdAtMs,
		kind: TEMP_ROOT_MARKER_KIND,
		ownerUid: getCurrentProcessUid(),
		version: TEMP_ROOT_MARKER_VERSION,
	};
	await writeFile(markerPath, JSON.stringify(markerRecord, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
	await chmod(markerPath, 0o600).catch(() => undefined);
	return markerPath;
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

				const stats = await stat(path).catch(() => undefined);
				if (!stats?.isDirectory() || stats.mtimeMs >= cutoffTime) return;
				await rm(path, { force: true, recursive: true }).catch(() => undefined);
			}),
	);
}

function registerExitCleanup(): void {
	if (exitCleanupRegistered) return;
	exitCleanupRegistered = true;
	process.once("exit", () => {
		for (const tempRoot of ownedTempRoots) {
			try {
				rmSync(tempRoot, { force: true, recursive: true });
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

export async function cleanupSecureTempArtifacts(): Promise<void> {
	await enqueueTempMutation(async () => {
		const tempRoot = await sessionTempRootPromise?.catch(() => undefined);
		sessionTempRootPromise = undefined;
		if (!tempRoot) return;
		ownedTempRoots.delete(tempRoot);
		await rm(tempRoot, { force: true, recursive: true }).catch(() => undefined);
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
): Promise<void> {
	if (additionalBytes <= 0) return;
	const maxBytes = getPersistentSessionArtifactMaxBytes();
	let files = await listArtifactFiles(sessionArtifactDir);
	let totalBytes = files.reduce((total, file) => total + file.size, 0);
	if (totalBytes + additionalBytes <= maxBytes) {
		return;
	}
	files = files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
	for (const file of files) {
		if (protectedPaths.has(file.path)) {
			continue;
		}
		await rm(file.path, { force: true }).catch(() => undefined);
		totalBytes -= file.size;
		if (totalBytes + additionalBytes <= maxBytes) {
			return;
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
		await assertSecureTempRootBudget(dirname(path), getTempArtifactByteLength(content));
		await fileHandle.writeFile(content);
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

export async function writePersistentSessionArtifactFile(options: {
	content: string | Uint8Array;
	prefix: string;
	store: PersistentSessionArtifactStore;
	suffix: string;
}): Promise<string> {
	const { content, prefix, store, suffix } = options;
	return await enqueueTempMutation(async () => {
		const artifactDir = await ensurePersistentSessionArtifactDir(store);
		await prunePersistentSessionArtifactsToBudget(
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
		return path;
	});
}

export async function getSecureTempDebugState(): Promise<{ currentTempRoot?: string; ownedTempRoots: string[] }> {
	return {
		currentTempRoot: await sessionTempRootPromise?.catch(() => undefined),
		ownedTempRoots: [...ownedTempRoots].sort(),
	};
}
