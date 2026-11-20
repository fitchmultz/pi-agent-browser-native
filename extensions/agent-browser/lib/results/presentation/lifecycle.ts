import { isRecord } from "../../parsing.js";
import type { AgentBrowserLifecycle } from "../contracts.js";

function compareCodeUnits(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	return left > right ? 1 : 0;
}

// `lifecycle` is upstream launch/reuse bookkeeping, never page content, so it must not be the
// answer an agent reads when a command has no dedicated presenter.
function canonicalizeLifecycleValue(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalizeLifecycleValue).join(",")}]`;
	}
	if (isRecord(value)) {
		const entries = Object.keys(value)
			.sort(compareCodeUnits)
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonicalizeLifecycleValue(value[key])}`);
		return `{${entries.join(",")}}`;
	}
	if (value === undefined) {
		return "undefined";
	}
	return JSON.stringify(value);
}

function selectSharedLifecycle(
	lifecycles: readonly Readonly<Record<string, unknown>>[],
): { readonly key: string; readonly value: Readonly<Record<string, unknown>> } | undefined {
	const counts = new Map<
		string,
		{ readonly value: Readonly<Record<string, unknown>>; count: number }
	>();
	for (const lifecycle of lifecycles) {
		const key = canonicalizeLifecycleValue(lifecycle);
		const existing = counts.get(key);
		if (existing) {
			existing.count += 1;
		} else {
			counts.set(key, { value: lifecycle, count: 1 });
		}
	}
	let winner:
		| { readonly key: string; readonly value: Readonly<Record<string, unknown>>; count: number }
		| undefined;
	for (const [key, entry] of counts) {
		if (!winner || entry.count > winner.count) {
			winner = { key, value: entry.value, count: entry.count };
		}
	}
	return winner && winner.count >= 2 ? { key: winner.key, value: winner.value } : undefined;
}

function stripMatchingLifecycle(value: unknown, sharedKey: string): unknown {
	if (!isRecord(value) || !isRecord(value.lifecycle)) {
		return value;
	}
	return canonicalizeLifecycleValue(value.lifecycle) === sharedKey
		? omitUpstreamLifecycle(value)
		: value;
}

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

export function hoistSharedBatchStepLifecycles<T extends { readonly data?: unknown }>(
	values: readonly T[],
	updateData: (item: T, data: unknown) => T,
): {
	readonly batchLifecycle?: Readonly<Record<string, unknown>> | undefined;
	readonly items: readonly T[];
} {
	const lifecycles: Readonly<Record<string, unknown>>[] = [];
	for (const item of values) {
		if (isRecord(item.data) && isRecord(item.data.lifecycle)) {
			lifecycles.push(item.data.lifecycle);
		}
	}
	const shared = selectSharedLifecycle(lifecycles);
	if (!shared) {
		return { items: values };
	}
	return {
		batchLifecycle: shared.value,
		items: values.map((item) => {
			const compacted = stripMatchingLifecycle(item.data, shared.key);
			return compacted === item.data ? item : updateData(item, compacted);
		}),
	};
}

export function compactBatchResultLifecycle(
	rows: readonly unknown[],
	existingBatchLifecycle?: unknown,
): {
	readonly batchLifecycle?: unknown;
	readonly data: readonly unknown[];
} {
	const lifecycles: Readonly<Record<string, unknown>>[] = [];
	for (const row of rows) {
		if (isRecord(row) && isRecord(row.result) && isRecord(row.result.lifecycle)) {
			lifecycles.push(row.result.lifecycle);
		}
	}
	const shared = isRecord(existingBatchLifecycle)
		? { key: canonicalizeLifecycleValue(existingBatchLifecycle), value: existingBatchLifecycle }
		: selectSharedLifecycle(lifecycles);
	if (!shared) {
		return { batchLifecycle: existingBatchLifecycle, data: rows };
	}
	return {
		batchLifecycle: shared.value,
		data: rows.map((row) => {
			if (!isRecord(row)) {
				return row;
			}
			const compacted = stripMatchingLifecycle(row.result, shared.key);
			return compacted === row.result ? row : { ...row, result: compacted };
		}),
	};
}
