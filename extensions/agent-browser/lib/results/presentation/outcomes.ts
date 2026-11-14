import { buildReadConfirmationNextActions } from "../../read-confirmation.js";
import { buildAgentBrowserNextActions } from "../action-recommendations.js";
import { buildAgentBrowserResultCategoryDetails } from "../categories.js";
import type { AgentBrowserNextAction, ToolPresentation } from "../contracts.js";
import {
	classifyPresentationSuccessCategory,
	formatMissingArtifactFailureText,
	hasMissingFileArtifact,
} from "./artifacts.js";
import { buildNetworkRequestsNextActions, buildStreamNextActions } from "./diagnostics.js";
import { extractPageWedgedHint, isOverlayBlockedClickError } from "./errors.js";
import type { BuildToolPresentationOptions } from "./input-contracts.js";
import { buildPageChangeSummary } from "./navigation.js";
import type { PresentationSource } from "./source.js";
import type { ToolPresentationObservation } from "./observation-contracts.js";

type OutcomeOptions = Pick<
	BuildToolPresentationOptions,
	"args" | "envelope" | "errorText" | "sessionName"
>;

type FailurePresentationUpdate = Pick<
	ToolPresentation,
	"resultCategory" | "failureCategory" | "successCategory" | "summary" | "content"
>;

function markFailure(
	content: ToolPresentationObservation["content"],
	category: "artifact-missing" | "upstream-error",
	text: string,
	prepend: boolean,
): FailurePresentationUpdate {
	const first = content.at(0);
	return {
		resultCategory: "failure",
		failureCategory: category,
		successCategory: undefined,
		summary: text,
		content:
			!prepend && first?.type === "text"
				? [{ ...first, text: `${text}\n\n${first.text}` }, ...content.slice(1)]
				: [{ type: "text", text }, ...content],
	};
}

function applyArtifactFailures(
	draft: ToolPresentationObservation,
	options: OutcomeOptions,
): FailurePresentationUpdate | undefined {
	const missing = formatMissingArtifactFailureText(draft.artifacts);
	const hasError = options.errorText !== undefined && options.errorText.length > 0;
	if (hasError) {
		return;
	}
	let failure: FailurePresentationUpdate | undefined;
	let content = draft.content;
	if (missing !== undefined && missing.length > 0 && hasMissingFileArtifact(draft.artifacts)) {
		failure = markFailure(content, "artifact-missing", missing, false);
		content = failure.content;
	}
	const recording = draft.artifacts?.find(
		(artifact) =>
			artifact.recording?.success === false ||
			artifact.recording?.output.encoderSucceeded === false,
	);
	if (recording) {
		return markFailure(
			content,
			"upstream-error",
			`Recording failed: ${recording.recording?.error ?? "native capture/encoder failure"}`,
			true,
		);
	}
	return failure;
}

function classifyOutcome(
	draft: ToolPresentationObservation,
	options: OutcomeOptions,
	source: PresentationSource,
): Pick<
	ToolPresentation,
	"readConfirmation" | "resultCategory" | "successCategory" | "failureCategory"
> {
	const outcome: Pick<
		ToolPresentation,
		"readConfirmation" | "resultCategory" | "successCategory" | "failureCategory"
	> = {};
	let resultCategory = draft.resultCategory;
	if (source.readConfirmation?.state === "pending") {
		outcome.readConfirmation = source.readConfirmation;
		resultCategory = "failure";
		outcome.failureCategory = "confirmation-required";
		outcome.successCategory = undefined;
	}
	if (resultCategory === undefined) {
		const categories = buildAgentBrowserResultCategoryDetails({
			artifacts: draft.artifacts,
			command: source.presentationCommandInfo.command,
			confirmationRequired: source.confirmationRequired !== undefined,
			errorText: options.envelope?.success === false ? draft.summary : undefined,
			savedFile: draft.savedFile,
			succeeded: options.envelope?.success !== false && source.confirmationRequired === undefined,
		});
		resultCategory = categories.resultCategory;
		outcome.successCategory = categories.successCategory;
		outcome.failureCategory = categories.failureCategory;
	}
	if (resultCategory === "success") {
		outcome.successCategory = classifyPresentationSuccessCategory({
			artifactVerification: draft.artifactVerification,
			artifacts: draft.artifacts,
			savedFile: draft.savedFile,
		});
	}
	outcome.resultCategory = resultCategory;
	return outcome;
}

function getGenericNextActions(
	draft: ToolPresentationObservation,
	options: OutcomeOptions,
	source: PresentationSource,
): readonly AgentBrowserNextAction[] | undefined {
	if (draft.nextActions) {
		return undefined;
	}
	return buildAgentBrowserNextActions({
		artifacts: draft.artifacts,
		args: options.args,
		command: source.presentationCommandInfo.command,
		confirmationId: source.confirmationRequired?.id,
		failureCategory: draft.failureCategory,
		overlayBlockedClick: isOverlayBlockedClickError(
			source.presentationCommandInfo.command,
			options.envelope?.success === false ? draft.summary : undefined,
			options.args ?? source.presentationCommandInfo.commandTokens,
		),
		pageWedged: extractPageWedgedHint(
			options.envelope?.success === false ? draft.summary : undefined,
			options.envelope?.data,
		),
		resultCategory: draft.resultCategory ?? "success",
		savedFilePath: draft.savedFilePath,
		sessionName: options.sessionName,
		subcommand: source.presentationCommandInfo.subcommand,
		successCategory: draft.successCategory,
	});
}

function applyNextActions(
	draft: ToolPresentationObservation,
	options: OutcomeOptions,
	source: PresentationSource,
): ToolPresentation["nextActions"] {
	const generic = getGenericNextActions(draft, options, source);
	const network =
		source.commandInfo.command === "network" &&
		source.commandInfo.subcommand === "requests" &&
		draft.resultCategory === "success"
			? buildNetworkRequestsNextActions(
					source.data,
					options.sessionName,
					draft.networkRouteDiagnostics,
				)
			: undefined;
	const stream =
		draft.resultCategory === "success"
			? buildStreamNextActions(source.commandInfo, source.data, options.sessionName)
			: undefined;
	const merged = [draft.nextActions, generic, network, stream].flatMap((group) => group ?? []);
	const fallback = merged.length > 0 ? merged : undefined;
	return source.readConfirmation
		? buildReadConfirmationNextActions(source.readConfirmation, true)
		: fallback;
}

export function applyPresentationOutcome(
	draft: ToolPresentationObservation,
	options: OutcomeOptions,
	source: PresentationSource,
): Partial<ToolPresentation> {
	const artifacts = applyArtifactFailures(draft, options);
	const withArtifacts = artifacts ? { ...draft, ...artifacts } : draft;
	const categories = classifyOutcome(withArtifacts, options, source);
	const classified = { ...withArtifacts, ...categories };
	const nextActions = applyNextActions(classified, options, source);
	const pageChangeSummary =
		classified.pageChangeSummary ??
		buildPageChangeSummary({
			artifacts: classified.artifacts,
			commandInfo: source.presentationCommandInfo,
			data: source.data,
			nextActions,
			savedFilePath: classified.savedFilePath,
			summary: classified.summary,
		});
	const result: Partial<ToolPresentation> = {
		...artifacts,
		...categories,
		nextActions,
		pageChangeSummary,
	};
	const first = classified.content.at(0);
	if (
		pageChangeSummary?.observed === false &&
		source.presentationCommandInfo.command !== "batch" &&
		first?.type === "text"
	) {
		result.content = [
			{
				...first,
				text: `${first.text}\n\nAction dispatched; application change unverified. Verify the expected URL, text, state, or external receipt before relying on it.`,
			},
			...classified.content.slice(1),
		];
	}
	return result;
}
