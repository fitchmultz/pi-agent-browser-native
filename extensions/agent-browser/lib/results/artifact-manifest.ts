import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
export { isSessionArtifactManifest } from "./artifact-manifest-validation.js";
import type {
	FileArtifactKind,
	FileArtifactMetadata,
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
} from "./contracts.js";

export function isPendingRecordingCommand(
	command: string | undefined,
	subcommand: string | undefined,
	kind: FileArtifactKind | "spill" | undefined,
): boolean {
	return (
		command === "record" && (subcommand === "start" || subcommand === "restart") && kind === "video"
	);
}

export function isPendingRecordingArtifact(
	artifact: Pick<FileArtifactMetadata, "command" | "subcommand" | "status" | "recordingState"> & {
		readonly kind: FileArtifactKind | "spill";
	},
): boolean {
	return (
		artifact.recordingState === "openRecording" ||
		artifact.status === "pending" ||
		(artifact.status === undefined &&
			isPendingRecordingCommand(artifact.command, artifact.subcommand, artifact.kind))
	);
}

const SESSION_ARTIFACT_MANIFEST_VERSION = 1;
const SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES_ENV =
	"PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES";
export const DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES = 100;

function parsePositiveSafeInteger(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		return undefined;
	}
	return parsed;
}

export function getSessionArtifactManifestMaxEntries(
	env: Readonly<NodeJS.ProcessEnv> = process.env,
): number {
	return (
		parsePositiveSafeInteger(env[SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES_ENV]) ??
		DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES
	);
}

export function buildEvictedSessionArtifactEntries(
	evictedArtifacts: readonly {
		readonly mtimeMs: number;
		readonly path: string;
		readonly sizeBytes: number;
	}[],
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
	const ephemeralCount = manifest.entries.filter(
		(entry) => entry.retentionState === "ephemeral",
	).length;
	const missingCount = manifest.entries.filter(
		(entry) => entry.retentionState === "missing",
	).length;
	const parts = [`${manifest.liveCount} live`, `${manifest.evictedCount} evicted`];
	if (ephemeralCount > 0) {
		parts.push(`${ephemeralCount} ephemeral`);
	}
	if (missingCount > 0) {
		parts.push(`${missingCount} missing`);
	}
	return `Session artifacts: ${parts.join(", ")} (${manifest.entries.length}/${manifest.maxEntries} recent).`;
}

export function getSessionArtifactManifestEntryKey(entry: SessionArtifactManifestEntry): string {
	const pathKey =
		entry.storageScope === "explicit-path" &&
		entry.absolutePath !== undefined &&
		entry.absolutePath.length > 0
			? `${entry.storageScope}:${entry.absolutePath}`
			: `${entry.storageScope}:${entry.path}`;
	const recordingSessionKey =
		entry.command === "record" &&
		entry.kind === "video" &&
		entry.session !== undefined &&
		entry.session.length > 0
			? getAgentBrowserSessionIdentityKey(entry.session, entry.namespace)
			: undefined;
	return recordingSessionKey !== undefined && recordingSessionKey.length > 0
		? `${pathKey}\0${recordingSessionKey}`
		: pathKey;
}

export function retirePendingRecordingManifestEntries(
	manifest: SessionArtifactManifest,
	sessionName: string | undefined,
	namespace?: string,
	nowMs = Date.now(),
): SessionArtifactManifest {
	const sessionKey =
		sessionName !== undefined && sessionName.length > 0
			? getAgentBrowserSessionIdentityKey(sessionName, namespace)
			: undefined;
	const entries = manifest.entries.map((entry) => {
		if (
			sessionKey === undefined ||
			sessionKey.length === 0 ||
			entry.session === undefined ||
			entry.session.length === 0 ||
			getAgentBrowserSessionIdentityKey(entry.session, entry.namespace) !== sessionKey ||
			entry.kind !== "video" ||
			!isPendingRecordingArtifact(entry)
		) {
			return entry;
		}
		return {
			...entry,
			recordingState: undefined,
			status: "unverified" as const,
			subcommand: "close-abandoned",
		};
	});
	if (entries.every((entry, index) => entry === manifest.entries[index])) {
		return manifest;
	}
	return {
		...manifest,
		entries,
		evictedCount: entries.filter((entry) => entry.retentionState === "evicted").length,
		liveCount: entries.filter((entry) => entry.retentionState === "live").length,
		updatedAtMs: nowMs,
	};
}

function getSupersededRecordingKeys(
	candidates: ReadonlyMap<string, SessionArtifactManifestEntry>,
	entry: SessionArtifactManifestEntry,
	key: string,
): string[] {
	if (entry.command !== "record" || entry.kind !== "video") {
		return [];
	}
	const entrySessionKey =
		entry.session !== undefined && entry.session.length > 0
			? getAgentBrowserSessionIdentityKey(entry.session, entry.namespace)
			: undefined;
	return [...candidates]
		.filter(([candidateKey, candidate]) => {
			const sameRecordingSession =
				entrySessionKey === undefined
					? candidate.session === undefined
					: candidate.session !== undefined &&
						getAgentBrowserSessionIdentityKey(candidate.session, candidate.namespace) ===
							entrySessionKey;
			return (
				candidateKey !== key &&
				sameRecordingSession &&
				candidate.kind === "video" &&
				isPendingRecordingArtifact(candidate)
			);
		})
		.map(([candidateKey]) => candidateKey);
}

function mergeManifestEntry(
	existing: SessionArtifactManifestEntry | undefined,
	entry: SessionArtifactManifestEntry,
	nowMs: number,
): SessionArtifactManifestEntry {
	return {
		...existing,
		...entry,
		createdAtMs:
			entry.command === "record" && entry.kind === "video"
				? entry.createdAtMs
				: (existing?.createdAtMs ?? entry.createdAtMs),
		evictedAtMs:
			entry.retentionState === "evicted" ? (entry.evictedAtMs ?? nowMs) : entry.evictedAtMs,
	};
}

function compareManifestEntries(
	left: SessionArtifactManifestEntry,
	right: SessionArtifactManifestEntry,
): number {
	const difference =
		(right.evictedAtMs ?? right.createdAtMs) - (left.evictedAtMs ?? left.createdAtMs);
	if (difference !== 0 && !Number.isNaN(difference)) {
		return difference;
	}
	const pendingDifference =
		Number(isPendingRecordingArtifact(right)) - Number(isPendingRecordingArtifact(left));
	return pendingDifference !== 0 ? pendingDifference : left.path.localeCompare(right.path);
}

export function mergeSessionArtifactManifest(options: {
	readonly base?: SessionArtifactManifest;
	readonly entries?: readonly SessionArtifactManifestEntry[];
	readonly nowMs?: number;
}): SessionArtifactManifest | undefined {
	const nowMs = options.nowMs ?? Date.now();
	const maxEntries = getSessionArtifactManifestMaxEntries();
	const byPath = new Map<string, SessionArtifactManifestEntry>();
	for (const entry of options.base?.entries ?? []) {
		byPath.set(getSessionArtifactManifestEntryKey(entry), entry);
	}
	const orderedEntries = (options.entries ?? [])
		.map((entry, index) => ({ entry, index }))
		.sort((left, right) => {
			const difference = left.entry.createdAtMs - right.entry.createdAtMs;
			return difference !== 0 && !Number.isNaN(difference) ? difference : left.index - right.index;
		})
		.map(({ entry }) => entry);
	for (const entry of orderedEntries) {
		const key = getSessionArtifactManifestEntryKey(entry);
		for (const candidateKey of getSupersededRecordingKeys(byPath, entry, key)) {
			byPath.delete(candidateKey);
		}
		const existing = byPath.get(key);
		byPath.set(key, mergeManifestEntry(existing, entry, nowMs));
	}
	if (byPath.size === 0) {
		return undefined;
	}
	const entries = [...byPath.values()].sort(compareManifestEntries).slice(0, maxEntries);
	return {
		entries,
		evictedCount: entries.filter((entry) => entry.retentionState === "evicted").length,
		liveCount: entries.filter((entry) => entry.retentionState === "live").length,
		maxEntries,
		updatedAtMs: nowMs,
		version: SESSION_ARTIFACT_MANIFEST_VERSION,
	};
}
