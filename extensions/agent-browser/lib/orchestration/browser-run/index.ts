import { runAgentBrowserProcess } from "../../process.js";
import {
	applyManagedSessionRestorePlanPolicy,
	buildOwnedManagedSessionEnv,
	resolveOwnedManagedSessionContext,
	withOwnedManagedSessionContext,
} from "../../runtime.js";
import { cleanupClickDispatchProbe } from "./click-dispatch.js";
import { applyBrowserRunStatePatch } from "./session-state.js";
import { buildMissingBinaryFailureResult } from "./final-result.js";
import { prepareBrowserRun } from "./prepare.js";
import { processBrowserOutput } from "./process-output.js";
import type { AgentBrowserToolResult, BrowserRunOptions } from "./types.js";

export { closeManagedSession, getSessionContextKey } from "./session-state.js";
export type { AgentBrowserToolResult, BrowserRunOptions, BrowserRunState, TraceOwner } from "./types.js";

export async function runAgentBrowserTool(options: BrowserRunOptions): Promise<AgentBrowserToolResult> {
	const preparedResult = await prepareBrowserRun(options);
	applyBrowserRunStatePatch(options.state, preparedResult.kind === "ready" ? preparedResult.prepared.statePatch : preparedResult.statePatch);
	if (preparedResult.kind === "early-result") {
		return preparedResult.result;
	}

	const { prepared } = preparedResult;
	const ownedManagedSession = resolveOwnedManagedSessionContext({
		currentManagedSessionName: options.state.managedSessionName,
		currentManagedSessionNamespace: options.state.managedSessionNamespace,
		managedSessionName: prepared.executionPlan.managedSessionName,
		namespace: prepared.executionPlan.namespace,
		sessionName: prepared.executionPlan.sessionName,
	});
	// Re-apply after prepare so sticky policy stays aligned if plan args changed.
	applyManagedSessionRestorePlanPolicy({
		args: prepared.executionPlan.effectiveArgs,
		cwd: options.cwd,
		owned: ownedManagedSession,
	});
	return await withOwnedManagedSessionContext(ownedManagedSession, async () => {
		try {
			const processResult = await runAgentBrowserProcess({
				args: prepared.processArgs,
				cwd: options.cwd,
				env: ownedManagedSession
					? {
							AGENT_BROWSER_IDLE_TIMEOUT_MS: options.implicitSessionIdleTimeoutMs,
							...buildOwnedManagedSessionEnv(),
						}
					: undefined,
				signal: options.signal,
				stdin: prepared.processStdin,
				timeoutMs: prepared.processTimeoutMs,
			});

			const missingBinaryResult = await buildMissingBinaryFailureResult({
				compatibilityWorkaround: prepared.compatibilityWorkaround,
				electronLaunch: prepared.electronLaunch,
				executionPlan: prepared.executionPlan,
				implicitSessionCloseTimeoutMs: options.implicitSessionCloseTimeoutMs,
				managedSessionActive: options.state.managedSessionActive,
				managedSessionName: options.state.managedSessionName,
				managedSessionNamespace: options.state.managedSessionNamespace,
				processResult,
				redactedArgs: prepared.redactedArgs,
				redactedProcessArgs: prepared.redactedProcessArgs,
				sessionMode: prepared.sessionMode,
				sessionTabCorrection: prepared.sessionTabCorrection,
			});
			if (missingBinaryResult) {
				return missingBinaryResult;
			}

			const output = await processBrowserOutput({ ...options, prepared, processResult });
			applyBrowserRunStatePatch(options.state, output.statePatch);
			return output.result;
		} finally {
			await cleanupClickDispatchProbe({
				cwd: options.cwd,
				namespace: prepared.executionPlan.namespace,
				probe: prepared.clickDispatchProbe,
				sessionName: prepared.executionPlan.sessionName,
			});
		}
	});
}
