import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import { isCloseAllCommand, isCloseCommand } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";

export interface SuccessfulBatchCloseLifecycle {
	endsClosed: boolean;
	recordingClosedAfterBatch: boolean;
	statePath?: string;
}

function getRowBrowserLaunched(row: Record<string, unknown>): boolean | undefined {
	const result = isRecord(row.result) ? row.result : isRecord(row.data) ? row.data : undefined;
	const lifecycle = isRecord(row.lifecycle) ? row.lifecycle : isRecord(result?.lifecycle) ? result.lifecycle : undefined;
	const effectiveLaunch = isRecord(lifecycle?.effectiveLaunch) ? lifecycle.effectiveLaunch : undefined;
	return typeof effectiveLaunch?.browserLaunched === "boolean" ? effectiveLaunch.browserLaunched : undefined;
}

export function batchHasSuccessfulCloseAll(data: unknown, fallbackCommands: string[][] = []): boolean {
	if (!Array.isArray(data)) return false;
	return data.some((row, index) => {
		if (!isRecord(row) || row.success !== true) return false;
		const rowCommand = Array.isArray(row.command) && row.command.every((token) => typeof token === "string")
			? row.command
			: fallbackCommands[index];
		return rowCommand ? isCloseAllCommand(extractUpstreamCommandTokens(rowCommand)) : false;
	});
}

export function getSuccessfulBatchCloseLifecycle(
	rows: unknown,
	fallbackCommands: string[][] = [],
): SuccessfulBatchCloseLifecycle | undefined {
	if (!Array.isArray(rows)) return undefined;
	let sawClose = false;
	let endsClosed = false;
	let browserActiveAfterClose = false;
	let recordingClosedAfterBatch = false;
	let statePath: string | undefined;
	for (const [index, row] of rows.entries()) {
		if (!isRecord(row)) continue;
		const stepSucceeded = row.success === true;
		const rowCommand = Array.isArray(row.command) && row.command.every((token) => typeof token === "string")
			? row.command
			: fallbackCommands[index];
		const browserLaunched = getRowBrowserLaunched(row);
		if (!rowCommand) {
			if (sawClose && browserLaunched !== false) {
				endsClosed = false;
				browserActiveAfterClose = true;
				recordingClosedAfterBatch = false;
			}
			continue;
		}
		const [command, subcommand] = extractUpstreamCommandTokens(rowCommand);
		if (stepSucceeded && isCloseCommand(command)) {
			sawClose = true;
			endsClosed = true;
			browserActiveAfterClose = false;
			recordingClosedAfterBatch = true;
			const result = isRecord(row.result) ? row.result : isRecord(row.data) ? row.data : undefined;
			statePath = typeof result?.statePath === "string" ? result.statePath : undefined;
		} else if (sawClose && command === "record") {
			if (browserLaunched !== false) {
				endsClosed = false;
				browserActiveAfterClose = true;
			}
			if (stepSucceeded && subcommand === "stop") recordingClosedAfterBatch = true;
			else if (stepSucceeded && browserActiveAfterClose && (subcommand === "start" || subcommand === "restart")) recordingClosedAfterBatch = false;
		} else if (sawClose && browserLaunched !== false) {
			endsClosed = false;
			browserActiveAfterClose = true;
		}
	}
	return sawClose ? { endsClosed, recordingClosedAfterBatch, statePath } : undefined;
}
