import { runAgentBrowserProcess } from "../../process.js";
import { cleanupClickDispatchProbe } from "./click-dispatch.js";
import { applyBrowserRunStatePatch } from "./session-state.js";
import { buildMissingBinaryFailureResult } from "./final-result.js";
import { prepareBrowserRun } from "./prepare.js";
import { processBrowserOutput } from "./process-output.js";
import type { AgentBrowserToolResult, BrowserRunOptions } from "./types.js";

export type { BrowserRunOptions, BrowserRunState } from "./types.js";

export async function runAgentBrowserTool(options: BrowserRunOptions): Promise<AgentBrowserToolResult> {
	const preparedResult = await prepareBrowserRun(options);
	applyBrowserRunStatePatch(options.state, preparedResult.kind === "ready" ? preparedResult.prepared.statePatch : preparedResult.statePatch);
	if (preparedResult.kind === "early-result") {
		return preparedResult.result;
	}

	const { prepared } = preparedResult;
	try {
		const processResult = await runAgentBrowserProcess({
			args: prepared.processArgs,
			cwd: options.cwd,
			env: prepared.executionPlan.managedSessionName ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: options.implicitSessionIdleTimeoutMs } : undefined,
			signal: options.signal,
			stdin: prepared.processStdin,
		});

		const missingBinaryResult = await buildMissingBinaryFailureResult({
			compatibilityWorkaround: prepared.compatibilityWorkaround,
			electronLaunch: prepared.electronLaunch,
			executionPlan: prepared.executionPlan,
			implicitSessionCloseTimeoutMs: options.implicitSessionCloseTimeoutMs,
			managedSessionActive: options.state.managedSessionActive,
			managedSessionName: options.state.managedSessionName,
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
		await cleanupClickDispatchProbe({ cwd: options.cwd, probe: prepared.clickDispatchProbe, sessionName: prepared.executionPlan.sessionName });
	}
}
