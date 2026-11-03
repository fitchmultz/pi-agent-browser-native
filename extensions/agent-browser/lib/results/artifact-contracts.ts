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
	readonly status?: FileArtifactStatus;
	readonly tempPath?: string;
}

export interface FileArtifactMetadata {
	readonly absolutePath: string;
	readonly artifactType?: FileArtifactKind;
	readonly command?: string;
	readonly cwd?: string;
	readonly exists?: boolean;
	readonly extension?: string;
	readonly kind: FileArtifactKind;
	readonly mediaType?: string;
	readonly namespace?: string;
	readonly path: string;
	readonly recording?: RecordingReceipt;
	readonly recordingStartedAtMs?: number;
	readonly recordingState?: "openRecording";
	readonly requestedPath?: string;
	readonly session?: string;
	readonly sizeBytes?: number;
	readonly status?: FileArtifactStatus;
	readonly subcommand?: string;
	readonly tempPath?: string;
	readonly updatedAtMs?: number;
	readonly willExistOnStop?: boolean;
}

export interface ArtifactVerificationEntry {
	readonly absolutePath?: string;
	readonly exists?: boolean;
	readonly kind: FileArtifactKind | "spill";
	readonly limitation?: string;
	readonly mediaType?: string;
	readonly path: string;
	readonly requestedPath?: string;
	readonly recording?: RecordingReceipt;
	readonly recordingStartedAtMs?: number;
	readonly recordingState?: "openRecording";
	readonly retentionState?: ArtifactRetentionState;
	readonly sizeBytes?: number;
	readonly state: ArtifactVerificationState;
	readonly status?: FileArtifactStatus;
	readonly storageScope?: ArtifactStorageScope;
	readonly updatedAtMs?: number;
	readonly willExistOnStop?: boolean;
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
	readonly recording?: RecordingReceipt;
	readonly recordingStartedAtMs?: number;
	readonly recordingState?: "openRecording";
	readonly status?: FileArtifactStatus;
	readonly command?: string;
	readonly createdAtMs: number;
	readonly cwd?: string;
	readonly evictedAtMs?: number;
	readonly exists?: boolean;
	readonly extension?: string;
	readonly kind: FileArtifactKind | "spill";
	readonly mediaType?: string;
	readonly namespace?: string;
	readonly path: string;
	readonly receiptKey?: ArtifactReceiptKey;
	readonly requestedPath?: string;
	readonly retentionState: ArtifactRetentionState;
	readonly session?: string;
	readonly sizeBytes?: number;
	readonly storageScope: ArtifactStorageScope;
	readonly subcommand?: string;
}

export interface SessionArtifactManifest {
	readonly entries: readonly SessionArtifactManifestEntry[];
	readonly evictedCount: number;
	readonly liveCount: number;
	readonly maxEntries: number;
	readonly updatedAtMs: number;
	readonly version: 1;
}
