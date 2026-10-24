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

export type AgentBrowserToolResult = AgentToolResult<unknown> & { readonly isError?: boolean };
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
	toolStdin?: string;
}>;

export type OwnedManagedSessionReference = Readonly<{
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	headedManagedAutosaveDisabled?: boolean;
	headedManagedAutosaveInterval?: string;
	namespace?: string;
	sessionName: string;
	socketDir?: string;
}>;

export interface BrowserRunState {
	observedBrowserEffects?: Record<string, unknown>;
	confirmationPolicyIdentity?: string;
	confirmationPolicyMayBeEstablished?: boolean;
	activeRecordingReservations?: ReadonlyMap<string, ActiveRecordingReservation>;
	attachedSessionKeys: Set<string>;
	artifactManifest?: SessionArtifactManifest;
	closedManagedSessionNames: Set<string>;
	electronChildProcesses: Map<string, ChildProcess>;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	ephemeralSessionSeed: string;
	freshSessionOrdinal: number;
	managedSessionActive: boolean;
	managedSessionBaseName: string;
	managedSessionCompatibilityWorkaround?: CompatibilityWorkaround;
	managedSessionHeadedAutosaveDisabled?: boolean;
	managedSessionHeadedAutosaveInterval?: string;
	managedSessionCwd: string;
	managedSessionName: string;
	managedSessionNamespace?: string;
	managedSessionRestoreState: ManagedSessionRestoreState;
	networkRoutesBySession: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
	ownedManagedSessions: ReadonlyMap<string, OwnedManagedSessionReference>;
	sessionPageState: SessionPageState;
	traceOwners: Map<string, TraceOwner>;
}

export interface BrowserRunStatePatch {
	readonly artifactManifest?: SessionArtifactManifest;
	readonly freshSessionOrdinal?: number;
	readonly managedSessionActive?: boolean;
	readonly managedSessionCompatibilityWorkaround?: CompatibilityWorkaround;
	readonly managedSessionHeadedAutosaveDisabled?: boolean;
	readonly managedSessionHeadedAutosaveInterval?: string;
	readonly managedSessionCwd?: string;
	readonly managedSessionName?: string;
	readonly managedSessionNamespace?: string;
	readonly networkRoutesBySession?: ReadonlyMap<string, readonly NetworkRouteRecord[]>;
}

export type BrowserRunOptions = Readonly<{
	modelVisible?: boolean;
	operationCwd?: string;
	initialDaemonObservation?: PreparationDaemonObservation;
	ctx: BrowserRunContext;
	cwd: string;
	electronPostCommandStatusSettleMs: number;
	electronProfileIsolationDetails: unknown;
	establishAttachedBrowserSession?: boolean;
	implicitSessionCloseTimeoutMs: number;
	implicitSessionIdleTimeoutMs: string;
	input: ResolvedAgentBrowserValidInput;
	onUpdate?: (result: AgentToolResult<unknown>) => void;
	params: AgentBrowserExecuteParams;
	preserveAttachedBrowserSession?: boolean;
	promptPolicy: PromptPolicy;
	sessionPageStateUpdate: ReturnType<SessionPageState["beginUpdate"]>;
	signal?: AbortSignal;
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
	callerColdLaunch?: true;
	chromeStartupArgs?: string;
	readConfirmation?: ReadConfirmation;
	batchScreenshotArtifactRequests?: ReadonlyArray<ScreenshotArtifactRequest | undefined>;
	headedLaunch: boolean;
	providerLaunch: boolean;
	commandTokens: readonly string[];
	compiledElectron?: CompiledAgentBrowserElectron;
	compiledJob?: CompiledAgentBrowserJob;
	compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	compiledQaPreset?: CompiledAgentBrowserQaPreset;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	compiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	compatibilityWorkaround?: CompatibilityWorkaround;
	electronFailedConnectCleanup?: ElectronCleanupResult;
	electronHandoff?: ElectronHandoffSummary;
	electronLaunch?: ElectronLaunchSuccess;
	exactSensitiveValues: readonly string[];
	executionPlan: AgentBrowserExecutionPlan;
	managedSessionPolicyLock?: ManagedSessionPolicyLock;
	ownedManagedSessionContext?: OwnedManagedSessionContext;
	clickDispatchProbe?: ClickDispatchProbe;
	preparedArgs: PreparedAgentBrowserArgs;
	priorRefSnapshotState?: SessionRefSnapshot;
	priorSessionTabTarget?: SessionTabTarget;
	priorSessionTabTargetUnknown?: true;
	processArgs: readonly string[];
	processStdin?: string;
	processTimeoutMs?: number;
	redactedArgs: readonly string[];
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	redactedCompiledJob?: CompiledAgentBrowserJob;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	redactedEffectiveArgs: readonly string[];
	redactedProcessArgs: readonly string[];
	redactedRecoveryHint?: AgentBrowserExecutionPlan["recoveryHint"];
	resolvedSemanticActionRefSnapshot?: SessionRefSnapshot;
	runtimeToolArgs: readonly string[];
	runtimeToolStdin?: string;
	screenshotArtifactRequest?: ScreenshotArtifactRequest;
	scrollPositionBefore?: ScrollPositionSnapshot;
	sessionMode: "auto" | "fresh";
	sessionTabCorrection?: OpenResultTabCorrection;
	sessionTabPinningReason?: string;
	shouldProbeScrollNoop: boolean;
	statePatch: BrowserRunStatePatch;
	userRequestedJson: boolean;
}>;

export type PrepareBrowserRunResult =
	| {
			readonly kind: "early-result";
			readonly result: AgentBrowserToolResult;
			readonly statePatch?: BrowserRunStatePatch;
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
	currentRefSnapshot?: SessionRefSnapshot;
	currentRefSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	noActivePageSnapshotFailure: boolean;
	richInputRecoveryDiagnostic?: RichInputRecoveryDiagnostic;
	visibleRefFallbackDiagnostic?: VisibleRefFallbackDiagnostic;
	visibleRefFallbackSessionName?: string;
}>;

export type FinalResultInput = Readonly<{
	modelVisible?: boolean;
	aboutBlankSessionMismatch?: AboutBlankSessionMismatch;
	artifactCleanup?: ArtifactCleanupGuidance;
	categoryDetails: AgentBrowserResultCategoryDetails;
	clickDispatchDiagnostic?: ClickDispatchDiagnostic;
	commandTokens: readonly string[];
	comboboxFocusDiagnostic?: ComboboxFocusDiagnostic;
	compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	compatibilityWorkaround?: CompatibilityWorkaround;
	currentRefSnapshot?: SessionRefSnapshot;
	currentRefSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	currentSessionTabTarget?: SessionTabTarget;
	currentSessionTabTargetUnknown?: true;
	electronBroadGetTextScopeDiagnostics: readonly ElectronBroadGetTextScopeDiagnostic[];
	electronFailedConnectCleanup?: ElectronCleanupResult;
	electronHandoff?: ElectronHandoffSummary;
	electronLaunch?: ElectronLaunchSuccess;
	electronLaunchRecord?: ElectronLaunchRecord;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	electronPostCommandHealth?: ElectronPostCommandHealthDiagnostic;
	electronProfileIsolationDetails: unknown;
	electronRefFreshnessDiagnostic?: ElectronRefFreshnessDiagnostic;
	electronSessionMismatch?: ElectronSessionMismatch;
	errorText?: string;
	evalStdinHint?: EvalStdinHint;
	evalResultWarning?: EvalResultWarning;
	exactSensitiveValues: readonly string[];
	executionPlan: AgentBrowserExecutionPlan;
	fillVerificationDiagnostic?: FillVerificationDiagnostic;
	headedLaunch: boolean;
	inspectionText?: string;
	preserveAttachedBrowserSession: boolean;
	providerLaunch: boolean;
	managedSessionHeadedAutosaveDisabled?: boolean;
	managedSessionHeadedAutosaveInterval?: string;
	managedSessionOutcome?: ManagedSessionOutcome;
	managedSessionRestoreDisabled: boolean;
	navigationSummary?: NavigationSummary;
	networkSourceLookup?: AgentBrowserNetworkSourceLookupAnalysis;
	noActivePageSnapshotFailure: boolean;
	openResultTabCorrection?: OpenResultTabCorrection;
	overlayBlockerDiagnostic?: OverlayBlockerDiagnostic;
	parseError?: string;
	parseFailureOutput: ParseFailureOutput;
	parseSucceeded: boolean;
	plainTextInspection: boolean;
	presentation: AgentBrowserToolPresentation;
	presentationEnvelope?: AgentBrowserEnvelope;
	priorSessionTabTarget?: SessionTabTarget;
	processResult: AgentBrowserProcessResult;
	qaAttachedTarget?: QaAttachedTarget;
	qaPreset?: AgentBrowserQaPresetAnalysis;
	recordingDependencyWarning?: RecordingDependencyWarning;
	redactedArgs: readonly string[];
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	redactedCompiledJob?: CompiledAgentBrowserJob;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	redactedContent: AgentBrowserToolResult["content"];
	redactedProcessArgs: readonly string[];
	redactedRecoveryHint?: AgentBrowserExecutionPlan["recoveryHint"];
	resultArtifactManifest?: SessionArtifactManifest;
	richInputRecoveryDiagnostic?: RichInputRecoveryDiagnostic;
	scrollNoopDiagnostic?: ScrollNoopDiagnostic;
	selectorTextVisibilityDiagnostics: readonly SelectorTextVisibilityDiagnostic[];
	sessionMode: "auto" | "fresh";
	sessionTabCorrection?: OpenResultTabCorrection;
	sourceLookup?: AgentBrowserSourceLookupAnalysis;
	succeeded: boolean;
	timeoutPartialProgress?: TimeoutPartialProgress;
	unsettledWebMcpMutation?: boolean;
	userRequestedJson: boolean;
	visibleRefFallbackDiagnostic?: VisibleRefFallbackDiagnostic;
	visibleRefFallbackSessionName?: string;
}>;
