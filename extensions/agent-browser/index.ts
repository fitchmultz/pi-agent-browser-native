import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	PROJECT_RULE_PROMPT,
	buildBrowserDefaultProfileGuideline,
	buildBrowserExecutablePathGuideline,
	buildToolPromptGuidelines,
} from "./lib/playbook.js";
import { SessionPageState } from "./lib/session-page-state.js";
import {
	canUseHeadlessCompatibilityUserAgent,
	createEphemeralSessionSeed,
	createFreshSessionName,
	createImplicitSessionName,
	extractCommandTokens,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	isRestorableManagedSessionName,
	restoreManagedSessionStateFromBranch,
	validateToolArgs,
	redactSensitiveText,
	isPlainTextInspectionArgs,
	type CompatibilityWorkaround,
} from "./lib/runtime.js";
import { extractExplicitNamespace, extractExplicitSessionName, isUpstreamEnvFlagEnabled, resolveAgentBrowserNamespace } from "./lib/argv-grammar.js";
import { parseArgvDescriptor } from "./lib/argv-descriptor.js";
import { needsManagedSession } from "./lib/command-policy.js";
import { cleanupManagedSessionRestoreConfig, ManagedSessionRestoreState } from "./lib/managed-session-restore.js";
import { isRecord } from "./lib/parsing.js";
import { runAgentBrowserProcess } from "./lib/process.js";
import { getAgentBrowserProcessEnvironment, withIsolatedAgentBrowserEnvironment } from "./lib/process-environment.js";
import {
	TARGET_AGENT_BROWSER_VERSION,
	TARGET_AGENT_BROWSER_VERSION_LABEL,
	getAgentBrowserVersionValidationError,
	parseAgentBrowserVersionOutput,
} from "./lib/upstream-version.js";
import { buildPromptPolicy, getLatestUserPrompt, shouldAppendBrowserSystemPrompt } from "./lib/prompt-policy.js";
import { isCloseCommand } from "./lib/command-taxonomy.js";
import { hasLaunchScopedFlagToken } from "./lib/launch-scoped-flags.js";
import { cleanupSecureTempArtifacts } from "./lib/temp.js";
import { AGENT_BROWSER_PARAMS } from "./lib/input-modes/params.js";
import { type CompiledAgentBrowserElectron } from "./lib/input-modes/types.js";
import {
	AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS,
	AGENT_BROWSER_SCRIPT_NAMESPACE,
	createAgentBrowserScriptSessionName,
	isAgentBrowserScriptSessionName,
	runAgentBrowserScript,
	type AgentBrowserScriptRunResult,
} from "./lib/input-modes/script.js";
import { parseAllowedDomainsPolicyFromArgs, type AllowedDomainsPolicy } from "./lib/navigation-policy.js";
import { closeManagedSession, getSessionContextKey, runAgentBrowserTool, type AgentBrowserToolResult, type BrowserRunState, type TraceOwner } from "./lib/orchestration/browser-run/index.js";
import { getExplicitArtifactDestination } from "./lib/orchestration/browser-run/artifact-paths.js";
import { findElectronLaunchRecordForSession, getActiveElectronRecords } from "./lib/orchestration/browser-run/session-state.js";
import { parseBatchStdinJsonArray } from "./lib/orchestration/batch-stdin.js";
import {
	ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
	ELECTRON_PROFILE_ISOLATION_DETAILS,
	cleanupActiveElectronHostLaunches,
	handleElectronHostInput,
	restoreElectronLaunchRecordsFromBranch,
	type ElectronLaunchRecord,
} from "./lib/orchestration/electron-host/index.js";
import { buildValidationFailureResult, resolveAgentBrowserInput, type AgentBrowserExecuteParams } from "./lib/orchestration/input-plan.js";
import { applyAgentBrowserOutputPath, getAgentBrowserOutputPathValidationError } from "./lib/orchestration/output-file.js";
import { appendScriptSessionLease, buildScriptBrowserEnvelope, buildScriptToolResult, getScriptSessionLeasesFromBranch } from "./lib/orchestration/script-mode.js";
import type { NetworkRouteRecord, SessionArtifactManifest } from "./lib/results/contracts.js";
import { formatSessionArtifactRetentionSummary, getSessionArtifactManifestEntryKey, isSessionArtifactManifest, mergeSessionArtifactManifest } from "./lib/results/artifact-manifest.js";
import { canRegisterWebSearchTool, loadAgentBrowserConfigSync } from "./lib/config.js";
import { createAgentBrowserWebSearchTool } from "./lib/web-search.js";
import {
	isDirectAgentBrowserBashAllowed,
	isHarmlessAgentBrowserInspectionCommand,
	looksLikeDirectAgentBrowserBash,
} from "./lib/bash-guard.js";
import {
	AgentBrowserResultComponent,
	buildAgentBrowserToolResultPatch,
	formatAgentBrowserRenderCall,
	formatAgentBrowserRenderResult,
} from "./lib/pi-tool-rendering.js";

type BashToolCallLike = {
	input: { command: string };
	toolName: "bash";
};

function isBashToolCallEvent(event: unknown): event is BashToolCallLike {
	if (!isRecord(event) || event.toolName !== "bash" || !isRecord(event.input)) return false;
	return typeof event.input.command === "string";
}

type OwnedManagedSession = {
	branchOwned: boolean;
	cwd: string;
	headedManagedAutosaveDisabled?: boolean;
	headedManagedAutosaveInterval?: string;
	namespace?: string;
	sessionName: string;
};

// Event ranks are local to the branch being restored. Keep them out of owned-resource
// state so branch switches never compare unrelated branch histories.
interface BranchManagedResourceEvents {
	electronLaunchActiveRanks: Map<string, number>;
	electronLaunchCleanupRanks: Map<string, number>;
	managedSessionActiveIdentities: Map<string, { namespace?: string; sessionName: string }>;
	managedSessionActiveRanks: Map<string, number>;
	managedSessionCloseRanks: Map<string, number>;
}

function getBatchPreflightValidationError(args: string[], stdin: string | undefined, cwd: string): string | undefined {
	const commandTokens = extractCommandTokens(args);
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return undefined;
	}
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return undefined;
	}
	const artifactDestinations = new Map<string, number>();
	for (const [index, step] of parsed.steps.entries()) {
		if (!Array.isArray(step) || !step.every((token) => typeof token === "string") || step.length === 0) continue;
		const stepValidationError = validateToolArgs(step);
		if (stepValidationError) return `Unsupported batch step ${index + 1}: ${stepValidationError}`;
		const artifactDestination = getExplicitArtifactDestination(step);
		if (artifactDestination) {
			const absoluteDestination = resolve(cwd, artifactDestination);
			const priorStep = artifactDestinations.get(absoluteDestination);
			if (priorStep !== undefined) {
				return `Unsupported batch artifact destination in step ${index + 1}: ${artifactDestination} is already written by step ${priorStep + 1}. Use distinct paths or split the batch so each artifact can be verified independently.`;
			}
			artifactDestinations.set(absoluteDestination, index);
		}
		if (step[0] === "screenshot" && step.includes("--annotate")) {
			return [
				`Unsupported batch screenshot annotation in step ${index + 1}: put --annotate in top-level args, not inside the batch step.`,
				`Use: { "args": ["--annotate", "batch"], "stdin": "[[\\"screenshot\\",\\"/path/to/image.png\\"]]" }`,
			].join("\n");
		}
	}
	return undefined;
}

function restoreArtifactManifestFromBranch(branch: unknown[]): SessionArtifactManifest | undefined {
	let restoredManifest: SessionArtifactManifest | undefined;
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		if (isSessionArtifactManifest(details?.artifactManifest) && (!restoredManifest || details.artifactManifest.updatedAtMs >= restoredManifest.updatedAtMs)) {
			restoredManifest = details.artifactManifest;
		}
	}
	return restoredManifest;
}

function restoreManagedSessionCompatibilityWorkaroundFromBranch(
	branch: unknown[],
	sessionName: string,
	namespace?: string,
): CompatibilityWorkaround | undefined {
	let restored: CompatibilityWorkaround | undefined;
	const targetKey = getSessionContextKey(sessionName, namespace);
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) continue;
		const workaround = isRecord(details.compatibilityWorkaround) ? details.compatibilityWorkaround : undefined;
		if (getSessionContextKey(typeof details.sessionName === "string" ? details.sessionName : undefined, typeof details.namespace === "string" ? details.namespace : undefined) !== targetKey) continue;
		const recognizedWorkaround: CompatibilityWorkaround | undefined =
			(workaround?.id === "chatgpt-headless-user-agent" || workaround?.id === "cloudflare-headless-user-agent") && typeof workaround.reason === "string"
				? { id: workaround.id, reason: workaround.reason }
				: undefined;
		const succeeded = getSuccessfulToolResult(details, message);
		const outcome = getManagedSessionOutcome(details);
		const activeAfterFailure = recognizedWorkaround
			&& outcome?.activeAfter === true
			&& typeof outcome.currentSessionName === "string"
			&& getSessionContextKey(outcome.currentSessionName, typeof outcome.currentSessionNamespace === "string" ? outcome.currentSessionNamespace : undefined) === targetKey
			&& (outcome.status === "created" || outcome.status === "replaced" || outcome.status === "unchanged");
		if (!succeeded && !activeAfterFailure) continue;
		if (recognizedWorkaround) {
			restored = recognizedWorkaround;
		} else if (!canUseHeadlessCompatibilityUserAgent(getToolResultArgs(details))) {
			restored = undefined;
		}
	}
	return restored;
}

function restoreManagedSessionHeadedAutosaveDisabledFromBranch(
	branch: unknown[],
	sessionName: string,
	namespace?: string,
): boolean {
	let restored = false;
	const targetKey = getSessionContextKey(sessionName, namespace);
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) continue;
		if (getSessionContextKey(typeof details.sessionName === "string" ? details.sessionName : undefined, typeof details.namespace === "string" ? details.namespace : undefined) !== targetKey) continue;
		const outcome = getManagedSessionOutcome(details);
		const activeAfterFailure = outcome?.activeAfter === true
			&& typeof outcome.currentSessionName === "string"
			&& getSessionContextKey(outcome.currentSessionName, typeof outcome.currentSessionNamespace === "string" ? outcome.currentSessionNamespace : undefined) === targetKey;
		if ((getSuccessfulToolResult(details, message) || activeAfterFailure) && typeof details.managedSessionHeadedAutosaveDisabled === "boolean") {
			restored = details.managedSessionHeadedAutosaveDisabled;
		}
	}
	return restored;
}

function restoreManagedSessionHeadedAutosaveIntervalFromBranch(
	branch: unknown[],
	sessionName: string,
	namespace?: string,
): string | undefined {
	let restored: string | undefined;
	const targetKey = getSessionContextKey(sessionName, namespace);
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) continue;
		if (getSessionContextKey(typeof details.sessionName === "string" ? details.sessionName : undefined, typeof details.namespace === "string" ? details.namespace : undefined) !== targetKey) continue;
		const outcome = getManagedSessionOutcome(details);
		const activeAfterFailure = outcome?.activeAfter === true
			&& typeof outcome.currentSessionName === "string"
			&& getSessionContextKey(outcome.currentSessionName, typeof outcome.currentSessionNamespace === "string" ? outcome.currentSessionNamespace : undefined) === targetKey;
		if (!getSuccessfulToolResult(details, message) && !activeAfterFailure) continue;
		if (typeof details.managedSessionHeadedAutosaveInterval === "string") restored = details.managedSessionHeadedAutosaveInterval;
		else if (details.managedSessionHeadedAutosaveDisabled === true) restored = "0";
	}
	return restored;
}

function getToolResultArgs(details: Record<string, unknown>): string[] {
	if (Array.isArray(details.args) && details.args.every((arg) => typeof arg === "string")) return details.args;
	if (Array.isArray(details.effectiveArgs) && details.effectiveArgs.every((arg) => typeof arg === "string")) return details.effectiveArgs;
	return [];
}

function isAttachedBrowserInvocation(args: string[], env: NodeJS.ProcessEnv = getAgentBrowserProcessEnvironment()): boolean {
	const autoConnectEnv = env.AGENT_BROWSER_AUTO_CONNECT;
	return extractCommandTokens(args)[0] === "connect"
		|| hasLaunchScopedFlagToken(args, "--cdp")
		|| hasLaunchScopedFlagToken(args, "--auto-connect")
		|| env.AGENT_BROWSER_CDP !== undefined
		|| isUpstreamEnvFlagEnabled(autoConnectEnv);
}

function restoreAttachedSessionKeysFromBranch(branch: unknown[]): Set<string> {
	const attachedSessionKeys = new Set<string>();
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) continue;
		const managedSessionOutcome = isRecord(details.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
		const retainedFailedAttachment = details.attachedBrowserSession === true && managedSessionOutcome?.activeAfter === true;
		if (!getSuccessfulToolResult(details, message) && !retainedFailedAttachment) continue;
		const args = getToolResultArgs(details);
		const sessionName = typeof details.sessionName === "string" ? details.sessionName : extractExplicitSessionName(args);
		if (!sessionName) continue;
		const namespace = typeof details.namespace === "string" ? details.namespace : extractExplicitNamespace(args);
		const sessionKey = getSessionContextKey(sessionName, namespace) ?? sessionName;
		if (isCloseCommand(extractCommandTokens(args)[0])) attachedSessionKeys.delete(sessionKey);
		else if (details.attachedBrowserSession === true || isAttachedBrowserInvocation(args, {})) attachedSessionKeys.add(sessionKey);
	}
	return attachedSessionKeys;
}

function restoreAllowedDomainsBySessionFromBranch(branch: unknown[]): Map<string, AllowedDomainsPolicy> {
	const restoredPolicies = new Map<string, AllowedDomainsPolicy>();
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) continue;
		const succeeded = getSuccessfulToolResult(details, message);
		const args = getToolResultArgs(details);
		const command = typeof details.command === "string" ? details.command : extractCommandTokens(args)[0];
		const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
		const namespace = typeof details.namespace === "string" ? details.namespace : undefined;
		const sessionKey = getSessionContextKey(sessionName, namespace);
		const explicitSessionName = extractExplicitSessionName(args);
		const outcome = getManagedSessionOutcome(details);
		const outcomeSucceeded = outcome?.succeeded === true;
		const outcomeStatus = typeof outcome?.status === "string" ? outcome.status : undefined;
		const outcomeCurrentSessionName = typeof outcome?.currentSessionName === "string" ? outcome.currentSessionName : undefined;
		const outcomeAttemptedSessionName = typeof outcome?.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
		if (outcomeSucceeded && outcomeStatus === "closed") {
			const closedSessionName = outcomeAttemptedSessionName ?? outcomeCurrentSessionName ?? sessionName;
			if (closedSessionName) restoredPolicies.delete(getSessionContextKey(closedSessionName, namespace) ?? closedSessionName);
		}
		if (outcomeSucceeded && outcomeStatus === "replaced") {
			const replacedSessionName = typeof outcome.replacedSessionName === "string" ? outcome.replacedSessionName : undefined;
			const replacedSessionNamespace = typeof outcome.replacedSessionNamespace === "string" ? outcome.replacedSessionNamespace : namespace;
			if (replacedSessionName) restoredPolicies.delete(getSessionContextKey(replacedSessionName, replacedSessionNamespace) ?? replacedSessionName);
		}
		if (succeeded && isCloseCommand(command)) {
			const closedSessionName = explicitSessionName ?? sessionName ?? outcomeAttemptedSessionName ?? outcomeCurrentSessionName;
			if (closedSessionName) restoredPolicies.delete(getSessionContextKey(closedSessionName, namespace) ?? closedSessionName);
		}
		const electron = isRecord(details.electron) ? details.electron : undefined;
		const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
		const cleanupResults = Array.isArray(cleanup?.results) ? cleanup.results : [];
		for (const cleanupResult of cleanupResults) {
			for (const closedSessionName of getCleanupResultClosedManagedSessionNames(cleanupResult)) restoredPolicies.delete(closedSessionName);
		}
		const outcomeKeepsSessionCurrent = outcome?.activeAfter === true
			&& (outcomeStatus === "created" || outcomeStatus === "replaced" || outcomeStatus === "unchanged")
			&& outcomeCurrentSessionName === sessionName;
		const policy = (succeeded || outcomeKeepsSessionCurrent) && sessionKey && !isCloseCommand(command) ? parseAllowedDomainsPolicyFromArgs(args) : undefined;
		if (policy && sessionKey) restoredPolicies.set(sessionKey, policy);
	}
	return restoredPolicies;
}

function trackOwnedManagedSession(
	sessions: Map<string, OwnedManagedSession>,
	sessionName: string | undefined,
	cwd: string,
	options: { branchOwned?: boolean; headedManagedAutosaveDisabled?: boolean; headedManagedAutosaveInterval?: string; namespace?: string } = {},
): void {
	if (!sessionName) return;
	const key = getSessionContextKey(sessionName, options.namespace) ?? sessionName;
	const existing = sessions.get(key);
	const branchOwned = existing && !existing.branchOwned ? false : options.branchOwned === true;
	const headedManagedAutosaveDisabled = options.headedManagedAutosaveDisabled ?? existing?.headedManagedAutosaveDisabled;
	const headedManagedAutosaveInterval = options.headedManagedAutosaveInterval ?? existing?.headedManagedAutosaveInterval;
	sessions.set(key, { branchOwned, cwd, headedManagedAutosaveDisabled, headedManagedAutosaveInterval, namespace: options.namespace, sessionName });
}

function untrackOwnedManagedSession(sessions: Map<string, OwnedManagedSession>, sessionName: string | undefined, namespace?: string): void {
	if (!sessionName) return;
	if (sessionName.includes("\u0000")) sessions.delete(sessionName);
	else sessions.delete(getSessionContextKey(sessionName, namespace) ?? sessionName);
}

function untrackOwnedManagedSessionFromBranchClose(
	sessions: Map<string, OwnedManagedSession>,
	sessionName: string | undefined,
	activeBranchRank: number | undefined,
	closeBranchRank: number | undefined,
): void {
	if (!sessionName || closeBranchRank === undefined) return;
	const ownedSession = sessions.get(sessionName);
	if (!ownedSession?.branchOwned) return;
	if (activeBranchRank !== undefined && closeBranchRank <= activeBranchRank) return;
	sessions.delete(sessionName);
}

function syncOwnedManagedSessionsFromResult(sessions: Map<string, OwnedManagedSession>, result: AgentToolResult<unknown>, cwd: string): void {
	const details = isRecord(result.details) ? result.details : undefined;
	const outcome = isRecord(details?.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
	if (!outcome) return;
	const succeeded = outcome.succeeded === true;
	const status = typeof outcome.status === "string" ? outcome.status : undefined;
	const currentSessionName = typeof outcome.currentSessionName === "string" ? outcome.currentSessionName : undefined;
	const attemptedSessionName = typeof outcome.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
	if (outcome.activeAfter === true && (status === "created" || status === "replaced" || status === "unchanged")) {
		const namespace = isRecord(details) && typeof details.namespace === "string" ? details.namespace : undefined;
		trackOwnedManagedSession(sessions, currentSessionName, cwd, {
			headedManagedAutosaveDisabled: details?.managedSessionHeadedAutosaveDisabled === true,
			headedManagedAutosaveInterval: typeof details?.managedSessionHeadedAutosaveInterval === "string" ? details.managedSessionHeadedAutosaveInterval : undefined,
			namespace,
		});
	}
	if (succeeded && status === "closed") {
		untrackOwnedManagedSession(sessions, attemptedSessionName ?? currentSessionName);
	}
}

function getTouchedElectronLaunchIds(sessionName: string | undefined, records: Map<string, ElectronLaunchRecord>): Set<string> | undefined {
	const record = findElectronLaunchRecordForSession(sessionName, records);
	return record ? new Set([record.launchId]) : undefined;
}

function mergeActiveElectronLaunchRecords(
	target: Map<string, ElectronLaunchRecord>,
	source: Map<string, ElectronLaunchRecord>,
	options: {
		branchOwnedLaunchIds?: Set<string>;
		markBranchOwned?: boolean;
		touchedLaunchIds?: Set<string>;
	} = {},
): void {
	for (const record of getActiveElectronRecords(source)) {
		const alreadyRuntimeOwned = target.has(record.launchId) && options.branchOwnedLaunchIds?.has(record.launchId) === false;
		target.set(record.launchId, record);
		if (options.branchOwnedLaunchIds) {
			if (alreadyRuntimeOwned) {
				// Already runtime-owned from a prior live result; keep it that way.
			} else if (options.markBranchOwned === true) {
				options.branchOwnedLaunchIds.add(record.launchId);
			} else if (options.touchedLaunchIds?.has(record.launchId)) {
				options.branchOwnedLaunchIds.delete(record.launchId);
			}
		}
	}
}

function removeInactiveOwnedElectronLaunchRecords(
	target: Map<string, ElectronLaunchRecord>,
	branchOwnedLaunchIds: Set<string>,
	source: Map<string, ElectronLaunchRecord>,
	activeBranchRanks: Map<string, number>,
	cleanupBranchRanks: Map<string, number>,
): void {
	const activeLaunchIds = new Set(getActiveElectronRecords(source).map((record) => record.launchId));
	const launchIds = new Set([...source.keys(), ...cleanupBranchRanks.keys()]);
	for (const launchId of launchIds) {
		if (!target.has(launchId) || !branchOwnedLaunchIds.has(launchId)) continue;
		const activeBranchRank = activeBranchRanks.get(launchId);
		const cleanupBranchRank = cleanupBranchRanks.get(launchId);
		const restoredInactiveRecord = source.has(launchId) && !activeLaunchIds.has(launchId);
		const cleanupIsLatest = cleanupBranchRank !== undefined && (activeBranchRank === undefined || cleanupBranchRank > activeBranchRank);
		if (!restoredInactiveRecord && !cleanupIsLatest) continue;
		target.delete(launchId);
		branchOwnedLaunchIds.delete(launchId);
	}
}

function mergeElectronLaunchRecordMaps(...maps: Array<Map<string, ElectronLaunchRecord>>): Map<string, ElectronLaunchRecord> {
	const merged = new Map<string, ElectronLaunchRecord>();
	for (const map of maps) {
		for (const [launchId, record] of map) merged.set(launchId, record);
	}
	return merged;
}

function replaceWithActiveElectronLaunchRecords(
	target: Map<string, ElectronLaunchRecord>,
	source: Map<string, ElectronLaunchRecord>,
	branchOwnedLaunchIds?: Set<string>,
	cleanedLaunchIds?: Set<string>,
): void {
	target.clear();
	if (branchOwnedLaunchIds) {
		if (cleanedLaunchIds) {
			for (const launchId of cleanedLaunchIds) branchOwnedLaunchIds.delete(launchId);
		} else {
			branchOwnedLaunchIds.clear();
		}
	}
	mergeActiveElectronLaunchRecords(target, source, branchOwnedLaunchIds ? { branchOwnedLaunchIds } : {});
}

function shouldSerializeElectronHostInput(compiledElectron: CompiledAgentBrowserElectron | undefined): boolean {
	return compiledElectron?.action === "status" || compiledElectron?.action === "probe" || compiledElectron?.action === "cleanup";
}

function getElectronHostLaunchRecordsForInput(options: {
	branchRecords: Map<string, ElectronLaunchRecord>;
	compiledElectron: CompiledAgentBrowserElectron | undefined;
	ownedRecords: Map<string, ElectronLaunchRecord>;
}): Map<string, ElectronLaunchRecord> {
	if (
		options.compiledElectron?.action === "status" ||
		options.compiledElectron?.action === "cleanup" ||
		(options.compiledElectron?.action === "probe" && options.compiledElectron.launchId)
	) {
		return mergeElectronLaunchRecordMaps(options.branchRecords, options.ownedRecords);
	}
	return options.branchRecords;
}

function getCleanupResultClosedManagedSessionNames(result: unknown): string[] {
	if (!isRecord(result) || !Array.isArray(result.steps)) return [];
	const closedSessionNames = new Set<string>();
	const record = isRecord(result.record) ? result.record : undefined;
	for (const step of result.steps) {
		if (!isRecord(step) || step.resource !== "managed-session") continue;
		if (step.state !== "removed" && step.state !== "already-gone") continue;
		const sessionName = typeof step.sessionName === "string"
			? step.sessionName
			: typeof record?.sessionName === "string" ? record.sessionName : undefined;
		if (sessionName) closedSessionNames.add(sessionName);
	}
	return [...closedSessionNames];
}

function getCleanupResultsClosedManagedSessionNames(cleanupResults: unknown[]): string[] {
	const closedSessionNames = new Set<string>();
	for (const result of cleanupResults) {
		for (const sessionName of getCleanupResultClosedManagedSessionNames(result)) closedSessionNames.add(sessionName);
	}
	return [...closedSessionNames];
}

function isElectronLaunchRecord(value: unknown): value is ElectronLaunchRecord {
	if (!isRecord(value)) return false;
	return value.version === 1
		&& value.launchedByWrapper === true
		&& typeof value.launchId === "string"
		&& typeof value.appName === "string"
		&& typeof value.executablePath === "string"
		&& typeof value.userDataDir === "string"
		&& typeof value.port === "number"
		&& typeof value.createdAtMs === "number";
}

function getCleanupResultsElectronRecords(cleanupResults: unknown[]): ElectronLaunchRecord[] {
	return cleanupResults
		.map((result) => isRecord(result) ? result.record : undefined)
		.filter(isElectronLaunchRecord);
}

function mergeElectronCleanupRecords(target: Map<string, ElectronLaunchRecord>, cleanupResults: unknown[]): void {
	for (const record of getCleanupResultsElectronRecords(cleanupResults)) {
		target.set(record.launchId, record);
	}
}

function getManagedSessionOutcome(details: Record<string, unknown>): Record<string, unknown> | undefined {
	return isRecord(details.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
}

function getSuccessfulToolResult(details: Record<string, unknown>, message: Record<string, unknown>): boolean {
	const messageIsError = typeof message.isError === "boolean" ? message.isError : undefined;
	const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
	return messageIsError === undefined ? exitCode === undefined || exitCode === 0 : !messageIsError;
}

function setBranchRankForString(map: Map<string, number>, value: unknown, rank: number): void {
	if (typeof value === "string" && value.length > 0) map.set(value, rank);
}

function setBranchManagedSessionActive(events: BranchManagedResourceEvents, sessionName: unknown, namespace: string | undefined, rank: number): void {
	if (typeof sessionName !== "string" || sessionName.length === 0) return;
	const key = getSessionContextKey(sessionName, namespace) ?? sessionName;
	events.managedSessionActiveIdentities.set(key, { namespace, sessionName });
	events.managedSessionActiveRanks.set(key, rank);
}

function collectBranchManagedResourceEvents(branch: unknown[]): BranchManagedResourceEvents {
	const events: BranchManagedResourceEvents = {
		electronLaunchActiveRanks: new Map<string, number>(),
		electronLaunchCleanupRanks: new Map<string, number>(),
		managedSessionActiveIdentities: new Map<string, { namespace?: string; sessionName: string }>(),
		managedSessionActiveRanks: new Map<string, number>(),
		managedSessionCloseRanks: new Map<string, number>(),
	};
	let eventRank = 0;
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.toolName !== "agent_browser") continue;
		const details = isRecord(message.details) ? message.details : undefined;
		if (!details) continue;
		eventRank += 1;
		const succeeded = getSuccessfulToolResult(details, message);
		const args = Array.isArray(details.args) && details.args.every((arg) => typeof arg === "string") ? details.args : [];
		const command = typeof details.command === "string" ? details.command : extractCommandTokens(args)[0];
		const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
		const namespace = typeof details.namespace === "string" ? details.namespace : undefined;
		const sessionMode = details.sessionMode === "fresh" || details.sessionMode === "auto" ? details.sessionMode : undefined;
		const usedImplicitSession = details.usedImplicitSession === true;
		const explicitSessionName = extractExplicitSessionName(args);
		const outcome = getManagedSessionOutcome(details);
		const outcomeSucceeded = outcome?.succeeded === true;
		const outcomeStatus = typeof outcome?.status === "string" ? outcome.status : undefined;
		const outcomeCurrentSessionName = typeof outcome?.currentSessionName === "string" ? outcome.currentSessionName : undefined;
		const outcomeAttemptedSessionName = typeof outcome?.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
		if (outcomeSucceeded && outcome.activeAfter === true && (outcomeStatus === "created" || outcomeStatus === "replaced" || outcomeStatus === "unchanged")) {
			setBranchManagedSessionActive(events, outcomeCurrentSessionName, namespace, eventRank);
		}
		if (outcomeSucceeded && outcomeStatus === "closed") {
			setBranchRankForString(events.managedSessionCloseRanks, getSessionContextKey(outcomeAttemptedSessionName ?? outcomeCurrentSessionName ?? sessionName, namespace), eventRank);
		}
		if (outcome && outcomeStatus === "replaced" && outcome.replacedSessionClosed !== false) {
			const replacedSessionNamespace = typeof outcome.replacedSessionNamespace === "string" ? outcome.replacedSessionNamespace : namespace;
			setBranchRankForString(events.managedSessionCloseRanks, getSessionContextKey(typeof outcome.replacedSessionName === "string" ? outcome.replacedSessionName : undefined, replacedSessionNamespace), eventRank);
		}
		if (succeeded && !isCloseCommand(command) && sessionName && (usedImplicitSession || sessionMode === "fresh" || details.managedSessionHeadedAutosaveDisabled === true || typeof details.managedSessionHeadedAutosaveInterval === "string")) {
			setBranchManagedSessionActive(events, sessionName, namespace, eventRank);
		}
		if (succeeded && isCloseCommand(command)) {
			setBranchRankForString(events.managedSessionCloseRanks, getSessionContextKey(explicitSessionName ?? sessionName ?? outcomeAttemptedSessionName ?? outcomeCurrentSessionName, namespace), eventRank);
		}

		const electron = isRecord(details.electron) ? details.electron : undefined;
		const launch = electron && isElectronLaunchRecord(electron.launch) ? electron.launch : undefined;
		if (launch && getActiveElectronRecords(new Map([[launch.launchId, launch]])).length > 0) {
			events.electronLaunchActiveRanks.set(launch.launchId, eventRank);
		}
		const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
		const cleanupRecords = Array.isArray(cleanup?.records) ? cleanup.records : [];
		for (const cleanupRecord of cleanupRecords) {
			if (isElectronLaunchRecord(cleanupRecord)) events.electronLaunchCleanupRanks.set(cleanupRecord.launchId, eventRank);
		}
		const cleanupResults = Array.isArray(cleanup?.results) ? cleanup.results : [];
		for (const cleanupResult of cleanupResults) {
			if (isRecord(cleanupResult) && isElectronLaunchRecord(cleanupResult.record)) {
				events.electronLaunchCleanupRanks.set(cleanupResult.record.launchId, eventRank);
			}
			for (const closedSessionName of getCleanupResultClosedManagedSessionNames(cleanupResult)) {
				events.managedSessionCloseRanks.set(closedSessionName, eventRank);
			}
		}
	}
	return events;
}

function getCleanupResultsPreservedUserDataDirs(cleanupResults: unknown[]): string[] {
	const userDataDirs = new Set<string>();
	for (const result of cleanupResults) {
		if (!isRecord(result) || !Array.isArray(result.steps) || !isElectronLaunchRecord(result.record)) continue;
		const userDataDirStep = result.steps.find((step) => isRecord(step) && step.resource === "user-data-dir");
		if (!isRecord(userDataDirStep)) continue;
		if (userDataDirStep.state === "skipped" || userDataDirStep.state === "failed") userDataDirs.add(result.record.userDataDir);
	}
	return [...userDataDirs];
}

function syncElectronCleanupManagedSessions(sessions: Map<string, OwnedManagedSession>, cleanupResults: unknown[]): void {
	for (const sessionName of getCleanupResultsClosedManagedSessionNames(cleanupResults)) {
		untrackOwnedManagedSession(sessions, sessionName);
	}
}

async function closeOwnedManagedSessionsExcept(sessions: Map<string, OwnedManagedSession>, restoreState: ManagedSessionRestoreState, keepSessionName: string | undefined, timeoutMs: number, attachedSessionKeys: ReadonlySet<string>, keepNamespace?: string): Promise<void> {
	const keepKey = getSessionContextKey(keepSessionName, keepNamespace);
	for (const [key, owner] of [...sessions]) {
		if (key === keepKey) continue;
		const error = await closeManagedSession({ cwd: owner.cwd, headedManagedAutosaveInterval: owner.headedManagedAutosaveInterval, namespace: owner.namespace, preserveAttachedBrowserSession: attachedSessionKeys.has(key), restoreState, sessionName: owner.sessionName, timeoutMs });
		if (!error) sessions.delete(key);
	}
}

async function closeOwnedManagedSessions(sessions: Map<string, OwnedManagedSession>, restoreState: ManagedSessionRestoreState, timeoutMs: number, attachedSessionKeys: ReadonlySet<string>): Promise<void> {
	await closeOwnedManagedSessionsExcept(sessions, restoreState, undefined, timeoutMs, attachedSessionKeys);
}

function getOffBranchOwnedElectronLaunchRecords(ownedRecords: Map<string, ElectronLaunchRecord>, branchRecords: Map<string, ElectronLaunchRecord>): Map<string, ElectronLaunchRecord> {
	const activeBranchLaunchIds = new Set(getActiveElectronRecords(branchRecords).map((record) => record.launchId));
	const offBranchRecords = new Map<string, ElectronLaunchRecord>();
	for (const record of getActiveElectronRecords(ownedRecords)) {
		if (!activeBranchLaunchIds.has(record.launchId)) offBranchRecords.set(record.launchId, record);
	}
	return offBranchRecords;
}

function shouldSerializeBrowserCommand(options: {
	explicitNamespace?: string;
	explicitSessionName?: string;
	managedSessionName: string;
	ownedElectronLaunchRecords: Map<string, ElectronLaunchRecord>;
	ownedManagedSessions: Map<string, OwnedManagedSession>;
}): boolean {
	if (!options.explicitSessionName) return true;
	if (options.explicitSessionName === options.managedSessionName) return true;
	if (options.ownedManagedSessions.has(getSessionContextKey(options.explicitSessionName, options.explicitNamespace) ?? options.explicitSessionName)) return true;
	return getActiveElectronRecords(options.ownedElectronLaunchRecords).some((record) => record.sessionName === options.explicitSessionName);
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

class KeyedAsyncExecutionQueue {
	private readonly entries = new Map<string, { queue: AsyncExecutionQueue; users: number }>();

	async run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const entry = this.entries.get(key) ?? { queue: new AsyncExecutionQueue(), users: 0 };
		entry.users += 1;
		this.entries.set(key, entry);
		try {
			return await entry.queue.run(work);
		} finally {
			entry.users -= 1;
			if (entry.users === 0 && this.entries.get(key) === entry) this.entries.delete(key);
		}
	}
}

function mergeBrowserRunMap<K, V>(current: Map<K, V>, initial: Map<K, V>, updated: Map<K, V>): Map<K, V> {
	if (updated === initial) return current;
	const merged = new Map(current);
	for (const [key, value] of updated) {
		if (!initial.has(key) || initial.get(key) !== value) merged.set(key, value);
	}
	for (const key of initial.keys()) {
		if (!updated.has(key)) merged.delete(key);
	}
	return merged;
}

function mergeBrowserRunArtifactManifest(
	current: SessionArtifactManifest | undefined,
	initial: SessionArtifactManifest | undefined,
	updated: SessionArtifactManifest | undefined,
): SessionArtifactManifest | undefined {
	if (!updated || updated === initial) return current;
	const initialEntries = new Map((initial?.entries ?? []).map((entry) => [getSessionArtifactManifestEntryKey(entry), entry]));
	const changedEntries = updated.entries.filter((entry) => initialEntries.get(getSessionArtifactManifestEntryKey(entry)) !== entry);
	return changedEntries.length === 0
		? current
		: mergeSessionArtifactManifest({
			base: current,
			entries: changedEntries,
			nowMs: Math.max(Date.now(), (current?.updatedAtMs ?? 0) + 1, updated.updatedAtMs),
		});
}

function findPackageRoot(startDir: string): string {
	let currentDir = startDir;
	while (true) {
		const packageJsonPath = join(currentDir, "package.json");
		if (existsSync(packageJsonPath)) {
			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
			if (packageJson.name === "pi-agent-browser-native") return currentDir;
		}
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return startDir;
		currentDir = parentDir;
	}
}

function getInstalledDocsPaths(): { readmePath: string; commandReferencePath: string; toolContractPath: string } {
	const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
	return {
		readmePath: join(packageRoot, "README.md"),
		commandReferencePath: join(packageRoot, "docs", "COMMAND_REFERENCE.md"),
		toolContractPath: join(packageRoot, "docs", "TOOL_CONTRACT.md"),
	};
}

function hasArgvFlag(argv: readonly string[], longFlag: string, shortFlag: string): boolean {
	return argv.includes(longFlag) || argv.includes(shortFlag);
}

function shouldIncludeProjectConfig(ctx: { isProjectTrusted?: () => boolean } | undefined, argv: readonly string[] = process.argv): boolean {
	if (hasArgvFlag(argv, "--no-approve", "-na")) return false;
	return ctx?.isProjectTrusted?.() ?? true;
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	const ephemeralSessionSeed = createEphemeralSessionSeed();
	const agentBrowserConfig = loadAgentBrowserConfigSync({
		cwd: process.cwd(),
		includeProjectConfig: false,
	});
	const webSearchToolAvailable = canRegisterWebSearchTool(agentBrowserConfig);
	const toolPromptGuidelines = buildToolPromptGuidelines({
		browserDefaultProfile: agentBrowserConfig.trustedBrowserDefaultProfile,
		browserExecutablePath: agentBrowserConfig.trustedBrowserExecutablePath,
		includeWebSearch: webSearchToolAvailable,
		docs: getInstalledDocsPaths(),
	});
	const implicitSessionIdleTimeoutMs = String(getImplicitSessionIdleTimeoutMs());
	const implicitSessionCloseTimeoutMs = getImplicitSessionCloseTimeoutMs();
	let webSearchToolRegistered = false;
	let managedSessionActive = false;
	let managedSessionBaseName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);
	let managedSessionCompatibilityWorkaround: CompatibilityWorkaround | undefined;
	let managedSessionHeadedAutosaveDisabled = false;
	let managedSessionHeadedAutosaveInterval: string | undefined;
	let managedSessionName = managedSessionBaseName;
	let managedSessionCwd = process.cwd();
	let managedSessionNamespace: string | undefined;
	let freshSessionOrdinal = 0;
	let sessionPageState = new SessionPageState();
	let traceOwners = new Map<string, TraceOwner>();
	let artifactManifest: SessionArtifactManifest | undefined;
	let allowedDomainsBySession = new Map<string, AllowedDomainsPolicy>();
	let attachedSessionKeys = new Set<string>();
	let networkRoutesBySession = new Map<string, NetworkRouteRecord[]>();
	let electronLaunchRecords = new Map<string, ElectronLaunchRecord>();
	let ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
	let branchOwnedElectronLaunchIds = new Set<string>();
	let electronChildProcesses = new Map<string, ChildProcess>();
	const managedSessionRestoreState = new ManagedSessionRestoreState();
	const ownedManagedSessions = new Map<string, OwnedManagedSession>();
	const managedSessionExecutionQueue = new AsyncExecutionQueue();
	const callerOwnedSessionExecutionQueues = new KeyedAsyncExecutionQueue();
	const activeScriptControllers = new Set<AbortController>();
	const activeScriptExecutions = new Set<Promise<void>>();
	let branchRestoreGeneration = 0;
	let branchStateGeneration = 0;
	const validatedUpstreamPathKeys = new Set<string>();

	const validateUpstreamVersion = async (cwd: string, signal?: AbortSignal): Promise<AgentBrowserToolResult | undefined> => {
		const processEnvironment = getAgentBrowserProcessEnvironment();
		const pathKey = `${cwd}\0${processEnvironment.PATH ?? processEnvironment.Path ?? ""}`;
		if (validatedUpstreamPathKeys.has(pathKey)) return undefined;
		const probe = await runAgentBrowserProcess({ args: ["--version"], cwd, signal, timeoutMs: 5_000 });
		if ((probe.spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || probe.exitCode === 127 || probe.aborted) return undefined;
		let error: string | undefined;
		let observedVersion: string | undefined;
		if (probe.spawnError || probe.exitCode !== 0) {
			const detail = redactSensitiveText(probe.spawnError?.message ?? (probe.stderr.trim() || `exit ${probe.exitCode}`));
			error = `agent-browser --version could not be validated (${detail}). Run pi-agent-browser-doctor before browser-backed calls.`;
		} else {
			observedVersion = parseAgentBrowserVersionOutput(probe.stdout);
			error = getAgentBrowserVersionValidationError(probe.stdout);
		}
		if (!error) {
			validatedUpstreamPathKeys.add(pathKey);
			return undefined;
		}
		return {
			content: [{ type: "text", text: error }],
			details: {
				expectedVersion: TARGET_AGENT_BROWSER_VERSION,
				failureCategory: "validation-error",
				observedVersion,
				resultCategory: "failure",
				versionValidation: { expected: TARGET_AGENT_BROWSER_VERSION_LABEL, observed: observedVersion },
			},
			isError: true,
		};
	};

	const clearSessionScopedBrowserState = (sessionName: string, namespace?: string): void => {
		const key = getSessionContextKey(sessionName, namespace) ?? sessionName;
		allowedDomainsBySession = new Map(allowedDomainsBySession);
		allowedDomainsBySession.delete(key);
		attachedSessionKeys.delete(key);
		networkRoutesBySession = new Map(networkRoutesBySession);
		networkRoutesBySession.delete(key);
		traceOwners.delete(key);
		sessionPageState.clearSession(key);
	};

	const closeScriptSessionLeaseWithinQueue = async (sessionName: string, cwd: string): Promise<string | undefined> => {
		const closeError = await withIsolatedAgentBrowserEnvironment(() => closeManagedSession({
			cwd,
			namespace: AGENT_BROWSER_SCRIPT_NAMESPACE,
			restoreState: managedSessionRestoreState,
			sessionName,
			timeoutMs: implicitSessionCloseTimeoutMs,
		}));
		if (closeError) {
			try {
				appendScriptSessionLease(pi, sessionName, "failed");
			} catch {}
			return redactSensitiveText(closeError);
		}
		try {
			appendScriptSessionLease(pi, sessionName, "closed");
		} catch {
			managedSessionRestoreState.disable(sessionName);
			return "The isolated session closed, but its durable cleanup record could not be saved.";
		}
		untrackOwnedManagedSession(ownedManagedSessions, sessionName);
		managedSessionRestoreState.clear(sessionName);
		clearSessionScopedBrowserState(sessionName);
		return undefined;
	};

	const recoverScriptSessionLeasesWithinQueue = async (ctx: ExtensionContext): Promise<void> => {
		const pendingSessionNames = new Set(
			[...ownedManagedSessions.values()]
				.map((session) => session.sessionName)
				.filter(isAgentBrowserScriptSessionName),
		);
		for (const lease of getScriptSessionLeasesFromBranch(ctx.sessionManager.getBranch()).values()) {
			if (lease.cleanup !== "closed") pendingSessionNames.add(lease.sessionName);
		}
		for (const sessionName of pendingSessionNames) {
			trackOwnedManagedSession(ownedManagedSessions, sessionName, ctx.cwd, { branchOwned: true });
			managedSessionRestoreState.disable(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
			await closeScriptSessionLeaseWithinQueue(sessionName, ctx.cwd);
		}
	};

	const restoreBranchBackedState = (ctx: ExtensionContext, options: { resetRuntimeOwnership: boolean }): void => {
		branchRestoreGeneration += 1;
		branchStateGeneration += 1;
		const previousManagedSessionActive = managedSessionActive;
		const previousManagedSessionName = managedSessionName;
		const previousFreshSessionOrdinal = freshSessionOrdinal;
		const previousAttachedSessionKeys = attachedSessionKeys;
		managedSessionBaseName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
		const branch = ctx.sessionManager.getBranch();
		const branchResourceEvents = collectBranchManagedResourceEvents(branch);
		const restoredState = restoreManagedSessionStateFromBranch(branch, managedSessionBaseName);
		managedSessionRestoreState.replace(restoredState.managedSessionRestoreDisabledIdentities, {
			preserveDaemonRestoreKeys: !options.resetRuntimeOwnership,
		});
		managedSessionActive = restoredState.active;
		const restoredFreshSessionOrdinal = options.resetRuntimeOwnership
			? restoredState.freshSessionOrdinal
			: Math.max(previousFreshSessionOrdinal, restoredState.freshSessionOrdinal);
		const shouldReservePostCloseSession = !restoredState.active && restoredState.closedSessionName === restoredState.sessionName;
		const alreadyReservedPostCloseSession = shouldReservePostCloseSession
			&& !options.resetRuntimeOwnership
			&& !previousManagedSessionActive
			&& previousFreshSessionOrdinal > restoredState.freshSessionOrdinal
			&& previousFreshSessionOrdinal === restoredFreshSessionOrdinal
			&& previousManagedSessionName === createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, restoredFreshSessionOrdinal);
		const nextFreshSessionOrdinal = shouldReservePostCloseSession && !alreadyReservedPostCloseSession
			? restoredFreshSessionOrdinal + 1
			: restoredFreshSessionOrdinal;
		managedSessionName = shouldReservePostCloseSession
			? alreadyReservedPostCloseSession
				? previousManagedSessionName
				: createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, nextFreshSessionOrdinal)
			: restoredState.sessionName;
		managedSessionNamespace = shouldReservePostCloseSession ? undefined : restoredState.namespace;
		managedSessionCompatibilityWorkaround = managedSessionActive
			? restoreManagedSessionCompatibilityWorkaroundFromBranch(branch, managedSessionName, managedSessionNamespace)
			: undefined;
		managedSessionHeadedAutosaveDisabled = managedSessionActive
			&& restoreManagedSessionHeadedAutosaveDisabledFromBranch(branch, managedSessionName, managedSessionNamespace);
		managedSessionHeadedAutosaveInterval = managedSessionActive
			? restoreManagedSessionHeadedAutosaveIntervalFromBranch(branch, managedSessionName, managedSessionNamespace)
			: undefined;
		managedSessionCwd = ctx.cwd;
		freshSessionOrdinal = nextFreshSessionOrdinal;
		sessionPageState = SessionPageState.fromBranch(branch);
		traceOwners = new Map<string, TraceOwner>();
		artifactManifest = restoreArtifactManifestFromBranch(branch);
		allowedDomainsBySession = restoreAllowedDomainsBySessionFromBranch(branch);
		attachedSessionKeys = restoreAttachedSessionKeysFromBranch(branch);
		networkRoutesBySession = new Map<string, NetworkRouteRecord[]>();
		electronLaunchRecords = restoreElectronLaunchRecordsFromBranch(branch);
		for (const record of getActiveElectronRecords(electronLaunchRecords)) {
			if (record.sessionName) attachedSessionKeys.add(getSessionContextKey(record.sessionName) ?? record.sessionName);
		}
		if (options.resetRuntimeOwnership) {
			ownedManagedSessions.clear();
			ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
			branchOwnedElectronLaunchIds = new Set<string>();
		} else {
			for (const [sessionName, closeRank] of branchResourceEvents.managedSessionCloseRanks) {
				untrackOwnedManagedSessionFromBranchClose(
					ownedManagedSessions,
					sessionName,
					branchResourceEvents.managedSessionActiveRanks.get(sessionName),
					closeRank,
				);
			}
			removeInactiveOwnedElectronLaunchRecords(
				ownedElectronLaunchRecords,
				branchOwnedElectronLaunchIds,
				electronLaunchRecords,
				branchResourceEvents.electronLaunchActiveRanks,
				branchResourceEvents.electronLaunchCleanupRanks,
			);
		}
		for (const [sessionKey, identity] of branchResourceEvents.managedSessionActiveIdentities) {
			const activeRank = branchResourceEvents.managedSessionActiveRanks.get(sessionKey);
			const closeRank = branchResourceEvents.managedSessionCloseRanks.get(sessionKey);
			if (activeRank === undefined || (closeRank !== undefined && closeRank >= activeRank)) continue;
			if (!isRestorableManagedSessionName(identity.sessionName, managedSessionBaseName)) continue;
			trackOwnedManagedSession(ownedManagedSessions, identity.sessionName, ctx.cwd, {
				branchOwned: true,
				headedManagedAutosaveDisabled: restoreManagedSessionHeadedAutosaveDisabledFromBranch(branch, identity.sessionName, identity.namespace),
				headedManagedAutosaveInterval: restoreManagedSessionHeadedAutosaveIntervalFromBranch(branch, identity.sessionName, identity.namespace),
				namespace: identity.namespace,
			});
		}
		if (restoredState.active) {
			trackOwnedManagedSession(ownedManagedSessions, restoredState.sessionName, ctx.cwd, {
				branchOwned: true,
				headedManagedAutosaveDisabled: managedSessionHeadedAutosaveDisabled,
				headedManagedAutosaveInterval: managedSessionHeadedAutosaveInterval,
				namespace: restoredState.namespace,
			});
		}
		for (const record of getActiveElectronRecords(electronLaunchRecords)) {
			if (!record.sessionName || !isRestorableManagedSessionName(record.sessionName, managedSessionBaseName)) continue;
			const sessionKey = getSessionContextKey(record.sessionName) ?? record.sessionName;
			const activeRank = branchResourceEvents.managedSessionActiveRanks.get(sessionKey);
			const closeRank = branchResourceEvents.managedSessionCloseRanks.get(sessionKey);
			if (activeRank === undefined || (closeRank !== undefined && closeRank >= activeRank)) continue;
			trackOwnedManagedSession(ownedManagedSessions, record.sessionName, ctx.cwd, {
				branchOwned: true,
				headedManagedAutosaveDisabled: restoreManagedSessionHeadedAutosaveDisabledFromBranch(branch, record.sessionName),
				headedManagedAutosaveInterval: restoreManagedSessionHeadedAutosaveIntervalFromBranch(branch, record.sessionName),
			});
		}
		mergeActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronLaunchRecords, {
			branchOwnedLaunchIds: branchOwnedElectronLaunchIds,
			markBranchOwned: true,
		});
		if (!options.resetRuntimeOwnership) {
			for (const sessionKey of previousAttachedSessionKeys) {
				if (ownedManagedSessions.has(sessionKey)) attachedSessionKeys.add(sessionKey);
			}
			for (const record of ownedElectronLaunchRecords.values()) {
				const sessionKey = getSessionContextKey(record.sessionName);
				if (sessionKey && previousAttachedSessionKeys.has(sessionKey)) attachedSessionKeys.add(sessionKey);
			}
		}
	};

	const registerWebSearchToolIfAvailable = (configState: typeof agentBrowserConfig) => {
		if (webSearchToolRegistered || !canRegisterWebSearchTool(configState)) return;
		pi.registerTool(createAgentBrowserWebSearchTool(configState, {
			loadConfigState(ctx) {
				return loadAgentBrowserConfigSync({
					cwd: ctx.cwd,
					includeProjectConfig: shouldIncludeProjectConfig(ctx),
				});
			},
		}));
		webSearchToolRegistered = true;
	};

	pi.on("session_start", async (_event, ctx) => {
		restoreBranchBackedState(ctx, { resetRuntimeOwnership: true });
		electronChildProcesses = new Map<string, ChildProcess>();
		registerWebSearchToolIfAvailable(loadAgentBrowserConfigSync({
			cwd: ctx.cwd,
			includeProjectConfig: shouldIncludeProjectConfig(ctx),
		}));
		await managedSessionExecutionQueue.run(() => recoverScriptSessionLeasesWithinQueue(ctx));
	});

	pi.on("session_tree", async (_event, ctx) => {
		for (const controller of activeScriptControllers) controller.abort();
		await Promise.allSettled([...activeScriptExecutions]);
		await managedSessionExecutionQueue.run(async () => {
			restoreBranchBackedState(ctx, { resetRuntimeOwnership: false });
			await recoverScriptSessionLeasesWithinQueue(ctx);
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		for (const controller of activeScriptControllers) controller.abort();
		await Promise.allSettled([...activeScriptExecutions]);
		branchRestoreGeneration += 1;
		branchStateGeneration += 1;
		let preservedElectronProfileDirs: string[] = [];
		await managedSessionExecutionQueue.run(async () => {
			const shutdownCwd = ctx?.cwd ?? managedSessionCwd;
			const quitting = event?.reason === "quit";
			preservedElectronProfileDirs = quitting
				? []
				: getActiveElectronRecords(electronLaunchRecords).map((record) => record.userDataDir);
			const electronRecordsToCleanup = quitting
				? ownedElectronLaunchRecords
				: getOffBranchOwnedElectronLaunchRecords(ownedElectronLaunchRecords, electronLaunchRecords);
			const electronCleanupResults = await cleanupActiveElectronHostLaunches({
				attachedSessionKeys,
				cwd: shutdownCwd,
				electronChildProcesses,
				electronLaunchRecords: electronRecordsToCleanup,
				managedSessionRestoreState,
				ownedManagedSessions,
				timeoutMs: implicitSessionCloseTimeoutMs,
			});
			preservedElectronProfileDirs = [...new Set([
				...preservedElectronProfileDirs,
				...getCleanupResultsPreservedUserDataDirs(electronCleanupResults),
			])];
			syncElectronCleanupManagedSessions(ownedManagedSessions, electronCleanupResults);
			if (quitting) {
				await closeOwnedManagedSessions(ownedManagedSessions, managedSessionRestoreState, implicitSessionCloseTimeoutMs, attachedSessionKeys);
			} else {
				await closeOwnedManagedSessionsExcept(
					ownedManagedSessions,
					managedSessionRestoreState,
					managedSessionActive ? managedSessionName : undefined,
					implicitSessionCloseTimeoutMs,
					attachedSessionKeys,
					managedSessionActive ? managedSessionNamespace : undefined,
				);
			}
		});
		managedSessionActive = false;
		managedSessionCompatibilityWorkaround = undefined;
		managedSessionHeadedAutosaveDisabled = false;
		managedSessionHeadedAutosaveInterval = undefined;
		managedSessionNamespace = undefined;
		sessionPageState.reset();
		traceOwners = new Map<string, TraceOwner>();
		artifactManifest = undefined;
		allowedDomainsBySession = new Map<string, AllowedDomainsPolicy>();
		attachedSessionKeys = new Set<string>();
		networkRoutesBySession = new Map<string, NetworkRouteRecord[]>();
		electronLaunchRecords = new Map<string, ElectronLaunchRecord>();
		ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
		branchOwnedElectronLaunchIds = new Set<string>();
		electronChildProcesses = new Map<string, ChildProcess>();
		ownedManagedSessions.clear();
		cleanupManagedSessionRestoreConfig();
		await cleanupSecureTempArtifacts({ preservePaths: preservedElectronProfileDirs });
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!shouldAppendBrowserSystemPrompt(event.prompt)) {
			return undefined;
		}
		const runtimeConfig = loadAgentBrowserConfigSync({
			cwd: ctx.cwd,
			includeProjectConfig: shouldIncludeProjectConfig(ctx),
		});
		const browserGuidance = [
			runtimeConfig.browserExecutablePathScope === "project"
				? buildBrowserExecutablePathGuideline(runtimeConfig.browserExecutablePath)
				: undefined,
			runtimeConfig.browserDefaultProfileScope === "project"
				? buildBrowserDefaultProfileGuideline(runtimeConfig.browserDefaultProfile)
				: undefined,
		].filter((line): line is string => typeof line === "string" && line.length > 0);
		const runtimeConfigPrompt = browserGuidance.length > 0
			? `\n\nProject agent_browser config guidance:\n${browserGuidance.map((line) => `- ${line}`).join("\n")}`
			: "";
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PROJECT_RULE_PROMPT}${runtimeConfigPrompt}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
		if (
			isBashToolCallEvent(event) &&
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

	pi.on("tool_result", async (event) => buildAgentBrowserToolResultPatch(event));

	const agentBrowserTool = {
		name: "agent_browser",
		label: "Agent Browser",
		description:
			"Browse and interact with websites using agent-browser. Use this for web research, reading live docs, opening pages, taking snapshots or screenshots, clicking links, filling forms, extracting page content, and authenticated/profile-based browser work. Input choice: `script` for one-shot JavaScript orchestration; default `args` for open → snapshot -i → click/fill @refs; `semanticAction` for stable role/text/label targets; `job` or `qa` for multi-step checks; `electron` only for desktop apps; experimental `sourceLookup` / `networkSourceLookup` for candidates only.",
		promptSnippet:
			"Browse websites, read live docs, click and fill pages, extract browser content, take screenshots, and automate real web workflows.",
		promptGuidelines: toolPromptGuidelines,
		parameters: AGENT_BROWSER_PARAMS,
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatAgentBrowserRenderCall(args, theme, context.expanded));
			return text;
		},
		renderResult(result, options, theme, context) {
			const component = context.lastComponent instanceof AgentBrowserResultComponent
				? context.lastComponent
				: new AgentBrowserResultComponent();
			component.setState(formatAgentBrowserRenderResult(result, options, theme, context.isError), options.expanded, theme);
			return component;
		},
		async execute(toolCallId, params: AgentBrowserExecuteParams, signal, onUpdate, ctx) {
			const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
			const outputPath = isRecord(params) && typeof params.outputPath === "string" ? params.outputPath : undefined;
			const resolvedInput = resolveAgentBrowserInput({
                getBatchPreflightValidationError: (args, stdin) => getBatchPreflightValidationError(args, stdin, ctx.cwd),
                managedSessionActive,
				params,
			});
			if (resolvedInput.status === "invalid") {
				return buildValidationFailureResult(resolvedInput);
			}
			const outputPathValidationError = getAgentBrowserOutputPathValidationError(outputPath, ctx.cwd);
			if (outputPathValidationError) {
				return buildValidationFailureResult({ attemptedKind: resolvedInput.kind, kind: "invalid", redactedArgs: resolvedInput.redactedArgs, status: "invalid", toolArgs: resolvedInput.toolArgs, toolStdin: resolvedInput.toolStdin, validationError: outputPathValidationError });
			}
			const versionCheckCommand = extractCommandTokens(resolvedInput.toolArgs)[0];
			const electronHostOnlyAction = resolvedInput.kind === "electron" && ["cleanup", "list", "status"].includes(resolvedInput.compiledElectron.action);
			const browserBackedVersionCheck = needsManagedSession(parseArgvDescriptor(resolvedInput.toolArgs));
			if (!electronHostOnlyAction && browserBackedVersionCheck && !isPlainTextInspectionArgs(resolvedInput.toolArgs) && !isCloseCommand(versionCheckCommand) && signal?.aborted !== true) {
				const versionFailure = resolvedInput.kind === "script"
					? await withIsolatedAgentBrowserEnvironment(() => validateUpstreamVersion(ctx.cwd, signal))
					: await validateUpstreamVersion(ctx.cwd, signal);
				if (versionFailure) return applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, result: versionFailure });
			}
			if (resolvedInput.kind === "script") {
				if (!ctx.sessionManager.getSessionFile()) {
					return buildValidationFailureResult({
						attemptedKind: "script",
						kind: "invalid",
						redactedArgs: [],
						status: "invalid",
						toolArgs: [],
						validationError: "script requires a persisted Pi session so its isolated browser-session cleanup lease survives restart; relaunch Pi without --no-session.",
					});
				}
				const sessionName = createAgentBrowserScriptSessionName();
				const innerResults: AgentBrowserToolResult[] = [];
				const scriptTimeoutMs = params.timeoutMs ?? AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS;
				const deadline = Date.now() + scriptTimeoutMs;
				let leased = false;
				let cleanupError: string | undefined;
				let run: AgentBrowserScriptRunResult = {
					callCount: 0,
					emitCount: 0,
					error: "Script sandbox execution failed.",
					failureCategory: "upstream-error",
					ok: false,
					rejectedCallCount: 0,
					steps: [],
				};
				const scriptController = new AbortController();
				const abortScript = () => scriptController.abort();
				signal?.addEventListener("abort", abortScript, { once: true });
				if (signal?.aborted) scriptController.abort();
				activeScriptControllers.add(scriptController);
				let finishScriptExecution!: () => void;
				const scriptExecution = new Promise<void>((resolve) => {
					finishScriptExecution = resolve;
				});
				activeScriptExecutions.add(scriptExecution);
				try {
					const pendingRun = runAgentBrowserScript({
						beforeFirstCall() {
							appendScriptSessionLease(pi, sessionName, "active");
							trackOwnedManagedSession(ownedManagedSessions, sessionName, ctx.cwd);
							managedSessionRestoreState.disable(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
							leased = true;
						},
						code: resolvedInput.compiledScript.code,
						dispatch: async (innerParams, innerSignal) => {
							const remainingMs = Math.max(1, deadline - Date.now());
							const innerTimeoutMs = Math.min(innerParams.timeoutMs ?? remainingMs, remainingMs);
							const innerResult = await withIsolatedAgentBrowserEnvironment(() => agentBrowserTool.execute(
								`${toolCallId}:script:${innerResults.length + 1}`,
								{
									args: ["--namespace", AGENT_BROWSER_SCRIPT_NAMESPACE, "--session", sessionName, ...innerParams.args],
									stdin: innerParams.stdin,
									timeoutMs: innerTimeoutMs,
								},
								innerSignal,
								undefined,
								ctx,
							)) as AgentBrowserToolResult;
							innerResults.push(innerResult);
							return await buildScriptBrowserEnvelope(innerResult, innerParams.args, sessionName);
						},
						signal: scriptController.signal,
						timeoutMs: scriptTimeoutMs,
					});
					run = await pendingRun;
				} catch {} finally {
					activeScriptControllers.delete(scriptController);
					signal?.removeEventListener("abort", abortScript);
					if (leased) {
						try {
							cleanupError = await managedSessionExecutionQueue.run(() => closeScriptSessionLeaseWithinQueue(sessionName, ctx.cwd));
						} catch {
							cleanupError = "The isolated script session cleanup operation failed.";
							try {
								appendScriptSessionLease(pi, sessionName, "failed");
							} catch {}
						}
					}
					activeScriptExecutions.delete(scriptExecution);
					finishScriptExecution();
				}
				const scriptResult = buildScriptToolResult({ cleanupError, innerResults, run, sessionName: leased ? sessionName : undefined });
				return applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, result: scriptResult });
			}
			const { toolArgs } = resolvedInput;
			const compiledElectron = resolvedInput.kind === "electron" ? resolvedInput.compiledElectron : undefined;
			const redactedCompiledElectron = resolvedInput.kind === "electron" ? resolvedInput.redactedCompiledElectron : undefined;
			const runElectronHostInput = async () => {
				const electronHostLaunchRecords = getElectronHostLaunchRecordsForInput({
					branchRecords: electronLaunchRecords,
					compiledElectron,
					ownedRecords: ownedElectronLaunchRecords,
				});
				const electronHostResult = await handleElectronHostInput({
					attachedSessionKeys,
					compiledElectron,
					cwd: ctx.cwd,
					electronChildProcesses,
					electronLaunchRecords: electronHostLaunchRecords,
					implicitSessionCloseTimeoutMs,
					managedSessionActive,
					managedSessionName,
					managedSessionNamespace,
					managedSessionRestoreState,
					ownedManagedSessions,
					redactedCompiledElectron,
					sessionPageState,
					signal,
				});
				if (electronHostResult && compiledElectron?.action === "cleanup") {
					branchStateGeneration += 1;
					const cleanupRecords = isRecord(electronHostResult.details)
						&& isRecord(electronHostResult.details.electron)
						&& isRecord(electronHostResult.details.electron.cleanup)
						&& Array.isArray(electronHostResult.details.electron.cleanup.results)
						? electronHostResult.details.electron.cleanup.results
						: [];
					const cleanedLaunchIds = new Set<string>();
					for (const cleanupResult of cleanupRecords) {
						if (isRecord(cleanupResult) && isElectronLaunchRecord(cleanupResult.record)) {
							cleanedLaunchIds.add(cleanupResult.record.launchId);
						}
					}
					replaceWithActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronHostLaunchRecords, branchOwnedElectronLaunchIds, cleanedLaunchIds);
					mergeElectronCleanupRecords(electronLaunchRecords, cleanupRecords);
					const closedSessionNames = getCleanupResultsClosedManagedSessionNames(cleanupRecords);
					syncElectronCleanupManagedSessions(ownedManagedSessions, cleanupRecords);
					for (const closedSessionName of closedSessionNames) {
						clearSessionScopedBrowserState(closedSessionName);
						if (closedSessionName === managedSessionName) {
							managedSessionActive = false;
							managedSessionCompatibilityWorkaround = undefined;
							managedSessionHeadedAutosaveDisabled = false;
							managedSessionHeadedAutosaveInterval = undefined;
							managedSessionNamespace = undefined;
							freshSessionOrdinal += 1;
							managedSessionName = createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal);
						}
					}
				}
				return electronHostResult;
			};
			const electronHostResult = shouldSerializeElectronHostInput(compiledElectron)
				? await managedSessionExecutionQueue.run(runElectronHostInput)
				: await runElectronHostInput();
			if (electronHostResult) {
				return applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, result: electronHostResult });
			}

			const explicitSessionName = extractExplicitSessionName(toolArgs);
			const explicitNamespace = extractExplicitNamespace(toolArgs);
			const serializeBrowserCommand = shouldSerializeBrowserCommand({
				explicitNamespace,
				explicitSessionName,
				managedSessionName,
				ownedElectronLaunchRecords,
				ownedManagedSessions,
			});
			const callerOwnedSessionQueueKey = !serializeBrowserCommand && explicitSessionName
				? getSessionContextKey(explicitSessionName, resolveAgentBrowserNamespace(toolArgs, getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE)) ?? explicitSessionName
				: undefined;
			const runBrowserCommand = async () => {
				const branchRestoreGenerationAtStart = branchRestoreGeneration;
				const generationAtStart = branchStateGeneration;
				const sessionPageStateUpdate = sessionPageState.beginUpdate();
				const browserRunState: BrowserRunState = {
					allowedDomainsBySession,
					artifactManifest,
					attachedSessionKeys,
					closedManagedSessionNames: new Set<string>(),
					electronChildProcesses,
					electronLaunchRecords,
					ephemeralSessionSeed,
					freshSessionOrdinal,
					managedSessionActive,
					managedSessionBaseName,
					managedSessionCompatibilityWorkaround,
					managedSessionHeadedAutosaveDisabled,
					managedSessionHeadedAutosaveInterval,
					managedSessionCwd,
					managedSessionName,
					managedSessionNamespace,
					managedSessionRestoreState,
					networkRoutesBySession,
					ownedManagedSessions,
					sessionPageState,
					traceOwners,
				};
				const initialAllowedDomainsBySession = browserRunState.allowedDomainsBySession;
				const initialArtifactManifest = browserRunState.artifactManifest;
				const initialNetworkRoutesBySession = browserRunState.networkRoutesBySession;
				const attachedSessionRequested = isAttachedBrowserInvocation(toolArgs)
					|| (resolvedInput.kind === "electron" && resolvedInput.compiledElectron.action === "launch");
				const allocatesFreshManagedSession = explicitSessionName === undefined
					&& (params.sessionMode === "fresh" || (resolvedInput.kind === "electron" && resolvedInput.compiledElectron.action === "launch"));
				const reusableSessionKey = allocatesFreshManagedSession
					? undefined
					: callerOwnedSessionQueueKey ?? getSessionContextKey(browserRunState.managedSessionName, browserRunState.managedSessionNamespace);
				const attachedSessionKnown = reusableSessionKey !== undefined && attachedSessionKeys.has(reusableSessionKey);
				let result = await runAgentBrowserTool({
					ctx,
					cwd: ctx.cwd,
					electronPostCommandStatusSettleMs: ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
					electronProfileIsolationDetails: ELECTRON_PROFILE_ISOLATION_DETAILS,
					implicitSessionCloseTimeoutMs,
					implicitSessionIdleTimeoutMs,
					input: resolvedInput,
					onUpdate,
					params,
					establishAttachedBrowserSession: attachedSessionRequested && !attachedSessionKnown,
					preserveAttachedBrowserSession: attachedSessionRequested || attachedSessionKnown,
					promptPolicy,
					sessionPageStateUpdate,
					signal,
					state: browserRunState,
				});
				const branchRestoreStillCurrent = branchRestoreGenerationAtStart === branchRestoreGeneration;
				if (branchRestoreStillCurrent) {
					const resultDetails = isRecord(result.details) ? result.details : undefined;
					const resultSessionName = typeof resultDetails?.sessionName === "string"
						? resultDetails.sessionName
						: extractExplicitSessionName(toolArgs);
					const resultNamespace = typeof resultDetails?.namespace === "string"
						? resultDetails.namespace
						: resolveAgentBrowserNamespace(toolArgs, getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE);
					const resultSessionKey = getSessionContextKey(resultSessionName, resultNamespace) ?? resultSessionName;
					const managedSessionOutcome = isRecord(resultDetails?.managedSessionOutcome) ? resultDetails.managedSessionOutcome : undefined;
					const attachedSessionRemainsActive = result.isError !== true
						|| (attachedSessionRequested && managedSessionOutcome?.activeAfter === true);
					const closesAttachedSession = result.isError !== true && isCloseCommand(extractCommandTokens(toolArgs)[0]);
					if (resultSessionKey && closesAttachedSession) attachedSessionKeys.delete(resultSessionKey);
					else if (resultSessionKey && attachedSessionRemainsActive && (attachedSessionRequested || attachedSessionKnown)) {
						attachedSessionKeys.add(resultSessionKey);
						result = { ...result, details: { ...(resultDetails ?? {}), attachedBrowserSession: true } };
					}
				}
				if (branchRestoreStillCurrent) {
					allowedDomainsBySession = mergeBrowserRunMap(allowedDomainsBySession, initialAllowedDomainsBySession, browserRunState.allowedDomainsBySession);
					networkRoutesBySession = mergeBrowserRunMap(networkRoutesBySession, initialNetworkRoutesBySession, browserRunState.networkRoutesBySession);
					artifactManifest = mergeBrowserRunArtifactManifest(artifactManifest, initialArtifactManifest, browserRunState.artifactManifest);
					if (artifactManifest) {
						result = {
							...result,
							details: {
								...(isRecord(result.details) ? result.details : {}),
								artifactManifest,
								artifactRetentionSummary: formatSessionArtifactRetentionSummary(artifactManifest),
							},
						};
					}
				}
				const branchStateStillCurrent = generationAtStart === branchStateGeneration;
				if (serializeBrowserCommand || branchStateStillCurrent) {
					freshSessionOrdinal = Math.max(freshSessionOrdinal, browserRunState.freshSessionOrdinal);
					managedSessionActive = browserRunState.managedSessionActive;
					managedSessionCompatibilityWorkaround = browserRunState.managedSessionCompatibilityWorkaround;
					managedSessionHeadedAutosaveDisabled = browserRunState.managedSessionHeadedAutosaveDisabled === true;
					managedSessionHeadedAutosaveInterval = browserRunState.managedSessionHeadedAutosaveInterval;
					managedSessionCwd = browserRunState.managedSessionCwd;
					managedSessionName = browserRunState.managedSessionName;
					managedSessionNamespace = browserRunState.managedSessionNamespace;
					for (const closedSessionName of browserRunState.closedManagedSessionNames) {
						untrackOwnedManagedSession(ownedManagedSessions, closedSessionName);
					}
					syncOwnedManagedSessionsFromResult(ownedManagedSessions, result, browserRunState.managedSessionCwd);
					mergeActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronLaunchRecords, {
						branchOwnedLaunchIds: branchOwnedElectronLaunchIds,
						touchedLaunchIds: !result.isError
							? getTouchedElectronLaunchIds(explicitSessionName ?? browserRunState.managedSessionName, electronLaunchRecords)
							: undefined,
					});
					if (serializeBrowserCommand) branchStateGeneration += 1;
				}
				return applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, preserveTextContent: Array.isArray(params.args) && params.args.includes("--json"), result });
			};

			if (serializeBrowserCommand) return managedSessionExecutionQueue.run(runBrowserCommand);
			return callerOwnedSessionQueueKey
				? callerOwnedSessionExecutionQueues.run(callerOwnedSessionQueueKey, runBrowserCommand)
				: runBrowserCommand();
		},
	} satisfies ToolDefinition<typeof AGENT_BROWSER_PARAMS>;
	pi.registerTool(agentBrowserTool);

	registerWebSearchToolIfAvailable(agentBrowserConfig);
}
