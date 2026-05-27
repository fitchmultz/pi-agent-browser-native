/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage extension-owned browser session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest in this package, or explicitly via `pi --no-extensions -e .` during local checkout development.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
	type ElectronLaunchRecord,
	type ElectronLaunchSuccess,
} from "./lib/electron/launch.js";
import {
	PROJECT_RULE_PROMPT,
	buildToolPromptGuidelines,
} from "./lib/playbook.js";
import {
	buildAgentBrowserNextActions,
	buildAgentBrowserResultCategoryDetails,
	buildToolPresentation,
	type AgentBrowserEnvelope,
	type AgentBrowserPageChangeSummary,
} from "./lib/results.js";
import {
	SessionPageState,
	extractRefSnapshotFromData,
	isAboutBlankUrl,
	normalizeSessionTabTarget,
	type SessionRefSnapshot,
	type SessionTabTarget,
} from "./lib/session-page-state.js";
import {
	buildExecutionPlan,
	createEphemeralSessionSeed,
	createFreshSessionName,
	createImplicitSessionName,
	extractCommandTokens,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	hasLaunchScopedTabCorrectionFlag,
	hasUsableBraveApiKey,
	extractExplicitSessionName,
	redactInvocationArgs,
	redactSensitiveText,
	restoreManagedSessionStateFromBranch,
	resolveManagedSessionState,
	validateToolArgs,
	type CompatibilityWorkaround,
} from "./lib/runtime.js";
import { buildPromptPolicy, getLatestUserPrompt, shouldAppendBrowserSystemPrompt } from "./lib/prompt-policy.js";
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
import { parseBatchStdinJsonArray } from "./lib/orchestration/batch-stdin.js";
import { collectElectronManagedSessionTarget } from "./lib/orchestration/browser-run/diagnostics.js";
import { buildElectronHostFailureResult, formatElectronTargetLines, redactToolDetails } from "./lib/orchestration/browser-run/final-result.js";
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
} from "./lib/orchestration/browser-run/session-state.js";
import type {
	AgentBrowserToolResult,
	ElectronManagedSessionTarget,
	ElectronSessionMismatch,
	TraceOwner,
} from "./lib/orchestration/browser-run/types.js";
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
	appendUniqueAgentBrowserNextActions,
	withOptionalSessionArgs,
} from "./lib/results/next-actions.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getBatchAnnotateValidationError(args: string[], stdin: string | undefined): string | undefined {
	const commandTokens = extractCommandTokens(args);
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return undefined;
	}
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return undefined;
	}
	const badStepIndex = parsed.steps.findIndex((step) => Array.isArray(step) && step[0] === "screenshot" && step.includes("--annotate"));
	if (badStepIndex < 0) {
		return undefined;
	}
	return [
		`Unsupported batch screenshot annotation in step ${badStepIndex + 1}: put --annotate in top-level args, not inside the batch step.`,
		`Use: { "args": ["--annotate", "batch"], "stdin": "[[\\"screenshot\\",\\"/path/to/image.png\\"]]" }`,
	].join("\n");
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

function findUnambiguousActiveElectronLaunchRecord(records: Map<string, ElectronLaunchRecord>): ElectronLaunchRecord | undefined {
	const activeRecords = getActiveElectronRecords(records);
	return activeRecords.length === 1 ? activeRecords[0] : undefined;
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
			"Browse and interact with websites using agent-browser. Use this for web research, reading live docs, opening pages, taking snapshots or screenshots, clicking links, filling forms, extracting page content, and authenticated/profile-based browser work. Input choice: default `args` for open → snapshot -i → click/fill @refs; `semanticAction` for stable role/text/label targets; `job` or `qa` for multi-step checks; `electron` only for desktop apps; experimental `sourceLookup` / `networkSourceLookup` for candidates only.",
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
			const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
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
					promptPolicy,
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
