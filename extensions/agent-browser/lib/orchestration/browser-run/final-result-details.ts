import type { AgentBrowserNextAction } from "../../results/contracts.js";
import { formatSessionArtifactRetentionSummary } from "../../results/artifact-manifest.js";
import { alignPageChangeSummaryNextActionIds } from "../../results/next-actions.js";
import { sanitizeVisibleRefFallbackDiagnostic } from "../../results/selector-recovery.js";
import { buildElectronIdentifiers, buildSessionDetailFields } from "./session-state.js";
import { getReadSource } from "./final-result-evidence.js";
import type {
	PublicationInput as FinalResultInput,
	PublicationLifecycle as AgentBrowserLifecycle,
	PublicationWindow as AgentBrowserWindow,
} from "./final-result-contracts.js";

function compiledRequestDetails(
	options: Pick<
		FinalResultInput,
		| "redactedArgs"
		| "redactedCompiledElectron"
		| "redactedCompiledJob"
		| "redactedCompiledQaPreset"
		| "redactedCompiledSourceLookup"
		| "redactedCompiledNetworkSourceLookup"
		| "redactedCompiledSemanticAction"
		| "compatibilityWorkaround"
		| "redactedProcessArgs"
	>,
): Record<string, unknown> {
	return {
		args: options.redactedArgs,
		compiledElectron: options.redactedCompiledElectron,
		compiledJob: options.redactedCompiledJob,
		compiledQaPreset: options.redactedCompiledQaPreset,
		compiledSourceLookup: options.redactedCompiledSourceLookup,
		compiledNetworkSourceLookup: options.redactedCompiledNetworkSourceLookup,
		compiledSemanticAction: options.redactedCompiledSemanticAction,
		compatibilityWorkaround: options.compatibilityWorkaround,
		effectiveArgs: options.redactedProcessArgs,
	};
}

function artifactDetails(
	options: Pick<
		FinalResultInput,
		"resultArtifactManifest" | "presentation" | "artifactCleanup" | "parseFailureOutput"
	>,
): Record<string, unknown> {
	const presentation = options.presentation;
	return {
		artifactManifest: options.resultArtifactManifest,
		artifactRetentionSummary:
			presentation.artifactRetentionSummary ??
			(options.resultArtifactManifest
				? formatSessionArtifactRetentionSummary(options.resultArtifactManifest)
				: undefined),
		artifactCleanup: options.artifactCleanup,
		artifactVerification: presentation.artifactVerification,
		artifacts: presentation.artifacts,
		fullOutputPath: options.parseFailureOutput.fullOutputPath ?? presentation.fullOutputPath,
		fullOutputPaths: presentation.fullOutputPaths,
		fullOutputUnavailable: options.parseFailureOutput.fullOutputUnavailable,
		imagePath: presentation.imagePath,
		imagePaths: presentation.imagePaths,
		imageObservations: presentation.imageObservations,
		savedFile: presentation.savedFile,
		savedFilePath: presentation.savedFilePath,
	};
}

function nativeObservationDetails(
	options: Pick<
		FinalResultInput,
		| "presentation"
		| "presentationEnvelope"
		| "plainTextInspection"
		| "parseError"
		| "processResult"
		| "inspectionText"
		| "executionPlan"
	>,
	lifecycle: AgentBrowserLifecycle | undefined,
	browserWindow: AgentBrowserWindow | undefined,
): Record<string, unknown> {
	return {
		batchFailure: options.presentation.batchFailure,
		batchSteps: options.presentation.batchSteps,
		command: options.executionPlan.commandInfo.command,
		subcommand: options.executionPlan.commandInfo.subcommand,
		data: options.presentation.data,
		error: options.plainTextInspection ? undefined : options.presentationEnvelope?.error,
		inspection: options.plainTextInspection || undefined,
		agentBrowserStarted: options.processResult.agentBrowserStarted,
		browserWindow,
		lifecycle,
		readSource: getReadSource(options),
		recordingRecovery: options.presentation.recordingRecovery,
		readConfirmation: options.presentation.readConfirmation,
		exitCode: options.processResult.exitCode,
		exitSignal: options.processResult.exitSignal,
		parseError: options.plainTextInspection ? undefined : options.parseError,
		stderr: options.processResult.stderr,
		stdout: options.plainTextInspection ? (options.inspectionText ?? "") : undefined,
		summary: options.presentation.summary,
		timedOut: options.processResult.timedOut || undefined,
		timeoutMs: options.processResult.timeoutMs,
	};
}

function sessionEvidenceDetails(
	options: Pick<
		FinalResultInput,
		| "executionPlan"
		| "managedSessionHeadedAutosaveDisabled"
		| "managedSessionHeadedAutosaveInterval"
		| "managedSessionOutcome"
		| "managedSessionRestoreDisabled"
		| "sessionMode"
		| "sessionTabCorrection"
		| "currentSessionTabTarget"
		| "currentSessionTabTargetUnknown"
		| "currentRefSnapshot"
		| "currentRefSnapshotInvalidation"
		| "redactedRecoveryHint"
		| "aboutBlankSessionMismatch"
		| "openResultTabCorrection"
		| "navigationSummary"
	>,
): Record<string, unknown> {
	return {
		managedSessionHeadedAutosaveDisabled: options.managedSessionHeadedAutosaveDisabled,
		managedSessionHeadedAutosaveInterval: options.managedSessionHeadedAutosaveInterval,
		managedSessionOutcome: options.managedSessionOutcome,
		sessionMode: options.sessionMode,
		sessionTabCorrection: options.sessionTabCorrection,
		sessionTabTarget: options.currentSessionTabTarget,
		sessionTabTargetUnknown: options.currentSessionTabTargetUnknown,
		refSnapshot: options.currentRefSnapshot,
		refSnapshotInvalidation: options.currentRefSnapshotInvalidation,
		namespace: options.executionPlan.namespace,
		...buildSessionDetailFields(
			options.executionPlan.sessionName,
			options.executionPlan.usedImplicitSession,
			options.executionPlan.namespace,
			options.managedSessionRestoreDisabled,
		),
		sessionRecoveryHint: options.redactedRecoveryHint,
		startupScopedFlags: options.executionPlan.startupScopedFlags,
		aboutBlankSessionMismatch: options.aboutBlankSessionMismatch,
		openResultTabCorrection: options.openResultTabCorrection,
		navigationSummary: options.navigationSummary,
	};
}

function electronEvidenceDetails(
	options: Pick<
		FinalResultInput,
		| "electronLaunchRecord"
		| "electronFailedConnectCleanup"
		| "electronHandoff"
		| "electronProfileIsolationDetails"
		| "succeeded"
		| "electronLaunch"
		| "electronPostCommandHealth"
		| "electronRefFreshnessDiagnostic"
		| "electronSessionMismatch"
		| "electronBroadGetTextScopeDiagnostics"
	>,
): Record<string, unknown> {
	return {
		electron: options.electronLaunchRecord
			? {
					action: "launch",
					cleanup: options.electronFailedConnectCleanup,
					handoff: options.electronHandoff,
					identifiers: buildElectronIdentifiers(options.electronLaunchRecord),
					launch: options.electronLaunchRecord,
					profileIsolation: options.electronProfileIsolationDetails,
					status: options.succeeded ? "succeeded" : "failed",
					targets: options.electronLaunch?.targets,
					version: options.electronLaunch?.version,
				}
			: undefined,
		electronPostCommandHealth: options.electronPostCommandHealth,
		electronRefFreshness: options.electronRefFreshnessDiagnostic,
		electronSessionMismatch: options.electronSessionMismatch,
		electronGetTextScopeWarning: options.electronBroadGetTextScopeDiagnostics[0],
		electronGetTextScopeWarnings:
			options.electronBroadGetTextScopeDiagnostics.length > 1
				? options.electronBroadGetTextScopeDiagnostics
				: undefined,
	};
}

function interactionEvidenceDetails(
	options: Pick<
		FinalResultInput,
		| "clickDispatchDiagnostic"
		| "overlayBlockerDiagnostic"
		| "fillVerificationDiagnostic"
		| "visibleRefFallbackDiagnostic"
		| "richInputRecoveryDiagnostic"
		| "comboboxFocusDiagnostic"
		| "recordingDependencyWarning"
		| "scrollNoopDiagnostic"
		| "selectorTextVisibilityDiagnostics"
		| "evalStdinHint"
		| "evalResultWarning"
		| "timeoutPartialProgress"
	>,
): Record<string, unknown> {
	return {
		clickDispatch: options.clickDispatchDiagnostic,
		overlayBlockers: options.overlayBlockerDiagnostic,
		fillVerification: options.fillVerificationDiagnostic,
		visibleRefFallback: options.visibleRefFallbackDiagnostic
			? sanitizeVisibleRefFallbackDiagnostic(options.visibleRefFallbackDiagnostic)
			: undefined,
		richInputRecovery: options.richInputRecoveryDiagnostic,
		comboboxFocus: options.comboboxFocusDiagnostic,
		recordingDependencyWarning: options.recordingDependencyWarning,
		scrollNoop: options.scrollNoopDiagnostic,
		selectorTextVisibility: options.selectorTextVisibilityDiagnostics[0],
		selectorTextVisibilityAll:
			options.selectorTextVisibilityDiagnostics.length > 1
				? options.selectorTextVisibilityDiagnostics
				: undefined,
		evalStdinHint: options.evalStdinHint,
		evalResultWarning: options.evalResultWarning,
		timeoutPartialProgress: options.timeoutPartialProgress,
	};
}

function pageChangeSummary(
	options: Pick<
		FinalResultInput,
		"presentation" | "scrollNoopDiagnostic" | "comboboxFocusDiagnostic"
	>,
	nextActions: readonly AgentBrowserNextAction[] | undefined,
): FinalResultInput["presentation"]["pageChangeSummary"] {
	const rawSummary =
		(options.scrollNoopDiagnostic || options.comboboxFocusDiagnostic) &&
		options.presentation.pageChangeSummary
			? {
					...options.presentation.pageChangeSummary,
					nextActionIds: nextActions?.map((action) => action.id),
				}
			: options.presentation.pageChangeSummary;
	return alignPageChangeSummaryNextActionIds(rawSummary, nextActions);
}

export function buildAgentBrowserResultDetails(
	options: Omit<FinalResultInput, "electronLaunchRecords">,
	nextActions: readonly AgentBrowserNextAction[] | undefined,
	lifecycle: AgentBrowserLifecycle | undefined,
	browserWindow: AgentBrowserWindow | undefined,
): Record<string, unknown> {
	return {
		...compiledRequestDetails(options),
		...artifactDetails(options),
		...nativeObservationDetails(options, lifecycle, browserWindow),
		...options.categoryDetails,
		...sessionEvidenceDetails(options),
		...electronEvidenceDetails(options),
		...interactionEvidenceDetails(options),
		nextActions,
		pageChangeSummary: pageChangeSummary(options, nextActions),
		qaPreset: options.qaPreset,
		qaAttachedTarget: options.qaAttachedTarget,
		sourceLookup: options.sourceLookup,
		networkSourceLookup: options.networkSourceLookup,
		networkRouteDiagnostics: options.presentation.networkRouteDiagnostics,
	};
}
