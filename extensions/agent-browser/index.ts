/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage extension-owned browser session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest in this package, or explicitly via `pi --no-extensions -e .` during local checkout development.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	highlightCode,
	isToolCallEventType,
	keyHint,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

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
} from "./lib/results.js";
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
	type SessionArtifactManifest,
	buildEvictedSessionArtifactEntries,
	formatSessionArtifactRetentionSummary,
	isSessionArtifactManifest,
	mergeSessionArtifactManifest,
} from "./lib/results/shared.js";

const DEFAULT_SESSION_MODE = "auto" as const;
const DIRECT_AGENT_BROWSER_BASH_BYPASS_ENV = "PI_AGENT_BROWSER_ALLOW_DIRECT_BASH";
const PACKAGE_NAME = "pi-agent-browser-native";

const AGENT_BROWSER_SEMANTIC_ACTIONS = ["check", "click", "fill", "select", "uncheck"] as const;
const AGENT_BROWSER_SEMANTIC_LOCATORS = ["alt", "label", "placeholder", "role", "testid", "text", "title"] as const;

type AgentBrowserSemanticActionName = (typeof AGENT_BROWSER_SEMANTIC_ACTIONS)[number];
type AgentBrowserSemanticLocator = (typeof AGENT_BROWSER_SEMANTIC_LOCATORS)[number];

interface AgentBrowserSemanticActionInput {
	action: AgentBrowserSemanticActionName;
	locator: AgentBrowserSemanticLocator;
	value: string;
	text?: string;
	role?: string;
	name?: string;
}

interface CompiledAgentBrowserSemanticAction {
	action: AgentBrowserSemanticActionName;
	locator: AgentBrowserSemanticLocator;
	args: string[];
}

const AGENT_BROWSER_PARAMS = Type.Object({
	args: Type.Optional(
		Type.Array(Type.String({ description: "Exact agent-browser CLI arguments, excluding the binary name." }), {
			description: "Exact agent-browser CLI arguments, excluding the binary name and any shell operators. Required unless semanticAction is provided.",
			minItems: 1,
		}),
	),
	semanticAction: Type.Optional(
		Type.Object({
			action: StringEnum(AGENT_BROWSER_SEMANTIC_ACTIONS, {
				description: "Intent action to compile to an existing agent-browser find command.",
			}),
			locator: StringEnum(AGENT_BROWSER_SEMANTIC_LOCATORS, {
				description: "Upstream find locator family to use.",
			}),
			value: Type.String({ description: "Locator value, such as visible text, label text, placeholder text, test id, title, alt text, or role." }),
			text: Type.Optional(Type.String({ description: "Text/value argument for fill or select actions." })),
			role: Type.Optional(Type.String({ description: "Role locator value; when set it must match value for locator=role." })),
			name: Type.Optional(Type.String({ description: "Accessible name filter for locator=role; compiles to --name <name>." })),
		}),
	),
	stdin: Type.Optional(Type.String({ description: "Optional raw stdin content; only supported for batch, eval --stdin, and auth save --password-stdin." })),
	sessionMode: Type.Optional(
		StringEnum(["auto", "fresh"] as const, {
			description:
				"Session handling mode. `auto` reuses the extension-managed pi-scoped session when possible. `fresh` switches that managed session to a fresh upstream launch so launch-scoped flags like --profile, --session-name, --cdp, --state, --auto-connect, --init-script, or --enable apply and later auto calls follow the new browser.",
			default: DEFAULT_SESSION_MODE,
		}),
	),
});
function buildMissingBinaryMessage(): string {
	return [
		"agent-browser is required but was not found on PATH.",
		"This project does not bundle agent-browser.",
		"Run `pi-agent-browser-doctor` for package/PATH diagnostics, then install agent-browser using the upstream docs:",
		"- https://agent-browser.dev/",
		"- https://github.com/vercel-labs/agent-browser",
	].join("\n");
}

function buildInvocationPreview(effectiveArgs: string[]): string {
	const preview = effectiveArgs.join(" ");
	return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

function compileAgentBrowserSemanticAction(input: unknown): { compiled?: CompiledAgentBrowserSemanticAction; error?: string } {
	if (!isRecord(input)) {
		return { error: "semanticAction must be an object." };
	}
	const action = input.action;
	const locator = input.locator;
	const value = input.value;
	const text = input.text;
	const role = input.role;
	const name = input.name;
	if (typeof action !== "string" || !AGENT_BROWSER_SEMANTIC_ACTIONS.includes(action as AgentBrowserSemanticActionName)) {
		return { error: `semanticAction.action must be one of: ${AGENT_BROWSER_SEMANTIC_ACTIONS.join(", ")}.` };
	}
	if (typeof locator !== "string" || !AGENT_BROWSER_SEMANTIC_LOCATORS.includes(locator as AgentBrowserSemanticLocator)) {
		return { error: `semanticAction.locator must be one of: ${AGENT_BROWSER_SEMANTIC_LOCATORS.join(", ")}.` };
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		return { error: "semanticAction.value must be a non-empty string." };
	}
	if (text !== undefined && typeof text !== "string") {
		return { error: "semanticAction.text must be a string when provided." };
	}
	if ((action === "fill" || action === "select") && (typeof text !== "string" || text.length === 0)) {
		return { error: `semanticAction.text is required for ${action}.` };
	}
	if (action !== "fill" && action !== "select" && text !== undefined) {
		return { error: `semanticAction.text is only supported for fill and select actions.` };
	}
	if (role !== undefined && (locator !== "role" || role !== value)) {
		return { error: "semanticAction.role is only supported for locator=role and must match value." };
	}
	if (name !== undefined && (locator !== "role" || typeof name !== "string" || name.length === 0)) {
		return { error: "semanticAction.name is only supported as a non-empty string for locator=role." };
	}
	const args = ["find", locator, value, action];
	if (action === "fill" || action === "select") {
		args.push(text as string);
	}
	if (locator === "role" && typeof name === "string") {
		args.push("--name", name);
	}
	return { compiled: { action: action as AgentBrowserSemanticActionName, locator: locator as AgentBrowserSemanticLocator, args } };
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
	const rawArgs = Array.isArray(input.args)
		? input.args.filter((value): value is string => typeof value === "string")
		: (semanticAction.compiled?.args ?? []);
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

function buildWrapperRecoveryHint(options: {
	pinnedBatchUnwrapMode?: PinnedBatchUnwrapMode;
	sessionTabCorrection?: OpenResultTabCorrection;
}): string | undefined {
	const wrapperManagedContexts = [
		options.sessionTabCorrection ? "session tab correction" : undefined,
		options.pinnedBatchUnwrapMode ? "pinned batch routing" : undefined,
	].filter((item): item is string => item !== undefined);
	if (wrapperManagedContexts.length === 0) {
		return undefined;
	}
	return `Wrapper recovery hint: this call used ${wrapperManagedContexts.join(" and ")}. Inspect details.effectiveArgs and details.sessionTabCorrection; if the selected tab looks wrong, run tab list for the same session before retrying.`;
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

interface NavigationSummary {
	title?: string;
	url?: string;
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

function validateWaitIpcTimeoutContract(commandTokens: string[], stdin: string | undefined): string | undefined {
	const directWaitTimeout = findWaitTimeoutMs(commandTokens);
	if (directWaitTimeout && directWaitTimeout.timeoutMs > SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS) {
		return buildIpcUnsafeWaitError(directWaitTimeout.source, directWaitTimeout.timeoutMs);
	}
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
	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index];
		if (!Array.isArray(step) || !step.every((item) => typeof item === "string")) {
			continue;
		}
		const waitTimeout = findWaitTimeoutMs(step);
		if (waitTimeout && waitTimeout.timeoutMs > SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS) {
			return buildIpcUnsafeWaitError(waitTimeout.source, waitTimeout.timeoutMs, index);
		}
	}
	return undefined;
}

async function prepareAgentBrowserArgs(args: string[], stdin: string | undefined, cwd: string): Promise<PreparedAgentBrowserArgs> {
	const preparedBatch = await prepareBatchScreenshotPaths(args, stdin, cwd);
	if (preparedBatch) {
		return preparedBatch;
	}

	const commandTokens = extractCommandTokens(args);
	const normalized = await normalizeScreenshotPathInTokens(commandTokens, cwd);
	if (!normalized.request) {
		return { args };
	}

	const commandStartIndex = args.length - commandTokens.length;
	return {
		args: [...args.slice(0, commandStartIndex), ...normalized.tokens],
		screenshotPathRequest: normalized.request,
	};
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

async function repairScreenshotArtifact(options: {
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	request?: ScreenshotPathRequest;
}): Promise<{ envelope?: AgentBrowserEnvelope; request?: ScreenshotArtifactRequest }> {
	const { cwd, envelope, request } = options;
	if (!request || !envelope || !isRecord(envelope.data)) {
		return { envelope, request };
	}

	const repaired = await repairScreenshotData({ cwd, data: envelope.data, request });
	return {
		envelope: { ...envelope, data: repaired.data },
		request: repaired.request,
	};
}

async function repairBatchScreenshotArtifacts(options: {
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	requests?: Array<ScreenshotPathRequest | undefined>;
}): Promise<{ envelope?: AgentBrowserEnvelope; requests?: Array<ScreenshotArtifactRequest | undefined> }> {
	const { cwd, envelope, requests } = options;
	if (!envelope || !Array.isArray(envelope.data) || !requests?.some((request) => request !== undefined)) {
		return { envelope, requests };
	}

	const repairedRequests: Array<ScreenshotArtifactRequest | undefined> = [];
	const repairedData = await Promise.all(envelope.data.map(async (item, index) => {
		const request = requests[index];
		if (!request || !isRecord(item) || !isRecord(item.result)) {
			return item;
		}
		const repaired = await repairScreenshotData({ cwd, data: item.result, request });
		repairedRequests[index] = repaired.request;
		return {
			...item,
			result: repaired.data,
		};
	}));

	return {
		envelope: { ...envelope, data: repairedData },
		requests: repairedRequests,
	};
}

function buildJsonVisibleContent(options: {
	error: unknown;
	presentation: Awaited<ReturnType<typeof buildToolPresentation>>;
	succeeded: boolean;
	warnings?: string[];
}): Array<{ text: string; type: "text" } | { data: string; mimeType: string; type: "image" }> {
	const { error, presentation, succeeded, warnings } = options;
	const payload = redactSensitiveValue({
		artifacts: presentation.artifacts,
		data: presentation.data,
		error,
		success: succeeded,
		warnings: warnings && warnings.length > 0 ? warnings : undefined,
	});
	if (isRecord(payload) && isRecord(payload.data) && isRecord(presentation.data) && typeof presentation.data.wsUrl === "string") {
		payload.data.wsUrl = presentation.data.wsUrl;
	}
	const images = presentation.content.filter((item): item is { data: string; mimeType: string; type: "image" } => item.type === "image");
	return [{ type: "text", text: JSON.stringify(payload, null, 2) }, ...images];
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

function getTraceOwnerGuardMessage(options: {
	command: string | undefined;
	sessionName: string | undefined;
	subcommand: string | undefined;
	traceOwners: Map<string, TraceOwner>;
}): string | undefined {
	const owner = getTraceOwner(options.command);
	if (!owner || !options.sessionName || (options.subcommand !== "start" && options.subcommand !== "stop")) {
		return undefined;
	}
	const activeOwner = options.traceOwners.get(options.sessionName);
	if (!activeOwner || activeOwner === owner) {
		return undefined;
	}
	return options.subcommand === "start"
		? `Wrapper believes ${activeOwner} tracing is active for session ${options.sessionName}; stop ${activeOwner} before starting ${owner}.`
		: `Wrapper believes tracing for session ${options.sessionName} is owned by ${activeOwner}; run ${activeOwner} stop instead of ${owner} stop.`;
}

function updateTraceOwnerState(options: {
	command: string | undefined;
	sessionName: string | undefined;
	subcommand: string | undefined;
	succeeded: boolean;
	traceOwners: Map<string, TraceOwner>;
}): void {
	const owner = getTraceOwner(options.command);
	if (!owner || !options.sessionName || !options.succeeded) {
		return;
	}
	if (options.subcommand === "start") {
		options.traceOwners.set(options.sessionName, owner);
	}
	if (options.subcommand === "stop" && options.traceOwners.get(options.sessionName) === owner) {
		options.traceOwners.delete(options.sessionName);
	}
}

function shouldCaptureNavigationSummary(command: string | undefined, data: unknown): boolean {
	return (
		command !== undefined &&
		NAVIGATION_SUMMARY_COMMANDS.has(command) &&
		(!isRecord(data) || (typeof data.title !== "string" && typeof data.url !== "string"))
	);
}

function extractStringResultField(data: unknown, fieldName: "title" | "url"): string | undefined {
	if (typeof data === "string") {
		const text = data.trim();
		return text.length > 0 ? text : undefined;
	}
	if (!isRecord(data) || typeof data[fieldName] !== "string") {
		return undefined;
	}
	const text = data[fieldName].trim();
	return text.length > 0 ? text : undefined;
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

interface SessionTabTarget {
	title?: string;
	url: string;
}

interface OrderedSessionTabTarget {
	order: number;
	target: SessionTabTarget;
}

interface AboutBlankSessionMismatch {
	activeUrl: "about:blank";
	recoveryApplied: boolean;
	recoveryHint: string;
	targetTitle?: string;
	targetUrl: string;
}

function getLatestSessionTabTargetOrder(targets: Map<string, OrderedSessionTabTarget>): number {
	let latestOrder = 0;
	for (const target of targets.values()) {
		latestOrder = Math.max(latestOrder, target.order);
	}
	return latestOrder;
}

function shouldApplySessionTabTargetUpdate(options: {
	current?: OrderedSessionTabTarget;
	updateOrder: number;
}): boolean {
	return !options.current || options.updateOrder >= options.current.order;
}

function normalizeComparableUrl(url: string | undefined): string | undefined {
	const normalizedUrl = url?.trim();
	if (!normalizedUrl) {
		return undefined;
	}
	try {
		const parsedUrl = new URL(normalizedUrl);
		parsedUrl.hash = "";
		return parsedUrl.toString();
	} catch {
		return undefined;
	}
}

function isAboutBlankUrl(url: string | undefined): boolean {
	return normalizeComparableUrl(url) === "about:blank";
}

function isAboutBlankSessionTabTarget(target: SessionTabTarget | undefined): boolean {
	return isAboutBlankUrl(target?.url);
}

function commandExplicitlyTargetsAboutBlank(commandTokens: string[]): boolean {
	return commandTokens.some((token) => isAboutBlankUrl(token));
}

function buildAboutBlankRecoveryHint(): string {
	return "agent_browser detected that the active tab became about:blank while this session still had a prior intended tab. Run tab list for this session and re-select the intended tab, or retry with sessionMode=fresh if the tab is gone.";
}

function buildAboutBlankWarning(mismatch: AboutBlankSessionMismatch): string {
	return `Warning: agent_browser detected that this session returned about:blank while the prior intended tab was ${mismatch.targetUrl}. ${mismatch.recoveryApplied ? "The wrapper re-selected the intended tab for the session." : "No matching tab could be re-selected; run tab list for the same session or retry with sessionMode=fresh."}`;
}

function normalizeSessionTabTarget(target: { title?: string; url?: string } | undefined): SessionTabTarget | undefined {
	if (!target) {
		return undefined;
	}
	const url = normalizeComparableUrl(target.url);
	if (!url) {
		return undefined;
	}
	const title = target.title?.trim();
	return { title: title && title.length > 0 ? title : undefined, url };
}

function extractSessionTabTargetFromData(data: unknown): SessionTabTarget | undefined {
	const directTarget = normalizeSessionTabTarget({
		title: extractStringResultField(data, "title"),
		url: extractStringResultField(data, "url"),
	});
	if (directTarget) {
		return directTarget;
	}
	if (isRecord(data) && typeof data.origin === "string") {
		return normalizeSessionTabTarget({ url: data.origin });
	}
	return undefined;
}

function extractBatchResultCommand(item: Record<string, unknown>): string[] {
	return Array.isArray(item.command) ? item.command.filter((token): token is string => typeof token === "string") : [];
}

function extractSessionTabTargetFromBatchResults(data: unknown): SessionTabTarget | undefined {
	if (!Array.isArray(data)) {
		return undefined;
	}

	let currentTarget: SessionTabTarget | undefined;
	let pendingTitle: string | undefined;
	for (const item of data) {
		if (!isRecord(item) || item.success === false) {
			continue;
		}
		const [name, subcommand] = extractBatchResultCommand(item);
		const result = item.result;

		if (name === "get" && subcommand === "title") {
			pendingTitle = extractStringResultField(result, "title");
			continue;
		}
		if (name === "get" && subcommand === "url") {
			const url = extractStringResultField(result, "url");
			const target = normalizeSessionTabTarget({ title: pendingTitle, url });
			if (target) {
				currentTarget = target;
			}
			pendingTitle = undefined;
			continue;
		}

		const resultTarget = extractSessionTabTargetFromData(result);
		if (resultTarget) {
			currentTarget = resultTarget;
		}
		pendingTitle = undefined;
	}
	return currentTarget;
}

function restoreSessionTabTargetsFromBranch(branch: unknown[]): Map<string, OrderedSessionTabTarget> {
	const restoredTargets = new Map<string, OrderedSessionTabTarget>();
	let restoredOrder = 0;
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") {
			continue;
		}
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") {
			continue;
		}
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) {
			continue;
		}
		const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
		if (!sessionName) {
			continue;
		}
		const command = typeof details.command === "string" ? details.command : undefined;
		if (command === "close" && message.isError !== true) {
			restoredOrder += 1;
			restoredTargets.delete(sessionName);
			continue;
		}
		const sessionTabTarget = isRecord(details.sessionTabTarget)
			? normalizeSessionTabTarget({
					title: typeof details.sessionTabTarget.title === "string" ? details.sessionTabTarget.title : undefined,
					url: typeof details.sessionTabTarget.url === "string" ? details.sessionTabTarget.url : undefined,
			  })
			: undefined;
		if (sessionTabTarget) {
			restoredOrder += 1;
			restoredTargets.set(sessionName, { order: restoredOrder, target: sessionTabTarget });
		}
	}
	return restoredTargets;
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

function getExactSensitiveStdinValues(options: { command?: string; commandTokens: string[]; stdin?: string }): string[] {
	if (options.stdin === undefined || !isPasswordStdinAuthSave(options)) {
		return [];
	}
	return [...new Set([options.stdin, options.stdin.trimEnd(), options.stdin.trim()].filter((value) => value.length > 0))];
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

function validateStdinCommandContract(options: { command?: string; commandTokens: string[]; stdin?: string }): string | undefined {
	if (options.stdin === undefined) {
		return undefined;
	}
	if (options.command === "batch") {
		return undefined;
	}
	if (options.command === "eval" && options.commandTokens.includes("--stdin")) {
		return undefined;
	}
	if (isPasswordStdinAuthSave(options)) {
		return undefined;
	}
	const commandLabel = options.command ? `\`${options.command}\`` : "the requested command";
	return `agent_browser stdin is only supported for \`batch\`, \`eval --stdin\`, and \`auth save --password-stdin\`; remove stdin from ${commandLabel} or use one of those command forms.`;
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

function shouldPinSessionTabForCommand(options: {
	command?: string;
	commandTokens: string[];
	sessionName?: string;
	stdin?: string;
}): boolean {
	return (
		options.sessionName !== undefined &&
		options.command !== undefined &&
		!SESSION_TAB_PINNING_EXCLUDED_COMMANDS.has(options.command) &&
		supportsPinnedStdinCommand(options)
	);
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

function getStaleRefArgs(commandTokens: string[], stdin?: string): string[] {
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return commandTokens;
	}
	const parsed = parseUserBatchStdin(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return commandTokens;
	}
	return parsed.steps.flatMap((step) => step);
}

function buildPinnedBatchPlan(options: {
	command?: string;
	commandTokens: string[];
	selectedTab: string;
	stdin?: string;
}): PinnedBatchPlan | { error: string } | undefined {
	if (options.command === "batch") {
		const parsed = parseUserBatchStdin(options.stdin);
		if (parsed.error) {
			return { error: parsed.error };
		}
		const tabSelectionStep: BatchCommandStep = ["tab", options.selectedTab];
		return {
			includeNavigationSummary: false,
			steps: [tabSelectionStep, ...(parsed.steps ?? [])],
			unwrapMode: "user-batch",
		};
	}
	if (options.commandTokens.length === 0) {
		return undefined;
	}
	const includeNavigationSummary = options.command !== undefined && NAVIGATION_SUMMARY_COMMANDS.has(options.command);
	const tabSelectionStep: BatchCommandStep = ["tab", options.selectedTab];
	const commandStep = options.commandTokens as BatchCommandStep;
	const navigationSummarySteps: BatchCommandStep[] = includeNavigationSummary ? [["get", "title"], ["get", "url"]] : [];
	return {
		includeNavigationSummary,
		steps: [tabSelectionStep, commandStep, ...navigationSummarySteps],
		unwrapMode: "single-command",
	};
}

function shouldCorrectSessionTabAfterCommand(options: { command?: string; sessionName?: string }): boolean {
	return (
		options.sessionName !== undefined &&
		options.command !== undefined &&
		!SESSION_TAB_POST_COMMAND_CORRECTION_EXCLUDED_COMMANDS.has(options.command)
	);
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

function deriveSessionTabTarget(options: {
	command?: string;
	data: unknown;
	navigationSummary?: NavigationSummary;
	previousTarget?: SessionTabTarget;
}): SessionTabTarget | undefined {
	if (options.command === "close") {
		return undefined;
	}
	return (
		normalizeSessionTabTarget(options.navigationSummary) ??
		extractSessionTabTargetFromBatchResults(options.data) ??
		extractSessionTabTargetFromData(options.data) ??
		options.previousTarget
	);
}

function unwrapPinnedSessionBatchEnvelope(options: {
	envelope?: AgentBrowserEnvelope;
	includeNavigationSummary: boolean;
	mode?: PinnedBatchUnwrapMode;
}): { envelope?: AgentBrowserEnvelope; navigationSummary?: NavigationSummary; parseError?: string } {
	if (!options.envelope) {
		return {};
	}
	if (!Array.isArray(options.envelope.data)) {
		return {
			parseError: "agent-browser returned an unexpected response while applying the wrapper's tab-pinning batch.",
		};
	}

	const steps = options.envelope.data.filter(isRecord) as AgentBrowserBatchResult[];
	const tabSelectionStep = steps[0];
	const commandStep = steps[1];
	if (tabSelectionStep?.success === false) {
		return {
			envelope: {
				success: false,
				error: tabSelectionStep.error ?? "agent-browser could not re-select the intended tab before running the command.",
			},
		};
	}
	if (options.mode === "user-batch") {
		const userSteps = steps.slice(1);
		return {
			envelope: {
				success: userSteps.every((step) => step.success !== false),
				data: userSteps,
				error: userSteps.find((step) => step.success === false)?.error,
			},
		};
	}
	if (!commandStep) {
		return {
			envelope: {
				success: false,
				error: "agent-browser did not return the corrected command result.",
			},
		};
	}

	const titleStep = options.includeNavigationSummary ? steps[2] : undefined;
	const urlStep = options.includeNavigationSummary ? steps[3] : undefined;
	const navigationSummary = normalizeSessionTabTarget({
		title: extractStringResultField(titleStep?.result, "title"),
		url: extractStringResultField(urlStep?.result, "url"),
	});
	return {
		envelope: {
			success: commandStep.success !== false,
			data: commandStep.result,
			error: commandStep.success === false ? commandStep.error : undefined,
		},
		navigationSummary,
	};
}

async function runSessionCommandData(options: {
	args: string[];
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<unknown | undefined> {
	const { args, cwd, sessionName, signal } = options;
	if (!sessionName) return undefined;

	const processResult = await runAgentBrowserProcess({
		args: ["--json", "--session", sessionName, ...args],
		cwd,
		signal,
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

async function collectNavigationSummary(options: {
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<NavigationSummary | undefined> {
	const { cwd, sessionName, signal } = options;
	const title = extractStringResultField(
		await runSessionCommandData({ args: ["get", "title"], cwd, sessionName, signal }),
		"title",
	);
	const url = extractStringResultField(
		await runSessionCommandData({ args: ["get", "url"], cwd, sessionName, signal }),
		"url",
	);
	if (!title && !url) return undefined;
	return { title, url };
}

function mergeNavigationSummaryIntoData(data: unknown, navigationSummary: NavigationSummary): unknown {
	if (isRecord(data)) {
		return { ...data, navigationSummary };
	}
	return { navigationSummary, result: data };
}

async function collectOpenResultTabCorrection(options: {
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
	targetTitle?: string;
	targetUrl?: string;
}): Promise<OpenResultTabCorrection | undefined> {
	const { cwd, sessionName, signal, targetTitle, targetUrl } = options;
	const tabData = await runSessionCommandData({ args: ["tab", "list"], cwd, sessionName, signal });
	if (!isRecord(tabData) || !Array.isArray(tabData.tabs)) {
		return undefined;
	}
	const tabs = tabData.tabs.filter(isRecord).map((tab, index) => ({
		active: tab.active === true,
		index: typeof tab.index === "number" ? tab.index : index,
		label: typeof tab.label === "string" ? tab.label : undefined,
		tabId: typeof tab.tabId === "string" ? tab.tabId : undefined,
		title: typeof tab.title === "string" ? tab.title : undefined,
		url: typeof tab.url === "string" ? tab.url : undefined,
	}));
	return chooseOpenResultTabCorrection({ tabs, targetTitle, targetUrl });
}

async function collectSessionTabSelection(options: {
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
	target: SessionTabTarget;
}): Promise<OpenResultTabCorrection | undefined> {
	const { cwd, sessionName, signal, target } = options;
	const tabData = await runSessionCommandData({ args: ["tab", "list"], cwd, sessionName, signal });
	if (!isRecord(tabData) || !Array.isArray(tabData.tabs)) {
		return undefined;
	}
	const tabs = tabData.tabs.filter(isRecord).map((tab, index) => ({
		active: tab.active === true,
		index: typeof tab.index === "number" ? tab.index : index,
		label: typeof tab.label === "string" ? tab.label : undefined,
		tabId: typeof tab.tabId === "string" ? tab.tabId : undefined,
		title: typeof tab.title === "string" ? tab.title : undefined,
		url: typeof tab.url === "string" ? tab.url : undefined,
	}));
	return selectSessionTargetTab({ tabs, target });
}

async function applyOpenResultTabCorrection(options: {
	correction: OpenResultTabCorrection;
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<OpenResultTabCorrection | undefined> {
	const { correction, cwd, sessionName, signal } = options;
	const result = await runSessionCommandData({
		args: ["tab", correction.selectedTab],
		cwd,
		sessionName,
		signal,
	});
	return result === undefined ? undefined : correction;
}

function buildSessionDetailFields(sessionName: string | undefined, usedImplicitSession: boolean): Record<string, unknown> {
	return sessionName ? { sessionName, usedImplicitSession } : {};
}

function getPersistentSessionArtifactStore(ctx: {
	sessionManager: {
		getSessionDir?: () => string;
		getSessionId: () => string | undefined;
	};
}): PersistentSessionArtifactStore | undefined {
	const sessionDir = typeof ctx.sessionManager.getSessionDir === "function" ? ctx.sessionManager.getSessionDir() : undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	return sessionDir && sessionId ? { sessionDir, sessionId } : undefined;
}

async function preserveParseFailureOutput(options: {
	artifactManifest?: SessionArtifactManifest;
	exactSensitiveValues?: string[];
	persistentArtifactStore?: PersistentSessionArtifactStore;
	stdoutSpillPath?: string;
}): Promise<{
	artifactManifest?: SessionArtifactManifest;
	artifactRetentionSummary?: string;
	fullOutputPath?: string;
	fullOutputUnavailable?: string;
}> {
	if (!options.stdoutSpillPath) {
		return {};
	}

	try {
		const rawOutput = redactExactSensitiveText(await readFile(options.stdoutSpillPath, "utf8"), options.exactSensitiveValues ?? []);
		const nowMs = Date.now();
		let evictedArtifacts: PersistentSessionArtifactEviction[] = [];
		let fullOutputPath: string;
		let storageScope: "persistent-session" | "process-temp";
		if (options.persistentArtifactStore) {
			const result = await writePersistentSessionArtifactFile({
				content: rawOutput,
				prefix: "pi-agent-browser-parse-failure-output",
				store: options.persistentArtifactStore,
				suffix: ".txt",
			});
			fullOutputPath = result.path;
			evictedArtifacts = result.evictedArtifacts;
			storageScope = "persistent-session";
		} else {
			fullOutputPath = await writeSecureTempFile({
				content: rawOutput,
				prefix: "pi-agent-browser-parse-failure-output",
				suffix: ".txt",
			});
			storageScope = "process-temp";
		}
		const artifactManifest = mergeSessionArtifactManifest({
			base: options.artifactManifest,
			entries: [
				{
					command: "agent-browser",
					createdAtMs: nowMs,
					kind: "spill",
					path: fullOutputPath,
					retentionState: storageScope === "persistent-session" ? "live" : "ephemeral",
					storageScope,
				},
				...buildEvictedSessionArtifactEntries(evictedArtifacts, nowMs),
			],
			nowMs,
		});
		return {
			artifactManifest,
			artifactRetentionSummary: artifactManifest ? formatSessionArtifactRetentionSummary(artifactManifest) : undefined,
			fullOutputPath,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { fullOutputUnavailable: message };
	}
}

function redactRecoveryHint(recoveryHint: {
	exampleArgs: string[];
	exampleParams: { args: string[]; sessionMode: "fresh" };
	reason: string;
	recommendedSessionMode: "fresh";
} | undefined): typeof recoveryHint {
	if (!recoveryHint) {
		return undefined;
	}
	const exampleArgs = redactInvocationArgs(recoveryHint.exampleArgs);
	return {
		...recoveryHint,
		exampleArgs,
		exampleParams: {
			...recoveryHint.exampleParams,
			args: exampleArgs,
		},
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

async function closeManagedSession(options: { cwd: string; sessionName: string; timeoutMs: number }): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	let stdoutSpillPath: string | undefined;
	try {
		const processResult = await runAgentBrowserProcess({
			args: ["--session", options.sessionName, "close"],
			cwd: options.cwd,
			signal: controller.signal,
		});
		stdoutSpillPath = processResult.stdoutSpillPath;
	} catch {
		// Best-effort cleanup only.
	} finally {
		clearTimeout(timer);
		if (stdoutSpillPath) {
			await rm(stdoutSpillPath, { force: true }).catch(() => undefined);
		}
	}
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	const ephemeralSessionSeed = createEphemeralSessionSeed();
	const hasBraveApiKey = hasUsableBraveApiKey();
	const toolPromptGuidelines = buildToolPromptGuidelines({ includeBraveSearch: hasBraveApiKey });
	const implicitSessionIdleTimeoutMs = String(getImplicitSessionIdleTimeoutMs());
	const implicitSessionCloseTimeoutMs = getImplicitSessionCloseTimeoutMs();
	let managedSessionActive = false;
	let managedSessionBaseName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);
	let managedSessionName = managedSessionBaseName;
	let managedSessionCwd = process.cwd();
	let freshSessionOrdinal = 0;
	let sessionTabTargets = new Map<string, OrderedSessionTabTarget>();
	let sessionTabTargetUpdateOrder = 0;
	let traceOwners = new Map<string, TraceOwner>();
	let artifactManifest: SessionArtifactManifest | undefined;
	const managedSessionExecutionQueue = new AsyncExecutionQueue();

	pi.on("session_start", async (_event, ctx) => {
		managedSessionBaseName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
		const restoredState = restoreManagedSessionStateFromBranch(ctx.sessionManager.getBranch(), managedSessionBaseName);
		managedSessionActive = restoredState.active;
		managedSessionName = restoredState.sessionName;
		managedSessionCwd = ctx.cwd;
		freshSessionOrdinal = restoredState.freshSessionOrdinal;
		sessionTabTargets = restoreSessionTabTargetsFromBranch(ctx.sessionManager.getBranch());
		sessionTabTargetUpdateOrder = getLatestSessionTabTargetOrder(sessionTabTargets);
		artifactManifest = restoreArtifactManifestFromBranch(ctx.sessionManager.getBranch());
	});

	pi.on("session_shutdown", async (event) => {
		if (event?.reason === "quit") {
			await managedSessionExecutionQueue.run(async () => {
				if (!managedSessionActive) return;
				await closeManagedSession({
					cwd: managedSessionCwd,
					sessionName: managedSessionName,
					timeoutMs: implicitSessionCloseTimeoutMs,
				});
			});
		}
		managedSessionActive = false;
		sessionTabTargets = new Map<string, OrderedSessionTabTarget>();
		sessionTabTargetUpdateOrder = 0;
		traceOwners = new Map<string, TraceOwner>();
		artifactManifest = undefined;
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
			const semanticActionResult = params.semanticAction === undefined ? {} : compileAgentBrowserSemanticAction(params.semanticAction);
			const hasExplicitArgs = Array.isArray(params.args);
			const semanticActionError = semanticActionResult.error;
			const inputModeError = hasExplicitArgs === Boolean(semanticActionResult.compiled)
				? "Provide exactly one of args or semanticAction."
				: undefined;
			const compiledSemanticAction = semanticActionResult.compiled;
			const toolArgs = compiledSemanticAction?.args ?? params.args ?? [];
			const redactedArgs = redactInvocationArgs(toolArgs);
			const validationError = semanticActionError ?? inputModeError ?? validateToolArgs(toolArgs) ?? getBatchAnnotateValidationError(toolArgs, params.stdin);
			const redactedCompiledSemanticAction = compiledSemanticAction
				? { ...compiledSemanticAction, args: redactInvocationArgs(compiledSemanticAction.args) }
				: undefined;
			if (validationError) {
				return {
					content: [{ type: "text", text: validationError }],
					details: {
						args: redactedArgs,
						compiledSemanticAction: redactedCompiledSemanticAction,
						...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, errorText: validationError, succeeded: false, validationError }),
						validationError,
					},
					isError: true,
				};
			}
			const preparedArgs = await prepareAgentBrowserArgs(toolArgs, params.stdin, ctx.cwd);
			const userRequestedJson = toolArgs.includes("--json");

			const tabTargetUpdateOrder = ++sessionTabTargetUpdateOrder;
			const runTool = async (): Promise<AgentBrowserToolResult> => {
				const sessionMode = params.sessionMode ?? DEFAULT_SESSION_MODE;
				const freshSessionName = createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal + 1);
				const executionPlan = buildExecutionPlan(preparedArgs.args, {
					freshSessionName,
					managedSessionActive,
					managedSessionName,
					sessionMode,
				});
				const redactedEffectiveArgs = redactInvocationArgs(executionPlan.effectiveArgs);
				const redactedRecoveryHint = redactRecoveryHint(executionPlan.recoveryHint);
				const compatibilityWorkaround: CompatibilityWorkaround | undefined = executionPlan.compatibilityWorkaround;
				if (executionPlan.managedSessionName === freshSessionName) {
					freshSessionOrdinal += 1;
				}

				if (executionPlan.validationError) {
					return {
						content: [{ type: "text", text: executionPlan.validationError }],
						details: {
							args: redactedArgs,
							invalidValueFlag: executionPlan.invalidValueFlag,
							sessionMode,
							sessionRecoveryHint: redactedRecoveryHint,
							startupScopedFlags: executionPlan.startupScopedFlags,
							...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, command: executionPlan.commandInfo.command, errorText: executionPlan.validationError, succeeded: false, validationError: executionPlan.validationError }),
							validationError: executionPlan.validationError,
						},
						isError: true,
					};
				}

				const commandTokens = extractCommandTokens(preparedArgs.args);
				const exactSensitiveValues = getExactSensitiveStdinValues({
					command: executionPlan.commandInfo.command,
					commandTokens,
					stdin: params.stdin,
				});
				const traceOwnerGuardMessage = getTraceOwnerGuardMessage({
					command: executionPlan.commandInfo.command,
					sessionName: executionPlan.sessionName,
					subcommand: executionPlan.commandInfo.subcommand,
					traceOwners,
				});
				if (traceOwnerGuardMessage) {
					return {
						content: [{ type: "text", text: traceOwnerGuardMessage }],
						details: {
							args: redactedArgs,
							command: executionPlan.commandInfo.command,
							compatibilityWorkaround,
							effectiveArgs: redactedEffectiveArgs,
							sessionMode,
							...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: traceOwnerGuardMessage, succeeded: false, validationError: traceOwnerGuardMessage }),
							validationError: traceOwnerGuardMessage,
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						},
						isError: true,
					};
				}
				const stdinValidationError = validateStdinCommandContract({
					command: executionPlan.commandInfo.command,
					commandTokens,
					stdin: params.stdin,
				});
				if (stdinValidationError) {
					return {
						content: [{ type: "text", text: stdinValidationError }],
						details: {
							args: redactedArgs,
							command: executionPlan.commandInfo.command,
							compatibilityWorkaround,
							effectiveArgs: redactedEffectiveArgs,
							sessionMode,
							...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: stdinValidationError, succeeded: false, validationError: stdinValidationError }),
							validationError: stdinValidationError,
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						},
						isError: true,
					};
				}
				const waitIpcTimeoutError = validateWaitIpcTimeoutContract(commandTokens, params.stdin);
				if (waitIpcTimeoutError) {
					return {
						content: [{ type: "text", text: waitIpcTimeoutError }],
						details: {
							args: redactedArgs,
							command: executionPlan.commandInfo.command,
							compatibilityWorkaround,
							effectiveArgs: redactedEffectiveArgs,
							sessionMode,
							...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: waitIpcTimeoutError, succeeded: false, timedOut: true, validationError: waitIpcTimeoutError }),
							validationError: waitIpcTimeoutError,
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						},
						isError: true,
					};
				}

				const priorSessionTabTargetState = executionPlan.sessionName ? sessionTabTargets.get(executionPlan.sessionName) : undefined;
				const priorSessionTabTarget = priorSessionTabTargetState?.target;
				let pinnedBatchUnwrapMode: PinnedBatchUnwrapMode | undefined;
				let includePinnedNavigationSummary = false;
				let sessionTabCorrection: OpenResultTabCorrection | undefined;
				let processArgs = executionPlan.effectiveArgs;
				let processStdin = preparedArgs.stdin ?? params.stdin;
				if (
					priorSessionTabTarget &&
					shouldPinSessionTabForCommand({
						command: executionPlan.commandInfo.command,
						commandTokens,
						sessionName: executionPlan.sessionName,
						stdin: params.stdin,
					})
				) {
					const plannedSessionTabSelection = await collectSessionTabSelection({
						cwd: ctx.cwd,
						sessionName: executionPlan.sessionName,
						signal,
						target: priorSessionTabTarget,
					});
					if (plannedSessionTabSelection && executionPlan.sessionName) {
						if (executionPlan.commandInfo.command === "eval" && params.stdin !== undefined) {
							const appliedSessionTabSelection = await applyOpenResultTabCorrection({
								correction: plannedSessionTabSelection,
								cwd: ctx.cwd,
								sessionName: executionPlan.sessionName,
								signal,
							});
							if (!appliedSessionTabSelection) {
								const error = "agent-browser could not re-select the intended tab before running the command.";
								return {
									content: [{ type: "text", text: error }],
									details: {
										args: redactedArgs,
										command: executionPlan.commandInfo.command,
										compatibilityWorkaround,
										effectiveArgs: redactedEffectiveArgs,
										sessionMode,
										sessionTabCorrection: plannedSessionTabSelection,
										...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: error, failureCategory: "tab-drift", succeeded: false, tabDrift: true, validationError: error }),
										nextActions: buildAgentBrowserNextActions({ failureCategory: "tab-drift", resultCategory: "failure" }),
										validationError: error,
										...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
									},
									isError: true,
								};
							}
							sessionTabCorrection = appliedSessionTabSelection;
						} else {
							const pinnedBatchPlan = buildPinnedBatchPlan({
								command: executionPlan.commandInfo.command,
								commandTokens,
								selectedTab: plannedSessionTabSelection.selectedTab,
								stdin: params.stdin,
							});
							if (pinnedBatchPlan && "error" in pinnedBatchPlan) {
								return {
									content: [{ type: "text", text: pinnedBatchPlan.error }],
									details: {
										args: redactedArgs,
										command: executionPlan.commandInfo.command,
										compatibilityWorkaround,
										effectiveArgs: redactedEffectiveArgs,
										sessionMode,
										sessionTabCorrection: plannedSessionTabSelection,
										...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: pinnedBatchPlan.error, failureCategory: "tab-drift", succeeded: false, tabDrift: true, validationError: pinnedBatchPlan.error }),
										nextActions: buildAgentBrowserNextActions({ failureCategory: "tab-drift", resultCategory: "failure" }),
										validationError: pinnedBatchPlan.error,
										...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
									},
									isError: true,
								};
							}
							if (pinnedBatchPlan) {
								sessionTabCorrection = plannedSessionTabSelection;
								processArgs = ["--json", "--session", executionPlan.sessionName, "batch"];
								processStdin = JSON.stringify(pinnedBatchPlan.steps);
								includePinnedNavigationSummary = pinnedBatchPlan.includeNavigationSummary;
								pinnedBatchUnwrapMode = pinnedBatchPlan.unwrapMode;
							}
						}
					}
				}
				const redactedProcessArgs = redactInvocationArgs(processArgs);

				onUpdate?.({
					content: [{ type: "text", text: `Running agent-browser ${buildInvocationPreview(redactedProcessArgs)}` }],
					details: {
						compatibilityWorkaround,
						effectiveArgs: redactedProcessArgs,
						sessionMode,
						sessionTabCorrection,
						...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
					},
				});

				const processResult = await runAgentBrowserProcess({
					args: processArgs,
					cwd: ctx.cwd,
					env: executionPlan.managedSessionName ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: implicitSessionIdleTimeoutMs } : undefined,
					signal,
					stdin: processStdin,
				});

				if (processResult.spawnError?.message.includes("ENOENT")) {
					const errorText = buildMissingBinaryMessage();
					return {
						content: [{ type: "text", text: errorText }],
						details: {
							args: redactedArgs,
							compatibilityWorkaround,
							effectiveArgs: redactedProcessArgs,
							sessionMode,
							sessionTabCorrection,
							...buildAgentBrowserResultCategoryDetails({ args: redactedProcessArgs, command: executionPlan.commandInfo.command, errorText, failureCategory: "missing-binary", spawnError: processResult.spawnError.message, succeeded: false }),
							spawnError: processResult.spawnError.message,
						},
						isError: true,
					};
				}

				try {
					const persistentArtifactStore = getPersistentSessionArtifactStore(ctx);
					const parsed = await parseAgentBrowserEnvelope({
						stdout: processResult.stdout,
						stdoutPath: processResult.stdoutSpillPath,
					});
					let parseError = parsed.parseError;
					let presentationEnvelope = parsed.envelope;
					let navigationSummary: NavigationSummary | undefined;
					if (pinnedBatchUnwrapMode) {
						const pinnedBatchResult = unwrapPinnedSessionBatchEnvelope({
							envelope: parsed.envelope,
							includeNavigationSummary: includePinnedNavigationSummary,
							mode: pinnedBatchUnwrapMode,
						});
						parseError = pinnedBatchResult.parseError ?? parseError;
						presentationEnvelope = pinnedBatchResult.envelope ?? presentationEnvelope;
						navigationSummary = pinnedBatchResult.navigationSummary;
					}
					const repairedScreenshot = await repairScreenshotArtifact({
						cwd: ctx.cwd,
						envelope: presentationEnvelope,
						request: preparedArgs.screenshotPathRequest,
					});
					presentationEnvelope = repairedScreenshot.envelope;
					const repairedBatchScreenshots = await repairBatchScreenshotArtifacts({
						cwd: ctx.cwd,
						envelope: presentationEnvelope,
						requests: preparedArgs.batchScreenshotPathRequests,
					});
					presentationEnvelope = repairedBatchScreenshots.envelope;
					const screenshotArtifactRequest = repairedScreenshot.request;
					const batchScreenshotArtifactRequests = repairedBatchScreenshots.requests;
					if (presentationEnvelope && exactSensitiveValues.length > 0) {
						presentationEnvelope = redactExactSensitiveValue(presentationEnvelope, exactSensitiveValues) as AgentBrowserEnvelope;
					}
					const parseFailureOutput = parseError
						? await preserveParseFailureOutput({
								artifactManifest,
								exactSensitiveValues,
								persistentArtifactStore,
								stdoutSpillPath: processResult.stdoutSpillPath,
							})
						: {};
					const processSucceeded = !processResult.aborted && !processResult.spawnError && processResult.exitCode === 0;
					const plainTextInspection = executionPlan.plainTextInspection && processSucceeded;
					const parseSucceeded = plainTextInspection || parseError === undefined;
					const envelopeSuccess = plainTextInspection ? true : presentationEnvelope?.success !== false;
					const succeeded = processSucceeded && parseSucceeded && envelopeSuccess;
					const inspectionText = plainTextInspection ? processResult.stdout.trim() : undefined;
					updateTraceOwnerState({
						command: executionPlan.commandInfo.command,
						sessionName: executionPlan.sessionName,
						subcommand: executionPlan.commandInfo.subcommand,
						succeeded,
						traceOwners,
					});

					if (succeeded && !navigationSummary && shouldCaptureNavigationSummary(executionPlan.commandInfo.command, presentationEnvelope?.data)) {
						navigationSummary = await collectNavigationSummary({
							cwd: ctx.cwd,
							sessionName: executionPlan.sessionName,
							signal,
						});
					}
					if (navigationSummary && presentationEnvelope) {
						presentationEnvelope = {
							...presentationEnvelope,
							data: mergeNavigationSummaryIntoData(presentationEnvelope.data, navigationSummary),
						};
					}

					let openResultTabCorrection: OpenResultTabCorrection | undefined;
					if (
						succeeded &&
						executionPlan.sessionName &&
						hasLaunchScopedTabCorrectionFlag(toolArgs) &&
						(executionPlan.commandInfo.command === "goto" ||
							executionPlan.commandInfo.command === "navigate" ||
							executionPlan.commandInfo.command === "open")
					) {
						const targetTitle = extractStringResultField(presentationEnvelope?.data, "title");
						const targetUrl = extractStringResultField(presentationEnvelope?.data, "url");
						const plannedTabCorrection = await collectOpenResultTabCorrection({
							cwd: ctx.cwd,
							sessionName: executionPlan.sessionName,
							signal,
							targetTitle,
							targetUrl,
						});
						if (plannedTabCorrection) {
							openResultTabCorrection = await applyOpenResultTabCorrection({
								correction: plannedTabCorrection,
								cwd: ctx.cwd,
								sessionName: executionPlan.sessionName,
								signal,
							});
						}
					}

					const observedSessionTabTarget =
						normalizeSessionTabTarget(navigationSummary) ??
						extractSessionTabTargetFromBatchResults(presentationEnvelope?.data) ??
						extractSessionTabTargetFromData(presentationEnvelope?.data);
					let currentSessionTabTarget = deriveSessionTabTarget({
						command: executionPlan.commandInfo.command,
						data: presentationEnvelope?.data,
						navigationSummary,
						previousTarget: priorSessionTabTarget,
					});
					let aboutBlankSessionMismatch: AboutBlankSessionMismatch | undefined;
					const shouldTreatAboutBlankAsMismatch =
						succeeded &&
						priorSessionTabTarget !== undefined &&
						!isAboutBlankSessionTabTarget(priorSessionTabTarget) &&
						isAboutBlankSessionTabTarget(observedSessionTabTarget ?? currentSessionTabTarget) &&
						!commandExplicitlyTargetsAboutBlank(commandTokens);
					if (shouldTreatAboutBlankAsMismatch && priorSessionTabTarget) {
						const aboutBlankRecovery = await collectSessionTabSelection({
							cwd: ctx.cwd,
							sessionName: executionPlan.sessionName,
							signal,
							target: priorSessionTabTarget,
						});
						const appliedAboutBlankRecovery = aboutBlankRecovery
							? await applyOpenResultTabCorrection({
									correction: aboutBlankRecovery,
									cwd: ctx.cwd,
									sessionName: executionPlan.sessionName,
									signal,
							  })
							: undefined;
						if (appliedAboutBlankRecovery) {
							sessionTabCorrection = appliedAboutBlankRecovery;
						}
						aboutBlankSessionMismatch = {
							activeUrl: "about:blank",
							recoveryApplied: appliedAboutBlankRecovery !== undefined,
							recoveryHint: buildAboutBlankRecoveryHint(),
							targetTitle: priorSessionTabTarget.title,
							targetUrl: priorSessionTabTarget.url,
						};
						currentSessionTabTarget = priorSessionTabTarget;
					}
					if (
						succeeded &&
						priorSessionTabTarget &&
						!sessionTabCorrection &&
						!aboutBlankSessionMismatch &&
						!commandExplicitlyTargetsAboutBlank(commandTokens) &&
						observedSessionTabTarget &&
						shouldCorrectSessionTabAfterCommand({
							command: executionPlan.commandInfo.command,
							sessionName: executionPlan.sessionName,
						})
					) {
						const postCommandTabCorrection = await collectSessionTabSelection({
							cwd: ctx.cwd,
							sessionName: executionPlan.sessionName,
							signal,
							target: observedSessionTabTarget,
						});
						if (postCommandTabCorrection) {
							const appliedPostCommandCorrection = await applyOpenResultTabCorrection({
								correction: postCommandTabCorrection,
								cwd: ctx.cwd,
								sessionName: executionPlan.sessionName,
								signal,
							});
							if (appliedPostCommandCorrection && !sessionTabCorrection) {
								sessionTabCorrection = appliedPostCommandCorrection;
							}
						}
					}
					if (executionPlan.sessionName) {
						const activeSessionTabTargetState = sessionTabTargets.get(executionPlan.sessionName);
						if (shouldApplySessionTabTargetUpdate({ current: activeSessionTabTargetState, updateOrder: tabTargetUpdateOrder })) {
							if (executionPlan.commandInfo.command === "close" && succeeded) {
								sessionTabTargets.delete(executionPlan.sessionName);
							} else if (currentSessionTabTarget) {
								sessionTabTargets.set(executionPlan.sessionName, { order: tabTargetUpdateOrder, target: currentSessionTabTarget });
							}
						}
					}

					const priorManagedSessionCwd = managedSessionCwd;
					const managedSessionState = resolveManagedSessionState({
						command: executionPlan.commandInfo.command,
						managedSessionName: executionPlan.managedSessionName,
						priorActive: managedSessionActive,
						priorSessionName: managedSessionName,
						succeeded,
					});
					const replacedManagedSessionName = managedSessionState.replacedSessionName;
					managedSessionActive = managedSessionState.active;
					managedSessionName = managedSessionState.sessionName;
					if (executionPlan.managedSessionName && succeeded) {
						managedSessionCwd = ctx.cwd;
					}
					if (replacedManagedSessionName) {
						sessionTabTargets.delete(replacedManagedSessionName);
						await closeManagedSession({
							cwd: priorManagedSessionCwd,
							sessionName: replacedManagedSessionName,
							timeoutMs: implicitSessionCloseTimeoutMs,
						});
					}

					const errorText = getAgentBrowserErrorText({
						aborted: processResult.aborted,
						command: executionPlan.commandInfo.command,
						effectiveArgs: redactedProcessArgs,
						envelope: presentationEnvelope,
						exitCode: processResult.exitCode,
						parseError,
						plainTextInspection,
						staleRefArgs: getStaleRefArgs(commandTokens, params.stdin),
						spawnError: processResult.spawnError,
						stderr: processResult.stderr,
						timedOut: processResult.timedOut,
						timeoutMs: processResult.timeoutMs,
						wrapperRecoveryHint: buildWrapperRecoveryHint({ pinnedBatchUnwrapMode, sessionTabCorrection }),
					});

					const presentation = plainTextInspection
						? {
							artifacts: undefined,
							batchFailure: undefined,
							batchSteps: undefined,
							content: [{ type: "text" as const, text: inspectionText ?? "" }],
							data: undefined,
							fullOutputPath: undefined,
							fullOutputPaths: undefined,
							imagePath: undefined,
							imagePaths: undefined,
							savedFile: undefined,
							savedFilePath: undefined,
							summary: `${redactedArgs.join(" ")} completed`,
						  }
						: await buildToolPresentation({
								args: redactedProcessArgs,
								artifactManifest,
								artifactRequest: screenshotArtifactRequest,
								batchArtifactRequests: batchScreenshotArtifactRequests,
								commandInfo: executionPlan.commandInfo,
								cwd: ctx.cwd,
								envelope: presentationEnvelope,
								errorText,
								persistentArtifactStore,
								sessionName: executionPlan.sessionName,
						  });
					if (parseFailureOutput.artifactManifest) {
						presentation.artifactManifest = parseFailureOutput.artifactManifest;
						presentation.artifactRetentionSummary = parseFailureOutput.artifactRetentionSummary;
					}
					if (parseFailureOutput.fullOutputPath || parseFailureOutput.fullOutputUnavailable) {
						const existingText = presentation.content[0]?.type === "text" ? presentation.content[0].text : "";
						const noticeLines = [
							parseFailureOutput.fullOutputPath
								? `Full output path: ${parseFailureOutput.fullOutputPath}`
								: `Full raw output unavailable: ${parseFailureOutput.fullOutputUnavailable}`,
							parseFailureOutput.artifactRetentionSummary,
						].filter((item): item is string => item !== undefined);
						const notice = noticeLines.join("\n");
						presentation.content[0] = {
							type: "text",
							text: existingText.length > 0 ? `${existingText}\n\n${notice}` : notice,
						};
					}
					if (presentation.artifactManifest) {
						artifactManifest = presentation.artifactManifest;
					}
					const warningText = aboutBlankSessionMismatch ? buildAboutBlankWarning(aboutBlankSessionMismatch) : undefined;
					const contentWithSessionWarnings = userRequestedJson && !plainTextInspection
						? buildJsonVisibleContent({
								error: presentationEnvelope?.error,
								presentation,
								succeeded,
								warnings: warningText ? [warningText] : undefined,
						  })
						: warningText
							? [...presentation.content]
							: presentation.content;
					if (warningText && !userRequestedJson) {
						if (contentWithSessionWarnings[0]?.type === "text") {
							contentWithSessionWarnings[0] = {
								...contentWithSessionWarnings[0],
								text: `${warningText}\n\n${contentWithSessionWarnings[0].text}`,
							};
						} else {
							contentWithSessionWarnings.unshift({ type: "text", text: warningText });
						}
					}
					const redactedContent = contentWithSessionWarnings.map((item) => {
						if (item.type !== "text") return item;
						const exactRedactedText = redactExactSensitiveText(item.text, exactSensitiveValues);
						return userRequestedJson && !plainTextInspection
							? { ...item, text: exactRedactedText }
							: { ...item, text: redactSensitiveText(exactRedactedText) };
					});
					const categoryDetails = buildAgentBrowserResultCategoryDetails({
						artifacts: presentation.artifacts,
						args: redactedProcessArgs,
						command: executionPlan.commandInfo.command,
						confirmationRequired: presentation.summary.startsWith("Confirmation required"),
						errorText: errorText ?? presentation.summary,
						failureCategory: presentation.failureCategory ?? presentation.batchFailure?.failedStep.failureCategory,
						inspection: plainTextInspection,
						parseError,
						savedFile: presentation.savedFile,
						spawnError: processResult.spawnError?.message,
						succeeded,
						tabDrift: !succeeded && (aboutBlankSessionMismatch !== undefined || sessionTabCorrection !== undefined),
						timedOut: processResult.timedOut,
						validationError: undefined,
					});
					let nextActions = presentation.nextActions ? [...presentation.nextActions] : undefined;
					if (categoryDetails.failureCategory === "stale-ref" && redactedCompiledSemanticAction) {
						(nextActions ??= []).push({
							id: "retry-semantic-action-after-stale-ref",
							params: { args: redactedCompiledSemanticAction.args },
							reason: "Retry the same semantic target via its compiled find command after the upstream stale-ref failure proves the prior action did not execute.",
							safety: "Use only for the same intended target; direct stale @refs still require a fresh snapshot or stable locator before retrying.",
							tool: "agent_browser" as const,
						});
					}
					const details = {
						args: redactedArgs,
						artifactManifest: presentation.artifactManifest,
						artifactRetentionSummary: presentation.artifactRetentionSummary,
						artifactVerification: presentation.artifactVerification,
						artifacts: presentation.artifacts,
						batchFailure: presentation.batchFailure,
						batchSteps: presentation.batchSteps,
						command: executionPlan.commandInfo.command,
						compiledSemanticAction: redactedCompiledSemanticAction,
						compatibilityWorkaround,
						subcommand: executionPlan.commandInfo.subcommand,
						data: presentation.data,
						error: plainTextInspection ? undefined : presentationEnvelope?.error,
						inspection: plainTextInspection || undefined,
						navigationSummary,
						...categoryDetails,
						aboutBlankSessionMismatch,
						openResultTabCorrection,
						effectiveArgs: redactedProcessArgs,
						exitCode: processResult.exitCode,
						fullOutputPath: parseFailureOutput.fullOutputPath ?? presentation.fullOutputPath,
						fullOutputPaths: presentation.fullOutputPaths,
						fullOutputUnavailable: parseFailureOutput.fullOutputUnavailable,
						imagePath: presentation.imagePath,
						imagePaths: presentation.imagePaths,
						nextActions,
						pageChangeSummary: presentation.pageChangeSummary,
						parseError: plainTextInspection ? undefined : parseError,
						savedFile: presentation.savedFile,
						savedFilePath: presentation.savedFilePath,
						sessionMode,
						sessionTabCorrection,
						sessionTabTarget: currentSessionTabTarget,
						...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						sessionRecoveryHint: redactedRecoveryHint,
						startupScopedFlags: executionPlan.startupScopedFlags,
						stderr: processResult.stderr,
						stdout: plainTextInspection ? inspectionText ?? "" : parseSucceeded ? undefined : processResult.stdout,
						summary: presentation.summary,
						timedOut: processResult.timedOut || undefined,
						timeoutMs: processResult.timeoutMs,
					};

					return {
						content: redactedContent,
						details: redactToolDetails(details, exactSensitiveValues),
						isError: !succeeded,
					};
				} finally {
					if (processResult.stdoutSpillPath) {
						await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
					}
				}
			};

			return extractExplicitSessionName(toolArgs)
				? runTool()
				: managedSessionExecutionQueue.run(runTool);
		},
	});
}
