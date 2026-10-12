import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parsePositiveInteger } from "./parsing.js";

const DEFAULT_MAX_BYTES = 32 * 1_024 * 1_024;
export interface PersistentSessionArtifactStore {
	readonly protectedPaths?: readonly string[];
	readonly sessionDir: string;
	readonly sessionId: string;
}
export interface PersistentSessionArtifactEviction {
	readonly mtimeMs: number;
	readonly path: string;
	readonly sizeBytes: number;
}
export interface PersistentSessionArtifactWriteResult {
	evictedArtifacts: PersistentSessionArtifactEviction[];
	path: string;
}

export function getTempArtifactByteLength(content: string | Uint8Array): number {
	return typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
}
export async function listArtifactFiles(
	directory: string,
	excludedNames: ReadonlySet<string> = new Set(),
): Promise<Array<{ mtimeMs: number; path: string; size: number }>> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const files: Array<{ mtimeMs: number; path: string; size: number }> = [];
	for (const entry of entries) {
		if (!entry.isFile() || excludedNames.has(entry.name)) {
			continue;
		}
		const path = join(directory, entry.name);
		// Bound filesystem work and retain the original ordered scan before eviction.
		// oxlint-disable-next-line no-await-in-loop
		const stats = await stat(path).catch(() => undefined);
		if (stats?.isFile() === true) {
			files.push({ mtimeMs: stats.mtimeMs, path, size: stats.size });
		}
	}
	return files;
}
export function getSecureTempRootMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInteger(env.PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES) ?? DEFAULT_MAX_BYTES;
}
export function getPersistentSessionArtifactMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	if (env.PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES?.trim() === "0") {
		return 0;
	}
	return parsePositiveInteger(env.PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES) ?? DEFAULT_MAX_BYTES;
}
export async function assertSecureTempRootBudget(
	tempRoot: string,
	additionalBytes: number,
): Promise<void> {
	if (additionalBytes <= 0) {
		return;
	}
	const files = await listArtifactFiles(tempRoot, new Set([".pi-agent-browser-owner.json"]));
	const currentBytes = files.reduce((total, file) => total + file.size, 0);
	const maxBytes = getSecureTempRootMaxBytes();
	const nextBytes = currentBytes + additionalBytes;
	if (nextBytes > maxBytes) {
		throw new Error(
			`pi-agent-browser temp spill budget exceeded (${nextBytes} bytes > ${maxBytes} byte limit).`,
		);
	}
}
export async function prunePersistentSessionArtifactsToBudget(
	sessionArtifactDir: string,
	additionalBytes: number,
	protectedPaths: ReadonlySet<string>,
): Promise<PersistentSessionArtifactEviction[]> {
	if (additionalBytes <= 0) {
		return [];
	}
	const maxBytes = getPersistentSessionArtifactMaxBytes();
	if (maxBytes === 0) {
		return [];
	}
	const files = await listArtifactFiles(sessionArtifactDir);
	let totalBytes = files.reduce((total, file) => total + file.size, 0);
	if (totalBytes + additionalBytes <= maxBytes) {
		return [];
	}
	const evictedArtifacts: PersistentSessionArtifactEviction[] = [];
	files.sort((left, right) => {
		const time = left.mtimeMs - right.mtimeMs;
		return time === 0 ? left.path.localeCompare(right.path) : time;
	});
	for (const file of files) {
		if (protectedPaths.has(file.path)) {
			continue;
		}
		// Evict oldest first and stop immediately once the required budget is available.
		// oxlint-disable-next-line no-await-in-loop
		const removed = await rm(file.path, { force: true }).then(
			() => true,
			() => false,
		);
		if (!removed) {
			continue;
		}
		evictedArtifacts.push({ mtimeMs: file.mtimeMs, path: file.path, sizeBytes: file.size });
		totalBytes -= file.size;
		if (totalBytes + additionalBytes <= maxBytes) {
			return evictedArtifacts;
		}
	}
	throw new Error(
		`pi-agent-browser persisted spill budget exceeded (${totalBytes + additionalBytes} bytes > ${maxBytes} byte limit).`,
	);
}
