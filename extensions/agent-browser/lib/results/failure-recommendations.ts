import { isOpenNavigationCommand } from "../command-taxonomy.js";
import type { AgentBrowserNextAction } from "./action-contracts.js";
import { buildInspectOverlayStateAction, buildNextToolAction } from "./next-actions.js";
import type { AgentBrowserNextActionOptions } from "./recommendation-contracts.js";
import { AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS } from "./recovery-actions.js";
import { buildMissingArtifactNextActions } from "./artifact-recommendations.js";

function getExplicitDownloadWaitPath(args: readonly string[]): string | undefined {
	const candidate = args.at(args.indexOf("--download") + 1);
	return candidate !== undefined && candidate.length > 0 && !candidate.startsWith("-")
		? candidate
		: undefined;
}

function getDownloadRetryPath(
	args: readonly string[] | undefined,
	fallback: string | undefined,
): string | undefined {
	if (fallback !== undefined && fallback.length > 0) {
		return fallback;
	}
	if (!args || args.length === 0) {
		return undefined;
	}
	if (args.includes("--download")) {
		return getExplicitDownloadWaitPath(args);
	}
	const downloadCommandIndex = args.indexOf("download");
	return downloadCommandIndex >= 0 && args.length > downloadCommandIndex + 2
		? args.at(-1)
		: undefined;
}

function buildConfirmationActions(id: string | undefined): AgentBrowserNextAction[] {
	if (id === undefined || id.length === 0) {
		return [];
	}
	return [
		buildNextToolAction({
			args: ["confirm", id],
			id: "approve-confirmation",
			reason: "Approve the pending upstream confirmation when the requested action is safe.",
			safety: "Only confirm after reviewing the guarded action shown in the result.",
		}),
		buildNextToolAction({
			args: ["deny", id],
			id: "deny-confirmation",
			reason:
				"Deny the pending upstream confirmation when the guarded action is unsafe or unintended.",
		}),
	];
}

function buildDownloadFailureActions(
	options: AgentBrowserNextActionOptions,
): AgentBrowserNextAction[] {
	const path = getDownloadRetryPath(options.args, options.savedFilePath);
	return [
		buildNextToolAction({
			args:
				path !== undefined && path.length > 0
					? ["wait", "--download", path]
					: ["wait", "--download"],
			id: "wait-for-download",
			reason: "Wait for the browser download and let the wrapper verify saved-file metadata.",
			safety:
				"Use an explicit wait timeout; if you set top-level timeoutMs, keep it above the wait duration plus a small grace window.",
		}),
	];
}

function getTimeoutInspectionReason(command: string | undefined, textAssertion: boolean): string {
	if (textAssertion) {
		return "Inspect the current page after the text assertion failed before concluding the expected text is absent.";
	}
	return command === "wait"
		? "Inspect the current page after the wait condition timed out before retrying with a different selector or timeout."
		: "Inspect the current page after the timed-out browser operation.";
}

function buildTimeoutActions(options: AgentBrowserNextActionOptions): AgentBrowserNextAction[] {
	if (options.command === "session" && options.subcommand === "info") {
		return [
			buildNextToolAction({
				args: ["session", "info"],
				id: "retry-session-info",
				reason:
					"Retry the same session status check without opening a browser or inspecting its page.",
			}),
		];
	}
	const textAssertion = options.command === "wait" && options.args?.includes("--text") === true;
	const urlAssertion = options.command === "wait" && options.args?.includes("--url") === true;
	const actions = [
		buildNextToolAction({
			args: ["snapshot", "-i"],
			id: textAssertion ? "inspect-after-text-assertion-failure" : "inspect-after-timeout",
			reason: getTimeoutInspectionReason(options.command, textAssertion),
			safety: textAssertion
				? "Read-only snapshot; use current refs or visible text from this page before retrying the assertion."
				: "Read-only snapshot; do not assume the timed-out interaction completed.",
		}),
	];
	if (urlAssertion) {
		actions.push(
			buildNextToolAction({
				args: ["open", "about:blank"],
				id: "fresh-session-after-url-wait-timeout",
				reason:
					"If a preceding click or form submit reported success but the page never navigated, upstream click dispatch may have silently missed (observed with agent-browser 0.34 after many spaced commands); replace about:blank with the target URL and replay the flow as one batch in a fresh session instead of retrying the wait.",
				safety:
					"Abandons the current browser session; capture page evidence with the inspect action first, and only abandon when the wait target is not simply wrong or slow.",
				sessionMode: "fresh",
			}),
		);
	}
	return actions;
}

function buildUpstreamFailureActions(
	options: AgentBrowserNextActionOptions,
): AgentBrowserNextAction[] {
	if (options.overlayBlockedClick === true) {
		return [buildInspectOverlayStateAction(options.sessionName)];
	}
	return isOpenNavigationCommand(options.command)
		? [
				buildNextToolAction({
					args: ["get", "url"],
					id: "inspect-page-after-navigation-error",
					reason: "Check which page, if any, remains active after the navigation or network error.",
					safety:
						"Read-only URL inspection; verify connectivity and the target URL before retrying navigation.",
				}),
			]
		: [];
}

function buildTabGoneActions(): AgentBrowserNextAction[] {
	return [
		buildNextToolAction({
			args: ["tab", "list"],
			id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabGoneListTabs,
			reason: "The pinned bound tab is gone; inspect remaining tabs before acting on a neighbor.",
			safety:
				"Read-only. Prefer a listed tab id, label, or CDP targetId, or open a new tab to rebind.",
		}),
		buildNextToolAction({
			args: ["tab", "new"],
			id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabGoneNewTab,
			reason: "Bind a fresh tab after tab_gone instead of continuing on another session's page.",
			safety:
				"Opens a new tab in this session and rebinds the pin; pass a URL if you know the intended page.",
		}),
	];
}

function buildPageWedgedActions(options: AgentBrowserNextActionOptions): AgentBrowserNextAction[] {
	if (options.pageWedged?.replaced === true) {
		const reopenTarget = options.pageWedged.lastUrl ?? "about:blank";
		return [
			buildNextToolAction({
				args: ["open", reopenTarget],
				id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.pageWedgedReopenPage,
				reason:
					"Upstream replaced the unresponsive wedged tab with a blank tab; navigate again to continue.",
				safety:
					reopenTarget === "about:blank"
						? "Replace about:blank with the intended URL before opening."
						: "Verify application state after reopening the page and capture fresh snapshot refs.",
			}),
			buildNextToolAction({
				args: ["tab", "list"],
				id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.pageWedgedListTabs,
				reason: "Inspect remaining tabs in this session before continuing.",
				safety: "Read-only tab inspection.",
			}),
		];
	}
	return [
		buildNextToolAction({
			args: ["tab", "list"],
			id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.pageWedgedListTabs,
			reason:
				"The active tab stopped responding; inspect tabs so you can switch away from or close the wedged tab.",
			safety: "Read-only tab inspection.",
		}),
		buildNextToolAction({
			args: ["tab", "new"],
			id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.pageWedgedNewTab,
			reason: "Open and bind a responsive new tab after page_wedged.",
			safety: "Opens a new tab in this session; pass a URL if you know the intended page.",
		}),
	];
}

function buildTabDriftActions(options: AgentBrowserNextActionOptions): AgentBrowserNextAction[] {
	if (options.recovery?.kind === "about-blank" || options.recovery?.kind === "tab-drift") {
		return [];
	}
	return [
		buildNextToolAction({
			args: ["tab", "list"],
			id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.genericTabDriftListTabs,
			reason: "Inspect available tabs before selecting the intended target.",
			safety:
				"Read-only. Retry snapshot only after selecting or confirming the intended stable tab.",
		}),
	];
}

export function buildFailureNextActions(
	options: AgentBrowserNextActionOptions,
): AgentBrowserNextAction[] {
	switch (options.failureCategory) {
		case "artifact-missing":
			return buildMissingArtifactNextActions(options.artifacts);
		case "confirmation-required":
			return buildConfirmationActions(options.confirmationId);
		case "stale-ref":
		case "selector-not-found":
		case "selector-unsupported":
			return [
				buildNextToolAction({
					args: ["snapshot", "-i"],
					id: "refresh-interactive-refs",
					reason: "Get current interactive refs before retrying the element action.",
					safety:
						"Prefer a current @ref or a stable find locator; do not retry stale refs blindly.",
				}),
			];
		case "download-not-verified":
			return buildDownloadFailureActions(options);
		case "timeout":
			return buildTimeoutActions(options);
		case "upstream-error":
			return buildUpstreamFailureActions(options);
		case "tab-gone":
			return buildTabGoneActions();
		case "page-wedged":
			return buildPageWedgedActions(options);
		case "tab-drift":
			return buildTabDriftActions(options);
		case "aborted":
		case "cleanup-failed":
		case "missing-binary":
		case "parse-failure":
		case "policy-blocked":
		case "qa-failure":
		case "validation-error":
		case undefined:
			return [];
	}
}
