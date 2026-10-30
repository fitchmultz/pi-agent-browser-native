import { parseCommandInfo, type CommandInfo } from "../../argv-descriptor.js";
import { isRecord } from "../../parsing.js";
import { redactInvocationArgs } from "../../runtime-redaction.js";
import { buildAgentBrowserNextActions } from "../action-recommendations.js";
import { buildPendingWebMcpNextActions } from "../recovery-next-actions.js";
import { classifyAgentBrowserFailureCategory } from "../categories.js";
import { detectConfirmationRequired } from "../confirmation.js";
import type {
	AgentBrowserBatchResult,
	AgentBrowserFailureCategory,
	AgentBrowserLifecycle,
	BatchStepPresentationDetails,
	ToolPresentation,
} from "../contracts.js";
import { applyNamespaceToNextActions, withOptionalSessionArgs } from "../next-actions.js";
import type { AgentBrowserNextAction } from "../action-contracts.js";
import { buildNetworkRouteDiagnostics } from "../network-routes.js";
import { extractAgentBrowserLifecycle, stringifyModelFacing } from "./common.js";
import { classifyPresentationSuccessCategory } from "./artifacts.js";
import {
	formatBatchStepCommand,
	getPresentationPaths,
	getPresentationText,
	isStringArray,
} from "./content.js";
import { buildPageChangeSummary } from "./navigation.js";
import { appendSelectorRecoveryHint, isOverlayBlockedClickError } from "./errors.js";
import { hasModelFacingArgRedaction, redactBatchStepErrorData } from "./batch-redaction.js";
import type {
	BatchPresentedStep,
	BuildBatchStepOptions,
	BuildNestedToolPresentationOptions,
} from "./batch-contracts.js";
import type { ToolPresentationObservation } from "./observation-contracts.js";

interface StepIdentity {
	readonly command?: readonly string[];
	readonly redactedCommand?: readonly string[];
	readonly commandText: string;
	readonly index: number;
	readonly lifecycle?: AgentBrowserLifecycle;
}

interface StepScope {
	readonly namespace?: string;
	readonly sessionName?: string;
}

function createStepIdentity(item: AgentBrowserBatchResult, index: number): StepIdentity {
	const command = isStringArray(item.command) ? item.command : undefined;
	const redactedCommand = command ? redactInvocationArgs(command) : undefined;
	const visibleCommand = hasModelFacingArgRedaction(redactedCommand) ? redactedCommand : command;
	return {
		command,
		redactedCommand,
		index: item.index ?? index,
		commandText: formatBatchStepCommand(
			item.index === undefined ? visibleCommand : undefined,
			item.index ?? index,
		),
		lifecycle: extractAgentBrowserLifecycle(item.result),
	};
}

function formatBatchStepError(error: unknown): string {
	const text = stringifyModelFacing(error).trim();
	return appendSelectorRecoveryHint(
		text.length > 0 ? `Error: ${text}` : "Error: batch step failed.",
	);
}

function buildWaitTextAssertionFailureAction(
	sessionName: string | undefined,
): AgentBrowserNextAction {
	return {
		id: "inspect-after-text-assertion-failure",
		params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) },
		reason:
			"Inspect the current page after the text assertion failed before concluding the expected text is absent.",
		safety:
			"Read-only snapshot; use current refs or visible text from this page before retrying the assertion.",
		tool: "agent_browser",
	};
}

interface StepFailure {
	readonly category: AgentBrowserFailureCategory;
	readonly confirmationId?: string;
	readonly data: unknown;
	readonly overlayBlocked: boolean;
	readonly text: string;
}

function describeStepFailure(command: readonly string[] | undefined, error: unknown): StepFailure {
	const data = redactBatchStepErrorData(command, error);
	const text = formatBatchStepError(data);
	return {
		data,
		text,
		category: classifyAgentBrowserFailureCategory({
			args: command,
			command: command?.[0],
			errorText: text,
		}),
		confirmationId: detectConfirmationRequired(error)?.id,
		overlayBlocked: isOverlayBlockedClickError(command?.[0], text, command),
	};
}

function buildFailedStepActions(
	command: readonly string[] | undefined,
	failure: StepFailure,
	scope: StepScope,
): readonly AgentBrowserNextAction[] | undefined {
	const recovery = buildAgentBrowserNextActions({
		args: command,
		command: command?.[0],
		confirmationId: failure.confirmationId,
		failureCategory: failure.category,
		overlayBlockedClick: failure.overlayBlocked,
		resultCategory: "failure",
		sessionName: scope.sessionName,
		subcommand: command?.[1],
	});
	const waitAction =
		command?.[0] === "wait" && command.includes("--text")
			? [buildWaitTextAssertionFailureAction(scope.sessionName)]
			: [];
	const seen = new Set<string>();
	const actions = [...waitAction, ...(recovery ?? [])].filter((action) => {
		if (seen.has(action.id)) {
			return false;
		}
		seen.add(action.id);
		return true;
	});
	return applyNamespaceToNextActions(actions.length > 0 ? actions : undefined, scope.namespace);
}

function buildFailedStep(
	item: AgentBrowserBatchResult,
	identity: StepIdentity,
	scope: StepScope,
): BatchPresentedStep {
	const failure = describeStepFailure(identity.command, item.error);
	const { data, text, category: failureCategory } = failure;
	const nextActions = buildFailedStepActions(identity.command, failure, scope);
	const presentation: ToolPresentation = {
		content: [{ type: "text", text }],
		failureCategory,
		nextActions,
		resultCategory: "failure",
		summary: text,
	};
	return {
		presentation,
		details: {
			artifactVerification: presentation.artifactVerification,
			artifacts: presentation.artifacts,
			command: identity.redactedCommand,
			commandText: identity.commandText,
			data,
			failureCategory,
			index: identity.index,
			lifecycle: identity.lifecycle,
			nextActions,
			resultCategory: "failure",
			success: false,
			summary: text,
			text,
		},
	};
}

function buildNestedRequest(
	options: BuildBatchStepOptions,
	command: readonly string[] | undefined,
): BuildNestedToolPresentationOptions {
	const commandInfo = parseCommandInfo(command ?? []);
	return {
		modelVisible: options.modelVisible,
		artifactManifest: options.artifactManifest,
		artifactMaxUpdatedAtMs: options.artifactMaxUpdatedAtMs,
		artifactMinUpdatedAtMs: options.artifactMinUpdatedAtMs,
		artifactRequest: options.artifactRequest,
		commandInfo: command ? { ...commandInfo, commandTokens: command } : commandInfo,
		cwd: options.cwd,
		args: command,
		envelope: {
			data: options.item.result,
			success: options.item.success !== false,
			error: options.item.error,
		},
		errorText:
			options.item.success === false
				? formatBatchStepError(redactBatchStepErrorData(command, options.item.error))
				: undefined,
		piCleanupOwnership: options.piCleanupOwnership,
		networkRouteDiagnostics:
			commandInfo.command === "network" && commandInfo.subcommand === "requests"
				? buildNetworkRouteDiagnostics(options.item.result, options.networkRoutes)
				: undefined,
		namespace: options.namespace,
		persistentArtifactStore: options.persistentArtifactStore,
		sessionName: options.sessionName,
	};
}

function isPendingWebMcpMutation(command: CommandInfo, data: unknown): boolean {
	return (
		command.command === "webmcp" &&
		["invoke", "result"].includes(command.subcommand ?? "") &&
		isRecord(data) &&
		data.status === "pending"
	);
}

function buildStandardStepActions(
	presentation: ToolPresentationObservation,
	command: readonly string[] | undefined,
	sessionName: string | undefined,
): readonly AgentBrowserNextAction[] | undefined {
	return (
		presentation.nextActions ??
		buildAgentBrowserNextActions({
			artifacts: presentation.artifacts,
			args: command,
			command: command?.[0],
			failureCategory: presentation.failureCategory,
			resultCategory: presentation.resultCategory !== "failure" ? "success" : "failure",
			savedFilePath: presentation.savedFilePath,
			sessionName,
			subcommand: command?.[1],
			successCategory: presentation.successCategory,
		})
	);
}

function getStepNextActions(
	presentation: ToolPresentationObservation,
	commandInfo: CommandInfo,
	command: readonly string[] | undefined,
	scope: StepScope,
): readonly AgentBrowserNextAction[] | undefined {
	const actions =
		presentation.resultCategory !== "failure" &&
		isPendingWebMcpMutation(commandInfo, presentation.data)
			? buildPendingWebMcpNextActions(scope.sessionName)
			: buildStandardStepActions(presentation, command, scope.sessionName);
	return applyNamespaceToNextActions(actions, scope.namespace);
}

function buildStepDetails(
	presentation: ToolPresentationObservation,
	identity: StepIdentity,
	command: CommandInfo,
	scope: StepScope,
): BatchStepPresentationDetails {
	const fullOutputPaths = getPresentationPaths({
		primaryPath: presentation.fullOutputPath,
		secondaryPaths: presentation.fullOutputPaths,
	});
	const imagePaths = getPresentationPaths({
		primaryPath: presentation.imagePath,
		secondaryPaths: presentation.imagePaths,
	});
	const text = getPresentationText(presentation);
	const succeeded = presentation.resultCategory !== "failure";
	const nextActions = getStepNextActions(presentation, command, identity.command, scope);
	return {
		artifactVerification: presentation.artifactVerification,
		artifacts: presentation.artifacts,
		command: identity.redactedCommand,
		commandText: identity.commandText,
		data: presentation.data,
		failureCategory: succeeded ? undefined : presentation.failureCategory,
		fullOutputPath: fullOutputPaths.at(0),
		fullOutputPaths: fullOutputPaths.length > 0 ? fullOutputPaths : undefined,
		imagePath: imagePaths.at(0),
		imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
		imageObservations: presentation.imageObservations,
		index: identity.index,
		lifecycle: identity.lifecycle,
		networkRouteDiagnostics: presentation.networkRouteDiagnostics,
		nextActions,
		pageChangeSummary: buildPageChangeSummary({
			artifacts: presentation.artifacts,
			commandInfo: command,
			data: presentation.data,
			nextActions,
			savedFilePath: presentation.savedFilePath,
			summary: presentation.summary,
		}),
		resultCategory: succeeded ? "success" : "failure",
		savedFile: presentation.savedFile,
		savedFilePath: presentation.savedFilePath,
		success: succeeded,
		successCategory: succeeded
			? classifyPresentationSuccessCategory({
					artifactVerification: presentation.artifactVerification,
					artifacts: presentation.artifacts,
					savedFile: presentation.savedFile,
				})
			: undefined,
		summary: presentation.summary,
		text: text.length > 0 ? text : presentation.summary,
	};
}

export async function buildBatchStepPresentation(
	options: BuildBatchStepOptions,
): Promise<BatchPresentedStep> {
	const identity = createStepIdentity(options.item, options.index);
	const scope = { namespace: options.namespace, sessionName: options.sessionName };
	if (options.item.success === false && identity.command?.[0] !== "record") {
		return {
			...buildFailedStep(options.item, identity, scope),
			nativeIndex: options.item.index,
		};
	}
	const request = buildNestedRequest(options, identity.command);
	const presentation = await options.buildNestedToolPresentation(request);
	return {
		details: buildStepDetails(presentation, identity, request.commandInfo, scope),
		nativeIndex: options.item.index,
		presentation,
	};
}
