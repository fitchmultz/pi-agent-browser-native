/**
 * Purpose: Centralize recovery-oriented nextAction ids and action construction.
 * Responsibilities: Build tab/about:blank/no-active-page/connected-session follow-ups and rich-input recovery ids.
 * Scope: Recovery action contracts only; result category classification and artifact follow-ups live elsewhere.
 * Usage: Imported by shared result action builders and the extension entrypoint.
 * Invariants/Assumptions: Ids are public machine-readable contracts mirrored by docs and tests.
 */

import { buildNextToolAction, type AgentBrowserNextAction, withOptionalSessionArgs } from "./next-actions.js";

export type AgentBrowserRecoveryKind = "about-blank" | "connected-session" | "no-active-page" | "tab-drift";

export interface AgentBrowserRecoveryContext {
	kind: AgentBrowserRecoveryKind;
	recoveryApplied?: boolean;
	selectedTab?: string;
	sessionName?: string;
	targetTitle?: string;
	targetUrl?: string;
}

export const AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS = {
	aboutBlankListTabs: "list-tabs-for-about-blank-recovery",
	connectedSessionListTabs: "list-connected-session-tabs",
	genericTabDriftListTabs: "list-tabs-for-recovery",
	noActivePageListTabs: "list-tabs-after-no-active-page",
	selectIntendedTabAfterDrift: "select-intended-tab-after-drift",
	snapshotAfterTabRecovery: "snapshot-after-tab-recovery",
	tabDriftListTabs: "list-tabs-for-tab-drift-recovery",
} as const;

export const AGENT_BROWSER_RICH_INPUT_RECOVERY_NEXT_ACTION_IDS = {
	click: "click-current-editable-ref",
	focus: "focus-current-editable-ref",
} as const;

export type AgentBrowserRichInputRecoveryNextActionKind = keyof typeof AGENT_BROWSER_RICH_INPUT_RECOVERY_NEXT_ACTION_IDS;

function getNumberedAgentBrowserNextActionId(baseId: string, index: number, total: number): string {
	return total > 1 ? `${baseId}-${index + 1}` : baseId;
}

export function getAgentBrowserRichInputRecoveryNextActionId(kind: AgentBrowserRichInputRecoveryNextActionKind, index: number, candidateCount: number): string {
	return getNumberedAgentBrowserNextActionId(AGENT_BROWSER_RICH_INPUT_RECOVERY_NEXT_ACTION_IDS[kind], index, candidateCount);
}

export function getAgentBrowserRichInputRecoveryNextActionIds(candidateCount: number): string[] {
	const ids: string[] = [];
	for (let index = 0; index < candidateCount; index += 1) {
		ids.push(
			getAgentBrowserRichInputRecoveryNextActionId("focus", index, candidateCount),
			getAgentBrowserRichInputRecoveryNextActionId("click", index, candidateCount),
		);
	}
	return ids;
}

function getRecoveryTargetDescription(recovery: AgentBrowserRecoveryContext): string {
	const target = [recovery.targetTitle, recovery.targetUrl].filter((item): item is string => item !== undefined && item.length > 0).join(" at ");
	return target.length > 0 ? target : "the intended tab";
}

function isStableTabId(tab: string | undefined): tab is string {
	return /^t\d+$/.test(tab ?? "");
}

function buildTabSnapshotRecoveryAction(options: {
	id: string;
	reason: string;
	recovery: AgentBrowserRecoveryContext;
	safety: string;
	sessionArgs: (args: string[]) => string[];
	tabId: string;
}): AgentBrowserNextAction {
	if (options.recovery.recoveryApplied === true) {
		return buildNextToolAction({
			args: options.sessionArgs(["snapshot", "-i"]),
			id: options.id,
			reason: options.reason,
			safety: options.safety,
		});
	}
	return buildNextToolAction({
		args: options.sessionArgs(["batch"]),
		id: options.id,
		reason: `${options.reason} The batch selects the stable tab before snapshotting.`,
		safety: `${options.safety} The snapshot retry is atomic with tab selection, so it does not assume the intended tab is already active.`,
		stdin: JSON.stringify([["tab", options.tabId], ["snapshot", "-i"]]),
	});
}

export function buildRecoveryNextActions(recovery: AgentBrowserRecoveryContext): AgentBrowserNextAction[] {
	const sessionArgs = (args: string[]) => withOptionalSessionArgs(recovery.sessionName, args);
	if (recovery.kind === "connected-session") {
		return [
			buildNextToolAction({
				args: sessionArgs(["tab", "list"]),
				id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.connectedSessionListTabs,
				reason: "Inspect tabs exposed by the connected CDP endpoint before assuming the app surface is active.",
				safety: "Read-only. Raw connect can succeed before the desktop app has an active rendered page.",
			}),
		];
	}
	if (recovery.kind === "no-active-page") {
		return [
			buildNextToolAction({
				args: sessionArgs(["tab", "list"]),
				id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.noActivePageListTabs,
				reason: "The snapshot found no active page; inspect the session tabs before retrying refs.",
				safety: "Read-only tab listing for the same connected session.",
			}),
		];
	}
	const targetDescription = getRecoveryTargetDescription(recovery);
	const listAction = buildNextToolAction({
		args: sessionArgs(["tab", "list"]),
		id: recovery.kind === "about-blank" ? AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.aboutBlankListTabs : AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabDriftListTabs,
		reason: `Inspect tabs for ${targetDescription} before continuing after tab drift.`,
		safety: "Read-only tab listing; prefer stable tN tab ids over positional tab guesses.",
	});
	if (!isStableTabId(recovery.selectedTab)) return [listAction];
	return [
		listAction,
		buildNextToolAction({
			args: sessionArgs(["tab", recovery.selectedTab]),
			id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.selectIntendedTabAfterDrift,
			reason: `Re-select ${targetDescription} with the stable tab id already observed by the wrapper.`,
			safety: "Switches only the active tab in this browser session; it does not mutate page content.",
		}),
		buildTabSnapshotRecoveryAction({
			id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.snapshotAfterTabRecovery,
			reason: "Refresh interactive refs on the recovered tab before using @e refs again.",
			recovery,
			safety: "Read-only snapshot. Treat previous refs as stale until this succeeds.",
			sessionArgs,
			tabId: recovery.selectedTab,
		}),
	];
}
