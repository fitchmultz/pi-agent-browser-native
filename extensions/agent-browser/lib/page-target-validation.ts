import { parseArgvDescriptor } from "./argv-descriptor.js";
import {
	GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
	VALUE_FLAGS,
} from "./argv-grammar.js";
import { needsManagedSession } from "./command-policy.js";
import { isUnverifiedPageTransitionCommand } from "./command-taxonomy.js";
import { type BatchCommandStep, parseBatchCommandArgument, parseUserBatchStdin } from "./orchestration/batch-stdin.js";

const UNVERIFIED_PAGE_MESSAGE = "The active page became unverified after a tab, attachment, history, script, or state-load transition. Run get url or navigate explicitly before page-content inspection.";
const BATCH_UNVERIFIED_PAGE_MESSAGE = `${UNVERIFIED_PAGE_MESSAGE} In a batch, put get url after the transition before later content steps, or split the batch at that boundary.`;
const UNSAFE_BATCH_ARGUMENT_MESSAGE = "Batch command arguments could not be inspected. Use batch stdin JSON command arrays instead.";
const NESTED_BATCH_ARGUMENT_MESSAGE = "Nested batch commands are not supported. Flatten the batch steps instead.";
const NON_BAIL_BATCH_NAVIGATION_MESSAGE = "Batches that change or re-verify the page target before page-content access must use exact batch --bail so a failed step cannot act on an unverified or prior page.";
const MAX_NON_BAIL_BATCH_PAGE_STATES = 64;
const EXPLICIT_NAVIGATION_COMMANDS = new Set(["a11y", "goto", "navigate", "open", "pushstate", "visit", "vitals", "web-vitals"]);
const POSITIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, "--llms"]);

function getPositionalOperands(commandTokens: string[]): string[] {
	const values: string[] = [];
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (!token || (token.includes("=") && token.startsWith("-"))) continue;
		if (POSITIONAL_VALUE_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token)) {
			if (["true", "false"].includes(commandTokens[index + 1] ?? "")) index += 1;
			continue;
		}
		if (!token.startsWith("-") || token.includes("/") || token.includes("\\")) values.push(token);
	}
	return values;
}

function getExplicitNavigationTarget(args: string[]): string | undefined {
	const descriptor = parseArgvDescriptor(args);
	const positionals = getPositionalOperands(descriptor.upstreamCommandTokens);
	if (EXPLICIT_NAVIGATION_COMMANDS.has(descriptor.commandInfo.command ?? "")) return positionals[0];
	if (descriptor.commandInfo.command === "tab" && descriptor.commandInfo.subcommand === "new") return positionals[1];
	return undefined;
}

function getResultingExplicitNavigationTarget(args: string[], currentPageUrl?: string): string | undefined {
	const target = getExplicitNavigationTarget(args);
	if (target === undefined) return undefined;
	if (parseArgvDescriptor(args).commandInfo.command !== "pushstate") return target;
	try {
		return new URL(target).href;
	} catch {
		if (!currentPageUrl) return undefined;
		try {
			return new URL(target, currentPageUrl).href;
		} catch {
			return undefined;
		}
	}
}

function getBatchCommandSteps(args: string[], stdin?: string): { error?: string; steps: BatchCommandStep[] } {
	const descriptor = parseArgvDescriptor(args);
	if (descriptor.commandInfo.command !== "batch") return { steps: [] };
	const argumentCommands = descriptor.upstreamCommandTokens.slice(1).filter((command) => command !== "--bail");
	const steps: BatchCommandStep[] = [];
	if (argumentCommands.length > 0) {
		for (const command of argumentCommands) {
			const parsed = parseBatchCommandArgument(command);
			if (parsed.error || parsed.step === undefined) return { error: parsed.error ?? UNSAFE_BATCH_ARGUMENT_MESSAGE, steps: [] };
			if (parseArgvDescriptor(parsed.step).commandInfo.command === "batch") return { error: NESTED_BATCH_ARGUMENT_MESSAGE, steps: [] };
			steps.push(parsed.step);
		}
		return { steps };
	}
	const parsedStdin = parseUserBatchStdin(stdin);
	if (parsedStdin.error) return { error: parsedStdin.error, steps: [] };
	for (const step of parsedStdin.steps ?? []) {
		if (parseArgvDescriptor(step).commandInfo.command === "batch") return { error: NESTED_BATCH_ARGUMENT_MESSAGE, steps: [] };
		steps.push(step);
	}
	return { steps };
}

function batchBailsOnFirstError(args: string[]): boolean {
	const descriptor = parseArgvDescriptor(args);
	return descriptor.commandInfo.command === "batch" && descriptor.upstreamCommandTokens.slice(1).includes("--bail");
}

interface PossibleBatchPageState {
	currentPageUrl?: string;
	pageUrlUnknown: boolean;
	retainedAfterFailedNavigation: boolean;
}

function commandMayChangePageTarget(args: string[], trustedBatchTabSelection: boolean): boolean {
	const descriptor = parseArgvDescriptor(args);
	return getExplicitNavigationTarget(args) !== undefined
		|| (isUnverifiedPageTransitionCommand(descriptor.commandInfo.command, descriptor.commandInfo.subcommand)
			&& !(trustedBatchTabSelection && descriptor.commandInfo.command === "tab"));
}

function commandVerifiesPageTarget(args: string[]): boolean {
	const { command, subcommand } = parseArgvDescriptor(args).commandInfo;
	return command === "get" && subcommand === "url";
}

function deduplicatePossibleBatchPageStates(states: PossibleBatchPageState[]): PossibleBatchPageState[] {
	const deduplicated = new Map<string, PossibleBatchPageState>();
	for (const state of states) {
		const key = `${state.pageUrlUnknown ? "unknown" : "known"}\0${state.currentPageUrl ?? ""}`;
		const existing = deduplicated.get(key);
		if (!existing) deduplicated.set(key, state);
		else existing.retainedAfterFailedNavigation ||= state.retainedAfterFailedNavigation;
	}
	return [...deduplicated.values()];
}

export function commandRequiresLivePageVerification(args: string[], stdin?: string): boolean {
	const descriptor = parseArgvDescriptor(args);
	if (descriptor.commandInfo.command === "eval") return true;
	if (descriptor.commandInfo.command !== "batch") return false;
	const batch = getBatchCommandSteps(args, stdin);
	return batch.error === undefined && batch.steps.some((step) => commandRequiresLivePageVerification(step));
}

function getResultingPageState(options: {
	args: string[];
	currentPageUrl?: string;
	pageUrlUnknown: boolean;
	trustedBatchTabSelection: boolean;
}): { currentPageUrl?: string; pageUrlUnknown: boolean } {
	const descriptor = parseArgvDescriptor(options.args);
	if (descriptor.commandInfo.command === "get" && descriptor.commandInfo.subcommand === "url") {
		return { currentPageUrl: options.currentPageUrl, pageUrlUnknown: false };
	}
	const rawExplicitTarget = getExplicitNavigationTarget(options.args);
	const explicitTarget = getResultingExplicitNavigationTarget(options.args, options.currentPageUrl);
	if (explicitTarget !== undefined) return { currentPageUrl: explicitTarget, pageUrlUnknown: false };
	if (rawExplicitTarget !== undefined) return { pageUrlUnknown: true };
	if (isUnverifiedPageTransitionCommand(descriptor.commandInfo.command, descriptor.commandInfo.subcommand)) {
		return options.trustedBatchTabSelection && descriptor.commandInfo.command === "tab"
			? { currentPageUrl: options.currentPageUrl, pageUrlUnknown: options.pageUrlUnknown }
			: { pageUrlUnknown: true };
	}
	return { currentPageUrl: options.currentPageUrl, pageUrlUnknown: options.pageUrlUnknown };
}

export function getResultingPageTargetState(options: {
	args: string[];
	currentPageUrl?: string;
	pageUrlUnknown?: boolean;
	stdin?: string;
	trustedFirstBatchTabSelection?: boolean;
}): { currentPageUrl?: string; pageTargetMayHaveChanged: boolean; pageUrlUnknown: boolean } {
	const descriptor = parseArgvDescriptor(options.args);
	let state: { currentPageUrl?: string; pageUrlUnknown: boolean } = { currentPageUrl: options.currentPageUrl, pageUrlUnknown: options.pageUrlUnknown ?? false };
	let pageTargetMayHaveChanged = false;
	if (descriptor.commandInfo.command !== "batch") {
		pageTargetMayHaveChanged = getExplicitNavigationTarget(options.args) !== undefined
			|| isUnverifiedPageTransitionCommand(descriptor.commandInfo.command, descriptor.commandInfo.subcommand);
		return { ...getResultingPageState({ ...state, args: options.args, trustedBatchTabSelection: false }), pageTargetMayHaveChanged };
	}
	const batch = getBatchCommandSteps(options.args, options.stdin);
	if (batch.error) return { pageTargetMayHaveChanged: true, pageUrlUnknown: true };
	for (let index = 0; index < batch.steps.length; index += 1) {
		const step = batch.steps[index];
		const trustedBatchTabSelection = options.trustedFirstBatchTabSelection === true && index === 0;
		const stepDescriptor = parseArgvDescriptor(step);
		pageTargetMayHaveChanged ||= getExplicitNavigationTarget(step) !== undefined
			|| (isUnverifiedPageTransitionCommand(stepDescriptor.commandInfo.command, stepDescriptor.commandInfo.subcommand)
				&& !(trustedBatchTabSelection && stepDescriptor.commandInfo.command === "tab"));
		state = getResultingPageState({ ...state, args: step, trustedBatchTabSelection });
	}
	return { ...state, pageTargetMayHaveChanged };
}

function isRecoveringPageTransitionCommand(command: string | undefined, subcommand?: string): boolean {
	return command !== "eval"
		&& !(command === "webmcp" && subcommand === "invoke")
		&& isUnverifiedPageTransitionCommand(command, subcommand);
}

function getUnverifiedPageError(options: {
	allowUnverifiedPageTransitions?: boolean;
	args: string[];
	pageUrlUnknown?: boolean;
	trustedBatchTabSelection?: boolean;
}): string | undefined {
	if (!options.pageUrlUnknown) return undefined;
	const { command, subcommand } = parseArgvDescriptor(options.args).commandInfo;
	const closesPage = ["close", "exit", "quit"].includes(command ?? "") || (command === "tab" && subcommand === "close");
	const inspectsTarget = (command === "tab" && subcommand === "list") || (command === "get" && subcommand === "url");
	const selectsTab = command === "tab" && subcommand !== undefined && !["close", "list", "new"].includes(subcommand);
	const settlesPendingWebMcp = command === "webmcp" && ["result", "cancel"].includes(subcommand ?? "");
	const transitionsPage = options.allowUnverifiedPageTransitions === true && isRecoveringPageTransitionCommand(command, subcommand);
	const navigatesExplicitly = getExplicitNavigationTarget(options.args) !== undefined;
	return closesPage || inspectsTarget || selectsTab || settlesPendingWebMcp || transitionsPage || navigatesExplicitly || (options.trustedBatchTabSelection && command === "tab")
		? undefined
		: UNVERIFIED_PAGE_MESSAGE;
}

export function getPageTargetValidationError(options: {
	allowUnverifiedPageTransitions?: boolean;
	args: string[];
	currentPageUrl?: string;
	pageUrlUnknown?: boolean;
	stdin?: string;
	trustedFirstBatchTabSelection?: boolean;
}): string | undefined {
	const descriptor = parseArgvDescriptor(options.args);
	const command = descriptor.commandInfo.command;
	if (["close", "exit", "quit"].includes(command ?? "")) return undefined;
	if (command === "batch") {
		const batch = getBatchCommandSteps(options.args, options.stdin);
		if (batch.error) return batch.error.startsWith("agent_browser batch stdin") || batch.error === NESTED_BATCH_ARGUMENT_MESSAGE
			? batch.error
			: UNSAFE_BATCH_ARGUMENT_MESSAGE;
		const bailOnFirstError = batchBailsOnFirstError(options.args);
		let possibleStates: PossibleBatchPageState[] = [{
			currentPageUrl: options.currentPageUrl,
			pageUrlUnknown: options.pageUrlUnknown ?? false,
			retainedAfterFailedNavigation: false,
		}];
		for (let index = 0; index < batch.steps.length; index += 1) {
			const step = batch.steps[index];
			const trustedBatchTabSelection = options.trustedFirstBatchTabSelection === true && index === 0;
			let directError: string | undefined;
			let failedNavigationHazard = false;
			for (const state of possibleStates) {
				const error = getUnverifiedPageError({
					allowUnverifiedPageTransitions: options.allowUnverifiedPageTransitions,
					args: step,
					pageUrlUnknown: state.pageUrlUnknown,
					trustedBatchTabSelection,
				});
				if (!error) continue;
				if (state.retainedAfterFailedNavigation) failedNavigationHazard = true;
				else directError ??= error;
			}
			if (directError) return BATCH_UNVERIFIED_PAGE_MESSAGE;
			if (failedNavigationHazard) return NON_BAIL_BATCH_NAVIGATION_MESSAGE;
			const mayChangePageTarget = commandMayChangePageTarget(step, trustedBatchTabSelection);
			const verifiesPageTarget = commandVerifiesPageTarget(step);
			const nextStates: PossibleBatchPageState[] = [];
			for (const state of possibleStates) {
				const successState = getResultingPageState({
					args: step,
					currentPageUrl: state.currentPageUrl,
					pageUrlUnknown: state.pageUrlUnknown,
					trustedBatchTabSelection,
				});
				if (nextStates.length >= MAX_NON_BAIL_BATCH_PAGE_STATES) return NON_BAIL_BATCH_NAVIGATION_MESSAGE;
				nextStates.push({ ...successState, retainedAfterFailedNavigation: mayChangePageTarget || verifiesPageTarget ? false : state.retainedAfterFailedNavigation });
				if (!bailOnFirstError && (mayChangePageTarget || (verifiesPageTarget && state.pageUrlUnknown))) {
					nextStates.push({ ...state, retainedAfterFailedNavigation: true });
				}
			}
			possibleStates = deduplicatePossibleBatchPageStates(nextStates);
		}
		return undefined;
	}
	return getUnverifiedPageError({
		allowUnverifiedPageTransitions: options.allowUnverifiedPageTransitions,
		args: options.args,
		pageUrlUnknown: options.pageUrlUnknown,
		trustedBatchTabSelection: options.trustedFirstBatchTabSelection,
	});
}

export function getExplicitSessionPageVerificationRequirement(options: {
	args: string[];
	stdin?: string;
	trustedFirstBatchTabSelection?: boolean;
}): string | undefined {
	const descriptor = parseArgvDescriptor(options.args);
	if (!needsManagedSession(descriptor)) return undefined;
	if (isRecoveringPageTransitionCommand(descriptor.commandInfo.command, descriptor.commandInfo.subcommand)) return undefined;
	const validationError = getPageTargetValidationError({
		args: options.args,
		pageUrlUnknown: true,
		stdin: options.stdin,
		allowUnverifiedPageTransitions: true,
		trustedFirstBatchTabSelection: options.trustedFirstBatchTabSelection,
	});
	return validationError === UNVERIFIED_PAGE_MESSAGE || validationError === BATCH_UNVERIFIED_PAGE_MESSAGE || validationError === NON_BAIL_BATCH_NAVIGATION_MESSAGE
		? UNVERIFIED_PAGE_MESSAGE
		: undefined;
}
