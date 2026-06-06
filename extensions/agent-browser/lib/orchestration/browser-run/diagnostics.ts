import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { isCloseCommand, isOpenNavigationCommand } from "../../command-taxonomy.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import { boundElectronProbeString } from "../../electron/text.js";
import { executableExistsOnPath } from "../../executable-path.js";
import type { AgentBrowserSourceLookupAnalysis, CompiledAgentBrowserJob, CompiledAgentBrowserSemanticAction } from "../../input-modes.js";
import { isHttpOrHttpsUrl } from "../../input-modes/job.js";
import type { AgentBrowserNextAction } from "../../results.js";
import { formatSessionArtifactRetentionSummary } from "../../results/artifact-manifest.js";
import { buildNextToolAction, withOptionalSessionArgs } from "../../results/next-actions.js";
import { buildVisibleRefFallbackDiagnosticFromSnapshot, getVisibleRefFallbackTarget, type VisibleRefFallbackDiagnostic } from "../../results/selector-recovery.js";
import { extractRefSnapshotFromData, normalizeComparableUrl, type SessionRefSnapshot, type SessionTabTarget } from "../../session-page-state.js";
import { redactInvocationArgs, redactSensitiveText, type CommandInfo } from "../../runtime.js";
import { isRecord } from "../../parsing.js";
import {
	extractBatchResultCommand,
	extractNavigationSummaryFromData,
	extractStringResultField,
	findElectronLaunchRecordForSession,
	getGuardedRefUsage,
	runSessionCommandData,
} from "./session-state.js";
import { parseValidBatchStepEntries } from "../batch-stdin.js";
import { getScreenshotPathTokenIndex } from "./prepare.js";
import type {
	ArtifactCleanupGuidance,
	ComboboxFocusDiagnostic,
	ElectronBroadGetTextScopeDiagnostic,
	ElectronHandoffSummary,
	ElectronManagedSessionTarget,
	FillVerificationDiagnostic,
	NavigationSummary,
	OverlayBlockerCandidate,
	OverlayBlockerDiagnostic,
	QaAttachedPreconditionFailure,
	QaAttachedTarget,
	RecordingDependencyWarning,
	ScrollNoopDiagnostic,
	ScrollPositionSnapshot,
	SelectorTextVisibilityDiagnostic,
	TimeoutArtifactEvidence,
	TimeoutPartialProgress,
	TimeoutProgressStep,
} from "./types.js";
import type { SessionArtifactManifest } from "../../results/contracts.js";

const ELECTRON_FILL_VERIFICATION_TIMEOUT_MS = 2_000;

export function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function collectNavigationSummary(options: {
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<NavigationSummary | undefined> {
	return extractNavigationSummaryFromData(await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: `({ title: document.title, url: location.href })`,
	}));
}

function extractScrollPositionSnapshot(data: unknown): ScrollPositionSnapshot | undefined {
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	if (!isRecord(result)) return undefined;
	const scrollX = typeof result.scrollX === "number" ? result.scrollX : undefined;
	const scrollY = typeof result.scrollY === "number" ? result.scrollY : undefined;
	const innerHeight = typeof result.innerHeight === "number" ? result.innerHeight : undefined;
	const innerWidth = typeof result.innerWidth === "number" ? result.innerWidth : undefined;
	const scrollHeight = typeof result.scrollHeight === "number" ? result.scrollHeight : undefined;
	const scrollWidth = typeof result.scrollWidth === "number" ? result.scrollWidth : undefined;
	if (scrollX === undefined || scrollY === undefined || innerHeight === undefined || innerWidth === undefined || scrollHeight === undefined || scrollWidth === undefined) return undefined;
	const containers = Array.isArray(result.containers)
		? result.containers.flatMap((entry, index): ScrollPositionSnapshot["containers"] => {
			if (!isRecord(entry)) return [];
			const rawId = typeof entry.id === "string" ? entry.id : undefined;
			const id = rawId && /^\d+:[a-z][a-z0-9-]*(?:\[role=[a-z-]+\])?$/i.test(rawId) ? rawId : `sample-${index}`;
			const scrollTop = typeof entry.scrollTop === "number" ? entry.scrollTop : undefined;
			const scrollLeft = typeof entry.scrollLeft === "number" ? entry.scrollLeft : undefined;
			return scrollTop !== undefined && scrollLeft !== undefined ? [{ id, scrollLeft, scrollTop }] : [];
		})
		: [];
	return { containerCount: typeof result.containerCount === "number" ? result.containerCount : containers.length, containers, innerHeight, innerWidth, scrollHeight, scrollWidth, scrollX, scrollY };
}

const SCROLL_POSITION_EVAL = `(() => {
  const viewport = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    scrollHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
    scrollWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
  };
  const describe = (element, index) => {
    const role = element.getAttribute("role") || "";
    const id = element.tagName.toLowerCase();
    return { id: String(index) + ":" + id + (role ? "[role=" + role + "]" : ""), scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, area: element.clientWidth * element.clientHeight };
  };
  const containers = Array.from(document.querySelectorAll("body *"))
    .filter((element) => element instanceof HTMLElement && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1))
    .map(describe)
    .sort((left, right) => right.area - left.area)
    .slice(0, 10)
    .map(({ area, ...entry }) => entry);
  return { ...viewport, containerCount: containers.length, containers };
})()`;

export async function collectScrollPositionSnapshot(options: { cwd: string; sessionName?: string; signal?: AbortSignal }): Promise<ScrollPositionSnapshot | undefined> {
	return extractScrollPositionSnapshot(await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: SCROLL_POSITION_EVAL }));
}

function sameScrollPositionSnapshot(left: ScrollPositionSnapshot, right: ScrollPositionSnapshot): boolean {
	return left.scrollX === right.scrollX && left.scrollY === right.scrollY && left.scrollHeight === right.scrollHeight && left.scrollWidth === right.scrollWidth && left.containers.length === right.containers.length && left.containers.every((container, index) => {
		const other = right.containers[index];
		return other?.id === container.id && other.scrollTop === container.scrollTop && other.scrollLeft === container.scrollLeft;
	});
}

export function buildScrollNoopDiagnostic(before: ScrollPositionSnapshot | undefined, after: ScrollPositionSnapshot | undefined): ScrollNoopDiagnostic | undefined {
	if (!before || !after || !sameScrollPositionSnapshot(before, after)) return undefined;
	return {
		after,
		before,
		message: "Scroll reported success, but the viewport and sampled scrollable containers did not change position.",
		reason: "no-observed-scroll-position-change",
		recommendations: [
			"Run snapshot -i or screenshot to confirm what is visible before choosing the next action.",
			"On dashboards and panes with nested scrolling, use scrollintoview <@ref> for a visible target or target the actual scrollable region instead of repeating page scrolls.",
		],
	};
}

export function buildScrollNoopNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	return [
		{ id: "inspect-after-noop-scroll", params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) }, reason: "Refresh interactive refs and inspect whether the intended target is inside a nested scroll container.", safety: "Do not assume repeated page scrolls will move dashboard panels or nested panes.", tool: "agent_browser" },
		{ id: "verify-noop-scroll-visually", params: { args: withOptionalSessionArgs(sessionName, ["screenshot"]) }, reason: "Capture the current viewport to verify whether the scroll actually changed visible content.", safety: "Use screenshot evidence before concluding a dense dashboard did or did not move.", tool: "agent_browser" },
	];
}

export function formatScrollNoopDiagnosticText(diagnostic: ScrollNoopDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	return ["Scroll diagnostic: no observed scroll movement.", `Reason: ${diagnostic.message}`, `Sampled scrollable containers: ${diagnostic.after.containers.length}/${diagnostic.after.containerCount}.`, ...diagnostic.recommendations.map((recommendation) => `- ${recommendation}`)].join("\n");
}

const COMBOBOX_FOCUS_EVAL = `(() => {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  };
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const role = active?.getAttribute("role") || undefined;
  const hasPopup = active?.getAttribute("aria-haspopup") || undefined;
  const expanded = active?.getAttribute("aria-expanded") || undefined;
  const tagName = active?.tagName.toLowerCase();
  const name = (active?.getAttribute("aria-label") || active?.getAttribute("placeholder") || active?.getAttribute("title") || active?.textContent || "").trim().slice(0, 80) || undefined;
  const visibleListboxCount = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).filter(isVisible).length;
  const visibleOptionCount = Array.from(document.querySelectorAll('[role="option"], option, [role="menuitem"]')).filter(isVisible).length;
  const comboboxLike = role === "combobox" || hasPopup === "listbox" || hasPopup === "menu" || tagName === "select" || active?.getAttribute("aria-autocomplete") !== null;
  return { activeElement: active ? { expanded, hasPopup, name, role, tagName } : undefined, comboboxLike, visibleListboxCount, visibleOptionCount };
})()`;

function extractComboboxFocusDiagnostic(data: unknown): ComboboxFocusDiagnostic | undefined {
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	if (!isRecord(result) || result.comboboxLike !== true || !isRecord(result.activeElement)) return undefined;
	const visibleListboxCount = typeof result.visibleListboxCount === "number" ? result.visibleListboxCount : 0;
	const visibleOptionCount = typeof result.visibleOptionCount === "number" ? result.visibleOptionCount : 0;
	const expanded = typeof result.activeElement.expanded === "string" ? result.activeElement.expanded : undefined;
	if ((expanded !== "false" && expanded !== "true") || visibleListboxCount > 0 || visibleOptionCount > 0) return undefined;
	return {
		activeElement: {
			expanded,
			hasPopup: typeof result.activeElement.hasPopup === "string" ? result.activeElement.hasPopup : undefined,
			name: typeof result.activeElement.name === "string" ? redactSensitiveText(result.activeElement.name) : undefined,
			role: typeof result.activeElement.role === "string" ? result.activeElement.role : undefined,
			tagName: typeof result.activeElement.tagName === "string" ? result.activeElement.tagName : undefined,
		},
		message: "A combobox-like control is focused, but no listbox or option elements are visibly open.",
		reason: "focused-combobox-without-visible-options",
		recommendations: ["Run snapshot -i to inspect whether options appeared under a different role or portal.", "Try ArrowDown or Enter to open the option list before selecting, or use select/visible option refs when available."],
		visibleListboxCount,
		visibleOptionCount,
	};
}

function isComboboxFocusDiagnosticCommand(command: string | undefined, commandTokens: string[]): boolean {
	const explicitlyTargetsCombobox = commandTokens.some((token) => /^(?:combobox|listbox)$/i.test(token));
	if (!explicitlyTargetsCombobox) return false;
	if (command === "click" || command === "fill") return true;
	return command === "find" && commandTokens.some((token) => ["click", "fill"].includes(token));
}

function getCompiledSemanticActionRoleValue(compiled: CompiledAgentBrowserSemanticAction): string | undefined {
	if (compiled.locator !== "role") return undefined;
	const findIndex = compiled.args.indexOf("find");
	if (findIndex < 0 || compiled.args[findIndex + 1] !== "role") return undefined;
	return compiled.args[findIndex + 2];
}

function isComboboxFocusDiagnosticSemanticAction(compiled: CompiledAgentBrowserSemanticAction | undefined): boolean {
	if (!compiled || !["click", "fill"].includes(compiled.action)) return false;
	return /^(?:combobox|listbox)$/i.test(getCompiledSemanticActionRoleValue(compiled) ?? "");
}

export async function collectComboboxFocusDiagnostic(options: { command?: string; commandTokens: string[]; cwd: string; semanticAction?: CompiledAgentBrowserSemanticAction; sessionName?: string; signal?: AbortSignal }): Promise<ComboboxFocusDiagnostic | undefined> {
	if (!isComboboxFocusDiagnosticCommand(options.command, options.commandTokens) && !isComboboxFocusDiagnosticSemanticAction(options.semanticAction)) return undefined;
	return extractComboboxFocusDiagnostic(await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: COMBOBOX_FOCUS_EVAL }));
}

export function buildComboboxFocusNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	return [
		{ id: "inspect-focused-combobox", params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) }, reason: "Inspect the focused combobox and any portal/listbox refs before choosing an option.", safety: "Prefer visible option refs or select when a native/selectable option list is exposed.", tool: "agent_browser" },
		{ id: "try-open-combobox-with-arrow", params: { args: withOptionalSessionArgs(sessionName, ["press", "ArrowDown"]) }, reason: "Many searchable comboboxes open their option list with ArrowDown after focus.", safety: "Use only when the focused combobox is still the intended control, then re-snapshot before selecting.", tool: "agent_browser" },
		{ id: "try-open-combobox-with-enter", params: { args: withOptionalSessionArgs(sessionName, ["press", "Enter"]) }, reason: "Some comboboxes open or confirm their option list with Enter after focus.", safety: "Enter may select a highlighted/default option; prefer ArrowDown first unless Enter is the app's expected opener.", tool: "agent_browser" },
	];
}

export function formatComboboxFocusDiagnosticText(diagnostic: ComboboxFocusDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	const label = diagnostic.activeElement.name ? ` (${diagnostic.activeElement.name})` : "";
	return [`Combobox diagnostic: focused combobox did not expose visible options${label}.`, `Reason: ${diagnostic.message}`, ...diagnostic.recommendations.map((recommendation) => `- ${recommendation}`)].join("\n");
}

function getRecordStartLikeCommand(command: string | undefined, commandTokens: string[]): RecordingDependencyWarning["command"] | undefined {
	if (command !== "record") return undefined;
	const subcommand = commandTokens[1]?.toLowerCase();
	if (subcommand === "start") return "record start";
	if (subcommand === "restart") return "record restart";
	return undefined;
}

export async function collectRecordingDependencyWarning(options: { command: string | undefined; commandTokens: string[]; succeeded: boolean }): Promise<RecordingDependencyWarning | undefined> {
	if (!options.succeeded) return undefined;
	const recordCommand = getRecordStartLikeCommand(options.command, options.commandTokens);
	if (!recordCommand) return undefined;
	if (await executableExistsOnPath("ffmpeg")) return undefined;
	return { command: recordCommand, dependency: "ffmpeg", message: `${recordCommand} can begin recording, but record stop needs ffmpeg on PATH to encode the WebM output.`, reason: "ffmpeg-missing-for-recording", recommendations: ["Install ffmpeg before relying on this recording workflow; on macOS with Homebrew, brew install ffmpeg or brew install ffmpeg-full.", "If ffmpeg was just installed, restart pi or ensure the PATH visible to pi includes the ffmpeg binary before running record stop."] };
}

export function formatRecordingDependencyWarningText(warning: RecordingDependencyWarning | undefined): string | undefined {
	if (!warning) return undefined;
	return ["Recording dependency warning: ffmpeg not found on PATH.", `Reason: ${warning.message}`, ...warning.recommendations.map((recommendation) => `- ${recommendation}`)].join("\n");
}

function getSnapshotRefRecord(data: unknown): Record<string, unknown> | undefined {
	return isRecord(data) && isRecord(data.refs) ? data.refs : undefined;
}

const OVERLAY_CLOSE_NAME_PATTERN = /(?:\b(?:close|dismiss|no thanks|not now|maybe later|hide|skip|continue without|x)\b|^\s*×\s*$)/i;
const OVERLAY_CONTEXT_ROLES = new Set(["alertdialog", "dialog"]);
const OVERLAY_ACTION_ROLES = new Set(["button", "link", "menuitem"]);
const OVERLAY_BLOCKER_CANDIDATE_LIMIT = 3;

function getOverlayBlockerCandidates(snapshotData: unknown): OverlayBlockerCandidate[] {
	const refs = getSnapshotRefRecord(snapshotData);
	if (!refs) return [];
	const hasOverlayContext = Object.values(refs).some((entry) => isRecord(entry) && OVERLAY_CONTEXT_ROLES.has((typeof entry.role === "string" ? entry.role : "").toLowerCase()));
	if (!hasOverlayContext) return [];
	const candidates: OverlayBlockerCandidate[] = [];
	for (const [ref, entry] of Object.entries(refs)) {
		if (!/^e\d+$/.test(ref) || !isRecord(entry)) continue;
		const role = typeof entry.role === "string" ? entry.role : undefined;
		const name = typeof entry.name === "string" ? entry.name : undefined;
		if (!role || !OVERLAY_ACTION_ROLES.has(role.toLowerCase()) || !name || !OVERLAY_CLOSE_NAME_PATTERN.test(name)) continue;
		candidates.push({ args: ["click", `@${ref}`], name, reason: `Visible ${role} ${JSON.stringify(name)} appears in a snapshot that also contains overlay/banner/dialog context.`, ref: `@${ref}`, role });
		if (candidates.length >= OVERLAY_BLOCKER_CANDIDATE_LIMIT) break;
	}
	return candidates;
}

export function formatOverlayBlockerText(diagnostic: OverlayBlockerDiagnostic): string {
	return ["Possible overlay blockers:", ...diagnostic.candidates.map((candidate) => `- ${candidate.ref}${candidate.role ? ` ${candidate.role}` : ""}${candidate.name ? ` ${JSON.stringify(candidate.name)}` : ""}: ${candidate.reason}`)].join("\n");
}

export function buildOverlayBlockerNextActions(options: { diagnostic: OverlayBlockerDiagnostic; sessionName?: string }): AgentBrowserNextAction[] {
	return [{ id: "inspect-overlay-state", params: { args: withOptionalSessionArgs(options.sessionName, ["snapshot", "-i"]) }, reason: "Refresh interactive refs and inspect whether an overlay, banner, modal, or dialog is blocking the intended click.", safety: "Read-only inspection; use current refs from this snapshot before interacting.", tool: "agent_browser" }, ...options.diagnostic.candidates.map((candidate, index) => ({ id: `try-overlay-blocker-candidate-${index + 1}`, params: { args: withOptionalSessionArgs(options.sessionName, candidate.args) }, reason: candidate.reason, safety: "Only click this if the candidate is clearly a close/dismiss control for an overlay that blocks the intended workflow.", tool: "agent_browser" as const }))];
}

export function collectSnapshotOverlayBlockerDiagnostic(data: unknown): OverlayBlockerDiagnostic | undefined {
	const candidates = getOverlayBlockerCandidates(data);
	const snapshot = extractRefSnapshotFromData(data);
	if (candidates.length === 0 || !snapshot) return undefined;
	return { candidates, snapshot, summary: "Snapshot contains dialog/modal context plus likely close or dismiss controls; treat covered controls as potentially obstructed until the overlay state is resolved." };
}

export async function collectOverlayBlockerDiagnostic(options: { command?: string; cwd: string; data: unknown; navigationSummary?: NavigationSummary; priorTarget?: SessionTabTarget; sessionName?: string; signal?: AbortSignal }): Promise<OverlayBlockerDiagnostic | undefined> {
	if (options.command !== "click" || !isRecord(options.data) || typeof options.data.clicked !== "string") return undefined;
	const priorUrl = normalizeComparableUrl(options.priorTarget?.url);
	const currentUrl = normalizeComparableUrl(options.navigationSummary?.url);
	if (!priorUrl || !currentUrl || priorUrl !== currentUrl) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	const diagnostic = collectSnapshotOverlayBlockerDiagnostic(snapshotData);
	if (!diagnostic) return undefined;
	return { ...diagnostic, summary: `Click completed but the page stayed on ${currentUrl}; a fresh snapshot contains likely overlay close/dismiss controls.` };
}

const SELECTOR_TEXT_VISIBILITY_CANDIDATE_LIMIT = 8;

function buildVisibleTextProbeScript(selector: string): string {
	return `(() => {\n  const selector = ${JSON.stringify(selector)};\n  const isVisible = (element) => {\n    const style = window.getComputedStyle(element);\n    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;\n    return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);\n  };\n  let matches = [];\n  try {\n    matches = Array.from(document.querySelectorAll(selector));\n  } catch (error) {\n    return JSON.stringify({ selector, error: error instanceof Error ? error.message : String(error) });\n  }\n  const visible = matches.filter(isVisible);\n  const trim = (value) => typeof value === 'string' ? value.trim().replace(/\\s+/g, ' ').slice(0, 200) : undefined;\n  const describeCandidate = (element) => {\n    const index = matches.indexOf(element);\n    const role = element.getAttribute('role');\n    const candidate = { index, tagName: element.tagName.toLowerCase(), textPreview: trim(element.textContent) };\n    if (role) candidate.role = role;\n    return candidate;\n  };\n  const visibleCandidates = visible.slice(0, ${SELECTOR_TEXT_VISIBILITY_CANDIDATE_LIMIT}).map(describeCandidate);\n  return JSON.stringify({ selector, matchCount: matches.length, visibleCount: visible.length, firstMatchVisible: matches[0] ? isVisible(matches[0]) : undefined, firstTextPreview: trim(matches[0]?.textContent), firstVisibleTextPreview: trim(visible[0]?.textContent), visibleCandidates });\n})()`;
}

function parseSelectorTextVisibilityCandidates(value: unknown): SelectorTextVisibilityDiagnostic["visibleCandidates"] {
	if (!Array.isArray(value)) return undefined;
	const candidates = value.flatMap((entry): NonNullable<SelectorTextVisibilityDiagnostic["visibleCandidates"]> => {
		if (!isRecord(entry) || typeof entry.index !== "number" || typeof entry.tagName !== "string") return [];
		const role = typeof entry.role === "string" && entry.role.length > 0 ? entry.role : undefined;
		const textPreview = typeof entry.textPreview === "string" && entry.textPreview.length > 0 ? redactSensitiveText(entry.textPreview) : undefined;
		return [{ index: entry.index, tagName: entry.tagName, ...(role ? { role } : {}), ...(textPreview ? { textPreview } : {}) }];
	});
	return candidates.length > 0 ? candidates : undefined;
}

function parseSelectorTextVisibilityProbe(data: unknown, selector: string): Omit<SelectorTextVisibilityDiagnostic, "summary"> | undefined {
	const result = extractStringResultField(data, "result");
	if (!result) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(result); } catch { return undefined; }
	if (!isRecord(parsed) || typeof parsed.error === "string") return undefined;
	const matchCount = typeof parsed.matchCount === "number" ? parsed.matchCount : undefined;
	const visibleCount = typeof parsed.visibleCount === "number" ? parsed.visibleCount : undefined;
	if (matchCount === undefined || visibleCount === undefined) return undefined;
	return {
		firstMatchVisible: typeof parsed.firstMatchVisible === "boolean" ? parsed.firstMatchVisible : undefined,
		firstVisibleTextPreview: typeof parsed.firstVisibleTextPreview === "string" && parsed.firstVisibleTextPreview.length > 0 ? redactSensitiveText(parsed.firstVisibleTextPreview) : undefined,
		matchCount,
		selector,
		visibleCandidates: parseSelectorTextVisibilityCandidates(parsed.visibleCandidates),
		visibleCount,
	};
}

function selectorMayExposeSensitiveLiteral(selector: string): boolean {
	return redactSensitiveText(selector) !== selector || /\[[^\]]*[~|^$*]?=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+)\s*(?:[is]\s*)?\]/.test(selector);
}

async function collectSelectorTextVisibilityDiagnosticForSelector(options: { cwd: string; selector: string | undefined; sessionName?: string; signal?: AbortSignal }): Promise<SelectorTextVisibilityDiagnostic | undefined> {
	const { selector } = options;
	if (!selector || /^@e\d+$/.test(selector) || selectorMayExposeSensitiveLiteral(selector)) return undefined;
	const probe = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: buildVisibleTextProbeScript(selector) });
	const parsed = parseSelectorTextVisibilityProbe(probe, selector);
	if (!parsed || parsed.matchCount <= 1 && parsed.firstMatchVisible !== false) return undefined;
	if (parsed.visibleCount === 0) return undefined;
	const visibleMatchNoun = `visible match${parsed.visibleCount === 1 ? "" : "es"}`;
	const visibleMatchVerb = parsed.visibleCount === 1 ? "exists" : "exist";
	const summary = parsed.firstMatchVisible === false
		? `Selector ${JSON.stringify(selector)} matched ${parsed.matchCount} elements; the first match is hidden while ${parsed.visibleCount} ${visibleMatchNoun} ${visibleMatchVerb}.`
		: `Selector ${JSON.stringify(selector)} matched ${parsed.matchCount} elements; get text reads the first upstream match, which may not be the intended visible tab/panel.`;
	return { ...parsed, summary };
}

function getBatchGetTextSelectors(data: unknown): string[] {
	if (!Array.isArray(data)) return [];
	return data.flatMap((item) => {
		if (!isRecord(item) || item.success === false) return [];
		const [command, subcommand, selector] = extractBatchResultCommand(item);
		return command === "get" && subcommand === "text" && selector ? [selector] : [];
	});
}

function getSuccessfulGetTextSelectors(options: { commandInfo: CommandInfo; commandTokens: string[]; data: unknown }): string[] {
	return options.commandInfo.command === "get" && options.commandInfo.subcommand === "text"
		? [options.commandTokens[2]].filter((selector): selector is string => typeof selector === "string" && selector.length > 0)
		: options.commandInfo.command === "batch" ? getBatchGetTextSelectors(options.data) : [];
}

export async function collectSelectorTextVisibilityDiagnostics(options: { commandInfo: CommandInfo; commandTokens: string[]; cwd: string; data: unknown; sessionName?: string; signal?: AbortSignal }): Promise<SelectorTextVisibilityDiagnostic[]> {
	const selectors = getSuccessfulGetTextSelectors(options);
	const diagnostics: SelectorTextVisibilityDiagnostic[] = [];
	for (const selector of selectors) {
		const diagnostic = await collectSelectorTextVisibilityDiagnosticForSelector({ cwd: options.cwd, selector, sessionName: options.sessionName, signal: options.signal });
		if (diagnostic) diagnostics.push(diagnostic);
	}
	return diagnostics.sort((left, right) => Number(right.firstMatchVisible === false) - Number(left.firstMatchVisible === false));
}

export function formatSelectorTextVisibilityText(diagnostics: SelectorTextVisibilityDiagnostic[]): string | undefined {
	if (diagnostics.length === 0) return undefined;
	return diagnostics.flatMap((diagnostic, index) => {
		const actionId = index === 0 ? "inspect-visible-text-candidates" : `inspect-visible-text-candidates-${index + 1}`;
		const lines = [`Selector text visibility warning: ${diagnostic.summary}`];
		if (diagnostic.firstVisibleTextPreview) lines.push(`First visible text preview: ${JSON.stringify(diagnostic.firstVisibleTextPreview)}`);
		if (diagnostic.visibleCandidates && diagnostic.visibleCandidates.length > 0) {
			lines.push(`Visible candidates (${diagnostic.visibleCandidates.length} shown, querySelectorAll index):`);
			for (const candidate of diagnostic.visibleCandidates) {
				const rolePart = candidate.role ? ` role=${candidate.role}` : "";
				const previewPart = candidate.textPreview ? `: ${JSON.stringify(candidate.textPreview)}` : "";
				lines.push(`- [${candidate.index}] ${candidate.tagName}${rolePart}${previewPart}`);
			}
		}
		lines.push(`Next action: use details.nextActions ${actionId} before trusting this selector text.`);
		return lines;
	}).join("\n");
}

export function buildSelectorTextVisibilityNextActions(options: { diagnostics: SelectorTextVisibilityDiagnostic[]; sessionName?: string }): AgentBrowserNextAction[] {
	return options.diagnostics.map((diagnostic, index) => ({ id: index === 0 ? "inspect-visible-text-candidates" : `inspect-visible-text-candidates-${index + 1}`, params: { args: withOptionalSessionArgs(options.sessionName, ["eval", "--stdin"]), stdin: buildVisibleTextProbeScript(diagnostic.selector) }, reason: "Inspect selector match count and visible text before trusting get text on tabbed or hidden DOM content.", safety: "Read-only DOM inspection; use a more specific visible selector or current @ref before acting on hidden-tab text.", tool: "agent_browser" as const }));
}

function normalizeSelectorForScopeHeuristic(selector: string): string {
	return selector.trim().replace(/\s+/g, " ").toLowerCase();
}

function isBroadGetTextSelector(selector: string | undefined): selector is string {
	if (!selector || /^@e\d+$/.test(selector) || selectorMayExposeSensitiveLiteral(selector)) return false;
	const normalized = normalizeSelectorForScopeHeuristic(selector);
	return normalized === "body" || normalized === "html" || normalized === ":root" || normalized === "*" || normalized === "main" || normalized === "div" || normalized === "section" || normalized === "article" || /^\[role=(?:"application"|'application'|application)\]$/i.test(normalized);
}

function getElectronTextScopeContext(options: { currentTarget?: SessionTabTarget; electronLaunchRecords: Map<string, ElectronLaunchRecord>; priorTarget?: SessionTabTarget; sessionName?: string }): ElectronBroadGetTextScopeDiagnostic["electronContext"] | undefined {
	const record = findElectronLaunchRecordForSession(options.sessionName, options.electronLaunchRecords);
	if (!record) return undefined;
	const url = options.currentTarget?.url ?? options.priorTarget?.url;
	return { launchId: record.launchId, sessionName: record.sessionName ?? options.sessionName, url };
}

export function getSourceLookupElectronContext(options: { currentTarget?: SessionTabTarget; electronLaunchRecords: Map<string, ElectronLaunchRecord>; priorTarget?: SessionTabTarget; sessionName?: string }): AgentBrowserSourceLookupAnalysis["electronContext"] | undefined {
	const record = findElectronLaunchRecordForSession(options.sessionName, options.electronLaunchRecords);
	if (!record) return undefined;
	const url = options.currentTarget?.url ?? options.priorTarget?.url;
	return { appName: record.appName, appPath: record.appPath, executablePath: record.executablePath, launchId: record.launchId, sessionName: record.sessionName ?? options.sessionName, url };
}

export function buildSourceLookupElectronNextActions(sourceLookup: AgentBrowserSourceLookupAnalysis | undefined): AgentBrowserNextAction[] {
	if (sourceLookup?.status !== "no-candidates" || !sourceLookup.electronContext) return [];
	const actions: AgentBrowserNextAction[] = [];
	const { launchId, sessionName } = sourceLookup.electronContext;
	if (sessionName) actions.push({ id: "snapshot-electron-session", params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) }, reason: "Refresh interactive refs in the attached Electron session before retrying source lookup with a narrower target.", safety: "Read-only snapshot; no app mutation.", tool: "agent_browser" });
	if (launchId) actions.push({ id: "probe-electron-launch", params: { electron: { action: "probe", launchId } }, reason: "Collect bounded wrapper/session context for the packaged Electron launch after sourceLookup found no candidates.", safety: "Read-only probe of title, URL, focus, tabs, and compact snapshot metadata.", tool: "agent_browser" });
	if (sessionName) actions.push({ id: "list-electron-tabs", params: { args: withOptionalSessionArgs(sessionName, ["tab", "list"]) }, reason: "Check current Electron tabs/targets before choosing a narrower selector or @ref.", safety: "Read-only tab listing.", tool: "agent_browser" });
	return actions;
}

export function collectElectronBroadGetTextScopeDiagnostics(options: { commandInfo: CommandInfo; commandTokens: string[]; currentTarget?: SessionTabTarget; data: unknown; electronLaunchRecords: Map<string, ElectronLaunchRecord>; priorTarget?: SessionTabTarget; sessionName?: string }): ElectronBroadGetTextScopeDiagnostic[] {
	const electronContext = getElectronTextScopeContext(options);
	if (!electronContext) return [];
	return getSuccessfulGetTextSelectors(options).filter(isBroadGetTextSelector).map((selector) => ({ electronContext, selector, summary: `Broad Electron get text selector warning: selector ${JSON.stringify(selector)} may read the entire app shell; prefer snapshot -i and a current @ref or a narrower panel selector.` }));
}

export function formatElectronBroadGetTextScopeText(diagnostics: ElectronBroadGetTextScopeDiagnostic[]): string | undefined {
	return diagnostics.length > 0 ? diagnostics.map((diagnostic) => diagnostic.summary).join("\n") : undefined;
}

export function buildElectronBroadGetTextScopeNextActions(options: { diagnostics: ElectronBroadGetTextScopeDiagnostic[]; sessionName?: string }): AgentBrowserNextAction[] {
	return options.diagnostics.map((diagnostic, index) => ({ id: index === 0 ? "snapshot-for-electron-text-scope" : `snapshot-for-electron-text-scope-${index + 1}`, params: { args: withOptionalSessionArgs(options.sessionName, ["snapshot", "-i"]) }, reason: `Refresh Electron refs before trusting broad get text selector ${JSON.stringify(diagnostic.selector)}.`, safety: "Read-only snapshot; prefer a current @ref or narrower selector before extracting app-shell text.", tool: "agent_browser" as const }));
}

function looksLikeFunctionEvalStdin(stdin: string | undefined): boolean {
	const trimmed = stdin?.trim();
	if (!trimmed) return false;
	return /^(?:async\s+)?function\b/.test(trimmed) || /^(?:async\s*)?\([^)]*\)\s*=>/.test(trimmed) || /^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(trimmed);
}

function isPlainEmptyObject(value: unknown): boolean {
	if (!isRecord(value) || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return (prototype === Object.prototype || prototype === null) && Object.keys(value).length === 0;
}

export function getEvalStdinHint(options: { command?: string; data: unknown; stdin?: string }) {
	if (options.command !== "eval" || !looksLikeFunctionEvalStdin(options.stdin) || !isRecord(options.data)) return undefined;
	const result = options.data.result;
	if (!isPlainEmptyObject(result)) return undefined;
	return { reason: "eval --stdin received a function-shaped snippet and the upstream JSON result was an empty object, which often means the function itself was returned or serialized instead of invoked.", suggestion: "Pass a plain expression such as `({ title: document.title })`, or invoke the function explicitly, for example `(() => ({ title: document.title }))()`." };
}

export function formatEvalStdinHintText(hint: ReturnType<typeof getEvalStdinHint>): string | undefined {
	return hint ? `Eval stdin hint: ${hint.reason} ${hint.suggestion}` : undefined;
}

export function getEvalResultWarning(options: { command?: string; data: unknown; navigationSummary?: { url?: string }; pageUrl?: string; stdin?: string }) {
	if (options.command !== "eval" || !options.stdin?.trim() || !isRecord(options.data) || options.data.result !== null) return undefined;
	const pageUrl = options.pageUrl?.trim() ?? options.navigationSummary?.url?.trim() ?? extractNavigationSummaryFromData(options.data)?.url;
	if (!pageUrl || !/^file:/i.test(pageUrl)) return undefined;
	const trimmed = options.stdin.trim();
	if (/^(?:null|undefined)$/i.test(trimmed)) return undefined;
	return {
		reason: "eval --stdin returned null on a file:// page; upstream may not expose full DOM semantics for local fixtures.",
		suggestion: "Treat this as inconclusive verification. Use snapshot -i, get text on current @refs, screenshot evidence, or a reachable http(s) fixture before concluding DOM state.",
	};
}

export function formatEvalResultWarningText(warning: ReturnType<typeof getEvalResultWarning>): string | undefined {
	return warning ? `Eval result warning: ${warning.reason} ${warning.suggestion}` : undefined;
}

export async function getArtifactCleanupGuidance(options: { command?: string; cwd: string; manifest?: SessionArtifactManifest; succeeded: boolean }): Promise<ArtifactCleanupGuidance | undefined> {
	if (!options.succeeded || !isCloseCommand(options.command) || !options.manifest || options.manifest.entries.length === 0) return undefined;
	const explicitEntries = options.manifest.entries.filter((entry) => entry.storageScope === "explicit-path");
	const explicitArtifactPaths: string[] = [];
	const seenPaths = new Set<string>();
	for (const entry of explicitEntries) {
		if (explicitArtifactPaths.length >= 10) break;
		const displayPath = entry.path;
		if (seenPaths.has(displayPath)) continue;
		const absolutePath = entry.absolutePath ?? (isAbsolute(entry.path) ? entry.path : resolve(options.cwd, entry.path));
		try { await stat(absolutePath); } catch { continue; }
		seenPaths.add(displayPath);
		explicitArtifactPaths.push(displayPath);
	}
	return { explicitArtifactPaths, note: "Closing the browser session does not delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings; clean existing paths with host file tools when no longer needed.", owner: "host-file-tools", summary: formatSessionArtifactRetentionSummary(options.manifest) };
}

export function formatArtifactCleanupGuidanceText(guidance: ArtifactCleanupGuidance | undefined): string | undefined {
	if (!guidance) return undefined;
	const lines = ["Artifact lifecycle:", `- ${guidance.summary}`, `- ${guidance.note}`];
	if (guidance.explicitArtifactPaths.length > 0) lines.push(`- Explicit artifact paths to review: ${guidance.explicitArtifactPaths.join(", ")}`);
	return lines.join("\n");
}

async function collectManagedSessionCommandData(options: { args: string[]; cwd: string; sessionName: string; signal?: AbortSignal; timeoutMs?: number }): Promise<{ data?: unknown; error?: string }> {
	try { return { data: await runSessionCommandData(options) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function collectElectronManagedSessionUrl(options: { cwd: string; sessionName: string; signal?: AbortSignal; timeoutMs?: number }): Promise<{ error?: string; url?: string }> {
	const urlResult = await collectManagedSessionCommandData({
		args: ["get", "url"],
		cwd: options.cwd,
		sessionName: options.sessionName,
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
	const url = boundElectronProbeString(extractStringResultField(urlResult.data, "result") ?? extractStringResultField(urlResult.data, "url"), 300);
	return urlResult.error ? { error: urlResult.error } : { url };
}

export async function collectElectronManagedSessionTarget(options: { cwd: string; sessionName?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<ElectronManagedSessionTarget | undefined> {
	if (!options.sessionName) return undefined;
	const [titleResult, urlResult] = await Promise.all([
		collectManagedSessionCommandData({ args: ["get", "title"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, timeoutMs: options.timeoutMs }),
		collectManagedSessionCommandData({ args: ["get", "url"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, timeoutMs: options.timeoutMs }),
	]);
	const title = boundElectronProbeString(extractStringResultField(titleResult.data, "result") ?? extractStringResultField(titleResult.data, "title"), 160);
	const url = boundElectronProbeString(extractStringResultField(urlResult.data, "result") ?? extractStringResultField(urlResult.data, "url"), 300);
	const errors = [titleResult.error, urlResult.error].filter((value): value is string => value !== undefined);
	return { sessionName: options.sessionName, title, url, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
}

export async function collectQaAttachedTarget(options: { currentTarget?: SessionTabTarget; cwd: string; sessionName?: string; signal?: AbortSignal }): Promise<QaAttachedTarget | undefined> {
	if (!options.sessionName) return undefined;
	if (options.currentTarget?.title || options.currentTarget?.url) return { sessionName: options.sessionName, title: options.currentTarget.title, url: options.currentTarget.url };
	return collectElectronManagedSessionTarget({ cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
}

export function formatQaAttachedTargetText(target: QaAttachedTarget | undefined): string | undefined {
	if (!target) return undefined;
	return ["QA attached target:", target.sessionName, target.title, target.url].filter((part): part is string => typeof part === "string" && part.length > 0).join(" — ");
}

export function buildQaAttachedRecoveryNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	const sessionArgs = (args: string[]) => withOptionalSessionArgs(sessionName, args);
	return [
		buildNextToolAction({
			args: sessionArgs(["tab", "list"]),
			id: "list-tabs-before-qa-attached",
			reason: "Inspect the connected session tabs before retrying qa.attached.",
			safety: "Read-only tab listing for the attached session.",
		}),
		buildNextToolAction({
			args: sessionArgs(["snapshot", "-i"]),
			id: "snapshot-before-qa-attached",
			reason: "Capture interactive refs on the active http(s) page before retrying qa.attached.",
			safety: "Read-only snapshot; confirms a renderable page is selected.",
		}),
	];
}

export async function validateQaAttachedPrecondition(options: {
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<QaAttachedPreconditionFailure | undefined> {
	if (!options.sessionName) {
		return {
			error: "qa.attached requires an active attached session with a resolvable session name.",
			nextActions: buildQaAttachedRecoveryNextActions(options.sessionName),
		};
	}
	const urlProbe = await collectElectronManagedSessionUrl({ cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	if (urlProbe.error) {
		return {
			error: `qa.attached could not read the attached session URL: ${urlProbe.error}. Run tab list or snapshot -i before retrying qa.attached.`,
			nextActions: buildQaAttachedRecoveryNextActions(options.sessionName),
		};
	}
	const url = urlProbe.url?.trim();
	if (!url) {
		return {
			error: "qa.attached requires an attached session with a readable http(s) page URL. Run tab list, select a stable tab, then snapshot -i before retrying.",
			nextActions: buildQaAttachedRecoveryNextActions(options.sessionName),
		};
	}
	if (!isHttpOrHttpsUrl(url)) {
		return {
			error: `qa.attached requires an http(s) page URL; the current attached URL is "${url}". Use tab list and snapshot -i to recover a web surface before retrying.`,
			nextActions: buildQaAttachedRecoveryNextActions(options.sessionName),
		};
	}
	return undefined;
}

function getTopLevelFillInvocation(commandTokens: string[]): { expected: string; refId?: string; selector: string } | undefined {
	if (commandTokens[0] !== "fill" || commandTokens.length < 3) return undefined;
	const selector = commandTokens[1];
	const expected = commandTokens.slice(2).join(" ");
	const refId = selector?.match(/^@?(e\d+)$/)?.[1];
	return selector && expected.length > 0 ? { expected, ...(refId ? { refId } : {}), selector } : undefined;
}

function shouldVerifyContenteditableFill(fill: { refId?: string } | undefined, refSnapshot?: SessionRefSnapshot): boolean {
	if (!fill?.refId) return false;
	const ref = refSnapshot?.refs?.[fill.refId];
	if (!ref) return false;
	return ref.isContentEditable === true && (ref.role === "generic" || ref.role === "unknown" || ref.role === "textbox");
}

export function buildFillVerificationNextActions(diagnostic: FillVerificationDiagnostic, sessionName: string | undefined): AgentBrowserNextAction[] {
	return [
		{ id: "inspect-after-fill-verification", params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) }, reason: "Refresh the UI after a fill that reported success but did not appear to update the target.", safety: "Read-only snapshot; use current refs before retrying.", tool: "agent_browser" },
		{ id: "verify-filled-value", params: { args: withOptionalSessionArgs(sessionName, ["get", diagnostic.method, diagnostic.selector]) }, reason: `Check the target ${diagnostic.method} directly before submitting or creating files.`, safety: "Read-only check; selector may still be stale if the UI rerendered.", tool: "agent_browser" },
	];
}

function extractFillVerificationValue(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (!isRecord(data)) return undefined;
	if (typeof data.value === "string") return data.value;
	if (typeof data.result === "string") return data.result;
	return undefined;
}

export async function collectFillVerificationDiagnostic(options: { commandTokens: string[]; cwd: string; forceValueVerification?: boolean; refSnapshot?: SessionRefSnapshot; sessionName?: string; signal?: AbortSignal }): Promise<FillVerificationDiagnostic | undefined> {
	const fill = getTopLevelFillInvocation(options.commandTokens);
	if (!fill || !options.sessionName) return undefined;
	const contenteditable = shouldVerifyContenteditableFill(fill, options.refSnapshot);
	if (!contenteditable && !options.forceValueVerification) return undefined;
	const method = contenteditable ? "text" : "value";
	let valueData: unknown | undefined;
	try { valueData = await runSessionCommandData({ args: ["get", method, fill.selector], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, timeoutMs: ELECTRON_FILL_VERIFICATION_TIMEOUT_MS }); } catch { return undefined; }
	const actual = extractFillVerificationValue(valueData);
	if (actual === undefined || actual === fill.expected) return undefined;
	const reason = contenteditable ? "contenteditable-fill-mismatch" : "value-fill-mismatch";
	const actualPreview = actual.length > 0 ? `"${boundElectronProbeString(actual, 80)}"` : `an empty ${method}`;
	const diagnostic: FillVerificationDiagnostic = { actual: actual.length > 0 ? boundElectronProbeString(actual, 160) : "", expected: boundElectronProbeString(fill.expected, 160) ?? fill.expected, method, nextActionIds: [], reason, selector: fill.selector, status: "mismatch", summary: `Fill verification warning: fill ${fill.selector} reported success, but get ${method} returned ${actualPreview}.` };
	diagnostic.nextActionIds = buildFillVerificationNextActions(diagnostic, options.sessionName).map((action) => action.id);
	return diagnostic;
}

export function formatFillVerificationText(diagnostic: FillVerificationDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	const actual = diagnostic.actual !== undefined ? `actual "${diagnostic.actual}"` : `actual ${diagnostic.method} unavailable`;
	const recovery = diagnostic.reason === "contenteditable-fill-mismatch"
		? "Contenteditable fill may append or prepend instead of replacing. Re-run snapshot -i, then prefer focus/click plus keyboard shortcut selection or direct keyboard insertion only after verifying the editor state."
		: "Re-run snapshot -i, then prefer click/focus plus keyboard type for custom quick-input controls before submitting.";
	return `${diagnostic.summary}\nExpected: "${diagnostic.expected}"; ${actual}.\nNext: ${recovery}`;
}

export async function collectVisibleRefFallbackDiagnostic(options: { commandTokens: string[]; compiledSemanticAction?: CompiledAgentBrowserSemanticAction; cwd: string; sessionName?: string; signal?: AbortSignal }): Promise<VisibleRefFallbackDiagnostic | undefined> {
	if (!options.sessionName) return undefined;
	const target = getVisibleRefFallbackTarget({ commandTokens: options.commandTokens, compiledSemanticAction: options.compiledSemanticAction });
	if (!target) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	return buildVisibleRefFallbackDiagnosticFromSnapshot({ snapshotData, target });
}

export async function collectElectronHandoff(options: { cwd: string; handoff: "connect" | "snapshot" | "tabs"; sessionName?: string; signal?: AbortSignal }): Promise<ElectronHandoffSummary> {
	if (options.handoff === "connect") return { handoff: "connect" };
	const tabs = await runSessionCommandData({ args: ["tab", "list"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	if (options.handoff === "tabs") return { handoff: "tabs", tabs };
	let snapshot = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	let refSnapshot = extractRefSnapshotFromData(snapshot);
	let snapshotRetryCount = 0;
	while ((!refSnapshot || refSnapshot.refIds.length === 0) && snapshotRetryCount < 2) {
		snapshotRetryCount += 1;
		await sleepMs(250);
		snapshot = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
		refSnapshot = extractRefSnapshotFromData(snapshot);
	}
	return { handoff: "snapshot", refSnapshot, snapshot, ...(snapshotRetryCount > 0 ? { snapshotRetryCount } : {}), tabs };
}

function getTimeoutProgressSteps(compiledJob: CompiledAgentBrowserJob | undefined, command: string | undefined, stdin: string | undefined): Array<{ args: string[]; generatedFrom?: string; index: number }> {
	if (compiledJob) return compiledJob.steps.map((step, index) => ({ args: step.args, generatedFrom: step.generatedFrom, index: index + 1 }));
	if (command !== "batch" || !stdin) return [];
	return parseValidBatchStepEntries(stdin).map(({ index, step }) => ({ args: step, index: index + 1 }));
}

function getLastPositionalToken(args: string[], startIndex = 1): string | undefined {
	for (let index = args.length - 1; index >= startIndex; index -= 1) {
		const token = args[index];
		if (token && !token.startsWith("-")) return token;
	}
	return undefined;
}

function getTimeoutStepArtifactPath(args: string[]): string | undefined {
	const [command] = args;
	if (command === "screenshot") {
		const index = getScreenshotPathTokenIndex(args);
		return index === undefined ? undefined : args[index];
	}
	if (command === "pdf") return getLastPositionalToken(args);
	if (command === "download") return getLastPositionalToken(args, 2);
	if (command === "wait") {
		const inlineDownload = args.find((token) => token.startsWith("--download="));
		if (inlineDownload) return inlineDownload.slice("--download=".length) || undefined;
		const downloadIndex = args.indexOf("--download");
		const downloadPath = downloadIndex >= 0 ? args[downloadIndex + 1] : undefined;
		if (downloadPath && !downloadPath.startsWith("-")) return downloadPath;
	}
	return undefined;
}

async function statTimeoutArtifactPath(absolutePath: string): Promise<{ exists: false } | { exists: true; sizeBytes: number }> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const stats = await stat(absolutePath);
			return { exists: true, sizeBytes: stats.size };
		} catch {
			if (attempt < 2) await sleepMs(25);
		}
	}
	return { exists: false };
}

async function collectTimeoutArtifactEvidence(cwd: string, steps: Array<{ args: string[]; index: number }>): Promise<TimeoutArtifactEvidence[]> {
	const evidence: TimeoutArtifactEvidence[] = [];
	for (const step of steps) {
		const path = getTimeoutStepArtifactPath(step.args);
		if (!path) continue;
		const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
		const artifact = await statTimeoutArtifactPath(absolutePath);
		evidence.push(artifact.exists
			? { absolutePath, exists: true, path, sizeBytes: artifact.sizeBytes, state: "verified", stepIndex: step.index }
			: { absolutePath, exists: false, path, state: "missing", stepIndex: step.index });
	}
	return evidence;
}

function getPlannedCurrentPageUrl(steps: Array<{ args: string[]; index: number }>): string | undefined {
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const args = steps[index]?.args ?? [];
		if (isOpenNavigationCommand(args[0]) || args[0] === "pushstate") return getLastPositionalToken(args);
	}
	return undefined;
}

const TIMEOUT_RETRYABLE_COMMANDS = new Set([
	"console",
	"diff",
	"errors",
	"get",
	"goto",
	"navigate",
	"network",
	"open",
	"pdf",
	"pushstate",
	"screenshot",
	"snapshot",
	"tab",
	"vitals",
	"wait",
]);

function getTimeoutStepRetry(step: { args: string[] }): { args: string[] } | undefined {
	const command = step.args[0];
	return command && TIMEOUT_RETRYABLE_COMMANDS.has(command) ? { args: step.args } : undefined;
}

function normalizeUrlForTimeoutComparison(url: string | undefined): URL | undefined {
	if (!url) return undefined;
	try {
		return new URL(url);
	} catch {
		return undefined;
	}
}

function currentUrlMatchesNavigationStep(currentUrl: string | undefined, plannedUrl: string | undefined): boolean {
	if (!currentUrl || !plannedUrl) return false;
	if (currentUrl === plannedUrl) return true;
	const current = normalizeUrlForTimeoutComparison(currentUrl);
	const planned = normalizeUrlForTimeoutComparison(plannedUrl);
	if (!current || !planned || current.origin !== planned.origin) return false;
	const plannedPath = planned.pathname.endsWith("/") ? planned.pathname : `${planned.pathname}/`;
	const currentPath = current.pathname.endsWith("/") ? current.pathname : `${current.pathname}/`;
	return planned.pathname === "/" || currentPath.startsWith(plannedPath);
}

function buildTimeoutProgressSteps(options: {
	artifacts: TimeoutArtifactEvidence[];
	currentPageSource?: "live" | "planned";
	currentPageUrl?: string;
	steps: Array<{ args: string[]; generatedFrom?: string; index: number }>;
}): { openedButPostOpenTimedOut?: boolean; retryStep?: TimeoutProgressStep; steps: TimeoutProgressStep[] } {
	let retryStep: TimeoutProgressStep | undefined;
	let lastCompletedNavigationIndex: number | undefined;
	const progressSteps = options.steps.map((step): TimeoutProgressStep => {
		const stepArtifacts = options.artifacts.filter((artifact) => artifact.stepIndex === step.index);
		const command = step.args[0];
		const navigationUrl = isOpenNavigationCommand(command) || command === "pushstate" ? getLastPositionalToken(step.args) : undefined;
		if (stepArtifacts.some((artifact) => artifact.exists)) {
			return { ...step, reason: "Declared artifact exists on disk after timeout.", status: "completed" };
		}
		if (options.currentPageSource === "live" && currentUrlMatchesNavigationStep(options.currentPageUrl, navigationUrl)) {
			lastCompletedNavigationIndex = step.index;
			return { ...step, reason: "Live page URL was recovered after timeout.", status: "completed" };
		}
		return { ...step, reason: stepArtifacts.length > 0 ? "Declared artifact was not present when the watchdog fired." : undefined, status: "unknown" };
	});
	const highestCompletedIndex = Math.max(0, ...progressSteps.filter((step) => step.status === "completed").map((step) => step.index));
	for (const step of progressSteps) {
		if (step.status === "unknown" && step.index < highestCompletedIndex) {
			step.status = "completed";
			step.reason = "Later step completion evidence indicates the batch advanced past this step before timeout.";
		}
	}
	for (const step of progressSteps) {
		if (step.status === "completed") continue;
		if (!retryStep) {
			const retry = getTimeoutStepRetry(step);
			retryStep = {
				...step,
				reason: step.reason ?? (retry ? "Likely active when the wrapper watchdog fired." : "Likely active when the wrapper watchdog fired; executable retry omitted because this step may have already mutated page state."),
				retry,
				status: "failed",
			};
			Object.assign(step, retryStep);
			continue;
		}
		step.status = "pending";
		step.reason = step.reason ?? `Pending behind timed-out step ${retryStep.index}.`;
	}
	return {
		openedButPostOpenTimedOut: lastCompletedNavigationIndex !== undefined && retryStep !== undefined && retryStep.index > lastCompletedNavigationIndex,
		retryStep,
		steps: progressSteps,
	};
}

export async function collectTimeoutPartialProgress(options: { command?: string; compiledJob?: CompiledAgentBrowserJob; cwd: string; sessionName?: string; stdin?: string }): Promise<TimeoutPartialProgress | undefined> {
	const rawSteps = getTimeoutProgressSteps(options.compiledJob, options.command, options.stdin);
	const artifacts = await collectTimeoutArtifactEvidence(options.cwd, rawSteps);
	const [urlData, titleData] = await Promise.all([runSessionCommandData({ args: ["get", "url"], cwd: options.cwd, sessionName: options.sessionName }), runSessionCommandData({ args: ["get", "title"], cwd: options.cwd, sessionName: options.sessionName })]);
	const recoveredUrl = extractStringResultField(urlData, "result") ?? extractStringResultField(urlData, "url");
	const title = extractStringResultField(titleData, "result") ?? extractStringResultField(titleData, "title");
	const plannedUrl = recoveredUrl ? undefined : getPlannedCurrentPageUrl(rawSteps);
	const url = recoveredUrl ?? plannedUrl;
	const currentPageSource = recoveredUrl ? "live" as const : plannedUrl ? "planned" as const : title ? "live" as const : undefined;
	const stepProgress = buildTimeoutProgressSteps({ artifacts, currentPageSource: recoveredUrl ? "live" : undefined, currentPageUrl: recoveredUrl, steps: rawSteps });
	if (rawSteps.length === 0 && artifacts.length === 0 && !url && !title) return undefined;
	const foundArtifacts = artifacts.filter((artifact) => artifact.exists).length;
	const completedSteps = stepProgress.steps.filter((step) => step.status === "completed").length;
	const pageStateSummary = recoveredUrl || title ? " and current page state" : plannedUrl ? " and planned page URL" : "";
	const retrySummary = stepProgress.retryStep ? ` Retry step ${stepProgress.retryStep.index} is the first incomplete step.` : "";
	return { artifacts, currentPage: url || title ? { source: currentPageSource, title, url } : undefined, liveUrlRecovered: recoveredUrl !== undefined, openedButPostOpenTimedOut: stepProgress.openedButPostOpenTimedOut, retryStep: stepProgress.retryStep, steps: stepProgress.steps.length > 0 ? stepProgress.steps : undefined, summary: `Timed out before upstream returned final results; recovered ${completedSteps}/${rawSteps.length} planned step state${rawSteps.length === 1 ? "" : "s"} and ${foundArtifacts}/${artifacts.length} declared artifact path${artifacts.length === 1 ? "" : "s"}${pageStateSummary}.${retrySummary}` };
}

function redactSensitivePathSegmentsForDiagnostic(path: string): string {
	return path.split(/([/\\]+)/).map((segment) => segment === "/" || segment === "\\" || /^[/\\]+$/.test(segment) ? segment : redactSensitiveText(segment) !== segment || /(?:secret|token|password|passwd|credential|auth|api[-_]?key|bearer)/i.test(segment) ? "[REDACTED]" : segment).join("");
}

function sanitizeCurrentPageUrlForTimeoutDiagnostic(url: string): string {
	try {
		const parsedUrl = new URL(url);
		parsedUrl.pathname = parsedUrl.pathname.split("/").map((segment) => redactSensitivePathSegmentsForDiagnostic(segment)).join("/");
		for (const [key, value] of parsedUrl.searchParams.entries()) {
			if (redactSensitiveText(key) !== key || redactSensitiveText(value) !== value || /(?:secret|token|password|passwd|credential|auth|api[-_]?key|bearer)/i.test(`${key} ${value}`)) parsedUrl.searchParams.set(key, "[REDACTED]");
		}
		if (parsedUrl.hash) parsedUrl.hash = redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(parsedUrl.hash));
		return redactSensitiveText(parsedUrl.toString());
	} catch {
		return redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(url));
	}
}

export function formatTimeoutPartialProgressText(progress: TimeoutPartialProgress): string {
	const lines = [`Timeout partial progress: ${progress.summary}`];
	const currentPageTitle = progress.currentPage?.title ? redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(progress.currentPage.title)) : undefined;
	const currentPageUrl = progress.currentPage?.url ? sanitizeCurrentPageUrlForTimeoutDiagnostic(progress.currentPage.url) : undefined;
	if (currentPageTitle || currentPageUrl) lines.push(`Current page: ${[currentPageTitle, currentPageUrl].filter(Boolean).join(" — ")}`);
	if (progress.steps && progress.steps.length > 0) {
		const shownSteps = progress.steps.slice(0, 6);
		lines.push("Planned steps:");
		for (const step of shownSteps) {
			const commandText = redactSensitivePathSegmentsForDiagnostic(redactInvocationArgs(step.args).join(" "));
			const generatedFrom = step.generatedFrom ? `, generated from ${step.generatedFrom}` : "";
			lines.push(`- Step ${step.index} [${step.status}${generatedFrom}]: ${commandText}${step.reason ? ` — ${redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(step.reason))}` : ""}`);
		}
		if (progress.steps.length > shownSteps.length) lines.push(`- ... ${progress.steps.length - shownSteps.length} more step${progress.steps.length - shownSteps.length === 1 ? "" : "s"} omitted`);
	}
	if (progress.retryStep?.retry?.args) {
		lines.push(`Retry failed step: ${JSON.stringify({ args: redactInvocationArgs(progress.retryStep.retry.args) })}`);
	}
	for (const artifact of progress.artifacts) lines.push(`Artifact from step ${artifact.stepIndex}: ${redactSensitivePathSegmentsForDiagnostic(artifact.path)} (${artifact.exists ? `exists${typeof artifact.sizeBytes === "number" ? `, ${artifact.sizeBytes} bytes` : ""}` : "missing"})`);
	return lines.join("\n");
}
