import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./parsing.js";

export const BROWSER_TRANSITION_ENTRY = "agent-browser-transition";

const BROWSER_RESULT_TOOLS = new Set([
	"agent_browser", "agent_browser_code", "agent_browser_action", "agent_browser_qa", "agent_browser_electron",
	"agent_browser_source", "agent_browser_network_source",
]);

/** Direct tools and ordered code calls replay through the same browser state reducers. */
export function getBrowserResultMessage(entry: unknown): Record<string, unknown> | undefined {
	if (!isRecord(entry)) return undefined;
	if (entry.type === "custom" && entry.customType === BROWSER_TRANSITION_ENTRY && isRecord(entry.data)) {
		return isRecord(entry.data.details) && typeof entry.data.isError === "boolean" ? entry.data : undefined;
	}
	const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
	return message && typeof message.toolName === "string" && BROWSER_RESULT_TOOLS.has(message.toolName) ? message : undefined;
}

// Page data and rendered output are not state. Keep only fields consumed by the
// existing replay reducers; recording reservations retain their own native journal.
const TRANSITION_FIELDS = [
	"args", "command", "subcommand", "sessionName", "namespace", "sessionMode", "usedImplicitSession",
	"agentBrowserStarted", "resultCategory", "exitCode", "closeAllApplied", "attachedBrowserSession",
	"sessionTabTarget", "sessionTabTargetUnknown", "sessionTabReopenPending", "refSnapshot", "refSnapshotInvalidation",
	"readConfirmation", "compatibilityWorkaround", "managedSessionHeadedAutosaveDisabled", "managedSessionHeadedAutosaveInterval",
	"managedSessionOutcome", "managedSessionRestoreDisabled", "artifactManifest", "electron", "compiledNetworkSourceLookup",
] as const;

export function appendBrowserTransition(pi: ExtensionAPI, toolCallId: string, details: Record<string, unknown>, isError: boolean): void {
	const state = Object.fromEntries(TRANSITION_FIELDS.filter(key => details[key] !== undefined).map(key => [key, details[key]]));
	if (Array.isArray(details.batchSteps)) state.batchSteps = details.batchSteps.filter(isRecord).map(step => ({
		command: step.command, success: step.success, lifecycle: step.lifecycle,
	}));
	pi.appendEntry(BROWSER_TRANSITION_ENTRY, { toolCallId, details: state, isError });
}
