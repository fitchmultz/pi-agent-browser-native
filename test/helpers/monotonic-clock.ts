import type { TestContext } from "node:test";

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
