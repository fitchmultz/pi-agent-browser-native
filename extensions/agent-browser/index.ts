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
	type ExtensionContext,
	type Theme,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	PROJECT_RULE_PROMPT,
	buildToolPromptGuidelines,
} from "./lib/playbook.js";
import {
	buildToolPresentation,
	type AgentBrowserEnvelope,
	type AgentBrowserPageChangeSummary,
} from "./lib/results.js";
import { SessionPageState } from "./lib/session-page-state.js";
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
	type CompiledAgentBrowserJob,
	type CompiledAgentBrowserNetworkSourceLookup,
	type CompiledAgentBrowserQaPreset,
	type CompiledAgentBrowserSemanticAction,
	type CompiledAgentBrowserSourceLookup,
} from "./lib/input-modes.js";
import { closeManagedSession, runAgentBrowserTool, type BrowserRunState, type TraceOwner } from "./lib/orchestration/browser-run.js";
import { getActiveElectronRecords } from "./lib/orchestration/browser-run/session-state.js";
import { parseBatchStdinJsonArray } from "./lib/orchestration/batch-stdin.js";
import {
	ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
	ELECTRON_PROFILE_ISOLATION_DETAILS,
	cleanupActiveElectronHostLaunches,
	handleElectronHostInput,
	restoreElectronLaunchRecordsFromBranch,
	type ElectronLaunchRecord,
} from "./lib/orchestration/electron-host/index.js";
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
import { withOptionalSessionArgs } from "./lib/results/next-actions.js";

const DEFAULT_SESSION_MODE = "auto" as const;
const DIRECT_AGENT_BROWSER_BASH_BYPASS_ENV = "PI_AGENT_BROWSER_ALLOW_DIRECT_BASH";
const PACKAGE_NAME = "pi-agent-browser-native";

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

type OwnedManagedSession = {
	cwd: string;
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

function trackOwnedManagedSession(sessions: Map<string, OwnedManagedSession>, sessionName: string | undefined, cwd: string): void {
	if (sessionName) sessions.set(sessionName, { cwd });
}

function untrackOwnedManagedSession(sessions: Map<string, OwnedManagedSession>, sessionName: string | undefined): void {
	if (sessionName) sessions.delete(sessionName);
}

function syncOwnedManagedSessionsFromResult(sessions: Map<string, OwnedManagedSession>, result: AgentToolResult<unknown>, cwd: string): void {
	const details = isRecord(result.details) ? result.details : undefined;
	const outcome = isRecord(details?.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
	if (!outcome) return;
	const succeeded = outcome.succeeded === true;
	const status = typeof outcome.status === "string" ? outcome.status : undefined;
	const currentSessionName = typeof outcome.currentSessionName === "string" ? outcome.currentSessionName : undefined;
	const attemptedSessionName = typeof outcome.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
	if (succeeded && outcome.activeAfter === true && (status === "created" || status === "replaced" || status === "unchanged")) {
		trackOwnedManagedSession(sessions, currentSessionName, cwd);
	}
	if (succeeded && status === "closed") {
		untrackOwnedManagedSession(sessions, attemptedSessionName ?? currentSessionName);
	}
}

function mergeActiveElectronLaunchRecords(target: Map<string, ElectronLaunchRecord>, source: Map<string, ElectronLaunchRecord>): void {
	for (const record of getActiveElectronRecords(source)) {
		target.set(record.launchId, record);
	}
}

function mergeElectronLaunchRecordMaps(...maps: Array<Map<string, ElectronLaunchRecord>>): Map<string, ElectronLaunchRecord> {
	const merged = new Map<string, ElectronLaunchRecord>();
	for (const map of maps) {
		for (const [launchId, record] of map) merged.set(launchId, record);
	}
	return merged;
}

function replaceWithActiveElectronLaunchRecords(target: Map<string, ElectronLaunchRecord>, source: Map<string, ElectronLaunchRecord>): void {
	target.clear();
	mergeActiveElectronLaunchRecords(target, source);
}

function syncElectronCleanupManagedSessions(sessions: Map<string, OwnedManagedSession>, cleanupResults: Awaited<ReturnType<typeof cleanupActiveElectronHostLaunches>>): void {
	for (const result of cleanupResults) {
		if (!result.partial) untrackOwnedManagedSession(sessions, result.record.sessionName);
	}
}

async function closeOwnedManagedSessions(sessions: Map<string, OwnedManagedSession>, timeoutMs: number): Promise<void> {
	for (const [sessionName, owner] of [...sessions]) {
		const error = await closeManagedSession({ cwd: owner.cwd, sessionName, timeoutMs });
		if (!error) sessions.delete(sessionName);
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

function getInstalledDocsPaths(): { readmePath: string; commandReferencePath: string; toolContractPath: string } {
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	return {
		readmePath: join(packageRoot, "README.md"),
		commandReferencePath: join(packageRoot, "docs", "COMMAND_REFERENCE.md"),
		toolContractPath: join(packageRoot, "docs", "TOOL_CONTRACT.md"),
	};
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
	let ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
	let electronChildProcesses = new Map<string, ChildProcess>();
	const ownedManagedSessions = new Map<string, OwnedManagedSession>();
	const managedSessionExecutionQueue = new AsyncExecutionQueue();

	const restoreBranchBackedState = (ctx: ExtensionContext, options: { resetRuntimeOwnership: boolean }): void => {
		managedSessionBaseName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
		const branch = ctx.sessionManager.getBranch();
		const restoredState = restoreManagedSessionStateFromBranch(branch, managedSessionBaseName);
		managedSessionActive = restoredState.active;
		managedSessionName = restoredState.sessionName;
		managedSessionCwd = ctx.cwd;
		freshSessionOrdinal = options.resetRuntimeOwnership
			? restoredState.freshSessionOrdinal
			: Math.max(freshSessionOrdinal, restoredState.freshSessionOrdinal);
		sessionPageState = SessionPageState.fromBranch(branch);
		traceOwners = new Map<string, TraceOwner>();
		artifactManifest = restoreArtifactManifestFromBranch(branch);
		electronLaunchRecords = restoreElectronLaunchRecordsFromBranch(branch);
		if (options.resetRuntimeOwnership) {
			ownedManagedSessions.clear();
			ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
		}
		if (restoredState.active) trackOwnedManagedSession(ownedManagedSessions, restoredState.sessionName, ctx.cwd);
		mergeActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronLaunchRecords);
	};

	pi.on("session_start", async (_event, ctx) => {
		restoreBranchBackedState(ctx, { resetRuntimeOwnership: true });
		electronChildProcesses = new Map<string, ChildProcess>();
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreBranchBackedState(ctx, { resetRuntimeOwnership: false });
	});

	pi.on("session_shutdown", async (event, ctx) => {
		await managedSessionExecutionQueue.run(async () => {
			const shutdownCwd = ctx?.cwd ?? managedSessionCwd;
			const electronCleanupResults = await cleanupActiveElectronHostLaunches({
				cwd: shutdownCwd,
				electronChildProcesses,
				electronLaunchRecords: ownedElectronLaunchRecords,
				timeoutMs: implicitSessionCloseTimeoutMs,
			});
			syncElectronCleanupManagedSessions(ownedManagedSessions, electronCleanupResults);
			if (event?.reason === "quit") {
				await closeOwnedManagedSessions(ownedManagedSessions, implicitSessionCloseTimeoutMs);
			}
		});
		managedSessionActive = false;
		sessionPageState.reset();
		traceOwners = new Map<string, TraceOwner>();
		artifactManifest = undefined;
		electronLaunchRecords = new Map<string, ElectronLaunchRecord>();
		ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
		electronChildProcesses = new Map<string, ChildProcess>();
		ownedManagedSessions.clear();
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
			const electronHostLaunchRecords = compiledElectron?.action === "cleanup"
				? mergeElectronLaunchRecordMaps(electronLaunchRecords, ownedElectronLaunchRecords)
				: electronLaunchRecords;
			const electronHostResult = await handleElectronHostInput({
				compiledElectron,
				cwd: ctx.cwd,
				electronChildProcesses,
				electronLaunchRecords: electronHostLaunchRecords,
				implicitSessionCloseTimeoutMs,
				managedSessionActive,
				managedSessionExecutionQueue,
				managedSessionName,
				redactedCompiledElectron,
				sessionPageState,
				signal,
			});
			if (electronHostResult) {
				if (compiledElectron?.action === "cleanup") {
					electronLaunchRecords = mergeElectronLaunchRecordMaps(electronLaunchRecords, electronHostLaunchRecords);
					replaceWithActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronHostLaunchRecords);
					const cleanupRecords = isRecord(electronHostResult.details)
						&& isRecord(electronHostResult.details.electron)
						&& isRecord(electronHostResult.details.electron.cleanup)
						&& Array.isArray(electronHostResult.details.electron.cleanup.results)
						? electronHostResult.details.electron.cleanup.results
						: [];
					for (const cleanupResult of cleanupRecords) {
						if (isRecord(cleanupResult) && cleanupResult.partial === false && isRecord(cleanupResult.record)) {
							const sessionName = typeof cleanupResult.record.sessionName === "string" ? cleanupResult.record.sessionName : undefined;
							untrackOwnedManagedSession(ownedManagedSessions, sessionName);
						}
					}
				}
				return electronHostResult;
			}

			const sessionPageStateUpdate = sessionPageState.beginUpdate();
			const runBrowserCommand = async () => {
				const browserRunState: BrowserRunState = {
					artifactManifest,
					closedManagedSessionNames: new Set<string>(),
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
				freshSessionOrdinal = Math.max(freshSessionOrdinal, browserRunState.freshSessionOrdinal);
				managedSessionActive = browserRunState.managedSessionActive;
				managedSessionCwd = browserRunState.managedSessionCwd;
				managedSessionName = browserRunState.managedSessionName;
				for (const closedSessionName of browserRunState.closedManagedSessionNames) {
					untrackOwnedManagedSession(ownedManagedSessions, closedSessionName);
				}
				syncOwnedManagedSessionsFromResult(ownedManagedSessions, result, browserRunState.managedSessionCwd);
				mergeActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronLaunchRecords);
				return result;
			};

			return extractExplicitSessionName(toolArgs)
				? runBrowserCommand()
				: managedSessionExecutionQueue.run(runBrowserCommand);
		},
	});
}
