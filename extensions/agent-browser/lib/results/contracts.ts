import type { AgentBrowserNextAction } from "./action-contracts.js";
import type { ReadConfirmation, RecordingRecovery } from "./evidence-contracts.js";
import type {
	ArtifactVerificationSummary,
	FileArtifactMetadata,
	SavedFilePresentationDetails,
	SessionArtifactManifest,
} from "./artifact-contracts.js";
export type {
	ArtifactRetentionState,
	ArtifactStorageScope,
	ArtifactVerificationEntry,
	ArtifactVerificationState,
	ArtifactVerificationSummary,
	ArtifactRequestContext,
	FileArtifactKind,
	FileArtifactStatus,
	FileArtifactMetadata,
	SavedFilePresentationDetails,
	SessionArtifactManifestEntry,
	SessionArtifactManifest,
} from "./artifact-contracts.js";

export type { AgentBrowserNextAction } from "./action-contracts.js";

export interface AgentBrowserEnvelope {
	readonly data?: unknown;
	readonly error?: unknown;
	readonly success: boolean;
}

export interface AgentBrowserBatchResult {
	readonly command?: readonly string[] | undefined;
	readonly index?: number;
	readonly error?: unknown;
	readonly result?: unknown;
	readonly success?: boolean;
}

export type AgentBrowserResultCategory = "failure" | "success";

export type AgentBrowserSuccessCategory =
	| "artifact-pending"
	| "artifact-saved"
	| "artifact-unverified"
	| "completed"
	| "inspection";

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
	readonly failureCategory?: AgentBrowserFailureCategory;
	readonly resultCategory: AgentBrowserResultCategory;
	readonly successCategory?: AgentBrowserSuccessCategory;
}

// Unknown detail projection guarantees only the wrapper-owned outcome fields.
// Producer observations retain their richer contract below.
export interface ProjectedAgentBrowserObservation {
	readonly [key: string]: unknown;
	readonly success: boolean;
	readonly resultCategory: AgentBrowserResultCategory;
}

export interface AgentBrowserObservation extends AgentBrowserResultCategoryDetails {
	[key: string]: unknown;
	success: boolean;
	data?: unknown;
	error?: unknown;
	summary?: string;
	sessionName?: string;
	namespace?: string;
	failures?: AgentBrowserObservation[];
	nextActions?: readonly AgentBrowserNextAction[];
	artifacts?: readonly FileArtifactMetadata[];
	artifactVerification?: ArtifactVerificationSummary;
	imageObservations?: readonly ImageObservation[];
	batchSteps?: Array<AgentBrowserObservation & { index: number; command?: string[] }>;
}

export interface AgentBrowserPageChangeSummary {
	artifactCount?: number;
	changeType: "artifact" | "confirmation" | "mutation" | "navigation";
	command?: string;
	nextActionIds?: readonly string[] | undefined;
	observed: boolean;
	savedFilePath?: string;
	summary: string;
	title?: string;
	url?: string;
}

export interface AgentBrowserLifecycle {
	readonly effectiveLaunch: { readonly browserLaunched: boolean };
}

export interface AgentBrowserWindow {
	mode: "headed";
	ownership: "wrapper-managed";
	sessionName: string;
	visibility: "unverified";
}

export interface ScreenshotSample {
	readonly rendering?: "text" | undefined;
	readonly url: string;
	readonly frame: "main" | "child";
	readonly childFrameCount: number;
	readonly viewport: { readonly width: number; readonly height: number };
	readonly document: { readonly width: number; readonly height: number };
	readonly scroll: { readonly x: number; readonly y: number };
	readonly dpr: number;
	readonly visualViewport: { readonly x: number; readonly y: number; readonly scale: number };
	readonly element?:
		| {
				readonly x: number;
				readonly y: number;
				readonly width: number;
				readonly height: number;
		  }
		| undefined;
}

export interface ImageObservation {
	readonly rendering?: "text" | undefined;
	readonly id?: string;
	readonly path: string;
	readonly mimeType: string;
	readonly pixels?: { readonly width: number; readonly height: number } | undefined;
	readonly capture: "viewport" | "full-page" | "element" | "unknown";
	readonly geometry: {
		readonly status: "measured" | "unknown";
		readonly reason: string;
		readonly before?: ScreenshotSample | undefined;
		readonly after?: ScreenshotSample | undefined;
		/** CSS document coordinates of the captured rectangle, not mouse coordinates. */
		readonly crop?:
			| {
					readonly x: number;
					readonly y: number;
					readonly width: number;
					readonly height: number;
			  }
			| undefined;
		readonly pixelsPerCssPixel?: { readonly x: number; readonly y: number } | undefined;
	};
}

export interface BatchStepPresentationDetails {
	artifactVerification?: ArtifactVerificationSummary | undefined;
	artifacts?: readonly FileArtifactMetadata[] | undefined;
	command?: readonly string[] | undefined;
	commandText: string;
	data?: unknown;
	failureCategory?: AgentBrowserFailureCategory | undefined;
	fullOutputPath?: string | undefined;
	fullOutputPaths?: readonly string[] | undefined;
	imagePath?: string | undefined;
	imagePaths?: readonly string[] | undefined;
	imageObservations?: readonly ImageObservation[] | undefined;
	index: number;
	lifecycle?: AgentBrowserLifecycle | undefined;
	networkRouteDiagnostics?: readonly NetworkRouteDiagnostic[] | undefined;
	nextActions?: readonly AgentBrowserNextAction[] | undefined;
	pageChangeSummary?: AgentBrowserPageChangeSummary | undefined;
	resultCategory: AgentBrowserResultCategory;
	savedFile?: SavedFilePresentationDetails | undefined;
	savedFilePath?: string | undefined;
	success: boolean;
	successCategory?: AgentBrowserSuccessCategory | undefined;
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
	readConfirmation?: ReadConfirmation;
	recordingRecovery?: RecordingRecovery;
	artifactManifest?: SessionArtifactManifest | undefined;
	artifactRetentionSummary?: string | undefined;
	artifactVerification?: ArtifactVerificationSummary | undefined;
	artifacts?: readonly FileArtifactMetadata[] | undefined;
	batchFailure?: BatchFailurePresentationDetails | undefined;
	batchSteps?: readonly BatchStepPresentationDetails[] | undefined;
	content: Array<
		{ text: string; type: "text" } | { data: string; mimeType: string; type: "image" }
	>;
	data?: unknown;
	failureCategory?: AgentBrowserFailureCategory | undefined;
	fullOutputPath?: string | undefined;
	fullOutputPaths?: readonly string[] | undefined;
	imagePath?: string | undefined;
	imagePaths?: readonly string[] | undefined;
	imageObservations?: readonly ImageObservation[];
	networkRouteDiagnostics?: readonly NetworkRouteDiagnostic[];
	nextActions?: readonly AgentBrowserNextAction[] | undefined;
	pageChangeSummary?: AgentBrowserPageChangeSummary | undefined;
	resultCategory?: AgentBrowserResultCategory;
	savedFile?: SavedFilePresentationDetails | undefined;
	savedFilePath?: string | undefined;
	successCategory?: AgentBrowserSuccessCategory | undefined;
	summary: string;
}

export type NetworkFailureImpact = "actionable" | "benign";

export interface NetworkFailureClassification {
	impact: NetworkFailureImpact;
	reason: string;
	resourceType?: string | undefined;
	status?: number | undefined;
	url?: string | undefined;
}

export interface NetworkFailureSummary {
	actionableCount: number;
	benignCount: number;
	failures: NetworkFailureClassification[];
	totalCount: number;
}

export interface NetworkRouteRecord {
	readonly mode: "abort" | "body" | "handler" | "unknown";
	readonly pattern: string;
}

export interface NetworkRouteDiagnostic {
	readonly mode: NetworkRouteRecord["mode"];
	readonly reason:
		| "pending-routed-request"
		| "cors-likely-routed-request"
		| "unfulfilled-routed-request";
	readonly requestId?: string;
	readonly requestUrl?: string;
	readonly routePattern: string;
	readonly summary: string;
}
