import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Controls performance.now(), the monotonic clock behind browser execution deadlines.
 * MockTimers mocks Date and timers but not performance.now(), so tests that freeze or advance
 * coordination deadlines must drive this clock explicitly.
 */
export function mockMonotonicClock(
	t: TestContext,
	start = performance.now(),
): { now: () => number; tick: (ms: number) => void; restore: () => void } {
	let now = start;
	const mocked = t.mock.method(performance, "now", () => now);
	return {
		now: (): number => now,
		tick: (ms: number): void => {
			now += ms;
		},
		restore: (): void => {
			mocked.mock.restore();
		},
	};
}

/** Steps Date.now() like a system wall-clock change while it keeps advancing in real time. */
export function wallClockStepper(t: TestContext): (offsetMs: number) => void {
	const realNow = Date.now.bind(Date);
	let offset = 0;
	t.mock.method(Date, "now", () => realNow() + offset);
	return (offsetMs) => {
		offset = offsetMs;
	};
}

/** Settles a pending promise, or reports it still pending after ms of real time. */
export async function settleWithin<T>(
	pending: Promise<T>,
	ms: number,
): Promise<{ value: T } | "pending"> {
	const settled = new AbortController();
	try {
		return await Promise.race([
			pending.then((value) => ({ value })),
			delay(ms, "pending" as const, { signal: settled.signal }),
		]);
	} finally {
		settled.abort();
	}
}
