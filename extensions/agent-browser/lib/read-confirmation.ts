import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import {
	extractExplicitSessionName,
	getAgentBrowserSessionIdentityKey,
	resolveAgentBrowserNamespace,
	scanUpstreamGlobalFlagOccurrences,
} from "./argv-grammar.js";
import { getExplicitReadUrl } from "./command-policy.js";
import { isCloseCommand } from "./command-taxonomy.js";
import { getUpstreamEffectiveBatchSteps } from "./orchestration/batch-stdin.js";
import {
	getConfirmedNativeResult,
	getNativePendingControl,
	type NativePendingConfirmation,
} from "./native-confirmation.js";
import type { ReadConfirmation } from "./results/evidence-contracts.js";
import type { AgentBrowserNextAction } from "./results/next-actions.js";
export type { ReadConfirmation } from "./results/evidence-contracts.js";
export {
	parseReadConfirmation,
	getNativeTabContinuationGuidance,
	isSuccessfulNativeConfirmedClose,
} from "./native-confirmation.js";

export function isBrowserIndependentConfirmation(value?: ReadConfirmation): boolean {
	return (
		value?.source === "native-explicit-url-read" &&
		value.capabilities?.readRequiresConfirmation === true
	);
}

export function suppressConfirmationPageHelpers(value?: ReadConfirmation): boolean {
	return (
		value?.state === "pending" &&
		(value.source === "native-guarded-action" || isBrowserIndependentConfirmation(value))
	);
}

export function findReadConfirmation(
	args: readonly string[],
	// lib.es2015.iterable.d.ts exposes a mutable iterator cursor; only deeply readonly confirmation values are consumed.
	confirmations: Iterable<ReadConfirmation>,
	namespace?: string,
	stdin?: string,
): ReadConfirmation | undefined {
	const command = extractUpstreamCommandTokens(args);
	const tokens =
		command[0] === "batch" ? (getUpstreamEffectiveBatchSteps(command, stdin)[0] ?? []) : command;
	if (tokens.length !== 2 || !["confirm", "deny"].includes(tokens[0] ?? "")) {
		return undefined;
	}
	const sessionName = extractExplicitSessionName(args);
	const effectiveNamespace = resolveAgentBrowserNamespace(args, namespace);
	const matches = [...confirmations].filter(
		(value) =>
			value.state === "pending" &&
			value.id === tokens[1] &&
			(command[0] !== "batch" || value.source === "native-guarded-action") &&
			(sessionName === undefined ||
				getAgentBrowserSessionIdentityKey(sessionName, value.namespace) ===
					getAgentBrowserSessionIdentityKey(value.sessionName, value.namespace)) &&
			(effectiveNamespace === undefined ||
				getAgentBrowserSessionIdentityKey(value.sessionName, effectiveNamespace) ===
					getAgentBrowserSessionIdentityKey(value.sessionName, value.namespace)),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

export function scopeReadConfirmationArgs(
	args: readonly string[],
	confirmation: ReadConfirmation,
): string[] {
	return [
		...(scanUpstreamGlobalFlagOccurrences(args, "--namespace").length === 0
			? ["--namespace", confirmation.namespace ?? ""]
			: []),
		...(extractExplicitSessionName(args) === undefined
			? ["--session", confirmation.sessionName]
			: []),
		...args,
	];
}

function isExplicitReadProvenance(
	pending: NativePendingConfirmation,
	tokens: readonly string[],
	confirmed?: ReadConfirmation,
): boolean {
	return (
		pending.action === "read" &&
		(typeof getExplicitReadUrl(tokens) === "string" ||
			confirmed?.source === "native-explicit-url-read")
	);
}

function isOriginalGuardedAction(command: string | undefined): boolean {
	return command !== undefined && command.length > 0 && !["confirm", "deny"].includes(command);
}

function pendingConfirmation(
	pending: NativePendingConfirmation,
	tokens: readonly string[],
	identity: {
		readonly namespace?: string | undefined;
		readonly sessionName: string;
		readonly confirmed?: ReadConfirmation | undefined;
	},
): ReadConfirmation | undefined {
	if (isExplicitReadProvenance(pending, tokens, identity.confirmed)) {
		return {
			...(pending.capabilities !== undefined ? { capabilities: pending.capabilities } : {}),
			id: pending.id,
			namespace: identity.namespace,
			sessionName: identity.sessionName,
			source: "native-explicit-url-read",
			state: "pending",
		};
	}
	const command = tokens.at(0);
	if (isOriginalGuardedAction(command) || identity.confirmed?.source === "native-guarded-action") {
		return {
			id: pending.id,
			namespace: identity.namespace,
			sessionName: identity.sessionName,
			source: "native-guarded-action",
			command: identity.confirmed !== undefined ? identity.confirmed.command : command,
			action: pending.action,
			state: "pending",
		};
	}
	return undefined;
}

function settlesPendingConfirmation(
	tokens: readonly string[],
	current?: ReadConfirmation,
): boolean {
	return (
		current?.state === "pending" &&
		tokens.length === 2 &&
		["confirm", "deny"].includes(tokens[0] ?? "") &&
		tokens[1] === current.id
	);
}

function confirmedDecisionResult(
	tokens: readonly string[],
	current: ReadConfirmation | undefined,
	data: unknown,
): Readonly<Record<string, unknown>> | undefined {
	if (
		tokens[0] !== "confirm" ||
		current === undefined ||
		!settlesPendingConfirmation(tokens, current)
	) {
		return undefined;
	}
	return getConfirmedNativeResult(data, current);
}

function clearedConfirmation(
	current: ReadConfirmation | undefined,
	command: string | undefined,
	succeeded: boolean,
	settles: boolean,
): ReadConfirmation | undefined {
	return succeeded && current?.state === "pending" && (settles || isCloseCommand(command))
		? { ...current, state: "cleared" }
		: undefined;
}

export function nextReadConfirmation(options: {
	readonly commandTokens: readonly string[];
	readonly current?: ReadConfirmation | undefined;
	readonly data: unknown;
	readonly namespace?: string | undefined;
	readonly sessionName: string;
	readonly succeeded: boolean;
}): ReadConfirmation | undefined {
	const { commandTokens: tokens, current } = options;
	const settles = settlesPendingConfirmation(tokens, current);
	const confirmedResult = confirmedDecisionResult(tokens, current, options.data);
	const pending = options.succeeded
		? getNativePendingControl(
				tokens,
				confirmedResult !== undefined ? confirmedResult.data : options.data,
			)
		: undefined;
	if (pending !== undefined) {
		const next = pendingConfirmation(pending, tokens, {
			namespace: options.namespace,
			sessionName: options.sessionName,
			confirmed: confirmedResult !== undefined ? current : undefined,
		});
		if (next !== undefined) {
			return next;
		}
		if (current?.state === "pending") {
			return { ...current, state: "cleared" };
		}
	}
	return clearedConfirmation(current, tokens[0], options.succeeded, settles);
}

function confirmationSafety(confirmation: ReadConfirmation): string {
	if (isBrowserIndependentConfirmation(confirmation)) {
		return "Review the requested read first. The native capability proves ID matching; no DOM confirmation is implied.";
	}
	return confirmation.source === "native-guarded-action"
		? "Review the original guarded action. Exact wrapper observation preserves its session and avoids overwriting helpers; native ID validation is not implied."
		: "Native ID matching/browser independence is unproven. The exact native session is preserved, but this confirmation retains normal page checks.";
}

export function buildReadConfirmationNextActions(
	confirmation: ReadConfirmation,
	pendingResponse: boolean,
): AgentBrowserNextAction[] {
	if (confirmation.state === "cleared") {
		return [];
	}
	const prefix = [
		"--namespace",
		confirmation.namespace ?? "",
		"--session",
		confirmation.sessionName,
	];
	if (!pendingResponse) {
		return [
			{
				id: "inspect-read-confirmation-session",
				tool: "agent_browser",
				params: { args: [...prefix, "session", "info"] },
				reason:
					"Inspect the exact native session after the confirmation failed; rerun the original command if its ID expired.",
				safety:
					"Read-only status, without browser launch or tab changes. Do not substitute a different pending confirmation ID.",
			},
		];
	}
	const subject =
		confirmation.source === "native-explicit-url-read"
			? "this explicit URL read"
			: `${confirmation.command ?? ""} (${confirmation.action ?? ""})`;
	return ["confirm", "deny"].map((command) => ({
		id: command === "confirm" ? "approve-confirmation" : "deny-confirmation",
		tool: "agent_browser",
		params: { args: [...prefix, command, confirmation.id] },
		reason: `${command === "confirm" ? "Approve" : "Deny"} the native confirmation for ${subject}.`,
		safety: confirmationSafety(confirmation),
	}));
}
