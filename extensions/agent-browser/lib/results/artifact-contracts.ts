import type { RecordingReceipt } from "./evidence-contracts.js";

export type FileArtifactKind =
	| "download"
	| "file"
	| "har"
	| "image"
	| "pdf"
	| "profile"
	| "trace"
	| "video";
export type FileArtifactStatus =
	| "failed"
	| "missing"
	| "pending"
	| "repaired-from-temp"
	| "saved"
	| "stale"
	| "unverified"
	| "upstream-temp-only";
export type ArtifactRetentionState = "evicted" | "ephemeral" | "live" | "missing";
export type ArtifactStorageScope = "explicit-path" | "persistent-session" | "process-temp";
export type ArtifactVerificationState = "missing" | "pending" | "unverified" | "verified";
/** Opaque digest of a complete private artifact row key; only manifest validation creates it. */
export type ArtifactReceiptKey = string & { readonly __artifactReceiptKey: unique symbol };

export interface ArtifactRequestContext {
	readonly absolutePath: string;
	readonly path: string;
	readonly status?: FileArtifactStatus | undefined;
	readonly tempPath?: string | undefined;
}

export interface FileArtifactMetadata {
	readonly absolutePath: string;
	readonly artifactType?: FileArtifactKind;
	readonly command?: string | undefined;
	readonly cwd?: string;
	readonly exists?: boolean | undefined;
	readonly extension?: string | undefined;
	readonly kind: FileArtifactKind;
	readonly mediaType?: string | undefined;
	readonly namespace?: string | undefined;
	readonly path: string;
	readonly recording?: RecordingReceipt | undefined;
	readonly recordingStartedAtMs?: number | undefined;
	readonly recordingState?: "openRecording" | undefined;
	readonly requestedPath?: string | undefined;
	readonly session?: string | undefined;
	readonly sizeBytes?: number | undefined;
	readonly status?: FileArtifactStatus | undefined;
	readonly subcommand?: string | undefined;
	readonly tempPath?: string | undefined;
	readonly updatedAtMs?: number | undefined;
	readonly willExistOnStop?: boolean | undefined;
}

export interface ArtifactVerificationEntry {
	readonly absolutePath?: string | undefined;
	readonly exists?: boolean | undefined;
	readonly kind: FileArtifactKind | "spill";
	readonly limitation?: string | undefined;
	readonly mediaType?: string | undefined;
	readonly path: string;
	readonly requestedPath?: string | undefined;
	readonly recording?: RecordingReceipt | undefined;
	readonly recordingStartedAtMs?: number | undefined;
	readonly recordingState?: "openRecording";
	readonly retentionState?: ArtifactRetentionState | undefined;
	readonly sizeBytes?: number | undefined;
	readonly state: ArtifactVerificationState;
	readonly status?: FileArtifactStatus | undefined;
	readonly storageScope?: ArtifactStorageScope | undefined;
	readonly updatedAtMs?: number | undefined;
	readonly willExistOnStop?: boolean | undefined;
}

export interface ArtifactVerificationSummary {
	readonly artifacts: readonly ArtifactVerificationEntry[];
	readonly missingCount: number;
	readonly pendingCount: number;
	readonly unverifiedCount: number;
	readonly verified: boolean;
	readonly verifiedCount: number;
}

export interface SavedFilePresentationDetails {
	readonly command: "download" | "pdf" | "wait";
	readonly kind: "download" | "pdf";
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly path: string;
	readonly subcommand?: string;
}

export interface SessionArtifactManifestEntry {
	readonly absolutePath?: string;
	readonly recording?: RecordingReceipt | undefined;
	readonly recordingStartedAtMs?: number | undefined;
	readonly recordingState?: "openRecording" | undefined;
	readonly status?: FileArtifactStatus | undefined;
	readonly command?: string | undefined;
	readonly createdAtMs: number;
	readonly cwd?: string | undefined;
	readonly evictedAtMs?: number | undefined;
	readonly exists?: boolean | undefined;
	readonly extension?: string | undefined;
	readonly kind: FileArtifactKind | "spill";
	readonly mediaType?: string | undefined;
	readonly namespace?: string | undefined;
	readonly path: string;
	readonly receiptKey?: ArtifactReceiptKey;
	readonly requestedPath?: string | undefined;
	readonly retentionState: ArtifactRetentionState;
	readonly session?: string | undefined;
	readonly sizeBytes?: number | undefined;
	readonly storageScope: ArtifactStorageScope;
	readonly subcommand?: string | undefined;
}

export interface SessionArtifactManifest {
	readonly entries: readonly SessionArtifactManifestEntry[];
	readonly evictedCount: number;
	readonly liveCount: number;
	readonly maxEntries: number;
	readonly updatedAtMs: number;
	readonly version: 1;
}
