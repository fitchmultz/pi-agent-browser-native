import { rm } from "node:fs/promises";

import type { ElectronLaunchStatus } from "../../electron/cleanup.js";
import type { ElectronCdpTarget, ElectronLaunchRecord } from "../../electron/launch.js";
import { runAgentBrowserProcess } from "../../process.js";
import { buildAgentBrowserNextActions, getAgentBrowserErrorText, parseAgentBrowserEnvelope, type AgentBrowserBatchResult, type AgentBrowserEnvelope, type AgentBrowserNextAction } from "../../results.js";
import { buildNextToolAction, withOptionalSessionArgs } from "../../results/next-actions.js";
import {
	extractRefSnapshotFromData,
	isAboutBlankUrl,
	normalizeComparableUrl,
	normalizeSessionTabTarget,
	targetsMatch,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
	type SessionTabTarget,
} from "../../session-page-state.js";
import {
	isCloseCommand,
	isElectronPostCommandHealthCommand,
	isNavigationObservableCommandName,
	isRefGuardedCommand,
	isRefInvalidatingBatchCommand,
	isSessionTabPinningExcludedCommand,
	isSessionTabPostCommandCorrectionExcludedCommand,
} from "../../command-taxonomy.js";
import { chooseOpenResultTabCorrection, redactInvocationArgs, type OpenResultTabCorrection } from "../../runtime.js";
import { isRecord } from "../../parsing.js";
import { parseUserBatchStdin } from "../batch-stdin.js";
import type {
	AboutBlankSessionMismatch,
	BatchCommandStep,
	BrowserRunState,
	BrowserRunStatePatch,
	ElectronManagedSessionTarget,
	ElectronPostCommandHealthDiagnostic,
	ElectronPostCommandHealthReason,
	ElectronRefFreshnessDiagnostic,
	ElectronSessionMismatch,
	ElectronSessionMismatchReason,
	ManagedSessionOutcome,
	NavigationSummary,
	PinnedBatchPlan,
	PinnedBatchUnwrapMode,
	StaleRefPreflight,
	TraceOwner,
} from "./types.js";

export const NAVIGATION_SUMMARY_EVAL = `({ title: document.title, url: location.href })`;

export function applyBrowserRunStatePatch(state: BrowserRunState, patch: BrowserRunStatePatch | undefined): void {
	if (!patch) return;
	if (patch.allowedDomainsBySession) state.allowedDomainsBySession = patch.allowedDomainsBySession;
	if ("artifactManifest" in patch) state.artifactManifest = patch.artifactManifest;
	if (patch.freshSessionOrdinal !== undefined) state.freshSessionOrdinal = patch.freshSessionOrdinal;
	if (patch.managedSessionActive !== undefined) state.managedSessionActive = patch.managedSessionActive;
	if (patch.managedSessionCwd !== undefined) state.managedSessionCwd = patch.managedSessionCwd;
	if (patch.managedSessionName !== undefined) state.managedSessionName = patch.managedSessionName;
	if (patch.networkRoutesBySession) state.networkRoutesBySession = patch.networkRoutesBySession;
}

export function buildSessionDetailFields(sessionName: string | undefined, usedImplicitSession: boolean): Record<string, unknown> {
	return sessionName ? { sessionName, usedImplicitSession } : {};
}

export function buildManagedSessionOutcome(options: {
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
	if (isCloseCommand(command)) {
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

function isFreshPostLaunchFailure(outcome: ManagedSessionOutcome): boolean {
	return !outcome.succeeded && outcome.sessionMode === "fresh" && outcome.activeAfter && !!outcome.currentSessionName && (outcome.status === "created" || outcome.status === "replaced" || outcome.status === "unchanged");
}

function formatManagedSessionOutcomeHeadline(outcome: ManagedSessionOutcome): string {
	if (outcome.status === "preserved") {
		return "Managed session outcome: Fresh launch failed; your previous browser session is still active.";
	}
	if (outcome.status === "abandoned") {
		return "Managed session outcome: Fresh launch failed; no managed browser session is current.";
	}
	if (isFreshPostLaunchFailure(outcome)) {
		return "Managed session outcome: Fresh launch became current, but this tool call failed after launch.";
	}
	return `Managed session outcome: ${outcome.summary}`;
}

function formatManagedSessionOutcomeRecoveryGuidance(outcome: ManagedSessionOutcome): string {
	const lines = ["Recovery:"];
	if (outcome.status === "preserved") {
		lines.push('- Continue with sessionMode "auto" on the current session, or retry the intended launch with sessionMode "fresh".');
		lines.push("- Run doctor to verify agent-browser install and environment when failures persist.");
	} else if (outcome.status === "abandoned") {
		lines.push('- Retry with sessionMode "fresh" (for example args: ["open", "<url>"]) after verifying agent-browser is on PATH.');
		lines.push("- Run doctor when install or environment issues are suspected.");
	} else if (isFreshPostLaunchFailure(outcome)) {
		lines.push('- Continue with sessionMode "auto" on the current session, or inspect failureCategory / qaPreset to fix the post-launch failure.');
		lines.push("- Run doctor only if later browser commands also fail.");
	} else {
		lines.push('- Retry with sessionMode "fresh" when launch-scoped flags must apply, or run doctor to verify the environment.');
	}
	lines.push("- Full session names and transition details remain in details.managedSessionOutcome.");
	return lines.join("\n");
}

export function formatManagedSessionOutcomeText(outcome: ManagedSessionOutcome | undefined): string | undefined {
	if (!outcome || outcome.succeeded || outcome.sessionMode !== "fresh") return undefined;
	return [formatManagedSessionOutcomeHeadline(outcome), formatManagedSessionOutcomeRecoveryGuidance(outcome)].join("\n");
}

export function buildManagedSessionFreshFailureNextActions(outcome: ManagedSessionOutcome | undefined): AgentBrowserNextAction[] {
	if (!outcome || outcome.succeeded || outcome.sessionMode !== "fresh") return [];
	const actions: AgentBrowserNextAction[] = [];
	if (!isFreshPostLaunchFailure(outcome)) {
		actions.push(buildNextToolAction({
			args: ["doctor"],
			id: "run-agent-browser-doctor",
			reason: "Verify agent-browser install, PATH, and environment after a failed fresh launch.",
			safety: "Read-only local diagnostics; does not mutate browser state.",
		}));
	}
	if ((outcome.status === "preserved" || isFreshPostLaunchFailure(outcome)) && outcome.activeAfter && outcome.currentSessionName) {
		const sessionLabel = isFreshPostLaunchFailure(outcome) ? "current managed session" : "preserved managed session";
		actions.push(
			buildNextToolAction({
				args: withOptionalSessionArgs(outcome.currentSessionName, ["get", "url"]),
				id: "verify-current-managed-session",
				reason: `Confirm the ${sessionLabel} before continuing with sessionMode auto.`,
				safety: `Read-only URL check on the ${sessionLabel}.`,
			}),
			buildNextToolAction({
				args: withOptionalSessionArgs(outcome.currentSessionName, ["snapshot", "-i"]),
				id: "snapshot-current-managed-session",
				reason: `Refresh interactive refs on the ${sessionLabel} before retrying the workflow.`,
				safety: "Read-only snapshot; no navigation.",
			}),
		);
	} else {
		actions.push(
			buildNextToolAction({
				args: ["open", "about:blank"],
				id: "retry-fresh-managed-session",
				reason: "Start a new managed browser session after the failed fresh launch.",
				safety: "Replace about:blank with the intended URL from your workflow.",
				sessionMode: "fresh",
			}),
		);
	}
	return actions;
}

function getTraceOwner(command: string | undefined): TraceOwner | undefined {
	return command === "trace" || command === "profiler" ? command : undefined;
}

export function getTraceOwnerGuardMessage(options: {
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

export function updateTraceOwnerState(options: {
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

export function extractStringResultField(data: unknown, fieldName: "result" | "title" | "url" | "value"): string | undefined {
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

export function extractNavigationSummaryFromData(data: unknown): NavigationSummary | undefined {
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	const title = extractStringResultField(result, "title");
	const url = extractStringResultField(result, "url");
	return title || url ? { title, url } : undefined;
}

export function shouldCaptureNavigationSummary(command: string | undefined, data: unknown): boolean {
	return (
		isNavigationObservableCommandName(command) &&
		(!isRecord(data) || (typeof data.title !== "string" && typeof data.url !== "string"))
	);
}

export function mergeNavigationSummaryIntoData(data: unknown, navigationSummary: NavigationSummary): unknown {
	if (isRecord(data)) {
		return { ...data, navigationSummary };
	}
	return { navigationSummary, result: data };
}

export function buildAboutBlankRecoveryHint(): string {
	return "agent_browser detected that the active tab became about:blank while this session still had a prior intended tab. Run tab list for this session and re-select the intended tab, or retry with sessionMode:fresh if the tab is gone.".replace("sessionMode:fresh", "sessionMode=fresh");
}

export function buildAboutBlankWarning(mismatch: AboutBlankSessionMismatch): string {
	return `Warning: agent_browser detected that this session returned about:blank while the prior intended tab was ${mismatch.targetUrl}. ${mismatch.recoveryApplied ? "The wrapper re-selected the intended tab for the session." : "No matching tab could be re-selected; run tab list for the same session or retry with sessionMode=fresh."}`;
}

function extractBatchResultCommand(item: Record<string, unknown>): string[] {
	return Array.isArray(item.command) ? item.command.filter((token): token is string => typeof token === "string") : [];
}

export function getStaleRefArgs(commandTokens: string[], stdin?: string): string[] {
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

export function getGuardedRefUsage(commandTokens: string[], stdin?: string, options: { includeRefsAfterBatchSnapshot?: boolean } = {}): string[] {
	const collectFromStep = (step: string[]) => isRefGuardedCommand(step[0]) ? collectRefsFromTokens(step) : [];
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return collectFromStep(commandTokens);
	}
	const parsed = parseUserBatchStdin(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return collectFromStep(commandTokens);
	}
	const refsBeforeInBatchSnapshot: string[] = [];
	for (const step of parsed.steps) {
		if (!options.includeRefsAfterBatchSnapshot && (step[0] ?? "") === "snapshot") break;
		refsBeforeInBatchSnapshot.push(...collectFromStep(step));
	}
	return refsBeforeInBatchSnapshot;
}

function getSnapshotRefRole(refSnapshot: SessionRefSnapshot | undefined, refId: string): string | undefined {
	return refSnapshot?.refs?.[refId]?.role?.toLowerCase();
}

function isSafeSameSnapshotFormBatchStep(step: string[], refSnapshot: SessionRefSnapshot | undefined): boolean {
	const command = step[0];
	const refIds = collectRefsFromTokens(step);
	if (refIds.length === 0 || !refSnapshot) return false;
	const roles = refIds.map((refId) => getSnapshotRefRole(refSnapshot, refId));
	if (roles.some((role) => role === undefined)) return false;
	if (command === "check" || command === "uncheck") return roles.every((role) => role === "checkbox" || role === "radio");
	if (command === "select") return roles.every((role) => role === "combobox");
	return false;
}

function getBatchRefInvalidationMessage(commandTokens: string[], stdin?: string, refSnapshot?: SessionRefSnapshot): string | undefined {
	if (commandTokens[0] !== "batch" || stdin === undefined) return undefined;
	const parsed = parseUserBatchStdin(stdin);
	if (parsed.error || parsed.steps === undefined) return undefined;
	let priorStepInvalidatesRefs = false;
	for (const step of parsed.steps) {
		if ((step[0] ?? "") === "snapshot") {
			priorStepInvalidatesRefs = false;
		}
		const refIds = collectRefsFromTokens(step);
		if (refIds.length > 0 && isRefGuardedCommand(step[0]) && priorStepInvalidatesRefs) {
			return `Batch step ${step[0]} uses page-scoped ref ${refIds.map((refId) => `@${refId}`).join(", ")} after an earlier batch step can navigate or mutate the page. Split the batch, run snapshot -i after the page-changing step, then retry with current refs.`;
		}
		if (isRefInvalidatingBatchCommand(step[0]) && !isSafeSameSnapshotFormBatchStep(step, refSnapshot)) {
			priorStepInvalidatesRefs = true;
		}
	}
	return undefined;
}

export function buildStaleRefPreflight(options: {
	commandTokens: string[];
	currentTarget?: SessionTabTarget;
	refSnapshot?: SessionRefSnapshot;
	refSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	stdin?: string;
}): StaleRefPreflight | undefined {
	const guardedRefIds = [...new Set(getGuardedRefUsage(options.commandTokens, options.stdin))];
	const usedRefIds = options.refSnapshotInvalidation
		? [...new Set(getGuardedRefUsage(options.commandTokens, options.stdin, { includeRefsAfterBatchSnapshot: true }))]
		: guardedRefIds;
	const batchInvalidationMessage = getBatchRefInvalidationMessage(options.commandTokens, options.stdin, options.refSnapshot);
	if (batchInvalidationMessage && guardedRefIds.length > 0) {
		return {
			message: batchInvalidationMessage,
			refIds: guardedRefIds,
			snapshot: options.refSnapshot,
		};
	}
	if (usedRefIds.length === 0) return undefined;
	if (options.refSnapshotInvalidation) {
		return {
			message: `Ref ${usedRefIds.map((refId) => `@${refId}`).join(", ")} cannot be used because the latest snapshot for this session reported No active page. Run snapshot -i successfully before using page-scoped refs.`,
			refIds: usedRefIds,
			snapshotInvalidation: options.refSnapshotInvalidation,
		};
	}
	if (!options.refSnapshot) return undefined;
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

export function shouldPinSessionTabForCommand(options: {
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
		!isSessionTabPinningExcludedCommand(options.command) &&
		supportsPinnedStdinCommand(options)
	);
}

export function buildPinnedBatchPlan(options: {
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
	const includeNavigationSummary = isNavigationObservableCommandName(options.command);
	const tabSelectionStep: BatchCommandStep = ["tab", options.selectedTab];
	const commandStep = options.commandTokens as BatchCommandStep;
	const navigationSummarySteps: BatchCommandStep[] = includeNavigationSummary ? [["eval", NAVIGATION_SUMMARY_EVAL]] : [];
	return {
		includeNavigationSummary,
		steps: [tabSelectionStep, commandStep, ...navigationSummarySteps],
		unwrapMode: "single-command",
	};
}

export function shouldCorrectSessionTabAfterCommand(options: { command?: string; pinningRequired?: boolean; sessionName?: string }): boolean {
	return (
		options.pinningRequired === true &&
		options.sessionName !== undefined &&
		options.command !== undefined &&
		!isSessionTabPostCommandCorrectionExcludedCommand(options.command)
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

export function unwrapPinnedSessionBatchEnvelope(options: {
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

export async function runSessionCommandData(options: {
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

export async function collectOpenResultTabCorrection(options: {
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

export async function collectSessionTabSelection(options: {
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

export async function applyOpenResultTabCorrection(options: {
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

export function isLiveElectronRendererTarget(target: ElectronCdpTarget): boolean {
	const normalizedUrl = normalizeComparableUrl(target.url);
	if (!normalizedUrl || normalizedUrl === "about:blank" || normalizedUrl.startsWith("devtools://")) return false;
	return target.type === undefined || target.type === "page" || target.type === "webview";
}

export function getLiveElectronRendererTargets(targets: ElectronCdpTarget[]): ElectronCdpTarget[] {
	return targets.filter(isLiveElectronRendererTarget);
}

export function electronTargetLabel(target: ElectronCdpTarget | undefined): string {
	if (!target) return "unknown target";
	return [target.title, target.url, target.id].find((value) => typeof value === "string" && value.trim().length > 0) ?? "unknown target";
}

export function getActiveElectronRecords(records: Map<string, ElectronLaunchRecord>): ElectronLaunchRecord[] {
	return [...records.values()].filter((record) => record.cleanupState === "active" || record.cleanupState === "dead" || record.cleanupState === "partial" || record.cleanupState === "failed");
}

export function findElectronLaunchRecordForSession(sessionName: string | undefined, records: Map<string, ElectronLaunchRecord>): ElectronLaunchRecord | undefined {
	if (!sessionName) return undefined;
	return getActiveElectronRecords(records).find((record) => record.sessionName === sessionName);
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

export function buildElectronMismatchNextActions(record: ElectronLaunchRecord, liveTarget?: ElectronCdpTarget): AgentBrowserNextAction[] {
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

export function buildElectronSessionMismatch(options: {
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

export function formatElectronSessionMismatchText(mismatch: ElectronSessionMismatch): string {
	return `${mismatch.summary}\nNext: run electron.status/electron.probe with launchId ${mismatch.launchId}, reattach with the reattach-electron-launch nextAction if needed, or cleanup when finished.`;
}

export function shouldInspectElectronPostCommandHealth(command: string | undefined): boolean {
	return isElectronPostCommandHealthCommand(command);
}

export function buildElectronLifecycleNextActions(record: ElectronLaunchRecord): AgentBrowserNextAction[] {
	return buildAgentBrowserNextActions({
		electron: { launchId: record.launchId, sessionName: record.sessionName, status: record.cleanupState },
		resultCategory: "success",
		successCategory: "completed",
	}) ?? [];
}

export function buildElectronPostCommandHealthDiagnostic(options: {
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

export function formatElectronPostCommandHealthText(diagnostic: ElectronPostCommandHealthDiagnostic | undefined): string | undefined {
	if (!diagnostic) return undefined;
	const lines = [diagnostic.summary];
	if (diagnostic.target?.url) lines.push(`Current browser session target: ${diagnostic.target.url}.`);
	lines.push(`Status: ${diagnostic.status.portAlive ? "debug port alive" : "debug port dead"}${diagnostic.status.pidAlive === undefined ? "" : diagnostic.status.pidAlive ? ", pid alive" : ", pid dead"}; ${diagnostic.status.targets.length} CDP target(s).`);
	lines.push(`Next: run electron.status/electron.probe with launchId ${diagnostic.launchId}, cleanup the wrapper-owned launch if dead, or relaunch the app.`);
	return lines.join("\n");
}

export function buildElectronIdentifiers(record: ElectronLaunchRecord): { appName: string; launchId: string; sessionName?: string } {
	return { appName: record.appName, launchId: record.launchId, sessionName: record.sessionName };
}

export function buildElectronRefFreshnessNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	return [{
		id: "refresh-electron-refs-after-rerender",
		params: { args: sessionName ? ["--session", sessionName, "snapshot", "-i"] : ["snapshot", "-i"] },
		reason: "Electron UIs often rerender without changing URL; refresh refs before using old @e handles again.",
		safety: "Read-only snapshot; avoids stale same-URL refs after quick-pick, modal, theme, or editor rerenders.",
		tool: "agent_browser",
	}];
}

export function buildElectronRefFreshnessDiagnostic(options: {
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

export function formatElectronRefFreshnessText(diagnostic: ElectronRefFreshnessDiagnostic | undefined): string | undefined {
	return diagnostic?.summary;
}

export async function closeManagedSession(options: { cwd: string; sessionName: string; timeoutMs: number }): Promise<string | undefined> {
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

export { extractBatchResultCommand };
