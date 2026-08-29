import { AsyncLocalStorage } from "node:async_hooks";

import { extractUpstreamCommandTokens, parseCommandInfo } from "./argv-descriptor.js";
import {
	canonicalizeAgentBrowserNamespace,
	extractExplicitNamespace,
	extractExplicitSessionName,
	extractRequestedRestoreKey,
	getAgentBrowserSessionIdentityKey,
	isUpstreamEnvFlagEnabled,
	scanUpstreamGlobalFlagOccurrences,
} from "./argv-grammar.js";
import {
	hasLaunchScopedFlagToken,
	MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_FLAGS,
} from "./launch-scoped-flags.js";
import {
	createManagedSessionRestoreKey,
	ensureManagedSessionRestoreStorageIsSecure,
	getManagedSessionRestoreScope,
	getManagedSessionRestoreProtectedStorageEnv,
	hasManagedSessionRestoreProjectIdentity,
	resolveManagedSessionRestoreHome,
} from "./managed-session-storage.js";
import { parseUserBatchStdin } from "./orchestration/batch-stdin.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";

export { createManagedSessionRestoreKey, ensureManagedSessionRestoreStorageIsSecure, getManagedSessionRestoreScope } from "./managed-session-storage.js";
export { pruneOwnedManagedSessionRestoreSnapshots } from "./managed-session-snapshots.js";

const AGENT_BROWSER_CONFIG_ENV = "AGENT_BROWSER_CONFIG";
const AGENT_BROWSER_RESTORE_ENV = "AGENT_BROWSER_RESTORE";
const MANAGED_SESSION_RESTORE_ENV = "PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE";
export const MANAGED_SESSION_NAME_PREFIX = "piab-";
const MANAGED_SESSION_RESTORE_SPAWN_PINNED_ENVS = new Set([AGENT_BROWSER_CONFIG_ENV, AGENT_BROWSER_RESTORE_ENV, "AGENT_BROWSER_NAMESPACE"]);

function isDisabledEnvFlag(value: string | undefined): boolean {
	if (value === undefined) return false;
	return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function hasUpstreamEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): boolean {
	return env?.[name] !== undefined;
}

export interface ManagedSessionRestoreIdentity {
	namespace?: string;
	sessionName: string;
}

export class ManagedSessionRestoreState {
	readonly #daemonRestoreKeys = new Map<string, string | null>();
	readonly #disabled = new Set<string>();

	clear(sessionName?: string, namespace?: string): void {
		if (sessionName) {
			const identity = getAgentBrowserSessionIdentityKey(sessionName, namespace);
			this.#daemonRestoreKeys.delete(identity);
			this.#disabled.delete(identity);
		} else {
			this.#daemonRestoreKeys.clear();
			this.#disabled.clear();
		}
	}

	disable(sessionName: string | undefined, namespace?: string): void {
		if (sessionName) this.#disabled.add(getAgentBrowserSessionIdentityKey(sessionName, namespace));
	}

	getDaemonRestoreKey(sessionName: string | undefined, namespace?: string): string | null | undefined {
		return typeof sessionName === "string" ? this.#daemonRestoreKeys.get(getAgentBrowserSessionIdentityKey(sessionName, namespace)) : undefined;
	}

	hasDaemonRestoreKey(sessionName: string | undefined, namespace?: string): boolean {
		return typeof sessionName === "string" && this.#daemonRestoreKeys.has(getAgentBrowserSessionIdentityKey(sessionName, namespace));
	}

	forgetDaemonRestoreKey(sessionName: string | undefined, namespace?: string): void {
		if (sessionName) this.#daemonRestoreKeys.delete(getAgentBrowserSessionIdentityKey(sessionName, namespace));
	}

	isDisabled(sessionName: string | undefined, namespace?: string): boolean {
		return typeof sessionName === "string" && this.#disabled.has(getAgentBrowserSessionIdentityKey(sessionName, namespace));
	}

	recordDaemonRestoreKey(sessionName: string | undefined, namespace: string | undefined, restoreKey: string | null): void {
		if (sessionName) this.#daemonRestoreKeys.set(getAgentBrowserSessionIdentityKey(sessionName, namespace), restoreKey);
	}

	replace(identities: ManagedSessionRestoreIdentity[] = [], options: { preserveDaemonRestoreKeys?: boolean } = {}): void {
		if (!options.preserveDaemonRestoreKeys) this.#daemonRestoreKeys.clear();
		this.#disabled.clear();
		for (const identity of identities) this.disable(identity.sessionName, identity.namespace);
	}
}

export type OwnedManagedSessionContext = {
	compatibilityUserAgent?: string;
	headedManagedAutosaveDisabled?: boolean;
	headedManagedAutosaveInterval?: string;
	cwd?: string;
	expectedDaemonRestoreKey?: string | null;
	namespace?: string;
	protectedStorageEnv?: NodeJS.ProcessEnv;
	restoreDecision?: "enabled" | "incompatible" | "opted-out";
	restoreKey?: string;
	restoreScope?: string;
	restoreSuppressed?: boolean;
	restoreState: ManagedSessionRestoreState;
	sessionName: string;
};

const ownedManagedSessionStorage = new AsyncLocalStorage<OwnedManagedSessionContext | undefined>();

export async function withOwnedManagedSessionContext<T>(
	context: OwnedManagedSessionContext | undefined,
	run: () => Promise<T>,
): Promise<T> {
	return await ownedManagedSessionStorage.run(context, run);
}

export function getOwnedManagedSessionRestoreKey(): string | undefined {
	return ownedManagedSessionStorage.getStore()?.restoreKey;
}

export function resolveOwnedManagedSessionContext(options: {
	currentManagedSessionName?: string;
	currentManagedSessionNamespace?: string;
	cwd?: string;
	managedSessionName?: string;
	namespace?: string;
	recordedOwnedSession?: { cwd: string; namespace?: string; sessionName: string };
	restoreState: ManagedSessionRestoreState;
	sessionName?: string;
}): OwnedManagedSessionContext | undefined {
	const namespace = canonicalizeAgentBrowserNamespace(options.namespace);
	const currentNamespace = canonicalizeAgentBrowserNamespace(options.currentManagedSessionNamespace);
	const recordedNamespace = canonicalizeAgentBrowserNamespace(options.recordedOwnedSession?.namespace);
	if (options.recordedOwnedSession
		&& options.sessionName === options.recordedOwnedSession.sessionName
		&& namespace === recordedNamespace) {
		return { cwd: options.recordedOwnedSession.cwd, namespace, restoreState: options.restoreState, sessionName: options.sessionName };
	}
	if (options.managedSessionName) return { cwd: options.cwd, namespace, restoreState: options.restoreState, sessionName: options.managedSessionName };
	if (options.sessionName && options.sessionName === options.currentManagedSessionName && namespace === currentNamespace) {
		return { cwd: options.cwd, namespace, restoreState: options.restoreState, sessionName: options.sessionName };
	}
	return undefined;
}

function ownedContextMatches(sessionName: string | undefined, namespace: string | undefined): OwnedManagedSessionContext | undefined {
	const owned = ownedManagedSessionStorage.getStore();
	return owned && sessionName === owned.sessionName && canonicalizeAgentBrowserNamespace(namespace) === owned.namespace ? owned : undefined;
}

export function isOwnedManagedSessionTarget(args: string[]): boolean {
	return ownedContextMatches(extractExplicitSessionName(args), extractExplicitNamespace(args)) !== undefined;
}

function hasExplicitConfigArg(args: string[]): boolean {
	return scanUpstreamGlobalFlagOccurrences(args, "--config").length > 0;
}

function closesBrowserSession(args: string[]): boolean {
	return ["close", "exit", "quit"].includes(parseCommandInfo(args).command ?? "");
}

export function agentBrowserExplicitConfigIsPresent(
	parentEnv: NodeJS.ProcessEnv = getAgentBrowserProcessEnvironment(),
	args: string[] = [],
): boolean {
	return hasExplicitConfigArg(args) || hasUpstreamEnvValue(parentEnv, AGENT_BROWSER_CONFIG_ENV);
}

/** Caller-selected upstream config disables the wrapper's automatic restore injection without blocking that config. */
export function agentBrowserConfigBlocksManagedRestore(
	_cwd: string,
	parentEnv: NodeJS.ProcessEnv = getAgentBrowserProcessEnvironment(),
	args: string[] = [],
	platform: NodeJS.Platform = process.platform,
): boolean {
	return !resolveManagedSessionRestoreHome(parentEnv, platform) || agentBrowserExplicitConfigIsPresent(parentEnv, args);
}

function omitWrapperInjectedUserAgent(args: string[], enabled: boolean | undefined): string[] {
	if (!enabled) return args;
	const index = args.indexOf("--user-agent");
	return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

type ManagedSessionRestorePolicyOptions = {
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	parentEnv?: NodeJS.ProcessEnv;
	stdin?: string;
	wrapperInjectedUserAgent?: boolean;
};

function batchHasManagedSessionRestoreConflict(args: string[], stdin: string | undefined): boolean {
	const [command, ...commandArgs] = extractUpstreamCommandTokens(args);
	if (command !== "batch") return false;
	if (commandArgs.some((token) => token !== "--bail")) return true;
	const parsed = parseUserBatchStdin(stdin);
	if (parsed.error || !parsed.steps) return false;
	return parsed.steps.some((step) => ["connect", "batch"].includes(parseCommandInfo(step).command ?? ""));
}

function hasManagedSessionRestoreLaunchConflict(options: ManagedSessionRestorePolicyOptions): boolean {
	const parentEnv = options.parentEnv ?? getAgentBrowserProcessEnvironment();
	const effectiveEnv = { ...parentEnv, ...options.env };
	const args = omitWrapperInjectedUserAgent(options.args, options.wrapperInjectedUserAgent);
	if (MANAGED_RESTORE_INCOMPATIBLE_ENVS.some((name) => hasUpstreamEnvValue(effectiveEnv, name))) return true;
	if (MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS.some((name) => isUpstreamEnvFlagEnabled(effectiveEnv[name]))) return true;
	if (MANAGED_RESTORE_INCOMPATIBLE_FLAGS.some((flag) => hasLaunchScopedFlagToken(args, flag))) return true;
	if (parseCommandInfo(args).command === "connect" || batchHasManagedSessionRestoreConflict(args, options.stdin)) return true;
	return hasExplicitConfigArg(args) || hasUpstreamEnvValue({ ...parentEnv, ...options.env }, AGENT_BROWSER_CONFIG_ENV);
}

function managedSessionRestoreOptedOut(options: ManagedSessionRestorePolicyOptions): boolean {
	const effectiveEnv = { ...(options.parentEnv ?? getAgentBrowserProcessEnvironment()), ...options.env };
	return isDisabledEnvFlag(effectiveEnv[MANAGED_SESSION_RESTORE_ENV]);
}

function isManagedSessionRestoreIncompatible(options: ManagedSessionRestorePolicyOptions): boolean {
	if (hasManagedSessionRestoreLaunchConflict(options)) return true;
	if (managedSessionRestoreOptedOut(options)) return false;
	const effectiveEnv = { ...(options.parentEnv ?? getAgentBrowserProcessEnvironment()), ...options.env };
	const args = omitWrapperInjectedUserAgent(options.args, options.wrapperInjectedUserAgent);
	if (options.cwd && !hasManagedSessionRestoreProjectIdentity(options.cwd)) return true;
	if (options.cwd && agentBrowserConfigBlocksManagedRestore(options.cwd, effectiveEnv, args)) return true;
	return !ensureManagedSessionRestoreStorageIsSecure(effectiveEnv, process.platform, extractExplicitNamespace(args));
}

export interface ManagedSessionRestoreEnvOptions {
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	ownedManagedSession?: boolean;
	parentEnv?: NodeJS.ProcessEnv;
	restoreState?: ManagedSessionRestoreState;
	stdin?: string;
}

function resolveManagedSessionRestorePolicy(options: ManagedSessionRestoreEnvOptions) {
	const parentEnv = options.parentEnv ?? getAgentBrowserProcessEnvironment();
	const sessionName = extractExplicitSessionName(options.args);
	const namespace = extractExplicitNamespace(options.args);
	const ownedContext = ownedContextMatches(sessionName, namespace);
	const restoreState = ownedContext?.restoreState ?? options.restoreState;
	const owned = (options.ownedManagedSession || ownedContext !== undefined) && restoreState !== undefined;
	return { namespace, owned, ownedContext, parentEnv, restoreState, sessionName };
}

export function getOwnedManagedSessionNamespaceEnv(options: ManagedSessionRestoreEnvOptions): NodeJS.ProcessEnv {
	const { namespace, owned, ownedContext } = resolveManagedSessionRestorePolicy(options);
	return owned ? { AGENT_BROWSER_NAMESPACE: ownedContext?.namespace ?? namespace ?? "" } : {};
}

const DEFAULT_AUTOSAVE_INTERVAL_MS = "30000";
const MAX_U64 = 18_446_744_073_709_551_615n;

export function resolveExplicitAutosaveInterval(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!/^\+?\d+$/.test(value)) return DEFAULT_AUTOSAVE_INTERVAL_MS;
	try {
		const parsed = BigInt(value);
		return parsed <= MAX_U64 ? parsed.toString() : DEFAULT_AUTOSAVE_INTERVAL_MS;
	} catch {
		return DEFAULT_AUTOSAVE_INTERVAL_MS;
	}
}

export function getOwnedManagedSessionCompatibilityEnv(options: ManagedSessionRestoreEnvOptions): NodeJS.ProcessEnv {
	const { owned, ownedContext } = resolveManagedSessionRestorePolicy(options);
	if (!owned || !ownedContext) return {};
	const parentEnv = options.parentEnv ?? getAgentBrowserProcessEnvironment();
	const callEnv = options.env ?? {};
	const explicitRawInterval = Object.hasOwn(callEnv, "AGENT_BROWSER_AUTOSAVE_INTERVAL_MS")
		? callEnv.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS
		: parentEnv.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS;
	const explicitIntervalMatches = resolveExplicitAutosaveInterval(explicitRawInterval) === ownedContext.headedManagedAutosaveInterval;
	return {
		...(ownedContext.compatibilityUserAgent ? { AGENT_BROWSER_USER_AGENT: ownedContext.compatibilityUserAgent } : {}),
		...(ownedContext.headedManagedAutosaveInterval !== undefined && !explicitIntervalMatches ? { AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: ownedContext.headedManagedAutosaveInterval } : {}),
	};
}

export function getManagedSessionRestoreProtectedEnv(
	options: ManagedSessionRestoreEnvOptions,
	restoreEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const { ownedContext } = resolveManagedSessionRestorePolicy(options);
	if (restoreEnv[AGENT_BROWSER_RESTORE_ENV] === undefined) return {};
	if (ownedContext?.protectedStorageEnv) return { ...ownedContext.protectedStorageEnv };
	const effectiveEnv = { ...(options.parentEnv ?? getAgentBrowserProcessEnvironment()), ...options.env };
	return getManagedSessionRestoreProtectedStorageEnv(true, effectiveEnv);
}

export function validateManagedSessionRestoreContextForSpawn(options: ManagedSessionRestoreEnvOptions): boolean {
	const { namespace, ownedContext, parentEnv } = resolveManagedSessionRestorePolicy(options);
	if (closesBrowserSession(options.args) || ownedContext?.restoreDecision !== "enabled") return true;
	const ownedCwd = ownedContext.cwd ?? options.cwd;
	if (!ownedContext.restoreKey || !ownedContext.restoreScope || createManagedSessionRestoreKey(ownedCwd, ownedContext.restoreScope) !== ownedContext.restoreKey || !hasManagedSessionRestoreProjectIdentity(ownedCwd)) return false;
	const effectiveEnv = { ...parentEnv, ...options.env };
	if (isDisabledEnvFlag(effectiveEnv[MANAGED_SESSION_RESTORE_ENV])) return false;
	if (MANAGED_RESTORE_INCOMPATIBLE_ENVS.some((name) => !MANAGED_SESSION_RESTORE_SPAWN_PINNED_ENVS.has(name) && hasUpstreamEnvValue(effectiveEnv, name))) return false;
	if (MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS.some((name) => isUpstreamEnvFlagEnabled(effectiveEnv[name]))) return false;
	if (options.env?.[AGENT_BROWSER_RESTORE_ENV] !== undefined && options.env[AGENT_BROWSER_RESTORE_ENV] !== ownedContext.restoreKey) return false;
	return ensureManagedSessionRestoreStorageIsSecure(
		{ ...effectiveEnv, ...ownedContext.protectedStorageEnv },
		process.platform,
		namespace,
	);
}

export function getManagedSessionRestoreEnv(options: ManagedSessionRestoreEnvOptions): NodeJS.ProcessEnv {
	const { namespace, owned, ownedContext, parentEnv, restoreState, sessionName } = resolveManagedSessionRestorePolicy(options);
	if (!owned || !restoreState || closesBrowserSession(options.args)) return {};
	if (ownedContext?.restoreDecision) {
		if (ownedContext.restoreDecision !== "enabled" || restoreState.isDisabled(sessionName, namespace) || !sessionName || !ownedContext.restoreKey || !validateManagedSessionRestoreContextForSpawn(options)) return {};
		return { [AGENT_BROWSER_RESTORE_ENV]: ownedContext.restoreKey };
	}
	const policyOptions = { ...options, parentEnv };
	if (managedSessionRestoreOptedOut(policyOptions) || ownedContext?.restoreSuppressed || isManagedSessionRestoreIncompatible(policyOptions)) return {};
	if (restoreState.isDisabled(sessionName, namespace) || !sessionName) return {};
	return { [AGENT_BROWSER_RESTORE_ENV]: createManagedSessionRestoreKey(options.cwd, getManagedSessionRestoreScope(sessionName)) };
}

/** Commit sticky suppression only after an owned-context subprocess has actually started. */
export function commitManagedSessionRestoreSuppression(options: ManagedSessionRestoreEnvOptions): void {
	const { namespace, owned, ownedContext, parentEnv, restoreState, sessionName } = resolveManagedSessionRestorePolicy(options);
	if (!owned || !restoreState || closesBrowserSession(options.args)) return;
	if (ownedContext?.restoreDecision) {
		const alreadyDisabled = restoreState.isDisabled(sessionName, namespace);
		if (ownedContext.restoreDecision === "enabled") {
			if (options.ownedManagedSession && !alreadyDisabled && ownedContext.restoreKey) {
				restoreState.recordDaemonRestoreKey(sessionName, namespace, ownedContext.restoreKey);
			} else if (options.ownedManagedSession && alreadyDisabled && !restoreState.hasDaemonRestoreKey(sessionName, namespace)) {
				restoreState.recordDaemonRestoreKey(sessionName, namespace, null);
			}
		} else {
			if (options.ownedManagedSession) restoreState.recordDaemonRestoreKey(sessionName, namespace, ownedContext.expectedDaemonRestoreKey ?? null);
			restoreState.disable(sessionName, namespace);
		}
		return;
	}
	const policyOptions = { ...options, parentEnv };
	if (managedSessionRestoreOptedOut(policyOptions) || ownedContext?.restoreSuppressed || isManagedSessionRestoreIncompatible(policyOptions)) restoreState.disable(sessionName, namespace);
}

export function buildOwnedManagedSessionRestoreContext(options: {
	args: string[];
	compatibilityUserAgent?: string;
	headedManagedAutosaveDisabled?: boolean;
	headedManagedAutosaveInterval?: string;
	cwd: string;
	currentManagedSessionName?: string;
	currentManagedSessionNamespace?: string;
	env?: NodeJS.ProcessEnv;
	managedSessionName?: string;
	namespace?: string;
	parentEnv?: NodeJS.ProcessEnv;
	recordedOwnedSession?: { cwd: string; namespace?: string; sessionName: string };
	restoreState: ManagedSessionRestoreState;
	sessionName?: string;
	stdin?: string;
	wrapperInjectedUserAgent?: boolean;
}): OwnedManagedSessionContext | undefined {
	const owned = resolveOwnedManagedSessionContext(options);
	if (!owned) return undefined;
	const ownedCwd = owned.cwd ?? options.cwd;
	const policyOptions = {
		args: options.args,
		cwd: ownedCwd,
		env: options.env,
		parentEnv: options.parentEnv,
		stdin: options.stdin,
		wrapperInjectedUserAgent: options.wrapperInjectedUserAgent,
	};
	const optedOut = managedSessionRestoreOptedOut(policyOptions);
	const projectIdentityAvailable = !optedOut && hasManagedSessionRestoreProjectIdentity(ownedCwd);
	const incompatible = !optedOut && isManagedSessionRestoreIncompatible(policyOptions);
	const enabled = !optedOut && !incompatible;
	const effectiveEnv = { ...(options.parentEnv ?? getAgentBrowserProcessEnvironment()), ...options.env };
	const restoreScope = getManagedSessionRestoreScope(owned.sessionName);
	const restoreKey = projectIdentityAvailable ? createManagedSessionRestoreKey(ownedCwd, restoreScope) : undefined;
	return {
		...owned,
		compatibilityUserAgent: options.compatibilityUserAgent,
		headedManagedAutosaveDisabled: options.headedManagedAutosaveDisabled,
		headedManagedAutosaveInterval: options.headedManagedAutosaveInterval,
		expectedDaemonRestoreKey: enabled ? restoreKey : extractRequestedRestoreKey(options.args, owned.sessionName, effectiveEnv[AGENT_BROWSER_RESTORE_ENV]),
		protectedStorageEnv: enabled ? getManagedSessionRestoreProtectedStorageEnv(true, effectiveEnv) : undefined,
		restoreDecision: optedOut ? "opted-out" : incompatible ? "incompatible" : "enabled",
		restoreKey,
		restoreScope,
		restoreSuppressed: optedOut || incompatible,
	};
}
