import type { ElectronLaunchStatus } from "../../electron/cleanup.js";
import { boundElectronProbeString } from "../../electron/cdp.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type { CompiledAgentBrowserElectron } from "../../input-modes/types.js";
import { buildAgentBrowserNextActions } from "../../results/action-recommendations.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { appendUniqueAgentBrowserNextActions } from "../../results/next-actions.js";
import { redactSensitiveText } from "../../runtime-redaction.js";
import { isAboutBlankUrl, type SessionTabTarget } from "../../session-page-state.js";
import { redactToolDetails } from "../browser-run/final-result.js";
import {
	buildElectronIdentifiers,
	buildElectronMismatchNextActions,
	formatElectronSessionMismatchText,
	getLiveElectronRendererTargets,
} from "../browser-run/session-state.js";
import type { AgentBrowserToolResult, ElectronSessionMismatch } from "../browser-run/types.js";
import type {
	ElectronProbeContext,
	ElectronProbeFocusedElement,
	ElectronProbeResult,
	ElectronProbeTab,
} from "./contracts.js";

function presentProbeTab(tab: ElectronProbeTab): ElectronProbeTab {
	return { ...tab, url: boundElectronProbeString(tab.url) };
}
function presentProbe(probe: ElectronProbeResult): ElectronProbeResult {
	return {
		...probe,
		activeTab: probe.activeTab ? presentProbeTab(probe.activeTab) : undefined,
		tabs: probe.tabs ? { ...probe.tabs, shown: probe.tabs.shown.map(presentProbeTab) } : undefined,
		url: boundElectronProbeString(probe.url, 300),
	};
}

interface ProbePresentation {
	readonly compiledElectron: CompiledAgentBrowserElectron;
	readonly headedManagedAutosaveDisabled?: boolean;
	readonly headedManagedAutosaveInterval?: string;
	readonly mismatch?: ElectronSessionMismatch;
	readonly namespace?: string;
	readonly probe: ElectronProbeResult;
	readonly probeContext: ElectronProbeContext;
	readonly record?: ElectronLaunchRecord;
	readonly sessionTabTarget?: SessionTabTarget;
	readonly status?: ElectronLaunchStatus;
}
function presentStrings(values: readonly (string | undefined)[]): string[] {
	return values.filter((value): value is string => value !== undefined && value.length > 0);
}
function formatFocusedElementAttributes(
	element: Pick<ElectronProbeFocusedElement, "id" | "type" | "valueLength" | "textLength">,
): string {
	return presentStrings([
		element.id !== undefined && element.id.length > 0 ? `#${element.id}` : undefined,
		element.type !== undefined && element.type.length > 0 ? `type=${element.type}` : undefined,
		element.valueLength !== undefined ? `valueLength=${element.valueLength}` : undefined,
		element.textLength !== undefined ? `textLength=${element.textLength}` : undefined,
	]).join(", ");
}
function focusedElementLabel(
	element: Pick<
		ElectronProbeFocusedElement,
		"name" | "textPreview" | "placeholder" | "ariaLabel" | "title"
	>,
): string | undefined {
	return (
		element.name ?? element.textPreview ?? element.placeholder ?? element.ariaLabel ?? element.title
	);
}
function formatElectronProbeFocusedElement(
	element: ElectronProbeFocusedElement | undefined,
): string | undefined {
	if (!element) {
		return;
	}
	const label = focusedElementLabel(element);
	const descriptorText = presentStrings([element.role, element.tagName]).join("/");
	const descriptor = descriptorText.length > 0 ? descriptorText : "element";
	const suffix = formatFocusedElementAttributes(element);
	return `Focused: ${descriptor}${label !== undefined && label.length > 0 ? ` "${label}"` : ""}${suffix.length > 0 ? ` (${suffix})` : ""}`;
}
function formatElectronProbeContextText(context: ElectronProbeContext): string {
	if (context.mode === "launchId") {
		return `Probe context: wrapper launch ${context.launchId ?? "undefined"} session ${context.sessionName}.`;
	}
	if (context.note !== undefined && context.note.length > 0) {
		return `Probe context: current managed session ${context.sessionName}; ${context.note}`;
	}
	if (context.launchId !== undefined && context.launchId.length > 0) {
		return `Probe context: current managed session ${context.sessionName} maps to Electron launch ${context.launchId}.`;
	}
	return `Probe context: current managed session ${context.sessionName} only; pass electron.probe.launchId to compare wrapper-tracked launch status.`;
}
function formatElectronProbeLaunchStatusText(
	status: ElectronLaunchStatus | undefined,
	probe: ElectronProbeResult,
): string | undefined {
	if (!status) {
		return;
	}
	let pidText = "";
	if (status.pidAlive !== undefined) {
		pidText = status.pidAlive ? ", pid alive" : ", pid dead";
	}
	const lines = [
		`Launch status: ${status.portAlive ? "debug port alive" : "debug port dead"}${pidText}; ${status.targets.length} CDP target(s).`,
	];
	if (
		isAboutBlankUrl(probe.url) &&
		(!status.portAlive ||
			status.pidAlive === false ||
			getLiveElectronRendererTargets(status.targets).length === 0)
	) {
		lines.push(
			"Electron lifecycle warning: the browser session is on about:blank and the wrapper launch has no live renderer target to reattach. Run electron.status, cleanup if dead, or relaunch the app.",
		);
	}
	return lines.join("\n");
}
function formatProbeTabs(probe: ElectronProbeResult): string | undefined {
	if (!probe.tabs) {
		return;
	}
	const omitted =
		(probe.tabs.omittedCount ?? 0) !== 0 ? ` (${probe.tabs.omittedCount ?? 0} omitted)` : "";
	const active = probe.activeTab;
	const activeText = active
		? `; active ${active.index ?? "?"}: ${presentStrings([presentStrings([active.title, active.url]).join(" — "), active.tabId])[0] ?? "tab"}`
		: "";
	return `Tabs: ${probe.tabs.total} total${omitted}${activeText}`;
}
function formatProbeSnapshot(probe: ElectronProbeResult): readonly string[] {
	const snapshot = probe.snapshot;
	if (!snapshot) {
		return [];
	}
	const omitted =
		(snapshot.omittedRefCount ?? 0) !== 0
			? ` (${snapshot.omittedRefCount ?? 0} ref id(s) omitted)`
			: "";
	const lines = [`Snapshot: ${snapshot.refCount} interactive ref(s)${omitted}.`];
	if (snapshot.text !== undefined && snapshot.text.length > 0) {
		lines.push(snapshot.text);
	}
	if ((snapshot.omittedLineCount ?? 0) !== 0) {
		lines.push(`... ${snapshot.omittedLineCount ?? 0} snapshot line(s) omitted`);
	}
	return lines;
}
function formatElectronProbeVisibleText(
	options: Pick<ProbePresentation, "probe" | "probeContext" | "mismatch" | "status">,
): string {
	const probe = options.probe;
	const page = presentStrings([probe.title, probe.url]).join(" — ");
	const lines = [
		`Electron probe: ${page.length > 0 ? page : probe.sessionName}`,
		formatElectronProbeContextText(options.probeContext),
		...presentStrings([
			formatElectronProbeLaunchStatusText(options.status, probe),
			options.mismatch ? formatElectronSessionMismatchText(options.mismatch) : undefined,
			formatElectronProbeFocusedElement(probe.focusedElement),
			formatProbeTabs(probe),
		]),
		...formatProbeSnapshot(probe),
	];
	if (probe.status === "partial") {
		lines.push(
			"Some probe commands did not return data; use raw agent_browser commands for deeper diagnostics.",
		);
	}
	if (probe.errors && probe.errors.length > 0) {
		lines.push(
			`Probe warning: ${probe.errors.slice(0, 2).join("; ")}${probe.errors.length > 2 ? "; ..." : ""}`,
		);
	}
	return lines.join("\n");
}
function probeNextActions(
	options: Pick<ProbePresentation, "record" | "mismatch">,
): ReturnType<typeof appendUniqueAgentBrowserNextActions> {
	const base = options.record
		? (buildAgentBrowserNextActions({
				electron: {
					launchId: options.record.launchId,
					sessionName: options.record.sessionName,
					status: options.record.cleanupState,
				},
				resultCategory: "success",
				successCategory: "completed",
			}) ?? [])
		: [];
	const mismatch =
		options.mismatch && options.record
			? buildElectronMismatchNextActions(options.record, options.mismatch.liveTarget)
			: [];
	return options.mismatch
		? appendUniqueAgentBrowserNextActions([...mismatch], base)
		: appendUniqueAgentBrowserNextActions([...base], mismatch);
}
export function buildElectronProbeResult(options: ProbePresentation): AgentBrowserToolResult {
	const probe = presentProbe(options.probe);
	const { refSnapshot: _refSnapshot, ...boundedProbe } = probe;
	const nextActions = probeNextActions(options);
	const details = {
		args: [],
		compiledElectron: options.compiledElectron,
		electron: {
			action: "probe" as const,
			identifiers: options.record ? buildElectronIdentifiers(options.record) : undefined,
			probe: boundedProbe,
			probeContext: options.probeContext,
			sessionMismatch: options.mismatch,
			status: options.probe.status,
			statusTargets: options.status?.targets,
			launchStatus: options.status,
		},
		nextActions: nextActions.length > 0 ? nextActions : undefined,
		...buildAgentBrowserResultCategoryDetails({ args: [], succeeded: true }),
		managedSessionHeadedAutosaveDisabled:
			options.headedManagedAutosaveDisabled === true ? true : undefined,
		managedSessionHeadedAutosaveInterval: options.headedManagedAutosaveInterval,
		namespace: options.namespace,
		refSnapshot: options.probe.refSnapshot,
		sessionName: options.probe.sessionName,
		sessionTabTarget: options.sessionTabTarget,
		summary: options.mismatch?.summary ?? options.probe.summary,
		usedImplicitSession: options.probeContext.mode === "current-managed-session",
	};
	return {
		content: [
			{
				type: "text",
				text: redactSensitiveText(formatElectronProbeVisibleText({ ...options, probe })),
			},
		],
		details: redactToolDetails(details, []),
		isError: false,
	};
}
