import type { ArtifactVerificationSummary } from "../results/contracts.js";
import { isRecord } from "../parsing.js";
import { truncateText } from "../results/text.js";
import { getBatchResultItems, getCommandNameFromBatchItem } from "./shared.js";
import type { AgentBrowserQaPresetAnalysis, CompiledAgentBrowserQaPreset } from "./types.js";

interface QaPage {
	readonly title?: string | undefined;
	readonly url?: string | undefined;
}

function hasPageContext(page: QaPage | undefined): boolean {
	return (page?.title?.length ?? 0) > 0 || (page?.url?.length ?? 0) > 0;
}

function pageLine(page: QaPage | undefined): string[] {
	const parts = [page?.title, page?.url].filter(
		(part): part is string => typeof part === "string" && part.length > 0,
	);
	return parts.length === 0 ? [] : [`Page: ${parts.join(" — ")}`];
}

function describeChecks(checks: CompiledAgentBrowserQaPreset["checks"]): string {
	const parts = [`load:${checks.loadState}`];
	if (checks.expectedText.length > 0) {
		parts.push(`text×${checks.expectedText.length}`);
	}
	const enabledChecks = [
		["selector", (checks.expectedSelector ?? "").length > 0],
		["network", checks.checkNetwork],
		["console", checks.checkConsole],
		["errors", checks.checkErrors],
	] as const;
	for (const [name, enabled] of enabledChecks) {
		if (enabled) {
			parts.push(name);
		}
	}
	if (checks.diagnosticsResetAtStart) {
		parts.push("diagnostics-reset");
	} else if (hasDiagnostics(checks)) {
		parts.push("attached-diagnostics-preserved");
	}
	if ((checks.screenshotPath ?? "").length > 0) {
		parts.push("screenshot");
	}
	return parts.join(", ");
}

function hasDiagnostics(checks: CompiledAgentBrowserQaPreset["checks"]): boolean {
	return checks.checkNetwork || checks.checkConsole || checks.checkErrors;
}

function isolationLines(checks: CompiledAgentBrowserQaPreset["checks"]): string[] {
	if (!hasDiagnostics(checks)) {
		return [];
	}
	if (checks.diagnosticsResetAtStart) {
		return [
			"Diagnostic isolation: URL QA requests clears of enabled diagnostic buffers before opening the target.",
		];
	}
	if (checks.attached) {
		return [
			"Attached diagnostics: existing upstream session console/network/error buffers were preserved; rows may include events from before qa.attached started.",
		];
	}
	return [];
}

export function extractQaPageContext(options: {
	readonly attachedTarget?: QaPage | undefined;
	readonly batchData?: unknown;
	readonly compiled?: CompiledAgentBrowserQaPreset;
}): QaPage {
	if (hasPageContext(options.attachedTarget)) {
		return { title: options.attachedTarget?.title, url: options.attachedTarget?.url };
	}
	const page = extractBatchPageContext(options.batchData);
	if (page !== undefined) {
		return page;
	}
	const url = options.compiled?.checks.url;
	return url === undefined || url.length === 0 ? {} : { url };
}

function extractBatchPageContext(data: unknown): QaPage | undefined {
	for (const item of getBatchResultItems(data)) {
		if (getCommandNameFromBatchItem(item) !== "open" || !isRecord(item.result)) {
			continue;
		}
		const page = {
			url: typeof item.result.url === "string" ? item.result.url : undefined,
			title: typeof item.result.title === "string" ? item.result.title : undefined,
		};
		if (hasPageContext(page)) {
			return page;
		}
	}
	return undefined;
}

export function buildQaCompactPassText(options: {
	readonly artifactVerification?: ArtifactVerificationSummary | undefined;
	readonly batchStepCount: number;
	readonly checks: CompiledAgentBrowserQaPreset["checks"];
	readonly page?: QaPage;
	readonly qaPreset: AgentBrowserQaPresetAnalysis;
}): string {
	const lines = [options.qaPreset.summary, ...pageLine(options.page)];
	lines.push(
		`Checks run: ${describeChecks(options.checks)} (${options.batchStepCount} batch step${options.batchStepCount === 1 ? "" : "s"})`,
	);
	lines.push(...isolationLines(options.checks));
	const path = options.checks.screenshotPath;
	if (path !== undefined && path.length > 0) {
		const verification = options.artifactVerification;
		lines.push(
			verification
				? `Screenshot: ${path} (${verification.verifiedCount}/${verification.artifacts.length} verified on disk)`
				: `Screenshot: ${path}`,
		);
	}
	lines.push("Full diagnostic matrix: see details.qaPreset and details.batchSteps.");
	return lines.join("\n");
}

export function buildQaCompactFailureText(options: {
	readonly causalError?: string | undefined;
	readonly executedStepCount?: number | undefined;
	readonly page?: QaPage;
	readonly plannedStepCount: number;
	readonly qaPreset: AgentBrowserQaPresetAnalysis;
}): string {
	const error = options.causalError;
	const lines = [
		error !== undefined && error.length > 0
			? truncateText(error.replace(/\s+/g, " ").trim(), 700)
			: options.qaPreset.summary,
		...pageLine(options.page),
	];
	for (const [label, entries] of [
		["Failed checks:", options.qaPreset.failedChecks],
		["Not run:", options.qaPreset.notRunChecks],
		["Warnings:", options.qaPreset.warnings],
	] as const) {
		if (entries.length > 0) {
			lines.push(label, ...entries.map((entry) => `- ${entry}`));
		}
	}
	lines.push(
		`Execution: ${options.executedStepCount ?? "unknown"}/${options.plannedStepCount} batch steps`,
	);
	lines.push("Full diagnostic matrix: see details.qaPreset and details.batchSteps.");
	return lines.join("\n");
}
