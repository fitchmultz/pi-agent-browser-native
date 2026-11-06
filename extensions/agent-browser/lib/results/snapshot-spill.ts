import { redactSensitiveValue } from "../runtime-redaction.js";
import {
	type PersistentSessionArtifactEviction,
	type PersistentSessionArtifactStore,
	writePersistentSessionArtifactFile,
	writeSecureTempFile,
} from "../temp.js";
import {
	buildEvictedSessionArtifactEntries,
	formatSessionArtifactRetentionSummary,
	mergeSessionArtifactManifest,
} from "./artifact-manifest.js";
import type { SessionArtifactManifest, SessionArtifactManifestEntry } from "./contracts.js";

const SNAPSHOT_SPILL_FILE_PREFIX = "pi-agent-browser-snapshot";

export interface SnapshotSpillWriteResult {
	readonly evictedArtifacts: readonly Readonly<PersistentSessionArtifactEviction>[];
	readonly path: string;
	readonly storageScope: "persistent-session" | "process-temp";
}

export async function writeSnapshotSpillFile(
	data: Readonly<Record<string, unknown>>,
	persistentArtifactStore: Readonly<PersistentSessionArtifactStore> | undefined,
): Promise<SnapshotSpillWriteResult> {
	const options = {
		content: JSON.stringify(redactSensitiveValue(data), null, 2),
		prefix: SNAPSHOT_SPILL_FILE_PREFIX,
		suffix: ".json",
	};
	if (persistentArtifactStore) {
		const result = await writePersistentSessionArtifactFile({
			...options,
			store: persistentArtifactStore,
		});
		return { ...result, storageScope: "persistent-session" };
	}
	return {
		evictedArtifacts: [],
		path: await writeSecureTempFile(options),
		storageScope: "process-temp",
	};
}

export function applySnapshotArtifactManifest(options: {
	readonly baseManifest?: SessionArtifactManifest | undefined;
	readonly command?: string;
	readonly fullOutputPath?: string | undefined;
	readonly spill?: SnapshotSpillWriteResult | undefined;
}): { artifactManifest?: SessionArtifactManifest; artifactRetentionSummary?: string } {
	if (
		options.fullOutputPath === undefined ||
		options.fullOutputPath.length === 0 ||
		!options.spill
	) {
		return {};
	}
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
	const artifactManifest = mergeSessionArtifactManifest({
		base: options.baseManifest,
		entries,
		nowMs,
	});
	return artifactManifest
		? {
				artifactManifest,
				artifactRetentionSummary: formatSessionArtifactRetentionSummary(artifactManifest),
			}
		: {};
}
