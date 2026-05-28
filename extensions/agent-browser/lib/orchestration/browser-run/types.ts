import type { ChildProcess } from "node:child_process";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ElectronCleanupResult, ElectronLaunchStatus } from "../../electron/cleanup.js";
import type { ElectronCdpTarget, ElectronLaunchRecord, ElectronLaunchSuccess } from "../../electron/launch.js";
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
} from "../../input-modes.js";
import type { runAgentBrowserProcess } from "../../process.js";
import type { AgentBrowserEnvelope, AgentBrowserNextAction, buildAgentBrowserResultCategoryDetails, buildToolPresentation } from "../../results.js";
import type { SessionArtifactManifest } from "../../results/contracts.js";
import type { RichInputRecoveryDiagnostic, VisibleRefFallbackDiagnostic } from "../../results/selector-recovery.js";
import type { SessionPageState, SessionRefSnapshot, SessionRefSnapshotInvalidation, SessionTabTarget } from "../../session-page-state.js";
import type { buildExecutionPlan, CompatibilityWorkaround, OpenResultTabCorrection } from "../../runtime.js";
import type { PromptPolicy } from "../../prompt-policy.js";
import type { AgentBrowserExecuteParams, ResolvedAgentBrowserValidInput } from "../input-plan.js";
import type { BatchCommandStep } from "../batch-stdin.js";

export type AgentBrowserToolResult = AgentToolResult<unknown> & { isError?: boolean };
export type AgentBrowserProcessResult = Awaited<ReturnType<typeof runAgentBrowserProcess>>;
export type AgentBrowserExecutionPlan = ReturnType<typeof buildExecutionPlan>;
export type AgentBrowserToolPresentation = Awaited<ReturnType<typeof buildToolPresentation>>;
export type AgentBrowserResultCategoryDetails = ReturnType<typeof buildAgentBrowserResultCategoryDetails>;

export type TraceOwner = "profiler" | "trace";
export type PinnedBatchUnwrapMode = "single-command" | "user-batch";
export type { BatchCommandStep } from "../batch-stdin.js";

export interface BrowserRunContext {
	cwd: string;
	sessionDir?: string;
	sessionManager: {
		getSessionDir?: () => string;
		getSessionId: () => string | undefined;
	};
}

export interface BrowserRunInputFields {
	compiledElectron?: CompiledAgentBrowserElectron;
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
}

export interface BrowserRunState {
	artifactManifest?: SessionArtifactManifest;
	closedManagedSessionNames: Set<string>;
	electronChildProcesses: Map<string, ChildProcess>;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	ephemeralSessionSeed: string;
	freshSessionOrdinal: number;
	managedSessionActive: boolean;
	managedSessionBaseName: string;
	managedSessionCwd: string;
	managedSessionName: string;
	sessionPageState: SessionPageState;
	traceOwners: Map<string, TraceOwner>;
}

export interface BrowserRunStatePatch {
	artifactManifest?: SessionArtifactManifest;
	freshSessionOrdinal?: number;
	managedSessionActive?: boolean;
	managedSessionCwd?: string;
	managedSessionName?: string;
}

export interface BrowserRunOptions {
	ctx: BrowserRunContext;
	cwd: string;
	electronPostCommandStatusSettleMs: number;
	electronProfileIsolationDetails: unknown;
	implicitSessionCloseTimeoutMs: number;
	implicitSessionIdleTimeoutMs: string;
	input: ResolvedAgentBrowserValidInput;
	onUpdate?: (result: AgentToolResult<unknown>) => void;
	params: AgentBrowserExecuteParams;
	promptPolicy: PromptPolicy;
	sessionPageStateUpdate: ReturnType<SessionPageState["beginUpdate"]>;
	signal?: AbortSignal;
	state: BrowserRunState;
}

export interface SemanticActionVisibleRefResolution {
	args: string[];
	snapshot: SessionRefSnapshot;
}

export interface NavigationSummary {
	title?: string;
	url?: string;
}

export interface OverlayBlockerCandidate {
	args: string[];
	name?: string;
	reason: string;
	ref: string;
	role?: string;
}

export interface OverlayBlockerDiagnostic {
	candidates: OverlayBlockerCandidate[];
	snapshot: SessionRefSnapshot;
	summary: string;
}

export interface ClickDispatchProbeTarget {
	kind: "selector" | "xpath";
	selector: string;
}

export interface ClickDispatchProbe {
	marker: string;
	target: ClickDispatchProbeTarget;
}

export interface ClickDispatchDiagnostic {
	nativeEventCount: number;
	reason: "native-click-produced-no-target-dom-event";
	status: "no-native-event-observed";
	summary: string;
	target: ClickDispatchProbeTarget;
}

export interface SelectorTextVisibilityDiagnostic {
	firstMatchVisible?: boolean;
	firstVisibleTextPreview?: string;
	matchCount: number;
	selector: string;
	summary: string;
	visibleCount: number;
}

export interface ElectronBroadGetTextScopeDiagnostic {
	electronContext: {
		launchId?: string;
		sessionName?: string;
		url?: string;
	};
	selector: string;
	summary: string;
}

export interface QaAttachedTarget {
	error?: string;
	sessionName: string;
	title?: string;
	url?: string;
}

export interface QaAttachedPreconditionFailure {
	error: string;
	nextActions: AgentBrowserNextAction[];
}

export interface TimeoutArtifactEvidence {
	absolutePath: string;
	exists: boolean;
	path: string;
	sizeBytes?: number;
	stepIndex: number;
}

export interface TimeoutPartialProgress {
	artifacts: TimeoutArtifactEvidence[];
	currentPage?: {
		title?: string;
		url?: string;
	};
	steps?: Array<{ args: string[]; index: number }>;
	summary: string;
}

export interface EvalStdinHint {
	reason: string;
	suggestion: string;
}

export interface ArtifactCleanupGuidance {
	explicitArtifactPaths: string[];
	note: string;
	owner: "host-file-tools";
	summary: string;
}

export interface ManagedSessionOutcome {
	activeAfter: boolean;
	activeBefore: boolean;
	attemptedSessionName?: string;
	currentSessionName: string;
	previousSessionName: string;
	replacedSessionName?: string;
	sessionMode: "auto" | "fresh";
	status: "abandoned" | "closed" | "created" | "preserved" | "replaced" | "unchanged";
	succeeded: boolean;
	summary: string;
}

export interface ScrollPositionSnapshot {
	containerCount: number;
	containers: Array<{ id: string; scrollLeft: number; scrollTop: number }>;
	innerHeight: number;
	innerWidth: number;
	scrollHeight: number;
	scrollWidth: number;
	scrollX: number;
	scrollY: number;
}

export interface ScrollNoopDiagnostic {
	after: ScrollPositionSnapshot;
	before: ScrollPositionSnapshot;
	message: string;
	reason: "no-observed-scroll-position-change";
	recommendations: string[];
}

export interface ComboboxFocusDiagnostic {
	activeElement: {
		expanded?: string;
		hasPopup?: string;
		name?: string;
		role?: string;
		tagName?: string;
	};
	message: string;
	reason: "focused-combobox-without-visible-options";
	recommendations: string[];
	visibleListboxCount: number;
	visibleOptionCount: number;
}

export interface RecordingDependencyWarning {
	command: "record start" | "record restart";
	dependency: "ffmpeg";
	message: string;
	reason: "ffmpeg-missing-for-recording";
	recommendations: string[];
}

export interface ScreenshotPathRequest {
	absolutePath: string;
	path: string;
}

export interface PreparedAgentBrowserArgs {
	args: string[];
	batchScreenshotPathRequests?: Array<ScreenshotPathRequest | undefined>;
	screenshotPathRequest?: ScreenshotPathRequest;
	stdin?: string;
}

export interface ScreenshotArtifactRequest extends ScreenshotPathRequest {
	status?: "missing" | "repaired-from-temp" | "saved" | "upstream-temp-only";
	tempPath?: string;
}

export interface PinnedBatchPlan {
	includeNavigationSummary: boolean;
	steps: BatchCommandStep[];
	unwrapMode: PinnedBatchUnwrapMode;
}

export interface StaleRefPreflight {
	message: string;
	refIds: string[];
	snapshot?: SessionRefSnapshot;
	snapshotInvalidation?: SessionRefSnapshotInvalidation;
}

export interface AboutBlankSessionMismatch {
	activeUrl: "about:blank";
	recoveryApplied: boolean;
	recoveryHint: string;
	targetTitle?: string;
	targetUrl: string;
}

export interface ElectronHandoffSummary {
	error?: string;
	handoff: "connect" | "snapshot" | "tabs";
	refSnapshot?: SessionRefSnapshot;
	snapshot?: unknown;
	snapshotRetryCount?: number;
	tabs?: unknown;
}

export interface ElectronManagedSessionTarget {
	error?: string;
	sessionName: string;
	title?: string;
	url?: string;
}

export type ElectronSessionMismatchReason =
	| "launch-session-not-current"
	| "managed-session-about-blank-while-launch-target-live"
	| "managed-session-target-not-in-launch-status";

export interface ElectronSessionMismatch {
	launchId: string;
	liveTarget?: ElectronCdpTarget;
	managedSession: ElectronManagedSessionTarget;
	nextActionIds: string[];
	reason: ElectronSessionMismatchReason;
	sessionName?: string;
	statusTargets: ElectronCdpTarget[];
	summary: string;
}

export type ElectronPostCommandHealthReason = "about-blank-no-live-target" | "debug-port-dead" | "process-dead";

export interface ElectronPostCommandHealthDiagnostic {
	appName: string;
	command?: string;
	launchId: string;
	nextActionIds: string[];
	reason: ElectronPostCommandHealthReason;
	sessionName?: string;
	status: ElectronLaunchStatus;
	summary: string;
	target?: SessionTabTarget;
}

export interface FillVerificationDiagnostic {
	actual?: string;
	expected: string;
	nextActionIds: string[];
	selector: string;
	status: "mismatch";
	summary: string;
}

export interface ElectronRefFreshnessDiagnostic {
	command?: string;
	launchId: string;
	nextActionIds: string[];
	sessionName?: string;
	summary: string;
}

export interface PreparedBrowserRun {
	batchScreenshotArtifactRequests?: Array<ScreenshotArtifactRequest | undefined>;
	commandTokens: string[];
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
	exactSensitiveValues: string[];
	executionPlan: AgentBrowserExecutionPlan;
	includePinnedNavigationSummary: boolean;
	clickDispatchProbe?: ClickDispatchProbe;
	pinnedBatchUnwrapMode?: PinnedBatchUnwrapMode;
	preparedArgs: PreparedAgentBrowserArgs;
	priorRefSnapshotState?: SessionRefSnapshot;
	priorSessionTabTarget?: SessionTabTarget;
	processArgs: string[];
	processStdin?: string;
	redactedArgs: string[];
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	redactedCompiledJob?: CompiledAgentBrowserJob;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	redactedEffectiveArgs: string[];
	redactedProcessArgs: string[];
	redactedRecoveryHint?: ReturnType<typeof import("../../runtime.js").buildExecutionPlan>["recoveryHint"];
	resolvedSemanticActionRefSnapshot?: SessionRefSnapshot;
	runtimeToolArgs: string[];
	runtimeToolStdin?: string;
	screenshotArtifactRequest?: ScreenshotArtifactRequest;
	scrollPositionBefore?: ScrollPositionSnapshot;
	sessionMode: "auto" | "fresh";
	sessionTabCorrection?: OpenResultTabCorrection;
	sessionTabPinningReason?: string;
	shouldProbeScrollNoop: boolean;
	statePatch: BrowserRunStatePatch;
	userRequestedJson: boolean;
}

export type PrepareBrowserRunResult =
	| { kind: "early-result"; result: AgentBrowserToolResult; statePatch?: BrowserRunStatePatch }
	| { kind: "ready"; prepared: PreparedBrowserRun };

export interface ProcessBrowserOutputInput extends BrowserRunOptions {
	prepared: PreparedBrowserRun;
	processResult: AgentBrowserProcessResult;
}

export interface BrowserProcessOutputResult {
	result: AgentBrowserToolResult;
	statePatch: BrowserRunStatePatch;
}

export interface ParseFailureOutput {
	artifactManifest?: SessionArtifactManifest;
	artifactRetentionSummary?: string;
	fullOutputPath?: string;
	fullOutputUnavailable?: string;
}

export interface FinalRecoveryState {
	categoryDetails: AgentBrowserResultCategoryDetails;
	currentRefSnapshot?: SessionRefSnapshot;
	currentRefSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	noActivePageSnapshotFailure: boolean;
	richInputRecoveryDiagnostic?: RichInputRecoveryDiagnostic;
	visibleRefFallbackDiagnostic?: VisibleRefFallbackDiagnostic;
	visibleRefFallbackSessionName?: string;
}

export interface FinalResultInput {
	aboutBlankSessionMismatch?: AboutBlankSessionMismatch;
	artifactCleanup?: ArtifactCleanupGuidance;
	categoryDetails: AgentBrowserResultCategoryDetails;
	clickDispatchDiagnostic?: ClickDispatchDiagnostic;
	commandTokens: string[];
	comboboxFocusDiagnostic?: ComboboxFocusDiagnostic;
	compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	compatibilityWorkaround?: CompatibilityWorkaround;
	currentRefSnapshot?: SessionRefSnapshot;
	currentRefSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	currentSessionTabTarget?: SessionTabTarget;
	electronBroadGetTextScopeDiagnostics: ElectronBroadGetTextScopeDiagnostic[];
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
	exactSensitiveValues: string[];
	executionPlan: AgentBrowserExecutionPlan;
	fillVerificationDiagnostic?: FillVerificationDiagnostic;
	inspectionText?: string;
	managedSessionOutcome?: ManagedSessionOutcome;
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
	redactedArgs: string[];
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	redactedCompiledJob?: CompiledAgentBrowserJob;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	redactedContent: AgentBrowserToolResult["content"];
	redactedProcessArgs: string[];
	redactedRecoveryHint?: AgentBrowserExecutionPlan["recoveryHint"];
	resultArtifactManifest?: SessionArtifactManifest;
	richInputRecoveryDiagnostic?: RichInputRecoveryDiagnostic;
	scrollNoopDiagnostic?: ScrollNoopDiagnostic;
	selectorTextVisibilityDiagnostics: SelectorTextVisibilityDiagnostic[];
	sessionMode: "auto" | "fresh";
	sessionTabCorrection?: OpenResultTabCorrection;
	sourceLookup?: AgentBrowserSourceLookupAnalysis;
	succeeded: boolean;
	timeoutPartialProgress?: TimeoutPartialProgress;
	userRequestedJson: boolean;
	visibleRefFallbackDiagnostic?: VisibleRefFallbackDiagnostic;
	visibleRefFallbackSessionName?: string;
}
