type CommandCapabilityFlag =
	| "closesSession"
	| "openNavigation"
	| "readOnlyDiagnosticSessionTarget"
	| "excludedFromPinning"
	| "excludedFromPostCommandCorrection"
	| "guardsPageRefs"
	| "invalidatesBatchRefs"
	| "eligibleForElectronHealthProbe"
	| "navigationObservable"
	| "triggersPostMutationSnapshot"
	| "eligibleForPageChangeSummary";

interface CommandCapabilityEntry extends Partial<Record<CommandCapabilityFlag, true>> {
	aliases?: readonly string[];
	command: string;
}

const ADDITIONAL_COMMAND_TOKENS = [
	"a11y", "auth", "chat", "clipboard", "confirm", "connect", "dashboard", "deny", "device", "dialog", "diff", "doctor", "errors", "eval", "find", "frame", "get", "highlight", "inspect", "install", "is", "mcp", "plugin", "plugins", "profiles", "profiler", "react", "record", "removeinitscript", "session", "set", "skills", "snapshot", "state", "stream", "trace", "upgrade", "vitals", "wait", "web-vitals", "webmcp", "window",
] as const;

const WEBMCP_PAGE_MUTATION_SUBCOMMANDS = new Set(["invoke", "result", "cancel"]);

const COMMAND_CAPABILITIES: readonly CommandCapabilityEntry[] = [
	{
		command: "back",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		invalidatesBatchRefs: true,
		navigationObservable: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "batch",
		excludedFromPostCommandCorrection: true,
	},
	{
		command: "check",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "click",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		navigationObservable: true,
		triggersPostMutationSnapshot: true,
	},
	{
		aliases: ["quit", "exit"],
		closesSession: true,
		command: "close",
		excludedFromPinning: true,
		excludedFromPostCommandCorrection: true,
	},
	{
		command: "console",
		readOnlyDiagnosticSessionTarget: true,
	},
	{
		command: "cookies",
		readOnlyDiagnosticSessionTarget: true,
	},
	{
		command: "dblclick",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		navigationObservable: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "dialog",
		eligibleForPageChangeSummary: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "diff",
		guardsPageRefs: true,
	},
	{
		command: "download",
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
	},
	{
		command: "drag",
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
	},
	{
		command: "errors",
		readOnlyDiagnosticSessionTarget: true,
	},
	{
		command: "eval",
		invalidatesBatchRefs: true,
		navigationObservable: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "fill",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "find",
		eligibleForElectronHealthProbe: true,
	},
	{
		command: "frame",
		guardsPageRefs: true,
	},
	{
		command: "focus",
		guardsPageRefs: true,
	},
	{
		command: "forward",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		invalidatesBatchRefs: true,
		navigationObservable: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "get",
		guardsPageRefs: true,
	},
	{
		command: "highlight",
		guardsPageRefs: true,
	},
	{
		command: "hover",
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "is",
		guardsPageRefs: true,
	},
	{
		command: "keydown",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "keyboard",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "keyup",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "mouse",
		eligibleForElectronHealthProbe: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
	},
	{
		command: "network",
		readOnlyDiagnosticSessionTarget: true,
	},
	{
		aliases: ["goto", "navigate"],
		command: "open",
		eligibleForPageChangeSummary: true,
		excludedFromPinning: true,
		invalidatesBatchRefs: true,
		openNavigation: true,
	},
	{
		command: "pdf",
		eligibleForPageChangeSummary: true,
	},
	{
		aliases: ["key"],
		command: "press",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "pushstate",
		eligibleForPageChangeSummary: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "reload",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		invalidatesBatchRefs: true,
		navigationObservable: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "read",
		readOnlyDiagnosticSessionTarget: true,
	},
	{
		command: "screenshot",
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
	},
	{
		command: "scroll",
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		aliases: ["scrollinto"],
		command: "scrollintoview",
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "select",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "session",
		excludedFromPinning: true,
		excludedFromPostCommandCorrection: true,
	},
	{
		command: "storage",
		readOnlyDiagnosticSessionTarget: true,
	},
	{
		command: "swipe",
		eligibleForPageChangeSummary: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "tab",
		excludedFromPinning: true,
		excludedFromPostCommandCorrection: true,
	},
	{
		command: "tap",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "type",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "uncheck",
		eligibleForElectronHealthProbe: true,
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
	},
	{
		command: "upload",
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
	},
];

const COMMAND_CAPABILITY_BY_NAME = new Map<string, CommandCapabilityEntry>();
for (const entry of COMMAND_CAPABILITIES) {
	COMMAND_CAPABILITY_BY_NAME.set(entry.command, entry);
	for (const alias of entry.aliases ?? []) {
		COMMAND_CAPABILITY_BY_NAME.set(alias, entry);
	}
}

const KNOWN_COMMAND_TOKENS: ReadonlySet<string> = new Set([...COMMAND_CAPABILITY_BY_NAME.keys(), ...ADDITIONAL_COMMAND_TOKENS]);

export function isKnownCommandToken(token: string): boolean {
	return KNOWN_COMMAND_TOKENS.has(token);
}

function getCommandCapability(command: string | undefined): CommandCapabilityEntry | undefined {
	return command === undefined ? undefined : COMMAND_CAPABILITY_BY_NAME.get(command);
}

function hasCommandCapability(command: string | undefined, capability: CommandCapabilityFlag): boolean {
	return getCommandCapability(command)?.[capability] === true;
}

export function normalizeCommandName(command: string | undefined): string | undefined {
	return getCommandCapability(command)?.command ?? command;
}

export function isCloseCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "closesSession");
}

export function isCloseAllCommand(commandTokens: readonly string[]): boolean {
	return isCloseCommand(commandTokens[0]) && commandTokens.slice(1).includes("--all");
}

export function isOpenNavigationCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "openNavigation");
}

export function isReadOnlyDiagnosticSessionTargetCommand(command: string | undefined, subcommand?: string): boolean {
	return hasCommandCapability(command, "readOnlyDiagnosticSessionTarget") || (command === "webmcp" && subcommand === "list");
}

export function isSessionTabPinningExcludedCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "excludedFromPinning");
}

export function isSessionTabPostCommandCorrectionExcludedCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "excludedFromPostCommandCorrection");
}

/** Upstream 0.33.2 record start swaps to a fresh active page before its already-active check, so even a failed start can replace the page; record restart navigates the current page only when a URL operand (any fourth token, mirroring upstream's positional slot) is present. */
export function isRecordPageTransitionCommand(tokens: readonly string[]): boolean {
	if (tokens[0] !== "record") return false;
	if (tokens[1] === "start") return true;
	return tokens[1] === "restart" && tokens.length >= 4;
}

export function isWebMcpPageMutationCommand(tokens: readonly string[]): boolean {
	return isWebMcpPageMutation(tokens[0], tokens[1]);
}

export function isRefInvalidatingBatchCommand(step: readonly string[]): boolean {
	return hasCommandCapability(step[0], "invalidatesBatchRefs") || isRecordPageTransitionCommand(step) || isWebMcpPageMutationCommand(step);
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

export function isNavigationObservableCommandName(command: string | undefined, subcommand?: string): boolean {
	return hasCommandCapability(command, "navigationObservable") || isWebMcpPageMutation(command, subcommand);
}

export function isUnverifiedPageTransitionCommand(command: string | undefined, subcommand?: string): boolean {
	return ["back", "connect", "eval", "forward", "reload"].includes(command ?? "")
		|| (command === "state" && subcommand === "load")
		|| (command === "tab" && subcommand !== undefined && !["list", "new"].includes(subcommand))
		|| isWebMcpPageMutation(command, subcommand);
}

export function isPageMutationCommand(command: string | undefined, subcommand?: string): boolean {
	return hasCommandCapability(command, "triggersPostMutationSnapshot") || isWebMcpPageMutation(command, subcommand);
}

export function isPageChangeSummaryCommand(command: string | undefined, subcommand?: string): boolean {
	return hasCommandCapability(command, "eligibleForPageChangeSummary") || isWebMcpPageMutation(command, subcommand);
}
