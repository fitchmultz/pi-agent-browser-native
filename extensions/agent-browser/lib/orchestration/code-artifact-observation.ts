import { isRecord } from "../parsing.js";
import type { ArtifactVerificationState } from "../results/contracts.js";

export interface CodeArtifactReceipt {
	readonly [key: string]: unknown;
	readonly absolutePath?: string | undefined;
	readonly path: string;
	readonly state: ArtifactVerificationState;
}
export interface CodeFileArtifact {
	readonly [key: string]: unknown;
	readonly absolutePath: string;
}
export function collectCodeArtifactReceipts(value: unknown): readonly CodeArtifactReceipt[] {
	if (!isRecord(value) || !Array.isArray(value.artifacts)) {
		return [];
	}
	const entries: CodeArtifactReceipt[] = [];
	for (const entry of value.artifacts) {
		if (!isRecord(entry) || typeof entry.path !== "string") {
			continue;
		}
		const states: readonly ArtifactVerificationState[] = [
			"missing",
			"pending",
			"unverified",
			"verified",
		];
		const state = states.find((candidate) => candidate === entry.state);
		if (state === undefined) {
			continue;
		}
		entries.push({
			...entry,
			path: entry.path,
			state,
			absolutePath: typeof entry.absolutePath === "string" ? entry.absolutePath : undefined,
		});
	}
	return entries;
}
export function collectCodeFileArtifacts(value: unknown): readonly CodeFileArtifact[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter(isRecord)
		.flatMap((entry) =>
			typeof entry.absolutePath === "string"
				? [{ ...entry, absolutePath: entry.absolutePath }]
				: [],
		);
}
