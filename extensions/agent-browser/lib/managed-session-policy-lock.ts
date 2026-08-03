/**
 * Purpose: Serialize wrapper-owned daemon policy decisions across cooperating Pi processes.
 * Responsibilities: Acquire a short user-private lock keyed by canonical namespace/session identity, recover proven-dead owners, and release only the caller's token.
 * Scope: Wrapper coordination only; agent-browser never reads this lock.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalizeAgentBrowserNamespace, getAgentBrowserSessionIdentityKey } from "./argv-grammar.js";
import { processStartIdentitiesMatch, readProcessStartIdentity } from "./process-identity.js";

const POLICY_LOCK_WAIT_MS = 1_000;
const POLICY_LOCK_RETRY_MS = 10;
const POLICY_LOCK_MAX_BYTES = 4_096;
const LOCK_OWNER_FILE = "owner.json";

interface PolicyLockOwner {
	pid: number;
	startIdentity: string;
	token: string;
	version: 2;
}

export interface ManagedSessionPolicyLock {
	release: () => Promise<void>;
}

function getCoordinationDirectory(platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") {
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		return `/tmp/pi-agent-browser-policy${uid === undefined ? "" : `-${uid}`}`;
	}
	const user = process.env.USERNAME ?? process.env.USER ?? "unknown";
	const suffix = createHash("sha256").update(user).digest("hex").slice(0, 12);
	return join(tmpdir(), `pi-agent-browser-policy-${suffix}`);
}

async function ensureCoordinationDirectory(path: string, platform: NodeJS.Platform): Promise<boolean> {
	try {
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
		const entry = await lstat(path);
		if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
		if (platform !== "win32") {
			const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (uid === undefined || entry.uid !== uid || (entry.mode & 0o077) !== 0) return false;
		}
		return true;
	} catch {
		return false;
	}
}

export function getManagedSessionPolicyLockPath(sessionName: string, namespace?: string): string {
	const identity = getAgentBrowserSessionIdentityKey(sessionName, canonicalizeAgentBrowserNamespace(namespace));
	const digest = createHash("sha256").update(identity).digest("hex");
	return join(getCoordinationDirectory(), `.pi-agent-browser-policy-${digest}.lock-v2`);
}

function parseOwner(content: string): PolicyLockOwner | undefined {
	if (Buffer.byteLength(content) > POLICY_LOCK_MAX_BYTES) return undefined;
	try {
		const parsed = JSON.parse(content) as Partial<PolicyLockOwner>;
		return parsed.version === 2
			&& Number.isSafeInteger(parsed.pid) && (parsed.pid ?? 0) > 0
			&& typeof parsed.startIdentity === "string" && parsed.startIdentity.length > 0
			&& typeof parsed.token === "string" && parsed.token.length > 0
			? parsed as PolicyLockOwner
			: undefined;
	} catch {
		return undefined;
	}
}

async function readLockOwner(path: string): Promise<PolicyLockOwner | undefined> {
	try {
		const directory = await lstat(path);
		const ownerPath = join(path, LOCK_OWNER_FILE);
		const ownerEntry = await lstat(ownerPath);
		if (!directory.isDirectory() || directory.isSymbolicLink() || !ownerEntry.isFile() || ownerEntry.isSymbolicLink()) return undefined;
		if (ownerEntry.size > POLICY_LOCK_MAX_BYTES) return undefined;
		if (process.platform !== "win32") {
			const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (uid === undefined || directory.uid !== uid || ownerEntry.uid !== uid || (directory.mode & 0o077) !== 0 || (ownerEntry.mode & 0o177) !== 0) return undefined;
		}
		return parseOwner(await readFile(ownerPath, "utf8"));
	} catch {
		return undefined;
	}
}

async function ownerAlive(owner: PolicyLockOwner): Promise<boolean | undefined> {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code !== "EPERM") return undefined;
	}
	const current = await readProcessStartIdentity(owner.pid);
	return current === undefined ? undefined : processStartIdentitiesMatch(owner.startIdentity, current);
}

async function restoreMovedLock(movedPath: string, path: string): Promise<void> {
	try { await rename(movedPath, path); } catch {}
}

async function removeLockOwnedBy(path: string, token: string, phase: "release" | "stale"): Promise<boolean> {
	const currentOwner = await readLockOwner(path);
	if (currentOwner?.token !== token) return false;
	const movedPath = `${path}.${phase}-${token}`;
	try {
		await rename(path, movedPath);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	const movedOwner = await readLockOwner(movedPath);
	if (movedOwner?.token !== token) {
		await restoreMovedLock(movedPath, path);
		return false;
	}
	await rm(movedPath, { force: true, recursive: true });
	return true;
}

function waitForRetry(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, POLICY_LOCK_RETRY_MS);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

export async function acquireManagedSessionPolicyLock(options: {
	namespace?: string;
	sessionName: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<ManagedSessionPolicyLock | undefined> {
	if (options.signal?.aborted) return undefined;
	const platform = process.platform;
	const directory = getCoordinationDirectory(platform);
	if (!await ensureCoordinationDirectory(directory, platform)) return undefined;
	const path = getManagedSessionPolicyLockPath(options.sessionName, options.namespace);
	const token = randomUUID();
	const startIdentity = await readProcessStartIdentity(process.pid);
	if (!startIdentity) return undefined;
	const owner = { pid: process.pid, startIdentity, token, version: 2 } satisfies PolicyLockOwner;
	const candidatePath = `${path}.candidate-${process.pid}-${token}`;
	try {
		await mkdir(candidatePath, { mode: 0o700 });
		await writeFile(join(candidatePath, LOCK_OWNER_FILE), JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch {
		await rm(candidatePath, { force: true, recursive: true }).catch(() => undefined);
		return undefined;
	}
	const deadline = Date.now() + (options.timeoutMs ?? POLICY_LOCK_WAIT_MS);
	try {
		while (!options.signal?.aborted) {
			try {
				await rename(candidatePath, path);
				const installedOwner = await readLockOwner(path);
				if (installedOwner?.token !== token) return undefined;
				return { release: async () => {
					await removeLockOwnedBy(path, token, "release");
					await rmdir(directory).catch(() => undefined);
				} };
			} catch (error) {
				if (!["EACCES", "EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
			}
			const observed = await readLockOwner(path);
			if (!observed) return undefined;
			if (await ownerAlive(observed) === false) {
				if (await removeLockOwnedBy(path, observed.token, "stale")) continue;
			}
			if (Date.now() >= deadline) return undefined;
			await waitForRetry(options.signal);
		}
		return undefined;
	} finally {
		await rm(candidatePath, { force: true, recursive: true }).catch(() => undefined);
	}
}
