import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import { extractExplicitSessionName, getAgentBrowserSessionIdentityKey, resolveAgentBrowserNamespace, scanUpstreamGlobalFlagOccurrences } from "./argv-grammar.js";
import { getExplicitReadUrl } from "./command-policy.js";
import { isCloseCommand } from "./command-taxonomy.js";
import { getExplicitNavigationTarget } from "./page-target-validation.js";
import { isRecord } from "./parsing.js";
import { getUpstreamEffectiveBatchSteps } from "./orchestration/batch-stdin.js";
import type { AgentBrowserNextAction } from "./results/contracts.js";

// Extend the existing observation with compact native provenance, never original argv or command replay.
export interface ReadConfirmation {
	capabilities?: { readRequiresConfirmation: true };
	id: string;
	namespace?: string;
	sessionName: string;
	source: "native-explicit-url-read" | "native-guarded-action";
	command?: string;
	action?: string;
	state: "pending" | "cleared";
	refSnapshotFresh?: true;
}

export function parseReadConfirmation(value: unknown): ReadConfirmation | undefined {
	if (!isRecord(value) || (value.source !== "native-explicit-url-read" && value.source !== "native-guarded-action") || (value.state !== "pending" && value.state !== "cleared")) return undefined;
	if (typeof value.id !== "string" || !value.id || typeof value.sessionName !== "string" || !value.sessionName || (value.namespace !== undefined && typeof value.namespace !== "string")) return undefined;
	if (value.source === "native-guarded-action" && (typeof value.command !== "string" || !value.command || typeof value.action !== "string" || !value.action)) return undefined;
	return { ...(value.source === "native-explicit-url-read" && isRecord(value.capabilities) && value.capabilities.readRequiresConfirmation === true ? { capabilities: { readRequiresConfirmation: true as const } } : {}), id: value.id, sessionName: value.sessionName, namespace: value.namespace, source: value.source, state: value.state,
		...(value.source === "native-guarded-action" ? { command: typeof value.command === "string" ? value.command : undefined, action: typeof value.action === "string" ? value.action : undefined } : {}),
		...(value.source === "native-guarded-action" && value.state === "cleared" && value.command === "snapshot" && value.action === "snapshot" && value.refSnapshotFresh === true ? { refSnapshotFresh: true as const } : {}) };
}

export function isBrowserIndependentConfirmation(value?: ReadConfirmation): boolean {
	return value?.source === "native-explicit-url-read" && value.capabilities?.readRequiresConfirmation === true;
}

export function suppressConfirmationPageHelpers(value?: ReadConfirmation): boolean {
	return value?.state === "pending" && (value.source === "native-guarded-action" || isBrowserIndependentConfirmation(value));
}

export function isSuccessfulNativeConfirmedClose(commandTokens: string[], data: unknown): boolean {
	return commandTokens[0] === "confirm" && commandTokens.length === 2 && isRecord(data) && data.confirmed === true
		&& data.action === "close" && isRecord(data.result) && data.result.success === true
		&& isRecord(data.result.data) && data.result.data.closed === true;
}

export function findReadConfirmation(args: string[], confirmations: Iterable<ReadConfirmation>, namespace?: string, stdin?: string): ReadConfirmation | undefined {
	const command = extractUpstreamCommandTokens(args);
	const tokens = command[0] === "batch" ? getUpstreamEffectiveBatchSteps(command, stdin)[0] ?? [] : command;
	if (tokens.length !== 2 || !["confirm", "deny"].includes(tokens[0])) return undefined;
	const sessionName = extractExplicitSessionName(args);
	const effectiveNamespace = resolveAgentBrowserNamespace(args, namespace);
	const matches = [...confirmations].filter(value => value.state === "pending" && value.id === tokens[1]
		&& (command[0] !== "batch" || value.source === "native-guarded-action")
		&& (sessionName === undefined || getAgentBrowserSessionIdentityKey(sessionName, value.namespace) === getAgentBrowserSessionIdentityKey(value.sessionName, value.namespace))
		&& (effectiveNamespace === undefined || getAgentBrowserSessionIdentityKey(value.sessionName, effectiveNamespace) === getAgentBrowserSessionIdentityKey(value.sessionName, value.namespace)));
	return matches.length === 1 ? matches[0] : undefined;
}

export function scopeReadConfirmationArgs(args: string[], confirmation: ReadConfirmation): string[] {
	return [
		...(scanUpstreamGlobalFlagOccurrences(args, "--namespace").length === 0 ? ["--namespace", confirmation.namespace ?? ""] : []),
		...(extractExplicitSessionName(args) === undefined ? ["--session", confirmation.sessionName] : []),
		...args,
	];
}

export function getNativeTabContinuationGuidance(commandTokens: string[], data: unknown): string | undefined {
	if (commandTokens[0] !== "tab" || commandTokens[1] !== "new" || !isRecord(data)
		|| data.confirmation_required !== true || typeof data.confirmation_id !== "string" || !data.confirmation_id || data.action !== "tab_new"
		|| !Object.keys(data).every(key => ["confirmation_required", "confirmation_id", "action", "capabilities", "after_confirmation", "guidance"].includes(key))
		|| !Array.isArray(data.after_confirmation) || data.after_confirmation.length !== 2 || data.after_confirmation[0] !== "open"
		|| typeof data.after_confirmation[1] !== "string" || !data.after_confirmation[1]
		|| data.after_confirmation[1] !== getExplicitNavigationTarget(commandTokens)
		|| typeof data.guidance !== "string" || !data.guidance.trim()) return undefined;
	// Transport prose only: approval creates the tab; the continuation is never stored or executed.
	return data.guidance;
}

export function nextReadConfirmation(options: {
	commandTokens: string[];
	current?: ReadConfirmation;
	data: unknown;
	namespace?: string;
	sessionName: string;
	succeeded: boolean;
}): ReadConfirmation | undefined {
	const { commandTokens: tokens, current } = options;
	const settles = current?.state === "pending" && tokens.length === 2 && ["confirm", "deny"].includes(tokens[0]) && tokens[1] === current.id;
	const confirmed = settles && tokens[0] === "confirm" && isRecord(options.data) && options.data.confirmed === true
		&& options.data.action === (current.source === "native-explicit-url-read" ? "read" : current.action) && isRecord(options.data.result);
	const control = confirmed && isRecord(options.data) && isRecord(options.data.result) ? options.data.result.data : options.data;
	// Only native control fields and a validated tab transport continuation. Page output is never provenance.
	if (options.succeeded && isRecord(control) && !Array.isArray(control) && control.confirmation_required === true
		&& typeof control.confirmation_id === "string" && control.confirmation_id && typeof control.action === "string" && control.action
		&& (Object.keys(control).every(key => ["confirmation_required", "confirmation_id", "action", "capabilities"].includes(key))
			|| getNativeTabContinuationGuidance(tokens, control) !== undefined)) {
		const explicitRead = control.action === "read" && (typeof getExplicitReadUrl(tokens) === "string" || confirmed && current.source === "native-explicit-url-read");
		if (explicitRead) return { ...(isRecord(control.capabilities) && control.capabilities.readRequiresConfirmation === true ? { capabilities: { readRequiresConfirmation: true as const } } : {}), id: control.confirmation_id, namespace: options.namespace, sessionName: options.sessionName, source: "native-explicit-url-read", state: "pending" };
		if (tokens[0] && !["confirm", "deny"].includes(tokens[0]) || confirmed && current.source === "native-guarded-action") {
			return { id: control.confirmation_id, namespace: options.namespace, sessionName: options.sessionName, source: "native-guarded-action", command: confirmed ? current.command : tokens[0], action: control.action, state: "pending" };
		}
		if (current?.state === "pending") return { ...current, state: "cleared" };
	}
	return options.succeeded && current?.state === "pending" && (settles || isCloseCommand(tokens[0])) ? { ...current, state: "cleared" } : undefined;
}

export function buildReadConfirmationNextActions(confirmation: ReadConfirmation, pendingResponse: boolean): AgentBrowserNextAction[] {
	if (confirmation.state === "cleared") return [];
	const prefix = ["--namespace", confirmation.namespace ?? "", "--session", confirmation.sessionName];
	if (!pendingResponse) return [{ id: "inspect-read-confirmation-session", tool: "agent_browser", params: { args: [...prefix, "session", "info"] }, reason: "Inspect the exact native session after the confirmation failed; rerun the original command if its ID expired.", safety: "Read-only status, without browser launch or tab changes. Do not substitute a different pending confirmation ID." }];
	return ["confirm", "deny"].map(command => ({
		id: command === "confirm" ? "approve-confirmation" : "deny-confirmation", tool: "agent_browser", params: { args: [...prefix, command, confirmation.id] },
		reason: `${command === "confirm" ? "Approve" : "Deny"} the native confirmation for ${confirmation.source === "native-explicit-url-read" ? "this explicit URL read" : `${confirmation.command} (${confirmation.action})`}.`,
		safety: isBrowserIndependentConfirmation(confirmation)
			? "Review the requested read first. The native capability proves ID matching; no DOM confirmation is implied."
			: confirmation.source === "native-guarded-action"
				? "Review the original guarded action. Exact wrapper observation preserves its session and avoids overwriting helpers; native ID validation is not implied."
				: "Native ID matching/browser independence is unproven. The exact native session is preserved, but this confirmation retains normal page checks.",
	}));
}
