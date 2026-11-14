import { hasCommandCapability } from "./command-capabilities.js";
export { isKnownCommandToken } from "./command-capabilities.js";

const WEBMCP_PAGE_MUTATION_SUBCOMMANDS = new Set(["invoke", "result", "cancel"]);

export function isCloseCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "closesSession");
}

export function isCloseAllCommand(commandTokens: readonly string[]): boolean {
	return isCloseCommand(commandTokens[0]) && commandTokens.slice(1).includes("--all");
}

export function isOpenNavigationCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "openNavigation");
}

export function isReadOnlyDiagnosticSessionTargetCommand(
	command: string | undefined,
	subcommand?: string,
): boolean {
	return (
		hasCommandCapability(command, "readOnlyDiagnosticSessionTarget") ||
		(command === "webmcp" && subcommand === "list")
	);
}

export function isSessionTabPinningExcludedCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "excludedFromPinning");
}

export function isSessionTabPostCommandCorrectionExcludedCommand(
	command: string | undefined,
): boolean {
	return hasCommandCapability(command, "excludedFromPostCommandCorrection");
}

function recordOptionWidth(token: string, next: string | undefined): number {
	// Native validates the range; bare/non-numeric --fps keeps its old literal meaning.
	if (token === "--fps" && /^\+?\d+$/.test(next ?? "")) {
		return 2;
	}
	if (token === "--cursor" || token === "--contact-sheet") {
		return 1;
	}
	return token === "--contact-sheet-threshold" && next !== undefined ? 2 : 0;
}

export function getRecordCommandOperandIndices(tokens: readonly string[]): number[] {
	if (tokens[0] !== "record" || !["start", "restart"].includes(tokens[1] ?? "")) {
		return [];
	}
	const operands: number[] = [];
	const entries = tokens.entries();
	entries.next();
	entries.next();
	for (const [index, token] of entries) {
		const width = recordOptionWidth(token, tokens.at(index + 1));
		if (width === 2) {
			entries.next();
		} else if (width === 0) {
			operands.push(index);
			if (operands.length === 2) {
				break;
			}
		}
	}
	return operands.length > 0 ? operands : [2, 3];
}

export function getRecordCommandOperands(tokens: readonly string[]): {
	path?: string | undefined;
	url?: string | undefined;
} {
	const indices = getRecordCommandOperandIndices(tokens);
	const path = indices.at(0);
	const url = indices.at(1);
	return path === undefined
		? {}
		: { path: tokens[path], url: url === undefined ? undefined : tokens[url] };
}

/** Native 0.43+ attaches screencast capture without replacing the page; starts and restarts retire refs only when they navigate to a URL. */
export function isRecordPageTransitionCommand(tokens: readonly string[]): boolean {
	if (tokens[0] !== "record") {
		return false;
	}
	return (
		(tokens[1] === "start" || tokens[1] === "restart") &&
		getRecordCommandOperands(tokens).url !== undefined
	);
}

export function isWindowOrDiffPageTransitionCommand(
	command: string | undefined,
	subcommand?: string,
): boolean {
	return (
		(command === "window" && subcommand === "new") || (command === "diff" && subcommand === "url")
	);
}

/** A saved-flow run can fall back to replaying its recorded commands, which navigates the session's page. */
function isFlowRunCommand(command: string | undefined, subcommand?: string): boolean {
	return command === "flow" && subcommand === "run";
}

/** A command whose run retires every earlier ref: later rows of its batch and the session's saved snapshot. */
export type RefRetiringTransition = "flow-run" | "record" | "reload" | "webmcp" | "window-or-diff";

export function getRefRetiringTransition(
	tokens: readonly string[],
): RefRetiringTransition | undefined {
	const [command, subcommand] = tokens;
	if (isRecordPageTransitionCommand(tokens)) {
		return "record";
	}
	if (isWindowOrDiffPageTransitionCommand(command, subcommand)) {
		return "window-or-diff";
	}
	if (command === "reload") {
		return "reload";
	}
	if (isWebMcpPageMutation(command, subcommand)) {
		return "webmcp";
	}
	return isFlowRunCommand(command, subcommand) ? "flow-run" : undefined;
}

export function isRefInvalidatingBatchCommand(step: readonly string[]): boolean {
	return (
		hasCommandCapability(step[0], "invalidatesBatchRefs") ||
		getRefRetiringTransition(step) !== undefined
	);
}

export function isRefGuardedCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "guardsPageRefs");
}

export function isElectronPostCommandHealthCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "eligibleForElectronHealthProbe");
}

function isWebMcpPageMutation(command: string | undefined, subcommand?: string): boolean {
	return command === "webmcp" && WEBMCP_PAGE_MUTATION_SUBCOMMANDS.has(subcommand ?? "");
}

export function isNavigationObservableCommandName(
	command: string | undefined,
	subcommand?: string,
): boolean {
	return (
		hasCommandCapability(command, "navigationObservable") ||
		isWebMcpPageMutation(command, subcommand) ||
		isWindowOrDiffPageTransitionCommand(command, subcommand)
	);
}

export function isUnverifiedPageTransitionCommand(
	command: string | undefined,
	subcommand?: string,
): boolean {
	return (
		["back", "connect", "eval", "forward", "reload"].includes(command ?? "") ||
		(command === "state" && subcommand === "load") ||
		(command === "tab" && subcommand !== undefined && !["list", "new"].includes(subcommand)) ||
		isWindowOrDiffPageTransitionCommand(command, subcommand) ||
		isWebMcpPageMutation(command, subcommand) ||
		isFlowRunCommand(command, subcommand)
	);
}

/**
 * Native eval and reload return the URL they read after the step with the same call as get url
 * (eval as `origin`, reload as `url`), so their own successful result is page-target evidence.
 */
export function isPageReportingTransitionCommand(
	command: string | undefined,
): command is "eval" | "reload" {
	return command === "eval" || command === "reload";
}

export function isPageMutationCommand(command: string | undefined, subcommand?: string): boolean {
	return (
		hasCommandCapability(command, "triggersPostMutationSnapshot") ||
		isWebMcpPageMutation(command, subcommand)
	);
}

/** Whether a batch step acts on the page: a mutation command, or `find` with a mutating action. */
export function isPageMutationStep(step: readonly string[]): boolean {
	const action = step[0] === "find" ? (step[step[1] === "nth" ? 4 : 3] ?? "click") : step[0];
	return isPageMutationCommand(action, step[1]);
}

export function isPageChangeSummaryCommand(
	command: string | undefined,
	subcommand?: string,
): boolean {
	return (
		hasCommandCapability(command, "eligibleForPageChangeSummary") ||
		isWebMcpPageMutation(command, subcommand)
	);
}
