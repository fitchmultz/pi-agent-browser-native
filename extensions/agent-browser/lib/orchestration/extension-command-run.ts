import { randomUUID } from "node:crypto";
import { appendBrowserTransition, type BrowserRecord } from "../browser-transcript.js";
import { appendBrowserRecord } from "../browser-journal.js";
import { buildExecutionPlan, createFreshSessionName, redactInvocationArgs } from "../runtime.js";
import { getAgentBrowserSessionIdentityKey } from "../argv-grammar.js";
import { parseArgvDescriptor } from "../argv-descriptor.js";
import { needsManagedSession } from "../command-policy.js";
import { isRecord } from "../parsing.js";
import { resolveAgentBrowserSocketDir } from "../process.js";
import { getAgentBrowserProcessEnvironment } from "../process-environment.js";
// Static ownership keeps the runner's host peers inside Pi's extension-module mapping.
import { runAgentBrowserTool } from "./browser-run/index.js";
import type { AgentBrowserToolResult, BrowserRunState } from "./browser-run/types.js";
import { getSessionContextKey } from "./browser-run/session-state.js";
import {
	ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
	ELECTRON_PROFILE_ISOLATION_DETAILS,
} from "./electron-host/index.js";
import { browserExecutionFailure } from "./extension-result-state.js";
import { isAttachedBrowserInvocation } from "./extension-resource-replay.js";
import type { BrowserRuntime } from "./extension-runtime.js";
import type { BrowserCommandCall } from "./extension-invocation.js";
import type {
	BrowserCommandPreparation,
	BrowserCommandDispatch,
} from "./extension-command-state.js";
import { BrowserCommandResult } from "./extension-command-result.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionPageState } from "../session-page-state.js";
import type { PreparationDaemonObservation } from "./browser-run/managed-session-daemon-inspection.js";

function captureBrowserRunState(runtime: BrowserRuntime): BrowserRunState {
	return {
		activeRecordingReservations: runtime.recordings.active,
		artifactManifest: runtime.artifacts.manifest,
		attachedSessionKeys: runtime.sessions.attached,
		closedManagedSessionNames: new Set<string>(),
		electronChildProcesses: runtime.electron.childProcesses,
		electronLaunchRecords: runtime.electron.records,
		ephemeralSessionSeed: runtime.ephemeralSessionSeed,
		freshSessionOrdinal: runtime.managed.freshOrdinal,
		managedSessionActive: runtime.managed.active,
		managedSessionBaseName: runtime.managed.baseName,
		managedSessionCompatibilityWorkaround: runtime.managed.compatibilityWorkaround,
		managedSessionHeadedAutosaveDisabled: runtime.managed.headedAutosaveDisabled,
		managedSessionHeadedAutosaveInterval: runtime.managed.headedAutosaveInterval,
		managedSessionCwd: runtime.managed.cwd,
		managedSessionName: runtime.managed.name,
		managedSessionNamespace: runtime.managed.namespace,
		managedSessionRestoreState: runtime.managed.restore,
		networkRoutesBySession: runtime.sessions.routes,
		ownedManagedSessions: runtime.managed.owned,
		sessionPageState: runtime.sessions.pages.fork(),
		traceOwners: runtime.sessions.traces,
	};
}
function selectCommandPlan(
	state: Readonly<
		Pick<
			BrowserRunState,
			| "managedSessionBaseName"
			| "ephemeralSessionSeed"
			| "freshSessionOrdinal"
			| "managedSessionActive"
			| "managedSessionCompatibilityWorkaround"
			| "managedSessionName"
			| "managedSessionNamespace"
		>
	>,
	call: Pick<
		BrowserCommandCall,
		"toolArgs" | "compiledElectron" | "params" | "resolvedInput" | "readConfirmation"
	>,
): ReturnType<typeof buildExecutionPlan> {
	return buildExecutionPlan(call.toolArgs, {
		freshSessionName: createFreshSessionName(
			state.managedSessionBaseName,
			state.ephemeralSessionSeed,
			state.freshSessionOrdinal + 1,
		),
		managedSessionActive: state.managedSessionActive,
		managedSessionCompatibilityWorkaround: state.managedSessionCompatibilityWorkaround,
		managedSessionName: state.managedSessionName,
		managedSessionNamespace: state.managedSessionNamespace,
		sessionMode:
			call.compiledElectron?.action === "launch" ? "fresh" : (call.params.sessionMode ?? "auto"),
		stdin: call.resolvedInput.toolStdin,
		browserIndependentReadConfirmation:
			call.readConfirmation?.capabilities?.readRequiresConfirmation === true,
	});
}
function affectsBrowser(
	plan: ReturnType<typeof buildExecutionPlan>,
	call: BrowserCommandCall,
): boolean {
	if (
		plan.plainTextInspection ||
		(plan.commandInfo.command === "session" && plan.commandInfo.subcommand === "info")
	) {
		return false;
	}
	return (
		needsManagedSession(parseArgvDescriptor(call.toolArgs), call.resolvedInput.toolStdin) ||
		plan.startupScopedFlags.length > 0
	);
}
function createBeginRecord(
	call: Pick<BrowserCommandCall, "toolArgs" | "ctx" | "toolCallId" | "commandIndex" | "browserCwd">,
	identity: Readonly<{
		plan: ReturnType<typeof buildExecutionPlan>;
		operationId: string;
		selectedKey: string;
		confirmActions: string | undefined;
		readonly wrapperManaged: boolean;
	}>,
): BrowserRecord {
	const wrapperManaged = identity.wrapperManaged;
	return {
		event: {
			version: 1,
			phase: "begin",
			operationId: identity.operationId,
			toolCallId: call.toolCallId,
			commandIndex: call.commandIndex ?? 0,
			isError: true,
			state: {
				args: redactInvocationArgs(call.toolArgs),
				sessionName: identity.plan.sessionName,
				namespace: identity.plan.namespace,
				ownerSessionId: call.ctx.sessionManager.getSessionId(),
				usedImplicitSession: identity.plan.usedImplicitSession,
				wrapperManaged,
				managedSessionCwd: call.browserCwd,
				managedSessionSocketDir: resolveAgentBrowserSocketDir({
					ownedManagedSession: wrapperManaged,
				}),
			},
			pages: [
				{
					key: identity.selectedKey,
					confirmActions: identity.confirmActions ?? null,
					refs: { kind: "unknown" },
					unknown: true,
				},
			],
		},
	};
}
function prepareBrowserCommand(
	runtime: BrowserRuntime,
	call: BrowserCommandCall,
	executionSignal: AbortSignal | undefined,
): BrowserCommandPreparation {
	runtime.recordings.flush();
	const generationAtStart = runtime.branch.stateGeneration;
	const browserRunState = captureBrowserRunState(runtime);
	const workingPageState = browserRunState.sessionPageState;
	const priorPages = workingPageState.views();
	const sessionPageStateUpdate = workingPageState.beginUpdate();
	const selectedPlan = selectCommandPlan(browserRunState, call);
	const operationId = randomUUID();
	const selectedKey = getAgentBrowserSessionIdentityKey(
		selectedPlan.sessionName ?? "default",
		selectedPlan.namespace,
	);
	browserRunState.confirmationPolicyIdentity = selectedKey;
	const confirmActions = getAgentBrowserProcessEnvironment().AGENT_BROWSER_CONFIRM_ACTIONS;
	workingPageState.setConfirmActions(selectedKey, confirmActions);
	const begin = createBeginRecord(call, {
		plan: selectedPlan,
		operationId,
		selectedKey,
		confirmActions,
		wrapperManaged:
			selectedPlan.managedSessionName !== undefined || runtime.managed.owned.has(selectedKey),
	});
	return {
		generationAtStart,
		browserRunState,
		workingPageState,
		priorPages,
		sessionPageStateUpdate,
		selectedPlan,
		operationId,
		selectedKey,
		begin,
		browserAffecting: affectsBrowser(selectedPlan, call),
		executionSignal,
	};
}
async function admitBrowserCommand(
	pi: ExtensionAPI,
	pages: SessionPageState,
	call: Pick<BrowserCommandCall, "ctx" | "branch">,
	prepared: Pick<BrowserCommandPreparation, "browserAffecting" | "begin" | "executionSignal">,
): Promise<AgentBrowserToolResult | undefined> {
	if (!prepared.browserAffecting) {
		return undefined;
	}
	try {
		if (
			!(await appendBrowserRecord(
				call.ctx.sessionManager,
				() => appendBrowserTransition(pi, prepared.begin),
				prepared.begin,
				call.branch,
			)) ||
			!call.branch.isCurrent()
		) {
			throw new Error("The selected Pi branch changed before browser-command admission.");
		}
	} catch (error) {
		const failure = browserExecutionFailure(
			new Error("Could not persist browser-state begin; the browser command was not run.", {
				cause: error,
			}),
			prepared.executionSignal,
		);
		return {
			...failure,
			details: {
				...(isRecord(failure.details) ? failure.details : {}),
				browserStatePersistence: "begin-unconfirmed",
			},
		};
	}
	pages.applyBrowserRecord(prepared.begin);
	return undefined;
}
function captureDispatch(
	attachedSessionKeys: ReadonlySet<string>,
	call: Pick<BrowserCommandCall, "resolvedInput" | "toolArgs" | "explicitSessionName" | "params">,
	prepared: Pick<BrowserCommandPreparation, "selectedPlan" | "browserRunState">,
): BrowserCommandDispatch {
	const electronLaunch =
		call.resolvedInput.kind === "electron" &&
		call.resolvedInput.compiledElectron.action === "launch";
	const attachedSessionRequested = isAttachedBrowserInvocation(call.toolArgs) || electronLaunch;
	const allocatesFreshManagedSession =
		call.explicitSessionName === undefined &&
		(call.params.sessionMode === "fresh" || electronLaunch);
	const reusableSessionKey = allocatesFreshManagedSession
		? undefined
		: (getSessionContextKey(prepared.selectedPlan.sessionName, prepared.selectedPlan.namespace) ??
			getSessionContextKey(
				prepared.browserRunState.managedSessionName,
				prepared.browserRunState.managedSessionNamespace,
			));
	return {
		initialArtifactManifest: prepared.browserRunState.artifactManifest,
		initialNetworkRoutesBySession: prepared.browserRunState.networkRoutesBySession,
		attachedSessionRequested,
		attachedSessionKnown:
			reusableSessionKey !== undefined && attachedSessionKeys.has(reusableSessionKey),
	};
}
async function dispatchBrowserCommand(
	timeouts: Readonly<{ close: number; idle: string }>,
	call: BrowserCommandCall,
	prepared: Pick<
		BrowserCommandPreparation,
		"browserRunState" | "sessionPageStateUpdate" | "executionSignal"
	>,
	dispatch: BrowserCommandDispatch &
		Readonly<{ initialDaemonObservation?: PreparationDaemonObservation }>,
): Promise<AgentBrowserToolResult> {
	try {
		return await runAgentBrowserTool({
			initialDaemonObservation: dispatch.initialDaemonObservation,
			ctx: call.ctx,
			cwd: call.browserCwd,
			operationCwd: call.operationCwd,
			electronPostCommandStatusSettleMs: ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
			electronProfileIsolationDetails: ELECTRON_PROFILE_ISOLATION_DETAILS,
			implicitSessionCloseTimeoutMs: timeouts.close,
			implicitSessionIdleTimeoutMs: timeouts.idle,
			input: call.resolvedInput,
			modelVisible: call.modelVisible,
			onUpdate: call.onUpdate,
			params: call.params,
			establishAttachedBrowserSession:
				dispatch.attachedSessionRequested && !dispatch.attachedSessionKnown,
			preserveAttachedBrowserSession:
				dispatch.attachedSessionRequested || dispatch.attachedSessionKnown,
			promptPolicy: call.promptPolicy,
			sessionPageStateUpdate: prepared.sessionPageStateUpdate,
			signal: prepared.executionSignal,
			state: prepared.browserRunState,
		});
	} catch (error) {
		const failure = browserExecutionFailure(error, prepared.executionSignal);
		return {
			...failure,
			details: {
				...prepared.browserRunState.observedBrowserEffects,
				...(isRecord(failure.details) ? failure.details : {}),
			},
		};
	}
}
export async function runBrowserCommand(
	runtime: BrowserRuntime,
	call: BrowserCommandCall,
	initialDaemonObservation?: PreparationDaemonObservation,
	executionSignal = call.signal,
): Promise<AgentBrowserToolResult> {
	const prepared = prepareBrowserCommand(runtime, call, executionSignal);
	const admissionFailure = await admitBrowserCommand(
		runtime.pi,
		runtime.sessions.pages,
		call,
		prepared,
	);
	if (admissionFailure) {
		return admissionFailure;
	}
	const dispatch = captureDispatch(runtime.sessions.attached, call, prepared);
	const result = await dispatchBrowserCommand(
		{ close: runtime.implicitSessionCloseTimeoutMs, idle: runtime.implicitSessionIdleTimeoutMs },
		call,
		prepared,
		{
			...dispatch,
			initialDaemonObservation,
		},
	);
	const completion = new BrowserCommandResult(runtime, call, prepared, { ...dispatch, result });
	completion.reconcileNativeIdentity();
	completion.reconcileAttachments();
	completion.mergeResultArtifacts();
	completion.adoptRuntime();
	const persistenceFailure = await completion.persistFinish();
	if (persistenceFailure) {
		return persistenceFailure;
	}
	return completion.complete();
}
