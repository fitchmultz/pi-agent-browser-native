/*
 * Purpose: Render parsed agent-browser results into concise pi-facing summaries, text content, and optional inline image attachments.
 * Responsibilities: Orchestrate specialized presentation modules, attach inline images within size limits, and keep generic record formatting distinct from envelope parsing.
 * Scope: Presentation shaping only; upstream stdout parsing and snapshot compaction internals live in separate modules.
 */

import type { CompiledAgentBrowserSemanticAction } from "../input-modes/types.js";
import { isRecord } from "../parsing.js";
import type { CommandInfo } from "../runtime.js";
import type { PersistentSessionArtifactStore } from "../temp.js";
import { buildAgentBrowserNextActions } from "./action-recommendations.js";
import { buildAgentBrowserResultCategoryDetails } from "./categories.js";
import { detectConfirmationRequired } from "./confirmation.js";
import type {
	AgentBrowserEnvelope,
	AgentBrowserNextAction,
	NetworkRouteDiagnostic,
	SessionArtifactManifest,
	ToolPresentation,
} from "./contracts.js";
import { buildSnapshotPresentation } from "./snapshot.js";
import { parseJsonPreviewString, redactModelFacingText, stringifyModelFacing } from "./presentation/common.js";
import {
	applyArtifactManifest,
	attachInlineImage,
	buildArtifactVerificationSummary,
	buildManifestEntriesForFileArtifacts,
	classifyPresentationSuccessCategory,
	extractFileArtifacts,
	extractImagePath,
	formatArtifactMetadataLines,
	formatArtifactSummary,
	formatMissingArtifactFailureText,
	getSavedFileDetails,
	hasMissingFileArtifact,
	isManifestFileArtifact,
	type ArtifactRequestContext,
} from "./presentation/artifacts.js";
import { buildBatchPresentation, isAgentBrowserBatchResultArray } from "./presentation/batch.js";
import { getPresentationPaths } from "./presentation/content.js";
import {
	buildNetworkRequestsNextActions,
	buildStreamNextActions,
	enrichStreamStatusData,
	formatNetworkRouteDiagnosticsText,
	redactPresentationData,
} from "./presentation/diagnostics.js";
import { buildErrorPresentation } from "./presentation/errors.js";
import { compactLargePresentationOutput } from "./presentation/large-output.js";
import { buildPageChangeSummary } from "./presentation/navigation.js";
import { formatPresentationContentText, formatPresentationSummary } from "./presentation/registry.js";
import { resolvePresentationCommandInfo } from "./presentation/semantic-action.js";

function sanitizeModelFacingPresentation(presentation: ToolPresentation): ToolPresentation {
	presentation.content = presentation.content.map((item) => {
		if (item.type !== "text") return item;
		const parsed = parseJsonPreviewString(item.text);
		return parsed === item.text ? item : { ...item, text: stringifyModelFacing(parsed) };
	});
	presentation.summary = redactModelFacingText(presentation.summary);
	return presentation;
}

function mergeNextActions(...groups: Array<AgentBrowserNextAction[] | undefined>): AgentBrowserNextAction[] | undefined {
	const merged = groups.flatMap((group) => group ?? []);
	return merged.length > 0 ? merged : undefined;
}

function shouldAddAnnotatedScreenshotGuidance(commandInfo: CommandInfo, args: string[] | undefined): boolean {
	return commandInfo.command === "screenshot" && (args?.includes("--annotate") ?? false);
}

export async function buildToolPresentation(options: {
	artifactManifest?: SessionArtifactManifest;
	args?: string[];
	artifactRequest?: ArtifactRequestContext;
	batchArtifactRequests?: Array<ArtifactRequestContext | undefined>;
	commandInfo: CommandInfo;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	errorText?: string;
	networkRouteDiagnostics?: NetworkRouteDiagnostic[];
	networkRoutes?: import("./contracts.js").NetworkRouteRecord[];
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
}): Promise<ToolPresentation> {
	const {
		args,
		artifactManifest,
		artifactRequest,
		commandInfo,
		compiledSemanticAction,
		cwd,
		envelope,
		errorText,
		networkRouteDiagnostics,
		networkRoutes,
		persistentArtifactStore,
		sessionName,
	} = options;
	const presentationCommandInfo = resolvePresentationCommandInfo(commandInfo, compiledSemanticAction);

	if (errorText) {
		return buildErrorPresentation({ args, commandInfo, errorText, sessionName });
	}

	const data = enrichStreamStatusData(commandInfo, envelope?.data);
	const presentationData = redactPresentationData(commandInfo, data);
	const artifacts = await extractFileArtifacts({ artifactRequest, commandInfo: presentationCommandInfo, cwd, data, sessionName });
	const artifactVerification = buildArtifactVerificationSummary(artifacts);
	const artifactSummary = formatArtifactSummary(artifacts);
	const summary = artifactSummary ?? formatPresentationSummary(commandInfo, data, compiledSemanticAction);
	const artifactText = artifacts.length > 0 ? formatArtifactMetadataLines(artifacts).join("\n") : undefined;

	let presentation: ToolPresentation;
	if (commandInfo.command === "batch" && isAgentBrowserBatchResultArray(data)) {
		presentation = await buildBatchPresentation({
			artifactManifest,
			artifactRequests: options.batchArtifactRequests,
			buildNestedToolPresentation: buildToolPresentation,
			cwd,
			data,
			networkRoutes,
			persistentArtifactStore,
			sessionName,
			summary,
		});
	} else if (commandInfo.command === "snapshot" && isRecord(data)) {
		presentation = await buildSnapshotPresentation(data, persistentArtifactStore, artifactManifest);
	} else {
		presentation = {
			artifactVerification,
			artifacts: artifacts.length > 0 ? artifacts : undefined,
			content: [{ type: "text", text: artifactText ?? formatPresentationContentText(commandInfo, data, compiledSemanticAction) }],
			data: presentationData,
			summary,
		};
	}

	if (networkRouteDiagnostics && networkRouteDiagnostics.length > 0 && presentation.content[0]?.type === "text") {
		const diagnosticText = formatNetworkRouteDiagnosticsText(networkRouteDiagnostics);
		if (diagnosticText) presentation.content[0] = { ...presentation.content[0], text: `${diagnosticText}\n\n${presentation.content[0].text}` };
		presentation.networkRouteDiagnostics = networkRouteDiagnostics;
	}
	if (artifacts.length > 0 && !presentation.artifacts) {
		presentation.artifacts = artifacts;
	}
	presentation.artifactVerification = presentation.artifactVerification ?? artifactVerification;
	if (isRecord(data)) {
		const savedFile = getSavedFileDetails(commandInfo, data);
		if (savedFile) {
			presentation.savedFile = savedFile;
			presentation.savedFilePath = savedFile.path;
		}
	}

	if (shouldAddAnnotatedScreenshotGuidance(commandInfo, args) && presentation.content[0]?.type === "text") {
		const guidance = "Annotated screenshot note: dense pages can produce overlapping labels. If the labels are noisy, capture a scoped element screenshot, take a non-annotated screenshot, or use snapshot -i high-value refs as the machine-readable map.";
		presentation.content[0] = { ...presentation.content[0], text: `${presentation.content[0].text}\n\n${guidance}` };
	}

	const imagePath = artifactRequest?.absolutePath ?? extractImagePath(commandInfo, cwd, data);
	const presentationWithImage = imagePath ? await attachInlineImage(presentation, imagePath) : presentation;
	const compactedPresentation = await compactLargePresentationOutput({
		artifactManifest,
		commandInfo,
		data: presentationData,
		persistentArtifactStore,
		presentation: presentationWithImage,
	});
	const presentationWithManifest = applyArtifactManifest(
		compactedPresentation,
		compactedPresentation.artifactManifest ?? artifactManifest,
		buildManifestEntriesForFileArtifacts(artifacts.filter(isManifestFileArtifact)),
	);
	const currentSpillPaths = new Set(getPresentationPaths({
		primaryPath: presentationWithManifest.fullOutputPath,
		secondaryPaths: presentationWithManifest.fullOutputPaths,
	}));
	presentationWithManifest.artifactVerification = buildArtifactVerificationSummary(
		artifacts,
		presentationWithManifest.artifactManifest,
		currentSpillPaths,
	) ?? presentationWithManifest.artifactVerification;

	const confirmationRequired = detectConfirmationRequired(data);
	const missingArtifactFailureText = formatMissingArtifactFailureText(presentationWithManifest.artifacts);
	if (missingArtifactFailureText && hasMissingFileArtifact(presentationWithManifest.artifacts)) {
		presentationWithManifest.resultCategory = "failure";
		presentationWithManifest.failureCategory = "artifact-missing";
		presentationWithManifest.successCategory = undefined;
		presentationWithManifest.summary = missingArtifactFailureText;
		if (presentationWithManifest.content[0]?.type === "text") {
			presentationWithManifest.content[0] = { ...presentationWithManifest.content[0], text: `${missingArtifactFailureText}\n\n${presentationWithManifest.content[0].text}` };
		} else {
			presentationWithManifest.content.unshift({ type: "text", text: missingArtifactFailureText });
		}
	}

	if (!presentationWithManifest.resultCategory) {
		const categoryDetails = buildAgentBrowserResultCategoryDetails({
			artifacts: presentationWithManifest.artifacts,
			command: presentationCommandInfo.command,
			confirmationRequired: confirmationRequired !== undefined,
			errorText: envelope?.success === false ? presentationWithManifest.summary : undefined,
			savedFile: presentationWithManifest.savedFile,
			succeeded: envelope?.success !== false,
		});
		presentationWithManifest.resultCategory = categoryDetails.resultCategory;
		presentationWithManifest.successCategory = categoryDetails.resultCategory === "success"
			? classifyPresentationSuccessCategory({
				artifactVerification: presentationWithManifest.artifactVerification,
				artifacts: presentationWithManifest.artifacts,
				savedFile: presentationWithManifest.savedFile,
			})
			: categoryDetails.successCategory;
		presentationWithManifest.failureCategory = categoryDetails.failureCategory;
	}
	if (presentationWithManifest.resultCategory === "success") {
		presentationWithManifest.successCategory = classifyPresentationSuccessCategory({
			artifactVerification: presentationWithManifest.artifactVerification,
			artifacts: presentationWithManifest.artifacts,
			savedFile: presentationWithManifest.savedFile,
		});
	}

	const genericNextActions = presentationWithManifest.nextActions ? undefined : buildAgentBrowserNextActions({
		artifacts: presentationWithManifest.artifacts,
		args,
		command: presentationCommandInfo.command,
		confirmationId: confirmationRequired?.id,
		failureCategory: presentationWithManifest.failureCategory,
		resultCategory: presentationWithManifest.resultCategory ?? "success",
		savedFilePath: presentationWithManifest.savedFilePath,
		successCategory: presentationWithManifest.successCategory,
	});
	const networkNextActions = commandInfo.command === "network" && commandInfo.subcommand === "requests" && presentationWithManifest.resultCategory === "success"
		? buildNetworkRequestsNextActions(data, sessionName, presentationWithManifest.networkRouteDiagnostics)
		: undefined;
	const streamNextActions = presentationWithManifest.resultCategory === "success" ? buildStreamNextActions(commandInfo, data, sessionName) : undefined;
	presentationWithManifest.nextActions = mergeNextActions(
		presentationWithManifest.nextActions,
		genericNextActions,
		networkNextActions,
		streamNextActions,
	);
	presentationWithManifest.pageChangeSummary = presentationWithManifest.pageChangeSummary ?? buildPageChangeSummary({
		artifacts: presentationWithManifest.artifacts,
		commandInfo: presentationCommandInfo,
		data,
		nextActions: presentationWithManifest.nextActions,
		savedFilePath: presentationWithManifest.savedFilePath,
		summary: presentationWithManifest.summary,
	});
	return sanitizeModelFacingPresentation(presentationWithManifest);
}
