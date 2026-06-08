/**
 * Purpose: Register the native agent_browser tool for pi so agents can invoke agent-browser without going through bash.
 * Responsibilities: Define the tool schema, inject thin wrapper behavior around the upstream CLI, manage extension-owned browser session convenience, and return pi-friendly content/details.
 * Scope: Native tool registration and orchestration only; the wrapper intentionally stays close to the upstream agent-browser CLI.
 * Usage: Loaded by pi through the package manifest in this package, or explicitly via `pi --no-extensions -e .` during local checkout development.
 * Invariants/Assumptions: agent-browser is installed separately on PATH, the wrapper targets the current locally installed upstream version only, and no backward-compatibility shims are provided.
 */

import type { ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	PROJECT_RULE_PROMPT,
	buildToolPromptGuidelines,
} from "./lib/playbook.js";
import {
	buildToolPresentation,
	type AgentBrowserEnvelope,
	type AgentBrowserPageChangeSummary,
} from "./lib/results.js";
import { SessionPageState } from "./lib/session-page-state.js";
import {
	buildExecutionPlan,
	createEphemeralSessionSeed,
	createFreshSessionName,
	createImplicitSessionName,
	extractCommandTokens,
	getImplicitSessionCloseTimeoutMs,
	getImplicitSessionIdleTimeoutMs,
	hasLaunchScopedTabCorrectionFlag,
	extractExplicitSessionName,
	restoreManagedSessionStateFromBranch,
	resolveManagedSessionState,
	validateToolArgs,
	type CompatibilityWorkaround,
} from "./lib/runtime.js";
import { isRecord } from "./lib/parsing.js";
import { buildPromptPolicy, getLatestUserPrompt, shouldAppendBrowserSystemPrompt } from "./lib/prompt-policy.js";
import { isCloseCommand } from "./lib/command-taxonomy.js";
import {
	cleanupSecureTempArtifacts,
	type PersistentSessionArtifactEviction,
	type PersistentSessionArtifactStore,
	writePersistentSessionArtifactFile,
	writeSecureTempFile,
} from "./lib/temp.js";
import {
	AGENT_BROWSER_PARAMS,
	analyzeNetworkSourceLookupResults,
	analyzeQaPresetResults,
	analyzeSourceLookupResults,
	compileAgentBrowserElectron,
	compileAgentBrowserJob,
	compileAgentBrowserNetworkSourceLookup,
	compileAgentBrowserQaPreset,
	compileAgentBrowserSemanticAction,
	compileAgentBrowserSourceLookup,
	getCompiledSemanticActionCommandIndex,
	getCompiledSemanticActionSessionPrefix,
	isCompiledSemanticActionFindCommand,
	redactNetworkSourceLookupAnalysis,
	redactNetworkSourceLookupSurface,
	type AgentBrowserNetworkSourceLookupAnalysis,
	type AgentBrowserQaPresetAnalysis,
	type AgentBrowserSourceLookupAnalysis,
	type AgentBrowserSourceLookupElectronContext,
	type CompiledAgentBrowserElectron,
	type CompiledAgentBrowserJob,
	type CompiledAgentBrowserNetworkSourceLookup,
	type CompiledAgentBrowserQaPreset,
	type CompiledAgentBrowserSemanticAction,
	type CompiledAgentBrowserSourceLookup,
} from "./lib/input-modes.js";
import { parseAllowedDomainsPolicyFromArgs, type AllowedDomainsPolicy } from "./lib/navigation-policy.js";
import { closeManagedSession, runAgentBrowserTool, type BrowserRunState, type TraceOwner } from "./lib/orchestration/browser-run.js";
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
import { applyAgentBrowserOutputPath } from "./lib/orchestration/output-file.js";
import type { NetworkRouteRecord } from "./lib/results/contracts.js";
import type { SessionArtifactManifest } from "./lib/results/contracts.js";
import {
	buildEvictedSessionArtifactEntries,
	formatSessionArtifactRetentionSummary,
	isSessionArtifactManifest,
	mergeSessionArtifactManifest,
} from "./lib/results/artifact-manifest.js";
import {
	buildRichInputRecoveryDiagnostic,
	buildRichInputRecoveryNextActions,
	buildVisibleRefFallbackDiagnosticFromSnapshot,
	buildVisibleRefFallbackNextActions,
	formatRichInputRecoveryText,
	formatVisibleRefFallbackText,
	getVisibleRefFallbackTarget,
	resolveVisibleRefActionFromSnapshot,
	sanitizeVisibleRefFallbackDiagnostic,
	type RichInputRecoveryDiagnostic,
	type VisibleRefFallbackDiagnostic,
} from "./lib/results/selector-recovery.js";
import { withOptionalSessionArgs } from "./lib/results/next-actions.js";
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

const DEFAULT_SESSION_MODE = "auto" as const;

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
};

// Event ranks are local to the branch being restored. Keep them out of owned-resource
// state so branch switches never compare unrelated branch histories.
interface BranchManagedResourceEvents {
	electronLaunchActiveRanks: Map<string, number>;
	electronLaunchCleanupRanks: Map<string, number>;
	managedSessionActiveRanks: Map<string, number>;
	managedSessionCloseRanks: Map<string, number>;
}

function getBatchPreflightValidationError(args: string[], stdin: string | undefined): string | undefined {
	const commandTokens = extractCommandTokens(args);
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return undefined;
	}
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return undefined;
	}
	for (const [index, step] of parsed.steps.entries()) {
		if (!Array.isArray(step) || !step.every((token) => typeof token === "string") || step.length === 0) continue;
		const stepValidationError = validateToolArgs(step);
		if (stepValidationError) return `Unsupported batch step ${index + 1}: ${stepValidationError}`;
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
		if (isSessionArtifactManifest(details?.artifactManifest)) {
			restoredManifest = details.artifactManifest;
		}
	}
	return restoredManifest;
}

function getToolResultArgs(details: Record<string, unknown>): string[] {
	if (Array.isArray(details.args) && details.args.every((arg) => typeof arg === "string")) return details.args;
	if (Array.isArray(details.effectiveArgs) && details.effectiveArgs.every((arg) => typeof arg === "string")) return details.effectiveArgs;
	return [];
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
		const explicitSessionName = extractExplicitSessionName(args);
		const outcome = getManagedSessionOutcome(details);
		const outcomeSucceeded = outcome?.succeeded === true;
		const outcomeStatus = typeof outcome?.status === "string" ? outcome.status : undefined;
		const outcomeCurrentSessionName = typeof outcome?.currentSessionName === "string" ? outcome.currentSessionName : undefined;
		const outcomeAttemptedSessionName = typeof outcome?.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
		if (outcomeSucceeded && outcomeStatus === "closed") {
			const closedSessionName = outcomeAttemptedSessionName ?? outcomeCurrentSessionName ?? sessionName;
			if (closedSessionName) restoredPolicies.delete(closedSessionName);
		}
		if (outcomeSucceeded && outcomeStatus === "replaced") {
			const replacedSessionName = typeof outcome.replacedSessionName === "string" ? outcome.replacedSessionName : undefined;
			if (replacedSessionName) restoredPolicies.delete(replacedSessionName);
		}
		if (succeeded && isCloseCommand(command)) {
			const closedSessionName = explicitSessionName ?? sessionName ?? outcomeAttemptedSessionName ?? outcomeCurrentSessionName;
			if (closedSessionName) restoredPolicies.delete(closedSessionName);
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
		const policy = (succeeded || outcomeKeepsSessionCurrent) && sessionName && !isCloseCommand(command) ? parseAllowedDomainsPolicyFromArgs(args) : undefined;
		if (policy && sessionName) restoredPolicies.set(sessionName, policy);
	}
	return restoredPolicies;
}

function trackOwnedManagedSession(
	sessions: Map<string, OwnedManagedSession>,
	sessionName: string | undefined,
	cwd: string,
	options: { branchOwned?: boolean } = {},
): void {
	if (!sessionName) return;
	const existing = sessions.get(sessionName);
	const branchOwned = existing && !existing.branchOwned ? false : options.branchOwned === true;
	sessions.set(sessionName, { branchOwned, cwd });
}

function untrackOwnedManagedSession(sessions: Map<string, OwnedManagedSession>, sessionName: string | undefined): void {
	if (sessionName) sessions.delete(sessionName);
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
		trackOwnedManagedSession(sessions, currentSessionName, cwd);
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

function collectBranchManagedResourceEvents(branch: unknown[]): BranchManagedResourceEvents {
	const events: BranchManagedResourceEvents = {
		electronLaunchActiveRanks: new Map<string, number>(),
		electronLaunchCleanupRanks: new Map<string, number>(),
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
		const sessionMode = details.sessionMode === "fresh" || details.sessionMode === "auto" ? details.sessionMode : undefined;
		const usedImplicitSession = details.usedImplicitSession === true;
		const explicitSessionName = extractExplicitSessionName(args);
		const outcome = getManagedSessionOutcome(details);
		const outcomeSucceeded = outcome?.succeeded === true;
		const outcomeStatus = typeof outcome?.status === "string" ? outcome.status : undefined;
		const outcomeCurrentSessionName = typeof outcome?.currentSessionName === "string" ? outcome.currentSessionName : undefined;
		const outcomeAttemptedSessionName = typeof outcome?.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
		if (outcomeSucceeded && outcome.activeAfter === true && (outcomeStatus === "created" || outcomeStatus === "replaced" || outcomeStatus === "unchanged")) {
			setBranchRankForString(events.managedSessionActiveRanks, outcomeCurrentSessionName, eventRank);
		}
		if (outcomeSucceeded && outcomeStatus === "closed") {
			setBranchRankForString(events.managedSessionCloseRanks, outcomeAttemptedSessionName ?? outcomeCurrentSessionName ?? sessionName, eventRank);
		}
		if (outcomeSucceeded && outcomeStatus === "replaced") {
			setBranchRankForString(events.managedSessionCloseRanks, outcome.replacedSessionName, eventRank);
		}
		if (succeeded && !isCloseCommand(command) && sessionName && (usedImplicitSession || sessionMode === "fresh")) {
			events.managedSessionActiveRanks.set(sessionName, eventRank);
		}
		if (succeeded && isCloseCommand(command)) {
			setBranchRankForString(events.managedSessionCloseRanks, explicitSessionName ?? sessionName ?? outcomeAttemptedSessionName ?? outcomeCurrentSessionName, eventRank);
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

async function closeOwnedManagedSessionsExcept(sessions: Map<string, OwnedManagedSession>, keepSessionName: string | undefined, timeoutMs: number): Promise<void> {
	for (const [sessionName, owner] of [...sessions]) {
		if (sessionName === keepSessionName) continue;
		const error = await closeManagedSession({ cwd: owner.cwd, sessionName, timeoutMs });
		if (!error) sessions.delete(sessionName);
	}
}

async function closeOwnedManagedSessions(sessions: Map<string, OwnedManagedSession>, timeoutMs: number): Promise<void> {
	await closeOwnedManagedSessionsExcept(sessions, undefined, timeoutMs);
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
	explicitSessionName?: string;
	managedSessionName: string;
	ownedElectronLaunchRecords: Map<string, ElectronLaunchRecord>;
	ownedManagedSessions: Map<string, OwnedManagedSession>;
}): boolean {
	if (!options.explicitSessionName) return true;
	if (options.explicitSessionName === options.managedSessionName) return true;
	if (options.ownedManagedSessions.has(options.explicitSessionName)) return true;
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

function getInstalledDocsPaths(): { readmePath: string; commandReferencePath: string; toolContractPath: string } {
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	return {
		readmePath: join(packageRoot, "README.md"),
		commandReferencePath: join(packageRoot, "docs", "COMMAND_REFERENCE.md"),
		toolContractPath: join(packageRoot, "docs", "TOOL_CONTRACT.md"),
	};
}

function hasArgvFlag(argv: readonly string[], longFlag: string, shortFlag: string): boolean {
	return argv.includes(longFlag) || argv.includes(shortFlag);
}

function shouldIncludeProjectConfig(_cwd: string, argv: readonly string[] = process.argv): boolean {
	return !hasArgvFlag(argv, "--no-approve", "-na");
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	const ephemeralSessionSeed = createEphemeralSessionSeed();
	const agentBrowserConfig = loadAgentBrowserConfigSync({
		cwd: process.cwd(),
		includeProjectConfig: shouldIncludeProjectConfig(process.cwd()),
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
	let managedSessionActive = false;
	let managedSessionBaseName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);
	let managedSessionName = managedSessionBaseName;
	let managedSessionCwd = process.cwd();
	let freshSessionOrdinal = 0;
	let sessionPageState = new SessionPageState();
	let traceOwners = new Map<string, TraceOwner>();
	let artifactManifest: SessionArtifactManifest | undefined;
	let allowedDomainsBySession = new Map<string, AllowedDomainsPolicy>();
	let networkRoutesBySession = new Map<string, NetworkRouteRecord[]>();
	let electronLaunchRecords = new Map<string, ElectronLaunchRecord>();
	let ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
	let branchOwnedElectronLaunchIds = new Set<string>();
	let electronChildProcesses = new Map<string, ChildProcess>();
	const ownedManagedSessions = new Map<string, OwnedManagedSession>();
	const managedSessionExecutionQueue = new AsyncExecutionQueue();
	let branchStateGeneration = 0;

	const clearSessionScopedBrowserState = (sessionName: string): void => {
		allowedDomainsBySession.delete(sessionName);
		networkRoutesBySession.delete(sessionName);
		sessionPageState.clearSession(sessionName);
	};

	const restoreBranchBackedState = (ctx: ExtensionContext, options: { resetRuntimeOwnership: boolean }): void => {
		branchStateGeneration += 1;
		const previousManagedSessionActive = managedSessionActive;
		const previousManagedSessionName = managedSessionName;
		const previousFreshSessionOrdinal = freshSessionOrdinal;
		managedSessionBaseName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
		const branch = ctx.sessionManager.getBranch();
		const branchResourceEvents = collectBranchManagedResourceEvents(branch);
		const restoredState = restoreManagedSessionStateFromBranch(branch, managedSessionBaseName);
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
		managedSessionCwd = ctx.cwd;
		freshSessionOrdinal = nextFreshSessionOrdinal;
		sessionPageState = SessionPageState.fromBranch(branch);
		traceOwners = new Map<string, TraceOwner>();
		artifactManifest = restoreArtifactManifestFromBranch(branch);
		allowedDomainsBySession = restoreAllowedDomainsBySessionFromBranch(branch);
		networkRoutesBySession = new Map<string, NetworkRouteRecord[]>();
		electronLaunchRecords = restoreElectronLaunchRecordsFromBranch(branch);
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
		if (restoredState.active) {
			trackOwnedManagedSession(ownedManagedSessions, restoredState.sessionName, ctx.cwd, { branchOwned: true });
		}
		mergeActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronLaunchRecords, {
			branchOwnedLaunchIds: branchOwnedElectronLaunchIds,
			markBranchOwned: true,
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		restoreBranchBackedState(ctx, { resetRuntimeOwnership: true });
		electronChildProcesses = new Map<string, ChildProcess>();
	});

	pi.on("session_tree", async (_event, ctx) => {
		await managedSessionExecutionQueue.run(async () => {
			restoreBranchBackedState(ctx, { resetRuntimeOwnership: false });
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
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
				cwd: shutdownCwd,
				electronChildProcesses,
				electronLaunchRecords: electronRecordsToCleanup,
				timeoutMs: implicitSessionCloseTimeoutMs,
			});
			preservedElectronProfileDirs = [...new Set([
				...preservedElectronProfileDirs,
				...getCleanupResultsPreservedUserDataDirs(electronCleanupResults),
			])];
			syncElectronCleanupManagedSessions(ownedManagedSessions, electronCleanupResults);
			if (quitting) {
				await closeOwnedManagedSessions(ownedManagedSessions, implicitSessionCloseTimeoutMs);
			} else {
				await closeOwnedManagedSessionsExcept(
					ownedManagedSessions,
					managedSessionActive ? managedSessionName : undefined,
					implicitSessionCloseTimeoutMs,
				);
			}
		});
		managedSessionActive = false;
		sessionPageState.reset();
		traceOwners = new Map<string, TraceOwner>();
		artifactManifest = undefined;
		allowedDomainsBySession = new Map<string, AllowedDomainsPolicy>();
		networkRoutesBySession = new Map<string, NetworkRouteRecord[]>();
		electronLaunchRecords = new Map<string, ElectronLaunchRecord>();
		ownedElectronLaunchRecords = new Map<string, ElectronLaunchRecord>();
		branchOwnedElectronLaunchIds = new Set<string>();
		electronChildProcesses = new Map<string, ChildProcess>();
		ownedManagedSessions.clear();
		await cleanupSecureTempArtifacts({ preservePaths: preservedElectronProfileDirs });
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

	pi.registerTool({
		name: "agent_browser",
		label: "Agent Browser",
		description:
			"Browse and interact with websites using agent-browser. Use this for web research, reading live docs, opening pages, taking snapshots or screenshots, clicking links, filling forms, extracting page content, and authenticated/profile-based browser work. Input choice: default `args` for open → snapshot -i → click/fill @refs; `semanticAction` for stable role/text/label targets; `job` or `qa` for multi-step checks; `electron` only for desktop apps; experimental `sourceLookup` / `networkSourceLookup` for candidates only.",
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
		async execute(_toolCallId, params: AgentBrowserExecuteParams, signal, onUpdate, ctx) {
			const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
			const outputPath = isRecord(params) && typeof params.outputPath === "string" ? params.outputPath : undefined;
			const resolvedInput = resolveAgentBrowserInput({
				getBatchPreflightValidationError,
				managedSessionActive,
				params,
			});
			if (resolvedInput.status === "invalid") {
				return buildValidationFailureResult(resolvedInput);
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
					compiledElectron,
					cwd: ctx.cwd,
					electronChildProcesses,
					electronLaunchRecords: electronHostLaunchRecords,
					implicitSessionCloseTimeoutMs,
					managedSessionActive,
					managedSessionName,
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
			const serializeBrowserCommand = shouldSerializeBrowserCommand({
				explicitSessionName,
				managedSessionName,
				ownedElectronLaunchRecords,
				ownedManagedSessions,
			});
			const runBrowserCommand = async () => {
				const generationAtStart = branchStateGeneration;
				const sessionPageStateUpdate = sessionPageState.beginUpdate();
				const browserRunState: BrowserRunState = {
					allowedDomainsBySession,
					artifactManifest,
					closedManagedSessionNames: new Set<string>(),
					electronChildProcesses,
					electronLaunchRecords,
					ephemeralSessionSeed,
					freshSessionOrdinal,
					managedSessionActive,
					managedSessionBaseName,
					managedSessionCwd,
					managedSessionName,
					networkRoutesBySession,
					sessionPageState,
					traceOwners,
				};
				const result = await runAgentBrowserTool({
					ctx,
					cwd: ctx.cwd,
					electronPostCommandStatusSettleMs: ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
					electronProfileIsolationDetails: ELECTRON_PROFILE_ISOLATION_DETAILS,
					implicitSessionCloseTimeoutMs,
					implicitSessionIdleTimeoutMs,
					input: resolvedInput,
					onUpdate,
					params,
					promptPolicy,
					sessionPageStateUpdate,
					signal,
					state: browserRunState,
				});
				const branchStateStillCurrent = generationAtStart === branchStateGeneration;
				if (serializeBrowserCommand || branchStateStillCurrent) {
					allowedDomainsBySession = browserRunState.allowedDomainsBySession;
					networkRoutesBySession = browserRunState.networkRoutesBySession;
					artifactManifest = browserRunState.artifactManifest;
					freshSessionOrdinal = Math.max(freshSessionOrdinal, browserRunState.freshSessionOrdinal);
					managedSessionActive = browserRunState.managedSessionActive;
					managedSessionCwd = browserRunState.managedSessionCwd;
					managedSessionName = browserRunState.managedSessionName;
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

			return serializeBrowserCommand
				? managedSessionExecutionQueue.run(runBrowserCommand)
				: runBrowserCommand();
		},
	});

	if (webSearchToolAvailable) {
		pi.registerTool(createAgentBrowserWebSearchTool(agentBrowserConfig));
	}
}
