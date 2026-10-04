import { runAgentBrowserProcess, withAttachedBrowserSessionContext, withChromeStartupArgs } from "../../process.js";
import { isRecord } from "../../parsing.js";
import { getAgentBrowserSessionIdentityKey, isBooleanFlagEnabled, resolveAgentBrowserNamespace } from "../../argv-grammar.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { isBrowserIndependentRead, needsManagedSession } from "../../command-policy.js";
import { nextReadConfirmation, parseReadConfirmation, suppressConfirmationPageHelpers } from "../../read-confirmation.js";
import { buildToolPresentation } from "../../results/presentation.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { collectNativeWebMcp, getNativeWebMcpCatalog } from "../../webmcp-observation.js";
import { isPlainTextInspectionArgs, redactSensitiveValue } from "../../runtime.js";
import { formatWebMcpCatalogUpdate } from "../../results/presentation/common.js";
import { withOwnedManagedSessionContext } from "../../managed-session-restore.js";
import { cleanupClickDispatchProbe } from "./click-dispatch.js";
import { applyBrowserRunStatePatch, getSessionContextKey, nativePolicyDefinitelyUnestablished, withSessionCommandObservation } from "./session-state.js";
import { buildScreenshotGeometry, collectScreenshotSample } from "./screenshot-observation.js";
import type { ImageObservation } from "../../results/contracts.js";
import { buildJsonVisibleContent, buildMissingBinaryFailureResult } from "./final-result.js";
import { prepareBrowserRun } from "./prepare.js";
import { processBrowserOutput } from "./process-output.js";
import type { AgentBrowserToolResult, BrowserRunOptions } from "./types.js";

export { closeManagedSession } from "./managed-session-daemon-policy.js";
export { getSessionContextKey } from "./session-state.js";
export type { AgentBrowserToolResult, BrowserRunOptions, BrowserRunState, TraceOwner } from "./types.js";

export async function runAgentBrowserTool(options: BrowserRunOptions): Promise<AgentBrowserToolResult> {
	const observed = await collectNativeWebMcp(() => withSessionCommandObservation({
		allow: helper => {
			const pending = parseReadConfirmation(options.state.observedBrowserEffects?.readConfirmation);
			return !needsManagedSession(parseArgvDescriptor(helper.args), helper.stdin) && !isBrowserIndependentRead(helper.args, helper.stdin)
				|| pending?.state !== "pending" || getAgentBrowserSessionIdentityKey(helper.sessionName ?? "default", resolveAgentBrowserNamespace([], helper.namespace ?? getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE)) !== getAgentBrowserSessionIdentityKey(pending.sessionName, pending.namespace);
		},
		observe: (helper, processResult, envelope) => {
			const namespace = resolveAgentBrowserNamespace([], helper.namespace ?? getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE);
			const sessionName = helper.sessionName ?? "default";
			const key = getAgentBrowserSessionIdentityKey(sessionName, namespace);
			if (key === options.state.confirmationPolicyIdentity && !nativePolicyDefinitelyUnestablished(processResult, envelope, helper.args)) options.state.confirmationPolicyMayBeEstablished = true;
			const confirmation = nextReadConfirmation({ commandTokens: helper.args, current: options.state.sessionPageState.getReadConfirmation(key), data: envelope?.data, namespace, sessionName, succeeded: envelope?.success === true && processResult.exitCode === 0 && !processResult.aborted && !processResult.timedOut });
			if (confirmation) {
				options.state.sessionPageState.applyReadConfirmation(confirmation, options.sessionPageStateUpdate);
				if (helper.args[0] === "open" && confirmation.state === "pending") {
					const invalidation = options.state.sessionPageState.get(key).refSnapshotInvalidation;
					options.state.sessionPageState.markTabTargetUnknown({ sessionName: key, update: options.sessionPageStateUpdate });
					if (invalidation) options.state.sessionPageState.applyRefSnapshotInvalidation({ sessionName: key, update: options.sessionPageStateUpdate, invalidation });
				}
				options.state.observedBrowserEffects = { ...options.state.observedBrowserEffects, readConfirmation: confirmation };
			}
		},
	}, () => withChromeStartupArgs(options.input.persistentChromeArgs, () => withAttachedBrowserSessionContext(options.preserveAttachedBrowserSession === true, () => runAgentBrowserToolInContext(options)))));
	const result = observed.result;
	let details = isRecord(result.details) ? result.details : undefined;
	if (observed.catalog) {
		const catalog = redactSensitiveValue(observed.catalog) as Record<string, unknown>;
		details = { ...details, webMcpCatalog: catalog };
		result.details = details;
		if (!isBooleanFlagEnabled(options.input.toolArgs, "--json") && JSON.stringify(getNativeWebMcpCatalog(details.data)) !== JSON.stringify(catalog)) {
			const notice = formatWebMcpCatalogUpdate(catalog);
			if (result.content[0]?.type === "text") result.content[0] = { ...result.content[0], text: `${result.content[0].text}\n\n${notice}` };
			else result.content.push({ type: "text", text: notice });
		}
	}
	if (result.isError && details?.error === undefined) {
		details = { ...details, error: details?.validationError ?? details?.summary ?? result.content.filter(part => part.type === "text").map(part => part.text).join("\n") };
		result.details = details;
	}
	if (options.modelVisible === false) result.content = [];
	const sessionKey = getSessionContextKey(typeof details?.sessionName === "string" ? details.sessionName : undefined, typeof details?.namespace === "string" ? details.namespace : undefined);
	const page = options.state.sessionPageState.get(sessionKey);
	return page.tabReopenPending === undefined ? result : {
		...result,
		details: { ...details, sessionTabReopenPending: page.tabReopenPending, ...(page.refSnapshotInvalidation ? { refSnapshotInvalidation: page.refSnapshotInvalidation } : {}) },
	};
}

async function runAgentBrowserToolInContext(options: BrowserRunOptions): Promise<AgentBrowserToolResult> {
	let preparedResult = await prepareBrowserRun(options);
	applyBrowserRunStatePatch(options.state, preparedResult.kind === "ready" ? preparedResult.prepared.statePatch : preparedResult.statePatch);
	const helperConfirmation = parseReadConfirmation(options.state.observedBrowserEffects?.readConfirmation);
	if (helperConfirmation?.state === "pending") {
		if (preparedResult.kind === "ready") await preparedResult.prepared.managedSessionPolicyLock?.release();
		const data = { confirmation_required: true, confirmation_id: helperConfirmation.id, action: helperConfirmation.action ?? "read" };
		const presentation = await buildToolPresentation({ commandInfo: { command: helperConfirmation.command, commandTokens: [helperConfirmation.command ?? "read"] }, cwd: options.cwd, envelope: { success: true, data }, namespace: helperConfirmation.namespace, sessionName: helperConfirmation.sessionName });
		preparedResult = { kind: "early-result", result: {
			content: [{ type: "text", text: `Native helper ${helperConfirmation.command} requires confirmation (${helperConfirmation.action}). The requested command was not dispatched.` }, ...presentation.content],
			details: { ...options.state.observedBrowserEffects, agentBrowserStarted: false, args: options.input.redactedArgs, data, sessionName: helperConfirmation.sessionName, namespace: helperConfirmation.namespace, sessionTabTargetUnknown: options.state.sessionPageState.get(getAgentBrowserSessionIdentityKey(helperConfirmation.sessionName, helperConfirmation.namespace)).tabTargetUnknown, readConfirmation: helperConfirmation, nextActions: presentation.nextActions,
				...buildAgentBrowserResultCategoryDetails({ succeeded: false, failureCategory: "confirmation-required" }) },
			isError: true,
		} };
	}
	if (preparedResult.kind === "early-result") {
		options.state.confirmationPolicyMayBeEstablished ??= false;
		const result = preparedResult.result;
		if (options.modelVisible !== false && isBooleanFlagEnabled(options.input.toolArgs, "--json") && !isPlainTextInspectionArgs(options.input.toolArgs)) {
			const details = isRecord(result.details) ? result.details : {};
			const summary = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
			result.content = buildJsonVisibleContent({
				error: result.isError ? details.validationError ?? summary : null,
				details,
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
			const geometryOptions = { command: prepared.commandTokens, cwd: options.cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal: options.signal,
				env: ownedManagedSession ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: options.implicitSessionIdleTimeoutMs } : undefined };
			// Do not start a cold browser through a probe or consume launch flags ahead of the requested capture.
			const probeGeometry = prepared.commandTokens[0] === "screenshot" && !!prepared.priorSessionTabTarget && !prepared.priorSessionTabTargetUnknown && !prepared.executionPlan.startupScopedFlags?.length;
			const before = probeGeometry ? await withChromeStartupArgs(prepared.chromeStartupArgs, () => collectScreenshotSample(geometryOptions)) : undefined;
			const artifactRunStartedAtMs = Date.now();
			const processResult = await withChromeStartupArgs(prepared.chromeStartupArgs, () => runAgentBrowserProcess({
				args: prepared.processArgs,
				nativeConfirmationDecision: suppressConfirmationPageHelpers(prepared.readConfirmation),
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

			const after = probeGeometry && !processResult.aborted && !processResult.timedOut && processResult.exitCode === 0
				? await withChromeStartupArgs(prepared.chromeStartupArgs, () => collectScreenshotSample(geometryOptions)) : undefined;
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
				options.state.confirmationPolicyMayBeEstablished ??= false;
				return missingBinaryResult;
			}

			const output = await processBrowserOutput({ ...options, artifactRunStartedAtMs, prepared, processResult });
			applyBrowserRunStatePatch(options.state, output.statePatch);
			if (isRecord(output.result.details) && Array.isArray(output.result.details.imageObservations) && prepared.commandTokens[0] === "screenshot") {
				output.result.details.imageObservations = redactSensitiveValue((output.result.details.imageObservations as ImageObservation[]).map(image => {
					const rendering = image.rendering ?? before?.rendering ?? after?.rendering;
					return { ...image, ...(rendering ? { rendering } : {}), geometry: buildScreenshotGeometry({ rendering, capture: image.capture, pixels: image.pixels, before, after }) };
				}));
			}
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
