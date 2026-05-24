/**
 * Purpose: Persist full compacted snapshot payloads when model-facing output is shortened.
 * Responsibilities: Write persistent or secure-temp snapshot spill files and merge spill retention metadata into the session artifact manifest.
 * Scope: Snapshot spill artifact lifecycle only; preview planning and presentation text live in snapshot.ts and sibling modules.
 * Usage: Snapshot presentation calls these helpers after deciding a snapshot is too large for inline output.
 * Invariants/Assumptions: Explicit full-output paths are reported but not deleted here; retention state mirrors the backing storage scope.
 */

import type { PersistentSessionArtifactEviction, PersistentSessionArtifactStore } from "../temp.js";
import { writePersistentSessionArtifactFile, writeSecureTempFile } from "../temp.js";
import {
	buildEvictedSessionArtifactEntries,
	formatSessionArtifactRetentionSummary,
	mergeSessionArtifactManifest,
} from "./artifact-manifest.js";
import type { SessionArtifactManifest, SessionArtifactManifestEntry } from "./contracts.js";

const SNAPSHOT_SPILL_FILE_PREFIX = "pi-agent-browser-snapshot";

export interface SnapshotSpillWriteResult {
	evictedArtifacts: PersistentSessionArtifactEviction[];
	path: string;
	storageScope: "persistent-session" | "process-temp";
}

export async function writeSnapshotSpillFile(
	data: Record<string, unknown>,
	persistentArtifactStore: PersistentSessionArtifactStore | undefined,
): Promise<SnapshotSpillWriteResult> {
	const options = {
		content: JSON.stringify(data, null, 2),
		prefix: SNAPSHOT_SPILL_FILE_PREFIX,
		suffix: ".json",
	};
	if (persistentArtifactStore) {
		const result = await writePersistentSessionArtifactFile({ ...options, store: persistentArtifactStore });
		return { ...result, storageScope: "persistent-session" };
	}
	return { evictedArtifacts: [], path: await writeSecureTempFile(options), storageScope: "process-temp" };
}

export function applySnapshotArtifactManifest(options: {
	baseManifest?: SessionArtifactManifest;
	command?: string;
	fullOutputPath?: string;
	spill?: SnapshotSpillWriteResult;
}): { artifactManifest?: SessionArtifactManifest; artifactRetentionSummary?: string } {
	if (!options.fullOutputPath || !options.spill) return {};
	const nowMs = Date.now();
	const entries: SessionArtifactManifestEntry[] = [
		{
			command: options.command,
			createdAtMs: nowMs,
			kind: "spill",
			path: options.fullOutputPath,
			retentionState: options.spill.storageScope === "persistent-session" ? "live" : "ephemeral",
			storageScope: options.spill.storageScope,
		},
		...buildEvictedSessionArtifactEntries(options.spill.evictedArtifacts, nowMs),
	];
	const artifactManifest = mergeSessionArtifactManifest({ base: options.baseManifest, entries, nowMs });
	return artifactManifest ? { artifactManifest, artifactRetentionSummary: formatSessionArtifactRetentionSummary(artifactManifest) } : {};
}
