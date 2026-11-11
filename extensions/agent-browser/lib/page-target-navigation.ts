import { parseArgvDescriptor } from "./argv-descriptor.js";
import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, VALUE_FLAGS } from "./argv-grammar.js";
import {
	isPageReportingTransitionCommand,
	isUnverifiedPageTransitionCommand,
} from "./command-taxonomy.js";

const EXPLICIT_NAVIGATION_COMMANDS = new Set([
	"a11y",
	"goto",
	"navigate",
	"open",
	"pushstate",
	"visit",
	"vitals",
	"web-vitals",
]);
const POSITIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, "--llms"]);

function isPositionalOperand(token: string): boolean {
	return !token.startsWith("-") || token.includes("/") || token.includes("\\");
}

function getPositionalOperands(commandTokens: readonly string[]): string[] {
	const values: string[] = [];
	const entries = commandTokens.entries();
	entries.next();
	for (const [index, token] of entries) {
		if (token.length === 0 || (token.includes("=") && token.startsWith("-"))) {
			continue;
		}
		if (POSITIONAL_VALUE_FLAGS.has(token)) {
			entries.next();
			continue;
		}
		if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token)) {
			if (["true", "false"].includes(commandTokens[index + 1] ?? "")) {
				entries.next();
			}
			continue;
		}
		if (isPositionalOperand(token)) {
			values.push(token);
		}
	}
	return values;
}

export function getExplicitNavigationTarget(args: readonly string[]): string | undefined {
	const descriptor = parseArgvDescriptor(args);
	const positionals = getPositionalOperands(descriptor.upstreamCommandTokens);
	const { command, subcommand } = descriptor.commandInfo;
	if (EXPLICIT_NAVIGATION_COMMANDS.has(command ?? "")) {
		return positionals[0];
	}
	if (command === "tab" && subcommand === "new") {
		return positionals[1];
	}
	if (command === "window" && subcommand === "new") {
		return "about:blank";
	}
	return command === "diff" && subcommand === "url"
		? descriptor.upstreamCommandTokens[3]
		: undefined;
}

function getResultingExplicitNavigationTarget(
	args: readonly string[],
	currentPageUrl?: string,
): string | undefined {
	const target = getExplicitNavigationTarget(args);
	if (target === undefined || parseArgvDescriptor(args).commandInfo.command !== "pushstate") {
		return target;
	}
	try {
		return new URL(target).href;
	} catch {
		if (currentPageUrl === undefined || currentPageUrl.length === 0) {
			return undefined;
		}
		try {
			return new URL(target, currentPageUrl).href;
		} catch {
			return undefined;
		}
	}
}

export interface PageTargetState {
	readonly currentPageUrl?: string | undefined;
	readonly pageUrlUnknown: boolean;
}

export function commandMayChangePageTarget(
	args: readonly string[],
	trustedBatchTabSelection: boolean,
): boolean {
	const { command, subcommand } = parseArgvDescriptor(args).commandInfo;
	return (
		getExplicitNavigationTarget(args) !== undefined ||
		(isUnverifiedPageTransitionCommand(command, subcommand) &&
			!(trustedBatchTabSelection && command === "tab"))
	);
}

export function commandVerifiesPageTarget(args: readonly string[]): boolean {
	const { command, subcommand } = parseArgvDescriptor(args).commandInfo;
	return command === "get" && subcommand === "url";
}

/** A successful eval or reload reports its resulting page; a failed one leaves the page unknown. */
export function commandReportsResultingPage(args: readonly string[]): boolean {
	return isPageReportingTransitionCommand(parseArgvDescriptor(args).commandInfo.command);
}

export function getResultingPageState(
	options: PageTargetState & {
		readonly args: readonly string[];
		readonly trustedBatchTabSelection: boolean;
	},
): PageTargetState {
	const { command, subcommand } = parseArgvDescriptor(options.args).commandInfo;
	if (command === "get" && subcommand === "url") {
		return { currentPageUrl: options.currentPageUrl, pageUrlUnknown: false };
	}
	const rawExplicitTarget = getExplicitNavigationTarget(options.args);
	const explicitTarget = getResultingExplicitNavigationTarget(options.args, options.currentPageUrl);
	if (explicitTarget !== undefined) {
		return { currentPageUrl: explicitTarget, pageUrlUnknown: false };
	}
	if (rawExplicitTarget !== undefined) {
		return { pageUrlUnknown: true };
	}
	if (isPageReportingTransitionCommand(command)) {
		// The step may navigate, so only its own result can name the resulting URL.
		return { pageUrlUnknown: false };
	}
	if (
		isUnverifiedPageTransitionCommand(command, subcommand) &&
		!(options.trustedBatchTabSelection && command === "tab")
	) {
		return { pageUrlUnknown: true };
	}
	return { currentPageUrl: options.currentPageUrl, pageUrlUnknown: options.pageUrlUnknown };
}
