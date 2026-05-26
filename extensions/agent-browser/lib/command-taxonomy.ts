/**
 * Purpose: Centralize upstream agent-browser command groups that wrapper behavior depends on.
 * Responsibilities: Keep alias-aware command predicates in one neutral module so runtime planning,
 * session/ref guards, result recommendations, and presentation summaries do not drift.
 * Scope: Static command taxonomy only; parsing args, spawning processes, and formatting results live elsewhere.
 */

const CLOSE_COMMANDS = new Set(["close", "quit", "exit"]);
const OPEN_NAVIGATION_COMMANDS = new Set(["goto", "navigate", "open"]);
const READ_ONLY_DIAGNOSTIC_SESSION_TARGET_COMMANDS = new Set(["console", "cookies", "errors", "network", "storage"]);
const SESSION_TAB_PINNING_EXCLUDED_COMMANDS = new Set(["close", "exit", "goto", "navigate", "open", "quit", "session", "tab"]);
const SESSION_TAB_POST_COMMAND_CORRECTION_EXCLUDED_COMMANDS = new Set(["batch", "close", "exit", "quit", "session", "tab"]);

const REF_GUARDED_COMMANDS = new Set([
	"check",
	"click",
	"dblclick",
	"download",
	"drag",
	"fill",
	"focus",
	"hover",
	"key",
	"keyboard",
	"mouse",
	"press",
	"scrollinto",
	"scrollintoview",
	"select",
	"tap",
	"type",
	"uncheck",
	"upload",
]);

const ELECTRON_POST_COMMAND_HEALTH_COMMANDS = new Set([
	"back",
	"check",
	"click",
	"dblclick",
	"fill",
	"find",
	"forward",
	"key",
	"keydown",
	"keyboard",
	"keyup",
	"mouse",
	"press",
	"reload",
	"select",
	"tap",
	"type",
	"uncheck",
]);

const NAVIGATION_OBSERVABLE_COMMANDS = new Set(["back", "click", "dblclick", "forward", "reload"]);

const PAGE_MUTATION_COMMANDS = new Set([
	"back",
	"check",
	"click",
	"dblclick",
	"dialog",
	"fill",
	"forward",
	"hover",
	"key",
	"keydown",
	"keyboard",
	"keyup",
	"press",
	"pushstate",
	"reload",
	"scroll",
	"scrollinto",
	"scrollintoview",
	"select",
	"swipe",
	"tap",
	"type",
	"uncheck",
]);

const PAGE_CHANGE_SUMMARY_COMMANDS = new Set([
	...PAGE_MUTATION_COMMANDS,
	"download",
	"goto",
	"navigate",
	"open",
	"pdf",
	"screenshot",
]);

// `fill @ref` is guarded but does not invalidate later refs so same-snapshot form-fill batches can submit after filling.
const PAGE_MUTATION_REF_INVALIDATION_EXCEPTIONS = new Set(["fill"]);
const NON_MUTATION_REF_INVALIDATING_BATCH_COMMANDS = new Set(["drag", "goto", "mouse", "navigate", "open", "upload"]);

function commandIn(command: string | undefined, commands: ReadonlySet<string>): boolean {
	return command !== undefined && commands.has(command);
}

export function isCloseCommand(command: string | undefined): boolean {
	return commandIn(command, CLOSE_COMMANDS);
}

export function isOpenNavigationCommand(command: string | undefined): boolean {
	return commandIn(command, OPEN_NAVIGATION_COMMANDS);
}

export function isReadOnlyDiagnosticSessionTargetCommand(command: string | undefined, _subcommand?: string): boolean {
	return commandIn(command, READ_ONLY_DIAGNOSTIC_SESSION_TARGET_COMMANDS);
}

export function isSessionTabPinningExcludedCommand(command: string | undefined): boolean {
	return commandIn(command, SESSION_TAB_PINNING_EXCLUDED_COMMANDS);
}

export function isSessionTabPostCommandCorrectionExcludedCommand(command: string | undefined): boolean {
	return commandIn(command, SESSION_TAB_POST_COMMAND_CORRECTION_EXCLUDED_COMMANDS);
}

export function isRefInvalidatingBatchCommand(command: string | undefined): boolean {
	return (
		(isPageMutationCommand(command) && !commandIn(command, PAGE_MUTATION_REF_INVALIDATION_EXCEPTIONS)) ||
		commandIn(command, NON_MUTATION_REF_INVALIDATING_BATCH_COMMANDS)
	);
}

export function isRefGuardedCommand(command: string | undefined): boolean {
	return commandIn(command, REF_GUARDED_COMMANDS);
}

export function isElectronPostCommandHealthCommand(command: string | undefined): boolean {
	return commandIn(command, ELECTRON_POST_COMMAND_HEALTH_COMMANDS);
}

export function isNavigationObservableCommandName(command: string | undefined): boolean {
	return commandIn(command, NAVIGATION_OBSERVABLE_COMMANDS);
}

export function isPageMutationCommand(command: string | undefined): boolean {
	return commandIn(command, PAGE_MUTATION_COMMANDS);
}

export function isPageChangeSummaryCommand(command: string | undefined): boolean {
	return commandIn(command, PAGE_CHANGE_SUMMARY_COMMANDS);
}
