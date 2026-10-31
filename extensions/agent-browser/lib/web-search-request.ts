import type { WebSearchProvider } from "./config.js";
import { getProviderLabel } from "./web-search-results.js";

export const SEARCH_REQUEST_TIMEOUT_MS = 15_000;
export const WEB_SEARCH_MIN_REQUEST_INTERVAL_MS = 1_100;

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}
	if (signal?.aborted === true) {
		const reason: unknown = signal.reason;
		// A caller-owned abort reason may be non-Error; preserve the original reason.
		// oxlint-disable-next-line typescript/prefer-promise-reject-errors
		return Promise.reject(reason ?? new Error("Web search cancelled"));
	}
	return new Promise((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			cleanup();
			const reason: unknown = signal?.reason;
			// A caller-owned abort reason may be non-Error; preserve the original reason.
			// oxlint-disable-next-line typescript/prefer-promise-reject-errors
			reject(reason ?? new Error("Web search cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export class WebSearchRequestGate {
	// A performance.now() timestamp (0 before the first request), so a system clock step neither
	// skips nor extends the spacing between requests.
	private lastRequestStartedAt = 0;
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
		const runTask = async () => {
			const elapsedMs =
				this.lastRequestStartedAt === 0
					? WEB_SEARCH_MIN_REQUEST_INTERVAL_MS
					: performance.now() - this.lastRequestStartedAt;
			const waitMs = Math.max(0, WEB_SEARCH_MIN_REQUEST_INTERVAL_MS - elapsedMs);
			if (waitMs > 0) {
				await sleepWithAbort(waitMs, signal);
			}
			if (signal?.aborted === true) {
				signal.throwIfAborted();
			}
			this.lastRequestStartedAt = performance.now();
			return task();
		};
		const result = this.tail.then(runTask, runTask);
		this.tail = result.catch(() => {
			/* Failed requests release the queue; callers retain the original rejection. */
		});
		return result;
	}
}

function formatSearchHttpError(options: {
	readonly provider: WebSearchProvider;
	readonly status: number;
}): string {
	const { provider, status } = options;
	const providerLabel = getProviderLabel(provider);
	if (status === 429) {
		return `${providerLabel} search rate limit exceeded (HTTP 429). Do not issue parallel or repeated agent_browser_web_search calls; use one high-signal query, inspect those results, then wait before retrying or ask the user to adjust their ${providerLabel} API plan/limits.`;
	}
	if (status === 401 || status === 403) {
		return `${providerLabel} search failed with HTTP ${status}: Check your API credential and permissions.`;
	}
	if (status >= 500) {
		return `${providerLabel} search failed with HTTP ${status}: Provider unavailable; retry later.`;
	}
	return `${providerLabel} search failed with HTTP ${status}: Request rejected; check the search parameters.`;
}

export async function fetchSearchJson(options: {
	readonly cancelMessage: string;
	readonly init?: RequestInit;
	readonly invalidJsonMessage: string;
	readonly provider: WebSearchProvider;
	readonly request: string | URL;
	readonly signal?: AbortSignal;
	readonly timeoutMessage: string;
	readonly timeoutMs: number;
}): Promise<unknown> {
	if (options.signal?.aborted === true) {
		options.signal.throwIfAborted();
	}
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error(options.timeoutMessage)),
		options.timeoutMs,
	);
	const abort = () => controller.abort(options.signal?.reason ?? new Error(options.cancelMessage));
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetch(options.request, { ...options.init, signal: controller.signal });
		if (!response.ok) {
			await response.body?.cancel().catch(() => {
				// Disposal errors must not replace the source-free HTTP diagnostic.
			});
			throw new Error(
				formatSearchHttpError({
					provider: options.provider,
					status: response.status,
				}),
			);
		}
		const text = await response.text();
		try {
			return JSON.parse(text);
		} catch {
			// Parser messages and causes can include partial credentials from the response body.
			throw new Error(options.invalidJsonMessage);
		}
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}
