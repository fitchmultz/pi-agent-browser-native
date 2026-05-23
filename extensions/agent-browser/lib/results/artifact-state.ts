/**
 * Purpose: Centralize small artifact state predicates shared by result classifiers, recommendations, and presentation.
 * Responsibilities: Identify pending recording artifacts whose output is not durable until record stop completes.
 * Scope: Artifact predicates only; verification summaries, manifests, and user-facing formatting live in neighboring modules.
 * Usage: Imported by categories, action recommendations, and presentation to avoid divergent artifact-state rules.
 * Invariants/Assumptions: `record start` video artifacts are pending and should not be treated like verified saved files.
 */

import type { FileArtifactMetadata } from "./contracts.js";

export function isPendingRecordingArtifact(artifact: FileArtifactMetadata): boolean {
	return artifact.command === "record" && artifact.subcommand === "start" && artifact.kind === "video";
}
