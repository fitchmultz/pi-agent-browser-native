import { isRecord } from "../../parsing.js";
import type { AgentBrowserLifecycle } from "../contracts.js";

// `lifecycle` is upstream launch/reuse bookkeeping, never page content, so it must not be the
// answer an agent reads when a command has no dedicated presenter.
function getNestedLifecycleRow(row: unknown): unknown {
	return isRecord(row) ? (row.result ?? row.data ?? row) : row;
}

export function extractAgentBrowserLifecycle(result: unknown): AgentBrowserLifecycle | undefined {
	if (Array.isArray(result)) {
		let latest: AgentBrowserLifecycle | undefined;
		for (const row of result) {
			const nested = getNestedLifecycleRow(row);
			latest = extractAgentBrowserLifecycle(nested) ?? latest;
		}
		return latest;
	}
	if (!isRecord(result)) {
		return undefined;
	}
	if (isRecord(result.lifecycle) && isRecord(result.lifecycle.effectiveLaunch)) {
		const browserLaunched = result.lifecycle.effectiveLaunch.browserLaunched;
		if (typeof browserLaunched === "boolean") {
			return { effectiveLaunch: { browserLaunched } };
		}
	}
	return extractAgentBrowserLifecycle(result.result ?? result.data);
}

export function omitUpstreamLifecycle(
	data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	if (Array.isArray(data)) {
		return data;
	}
	const { lifecycle: _lifecycle, ...rest } = data;
	return rest;
}
