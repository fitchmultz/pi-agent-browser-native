/**
 * Purpose: Own wrapper-side Electron host orchestration for agent_browser structured electron input.
 * Responsibilities: Discover Electron apps, inspect/probe/cleanup wrapper-tracked Electron launches, and build Pi-facing Electron host results.
 * Scope: Electron host actions that do not spawn the main upstream browser command; generic agent_browser execution stays in browser-run.
 */

import type { ChildProcess } from "node:child_process";

import { cleanupElectronLaunchResources, inspectElectronLaunchStatus, type ElectronCleanupResult, type ElectronLaunchStatus } from "../../electron/cleanup.js";
import { discoverElectronApps, type ElectronDiscoveryResult } from "../../electron/discovery.js";
import type { ElectronCdpTarget, ElectronLaunchRecord } from "../../electron/launch.js";
import type { CompiledAgentBrowserElectron } from "../../input-modes.js";
import { isRecord } from "../../parsing.js";
import { buildAgentBrowserNextActions, buildAgentBrowserResultCategoryDetails } from "../../results.js";
import { appendUniqueAgentBrowserNextActions } from "../../results/next-actions.js";
import { extractRefSnapshotFromData, isAboutBlankUrl, normalizeSessionTabTarget, type SessionPageState, type SessionRefSnapshot, type SessionTabTarget } from "../../session-page-state.js";
import { redactSensitiveText } from "../../runtime.js";
import { collectElectronManagedSessionTarget } from "../browser-run/diagnostics.js";
import { buildElectronHostFailureResult, formatElectronTargetLines, redactToolDetails } from "../browser-run/final-result.js";
import {
	buildElectronIdentifiers,
	buildElectronMismatchNextActions,
	buildElectronSessionMismatch,
	closeManagedSession,
	extractStringResultField,
	findElectronLaunchRecordForSession,
	formatElectronSessionMismatchText,
	getActiveElectronRecords,
	getLiveElectronRendererTargets,
	runSessionCommandData,
} from "../browser-run/session-state.js";
import type { AgentBrowserToolResult, ElectronManagedSessionTarget, ElectronSessionMismatch } from "../browser-run/types.js";

export type { ElectronLaunchRecord } from "../../electron/launch.js";

const ELECTRON_PROFILE_ISOLATION_NOTE = "Profile note: electron.launch starts an isolated temporary profile; it does not reuse the app's normal signed-in profile or attach to an already-running authenticated app.";
const ELECTRON_EXISTING_AUTH_GUIDANCE = "For already-authenticated desktop app content, do not stop here: if host tools are allowed and the app is not running, launch the normal app with --remote-debugging-port=<port>, verify the port, then run agent_browser connect <port>; if it is already running without a debug port, ask before relaunching it.";
export const ELECTRON_PROFILE_ISOLATION_DETAILS = {
	attachesToAlreadyRunningApp: false,
	existingAuthenticatedAppGuidance: ELECTRON_EXISTING_AUTH_GUIDANCE,
	hostDebugLaunchExample: "macOS: open -a <App Name> --args --remote-debugging-port=9222 --remote-allow-origins='*'; then agent_browser connect 9222 with sessionMode=fresh",
	isolatedLaunch: true,
	note: ELECTRON_PROFILE_ISOLATION_NOTE,
	reusesExistingSignedInProfile: false,
} as const;
export const ELECTRON_POST_COMMAND_STATUS_SETTLE_MS = 250;

const ELECTRON_PROBE_MAX_TABS = 6;
const ELECTRON_PROBE_MAX_REF_IDS = 20;
const ELECTRON_PROBE_MAX_SNAPSHOT_LINES = 12;
const ELECTRON_PROBE_MAX_SNAPSHOT_CHARS = 1_600;

function formatElectronListVisibleText(result: ElectronDiscoveryResult): string {
	const visibleApps = result.apps.slice(0, 10);
	const visibleOmittedCount = Math.max(0, result.apps.length - visibleApps.length);
	const header = result.omittedCount > 0
		? `Electron apps (${result.apps.length} shown, ${result.omittedCount} omitted):`
		: `Electron apps (${result.apps.length} found):`;
	const lines = [header];
	if (visibleApps.length === 0) {
		lines.push(result.query ? `No Electron apps matched query "${result.query}".` : "No Electron apps found in the supported scan locations.");
	} else {
		for (const app of visibleApps) {
			const identifier = app.bundleId ?? app.desktopId;
			const path = app.appPath ?? app.executablePath;
			const sensitivity = app.sensitivity ? ` [likely sensitive: ${app.sensitivity.categories.join(", ")}]` : "";
			lines.push(`- ${app.name}${identifier ? ` (${identifier})` : ""}${sensitivity} — ${path}`);
		}
	}
	if (visibleOmittedCount > 0) {
		lines.push(`${visibleOmittedCount} additional app(s) omitted from visible output; see details.electron.apps.`);
	}
	if (result.omittedCount > 0) {
		lines.push(`${result.omittedCount} app(s) omitted by maxResults=${result.maxResults}.`);
	}
	if (result.apps.some((app) => app.sensitivity?.level === "likely-sensitive")) {
		lines.push("Review likely-sensitive apps and use caller-owned allow/deny policy before launch.");
		lines.push(ELECTRON_PROFILE_ISOLATION_NOTE);
		lines.push(ELECTRON_EXISTING_AUTH_GUIDANCE);
	}
	return lines.join("\n");
}

function buildElectronListSuccessResult(compiledElectron: CompiledAgentBrowserElectron, discovery: ElectronDiscoveryResult): AgentBrowserToolResult {
	const text = redactSensitiveText(formatElectronListVisibleText(discovery));
	const sensitiveAppCount = discovery.apps.filter((app) => app.sensitivity?.level === "likely-sensitive").length;
	const details = {
		args: [] as string[],
		compiledElectron,
		electron: {
			action: "list" as const,
			apps: discovery.apps,
			maxResults: discovery.maxResults,
			omittedCount: discovery.omittedCount || undefined,
			platform: discovery.platform,
			profileIsolation: ELECTRON_PROFILE_ISOLATION_DETAILS,
			query: discovery.query,
			sensitiveAppCount: sensitiveAppCount || undefined,
			skippedCount: discovery.skippedCount,
			status: "succeeded" as const,
		},
		...buildAgentBrowserResultCategoryDetails({ args: [], succeeded: true }),
		summary: discovery.omittedCount > 0
			? `Electron app discovery found ${discovery.apps.length} app(s) and omitted ${discovery.omittedCount}.`
			: `Electron app discovery found ${discovery.apps.length} app(s).`,
	};
	return {
		content: [{ type: "text", text }],
		details: redactToolDetails(details, []),
		isError: false,
	};
}

function buildElectronListFailureResult(compiledElectron: CompiledAgentBrowserElectron | undefined, error: unknown): AgentBrowserToolResult {
	const errorText = error instanceof Error ? error.message : String(error);
	const text = redactSensitiveText(`Electron app discovery failed: ${errorText}`);
	const details = {
		args: [] as string[],
		compiledElectron,
		electron: {
			action: "list" as const,
			error: errorText,
			status: "failed" as const,
		},
		...buildAgentBrowserResultCategoryDetails({ args: [], errorText, succeeded: false }),
		summary: "Electron app discovery failed.",
	};
	return {
		content: [{ type: "text", text }],
		details: redactToolDetails(details, []),
		isError: true,
	};
}

function isElectronLaunchRecord(value: unknown): value is ElectronLaunchRecord {
	if (!isRecord(value)) return false;
	return value.version === 1 &&
		value.launchedByWrapper === true &&
		typeof value.launchId === "string" &&
		typeof value.appName === "string" &&
		typeof value.executablePath === "string" &&
		typeof value.userDataDir === "string" &&
		typeof value.port === "number" &&
		typeof value.createdAtMs === "number";
}

export function restoreElectronLaunchRecordsFromBranch(branch: unknown[]): Map<string, ElectronLaunchRecord> {
	const records = new Map<string, ElectronLaunchRecord>();
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		const electron = isRecord(details?.electron) ? details.electron : undefined;
		if (!electron) continue;
		const launch = isElectronLaunchRecord(electron.launch) ? electron.launch : undefined;
		if (launch) records.set(launch.launchId, launch);
		const cleanupRecords = isRecord(electron.cleanup) && Array.isArray(electron.cleanup.records) ? electron.cleanup.records : [];
		for (const cleanupRecord of cleanupRecords) {
			if (isElectronLaunchRecord(cleanupRecord)) records.set(cleanupRecord.launchId, cleanupRecord);
		}
	}
	return records;
}

function selectElectronRecords(compiledElectron: Extract<CompiledAgentBrowserElectron, { action: "cleanup" | "status" }>, records: Map<string, ElectronLaunchRecord>): { error?: string; records?: ElectronLaunchRecord[] } {
	if (compiledElectron.launchId) {
		const record = records.get(compiledElectron.launchId);
		return record ? { records: [record] } : { error: `No wrapper-tracked Electron launch found for launchId ${compiledElectron.launchId}.` };
	}
	if (compiledElectron.all) return { records: getActiveElectronRecords(records) };
	const activeRecords = getActiveElectronRecords(records);
	if (activeRecords.length === 0) return { records: [] };
	if (activeRecords.length > 1) return { error: "Multiple wrapper-tracked Electron launches are active; pass electron.launchId or electron.all." };
	return { records: activeRecords };
}

function extractTargetsFromStatus(statuses: ElectronLaunchStatus[]): ElectronCdpTarget[] {
	return statuses.flatMap((status) => status.targets);
}

interface ElectronProbeContext {
	launchId?: string;
	mode: "current-managed-session" | "launchId";
	note?: string;
	sessionName: string;
}

function formatElectronStatusVisibleText(statuses: ElectronLaunchStatus[], records: ElectronLaunchRecord[], mismatches: ElectronSessionMismatch[] = [], managedSessions: ElectronManagedSessionTarget[] = []): string {
	if (statuses.length === 0) return "Electron status: no active wrapper-tracked launches.";
	const recordsByLaunchId = new Map(records.map((record) => [record.launchId, record]));
	const managedSessionsByName = new Map(managedSessions.map((managedSession) => [managedSession.sessionName, managedSession]));
	const lines = [`Electron status: ${statuses.length} wrapper-tracked launch(es).`];
	for (const status of statuses) {
		const record = recordsByLaunchId.get(status.launchId);
		const sessionName = record?.sessionName;
		const appName = record?.appName ?? "Electron launch";
		const sessionText = sessionName ? `, sessionName ${sessionName}` : "";
		lines.push(`- ${status.launchId}: ${appName}${sessionText}; ${status.portAlive ? "debug port alive" : "debug port dead"}${status.pidAlive === undefined ? "" : status.pidAlive ? ", pid alive" : ", pid dead"} (port ${status.port})`);
		lines.push(`  Identifiers: launchId ${status.launchId}; sessionName ${sessionName ?? "not attached"}.`);
		for (const targetLine of formatElectronTargetLines(status.targets, 4)) lines.push(`  ${targetLine}`);
		const managedSession = sessionName ? managedSessionsByName.get(sessionName) : undefined;
		if (managedSession?.error) lines.push(`  Managed session warning: ${managedSession.error}`);
	}
	for (const mismatch of mismatches) lines.push("", formatElectronSessionMismatchText(mismatch));
	return lines.join("\n");
}

function buildElectronStatusResult(options: {
	compiledElectron: CompiledAgentBrowserElectron;
	managedSessions?: ElectronManagedSessionTarget[];
	mismatches?: ElectronSessionMismatch[];
	records: ElectronLaunchRecord[];
	statuses: ElectronLaunchStatus[];
}): AgentBrowserToolResult {
	const baseNextActions = options.records.flatMap((record) => buildAgentBrowserNextActions({
		electron: { launchId: record.launchId, sessionName: record.sessionName, status: record.cleanupState },
		resultCategory: "success",
		successCategory: "completed",
	}) ?? []);
	const mismatchNextActions = (options.mismatches ?? []).flatMap((mismatch) => {
		const record = options.records.find((candidate) => candidate.launchId === mismatch.launchId);
		return record ? buildElectronMismatchNextActions(record, mismatch.liveTarget) : [];
	});
	const nextActions = options.mismatches?.length
		? appendUniqueAgentBrowserNextActions([...mismatchNextActions], baseNextActions)
		: appendUniqueAgentBrowserNextActions([...baseNextActions], mismatchNextActions);
	const details = {
		args: [] as string[],
		compiledElectron: options.compiledElectron,
		electron: {
			action: "status" as const,
			identifierList: options.records.length > 1 ? options.records.map(buildElectronIdentifiers) : undefined,
			identifiers: options.records.length === 1 && options.records[0] ? buildElectronIdentifiers(options.records[0]) : undefined,
			launches: options.records,
			managedSession: options.managedSessions?.length === 1 ? options.managedSessions[0] : undefined,
			managedSessions: options.managedSessions && options.managedSessions.length > 0 ? options.managedSessions : undefined,
			sessionMismatch: options.mismatches?.length === 1 ? options.mismatches[0] : undefined,
			sessionMismatches: options.mismatches && options.mismatches.length > 1 ? options.mismatches : undefined,
			status: "succeeded" as const,
			statuses: options.statuses,
			targets: extractTargetsFromStatus(options.statuses),
		},
		nextActions: nextActions.length > 0 ? nextActions : undefined,
		...buildAgentBrowserResultCategoryDetails({ args: [], succeeded: true }),
		summary: options.statuses.length === 0 ? "Electron status found no active wrapper-tracked launches." : `Electron status inspected ${options.statuses.length} launch(es).`,
	};
	return { content: [{ type: "text", text: redactSensitiveText(formatElectronStatusVisibleText(options.statuses, options.records, options.mismatches, options.managedSessions)) }], details: redactToolDetails(details, []), isError: false };
}

function formatElectronCleanupVisibleText(results: ElectronCleanupResult[]): string {
	if (results.length === 0) return "Electron cleanup: no active wrapper-tracked launches.";
	const lines = [`Electron cleanup: ${results.filter((result) => !result.partial).length}/${results.length} launch(es) fully cleaned.`];
	for (const result of results) {
		lines.push(`- ${result.summary}`);
		for (const step of result.steps) lines.push(`  - ${step.resource}: ${step.state}${step.error ? ` (${step.error})` : ""}`);
	}
	return lines.join("\n");
}

function buildElectronCleanupResult(compiledElectron: CompiledAgentBrowserElectron, cleanupResults: ElectronCleanupResult[]): AgentBrowserToolResult {
	const partial = cleanupResults.some((result) => result.partial);
	const records = cleanupResults.map((result) => result.record);
	const nextActions = cleanupResults.flatMap((result) => buildAgentBrowserNextActions({
		electron: { launchId: result.launchId, sessionName: result.record.sessionName, status: result.record.cleanupState },
		failureCategory: partial ? "cleanup-failed" : undefined,
		resultCategory: partial ? "failure" : "success",
		successCategory: partial ? undefined : "completed",
	}) ?? []);
	const errorText = partial ? cleanupResults.map((result) => result.summary).join("\n") : undefined;
	const details = {
		args: [] as string[],
		compiledElectron,
		electron: {
			action: "cleanup" as const,
			cleanup: { partial, records, results: cleanupResults },
			status: partial ? "partial" as const : "succeeded" as const,
		},
		nextActions: nextActions.length > 0 ? nextActions : undefined,
		...buildAgentBrowserResultCategoryDetails({ args: [], errorText, failureCategory: partial ? "cleanup-failed" : undefined, succeeded: !partial }),
		summary: partial ? "Electron cleanup was partial." : "Electron cleanup completed.",
	};
	return { content: [{ type: "text", text: redactSensitiveText(formatElectronCleanupVisibleText(cleanupResults)) }], details: redactToolDetails(details, []), isError: partial };
}

interface ElectronProbeFocusedElement {
	ariaLabel?: string;
	id?: string;
	isContentEditable?: boolean;
	name?: string;
	placeholder?: string;
	role?: string;
	tagName?: string;
	textLength?: number;
	textPreview?: string;
	title?: string;
	type?: string;
	valueLength?: number;
}

interface ElectronProbeTab {
	active?: boolean;
	index?: number;
	tabId?: string;
	title?: string;
	type?: string;
	url?: string;
}

interface ElectronProbeSnapshotSummary {
	lineCount: number;
	omittedLineCount?: number;
	omittedRefCount?: number;
	refCount: number;
	refIds: string[];
	text?: string;
}

interface ElectronProbeResult {
	activeTab?: ElectronProbeTab;
	errors?: string[];
	focusedElement?: ElectronProbeFocusedElement;
	refSnapshot?: SessionRefSnapshot;
	sessionName: string;
	snapshot?: ElectronProbeSnapshotSummary;
	status: "partial" | "succeeded";
	summary: string;
	tabs?: {
		omittedCount?: number;
		shown: ElectronProbeTab[];
		total: number;
	};
	title?: string;
	url?: string;
}

const ELECTRON_FOCUSED_ELEMENT_EVAL = `(() => {
	const clean = (value, max = 80) => {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > max ? normalized.slice(0, max - 3) + "..." : normalized;
	};
	const describeElement = (element) => {
	if (!element || !(element instanceof Element)) return undefined;
	const tagName = element.tagName.toLowerCase();
	const inputLike = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
	const contentEditable = element instanceof HTMLElement && element.isContentEditable;
	const containerLike = tagName === "body" || tagName === "html";
	const rawText = element.textContent || "";
	const exposeText = !inputLike && !contentEditable && !containerLike;
	const text = exposeText ? clean(rawText) : undefined;
	return {
		tagName: clean(tagName, 40),
		role: clean(element.getAttribute("role") || "", 60),
		name: clean(element.getAttribute("aria-label") || element.getAttribute("title") || text || "", 80),
		id: clean(element.id || "", 80),
		type: clean(element.getAttribute("type") || "", 40),
		placeholder: clean(element.getAttribute("placeholder") || "", 80),
		ariaLabel: clean(element.getAttribute("aria-label") || "", 80),
		title: clean(element.getAttribute("title") || "", 80),
		textLength: !exposeText && rawText ? rawText.length : undefined,
		textPreview: text,
		valueLength: inputLike && typeof element.value === "string" ? element.value.length : undefined,
		isContentEditable: contentEditable || undefined,
	};
	};
	return { focusedElement: describeElement(document.activeElement) };
})()`;

function boundElectronProbeString(value: string | undefined, maxLength = 240): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.length > maxLength ? `${trimmed.slice(0, Math.max(0, maxLength - 3))}...` : trimmed;
}

function getTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" ? boundElectronProbeString(value) : undefined;
}

function getOptionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractElectronFocusedElement(data: unknown): ElectronProbeFocusedElement | undefined {
	const payload = isRecord(data) && isRecord(data.result) ? data.result : data;
	const rawFocusedElement = isRecord(payload) && isRecord(payload.focusedElement) ? payload.focusedElement : isRecord(payload) ? payload : undefined;
	if (!rawFocusedElement) return undefined;
	const focusedElement: ElectronProbeFocusedElement = {
		ariaLabel: getTrimmedString(rawFocusedElement.ariaLabel),
		id: getTrimmedString(rawFocusedElement.id),
		isContentEditable: getOptionalBoolean(rawFocusedElement.isContentEditable),
		name: getTrimmedString(rawFocusedElement.name),
		placeholder: getTrimmedString(rawFocusedElement.placeholder),
		role: getTrimmedString(rawFocusedElement.role),
		tagName: getTrimmedString(rawFocusedElement.tagName),
		textLength: getOptionalNumber(rawFocusedElement.textLength),
		textPreview: getTrimmedString(rawFocusedElement.textPreview),
		title: getTrimmedString(rawFocusedElement.title),
		type: getTrimmedString(rawFocusedElement.type),
		valueLength: getOptionalNumber(rawFocusedElement.valueLength),
	};
	return Object.values(focusedElement).some((value) => value !== undefined) ? focusedElement : undefined;
}

function extractElectronProbeTabs(data: unknown): { activeTab?: ElectronProbeTab; tabs?: ElectronProbeResult["tabs"] } {
	const rawTabs = isRecord(data) && Array.isArray(data.tabs) ? data.tabs : Array.isArray(data) ? data : [];
	const allTabs = rawTabs.filter(isRecord).map((tab, index): ElectronProbeTab => ({
		active: getOptionalBoolean(tab.active),
		index: typeof tab.index === "number" && Number.isInteger(tab.index) ? tab.index : index,
		tabId: getTrimmedString(tab.tabId) ?? getTrimmedString(tab.id),
		title: getTrimmedString(tab.title) ?? getTrimmedString(tab.label),
		type: getTrimmedString(tab.type),
		url: getTrimmedString(tab.url),
	}));
	if (allTabs.length === 0) return {};
	const shown = allTabs.slice(0, ELECTRON_PROBE_MAX_TABS);
	return {
		activeTab: allTabs.find((tab) => tab.active) ?? allTabs[0],
		tabs: {
			omittedCount: allTabs.length > shown.length ? allTabs.length - shown.length : undefined,
			shown,
			total: allTabs.length,
		},
	};
}

function truncateElectronProbeSnapshotText(snapshotText: string | undefined): { lineCount: number; omittedLineCount?: number; text?: string } {
	if (!snapshotText) return { lineCount: 0 };
	const lines = snapshotText.split(/\r?\n/);
	const shownLines: string[] = [];
	let usedChars = 0;
	for (const line of lines) {
		if (shownLines.length >= ELECTRON_PROBE_MAX_SNAPSHOT_LINES) break;
		const nextLength = usedChars + line.length + (shownLines.length > 0 ? 1 : 0);
		if (nextLength > ELECTRON_PROBE_MAX_SNAPSHOT_CHARS) {
			if (shownLines.length === 0) shownLines.push(`${line.slice(0, ELECTRON_PROBE_MAX_SNAPSHOT_CHARS - 3)}...`);
			break;
		}
		shownLines.push(line);
		usedChars = nextLength;
	}
	return {
		lineCount: lines.length,
		omittedLineCount: lines.length > shownLines.length ? lines.length - shownLines.length : undefined,
		text: shownLines.length > 0 ? shownLines.join("\n") : undefined,
	};
}

function summarizeElectronProbeSnapshot(data: unknown): { refSnapshot?: SessionRefSnapshot; snapshot?: ElectronProbeSnapshotSummary } {
	const refSnapshot = extractRefSnapshotFromData(data);
	const rawSnapshotText = isRecord(data) ? getTrimmedString(data.snapshot) : undefined;
	const truncatedText = truncateElectronProbeSnapshotText(rawSnapshotText);
	const refIds = refSnapshot?.refIds ?? [];
	const shownRefIds = refIds.slice(0, ELECTRON_PROBE_MAX_REF_IDS);
	const snapshot = refSnapshot || truncatedText.text
		? {
			lineCount: truncatedText.lineCount,
			omittedLineCount: truncatedText.omittedLineCount,
			omittedRefCount: refIds.length > shownRefIds.length ? refIds.length - shownRefIds.length : undefined,
			refCount: refIds.length,
			refIds: shownRefIds,
			text: truncatedText.text,
		}
		: undefined;
	return { refSnapshot, snapshot };
}

function getElectronProbeSummary(probe: Omit<ElectronProbeResult, "summary">): string {
	const parts = [
		probe.title ? `title "${probe.title}"` : undefined,
		probe.url ? `url ${probe.url}` : undefined,
		probe.focusedElement ? "focused element" : undefined,
		probe.tabs ? `${probe.tabs.total} tab(s)` : undefined,
		probe.snapshot ? `${probe.snapshot.refCount} ref(s)` : undefined,
	].filter((item): item is string => item !== undefined);
	return parts.length > 0 ? `Electron probe collected ${parts.join(", ")}.` : "Electron probe did not return current session state.";
}

async function runElectronProbeCommandData(options: {
	args: string[];
	cwd: string;
	sessionName: string;
	signal?: AbortSignal;
	stdin?: string;
	timeoutMs?: number;
}): Promise<{ data?: unknown; error?: string }> {
	try {
		return { data: await runSessionCommandData(options) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function collectElectronProbe(options: {
	cwd: string;
	sessionName: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<ElectronProbeResult> {
	const titleResult = await runElectronProbeCommandData({ args: ["get", "title"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, timeoutMs: options.timeoutMs });
	const urlResult = await runElectronProbeCommandData({ args: ["get", "url"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, timeoutMs: options.timeoutMs });
	const focusedResult = await runElectronProbeCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: ELECTRON_FOCUSED_ELEMENT_EVAL, timeoutMs: options.timeoutMs });
	const tabsResult = await runElectronProbeCommandData({ args: ["tab", "list"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, timeoutMs: options.timeoutMs });
	const snapshotResult = await runElectronProbeCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, timeoutMs: options.timeoutMs });
	const errors = [
		titleResult.error ? `get title: ${titleResult.error}` : undefined,
		urlResult.error ? `get url: ${urlResult.error}` : undefined,
		focusedResult.error ? `focused element: ${focusedResult.error}` : undefined,
		tabsResult.error ? `tab list: ${tabsResult.error}` : undefined,
		snapshotResult.error ? `snapshot: ${snapshotResult.error}` : undefined,
	].filter((item): item is string => item !== undefined).map((error) => boundElectronProbeString(error, 240) ?? "probe command failed");
	const title = boundElectronProbeString(extractStringResultField(titleResult.data, "result") ?? extractStringResultField(titleResult.data, "title"), 160);
	const url = boundElectronProbeString(extractStringResultField(urlResult.data, "result") ?? extractStringResultField(urlResult.data, "url"), 300);
	const focusedElement = extractElectronFocusedElement(focusedResult.data);
	const { activeTab, tabs } = extractElectronProbeTabs(tabsResult.data);
	const { refSnapshot, snapshot } = summarizeElectronProbeSnapshot(snapshotResult.data);
	const probeWithoutSummary = {
		activeTab,
		focusedElement,
		errors: errors.length > 0 ? errors : undefined,
		refSnapshot,
		sessionName: options.sessionName,
		snapshot,
		status: errors.length === 0 && (title || url || focusedElement || tabs || snapshot) ? "succeeded" as const : "partial" as const,
		tabs,
		title,
		url,
	};
	return { ...probeWithoutSummary, summary: getElectronProbeSummary(probeWithoutSummary) };
}

function formatElectronProbeFocusedElement(focusedElement: ElectronProbeFocusedElement | undefined): string | undefined {
	if (!focusedElement) return undefined;
	const label = focusedElement.name ?? focusedElement.textPreview ?? focusedElement.placeholder ?? focusedElement.ariaLabel ?? focusedElement.title;
	const descriptor = [focusedElement.role, focusedElement.tagName].filter(Boolean).join("/") || "element";
	const suffix = [
		focusedElement.id ? `#${focusedElement.id}` : undefined,
		focusedElement.type ? `type=${focusedElement.type}` : undefined,
		focusedElement.valueLength !== undefined ? `valueLength=${focusedElement.valueLength}` : undefined,
		focusedElement.textLength !== undefined ? `textLength=${focusedElement.textLength}` : undefined,
	].filter((item): item is string => item !== undefined).join(", ");
	return `Focused: ${descriptor}${label ? ` "${label}"` : ""}${suffix ? ` (${suffix})` : ""}`;
}

function formatElectronProbeContextText(context: ElectronProbeContext): string {
	if (context.mode === "launchId") {
		return `Probe context: wrapper launch ${context.launchId} session ${context.sessionName}.`;
	}
	if (context.note) {
		return `Probe context: current managed session ${context.sessionName}; ${context.note}`;
	}
	if (context.launchId) {
		return `Probe context: current managed session ${context.sessionName} maps to Electron launch ${context.launchId}.`;
	}
	return `Probe context: current managed session ${context.sessionName} only; pass electron.probe.launchId to compare wrapper-tracked launch status.`;
}

function formatElectronProbeLaunchStatusText(status: ElectronLaunchStatus | undefined, probe: ElectronProbeResult): string | undefined {
	if (!status) return undefined;
	const lines = [`Launch status: ${status.portAlive ? "debug port alive" : "debug port dead"}${status.pidAlive === undefined ? "" : status.pidAlive ? ", pid alive" : ", pid dead"}; ${status.targets.length} CDP target(s).`];
	if (isAboutBlankUrl(probe.url) && (!status.portAlive || status.pidAlive === false || getLiveElectronRendererTargets(status.targets).length === 0)) {
		lines.push("Electron lifecycle warning: the browser session is on about:blank and the wrapper launch has no live renderer target to reattach. Run electron.status, cleanup if dead, or relaunch the app.");
	}
	return lines.join("\n");
}

function formatElectronProbeVisibleText(options: {
	context?: ElectronProbeContext;
	mismatch?: ElectronSessionMismatch;
	probe: ElectronProbeResult;
	status?: ElectronLaunchStatus;
}): string {
	const { context, mismatch, probe, status } = options;
	const page = [probe.title, probe.url].filter(Boolean).join(" — ");
	const lines = [`Electron probe: ${page || probe.sessionName}`];
	if (context) lines.push(formatElectronProbeContextText(context));
	const launchStatusText = formatElectronProbeLaunchStatusText(status, probe);
	if (launchStatusText) lines.push(launchStatusText);
	if (mismatch) lines.push(formatElectronSessionMismatchText(mismatch));
	const focusedLine = formatElectronProbeFocusedElement(probe.focusedElement);
	if (focusedLine) lines.push(focusedLine);
	if (probe.tabs) {
		const active = probe.activeTab;
		lines.push(`Tabs: ${probe.tabs.total} total${probe.tabs.omittedCount ? ` (${probe.tabs.omittedCount} omitted)` : ""}${active ? `; active ${active.index ?? "?"}: ${[active.title, active.url].filter(Boolean).join(" — ") || active.tabId || "tab"}` : ""}`);
	}
	if (probe.snapshot) {
		lines.push(`Snapshot: ${probe.snapshot.refCount} interactive ref(s)${probe.snapshot.omittedRefCount ? ` (${probe.snapshot.omittedRefCount} ref id(s) omitted)` : ""}.`);
		if (probe.snapshot.text) lines.push(probe.snapshot.text);
		if (probe.snapshot.omittedLineCount) lines.push(`... ${probe.snapshot.omittedLineCount} snapshot line(s) omitted`);
	}
	if (probe.status === "partial") lines.push("Some probe commands did not return data; use raw agent_browser commands for deeper diagnostics.");
	if (probe.errors && probe.errors.length > 0) lines.push(`Probe warning: ${probe.errors.slice(0, 2).join("; ")}${probe.errors.length > 2 ? "; ..." : ""}`);
	return lines.join("\n");
}

function buildElectronProbeResult(options: {
	compiledElectron: CompiledAgentBrowserElectron;
	mismatch?: ElectronSessionMismatch;
	probe: ElectronProbeResult;
	probeContext: ElectronProbeContext;
	record?: ElectronLaunchRecord;
	sessionTabTarget?: SessionTabTarget;
	status?: ElectronLaunchStatus;
}): AgentBrowserToolResult {
	const { refSnapshot: _refSnapshot, ...boundedProbe } = options.probe;
	const baseNextActions = options.record ? buildAgentBrowserNextActions({
		electron: { launchId: options.record.launchId, sessionName: options.record.sessionName, status: options.record.cleanupState },
		resultCategory: "success",
		successCategory: "completed",
	}) ?? [] : [];
	const mismatchNextActions = options.mismatch && options.record ? buildElectronMismatchNextActions(options.record, options.mismatch.liveTarget) : [];
	const nextActions = options.mismatch
		? appendUniqueAgentBrowserNextActions([...mismatchNextActions], baseNextActions)
		: appendUniqueAgentBrowserNextActions([...baseNextActions], mismatchNextActions);
	const details = {
		args: [] as string[],
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
		sessionName: options.probe.sessionName,
		sessionTabTarget: options.sessionTabTarget,
		summary: options.mismatch?.summary ?? options.probe.summary,
		usedImplicitSession: options.probeContext.mode === "current-managed-session",
	};
	return {
		content: [{ type: "text", text: redactSensitiveText(formatElectronProbeVisibleText({ context: options.probeContext, mismatch: options.mismatch, probe: options.probe, status: options.status })) }],
		details: redactToolDetails(details, []),
		isError: false,
	};
}

interface ElectronHostLaunchCleanupState {
	electronChildProcesses: Map<string, ChildProcess>;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
}

export async function cleanupTrackedElectronHostLaunches(options: ElectronHostLaunchCleanupState & {
	cwd: string;
	records: ElectronLaunchRecord[];
	timeoutMs: number;
}): Promise<ElectronCleanupResult[]> {
	const results: ElectronCleanupResult[] = [];
	for (const record of options.records) {
		const managedSessionCloseError = record.sessionName
			? await closeManagedSession({ cwd: options.cwd, sessionName: record.sessionName, timeoutMs: options.timeoutMs })
			: undefined;
		const managedSessionStep = record.sessionName
			? managedSessionCloseError
				? { error: managedSessionCloseError, resource: "managed-session" as const, sessionName: record.sessionName, state: "failed" as const }
				: { resource: "managed-session" as const, sessionName: record.sessionName, state: "removed" as const }
			: undefined;
		const cleanupResult = await cleanupElectronLaunchResources({
			child: options.electronChildProcesses.get(record.launchId),
			record,
			timeoutMs: options.timeoutMs,
		});
		const cleanupRecord = record.sessionName && !managedSessionCloseError
			? { ...cleanupResult.record, sessionName: undefined }
			: cleanupResult.record;
		const result: ElectronCleanupResult = managedSessionCloseError
			? {
					...cleanupResult,
					partial: true,
					record: { ...cleanupResult.record, cleanupState: "partial" },
					remainingResources: [...new Set(["managed-session", ...cleanupResult.remainingResources])],
					steps: [managedSessionStep, ...cleanupResult.steps].filter((step): step is NonNullable<typeof step> => step !== undefined),
					summary: `Electron cleanup for ${record.launchId} is partial; managed session close failed.`,
			  }
			: {
					...cleanupResult,
					record: cleanupRecord,
					steps: [managedSessionStep, ...cleanupResult.steps].filter((step): step is NonNullable<typeof step> => step !== undefined),
			  };
		results.push(result);
		options.electronLaunchRecords.set(record.launchId, result.record);
		if (!result.partial) options.electronChildProcesses.delete(record.launchId);
	}
	return results;
}

export async function cleanupActiveElectronHostLaunches(options: ElectronHostLaunchCleanupState & {
	cwd: string;
	timeoutMs: number;
}): Promise<ElectronCleanupResult[]> {
	const activeRecords = getActiveElectronRecords(options.electronLaunchRecords);
	return activeRecords.length > 0
		? cleanupTrackedElectronHostLaunches({ ...options, records: activeRecords })
		: [];
}

export async function handleElectronHostInput(options: {
	compiledElectron?: CompiledAgentBrowserElectron;
	cwd: string;
	electronChildProcesses: Map<string, ChildProcess>;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	implicitSessionCloseTimeoutMs: number;
	managedSessionActive: boolean;
	managedSessionName: string;
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	sessionPageState: SessionPageState;
	signal?: AbortSignal;
}): Promise<AgentBrowserToolResult | undefined> {
	const {
		compiledElectron,
		cwd,
		electronChildProcesses,
		electronLaunchRecords,
		implicitSessionCloseTimeoutMs,
		managedSessionActive,
		managedSessionName,
		redactedCompiledElectron,
		sessionPageState,
		signal,
	} = options;
	if (compiledElectron?.action === "list") {
		try {
			const discovery = await discoverElectronApps({ maxResults: compiledElectron.maxResults, query: compiledElectron.query });
			return buildElectronListSuccessResult(redactedCompiledElectron ?? compiledElectron, discovery);
		} catch (error) {
			return buildElectronListFailureResult(redactedCompiledElectron ?? compiledElectron, error);
		}
	}
	if (compiledElectron?.action === "status") {
		const selection = selectElectronRecords(compiledElectron, electronLaunchRecords);
		if (selection.error) return buildElectronHostFailureResult({ compiledElectron: redactedCompiledElectron ?? compiledElectron, errorText: selection.error, failureCategory: "validation-error" });
		const records = selection.records ?? [];
		const statuses = await Promise.all(records.map((record) => inspectElectronLaunchStatus(record)));
		const managedSessions = (await Promise.all(records.map((record) => collectElectronManagedSessionTarget({
			cwd,
			sessionName: record.sessionName,
			signal,
			timeoutMs: compiledElectron.timeoutMs,
		})))).filter((managedSession): managedSession is ElectronManagedSessionTarget => managedSession !== undefined);
		const mismatches = managedSessions
			.map((managedSession) => {
				const record = records.find((candidate) => candidate.sessionName === managedSession.sessionName);
				const status = record ? statuses.find((candidate) => candidate.launchId === record.launchId) : undefined;
				return record && status ? buildElectronSessionMismatch({ managedSession, record, statusTargets: status.targets }) : undefined;
			})
			.filter((mismatch): mismatch is ElectronSessionMismatch => mismatch !== undefined);
		return buildElectronStatusResult({
			compiledElectron: redactedCompiledElectron ?? compiledElectron,
			managedSessions,
			mismatches,
			records,
			statuses,
		});
	}
	if (compiledElectron?.action === "probe") {
		const launchRecord = compiledElectron.launchId
			? electronLaunchRecords.get(compiledElectron.launchId)
			: findElectronLaunchRecordForSession(managedSessionName, electronLaunchRecords);
		if (compiledElectron.launchId && !launchRecord) {
			return buildElectronHostFailureResult({
				compiledElectron: redactedCompiledElectron ?? compiledElectron,
				errorText: `No wrapper-tracked Electron launch found for launchId ${compiledElectron.launchId}.`,
				failureCategory: "validation-error",
			});
		}
		if (compiledElectron.launchId && !launchRecord?.sessionName) {
			return buildElectronHostFailureResult({
				compiledElectron: redactedCompiledElectron ?? compiledElectron,
				errorText: `electron.probe launchId ${compiledElectron.launchId} has no attached managed sessionName; reattach with connect or run electron.launch again.`,
				failureCategory: "validation-error",
			});
		}
		if (!compiledElectron.launchId && !managedSessionActive) {
			return buildElectronHostFailureResult({
				compiledElectron: redactedCompiledElectron ?? compiledElectron,
				errorText: "electron.probe requires an active attached session. Run electron.launch or connect to an Electron debug port first.",
				failureCategory: "validation-error",
			});
		}
		const probeSessionName = compiledElectron.launchId ? launchRecord?.sessionName : managedSessionName;
		if (!probeSessionName) {
			return buildElectronHostFailureResult({
				compiledElectron: redactedCompiledElectron ?? compiledElectron,
				errorText: "electron.probe could not resolve a managed session to inspect.",
				failureCategory: "validation-error",
			});
		}
		try {
			const status = launchRecord ? await inspectElectronLaunchStatus(launchRecord) : undefined;
			const probe = await collectElectronProbe({ cwd, sessionName: probeSessionName, signal, timeoutMs: compiledElectron.timeoutMs });
			const managedSession: ElectronManagedSessionTarget = {
				sessionName: probe.sessionName,
				title: probe.title ?? probe.activeTab?.title,
				url: probe.url ?? probe.activeTab?.url,
			};
			const sessionMismatch = launchRecord && status
				? buildElectronSessionMismatch({ managedSession, record: launchRecord, statusTargets: status.targets })
				: undefined;
			const probeContextNote = !launchRecord
				? "No wrapper-tracked Electron launch matched this current managed session."
				: !compiledElectron.launchId && launchRecord.sessionName && launchRecord.sessionName !== probe.sessionName
					? `single active Electron launch ${launchRecord.launchId} uses wrapper session ${launchRecord.sessionName}; pass electron.probe.launchId to inspect that launch session directly.`
					: undefined;
			const probeContext: ElectronProbeContext = {
				launchId: launchRecord?.launchId,
				mode: compiledElectron.launchId ? "launchId" : "current-managed-session",
				note: probeContextNote,
				sessionName: probe.sessionName,
			};
			const sessionTabTarget = normalizeSessionTabTarget({
				title: probe.title ?? probe.activeTab?.title ?? probe.refSnapshot?.target?.title,
				url: probe.url ?? probe.activeTab?.url ?? probe.refSnapshot?.target?.url,
			});
			const pageStateUpdate = sessionPageState.beginUpdate();
			if (sessionTabTarget) {
				sessionPageState.applyTabTarget({ sessionName: probe.sessionName, target: sessionTabTarget, update: pageStateUpdate });
			}
			if (probe.refSnapshot) {
				sessionPageState.applyRefSnapshot({
					fallbackTarget: sessionTabTarget,
					sessionName: probe.sessionName,
					snapshot: probe.refSnapshot,
					update: pageStateUpdate,
				});
			}
			return buildElectronProbeResult({
				compiledElectron: redactedCompiledElectron ?? compiledElectron,
				mismatch: sessionMismatch,
				probe,
				probeContext,
				record: launchRecord,
				sessionTabTarget,
				status,
			});
		} catch (error) {
			const errorText = error instanceof Error ? error.message : String(error);
			return buildElectronHostFailureResult({
				compiledElectron: redactedCompiledElectron ?? compiledElectron,
				errorText: `Electron probe failed: ${errorText}`,
				failureCategory: "upstream-error",
			});
		}
	}
	if (compiledElectron?.action === "cleanup") {
		const selection = selectElectronRecords(compiledElectron, electronLaunchRecords);
		if (selection.error) return buildElectronHostFailureResult({ compiledElectron: redactedCompiledElectron ?? compiledElectron, errorText: selection.error, failureCategory: "validation-error" });
		const cleanupResults = await cleanupTrackedElectronHostLaunches({ cwd, electronChildProcesses, electronLaunchRecords, records: selection.records ?? [], timeoutMs: compiledElectron.timeoutMs ?? implicitSessionCloseTimeoutMs });
		return buildElectronCleanupResult(redactedCompiledElectron ?? compiledElectron, cleanupResults);
	}
	return undefined;
}
