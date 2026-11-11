import {
	runAgentBrowserProcess,
	withAttachedBrowserSessionContext,
	withChromeStartupArgs,
} from "../../process.js";
import { isRecord } from "../../parsing.js";
import { getAgentBrowserSessionIdentityKey, isBooleanFlagEnabled } from "../../argv-grammar.js";
import { parseReadConfirmation, suppressConfirmationPageHelpers } from "../../read-confirmation.js";
import type { ReadConfirmation } from "../../results/evidence-contracts.js";
import type { ScreenshotSample } from "../../results/contracts.js";
import { buildToolPresentation } from "../../results/presentation.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { collectNativeWebMcp } from "../../webmcp-observation.js";
import { isPlainTextInspectionArgs } from "../../runtime-args-validation.js";
import { redactSensitiveValue } from "../../runtime-redaction.js";
import { withOwnedManagedSessionContext } from "../../managed-session-restore.js";
import { cleanupClickDispatchProbe } from "./click-dispatch.js";
import { withSessionCommandObservation } from "./session-state.js";
import {
	annotateScreenshotImageObservations,
	collectScreenshotSample,
} from "./screenshot-observation.js";
import { buildJsonVisibleContent } from "./final-result-redaction.js";
import { buildMissingBinaryFailureResult } from "./final-result-missing-binary.js";
import { createNativeHelperObserver } from "./native-helper-observation.js";
import {
	projectBrowserObservationResult,
	type BrowserObservationState,
} from "./browser-observation-result.js";
import type {
	AgentBrowserProcessResult,
	AgentBrowserToolResult,
	BrowserRunOptions,
	BrowserRunState,
	PreparedBrowserRun,
	PrepareBrowserRunResult,
} from "./types.js";

export { closeManagedSession } from "./managed-session-daemon-policy.js";
export { getSessionContextKey } from "./session-state.js";
export type {
	AgentBrowserToolResult,
	BrowserRunOptions,
	BrowserRunState,
	TraceOwner,
} from "./types.js";

export async function runAgentBrowserTool(
	options: BrowserRunOptions,
): Promise<AgentBrowserToolResult> {
	const observed = await collectNativeWebMcp(() =>
		withSessionCommandObservation(
			createNativeHelperObserver(options.state, options.sessionPageStateUpdate),
			() =>
				withAttachedBrowserSessionContext(options.preserveAttachedBrowserSession === true, () =>
					runAgentBrowserToolInContext(options),
				),
		),
	);
	return projectBrowserObservationResult({
		...observed,
		args: options.input.toolArgs,
		state: options.state,
	});
}

async function buildHelperConfirmationResult(
	options: Pick<BrowserRunOptions, "cwd"> & {
		readonly input: Pick<BrowserRunOptions["input"], "redactedArgs">;
		readonly state: BrowserObservationState;
	},
	confirmation: ReadConfirmation,
): Promise<AgentBrowserToolResult> {
	const data = {
		confirmation_required: true,
		confirmation_id: confirmation.id,
		action: confirmation.action ?? "read",
	};
	const presentation = await buildToolPresentation({
		commandInfo: { command: confirmation.command, commandTokens: [confirmation.command ?? "read"] },
		cwd: options.cwd,
		envelope: { success: true, data },
		namespace: confirmation.namespace,
		sessionName: confirmation.sessionName,
	});
	return {
		content: [
			{
				type: "text",
				text: `Native helper ${confirmation.command ?? "undefined"} requires confirmation (${confirmation.action ?? "undefined"}). The requested command was not dispatched.`,
			},
			...presentation.content,
		],
		details: {
			...options.state.observedBrowserEffects,
			agentBrowserStarted: false,
			args: options.input.redactedArgs,
			data,
			sessionName: confirmation.sessionName,
			namespace: confirmation.namespace,
			sessionTabTargetUnknown: options.state.sessionPageState.get(
				getAgentBrowserSessionIdentityKey(confirmation.sessionName, confirmation.namespace),
			).tabTargetUnknown,
			readConfirmation: confirmation,
			nextActions: presentation.nextActions,
			...buildAgentBrowserResultCategoryDetails({
				succeeded: false,
				failureCategory: "confirmation-required",
			}),
		},
		isError: true,
	};
}

function projectEarlyResult(
	options: { readonly toolArgs: readonly string[] },
	result: AgentBrowserToolResult,
): AgentBrowserToolResult {
	if (
		!isBooleanFlagEnabled(options.toolArgs, "--json") ||
		isPlainTextInspectionArgs(options.toolArgs)
	) {
		return result;
	}
	const details = isRecord(result.details) ? result.details : {};
	const summary = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	return {
		...result,
		content: buildJsonVisibleContent({
			error: result.isError === true ? (details.validationError ?? summary) : null,
			details,
			presentation: { content: result.content, data: details.data, summary },
			succeeded: result.isError !== true,
		}),
	};
}

async function honorHelperConfirmation(
	options: BrowserRunOptions,
	prepared: PrepareBrowserRunResult,
): Promise<PrepareBrowserRunResult> {
	const confirmation = parseReadConfirmation(
		options.state.observedBrowserEffects?.readConfirmation,
	);
	if (confirmation?.state !== "pending") {
		return prepared;
	}
	if (prepared.kind === "ready") {
		await prepared.prepared.managedSessionPolicyLock?.release();
	}
	return {
		kind: "early-result",
		result: await buildHelperConfirmationResult(options, confirmation),
	};
}

async function runAgentBrowserToolInContext(
	options: BrowserRunOptions,
): Promise<AgentBrowserToolResult> {
	// Preparation belongs to this call's existing helper/attachment observation context.
	const { prepareBrowserRun } = await import("./prepare.js");
	const prepared = await prepareBrowserRun(options);
	options.state.applyPatch(
		prepared.kind === "ready" ? prepared.prepared.statePatch : prepared.statePatch,
	);
	const preparation = await honorHelperConfirmation(options, prepared);
	if (preparation.kind === "early-result") {
		options.state.recordConfirmationPolicy(false);
		return projectEarlyResult({ toolArgs: options.input.toolArgs }, preparation.result);
	}
	return withOwnedManagedSessionContext(preparation.prepared.ownedManagedSessionContext, () =>
		executePreparedBrowserRun(options, preparation.prepared),
	);
}

interface CapturedBrowserExecution {
	readonly artifactRunStartedAtMs: number;
	readonly before?: ScreenshotSample | undefined;
	readonly after?: ScreenshotSample | undefined;
	readonly processResult: AgentBrowserProcessResult;
}

function geometryProbeOptions(
	options: Pick<BrowserRunOptions, "cwd" | "signal" | "implicitSessionIdleTimeoutMs">,
	prepared: Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">,
	ownedManagedSession: boolean,
): Parameters<typeof collectScreenshotSample>[0] {
	return {
		command: prepared.commandTokens,
		cwd: options.cwd,
		namespace: prepared.executionPlan.namespace,
		sessionName: prepared.executionPlan.sessionName,
		signal: options.signal,
		env: ownedManagedSession
			? { AGENT_BROWSER_IDLE_TIMEOUT_MS: options.implicitSessionIdleTimeoutMs }
			: undefined,
	};
}

function screenshotCanBeProbed(
	prepared: Pick<
		PreparedBrowserRun,
		"commandTokens" | "priorSessionTabTarget" | "priorSessionTabTargetUnknown" | "executionPlan"
	>,
): boolean {
	// A cold probe could launch the browser and consume launch-scoped capture flags.
	return (
		prepared.commandTokens[0] === "screenshot" &&
		prepared.priorSessionTabTarget !== undefined &&
		prepared.priorSessionTabTargetUnknown !== true &&
		prepared.executionPlan.startupScopedFlags.length === 0
	);
}

function captureSucceeded(result: AgentBrowserProcessResult): boolean {
	return !result.aborted && !result.timedOut && result.exitCode === 0;
}

async function captureBrowserExecution(
	options: BrowserRunOptions,
	prepared: PreparedBrowserRun,
): Promise<CapturedBrowserExecution> {
	const geometry = geometryProbeOptions(
		options,
		prepared,
		prepared.ownedManagedSessionContext !== undefined,
	);
	const probe = screenshotCanBeProbed(prepared);
	const sample = () =>
		withChromeStartupArgs(prepared.chromeStartupArgs, () => collectScreenshotSample(geometry));
	const before = probe ? await sample() : undefined;
	const artifactRunStartedAtMs = Date.now();
	const processResult = await withChromeStartupArgs(prepared.chromeStartupArgs, () =>
		runAgentBrowserProcess({
			args: prepared.processArgs,
			nativeConfirmationDecision: suppressConfirmationPageHelpers(prepared.readConfirmation),
			cwd: options.cwd,
			env: geometry.env,
			managedSessionRestoreState: options.state.managedSessionRestoreState,
			managedStateCurrentPageUrl: prepared.priorSessionTabTarget?.url,
			managedStatePageUrlUnknown: prepared.priorSessionTabTargetUnknown === true,
			ownedManagedSession: prepared.ownedManagedSessionContext !== undefined,
			signal: options.signal,
			stdin: prepared.processStdin,
			timeoutMs: prepared.processTimeoutMs,
		}),
	);
	const after = probe && captureSucceeded(processResult) ? await sample() : undefined;
	return { before, after, artifactRunStartedAtMs, processResult };
}

async function missingBinaryResult(
	options: Pick<BrowserRunOptions, "implicitSessionCloseTimeoutMs"> & {
		readonly state: Readonly<
			Pick<
				BrowserRunState,
				| "electronChildProcesses"
				| "electronLaunchRecords"
				| "managedSessionActive"
				| "managedSessionName"
				| "managedSessionNamespace"
			>
		>;
	},
	prepared: Pick<
		PreparedBrowserRun,
		| "compatibilityWorkaround"
		| "electronLaunch"
		| "executionPlan"
		| "redactedArgs"
		| "redactedProcessArgs"
		| "sessionMode"
		| "sessionTabCorrection"
	>,
	processResult: AgentBrowserProcessResult,
): Promise<AgentBrowserToolResult | undefined> {
	return buildMissingBinaryFailureResult({
		compatibilityWorkaround: prepared.compatibilityWorkaround,
		electronChildProcesses: options.state.electronChildProcesses,
		electronLaunch: prepared.electronLaunch,
		electronLaunchRecords: options.state.electronLaunchRecords,
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
}

function addCaptureGeometry(
	result: AgentBrowserToolResult,
	capture: CapturedBrowserExecution,
	commandTokens: readonly string[],
): AgentBrowserToolResult {
	if (
		!isRecord(result.details) ||
		!Array.isArray(result.details.imageObservations) ||
		commandTokens[0] !== "screenshot"
	) {
		return result;
	}
	return {
		...result,
		details: {
			...result.details,
			imageObservations: redactSensitiveValue(
				annotateScreenshotImageObservations(result.details.imageObservations, {
					before: capture.before,
					after: capture.after,
				}),
			),
		},
	};
}

async function executePreparedBrowserRun(
	options: BrowserRunOptions,
	prepared: PreparedBrowserRun,
): Promise<AgentBrowserToolResult> {
	try {
		const capture = await captureBrowserExecution(options, prepared);
		const missing = await missingBinaryResult(options, prepared, capture.processResult);
		if (missing) {
			options.state.recordConfirmationPolicy(false);
			return missing;
		}
		// Output presentation is not needed for synchronous registration or failed preparation.
		// Its static host-peer imports retain Pi's loader mapping when loaded on demand.
		const { processBrowserOutput } = await import("./process-output.js");
		const output = await processBrowserOutput({
			...options,
			prepared,
			artifactRunStartedAtMs: capture.artifactRunStartedAtMs,
			processResult: capture.processResult,
		});
		options.state.applyPatch(output.statePatch);
		return addCaptureGeometry(output.result, capture, prepared.commandTokens);
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
}
