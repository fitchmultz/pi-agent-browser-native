import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import { isCloseCommand } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";

export interface SuccessfulBatchCloseLifecycle {
	endsClosed: boolean;
	recordingClosedAfterBatch: boolean;
	statePath?: string;
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
		if (!isRecord(row) || row.success !== true) continue;
		const rowCommand = Array.isArray(row.command) && row.command.every((token) => typeof token === "string")
			? row.command
			: fallbackCommands[index];
		if (!rowCommand) {
			if (sawClose) {
				endsClosed = false;
				browserActiveAfterClose = true;
				recordingClosedAfterBatch = false;
			}
			continue;
		}
		const [command, subcommand] = extractUpstreamCommandTokens(rowCommand);
		if (isCloseCommand(command)) {
			sawClose = true;
			endsClosed = true;
			browserActiveAfterClose = false;
			recordingClosedAfterBatch = true;
			const result = isRecord(row.result) ? row.result : isRecord(row.data) ? row.data : undefined;
			statePath = typeof result?.statePath === "string" ? result.statePath : undefined;
		} else if (sawClose && command === "record") {
			if (subcommand === "stop") recordingClosedAfterBatch = true;
			else if (browserActiveAfterClose && (subcommand === "start" || subcommand === "restart")) recordingClosedAfterBatch = false;
		} else if (sawClose) {
			endsClosed = false;
			browserActiveAfterClose = true;
		}
	}
	return sawClose ? { endsClosed, recordingClosedAfterBatch, statePath } : undefined;
}
