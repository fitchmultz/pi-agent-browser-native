import { runAgentBrowserProcess, withAttachedBrowserSessionContext, withChromeStartupArgs } from "../../process.js";
import { isRecord } from "../../parsing.js";
import { collectNativeWebMcp, getNativeWebMcpCatalog } from "../../webmcp-observation.js";
import { isPlainTextInspectionArgs, redactSensitiveValue } from "../../runtime.js";
import { formatWebMcpCatalogUpdate } from "../../results/presentation/common.js";
import { withOwnedManagedSessionContext } from "../../managed-session-restore.js";
import { cleanupClickDispatchProbe } from "./click-dispatch.js";
import { applyBrowserRunStatePatch, getSessionContextKey } from "./session-state.js";
import { buildJsonVisibleContent, buildMissingBinaryFailureResult } from "./final-result.js";
import { prepareBrowserRun } from "./prepare.js";
import { processBrowserOutput } from "./process-output.js";
import type { AgentBrowserToolResult, BrowserRunOptions } from "./types.js";

export { closeManagedSession } from "./managed-session-daemon-policy.js";
export { getSessionContextKey } from "./session-state.js";
export type { AgentBrowserToolResult, BrowserRunOptions, BrowserRunState, TraceOwner } from "./types.js";

export async function runAgentBrowserTool(options: BrowserRunOptions): Promise<AgentBrowserToolResult> {
	const observed = await collectNativeWebMcp(() => withChromeStartupArgs(options.input.persistentChromeArgs, () => withAttachedBrowserSessionContext(options.preserveAttachedBrowserSession === true, () => runAgentBrowserToolInContext(options))));
	const result = observed.result;
	let details = isRecord(result.details) ? result.details : undefined;
	if (observed.catalog) {
		const catalog = redactSensitiveValue(observed.catalog) as Record<string, unknown>;
		details = { ...details, webMcpCatalog: catalog };
		result.details = details;
		if (!options.input.toolArgs.includes("--json") && JSON.stringify(getNativeWebMcpCatalog(details.data)) !== JSON.stringify(catalog)) {
			const notice = formatWebMcpCatalogUpdate(catalog);
			if (result.content[0]?.type === "text") result.content[0] = { ...result.content[0], text: `${result.content[0].text}\n\n${notice}` };
			else result.content.push({ type: "text", text: notice });
		}
	}
	const sessionKey = getSessionContextKey(typeof details?.sessionName === "string" ? details.sessionName : undefined, typeof details?.namespace === "string" ? details.namespace : undefined);
	const page = options.state.sessionPageState.get(sessionKey);
	return page.tabReopenPending === undefined ? result : {
		...result,
		details: { ...details, sessionTabReopenPending: page.tabReopenPending, ...(page.refSnapshotInvalidation ? { refSnapshotInvalidation: page.refSnapshotInvalidation } : {}) },
	};
}

async function runAgentBrowserToolInContext(options: BrowserRunOptions): Promise<AgentBrowserToolResult> {
	const preparedResult = await prepareBrowserRun(options);
	applyBrowserRunStatePatch(options.state, preparedResult.kind === "ready" ? preparedResult.prepared.statePatch : preparedResult.statePatch);
	if (preparedResult.kind === "early-result") {
		const result = preparedResult.result;
		if (options.input.toolArgs.includes("--json") && !isPlainTextInspectionArgs(options.input.toolArgs)) {
			const details = isRecord(result.details) ? result.details : {};
			const summary = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
			result.content = buildJsonVisibleContent({
				error: result.isError ? details.validationError ?? summary : null,
				presentation: { content: result.content, data: details.data, summary },
				succeeded: result.isError !== true,
			});
		}
		return result;
	}

	const { prepared } = preparedResult;
	const ownedManagedSession = prepared.ownedManagedSessionContext;
	return await withOwnedManagedSessionContext(ownedManagedSession, async () => {
		try {
			const artifactRunStartedAtMs = Date.now();
			const processResult = await withChromeStartupArgs(prepared.chromeStartupArgs, () => runAgentBrowserProcess({
				args: prepared.processArgs,
				browserIndependentReadConfirmation: prepared.readConfirmation !== undefined,
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
			}));

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
