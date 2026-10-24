import type { ElectronLaunchSuccess } from "../../electron/launch.js";
import { prepareAgentBrowserSpawnArgs } from "../../process.js";
import { redactInvocationArgs } from "../../runtime-redaction.js";
import { getBooleanFlagValue } from "../../argv-grammar.js";
import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { needsManagedSession } from "../../command-policy.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PreparationProcessFacts } from "./prepare-contracts.js";

export interface PreparationNativeFacts extends PreparationProcessFacts {
	readonly managedSessionActive: boolean;
	readonly preserveAttachedBrowserSession?: boolean;
	readonly callerColdLaunch?: () => Promise<boolean>;
	readonly isRestoreDisabled: () => boolean;
	readonly onUpdate?: (result: AgentToolResult<unknown>) => void;
}
import { prepareClickDispatchProbe } from "./click-dispatch.js";
import { collectScrollPositionSnapshot } from "./diagnostics.js";
import { preparationSessionDetails } from "./prepare-failure.js";
import { buildInvocationPreview } from "./prepare-input.js";
import { prepareProcessTimeout } from "./prepare-timeouts.js";
import type { PreparationGuardContext, PreparationGuardEvidence } from "./prepare-guards.js";
import type {
	PreparedAgentBrowserArgs,
	PreparedBrowserRun,
	PrepareBrowserRunResult,
} from "./types.js";

export interface PreparationCommandContext extends PreparationGuardContext {
	readonly preparedArgs: PreparedAgentBrowserArgs;
	readonly runtimeToolArgs: readonly string[];
	readonly electronLaunch?: ElectronLaunchSuccess;
}

function shouldProbeScrollNoop(
	managedSessionActive: boolean,
	context: Pick<PreparationCommandContext, "semantic" | "sessionMode">,
): boolean {
	const plan = context.semantic.selection.executionPlan;
	const amount = Number(
		context.semantic.commandTokens.find((token) => /^\d+(?:\.\d+)?$/.test(token)),
	);
	return (
		plan.commandInfo.command === "scroll" &&
		plan.startupScopedFlags.length === 0 &&
		(managedSessionActive || context.sessionMode === "fresh") &&
		(!Number.isFinite(amount) || amount >= 500)
	);
}

function redactedSemanticAction(
	context: Pick<PreparationCommandContext, "input" | "semantic">,
): PreparedBrowserRun["redactedCompiledSemanticAction"] {
	const compiled = context.input.redactedCompiledSemanticAction;
	return context.semantic.resolution && compiled?.action === "select"
		? { ...compiled, args: redactInvocationArgs(context.semantic.resolution.args) }
		: compiled;
}

type NativeCommandEvidence = Pick<
	PreparedBrowserRun,
	| "processArgs"
	| "processStdin"
	| "processTimeoutMs"
	| "clickDispatchProbe"
	| "redactedProcessArgs"
	| "shouldProbeScrollNoop"
	| "scrollPositionBefore"
>;

async function nativeCommandEvidence(
	facts: PreparationNativeFacts,
	context: PreparationCommandContext,
): Promise<NativeCommandEvidence> {
	const plan = context.semantic.selection.executionPlan;
	const page = context.semantic.selection.page;
	const promptSnapshot = context.semantic.resolvedSnapshot ?? page.priorRefSnapshotState;
	const processStdin = context.preparedArgs.stdin ?? context.stdin;
	const processTimeoutMs = await prepareProcessTimeout(facts, {
		commandTokens: context.semantic.commandTokens,
		namespace: plan.namespace,
		sessionName: plan.sessionName,
		stdin: processStdin,
		pageUrl: page.priorSessionTabTarget?.url,
		refSnapshot: promptSnapshot,
	});
	const clickDispatchProbe =
		context.input.compiledElectron === undefined
			? await prepareClickDispatchProbe({
					commandTokens: [...context.semantic.commandTokens],
					cwd: facts.cwd,
					namespace: plan.namespace,
					refSnapshot: promptSnapshot,
					sessionName: plan.sessionName,
					signal: facts.signal,
					timeoutMs: processTimeoutMs,
				})
			: undefined;
	const redactedProcessArgs = redactInvocationArgs(
		prepareAgentBrowserSpawnArgs(
			plan.effectiveArgs,
			context.session.ownedManagedSession?.compatibilityUserAgent,
			facts.preserveAttachedBrowserSession,
			context.chromeStartupArgs,
		),
	);
	const probeScroll = shouldProbeScrollNoop(facts.managedSessionActive, context);
	const scrollPositionBefore = probeScroll
		? await collectScrollPositionSnapshot({
				cwd: facts.cwd,
				namespace: plan.namespace,
				sessionName: plan.sessionName,
				signal: facts.signal,
			})
		: undefined;
	facts.onUpdate?.({
		content: [
			{
				type: "text",
				text: `Running agent-browser ${buildInvocationPreview(redactedProcessArgs)}`,
			},
		],
		details: {
			compatibilityWorkaround: plan.compatibilityWorkaround,
			effectiveArgs: redactedProcessArgs,
			sessionMode: context.sessionMode,
			sessionTabCorrection: context.semantic.selection.sessionTabCorrection,
			...preparationSessionDetails(facts.isRestoreDisabled(), plan),
		},
	});
	return {
		processArgs: plan.effectiveArgs,
		processStdin,
		processTimeoutMs,
		clickDispatchProbe,
		redactedProcessArgs,
		shouldProbeScrollNoop: probeScroll,
		scrollPositionBefore,
	};
}

export async function prepareNativeCommand(
	facts: PreparationNativeFacts,
	context: PreparationCommandContext,
	evidence: PreparationGuardEvidence,
): Promise<PrepareBrowserRunResult> {
	const native = await nativeCommandEvidence(facts, context);
	const plan = context.semantic.selection.executionPlan;
	const page = context.semantic.selection.page;
	const input = context.input;
	const callerColdLaunch =
		!context.session.browserIndependent &&
		needsManagedSession(parseArgvDescriptor(plan.effectiveArgs), native.processStdin) &&
		facts.preserveAttachedBrowserSession !== true &&
		(await facts.callerColdLaunch?.()) === true;
	return {
		kind: "ready",
		prepared: {
			callerColdLaunch: callerColdLaunch ? true : undefined,
			compiledElectron: input.compiledElectron,
			compiledJob: input.compiledJob,
			compiledNetworkSourceLookup: input.compiledNetworkSourceLookup,
			compiledQaPreset: input.compiledQaPreset,
			compiledSemanticAction: input.compiledSemanticAction,
			compiledSourceLookup: input.compiledSourceLookup,
			redactedArgs: input.redactedArgs,
			redactedCompiledElectron: input.redactedCompiledElectron,
			redactedCompiledJob: input.redactedCompiledJob,
			redactedCompiledNetworkSourceLookup: input.redactedCompiledNetworkSourceLookup,
			redactedCompiledQaPreset: input.redactedCompiledQaPreset,
			redactedCompiledSourceLookup: input.redactedCompiledSourceLookup,
			...native,
			chromeStartupArgs: context.chromeStartupArgs,
			commandTokens: [...context.semantic.commandTokens],
			headedLaunch: context.session.headedLaunch,
			providerLaunch: context.session.providerLaunch,
			managedSessionPolicyLock: context.policy.lock,
			compatibilityWorkaround: plan.compatibilityWorkaround,
			electronLaunch: context.electronLaunch,
			exactSensitiveValues: [...evidence.exactSensitiveValues],
			executionPlan: plan,
			ownedManagedSessionContext: context.session.ownedManagedSession,
			preparedArgs: context.preparedArgs,
			readConfirmation: context.session.readConfirmation,
			priorRefSnapshotState: page.priorRefSnapshotState,
			priorSessionTabTarget: page.priorSessionTabTarget,
			priorSessionTabTargetUnknown: page.priorSessionTabTargetUnknown,
			redactedCompiledSemanticAction: redactedSemanticAction(context),
			redactedEffectiveArgs: [...evidence.redactedEffectiveArgs],
			redactedRecoveryHint: evidence.redactedRecoveryHint,
			resolvedSemanticActionRefSnapshot: context.semantic.resolvedSnapshot,
			runtimeToolArgs: [...context.runtimeToolArgs],
			runtimeToolStdin: context.stdin,
			sessionMode: context.sessionMode,
			sessionTabCorrection: context.semantic.selection.sessionTabCorrection,
			sessionTabPinningReason: page.sessionTabPinningReason,
			statePatch: evidence.statePatch,
			userRequestedJson: getBooleanFlagValue(context.runtimeToolArgs, "--json") === true,
		},
	};
}
