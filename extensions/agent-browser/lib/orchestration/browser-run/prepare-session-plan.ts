import {
	extractExplicitSessionName,
	getBooleanFlagValue,
	isUpstreamEnvFlagEnabled,
	resolveAgentBrowserNamespace,
} from "../../argv-grammar.js";
import { isCloseCommand } from "../../command-taxonomy.js";
import { isBrowserIndependentRead } from "../../command-policy.js";
import {
	isBrowserIndependentConfirmation,
	suppressConfirmationPageHelpers,
	type ReadConfirmation,
} from "../../read-confirmation.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { getPageTargetValidationError } from "../../page-target-validation.js";
import {
	buildExecutionPlan,
	canUseHeadlessCompatibilityUserAgent,
	extractUpstreamCommandTokens,
	getDefaultHeadlessCompatUserAgent,
} from "../../runtime.js";
import {
	buildOwnedManagedSessionRestoreContext,
	resolveExplicitAutosaveInterval,
	type OwnedManagedSessionContext,
	type ManagedSessionRestoreState,
} from "../../managed-session-restore.js";
import { getRunningHeadedAutosavePolicyChangeError } from "./managed-session-daemon-policy.js";
import { getSessionContextKey } from "./session-state.js";
import type { SessionPageState } from "../../session-page-state.js";
import type { ExecutionPlan as AgentBrowserExecutionPlan } from "../../runtime-contracts.js";
import type { PreparationSessionFacts } from "./prepare-contracts.js";

export interface PreparationSessionOwners {
	readonly pageState: SessionPageState;
	readonly restoreState: ManagedSessionRestoreState;
	readonly ownedSessions: ReadonlyMap<string, OwnedManagedSessionReference>;
}
import type { OwnedManagedSessionReference, PreparedAgentBrowserArgs } from "./types.js";

export interface PreparationSessionPlan {
	readonly hasPriorRefs: boolean;
	readonly browserIndependent: boolean;
	readonly readConfirmation?: ReadConfirmation;
	readonly recordedOwnedSession?: OwnedManagedSessionReference;
	readonly ownedManagedSession?: OwnedManagedSessionContext;
	readonly offCurrentLaunchScopedFlags: readonly string[];
	readonly offCurrentCompatibilityUpgrade: boolean;
	readonly compatibilityUserAgent?: string;
	readonly compatibilityUserAgentApplied: boolean;
	readonly headedLaunch: boolean;
	readonly providerLaunch: boolean;
}

export function withPlanValidationError(
	plan: AgentBrowserExecutionPlan,
	error: string,
): AgentBrowserExecutionPlan {
	return { ...plan, recoveryHint: undefined, validationError: error };
}

export function planHasValidationError(plan: AgentBrowserExecutionPlan): boolean {
	return plan.validationError !== undefined && plan.validationError.length > 0;
}

function getIdleTimeoutMismatch(
	args: readonly string[],
	configuredValue: string,
): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== "--idle-timeout") {
			continue;
		}
		const requestedToken = args.at(++index);
		if (
			requestedToken === undefined ||
			requestedToken === "" ||
			!/^\d+$/.test(requestedToken) ||
			Number(requestedToken) === Number(configuredValue)
		) {
			continue;
		}
		return `--idle-timeout ${requestedToken} conflicts with this Pi process's managed-session idle timeout (${configuredValue} ms). Restart Pi with PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS=${requestedToken} and omit --idle-timeout; changing the launch value for one call can restart the upstream browser and discard the active tab.`;
	}
	return undefined;
}

function validatePlannedPage(
	page: ReturnType<SessionPageState["get"]>,
	plan: AgentBrowserExecutionPlan,
	request: {
		readonly stdin?: string;
		readonly hasReadConfirmation: boolean;
	},
): AgentBrowserExecutionPlan {
	if (request.hasReadConfirmation && plan.commandInfo.command !== "batch") {
		return plan;
	}
	const error = getPageTargetValidationError({
		allowFirstBatchConfirmation: request.hasReadConfirmation,
		args: plan.effectiveArgs,
		currentPageUrl: page.tabTarget?.url,
		pageUrlUnknown: page.tabTargetUnknown === true,
		stdin: request.stdin,
	});
	return !planHasValidationError(plan) && error !== undefined && error !== ""
		? withPlanValidationError(plan, error)
		: plan;
}

function restoreOffCurrentCompatibility(
	plan: AgentBrowserExecutionPlan,
	request: {
		readonly offCurrent: boolean;
		readonly browserIndependent: boolean;
		readonly recorded?: OwnedManagedSessionReference;
		readonly args: readonly string[];
	},
): AgentBrowserExecutionPlan {
	if (
		request.browserIndependent ||
		!request.offCurrent ||
		!canUseHeadlessCompatibilityUserAgent(request.args, getAgentBrowserProcessEnvironment())
	) {
		return plan;
	}
	const workaround = plan.compatibilityWorkaround ?? request.recorded?.compatibilityWorkaround;
	if (!workaround) {
		return plan;
	}
	const index = plan.effectiveArgs.indexOf("--user-agent");
	return {
		...plan,
		compatibilityWorkaround: workaround,
		effectiveArgs:
			index < 0
				? plan.effectiveArgs
				: [...plan.effectiveArgs.slice(0, index), ...plan.effectiveArgs.slice(index + 2)],
	};
}

function retainedAutosaveSettings(
	facts: PreparationSessionFacts,
	request: {
		readonly recorded?: OwnedManagedSessionReference;
		readonly targetsCurrent: boolean;
	},
): { readonly retainedDisabled: boolean; readonly retainedInterval?: string } {
	const retainedDisabled =
		request.recorded?.headedManagedAutosaveDisabled === true ||
		(request.targetsCurrent && facts.managedSessionHeadedAutosaveDisabled === true);
	const retainedInterval =
		request.recorded?.headedManagedAutosaveInterval ??
		(request.targetsCurrent ? facts.managedSessionHeadedAutosaveInterval : undefined);
	return { retainedDisabled, retainedInterval };
}

function autosaveSettings(
	plan: AgentBrowserExecutionPlan,
	retained: ReturnType<typeof retainedAutosaveSettings>,
	browserIndependent: boolean,
): {
	readonly executionPlan: AgentBrowserExecutionPlan;
	readonly headedLaunch: boolean;
	readonly disabled: boolean;
	readonly interval?: string;
	readonly retainedDisabled: boolean;
	readonly retainedInterval?: string;
} {
	const env = getAgentBrowserProcessEnvironment();
	const explicitInterval = resolveExplicitAutosaveInterval(env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS);
	const error = getRunningHeadedAutosavePolicyChangeError(
		retained.retainedInterval,
		isCloseCommand(plan.commandInfo.command),
	);
	const executionPlan =
		!browserIndependent && !planHasValidationError(plan) && error !== undefined
			? withPlanValidationError(plan, error)
			: plan;
	const headedLaunch =
		getBooleanFlagValue(plan.effectiveArgs, "--headed") ??
		isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_HEADED);
	return {
		executionPlan,
		headedLaunch,
		...retained,
		disabled: retained.retainedDisabled || (explicitInterval === undefined && headedLaunch),
		interval: retained.retainedInterval ?? (headedLaunch ? (explicitInterval ?? "0") : undefined),
	};
}

function ownedRestoreContext(
	restoreState: ManagedSessionRestoreState,
	facts: PreparationSessionFacts,
	plan: AgentBrowserExecutionPlan,
	request: {
		readonly cwd: string;
		readonly browserIndependent: boolean;
		readonly recorded?: OwnedManagedSessionReference;
		readonly targetsCurrent: boolean;
		readonly autosave: Omit<ReturnType<typeof autosaveSettings>, "executionPlan">;
		readonly compatibilityUserAgent?: string;
		readonly compatibilityUserAgentApplied: boolean;
		readonly stdin?: string;
	},
): OwnedManagedSessionContext | undefined {
	if (request.browserIndependent && !request.recorded && !request.targetsCurrent) {
		return undefined;
	}
	return buildOwnedManagedSessionRestoreContext({
		args: plan.effectiveArgs,
		reuseOnly: request.browserIndependent,
		cwd: request.recorded?.cwd ?? request.cwd,
		currentManagedSessionName: facts.managedSessionName,
		currentManagedSessionNamespace: facts.managedSessionNamespace,
		headedManagedAutosaveDisabled: request.browserIndependent
			? request.autosave.retainedDisabled
			: request.autosave.disabled,
		headedManagedAutosaveInterval: request.browserIndependent
			? request.autosave.retainedInterval
			: request.autosave.interval,
		managedSessionName: plan.managedSessionName,
		namespace: plan.namespace,
		parentEnv: getAgentBrowserProcessEnvironment(),
		recordedOwnedSession: request.recorded,
		restoreState,
		sessionName: plan.sessionName,
		stdin: request.stdin,
		compatibilityUserAgent: request.compatibilityUserAgentApplied
			? request.compatibilityUserAgent
			: undefined,
		wrapperInjectedUserAgent: request.compatibilityUserAgentApplied,
	});
}

function validateManagedIdle(
	facts: PreparationSessionFacts,
	plan: AgentBrowserExecutionPlan,
	request: {
		readonly browserIndependent: boolean;
		readonly recorded?: OwnedManagedSessionReference;
		readonly targetsCurrent: boolean;
		readonly args: readonly string[];
		readonly idleTimeoutMs: string;
	},
): AgentBrowserExecutionPlan {
	const owned =
		(plan.managedSessionName !== undefined && plan.managedSessionName !== "") ||
		request.recorded !== undefined ||
		request.targetsCurrent ||
		(facts.managedSessionActive && extractExplicitSessionName(request.args) === undefined);
	if (request.browserIndependent || !owned) {
		return plan;
	}
	const error = getIdleTimeoutMismatch(request.args, request.idleTimeoutMs);
	return error !== undefined && error !== "" ? withPlanValidationError(plan, error) : plan;
}

function prepareNativePlan(
	pageState: SessionPageState,
	facts: PreparationSessionFacts,
	preparedArgs: PreparedAgentBrowserArgs,
	request: {
		readonly freshSessionName: string;
		readonly sessionMode: "auto" | "fresh";
		readonly stdin?: string;
	},
): {
	readonly plan: AgentBrowserExecutionPlan;
	readonly browserIndependent: boolean;
	readonly readConfirmation?: ReadConfirmation;
} {
	const env = getAgentBrowserProcessEnvironment();
	const routed = pageState.findReadConfirmation(
		preparedArgs.args,
		resolveAgentBrowserNamespace(preparedArgs.args, env.AGENT_BROWSER_NAMESPACE),
		request.stdin,
	);
	const readConfirmation = suppressConfirmationPageHelpers(routed) ? routed : undefined;
	const independentConfirmation = isBrowserIndependentConfirmation(readConfirmation);
	let plan = buildExecutionPlan(preparedArgs.args, {
		freshSessionName: request.freshSessionName,
		managedSessionActive: facts.managedSessionActive,
		managedSessionCompatibilityWorkaround: facts.managedSessionCompatibilityWorkaround,
		managedSessionName: facts.managedSessionName,
		managedSessionNamespace: facts.managedSessionNamespace,
		sessionMode: request.sessionMode,
		stdin: request.stdin,
		browserIndependentReadConfirmation: independentConfirmation,
	});
	const browserIndependent =
		independentConfirmation ||
		isBrowserIndependentRead(extractUpstreamCommandTokens(preparedArgs.args), request.stdin) ||
		(plan.commandInfo.command === "session" && plan.commandInfo.subcommand === "info");
	plan = validatePlannedPage(
		pageState.get(getSessionContextKey(plan.sessionName, plan.namespace)),
		plan,
		{ stdin: request.stdin, hasReadConfirmation: readConfirmation !== undefined },
	);
	return { plan, browserIndependent, readConfirmation };
}

function sessionOwnership(
	ownedSessions: ReadonlyMap<string, OwnedManagedSessionReference>,
	facts: PreparationSessionFacts,
	plan: AgentBrowserExecutionPlan,
): {
	readonly recorded?: OwnedManagedSessionReference;
	readonly targetsCurrent: boolean;
	readonly offCurrent: boolean;
} {
	const key = getSessionContextKey(plan.sessionName, plan.namespace);
	const recorded = key !== undefined && key !== "" ? ownedSessions.get(key) : undefined;
	const targetsCurrent =
		facts.managedSessionActive &&
		key === getSessionContextKey(facts.managedSessionName, facts.managedSessionNamespace);
	return { recorded, targetsCurrent, offCurrent: recorded !== undefined && !targetsCurrent };
}

function compatibilityLaunchFacts(
	plan: AgentBrowserExecutionPlan,
): Pick<PreparationSessionPlan, "compatibilityUserAgent" | "compatibilityUserAgentApplied"> {
	const compatibilityUserAgent = plan.compatibilityWorkaround
		? getDefaultHeadlessCompatUserAgent()
		: undefined;
	return {
		compatibilityUserAgent,
		compatibilityUserAgentApplied:
			compatibilityUserAgent !== undefined &&
			plan.effectiveArgs.some(
				(token, index) =>
					token === "--user-agent" && plan.effectiveArgs[index + 1] === compatibilityUserAgent,
			),
	};
}

export function prepareSessionPlan(
	owners: PreparationSessionOwners,
	facts: PreparationSessionFacts,
	preparedArgs: PreparedAgentBrowserArgs,
	request: {
		readonly cwd: string;
		readonly idleTimeoutMs: string;
		readonly freshSessionName: string;
		readonly sessionMode: "auto" | "fresh";
		readonly stdin?: string;
	},
): { readonly plan: AgentBrowserExecutionPlan; readonly session: PreparationSessionPlan } {
	const native = prepareNativePlan(owners.pageState, facts, preparedArgs, request);
	const { browserIndependent, readConfirmation } = native;
	let plan = native.plan;
	const { recorded, targetsCurrent, offCurrent } = sessionOwnership(
		owners.ownedSessions,
		facts,
		plan,
	);
	plan = validateManagedIdle(facts, plan, {
		idleTimeoutMs: request.idleTimeoutMs,
		browserIndependent,
		recorded,
		targetsCurrent,
		args: preparedArgs.args,
	});
	const offCurrentLaunchScopedFlags = offCurrent
		? plan.startupScopedFlags.filter((flag) => flag !== "--namespace")
		: [];
	const offCurrentCompatibilityUpgrade =
		offCurrent &&
		plan.compatibilityWorkaround !== undefined &&
		recorded?.compatibilityWorkaround === undefined;
	plan = restoreOffCurrentCompatibility(plan, {
		offCurrent,
		browserIndependent,
		recorded,
		args: preparedArgs.args,
	});
	const { executionPlan: autosavePlan, ...autosave } = autosaveSettings(
		plan,
		retainedAutosaveSettings(facts, { recorded, targetsCurrent }),
		browserIndependent,
	);
	plan = autosavePlan;
	const { compatibilityUserAgent, compatibilityUserAgentApplied } = compatibilityLaunchFacts(plan);
	const ownedManagedSession = ownedRestoreContext(owners.restoreState, facts, plan, {
		cwd: request.cwd,
		browserIndependent,
		recorded,
		targetsCurrent,
		autosave,
		compatibilityUserAgent,
		compatibilityUserAgentApplied,
		stdin: request.stdin,
	});
	return {
		plan,
		session: {
			hasPriorRefs:
				(owners.pageState.get(getSessionContextKey(plan.sessionName, plan.namespace)).refSnapshot
					?.refIds.length ?? 0) > 0,
			browserIndependent,
			readConfirmation,
			recordedOwnedSession: recorded,
			ownedManagedSession,
			offCurrentLaunchScopedFlags,
			offCurrentCompatibilityUpgrade,
			compatibilityUserAgent,
			compatibilityUserAgentApplied,
			headedLaunch: autosave.headedLaunch,
			providerLaunch:
				plan.startupScopedFlags.some((flag) => flag === "--provider" || flag === "-p") ||
				getAgentBrowserProcessEnvironment().AGENT_BROWSER_PROVIDER !== undefined,
		},
	};
}
