/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage extension-owned browser session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest in this package, or explicitly via `pi --no-extensions -e .` during local checkout development.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
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
	type AgentBrowserNextAction,
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
	type SessionArtifactManifest,
	buildEvictedSessionArtifactEntries,
	formatSessionArtifactRetentionSummary,
	isSessionArtifactManifest,
	mergeSessionArtifactManifest,
	summarizeNetworkFailures,
} from "./lib/results/shared.js";

const DEFAULT_SESSION_MODE = "auto" as const;
const DIRECT_AGENT_BROWSER_BASH_BYPASS_ENV = "PI_AGENT_BROWSER_ALLOW_DIRECT_BASH";
const PACKAGE_NAME = "pi-agent-browser-native";

const AGENT_BROWSER_SEMANTIC_ACTIONS = ["check", "click", "fill", "select", "uncheck"] as const;
const AGENT_BROWSER_SEMANTIC_LOCATORS = ["alt", "label", "placeholder", "role", "testid", "text", "title"] as const;
const AGENT_BROWSER_JOB_STEP_ACTIONS = ["open", "click", "fill", "wait", "assertText", "assertUrl", "waitForDownload", "screenshot"] as const;
const SOURCE_LOOKUP_WORKSPACE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SOURCE_LOOKUP_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "out", "tmp", "temp"]);
const SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES = 2_000;
const SOURCE_LOOKUP_MAX_WORKSPACE_FILES = 5_000;

type AgentBrowserSemanticActionName = (typeof AGENT_BROWSER_SEMANTIC_ACTIONS)[number];
type AgentBrowserSemanticLocator = (typeof AGENT_BROWSER_SEMANTIC_LOCATORS)[number];
type AgentBrowserJobStepAction = (typeof AGENT_BROWSER_JOB_STEP_ACTIONS)[number];
type AgentBrowserSourceLookupStatus = "candidates-found" | "no-candidates" | "unsupported";
type AgentBrowserNetworkSourceLookupStatus = "failed-requests-found" | "no-failed-requests" | "no-candidates";

interface AgentBrowserSemanticActionInput {
	action: AgentBrowserSemanticActionName;
	locator: AgentBrowserSemanticLocator;
	value: string;
	text?: string;
	role?: string;
	name?: string;
	session?: string;
}

interface CompiledAgentBrowserSemanticAction {
	action: AgentBrowserSemanticActionName;
	locator: AgentBrowserSemanticLocator;
	args: string[];
}

interface CompiledAgentBrowserJobStep {
	action: AgentBrowserJobStepAction;
	args: string[];
}

interface CompiledAgentBrowserJob {
	args: string[];
	stdin: string;
	steps: CompiledAgentBrowserJobStep[];
}

interface CompiledAgentBrowserQaPreset extends CompiledAgentBrowserJob {
	checks: {
		checkConsole: boolean;
		checkErrors: boolean;
		checkNetwork: boolean;
		expectedText: string[];
		expectedSelector?: string;
		screenshotPath?: string;
		url: string;
	};
}

interface CompiledAgentBrowserSourceLookupStep {
	action: "dom" | "react";
	args: string[];
}

interface CompiledAgentBrowserSourceLookup {
	args: string[];
	stdin: string;
	steps: CompiledAgentBrowserSourceLookupStep[];
	query: {
		componentName?: string;
		includeDomHints: boolean;
		maxWorkspaceFiles: number;
		reactFiberId?: string;
		selector?: string;
	};
}

interface AgentBrowserSourceLookupCandidate {
	column?: number;
	componentName?: string;
	confidence: "high" | "medium" | "low";
	evidence: string[];
	file?: string;
	line?: number;
	source: "react-inspect" | "dom-attribute" | "workspace-search";
}

interface AgentBrowserSourceLookupAnalysis {
	candidates: AgentBrowserSourceLookupCandidate[];
	limitations: string[];
	status: AgentBrowserSourceLookupStatus;
	summary: string;
}

interface CompiledAgentBrowserNetworkSourceLookup {
	args: string[];
	stdin: string;
	steps: Array<{ action: "network"; args: string[] }>;
	query: {
		filter?: string;
		maxWorkspaceFiles: number;
		requestId?: string;
		url?: string;
	};
}

interface AgentBrowserNetworkSourceLookupRequest {
	error?: string;
	method?: string;
	requestId?: string;
	status?: number;
	url?: string;
}

interface AgentBrowserNetworkSourceLookupCandidate {
	confidence: "high" | "medium" | "low";
	evidence: string[];
	file?: string;
	line?: number;
	requestUrl?: string;
	source: "initiator" | "workspace-search";
}

interface AgentBrowserNetworkSourceLookupAnalysis {
	candidates: AgentBrowserNetworkSourceLookupCandidate[];
	failedRequests: AgentBrowserNetworkSourceLookupRequest[];
	limitations: string[];
	status: AgentBrowserNetworkSourceLookupStatus;
	summary: string;
}

const AGENT_BROWSER_PARAMS = Type.Object({

	args: Type.Optional(
		Type.Array(Type.String({ description: "Exact agent-browser CLI arguments, excluding the binary name." }), {
			description: "Exact agent-browser CLI arguments, excluding the binary name and any shell operators. Required unless semanticAction, job, qa, sourceLookup, or networkSourceLookup is provided.",
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
			session: Type.Optional(Type.String({ description: "Optional upstream session name; prepends --session <name> before the compiled find command." })),
		}),
	),
	qa: Type.Optional(
		Type.Object({
			url: Type.String({ description: "URL to open for a lightweight QA preset." }),
			expectedText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Text that must appear on the page." })),
			expectedSelector: Type.Optional(Type.String({ description: "Selector or @ref that must appear on the page." })),
			screenshotPath: Type.Optional(Type.String({ description: "Optional evidence screenshot path captured at the end of the QA preset." })),
			checkConsole: Type.Optional(Type.Boolean({ description: "Whether to fail on console error messages. Defaults to true." })),
			checkErrors: Type.Optional(Type.Boolean({ description: "Whether to fail on page errors. Defaults to true." })),
			checkNetwork: Type.Optional(Type.Boolean({ description: "Whether to inspect network requests and fail on actionable request failures; benign icon misses warn. Defaults to true." })),
		}),
	),
	sourceLookup: Type.Optional(
		Type.Object({
			selector: Type.Optional(Type.String({ description: "Visible selector or @ref whose DOM metadata should be inspected for source hints." })),
			reactFiberId: Type.Optional(Type.String({ description: "React fiber id to inspect with upstream react inspect. Requires a session opened with --enable react-devtools." })),
			componentName: Type.Optional(Type.String({ description: "Component name to correlate with react tree output and bounded local workspace search." })),
			includeDomHints: Type.Optional(Type.Boolean({ description: "Whether selector lookups should inspect DOM HTML attributes for source-like metadata. Defaults to true." })),
			maxWorkspaceFiles: Type.Optional(Type.Number({ description: "Maximum local source files to scan when componentName is provided. Defaults to 2000 and cannot exceed 5000.", minimum: 1, maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES })),
		}),
	),
	networkSourceLookup: Type.Optional(
		Type.Object({
			filter: Type.Optional(Type.String({ description: "Optional upstream network requests filter pattern." })),
			requestId: Type.Optional(Type.String({ description: "Optional network request id to inspect with network request <id>." })),
			url: Type.Optional(Type.String({ description: "Optional failed request URL or URL fragment to correlate with local source." })),
			maxWorkspaceFiles: Type.Optional(Type.Number({ description: "Maximum local source files to scan for URL literals. Defaults to 2000 and cannot exceed 5000.", minimum: 1, maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES })),
		}),
	),
	job: Type.Optional(
		Type.Object({
			steps: Type.Array(
				Type.Object({
					action: StringEnum(AGENT_BROWSER_JOB_STEP_ACTIONS, {
						description: "Constrained one-call job step compiled to existing upstream batch commands.",
					}),
					url: Type.Optional(Type.String({ description: "URL for open steps, or URL pattern for assertUrl steps." })),
					selector: Type.Optional(Type.String({ description: "Selector or @ref for click/fill/get-like steps." })),
					text: Type.Optional(Type.String({ description: "Text for fill steps or visible text for assertText steps." })),
					path: Type.Optional(Type.String({ description: "Artifact/download path for waitForDownload or screenshot steps." })),
					milliseconds: Type.Optional(Type.Number({ description: "Milliseconds for wait steps." })),
				}),
				{ minItems: 1 },
			),
		}),
	),
	stdin: Type.Optional(Type.String({ description: "Optional raw stdin content; only supported for batch, eval --stdin, auth save --password-stdin, and is generated internally by job, qa, sourceLookup, or networkSourceLookup mode." })),
	sessionMode: Type.Optional(
		StringEnum(["auto", "fresh"] as const, {
			description:
				"Session handling mode. `auto` reuses the extension-managed pi-scoped session when possible. `fresh` switches that managed session to a fresh upstream launch so launch-scoped flags like --profile, --session-name, --cdp, --state, --auto-connect, --init-script, --enable, -p/--provider, or iOS --device apply and later auto calls follow the new browser.",
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

function getRequiredJobString(step: Record<string, unknown>, field: "path" | "selector" | "text" | "url", action: AgentBrowserJobStepAction): { value?: string; error?: string } {
	const value = step[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		return { error: `job step ${action} requires a non-empty ${field} string.` };
	}
	return { value };
}

function compileAgentBrowserJob(input: unknown): { compiled?: CompiledAgentBrowserJob; error?: string } {
	if (!isRecord(input)) {
		return { error: "job must be an object." };
	}
	const rawSteps = input.steps;
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		return { error: "job.steps must be a non-empty array." };
	}
	const steps: CompiledAgentBrowserJobStep[] = [];
	for (const [index, rawStep] of rawSteps.entries()) {
		if (!isRecord(rawStep)) {
			return { error: `job.steps[${index}] must be an object.` };
		}
		const action = rawStep.action;
		if (typeof action !== "string" || !AGENT_BROWSER_JOB_STEP_ACTIONS.includes(action as AgentBrowserJobStepAction)) {
			return { error: `job.steps[${index}].action must be one of: ${AGENT_BROWSER_JOB_STEP_ACTIONS.join(", ")}.` };
		}
		const jobAction = action as AgentBrowserJobStepAction;
		let args: string[];
		if (jobAction === "open") {
			const result = getRequiredJobString(rawStep, "url", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["open", result.value as string];
		} else if (jobAction === "click") {
			const result = getRequiredJobString(rawStep, "selector", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["click", result.value as string];
		} else if (jobAction === "fill") {
			const selector = getRequiredJobString(rawStep, "selector", jobAction);
			if (selector.error) return { error: `job.steps[${index}]: ${selector.error}` };
			const text = getRequiredJobString(rawStep, "text", jobAction);
			if (text.error) return { error: `job.steps[${index}]: ${text.error}` };
			args = ["fill", selector.value as string, text.value as string];
		} else if (jobAction === "wait") {
			const milliseconds = rawStep.milliseconds;
			if (typeof milliseconds !== "number" || !Number.isInteger(milliseconds) || milliseconds <= 0) {
				return { error: `job.steps[${index}]: job step wait requires a positive integer milliseconds value.` };
			}
			args = ["wait", String(milliseconds)];
		} else if (jobAction === "assertText") {
			const result = getRequiredJobString(rawStep, "text", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["wait", "--text", result.value as string];
		} else if (jobAction === "assertUrl") {
			const result = getRequiredJobString(rawStep, "url", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["wait", "--url", result.value as string];
		} else if (jobAction === "waitForDownload") {
			const result = getRequiredJobString(rawStep, "path", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["wait", "--download", result.value as string];
		} else {
			const result = getRequiredJobString(rawStep, "path", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["screenshot", result.value as string];
		}
		steps.push({ action: jobAction, args });
	}
	return { compiled: { args: ["batch"], stdin: JSON.stringify(steps.map((step) => step.args)), steps } };
}

interface AgentBrowserQaPresetAnalysis {
	failedChecks: string[];
	passed: boolean;
	summary: string;
	warnings: string[];
}

function getBatchResultItems(data: unknown): Array<Record<string, unknown>> {
	return Array.isArray(data) ? data.filter(isRecord) : [];
}

function getCommandNameFromBatchItem(item: Record<string, unknown>): string | undefined {
	const command = item.command;
	return Array.isArray(command) && typeof command[0] === "string" ? command[0] : undefined;
}

function analyzeQaPresetResults(data: unknown): AgentBrowserQaPresetAnalysis | undefined {
	const items = getBatchResultItems(data);
	if (items.length === 0) return undefined;
	const failedChecks: string[] = [];
	const warnings: string[] = [];
	for (const item of items) {
		if (item.success === false) {
			failedChecks.push(`${getCommandNameFromBatchItem(item) ?? "step"} failed`);
		}
		const result = isRecord(item.result) ? item.result : undefined;
		const commandName = getCommandNameFromBatchItem(item);
		if (commandName === "errors" && Array.isArray(result?.errors) && result.errors.length > 0) {
			failedChecks.push(`${result.errors.length} page error(s)`);
		}
		if (commandName === "console" && Array.isArray(result?.messages)) {
			const errorCount = result.messages.filter((message) => isRecord(message) && /error/i.test(String(message.type ?? message.level ?? ""))).length;
			if (errorCount > 0) failedChecks.push(`${errorCount} console error message(s)`);
		}
		if (commandName === "network" && Array.isArray(result?.requests)) {
			const networkFailures = summarizeNetworkFailures(result.requests);
			if (networkFailures.actionableCount > 0) failedChecks.push(`${networkFailures.actionableCount} actionable failed network request(s)`);
			if (networkFailures.benignCount > 0) warnings.push(`${networkFailures.benignCount} benign network request failure(s) ignored`);
		}
	}
	const uniqueFailures = [...new Set(failedChecks)];
	const uniqueWarnings = [...new Set(warnings)];
	return {
		failedChecks: uniqueFailures,
		passed: uniqueFailures.length === 0,
		summary: uniqueFailures.length === 0
			? uniqueWarnings.length === 0 ? "QA preset passed." : `QA preset passed with warnings: ${uniqueWarnings.join("; ")}.`
			: `QA preset failed: ${uniqueFailures.join("; ")}.`,
		warnings: uniqueWarnings,
	};
}

function compileAgentBrowserQaPreset(input: unknown): { compiled?: CompiledAgentBrowserQaPreset; error?: string } {
	if (!isRecord(input)) {
		return { error: "qa must be an object." };
	}
	const url = input.url;
	if (typeof url !== "string" || url.trim().length === 0) {
		return { error: "qa.url must be a non-empty string." };
	}
	const expectedText = input.expectedText === undefined
		? []
		: typeof input.expectedText === "string"
			? [input.expectedText]
			: Array.isArray(input.expectedText)
				? input.expectedText
				: undefined;
	if (!expectedText || expectedText.some((text) => typeof text !== "string" || text.trim().length === 0)) {
		return { error: "qa.expectedText must be a non-empty string or array of non-empty strings when provided." };
	}
	const expectedSelector = input.expectedSelector;
	if (expectedSelector !== undefined && (typeof expectedSelector !== "string" || expectedSelector.trim().length === 0)) {
		return { error: "qa.expectedSelector must be a non-empty string when provided." };
	}
	const screenshotPath = input.screenshotPath;
	if (screenshotPath !== undefined && (typeof screenshotPath !== "string" || screenshotPath.trim().length === 0)) {
		return { error: "qa.screenshotPath must be a non-empty string when provided." };
	}
	for (const field of ["checkConsole", "checkErrors", "checkNetwork"] as const) {
		if (input[field] !== undefined && typeof input[field] !== "boolean") {
			return { error: `qa.${field} must be a boolean when provided.` };
		}
	}
	const checkConsole = input.checkConsole !== false;
	const checkErrors = input.checkErrors !== false;
	const checkNetwork = input.checkNetwork !== false;
	const steps: CompiledAgentBrowserJobStep[] = [];
	if (checkNetwork) steps.push({ action: "wait", args: ["network", "requests", "--clear"] });
	if (checkConsole) steps.push({ action: "wait", args: ["console", "--clear"] });
	if (checkErrors) steps.push({ action: "wait", args: ["errors", "--clear"] });
	steps.push(
		{ action: "open", args: ["open", url] },
		{ action: "wait", args: ["wait", "--load", "networkidle"] },
	);
	for (const text of expectedText) {
		steps.push({ action: "assertText", args: ["wait", "--text", text] });
	}
	if (typeof expectedSelector === "string") {
		steps.push({ action: "wait", args: ["wait", expectedSelector] });
	}
	if (checkNetwork) steps.push({ action: "wait", args: ["network", "requests"] });
	if (checkConsole) steps.push({ action: "wait", args: ["console"] });
	if (checkErrors) steps.push({ action: "wait", args: ["errors"] });
	if (typeof screenshotPath === "string") steps.push({ action: "screenshot", args: ["screenshot", screenshotPath] });
	return {
		compiled: {
			args: ["batch"],
			checks: { checkConsole, checkErrors, checkNetwork, expectedSelector, expectedText, screenshotPath, url },
			stdin: JSON.stringify(steps.map((step) => step.args)),
			steps,
		},
	};
}

function compileAgentBrowserSourceLookup(input: unknown): { compiled?: CompiledAgentBrowserSourceLookup; error?: string } {
	if (!isRecord(input)) {
		return { error: "sourceLookup must be an object." };
	}
	const selector = input.selector;
	const reactFiberId = input.reactFiberId;
	const componentName = input.componentName;
	if (selector !== undefined && (typeof selector !== "string" || selector.trim().length === 0)) {
		return { error: "sourceLookup.selector must be a non-empty string when provided." };
	}
	if (reactFiberId !== undefined && (typeof reactFiberId !== "string" || reactFiberId.trim().length === 0)) {
		return { error: "sourceLookup.reactFiberId must be a non-empty string when provided." };
	}
	if (componentName !== undefined && (typeof componentName !== "string" || componentName.trim().length === 0)) {
		return { error: "sourceLookup.componentName must be a non-empty string when provided." };
	}
	if (selector === undefined && reactFiberId === undefined && componentName === undefined) {
		return { error: "sourceLookup requires selector, reactFiberId, or componentName." };
	}
	if (input.includeDomHints !== undefined && typeof input.includeDomHints !== "boolean") {
		return { error: "sourceLookup.includeDomHints must be a boolean when provided." };
	}
	const rawMaxWorkspaceFiles = input.maxWorkspaceFiles;
	if (rawMaxWorkspaceFiles !== undefined && (typeof rawMaxWorkspaceFiles !== "number" || !Number.isInteger(rawMaxWorkspaceFiles) || rawMaxWorkspaceFiles <= 0)) {
		return { error: "sourceLookup.maxWorkspaceFiles must be a positive integer when provided." };
	}
	if (typeof rawMaxWorkspaceFiles === "number" && rawMaxWorkspaceFiles > SOURCE_LOOKUP_MAX_WORKSPACE_FILES) {
		return { error: `sourceLookup.maxWorkspaceFiles must be ${SOURCE_LOOKUP_MAX_WORKSPACE_FILES} or less.` };
	}
	const includeDomHints = input.includeDomHints !== false;
	const maxWorkspaceFiles = (rawMaxWorkspaceFiles as number | undefined) ?? SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES;
	const steps: CompiledAgentBrowserSourceLookupStep[] = [];
	if (typeof selector === "string") {
		steps.push({ action: "dom", args: ["is", "visible", selector] });
		if (includeDomHints) {
			steps.push({ action: "dom", args: ["get", "html", selector] });
		}
	}
	if (typeof reactFiberId === "string") {
		steps.push({ action: "react", args: ["react", "inspect", reactFiberId] });
	}
	if (typeof componentName === "string") {
		steps.push({ action: "react", args: ["react", "tree"] });
	}
	return {
		compiled: {
			args: ["batch"],
			query: { componentName, includeDomHints, maxWorkspaceFiles, reactFiberId, selector },
			stdin: JSON.stringify(steps.map((step) => step.args)),
			steps,
		},
	};
}

function extractStringField(value: Record<string, unknown>, names: string[]): string | undefined {
	for (const name of names) {
		const field = value[name];
		if (typeof field === "string" && field.trim().length > 0) return field;
	}
	return undefined;
}

function extractNumberField(value: Record<string, unknown>, names: string[]): number | undefined {
	for (const name of names) {
		const field = value[name];
		if (typeof field === "number" && Number.isFinite(field)) return field;
		if (typeof field === "string" && /^\d+$/.test(field)) return Number(field);
	}
	return undefined;
}

function candidateKey(candidate: AgentBrowserSourceLookupCandidate): string {
	return [candidate.source, candidate.file ?? "", candidate.line ?? "", candidate.column ?? "", candidate.componentName ?? ""].join(":");
}

function addSourceLookupCandidate(candidates: AgentBrowserSourceLookupCandidate[], candidate: AgentBrowserSourceLookupCandidate): void {
	if (!candidates.some((existing) => candidateKey(existing) === candidateKey(candidate))) {
		candidates.push(candidate);
	}
}

function collectSourceCandidatesFromValue(value: unknown, source: "react-inspect" | "dom-attribute", candidates: AgentBrowserSourceLookupCandidate[], evidence: string[], depth = 0): void {
	if (depth > 6 || value === undefined || value === null) return;
	if (typeof value === "string") {
		const sourcePattern = /([A-Za-z0-9_./@-]+\.(?:tsx|jsx|ts|js))(?:[:#](\d+))?(?:[:#](\d+))?/g;
		for (const match of value.matchAll(sourcePattern)) {
			addSourceLookupCandidate(candidates, {
				column: match[3] ? Number(match[3]) : undefined,
				confidence: source === "react-inspect" ? "high" : "medium",
				evidence,
				file: match[1],
				line: match[2] ? Number(match[2]) : undefined,
				source,
			});
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectSourceCandidatesFromValue(item, source, candidates, evidence, depth + 1);
		return;
	}
	if (!isRecord(value)) return;
	const file = extractStringField(value, ["file", "fileName", "filename", "filePath", "path", "source", "url"]);
	if (file && /\.(?:tsx|jsx|ts|js)(?:$|[:?#])/.test(file)) {
		addSourceLookupCandidate(candidates, {
			column: extractNumberField(value, ["column", "columnNumber", "col"]),
			confidence: source === "react-inspect" ? "high" : "medium",
			evidence,
			file,
			line: extractNumberField(value, ["line", "lineNumber"]),
			source,
		});
	}
	for (const nested of Object.values(value)) {
		collectSourceCandidatesFromValue(nested, source, candidates, evidence, depth + 1);
	}
}

function getHtmlAttributeValue(html: string, name: string): string | undefined {
	const pattern = new RegExp(`${name}=["']([^"']+)["']`, "i");
	return pattern.exec(html)?.[1];
}

function collectDomSourceCandidates(html: unknown, candidates: AgentBrowserSourceLookupCandidate[]): void {
	if (typeof html !== "string") return;
	const file = getHtmlAttributeValue(html, "(?:data-source-file|data-file|data-component-file|data-source)");
	if (file && /\.(?:tsx|jsx|ts|js)$/.test(file)) {
		const line = getHtmlAttributeValue(html, "(?:data-source-line|data-line)");
		const column = getHtmlAttributeValue(html, "(?:data-source-column|data-column)");
		addSourceLookupCandidate(candidates, {
			column: column && /^\d+$/.test(column) ? Number(column) : undefined,
			confidence: "medium",
			evidence: ["selector HTML contained source-like data attributes"],
			file,
			line: line && /^\d+$/.test(line) ? Number(line) : undefined,
			source: "dom-attribute",
		});
	}
	collectSourceCandidatesFromValue(html, "dom-attribute", candidates, ["selector HTML contained source-like text"]);
}

async function walkWorkspaceSourceFiles(root: string, maxFiles: number): Promise<string[]> {
	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		if (files.length >= maxFiles) return;
		let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= maxFiles) return;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SOURCE_LOOKUP_IGNORED_DIRECTORIES.has(entry.name)) await visit(path);
			} else if (entry.isFile() && SOURCE_LOOKUP_WORKSPACE_EXTENSIONS.has(extname(entry.name))) {
				files.push(path);
			}
		}
	}
	await visit(root);
	return files;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectWorkspaceComponentCandidates(query: CompiledAgentBrowserSourceLookup["query"], cwd: string, candidates: AgentBrowserSourceLookupCandidate[], limitations: string[]): Promise<void> {
	if (!query.componentName) return;
	const files = await walkWorkspaceSourceFiles(cwd, query.maxWorkspaceFiles);
	if (files.length >= query.maxWorkspaceFiles) {
		limitations.push(`Workspace source scan stopped at ${query.maxWorkspaceFiles} files.`);
	}
	const componentPattern = new RegExp(`(?:function|class)\\s+${escapeRegExp(query.componentName)}\\b|(?:const|let|var)\\s+${escapeRegExp(query.componentName)}\\s*=|export\\s+default\\s+function\\s+${escapeRegExp(query.componentName)}\\b`);
	for (const file of files) {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		const match = componentPattern.exec(text);
		if (!match) continue;
		const line = text.slice(0, match.index).split("\n").length;
		addSourceLookupCandidate(candidates, {
			componentName: query.componentName,
			confidence: "low",
			evidence: [`local workspace contains a matching ${query.componentName} declaration`],
			file,
			line,
			source: "workspace-search",
		});
		if (candidates.filter((candidate) => candidate.source === "workspace-search").length >= 10) break;
	}
}

function validateLookupMaxWorkspaceFiles(value: unknown, fieldName: string): { value?: number; error?: string } {
	if (value === undefined) return { value: SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES };
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return { error: `${fieldName} must be a positive integer when provided.` };
	}
	if (value > SOURCE_LOOKUP_MAX_WORKSPACE_FILES) {
		return { error: `${fieldName} must be ${SOURCE_LOOKUP_MAX_WORKSPACE_FILES} or less.` };
	}
	return { value };
}

async function analyzeSourceLookupResults(data: unknown, compiled: CompiledAgentBrowserSourceLookup, cwd: string): Promise<AgentBrowserSourceLookupAnalysis> {
	const items = getBatchResultItems(data);
	const candidates: AgentBrowserSourceLookupCandidate[] = [];
	const limitations = [
		"Experimental lookup only reports candidates with evidence; it cannot guarantee a DOM node maps to one source file.",
		"React source hints require the page to be opened with --enable react-devtools and source information from the app build.",
	];
	let unsupported = false;
	for (const item of items) {
		const command = Array.isArray(item.command) ? item.command : [];
		const result = isRecord(item.result) && "data" in item.result ? item.result.data : item.result;
		if (item.success === false && command[0] === "react") unsupported = true;
		if (command[0] === "react" && command[1] === "inspect") {
			collectSourceCandidatesFromValue(result, "react-inspect", candidates, ["react inspect returned source-like metadata"]);
		}
		if (command[0] === "get" && command[1] === "html") {
			collectDomSourceCandidates(result, candidates);
		}
	}
	await collectWorkspaceComponentCandidates(compiled.query, cwd, candidates, limitations);
	const status: AgentBrowserSourceLookupStatus = candidates.length > 0 ? "candidates-found" : unsupported ? "unsupported" : "no-candidates";
	return {
		candidates,
		limitations,
		status,
		summary: candidates.length > 0
			? `Source lookup found ${candidates.length} candidate location(s).`
			: unsupported
				? "Source lookup could not inspect React metadata in this session."
				: "Source lookup found no candidate locations.",
	};
}

function compileAgentBrowserNetworkSourceLookup(input: unknown): { compiled?: CompiledAgentBrowserNetworkSourceLookup; error?: string } {
	if (!isRecord(input)) return { error: "networkSourceLookup must be an object." };
	const filter = input.filter;
	const requestId = input.requestId;
	const url = input.url;
	if (filter !== undefined && (typeof filter !== "string" || filter.trim().length === 0)) return { error: "networkSourceLookup.filter must be a non-empty string when provided." };
	if (requestId !== undefined && (typeof requestId !== "string" || requestId.trim().length === 0)) return { error: "networkSourceLookup.requestId must be a non-empty string when provided." };
	if (url !== undefined && (typeof url !== "string" || url.trim().length === 0)) return { error: "networkSourceLookup.url must be a non-empty string when provided." };
	if (filter === undefined && requestId === undefined && url === undefined) return { error: "networkSourceLookup requires requestId, filter, or url." };
	const maxWorkspaceFiles = validateLookupMaxWorkspaceFiles(input.maxWorkspaceFiles, "networkSourceLookup.maxWorkspaceFiles");
	if (maxWorkspaceFiles.error) return { error: maxWorkspaceFiles.error };
	const steps: Array<{ action: "network"; args: string[] }> = [];
	if (typeof requestId === "string") {
		steps.push({ action: "network", args: ["network", "request", requestId] });
	}
	const effectiveFilter = typeof filter === "string" ? filter : typeof url === "string" ? url : undefined;
	if (effectiveFilter) {
		steps.push({ action: "network", args: ["network", "requests", "--filter", effectiveFilter] });
	}
	return { compiled: { args: ["batch"], query: { filter, maxWorkspaceFiles: maxWorkspaceFiles.value as number, requestId, url }, stdin: JSON.stringify(steps.map((step) => step.args)), steps } };
}

function getResultPayload(item: Record<string, unknown>): unknown {
	return isRecord(item.result) && "data" in item.result ? item.result.data : item.result;
}

function networkRequestMatchesQuery(url: string | undefined, queryText: string | undefined): boolean {
	return queryText === undefined || url === undefined || url.includes(queryText) || queryText.includes(url);
}

function isFailedNetworkRecord(request: Record<string, unknown>): boolean {
	const status = typeof request.status === "number" ? request.status : undefined;
	const error = typeof request.error === "string" ? request.error : undefined;
	return request.failed === true || error !== undefined || (status !== undefined && status >= 400);
}

function getFailedNetworkRequests(data: unknown, queryText?: string): AgentBrowserNetworkSourceLookupRequest[] {
	const failed: AgentBrowserNetworkSourceLookupRequest[] = [];
	for (const item of getBatchResultItems(data)) {
		const payload = getResultPayload(item);
		const requests = isRecord(payload) && Array.isArray(payload.requests) ? payload.requests : Array.isArray(payload) ? payload : isRecord(payload) ? [payload] : [];
		for (const request of requests) {
			if (!isRecord(request)) continue;
			const url = typeof request.url === "string" ? request.url : undefined;
			if (!networkRequestMatchesQuery(url, queryText) || !isFailedNetworkRecord(request)) continue;
			failed.push({
				error: typeof request.error === "string" ? request.error : undefined,
				method: typeof request.method === "string" ? request.method : undefined,
				requestId: typeof request.id === "string" ? request.id : typeof request.requestId === "string" ? request.requestId : undefined,
				status: typeof request.status === "number" ? request.status : undefined,
				url,
			});
		}
	}
	return failed;
}

function addNetworkCandidate(candidates: AgentBrowserNetworkSourceLookupCandidate[], candidate: AgentBrowserNetworkSourceLookupCandidate): void {
	const key = [candidate.source, candidate.file ?? "", candidate.line ?? "", candidate.requestUrl ?? ""].join(":");
	if (!candidates.some((existing) => [existing.source, existing.file ?? "", existing.line ?? "", existing.requestUrl ?? ""].join(":") === key)) candidates.push(candidate);
}

function collectInitiatorCandidates(data: unknown, failedRequests: AgentBrowserNetworkSourceLookupRequest[], candidates: AgentBrowserNetworkSourceLookupCandidate[]): void {
	const failedRequestIds = new Set(failedRequests.map((request) => request.requestId).filter((value): value is string => value !== undefined));
	const failedRequestUrls = new Set(failedRequests.map((request) => request.url).filter((value): value is string => value !== undefined));
	for (const item of getBatchResultItems(data)) {
		const payload = getResultPayload(item);
		const requestValues = isRecord(payload) && Array.isArray(payload.requests) ? payload.requests : [payload];
		for (const value of requestValues) {
			if (!isRecord(value)) continue;
			const requestUrl = typeof value.url === "string" ? value.url : undefined;
			const requestId = typeof value.id === "string" ? value.id : typeof value.requestId === "string" ? value.requestId : undefined;
			const correlatesWithFailedRequest = (requestId !== undefined && failedRequestIds.has(requestId)) || (requestUrl !== undefined && failedRequestUrls.has(requestUrl));
			if (!correlatesWithFailedRequest && !isFailedNetworkRecord(value)) continue;
			for (const field of [value.initiator, value.stack, value.source, value.trace]) {
				const localCandidates: AgentBrowserSourceLookupCandidate[] = [];
				collectSourceCandidatesFromValue(field, "dom-attribute", localCandidates, ["failed network request included source-like initiator metadata"]);
				for (const candidate of localCandidates) {
					addNetworkCandidate(candidates, { confidence: "medium", evidence: candidate.evidence, file: candidate.file, line: candidate.line, requestUrl, source: "initiator" });
				}
			}
		}
	}
}

async function collectWorkspaceRequestCandidates(query: CompiledAgentBrowserNetworkSourceLookup["query"], failedRequests: AgentBrowserNetworkSourceLookupRequest[], cwd: string, candidates: AgentBrowserNetworkSourceLookupCandidate[], limitations: string[]): Promise<void> {
	const needles = [...new Set([query.url, query.filter, ...failedRequests.map((request) => request.url)].filter((value): value is string => typeof value === "string" && value.length > 0).flatMap((value) => {
		try {
			const parsed = new URL(value);
			return [value, parsed.pathname].filter((item) => item && item !== "/");
		} catch {
			return [value];
		}
	}))].slice(0, 8);
	if (needles.length === 0) return;
	const files = await walkWorkspaceSourceFiles(cwd, query.maxWorkspaceFiles);
	if (files.length >= query.maxWorkspaceFiles) limitations.push(`Workspace source scan stopped at ${query.maxWorkspaceFiles} files.`);
	for (const file of files) {
		let text: string;
		try { text = await readFile(file, "utf8"); } catch { continue; }
		for (const needle of needles) {
			const index = text.indexOf(needle);
			if (index === -1) continue;
			addNetworkCandidate(candidates, { confidence: "low", evidence: [`local workspace contains request URL literal ${needle}`], file, line: text.slice(0, index).split("\n").length, requestUrl: needle, source: "workspace-search" });
			if (candidates.filter((candidate) => candidate.source === "workspace-search").length >= 10) return;
		}
	}
}

function redactNetworkSourceLookupUrl(value: string | undefined): string | undefined {
	if (!value) return value;
	try {
		const isRelative = value.startsWith("/");
		const url = new URL(value, isRelative ? "https://redacted.invalid" : undefined);
		url.username = url.username ? "[REDACTED]" : "";
		url.password = url.password ? "[REDACTED]" : "";
		for (const key of [...url.searchParams.keys()]) {
			url.searchParams.set(key, "[REDACTED]");
		}
		if (/(?:token|secret|password|passwd|pwd|key|auth|session|jwt|credential)/i.test(url.hash)) {
			url.hash = "#[REDACTED]";
		}
		return isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
	} catch {
		return redactSensitiveText(value
			.replace(/([a-z][a-z0-9+.-]*:\/\/)\S+:\S+@/gi, "$1[REDACTED]@")
			.replace(/([?&][^=]+)=([^&#\s"'\]]+)/g, "$1=[REDACTED]"));
	}
}

function redactNetworkSourceLookupArgs(args: string[]): string[] {
	return redactInvocationArgs(args).map((arg) => redactNetworkSourceLookupUrl(arg) ?? arg);
}

function redactNetworkSourceLookupSurface(value: unknown): unknown {
	if (typeof value === "string") return redactNetworkSourceLookupUrl(value) ?? value;
	if (Array.isArray(value)) return value.map((item) => redactNetworkSourceLookupSurface(item));
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactNetworkSourceLookupSurface(item)]));
}

function redactNetworkSourceLookupAnalysis(analysis: AgentBrowserNetworkSourceLookupAnalysis): AgentBrowserNetworkSourceLookupAnalysis {
	return {
		...analysis,
		candidates: analysis.candidates.map((candidate) => ({
			...candidate,
			evidence: candidate.evidence.map((item) => redactNetworkSourceLookupUrl(item) ?? redactSensitiveText(item)),
			file: redactNetworkSourceLookupUrl(candidate.file),
			requestUrl: redactNetworkSourceLookupUrl(candidate.requestUrl),
		})),
		failedRequests: analysis.failedRequests.map((request) => ({ ...request, error: redactNetworkSourceLookupUrl(request.error), url: redactNetworkSourceLookupUrl(request.url) })),
	};
}

async function analyzeNetworkSourceLookupResults(data: unknown, compiled: CompiledAgentBrowserNetworkSourceLookup, cwd: string): Promise<AgentBrowserNetworkSourceLookupAnalysis> {
	const limitations = [
		"Experimental network source hints report candidates only; failed requests can be triggered indirectly by frameworks, caches, service workers, or third-party scripts.",
		"Initiator/source-map metadata is upstream/browser-build dependent and may be absent.",
	];
	const failedRequests = getFailedNetworkRequests(data, compiled.query.url ?? compiled.query.filter);
	const candidates: AgentBrowserNetworkSourceLookupCandidate[] = [];
	collectInitiatorCandidates(data, failedRequests, candidates);
	await collectWorkspaceRequestCandidates(compiled.query, failedRequests, cwd, candidates, limitations);
	const status: AgentBrowserNetworkSourceLookupStatus = failedRequests.length === 0 ? "no-failed-requests" : candidates.length > 0 ? "failed-requests-found" : "no-candidates";
	return { candidates, failedRequests, limitations, status, summary: failedRequests.length === 0 ? "Network source lookup found no failed requests." : candidates.length > 0 ? `Network source lookup found ${failedRequests.length} failed request(s) and ${candidates.length} candidate source hint(s).` : `Network source lookup found ${failedRequests.length} failed request(s) but no source candidates.` };
}

function appendSemanticActionTextArg(args: string[], action: string, text: string | undefined): void {
	if ((action === "fill" || action === "select") && text) {
		args.push(text);
	}
}

function getCompiledSemanticActionCommandIndex(compiled: CompiledAgentBrowserSemanticAction): number {
	return compiled.args[0] === "--session" ? 2 : 0;
}

function getCompiledSemanticActionTextArg(compiled: CompiledAgentBrowserSemanticAction): string | undefined {
	if (compiled.action !== "fill" && compiled.action !== "select") return undefined;
	const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
	if (commandIndex < 0) return undefined;
	const markerIndex = compiled.args.indexOf("--name");
	return markerIndex >= 0 ? compiled.args[markerIndex - 1] : compiled.args[commandIndex + 4];
}

function getCompiledSemanticActionSessionPrefix(compiled: CompiledAgentBrowserSemanticAction): string[] {
	const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
	return commandIndex > 0 ? compiled.args.slice(0, commandIndex) : [];
}

const SEMANTIC_ACTION_CANDIDATE_ACTION_IDS = new Set([
	"try-searchbox-name-candidate",
	"try-textbox-name-candidate",
	"try-button-name-candidate",
	"try-link-name-candidate",
	"try-labeled-textbox-candidate",
]);

function formatSemanticActionCandidateText(actions: AgentBrowserNextAction[]): string | undefined {
	const candidateActions = actions.filter((action) => SEMANTIC_ACTION_CANDIDATE_ACTION_IDS.has(action.id) && action.params?.args);
	if (candidateActions.length === 0) return undefined;
	return [
		"Agent-browser candidate fallbacks:",
		...candidateActions.map((action) => `- ${action.id}: agent_browser ${JSON.stringify({ args: action.params?.args })} — ${action.reason}`),
	].join("\n");
}

function buildSemanticActionCandidateActions(compiled: CompiledAgentBrowserSemanticAction): AgentBrowserNextAction[] {
	const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
	if (commandIndex < 0) return [];
	const locator = compiled.args[commandIndex + 1];
	const value = compiled.args[commandIndex + 2];
	if (!locator || !value) return [];
	const text = getCompiledSemanticActionTextArg(compiled);
	const sessionPrefix = getCompiledSemanticActionSessionPrefix(compiled);
	const buildRoleCandidate = (role: string, id: string, reason: string): AgentBrowserNextAction => {
		const args = [...sessionPrefix, "find", "role", role, compiled.action];
		appendSemanticActionTextArg(args, compiled.action, text);
		args.push("--name", value);
		return {
			id,
			params: { args: redactInvocationArgs(args) },
			reason,
			safety: "Candidate locator fallback only; inspect the page if multiple elements could match the same accessible name.",
			tool: "agent_browser" as const,
		};
	};

	if (locator === "placeholder" && compiled.action === "fill") {
		return [
			buildRoleCandidate("searchbox", "try-searchbox-name-candidate", "Retry against a searchbox with the same accessible name; many search inputs expose names instead of placeholders."),
			buildRoleCandidate("textbox", "try-textbox-name-candidate", "Retry against a textbox with the same accessible name when placeholder lookup misses."),
		];
	}
	if (locator === "text" && compiled.action === "click") {
		return [
			buildRoleCandidate("button", "try-button-name-candidate", "Retry against a button with the same accessible name when text lookup misses."),
			buildRoleCandidate("link", "try-link-name-candidate", "Retry against a link with the same accessible name when text lookup misses."),
		];
	}
	if (locator === "label" && compiled.action === "fill") {
		return [buildRoleCandidate("textbox", "try-labeled-textbox-candidate", "Retry against a textbox with the same accessible name when label lookup misses.")];
	}
	return [];
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
	const session = input.session;
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
	if (session !== undefined && (typeof session !== "string" || session.trim().length === 0)) {
		return { error: "semanticAction.session must be a non-empty string when provided." };
	}
	const args = typeof session === "string" ? ["--session", session, "find", locator, value, action] : ["find", locator, value, action];
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
	const job = compileAgentBrowserJob(input.job);
	const qa = compileAgentBrowserQaPreset(input.qa);
	const sourceLookup = compileAgentBrowserSourceLookup(input.sourceLookup);
	const networkSourceLookup = compileAgentBrowserNetworkSourceLookup(input.networkSourceLookup);
	const generatedBatch = networkSourceLookup.compiled ?? sourceLookup.compiled ?? job.compiled ?? qa.compiled;
	const rawArgs = Array.isArray(input.args)
		? input.args.filter((value): value is string => typeof value === "string")
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

function extractStringResultField(data: unknown, fieldName: "result" | "title" | "url"): string | undefined {
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

interface SessionRefSnapshot {
	refIds: string[];
	target?: SessionTabTarget;
}

interface OrderedSessionRefSnapshot extends SessionRefSnapshot {
	order: number;
}

interface StaleRefPreflight {
	message: string;
	refIds: string[];
	snapshot?: SessionRefSnapshot;
}

interface AboutBlankSessionMismatch {
	activeUrl: "about:blank";
	recoveryApplied: boolean;
	recoveryHint: string;
	targetTitle?: string;
	targetUrl: string;
}

function getLatestSessionTabTargetOrder(targets: Map<string, { order: number }>): number {
	let latestOrder = 0;
	for (const target of targets.values()) {
		latestOrder = Math.max(latestOrder, target.order);
	}
	return latestOrder;
}

function shouldApplySessionTabTargetUpdate(options: {
	current?: { order: number };
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

function extractRefSnapshotFromData(data: unknown): SessionRefSnapshot | undefined {
	if (!isRecord(data)) return undefined;
	const refIds = isRecord(data.refs) ? Object.keys(data.refs).filter((refId) => /^e\d+$/.test(refId)) : [];
	if (refIds.length === 0) return undefined;
	return {
		refIds,
		target: extractSessionTabTargetFromData(data),
	};
}

function extractRefSnapshotFromBatchResults(data: unknown): SessionRefSnapshot | undefined {
	if (!Array.isArray(data)) return undefined;
	let latestSnapshot: SessionRefSnapshot | undefined;
	for (const item of data) {
		if (!isRecord(item) || item.success === false) continue;
		const [name] = extractBatchResultCommand(item);
		if (name !== "snapshot") continue;
		latestSnapshot = extractRefSnapshotFromData(item.result) ?? latestSnapshot;
	}
	return latestSnapshot;
}

function restoreSessionRefSnapshotsFromBranch(branch: unknown[]): Map<string, OrderedSessionRefSnapshot> {
	const restoredSnapshots = new Map<string, OrderedSessionRefSnapshot>();
	let restoredOrder = 0;
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) continue;
		const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
		if (!sessionName) continue;
		const command = typeof details.command === "string" ? details.command : undefined;
		if (command === "close" && message.isError !== true) {
			restoredOrder += 1;
			restoredSnapshots.delete(sessionName);
			continue;
		}
		const refSnapshot = isRecord(details.refSnapshot)
			? {
				refIds: Array.isArray(details.refSnapshot.refIds)
					? details.refSnapshot.refIds.filter((refId): refId is string => typeof refId === "string" && /^e\d+$/.test(refId))
					: [],
				target: isRecord(details.refSnapshot.target)
					? normalizeSessionTabTarget({
							title: typeof details.refSnapshot.target.title === "string" ? details.refSnapshot.target.title : undefined,
							url: typeof details.refSnapshot.target.url === "string" ? details.refSnapshot.target.url : undefined,
					  })
					: undefined,
			  }
			: undefined;
		if (refSnapshot && refSnapshot.refIds.length > 0) {
			restoredOrder += 1;
			restoredSnapshots.set(sessionName, { ...refSnapshot, order: restoredOrder });
		}
	}
	return restoredSnapshots;
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

const REF_INVALIDATING_BATCH_COMMANDS = new Set([
	"back",
	"check",
	"click",
	"dblclick",
	"drag",
	"fill",
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

function collectRefsFromTokens(tokens: string[]): string[] {
	return tokens.filter((token) => /^@e\d+\b/.test(token)).map((token) => token.slice(1));
}

function getGuardedRefUsage(commandTokens: string[], stdin?: string): string[] {
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
		if ((step[0] ?? "") === "snapshot") break;
		refsBeforeInBatchSnapshot.push(...collectFromStep(step));
	}
	return refsBeforeInBatchSnapshot;
}

function targetsMatch(left: SessionTabTarget | undefined, right: SessionTabTarget | undefined): boolean {
	if (!left || !right) return true;
	return normalizeComparableUrl(left.url) === normalizeComparableUrl(right.url);
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

function buildStaleRefPreflight(options: {
	commandTokens: string[];
	currentTarget?: SessionTabTarget;
	refSnapshot?: SessionRefSnapshot;
	stdin?: string;
}): StaleRefPreflight | undefined {
	const usedRefIds = [...new Set(getGuardedRefUsage(options.commandTokens, options.stdin))];
	const batchInvalidationMessage = getBatchRefInvalidationMessage(options.commandTokens, options.stdin);
	if (batchInvalidationMessage && usedRefIds.length > 0) {
		return {
			message: batchInvalidationMessage,
			refIds: usedRefIds,
			snapshot: options.refSnapshot,
		};
	}
	if (usedRefIds.length === 0 || !options.refSnapshot) return undefined;
	if (!targetsMatch(options.refSnapshot.target, options.currentTarget)) {
		return {
			message: `Ref ${usedRefIds.map((refId) => `@${refId}`).join(", ")} came from a snapshot for ${options.refSnapshot.target?.url ?? "a prior page"}, but the current session target is ${options.currentTarget?.url ?? "unknown"}. Run snapshot -i again before using page-scoped refs.`,
			refIds: usedRefIds,
			snapshot: options.refSnapshot,
		};
	}
	const knownRefs = new Set(options.refSnapshot.refIds);
	const missingRefs = usedRefIds.filter((refId) => !knownRefs.has(refId));
	if (missingRefs.length > 0) {
		return {
			message: `Ref ${missingRefs.map((refId) => `@${refId}`).join(", ")} was not present in the latest snapshot for this session. Run snapshot -i again before using page-scoped refs.`,
			refIds: missingRefs,
			snapshot: options.refSnapshot,
		};
	}
	return undefined;
}

function sessionPrefixArgs(sessionName: string | undefined, args: string[]): string[] {
	return sessionName && args[0] !== "--session" ? ["--session", sessionName, ...args] : args;
}

function sessionAwareStaleRefNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	return (buildAgentBrowserNextActions({ failureCategory: "stale-ref", resultCategory: "failure" }) ?? []).map((action) => {
		const actionArgs = action.params?.args;
		return {
			...action,
			params: action.params && actionArgs ? { ...action.params, args: sessionPrefixArgs(sessionName, actionArgs) } : action.params,
		};
	});
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
	stdin?: string;
}): Promise<unknown | undefined> {
	const { args, cwd, sessionName, signal, stdin } = options;
	if (!sessionName) return undefined;

	const processResult = await runAgentBrowserProcess({
		args: ["--json", "--session", sessionName, ...args],
		cwd,
		signal,
		stdin,
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

function getSnapshotRefRecord(data: unknown): Record<string, unknown> | undefined {
	return isRecord(data) && isRecord(data.refs) ? data.refs : undefined;
}

const OVERLAY_CLOSE_NAME_PATTERN = /(?:\b(?:close|dismiss|no thanks|not now|maybe later|hide|skip|continue without|x)\b|^\s*×\s*$)/i;
const OVERLAY_CONTEXT_NAME_PATTERN = /\b(?:banner|modal|dialog|popup|pop-up|overlay|donat(?:e|ion)|subscribe|sign in|login|cookie|privacy|consent)\b/i;
const OVERLAY_CONTEXT_ROLES = new Set(["alertdialog", "dialog"]);
const OVERLAY_ACTION_ROLES = new Set(["button", "link", "menuitem"]);
const OVERLAY_BLOCKER_CANDIDATE_LIMIT = 3;

function getOverlayBlockerCandidates(snapshotData: unknown): OverlayBlockerCandidate[] {
	const refs = getSnapshotRefRecord(snapshotData);
	if (!refs) return [];
	const hasOverlayContext = Object.values(refs).some((entry) => {
		if (!isRecord(entry)) return false;
		const role = typeof entry.role === "string" ? entry.role : "";
		const name = typeof entry.name === "string" ? entry.name : "";
		return OVERLAY_CONTEXT_ROLES.has(role.toLowerCase()) || OVERLAY_CONTEXT_NAME_PATTERN.test(name);
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

function formatOverlayBlockerText(diagnostic: OverlayBlockerDiagnostic): string {
	return [
		"Possible overlay blockers:",
		...diagnostic.candidates.map((candidate) => `- ${candidate.ref}${candidate.role ? ` ${candidate.role}` : ""}${candidate.name ? ` ${JSON.stringify(candidate.name)}` : ""}: ${candidate.reason}`),
	].join("\n");
}

function buildOverlayBlockerNextActions(options: { diagnostic: OverlayBlockerDiagnostic; sessionName?: string }): AgentBrowserNextAction[] {
	return [
		{
			id: "inspect-overlay-state",
			params: { args: sessionPrefixArgs(options.sessionName, ["snapshot", "-i"]) },
			reason: "Refresh interactive refs and inspect whether an overlay, banner, modal, or dialog is blocking the intended click.",
			safety: "Read-only inspection; use current refs from this snapshot before interacting.",
			tool: "agent_browser" as const,
		},
		...options.diagnostic.candidates.map((candidate, index) => ({
			id: `try-overlay-blocker-candidate-${index + 1}`,
			params: { args: sessionPrefixArgs(options.sessionName, candidate.args) },
			reason: candidate.reason,
			safety: "Only click this if the candidate is clearly a close/dismiss control for an overlay that blocks the intended workflow.",
			tool: "agent_browser" as const,
		})),
	];
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

async function collectSelectorTextVisibilityDiagnostics(options: {
	commandInfo: CommandInfo;
	commandTokens: string[];
	cwd: string;
	data: unknown;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<SelectorTextVisibilityDiagnostic[]> {
	const selectors = options.commandInfo.command === "get" && options.commandInfo.subcommand === "text"
		? [options.commandTokens[2]]
		: options.commandInfo.command === "batch"
			? getBatchGetTextSelectors(options.data)
			: [];
	const diagnostics: SelectorTextVisibilityDiagnostic[] = [];
	for (const selector of selectors) {
		const diagnostic = await collectSelectorTextVisibilityDiagnosticForSelector({
			cwd: options.cwd,
			selector,
			sessionName: options.sessionName,
			signal: options.signal,
		});
		if (diagnostic) diagnostics.push(diagnostic);
	}
	return diagnostics.sort((left, right) => Number(right.firstMatchVisible === false) - Number(left.firstMatchVisible === false));
}

function formatSelectorTextVisibilityText(diagnostics: SelectorTextVisibilityDiagnostic[]): string | undefined {
	if (diagnostics.length === 0) return undefined;
	return diagnostics.flatMap((diagnostic) => {
		const lines = [`Selector text visibility warning: ${diagnostic.summary}`];
		if (diagnostic.firstVisibleTextPreview) lines.push(`First visible text preview: ${JSON.stringify(diagnostic.firstVisibleTextPreview)}`);
		return lines;
	}).join("\n");
}

function looksLikeFunctionEvalStdin(stdin: string | undefined): boolean {
	const trimmed = stdin?.trim();
	if (!trimmed) return false;
	return /^(?:async\s+)?function\b/.test(trimmed) || /^(?:async\s*)?\([^)]*\)\s*=>/.test(trimmed) || /^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(trimmed);
}

function isEmptyRecord(value: unknown): boolean {
	return isRecord(value) && Object.keys(value).length === 0;
}

function getEvalStdinHint(options: { command?: string; data: unknown; stdin?: string }): EvalStdinHint | undefined {
	if (options.command !== "eval" || !looksLikeFunctionEvalStdin(options.stdin) || !isRecord(options.data)) return undefined;
	const result = options.data.result;
	if (!isEmptyRecord(result)) return undefined;
	return {
		reason: "eval --stdin received a function-shaped snippet and the upstream JSON result was an empty object, which often means the function itself was returned or serialized instead of invoked.",
		suggestion: "Pass a plain expression such as `({ title: document.title })`, or invoke the function explicitly, for example `(() => ({ title: document.title }))()`.",
	};
}

function formatEvalStdinHintText(hint: EvalStdinHint | undefined): string | undefined {
	return hint ? `Eval stdin hint: ${hint.reason} ${hint.suggestion}` : undefined;
}

function getArtifactCleanupGuidance(options: { command?: string; manifest?: SessionArtifactManifest; succeeded: boolean }): ArtifactCleanupGuidance | undefined {
	if (!options.succeeded || options.command !== "close" || !options.manifest || options.manifest.entries.length === 0) return undefined;
	const explicitArtifactPaths = options.manifest.entries
		.filter((entry) => entry.storageScope === "explicit-path")
		.map((entry) => entry.path)
		.filter((path, index, paths) => paths.indexOf(path) === index)
		.slice(0, 10);
	return {
		explicitArtifactPaths,
		note: "Closing the browser session does not delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings; clean those paths with host file tools when no longer needed.",
		owner: "host-file-tools",
		summary: formatSessionArtifactRetentionSummary(options.manifest),
	};
}

function formatArtifactCleanupGuidanceText(guidance: ArtifactCleanupGuidance | undefined): string | undefined {
	if (!guidance) return undefined;
	const lines = [
		"Artifact lifecycle:",
		`- ${guidance.summary}`,
		`- ${guidance.note}`,
	];
	if (guidance.explicitArtifactPaths.length > 0) {
		lines.push(`- Explicit artifact paths to review: ${guidance.explicitArtifactPaths.join(", ")}`);
	}
	return lines.join("\n");
}

function buildSelectorTextVisibilityNextActions(options: { diagnostics: SelectorTextVisibilityDiagnostic[]; sessionName?: string }): AgentBrowserNextAction[] {
	return options.diagnostics.map((diagnostic, index) => ({
		id: index === 0 ? "inspect-visible-text-candidates" : `inspect-visible-text-candidates-${index + 1}`,
		params: {
			args: sessionPrefixArgs(options.sessionName, ["eval", "--stdin"]),
			stdin: buildVisibleTextProbeScript(diagnostic.selector),
		},
		reason: "Inspect selector match count and visible text before trusting get text on tabbed or hidden DOM content.",
		safety: "Read-only DOM inspection; use a more specific visible selector or current @ref before acting on hidden-tab text.",
		tool: "agent_browser" as const,
	}));
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

async function collectTimeoutPartialProgress(options: {
	command?: string;
	compiledJob?: CompiledAgentBrowserJob;
	cwd: string;
	sessionName?: string;
	stdin?: string;
}): Promise<TimeoutPartialProgress | undefined> {
	const steps = getTimeoutProgressSteps(options.compiledJob, options.command, options.stdin);
	const artifacts = await collectTimeoutArtifactEvidence(options.cwd, steps);
	const [urlData, titleData] = await Promise.all([
		runSessionCommandData({ args: ["get", "url"], cwd: options.cwd, sessionName: options.sessionName }),
		runSessionCommandData({ args: ["get", "title"], cwd: options.cwd, sessionName: options.sessionName }),
	]);
	const recoveredUrl = extractStringResultField(urlData, "result") ?? extractStringResultField(urlData, "url");
	const title = extractStringResultField(titleData, "result") ?? extractStringResultField(titleData, "title");
	const plannedUrl = recoveredUrl ? undefined : getPlannedCurrentPageUrl(steps);
	const url = recoveredUrl ?? plannedUrl;
	if (steps.length === 0 && artifacts.length === 0 && !url && !title) return undefined;
	const foundArtifacts = artifacts.filter((artifact) => artifact.exists).length;
	const pageStateSummary = recoveredUrl || title ? " and current page state" : plannedUrl ? " and planned page URL" : "";
	return {
		artifacts,
		currentPage: url || title ? { title, url } : undefined,
		steps: steps.length > 0 ? steps : undefined,
		summary: `Timed out before upstream returned final results; recovered ${foundArtifacts}/${artifacts.length} declared artifact path${artifacts.length === 1 ? "" : "s"}${pageStateSummary}.`,
	};
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

function formatTimeoutPartialProgressText(progress: TimeoutPartialProgress): string {
	const lines = [`Timeout partial progress: ${progress.summary}`];
	const currentPageTitle = progress.currentPage?.title ? redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(progress.currentPage.title)) : undefined;
	const currentPageUrl = progress.currentPage?.url ? sanitizeCurrentPageUrlForTimeoutDiagnostic(progress.currentPage.url) : undefined;
	if (currentPageTitle || currentPageUrl) {
		lines.push(`Current page: ${[currentPageTitle, currentPageUrl].filter(Boolean).join(" — ")}`);
	}
	if (progress.steps && progress.steps.length > 0) {
		const shownSteps = progress.steps.slice(0, 6);
		lines.push("Planned steps:");
		for (const step of shownSteps) {
			const command = redactSensitivePathSegmentsForDiagnostic(redactInvocationArgs(step.args).join(" "));
			lines.push(`- Step ${step.index}: ${command}`);
		}
		if (progress.steps.length > shownSteps.length) {
			lines.push(`- ... ${progress.steps.length - shownSteps.length} more step${progress.steps.length - shownSteps.length === 1 ? "" : "s"} omitted`);
		}
	}
	for (const artifact of progress.artifacts) {
		const path = redactSensitivePathSegmentsForDiagnostic(artifact.path);
		lines.push(`Artifact from step ${artifact.stepIndex}: ${path} (${artifact.exists ? `exists${typeof artifact.sizeBytes === "number" ? `, ${artifact.sizeBytes} bytes` : ""}` : "missing"})`);
	}
	return lines.join("\n");
}

async function collectOverlayBlockerDiagnostic(options: {
	command?: string;
	cwd: string;
	data: unknown;
	navigationSummary?: NavigationSummary;
	priorTarget?: SessionTabTarget;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<OverlayBlockerDiagnostic | undefined> {
	if (options.command !== "click" || !isRecord(options.data) || typeof options.data.clicked !== "string") return undefined;
	const priorUrl = normalizeComparableUrl(options.priorTarget?.url);
	const currentUrl = normalizeComparableUrl(options.navigationSummary?.url);
	if (!priorUrl || !currentUrl || priorUrl !== currentUrl) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	const candidates = getOverlayBlockerCandidates(snapshotData);
	const snapshot = extractRefSnapshotFromData(snapshotData);
	if (candidates.length === 0 || !snapshot) return undefined;
	return {
		candidates,
		snapshot,
		summary: `Click completed but the page stayed on ${currentUrl}; a fresh snapshot contains likely overlay close/dismiss controls.`,
	};
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

function buildManagedSessionOutcome(options: {
	activeAfter: boolean;
	activeBefore: boolean;
	attemptedSessionName?: string;
	command?: string;
	currentSessionName: string;
	previousSessionName: string;
	replacedSessionName?: string;
	sessionMode: "auto" | "fresh";
	succeeded: boolean;
}): ManagedSessionOutcome | undefined {
	const { activeAfter, activeBefore, attemptedSessionName, command, currentSessionName, previousSessionName, replacedSessionName, sessionMode, succeeded } = options;
	if (!attemptedSessionName) return undefined;
	let status: ManagedSessionOutcome["status"];
	let summary: string;
	if (command === "close") {
		status = succeeded ? "closed" : activeBefore ? "preserved" : "abandoned";
		summary = succeeded
			? `Managed session ${attemptedSessionName} was closed.`
			: activeBefore
				? `Managed session close failed; previous managed session ${previousSessionName} remains current.`
				: `Managed session close failed; no managed session is active.`;
	} else if (succeeded) {
		if (replacedSessionName) {
			status = "replaced";
			summary = `Managed session ${replacedSessionName} was replaced by ${currentSessionName}.`;
		} else if (!activeBefore && activeAfter) {
			status = "created";
			summary = `Managed session ${currentSessionName} is now current.`;
		} else {
			status = "unchanged";
			summary = `Managed session ${currentSessionName} remains current.`;
		}
	} else if (activeBefore) {
		status = "preserved";
		summary = sessionMode === "fresh" && attemptedSessionName !== previousSessionName
			? `Fresh managed session ${attemptedSessionName} failed before becoming current; previous managed session ${previousSessionName} was preserved.`
			: `Managed session call failed; previous managed session ${previousSessionName} was preserved.`;
	} else {
		status = "abandoned";
		summary = sessionMode === "fresh"
			? `Fresh managed session ${attemptedSessionName} failed before becoming current; no previous managed session was active, so no managed session is current.`
			: `Managed session call failed before any managed session became current.`;
	}
	return {
		activeAfter,
		activeBefore,
		attemptedSessionName,
		currentSessionName,
		previousSessionName,
		replacedSessionName,
		sessionMode,
		status,
		succeeded,
		summary,
	};
}

function formatManagedSessionOutcomeText(outcome: ManagedSessionOutcome | undefined): string | undefined {
	return outcome && !outcome.succeeded && outcome.sessionMode === "fresh" ? `Managed session outcome: ${outcome.summary}` : undefined;
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
	let sessionRefSnapshots = new Map<string, OrderedSessionRefSnapshot>();
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
		sessionRefSnapshots = restoreSessionRefSnapshotsFromBranch(ctx.sessionManager.getBranch());
		sessionTabTargetUpdateOrder = Math.max(getLatestSessionTabTargetOrder(sessionTabTargets), getLatestSessionTabTargetOrder(sessionRefSnapshots));
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
		sessionRefSnapshots = new Map<string, OrderedSessionRefSnapshot>();
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
			const jobResult = params.job === undefined ? {} : compileAgentBrowserJob(params.job);
			const qaResult = params.qa === undefined ? {} : compileAgentBrowserQaPreset(params.qa);
			const sourceLookupResult = params.sourceLookup === undefined ? {} : compileAgentBrowserSourceLookup(params.sourceLookup);
			const networkSourceLookupResult = params.networkSourceLookup === undefined ? {} : compileAgentBrowserNetworkSourceLookup(params.networkSourceLookup);
			const hasExplicitArgs = Array.isArray(params.args);
			const explicitInputModes = [hasExplicitArgs, Boolean(semanticActionResult.compiled), Boolean(jobResult.compiled), Boolean(qaResult.compiled), Boolean(sourceLookupResult.compiled), Boolean(networkSourceLookupResult.compiled)].filter(Boolean).length;
			const semanticActionError = semanticActionResult.error;
			const jobError = jobResult.error;
			const qaError = qaResult.error;
			const sourceLookupError = sourceLookupResult.error;
			const networkSourceLookupError = networkSourceLookupResult.error;
			const inputModeError = explicitInputModes !== 1
				? "Provide exactly one of args, semanticAction, job, qa, sourceLookup, or networkSourceLookup."
				: undefined;
			const compiledSemanticAction = semanticActionResult.compiled;
			const compiledQaPreset = qaResult.compiled;
			const compiledSourceLookup = sourceLookupResult.compiled;
			const compiledNetworkSourceLookup = networkSourceLookupResult.compiled;
			const compiledJob = jobResult.compiled ?? compiledQaPreset;
			const compiledGeneratedBatch = compiledNetworkSourceLookup ?? compiledSourceLookup ?? compiledJob;
			const toolArgs = compiledSemanticAction?.args ?? compiledGeneratedBatch?.args ?? params.args ?? [];
			const toolStdin = compiledGeneratedBatch?.stdin ?? params.stdin;
			const redactedArgs = redactInvocationArgs(toolArgs);
			const generatedStdinError = compiledGeneratedBatch && params.stdin !== undefined ? "Do not provide stdin with job, qa, sourceLookup, or networkSourceLookup; those modes generate their own batch stdin." : undefined;
			const validationError = semanticActionError ?? jobError ?? qaError ?? sourceLookupError ?? networkSourceLookupError ?? inputModeError ?? generatedStdinError ?? validateToolArgs(toolArgs) ?? getBatchAnnotateValidationError(toolArgs, toolStdin);
			const redactedCompiledSemanticAction = compiledSemanticAction
				? { ...compiledSemanticAction, args: redactInvocationArgs(compiledSemanticAction.args) }
				: undefined;
			const redactedCompiledJobSteps = compiledJob?.steps.map((step) => ({ ...step, args: redactInvocationArgs(step.args) }));
			const redactedCompiledJob = compiledJob && redactedCompiledJobSteps
				? { ...compiledJob, stdin: JSON.stringify(redactedCompiledJobSteps.map((step) => step.args)), steps: redactedCompiledJobSteps }
				: undefined;
			const redactedCompiledQaPreset = compiledQaPreset && redactedCompiledJob
				? { ...redactedCompiledJob, checks: compiledQaPreset.checks }
				: undefined;
			const redactedCompiledSourceLookupSteps = compiledSourceLookup?.steps.map((step) => ({ ...step, args: redactInvocationArgs(step.args) }));
			const redactedCompiledSourceLookup = compiledSourceLookup && redactedCompiledSourceLookupSteps
				? { ...compiledSourceLookup, stdin: JSON.stringify(redactedCompiledSourceLookupSteps.map((step) => step.args)), steps: redactedCompiledSourceLookupSteps }
				: undefined;
			const redactedCompiledNetworkSourceLookupSteps = compiledNetworkSourceLookup?.steps.map((step) => ({ ...step, args: redactNetworkSourceLookupArgs(step.args) }));
			const redactedCompiledNetworkSourceLookup = compiledNetworkSourceLookup && redactedCompiledNetworkSourceLookupSteps
				? {
					...compiledNetworkSourceLookup,
					query: {
						...compiledNetworkSourceLookup.query,
						filter: redactNetworkSourceLookupUrl(compiledNetworkSourceLookup.query.filter),
						url: redactNetworkSourceLookupUrl(compiledNetworkSourceLookup.query.url),
					},
					stdin: JSON.stringify(redactedCompiledNetworkSourceLookupSteps.map((step) => step.args)),
					steps: redactedCompiledNetworkSourceLookupSteps,
				}
				: undefined;
			if (validationError) {
				return {
					content: [{ type: "text", text: validationError }],
					details: {
						args: redactedArgs,
						compiledJob: redactedCompiledJob,
						compiledQaPreset: redactedCompiledQaPreset,
						compiledSourceLookup: redactedCompiledSourceLookup,
						compiledNetworkSourceLookup: redactedCompiledNetworkSourceLookup,
						compiledSemanticAction: redactedCompiledSemanticAction,
						...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, errorText: validationError, succeeded: false, validationError }),
						validationError,
					},
					isError: true,
				};
			}
			const preparedArgs = await prepareAgentBrowserArgs(toolArgs, toolStdin, ctx.cwd);
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
							compiledJob: redactedCompiledJob,
							compiledQaPreset: redactedCompiledQaPreset,
							compiledSourceLookup: redactedCompiledSourceLookup,
							compiledNetworkSourceLookup: redactedCompiledNetworkSourceLookup,
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
					stdin: toolStdin,
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
					stdin: toolStdin,
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
				const waitIpcTimeoutError = validateWaitIpcTimeoutContract(commandTokens, toolStdin);
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
				const priorRefSnapshotState = executionPlan.sessionName ? sessionRefSnapshots.get(executionPlan.sessionName) : undefined;
				const staleRefPreflight = buildStaleRefPreflight({
					commandTokens,
					currentTarget: priorSessionTabTarget,
					refSnapshot: priorRefSnapshotState,
					stdin: toolStdin,
				});
				if (staleRefPreflight) {
					return {
						content: [{ type: "text", text: staleRefPreflight.message }],
						details: {
							args: redactedArgs,
							command: executionPlan.commandInfo.command,
							compatibilityWorkaround,
							effectiveArgs: redactedEffectiveArgs,
							nextActions: sessionAwareStaleRefNextActions(executionPlan.sessionName),
							refIds: staleRefPreflight.refIds,
							refSnapshot: staleRefPreflight.snapshot,
							sessionMode,
							...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: staleRefPreflight.message, failureCategory: "stale-ref", succeeded: false }),
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						},
						isError: true,
					};
				}
				let pinnedBatchUnwrapMode: PinnedBatchUnwrapMode | undefined;
				let includePinnedNavigationSummary = false;
				let sessionTabCorrection: OpenResultTabCorrection | undefined;
				let processArgs = executionPlan.effectiveArgs;
				let processStdin = preparedArgs.stdin ?? toolStdin;
				if (
					priorSessionTabTarget &&
					shouldPinSessionTabForCommand({
						command: executionPlan.commandInfo.command,
						commandTokens,
						sessionName: executionPlan.sessionName,
						stdin: toolStdin,
					})
				) {
					const plannedSessionTabSelection = await collectSessionTabSelection({
						cwd: ctx.cwd,
						sessionName: executionPlan.sessionName,
						signal,
						target: priorSessionTabTarget,
					});
					if (plannedSessionTabSelection && executionPlan.sessionName) {
						if (executionPlan.commandInfo.command === "eval" && toolStdin !== undefined) {
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
								stdin: toolStdin,
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
					const managedSessionOutcome = buildManagedSessionOutcome({
						activeAfter: managedSessionActive,
						activeBefore: managedSessionActive,
						attemptedSessionName: executionPlan.managedSessionName,
						command: executionPlan.commandInfo.command,
						currentSessionName: managedSessionName,
						previousSessionName: managedSessionName,
						sessionMode,
						succeeded: false,
					});
					const managedSessionOutcomeText = formatManagedSessionOutcomeText(managedSessionOutcome);
					return {
						content: [{ type: "text", text: managedSessionOutcomeText ? `${errorText}\n\n${managedSessionOutcomeText}` : errorText }],
						details: {
							args: redactedArgs,
							compatibilityWorkaround,
							effectiveArgs: redactedProcessArgs,
							managedSessionOutcome,
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
					let succeeded = processSucceeded && parseSucceeded && envelopeSuccess;
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
					let overlayBlockerDiagnostic: OverlayBlockerDiagnostic | undefined;

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
					let selectorTextVisibilityDiagnostics: SelectorTextVisibilityDiagnostic[] = [];
					const timeoutPartialProgress = processResult.timedOut ? await collectTimeoutPartialProgress({
						command: executionPlan.commandInfo.command,
						compiledJob,
						cwd: ctx.cwd,
						sessionName: executionPlan.sessionName,
						stdin: toolStdin,
					}) : undefined;
					if (succeeded && !sessionTabCorrection && !aboutBlankSessionMismatch) {
						overlayBlockerDiagnostic = await collectOverlayBlockerDiagnostic({
							command: executionPlan.commandInfo.command,
							cwd: ctx.cwd,
							data: presentationEnvelope?.data,
							navigationSummary,
							priorTarget: priorSessionTabTarget,
							sessionName: executionPlan.sessionName,
							signal,
						});
					}
					if (succeeded) {
						selectorTextVisibilityDiagnostics = await collectSelectorTextVisibilityDiagnostics({
							commandInfo: executionPlan.commandInfo,
							commandTokens,
							cwd: ctx.cwd,
							data: presentationEnvelope?.data,
							sessionName: executionPlan.sessionName,
							signal,
						});
					}
					let currentRefSnapshot: SessionRefSnapshot | undefined;
					if (executionPlan.sessionName) {
						const activeSessionTabTargetState = sessionTabTargets.get(executionPlan.sessionName);
						if (shouldApplySessionTabTargetUpdate({ current: activeSessionTabTargetState, updateOrder: tabTargetUpdateOrder })) {
							if (executionPlan.commandInfo.command === "close" && succeeded) {
								sessionTabTargets.delete(executionPlan.sessionName);
								sessionRefSnapshots.delete(executionPlan.sessionName);
							} else if (currentSessionTabTarget) {
								sessionTabTargets.set(executionPlan.sessionName, { order: tabTargetUpdateOrder, target: currentSessionTabTarget });
							}
						}
						const refSnapshot = succeeded
			? executionPlan.commandInfo.command === "snapshot"
				? extractRefSnapshotFromData(presentationEnvelope?.data)
				: executionPlan.commandInfo.command === "batch"
					? extractRefSnapshotFromBatchResults(presentationEnvelope?.data)
					: overlayBlockerDiagnostic?.snapshot
			: undefined;
						if (refSnapshot && shouldApplySessionTabTargetUpdate({ current: sessionRefSnapshots.get(executionPlan.sessionName), updateOrder: tabTargetUpdateOrder })) {
							currentRefSnapshot = { ...refSnapshot, target: refSnapshot.target ?? currentSessionTabTarget };
							sessionRefSnapshots.set(executionPlan.sessionName, { ...currentRefSnapshot, order: tabTargetUpdateOrder });
						} else {
							currentRefSnapshot = sessionRefSnapshots.get(executionPlan.sessionName);
						}
					}

					const priorManagedSessionActive = managedSessionActive;
					const priorManagedSessionCwd = managedSessionCwd;
					const priorManagedSessionName = managedSessionName;
					const managedSessionState = resolveManagedSessionState({
						command: executionPlan.commandInfo.command,
						managedSessionName: executionPlan.managedSessionName,
						priorActive: priorManagedSessionActive,
						priorSessionName: priorManagedSessionName,
						succeeded,
					});
					const replacedManagedSessionName = managedSessionState.replacedSessionName;
					managedSessionActive = managedSessionState.active;
					managedSessionName = managedSessionState.sessionName;
					let managedSessionOutcome = buildManagedSessionOutcome({
						activeAfter: managedSessionActive,
						activeBefore: priorManagedSessionActive,
						attemptedSessionName: executionPlan.managedSessionName,
						command: executionPlan.commandInfo.command,
						currentSessionName: managedSessionName,
						previousSessionName: priorManagedSessionName,
						replacedSessionName: replacedManagedSessionName,
						sessionMode,
						succeeded,
					});
					if (executionPlan.managedSessionName && succeeded) {
						managedSessionCwd = ctx.cwd;
					}
					if (replacedManagedSessionName) {
						sessionTabTargets.delete(replacedManagedSessionName);
						sessionRefSnapshots.delete(replacedManagedSessionName);
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
						staleRefArgs: getStaleRefArgs(commandTokens, toolStdin),
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
					const qaPreset = compiledQaPreset ? analyzeQaPresetResults(presentationEnvelope?.data) : undefined;
					const sourceLookup = compiledSourceLookup ? await analyzeSourceLookupResults(presentationEnvelope?.data, compiledSourceLookup, ctx.cwd) : undefined;
					const networkSourceLookup = compiledNetworkSourceLookup ? redactNetworkSourceLookupAnalysis(await analyzeNetworkSourceLookupResults(presentationEnvelope?.data, compiledNetworkSourceLookup, ctx.cwd)) : undefined;
					if (networkSourceLookup && presentation.content[0]?.type === "text") {
						presentation.content[0] = { ...presentation.content[0], text: `${networkSourceLookup.summary}\n\n${presentation.content[0].text}` };
					} else if (networkSourceLookup) {
						presentation.content.unshift({ type: "text", text: networkSourceLookup.summary });
					}
					if (sourceLookup && presentation.content[0]?.type === "text") {
						presentation.content[0] = { ...presentation.content[0], text: `${sourceLookup.summary}\n\n${presentation.content[0].text}` };
					} else if (sourceLookup) {
						presentation.content.unshift({ type: "text", text: sourceLookup.summary });
					}
					if (qaPreset && (!qaPreset.passed || qaPreset.warnings.length > 0)) {
						if (!qaPreset.passed) {
							succeeded = false;
							presentation.failureCategory = "qa-failure";
						}
						presentation.summary = qaPreset.summary;
						if (presentation.content[0]?.type === "text") {
							presentation.content[0] = { ...presentation.content[0], text: `${qaPreset.summary}\n\n${presentation.content[0].text}` };
						} else {
							presentation.content.unshift({ type: "text", text: qaPreset.summary });
						}
					}
					if (managedSessionOutcome && managedSessionOutcome.succeeded !== succeeded) {
						managedSessionOutcome = { ...managedSessionOutcome, succeeded };
					}
					const evalStdinHint = getEvalStdinHint({
						command: executionPlan.commandInfo.command,
						data: presentationEnvelope?.data,
						stdin: toolStdin,
					});
					const resultArtifactManifest = presentation.artifactManifest ?? artifactManifest;
					const artifactCleanup = getArtifactCleanupGuidance({
						command: executionPlan.commandInfo.command,
						manifest: resultArtifactManifest,
						succeeded,
					});
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
					if (categoryDetails.failureCategory === "stale-ref") {
						nextActions = sessionAwareStaleRefNextActions(executionPlan.sessionName);
					}
					if (categoryDetails.failureCategory === "selector-not-found" && redactedCompiledSemanticAction) {
						const candidateActions = buildSemanticActionCandidateActions(redactedCompiledSemanticAction);
						if (candidateActions.length > 0) {
							(nextActions ??= []).push(...candidateActions);
						}
					}
					if (overlayBlockerDiagnostic) {
						(nextActions ??= []).push(...buildOverlayBlockerNextActions({ diagnostic: overlayBlockerDiagnostic, sessionName: executionPlan.sessionName }));
					}
					if (selectorTextVisibilityDiagnostics.length > 0) {
						(nextActions ??= []).push(...buildSelectorTextVisibilityNextActions({ diagnostics: selectorTextVisibilityDiagnostics, sessionName: executionPlan.sessionName }));
					}
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
						compiledJob: redactedCompiledJob,
						compiledQaPreset: redactedCompiledQaPreset,
						compiledSourceLookup: redactedCompiledSourceLookup,
						compiledNetworkSourceLookup: redactedCompiledNetworkSourceLookup,
						artifactManifest: resultArtifactManifest,
						artifactRetentionSummary: presentation.artifactRetentionSummary ?? (resultArtifactManifest ? formatSessionArtifactRetentionSummary(resultArtifactManifest) : undefined),
						artifactCleanup,
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
						managedSessionOutcome,
						imagePath: presentation.imagePath,
						imagePaths: presentation.imagePaths,
						nextActions,
						pageChangeSummary: presentation.pageChangeSummary,
						overlayBlockers: overlayBlockerDiagnostic,
						qaPreset,
						selectorTextVisibility: selectorTextVisibilityDiagnostics[0],
						selectorTextVisibilityAll: selectorTextVisibilityDiagnostics.length > 1 ? selectorTextVisibilityDiagnostics : undefined,
						evalStdinHint,
						timeoutPartialProgress,
						parseError: plainTextInspection ? undefined : parseError,
						savedFile: presentation.savedFile,
						savedFilePath: presentation.savedFilePath,
						sourceLookup,
						networkSourceLookup,
						sessionMode,
						sessionTabCorrection,
						sessionTabTarget: currentSessionTabTarget,
						refSnapshot: currentRefSnapshot,
						...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						sessionRecoveryHint: redactedRecoveryHint,
						startupScopedFlags: executionPlan.startupScopedFlags,
						stderr: processResult.stderr,
						stdout: plainTextInspection ? inspectionText ?? "" : parseSucceeded ? undefined : processResult.stdout,
						summary: presentation.summary,
						timedOut: processResult.timedOut || undefined,
						timeoutMs: processResult.timeoutMs,
					};

					const semanticActionCandidateText = nextActions ? formatSemanticActionCandidateText(nextActions) : undefined;
					const overlayBlockerText = overlayBlockerDiagnostic ? formatOverlayBlockerText(overlayBlockerDiagnostic) : undefined;
					const selectorTextVisibilityText = formatSelectorTextVisibilityText(selectorTextVisibilityDiagnostics);
					const evalStdinHintText = formatEvalStdinHintText(evalStdinHint);
					const artifactCleanupText = formatArtifactCleanupGuidanceText(artifactCleanup);
					const timeoutPartialProgressText = timeoutPartialProgress ? formatTimeoutPartialProgressText(timeoutPartialProgress) : undefined;
					const managedSessionOutcomeText = formatManagedSessionOutcomeText(managedSessionOutcome);
					const rawAppendedDiagnosticText = [semanticActionCandidateText, overlayBlockerText, selectorTextVisibilityText, evalStdinHintText, artifactCleanupText, timeoutPartialProgressText, managedSessionOutcomeText].filter((item): item is string => item !== undefined).join("\n\n");
					const appendedDiagnosticText = redactSensitiveText(redactExactSensitiveText(rawAppendedDiagnosticText, exactSensitiveValues));
					const shouldAppendDiagnosticText = appendedDiagnosticText.length > 0 && (!userRequestedJson || plainTextInspection);
					const content = shouldAppendDiagnosticText && redactedContent[0]?.type === "text"
						? [
							{ ...redactedContent[0], text: `${redactedContent[0].text}\n\n${appendedDiagnosticText}` },
							...redactedContent.slice(1),
						]
						: redactedContent;
					const result = {
						content,
						details: redactToolDetails(details, exactSensitiveValues),
						isError: !succeeded,
					};
					return compiledNetworkSourceLookup ? redactNetworkSourceLookupSurface(result) as typeof result : result;
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
