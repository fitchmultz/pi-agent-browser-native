/**
 * Purpose: Create private temporary files for the pi-agent-browser extension without leaking artifacts broadly on disk.
 * Responsibilities: Maintain a process-private temp root, prune stale temp roots from prior runs, create securely permissioned temp files, and best-effort clean the current run's temp root on process exit.
 * Scope: Temporary artifact lifecycle only; callers decide what data to write and when to delete long-lived references.
 * Usage: Imported by result/process helpers when they need secure spill files instead of world-readable shared tmp paths.
 * Invariants/Assumptions: Temp artifacts live under the OS temp directory, the active run uses a dedicated 0700 directory, and files are created with exclusive 0600 permissions.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_ROOT_PREFIX = "pi-agent-browser-";
const STALE_TEMP_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

let sessionTempRootPromise: Promise<string> | undefined;
let exitCleanupRegistered = false;

async function pruneStaleTempRoots(currentTempRoot: string | undefined): Promise<void> {
	const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
	const cutoffTime = Date.now() - STALE_TEMP_ROOT_MAX_AGE_MS;

	await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_ROOT_PREFIX))
			.map(async (entry) => {
				const path = join(tmpdir(), entry.name);
				if (path === currentTempRoot) return;
				const stats = await stat(path).catch(() => undefined);
				if (!stats || stats.mtimeMs >= cutoffTime) return;
				await rm(path, { force: true, recursive: true }).catch(() => undefined);
			}),
	);
}

function registerExitCleanup(tempRoot: string): void {
	if (exitCleanupRegistered) return;
	exitCleanupRegistered = true;
	process.once("exit", () => {
		try {
			rmSync(tempRoot, { force: true, recursive: true });
		} catch {
			// Best-effort cleanup only.
		}
	});
}

export async function cleanupSecureTempArtifacts(): Promise<void> {
	const tempRoot = await sessionTempRootPromise?.catch(() => undefined);
	sessionTempRootPromise = undefined;
	if (!tempRoot) return;
	await rm(tempRoot, { force: true, recursive: true }).catch(() => undefined);
}

async function getSessionTempRoot(): Promise<string> {
	if (!sessionTempRootPromise) {
		sessionTempRootPromise = (async () => {
			await pruneStaleTempRoots(undefined);
			const tempRoot = await mkdtemp(join(tmpdir(), TEMP_ROOT_PREFIX));
			await chmod(tempRoot, 0o700).catch(() => undefined);
			registerExitCleanup(tempRoot);
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

export async function writeSecureTempFile(options: {
	content: string | Uint8Array;
	prefix: string;
	suffix: string;
}): Promise<string> {
	const { content, prefix, suffix } = options;
	const { fileHandle, path } = await openSecureTempFile(prefix, suffix);
	try {
		await fileHandle.writeFile(content);
	} finally {
		await fileHandle.close();
	}
	return path;
}
