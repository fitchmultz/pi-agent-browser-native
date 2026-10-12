import { isRecord } from "../parsing.js";
import type { PersistentSessionArtifactStore } from "../temp.js";
import type { SessionArtifactManifest, ToolPresentation } from "./contracts.js";
import { buildCompactSnapshotView } from "./snapshot-compact.js";
import {
	formatRawSnapshotText,
	formatSnapshotSummary,
	getSnapshotText,
} from "./snapshot-content.js";
import { getSnapshotRefRecord } from "./snapshot-refs.js";
import {
	applySnapshotArtifactManifest,
	writeSnapshotSpillFile,
	type SnapshotSpillWriteResult,
} from "./snapshot-spill.js";
import { countLines, stringifyUnknown } from "./text.js";

export { formatRawSnapshotText, formatSnapshotSummary } from "./snapshot-content.js";

function shouldCompactSnapshot(rawText: string, data: Readonly<Record<string, unknown>>): boolean {
	return (
		rawText.length > 6_000 ||
		countLines(getSnapshotText(data) ?? "") > 80 ||
		Object.keys(getSnapshotRefRecord(data) ?? {}).length > 60
	);
}

async function getSnapshotSpill(
	data: Readonly<Record<string, unknown>>,
	store: Readonly<PersistentSessionArtifactStore> | undefined,
): Promise<{
	readonly spill?: SnapshotSpillWriteResult;
	readonly fullOutputPath?: string;
	readonly spillErrorText?: string;
}> {
	try {
		const spill = await writeSnapshotSpillFile(data, store);
		return { spill, fullOutputPath: spill.path };
	} catch (error) {
		return { spillErrorText: error instanceof Error ? error.message : stringifyUnknown(error) };
	}
}

export async function buildSnapshotPresentation(
	data: Readonly<Record<string, unknown>>,
	persistentArtifactStore?: Readonly<PersistentSessionArtifactStore>,
	artifactManifest?: SessionArtifactManifest,
): Promise<ToolPresentation> {
	const summary = formatSnapshotSummary(data);
	const rawText = formatRawSnapshotText(data);
	// Native partials are patches, not accessibility trees; large-output owns oversized patches.
	if (
		(isRecord(data.snapshot) && data.snapshot.kind !== "full") ||
		!shouldCompactSnapshot(rawText, data)
	) {
		return { content: [{ type: "text", text: rawText }], data, summary };
	}
	const { spill, fullOutputPath, spillErrorText } = await getSnapshotSpill(
		data,
		persistentArtifactStore,
	);
	const compact = buildCompactSnapshotView(data, fullOutputPath, spillErrorText);
	const manifestFields = applySnapshotArtifactManifest({
		baseManifest: artifactManifest,
		command: "snapshot",
		fullOutputPath,
		spill,
	});
	const notice = manifestFields.artifactRetentionSummary;
	const text = compact.content.at(0);
	if (notice !== undefined && notice.length > 0 && text?.type === "text") {
		compact.content[0] = { type: "text", text: `${text.text}\n\n${notice}` };
	}
	return { ...manifestFields, ...compact, fullOutputPath, summary: `${summary} (compact)` };
}
