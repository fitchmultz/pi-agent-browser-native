import type { ToolPresentationObservation } from "../../results/presentation/observation-contracts.js";
import type { ProcessRunResult } from "../../process.js";
import type {
	AgentBrowserEnvelope,
	SessionArtifactManifest,
	ToolPresentation,
} from "../../results/contracts.js";
import type {
	ActiveRecordingReservation,
	RecordingRecovery,
} from "../../results/evidence-contracts.js";

export interface RecordingRecoveryOptions {
	readonly artifactManifest?: SessionArtifactManifest | undefined;
	readonly artifactRunStartedAtMs: number;
	readonly commandTokens: readonly string[];
	readonly cwd: string;
	readonly envelope?: AgentBrowserEnvelope | undefined;
	readonly namespace?: string | undefined;
	readonly parseError?: string | undefined;
	readonly processResult: ProcessRunResult;
	readonly reservation?: ActiveRecordingReservation | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly stdin?: string | undefined;
}

export interface RecordingStopRecoveryResult {
	readonly batch: boolean;
	readonly envelope?: AgentBrowserEnvelope | undefined;
	readonly partialBatch: boolean;
	readonly stopPosition: number;
	readonly presentation: ToolPresentation;
	readonly recovery: RecordingRecovery;
}

export type RecordingStopRecoveryObservation = Omit<RecordingStopRecoveryResult, "presentation"> & {
	readonly presentation: ToolPresentationObservation;
};

export interface RecordingRecoveryPlan {
	readonly batch: boolean;
	readonly rows?: readonly unknown[] | undefined;
	/** Compact dispatched-row position; native input indexes can include skipped empty rows. */
	readonly stopPosition: number;
	readonly expected?: ActiveRecordingReservation | undefined;
	readonly attempt: RecordingRecovery["attempt"];
}
