import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { launchElectronApp, type ElectronLaunchSuccess } from "../../electron/launch.js";
import { pathExists } from "../../fs-utils.js";
import { getCompiledSemanticActionSessionPrefix, type CompiledAgentBrowserSemanticAction } from "../../input-modes.js";
import { tryDirectAnchorDownload } from "./prepare/direct-anchor-download.js";
import { tryNetworkRequestsPageFilter } from "./prepare/network-page-filter.js";
import { tryContainerScroll, tryPageScrollTo } from "./prepare/scroll-shims.js";
import { trySnapshotFilter } from "./prepare/snapshot-filter.js";
import { getWaitAwareProcessTimeoutMs } from "./prepare/wait-timeouts.js";
import { getPersistentSessionArtifactStore } from "./session-artifacts.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results.js";
import { applyNamespaceToNextActions } from "../../results/next-actions.js";
import { buildSessionAwareStaleRefNextActions, buildSessionTabRecoveryNextActions } from "../../results/recovery-next-actions.js";
import { resolveVisibleRefActionFromSnapshot } from "../../results/selector-recovery.js";
import { extractRefSnapshotFromData, type SessionRefSnapshot, type SessionTabTarget } from "../../session-page-state.js";
import {
	buildExecutionPlan,
	createFreshSessionName,
	extractCommandTokens,
	redactInvocationArgs,
	redactSensitiveText,
	type CompatibilityWorkaround,
} from "../../runtime.js";
import {
	applyOpenResultTabCorrection,
	buildManagedSessionOutcome,
	buildPinnedBatchPlan,
	buildSessionDetailFields,
	buildStaleRefPreflight,
	getSessionContextKey,
	collectSessionTabSelection,
	getGuardedRefUsage,
	getTraceOwnerGuardMessage,
	runSessionCommandData,
	shouldPinSessionTabForCommand,
} from "./session-state.js";
import { parseBatchStdinJsonArray, parseValidBatchStepEntries } from "../batch-stdin.js";
import { buildElectronHostFailureResult, getElectronLaunchFailureCategory, redactRecoveryHint } from "./final-result.js";
import { prepareClickDispatchProbe } from "./click-dispatch.js";
import { collectScrollPositionSnapshot, validateQaAttachedPrecondition } from "./diagnostics.js";
import { getScreenshotPathTokenIndex } from "./artifact-paths.js";
import { findRequestedArtifactCloseViolation } from "./prompt-guards.js";

import type {
	AgentBrowserToolResult,
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
	if (commandTokens[0] === "wait") {
		const downloadIndex = commandTokens.findIndex((token) => token === "--download");
		const pathIndex = downloadIndex >= 0 ? downloadIndex + 1 : -1;
		if (pathIndex > 0 && typeof commandTokens[pathIndex] === "string" && !commandTokens[pathIndex].startsWith("-")) return pathIndex;
	}
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
		await ensureArtifactParentDirectory(step, cwd);
		if (step[0] !== "screenshot") {
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
	await ensureArtifactParentDirectory(commandTokens, cwd);
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
	const value = process.env[name];
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
	commandTokens: string[];
	currentSnapshot: SessionRefSnapshot;
	previousSnapshot: SessionRefSnapshot;
}): { message: string; refIds: string[] } | undefined {
	if (options.commandTokens[0] === "batch") return undefined;
	const refIds = getRefIdsFromDirectCommand(options.commandTokens);
	if (refIds.length === 0) return undefined;
	const previousUrl = options.previousSnapshot.target?.url;
	const currentUrl = options.currentSnapshot.target?.url;
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
	previousSnapshot?: SessionRefSnapshot;
	namespace?: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<StaleRefPreflight | undefined> {
	if (!options.previousSnapshot || !options.sessionName || options.commandTokens[0] === "batch" || getRefIdsFromDirectCommand(options.commandTokens).length === 0) return undefined;
	const previousUrl = options.previousSnapshot.target?.url;
	const currentTargetUrl = options.currentTarget?.url;
	if (currentTargetUrl === "about:blank" || (previousUrl && currentTargetUrl && previousUrl !== currentTargetUrl)) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal });
	const currentSnapshot = extractRefSnapshotFromData(snapshotData);
	if (!currentSnapshot) return undefined;
	const snapshotWithTarget = { ...currentSnapshot, target: currentSnapshot.target ?? options.currentTarget };
	const mismatch = getSamePageFreshnessPreflightFailure({ commandTokens: options.commandTokens, currentSnapshot: snapshotWithTarget, previousSnapshot: options.previousSnapshot });
	if (!mismatch) return undefined;
	return { message: mismatch.message, refIds: mismatch.refIds, snapshot: snapshotWithTarget };
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

export async function resolveSemanticActionVisibleRefArgs(options: {
	compiled: CompiledAgentBrowserSemanticAction | undefined;
	cwd: string;
	namespace?: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<SemanticActionVisibleRefResolution | undefined> {
	if (!options.compiled || !options.sessionName || options.compiled.locator !== "role" || !["check", "click", "fill"].includes(options.compiled.action)) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal });
	const resolution = resolveVisibleRefActionFromSnapshot({ allowFill: true, compiledAction: options.compiled, snapshotData });
	if (!resolution) return undefined;
	return { args: [...getCompiledSemanticActionSessionPrefix(options.compiled), ...resolution.args], snapshot: resolution.snapshot };
}

export async function prepareBrowserRun(options: BrowserRunOptions): Promise<PrepareBrowserRunResult> {
	const { cwd, implicitSessionIdleTimeoutMs, onUpdate, params, signal, state } = options;
	const { sessionPageState, traceOwners, managedSessionBaseName, ephemeralSessionSeed } = state;
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
	if (compiledElectron?.action === "launch") {
		const launchResult = await launchElectronApp(compiledElectron);
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
	const preparedArgs = await prepareAgentBrowserArgs(runtimeToolArgs, runtimeToolStdin, cwd);
	const userRequestedJson = runtimeToolArgs.includes("--json");
	let executionPlan = buildExecutionPlan(preparedArgs.args, {
		freshSessionName,
		managedSessionActive: state.managedSessionActive,
		managedSessionName: state.managedSessionName,
		managedSessionNamespace: state.managedSessionNamespace,
		sessionMode,
	});
	let semanticActionVisibleRefResolution: SemanticActionVisibleRefResolution | undefined;
	if (!executionPlan.validationError && executionPlan.managedSessionName !== freshSessionName) {
		semanticActionVisibleRefResolution = await resolveSemanticActionVisibleRefArgs({
			compiled: compiledSemanticAction,
			cwd,
			namespace: executionPlan.namespace,
			sessionName: executionPlan.sessionName,
			signal,
		});
		if (semanticActionVisibleRefResolution) {
			executionPlan = buildExecutionPlan(semanticActionVisibleRefResolution.args, {
				freshSessionName,
				managedSessionActive: state.managedSessionActive,
				managedSessionName: state.managedSessionName,
				managedSessionNamespace: state.managedSessionNamespace,
				sessionMode,
			});
		}
	}
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
		return { kind: "early-result", statePatch, result: {
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
		} };
	}

	const commandTokens = semanticActionVisibleRefResolution ? extractCommandTokens(semanticActionVisibleRefResolution.args) : extractCommandTokens(preparedArgs.args);
	const exactSensitiveValues = getExactSensitiveStdinValues({
		command: executionPlan.commandInfo.command,
		commandTokens,
		stdin: runtimeToolStdin,
	});
	const sessionStateKey = getSessionContextKey(executionPlan.sessionName, executionPlan.namespace);
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
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace),
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
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace),
			},
			isError: true,
		} };
	}
	const priorSessionPageState = sessionPageState.get(sessionStateKey);
	const priorSessionTabTarget = priorSessionPageState.tabTarget;
	const sessionTabPinningReason = priorSessionPageState.pinningReason;
	const priorRefSnapshotState = priorSessionPageState.refSnapshot;
	const priorRefSnapshotInvalidation = priorSessionPageState.refSnapshotInvalidation;
	const resolvedSemanticActionRefSnapshot: SessionRefSnapshot | undefined = semanticActionVisibleRefResolution?.snapshot
		? { ...semanticActionVisibleRefResolution.snapshot, target: semanticActionVisibleRefResolution.snapshot.target ?? priorSessionTabTarget }
		: undefined;
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
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace),
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
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace),
			},
			isError: true,
		} };
	}
	const samePageRefFreshnessPreflight = await collectSamePageRefFreshnessPreflight({
		commandTokens,
		cwd,
		currentTarget: priorSessionTabTarget,
		previousSnapshot: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotState,
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
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace),
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
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace),
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
		redactedArgs,
		sessionMode,
		namespace: executionPlan.namespace,
		sessionName: executionPlan.sessionName,
		signal,
		usedImplicitSession: executionPlan.usedImplicitSession,
	});
	if (networkRequestsPageFilter) return { kind: "early-result", statePatch, result: networkRequestsPageFilter };

	const containerScroll = await tryContainerScroll({
		commandTokens,
		compatibilityWorkaround,
		cwd,
		effectiveArgs: redactedEffectiveArgs,
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
		redactedArgs,
		sessionMode,
		namespace: executionPlan.namespace,
		sessionName: executionPlan.sessionName,
		signal,
		usedImplicitSession: executionPlan.usedImplicitSession,
	});
	if (pageScrollTo) return { kind: "early-result", statePatch, result: pageScrollTo };

	const directAnchorDownload = await tryDirectAnchorDownload({
		artifactManifest: state.artifactManifest,
		commandTokens,
		compatibilityWorkaround,
		cwd,
		effectiveArgs: redactedEffectiveArgs,
		redactedArgs,
		sessionMode,
		namespace: executionPlan.namespace,
		sessionName: executionPlan.sessionName,
		signal,
		usedImplicitSession: executionPlan.usedImplicitSession,
	});
	if (directAnchorDownload) return { kind: "early-result", statePatch: { ...statePatch, artifactManifest: directAnchorDownload.artifactManifest ?? statePatch.artifactManifest }, result: directAnchorDownload.result };

	let pinnedBatchUnwrapMode: PreparedBrowserRun["pinnedBatchUnwrapMode"];
	let includePinnedNavigationSummary = false;
	let sessionTabCorrection: PreparedBrowserRun["sessionTabCorrection"];
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
			cwd,
			namespace: executionPlan.namespace,
			sessionName: executionPlan.sessionName,
			signal,
			target: priorSessionTabTarget,
		});
		if (plannedSessionTabSelection && executionPlan.sessionName) {
			if (executionPlan.commandInfo.command === "eval" && runtimeToolStdin !== undefined) {
				const appliedSessionTabSelection = await applyOpenResultTabCorrection({
					correction: plannedSessionTabSelection,
					cwd,
					namespace: executionPlan.namespace,
					sessionName: executionPlan.sessionName,
					signal,
				});
				if (!appliedSessionTabSelection) {
					const error = "agent-browser could not re-select the intended tab before running the command.";
					return { kind: "early-result", statePatch, result: {
						content: [{ type: "text", text: error }],
						details: {
							args: redactedArgs,
							command: executionPlan.commandInfo.command,
							compatibilityWorkaround,
							effectiveArgs: redactedEffectiveArgs,
							sessionMode,
							sessionTabCorrection: plannedSessionTabSelection,
							...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: error, failureCategory: "tab-drift", succeeded: false, tabDrift: true, validationError: error }),
							nextActions: applyNamespaceToNextActions(buildSessionTabRecoveryNextActions({
								kind: "tab-drift",
								resultCategory: "failure",
								sessionName: executionPlan.sessionName,
								tabCorrection: plannedSessionTabSelection,
								target: priorSessionTabTarget,
							}), executionPlan.namespace),
							validationError: error,
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace),
						},
						isError: true,
					} };
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
					return { kind: "early-result", statePatch, result: {
						content: [{ type: "text", text: pinnedBatchPlan.error }],
						details: {
							args: redactedArgs,
							command: executionPlan.commandInfo.command,
							compatibilityWorkaround,
							effectiveArgs: redactedEffectiveArgs,
							sessionMode,
							sessionTabCorrection: plannedSessionTabSelection,
							...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: pinnedBatchPlan.error, failureCategory: "tab-drift", succeeded: false, tabDrift: true, validationError: pinnedBatchPlan.error }),
							nextActions: applyNamespaceToNextActions(buildSessionTabRecoveryNextActions({
								kind: "tab-drift",
								resultCategory: "failure",
								sessionName: executionPlan.sessionName,
								tabCorrection: plannedSessionTabSelection,
								target: priorSessionTabTarget,
							}), executionPlan.namespace),
							validationError: pinnedBatchPlan.error,
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace),
						},
						isError: true,
					} };
				}
				if (pinnedBatchPlan) {
					sessionTabCorrection = plannedSessionTabSelection;
					processArgs = ["--json", ...(executionPlan.namespace ? ["--namespace", executionPlan.namespace] : []), "--session", executionPlan.sessionName, "batch"];
					processStdin = JSON.stringify(pinnedBatchPlan.steps);
					includePinnedNavigationSummary = pinnedBatchPlan.includeNavigationSummary;
					pinnedBatchUnwrapMode = pinnedBatchPlan.unwrapMode;
				}
			}
		}
	}
	const clickDispatchProbe = pinnedBatchUnwrapMode === undefined && compiledElectron === undefined
		? await prepareClickDispatchProbe({ commandTokens, cwd, namespace: executionPlan.namespace, refSnapshot: promptRefSnapshot, sessionName: executionPlan.sessionName, signal })
		: undefined;
	const processTimeoutMs = options.params.timeoutMs ?? getDialogAwareProcessTimeoutMs(commandTokens, promptRefSnapshot, processStdin) ?? getWaitAwareProcessTimeoutMs(commandTokens, processStdin);
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
			...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace),
		},
	});

	return { kind: "ready", prepared: {
		commandTokens,
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
		includePinnedNavigationSummary,
		pinnedBatchUnwrapMode,
		preparedArgs,
		priorRefSnapshotState,
		priorSessionTabTarget,
		processArgs,
		processStdin,
		processTimeoutMs,
		redactedArgs,
		redactedCompiledElectron,
		redactedCompiledJob,
		redactedCompiledNetworkSourceLookup,
		redactedCompiledQaPreset,
		redactedCompiledSemanticAction,
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
	} };
}
