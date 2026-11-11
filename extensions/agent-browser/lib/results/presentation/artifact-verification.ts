import { isPendingRecordingArtifact } from "../artifact-manifest.js";
import { classifyAgentBrowserSuccessCategory } from "../categories.js";
import type {
	AgentBrowserSuccessCategory,
	ArtifactVerificationEntry,
	ArtifactVerificationState,
	ArtifactVerificationSummary,
	FileArtifactMetadata,
	SavedFilePresentationDetails,
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
} from "../contracts.js";

function artifactState(artifact: FileArtifactMetadata): ArtifactVerificationState {
	if (artifact.status === "missing") {
		return "missing";
	}
	if (["failed", "stale", "unverified"].includes(artifact.status ?? "")) {
		return "unverified";
	}
	if (artifact.exists === true) {
		return "verified";
	}
	return artifact.exists === false ? "missing" : "unverified";
}

function artifactLimitation(
	artifact: FileArtifactMetadata,
	state: ArtifactVerificationState,
): string | undefined {
	if (artifact.status === "failed" || artifact.status === "unverified") {
		return "File presence does not prove successful native recording finalization or encoding. Inspect the receipt and original failure.";
	}
	if (artifact.status === "stale") {
		return "The reported path's modification time fell outside this command's bounded artifact window. Treat the artifact as stale until regenerated.";
	}
	if (state === "missing") {
		return artifact.exists === true
			? "The reported capture was missing. Destination existence alone does not prove this capture was saved. Recover or regenerate it."
			: "The wrapper did not find the reported artifact at absolutePath. Treat the path as unverified until recovered or regenerated.";
	}
	return state === "unverified"
		? "The wrapper could not prove local filesystem existence for this artifact."
		: undefined;
}

function getArtifactVerificationEntry(artifact: FileArtifactMetadata): ArtifactVerificationEntry {
	const common = {
		absolutePath: artifact.absolutePath,
		exists: artifact.exists,
		kind: artifact.kind,
		recording: artifact.recording,
		recordingStartedAtMs: artifact.recordingStartedAtMs,
		mediaType: artifact.mediaType,
		path: artifact.path,
		requestedPath: artifact.requestedPath,
		sizeBytes: artifact.sizeBytes,
	};
	if (isPendingRecordingArtifact(artifact)) {
		return {
			...common,
			limitation:
				"Recording output is pending until native finalization succeeds and the file is verified.",
			recordingState: artifact.recordingState ?? "openRecording",
			retentionState: undefined,
			state: "pending",
			status: artifact.status ?? "pending",
			storageScope: undefined,
			willExistOnStop: artifact.willExistOnStop ?? true,
		};
	}
	const state = artifactState(artifact);
	return {
		...common,
		limitation: artifactLimitation(artifact, state),
		retentionState: state === "missing" ? "missing" : "live",
		state,
		status: artifact.status,
		storageScope: "explicit-path",
		updatedAtMs: artifact.updatedAtMs,
	};
}

const MANIFEST_STATES: Readonly<
	Record<SessionArtifactManifestEntry["retentionState"], ArtifactVerificationState>
> = {
	live: "verified",
	missing: "missing",
	evicted: "missing",
	ephemeral: "unverified",
};

function getManifestVerificationEntry(
	entry: SessionArtifactManifestEntry,
): ArtifactVerificationEntry | undefined {
	if (entry.storageScope === "explicit-path") {
		return undefined;
	}
	let limitation: string | undefined;
	if (entry.retentionState === "ephemeral") {
		limitation = "This spill file is process-temporary and may not survive reload or restart.";
	}
	if (entry.retentionState === "evicted") {
		limitation = "This persisted spill file was evicted from the bounded session artifact store.";
	}
	return {
		absolutePath: entry.absolutePath,
		exists: entry.exists,
		kind: entry.kind,
		limitation,
		mediaType: entry.mediaType,
		path: entry.path,
		requestedPath: entry.requestedPath,
		retentionState: entry.retentionState,
		sizeBytes: entry.sizeBytes,
		state: MANIFEST_STATES[entry.retentionState],
		storageScope: entry.storageScope,
	};
}

export function buildArtifactVerificationSummary(
	artifacts: readonly FileArtifactMetadata[],
	manifest?: SessionArtifactManifest,
	manifestPaths?: ReadonlySet<string>,
): ArtifactVerificationSummary | undefined {
	const entries = [
		...artifacts.map(getArtifactVerificationEntry),
		...(manifest?.entries.flatMap((entry) => {
			if (manifestPaths && !manifestPaths.has(entry.path)) {
				return [];
			}
			const verificationEntry = getManifestVerificationEntry(entry);
			return verificationEntry ? [verificationEntry] : [];
		}) ?? []),
	];
	if (entries.length === 0) {
		return undefined;
	}
	const counts = { verified: 0, missing: 0, pending: 0, unverified: 0 };
	for (const entry of entries) {
		counts[entry.state] += 1;
	}
	return {
		artifacts: entries,
		missingCount: counts.missing,
		pendingCount: counts.pending,
		unverifiedCount: counts.unverified,
		verified: counts.verified === entries.length,
		verifiedCount: counts.verified,
	};
}

function isMissingFileArtifact(artifact: FileArtifactMetadata): boolean {
	return (
		!isPendingRecordingArtifact(artifact) &&
		(artifact.exists === false || artifact.status === "missing" || artifact.status === "stale")
	);
}

export function hasMissingFileArtifact(
	artifacts: readonly FileArtifactMetadata[] | undefined,
): boolean {
	return (artifacts ?? []).some(isMissingFileArtifact);
}

export function formatMissingArtifactFailureText(
	artifacts: readonly FileArtifactMetadata[] | undefined,
): string | undefined {
	const failedArtifacts = (artifacts ?? []).filter(isMissingFileArtifact);
	const artifact = failedArtifacts[0];
	if (artifact === undefined) {
		return undefined;
	}
	if (failedArtifacts.length === 1) {
		if (artifact.status === "missing" && artifact.exists === true) {
			return `Artifact verification failed: the reported capture was missing; the existing destination ${artifact.absolutePath} does not prove this capture was saved.`;
		}
		return artifact.status === "stale"
			? `Artifact verification failed: requested ${artifact.kind} path ${artifact.absolutePath} has a modification time outside the current command window.`
			: `Artifact verification failed: requested ${artifact.kind} was not found at ${artifact.absolutePath}.`;
	}
	return `Artifact verification failed: ${failedArtifacts.length} requested artifacts were missing or stale.`;
}

export function classifyPresentationSuccessCategory(options: {
	readonly artifactVerification?:
		| Readonly<Pick<ArtifactVerificationSummary, "missingCount" | "unverifiedCount">>
		| undefined;
	readonly artifacts?: readonly FileArtifactMetadata[] | undefined;
	readonly inspection?: boolean;
	readonly savedFile?: SavedFilePresentationDetails | undefined;
}): AgentBrowserSuccessCategory {
	if (
		(options.artifactVerification?.missingCount ?? 0) > 0 ||
		(options.artifactVerification?.unverifiedCount ?? 0) > 0
	) {
		return "artifact-unverified";
	}
	return classifyAgentBrowserSuccessCategory({ ...options, artifacts: options.artifacts?.slice() });
}
