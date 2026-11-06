import type { CompiledAgentBrowserSemanticAction } from "../../input-modes/types.js";
import type { NetworkRouteRecord } from "../contracts.js";
import type { BuildNestedToolPresentationOptions } from "./batch-contracts.js";

export interface BuildToolPresentationOptions extends BuildNestedToolPresentationOptions {
	readonly textOutput?: boolean;
	readonly stdin?: string | undefined;
	readonly batchArtifactRequests?:
		| readonly BuildNestedToolPresentationOptions["artifactRequest"][]
		| undefined;
	readonly compiledSemanticAction?: CompiledAgentBrowserSemanticAction | undefined;
	readonly networkRoutes?: readonly NetworkRouteRecord[] | undefined;
	readonly recordingPending?: boolean;
	readonly previousRecordingContactSheetPath?: string | undefined;
}
