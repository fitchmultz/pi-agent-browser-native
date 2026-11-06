import type { ProcessBrowserOutputInput, PreparedBrowserRun, BrowserRunState } from "./types.js";
import type { PublicationOutputPhase } from "./process-output-publication-phase-contracts.js";
import type { ToolPresentationObservation } from "../../results/presentation/observation-contracts.js";
export type RenderNativePresentationInput = Readonly<
	Pick<
		PublicationOutputPhase,
		| "activeNetworkRoutes"
		| "artifactManifest"
		| "batchScreenshotArtifactRequests"
		| "confirmationFromHelper"
		| "electronHandoff"
		| "errorText"
		| "inspectionText"
		| "diagnostics"
		| "operationCwd"
		| "parseError"
		| "persistentArtifactStore"
		| "plainTextInspection"
		| "plainTextUpgrade"
		| "presentationEnvelope"
		| "readConfirmationEvent"
		| "recordingStopRecovery"
		| "screenshotArtifactRequest"
		| "sessionStateKey"
		| "succeeded"
		| "textOutput"
	>
> & {
	readonly input: Readonly<
		Pick<ProcessBrowserOutputInput, "artifactRunStartedAtMs" | "modelVisible" | "processResult">
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "commandTokens"
				| "compiledSemanticAction"
				| "executionPlan"
				| "processStdin"
				| "readConfirmation"
				| "redactedArgs"
				| "redactedProcessArgs"
			>
		>;
	} & { readonly state: BrowserRunState };
};
export type ReclassifyPresentationInput = Readonly<
	Pick<
		PublicationOutputPhase,
		| "parseFailureOutput"
		| "diagnostics"
		| "sessionStateKey"
		| "artifactManifest"
		| "networkRoutesBySession"
		| "presentationEnvelope"
		| "succeeded"
	>
> & { readonly presentation: ToolPresentationObservation };
export type ClassifyMalformedNativeFailureInput = Readonly<
	Pick<PublicationOutputPhase, "parseError">
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">>;
};
export type RenderPresentationConfirmationInput = Readonly<
	Pick<
		PublicationOutputPhase,
		"confirmationFromHelper" | "presentationEnvelope" | "readConfirmationEvent"
	>
> & {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "readConfirmation">> };
};
export type RenderUpgradeFailureInput = Readonly<
	Pick<
		PublicationOutputPhase,
		"plainTextUpgrade" | "presentationEnvelope" | "succeeded" | "textOutput"
	>
>;
export type ReclassifyScrollNoopInput = Readonly<
	Pick<PublicationOutputPhase, "diagnostics" | "presentationEnvelope">
> & { readonly presentation: ToolPresentationObservation };
export type RenderParseFailureArtifactsInput = Readonly<
	Pick<PublicationOutputPhase, "parseFailureOutput" | "artifactManifest">
> & { readonly presentation: ToolPresentationObservation };
export type RenderPendingHelperConfirmationInput = Readonly<
	Pick<PublicationOutputPhase, "presentationEnvelope" | "readConfirmationEvent">
>;
export type InspectionPresentationInput = Readonly<
	Pick<PublicationOutputPhase, "inspectionText">
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "redactedArgs">> } };
export type PreviousContactSheetPathInput = Readonly<
	Pick<PublicationOutputPhase, "sessionStateKey">
> & { readonly input: { readonly state: BrowserRunState } };
export type PresentationCleanupOwnershipInput = Readonly<
	Pick<PublicationOutputPhase, "sessionStateKey">
> & {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "executionPlan">> } & {
		readonly state: BrowserRunState;
	};
};
export type BuildNativePresentationInput = Readonly<
	Pick<
		PublicationOutputPhase,
		| "activeNetworkRoutes"
		| "artifactManifest"
		| "batchScreenshotArtifactRequests"
		| "errorText"
		| "inspectionText"
		| "diagnostics"
		| "operationCwd"
		| "persistentArtifactStore"
		| "plainTextInspection"
		| "presentationEnvelope"
		| "recordingStopRecovery"
		| "screenshotArtifactRequest"
		| "sessionStateKey"
		| "textOutput"
	>
> & {
	readonly input: Readonly<
		Pick<ProcessBrowserOutputInput, "artifactRunStartedAtMs" | "modelVisible">
	> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "commandTokens"
				| "compiledSemanticAction"
				| "executionPlan"
				| "processStdin"
				| "redactedArgs"
				| "redactedProcessArgs"
			>
		>;
	} & { readonly state: BrowserRunState };
};
export type RenderParseFailureNoticeInput = Readonly<
	Pick<PublicationOutputPhase, "parseFailureOutput">
> & { readonly presentation: ToolPresentationObservation };
export type ApplyBatchNetworkRouteStateInput = Readonly<
	Pick<PublicationOutputPhase, "presentationEnvelope" | "sessionStateKey" | "succeeded">
> &
	Readonly<Pick<PublicationOutputPhase, "networkRoutesBySession">>;
