/**
 * Purpose: Own automatic restore policy for wrapper-managed browser sessions.
 * Responsibilities: Resolve owned session identity, isolate per-call helper policy, reject incompatible argv/env/config, secure upstream state storage, and persist sticky restore-disable state.
 * Scope: Managed restore only; general argv/session planning stays in runtime.ts and process spawning stays in process.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";

import { extractCommandTokens, parseCommandInfo } from "./argv-descriptor.js";
import {
	canonicalizeAgentBrowserNamespace,
	extractExplicitNamespace,
	extractExplicitSessionName,
	getAgentBrowserSessionIdentityKey,
	scanUpstreamGlobalFlagOccurrences,
} from "./argv-grammar.js";
import {
	hasLaunchScopedFlagToken,
	MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_ENVS,
	MANAGED_RESTORE_INCOMPATIBLE_FLAGS,
} from "./launch-scoped-flags.js";
import { parseUserBatchStdin } from "./orchestration/batch-stdin.js";

const AGENT_BROWSER_RESTORE_ENV = "AGENT_BROWSER_RESTORE";
const MANAGED_SESSION_RESTORE_ENV = "PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE";
export const MANAGED_SESSION_NAME_PREFIX = "piab-";
const MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH = 32;
const OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP = 2;
const OWNED_RESTORE_SNAPSHOT_MANIFEST_MAX_BYTES = 128 * 1_024;
const OWNED_RESTORE_SNAPSHOT_MANIFEST_MAX_PATHS = 1_024;
const OWNED_RESTORE_SNAPSHOT_MANIFEST_NAME = ".pi-agent-browser-owned-snapshots-v1";
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

function isAbsoluteHome(path: string, platform: NodeJS.Platform): boolean {
	return platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
}

function resolveManagedSessionRestoreHome(
	parentEnv: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const configuredHome = platform === "win32" ? parentEnv.USERPROFILE : parentEnv.HOME;
	if (configuredHome !== undefined) {
		return configuredHome.length > 0 && configuredHome.trim() === configuredHome && isAbsoluteHome(configuredHome, platform)
			? configuredHome
			: undefined;
	}
	const fallback = homedir();
	return fallback.length > 0 && fallback.trim() === fallback && isAbsoluteHome(fallback, platform) ? fallback : undefined;
}

/** Cwd-stable restore key so SSO browser storage survives across Pi chats in the same project. */
export function createManagedSessionRestoreKey(cwd: string): string {
	let canonicalCwd = resolve(cwd);
	try {
		canonicalCwd = realpathSync(canonicalCwd);
	} catch {
		// The tool cwd normally exists; lexical resolution keeps direct unit callers deterministic.
	}
	const digest = createHash("sha256").update(`restore:${canonicalCwd}`).digest("hex").slice(0, MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH);
	return `${MANAGED_SESSION_NAME_PREFIX}r-${digest}`;
}

export interface ManagedSessionRestoreIdentity {
	namespace?: string;
	sessionName: string;
}

export class ManagedSessionRestoreState {
	readonly #disabled = new Set<string>();

	clear(sessionName?: string, namespace?: string): void {
		if (sessionName) this.#disabled.delete(getAgentBrowserSessionIdentityKey(sessionName, namespace));
		else this.#disabled.clear();
	}

	disable(sessionName: string | undefined, namespace?: string): void {
		if (sessionName && sessionName.length > 0) this.#disabled.add(getAgentBrowserSessionIdentityKey(sessionName, namespace));
	}

	isDisabled(sessionName: string | undefined, namespace?: string): boolean {
		return typeof sessionName === "string" && this.#disabled.has(getAgentBrowserSessionIdentityKey(sessionName, namespace));
	}

	replace(identities: ManagedSessionRestoreIdentity[]): void {
		this.#disabled.clear();
		for (const identity of identities) this.disable(identity.sessionName, identity.namespace);
	}
}

export type OwnedManagedSessionContext = {
	namespace?: string;
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
	const namespace = canonicalizeAgentBrowserNamespace(options.namespace);
	const currentManagedSessionNamespace = canonicalizeAgentBrowserNamespace(options.currentManagedSessionNamespace);
	if (options.managedSessionName) return { ...contextFields, namespace, sessionName: options.managedSessionName };
	if (
		options.sessionName &&
		options.currentManagedSessionName &&
		options.sessionName === options.currentManagedSessionName &&
		namespace === currentManagedSessionNamespace
	) {
		return { ...contextFields, namespace, sessionName: options.sessionName };
	}
	return undefined;
}

function ownedContextMatches(sessionName: string | undefined, namespace: string | undefined): OwnedManagedSessionContext | undefined {
	const owned = ownedManagedSessionStorage.getStore();
	if (!owned || !sessionName) return undefined;
	if (owned.sessionName !== sessionName || owned.namespace !== canonicalizeAgentBrowserNamespace(namespace)) return undefined;
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

function ensureOwnerOnlyDirectory(path: string): boolean {
	try {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		let entry = lstatSync(path);
		if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
		if ((entry.mode & 0o077) !== 0) {
			chmodSync(path, 0o700);
			entry = lstatSync(path);
		}
		return !entry.isSymbolicLink() && entry.isDirectory() && (entry.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

function directoryContainsSymlink(path: string): boolean {
	try {
		return readdirSync(path, { withFileTypes: true }).some((entry) => entry.isSymbolicLink());
	} catch {
		return true;
	}
}

/** Require the upstream 256-bit key format and secure every directory that can receive restore snapshots. */
export function ensureManagedSessionRestoreStorageIsSecure(
	parentEnv: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	namespace?: string,
): boolean {
	const encryptionKey = parentEnv.AGENT_BROWSER_ENCRYPTION_KEY;
	if (encryptionKey !== undefined && !hasValidEncryptionKey(parentEnv)) return false;
	if (platform === "win32") return hasValidEncryptionKey(parentEnv);
	const home = resolveManagedSessionRestoreHome(parentEnv, platform);
	if (!home) return false;
	const root = join(home, ".agent-browser");
	if (!ensureOwnerOnlyDirectory(root)) return false;
	const canonicalNamespace = canonicalizeAgentBrowserNamespace(namespace);
	const stateComponents = canonicalNamespace
		? ["namespaces", canonicalNamespace, "state", "sessions"]
		: ["sessions"];
	let path = root;
	for (const component of stateComponents) {
		path = join(path, component);
		if (!ensureOwnerOnlyDirectory(path)) return false;
	}
	if (directoryContainsSymlink(path)) return false;
	const temporaryDirectory = join(path, ".tmp");
	return ensureOwnerOnlyDirectory(temporaryDirectory) && !directoryContainsSymlink(temporaryDirectory);
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
	const [command, ...commandArgs] = extractCommandTokens(args);
	if (command !== "batch") return false;
	if (commandArgs.some((token) => token !== "--bail")) return true;
	const parsed = parseUserBatchStdin(stdin);
	if (parsed.error || !parsed.steps) return false;
	return parsed.steps.some((step) => {
		const nestedCommand = parseCommandInfo(step).command;
		return nestedCommand === "connect" || nestedCommand === "batch";
	});
}

function hasManagedSessionRestoreLaunchConflict(options: ManagedSessionRestorePolicyOptions): boolean {
	const parentEnv = options.parentEnv ?? process.env;
	const args = omitWrapperInjectedUserAgent(options.args, options.wrapperInjectedUserAgent);
	if (MANAGED_RESTORE_INCOMPATIBLE_ENVS.some((name) =>
		hasUpstreamEnvValue(parentEnv, name) || hasUpstreamEnvValue(options.env, name))) return true;
	if (MANAGED_RESTORE_INCOMPATIBLE_BOOLEAN_ENVS.some((name) =>
		isUpstreamEnvFlagEnabled(parentEnv[name]) || isUpstreamEnvFlagEnabled(options.env?.[name]))) return true;
	if (MANAGED_RESTORE_INCOMPATIBLE_FLAGS.some((flag) => hasLaunchScopedFlagToken(args, flag))) return true;
	if (parseCommandInfo(args).command === "connect" || batchHasManagedSessionRestoreConflict(args, options.stdin)) return true;
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
	const parentEnv = options.parentEnv ?? process.env;
	const sessionName = extractExplicitSessionName(options.args);
	const namespace = extractExplicitNamespace(options.args);
	const ownedContext = ownedContextMatches(sessionName, namespace);
	const restoreState = ownedContext?.restoreState ?? options.restoreState;
	const owned = (options.ownedManagedSession || ownedContext !== undefined) && restoreState !== undefined;
	return { namespace, owned, ownedContext, parentEnv, restoreState, sessionName };
}

/** Pin wrapper-owned subprocesses to their recorded namespace, including the default namespace. */
export function getOwnedManagedSessionNamespaceEnv(options: ManagedSessionRestoreEnvOptions): NodeJS.ProcessEnv {
	const { namespace, owned, ownedContext } = resolveManagedSessionRestorePolicy(options);
	return owned ? { AGENT_BROWSER_NAMESPACE: ownedContext?.namespace ?? namespace ?? "" } : {};
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
	stdin?: string;
	wrapperInjectedUserAgent?: boolean;
}): OwnedManagedSessionContext | undefined {
	const owned = resolveOwnedManagedSessionContext(options);
	if (!owned) return undefined;
	const policyOptions = {
		args: options.args,
		cwd: options.cwd,
		env: options.env,
		parentEnv: options.parentEnv,
		stdin: options.stdin,
		wrapperInjectedUserAgent: options.wrapperInjectedUserAgent,
	};
	const optedOut = managedSessionRestoreOptedOut(policyOptions);
	const incompatible = !optedOut && isManagedSessionRestoreIncompatible(policyOptions);
	return {
		...owned,
		restoreDecision: optedOut ? "opted-out" : incompatible ? "incompatible" : "enabled",
		restoreKey: createManagedSessionRestoreKey(options.cwd),
		restoreSuppressed: optedOut || incompatible,
	};
}

function getManagedRestoreSessionsDirectory(home: string, namespace?: string): string {
	const canonicalNamespace = canonicalizeAgentBrowserNamespace(namespace);
	return canonicalNamespace
		? join(home, ".agent-browser", "namespaces", canonicalNamespace, "state", "sessions")
		: join(home, ".agent-browser", "sessions");
}

function validateOwnedSnapshotPath(options: {
	cwd: string;
	home: string;
	namespace?: string;
	path: string;
}): string | undefined {
	const path = resolve(options.path);
	const directory = getManagedRestoreSessionsDirectory(options.home, options.namespace);
	const name = basename(path);
	if (dirname(path) !== directory || !name.startsWith(`${createManagedSessionRestoreKey(options.cwd)}-`)) return undefined;
	if (!/\.json(?:\.enc)?$/.test(name)) return undefined;
	try {
		const entry = lstatSync(path);
		return !entry.isSymbolicLink() && entry.isFile() ? path : undefined;
	} catch {
		return undefined;
	}
}

function readOwnedSnapshotManifest(directory: string, platform: NodeJS.Platform): string[] | undefined {
	const path = join(directory, OWNED_RESTORE_SNAPSHOT_MANIFEST_NAME);
	try {
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() || !entry.isFile() || entry.size > OWNED_RESTORE_SNAPSHOT_MANIFEST_MAX_BYTES) return undefined;
		if (platform !== "win32" && (entry.mode & 0o077) !== 0) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!Array.isArray(parsed) || parsed.length > OWNED_RESTORE_SNAPSHOT_MANIFEST_MAX_PATHS) return undefined;
		return parsed.every((value) => typeof value === "string" && value.length > 0 && isAbsolute(value))
			? [...new Set(parsed)]
			: undefined;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
	}
}

function writeOwnedSnapshotManifest(directory: string, paths: string[]): boolean {
	const content = JSON.stringify(paths);
	if (paths.length > OWNED_RESTORE_SNAPSHOT_MANIFEST_MAX_PATHS || Buffer.byteLength(content) > OWNED_RESTORE_SNAPSHOT_MANIFEST_MAX_BYTES) return false;
	const manifestPath = join(directory, OWNED_RESTORE_SNAPSHOT_MANIFEST_NAME);
	const temporaryPath = join(directory, ".tmp", `${OWNED_RESTORE_SNAPSHOT_MANIFEST_NAME}-${process.pid}-${randomUUID()}`);
	try {
		writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, manifestPath);
		return true;
	} catch {
		return false;
	} finally {
		try { unlinkSync(temporaryPath); } catch {}
	}
}

/** After an owned close, expire only ownership-manifest snapshots while retaining two fallbacks. */
export function pruneOwnedManagedSessionRestoreSnapshots(options: {
	cwd: string;
	namespace?: string;
	parentEnv?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	statePath?: string;
}): number {
	const parentEnv = options.parentEnv ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = resolveManagedSessionRestoreHome(parentEnv, platform);
	if (!home) return 0;
	const directory = getManagedRestoreSessionsDirectory(home, options.namespace);
	const manifestPath = join(directory, OWNED_RESTORE_SNAPSHOT_MANIFEST_NAME);
	if (!options.statePath && !configPathExistsOrIsUnreadable(manifestPath)) return 0;
	if (!ensureManagedSessionRestoreStorageIsSecure(parentEnv, platform, options.namespace)) return 0;
	const persistedPaths = readOwnedSnapshotManifest(directory, platform);
	if (!persistedPaths) return 0;
	const recordedPaths = new Set(persistedPaths);
	if (options.statePath) {
		const ownedPath = validateOwnedSnapshotPath({ cwd: options.cwd, home, namespace: options.namespace, path: options.statePath });
		if (ownedPath) recordedPaths.add(ownedPath);
	}
	const currentPrefix = `${createManagedSessionRestoreKey(options.cwd)}-`;
	const otherOwnedPaths = [...recordedPaths].filter((path) => dirname(resolve(path)) !== directory || !basename(path).startsWith(currentPrefix));
	const otherOwnedPathSet = new Set(otherOwnedPaths);
	const snapshots: Array<{ mtimeMs: number; path: string }> = [];
	for (const recordedPath of recordedPaths) {
		if (otherOwnedPathSet.has(recordedPath)) continue;
		const path = validateOwnedSnapshotPath({ cwd: options.cwd, home, namespace: options.namespace, path: recordedPath });
		if (!path) continue;
		try {
			snapshots.push({ mtimeMs: lstatSync(path).mtimeMs, path });
		} catch {
			continue;
		}
	}
	if (!writeOwnedSnapshotManifest(directory, [...otherOwnedPaths, ...snapshots.map((snapshot) => snapshot.path)])) return 0;
	const staleBefore = Date.now() - OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS;
	let removed = 0;
	const removedPaths = new Set<string>();
	for (const snapshot of snapshots
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
		.slice(OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP)) {
		if (snapshot.mtimeMs >= staleBefore) continue;
		try {
			const current = lstatSync(snapshot.path);
			if (current.isSymbolicLink() || !current.isFile() || current.mtimeMs >= staleBefore) continue;
			unlinkSync(snapshot.path);
			removedPaths.add(snapshot.path);
			removed += 1;
		} catch {
			// Best effort after the daemon has closed; a later owned close retries cleanup.
		}
	}
	if (removedPaths.size > 0) {
		writeOwnedSnapshotManifest(directory, [...otherOwnedPaths, ...snapshots
			.filter((snapshot) => !removedPaths.has(snapshot.path))
			.map((snapshot) => snapshot.path)]);
	}
	return removed;
}
