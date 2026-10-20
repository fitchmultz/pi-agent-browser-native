import type {
	ResolveOutputErrorInput,
	RenderNativePresentationInput,
	ReclassifyPresentationInput,
	ResolveNativeErrorTextInput,
	ApplyErrorEnvelopeFallbackInput,
	RedactClipboardErrorInput,
	ApplyTextErrorEnvelopeInput,
	ObserveResultLaunchPolicyInput,
	ClassifyMalformedNativeFailureInput,
	RenderPresentationConfirmationInput,
	RenderUpgradeFailureInput,
	ReclassifyScrollNoopInput,
	RenderParseFailureArtifactsInput,
	RenderPendingHelperConfirmationInput,
	InspectionPresentationInput,
	PreviousContactSheetPathInput,
	PresentationCleanupOwnershipInput,
	BuildNativePresentationInput,
	PreparedSessionRetainedInput,
	RenderParseFailureNoticeInput,
	ApplyBatchNetworkRouteStateInput,
} from "./process-output-presentation-contracts.js";
import { isStringArray } from "../../results/presentation/content.js";
import type { ToolPresentation } from "../../results/contracts.js";
import {
	type ReadConfirmation,
	buildReadConfirmationNextActions,
} from "../../read-confirmation.js";
import { isCloseCommand } from "../../command-taxonomy.js";
import { applyNetworkRouteRecords } from "../../results/network-routes.js";
import { buildToolPresentation } from "../../results/presentation.js";
import { compactLargePresentationOutput } from "../../results/presentation/large-output.js";
import { extractEnvelopeErrorText, getAgentBrowserErrorText } from "../../results/envelope.js";
import { detectConfirmationRequired } from "../../results/confirmation.js";
import { omitUpstreamLifecycle } from "../../results/presentation/common.js";
import {
	getClipboardWritePayloadCandidates,
	redactClipboardPermissionEcho,
	redactClipboardPermissionErrorValue,
} from "../../results/presentation/errors.js";
import { isRecord } from "../../parsing.js";
import { extractUpstreamCommandTokens } from "../../argv-descriptor.js";
import { getStaleRefArgs } from "./session-state.js";
import { mergeRecordingRecoveryPresentation } from "./recording-recovery.js";
import { buildWrapperRecoveryHint } from "./final-result.js";
import { setNetworkRouteState } from "./process-output-diagnostics.js";
export function resolveOutputError(draft: ResolveOutputErrorInput): void {
	resolveNativeErrorText(draft);
	applyErrorEnvelopeFallback(draft);
	redactClipboardError(draft);
	applyTextErrorEnvelope(draft);
	observeResultLaunchPolicy(draft);
}

export async function renderNativePresentation(
	draft: RenderNativePresentationInput,
): Promise<void> {
	draft.presentation = await buildNativePresentation(draft);
	if (draft.recordingStopRecovery) {
		draft.presentation = mergeRecordingRecoveryPresentation(
			draft.presentation,
			draft.recordingStopRecovery,
		);
	}
	classifyMalformedNativeFailure(draft);
	renderPresentationConfirmation(draft);
	await renderUpgradeFailure(draft);
	if (
		draft.electronHandoff?.error !== undefined &&
		draft.electronHandoff.error.length > 0 &&
		draft.electronHandoff.failureCategory !== undefined &&
		draft.electronHandoff.failureCategory.length > 0
	) {
		draft.presentation.failureCategory = draft.electronHandoff.failureCategory;
	}
}

export function reclassifyPresentation(draft: ReclassifyPresentationInput): void {
	applyBatchNetworkRouteState(draft);
	if (draft.presentation.resultCategory === "failure" && draft.succeeded) {
		draft.succeeded = false;
		draft.presentationEnvelope = {
			...draft.presentationEnvelope,
			error: draft.presentation.summary,
			success: false,
		};
	}
	reclassifyScrollNoop(draft);
	renderParseFailureArtifacts(draft);
}

function resolveNativeErrorText(draft: ResolveNativeErrorTextInput): void {
	draft.errorText =
		draft.recordingStopRecovery?.recovery.healed === true
			? undefined
			: getAgentBrowserErrorText({
					aborted: draft.input.processResult.aborted,
					command: draft.input.prepared.executionPlan.commandInfo.command,
					effectiveArgs: draft.input.prepared.redactedProcessArgs,
					envelope: draft.presentationEnvelope,
					exitCode: draft.input.processResult.exitCode,
					exitSignal: draft.input.processResult.exitSignal,
					parseError: draft.parseError,
					plainTextInspection: draft.plainTextInspection,
					staleRefArgs: getStaleRefArgs(
						draft.input.prepared.commandTokens,
						draft.input.prepared.runtimeToolStdin,
					),
					spawnError: draft.input.processResult.spawnError,
					stderr: draft.input.processResult.stderr,
					timedOut: draft.input.processResult.timedOut,
					timeoutMs: draft.input.processResult.timeoutMs,
					wrapperRecoveryHint: buildWrapperRecoveryHint({
						sessionTabCorrection: draft.sessionTabCorrection,
					}),
				});
}

function applyErrorEnvelopeFallback(draft: ApplyErrorEnvelopeFallbackInput): void {
	if (
		draft.errorText !== undefined &&
		draft.errorText.length > 0 &&
		draft.presentationEnvelope?.success === false &&
		extractEnvelopeErrorText(draft.presentationEnvelope.error) === undefined
	) {
		draft.presentationEnvelope = { ...draft.presentationEnvelope, error: draft.errorText };
	}
}

function redactClipboardError(draft: RedactClipboardErrorInput): void {
	if (draft.errorText !== undefined && draft.errorText.length > 0) {
		const clipboardWritePayloadCandidates = getClipboardWritePayloadCandidates(
			draft.input.prepared.commandTokens,
		);
		draft.errorText = redactClipboardPermissionEcho(
			draft.input.prepared.executionPlan.commandInfo,
			draft.errorText,
		);
		if (draft.presentationEnvelope?.error !== undefined) {
			draft.presentationEnvelope = {
				...draft.presentationEnvelope,
				error: redactClipboardPermissionErrorValue(
					draft.input.prepared.executionPlan.commandInfo,
					draft.presentationEnvelope.error,
					clipboardWritePayloadCandidates,
				),
			};
		}
	}
}

function applyTextErrorEnvelope(draft: ApplyTextErrorEnvelopeInput): void {
	if (
		(draft.plainTextUpgrade || draft.textOutput) &&
		draft.errorText !== undefined &&
		draft.errorText.length > 0
	) {
		draft.presentationEnvelope = {
			...draft.presentationEnvelope,
			success: false,
			error: draft.errorText,
		};
	}
}

function observeResultLaunchPolicy(draft: ObserveResultLaunchPolicyInput): void {
	const resultRetainsPreparedManagedSession = preparedSessionRetained(draft);
	draft.resultHeadedManagedAutosaveDisabled =
		draft.input.prepared.ownedManagedSessionContext?.headedManagedAutosaveDisabled === true &&
		resultRetainsPreparedManagedSession &&
		!(draft.commandClosesSession && draft.succeeded);
	draft.resultHeadedManagedAutosaveInterval =
		resultRetainsPreparedManagedSession && !(draft.commandClosesSession && draft.succeeded)
			? draft.input.prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval
			: undefined;
}

function classifyMalformedNativeFailure(draft: ClassifyMalformedNativeFailureInput): void {
	if (
		draft.parseError !== undefined &&
		draft.parseError.length > 0 &&
		draft.input.processResult.exitCode !== 0 &&
		!draft.input.processResult.timedOut &&
		!draft.input.processResult.aborted &&
		!draft.input.processResult.spawnError
	) {
		draft.presentation.failureCategory = "upstream-error";
	}
}

function renderPresentationConfirmation(draft: RenderPresentationConfirmationInput): void {
	const confirmation: ReadConfirmation | undefined =
		draft.readConfirmationEvent ?? draft.input.prepared.readConfirmation;
	if (confirmation) {
		draft.presentation.readConfirmation = confirmation;
		renderPendingHelperConfirmation(draft, confirmation);
		if (draft.readConfirmationEvent?.state === "pending") {
			draft.presentation.resultCategory = "failure";
			draft.presentation.failureCategory = "confirmation-required";
			draft.presentation.successCategory = undefined;
			if (draft.confirmationFromHelper) {
				draft.presentation.content.unshift({
					type: "text",
					text: `Native helper ${confirmation.command ?? "read"} requires confirmation (${confirmation.action ?? "read"}, ${confirmation.id}). The requested command's result, if dispatched, is preserved below.`,
				});
			}
		}
	}
}

async function renderUpgradeFailure(draft: RenderUpgradeFailureInput): Promise<void> {
	if (
		draft.plainTextUpgrade &&
		!draft.textOutput &&
		!draft.succeeded &&
		typeof draft.presentationEnvelope?.data === "string"
	) {
		draft.presentation.data = draft.presentationEnvelope.data;
		const errorContent = draft.presentation.content.at(0);
		if (errorContent?.type === "text" && draft.presentationEnvelope.data.length > 0) {
			errorContent.text += `\n\n${draft.presentationEnvelope.data}`;
		}
		if (draft.input.modelVisible !== false) {
			draft.presentation = await compactLargePresentationOutput({
				artifactManifest: draft.artifactManifest,
				commandInfo: draft.input.prepared.executionPlan.commandInfo,
				data: draft.presentation.data,
				persistentArtifactStore: draft.persistentArtifactStore,
				presentation: draft.presentation,
			});
		}
	}
}

function reclassifyScrollNoop(draft: ReclassifyScrollNoopInput): void {
	if (draft.diagnostics.scrollNoopDiagnostic) {
		draft.succeeded = false;
		draft.presentation.resultCategory = "failure";
		draft.presentation.failureCategory = "upstream-error";
		draft.presentationEnvelope = {
			...draft.presentationEnvelope,
			error: "Scroll completed with no observed movement.",
			success: false,
		};
		draft.presentation.summary = "Scroll completed with no observed movement.";
		if (isRecord(draft.presentation.data)) {
			draft.presentation.data = { ...draft.presentation.data, noMovement: true, scrolled: false };
		}
		if (draft.presentation.content[0]?.type === "text") {
			const details = isRecord(draft.presentation.data)
				? JSON.stringify(omitUpstreamLifecycle(draft.presentation.data), null, 2)
				: draft.presentation.content[0].text;
			draft.presentation.content[0] = {
				...draft.presentation.content[0],
				text: `Scroll completed with no observed movement.\n\n${details}`,
			};
		} else {
			draft.presentation.content.unshift({
				type: "text",
				text: "Scroll completed with no observed movement.",
			});
		}
	}
}

function renderParseFailureArtifacts(draft: RenderParseFailureArtifactsInput): void {
	if (draft.parseFailureOutput.artifactManifest) {
		draft.presentation.artifactManifest = draft.parseFailureOutput.artifactManifest;
		draft.presentation.artifactRetentionSummary = draft.parseFailureOutput.artifactRetentionSummary;
	}
	renderParseFailureNotice(draft);
	if (draft.presentation.artifactManifest) {
		draft.artifactManifest = draft.presentation.artifactManifest;
	}
}

function renderPendingHelperConfirmation(
	draft: RenderPendingHelperConfirmationInput,
	confirmation: ReadConfirmation,
): void {
	if (
		confirmation.state !== "cleared" ||
		!detectConfirmationRequired(draft.presentationEnvelope?.data)
	) {
		draft.presentation.nextActions = buildReadConfirmationNextActions(
			confirmation,
			draft.readConfirmationEvent?.state === "pending",
		);
	}
}

function inspectionPresentation(draft: InspectionPresentationInput): ToolPresentation {
	return {
		artifacts: undefined,
		batchFailure: undefined,
		batchSteps: undefined,
		content: [{ type: "text", text: draft.inspectionText ?? "" }],
		data: undefined,
		fullOutputPath: undefined,
		fullOutputPaths: undefined,
		imagePath: undefined,
		imagePaths: undefined,
		savedFile: undefined,
		savedFilePath: undefined,
		summary: `${draft.input.prepared.redactedArgs.join(" ")} completed`,
	};
}
function previousContactSheetPath(draft: PreviousContactSheetPathInput): string | undefined {
	const key = draft.sessionStateKey;
	return key !== undefined && key.length > 0
		? draft.input.state.activeRecordingReservations?.get(key)?.contactSheetPath
		: undefined;
}
function presentationCleanupOwnership(
	draft: PresentationCleanupOwnershipInput,
): "wrapper-managed" | "caller-owned" {
	const key = draft.sessionStateKey;
	return key !== undefined &&
		key.length > 0 &&
		(draft.input.state.ownedManagedSessions.has(key) ||
			draft.input.prepared.executionPlan.managedSessionName !== undefined)
		? "wrapper-managed"
		: "caller-owned";
}
async function buildNativePresentation(
	draft: BuildNativePresentationInput,
): Promise<ToolPresentation> {
	if (draft.plainTextInspection) {
		return inspectionPresentation(draft);
	}
	if (draft.recordingStopRecovery && !draft.recordingStopRecovery.batch) {
		return draft.recordingStopRecovery.presentation;
	}
	return buildToolPresentation({
		textOutput: draft.textOutput,
		stdin: draft.input.prepared.processStdin,
		modelVisible: draft.input.modelVisible,
		args: draft.input.prepared.redactedProcessArgs,
		artifactManifest: draft.artifactManifest,
		artifactMaxUpdatedAtMs: Date.now(),
		artifactMinUpdatedAtMs: draft.input.artifactRunStartedAtMs,
		artifactRequest: draft.screenshotArtifactRequest,
		batchArtifactRequests: draft.batchScreenshotArtifactRequests,
		commandInfo: {
			...draft.input.prepared.executionPlan.commandInfo,
			commandTokens: draft.input.prepared.commandTokens,
		},
		compiledSemanticAction: draft.input.prepared.compiledSemanticAction,
		cwd: draft.operationCwd,
		envelope: draft.presentationEnvelope,
		errorText: draft.errorText,
		namespace: draft.input.prepared.executionPlan.namespace,
		networkRouteDiagnostics: draft.diagnostics.networkRouteDiagnostics,
		networkRoutes: draft.activeNetworkRoutes,
		persistentArtifactStore: draft.persistentArtifactStore,
		previousRecordingContactSheetPath: previousContactSheetPath(draft),
		piCleanupOwnership: presentationCleanupOwnership(draft),
		sessionName: draft.input.prepared.executionPlan.sessionName,
	});
}

function preparedSessionRetained(draft: PreparedSessionRetainedInput): boolean {
	return (
		!draft.managedSessionOutcome ||
		(draft.managedSessionOutcome.activeAfter &&
			draft.managedSessionOutcome.attemptedSessionName ===
				draft.managedSessionOutcome.currentSessionName)
	);
}

function renderParseFailureNotice(draft: RenderParseFailureNoticeInput): void {
	const path = draft.parseFailureOutput.fullOutputPath ?? "";
	const unavailable = draft.parseFailureOutput.fullOutputUnavailable ?? "";
	if (path.length === 0 && unavailable.length === 0) {
		return;
	}
	const firstContent = draft.presentation.content.at(0);
	const existingText = firstContent?.type === "text" ? firstContent.text : "";
	const noticeLines = [
		path.length > 0 ? `Full output path: ${path}` : `Full raw output unavailable: ${unavailable}`,
		draft.parseFailureOutput.artifactRetentionSummary,
	].filter((item): item is string => item !== undefined);
	const notice = noticeLines.join("\n");
	draft.presentation.content[0] = {
		type: "text",
		text: existingText.length > 0 ? `${existingText}\n\n${notice}` : notice,
	};
}

function batchRouteEffect(
	item: unknown,
): { readonly tokens: readonly string[]; readonly succeeded: boolean } | undefined {
	if (!isRecord(item) || !isStringArray(item.command)) {
		return;
	}
	return {
		tokens: extractUpstreamCommandTokens(item.command),
		succeeded: item.success !== false && !detectConfirmationRequired(item.result),
	};
}
function applyBatchNetworkRouteState(draft: ApplyBatchNetworkRouteStateInput): void {
	const key = draft.sessionStateKey;
	const data: unknown = draft.presentationEnvelope?.data;
	if (!draft.succeeded || key === undefined || key.length === 0 || !Array.isArray(data)) {
		return;
	}
	let routes = draft.networkRoutesBySession.get(key);
	for (const item of data) {
		const effect = batchRouteEffect(item);
		if (!effect) {
			continue;
		}
		routes =
			effect.succeeded && isCloseCommand(effect.tokens[0])
				? undefined
				: applyNetworkRouteRecords(routes, effect.tokens, effect.succeeded);
	}
	draft.networkRoutesBySession = setNetworkRouteState({
		routes,
		routesBySession: draft.networkRoutesBySession,
		sessionName: key,
	});
}
