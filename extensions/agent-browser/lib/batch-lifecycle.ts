import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import { isCloseCommand } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";
import { isSuccessfulNativeConfirmedClose } from "./native-confirmation.js";
import { detectConfirmationRequired } from "./results/confirmation.js";

export interface SuccessfulBatchCloseLifecycle {
	readonly endsClosed: boolean;
	readonly recordingClosedAfterBatch: boolean;
	readonly statePath?: string;
}

interface BatchLifecycleStep {
	readonly tokens?: readonly string[];
	readonly result: unknown;
	readonly succeeded: boolean;
	readonly browserLaunched?: boolean;
}

function rowCommand(
	value: unknown,
	fallback: readonly string[] | undefined,
): readonly string[] | undefined {
	return Array.isArray(value) && value.every((token: unknown) => typeof token === "string")
		? value
		: fallback;
}

function rowResult(
	row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
	if (isRecord(row.result)) {
		return row.result;
	}
	return isRecord(row.data) ? row.data : undefined;
}

function rowBrowserLaunched(
	row: Readonly<Record<string, unknown>>,
	result: Readonly<Record<string, unknown>> | undefined,
): boolean | undefined {
	const lifecycle = isRecord(row.lifecycle) ? row.lifecycle : result?.lifecycle;
	if (!isRecord(lifecycle) || !isRecord(lifecycle.effectiveLaunch)) {
		return undefined;
	}
	const launched = lifecycle.effectiveLaunch.browserLaunched;
	return typeof launched === "boolean" ? launched : undefined;
}

function lifecycleStep(
	value: unknown,
	fallback: readonly string[] | undefined,
): BatchLifecycleStep | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const result = rowResult(value);
	const command = rowCommand(value.command, fallback);
	return {
		result,
		succeeded: value.success === true,
		browserLaunched: rowBrowserLaunched(value, result),
		tokens: command === undefined ? undefined : extractUpstreamCommandTokens(command),
	};
}

interface ClosedBatchState extends SuccessfulBatchCloseLifecycle {
	readonly browserActiveAfterClose: boolean;
}

function successfulClose(step: BatchLifecycleStep): boolean {
	return (
		step.succeeded &&
		step.tokens !== undefined &&
		!detectConfirmationRequired(step.result) &&
		(isCloseCommand(step.tokens[0]) || isSuccessfulNativeConfirmedClose(step.tokens, step.result))
	);
}

function closedState(step: BatchLifecycleStep): ClosedBatchState {
	const result = step.result;
	const closeData =
		step.tokens?.[0] === "confirm" && isRecord(result) && isRecord(result.result)
			? result.result.data
			: result;
	return {
		endsClosed: true,
		browserActiveAfterClose: false,
		recordingClosedAfterBatch: true,
		statePath:
			isRecord(closeData) && typeof closeData.statePath === "string"
				? closeData.statePath
				: undefined,
	};
}

function recordingState(state: ClosedBatchState, step: BatchLifecycleStep): ClosedBatchState {
	const relaunched = step.browserLaunched !== false;
	const browserActiveAfterClose = state.browserActiveAfterClose || relaunched;
	let recordingClosedAfterBatch = state.recordingClosedAfterBatch;
	const subcommand = step.tokens?.[1];
	if (step.succeeded && subcommand === "stop") {
		recordingClosedAfterBatch = true;
	} else if (
		step.succeeded &&
		browserActiveAfterClose &&
		(subcommand === "start" || subcommand === "restart")
	) {
		recordingClosedAfterBatch = false;
	}
	return {
		...state,
		endsClosed: state.endsClosed && !relaunched,
		browserActiveAfterClose,
		recordingClosedAfterBatch,
	};
}

function advanceClosedState(state: ClosedBatchState, step: BatchLifecycleStep): ClosedBatchState {
	if (step.tokens?.[0] === "record") {
		return recordingState(state, step);
	}
	if (step.browserLaunched === false) {
		return state;
	}
	return {
		...state,
		endsClosed: false,
		browserActiveAfterClose: true,
		recordingClosedAfterBatch: step.tokens === undefined ? false : state.recordingClosedAfterBatch,
	};
}

/** Fold in execution order. Unknown launch evidence conservatively retains active ownership, including failed rows. */
export function getSuccessfulBatchCloseLifecycle(
	rows: unknown,
	fallbackCommands: readonly (readonly string[])[] = [],
): SuccessfulBatchCloseLifecycle | undefined {
	if (!Array.isArray(rows)) {
		return undefined;
	}
	let state: ClosedBatchState | undefined;
	for (const [index, row] of rows.entries()) {
		const step = lifecycleStep(row, fallbackCommands.at(index));
		if (step === undefined) {
			continue;
		}
		if (successfulClose(step)) {
			state = closedState(step);
		} else if (state !== undefined) {
			state = advanceClosedState(state, step);
		}
	}
	return state === undefined
		? undefined
		: {
				endsClosed: state.endsClosed,
				recordingClosedAfterBatch: state.recordingClosedAfterBatch,
				statePath: state.statePath,
			};
}
