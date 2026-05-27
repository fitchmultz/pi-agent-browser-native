/**
 * Purpose: Centralize upstream agent-browser command capabilities that wrapper behavior depends on.
 * Responsibilities: Normalize command aliases once and expose capability predicates for runtime planning,
 * session/ref guards, result recommendations, and presentation summaries without coupling unrelated behaviors.
 * Scope: Static command capability taxonomy only; command-shape parsing, spawning, and formatting live elsewhere.
 */

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
		command: "hover",
		eligibleForPageChangeSummary: true,
		guardsPageRefs: true,
		invalidatesBatchRefs: true,
		triggersPostMutationSnapshot: true,
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
		command: "screenshot",
		eligibleForPageChangeSummary: true,
	},
	{
		command: "scroll",
		eligibleForPageChangeSummary: true,
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

export function isOpenNavigationCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "openNavigation");
}

export function isReadOnlyDiagnosticSessionTargetCommand(command: string | undefined, _subcommand?: string): boolean {
	return hasCommandCapability(command, "readOnlyDiagnosticSessionTarget");
}

export function isSessionTabPinningExcludedCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "excludedFromPinning");
}

export function isSessionTabPostCommandCorrectionExcludedCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "excludedFromPostCommandCorrection");
}

export function isRefInvalidatingBatchCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "invalidatesBatchRefs");
}

export function isRefGuardedCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "guardsPageRefs");
}

export function isElectronPostCommandHealthCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "eligibleForElectronHealthProbe");
}

export function isNavigationObservableCommandName(command: string | undefined): boolean {
	return hasCommandCapability(command, "navigationObservable");
}

export function isPageMutationCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "triggersPostMutationSnapshot");
}

export function isPageChangeSummaryCommand(command: string | undefined): boolean {
	return hasCommandCapability(command, "eligibleForPageChangeSummary");
}
