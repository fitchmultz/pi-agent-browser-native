import { parseArgvDescriptor } from "../argv-descriptor.js";
import { isRecord } from "../parsing.js";
import { isStringArray } from "../input-modes/shared.js";
import { normalizeUrlLessOpen } from "./batch-stdin.js";
import { isPlainTextInspectionArgs, validateToolArgs, redactInvocationArgs } from "../runtime.js";
import { buildAgentBrowserResultCategoryDetails } from "../results/categories.js";
import { compileAgentBrowserElectron } from "../input-modes/electron.js";
import { compileAgentBrowserQaPreset } from "../input-modes/job.js";
import {
	compileAgentBrowserNetworkSourceLookup,
	compileAgentBrowserSourceLookup,
} from "../input-modes/lookups.js";
import { compileAgentBrowserSemanticAction } from "../input-modes/semantic-action.js";
import {
	redactCompiledBatch,
	redactCompiledElectron,
	redactCompiledNetworkSourceLookup,
} from "./input-redaction.js";
import type {
	BatchPreflightValidator,
	ResolvedAgentBrowserInput,
	ResolvedAgentBrowserInputBase,
	ResolvedAgentBrowserInputKind,
	ResolvedAgentBrowserInputModeFields,
	ResolvedAgentBrowserInvalidInput,
	ResolvedAgentBrowserValidInput,
} from "./input-plan-types.js";
export type {
	AgentBrowserExecuteParams,
	ResolvedAgentBrowserInputKind,
	ResolvedAgentBrowserInput,
	ResolvedAgentBrowserInvalidInput,
	ResolvedAgentBrowserValidInput,
} from "./input-plan-types.js";

type InputFields = Readonly<Record<string, unknown>>;

function normalizeExplicitEvalStdinArgs(
	args: readonly string[],
	stdin: string | undefined,
): { args: readonly string[]; stdin?: string | undefined } {
	if (stdin !== undefined) {
		return { args, stdin };
	}
	const descriptor = parseArgvDescriptor([...args]);
	if (descriptor.commandInfo.command !== "eval") {
		return { args, stdin };
	}
	const stdinIndex = descriptor.commandTokens.indexOf("--stdin");
	if (stdinIndex < 0 || stdinIndex >= descriptor.commandTokens.length - 1) {
		return { args, stdin };
	}
	const commandStartIndex = args.length - descriptor.commandTokens.length;
	return {
		args: [
			...args.slice(0, commandStartIndex),
			...descriptor.commandTokens.slice(0, stdinIndex + 1),
		],
		stdin: descriptor.commandTokens.slice(stdinIndex + 1).join(" "),
	};
}

function fieldShapeError(params: InputFields): string | undefined {
	if (params.args !== undefined && !isStringArray(params.args)) {
		return "args must be an array of strings when provided.";
	}
	if (params.stdin !== undefined && typeof params.stdin !== "string") {
		return "stdin must be a string when provided.";
	}
	return undefined;
}

function outputPathError(value: unknown): string | undefined {
	if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
		return "outputPath must be a non-empty string when provided.";
	}
	return undefined;
}

/** Compiles all requested modes once, then validates selection before exposing executable input. */
class BrowserInputCompiler {
	private readonly semanticAction;
	private readonly qa;
	private readonly sourceLookup;
	private readonly networkSourceLookup;
	private readonly electron;
	private readonly modes: ResolvedAgentBrowserInputModeFields;

	constructor(
		private readonly params: InputFields,
		private readonly preflight: BatchPreflightValidator,
	) {
		this.semanticAction =
			params.semanticAction === undefined
				? {}
				: compileAgentBrowserSemanticAction(params.semanticAction);
		this.qa = params.qa === undefined ? {} : compileAgentBrowserQaPreset(params.qa);
		this.sourceLookup =
			params.sourceLookup === undefined ? {} : compileAgentBrowserSourceLookup(params.sourceLookup);
		this.networkSourceLookup =
			params.networkSourceLookup === undefined
				? {}
				: compileAgentBrowserNetworkSourceLookup(params.networkSourceLookup);
		this.electron =
			params.electron === undefined ? {} : compileAgentBrowserElectron(params.electron);
		this.modes = this.projectModes();
	}

	private projectModes(): ResolvedAgentBrowserInputModeFields {
		const compiledJob = this.qa.compiled;
		const redactedCompiledJob = redactCompiledBatch(compiledJob);
		const compiledSemanticAction = this.semanticAction.compiled;
		return {
			compiledElectron: this.electron.compiled,
			compiledGeneratedBatch:
				this.networkSourceLookup.compiled ?? this.sourceLookup.compiled ?? compiledJob,
			compiledJob,
			compiledNetworkSourceLookup: this.networkSourceLookup.compiled,
			compiledQaPreset: this.qa.compiled,
			compiledSemanticAction,
			compiledSourceLookup: this.sourceLookup.compiled,
			redactedCompiledElectron: redactCompiledElectron(this.electron.compiled),
			redactedCompiledJob,
			redactedCompiledNetworkSourceLookup: redactCompiledNetworkSourceLookup(
				this.networkSourceLookup.compiled,
			),
			redactedCompiledQaPreset:
				compiledJob !== undefined && redactedCompiledJob !== undefined
					? { ...redactedCompiledJob, checks: compiledJob.checks }
					: undefined,
			redactedCompiledSemanticAction:
				compiledSemanticAction === undefined
					? undefined
					: {
							...compiledSemanticAction,
							args: redactInvocationArgs([...compiledSemanticAction.args]),
						},
			redactedCompiledSourceLookup: redactCompiledBatch(this.sourceLookup.compiled),
		};
	}

	private attemptedKind(): ResolvedAgentBrowserInputKind | undefined {
		if (this.electron.compiled !== undefined) {
			return "electron";
		}
		if (this.networkSourceLookup.compiled !== undefined) {
			return "networkSourceLookup";
		}
		if (this.sourceLookup.compiled !== undefined) {
			return "sourceLookup";
		}
		if (this.qa.compiled !== undefined) {
			return "qa";
		}
		if (this.semanticAction.compiled !== undefined) {
			return "semanticAction";
		}
		return Array.isArray(this.params.args) ? "args" : undefined;
	}

	private inputModeError(): string | undefined {
		const selected = [
			Array.isArray(this.params.args),
			this.semanticAction.compiled !== undefined,
			this.qa.compiled !== undefined,
			this.sourceLookup.compiled !== undefined,
			this.networkSourceLookup.compiled !== undefined,
			this.electron.compiled !== undefined,
		].filter((active) => active).length;
		return selected === 1
			? undefined
			: "Provide exactly one of args, semanticAction, qa, sourceLookup, networkSourceLookup, or electron.";
	}

	private generatedStdinError(): string | undefined {
		if (this.params.stdin === undefined) {
			return undefined;
		}
		if (this.modes.compiledGeneratedBatch !== undefined) {
			return "Do not provide stdin with qa, sourceLookup, or networkSourceLookup; those modes generate their own batch stdin.";
		}
		return this.electron.compiled === undefined
			? undefined
			: "Do not provide stdin with electron; electron mode is host-only or manages its own input.";
	}

	private timeoutError(): string | undefined {
		const value = this.params.timeoutMs;
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
			return "timeoutMs must be a positive integer when provided.";
		}
		if (this.electron.compiled === undefined) {
			return undefined;
		}
		return this.electron.compiled.action === "list"
			? "electron.list has no configurable timeout; remove top-level timeoutMs."
			: "Use electron.timeoutMs for this action; top-level timeoutMs applies only to browser CLI subprocess calls.";
	}

	private attachedQaError(): string | undefined {
		return this.qa.compiled?.checks.attached === true && this.params.sessionMode === "fresh"
			? "qa.attached cannot be used with sessionMode=fresh; attach or launch a session first, then run qa.attached with the current session."
			: undefined;
	}

	private validationError(args: readonly string[], stdin: string | undefined): string | undefined {
		const compilationError = this.compilationError();
		const shapeError = fieldShapeError(this.params);
		const modeError = this.inputModeError() ?? this.generatedStdinError();
		const optionsError = this.optionsError();
		const error = compilationError ?? shapeError ?? modeError ?? optionsError;
		if (error !== undefined) {
			return error;
		}
		return this.electron.compiled === undefined
			? (validateToolArgs([...args]) ?? this.preflight(args, stdin))
			: undefined;
	}

	private compilationError(): string | undefined {
		return (
			this.semanticAction.error ??
			this.qa.error ??
			this.sourceLookup.error ??
			this.networkSourceLookup.error ??
			this.electron.error
		);
	}

	private optionsError(): string | undefined {
		return outputPathError(this.params.outputPath) ?? this.timeoutError() ?? this.attachedQaError();
	}

	private validInput(base: ResolvedAgentBrowserInputBase): ResolvedAgentBrowserValidInput {
		const {
			compiledElectron,
			compiledSemanticAction,
			redactedCompiledElectron,
			redactedCompiledSemanticAction,
		} = this.modes;
		if (compiledElectron !== undefined && redactedCompiledElectron !== undefined) {
			return {
				...base,
				compiledElectron,
				kind: "electron",
				redactedCompiledElectron,
				status: "valid",
			};
		}
		const generated = this.validGeneratedInput(base);
		if (generated !== undefined) {
			return generated;
		}
		if (compiledSemanticAction !== undefined && redactedCompiledSemanticAction !== undefined) {
			return {
				...base,
				compiledSemanticAction,
				kind: "semanticAction",
				redactedCompiledSemanticAction,
				status: "valid",
			};
		}
		return { ...base, kind: "args", status: "valid" };
	}

	private validGeneratedInput(
		base: ResolvedAgentBrowserInputBase,
	): ResolvedAgentBrowserValidInput | undefined {
		const {
			compiledNetworkSourceLookup,
			compiledSourceLookup,
			compiledQaPreset,
			redactedCompiledNetworkSourceLookup,
			redactedCompiledSourceLookup,
			redactedCompiledQaPreset,
			redactedCompiledJob,
		} = this.modes;
		if (
			compiledNetworkSourceLookup !== undefined &&
			redactedCompiledNetworkSourceLookup !== undefined
		) {
			return {
				...base,
				compiledGeneratedBatch: compiledNetworkSourceLookup,
				compiledNetworkSourceLookup,
				kind: "networkSourceLookup",
				redactedCompiledNetworkSourceLookup,
				status: "valid",
			};
		}
		if (compiledSourceLookup !== undefined && redactedCompiledSourceLookup !== undefined) {
			return {
				...base,
				compiledGeneratedBatch: compiledSourceLookup,
				compiledSourceLookup,
				kind: "sourceLookup",
				redactedCompiledSourceLookup,
				status: "valid",
			};
		}
		if (
			compiledQaPreset !== undefined &&
			redactedCompiledJob !== undefined &&
			redactedCompiledQaPreset !== undefined
		) {
			return {
				...base,
				compiledGeneratedBatch: compiledQaPreset,
				compiledJob: compiledQaPreset,
				compiledQaPreset,
				kind: "qa",
				redactedCompiledJob,
				redactedCompiledQaPreset,
				status: "valid",
			};
		}
		return undefined;
	}

	private explicitInput(): {
		readonly args: readonly string[];
		readonly stdin?: string | undefined;
	} {
		return normalizeExplicitEvalStdinArgs(
			isStringArray(this.params.args) ? this.params.args : [],
			typeof this.params.stdin === "string" ? this.params.stdin : undefined,
		);
	}

	private executionInput(): {
		readonly args: readonly string[];
		readonly stdin?: string | undefined;
	} {
		const explicit = this.explicitInput();
		return {
			args:
				this.electron.compiled === undefined
					? (this.semanticAction.compiled?.args ??
						this.modes.compiledGeneratedBatch?.args ??
						explicit.args)
					: [],
			stdin: this.modes.compiledGeneratedBatch?.stdin ?? explicit.stdin,
		};
	}

	resolve(): ResolvedAgentBrowserInput {
		const { args, stdin } = this.executionInput();
		const redactedArgs = redactInvocationArgs([...args]);
		const validationError = this.validationError(args, stdin);
		const normalized =
			validationError !== undefined || isPlainTextInspectionArgs([...args])
				? { args, stdin }
				: normalizeUrlLessOpen([...args], stdin);
		const base = { redactedArgs, toolArgs: normalized.args, toolStdin: normalized.stdin };
		if (validationError !== undefined) {
			return {
				...base,
				...this.modes,
				attemptedKind: this.attemptedKind(),
				kind: "invalid",
				status: "invalid",
				validationError,
			};
		}
		return this.validInput(base);
	}
}

export function resolveAgentBrowserInput(options: {
	readonly getBatchPreflightValidationError: BatchPreflightValidator;
	readonly params: unknown;
}): ResolvedAgentBrowserInput {
	const params = isRecord(options.params) ? options.params : {};
	return new BrowserInputCompiler(params, options.getBatchPreflightValidationError).resolve();
}

export function buildValidationFailureResult(input: ResolvedAgentBrowserInvalidInput): {
	content: Array<{ text: string; type: "text" }>;
	details: Record<string, unknown>;
	isError: true;
} {
	return {
		content: [{ type: "text", text: input.validationError }],
		details: {
			args: input.redactedArgs,
			compiledElectron: input.redactedCompiledElectron,
			compiledJob: input.redactedCompiledJob,
			compiledQaPreset: input.redactedCompiledQaPreset,
			compiledSourceLookup: input.redactedCompiledSourceLookup,
			compiledNetworkSourceLookup: input.redactedCompiledNetworkSourceLookup,
			compiledSemanticAction: input.redactedCompiledSemanticAction,
			...buildAgentBrowserResultCategoryDetails({
				args: [...input.redactedArgs],
				errorText: input.validationError,
				succeeded: false,
				validationError: input.validationError,
			}),
			validationError: input.validationError,
		},
		isError: true,
	};
}
