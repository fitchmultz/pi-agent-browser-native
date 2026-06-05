/**
 * Purpose: Re-export focused input-mode schema, compiler, and analysis modules for the agent_browser wrapper.
 * Responsibilities: Preserve the extension entrypoint's import surface while keeping input-mode code split by concern.
 * Scope: Barrel only; add behavior to focused files under ./input-modes/.
 */

export { AGENT_BROWSER_PARAMS } from "./input-modes/params.js";
export {
	analyzeQaPresetResults,
	analyzeQaPresetTimeout,
	buildQaCompactPassText,
	compileAgentBrowserJob,
	compileAgentBrowserQaPreset,
	extractQaPageContext,
	isHttpOrHttpsUrl,
} from "./input-modes/job.js";
export {
	analyzeNetworkSourceLookupResults,
	analyzeSourceLookupResults,
	compileAgentBrowserNetworkSourceLookup,
	compileAgentBrowserSourceLookup,
	redactNetworkSourceLookupAnalysis,
	redactNetworkSourceLookupArgs,
	redactNetworkSourceLookupSurface,
	redactNetworkSourceLookupUrl,
} from "./input-modes/lookups.js";
export { compileAgentBrowserElectron } from "./input-modes/electron.js";
export {
	compileAgentBrowserSemanticAction,
	getCompiledSemanticActionCommandIndex,
	getCompiledSemanticActionSessionPrefix,
	isCompiledSemanticActionFindCommand,
} from "./input-modes/semantic-action.js";
export type {
	AgentBrowserNetworkSourceLookupAnalysis,
	AgentBrowserQaPresetAnalysis,
	AgentBrowserSourceLookupAnalysis,
	AgentBrowserSourceLookupElectronContext,
	CompiledAgentBrowserElectron,
	CompiledAgentBrowserJob,
	CompiledAgentBrowserNetworkSourceLookup,
	CompiledAgentBrowserQaPreset,
	CompiledAgentBrowserSemanticAction,
	CompiledAgentBrowserSourceLookup,
} from "./input-modes/types.js";
