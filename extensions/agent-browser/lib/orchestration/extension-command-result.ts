import { getSuccessfulBatchCloseLifecycle } from "../batch-lifecycle.js";
import {
	appendBrowserTransition,
	applyArtifactChanges,
	artifactChanges,
	browserStateEffects,
	type BrowserRecord,
} from "../browser-transcript.js";
import { appendBrowserRecord, hasPublishedBrowserJournal } from "../browser-journal.js";
import { extractUpstreamCommandTokens } from "../runtime.js";
import {
	isBooleanFlagEnabled,
	deleteIdentityKeysInNamespace,
	extractExplicitSessionName,
	getAgentBrowserSessionIdentityKey,
	isAgentBrowserSessionIdentityKeyInNamespace,
} from "../argv-grammar.js";

import { isRecord } from "../parsing.js";

import { mergeBrowserRunArtifactManifest } from "./browser-run/artifact-merge.js";
import { isCloseCommand } from "../command-taxonomy.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import { getSessionContextKey } from "./browser-run/session-state.js";

import { applyAgentBrowserOutputPath } from "./output-file.js";
import { formatSessionArtifactRetentionSummary } from "../results/artifact-manifest.js";
import { isSuccessfulNativeConfirmedClose } from "../read-confirmation.js";
import { getArtifactCommandSteps } from "./extension-artifact-preflight.js";
import {
	browserExecutionFailure,
	invocationArtifactManifest,
	browserPageChanges,
} from "./extension-result-state.js";
import {
	untrackOwnedManagedSession,
	syncOwnedManagedSessionsFromResult,
} from "./extension-managed-ownership.js";
import { getTouchedElectronLaunchIds } from "./extension-electron-ownership.js";

import {
	warnRecordingPersistence,
	appendActiveRecordingCleanupAction,
} from "./extension-recording.js";

import type {
	BrowserCommandPreparation,
	BrowserCommandDispatch,
} from "./extension-command-state.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BrowserRuntime } from "./extension-runtime.js";
import type { BrowserCommandCall } from "./extension-invocation.js";

function withoutCommand(step: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const visible = { ...step };
	delete visible.command;
	return visible;
}

export class BrowserCommandResult {
	result: AgentBrowserToolResult;
	readonly branchRestoreStillCurrent: boolean;
	readonly resultDetails: Record<string, unknown> | undefined;
	readonly resultSessionName: string | undefined;
	readonly resultNamespace: string | undefined;
	constructor(
		readonly runtime: BrowserRuntime,
		readonly call: BrowserCommandCall,
		readonly prepared: BrowserCommandPreparation,
		readonly dispatch: BrowserCommandDispatch & Readonly<{ result: AgentToolResult<unknown> }>,
	) {
		this.result = dispatch.result;
		this.branchRestoreStillCurrent = call.branch.isCurrent();
		this.resultDetails = isRecord(this.result.details) ? this.result.details : undefined;
		this.resultSessionName =
			typeof this.resultDetails?.sessionName === "string"
				? this.resultDetails.sessionName
				: extractExplicitSessionName(call.toolArgs);
		this.resultNamespace =
			typeof this.resultDetails?.namespace === "string"
				? this.resultDetails.namespace
				: prepared.selectedPlan.namespace;
	}
	reconcileNativeIdentity(): void {
		const { prepared } = this;
		if (prepared.browserRunState.confirmationPolicyMayBeEstablished === false) {
			prepared.workingPageState.setConfirmActions(
				prepared.selectedKey,
				prepared.priorPages.get(prepared.selectedKey)?.confirmActions,
			);
		}
		this.annotateManagedIdentity();
	}
	resultMatchesManagedIdentity(): boolean {
		const details = this.resultDetails;
		if (
			!details ||
			typeof details.sessionName !== "string" ||
			!this.prepared.browserRunState.managedSessionActive
		) {
			return false;
		}
		return (
			getAgentBrowserSessionIdentityKey(
				details.sessionName,
				typeof details.namespace === "string" ? details.namespace : undefined,
			) ===
			getAgentBrowserSessionIdentityKey(
				this.prepared.browserRunState.managedSessionName,
				this.prepared.browserRunState.managedSessionNamespace,
			)
		);
	}
	annotateManagedIdentity(): void {
		if (this.resultDetails && this.prepared.begin.event.state.wrapperManaged === true) {
			this.resultDetails.managedSessionSocketDir =
				this.prepared.begin.event.state.managedSessionSocketDir;
		}
		if (this.resultDetails && this.resultMatchesManagedIdentity()) {
			this.resultDetails.managedSessionCwd = this.prepared.browserRunState.managedSessionCwd;
		}
	}
	attachmentRemainsActive(): boolean {
		const outcome = isRecord(this.resultDetails?.managedSessionOutcome)
			? this.resultDetails.managedSessionOutcome
			: undefined;
		return (
			this.result.isError !== true ||
			((this.dispatch.attachedSessionRequested || this.dispatch.attachedSessionKnown) &&
				outcome?.activeAfter === true)
		);
	}
	closesAttachment(): boolean {
		const tokens = extractUpstreamCommandTokens(this.call.toolArgs);
		return (
			(this.result.isError !== true &&
				(isCloseCommand(tokens[0]) ||
					isSuccessfulNativeConfirmedClose(tokens, this.resultDetails?.data))) ||
			getSuccessfulBatchCloseLifecycle(this.resultDetails?.batchSteps)?.endsClosed === true
		);
	}
	retainAttachment(key: string): void {
		this.runtime.sessions.attached.add(key);
		this.result = {
			...this.result,
			details: { ...this.resultDetails, attachedBrowserSession: true },
		};
	}
	shouldRetainAttachment(): boolean {
		return (
			this.attachmentRemainsActive() &&
			(this.dispatch.attachedSessionRequested || this.dispatch.attachedSessionKnown)
		);
	}
	retainAfterCloseAll(key: string): void {
		if (
			this.shouldRetainAttachment() &&
			getSuccessfulBatchCloseLifecycle(this.resultDetails?.batchSteps)?.endsClosed === false
		) {
			this.retainAttachment(key);
		}
	}
	reconcileAttachments(): void {
		if (!this.branchRestoreStillCurrent) {
			return;
		}
		const closeAll = this.resultDetails?.closeAllApplied === true;
		if (closeAll) {
			deleteIdentityKeysInNamespace(this.runtime.sessions.attached, this.resultNamespace);
		}
		const key =
			getSessionContextKey(this.resultSessionName, this.resultNamespace) ?? this.resultSessionName;
		if (key === undefined || key === "") {
			return;
		}
		if (closeAll) {
			this.retainAfterCloseAll(key);
			return;
		}
		if (this.closesAttachment()) {
			this.runtime.sessions.attached.delete(key);
		} else if (this.shouldRetainAttachment()) {
			this.retainAttachment(key);
		}
	}
	mergeRoutes(): void {
		const updated = this.prepared.browserRunState.networkRoutesBySession;
		const initial = this.dispatch.initialNetworkRoutesBySession;
		if (updated === initial) {
			return;
		}
		const merged = new Map(this.runtime.sessions.routes);
		for (const [key, value] of updated) {
			if (!initial.has(key) || initial.get(key) !== value) {
				merged.set(key, value);
			}
		}
		for (const key of initial.keys()) {
			if (!updated.has(key)) {
				merged.delete(key);
			}
		}
		this.runtime.sessions.routes = merged;
	}
	retireClosedRecordings(): void {
		const handled = this.runtime.recordings.syncResult(this.result);
		if (this.resultDetails?.closeAllApplied === true) {
			// Snapshot reservations because retiring an identity deletes from the live index.
			for (const [key, reservation] of Array.from(this.runtime.recordings.active)) {
				if (isAgentBrowserSessionIdentityKeyInNamespace(key, this.resultNamespace)) {
					this.runtime.recordings.retire(reservation.sessionName, reservation.namespace);
				}
			}
		}
		for (const key of this.prepared.browserRunState.closedManagedSessionNames) {
			if (handled.has(key)) {
				continue;
			}
			const reservation = this.runtime.recordings.active.get(key);
			if (reservation) {
				this.runtime.recordings.retire(reservation.sessionName, reservation.namespace);
			}
		}
	}
	appendRecordingCleanup(): void {
		if (this.resultSessionName === undefined || this.resultSessionName === "") {
			return;
		}
		const reservation = this.runtime.recordings.active.get(
			getAgentBrowserSessionIdentityKey(this.resultSessionName, this.resultNamespace),
		);
		if (reservation) {
			this.result = appendActiveRecordingCleanupAction(this.result, reservation);
		}
	}
	mergeResultArtifacts(): void {
		if (!this.branchRestoreStillCurrent) {
			return;
		}
		this.mergeRoutes();
		this.runtime.artifacts.manifest = mergeBrowserRunArtifactManifest(
			this.runtime.artifacts.manifest,
			this.dispatch.initialArtifactManifest,
			this.prepared.browserRunState.artifactManifest,
		);
		this.retireClosedRecordings();
		this.appendRecordingCleanup();
		if (this.runtime.artifacts.manifest && isRecord(this.result.details)) {
			this.result.details.artifactRetentionSummary = formatSessionArtifactRetentionSummary(
				this.runtime.artifacts.manifest,
			);
		}
	}
	adoptRuntime(): void {
		const branchStateStillCurrent =
			this.prepared.generationAtStart === this.runtime.branch.stateGeneration &&
			this.call.branch.isCurrent();
		if (this.call.serializeBrowserCommand || branchStateStillCurrent) {
			this.runtime.managed.freshOrdinal = Math.max(
				this.runtime.managed.freshOrdinal,
				this.prepared.browserRunState.freshSessionOrdinal,
			);
			this.runtime.managed.active = this.prepared.browserRunState.managedSessionActive;
			this.runtime.managed.compatibilityWorkaround =
				this.prepared.browserRunState.managedSessionCompatibilityWorkaround;
			this.runtime.managed.headedAutosaveDisabled =
				this.prepared.browserRunState.managedSessionHeadedAutosaveDisabled === true;
			this.runtime.managed.headedAutosaveInterval =
				this.prepared.browserRunState.managedSessionHeadedAutosaveInterval;
			this.runtime.managed.cwd = this.prepared.browserRunState.managedSessionCwd;
			this.runtime.managed.name = this.prepared.browserRunState.managedSessionName;
			this.runtime.managed.namespace = this.prepared.browserRunState.managedSessionNamespace;
			for (const closedSessionName of this.prepared.browserRunState.closedManagedSessionNames) {
				untrackOwnedManagedSession(this.runtime.managed.owned, closedSessionName);
			}
			syncOwnedManagedSessionsFromResult(
				this.runtime.managed.owned,
				this.result,
				this.prepared.browserRunState.managedSessionCwd,
			);
			this.runtime.electron.mergeActive(this.runtime.electron.records, {
				ownerSessionId: this.call.ctx.sessionManager.getSessionId(),
				touchedLaunchIds: !(this.result.isError === true)
					? getTouchedElectronLaunchIds(
							this.call.explicitSessionName ?? this.prepared.browserRunState.managedSessionName,
							this.runtime.electron.records,
							this.resultNamespace,
						)
					: undefined,
			});
			if (this.call.serializeBrowserCommand) {
				this.runtime.branch.advanceState();
			}
		}
	}
	finishState(): BrowserRecord["event"]["state"] {
		return {
			...browserStateEffects(isRecord(this.result.details) ? this.result.details : {}),
			...this.prepared.browserRunState.observedBrowserEffects,
			ownerSessionId: this.call.ctx.sessionManager.getSessionId(),
			...(this.prepared.begin.event.state.wrapperManaged === true
				? {
						managedSessionDaemon: this.runtime.managed.restore.getDaemonReceipt(
							this.resultSessionName,
							this.resultNamespace,
						),
					}
				: {}),
		};
	}
	needsFinish(pagesChanged: boolean, artifactsChanged: boolean): boolean {
		return (
			this.prepared.browserAffecting ||
			pagesChanged ||
			(artifactsChanged && hasPublishedBrowserJournal(this.call.ctx.sessionManager)) ||
			this.resultDetails?.readConfirmation !== undefined ||
			this.prepared.browserRunState.observedBrowserEffects?.readConfirmation !== undefined
		);
	}
	buildFinish(): BrowserRecord | undefined {
		if (this.prepared.selectedPlan.plainTextInspection || !this.branchRestoreStillCurrent) {
			return undefined;
		}
		const changes = browserPageChanges(this.prepared.workingPageState, this.prepared.priorPages, [
			...this.prepared.browserRunState.closedManagedSessionNames,
			...(this.prepared.browserAffecting ? [this.prepared.selectedKey] : []),
		]);
		const artifacts = artifactChanges(
			this.dispatch.initialArtifactManifest,
			this.runtime.artifacts.manifest,
		);
		const requiresFinish = this.needsFinish(changes.pages.length > 0, artifacts !== undefined);
		if (!requiresFinish) {
			return undefined;
		}
		return {
			event: {
				version: 1,
				phase: this.prepared.browserAffecting ? "finish" : "state",
				operationId: this.prepared.operationId,
				toolCallId: this.call.toolCallId,
				commandIndex: this.call.commandIndex ?? 0,
				isError: this.result.isError === true,
				state: this.finishState(),
				pages: changes.pages,
				artifacts,
			},
			...(changes.snapshot ? { snapshot: changes.snapshot } : {}),
		};
	}
	persistenceFailure(error: unknown): AgentBrowserToolResult {
		return {
			...this.result,
			...browserExecutionFailure(
				new Error(
					"The browser command finished, but its state could not be persisted. Changes may already have happened; inspect the current page before retrying.",
					{ cause: error },
				),
				this.prepared.executionSignal,
			),
			details: {
				...(isRecord(this.result.details) ? this.result.details : {}),
				resultCategory: "failure",
				failureCategory: "upstream-error",
				browserStatePersistence: "finish-unconfirmed",
				nextActions: [
					{
						id: "inspect-after-browser-state-persistence-failure",
						tool: "agent_browser",
						params: {
							args: [
								"--session",
								this.prepared.selectedPlan.sessionName ?? "default",
								"--namespace",
								this.prepared.selectedPlan.namespace ?? "",
								"batch",
								"--bail",
							],
							stdin: JSON.stringify([
								["get", "url"],
								["snapshot", "-i"],
							]),
						},
						reason:
							"The effect may already have happened. Verify the current URL and inspect before deciding whether to retry.",
						safety: "Read-only inspection; no mutation is replayed.",
					},
				],
			},
		};
	}
	async persistFinish(): Promise<AgentBrowserToolResult | undefined> {
		const finish = this.buildFinish();
		if (!finish) {
			return undefined;
		}
		try {
			if (
				!(await appendBrowserRecord(
					this.call.ctx.sessionManager,
					() => appendBrowserTransition(this.runtime.pi, finish),
					finish,
					this.call.branch,
				)) ||
				!this.call.branch.isCurrent()
			) {
				throw new Error("The selected Pi branch changed before browser-state confirmation.");
			}
		} catch (error) {
			return this.omitIndexedBatchCommands(this.persistenceFailure(error));
		}
		this.runtime.sessions.pages.applyBrowserRecord(finish);
		this.runtime.artifacts.manifest = applyArtifactChanges(
			this.runtime.artifacts.manifest,
			finish.event.artifacts,
		);
		return undefined;
	}
	private omitIndexedBatchCommands(result: AgentBrowserToolResult): AgentBrowserToolResult {
		const details = result.details;
		const tokens = extractUpstreamCommandTokens(this.call.toolArgs);
		if (
			!isRecord(details) ||
			tokens[0] !== "batch" ||
			!tokens.includes("--omit-command") ||
			!Array.isArray(details.batchSteps)
		) {
			return result;
		}
		// Canonical finish and any outputPath receipt read the redacted attribution first; native
		// public receipts omit argv, so project each returned copy instead of mutating shared rows.
		const failure = details.batchFailure;
		return {
			...result,
			details: {
				...details,
				batchSteps: details.batchSteps.map((step: unknown) =>
					isRecord(step) ? withoutCommand(step) : step,
				),
				...(isRecord(failure) && isRecord(failure.failedStep)
					? { batchFailure: { ...failure, failedStep: withoutCommand(failure.failedStep) } }
					: {}),
			},
		};
	}
	async complete(): Promise<AgentBrowserToolResult> {
		if (isRecord(this.result.details)) {
			this.result.details.browserEventVersion = 1;
			if (
				!(
					this.call.compiledElectron?.action === "launch" &&
					this.call.compiledElectron.handoff === "snapshot"
				) &&
				!getArtifactCommandSteps(this.call.toolArgs, this.call.resolvedInput.toolStdin).steps.some(
					(step) => step[0] === "snapshot",
				)
			) {
				delete this.result.details.refSnapshot;
			}
			this.result.details.artifactManifest = invocationArtifactManifest(
				this.call.branch.isCurrent()
					? this.runtime.artifacts.manifest
					: this.prepared.browserRunState.artifactManifest,
				this.dispatch.initialArtifactManifest,
				this.result.details,
			);
		}
		const result = await applyAgentBrowserOutputPath({
			cwd: this.call.operationCwd,
			outputPath: this.call.outputPath,
			preserveTextContent:
				Array.isArray(this.call.params.args) &&
				isBooleanFlagEnabled(this.call.params.args, "--json"),
			result: warnRecordingPersistence(this.runtime.recordings.dirty, this.result),
		});
		return this.omitIndexedBatchCommands(result);
	}
}
