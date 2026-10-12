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
	const candidates = entries.filter((entry) => entry.isFile() && !excludedNames.has(entry.name));
	for (let index = 0; index < candidates.length; index += 4) {
		// Four independent stats bound filesystem work; eviction still consumes the original order.
		// oxlint-disable-next-line no-await-in-loop
		const batch = await Promise.all(
			candidates.slice(index, index + 4).map(async (entry) => {
				const path = join(directory, entry.name);
				const stats = await stat(path).catch(() => undefined);
				return stats?.isFile() === true
					? { mtimeMs: stats.mtimeMs, path, size: stats.size }
					: undefined;
			}),
		);
		for (const file of batch) {
			if (file !== undefined) {
				files.push(file);
			}
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
