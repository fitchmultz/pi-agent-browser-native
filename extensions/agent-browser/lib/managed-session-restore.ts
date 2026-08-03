/**
 * Purpose: Own automatic restore policy for wrapper-managed browser sessions.
 * Responsibilities: Resolve owned session identity, isolate per-call helper policy, reject incompatible argv/env/config, secure upstream state storage, and persist sticky restore-disable state.
 * Scope: Managed restore only; general argv/session planning stays in runtime.ts and process spawning stays in process.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseCommandInfo } from "./argv-descriptor.js";
import { VALUE_FLAGS, optionalGlobalValueFlagConsumesNext } from "./argv-grammar.js";
import {
	hasLaunchScopedFlagToken,
	MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_FLAGS,
} from "./launch-scoped-flags.js";

const AGENT_BROWSER_RESTORE_ENV = "AGENT_BROWSER_RESTORE";
const MANAGED_SESSION_RESTORE_ENV = "PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE";
export const MANAGED_SESSION_NAME_PREFIX = "piab-";
export const OWNED_MANAGED_SESSION_ENV = "PI_AGENT_BROWSER_OWNED_MANAGED_SESSION";
const MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH = 32;

function isDisabledEnvFlag(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function isEnabledEnvFlag(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	if (normalized.length === 0) return false;
	return !isDisabledEnvFlag(normalized);
}

/** Match upstream env_var_is_truthy exactly: lowercase only, without trimming or accepting "off". */
function isUpstreamEnvFlagEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	return !["", "0", "false", "no"].includes(value.toLowerCase());
}

function hasNonEmptyEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): boolean {
	const value = env?.[name];
	return typeof value === "string" && value.trim().length > 0;
}

/** Cwd-stable restore key so SSO browser storage survives across Pi chats in the same project. */
export function createManagedSessionRestoreKey(cwd: string): string {
	const digest = createHash("sha256").update(`restore:${cwd}`).digest("hex").slice(0, MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH);
	return `${MANAGED_SESSION_NAME_PREFIX}r-${digest}`;
}

const managedSessionsWithRestoreDisabled = new Set<string>();

export type OwnedManagedSessionContext = {
	namespace?: string;
	/** Original main-plan launch conflict, retained when prepare rewrites subprocess argv. */
	restoreLaunchConflict?: boolean;
	/** Call-scoped only: suppress restore for helper probes without sticky-disabling the session. */
	restoreSuppressed?: boolean;
	sessionName: string;
};

function managedSessionIdentityKey(sessionName: string, namespace?: string): string {
	return namespace ? `${namespace}\0${sessionName}` : sessionName;
}

export function markManagedSessionRestoreDisabled(sessionName: string, namespace?: string): void {
	if (sessionName.trim().length > 0) managedSessionsWithRestoreDisabled.add(managedSessionIdentityKey(sessionName, namespace));
}

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
	sessionName?: string;
}): OwnedManagedSessionContext | undefined {
	if (options.managedSessionName) return { namespace: options.namespace, sessionName: options.managedSessionName };
	if (
		options.sessionName &&
		options.currentManagedSessionName &&
		options.sessionName === options.currentManagedSessionName &&
		(options.namespace ?? undefined) === (options.currentManagedSessionNamespace ?? undefined)
	) {
		return { namespace: options.namespace, sessionName: options.sessionName };
	}
	return undefined;
}

export function clearManagedSessionRestoreDisabled(sessionName?: string, namespace?: string): void {
	if (sessionName) managedSessionsWithRestoreDisabled.delete(managedSessionIdentityKey(sessionName, namespace));
	else managedSessionsWithRestoreDisabled.clear();
}

export function isManagedSessionRestoreDisabled(sessionName: string | undefined, namespace?: string): boolean {
	return typeof sessionName === "string" && managedSessionsWithRestoreDisabled.has(managedSessionIdentityKey(sessionName, namespace));
}

function disableManagedSessionRestore(sessionName: string | undefined, namespace?: string): void {
	if (sessionName) markManagedSessionRestoreDisabled(sessionName, namespace);
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
	for (const token of args) {
		if (token === "--") return false;
		if (token === "--config" || token.startsWith("--config=")) return true;
	}
	return false;
}

/** Any upstream config disables automatic restore; content inspection would create parser and resource-exhaustion gaps. */
export function agentBrowserConfigBlocksManagedRestore(
	cwd: string,
	parentEnv: NodeJS.ProcessEnv = process.env,
	args: string[] = [],
): boolean {
	if (hasExplicitConfigArg(args) || parentEnv.AGENT_BROWSER_CONFIG?.trim()) return true;
	const home = parentEnv.HOME?.trim() || parentEnv.USERPROFILE?.trim() || homedir();
	return [join(cwd, "agent-browser.json"), join(home, ".agent-browser", "config.json")]
		.some(configPathExistsOrIsUnreadable);
}

function hasValidEncryptionKey(parentEnv: NodeJS.ProcessEnv): boolean {
	const value = parentEnv.AGENT_BROWSER_ENCRYPTION_KEY?.trim();
	return typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
}

/** Require the upstream 256-bit key format and protect its state parent with owner-only permissions. */
export function managedSessionRestoreStorageIsSecure(
	parentEnv: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const encryptionKey = parentEnv.AGENT_BROWSER_ENCRYPTION_KEY;
	if (encryptionKey !== undefined && !hasValidEncryptionKey(parentEnv)) return false;
	if (platform === "win32") return hasValidEncryptionKey(parentEnv);
	const home = parentEnv.HOME?.trim() || parentEnv.USERPROFILE?.trim() || homedir();
	if (!home) return false;
	const root = join(home, ".agent-browser");
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		let rootEntry = lstatSync(root);
		if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) return false;
		chmodSync(root, 0o700);
		rootEntry = lstatSync(root);
		return !rootEntry.isSymbolicLink() && rootEntry.isDirectory() && (rootEntry.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

type ManagedSessionRestorePolicyOptions = {
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	parentEnv?: NodeJS.ProcessEnv;
};

function hasManagedSessionRestoreLaunchConflict(options: ManagedSessionRestorePolicyOptions): boolean {
	const parentEnv = options.parentEnv ?? process.env;
	if (MANAGED_RESTORE_INCOMPATIBLE_ENVS.some((name) =>
		hasNonEmptyEnvValue(parentEnv, name) || hasNonEmptyEnvValue(options.env, name))) return true;
	if (MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS.some((name) =>
		isUpstreamEnvFlagEnabled(parentEnv[name]) || isUpstreamEnvFlagEnabled(options.env?.[name]))) return true;
	if (MANAGED_RESTORE_INCOMPATIBLE_FLAGS.some((flag) => hasLaunchScopedFlagToken(options.args, flag))) return true;
	if (parseCommandInfo(options.args).command === "connect") return true;
	return hasExplicitConfigArg(options.args) || hasNonEmptyEnvValue({ ...parentEnv, ...options.env }, "AGENT_BROWSER_CONFIG");
}

function managedSessionRestoreOptedOut(options: ManagedSessionRestorePolicyOptions): boolean {
	const parentEnv = options.parentEnv ?? process.env;
	return isDisabledEnvFlag(parentEnv[MANAGED_SESSION_RESTORE_ENV]) || isDisabledEnvFlag(options.env?.[MANAGED_SESSION_RESTORE_ENV]);
}

function isManagedSessionRestoreIncompatible(options: ManagedSessionRestorePolicyOptions): boolean {
	if (hasManagedSessionRestoreLaunchConflict(options)) return true;
	if (managedSessionRestoreOptedOut(options)) return false;
	const effectiveEnv = { ...(options.parentEnv ?? process.env), ...options.env };
	if (options.cwd && agentBrowserConfigBlocksManagedRestore(options.cwd, effectiveEnv, options.args)) return true;
	return !managedSessionRestoreStorageIsSecure(effectiveEnv);
}

function extractGlobalFlagValue(args: string[], targetFlag: string): string | undefined {
	let value: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === "--") break;
		if (token === targetFlag) {
			value = args[index + 1];
			index += 1;
			continue;
		}
		if (token.startsWith(`${targetFlag}=`)) {
			value = token.slice(targetFlag.length + 1);
			continue;
		}
		const flag = token.split("=", 1)[0] ?? token;
		if (!token.includes("=") && (VALUE_FLAGS.has(flag) || optionalGlobalValueFlagConsumesNext(flag, args[index + 1]))) index += 1;
	}
	return value;
}

export function extractExplicitSessionName(args: string[]): string | undefined {
	return extractGlobalFlagValue(args, "--session");
}

export function extractExplicitNamespace(args: string[]): string | undefined {
	return extractGlobalFlagValue(args, "--namespace");
}

/** Build env for an upstream managed-session subprocess without exposing caller-owned sessions. */
export function getManagedSessionRestoreEnv(options: {
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	parentEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
	const parentEnv = options.parentEnv ?? process.env;
	const sessionName = extractExplicitSessionName(options.args);
	const namespace = extractExplicitNamespace(options.args);
	const ownedFromEnv = isEnabledEnvFlag(options.env?.[OWNED_MANAGED_SESSION_ENV]);
	const ownedContext = ownedContextMatches(sessionName, namespace);
	if (!ownedFromEnv && !ownedContext) return {};

	const policyOptions = { ...options, parentEnv };
	if (managedSessionRestoreOptedOut(policyOptions)) {
		if (ownedFromEnv && (ownedContext?.restoreLaunchConflict || hasManagedSessionRestoreLaunchConflict(policyOptions))) disableManagedSessionRestore(sessionName, namespace);
		return {};
	}
	if (ownedContext?.restoreSuppressed) {
		if (ownedFromEnv) disableManagedSessionRestore(sessionName, namespace);
		return {};
	}
	if (isManagedSessionRestoreIncompatible(policyOptions)) {
		if (ownedFromEnv) disableManagedSessionRestore(sessionName, namespace);
		return {};
	}
	if (isManagedSessionRestoreDisabled(sessionName, namespace) || !sessionName) return {};
	return { [AGENT_BROWSER_RESTORE_ENV]: createManagedSessionRestoreKey(options.cwd) };
}

/** Build call-scoped restore suppression from the original main-plan argv. */
export function buildOwnedManagedSessionRestoreContext(options: {
	args: string[];
	cwd: string;
	currentManagedSessionName?: string;
	currentManagedSessionNamespace?: string;
	managedSessionName?: string;
	namespace?: string;
	sessionName?: string;
}): OwnedManagedSessionContext | undefined {
	const owned = resolveOwnedManagedSessionContext(options);
	if (!owned) return undefined;
	const policyOptions = { args: options.args, cwd: options.cwd };
	return {
		...owned,
		restoreLaunchConflict: hasManagedSessionRestoreLaunchConflict(policyOptions),
		restoreSuppressed: isManagedSessionRestoreIncompatible(policyOptions),
	};
}

export function buildOwnedManagedSessionEnv(): NodeJS.ProcessEnv {
	return { [OWNED_MANAGED_SESSION_ENV]: "1" };
}
