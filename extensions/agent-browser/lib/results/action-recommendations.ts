import { isOpenNavigationCommand, isPageMutationCommand } from "../command-taxonomy.js";
import { isPendingRecordingArtifact } from "./artifact-manifest.js";
import type {
	AgentBrowserFailureCategory,
	AgentBrowserResultCategory,
	AgentBrowserSuccessCategory,
	FileArtifactMetadata,
} from "./contracts.js";
import { applySessionToNextActions, buildNextToolAction, type AgentBrowserNextAction } from "./next-actions.js";
import {
	AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS,
	buildRecoveryNextActions,
	type AgentBrowserRecoveryContext,
} from "./recovery-actions.js";

function buildArtifactAction(path: string): AgentBrowserNextAction {
	return {
		artifactPath: path,
		id: "use-saved-artifact",
		reason: "Use the saved artifact path from the structured result instead of scraping it from text.",
		safety: "Verify artifact metadata such as exists/status before treating the file as durable.",
		tool: "agent_browser",
	};
}

function buildArtifactVerificationAction(artifact: FileArtifactMetadata): AgentBrowserNextAction {
	return {
		artifactPath: artifact.path,
		id: "verify-artifact-path",
		reason: "The wrapper has artifact metadata but did not verify this file as present on disk.",
		safety: "Check details.artifactVerification and the filesystem before treating the artifact as durable.",
		tool: "agent_browser",
	};
}

function buildElectronToolAction(options: {
	action: "cleanup" | "probe" | "status";
	id: string;
	launchId: string;
	reason: string;
	safety?: string;
}): AgentBrowserNextAction {
	return {
		id: options.id,
		params: { electron: { action: options.action, launchId: options.launchId } },
		reason: options.reason,
		...(options.safety ? { safety: options.safety } : {}),
		tool: "agent_browser",
	};
}

function getDownloadRetryPath(args: string[] | undefined, fallback: string | undefined): string | undefined {
	if (fallback) return fallback;
	if (!args || args.length === 0) return undefined;
	const downloadFlagIndex = args.indexOf("--download");
	if (downloadFlagIndex >= 0) {
		const candidate = args[downloadFlagIndex + 1];
		return candidate && !candidate.startsWith("-") ? candidate : undefined;
	}
	const downloadCommandIndex = args.indexOf("download");
	if (downloadCommandIndex >= 0 && args.length > downloadCommandIndex + 2) {
		return args[args.length - 1];
	}
	return undefined;
}

export function buildAgentBrowserNextActions(options: {
	artifacts?: FileArtifactMetadata[];
	args?: string[];
	command?: string;
	confirmationId?: string;
	electron?: {
		launchId?: string;
		sessionName?: string;
		status?: "active" | "cleaned" | "dead" | "failed" | "partial" | "succeeded";
	};
	failureCategory?: AgentBrowserFailureCategory;
	resultCategory: AgentBrowserResultCategory;
	recovery?: AgentBrowserRecoveryContext;
	savedFilePath?: string;
	sessionName?: string;
	subcommand?: string;
	successCategory?: AgentBrowserSuccessCategory;
}): AgentBrowserNextAction[] | undefined {
	const actions: AgentBrowserNextAction[] = [];
	if (options.recovery) {
		actions.push(...buildRecoveryNextActions(options.recovery));
	}
	if (options.electron?.launchId) {
		const { launchId, sessionName, status } = options.electron;
		if (options.resultCategory === "success" && status !== "cleaned") {
			actions.push(
				buildElectronToolAction({
					action: "status",
					id: "status-electron-launch",
					launchId,
					reason: "Check the wrapper-tracked Electron launch liveness and current CDP targets without mutating the app.",
				}),
				buildElectronToolAction({
					action: "probe",
					id: "probe-electron-launch",
					launchId,
					reason: "Probe the attached Electron managed session and carry the wrapper launchId for follow-up diagnostics.",
				}),
				buildElectronToolAction({
					action: "cleanup",
					id: "cleanup-electron-launch",
					launchId,
					reason: "Clean the wrapper-owned Electron process and isolated userDataDir when the run is complete.",
					safety: "Only operates on the launchId created by electron.launch; explicit artifacts and manually launched apps remain host-owned.",
				}),
			);
			if (sessionName) {
				actions.push(
					buildNextToolAction({
						args: ["--session", sessionName, "tab", "list"],
						id: "list-electron-tabs",
						reason: "Inspect attached Electron page/webview targets before choosing the active tab.",
					}),
					buildNextToolAction({
						args: ["--session", sessionName, "snapshot", "-i"],
						id: "snapshot-electron-session",
						reason: "Refresh interactive refs for the attached Electron session.",
						safety: "Use current Electron refs only after a fresh snapshot for this session.",
					}),
				);
			}
		} else if (options.resultCategory === "failure" && options.failureCategory === "cleanup-failed") {
			actions.push(
				buildElectronToolAction({
					action: "status",
					id: "status-electron-launch",
					launchId,
					reason: "Inspect which wrapper-tracked Electron resources remain after partial cleanup.",
				}),
				buildElectronToolAction({
					action: "cleanup",
					id: "retry-electron-cleanup",
					launchId,
					reason: "Retry cleanup for the same wrapper-owned Electron launch after reviewing remaining resources.",
					safety: "Only retry for the same launchId; do not use cleanup for manually launched Electron apps.",
				}),
			);
		}
	}
	if (options.resultCategory === "success") {
		if (isOpenNavigationCommand(options.command)) {
			actions.push(buildNextToolAction({
				args: ["snapshot", "-i"],
				id: "inspect-opened-page",
				reason: "Inspect the opened page before choosing interactive refs.",
			}));
		} else if (isPageMutationCommand(options.command, options.subcommand)) {
			actions.push(buildNextToolAction({
				args: ["snapshot", "-i"],
				id: "inspect-after-mutation",
				reason: "Refresh interactive refs after a browser mutation, navigation, scroll, or rerender.",
				safety: "Do not reuse prior @refs until a fresh snapshot confirms they still exist.",
			}));
		}
		const artifacts = options.artifacts ?? [];
		const savedFileArtifact = options.savedFilePath ? artifacts.find((artifact) => artifact.path === options.savedFilePath) : undefined;
		if (options.savedFilePath && savedFileArtifact?.exists !== false) {
			actions.push(buildArtifactAction(options.savedFilePath));
		}
		for (const artifact of artifacts) {
			if (isPendingRecordingArtifact(artifact)) continue;
			if (artifact.exists === false) {
				if (artifact.kind === "download") {
					actions.push(buildNextToolAction({
						args: ["wait", "--download", artifact.path],
						id: "wait-for-download",
						reason: "Upstream reported a download path, but the wrapper did not verify the file on disk.",
						safety: "Use an explicit wait timeout; if you set top-level timeoutMs, keep it above the wait duration plus a small grace window.",
					}));
				} else {
					actions.push(buildArtifactVerificationAction(artifact));
				}
				continue;
			}
			if (artifact.path !== options.savedFilePath) {
				actions.push(buildArtifactAction(artifact.path));
			}
		}
	} else {
		switch (options.failureCategory) {
			case "artifact-missing":
				for (const artifact of options.artifacts ?? []) {
					if (isPendingRecordingArtifact(artifact) || (artifact.exists !== false && artifact.status !== "stale")) continue;
					if (artifact.kind === "download") {
						actions.push(buildNextToolAction({
							args: ["wait", "--download", artifact.path],
							id: "wait-for-download",
							reason: "The requested download artifact was not found on disk after upstream reported completion.",
							safety: "Use an explicit wait timeout; if you set top-level timeoutMs, keep it above the wait duration plus a small grace window.",
						}));
					} else {
						actions.push(buildArtifactVerificationAction(artifact));
					}
				}
				break;
			case "confirmation-required":
				if (options.confirmationId) {
					actions.push(
						buildNextToolAction({
							args: ["confirm", options.confirmationId],
							id: "approve-confirmation",
							reason: "Approve the pending upstream confirmation when the requested action is safe.",
							safety: "Only confirm after reviewing the guarded action shown in the result.",
						}),
						buildNextToolAction({
							args: ["deny", options.confirmationId],
							id: "deny-confirmation",
							reason: "Deny the pending upstream confirmation when the guarded action is unsafe or unintended.",
						}),
					);
				}
				break;
			case "stale-ref":
			case "selector-not-found":
			case "selector-unsupported":
				actions.push(buildNextToolAction({
					args: ["snapshot", "-i"],
					id: "refresh-interactive-refs",
					reason: "Get current interactive refs before retrying the element action.",
					safety: "Prefer a current @ref or a stable find locator; do not retry stale refs blindly.",
				}));
				break;
			case "download-not-verified":
				{
					const retryPath = getDownloadRetryPath(options.args, options.savedFilePath);
					actions.push(buildNextToolAction({
						args: retryPath ? ["wait", "--download", retryPath] : ["wait", "--download"],
						id: "wait-for-download",
						reason: "Wait for the browser download and let the wrapper verify saved-file metadata.",
						safety: "Use an explicit wait timeout; if you set top-level timeoutMs, keep it above the wait duration plus a small grace window.",
					}));
				}
				break;
			case "timeout":
				{
					const textAssertion = options.command === "wait" && options.args?.includes("--text") === true;
					const urlAssertion = options.command === "wait" && options.args?.includes("--url") === true;
					actions.push(buildNextToolAction({
						args: ["snapshot", "-i"],
						id: textAssertion ? "inspect-after-text-assertion-failure" : "inspect-after-timeout",
						reason: textAssertion
							? "Inspect the current page after the text assertion failed before concluding the expected text is absent."
							: options.command === "wait"
								? "Inspect the current page after the wait condition timed out before retrying with a different selector or timeout."
								: "Inspect the current page after the timed-out browser operation.",
						safety: textAssertion
							? "Read-only snapshot; use current refs or visible text from this page before retrying the assertion."
							: "Read-only snapshot; do not assume the timed-out interaction completed.",
					}));
					if (urlAssertion) {
						actions.push(buildNextToolAction({
							args: ["open", "about:blank"],
							id: "fresh-session-after-url-wait-timeout",
							reason: "If a preceding click or form submit reported success but the page never navigated, upstream click dispatch may have silently missed (observed with agent-browser 0.34 after many spaced commands); replace about:blank with the target URL and replay the flow as one batch in a fresh session instead of retrying the wait.",
							safety: "Abandons the current browser session; capture page evidence with the inspect action first, and only abandon when the wait target is not simply wrong or slow.",
							sessionMode: "fresh",
						}));
					}
				}
				break;
			case "upstream-error":
				if (isOpenNavigationCommand(options.command)) {
					actions.push(buildNextToolAction({
						args: ["get", "url"],
						id: "inspect-page-after-navigation-error",
						reason: "Check which page, if any, remains active after the navigation or network error.",
						safety: "Read-only URL inspection; verify connectivity and the target URL before retrying navigation.",
					}));
				}
				break;
			case "tab-gone":
				actions.push(
					buildNextToolAction({
						args: ["tab", "list"],
						id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabGoneListTabs,
						reason: "The pinned bound tab is gone; inspect remaining tabs before acting on a neighbor.",
						safety: "Read-only. Prefer a listed tab id, label, or CDP targetId, or open a new tab to rebind.",
					}),
					buildNextToolAction({
						args: ["tab", "new"],
						id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabGoneNewTab,
						reason: "Bind a fresh tab after tab_gone instead of continuing on another session's page.",
						safety: "Opens a new tab in this session and rebinds the pin; pass a URL if you know the intended page.",
					}),
				);
				break;
			case "tab-drift":
				if (options.recovery?.kind === "about-blank" || options.recovery?.kind === "tab-drift") {
					break;
				}
				actions.push(
					buildNextToolAction({
						args: ["tab", "list"],
						id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.genericTabDriftListTabs,
						reason: "Inspect available tabs before selecting the intended target.",
						safety: "Read-only. Retry snapshot only after selecting or confirming the intended stable tab.",
					}),
				);
				break;
		}
	}
	if ((options.artifacts ?? []).some(isPendingRecordingArtifact)) {
		actions.push(buildNextToolAction({
			args: ["record", "stop"],
			id: "stop-pending-recording",
			reason: "Stop the active recording so the requested video can be finalized and verified on disk.",
			safety: "The file remains pending until record stop succeeds; verify details.artifactVerification afterward.",
		}));
	}
	return applySessionToNextActions(actions.length > 0 ? actions : undefined, options.sessionName);
}
