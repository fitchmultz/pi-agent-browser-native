import { cleanupElectronLaunchResources, type ElectronCleanupResult } from "../../electron/cleanup.js";
import type { ElectronCdpTarget, ElectronLaunchFailure, ElectronLaunchRecord } from "../../electron/launch.js";
import {
	getCompiledSemanticActionCommandIndex,
	getCompiledSemanticActionSessionPrefix,
	isCompiledSemanticActionFindCommand,
	redactNetworkSourceLookupSurface,
	type CompiledAgentBrowserElectron,
	type CompiledAgentBrowserSemanticAction,
} from "../../input-modes.js";
import {
	buildAgentBrowserNextActions,
	buildAgentBrowserResultCategoryDetails,
	type AgentBrowserEnvelope,
	type AgentBrowserNextAction,
} from "../../results.js";
import { formatSessionArtifactRetentionSummary } from "../../results/artifact-manifest.js";
import {
	AgentBrowserNextActionCollector,
	alignPageChangeSummaryNextActionIds,
	isStandaloneSnapshotNextAction,
} from "../../results/next-actions.js";
import {
	buildConnectedSessionNextActions,
	buildNoActivePageNextActions,
	buildSessionAwareStaleRefNextActions,
	buildSessionTabRecoveryNextActions,
} from "../../results/recovery-next-actions.js";
import {
	buildRichInputRecoveryDiagnostic,
	buildRichInputRecoveryNextActions,
	buildVisibleRefFallbackNextActions,
	formatRichInputRecoveryText,
	formatVisibleRefFallbackText,
	sanitizeVisibleRefFallbackDiagnostic,
} from "../../results/selector-recovery.js";
import {
	buildNoActivePageRefSnapshotInvalidation,
	isNoActivePageSnapshotFailure,
	type SessionPageState,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
} from "../../session-page-state.js";
import { extractExplicitSessionName, redactInvocationArgs, redactSensitiveText, redactSensitiveValue, type OpenResultTabCorrection } from "../../runtime.js";
import { isRecord } from "../../parsing.js";
import { buildClickDispatchNextActions, formatClickDispatchDiagnosticText } from "./click-dispatch.js";
import {
	buildComboboxFocusNextActions,
	buildElectronBroadGetTextScopeNextActions,
	buildFillVerificationNextActions,
	buildOverlayBlockerNextActions,
	buildScrollNoopNextActions,
	buildSelectorTextVisibilityNextActions,
	buildSourceLookupElectronNextActions,
	collectVisibleRefFallbackDiagnostic,
	formatArtifactCleanupGuidanceText,
	formatComboboxFocusDiagnosticText,
	formatElectronBroadGetTextScopeText,
	formatEvalResultWarningText,
	formatEvalStdinHintText,
	formatFillVerificationText,
	formatOverlayBlockerText,
	formatRecordingDependencyWarningText,
	formatScrollNoopDiagnosticText,
	formatSelectorTextVisibilityText,
	formatTimeoutPartialProgressText,
} from "./diagnostics.js";
import {
	buildElectronIdentifiers,
	buildElectronLifecycleNextActions,
	buildElectronMismatchNextActions,
	buildElectronRefFreshnessNextActions,
	buildManagedSessionFreshFailureNextActions,
	buildManagedSessionOutcome,
	buildSessionDetailFields,
	formatElectronPostCommandHealthText,
	formatElectronRefFreshnessText,
	formatElectronSessionMismatchText,
	formatManagedSessionOutcomeText,
} from "./session-state.js";
import type {
	AboutBlankSessionMismatch,
	AgentBrowserExecutionPlan,
	AgentBrowserResultCategoryDetails,
	AgentBrowserToolPresentation,
	AgentBrowserToolResult,
	ArtifactCleanupGuidance,
	FinalRecoveryState,
	FinalResultInput,
	ManagedSessionOutcome,
	PinnedBatchUnwrapMode,
} from "./types.js";

export function buildMissingBinaryMessage(): string {
	return [
		"agent-browser is required but was not found on PATH.",
		"This project does not bundle agent-browser.",
		"Run `pi-agent-browser-doctor` for package/PATH diagnostics, then install agent-browser using the upstream docs:",
		"- https://agent-browser.dev/",
		"- https://github.com/vercel-labs/agent-browser",
	].join("\n");
}

const SEMANTIC_ACTION_CANDIDATE_ACTION_IDS = new Set(["try-button-name-candidate", "try-link-name-candidate"]);

export function formatSemanticActionCandidateText(actions: AgentBrowserNextAction[]): string | undefined {
	const candidateActions = actions.filter((action) => SEMANTIC_ACTION_CANDIDATE_ACTION_IDS.has(action.id) && action.params?.args);
	if (candidateActions.length === 0) return undefined;
	return ["Agent-browser candidate fallbacks:", ...candidateActions.map((action) => `- ${action.id}: agent_browser ${JSON.stringify({ args: action.params?.args })} — ${action.reason}`)].join("\n");
}

export function buildSemanticActionCandidateActions(compiled: CompiledAgentBrowserSemanticAction): AgentBrowserNextAction[] {
	const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
	if (commandIndex < 0 || compiled.args[commandIndex] !== "find") return [];
	const locator = compiled.args[commandIndex + 1];
	const value = compiled.args[commandIndex + 2];
	if (!locator || !value) return [];
	const sessionPrefix = getCompiledSemanticActionSessionPrefix(compiled);
	const buildRoleCandidate = (role: string, id: string, reason: string): AgentBrowserNextAction => {
		const args = [...sessionPrefix, "find", "role", role, compiled.action];
		args.push("--name", value);
		return { id, params: { args: redactInvocationArgs(args) }, reason, safety: "Candidate locator fallback only; inspect the page if multiple elements could match the same accessible name.", tool: "agent_browser" as const };
	};
	if (locator === "text" && compiled.action === "click") {
		return [
			buildRoleCandidate("button", "try-button-name-candidate", "Retry against a button with the same accessible name when text lookup misses."),
			buildRoleCandidate("link", "try-link-name-candidate", "Retry against a link with the same accessible name when text lookup misses."),
		];
	}
	return [];
}

export function buildWrapperRecoveryHint(options: { pinnedBatchUnwrapMode?: PinnedBatchUnwrapMode; sessionTabCorrection?: OpenResultTabCorrection }): string | undefined {
	const wrapperManagedContexts = [options.sessionTabCorrection ? "session tab correction" : undefined, options.pinnedBatchUnwrapMode ? "pinned batch routing" : undefined].filter((item): item is string => item !== undefined);
	if (wrapperManagedContexts.length === 0) return undefined;
	return `Wrapper recovery hint: this call used ${wrapperManagedContexts.join(" and ")}. Inspect details.effectiveArgs and details.sessionTabCorrection; if the selected tab looks wrong, run tab list for the same session before retrying.`;
}

export function redactExactSensitiveText(text: string, sensitiveValues: string[]): string {
	let redacted = text;
	for (const value of sensitiveValues) redacted = redacted.split(value).join("[REDACTED]");
	return redacted;
}

export function redactExactSensitiveValue(value: unknown, sensitiveValues: string[]): unknown {
	if (sensitiveValues.length === 0) return value;
	if (typeof value === "string") return redactExactSensitiveText(value, sensitiveValues);
	if (Array.isArray(value)) return value.map((item) => redactExactSensitiveValue(item, sensitiveValues));
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, redactExactSensitiveValue(entryValue, sensitiveValues)]));
}

export function redactToolDetails(details: Record<string, unknown>, sensitiveValues: string[]): Record<string, unknown> {
	return redactSensitiveValue(redactExactSensitiveValue(details, sensitiveValues)) as Record<string, unknown>;
}

export function redactRecoveryHint(recoveryHint: AgentBrowserExecutionPlan["recoveryHint"] | undefined): AgentBrowserExecutionPlan["recoveryHint"] | undefined {
	if (!recoveryHint) return undefined;
	const exampleArgs = redactInvocationArgs(recoveryHint.exampleArgs);
	return { ...recoveryHint, exampleArgs, exampleParams: { ...recoveryHint.exampleParams, args: exampleArgs } };
}

export function buildJsonVisibleContent(options: {
	error: unknown;
	presentation: AgentBrowserToolPresentation;
	succeeded: boolean;
	warnings?: string[];
}): AgentBrowserToolResult["content"] {
	const { error, presentation, succeeded, warnings } = options;
	const payload = redactSensitiveValue({ artifacts: presentation.artifacts, data: presentation.data, error, success: succeeded, warnings: warnings && warnings.length > 0 ? warnings : undefined });
	if (isRecord(payload) && isRecord(payload.data) && isRecord(presentation.data) && typeof presentation.data.wsUrl === "string") payload.data.wsUrl = presentation.data.wsUrl;
	const images = presentation.content.filter((item): item is { data: string; mimeType: string; type: "image" } => item.type === "image");
	return [{ type: "text", text: JSON.stringify(payload, null, 2) }, ...images];
}

export function getElectronLaunchFailureCategory(failure: ElectronLaunchFailure): "policy-blocked" | "timeout" | "upstream-error" | "validation-error" {
	if (failure.reason === "policy-blocked") return "policy-blocked";
	if (failure.reason === "timeout") return "timeout";
	if (failure.reason === "non-electron-target") return "validation-error";
	return "upstream-error";
}

function formatElectronLaunchFailureDiagnostics(failure: ElectronLaunchFailure | undefined): string | undefined {
	const diagnostics = failure?.diagnostics;
	if (!diagnostics) return undefined;
	const lines = ["Electron launch diagnostics:"];
	if (diagnostics.pid !== undefined) lines.push(`- PID: ${diagnostics.pid} (${diagnostics.pidAlive === undefined ? "state unknown" : diagnostics.pidAlive ? "alive before cleanup" : "not alive before cleanup"}).`);
	if (diagnostics.exitCode !== undefined || diagnostics.exitSignal !== undefined) {
		const exitParts = [diagnostics.exitCode !== undefined ? `code ${diagnostics.exitCode}` : undefined, diagnostics.exitSignal ? `signal ${diagnostics.exitSignal}` : undefined].filter(Boolean).join(", ");
		lines.push(`- Process exit: ${exitParts || "not observed before cleanup"}.`);
	}
	if (diagnostics.userDataDir) lines.push(`- Wrapper profile: ${diagnostics.userDataDir}`);
	if (diagnostics.devToolsActivePort) {
		const activePort = diagnostics.devToolsActivePort;
		const state = activePort.port ? `found port ${activePort.port}` : activePort.found ? `found but invalid${activePort.error ? ` (${activePort.error})` : ""}` : `missing${activePort.error ? ` (${activePort.error})` : ""}`;
		lines.push(`- DevToolsActivePort: ${state} at ${activePort.path}.`);
	}
	if (diagnostics.cdpVersionReached === false) lines.push("- CDP /json/version: did not return a valid payload before timeout.");
	if (diagnostics.timeoutMs !== undefined || diagnostics.elapsedMs !== undefined) lines.push(`- Timing: ${diagnostics.elapsedMs ?? "unknown"}ms elapsed${diagnostics.timeoutMs !== undefined ? ` of ${diagnostics.timeoutMs}ms timeout` : ""}.`);
	if (diagnostics.outputCaptured === false) lines.push("- App stdout/stderr: not captured by this wrapper launch path.");
	lines.push("Retry guidance: increase electron.timeoutMs, try targetType:'any', pass an explicit appPath/executablePath, quit any already-running singleton instance, then retry launch.");
	return lines.join("\n");
}

export function buildElectronHostFailureResult(options: {
	compiledElectron: CompiledAgentBrowserElectron;
	errorText: string;
	failureCategory?: "cleanup-failed" | "policy-blocked" | "timeout" | "upstream-error" | "validation-error";
	launchFailure?: ElectronLaunchFailure;
	managedSessionOutcome?: ManagedSessionOutcome;
	status?: string;
}): AgentBrowserToolResult {
	const text = [options.errorText, formatElectronLaunchFailureDiagnostics(options.launchFailure), options.launchFailure?.cleanupError ? `Electron launch cleanup warning: ${options.launchFailure.cleanupError}` : undefined].filter((item): item is string => item !== undefined && item.length > 0).join("\n");
	const details = { args: [] as string[], compiledElectron: options.compiledElectron, electron: { action: options.compiledElectron.action, error: options.errorText, failure: options.launchFailure, status: options.status ?? "failed" }, managedSessionOutcome: options.managedSessionOutcome, ...buildAgentBrowserResultCategoryDetails({ args: [], errorText: options.errorText, failureCategory: options.failureCategory, succeeded: false, timedOut: options.failureCategory === "timeout" }), summary: options.errorText };
	return { content: [{ type: "text", text: redactSensitiveText(text) }], details: redactToolDetails(details, []), isError: true };
}

export function formatElectronTargetLines(targets: ElectronCdpTarget[], limit = 8): string[] {
	const shownTargets = targets.slice(0, limit);
	const lines = shownTargets.map((target) => {
		const label = [target.type, target.title].filter(Boolean).join(" ") || target.id || "target";
		return `- ${label}${target.url ? ` — ${target.url}` : ""}`;
	});
	if (targets.length > shownTargets.length) lines.push(`- ... ${targets.length - shownTargets.length} more target(s) omitted`);
	return lines;
}

const ELECTRON_PROFILE_ISOLATION_NOTE = "Profile note: electron.launch starts an isolated temporary profile; it does not reuse the app's normal signed-in profile or attach to an already-running authenticated app.";
const ELECTRON_EXISTING_AUTH_GUIDANCE = "For already-authenticated desktop app content, do not stop here: if host tools are allowed and the app is not running, launch the normal app with --remote-debugging-port=<port>, verify the port, then run agent_browser connect <port>; if it is already running without a debug port, ask before relaunching it.";

export function formatElectronLaunchText(options: { handoff?: FinalResultInput["electronHandoff"]; record: ElectronLaunchRecord; targets: ElectronCdpTarget[]; upstreamText: string }): string {
	const lines = [`Electron launch: ${options.record.appName} attached as ${options.record.sessionName ?? "managed session"} (launchId ${options.record.launchId}, port ${options.record.port}).`, `Identifiers: launchId ${options.record.launchId} for electron.status/electron.cleanup/electron.probe; sessionName ${options.record.sessionName ?? "not attached"} for browser snapshot/tab commands.`, ELECTRON_PROFILE_ISOLATION_NOTE, ELECTRON_EXISTING_AUTH_GUIDANCE, ...formatElectronTargetLines(options.targets)];
	if (options.handoff?.handoff === "snapshot") lines.push(options.handoff.refSnapshot && options.handoff.refSnapshot.refIds.length > 0 ? `Snapshot handoff: ${options.handoff.refSnapshot.refIds.length} interactive ref(s)${options.handoff.snapshotRetryCount ? ` after ${options.handoff.snapshotRetryCount} retry attempt(s)` : ""}.` : "Snapshot handoff: no interactive refs returned after a short readiness retry; run snapshot -i once more before assuming the Electron UI is unusable.");
	else if (options.handoff?.handoff === "tabs") lines.push("Tabs handoff completed: safer diagnostic starting point; no interactive refs were captured.");
	else if (options.handoff?.handoff === "connect") lines.push("Connect handoff completed: run snapshot -i before using interactive refs.");
	lines.push(`Cleanup: use details.nextActions cleanup-electron-launch or call electron.cleanup with launchId ${options.record.launchId} when finished.`);
	if (options.handoff?.error) lines.push(`Handoff warning: ${options.handoff.error}`);
	if (options.upstreamText.trim().length > 0) lines.push("", options.upstreamText.trim());
	return lines.join("\n");
}

export function buildRedactedPresentationContent(options: { exactSensitiveValues: string[]; plainTextInspection: boolean; presentation: AgentBrowserToolPresentation; presentationEnvelope?: AgentBrowserEnvelope; succeeded: boolean; userRequestedJson: boolean; warningText?: string }): AgentBrowserToolResult["content"] {
	const { exactSensitiveValues, plainTextInspection, presentation, presentationEnvelope, succeeded, userRequestedJson, warningText } = options;
	const contentWithSessionWarnings = userRequestedJson && !plainTextInspection ? buildJsonVisibleContent({ error: presentationEnvelope?.error, presentation, succeeded, warnings: warningText ? [warningText] : undefined }) : warningText ? [...presentation.content] : presentation.content;
	if (warningText && !userRequestedJson) {
		if (contentWithSessionWarnings[0]?.type === "text") contentWithSessionWarnings[0] = { ...contentWithSessionWarnings[0], text: `${warningText}\n\n${contentWithSessionWarnings[0].text}` };
		else contentWithSessionWarnings.unshift({ type: "text", text: warningText });
	}
	return contentWithSessionWarnings.map((item) => {
		if (item.type !== "text") return item;
		const exactRedactedText = redactExactSensitiveText(item.text, exactSensitiveValues);
		return userRequestedJson && !plainTextInspection ? { ...item, text: exactRedactedText } : { ...item, text: redactSensitiveText(exactRedactedText) };
	}) as AgentBrowserToolResult["content"];
}

export async function prepareFinalResultRecoveryState(options: {
	aboutBlankSessionMismatch?: AboutBlankSessionMismatch;
	batchRefSnapshotState?: { snapshot?: SessionRefSnapshot; invalidation?: SessionRefSnapshotInvalidation };
	commandTokens: string[];
	compiledSemanticAction?: CompiledAgentBrowserSemanticAction;
	currentRefSnapshot?: SessionRefSnapshot;
	currentRefSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	currentSessionTabTarget?: FinalResultInput["currentSessionTabTarget"];
	cwd: string;
	electronPostCommandHealth?: FinalResultInput["electronPostCommandHealth"];
	errorText?: string;
	executionPlan: AgentBrowserExecutionPlan;
	parseError?: string;
	plainTextInspection: boolean;
	presentation: AgentBrowserToolPresentation;
	processResult: FinalResultInput["processResult"];
	redactedProcessArgs: string[];
	runtimeToolArgs: string[];
	sessionPageState: SessionPageState;
	sessionPageStateUpdate: ReturnType<SessionPageState["beginUpdate"]>;
	sessionTabCorrection?: FinalResultInput["sessionTabCorrection"];
	signal?: AbortSignal;
	succeeded: boolean;
}): Promise<FinalRecoveryState> {
	let { currentRefSnapshot, currentRefSnapshotInvalidation } = options;
	const categoryDetails = buildAgentBrowserResultCategoryDetails({ artifacts: options.presentation.artifacts, args: options.redactedProcessArgs, command: options.executionPlan.commandInfo.command, confirmationRequired: options.presentation.summary.startsWith("Confirmation required"), errorText: options.errorText ?? options.presentation.summary, failureCategory: options.presentation.failureCategory ?? options.presentation.batchFailure?.failedStep.failureCategory ?? (options.electronPostCommandHealth ? "tab-drift" : undefined), inspection: options.plainTextInspection, parseError: options.parseError, savedFile: options.presentation.savedFile, spawnError: options.processResult.spawnError?.message, succeeded: options.succeeded, tabDrift: !options.succeeded && (options.aboutBlankSessionMismatch !== undefined || options.electronPostCommandHealth !== undefined || options.sessionTabCorrection !== undefined), timedOut: options.processResult.timedOut, validationError: undefined });
	let visibleRefFallbackDiagnostic: FinalRecoveryState["visibleRefFallbackDiagnostic"];
	const visibleRefFallbackSessionName = options.executionPlan.sessionName ?? extractExplicitSessionName(options.runtimeToolArgs);
	if (categoryDetails.failureCategory === "selector-not-found") {
		visibleRefFallbackDiagnostic = await collectVisibleRefFallbackDiagnostic({ commandTokens: options.commandTokens, compiledSemanticAction: options.compiledSemanticAction, cwd: options.cwd, sessionName: visibleRefFallbackSessionName, signal: options.signal });
		if (visibleRefFallbackDiagnostic && visibleRefFallbackSessionName) {
			const refUpdate = options.sessionPageState.applyRefSnapshot({ fallbackTarget: options.currentSessionTabTarget, sessionName: visibleRefFallbackSessionName, snapshot: visibleRefFallbackDiagnostic.snapshot, update: options.sessionPageStateUpdate });
			currentRefSnapshot = refUpdate.refSnapshot;
			currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
		}
	}
	const richInputRecoveryDiagnostic = buildRichInputRecoveryDiagnostic(visibleRefFallbackDiagnostic);
	const noActivePageSnapshotFailure = categoryDetails.resultCategory === "failure" && (isNoActivePageSnapshotFailure(options.executionPlan.commandInfo.command, options.errorText ?? options.presentation.summary) || options.batchRefSnapshotState?.invalidation !== undefined);
	if (noActivePageSnapshotFailure && options.executionPlan.sessionName) {
		const refUpdate = options.sessionPageState.applyRefSnapshotInvalidation({ invalidation: buildNoActivePageRefSnapshotInvalidation(), sessionName: options.executionPlan.sessionName, update: options.sessionPageStateUpdate });
		currentRefSnapshot = refUpdate.refSnapshot;
		currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
	}
	return { categoryDetails, currentRefSnapshot, currentRefSnapshotInvalidation, noActivePageSnapshotFailure, richInputRecoveryDiagnostic, visibleRefFallbackDiagnostic, visibleRefFallbackSessionName };
}

function buildResultNextActions(options: FinalResultInput): AgentBrowserNextAction[] | undefined {
	const nextActionCollector = new AgentBrowserNextActionCollector(options.presentation.nextActions);
	if (options.categoryDetails.resultCategory === "success" && options.executionPlan.commandInfo.command === "connect" && !options.electronLaunchRecord) nextActionCollector.appendUnique(buildConnectedSessionNextActions(options.executionPlan.sessionName));
	if (options.noActivePageSnapshotFailure) nextActionCollector.appendUnique(buildNoActivePageNextActions(options.executionPlan.sessionName));
	if (options.aboutBlankSessionMismatch) {
		nextActionCollector.appendUnique(buildSessionTabRecoveryNextActions({ kind: "about-blank", recoveryApplied: options.aboutBlankSessionMismatch.recoveryApplied, sessionName: options.executionPlan.sessionName, tabCorrection: options.aboutBlankSessionMismatch.recoveryApplied ? options.sessionTabCorrection : undefined, target: { title: options.aboutBlankSessionMismatch.targetTitle, url: options.aboutBlankSessionMismatch.targetUrl } }));
		if (!options.aboutBlankSessionMismatch.recoveryApplied) nextActionCollector.removeWhere(isStandaloneSnapshotNextAction);
	} else if (options.categoryDetails.resultCategory === "success" && (options.sessionTabCorrection || options.openResultTabCorrection)) nextActionCollector.appendUnique(buildSessionTabRecoveryNextActions({ kind: "tab-drift", recoveryApplied: true, sessionName: options.executionPlan.sessionName, tabCorrection: options.sessionTabCorrection ?? options.openResultTabCorrection, target: options.currentSessionTabTarget ?? options.priorSessionTabTarget }));
	if (options.categoryDetails.failureCategory === "stale-ref") nextActionCollector.replace(buildSessionAwareStaleRefNextActions(options.executionPlan.sessionName));
	if (options.visibleRefFallbackDiagnostic) nextActionCollector.append(buildVisibleRefFallbackNextActions({ diagnostic: options.visibleRefFallbackDiagnostic, sessionName: options.visibleRefFallbackSessionName }));
	if (options.richInputRecoveryDiagnostic) nextActionCollector.append(buildRichInputRecoveryNextActions({ diagnostic: options.richInputRecoveryDiagnostic, sessionName: options.visibleRefFallbackSessionName }));
	if (options.electronPostCommandHealth) { const electronRecord = options.electronLaunchRecords.get(options.electronPostCommandHealth.launchId); if (electronRecord) nextActionCollector.appendUnique(buildElectronLifecycleNextActions(electronRecord)); }
	if (options.electronSessionMismatch) { const electronRecord = options.electronLaunchRecords.get(options.electronSessionMismatch.launchId); if (electronRecord) nextActionCollector.appendUnique(buildElectronMismatchNextActions(electronRecord, options.electronSessionMismatch.liveTarget)); }
	if (options.categoryDetails.failureCategory === "selector-not-found" && options.redactedCompiledSemanticAction) {
		const candidateActions = buildSemanticActionCandidateActions(options.redactedCompiledSemanticAction);
		if (candidateActions.length > 0) nextActionCollector.append(candidateActions);
	}
	if (options.overlayBlockerDiagnostic) nextActionCollector.append(buildOverlayBlockerNextActions({ diagnostic: options.overlayBlockerDiagnostic, sessionName: options.executionPlan.sessionName }));
	if (options.fillVerificationDiagnostic) nextActionCollector.appendUnique(buildFillVerificationNextActions(options.fillVerificationDiagnostic, options.executionPlan.sessionName));
	if (options.electronRefFreshnessDiagnostic) nextActionCollector.appendUnique(buildElectronRefFreshnessNextActions(options.executionPlan.sessionName));
	if (options.selectorTextVisibilityDiagnostics.length > 0) nextActionCollector.append(buildSelectorTextVisibilityNextActions({ diagnostics: options.selectorTextVisibilityDiagnostics, sessionName: options.executionPlan.sessionName }));
	if (options.electronBroadGetTextScopeDiagnostics.length > 0) nextActionCollector.append(buildElectronBroadGetTextScopeNextActions({ diagnostics: options.electronBroadGetTextScopeDiagnostics, sessionName: options.executionPlan.sessionName }));
	if (options.sourceLookup?.electronContext) nextActionCollector.appendUnique(buildSourceLookupElectronNextActions(options.sourceLookup));
	if (options.clickDispatchDiagnostic) nextActionCollector.append(buildClickDispatchNextActions({ commandTokens: options.commandTokens, sessionName: options.executionPlan.sessionName }));
	if (options.scrollNoopDiagnostic) nextActionCollector.append(buildScrollNoopNextActions(options.executionPlan.sessionName));
	if (options.comboboxFocusDiagnostic) nextActionCollector.append(buildComboboxFocusNextActions(options.executionPlan.sessionName));
	if (options.managedSessionOutcome) nextActionCollector.appendUnique(buildManagedSessionFreshFailureNextActions(options.managedSessionOutcome));
	if (options.categoryDetails.failureCategory === "stale-ref" && options.redactedCompiledSemanticAction && isCompiledSemanticActionFindCommand(options.compiledSemanticAction)) nextActionCollector.append([{ id: "retry-semantic-action-after-stale-ref", params: { args: options.redactedCompiledSemanticAction.args }, reason: "Retry the same semantic target via its compiled find command after the upstream stale-ref failure proves the prior action did not execute.", safety: "Use only for the same intended target; direct stale @refs still require a fresh snapshot or stable locator before retrying.", tool: "agent_browser" as const }]);
	if (options.electronLaunchRecord) nextActionCollector.append(buildAgentBrowserNextActions({ electron: { launchId: options.electronLaunchRecord.launchId, sessionName: options.electronLaunchRecord.sessionName, status: options.electronLaunchRecord.cleanupState }, failureCategory: options.categoryDetails.failureCategory, resultCategory: options.categoryDetails.resultCategory, successCategory: options.categoryDetails.successCategory }));
	return nextActionCollector.toArray();
}

function buildAgentBrowserResultDetails(options: FinalResultInput, nextActions: AgentBrowserNextAction[] | undefined): Record<string, unknown> {
	const publicVisibleRefFallbackDiagnostic = options.visibleRefFallbackDiagnostic ? sanitizeVisibleRefFallbackDiagnostic(options.visibleRefFallbackDiagnostic) : undefined;
	const rawPageChangeSummary = (options.scrollNoopDiagnostic || options.comboboxFocusDiagnostic) && options.presentation.pageChangeSummary ? { ...options.presentation.pageChangeSummary, nextActionIds: nextActions?.map((action) => action.id) } : options.presentation.pageChangeSummary;
	const pageChangeSummary = alignPageChangeSummaryNextActionIds(rawPageChangeSummary, nextActions);
	return {
		args: options.redactedArgs,
		compiledElectron: options.redactedCompiledElectron,
		compiledJob: options.redactedCompiledJob,
		compiledQaPreset: options.redactedCompiledQaPreset,
		compiledSourceLookup: options.redactedCompiledSourceLookup,
		compiledNetworkSourceLookup: options.redactedCompiledNetworkSourceLookup,
		artifactManifest: options.resultArtifactManifest,
		artifactRetentionSummary: options.presentation.artifactRetentionSummary ?? (options.resultArtifactManifest ? formatSessionArtifactRetentionSummary(options.resultArtifactManifest) : undefined),
		artifactCleanup: options.artifactCleanup,
		artifactVerification: options.presentation.artifactVerification,
		artifacts: options.presentation.artifacts,
		batchFailure: options.presentation.batchFailure,
		batchSteps: options.presentation.batchSteps,
		command: options.executionPlan.commandInfo.command,
		compiledSemanticAction: options.redactedCompiledSemanticAction,
		compatibilityWorkaround: options.compatibilityWorkaround,
		subcommand: options.executionPlan.commandInfo.subcommand,
		data: options.presentation.data,
		error: options.plainTextInspection ? undefined : options.presentationEnvelope?.error,
		inspection: options.plainTextInspection || undefined,
		navigationSummary: options.navigationSummary,
		electron: options.electronLaunchRecord ? { action: "launch" as const, cleanup: options.electronFailedConnectCleanup, handoff: options.electronHandoff, identifiers: buildElectronIdentifiers(options.electronLaunchRecord), launch: options.electronLaunchRecord, profileIsolation: options.electronProfileIsolationDetails, status: options.succeeded ? "succeeded" as const : "failed" as const, targets: options.electronLaunch?.targets, version: options.electronLaunch?.version } : undefined,
		...options.categoryDetails,
		aboutBlankSessionMismatch: options.aboutBlankSessionMismatch,
		electronPostCommandHealth: options.electronPostCommandHealth,
		electronRefFreshness: options.electronRefFreshnessDiagnostic,
		electronSessionMismatch: options.electronSessionMismatch,
		openResultTabCorrection: options.openResultTabCorrection,
		effectiveArgs: options.redactedProcessArgs,
		exitCode: options.processResult.exitCode,
		fullOutputPath: options.parseFailureOutput.fullOutputPath ?? options.presentation.fullOutputPath,
		fullOutputPaths: options.presentation.fullOutputPaths,
		fullOutputUnavailable: options.parseFailureOutput.fullOutputUnavailable,
		managedSessionOutcome: options.managedSessionOutcome,
		imagePath: options.presentation.imagePath,
		imagePaths: options.presentation.imagePaths,
		nextActions,
		pageChangeSummary,
		clickDispatch: options.clickDispatchDiagnostic,
		overlayBlockers: options.overlayBlockerDiagnostic,
		fillVerification: options.fillVerificationDiagnostic,
		visibleRefFallback: publicVisibleRefFallbackDiagnostic,
		richInputRecovery: options.richInputRecoveryDiagnostic,
		comboboxFocus: options.comboboxFocusDiagnostic,
		recordingDependencyWarning: options.recordingDependencyWarning,
		scrollNoop: options.scrollNoopDiagnostic,
		qaPreset: options.qaPreset,
		qaAttachedTarget: options.qaAttachedTarget,
		electronGetTextScopeWarning: options.electronBroadGetTextScopeDiagnostics[0],
		electronGetTextScopeWarnings: options.electronBroadGetTextScopeDiagnostics.length > 1 ? options.electronBroadGetTextScopeDiagnostics : undefined,
		selectorTextVisibility: options.selectorTextVisibilityDiagnostics[0],
		selectorTextVisibilityAll: options.selectorTextVisibilityDiagnostics.length > 1 ? options.selectorTextVisibilityDiagnostics : undefined,
		evalStdinHint: options.evalStdinHint,
		evalResultWarning: options.evalResultWarning,
		timeoutPartialProgress: options.timeoutPartialProgress,
		parseError: options.plainTextInspection ? undefined : options.parseError,
		savedFile: options.presentation.savedFile,
		savedFilePath: options.presentation.savedFilePath,
		sourceLookup: options.sourceLookup,
		networkSourceLookup: options.networkSourceLookup,
		networkRouteDiagnostics: options.presentation.networkRouteDiagnostics,
		sessionMode: options.sessionMode,
		sessionTabCorrection: options.sessionTabCorrection,
		sessionTabTarget: options.currentSessionTabTarget,
		refSnapshot: options.currentRefSnapshot,
		refSnapshotInvalidation: options.currentRefSnapshotInvalidation,
		...buildSessionDetailFields(options.executionPlan.sessionName, options.executionPlan.usedImplicitSession),
		sessionRecoveryHint: options.redactedRecoveryHint,
		startupScopedFlags: options.executionPlan.startupScopedFlags,
		stderr: options.processResult.stderr,
		stdout: options.plainTextInspection ? options.inspectionText ?? "" : options.parseSucceeded ? undefined : options.processResult.stdout,
		summary: options.presentation.summary,
		timedOut: options.processResult.timedOut || undefined,
		timeoutMs: options.processResult.timeoutMs,
	};
}

export function buildFinalAgentBrowserToolResult(options: FinalResultInput): AgentBrowserToolResult {
	const nextActions = buildResultNextActions(options);
	const details = buildAgentBrowserResultDetails(options, nextActions);
	const visibleRefFallbackText = formatVisibleRefFallbackText(options.visibleRefFallbackDiagnostic);
	const richInputRecoveryText = formatRichInputRecoveryText(options.richInputRecoveryDiagnostic);
	const semanticActionCandidateText = nextActions ? formatSemanticActionCandidateText(nextActions) : undefined;
	const clickDispatchText = options.clickDispatchDiagnostic ? formatClickDispatchDiagnosticText(options.clickDispatchDiagnostic) : undefined;
	const overlayBlockerText = options.overlayBlockerDiagnostic ? formatOverlayBlockerText(options.overlayBlockerDiagnostic) : undefined;
	const fillVerificationText = formatFillVerificationText(options.fillVerificationDiagnostic);
	const electronRefFreshnessText = formatElectronRefFreshnessText(options.electronRefFreshnessDiagnostic);
	const selectorTextVisibilityText = formatSelectorTextVisibilityText(options.selectorTextVisibilityDiagnostics);
	const electronBroadGetTextScopeText = formatElectronBroadGetTextScopeText(options.electronBroadGetTextScopeDiagnostics);
	const scrollNoopDiagnosticText = formatScrollNoopDiagnosticText(options.scrollNoopDiagnostic);
	const comboboxFocusDiagnosticText = formatComboboxFocusDiagnosticText(options.comboboxFocusDiagnostic);
	const recordingDependencyWarningText = formatRecordingDependencyWarningText(options.recordingDependencyWarning);
	const evalStdinHintText = formatEvalStdinHintText(options.evalStdinHint);
	const evalResultWarningText = formatEvalResultWarningText(options.evalResultWarning);
	const artifactCleanupText = formatArtifactCleanupGuidanceText(options.artifactCleanup);
	const timeoutPartialProgressText = options.timeoutPartialProgress ? formatTimeoutPartialProgressText(options.timeoutPartialProgress) : undefined;
	const managedSessionOutcomeText = formatManagedSessionOutcomeText(options.managedSessionOutcome);
	const rawAppendedDiagnosticText = [visibleRefFallbackText, richInputRecoveryText, semanticActionCandidateText, clickDispatchText, overlayBlockerText, fillVerificationText, electronRefFreshnessText, selectorTextVisibilityText, electronBroadGetTextScopeText, scrollNoopDiagnosticText, comboboxFocusDiagnosticText, recordingDependencyWarningText, evalStdinHintText, evalResultWarningText, artifactCleanupText, timeoutPartialProgressText, managedSessionOutcomeText].filter((item): item is string => item !== undefined).join("\n\n");
	const appendedDiagnosticText = redactSensitiveText(redactExactSensitiveText(rawAppendedDiagnosticText, options.exactSensitiveValues));
	const shouldAppendDiagnosticText = appendedDiagnosticText.length > 0 && (!options.userRequestedJson || options.plainTextInspection);
	let content = shouldAppendDiagnosticText && options.redactedContent[0]?.type === "text" ? [{ ...options.redactedContent[0], text: `${options.redactedContent[0].text}\n\n${appendedDiagnosticText}` }, ...options.redactedContent.slice(1)] : options.redactedContent;
	if (options.electronLaunchRecord && options.succeeded && content[0]?.type === "text") {
		content = [{ ...content[0], text: redactSensitiveText(formatElectronLaunchText({ handoff: options.electronHandoff, record: options.electronLaunchRecord, targets: options.electronLaunch?.targets ?? [], upstreamText: content[0].text })) }, ...content.slice(1)];
	}
	const result = { content, details: redactToolDetails(details, options.exactSensitiveValues), isError: !options.succeeded };
	return options.compiledNetworkSourceLookup ? redactNetworkSourceLookupSurface(result) as typeof result : result;
}

export async function buildMissingBinaryFailureResult(options: { compatibilityWorkaround?: FinalResultInput["compatibilityWorkaround"]; electronLaunch?: FinalResultInput["electronLaunch"]; executionPlan: AgentBrowserExecutionPlan; implicitSessionCloseTimeoutMs: number; managedSessionActive: boolean; managedSessionName: string; processResult: FinalResultInput["processResult"]; redactedArgs: string[]; redactedProcessArgs: string[]; sessionMode: "auto" | "fresh"; sessionTabCorrection?: FinalResultInput["sessionTabCorrection"] }): Promise<AgentBrowserToolResult | undefined> {
	if (!options.processResult.spawnError?.message.includes("ENOENT")) return undefined;
	const errorText = buildMissingBinaryMessage();
	const managedSessionOutcome = buildManagedSessionOutcome({ activeAfter: options.managedSessionActive, activeBefore: options.managedSessionActive, attemptedSessionName: options.executionPlan.managedSessionName, command: options.executionPlan.commandInfo.command, currentSessionName: options.managedSessionName, previousSessionName: options.managedSessionName, sessionMode: options.sessionMode, succeeded: false });
	const managedSessionOutcomeText = formatManagedSessionOutcomeText(managedSessionOutcome);
	const managedSessionRecoveryNextActions = buildManagedSessionFreshFailureNextActions(managedSessionOutcome);
	let missingBinaryElectronCleanup: ElectronCleanupResult | undefined;
	let missingBinaryElectronRecord: ElectronLaunchRecord | undefined;
	if (options.electronLaunch) {
		missingBinaryElectronCleanup = await cleanupElectronLaunchResources({ child: options.electronLaunch.child, record: options.electronLaunch.record, timeoutMs: options.implicitSessionCloseTimeoutMs });
		missingBinaryElectronRecord = missingBinaryElectronCleanup.record;
	}
	const textParts = [errorText, managedSessionOutcomeText, missingBinaryElectronCleanup ? `Electron cleanup after failed attach: ${missingBinaryElectronCleanup.summary}` : undefined].filter((part): part is string => part !== undefined && part.length > 0);
	return { content: [{ type: "text", text: textParts.join("\n\n") }], details: { args: options.redactedArgs, compatibilityWorkaround: options.compatibilityWorkaround, effectiveArgs: options.redactedProcessArgs, electron: missingBinaryElectronRecord ? { action: "launch" as const, cleanup: missingBinaryElectronCleanup, launch: missingBinaryElectronRecord, status: "failed" as const, targets: options.electronLaunch?.targets, version: options.electronLaunch?.version } : undefined, managedSessionOutcome, nextActions: managedSessionRecoveryNextActions.length > 0 ? managedSessionRecoveryNextActions : undefined, sessionMode: options.sessionMode, sessionTabCorrection: options.sessionTabCorrection, ...buildAgentBrowserResultCategoryDetails({ args: options.redactedProcessArgs, command: options.executionPlan.commandInfo.command, errorText, failureCategory: "missing-binary", spawnError: options.processResult.spawnError.message, succeeded: false }), spawnError: options.processResult.spawnError.message }, isError: true };
}
