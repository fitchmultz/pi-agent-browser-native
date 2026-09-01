import { buildAgentBrowserNextActions } from "./action-recommendations.js";
import { type AgentBrowserNextAction, withOptionalSessionArgs } from "./next-actions.js";

export interface TabRecoveryCorrection {
	selectedTab?: string;
	targetTitle?: string;
	targetUrl?: string;
}

export interface TabRecoveryTarget {
	title?: string;
	url?: string;
}

export function buildConnectedSessionNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	if (!sessionName) return [];
	return buildAgentBrowserNextActions({
		recovery: { kind: "connected-session", sessionName },
		resultCategory: "success",
		successCategory: "completed",
	}) ?? [];
}

export function buildNoActivePageNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	if (!sessionName) return [];
	return buildAgentBrowserNextActions({
		recovery: { kind: "no-active-page", sessionName },
		resultCategory: "failure",
	}) ?? [];
}

export function buildPendingWebMcpNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	return [{
		id: "verify-page-target-after-pending-webmcp",
		params: { args: withOptionalSessionArgs(sessionName, ["get", "url"]) },
		reason: "Verify the current page target before taking a fresh snapshot; use webmcp result or cancel to settle the detached invocation.",
		safety: "Read-only URL inspection. It does not settle the pending page tool, which may still mutate or navigate later.",
		tool: "agent_browser",
	}];
}

export function buildSessionTabRecoveryNextActions(options: {
	kind: "about-blank" | "tab-drift";
	recoveryApplied?: boolean;
	resultCategory?: "failure" | "success";
	sessionName?: string;
	tabCorrection?: TabRecoveryCorrection;
	target?: TabRecoveryTarget;
}): AgentBrowserNextAction[] {
	const resultCategory = options.resultCategory ?? "success";
	return buildAgentBrowserNextActions({
		recovery: {
			kind: options.kind,
			recoveryApplied: options.recoveryApplied,
			selectedTab: options.tabCorrection?.selectedTab,
			sessionName: options.sessionName,
			targetTitle: options.tabCorrection?.targetTitle ?? options.target?.title,
			targetUrl: options.tabCorrection?.targetUrl ?? options.target?.url,
		},
		resultCategory,
		successCategory: resultCategory === "success" ? "completed" : undefined,
	}) ?? [];
}

export function buildSessionAwareStaleRefNextActions(sessionName: string | undefined): AgentBrowserNextAction[] {
	return (buildAgentBrowserNextActions({ failureCategory: "stale-ref", resultCategory: "failure" }) ?? []).map((action) => {
		const actionArgs = action.params?.args;
		return {
			...action,
			params: action.params && actionArgs ? { ...action.params, args: withOptionalSessionArgs(sessionName, actionArgs) } : action.params,
		};
	});
}
