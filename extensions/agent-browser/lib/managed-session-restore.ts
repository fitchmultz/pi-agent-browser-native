/**
 * Purpose: Own automatic restore policy for wrapper-managed browser sessions.
 * Responsibilities: Resolve owned session identity, isolate per-call helper policy, reject incompatible argv/env/config, secure upstream state storage, and persist sticky restore-disable state.
 * Scope: Managed restore only; general argv/session planning stays in runtime.ts and process spawning stays in process.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import { buildProcessStartIdentityCommand, normalizeProcessStartIdentity, processStartIdentitiesMatch } from "./process-identity.js";
import { writeSecureTempFile } from "./temp.js";

const AGENT_BROWSER_CONFIG_ENV = "AGENT_BROWSER_CONFIG";
const AGENT_BROWSER_RESTORE_ENV = "AGENT_BROWSER_RESTORE";
const MANAGED_SESSION_RESTORE_ENV = "PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE";
export const MANAGED_SESSION_NAME_PREFIX = "piab-";
const MANAGED_SESSION_RESTORE_EMPTY_CONFIG_CONTENT = "{}\n";
const MANAGED_SESSION_RESTORE_EMPTY_CONFIG_NAME = ".pi-agent-browser-managed-restore-config-v1.json";
const MANAGED_SESSION_RESTORE_KEY_HASH_LENGTH = 32;
const OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP = 2;
const OWNED_RESTORE_SNAPSHOT_MAX_RECORDS = 256;
const OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES = 16 * 1_024;
const OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX = ".pi-agent-browser-owned-snapshots-v1";
const OWNED_RESTORE_SNAPSHOT_MANIFEST_LOCK_STALE_MS = 30_000;
const OWNED_RESTORE_SNAPSHOT_MANIFEST_LOCK_WAIT_MS = 1_000;
const OWNED_RESTORE_SNAPSHOT_MANIFEST_LOCK_RETRY_MS = 10;
const OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const ownedRestoreSnapshotManifestLockWaitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
let currentProcessStartIdentity: string | undefined;
let managedSessionRestoreEmptyConfigPath: string | undefined;
let managedSessionRestoreEmptyConfigPromise: Promise<string> | undefined;

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

export function cleanupManagedSessionRestoreConfig(): void {
	if (managedSessionRestoreEmptyConfigPath) {
		try { unlinkSync(managedSessionRestoreEmptyConfigPath); } catch {}
	}
	managedSessionRestoreEmptyConfigPath = undefined;
	managedSessionRestoreEmptyConfigPromise = undefined;
}

async function ensureManagedSessionRestoreEmptyConfig(platform: NodeJS.Platform): Promise<string | undefined> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			if (!managedSessionRestoreEmptyConfigPromise) {
				managedSessionRestoreEmptyConfigPromise = writeSecureTempFile({
					content: MANAGED_SESSION_RESTORE_EMPTY_CONFIG_CONTENT,
					prefix: MANAGED_SESSION_RESTORE_EMPTY_CONFIG_NAME.replace(/\.json$/, ""),
					suffix: ".json",
				}).then((path) => {
					if (platform !== "win32") chmodSync(path, 0o400);
					managedSessionRestoreEmptyConfigPath = path;
					return path;
				});
			}
			const path = await managedSessionRestoreEmptyConfigPromise;
			let entry = lstatSync(path);
			if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Managed restore config is not a regular file.");
			if (platform !== "win32" && (entry.mode & 0o777) !== 0o400) {
				chmodSync(path, 0o400);
				entry = lstatSync(path);
			}
			if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Managed restore config is not a regular file.");
			if (platform !== "win32" && (entry.mode & 0o777) !== 0o400) throw new Error("Managed restore config permissions are unsafe.");
			if (readFileSync(path, "utf8") !== MANAGED_SESSION_RESTORE_EMPTY_CONFIG_CONTENT) throw new Error("Managed restore config content changed.");
			return path;
		} catch {
			cleanupManagedSessionRestoreConfig();
		}
	}
	return undefined;
}

/** Pin an enabled restore subprocess to an empty protected config, bypassing later project/global config creation. */
export async function getManagedSessionRestoreConfigEnv(restoreEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
	if (restoreEnv[AGENT_BROWSER_RESTORE_ENV] === undefined) return {};
	const path = await ensureManagedSessionRestoreEmptyConfig(process.platform);
	if (path) return { [AGENT_BROWSER_CONFIG_ENV]: path };
	return { [AGENT_BROWSER_CONFIG_ENV]: join(tmpdir(), `.pi-agent-browser-managed-restore-config-unavailable-${randomUUID()}.json`) };
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

function getOwnedSnapshotManifestDirectory(directory: string, cwd: string): string {
	return join(directory, `${OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX}-${createManagedSessionRestoreKey(cwd)}`);
}

function ensureOwnedSnapshotManifestDirectory(path: string, platform: NodeJS.Platform): boolean {
	if (platform !== "win32") return ensureOwnerOnlyDirectory(path) && !directoryContainsSymlink(path);
	try {
		mkdirSync(path, { recursive: true });
		const entry = lstatSync(path);
		return !entry.isSymbolicLink() && entry.isDirectory() && !directoryContainsSymlink(path);
	} catch {
		return false;
	}
}

function getOwnedSnapshotRecordPath(directory: string, snapshotPath: string): string {
	const digest = createHash("sha256").update(snapshotPath).digest("hex");
	return join(directory, `${digest}.json`);
}

function writeOwnedSnapshotRecord(directory: string, snapshotPath: string, platform: NodeJS.Platform): boolean {
	const content = JSON.stringify(snapshotPath);
	if (Buffer.byteLength(content) > OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES) return false;
	const path = getOwnedSnapshotRecordPath(directory, snapshotPath);
	try {
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() || !entry.isFile()) return false;
		if (entry.size <= OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES && JSON.parse(readFileSync(path, "utf8")) === snapshotPath) {
			if (platform !== "win32") chmodSync(path, 0o600);
			return true;
		}
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) return false;
		try { unlinkSync(path); } catch {}
	}
	const temporaryPath = join(directory, `.tmp-${process.pid}-${randomUUID()}`);
	try {
		writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, path);
		return true;
	} catch {
		try {
			const entry = lstatSync(path);
			return !entry.isSymbolicLink()
				&& entry.isFile()
				&& entry.size <= OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES
				&& JSON.parse(readFileSync(path, "utf8")) === snapshotPath;
		} catch {
			return false;
		}
	} finally {
		try { unlinkSync(temporaryPath); } catch {}
	}
}

function readOwnedSnapshotRecord(options: {
	cwd: string;
	home: string;
	namespace?: string;
	path: string;
	platform: NodeJS.Platform;
}): string | undefined {
	try {
		let entry = lstatSync(options.path);
		if (entry.isSymbolicLink() || !entry.isFile() || entry.size > OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES) return undefined;
		if (options.platform !== "win32" && (entry.mode & 0o077) !== 0) {
			chmodSync(options.path, 0o600);
			entry = lstatSync(options.path);
			if (entry.isSymbolicLink() || !entry.isFile() || (entry.mode & 0o077) !== 0) return undefined;
		}
		const parsed = JSON.parse(readFileSync(options.path, "utf8")) as unknown;
		if (typeof parsed !== "string" || !isAbsolute(parsed)) return undefined;
		const snapshotPath = validateOwnedSnapshotPath({ cwd: options.cwd, home: options.home, namespace: options.namespace, path: parsed });
		return snapshotPath && getOwnedSnapshotRecordPath(dirname(options.path), snapshotPath) === options.path
			? snapshotPath
			: undefined;
	} catch {
		return undefined;
	}
}

function getProcessStartIdentitySync(pid: number): string | undefined {
	const command = buildProcessStartIdentityCommand(pid);
	if (!command) return undefined;
	try {
		return normalizeProcessStartIdentity(execFileSync(command.file, command.args, { encoding: "utf8", timeout: 1_000 }));
	} catch {
		return undefined;
	}
}

function getCurrentProcessStartIdentity(): string | undefined {
	currentProcessStartIdentity ??= getProcessStartIdentitySync(process.pid);
	return currentProcessStartIdentity;
}

function isSnapshotManifestLockOwnerAlive(content: string): boolean | undefined {
	try {
		const owner = JSON.parse(content) as { pid?: unknown; startIdentity?: unknown };
		if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.startIdentity !== "string" || !owner.startIdentity) return undefined;
		const pid = owner.pid as number;
		try {
			process.kill(pid, 0);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ESRCH") return false;
			if (code !== "EPERM") return undefined;
		}
		const startIdentity = getProcessStartIdentitySync(pid);
		return startIdentity === undefined ? undefined : processStartIdentitiesMatch(owner.startIdentity, startIdentity);
	} catch {
		return undefined;
	}
}

function acquireOwnedSnapshotManifestLock(path: string): number | undefined {
	const startIdentity = getCurrentProcessStartIdentity();
	if (!startIdentity) return undefined;
	const deadline = Date.now() + OWNED_RESTORE_SNAPSHOT_MANIFEST_LOCK_WAIT_MS;
	let observedLiveOwner: string | undefined;
	while (true) {
		try {
			const lock = openSync(path, "wx", 0o600);
			try {
				writeFileSync(lock, JSON.stringify({ pid: process.pid, startIdentity }));
				return lock;
			} catch {
				closeSync(lock);
				try { unlinkSync(path); } catch {}
				return undefined;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
		}
		try {
			const entry = lstatSync(path);
			if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
			const ownerContent = readFileSync(path, "utf8");
			const ownerAlive = ownerContent === observedLiveOwner ? true : isSnapshotManifestLockOwnerAlive(ownerContent);
			observedLiveOwner = ownerAlive === true ? ownerContent : undefined;
			if (ownerAlive === false || (ownerAlive === undefined && Date.now() - entry.mtimeMs > OWNED_RESTORE_SNAPSHOT_MANIFEST_LOCK_STALE_MS)) {
				unlinkSync(path);
				continue;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return undefined;
		}
		if (Date.now() >= deadline) return undefined;
		Atomics.wait(ownedRestoreSnapshotManifestLockWaitArray, 0, 0, OWNED_RESTORE_SNAPSHOT_MANIFEST_LOCK_RETRY_MS);
	}
}

/** After an owned close, expire only close-proven snapshots while retaining two fallbacks. */
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
	const manifestDirectory = getOwnedSnapshotManifestDirectory(directory, options.cwd);
	if (!options.statePath && !configPathExistsOrIsUnreadable(manifestDirectory)) return 0;
	if (!ensureManagedSessionRestoreStorageIsSecure(parentEnv, platform, options.namespace)) return 0;
	if (!ensureOwnedSnapshotManifestDirectory(manifestDirectory, platform)) return 0;
	if (options.statePath) {
		const ownedPath = validateOwnedSnapshotPath({ cwd: options.cwd, home, namespace: options.namespace, path: options.statePath });
		if (ownedPath && !writeOwnedSnapshotRecord(manifestDirectory, ownedPath, platform)) return 0;
	}
	const lockPath = join(manifestDirectory, ".lock");
	const lock = acquireOwnedSnapshotManifestLock(lockPath);
	if (lock === undefined) return 0;
	try {
		const snapshots: Array<{ mtimeMs: number; path: string; recordPath: string }> = [];
		for (const entry of readdirSync(manifestDirectory, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.startsWith(".tmp-")) {
				const temporaryPath = join(manifestDirectory, entry.name);
				try {
					if (Date.now() - lstatSync(temporaryPath).mtimeMs > OWNED_RESTORE_SNAPSHOT_MANIFEST_LOCK_STALE_MS) unlinkSync(temporaryPath);
				} catch {}
				continue;
			}
			if (!entry.isFile() || !/^[a-f\d]{64}\.json$/.test(entry.name)) continue;
			const recordPath = join(manifestDirectory, entry.name);
			const path = readOwnedSnapshotRecord({ cwd: options.cwd, home, namespace: options.namespace, path: recordPath, platform });
			if (!path) {
				try { unlinkSync(recordPath); } catch {}
				continue;
			}
			try {
				snapshots.push({ mtimeMs: lstatSync(path).mtimeMs, path, recordPath });
			} catch {
				try { unlinkSync(recordPath); } catch {}
			}
		}
		const staleBefore = Date.now() - OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS;
		let removed = 0;
		for (const [index, snapshot] of snapshots
			.sort((left, right) => right.mtimeMs - left.mtimeMs)
			.entries()) {
			if (index < OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP) continue;
			if (index < OWNED_RESTORE_SNAPSHOT_MAX_RECORDS && snapshot.mtimeMs >= staleBefore) continue;
			try {
				const current = lstatSync(snapshot.path);
				if (current.isSymbolicLink() || !current.isFile() || current.mtimeMs !== snapshot.mtimeMs) continue;
				if (index < OWNED_RESTORE_SNAPSHOT_MAX_RECORDS && current.mtimeMs >= staleBefore) continue;
				unlinkSync(snapshot.path);
				unlinkSync(snapshot.recordPath);
				removed += 1;
			} catch {
				// Best effort after the daemon has closed; a later owned close retries cleanup.
			}
		}
		return removed;
	} finally {
		try { closeSync(lock); } finally {
			try { unlinkSync(lockPath); } catch {}
		}
	}
}
