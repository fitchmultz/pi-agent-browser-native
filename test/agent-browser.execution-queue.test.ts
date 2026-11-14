import assert from "node:assert/strict";
import nodeTest from "node:test";
import { getAgentBrowserSessionIdentityKey } from "../extensions/agent-browser/lib/argv-grammar.js";
import { KeyedAsyncExecutionQueue } from "../extensions/agent-browser/lib/orchestration/execution-queue.js";

nodeTest(
	"queued browser cancellation withdraws waiting work without releasing the active owner",
	async () => {
		const queue = new KeyedAsyncExecutionQueue();
		const { promise: started, resolve: entered } = Promise.withResolvers<null>();
		const { promise: held, resolve: release } = Promise.withResolvers<null>();
		const first = queue.run("team\u0000same", "team", async () => {
			entered(null);
			await held;
		});
		await started;
		const controller = new AbortController();
		const cancelled = queue.run(
			"team\u0000same",
			"team",
			async () => assert.fail("cancelled action dispatched"),
			controller.signal,
		);
		controller.abort();
		await assert.rejects(cancelled, { name: "AbortError" });
		let laterStarted = false;
		const later = queue.run("team\u0000same", "team", async () => {
			laterStarted = true;
		});
		await Promise.resolve();
		assert.equal(laterStarted, false);
		release(null);
		await Promise.all([first, later]);
		assert.equal(laterStarted, true);
	},
);

nodeTest(
	"reentrant keyed browser work respects cancellation without abandoning the active owner",
	async () => {
		const queue = new KeyedAsyncExecutionQueue();
		const key = getAgentBrowserSessionIdentityKey("shared", "team");
		const controller = new AbortController();
		const reason = new Error("inner operation cancelled");
		await queue.run(key, "team", async () => {
			controller.abort(reason);
			await assert.rejects(
				() =>
					queue.run(
						key,
						"team",
						async () => assert.fail("cancelled reentrant action dispatched"),
						controller.signal,
					),
				(error: unknown) => error === reason,
			);
			assert.equal(await queue.run(key, "team", async () => "still active"), "still active");
		});
		assert.equal(await queue.run(key, "team", async () => "released"), "released");
	},
);

nodeTest(
	"KeyedAsyncExecutionQueue drains same-namespace work without deadlocking late arrivals",
	async () => {
		const queue = new KeyedAsyncExecutionQueue();
		const key = getAgentBrowserSessionIdentityKey("shared", "team");
		const events: string[] = [];
		const { promise: active, resolve: markActive } = Promise.withResolvers<null>();
		const { promise: holdActive, resolve: releaseActive } = Promise.withResolvers<null>();
		const first = queue.run(key, "team", async () => {
			events.push("first-start");
			markActive(null);
			await holdActive;
			events.push("first-end");
		});
		await active;
		const exclusive = queue.runExclusive("team", async () => {
			events.push("exclusive");
		});
		const late = queue.run(key, "team", async () => {
			events.push("late");
		});
		releaseActive(null);
		let timeout: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				Promise.all([first, exclusive, late]),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error("namespace-exclusive queue deadlocked")),
						1_000,
					);
				}),
			]);
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
		}
		assert.deepEqual(events, ["first-start", "first-end", "exclusive", "late"]);
	},
);
