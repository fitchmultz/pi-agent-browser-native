/**
 * Purpose: Own persistent session artifact manifest merge, retention, and validation logic.
 * Responsibilities: Parse manifest bounds, recognize manifest entries, merge new artifact rows, and format retention summaries.
 * Scope: Manifest accounting only; artifact detection and presentation live in presentation modules.
 * Usage: Imported by presentation and snapshot artifact persistence paths.
 * Invariants/Assumptions: Explicit-path artifacts are host-owned while persistent-session spill files are bounded by the manifest cap.
 */

import { isRecord } from "../parsing.js";
import type { SessionArtifactManifest, SessionArtifactManifestEntry } from "./contracts.js";

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

export function mergeSessionArtifactManifest(options: {
	base?: SessionArtifactManifest;
	entries?: SessionArtifactManifestEntry[];
	nowMs?: number;
}): SessionArtifactManifest | undefined {
	const nowMs = options.nowMs ?? Date.now();
	const maxEntries = getSessionArtifactManifestMaxEntries();
	const getEntryKey = (entry: SessionArtifactManifestEntry) =>
		entry.storageScope === "explicit-path" && entry.absolutePath ? `${entry.storageScope}:${entry.absolutePath}` : `${entry.storageScope}:${entry.path}`;
	const byPath = new Map<string, SessionArtifactManifestEntry>();
	for (const entry of options.base?.entries ?? []) {
		byPath.set(getEntryKey(entry), entry);
	}
	for (const entry of options.entries ?? []) {
		const key = getEntryKey(entry);
		const existing = byPath.get(key);
		byPath.set(key, {
			...existing,
			...entry,
			createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
			evictedAtMs: entry.retentionState === "evicted" ? (entry.evictedAtMs ?? nowMs) : entry.evictedAtMs,
		});
	}
	if (byPath.size === 0) return undefined;
	const entries = [...byPath.values()]
		.sort((left, right) => {
			const leftTime = left.evictedAtMs ?? left.createdAtMs;
			const rightTime = right.evictedAtMs ?? right.createdAtMs;
			return rightTime - leftTime || left.path.localeCompare(right.path);
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
