import { readFile, rm } from "node:fs/promises";

import { isCloseCommand, isOpenNavigationCommand } from "../../command-taxonomy.js";
import { cleanupElectronLaunchResources, inspectElectronLaunchStatus, type ElectronCleanupResult } from "../../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import { getAllowedDomainsViolation, parseAllowedDomainsPolicyFromArgs } from "../../navigation-policy.js";
import {
	analyzeNetworkSourceLookupResults,
	analyzeQaPresetResults,
	analyzeSourceLookupResults,
	buildQaCompactPassText,
	extractQaPageContext,
	redactNetworkSourceLookupAnalysis,
} from "../../input-modes.js";
import {
	buildToolPresentation,
	getAgentBrowserErrorText,
	parseAgentBrowserEnvelope,
	type AgentBrowserEnvelope,
} from "../../results.js";
import {
	buildEvictedSessionArtifactEntries,
	formatSessionArtifactRetentionSummary,
	mergeSessionArtifactManifest,
} from "../../results/artifact-manifest.js";
import type { SessionArtifactManifest } from "../../results/contracts.js";
import { shouldCaptureSemanticActionNavigationSummary } from "../../results/presentation/semantic-action.js";
import {
	commandExplicitlyTargetsAboutBlank,
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
import type { PersistentSessionArtifactEviction, PersistentSessionArtifactStore } from "../../temp.js";
import { writePersistentSessionArtifactFile, writeSecureTempFile } from "../../temp.js";
import { isRecord } from "../../parsing.js";
import { createFreshSessionName, hasLaunchScopedTabCorrectionFlag, resolveManagedSessionState } from "../../runtime.js";
import {
	applyOpenResultTabCorrection,
	buildAboutBlankRecoveryHint,
	buildAboutBlankWarning,
	buildElectronPostCommandHealthDiagnostic,
	buildElectronRefFreshnessDiagnostic,
	buildElectronSessionMismatch,
	buildManagedSessionOutcome,
	closeManagedSession,
	collectOpenResultTabCorrection,
	collectSessionTabSelection,
	extractNavigationSummaryFromData,
	extractStringResultField,
	findElectronLaunchRecordForSession,
	formatElectronPostCommandHealthText,
	formatElectronSessionMismatchText,
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
	collectRecordingDependencyWarning,
	collectScrollPositionSnapshot,
	collectSelectorTextVisibilityDiagnostics,
	collectTimeoutPartialProgress,
	formatQaAttachedTargetText,
	getArtifactCleanupGuidance,
	getEvalResultWarning,
	getEvalStdinHint,
	getSourceLookupElectronContext,
	sleepMs,
} from "./diagnostics.js";
import { repairScreenshotData } from "./prepare.js";
import {
	buildFinalAgentBrowserToolResult,
	buildRedactedPresentationContent,
	buildWrapperRecoveryHint,
	prepareFinalResultRecoveryState,
	redactExactSensitiveText,
	redactExactSensitiveValue,
} from "./final-result.js";
import type {
	AboutBlankSessionMismatch,
	AgentBrowserToolResult,
	BrowserProcessOutputResult,
	BrowserRunContext,
	BrowserRunOptions,
	BrowserRunStatePatch,
	ParseFailureOutput,
	ProcessBrowserOutputInput,
	ScreenshotArtifactRequest,
	ScreenshotPathRequest,
} from "./types.js";

function getPersistentSessionArtifactStore(ctx: BrowserRunContext): PersistentSessionArtifactStore | undefined {
	const sessionDir = typeof ctx.sessionManager.getSessionDir === "function" ? ctx.sessionManager.getSessionDir() : undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	return sessionDir && sessionId ? { sessionDir, sessionId } : undefined;
}

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

export async function preserveParseFailureOutput(options: {
	artifactManifest?: SessionArtifactManifest;
	exactSensitiveValues?: string[];
	persistentArtifactStore?: PersistentSessionArtifactStore;
	stdoutSpillPath?: string;
}): Promise<ParseFailureOutput> {
	if (!options.stdoutSpillPath) return {};
	try {
		const rawOutput = redactExactSensitiveText(await readFile(options.stdoutSpillPath, "utf8"), options.exactSensitiveValues ?? []);
		const nowMs = Date.now();
		let evictedArtifacts: PersistentSessionArtifactEviction[] = [];
		let fullOutputPath: string;
		let storageScope: "persistent-session" | "process-temp";
		if (options.persistentArtifactStore) {
			const result = await writePersistentSessionArtifactFile({ content: rawOutput, prefix: "pi-agent-browser-parse-failure-output", store: options.persistentArtifactStore, suffix: ".txt" });
			fullOutputPath = result.path;
			evictedArtifacts = result.evictedArtifacts;
			storageScope = "persistent-session";
		} else {
			fullOutputPath = await writeSecureTempFile({ content: rawOutput, prefix: "pi-agent-browser-parse-failure-output", suffix: ".txt" });
			storageScope = "process-temp";
		}
		const artifactManifest = mergeSessionArtifactManifest({
			base: options.artifactManifest,
			entries: [{ command: "agent-browser", createdAtMs: nowMs, kind: "spill", path: fullOutputPath, retentionState: storageScope === "persistent-session" ? "live" : "ephemeral", storageScope }, ...buildEvictedSessionArtifactEntries(evictedArtifacts, nowMs)],
			nowMs,
		});
		return { artifactManifest, artifactRetentionSummary: artifactManifest ? formatSessionArtifactRetentionSummary(artifactManifest) : undefined, fullOutputPath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { fullOutputUnavailable: message };
	}
}

export async function processBrowserOutput(input: ProcessBrowserOutputInput): Promise<BrowserProcessOutputResult> {
	const { ctx, cwd, electronPostCommandStatusSettleMs, implicitSessionCloseTimeoutMs, sessionPageStateUpdate, signal, state } = input;
	const { prepared, processResult } = input;
	const { electronChildProcesses, electronLaunchRecords, sessionPageState, traceOwners } = state;
	let allowedDomainsBySession = state.allowedDomainsBySession;
	let artifactManifest = state.artifactManifest;
	let freshSessionOrdinal = state.freshSessionOrdinal;
	let managedSessionActive = state.managedSessionActive;
	let managedSessionCwd = state.managedSessionCwd;
	let managedSessionName = state.managedSessionName;
	try {
		const persistentArtifactStore = getPersistentSessionArtifactStore(ctx);
		const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath });
		let parseError = parsed.parseError;
		let presentationEnvelope = parsed.envelope;
		let navigationSummary = undefined as Awaited<ReturnType<typeof collectNavigationSummary>> | undefined;
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
		if (presentationEnvelope && prepared.exactSensitiveValues.length > 0) presentationEnvelope = redactExactSensitiveValue(presentationEnvelope, prepared.exactSensitiveValues) as AgentBrowserEnvelope;
		const parseFailureOutput = parseError ? await preserveParseFailureOutput({ artifactManifest, exactSensitiveValues: prepared.exactSensitiveValues, persistentArtifactStore, stdoutSpillPath: processResult.stdoutSpillPath }) : {};
		const processSucceeded = !processResult.aborted && !processResult.spawnError && processResult.exitCode === 0;
		const plainTextInspection = prepared.executionPlan.plainTextInspection && processSucceeded;
		const parseSucceeded = plainTextInspection || parseError === undefined;
		const envelopeSuccess = plainTextInspection ? true : presentationEnvelope?.success !== false;
		let succeeded = processSucceeded && parseSucceeded && envelopeSuccess;
		const inspectionText = plainTextInspection ? processResult.stdout.trim() : undefined;
		updateTraceOwnerState({ command: prepared.executionPlan.commandInfo.command, sessionName: prepared.executionPlan.sessionName, subcommand: prepared.executionPlan.commandInfo.subcommand, succeeded, traceOwners });

		let clickDispatchDiagnostic: Awaited<ReturnType<typeof collectClickDispatchDiagnostic>>;
		if (succeeded && prepared.clickDispatchProbe) {
			clickDispatchDiagnostic = await collectClickDispatchDiagnostic({ cwd, probe: prepared.clickDispatchProbe, sessionName: prepared.executionPlan.sessionName, signal });
			if (clickDispatchDiagnostic) {
				succeeded = false;
				presentationEnvelope = { ...(presentationEnvelope ?? {}), error: clickDispatchDiagnostic.summary, success: false };
			}
		}

		const parsedAllowedDomainsPolicy = parseAllowedDomainsPolicyFromArgs(prepared.runtimeToolArgs);
		const sessionAllowedDomainsPolicy = prepared.executionPlan.sessionName
			? parsedAllowedDomainsPolicy ?? allowedDomainsBySession.get(prepared.executionPlan.sessionName)
			: parsedAllowedDomainsPolicy;
		const shouldCaptureAllowedDomainNavigationSummary = prepared.executionPlan.commandInfo.command === "batch" && sessionAllowedDomainsPolicy !== undefined;
		if (
			succeeded &&
			!navigationSummary &&
			(shouldCaptureNavigationSummary(prepared.executionPlan.commandInfo.command, presentationEnvelope?.data) ||
				shouldCaptureSemanticActionNavigationSummary(prepared.compiledSemanticAction, presentationEnvelope?.data) ||
				shouldCaptureAllowedDomainNavigationSummary)
		) {
			navigationSummary = await collectNavigationSummary({ cwd, sessionName: prepared.executionPlan.sessionName, signal });
		}
		if (navigationSummary && presentationEnvelope && !Array.isArray(presentationEnvelope.data)) presentationEnvelope = { ...presentationEnvelope, data: mergeNavigationSummaryIntoData(presentationEnvelope.data, navigationSummary) };
		let overlayBlockerDiagnostic: Awaited<ReturnType<typeof collectOverlayBlockerDiagnostic>>;

		let openResultTabCorrection: Awaited<ReturnType<typeof collectOpenResultTabCorrection>>;
		if (succeeded && prepared.executionPlan.sessionName && hasLaunchScopedTabCorrectionFlag(prepared.runtimeToolArgs) && isOpenNavigationCommand(prepared.executionPlan.commandInfo.command)) {
			const targetTitle = extractStringResultField(presentationEnvelope?.data, "title");
			const targetUrl = extractStringResultField(presentationEnvelope?.data, "url");
			const plannedTabCorrection = await collectOpenResultTabCorrection({ cwd, sessionName: prepared.executionPlan.sessionName, signal, targetTitle, targetUrl });
			if (plannedTabCorrection) openResultTabCorrection = await applyOpenResultTabCorrection({ correction: plannedTabCorrection, cwd, sessionName: prepared.executionPlan.sessionName, signal });
		}

		const observedSessionTabTarget = normalizeSessionTabTarget(navigationSummary) ?? extractSessionTabTargetFromBatchResults(presentationEnvelope?.data) ?? extractSessionTabTargetFromCommandData(prepared.commandTokens, presentationEnvelope?.data);
		let currentSessionTabTarget = deriveSessionTabTarget({ command: prepared.executionPlan.commandInfo.command, data: presentationEnvelope?.data, navigationSummary, previousTarget: prepared.priorSessionTabTarget, subcommand: prepared.executionPlan.commandInfo.subcommand });
		let aboutBlankSessionMismatch: AboutBlankSessionMismatch | undefined;
		let electronPostCommandHealth: ReturnType<typeof buildElectronPostCommandHealthDiagnostic>;
		let electronRefFreshnessDiagnostic: ReturnType<typeof buildElectronRefFreshnessDiagnostic>;
		let electronSessionMismatch: ReturnType<typeof buildElectronSessionMismatch>;
		let electronStatusAfterCommand: Awaited<ReturnType<typeof inspectElectronLaunchStatus>> | undefined;
		const shouldTreatAboutBlankAsMismatch = succeeded && prepared.priorSessionTabTarget !== undefined && !isAboutBlankSessionTabTarget(prepared.priorSessionTabTarget) && isAboutBlankSessionTabTarget(observedSessionTabTarget ?? currentSessionTabTarget) && !commandExplicitlyTargetsAboutBlank(prepared.commandTokens);
		let sessionTabCorrection = prepared.sessionTabCorrection;
		if (shouldTreatAboutBlankAsMismatch && prepared.priorSessionTabTarget) {
			const aboutBlankObservedTarget = observedSessionTabTarget ?? currentSessionTabTarget;
			const aboutBlankRecovery = await collectSessionTabSelection({ cwd, sessionName: prepared.executionPlan.sessionName, signal, target: prepared.priorSessionTabTarget });
			const appliedAboutBlankRecovery = aboutBlankRecovery ? await applyOpenResultTabCorrection({ correction: aboutBlankRecovery, cwd, sessionName: prepared.executionPlan.sessionName, signal }) : undefined;
			if (appliedAboutBlankRecovery) { sessionTabCorrection = appliedAboutBlankRecovery; currentSessionTabTarget = prepared.priorSessionTabTarget; }
			else currentSessionTabTarget = aboutBlankObservedTarget ?? normalizeSessionTabTarget({ url: "about:blank" });
			aboutBlankSessionMismatch = { activeUrl: "about:blank", recoveryApplied: appliedAboutBlankRecovery !== undefined, recoveryHint: buildAboutBlankRecoveryHint(), targetTitle: prepared.priorSessionTabTarget.title, targetUrl: prepared.priorSessionTabTarget.url };
			const electronRecord = findElectronLaunchRecordForSession(prepared.executionPlan.sessionName, electronLaunchRecords);
			if (electronRecord && prepared.executionPlan.sessionName) {
				electronStatusAfterCommand = await inspectElectronLaunchStatus(electronRecord);
				electronSessionMismatch = buildElectronSessionMismatch({ managedSession: { sessionName: prepared.executionPlan.sessionName, title: aboutBlankObservedTarget?.title, url: aboutBlankObservedTarget?.url ?? "about:blank" }, record: electronRecord, statusTargets: electronStatusAfterCommand.targets });
			}
		}
		if (succeeded && prepared.priorSessionTabTarget && !sessionTabCorrection && !aboutBlankSessionMismatch && !commandExplicitlyTargetsAboutBlank(prepared.commandTokens) && observedSessionTabTarget && shouldCorrectSessionTabAfterCommand({ command: prepared.executionPlan.commandInfo.command, pinningRequired: prepared.sessionTabPinningReason !== undefined, sessionName: prepared.executionPlan.sessionName })) {
			const postCommandTabCorrection = await collectSessionTabSelection({ cwd, sessionName: prepared.executionPlan.sessionName, signal, target: observedSessionTabTarget });
			if (postCommandTabCorrection) {
				const appliedPostCommandCorrection = await applyOpenResultTabCorrection({ correction: postCommandTabCorrection, cwd, sessionName: prepared.executionPlan.sessionName, signal });
				if (appliedPostCommandCorrection && !sessionTabCorrection) sessionTabCorrection = appliedPostCommandCorrection;
			}
		}
		if (succeeded && prepared.executionPlan.sessionName && parsedAllowedDomainsPolicy) {
			allowedDomainsBySession = new Map(allowedDomainsBySession);
			allowedDomainsBySession.set(prepared.executionPlan.sessionName, parsedAllowedDomainsPolicy);
		}
		const allowedDomainsViolation = succeeded ? getAllowedDomainsViolation({
			policy: sessionAllowedDomainsPolicy,
			url: currentSessionTabTarget?.url ?? observedSessionTabTarget?.url ?? navigationSummary?.url,
		}) : undefined;
		if (allowedDomainsViolation) {
			succeeded = false;
			presentationEnvelope = { ...(presentationEnvelope ?? {}), error: allowedDomainsViolation.summary, success: false };
		}

		const electronRecordForCommand = findElectronLaunchRecordForSession(prepared.executionPlan.sessionName, electronLaunchRecords);
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
		const timeoutPartialProgress = processResult.timedOut ? await collectTimeoutPartialProgress({ command: prepared.executionPlan.commandInfo.command, compiledJob: prepared.compiledJob, cwd, sessionName: prepared.executionPlan.sessionName, stdin: prepared.runtimeToolStdin }) : undefined;
		if (succeeded && electronRecordForCommand) {
			fillVerificationDiagnostic = await collectFillVerificationDiagnostic({ commandTokens: prepared.commandTokens, cwd, sessionName: prepared.executionPlan.sessionName, signal });
			electronRefFreshnessDiagnostic = buildElectronRefFreshnessDiagnostic({ command: prepared.executionPlan.commandInfo.command, commandTokens: prepared.commandTokens, record: electronRecordForCommand, sessionName: prepared.executionPlan.sessionName, stdin: prepared.runtimeToolStdin });
		}
		if (succeeded && !sessionTabCorrection && !aboutBlankSessionMismatch && !electronRecordForCommand && !clickDispatchDiagnostic) overlayBlockerDiagnostic = await collectOverlayBlockerDiagnostic({ command: prepared.executionPlan.commandInfo.command, cwd, data: presentationEnvelope?.data, navigationSummary, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName, signal });
		if (succeeded) {
			selectorTextVisibilityDiagnostics = await collectSelectorTextVisibilityDiagnostics({ commandInfo: prepared.executionPlan.commandInfo, commandTokens: prepared.commandTokens, cwd, data: presentationEnvelope?.data, sessionName: prepared.executionPlan.sessionName, signal });
			electronBroadGetTextScopeDiagnostics = collectElectronBroadGetTextScopeDiagnostics({ commandInfo: prepared.executionPlan.commandInfo, commandTokens: prepared.commandTokens, currentTarget: currentSessionTabTarget, data: presentationEnvelope?.data, electronLaunchRecords, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName });
		}
		const comboboxFocusDiagnostic = succeeded ? await collectComboboxFocusDiagnostic({ command: prepared.executionPlan.commandInfo.command, commandTokens: prepared.commandTokens, cwd, semanticAction: prepared.compiledSemanticAction, sessionName: prepared.executionPlan.sessionName, signal }) : undefined;
		const recordingDependencyWarning = await collectRecordingDependencyWarning({ command: prepared.executionPlan.commandInfo.command, commandTokens: prepared.commandTokens, succeeded });
		const scrollNoopDiagnostic = succeeded && prepared.shouldProbeScrollNoop ? buildScrollNoopDiagnostic(prepared.scrollPositionBefore, await collectScrollPositionSnapshot({ cwd, sessionName: prepared.executionPlan.sessionName, signal })) : undefined;
		let currentRefSnapshot: SessionRefSnapshot | undefined;
		let currentRefSnapshotInvalidation: SessionRefSnapshotInvalidation | undefined;
		const batchRefSnapshotState = prepared.executionPlan.commandInfo.command === "batch" ? extractLatestRefSnapshotStateFromBatchResults(presentationEnvelope?.data) : undefined;
		if (prepared.executionPlan.sessionName) {
			if (isCloseCommand(prepared.executionPlan.commandInfo.command) && succeeded) {
				allowedDomainsBySession = new Map(allowedDomainsBySession);
				allowedDomainsBySession.delete(prepared.executionPlan.sessionName);
				sessionPageState.clearSession(prepared.executionPlan.sessionName);
				state.closedManagedSessionNames.add(prepared.executionPlan.sessionName);
			} else if (currentSessionTabTarget) {
				const tabUpdate = sessionPageState.applyTabTarget({ sessionName: prepared.executionPlan.sessionName, target: currentSessionTabTarget, update: sessionPageStateUpdate });
				if (!tabUpdate.applied && succeeded) sessionPageState.markPinning(prepared.executionPlan.sessionName, "drift");
			}
			const refSnapshot = prepared.executionPlan.commandInfo.command === "batch" ? batchRefSnapshotState?.snapshot : succeeded ? prepared.executionPlan.commandInfo.command === "snapshot" ? extractRefSnapshotFromData(presentationEnvelope?.data) : prepared.resolvedSemanticActionRefSnapshot ?? overlayBlockerDiagnostic?.snapshot : undefined;
			if (refSnapshot) {
				const refUpdate = sessionPageState.applyRefSnapshot({ fallbackTarget: currentSessionTabTarget, sessionName: prepared.executionPlan.sessionName, snapshot: refSnapshot, update: sessionPageStateUpdate });
				currentRefSnapshot = refUpdate.refSnapshot;
				currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
			} else {
				const stateView = sessionPageState.get(prepared.executionPlan.sessionName);
				currentRefSnapshot = stateView.refSnapshot;
				currentRefSnapshotInvalidation = stateView.refSnapshotInvalidation;
			}
		}

		const priorManagedSessionActive = managedSessionActive;
		const priorManagedSessionCwd = managedSessionCwd;
		const priorManagedSessionName = managedSessionName;
		const commandClosesSession = isCloseCommand(prepared.executionPlan.commandInfo.command);
		const managedCloseSessionName = commandClosesSession && succeeded && prepared.executionPlan.sessionName === priorManagedSessionName
			? prepared.executionPlan.sessionName
			: prepared.executionPlan.managedSessionName;
		const policyBlockedFreshManagedSession = allowedDomainsViolation !== undefined && prepared.sessionMode === "fresh" && prepared.executionPlan.managedSessionName === prepared.executionPlan.sessionName;
		const managedTransitionSucceeded = succeeded || policyBlockedFreshManagedSession;
		const managedSessionState = resolveManagedSessionState({ command: prepared.executionPlan.commandInfo.command, managedSessionName: managedCloseSessionName, priorActive: priorManagedSessionActive, priorSessionName: priorManagedSessionName, succeeded: managedTransitionSucceeded });
		const replacedManagedSessionName = managedSessionState.replacedSessionName;
		managedSessionActive = managedSessionState.active;
		managedSessionName = managedSessionState.sessionName;
		if (commandClosesSession && succeeded && managedCloseSessionName === priorManagedSessionName && !managedSessionActive) {
			freshSessionOrdinal += 1;
			managedSessionName = createFreshSessionName(state.managedSessionBaseName, state.ephemeralSessionSeed, freshSessionOrdinal);
		}
		let managedSessionOutcome = buildManagedSessionOutcome({ activeAfter: managedSessionActive, activeBefore: priorManagedSessionActive, attemptedSessionName: managedCloseSessionName, command: prepared.executionPlan.commandInfo.command, currentSessionName: managedSessionName, previousSessionName: priorManagedSessionName, replacedSessionName: replacedManagedSessionName, sessionMode: prepared.sessionMode, succeeded: managedTransitionSucceeded });
		if (prepared.executionPlan.managedSessionName && succeeded) managedSessionCwd = cwd;
		if (prepared.executionPlan.sessionName && succeeded) {
			if (openResultTabCorrection || sessionTabCorrection || aboutBlankSessionMismatch?.recoveryApplied) sessionPageState.markPinning(prepared.executionPlan.sessionName, "drift");
			else if (prepared.sessionTabPinningReason === "restore") sessionPageState.clearRestorePinning(prepared.executionPlan.sessionName);
		}
		if (replacedManagedSessionName) {
			allowedDomainsBySession = new Map(allowedDomainsBySession);
			allowedDomainsBySession.delete(replacedManagedSessionName);
			sessionPageState.clearSession(replacedManagedSessionName);
			const replacedCloseError = await closeManagedSession({ cwd: priorManagedSessionCwd, sessionName: replacedManagedSessionName, timeoutMs: implicitSessionCloseTimeoutMs });
			if (!replacedCloseError) state.closedManagedSessionNames.add(replacedManagedSessionName);
		}

		let electronLaunchRecord: ElectronLaunchRecord | undefined;
		let electronFailedConnectCleanup: ElectronCleanupResult | undefined = prepared.electronFailedConnectCleanup;
		let electronHandoff = prepared.electronHandoff;
		if (prepared.electronLaunch) {
			if (succeeded && prepared.executionPlan.sessionName) {
				electronLaunchRecord = { ...prepared.electronLaunch.record, sessionName: prepared.executionPlan.sessionName };
				electronLaunchRecords.set(electronLaunchRecord.launchId, electronLaunchRecord);
				electronChildProcesses.set(electronLaunchRecord.launchId, prepared.electronLaunch.child);
				const electronHandoffMode = prepared.compiledElectron?.action === "launch" ? prepared.compiledElectron.handoff : "connect";
				try { electronHandoff = await collectElectronHandoff({ cwd, handoff: electronHandoffMode, sessionName: prepared.executionPlan.sessionName, signal }); }
				catch (error) { electronHandoff = { error: error instanceof Error ? error.message : String(error), handoff: electronHandoffMode }; }
				if (electronHandoff?.refSnapshot) {
					const refUpdate = sessionPageState.applyRefSnapshot({ sessionName: prepared.executionPlan.sessionName, snapshot: electronHandoff.refSnapshot, update: sessionPageStateUpdate });
					currentRefSnapshot = refUpdate.refSnapshot;
					currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
					if (electronHandoff.refSnapshot.target) {
						currentSessionTabTarget = electronHandoff.refSnapshot.target;
						sessionPageState.applyTabTarget({ sessionName: prepared.executionPlan.sessionName, target: electronHandoff.refSnapshot.target, update: sessionPageStateUpdate });
					}
				}
			} else {
				electronFailedConnectCleanup = await cleanupElectronLaunchResources({ child: prepared.electronLaunch.child, record: prepared.electronLaunch.record, timeoutMs: implicitSessionCloseTimeoutMs });
				electronLaunchRecord = electronFailedConnectCleanup.record;
			}
		}

		const errorText = getAgentBrowserErrorText({ aborted: processResult.aborted, command: prepared.executionPlan.commandInfo.command, effectiveArgs: prepared.redactedProcessArgs, envelope: presentationEnvelope, exitCode: processResult.exitCode, parseError, plainTextInspection, staleRefArgs: getStaleRefArgs(prepared.commandTokens, prepared.runtimeToolStdin), spawnError: processResult.spawnError, stderr: processResult.stderr, timedOut: processResult.timedOut, timeoutMs: processResult.timeoutMs, wrapperRecoveryHint: buildWrapperRecoveryHint({ pinnedBatchUnwrapMode: prepared.pinnedBatchUnwrapMode, sessionTabCorrection }) });
		const presentation = plainTextInspection ? { artifacts: undefined, batchFailure: undefined, batchSteps: undefined, content: [{ type: "text" as const, text: inspectionText ?? "" }], data: undefined, fullOutputPath: undefined, fullOutputPaths: undefined, imagePath: undefined, imagePaths: undefined, savedFile: undefined, savedFilePath: undefined, summary: `${prepared.redactedArgs.join(" ")} completed` } : await buildToolPresentation({ args: prepared.redactedProcessArgs, artifactManifest, artifactRequest: screenshotArtifactRequest, batchArtifactRequests: batchScreenshotArtifactRequests, commandInfo: prepared.executionPlan.commandInfo, compiledSemanticAction: prepared.compiledSemanticAction, cwd, envelope: presentationEnvelope, errorText, persistentArtifactStore, sessionName: prepared.executionPlan.sessionName });
		if (presentation.failureCategory === "artifact-missing") {
			succeeded = false;
			presentationEnvelope = { ...(presentationEnvelope ?? {}), error: presentation.summary, success: false };
		}
		if (parseFailureOutput.artifactManifest) { presentation.artifactManifest = parseFailureOutput.artifactManifest; presentation.artifactRetentionSummary = parseFailureOutput.artifactRetentionSummary; }
		if (parseFailureOutput.fullOutputPath || parseFailureOutput.fullOutputUnavailable) {
			const existingText = presentation.content[0]?.type === "text" ? presentation.content[0].text : "";
			const noticeLines = [parseFailureOutput.fullOutputPath ? `Full output path: ${parseFailureOutput.fullOutputPath}` : `Full raw output unavailable: ${parseFailureOutput.fullOutputUnavailable}`, parseFailureOutput.artifactRetentionSummary].filter((item): item is string => item !== undefined);
			const notice = noticeLines.join("\n");
			presentation.content[0] = { type: "text", text: existingText.length > 0 ? `${existingText}\n\n${notice}` : notice };
		}
		if (presentation.artifactManifest) artifactManifest = presentation.artifactManifest;
		const qaPreset = prepared.compiledQaPreset ? analyzeQaPresetResults(presentationEnvelope?.data) : undefined;
		let qaAttachedTarget = prepared.compiledQaPreset?.checks.attached
			? await collectQaAttachedTarget({ currentTarget: currentSessionTabTarget ?? prepared.priorSessionTabTarget, cwd, sessionName: prepared.executionPlan.sessionName, signal })
			: undefined;
		const sourceLookupElectronContext = prepared.compiledSourceLookup ? getSourceLookupElectronContext({ currentTarget: currentSessionTabTarget, electronLaunchRecords, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName }) : undefined;
		const sourceLookup = prepared.compiledSourceLookup ? await analyzeSourceLookupResults(presentationEnvelope?.data, prepared.compiledSourceLookup, cwd, { electronContext: sourceLookupElectronContext, workspaceRoot: cwd }) : undefined;
		const networkSourceLookup = prepared.compiledNetworkSourceLookup ? redactNetworkSourceLookupAnalysis(await analyzeNetworkSourceLookupResults(presentationEnvelope?.data, prepared.compiledNetworkSourceLookup, cwd)) : undefined;
		if (networkSourceLookup && presentation.content[0]?.type === "text") presentation.content[0] = { ...presentation.content[0], text: `${networkSourceLookup.summary}\n\n${presentation.content[0].text}` };
		else if (networkSourceLookup) presentation.content.unshift({ type: "text", text: networkSourceLookup.summary });
		if (sourceLookup && presentation.content[0]?.type === "text") presentation.content[0] = { ...presentation.content[0], text: `${sourceLookup.summary}\n\n${presentation.content[0].text}` };
		else if (sourceLookup) presentation.content.unshift({ type: "text", text: sourceLookup.summary });
		if (qaPreset && !qaPreset.passed) {
			succeeded = false;
			presentation.failureCategory = "qa-failure";
			presentation.summary = qaPreset.summary;
			if (presentation.content[0]?.type === "text") presentation.content[0] = { ...presentation.content[0], text: `${qaPreset.summary}\n\n${presentation.content[0].text}` };
			else presentation.content.unshift({ type: "text", text: qaPreset.summary });
		} else if (qaPreset?.passed && prepared.compiledQaPreset) {
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
		const skipAttachedTargetBanner = qaPreset?.passed && prepared.compiledQaPreset?.checks.attached;
		if (!skipAttachedTargetBanner && qaAttachedTargetText && presentation.content[0]?.type === "text") presentation.content[0] = { ...presentation.content[0], text: `${qaAttachedTargetText}\n\n${presentation.content[0].text}` };
		else if (!skipAttachedTargetBanner && qaAttachedTargetText) presentation.content.unshift({ type: "text", text: qaAttachedTargetText });
		if (managedSessionOutcome && managedSessionOutcome.succeeded !== succeeded) managedSessionOutcome = { ...managedSessionOutcome, succeeded };
		const evalNavigationSummary = navigationSummary ?? extractNavigationSummaryFromData(presentationEnvelope?.data);
		const evalSessionTabUrl = prepared.executionPlan.sessionName ? sessionPageState.get(prepared.executionPlan.sessionName).tabTarget?.url : undefined;
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
		const result = buildFinalAgentBrowserToolResult({ aboutBlankSessionMismatch, artifactCleanup, categoryDetails: finalRecoveryState.categoryDetails, clickDispatchDiagnostic, commandTokens: prepared.commandTokens, comboboxFocusDiagnostic, compiledNetworkSourceLookup: prepared.compiledNetworkSourceLookup, compiledSemanticAction: prepared.compiledSemanticAction, compatibilityWorkaround: prepared.compatibilityWorkaround, currentRefSnapshot, currentRefSnapshotInvalidation, currentSessionTabTarget, electronBroadGetTextScopeDiagnostics, electronFailedConnectCleanup, electronHandoff, electronLaunch: prepared.electronLaunch, electronLaunchRecord, electronLaunchRecords, electronPostCommandHealth, electronProfileIsolationDetails: input.electronProfileIsolationDetails, electronRefFreshnessDiagnostic, electronSessionMismatch, errorText, evalResultWarning, evalStdinHint, exactSensitiveValues: prepared.exactSensitiveValues, executionPlan: prepared.executionPlan, fillVerificationDiagnostic, inspectionText, managedSessionOutcome, navigationSummary, networkSourceLookup, noActivePageSnapshotFailure: finalRecoveryState.noActivePageSnapshotFailure, openResultTabCorrection, overlayBlockerDiagnostic, parseError, parseFailureOutput, parseSucceeded, plainTextInspection, presentation, presentationEnvelope, priorSessionTabTarget: prepared.priorSessionTabTarget, processResult, qaAttachedTarget, qaPreset, recordingDependencyWarning, redactedArgs: prepared.redactedArgs, redactedCompiledElectron: prepared.redactedCompiledElectron, redactedCompiledJob: prepared.redactedCompiledJob, redactedCompiledNetworkSourceLookup: prepared.redactedCompiledNetworkSourceLookup, redactedCompiledQaPreset: prepared.redactedCompiledQaPreset, redactedCompiledSemanticAction: prepared.redactedCompiledSemanticAction, redactedCompiledSourceLookup: prepared.redactedCompiledSourceLookup, redactedContent, redactedProcessArgs: prepared.redactedProcessArgs, redactedRecoveryHint: prepared.redactedRecoveryHint, resultArtifactManifest, richInputRecoveryDiagnostic: finalRecoveryState.richInputRecoveryDiagnostic, scrollNoopDiagnostic, selectorTextVisibilityDiagnostics, sessionMode: prepared.sessionMode, sessionTabCorrection, sourceLookup, succeeded, timeoutPartialProgress, userRequestedJson: prepared.userRequestedJson, visibleRefFallbackDiagnostic: finalRecoveryState.visibleRefFallbackDiagnostic, visibleRefFallbackSessionName: finalRecoveryState.visibleRefFallbackSessionName });
		const statePatch: BrowserRunStatePatch = { allowedDomainsBySession, artifactManifest, freshSessionOrdinal, managedSessionActive, managedSessionCwd, managedSessionName };
		return { result, statePatch };
	} finally {
		if (processResult.stdoutSpillPath) await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
	}
}
