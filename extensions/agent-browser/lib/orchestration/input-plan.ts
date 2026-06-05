import { parseArgvDescriptor } from "../argv-descriptor.js";
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

export type ResolvedAgentBrowserInputKind = "args" | "electron" | "job" | "networkSourceLookup" | "qa" | "semanticAction" | "sourceLookup";

type ResolvedAgentBrowserInputModeFields = {
	compiledElectron?: CompiledAgentBrowserElectron;
	compiledGeneratedBatch?: CompiledAgentBrowserJob | CompiledAgentBrowserNetworkSourceLookup | CompiledAgentBrowserSourceLookup;
	compiledJob?: CompiledAgentBrowserJob;
	compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	compiledQaPreset?: CompiledAgentBrowserQaPreset;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	compiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	redactedCompiledJob?: CompiledAgentBrowserJob;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup;
};

interface ResolvedAgentBrowserInputBase {
	redactedArgs: string[];
	toolArgs: string[];
	toolStdin?: string;
}

interface ResolvedAgentBrowserValidInputBase extends ResolvedAgentBrowserInputBase {
	status: "valid";
	validationError?: undefined;
}

export interface ResolvedAgentBrowserInvalidInput extends ResolvedAgentBrowserInputBase, ResolvedAgentBrowserInputModeFields {
	attemptedKind?: ResolvedAgentBrowserInputKind;
	kind: "invalid";
	status: "invalid";
	validationError: string;
}

export type ResolvedAgentBrowserValidInput =
	| (ResolvedAgentBrowserValidInputBase & {
		kind: "args";
	})
	| (ResolvedAgentBrowserValidInputBase & {
		compiledElectron: CompiledAgentBrowserElectron;
		kind: "electron";
		redactedCompiledElectron: CompiledAgentBrowserElectron;
	})
	| (ResolvedAgentBrowserValidInputBase & {
		compiledGeneratedBatch: CompiledAgentBrowserJob;
		compiledJob: CompiledAgentBrowserJob;
		kind: "job";
		redactedCompiledJob: CompiledAgentBrowserJob;
	})
	| (ResolvedAgentBrowserValidInputBase & {
		compiledGeneratedBatch: CompiledAgentBrowserNetworkSourceLookup;
		compiledNetworkSourceLookup: CompiledAgentBrowserNetworkSourceLookup;
		kind: "networkSourceLookup";
		redactedCompiledNetworkSourceLookup: CompiledAgentBrowserNetworkSourceLookup;
	})
	| (ResolvedAgentBrowserValidInputBase & {
		compiledGeneratedBatch: CompiledAgentBrowserQaPreset;
		compiledJob: CompiledAgentBrowserQaPreset;
		compiledQaPreset: CompiledAgentBrowserQaPreset;
		kind: "qa";
		redactedCompiledJob: CompiledAgentBrowserJob;
		redactedCompiledQaPreset: CompiledAgentBrowserQaPreset;
	})
	| (ResolvedAgentBrowserValidInputBase & {
		compiledSemanticAction: CompiledAgentBrowserSemanticAction;
		kind: "semanticAction";
		redactedCompiledSemanticAction: CompiledAgentBrowserSemanticAction;
	})
	| (ResolvedAgentBrowserValidInputBase & {
		compiledGeneratedBatch: CompiledAgentBrowserSourceLookup;
		compiledSourceLookup: CompiledAgentBrowserSourceLookup;
		kind: "sourceLookup";
		redactedCompiledSourceLookup: CompiledAgentBrowserSourceLookup;
	});

export type ResolvedAgentBrowserInput = ResolvedAgentBrowserInvalidInput | ResolvedAgentBrowserValidInput;

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

function normalizeExplicitEvalStdinArgs(args: string[], stdin: string | undefined): { args: string[]; stdin?: string } {
	if (stdin !== undefined) {
		return { args, stdin };
	}

	const descriptor = parseArgvDescriptor(args);
	if (descriptor.commandInfo.command !== "eval") {
		return { args, stdin };
	}

	const stdinIndex = descriptor.commandTokens.indexOf("--stdin");
	if (stdinIndex < 0 || stdinIndex >= descriptor.commandTokens.length - 1) {
		return { args, stdin };
	}

	const commandStartIndex = args.length - descriptor.commandTokens.length;
	const stdinValue = descriptor.commandTokens.slice(stdinIndex + 1).join(" ");
	return {
		args: [...args.slice(0, commandStartIndex), ...descriptor.commandTokens.slice(0, stdinIndex + 1)],
		stdin: stdinValue,
	};
}

export function resolveAgentBrowserInput(options: {
	getBatchPreflightValidationError: (args: string[], stdin: string | undefined) => string | undefined;
	managedSessionActive: boolean;
	params: AgentBrowserExecuteParams;
}): ResolvedAgentBrowserInput {
	const { getBatchPreflightValidationError, managedSessionActive, params } = options;
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
	const normalizedExplicitArgs = normalizeExplicitEvalStdinArgs(params.args ?? [], params.stdin);
	const toolArgs = compiledElectron ? [] : compiledSemanticAction?.args ?? compiledGeneratedBatch?.args ?? normalizedExplicitArgs.args;
	const toolStdin = compiledGeneratedBatch?.stdin ?? normalizedExplicitArgs.stdin;
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
		?? (compiledElectron ? undefined : validateToolArgs(toolArgs) ?? getBatchPreflightValidationError(toolArgs, toolStdin));
	const redactedCompiledJob = redactCompiledJob(compiledJob);
	const redactedCompiledSemanticAction = compiledSemanticAction
		? { ...compiledSemanticAction, args: redactInvocationArgs(compiledSemanticAction.args) }
		: undefined;
	const attemptedKind: ResolvedAgentBrowserInputKind | undefined = compiledElectron
		? "electron"
		: compiledNetworkSourceLookup
			? "networkSourceLookup"
			: compiledSourceLookup
				? "sourceLookup"
				: compiledQaPreset
					? "qa"
					: jobResult.compiled
						? "job"
						: compiledSemanticAction
							? "semanticAction"
							: hasExplicitArgs
								? "args"
								: undefined;

	const redactedCompiledElectron = redactCompiledElectron(compiledElectron);
	const redactedCompiledNetworkSourceLookup = redactCompiledNetworkSourceLookup(compiledNetworkSourceLookup);
	const redactedCompiledQaPreset = compiledQaPreset && redactedCompiledJob ? { ...redactedCompiledJob, checks: compiledQaPreset.checks } : undefined;
	const redactedCompiledSourceLookup = redactCompiledSourceLookup(compiledSourceLookup);
	const resolvedBase: ResolvedAgentBrowserInputBase = { redactedArgs, toolArgs, toolStdin };
	if (validationError) {
		return {
			...resolvedBase,
			attemptedKind,
			compiledElectron,
			compiledGeneratedBatch,
			compiledJob,
			compiledNetworkSourceLookup,
			compiledQaPreset,
			compiledSemanticAction,
			compiledSourceLookup,
			kind: "invalid",
			redactedCompiledElectron,
			redactedCompiledJob,
			redactedCompiledNetworkSourceLookup,
			redactedCompiledQaPreset,
			redactedCompiledSemanticAction,
			redactedCompiledSourceLookup,
			status: "invalid",
			validationError,
		};
	}
	if (compiledElectron && redactedCompiledElectron) {
		return { ...resolvedBase, compiledElectron, kind: "electron", redactedCompiledElectron, status: "valid" };
	}
	if (compiledNetworkSourceLookup && redactedCompiledNetworkSourceLookup) {
		return {
			...resolvedBase,
			compiledGeneratedBatch: compiledNetworkSourceLookup,
			compiledNetworkSourceLookup,
			kind: "networkSourceLookup",
			redactedCompiledNetworkSourceLookup,
			status: "valid",
		};
	}
	if (compiledSourceLookup && redactedCompiledSourceLookup) {
		return {
			...resolvedBase,
			compiledGeneratedBatch: compiledSourceLookup,
			compiledSourceLookup,
			kind: "sourceLookup",
			redactedCompiledSourceLookup,
			status: "valid",
		};
	}
	if (compiledQaPreset && redactedCompiledJob && redactedCompiledQaPreset) {
		return {
			...resolvedBase,
			compiledGeneratedBatch: compiledQaPreset,
			compiledJob: compiledQaPreset,
			compiledQaPreset,
			kind: "qa",
			redactedCompiledJob,
			redactedCompiledQaPreset,
			status: "valid",
		};
	}
	if (jobResult.compiled && redactedCompiledJob) {
		return {
			...resolvedBase,
			compiledGeneratedBatch: jobResult.compiled,
			compiledJob: jobResult.compiled,
			kind: "job",
			redactedCompiledJob,
			status: "valid",
		};
	}
	if (compiledSemanticAction && redactedCompiledSemanticAction) {
		return { ...resolvedBase, compiledSemanticAction, kind: "semanticAction", redactedCompiledSemanticAction, status: "valid" };
	}
	return { ...resolvedBase, kind: "args", status: "valid" };
}

export function buildValidationFailureResult(input: ResolvedAgentBrowserInvalidInput): {
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
