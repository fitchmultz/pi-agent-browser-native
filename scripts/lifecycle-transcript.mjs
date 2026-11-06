/** Pi transcript observations and bounded polling for the configured-source lifecycle harness. */
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SENTINEL_CUSTOM_TYPE = "piab-lifecycle-sentinel";

/** @typedef {{readonly [key: string]: unknown, readonly details?: Readonly<Record<string, unknown>> | undefined}} LifecycleToolResult */
/** @typedef {{readonly entries: readonly unknown[], readonly result: LifecycleToolResult, readonly results: readonly LifecycleToolResult[], readonly sessionFile: string}} LifecycleResultReport */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
export function record(value) {
	return isRecord(value) ? value : undefined;
}

/** @param {string} text @returns {unknown[]} */
export function parseJsonl(text) {
	/** @type {unknown[]} */
	const entries = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			entries.push(JSON.parse(line));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid JSONL at line ${index + 1}: ${message}`, { cause: error });
		}
	}
	return entries;
}

/** @param {readonly unknown[]} entries @returns {LifecycleToolResult[]} */
export function agentBrowserResults(entries) {
	return entries.flatMap((entry) => {
		const row = record(entry);
		const message = record(row?.message);
		if (
			row?.type !== "message" ||
			message?.role !== "toolResult" ||
			typeof message.toolName !== "string" ||
			!["agent_browser", "agent_browser_code", "agent_browser_qa"].includes(message.toolName)
		) {
			return [];
		}
		// Keep every matching completed receipt, even malformed details, so polling never skips a failure.
		return [{ ...message, details: record(message.details) }];
	});
}

/** @param {readonly unknown[]} entries @returns {string[]} */
export function sentinelTokens(entries) {
	return entries.flatMap((entry) => {
		const row = record(entry);
		const token = record(row?.data)?.token;
		return row?.type === "custom" &&
			row.customType === SENTINEL_CUSTOM_TYPE &&
			typeof token === "string"
			? [token]
			: [];
	});
}

/** @param {readonly unknown[]} entries @returns {string | undefined} */
export function sessionHeaderId(entries) {
	const header = entries.map(record).find((entry) => entry?.type === "session");
	return typeof header?.id === "string" ? header.id : undefined;
}

/** @param {readonly unknown[]} results @returns {string[]} */
export function collectFullOutputPaths(results) {
	const paths = [];
	for (const result of results) {
		const details = record(record(result)?.details);
		if (typeof details?.fullOutputPath === "string") {
			paths.push(details.fullOutputPath);
		}
		if (Array.isArray(details?.fullOutputPaths)) {
			/** @type {readonly unknown[]} */
			const outputPaths = details.fullOutputPaths;
			paths.push(...outputPaths.filter((path) => typeof path === "string"));
		}
	}
	return [...new Set(paths)];
}

/** @param {unknown} url */
function normalizeComparableUrl(url) {
	if (typeof url !== "string" || url.trim().length === 0) {
		return;
	}
	try {
		const parsed = new URL(url.trim());
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return url.trim();
	}
}

/** @param {Readonly<Record<string, unknown>> | undefined} details @param {string} command */
function pageResultUrl(details, command) {
	const data = record(details?.data);
	if (command === "open") {
		return data?.url;
	}
	return command === "snapshot" ? data?.origin : undefined;
}

/** @param {unknown} result @param {string} command @param {string} expectedUrl @returns {boolean} */
export function matchesSuccessfulPageResult(result, command, expectedUrl) {
	const row = record(result);
	const details = record(row?.details);
	const observedUrl = pageResultUrl(details, command);
	return (
		row?.isError === false &&
		details?.resultCategory === "success" &&
		details.command === command &&
		typeof observedUrl === "string" &&
		normalizeComparableUrl(observedUrl) === normalizeComparableUrl(expectedUrl)
	);
}

/** @param {number} ms @returns {Promise<void>} */
export function sleep(ms) {
	return new Promise((resolveSleep) => {
		setTimeout(resolveSleep, ms);
	});
}

/** @param {string} sessionDir */
export async function newestSessionFile(sessionDir) {
	const { stdout } = await execFile("find", [sessionDir, "-type", "f", "-name", "*.jsonl"]);
	const files = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.sort();
	let newest;
	let newestMtime = -1;
	for (const file of files) {
		// Inspect one transcript at a time, preserving last-in-sorted-order ties across native stat variants.
		const { stdout: timestamp } = await execFile("stat", ["-f", "%m", file]).catch(async () =>
			execFile("stat", ["-c", "%Y", file]),
		);
		const mtime = Number(timestamp.trim());
		if (mtime >= newestMtime) {
			newest = file;
			newestMtime = mtime;
		}
	}
	return newest;
}

/** @template T @param {{describe: string, predicate: () => Promise<T | undefined>, timeoutMs: number, intervalMs?: number, onPoll?: () => Promise<void>}} options @returns {Promise<T>} */
export async function waitFor({ describe, predicate, timeoutMs, intervalMs = 1000, onPoll }) {
	const start = Date.now();
	let lastError;
	while (Date.now() - start <= timeoutMs) {
		try {
			// Each poll must finish before deciding success, retrying, or observing a newer transcript.
			const result = await predicate();
			if (result !== undefined && Boolean(result)) {
				return result;
			}
		} catch (error) {
			lastError = error;
		}
		if (onPoll) {
			// Finish this poll's observation before the next poll can capture another state.
			await onPoll();
		}
		// Poll backoff follows the completed attempt, not concurrent timers.
		await sleep(intervalMs);
	}
	const hasLastError = Boolean(lastError);
	const suffix = hasLastError
		? ` Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
		: "";
	throw new Error(`Timed out waiting for ${describe} after ${timeoutMs}ms.${suffix}`);
}

/** @param {string} sessionFile @returns {Promise<unknown[]>} */
export async function readEntries(sessionFile) {
	return parseJsonl(await readFile(sessionFile, "utf8"));
}

/** @param {unknown} result @returns {string} */
export function resultText(result) {
	const content = record(result)?.content;
	return Array.isArray(content)
		? content
				.map(record)
				.flatMap((item) =>
					item?.type === "text" && typeof item.text === "string" ? [item.text] : [],
				)
				.join("\n")
		: "";
}

/** @param {{describe: string, sessionFile?: string, sessionDir?: string, timeoutMs: number, sinceCount: number, predicate: (result: LifecycleToolResult) => boolean}} options @returns {Promise<LifecycleResultReport>} */
export async function waitForAgentBrowserResult({
	describe,
	sessionFile,
	sessionDir,
	timeoutMs,
	sinceCount,
	predicate,
}) {
	let activeSessionFile = sessionFile;
	const report = await waitFor({
		describe,
		timeoutMs,
		predicate: async () => {
			if (
				(activeSessionFile === undefined || activeSessionFile === "") &&
				sessionDir !== undefined &&
				sessionDir !== ""
			) {
				activeSessionFile = await newestSessionFile(sessionDir);
			}
			if (activeSessionFile === undefined || activeSessionFile === "") {
				return;
			}
			const entries = await readEntries(activeSessionFile);
			const results = agentBrowserResults(entries);
			const result = results[sinceCount];
			return result ? { entries, result, results, sessionFile: activeSessionFile } : undefined;
		},
	});
	const { result } = report;
	if (!predicate(result)) {
		throw new Error(unexpectedResultMessage(describe, result));
	}
	return report;
}

/** @param {unknown} value @param {string} absent */
function diagnosticLabel(value, absent) {
	const text = String(value);
	return value === null || value === undefined ? absent : text;
}

/** @param {string} describe @param {LifecycleToolResult} result */
function unexpectedResultMessage(describe, result) {
	return `Unexpected agent_browser result for ${describe}: call ${diagnosticLabel(result.toolCallId, "unknown")}; command ${diagnosticLabel(result.details?.command, "missing")}; isError ${String(result.isError)}; category ${diagnosticLabel(result.details?.resultCategory, "missing")}/${diagnosticLabel(result.details?.failureCategory ?? result.details?.successCategory, "missing")}.`;
}

/** @param {{sessionFile: string, timeoutMs: number, token: string}} options */
export async function waitForSentinel({ sessionFile, timeoutMs, token }) {
	return waitFor({
		describe: `sentinel token ${token}`,
		timeoutMs,
		predicate: async () => {
			const entries = await readEntries(sessionFile);
			return sentinelTokens(entries).includes(token) ? entries : undefined;
		},
	});
}

/** @param {{describe: string, sessionFile: string, sinceEntryCount: number, timeoutMs: number}} options */
export async function waitForAssistantFinal({ describe, sessionFile, sinceEntryCount, timeoutMs }) {
	return waitFor({
		describe: `${describe} final assistant response`,
		timeoutMs,
		predicate: async () => {
			const entries = await readEntries(sessionFile);
			const finalMessage = entries.slice(sinceEntryCount).find((entry) => {
				const row = record(entry);
				const message = record(row?.message);
				return (
					row?.type === "message" &&
					message?.role === "assistant" &&
					Array.isArray(message.content) &&
					message.content.some(
						(item) => record(item)?.type === "text" && typeof record(item)?.text === "string",
					)
				);
			});
			return finalMessage !== undefined ? entries : undefined;
		},
	});
}
