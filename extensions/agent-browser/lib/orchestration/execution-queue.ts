import { AsyncLocalStorage } from "node:async_hooks";
import {
	getAgentBrowserSessionIdentityKey,
	isAgentBrowserSessionIdentityKeyInNamespace,
} from "../argv-grammar.js";

// Serializes managed-session read/modify/write work so overlapping tool calls cannot promote stale state or close an in-use session.
export class AsyncExecutionQueue {
	private tail: Promise<void> = Promise.resolve();
	private readonly active = new AsyncLocalStorage<{ active: boolean }>();

	isCurrent(): boolean {
		return this.active.getStore()?.active === true;
	}

	run<T>(work: () => Promise<T>, signal?: AbortSignal, barrier = Promise.resolve()): Promise<T> {
		if (this.isCurrent()) {
			signal?.throwIfAborted();
			return work();
		}
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});

		let rejectWaiting!: (reason: unknown) => void;
		const cancelled = new Promise<never>((_resolve, reject) => {
			rejectWaiting = reject;
		});
		const abortWaiting = () => {
			rejectWaiting(signal?.reason);
		};
		signal?.addEventListener("abort", abortWaiting, { once: true });
		if (signal?.aborted === true) {
			abortWaiting();
		}
		const execution = (async () => {
			await Promise.all([previous, barrier]);
			signal?.removeEventListener("abort", abortWaiting);
			try {
				signal?.throwIfAborted();
				const scope = { active: true };
				try {
					return await this.active.run(scope, work);
				} finally {
					scope.active = false;
				}
			} finally {
				release();
			}
		})();
		return signal ? Promise.race([execution, cancelled]) : execution;
	}
}

export class KeyedAsyncExecutionQueue {
	private readonly barriers = new Map<string, Promise<void>>();
	private readonly entries = new Map<string, { queue: AsyncExecutionQueue; users: number }>();

	async run<T>(
		key: string,
		namespace: string | undefined,
		work: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const entry = this.entries.get(key) ?? { queue: new AsyncExecutionQueue(), users: 0 };
		if (entry.queue.isCurrent()) {
			return entry.queue.run(work, signal);
		}
		const barrier =
			this.barriers.get(getAgentBrowserSessionIdentityKey("", namespace)) ?? Promise.resolve();
		entry.users += 1;
		this.entries.set(key, entry);
		try {
			return await entry.queue.run(work, signal, barrier);
		} finally {
			entry.users -= 1;
			if (entry.users === 0 && this.entries.get(key) === entry) {
				this.entries.delete(key);
			}
		}
	}

	async runExclusive<T>(namespace: string | undefined, work: () => Promise<T>): Promise<T> {
		const namespaceKey = getAgentBrowserSessionIdentityKey("", namespace);
		const previous = this.barriers.get(namespaceKey) ?? Promise.resolve();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const barrier = previous.then(() => blocked);
		this.barriers.set(namespaceKey, barrier);
		const drains = [...this.entries]
			.filter(([key]) => isAgentBrowserSessionIdentityKeyInNamespace(key, namespace))
			.map(([, { queue }]) =>
				queue.run(async () => {
					// This queued marker only waits for earlier work; it has no browser operation.
				}),
			);
		await previous;
		await Promise.all(drains);
		try {
			return await work();
		} finally {
			release();
			if (this.barriers.get(namespaceKey) === barrier) {
				this.barriers.delete(namespaceKey);
			}
		}
	}
}
