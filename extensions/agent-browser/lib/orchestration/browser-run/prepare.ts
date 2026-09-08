import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { getBooleanFlagValue, isUpstreamEnvFlagEnabled, projectUpstreamGlobalFlags } from "../../argv-grammar.js";
import { isCloseCommand } from "../../command-taxonomy.js";
import { cleanupElectronLaunchResources } from "../../electron/cleanup.js";
import { launchElectronApp, type ElectronLaunchSuccess } from "../../electron/launch.js";
import { pathExists } from "../../fs-utils.js";
import { getCompiledSemanticActionSessionPrefix } from "../../input-modes/semantic-action.js";
import { type CompiledAgentBrowserSemanticAction } from "../../input-modes/types.js";
import { tryDirectAnchorDownload } from "./prepare/direct-anchor-download.js";
import { tryNetworkRequestsPageFilter } from "./prepare/network-page-filter.js";
import { tryContainerScroll, tryPageScrollTo } from "./prepare/scroll-shims.js";
import { trySnapshotFilter } from "./prepare/snapshot-filter.js";
import { commandTimeoutNeedsActivePageUrl, getCommandAwareProcessTimeoutMs } from "./prepare/wait-timeouts.js";
import { getPersistentSessionArtifactStore } from "./session-state.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { applyNamespaceToNextActions } from "../../results/next-actions.js";
import { buildSessionAwareStaleRefNextActions, buildSessionTabRecoveryNextActions } from "../../results/recovery-next-actions.js";
import { resolveVisibleRefActionFromSnapshot } from "../../results/selector-recovery.js";
import { buildPageTransitionRefSnapshotInvalidation, extractRefSnapshotFromData, normalizeComparableUrl, type SessionRefSnapshot, type SessionTabTarget } from "../../session-page-state.js";
import {
	buildExecutionPlan,
	canUseHeadlessCompatibilityUserAgent,
	createFreshSessionName,
	extractCommandTokens,
	extractUpstreamCommandTokens,
	getDefaultHeadlessCompatUserAgent,
	parseWaitCommandTokens,
	redactInvocationArgs,
	redactSensitiveText,
	type CompatibilityWorkaround,
} from "../../runtime.js";
import {
	buildOwnedManagedSessionRestoreContext,
	resolveExplicitAutosaveInterval,
	withOwnedManagedSessionContext,
} from "../../managed-session-restore.js";
import type { ManagedSessionPolicyLock } from "../../managed-session-policy-lock.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import {
	getExplicitSessionPageVerificationRequirement,
	getPageTargetValidationError,
} from "../../page-target-validation.js";
import { acquireOwnedManagedSessionDaemonPolicy, getRunningHeadedAutosavePolicyChangeError } from "./managed-session-daemon-policy.js";
import {
	buildManagedSessionOutcome,
	buildSessionDetailFields,
	buildStaleRefPreflight,
	getSessionContextKey,
	findElectronLaunchRecordForSession,
	extractStringResultField,
	ensureSessionTabTarget,
	getGuardedRefUsage,
	getTraceOwnerGuardMessage,
	runSessionCommandData,
	shouldPinSessionTabForCommand,
} from "./session-state.js";
import { getUpstreamEffectiveBatchSteps, parseBatchStdinJsonArray } from "../batch-stdin.js";
import { buildElectronHostFailureResult, formatAgentBrowserNextActionsText, getElectronLaunchFailureCategory, redactRecoveryHint } from "./final-result.js";
import { prepareClickDispatchProbe } from "./click-dispatch.js";
import { buildUnsupportedScrollIntoViewRecovery, collectScrollPositionSnapshot, validateQaAttachedPrecondition } from "./diagnostics.js";
import { getScreenshotPathTokenIndex } from "./artifact-paths.js";
import { findRequestedArtifactCloseViolation } from "./prompt-guards.js";

import type {
	BrowserRunInputFields,
	BrowserRunOptions,
	BrowserRunStatePatch,
	PreparedAgentBrowserArgs,
	PreparedBrowserRun,
	PrepareBrowserRunResult,
	ScreenshotArtifactRequest,
	ScreenshotPathRequest,
	SemanticActionVisibleRefResolution,
	StaleRefPreflight,
} from "./types.js";

export function normalizeRunInput(input: BrowserRunOptions["input"]): BrowserRunInputFields {
	const base = { redactedArgs: input.redactedArgs, toolArgs: input.toolArgs, toolStdin: input.toolStdin };
	switch (input.kind) {
		case "electron":
			return { ...base, compiledElectron: input.compiledElectron, redactedCompiledElectron: input.redactedCompiledElectron };
		case "job":
			return { ...base, compiledJob: input.compiledJob, redactedCompiledJob: input.redactedCompiledJob };
		case "networkSourceLookup":
			return { ...base, compiledNetworkSourceLookup: input.compiledNetworkSourceLookup, redactedCompiledNetworkSourceLookup: input.redactedCompiledNetworkSourceLookup };
		case "qa":
			return { ...base, compiledJob: input.compiledJob, compiledQaPreset: input.compiledQaPreset, redactedCompiledJob: input.redactedCompiledJob, redactedCompiledQaPreset: input.redactedCompiledQaPreset };
		case "semanticAction":
			return { ...base, compiledSemanticAction: input.compiledSemanticAction, redactedCompiledSemanticAction: input.redactedCompiledSemanticAction };
		case "sourceLookup":
			return { ...base, compiledSourceLookup: input.compiledSourceLookup, redactedCompiledSourceLookup: input.redactedCompiledSourceLookup };
		case "script":
		case "args":
			return base;
	}
}

export function buildInvocationPreview(effectiveArgs: string[]): string {
	const preview = effectiveArgs.join(" ");
	return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

function getArtifactParentPathTokenIndex(commandTokens: string[]): number | undefined {
	if (commandTokens[0] === "download" && commandTokens.length >= 3) return 2;
	if (commandTokens[0] === "pdf" && commandTokens.length >= 2) return 1;
	if (commandTokens[0] === "state" && commandTokens[1] === "save" && commandTokens.length >= 3) return 2;
	if (commandTokens[0] === "wait") return parseWaitCommandTokens(commandTokens).downloadPathIndex;
	return undefined;
}

async function ensureArtifactParentDirectory(commandTokens: string[], cwd: string): Promise<void> {
	const pathIndex = getArtifactParentPathTokenIndex(commandTokens);
	if (pathIndex === undefined) return;
	const requestedPath = commandTokens[pathIndex];
	if (!requestedPath) return;
	await mkdir(dirname(resolve(cwd, requestedPath)), { recursive: true });
}

async function normalizeScreenshotPathInTokens(commandTokens: string[], cwd: string): Promise<{
	request?: ScreenshotPathRequest;
	tokens: string[];
}> {
	const scopedCommandTokens = extractCommandTokens(commandTokens);
	const projection = projectUpstreamGlobalFlags(scopedCommandTokens);
	const projectedPathTokenIndex = getScreenshotPathTokenIndex(projection.tokens);
	const scopedPathTokenIndex = projectedPathTokenIndex === undefined ? undefined : projection.indices[projectedPathTokenIndex];
	if (scopedPathTokenIndex === undefined) {
		return { tokens: commandTokens };
	}
	const screenshotPathTokenIndex = commandTokens.length - scopedCommandTokens.length + scopedPathTokenIndex;
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
	const commandTokens = extractUpstreamCommandTokens(args);
	if (commandTokens[0] !== "batch") {
		return undefined;
	}
	const argumentSteps = getUpstreamEffectiveBatchSteps(commandTokens, undefined);
	if (argumentSteps.length > 0) {
		// Upstream executes raw argument steps exclusively and ignores stdin, so
		// prepare parent directories for the rows that will run and skip stdin
		// preparation (no directories for never-executed rows).
		for (const step of argumentSteps) {
			const stepTokens = extractUpstreamCommandTokens(step);
			await ensureArtifactParentDirectory(stepTokens, cwd);
			if (stepTokens[0] === "screenshot") {
				// Reuse the screenshot path resolution for its parent-directory side
				// effect only: raw strings are never rewritten, so the normalized
				// tokens and path request are deliberately discarded.
				await normalizeScreenshotPathInTokens(step, cwd);
			}
		}
		return undefined;
	}
	if (stdin === undefined) {
		return undefined;
	}
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return undefined;
	}

	let changed = false;
	const batchScreenshotPathRequests: Array<ScreenshotPathRequest | undefined> = [];
	const preparedSteps = await Promise.all(parsed.steps.map(async (step, index) => {
		if (!Array.isArray(step) || !step.every((item) => typeof item === "string")) {
			return step;
		}
		const upstreamStep = extractUpstreamCommandTokens(step);
		await ensureArtifactParentDirectory(upstreamStep, cwd);
		if (upstreamStep[0] !== "screenshot") {
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

export async function prepareAgentBrowserArgs(args: string[], stdin: string | undefined, cwd: string): Promise<PreparedAgentBrowserArgs> {
	const preparedBatch = await prepareBatchScreenshotPaths(args, stdin, cwd);
	if (preparedBatch) {
		return preparedBatch;
	}

	const commandTokens = extractCommandTokens(args);
	await ensureArtifactParentDirectory(extractUpstreamCommandTokens(args), cwd);
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

export { repairScreenshotData };

const DIALOG_COMMAND_PROCESS_TIMEOUT_MS = 5_000;
const DIALOG_COMMAND_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_DIALOG_PROCESS_TIMEOUT_MS";
const LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS = 8_000;
const LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS";
const DIALOG_TRIGGER_TEXT_PATTERN = /\b(?:alert|confirm|dialog|prompt)\b/i;

function getPositiveIntegerEnv(name: string): number | undefined {
	const value = getAgentBrowserProcessEnvironment()[name];
	if (!value || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getRefIdsFromDirectCommand(commandTokens: string[]): string[] {
	return [...new Set(getGuardedRefUsage(commandTokens))];
}

function commandTextLooksLikeDialogTrigger(commandTokens: string[], refSnapshot?: SessionRefSnapshot): boolean {
	if (commandTokens.some((token) => DIALOG_TRIGGER_TEXT_PATTERN.test(token))) return true;
	for (const refId of getRefIdsFromDirectCommand(commandTokens)) {
		const ref = refSnapshot?.refs?.[refId];
		if (ref && DIALOG_TRIGGER_TEXT_PATTERN.test(`${ref.role} ${ref.name}`)) return true;
	}
	return false;
}

function getDialogAwareProcessTimeoutMs(commandTokens: string[], refSnapshot?: SessionRefSnapshot, stdin?: string): number | undefined {
	const command = commandTokens[0];
	if (command === "dialog") return getPositiveIntegerEnv(DIALOG_COMMAND_PROCESS_TIMEOUT_ENV) ?? DIALOG_COMMAND_PROCESS_TIMEOUT_MS;
	if (command === "eval" && typeof stdin === "string" && DIALOG_TRIGGER_TEXT_PATTERN.test(stdin)) return getPositiveIntegerEnv(LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_ENV) ?? LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS;
	if ((command === "click" || command === "tap" || (command === "find" && commandTokens.includes("click"))) && commandTextLooksLikeDialogTrigger(commandTokens, refSnapshot)) return getPositiveIntegerEnv(LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_ENV) ?? LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS;
	return undefined;
}

function describeRef(refSnapshot: SessionRefSnapshot | undefined, refId: string): string {
	const ref = refSnapshot?.refs?.[refId];
	return ref ? `${ref.role} ${JSON.stringify(ref.name)}` : "not present";
}

function getSamePageFreshnessPreflightFailure(options: {
	currentSnapshot: SessionRefSnapshot;
	previousSnapshot: SessionRefSnapshot;
	refIds: string[];
}): { message: string; refIds: string[] } | undefined {
	const { refIds } = options;
	if (refIds.length === 0) return undefined;
	const previousUrl = normalizeComparableUrl(options.previousSnapshot.target?.url);
	const currentUrl = normalizeComparableUrl(options.currentSnapshot.target?.url);
	if (!previousUrl || !currentUrl || previousUrl !== currentUrl || currentUrl === "about:blank") return undefined;
	const mismatchedRefs = refIds.filter((refId) => {
		const previous = options.previousSnapshot.refs?.[refId];
		const current = options.currentSnapshot.refs?.[refId];
		if (!options.currentSnapshot.refIds.includes(refId)) return true;
		if (!previous || !current) return previous !== current;
		return previous.role !== current.role || previous.name !== current.name;
	});
	if (mismatchedRefs.length === 0) return undefined;
	const refText = mismatchedRefs.map((refId) => `@${refId}`).join(", ");
	const evidence = mismatchedRefs.map((refId) => `@${refId}: previous ${describeRef(options.previousSnapshot, refId)}, current ${describeRef(options.currentSnapshot, refId)}`).join("; ");
	return {
		message: `Ref ${refText} no longer matches the latest same-page snapshot. The page likely rerendered after the previous snapshot; run snapshot -i and retry with current refs. Evidence: ${evidence}.`,
		refIds: mismatchedRefs,
	};
}

async function collectSamePageRefFreshnessPreflight(options: {
	commandTokens: string[];
	cwd: string;
	currentTarget?: SessionTabTarget;
	stdin?: string;
	previousSnapshot?: SessionRefSnapshot;
	namespace?: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<StaleRefPreflight | undefined> {
	const refIds = [...new Set(getGuardedRefUsage(options.commandTokens, options.stdin))];
	if (!options.previousSnapshot || !options.sessionName || refIds.length === 0) return undefined;
	const previousUrl = normalizeComparableUrl(options.previousSnapshot.target?.url);
	const currentTargetUrl = normalizeComparableUrl(options.currentTarget?.url);
	if (currentTargetUrl === "about:blank" || (previousUrl && currentTargetUrl && previousUrl !== currentTargetUrl)) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal });
	const currentSnapshot = extractRefSnapshotFromData(snapshotData);
	if (!currentSnapshot) return undefined;
	const snapshotWithTarget = { ...currentSnapshot, target: currentSnapshot.target ?? options.currentTarget };
	const mismatch = getSamePageFreshnessPreflightFailure({ currentSnapshot: snapshotWithTarget, previousSnapshot: options.previousSnapshot, refIds });
	if (!mismatch) return undefined;
	return { message: mismatch.message, refIds: mismatch.refIds, snapshot: snapshotWithTarget };
}

function getIdleTimeoutMismatch(args: string[], configuredValue: string): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== "--idle-timeout") continue;
		const requestedToken = args[++index];
		if (!requestedToken || !/^\d+$/.test(requestedToken) || Number(requestedToken) === Number(configuredValue)) continue;
		return `--idle-timeout ${requestedToken} conflicts with this Pi process's managed-session idle timeout (${configuredValue} ms). Restart Pi with PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS=${requestedToken} and omit --idle-timeout; changing the launch value for one call can restart the upstream browser and discard the active tab.`;
	}
	return undefined;
}

function isPasswordStdinAuthSave(options: { command?: string; commandTokens: string[] }): boolean {
	return options.command === "auth" && options.commandTokens[1] === "save" && options.commandTokens.includes("--password-stdin");
}

export function getExactSensitiveStdinValues(options: { command?: string; commandTokens: string[]; stdin?: string }): string[] {
	if (options.stdin === undefined || !isPasswordStdinAuthSave(options)) {
		return [];
	}
	return [...new Set([options.stdin, options.stdin.trimEnd(), options.stdin.trim()].filter((value) => value.length > 0))];
}

export function validateStdinCommandContract(options: { command?: string; commandTokens: string[]; stdin?: string }): string | undefined {
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

function canResolveSemanticVisibleRef(compiled: CompiledAgentBrowserSemanticAction | undefined): compiled is CompiledAgentBrowserSemanticAction {
	if (!compiled?.locator) return false;
	if (compiled.action === "select") return true;
	return compiled.locator === "role" && ["check", "click", "fill"].includes(compiled.action);
}

function requiresResolvedSemanticVisibleRef(compiled: CompiledAgentBrowserSemanticAction | undefined): boolean {
	return compiled?.action === "select" && compiled.locator !== undefined;
}

function resolveSemanticActionVisibleRefArgsFromSnapshot(compiled: CompiledAgentBrowserSemanticAction | undefined, snapshotData: unknown): SemanticActionVisibleRefResolution | undefined {
	if (!canResolveSemanticVisibleRef(compiled)) return undefined;
	const resolution = resolveVisibleRefActionFromSnapshot({ allowFill: true, compiledAction: compiled, snapshotData });
	if (!resolution) return undefined;
	return { args: [...getCompiledSemanticActionSessionPrefix(compiled), ...resolution.args], snapshot: resolution.snapshot };
}

export async function resolveSemanticActionVisibleRefArgs(options: {
	compiled: CompiledAgentBrowserSemanticAction | undefined;
	cwd: string;
	namespace?: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<SemanticActionVisibleRefResolution | undefined> {
	if (!options.compiled || !options.sessionName) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal });
	return resolveSemanticActionVisibleRefArgsFromSnapshot(options.compiled, snapshotData);
}

export async function prepareBrowserRun(options: BrowserRunOptions): Promise<PrepareBrowserRunResult> {
	const { cwd, onUpdate, params, signal, state } = options;
	const { sessionPageState, traceOwners, managedSessionBaseName, ephemeralSessionSeed } = state;
	const agentBrowserProcessEnv = getAgentBrowserProcessEnvironment();
	let freshSessionOrdinal = state.freshSessionOrdinal;
	const {
		compiledElectron,
		compiledJob,
		compiledNetworkSourceLookup,
		compiledQaPreset,
		compiledSemanticAction,
		compiledSourceLookup,
		redactedArgs,
		redactedCompiledElectron,
		redactedCompiledJob,
		redactedCompiledNetworkSourceLookup,
		redactedCompiledQaPreset,
		redactedCompiledSemanticAction,
		redactedCompiledSourceLookup,
		toolArgs,
		toolStdin,
	} = normalizeRunInput(options.input);
	let runtimeToolArgs = toolArgs;
	let runtimeToolStdin = toolStdin;
	let electronLaunch: ElectronLaunchSuccess | undefined;
	const sessionMode = compiledElectron?.action === "launch" ? "fresh" : params.sessionMode ?? "auto";
	const freshSessionName = createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal + 1);
	const rawPageTargetError = getPageTargetValidationError({
		args: runtimeToolArgs,
		stdin: runtimeToolStdin,
		trustedFirstBatchTabSelection: true,
	});
	if (rawPageTargetError) {
		return {
			kind: "early-result",
			result: {
				content: [{ type: "text", text: rawPageTargetError }],
				details: {
					args: redactedArgs,
					...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, errorText: rawPageTargetError, succeeded: false, validationError: rawPageTargetError }),
					validationError: rawPageTargetError,
				},
				isError: true,
			},
		};
	}
	if (compiledElectron?.action === "launch") {
		const launchResult = await launchElectronApp({ ...compiledElectron, signal });
		if (!launchResult.ok) {
			const managedSessionOutcome = buildManagedSessionOutcome({
				activeAfter: state.managedSessionActive,
				activeBefore: state.managedSessionActive,
				attemptedSessionName: freshSessionName,
				command: "connect",
				currentSessionName: state.managedSessionName,
				previousSessionName: state.managedSessionName,
				sessionMode: "fresh",
				succeeded: false,
			});
			return { kind: "early-result", result: buildElectronHostFailureResult({
				compiledElectron: redactedCompiledElectron ?? compiledElectron,
				errorText: launchResult.failure.error,
				failureCategory: getElectronLaunchFailureCategory(launchResult.failure),
				launchFailure: launchResult.failure,
				managedSessionOutcome,
				status: launchResult.failure.reason,
			}) };
		}
		electronLaunch = launchResult.value;
		runtimeToolArgs = ["connect", electronLaunch.connectArg];
		runtimeToolStdin = undefined;
	}
	let managedSessionPolicyLock: ManagedSessionPolicyLock | undefined;
	let managedSessionPolicyLockTransferred = false;
	let electronLaunchTransferred = false;
	try {
	let preparedArgs: PreparedAgentBrowserArgs;
	try {
		preparedArgs = await prepareAgentBrowserArgs(runtimeToolArgs, runtimeToolStdin, cwd);
	} catch (error) {
		signal?.throwIfAborted();
		if (!(error instanceof Error) || !("syscall" in error) || error.syscall !== "mkdir" || !("path" in error) || typeof error.path !== "string") throw error;
		const guidance = "Choose a writable artifact path whose parent components are directories. Use absolute paths in raw batch artifact rows.";
		const validationError = redactSensitiveText(`Could not prepare artifact directory ${error.path}: ${error.message}. ${guidance}`);
		const nextActions = [{ artifactPath: redactSensitiveText(error.path), id: "verify-artifact-path", reason: guidance, safety: "The requested browser command did not run; inspect the directory with host file tools before retrying.", tool: "agent_browser" as const }];
		return { kind: "early-result", result: {
			content: [{ type: "text", text: validationError }],
			details: {
				agentBrowserStarted: false,
				args: redactedArgs,
				nextActions,
				...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, succeeded: false, validationError }),
				validationError,
			},
			isError: true,
		} };
	}
	const userRequestedJson = runtimeToolArgs.includes("--json");
	let executionPlan = buildExecutionPlan(preparedArgs.args, {
		freshSessionName,
		managedSessionActive: state.managedSessionActive,
		managedSessionCompatibilityWorkaround: state.managedSessionCompatibilityWorkaround,
		managedSessionName: state.managedSessionName,
		managedSessionNamespace: state.managedSessionNamespace,
		sessionMode,
	});
	const idleTimeoutMismatch = getIdleTimeoutMismatch(preparedArgs.args, options.implicitSessionIdleTimeoutMs);
	if (idleTimeoutMismatch) executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: idleTimeoutMismatch };
	const ownedSessionKey = getSessionContextKey(executionPlan.sessionName, executionPlan.namespace);
	const plannedSessionPageState = sessionPageState.get(ownedSessionKey);
	const pageTargetError = getPageTargetValidationError({
		args: executionPlan.effectiveArgs,
		currentPageUrl: plannedSessionPageState.tabTarget?.url,
		pageUrlUnknown: plannedSessionPageState.tabTargetUnknown === true,
		stdin: runtimeToolStdin,
	});
	if (!executionPlan.validationError && pageTargetError) executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: pageTargetError };
	const recordedOwnedSession = ownedSessionKey ? state.ownedManagedSessions.get(ownedSessionKey) : undefined;
	const targetsCurrentManagedSession = state.managedSessionActive
		&& ownedSessionKey === getSessionContextKey(state.managedSessionName, state.managedSessionNamespace);
	const targetsOffCurrentOwnedSession = recordedOwnedSession !== undefined && !targetsCurrentManagedSession;
	const offCurrentLaunchScopedFlags = targetsOffCurrentOwnedSession
		? executionPlan.startupScopedFlags.filter((flag) => flag !== "--namespace")
		: [];
	const offCurrentCompatibilityUpgrade = targetsOffCurrentOwnedSession
		&& executionPlan.compatibilityWorkaround !== undefined
		&& recordedOwnedSession.compatibilityWorkaround === undefined;
	if (targetsOffCurrentOwnedSession && canUseHeadlessCompatibilityUserAgent(preparedArgs.args, agentBrowserProcessEnv)) {
		const compatibilityWorkaround = executionPlan.compatibilityWorkaround ?? recordedOwnedSession.compatibilityWorkaround;
		if (compatibilityWorkaround) {
			const userAgentIndex = executionPlan.effectiveArgs.indexOf("--user-agent");
			executionPlan = {
				...executionPlan,
				compatibilityWorkaround,
				effectiveArgs: userAgentIndex < 0
					? executionPlan.effectiveArgs
					: [...executionPlan.effectiveArgs.slice(0, userAgentIndex), ...executionPlan.effectiveArgs.slice(userAgentIndex + 2)],
			};
		}
	}
	const retainedHeadedAutosaveDisabled = recordedOwnedSession?.headedManagedAutosaveDisabled === true
		|| (targetsCurrentManagedSession && state.managedSessionHeadedAutosaveDisabled === true);
	const retainedHeadedAutosaveInterval = recordedOwnedSession?.headedManagedAutosaveInterval
		?? (targetsCurrentManagedSession ? state.managedSessionHeadedAutosaveInterval : undefined);
	const explicitAutosaveInterval = resolveExplicitAutosaveInterval(agentBrowserProcessEnv.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS);
	const autosavePolicyChangeError = getRunningHeadedAutosavePolicyChangeError(retainedHeadedAutosaveInterval, isCloseCommand(executionPlan.commandInfo.command));
	if (!executionPlan.validationError && autosavePolicyChangeError) {
		executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: autosavePolicyChangeError };
	}
	const headedLaunch = getBooleanFlagValue(executionPlan.effectiveArgs, "--headed") ?? isUpstreamEnvFlagEnabled(agentBrowserProcessEnv.AGENT_BROWSER_HEADED);
	const providerLaunch = executionPlan.startupScopedFlags.some((flag) => flag === "--provider" || flag === "-p") || agentBrowserProcessEnv.AGENT_BROWSER_PROVIDER !== undefined;
	const headedManagedAutosaveDisabled = retainedHeadedAutosaveDisabled || (explicitAutosaveInterval === undefined && headedLaunch);
	const headedManagedAutosaveInterval = retainedHeadedAutosaveInterval ?? (headedLaunch ? explicitAutosaveInterval ?? "0" : undefined);
	const compatibilityUserAgent = executionPlan.compatibilityWorkaround ? getDefaultHeadlessCompatUserAgent() : undefined;
	const compatibilityUserAgentApplied = compatibilityUserAgent !== undefined
		&& executionPlan.effectiveArgs.some((token, index) => token === "--user-agent" && executionPlan.effectiveArgs[index + 1] === compatibilityUserAgent);
	const ownedManagedSession = buildOwnedManagedSessionRestoreContext({
		args: executionPlan.effectiveArgs,
		cwd: recordedOwnedSession?.cwd ?? cwd,
		currentManagedSessionName: state.managedSessionName,
		currentManagedSessionNamespace: state.managedSessionNamespace,
		headedManagedAutosaveDisabled,
		headedManagedAutosaveInterval,
		managedSessionName: executionPlan.managedSessionName,
		namespace: executionPlan.namespace,
		parentEnv: agentBrowserProcessEnv,
		recordedOwnedSession,
		restoreState: state.managedSessionRestoreState,
		sessionName: executionPlan.sessionName,
		stdin: runtimeToolStdin,
		compatibilityUserAgent: compatibilityUserAgentApplied ? compatibilityUserAgent : undefined,
		wrapperInjectedUserAgent: compatibilityUserAgentApplied,
	});
	let managedSessionDaemonInactive = false;
	let managedSessionCleanupOnlyReason: Awaited<ReturnType<typeof acquireOwnedManagedSessionDaemonPolicy>>["cleanupOnlyReason"];
	if (!executionPlan.validationError && ownedManagedSession) {
		const closeCommand = isCloseCommand(executionPlan.commandInfo.command);
		const policy = await acquireOwnedManagedSessionDaemonPolicy({
			context: ownedManagedSession,
			electronLaunchRecord: findElectronLaunchRecordForSession(executionPlan.sessionName, state.electronLaunchRecords, executionPlan.namespace),
			electronVerificationTimeoutMs: params.timeoutMs,
			mode: closeCommand ? "close" : "reuse",
			signal,
		});
		managedSessionPolicyLock = policy.lock;
		managedSessionDaemonInactive = policy.daemonStatus === "inactive";
		if (policy.error) {
			managedSessionCleanupOnlyReason = policy.cleanupOnlyReason;
			executionPlan = {
				...executionPlan,
				recoveryHint: undefined,
				validationError: policy.error,
			};
		} else if (!closeCommand && policy.daemonStatus === "active" && offCurrentLaunchScopedFlags.length > 0) {
			executionPlan = {
				...executionPlan,
				recoveryHint: undefined,
				validationError: `This older wrapper-owned session is already running, so launch-scoped flags ${offCurrentLaunchScopedFlags.join(", ")} would replace or be ignored by upstream agent-browser. Close it first, or remove the explicit --session and retry with sessionMode: \"fresh\".`,
			};
		} else if (!closeCommand && policy.daemonStatus === "active" && offCurrentCompatibilityUpgrade) {
			executionPlan = {
				...executionPlan,
				recoveryHint: undefined,
				validationError: "This older wrapper-owned session is already running without the user agent required by this site. Close it first, or remove the explicit --session and retry with sessionMode: \"fresh\".",
			};
		} else if (!closeCommand && policy.daemonStatus === "inactive" && compatibilityUserAgent && !compatibilityUserAgentApplied) {
			ownedManagedSession.compatibilityUserAgent = compatibilityUserAgent;
			executionPlan = {
				...executionPlan,
				effectiveArgs: ["--user-agent", compatibilityUserAgent, ...executionPlan.effectiveArgs],
			};
		}
	}
		return await withOwnedManagedSessionContext(ownedManagedSession, async () => {
		const managedSessionRestoreDisabled = () => state.managedSessionRestoreState.isDisabled(executionPlan.sessionName, executionPlan.namespace);
		const sessionStateKey = getSessionContextKey(executionPlan.sessionName, executionPlan.namespace);
		const priorSessionPageState = sessionPageState.get(sessionStateKey);
		let priorSessionTabTarget: SessionTabTarget | undefined = priorSessionPageState.tabTarget;
		let priorSessionTabTargetUnknown: true | undefined = priorSessionPageState.tabTargetUnknown;
		const sessionTabPinningReason = priorSessionPageState.pinningReason;
		let priorRefSnapshotState = priorSessionPageState.refSnapshot;
		let priorRefSnapshotInvalidation = priorSessionPageState.refSnapshotInvalidation;
		const coldManagedSession = (managedSessionDaemonInactive || priorSessionPageState.tabReopenPending === true)
			&& recordedOwnedSession !== undefined
			&& sessionTabPinningReason === "restore"
			&& ownedManagedSession?.restoreDecision === "enabled"
			&& !managedSessionRestoreDisabled()
			&& !options.preserveAttachedBrowserSession;
		if (coldManagedSession && sessionStateKey) {
			sessionPageState.setTabReopenPending({ pending: true, sessionName: sessionStateKey, update: options.sessionPageStateUpdate });
			priorRefSnapshotState = undefined;
			priorRefSnapshotInvalidation = buildPageTransitionRefSnapshotInvalidation("The managed browser shut down. Reopening its URL reloads the page; run snapshot -i before using page-scoped refs.");
			sessionPageState.applyRefSnapshotInvalidation({ invalidation: priorRefSnapshotInvalidation, sessionName: sessionStateKey, update: options.sessionPageStateUpdate });
		}
		let semanticActionVisibleRefResolution: SemanticActionVisibleRefResolution | undefined;
		let livePageVerified = false;
		let sessionTabCorrection: PreparedBrowserRun["sessionTabCorrection"];
		let sessionTabSelectionError: string | undefined;
		const plannedCommandTokens = extractUpstreamCommandTokens(preparedArgs.args);
		const knownStaleRef = buildStaleRefPreflight({ commandTokens: plannedCommandTokens, currentTarget: priorSessionTabTarget, refSnapshot: priorRefSnapshotState, refSnapshotInvalidation: priorRefSnapshotInvalidation, stdin: runtimeToolStdin });
		const invalidStdin = validateStdinCommandContract({ command: executionPlan.commandInfo.command, commandTokens: plannedCommandTokens, stdin: runtimeToolStdin });
		const pinSessionTab = shouldPinSessionTabForCommand({
			command: executionPlan.commandInfo.command,
			commandTokens: plannedCommandTokens,
			// URL QA clears diagnostics before its explicit open; those clears do not need the old tab.
			pinningRequired: sessionTabPinningReason !== undefined && compiledQaPreset?.checks.url === undefined,
			reopenPending: coldManagedSession,
			sessionName: executionPlan.sessionName,
			stdin: runtimeToolStdin,
		});
		if (!executionPlan.validationError && !executionPlan.plainTextInspection && !knownStaleRef && !invalidStdin && priorSessionTabTarget && pinSessionTab) {
			signal?.throwIfAborted();
			const reopened = !coldManagedSession || await runSessionCommandData({
				args: ["open", priorSessionTabTarget.url], cwd, namespace: executionPlan.namespace, sessionName: executionPlan.sessionName, signal, timeoutMs: params.timeoutMs,
				onProcessResult: ({ agentBrowserStarted }) => {
					// A started open may have navigated even if its CLI was aborted before replying.
					if (agentBrowserStarted && sessionStateKey) sessionPageState.setTabReopenPending({ pending: false, sessionName: sessionStateKey, update: options.sessionPageStateUpdate });
				},
			}) !== undefined;
			const selection = signal?.aborted ? undefined : reopened
				? await ensureSessionTabTarget({ cwd, namespace: executionPlan.namespace, sessionName: executionPlan.sessionName, signal, target: priorSessionTabTarget })
				: { error: "agent-browser could not reopen the remembered URL after the managed browser shut down. Navigate explicitly, then run snapshot -i before retrying." };
			if (coldManagedSession && signal?.aborted) {
				const errorText = "agent_browser was aborted while reopening the remembered page. The requested command did not run.";
				return { kind: "early-result", result: {
					content: [{ type: "text", text: errorText }],
					details: {
						aborted: true, args: redactedArgs, command: executionPlan.commandInfo.command,
						effectiveArgs: redactInvocationArgs(executionPlan.effectiveArgs), sessionMode,
						...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
						...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, command: executionPlan.commandInfo.command, errorText, failureCategory: "aborted", succeeded: false }),
					},
					isError: true,
				} };
			}
			signal?.throwIfAborted();
			sessionTabCorrection = selection?.correction;
			sessionTabSelectionError = selection?.error;
			if (selection?.error) executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: selection.error };
		}
		const isCallerOwnedExplicitSession = () => executionPlan.sessionName !== undefined
			&& executionPlan.usedImplicitSession === false
			&& ownedManagedSession === undefined;
		const requiresLivePageVerification = () => isCallerOwnedExplicitSession() || options.preserveAttachedBrowserSession === true;
		const verifyLivePage = async (request: { args: string[]; requirement?: string; stdin?: string }) => {
			if (!request.requirement || !executionPlan.sessionName) return;
			if (options.establishAttachedBrowserSession) {
				executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: request.requirement };
				return;
			}
			let liveUrl: string | undefined;
			try {
				const liveUrlData = await runSessionCommandData({
					args: ["get", "url"],
					cwd,
					namespace: executionPlan.namespace,
					sessionName: executionPlan.sessionName,
					signal,
					throwOnFailure: true,
				});
				liveUrl = extractStringResultField(liveUrlData, "result") ?? extractStringResultField(liveUrlData, "url");
			} catch (error) {
				if (signal?.aborted) throw signal.reason ?? error;
			}
			if (liveUrl === undefined) {
				executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: request.requirement };
				return;
			}
			const livePageValidationError = getPageTargetValidationError({
				args: request.args,
				currentPageUrl: liveUrl,
				pageUrlUnknown: false,
				stdin: request.stdin,
			});
			if (livePageValidationError) {
				executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: livePageValidationError };
				return;
			}
			livePageVerified = true;
			priorSessionTabTarget ??= { url: liveUrl };
			priorSessionTabTargetUnknown = undefined;
		};
		const hasPotentialLiveSemanticSession = state.managedSessionActive || priorSessionTabTarget !== undefined || isCallerOwnedExplicitSession() || options.preserveAttachedBrowserSession === true;
		const mayResolveSemanticVisibleRef = executionPlan.managedSessionName !== freshSessionName && hasPotentialLiveSemanticSession && canResolveSemanticVisibleRef(compiledSemanticAction);
		if (!executionPlan.validationError && mayResolveSemanticVisibleRef && requiresLivePageVerification()) {
			await verifyLivePage({
				args: ["snapshot", "-i"],
				requirement: getExplicitSessionPageVerificationRequirement({ args: ["snapshot", "-i"] }),
			});
		}
		if (!executionPlan.validationError && mayResolveSemanticVisibleRef) {
			semanticActionVisibleRefResolution = await resolveSemanticActionVisibleRefArgs({
				compiled: compiledSemanticAction,
				cwd,
				namespace: executionPlan.namespace,
				sessionName: executionPlan.sessionName,
				signal,
			});
		}
		if (!executionPlan.validationError && requiresResolvedSemanticVisibleRef(compiledSemanticAction) && !semanticActionVisibleRefResolution) {
			const freshLocatorError = executionPlan.managedSessionName === freshSessionName
				? "semanticAction select with locator cannot resolve a current @ref in sessionMode fresh. Open the page first, then reuse that session, or pass selector plus value/values."
				: undefined;
			executionPlan = {
				...executionPlan,
				validationError: freshLocatorError ?? (hasPotentialLiveSemanticSession
					? "semanticAction select with locator could not resolve to exactly one current visible combobox/listbox ref. Run snapshot -i and retry with selector or a more specific role/name."
					: "semanticAction select with locator requires an active browser session so the wrapper can resolve a current @ref; open a page first or pass selector plus value/values."),
			};
		}
		if (semanticActionVisibleRefResolution) {
			executionPlan = buildExecutionPlan(semanticActionVisibleRefResolution.args, {
				freshSessionName,
				managedSessionActive: state.managedSessionActive,
				managedSessionCompatibilityWorkaround: state.managedSessionCompatibilityWorkaround,
				managedSessionName: state.managedSessionName,
				managedSessionNamespace: state.managedSessionNamespace,
				sessionMode,
			});
		}

		const commandTokens = semanticActionVisibleRefResolution ? extractUpstreamCommandTokens(semanticActionVisibleRefResolution.args) : extractUpstreamCommandTokens(preparedArgs.args);
		const unsupportedScrollIntoViewRecovery = executionPlan.validationError || executionPlan.plainTextInspection
			? undefined
			: [commandTokens, ...getUpstreamEffectiveBatchSteps(commandTokens, runtimeToolStdin)]
				.map((tokens) => buildUnsupportedScrollIntoViewRecovery({ commandTokens: tokens, sessionName: executionPlan.sessionName }))
				.find((recovery) => recovery !== undefined);
		if (unsupportedScrollIntoViewRecovery) executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: unsupportedScrollIntoViewRecovery.error };
		const resolvedSemanticActionRefSnapshot: SessionRefSnapshot | undefined = semanticActionVisibleRefResolution?.snapshot
			? { ...semanticActionVisibleRefResolution.snapshot, target: semanticActionVisibleRefResolution.snapshot.target ?? priorSessionTabTarget }
			: undefined;
		const preLiveStaleRefPreflight = buildStaleRefPreflight({
			commandTokens,
			currentTarget: priorSessionTabTarget,
			refSnapshot: resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState,
			refSnapshotInvalidation: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotInvalidation,
			stdin: runtimeToolStdin,
		});
		const livePageAccessEligible = !executionPlan.validationError
			&& preLiveStaleRefPreflight === undefined
			&& validateStdinCommandContract({ command: executionPlan.commandInfo.command, commandTokens, stdin: runtimeToolStdin }) === undefined
			&& requiresLivePageVerification();
		const livePageRequirement = livePageAccessEligible
			&& !livePageVerified
			? getExplicitSessionPageVerificationRequirement({
				args: executionPlan.effectiveArgs,
				stdin: runtimeToolStdin,
			})
			: undefined;
		await verifyLivePage({
			args: executionPlan.effectiveArgs,
			requirement: livePageRequirement,
			stdin: runtimeToolStdin,
		});

		const redactedEffectiveArgs = redactInvocationArgs(executionPlan.effectiveArgs);
		const redactedRecoveryHint = redactRecoveryHint(executionPlan.recoveryHint);
		const compatibilityWorkaround: CompatibilityWorkaround | undefined = executionPlan.compatibilityWorkaround;
		const statePatch: BrowserRunStatePatch = executionPlan.managedSessionName === freshSessionName
			? { freshSessionOrdinal: freshSessionOrdinal + 1 }
			: {};
		if (executionPlan.managedSessionName === freshSessionName) {
			freshSessionOrdinal += 1;
		}

		if (executionPlan.validationError) {
			const nextActions = applyNamespaceToNextActions(sessionTabSelectionError ? buildSessionTabRecoveryNextActions({ kind: "tab-drift", resultCategory: "failure", sessionName: executionPlan.sessionName, tabCorrection: sessionTabCorrection, target: priorSessionTabTarget }) : unsupportedScrollIntoViewRecovery?.nextActions, executionPlan.namespace);
			const nextActionsText = formatAgentBrowserNextActionsText(nextActions);
			return { kind: "early-result", statePatch, result: {
				content: [{ type: "text", text: [executionPlan.validationError, nextActionsText].filter((text): text is string => text !== undefined).join("\n\n") }],
				details: {
					args: redactedArgs,
					compiledElectron: redactedCompiledElectron,
					compiledJob: redactedCompiledJob,
					compiledQaPreset: redactedCompiledQaPreset,
					compiledSourceLookup: redactedCompiledSourceLookup,
					compiledNetworkSourceLookup: redactedCompiledNetworkSourceLookup,
					invalidValueFlag: executionPlan.invalidValueFlag,
					managedSessionCleanupOnlyReason,
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
					...(managedSessionCleanupOnlyReason ? { namespace: ownedManagedSession?.namespace ?? "" } : {}),
					nextActions,
					sessionMode,
					sessionRecoveryHint: redactedRecoveryHint,
					startupScopedFlags: executionPlan.startupScopedFlags,
					...(sessionTabSelectionError ? { effectiveArgs: redactedEffectiveArgs, sessionTabCorrection } : {}),
					...(coldManagedSession ? { refSnapshotInvalidation: priorRefSnapshotInvalidation } : {}),
					...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, command: executionPlan.commandInfo.command, errorText: executionPlan.validationError, failureCategory: sessionTabSelectionError ? "tab-drift" : undefined, succeeded: false, validationError: executionPlan.validationError }),
					validationError: executionPlan.validationError,
				},
				isError: true,
			} };
		}

		const exactSensitiveValues = getExactSensitiveStdinValues({
			command: executionPlan.commandInfo.command,
			commandTokens,
			stdin: runtimeToolStdin,
		});
		const traceOwnerGuardMessage = getTraceOwnerGuardMessage({
			command: executionPlan.commandInfo.command,
			sessionName: sessionStateKey,
			subcommand: executionPlan.commandInfo.subcommand,
			traceOwners,
		});
		if (traceOwnerGuardMessage) {
			return { kind: "early-result", statePatch, result: {
				content: [{ type: "text", text: traceOwnerGuardMessage }],
				details: {
					args: redactedArgs,
					command: executionPlan.commandInfo.command,
					compatibilityWorkaround,
					effectiveArgs: redactedEffectiveArgs,
					sessionMode,
					...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: traceOwnerGuardMessage, succeeded: false, validationError: traceOwnerGuardMessage }),
					validationError: traceOwnerGuardMessage,
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
				},
				isError: true,
			} };
		}
		const stdinValidationError = validateStdinCommandContract({
			command: executionPlan.commandInfo.command,
			commandTokens,
			stdin: runtimeToolStdin,
		});
		if (stdinValidationError) {
			return { kind: "early-result", statePatch, result: {
				content: [{ type: "text", text: stdinValidationError }],
				details: {
					args: redactedArgs,
					command: executionPlan.commandInfo.command,
					compatibilityWorkaround,
					effectiveArgs: redactedEffectiveArgs,
					sessionMode,
					...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: stdinValidationError, succeeded: false, validationError: stdinValidationError }),
					validationError: stdinValidationError,
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
				},
				isError: true,
			} };
		}
		const promptRefSnapshot = resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState;
		const requestedArtifactCloseViolation = await findRequestedArtifactCloseViolation({ artifactManifest: state.artifactManifest, command: executionPlan.commandInfo.command, cwd, promptPolicy: options.promptPolicy });
		if (requestedArtifactCloseViolation) {
			return { kind: "early-result", statePatch, result: {
				content: [{ type: "text", text: requestedArtifactCloseViolation.message }],
				details: {
					args: redactedArgs,
					command: executionPlan.commandInfo.command,
					compatibilityWorkaround,
					effectiveArgs: redactedEffectiveArgs,
					promptGuard: requestedArtifactCloseViolation,
					sessionMode,
					...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: requestedArtifactCloseViolation.message, failureCategory: "policy-blocked", succeeded: false, validationError: requestedArtifactCloseViolation.message }),
					validationError: requestedArtifactCloseViolation.message,
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
				},
				isError: true,
			} };
		}
		const staleRefPreflight = buildStaleRefPreflight({
			commandTokens,
			currentTarget: priorSessionTabTarget,
			refSnapshot: resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState,
			refSnapshotInvalidation: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotInvalidation,
			stdin: runtimeToolStdin,
		});
		if (staleRefPreflight) {
			return { kind: "early-result", statePatch, result: {
				content: [{ type: "text", text: staleRefPreflight.message }],
				details: {
					args: redactedArgs,
					command: executionPlan.commandInfo.command,
					compatibilityWorkaround,
					effectiveArgs: redactedEffectiveArgs,
					nextActions: applyNamespaceToNextActions(buildSessionAwareStaleRefNextActions(executionPlan.sessionName), executionPlan.namespace),
					refIds: staleRefPreflight.refIds,
					refSnapshot: staleRefPreflight.snapshot,
					refSnapshotInvalidation: staleRefPreflight.snapshotInvalidation,
					sessionMode,
					...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: staleRefPreflight.message, failureCategory: "stale-ref", succeeded: false }),
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
				},
				isError: true,
			} };
		}
		const samePageRefFreshnessPreflight = await collectSamePageRefFreshnessPreflight({
			commandTokens,
			cwd,
			currentTarget: priorSessionTabTarget,
			previousSnapshot: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotState,
			stdin: runtimeToolStdin,
			namespace: executionPlan.namespace,
			sessionName: executionPlan.sessionName,
			signal,
		});
		if (samePageRefFreshnessPreflight) {
			if (samePageRefFreshnessPreflight.snapshot && sessionStateKey) {
				sessionPageState.applyRefSnapshot({ fallbackTarget: priorSessionTabTarget, sessionName: sessionStateKey, snapshot: samePageRefFreshnessPreflight.snapshot, update: options.sessionPageStateUpdate });
			}
			return { kind: "early-result", statePatch, result: {
				content: [{ type: "text", text: samePageRefFreshnessPreflight.message }],
				details: {
					args: redactedArgs,
					command: executionPlan.commandInfo.command,
					compatibilityWorkaround,
					effectiveArgs: redactedEffectiveArgs,
					nextActions: applyNamespaceToNextActions(buildSessionAwareStaleRefNextActions(executionPlan.sessionName), executionPlan.namespace),
					refIds: samePageRefFreshnessPreflight.refIds,
					refSnapshot: samePageRefFreshnessPreflight.snapshot,
					sessionMode,
					...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: samePageRefFreshnessPreflight.message, failureCategory: "stale-ref", succeeded: false }),
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
				},
				isError: true,
			} };
		}

		if (compiledQaPreset?.checks.attached) {
			const qaAttachedPrecondition = await validateQaAttachedPrecondition({
				cwd,
				namespace: executionPlan.namespace,
				sessionName: executionPlan.sessionName,
				signal,
			});
			if (qaAttachedPrecondition) {
				return { kind: "early-result", statePatch, result: {
					content: [{ type: "text", text: qaAttachedPrecondition.error }],
					details: {
						args: redactedArgs,
						compiledQaPreset: redactedCompiledQaPreset,
						compatibilityWorkaround,
						effectiveArgs: redactedEffectiveArgs,
						nextActions: applyNamespaceToNextActions(qaAttachedPrecondition.nextActions, executionPlan.namespace),
						sessionMode,
						...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: qaAttachedPrecondition.error, succeeded: false, validationError: qaAttachedPrecondition.error }),
						validationError: qaAttachedPrecondition.error,
						...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
					},
					isError: true,
				} };
			}
		}

		const persistentArtifactStore = getPersistentSessionArtifactStore(options.ctx);
		const snapshotFilter = await trySnapshotFilter({
			artifactManifest: state.artifactManifest,
			commandTokens,
			compatibilityWorkaround,
			cwd,
			effectiveArgs: redactedEffectiveArgs,
			managedSessionRestoreDisabled,
			persistentArtifactStore,
			previousRefSnapshot: priorRefSnapshotState,
			redactedArgs,
			namespace: executionPlan.namespace,
			sessionMode,
			sessionName: executionPlan.sessionName,
			sessionStateKey,
			sessionPageState,
			sessionPageStateUpdate: options.sessionPageStateUpdate,
			signal,
			usedImplicitSession: executionPlan.usedImplicitSession,
		});
		if (snapshotFilter) return { kind: "early-result", statePatch: { ...statePatch, artifactManifest: snapshotFilter.artifactManifest ?? statePatch.artifactManifest }, result: snapshotFilter.result };

		const networkRequestsPageFilter = await tryNetworkRequestsPageFilter({
			commandTokens,
			compatibilityWorkaround,
			cwd,
			effectiveArgs: redactedEffectiveArgs,
			managedSessionRestoreDisabled,
			redactedArgs,
			sessionMode,
			namespace: executionPlan.namespace,
			sessionName: executionPlan.sessionName,
			signal,
			usedImplicitSession: executionPlan.usedImplicitSession,
		});
		if (networkRequestsPageFilter) return { kind: "early-result", statePatch, result: networkRequestsPageFilter };

		if (executionPlan.startupScopedFlags.length === 0) {
			const containerScroll = await tryContainerScroll({
				commandTokens,
				compatibilityWorkaround,
				cwd,
				effectiveArgs: redactedEffectiveArgs,
				managedSessionRestoreDisabled,
				redactedArgs,
				sessionMode,
				namespace: executionPlan.namespace,
				sessionName: executionPlan.sessionName,
				signal,
				usedImplicitSession: executionPlan.usedImplicitSession,
			});
			if (containerScroll) return { kind: "early-result", statePatch, result: containerScroll };
			const pageScrollTo = await tryPageScrollTo({
				commandTokens,
				compatibilityWorkaround,
				cwd,
				effectiveArgs: redactedEffectiveArgs,
				managedSessionRestoreDisabled,
				redactedArgs,
				sessionMode,
				namespace: executionPlan.namespace,
				sessionName: executionPlan.sessionName,
				signal,
				usedImplicitSession: executionPlan.usedImplicitSession,
			});
			if (pageScrollTo) return { kind: "early-result", statePatch, result: pageScrollTo };
		}

		const directAnchorDownload = await tryDirectAnchorDownload({
			artifactManifest: state.artifactManifest,
			commandTokens,
			compatibilityWorkaround,
			cwd,
			effectiveArgs: redactedEffectiveArgs,
			managedSessionRestoreDisabled,
			redactedArgs,
			sessionMode,
			namespace: executionPlan.namespace,
			sessionName: executionPlan.sessionName,
			signal,
			usedImplicitSession: executionPlan.usedImplicitSession,
		});
		if (directAnchorDownload) return { kind: "early-result", statePatch: { ...statePatch, artifactManifest: directAnchorDownload.artifactManifest ?? statePatch.artifactManifest }, result: directAnchorDownload.result };

		const processArgs = executionPlan.effectiveArgs;
		const processStdin = preparedArgs.stdin ?? runtimeToolStdin;
		const clickDispatchProbe = compiledElectron === undefined
			? await prepareClickDispatchProbe({ commandTokens, cwd, namespace: executionPlan.namespace, refSnapshot: promptRefSnapshot, sessionName: executionPlan.sessionName, signal })
			: undefined;
		let readTimeoutPageUrl = priorSessionTabTarget?.url;
		if (options.params.timeoutMs === undefined && readTimeoutPageUrl === undefined && executionPlan.sessionName && commandTimeoutNeedsActivePageUrl(commandTokens, processStdin)) {
			try {
				const data = await runSessionCommandData({ args: ["get", "url"], cwd, namespace: executionPlan.namespace, sessionName: executionPlan.sessionName, signal });
				readTimeoutPageUrl = extractStringResultField(data, "result") ?? extractStringResultField(data, "url");
			} catch {}
		}
		const processTimeoutMs = options.params.timeoutMs ?? getDialogAwareProcessTimeoutMs(commandTokens, promptRefSnapshot, processStdin) ?? getCommandAwareProcessTimeoutMs(commandTokens, processStdin, readTimeoutPageUrl);
		const redactedProcessArgs = redactInvocationArgs(processArgs);
		const scrollAmount = Number(commandTokens.find((token) => /^\d+(?:\.\d+)?$/.test(token)));
		const shouldProbeScrollNoop = executionPlan.commandInfo.command === "scroll" && executionPlan.startupScopedFlags.length === 0 && (state.managedSessionActive || sessionMode === "fresh") && (!Number.isFinite(scrollAmount) || scrollAmount >= 500);
		const scrollPositionBefore = shouldProbeScrollNoop
			? await collectScrollPositionSnapshot({ cwd, namespace: executionPlan.namespace, sessionName: executionPlan.sessionName, signal })
			: undefined;

		onUpdate?.({
			content: [{ type: "text", text: `Running agent-browser ${buildInvocationPreview(redactedProcessArgs)}` }],
			details: {
				compatibilityWorkaround,
				effectiveArgs: redactedProcessArgs,
				sessionMode,
				sessionTabCorrection,
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
			},
		});

		managedSessionPolicyLockTransferred = true;
		electronLaunchTransferred = true;
		return {
			kind: "ready",
			prepared: {
				commandTokens,
				headedLaunch,
				providerLaunch,
				managedSessionPolicyLock,
				compiledElectron,
				compiledJob,
				compiledNetworkSourceLookup,
				compiledQaPreset,
				compiledSemanticAction,
				compiledSourceLookup,
				compatibilityWorkaround,
				clickDispatchProbe,
				electronLaunch,
				exactSensitiveValues,
				executionPlan,
				ownedManagedSessionContext: ownedManagedSession,
				preparedArgs,
				priorRefSnapshotState,
				priorSessionTabTarget,
				priorSessionTabTargetUnknown,
				processArgs,
				processStdin,
				processTimeoutMs,
				redactedArgs,
				redactedCompiledElectron,
				redactedCompiledJob,
				redactedCompiledNetworkSourceLookup,
				redactedCompiledQaPreset,
				redactedCompiledSemanticAction: semanticActionVisibleRefResolution && redactedCompiledSemanticAction?.action === "select"
					? { ...redactedCompiledSemanticAction, args: redactInvocationArgs(semanticActionVisibleRefResolution.args) }
					: redactedCompiledSemanticAction,
				redactedCompiledSourceLookup,
				redactedEffectiveArgs,
				redactedProcessArgs,
				redactedRecoveryHint,
				resolvedSemanticActionRefSnapshot,
				runtimeToolArgs,
				runtimeToolStdin,
				scrollPositionBefore,
				sessionMode,
				sessionTabCorrection,
				sessionTabPinningReason,
				shouldProbeScrollNoop,
				statePatch,
				userRequestedJson,
			},
		};
		});
	} finally {
		if (!managedSessionPolicyLockTransferred) await managedSessionPolicyLock?.release();
		if (electronLaunch && !electronLaunchTransferred) {
			try {
				const cleanup = await cleanupElectronLaunchResources({
					child: electronLaunch.child,
					record: electronLaunch.record,
					timeoutMs: options.implicitSessionCloseTimeoutMs,
				});
				if (cleanup.partial) {
					state.electronLaunchRecords.set(cleanup.launchId, cleanup.record);
					state.electronChildProcesses.set(cleanup.launchId, electronLaunch.child);
				}
			} catch {
				state.electronLaunchRecords.set(electronLaunch.record.launchId, electronLaunch.record);
				state.electronChildProcesses.set(electronLaunch.record.launchId, electronLaunch.child);
			}
		}
	}
}
