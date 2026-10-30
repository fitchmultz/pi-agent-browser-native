import { parseArgvDescriptor } from "./argv-descriptor.js";
import {
	type BatchCommandStep,
	isNativeBatchOption,
	parseBatchCommandArgument,
	parseUserBatchStdin,
} from "./orchestration/batch-stdin.js";
import {
	BATCH_UNVERIFIED_PAGE_MESSAGE,
	NON_BAIL_BATCH_NAVIGATION_MESSAGE,
	getUnverifiedPageError,
} from "./page-target-guards.js";
import {
	type PageTargetState,
	commandMayChangePageTarget,
	commandVerifiesPageTarget,
	getResultingPageState,
} from "./page-target-navigation.js";

export const UNSAFE_BATCH_ARGUMENT_MESSAGE =
	"Batch command arguments could not be inspected. Use batch stdin JSON command arrays instead.";
export const NESTED_BATCH_ARGUMENT_MESSAGE =
	"Nested batch commands are not supported. Flatten the batch steps instead.";
const MAX_NON_BAIL_BATCH_PAGE_STATES = 64;

type BatchPlan = { readonly error?: string; readonly steps: readonly (readonly string[])[] };

function inspectBatchArguments(commands: readonly string[]): BatchPlan {
	const steps: BatchCommandStep[] = [];
	for (const command of commands) {
		const parsed = parseBatchCommandArgument(command);
		if ((parsed.error !== undefined && parsed.error.length > 0) || parsed.step === undefined) {
			return { error: parsed.error ?? UNSAFE_BATCH_ARGUMENT_MESSAGE, steps: [] };
		}
		if (parseArgvDescriptor(parsed.step).commandInfo.command === "batch") {
			return { error: NESTED_BATCH_ARGUMENT_MESSAGE, steps: [] };
		}
		steps.push(parsed.step);
	}
	return { steps };
}

export function getBatchCommandSteps(args: readonly string[], stdin?: string): BatchPlan {
	const descriptor = parseArgvDescriptor(args);
	if (descriptor.commandInfo.command !== "batch") {
		return { steps: [] };
	}
	const argumentsToParse = descriptor.upstreamCommandTokens
		.slice(1)
		.filter((command) => !isNativeBatchOption(command));
	if (argumentsToParse.length > 0) {
		return inspectBatchArguments(argumentsToParse);
	}
	const parsed = parseUserBatchStdin(stdin);
	if (parsed.error !== undefined && parsed.error.length > 0) {
		return { error: parsed.error, steps: [] };
	}
	const steps = (parsed.steps ?? []).filter((step) => step.length > 0);
	return steps.some((step) => parseArgvDescriptor(step).commandInfo.command === "batch")
		? { error: NESTED_BATCH_ARGUMENT_MESSAGE, steps: [] }
		: { steps };
}

interface PossibleBatchPageState extends PageTargetState {
	readonly retainedAfterFailedNavigation: boolean;
}

function deduplicatePossibleBatchPageStates(
	states: readonly PossibleBatchPageState[],
): PossibleBatchPageState[] {
	const deduplicated = new Map<string, PossibleBatchPageState>();
	for (const state of states) {
		const key = `${state.pageUrlUnknown ? "unknown" : "known"}\0${state.currentPageUrl ?? ""}`;
		const existing = deduplicated.get(key);
		deduplicated.set(key, {
			...(existing ?? state),
			retainedAfterFailedNavigation:
				state.retainedAfterFailedNavigation || existing?.retainedAfterFailedNavigation === true,
		});
	}
	return [...deduplicated.values()];
}

export interface BatchTargetValidationOptions {
	readonly allowFirstBatchConfirmation?: boolean;
	readonly allowUnverifiedPageTransitions?: boolean;
	readonly currentPageUrl?: string;
	readonly pageUrlUnknown?: boolean;
	readonly trustedFirstBatchTabSelection?: boolean;
}

function possibleStateError(
	states: readonly PossibleBatchPageState[],
	step: readonly string[],
	options: {
		readonly allowUnverifiedPageTransitions?: boolean;
		readonly trustedBatchTabSelection: boolean;
		readonly allowsConfirmation: boolean;
	},
): string | undefined {
	if (options.allowsConfirmation) {
		return undefined;
	}
	let failedNavigationHazard = false;
	for (const state of states) {
		const error = getUnverifiedPageError({
			...options,
			args: step,
			pageUrlUnknown: state.pageUrlUnknown,
		});
		if (error === undefined || error.length === 0) {
			continue;
		}
		if (!state.retainedAfterFailedNavigation) {
			return BATCH_UNVERIFIED_PAGE_MESSAGE;
		}
		failedNavigationHazard = true;
	}
	return failedNavigationHazard ? NON_BAIL_BATCH_NAVIGATION_MESSAGE : undefined;
}

function advancePossibleStates(
	states: readonly PossibleBatchPageState[],
	step: readonly string[],
	trustedBatchTabSelection: boolean,
	bail: boolean,
): { states: PossibleBatchPageState[]; error?: string } {
	const mayChangePageTarget = commandMayChangePageTarget(step, trustedBatchTabSelection);
	const verifiesPageTarget = commandVerifiesPageTarget(step);
	const nextStates: PossibleBatchPageState[] = [];
	for (const state of states) {
		if (nextStates.length >= MAX_NON_BAIL_BATCH_PAGE_STATES) {
			return { states: [], error: NON_BAIL_BATCH_NAVIGATION_MESSAGE };
		}
		nextStates.push({
			...getResultingPageState({ args: step, ...state, trustedBatchTabSelection }),
			retainedAfterFailedNavigation:
				mayChangePageTarget || verifiesPageTarget ? false : state.retainedAfterFailedNavigation,
		});
		if (!bail && (mayChangePageTarget || (verifiesPageTarget && state.pageUrlUnknown))) {
			nextStates.push({ ...state, retainedAfterFailedNavigation: true });
		}
	}
	return { states: deduplicatePossibleBatchPageStates(nextStates) };
}

export function validateBatchPageTargets(
	steps: readonly (readonly string[])[],
	bail: boolean,
	options: BatchTargetValidationOptions,
): string | undefined {
	let states: PossibleBatchPageState[] = [
		{
			currentPageUrl: options.currentPageUrl,
			pageUrlUnknown: options.pageUrlUnknown ?? false,
			retainedAfterFailedNavigation: false,
		},
	];
	for (const [index, step] of steps.entries()) {
		const trustedBatchTabSelection = options.trustedFirstBatchTabSelection === true && index === 0;
		const error = possibleStateError(states, step, {
			allowUnverifiedPageTransitions: options.allowUnverifiedPageTransitions,
			trustedBatchTabSelection,
			allowsConfirmation: options.allowFirstBatchConfirmation === true && index === 0,
		});
		if (error !== undefined) {
			return error;
		}
		const next = advancePossibleStates(states, step, trustedBatchTabSelection, bail);
		if (next.error !== undefined) {
			return next.error;
		}
		states = next.states;
	}
	return undefined;
}
