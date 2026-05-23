import { validateToolArgs, redactInvocationArgs, redactSensitiveText } from "../runtime.js";
import { buildAgentBrowserResultCategoryDetails } from "../results/categories.js";
import {
	compileAgentBrowserElectron,
	compileAgentBrowserJob,
	compileAgentBrowserNetworkSourceLookup,
	compileAgentBrowserQaPreset,
	compileAgentBrowserSemanticAction,
	compileAgentBrowserSourceLookup,
	redactNetworkSourceLookupArgs,
	redactNetworkSourceLookupUrl,
	type CompiledAgentBrowserElectron,
	type CompiledAgentBrowserJob,
	type CompiledAgentBrowserNetworkSourceLookup,
	type CompiledAgentBrowserQaPreset,
	type CompiledAgentBrowserSemanticAction,
	type CompiledAgentBrowserSourceLookup,
} from "../input-modes.js";

export interface AgentBrowserExecuteParams {
	args?: string[];
	electron?: unknown;
	job?: unknown;
	networkSourceLookup?: unknown;
	qa?: unknown;
	semanticAction?: unknown;
	sessionMode?: "auto" | "fresh";
	sourceLookup?: unknown;
	stdin?: string;
}

export interface ResolvedAgentBrowserInput {
	compiledElectron?: CompiledAgentBrowserElectron;
	compiledGeneratedBatch?: CompiledAgentBrowserJob | CompiledAgentBrowserNetworkSourceLookup | CompiledAgentBrowserSourceLookup;
	compiledJob?: CompiledAgentBrowserJob;
	compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	compiledQaPreset?: CompiledAgentBrowserQaPreset;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	compiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	redactedArgs: string[];
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	redactedCompiledJob?: CompiledAgentBrowserJob;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	toolArgs: string[];
	toolStdin?: string;
	validationError?: string;
}

function redactCompiledElectron(compiled: CompiledAgentBrowserElectron | undefined): CompiledAgentBrowserElectron | undefined {
	if (!compiled) return undefined;
	if (compiled.action === "list") {
		return { ...compiled, query: compiled.query ? redactSensitiveText(compiled.query) : undefined };
	}
	if (compiled.action === "launch") {
		return { ...compiled, appArgs: compiled.appArgs ? redactInvocationArgs(compiled.appArgs) : undefined };
	}
	return { ...compiled };
}

function redactCompiledJob(compiled: CompiledAgentBrowserJob | undefined): CompiledAgentBrowserJob | undefined {
	const redactedSteps = compiled?.steps.map((step) => ({ ...step, args: redactInvocationArgs(step.args) }));
	return compiled && redactedSteps
		? { ...compiled, stdin: JSON.stringify(redactedSteps.map((step) => step.args)), steps: redactedSteps }
		: undefined;
}

function redactCompiledSourceLookup(compiled: CompiledAgentBrowserSourceLookup | undefined): CompiledAgentBrowserSourceLookup | undefined {
	const redactedSteps = compiled?.steps.map((step) => ({ ...step, args: redactInvocationArgs(step.args) }));
	return compiled && redactedSteps
		? { ...compiled, stdin: JSON.stringify(redactedSteps.map((step) => step.args)), steps: redactedSteps }
		: undefined;
}

function redactCompiledNetworkSourceLookup(compiled: CompiledAgentBrowserNetworkSourceLookup | undefined): CompiledAgentBrowserNetworkSourceLookup | undefined {
	const redactedSteps = compiled?.steps.map((step) => ({ ...step, args: redactNetworkSourceLookupArgs(step.args) }));
	return compiled && redactedSteps
		? {
			...compiled,
			args: redactNetworkSourceLookupArgs(compiled.args),
			query: {
				...compiled.query,
				filter: redactNetworkSourceLookupUrl(compiled.query.filter),
				url: redactNetworkSourceLookupUrl(compiled.query.url),
			},
			stdin: JSON.stringify(redactedSteps.map((step) => step.args)),
			steps: redactedSteps,
		}
		: undefined;
}

export function resolveAgentBrowserInput(options: {
	getBatchAnnotateValidationError: (args: string[], stdin: string | undefined) => string | undefined;
	managedSessionActive: boolean;
	params: AgentBrowserExecuteParams;
}): ResolvedAgentBrowserInput {
	const { getBatchAnnotateValidationError, managedSessionActive, params } = options;
	const semanticActionResult = params.semanticAction === undefined ? {} : compileAgentBrowserSemanticAction(params.semanticAction);
	const jobResult = params.job === undefined ? {} : compileAgentBrowserJob(params.job);
	const qaResult = params.qa === undefined ? {} : compileAgentBrowserQaPreset(params.qa);
	const sourceLookupResult = params.sourceLookup === undefined ? {} : compileAgentBrowserSourceLookup(params.sourceLookup);
	const networkSourceLookupResult = params.networkSourceLookup === undefined ? {} : compileAgentBrowserNetworkSourceLookup(params.networkSourceLookup);
	const electronResult = params.electron === undefined ? {} : compileAgentBrowserElectron(params.electron);

	const hasExplicitArgs = Array.isArray(params.args);
	const explicitInputModes = [
		hasExplicitArgs,
		Boolean(semanticActionResult.compiled),
		Boolean(jobResult.compiled),
		Boolean(qaResult.compiled),
		Boolean(sourceLookupResult.compiled),
		Boolean(networkSourceLookupResult.compiled),
		Boolean(electronResult.compiled),
	].filter(Boolean).length;
	const inputModeError = explicitInputModes !== 1
		? "Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron."
		: undefined;

	const compiledSemanticAction = semanticActionResult.compiled;
	const compiledQaPreset = qaResult.compiled;
	const compiledSourceLookup = sourceLookupResult.compiled;
	const compiledNetworkSourceLookup = networkSourceLookupResult.compiled;
	const compiledElectron = electronResult.compiled;
	const compiledJob = jobResult.compiled ?? compiledQaPreset;
	const compiledGeneratedBatch = compiledNetworkSourceLookup ?? compiledSourceLookup ?? compiledJob;
	const toolArgs = compiledElectron ? [] : compiledSemanticAction?.args ?? compiledGeneratedBatch?.args ?? params.args ?? [];
	const toolStdin = compiledGeneratedBatch?.stdin ?? params.stdin;
	const redactedArgs = redactInvocationArgs(toolArgs);
	const generatedStdinError = params.stdin !== undefined
		? compiledGeneratedBatch
			? "Do not provide stdin with job, qa, sourceLookup, or networkSourceLookup; those modes generate their own batch stdin."
			: compiledElectron
				? "Do not provide stdin with electron; electron mode is host-only or manages its own input."
				: undefined
		: undefined;
	const attachedQaSessionError = compiledQaPreset?.checks.attached
		? params.sessionMode === "fresh"
			? "qa.attached cannot be used with sessionMode=fresh; attach or launch a session first, then run qa.attached with the current session."
			: !managedSessionActive
				? "qa.attached requires an active attached session. Run electron.launch or connect to an Electron debug port first."
				: undefined
		: undefined;
	const validationError = semanticActionResult.error
		?? jobResult.error
		?? qaResult.error
		?? sourceLookupResult.error
		?? networkSourceLookupResult.error
		?? electronResult.error
		?? inputModeError
		?? generatedStdinError
		?? attachedQaSessionError
		?? (compiledElectron ? undefined : validateToolArgs(toolArgs) ?? getBatchAnnotateValidationError(toolArgs, toolStdin));
	const redactedCompiledJob = redactCompiledJob(compiledJob);
	const redactedCompiledSemanticAction = compiledSemanticAction
		? { ...compiledSemanticAction, args: redactInvocationArgs(compiledSemanticAction.args) }
		: undefined;

	return {
		compiledElectron,
		compiledGeneratedBatch,
		compiledJob,
		compiledNetworkSourceLookup,
		compiledQaPreset,
		compiledSemanticAction,
		compiledSourceLookup,
		redactedArgs,
		redactedCompiledElectron: redactCompiledElectron(compiledElectron),
		redactedCompiledJob,
		redactedCompiledNetworkSourceLookup: redactCompiledNetworkSourceLookup(compiledNetworkSourceLookup),
		redactedCompiledQaPreset: compiledQaPreset && redactedCompiledJob ? { ...redactedCompiledJob, checks: compiledQaPreset.checks } : undefined,
		redactedCompiledSemanticAction,
		redactedCompiledSourceLookup: redactCompiledSourceLookup(compiledSourceLookup),
		toolArgs,
		toolStdin,
		validationError,
	};
}

export function buildValidationFailureResult(input: ResolvedAgentBrowserInput): {
	content: Array<{ text: string; type: "text" }>;
	details: Record<string, unknown>;
	isError: true;
} {
	const validationError = input.validationError ?? "Invalid agent_browser input.";
	return {
		content: [{ type: "text", text: validationError }],
		details: {
			args: input.redactedArgs,
			compiledElectron: input.redactedCompiledElectron,
			compiledJob: input.redactedCompiledJob,
			compiledQaPreset: input.redactedCompiledQaPreset,
			compiledSourceLookup: input.redactedCompiledSourceLookup,
			compiledNetworkSourceLookup: input.redactedCompiledNetworkSourceLookup,
			compiledSemanticAction: input.redactedCompiledSemanticAction,
			...buildAgentBrowserResultCategoryDetails({
				args: input.redactedArgs,
				errorText: validationError,
				succeeded: false,
				validationError,
			}),
			validationError,
		},
		isError: true,
	};
}
