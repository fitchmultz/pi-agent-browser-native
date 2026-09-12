import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import { extractExplicitSessionName, getAgentBrowserSessionIdentityKey, resolveAgentBrowserNamespace, scanUpstreamGlobalFlagOccurrences } from "./argv-grammar.js";
import { getExplicitReadUrl } from "./command-policy.js";
import { isCloseCommand } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";
import type { AgentBrowserNextAction } from "./results/contracts.js";

export interface ReadConfirmation {
	capabilities?: { readRequiresConfirmation: true };
	id: string;
	namespace?: string;
	sessionName: string;
	source: "native-explicit-url-read";
	state: "pending" | "cleared";
}

export function parseReadConfirmation(value: unknown): ReadConfirmation | undefined {
	if (!isRecord(value) || value.source !== "native-explicit-url-read" || (value.state !== "pending" && value.state !== "cleared")) return undefined;
	if (typeof value.id !== "string" || !value.id || typeof value.sessionName !== "string" || !value.sessionName || (value.namespace !== undefined && typeof value.namespace !== "string")) return undefined;
	return { ...(isRecord(value.capabilities) && value.capabilities.readRequiresConfirmation === true ? { capabilities: { readRequiresConfirmation: true as const } } : {}), id: value.id, sessionName: value.sessionName, namespace: value.namespace, source: "native-explicit-url-read", state: value.state };
}

export function findReadConfirmation(args: string[], confirmations: Iterable<ReadConfirmation>, namespace?: string): ReadConfirmation | undefined {
	const tokens = extractUpstreamCommandTokens(args);
	if (tokens.length !== 2 || !["confirm", "deny"].includes(tokens[0])) return undefined;
	const sessionName = extractExplicitSessionName(args);
	const effectiveNamespace = resolveAgentBrowserNamespace(args, namespace);
	const matches = [...confirmations].filter(value => value.state === "pending" && value.id === tokens[1]
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

export function nextReadConfirmation(options: {
	commandTokens: string[];
	current?: ReadConfirmation;
	data: unknown;
	namespace?: string;
	sessionName: string;
	succeeded: boolean;
}): ReadConfirmation | undefined {
	const { commandTokens: tokens, current } = options;
	const settlesRead = current?.state === "pending" && tokens.length === 2 && ["confirm", "deny"].includes(tokens[0]) && tokens[1] === current.id;
	const confirmedResult = settlesRead && tokens[0] === "confirm" && isRecord(options.data) && options.data.confirmed === true && options.data.action === "read" && isRecord(options.data.result)
		? options.data.result.data : options.data;
	// Native control fields only. Never parse response content, snapshot text or nested page JSON as provenance.
	if (isRecord(confirmedResult) && confirmedResult.confirmation_required === true && typeof confirmedResult.confirmation_id === "string" && confirmedResult.confirmation_id && !("content" in confirmedResult)) {
		if (confirmedResult.action === "read" && (typeof getExplicitReadUrl(tokens) === "string" || settlesRead)) {
			return { ...(isRecord(confirmedResult.capabilities) && confirmedResult.capabilities.readRequiresConfirmation === true ? { capabilities: { readRequiresConfirmation: true as const } } : {}), id: confirmedResult.confirmation_id, namespace: options.namespace, sessionName: options.sessionName, source: "native-explicit-url-read", state: "pending" };
		}
		if (current?.state === "pending") return { ...current, state: "cleared" };
	}
	return options.succeeded && current?.state === "pending" && (settlesRead || isCloseCommand(tokens[0])) ? { ...current, state: "cleared" } : undefined;
}

export function buildReadConfirmationNextActions(confirmation: ReadConfirmation, pendingResponse: boolean): AgentBrowserNextAction[] {
	if (confirmation.state === "cleared") return [];
	const prefix = ["--namespace", confirmation.namespace ?? "", "--session", confirmation.sessionName];
	if (!pendingResponse) return [{ id: "inspect-read-confirmation-session", tool: "agent_browser", params: { args: [...prefix, "session", "info"] }, reason: "Inspect the exact native session after the read confirmation failed; rerun the original URL read if its ID expired.", safety: "Read-only status, without browser launch or tab changes. Do not substitute a different pending confirmation ID." }];
	return ["confirm", "deny"].map(command => ({
		id: command === "confirm" ? "approve-confirmation" : "deny-confirmation", tool: "agent_browser", params: { args: [...prefix, command, confirmation.id] },
		reason: `${command === "confirm" ? "Approve" : "Deny"} the native confirmation for this explicit URL read.`,
		safety: confirmation.capabilities?.readRequiresConfirmation === true
			? "Review the requested read first. The native capability proves ID matching; no DOM confirmation is implied."
			: "Native ID matching/browser independence is unproven. The exact native session is preserved, but this confirmation retains normal page checks.",
	}));
}
