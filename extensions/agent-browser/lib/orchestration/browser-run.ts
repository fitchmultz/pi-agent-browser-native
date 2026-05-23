import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	cleanupElectronLaunchResources,
	inspectElectronLaunchStatus,
	type ElectronCleanupResult,
	type ElectronLaunchStatus,
} from "../electron/cleanup.js";
import { launchElectronApp, type ElectronLaunchRecord, type ElectronLaunchSuccess } from "../electron/launch.js";
import {
	analyzeNetworkSourceLookupResults,
	analyzeQaPresetResults,
	analyzeSourceLookupResults,
	getCompiledSemanticActionCommandIndex,
	getCompiledSemanticActionSessionPrefix,
	isCompiledSemanticActionFindCommand,
	redactNetworkSourceLookupAnalysis,
	redactNetworkSourceLookupSurface,
	type AgentBrowserNetworkSourceLookupAnalysis,
	type AgentBrowserQaPresetAnalysis,
	type AgentBrowserSourceLookupAnalysis,
	type CompiledAgentBrowserElectron,
	type CompiledAgentBrowserJob,
	type CompiledAgentBrowserNetworkSourceLookup,
	type CompiledAgentBrowserQaPreset,
	type CompiledAgentBrowserSemanticAction,
	type CompiledAgentBrowserSourceLookup,
} from "../input-modes.js";
import { runAgentBrowserProcess } from "../process.js";
import {
	buildAgentBrowserNextActions,
	buildAgentBrowserResultCategoryDetails,
	buildToolPresentation,
	getAgentBrowserErrorText,
	parseAgentBrowserEnvelope,
	type AgentBrowserEnvelope,
	type AgentBrowserNextAction,
} from "../results.js";
import { formatSessionArtifactRetentionSummary } from "../results/artifact-manifest.js";
import type { SessionArtifactManifest } from "../results/contracts.js";
import {
	buildRichInputRecoveryDiagnostic,
	buildRichInputRecoveryNextActions,
	buildVisibleRefFallbackNextActions,
	formatRichInputRecoveryText,
	formatVisibleRefFallbackText,
	sanitizeVisibleRefFallbackDiagnostic,
	type RichInputRecoveryDiagnostic,
	type VisibleRefFallbackDiagnostic,
} from "../results/selector-recovery.js";
import {
	AgentBrowserNextActionCollector,
	alignPageChangeSummaryNextActionIds,
	isStandaloneSnapshotNextAction,
} from "../results/next-actions.js";
import {
	buildConnectedSessionNextActions,
	buildNoActivePageNextActions,
	buildSessionAwareStaleRefNextActions,
	buildSessionTabRecoveryNextActions,
} from "../results/recovery-next-actions.js";
import {
	SessionPageState,
	buildNoActivePageRefSnapshotInvalidation,
	commandExplicitlyTargetsAboutBlank,
	deriveSessionTabTarget,
	extractLatestRefSnapshotStateFromBatchResults,
	extractRefSnapshotFromData,
	extractSessionTabTargetFromBatchResults,
	extractSessionTabTargetFromCommandData,
	isAboutBlankSessionTabTarget,
	isNoActivePageSnapshotFailure,
	normalizeSessionTabTarget,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
	type SessionTabTarget,
} from "../session-page-state.js";
import {
	buildExecutionPlan,
	createFreshSessionName,
	extractCommandTokens,
	extractExplicitSessionName,
	hasLaunchScopedTabCorrectionFlag,
	redactInvocationArgs,
	redactSensitiveText,
	resolveManagedSessionState,
	type CompatibilityWorkaround,
	type OpenResultTabCorrection,
} from "../runtime.js";
import type { AgentBrowserExecuteParams, ResolvedAgentBrowserValidInput } from "./input-plan.js";

type AgentBrowserToolResult = AgentToolResult<unknown> & { isError?: boolean };
type JsonObject = Record<string, any>;
type BrowserRunServices = JsonObject;

type TraceOwner = "profiler" | "trace";
type PinnedBatchUnwrapMode = "single-command" | "user-batch";
type SemanticActionVisibleRefResolution = JsonObject;
type NavigationSummary = JsonObject;
type OverlayBlockerDiagnostic = JsonObject;
type AboutBlankSessionMismatch = JsonObject;
type ElectronPostCommandHealthDiagnostic = JsonObject;
type ElectronRefFreshnessDiagnostic = JsonObject;
type ElectronSessionMismatch = JsonObject;
type ElectronHandoffSummary = JsonObject;
type FillVerificationDiagnostic = JsonObject;
type SelectorTextVisibilityDiagnostic = JsonObject;
type ElectronBroadGetTextScopeDiagnostic = JsonObject;

interface BrowserRunInputFields {
	compiledElectron?: CompiledAgentBrowserElectron;
	compiledJob?: CompiledAgentBrowserJob;
	compiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	compiledQaPreset?: CompiledAgentBrowserQaPreset;
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	compiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	redactedArgs: string[];
	redactedCompiledElectron?: CompiledAgentBrowserElectron;
	redactedCompiledJob?: CompiledAgentBrowserJob;
	redactedCompiledNetworkSourceLookup?: CompiledAgentBrowserNetworkSourceLookup;
	redactedCompiledQaPreset?: CompiledAgentBrowserQaPreset;
	redactedCompiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	redactedCompiledSourceLookup?: CompiledAgentBrowserSourceLookup;
	toolArgs: string[];
	toolStdin?: string;
}

export interface BrowserRunState {
	artifactManifest?: SessionArtifactManifest;
	electronChildProcesses: Map<string, ChildProcess>;
	electronLaunchRecords: Map<string, ElectronLaunchRecord>;
	ephemeralSessionSeed: string;
	freshSessionOrdinal: number;
	managedSessionActive: boolean;
	managedSessionBaseName: string;
	managedSessionCwd: string;
	managedSessionName: string;
	sessionPageState: SessionPageState;
	traceOwners: Map<string, TraceOwner>;
}

export interface BrowserRunOptions {
	ctx: { cwd: string; sessionDir?: string };
	cwd: string;
	electronPostCommandStatusSettleMs: number;
	electronProfileIsolationDetails: unknown;
	implicitSessionCloseTimeoutMs: number;
	implicitSessionIdleTimeoutMs: string;
	input: ResolvedAgentBrowserValidInput;
	onUpdate?: (result: AgentToolResult<unknown>) => void;
	params: AgentBrowserExecuteParams;
	services: BrowserRunServices;
	sessionPageStateUpdate: ReturnType<SessionPageState["beginUpdate"]>;
	signal?: AbortSignal;
	state: BrowserRunState;
}

function normalizeRunInput(input: ResolvedAgentBrowserValidInput): BrowserRunInputFields {
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

export async function runAgentBrowserTool(options: BrowserRunOptions): Promise<AgentBrowserToolResult> {
	return new BrowserRunExecution(options).run();
}

class BrowserRunExecution {
	constructor(private readonly options: BrowserRunOptions) {}

	private get services(): BrowserRunServices {
		return this.options.services;
	}

	async run(): Promise<AgentBrowserToolResult> {
		const {
			applyOpenResultTabCorrection,
			buildAboutBlankRecoveryHint,
			buildAboutBlankWarning,
			buildElectronHostFailureResult,
			buildElectronPostCommandHealthDiagnostic,
			buildElectronRefFreshnessDiagnostic,
			buildElectronSessionMismatch,
			buildInvocationPreview,
			buildManagedSessionOutcome,
			buildPinnedBatchPlan,
			buildScrollNoopDiagnostic,
			buildSessionDetailFields,
			buildStaleRefPreflight,
			buildWrapperRecoveryHint,
			collectComboboxFocusDiagnostic,
			collectElectronBroadGetTextScopeDiagnostics,
			collectElectronHandoff,
			collectFillVerificationDiagnostic,
			collectNavigationSummary,
			collectOpenResultTabCorrection,
			collectOverlayBlockerDiagnostic,
			collectQaAttachedTarget,
			collectRecordingDependencyWarning,
			collectScrollPositionSnapshot,
			collectSelectorTextVisibilityDiagnostics,
			collectSessionTabSelection,
			collectTimeoutPartialProgress,
			closeManagedSession,
			extractStringResultField,
			findElectronLaunchRecordForSession,
			formatElectronPostCommandHealthText,
			formatElectronSessionMismatchText,
			formatQaAttachedTargetText,
			getArtifactCleanupGuidance,
			getElectronLaunchFailureCategory,
			getEvalStdinHint,
			getExactSensitiveStdinValues,
			getPersistentSessionArtifactStore,
			getSourceLookupElectronContext,
			getStaleRefArgs,
			getTraceOwnerGuardMessage,
			mergeNavigationSummaryIntoData,
			prepareAgentBrowserArgs,
			preserveParseFailureOutput,
			redactExactSensitiveValue,
			redactRecoveryHint,
			repairBatchScreenshotArtifacts,
			repairScreenshotArtifact,
			resolveSemanticActionVisibleRefArgs,
			shouldCaptureNavigationSummary,
			shouldCorrectSessionTabAfterCommand,
			shouldInspectElectronPostCommandHealth,
			shouldPinSessionTabForCommand,
			sleepMs,
			updateTraceOwnerState,
			unwrapPinnedSessionBatchEnvelope,
			validateStdinCommandContract,
			validateWaitIpcTimeoutContract,
		} = this.services;
		const { ctx, cwd, implicitSessionCloseTimeoutMs, implicitSessionIdleTimeoutMs, onUpdate, params, sessionPageStateUpdate, signal, state } = this.options;
		const { electronPostCommandStatusSettleMs } = this.options;
		const { sessionPageState, traceOwners, electronLaunchRecords, electronChildProcesses, managedSessionBaseName, ephemeralSessionSeed } = state;
		let { artifactManifest, freshSessionOrdinal, managedSessionActive, managedSessionCwd, managedSessionName } = state;
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
		} = normalizeRunInput(this.options.input);
		try {
			let runtimeToolArgs = toolArgs;
			let runtimeToolStdin = toolStdin;
			let electronLaunch: ElectronLaunchSuccess | undefined;
			let electronHandoff: ElectronHandoffSummary | undefined;
			let electronFailedConnectCleanup: ElectronCleanupResult | undefined;
			const sessionMode = compiledElectron?.action === "launch" ? "fresh" : params.sessionMode ?? "auto";
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
			const preparedArgs = await prepareAgentBrowserArgs(runtimeToolArgs, runtimeToolStdin, cwd);
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
					cwd: cwd,
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

			const priorSessionPageState = sessionPageState.get(executionPlan.sessionName);
			const priorSessionTabTarget = priorSessionPageState.tabTarget;
			const sessionTabPinningReason = priorSessionPageState.pinningReason;
			const priorRefSnapshotState = priorSessionPageState.refSnapshot;
			const priorRefSnapshotInvalidation = priorSessionPageState.refSnapshotInvalidation;
			const resolvedSemanticActionRefSnapshot = semanticActionVisibleRefResolution?.snapshot
				? { ...semanticActionVisibleRefResolution.snapshot, target: semanticActionVisibleRefResolution.snapshot.target ?? priorSessionTabTarget }
				: undefined;
			const staleRefPreflight = buildStaleRefPreflight({
				commandTokens,
				currentTarget: priorSessionTabTarget,
				refSnapshot: resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState,
				refSnapshotInvalidation: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotInvalidation,
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
						nextActions: buildSessionAwareStaleRefNextActions(executionPlan.sessionName),
						refIds: staleRefPreflight.refIds,
						refSnapshot: staleRefPreflight.snapshot,
						refSnapshotInvalidation: staleRefPreflight.snapshotInvalidation,
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
					cwd: cwd,
					sessionName: executionPlan.sessionName,
					signal,
					target: priorSessionTabTarget,
				});
				if (plannedSessionTabSelection && executionPlan.sessionName) {
					if (executionPlan.commandInfo.command === "eval" && runtimeToolStdin !== undefined) {
						const appliedSessionTabSelection = await applyOpenResultTabCorrection({
							correction: plannedSessionTabSelection,
							cwd: cwd,
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
						cwd: cwd,
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
				cwd: cwd,
				env: executionPlan.managedSessionName ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: implicitSessionIdleTimeoutMs } : undefined,
				signal,
				stdin: processStdin,
			});

			const missingBinaryResult = await this.buildMissingBinaryFailureResult({
				compatibilityWorkaround,
				electronLaunch,
				executionPlan,
				implicitSessionCloseTimeoutMs,
				managedSessionActive,
				managedSessionName,
				processResult,
				redactedArgs,
				redactedProcessArgs,
				sessionMode,
				sessionTabCorrection,
			});
			if (missingBinaryResult) {
				return missingBinaryResult;
			}


			return await this.parseBrowserOutput({
				aboutBlankSessionMismatch: undefined,
				artifactManifestMutable: {
					get artifactManifest() { return artifactManifest; },
					set artifactManifest(value) { artifactManifest = value; },
					get managedSessionActive() { return managedSessionActive; },
					set managedSessionActive(value) { managedSessionActive = value; },
					get managedSessionCwd() { return managedSessionCwd; },
					set managedSessionCwd(value) { managedSessionCwd = value; },
					get managedSessionName() { return managedSessionName; },
					set managedSessionName(value) { managedSessionName = value; },
				},
				artifactManifest,
				commandTokens,
				compiledElectron,
				compiledJob,
				compiledNetworkSourceLookup,
				compiledQaPreset,
				compiledSemanticAction,
				compiledSourceLookup,
				compatibilityWorkaround,
				cwd,
				electronFailedConnectCleanup,
				electronHandoff,
				electronLaunch,
				electronChildProcesses,
				electronLaunchRecords,
				electronPostCommandStatusSettleMs,
				exactSensitiveValues,
				executionPlan,
				includePinnedNavigationSummary,
				implicitSessionCloseTimeoutMs,
				managedSessionActive,
				managedSessionCwd,
				managedSessionName,
				pinnedBatchUnwrapMode,
				preparedArgs,
				priorSessionTabTarget,
				processResult,
				redactedArgs,
				redactedCompiledElectron,
				redactedCompiledJob,
				redactedCompiledNetworkSourceLookup,
				redactedCompiledQaPreset,
				redactedCompiledSemanticAction,
				redactedCompiledSourceLookup,
				redactedProcessArgs,
				redactedRecoveryHint,
				resolvedSemanticActionRefSnapshot,
				runtimeToolArgs,
				runtimeToolStdin,
				scrollPositionBefore,
				sessionMode,
				sessionPageState,
				sessionPageStateUpdate,
				sessionTabCorrection,
				sessionTabPinningReason,
				shouldProbeScrollNoop,
				signal,
				traceOwners,
				userRequestedJson,
				ctx,
			});
		} finally {
			state.artifactManifest = artifactManifest;
			state.freshSessionOrdinal = freshSessionOrdinal;
			state.managedSessionActive = managedSessionActive;
			state.managedSessionCwd = managedSessionCwd;
			state.managedSessionName = managedSessionName;
		}
	}



	private async parseBrowserOutput(options: JsonObject): Promise<AgentBrowserToolResult> {
		const {
			applyOpenResultTabCorrection,
			buildAboutBlankRecoveryHint,
			buildAboutBlankWarning,
			buildElectronPostCommandHealthDiagnostic,
			buildElectronRefFreshnessDiagnostic,
			buildElectronSessionMismatch,
			buildManagedSessionOutcome,
			buildScrollNoopDiagnostic,
			buildWrapperRecoveryHint,
			closeManagedSession,
			collectComboboxFocusDiagnostic,
			collectElectronBroadGetTextScopeDiagnostics,
			collectElectronHandoff,
			collectFillVerificationDiagnostic,
			collectNavigationSummary,
			collectOpenResultTabCorrection,
			collectOverlayBlockerDiagnostic,
			collectQaAttachedTarget,
			collectRecordingDependencyWarning,
			collectScrollPositionSnapshot,
			collectSelectorTextVisibilityDiagnostics,
			collectSessionTabSelection,
			collectTimeoutPartialProgress,
			extractStringResultField,
			findElectronLaunchRecordForSession,
			formatElectronPostCommandHealthText,
			formatElectronSessionMismatchText,
			formatQaAttachedTargetText,
			getArtifactCleanupGuidance,
			getEvalStdinHint,
			getPersistentSessionArtifactStore,
			getSourceLookupElectronContext,
			getStaleRefArgs,
			mergeNavigationSummaryIntoData,
			preserveParseFailureOutput,
			redactExactSensitiveValue,
			repairBatchScreenshotArtifacts,
			repairScreenshotArtifact,
			shouldCaptureNavigationSummary,
			shouldCorrectSessionTabAfterCommand,
			shouldInspectElectronPostCommandHealth,
			sleepMs,
			unwrapPinnedSessionBatchEnvelope,
			updateTraceOwnerState,
		} = this.services;
		const {
			artifactManifestMutable,
			commandTokens,
			compiledElectron,
			compiledJob,
			compiledNetworkSourceLookup,
			compiledQaPreset,
			compiledSemanticAction,
			compiledSourceLookup,
			compatibilityWorkaround,
			ctx,
			cwd,
			electronChildProcesses,
			electronLaunch,
			electronLaunchRecords,
			electronPostCommandStatusSettleMs,
			exactSensitiveValues,
			executionPlan,
			includePinnedNavigationSummary,
			implicitSessionCloseTimeoutMs,
			pinnedBatchUnwrapMode,
			preparedArgs,
			priorSessionTabTarget,
			processResult,
			redactedArgs,
			redactedCompiledElectron,
			redactedCompiledJob,
			redactedCompiledNetworkSourceLookup,
			redactedCompiledQaPreset,
			redactedCompiledSemanticAction,
			redactedCompiledSourceLookup,
			redactedProcessArgs,
			redactedRecoveryHint,
			resolvedSemanticActionRefSnapshot,
			runtimeToolArgs,
			runtimeToolStdin,
			scrollPositionBefore,
			sessionMode,
			sessionPageState,
			sessionPageStateUpdate,
			sessionTabPinningReason,
			shouldProbeScrollNoop,
			signal,
			traceOwners,
			userRequestedJson,
		} = options;
		let { artifactManifest, electronFailedConnectCleanup, electronHandoff, managedSessionActive, managedSessionCwd, managedSessionName, sessionTabCorrection } = options;
		try {
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
				cwd: cwd,
				envelope: presentationEnvelope,
				request: preparedArgs.screenshotPathRequest,
			});
			presentationEnvelope = repairedScreenshot.envelope;
			const repairedBatchScreenshots = await repairBatchScreenshotArtifacts({
				cwd: cwd,
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
					cwd: cwd,
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
					cwd: cwd,
					sessionName: executionPlan.sessionName,
					signal,
					targetTitle,
					targetUrl,
				});
				if (plannedTabCorrection) {
					openResultTabCorrection = await applyOpenResultTabCorrection({
						correction: plannedTabCorrection,
						cwd: cwd,
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
					cwd: cwd,
					sessionName: executionPlan.sessionName,
					signal,
					target: priorSessionTabTarget,
				});
				const appliedAboutBlankRecovery = aboutBlankRecovery
					? await applyOpenResultTabCorrection({
							correction: aboutBlankRecovery,
							cwd: cwd,
							sessionName: executionPlan.sessionName,
							signal,
					  })
					: undefined;
				if (appliedAboutBlankRecovery) {
					sessionTabCorrection = appliedAboutBlankRecovery;
					currentSessionTabTarget = priorSessionTabTarget;
				} else {
					currentSessionTabTarget = aboutBlankObservedTarget ?? normalizeSessionTabTarget({ url: "about:blank" });
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
					cwd: cwd,
					sessionName: executionPlan.sessionName,
					signal,
					target: observedSessionTabTarget,
				});
				if (postCommandTabCorrection) {
					const appliedPostCommandCorrection = await applyOpenResultTabCorrection({
						correction: postCommandTabCorrection,
						cwd: cwd,
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
					await sleepMs(electronPostCommandStatusSettleMs);
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
				cwd: cwd,
				sessionName: executionPlan.sessionName,
				stdin: runtimeToolStdin,
			}) : undefined;
			if (succeeded && electronRecordForCommand) {
				fillVerificationDiagnostic = await collectFillVerificationDiagnostic({
					commandTokens,
					cwd: cwd,
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
					cwd: cwd,
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
					cwd: cwd,
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
						cwd: cwd,
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
						cwd: cwd,
						sessionName: executionPlan.sessionName,
						signal,
					}),
				)
				: undefined;
			let currentRefSnapshot: SessionRefSnapshot | undefined;
			let currentRefSnapshotInvalidation: SessionRefSnapshotInvalidation | undefined;
			const batchRefSnapshotState = executionPlan.commandInfo.command === "batch"
				? extractLatestRefSnapshotStateFromBatchResults(presentationEnvelope?.data)
				: undefined;
			if (executionPlan.sessionName) {
				if (executionPlan.commandInfo.command === "close" && succeeded) {
					sessionPageState.clearSession(executionPlan.sessionName);
				} else if (currentSessionTabTarget) {
					const tabUpdate = sessionPageState.applyTabTarget({
						sessionName: executionPlan.sessionName,
						target: currentSessionTabTarget,
						update: sessionPageStateUpdate,
					});
					if (!tabUpdate.applied && succeeded) {
						// A stale overlapping command may have moved browser focus even though its older target
						// must not replace the newer logical target. Require tab pinning on the next call.
						sessionPageState.markPinning(executionPlan.sessionName, "drift");
					}
				}
				const refSnapshot = executionPlan.commandInfo.command === "batch"
					? batchRefSnapshotState?.snapshot
					: succeeded
						? executionPlan.commandInfo.command === "snapshot"
							? extractRefSnapshotFromData(presentationEnvelope?.data)
							: resolvedSemanticActionRefSnapshot ?? overlayBlockerDiagnostic?.snapshot
						: undefined;
				if (refSnapshot) {
					const refUpdate = sessionPageState.applyRefSnapshot({
						fallbackTarget: currentSessionTabTarget,
						sessionName: executionPlan.sessionName,
						snapshot: refSnapshot,
						update: sessionPageStateUpdate,
					});
					currentRefSnapshot = refUpdate.refSnapshot;
					currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
				} else {
					const stateView = sessionPageState.get(executionPlan.sessionName);
					currentRefSnapshot = stateView.refSnapshot;
					currentRefSnapshotInvalidation = stateView.refSnapshotInvalidation;
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
				managedSessionCwd = cwd;
			}
			if (executionPlan.sessionName && succeeded) {
				if (openResultTabCorrection || sessionTabCorrection || aboutBlankSessionMismatch?.recoveryApplied) {
					sessionPageState.markPinning(executionPlan.sessionName, "drift");
				} else if (sessionTabPinningReason === "restore") {
					sessionPageState.clearRestorePinning(executionPlan.sessionName);
				}
			}

			if (replacedManagedSessionName) {
				sessionPageState.clearSession(replacedManagedSessionName);
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
					electronLaunchRecords.set(electronLaunchRecord!.launchId, electronLaunchRecord!);
					electronChildProcesses.set(electronLaunchRecord!.launchId, electronLaunch.child);
					const electronHandoffMode = compiledElectron?.action === "launch" ? compiledElectron.handoff : "connect";
					try {
						electronHandoff = await collectElectronHandoff({
							cwd: cwd,
							handoff: electronHandoffMode,
							sessionName: executionPlan.sessionName,
							signal,
						});
					} catch (error) {
						electronHandoff = { error: error instanceof Error ? error.message : String(error), handoff: electronHandoffMode };
					}
					if (electronHandoff?.refSnapshot) {
						const refUpdate = sessionPageState.applyRefSnapshot({
							sessionName: executionPlan.sessionName,
							snapshot: electronHandoff.refSnapshot,
							update: sessionPageStateUpdate,
						});
						currentRefSnapshot = refUpdate.refSnapshot;
						currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
						if (electronHandoff.refSnapshot.target) {
							currentSessionTabTarget = electronHandoff.refSnapshot.target;
							sessionPageState.applyTabTarget({
								sessionName: executionPlan.sessionName,
								target: electronHandoff.refSnapshot.target,
								update: sessionPageStateUpdate,
							});
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

			const presentation: any = plainTextInspection
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
						cwd: cwd,
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
				? await collectQaAttachedTarget({ currentTarget: currentSessionTabTarget ?? priorSessionTabTarget, cwd: cwd, sessionName: executionPlan.sessionName, signal })
				: undefined;
			const sourceLookupElectronContext = compiledSourceLookup ? getSourceLookupElectronContext({
				currentTarget: currentSessionTabTarget,
				electronLaunchRecords,
				priorTarget: priorSessionTabTarget,
				sessionName: executionPlan.sessionName,
			}) : undefined;
			const sourceLookup = compiledSourceLookup ? await analyzeSourceLookupResults(presentationEnvelope?.data, compiledSourceLookup, cwd, {
				electronContext: sourceLookupElectronContext,
				workspaceRoot: cwd,
			}) : undefined;
			const networkSourceLookup = compiledNetworkSourceLookup ? redactNetworkSourceLookupAnalysis(await analyzeNetworkSourceLookupResults(presentationEnvelope?.data, compiledNetworkSourceLookup, cwd)) : undefined;
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
				cwd: cwd,
				manifest: resultArtifactManifest,
				succeeded,
			});
			const warningText = electronPostCommandHealth
				? formatElectronPostCommandHealthText(electronPostCommandHealth)
				: electronSessionMismatch
					? formatElectronSessionMismatchText(electronSessionMismatch)
					: aboutBlankSessionMismatch ? buildAboutBlankWarning(aboutBlankSessionMismatch) : undefined;
			const redactedContent = this.buildRedactedPresentationContent({
				exactSensitiveValues,
				plainTextInspection,
				presentation,
				presentationEnvelope,
				succeeded,
				userRequestedJson,
				warningText,
			});
			const finalRecoveryState = await this.prepareFinalResultRecoveryState({
				aboutBlankSessionMismatch,
				batchRefSnapshotState,
				commandTokens,
				compiledSemanticAction,
				currentRefSnapshot,
				currentRefSnapshotInvalidation,
				currentSessionTabTarget,
				cwd: cwd,
				electronPostCommandHealth,
				errorText,
				executionPlan,
				parseError,
				plainTextInspection,
				presentation,
				processResult,
				redactedProcessArgs,
				runtimeToolArgs,
				sessionPageState,
				sessionPageStateUpdate,
				sessionTabCorrection,
				signal,
				succeeded,
			});
			const { categoryDetails, noActivePageSnapshotFailure, richInputRecoveryDiagnostic, visibleRefFallbackDiagnostic, visibleRefFallbackSessionName } = finalRecoveryState;
			currentRefSnapshot = finalRecoveryState.currentRefSnapshot;
			currentRefSnapshotInvalidation = finalRecoveryState.currentRefSnapshotInvalidation;
			return this.buildFinalAgentBrowserToolResult({
				aboutBlankSessionMismatch,
				artifactCleanup,
				categoryDetails,
				comboboxFocusDiagnostic,
				compiledNetworkSourceLookup,
				compiledSemanticAction,
				compatibilityWorkaround,
				currentRefSnapshot,
				currentRefSnapshotInvalidation,
				currentSessionTabTarget,
				electronBroadGetTextScopeDiagnostics,
				electronFailedConnectCleanup,
				electronHandoff,
				electronLaunch,
				electronLaunchRecord,
				electronLaunchRecords,
				electronPostCommandHealth,
				electronRefFreshnessDiagnostic,
				electronSessionMismatch,
				errorText,
				evalStdinHint,
				exactSensitiveValues,
				executionPlan,
				fillVerificationDiagnostic,
				inspectionText,
				managedSessionOutcome,
				navigationSummary,
				networkSourceLookup,
				noActivePageSnapshotFailure,
				openResultTabCorrection,
				overlayBlockerDiagnostic,
				parseError,
				parseFailureOutput,
				parseSucceeded,
				plainTextInspection,
				presentation,
				presentationEnvelope,
				priorSessionTabTarget,
				processResult,
				qaAttachedTarget,
				qaPreset,
				recordingDependencyWarning,
				redactedArgs,
				redactedCompiledElectron,
				redactedCompiledJob,
				redactedCompiledNetworkSourceLookup,
				redactedCompiledQaPreset,
				redactedCompiledSemanticAction,
				redactedCompiledSourceLookup,
				redactedContent,
				redactedProcessArgs,
				redactedRecoveryHint,
				resultArtifactManifest,
				richInputRecoveryDiagnostic,
				scrollNoopDiagnostic,
				selectorTextVisibilityDiagnostics,
				sessionMode,
				sessionTabCorrection,
				sourceLookup,
				succeeded,
				timeoutPartialProgress,
				userRequestedJson,
				visibleRefFallbackDiagnostic,
				visibleRefFallbackSessionName,
			});
		} finally {
			if (processResult.stdoutSpillPath) {
				await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
			}
		}
		} finally {
			artifactManifestMutable.artifactManifest = artifactManifest;
			artifactManifestMutable.managedSessionActive = managedSessionActive;
			artifactManifestMutable.managedSessionCwd = managedSessionCwd;
			artifactManifestMutable.managedSessionName = managedSessionName;
		}
	}

	private async prepareFinalResultRecoveryState(options: JsonObject): Promise<JsonObject> {
		const { collectVisibleRefFallbackDiagnostic } = this.services;
		const {
			aboutBlankSessionMismatch,
			batchRefSnapshotState,
			commandTokens,
			compiledSemanticAction,
			currentSessionTabTarget,
			cwd,
			electronPostCommandHealth,
			errorText,
			executionPlan,
			parseError,
			plainTextInspection,
			presentation,
			processResult,
			redactedProcessArgs,
			runtimeToolArgs,
			sessionPageState,
			sessionPageStateUpdate,
			sessionTabCorrection,
			signal,
			succeeded,
		} = options;
		let currentRefSnapshot = options.currentRefSnapshot;
		let currentRefSnapshotInvalidation = options.currentRefSnapshotInvalidation;
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
				cwd,
				sessionName: visibleRefFallbackSessionName,
				signal,
			});
			if (visibleRefFallbackDiagnostic && visibleRefFallbackSessionName) {
				const refUpdate = sessionPageState.applyRefSnapshot({
					fallbackTarget: currentSessionTabTarget,
					sessionName: visibleRefFallbackSessionName,
					snapshot: visibleRefFallbackDiagnostic.snapshot,
					update: sessionPageStateUpdate,
				});
				currentRefSnapshot = refUpdate.refSnapshot;
				currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
			}
		}
		const richInputRecoveryDiagnostic = buildRichInputRecoveryDiagnostic(visibleRefFallbackDiagnostic);
		const noActivePageSnapshotFailure = categoryDetails.resultCategory === "failure" && (
			isNoActivePageSnapshotFailure(executionPlan.commandInfo.command, errorText ?? presentation.summary) ||
			batchRefSnapshotState?.invalidation !== undefined
		);
		if (noActivePageSnapshotFailure && executionPlan.sessionName) {
			const refUpdate = sessionPageState.applyRefSnapshotInvalidation({
				invalidation: buildNoActivePageRefSnapshotInvalidation(),
				sessionName: executionPlan.sessionName,
				update: sessionPageStateUpdate,
			});
			currentRefSnapshot = refUpdate.refSnapshot;
			currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
		}
		return {
			categoryDetails,
			currentRefSnapshot,
			currentRefSnapshotInvalidation,
			noActivePageSnapshotFailure,
			richInputRecoveryDiagnostic,
			visibleRefFallbackDiagnostic,
			visibleRefFallbackSessionName,
		};
	}

	private buildRedactedPresentationContent(options: JsonObject): AgentBrowserToolResult["content"] {
		const { buildJsonVisibleContent, redactExactSensitiveText } = this.services;
		const { exactSensitiveValues, plainTextInspection, presentation, presentationEnvelope, succeeded, userRequestedJson, warningText } = options;
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
		return (contentWithSessionWarnings as AgentBrowserToolResult["content"]).map((item) => {
			if (item.type !== "text") return item;
			const exactRedactedText = redactExactSensitiveText(item.text, exactSensitiveValues);
			return userRequestedJson && !plainTextInspection
				? { ...item, text: exactRedactedText }
				: { ...item, text: redactSensitiveText(exactRedactedText) };
		});
	}


	private buildResultNextActions(options: JsonObject): AgentBrowserNextAction[] | undefined {
		const {
			buildComboboxFocusNextActions,
			buildElectronBroadGetTextScopeNextActions,
			buildElectronIdentifiers,
			buildElectronLifecycleNextActions,
			buildElectronMismatchNextActions,
			buildElectronRefFreshnessNextActions,
			buildFillVerificationNextActions,
			buildOverlayBlockerNextActions,
			buildScrollNoopNextActions,
			buildSelectorTextVisibilityNextActions,
			buildSessionDetailFields,
			buildSemanticActionCandidateActions,
			buildSourceLookupElectronNextActions,
			formatArtifactCleanupGuidanceText,
			formatComboboxFocusDiagnosticText,
			formatElectronBroadGetTextScopeText,
			formatElectronLaunchText,
			formatElectronRefFreshnessText,
			formatEvalStdinHintText,
			formatFillVerificationText,
			formatManagedSessionOutcomeText,
			formatOverlayBlockerText,
			formatRecordingDependencyWarningText,
			formatScrollNoopDiagnosticText,
			formatSelectorTextVisibilityText,
			formatSemanticActionCandidateText,
			formatTimeoutPartialProgressText,
			redactExactSensitiveText,
			redactToolDetails,
		} = this.services;
		const {
			aboutBlankSessionMismatch,
			artifactCleanup,
			categoryDetails,
			comboboxFocusDiagnostic,
			compiledNetworkSourceLookup,
			compiledSemanticAction,
			compatibilityWorkaround,
			currentRefSnapshot,
			currentRefSnapshotInvalidation,
			currentSessionTabTarget,
			electronBroadGetTextScopeDiagnostics,
			electronFailedConnectCleanup,
			electronHandoff,
			electronLaunch,
			electronLaunchRecord,
			electronLaunchRecords,
			electronPostCommandHealth,
			electronRefFreshnessDiagnostic,
			electronSessionMismatch,
			errorText,
			evalStdinHint,
			exactSensitiveValues,
			executionPlan,
			fillVerificationDiagnostic,
			inspectionText,
			managedSessionOutcome,
			navigationSummary,
			networkSourceLookup,
			noActivePageSnapshotFailure,
			openResultTabCorrection,
			overlayBlockerDiagnostic,
			parseError,
			parseFailureOutput,
			parseSucceeded,
			plainTextInspection,
			presentation,
			presentationEnvelope,
			priorSessionTabTarget,
			processResult,
			qaAttachedTarget,
			qaPreset,
			recordingDependencyWarning,
			redactedArgs,
			redactedCompiledElectron,
			redactedCompiledJob,
			redactedCompiledNetworkSourceLookup,
			redactedCompiledQaPreset,
			redactedCompiledSemanticAction,
			redactedCompiledSourceLookup,
			redactedContent,
			redactedProcessArgs,
			redactedRecoveryHint,
			resultArtifactManifest,
			richInputRecoveryDiagnostic,
			scrollNoopDiagnostic,
			selectorTextVisibilityDiagnostics,
			sessionMode,
			sessionTabCorrection,
			sourceLookup,
			succeeded,
			timeoutPartialProgress,
			userRequestedJson,
			visibleRefFallbackDiagnostic,
			visibleRefFallbackSessionName,
		} = options;
		const nextActionCollector = new AgentBrowserNextActionCollector(presentation.nextActions);
		if (categoryDetails.resultCategory === "success" && executionPlan.commandInfo.command === "connect" && !electronLaunchRecord) {
			nextActionCollector.appendUnique(buildConnectedSessionNextActions(executionPlan.sessionName));
		}
		if (noActivePageSnapshotFailure) {
			nextActionCollector.appendUnique(buildNoActivePageNextActions(executionPlan.sessionName));
		}
		if (aboutBlankSessionMismatch) {
			nextActionCollector.appendUnique(buildSessionTabRecoveryNextActions({
				kind: "about-blank",
				recoveryApplied: aboutBlankSessionMismatch.recoveryApplied,
				sessionName: executionPlan.sessionName,
				tabCorrection: aboutBlankSessionMismatch.recoveryApplied ? sessionTabCorrection : undefined,
				target: { title: aboutBlankSessionMismatch.targetTitle, url: aboutBlankSessionMismatch.targetUrl },
			}));
			if (!aboutBlankSessionMismatch.recoveryApplied) {
				nextActionCollector.removeWhere(isStandaloneSnapshotNextAction);
			}
		} else if (categoryDetails.resultCategory === "success" && (sessionTabCorrection || openResultTabCorrection)) {
			nextActionCollector.appendUnique(buildSessionTabRecoveryNextActions({
				kind: "tab-drift",
				recoveryApplied: true,
				sessionName: executionPlan.sessionName,
				tabCorrection: sessionTabCorrection ?? openResultTabCorrection,
				target: currentSessionTabTarget ?? priorSessionTabTarget,
			}));
		}
		if (categoryDetails.failureCategory === "stale-ref") {
			nextActionCollector.replace(buildSessionAwareStaleRefNextActions(executionPlan.sessionName));
		}
		if (visibleRefFallbackDiagnostic) {
			nextActionCollector.append(buildVisibleRefFallbackNextActions({ diagnostic: visibleRefFallbackDiagnostic, sessionName: visibleRefFallbackSessionName }));
		}
		if (richInputRecoveryDiagnostic) {
			nextActionCollector.append(buildRichInputRecoveryNextActions({ diagnostic: richInputRecoveryDiagnostic, sessionName: visibleRefFallbackSessionName }));
		}
		if (electronPostCommandHealth) {
			const electronRecord = electronLaunchRecords.get(electronPostCommandHealth.launchId);
			if (electronRecord) {
				nextActionCollector.appendUnique(buildElectronLifecycleNextActions(electronRecord));
			}
		}
		if (electronSessionMismatch) {
			const electronRecord = electronLaunchRecords.get(electronSessionMismatch.launchId);
			if (electronRecord) {
				nextActionCollector.appendUnique(buildElectronMismatchNextActions(electronRecord, electronSessionMismatch.liveTarget));
			}
		}
		if (categoryDetails.failureCategory === "selector-not-found" && redactedCompiledSemanticAction) {
			const candidateActions = buildSemanticActionCandidateActions(redactedCompiledSemanticAction);
			if (candidateActions.length > 0) {
				nextActionCollector.append(candidateActions);
			}
		}
		if (overlayBlockerDiagnostic) {
			nextActionCollector.append(buildOverlayBlockerNextActions({ diagnostic: overlayBlockerDiagnostic, sessionName: executionPlan.sessionName }));
		}
		if (fillVerificationDiagnostic) {
			nextActionCollector.appendUnique(buildFillVerificationNextActions(fillVerificationDiagnostic, executionPlan.sessionName));
		}
		if (electronRefFreshnessDiagnostic) {
			nextActionCollector.appendUnique(buildElectronRefFreshnessNextActions(executionPlan.sessionName));
		}
		if (selectorTextVisibilityDiagnostics.length > 0) {
			nextActionCollector.append(buildSelectorTextVisibilityNextActions({ diagnostics: selectorTextVisibilityDiagnostics, sessionName: executionPlan.sessionName }));
		}
		if (electronBroadGetTextScopeDiagnostics.length > 0) {
			nextActionCollector.append(buildElectronBroadGetTextScopeNextActions({ diagnostics: electronBroadGetTextScopeDiagnostics, sessionName: executionPlan.sessionName }));
		}
		if (sourceLookup?.electronContext) {
			nextActionCollector.appendUnique(buildSourceLookupElectronNextActions(sourceLookup));
		}
		if (scrollNoopDiagnostic) {
			nextActionCollector.append(buildScrollNoopNextActions(executionPlan.sessionName));
		}
		if (comboboxFocusDiagnostic) {
			nextActionCollector.append(buildComboboxFocusNextActions(executionPlan.sessionName));
		}
		if (categoryDetails.failureCategory === "stale-ref" && redactedCompiledSemanticAction && isCompiledSemanticActionFindCommand(compiledSemanticAction)) {
			nextActionCollector.append([{
				id: "retry-semantic-action-after-stale-ref",
				params: { args: redactedCompiledSemanticAction.args },
				reason: "Retry the same semantic target via its compiled find command after the upstream stale-ref failure proves the prior action did not execute.",
				safety: "Use only for the same intended target; direct stale @refs still require a fresh snapshot or stable locator before retrying.",
				tool: "agent_browser" as const,
			}]);
		}
		if (electronLaunchRecord) {
			nextActionCollector.append(buildAgentBrowserNextActions({
				electron: { launchId: electronLaunchRecord.launchId, sessionName: electronLaunchRecord.sessionName, status: electronLaunchRecord.cleanupState },
				failureCategory: categoryDetails.failureCategory,
				resultCategory: categoryDetails.resultCategory,
				successCategory: categoryDetails.successCategory,
			}));
		}
		const nextActions = nextActionCollector.toArray();
		return nextActions;
	}

	private buildAgentBrowserResultDetails(options: JsonObject, nextActions: AgentBrowserNextAction[] | undefined): JsonObject {
		const { buildElectronIdentifiers, buildSessionDetailFields } = this.services;
		const {
			aboutBlankSessionMismatch,
			artifactCleanup,
			categoryDetails,
			comboboxFocusDiagnostic,
			compiledNetworkSourceLookup,
			compiledSemanticAction,
			compatibilityWorkaround,
			currentRefSnapshot,
			currentRefSnapshotInvalidation,
			currentSessionTabTarget,
			electronBroadGetTextScopeDiagnostics,
			electronFailedConnectCleanup,
			electronHandoff,
			electronLaunch,
			electronLaunchRecord,
			electronLaunchRecords,
			electronPostCommandHealth,
			electronRefFreshnessDiagnostic,
			electronSessionMismatch,
			errorText,
			evalStdinHint,
			exactSensitiveValues,
			executionPlan,
			fillVerificationDiagnostic,
			inspectionText,
			managedSessionOutcome,
			navigationSummary,
			networkSourceLookup,
			noActivePageSnapshotFailure,
			openResultTabCorrection,
			overlayBlockerDiagnostic,
			parseError,
			parseFailureOutput,
			parseSucceeded,
			plainTextInspection,
			presentation,
			presentationEnvelope,
			priorSessionTabTarget,
			processResult,
			qaAttachedTarget,
			qaPreset,
			recordingDependencyWarning,
			redactedArgs,
			redactedCompiledElectron,
			redactedCompiledJob,
			redactedCompiledNetworkSourceLookup,
			redactedCompiledQaPreset,
			redactedCompiledSemanticAction,
			redactedCompiledSourceLookup,
			redactedContent,
			redactedProcessArgs,
			redactedRecoveryHint,
			resultArtifactManifest,
			richInputRecoveryDiagnostic,
			scrollNoopDiagnostic,
			selectorTextVisibilityDiagnostics,
			sessionMode,
			sessionTabCorrection,
			sourceLookup,
			succeeded,
			timeoutPartialProgress,
			userRequestedJson,
			visibleRefFallbackDiagnostic,
			visibleRefFallbackSessionName,
		} = options;
		const publicVisibleRefFallbackDiagnostic = visibleRefFallbackDiagnostic
			? sanitizeVisibleRefFallbackDiagnostic(visibleRefFallbackDiagnostic)
			: undefined;
		const rawPageChangeSummary = (scrollNoopDiagnostic || comboboxFocusDiagnostic) && presentation.pageChangeSummary
			? { ...presentation.pageChangeSummary, nextActionIds: nextActions?.map((action) => action.id) }
			: presentation.pageChangeSummary;
		const pageChangeSummary = alignPageChangeSummaryNextActionIds(rawPageChangeSummary, nextActions);
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
				profileIsolation: this.options.electronProfileIsolationDetails,
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
			visibleRefFallback: publicVisibleRefFallbackDiagnostic,
			richInputRecovery: richInputRecoveryDiagnostic,
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
			refSnapshotInvalidation: currentRefSnapshotInvalidation,
			...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
			sessionRecoveryHint: redactedRecoveryHint,
			startupScopedFlags: executionPlan.startupScopedFlags,
			stderr: processResult.stderr,
			stdout: plainTextInspection ? inspectionText ?? "" : parseSucceeded ? undefined : processResult.stdout,
			summary: presentation.summary,
			timedOut: processResult.timedOut || undefined,
			timeoutMs: processResult.timeoutMs,
		};
		return details;
	}

	private buildFinalAgentBrowserToolResult(options: JsonObject): AgentBrowserToolResult {
		const {
			buildComboboxFocusNextActions,
			buildElectronBroadGetTextScopeNextActions,
			buildElectronIdentifiers,
			buildElectronLifecycleNextActions,
			buildElectronMismatchNextActions,
			buildElectronRefFreshnessNextActions,
			buildFillVerificationNextActions,
			buildOverlayBlockerNextActions,
			buildScrollNoopNextActions,
			buildSelectorTextVisibilityNextActions,
			buildSessionDetailFields,
			buildSemanticActionCandidateActions,
			buildSourceLookupElectronNextActions,
			formatArtifactCleanupGuidanceText,
			formatComboboxFocusDiagnosticText,
			formatElectronBroadGetTextScopeText,
			formatElectronLaunchText,
			formatElectronRefFreshnessText,
			formatEvalStdinHintText,
			formatFillVerificationText,
			formatManagedSessionOutcomeText,
			formatOverlayBlockerText,
			formatRecordingDependencyWarningText,
			formatScrollNoopDiagnosticText,
			formatSelectorTextVisibilityText,
			formatSemanticActionCandidateText,
			formatTimeoutPartialProgressText,
			redactExactSensitiveText,
			redactToolDetails,
		} = this.services;
		const {
			aboutBlankSessionMismatch,
			artifactCleanup,
			categoryDetails,
			comboboxFocusDiagnostic,
			compiledNetworkSourceLookup,
			compiledSemanticAction,
			compatibilityWorkaround,
			currentRefSnapshot,
			currentRefSnapshotInvalidation,
			currentSessionTabTarget,
			electronBroadGetTextScopeDiagnostics,
			electronFailedConnectCleanup,
			electronHandoff,
			electronLaunch,
			electronLaunchRecord,
			electronLaunchRecords,
			electronPostCommandHealth,
			electronRefFreshnessDiagnostic,
			electronSessionMismatch,
			errorText,
			evalStdinHint,
			exactSensitiveValues,
			executionPlan,
			fillVerificationDiagnostic,
			inspectionText,
			managedSessionOutcome,
			navigationSummary,
			networkSourceLookup,
			noActivePageSnapshotFailure,
			openResultTabCorrection,
			overlayBlockerDiagnostic,
			parseError,
			parseFailureOutput,
			parseSucceeded,
			plainTextInspection,
			presentation,
			presentationEnvelope,
			priorSessionTabTarget,
			processResult,
			qaAttachedTarget,
			qaPreset,
			recordingDependencyWarning,
			redactedArgs,
			redactedCompiledElectron,
			redactedCompiledJob,
			redactedCompiledNetworkSourceLookup,
			redactedCompiledQaPreset,
			redactedCompiledSemanticAction,
			redactedCompiledSourceLookup,
			redactedContent,
			redactedProcessArgs,
			redactedRecoveryHint,
			resultArtifactManifest,
			richInputRecoveryDiagnostic,
			scrollNoopDiagnostic,
			selectorTextVisibilityDiagnostics,
			sessionMode,
			sessionTabCorrection,
			sourceLookup,
			succeeded,
			timeoutPartialProgress,
			userRequestedJson,
			visibleRefFallbackDiagnostic,
			visibleRefFallbackSessionName,
		} = options;
		const nextActions = this.buildResultNextActions(options);
		const details = this.buildAgentBrowserResultDetails(options, nextActions);

		const visibleRefFallbackText = formatVisibleRefFallbackText(visibleRefFallbackDiagnostic);
		const richInputRecoveryText = formatRichInputRecoveryText(richInputRecoveryDiagnostic);
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
		const rawAppendedDiagnosticText = [visibleRefFallbackText, richInputRecoveryText, semanticActionCandidateText, overlayBlockerText, fillVerificationText, electronRefFreshnessText, selectorTextVisibilityText, electronBroadGetTextScopeText, scrollNoopDiagnosticText, comboboxFocusDiagnosticText, recordingDependencyWarningText, evalStdinHintText, artifactCleanupText, timeoutPartialProgressText, managedSessionOutcomeText].filter((item): item is string => item !== undefined).join("\n\n");
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
	}

	private async buildMissingBinaryFailureResult(options: JsonObject): Promise<AgentBrowserToolResult | undefined> {
		const { buildManagedSessionOutcome, buildMissingBinaryMessage, formatManagedSessionOutcomeText } = this.services;
		const { compatibilityWorkaround, electronLaunch, executionPlan, implicitSessionCloseTimeoutMs, managedSessionActive, managedSessionName, processResult, redactedArgs, redactedProcessArgs, sessionMode, sessionTabCorrection } = options;
		if (!processResult.spawnError?.message.includes("ENOENT")) return undefined;
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
		const textParts = [
			errorText,
			managedSessionOutcomeText,
			missingBinaryElectronCleanup ? `Electron cleanup after failed attach: ${missingBinaryElectronCleanup.summary}` : undefined,
		].filter((part): part is string => part !== undefined && part.length > 0);
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
}
