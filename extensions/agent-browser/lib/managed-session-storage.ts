import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, win32 } from "node:path";

import { canonicalizeAgentBrowserNamespace } from "./argv-grammar.js";

const MANAGED_SESSION_RESTORE_KEY_PATTERN = /^piab-r2-[a-f\d]{32}$/i;
const MANAGED_SESSION_NAME_PREFIX = "piab-r2-";

export function isManagedSessionRestoreKey(value: string | null | undefined): value is string {
	return typeof value === "string" && MANAGED_SESSION_RESTORE_KEY_PATTERN.test(value);
}
const MANAGED_SESSION_FRESH_SUFFIX_PATTERN = /-fresh-[a-f\d]{10}$/i;
const MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH = 32;
const PROJECT_GENERATION_MARKER_NAME = "pi-agent-browser-project-generation-v1.json";
const PROJECT_GENERATION_MARKER_MAX_BYTES = 1_024;

type ProjectGenerationCacheEntry = {
	gitDirectory: string;
	gitFilesystemIdentity: string;
	identity: string;
	marker: string;
	worktreeDirectory: string;
	worktreeFilesystemIdentity: string;
};
const projectGenerationCache = new Map<string, ProjectGenerationCacheEntry>();

function isAbsoluteHome(path: string, platform: NodeJS.Platform): boolean {
	return platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isTrustedPosixDirectory(path: string, requireCurrentOwner: boolean, platform: NodeJS.Platform = process.platform): boolean {
	const uid = currentUid();
	if (uid === undefined) return false;
	const root = parse(path).root;
	let cursor = root;
	for (const component of path.slice(root.length).split("/").filter(Boolean)) {
		cursor = join(cursor, component);
		let entry;
		try {
			entry = lstatSync(cursor);
		} catch {
			return false;
		}
		if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
		const androidSystemAncestor = platform === "android" && (cursor === "/data" || cursor === "/data/data") && entry.uid === 1000 && (entry.mode & 0o002) === 0;
		const androidAppDirectory = platform === "android" && entry.uid === uid && entry.gid === uid && (entry.mode & 0o002) === 0;
		if (!androidSystemAncestor && entry.uid !== 0 && entry.uid !== uid) return false;
		const writableByOthers = (entry.mode & 0o022) !== 0;
		const rootOwnedStickyDirectory = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
		if (writableByOthers && !rootOwnedStickyDirectory && !androidSystemAncestor && !androidAppDirectory) return false;
	}
	try {
		const leaf = lstatSync(path);
		return !requireCurrentOwner || leaf.uid === uid;
	} catch {
		return false;
	}
}

export function resolveManagedSessionRestoreHome(
	parentEnv: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const configuredHome = platform === "win32" ? parentEnv.USERPROFILE : parentEnv.HOME;
	const candidate = configuredHome ?? homedir();
	if (!candidate || candidate.trim() !== candidate || !isAbsoluteHome(candidate, platform)) return undefined;
	if (platform === "win32") return candidate;
	try {
		const canonical = realpathSync(candidate);
		return isTrustedPosixDirectory(canonical, true, platform) ? canonical : undefined;
	} catch {
		return undefined;
	}
}

export function ensureOwnerOnlyDirectory(path: string, platform: NodeJS.Platform = process.platform): boolean {
	try {
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
		if (platform === "win32") return true;
		const uid = currentUid();
		return uid !== undefined && entry.uid === uid && (entry.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

export function directoryContainsSymlink(path: string): boolean {
	try {
		return readdirSync(path, { withFileTypes: true }).some((entry) => entry.isSymbolicLink());
	} catch {
		return true;
	}
}

function resolveGitCheckout(cwd: string, platform: NodeJS.Platform): { gitDirectory: string; worktreeDirectory: string } | undefined {
	let directory = cwd;
	while (true) {
		const dotGit = join(directory, ".git");
		try {
			const entry = lstatSync(dotGit);
			if (entry.isDirectory() && !entry.isSymbolicLink()) return { gitDirectory: realpathSync(dotGit), worktreeDirectory: realpathSync(directory) };
			if (!entry.isFile() || entry.isSymbolicLink() || entry.size > PROJECT_GENERATION_MARKER_MAX_BYTES) return undefined;
			if (platform !== "win32") {
				const uid = currentUid();
				if (uid === undefined || entry.uid !== uid || (entry.mode & 0o022) !== 0) return undefined;
			}
			const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(dotGit, "utf8"));
			if (!match?.[1]) return undefined;
			return { gitDirectory: realpathSync(resolve(directory, match[1])), worktreeDirectory: realpathSync(directory) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function readProjectGenerationMarker(path: string, platform: NodeJS.Platform): string | undefined {
	try {
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() || !entry.isFile() || entry.size > PROJECT_GENERATION_MARKER_MAX_BYTES) return undefined;
		if (platform !== "win32") {
			const uid = currentUid();
			if (uid === undefined || entry.uid !== uid || (entry.mode & 0o177) !== 0) return undefined;
		}
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; version?: unknown };
		return parsed.version === 1 && typeof parsed.id === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(parsed.id) ? parsed.id : undefined;
	} catch {
		return undefined;
	}
}

function getDirectoryFilesystemIdentity(path: string, platform: NodeJS.Platform): string | undefined {
	try {
		const entry = statSync(path, { bigint: true });
		if (!entry.isDirectory() || entry.dev <= 0n || entry.ino <= 0n) return undefined;
		// ponytail: Android reports mutable ctime as birthtime; use statx birthtime/inode generation when Node exposes either reliably.
		return platform === "android"
			? `${entry.dev}:${entry.ino}`
			: entry.birthtimeNs > 0n ? `${entry.dev}:${entry.ino}:${entry.birthtimeNs}` : undefined;
	} catch {
		return undefined;
	}
}

function resolveManagedSessionRestoreProjectCheckout(cwd: string, platform: NodeJS.Platform): {
	canonicalCwd: string;
	gitDirectory: string;
	worktreeDirectory: string;
} | undefined {
	let canonicalCwd: string;
	try { canonicalCwd = realpathSync(cwd); } catch { return undefined; }
	if (platform !== "win32" && !isTrustedPosixDirectory(canonicalCwd, false, platform)) return undefined;
	const checkout = resolveGitCheckout(canonicalCwd, platform);
	if (!checkout) return undefined;
	if (platform !== "win32" && (
		!isTrustedPosixDirectory(checkout.worktreeDirectory, true, platform)
		|| !isTrustedPosixDirectory(checkout.gitDirectory, true, platform)
	)) return undefined;
	return { canonicalCwd, ...checkout };
}

export function resolveManagedSessionRestoreCheckoutRoot(cwd: string, platform: NodeJS.Platform = process.platform): string | undefined {
	return resolveManagedSessionRestoreProjectCheckout(cwd, platform)?.worktreeDirectory;
}

function resolveProjectGenerationIdentity(cwd: string, platform: NodeJS.Platform = process.platform): string | undefined {
	const checkout = resolveManagedSessionRestoreProjectCheckout(cwd, platform);
	if (!checkout) return undefined;
	const { canonicalCwd } = checkout;
	const gitFilesystemIdentity = getDirectoryFilesystemIdentity(checkout.gitDirectory, platform);
	const worktreeFilesystemIdentity = getDirectoryFilesystemIdentity(checkout.worktreeDirectory, platform);
	if (!gitFilesystemIdentity || !worktreeFilesystemIdentity) return undefined;
	const markerPath = join(checkout.gitDirectory, PROJECT_GENERATION_MARKER_NAME);
	let marker = readProjectGenerationMarker(markerPath, platform);
	const cached = projectGenerationCache.get(canonicalCwd);
	if (cached
		&& cached.gitDirectory === checkout.gitDirectory
		&& cached.worktreeDirectory === checkout.worktreeDirectory
		&& cached.gitFilesystemIdentity === gitFilesystemIdentity
		&& cached.worktreeFilesystemIdentity === worktreeFilesystemIdentity
		&& cached.marker === marker
	) return cached.identity;
	projectGenerationCache.delete(canonicalCwd);
	try {
		if (!marker) {
			const content = JSON.stringify({ id: randomUUID(), version: 1 });
			if (platform === "android") {
				// ponytail: Android denies hard links in app storage; use renameat2(RENAME_NOREPLACE) if Node exposes it.
				try { writeFileSync(markerPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
				}
			} else {
				const candidatePath = `${markerPath}.candidate-${process.pid}-${randomUUID()}`;
				try {
					writeFileSync(candidatePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
					try { linkSync(candidatePath, markerPath); } catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
					}
				} finally {
					try { unlinkSync(candidatePath); } catch {}
				}
			}
			marker = readProjectGenerationMarker(markerPath, platform);
		}
		if (!marker) return undefined;
		const identity = `${platform}:${worktreeFilesystemIdentity}:${gitFilesystemIdentity}:${marker}`;
		projectGenerationCache.set(canonicalCwd, {
			gitDirectory: checkout.gitDirectory,
			gitFilesystemIdentity,
			identity,
			marker,
			worktreeDirectory: checkout.worktreeDirectory,
			worktreeFilesystemIdentity,
		});
		return identity;
	} catch {
		return undefined;
	}
}

export function hasManagedSessionRestoreProjectIdentity(cwd: string): boolean {
	return resolveProjectGenerationIdentity(cwd) !== undefined;
}

/** Keep fresh rotations from one Pi transcript in one private upstream restore pool. */
export function getManagedSessionRestoreScope(sessionName: string): string {
	return sessionName.replace(MANAGED_SESSION_FRESH_SUFFIX_PATTERN, "");
}

/** Stable for one Pi transcript and checkout generation; isolated from other concurrent transcripts. */
export function createManagedSessionRestoreKey(cwd: string, restoreScope = "", platform: NodeJS.Platform = process.platform): string {
	let canonicalCwd = resolve(cwd);
	try { canonicalCwd = realpathSync(canonicalCwd); } catch {}
	const identity = resolveProjectGenerationIdentity(canonicalCwd, platform);
	const material = identity ?? `unavailable:${canonicalCwd}`;
	const digest = createHash("sha256")
		.update(`restore-v3:${material}:scope:${restoreScope}`)
		.digest("hex")
		.slice(0, MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH);
	return `${MANAGED_SESSION_NAME_PREFIX}${digest}`;
}

function hasValidEncryptionKey(parentEnv: NodeJS.ProcessEnv): boolean {
	const value = parentEnv.AGENT_BROWSER_ENCRYPTION_KEY;
	return typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
}

export function getManagedRestoreSessionsDirectory(home: string, namespace?: string): string {
	const canonicalNamespace = canonicalizeAgentBrowserNamespace(namespace);
	return canonicalNamespace
		? join(home, ".agent-browser", "namespaces", canonicalNamespace, "state", "sessions")
		: join(home, ".agent-browser", "sessions");
}

/** Require the upstream 256-bit key format and secure every directory that can receive restore snapshots. */
export function ensureManagedSessionRestoreStorageIsSecure(
	parentEnv: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	namespace?: string,
): boolean {
	const encryptionKey = parentEnv.AGENT_BROWSER_ENCRYPTION_KEY;
	if (encryptionKey !== undefined && !hasValidEncryptionKey(parentEnv)) return false;
	if (platform === "win32") return hasValidEncryptionKey(parentEnv);
	const home = resolveManagedSessionRestoreHome(parentEnv, platform);
	if (!home) return false;
	const root = join(home, ".agent-browser");
	if (!ensureOwnerOnlyDirectory(root, platform)) return false;
	const canonicalNamespace = canonicalizeAgentBrowserNamespace(namespace);
	const stateComponents = canonicalNamespace
		? ["namespaces", canonicalNamespace, "state", "sessions"]
		: ["sessions"];
	let path = root;
	for (const component of stateComponents) {
		path = join(path, component);
		if (!ensureOwnerOnlyDirectory(path, platform)) return false;
	}
	if (directoryContainsSymlink(path)) return false;
	const temporaryDirectory = join(path, ".tmp");
	return ensureOwnerOnlyDirectory(temporaryDirectory, platform) && !directoryContainsSymlink(temporaryDirectory);
}

export function getManagedSessionRestoreProtectedStorageEnv(
	restoreEnabled: boolean,
	parentEnv: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	if (!restoreEnabled) return {};
	const home = resolveManagedSessionRestoreHome(parentEnv, platform);
	if (!home) return {};
	return {
		AGENT_BROWSER_ENCRYPTION_KEY: parentEnv.AGENT_BROWSER_ENCRYPTION_KEY,
		...(platform === "win32" ? { USERPROFILE: home } : { HOME: home }),
	};
}
