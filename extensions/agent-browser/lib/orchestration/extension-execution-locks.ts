import {
	buildExecutionPlan,
	createFreshSessionName,
	extractUpstreamCommandTokens,
} from "../runtime.js";
import {
	getAgentBrowserSessionIdentityKey,
	scanUpstreamGlobalFlagOccurrences,
} from "../argv-grammar.js";
import { getAgentBrowserProcessTimeoutMs } from "../process.js";
import { isCloseCommand } from "../command-taxonomy.js";
import { getCommandAwareProcessTimeoutMs } from "./browser-run/prepare/wait-timeouts.js";
import { withAgentBrowserProcessEnvironment } from "../process-environment.js";
import { buildValidationFailureResult } from "./input-plan.js";
import {
	resolveBrowserExecutionIdentity,
	withBrowserExecutionLocks,
} from "../managed-session-policy-lock.js";
import {
	getArtifactPreflightValidationError,
	commandTouchesArtifactLifecycle,
} from "./extension-artifact-preflight.js";
import { browserExecutionFailure } from "./extension-result-state.js";
import { warnRecordingPersistence } from "./extension-recording.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import { runBrowserCommand } from "./extension-command-run.js";
import type { BrowserCommandCall } from "./extension-invocation.js";

class BrowserCommandCoordinator {
	readonly plan: ReturnType<typeof buildExecutionPlan>;
	readonly key: string;
	constructor(
		readonly runtime: BrowserRuntime,
		readonly call: BrowserCommandCall,
	) {
		// Electron's browser identity is known before its host supplies the CDP port.
		this.plan = buildExecutionPlan(
			call.compiledElectron?.action === "launch" ? ["connect"] : call.toolArgs,
			{
				freshSessionName: createFreshSessionName(
					runtime.managed.baseName,
					runtime.ephemeralSessionSeed,
					runtime.managed.freshOrdinal + 1,
				),
				managedSessionActive: runtime.managed.active,
				managedSessionCompatibilityWorkaround: runtime.managed.compatibilityWorkaround,
				managedSessionName: runtime.managed.name,
				managedSessionNamespace: runtime.managed.namespace,
				sessionMode:
					call.compiledElectron?.action === "launch"
						? "fresh"
						: (call.params.sessionMode ?? "auto"),
				stdin: call.resolvedInput.toolStdin,
			},
		);
		this.key = getAgentBrowserSessionIdentityKey(
			this.plan.sessionName ?? "default",
			this.plan.namespace,
		);
	}
	launchEnvironment(): NodeJS.ProcessEnv {
		const owner = this.runtime.managed.owned.get(this.key);
		const explicit = ["--confirm-actions", "--config"].some(
			(flag) => scanUpstreamGlobalFlagOccurrences(this.call.toolArgs, flag).length > 0,
		);
		const retained = this.runtime.sessions.pages.get(this.key).confirmActions;
		return {
			...(owner?.socketDir !== undefined && owner.socketDir !== ""
				? { PI_AGENT_BROWSER_SOCKET_DIR: owner.socketDir }
				: {}),
			AGENT_BROWSER_CONFIRM_ACTIONS:
				!explicit && retained !== undefined
					? retained
					: this.call.resolvedInput.nativeConfirmActions,
		};
	}
	execute(signal: AbortSignal | undefined): Promise<AgentBrowserToolResult> {
		return this.call.withLaunchDefaults
			? this.call.withLaunchDefaults(
					(observation) => runBrowserCommand(this.runtime, this.call, observation, signal),
					signal,
					!isCloseCommand(this.plan.commandInfo.command) &&
						(this.runtime.sessions.pages.get(this.key).refSnapshot?.refIds.length ?? 0) > 0,
				)
			: runBrowserCommand(this.runtime, this.call, undefined, signal);
	}
	async preflightAndExecute(signal: AbortSignal | undefined): Promise<AgentBrowserToolResult> {
		const error = getArtifactPreflightValidationError({
			activeRecordingReservations: [...this.runtime.recordings.active.values()],
			args: this.call.toolArgs,
			cwd: this.call.operationCwd,
			outputPath: this.call.outputPath,
			stdin: this.call.resolvedInput.toolStdin,
		});
		if (error === undefined || error === "") {
			return this.execute(signal);
		}
		this.runtime.recordings.flush();
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
	runCommand(signal = this.call.signal): Promise<AgentBrowserToolResult> {
		if (
			!commandTouchesArtifactLifecycle(
				this.call.toolArgs,
				this.call.resolvedInput.toolStdin,
				this.call.outputPath,
			)
		) {
			return this.execute(signal);
		}
		return this.runtime.artifacts.queue.run(() => this.preflightAndExecute(signal));
	}
	needsIdentityLock(): boolean {
		if (this.plan.validationError !== undefined && this.plan.validationError !== "") {
			return false;
		}
		return (
			(this.plan.sessionName !== undefined && this.plan.sessionName !== "") ||
			this.plan.commandInfo.command === "read" ||
			this.call.closesAllSessions
		);
	}
	replacesManagedSession(): boolean {
		return (
			this.runtime.managed.active &&
			(this.call.params.sessionMode === "fresh" ||
				this.call.compiledElectron?.action === "launch") &&
			(this.call.explicitSessionName === undefined || this.call.explicitSessionName === "")
		);
	}
	async identities(): Promise<Awaited<ReturnType<typeof resolveBrowserExecutionIdentity>>[]> {
		const identities = [
			await resolveBrowserExecutionIdentity({
				namespace: this.plan.namespace,
				ownedManagedSession:
					this.plan.managedSessionName !== undefined || this.runtime.managed.owned.has(this.key),
				sessionName: this.call.closesAllSessions ? undefined : (this.plan.sessionName ?? "default"),
			}),
		];
		if (this.replacesManagedSession()) {
			const previous = this.runtime.managed.owned.get(
				getAgentBrowserSessionIdentityKey(
					this.runtime.managed.name,
					this.runtime.managed.namespace,
				),
			);
			identities.push(
				await resolveBrowserExecutionIdentity({
					namespace: this.runtime.managed.namespace,
					ownedManagedSession: true,
					sessionName: this.runtime.managed.name,
					env:
						previous?.socketDir !== undefined && previous.socketDir !== ""
							? { AGENT_BROWSER_SOCKET_DIR: previous.socketDir }
							: undefined,
				}),
			);
		}
		return identities;
	}
	deadline(): number {
		const url = this.runtime.sessions.pages.get(this.key).tabTarget?.url;
		return (
			Date.now() +
			(this.call.params.timeoutMs ??
				getCommandAwareProcessTimeoutMs(
					extractUpstreamCommandTokens(this.call.toolArgs),
					this.call.resolvedInput.toolStdin,
					url,
				) ??
				getAgentBrowserProcessTimeoutMs())
		);
	}
	async runLocked(): Promise<AgentBrowserToolResult> {
		if (!this.needsIdentityLock()) {
			return this.runCommand();
		}
		try {
			const identities = await this.identities();
			return await withBrowserExecutionLocks(
				{ identities, signal: this.call.signal, deadline: this.deadline(), waitOnly: true },
				(signal) => this.runCommand(signal),
			);
		} catch (error) {
			return browserExecutionFailure(error, this.call.signal);
		}
	}
	run(): Promise<AgentBrowserToolResult> {
		// Retained settings are resolved inside the identity queue before daemon or page helpers.
		return withAgentBrowserProcessEnvironment(this.launchEnvironment(), () => this.runLocked());
	}
}
export function runWithLaunchDefaults(
	runtime: BrowserRuntime,
	call: BrowserCommandCall,
): Promise<AgentBrowserToolResult> {
	return new BrowserCommandCoordinator(runtime, call).run();
}
