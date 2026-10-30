import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { getErrorCode } from "./process-errors.js";
import {
	debugPolicyFailure,
	policyDebugEnabled,
	withPolicyDebugAttempt,
	policyDebugPhase,
} from "./browser-execution-policy-debug.js";
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
	openClaimEndpoint,
	subscribeClaimEndpoint,
	type ClaimEndpoint,
	type ClaimSubscription,
} from "./browser-execution-claim-endpoint.js";
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
interface BlockingPredecessor {
	readonly claim: PolicyLockClaim;
	/** True only when this scan confirmed the owner's current native process identity. */
	readonly ownerConfirmed: boolean;
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
async function blockingPredecessor(
	claim: PolicyLockClaim,
	ownClaim: PolicyLockClaim,
	budget: ClaimBudget,
): Promise<BlockingPredecessor | undefined> {
	if (!relevantPredecessor(claim, ownClaim) || (await hasPublishedLaterTicket(claim, ownClaim))) {
		return undefined;
	}
	// A predecessor may have released since the scan; only confirmed absence skips its query.
	if (!(await claimStillExists(claim.path))) {
		return undefined;
	}
	const alive = await ownerAlive(claim.owner, budget);
	if (alive === false) {
		await removeClaimOwnedBy(claim.path, claim.owner.token);
		return undefined;
	}
	// Native identity queries can outlive the whole critical section. Re-read the immutable
	// claim so an already released owner, or a newly published later ticket, cannot block us.
	if (!(await claimStillExists(claim.path))) {
		return undefined;
	}
	return (await hasPublishedLaterTicket(claim, ownClaim))
		? undefined
		: { claim, ownerConfirmed: alive === true };
}
async function claimStillExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		const code = getErrorCode(error);
		if (code !== "ENOENT") {
			debugPolicyFailure("acquire.predecessor-stat", "presence-unresolved", error);
		}
		return code !== "ENOENT";
	}
}
async function firstBlockingPredecessor(
	claims: readonly PolicyLockClaim[],
	own: PolicyLockClaim,
	budget: ClaimBudget,
): Promise<BlockingPredecessor | undefined> {
	for (const claim of claims) {
		// Contender inspection/removal is ordered before the next ticket decision.
		// oxlint-disable-next-line no-await-in-loop
		const blocking = await blockingPredecessor(claim, own, budget);
		if (blocking) {
			return blocking;
		}
	}
	return undefined;
}
async function prepareClaim(
	identity: ExecutionClaimIdentity,
	budget: ClaimBudget,
): Promise<PreparedClaim | undefined> {
	const directory = getCoordinationDirectory(process.platform);
	if (!(await ensureCoordinationDirectory(directory, process.platform))) {
		debugPolicyFailure("acquire.prepare", "directory-unavailable");
		return undefined;
	}
	const basePath = getBrowserExecutionLockPath(identity);
	const token = randomUUID();
	const startIdentity = await readProcessStartIdentity(process.pid, process.platform, budget);
	if (startIdentity === undefined || startIdentity.length === 0) {
		debugPolicyFailure("acquire.prepare", "start-identity-unavailable");
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
		debugPolicyFailure("acquire.prepare", "owner-too-large");
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
function publicationRetryAvailable(budget: ClaimBudget): boolean {
	return (
		budget.deadline !== undefined &&
		budget.signal?.aborted !== true &&
		performance.now() < budget.deadline
	);
}
function candidateMatchesPreparedClaim(
	candidate: PolicyLockClaim | undefined,
	claim: PreparedClaim,
): boolean {
	if (!candidate || candidate.ticket !== null) {
		return false;
	}
	const { owner } = candidate;
	const expected = claim.owner;
	const sessions = owner.sessionNames;
	const expectedSessions = expected.sessionNames;
	const identityFields = ["token", "pid", "startIdentity", "version"] as const;
	return (
		identityFields.every((field) => owner[field] === expected[field]) &&
		(expectedSessions === null
			? sessions === null
			: sessions !== null &&
				sessions.length === expectedSessions.length &&
				sessions.every((session, index) => session === expectedSessions[index]))
	);
}
async function publishCandidate(claim: PreparedClaim, budget: ClaimBudget): Promise<boolean> {
	while (true) {
		try {
			// The initial native publication attempt retains its existing single-probe semantics.
			// oxlint-disable-next-line no-await-in-loop
			await rename(claim.candidatePath, claim.path);
			return true;
		} catch (error) {
			if (
				process.platform !== "win32" ||
				getErrorCode(error) !== "EPERM" ||
				!publicationRetryAvailable(budget)
			) {
				throw error;
			}
			// Retry only the observed Windows publication conflict, within the original budget.
			// oxlint-disable-next-line no-await-in-loop
			await waitForRetry(budget.signal);
			if (!publicationRetryAvailable(budget)) {
				throw error;
			}
			// Every retry must still own this unpublished candidate and its complete captured scope.
			// oxlint-disable-next-line no-await-in-loop
			const candidate = await readClaim(claim.candidatePath);
			if (!candidateMatchesPreparedClaim(candidate, claim)) {
				debugPolicyFailure("publish.verify", "candidate-unconfirmed", error);
				return false;
			}
			if (!publicationRetryAvailable(budget)) {
				throw error;
			}
		}
	}
}
async function publishClaim(claim: PreparedClaim, budget: ClaimBudget): Promise<boolean> {
	let stage = "publish.mkdir";
	try {
		await mkdir(claim.candidatePath, { mode: 0o700 });
		stage = "publish.owner-write";
		await writeFile(join(claim.candidatePath, LOCK_OWNER_FILE), claim.content, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		stage = "publish.rename";
		return await publishCandidate(claim, budget);
	} catch (error) {
		debugPolicyFailure(stage, "native-error", error);
		throw error;
	}
}
async function publishTicket(claim: PreparedClaim): Promise<number | undefined> {
	const claims = await readClaims(claim.basePath);
	if (!claims) {
		debugPolicyFailure("ticket.scan", "claims-unavailable");
		return undefined;
	}
	const maxTicket = claims.reduce(
		(max, entry) => (entry.ticket === null ? max : Math.max(max, entry.ticket)),
		0,
	);
	if (!Number.isSafeInteger(maxTicket + 1)) {
		debugPolicyFailure("ticket.number", "unsafe-ticket-number");
		return undefined;
	}
	const ticket: PolicyLockTicket = { ticket: maxTicket + 1, token: claim.owner.token, version: 4 };
	const candidate = join(claim.path, `.ticket-${claim.owner.token}.tmp`);
	let stage = "ticket.write";
	try {
		await writeFile(candidate, JSON.stringify(ticket), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		stage = "ticket.rename";
		await rename(candidate, join(claim.path, LOCK_TICKET_FILE));
	} catch (error) {
		debugPolicyFailure(stage, "native-error", error);
		throw error;
	}
	return ticket.ticket;
}
function acquisitionCancelled(budget: ClaimBudget): boolean {
	return budget.signal?.aborted === true;
}
interface PredecessorWait {
	readonly wait: (
		blocking: BlockingPredecessor,
		budget: ClaimBudget,
		deadline: number,
	) => Promise<void>;
	readonly close: () => void;
}
function createPredecessorWait(): PredecessorWait {
	let subscription: ClaimSubscription | undefined;
	const attempted = new Set<string>();
	const close = (): void => {
		subscription?.close();
		subscription = undefined;
	};
	return {
		close,
		wait: async (blocking, budget, deadline) => {
			const { token } = blocking.claim.owner;
			if (subscription?.token === token && subscription.connected()) {
				// Arbitration after subscribing still found this predecessor blocking.
				await subscription.wait(budget.signal, deadline);
				return;
			}
			close();
			// Unresolved liveness and choosing (null-ticket) predecessors keep timed polling: a
			// choosing claim may publish a later ticket and then wait for us. Subscribe once per owner.
			if (blocking.ownerConfirmed && blocking.claim.ticket !== null && !attempted.has(token)) {
				attempted.add(token);
				subscription = await subscribeClaimEndpoint(
					blocking.claim.path,
					token,
					budget.signal,
					deadline,
				);
				// Re-run arbitration at once: a release before the subscription connected is then
				// not missed, and a refused or missing endpoint usually means the owner just released.
				return;
			}
			await waitForRetry(budget.signal);
		},
	};
}
async function waitForTurn(
	claim: PreparedClaim,
	ticket: number,
	budget: ClaimBudget,
	deadline: number,
): Promise<boolean> {
	const predecessorWait = createPredecessorWait();
	try {
		while (budget.signal?.aborted !== true) {
			// Each wake observes a fresh published ticket set after the previous delay.
			// oxlint-disable-next-line no-await-in-loop
			const claims = await readClaims(claim.basePath);
			if (!claims) {
				debugPolicyFailure("acquire.wait-scan", "claims-unavailable");
				return false;
			}
			const own = claims.find((entry) => entry.owner.token === claim.owner.token);
			if (!own || own.ticket !== ticket) {
				debugPolicyFailure("acquire.own-claim", !own ? "missing" : "ticket-mismatch");
				return false;
			}
			// Liveness checks and stale-claim removal must finish before acquisition.
			// oxlint-disable-next-line no-await-in-loop
			const blocking = await firstBlockingPredecessor(claims, own, budget);
			if (!blocking) {
				// Winning ends the loop once GC and the final cancellation check complete.
				// oxlint-disable-next-line no-await-in-loop
				return await acquireTurn(claim, budget);
			}
			if (performance.now() >= deadline) {
				debugPolicyFailure("acquire.wait", "deadline");
				return false;
			}
			// Waiting respects ordering and cancellation; contenders cannot run concurrently here.
			// oxlint-disable-next-line no-await-in-loop
			await predecessorWait.wait(blocking, budget, deadline);
		}
		debugPolicyFailure("acquire.wait", "cancelled");
		return false;
	} finally {
		predecessorWait.close();
	}
}
async function acquireTurn(claim: PreparedClaim, budget: ClaimBudget): Promise<boolean> {
	// Opportunistic GC must finish before the final cancellation check.
	await cleanDeadPolicyArtifacts(claim.directory, budget);
	// GC stays within the wait budget but cannot revoke a turn this claim already won;
	// only cancellation can. Callers enforce their own operation deadlines.
	const cancelled = acquisitionCancelled(budget);
	if (cancelled) {
		debugPolicyFailure("acquire.turn", "cancelled");
	}
	return !cancelled;
}
function acquisitionDeadline(options: ClaimOptions): number {
	return options.deadline ?? performance.now() + (options.timeoutMs ?? POLICY_LOCK_WAIT_MS);
}
export function acquireExecutionClaim(
	options: ClaimOptions,
): Promise<ManagedSessionPolicyLock | undefined> {
	return policyDebugEnabled
		? withPolicyDebugAttempt(() => acquireClaim(options))
		: acquireClaim(options);
}
async function acquireClaim(options: ClaimOptions): Promise<ManagedSessionPolicyLock | undefined> {
	if (acquisitionCancelled(options)) {
		debugPolicyFailure("acquire.begin", "cancelled");
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
	let cleanupCandidate = true;
	let endpoint: ClaimEndpoint | undefined;
	try {
		if (!(await publishClaim(claim, budget))) {
			// An observed foreign/unknown candidate also withdraws our cleanup authority.
			cleanupCandidate = false;
			return undefined;
		}
		published = true;
		// Listen before the ticket becomes visible to waiters that may sleep on this claim.
		endpoint = openClaimEndpoint(claim.path, claim.owner.token);
		const ticket = await publishTicket(claim);
		if (ticket === undefined || !(await waitForTurn(claim, ticket, budget, deadline))) {
			return undefined;
		}
		acquired = true;
		return {
			release: policyDebugPhase("release", async () =>
				removeOwnClaim(claim, endpoint, "release.complete"),
			),
		};
	} catch (error) {
		debugPolicyFailure("acquire.complete", "native-error", error);
		return undefined;
	} finally {
		await cleanupUnpublishedCandidate(claim, cleanupCandidate);
		if (published && !acquired) {
			await removeOwnClaim(claim, endpoint, "cleanup.complete");
		}
	}
}
async function removeOwnClaim(
	claim: PreparedClaim,
	endpoint: ClaimEndpoint | undefined,
	stage: string,
): Promise<void> {
	try {
		const removed = await removeClaimOwnedBy(
			claim.path,
			claim.owner.token,
			performance.now() + POLICY_LOCK_WAIT_MS,
		);
		debugRemovalResult(removed, stage);
	} finally {
		// Wake subscribers after removal so their fresh arbitration no longer sees this claim.
		endpoint?.close();
	}
}
async function cleanupUnpublishedCandidate(
	claim: PreparedClaim,
	permitted: boolean,
): Promise<void> {
	if (permitted) {
		await rm(claim.candidatePath, { force: true, recursive: true }).catch((error: unknown) => {
			debugPolicyFailure("cleanup.candidate-rm", "native-error", error);
		});
	}
}
function debugRemovalResult(removed: boolean, stage: string): void {
	if (!removed) {
		debugPolicyFailure(stage, "claim-not-removed");
	}
}
