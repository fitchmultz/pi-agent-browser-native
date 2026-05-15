/**
 * Purpose: Provide the public result-rendering facade for the pi-agent-browser extension.
 * Responsibilities: Re-export focused envelope parsing, snapshot rendering, and presentation helpers from smaller modules while preserving the stable import surface used by the extension entrypoint and tests.
 * Scope: Facade only; implementation details live in `lib/results/*` modules.
 * Usage: Imported by the extension entrypoint after upstream `agent-browser` execution completes.
 * Invariants/Assumptions: Public exports remain stable even as result-rendering internals are split into narrower modules.
 */

export { getAgentBrowserErrorText, parseAgentBrowserEnvelope } from "./results/envelope.js";
export { buildToolPresentation } from "./results/presentation.js";
export {
	buildAgentBrowserNextActions,
	buildAgentBrowserResultCategoryDetails,
	classifyAgentBrowserFailureCategory,
	classifyAgentBrowserSuccessCategory,
	compareRefIds,
} from "./results/shared.js";
export type {
	AgentBrowserBatchResult,
	AgentBrowserEnvelope,
	AgentBrowserFailureCategory,
	AgentBrowserResultCategory,
	AgentBrowserNextAction,
	AgentBrowserPageChangeSummary,
	AgentBrowserResultCategoryDetails,
	AgentBrowserSuccessCategory,
	FileArtifactKind,
	FileArtifactMetadata,
	ToolPresentation,
} from "./results/shared.js";
