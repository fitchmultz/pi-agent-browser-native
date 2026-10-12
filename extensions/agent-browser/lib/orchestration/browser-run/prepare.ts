import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ElectronLaunchSuccess } from "../../electron/launch.js";
import { createFreshSessionName } from "../../runtime.js";
import { getPageTargetValidationError } from "../../page-target-validation.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { withChromeStartupArgs } from "../../process.js";
import { withOwnedManagedSessionContext } from "../../managed-session-restore.js";
import type { PromptPolicy } from "../../prompt-policy.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import { getAgentBrowserSessionIdentityKey } from "../../argv-grammar.js";
import type { PreparationDaemonObservation } from "./managed-session-daemon-inspection.js";
import {
	findElectronLaunchRecordForSession,
	getPersistentSessionArtifactStore,
} from "./session-state.js";
import { normalizeRunInput } from "./prepare-input.js";
import { preparationFailure } from "./prepare-failure.js";
import {
	cleanupPreparationResources,
	prepareArtifactArguments,
	prepareElectronLaunch,
} from "./prepare-resources.js";
import { prepareSessionPlan } from "./prepare-session-plan.js";
import {
	prepareDaemonPolicy,
	prepareChromeStartupArgs,
	type PreparationDaemonPolicy,
	type PreparationDaemonResult,
} from "./prepare-daemon.js";
import { preparePageState } from "./prepare-page-state.js";
import { preparePageSelection, type PreparationPageFacts } from "./prepare-page-selection.js";
import { prepareSemanticAction } from "./prepare-semantic.js";
import { prepareGuardEvidence, validatePreparationGuards } from "./prepare-guards.js";
import { prepareObservations } from "./prepare-observations.js";
import { prepareNativeCommand, type PreparationCommandContext } from "./prepare-command.js";
import type { PreparationSessionFacts } from "./prepare-contracts.js";
import type {
	BrowserRunOptions,
	BrowserRunInputFields,
	BrowserRunState,
	PrepareBrowserRunResult,
} from "./types.js";

export {
	buildInvocationPreview,
	getExactSensitiveStdinValues,
	normalizeRunInput,
	validateStdinCommandContract,
} from "./prepare-input.js";
export { prepareAgentBrowserArgs, repairScreenshotData } from "./prepare-artifacts.js";

interface PreparationRequest {
	readonly input: BrowserRunInputFields;
	readonly freshSessionName: string;
	readonly freshSessionOrdinal: number;
	readonly sessionMode: "auto" | "fresh";
	readonly runtimeToolArgs: readonly string[];
	readonly stdin?: string;
	readonly electronLaunch?: ElectronLaunchSuccess;
}

interface PreparationControls extends PreparationPageFacts {
	readonly modelVisible?: boolean;
	readonly onUpdate?: (result: AgentToolResult<unknown>) => void;
	readonly promptPolicy: PromptPolicy;
	readonly artifactStore?: PersistentSessionArtifactStore;
	readonly initialDaemonObservation?: PreparationDaemonObservation;
}

function rawPageFailure(input: BrowserRunInputFields): PrepareBrowserRunResult | undefined {
	const error = getPageTargetValidationError({
		args: input.toolArgs,
		stdin: input.toolStdin,
		trustedFirstBatchTabSelection: true,
	});
	if (error === undefined || error === "") {
		return undefined;
	}
	return preparationFailure({
		message: error,
		details: {
			args: input.redactedArgs,
			...buildAgentBrowserResultCategoryDetails({
				args: input.redactedArgs,
				errorText: error,
				succeeded: false,
				validationError: error,
			}),
			validationError: error,
		},
	});
}

async function prepareCommandPhases(
	state: BrowserRunState,
	controls: PreparationControls,
	context: PreparationCommandContext & {
		readonly update: BrowserRunOptions["sessionPageStateUpdate"];
	},
): Promise<PrepareBrowserRunResult> {
	const plan = context.semantic.selection.executionPlan;
	const isRestoreDisabled = () =>
		state.managedSessionRestoreState.isDisabled(plan.sessionName, plan.namespace);
	const evidence = prepareGuardEvidence(controls.preserveAttachedBrowserSession, context);
	const guarded = await validatePreparationGuards(
		{
			pageState: state.sessionPageState,
			update: context.update,
			traceOwners: state.traceOwners,
			artifactManifest: state.artifactManifest,
		},
		{ ...controls, isRestoreDisabled },
		context,
		evidence,
	);
	if (guarded) {
		return guarded;
	}
	const observation = await prepareObservations(
		{
			pageState: state.sessionPageState,
			restoreState: state.managedSessionRestoreState,
			update: context.update,
			artifactManifest: state.artifactManifest,
			artifactStore: controls.artifactStore,
		},
		controls,
		context,
		evidence,
	);
	if (observation) {
		return observation;
	}
	return prepareNativeCommand(
		{ ...controls, managedSessionActive: state.managedSessionActive, isRestoreDisabled },
		context,
		evidence,
	);
}

async function preparePagePhases(
	state: BrowserRunState,
	controls: PreparationControls,
	planning: PreparationDaemonResult,
	request: PreparationRequest & {
		readonly preparedArgs: PreparationCommandContext["preparedArgs"];
		readonly chromeStartupArgs?: string;
		readonly update: BrowserRunOptions["sessionPageStateUpdate"];
		readonly sessionFacts: PreparationSessionFacts;
	},
): Promise<PrepareBrowserRunResult> {
	const { plan, session, policy } = planning;
	const initial = controls.initialDaemonObservation;
	// Only admission, filesystem preparation and pure planning precede this use of the root sample.
	// Owned policy omits its sample after native attachment verification; later capture receipts stay fresh.
	const page = await preparePageState(state, controls, {
		plan,
		session,
		inactive: policy.inactive,
		update: request.update,
		preserveAttachedBrowserSession: controls.preserveAttachedBrowserSession,
		generationInspection:
			policy.generationInspection ??
			(!session.ownedManagedSession &&
			initial?.generationInspected === true &&
			initial.identity === getAgentBrowserSessionIdentityKey(plan.sessionName ?? "", plan.namespace)
				? initial.daemon
				: undefined),
	});
	const selection = await preparePageSelection(
		state.sessionPageState,
		controls,
		session.readConfirmation !== undefined,
		{
			...request,
			plan,
			page,
			restoreDisabled: state.managedSessionRestoreState.isDisabled(
				plan.sessionName,
				plan.namespace,
			),
		},
	);
	if ("earlyResult" in selection) {
		return selection.earlyResult;
	}
	const semantic = await prepareSemanticAction(
		controls,
		request.sessionFacts,
		{
			hasReadConfirmation: session.readConfirmation !== undefined,
			ownsSession: session.ownedManagedSession !== undefined,
		},
		{
			...request,
			selection,
		},
	);
	return prepareCommandPhases(state, controls, { ...request, semantic, session, policy });
}

async function prepareRequest(
	identity: Readonly<
		Pick<
			BrowserRunState,
			| "managedSessionBaseName"
			| "ephemeralSessionSeed"
			| "freshSessionOrdinal"
			| "managedSessionActive"
			| "managedSessionName"
		>
	>,
	input: BrowserRunInputFields,
	settings: {
		readonly signal?: AbortSignal;
		readonly sessionMode?: "auto" | "fresh";
		readonly getOwnerSessionId: () => string | undefined;
	},
): Promise<
	{ readonly request: PreparationRequest } | { readonly earlyResult: PrepareBrowserRunResult }
> {
	const freshSessionName = createFreshSessionName(
		identity.managedSessionBaseName,
		identity.ephemeralSessionSeed,
		identity.freshSessionOrdinal + 1,
	);
	const rawFailure = rawPageFailure(input);
	if (rawFailure) {
		return { earlyResult: rawFailure };
	}
	const electron = await prepareElectronLaunch(
		{
			...settings,
			managedSessionActive: identity.managedSessionActive,
			managedSessionName: identity.managedSessionName,
		},
		input,
		freshSessionName,
	);
	if ("earlyResult" in electron) {
		return electron;
	}
	const launch = electron.electronLaunch;
	return {
		request: {
			input,
			freshSessionName,
			freshSessionOrdinal: identity.freshSessionOrdinal,
			sessionMode:
				input.compiledElectron?.action === "launch" ? "fresh" : (settings.sessionMode ?? "auto"),
			runtimeToolArgs: launch ? ["connect", launch.connectArg] : input.toolArgs,
			stdin: launch ? undefined : input.toolStdin,
			electronLaunch: launch,
		},
	};
}

function preparationControls(
	options: Readonly<
		Pick<
			BrowserRunOptions,
			| "cwd"
			| "signal"
			| "params"
			| "modelVisible"
			| "onUpdate"
			| "promptPolicy"
			| "preserveAttachedBrowserSession"
			| "establishAttachedBrowserSession"
			| "ctx"
			| "initialDaemonObservation"
		>
	>,
): PreparationControls {
	return {
		cwd: options.cwd,
		signal: options.signal,
		timeoutMs: options.params.timeoutMs,
		modelVisible: options.modelVisible,
		onUpdate: options.onUpdate,
		promptPolicy: options.promptPolicy,
		preserveAttachedBrowserSession: options.preserveAttachedBrowserSession,
		establishAttachedBrowserSession: options.establishAttachedBrowserSession,
		artifactStore: getPersistentSessionArtifactStore(options.ctx),
		initialDaemonObservation: options.initialDaemonObservation,
	};
}

function preparationSessionFacts(
	state: Readonly<PreparationSessionFacts>,
): PreparationSessionFacts {
	return {
		managedSessionActive: state.managedSessionActive,
		managedSessionName: state.managedSessionName,
		managedSessionNamespace: state.managedSessionNamespace,
		managedSessionCompatibilityWorkaround: state.managedSessionCompatibilityWorkaround,
		managedSessionHeadedAutosaveDisabled: state.managedSessionHeadedAutosaveDisabled,
		managedSessionHeadedAutosaveInterval: state.managedSessionHeadedAutosaveInterval,
	};
}

export async function prepareBrowserRun(
	options: BrowserRunOptions,
): Promise<PrepareBrowserRunResult> {
	const input = normalizeRunInput(options.input);
	const state = options.state;
	const launched = await prepareRequest(state, input, {
		signal: options.signal,
		sessionMode: options.params.sessionMode,
		getOwnerSessionId: () => options.ctx.sessionManager.getSessionId(),
	});
	if ("earlyResult" in launched) {
		return launched.earlyResult;
	}
	const request = launched.request;
	let policy: PreparationDaemonPolicy | undefined;
	let transferred = false;
	try {
		const controls = preparationControls(options);
		const artifacts = await prepareArtifactArguments(controls, {
			args: request.runtimeToolArgs,
			stdin: request.stdin,
			redactedArgs: input.redactedArgs,
		});
		if ("earlyResult" in artifacts) {
			return artifacts.earlyResult;
		}
		const sessionFacts = preparationSessionFacts(state);
		const initial = prepareSessionPlan(
			{
				pageState: state.sessionPageState,
				restoreState: state.managedSessionRestoreState,
				ownedSessions: state.ownedManagedSessions,
			},
			sessionFacts,
			artifacts.preparedArgs,
			{ ...request, cwd: options.cwd, idleTimeoutMs: options.implicitSessionIdleTimeoutMs },
		);
		const planning = await prepareDaemonPolicy(
			controls,
			findElectronLaunchRecordForSession(
				initial.plan.sessionName,
				state.electronLaunchRecords,
				initial.plan.namespace,
			),
			initial,
		);
		policy = planning.policy;
		const chromeStartupArgs = await prepareChromeStartupArgs(
			{
				...controls,
				chromeStartupArgs: options.input.chromeStartupArgs,
				configuredChromeLaunch: options.input.configuredChromeLaunch,
			},
			planning,
			{ preparedArgs: artifacts.preparedArgs, stdin: request.stdin },
		);
		const result = await withChromeStartupArgs(chromeStartupArgs, () =>
			withOwnedManagedSessionContext(planning.session.ownedManagedSession, () =>
				preparePagePhases(state, controls, planning, {
					...request,
					preparedArgs: artifacts.preparedArgs,
					chromeStartupArgs,
					update: options.sessionPageStateUpdate,
					sessionFacts,
				}),
			),
		);
		transferred = result.kind === "ready";
		return result;
	} finally {
		if (!transferred) {
			await cleanupPreparationResources(state, {
				lock: policy?.lock,
				electronLaunch: request.electronLaunch,
				timeoutMs: options.implicitSessionCloseTimeoutMs,
			});
		}
	}
}
