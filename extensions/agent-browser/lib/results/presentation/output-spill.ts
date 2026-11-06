import type { CommandInfo } from "../../argv-descriptor.js";
import {
	type PersistentSessionArtifactEviction,
	type PersistentSessionArtifactStore,
	writePersistentSessionArtifactFile,
	writeSecureTempFile,
} from "../../temp.js";
import { buildEvictedSessionArtifactEntries } from "../artifact-manifest.js";
import type { ArtifactStorageScope, SessionArtifactManifestEntry } from "../contracts.js";
import { redactModelFacingText, stringifyModelFacing } from "./common.js";

export interface LargeOutputSpillWriteResult {
	readonly evictedArtifacts: readonly Readonly<PersistentSessionArtifactEviction>[];
	readonly path: string;
	readonly storageScope: ArtifactStorageScope;
}

function serializePayload(data: unknown, text: string): string {
	if (typeof data === "string") {
		return redactModelFacingText(data);
	}
	if (typeof data === "number" || typeof data === "boolean") {
		return String(data);
	}
	return data === undefined ? redactModelFacingText(text) : stringifyModelFacing(data);
}

export async function writeLargeOutputSpillFile(options: {
	readonly data: unknown;
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore> | undefined;
	readonly text: string;
}): Promise<LargeOutputSpillWriteResult> {
	const isStructured =
		typeof options.data !== "string" &&
		typeof options.data !== "number" &&
		typeof options.data !== "boolean";
	const fileOptions = {
		content: serializePayload(options.data, options.text),
		prefix: "pi-agent-browser-output",
		suffix: isStructured ? ".json" : ".txt",
	};
	if (options.persistentArtifactStore) {
		return {
			...(await writePersistentSessionArtifactFile({
				...fileOptions,
				store: options.persistentArtifactStore,
			})),
			storageScope: "persistent-session",
		};
	}
	return {
		evictedArtifacts: [],
		path: await writeSecureTempFile(fileOptions),
		storageScope: "process-temp",
	};
}

export function buildSpillArtifactEntries(
	options: LargeOutputSpillWriteResult & { readonly commandInfo: CommandInfo },
): readonly SessionArtifactManifestEntry[] {
	const nowMs = Date.now();
	return [
		{
			command: options.commandInfo.command,
			createdAtMs: nowMs,
			kind: "spill",
			path: options.path,
			retentionState: options.storageScope === "persistent-session" ? "live" : "ephemeral",
			storageScope: options.storageScope,
			subcommand: options.commandInfo.subcommand,
		},
		...buildEvictedSessionArtifactEntries(options.evictedArtifacts, nowMs),
	];
}
