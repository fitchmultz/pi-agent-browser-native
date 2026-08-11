import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
import { isRecord } from "../parsing.js";
import type { FileArtifactKind, FileArtifactMetadata, SessionArtifactManifest, SessionArtifactManifestEntry } from "./contracts.js";

export function isPendingRecordingCommand(command: string | undefined, subcommand: string | undefined, kind: FileArtifactKind | "spill" | undefined): boolean {
	return command === "record" && (subcommand === "start" || subcommand === "restart") && kind === "video";
}

export function isPendingRecordingArtifact(artifact: FileArtifactMetadata): boolean {
	return isPendingRecordingCommand(artifact.command, artifact.subcommand, artifact.kind);
}

export const SESSION_ARTIFACT_MANIFEST_VERSION = 1;
export const SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES_ENV = "PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES";
export const DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES = 100;

function parsePositiveSafeInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
	return parsed;
}

export function getSessionArtifactManifestMaxEntries(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveSafeInteger(env[SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES_ENV]) ?? DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES;
}

function isManifestEntry(value: unknown): value is SessionArtifactManifestEntry {
	if (!isRecord(value)) return false;
	if (typeof value.path !== "string" || value.path.trim().length === 0) return false;
	if (typeof value.createdAtMs !== "number" || !Number.isFinite(value.createdAtMs)) return false;
	if (!["evicted", "ephemeral", "live", "missing"].includes(String(value.retentionState))) return false;
	if (!["explicit-path", "persistent-session", "process-temp"].includes(String(value.storageScope))) return false;
	if (typeof value.kind !== "string" || value.kind.trim().length === 0) return false;
	for (const key of ["absolutePath", "command", "cwd", "extension", "mediaType", "namespace", "requestedPath", "session", "subcommand"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") return false;
	}
	if (value.evictedAtMs !== undefined && (typeof value.evictedAtMs !== "number" || !Number.isFinite(value.evictedAtMs))) return false;
	if (value.exists !== undefined && typeof value.exists !== "boolean") return false;
	if (value.sizeBytes !== undefined && (typeof value.sizeBytes !== "number" || !Number.isFinite(value.sizeBytes) || value.sizeBytes < 0)) return false;
	return true;
}

export function isSessionArtifactManifest(value: unknown): value is SessionArtifactManifest {
	if (!isRecord(value)) return false;
	if (value.version !== SESSION_ARTIFACT_MANIFEST_VERSION) return false;
	if (!Array.isArray(value.entries) || !value.entries.every(isManifestEntry)) return false;
	if (typeof value.updatedAtMs !== "number" || !Number.isFinite(value.updatedAtMs)) return false;
	if (typeof value.maxEntries !== "number" || !Number.isSafeInteger(value.maxEntries) || value.maxEntries <= 0) return false;
	if (typeof value.liveCount !== "number" || !Number.isSafeInteger(value.liveCount) || value.liveCount < 0) return false;
	if (typeof value.evictedCount !== "number" || !Number.isSafeInteger(value.evictedCount) || value.evictedCount < 0) return false;
	return true;
}

export function buildEvictedSessionArtifactEntries(
	evictedArtifacts: Array<{ mtimeMs: number; path: string; sizeBytes: number }>,
	nowMs: number,
): SessionArtifactManifestEntry[] {
	return evictedArtifacts.map((artifact) => ({
		createdAtMs: artifact.mtimeMs,
		evictedAtMs: nowMs,
		kind: "spill",
		path: artifact.path,
		retentionState: "evicted",
		sizeBytes: artifact.sizeBytes,
		storageScope: "persistent-session",
	}));
}

export function formatSessionArtifactRetentionSummary(manifest: SessionArtifactManifest): string {
	const ephemeralCount = manifest.entries.filter((entry) => entry.retentionState === "ephemeral").length;
	const missingCount = manifest.entries.filter((entry) => entry.retentionState === "missing").length;
	const parts = [`${manifest.liveCount} live`, `${manifest.evictedCount} evicted`];
	if (ephemeralCount > 0) parts.push(`${ephemeralCount} ephemeral`);
	if (missingCount > 0) parts.push(`${missingCount} missing`);
	return `Session artifacts: ${parts.join(", ")} (${manifest.entries.length}/${manifest.maxEntries} recent).`;
}

export function getSessionArtifactManifestEntryKey(entry: SessionArtifactManifestEntry): string {
	const pathKey = entry.storageScope === "explicit-path" && entry.absolutePath ? `${entry.storageScope}:${entry.absolutePath}` : `${entry.storageScope}:${entry.path}`;
	const recordingSessionKey = entry.command === "record" && entry.kind === "video" && entry.session
		? getAgentBrowserSessionIdentityKey(entry.session, entry.namespace)
		: undefined;
	return recordingSessionKey ? `${pathKey}\0${recordingSessionKey}` : pathKey;
}

export function retirePendingRecordingManifestEntries(
	manifest: SessionArtifactManifest,
	sessionName: string | undefined,
	namespace?: string,
	nowMs = Date.now(),
): SessionArtifactManifest {
	let changed = false;
	const sessionKey = sessionName ? getAgentBrowserSessionIdentityKey(sessionName, namespace) : undefined;
	const entries = manifest.entries.map((entry) => {
		if (!sessionKey
			|| !entry.session
			|| getAgentBrowserSessionIdentityKey(entry.session, entry.namespace) !== sessionKey
			|| entry.kind !== "video"
			|| !isPendingRecordingCommand(entry.command, entry.subcommand, entry.kind)) return entry;
		changed = true;
		return { ...entry, retentionState: "missing" as const, subcommand: "close-abandoned" };
	});
	if (!changed) return manifest;
	return {
		...manifest,
		entries,
		evictedCount: entries.filter((entry) => entry.retentionState === "evicted").length,
		liveCount: entries.filter((entry) => entry.retentionState === "live").length,
		updatedAtMs: nowMs,
	};
}

export function mergeSessionArtifactManifest(options: {
	base?: SessionArtifactManifest;
	entries?: SessionArtifactManifestEntry[];
	nowMs?: number;
}): SessionArtifactManifest | undefined {
	const nowMs = options.nowMs ?? Date.now();
	const maxEntries = getSessionArtifactManifestMaxEntries();
	const byPath = new Map<string, SessionArtifactManifestEntry>();
	for (const entry of options.base?.entries ?? []) {
		byPath.set(getSessionArtifactManifestEntryKey(entry), entry);
	}
	const orderedEntries = (options.entries ?? [])
		.map((entry, index) => ({ entry, index }))
		.sort((left, right) => left.entry.createdAtMs - right.entry.createdAtMs || left.index - right.index)
		.map(({ entry }) => entry);
	for (const entry of orderedEntries) {
		const key = getSessionArtifactManifestEntryKey(entry);
		if (entry.command === "record" && entry.kind === "video") {
			const entrySessionKey = entry.session ? getAgentBrowserSessionIdentityKey(entry.session, entry.namespace) : undefined;
			for (const [candidateKey, candidate] of byPath) {
				const sameRecordingSession = entrySessionKey === undefined
					? candidate.session === undefined
					: candidate.session !== undefined && getAgentBrowserSessionIdentityKey(candidate.session, candidate.namespace) === entrySessionKey;
				if (candidateKey !== key
					&& sameRecordingSession
					&& candidate.kind === "video"
					&& isPendingRecordingCommand(candidate.command, candidate.subcommand, candidate.kind)) {
					byPath.delete(candidateKey);
				}
			}
		}
		const existing = byPath.get(key);
		byPath.set(key, {
			...existing,
			...entry,
			createdAtMs: entry.command === "record" && entry.kind === "video" ? entry.createdAtMs : existing?.createdAtMs ?? entry.createdAtMs,
			evictedAtMs: entry.retentionState === "evicted" ? (entry.evictedAtMs ?? nowMs) : entry.evictedAtMs,
		});
	}
	if (byPath.size === 0) return undefined;
	const entries = [...byPath.values()]
		.sort((left, right) => {
			const leftTime = left.evictedAtMs ?? left.createdAtMs;
			const rightTime = right.evictedAtMs ?? right.createdAtMs;
			return rightTime - leftTime
				|| Number(isPendingRecordingCommand(right.command, right.subcommand, right.kind)) - Number(isPendingRecordingCommand(left.command, left.subcommand, left.kind))
				|| left.path.localeCompare(right.path);
		})
		.slice(0, maxEntries);
	return {
		entries,
		evictedCount: entries.filter((entry) => entry.retentionState === "evicted").length,
		liveCount: entries.filter((entry) => entry.retentionState === "live").length,
		maxEntries,
		updatedAtMs: nowMs,
		version: SESSION_ARTIFACT_MANIFEST_VERSION,
	};
}
