import type {
	RenderNativePresentationInput,
	ReclassifyPresentationInput,
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
	RenderParseFailureNoticeInput,
	ApplyBatchNetworkRouteStateInput,
} from "./process-output-presentation-contracts.js";
import type { PublicationOutputPhase } from "./process-output-publication-phase-contracts.js";
import type { ToolPresentationObservation } from "../../results/presentation/observation-contracts.js";
import { isStringArray } from "../../results/presentation/content.js";
import type { ToolPresentation } from "../../results/contracts.js";
import {
	type ReadConfirmation,
	buildReadConfirmationNextActions,
} from "../../read-confirmation.js";
import { applyBatchRowNetworkRouteRecords } from "../../results/network-routes.js";
import { buildToolPresentation } from "../../results/presentation.js";
import { compactLargePresentationOutput } from "../../results/presentation/large-output.js";
import { detectConfirmationRequired } from "../../results/confirmation.js";
import { omitUpstreamLifecycle } from "../../results/presentation/common.js";
import { isRecord } from "../../parsing.js";
import { extractUpstreamCommandTokens } from "../../argv-descriptor.js";
import { mergeRecordingRecoveryPresentation } from "./recording-recovery.js";
import { setNetworkRouteState } from "./process-output-diagnostics.js";
export async function renderNativePresentation(
	draft: RenderNativePresentationInput,
): Promise<ToolPresentation> {
	let presentation = await buildNativePresentation(draft);
	if (draft.recordingStopRecovery) {
		presentation = mergeRecordingRecoveryPresentation(presentation, draft.recordingStopRecovery);
	}
	Object.assign(presentation, classifyMalformedNativeFailure(draft));
	Object.assign(presentation, renderPresentationConfirmation(draft, presentation));
	const upgrade = renderUpgradeFailure(draft, presentation);
	if (upgrade) {
		Object.assign(presentation, upgrade);
		if (draft.input.modelVisible !== false) {
			Object.assign(
				presentation,
				await compactLargePresentationOutput({
					artifactManifest: draft.artifactManifest,
					commandInfo: draft.input.prepared.executionPlan.commandInfo,
					data: presentation.data,
					persistentArtifactStore: draft.persistentArtifactStore,
					presentation,
				}),
			);
		}
	}
	if (
		draft.electronHandoff?.error !== undefined &&
		draft.electronHandoff.error.length > 0 &&
		draft.electronHandoff.failureCategory !== undefined &&
		draft.electronHandoff.failureCategory.length > 0
	) {
		presentation.failureCategory = draft.electronHandoff.failureCategory;
	}
	return presentation;
}

type ReclassifiedOutput = Pick<
	PublicationOutputPhase,
	"networkRoutesBySession" | "succeeded" | "presentationEnvelope" | "artifactManifest"
> & {
	readonly presentationUpdate: Partial<
		Pick<
			ToolPresentation,
			| "resultCategory"
			| "failureCategory"
			| "summary"
			| "data"
			| "content"
			| "artifactManifest"
			| "artifactRetentionSummary"
		>
	>;
};

export function reclassifyPresentation(draft: ReclassifyPresentationInput): ReclassifiedOutput {
	const networkRoutesBySession = applyBatchNetworkRouteState(draft);
	let { succeeded, presentationEnvelope } = draft;
	if (draft.presentation.resultCategory === "failure" && succeeded) {
		succeeded = false;
		presentationEnvelope = {
			...presentationEnvelope,
			error: draft.presentation.summary,
			success: false,
		};
	}
	const scroll = reclassifyScrollNoop({
		diagnostics: draft.diagnostics,
		presentation: draft.presentation,
		presentationEnvelope,
	});
	if (scroll) {
		succeeded = scroll.succeeded;
		presentationEnvelope = scroll.presentationEnvelope;
	}
	const corrected = scroll
		? { ...draft.presentation, ...scroll.presentationUpdate }
		: draft.presentation;
	const artifacts = renderParseFailureArtifacts({
		artifactManifest: draft.artifactManifest,
		parseFailureOutput: draft.parseFailureOutput,
		presentation: corrected,
	});
	return {
		networkRoutesBySession,
		succeeded,
		presentationEnvelope,
		artifactManifest: artifacts.artifactManifest,
		presentationUpdate: { ...scroll?.presentationUpdate, ...artifacts.presentationUpdate },
	};
}

function classifyMalformedNativeFailure(
	draft: ClassifyMalformedNativeFailureInput,
): Pick<ToolPresentation, "failureCategory"> | undefined {
	if (
		draft.parseError !== undefined &&
		draft.parseError.length > 0 &&
		draft.input.processResult.exitCode !== 0 &&
		!draft.input.processResult.timedOut &&
		!draft.input.processResult.aborted &&
		!draft.input.processResult.spawnError
	) {
		return { failureCategory: "upstream-error" };
	}
	return;
}

function renderPresentationConfirmation(
	draft: RenderPresentationConfirmationInput,
	presentation: ToolPresentationObservation,
):
	| Partial<
			Pick<
				ToolPresentation,
				| "readConfirmation"
				| "nextActions"
				| "resultCategory"
				| "failureCategory"
				| "successCategory"
				| "content"
			>
	  >
	| undefined {
	const confirmation = draft.readConfirmationEvent ?? draft.input.prepared.readConfirmation;
	if (!confirmation) {
		return;
	}
	const result: Partial<
		Pick<
			ToolPresentation,
			| "readConfirmation"
			| "nextActions"
			| "resultCategory"
			| "failureCategory"
			| "successCategory"
			| "content"
		>
	> = {
		readConfirmation: confirmation,
		...renderPendingHelperConfirmation(draft, confirmation),
	};
	if (draft.readConfirmationEvent?.state === "pending") {
		result.resultCategory = "failure";
		result.failureCategory = "confirmation-required";
		result.successCategory = undefined;
		if (draft.confirmationFromHelper) {
			result.content = [
				{
					type: "text",
					text: `Native helper ${confirmation.command ?? "read"} requires confirmation (${confirmation.action ?? "read"}, ${confirmation.id}). The requested command's result, if dispatched, is preserved below.`,
				},
				...presentation.content,
			];
		}
	}
	return result;
}

function renderUpgradeFailure(
	draft: RenderUpgradeFailureInput,
	presentation: ToolPresentationObservation,
): (Pick<ToolPresentation, "data"> & Partial<Pick<ToolPresentation, "content">>) | undefined {
	if (
		!draft.plainTextUpgrade ||
		draft.textOutput ||
		draft.succeeded ||
		typeof draft.presentationEnvelope?.data !== "string"
	) {
		return;
	}
	const data = draft.presentationEnvelope.data;
	const first = presentation.content.at(0);
	return {
		data,
		...(first?.type === "text" && data.length > 0
			? {
					content: [
						{ ...first, text: `${first.text}\n\n${data}` },
						...presentation.content.slice(1),
					],
				}
			: {}),
	};
}

function reclassifyScrollNoop(
	draft: ReclassifyScrollNoopInput,
):
	| Pick<ReclassifiedOutput, "succeeded" | "presentationEnvelope" | "presentationUpdate">
	| undefined {
	if (!draft.diagnostics.scrollNoopDiagnostic) {
		return;
	}
	const summary = "Scroll completed with no observed movement.";
	const data = isRecord(draft.presentation.data)
		? { ...draft.presentation.data, noMovement: true, scrolled: false }
		: draft.presentation.data;
	const first = draft.presentation.content.at(0);
	let content: ToolPresentation["content"];
	if (first?.type === "text") {
		const details = isRecord(data)
			? JSON.stringify(omitUpstreamLifecycle(data), null, 2)
			: first.text;
		content = [
			{ ...first, text: `${summary}\n\n${details}` },
			...draft.presentation.content.slice(1),
		];
	} else {
		content = [{ type: "text", text: summary }, ...draft.presentation.content];
	}
	return {
		succeeded: false,
		presentationEnvelope: { ...draft.presentationEnvelope, error: summary, success: false },
		presentationUpdate: {
			resultCategory: "failure",
			failureCategory: "upstream-error",
			summary,
			content,
			...(isRecord(draft.presentation.data) ? { data } : {}),
		},
	};
}

function renderParseFailureArtifacts(
	draft: RenderParseFailureArtifactsInput,
): Pick<ReclassifiedOutput, "artifactManifest" | "presentationUpdate"> {
	const artifactManifest = draft.parseFailureOutput.artifactManifest;
	const content = renderParseFailureNotice(draft);
	return {
		artifactManifest:
			artifactManifest ?? draft.presentation.artifactManifest ?? draft.artifactManifest,
		presentationUpdate: {
			...(artifactManifest
				? {
						artifactManifest,
						artifactRetentionSummary: draft.parseFailureOutput.artifactRetentionSummary,
					}
				: {}),
			...(content ? { content } : {}),
		},
	};
}

function renderPendingHelperConfirmation(
	draft: RenderPendingHelperConfirmationInput,
	confirmation: ReadConfirmation,
): Pick<ToolPresentation, "nextActions"> | undefined {
	if (
		confirmation.state !== "cleared" ||
		!detectConfirmationRequired(draft.presentationEnvelope?.data)
	) {
		return {
			nextActions: buildReadConfirmationNextActions(
				confirmation,
				draft.readConfirmationEvent?.state === "pending",
			),
		};
	}
	return;
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

function renderParseFailureNotice(
	draft: RenderParseFailureNoticeInput,
): ToolPresentation["content"] | undefined {
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
	return [
		{
			type: "text",
			text: existingText.length > 0 ? `${existingText}\n\n${notice}` : notice,
		},
		...draft.presentation.content.slice(1),
	];
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
function applyBatchNetworkRouteState(
	draft: ApplyBatchNetworkRouteStateInput,
): PublicationOutputPhase["networkRoutesBySession"] {
	const key = draft.sessionStateKey;
	const data: unknown = draft.presentationEnvelope?.data;
	if (!draft.succeeded || key === undefined || key.length === 0 || !Array.isArray(data)) {
		return draft.networkRoutesBySession;
	}
	let routes = draft.networkRoutesBySession.get(key);
	for (const item of data) {
		const effect = batchRouteEffect(item);
		if (!effect) {
			continue;
		}
		routes = applyBatchRowNetworkRouteRecords(routes, effect.tokens, effect.succeeded);
	}
	return setNetworkRouteState({
		routes,
		routesBySession: draft.networkRoutesBySession,
		sessionName: key,
	});
}
