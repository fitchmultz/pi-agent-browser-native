import type { ProjectedAgentBrowserObservation } from "../contracts.js";
import type { ToolPresentationObservation } from "./observation-contracts.js";
import { isRecord } from "../../parsing.js";
import { redactSensitiveValue } from "../../runtime-redaction.js";
import { omitUpstreamLifecycle } from "./common.js";
import {
	isTimeoutPartialProgress,
	redactTimeoutPartialProgress,
} from "../../orchestration/browser-run/timeout-progress.js";

export type { AgentBrowserObservation, ProjectedAgentBrowserObservation } from "../contracts.js";
export const OBSERVATION_INLINE_MAX_CHARS = 16_000;

const OBSERVATION_DETAIL_FIELDS = [
	"data",
	"error",
	"summary",
	"failureCategory",
	"successCategory",
	"nextActions",
	"warnings",
	"sessionName",
	"namespace",
	"codeRun",
	"failures",
	"artifacts",
	"artifactVerification",
	"imageObservations",
	"fullOutputPath",
	"fullOutputPaths",
	"fullOutputUnavailable",
	"recordingRecovery",
	"readConfirmation",
	"sessionRecoveryHint",
	"pageChangeSummary",
	"timeoutPartialProgress",
	"qaPreset",
	"sourceLookup",
	"networkSourceLookup",
	"networkRouteDiagnostics",
	"webMcpCatalog",
	"clickDispatch",
	"overlayBlockers",
	"fillVerification",
	"visibleRefFallback",
	"richInputRecovery",
	"snapshotDiff",
	"snapshotFilter",
	"snapshotViewport",
	"scrollPage",
	"scrollContainer",
	"comboboxFocus",
	"scrollNoop",
	"selectorTextVisibility",
	"selectorTextVisibilityAll",
	"evalStdinHint",
	"evalResultWarning",
	"electronGetTextScopeWarning",
	"electronGetTextScopeWarnings",
	"recordingDependencyWarning",
];

export function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

export function getPresentationText(presentation: ToolPresentationObservation): string {
	return presentation.content
		.filter((part) => part.type === "text")
		.map((part) => part.text.trim())
		.filter((text) => text.length > 0)
		.join("\n\n");
}

export function getPresentationImages(
	presentation: ToolPresentationObservation,
): Array<Extract<ToolPresentationObservation["content"][number], { type: "image" }>> {
	return presentation.content.filter(
		(part): part is Extract<ToolPresentationObservation["content"][number], { type: "image" }> =>
			part.type === "image",
	);
}

export function getPresentationPaths(options: {
	readonly primaryPath?: string;
	readonly secondaryPaths?: readonly string[];
}): readonly string[] {
	return (
		options.secondaryPaths ??
		(options.primaryPath !== undefined && options.primaryPath.length > 0
			? [options.primaryPath]
			: [])
	);
}

export function formatBatchStepCommand(
	command: readonly string[] | undefined,
	index: number,
): string {
	return command && command.length > 0 ? command.join(" ") : `step-${index + 1}`;
}

function selectObservationFields(
	details: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const observation: Record<string, unknown> = {};
	for (const key of OBSERVATION_DETAIL_FIELDS) {
		if (details[key] !== undefined) {
			observation[key] = details[key];
		}
	}
	if (
		details.inspection === true &&
		details.data === undefined &&
		typeof details.stdout === "string"
	) {
		observation.data = details.stdout;
	}
	// Identical error/summary strings double-count large failure text against the observation bound; keep error.
	if (typeof observation.error === "string" && observation.error === observation.summary) {
		observation.summary = undefined;
	}
	if (isRecord(observation.data)) {
		observation.data = omitUpstreamLifecycle(observation.data);
	}
	if (isTimeoutPartialProgress(observation.timeoutPartialProgress)) {
		observation.timeoutPartialProgress = redactTimeoutPartialProgress(
			observation.timeoutPartialProgress,
		);
	}
	return observation;
}

function projectBatchMetadata(
	step: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const { data: _data, stdout: _stdout, ...metadata } = step;
	return Object.assign(
		{ index: step.index },
		projectAgentBrowserObservation(metadata, step.success !== false),
	);
}

// Shared by direct results and code observations; ownership/replay state stays in details.
export function projectAgentBrowserObservation(
	details: Readonly<Record<string, unknown>>,
	succeeded: boolean,
): ProjectedAgentBrowserObservation {
	const observation = selectObservationFields(details);
	if (Array.isArray(details.batchSteps)) {
		observation.batchSteps = details.batchSteps.filter(isRecord).map(projectBatchMetadata);
	}
	const redacted = redactSensitiveValue(observation);
	if (!isRecord(redacted)) {
		throw new Error("Browser observation redaction must preserve its record shape.");
	}
	// Native stream endpoints are usable browser resource identifiers, not credentials.
	if (isRecord(redacted.data) && isRecord(details.data) && typeof details.data.wsUrl === "string") {
		redacted.data.wsUrl = details.data.wsUrl;
	}
	return { success: succeeded, resultCategory: succeeded ? "success" : "failure", ...redacted };
}
