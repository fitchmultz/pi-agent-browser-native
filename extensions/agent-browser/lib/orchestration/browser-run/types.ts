import type { ChildProcess } from "node:child_process";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ElectronCleanupResult } from "../../electron/cleanup.js";
import type { ElectronLaunchRecord, ElectronLaunchSuccess } from "../../electron/launch.js";
import type {
	AgentBrowserNetworkSourceLookupAnalysis,
	AgentBrowserQaPresetAnalysis,
	AgentBrowserSourceLookupAnalysis,
	CompiledAgentBrowserElectron,
	CompiledAgentBrowserJob,
	CompiledAgentBrowserNetworkSourceLookup,
	CompiledAgentBrowserQaPreset,
	CompiledAgentBrowserSemanticAction,
	CompiledAgentBrowserSourceLookup,
} from "../../input-modes/types.js";
import type { runAgentBrowserProcess } from "../../process.js";
import type {
	AgentBrowserEnvelope,
	AgentBrowserResultCategoryDetails,
	NetworkRouteRecord,
	SessionArtifactManifest,
	ToolPresentation,
} from "../../results/contracts.js";
import type {
	RichInputRecoveryDiagnostic,
	VisibleRefFallbackDiagnostic,
} from "../../results/selector-recovery.js";
import type {
	SessionPageState,
	SessionRefSnapshot,
	SessionRefSnapshotInvalidation,
	SessionTabTarget,
} from "../../session-page-state.js";
import type {
	ExecutionPlan,
	CompatibilityWorkaround,
	OpenResultTabCorrection,
} from "../../runtime-contracts.js";
import type {
	ManagedSessionRestoreState,
	OwnedManagedSessionContext,
} from "../../managed-session-restore.js";
import type { ManagedSessionPolicyLock } from "../../managed-session-policy-lock.js";
import type { PromptPolicy } from "../../prompt-policy.js";
import type { ActiveRecordingReservation } from "../../recording-reservations.js";
import type { ReadConfirmation } from "../../read-confirmation.js";
import type { AgentBrowserExecuteParams, ResolvedAgentBrowserValidInput } from "../input-plan.js";
import type { PreparationDaemonObservation } from "./managed-session-daemon-inspection.js";
import type { OwnedManagedSession } from "../extension-resource-contracts.js";

export type AgentBrowserToolResult = AgentToolResult<unknown>;
export type AgentBrowserProcessResult = Awaited<ReturnType<typeof runAgentBrowserProcess>>;
export type AgentBrowserExecutionPlan = ExecutionPlan;
export type AgentBrowserToolPresentation = ToolPresentation;
export type { AgentBrowserResultCategoryDetails };

export type TraceOwner = "profiler" | "trace";
export type { BatchCommandStep } from "../batch-stdin.js";

export type BrowserRunContext = Readonly<{
	cwd: string;
	sessionDir?: string;
	sessionManager: {
		readonly getSessionDir?: () => string;
		readonly getSessionId: () => string | undefined;
	};
}>;

export type BrowserRunInputFields = Readonly<{
	compiledElectron?: CompiledAgentBrowserElectron;
	compiledJob?: CompiledAgentBrowserJob;
	compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	compiledQaPreset?: CompiledAgentBrowserQaPreset;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	compiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	redactedArgs: readonly string[];
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	redactedCompiledJob?: CompiledAgentBrowserJob;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	toolArgs: readonly string[];
	toolStdin?: string | undefined;
}>;

export type OwnedManagedSessionReference = Omit<OwnedManagedSession, "branchOwned">;

export interface BrowserRunStateSnapshot {
	observedBrowserEffects?: Record<string, unknown>;
	confirmationPolicyIdentity?: string;
	confirmationPolicyMayBeEstablished?: boolean;
	activeRecordingReservations?: ReadonlyMap<string, ActiveRecordingReservation>;
	attachedSessionKeys: Set<string>;
	artifactManifest?: SessionArtifactManifest | undefined;
	closedManagedSessionNames: Set<string>;
	electronChildProcesses: Map<string, ChildProcess>;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	ephemeralSessionSeed: string;
	freshSessionOrdinal: number;
	managedSessionActive: boolean;
	managedSessionBaseName: string;
	managedSessionCompatibilityWorkaround?: CompatibilityWorkaround | undefined;
	managedSessionHeadedAutosaveDisabled?: boolean;
	managedSessionHeadedAutosaveInterval?: string | undefined;
	managedSessionCwd: string;
	managedSessionName: string;
	managedSessionNamespace?: string | undefined;
	managedSessionRestoreState: ManagedSessionRestoreState;
	networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
	ownedManagedSessions: ReadonlyMap<string, OwnedManagedSessionReference>;
	sessionPageState: SessionPageState;
	traceOwners: Map<string, TraceOwner>;
}

export interface BrowserRunState extends BrowserRunStateSnapshot {
	readonly applyPatch: (patch: BrowserRunStatePatch | undefined) => void;
	readonly recordConfirmationPolicy: (mayBeEstablished: boolean) => void;
	readonly recordReadConfirmation: (confirmation: ReadConfirmation) => void;
	readonly recordBrowserEffects: (effects: Record<string, unknown>) => void;
}

export interface BrowserRunStatePatch {
	readonly artifactManifest?: SessionArtifactManifest | undefined;
	readonly freshSessionOrdinal?: number;
	readonly managedSessionActive?: boolean;
	readonly managedSessionCompatibilityWorkaround?: CompatibilityWorkaround | undefined;
	readonly managedSessionHeadedAutosaveDisabled?: boolean;
	readonly managedSessionHeadedAutosaveInterval?: string | undefined;
	readonly managedSessionCwd?: string;
	readonly managedSessionName?: string;
	readonly managedSessionNamespace?: string | undefined;
	readonly networkRoutesBySession?: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
}

export type BrowserRunOptions = Readonly<{
	operationCwd?: string;
	initialDaemonObservation?: PreparationDaemonObservation | undefined;
	ctx: BrowserRunContext;
	cwd: string;
	electronPostCommandStatusSettleMs: number;
	electronProfileIsolationDetails: unknown;
	establishAttachedBrowserSession?: boolean;
	implicitSessionCloseTimeoutMs: number;
	implicitSessionIdleTimeoutMs: string;
	input: ResolvedAgentBrowserValidInput;
	onUpdate?: ((result: AgentToolResult<unknown>) => void) | undefined;
	params: AgentBrowserExecuteParams;
	preserveAttachedBrowserSession?: boolean;
	promptPolicy: PromptPolicy;
	sessionPageStateUpdate: ReturnType<SessionPageState["beginUpdate"]>;
	signal?: AbortSignal | undefined;
	state: BrowserRunState;
}>;

export type {
	SemanticActionVisibleRefResolution,
	NavigationSummary,
	OverlayBlockerCandidate,
	OverlayBlockerDiagnostic,
	ClickDispatchProbeTarget,
	ClickDispatchProbe,
	ClickDispatchScrollContainerDiagnostic,
	ClickDispatchDiagnostic,
	SelectorTextVisibilityCandidate,
	SelectorTextVisibilityDiagnostic,
	ElectronBroadGetTextScopeDiagnostic,
	QaAttachedTarget,
	QaAttachedPreconditionFailure,
	TimeoutArtifactEvidence,
	TimeoutProgressStep,
	TimeoutPartialProgress,
	EvalStdinHint,
	EvalResultWarning,
	ArtifactCleanupGuidance,
	ManagedSessionOutcome,
	ScrollPositionSnapshot,
	ScrollNoopDiagnostic,
	ComboboxFocusDiagnostic,
	RecordingDependencyWarning,
	ScreenshotPathRequest,
	PreparedAgentBrowserArgs,
	ScreenshotArtifactRequest,
	StaleRefPreflight,
	AboutBlankSessionMismatch,
	ElectronHandoffSummary,
	ElectronManagedSessionTarget,
	ElectronSessionMismatchReason,
	ElectronSessionMismatch,
	ElectronPostCommandHealthReason,
	ElectronPostCommandHealthDiagnostic,
	FillVerificationDiagnostic,
	ElectronRefFreshnessDiagnostic,
} from "./observation-types.js";

import type {
	AboutBlankSessionMismatch,
	ArtifactCleanupGuidance,
	ClickDispatchDiagnostic,
	ClickDispatchProbe,
	ComboboxFocusDiagnostic,
	ElectronBroadGetTextScopeDiagnostic,
	ElectronHandoffSummary,
	ElectronPostCommandHealthDiagnostic,
	ElectronRefFreshnessDiagnostic,
	ElectronSessionMismatch,
	EvalResultWarning,
	EvalStdinHint,
	FillVerificationDiagnostic,
	ManagedSessionOutcome,
	NavigationSummary,
	OverlayBlockerDiagnostic,
	PreparedAgentBrowserArgs,
	QaAttachedTarget,
	RecordingDependencyWarning,
	ScreenshotArtifactRequest,
	ScrollNoopDiagnostic,
	ScrollPositionSnapshot,
	SelectorTextVisibilityDiagnostic,
	TimeoutPartialProgress,
} from "./observation-types.js";

export type PreparedBrowserRun = Readonly<{
	callerColdLaunch?: true | undefined;
	chromeStartupArgs?: string | undefined;
	readConfirmation?: ReadConfirmation | undefined;
	batchScreenshotArtifactRequests?: ReadonlyArray<ScreenshotArtifactRequest | undefined>;
	headedLaunch: boolean;
	providerLaunch: boolean;
	commandTokens: readonly string[];
	compiledElectron?: CompiledAgentBrowserElectron | undefined;
	compiledJob?: CompiledAgentBrowserJob | undefined;
	compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup | undefined;
	compiledQaPreset?: CompiledAgentBrowserQaPreset | undefined;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction | undefined;
	compiledSourceLookup?: CompiledAgentBrowserSourceLookup | undefined;
	compatibilityWorkaround?: CompatibilityWorkaround | undefined;
	electronFailedConnectCleanup?: ElectronCleanupResult;
	electronHandoff?: ElectronHandoffSummary;
	electronLaunch?: ElectronLaunchSuccess | undefined;
	exactSensitiveValues: readonly string[];
	executionPlan: AgentBrowserExecutionPlan;
	managedSessionPolicyLock?: ManagedSessionPolicyLock | undefined;
	ownedManagedSessionContext?: OwnedManagedSessionContext | undefined;
	clickDispatchProbe?: ClickDispatchProbe | undefined;
	preparedArgs: PreparedAgentBrowserArgs;
	priorRefSnapshotState?: SessionRefSnapshot | undefined;
	priorSessionTabTarget?: SessionTabTarget | undefined;
	priorSessionTabTargetUnknown?: true | undefined;
	processArgs: readonly string[];
	processStdin?: string | undefined;
	processTimeoutMs?: number | undefined;
	redactedArgs: readonly string[];
	redactedCompiledElectron?: CompiledAgentBrowserElectron | undefined;
	redactedCompiledJob?: CompiledAgentBrowserJob | undefined;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup | undefined;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset | undefined;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction | undefined;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup | undefined;
	redactedEffectiveArgs: readonly string[];
	redactedProcessArgs: readonly string[];
	redactedRecoveryHint?: AgentBrowserExecutionPlan["recoveryHint"];
	resolvedSemanticActionRefSnapshot?: SessionRefSnapshot | undefined;
	runtimeToolArgs: readonly string[];
	runtimeToolStdin?: string | undefined;
	screenshotArtifactRequest?: ScreenshotArtifactRequest;
	scrollPositionBefore?: ScrollPositionSnapshot | undefined;
	sessionMode: "auto" | "fresh";
	sessionTabCorrection?: OpenResultTabCorrection | undefined;
	sessionTabPinningReason?: string | undefined;
	shouldProbeScrollNoop: boolean;
	statePatch: BrowserRunStatePatch;
	userRequestedJson: boolean;
}>;

export type PrepareBrowserRunResult =
	| {
			readonly kind: "early-result";
			readonly result: AgentBrowserToolResult;
			readonly statePatch?: BrowserRunStatePatch | undefined;
	  }
	| { readonly kind: "ready"; readonly prepared: PreparedBrowserRun };

export interface ProcessBrowserOutputInput extends BrowserRunOptions {
	readonly artifactRunStartedAtMs: number;
	readonly prepared: PreparedBrowserRun;
	readonly processResult: AgentBrowserProcessResult;
}

export type BrowserProcessOutputResult = Readonly<{
	result: AgentBrowserToolResult;
	statePatch: BrowserRunStatePatch;
}>;

export type ParseFailureOutput = Readonly<{
	artifactManifest?: SessionArtifactManifest;
	artifactRetentionSummary?: string;
	fullOutputPath?: string;
	fullOutputUnavailable?: string;
}>;

export type FinalRecoveryState = Readonly<{
	categoryDetails: AgentBrowserResultCategoryDetails;
	currentRefSnapshot?: SessionRefSnapshot | undefined;
	currentRefSnapshotInvalidation?: SessionRefSnapshotInvalidation | undefined;
	noActivePageSnapshotFailure: boolean;
	richInputRecoveryDiagnostic?: RichInputRecoveryDiagnostic | undefined;
	visibleRefFallbackDiagnostic?: VisibleRefFallbackDiagnostic | undefined;
	visibleRefFallbackSessionName?: string | undefined;
}>;

export type FinalResultInput = Readonly<{
	aboutBlankSessionMismatch?: AboutBlankSessionMismatch | undefined;
	artifactCleanup?: ArtifactCleanupGuidance | undefined;
	categoryDetails: AgentBrowserResultCategoryDetails;
	clickDispatchDiagnostic?: ClickDispatchDiagnostic | undefined;
	commandTokens: readonly string[];
	comboboxFocusDiagnostic?: ComboboxFocusDiagnostic | undefined;
	compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup | undefined;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction | undefined;
	compatibilityWorkaround?: CompatibilityWorkaround | undefined;
	currentRefSnapshot?: SessionRefSnapshot | undefined;
	currentRefSnapshotInvalidation?: SessionRefSnapshotInvalidation | undefined;
	currentSessionTabTarget?: SessionTabTarget | undefined;
	currentSessionTabTargetUnknown?: true | undefined;
	electronBroadGetTextScopeDiagnostics: readonly ElectronBroadGetTextScopeDiagnostic[];
	electronFailedConnectCleanup?: ElectronCleanupResult | undefined;
	electronHandoff?: ElectronHandoffSummary | undefined;
	electronLaunch?: ElectronLaunchSuccess | undefined;
	electronLaunchRecord?: ElectronLaunchRecord | undefined;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	electronPostCommandHealth?: ElectronPostCommandHealthDiagnostic | undefined;
	electronProfileIsolationDetails: unknown;
	electronRefFreshnessDiagnostic?: ElectronRefFreshnessDiagnostic | undefined;
	electronSessionMismatch?: ElectronSessionMismatch | undefined;
	errorText?: string | undefined;
	evalStdinHint?: EvalStdinHint | undefined;
	evalResultWarning?: EvalResultWarning | undefined;
	exactSensitiveValues: readonly string[];
	executionPlan: AgentBrowserExecutionPlan;
	fillVerificationDiagnostic?: FillVerificationDiagnostic | undefined;
	headedLaunch: boolean;
	inspectionText?: string | undefined;
	preserveAttachedBrowserSession: boolean;
	providerLaunch: boolean;
	managedSessionHeadedAutosaveDisabled?: boolean | undefined;
	managedSessionHeadedAutosaveInterval?: string | undefined;
	managedSessionOutcome?: ManagedSessionOutcome | undefined;
	managedSessionRestoreDisabled: boolean;
	navigationSummary?: NavigationSummary | undefined;
	networkSourceLookup?: AgentBrowserNetworkSourceLookupAnalysis | undefined;
	noActivePageSnapshotFailure: boolean;
	openResultTabCorrection?: OpenResultTabCorrection | undefined;
	overlayBlockerDiagnostic?: OverlayBlockerDiagnostic | undefined;
	parseError?: string | undefined;
	parseFailureOutput: ParseFailureOutput;
	parseSucceeded: boolean;
	plainTextInspection: boolean;
	presentation: AgentBrowserToolPresentation;
	presentationEnvelope?: AgentBrowserEnvelope | undefined;
	priorSessionTabTarget?: SessionTabTarget | undefined;
	processResult: AgentBrowserProcessResult;
	qaAttachedTarget?: QaAttachedTarget | undefined;
	qaPreset?: AgentBrowserQaPresetAnalysis | undefined;
	recordingDependencyWarning?: RecordingDependencyWarning | undefined;
	redactedArgs: readonly string[];
	redactedCompiledElectron?: CompiledAgentBrowserElectron | undefined;
	redactedCompiledJob?: CompiledAgentBrowserJob | undefined;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup | undefined;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset | undefined;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction | undefined;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup | undefined;
	redactedContent: AgentBrowserToolResult["content"];
	redactedProcessArgs: readonly string[];
	redactedRecoveryHint?: AgentBrowserExecutionPlan["recoveryHint"];
	resultArtifactManifest?: SessionArtifactManifest | undefined;
	richInputRecoveryDiagnostic?: RichInputRecoveryDiagnostic | undefined;
	scrollNoopDiagnostic?: ScrollNoopDiagnostic | undefined;
	selectorTextVisibilityDiagnostics: readonly SelectorTextVisibilityDiagnostic[];
	sessionMode: "auto" | "fresh";
	sessionTabCorrection?: OpenResultTabCorrection | undefined;
	sourceLookup?: AgentBrowserSourceLookupAnalysis | undefined;
	succeeded: boolean;
	timeoutPartialProgress?: TimeoutPartialProgress | undefined;
	unsettledWebMcpMutation?: boolean;
	userRequestedJson: boolean;
	visibleRefFallbackDiagnostic?: VisibleRefFallbackDiagnostic | undefined;
	visibleRefFallbackSessionName?: string | undefined;
}>;
