/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage extension-owned browser session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest in this package, or explicitly via `pi --no-extensions -e .` during local checkout development.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import { readFile, rm } from "node:fs/promises";

import { isToolCallEventType, type AgentToolResult, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import {
	PROJECT_RULE_PROMPT,
	buildToolPromptGuidelines,
} from "./lib/playbook.js";
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
	type PersistentSessionArtifactStore,
	writePersistentSessionArtifactFile,
	writeSecureTempFile,
} from "./lib/temp.js";

const DEFAULT_SESSION_MODE = "auto" as const;

const AGENT_BROWSER_PARAMS = Type.Object({
	args: Type.Array(Type.String({ description: "Exact agent-browser CLI arguments, excluding the binary name." }), {
		description: "Exact agent-browser CLI arguments, excluding the binary name and any shell operators.",
		minItems: 1,
	}),
	stdin: Type.Optional(Type.String({ description: "Optional raw stdin content; only supported for batch and eval --stdin." })),
	sessionMode: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("fresh")], {
			description:
				"Session handling mode. `auto` reuses the extension-managed pi-scoped session when possible. `fresh` switches that managed session to a fresh upstream launch so launch-scoped flags like --profile, --session-name, --cdp, --state, or --auto-connect apply and later auto calls follow the new browser.",
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
	const commandLabel = options.command ? `\`${options.command}\`` : "the requested command";
	return `agent_browser stdin is only supported for \`batch\` and \`eval --stdin\`; remove stdin from ${commandLabel} or use one of those command forms.`;
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

async function preserveParseFailureOutput(options: {
	persistentArtifactStore?: PersistentSessionArtifactStore;
	stdoutSpillPath?: string;
}): Promise<{ fullOutputPath?: string; fullOutputUnavailable?: string }> {
	if (!options.stdoutSpillPath) {
		return {};
	}

	try {
		const rawOutput = await readFile(options.stdoutSpillPath);
		const fullOutputPath = options.persistentArtifactStore
			? await writePersistentSessionArtifactFile({
					content: rawOutput,
					prefix: "pi-agent-browser-parse-failure-output",
					store: options.persistentArtifactStore,
					suffix: ".txt",
				})
			: await writeSecureTempFile({
					content: rawOutput,
					prefix: "pi-agent-browser-parse-failure-output",
					suffix: ".txt",
				});
		return { fullOutputPath };
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
	const implicitSessionIdleTimeoutMs = getImplicitSessionIdleTimeoutMs();
	const implicitSessionCloseTimeoutMs = getImplicitSessionCloseTimeoutMs();
	let managedSessionActive = false;
	let managedSessionBaseName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);
	let managedSessionName = managedSessionBaseName;
	let managedSessionCwd = process.cwd();
	let freshSessionOrdinal = 0;
	let sessionTabTargets = new Map<string, OrderedSessionTabTarget>();
	let sessionTabTargetUpdateOrder = 0;
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
	});

	pi.on("session_shutdown", async () => {
		managedSessionActive = false;
		sessionTabTargets = new Map<string, OrderedSessionTabTarget>();
		sessionTabTargetUpdateOrder = 0;
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

			const tabTargetUpdateOrder = ++sessionTabTargetUpdateOrder;
			const runTool = async (): Promise<AgentBrowserToolResult> => {
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

				const commandTokens = extractCommandTokens(params.args);
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
							validationError: stdinValidationError,
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
					const parseFailureOutput = parseError
						? await preserveParseFailureOutput({
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
						spawnError: processResult.spawnError,
						stderr: processResult.stderr,
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
								commandInfo: executionPlan.commandInfo,
								cwd: ctx.cwd,
								envelope: presentationEnvelope,
								errorText,
								persistentArtifactStore,
						  });
					if (parseFailureOutput.fullOutputPath || parseFailureOutput.fullOutputUnavailable) {
						const existingText = presentation.content[0]?.type === "text" ? presentation.content[0].text : "";
						const notice = parseFailureOutput.fullOutputPath
							? `Full output path: ${parseFailureOutput.fullOutputPath}`
							: `Full raw output unavailable: ${parseFailureOutput.fullOutputUnavailable}`;
						presentation.content[0] = {
							type: "text",
							text: existingText.length > 0 ? `${existingText}\n\n${notice}` : notice,
						};
					}
					const redactedContent = presentation.content.map((item) =>
						item.type === "text" ? { ...item, text: redactSensitiveText(item.text) } : item,
					);

					return {
						content: redactedContent,
						details: {
							args: redactedArgs,
							artifacts: redactSensitiveValue(presentation.artifacts),
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
							fullOutputPath: parseFailureOutput.fullOutputPath ?? presentation.fullOutputPath,
							fullOutputPaths: presentation.fullOutputPaths,
							fullOutputUnavailable: parseFailureOutput.fullOutputUnavailable,
							imagePath: presentation.imagePath,
							imagePaths: presentation.imagePaths,
							parseError: plainTextInspection ? undefined : parseError,
							savedFile: redactSensitiveValue(presentation.savedFile),
							savedFilePath: presentation.savedFilePath ? redactSensitiveText(presentation.savedFilePath) : undefined,
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
			};

			return extractExplicitSessionName(params.args)
				? runTool()
				: managedSessionExecutionQueue.run(runTool);
		},
	});
}
