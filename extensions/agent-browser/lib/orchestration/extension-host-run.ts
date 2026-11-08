import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	appendBrowserTransition,
	applyArtifactChanges,
	artifactChanges,
	browserStateEffects,
	type BrowserRecord,
} from "../browser-transcript.js";
import { appendBrowserRecord } from "../browser-journal.js";
import { createFreshSessionName } from "../runtime.js";
import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
import { isRecord } from "../parsing.js";
import { inspectManagedSessionDaemon } from "./browser-run/managed-session-daemon-policy.js";
import { getActiveElectronRecords, getSessionContextKey } from "./browser-run/session-state.js";
import { handleElectronHostInput, type ElectronLaunchRecord } from "./electron-host/index.js";
import { formatSessionArtifactRetentionSummary } from "../results/artifact-manifest.js";
import {
	browserExecutionFailure,
	invocationArtifactManifest,
	browserPageChanges,
} from "./extension-result-state.js";
import {
	getCleanupResultsClosedManagedSessionIdentities,
	isElectronLaunchRecord,
	syncElectronCleanupManagedSessions,
} from "./extension-electron-ownership.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import type { ElectronClosedManagedSessionIdentity } from "./extension-resource-contracts.js";
import type { BrowserHostCall } from "./extension-invocation.js";
import type { SessionPageState } from "../session-page-state.js";
import type { SessionArtifactManifest } from "../results/contracts.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";

class ElectronHostTransaction {
	readonly electronHostLaunchRecords: Map<string, ElectronLaunchRecord>;
	readonly hostAffecting: boolean;
	readonly workingPageState: SessionPageState;
	readonly priorPages: ReturnType<SessionPageState["views"]>;
	readonly priorManifest: SessionArtifactManifest | undefined;
	readonly operationId: string;
	readonly launchId: string | undefined;
	readonly selected: ElectronLaunchRecord[];
	readonly keys: Set<string>;
	readonly begin: BrowserRecord;
	electronHostResult: AgentBrowserToolResult | undefined;
	constructor(
		readonly runtime: BrowserRuntime,
		readonly call: BrowserHostCall,
		readonly executionSignal = call.signal,
	) {
		this.electronHostLaunchRecords = this.runtime.electron.forHostInput({
			compiledElectron: this.call.compiledElectron,
			ownerSessionId: this.call.ctx.sessionManager.getSessionId(),
		});
		this.hostAffecting =
			this.call.compiledElectron !== undefined &&
			["cleanup", "probe"].includes(this.call.compiledElectron.action);
		this.workingPageState = this.runtime.sessions.pages.fork();
		this.priorPages = this.workingPageState.views();
		this.priorManifest = this.runtime.artifacts.manifest;
		this.operationId = randomUUID();
		this.launchId =
			this.call.compiledElectron && "launchId" in this.call.compiledElectron
				? this.call.compiledElectron.launchId
				: undefined;
		this.selected =
			this.launchId !== undefined && this.launchId !== ""
				? [this.electronHostLaunchRecords.get(this.launchId)].filter(
						(record): record is ElectronLaunchRecord => record !== undefined,
					)
				: getActiveElectronRecords(this.electronHostLaunchRecords);
		this.keys = this.selectedKeys();
		this.begin = this.beginRecord();
	}
	selectedKeys(): Set<string> {
		const keys = new Set(
			this.selected.flatMap((record) =>
				record.sessionName !== undefined && record.sessionName !== ""
					? [getAgentBrowserSessionIdentityKey(record.sessionName, record.namespace)]
					: [],
			),
		);
		if (
			this.call.compiledElectron?.action === "probe" &&
			!(this.launchId !== undefined && this.launchId !== "") &&
			this.runtime.managed.active
		) {
			keys.add(
				getAgentBrowserSessionIdentityKey(
					this.runtime.managed.name,
					this.runtime.managed.namespace,
				),
			);
		}
		return keys;
	}
	beginRecord(): BrowserRecord {
		return {
			event: {
				version: 1,
				phase: "begin",
				operationId: this.operationId,
				toolCallId: this.call.toolCallId,
				commandIndex: 0,
				isError: true,
				state: {},
				pages: [...this.keys].map((key) => ({
					key,
					refs: { kind: "unknown" },
					unknown: true,
				})),
			},
		};
	}
	async admit(): Promise<AgentBrowserToolResult | undefined> {
		if (this.hostAffecting) {
			try {
				if (
					!(await appendBrowserRecord(
						this.call.ctx.sessionManager,
						() => appendBrowserTransition(this.runtime.pi, this.begin),
						this.begin,
						this.call.branch,
					)) ||
					!this.call.branch.isCurrent()
				) {
					throw new Error("The selected Pi branch changed before host-operation admission.");
				}
			} catch (error) {
				return browserExecutionFailure(
					new Error(
						"Could not persist Electron/browser-state begin; the host operation was not run.",
						{ cause: error },
					),
					this.executionSignal,
				);
			}
			this.runtime.sessions.pages.applyBrowserRecord(this.begin);
		}
		return undefined;
	}
	async dispatch(): Promise<void> {
		this.electronHostResult = await handleElectronHostInput({
			attachedSessionKeys: this.runtime.sessions.attached,
			compiledElectron: this.call.compiledElectron,
			cwd: this.call.ctx.cwd,
			electronChildProcesses: this.runtime.electron.childProcesses,
			electronLaunchRecords: this.electronHostLaunchRecords,
			implicitSessionCloseTimeoutMs: this.runtime.implicitSessionCloseTimeoutMs,
			managedSessionActive: this.runtime.managed.active,
			managedSessionName: this.runtime.managed.name,
			managedSessionNamespace: this.runtime.managed.namespace,
			managedSessionRestoreState: this.runtime.managed.restore,
			ownedManagedSessions: this.runtime.managed.owned,
			redactedCompiledElectron: this.call.redactedCompiledElectron,
			sessionPageState: this.workingPageState,
			signal: this.executionSignal,
		});
	}
	cleanupRecords(): unknown[] {
		const details = this.electronHostResult?.details;
		if (!isRecord(details) || !isRecord(details.electron) || !isRecord(details.electron.cleanup)) {
			return [];
		}
		const rows: unknown = details.electron.cleanup.results;
		return Array.isArray(rows) ? rows : [];
	}
	resetManagedSession(): void {
		this.runtime.managed.active = false;
		this.runtime.managed.compatibilityWorkaround = undefined;
		this.runtime.managed.headedAutosaveDisabled = false;
		this.runtime.managed.headedAutosaveInterval = undefined;
		this.runtime.managed.namespace = undefined;
		this.runtime.managed.freshOrdinal += 1;
		this.runtime.managed.name = createFreshSessionName(
			this.runtime.managed.baseName,
			this.runtime.ephemeralSessionSeed,
			this.runtime.managed.freshOrdinal,
		);
	}
	retireClosedIdentity(identity: Readonly<ElectronClosedManagedSessionIdentity>): void {
		this.runtime.recordings.retire(identity.sessionName, identity.namespace);
		const key =
			getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName;
		this.runtime.sessions.clear(key);
		this.workingPageState.clearSession(key);
		if (
			key ===
			(getSessionContextKey(this.runtime.managed.name, this.runtime.managed.namespace) ??
				this.runtime.managed.name)
		) {
			this.resetManagedSession();
		}
	}
	cleanedLaunchIds(records: readonly unknown[]): Set<string> {
		const ids = new Set<string>();
		for (const row of records) {
			if (isRecord(row) && isElectronLaunchRecord(row.record)) {
				ids.add(row.record.launchId);
			}
		}
		return ids;
	}
	applyCleanup(): void {
		const result = this.electronHostResult;
		if (!result || this.call.compiledElectron?.action !== "cleanup") {
			return;
		}
		this.runtime.branch.advanceState();
		const records = this.cleanupRecords();
		const cleanedLaunchIds = this.cleanedLaunchIds(records);
		this.runtime.electron.replaceActive(this.electronHostLaunchRecords, cleanedLaunchIds);
		this.runtime.electron.mergeCleanup(records);
		const namespace =
			isRecord(result.details) && typeof result.details.namespace === "string"
				? result.details.namespace
				: undefined;
		const identities = getCleanupResultsClosedManagedSessionIdentities(records, namespace);
		syncElectronCleanupManagedSessions(this.runtime.managed.owned, records, namespace);
		for (const identity of identities) {
			this.retireClosedIdentity(identity);
		}
		if (this.runtime.artifacts.manifest && isRecord(result.details)) {
			result.details.artifactRetentionSummary = formatSessionArtifactRetentionSummary(
				this.runtime.artifacts.manifest,
			);
		}
	}
	selectedRecordForKey(key: string): ElectronLaunchRecord | undefined {
		return this.selected.find(
			(candidate) =>
				candidate.sessionName !== undefined &&
				candidate.sessionName !== "" &&
				getAgentBrowserSessionIdentityKey(candidate.sessionName, candidate.namespace) === key,
		);
	}
	snapshotChanged(key: string): boolean {
		const snapshot = this.workingPageState.get(key).refSnapshot;
		return (
			snapshot !== undefined &&
			snapshot.snapshotId !== this.priorPages.get(key)?.refSnapshot?.snapshotId
		);
	}
	headedAutosaveInterval(key: string): string | undefined {
		const owner = this.runtime.managed.owned.get(key);
		return (
			owner?.headedManagedAutosaveInterval ??
			(owner?.headedManagedAutosaveDisabled === true ? "0" : undefined)
		);
	}
	async bindSnapshotGeneration(key: string): Promise<void> {
		if (!this.snapshotChanged(key)) {
			return;
		}
		const record = this.selectedRecordForKey(key);
		const daemon = await inspectManagedSessionDaemon({
			cwd: this.call.ctx.cwd,
			sessionName: record?.sessionName ?? this.runtime.managed.name,
			namespace: record?.namespace ?? this.runtime.managed.namespace,
			signal: this.executionSignal,
			includeGeneration: true,
			headedManagedAutosaveInterval: this.headedAutosaveInterval(key),
		});
		this.workingPageState.bindSnapshotGeneration(
			key,
			daemon.status === "active" ? daemon.generation : undefined,
		);
	}
	buildFinish(result: AgentToolResult<unknown>): BrowserRecord {
		const changes = browserPageChanges(this.workingPageState, this.priorPages, [...this.keys]);
		return {
			event: {
				version: 1,
				phase: this.hostAffecting ? "finish" : "state",
				operationId: this.operationId,
				toolCallId: this.call.toolCallId,
				commandIndex: 0,
				isError: result.isError === true,
				state: browserStateEffects(isRecord(result.details) ? result.details : {}),
				pages: changes.pages,
				artifacts: artifactChanges(this.priorManifest, this.runtime.artifacts.manifest),
			},
			...(changes.snapshot ? { snapshot: changes.snapshot } : {}),
		};
	}
	persistenceFailure(result: AgentToolResult<unknown>, error: unknown): AgentBrowserToolResult {
		if (this.call.branch.isCurrent()) {
			this.runtime.sessions.pages.applyBrowserRecord(this.begin);
		}
		return {
			...browserExecutionFailure(
				new Error(
					"The host operation finished, but its state could not be persisted. Inspect before retrying; changes may already have happened.",
					{ cause: error },
				),
				this.executionSignal,
			),
			details: {
				...(isRecord(result.details) ? result.details : {}),
				browserStatePersistence: "finish-unconfirmed",
				resultCategory: "failure",
				failureCategory: "upstream-error",
				nextActions: undefined,
			},
		};
	}
	async persistFinish(): Promise<AgentBrowserToolResult | undefined> {
		const result = this.electronHostResult;
		if (!result || !this.hostAffecting || !this.call.branch.isCurrent()) {
			return undefined;
		}
		for (const key of this.keys) {
			// Bind each ordered host snapshot to its live daemon before persisting one canonical finish.
			await this.bindSnapshotGeneration(key);
		}
		const finish = this.buildFinish(result);
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
				throw new Error("The selected Pi branch changed before host-state confirmation.");
			}
		} catch (error) {
			return this.persistenceFailure(result, error);
		}
		this.runtime.sessions.pages.applyBrowserRecord(finish);
		this.runtime.artifacts.manifest = applyArtifactChanges(
			this.runtime.artifacts.manifest,
			finish.event.artifacts,
		);
		if (isRecord(result.details)) {
			result.details.browserEventVersion = 1;
			result.details.artifactManifest = invocationArtifactManifest(
				this.runtime.artifacts.manifest,
				this.priorManifest,
				result.details,
			);
		}
		return undefined;
	}
	complete(): AgentBrowserToolResult | undefined {
		if (this.electronHostResult && this.executionSignal?.aborted === true) {
			const failure = browserExecutionFailure(this.executionSignal.reason, this.executionSignal);
			return {
				...this.electronHostResult,
				...failure,
				details: {
					...(isRecord(this.electronHostResult.details) ? this.electronHostResult.details : {}),
					...(isRecord(failure.details) ? failure.details : {}),
				},
			};
		}
		return this.electronHostResult;
	}
	async run(): Promise<AgentBrowserToolResult | undefined> {
		const admissionFailure = await this.admit();
		if (admissionFailure) {
			return admissionFailure;
		}
		await this.dispatch();
		this.applyCleanup();
		const failure = await this.persistFinish();
		if (failure) {
			return failure;
		}
		return this.complete();
	}
}
export function runElectronHostInput(
	runtime: BrowserRuntime,
	call: BrowserHostCall,
	executionSignal = call.signal,
): Promise<AgentBrowserToolResult | undefined> {
	return new ElectronHostTransaction(runtime, call, executionSignal).run();
}
