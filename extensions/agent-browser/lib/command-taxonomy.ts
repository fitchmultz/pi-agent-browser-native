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

/** Starts conservatively invalidate refs because older supported natives replace the page, even on failure. Restarts invalidate only when they have a URL. */
export function isRecordPageTransitionCommand(tokens: readonly string[]): boolean {
	if (tokens[0] !== "record") {
		return false;
	}
	return (
		tokens[1] === "start" ||
		(tokens[1] === "restart" && getRecordCommandOperands(tokens).url !== undefined)
	);
}

export function isWebMcpPageMutationCommand(tokens: readonly string[]): boolean {
	return isWebMcpPageMutation(tokens[0], tokens[1]);
}

export function isWindowOrDiffPageTransitionCommand(
	command: string | undefined,
	subcommand?: string,
): boolean {
	return (
		(command === "window" && subcommand === "new") || (command === "diff" && subcommand === "url")
	);
}

export function isRefInvalidatingBatchCommand(step: readonly string[]): boolean {
	return (
		hasCommandCapability(step[0], "invalidatesBatchRefs") ||
		isRecordPageTransitionCommand(step) ||
		isWebMcpPageMutationCommand(step) ||
		isWindowOrDiffPageTransitionCommand(step[0], step[1])
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
		isWebMcpPageMutation(command, subcommand)
	);
}

export function isPageMutationCommand(command: string | undefined, subcommand?: string): boolean {
	return (
		hasCommandCapability(command, "triggersPostMutationSnapshot") ||
		isWebMcpPageMutation(command, subcommand)
	);
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
