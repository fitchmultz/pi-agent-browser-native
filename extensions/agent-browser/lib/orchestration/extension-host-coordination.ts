import { getActiveElectronRecords } from "./browser-run/session-state.js";
import type { ElectronLaunchRecord } from "./electron-host/index.js";
import { buildValidationFailureResult } from "./input-plan.js";
import { applyAgentBrowserOutputPath } from "./output-file.js";
import {
	resolveBrowserExecutionIdentity,
	withBrowserExecutionLocks,
} from "../managed-session-policy-lock.js";
import { getArtifactPreflightValidationError } from "./extension-artifact-preflight.js";
import { browserExecutionFailure } from "./extension-result-state.js";
import { shouldSerializeElectronHostInput } from "./extension-electron-ownership.js";
import { warnRecordingPersistence } from "./extension-recording.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import { runElectronHostInput } from "./extension-host-run.js";
import type { BrowserHostCall } from "./extension-invocation.js";

type HostResult = AgentBrowserToolResult | undefined;
class ElectronHostCoordinator {
	constructor(
		readonly runtime: BrowserRuntime,
		readonly call: BrowserHostCall,
	) {}
	async cleanup(signal: AbortSignal | undefined): Promise<HostResult> {
		this.runtime.recordings.flush();
		const path = this.call.outputPath;
		const error =
			path !== undefined && path !== ""
				? getArtifactPreflightValidationError({
						activeRecordingReservations: [...this.runtime.recordings.active.values()],
						args: [],
						cwd: this.call.operationCwd,
						outputPath: path,
					})
				: undefined;
		if (error !== undefined && error !== "") {
			return warnRecordingPersistence(
				this.runtime.recordings.dirty,
				buildValidationFailureResult({
					...this.call.resolvedInput,
					attemptedKind: this.call.resolvedInput.kind,
					kind: "invalid",
					status: "invalid",
					validationError: error,
				}),
			);
		}
		const result = await runElectronHostInput(this.runtime, this.call, signal);
		return result
			? applyAgentBrowserOutputPath({
					cwd: this.call.operationCwd,
					outputPath: path,
					result: warnRecordingPersistence(this.runtime.recordings.dirty, result),
				})
			: result;
	}
	execute(signal = this.call.signal): Promise<HostResult> {
		return this.call.compiledElectron?.action === "cleanup"
			? this.runtime.artifacts.queue.run(() => this.cleanup(signal))
			: runElectronHostInput(this.runtime, this.call, signal);
	}
	selectedSessions(): Array<{ sessionName: string; namespace?: string }> {
		const compiled = this.call.compiledElectron;
		const records = this.runtime.electron.forHostInput({
			compiledElectron: compiled,
			ownerSessionId: this.call.ctx.sessionManager.getSessionId(),
		});
		const launchId = compiled && "launchId" in compiled ? compiled.launchId : undefined;
		const selected =
			launchId !== undefined && launchId !== ""
				? [records.get(launchId)].filter(
						(record): record is ElectronLaunchRecord => record !== undefined,
					)
				: getActiveElectronRecords(records);
		const sessions = selected.flatMap((record) =>
			record.sessionName !== undefined && record.sessionName !== ""
				? [{ sessionName: record.sessionName, namespace: record.namespace }]
				: [],
		);
		if (
			compiled?.action === "probe" &&
			(launchId === undefined || launchId === "") &&
			this.runtime.managed.active
		) {
			sessions.push({
				sessionName: this.runtime.managed.name,
				namespace: this.runtime.managed.namespace,
			});
		}
		return sessions;
	}
	async run(): Promise<HostResult> {
		if (!shouldSerializeElectronHostInput(this.call.compiledElectron)) {
			return this.execute();
		}
		const sessions = this.selectedSessions();
		if (sessions.length === 0) {
			return this.execute();
		}
		try {
			const identities = await Promise.all(
				sessions.map((session) =>
					resolveBrowserExecutionIdentity({ ...session, ownedManagedSession: true }),
				),
			);
			return await withBrowserExecutionLocks(
				{
					identities,
					signal: this.call.signal,
					deadline: performance.now() + this.call.executionTimeoutMs,
					waitOnly: true,
				},
				(signal) => this.execute(signal),
			);
		} catch (error) {
			return browserExecutionFailure(error, this.call.signal);
		}
	}
}
export function runCoordinatedElectronHostInput(
	runtime: BrowserRuntime,
	call: BrowserHostCall,
): Promise<HostResult> {
	return new ElectronHostCoordinator(runtime, call).run();
}
