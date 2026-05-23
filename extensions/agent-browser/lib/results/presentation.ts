/**
 * Purpose: Render parsed agent-browser results into concise pi-facing summaries, text content, and optional inline image attachments.
 * Responsibilities: Format command summaries, delegate snapshot-specific rendering to the snapshot module, attach inline images within size limits, and keep generic record formatting distinct from envelope parsing.
 * Scope: Presentation shaping only; upstream stdout parsing and snapshot compaction internals live in separate modules.
 * Usage: Imported by the public `lib/results.ts` facade and consumed by the extension entrypoint after envelope parsing.
 * Invariants/Assumptions: Presentation logic should stay close to upstream data while remaining small enough to reason about without mixing in snapshot-parser or envelope-parser internals.
 */

import { isRecord } from "../parsing.js";
import { extractCommandTokens, parseCommandInfo, redactInvocationArgs, redactSensitiveText, redactSensitiveValue, type CommandInfo } from "../runtime.js";
import type { PersistentSessionArtifactStore } from "../temp.js";
import { detectConfirmationRequired, type ConfirmationRequiredPresentation } from "./confirmation.js";
import { buildSnapshotPresentation, formatRawSnapshotText, formatSnapshotSummary } from "./snapshot.js";
import type {
	AgentBrowserBatchResult,
	AgentBrowserEnvelope,
	AgentBrowserNextAction,
	AgentBrowserPageChangeSummary,
	ArtifactStorageScope,
	ArtifactVerificationEntry,
	ArtifactVerificationSummary,
	BatchFailurePresentationDetails,
	BatchStepPresentationDetails,
	FileArtifactKind,
	FileArtifactMetadata,
	SavedFilePresentationDetails,
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
	ToolPresentation,
} from "./contracts.js";
import { buildAgentBrowserNextActions } from "./action-recommendations.js";
import {
	buildAgentBrowserResultCategoryDetails,
	classifyAgentBrowserFailureCategory,
} from "./categories.js";
import { formatSessionArtifactRetentionSummary } from "./artifact-manifest.js";
import { withOptionalSessionArgs } from "./next-actions.js";
import { stringifyUnknown } from "./text.js";
import {
	getArrayField,
	getStringField,
	parseJsonPreviewString,
	redactModelFacingText,
	redactModelFacingTextIfSensitive,
	stringifyModelFacing,
} from "./presentation/common.js";
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
	getSavedFileDetails,
	getScreenshotSummary,
	isManifestFileArtifact,
	manifestHasNewNoticeWorthyEntries,
	type ArtifactRequestContext,
} from "./presentation/artifacts.js";
import {
	buildNetworkRequestsNextActions,
	enrichStreamStatusData,
	formatDiagnosticSummary,
	formatDiagnosticText,
	formatProfilesText,
	getStreamSummary,
	getTabSummary,
	redactPresentationData,
} from "./presentation/diagnostics.js";
import { formatSkillsText } from "./presentation/skills.js";
import {
	formatBatchStepCommand,
	getPresentationImages,
	getPresentationPaths,
	getPresentationText,
	isStringArray,
} from "./presentation/content.js";
import { compactLargePresentationOutput } from "./presentation/large-output.js";
import {
	buildPageChangeSummary,
	formatExtractionSummary,
	formatExtractionText,
	formatNavigationActionResult,
	formatNavigationSummary,
	getNavigationSummary,
	isNavigationObservableCommand,
} from "./presentation/navigation.js";




































































function getPageSummary(data: Record<string, unknown>): string | undefined {
	const title = typeof data.title === "string" ? data.title : undefined;
	const url = typeof data.url === "string" ? data.url : undefined;
	if (!title && !url) return undefined;
	if (title && url) return `${title}\n${url}`;
	return title ?? url;
}

function formatConfirmationRequiredSummary(confirmation: ConfirmationRequiredPresentation): string {
	return `Confirmation required: ${confirmation.id}`;
}

function formatConfirmationRequiredText(confirmation: ConfirmationRequiredPresentation): string {
	const lines = [
		"Confirmation required.",
		`Pending confirmation id: ${confirmation.id}`,
	];
	if (confirmation.actionText) {
		lines.push(`Action: ${confirmation.actionText}`);
	}
	lines.push(
		"",
		"Next steps:",
		`- Approve: { "args": ["confirm", "${confirmation.id}"] }`,
		`- Deny: { "args": ["deny", "${confirmation.id}"] }`,
	);
	return lines.join("\n");
}









































const STALE_REF_ERROR_HINT = [
	"Agent-browser hint: This ref may be stale after navigation, scrolling, or re-rendering.",
	"Run `snapshot -i` again and retry with a current `@e…` ref; for less ref churn, use `find role|text|label|placeholder|alt|title|testid ...` or `scrollintoview` before interacting with off-screen elements.",
].join(" ");

const SELECTOR_DIALECT_ERROR_HINT = [
	"Agent-browser hint: This selector may use an unsupported selector dialect.",
	"Prefer refs from `snapshot -i`, or use supported `find role|text|label|placeholder|alt|title|testid ...` locators; use `scrollintoview` before interacting with off-screen elements.",
].join(" ");

function getSelectorRecoveryHint(errorText: string): string | undefined {
	const normalized = errorText.trim();
	if (normalized.length === 0) {
		return undefined;
	}

	if (/\bUnknown ref\b|\bstale ref\b|\bref\b.*\b(?:not found|missing|expired)\b/i.test(normalized)) {
		return STALE_REF_ERROR_HINT;
	}

	const mentionsPlaywrightSelectorDialect = /(?:\btext=|:has-text\(|\bgetByRole\b|\bgetByText\b)/i.test(normalized);
	const reportsSelectorMatchFailure =
		/\b(?:no elements? found|failed to find|could not find|unable to find)\b.*\b(?:selector|locator)\b/i.test(normalized) ||
		/\b(?:selector|locator)\b.*\b(?:no elements? found|not found|missing|failed to find|could not find|unable to find)\b/i.test(
			normalized,
		);

	if (
		/\b(?:unsupported|unknown|invalid)\s+(?:selector|locator)\b/i.test(normalized) ||
		/\bfailed to parse selector\b/i.test(normalized) ||
		/\bselector\b.*\b(?:parse|syntax|unsupported|invalid)\b/i.test(normalized) ||
		(mentionsPlaywrightSelectorDialect && reportsSelectorMatchFailure)
	) {
		return SELECTOR_DIALECT_ERROR_HINT;
	}

	return undefined;
}

interface CommandSuggestion {
	args?: string[];
	description: string;
	id?: string;
}

const UNKNOWN_COMMAND_SUGGESTIONS: Record<string, CommandSuggestion[]> = {
	attr: [
		{ description: "Use `get attr <selector> <name>` to read an attribute from a selector or current `@ref`." },
	],
	count: [
		{ description: "Use `get count <selector>` to count matching elements." },
	],
	html: [
		{ description: "Use `get html <selector>` to read element HTML, or `get html` for the page when upstream supports it." },
	],
	text: [
		{ description: "Use `get text <selector>` to read text from a selector or current `@ref`; run `snapshot -i` first when you need a safe `@ref`." },
	],
	title: [
		{ args: ["get", "title"], description: "Use `get title` to read the current page title.", id: "use-get-title" },
	],
	url: [
		{ args: ["get", "url"], description: "Use `get url` to read the current page URL.", id: "use-get-url" },
	],
	value: [
		{ description: "Use `get value <selector>` to read form control value from a selector or current `@ref`." },
	],
};

function getUnknownCommandSuggestions(command: string | undefined, errorText: string): CommandSuggestion[] {
	if (!command) return [];
	const normalizedCommand = command.trim().toLowerCase();
	if (!/\bunknown\s+command\b|\bunknown\s+subcommand\b|\bunrecognized\s+command\b/i.test(errorText)) return [];
	return UNKNOWN_COMMAND_SUGGESTIONS[normalizedCommand] ?? [];
}

function formatUnknownCommandSuggestionText(suggestions: CommandSuggestion[]): string | undefined {
	if (suggestions.length === 0) return undefined;
	return ["Agent-browser hint: This looks like a getter shortcut, but upstream getter commands are grouped under `get`.", ...suggestions.map((suggestion) => suggestion.description)].join(" ");
}

function buildUnknownCommandSuggestionActions(suggestions: CommandSuggestion[], sessionName: string | undefined): AgentBrowserNextAction[] | undefined {
	const actions = suggestions
		.filter((suggestion): suggestion is CommandSuggestion & { args: string[]; id: string } => suggestion.args !== undefined && suggestion.id !== undefined)
		.map((suggestion) => ({
			id: suggestion.id,
			params: { args: withOptionalSessionArgs(sessionName, suggestion.args) },
			reason: suggestion.description,
			safety: "Read-only getter command; safe to retry when you intended to inspect page state.",
			tool: "agent_browser" as const,
		}));
	return actions.length > 0 ? actions : undefined;
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

function appendSelectorRecoveryHint(errorText: string): string {
	const hint = getSelectorRecoveryHint(errorText);
	if (!hint || errorText.includes("Agent-browser hint:")) {
		return errorText;
	}
	return `${errorText}\n\n${hint}`;
}

function formatBatchStepError(error: unknown): string {
	const errorText = stringifyModelFacing(error).trim();
	const formattedErrorText = errorText.length > 0 ? `Error: ${errorText}` : "Error: batch step failed.";
	return appendSelectorRecoveryHint(formattedErrorText);
}

function getBatchFailureDetails(steps: Array<{ details: BatchStepPresentationDetails }>): BatchFailurePresentationDetails | undefined {
	const failedSteps = steps.filter((step) => step.details.success === false);
	if (failedSteps.length === 0) {
		return undefined;
	}
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
	cwd: string;
	index: number;
	item: AgentBrowserBatchResult;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
}): Promise<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> {
	const { artifactManifest, artifactRequest, cwd, index, item, persistentArtifactStore, sessionName } = options;
	const command = isStringArray(item.command) ? item.command : undefined;
	const redactedCommand = command ? redactInvocationArgs(command) : undefined;
	const commandText = formatBatchStepCommand(hasModelFacingArgRedaction(redactedCommand) ? redactedCommand : command, index);

	if (item.success === false) {
		const redactedErrorData = redactExactValues(item.error, getStatefulCommandSensitiveValues(command));
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

	const presentation = await buildToolPresentation({
		artifactManifest,
		artifactRequest,
		commandInfo: parseCommandInfo(command ?? []),
		cwd,
		args: command,
		envelope: { data: item.result, success: true },
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
	const nextActions = presentation.nextActions ?? buildAgentBrowserNextActions({
		artifacts: presentation.artifacts,
		args: command,
		command: command?.[0],
		resultCategory: "success",
		savedFilePath: presentation.savedFilePath,
		successCategory: presentation.successCategory,
	});
	const pageChangeSummary = buildPageChangeSummary({
		artifacts: presentation.artifacts,
		commandInfo: parseCommandInfo(command ?? []),
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
			fullOutputPath: fullOutputPaths[0],
			fullOutputPaths: fullOutputPaths.length > 0 ? fullOutputPaths : undefined,
			imagePath: imagePaths[0],
			imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
			index,
			nextActions,
			pageChangeSummary,
			resultCategory: "success",
			savedFile: presentation.savedFile,
			savedFilePath: presentation.savedFilePath,
			success: true,
			successCategory: classifyPresentationSuccessCategory({ artifactVerification: presentation.artifactVerification, artifacts: presentation.artifacts, savedFile: presentation.savedFile }),
			summary: presentation.summary,
			text,
		},
		presentation,
	};
}

async function buildBatchPresentation(options: {
	artifactManifest?: SessionArtifactManifest;
	artifactRequests?: Array<ArtifactRequestContext | undefined>;
	cwd: string;
	data: AgentBrowserBatchResult[];
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
	summary: string;
}): Promise<ToolPresentation> {
	const { artifactRequests, cwd, data, persistentArtifactStore, sessionName, summary } = options;
	const steps: Array<{ details: BatchStepPresentationDetails; presentation: ToolPresentation }> = [];
	const protectedPersistentPaths: string[] = [];
	let currentArtifactManifest = options.artifactManifest;
	for (const [index, item] of data.entries()) {
		const step = await buildBatchStepPresentation({
			artifactManifest: currentArtifactManifest,
			artifactRequest: artifactRequests?.[index],
			cwd,
			index,
			item,
			persistentArtifactStore: persistentArtifactStore
				? { ...persistentArtifactStore, protectedPaths: protectedPersistentPaths }
				: undefined,
			sessionName,
		});
		steps.push(step);
		currentArtifactManifest = step.presentation.artifactManifest ?? currentArtifactManifest;
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
	const stepText =
		steps.length === 0
			? "(no batch steps)"
			: steps
				.map(({ details, presentation }) => {
					const inlineImageCount = getPresentationImages(presentation).length;
					const status = details.success ? "succeeded" : "failed";
					const lines = [`Step ${details.index + 1} — ${details.commandText} (${status})`];
					if (details.text.length > 0) {
						lines.push(details.text);
					}
					if (inlineImageCount > 0) {
						lines.push(`(${inlineImageCount} inline image attachment${inlineImageCount === 1 ? "" : "s"} below)`);
					}
					return lines.join("\n");
				})
				.join("\n\n");
	const failureHeader =
		batchFailure === undefined
			? undefined
			: [
					summary,
					`First failing step: ${batchFailure.failedStep.index + 1} — ${batchFailure.failedStep.commandText}`,
					batchFailure.failureCount > 1
						? `${batchFailure.failureCount} steps failed. See the per-step results below.`
						: "See the per-step results below.",
				].join("\n");
	const text = failureHeader ? `${failureHeader}\n\n${stepText}` : stepText;

	const artifactRetentionSummary = currentArtifactManifest ? formatSessionArtifactRetentionSummary(currentArtifactManifest) : undefined;
	const contentText = artifactRetentionSummary && manifestHasNewNoticeWorthyEntries(options.artifactManifest, currentArtifactManifest) ? `${text}\n\n${artifactRetentionSummary}` : text;

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
			summary,
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
		summary,
	};
}

function formatSummary(commandInfo: CommandInfo, data: unknown): string {
	const confirmationRequired = detectConfirmationRequired(data);
	if (confirmationRequired) {
		return formatConfirmationRequiredSummary(confirmationRequired);
	}

	if (Array.isArray(data) && commandInfo.command === "batch") {
		const successCount = data.filter((item) => isRecord(item) && item.success !== false).length;
		return successCount === data.length ? `Batch: ${successCount}/${data.length} succeeded` : `Batch failed: ${successCount}/${data.length} succeeded`;
	}
	if (Array.isArray(data) && commandInfo.command === "profiles") {
		return `Chrome profiles: ${data.length}`;
	}
	if (Array.isArray(data) && commandInfo.command === "skills" && commandInfo.subcommand === "list") {
		return `agent-browser skills: ${data.length}`;
	}
	if (commandInfo.command === "skills" && commandInfo.subcommand === "get") {
		return "agent-browser skill loaded";
	}
	if (commandInfo.command === "skills" && commandInfo.subcommand === "path") {
		return "agent-browser skill path";
	}
	if (isRecord(data)) {
		const navigationSummary = getNavigationSummary(data);
		if (navigationSummary && isNavigationObservableCommand(commandInfo.command)) {
			const navigationText = formatNavigationSummary(navigationSummary);
			if (navigationText) {
				return `${commandInfo.command ?? "navigation"} → ${navigationText.split("\n", 1)[0] ?? navigationText}`;
			}
		}
		if (commandInfo.command === "snapshot") {
			return formatSnapshotSummary(data);
		}
		if (commandInfo.command === "tab" && Array.isArray(data.tabs)) {
			return `Tabs: ${data.tabs.length}`;
		}
		if (commandInfo.command === "stream" && commandInfo.subcommand === "status") {
			const port = typeof data.port === "number" ? ` on port ${data.port}` : "";
			return `Stream ${data.enabled === true ? "enabled" : "disabled"}${port}`;
		}
		if (commandInfo.command === "screenshot" && typeof data.path === "string") {
			return `Screenshot saved: ${data.path}`;
		}
		const diagnosticSummary = formatDiagnosticSummary(commandInfo, data);
		if (diagnosticSummary) {
			return diagnosticSummary;
		}
		const extractionSummary = formatExtractionSummary(commandInfo, data);
		if (extractionSummary) {
			return extractionSummary;
		}
		const pageSummary = getPageSummary(data);
		if (pageSummary) {
			return pageSummary.split("\n", 1)[0] ?? "agent-browser result";
		}
	}

	if (typeof data === "string" && data.length > 0) {
		return data.split("\n", 1)[0] ?? data;
	}

	const primaryCommand = commandInfo.command ?? "agent-browser";
	return `${primaryCommand} completed`;
}

function formatContentText(commandInfo: CommandInfo, data: unknown): string {
	const confirmationRequired = detectConfirmationRequired(data);
	if (confirmationRequired) {
		return formatConfirmationRequiredText(confirmationRequired);
	}

	const skillsText = formatSkillsText(commandInfo, data);
	if (skillsText) {
		return skillsText;
	}
	if (typeof data === "string") {
		return redactModelFacingText(data);
	}
	if (typeof data === "number" || typeof data === "boolean") {
		return String(data);
	}
	if (Array.isArray(data) && commandInfo.command === "profiles") {
		return formatProfilesText(data, "Chrome profiles");
	}
	if (!isRecord(data)) {
		return stringifyModelFacing(data);
	}

	const navigationSummary = getNavigationSummary(data);
	if (navigationSummary && isNavigationObservableCommand(commandInfo.command)) {
		const navigationText = formatNavigationSummary(navigationSummary);
		if (navigationText) {
			const actionText = formatNavigationActionResult(data);
			return actionText ? `${actionText}\n\nCurrent page:\n${navigationText}` : `Current page:\n${navigationText}`;
		}
	}

	if (commandInfo.command === "snapshot") {
		return formatRawSnapshotText(data);
	}
	if (commandInfo.command === "tab") {
		const tabSummary = getTabSummary(data);
		if (tabSummary) return tabSummary;
	}
	if (commandInfo.command === "stream" && commandInfo.subcommand === "status") {
		const streamSummary = getStreamSummary(data);
		if (streamSummary) return streamSummary;
	}
	if (commandInfo.command === "screenshot") {
		const screenshotSummary = getScreenshotSummary(data);
		if (screenshotSummary) return screenshotSummary;
	}
	const extractionText = formatExtractionText(commandInfo, data);
	if (extractionText) {
		return extractionText;
	}

	const diagnosticText = formatDiagnosticText(commandInfo, data);
	if (diagnosticText) {
		return diagnosticText;
	}

	const pageSummary = getPageSummary(data);
	if (pageSummary) {
		return redactModelFacingText(pageSummary);
	}

	return stringifyModelFacing(data);
}



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


export async function buildToolPresentation(options: {
	artifactManifest?: SessionArtifactManifest;
	args?: string[];
	artifactRequest?: ArtifactRequestContext;
	batchArtifactRequests?: Array<ArtifactRequestContext | undefined>;
	commandInfo: CommandInfo;
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	errorText?: string;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	sessionName?: string;
}): Promise<ToolPresentation> {
	const { args, artifactManifest, artifactRequest, commandInfo, cwd, envelope, errorText, persistentArtifactStore, sessionName } = options;
	if (errorText) {
		const safeErrorText = redactModelFacingText(errorText);
		const selectorHintedErrorText = appendSelectorRecoveryHint(safeErrorText);
		const unknownCommandSuggestions = getUnknownCommandSuggestions(commandInfo.command, safeErrorText);
		const unknownCommandSuggestionText = formatUnknownCommandSuggestionText(unknownCommandSuggestions);
		const hintedErrorText = unknownCommandSuggestionText && !selectorHintedErrorText.includes("Agent-browser hint:")
			? `${selectorHintedErrorText}\n\n${unknownCommandSuggestionText}`
			: selectorHintedErrorText;
		const categoryDetails = buildAgentBrowserResultCategoryDetails({ args: [commandInfo.command, commandInfo.subcommand].filter((item): item is string => item !== undefined), command: commandInfo.command, errorText: hintedErrorText, succeeded: false });
		const nextActions = [
			...(buildUnknownCommandSuggestionActions(unknownCommandSuggestions, sessionName) ?? []),
			...(buildAgentBrowserNextActions({ args, command: commandInfo.command, failureCategory: categoryDetails.failureCategory, resultCategory: "failure" }) ?? []),
		];
		return {
			...categoryDetails,
			content: [{ type: "text", text: hintedErrorText }],
			nextActions: nextActions.length > 0 ? nextActions : undefined,
			summary: hintedErrorText,
		};
	}

	const data = enrichStreamStatusData(commandInfo, envelope?.data);
	const presentationData = redactPresentationData(commandInfo, data);
	const artifacts = await extractFileArtifacts({ artifactRequest, commandInfo, cwd, data, sessionName });
	const artifactVerification = buildArtifactVerificationSummary(artifacts);
	const artifactSummary = formatArtifactSummary(artifacts);
	const summary = artifactSummary ?? formatSummary(commandInfo, data);
	const artifactText = artifacts.length > 0 ? formatArtifactMetadataLines(artifacts).join("\n") : undefined;
	const presentation =
		commandInfo.command === "batch" && Array.isArray(data)
			? await buildBatchPresentation({ artifactManifest, artifactRequests: options.batchArtifactRequests, cwd, data: data as AgentBrowserBatchResult[], persistentArtifactStore, sessionName, summary })
			: commandInfo.command === "snapshot" && isRecord(data)
				? await buildSnapshotPresentation(data, persistentArtifactStore, artifactManifest)
				: {
						artifactVerification,
						artifacts: artifacts.length > 0 ? artifacts : undefined,
						content: [{ type: "text" as const, text: artifactText ?? formatContentText(commandInfo, data) }],
						data: presentationData,
						summary,
				  };
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
	if (!presentationWithManifest.resultCategory) {
		const categoryDetails = buildAgentBrowserResultCategoryDetails({
			artifacts: presentationWithManifest.artifacts,
			command: commandInfo.command,
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
		command: commandInfo.command,
		confirmationId: confirmationRequired?.id,
		failureCategory: presentationWithManifest.failureCategory,
		resultCategory: presentationWithManifest.resultCategory ?? "success",
		savedFilePath: presentationWithManifest.savedFilePath,
		successCategory: presentationWithManifest.successCategory,
	});
	const networkNextActions = commandInfo.command === "network" && commandInfo.subcommand === "requests" && presentationWithManifest.resultCategory === "success"
		? buildNetworkRequestsNextActions(data, sessionName)
		: undefined;
	presentationWithManifest.nextActions = mergeNextActions(presentationWithManifest.nextActions, genericNextActions, networkNextActions);
	presentationWithManifest.pageChangeSummary = presentationWithManifest.pageChangeSummary ?? buildPageChangeSummary({
		artifacts: presentationWithManifest.artifacts,
		commandInfo,
		data,
		nextActions: presentationWithManifest.nextActions,
		savedFilePath: presentationWithManifest.savedFilePath,
		summary: presentationWithManifest.summary,
	});
	return sanitizeModelFacingPresentation(presentationWithManifest);
}
