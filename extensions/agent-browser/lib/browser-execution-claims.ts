import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { getErrorCode } from "./process-errors.js";
import { join } from "node:path";
import { readProcessStartIdentity } from "./process-identity.js";
import {
	POLICY_LOCK_MAX_BYTES,
	type PolicyLockOwner,
	type PolicyLockTicket,
	type PolicyLockClaim,
} from "./browser-execution-claim-codec.js";
import {
	ensureCoordinationDirectory,
	getCoordinationDirectory,
	getBrowserExecutionLockPath,
	type ExecutionClaimIdentity,
} from "./browser-execution-identity.js";
import {
	cleanDeadPolicyArtifacts,
	readClaim,
	readClaims,
	removeClaimOwnedBy,
	ownerAlive,
	waitForRetry,
	LOCK_OWNER_FILE,
	LOCK_TICKET_FILE,
	POLICY_LOCK_WAIT_MS,
	type ClaimBudget,
} from "./browser-execution-claim-storage.js";
export interface ManagedSessionPolicyLock {
	readonly release: () => Promise<void>;
}
interface ClaimOptions {
	readonly identity: ExecutionClaimIdentity;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly deadline?: number;
}
interface PreparedClaim {
	readonly owner: PolicyLockOwner;
	readonly content: string;
	readonly basePath: string;
	readonly directory: string;
	readonly candidatePath: string;
	readonly path: string;
}
function claimPrecedes(left: PolicyLockClaim, right: PolicyLockClaim): boolean {
	if (left.ticket === null) {
		return true;
	}
	if (right.ticket === null) {
		return false;
	}
	return (
		left.ticket < right.ticket ||
		(left.ticket === right.ticket && left.owner.token < right.owner.token)
	);
}
async function hasPublishedLaterTicket(
	claim: PolicyLockClaim,
	ownClaim: PolicyLockClaim,
): Promise<boolean> {
	if (claim.ticket !== null) {
		return false;
	}
	const current = await readClaim(claim.path);
	return current?.owner.token === claim.owner.token && !claimPrecedes(current, ownClaim);
}
function relevantPredecessor(claim: PolicyLockClaim, ownClaim: PolicyLockClaim): boolean {
	if (claim.owner.token === ownClaim.owner.token || !claimPrecedes(claim, ownClaim)) {
		return false;
	}
	const ownSessions = ownClaim.owner.sessionNames;
	const sessions = claim.owner.sessionNames;
	return (
		ownSessions === null ||
		sessions === null ||
		ownSessions.some((session) => sessions.includes(session))
	);
}
async function claimBlocks(
	claim: PolicyLockClaim,
	ownClaim: PolicyLockClaim,
	budget: ClaimBudget,
): Promise<boolean> {
	if (!relevantPredecessor(claim, ownClaim) || (await hasPublishedLaterTicket(claim, ownClaim))) {
		return false;
	}
	const alive = await ownerAlive(claim.owner, budget);
	if (alive === false) {
		await removeClaimOwnedBy(claim.path, claim.owner.token);
		return false;
	}
	// Native identity queries can outlive the whole critical section. Re-read the immutable
	// claim so an already released owner, or a newly published later ticket, cannot block us.
	if (!(await claimStillExists(claim.path))) {
		return false;
	}
	return !(await hasPublishedLaterTicket(claim, ownClaim));
}
async function claimStillExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		return getErrorCode(error) !== "ENOENT";
	}
}
async function anyPredecessorBlocks(
	claims: readonly PolicyLockClaim[],
	own: PolicyLockClaim,
	budget: ClaimBudget,
): Promise<boolean> {
	for (const claim of claims) {
		// Contender inspection/removal is ordered before the next ticket decision.
		// oxlint-disable-next-line no-await-in-loop
		if (await claimBlocks(claim, own, budget)) {
			return true;
		}
	}
	return false;
}
async function prepareClaim(
	identity: ExecutionClaimIdentity,
	budget: ClaimBudget,
): Promise<PreparedClaim | undefined> {
	const directory = getCoordinationDirectory(process.platform);
	if (!(await ensureCoordinationDirectory(directory, process.platform))) {
		return undefined;
	}
	const basePath = getBrowserExecutionLockPath(identity);
	const token = randomUUID();
	const startIdentity = await readProcessStartIdentity(process.pid, process.platform, budget);
	if (startIdentity === undefined || startIdentity.length === 0) {
		return undefined;
	}
	const owner: PolicyLockOwner = {
		pid: process.pid,
		startIdentity,
		token,
		sessionNames: identity.sessionNames,
		version: 4,
	};
	const content = JSON.stringify(owner);
	if (Buffer.byteLength(content) > POLICY_LOCK_MAX_BYTES) {
		return undefined;
	}
	return {
		owner,
		content,
		basePath,
		directory,
		candidatePath: `${basePath}.candidate-${token}`,
		path: `${basePath}.claim-${token}`,
	};
}
async function publishClaim(claim: PreparedClaim): Promise<void> {
	await mkdir(claim.candidatePath, { mode: 0o700 });
	await writeFile(join(claim.candidatePath, LOCK_OWNER_FILE), claim.content, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	await rename(claim.candidatePath, claim.path);
}
async function publishTicket(claim: PreparedClaim): Promise<number | undefined> {
	const claims = await readClaims(claim.basePath);
	if (!claims) {
		return undefined;
	}
	const maxTicket = claims.reduce(
		(max, entry) => (entry.ticket === null ? max : Math.max(max, entry.ticket)),
		0,
	);
	if (!Number.isSafeInteger(maxTicket + 1)) {
		return undefined;
	}
	const ticket: PolicyLockTicket = { ticket: maxTicket + 1, token: claim.owner.token, version: 4 };
	const candidate = join(claim.path, `.ticket-${claim.owner.token}.tmp`);
	await writeFile(candidate, JSON.stringify(ticket), { encoding: "utf8", flag: "wx", mode: 0o600 });
	await rename(candidate, join(claim.path, LOCK_TICKET_FILE));
	return ticket.ticket;
}
function acquisitionCancelled(budget: ClaimBudget): boolean {
	return budget.signal?.aborted === true;
}
async function waitForTurn(
	claim: PreparedClaim,
	ticket: number,
	budget: ClaimBudget,
	deadline: number,
): Promise<boolean> {
	while (budget.signal?.aborted !== true) {
		// Each poll observes a fresh published ticket set after the previous delay.
		// oxlint-disable-next-line no-await-in-loop
		const claims = await readClaims(claim.basePath);
		if (!claims) {
			return false;
		}
		const own = claims.find((entry) => entry.owner.token === claim.owner.token);
		if (!own || own.ticket !== ticket) {
			return false;
		}
		// Liveness checks and stale-claim removal must finish before acquisition.
		// oxlint-disable-next-line no-await-in-loop
		if (!(await anyPredecessorBlocks(claims, own, budget))) {
			// Opportunistic GC must finish before the final cancellation check.
			// oxlint-disable-next-line no-await-in-loop
			await cleanDeadPolicyArtifacts(claim.directory, budget);
			// GC stays within the wait budget but cannot revoke a turn this claim already won;
			// only cancellation can. Callers enforce their own operation deadlines.
			return !acquisitionCancelled(budget);
		}
		if (Date.now() >= deadline) {
			return false;
		}
		// Polling respects ordering and cancellation; contenders cannot run concurrently here.
		// oxlint-disable-next-line no-await-in-loop
		await waitForRetry(budget.signal);
	}
	return false;
}
function acquisitionDeadline(options: ClaimOptions): number {
	return options.deadline ?? Date.now() + (options.timeoutMs ?? POLICY_LOCK_WAIT_MS);
}
export async function acquireExecutionClaim(
	options: ClaimOptions,
): Promise<ManagedSessionPolicyLock | undefined> {
	if (options.signal?.aborted === true) {
		return undefined;
	}
	const deadline = acquisitionDeadline(options);
	// timeoutMs: 0 retains the existing single-attempt policy probe contract.
	const budget: ClaimBudget = {
		signal: options.signal,
		deadline: options.timeoutMs === 0 ? undefined : deadline,
	};
	const claim = await prepareClaim(options.identity, budget);
	if (!claim) {
		return undefined;
	}
	let published = false;
	let acquired = false;
	try {
		await publishClaim(claim);
		published = true;
		const ticket = await publishTicket(claim);
		if (ticket === undefined || !(await waitForTurn(claim, ticket, budget, deadline))) {
			return undefined;
		}
		acquired = true;
		return {
			release: async () => {
				await removeClaimOwnedBy(claim.path, claim.owner.token, Date.now() + POLICY_LOCK_WAIT_MS);
			},
		};
	} catch {
		return undefined;
	} finally {
		await rm(claim.candidatePath, { force: true, recursive: true }).catch(() => undefined);
		if (published && !acquired) {
			await removeClaimOwnedBy(claim.path, claim.owner.token, Date.now() + POLICY_LOCK_WAIT_MS);
		}
	}
}
