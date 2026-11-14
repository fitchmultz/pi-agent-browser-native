import { hash, randomUUID } from "node:crypto";
import {
	linkSync,
	lstatSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isRecord } from "./parsing.js";
import { getErrorCode } from "./process-errors.js";

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
	readonly gitDirectory: string;
	readonly gitFilesystemIdentity: string;
	readonly identity: string;
	readonly marker: string;
	readonly worktreeDirectory: string;
	readonly worktreeFilesystemIdentity: string;
};
const projectGenerationCache = new Map<string, ProjectGenerationCacheEntry>();

import { isTrustedPosixDirectory, isTrustedCurrentFile } from "./managed-session-posix-storage.js";

function readGitPointer(
	directory: string,
	entry: Stats,
	platform: NodeJS.Platform,
): { readonly gitDirectory: string; readonly worktreeDirectory: string } | undefined {
	const dotGit = join(directory, ".git");
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.size > PROJECT_GENERATION_MARKER_MAX_BYTES ||
		!isTrustedCurrentFile(entry, platform, 0o022)
	) {
		return undefined;
	}
	const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(dotGit, "utf8"));
	if (match?.[1] === undefined || match[1].length === 0) {
		return undefined;
	}
	return {
		gitDirectory: realpathSync(resolve(directory, match[1])),
		worktreeDirectory: realpathSync(directory),
	};
}

function resolveGitCheckout(
	cwd: string,
	platform: NodeJS.Platform,
): { gitDirectory: string; worktreeDirectory: string } | undefined {
	let directory = cwd;
	while (true) {
		const dotGit = join(directory, ".git");
		try {
			const entry = lstatSync(dotGit);
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				return { gitDirectory: realpathSync(dotGit), worktreeDirectory: realpathSync(directory) };
			}
			return readGitPointer(directory, entry, platform);
		} catch (error) {
			if (getErrorCode(error) !== "ENOENT") {
				return undefined;
			}
		}
		const parent = dirname(directory);
		if (parent === directory) {
			return undefined;
		}
		directory = parent;
	}
}

function readProjectGenerationMarker(path: string, platform: NodeJS.Platform): string | undefined {
	try {
		const entry = lstatSync(path);
		if (
			entry.isSymbolicLink() ||
			!entry.isFile() ||
			entry.size > PROJECT_GENERATION_MARKER_MAX_BYTES
		) {
			return undefined;
		}
		if (!isTrustedCurrentFile(entry, platform, 0o177)) {
			return undefined;
		}
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) {
			return undefined;
		}
		return parsed.version === 1 &&
			typeof parsed.id === "string" &&
			/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(parsed.id)
			? parsed.id
			: undefined;
	} catch {
		return undefined;
	}
}

function getDirectoryFilesystemIdentity(
	path: string,
	platform: NodeJS.Platform,
): string | undefined {
	try {
		const entry = statSync(path, { bigint: true });
		if (!entry.isDirectory() || entry.dev <= 0n || entry.ino <= 0n) {
			return undefined;
		}
		// ponytail: Android reports mutable ctime as birthtime; use statx birthtime/inode generation when Node exposes either reliably.
		if (platform === "android") {
			return `${entry.dev.toString()}:${entry.ino.toString()}`;
		}
		if (entry.birthtimeNs <= 0n) {
			return undefined;
		}
		return `${entry.dev.toString()}:${entry.ino.toString()}:${entry.birthtimeNs.toString()}`;
	} catch {
		return undefined;
	}
}

function resolveManagedSessionRestoreProjectCheckout(
	cwd: string,
	platform: NodeJS.Platform,
):
	| {
			canonicalCwd: string;
			readonly gitDirectory: string;
			readonly worktreeDirectory: string;
	  }
	| undefined {
	let canonicalCwd: string;
	try {
		canonicalCwd = realpathSync(cwd);
	} catch {
		return undefined;
	}
	if (platform !== "win32" && !isTrustedPosixDirectory(canonicalCwd, false, platform)) {
		return undefined;
	}
	const checkout = resolveGitCheckout(canonicalCwd, platform);
	if (!checkout) {
		return undefined;
	}
	if (
		platform !== "win32" &&
		(!isTrustedPosixDirectory(checkout.worktreeDirectory, true, platform) ||
			!isTrustedPosixDirectory(checkout.gitDirectory, true, platform))
	) {
		return undefined;
	}
	return { canonicalCwd, ...checkout };
}

export function resolveManagedSessionRestoreCheckoutRoot(
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	return resolveManagedSessionRestoreProjectCheckout(cwd, platform)?.worktreeDirectory;
}

function matchingCacheIdentity(
	cached: ProjectGenerationCacheEntry | undefined,
	checkout: Readonly<{ gitDirectory: string; worktreeDirectory: string }>,
	filesystem: Readonly<{ git: string; worktree: string; marker?: string | undefined }>,
): string | undefined {
	if (cached === undefined) {
		return undefined;
	}
	return cached.gitDirectory === checkout.gitDirectory &&
		cached.worktreeDirectory === checkout.worktreeDirectory &&
		cached.gitFilesystemIdentity === filesystem.git &&
		cached.worktreeFilesystemIdentity === filesystem.worktree &&
		cached.marker === filesystem.marker
		? cached.identity
		: undefined;
}

function publishGenerationMarker(markerPath: string, platform: NodeJS.Platform): boolean {
	const content = JSON.stringify({ id: randomUUID(), version: 1 });
	if (platform === "android") {
		// ponytail: Android denies hard links in app storage; use renameat2(RENAME_NOREPLACE) if Node exposes it.
		try {
			writeFileSync(markerPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return true;
		} catch (error) {
			return getErrorCode(error) === "EEXIST";
		}
	}
	const candidatePath = `${markerPath}.candidate-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(candidatePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		try {
			linkSync(candidatePath, markerPath);
			return true;
		} catch (error) {
			return getErrorCode(error) === "EEXIST";
		}
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(candidatePath);
		} catch {
			/* Cleanup is best-effort; only the validated published marker supplies identity. */
		}
	}
}

function resolveProjectGenerationIdentity(
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const checkout = resolveManagedSessionRestoreProjectCheckout(cwd, platform);
	if (!checkout) {
		return undefined;
	}
	const { canonicalCwd } = checkout;
	const gitFilesystemIdentity = getDirectoryFilesystemIdentity(checkout.gitDirectory, platform);
	const worktreeFilesystemIdentity = getDirectoryFilesystemIdentity(
		checkout.worktreeDirectory,
		platform,
	);
	if (gitFilesystemIdentity === undefined || worktreeFilesystemIdentity === undefined) {
		return undefined;
	}
	const markerPath = join(checkout.gitDirectory, PROJECT_GENERATION_MARKER_NAME);
	let marker = readProjectGenerationMarker(markerPath, platform);
	const cached = projectGenerationCache.get(canonicalCwd);
	const cachedIdentity = matchingCacheIdentity(cached, checkout, {
		git: gitFilesystemIdentity,
		worktree: worktreeFilesystemIdentity,
		marker,
	});
	if (cachedIdentity !== undefined) {
		return cachedIdentity;
	}
	projectGenerationCache.delete(canonicalCwd);
	try {
		if (marker === undefined) {
			if (!publishGenerationMarker(markerPath, platform)) {
				return undefined;
			}
			marker = readProjectGenerationMarker(markerPath, platform);
		}
		if (marker === undefined) {
			return undefined;
		}
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
export function createManagedSessionRestoreKey(
	cwd: string,
	restoreScope = "",
	platform: NodeJS.Platform = process.platform,
): string {
	let canonicalCwd = resolve(cwd);
	try {
		canonicalCwd = realpathSync(canonicalCwd);
	} catch {
		// Missing cwd keeps the deterministic unavailable identity without claiming a durable checkout.
	}
	const identity = resolveProjectGenerationIdentity(canonicalCwd, platform);
	const material = identity ?? `unavailable:${canonicalCwd}`;
	const digest = hash("sha256", `restore-v3:${material}:scope:${restoreScope}`, "hex").slice(
		0,
		MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH,
	);
	return `${MANAGED_SESSION_NAME_PREFIX}${digest}`;
}
