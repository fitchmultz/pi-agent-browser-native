/** Test-only native I/O provenance; never substitutes filesystem results or errors. */
import { Stats } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

const operations = ["mkdir", "lstat", "readdir", "readFile", "writeFile", "rename", "rm"] as const;
const RECENT_LIMIT = 32;
const FAILURE_LIMIT = 8;
const CONTENT_LIMIT = 1_024;
type Operation = (typeof operations)[number];
interface ContentSummary {
	readonly content: string;
	readonly bytes: number;
}
interface TraceEntry {
	readonly sequence: number;
	readonly op: Operation;
	readonly paths: readonly string[];
	readonly outcome: "ok" | "error";
	readonly code?: string;
	readonly syscall?: string;
	readonly content?: string;
	readonly bytes?: number;
	readonly input?: ContentSummary;
	readonly stat?: {
		readonly isDirectory: boolean;
		readonly isFile: boolean;
		readonly isSymbolicLink: boolean;
		readonly size: number;
		readonly mode: number;
		readonly uid: number;
	};
	readonly names?: readonly string[];
	readonly entries?: number;
}

function pathText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (Buffer.isBuffer(value)) {
		return value.toString();
	}
	return value instanceof URL ? value.href : undefined;
}
function isPolicyPath(path: string): boolean {
	// Include the coordination directory itself, not only dot-prefixed claim children.
	return /(?:^|[/\\])\.?pi-agent-browser-policy(?:-|[/\\]|$)/.test(path);
}
function tracePaths(op: Operation, args: readonly unknown[]): string[] {
	const paths = (op === "rename" ? args.slice(0, 2) : args.slice(0, 1))
		.map(pathText)
		.filter((path) => path !== undefined);
	return paths.some(isPolicyPath) ? paths.map((path) => path.slice(0, 512)) : [];
}
function errorField(error: unknown, field: "code" | "syscall"): string | undefined {
	if (typeof error !== "object" || error === null || !(field in error)) {
		return undefined;
	}
	const value: unknown = Reflect.get(error, field);
	return typeof value === "string" ? value.slice(0, 128) : undefined;
}
function isOwnerOrTicket(paths: readonly string[]): boolean {
	return paths.some((path) => /[/\\](?:(?:owner|ticket)\.json|\.ticket-[^/\\]+\.tmp)$/.test(path));
}
function contentSummary(value: unknown): ContentSummary | undefined {
	if (typeof value === "string") {
		return {
			bytes: Buffer.byteLength(value),
			content: Buffer.from(value.slice(0, CONTENT_LIMIT))
				.subarray(0, CONTENT_LIMIT)
				.toString("utf8"),
		};
	}
	return Buffer.isBuffer(value)
		? { bytes: value.length, content: value.subarray(0, CONTENT_LIMIT).toString("utf8") }
		: undefined;
}
function resultDetails(
	op: Operation,
	paths: readonly string[],
	result: unknown,
): Partial<TraceEntry> {
	if (op === "readFile" && isOwnerOrTicket(paths)) {
		return contentSummary(result) ?? {};
	}
	if (op === "lstat" && result instanceof Stats) {
		return {
			stat: {
				isDirectory: result.isDirectory(),
				isFile: result.isFile(),
				isSymbolicLink: result.isSymbolicLink(),
				size: result.size,
				mode: result.mode,
				uid: result.uid,
			},
		};
	}
	if (op === "readdir" && Array.isArray(result)) {
		return {
			entries: result.length,
			names: result
				.filter(
					(name): name is string =>
						typeof name === "string" && name.startsWith(".pi-agent-browser-policy-"),
				)
				.slice(0, 8)
				.map((name) => name.slice(0, 128)),
		};
	}
	return {};
}
interface TraceSnapshot {
	readonly operations: number;
	readonly errors: number;
	readonly omittedOperations: number;
	readonly omittedFailures: number;
	readonly recent: readonly TraceEntry[];
	readonly failures: readonly TraceEntry[];
}
interface PolicyFilesystemTrace {
	readonly restore: () => void;
	readonly snapshot: () => TraceSnapshot;
	readonly failureMessage: (result: { readonly isError?: unknown }) => string | undefined;
}
function appendBounded(
	entries: readonly TraceEntry[],
	entry: TraceEntry,
	limit: number,
): TraceEntry[] {
	return [...entries, entry].slice(-limit);
}

export function tracePolicyFilesystem(t: TestContext): PolicyFilesystemTrace {
	let recent: TraceEntry[] = [];
	let failures: TraceEntry[] = [];
	const restorers: (() => void)[] = [];
	let sequence = 0;
	let errors = 0;
	let restored = false;
	const restore = () => {
		if (restored) {
			return;
		}
		restored = true;
		for (const restoreMethod of restorers.toReversed()) {
			restoreMethod();
		}
		syncBuiltinESMExports();
	};
	// Hooks also run on assertion failure, after the test's native finally cleanup.
	t.after(restore);
	for (const op of operations) {
		const native = fs[op];
		const mocked = t.mock.method(fs, op, async (...args: readonly unknown[]) => {
			const paths = tracePaths(op, args);
			const number = paths.length > 0 ? ++sequence : 0;
			const input =
				op === "writeFile" && isOwnerOrTicket(paths) ? contentSummary(args[1]) : undefined;
			try {
				const result: unknown = await Reflect.apply(native, fs, args);
				if (number > 0) {
					recent = appendBounded(
						recent,
						{
							sequence: number,
							op,
							paths,
							input,
							outcome: "ok",
							...resultDetails(op, paths, result),
						},
						RECENT_LIMIT,
					);
				}
				return result;
			} catch (error) {
				if (number > 0) {
					errors++;
					const entry: TraceEntry = {
						sequence: number,
						op,
						paths,
						input,
						outcome: "error",
						code: errorField(error, "code"),
						syscall: errorField(error, "syscall"),
					};
					recent = appendBounded(recent, entry, RECENT_LIMIT);
					failures = appendBounded(failures, entry, FAILURE_LIMIT);
				}
				throw error;
			} finally {
				// Node's mock call history must not become a second, unbounded I/O log.
				mocked.mock.resetCalls();
			}
		});
		restorers.push(() => mocked.mock.restore());
	}
	syncBuiltinESMExports();
	const snapshot = (): TraceSnapshot => ({
		operations: sequence,
		errors,
		omittedOperations: Math.max(0, sequence - recent.length),
		omittedFailures: Math.max(0, errors - failures.length),
		recent: [...recent],
		failures: [...failures],
	});
	return {
		restore,
		snapshot,
		failureMessage: (result: { readonly isError?: unknown }): string | undefined =>
			result.isError === false
				? undefined
				: `${JSON.stringify(result)}\nNative policy filesystem trace: ${JSON.stringify(snapshot())}`,
	};
}
