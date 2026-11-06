import { extractRequestedRestoreKey } from "./argv-grammar.js";
import { hasLaunchScopedFlagToken } from "./launch-scoped-flags.js";
import {
	createManagedSessionRestoreKey,
	getManagedSessionRestoreScope,
	getManagedSessionRestoreProtectedStorageEnv,
	hasManagedSessionRestoreProjectIdentity,
} from "./managed-session-storage.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";
import {
	resolveOwnedManagedSessionContext,
	type OwnedManagedSessionContext,
	type OwnedContextResolutionOptions,
} from "./owned-managed-session-context.js";
import {
	AGENT_BROWSER_RESTORE_ENV,
	agentBrowserExplicitConfigIsPresent,
	isManagedSessionRestoreIncompatible,
	managedSessionRestoreOptedOut,
	type ManagedSessionRestorePolicyOptions,
} from "./managed-session-restore-policy.js";
interface RestoreContextOptions
	extends OwnedContextResolutionOptions, ManagedSessionRestorePolicyOptions {
	readonly cwd: string;
	readonly reuseOnly?: boolean;
	readonly compatibilityUserAgent?: string | undefined;
	readonly headedManagedAutosaveDisabled?: boolean | undefined;
	readonly headedManagedAutosaveInterval?: string | undefined;
}
function reuseIsSuppressed(options: RestoreContextOptions, env: NodeJS.ProcessEnv): boolean {
	return (
		managedSessionRestoreOptedOut(options) ||
		agentBrowserExplicitConfigIsPresent(env, options.args) ||
		["--restore", "--session-name"].some((flag) => hasLaunchScopedFlagToken(options.args, flag)) ||
		env.AGENT_BROWSER_RESTORE !== undefined ||
		env.AGENT_BROWSER_SESSION_NAME !== undefined
	);
}
function reuseContext(
	options: RestoreContextOptions,
	owned: OwnedManagedSessionContext,
): OwnedManagedSessionContext {
	const env = { ...(options.parentEnv ?? getAgentBrowserProcessEnvironment()), ...options.env };
	const enabled = !options.restoreState.isDisabled(owned.sessionName, owned.namespace);
	const scope = getManagedSessionRestoreScope(owned.sessionName);
	const knownKey = options.restoreState.getDaemonRestoreKey(owned.sessionName, owned.namespace);
	const cwd = owned.cwd ?? options.cwd;
	const key =
		knownKey === undefined && enabled && hasManagedSessionRestoreProjectIdentity(cwd)
			? createManagedSessionRestoreKey(cwd, scope)
			: knownKey;
	return {
		...owned,
		reuseOnly: true,
		restoreKey: key ?? undefined,
		restoreScope: scope,
		protectedStorageEnv: enabled
			? getManagedSessionRestoreProtectedStorageEnv(true, env)
			: undefined,
		restoreDecision: enabled ? "enabled" : undefined,
		restoreSuppressed: reuseIsSuppressed(options, env),
		headedManagedAutosaveDisabled: options.headedManagedAutosaveDisabled,
		headedManagedAutosaveInterval: options.headedManagedAutosaveInterval,
	};
}
function restoreDecision(
	optedOut: boolean,
	incompatible: boolean,
): OwnedManagedSessionContext["restoreDecision"] {
	if (optedOut) {
		return "opted-out";
	}
	return incompatible ? "incompatible" : "enabled";
}
function launchContext(
	options: RestoreContextOptions,
	owned: OwnedManagedSessionContext,
): OwnedManagedSessionContext {
	const cwd = owned.cwd ?? options.cwd;
	const policy = {
		args: options.args,
		cwd,
		env: options.env,
		parentEnv: options.parentEnv,
		stdin: options.stdin,
		wrapperInjectedUserAgent: options.wrapperInjectedUserAgent,
	};
	const optedOut = managedSessionRestoreOptedOut(policy);
	const projectIdentityAvailable = !optedOut && hasManagedSessionRestoreProjectIdentity(cwd);
	const incompatible = !optedOut && isManagedSessionRestoreIncompatible(policy, owned.namespace);
	const enabled = !optedOut && !incompatible;
	const env = { ...(options.parentEnv ?? getAgentBrowserProcessEnvironment()), ...options.env };
	const scope = getManagedSessionRestoreScope(owned.sessionName);
	const key = projectIdentityAvailable ? createManagedSessionRestoreKey(cwd, scope) : undefined;
	const decision = restoreDecision(optedOut, incompatible);
	return {
		...owned,
		compatibilityUserAgent: options.compatibilityUserAgent,
		headedManagedAutosaveDisabled: options.headedManagedAutosaveDisabled,
		headedManagedAutosaveInterval: options.headedManagedAutosaveInterval,
		expectedDaemonRestoreKey: enabled
			? key
			: extractRequestedRestoreKey(options.args, owned.sessionName, env[AGENT_BROWSER_RESTORE_ENV]),
		protectedStorageEnv: enabled
			? getManagedSessionRestoreProtectedStorageEnv(true, env)
			: undefined,
		restoreDecision: decision,
		restoreKey: key,
		restoreScope: scope,
		restoreSuppressed: optedOut || incompatible,
	};
}
export function buildOwnedManagedSessionRestoreContext(
	options: RestoreContextOptions,
): OwnedManagedSessionContext | undefined {
	const owned = resolveOwnedManagedSessionContext(options);
	if (!owned) {
		return undefined;
	}
	return options.reuseOnly === true ? reuseContext(options, owned) : launchContext(options, owned);
}
