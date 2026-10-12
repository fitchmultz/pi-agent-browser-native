import { parseArgvDescriptor } from "./argv-descriptor.js";
import { needsManagedSession } from "./command-policy.js";
import { isUnverifiedPageTransitionCommand } from "./command-taxonomy.js";
import { getExplicitNavigationTarget } from "./page-target-navigation.js";

export const UNVERIFIED_PAGE_MESSAGE =
	"The active page became unverified after a tab, attachment, history, script, or state-load transition. Run get url or navigate explicitly before page-content inspection.";
export const BATCH_UNVERIFIED_PAGE_MESSAGE = `${UNVERIFIED_PAGE_MESSAGE} In a batch, put get url after the transition before later content steps, or split the batch at that boundary.`;
export const NON_BAIL_BATCH_NAVIGATION_MESSAGE =
	"Batches that change or re-verify the page target before page-content access must use exact batch --bail so a failed step cannot act on an unverified or prior page.";

export function isRecoveringPageTransitionCommand(
	command: string | undefined,
	subcommand?: string,
): boolean {
	return (
		command !== "eval" &&
		!(command === "webmcp" && subcommand === "invoke") &&
		isUnverifiedPageTransitionCommand(command, subcommand)
	);
}

function canOperateWithoutVerifiedPage(command: string | undefined, subcommand?: string): boolean {
	switch (command) {
		case undefined:
			return false;
		case "close":
		case "exit":
		case "quit":
			return true;
		case "tab":
			return subcommand !== undefined && subcommand !== "new";
		case "get":
			return subcommand === "url";
		case "session":
			return subcommand === undefined;
		case "webmcp":
			return ["result", "cancel"].includes(subcommand ?? "");
		case "record":
			return subcommand === "stop";
		case "dialog":
			return ["status", "accept", "dismiss"].includes(subcommand ?? "");
		default:
			return false;
	}
}

export interface PageTargetGuardOptions {
	readonly allowUnverifiedPageTransitions?: boolean;
	readonly args: readonly string[];
	readonly pageUrlUnknown?: boolean;
	readonly trustedBatchTabSelection?: boolean;
}

export function getUnverifiedPageError(options: PageTargetGuardOptions): string | undefined {
	const descriptor = parseArgvDescriptor(options.args);
	if (options.pageUrlUnknown !== true || !needsManagedSession(descriptor)) {
		return undefined;
	}
	const { command, subcommand } = descriptor.commandInfo;
	if (canOperateWithoutVerifiedPage(command, subcommand)) {
		return undefined;
	}
	const transitionsPage =
		options.allowUnverifiedPageTransitions === true &&
		isRecoveringPageTransitionCommand(command, subcommand);
	const trustedTab = options.trustedBatchTabSelection === true && command === "tab";
	return transitionsPage || trustedTab || getExplicitNavigationTarget(options.args) !== undefined
		? undefined
		: UNVERIFIED_PAGE_MESSAGE;
}
