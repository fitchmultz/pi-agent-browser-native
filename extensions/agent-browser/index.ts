/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage extension-owned browser session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest in this package, or explicitly via `pi --no-extensions -e .` during local checkout development.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import { constants as fsConstants } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
	compareRefIds,
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
const AGENT_BROWSER_JOB_STEP_ACTIONS = ["open", "click", "fill", "select", "wait", "assertText", "assertUrl", "waitForDownload", "screenshot"] as const;
const AGENT_BROWSER_QA_LOAD_STATES = ["domcontentloaded", "load", "networkidle"] as const;
const AGENT_BROWSER_ELECTRON_ACTIONS = ["list", "launch", "status", "cleanup", "probe"] as const;
const AGENT_BROWSER_ELECTRON_HANDOFFS = ["connect", "tabs", "snapshot"] as const;
const AGENT_BROWSER_ELECTRON_TARGET_TYPES = ["page", "webview", "any"] as const;
const AGENT_BROWSER_ELECTRON_LIST_FIELDS = new Set(["action", "query", "maxResults"]);
const AGENT_BROWSER_ELECTRON_PROBE_FIELDS = new Set(["action", "launchId", "timeoutMs"]);
const AGENT_BROWSER_ELECTRON_RESERVED_APP_ARGS = ["--user-data-dir", "--remote-debugging-port", "--remote-debugging-address", "--remote-debugging-pipe"] as const;
const ELECTRON_PROBE_MAX_TABS = 6;
const ELECTRON_PROBE_MAX_REF_IDS = 20;
const ELECTRON_PROBE_MAX_SNAPSHOT_LINES = 12;
const ELECTRON_PROBE_MAX_SNAPSHOT_CHARS = 1_600;
const ELECTRON_POST_COMMAND_STATUS_SETTLE_MS = 250;
const ELECTRON_FILL_VERIFICATION_TIMEOUT_MS = 2_000;
const SOURCE_LOOKUP_WORKSPACE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SOURCE_LOOKUP_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "out", "tmp", "temp"]);
const SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES = 2_000;
const SOURCE_LOOKUP_MAX_WORKSPACE_FILES = 5_000;

type AgentBrowserSemanticActionName = (typeof AGENT_BROWSER_SEMANTIC_ACTIONS)[number];
type AgentBrowserSemanticLocator = (typeof AGENT_BROWSER_SEMANTIC_LOCATORS)[number];
type AgentBrowserJobStepAction = (typeof AGENT_BROWSER_JOB_STEP_ACTIONS)[number];
type AgentBrowserQaLoadState = (typeof AGENT_BROWSER_QA_LOAD_STATES)[number];
type AgentBrowserElectronAction = (typeof AGENT_BROWSER_ELECTRON_ACTIONS)[number];
type AgentBrowserSourceLookupStatus = "candidates-found" | "no-candidates" | "unsupported";
type AgentBrowserNetworkSourceLookupStatus = "failed-requests-found" | "no-failed-requests" | "no-candidates";

interface AgentBrowserSemanticActionInput {
	action: AgentBrowserSemanticActionName;
	locator?: AgentBrowserSemanticLocator;
	value?: string;
	values?: string[];
	selector?: string;
	text?: string;
	role?: string;
	name?: string;
	session?: string;
}

interface CompiledAgentBrowserSemanticAction {
	action: AgentBrowserSemanticActionName;
	locator?: AgentBrowserSemanticLocator;
	selector?: string;
	values?: string[];
	args: string[];
}

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
		loadState: AgentBrowserQaLoadState;
		expectedText: string[];
		expectedSelector?: string;
		screenshotPath?: string;
		attached: boolean;
		url?: string;
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

interface AgentBrowserSourceLookupElectronContext {
	appName?: string;
	appPath?: string;
	executablePath?: string;
	launchId?: string;
	sessionName?: string;
	url?: string;
}

interface AgentBrowserSourceLookupAnalysis {
	candidates: AgentBrowserSourceLookupCandidate[];
	electronContext?: AgentBrowserSourceLookupElectronContext;
	limitations: string[];
	status: AgentBrowserSourceLookupStatus;
	summary: string;
	workspaceRoot?: string;
}

interface AgentBrowserSourceLookupAnalysisContext {
	electronContext?: AgentBrowserSourceLookupElectronContext;
	workspaceRoot: string;
}

interface CompiledAgentBrowserNetworkSourceLookup {
	args: string[];
	stdin: string;
	steps: Array<{ action: "network"; args: string[] }>;
	query: {
		filter?: string;
		maxWorkspaceFiles: number;
		requestId?: string;
		session?: string;
		url?: string;
	};
}

type CompiledAgentBrowserElectron =
	| {
		action: "list";
		maxResults?: number;
		query?: string;
	}
	| {
		action: "launch";
		allow?: string[];
		appArgs?: string[];
		deny?: string[];
		appName?: string;
		appPath?: string;
		bundleId?: string;
		executablePath?: string;
		handoff: "connect" | "snapshot" | "tabs";
		targetType: "any" | "page" | "webview";
		timeoutMs?: number;
	}
	| {
		action: "cleanup" | "status";
		all?: boolean;
		launchId?: string;
		timeoutMs?: number;
	}
	| {
		action: "probe";
		launchId?: string;
		timeoutMs?: number;
	};

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
				description: "Intent action to compile to an existing agent-browser find command, or to upstream select when action=select.",
			}),
			locator: Type.Optional(StringEnum(AGENT_BROWSER_SEMANTIC_LOCATORS, {
				description: "Upstream find locator family to use for check/click/fill/uncheck actions.",
			})),
			value: Type.Optional(Type.String({ description: "Locator value for find actions, or a single option value for select actions. For locator=role, role may be supplied instead." })),
			values: Type.Optional(Type.Array(Type.String({ description: "Option value for select actions." }), { description: "One or more option values for select actions.", minItems: 1 })),
			selector: Type.Optional(Type.String({ description: "Selector or @ref for select actions; compiled to select <selector> <value...>." })),
			text: Type.Optional(Type.String({ description: "Text/value argument for fill actions." })),
			role: Type.Optional(Type.String({ description: "Role locator value for locator=role. May be used instead of value; when both are set they must match." })),
			name: Type.Optional(Type.String({ description: "Accessible name filter for locator=role; compiles to --name <name>." })),
			session: Type.Optional(Type.String({ description: "Optional upstream session name; prepends --session <name> before the compiled command." })),
		}),
	),
	qa: Type.Optional(
		Type.Union([
			Type.Object({
				attached: Type.Literal(true, { description: "Run the QA preset against the currently attached session instead of opening qa.url." }),
				expectedText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Text that must appear on the page." })),
				expectedSelector: Type.Optional(Type.String({ description: "Selector or @ref that must appear on the page." })),
				screenshotPath: Type.Optional(Type.String({ description: "Optional evidence screenshot path captured at the end of the QA preset." })),
				checkConsole: Type.Optional(Type.Boolean({ description: "Whether to fail on console error messages. Defaults to true." })),
				checkErrors: Type.Optional(Type.Boolean({ description: "Whether to fail on page errors. Defaults to true." })),
				checkNetwork: Type.Optional(Type.Boolean({ description: "Whether to inspect network requests and fail on actionable request failures; benign icon misses warn. Defaults to true." })),
				loadState: Type.Optional(StringEnum(AGENT_BROWSER_QA_LOAD_STATES, { description: "Page readiness state for the QA preset before assertions and diagnostics. Defaults to domcontentloaded; use networkidle only for pages without long-lived background requests." })),
			}, { additionalProperties: false }),
			Type.Object({
				url: Type.String({ description: "URL to open for a lightweight QA preset." }),
				attached: Type.Optional(Type.Literal(false, { description: "When omitted or false, qa.url is required and opened before checks." })),
				expectedText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Text that must appear on the page." })),
				expectedSelector: Type.Optional(Type.String({ description: "Selector or @ref that must appear on the page." })),
				screenshotPath: Type.Optional(Type.String({ description: "Optional evidence screenshot path captured at the end of the QA preset." })),
				checkConsole: Type.Optional(Type.Boolean({ description: "Whether to fail on console error messages. Defaults to true." })),
				checkErrors: Type.Optional(Type.Boolean({ description: "Whether to fail on page errors. Defaults to true." })),
				checkNetwork: Type.Optional(Type.Boolean({ description: "Whether to inspect network requests and fail on actionable request failures; benign icon misses warn. Defaults to true." })),
				loadState: Type.Optional(StringEnum(AGENT_BROWSER_QA_LOAD_STATES, { description: "Page readiness state for the QA preset before assertions and diagnostics. Defaults to domcontentloaded; use networkidle only for pages without long-lived background requests." })),
			}, { additionalProperties: false }),
		], { description: "Lightweight QA preset. Use qa.url to open a URL, or qa.attached=true to check the current attached session without opening a URL." }),
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
			session: Type.Optional(Type.String({ description: "Optional upstream session name; prepends --session <name> before the generated batch." })),
			url: Type.Optional(Type.String({ description: "Optional failed request URL or URL fragment to correlate with local source." })),
			maxWorkspaceFiles: Type.Optional(Type.Number({ description: "Maximum local source files to scan for URL literals. Defaults to 2000 and cannot exceed 5000.", minimum: 1, maximum: SOURCE_LOOKUP_MAX_WORKSPACE_FILES })),
		}),
	),
	electron: Type.Optional(
		Type.Union([
			Type.Object({
				action: StringEnum(["list"] as const, { description: "List discovered Electron apps." }),
				query: Type.Optional(Type.String({ description: "Optional case-insensitive substring filter for electron.list across app name, bundle id, desktop id, and paths.", minLength: 1 })),
				maxResults: Type.Optional(Type.Integer({ description: `Maximum electron.list apps to return. Defaults to ${ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS}; values above ${ELECTRON_DISCOVERY_MAX_RESULTS} are clamped.`, minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["launch"] as const, { description: "Launch an Electron app with an isolated wrapper-owned profile." }),
				appPath: Type.String({ description: "Electron launch target: macOS .app bundle path. Exactly one launch target is required for electron.launch.", minLength: 1 }),
				appArgs: Type.Optional(Type.Array(Type.String({ description: "Argument passed to the Electron application.", minLength: 1 }), { description: "Optional Electron app argv. Wrapper-owned lifecycle/debug flags are rejected." })),
				handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS, { description: "Post-launch handoff depth. Defaults to snapshot." })),
				targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES, { description: "Preferred CDP target type. Defaults to page." })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded launch timeout in milliseconds.", minimum: 1 })),
				allow: Type.Optional(Type.Array(Type.String({ description: "App identifier allowed by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned allow list for electron.launch policy checks." })),
				deny: Type.Optional(Type.Array(Type.String({ description: "App identifier denied by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned deny list for electron.launch policy checks; deny wins over allow." })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["launch"] as const, { description: "Launch an Electron app with an isolated wrapper-owned profile." }),
				appName: Type.String({ description: "Electron launch target: app display name discovered by electron.list. Exactly one launch target is required for electron.launch.", minLength: 1 }),
				appArgs: Type.Optional(Type.Array(Type.String({ description: "Argument passed to the Electron application.", minLength: 1 }), { description: "Optional Electron app argv. Wrapper-owned lifecycle/debug flags are rejected." })),
				handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS, { description: "Post-launch handoff depth. Defaults to snapshot." })),
				targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES, { description: "Preferred CDP target type. Defaults to page." })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded launch timeout in milliseconds.", minimum: 1 })),
				allow: Type.Optional(Type.Array(Type.String({ description: "App identifier allowed by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned allow list for electron.launch policy checks." })),
				deny: Type.Optional(Type.Array(Type.String({ description: "App identifier denied by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned deny list for electron.launch policy checks; deny wins over allow." })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["launch"] as const, { description: "Launch an Electron app with an isolated wrapper-owned profile." }),
				bundleId: Type.String({ description: "Electron launch target: macOS bundle identifier discovered by electron.list. Exactly one launch target is required for electron.launch.", minLength: 1 }),
				appArgs: Type.Optional(Type.Array(Type.String({ description: "Argument passed to the Electron application.", minLength: 1 }), { description: "Optional Electron app argv. Wrapper-owned lifecycle/debug flags are rejected." })),
				handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS, { description: "Post-launch handoff depth. Defaults to snapshot." })),
				targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES, { description: "Preferred CDP target type. Defaults to page." })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded launch timeout in milliseconds.", minimum: 1 })),
				allow: Type.Optional(Type.Array(Type.String({ description: "App identifier allowed by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned allow list for electron.launch policy checks." })),
				deny: Type.Optional(Type.Array(Type.String({ description: "App identifier denied by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned deny list for electron.launch policy checks; deny wins over allow." })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["launch"] as const, { description: "Launch an Electron app with an isolated wrapper-owned profile." }),
				executablePath: Type.String({ description: "Electron launch target: executable path. Discovery is not required when this is provided. Exactly one launch target is required for electron.launch.", minLength: 1 }),
				appArgs: Type.Optional(Type.Array(Type.String({ description: "Argument passed to the Electron application.", minLength: 1 }), { description: "Optional Electron app argv. Wrapper-owned lifecycle/debug flags are rejected." })),
				handoff: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_HANDOFFS, { description: "Post-launch handoff depth. Defaults to snapshot." })),
				targetType: Type.Optional(StringEnum(AGENT_BROWSER_ELECTRON_TARGET_TYPES, { description: "Preferred CDP target type. Defaults to page." })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded launch timeout in milliseconds.", minimum: 1 })),
				allow: Type.Optional(Type.Array(Type.String({ description: "App identifier allowed by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned allow list for electron.launch policy checks." })),
				deny: Type.Optional(Type.Array(Type.String({ description: "App identifier denied by the caller for electron.launch.", minLength: 1 }), { description: "Optional caller-owned deny list for electron.launch policy checks; deny wins over allow." })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["status", "cleanup"] as const, { description: "Inspect or cleanup one wrapper-tracked Electron launch by launchId." }),
				launchId: Type.String({ description: "Wrapper launch id for electron.status and electron.cleanup.", minLength: 1 }),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded status/cleanup timeout in milliseconds.", minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["status", "cleanup"] as const, { description: "Inspect or cleanup all wrapper-tracked Electron launches." }),
				all: Type.Literal(true, { description: "Apply electron.status or electron.cleanup to all wrapper-owned launches." }),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded status/cleanup timeout in milliseconds.", minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["status", "cleanup"] as const, { description: "Inspect or cleanup the only active wrapper-tracked Electron launch." }),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded status/cleanup timeout in milliseconds.", minimum: 1 })),
			}, { additionalProperties: false }),
			Type.Object({
				action: StringEnum(["probe"] as const, { description: "Probe the current attached Electron managed session; launchId is accepted for launch-scoped follow-up actions." }),
				launchId: Type.Optional(Type.String({ description: "Wrapper launch id for electron.probe follow-up targeting.", minLength: 1 })),
				timeoutMs: Type.Optional(Type.Integer({ description: "Bounded probe timeout in milliseconds.", minimum: 1 })),
			}, { additionalProperties: false }),
		], { description: "Electron wrapper action. Fields are action-specific and unsupported fields are rejected." }),
	),
	job: Type.Optional(
		Type.Object({
			steps: Type.Array(
				Type.Object({
					action: StringEnum(AGENT_BROWSER_JOB_STEP_ACTIONS, {
						description: "Constrained one-call job step compiled to existing upstream batch commands.",
					}),
					url: Type.Optional(Type.String({ description: "URL for open steps, or URL pattern for assertUrl steps." })),
					selector: Type.Optional(Type.String({ description: "Selector or @ref for click/fill/select-like steps." })),
					text: Type.Optional(Type.String({ description: "Text for fill steps or visible text for assertText steps." })),
					value: Type.Optional(Type.String({ description: "Single option value for select steps." })),
					values: Type.Optional(Type.Array(Type.String({ description: "Option value for select steps." }), { description: "One or more option values for select steps.", minItems: 1 })),
					path: Type.Optional(Type.String({ description: "Artifact/download path for waitForDownload or screenshot steps." })),
					milliseconds: Type.Optional(Type.Number({ description: "Milliseconds for wait steps." })),
				}),
				{ minItems: 1 },
			),
		}),
	),
	stdin: Type.Optional(Type.String({ description: "Optional raw stdin content; only supported for batch, eval --stdin, auth save --password-stdin, and is generated internally by job, qa, sourceLookup, or networkSourceLookup mode. Do not use with electron mode." })),
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

function getSelectValues(input: Record<string, unknown>, context: string): { values?: string[]; error?: string } {
	const rawValue = input.value;
	const rawValues = input.values;
	if (rawValue !== undefined && rawValues !== undefined) {
		return { error: `${context}.value and ${context}.values cannot both be provided for select.` };
	}
	if (rawValues !== undefined) {
		if (!Array.isArray(rawValues) || rawValues.length === 0 || rawValues.some((value) => typeof value !== "string" || value.trim().length === 0)) {
			return { error: `${context}.values must be a non-empty array of non-empty strings for select.` };
		}
		return { values: rawValues };
	}
	if (typeof rawValue === "string" && rawValue.trim().length > 0) {
		return { values: [rawValue] };
	}
	return { error: `${context}.value or ${context}.values is required for select.` };
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
		} else if (jobAction === "select") {
			const selector = getRequiredJobString(rawStep, "selector", jobAction);
			if (selector.error) return { error: `job.steps[${index}]: ${selector.error}` };
			const values = getSelectValues(rawStep, `job.steps[${index}]`);
			if (values.error) return { error: values.error };
			args = ["select", selector.value as string, ...(values.values as string[])];
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
	const attached = input.attached === true;
	if (input.attached !== undefined && typeof input.attached !== "boolean") {
		return { error: "qa.attached must be a boolean when provided." };
	}
	const url = input.url;
	if (attached && url !== undefined) {
		return { error: "qa.url must be omitted when qa.attached is true." };
	}
	if (!attached && (typeof url !== "string" || url.trim().length === 0)) {
		return { error: "qa.url must be a non-empty string." };
	}
	const normalizedUrl = typeof url === "string" ? url.trim() : undefined;
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
	const rawLoadState = input.loadState;
	if (rawLoadState !== undefined && (typeof rawLoadState !== "string" || !AGENT_BROWSER_QA_LOAD_STATES.includes(rawLoadState as AgentBrowserQaLoadState))) {
		return { error: `qa.loadState must be one of: ${AGENT_BROWSER_QA_LOAD_STATES.join(", ")}.` };
	}
	const checkConsole = input.checkConsole !== false;
	const checkErrors = input.checkErrors !== false;
	const checkNetwork = input.checkNetwork !== false;
	const loadState = (rawLoadState as AgentBrowserQaLoadState | undefined) ?? "domcontentloaded";
	const steps: CompiledAgentBrowserJobStep[] = [];
	if (checkNetwork) steps.push({ action: "wait", args: ["network", "requests", "--clear"] });
	if (checkConsole) steps.push({ action: "wait", args: ["console", "--clear"] });
	if (checkErrors) steps.push({ action: "wait", args: ["errors", "--clear"] });
	if (!attached && normalizedUrl) steps.push({ action: "open", args: ["open", normalizedUrl] });
	steps.push({ action: "wait", args: ["wait", "--load", loadState] });
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
			checks: { attached, checkConsole, checkErrors, checkNetwork, expectedSelector, expectedText, loadState, screenshotPath, url: normalizedUrl },
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

async function analyzeSourceLookupResults(
	data: unknown,
	compiled: CompiledAgentBrowserSourceLookup,
	cwd: string,
	context?: AgentBrowserSourceLookupAnalysisContext,
): Promise<AgentBrowserSourceLookupAnalysis> {
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
	const electronContext = status === "no-candidates" ? context?.electronContext : undefined;
	const workspaceRoot = context?.workspaceRoot ?? cwd;
	if (electronContext) {
		limitations.push(
			`Workspace source scan is limited to the Pi tool session cwd: ${workspaceRoot}.`,
			"Packaged Electron app code may live inside installed app resources or app.asar outside the workspace; the wrapper does not unpack asar files or scan app bundle resources.",
		);
	}
	return {
		candidates,
		electronContext,
		limitations,
		status,
		summary: candidates.length > 0
			? `Source lookup found ${candidates.length} candidate location(s).`
			: unsupported
				? "Source lookup could not inspect React metadata in this session."
				: electronContext
					? `Source lookup found no candidate locations. The workspace scan was limited to ${workspaceRoot}; packaged Electron app code may live outside that cwd in app resources or app.asar.`
					: "Source lookup found no candidate locations.",
		workspaceRoot: electronContext ? workspaceRoot : undefined,
	};
}

function compileAgentBrowserNetworkSourceLookup(input: unknown): { compiled?: CompiledAgentBrowserNetworkSourceLookup; error?: string } {
	if (!isRecord(input)) return { error: "networkSourceLookup must be an object." };
	const filter = input.filter;
	const requestId = input.requestId;
	const session = input.session;
	const url = input.url;
	if (filter !== undefined && (typeof filter !== "string" || filter.trim().length === 0)) return { error: "networkSourceLookup.filter must be a non-empty string when provided." };
	if (requestId !== undefined && (typeof requestId !== "string" || requestId.trim().length === 0)) return { error: "networkSourceLookup.requestId must be a non-empty string when provided." };
	if (session !== undefined && (typeof session !== "string" || session.trim().length === 0)) return { error: "networkSourceLookup.session must be a non-empty string when provided." };
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
	const args = typeof session === "string" ? ["--session", session, "batch"] : ["batch"];
	return { compiled: { args, query: { filter, maxWorkspaceFiles: maxWorkspaceFiles.value as number, requestId, session, url }, stdin: JSON.stringify(steps.map((step) => step.args)), steps } };
}

function validateOptionalNonEmptyString(input: Record<string, unknown>, fieldName: string): { value?: string; error?: string } {
	const value = input[fieldName];
	if (value === undefined) return {};
	if (typeof value !== "string" || value.trim().length === 0) {
		return { error: `electron.${fieldName} must be a non-empty string when provided.` };
	}
	return { value: value.trim() };
}

function validateOptionalElectronStringArray(input: Record<string, unknown>, fieldName: "allow" | "appArgs" | "deny"): string | undefined {
	const value = input[fieldName];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		return `electron.${fieldName} must be an array of non-empty strings when provided.`;
	}
	return undefined;
}

function validateOptionalElectronEnum<T extends string>(input: Record<string, unknown>, fieldName: string, values: readonly T[]): string | undefined {
	const value = input[fieldName];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !values.includes(value as T)) {
		return `electron.${fieldName} must be one of: ${values.join(", ")}.`;
	}
	return undefined;
}

function getReservedElectronAppArg(appArgs: string[] | undefined): string | undefined {
	return appArgs?.find((arg) => {
		const trimmed = arg.trim();
		return trimmed === "--" || AGENT_BROWSER_ELECTRON_RESERVED_APP_ARGS.some((reserved) => trimmed === reserved || trimmed.startsWith(`${reserved}=`));
	});
}

function validateElectronLaunchAppArgs(appArgs: string[] | undefined): string | undefined {
	const reservedArg = getReservedElectronAppArg(appArgs);
	return reservedArg
		? `electron.appArgs must not include wrapper-owned launch flag ${reservedArg}.`
		: undefined;
}

function validateOptionalElectronPositiveInteger(input: Record<string, unknown>, fieldName: "maxResults" | "timeoutMs"): { value?: number; error?: string } {
	const value = input[fieldName];
	if (value === undefined) return {};
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return { error: `electron.${fieldName} must be a positive integer when provided.` };
	}
	return { value };
}

function onlyAllowedElectronFields(input: Record<string, unknown>, action: string, allowedFields: ReadonlySet<string>): string | undefined {
	return Object.keys(input).find((fieldName) => !allowedFields.has(fieldName))
		? `electron.${action} does not support electron.${Object.keys(input).find((fieldName) => !allowedFields.has(fieldName))}.`
		: undefined;
}

function compileAgentBrowserElectron(input: unknown): { compiled?: CompiledAgentBrowserElectron; error?: string } {
	if (!isRecord(input)) return { error: "electron must be an object." };
	const action = input.action;
	if (typeof action !== "string" || !AGENT_BROWSER_ELECTRON_ACTIONS.includes(action as AgentBrowserElectronAction)) {
		return { error: `electron.action must be one of: ${AGENT_BROWSER_ELECTRON_ACTIONS.join(", ")}.` };
	}
	for (const fieldName of ["query", "appPath", "appName", "bundleId", "executablePath", "launchId"] as const) {
		const validation = validateOptionalNonEmptyString(input, fieldName);
		if (validation.error) return { error: validation.error };
	}
	for (const fieldName of ["appArgs", "allow", "deny"] as const) {
		const error = validateOptionalElectronStringArray(input, fieldName);
		if (error) return { error };
	}
	const handoffError = validateOptionalElectronEnum(input, "handoff", AGENT_BROWSER_ELECTRON_HANDOFFS);
	if (handoffError) return { error: handoffError };
	const targetTypeError = validateOptionalElectronEnum(input, "targetType", AGENT_BROWSER_ELECTRON_TARGET_TYPES);
	if (targetTypeError) return { error: targetTypeError };
	for (const fieldName of ["maxResults", "timeoutMs"] as const) {
		const validation = validateOptionalElectronPositiveInteger(input, fieldName);
		if (validation.error) return { error: validation.error };
	}
	if (input.all !== undefined && typeof input.all !== "boolean") {
		return { error: "electron.all must be a boolean when provided." };
	}
	if (action === "list") {
		const unsupportedListField = Object.keys(input).find((fieldName) => !AGENT_BROWSER_ELECTRON_LIST_FIELDS.has(fieldName));
		if (unsupportedListField) {
			return { error: `electron.list only supports query and maxResults; remove electron.${unsupportedListField}.` };
		}
		return {
			compiled: {
				action: "list",
				maxResults: validateOptionalElectronPositiveInteger(input, "maxResults").value,
				query: validateOptionalNonEmptyString(input, "query").value,
			},
		};
	}
	if (action === "probe") {
		const unsupportedProbeField = Object.keys(input).find((fieldName) => !AGENT_BROWSER_ELECTRON_PROBE_FIELDS.has(fieldName));
		if (unsupportedProbeField) {
			return { error: `electron.probe only supports action, launchId, and timeoutMs; remove electron.${unsupportedProbeField}.` };
		}
		const launchId = validateOptionalNonEmptyString(input, "launchId").value;
		const timeoutMs = validateOptionalElectronPositiveInteger(input, "timeoutMs").value;
		return {
			compiled: {
				action: "probe",
				...(launchId ? { launchId } : {}),
				...(timeoutMs ? { timeoutMs } : {}),
			},
		};
	}
	if (action === "launch") {
		const allowedFields = new Set(["action", "allow", "appArgs", "appName", "appPath", "bundleId", "deny", "executablePath", "handoff", "targetType", "timeoutMs"]);
		const unsupportedFieldError = onlyAllowedElectronFields(input, action, allowedFields);
		if (unsupportedFieldError) return { error: unsupportedFieldError };
		const appArgs = (input.appArgs as string[] | undefined)?.map((item) => item.trim());
		const appArgsError = validateElectronLaunchAppArgs(appArgs);
		if (appArgsError) return { error: appArgsError };
		const targetFields = ["appPath", "appName", "bundleId", "executablePath"] as const;
		const providedTargets = targetFields.filter((fieldName) => input[fieldName] !== undefined);
		if (providedTargets.length !== 1) {
			return { error: "electron.launch requires exactly one of appPath, appName, bundleId, or executablePath." };
		}
		return {
			compiled: {
				action: "launch",
				allow: (input.allow as string[] | undefined)?.map((item) => item.trim()),
				appArgs,
				deny: (input.deny as string[] | undefined)?.map((item) => item.trim()),
				appName: validateOptionalNonEmptyString(input, "appName").value,
				appPath: validateOptionalNonEmptyString(input, "appPath").value,
				bundleId: validateOptionalNonEmptyString(input, "bundleId").value,
				executablePath: validateOptionalNonEmptyString(input, "executablePath").value,
				handoff: (input.handoff as "connect" | "snapshot" | "tabs" | undefined) ?? "snapshot",
				targetType: (input.targetType as "any" | "page" | "webview" | undefined) ?? "page",
				timeoutMs: validateOptionalElectronPositiveInteger(input, "timeoutMs").value,
			},
		};
	}
	const allowedFields = new Set(["action", "all", "launchId", "timeoutMs"]);
	const unsupportedFieldError = onlyAllowedElectronFields(input, action, allowedFields);
	if (unsupportedFieldError) return { error: unsupportedFieldError };
	if (input.all === true && input.launchId !== undefined) {
		return { error: `electron.${action} accepts launchId or all, not both.` };
	}
	return {
		compiled: {
			action: action as "cleanup" | "status",
			all: input.all === true || undefined,
			launchId: validateOptionalNonEmptyString(input, "launchId").value,
			timeoutMs: validateOptionalElectronPositiveInteger(input, "timeoutMs").value,
		},
	};
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
	if (action === "fill" && text) {
		args.push(text);
	}
}

function getCompiledSemanticActionCommandIndex(compiled: CompiledAgentBrowserSemanticAction): number {
	return compiled.args[0] === "--session" ? 2 : 0;
}

function getCompiledSemanticActionTextArg(compiled: CompiledAgentBrowserSemanticAction): string | undefined {
	if (compiled.action !== "fill") return undefined;
	const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
	if (commandIndex < 0) return undefined;
	const markerIndex = compiled.args.indexOf("--name");
	return markerIndex >= 0 ? compiled.args[markerIndex - 1] : compiled.args[commandIndex + 4];
}

function getCompiledSemanticActionSessionPrefix(compiled: CompiledAgentBrowserSemanticAction): string[] {
	const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
	return commandIndex > 0 ? compiled.args.slice(0, commandIndex) : [];
}

function isCompiledSemanticActionFindCommand(compiled: CompiledAgentBrowserSemanticAction | undefined): boolean {
	if (!compiled) return false;
	return compiled.args[getCompiledSemanticActionCommandIndex(compiled)] === "find";
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
	if (commandIndex < 0 || compiled.args[commandIndex] !== "find") return [];
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

function isAgentBrowserSemanticActionName(value: string | undefined): value is AgentBrowserSemanticActionName {
	return typeof value === "string" && AGENT_BROWSER_SEMANTIC_ACTIONS.includes(value as AgentBrowserSemanticActionName);
}

function getFindNameFlagValue(args: string[], startIndex: number): string | undefined {
	const nameFlagIndex = args.indexOf("--name", startIndex);
	const name = nameFlagIndex >= 0 ? args[nameFlagIndex + 1] : undefined;
	return name && !name.startsWith("-") ? name : undefined;
}

function getFindVisibleRefFallbackTarget(args: string[]): VisibleRefFallbackTarget | undefined {
	const findIndex = args[0] === "--session" ? 2 : 0;
	if (args[findIndex] !== "find") return undefined;
	const locator = args[findIndex + 1];
	const value = args[findIndex + 2];
	const action = args[findIndex + 3];
	if (!locator || !value || !isAgentBrowserSemanticActionName(action) || action === "select") return undefined;
	const text = action === "fill" ? args[findIndex + 4] : undefined;
	if (action === "fill" && (!text || text.startsWith("-"))) return undefined;
	if (locator === "role") {
		const targetName = getFindNameFlagValue(args, findIndex + 4);
		return targetName ? { action, roles: [value], targetName, text } : undefined;
	}
	if (locator === "text" && action === "click") {
		return { action, roles: ["button", "link"], targetName: value };
	}
	if (locator === "label" && action === "fill") {
		return { action, roles: ["textbox"], targetName: value, text };
	}
	if (locator === "placeholder" && action === "fill") {
		return { action, roles: ["searchbox", "textbox"], targetName: value, text };
	}
	return undefined;
}

function getVisibleRefFallbackTarget(options: {
	commandTokens: string[];
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
}): VisibleRefFallbackTarget | undefined {
	return getFindVisibleRefFallbackTarget(options.commandTokens) ?? (options.compiledSemanticAction ? getFindVisibleRefFallbackTarget(options.compiledSemanticAction.args) : undefined);
}

const VISIBLE_REF_FALLBACK_CANDIDATE_LIMIT = 3;

function getVisibleRefFallbackCandidates(target: VisibleRefFallbackTarget, snapshotData: unknown): VisibleRefFallbackCandidate[] {
	const refs = getSnapshotRefRecord(snapshotData);
	if (!refs) return [];
	const roleOrder = target.roles.map((role) => role.toLowerCase());
	const targetName = normalizeSemanticActionAccessibleName(target.targetName);
	const candidates = Object.entries(refs).flatMap(([ref, entry]): VisibleRefFallbackCandidate[] => {
		if (!/^e\d+$/.test(ref) || !isRecord(entry)) return [];
		const role = typeof entry.role === "string" ? entry.role : undefined;
		const name = typeof entry.name === "string" ? entry.name : undefined;
		if (!role || !name || !roleOrder.includes(role.toLowerCase()) || normalizeSemanticActionAccessibleName(name) !== targetName) return [];
		const args = [target.action, `@${ref}`];
		appendSemanticActionTextArg(args, target.action, target.text);
		return [{
			action: target.action,
			args,
			name,
			reason: `Current snapshot shows ${role} ${JSON.stringify(name)} at @${ref}, matching the failed ${target.action} locator exactly.`,
			ref: `@${ref}`,
			role,
		}];
	});
	candidates.sort((left, right) => roleOrder.indexOf(left.role.toLowerCase()) - roleOrder.indexOf(right.role.toLowerCase()) || compareRefIds(left.ref.slice(1), right.ref.slice(1)));
	return candidates.slice(0, VISIBLE_REF_FALLBACK_CANDIDATE_LIMIT);
}

async function collectVisibleRefFallbackDiagnostic(options: {
	commandTokens: string[];
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<VisibleRefFallbackDiagnostic | undefined> {
	if (!options.sessionName) return undefined;
	const target = getVisibleRefFallbackTarget({ commandTokens: options.commandTokens, compiledSemanticAction: options.compiledSemanticAction });
	if (!target) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	const snapshot = extractRefSnapshotFromData(snapshotData);
	if (!snapshot) return undefined;
	const candidates = getVisibleRefFallbackCandidates(target, snapshotData);
	if (candidates.length === 0) return undefined;
	return {
		candidates,
		snapshot,
		summary: candidates.length === 1
			? `Current snapshot has one exact visible ref match for ${target.action} ${JSON.stringify(target.targetName)}.`
			: `Current snapshot has ${candidates.length} exact visible ref matches for ${target.action} ${JSON.stringify(target.targetName)}; choose only if the intended control is unambiguous.`,
		target,
	};
}

function buildVisibleRefFallbackNextActions(options: { diagnostic: VisibleRefFallbackDiagnostic; sessionName?: string }): AgentBrowserNextAction[] {
	const ambiguous = options.diagnostic.candidates.length > 1;
	return options.diagnostic.candidates.map((candidate, index) => ({
		id: ambiguous ? `try-current-visible-ref-${index + 1}` : "try-current-visible-ref",
		params: { args: sessionPrefixArgs(options.sessionName, candidate.args) },
		reason: candidate.reason,
		safety: ambiguous
			? "Several current refs share the same exact role/name. Inspect the snapshot and use only the ref that clearly matches the intended target."
			: "Use only while this current snapshot still represents the page; refresh refs first if the page changed.",
		tool: "agent_browser" as const,
	}));
}

function formatVisibleRefFallbackText(diagnostic: VisibleRefFallbackDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	return [
		"Current snapshot ref fallback:",
		...diagnostic.candidates.map((candidate) => `- ${candidate.ref}${candidate.role ? ` ${candidate.role}` : ""} ${JSON.stringify(candidate.name)}: ${candidate.reason}`),
	].join("\n");
}

function normalizeSemanticActionAccessibleName(name: string): string {
	return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function semanticActionNameMatches(candidateName: string, targetName: string): boolean {
	const normalizedCandidate = normalizeSemanticActionAccessibleName(candidateName);
	const normalizedTarget = normalizeSemanticActionAccessibleName(targetName);
	return normalizedCandidate === normalizedTarget || normalizedCandidate.startsWith(`${normalizedTarget} `);
}

function getCompiledSemanticActionRoleTarget(compiled: CompiledAgentBrowserSemanticAction): { role: string; targetName: string } | undefined {
	if (compiled.locator !== "role" || !["check", "click", "uncheck"].includes(compiled.action)) return undefined;
	const findIndex = compiled.args.indexOf("find");
	if (findIndex < 0 || compiled.args[findIndex + 1] !== "role") return undefined;
	const role = compiled.args[findIndex + 2];
	const nameFlagIndex = compiled.args.indexOf("--name");
	const targetName = nameFlagIndex >= 0 ? compiled.args[nameFlagIndex + 1] : undefined;
	if (!role || !targetName) return undefined;
	return { role, targetName };
}

function findSemanticActionRefInSnapshot(compiled: CompiledAgentBrowserSemanticAction, snapshotData: unknown): string | undefined {
	const target = getCompiledSemanticActionRoleTarget(compiled);
	const refs = getSnapshotRefRecord(snapshotData);
	if (!target || !refs) return undefined;
	const candidates = Object.entries(refs).flatMap(([ref, entry]) => {
		if (!/^e\d+$/.test(ref) || !isRecord(entry)) return [];
		const role = typeof entry.role === "string" ? entry.role : undefined;
		const name = typeof entry.name === "string" ? entry.name : undefined;
		if (!role || !name || role.toLowerCase() !== target.role.toLowerCase() || !semanticActionNameMatches(name, target.targetName)) return [];
		return [{ exact: normalizeSemanticActionAccessibleName(name) === normalizeSemanticActionAccessibleName(target.targetName), name, ref }];
	});
	candidates.sort((left, right) => Number(right.exact) - Number(left.exact) || left.name.length - right.name.length || compareRefIds(left.ref, right.ref));
	return candidates[0]?.ref;
}

interface SemanticActionVisibleRefResolution {
	args: string[];
	snapshot: SessionRefSnapshot;
}

async function resolveSemanticActionVisibleRefArgs(options: {
	compiled: CompiledAgentBrowserSemanticAction | undefined;
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<SemanticActionVisibleRefResolution | undefined> {
	if (!options.compiled || !options.sessionName || !getCompiledSemanticActionRoleTarget(options.compiled)) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	const ref = findSemanticActionRefInSnapshot(options.compiled, snapshotData);
	const snapshot = extractRefSnapshotFromData(snapshotData);
	if (!ref || !snapshot) return undefined;
	return { args: [...getCompiledSemanticActionSessionPrefix(options.compiled), options.compiled.action, `@${ref}`], snapshot };
}

function compileAgentBrowserSemanticAction(input: unknown): { compiled?: CompiledAgentBrowserSemanticAction; error?: string } {
	if (!isRecord(input)) {
		return { error: "semanticAction must be an object." };
	}
	const action = input.action;
	const locator = input.locator;
	const value = input.value;
	const values = input.values;
	const selector = input.selector;
	const text = input.text;
	const role = input.role;
	const name = input.name;
	const session = input.session;
	if (typeof action !== "string" || !AGENT_BROWSER_SEMANTIC_ACTIONS.includes(action as AgentBrowserSemanticActionName)) {
		return { error: `semanticAction.action must be one of: ${AGENT_BROWSER_SEMANTIC_ACTIONS.join(", ")}.` };
	}
	if (session !== undefined && (typeof session !== "string" || session.trim().length === 0)) {
		return { error: "semanticAction.session must be a non-empty string when provided." };
	}
	if (action === "select") {
		if (locator !== undefined || role !== undefined || name !== undefined) {
			return { error: "semanticAction.locator, role, and name are not supported for select; use selector plus value or values." };
		}
		if (text !== undefined) {
			return { error: "semanticAction.text is not supported for select; use value or values for option values." };
		}
		if (typeof selector !== "string" || selector.trim().length === 0) {
			return { error: "semanticAction.selector is required for select." };
		}
		const selectedValues = getSelectValues(input, "semanticAction");
		if (selectedValues.error) return { error: selectedValues.error };
		const args = typeof session === "string" ? ["--session", session, "select", selector, ...(selectedValues.values as string[])] : ["select", selector, ...(selectedValues.values as string[])];
		return { compiled: { action: "select", selector, values: selectedValues.values, args } };
	}
	if (selector !== undefined || values !== undefined) {
		return { error: "semanticAction.selector and values are only supported for select actions." };
	}
	if (typeof locator !== "string" || !AGENT_BROWSER_SEMANTIC_LOCATORS.includes(locator as AgentBrowserSemanticLocator)) {
		return { error: `semanticAction.locator must be one of: ${AGENT_BROWSER_SEMANTIC_LOCATORS.join(", ")}.` };
	}
	if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
		return { error: "semanticAction.value must be a non-empty string when provided." };
	}
	if (role !== undefined && (typeof role !== "string" || role.trim().length === 0)) {
		return { error: "semanticAction.role must be a non-empty string when provided." };
	}
	const locatorValue = locator === "role" && typeof role === "string" ? role : value;
	if (typeof locatorValue !== "string" || locatorValue.trim().length === 0) {
		return { error: locator === "role" ? "semanticAction.value or semanticAction.role must be a non-empty string for locator=role." : "semanticAction.value must be a non-empty string." };
	}
	if (text !== undefined && typeof text !== "string") {
		return { error: "semanticAction.text must be a string when provided." };
	}
	if (action === "fill" && (typeof text !== "string" || text.length === 0)) {
		return { error: `semanticAction.text is required for ${action}.` };
	}
	if (action !== "fill" && text !== undefined) {
		return { error: "semanticAction.text is only supported for fill actions." };
	}
	if (role !== undefined && locator !== "role") {
		return { error: "semanticAction.role is only supported for locator=role." };
	}
	if (role !== undefined && value !== undefined && role !== value) {
		return { error: "semanticAction.role must match value when both are provided for locator=role." };
	}
	if (name !== undefined && (locator !== "role" || typeof name !== "string" || name.length === 0)) {
		return { error: "semanticAction.name is only supported as a non-empty string for locator=role." };
	}
	const args = typeof session === "string" ? ["--session", session, "find", locator, locatorValue, action] : ["find", locator, locatorValue, action];
	if (action === "fill") {
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

interface VisibleRefFallbackCandidate {
	action: AgentBrowserSemanticActionName;
	args: string[];
	name: string;
	reason: string;
	ref: string;
	role: string;
}

interface VisibleRefFallbackDiagnostic {
	candidates: VisibleRefFallbackCandidate[];
	snapshot: SessionRefSnapshot;
	summary: string;
	target: {
		action: AgentBrowserSemanticActionName;
		roles: string[];
		text?: string;
		targetName: string;
	};
}

interface VisibleRefFallbackTarget {
	action: AgentBrowserSemanticActionName;
	roles: string[];
	text?: string;
	targetName: string;
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

function isReadOnlyDiagnosticSessionTargetCommand(command: string | undefined, _subcommand: string | undefined): boolean {
	return command !== undefined && READ_ONLY_DIAGNOSTIC_SESSION_TARGET_COMMANDS.has(command);
}

function extractSessionTabTargetFromCommandData(commandTokens: string[], data: unknown): SessionTabTarget | undefined {
	const [command, subcommand] = commandTokens;
	return isReadOnlyDiagnosticSessionTargetCommand(command, subcommand) ? undefined : extractSessionTabTargetFromData(data);
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
		const resultTarget = extractSessionTabTargetFromCommandData([name, subcommand].filter((token): token is string => token !== undefined), result);
		if (resultTarget) {
			currentTarget = resultTarget;
		}
		pendingTitle = undefined;
	}
	return currentTarget;
}

function batchContainsOnlyReadOnlyDiagnosticTargets(data: unknown): boolean {
	if (!Array.isArray(data) || data.length === 0) {
		return false;
	}
	return data.every((item) => {
		if (!isRecord(item)) return false;
		const [command, subcommand] = extractBatchResultCommand(item);
		return isReadOnlyDiagnosticSessionTargetCommand(command, subcommand);
	});
}

function getRestoredSessionTabTarget(details: Record<string, unknown>, command: string | undefined, subcommand: string | undefined): SessionTabTarget | undefined {
	if (isReadOnlyDiagnosticSessionTargetCommand(command, subcommand)) {
		return undefined;
	}
	const storedTarget = isRecord(details.sessionTabTarget)
		? normalizeSessionTabTarget({
				title: typeof details.sessionTabTarget.title === "string" ? details.sessionTabTarget.title : undefined,
				url: typeof details.sessionTabTarget.url === "string" ? details.sessionTabTarget.url : undefined,
		  })
		: undefined;
	if (command !== "batch") {
		return storedTarget;
	}
	const batchTarget = extractSessionTabTargetFromBatchResults(details.data);
	if (batchTarget) {
		return batchTarget;
	}
	if (isRecord(details.compiledNetworkSourceLookup) || batchContainsOnlyReadOnlyDiagnosticTargets(details.data)) {
		return undefined;
	}
	return storedTarget;
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
		const subcommand = typeof details.subcommand === "string" ? details.subcommand : undefined;
		if (command === "close" && message.isError !== true) {
			restoredOrder += 1;
			restoredTargets.delete(sessionName);
			continue;
		}
		const sessionTabTarget = getRestoredSessionTabTarget(details, command, subcommand);
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

function appendUniqueNextActions(target: AgentBrowserNextAction[], additions: AgentBrowserNextAction[]): AgentBrowserNextAction[] {
	const existingIds = new Set(target.map((action) => action.id));
	for (const action of additions) {
		if (existingIds.has(action.id)) continue;
		target.push(action);
		existingIds.add(action.id);
	}
	return target;
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

function buildElectronPostCommandHealthDiagnostic(options: {
	command?: string;
	record: ElectronLaunchRecord;
	status: ElectronLaunchStatus;
	target?: SessionTabTarget;
}): ElectronPostCommandHealthDiagnostic | undefined {
	let reason: ElectronPostCommandHealthReason | undefined;
	if (options.status.pidAlive === false) reason = "process-dead";
	else if (!options.status.portAlive) reason = "debug-port-dead";
	else if (isAboutBlankUrl(options.target?.url) && getLiveElectronRendererTargets(options.status.targets).length === 0) reason = "about-blank-no-live-target";
	if (!reason) return undefined;
	const nextActions = buildElectronLifecycleNextActions(options.record);
	const commandText = options.command ? `${options.command} command` : "command";
	const statusText = `${options.status.portAlive ? "debug port alive" : "debug port dead"}${options.status.pidAlive === undefined ? "" : options.status.pidAlive ? ", pid alive" : ", pid dead"}`;
	const summary = `Electron lifecycle warning: ${commandText} completed, but launch ${options.record.launchId} is no longer healthy (${statusText}).`;
	return {
		appName: options.record.appName,
		command: options.command,
		launchId: options.record.launchId,
		nextActionIds: nextActions.map((action) => action.id),
		reason,
		sessionName: options.record.sessionName,
		status: options.status,
		summary,
		target: options.target,
	};
}

function formatElectronPostCommandHealthText(diagnostic: ElectronPostCommandHealthDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	const lines = [diagnostic.summary];
	if (diagnostic.target?.url) lines.push(`Current browser session target: ${diagnostic.target.url}.`);
	lines.push(`Status: ${diagnostic.status.portAlive ? "debug port alive" : "debug port dead"}${diagnostic.status.pidAlive === undefined ? "" : diagnostic.status.pidAlive ? ", pid alive" : ", pid dead"}; ${diagnostic.status.targets.length} CDP target(s).`);
	lines.push(`Next: run electron.status/electron.probe with launchId ${diagnostic.launchId}, cleanup the wrapper-owned launch if dead, or relaunch the app.`);
	return lines.join("\n");
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
		? appendUniqueNextActions([...mismatchNextActions], baseNextActions)
		: appendUniqueNextActions([...baseNextActions], mismatchNextActions);
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

function getElectronLaunchFailureCategory(failure: ElectronLaunchFailure): "policy-blocked" | "timeout" | "upstream-error" | "validation-error" {
	if (failure.reason === "policy-blocked") return "policy-blocked";
	if (failure.reason === "timeout") return "timeout";
	if (failure.reason === "non-electron-target") return "validation-error";
	return "upstream-error";
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectElectronHandoff(options: {
	cwd: string;
	handoff: "connect" | "snapshot" | "tabs";
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<ElectronHandoffSummary> {
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
		? appendUniqueNextActions([...mismatchNextActions], baseNextActions)
		: appendUniqueNextActions([...baseNextActions], mismatchNextActions);
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

function formatElectronLaunchText(options: {
	handoff?: ElectronHandoffSummary;
	record: ElectronLaunchRecord;
	targets: ElectronCdpTarget[];
	upstreamText: string;
}): string {
	const lines = [
		`Electron launch: ${options.record.appName} attached as ${options.record.sessionName ?? "managed session"} (launchId ${options.record.launchId}, port ${options.record.port}).`,
		`Identifiers: launchId ${options.record.launchId} for electron.status/electron.cleanup/electron.probe; sessionName ${options.record.sessionName ?? "not attached"} for browser snapshot/tab commands.`,
		...formatElectronTargetLines(options.targets),
	];
	if (options.handoff?.handoff === "snapshot") lines.push(options.handoff.refSnapshot && options.handoff.refSnapshot.refIds.length > 0
		? `Snapshot handoff: ${options.handoff.refSnapshot.refIds.length} interactive ref(s)${options.handoff.snapshotRetryCount ? ` after ${options.handoff.snapshotRetryCount} retry attempt(s)` : ""}.`
		: "Snapshot handoff: no interactive refs returned after a short readiness retry; run snapshot -i once more before assuming the Electron UI is unusable.");
	else if (options.handoff?.handoff === "tabs") lines.push("Tabs handoff completed: safer diagnostic starting point; no interactive refs were captured.");
	else if (options.handoff?.handoff === "connect") lines.push("Connect handoff completed: run snapshot -i before using interactive refs.");
	lines.push(`Cleanup: use details.nextActions cleanup-electron-launch or call electron.cleanup with launchId ${options.record.launchId} when finished.`);
	if (options.handoff?.error) lines.push(`Handoff warning: ${options.handoff.error}`);
	if (options.upstreamText.trim().length > 0) lines.push("", options.upstreamText.trim());
	return lines.join("\n");
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
	pinningRequired?: boolean;
	sessionName?: string;
	stdin?: string;
}): boolean {
	return (
		options.pinningRequired === true &&
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
	const navigationSummarySteps: BatchCommandStep[] = includeNavigationSummary ? [["eval", NAVIGATION_SUMMARY_EVAL]] : [];
	return {
		includeNavigationSummary,
		steps: [tabSelectionStep, commandStep, ...navigationSummarySteps],
		unwrapMode: "single-command",
	};
}

function shouldCorrectSessionTabAfterCommand(options: { command?: string; pinningRequired?: boolean; sessionName?: string }): boolean {
	return (
		options.pinningRequired === true &&
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
	subcommand?: string;
}): SessionTabTarget | undefined {
	if (options.command === "close") {
		return undefined;
	}
	const commandDataTarget = isReadOnlyDiagnosticSessionTargetCommand(options.command, options.subcommand)
		? undefined
		: extractSessionTabTargetFromData(options.data);
	return (
		normalizeSessionTabTarget(options.navigationSummary) ??
		extractSessionTabTargetFromBatchResults(options.data) ??
		commandDataTarget ??
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

	const navigationSummaryStep = options.includeNavigationSummary ? steps[2] : undefined;
	const navigationSummary = normalizeSessionTabTarget(extractNavigationSummaryFromData(navigationSummaryStep?.result));
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
			params: { args: sessionPrefixArgs(sessionName, ["snapshot", "-i"]) },
			reason: "Refresh the UI after a fill that reported success but did not appear to update the input value.",
			safety: "Read-only snapshot; use current refs before retrying.",
			tool: "agent_browser",
		},
		{
			id: "verify-filled-value",
			params: { args: sessionPrefixArgs(sessionName, ["get", "value", diagnostic.selector]) },
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

async function collectFillVerificationDiagnostic(options: {
	commandTokens: string[];
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<FillVerificationDiagnostic | undefined> {
	const fill = getTopLevelFillInvocation(options.commandTokens);
	if (!fill || !options.sessionName) return undefined;
	let valueData: unknown | undefined;
	try {
		valueData = await runSessionCommandData({
			args: ["get", "value", fill.selector],
			cwd: options.cwd,
			sessionName: options.sessionName,
			signal: options.signal,
			timeoutMs: ELECTRON_FILL_VERIFICATION_TIMEOUT_MS,
		});
	} catch {
		return undefined;
	}
	const actual = extractFillVerificationValue(valueData);
	if (actual === undefined || actual === fill.expected) return undefined;
	const diagnostic: FillVerificationDiagnostic = {
		actual: actual.length > 0 ? boundElectronProbeString(actual, 160) : "",
		expected: boundElectronProbeString(fill.expected, 160) ?? fill.expected,
		nextActionIds: [],
		selector: fill.selector,
		status: "mismatch",
		summary: `Fill verification warning: fill ${fill.selector} reported success, but get value returned ${actual.length > 0 ? `"${boundElectronProbeString(actual, 80)}"` : "an empty value"}.`,
	};
	diagnostic.nextActionIds = buildFillVerificationNextActions(diagnostic, options.sessionName).map((action) => action.id);
	return diagnostic;
}

function formatFillVerificationText(diagnostic: FillVerificationDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	const actual = diagnostic.actual !== undefined ? `actual "${diagnostic.actual}"` : "actual value unavailable";
	return `${diagnostic.summary}\nExpected: "${diagnostic.expected}"; ${actual}.\nNext: re-run snapshot -i, then prefer click/focus plus keyboard type for custom Electron quick-input controls before submitting.`;
}

function buildElectronRefFreshnessNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	return [{
		id: "refresh-electron-refs-after-rerender",
		params: { args: sessionPrefixArgs(sessionName, ["snapshot", "-i"]) },
		reason: "Electron UIs often rerender without changing URL; refresh refs before using old @e handles again.",
		safety: "Read-only snapshot; avoids stale same-URL refs after quick-pick, modal, theme, or editor rerenders.",
		tool: "agent_browser",
	}];
}

function buildElectronRefFreshnessDiagnostic(options: {
	command?: string;
	commandTokens: string[];
	record?: ElectronLaunchRecord;
	sessionName?: string;
	stdin?: string;
}): ElectronRefFreshnessDiagnostic | undefined {
	if (!options.record || !shouldInspectElectronPostCommandHealth(options.command)) return undefined;
	if (getGuardedRefUsage(options.commandTokens, options.stdin).length === 0) return undefined;
	const nextActions = buildElectronRefFreshnessNextActions(options.sessionName);
	return {
		command: options.command,
		launchId: options.record.launchId,
		nextActionIds: nextActions.map((action) => action.id),
		sessionName: options.sessionName,
		summary: `Electron ref freshness: ${options.command ?? "mutation"} used page-scoped refs in an Electron UI. Re-run snapshot -i before reusing old @e refs, even if the URL did not change.`,
	};
}

function formatElectronRefFreshnessText(diagnostic: ElectronRefFreshnessDiagnostic | undefined): string | undefined {
	return diagnostic?.summary;
}

async function collectNavigationSummary(options: {
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<NavigationSummary | undefined> {
	return extractNavigationSummaryFromData(await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: NAVIGATION_SUMMARY_EVAL,
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

async function collectScrollPositionSnapshot(options: {
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<ScrollPositionSnapshot | undefined> {
	return extractScrollPositionSnapshot(await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: SCROLL_POSITION_EVAL,
	}));
}

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

function buildScrollNoopDiagnostic(before: ScrollPositionSnapshot | undefined, after: ScrollPositionSnapshot | undefined): ScrollNoopDiagnostic | undefined {
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

function buildScrollNoopNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	const withSession = (args: string[]): string[] => sessionName ? ["--session", sessionName, ...args] : args;
	return [
		{
			id: "inspect-after-noop-scroll",
			params: { args: withSession(["snapshot", "-i"]) },
			reason: "Refresh interactive refs and inspect whether the intended target is inside a nested scroll container.",
			safety: "Do not assume repeated page scrolls will move dashboard panels or nested panes.",
			tool: "agent_browser",
		},
		{
			id: "verify-noop-scroll-visually",
			params: { args: withSession(["screenshot"]) },
			reason: "Capture the current viewport to verify whether the scroll actually changed visible content.",
			safety: "Use screenshot evidence before concluding a dense dashboard did or did not move.",
			tool: "agent_browser",
		},
	];
}

function formatScrollNoopDiagnosticText(diagnostic: ScrollNoopDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	return [
		"Scroll diagnostic: no observed scroll movement.",
		`Reason: ${diagnostic.message}`,
		`Sampled scrollable containers: ${diagnostic.after.containers.length}/${diagnostic.after.containerCount}.`,
		...diagnostic.recommendations.map((recommendation) => `- ${recommendation}`),
	].join("\n");
}

function mergeNavigationSummaryIntoData(data: unknown, navigationSummary: NavigationSummary): unknown {
	if (isRecord(data)) {
		return { ...data, navigationSummary };
	}
	return { navigationSummary, result: data };
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

async function collectComboboxFocusDiagnostic(options: {
	command?: string;
	commandTokens: string[];
	cwd: string;
	semanticAction?: CompiledAgentBrowserSemanticAction;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<ComboboxFocusDiagnostic | undefined> {
	if (!isComboboxFocusDiagnosticCommand(options.command, options.commandTokens) && !isComboboxFocusDiagnosticSemanticAction(options.semanticAction)) return undefined;
	return extractComboboxFocusDiagnostic(await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: COMBOBOX_FOCUS_EVAL,
	}));
}

function buildComboboxFocusNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	const withSession = (args: string[]): string[] => sessionName ? ["--session", sessionName, ...args] : args;
	return [
		{
			id: "inspect-focused-combobox",
			params: { args: withSession(["snapshot", "-i"]) },
			reason: "Inspect the focused combobox and any portal/listbox refs before choosing an option.",
			safety: "Prefer visible option refs or select when a native/selectable option list is exposed.",
			tool: "agent_browser",
		},
		{
			id: "try-open-combobox-with-arrow",
			params: { args: withSession(["press", "ArrowDown"]) },
			reason: "Many searchable comboboxes open their option list with ArrowDown after focus.",
			safety: "Use only when the focused combobox is still the intended control, then re-snapshot before selecting.",
			tool: "agent_browser",
		},
		{
			id: "try-open-combobox-with-enter",
			params: { args: withSession(["press", "Enter"]) },
			reason: "Some comboboxes open or confirm their option list with Enter after focus.",
			safety: "Enter may select a highlighted/default option; prefer ArrowDown first unless Enter is the app's expected opener.",
			tool: "agent_browser",
		},
	];
}

function formatComboboxFocusDiagnosticText(diagnostic: ComboboxFocusDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	const label = diagnostic.activeElement.name ? ` (${diagnostic.activeElement.name})` : "";
	return [
		`Combobox diagnostic: focused combobox did not expose visible options${label}.`,
		`Reason: ${diagnostic.message}`,
		...diagnostic.recommendations.map((recommendation) => `- ${recommendation}`),
	].join("\n");
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

async function collectRecordingDependencyWarning(options: {
	command: string | undefined;
	commandTokens: string[];
	succeeded: boolean;
}): Promise<RecordingDependencyWarning | undefined> {
	if (!options.succeeded) return undefined;
	const recordCommand = getRecordStartLikeCommand(options.command, options.commandTokens);
	if (!recordCommand) return undefined;
	if (await executableExistsOnPath("ffmpeg")) return undefined;
	return {
		command: recordCommand,
		dependency: "ffmpeg",
		message: `${recordCommand} can begin recording, but record stop needs ffmpeg on PATH to encode the WebM output.`,
		reason: "ffmpeg-missing-for-recording",
		recommendations: [
			"Install ffmpeg before relying on this recording workflow; on macOS with Homebrew, brew install ffmpeg or brew install ffmpeg-full.",
			"If ffmpeg was just installed, restart pi or ensure the PATH visible to pi includes the ffmpeg binary before running record stop.",
		],
	};
}

function formatRecordingDependencyWarningText(warning: RecordingDependencyWarning | undefined): string | undefined {
	if (!warning) return undefined;
	return [
		"Recording dependency warning: ffmpeg not found on PATH.",
		`Reason: ${warning.message}`,
		...warning.recommendations.map((recommendation) => `- ${recommendation}`),
	].join("\n");
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

function getSuccessfulGetTextSelectors(options: { commandInfo: CommandInfo; commandTokens: string[]; data: unknown }): string[] {
	return options.commandInfo.command === "get" && options.commandInfo.subcommand === "text"
		? [options.commandTokens[2]].filter((selector): selector is string => typeof selector === "string" && selector.length > 0)
		: options.commandInfo.command === "batch"
			? getBatchGetTextSelectors(options.data)
			: [];
}

async function collectSelectorTextVisibilityDiagnostics(options: {
	commandInfo: CommandInfo;
	commandTokens: string[];
	cwd: string;
	data: unknown;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<SelectorTextVisibilityDiagnostic[]> {
	const selectors = getSuccessfulGetTextSelectors(options);
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

function getSourceLookupElectronContext(options: {
	currentTarget?: SessionTabTarget;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	priorTarget?: SessionTabTarget;
	sessionName?: string;
}): AgentBrowserSourceLookupElectronContext | undefined {
	const record = findElectronLaunchRecordForSession(options.sessionName, options.electronLaunchRecords);
	if (!record) return undefined;
	const url = options.currentTarget?.url ?? options.priorTarget?.url;
	return {
		appName: record.appName,
		appPath: record.appPath,
		executablePath: record.executablePath,
		launchId: record.launchId,
		sessionName: record.sessionName ?? options.sessionName,
		url,
	};
}

function buildSourceLookupElectronNextActions(sourceLookup: AgentBrowserSourceLookupAnalysis | undefined): AgentBrowserNextAction[] {
	if (sourceLookup?.status !== "no-candidates" || !sourceLookup.electronContext) return [];
	const actions: AgentBrowserNextAction[] = [];
	const { launchId, sessionName } = sourceLookup.electronContext;
	if (sessionName) {
		actions.push({
			id: "snapshot-electron-session",
			params: { args: sessionPrefixArgs(sessionName, ["snapshot", "-i"]) },
			reason: "Refresh interactive refs in the attached Electron session before retrying source lookup with a narrower target.",
			safety: "Read-only snapshot; no app mutation.",
			tool: "agent_browser",
		});
	}
	if (launchId) {
		actions.push({
			id: "probe-electron-launch",
			params: { electron: { action: "probe", launchId } },
			reason: "Collect bounded wrapper/session context for the packaged Electron launch after sourceLookup found no candidates.",
			safety: "Read-only probe of title, URL, focus, tabs, and compact snapshot metadata.",
			tool: "agent_browser",
		});
	}
	if (sessionName) {
		actions.push({
			id: "list-electron-tabs",
			params: { args: sessionPrefixArgs(sessionName, ["tab", "list"]) },
			reason: "Check current Electron tabs/targets before choosing a narrower selector or @ref.",
			safety: "Read-only tab listing.",
			tool: "agent_browser",
		});
	}
	return actions;
}

function collectElectronBroadGetTextScopeDiagnostics(options: {
	commandInfo: CommandInfo;
	commandTokens: string[];
	currentTarget?: SessionTabTarget;
	data: unknown;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	priorTarget?: SessionTabTarget;
	sessionName?: string;
}): ElectronBroadGetTextScopeDiagnostic[] {
	const electronContext = getElectronTextScopeContext(options);
	if (!electronContext) return [];
	return getSuccessfulGetTextSelectors(options)
		.filter(isBroadGetTextSelector)
		.map((selector) => ({
			electronContext,
			selector,
			summary: `Broad Electron get text selector warning: selector ${JSON.stringify(selector)} may read the entire app shell; prefer snapshot -i and a current @ref or a narrower panel selector.`,
		}));
}

function formatElectronBroadGetTextScopeText(diagnostics: ElectronBroadGetTextScopeDiagnostic[]): string | undefined {
	return diagnostics.length > 0 ? diagnostics.map((diagnostic) => diagnostic.summary).join("\n") : undefined;
}

function buildElectronBroadGetTextScopeNextActions(options: { diagnostics: ElectronBroadGetTextScopeDiagnostic[]; sessionName?: string }): AgentBrowserNextAction[] {
	return options.diagnostics.map((diagnostic, index) => ({
		id: index === 0 ? "snapshot-for-electron-text-scope" : `snapshot-for-electron-text-scope-${index + 1}`,
		params: { args: sessionPrefixArgs(options.sessionName, ["snapshot", "-i"]) },
		reason: `Refresh Electron refs before trusting broad get text selector ${JSON.stringify(diagnostic.selector)}.`,
		safety: "Read-only snapshot; prefer a current @ref or narrower selector before extracting app-shell text.",
		tool: "agent_browser" as const,
	}));
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

function getEvalStdinHint(options: { command?: string; data: unknown; stdin?: string }): EvalStdinHint | undefined {
	if (options.command !== "eval" || !looksLikeFunctionEvalStdin(options.stdin) || !isRecord(options.data)) return undefined;
	const result = options.data.result;
	if (!isPlainEmptyObject(result)) return undefined;
	return {
		reason: "eval --stdin received a function-shaped snippet and the upstream JSON result was an empty object, which often means the function itself was returned or serialized instead of invoked.",
		suggestion: "Pass a plain expression such as `({ title: document.title })`, or invoke the function explicitly, for example `(() => ({ title: document.title }))()`.",
	};
}

function formatEvalStdinHintText(hint: EvalStdinHint | undefined): string | undefined {
	return hint ? `Eval stdin hint: ${hint.reason} ${hint.suggestion}` : undefined;
}

async function getArtifactCleanupGuidance(options: { command?: string; cwd: string; manifest?: SessionArtifactManifest; succeeded: boolean }): Promise<ArtifactCleanupGuidance | undefined> {
	if (!options.succeeded || options.command !== "close" || !options.manifest || options.manifest.entries.length === 0) return undefined;
	const explicitEntries = options.manifest.entries.filter((entry) => entry.storageScope === "explicit-path");
	const explicitArtifactPaths: string[] = [];
	const seenPaths = new Set<string>();
	for (const entry of explicitEntries) {
		if (explicitArtifactPaths.length >= 10) break;
		const displayPath = entry.path;
		if (seenPaths.has(displayPath)) continue;
		const absolutePath = entry.absolutePath ?? (isAbsolute(entry.path) ? entry.path : resolve(options.cwd, entry.path));
		try {
			await stat(absolutePath);
		} catch {
			continue;
		}
		seenPaths.add(displayPath);
		explicitArtifactPaths.push(displayPath);
	}
	return {
		explicitArtifactPaths,
		note: "Closing the browser session does not delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings; clean existing paths with host file tools when no longer needed.",
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

async function collectQaAttachedTarget(options: {
	currentTarget?: SessionTabTarget;
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<QaAttachedTarget | undefined> {
	if (!options.sessionName) return undefined;
	if (options.currentTarget?.title || options.currentTarget?.url) {
		return { sessionName: options.sessionName, title: options.currentTarget.title, url: options.currentTarget.url };
	}
	return collectElectronManagedSessionTarget({ cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
}

function formatQaAttachedTargetText(target: QaAttachedTarget | undefined): string | undefined {
	if (!target) return undefined;
	return ["QA attached target:", target.sessionName, target.title, target.url].filter((part): part is string => typeof part === "string" && part.length > 0).join(" — ");
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
	let sessionTabTargets = new Map<string, OrderedSessionTabTarget>();
	let sessionRefSnapshots = new Map<string, OrderedSessionRefSnapshot>();
	let sessionTabPinningReasons = new Map<string, "drift" | "restore">();
	let sessionTabTargetUpdateOrder = 0;
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
		sessionTabTargets = restoreSessionTabTargetsFromBranch(ctx.sessionManager.getBranch());
		sessionRefSnapshots = restoreSessionRefSnapshotsFromBranch(ctx.sessionManager.getBranch());
		sessionTabPinningReasons = new Map([...sessionTabTargets.keys()].map((sessionName) => [sessionName, "restore"]));
		sessionTabTargetUpdateOrder = Math.max(getLatestSessionTabTargetOrder(sessionTabTargets), getLatestSessionTabTargetOrder(sessionRefSnapshots));
		artifactManifest = restoreArtifactManifestFromBranch(ctx.sessionManager.getBranch());
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
		sessionTabTargets = new Map<string, OrderedSessionTabTarget>();
		sessionRefSnapshots = new Map<string, OrderedSessionRefSnapshot>();
		sessionTabPinningReasons = new Map<string, "drift" | "restore">();
		sessionTabTargetUpdateOrder = 0;
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
			const electronResult = params.electron === undefined ? {} : compileAgentBrowserElectron(params.electron);
			const hasExplicitArgs = Array.isArray(params.args);
			const explicitInputModes = [hasExplicitArgs, Boolean(semanticActionResult.compiled), Boolean(jobResult.compiled), Boolean(qaResult.compiled), Boolean(sourceLookupResult.compiled), Boolean(networkSourceLookupResult.compiled), Boolean(electronResult.compiled)].filter(Boolean).length;
			const semanticActionError = semanticActionResult.error;
			const jobError = jobResult.error;
			const qaError = qaResult.error;
			const sourceLookupError = sourceLookupResult.error;
			const networkSourceLookupError = networkSourceLookupResult.error;
			const electronError = electronResult.error;
			const inputModeError = explicitInputModes !== 1
				? "Provide exactly one of args, semanticAction, job, qa, sourceLookup, or networkSourceLookup, or electron."
				: undefined;
			const compiledSemanticAction = semanticActionResult.compiled;
			const compiledQaPreset = qaResult.compiled;
			const compiledSourceLookup = sourceLookupResult.compiled;
			const compiledNetworkSourceLookup = networkSourceLookupResult.compiled;
			const compiledElectron = electronResult.compiled;
			const compiledJob = jobResult.compiled ?? compiledQaPreset;
			const compiledGeneratedBatch = compiledNetworkSourceLookup ?? compiledSourceLookup ?? compiledJob;
			const toolArgs = compiledElectron ? [] : compiledSemanticAction?.args ?? compiledGeneratedBatch?.args ?? params.args ?? [];
			const toolStdin = compiledGeneratedBatch?.stdin ?? params.stdin;
			const redactedArgs = redactInvocationArgs(toolArgs);
			const generatedStdinError = params.stdin !== undefined
				? compiledGeneratedBatch
					? "Do not provide stdin with job, qa, sourceLookup, or networkSourceLookup; those modes generate their own batch stdin."
					: compiledElectron
						? "Do not provide stdin with job, qa, sourceLookup, or networkSourceLookup; those modes generate their own batch stdin. Do not provide stdin with electron; electron mode is host-only or manages its own input."
						: undefined
				: undefined;
			const attachedQaSessionError = compiledQaPreset?.checks.attached
				? params.sessionMode === "fresh"
					? "qa.attached cannot be used with sessionMode=fresh; attach or launch a session first, then run qa.attached with the current session."
					: !managedSessionActive
						? "qa.attached requires an active attached session. Run electron.launch or connect to an Electron debug port first."
						: undefined
				: undefined;
			const validationError = semanticActionError ?? jobError ?? qaError ?? sourceLookupError ?? networkSourceLookupError ?? electronError ?? inputModeError ?? generatedStdinError ?? attachedQaSessionError ?? (compiledElectron ? undefined : validateToolArgs(toolArgs) ?? getBatchAnnotateValidationError(toolArgs, toolStdin));
			const redactedCompiledSemanticAction = compiledSemanticAction
				? { ...compiledSemanticAction, args: redactInvocationArgs(compiledSemanticAction.args) }
				: undefined;
			const redactedCompiledElectron: CompiledAgentBrowserElectron | undefined = compiledElectron
				? compiledElectron.action === "list"
					? { ...compiledElectron, query: compiledElectron.query ? redactSensitiveText(compiledElectron.query) : undefined }
					: compiledElectron.action === "launch"
						? { ...compiledElectron, appArgs: compiledElectron.appArgs ? redactInvocationArgs(compiledElectron.appArgs) : undefined }
						: { ...compiledElectron }
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
					args: redactNetworkSourceLookupArgs(compiledNetworkSourceLookup.args),
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
						compiledElectron: redactedCompiledElectron,
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
						cwd: ctx.cwd,
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
						const probe = await collectElectronProbe({ cwd: ctx.cwd, sessionName: probeSessionName, signal, timeoutMs: compiledElectron.timeoutMs });
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
						const order = ++sessionTabTargetUpdateOrder;
						if (sessionTabTarget) sessionTabTargets.set(probe.sessionName, { order, target: sessionTabTarget });
						if (probe.refSnapshot) {
							sessionRefSnapshots.set(probe.sessionName, {
								...probe.refSnapshot,
								order,
								target: probe.refSnapshot.target ?? sessionTabTarget,
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
						return buildElectronHostFailureResult({ compiledElectron: redactedCompiledElectron ?? compiledElectron, errorText: `Electron probe failed: ${errorText}`, failureCategory: "upstream-error" });
					}
				});
			}
			if (compiledElectron?.action === "cleanup") {
				const selection = selectElectronRecords(compiledElectron, electronLaunchRecords);
				if (selection.error) return buildElectronHostFailureResult({ compiledElectron: redactedCompiledElectron ?? compiledElectron, errorText: selection.error, failureCategory: "validation-error" });
				const cleanupResults = await cleanupTrackedElectronLaunches(selection.records ?? [], ctx.cwd, compiledElectron.timeoutMs ?? implicitSessionCloseTimeoutMs);
				return buildElectronCleanupResult(redactedCompiledElectron ?? compiledElectron, cleanupResults);
			}

			const tabTargetUpdateOrder = ++sessionTabTargetUpdateOrder;
			const runTool = async (): Promise<AgentBrowserToolResult> => {
				let runtimeToolArgs = toolArgs;
				let runtimeToolStdin = toolStdin;
				let electronLaunch: ElectronLaunchSuccess | undefined;
				let electronHandoff: ElectronHandoffSummary | undefined;
				let electronFailedConnectCleanup: ElectronCleanupResult | undefined;
				const sessionMode = compiledElectron?.action === "launch" ? "fresh" : params.sessionMode ?? DEFAULT_SESSION_MODE;
				const freshSessionName = createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal + 1);
				if (compiledElectron?.action === "launch") {
					const launchResult = await launchElectronApp(compiledElectron);
					if (!launchResult.ok) {
						const managedSessionOutcome = buildManagedSessionOutcome({
							activeAfter: managedSessionActive,
							activeBefore: managedSessionActive,
							attemptedSessionName: freshSessionName,
							command: "connect",
							currentSessionName: managedSessionName,
							previousSessionName: managedSessionName,
							sessionMode: "fresh",
							succeeded: false,
						});
						return buildElectronHostFailureResult({
							compiledElectron: redactedCompiledElectron ?? compiledElectron,
							errorText: launchResult.failure.error,
							failureCategory: getElectronLaunchFailureCategory(launchResult.failure),
							launchFailure: launchResult.failure,
							managedSessionOutcome,
							status: launchResult.failure.reason,
						});
					}
					electronLaunch = launchResult.value;
					runtimeToolArgs = ["connect", electronLaunch.connectArg];
					runtimeToolStdin = undefined;
				}
				const preparedArgs = await prepareAgentBrowserArgs(runtimeToolArgs, runtimeToolStdin, ctx.cwd);
				const userRequestedJson = runtimeToolArgs.includes("--json");
				let executionPlan = buildExecutionPlan(preparedArgs.args, {
					freshSessionName,
					managedSessionActive,
					managedSessionName,
					sessionMode,
				});
				let semanticActionVisibleRefResolution: SemanticActionVisibleRefResolution | undefined;
				if (!executionPlan.validationError && executionPlan.managedSessionName !== freshSessionName) {
					semanticActionVisibleRefResolution = await resolveSemanticActionVisibleRefArgs({
						compiled: compiledSemanticAction,
						cwd: ctx.cwd,
						sessionName: executionPlan.sessionName,
						signal,
					});
					if (semanticActionVisibleRefResolution) {
						executionPlan = buildExecutionPlan(semanticActionVisibleRefResolution.args, {
							freshSessionName,
							managedSessionActive,
							managedSessionName,
							sessionMode,
						});
					}
				}
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
							compiledElectron: redactedCompiledElectron,
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

				const commandTokens = semanticActionVisibleRefResolution ? extractCommandTokens(semanticActionVisibleRefResolution.args) : extractCommandTokens(preparedArgs.args);
				const exactSensitiveValues = getExactSensitiveStdinValues({
					command: executionPlan.commandInfo.command,
					commandTokens,
					stdin: runtimeToolStdin,
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
					stdin: runtimeToolStdin,
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
				const waitIpcTimeoutError = validateWaitIpcTimeoutContract(commandTokens, runtimeToolStdin);
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
				const sessionTabPinningReason = executionPlan.sessionName ? sessionTabPinningReasons.get(executionPlan.sessionName) : undefined;
				const priorRefSnapshotState = executionPlan.sessionName ? sessionRefSnapshots.get(executionPlan.sessionName) : undefined;
				const resolvedSemanticActionRefSnapshot = semanticActionVisibleRefResolution?.snapshot
					? { ...semanticActionVisibleRefResolution.snapshot, target: semanticActionVisibleRefResolution.snapshot.target ?? priorSessionTabTarget }
					: undefined;
				const staleRefPreflight = buildStaleRefPreflight({
					commandTokens,
					currentTarget: priorSessionTabTarget,
					refSnapshot: resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState,
					stdin: runtimeToolStdin,
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
				let processStdin = preparedArgs.stdin ?? runtimeToolStdin;
				if (
					priorSessionTabTarget &&
					shouldPinSessionTabForCommand({
						command: executionPlan.commandInfo.command,
						commandTokens,
						pinningRequired: sessionTabPinningReason !== undefined,
						sessionName: executionPlan.sessionName,
						stdin: runtimeToolStdin,
					})
				) {
					const plannedSessionTabSelection = await collectSessionTabSelection({
						cwd: ctx.cwd,
						sessionName: executionPlan.sessionName,
						signal,
						target: priorSessionTabTarget,
					});
					if (plannedSessionTabSelection && executionPlan.sessionName) {
						if (executionPlan.commandInfo.command === "eval" && runtimeToolStdin !== undefined) {
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
								stdin: runtimeToolStdin,
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
				const shouldProbeScrollNoop = executionPlan.commandInfo.command === "scroll" && executionPlan.startupScopedFlags.length === 0;
				const scrollPositionBefore = shouldProbeScrollNoop
					? await collectScrollPositionSnapshot({
							cwd: ctx.cwd,
							sessionName: executionPlan.sessionName,
							signal,
					  })
					: undefined;

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
					let missingBinaryElectronCleanup: ElectronCleanupResult | undefined;
					let missingBinaryElectronRecord: ElectronLaunchRecord | undefined;
					if (electronLaunch) {
						missingBinaryElectronCleanup = await cleanupElectronLaunchResources({
							child: electronLaunch.child,
							record: electronLaunch.record,
							timeoutMs: implicitSessionCloseTimeoutMs,
						});
						missingBinaryElectronRecord = missingBinaryElectronCleanup.record;
					}
					const textParts = [errorText, managedSessionOutcomeText, missingBinaryElectronCleanup ? `Electron cleanup after failed attach: ${missingBinaryElectronCleanup.summary}` : undefined]
						.filter((part): part is string => part !== undefined && part.length > 0);
					return {
						content: [{ type: "text", text: textParts.join("\n\n") }],
						details: {
							args: redactedArgs,
							compatibilityWorkaround,
							effectiveArgs: redactedProcessArgs,
							electron: missingBinaryElectronRecord ? {
								action: "launch" as const,
								cleanup: missingBinaryElectronCleanup,
								launch: missingBinaryElectronRecord,
								status: "failed" as const,
								targets: electronLaunch?.targets,
								version: electronLaunch?.version,
							} : undefined,
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
						hasLaunchScopedTabCorrectionFlag(runtimeToolArgs) &&
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
						extractSessionTabTargetFromCommandData(commandTokens, presentationEnvelope?.data);
					let currentSessionTabTarget = deriveSessionTabTarget({
						command: executionPlan.commandInfo.command,
						data: presentationEnvelope?.data,
						navigationSummary,
						previousTarget: priorSessionTabTarget,
						subcommand: executionPlan.commandInfo.subcommand,
					});
					let aboutBlankSessionMismatch: AboutBlankSessionMismatch | undefined;
					let electronPostCommandHealth: ElectronPostCommandHealthDiagnostic | undefined;
					let electronRefFreshnessDiagnostic: ElectronRefFreshnessDiagnostic | undefined;
					let electronSessionMismatch: ElectronSessionMismatch | undefined;
					let electronStatusAfterCommand: ElectronLaunchStatus | undefined;
					const shouldTreatAboutBlankAsMismatch =
						succeeded &&
						priorSessionTabTarget !== undefined &&
						!isAboutBlankSessionTabTarget(priorSessionTabTarget) &&
						isAboutBlankSessionTabTarget(observedSessionTabTarget ?? currentSessionTabTarget) &&
						!commandExplicitlyTargetsAboutBlank(commandTokens);
					if (shouldTreatAboutBlankAsMismatch && priorSessionTabTarget) {
						const aboutBlankObservedTarget = observedSessionTabTarget ?? currentSessionTabTarget;
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
						const electronRecord = findElectronLaunchRecordForSession(executionPlan.sessionName, electronLaunchRecords);
						if (electronRecord && executionPlan.sessionName) {
							electronStatusAfterCommand = await inspectElectronLaunchStatus(electronRecord);
							electronSessionMismatch = buildElectronSessionMismatch({
								managedSession: {
									sessionName: executionPlan.sessionName,
									title: aboutBlankObservedTarget?.title,
									url: aboutBlankObservedTarget?.url ?? "about:blank",
								},
								record: electronRecord,
								statusTargets: electronStatusAfterCommand.targets,
							});
						}
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
							pinningRequired: sessionTabPinningReason !== undefined,
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
					const electronRecordForCommand = findElectronLaunchRecordForSession(executionPlan.sessionName, electronLaunchRecords);
					if (succeeded && electronRecordForCommand && shouldInspectElectronPostCommandHealth(executionPlan.commandInfo.command)) {
						electronStatusAfterCommand ??= await inspectElectronLaunchStatus(electronRecordForCommand);
						electronPostCommandHealth = buildElectronPostCommandHealthDiagnostic({
							command: executionPlan.commandInfo.command,
							record: electronRecordForCommand,
							status: electronStatusAfterCommand,
							target: observedSessionTabTarget ?? currentSessionTabTarget,
						});
						if (electronPostCommandHealth && electronPostCommandHealth.reason !== "process-dead") {
							await sleepMs(ELECTRON_POST_COMMAND_STATUS_SETTLE_MS);
							electronStatusAfterCommand = await inspectElectronLaunchStatus(electronRecordForCommand);
							electronPostCommandHealth = buildElectronPostCommandHealthDiagnostic({
								command: executionPlan.commandInfo.command,
								record: electronRecordForCommand,
								status: electronStatusAfterCommand,
								target: observedSessionTabTarget ?? currentSessionTabTarget,
							});
						}
						if (electronPostCommandHealth) {
							succeeded = false;
						}
					}
					let fillVerificationDiagnostic: FillVerificationDiagnostic | undefined;
					let selectorTextVisibilityDiagnostics: SelectorTextVisibilityDiagnostic[] = [];
					let electronBroadGetTextScopeDiagnostics: ElectronBroadGetTextScopeDiagnostic[] = [];
					const timeoutPartialProgress = processResult.timedOut ? await collectTimeoutPartialProgress({
						command: executionPlan.commandInfo.command,
						compiledJob,
						cwd: ctx.cwd,
						sessionName: executionPlan.sessionName,
						stdin: runtimeToolStdin,
					}) : undefined;
					if (succeeded && electronRecordForCommand) {
						fillVerificationDiagnostic = await collectFillVerificationDiagnostic({
							commandTokens,
							cwd: ctx.cwd,
							sessionName: executionPlan.sessionName,
							signal,
						});
						electronRefFreshnessDiagnostic = buildElectronRefFreshnessDiagnostic({
							command: executionPlan.commandInfo.command,
							commandTokens,
							record: electronRecordForCommand,
							sessionName: executionPlan.sessionName,
							stdin: runtimeToolStdin,
						});
					}
					if (succeeded && !sessionTabCorrection && !aboutBlankSessionMismatch && !electronRecordForCommand) {
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
						electronBroadGetTextScopeDiagnostics = collectElectronBroadGetTextScopeDiagnostics({
							commandInfo: executionPlan.commandInfo,
							commandTokens,
							currentTarget: currentSessionTabTarget,
							data: presentationEnvelope?.data,
							electronLaunchRecords,
							priorTarget: priorSessionTabTarget,
							sessionName: executionPlan.sessionName,
						});
					}
					const comboboxFocusDiagnostic = succeeded
						? await collectComboboxFocusDiagnostic({
								command: executionPlan.commandInfo.command,
								commandTokens,
								cwd: ctx.cwd,
								semanticAction: compiledSemanticAction,
								sessionName: executionPlan.sessionName,
								signal,
						  })
						: undefined;
					const recordingDependencyWarning = await collectRecordingDependencyWarning({
						command: executionPlan.commandInfo.command,
						commandTokens,
						succeeded,
					});
					const scrollNoopDiagnostic = succeeded && shouldProbeScrollNoop
						? buildScrollNoopDiagnostic(
							scrollPositionBefore,
							await collectScrollPositionSnapshot({
								cwd: ctx.cwd,
								sessionName: executionPlan.sessionName,
								signal,
							}),
						)
						: undefined;
					let currentRefSnapshot: SessionRefSnapshot | undefined;
					if (executionPlan.sessionName) {
						const activeSessionTabTargetState = sessionTabTargets.get(executionPlan.sessionName);
						if (shouldApplySessionTabTargetUpdate({ current: activeSessionTabTargetState, updateOrder: tabTargetUpdateOrder })) {
							if (executionPlan.commandInfo.command === "close" && succeeded) {
								sessionTabTargets.delete(executionPlan.sessionName);
								sessionRefSnapshots.delete(executionPlan.sessionName);
								sessionTabPinningReasons.delete(executionPlan.sessionName);
							} else if (currentSessionTabTarget) {
								sessionTabTargets.set(executionPlan.sessionName, { order: tabTargetUpdateOrder, target: currentSessionTabTarget });
							}
						} else if (succeeded && currentSessionTabTarget) {
							// A stale overlapping command may have moved browser focus even though its older target
							// must not replace the newer logical target. Require tab pinning on the next call.
							sessionTabPinningReasons.set(executionPlan.sessionName, "drift");
						}
						const refSnapshot = succeeded
			? executionPlan.commandInfo.command === "snapshot"
				? extractRefSnapshotFromData(presentationEnvelope?.data)
				: executionPlan.commandInfo.command === "batch"
					? extractRefSnapshotFromBatchResults(presentationEnvelope?.data)
					: resolvedSemanticActionRefSnapshot ?? overlayBlockerDiagnostic?.snapshot
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
					if (executionPlan.sessionName && succeeded) {
						if (openResultTabCorrection || sessionTabCorrection || aboutBlankSessionMismatch?.recoveryApplied) {
							sessionTabPinningReasons.set(executionPlan.sessionName, "drift");
						} else if (sessionTabPinningReason === "restore") {
							sessionTabPinningReasons.delete(executionPlan.sessionName);
						}
					}

					if (replacedManagedSessionName) {
						sessionTabTargets.delete(replacedManagedSessionName);
						sessionRefSnapshots.delete(replacedManagedSessionName);
						sessionTabPinningReasons.delete(replacedManagedSessionName);
						await closeManagedSession({
							cwd: priorManagedSessionCwd,
							sessionName: replacedManagedSessionName,
							timeoutMs: implicitSessionCloseTimeoutMs,
						});
					}

					let electronLaunchRecord: ElectronLaunchRecord | undefined;
					if (electronLaunch) {
						if (succeeded && executionPlan.sessionName) {
							electronLaunchRecord = { ...electronLaunch.record, sessionName: executionPlan.sessionName };
							electronLaunchRecords.set(electronLaunchRecord.launchId, electronLaunchRecord);
							electronChildProcesses.set(electronLaunchRecord.launchId, electronLaunch.child);
							const electronHandoffMode = compiledElectron?.action === "launch" ? compiledElectron.handoff : "connect";
							try {
								electronHandoff = await collectElectronHandoff({
									cwd: ctx.cwd,
									handoff: electronHandoffMode,
									sessionName: executionPlan.sessionName,
									signal,
								});
							} catch (error) {
								electronHandoff = { error: error instanceof Error ? error.message : String(error), handoff: electronHandoffMode };
							}
							if (electronHandoff.refSnapshot) {
								currentRefSnapshot = electronHandoff.refSnapshot;
								sessionRefSnapshots.set(executionPlan.sessionName, { ...electronHandoff.refSnapshot, order: tabTargetUpdateOrder });
								if (electronHandoff.refSnapshot.target) {
									currentSessionTabTarget = electronHandoff.refSnapshot.target;
									sessionTabTargets.set(executionPlan.sessionName, { order: tabTargetUpdateOrder, target: electronHandoff.refSnapshot.target });
								}
							}
						} else {
							electronFailedConnectCleanup = await cleanupElectronLaunchResources({ child: electronLaunch.child, record: electronLaunch.record, timeoutMs: implicitSessionCloseTimeoutMs });
							electronLaunchRecord = electronFailedConnectCleanup.record;
						}
					}

					const errorText = getAgentBrowserErrorText({
						aborted: processResult.aborted,
						command: executionPlan.commandInfo.command,
						effectiveArgs: redactedProcessArgs,
						envelope: presentationEnvelope,
						exitCode: processResult.exitCode,
						parseError,
						plainTextInspection,
						staleRefArgs: getStaleRefArgs(commandTokens, runtimeToolStdin),
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
					const qaAttachedTarget = compiledQaPreset?.checks.attached
						? await collectQaAttachedTarget({ currentTarget: currentSessionTabTarget ?? priorSessionTabTarget, cwd: ctx.cwd, sessionName: executionPlan.sessionName, signal })
						: undefined;
					const sourceLookupElectronContext = compiledSourceLookup ? getSourceLookupElectronContext({
						currentTarget: currentSessionTabTarget,
						electronLaunchRecords,
						priorTarget: priorSessionTabTarget,
						sessionName: executionPlan.sessionName,
					}) : undefined;
					const sourceLookup = compiledSourceLookup ? await analyzeSourceLookupResults(presentationEnvelope?.data, compiledSourceLookup, ctx.cwd, {
						electronContext: sourceLookupElectronContext,
						workspaceRoot: ctx.cwd,
					}) : undefined;
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
					const qaAttachedTargetText = formatQaAttachedTargetText(qaAttachedTarget);
					if (qaAttachedTargetText && presentation.content[0]?.type === "text") {
						presentation.content[0] = { ...presentation.content[0], text: `${qaAttachedTargetText}\n\n${presentation.content[0].text}` };
					} else if (qaAttachedTargetText) {
						presentation.content.unshift({ type: "text", text: qaAttachedTargetText });
					}
					if (managedSessionOutcome && managedSessionOutcome.succeeded !== succeeded) {
						managedSessionOutcome = { ...managedSessionOutcome, succeeded };
					}
					const evalStdinHint = getEvalStdinHint({
						command: executionPlan.commandInfo.command,
						data: presentationEnvelope?.data,
						stdin: runtimeToolStdin,
					});
					const resultArtifactManifest = presentation.artifactManifest ?? artifactManifest;
					const artifactCleanup = await getArtifactCleanupGuidance({
						command: executionPlan.commandInfo.command,
						cwd: ctx.cwd,
						manifest: resultArtifactManifest,
						succeeded,
					});
					const warningText = electronPostCommandHealth
						? formatElectronPostCommandHealthText(electronPostCommandHealth)
						: electronSessionMismatch
							? formatElectronSessionMismatchText(electronSessionMismatch)
							: aboutBlankSessionMismatch ? buildAboutBlankWarning(aboutBlankSessionMismatch) : undefined;
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
						failureCategory: presentation.failureCategory ?? presentation.batchFailure?.failedStep.failureCategory ?? (electronPostCommandHealth ? "tab-drift" : undefined),
						inspection: plainTextInspection,
						parseError,
						savedFile: presentation.savedFile,
						spawnError: processResult.spawnError?.message,
						succeeded,
						tabDrift: !succeeded && (aboutBlankSessionMismatch !== undefined || electronPostCommandHealth !== undefined || sessionTabCorrection !== undefined),
						timedOut: processResult.timedOut,
						validationError: undefined,
					});
					let visibleRefFallbackDiagnostic: VisibleRefFallbackDiagnostic | undefined;
					const visibleRefFallbackSessionName = executionPlan.sessionName ?? extractExplicitSessionName(runtimeToolArgs);
					if (categoryDetails.failureCategory === "selector-not-found") {
						visibleRefFallbackDiagnostic = await collectVisibleRefFallbackDiagnostic({
							commandTokens,
							compiledSemanticAction,
							cwd: ctx.cwd,
							sessionName: visibleRefFallbackSessionName,
							signal,
						});
						if (visibleRefFallbackDiagnostic && visibleRefFallbackSessionName && shouldApplySessionTabTargetUpdate({ current: sessionRefSnapshots.get(visibleRefFallbackSessionName), updateOrder: tabTargetUpdateOrder })) {
							currentRefSnapshot = { ...visibleRefFallbackDiagnostic.snapshot, target: visibleRefFallbackDiagnostic.snapshot.target ?? currentSessionTabTarget };
							sessionRefSnapshots.set(visibleRefFallbackSessionName, { ...currentRefSnapshot, order: tabTargetUpdateOrder });
						}
					}
					let nextActions = presentation.nextActions ? [...presentation.nextActions] : undefined;
					if (categoryDetails.failureCategory === "stale-ref") {
						nextActions = sessionAwareStaleRefNextActions(executionPlan.sessionName);
					}
					if (visibleRefFallbackDiagnostic) {
						(nextActions ??= []).push(...buildVisibleRefFallbackNextActions({ diagnostic: visibleRefFallbackDiagnostic, sessionName: visibleRefFallbackSessionName }));
					}
					if (electronPostCommandHealth) {
						const electronRecord = electronLaunchRecords.get(electronPostCommandHealth.launchId);
						if (electronRecord) {
							nextActions = appendUniqueNextActions(nextActions ?? [], buildElectronLifecycleNextActions(electronRecord));
						}
					}
					if (electronSessionMismatch) {
						const electronRecord = electronLaunchRecords.get(electronSessionMismatch.launchId);
						if (electronRecord) {
							nextActions = appendUniqueNextActions(nextActions ?? [], buildElectronMismatchNextActions(electronRecord, electronSessionMismatch.liveTarget));
						}
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
					if (fillVerificationDiagnostic) {
						nextActions = appendUniqueNextActions(nextActions ?? [], buildFillVerificationNextActions(fillVerificationDiagnostic, executionPlan.sessionName));
					}
					if (electronRefFreshnessDiagnostic) {
						nextActions = appendUniqueNextActions(nextActions ?? [], buildElectronRefFreshnessNextActions(executionPlan.sessionName));
					}
					if (selectorTextVisibilityDiagnostics.length > 0) {
						(nextActions ??= []).push(...buildSelectorTextVisibilityNextActions({ diagnostics: selectorTextVisibilityDiagnostics, sessionName: executionPlan.sessionName }));
					}
					if (electronBroadGetTextScopeDiagnostics.length > 0) {
						(nextActions ??= []).push(...buildElectronBroadGetTextScopeNextActions({ diagnostics: electronBroadGetTextScopeDiagnostics, sessionName: executionPlan.sessionName }));
					}
					if (sourceLookup?.electronContext) {
						nextActions = appendUniqueNextActions(nextActions ?? [], buildSourceLookupElectronNextActions(sourceLookup));
					}
					if (scrollNoopDiagnostic) {
						(nextActions ??= []).push(...buildScrollNoopNextActions(executionPlan.sessionName));
					}
					if (comboboxFocusDiagnostic) {
						(nextActions ??= []).push(...buildComboboxFocusNextActions(executionPlan.sessionName));
					}
					if (categoryDetails.failureCategory === "stale-ref" && redactedCompiledSemanticAction && isCompiledSemanticActionFindCommand(compiledSemanticAction)) {
						(nextActions ??= []).push({
							id: "retry-semantic-action-after-stale-ref",
							params: { args: redactedCompiledSemanticAction.args },
							reason: "Retry the same semantic target via its compiled find command after the upstream stale-ref failure proves the prior action did not execute.",
							safety: "Use only for the same intended target; direct stale @refs still require a fresh snapshot or stable locator before retrying.",
							tool: "agent_browser" as const,
						});
					}
					if (electronLaunchRecord) {
						(nextActions ??= []).push(...(buildAgentBrowserNextActions({
							electron: { launchId: electronLaunchRecord.launchId, sessionName: electronLaunchRecord.sessionName, status: electronLaunchRecord.cleanupState },
							failureCategory: categoryDetails.failureCategory,
							resultCategory: categoryDetails.resultCategory,
							successCategory: categoryDetails.successCategory,
						}) ?? []));
					}
					const pageChangeSummary = (scrollNoopDiagnostic || comboboxFocusDiagnostic) && presentation.pageChangeSummary
						? { ...presentation.pageChangeSummary, nextActionIds: nextActions?.map((action) => action.id) }
						: presentation.pageChangeSummary;
					const details = {
						args: redactedArgs,
						compiledElectron: redactedCompiledElectron,
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
						electron: electronLaunchRecord ? {
							action: "launch" as const,
							cleanup: electronFailedConnectCleanup,
							handoff: electronHandoff,
							identifiers: buildElectronIdentifiers(electronLaunchRecord),
							launch: electronLaunchRecord,
							status: succeeded ? "succeeded" as const : "failed" as const,
							targets: electronLaunch?.targets,
							version: electronLaunch?.version,
						} : undefined,
						...categoryDetails,
						aboutBlankSessionMismatch,
						electronPostCommandHealth,
						electronRefFreshness: electronRefFreshnessDiagnostic,
						electronSessionMismatch,
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
						pageChangeSummary,
						overlayBlockers: overlayBlockerDiagnostic,
						fillVerification: fillVerificationDiagnostic,
						visibleRefFallback: visibleRefFallbackDiagnostic,
						comboboxFocus: comboboxFocusDiagnostic,
						recordingDependencyWarning,
						scrollNoop: scrollNoopDiagnostic,
						qaPreset,
						qaAttachedTarget,
						electronGetTextScopeWarning: electronBroadGetTextScopeDiagnostics[0],
						electronGetTextScopeWarnings: electronBroadGetTextScopeDiagnostics.length > 1 ? electronBroadGetTextScopeDiagnostics : undefined,
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

					const visibleRefFallbackText = formatVisibleRefFallbackText(visibleRefFallbackDiagnostic);
					const semanticActionCandidateText = nextActions ? formatSemanticActionCandidateText(nextActions) : undefined;
					const overlayBlockerText = overlayBlockerDiagnostic ? formatOverlayBlockerText(overlayBlockerDiagnostic) : undefined;
					const fillVerificationText = formatFillVerificationText(fillVerificationDiagnostic);
					const electronRefFreshnessText = formatElectronRefFreshnessText(electronRefFreshnessDiagnostic);
					const selectorTextVisibilityText = formatSelectorTextVisibilityText(selectorTextVisibilityDiagnostics);
					const electronBroadGetTextScopeText = formatElectronBroadGetTextScopeText(electronBroadGetTextScopeDiagnostics);
					const scrollNoopDiagnosticText = formatScrollNoopDiagnosticText(scrollNoopDiagnostic);
					const comboboxFocusDiagnosticText = formatComboboxFocusDiagnosticText(comboboxFocusDiagnostic);
					const recordingDependencyWarningText = formatRecordingDependencyWarningText(recordingDependencyWarning);
					const evalStdinHintText = formatEvalStdinHintText(evalStdinHint);
					const artifactCleanupText = formatArtifactCleanupGuidanceText(artifactCleanup);
					const timeoutPartialProgressText = timeoutPartialProgress ? formatTimeoutPartialProgressText(timeoutPartialProgress) : undefined;
					const managedSessionOutcomeText = formatManagedSessionOutcomeText(managedSessionOutcome);
					const rawAppendedDiagnosticText = [visibleRefFallbackText, semanticActionCandidateText, overlayBlockerText, fillVerificationText, electronRefFreshnessText, selectorTextVisibilityText, electronBroadGetTextScopeText, scrollNoopDiagnosticText, comboboxFocusDiagnosticText, recordingDependencyWarningText, evalStdinHintText, artifactCleanupText, timeoutPartialProgressText, managedSessionOutcomeText].filter((item): item is string => item !== undefined).join("\n\n");
					const appendedDiagnosticText = redactSensitiveText(redactExactSensitiveText(rawAppendedDiagnosticText, exactSensitiveValues));
					const shouldAppendDiagnosticText = appendedDiagnosticText.length > 0 && (!userRequestedJson || plainTextInspection);
					let content = shouldAppendDiagnosticText && redactedContent[0]?.type === "text"
						? [
							{ ...redactedContent[0], text: `${redactedContent[0].text}\n\n${appendedDiagnosticText}` },
							...redactedContent.slice(1),
						]
						: redactedContent;
					if (electronLaunchRecord && succeeded && content[0]?.type === "text") {
						content = [{
							...content[0],
							text: redactSensitiveText(formatElectronLaunchText({
								handoff: electronHandoff,
								record: electronLaunchRecord,
								targets: electronLaunch?.targets ?? [],
								upstreamText: content[0].text,
							})),
						}, ...content.slice(1)];
					}
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
