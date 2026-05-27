/**
 * Purpose: Build generic nextAction recommendations from result categories, artifacts, Electron lifecycle state, and recovery context.
 * Responsibilities: Preserve stable action ids/order while keeping recommendation policy out of generic shared helpers.
 * Scope: Generic result-level recommendations only; feature-specific diagnostics append their own actions in the extension entrypoint.
 * Usage: Called by presentation and extension result assembly.
 * Invariants/Assumptions: Action ids are public machine-readable contracts; preserve first-observed order.
 */

import { isOpenNavigationCommand, isPageMutationCommand } from "../command-taxonomy.js";
import { isPendingRecordingArtifact } from "./artifact-state.js";
import type {
	AgentBrowserFailureCategory,
	AgentBrowserResultCategory,
	AgentBrowserSuccessCategory,
	FileArtifactMetadata,
} from "./contracts.js";
import { buildNextToolAction, type AgentBrowserNextAction } from "./next-actions.js";
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
		} else if (isPageMutationCommand(options.command)) {
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
			if (isPendingRecordingArtifact(artifact)) {
				continue;
			}
			if (artifact.exists === false) {
				if (artifact.kind === "download") {
					actions.push(buildNextToolAction({
						args: ["wait", "--download", artifact.path],
						id: "wait-for-download",
						reason: "Upstream reported a download path, but the wrapper did not verify the file on disk.",
						safety: "Use a bounded wait timeout that stays below the native wrapper IPC budget.",
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
						safety: "Use a bounded wait timeout that stays below the native wrapper IPC budget.",
					}));
				}
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
	return actions.length > 0 ? actions : undefined;
}
