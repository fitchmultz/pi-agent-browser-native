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
	readonly artifactManifest?: SessionArtifactManifest | undefined;
	readonly artifactMaxUpdatedAtMs?: number | undefined;
	readonly artifactMinUpdatedAtMs?: number | undefined;
	readonly artifactRequest?: ArtifactRequestContext | undefined;
	readonly args?: readonly string[] | undefined;
	readonly commandInfo: CommandInfo;
	readonly cwd: string;
	readonly envelope?: AgentBrowserEnvelope | undefined;
	readonly errorText?: string | undefined;
	readonly piCleanupOwnership?: "caller-owned" | "wrapper-managed" | undefined;
	readonly networkRouteDiagnostics?: readonly NetworkRouteDiagnostic[] | undefined;
	readonly namespace?: string | undefined;
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore> | undefined;
	readonly sessionName?: string | undefined;
}

export type BuildNestedToolPresentation = (
	options: BuildNestedToolPresentationOptions,
) => Promise<ToolPresentation>;

export interface BatchPresentedStep {
	readonly details: BatchStepPresentationDetails;
	readonly nativeIndex?: number | undefined;
	readonly presentation: ToolPresentation;
}

export interface BuildBatchStepOptions {
	readonly artifactManifest?: SessionArtifactManifest | undefined;
	readonly artifactMaxUpdatedAtMs?: number | undefined;
	readonly artifactMinUpdatedAtMs?: number | undefined;
	readonly artifactRequest?: ArtifactRequestContext | undefined;
	readonly buildNestedToolPresentation: BuildNestedToolPresentation;
	readonly cwd: string;
	readonly index: number;
	readonly item: AgentBrowserBatchResult;
	readonly piCleanupOwnership?: "caller-owned" | "wrapper-managed" | undefined;
	readonly namespace?: string | undefined;
	readonly networkRoutes?: readonly NetworkRouteRecord[] | undefined;
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore> | undefined;
	readonly sessionName?: string | undefined;
}

export interface BuildBatchPresentationOptions {
	readonly artifactManifest?: SessionArtifactManifest | undefined;
	readonly artifactMaxUpdatedAtMs?: number | undefined;
	readonly artifactMinUpdatedAtMs?: number | undefined;
	readonly artifactRequests?: readonly (ArtifactRequestContext | undefined)[] | undefined;
	readonly buildNestedToolPresentation: BuildNestedToolPresentation;
	readonly cwd: string;
	readonly data: readonly AgentBrowserBatchResult[];
	readonly piCleanupOwnership?: "caller-owned" | "wrapper-managed" | undefined;
	readonly namespace?: string | undefined;
	readonly networkRoutes?: readonly NetworkRouteRecord[] | undefined;
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore> | undefined;
	readonly sessionName?: string | undefined;
	readonly summary: string;
}
