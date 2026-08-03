/**
 * Purpose: Own automatic restore policy for wrapper-managed browser sessions.
 * Responsibilities: Resolve owned session identity, isolate per-call helper policy, reject incompatible argv/env/config, secure upstream state storage, and persist sticky restore-disable state.
 * Scope: Managed restore only; general argv/session planning stays in runtime.ts and process spawning stays in process.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseCommandInfo } from "./argv-descriptor.js";
import {
	extractExplicitNamespace,
	extractExplicitSessionName,
	scanUpstreamGlobalFlagOccurrences,
} from "./argv-grammar.js";
import {
	hasLaunchScopedFlagToken,
	MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_FLAGS,
} from "./launch-scoped-flags.js";

const AGENT_BROWSER_RESTORE_ENV = "AGENT_BROWSER_RESTORE";
const MANAGED_SESSION_RESTORE_ENV = "PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE";
export const MANAGED_SESSION_NAME_PREFIX = "piab-";
const MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH = 32;
const OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP = 2;
const OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function isDisabledEnvFlag(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

/** Match upstream env_var_is_truthy exactly: lowercase only, without trimming or accepting "off". */
function isUpstreamEnvFlagEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	return !["", "0", "false", "no"].includes(value.toLowerCase());
}

function hasUpstreamEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): boolean {
	return env?.[name] !== undefined;
}

function resolveManagedSessionRestoreHome(
	parentEnv: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const configuredHome = platform === "win32" ? parentEnv.USERPROFILE : parentEnv.HOME;
	if (configuredHome !== undefined) return configuredHome.length > 0 && configuredHome.trim() === configuredHome ? configuredHome : undefined;
	const fallback = homedir();
	return fallback.length > 0 && fallback.trim() === fallback ? fallback : undefined;
}

/** Cwd-stable restore key so SSO browser storage survives across Pi chats in the same project. */
export function createManagedSessionRestoreKey(cwd: string): string {
	const digest = createHash("sha256").update(`restore:${cwd}`).digest("hex").slice(0, MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH);
	return `${MANAGED_SESSION_NAME_PREFIX}r-${digest}`;
}

function managedSessionIdentityKey(sessionName: string, namespace?: string): string {
	return namespace ? `${namespace}\0${sessionName}` : sessionName;
}

export interface ManagedSessionRestoreIdentity {
	namespace?: string;
	sessionName: string;
}

export class ManagedSessionRestoreState {
	readonly #disabled = new Set<string>();

	clear(sessionName?: string, namespace?: string): void {
		if (sessionName) this.#disabled.delete(managedSessionIdentityKey(sessionName, namespace));
		else this.#disabled.clear();
	}

	disable(sessionName: string | undefined, namespace?: string): void {
		if (sessionName && sessionName.length > 0) this.#disabled.add(managedSessionIdentityKey(sessionName, namespace));
	}

	isDisabled(sessionName: string | undefined, namespace?: string): boolean {
		return typeof sessionName === "string" && this.#disabled.has(managedSessionIdentityKey(sessionName, namespace));
	}

	replace(identities: ManagedSessionRestoreIdentity[]): void {
		this.#disabled.clear();
		for (const identity of identities) this.disable(identity.sessionName, identity.namespace);
	}
}

export type OwnedManagedSessionContext = {
	namespace?: string;
	/** Original main-plan launch conflict, retained when prepare rewrites subprocess argv. */
	restoreLaunchConflict?: boolean;
	/** One policy decision shared by the main spawn and every helper in this call. */
	restoreDecision?: "enabled" | "incompatible" | "opted-out";
	restoreKey?: string;
	/** Call-scoped only: suppress restore for helper probes without sticky-disabling the session. */
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

export function resolveOwnedManagedSessionContext(options: {
	currentManagedSessionName?: string;
	currentManagedSessionNamespace?: string;
	managedSessionName?: string;
	namespace?: string;
	restoreState: ManagedSessionRestoreState;
	sessionName?: string;
}): OwnedManagedSessionContext | undefined {
	const contextFields = { restoreState: options.restoreState };
	if (options.managedSessionName) return { ...contextFields, namespace: options.namespace, sessionName: options.managedSessionName };
	if (
		options.sessionName &&
		options.currentManagedSessionName &&
		options.sessionName === options.currentManagedSessionName &&
		(options.namespace ?? undefined) === (options.currentManagedSessionNamespace ?? undefined)
	) {
		return { ...contextFields, namespace: options.namespace, sessionName: options.sessionName };
	}
	return undefined;
}

function ownedContextMatches(sessionName: string | undefined, namespace: string | undefined): OwnedManagedSessionContext | undefined {
	const owned = ownedManagedSessionStorage.getStore();
	if (!owned || !sessionName) return undefined;
	if (owned.sessionName !== sessionName || (owned.namespace ?? undefined) !== (namespace ?? undefined)) return undefined;
	return owned;
}

function configPathExistsOrIsUnreadable(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

function hasExplicitConfigArg(args: string[]): boolean {
	return scanUpstreamGlobalFlagOccurrences(args, "--config").length > 0;
}

/** Any upstream config disables automatic restore; content inspection would create parser and resource-exhaustion gaps. */
export function agentBrowserConfigBlocksManagedRestore(
	cwd: string,
	parentEnv: NodeJS.ProcessEnv = process.env,
	args: string[] = [],
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (hasExplicitConfigArg(args) || hasUpstreamEnvValue(parentEnv, "AGENT_BROWSER_CONFIG")) return true;
	const home = resolveManagedSessionRestoreHome(parentEnv, platform);
	if (!home) return true;
	return [join(cwd, "agent-browser.json"), join(home, ".agent-browser", "config.json")]
		.some(configPathExistsOrIsUnreadable);
}

function hasValidEncryptionKey(parentEnv: NodeJS.ProcessEnv): boolean {
	const value = parentEnv.AGENT_BROWSER_ENCRYPTION_KEY;
	return typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
}

/** Require the upstream 256-bit key format and ensure its state parent has owner-only permissions. */
export function ensureManagedSessionRestoreStorageIsSecure(
	parentEnv: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const encryptionKey = parentEnv.AGENT_BROWSER_ENCRYPTION_KEY;
	if (encryptionKey !== undefined && !hasValidEncryptionKey(parentEnv)) return false;
	if (platform === "win32") return hasValidEncryptionKey(parentEnv);
	const home = resolveManagedSessionRestoreHome(parentEnv, platform);
	if (!home) return false;
	const root = join(home, ".agent-browser");
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		let rootEntry = lstatSync(root);
		if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) return false;
		if ((rootEntry.mode & 0o077) !== 0) {
			chmodSync(root, 0o700);
			rootEntry = lstatSync(root);
		}
		return !rootEntry.isSymbolicLink() && rootEntry.isDirectory() && (rootEntry.mode & 0o077) === 0;
	} catch {
		return false;
	}
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
	wrapperInjectedUserAgent?: boolean;
};

function hasManagedSessionRestoreLaunchConflict(options: ManagedSessionRestorePolicyOptions): boolean {
	const parentEnv = options.parentEnv ?? process.env;
	const args = omitWrapperInjectedUserAgent(options.args, options.wrapperInjectedUserAgent);
	if (MANAGED_RESTORE_INCOMPATIBLE_ENVS.some((name) =>
		hasUpstreamEnvValue(parentEnv, name) || hasUpstreamEnvValue(options.env, name))) return true;
	if (MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS.some((name) =>
		isUpstreamEnvFlagEnabled(parentEnv[name]) || isUpstreamEnvFlagEnabled(options.env?.[name]))) return true;
	if (MANAGED_RESTORE_INCOMPATIBLE_FLAGS.some((flag) => hasLaunchScopedFlagToken(args, flag))) return true;
	if (parseCommandInfo(args).command === "connect") return true;
	return hasExplicitConfigArg(args) || hasUpstreamEnvValue({ ...parentEnv, ...options.env }, "AGENT_BROWSER_CONFIG");
}

function managedSessionRestoreOptedOut(options: ManagedSessionRestorePolicyOptions): boolean {
	const parentEnv = options.parentEnv ?? process.env;
	return isDisabledEnvFlag(parentEnv[MANAGED_SESSION_RESTORE_ENV]) || isDisabledEnvFlag(options.env?.[MANAGED_SESSION_RESTORE_ENV]);
}

function isManagedSessionRestoreIncompatible(options: ManagedSessionRestorePolicyOptions): boolean {
	if (hasManagedSessionRestoreLaunchConflict(options)) return true;
	if (managedSessionRestoreOptedOut(options)) return false;
	const effectiveEnv = { ...(options.parentEnv ?? process.env), ...options.env };
	const args = omitWrapperInjectedUserAgent(options.args, options.wrapperInjectedUserAgent);
	if (options.cwd && agentBrowserConfigBlocksManagedRestore(options.cwd, effectiveEnv, args)) return true;
	return !ensureManagedSessionRestoreStorageIsSecure(effectiveEnv);
}

export interface ManagedSessionRestoreEnvOptions {
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	ownedManagedSession?: boolean;
	parentEnv?: NodeJS.ProcessEnv;
	restoreState?: ManagedSessionRestoreState;
}

function resolveManagedSessionRestorePolicy(options: ManagedSessionRestoreEnvOptions) {
	const parentEnv = options.parentEnv ?? process.env;
	const sessionName = extractExplicitSessionName(options.args);
	const namespace = extractExplicitNamespace(options.args);
	const ownedContext = ownedContextMatches(sessionName, namespace);
	const restoreState = ownedContext?.restoreState ?? options.restoreState;
	const owned = (options.ownedManagedSession || ownedContext !== undefined) && restoreState !== undefined;
	return { namespace, owned, ownedContext, parentEnv, restoreState, sessionName };
}

/** Build env for an upstream managed-session subprocess without exposing caller-owned sessions or mutating sticky state. */
export function getManagedSessionRestoreEnv(options: ManagedSessionRestoreEnvOptions): NodeJS.ProcessEnv {
	const { namespace, owned, ownedContext, parentEnv, restoreState, sessionName } = resolveManagedSessionRestorePolicy(options);
	if (!owned || !restoreState) return {};
	if (ownedContext?.restoreDecision) {
		if (ownedContext.restoreDecision !== "enabled") return {};
		if (restoreState.isDisabled(sessionName, namespace) || !sessionName || !ownedContext.restoreKey) return {};
		return { [AGENT_BROWSER_RESTORE_ENV]: ownedContext.restoreKey };
	}

	const policyOptions = { ...options, parentEnv };
	if (managedSessionRestoreOptedOut(policyOptions) || ownedContext?.restoreSuppressed || isManagedSessionRestoreIncompatible(policyOptions)) return {};
	if (restoreState.isDisabled(sessionName, namespace) || !sessionName) return {};
	return { [AGENT_BROWSER_RESTORE_ENV]: createManagedSessionRestoreKey(options.cwd) };
}

/** Commit sticky suppression only after an owned-context subprocess has actually spawned. */
export function commitManagedSessionRestoreSuppression(options: ManagedSessionRestoreEnvOptions): void {
	const { namespace, owned, ownedContext, parentEnv, restoreState, sessionName } = resolveManagedSessionRestorePolicy(options);
	if (!owned || !restoreState) return;
	if (ownedContext?.restoreDecision) {
		if (ownedContext.restoreDecision !== "enabled") restoreState.disable(sessionName, namespace);
		return;
	}
	const policyOptions = { ...options, parentEnv };
	if (managedSessionRestoreOptedOut(policyOptions) || ownedContext?.restoreSuppressed || isManagedSessionRestoreIncompatible(policyOptions)) {
		restoreState.disable(sessionName, namespace);
	}
}

/** Build call-scoped restore suppression from the original main-plan argv. */
export function buildOwnedManagedSessionRestoreContext(options: {
	args: string[];
	cwd: string;
	currentManagedSessionName?: string;
	currentManagedSessionNamespace?: string;
	env?: NodeJS.ProcessEnv;
	managedSessionName?: string;
	namespace?: string;
	parentEnv?: NodeJS.ProcessEnv;
	restoreState: ManagedSessionRestoreState;
	sessionName?: string;
	wrapperInjectedUserAgent?: boolean;
}): OwnedManagedSessionContext | undefined {
	const owned = resolveOwnedManagedSessionContext(options);
	if (!owned) return undefined;
	const policyOptions = {
		args: options.args,
		cwd: options.cwd,
		env: options.env,
		parentEnv: options.parentEnv,
		wrapperInjectedUserAgent: options.wrapperInjectedUserAgent,
	};
	const restoreLaunchConflict = hasManagedSessionRestoreLaunchConflict(policyOptions);
	const optedOut = managedSessionRestoreOptedOut(policyOptions);
	const incompatible = !optedOut && isManagedSessionRestoreIncompatible(policyOptions);
	return {
		...owned,
		restoreDecision: optedOut ? "opted-out" : incompatible ? "incompatible" : "enabled",
		restoreKey: createManagedSessionRestoreKey(options.cwd),
		restoreLaunchConflict,
		restoreSuppressed: optedOut || incompatible,
	};
}

function isRealDirectory(path: string): boolean {
	try {
		const entry = lstatSync(path);
		return entry.isDirectory() && !entry.isSymbolicLink();
	} catch {
		return false;
	}
}

function getManagedRestoreSessionsDirectories(root: string): string[] {
	if (!isRealDirectory(root)) return [];
	const directories: string[] = [];
	const rootSessions = join(root, "sessions");
	if (isRealDirectory(rootSessions)) directories.push(rootSessions);
	const namespacesRoot = join(root, "namespaces");
	if (!isRealDirectory(namespacesRoot)) return directories;
	try {
		for (const entry of readdirSync(namespacesRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const namespaceRoot = join(namespacesRoot, entry.name);
			const stateRoot = join(namespaceRoot, "state");
			const sessions = join(stateRoot, "sessions");
			if (isRealDirectory(namespaceRoot) && isRealDirectory(stateRoot) && isRealDirectory(sessions)) directories.push(sessions);
		}
	} catch {
		return directories;
	}
	return directories;
}

/** After an owned close, expire only this wrapper key's old snapshots while retaining two fallback families. */
export function pruneOwnedManagedSessionRestoreSnapshots(
	cwd: string,
	parentEnv: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): number {
	const home = resolveManagedSessionRestoreHome(parentEnv, platform);
	if (!home) return 0;
	const root = join(home, ".agent-browser");
	const encryptionKey = parentEnv.AGENT_BROWSER_ENCRYPTION_KEY;
	if (encryptionKey !== undefined && !hasValidEncryptionKey(parentEnv)) return 0;
	if (platform === "win32" && !hasValidEncryptionKey(parentEnv)) return 0;
	if (platform !== "win32") {
		try {
			const rootEntry = lstatSync(root);
			if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory() || (rootEntry.mode & 0o077) !== 0) return 0;
		} catch {
			return 0;
		}
	}
	const restoreKey = createManagedSessionRestoreKey(cwd);
	const namePrefix = `${restoreKey}-`;
	let removed = 0;
	for (const directory of getManagedRestoreSessionsDirectories(root)) {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		const families = new Map<string, { mtimeMs: number; paths: string[] }>();
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.startsWith(namePrefix) || !/\.json(?:\.enc)?(?:\.previous)?$/.test(entry.name)) continue;
			const path = join(directory, entry.name);
			try {
				const fileEntry = lstatSync(path);
				if (fileEntry.isSymbolicLink() || !fileEntry.isFile()) continue;
				const familyName = entry.name.endsWith(".previous") ? entry.name.slice(0, -".previous".length) : entry.name;
				const family = families.get(familyName) ?? { mtimeMs: 0, paths: [] };
				family.mtimeMs = Math.max(family.mtimeMs, fileEntry.mtimeMs);
				family.paths.push(path);
				families.set(familyName, family);
			} catch {
				continue;
			}
		}
		const staleBefore = Date.now() - OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS;
		const staleFamilies = [...families.values()]
			.sort((left, right) => right.mtimeMs - left.mtimeMs)
			.slice(OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP)
			.filter((family) => family.mtimeMs < staleBefore);
		for (const family of staleFamilies) {
			for (const path of family.paths) {
				try {
					const current = lstatSync(path);
					if (current.isSymbolicLink() || !current.isFile() || current.mtimeMs >= staleBefore) continue;
					unlinkSync(path);
					removed += 1;
				} catch {
					// Best effort after the daemon has closed; a later owned close retries cleanup.
				}
			}
		}
	}
	return removed;
}
