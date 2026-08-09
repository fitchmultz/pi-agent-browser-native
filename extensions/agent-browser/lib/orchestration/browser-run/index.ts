import { runAgentBrowserProcess, withAttachedBrowserSessionContext } from "../../process.js";
import { withOwnedManagedSessionContext } from "../../managed-session-restore.js";
import { cleanupClickDispatchProbe } from "./click-dispatch.js";
import { applyBrowserRunStatePatch } from "./session-state.js";
import { buildMissingBinaryFailureResult } from "./final-result.js";
import { prepareBrowserRun } from "./prepare.js";
import { processBrowserOutput } from "./process-output.js";
import type { AgentBrowserToolResult, BrowserRunOptions } from "./types.js";

export { closeManagedSession } from "./managed-session-daemon-policy.js";
export { getSessionContextKey } from "./session-state.js";
export type { AgentBrowserToolResult, BrowserRunOptions, BrowserRunState, TraceOwner } from "./types.js";

export async function runAgentBrowserTool(options: BrowserRunOptions): Promise<AgentBrowserToolResult> {
	return await withAttachedBrowserSessionContext(options.preserveAttachedBrowserSession === true, () => runAgentBrowserToolInContext(options));
}

async function runAgentBrowserToolInContext(options: BrowserRunOptions): Promise<AgentBrowserToolResult> {
	const preparedResult = await prepareBrowserRun(options);
	applyBrowserRunStatePatch(options.state, preparedResult.kind === "ready" ? preparedResult.prepared.statePatch : preparedResult.statePatch);
	if (preparedResult.kind === "early-result") {
		return preparedResult.result;
	}

	const { prepared } = preparedResult;
	const ownedManagedSession = prepared.ownedManagedSessionContext;
	return await withOwnedManagedSessionContext(ownedManagedSession, async () => {
		try {
			const artifactRunStartedAtMs = Date.now();
			const processResult = await runAgentBrowserProcess({
				args: prepared.processArgs,
				cwd: options.cwd,
				env: ownedManagedSession
					? { AGENT_BROWSER_IDLE_TIMEOUT_MS: options.implicitSessionIdleTimeoutMs }
					: undefined,
				managedSessionRestoreState: options.state.managedSessionRestoreState,
				managedStateCurrentPageUrl: prepared.priorSessionTabTarget?.url,
				managedStatePageUrlUnknown: prepared.priorSessionTabTargetUnknown === true,
				ownedManagedSession: ownedManagedSession !== undefined,
				signal: options.signal,
				stdin: prepared.processStdin,
				timeoutMs: prepared.processTimeoutMs,
				trustedFirstBatchTabSelection: prepared.pinnedBatchUnwrapMode !== undefined,
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
			if (missingBinaryResult) return missingBinaryResult;

			const output = await processBrowserOutput({ ...options, artifactRunStartedAtMs, prepared, processResult });
			applyBrowserRunStatePatch(options.state, output.statePatch);
			return output.result;
		} finally {
			try {
				await cleanupClickDispatchProbe({
					cwd: options.cwd,
					namespace: prepared.executionPlan.namespace,
					probe: prepared.clickDispatchProbe,
					sessionName: prepared.executionPlan.sessionName,
				});
			} finally {
				await prepared.managedSessionPolicyLock?.release();
			}
		}
	});
}
