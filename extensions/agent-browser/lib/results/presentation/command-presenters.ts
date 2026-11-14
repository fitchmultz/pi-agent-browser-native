import { isRecord } from "../../parsing.js";
import type { CommandInfo } from "../../argv-descriptor.js";
import { formatRawSnapshotText, formatSnapshotSummary } from "../snapshot-content.js";
import { getScreenshotSummary } from "./artifacts.js";
import { formatProfilesText, getStreamSummary, getTabSummary } from "./diagnostics.js";
import { formatSkillsText } from "./skills.js";
import { getNavigationSummary } from "./navigation.js";
import { redactModelFacingText } from "./common.js";

export interface CommandPresenter {
	readonly summary?: (commandInfo: CommandInfo, data: unknown) => string | undefined;
	readonly text?: (commandInfo: CommandInfo, data: unknown) => string | undefined;
}

const SIMPLE_ACTION_RESULTS: Readonly<
	Partial<Record<string, { readonly field: string; readonly label: string }>>
> = {
	check: { field: "checked", label: "Checked" },
	click: { field: "clicked", label: "Clicked" },
	fill: { field: "filled", label: "Filled" },
	focus: { field: "focused", label: "Focused" },
	hover: { field: "hovered", label: "Hovered" },
	press: { field: "pressed", label: "Pressed" },
	select: { field: "selected", label: "Selected" },
	type: { field: "typed", label: "Typed" },
	uncheck: { field: "unchecked", label: "Unchecked" },
};

function formatSimpleActionResult(command: string, data: unknown): string | undefined {
	if (!isRecord(data) || (command === "click" && getNavigationSummary(data) !== undefined)) {
		return undefined;
	}
	const definition = SIMPLE_ACTION_RESULTS[command];
	if (!definition) {
		return undefined;
	}
	const value = data[definition.field];
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? `${definition.label}: ${redactModelFacingText(String(value))}`
		: undefined;
}

function formatWaitResult(data: unknown): string | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	if (data.waited === "timeout") {
		return "Fixed wait elapsed; no page condition was verified.";
	}
	for (const field of ["selector", "text", "url", "state", "waited"]) {
		const value = data[field];
		if (typeof value === "string" && value.length > 0) {
			return `Wait completed: ${redactModelFacingText(value)}`;
		}
	}
	return undefined;
}

function formatCloseResult(data: unknown): string | undefined {
	return isRecord(data) && data.closed === true ? "Browser session closed." : undefined;
}

function coerceVitalsMetricValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (isRecord(value)) {
		for (const key of ["value", "duration", "startTime", "score"]) {
			const nested = value[key];
			if (typeof nested === "number" && Number.isFinite(nested)) {
				return nested;
			}
		}
	}
	return undefined;
}

function getVitalsMetric(data: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const metrics = isRecord(data.metrics) ? data.metrics : undefined;
	return coerceVitalsMetricValue(
		data[key] ?? data[key.toUpperCase()] ?? metrics?.[key] ?? metrics?.[key.toUpperCase()],
	);
}

function getVitalsMetrics(data: Readonly<Record<string, unknown>>): string[] {
	return ["lcp", "fcp", "ttfb", "inp", "cls"].flatMap((key) => {
		const value = getVitalsMetric(data, key);
		if (value === undefined) {
			return [];
		}
		return [
			key === "cls"
				? `${key.toUpperCase()}: ${value}`
				: `${key.toUpperCase()}: ${Math.round(value)}ms`,
		];
	});
}

function getVitalsUnavailableReason(data: Readonly<Record<string, unknown>>): string {
	for (const key of ["reason", "message", "error", "status"]) {
		const value = data[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return redactModelFacingText(value.trim());
		}
	}
	return "No Core Web Vitals metric fields were present in the upstream result.";
}

function formatVitalsText(data: Readonly<Record<string, unknown>>): string {
	const url =
		typeof data.url === "string" && data.url.trim().length > 0
			? redactModelFacingText(data.url.trim())
			: undefined;
	const metrics = getVitalsMetrics(data);
	return [
		url !== undefined && url.length > 0 ? `Vitals for ${url}` : "Vitals result",
		...(metrics.length > 0
			? metrics.map((metric) => `- ${metric}`)
			: [`Metrics unavailable: ${getVitalsUnavailableReason(data)}`]),
	].join("\n");
}

function formatVitalsSummary(data: Readonly<Record<string, unknown>>): string {
	const metrics = getVitalsMetrics(data);
	return metrics.length > 0 ? `Vitals: ${metrics.join(", ")}` : "Vitals: metrics unavailable";
}

function formatReadSummary(data: unknown): string | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	const url = data.finalUrl ?? data.url;
	return typeof url === "string" ? `Read: ${url}` : undefined;
}

function formatScreenshotSummary(data: unknown): string | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	if (data.changed === false) {
		return getScreenshotSummary(data);
	}
	return typeof data.path === "string" ? `Screenshot saved: ${data.path}` : undefined;
}

function formatTabSummary(data: unknown): string | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	if (Array.isArray(data.tabs)) {
		return `Tabs: ${data.tabs.length}`;
	}
	return data.closed === true ? "Tab closed" : undefined;
}

function formatTabText(data: unknown): string | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	if (data.closed === true) {
		return `Tab closed${typeof data.tabId === "string" ? `: ${redactModelFacingText(data.tabId)}` : "."}`;
	}
	return getTabSummary(data);
}

function readPluginName(data: Readonly<Record<string, unknown>>): string | undefined {
	return isRecord(data.plugin) && typeof data.plugin.name === "string"
		? redactModelFacingText(data.plugin.name)
		: undefined;
}

function formatPluginsSummary(commandInfo: CommandInfo, data: unknown): string | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	if (Array.isArray(data.plugins)) {
		return `agent-browser plugins: ${data.plugins.length}`;
	}
	const name = readPluginName(data);
	if (commandInfo.subcommand === "add" || commandInfo.subcommand === "install") {
		return name !== undefined ? `Plugin configured: ${name}` : "Plugin configured";
	}
	if (commandInfo.subcommand === "show" && isRecord(data.plugin)) {
		return name !== undefined ? `Plugin: ${name}` : "Plugin details";
	}
	return undefined;
}

const PLUGIN_PRESENTER: CommandPresenter = {
	summary: formatPluginsSummary,
};

export const COMMAND_PRESENTERS: Readonly<Partial<Record<string, CommandPresenter>>> = {
	...Object.fromEntries(
		Object.keys(SIMPLE_ACTION_RESULTS).map((command) => [
			command,
			{
				summary: (_commandInfo: CommandInfo, data: unknown) =>
					formatSimpleActionResult(command, data),
				text: (_commandInfo: CommandInfo, data: unknown) => formatSimpleActionResult(command, data),
			},
		]),
	),
	close: {
		summary: (_commandInfo, data) => formatCloseResult(data),
		text: (_commandInfo, data) => formatCloseResult(data),
	},
	exit: {
		summary: (_commandInfo, data) => formatCloseResult(data),
		text: (_commandInfo, data) => formatCloseResult(data),
	},
	quit: {
		summary: (_commandInfo, data) => formatCloseResult(data),
		text: (_commandInfo, data) => formatCloseResult(data),
	},
	wait: {
		summary: (_commandInfo, data) => formatWaitResult(data),
		text: (_commandInfo, data) => formatWaitResult(data),
	},
	plugin: PLUGIN_PRESENTER,
	plugins: PLUGIN_PRESENTER,
	profiles: {
		summary: (_commandInfo, data) =>
			Array.isArray(data) ? `Chrome profiles: ${data.length}` : undefined,
		text: (_commandInfo, data) =>
			Array.isArray(data) ? formatProfilesText(data, "Chrome profiles") : undefined,
	},
	read: {
		summary: (_commandInfo, data) => formatReadSummary(data),
		text: (_commandInfo, data) =>
			isRecord(data) && typeof data.content === "string"
				? redactModelFacingText(data.content)
				: undefined,
	},
	screenshot: {
		summary: (_commandInfo, data) => formatScreenshotSummary(data),
		text: (_commandInfo, data) => (isRecord(data) ? getScreenshotSummary(data) : undefined),
	},
	skills: {
		summary: (commandInfo, data) => {
			if (
				Array.isArray(data) &&
				(commandInfo.subcommand === undefined || commandInfo.subcommand === "list")
			) {
				return `agent-browser skills: ${data.length}`;
			}
			if (commandInfo.subcommand === "get") {
				return "agent-browser skill loaded";
			}
			return commandInfo.subcommand === "path" ? "agent-browser skill path" : undefined;
		},
		text: formatSkillsText,
	},
	snapshot: {
		summary: (_commandInfo, data) => (isRecord(data) ? formatSnapshotSummary(data) : undefined),
		text: (_commandInfo, data) => (isRecord(data) ? formatRawSnapshotText(data) : undefined),
	},
	stream: {
		summary: (commandInfo, data) => {
			if (!isRecord(data) || commandInfo.subcommand !== "status") {
				return;
			}
			const port = typeof data.port === "number" ? ` on port ${data.port}` : "";
			return `Stream ${data.enabled === true ? "enabled" : "disabled"}${port}`;
		},
		text: (commandInfo, data) =>
			isRecord(data) && commandInfo.subcommand === "status" ? getStreamSummary(data) : undefined,
	},
	tab: {
		summary: (_commandInfo, data) => formatTabSummary(data),
		text: (_commandInfo, data) => formatTabText(data),
	},
	vitals: {
		summary: (_commandInfo, data) => (isRecord(data) ? formatVitalsSummary(data) : undefined),
		text: (_commandInfo, data) => (isRecord(data) ? formatVitalsText(data) : undefined),
	},
	"web-vitals": {
		summary: (_commandInfo, data) => (isRecord(data) ? formatVitalsSummary(data) : undefined),
		text: (_commandInfo, data) => (isRecord(data) ? formatVitalsText(data) : undefined),
	},
};
