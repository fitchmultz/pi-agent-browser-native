import type { AgentBrowserNextAction } from "./next-actions.js";

export type { AgentBrowserNextAction } from "./next-actions.js";

export interface AgentBrowserEnvelope {
	data?: unknown;
	error?: unknown;
	success: boolean;
}

export interface AgentBrowserBatchResult {
	command?: string[];
	error?: unknown;
	result?: unknown;
	success?: boolean;
}

export type AgentBrowserResultCategory = "failure" | "success";

export type AgentBrowserSuccessCategory = "artifact-pending" | "artifact-saved" | "artifact-unverified" | "completed" | "inspection";

export type AgentBrowserFailureCategory =
	| "aborted"
	| "artifact-missing"
	| "cleanup-failed"
	| "confirmation-required"
	| "download-not-verified"
	| "missing-binary"
	| "parse-failure"
	| "policy-blocked"
	| "qa-failure"
	| "selector-not-found"
	| "selector-unsupported"
	| "script-error"
	| "stale-ref"
	| "tab-drift"
	| "tab-gone"
	| "timeout"
	| "upstream-error"
	| "validation-error";

export interface AgentBrowserResultCategoryDetails {
	failureCategory?: AgentBrowserFailureCategory;
	resultCategory: AgentBrowserResultCategory;
	successCategory?: AgentBrowserSuccessCategory;
}

export interface AgentBrowserPageChangeSummary {
	artifactCount?: number;
	changeType: "artifact" | "confirmation" | "mutation" | "navigation";
	command?: string;
	nextActionIds?: string[];
	observed: boolean;
	savedFilePath?: string;
	summary: string;
	title?: string;
	url?: string;
}

export type FileArtifactKind = "download" | "file" | "har" | "image" | "pdf" | "profile" | "trace" | "video";

export type FileArtifactStatus = "missing" | "pending" | "repaired-from-temp" | "saved" | "stale" | "upstream-temp-only";

export interface FileArtifactMetadata {
	absolutePath: string;
	artifactType?: FileArtifactKind;
	command?: string;
	cwd?: string;
	exists?: boolean;
	extension?: string;
	kind: FileArtifactKind;
	mediaType?: string;
	namespace?: string;
	path: string;
	recordingState?: "openRecording";
	requestedPath?: string;
	session?: string;
	sizeBytes?: number;
	status?: FileArtifactStatus;
	subcommand?: string;
	tempPath?: string;
	updatedAtMs?: number;
	willExistOnStop?: boolean;
}

export type ArtifactVerificationState = "missing" | "pending" | "unverified" | "verified";

export interface ArtifactVerificationEntry {
	absolutePath?: string;
	exists?: boolean;
	kind: FileArtifactKind | "spill";
	limitation?: string;
	mediaType?: string;
	path: string;
	requestedPath?: string;
	recordingState?: "openRecording";
	retentionState?: ArtifactRetentionState;
	sizeBytes?: number;
	state: ArtifactVerificationState;
	status?: FileArtifactStatus;
	storageScope?: ArtifactStorageScope;
	updatedAtMs?: number;
	willExistOnStop?: boolean;
}

export interface ArtifactVerificationSummary {
	artifacts: ArtifactVerificationEntry[];
	missingCount: number;
	pendingCount: number;
	unverifiedCount: number;
	verified: boolean;
	verifiedCount: number;
}

export interface SavedFilePresentationDetails {
	command: "download" | "pdf" | "wait";
	kind: "download" | "pdf";
	metadata?: Record<string, unknown>;
	path: string;
	subcommand?: string;
}

export type ArtifactRetentionState = "evicted" | "ephemeral" | "live" | "missing";

export type ArtifactStorageScope = "explicit-path" | "persistent-session" | "process-temp";

export interface SessionArtifactManifestEntry {
	absolutePath?: string;
	command?: string;
	createdAtMs: number;
	cwd?: string;
	evictedAtMs?: number;
	exists?: boolean;
	extension?: string;
	kind: FileArtifactKind | "spill";
	mediaType?: string;
	namespace?: string;
	path: string;
	requestedPath?: string;
	retentionState: ArtifactRetentionState;
	session?: string;
	sizeBytes?: number;
	storageScope: ArtifactStorageScope;
	subcommand?: string;
}

export interface SessionArtifactManifest {
	entries: SessionArtifactManifestEntry[];
	evictedCount: number;
	liveCount: number;
	maxEntries: number;
	updatedAtMs: number;
	version: 1;
}

export interface BatchStepPresentationDetails {
	artifactVerification?: ArtifactVerificationSummary;
	artifacts?: FileArtifactMetadata[];
	command?: string[];
	commandText: string;
	data?: unknown;
	failureCategory?: AgentBrowserFailureCategory;
	fullOutputPath?: string;
	fullOutputPaths?: string[];
	imagePath?: string;
	imagePaths?: string[];
	index: number;
	lifecycle?: { effectiveLaunch: { browserLaunched: boolean } };
	networkRouteDiagnostics?: NetworkRouteDiagnostic[];
	nextActions?: AgentBrowserNextAction[];
	pageChangeSummary?: AgentBrowserPageChangeSummary;
	resultCategory: AgentBrowserResultCategory;
	savedFile?: SavedFilePresentationDetails;
	savedFilePath?: string;
	success: boolean;
	successCategory?: AgentBrowserSuccessCategory;
	summary: string;
	text: string;
}

export interface BatchFailurePresentationDetails {
	failedStep: BatchStepPresentationDetails;
	failureCount: number;
	successCount: number;
	totalCount: number;
}

export interface ToolPresentation {
	artifactManifest?: SessionArtifactManifest;
	artifactRetentionSummary?: string;
	artifactVerification?: ArtifactVerificationSummary;
	artifacts?: FileArtifactMetadata[];
	batchFailure?: BatchFailurePresentationDetails;
	batchSteps?: BatchStepPresentationDetails[];
	content: Array<{ text: string; type: "text" } | { data: string; mimeType: string; type: "image" }>;
	data?: unknown;
	failureCategory?: AgentBrowserFailureCategory;
	fullOutputPath?: string;
	fullOutputPaths?: string[];
	imagePath?: string;
	imagePaths?: string[];
	networkRouteDiagnostics?: NetworkRouteDiagnostic[];
	nextActions?: AgentBrowserNextAction[];
	pageChangeSummary?: AgentBrowserPageChangeSummary;
	resultCategory?: AgentBrowserResultCategory;
	savedFile?: SavedFilePresentationDetails;
	savedFilePath?: string;
	successCategory?: AgentBrowserSuccessCategory;
	summary: string;
}

export type NetworkFailureImpact = "actionable" | "benign";

export interface NetworkFailureClassification {
	impact: NetworkFailureImpact;
	reason: string;
	resourceType?: string;
	status?: number;
	url?: string;
}

export interface NetworkFailureSummary {
	actionableCount: number;
	benignCount: number;
	failures: NetworkFailureClassification[];
	totalCount: number;
}

export interface NetworkRouteRecord {
	mode: "abort" | "body" | "handler" | "unknown";
	pattern: string;
}

export interface NetworkRouteDiagnostic {
	mode: NetworkRouteRecord["mode"];
	reason: "pending-routed-request" | "cors-likely-routed-request" | "unfulfilled-routed-request";
	requestId?: string;
	requestUrl?: string;
	routePattern: string;
	summary: string;
}
