import { rm } from "node:fs/promises";

import { getAgentBrowserSessionIdentityKey, isAgentBrowserSessionIdentityKeyInNamespace } from "../../argv-grammar.js";
import { batchHasSuccessfulCloseAll, getSuccessfulBatchCloseLifecycle } from "../../batch-lifecycle.js";
import { isCloseAllCommand, isCloseCommand, isOpenNavigationCommand, isUnverifiedPageTransitionCommand } from "../../command-taxonomy.js";
import { OPEN_RESULT_TAB_CORRECTION_FLAGS } from "../../launch-scoped-flags.js";
import { cleanupElectronLaunchResources, inspectElectronLaunchStatus, type ElectronCleanupResult } from "../../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import { getResultingPageTargetState, commandRequiresLivePageVerification } from "../../page-target-validation.js";
import { analyzeNetworkSourceLookupResults, analyzeSourceLookupResults, redactNetworkSourceLookupAnalysis } from "../../input-modes/lookups.js";
import { analyzeQaPresetResults, analyzeQaPresetTimeout, buildQaCompactFailureText, buildQaCompactPassText, extractQaPageContext } from "../../input-modes/job.js";
import { applyNetworkRouteRecords, buildNetworkRouteDiagnostics } from "../../results/network-routes.js";
import { buildToolPresentation } from "../../results/presentation.js";
import { getAgentBrowserErrorText, parseAgentBrowserEnvelope } from "../../results/envelope.js";
import { type AgentBrowserEnvelope } from "../../results/contracts.js";
import type { NetworkRouteRecord } from "../../results/contracts.js";
import { omitUpstreamLifecycle } from "../../results/presentation/common.js";
import { getClipboardWritePayloadCandidates, redactClipboardPermissionEcho, redactClipboardPermissionErrorValue } from "../../results/presentation/errors.js";
import { shouldCaptureSemanticActionNavigationSummary } from "../../results/presentation/semantic-action.js";
import {
	buildPageTransitionRefSnapshotInvalidation,
	commandExplicitlyTargetsAboutBlank,
	getCommandRefSnapshotInvalidation,
	deriveSessionTabTarget,
	extractLatestRefSnapshotStateFromBatchResults,
	extractRefSnapshotFromData,
	extractSessionTabTargetFromBatchResults,
	extractSessionTabTargetFromCommandData,
	isAboutBlankSessionTabTarget,
	normalizeSessionTabTarget,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
} from "../../session-page-state.js";
import { isRecord } from "../../parsing.js";
import { pruneOwnedManagedSessionRestoreSnapshots } from "../../managed-session-restore.js";
import { isManagedSessionRestoreKey } from "../../managed-session-storage.js";
import { createFreshSessionName, extractUpstreamCommandTokens, resolveManagedSessionState } from "../../runtime.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { closeManagedSession, inspectManagedSessionDaemon } from "./managed-session-daemon-policy.js";
import {
	applyOpenResultTabCorrection,
	buildAboutBlankRecoveryHint,
	buildAboutBlankWarning,
	buildElectronPostCommandHealthDiagnostic,
	buildElectronRefFreshnessDiagnostic,
	buildElectronSessionMismatch,
	buildManagedSessionOutcome,
	collectOpenResultTabCorrection,
	collectSessionTabSelection,
	extractNavigationSummaryFromData,
	extractStringResultField,
	findElectronLaunchRecordForSession,
	formatElectronPostCommandHealthText,
	formatElectronSessionMismatchText,
	getSessionContextKey,
	getStaleRefArgs,
	mergeNavigationSummaryIntoData,
	shouldCaptureNavigationSummary,
	shouldCorrectSessionTabAfterCommand,
	shouldInspectElectronPostCommandHealth,
	unwrapPinnedSessionBatchEnvelope,
	updateTraceOwnerState,
} from "./session-state.js";
import { collectClickDispatchDiagnostic } from "./click-dispatch.js";
import {
	buildScrollNoopDiagnostic,
	collectComboboxFocusDiagnostic,
	collectElectronBroadGetTextScopeDiagnostics,
	collectElectronHandoff,
	collectFillVerificationDiagnostic,
	collectNavigationSummary,
	collectOverlayBlockerDiagnostic,
	collectQaAttachedTarget,
	collectSnapshotOverlayBlockerDiagnostic,
	collectRecordingDependencyWarning,
	collectScrollPositionSnapshot,
	collectSelectorTextVisibilityDiagnostics,
	collectTimeoutPartialProgress,
	sleepMs,
	formatQaAttachedTargetText,
	getArtifactCleanupGuidance,
	getEvalResultWarning,
	getEvalStdinHint,
	getSourceLookupElectronContext,
} from "./diagnostics.js";
import { repairScreenshotData } from "./prepare.js";
import { getPersistentSessionArtifactStore } from "./session-state.js";
import {
	buildFinalAgentBrowserToolResult,
	buildRedactedPresentationContent,
	buildWrapperRecoveryHint,
	prepareFinalResultRecoveryState,
	redactExactSensitiveValue,
} from "./final-result.js";
import type {
	AboutBlankSessionMismatch,
	BrowserProcessOutputResult,
	BrowserRunStatePatch,
	ParseFailureOutput,
	ProcessBrowserOutputInput,
	ScreenshotArtifactRequest,
	ScreenshotPathRequest,
} from "./types.js";

async function repairScreenshotArtifact(options: {
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	request?: ScreenshotPathRequest;
}): Promise<{ envelope?: AgentBrowserEnvelope; request?: ScreenshotArtifactRequest }> {
	const { cwd, envelope, request } = options;
	if (!request || !envelope || !isRecord(envelope.data)) return { envelope, request };
	const repaired = await repairScreenshotData({ cwd, data: envelope.data, request });
	return { envelope: { ...envelope, data: repaired.data }, request: repaired.request };
}

async function repairBatchScreenshotArtifacts(options: {
	cwd: string;
	envelope?: AgentBrowserEnvelope;
	requests?: Array<ScreenshotPathRequest | undefined>;
}): Promise<{ envelope?: AgentBrowserEnvelope; requests?: Array<ScreenshotArtifactRequest | undefined> }> {
	const { cwd, envelope, requests } = options;
	if (!envelope || !Array.isArray(envelope.data) || !requests?.some((request) => request !== undefined)) return { envelope, requests };
	const repairedRequests: Array<ScreenshotArtifactRequest | undefined> = [];
	const repairedData = await Promise.all(envelope.data.map(async (item, index) => {
		const request = requests[index];
		if (!request || !isRecord(item) || !isRecord(item.result)) return item;
		const repaired = await repairScreenshotData({ cwd, data: item.result, request });
		repairedRequests[index] = repaired.request;
		return { ...item, result: repaired.data };
	}));
	return { envelope: { ...envelope, data: repairedData }, requests: repairedRequests };
}

function getEnvelopeErrorString(envelope: AgentBrowserEnvelope | undefined): string | undefined {
	if (!envelope?.error) return undefined;
	if (typeof envelope.error === "string") return envelope.error;
	if (isRecord(envelope.error) && typeof envelope.error.message === "string") return envelope.error.message;
	return String(envelope.error);
}

function isStreamEnableAlreadyEnabledNoop(options: { command: string | undefined; envelope: AgentBrowserEnvelope | undefined; processSucceeded: boolean; subcommand: string | undefined }): boolean {
	if (!options.processSucceeded || options.command !== "stream" || options.subcommand !== "enable" || options.envelope?.success !== false) return false;
	const message = (getEnvelopeErrorString(options.envelope) ?? "").trim().replace(/[.!]+$/, "").toLowerCase();
	return message === "streaming is already enabled for this session" || message === "streaming is already enabled" || message === "stream already enabled";
}

function isPendingWebMcpMutation(command: string | undefined, subcommand: string | undefined, data: unknown): boolean {
	return command === "webmcp"
		&& ["invoke", "result"].includes(subcommand ?? "")
		&& isRecord(data)
		&& data.status === "pending";
}

function isWebMcpSettlementCommand(command: string | undefined, subcommand: string | undefined): boolean {
	return command === "webmcp" && ["result", "cancel"].includes(subcommand ?? "");
}

function batchHasPendingWebMcpMutation(data: unknown): boolean {
	if (!Array.isArray(data)) return false;
	return data.some((row) => {
		if (!isRecord(row) || row.success === false || !Array.isArray(row.command) || !row.command.every((token) => typeof token === "string")) return false;
		const [command, subcommand] = extractUpstreamCommandTokens(row.command as string[]);
		return isPendingWebMcpMutation(command, subcommand, row.result);
	});
}

function batchHasFailedWebMcpSettlement(data: unknown): boolean {
	if (!Array.isArray(data)) return false;
	return data.some((row) => {
		if (!isRecord(row) || row.success !== false || !Array.isArray(row.command) || !row.command.every((token) => typeof token === "string")) return false;
		const [command, subcommand] = extractUpstreamCommandTokens(row.command as string[]);
		return isWebMcpSettlementCommand(command, subcommand);
	});
}

function batchStartedManagedBrowser(data: unknown): boolean {
	if (!Array.isArray(data)) return false;
	return data.some((entry) => {
		if (!isRecord(entry) || entry.success !== true || !Array.isArray(entry.command)) return false;
		const command = typeof entry.command[0] === "string" ? entry.command[0] : undefined;
		return command === "connect" || command === "goto" || command === "navigate" || isOpenNavigationCommand(command);
	});
}

function withoutNamespaceEntries<T>(entries: ReadonlyMap<string, T>, namespace?: string): Map<string, T> {
	return new Map([...entries].filter(([key]) => !isAgentBrowserSessionIdentityKeyInNamespace(key, namespace)));
}

function deleteNamespaceEntries(entries: Set<string> | Map<string, unknown>, namespace?: string): void {
	for (const key of entries.keys()) {
		if (isAgentBrowserSessionIdentityKeyInNamespace(key, namespace)) entries.delete(key);
	}
}

function setNetworkRouteState(options: { routes?: NetworkRouteRecord[]; routesBySession: Map<string, NetworkRouteRecord[]>; sessionName: string | undefined }): Map<string, NetworkRouteRecord[]> {
	if (!options.sessionName) return options.routesBySession;
	const previousRoutes = options.routesBySession.get(options.sessionName);
	if (options.routes === previousRoutes) return options.routesBySession;
	const next = new Map(options.routesBySession);
	if (options.routes && options.routes.length > 0) next.set(options.sessionName, options.routes);
	else next.delete(options.sessionName);
	return next;
}

function applyNetworkRouteState(options: { commandTokens: string[]; routesBySession: Map<string, NetworkRouteRecord[]>; sessionName: string | undefined; succeeded: boolean }): Map<string, NetworkRouteRecord[]> {
	const routes = options.sessionName ? applyNetworkRouteRecords(options.routesBySession.get(options.sessionName), options.commandTokens, options.succeeded) : undefined;
	return setNetworkRouteState({ routes, routesBySession: options.routesBySession, sessionName: options.sessionName });
}

function applyBatchNetworkRouteState(options: { data: unknown; routesBySession: Map<string, NetworkRouteRecord[]>; sessionName: string | undefined; succeeded: boolean }): Map<string, NetworkRouteRecord[]> {
	if (!options.succeeded || !options.sessionName || !Array.isArray(options.data)) return options.routesBySession;
	let routes = options.routesBySession.get(options.sessionName);
	for (const item of options.data) {
		if (!isRecord(item) || !Array.isArray(item.command) || !item.command.every((token) => typeof token === "string")) continue;
		const commandTokens = extractUpstreamCommandTokens(item.command as string[]);
		const stepSucceeded = item.success !== false;
		if (stepSucceeded && isCloseCommand(commandTokens[0])) routes = undefined;
		else routes = applyNetworkRouteRecords(routes, commandTokens, stepSucceeded);
	}
	return setNetworkRouteState({ routes, routesBySession: options.routesBySession, sessionName: options.sessionName });
}

export async function processBrowserOutput(input: ProcessBrowserOutputInput): Promise<BrowserProcessOutputResult> {
	const { ctx, cwd, electronPostCommandStatusSettleMs, implicitSessionCloseTimeoutMs, sessionPageStateUpdate, signal, state } = input;
	const { prepared, processResult } = input;
	const { electronChildProcesses, electronLaunchRecords, sessionPageState, traceOwners } = state;
	let artifactManifest = state.artifactManifest;
	let freshSessionOrdinal = state.freshSessionOrdinal;
	let managedSessionActive = state.managedSessionActive;
	let managedSessionCompatibilityWorkaround = state.managedSessionCompatibilityWorkaround;
	let managedSessionHeadedAutosaveDisabled = state.managedSessionHeadedAutosaveDisabled === true;
	let managedSessionHeadedAutosaveInterval = state.managedSessionHeadedAutosaveInterval;
	let managedSessionCwd = state.managedSessionCwd;
	let managedSessionName = state.managedSessionName;
	let managedSessionNamespace = state.managedSessionNamespace;
	let networkRoutesBySession = state.networkRoutesBySession;
	try {
		const persistentArtifactStore = getPersistentSessionArtifactStore(ctx);
		const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
		let parseError = parsed.parseError;
		let presentationEnvelope = parsed.envelope;
		let navigationSummary = undefined as Awaited<ReturnType<typeof collectNavigationSummary>> | undefined;
		let failedTransitionReverification = false;
		if (prepared.pinnedBatchUnwrapMode) {
			const pinnedBatchResult = unwrapPinnedSessionBatchEnvelope({ envelope: parsed.envelope, includeNavigationSummary: prepared.includePinnedNavigationSummary, mode: prepared.pinnedBatchUnwrapMode });
			parseError = pinnedBatchResult.parseError ?? parseError;
			presentationEnvelope = pinnedBatchResult.envelope ?? presentationEnvelope;
			navigationSummary = pinnedBatchResult.navigationSummary;
		}
		const repairedScreenshot = await repairScreenshotArtifact({ cwd, envelope: presentationEnvelope, request: prepared.preparedArgs.screenshotPathRequest });
		presentationEnvelope = repairedScreenshot.envelope;
		const repairedBatchScreenshots = await repairBatchScreenshotArtifacts({ cwd, envelope: presentationEnvelope, requests: prepared.preparedArgs.batchScreenshotPathRequests });
		presentationEnvelope = repairedBatchScreenshots.envelope;
		const screenshotArtifactRequest = repairedScreenshot.request;
		const batchScreenshotArtifactRequests = repairedBatchScreenshots.requests;
		const batchCommandSteps = prepared.executionPlan.commandInfo.command === "batch"
			? getUpstreamEffectiveBatchSteps(prepared.commandTokens, prepared.runtimeToolStdin)
			: [];
		const nestedBatchClose = prepared.executionPlan.commandInfo.command === "batch"
			? getSuccessfulBatchCloseLifecycle(presentationEnvelope?.data, batchCommandSteps)
			: undefined;
		const nestedBatchClosed = nestedBatchClose?.endsClosed === true;
		const nestedBatchRemainsActive = nestedBatchClose?.endsClosed === false;
		const nestedBatchClosesAll = prepared.executionPlan.commandInfo.command === "batch"
			&& batchHasSuccessfulCloseAll(presentationEnvelope?.data, batchCommandSteps);
		const directCloseAllRequested = isCloseAllCommand(extractUpstreamCommandTokens(prepared.commandTokens));
		const rawCloseStatePath = isCloseCommand(prepared.executionPlan.commandInfo.command)
			&& isRecord(presentationEnvelope?.data)
			&& typeof presentationEnvelope.data.statePath === "string"
			? presentationEnvelope.data.statePath
			: nestedBatchClose?.statePath;
		if (presentationEnvelope && prepared.exactSensitiveValues.length > 0) presentationEnvelope = redactExactSensitiveValue(presentationEnvelope, prepared.exactSensitiveValues) as AgentBrowserEnvelope;
		const parseFailureOutput: ParseFailureOutput = parseError && processResult.stdoutSpillPath
			? { fullOutputUnavailable: "Malformed upstream output was discarded because it may contain sensitive browser data." }
			: {};
		const processSucceeded = !processResult.aborted && !processResult.spawnError && processResult.exitCode === 0;
		const plainTextInspection = prepared.executionPlan.plainTextInspection && processSucceeded;
		const parseSucceeded = plainTextInspection || parseError === undefined;
		if (isStreamEnableAlreadyEnabledNoop({ command: prepared.executionPlan.commandInfo.command, envelope: presentationEnvelope, processSucceeded, subcommand: prepared.executionPlan.commandInfo.subcommand })) {
			presentationEnvelope = { success: true, data: { alreadyEnabled: true, enabled: true, message: getEnvelopeErrorString(presentationEnvelope) ?? "Stream already enabled" } };
		}
		const envelopeSuccess = plainTextInspection ? true : presentationEnvelope?.success !== false;
		let succeeded = processSucceeded && parseSucceeded && envelopeSuccess;
		const inspectionText = plainTextInspection ? processResult.stdout.trim() : undefined;
		const sessionStateKey = getSessionContextKey(prepared.executionPlan.sessionName, prepared.executionPlan.namespace);
		const closeAllApplied = nestedBatchClosesAll || (directCloseAllRequested && succeeded);
		if (closeAllApplied) {
			networkRoutesBySession = withoutNamespaceEntries(networkRoutesBySession, prepared.executionPlan.namespace);
			deleteNamespaceEntries(state.attachedSessionKeys, prepared.executionPlan.namespace);
			deleteNamespaceEntries(traceOwners, prepared.executionPlan.namespace);
			sessionPageState.clearNamespace(prepared.executionPlan.namespace);
			const retainedSessionKey = nestedBatchRemainsActive ? sessionStateKey : undefined;
			for (const [key, owner] of state.ownedManagedSessions) {
				if (!isAgentBrowserSessionIdentityKeyInNamespace(key, prepared.executionPlan.namespace) || key === retainedSessionKey) continue;
				state.closedManagedSessionNames.add(key);
				state.managedSessionRestoreState.clear(owner.sessionName, owner.namespace);
			}
		} else if (nestedBatchClose && sessionStateKey) {
			networkRoutesBySession = new Map(networkRoutesBySession);
			networkRoutesBySession.delete(sessionStateKey);
			sessionPageState.clearSession(sessionStateKey);
		}
		if (prepared.executionPlan.commandInfo.command === "batch" && Array.isArray(presentationEnvelope?.data)) {
			for (const [index, row] of presentationEnvelope.data.entries()) {
				if (!isRecord(row)) continue;
				const rowCommand = Array.isArray(row.command) && row.command.every((token) => typeof token === "string")
					? row.command as string[]
					: batchCommandSteps[index];
				if (!rowCommand) continue;
				const [command, subcommand] = extractUpstreamCommandTokens(rowCommand);
				updateTraceOwnerState({ command, sessionName: sessionStateKey, subcommand, succeeded: row.success === true, traceOwners });
			}
		} else {
			updateTraceOwnerState({ command: prepared.executionPlan.commandInfo.command, sessionName: sessionStateKey, subcommand: prepared.executionPlan.commandInfo.subcommand, succeeded, traceOwners });
		}

		let clickDispatchDiagnostic: Awaited<ReturnType<typeof collectClickDispatchDiagnostic>>;
		if (succeeded && prepared.clickDispatchProbe) {
			clickDispatchDiagnostic = await collectClickDispatchDiagnostic({ cwd, namespace: prepared.executionPlan.namespace, probe: prepared.clickDispatchProbe, sessionName: prepared.executionPlan.sessionName, signal });
			if (clickDispatchDiagnostic) {
				succeeded = false;
				presentationEnvelope = { ...(presentationEnvelope ?? {}), error: clickDispatchDiagnostic.summary, success: false };
			}
		}

		const resultingPageState = getResultingPageTargetState({
			args: prepared.executionPlan.effectiveArgs,
			currentPageUrl: prepared.priorSessionTabTarget?.url,
			pageUrlUnknown: prepared.priorSessionTabTargetUnknown === true,
			stdin: prepared.runtimeToolStdin,
			trustedFirstBatchTabSelection: prepared.pinnedBatchUnwrapMode !== undefined,
		});
		if (
			succeeded &&
			!navigationSummary &&
			(shouldCaptureNavigationSummary(prepared.executionPlan.commandInfo.command, presentationEnvelope?.data, prepared.executionPlan.commandInfo.subcommand) ||
				shouldCaptureSemanticActionNavigationSummary(prepared.compiledSemanticAction, presentationEnvelope?.data) ||
				commandRequiresLivePageVerification(prepared.executionPlan.effectiveArgs, prepared.runtimeToolStdin) ||
				(prepared.executionPlan.commandInfo.command === "tab" && prepared.executionPlan.commandInfo.subcommand === "close"))
		) {
			navigationSummary = await collectNavigationSummary({ cwd, namespace: prepared.executionPlan.namespace, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName, signal });
		}
		// A failed eval/back/forward/reload/state-load/tab would otherwise drop the page to unverified and force the
		// agent through a manual get url round trip. Probe the live URL ourselves instead: an observed page
		// stays verified, and a failed
		// probe preserves the existing unknown-target behavior.
		if (
			succeeded === false &&
			!navigationSummary &&
			processResult.agentBrowserStarted &&
			!processResult.aborted &&
			!processResult.timedOut &&
			prepared.executionPlan.commandInfo.command !== "batch" &&
			isUnverifiedPageTransitionCommand(prepared.executionPlan.commandInfo.command, prepared.executionPlan.commandInfo.subcommand)
		) {
			navigationSummary = await collectNavigationSummary({ cwd, namespace: prepared.executionPlan.namespace, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName, signal });
			// A failed transition command can still have mutated or replaced the document before throwing, so
			// keeping the verified URL must not keep the prior snapshot refs (markTabTargetUnknown dropped
			// them before this probe existed); invalidate so the next ref use requires a fresh snapshot.
			failedTransitionReverification = navigationSummary !== undefined;
		}
		if (navigationSummary && presentationEnvelope && prepared.executionPlan.commandInfo.command !== "eval" && !Array.isArray(presentationEnvelope.data)) presentationEnvelope = { ...presentationEnvelope, data: mergeNavigationSummaryIntoData(presentationEnvelope.data, navigationSummary) };
		let overlayBlockerDiagnostic: Awaited<ReturnType<typeof collectOverlayBlockerDiagnostic>>;

		let openResultTabCorrection: Awaited<ReturnType<typeof collectOpenResultTabCorrection>>;
		if (succeeded && prepared.executionPlan.sessionName && prepared.executionPlan.startupScopedFlags.some((flag) => OPEN_RESULT_TAB_CORRECTION_FLAGS.has(flag)) && isOpenNavigationCommand(prepared.executionPlan.commandInfo.command) && !commandExplicitlyTargetsAboutBlank(prepared.commandTokens)) {
			const targetTitle = extractStringResultField(presentationEnvelope?.data, "title");
			const targetUrl = extractStringResultField(presentationEnvelope?.data, "url");
			const plannedTabCorrection = await collectOpenResultTabCorrection({ cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal, targetTitle, targetUrl });
			if (plannedTabCorrection) openResultTabCorrection = await applyOpenResultTabCorrection({ correction: plannedTabCorrection, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal });
		}

		const verifiesCurrentUrl = prepared.executionPlan.commandInfo.command === "get" && prepared.executionPlan.commandInfo.subcommand === "url";
		const trustsReportedPageTarget = !resultingPageState.pageUrlUnknown || verifiesCurrentUrl;
		const pendingWebMcpMutation = isPendingWebMcpMutation(
			prepared.executionPlan.commandInfo.command,
			prepared.executionPlan.commandInfo.subcommand,
			presentationEnvelope?.data,
		) || (prepared.executionPlan.commandInfo.command === "batch" && batchHasPendingWebMcpMutation(presentationEnvelope?.data));
		const failedWebMcpSettlement = prepared.priorSessionTabTargetUnknown === true && (
			(!succeeded && isWebMcpSettlementCommand(prepared.executionPlan.commandInfo.command, prepared.executionPlan.commandInfo.subcommand))
			|| (prepared.executionPlan.commandInfo.command === "batch" && batchHasFailedWebMcpSettlement(presentationEnvelope?.data))
		);
		const unsettledWebMcpMutation = pendingWebMcpMutation || failedWebMcpSettlement;
		const observedSessionTabTarget = unsettledWebMcpMutation
			? undefined
			: normalizeSessionTabTarget(navigationSummary)
				?? (trustsReportedPageTarget ? extractSessionTabTargetFromBatchResults(presentationEnvelope?.data) : undefined)
				?? (succeeded && trustsReportedPageTarget ? extractSessionTabTargetFromCommandData(prepared.commandTokens, presentationEnvelope?.data) : undefined);
		const safeObservedSessionTabTarget = observedSessionTabTarget;
		let currentSessionTabTarget = safeObservedSessionTabTarget;
		if (!currentSessionTabTarget && nestedBatchClose === undefined) {
			currentSessionTabTarget = resultingPageState.pageTargetMayHaveChanged
				? succeeded ? normalizeSessionTabTarget({ url: resultingPageState.currentPageUrl }) : undefined
				: deriveSessionTabTarget({ command: prepared.executionPlan.commandInfo.command, data: presentationEnvelope?.data, navigationSummary, previousTarget: prepared.priorSessionTabTarget, subcommand: prepared.executionPlan.commandInfo.subcommand });
		}
		let aboutBlankSessionMismatch: AboutBlankSessionMismatch | undefined;
		let electronPostCommandHealth: ReturnType<typeof buildElectronPostCommandHealthDiagnostic>;
		let electronRefFreshnessDiagnostic: ReturnType<typeof buildElectronRefFreshnessDiagnostic>;
		let electronSessionMismatch: ReturnType<typeof buildElectronSessionMismatch>;
		let electronStatusAfterCommand: Awaited<ReturnType<typeof inspectElectronLaunchStatus>> | undefined;
		const shouldTreatAboutBlankAsMismatch = succeeded && nestedBatchClose === undefined && prepared.priorSessionTabTarget !== undefined && !isAboutBlankSessionTabTarget(prepared.priorSessionTabTarget) && isAboutBlankSessionTabTarget(observedSessionTabTarget ?? currentSessionTabTarget) && !commandExplicitlyTargetsAboutBlank(prepared.commandTokens);
		let sessionTabCorrection = prepared.sessionTabCorrection;
		if (shouldTreatAboutBlankAsMismatch && prepared.priorSessionTabTarget) {
			const aboutBlankObservedTarget = observedSessionTabTarget ?? currentSessionTabTarget;
			const aboutBlankRecovery = await collectSessionTabSelection({ cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal, target: prepared.priorSessionTabTarget });
			const appliedAboutBlankRecovery = aboutBlankRecovery ? await applyOpenResultTabCorrection({ correction: aboutBlankRecovery, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal }) : undefined;
			if (appliedAboutBlankRecovery) { sessionTabCorrection = appliedAboutBlankRecovery; currentSessionTabTarget = prepared.priorSessionTabTarget; }
			else currentSessionTabTarget = aboutBlankObservedTarget ?? normalizeSessionTabTarget({ url: "about:blank" });
			aboutBlankSessionMismatch = { activeUrl: "about:blank", recoveryApplied: appliedAboutBlankRecovery !== undefined, recoveryHint: buildAboutBlankRecoveryHint(), targetTitle: prepared.priorSessionTabTarget.title, targetUrl: prepared.priorSessionTabTarget.url };
			const electronRecord = findElectronLaunchRecordForSession(prepared.executionPlan.sessionName, electronLaunchRecords, prepared.executionPlan.namespace);
			if (electronRecord && prepared.executionPlan.sessionName) {
				electronStatusAfterCommand = await inspectElectronLaunchStatus(electronRecord);
				electronSessionMismatch = buildElectronSessionMismatch({ managedSession: { sessionName: prepared.executionPlan.sessionName, title: aboutBlankObservedTarget?.title, url: aboutBlankObservedTarget?.url ?? "about:blank" }, record: electronRecord, statusTargets: electronStatusAfterCommand.targets });
			}
		}
		if (succeeded && prepared.priorSessionTabTarget && !sessionTabCorrection && !aboutBlankSessionMismatch && !commandExplicitlyTargetsAboutBlank(prepared.commandTokens) && observedSessionTabTarget && shouldCorrectSessionTabAfterCommand({ command: prepared.executionPlan.commandInfo.command, pinningRequired: prepared.sessionTabPinningReason !== undefined, sessionName: prepared.executionPlan.sessionName })) {
			const postCommandTabCorrection = await collectSessionTabSelection({ cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal, target: observedSessionTabTarget });
			if (postCommandTabCorrection) {
				const appliedPostCommandCorrection = await applyOpenResultTabCorrection({ correction: postCommandTabCorrection, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal });
				if (appliedPostCommandCorrection && !sessionTabCorrection) sessionTabCorrection = appliedPostCommandCorrection;
			}
		}
		const electronRecordForCommand = findElectronLaunchRecordForSession(prepared.executionPlan.sessionName, electronLaunchRecords, prepared.executionPlan.namespace);
		if (succeeded && electronRecordForCommand && shouldInspectElectronPostCommandHealth(prepared.executionPlan.commandInfo.command)) {
			electronStatusAfterCommand ??= await inspectElectronLaunchStatus(electronRecordForCommand);
			electronPostCommandHealth = buildElectronPostCommandHealthDiagnostic({ command: prepared.executionPlan.commandInfo.command, record: electronRecordForCommand, status: electronStatusAfterCommand, target: observedSessionTabTarget ?? currentSessionTabTarget });
			if (electronPostCommandHealth && electronPostCommandHealth.reason !== "process-dead") {
				await sleepMs(electronPostCommandStatusSettleMs);
				electronStatusAfterCommand = await inspectElectronLaunchStatus(electronRecordForCommand);
				electronPostCommandHealth = buildElectronPostCommandHealthDiagnostic({ command: prepared.executionPlan.commandInfo.command, record: electronRecordForCommand, status: electronStatusAfterCommand, target: observedSessionTabTarget ?? currentSessionTabTarget });
			}
			if (electronPostCommandHealth) succeeded = false;
		}
		let fillVerificationDiagnostic: Awaited<ReturnType<typeof collectFillVerificationDiagnostic>>;
		let selectorTextVisibilityDiagnostics: Awaited<ReturnType<typeof collectSelectorTextVisibilityDiagnostics>> = [];
		let electronBroadGetTextScopeDiagnostics: ReturnType<typeof collectElectronBroadGetTextScopeDiagnostics> = [];
		const timeoutPartialProgress = processResult.timedOut ? await collectTimeoutPartialProgress({ command: prepared.executionPlan.commandInfo.command, compiledJob: prepared.compiledJob, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, stdin: prepared.runtimeToolStdin }) : undefined;
		if (!currentSessionTabTarget && timeoutPartialProgress?.currentPage?.source === "live") {
			currentSessionTabTarget = normalizeSessionTabTarget(timeoutPartialProgress.currentPage);
		}
		if (succeeded) {
			const fillRefSnapshot = prepared.resolvedSemanticActionRefSnapshot ?? prepared.priorRefSnapshotState;
			fillVerificationDiagnostic = await collectFillVerificationDiagnostic({ commandTokens: prepared.commandTokens, cwd, forceValueVerification: electronRecordForCommand !== undefined, namespace: prepared.executionPlan.namespace, refSnapshot: fillRefSnapshot, sessionName: prepared.executionPlan.sessionName, signal });
		}
		if (succeeded && electronRecordForCommand) {
			electronRefFreshnessDiagnostic = buildElectronRefFreshnessDiagnostic({ command: prepared.executionPlan.commandInfo.command, commandTokens: prepared.commandTokens, record: electronRecordForCommand, sessionName: prepared.executionPlan.sessionName, stdin: prepared.runtimeToolStdin });
		}
		if (succeeded && prepared.executionPlan.commandInfo.command === "snapshot") {
			overlayBlockerDiagnostic = collectSnapshotOverlayBlockerDiagnostic(presentationEnvelope?.data);
		}
		if (succeeded && !overlayBlockerDiagnostic && !sessionTabCorrection && !aboutBlankSessionMismatch && !electronRecordForCommand && !clickDispatchDiagnostic) overlayBlockerDiagnostic = await collectOverlayBlockerDiagnostic({ command: prepared.executionPlan.commandInfo.command, cwd, data: presentationEnvelope?.data, namespace: prepared.executionPlan.namespace, navigationSummary, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName, signal });
		if (succeeded) {
			selectorTextVisibilityDiagnostics = await collectSelectorTextVisibilityDiagnostics({ commandInfo: prepared.executionPlan.commandInfo, commandTokens: prepared.commandTokens, cwd, data: presentationEnvelope?.data, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal });
			if (electronRecordForCommand) electronBroadGetTextScopeDiagnostics = collectElectronBroadGetTextScopeDiagnostics({ commandInfo: prepared.executionPlan.commandInfo, commandTokens: prepared.commandTokens, currentTarget: currentSessionTabTarget, data: presentationEnvelope?.data, electronLaunchRecords, namespace: prepared.executionPlan.namespace, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName });
		}
		const activeNetworkRoutes = sessionStateKey ? networkRoutesBySession.get(sessionStateKey) : undefined;
		const networkRouteDiagnostics = succeeded && prepared.executionPlan.commandInfo.command === "network" && prepared.executionPlan.commandInfo.subcommand === "requests" && prepared.executionPlan.sessionName
			? buildNetworkRouteDiagnostics(presentationEnvelope?.data, activeNetworkRoutes)
			: undefined;
		networkRoutesBySession = applyNetworkRouteState({ commandTokens: prepared.commandTokens, routesBySession: networkRoutesBySession, sessionName: sessionStateKey, succeeded });
		const comboboxFocusDiagnostic = succeeded ? await collectComboboxFocusDiagnostic({ command: prepared.executionPlan.commandInfo.command, commandTokens: prepared.commandTokens, cwd, namespace: prepared.executionPlan.namespace, semanticAction: prepared.compiledSemanticAction, sessionName: prepared.executionPlan.sessionName, signal }) : undefined;
		const recordingDependencyWarning = await collectRecordingDependencyWarning({ command: prepared.executionPlan.commandInfo.command, commandTokens: prepared.commandTokens, succeeded });
		const scrollNoopDiagnostic = succeeded && prepared.shouldProbeScrollNoop ? buildScrollNoopDiagnostic(prepared.scrollPositionBefore, await collectScrollPositionSnapshot({ cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal })) : undefined;
		const batchRefSnapshotState = prepared.executionPlan.commandInfo.command === "batch" ? extractLatestRefSnapshotStateFromBatchResults(presentationEnvelope?.data) : undefined;
		let currentRefSnapshot: SessionRefSnapshot | undefined;
		let currentRefSnapshotInvalidation: SessionRefSnapshotInvalidation | undefined;
		if (sessionStateKey) {
			const sessionClosed = (isCloseCommand(prepared.executionPlan.commandInfo.command) && succeeded) || nestedBatchClosed;
			if (sessionClosed) {
				state.attachedSessionKeys.delete(sessionStateKey);
				networkRoutesBySession = new Map(networkRoutesBySession);
				networkRoutesBySession.delete(sessionStateKey);
				sessionPageState.clearSession(sessionStateKey);
				state.closedManagedSessionNames.add(sessionStateKey);
			} else {
				// A batch that times out or returns unparseable output yields no result rows, but the daemon
				// may already have executed a recording swap or page-provided WebMCP tool; fall back to the
				// planned steps then. This can over-invalidate by one snapshot, but never under-invalidates.
				const directTransitionInvalidation = getCommandRefSnapshotInvalidation(prepared.commandTokens);
				const plannedBatchTransitionInvalidation = !Array.isArray(presentationEnvelope?.data)
					? batchCommandSteps.map(getCommandRefSnapshotInvalidation).find((invalidation) => invalidation !== undefined)
					: undefined;
				const pageTransitionInvalidation = unsettledWebMcpMutation
					? buildPageTransitionRefSnapshotInvalidation("A detached WebMCP invocation is still pending or failed to settle and can mutate, rerender, or navigate the page, so prior snapshot refs remain invalid after URL verification. Run webmcp result or cancel, then take a fresh snapshot before using page-scoped refs.")
					: processResult.agentBrowserStarted && (directTransitionInvalidation || plannedBatchTransitionInvalidation)
						? directTransitionInvalidation ?? plannedBatchTransitionInvalidation
					: failedTransitionReverification
						? buildPageTransitionRefSnapshotInvalidation("A failed eval/back/forward/reload/connect/state-load/tab command may still have changed the page, so the prior snapshot refs were invalidated. Run snapshot -i before using page-scoped refs.")
						: batchRefSnapshotState?.invalidation?.reason === "page-transition"
							? batchRefSnapshotState.invalidation
							: undefined;
				if (currentSessionTabTarget) {
					const tabUpdate = sessionPageState.applyTabTarget({ sessionName: sessionStateKey, target: currentSessionTabTarget, update: sessionPageStateUpdate });
					if (!tabUpdate.applied && succeeded) sessionPageState.markPinning(sessionStateKey, "drift");
				} else if (processResult.agentBrowserStarted && (resultingPageState.pageUrlUnknown || resultingPageState.pageTargetMayHaveChanged)) {
					sessionPageState.markTabTargetUnknown({ sessionName: sessionStateKey, update: sessionPageStateUpdate });
				}
				const refSnapshot = unsettledWebMcpMutation
					? undefined
					: prepared.executionPlan.commandInfo.command === "batch"
						? batchRefSnapshotState?.snapshot
						: succeeded
							? prepared.executionPlan.commandInfo.command === "snapshot" ? extractRefSnapshotFromData(presentationEnvelope?.data) : prepared.resolvedSemanticActionRefSnapshot ?? overlayBlockerDiagnostic?.snapshot
							: undefined;
				if (refSnapshot) {
					const refUpdate = sessionPageState.applyRefSnapshot({ fallbackTarget: currentSessionTabTarget, sessionName: sessionStateKey, snapshot: refSnapshot, update: sessionPageStateUpdate });
					currentRefSnapshot = refUpdate.refSnapshot;
					currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
				} else if (pageTransitionInvalidation) {
					const refUpdate = sessionPageState.applyRefSnapshotInvalidation({ invalidation: pageTransitionInvalidation, sessionName: sessionStateKey, update: sessionPageStateUpdate });
					currentRefSnapshot = refUpdate.refSnapshot;
					currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
				} else {
					const stateView = sessionPageState.get(sessionStateKey);
					currentRefSnapshot = stateView.refSnapshot;
					currentRefSnapshotInvalidation = stateView.refSnapshotInvalidation;
				}
			}
		}

		const priorManagedSessionActive = managedSessionActive;
		const priorManagedSessionCwd = managedSessionCwd;
		const priorManagedSessionHeadedAutosaveInterval = managedSessionHeadedAutosaveInterval;
		const priorManagedSessionName = managedSessionName;
		const priorManagedSessionNamespace = managedSessionNamespace;
		const priorManagedSessionKey = getSessionContextKey(priorManagedSessionName, priorManagedSessionNamespace) ?? priorManagedSessionName;
		const closeAllTargetsPriorManagedSession = closeAllApplied
			&& priorManagedSessionActive
			&& isAgentBrowserSessionIdentityKeyInNamespace(priorManagedSessionKey, prepared.executionPlan.namespace);
		const closeAllRetainsPriorManagedSession = closeAllTargetsPriorManagedSession
			&& nestedBatchRemainsActive
			&& sessionStateKey === priorManagedSessionKey;
		const closeAllClosesPriorManagedSession = closeAllTargetsPriorManagedSession && !closeAllRetainsPriorManagedSession;
		const commandClosesSession = isCloseCommand(prepared.executionPlan.commandInfo.command) || nestedBatchClosed || closeAllClosesPriorManagedSession;
		const closeCommandSucceeded = (isCloseCommand(prepared.executionPlan.commandInfo.command) && succeeded) || nestedBatchClosed || closeAllClosesPriorManagedSession;
		const closeTargetsPriorManagedNamespace = prepared.executionPlan.namespace === priorManagedSessionNamespace;
		const managedCloseSessionName = closeAllClosesPriorManagedSession
			? priorManagedSessionName
			: closeCommandSucceeded && prepared.executionPlan.sessionName === priorManagedSessionName && closeTargetsPriorManagedNamespace
				? prepared.executionPlan.sessionName
				: prepared.executionPlan.managedSessionName;
		const postLaunchBatchFailure = !succeeded && processSucceeded && parseSucceeded && prepared.sessionMode === "fresh" && prepared.executionPlan.commandInfo.command === "batch" && batchStartedManagedBrowser(presentationEnvelope?.data);
		const postLaunchTimeoutWithPage = !succeeded && processResult.timedOut && prepared.sessionMode === "fresh" && prepared.executionPlan.commandInfo.command === "batch" && timeoutPartialProgress?.liveUrlRecovered === true;
		const failedFreshSessionMayHaveStarted = !succeeded
			&& (processResult.agentBrowserStarted || (!processResult.aborted && processResult.spawnError === undefined))
			&& prepared.sessionMode === "fresh"
			&& prepared.executionPlan.managedSessionName === prepared.executionPlan.sessionName;
		const failedFreshDaemon = failedFreshSessionMayHaveStarted && prepared.executionPlan.sessionName
			? await inspectManagedSessionDaemon({
				cwd,
				headedManagedAutosaveInterval: prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval,
				namespace: prepared.executionPlan.namespace,
				sessionName: prepared.executionPlan.sessionName,
				timeoutMs: Math.min(implicitSessionCloseTimeoutMs, 2_000),
			})
			: undefined;
		if (failedFreshDaemon?.status === "active") {
			state.managedSessionRestoreState.recordDaemonRestoreKey(prepared.executionPlan.sessionName, prepared.executionPlan.namespace, failedFreshDaemon.restoreKey);
		}
		// Only a confirmed inactive daemon proves that a started fresh command did not establish browser ownership.
		const postLaunchFreshFailure = failedFreshDaemon !== undefined && failedFreshDaemon.status !== "inactive";
		const managedTransitionSucceeded = succeeded || nestedBatchClosed || nestedBatchRemainsActive || postLaunchBatchFailure || postLaunchTimeoutWithPage || postLaunchFreshFailure;
		const managedSessionState = resolveManagedSessionState({ command: commandClosesSession ? "close" : prepared.executionPlan.commandInfo.command, managedSessionName: managedCloseSessionName, managedSessionNamespace: prepared.executionPlan.namespace, priorActive: priorManagedSessionActive, priorNamespace: priorManagedSessionNamespace, priorSessionName: priorManagedSessionName, succeeded: managedTransitionSucceeded });
		if (!managedTransitionSucceeded && prepared.sessionMode === "fresh" && prepared.executionPlan.managedSessionName) {
			state.managedSessionRestoreState.clear(prepared.executionPlan.managedSessionName, prepared.executionPlan.namespace);
		}
		const replacedManagedSessionName = managedSessionState.replacedSessionName;
		managedSessionActive = managedSessionState.active;
		managedSessionName = managedSessionState.sessionName;
		managedSessionNamespace = managedSessionState.namespace;
		const executionTargetsManagedSession = prepared.executionPlan.sessionName
			&& getAgentBrowserSessionIdentityKey(prepared.executionPlan.sessionName, prepared.executionPlan.namespace)
				=== getAgentBrowserSessionIdentityKey(managedSessionName, managedSessionNamespace);
		if (!managedSessionActive) {
			managedSessionCompatibilityWorkaround = undefined;
			managedSessionHeadedAutosaveDisabled = false;
			managedSessionHeadedAutosaveInterval = undefined;
		} else if (managedTransitionSucceeded && executionTargetsManagedSession) {
			managedSessionCompatibilityWorkaround = prepared.compatibilityWorkaround;
			managedSessionHeadedAutosaveDisabled = prepared.ownedManagedSessionContext?.headedManagedAutosaveDisabled === true;
			managedSessionHeadedAutosaveInterval = prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval;
		}
		if (closeCommandSucceeded && managedCloseSessionName === priorManagedSessionName && !managedSessionActive) {
			const daemonRestoreKey = state.managedSessionRestoreState.getDaemonRestoreKey(managedCloseSessionName, priorManagedSessionNamespace);
			const ownedRestoreKey = !state.managedSessionRestoreState.isDisabled(managedCloseSessionName, priorManagedSessionNamespace)
				&& isManagedSessionRestoreKey(daemonRestoreKey) ? daemonRestoreKey : null;
			state.managedSessionRestoreState.clear(managedCloseSessionName, priorManagedSessionNamespace);
			pruneOwnedManagedSessionRestoreSnapshots({
				cwd,
				namespace: priorManagedSessionNamespace,
				restoreKey: ownedRestoreKey,
				statePath: rawCloseStatePath,
			});
			freshSessionOrdinal += 1;
			managedSessionName = createFreshSessionName(state.managedSessionBaseName, state.ephemeralSessionSeed, freshSessionOrdinal);
			managedSessionNamespace = undefined;
		}
		let managedSessionOutcome = buildManagedSessionOutcome({ activeAfter: managedSessionActive, activeBefore: priorManagedSessionActive, attemptedSessionName: managedCloseSessionName, command: commandClosesSession ? "close" : prepared.executionPlan.commandInfo.command, currentSessionName: managedSessionName, currentSessionNamespace: managedSessionNamespace, previousSessionName: priorManagedSessionName, replacedSessionName: replacedManagedSessionName, replacedSessionNamespace: priorManagedSessionNamespace, sessionMode: prepared.sessionMode, succeeded: managedTransitionSucceeded });
		if (prepared.executionPlan.managedSessionName && managedTransitionSucceeded && managedSessionActive) {
			managedSessionCwd = cwd;
			managedSessionNamespace = prepared.executionPlan.namespace;
		}
		if (sessionStateKey && succeeded) {
			if (openResultTabCorrection || sessionTabCorrection || aboutBlankSessionMismatch?.recoveryApplied) sessionPageState.markPinning(sessionStateKey, "drift");
			else if (prepared.sessionTabPinningReason === "restore") sessionPageState.clearRestorePinning(sessionStateKey);
		}
		if (replacedManagedSessionName) {
			const replacedSessionStateKey = getSessionContextKey(replacedManagedSessionName, priorManagedSessionNamespace);
			networkRoutesBySession = new Map(networkRoutesBySession);
			networkRoutesBySession.delete(replacedSessionStateKey ?? replacedManagedSessionName);
			sessionPageState.clearSession(replacedSessionStateKey ?? replacedManagedSessionName);
			const replacedSessionKey = replacedSessionStateKey ?? replacedManagedSessionName;
			const replacedCloseError = await closeManagedSession({ cwd: priorManagedSessionCwd, headedManagedAutosaveInterval: priorManagedSessionHeadedAutosaveInterval, namespace: priorManagedSessionNamespace, preserveAttachedBrowserSession: state.attachedSessionKeys.has(replacedSessionKey), restoreState: state.managedSessionRestoreState, sessionName: replacedManagedSessionName, timeoutMs: implicitSessionCloseTimeoutMs });
			if (managedSessionOutcome) {
				managedSessionOutcome = {
					...managedSessionOutcome,
					replacedSessionClosed: !replacedCloseError,
					summary: replacedCloseError
						? `${managedSessionOutcome.summary} Previous session ${replacedManagedSessionName} remains wrapper-owned because automatic close failed; retry an explicit close.`
						: managedSessionOutcome.summary,
				};
			}
			if (!replacedCloseError) {
				state.attachedSessionKeys.delete(replacedSessionKey);
				state.closedManagedSessionNames.add(replacedSessionKey);
			}
		}

		let electronLaunchRecord: ElectronLaunchRecord | undefined;
		let electronFailedConnectCleanup: ElectronCleanupResult | undefined = prepared.electronFailedConnectCleanup;
		let electronHandoff = prepared.electronHandoff;
		if (prepared.electronLaunch) {
			if (succeeded && prepared.executionPlan.sessionName) {
				const electronSessionName = prepared.executionPlan.sessionName;
				const electronSessionStateKey = sessionStateKey ?? electronSessionName;
				electronLaunchRecord = { ...prepared.electronLaunch.record, namespace: prepared.executionPlan.namespace, sessionName: electronSessionName };
				const electronHandoffMode = prepared.compiledElectron?.action === "launch" ? prepared.compiledElectron.handoff : "connect";
				try {
					electronHandoff = await collectElectronHandoff({ cwd, handoff: electronHandoffMode, namespace: prepared.executionPlan.namespace, sessionName: electronSessionName, signal });
				} catch (error) {
					electronHandoff = {
						error: error instanceof Error ? error.message : String(error),
						failureCategory: signal?.aborted ? "aborted" : "upstream-error",
						handoff: electronHandoffMode,
					};
				}
				if (electronHandoff.error) {
					succeeded = false;
					presentationEnvelope = { error: electronHandoff.error, success: false };
					const closeError = await closeManagedSession({ cwd, headedManagedAutosaveInterval: prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval, namespace: prepared.executionPlan.namespace, policyLock: prepared.managedSessionPolicyLock, preserveAttachedBrowserSession: input.preserveAttachedBrowserSession, restoreState: state.managedSessionRestoreState, sessionName: electronSessionName, timeoutMs: implicitSessionCloseTimeoutMs });
					electronFailedConnectCleanup = await cleanupElectronLaunchResources({ child: prepared.electronLaunch.child, record: electronLaunchRecord, timeoutMs: implicitSessionCloseTimeoutMs });
					electronLaunchRecord = electronFailedConnectCleanup.record;
					if (electronFailedConnectCleanup.partial) {
						electronLaunchRecords.set(electronLaunchRecord.launchId, electronLaunchRecord);
						electronChildProcesses.set(electronLaunchRecord.launchId, prepared.electronLaunch.child);
					} else {
						electronLaunchRecords.delete(electronLaunchRecord.launchId);
						electronChildProcesses.delete(electronLaunchRecord.launchId);
					}
					if (!closeError) {
						state.closedManagedSessionNames.add(electronSessionStateKey);
						networkRoutesBySession = new Map(networkRoutesBySession);
						networkRoutesBySession.delete(electronSessionStateKey);
						sessionPageState.clearSession(electronSessionStateKey);
						if (managedSessionName === electronSessionName && managedSessionNamespace === prepared.executionPlan.namespace) {
							managedSessionActive = false;
							freshSessionOrdinal += 1;
							managedSessionName = createFreshSessionName(state.managedSessionBaseName, state.ephemeralSessionSeed, freshSessionOrdinal);
							managedSessionNamespace = undefined;
						}
					}
					managedSessionOutcome = buildManagedSessionOutcome({ activeAfter: managedSessionActive, activeBefore: priorManagedSessionActive, attemptedSessionName: electronSessionName, command: prepared.executionPlan.commandInfo.command, currentSessionName: managedSessionName, currentSessionNamespace: managedSessionNamespace, previousSessionName: priorManagedSessionName, replacedSessionName: replacedManagedSessionName, replacedSessionNamespace: priorManagedSessionNamespace, sessionMode: prepared.sessionMode, succeeded: false });
				} else {
					electronLaunchRecords.set(electronLaunchRecord.launchId, electronLaunchRecord);
					electronChildProcesses.set(electronLaunchRecord.launchId, prepared.electronLaunch.child);
					if (electronHandoff.refSnapshot) {
						const refUpdate = sessionPageState.applyRefSnapshot({ sessionName: electronSessionStateKey, snapshot: electronHandoff.refSnapshot, update: sessionPageStateUpdate });
						currentRefSnapshot = refUpdate.refSnapshot;
						currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
						if (electronHandoff.refSnapshot.target) {
							const targetUpdate = sessionPageState.applyTabTarget({ sessionName: electronSessionStateKey, target: electronHandoff.refSnapshot.target, update: sessionPageStateUpdate });
							currentSessionTabTarget = targetUpdate.tabTarget;
						}
					}
				}
			} else {
				electronFailedConnectCleanup = await cleanupElectronLaunchResources({ child: prepared.electronLaunch.child, record: prepared.electronLaunch.record, timeoutMs: implicitSessionCloseTimeoutMs });
				electronLaunchRecord = electronFailedConnectCleanup.record;
			}
		}

		let errorText = getAgentBrowserErrorText({ aborted: processResult.aborted, command: prepared.executionPlan.commandInfo.command, effectiveArgs: prepared.redactedProcessArgs, envelope: presentationEnvelope, exitCode: processResult.exitCode, parseError, plainTextInspection, staleRefArgs: getStaleRefArgs(prepared.commandTokens, prepared.runtimeToolStdin), spawnError: processResult.spawnError, stderr: processResult.stderr, timedOut: processResult.timedOut, timeoutMs: processResult.timeoutMs, wrapperRecoveryHint: buildWrapperRecoveryHint({ pinnedBatchUnwrapMode: prepared.pinnedBatchUnwrapMode, sessionTabCorrection }) });
		if (errorText) {
			const clipboardWritePayloadCandidates = getClipboardWritePayloadCandidates(prepared.commandTokens);
			errorText = redactClipboardPermissionEcho(prepared.executionPlan.commandInfo, errorText);
			if (presentationEnvelope?.error !== undefined) presentationEnvelope = { ...presentationEnvelope, error: redactClipboardPermissionErrorValue(prepared.executionPlan.commandInfo, presentationEnvelope.error, clipboardWritePayloadCandidates) };
		}
		const presentation = plainTextInspection ? { artifacts: undefined, batchFailure: undefined, batchSteps: undefined, content: [{ type: "text" as const, text: inspectionText ?? "" }], data: undefined, fullOutputPath: undefined, fullOutputPaths: undefined, imagePath: undefined, imagePaths: undefined, savedFile: undefined, savedFilePath: undefined, summary: `${prepared.redactedArgs.join(" ")} completed` } : await buildToolPresentation({ args: prepared.redactedProcessArgs, artifactManifest, artifactMaxUpdatedAtMs: Date.now(), artifactMinUpdatedAtMs: input.artifactRunStartedAtMs, artifactRequest: screenshotArtifactRequest, batchArtifactRequests: batchScreenshotArtifactRequests, commandInfo: prepared.executionPlan.commandInfo, compiledSemanticAction: prepared.compiledSemanticAction, cwd, envelope: presentationEnvelope, errorText, namespace: prepared.executionPlan.namespace, networkRouteDiagnostics, networkRoutes: activeNetworkRoutes, persistentArtifactStore, sessionName: prepared.executionPlan.sessionName });
		if (electronHandoff?.error && electronHandoff.failureCategory) presentation.failureCategory = electronHandoff.failureCategory;
		networkRoutesBySession = applyBatchNetworkRouteState({ data: presentationEnvelope?.data, routesBySession: networkRoutesBySession, sessionName: sessionStateKey, succeeded });
		if (presentation.resultCategory === "failure" && succeeded) {
			succeeded = false;
			presentationEnvelope = { ...(presentationEnvelope ?? {}), error: presentation.summary, success: false };
		}
		if (scrollNoopDiagnostic) {
			succeeded = false;
			presentation.resultCategory = "failure";
			presentation.failureCategory = "upstream-error";
			presentationEnvelope = { ...(presentationEnvelope ?? {}), error: "Scroll completed with no observed movement.", success: false };
			presentation.summary = "Scroll completed with no observed movement.";
			if (isRecord(presentation.data)) presentation.data = { ...presentation.data, noMovement: true, scrolled: false };
			if (presentation.content[0]?.type === "text") {
				const details = isRecord(presentation.data) ? JSON.stringify(omitUpstreamLifecycle(presentation.data), null, 2) : presentation.content[0].text;
				presentation.content[0] = { ...presentation.content[0], text: `Scroll completed with no observed movement.\n\n${details}` };
			} else {
				presentation.content.unshift({ type: "text", text: "Scroll completed with no observed movement." });
			}
		}
		if (parseFailureOutput.artifactManifest) { presentation.artifactManifest = parseFailureOutput.artifactManifest; presentation.artifactRetentionSummary = parseFailureOutput.artifactRetentionSummary; }
		if (parseFailureOutput.fullOutputPath || parseFailureOutput.fullOutputUnavailable) {
			const existingText = presentation.content[0]?.type === "text" ? presentation.content[0].text : "";
			const noticeLines = [parseFailureOutput.fullOutputPath ? `Full output path: ${parseFailureOutput.fullOutputPath}` : `Full raw output unavailable: ${parseFailureOutput.fullOutputUnavailable}`, parseFailureOutput.artifactRetentionSummary].filter((item): item is string => item !== undefined);
			const notice = noticeLines.join("\n");
			presentation.content[0] = { type: "text", text: existingText.length > 0 ? `${existingText}\n\n${notice}` : notice };
		}
		if (presentation.artifactManifest) artifactManifest = presentation.artifactManifest;
		const qaPreset = prepared.compiledQaPreset
			? (processResult.timedOut ? analyzeQaPresetTimeout(prepared.compiledQaPreset) ?? analyzeQaPresetResults(presentationEnvelope?.data, prepared.compiledQaPreset) : analyzeQaPresetResults(presentationEnvelope?.data, prepared.compiledQaPreset))
			: undefined;
		let qaAttachedTarget = prepared.compiledQaPreset?.checks.attached
			? await collectQaAttachedTarget({ currentTarget: currentSessionTabTarget ?? prepared.priorSessionTabTarget, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal })
			: undefined;
		const sourceLookupElectronContext = prepared.compiledSourceLookup ? getSourceLookupElectronContext({ currentTarget: currentSessionTabTarget, electronLaunchRecords, namespace: prepared.executionPlan.namespace, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName }) : undefined;
		const sourceLookup = prepared.compiledSourceLookup ? await analyzeSourceLookupResults(presentationEnvelope?.data, prepared.compiledSourceLookup, cwd, { electronContext: sourceLookupElectronContext, workspaceRoot: cwd }) : undefined;
		const networkSourceLookup = prepared.compiledNetworkSourceLookup ? redactNetworkSourceLookupAnalysis(await analyzeNetworkSourceLookupResults(presentationEnvelope?.data, prepared.compiledNetworkSourceLookup, cwd)) : undefined;
		if (networkSourceLookup && presentation.content[0]?.type === "text") presentation.content[0] = { ...presentation.content[0], text: `${networkSourceLookup.summary}\n\n${presentation.content[0].text}` };
		else if (networkSourceLookup) presentation.content.unshift({ type: "text", text: networkSourceLookup.summary });
		if (sourceLookup && presentation.content[0]?.type === "text") presentation.content[0] = { ...presentation.content[0], text: `${sourceLookup.summary}\n\n${presentation.content[0].text}` };
		else if (sourceLookup) presentation.content.unshift({ type: "text", text: sourceLookup.summary });
		if (qaPreset && !qaPreset.passed && prepared.compiledQaPreset && presentation.failureCategory !== "artifact-missing") {
			succeeded = false;
			presentation.failureCategory = "qa-failure";
			presentation.summary = qaPreset.summary;
			const compactText = buildQaCompactFailureText({
				batchStepCount: presentation.batchSteps?.length ?? prepared.compiledQaPreset.steps.length,
				checks: prepared.compiledQaPreset.checks,
				page: extractQaPageContext({
					attachedTarget: qaAttachedTarget,
					batchData: presentationEnvelope?.data,
					compiled: prepared.compiledQaPreset,
				}),
				qaPreset,
			});
			const nonTextContent = presentation.content.filter((item) => item.type !== "text");
			presentation.content = [{ type: "text", text: compactText }, ...nonTextContent];
		} else if (qaPreset?.passed && prepared.compiledQaPreset && succeeded) {
			const compactText = buildQaCompactPassText({
				artifactVerification: presentation.artifactVerification,
				batchStepCount: presentation.batchSteps?.length ?? prepared.compiledQaPreset.steps.length,
				checks: prepared.compiledQaPreset.checks,
				page: extractQaPageContext({
					attachedTarget: qaAttachedTarget,
					batchData: presentationEnvelope?.data,
					compiled: prepared.compiledQaPreset,
				}),
				qaPreset,
			});
			presentation.summary = qaPreset.summary;
			const nonTextContent = presentation.content.filter((item) => item.type !== "text");
			presentation.content = [{ type: "text", text: compactText }, ...nonTextContent];
		}
		const qaAttachedTargetText = formatQaAttachedTargetText(qaAttachedTarget);
		const qaAttachedDiagnosticsText = prepared.compiledQaPreset?.checks.attached && prepared.compiledQaPreset.checks.diagnosticsResetAtStart === false && (prepared.compiledQaPreset.checks.checkNetwork || prepared.compiledQaPreset.checks.checkConsole || prepared.compiledQaPreset.checks.checkErrors)
			? "Attached diagnostics: existing upstream session console/network/error buffers were preserved; rows may include events from before qa.attached started."
			: undefined;
		const qaAttachedBannerText = [qaAttachedTargetText, qaAttachedDiagnosticsText].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
		const skipAttachedTargetBanner = qaPreset?.passed && prepared.compiledQaPreset?.checks.attached;
		if (!skipAttachedTargetBanner && qaAttachedBannerText && presentation.content[0]?.type === "text") presentation.content[0] = { ...presentation.content[0], text: `${qaAttachedBannerText}\n\n${presentation.content[0].text}` };
		else if (!skipAttachedTargetBanner && qaAttachedBannerText) presentation.content.unshift({ type: "text", text: qaAttachedBannerText });
		if (managedSessionOutcome && managedSessionOutcome.succeeded !== succeeded) managedSessionOutcome = { ...managedSessionOutcome, succeeded };
		const evalNavigationSummary = navigationSummary ?? extractNavigationSummaryFromData(presentationEnvelope?.data);
		const evalSessionTabUrl = sessionStateKey ? sessionPageState.get(sessionStateKey).tabTarget?.url : undefined;
		const evalPageUrl = evalNavigationSummary?.url ?? currentSessionTabTarget?.url ?? prepared.priorSessionTabTarget?.url ?? evalSessionTabUrl;
		const evalStdinHint = getEvalStdinHint({ command: prepared.executionPlan.commandInfo.command, data: presentationEnvelope?.data, stdin: prepared.runtimeToolStdin });
		const evalResultWarning = getEvalResultWarning({ command: prepared.executionPlan.commandInfo.command, data: presentationEnvelope?.data, navigationSummary: evalNavigationSummary, pageUrl: evalPageUrl, stdin: prepared.runtimeToolStdin });
		const resultArtifactManifest = presentation.artifactManifest ?? artifactManifest;
		const artifactCleanup = await getArtifactCleanupGuidance({ command: prepared.executionPlan.commandInfo.command, cwd, manifest: resultArtifactManifest, succeeded });
		const warningText = electronPostCommandHealth ? formatElectronPostCommandHealthText(electronPostCommandHealth) : electronSessionMismatch ? formatElectronSessionMismatchText(electronSessionMismatch) : aboutBlankSessionMismatch ? buildAboutBlankWarning(aboutBlankSessionMismatch) : undefined;
		const redactedContent = buildRedactedPresentationContent({ exactSensitiveValues: prepared.exactSensitiveValues, plainTextInspection, presentation, presentationEnvelope, succeeded, userRequestedJson: prepared.userRequestedJson, warningText });
		const finalRecoveryState = await prepareFinalResultRecoveryState({ aboutBlankSessionMismatch, batchRefSnapshotState, commandTokens: prepared.commandTokens, compiledSemanticAction: prepared.compiledSemanticAction, currentRefSnapshot, currentRefSnapshotInvalidation, currentSessionTabTarget, cwd, electronPostCommandHealth, errorText, executionPlan: prepared.executionPlan, parseError, plainTextInspection, presentation, processResult, redactedProcessArgs: prepared.redactedProcessArgs, runtimeToolArgs: prepared.runtimeToolArgs, sessionPageState, sessionPageStateUpdate, sessionTabCorrection, signal, succeeded });
		currentRefSnapshot = finalRecoveryState.currentRefSnapshot;
		currentRefSnapshotInvalidation = finalRecoveryState.currentRefSnapshotInvalidation;
		const authoritativePageState = sessionStateKey ? sessionPageState.get(sessionStateKey) : undefined;
		if (sessionStateKey) currentSessionTabTarget = authoritativePageState?.tabTarget;
		const currentSessionTabTargetUnknown = authoritativePageState?.tabTargetUnknown === true ? true : undefined;
		const resultRetainsPreparedManagedSession = !managedSessionOutcome || (
			managedSessionOutcome.activeAfter
			&& managedSessionOutcome.attemptedSessionName === managedSessionOutcome.currentSessionName
		);
		const resultHeadedManagedAutosaveDisabled = prepared.ownedManagedSessionContext?.headedManagedAutosaveDisabled === true
			&& resultRetainsPreparedManagedSession
			&& !(commandClosesSession && succeeded);
		const resultHeadedManagedAutosaveInterval = resultRetainsPreparedManagedSession && !(commandClosesSession && succeeded)
			? prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval
			: undefined;
		const result = buildFinalAgentBrowserToolResult({ aboutBlankSessionMismatch, artifactCleanup, categoryDetails: finalRecoveryState.categoryDetails, clickDispatchDiagnostic, commandTokens: prepared.commandTokens, comboboxFocusDiagnostic, compiledNetworkSourceLookup: prepared.compiledNetworkSourceLookup, compiledSemanticAction: prepared.compiledSemanticAction, compatibilityWorkaround: prepared.compatibilityWorkaround, currentRefSnapshot, currentRefSnapshotInvalidation, currentSessionTabTarget, currentSessionTabTargetUnknown, electronBroadGetTextScopeDiagnostics, electronFailedConnectCleanup, electronHandoff, electronLaunch: prepared.electronLaunch, electronLaunchRecord, electronLaunchRecords, electronPostCommandHealth, electronProfileIsolationDetails: input.electronProfileIsolationDetails, electronRefFreshnessDiagnostic, electronSessionMismatch, errorText, evalResultWarning, evalStdinHint, exactSensitiveValues: prepared.exactSensitiveValues, executionPlan: prepared.executionPlan, fillVerificationDiagnostic, inspectionText, managedSessionHeadedAutosaveDisabled: resultHeadedManagedAutosaveDisabled || undefined, managedSessionHeadedAutosaveInterval: resultHeadedManagedAutosaveInterval, managedSessionOutcome, managedSessionRestoreDisabled: state.managedSessionRestoreState.isDisabled(prepared.executionPlan.sessionName, prepared.executionPlan.namespace), navigationSummary, networkSourceLookup, noActivePageSnapshotFailure: finalRecoveryState.noActivePageSnapshotFailure, openResultTabCorrection, overlayBlockerDiagnostic, parseError, parseFailureOutput, parseSucceeded, plainTextInspection, presentation, presentationEnvelope, priorSessionTabTarget: prepared.priorSessionTabTarget, processResult, qaAttachedTarget, qaPreset, recordingDependencyWarning, redactedArgs: prepared.redactedArgs, redactedCompiledElectron: prepared.redactedCompiledElectron, redactedCompiledJob: prepared.redactedCompiledJob, redactedCompiledNetworkSourceLookup: prepared.redactedCompiledNetworkSourceLookup, redactedCompiledQaPreset: prepared.redactedCompiledQaPreset, redactedCompiledSemanticAction: prepared.redactedCompiledSemanticAction, redactedCompiledSourceLookup: prepared.redactedCompiledSourceLookup, redactedContent, redactedProcessArgs: prepared.redactedProcessArgs, redactedRecoveryHint: prepared.redactedRecoveryHint, resultArtifactManifest, richInputRecoveryDiagnostic: finalRecoveryState.richInputRecoveryDiagnostic, scrollNoopDiagnostic, selectorTextVisibilityDiagnostics, sessionMode: prepared.sessionMode, sessionTabCorrection, sourceLookup, succeeded, timeoutPartialProgress, unsettledWebMcpMutation, userRequestedJson: prepared.userRequestedJson, visibleRefFallbackDiagnostic: finalRecoveryState.visibleRefFallbackDiagnostic, visibleRefFallbackSessionName: finalRecoveryState.visibleRefFallbackSessionName });
		const resultWithCloseAll = closeAllApplied
			? { ...result, details: { ...(isRecord(result.details) ? result.details : {}), closeAllApplied: true } }
			: result;
		const statePatch: BrowserRunStatePatch = { artifactManifest, freshSessionOrdinal, managedSessionActive, managedSessionCompatibilityWorkaround, managedSessionHeadedAutosaveDisabled, managedSessionHeadedAutosaveInterval, managedSessionCwd, managedSessionName, managedSessionNamespace, networkRoutesBySession };
		return { result: resultWithCloseAll, statePatch };
	} finally {
		if (processResult.stdoutSpillPath) await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
	}
}
