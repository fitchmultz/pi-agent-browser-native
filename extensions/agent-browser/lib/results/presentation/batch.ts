import { isRecord } from "../../parsing.js";
import { extractCommandTokens, parseCommandInfo, redactInvocationArgs, redactSensitiveText, redactSensitiveValue, type CommandInfo } from "../../runtime.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import { buildAgentBrowserNextActions } from "../action-recommendations.js";
import { formatSessionArtifactRetentionSummary } from "../artifact-manifest.js";
import { classifyAgentBrowserFailureCategory } from "../categories.js";
import { detectConfirmationRequired } from "../confirmation.js";
import type {
	AgentBrowserBatchResult,
	AgentBrowserEnvelope,
	AgentBrowserNextAction,
	BatchFailurePresentationDetails,
	BatchStepPresentationDetails,
	NetworkRouteDiagnostic,
	NetworkRouteRecord,
	SessionArtifactManifest,
	ToolPresentation,
} from "../contracts.js";
import { applyNetworkRouteRecords, buildNetworkRouteDiagnostics } from "../network-routes.js";
import { withOptionalSessionArgs } from "../next-actions.js";
import { stringifyModelFacing } from "./common.js";
import { buildArtifactVerificationSummary, classifyPresentationSuccessCategory, manifestHasNewNoticeWorthyEntries, type ArtifactRequestContext } from "./artifacts.js";
import { formatBatchStepCommand, getPresentationImages, getPresentationPaths, getPresentationText, isStringArray } from "./content.js";
import { buildPageChangeSummary } from "./navigation.js";
import { appendSelectorRecoveryHint, getClipboardWritePayloadCandidates, redactClipboardPermissionErrorValue } from "./errors.js";

export interface BuildNestedToolPresentationOptions {
	artifactManifest?: SessionArtifactManifest;
	artifactRequest?: ArtifactRequestContext;
	args?: string[];
	commandInfo: CommandInfo;
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	networkRouteDiagnostics?: NetworkRouteDiagnostic[];
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
}

type BuildNestedToolPresentation = (options: BuildNestedToolPresentationOptions) => Promise<ToolPresentation>;

export function isAgentBrowserBatchResultArray(value: unknown): value is AgentBrowserBatchResult[] {
	return Array.isArray(value) && value.every(isRecord);
}

function isWaitTextAssertionCommand(command: string[] | undefined): boolean {
	return command?.[0] === "wait" && command.includes("--text");
}

function buildWaitTextAssertionFailureNextAction(sessionName: string | undefined): AgentBrowserNextAction {
	return {
		id: "inspect-after-text-assertion-failure",
		params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) },
		reason: "Inspect the current page after the text assertion failed before concluding the expected text is absent.",
		safety: "Read-only snapshot; use current refs or visible text from this page before retrying the assertion.",
		tool: "agent_browser",
	};
}

function mergePresentationNextActions(...groups: Array<AgentBrowserNextAction[] | undefined>): AgentBrowserNextAction[] | undefined {
	const actions: AgentBrowserNextAction[] = [];
	const seen = new Set<string>();
	for (const group of groups) {
		for (const action of group ?? []) {
			if (seen.has(action.id)) continue;
			actions.push(action);
			seen.add(action.id);
		}
	}
	return actions.length > 0 ? actions : undefined;
}

function formatBatchStepError(error: unknown): string {
	const errorText = stringifyModelFacing(error).trim();
	const formattedErrorText = errorText.length > 0 ? `Error: ${errorText}` : "Error: batch step failed.";
	return appendSelectorRecoveryHint(formattedErrorText);
}

function getBatchFailureDetails(steps: Array<{ details: BatchStepPresentationDetails }>): BatchFailurePresentationDetails | undefined {
	const failedSteps = steps.filter((step) => step.details.success === false);
	if (failedSteps.length === 0) return undefined;
	const successCount = steps.length - failedSteps.length;
	return {
		failedStep: failedSteps[0].details,
		failureCount: failedSteps.length,
		successCount,
		totalCount: steps.length,
	};
}

function hasModelFacingArgRedaction(args: string[] | undefined): boolean {
	return args?.some((arg) => arg === "[REDACTED]" || arg.includes("%5BREDACTED%5D") || arg.includes("[REDACTED]")) === true;
}

function getStatefulCommandSensitiveValues(command: string[] | undefined): string[] {
	if (!command) return [];
	const tokens = extractCommandTokens(command);
	const values: string[] = [];
	if (tokens[0] === "cookies" && tokens[1] === "set" && tokens[3]) values.push(tokens[3]);
	if (tokens[0] === "storage" && ["local", "session"].includes(tokens[1] ?? "") && tokens[2] === "set" && tokens[4]) values.push(tokens[4]);
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--password" && tokens[index + 1]) values.push(tokens[index + 1]);
		else if (token?.startsWith("--password=")) values.push(token.slice("--password=".length));
	}
	return values.filter((value) => value.length > 0);
}

function redactExactValues(value: unknown, sensitiveValues: string[]): unknown {
	if (sensitiveValues.length === 0) return redactSensitiveValue(value);
	if (typeof value === "string") {
		let redacted = value;
		for (const sensitiveValue of sensitiveValues) redacted = redacted.split(sensitiveValue).join("[REDACTED]");
		return redactSensitiveText(redacted);
	}
	if (Array.isArray(value)) return value.map((item) => redactExactValues(item, sensitiveValues));
	if (!isRecord(value)) return value;
	return redactSensitiveValue(Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, redactExactValues(entryValue, sensitiveValues)])));
}

async function buildBatchStepPresentation(options: {
	artifactManifest?: SessionArtifactManifest;
	artifactRequest?: ArtifactRequestContext;
	buildNestedToolPresentation: BuildNestedToolPresentation;
	cwd: string;
	index: number;
	item: AgentBrowserBatchResult;
	networkRoutes?: NetworkRouteRecord[];
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
}): Promise<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> {
	const { artifactManifest, artifactRequest, buildNestedToolPresentation, cwd, index, item, networkRoutes, persistentArtifactStore, sessionName } = options;
	const command = isStringArray(item.command) ? item.command : undefined;
	const redactedCommand = command ? redactInvocationArgs(command) : undefined;
	const commandText = formatBatchStepCommand(hasModelFacingArgRedaction(redactedCommand) ? redactedCommand : command, index);

	if (item.success === false) {
		const redactedErrorData = command?.[0] === "clipboard"
			? redactSensitiveValue(redactClipboardPermissionErrorValue({ command: "clipboard", subcommand: command[1] }, item.error, getClipboardWritePayloadCandidates(command)))
			: redactExactValues(item.error, getStatefulCommandSensitiveValues(command));
		const errorText = formatBatchStepError(redactedErrorData);
		const failureCategory = classifyAgentBrowserFailureCategory({
			args: command,
			command: command?.[0],
			errorText,
		});
		const confirmationRequired = detectConfirmationRequired(item.error);
		const nextActions = mergePresentationNextActions(
			buildAgentBrowserNextActions({
				args: command,
				command: command?.[0],
				confirmationId: confirmationRequired?.id,
				failureCategory,
				resultCategory: "failure",
			}),
			isWaitTextAssertionCommand(command) ? [buildWaitTextAssertionFailureNextAction(sessionName)] : undefined,
		);
		const presentation: ToolPresentation = {
			content: [{ type: "text", text: errorText }],
			failureCategory,
			nextActions,
			resultCategory: "failure",
			summary: errorText,
		};
		return {
			details: {
				artifactVerification: presentation.artifactVerification,
				artifacts: presentation.artifacts,
				command: redactedCommand,
				commandText,
				data: redactedErrorData,
				failureCategory,
				index,
				nextActions,
				resultCategory: "failure",
				success: false,
				summary: errorText,
				text: errorText,
			},
			presentation,
		};
	}

	const commandInfo = parseCommandInfo(command ?? []);
	const networkRouteDiagnostics = commandInfo.command === "network" && commandInfo.subcommand === "requests"
		? buildNetworkRouteDiagnostics(item.result, networkRoutes)
		: undefined;
	const presentation = await buildNestedToolPresentation({
		artifactManifest,
		artifactRequest,
		commandInfo,
		cwd,
		args: command,
		envelope: { data: item.result, success: true },
		networkRouteDiagnostics,
		persistentArtifactStore,
		sessionName,
	});
	const fullOutputPaths = getPresentationPaths({
		primaryPath: presentation.fullOutputPath,
		secondaryPaths: presentation.fullOutputPaths,
	});
	const imagePaths = getPresentationPaths({
		primaryPath: presentation.imagePath,
		secondaryPaths: presentation.imagePaths,
	});
	const text = getPresentationText(presentation) || presentation.summary;
	const stepSucceeded = presentation.resultCategory !== "failure";
	const nextActions = presentation.nextActions ?? buildAgentBrowserNextActions({
		artifacts: presentation.artifacts,
		args: command,
		command: command?.[0],
		failureCategory: presentation.failureCategory,
		resultCategory: stepSucceeded ? "success" : "failure",
		savedFilePath: presentation.savedFilePath,
		successCategory: presentation.successCategory,
	});
	const pageChangeSummary = buildPageChangeSummary({
		artifacts: presentation.artifacts,
		commandInfo,
		data: presentation.data,
		nextActions,
		savedFilePath: presentation.savedFilePath,
		summary: presentation.summary,
	});

	return {
		details: {
			artifactVerification: presentation.artifactVerification,
			artifacts: presentation.artifacts,
			command: redactedCommand,
			commandText,
			data: presentation.data,
			failureCategory: stepSucceeded ? undefined : presentation.failureCategory,
			fullOutputPath: fullOutputPaths[0],
			fullOutputPaths: fullOutputPaths.length > 0 ? fullOutputPaths : undefined,
			imagePath: imagePaths[0],
			imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
			index,
			networkRouteDiagnostics: presentation.networkRouteDiagnostics,
			nextActions,
			pageChangeSummary,
			resultCategory: stepSucceeded ? "success" : "failure",
			savedFile: presentation.savedFile,
			savedFilePath: presentation.savedFilePath,
			success: stepSucceeded,
			successCategory: stepSucceeded ? classifyPresentationSuccessCategory({ artifactVerification: presentation.artifactVerification, artifacts: presentation.artifacts, savedFile: presentation.savedFile }) : undefined,
			summary: presentation.summary,
			text,
		},
		presentation,
	};
}

export async function buildBatchPresentation(options: {
	artifactManifest?: SessionArtifactManifest;
	artifactRequests?: Array<ArtifactRequestContext | undefined>;
	buildNestedToolPresentation: BuildNestedToolPresentation;
	cwd: string;
	data: AgentBrowserBatchResult[];
	networkRoutes?: NetworkRouteRecord[];
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
	summary: string;
}): Promise<ToolPresentation> {
	const { artifactRequests, buildNestedToolPresentation, cwd, data, networkRoutes, persistentArtifactStore, sessionName, summary } = options;
	const steps: Array<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> = [];
	const protectedPersistentPaths: string[] = [];
	let currentArtifactManifest = options.artifactManifest;
	let currentNetworkRoutes = networkRoutes;
	for (const [index, item] of data.entries()) {
		const step = await buildBatchStepPresentation({
			artifactManifest: currentArtifactManifest,
			artifactRequest: artifactRequests?.[index],
			buildNestedToolPresentation,
			cwd,
			index,
			item,
			networkRoutes: currentNetworkRoutes,
			persistentArtifactStore: persistentArtifactStore ? { ...persistentArtifactStore, protectedPaths: protectedPersistentPaths } : undefined,
			sessionName,
		});
		steps.push(step);
		currentArtifactManifest = step.presentation.artifactManifest ?? currentArtifactManifest;
		currentNetworkRoutes = applyNetworkRouteRecords(currentNetworkRoutes, isStringArray(item.command) ? extractCommandTokens(item.command) : undefined, item.success !== false && step.details.success);
		protectedPersistentPaths.push(
			...getPresentationPaths({
				primaryPath: step.presentation.fullOutputPath,
				secondaryPaths: step.presentation.fullOutputPaths,
			}),
		);
	}

	const batchFailure = getBatchFailureDetails(steps);
	const images = steps.flatMap((step) => getPresentationImages(step.presentation));
	const artifacts = steps.flatMap((step) => step.presentation.artifacts ?? []);
	const artifactVerification = buildArtifactVerificationSummary(artifacts);
	const fullOutputPaths = steps.flatMap((step) => getPresentationPaths({
		primaryPath: step.presentation.fullOutputPath,
		secondaryPaths: step.presentation.fullOutputPaths,
	}));
	const imagePaths = steps.flatMap((step) => getPresentationPaths({
		primaryPath: step.presentation.imagePath,
		secondaryPaths: step.presentation.imagePaths,
	}));
	const redactedBatchData = steps.map(({ details }) => (
		details.success
			? { command: details.command, result: details.data, success: true }
			: { command: details.command, error: details.text, success: false }
	));
	const stepText = steps.length === 0
		? "(no batch steps)"
		: steps
			.map(({ details, presentation }) => {
				const inlineImageCount = getPresentationImages(presentation).length;
				const status = details.success ? "succeeded" : "failed";
				const lines = [`Step ${details.index + 1} — ${details.commandText} (${status})`];
				if (details.text.length > 0) lines.push(details.text);
				if (inlineImageCount > 0) lines.push(`(${inlineImageCount} inline image attachment${inlineImageCount === 1 ? "" : "s"} below)`);
				return lines.join("\n");
			})
			.join("\n\n");
	const batchSummary = batchFailure === undefined
		? summary
		: `Batch failed: ${batchFailure.successCount}/${batchFailure.totalCount} succeeded`;
	const failureHeader = batchFailure === undefined
		? undefined
		: [
			batchSummary,
			`First failing step: ${batchFailure.failedStep.index + 1} — ${batchFailure.failedStep.commandText}`,
			batchFailure.failureCount > 1 ? `${batchFailure.failureCount} steps failed. See the per-step results below.` : "See the per-step results below.",
		].join("\n");
	const text = failureHeader ? `${failureHeader}\n\n${stepText}` : stepText;
	const artifactRetentionSummary = currentArtifactManifest ? formatSessionArtifactRetentionSummary(currentArtifactManifest) : undefined;
	const contentText = artifactRetentionSummary && manifestHasNewNoticeWorthyEntries(options.artifactManifest, currentArtifactManifest)
		? `${text}\n\n${artifactRetentionSummary}`
		: text;
	const nextActions = batchFailure
		? batchFailure.failedStep.nextActions
		: buildAgentBrowserNextActions({ artifacts, command: "batch", resultCategory: "success" });
	const changedSteps = steps.map((step) => step.details).filter((details) => details.pageChangeSummary !== undefined);
	const pageChangeSummary = artifacts.length > 0
		? buildPageChangeSummary({
			artifacts,
			commandInfo: { command: "batch" },
			data,
			nextActions,
			summary: batchSummary,
		})
		: changedSteps.length > 0
			? {
				changeType: "mutation" as const,
				command: "batch",
				nextActionIds: nextActions?.map((action) => action.id),
				summary: `batch → mutation → ${changedSteps.length} changed step${changedSteps.length === 1 ? "" : "s"}`,
			}
			: undefined;

	return {
		artifactManifest: currentArtifactManifest,
		artifactRetentionSummary,
		artifactVerification,
		artifacts: artifacts.length > 0 ? artifacts : undefined,
		batchFailure,
		batchSteps: steps.map((step) => step.details),
		content: [{ type: "text", text: contentText }, ...images],
		failureCategory: batchFailure?.failedStep.failureCategory,
		data: redactedBatchData,
		fullOutputPath: fullOutputPaths[0],
		fullOutputPaths: fullOutputPaths.length > 0 ? fullOutputPaths : undefined,
		imagePath: imagePaths[0],
		imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
		nextActions,
		pageChangeSummary,
		resultCategory: batchFailure ? "failure" : "success",
		successCategory: batchFailure ? undefined : classifyPresentationSuccessCategory({ artifactVerification, artifacts }),
		summary: batchSummary,
	};
}
