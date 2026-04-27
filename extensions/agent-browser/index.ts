/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage extension-owned browser session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest in this package, or explicitly via `pi --no-extensions -e .` during local checkout development.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import { rm } from "node:fs/promises";

import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { runAgentBrowserProcess } from "./lib/process.js";
import {
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
import { cleanupSecureTempArtifacts, type PersistentSessionArtifactStore } from "./lib/temp.js";

const DEFAULT_SESSION_MODE = "auto" as const;

const AGENT_BROWSER_PARAMS = Type.Object({
	args: Type.Array(Type.String({ description: "Exact agent-browser CLI arguments, excluding the binary name." }), {
		description: "Exact agent-browser CLI arguments, excluding the binary name and any shell operators.",
		minItems: 1,
	}),
	stdin: Type.Optional(Type.String({ description: "Optional raw stdin content for commands like eval --stdin or batch." })),
	sessionMode: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("fresh")], {
			description:
				"Session handling mode. `auto` reuses the extension-managed pi-scoped session when possible. `fresh` switches that managed session to a fresh upstream launch so launch-scoped flags like --profile, --session-name, --cdp, --state, or --auto-connect apply and later auto calls follow the new browser.",
			default: DEFAULT_SESSION_MODE,
		}),
	),
});
const PROJECT_RULE_PROMPT =
	"Project rule: when browser automation is needed, prefer the native `agent_browser` tool. Do not run direct `agent-browser` bash commands unless the user explicitly asks for a bash-oriented workflow or browser-integration debugging.";
const QUICK_START_GUIDELINES = [
	"Quick start mental model: args are the exact agent-browser CLI args after the binary; stdin is only for batch and eval --stdin; sessionMode=fresh switches the extension-managed session to a fresh upstream launch when you need new --profile, --session-name, --cdp, --state, or --auto-connect state.",
	"Common first calls: { args: [\"open\", \"https://example.com\"] } then { args: [\"snapshot\", \"-i\"] }; after navigation, use { args: [\"click\", \"@e2\"] } then { args: [\"snapshot\", \"-i\"] }.",
	"Common advanced calls: { args: [\"batch\"], stdin: \"[[\\\"open\\\",\\\"https://example.com\\\"],[\\\"snapshot\\\",\\\"-i\\\"]]\" }, { args: [\"eval\", \"--stdin\"], stdin: \"document.title\" }, and { args: [\"--profile\", \"Default\", \"open\", \"https://example.com/account\"], sessionMode: \"fresh\" }.",
	"High-value command reference: download <selector> <path> saves a file triggered by a click; get title/url/text/html/value/attr/count reads page state; screenshot [path] captures an image; pdf <path> saves a PDF; tab list and tab <tab-id-or-label> inspect or recover the active tab.",
] as const;
const BRAVE_SEARCH_PROMPT_GUIDELINE =
	"When a non-empty BRAVE_API_KEY is available in the current environment, prefer the Brave Search API via bash/curl to discover specific destination URLs, then open the chosen URL with agent_browser instead of browsing a search engine results page just to find the target.";
const SHARED_BROWSER_PLAYBOOK_GUIDELINES = [
	"Standard workflow: open the page, snapshot -i, interact using refs, and re-snapshot after navigation or major DOM changes.",
	"For authenticated or user-specific content like feeds, inboxes, dashboards, and accounts, prefer --profile Default on the first browser call and let the implicit session carry continuity. Use --auto-connect only if profile-based reuse is unavailable or the task is specifically about attaching to a running debug-enabled browser.",
	"Do not invent fixed explicit session names for routine tasks. Use the implicit session unless you truly need multiple isolated browser sessions in the same conversation.",
	"When using --profile, --session-name, --cdp, --state, or --auto-connect, put them on the first command for that session. If you intentionally use an explicit --session, keep using that same explicit session for follow-ups.",
	"If you already used the implicit session and now need launch-scoped flags like --profile, --session-name, --cdp, --state, or --auto-connect, retry with sessionMode set to fresh or pass an explicit --session for the new launch. After a successful unnamed fresh launch, later auto calls follow that new session.",
	"If a session lands on the wrong page or tab, an interaction changes origin unexpectedly, or an open call returns blocked, blank, or otherwise unexpected results, use tab list / tab <tab-id-or-label> / snapshot -i to recover state before retrying different URLs or fallback strategies. Only use wait with an explicit argument like milliseconds, --load <state>, --url <matcher>, --fn <js>, or --text <matcher>.",
	"For feed, timeline, or inbox reading tasks, focus on the main timeline/list region and read the first item there rather than unrelated composer or sidebar content.",
	"For read-only browsing tasks, prefer extracting the answer from the current snapshot, structured ref labels, or eval --stdin on the current page before navigating away. Only click into media viewers, detail routes, or new pages when the current view does not contain the needed information.",
	"For downloads, prefer download <selector> <path> when an element click should save a file. Do not rely on click alone when you need the downloaded file on disk.",
	"When using eval --stdin, scope checks and actions to the target element or route whenever possible instead of relying on broad page-wide text heuristics.",
	"When using eval --stdin for extraction, return the value you want instead of relying on console.log as the primary result channel.",
	"Do not call --help or other exploratory inspection commands unless the user explicitly asks for them or debugging the browser integration is necessary.",
] as const;
const TOOL_PROMPT_GUIDELINES_PREFIX = ["Use this tool whenever the task requires a real browser or live web content."] as const;
const TOOL_PROMPT_GUIDELINES_SUFFIX = [
	"Prefer this tool over bash for opening sites, reading docs on the web, clicking, filling, screenshots, eval, and batch workflows.",
	"Do not fall back to osascript, AppleScript, or generic browser-driving bash commands when this tool can do the job.",
	"Pass exact agent-browser CLI arguments in args, excluding the binary name.",
	"Use stdin for commands like eval --stdin and batch instead of shell heredocs.",
	"Let the extension-managed session handle the common path unless you explicitly need a fresh launch for upstream flags like --profile, --session-name, --cdp, --state, or --auto-connect.",
	"Use sessionMode=fresh when switching from an existing implicit session to a new profile/debug launch without inventing a fixed explicit session name; later auto calls will follow that new session.",
] as const;

function buildMissingBinaryMessage(): string {
	return [
		"agent-browser is required but was not found on PATH.",
		"This project does not bundle agent-browser.",
		"Install it using the upstream docs:",
		"- https://agent-browser.dev/",
		"- https://github.com/vercel-labs/agent-browser",
	].join("\n");
}

function buildInvocationPreview(effectiveArgs: string[]): string {
	const preview = effectiveArgs.join(" ");
	return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
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

const NAVIGATION_SUMMARY_COMMANDS = new Set(["back", "click", "dblclick", "forward", "reload"]);

interface NavigationSummary {
	title?: string;
	url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

interface PinnedBatchPlan {
	includeNavigationSummary: boolean;
	steps: unknown[];
	unwrapMode: PinnedBatchUnwrapMode;
}

interface SessionTabTarget {
	title?: string;
	url: string;
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
			pendingTitle = undefined;
		}
	}
	return currentTarget;
}

function restoreSessionTabTargetsFromBranch(branch: unknown[]): Map<string, SessionTabTarget> {
	const restoredTargets = new Map<string, SessionTabTarget>();
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
			restoredTargets.set(sessionName, sessionTabTarget);
		}
	}
	return restoredTargets;
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

function parseUserBatchStdin(stdin: string | undefined): { error?: string; steps?: unknown[] } {
	if (stdin === undefined) {
		return { steps: [] };
	}
	try {
		const parsed = JSON.parse(stdin) as unknown;
		if (!Array.isArray(parsed)) {
			return { error: "agent_browser batch stdin must be a JSON array of command steps." };
		}
		return { steps: parsed };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `agent_browser batch stdin could not be parsed as JSON: ${message}` };
	}
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
		return {
			includeNavigationSummary: false,
			steps: [["tab", options.selectedTab], ...(parsed.steps ?? [])],
			unwrapMode: "user-batch",
		};
	}
	if (options.commandTokens.length === 0) {
		return undefined;
	}
	const includeNavigationSummary = options.command !== undefined && NAVIGATION_SUMMARY_COMMANDS.has(options.command);
	return {
		includeNavigationSummary,
		steps: [
			["tab", options.selectedTab],
			options.commandTokens,
			...(includeNavigationSummary ? [["get", "title"], ["get", "url"]] : []),
		],
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
	if (processResult.aborted || processResult.spawnError || processResult.exitCode !== 0) {
		return undefined;
	}
	const parsed = await parseAgentBrowserEnvelope({
		stdout: processResult.stdout,
		stdoutPath: processResult.stdoutSpillPath,
	});
	try {
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

function buildSharedBrowserPlaybookGuidelines(hasBraveApiKey: boolean): string[] {
	return [
		SHARED_BROWSER_PLAYBOOK_GUIDELINES[0],
		...(hasBraveApiKey ? [BRAVE_SEARCH_PROMPT_GUIDELINE] : []),
		...SHARED_BROWSER_PLAYBOOK_GUIDELINES.slice(1),
	];
}

function buildToolPromptGuidelines(hasBraveApiKey: boolean): string[] {
	return [
		...TOOL_PROMPT_GUIDELINES_PREFIX,
		...QUICK_START_GUIDELINES,
		...buildSharedBrowserPlaybookGuidelines(hasBraveApiKey),
		...TOOL_PROMPT_GUIDELINES_SUFFIX,
	];
}

function buildSessionDetailFields(sessionName: string | undefined, usedImplicitSession: boolean): Record<string, unknown> {
	return sessionName ? { sessionName, usedImplicitSession } : {};
}

function getPersistentSessionArtifactStore(ctx: {
	sessionManager: {
		getSessionDir?: () => string;
		getSessionFile?: () => string | undefined;
		getSessionId: () => string | undefined;
	};
}): PersistentSessionArtifactStore | undefined {
	const sessionFile = typeof ctx.sessionManager.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
	const sessionDir = typeof ctx.sessionManager.getSessionDir === "function" ? ctx.sessionManager.getSessionDir() : undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionFile || !sessionDir || !sessionId) {
		return undefined;
	}
	return { sessionDir, sessionId };
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

async function closeManagedSession(options: { cwd: string; sessionName: string; timeoutMs: number }): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		await runAgentBrowserProcess({
			args: ["--session", options.sessionName, "close"],
			cwd: options.cwd,
			signal: controller.signal,
		});
	} catch {
		// Best-effort cleanup only.
	} finally {
		clearTimeout(timer);
	}
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	const ephemeralSessionSeed = createEphemeralSessionSeed();
	const hasBraveApiKey = hasUsableBraveApiKey();
	const toolPromptGuidelines = buildToolPromptGuidelines(hasBraveApiKey);
	const implicitSessionIdleTimeoutMs = getImplicitSessionIdleTimeoutMs();
	const implicitSessionCloseTimeoutMs = getImplicitSessionCloseTimeoutMs();
	let managedSessionActive = false;
	let managedSessionBaseName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);
	let managedSessionName = managedSessionBaseName;
	let managedSessionCwd = process.cwd();
	let freshSessionOrdinal = 0;
	let sessionTabTargets = new Map<string, SessionTabTarget>();

	pi.on("session_start", async (_event, ctx) => {
		managedSessionBaseName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
		const restoredState = restoreManagedSessionStateFromBranch(ctx.sessionManager.getBranch(), managedSessionBaseName);
		managedSessionActive = restoredState.active;
		managedSessionName = restoredState.sessionName;
		managedSessionCwd = ctx.cwd;
		freshSessionOrdinal = restoredState.freshSessionOrdinal;
		sessionTabTargets = restoreSessionTabTargetsFromBranch(ctx.sessionManager.getBranch());
	});

	pi.on("session_shutdown", async () => {
		managedSessionActive = false;
		sessionTabTargets = new Map<string, SessionTabTarget>();
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
			!isHarmlessAgentBrowserInspectionCommand(event.input.command)
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
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const redactedArgs = redactInvocationArgs(params.args);
			const validationError = validateToolArgs(params.args);
			if (validationError) {
				return {
					content: [{ type: "text", text: validationError }],
					details: { args: redactedArgs, validationError },
					isError: true,
				};
			}

			const sessionMode = params.sessionMode ?? DEFAULT_SESSION_MODE;
			const freshSessionName = createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal + 1);
			const executionPlan = buildExecutionPlan(params.args, {
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
						validationError: executionPlan.validationError,
					},
					isError: true,
				};
			}

			const priorSessionTabTarget = executionPlan.sessionName ? sessionTabTargets.get(executionPlan.sessionName) : undefined;
			const commandTokens = extractCommandTokens(params.args);
			let pinnedBatchUnwrapMode: PinnedBatchUnwrapMode | undefined;
			let includePinnedNavigationSummary = false;
			let sessionTabCorrection: OpenResultTabCorrection | undefined;
			let processArgs = executionPlan.effectiveArgs;
			let processStdin = params.stdin;
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
						spawnError: processResult.spawnError.message,
					},
					isError: true,
				};
			}

			try {
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
				const processSucceeded = !processResult.aborted && !processResult.spawnError && processResult.exitCode === 0;
				const plainTextInspection = executionPlan.plainTextInspection && processSucceeded;
				const parseSucceeded = plainTextInspection || parseError === undefined;
				const envelopeSuccess = plainTextInspection ? true : presentationEnvelope?.success !== false;
				const succeeded = processSucceeded && parseSucceeded && envelopeSuccess;
				const inspectionText = plainTextInspection ? processResult.stdout.trim() : undefined;

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
					hasLaunchScopedTabCorrectionFlag(params.args) &&
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
				const currentSessionTabTarget = deriveSessionTabTarget({
					command: executionPlan.commandInfo.command,
					data: presentationEnvelope?.data,
					navigationSummary,
					previousTarget: priorSessionTabTarget,
				});
				if (
					succeeded &&
					priorSessionTabTarget &&
					!sessionTabCorrection &&
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
					if (executionPlan.commandInfo.command === "close" && succeeded) {
						sessionTabTargets.delete(executionPlan.sessionName);
					} else if (currentSessionTabTarget) {
						sessionTabTargets.set(executionPlan.sessionName, currentSessionTabTarget);
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
					envelope: presentationEnvelope,
					exitCode: processResult.exitCode,
					parseError,
					plainTextInspection,
					spawnError: processResult.spawnError,
					stderr: processResult.stderr,
				});

				const presentation = plainTextInspection
					? {
						batchFailure: undefined,
						batchSteps: undefined,
						content: [{ type: "text" as const, text: inspectionText ?? "" }],
						data: undefined,
						fullOutputPath: undefined,
						fullOutputPaths: undefined,
						imagePath: undefined,
						imagePaths: undefined,
						summary: `${redactedArgs.join(" ")} completed`,
					  }
					: await buildToolPresentation({
							commandInfo: executionPlan.commandInfo,
							cwd: ctx.cwd,
							envelope: presentationEnvelope,
							errorText,
							persistentArtifactStore: getPersistentSessionArtifactStore(ctx),
					  });
				const redactedContent = presentation.content.map((item) =>
					item.type === "text" ? { ...item, text: redactSensitiveText(item.text) } : item,
				);

				return {
					content: redactedContent,
					details: {
						args: redactedArgs,
						batchFailure: redactSensitiveValue(presentation.batchFailure),
						batchSteps: redactSensitiveValue(presentation.batchSteps),
						command: executionPlan.commandInfo.command,
						compatibilityWorkaround,
						subcommand: executionPlan.commandInfo.subcommand,
						data: redactSensitiveValue(presentation.data),
						error: plainTextInspection ? undefined : redactSensitiveValue(presentationEnvelope?.error),
						inspection: plainTextInspection || undefined,
						navigationSummary: redactSensitiveValue(navigationSummary),
						openResultTabCorrection: redactSensitiveValue(openResultTabCorrection),
						effectiveArgs: redactedProcessArgs,
						exitCode: processResult.exitCode,
						fullOutputPath: presentation.fullOutputPath,
						fullOutputPaths: presentation.fullOutputPaths,
						imagePath: presentation.imagePath,
						imagePaths: presentation.imagePaths,
						parseError: plainTextInspection ? undefined : parseError,
						sessionMode,
						sessionTabCorrection: redactSensitiveValue(sessionTabCorrection),
						sessionTabTarget: redactSensitiveValue(currentSessionTabTarget),
						...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						sessionRecoveryHint: redactedRecoveryHint,
						startupScopedFlags: executionPlan.startupScopedFlags,
						stderr: processResult.stderr ? redactSensitiveText(processResult.stderr) : undefined,
						stdout: plainTextInspection
							? redactSensitiveText(inspectionText ?? "")
							: parseSucceeded
								? undefined
								: redactSensitiveText(processResult.stdout),
						summary: redactSensitiveText(presentation.summary),
					},
					isError: !succeeded,
				};
			} finally {
				if (processResult.stdoutSpillPath) {
					await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
				}
			}
		},
	});
}
