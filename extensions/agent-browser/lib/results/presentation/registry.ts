import type { CompiledAgentBrowserSemanticAction } from "../../input-modes/types.js";
import { isRecord } from "../../parsing.js";
import type { CommandInfo } from "../../runtime.js";
import { detectConfirmationRequired, type ConfirmationRequiredPresentation } from "../confirmation.js";
import { formatRawSnapshotText, formatSnapshotSummary } from "../snapshot.js";
import { redactModelFacingText, stringifyModelFacing } from "./common.js";
import { formatDiagnosticSummary, formatDiagnosticText, formatProfilesText, getStreamSummary, getTabSummary } from "./diagnostics.js";
import { getScreenshotSummary } from "./artifacts.js";
import { formatSkillsText } from "./skills.js";
import {
	formatExtractionSummary,
	formatExtractionText,
	formatNavigationActionResult,
	formatNavigationSummary,
	getNavigationSummary,
	isNavigationObservableCommand,
} from "./navigation.js";
import {
	formatSemanticActionPresentationSummary,
	formatSemanticActionPresentationText,
	resolvePresentationCommandInfo,
} from "./semantic-action.js";

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

const VITALS_METRICS = ["lcp", "fcp", "ttfb", "inp", "cls"] as const;

function coerceVitalsMetricValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (isRecord(value)) {
		for (const nestedKey of ["value", "duration", "startTime", "score"] as const) {
			const nestedValue = value[nestedKey];
			if (typeof nestedValue === "number" && Number.isFinite(nestedValue)) return nestedValue;
		}
	}
	return undefined;
}

function getVitalsMetric(data: Record<string, unknown>, key: string): number | undefined {
	const metrics = isRecord(data.metrics) ? data.metrics : undefined;
	return coerceVitalsMetricValue(data[key] ?? data[key.toUpperCase()] ?? metrics?.[key] ?? metrics?.[key.toUpperCase()]);
}

function formatVitalsMetric(key: string, value: number): string {
	return key === "cls" ? `${key.toUpperCase()}: ${value}` : `${key.toUpperCase()}: ${Math.round(value)}ms`;
}

function getVitalsMetrics(data: Record<string, unknown>): string[] {
	return VITALS_METRICS.flatMap((key) => {
		const value = getVitalsMetric(data, key);
		return value === undefined ? [] : [formatVitalsMetric(key, value)];
	});
}

function getVitalsUnavailableReason(data: Record<string, unknown>): string {
	for (const key of ["reason", "message", "error", "status"] as const) {
		const value = data[key];
		if (typeof value === "string" && value.trim().length > 0) return redactModelFacingText(value.trim());
	}
	return "No Core Web Vitals metric fields were present in the upstream result.";
}

function formatVitalsText(data: Record<string, unknown>): string {
	const url = typeof data.url === "string" && data.url.trim().length > 0 ? redactModelFacingText(data.url.trim()) : undefined;
	const metrics = getVitalsMetrics(data);
	const lines = [url ? `Vitals for ${url}` : "Vitals result"];
	if (metrics.length > 0) lines.push(...metrics.map((metric) => `- ${metric}`));
	else lines.push(`Metrics unavailable: ${getVitalsUnavailableReason(data)}`);
	return lines.join("\n");
}

function formatVitalsSummary(data: Record<string, unknown>): string | undefined {
	const metrics = getVitalsMetrics(data);
	if (metrics.length > 0) return `Vitals: ${metrics.join(", ")}`;
	return "Vitals: metrics unavailable";
}

function formatConfirmationRequiredText(confirmation: ConfirmationRequiredPresentation): string {
	const lines = [
		"Confirmation required.",
		`Pending confirmation id: ${confirmation.id}`,
	];
	if (confirmation.actionText) lines.push(`Action: ${confirmation.actionText}`);
	lines.push(
		"",
		"Next steps:",
		`- Approve: { "args": ["confirm", "${confirmation.id}"] }`,
		`- Deny: { "args": ["deny", "${confirmation.id}"] }`,
	);
	return lines.join("\n");
}

interface CommandPresenter {
	summary?: (commandInfo: CommandInfo, data: unknown) => string | undefined;
	text?: (commandInfo: CommandInfo, data: unknown) => string | undefined;
}

const COMMAND_PRESENTERS: Record<string, CommandPresenter> = {
	profiles: {
		summary: (_commandInfo, data) => Array.isArray(data) ? `Chrome profiles: ${data.length}` : undefined,
		text: (_commandInfo, data) => Array.isArray(data) ? formatProfilesText(data, "Chrome profiles") : undefined,
	},
	screenshot: {
		summary: (_commandInfo, data) => isRecord(data) && typeof data.path === "string" ? `Screenshot saved: ${data.path}` : undefined,
		text: (_commandInfo, data) => isRecord(data) ? getScreenshotSummary(data) : undefined,
	},
	skills: {
		summary: (commandInfo, data) => {
			if (Array.isArray(data) && commandInfo.subcommand === "list") return `agent-browser skills: ${data.length}`;
			if (commandInfo.subcommand === "get") return "agent-browser skill loaded";
			if (commandInfo.subcommand === "path") return "agent-browser skill path";
			return undefined;
		},
		text: formatSkillsText,
	},
	snapshot: {
		summary: (_commandInfo, data) => isRecord(data) ? formatSnapshotSummary(data) : undefined,
		text: (_commandInfo, data) => isRecord(data) ? formatRawSnapshotText(data) : undefined,
	},
	stream: {
		summary: (commandInfo, data) => {
			if (!isRecord(data) || commandInfo.subcommand !== "status") return undefined;
			const port = typeof data.port === "number" ? ` on port ${data.port}` : "";
			return `Stream ${data.enabled === true ? "enabled" : "disabled"}${port}`;
		},
		text: (commandInfo, data) => isRecord(data) && commandInfo.subcommand === "status" ? getStreamSummary(data) : undefined,
	},
	tab: {
		summary: (_commandInfo, data) => isRecord(data) && Array.isArray(data.tabs) ? `Tabs: ${data.tabs.length}` : undefined,
		text: (_commandInfo, data) => isRecord(data) ? getTabSummary(data) : undefined,
	},
	vitals: {
		summary: (_commandInfo, data) => isRecord(data) ? formatVitalsSummary(data) : undefined,
		text: (_commandInfo, data) => isRecord(data) ? formatVitalsText(data) : undefined,
	},
	"web-vitals": {
		summary: (_commandInfo, data) => isRecord(data) ? formatVitalsSummary(data) : undefined,
		text: (_commandInfo, data) => isRecord(data) ? formatVitalsText(data) : undefined,
	},
};

function formatBatchSummary(data: unknown): string | undefined {
	if (!Array.isArray(data)) return undefined;
	const successCount = data.filter((item) => isRecord(item) && item.success !== false).length;
	return successCount === data.length
		? `Batch: ${successCount}/${data.length} succeeded`
		: `Batch failed: ${successCount}/${data.length} succeeded`;
}

export function formatPresentationSummary(
	commandInfo: CommandInfo,
	data: unknown,
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction,
): string {
	const confirmationRequired = detectConfirmationRequired(data);
	if (confirmationRequired) return formatConfirmationRequiredSummary(confirmationRequired);

	const presentationCommandInfo = resolvePresentationCommandInfo(commandInfo, compiledSemanticAction);

	if (commandInfo.command === "batch") {
		const batchSummary = formatBatchSummary(data);
		if (batchSummary) return batchSummary;
	}

	if (isRecord(data)) {
		if (compiledSemanticAction) {
			const semanticSummary = formatSemanticActionPresentationSummary(compiledSemanticAction, data);
			if (semanticSummary) return semanticSummary;
		}
		const navigationSummary = getNavigationSummary(data);
		if (navigationSummary && isNavigationObservableCommand(presentationCommandInfo.command)) {
			const navigationText = formatNavigationSummary(navigationSummary);
			if (navigationText) {
				return `${presentationCommandInfo.command ?? "navigation"} → ${navigationText.split("\n", 1)[0] ?? navigationText}`;
			}
		}
	}

	const presenterSummary = commandInfo.command ? COMMAND_PRESENTERS[commandInfo.command]?.summary?.(commandInfo, data) : undefined;
	if (presenterSummary) return presenterSummary;

	if (isRecord(data)) {
		const diagnosticSummary = formatDiagnosticSummary(commandInfo, data);
		if (diagnosticSummary) return diagnosticSummary;
		const extractionSummary = formatExtractionSummary(commandInfo, data);
		if (extractionSummary) return extractionSummary;
		const pageSummary = getPageSummary(data);
		if (pageSummary) return pageSummary.split("\n", 1)[0] ?? "agent-browser result";
	}

	if (typeof data === "string" && data.length > 0) return data.split("\n", 1)[0] ?? data;
	return `${presentationCommandInfo.command ?? commandInfo.command ?? "agent-browser"} completed`;
}

export function formatPresentationContentText(
	commandInfo: CommandInfo,
	data: unknown,
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction,
): string {
	const confirmationRequired = detectConfirmationRequired(data);
	if (confirmationRequired) return formatConfirmationRequiredText(confirmationRequired);

	const presenterText = commandInfo.command ? COMMAND_PRESENTERS[commandInfo.command]?.text?.(commandInfo, data) : undefined;
	if (presenterText) return presenterText;

	if (typeof data === "string") return redactModelFacingText(data);
	if (typeof data === "number" || typeof data === "boolean") return String(data);
	if (!isRecord(data)) return stringifyModelFacing(data);

	if (compiledSemanticAction) {
		const semanticText = formatSemanticActionPresentationText(compiledSemanticAction, data);
		if (semanticText) return semanticText;
	}

	const presentationCommandInfo = resolvePresentationCommandInfo(commandInfo, compiledSemanticAction);
	const navigationSummary = getNavigationSummary(data);
	if (navigationSummary && isNavigationObservableCommand(presentationCommandInfo.command)) {
		const navigationText = formatNavigationSummary(navigationSummary);
		if (navigationText) {
			const actionText = formatNavigationActionResult(data);
			return actionText ? `${actionText}\n\nCurrent page:\n${navigationText}` : `Current page:\n${navigationText}`;
		}
	}

	const extractionText = formatExtractionText(commandInfo, data);
	if (extractionText) return extractionText;
	const diagnosticText = formatDiagnosticText(commandInfo, data);
	if (diagnosticText) return diagnosticText;
	const pageSummary = getPageSummary(data);
	if (pageSummary) return redactModelFacingText(pageSummary);
	return stringifyModelFacing(data);
}
