import { readInvocationLog } from "./agent-browser-harness.js";

// Full-suite runs spawn many fake upstream processes in parallel; keep this as a deadlock watchdog,
// not a scheduler-load race. The gated calls normally finish sub-second when run in isolation.
export const CONCURRENCY_TEST_TIMEOUT_MS = 15_000;

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function withConcurrencyTestTimeout<T>(
	promise: Promise<T>,
	message: string,
): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), CONCURRENCY_TEST_TIMEOUT_MS);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

export async function waitForInvocation(
	logPath: string,
	match: (entry: { readonly args: readonly string[]; readonly event?: string }) => boolean,
): Promise<void> {
	const deadline = Date.now() + CONCURRENCY_TEST_TIMEOUT_MS;
	while (Date.now() <= deadline) {
		// Observe real dispatch before proceeding with the dependent race.
		// oxlint-disable-next-line no-await-in-loop
		if ((await readInvocationLog(logPath)).some(match)) {
			return;
		}
		// Yield between receipt polls; the deadline also covers preflight failures.
		// oxlint-disable-next-line no-await-in-loop
		await delay(10);
	}
	throw new Error("The gated child did not dispatch before the watchdog deadline");
}

export function ownedSessionDetails(
	sessionName: string,
	sessionMode: "auto" | "fresh" = "auto",
): Readonly<Record<string, unknown>> {
	return {
		args: ["open", `https://example.com/${encodeURIComponent(sessionName)}`],
		command: "open",
		exitCode: 0,
		managedSessionOutcome: {
			activeAfter: true,
			activeBefore: false,
			attemptedSessionName: sessionName,
			currentSessionName: sessionName,
			previousSessionName: sessionName,
			sessionMode,
			status: "created",
			succeeded: true,
			summary: `Managed session ${sessionName} is now current.`,
		},
		resultCategory: "success",
		sessionMode,
		sessionName,
		usedImplicitSession: sessionMode === "auto",
	};
}
