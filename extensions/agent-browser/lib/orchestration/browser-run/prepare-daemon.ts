import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { getAgentBrowserSessionIdentityKey } from "../../argv-grammar.js";
import { needsManagedSession } from "../../command-policy.js";
import { isCloseCommand } from "../../command-taxonomy.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type { OwnedManagedSessionContext } from "../../managed-session-restore.js";
import type { ManagedSessionPolicyLock } from "../../managed-session-policy-lock.js";
import {
	acquireOwnedManagedSessionDaemonPolicy,
	inspectManagedSessionDaemon,
} from "./managed-session-daemon-policy.js";
import {
	planHasValidationError,
	withPlanValidationError,
	type PreparationSessionPlan,
} from "./prepare-session-plan.js";
import type { PreparationProcessFacts } from "./prepare-contracts.js";
import type { PreparedAgentBrowserArgs } from "./types.js";
import type { ExecutionPlan as AgentBrowserExecutionPlan } from "../../runtime-contracts.js";
import type {
	ManagedSessionDaemonInspection,
	PreparationDaemonObservation,
} from "./managed-session-daemon-inspection.js";

export interface PreparationDaemonPolicy {
	readonly lock?: ManagedSessionPolicyLock;
	readonly inactive: boolean;
	readonly generationInspection?: ManagedSessionDaemonInspection;
	readonly cleanupOnlyReason?: Awaited<
		ReturnType<typeof acquireOwnedManagedSessionDaemonPolicy>
	>["cleanupOnlyReason"];
}

export interface PreparationDaemonResult {
	readonly plan: AgentBrowserExecutionPlan;
	readonly session: PreparationSessionPlan;
	readonly policy: PreparationDaemonPolicy;
	/** Whether a caller-owned session has no running daemon; owned sessions report false. */
	readonly callerDaemonInactive: () => Promise<boolean>;
}

interface PreparationDaemonFacts extends PreparationProcessFacts {
	readonly initialDaemonObservation?: PreparationDaemonObservation;
}

async function notCallerOwned(): Promise<boolean> {
	return false;
}

/** Probes a caller-owned daemon at most once per preparation, reusing a matching root sample. */
function observeCallerDaemonInactive(
	facts: PreparationDaemonFacts,
	{
		plan,
		session,
	}: { readonly plan: AgentBrowserExecutionPlan; readonly session: PreparationSessionPlan },
): () => Promise<boolean> {
	if (session.ownedManagedSession) {
		return notCallerOwned;
	}
	let observation: Promise<boolean> | undefined;
	const observe = async (): Promise<boolean> => {
		const initial = facts.initialDaemonObservation;
		if (
			initial?.identity ===
			getAgentBrowserSessionIdentityKey(plan.sessionName ?? "", plan.namespace)
		) {
			return initial.daemon.status === "inactive";
		}
		return (
			plan.sessionName !== undefined &&
			(
				await inspectManagedSessionDaemon({
					cwd: facts.cwd,
					signal: facts.signal,
					sessionName: plan.sessionName,
					namespace: plan.namespace,
				})
			).status === "inactive"
		);
	};
	return () => {
		observation ??= observe();
		return observation;
	};
}

function daemonReuseError(
	plan: AgentBrowserExecutionPlan,
	session: Pick<
		PreparationSessionPlan,
		"offCurrentLaunchScopedFlags" | "offCurrentCompatibilityUpgrade"
	>,
	policy: { readonly error?: string; readonly daemonStatus?: string },
): string | undefined {
	if (policy.error !== undefined && policy.error !== "") {
		return policy.error;
	}
	if (isCloseCommand(plan.commandInfo.command) || policy.daemonStatus !== "active") {
		return undefined;
	}
	if (session.offCurrentLaunchScopedFlags.length > 0) {
		return `This older wrapper-owned session is already running, so launch-scoped flags ${session.offCurrentLaunchScopedFlags.join(", ")} would replace or be ignored by upstream agent-browser. Close it first, or remove the explicit --session and retry with sessionMode: "fresh".`;
	}
	if (session.offCurrentCompatibilityUpgrade) {
		return 'This older wrapper-owned session is already running without the user agent required by this site. Close it first, or remove the explicit --session and retry with sessionMode: "fresh".';
	}
	return undefined;
}

function applyColdCompatibility(
	plan: AgentBrowserExecutionPlan,
	session: Pick<PreparationSessionPlan, "compatibilityUserAgent" | "compatibilityUserAgentApplied">,
	context: OwnedManagedSessionContext,
	status: string | undefined,
): {
	readonly plan: AgentBrowserExecutionPlan;
	readonly ownedManagedSession: OwnedManagedSessionContext;
} {
	if (
		isCloseCommand(plan.commandInfo.command) ||
		status !== "inactive" ||
		session.compatibilityUserAgent === undefined ||
		session.compatibilityUserAgent === "" ||
		session.compatibilityUserAgentApplied
	) {
		return { plan, ownedManagedSession: context };
	}
	return {
		ownedManagedSession: { ...context, compatibilityUserAgent: session.compatibilityUserAgent },
		plan: {
			...plan,
			effectiveArgs: ["--user-agent", session.compatibilityUserAgent, ...plan.effectiveArgs],
		},
	};
}

export async function prepareDaemonPolicy(
	process: PreparationDaemonFacts,
	electronLaunchRecord: ElectronLaunchRecord | undefined,
	planning: { readonly plan: AgentBrowserExecutionPlan; readonly session: PreparationSessionPlan },
): Promise<PreparationDaemonResult> {
	const { plan, session } = planning;
	const context = session.ownedManagedSession;
	if (session.browserIndependent || planHasValidationError(plan) || !context) {
		return {
			plan,
			session,
			policy: { inactive: false },
			callerDaemonInactive: observeCallerDaemonInactive(process, planning),
		};
	}
	const closeCommand = isCloseCommand(plan.commandInfo.command);
	const policy = await acquireOwnedManagedSessionDaemonPolicy({
		context,
		electronLaunchRecord,
		electronVerificationTimeoutMs: process.timeoutMs,
		mode: closeCommand ? "close" : "reuse",
		includeGeneration: session.hasPriorRefs && !closeCommand,
		signal: process.signal,
	});
	const error = daemonReuseError(plan, session, policy);
	const resolved =
		error !== undefined && error !== ""
			? { plan: withPlanValidationError(plan, error), ownedManagedSession: context }
			: applyColdCompatibility(plan, session, context, policy.daemonStatus);
	return {
		plan: resolved.plan,
		session: { ...session, ownedManagedSession: resolved.ownedManagedSession },
		policy: {
			lock: policy.lock,
			inactive: policy.daemonStatus === "inactive",
			generationInspection: policy.generationInspection,
			cleanupOnlyReason:
				policy.error !== undefined && policy.error !== "" ? policy.cleanupOnlyReason : undefined,
		},
		callerDaemonInactive: notCallerOwned,
	};
}

interface ChromeStartupFacts {
	readonly chromeStartupArgs?: string;
	readonly configuredChromeLaunch?: boolean;
	readonly preserveAttachedBrowserSession?: boolean;
}

function chromeStartupEligible(
	facts: Pick<ChromeStartupFacts, "chromeStartupArgs" | "preserveAttachedBrowserSession">,
	plan: AgentBrowserExecutionPlan,
	request: {
		readonly browserIndependent: boolean;
		readonly preparedArgs: PreparedAgentBrowserArgs;
		readonly stdin?: string;
	},
): boolean {
	return (
		facts.chromeStartupArgs !== undefined &&
		facts.preserveAttachedBrowserSession !== true &&
		!request.browserIndependent &&
		!planHasValidationError(plan) &&
		!isCloseCommand(plan.commandInfo.command) &&
		needsManagedSession(parseArgvDescriptor(request.preparedArgs.args), request.stdin)
	);
}

export async function prepareChromeStartupArgs(
	facts: ChromeStartupFacts,
	planning: PreparationDaemonResult,
	request: { readonly preparedArgs: PreparedAgentBrowserArgs; readonly stdin?: string },
): Promise<string | undefined> {
	if (
		!chromeStartupEligible(facts, planning.plan, {
			...request,
			browserIndependent: planning.session.browserIndependent,
		})
	) {
		return undefined;
	}
	const inactive = planning.session.ownedManagedSession
		? planning.policy.inactive
		: await planning.callerDaemonInactive();
	return inactive || facts.configuredChromeLaunch === true ? facts.chromeStartupArgs : undefined;
}
