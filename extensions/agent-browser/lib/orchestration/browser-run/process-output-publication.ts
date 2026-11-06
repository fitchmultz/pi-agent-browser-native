import type {
	PublicationOutputPhase,
	PublicationOutputEvidence,
} from "./process-output-publication-phase-contracts.js";
import type { NativeOutputEvidence } from "./process-output-native-phase-contracts.js";
import type { PageOutputEvidence } from "./process-output-page-phase-contracts.js";
import type { LifecycleOutputEvidence } from "./process-output-lifecycle-phase-contracts.js";
import type { ToolPresentationObservation } from "../../results/presentation/observation-contracts.js";
import { buildOutputStatePatch } from "./process-output-ownership.js";
import { isRecordPageTransitionCommand } from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import { extractUpstreamCommandTokens } from "../../argv-descriptor.js";
import {
	buildAboutBlankWarning,
	formatElectronPostCommandHealthText,
	formatElectronSessionMismatchText,
} from "./session-state.js";
import { getArtifactCleanupGuidance } from "./diagnostics.js";
import {
	buildFinalAgentBrowserToolResult,
	buildRedactedPresentationContent,
	prepareFinalResultRecoveryState,
} from "./final-result.js";
import type {
	ProcessBrowserOutputInput,
	PreparedBrowserRun,
	BrowserRunState,
	BrowserProcessOutputResult,
	FinalRecoveryState,
	AgentBrowserToolResult,
} from "./types.js";
import type { PublicationInput as FinalResultInput } from "./final-result-contracts.js";

type RecordingPageWarningInput = { readonly presentation: ToolPresentationObservation } & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
	};
};
type SessionWarningInput = Readonly<
	Pick<
		PublicationOutputPhase,
		"aboutBlankSessionMismatch" | "electronPostCommandHealth" | "electronSessionMismatch"
	>
>;
type CollectPublicationWarningsInput = Readonly<
	Pick<
		PublicationOutputPhase,
		| "aboutBlankSessionMismatch"
		| "artifactManifest"
		| "electronPostCommandHealth"
		| "electronSessionMismatch"
		| "plainTextInspection"
		| "presentationEnvelope"
		| "succeeded"
	>
> & {
	readonly presentation: ToolPresentationObservation;
	readonly input: Readonly<
		Pick<ProcessBrowserOutputInput, "cwd" | "modelVisible" | "processResult">
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				"commandTokens" | "exactSensitiveValues" | "executionPlan" | "userRequestedJson"
			>
		>;
	};
};
type RecoverFinalOutputInput = Readonly<
	Pick<
		PublicationOutputPhase,
		| "aboutBlankSessionMismatch"
		| "batchRefSnapshotState"
		| "currentSessionTabTarget"
		| "electronPostCommandHealth"
		| "errorText"
		| "parseError"
		| "plainTextInspection"
		| "sessionTabCorrection"
		| "succeeded"
	>
> &
	Pick<PublicationOutputPhase, "currentRefSnapshot" | "currentRefSnapshotInvalidation"> & {
		readonly presentation: ToolPresentationObservation;
		readonly input: Readonly<
			Pick<ProcessBrowserOutputInput, "cwd" | "processResult" | "sessionPageStateUpdate" | "signal">
		> & {
			readonly prepared: Readonly<
				Pick<
					PreparedBrowserRun,
					| "commandTokens"
					| "compiledSemanticAction"
					| "executionPlan"
					| "redactedProcessArgs"
					| "runtimeToolArgs"
				>
			>;
			readonly state: BrowserRunState;
		};
	};
export interface BuildOutputResultInput {
	readonly input: Readonly<
		Pick<
			ProcessBrowserOutputInput,
			| "electronProfileIsolationDetails"
			| "modelVisible"
			| "preserveAttachedBrowserSession"
			| "processResult"
		>
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "commandTokens"
				| "compatibilityWorkaround"
				| "compiledNetworkSourceLookup"
				| "compiledSemanticAction"
				| "electronLaunch"
				| "exactSensitiveValues"
				| "executionPlan"
				| "headedLaunch"
				| "ownedManagedSessionContext"
				| "priorSessionTabTarget"
				| "providerLaunch"
				| "redactedArgs"
				| "redactedCompiledElectron"
				| "redactedCompiledJob"
				| "redactedCompiledNetworkSourceLookup"
				| "redactedCompiledQaPreset"
				| "redactedCompiledSemanticAction"
				| "redactedCompiledSourceLookup"
				| "redactedProcessArgs"
				| "redactedRecoveryHint"
				| "sessionMode"
				| "userRequestedJson"
			>
		>;
		readonly state: BrowserRunState;
	};
	readonly native: NativeOutputEvidence;
	readonly page: PageOutputEvidence;
	readonly lifecycle: LifecycleOutputEvidence;
	readonly publication: PublicationOutputEvidence;
}
type ElectronResultEvidenceInput = Readonly<
	Pick<BuildOutputResultInput, "input" | "page" | "lifecycle">
>;
type InvocationResultEvidenceInput = Readonly<
	Pick<BuildOutputResultInput, "input" | "publication">
>;
type AttachCloseAllReceiptInput = Readonly<Pick<LifecycleOutputEvidence, "closeAllApplied">>;

function recordingPageWarning(draft: RecordingPageWarningInput): string | undefined {
	const reached =
		draft.input.prepared.executionPlan.commandInfo.command === "batch"
			? draft.presentation.batchSteps?.some((step) =>
					isRecordPageTransitionCommand(extractUpstreamCommandTokens(step.command ?? [])),
				) === true
			: isRecordPageTransitionCommand(draft.input.prepared.commandTokens);
	if (
		!draft.input.processResult.agentBrowserStarted ||
		draft.input.prepared.executionPlan.plainTextInspection ||
		!reached
	) {
		return;
	}
	return "Page state: this wrapper conservatively invalidates earlier refs after recording starts and URL-bearing restarts. Take a fresh snapshot before continuing; this does not prove the page changed.";
}

function sessionWarning(draft: SessionWarningInput): string | undefined {
	if (draft.electronPostCommandHealth) {
		return formatElectronPostCommandHealthText(draft.electronPostCommandHealth);
	}
	if (draft.electronSessionMismatch) {
		return formatElectronSessionMismatchText(draft.electronSessionMismatch);
	}
	return draft.aboutBlankSessionMismatch
		? buildAboutBlankWarning(draft.aboutBlankSessionMismatch)
		: undefined;
}

export async function collectPublicationWarnings(
	draft: CollectPublicationWarningsInput,
): Promise<
	Pick<PublicationOutputPhase, "artifactCleanup" | "redactedContent" | "resultArtifactManifest">
> {
	const resultArtifactManifest = draft.presentation.artifactManifest ?? draft.artifactManifest;
	const artifactCleanup = await getArtifactCleanupGuidance({
		command: draft.input.prepared.executionPlan.commandInfo.command,
		cwd: draft.input.cwd,
		manifest: resultArtifactManifest,
		succeeded: draft.succeeded,
	});
	const warnings = [sessionWarning(draft), recordingPageWarning(draft)]
		.filter((part) => part !== undefined && part.length > 0)
		.join("\n\n");
	const redactedContent =
		draft.input.modelVisible === false
			? []
			: buildRedactedPresentationContent({
					exactSensitiveValues: draft.input.prepared.exactSensitiveValues,
					plainTextInspection: draft.plainTextInspection,
					presentation: draft.presentation,
					presentationEnvelope: draft.presentationEnvelope,
					succeeded: draft.succeeded,
					userRequestedJson: draft.input.prepared.userRequestedJson,
					warningText: warnings.length > 0 ? warnings : undefined,
				});
	return { artifactCleanup, redactedContent, resultArtifactManifest };
}

export async function recoverFinalOutput(
	draft: RecoverFinalOutputInput,
): Promise<FinalRecoveryState> {
	const recovery = await prepareFinalResultRecoveryState({
		aboutBlankSessionMismatch: draft.aboutBlankSessionMismatch,
		batchRefSnapshotState: draft.batchRefSnapshotState,
		commandTokens: draft.input.prepared.commandTokens,
		compiledSemanticAction: draft.input.prepared.compiledSemanticAction,
		currentRefSnapshot: draft.currentRefSnapshot,
		currentRefSnapshotInvalidation: draft.currentRefSnapshotInvalidation,
		currentSessionTabTarget: draft.currentSessionTabTarget,
		cwd: draft.input.cwd,
		electronPostCommandHealth: draft.electronPostCommandHealth,
		errorText: draft.errorText,
		executionPlan: draft.input.prepared.executionPlan,
		parseError: draft.parseError,
		plainTextInspection: draft.plainTextInspection,
		presentation: draft.presentation,
		processResult: draft.input.processResult,
		redactedProcessArgs: draft.input.prepared.redactedProcessArgs,
		runtimeToolArgs: draft.input.prepared.runtimeToolArgs,
		sessionPageState: draft.input.state.sessionPageState,
		sessionPageStateUpdate: draft.input.sessionPageStateUpdate,
		sessionTabCorrection: draft.sessionTabCorrection,
		signal: draft.input.signal,
		succeeded: draft.succeeded,
	});
	return recovery;
}

export function buildOutputResult(
	sources: BuildOutputResultInput,
	recovery: FinalRecoveryState,
): BrowserProcessOutputResult {
	const { input, native, page, lifecycle, publication } = sources;
	const result = buildFinalAgentBrowserToolResult({
		modelVisible: input.modelVisible,
		aboutBlankSessionMismatch: lifecycle.aboutBlankSessionMismatch,
		artifactCleanup: publication.artifactCleanup,
		categoryDetails: recovery.categoryDetails,
		clickDispatchDiagnostic: page.clickDispatchDiagnostic,
		commandTokens: input.prepared.commandTokens,
		comboboxFocusDiagnostic: page.diagnostics.comboboxFocusDiagnostic,
		compiledNetworkSourceLookup: input.prepared.compiledNetworkSourceLookup,
		compiledSemanticAction: input.prepared.compiledSemanticAction,
		compatibilityWorkaround: input.prepared.compatibilityWorkaround,
		currentRefSnapshot: input.modelVisible === false ? undefined : publication.currentRefSnapshot,
		currentRefSnapshotInvalidation: publication.currentRefSnapshotInvalidation,
		currentSessionTabTarget: publication.currentSessionTabTarget,
		currentSessionTabTargetUnknown: publication.currentSessionTabTargetUnknown,
		...electronResultEvidence(sources),
		...invocationResultEvidence(sources),
		...launchResultEvidence(sources),
		errorText: lifecycle.errorText,
		evalResultWarning: publication.evalResultWarning,
		evalStdinHint: publication.evalStdinHint,
		exactSensitiveValues: input.prepared.exactSensitiveValues,
		executionPlan: input.prepared.executionPlan,
		fillVerificationDiagnostic: page.diagnostics.fillVerificationDiagnostic,
		inspectionText: native.inspectionText,
		navigationSummary: page.navigationSummary,
		networkSourceLookup: publication.networkSourceLookup,
		noActivePageSnapshotFailure: recovery.noActivePageSnapshotFailure,
		openResultTabCorrection: lifecycle.openResultTabCorrection,
		overlayBlockerDiagnostic: page.diagnostics.overlayBlockerDiagnostic,
		parseError: lifecycle.parseError,
		parseFailureOutput: native.parseFailureOutput,
		parseSucceeded: lifecycle.parseSucceeded,
		plainTextInspection: lifecycle.plainTextInspection,
		presentation: publication.presentation,
		presentationEnvelope: publication.presentationEnvelope,
		priorSessionTabTarget: input.prepared.priorSessionTabTarget,
		processResult: input.processResult,
		qaAttachedTarget: publication.qaAttachedTarget,
		qaPreset: publication.qaPreset,
		recordingDependencyWarning: page.diagnostics.recordingDependencyWarning,
		resultArtifactManifest: publication.resultArtifactManifest,
		richInputRecoveryDiagnostic: recovery.richInputRecoveryDiagnostic,
		scrollNoopDiagnostic: page.diagnostics.scrollNoopDiagnostic,
		selectorTextVisibilityDiagnostics: page.diagnostics.selectorTextVisibilityDiagnostics,
		sessionMode: input.prepared.sessionMode,
		sessionTabCorrection: lifecycle.sessionTabCorrection,
		sourceLookup: publication.sourceLookup,
		succeeded: publication.succeeded,
		timeoutPartialProgress: lifecycle.timeoutPartialProgress,
		unsettledWebMcpMutation: page.unsettledWebMcpMutation,
		userRequestedJson: input.prepared.userRequestedJson,
		visibleRefFallbackDiagnostic: recovery.visibleRefFallbackDiagnostic,
		visibleRefFallbackSessionName: recovery.visibleRefFallbackSessionName,
	});
	const resultWithCloseAll = attachCloseAllReceipt(lifecycle, result);
	const statePatch = buildOutputStatePatch({
		...lifecycle,
		artifactManifest: publication.artifactManifest,
		networkRoutesBySession: publication.networkRoutesBySession,
	});
	return { result: resultWithCloseAll, statePatch };
}

function launchResultEvidence(
	sources: Readonly<Pick<BuildOutputResultInput, "input" | "lifecycle" | "publication">>,
): Pick<
	FinalResultInput,
	| "headedLaunch"
	| "preserveAttachedBrowserSession"
	| "providerLaunch"
	| "managedSessionHeadedAutosaveDisabled"
	| "managedSessionHeadedAutosaveInterval"
	| "managedSessionOutcome"
	| "managedSessionRestoreDisabled"
> {
	const { input, lifecycle, publication } = sources;
	return {
		headedLaunch: input.prepared.headedLaunch,
		preserveAttachedBrowserSession: input.preserveAttachedBrowserSession === true,
		providerLaunch: input.prepared.providerLaunch,
		managedSessionHeadedAutosaveDisabled:
			(!(input.prepared.ownedManagedSessionContext?.reuseOnly === true) &&
				lifecycle.resultHeadedManagedAutosaveDisabled) ||
			undefined,
		managedSessionHeadedAutosaveInterval:
			input.prepared.ownedManagedSessionContext?.reuseOnly === true
				? undefined
				: lifecycle.resultHeadedManagedAutosaveInterval,
		managedSessionOutcome: publication.managedSessionOutcome,
		managedSessionRestoreDisabled: input.state.managedSessionRestoreState.isDisabled(
			input.prepared.executionPlan.sessionName,
			input.prepared.executionPlan.namespace,
		),
	};
}

type electronResultEvidence = Pick<
	FinalResultInput,
	| "electronBroadGetTextScopeDiagnostics"
	| "electronFailedConnectCleanup"
	| "electronHandoff"
	| "electronLaunch"
	| "electronLaunchRecord"
	| "electronLaunchRecords"
	| "electronPostCommandHealth"
	| "electronProfileIsolationDetails"
	| "electronRefFreshnessDiagnostic"
	| "electronSessionMismatch"
>;
function electronResultEvidence(sources: ElectronResultEvidenceInput): electronResultEvidence {
	const { input, page, lifecycle } = sources;
	return {
		electronBroadGetTextScopeDiagnostics: page.diagnostics.electronBroadGetTextScopeDiagnostics,
		electronFailedConnectCleanup: lifecycle.electronFailedConnectCleanup,
		electronHandoff: lifecycle.electronHandoff,
		electronLaunch: input.prepared.electronLaunch,
		electronLaunchRecord: lifecycle.electronLaunchRecord,
		electronLaunchRecords: input.state.electronLaunchRecords,
		electronPostCommandHealth: page.electronPostCommandHealth,
		electronProfileIsolationDetails: input.electronProfileIsolationDetails,
		electronRefFreshnessDiagnostic: page.diagnostics.electronRefFreshnessDiagnostic,
		electronSessionMismatch: page.electronSessionMismatch,
	};
}

type invocationResultEvidence = Pick<
	FinalResultInput,
	| "redactedArgs"
	| "redactedCompiledElectron"
	| "redactedCompiledJob"
	| "redactedCompiledNetworkSourceLookup"
	| "redactedCompiledQaPreset"
	| "redactedCompiledSemanticAction"
	| "redactedCompiledSourceLookup"
	| "redactedContent"
	| "redactedProcessArgs"
	| "redactedRecoveryHint"
>;
function invocationResultEvidence(
	sources: InvocationResultEvidenceInput,
): invocationResultEvidence {
	const { input, publication } = sources;
	return {
		redactedArgs: input.prepared.redactedArgs,
		redactedCompiledElectron: input.prepared.redactedCompiledElectron,
		redactedCompiledJob: input.prepared.redactedCompiledJob,
		redactedCompiledNetworkSourceLookup: input.prepared.redactedCompiledNetworkSourceLookup,
		redactedCompiledQaPreset: input.prepared.redactedCompiledQaPreset,
		redactedCompiledSemanticAction: input.prepared.redactedCompiledSemanticAction,
		redactedCompiledSourceLookup: input.prepared.redactedCompiledSourceLookup,
		redactedContent: publication.redactedContent,
		redactedProcessArgs: input.prepared.redactedProcessArgs,
		redactedRecoveryHint: input.prepared.redactedRecoveryHint,
	};
}

function attachCloseAllReceipt(
	draft: AttachCloseAllReceiptInput,
	result: AgentBrowserToolResult,
): AgentBrowserToolResult {
	return draft.closeAllApplied
		? {
				...result,
				details: { ...(isRecord(result.details) ? result.details : {}), closeAllApplied: true },
			}
		: result;
}
