import type { CommandInfo } from "../../argv-descriptor.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import type { ArtifactRequestContext } from "../artifact-contracts.js";
import type {
	AgentBrowserBatchResult,
	AgentBrowserEnvelope,
	BatchStepPresentationDetails,
	NetworkRouteDiagnostic,
	NetworkRouteRecord,
	SessionArtifactManifest,
	ToolPresentation,
} from "../contracts.js";

export interface BuildNestedToolPresentationOptions {
	readonly modelVisible?: boolean;
	readonly artifactManifest?: SessionArtifactManifest;
	readonly artifactMaxUpdatedAtMs?: number;
	readonly artifactMinUpdatedAtMs?: number;
	readonly artifactRequest?: ArtifactRequestContext;
	readonly args?: readonly string[];
	readonly commandInfo: CommandInfo;
	readonly cwd: string;
	readonly envelope?: AgentBrowserEnvelope;
	readonly errorText?: string;
	readonly piCleanupOwnership?: "caller-owned" | "wrapper-managed";
	readonly networkRouteDiagnostics?: readonly NetworkRouteDiagnostic[];
	readonly namespace?: string;
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore>;
	readonly sessionName?: string;
}

export type BuildNestedToolPresentation = (
	options: BuildNestedToolPresentationOptions,
) => Promise<ToolPresentation>;

export interface BatchPresentedStep {
	readonly details: BatchStepPresentationDetails;
	readonly nativeIndex?: number;
	readonly presentation: ToolPresentation;
}

export interface BuildBatchStepOptions {
	readonly modelVisible?: boolean;
	readonly artifactManifest?: SessionArtifactManifest;
	readonly artifactMaxUpdatedAtMs?: number;
	readonly artifactMinUpdatedAtMs?: number;
	readonly artifactRequest?: ArtifactRequestContext;
	readonly buildNestedToolPresentation: BuildNestedToolPresentation;
	readonly cwd: string;
	readonly index: number;
	readonly item: AgentBrowserBatchResult;
	readonly piCleanupOwnership?: "caller-owned" | "wrapper-managed";
	readonly namespace?: string;
	readonly networkRoutes?: readonly NetworkRouteRecord[];
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore>;
	readonly sessionName?: string;
}

export interface BuildBatchPresentationOptions {
	readonly modelVisible?: boolean;
	readonly artifactManifest?: SessionArtifactManifest;
	readonly artifactMaxUpdatedAtMs?: number;
	readonly artifactMinUpdatedAtMs?: number;
	readonly artifactRequests?: readonly (ArtifactRequestContext | undefined)[];
	readonly buildNestedToolPresentation: BuildNestedToolPresentation;
	readonly cwd: string;
	readonly data: readonly AgentBrowserBatchResult[];
	readonly piCleanupOwnership?: "caller-owned" | "wrapper-managed";
	readonly namespace?: string;
	readonly networkRoutes?: readonly NetworkRouteRecord[];
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore>;
	readonly sessionName?: string;
	readonly summary: string;
}
