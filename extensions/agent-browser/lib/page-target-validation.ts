import { parseArgvDescriptor } from "./argv-descriptor.js";
import { isBrowserIndependentRead, needsManagedSession } from "./command-policy.js";
import { isRecord } from "./parsing.js";
import { detectConfirmationRequired } from "./results/confirmation.js";
import {
	getBatchCommandSteps,
	validateBatchPageTargets,
	type BatchTargetValidationOptions,
	UNSAFE_BATCH_ARGUMENT_MESSAGE,
	NESTED_BATCH_ARGUMENT_MESSAGE,
} from "./page-target-batch.js";
import {
	UNVERIFIED_PAGE_MESSAGE,
	BATCH_UNVERIFIED_PAGE_MESSAGE,
	NON_BAIL_BATCH_NAVIGATION_MESSAGE,
	getUnverifiedPageError,
	isRecoveringPageTransitionCommand,
} from "./page-target-guards.js";
import {
	commandMayChangePageTarget,
	getResultingPageState,
	type PageTargetState,
} from "./page-target-navigation.js";
export { getExplicitNavigationTarget } from "./page-target-navigation.js";

export function commandRequiresLivePageVerification(
	args: readonly string[],
	stdin?: string,
): boolean {
	const { command } = parseArgvDescriptor(args).commandInfo;
	if (command === "eval") {
		return true;
	}
	if (command !== "batch") {
		return false;
	}
	const batch = getBatchCommandSteps(args, stdin);
	return (
		batch.error === undefined &&
		batch.steps.some((step) => commandRequiresLivePageVerification(step))
	);
}

export function getResultingPageTargetState(options: {
	readonly args: readonly string[];
	readonly executedBatchSteps: readonly (readonly string[])[];
	readonly batchResults?: unknown;
	readonly currentPageUrl?: string | undefined;
	readonly pageUrlUnknown?: boolean;
}): {
	currentPageUrl?: string | undefined;
	pageTargetMayHaveChanged: boolean;
	pageUrlUnknown: boolean;
} {
	let state: PageTargetState = {
		currentPageUrl: options.currentPageUrl,
		pageUrlUnknown: options.pageUrlUnknown ?? false,
	};
	if (parseArgvDescriptor(options.args).commandInfo.command !== "batch") {
		return {
			...getResultingPageState({ ...state, args: options.args, trustedBatchTabSelection: false }),
			pageTargetMayHaveChanged: commandMayChangePageTarget(options.args, false),
		};
	}
	let pageTargetMayHaveChanged = false;
	for (const [index, step] of options.executedBatchSteps.entries()) {
		const row: unknown = Array.isArray(options.batchResults)
			? options.batchResults[index]
			: undefined;
		if (isRecord(row) && detectConfirmationRequired(row.result)) {
			continue;
		}
		pageTargetMayHaveChanged ||= commandMayChangePageTarget(step, false);
		state = getResultingPageState({ ...state, args: step, trustedBatchTabSelection: false });
	}
	return { ...state, pageTargetMayHaveChanged };
}

export function getPageTargetValidationError(
	options: BatchTargetValidationOptions & {
		readonly args: readonly string[];
		readonly stdin?: string | undefined;
	},
): string | undefined {
	const descriptor = parseArgvDescriptor(options.args);
	const command = descriptor.commandInfo.command;
	if (
		isBrowserIndependentRead(descriptor.upstreamCommandTokens, options.stdin) ||
		["close", "exit", "quit"].includes(command ?? "")
	) {
		return undefined;
	}
	if (command !== "batch") {
		return getUnverifiedPageError({
			...options,
			trustedBatchTabSelection: options.trustedFirstBatchTabSelection,
		});
	}
	const rawArguments = descriptor.upstreamCommandTokens.slice(1);
	if (rawArguments.some((token) => token.startsWith("--bail="))) {
		return "Use exact batch --bail for fail-fast, or omit it to continue after errors. --bail=<value> is a raw command upstream; stdin is ignored when raw batch arguments are present.";
	}
	const batch = getBatchCommandSteps(options.args, options.stdin);
	if (batch.error !== undefined && batch.error.length > 0) {
		return batch.error.startsWith("agent_browser batch stdin") ||
			batch.error === NESTED_BATCH_ARGUMENT_MESSAGE
			? batch.error
			: UNSAFE_BATCH_ARGUMENT_MESSAGE;
	}
	return validateBatchPageTargets(batch.steps, rawArguments.includes("--bail"), options);
}

export function getExplicitSessionPageVerificationRequirement(options: {
	readonly args: readonly string[];
	readonly stdin?: string | undefined;
}): string | undefined {
	const descriptor = parseArgvDescriptor(options.args);
	if (
		!needsManagedSession(descriptor, options.stdin) ||
		isRecoveringPageTransitionCommand(
			descriptor.commandInfo.command,
			descriptor.commandInfo.subcommand,
		)
	) {
		return undefined;
	}
	const validationError = getPageTargetValidationError({
		args: options.args,
		pageUrlUnknown: true,
		stdin: options.stdin,
		allowUnverifiedPageTransitions: true,
	});
	return [
		UNVERIFIED_PAGE_MESSAGE,
		BATCH_UNVERIFIED_PAGE_MESSAGE,
		NON_BAIL_BATCH_NAVIGATION_MESSAGE,
	].includes(validationError ?? "")
		? UNVERIFIED_PAGE_MESSAGE
		: undefined;
}
