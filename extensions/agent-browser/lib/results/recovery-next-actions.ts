import { buildAgentBrowserNextActions } from "./action-recommendations.js";
import { type AgentBrowserNextAction, withOptionalSessionArgs } from "./next-actions.js";
import type { AgentBrowserRecoveryContext } from "./action-contracts.js";

export interface TabRecoveryCorrection {
	readonly selectedTab?: string;
	readonly targetTitle?: string | undefined;
	readonly targetUrl?: string;
}

export interface TabRecoveryTarget {
	readonly title?: string | undefined;
	readonly url?: string;
}

export function buildConnectedSessionNextActions(
	sessionName: string | undefined,
): readonly AgentBrowserNextAction[] {
	if ((sessionName ?? "") === "") {
		return [];
	}
	return (
		buildAgentBrowserNextActions({
			recovery: { kind: "connected-session", sessionName },
			resultCategory: "success",
			successCategory: "completed",
		}) ?? []
	);
}

export function buildNoActivePageNextActions(
	sessionName: string | undefined,
): readonly AgentBrowserNextAction[] {
	if ((sessionName ?? "") === "") {
		return [];
	}
	return (
		buildAgentBrowserNextActions({
			recovery: { kind: "no-active-page", sessionName },
			resultCategory: "failure",
		}) ?? []
	);
}

export function buildPendingWebMcpNextActions(
	sessionName: string | undefined,
): readonly AgentBrowserNextAction[] {
	return [
		{
			id: "verify-page-target-after-pending-webmcp",
			params: { args: withOptionalSessionArgs(sessionName, ["get", "url"]) },
			reason:
				"Verify the current page target before taking a fresh snapshot; use webmcp result or cancel to settle the detached invocation.",
			safety:
				"Read-only URL inspection. It does not settle the pending page tool, which may still mutate or navigate later.",
			tool: "agent_browser",
		},
	];
}

interface SessionTabRecoveryOptions {
	readonly kind: "about-blank" | "tab-drift";
	readonly recoveryApplied?: boolean;
	readonly resultCategory?: "failure" | "success";
	readonly sessionName?: string | undefined;
	readonly tabCorrection?: TabRecoveryCorrection | undefined;
	readonly target?: TabRecoveryTarget | undefined;
}

function getSessionTabRecoveryContext(
	options: SessionTabRecoveryOptions,
): AgentBrowserRecoveryContext {
	return {
		kind: options.kind,
		recoveryApplied: options.recoveryApplied,
		selectedTab: options.tabCorrection?.selectedTab,
		sessionName: options.sessionName,
		targetTitle: options.tabCorrection?.targetTitle ?? options.target?.title,
		targetUrl: options.tabCorrection?.targetUrl ?? options.target?.url,
	};
}

export function buildSessionTabRecoveryNextActions(
	options: SessionTabRecoveryOptions,
): readonly AgentBrowserNextAction[] {
	const resultCategory = options.resultCategory ?? "success";
	return (
		buildAgentBrowserNextActions({
			recovery: getSessionTabRecoveryContext(options),
			resultCategory,
			successCategory: resultCategory === "success" ? "completed" : undefined,
		}) ?? []
	);
}

export function buildSessionAwareStaleRefNextActions(
	sessionName: string | undefined,
): readonly AgentBrowserNextAction[] {
	return (
		buildAgentBrowserNextActions({ failureCategory: "stale-ref", resultCategory: "failure" }) ?? []
	).map((action) => {
		const actionArgs = action.params?.args;
		return Object.assign({}, action, {
			params:
				action.params && actionArgs
					? { ...action.params, args: withOptionalSessionArgs(sessionName, actionArgs) }
					: action.params,
		});
	});
}
