import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import { launchElectronApp, type ElectronLaunchSuccess } from "../../electron/launch.js";
import { getCompiledSemanticActionSessionPrefix, type CompiledAgentBrowserSemanticAction } from "../../input-modes.js";
import { SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS } from "../../process.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results.js";
import { buildSessionAwareStaleRefNextActions, buildSessionTabRecoveryNextActions } from "../../results/recovery-next-actions.js";
import { resolveVisibleRefActionFromSnapshot } from "../../results/selector-recovery.js";
import { type SessionRefSnapshot } from "../../session-page-state.js";
import {
	buildExecutionPlan,
	createFreshSessionName,
	extractCommandTokens,
	getClipboardWriteArgumentValues,
	redactInvocationArgs,
	type CompatibilityWorkaround,
} from "../../runtime.js";
import {
	applyOpenResultTabCorrection,
	buildManagedSessionOutcome,
	buildPinnedBatchPlan,
	buildSessionDetailFields,
	buildStaleRefPreflight,
	collectSessionTabSelection,
	getTraceOwnerGuardMessage,
	runSessionCommandData,
	shouldPinSessionTabForCommand,
} from "./session-state.js";
import { parseBatchStdinJsonArray, parseValidBatchStepEntries } from "../batch-stdin.js";
import { buildElectronHostFailureResult, getElectronLaunchFailureCategory, redactRecoveryHint } from "./final-result.js";
import { prepareClickDispatchProbe } from "./click-dispatch.js";
import { collectScrollPositionSnapshot, validateQaAttachedPrecondition } from "./diagnostics.js";
import { findRequestedArtifactCloseViolation, findStopBoundaryViolation } from "./prompt-guards.js";
import type {
	BrowserRunInputFields,
	BrowserRunOptions,
	PreparedAgentBrowserArgs,
	PreparedBrowserRun,
	PrepareBrowserRunResult,
	ScreenshotArtifactRequest,
	ScreenshotPathRequest,
	SemanticActionVisibleRefResolution,
} from "./types.js";

const SCREENSHOT_VALUE_FLAGS = new Set(["--screenshot-dir", "--screenshot-format", "--screenshot-quality"]);
const SCREENSHOT_IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);

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

function isImagePathToken(token: string): boolean {
	const extension = extname(token).toLowerCase();
	return SCREENSHOT_IMAGE_EXTENSIONS.has(extension);
}

export function getScreenshotPathTokenIndex(commandTokens: string[]): number | undefined {
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
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return undefined;
	}

	let changed = false;
	const batchScreenshotPathRequests: Array<ScreenshotPathRequest | undefined> = [];
	const preparedSteps = await Promise.all(parsed.steps.map(async (step, index) => {
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

export async function prepareAgentBrowserArgs(args: string[], stdin: string | undefined, cwd: string): Promise<PreparedAgentBrowserArgs> {
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

export { repairScreenshotData };

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

export function validateWaitIpcTimeoutContract(commandTokens: string[], stdin: string | undefined): string | undefined {
	const directWaitTimeout = findWaitTimeoutMs(commandTokens);
	if (directWaitTimeout && directWaitTimeout.timeoutMs > SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS) {
		return buildIpcUnsafeWaitError(directWaitTimeout.source, directWaitTimeout.timeoutMs);
	}
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return undefined;
	}
	for (const { index, step } of parseValidBatchStepEntries(stdin)) {
		const waitTimeout = findWaitTimeoutMs(step);
		if (waitTimeout && waitTimeout.timeoutMs > SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS) {
			return buildIpcUnsafeWaitError(waitTimeout.source, waitTimeout.timeoutMs, index);
		}
	}
	return undefined;
}

function isPasswordStdinAuthSave(options: { command?: string; commandTokens: string[] }): boolean {
	return options.command === "auth" && options.commandTokens[1] === "save" && options.commandTokens.includes("--password-stdin");
}

export function getExactSensitiveStdinValues(options: { command?: string; commandTokens: string[]; stdin?: string }): string[] {
	const values = getClipboardWriteArgumentValues(options.commandTokens);
	if (options.stdin !== undefined && isPasswordStdinAuthSave(options)) {
		values.push(options.stdin, options.stdin.trimEnd(), options.stdin.trim());
	}
	return [...new Set(values.filter((value) => value.length > 0))];
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
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<SemanticActionVisibleRefResolution | undefined> {
	if (!options.compiled || !options.sessionName || options.compiled.locator !== "role" || !["check", "click", "uncheck"].includes(options.compiled.action)) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	const resolution = resolveVisibleRefActionFromSnapshot({ compiledAction: options.compiled, snapshotData });
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
		sessionMode,
	});
	let semanticActionVisibleRefResolution: SemanticActionVisibleRefResolution | undefined;
	if (!executionPlan.validationError && executionPlan.managedSessionName !== freshSessionName) {
		semanticActionVisibleRefResolution = await resolveSemanticActionVisibleRefArgs({
			compiled: compiledSemanticAction,
			cwd,
			sessionName: executionPlan.sessionName,
			signal,
		});
		if (semanticActionVisibleRefResolution) {
			executionPlan = buildExecutionPlan(semanticActionVisibleRefResolution.args, {
				freshSessionName,
				managedSessionActive: state.managedSessionActive,
				managedSessionName: state.managedSessionName,
				sessionMode,
			});
		}
	}
	const redactedEffectiveArgs = redactInvocationArgs(executionPlan.effectiveArgs);
	const redactedRecoveryHint = redactRecoveryHint(executionPlan.recoveryHint);
	const compatibilityWorkaround: CompatibilityWorkaround | undefined = executionPlan.compatibilityWorkaround;
	const statePatch = executionPlan.managedSessionName === freshSessionName
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
	const traceOwnerGuardMessage = getTraceOwnerGuardMessage({
		command: executionPlan.commandInfo.command,
		sessionName: executionPlan.sessionName,
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
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
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
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
			},
			isError: true,
		} };
	}
	const waitIpcTimeoutError = validateWaitIpcTimeoutContract(commandTokens, runtimeToolStdin);
	if (waitIpcTimeoutError) {
		return { kind: "early-result", statePatch, result: {
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
		} };
	}

	const priorSessionPageState = sessionPageState.get(executionPlan.sessionName);
	const priorSessionTabTarget = priorSessionPageState.tabTarget;
	const sessionTabPinningReason = priorSessionPageState.pinningReason;
	const priorRefSnapshotState = priorSessionPageState.refSnapshot;
	const priorRefSnapshotInvalidation = priorSessionPageState.refSnapshotInvalidation;
	const resolvedSemanticActionRefSnapshot: SessionRefSnapshot | undefined = semanticActionVisibleRefResolution?.snapshot
		? { ...semanticActionVisibleRefResolution.snapshot, target: semanticActionVisibleRefResolution.snapshot.target ?? priorSessionTabTarget }
		: undefined;
	const promptRefSnapshot = resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState;
	const stopBoundaryViolation = findStopBoundaryViolation({ commandTokens, promptPolicy: options.promptPolicy, refSnapshot: promptRefSnapshot, stdin: runtimeToolStdin });
	if (stopBoundaryViolation) {
		return { kind: "early-result", statePatch, result: {
			content: [{ type: "text", text: stopBoundaryViolation.message }],
			details: {
				args: redactedArgs,
				command: executionPlan.commandInfo.command,
				compatibilityWorkaround,
				effectiveArgs: redactedEffectiveArgs,
				promptGuard: stopBoundaryViolation,
				sessionMode,
				...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: stopBoundaryViolation.message, failureCategory: "policy-blocked", succeeded: false, validationError: stopBoundaryViolation.message }),
				validationError: stopBoundaryViolation.message,
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
			},
			isError: true,
		} };
	}
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
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
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
				nextActions: buildSessionAwareStaleRefNextActions(executionPlan.sessionName),
				refIds: staleRefPreflight.refIds,
				refSnapshot: staleRefPreflight.snapshot,
				refSnapshotInvalidation: staleRefPreflight.snapshotInvalidation,
				sessionMode,
				...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: staleRefPreflight.message, failureCategory: "stale-ref", succeeded: false }),
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
			},
			isError: true,
		} };
	}

	if (compiledQaPreset?.checks.attached) {
		const qaAttachedPrecondition = await validateQaAttachedPrecondition({
			cwd,
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
					nextActions: qaAttachedPrecondition.nextActions,
					sessionMode,
					...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: qaAttachedPrecondition.error, succeeded: false, validationError: qaAttachedPrecondition.error }),
					validationError: qaAttachedPrecondition.error,
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
				},
				isError: true,
			} };
		}
	}

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
			sessionName: executionPlan.sessionName,
			signal,
			target: priorSessionTabTarget,
		});
		if (plannedSessionTabSelection && executionPlan.sessionName) {
			if (executionPlan.commandInfo.command === "eval" && runtimeToolStdin !== undefined) {
				const appliedSessionTabSelection = await applyOpenResultTabCorrection({
					correction: plannedSessionTabSelection,
					cwd,
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
							nextActions: buildSessionTabRecoveryNextActions({
								kind: "tab-drift",
								resultCategory: "failure",
								sessionName: executionPlan.sessionName,
								tabCorrection: plannedSessionTabSelection,
								target: priorSessionTabTarget,
							}),
							validationError: error,
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
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
							nextActions: buildSessionTabRecoveryNextActions({
								kind: "tab-drift",
								resultCategory: "failure",
								sessionName: executionPlan.sessionName,
								tabCorrection: plannedSessionTabSelection,
								target: priorSessionTabTarget,
							}),
							validationError: pinnedBatchPlan.error,
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						},
						isError: true,
					} };
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
	const clickDispatchProbe = pinnedBatchUnwrapMode === undefined && compiledElectron === undefined
		? await prepareClickDispatchProbe({ commandTokens, cwd, refSnapshot: promptRefSnapshot, sessionName: executionPlan.sessionName, signal })
		: undefined;
	const redactedProcessArgs = redactInvocationArgs(processArgs);
	const shouldProbeScrollNoop = executionPlan.commandInfo.command === "scroll" && executionPlan.startupScopedFlags.length === 0;
	const scrollPositionBefore = shouldProbeScrollNoop
		? await collectScrollPositionSnapshot({ cwd, sessionName: executionPlan.sessionName, signal })
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
