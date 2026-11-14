import type {
	CompiledAgentBrowserElectron,
	CompiledAgentBrowserJob,
	CompiledAgentBrowserNetworkSourceLookup,
	CompiledAgentBrowserQaPreset,
	CompiledAgentBrowserSemanticAction,
	CompiledAgentBrowserSourceLookup,
} from "../input-modes/types.js";

export interface AgentBrowserExecuteParams {
	readonly args?: readonly string[];
	readonly electron?: unknown;
	readonly networkSourceLookup?: unknown;
	readonly outputPath?: string | undefined;
	readonly qa?: unknown;
	readonly semanticAction?: unknown;
	readonly sessionMode?: "auto" | "fresh" | undefined;
	readonly sourceLookup?: unknown;
	readonly stdin?: string | undefined;
	readonly timeoutMs?: number | undefined;
}

export type ResolvedAgentBrowserInputKind =
	| "args"
	| "electron"
	| "networkSourceLookup"
	| "qa"
	| "semanticAction"
	| "sourceLookup";

export interface ResolvedAgentBrowserInputModeFields {
	readonly compiledElectron?: CompiledAgentBrowserElectron | undefined;
	readonly compiledGeneratedBatch?:
		| CompiledAgentBrowserJob
		| CompiledAgentBrowserNetworkSourceLookup
		| CompiledAgentBrowserSourceLookup
		| undefined;
	readonly compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup | undefined;
	readonly compiledQaPreset?: CompiledAgentBrowserQaPreset | undefined;
	readonly compiledSemanticAction?: CompiledAgentBrowserSemanticAction | undefined;
	readonly compiledSourceLookup?: CompiledAgentBrowserSourceLookup | undefined;
	readonly redactedCompiledElectron?: CompiledAgentBrowserElectron | undefined;
	readonly redactedCompiledNetworkSourceLookup?:
		| CompiledAgentBrowserNetworkSourceLookup
		| undefined;
	readonly redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset | undefined;
	readonly redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction | undefined;
	readonly redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup | undefined;
}

export interface ResolvedAgentBrowserInputBase {
	readonly redactedArgs: readonly string[];
	readonly toolArgs: readonly string[];
	readonly toolStdin?: string | undefined;
}

interface ResolvedAgentBrowserValidInputBase extends ResolvedAgentBrowserInputBase {
	readonly nativeConfirmActions?: string | undefined;
	readonly chromeStartupArgs?: string | undefined;
	readonly hasExplicitChromeArgs?: boolean;
	readonly status: "valid";
	readonly validationError?: undefined;
}

export interface ResolvedAgentBrowserInvalidInput
	extends ResolvedAgentBrowserInputBase, ResolvedAgentBrowserInputModeFields {
	readonly attemptedKind?: ResolvedAgentBrowserInputKind | undefined;
	readonly kind: "invalid";
	readonly status: "invalid";
	readonly validationError: string;
}

export type ResolvedAgentBrowserValidInput =
	| (ResolvedAgentBrowserValidInputBase & { readonly kind: "args" })
	| (ResolvedAgentBrowserValidInputBase & {
			readonly kind: "electron";
			readonly compiledElectron: CompiledAgentBrowserElectron;
			readonly redactedCompiledElectron: CompiledAgentBrowserElectron;
	  })
	| (ResolvedAgentBrowserValidInputBase & {
			readonly kind: "networkSourceLookup";
			readonly compiledGeneratedBatch: CompiledAgentBrowserNetworkSourceLookup;
			readonly compiledNetworkSourceLookup: CompiledAgentBrowserNetworkSourceLookup;
			readonly redactedCompiledNetworkSourceLookup: CompiledAgentBrowserNetworkSourceLookup;
	  })
	| (ResolvedAgentBrowserValidInputBase & {
			readonly kind: "qa";
			readonly compiledGeneratedBatch: CompiledAgentBrowserQaPreset;
			readonly compiledQaPreset: CompiledAgentBrowserQaPreset;
			readonly redactedCompiledQaPreset: CompiledAgentBrowserQaPreset;
	  })
	| (ResolvedAgentBrowserValidInputBase & {
			readonly kind: "semanticAction";
			readonly compiledSemanticAction: CompiledAgentBrowserSemanticAction;
			readonly redactedCompiledSemanticAction: CompiledAgentBrowserSemanticAction;
	  })
	| (ResolvedAgentBrowserValidInputBase & {
			readonly kind: "sourceLookup";
			readonly compiledGeneratedBatch: CompiledAgentBrowserSourceLookup;
			readonly compiledSourceLookup: CompiledAgentBrowserSourceLookup;
			readonly redactedCompiledSourceLookup: CompiledAgentBrowserSourceLookup;
	  });

export type ResolvedAgentBrowserInput =
	| ResolvedAgentBrowserInvalidInput
	| ResolvedAgentBrowserValidInput;
export type BatchPreflightValidator = (
	args: readonly string[],
	stdin: string | undefined,
) => string | undefined;
