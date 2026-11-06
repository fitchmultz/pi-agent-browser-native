import type { BrowserBranch } from "../browser-journal.js";
import type { withNativeSessionDefaults } from "./native-session-defaults.js";
import type { buildPromptPolicy } from "../prompt-policy.js";
import type { CompiledAgentBrowserElectron } from "../input-modes/types.js";
import type { AgentBrowserExecuteParams, ResolvedAgentBrowserValidInput } from "./input-plan.js";
import type { AgentBrowserExecutor } from "../tool-surface.js";
import type { ReadConfirmation } from "../read-confirmation.js";

export type NativeLaunchDefaultsRunner = NonNullable<
	Parameters<Parameters<typeof withNativeSessionDefaults>[2]>[1]
>;

export interface BrowserInvocationInput {
	readonly toolCallId: string;
	readonly params: AgentBrowserExecuteParams;
	readonly signal: Parameters<AgentBrowserExecutor>[2];
	readonly onUpdate?: Parameters<AgentBrowserExecutor>[3];
	readonly ctx: Parameters<AgentBrowserExecutor>[4];
	readonly nativeToolCallId?: string;
	readonly capturedCwd?: string;
	readonly modelVisible?: boolean;
	readonly commandIndex?: number;
	readonly selectedBranch?: Readonly<BrowserBranch>;
}

export interface BrowserInvocation extends BrowserInvocationInput {
	readonly nativeToolCallId: string;
	readonly modelVisible: boolean;
}

export interface AdmittedBrowserCall extends BrowserInvocation {
	readonly branch: Readonly<BrowserBranch>;
	readonly operationCwd: string;
	readonly promptPolicy: ReturnType<typeof buildPromptPolicy>;
	readonly outputPath?: string | undefined;
	readonly admittedInput: ResolvedAgentBrowserValidInput;
	readonly explicitConfig: boolean;
	readonly managedAtAdmission: boolean;
}

export interface PreparedBrowserCall extends AdmittedBrowserCall {
	readonly resolvedInput: ResolvedAgentBrowserValidInput;
	readonly browserCwd: string;
	readonly executionTimeoutMs: number;
}

export interface NativeBrowserCall extends PreparedBrowserCall {
	readonly readConfirmation?: ReadConfirmation | undefined;
	readonly withLaunchDefaults?: NativeLaunchDefaultsRunner | undefined;
	readonly toolArgs: readonly string[];
	readonly compiledElectron?: CompiledAgentBrowserElectron | undefined;
	readonly redactedCompiledElectron?: CompiledAgentBrowserElectron | undefined;
}

export interface CoordinatedBrowserCall extends NativeBrowserCall {
	readonly explicitSessionName?: string | undefined;
	readonly callerOwnedSessionNamespace?: string | undefined;
	readonly serializeBrowserCommand: boolean;
	readonly callerOwnedSessionQueueKey?: string | undefined;
	readonly closesAllSessions: boolean;
}

export type BrowserHostCall = Pick<
	NativeBrowserCall,
	| "ctx"
	| "compiledElectron"
	| "redactedCompiledElectron"
	| "signal"
	| "branch"
	| "toolCallId"
	| "commandIndex"
	| "executionTimeoutMs"
	| "outputPath"
	| "operationCwd"
	| "resolvedInput"
>;
export type BrowserOutputCall = Pick<
	NativeBrowserCall,
	"outputPath" | "operationCwd" | "resolvedInput"
>;
export type BrowserCommandCall = Omit<
	CoordinatedBrowserCall,
	| "nativeToolCallId"
	| "capturedCwd"
	| "selectedBranch"
	| "admittedInput"
	| "explicitConfig"
	| "managedAtAdmission"
>;

export function createBrowserInvocation(input: BrowserInvocationInput): BrowserInvocation {
	return {
		...input,
		nativeToolCallId: input.nativeToolCallId ?? input.toolCallId,
		modelVisible: input.modelVisible ?? true,
	};
}
