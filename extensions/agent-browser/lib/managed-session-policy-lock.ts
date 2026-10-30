import { AsyncLocalStorage } from "node:async_hooks";
import {
	acquireExecutionClaim,
	type ManagedSessionPolicyLock,
} from "./browser-execution-claims.js";
import {
	resolveBrowserExecutionIdentity,
	type BrowserExecutionIdentity,
	type ExecutionClaimIdentity,
} from "./browser-execution-identity.js";
export {
	resolveBrowserExecutionIdentity,
	getBrowserExecutionLockPath,
	type BrowserExecutionIdentity,
} from "./browser-execution-identity.js";
export type { ManagedSessionPolicyLock } from "./browser-execution-claims.js";

function groupExecutionIdentities(
	identities: readonly BrowserExecutionIdentity[],
): ExecutionClaimIdentity[] {
	if (identities.length === 0) {
		throw new Error("Browser execution coordination requires at least one identity.");
	}
	const groups = new Map<string, Set<string> | null>();
	for (const { socketContext, sessionName } of identities) {
		if (sessionName === undefined) {
			groups.set(socketContext, null);
		} else if (groups.get(socketContext) !== null) {
			const sessions = groups.get(socketContext) ?? new Set<string>();
			sessions.add(sessionName);
			groups.set(socketContext, sessions);
		}
	}
	return [...groups.keys()].sort().map((socketContext) => {
		const sessions = groups.get(socketContext);
		return { socketContext, sessionNames: sessions ? [...sessions].sort() : null };
	});
}
interface ExecutionScope {
	readonly identities: readonly ExecutionClaimIdentity[];
	active: boolean;
	readonly signal: AbortSignal;
	children: Promise<void>;
}
const executionScope = new AsyncLocalStorage<ExecutionScope>();
function identityCovers(held: ExecutionClaimIdentity, identity: ExecutionClaimIdentity): boolean {
	if (held.socketContext !== identity.socketContext) {
		return false;
	}
	const heldSessions = held.sessionNames;
	if (heldSessions === null) {
		return true;
	}
	const innerSessions = identity.sessionNames;
	return innerSessions !== null && innerSessions.every((session) => heldSessions.includes(session));
}
function scopeCovers(
	outer: readonly ExecutionClaimIdentity[],
	inner: readonly ExecutionClaimIdentity[],
): boolean {
	return inner.every((identity) => outer.some((held) => identityCovers(held, identity)));
}
async function acquireClaimsInOrder(
	identities: readonly ExecutionClaimIdentity[],
	budget: { readonly deadline: number; readonly signal: AbortSignal; readonly check: () => void },
	remember: (lock: ManagedSessionPolicyLock) => void,
): Promise<void> {
	for (const identity of identities) {
		// Acquiring sorted native socket contexts in order prevents lock-order cycles.
		// oxlint-disable-next-line no-await-in-loop
		const lock = await acquireExecutionClaim({
			identity,
			deadline: budget.deadline,
			signal: budget.signal,
		});
		if (lock) {
			remember(lock);
		}
		budget.check();
		if (!lock) {
			throw new Error(
				"Browser execution coordination is unavailable or busy; no browser command was run.",
			);
		}
	}
}
async function runInScope<T>(
	identities: readonly ExecutionClaimIdentity[],
	signal: AbortSignal,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const scope: ExecutionScope = { identities, active: true, signal, children: Promise.resolve() };
	try {
		return await executionScope.run(scope, () => run(signal));
	} finally {
		scope.active = false;
		await scope.children;
	}
}
/** Hold across helpers/actions or a complete code cell. Nested siblings serialize and recursive
 * calls borrow existing claims. Declare every replacement/cleanup identity up front: upgrades
 * mid-operation would permit lock-order cycles. One set-valued claim per socket context prevents
 * namespace-wide contenders from deadlocking between individual session acquisitions.
 * Cancellation does not release running callbacks: they must pass the signal to subprocesses
 * and await termination. Finally drains started children before releasing the native claims.
 * The deadline is a performance.now() timestamp so wall-clock steps cannot shorten or extend it. */
export async function withBrowserExecutionLocks<T>(
	options: {
		readonly identities: readonly BrowserExecutionIdentity[];
		readonly signal?: AbortSignal;
		readonly deadline: number;
		readonly waitOnly?: boolean;
	},
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	if (!Number.isFinite(options.deadline)) {
		throw new Error("Browser execution coordination requires a finite deadline.");
	}
	const identities = groupExecutionIdentities(options.identities);
	const parent = executionScope.getStore();
	if (parent && !parent.active) {
		throw new Error("Browser execution scope has already finished.");
	}
	if (parent && !scopeCovers(parent.identities, identities)) {
		throw new Error(
			"Cannot change or upgrade browser identity inside an execution lock; acquire every required identity before starting.",
		);
	}
	const controller = new AbortController();
	const signals = [controller.signal, options.signal, parent?.signal].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	const signal = AbortSignal.any(signals);
	const expire = () =>
		controller.abort(new DOMException("Browser execution deadline exceeded.", "TimeoutError"));
	const remaining = options.deadline - performance.now();
	const timer = setTimeout(expire, Math.max(0, Math.min(remaining, 2_147_483_647)));
	const checkBudget = () => {
		if (performance.now() >= options.deadline) {
			expire();
		}
		signal.throwIfAborted();
	};
	const locks: ManagedSessionPolicyLock[] = [];
	try {
		checkBudget();
		if (!parent) {
			await acquireClaimsInOrder(
				identities,
				{ deadline: options.deadline, signal, check: checkBudget },
				(lock) => {
					locks.push(lock);
				},
			);
		}
		const execute = async () => {
			checkBudget();
			if (options.waitOnly === true) {
				clearTimeout(timer);
			}
			return runInScope(parent?.identities ?? identities, signal, run);
		};
		if (!parent) {
			return await execute();
		}
		const result = parent.children.then(execute);
		// The caller owns this result; the parent drains both outcomes before releasing claims.
		parent.children = result.then(
			() => undefined,
			() => undefined,
		);
		return await result;
	} finally {
		clearTimeout(timer);
		await Promise.all(locks.reverse().map((lock) => lock.release()));
	}
}
export function withBrowserExecutionLock<T>(
	options: {
		readonly identity: BrowserExecutionIdentity;
		readonly signal?: AbortSignal;
		readonly deadline: number;
		readonly waitOnly?: boolean;
	},
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	return withBrowserExecutionLocks(
		{
			identities: [options.identity],
			signal: options.signal,
			deadline: options.deadline,
			waitOnly: options.waitOnly,
		},
		run,
	);
}
export async function acquireManagedSessionPolicyLock(options: {
	readonly namespace?: string;
	readonly sessionName: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}): Promise<ManagedSessionPolicyLock | undefined> {
	if (options.signal?.aborted === true) {
		return undefined;
	}
	let identity: BrowserExecutionIdentity;
	try {
		identity = await resolveBrowserExecutionIdentity({ ...options, ownedManagedSession: true });
	} catch {
		return undefined;
	}
	const scope = executionScope.getStore();
	if (scope) {
		if (!scope.active || !scopeCovers(scope.identities, groupExecutionIdentities([identity]))) {
			return undefined;
		}
		return {
			release: async () => {
				/* The outer execution owns release of this borrowed claim. */
			},
		};
	}
	const grouped = groupExecutionIdentities([identity]).at(0);
	if (grouped === undefined) {
		return undefined;
	}
	return acquireExecutionClaim({
		identity: grouped,
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}
