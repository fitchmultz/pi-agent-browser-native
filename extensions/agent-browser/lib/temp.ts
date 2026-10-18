import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { enqueueTempMutation } from "./temp-mutation-queue.js";
import { getSessionTempRoot, refreshSecureTempRootLease } from "./temp-root.js";
import {
	assertSecureTempRootBudget,
	getTempArtifactByteLength,
	prunePersistentSessionArtifactsToBudget,
	type PersistentSessionArtifactStore,
	type PersistentSessionArtifactWriteResult,
} from "./temp-artifact-budget.js";
export {
	cleanupSecureTempArtifacts,
	getSecureTempChildDirectoryValidationError,
	preserveSecureTempDirectory,
	writeSecureTempRootOwnershipMarker,
} from "./temp-root.js";
export {
	getPersistentSessionArtifactMaxBytes,
	getSecureTempRootMaxBytes,
	type PersistentSessionArtifactStore,
	type PersistentSessionArtifactEviction,
	type PersistentSessionArtifactWriteResult,
} from "./temp-artifact-budget.js";

async function ensurePersistentSessionArtifactDir(
	store: PersistentSessionArtifactStore,
): Promise<string> {
	const rootDir = join(store.sessionDir, ".pi-agent-browser-artifacts");
	const sessionDir = join(rootDir, store.sessionId);
	await mkdir(rootDir, { recursive: true, mode: 0o700 });
	await chmod(rootDir, 0o700).catch(() => {
		/* Native creation may already enforce the mode. */
	});
	await mkdir(sessionDir, { recursive: true, mode: 0o700 });
	await chmod(sessionDir, 0o700).catch(() => {
		/* Native creation may already enforce the mode. */
	});
	return sessionDir;
}
export async function openSecureTempFile(
	prefix: string,
	suffix: string,
): Promise<{ fileHandle: Awaited<ReturnType<typeof open>>; path: string }> {
	const tempRoot = await getSessionTempRoot();
	const path = join(tempRoot, `${prefix}-${randomBytes(8).toString("hex")}${suffix}`);
	const fileHandle = await open(path, "wx", 0o600);
	return { fileHandle, path };
}
export async function writeSecureTempChunk(options: {
	readonly content: string | Uint8Array;
	readonly fileHandle: Awaited<ReturnType<typeof open>>;
	readonly path: string;
}): Promise<void> {
	const { content, fileHandle, path } = options;
	await enqueueTempMutation(async () => {
		const tempRoot = dirname(path);
		await refreshSecureTempRootLease(tempRoot).catch(() => {
			/* Lease renewal is best-effort; file ownership is already captured. */
		});
		await assertSecureTempRootBudget(tempRoot, getTempArtifactByteLength(content));
		await fileHandle.appendFile(content);
	});
}
export async function writeSecureTempFile(options: {
	readonly content: string | Uint8Array;
	readonly prefix: string;
	readonly suffix: string;
}): Promise<string> {
	const { content, prefix, suffix } = options;
	const { fileHandle, path } = await openSecureTempFile(prefix, suffix);
	try {
		await writeSecureTempChunk({ content, fileHandle, path });
	} catch (error) {
		await rm(path, { force: true }).catch(() => {
			/* Retain the original write failure if removal also fails. */
		});
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
	await chmod(directory, 0o700).catch(() => {
		/* mkdtemp supplies the private directory when chmod is unavailable. */
	});
	await refreshSecureTempRootLease(tempRoot).catch(() => {
		/* Renewal is best-effort after private creation. */
	});
	return directory;
}
export async function writePersistentSessionArtifactFile(options: {
	readonly content: string | Uint8Array;
	readonly prefix: string;
	readonly store: PersistentSessionArtifactStore;
	readonly suffix: string;
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
			await rm(path, { force: true }).catch(() => {
				/* Preserve write failure identity. */
			});
			throw error;
		} finally {
			await fileHandle.close().catch(() => {
				/* A completed artifact write retains its receipt even if close fails. */
			});
		}
		return { evictedArtifacts, path };
	});
}
