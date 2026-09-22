import type { AgentBrowserObservation, ToolPresentation } from "../contracts.js";
import { isRecord } from "../../parsing.js";
import { redactSensitiveValue } from "../../runtime.js";
import { omitUpstreamLifecycle } from "./common.js";
import { redactTimeoutPartialProgress } from "../../orchestration/browser-run/diagnostics.js";

export type { AgentBrowserObservation } from "../contracts.js";

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function getPresentationText(presentation: ToolPresentation): string {
	return presentation.content
		.filter((part): part is Extract<ToolPresentation["content"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.text.trim())
		.filter((text) => text.length > 0)
		.join("\n\n");
}

export function getPresentationImages(presentation: ToolPresentation): Array<Extract<ToolPresentation["content"][number], { type: "image" }>> {
	return presentation.content.filter(
		(part): part is Extract<ToolPresentation["content"][number], { type: "image" }> => part.type === "image",
	);
}

export function getPresentationPaths(options: {
	primaryPath?: string;
	secondaryPaths?: string[];
}): string[] {
	return options.secondaryPaths ?? (options.primaryPath ? [options.primaryPath] : []);
}

export function formatBatchStepCommand(command: string[] | undefined, index: number): string {
	return command && command.length > 0 ? command.join(" ") : `step-${index + 1}`;
}

// Shared by direct results and code observations; ownership/replay state stays in details.
export function projectAgentBrowserObservation(details: Record<string, unknown>, succeeded: boolean): AgentBrowserObservation {
	const observation: Record<string, unknown> = { success: succeeded, resultCategory: succeeded ? "success" : "failure" };
	for (const key of [
		"data", "error", "summary", "failureCategory", "successCategory", "nextActions", "warnings",
		"sessionName", "namespace", "codeRun", "failures",
		"artifacts", "artifactVerification", "imageObservations", "fullOutputPath", "fullOutputPaths", "fullOutputUnavailable",
		"recordingRecovery", "readConfirmation", "sessionRecoveryHint", "pageChangeSummary", "timeoutPartialProgress",
		"qaPreset", "sourceLookup", "networkSourceLookup", "networkRouteDiagnostics", "webMcpCatalog",
		"clickDispatch", "overlayBlockers", "fillVerification", "visibleRefFallback", "richInputRecovery",
		"snapshotDiff", "snapshotFilter", "snapshotViewport", "scrollPage", "scrollContainer",
		"comboboxFocus", "scrollNoop", "selectorTextVisibility", "selectorTextVisibilityAll", "evalStdinHint", "evalResultWarning",
		"electronGetTextScopeWarning", "electronGetTextScopeWarnings", "recordingDependencyWarning",
	]) {
		if (details[key] !== undefined) observation[key] = details[key];
	}
	if (details.inspection === true && details.data === undefined && typeof details.stdout === "string") observation.data = details.stdout;
	if (isRecord(observation.data)) observation.data = omitUpstreamLifecycle(observation.data);
	if (Array.isArray(details.batchSteps)) {
		observation.batchSteps = details.batchSteps.filter(isRecord).map(step => {
			const { data: _data, ...metadata } = projectAgentBrowserObservation(step, step.success !== false);
			return { index: step.index, ...metadata };
		});
	}
	if (observation.timeoutPartialProgress) observation.timeoutPartialProgress = redactTimeoutPartialProgress(observation.timeoutPartialProgress as Parameters<typeof redactTimeoutPartialProgress>[0]);
	const redacted = redactSensitiveValue(observation) as Record<string, unknown>;
	// Native stream endpoints are usable browser resource identifiers, not credentials.
	if (isRecord(redacted.data) && isRecord(details.data) && typeof details.data.wsUrl === "string") redacted.data.wsUrl = details.data.wsUrl;
	return redacted as AgentBrowserObservation;
}
