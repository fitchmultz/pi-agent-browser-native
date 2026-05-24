/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage extension-owned browser session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest in this package, or explicitly via `pi --no-extensions -e .` during local checkout development.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import { constants as fsConstants } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { access, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	highlightCode,
	isToolCallEventType,
	keyHint,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	discoverElectronApps,
	ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS,
	ELECTRON_DISCOVERY_MAX_RESULTS,
	type ElectronDiscoveryResult,
} from "./lib/electron/discovery.js";
import {
	cleanupElectronLaunchResources,
	inspectElectronLaunchStatus,
	type ElectronCleanupResult,
	type ElectronLaunchStatus,
} from "./lib/electron/cleanup.js";
import {
	launchElectronApp,
	type ElectronCdpTarget,
	type ElectronLaunchFailure,
	type ElectronLaunchRecord,
	type ElectronLaunchSuccess,
} from "./lib/electron/launch.js";
import {
	PROJECT_RULE_PROMPT,
	buildToolPromptGuidelines,
} from "./lib/playbook.js";
import { SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS, runAgentBrowserProcess } from "./lib/process.js";
import {
	buildAgentBrowserNextActions,
	buildAgentBrowserResultCategoryDetails,
	buildToolPresentation,
	getAgentBrowserErrorText,
	parseAgentBrowserEnvelope,
	type AgentBrowserBatchResult,
	type AgentBrowserEnvelope,
	type AgentBrowserNextAction,
	type AgentBrowserPageChangeSummary,
} from "./lib/results.js";
import {
	SessionPageState,
	buildNoActivePageRefSnapshotInvalidation,
	commandExplicitlyTargetsAboutBlank,
	deriveSessionTabTarget,
	extractLatestRefSnapshotStateFromBatchResults,
	extractRefSnapshotFromData,
	extractSessionTabTargetFromBatchResults,
	extractSessionTabTargetFromCommandData,
	isAboutBlankSessionTabTarget,
	isAboutBlankUrl,
	isNoActivePageSnapshotFailure,
	normalizeComparableUrl,
	normalizeSessionTabTarget,
	targetsMatch,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
	type SessionTabTarget,
} from "./lib/session-page-state.js";
import {
	buildExecutionPlan,
	buildPromptPolicy,
	chooseOpenResultTabCorrection,
	createEphemeralSessionSeed,
	createFreshSessionName,
	createImplicitSessionName,
	extractCommandTokens,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	getLatestUserPrompt,
	hasLaunchScopedTabCorrectionFlag,
	hasUsableBraveApiKey,
	extractExplicitSessionName,
	redactInvocationArgs,
	redactSensitiveText,
	redactSensitiveValue,
	restoreManagedSessionStateFromBranch,
	resolveManagedSessionState,
	shouldAppendBrowserSystemPrompt,
	validateToolArgs,
	type CommandInfo,
	type CompatibilityWorkaround,
	type OpenResultTabCorrection,
} from "./lib/runtime.js";
import {
	cleanupSecureTempArtifacts,
	type PersistentSessionArtifactEviction,
	type PersistentSessionArtifactStore,
	writePersistentSessionArtifactFile,
	writeSecureTempFile,
} from "./lib/temp.js";
import {
	AGENT_BROWSER_PARAMS,
	analyzeNetworkSourceLookupResults,
	analyzeQaPresetResults,
	analyzeSourceLookupResults,
	compileAgentBrowserElectron,
	compileAgentBrowserJob,
	compileAgentBrowserNetworkSourceLookup,
	compileAgentBrowserQaPreset,
	compileAgentBrowserSemanticAction,
	compileAgentBrowserSourceLookup,
	getCompiledSemanticActionCommandIndex,
	getCompiledSemanticActionSessionPrefix,
	isCompiledSemanticActionFindCommand,
	redactNetworkSourceLookupAnalysis,
	redactNetworkSourceLookupSurface,
	type AgentBrowserNetworkSourceLookupAnalysis,
	type AgentBrowserQaPresetAnalysis,
	type AgentBrowserSourceLookupAnalysis,
	type AgentBrowserSourceLookupElectronContext,
	type CompiledAgentBrowserElectron,
	type CompiledAgentBrowserJob,
	type CompiledAgentBrowserNetworkSourceLookup,
	type CompiledAgentBrowserQaPreset,
	type CompiledAgentBrowserSemanticAction,
	type CompiledAgentBrowserSourceLookup,
} from "./lib/input-modes.js";
import { runAgentBrowserTool, type BrowserRunState } from "./lib/orchestration/browser-run.js";
import { buildValidationFailureResult, resolveAgentBrowserInput } from "./lib/orchestration/input-plan.js";
import type { SessionArtifactManifest } from "./lib/results/contracts.js";
import {
	buildEvictedSessionArtifactEntries,
	formatSessionArtifactRetentionSummary,
	isSessionArtifactManifest,
	mergeSessionArtifactManifest,
} from "./lib/results/artifact-manifest.js";
import {
	buildRichInputRecoveryDiagnostic,
	buildRichInputRecoveryNextActions,
	buildVisibleRefFallbackDiagnosticFromSnapshot,
	buildVisibleRefFallbackNextActions,
	formatRichInputRecoveryText,
	formatVisibleRefFallbackText,
	getVisibleRefFallbackTarget,
	resolveVisibleRefActionFromSnapshot,
	sanitizeVisibleRefFallbackDiagnostic,
	type RichInputRecoveryDiagnostic,
	type VisibleRefFallbackDiagnostic,
} from "./lib/results/selector-recovery.js";
import {
	AgentBrowserNextActionCollector,
	alignPageChangeSummaryNextActionIds,
	appendUniqueAgentBrowserNextActions,
	isStandaloneSnapshotNextAction,
	withOptionalSessionArgs,
} from "./lib/results/next-actions.js";
import {
	buildConnectedSessionNextActions,
	buildNoActivePageNextActions,
	buildSessionAwareStaleRefNextActions,
	buildSessionTabRecoveryNextActions,
} from "./lib/results/recovery-next-actions.js";

const DEFAULT_SESSION_MODE = "auto" as const;
const DIRECT_AGENT_BROWSER_BASH_BYPASS_ENV = "PI_AGENT_BROWSER_ALLOW_DIRECT_BASH";
const PACKAGE_NAME = "pi-agent-browser-native";

const ELECTRON_PROFILE_ISOLATION_NOTE = "Profile note: electron.launch starts an isolated temporary profile; it does not reuse the app's normal signed-in profile or attach to an already-running authenticated app.";
const ELECTRON_EXISTING_AUTH_GUIDANCE = "For already-authenticated desktop app content, do not stop here: if host tools are allowed and the app is not running, launch the normal app with --remote-debugging-port=<port>, verify the port, then run agent_browser connect <port>; if it is already running without a debug port, ask before relaunching it.";
const ELECTRON_PROFILE_ISOLATION_DETAILS = {
	attachesToAlreadyRunningApp: false,
	existingAuthenticatedAppGuidance: ELECTRON_EXISTING_AUTH_GUIDANCE,
	hostDebugLaunchExample: "macOS: open -a <App Name> --args --remote-debugging-port=9222 --remote-allow-origins='*'; then agent_browser connect 9222 with sessionMode=fresh",
	isolatedLaunch: true,
	note: ELECTRON_PROFILE_ISOLATION_NOTE,
	reusesExistingSignedInProfile: false,
} as const;
const ELECTRON_PROBE_MAX_TABS = 6;
const ELECTRON_PROBE_MAX_REF_IDS = 20;
const ELECTRON_PROBE_MAX_SNAPSHOT_LINES = 12;
const ELECTRON_PROBE_MAX_SNAPSHOT_CHARS = 1_600;
const ELECTRON_POST_COMMAND_STATUS_SETTLE_MS = 250;
const ELECTRON_FILL_VERIFICATION_TIMEOUT_MS = 2_000;

interface ScrollPositionSnapshot {
	containerCount: number;
	containers: Array<{ id: string; scrollLeft: number; scrollTop: number }>;
	innerHeight: number;
	innerWidth: number;
	scrollHeight: number;
	scrollWidth: number;
	scrollX: number;
	scrollY: number;
}

interface ScrollNoopDiagnostic {
	after: ScrollPositionSnapshot;
	before: ScrollPositionSnapshot;
	message: string;
	reason: "no-observed-scroll-position-change";
	recommendations: string[];
}

interface ComboboxFocusDiagnostic {
	activeElement: {
		expanded?: string;
		hasPopup?: string;
		name?: string;
		role?: string;
		tagName?: string;
	};
	message: string;
	reason: "focused-combobox-without-visible-options";
	recommendations: string[];
	visibleListboxCount: number;
	visibleOptionCount: number;
}

interface RecordingDependencyWarning {
	command: "record start" | "record restart";
	dependency: "ffmpeg";
	message: string;
	reason: "ffmpeg-missing-for-recording";
	recommendations: string[];
}



const SEMANTIC_ACTION_CANDIDATE_ACTION_IDS = new Set([
	"try-button-name-candidate",
	"try-link-name-candidate",
]);




interface SemanticActionVisibleRefResolution {
	args: string[];
	snapshot: SessionRefSnapshot;
}


const TUI_COLLAPSED_OUTPUT_MAX_LINES = 10;
const TUI_INVOCATION_PREVIEW_MAX_CHARS = 120;
const ANSI_CONTROL_SEQUENCE_PATTERN = /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|P[^\x1B]*(?:\x1B\\)|_[^\x1B]*(?:\x1B\\)|\^[^\x1B]*(?:\x1B\\)|[@-Z\\-_])/g;
const UNSAFE_DISPLAY_CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

function sanitizeDisplayText(text: string): string {
	return text
		.replace(ANSI_CONTROL_SEQUENCE_PATTERN, "")
		.replace(/\r/g, "")
		.replace(UNSAFE_DISPLAY_CONTROL_PATTERN, "�");
}

function replaceTabsForDisplay(text: string): string {
	return text.replaceAll("\t", "    ");
}

function trimTrailingBlankLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim().length === 0) {
		end -= 1;
	}
	return lines.slice(0, end);
}

function isJsonDocumentText(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
		return false;
	}
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

function getPrimaryTextContent(result: AgentToolResult<unknown>): string {
	const textContent = result.content.find((item) => item.type === "text");
	return textContent?.type === "text" ? textContent.text : "";
}

function colorizeToolOutputLines(text: string, theme: Theme, isError: boolean): string[] {
	const normalizedLines = trimTrailingBlankLines(replaceTabsForDisplay(sanitizeDisplayText(text)).split("\n"));
	const normalizedText = normalizedLines.join("\n");
	if (normalizedText.length === 0) {
		return [];
	}
	if (isJsonDocumentText(normalizedText)) {
		return highlightCode(normalizedText, "json");
	}
	return normalizedLines.map((line) => {
		if (line.length === 0) {
			return "";
		}
		return isError ? theme.fg("error", line) : theme.fg("toolOutput", line);
	});
}

function formatExpandHint(theme: Theme): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return `${theme.fg("dim", "ctrl+o")} ${theme.fg("muted", "to expand")}`;
	}
}

function formatVisualTruncationNotice(remainingLines: number, totalLines: number, theme: Theme): string {
	return `${theme.fg("muted", `... (${remainingLines} more lines, ${totalLines} total, `)}${formatExpandHint(theme)}${theme.fg("muted", ")")}`;
}

function formatAgentBrowserRenderCall(args: unknown, theme: Theme): string {
	const input = isRecord(args) ? args : {};
	const semanticAction = compileAgentBrowserSemanticAction(input.semanticAction);
	const job = compileAgentBrowserJob(input.job);
	const qa = compileAgentBrowserQaPreset(input.qa);
	const sourceLookup = compileAgentBrowserSourceLookup(input.sourceLookup);
	const networkSourceLookup = compileAgentBrowserNetworkSourceLookup(input.networkSourceLookup);
	const electron = compileAgentBrowserElectron(input.electron);
	const generatedBatch = networkSourceLookup.compiled ?? sourceLookup.compiled ?? job.compiled ?? qa.compiled;
	const rawArgs = Array.isArray(input.args)
		? input.args.filter((value): value is string => typeof value === "string")
		: electron.compiled
			? ["electron", electron.compiled.action]
			: (semanticAction.compiled?.args ?? generatedBatch?.args ?? []);
	const redactedArgs = redactInvocationArgs(rawArgs);
	const invocation = sanitizeDisplayText(redactedArgs.join(" ")).replace(/\s+/g, " ").trim();
	const invocationPreview =
		invocation.length > TUI_INVOCATION_PREVIEW_MAX_CHARS
			? `${invocation.slice(0, TUI_INVOCATION_PREVIEW_MAX_CHARS - 3)}...`
			: invocation;
	let text = theme.fg("toolTitle", theme.bold("agent_browser"));
	if (invocationPreview.length > 0) {
		text += ` ${theme.fg("accent", invocationPreview)}`;
	}
	if (input.sessionMode === "fresh") {
		text += theme.fg("dim", " sessionMode=fresh");
	}
	if (typeof input.stdin === "string") {
		text += theme.fg("dim", " + stdin");
	}
	return text;
}

function formatAgentBrowserRenderResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	isError: boolean,
): string {
	if (options.isPartial) {
		return theme.fg("warning", "Running agent-browser...");
	}

	const outputText = getPrimaryTextContent(result);
	const outputLines = colorizeToolOutputLines(outputText, theme, isError);
	if (outputLines.length === 0) {
		const details = isRecord(result.details) ? result.details : undefined;
		const rawSummary = typeof details?.summary === "string" ? details.summary : isError ? "agent-browser failed" : "Done";
		const sanitizedSummary = sanitizeDisplayText(rawSummary).trim();
		const summary = sanitizedSummary.length > 0 ? sanitizedSummary : isError ? "agent-browser failed" : "Done";
		return isError ? theme.fg("error", summary) : theme.fg("success", summary);
	}

	return `\n${outputLines.join("\n")}`;
}

function formatModelVisibleFailureCategoryNotice(details: unknown): string | undefined {
	if (!isRecord(details) || details.resultCategory !== "failure") return undefined;
	const failureCategory = typeof details.failureCategory === "string" && details.failureCategory.length > 0
		? details.failureCategory
		: undefined;
	return `Result category: failure${failureCategory ? `; failureCategory: ${failureCategory}` : ""}; Pi tool isError: true.`;
}

type AgentBrowserToolContent = AgentToolResult<unknown>["content"];
type AgentBrowserToolContentItem = AgentBrowserToolContent[number];

type AgentBrowserToolResultPatch = {
	content?: AgentBrowserToolContent;
	isError?: boolean;
};

function agentBrowserToolResultRequestedJson(event: ToolResultEvent): boolean {
	const details = isRecord(event.details) ? event.details : undefined;
	const detailArgs = Array.isArray(details?.args) ? details.args : undefined;
	const inputArgs = isRecord(event.input) && Array.isArray(event.input.args) ? event.input.args : undefined;
	return detailArgs?.includes("--json") === true || inputArgs?.includes("--json") === true;
}

function agentBrowserToolResultHasParseableJsonContent(content: AgentBrowserToolContent): boolean {
	return content.some((item) => {
		if (item.type !== "text" || typeof item.text !== "string") return false;
		const text = item.text.trim();
		if (text.length === 0) return false;
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	});
}

function appendModelVisibleFailureCategoryNotice(content: AgentBrowserToolContent, notice: string): AgentBrowserToolContent | undefined {
	const noticeContent: AgentBrowserToolContentItem = { type: "text", text: notice };
	const textIndex = content.findIndex((item) => item.type === "text" && typeof item.text === "string");
	if (textIndex === -1) return [noticeContent, ...content];
	const textItem = content[textIndex];
	if (textItem.type !== "text" || typeof textItem.text !== "string" || textItem.text.includes(notice)) return undefined;
	return content.map((item, index) => index === textIndex
		? { ...item, text: `${textItem.text}\n\n${notice}` }
		: item);
}

function buildAgentBrowserToolResultPatch(event: ToolResultEvent): AgentBrowserToolResultPatch | undefined {
	if (event.toolName !== "agent_browser") return undefined;
	const preservesParseableJson = agentBrowserToolResultRequestedJson(event) && agentBrowserToolResultHasParseableJsonContent(event.content);
	const notice = preservesParseableJson ? undefined : formatModelVisibleFailureCategoryNotice(event.details);
	const content = notice ? appendModelVisibleFailureCategoryNotice(event.content, notice) : undefined;
	const shouldMarkError = isRecord(event.details) && event.details.resultCategory === "failure" && event.isError !== true;
	if (!shouldMarkError && !content) return undefined;
	return {
		...(content ? { content } : {}),
		...(shouldMarkError ? { isError: true } : {}),
	};
}

class AgentBrowserResultComponent {
	private expanded = false;
	private theme: Theme | undefined;
	private readonly text = new Text("", 0, 0);

	setState(value: string, expanded: boolean, theme: Theme): void {
		this.text.setText(value);
		this.expanded = expanded;
		this.theme = theme;
	}

	render(width: number): string[] {
		const lines = this.text.render(width);
		if (this.expanded || lines.length <= TUI_COLLAPSED_OUTPUT_MAX_LINES) {
			return lines;
		}
		const theme = this.theme;
		if (!theme) {
			return lines.slice(0, TUI_COLLAPSED_OUTPUT_MAX_LINES);
		}
		const hiddenLineCount = lines.length - TUI_COLLAPSED_OUTPUT_MAX_LINES;
		return [
			...lines.slice(0, TUI_COLLAPSED_OUTPUT_MAX_LINES),
			formatVisualTruncationNotice(hiddenLineCount, lines.length, theme),
		];
	}

	invalidate(): void {
		this.text.invalidate();
	}
}


const DIRECT_AGENT_BROWSER_EXECUTABLE_PATTERN = /^(?:[.~]|\.\.?|\/)?(?:[^\s;&|]+\/)?agent-browser$/;
const HARMLESS_AGENT_BROWSER_INSPECTION_PATTERN = /^\s*(?:command\s+-v|which|type\s+-P)\s+agent-browser\s*$/;

type ShellQuoteState = 'double' | 'single' | undefined;

function isShellAssignmentToken(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function stripOuterQuotes(token: string): string {
	if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
		return token.slice(1, -1);
	}
	return token;
}

function segmentLaunchesAgentBrowser(tokens: string[]): boolean {
	let index = 0;
	while (index < tokens.length && isShellAssignmentToken(tokens[index])) {
		index += 1;
	}
	if (index >= tokens.length) {
		return false;
	}

	let executableToken = tokens[index];
	if (executableToken === 'env') {
		index += 1;
		while (index < tokens.length && isShellAssignmentToken(tokens[index])) {
			index += 1;
		}
		executableToken = tokens[index] ?? '';
	}
	if (executableToken === 'npx' || executableToken === 'bunx') {
		index += 1;
		while (index < tokens.length && tokens[index].startsWith('-')) {
			index += 1;
		}
		executableToken = tokens[index] ?? '';
	}
	if (executableToken === 'pnpm' || executableToken === 'yarn') {
		index += 1;
		if (tokens[index] !== 'dlx') {
			return false;
		}
		index += 1;
		while (index < tokens.length && tokens[index].startsWith('-')) {
			index += 1;
		}
		executableToken = tokens[index] ?? '';
	}
	return DIRECT_AGENT_BROWSER_EXECUTABLE_PATTERN.test(executableToken);
}

// Best-effort detection for common direct launches only. This is an ergonomics guard,
// not a general-purpose bash parser or security boundary.
function looksLikeDirectAgentBrowserBash(command: string): boolean {
	let currentToken = '';
	let quoteState: ShellQuoteState;
	let awaitingHeredocDelimiter: { stripTabs: boolean } | undefined;
	let pendingHeredoc: { delimiter: string; stripTabs: boolean } | undefined;
	let pendingHeredocLine = '';
	let segmentTokens: string[] = [];

	const acceptToken = (token: string) => {
		if (token.length === 0) {
			return;
		}
		if (awaitingHeredocDelimiter) {
			pendingHeredoc = {
				delimiter: stripOuterQuotes(token),
				stripTabs: awaitingHeredocDelimiter.stripTabs,
			};
			awaitingHeredocDelimiter = undefined;
			return;
		}
		segmentTokens.push(token);
	};
	const flushToken = () => {
		acceptToken(currentToken);
		currentToken = '';
	};
	const flushSegment = () => {
		const launchesAgentBrowser = segmentLaunchesAgentBrowser(segmentTokens);
		segmentTokens = [];
		return launchesAgentBrowser;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (pendingHeredoc) {
			if (char === '\n') {
				const candidate = pendingHeredoc.stripTabs ? pendingHeredocLine.replace(/^\t+/, '') : pendingHeredocLine;
				if (candidate === pendingHeredoc.delimiter) {
					pendingHeredoc = undefined;
				}
				pendingHeredocLine = '';
				continue;
			}
			pendingHeredocLine += char;
			continue;
		}

		if (quoteState === 'single') {
			currentToken += char;
			if (char === "'") {
				quoteState = undefined;
			}
			continue;
		}
		if (quoteState === 'double') {
			currentToken += char;
			if (char === '\\' && index + 1 < command.length) {
				currentToken += command[index + 1];
				index += 1;
				continue;
			}
			if (char === '"') {
				quoteState = undefined;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			currentToken += char;
			quoteState = char === "'" ? 'single' : 'double';
			continue;
		}
		if (char === '\\' && index + 1 < command.length) {
			currentToken += char;
			currentToken += command[index + 1];
			index += 1;
			continue;
		}
		if (char === '\n') {
			flushToken();
			if (flushSegment()) {
				return true;
			}
			continue;
		}
		if (/\s/.test(char)) {
			flushToken();
			continue;
		}
		const threeCharOperator = command.slice(index, index + 3);
		if (threeCharOperator === '<<-') {
			flushToken();
			awaitingHeredocDelimiter = { stripTabs: true };
			index += 2;
			continue;
		}
		const twoCharOperator = command.slice(index, index + 2);
		if (twoCharOperator === '<<') {
			flushToken();
			awaitingHeredocDelimiter = { stripTabs: false };
			index += 1;
			continue;
		}
		if (twoCharOperator === '&&' || twoCharOperator === '||') {
			flushToken();
			if (flushSegment()) {
				return true;
			}
			index += 1;
			continue;
		}
		if (char === '|' || char === ';' || char === '&') {
			flushToken();
			if (flushSegment()) {
				return true;
			}
			continue;
		}
		currentToken += char;
	}

	flushToken();
	return flushSegment();
}

function isHarmlessAgentBrowserInspectionCommand(command: string): boolean {
	return HARMLESS_AGENT_BROWSER_INSPECTION_PATTERN.test(command);
}

function isTruthyEnvValue(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

async function isPackageDevelopmentCwd(cwd: string): Promise<boolean> {
	try {
		const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { name?: unknown };
		return packageJson.name === PACKAGE_NAME;
	} catch {
		return false;
	}
}

async function isDirectAgentBrowserBashAllowed(cwd: string): Promise<boolean> {
	return isTruthyEnvValue(process.env[DIRECT_AGENT_BROWSER_BASH_BYPASS_ENV]) || await isPackageDevelopmentCwd(cwd);
}

const NAVIGATION_SUMMARY_COMMANDS = new Set(["back", "click", "dblclick", "forward", "reload"]);
const NAVIGATION_SUMMARY_EVAL = `({ title: document.title, url: location.href })`;
// These commands can expose URLs for inspected resources (request URLs, cookie/storage scope, or log sources),
// but they do not navigate the active tab and must not poison page-scoped ref guards.
const READ_ONLY_DIAGNOSTIC_SESSION_TARGET_COMMANDS = new Set(["console", "cookies", "errors", "network", "storage"]);

interface NavigationSummary {
	title?: string;
	url?: string;
}

interface OverlayBlockerCandidate {
	args: string[];
	name?: string;
	reason: string;
	ref: string;
	role?: string;
}

interface OverlayBlockerDiagnostic {
	candidates: OverlayBlockerCandidate[];
	snapshot: SessionRefSnapshot;
	summary: string;
}

interface SelectorTextVisibilityDiagnostic {
	firstMatchVisible?: boolean;
	firstVisibleTextPreview?: string;
	matchCount: number;
	selector: string;
	summary: string;
	visibleCount: number;
}

interface ElectronBroadGetTextScopeDiagnostic {
	electronContext: {
		launchId?: string;
		sessionName?: string;
		url?: string;
	};
	selector: string;
	summary: string;
}

interface QaAttachedTarget {
	sessionName: string;
	title?: string;
	url?: string;
}

interface TimeoutArtifactEvidence {
	absolutePath: string;
	exists: boolean;
	path: string;
	sizeBytes?: number;
	stepIndex: number;
}

interface TimeoutPartialProgress {
	artifacts: TimeoutArtifactEvidence[];
	currentPage?: {
		title?: string;
		url?: string;
	};
	steps?: Array<{ args: string[]; index: number }>;
	summary: string;
}

interface EvalStdinHint {
	reason: string;
	suggestion: string;
}

interface ArtifactCleanupGuidance {
	explicitArtifactPaths: string[];
	note: string;
	owner: "host-file-tools";
	summary: string;
}

interface ManagedSessionOutcome {
	activeAfter: boolean;
	activeBefore: boolean;
	attemptedSessionName?: string;
	currentSessionName: string;
	previousSessionName: string;
	replacedSessionName?: string;
	sessionMode: "auto" | "fresh";
	status: "abandoned" | "closed" | "created" | "preserved" | "replaced" | "unchanged";
	succeeded: boolean;
	summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const SCREENSHOT_VALUE_FLAGS = new Set(["--screenshot-dir", "--screenshot-format", "--screenshot-quality"]);
const SCREENSHOT_IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);

interface ScreenshotPathRequest {
	absolutePath: string;
	path: string;
}

interface PreparedAgentBrowserArgs {
	args: string[];
	batchScreenshotPathRequests?: Array<ScreenshotPathRequest | undefined>;
	screenshotPathRequest?: ScreenshotPathRequest;
	stdin?: string;
}

interface ScreenshotArtifactRequest extends ScreenshotPathRequest {
	status?: "missing" | "repaired-from-temp" | "saved" | "upstream-temp-only";
	tempPath?: string;
}

type TraceOwner = "profiler" | "trace";

function isImagePathToken(token: string): boolean {
	const extension = extname(token).toLowerCase();
	return SCREENSHOT_IMAGE_EXTENSIONS.has(extension);
}

function getScreenshotPathTokenIndex(commandTokens: string[]): number | undefined {
	if (commandTokens[0] !== "screenshot") {
		return undefined;
	}

	const positionalIndices: number[] = [];
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--") {
			for (let positionalIndex = index + 1; positionalIndex < commandTokens.length; positionalIndex += 1) {
				positionalIndices.push(positionalIndex);
			}
			break;
		}
		if (token.startsWith("-")) {
			const normalizedToken = token.split("=", 1)[0] ?? token;
			if (SCREENSHOT_VALUE_FLAGS.has(normalizedToken) && !token.includes("=")) {
				index += 1;
			}
			continue;
		}
		positionalIndices.push(index);
	}

	if (positionalIndices.length === 0) {
		return undefined;
	}
	const candidateIndex = positionalIndices[positionalIndices.length - 1];
	const candidate = commandTokens[candidateIndex];
	if (positionalIndices.length >= 2 || isImagePathToken(candidate) || isAbsolute(candidate) || candidate.startsWith("./") || candidate.startsWith("../")) {
		return candidateIndex;
	}
	return undefined;
}

async function normalizeScreenshotPathInTokens(commandTokens: string[], cwd: string): Promise<{
	request?: ScreenshotPathRequest;
	tokens: string[];
}> {
	const screenshotPathTokenIndex = getScreenshotPathTokenIndex(commandTokens);
	if (screenshotPathTokenIndex === undefined) {
		return { tokens: commandTokens };
	}

	const requestedPath = commandTokens[screenshotPathTokenIndex];
	const absolutePath = resolve(cwd, requestedPath);
	await mkdir(dirname(absolutePath), { recursive: true });

	const tokens = [...commandTokens];
	tokens[screenshotPathTokenIndex] = absolutePath;
	const terminatorIndex = tokens.indexOf("--");
	if (terminatorIndex >= 0) {
		tokens.splice(terminatorIndex, 1);
	}

	return {
		request: {
			absolutePath,
			path: requestedPath,
		},
		tokens,
	};
}

async function prepareBatchScreenshotPaths(args: string[], stdin: string | undefined, cwd: string): Promise<PreparedAgentBrowserArgs | undefined> {
	const commandTokens = extractCommandTokens(args);
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return undefined;
	}
	let steps: unknown;
	try {
		steps = JSON.parse(stdin);
	} catch {
		return undefined;
	}
	if (!Array.isArray(steps)) {
		return undefined;
	}

	let changed = false;
	const batchScreenshotPathRequests: Array<ScreenshotPathRequest | undefined> = [];
	const preparedSteps = await Promise.all(steps.map(async (step, index) => {
		if (!Array.isArray(step) || !step.every((item) => typeof item === "string") || step[0] !== "screenshot") {
			return step;
		}
		const normalized = await normalizeScreenshotPathInTokens(step, cwd);
		batchScreenshotPathRequests[index] = normalized.request;
		if (normalized.request) {
			changed = true;
		}
		return normalized.tokens;
	}));

	return changed
		? {
				args,
				batchScreenshotPathRequests,
				stdin: JSON.stringify(preparedSteps),
		  }
		: undefined;
}

function parseMillisecondsToken(token: string | undefined): number | undefined {
	if (token === undefined || !/^\d+$/.test(token)) {
		return undefined;
	}
	const parsed = Number(token);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function findWaitTimeoutMs(commandTokens: string[]): { timeoutMs: number; source: string } | undefined {
	if (commandTokens[0] !== "wait") {
		return undefined;
	}
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--timeout") {
			const timeoutMs = parseMillisecondsToken(commandTokens[index + 1]);
			return timeoutMs === undefined ? undefined : { source: "wait --timeout", timeoutMs };
		}
		if (token.startsWith("--timeout=")) {
			const timeoutMs = parseMillisecondsToken(token.slice("--timeout=".length));
			return timeoutMs === undefined ? undefined : { source: "wait --timeout", timeoutMs };
		}
		if (!token.startsWith("-")) {
			const timeoutMs = parseMillisecondsToken(token);
			if (timeoutMs !== undefined) {
				return { source: "wait", timeoutMs };
			}
		}
	}
	return undefined;
}

function buildIpcUnsafeWaitError(source: string, timeoutMs: number, batchStep?: number): string {
	const location = batchStep === undefined ? source : `batch step ${batchStep + 1} (${source})`;
	return `${location} requests ${timeoutMs}ms, but upstream agent-browser CLI calls must stay under its 30s IPC read timeout. Use ${SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS}ms or less per wait, split long waits into multiple tool calls, or use a page-specific shorter condition.`;
}



async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function repairScreenshotData(options: {
	cwd: string;
	data: Record<string, unknown>;
	request: ScreenshotPathRequest;
}): Promise<{ data: Record<string, unknown>; request: ScreenshotArtifactRequest }> {
	const { cwd, data, request } = options;
	const reportedPath = typeof data.path === "string" ? data.path : undefined;
	const reportedAbsolutePath = reportedPath ? resolve(cwd, reportedPath) : undefined;
	let status: ScreenshotArtifactRequest["status"] = await pathExists(request.absolutePath) ? "saved" : "missing";
	let tempPath: string | undefined;

	if (reportedAbsolutePath && reportedAbsolutePath !== request.absolutePath) {
		tempPath = reportedAbsolutePath;
		if (status === "missing" && await pathExists(reportedAbsolutePath)) {
			await mkdir(dirname(request.absolutePath), { recursive: true });
			await copyFile(reportedAbsolutePath, request.absolutePath);
			status = "repaired-from-temp";
		}
	}

	return {
		data: {
			...data,
			path: request.absolutePath,
		},
		request: {
			...request,
			status,
			tempPath,
		},
	};
}




function getBatchAnnotateValidationError(args: string[], stdin: string | undefined): string | undefined {
	const commandTokens = extractCommandTokens(args);
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return undefined;
	}
	let steps: unknown;
	try {
		steps = JSON.parse(stdin);
	} catch {
		return undefined;
	}
	if (!Array.isArray(steps)) {
		return undefined;
	}
	const badStepIndex = steps.findIndex((step) => Array.isArray(step) && step[0] === "screenshot" && step.includes("--annotate"));
	if (badStepIndex < 0) {
		return undefined;
	}
	return [
		`Unsupported batch screenshot annotation in step ${badStepIndex + 1}: put --annotate in top-level args, not inside the batch step.`,
		`Use: { "args": ["--annotate", "batch"], "stdin": "[[\\"screenshot\\",\\"/path/to/image.png\\"]]" }`,
	].join("\n");
}

function getTraceOwner(command: string | undefined): TraceOwner | undefined {
	return command === "trace" || command === "profiler" ? command : undefined;
}




function extractStringResultField(data: unknown, fieldName: "result" | "title" | "url" | "value"): string | undefined {
	if (typeof data === "string") {
		if (fieldName === "value") return data;
		const text = data.trim();
		return text.length > 0 ? text : undefined;
	}
	if (!isRecord(data) || typeof data[fieldName] !== "string") {
		return undefined;
	}
	if (fieldName === "value") return data[fieldName];
	const text = data[fieldName].trim();
	return text.length > 0 ? text : undefined;
}

function extractNavigationSummaryFromData(data: unknown): NavigationSummary | undefined {
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	const title = extractStringResultField(result, "title");
	const url = extractStringResultField(result, "url");
	return title || url ? { title, url } : undefined;
}

const SESSION_TAB_PINNING_EXCLUDED_COMMANDS = new Set(["close", "goto", "navigate", "open", "session", "tab"]);
const SESSION_TAB_POST_COMMAND_CORRECTION_EXCLUDED_COMMANDS = new Set(["batch", "close", "session", "tab"]);

type PinnedBatchUnwrapMode = "single-command" | "user-batch";

type AgentBrowserToolResult = AgentToolResult<unknown> & { isError?: boolean };

type BatchCommandStep = [string, ...string[]];

interface PinnedBatchPlan {
	includeNavigationSummary: boolean;
	steps: BatchCommandStep[];
	unwrapMode: PinnedBatchUnwrapMode;
}

interface StaleRefPreflight {
	message: string;
	refIds: string[];
	snapshot?: SessionRefSnapshot;
	snapshotInvalidation?: SessionRefSnapshotInvalidation;
}

interface AboutBlankSessionMismatch {
	activeUrl: "about:blank";
	recoveryApplied: boolean;
	recoveryHint: string;
	targetTitle?: string;
	targetUrl: string;
}



function extractBatchResultCommand(item: Record<string, unknown>): string[] {
	return Array.isArray(item.command) ? item.command.filter((token): token is string => typeof token === "string") : [];
}

function restoreArtifactManifestFromBranch(branch: unknown[]): SessionArtifactManifest | undefined {
	let restoredManifest: SessionArtifactManifest | undefined;
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		if (isSessionArtifactManifest(details?.artifactManifest)) {
			restoredManifest = details.artifactManifest;
		}
	}
	return restoredManifest;
}

function isPasswordStdinAuthSave(options: { command?: string; commandTokens: string[] }): boolean {
	return options.command === "auth" && options.commandTokens[1] === "save" && options.commandTokens.includes("--password-stdin");
}


function redactExactSensitiveText(text: string, sensitiveValues: string[]): string {
	let redacted = text;
	for (const value of sensitiveValues) {
		redacted = redacted.split(value).join("[REDACTED]");
	}
	return redacted;
}

function redactExactSensitiveValue(value: unknown, sensitiveValues: string[]): unknown {
	if (sensitiveValues.length === 0) {
		return value;
	}
	if (typeof value === "string") {
		return redactExactSensitiveText(value, sensitiveValues);
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactExactSensitiveValue(item, sensitiveValues));
	}
	if (!isRecord(value)) {
		return value;
	}
	return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, redactExactSensitiveValue(entryValue, sensitiveValues)]));
}

function redactToolDetails(details: Record<string, unknown>, sensitiveValues: string[]): Record<string, unknown> {
	return redactSensitiveValue(redactExactSensitiveValue(details, sensitiveValues)) as Record<string, unknown>;
}

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

interface ElectronHandoffSummary {
	error?: string;
	handoff: "connect" | "snapshot" | "tabs";
	refSnapshot?: SessionRefSnapshot;
	snapshot?: unknown;
	snapshotRetryCount?: number;
	tabs?: unknown;
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

function restoreElectronLaunchRecordsFromBranch(branch: unknown[]): Map<string, ElectronLaunchRecord> {
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

function getActiveElectronRecords(records: Map<string, ElectronLaunchRecord>): ElectronLaunchRecord[] {
	return [...records.values()].filter((record) => record.cleanupState === "active" || record.cleanupState === "dead" || record.cleanupState === "partial" || record.cleanupState === "failed");
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

function formatElectronTargetLines(targets: ElectronCdpTarget[], limit = 8): string[] {
	const shownTargets = targets.slice(0, limit);
	const lines = shownTargets.map((target) => {
		const label = [target.type, target.title].filter(Boolean).join(" ") || target.id || "target";
		return `- ${label}${target.url ? ` — ${target.url}` : ""}`;
	});
	if (targets.length > shownTargets.length) lines.push(`- ... ${targets.length - shownTargets.length} more target(s) omitted`);
	return lines;
}

function extractTargetsFromStatus(statuses: ElectronLaunchStatus[]): ElectronCdpTarget[] {
	return statuses.flatMap((status) => status.targets);
}

interface ElectronManagedSessionTarget {
	error?: string;
	sessionName: string;
	title?: string;
	url?: string;
}

type ElectronSessionMismatchReason =
	| "launch-session-not-current"
	| "managed-session-about-blank-while-launch-target-live"
	| "managed-session-target-not-in-launch-status";

interface ElectronSessionMismatch {
	launchId: string;
	liveTarget?: ElectronCdpTarget;
	managedSession: ElectronManagedSessionTarget;
	nextActionIds: string[];
	reason: ElectronSessionMismatchReason;
	sessionName?: string;
	statusTargets: ElectronCdpTarget[];
	summary: string;
}

type ElectronPostCommandHealthReason = "about-blank-no-live-target" | "debug-port-dead" | "process-dead";

interface ElectronPostCommandHealthDiagnostic {
	appName: string;
	command?: string;
	launchId: string;
	nextActionIds: string[];
	reason: ElectronPostCommandHealthReason;
	sessionName?: string;
	status: ElectronLaunchStatus;
	summary: string;
	target?: SessionTabTarget;
}

interface FillVerificationDiagnostic {
	actual?: string;
	expected: string;
	nextActionIds: string[];
	selector: string;
	status: "mismatch";
	summary: string;
}

interface ElectronRefFreshnessDiagnostic {
	command?: string;
	launchId: string;
	nextActionIds: string[];
	sessionName?: string;
	summary: string;
}

interface ElectronProbeContext {
	launchId?: string;
	mode: "current-managed-session" | "launchId";
	note?: string;
	sessionName: string;
}

function isLiveElectronRendererTarget(target: ElectronCdpTarget): boolean {
	const normalizedUrl = normalizeComparableUrl(target.url);
	if (!normalizedUrl || normalizedUrl === "about:blank" || normalizedUrl.startsWith("devtools://")) return false;
	return target.type === undefined || target.type === "page" || target.type === "webview";
}

function getLiveElectronRendererTargets(targets: ElectronCdpTarget[]): ElectronCdpTarget[] {
	return targets.filter(isLiveElectronRendererTarget);
}

function electronTargetLabel(target: ElectronCdpTarget | undefined): string {
	if (!target) return "unknown target";
	return [target.title, target.url, target.id].find((value) => typeof value === "string" && value.trim().length > 0) ?? "unknown target";
}

function findElectronLaunchRecordForSession(sessionName: string | undefined, records: Map<string, ElectronLaunchRecord>): ElectronLaunchRecord | undefined {
	if (!sessionName) return undefined;
	return getActiveElectronRecords(records).find((record) => record.sessionName === sessionName);
}

function findUnambiguousActiveElectronLaunchRecord(records: Map<string, ElectronLaunchRecord>): ElectronLaunchRecord | undefined {
	const activeRecords = getActiveElectronRecords(records);
	return activeRecords.length === 1 ? activeRecords[0] : undefined;
}

function buildElectronReattachNextAction(record: ElectronLaunchRecord, liveTarget?: ElectronCdpTarget): AgentBrowserNextAction {
	const endpoint = liveTarget?.webSocketDebuggerUrl ?? record.webSocketDebuggerUrl ?? String(record.port);
	return {
		id: "reattach-electron-launch",
		params: { args: ["connect", endpoint], sessionMode: "fresh" },
		reason: "Attach a fresh managed session to the same wrapper-tracked Electron debug endpoint when the current session no longer matches the live renderer.",
		safety: "Creates a new managed browser session; it does not mutate the Electron app. Keep the launchId for later status and cleanup.",
		tool: "agent_browser",
	};
}

function buildElectronMismatchNextActions(record: ElectronLaunchRecord, liveTarget?: ElectronCdpTarget): AgentBrowserNextAction[] {
	const baseActions = buildAgentBrowserNextActions({
		electron: { launchId: record.launchId, sessionName: record.sessionName, status: record.cleanupState },
		resultCategory: "success",
		successCategory: "completed",
	}) ?? [];
	const reattachAction = buildElectronReattachNextAction(record, liveTarget);
	const actions: AgentBrowserNextAction[] = [];
	for (const action of baseActions) {
		actions.push(action);
		if (action.id === "probe-electron-launch") actions.push(reattachAction);
	}
	if (!actions.some((action) => action.id === reattachAction.id)) actions.push(reattachAction);
	return actions;
}

function buildElectronSessionMismatch(options: {
	managedSession: ElectronManagedSessionTarget;
	record: ElectronLaunchRecord;
	statusTargets: ElectronCdpTarget[];
}): ElectronSessionMismatch | undefined {
	const liveTargets = getLiveElectronRendererTargets(options.statusTargets);
	if (liveTargets.length === 0) return undefined;
	const managedUrl = normalizeComparableUrl(options.managedSession.url);
	const matchingLiveTarget = managedUrl
		? liveTargets.find((target) => normalizeComparableUrl(target.url) === managedUrl)
		: undefined;
	if (matchingLiveTarget) return undefined;

	const liveTarget = liveTargets[0];
	let reason: ElectronSessionMismatchReason | undefined;
	if (isAboutBlankUrl(options.managedSession.url)) {
		reason = "managed-session-about-blank-while-launch-target-live";
	} else if (options.record.sessionName && options.record.sessionName !== options.managedSession.sessionName) {
		reason = "launch-session-not-current";
	} else if (managedUrl) {
		reason = "managed-session-target-not-in-launch-status";
	}
	if (!reason) return undefined;

	const managedDescription = options.managedSession.url ?? options.managedSession.title ?? options.managedSession.sessionName;
	const liveDescription = electronTargetLabel(liveTarget);
	const summary = reason === "launch-session-not-current"
		? `Electron session mismatch: current managed session ${options.managedSession.sessionName} is not the wrapper launch session ${options.record.sessionName ?? "unknown"}, while launch ${options.record.launchId} still has live target ${liveDescription}.`
		: `Electron session mismatch: managed session ${options.managedSession.sessionName} is on ${managedDescription}, but launch ${options.record.launchId} still has live target ${liveDescription}.`;
	const nextActions = buildElectronMismatchNextActions(options.record, liveTarget);
	return {
		launchId: options.record.launchId,
		liveTarget,
		managedSession: options.managedSession,
		nextActionIds: nextActions.map((action) => action.id),
		reason,
		sessionName: options.record.sessionName,
		statusTargets: options.statusTargets,
		summary,
	};
}

async function collectManagedSessionCommandData(options: {
	args: string[];
	cwd: string;
	sessionName: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{ data?: unknown; error?: string }> {
	try {
		return { data: await runSessionCommandData(options) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function collectElectronManagedSessionTarget(options: {
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<ElectronManagedSessionTarget | undefined> {
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

function formatElectronSessionMismatchText(mismatch: ElectronSessionMismatch): string {
	return `${mismatch.summary}\nNext: run electron.status/electron.probe with launchId ${mismatch.launchId}, reattach with the reattach-electron-launch nextAction if needed, or cleanup when finished.`;
}

const ELECTRON_POST_COMMAND_HEALTH_COMMANDS = new Set([
	"back",
	"check",
	"click",
	"dblclick",
	"fill",
	"find",
	"forward",
	"keyboard",
	"mouse",
	"press",
	"reload",
	"select",
	"type",
	"uncheck",
]);

function shouldInspectElectronPostCommandHealth(command: string | undefined): boolean {
	return command !== undefined && ELECTRON_POST_COMMAND_HEALTH_COMMANDS.has(command);
}

function buildElectronLifecycleNextActions(record: ElectronLaunchRecord): AgentBrowserNextAction[] {
	return buildAgentBrowserNextActions({
		electron: { launchId: record.launchId, sessionName: record.sessionName, status: record.cleanupState },
		resultCategory: "success",
		successCategory: "completed",
	}) ?? [];
}



function buildElectronIdentifiers(record: ElectronLaunchRecord): { appName: string; launchId: string; sessionName?: string } {
	return { appName: record.appName, launchId: record.launchId, sessionName: record.sessionName };
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

function formatElectronLaunchFailureDiagnostics(failure: ElectronLaunchFailure | undefined): string | undefined {
	const diagnostics = failure?.diagnostics;
	if (!diagnostics) return undefined;
	const lines = ["Electron launch diagnostics:"];
	if (diagnostics.pid !== undefined) {
		const pidState = diagnostics.pidAlive === undefined ? "state unknown" : diagnostics.pidAlive ? "alive before cleanup" : "not alive before cleanup";
		lines.push(`- PID: ${diagnostics.pid} (${pidState}).`);
	}
	if (diagnostics.exitCode !== undefined || diagnostics.exitSignal !== undefined) {
		const exitParts = [diagnostics.exitCode !== undefined ? `code ${diagnostics.exitCode}` : undefined, diagnostics.exitSignal ? `signal ${diagnostics.exitSignal}` : undefined].filter(Boolean).join(", ");
		lines.push(`- Process exit: ${exitParts || "not observed before cleanup"}.`);
	}
	if (diagnostics.userDataDir) lines.push(`- Wrapper profile: ${diagnostics.userDataDir}`);
	if (diagnostics.devToolsActivePort) {
		const activePort = diagnostics.devToolsActivePort;
		const state = activePort.port
			? `found port ${activePort.port}`
			: activePort.found
				? `found but invalid${activePort.error ? ` (${activePort.error})` : ""}`
				: `missing${activePort.error ? ` (${activePort.error})` : ""}`;
		lines.push(`- DevToolsActivePort: ${state} at ${activePort.path}.`);
	}
	if (diagnostics.cdpVersionReached === false) lines.push("- CDP /json/version: did not return a valid payload before timeout.");
	if (diagnostics.timeoutMs !== undefined || diagnostics.elapsedMs !== undefined) {
		lines.push(`- Timing: ${diagnostics.elapsedMs ?? "unknown"}ms elapsed${diagnostics.timeoutMs !== undefined ? ` of ${diagnostics.timeoutMs}ms timeout` : ""}.`);
	}
	if (diagnostics.outputCaptured === false) lines.push("- App stdout/stderr: not captured by this wrapper launch path.");
	lines.push("Retry guidance: increase electron.timeoutMs, try targetType:'any', pass an explicit appPath/executablePath, quit any already-running singleton instance, then retry launch.");
	return lines.join("\n");
}

function buildElectronHostFailureResult(options: {
	compiledElectron: CompiledAgentBrowserElectron;
	errorText: string;
	failureCategory?: "cleanup-failed" | "policy-blocked" | "timeout" | "upstream-error" | "validation-error";
	launchFailure?: ElectronLaunchFailure;
	managedSessionOutcome?: ManagedSessionOutcome;
	status?: string;
}): AgentBrowserToolResult {
	const text = [
		options.errorText,
		formatElectronLaunchFailureDiagnostics(options.launchFailure),
		options.launchFailure?.cleanupError ? `Electron launch cleanup warning: ${options.launchFailure.cleanupError}` : undefined,
	].filter((item): item is string => item !== undefined && item.length > 0).join("\n");
	const details = {
		args: [] as string[],
		compiledElectron: options.compiledElectron,
		electron: {
			action: options.compiledElectron.action,
			error: options.errorText,
			failure: options.launchFailure,
			status: options.status ?? "failed",
		},
		managedSessionOutcome: options.managedSessionOutcome,
		...buildAgentBrowserResultCategoryDetails({ args: [], errorText: options.errorText, failureCategory: options.failureCategory, succeeded: false, timedOut: options.failureCategory === "timeout" }),
		summary: options.errorText,
	};
	return { content: [{ type: "text", text: redactSensitiveText(text) }], details: redactToolDetails(details, []), isError: true };
}


function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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



function supportsPinnedStdinCommand(options: { command?: string; commandTokens: string[]; stdin?: string }): boolean {
	if (options.command === "batch") {
		return options.stdin !== undefined;
	}
	if (options.stdin === undefined) {
		return true;
	}
	if (options.command === "eval") {
		return options.commandTokens.includes("--stdin");
	}
	return false;
}


function validateUserBatchStep(
	step: unknown,
	index: number,
):
	| { ok: true; step: BatchCommandStep }
	| { ok: false; error: string } {
	if (!Array.isArray(step)) {
		return {
			ok: false,
			error: `agent_browser batch stdin step ${index} must be a non-empty array of string command tokens.`,
		};
	}
	if (step.length === 0) {
		return {
			ok: false,
			error: `agent_browser batch stdin step ${index} must not be empty.`,
		};
	}
	const invalidTokenIndex = step.findIndex((token) => typeof token !== "string");
	if (invalidTokenIndex !== -1) {
		return {
			ok: false,
			error: `agent_browser batch stdin step ${index} token ${invalidTokenIndex} must be a string.`,
		};
	}
	return { ok: true, step: step as BatchCommandStep };
}

function parseUserBatchStdin(stdin: string | undefined): { error?: string; steps?: BatchCommandStep[] } {
	if (stdin === undefined) {
		return { steps: [] };
	}
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (!Array.isArray(parsed)) {
			return { error: "agent_browser batch stdin must be a JSON array of command steps." };
		}
		const steps: BatchCommandStep[] = [];
		for (const [index, rawStep] of parsed.entries()) {
			const validated = validateUserBatchStep(rawStep, index);
			if (!validated.ok) {
				return { error: validated.error };
			}
			steps.push(validated.step);
		}
		return { steps };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `agent_browser batch stdin could not be parsed as JSON: ${message}` };
	}
}

const REF_INVALIDATING_BATCH_COMMANDS = new Set([
	"back",
	"check",
	"click",
	"dblclick",
	"drag",
	"forward",
	"goto",
	"keyboard",
	"mouse",
	"navigate",
	"open",
	"press",
	"reload",
	"select",
	"type",
	"uncheck",
	"upload",
]);

const REF_GUARDED_COMMANDS = new Set([
	"check",
	"click",
	"dblclick",
	"download",
	"drag",
	"fill",
	"focus",
	"hover",
	"keyboard",
	"mouse",
	"press",
	"scrollintoview",
	"select",
	"type",
	"uncheck",
	"upload",
]);


function collectRefsFromTokens(tokens: string[]): string[] {
	return tokens.filter((token) => /^@e\d+\b/.test(token)).map((token) => token.slice(1));
}

function getGuardedRefUsage(commandTokens: string[], stdin?: string, options: { includeRefsAfterBatchSnapshot?: boolean } = {}): string[] {
	const collectFromStep = (step: string[]) => REF_GUARDED_COMMANDS.has(step[0] ?? "") ? collectRefsFromTokens(step) : [];
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return collectFromStep(commandTokens);
	}
	const parsed = parseUserBatchStdin(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return collectFromStep(commandTokens);
	}
	const refsBeforeInBatchSnapshot: string[] = [];
	for (const step of parsed.steps) {
		if (!options.includeRefsAfterBatchSnapshot && (step[0] ?? "") === "snapshot") break;
		refsBeforeInBatchSnapshot.push(...collectFromStep(step));
	}
	return refsBeforeInBatchSnapshot;
}

function getBatchRefInvalidationMessage(commandTokens: string[], stdin?: string): string | undefined {
	if (commandTokens[0] !== "batch" || stdin === undefined) return undefined;
	const parsed = parseUserBatchStdin(stdin);
	if (parsed.error || parsed.steps === undefined) return undefined;
	let priorStepInvalidatesRefs = false;
	for (const step of parsed.steps) {
		if ((step[0] ?? "") === "snapshot") {
			priorStepInvalidatesRefs = false;
		}
		const refIds = collectRefsFromTokens(step);
		if (refIds.length > 0 && REF_GUARDED_COMMANDS.has(step[0] ?? "") && priorStepInvalidatesRefs) {
			return `Batch step ${step[0]} uses page-scoped ref ${refIds.map((refId) => `@${refId}`).join(", ")} after an earlier batch step can navigate or mutate the page. Split the batch, run snapshot -i after the page-changing step, then retry with current refs.`;
		}
		if (REF_INVALIDATING_BATCH_COMMANDS.has(step[0] ?? "")) {
			priorStepInvalidatesRefs = true;
		}
	}
	return undefined;
}




function selectSessionTargetTab(options: {
	tabs: Array<{ active?: boolean; index?: number; label?: string; tabId?: string; title?: string; url?: string }>;
	target: SessionTabTarget;
}): OpenResultTabCorrection | undefined {
	return chooseOpenResultTabCorrection({
		tabs: options.tabs,
		targetTitle: options.target.title,
		targetUrl: options.target.url,
	});
}


async function runSessionCommandData(options: {
	args: string[];
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
	stdin?: string;
	timeoutMs?: number;
}): Promise<unknown | undefined> {
	const { args, cwd, sessionName, signal, stdin, timeoutMs } = options;
	if (!sessionName) return undefined;

	const processResult = await runAgentBrowserProcess({
		args: ["--json", "--session", sessionName, ...args],
		cwd,
		signal,
		stdin,
		timeoutMs,
	});
	try {
		if (processResult.aborted || processResult.spawnError || processResult.exitCode !== 0) {
			return undefined;
		}
		const parsed = await parseAgentBrowserEnvelope({
			stdout: processResult.stdout,
			stdoutPath: processResult.stdoutSpillPath,
		});
		if (parsed.parseError || parsed.envelope?.success === false) {
			return undefined;
		}
		return parsed.envelope?.data;
	} finally {
		if (processResult.stdoutSpillPath) {
			await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
		}
	}
}

function getTopLevelFillInvocation(commandTokens: string[]): { expected: string; selector: string } | undefined {
	if (commandTokens[0] !== "fill" || commandTokens.length < 3) return undefined;
	const selector = commandTokens[1];
	const expected = commandTokens.slice(2).join(" ");
	if (!selector || expected.length === 0) return undefined;
	return { expected, selector };
}

function buildFillVerificationNextActions(diagnostic: FillVerificationDiagnostic, sessionName: string | undefined): AgentBrowserNextAction[] {
	return [
		{
			id: "inspect-after-fill-verification",
			params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) },
			reason: "Refresh the UI after a fill that reported success but did not appear to update the input value.",
			safety: "Read-only snapshot; use current refs before retrying.",
			tool: "agent_browser",
		},
		{
			id: "verify-filled-value",
			params: { args: withOptionalSessionArgs(sessionName, ["get", "value", diagnostic.selector]) },
			reason: "Check the target input value directly before submitting or creating files.",
			safety: "Read-only value check; selector may still be stale if the Electron UI rerendered.",
			tool: "agent_browser",
		},
	];
}

function extractFillVerificationValue(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (!isRecord(data)) return undefined;
	if (typeof data.value === "string") return data.value;
	if (typeof data.result === "string") return data.result;
	return undefined;
}



function buildElectronRefFreshnessNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	return [{
		id: "refresh-electron-refs-after-rerender",
		params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) },
		reason: "Electron UIs often rerender without changing URL; refresh refs before using old @e handles again.",
		safety: "Read-only snapshot; avoids stale same-URL refs after quick-pick, modal, theme, or editor rerenders.",
		tool: "agent_browser",
	}];
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
	return {
		containerCount: typeof result.containerCount === "number" ? result.containerCount : containers.length,
		containers,
		innerHeight,
		innerWidth,
		scrollHeight,
		scrollWidth,
		scrollX,
		scrollY,
	};
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
    return {
      id: String(index) + ":" + id + (role ? "[role=" + role + "]" : ""),
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      area: element.clientWidth * element.clientHeight,
    };
  };
  const containers = Array.from(document.querySelectorAll("body *"))
    .filter((element) => element instanceof HTMLElement && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1))
    .map(describe)
    .sort((left, right) => right.area - left.area)
    .slice(0, 10)
    .map(({ area, ...entry }) => entry);
  return { ...viewport, containerCount: containers.length, containers };
})()`;


function sameScrollPositionSnapshot(left: ScrollPositionSnapshot, right: ScrollPositionSnapshot): boolean {
	if (
		left.scrollX !== right.scrollX ||
		left.scrollY !== right.scrollY ||
		left.scrollHeight !== right.scrollHeight ||
		left.scrollWidth !== right.scrollWidth ||
		left.containers.length !== right.containers.length
	) {
		return false;
	}
	return left.containers.every((container, index) => {
		const other = right.containers[index];
		return other?.id === container.id && other.scrollTop === container.scrollTop && other.scrollLeft === container.scrollLeft;
	});
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
		recommendations: [
			"Run snapshot -i to inspect whether options appeared under a different role or portal.",
			"Try ArrowDown or Enter to open the option list before selecting, or use select/visible option refs when available.",
		],
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




function getRecordStartLikeCommand(command: string | undefined, commandTokens: string[]): RecordingDependencyWarning["command"] | undefined {
	if (command !== "record") return undefined;
	const subcommand = commandTokens[1]?.toLowerCase();
	if (subcommand === "start") return "record start";
	if (subcommand === "restart") return "record restart";
	return undefined;
}

async function executableExistsOnPath(command: string): Promise<boolean> {
	const pathValue = process.env.PATH ?? "";
	const extensions = process.platform === "win32"
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
		: [""];
	for (const directory of pathValue.split(delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			try {
				const candidate = join(directory, `${command}${extension}`);
				await access(candidate, fsConstants.X_OK);
				if ((await stat(candidate)).isFile()) return true;
			} catch {
				// Try the next candidate.
			}
		}
	}
	return false;
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
	const hasOverlayContext = Object.values(refs).some((entry) => {
		if (!isRecord(entry)) return false;
		const role = typeof entry.role === "string" ? entry.role : "";
		return OVERLAY_CONTEXT_ROLES.has(role.toLowerCase());
	});
	if (!hasOverlayContext) return [];
	const candidates: OverlayBlockerCandidate[] = [];
	for (const [ref, entry] of Object.entries(refs)) {
		if (!/^e\d+$/.test(ref) || !isRecord(entry)) continue;
		const role = typeof entry.role === "string" ? entry.role : undefined;
		const name = typeof entry.name === "string" ? entry.name : undefined;
		if (!role || !OVERLAY_ACTION_ROLES.has(role.toLowerCase()) || !name || !OVERLAY_CLOSE_NAME_PATTERN.test(name)) continue;
		candidates.push({
			args: ["click", `@${ref}`],
			name,
			reason: `Visible ${role} ${JSON.stringify(name)} appears in a snapshot that also contains overlay/banner/dialog context.`,
			ref: `@${ref}`,
			role,
		});
		if (candidates.length >= OVERLAY_BLOCKER_CANDIDATE_LIMIT) break;
	}
	return candidates;
}



function buildVisibleTextProbeScript(selector: string): string {
	return `(() => {\n  const selector = ${JSON.stringify(selector)};\n  const isVisible = (element) => {\n    const style = window.getComputedStyle(element);\n    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;\n    return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);\n  };\n  let matches = [];\n  try {\n    matches = Array.from(document.querySelectorAll(selector));\n  } catch (error) {\n    return JSON.stringify({ selector, error: error instanceof Error ? error.message : String(error) });\n  }\n  const visible = matches.filter(isVisible);\n  const trim = (value) => typeof value === 'string' ? value.trim().replace(/\\s+/g, ' ').slice(0, 200) : undefined;\n  return JSON.stringify({\n    selector,\n    matchCount: matches.length,\n    visibleCount: visible.length,\n    firstMatchVisible: matches[0] ? isVisible(matches[0]) : undefined,\n    firstTextPreview: trim(matches[0]?.textContent),\n    firstVisibleTextPreview: trim(visible[0]?.textContent),\n  });\n})()`;
}

function parseSelectorTextVisibilityProbe(data: unknown, selector: string): Omit<SelectorTextVisibilityDiagnostic, "summary"> | undefined {
	const result = extractStringResultField(data, "result");
	if (!result) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(result);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.error === "string") return undefined;
	const matchCount = typeof parsed.matchCount === "number" ? parsed.matchCount : undefined;
	const visibleCount = typeof parsed.visibleCount === "number" ? parsed.visibleCount : undefined;
	if (matchCount === undefined || visibleCount === undefined) return undefined;
	return {
		firstMatchVisible: typeof parsed.firstMatchVisible === "boolean" ? parsed.firstMatchVisible : undefined,
		firstVisibleTextPreview: typeof parsed.firstVisibleTextPreview === "string" && parsed.firstVisibleTextPreview.length > 0 ? redactSensitiveText(parsed.firstVisibleTextPreview) : undefined,
		matchCount,
		selector,
		visibleCount,
	};
}

function selectorMayExposeSensitiveLiteral(selector: string): boolean {
	return redactSensitiveText(selector) !== selector || /\[[^\]]*[~|^$*]?=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+)\s*(?:[is]\s*)?\]/.test(selector);
}

async function collectSelectorTextVisibilityDiagnosticForSelector(options: {
	cwd: string;
	selector: string | undefined;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<SelectorTextVisibilityDiagnostic | undefined> {
	const { selector } = options;
	if (!selector || /^@e\d+$/.test(selector) || selectorMayExposeSensitiveLiteral(selector)) return undefined;
	const probe = await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: buildVisibleTextProbeScript(selector),
	});
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
		: options.commandInfo.command === "batch"
			? getBatchGetTextSelectors(options.data)
			: [];
}



function isElectronLikeRendererUrl(url: string | undefined): boolean {
	if (!url) return false;
	return /^(?:app|file|vscode-file|vscode|chrome-extension):/i.test(url);
}

function normalizeSelectorForScopeHeuristic(selector: string): string {
	return selector.trim().replace(/\s+/g, " ").toLowerCase();
}

function isBroadGetTextSelector(selector: string | undefined): selector is string {
	if (!selector || /^@e\d+$/.test(selector) || selectorMayExposeSensitiveLiteral(selector)) return false;
	const normalized = normalizeSelectorForScopeHeuristic(selector);
	return normalized === "body" ||
		normalized === "html" ||
		normalized === ":root" ||
		normalized === "*" ||
		normalized === "main" ||
		normalized === "div" ||
		normalized === "section" ||
		normalized === "article" ||
		/^\[role=(?:"application"|'application'|application)\]$/i.test(normalized);
}

function getElectronTextScopeContext(options: {
	currentTarget?: SessionTabTarget;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	priorTarget?: SessionTabTarget;
	sessionName?: string;
}): ElectronBroadGetTextScopeDiagnostic["electronContext"] | undefined {
	const record = findElectronLaunchRecordForSession(options.sessionName, options.electronLaunchRecords);
	const url = options.currentTarget?.url ?? options.priorTarget?.url;
	if (record) return { launchId: record.launchId, sessionName: record.sessionName ?? options.sessionName, url };
	if (isElectronLikeRendererUrl(url)) return { sessionName: options.sessionName, url };
	return undefined;
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








function getTimeoutProgressSteps(compiledJob: CompiledAgentBrowserJob | undefined, command: string | undefined, stdin: string | undefined): Array<{ args: string[]; index: number }> {
	if (compiledJob) return compiledJob.steps.map((step, index) => ({ args: step.args, index: index + 1 }));
	if (command !== "batch" || !stdin) return [];
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((step, index) => Array.isArray(step) && step.every((token) => typeof token === "string") ? [{ args: step as string[], index: index + 1 }] : []);
	} catch {
		return [];
	}
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

async function collectTimeoutArtifactEvidence(cwd: string, steps: Array<{ args: string[]; index: number }>): Promise<TimeoutArtifactEvidence[]> {
	const evidence: TimeoutArtifactEvidence[] = [];
	for (const step of steps) {
		const path = getTimeoutStepArtifactPath(step.args);
		if (!path) continue;
		const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
		try {
			const stats = await stat(absolutePath);
			evidence.push({ absolutePath, exists: true, path, sizeBytes: stats.size, stepIndex: step.index });
		} catch {
			evidence.push({ absolutePath, exists: false, path, stepIndex: step.index });
		}
	}
	return evidence;
}

function getPlannedCurrentPageUrl(steps: Array<{ args: string[]; index: number }>): string | undefined {
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const args = steps[index]?.args ?? [];
		if (args[0] === "open" || args[0] === "navigate" || args[0] === "pushstate") {
			return getLastPositionalToken(args);
		}
	}
	return undefined;
}


function redactSensitivePathSegmentsForDiagnostic(path: string): string {
	return path.split(/([/\\]+)/).map((segment) => {
		if (segment === "/" || segment === "\\" || /^[/\\]+$/.test(segment)) return segment;
		return redactSensitiveText(segment) !== segment || /(?:secret|token|password|passwd|credential|auth|api[-_]?key|bearer)/i.test(segment) ? "[REDACTED]" : segment;
	}).join("");
}

function sanitizeCurrentPageUrlForTimeoutDiagnostic(url: string): string {
	try {
		const parsedUrl = new URL(url);
		parsedUrl.pathname = parsedUrl.pathname.split("/").map((segment) => redactSensitivePathSegmentsForDiagnostic(segment)).join("/");
		for (const [key, value] of parsedUrl.searchParams.entries()) {
			if (redactSensitiveText(key) !== key || redactSensitiveText(value) !== value || /(?:secret|token|password|passwd|credential|auth|api[-_]?key|bearer)/i.test(`${key} ${value}`)) {
				parsedUrl.searchParams.set(key, "[REDACTED]");
			}
		}
		if (parsedUrl.hash) {
			parsedUrl.hash = redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(parsedUrl.hash));
		}
		return redactSensitiveText(parsedUrl.toString());
	} catch {
		return redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(url));
	}
}












// Serializes managed-session read/modify/write work so overlapping tool calls cannot promote stale state or close an in-use session.
class AsyncExecutionQueue {
	private tail: Promise<void> = Promise.resolve();

	run<T>(work: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});

		return (async () => {
			await previous;
			try {
				return await work();
			} finally {
				release();
			}
		})();
	}
}

async function closeManagedSession(options: { cwd: string; sessionName: string; timeoutMs: number }): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	let stdoutSpillPath: string | undefined;
	const closeArgs = ["--session", options.sessionName, "close"];
	try {
		const processResult = await runAgentBrowserProcess({
			args: closeArgs,
			cwd: options.cwd,
			signal: controller.signal,
		});
		stdoutSpillPath = processResult.stdoutSpillPath;
		return getAgentBrowserErrorText({
			aborted: processResult.aborted,
			command: "close",
			effectiveArgs: redactInvocationArgs(closeArgs),
			exitCode: processResult.exitCode,
			plainTextInspection: false,
			spawnError: processResult.spawnError,
			stderr: processResult.stderr,
			timedOut: processResult.timedOut,
			timeoutMs: processResult.timeoutMs,
		});
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		if (stdoutSpillPath) {
			await rm(stdoutSpillPath, { force: true }).catch(() => undefined);
		}
	}
}

function getInstalledDocsPaths(): { readmePath: string; commandReferencePath: string; toolContractPath: string } {
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	return {
		readmePath: join(packageRoot, "README.md"),
		commandReferencePath: join(packageRoot, "docs", "COMMAND_REFERENCE.md"),
		toolContractPath: join(packageRoot, "docs", "TOOL_CONTRACT.md"),
	};
}



async function handleElectronHostInput(options: {
	cleanupTrackedElectronLaunches: (records: ElectronLaunchRecord[], cwd: string, timeoutMs?: number) => Promise<ElectronCleanupResult[]>;
	compiledElectron?: CompiledAgentBrowserElectron;
	cwd: string;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	implicitSessionCloseTimeoutMs: number;
	managedSessionActive: boolean;
	managedSessionExecutionQueue: { run<T>(task: () => Promise<T>): Promise<T> };
	managedSessionName: string;
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	sessionPageState: SessionPageState;
	signal?: AbortSignal;
}): Promise<AgentBrowserToolResult | undefined> {
	const {
		cleanupTrackedElectronLaunches,
		compiledElectron,
		cwd,
		electronLaunchRecords,
		implicitSessionCloseTimeoutMs,
		managedSessionActive,
		managedSessionExecutionQueue,
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
		return managedSessionExecutionQueue.run(async () => {
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
		});
	}
	if (compiledElectron?.action === "probe") {
		return managedSessionExecutionQueue.run(async () => {
			const launchRecord = compiledElectron.launchId
				? electronLaunchRecords.get(compiledElectron.launchId)
				: findElectronLaunchRecordForSession(managedSessionName, electronLaunchRecords) ?? findUnambiguousActiveElectronLaunchRecord(electronLaunchRecords);
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
		});
	}
	if (compiledElectron?.action === "cleanup") {
		const selection = selectElectronRecords(compiledElectron, electronLaunchRecords);
		if (selection.error) return buildElectronHostFailureResult({ compiledElectron: redactedCompiledElectron ?? compiledElectron, errorText: selection.error, failureCategory: "validation-error" });
		const cleanupResults = await cleanupTrackedElectronLaunches(selection.records ?? [], cwd, compiledElectron.timeoutMs ?? implicitSessionCloseTimeoutMs);
		return buildElectronCleanupResult(redactedCompiledElectron ?? compiledElectron, cleanupResults);
	}
	return undefined;
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	const ephemeralSessionSeed = createEphemeralSessionSeed();
	const hasBraveApiKey = hasUsableBraveApiKey();
	const toolPromptGuidelines = buildToolPromptGuidelines({ includeBraveSearch: hasBraveApiKey, docs: getInstalledDocsPaths() });
	const implicitSessionIdleTimeoutMs = String(getImplicitSessionIdleTimeoutMs());
	const implicitSessionCloseTimeoutMs = getImplicitSessionCloseTimeoutMs();
	let managedSessionActive = false;
	let managedSessionBaseName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);
	let managedSessionName = managedSessionBaseName;
	let managedSessionCwd = process.cwd();
	let freshSessionOrdinal = 0;
	let sessionPageState = new SessionPageState();
	let traceOwners = new Map<string, TraceOwner>();
	let artifactManifest: SessionArtifactManifest | undefined;
	let electronLaunchRecords = new Map<string, ElectronLaunchRecord>();
	let electronChildProcesses = new Map<string, ChildProcess>();
	const managedSessionExecutionQueue = new AsyncExecutionQueue();

	const cleanupTrackedElectronLaunches = async (records: ElectronLaunchRecord[], cwd: string, timeoutMs = implicitSessionCloseTimeoutMs): Promise<ElectronCleanupResult[]> => {
		const results: ElectronCleanupResult[] = [];
		for (const record of records) {
			const managedSessionCloseError = record.sessionName
				? await closeManagedSession({ cwd, sessionName: record.sessionName, timeoutMs })
				: undefined;
			const cleanupResult = await cleanupElectronLaunchResources({
				child: electronChildProcesses.get(record.launchId),
				record,
				timeoutMs,
			});
			const result: ElectronCleanupResult = managedSessionCloseError
				? {
					...cleanupResult,
					partial: true,
					record: { ...cleanupResult.record, cleanupState: "partial" },
					remainingResources: [...new Set(["managed-session", ...cleanupResult.remainingResources])],
					steps: [{ error: managedSessionCloseError, resource: "managed-session", state: "failed" }, ...cleanupResult.steps],
					summary: `Electron cleanup for ${record.launchId} is partial; managed session close failed.`,
				}
				: cleanupResult;
			results.push(result);
			electronLaunchRecords.set(record.launchId, result.record);
			if (!result.partial) electronChildProcesses.delete(record.launchId);
		}
		return results;
	};

	pi.on("session_start", async (_event, ctx) => {
		managedSessionBaseName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
		const restoredState = restoreManagedSessionStateFromBranch(ctx.sessionManager.getBranch(), managedSessionBaseName);
		managedSessionActive = restoredState.active;
		managedSessionName = restoredState.sessionName;
		managedSessionCwd = ctx.cwd;
		freshSessionOrdinal = restoredState.freshSessionOrdinal;
		const branch = ctx.sessionManager.getBranch();
		sessionPageState = SessionPageState.fromBranch(branch);
		artifactManifest = restoreArtifactManifestFromBranch(branch);
		electronLaunchRecords = restoreElectronLaunchRecordsFromBranch(ctx.sessionManager.getBranch());
		electronChildProcesses = new Map<string, ChildProcess>();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		await managedSessionExecutionQueue.run(async () => {
			const activeElectronRecords = getActiveElectronRecords(electronLaunchRecords);
			if (activeElectronRecords.length > 0) {
				await cleanupTrackedElectronLaunches(activeElectronRecords, ctx?.cwd ?? managedSessionCwd);
			}
			if (event?.reason === "quit" && managedSessionActive) {
				await closeManagedSession({
					cwd: managedSessionCwd,
					sessionName: managedSessionName,
					timeoutMs: implicitSessionCloseTimeoutMs,
				});
			}
		});
		managedSessionActive = false;
		sessionPageState.reset();
		traceOwners = new Map<string, TraceOwner>();
		artifactManifest = undefined;
		electronLaunchRecords = new Map<string, ElectronLaunchRecord>();
		electronChildProcesses = new Map<string, ChildProcess>();
		await cleanupSecureTempArtifacts();
	});

	pi.on("before_agent_start", async (event) => {
		if (!shouldAppendBrowserSystemPrompt(event.prompt)) {
			return undefined;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PROJECT_RULE_PROMPT}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
		if (
			isToolCallEventType("bash", event) &&
			!promptPolicy.allowLegacyAgentBrowserBash &&
			looksLikeDirectAgentBrowserBash(event.input.command) &&
			!isHarmlessAgentBrowserInspectionCommand(event.input.command) &&
			!(await isDirectAgentBrowserBashAllowed(ctx.cwd))
		) {
			return {
				block: true,
				reason: "Use the native agent_browser tool instead of bash for agent-browser in this environment.",
			};
		}
	});

	pi.on("tool_result", async (event) => buildAgentBrowserToolResultPatch(event));

	pi.registerTool({
		name: "agent_browser",
		label: "Agent Browser",
		description:
			"Browse and interact with websites using agent-browser. Use this for web research, reading live docs, opening pages, taking snapshots or screenshots, clicking links, filling forms, extracting page content, and authenticated/profile-based browser work.",
		promptSnippet:
			"Browse websites, read live docs, click and fill pages, extract browser content, take screenshots, and automate real web workflows.",
		promptGuidelines: toolPromptGuidelines,
		parameters: AGENT_BROWSER_PARAMS,
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatAgentBrowserRenderCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const component = context.lastComponent instanceof AgentBrowserResultComponent
				? context.lastComponent
				: new AgentBrowserResultComponent();
			component.setState(formatAgentBrowserRenderResult(result, options, theme, context.isError), options.expanded, theme);
			return component;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolvedInput = resolveAgentBrowserInput({
				getBatchAnnotateValidationError,
				managedSessionActive,
				params,
			});
			if (resolvedInput.status === "invalid") {
				return buildValidationFailureResult(resolvedInput);
			}
			const { toolArgs } = resolvedInput;
			const compiledElectron = resolvedInput.kind === "electron" ? resolvedInput.compiledElectron : undefined;
			const redactedCompiledElectron = resolvedInput.kind === "electron" ? resolvedInput.redactedCompiledElectron : undefined;
			const electronHostResult = await handleElectronHostInput({
				cleanupTrackedElectronLaunches,
				compiledElectron,
				cwd: ctx.cwd,
				electronLaunchRecords,
				implicitSessionCloseTimeoutMs,
				managedSessionActive,
				managedSessionExecutionQueue,
				managedSessionName,
				redactedCompiledElectron,
				sessionPageState,
				signal,
			});
			if (electronHostResult) {
				return electronHostResult;
			}

			const sessionPageStateUpdate = sessionPageState.beginUpdate();
			const runBrowserCommand = async () => {
				const browserRunState: BrowserRunState = {
					artifactManifest,
					electronChildProcesses,
					electronLaunchRecords,
					ephemeralSessionSeed,
					freshSessionOrdinal,
					managedSessionActive,
					managedSessionBaseName,
					managedSessionCwd,
					managedSessionName,
					sessionPageState,
					traceOwners,
				};
				const result = await runAgentBrowserTool({
					ctx,
					cwd: ctx.cwd,
					electronPostCommandStatusSettleMs: ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
					electronProfileIsolationDetails: ELECTRON_PROFILE_ISOLATION_DETAILS,
					implicitSessionCloseTimeoutMs,
					implicitSessionIdleTimeoutMs,
					input: resolvedInput,
					onUpdate,
					params,
					sessionPageStateUpdate,
					signal,
					state: browserRunState,
				});
				artifactManifest = browserRunState.artifactManifest;
				freshSessionOrdinal = browserRunState.freshSessionOrdinal;
				managedSessionActive = browserRunState.managedSessionActive;
				managedSessionCwd = browserRunState.managedSessionCwd;
				managedSessionName = browserRunState.managedSessionName;
				return result;
			};

			return extractExplicitSessionName(toolArgs)
				? runBrowserCommand()
				: managedSessionExecutionQueue.run(runBrowserCommand);
		},
	});
}
