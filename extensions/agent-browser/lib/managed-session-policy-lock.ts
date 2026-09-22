import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { canonicalizeAgentBrowserNamespace, foldAgentBrowserFilesystemIdentity } from "./argv-grammar.js";
import { getAgentBrowserSocketDirValidationError, resolveAgentBrowserSocketDir } from "./process.js";
import { processStartIdentitiesMatch, readProcessStartIdentity } from "./process-identity.js";

const POLICY_LOCK_WAIT_MS = 1_000;
const POLICY_LOCK_RETRY_MS = 10;
const POLICY_LOCK_MAX_BYTES = 1_048_576; // One claim may cover an entire owned-browser cleanup set.
const LOCK_OWNER_FILE = "owner.json";
const LOCK_TICKET_FILE = "ticket.json";

interface PolicyLockOwner {
	// null claims the whole native namespace; other sessions may otherwise run concurrently.
	sessionNames: string[] | null;
	pid: number;
	startIdentity: string;
	token: string;
	version: 4;
}

interface PolicyLockTicket {
	ticket: number;
	token: string;
	version: 4;
}

interface PolicyLockClaim {
	owner: PolicyLockOwner;
	path: string;
	ticket: number | null;
}

export interface ManagedSessionPolicyLock {
	release: () => Promise<void>;
}

function getCoordinationDirectory(platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") {
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		return platform === "android"
			? join(tmpdir(), `pi-agent-browser-policy${uid === undefined ? "" : `-${uid}`}`)
			: `/tmp/pi-agent-browser-policy${uid === undefined ? "" : `-${uid}`}`;
	}
	const user = process.env.USERNAME ?? process.env.USER ?? "unknown";
	const suffix = createHash("sha256").update(user).digest("hex").slice(0, 12);
	return join(tmpdir(), `pi-agent-browser-policy-${suffix}`);
}

async function ensureCoordinationDirectory(path: string, platform: NodeJS.Platform): Promise<boolean> {
	try {
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
		const entry = await lstat(path);
		if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
		if (platform !== "win32") {
			const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (uid === undefined || entry.uid !== uid || (entry.mode & 0o077) !== 0) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Resolved after native routing. Omit sessionName only for a namespace-wide operation. */
export interface BrowserExecutionIdentity {
	readonly socketContext: string;
	readonly sessionName?: string;
}

export async function resolveBrowserExecutionIdentity(options: {
	env?: NodeJS.ProcessEnv;
	namespace?: string;
	ownedManagedSession?: boolean;
	sessionName?: string;
}): Promise<BrowserExecutionIdentity> {
	const socketDir = resolveAgentBrowserSocketDir(options);
	const namespace = canonicalizeAgentBrowserNamespace(options.namespace);
	let socketContext: string;
	if (process.platform === "win32") {
		// Native Windows can reach the same namespace/session TCP daemon from
		// different storage roots. Do not split those callers into separate locks.
		socketContext = `win32-native:${namespace ?? ""}`;
	} else {
		if (socketDir === undefined) throw new Error("Browser execution coordination requires the native socket directory.");
		const error = await getAgentBrowserSocketDirValidationError(socketDir);
		if (error) throw new Error(`Browser execution coordination cannot use socket storage: ${error}.`);
		const root = await realpath(socketDir);
		socketContext = namespace ? join(root, "namespaces", namespace, "run") : root;
	}
	return {
		socketContext: foldAgentBrowserFilesystemIdentity(socketContext, process.platform),
		...(options.sessionName !== undefined ? { sessionName: foldAgentBrowserFilesystemIdentity(options.sessionName, process.platform) } : {}),
	};
}

export function getBrowserExecutionLockPath(identity: Pick<BrowserExecutionIdentity, "socketContext">): string {
	const digest = createHash("sha256").update(identity.socketContext).digest("hex");
	return join(getCoordinationDirectory(), `.pi-agent-browser-policy-${digest}.lock-v4`);
}

interface ExecutionClaimIdentity {
	socketContext: string;
	sessionNames: string[] | null;
}

function groupExecutionIdentities(identities: readonly BrowserExecutionIdentity[]): ExecutionClaimIdentity[] {
	if (identities.length === 0) throw new Error("Browser execution coordination requires at least one identity.");
	const groups = new Map<string, Set<string> | null>();
	for (const { socketContext, sessionName } of identities) {
		if (sessionName === undefined) groups.set(socketContext, null);
		else if (groups.get(socketContext) !== null) {
			const sessions = groups.get(socketContext) ?? new Set<string>();
			sessions.add(sessionName);
			groups.set(socketContext, sessions);
		}
	}
	return [...groups.keys()].sort().map(socketContext => {
		const sessions = groups.get(socketContext);
		return { socketContext, sessionNames: sessions ? [...sessions].sort() : null };
	});
}

interface ExecutionScope {
	identities: ExecutionClaimIdentity[];
	active: boolean;
	signal: AbortSignal;
	children: Promise<void>;
}
const executionScope = new AsyncLocalStorage<ExecutionScope>();

function scopeCovers(outer: ExecutionClaimIdentity[], inner: ExecutionClaimIdentity[]): boolean {
	return inner.every(identity => outer.some(held => held.socketContext === identity.socketContext
		&& (held.sessionNames === null || identity.sessionNames !== null && identity.sessionNames.every(session => held.sessionNames!.includes(session)))));
}

/**
 * Hold across every helper and action (or a complete code cell), not each CLI call.
 * Nested siblings are serialized; recursive inner calls and managed policy checks borrow
 * the claims. Declare every old/new identity up front for replacement or multi-browser cleanup;
 * omit sessionName for close --all. Upgrading mid-operation would allow a lock-order cycle.
 * Sessions sharing a socket context use ONE set-valued claim: acquiring them separately
 * could deadlock against a namespace-wide claimant between the first and second session.
 * Cancellation never releases a still-running callback. The callback must pass its signal
 * to subprocesses and await their termination; finally drains started children before release.
 */
export async function withBrowserExecutionLocks<T>(options: {
	identities: readonly BrowserExecutionIdentity[];
	signal?: AbortSignal;
	/** Absolute epoch-ms deadline for waiting AND execution. */
	deadline: number;
}, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	if (!Number.isFinite(options.deadline)) throw new Error("Browser execution coordination requires a finite deadline.");
	const identities = groupExecutionIdentities(options.identities);
	const parent = executionScope.getStore();
	if (parent && !parent.active) throw new Error("Browser execution scope has already finished.");
	if (parent && !scopeCovers(parent.identities, identities)) throw new Error("Cannot change or upgrade browser identity inside an execution lock; acquire every required identity before starting.");
	const controller = new AbortController();
	const signals = [controller.signal, options.signal, parent?.signal].filter((signal): signal is AbortSignal => signal !== undefined);
	const signal = AbortSignal.any(signals);
	const expire = () => controller.abort(new DOMException("Browser execution deadline exceeded.", "TimeoutError"));
	const remaining = options.deadline - Date.now();
	const timer = setTimeout(expire, Math.max(0, Math.min(remaining, 2_147_483_647)));
	const checkBudget = () => {
		if (Date.now() >= options.deadline) expire();
		signal.throwIfAborted();
	};
	const locks: ManagedSessionPolicyLock[] = [];
	try {
		checkBudget();
		if (!parent) {
			for (const identity of identities) {
				const lock = await acquireExecutionClaim({ identity, deadline: options.deadline, signal });
				if (lock) locks.push(lock);
				checkBudget();
				if (!lock) throw new Error("Browser execution coordination is unavailable or busy; no browser command was run.");
			}
		}
		const execute = async () => {
			checkBudget();
			const scope: ExecutionScope = { identities: parent?.identities ?? identities, active: true, signal, children: Promise.resolve() };
			try { return await executionScope.run(scope, () => run(signal)); }
			finally { scope.active = false; await scope.children; }
		};
		if (!parent) return await execute();
		const result = parent.children.then(execute);
		parent.children = result.then(() => undefined, () => undefined);
		return await result;
	} finally {
		clearTimeout(timer);
		await Promise.all(locks.reverse().map(lock => lock.release()));
	}
}

export function withBrowserExecutionLock<T>(options: {
	identity: BrowserExecutionIdentity;
	signal?: AbortSignal;
	deadline: number;
}, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	return withBrowserExecutionLocks({ identities: [options.identity], signal: options.signal, deadline: options.deadline }, run);
}

function parseOwner(content: string): PolicyLockOwner | undefined {
	if (Buffer.byteLength(content) > POLICY_LOCK_MAX_BYTES) return undefined;
	try {
		const parsed = JSON.parse(content) as Partial<PolicyLockOwner>;
		return parsed.version === 4
			&& (parsed.sessionNames === null || Array.isArray(parsed.sessionNames) && parsed.sessionNames.length > 0 && parsed.sessionNames.every(session => typeof session === "string"))
			&& Number.isSafeInteger(parsed.pid) && (parsed.pid ?? 0) > 0
			&& typeof parsed.startIdentity === "string" && parsed.startIdentity.length > 0
			&& typeof parsed.token === "string" && parsed.token.length > 0
			? parsed as PolicyLockOwner
			: undefined;
	} catch {
		return undefined;
	}
}

function parseTicket(content: string, token: string): number | undefined {
	if (Buffer.byteLength(content) > POLICY_LOCK_MAX_BYTES) return undefined;
	try {
		const parsed = JSON.parse(content) as Partial<PolicyLockTicket>;
		return parsed.version === 4
			&& parsed.token === token
			&& Number.isSafeInteger(parsed.ticket)
			&& (parsed.ticket ?? 0) > 0
			? parsed.ticket
			: undefined;
	} catch {
		return undefined;
	}
}

async function readClaim(path: string): Promise<PolicyLockClaim | undefined> {
	try {
		const directory = await lstat(path);
		const ownerPath = join(path, LOCK_OWNER_FILE);
		const ownerEntry = await lstat(ownerPath);
		if (!directory.isDirectory() || directory.isSymbolicLink() || !ownerEntry.isFile() || ownerEntry.isSymbolicLink()) return undefined;
		if (ownerEntry.size > POLICY_LOCK_MAX_BYTES) return undefined;
		if (process.platform !== "win32") {
			const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (uid === undefined || directory.uid !== uid || ownerEntry.uid !== uid || (directory.mode & 0o077) !== 0 || (ownerEntry.mode & 0o177) !== 0) return undefined;
		}
		const owner = parseOwner(await readFile(ownerPath, "utf8"));
		if (!owner) return undefined;
		const ticketPath = join(path, LOCK_TICKET_FILE);
		try {
			const ticketEntry = await lstat(ticketPath);
			if (!ticketEntry.isFile() || ticketEntry.isSymbolicLink() || ticketEntry.size > POLICY_LOCK_MAX_BYTES) return undefined;
			if (process.platform !== "win32") {
				const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
				if (uid === undefined || ticketEntry.uid !== uid || (ticketEntry.mode & 0o177) !== 0) return undefined;
			}
			const ticket = parseTicket(await readFile(ticketPath, "utf8"), owner.token);
			return ticket === undefined ? undefined : { owner, path, ticket };
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? { owner, path, ticket: null } : undefined;
		}
	} catch {
		return undefined;
	}
}

async function readClaims(basePath: string): Promise<PolicyLockClaim[] | undefined> {
	const directory = dirname(basePath);
	const prefix = `${basename(basePath)}.claim-`;
	let names: string[];
	try { names = await readdir(directory); } catch { return undefined; }
	const claims: PolicyLockClaim[] = [];
	for (const name of names.filter((candidate) => candidate.startsWith(prefix))) {
		const path = join(directory, name);
		const claim = await readClaim(path);
		if (!claim) {
			try { await lstat(path); } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			}
			return undefined;
		}
		if (name !== `${prefix}${claim.owner.token}`) return undefined;
		claims.push(claim);
	}
	return claims;
}

async function ownerAlive(owner: PolicyLockOwner, budget?: { signal?: AbortSignal; deadline?: number }): Promise<boolean | undefined> {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code !== "EPERM") return undefined;
	}
	const current = await readProcessStartIdentity(owner.pid, process.platform, budget);
	return current === undefined ? undefined : processStartIdentitiesMatch(owner.startIdentity, current);
}

async function removeClaimOwnedBy(path: string, token: string, deadline = 0): Promise<boolean> {
	const movedPath = join(dirname(path), `.pi-agent-browser-policy-remove-${token}-${randomUUID()}`);
	while (true) {
		const current = await readClaim(path);
		if (current?.owner.token !== token) return false;
		try {
			await rename(path, movedPath);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return true;
			// Windows may refuse a directory move while a contender reads its
			// metadata. Revalidate before retrying. Owned-claim cleanup gets
			// its own bounded window, independent of the acquisition wait.
			if (process.platform !== "win32" || code !== "EPERM" || Date.now() >= deadline) return false;
			await waitForRetry();
			if (Date.now() >= deadline) return false;
		}
	}
	const moved = await readClaim(movedPath);
	if (moved?.owner.token !== token) {
		try { await rename(movedPath, path); } catch {}
		return false;
	}
	await rm(movedPath, { force: true, recursive: true });
	return true;
}

async function cleanDeadPolicyArtifacts(directory: string, budget: { signal?: AbortSignal; deadline?: number }): Promise<void> {
	let names: string[];
	try { names = await readdir(directory); } catch { return; }
	for (const name of names.filter((candidate) =>
		candidate.startsWith(".pi-agent-browser-policy-remove-")
		|| candidate.includes(".lock-v4.candidate-"))) {
		if (budget.signal?.aborted || Date.now() >= (budget.deadline ?? Infinity)) return;
		const path = join(directory, name);
		const claim = await readClaim(path);
		if (claim && await ownerAlive(claim.owner, budget) === false) await rm(path, { force: true, recursive: true }).catch(() => undefined);
	}
}

function claimPrecedes(left: PolicyLockClaim, right: PolicyLockClaim): boolean {
	if (left.ticket === null) return true;
	if (right.ticket === null) return false;
	return left.ticket < right.ticket || (left.ticket === right.ticket && left.owner.token < right.owner.token);
}

async function hasPublishedLaterTicket(claim: PolicyLockClaim, ownClaim: PolicyLockClaim): Promise<boolean> {
	if (claim.ticket !== null) return false;
	const current = await readClaim(claim.path);
	return current?.owner.token === claim.owner.token && !claimPrecedes(current, ownClaim);
}

function waitForRetry(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, POLICY_LOCK_RETRY_MS);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

export async function acquireManagedSessionPolicyLock(options: {
	namespace?: string;
	sessionName: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<ManagedSessionPolicyLock | undefined> {
	if (options.signal?.aborted) return undefined;
	let identity: BrowserExecutionIdentity;
	try { identity = await resolveBrowserExecutionIdentity({ ...options, ownedManagedSession: true }); }
	catch { return undefined; }
	const scope = executionScope.getStore();
	if (scope) {
		if (!scope.active || scope.signal.aborted || !scopeCovers(scope.identities, groupExecutionIdentities([identity]))) return undefined;
		return { release: async () => undefined };
	}
	return acquireExecutionClaim({ identity: groupExecutionIdentities([identity])[0]!, signal: options.signal, timeoutMs: options.timeoutMs });
}

async function acquireExecutionClaim(options: {
	identity: ExecutionClaimIdentity;
	signal?: AbortSignal;
	timeoutMs?: number;
	deadline?: number;
}): Promise<ManagedSessionPolicyLock | undefined> {
	if (options.signal?.aborted) return undefined;
	const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? POLICY_LOCK_WAIT_MS);
	// timeoutMs: 0 retains the existing single-attempt policy probe contract.
	const budget = { signal: options.signal, deadline: options.timeoutMs === 0 ? undefined : deadline };
	const platform = process.platform;
	const directory = getCoordinationDirectory(platform);
	if (!await ensureCoordinationDirectory(directory, platform)) return undefined;
	const basePath = getBrowserExecutionLockPath(options.identity);
	const token = randomUUID();
	const startIdentity = await readProcessStartIdentity(process.pid, process.platform, budget);
	if (!startIdentity) return undefined;
	const owner = { pid: process.pid, startIdentity, token, sessionNames: options.identity.sessionNames, version: 4 } satisfies PolicyLockOwner;
	const ownerContent = JSON.stringify(owner);
	// Never publish metadata our reader cannot validate and ownership-safely remove.
	if (Buffer.byteLength(ownerContent) > POLICY_LOCK_MAX_BYTES) return undefined;
	const candidatePath = `${basePath}.candidate-${token}`;
	const claimPath = `${basePath}.claim-${token}`;
	let claimPublished = false;
	let lockAcquired = false;
	try {
		await mkdir(candidatePath, { mode: 0o700 });
		await writeFile(join(candidatePath, LOCK_OWNER_FILE), ownerContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(candidatePath, claimPath);
		claimPublished = true;

		const initialClaims = await readClaims(basePath);
		if (!initialClaims) return undefined;
		const maxTicket = initialClaims.reduce((max, claim) => claim.ticket === null ? max : Math.max(max, claim.ticket), 0);
		if (!Number.isSafeInteger(maxTicket + 1)) return undefined;
		const ticket = { ticket: maxTicket + 1, token, version: 4 } satisfies PolicyLockTicket;
		const ticketCandidatePath = join(claimPath, `.ticket-${token}.tmp`);
		await writeFile(ticketCandidatePath, JSON.stringify(ticket), { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(ticketCandidatePath, join(claimPath, LOCK_TICKET_FILE));

		while (!options.signal?.aborted) {
			const claims = await readClaims(basePath);
			if (!claims) return undefined;
			const ownClaim = claims.find((claim) => claim.owner.token === token);
			if (!ownClaim || ownClaim.ticket !== ticket.ticket) return undefined;
			let blocked = false;
			for (const claim of claims) {
				const disjoint = owner.sessionNames !== null && claim.owner.sessionNames !== null
					&& !owner.sessionNames.some(session => claim.owner.sessionNames!.includes(session));
				if (claim.owner.token === token || disjoint || !claimPrecedes(claim, ownClaim)) continue;
				// Choosing is transient: a later published ticket must not make
				// its predecessor wait on it using an earlier null snapshot.
				if (await hasPublishedLaterTicket(claim, ownClaim)) continue;
				const alive = await ownerAlive(claim.owner, budget);
				if (alive === false) {
					await removeClaimOwnedBy(claim.path, claim.owner.token);
					continue;
				}
				// A native identity query can outlive the owner's entire critical
				// section. Its result (including unknown after exit) does not make
				// an already released immutable claim a current blocker.
				try { await lstat(claim.path); } catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				}
				// Publication can also complete during the native identity query.
				if (await hasPublishedLaterTicket(claim, ownClaim)) continue;
				blocked = true;
				break;
			}
			if (!blocked) {
				await cleanDeadPolicyArtifacts(directory, budget);
				if (options.signal?.aborted || (budget.deadline !== undefined && Date.now() >= budget.deadline)) return undefined;
				lockAcquired = true;
				return { release: async () => { await removeClaimOwnedBy(claimPath, token, Date.now() + POLICY_LOCK_WAIT_MS); } };
			}
			if (Date.now() >= deadline) return undefined;
			await waitForRetry(options.signal);
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		await rm(candidatePath, { force: true, recursive: true }).catch(() => undefined);
		if (claimPublished && !lockAcquired) await removeClaimOwnedBy(claimPath, token, Date.now() + POLICY_LOCK_WAIT_MS);
	}
}
