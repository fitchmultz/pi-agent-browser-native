import { isUpstreamEnvFlagEnabled } from "./argv-grammar.js";
import {
	MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_ENVS,
} from "./launch-scoped-flags.js";
import {
	createManagedSessionRestoreKey,
	ensureManagedSessionRestoreStorageIsSecure,
	getManagedSessionRestoreScope,
	getManagedSessionRestoreProtectedStorageEnv,
	hasManagedSessionRestoreProjectIdentity,
} from "./managed-session-storage.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";
import type { OwnedManagedSessionContext } from "./owned-managed-session-context.js";
import {
	AGENT_BROWSER_CONFIG_ENV,
	AGENT_BROWSER_RESTORE_ENV,
	MANAGED_SESSION_RESTORE_ENV,
	agentBrowserExplicitConfigIsPresent,
	closesBrowserSession,
	isDisabledEnvFlag,
	hasUpstreamEnvValue,
	isManagedSessionRestoreIncompatible,
	managedSessionRestoreOptedOut,
	resolveExplicitAutosaveInterval,
	resolveManagedSessionRestorePolicy,
	type ManagedSessionRestoreEnvOptions,
} from "./managed-session-restore-policy.js";
export {
	agentBrowserConfigBlocksManagedRestore,
	resolveExplicitAutosaveInterval,
	type ManagedSessionRestoreEnvOptions,
} from "./managed-session-restore-policy.js";
export {
	createManagedSessionRestoreKey,
	ensureManagedSessionRestoreStorageIsSecure,
	getManagedSessionRestoreScope,
} from "./managed-session-storage.js";
export { pruneOwnedManagedSessionRestoreSnapshots } from "./managed-session-snapshots.js";
export {
	ManagedSessionRestoreState,
	type ManagedSessionRestoreIdentity,
} from "./managed-session-restore-state.js";
export {
	withOwnedManagedSessionContext,
	resolveOwnedManagedSessionContext,
	isOwnedManagedSessionTarget,
	type OwnedManagedSessionContext,
} from "./owned-managed-session-context.js";
export { buildOwnedManagedSessionRestoreContext } from "./managed-session-restore-context.js";
export const MANAGED_SESSION_NAME_PREFIX = "piab-";
const SPAWN_PINNED_ENVS = new Set([AGENT_BROWSER_CONFIG_ENV, AGENT_BROWSER_RESTORE_ENV]);
export function getOwnedManagedSessionNamespaceEnv(
	options: ManagedSessionRestoreEnvOptions,
): NodeJS.ProcessEnv {
	const { namespace, owned, ownedContext } = resolveManagedSessionRestorePolicy(options);
	return owned ? { AGENT_BROWSER_NAMESPACE: ownedContext?.namespace ?? namespace ?? "" } : {};
}
function compatibilityForReuse(
	context: OwnedManagedSessionContext,
	env: NodeJS.ProcessEnv,
	args: readonly string[],
	explicit: string | undefined,
): NodeJS.ProcessEnv {
	return explicit === undefined &&
		context.headedManagedAutosaveInterval !== undefined &&
		!agentBrowserExplicitConfigIsPresent(env, args)
		? { AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: context.headedManagedAutosaveInterval }
		: {};
}
function explicitAutosaveInterval(options: ManagedSessionRestoreEnvOptions): string | undefined {
	const parent = options.parentEnv ?? getAgentBrowserProcessEnvironment();
	const env = options.env ?? {};
	return Object.hasOwn(env, "AGENT_BROWSER_AUTOSAVE_INTERVAL_MS")
		? env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS
		: parent.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS;
}
export function getOwnedManagedSessionCompatibilityEnv(
	options: ManagedSessionRestoreEnvOptions,
): NodeJS.ProcessEnv {
	const { owned, ownedContext } = resolveManagedSessionRestorePolicy(options);
	if (!owned || !ownedContext) {
		return {};
	}
	const parentEnv = options.parentEnv ?? getAgentBrowserProcessEnvironment();
	const callEnv = options.env ?? {};
	const explicit = explicitAutosaveInterval(options);
	if (ownedContext.reuseOnly === true) {
		return compatibilityForReuse(
			ownedContext,
			{ ...parentEnv, ...callEnv },
			options.args,
			explicit,
		);
	}
	const env: NodeJS.ProcessEnv = {};
	if (
		ownedContext.compatibilityUserAgent !== undefined &&
		ownedContext.compatibilityUserAgent.length > 0
	) {
		env.AGENT_BROWSER_USER_AGENT = ownedContext.compatibilityUserAgent;
	}
	if (
		ownedContext.headedManagedAutosaveInterval !== undefined &&
		resolveExplicitAutosaveInterval(explicit) !== ownedContext.headedManagedAutosaveInterval
	) {
		env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS = ownedContext.headedManagedAutosaveInterval;
	}
	return env;
}
export function getManagedSessionRestoreProtectedEnv(
	options: ManagedSessionRestoreEnvOptions,
	restoreEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const { ownedContext } = resolveManagedSessionRestorePolicy(options);
	if (restoreEnv[AGENT_BROWSER_RESTORE_ENV] === undefined) {
		return {};
	}
	if (ownedContext?.protectedStorageEnv) {
		return { ...ownedContext.protectedStorageEnv };
	}
	return getManagedSessionRestoreProtectedStorageEnv(true, {
		...(options.parentEnv ?? getAgentBrowserProcessEnvironment()),
		...options.env,
	});
}
function validRestoreIdentity(context: OwnedManagedSessionContext, cwd: string): boolean {
	if (
		context.restoreKey === undefined ||
		context.restoreKey.length === 0 ||
		context.restoreScope === undefined ||
		context.restoreScope.length === 0
	) {
		return false;
	}
	return (
		createManagedSessionRestoreKey(cwd, context.restoreScope) === context.restoreKey &&
		hasManagedSessionRestoreProjectIdentity(cwd)
	);
}
function validLaunchEnvironment(
	options: ManagedSessionRestoreEnvOptions,
	context: OwnedManagedSessionContext,
	env: NodeJS.ProcessEnv,
): boolean {
	if (context.reuseOnly === true) {
		return true;
	}
	if (isDisabledEnvFlag(env[MANAGED_SESSION_RESTORE_ENV])) {
		return false;
	}
	if (
		MANAGED_RESTORE_INCOMPATIBLE_ENVS.some(
			(name) => !SPAWN_PINNED_ENVS.has(name) && hasUpstreamEnvValue(env, name),
		)
	) {
		return false;
	}
	if (
		MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS.some((name) => isUpstreamEnvFlagEnabled(env[name]))
	) {
		return false;
	}
	return (
		options.env?.[AGENT_BROWSER_RESTORE_ENV] === undefined ||
		options.env[AGENT_BROWSER_RESTORE_ENV] === context.restoreKey
	);
}
export function validateManagedSessionRestoreContextForSpawn(
	options: ManagedSessionRestoreEnvOptions,
): boolean {
	const { namespace, ownedContext, parentEnv } = resolveManagedSessionRestorePolicy(options);
	if (
		closesBrowserSession(options.args) ||
		ownedContext?.restoreDecision !== "enabled" ||
		(ownedContext.reuseOnly === true && ownedContext.restoreSuppressed === true)
	) {
		return true;
	}
	if (!validRestoreIdentity(ownedContext, ownedContext.cwd ?? options.cwd)) {
		return false;
	}
	const env = { ...parentEnv, ...options.env };
	return (
		validLaunchEnvironment(options, ownedContext, env) &&
		ensureManagedSessionRestoreStorageIsSecure(
			{ ...env, ...ownedContext.protectedStorageEnv },
			process.platform,
			namespace,
		)
	);
}
function reuseRestoreEnv(
	options: ManagedSessionRestoreEnvOptions,
	context: OwnedManagedSessionContext,
): NodeJS.ProcessEnv {
	return context.restoreKey !== undefined &&
		context.restoreKey.length > 0 &&
		context.restoreSuppressed !== true &&
		validateManagedSessionRestoreContextForSpawn(options)
		? { [AGENT_BROWSER_RESTORE_ENV]: context.restoreKey }
		: {};
}
function disabledByPolicy(
	options: ManagedSessionRestoreEnvOptions,
	context: OwnedManagedSessionContext | undefined,
	namespace: string | undefined,
): boolean {
	return (
		managedSessionRestoreOptedOut(options) ||
		context?.restoreSuppressed === true ||
		isManagedSessionRestoreIncompatible(options, namespace)
	);
}
type RestorePolicy = ReturnType<typeof resolveManagedSessionRestorePolicy>;
function configuredRestoreEnv(
	options: ManagedSessionRestoreEnvOptions,
	context: OwnedManagedSessionContext,
	policy: RestorePolicy,
): NodeJS.ProcessEnv {
	if (
		context.restoreDecision !== "enabled" ||
		!policy.restoreState ||
		policy.restoreState.isDisabled(policy.sessionName, policy.namespace)
	) {
		return {};
	}
	if (
		policy.sessionName === undefined ||
		policy.sessionName.length === 0 ||
		context.restoreKey === undefined ||
		context.restoreKey.length === 0 ||
		!validateManagedSessionRestoreContextForSpawn(options)
	) {
		return {};
	}
	return { [AGENT_BROWSER_RESTORE_ENV]: context.restoreKey };
}
function automaticRestoreEnv(
	options: ManagedSessionRestoreEnvOptions,
	policy: RestorePolicy,
): NodeJS.ProcessEnv {
	if (
		disabledByPolicy(
			{ ...options, parentEnv: policy.parentEnv },
			policy.ownedContext,
			policy.namespace,
		)
	) {
		return {};
	}
	if (
		!policy.restoreState ||
		policy.restoreState.isDisabled(policy.sessionName, policy.namespace) ||
		policy.sessionName === undefined ||
		policy.sessionName.length === 0
	) {
		return {};
	}
	return {
		[AGENT_BROWSER_RESTORE_ENV]: createManagedSessionRestoreKey(
			options.cwd,
			getManagedSessionRestoreScope(policy.sessionName),
		),
	};
}
export function getManagedSessionRestoreEnv(
	options: ManagedSessionRestoreEnvOptions,
): NodeJS.ProcessEnv {
	const policy = resolveManagedSessionRestorePolicy(options);
	if (!policy.owned || !policy.restoreState || closesBrowserSession(options.args)) {
		return {};
	}
	const context = policy.ownedContext;
	if (context?.reuseOnly === true) {
		return reuseRestoreEnv(options, context);
	}
	if (context?.restoreDecision !== undefined) {
		return configuredRestoreEnv(options, context, policy);
	}
	return automaticRestoreEnv(options, policy);
}
function recordEnabledDaemonKey(
	options: ManagedSessionRestoreEnvOptions,
	context: OwnedManagedSessionContext,
): void {
	const { namespace, restoreState, sessionName } = resolveManagedSessionRestorePolicy(options);
	if (options.ownedManagedSession !== true || !restoreState) {
		return;
	}
	const disabled = restoreState.isDisabled(sessionName, namespace);
	if (!disabled && context.restoreKey !== undefined && context.restoreKey.length > 0) {
		restoreState.recordDaemonRestoreKey(sessionName, namespace, context.restoreKey);
	} else if (disabled && !restoreState.hasUnrestoredDaemonRestoreKey(sessionName, namespace)) {
		restoreState.recordDaemonRestoreKey(sessionName, namespace, null);
	}
}
function commitPlannedDecision(
	options: ManagedSessionRestoreEnvOptions,
	context: OwnedManagedSessionContext,
	policy: RestorePolicy,
): void {
	if (context.restoreDecision === "enabled") {
		recordEnabledDaemonKey(options, context);
		return;
	}
	if (!policy.restoreState) {
		return;
	}
	if (options.ownedManagedSession === true) {
		policy.restoreState.recordDaemonRestoreKey(
			policy.sessionName,
			policy.namespace,
			context.expectedDaemonRestoreKey ?? null,
		);
	}
	policy.restoreState.disable(policy.sessionName, policy.namespace);
}
/** Commit sticky suppression only after an owned-context subprocess has actually started. */
export function commitManagedSessionRestoreSuppression(
	options: ManagedSessionRestoreEnvOptions,
): void {
	const { namespace, owned, ownedContext, parentEnv, restoreState, sessionName } =
		resolveManagedSessionRestorePolicy(options);
	if (
		!owned ||
		!restoreState ||
		ownedContext?.reuseOnly === true ||
		closesBrowserSession(options.args)
	) {
		return;
	}
	if (ownedContext?.restoreDecision !== undefined) {
		commitPlannedDecision(options, ownedContext, {
			namespace,
			owned,
			ownedContext,
			parentEnv,
			restoreState,
			sessionName,
		});
		return;
	}
	if (disabledByPolicy({ ...options, parentEnv }, ownedContext, namespace)) {
		restoreState.disable(sessionName, namespace);
	}
}
