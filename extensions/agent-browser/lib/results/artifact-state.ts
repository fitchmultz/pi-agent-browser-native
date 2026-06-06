/**
 * Purpose: Centralize small artifact state predicates shared by result classifiers, recommendations, and presentation.
 * Responsibilities: Identify pending recording artifacts whose output is not durable until record stop completes.
 * Scope: Artifact predicates only; verification summaries, manifests, and user-facing formatting live in neighboring modules.
 * Usage: Imported by categories, action recommendations, and presentation to avoid divergent artifact-state rules.
 * Invariants/Assumptions: `record start` / `record restart` video artifacts are pending and should not be treated like verified saved files.
 */

import type { FileArtifactKind, FileArtifactMetadata } from "./contracts.js";

export function isPendingRecordingCommand(command: string | undefined, subcommand: string | undefined, kind: FileArtifactKind | undefined): boolean {
	return command === "record" && (subcommand === "start" || subcommand === "restart") && kind === "video";
}

export function isPendingRecordingArtifact(artifact: FileArtifactMetadata): boolean {
	return isPendingRecordingCommand(artifact.command, artifact.subcommand, artifact.kind);
}
