/**
 * Purpose: Classify successful and failed agent-browser outcomes into stable result categories.
 * Responsibilities: Map artifacts, inspection calls, errors, refs, selectors, downloads, drift, and timeouts to small enums.
 * Scope: Category policy only; next-action recommendations and presentation formatting live elsewhere.
 * Usage: Called by presentation and extension result assembly before details are exposed to Pi.
 * Invariants/Assumptions: Category strings are public machine-readable contracts covered by tests and docs.
 */

import type {
	AgentBrowserFailureCategory,
	AgentBrowserResultCategoryDetails,
	AgentBrowserSuccessCategory,
	FileArtifactMetadata,
	SavedFilePresentationDetails,
} from "./contracts.js";
import { isPendingRecordingArtifact } from "./artifact-state.js";

function hasUnverifiedFileArtifact(artifacts: FileArtifactMetadata[] | undefined): boolean {
	return (artifacts ?? []).some((artifact) => !isPendingRecordingArtifact(artifact) && artifact.exists !== true);
}

export function classifyAgentBrowserSuccessCategory(options: {
	artifacts?: FileArtifactMetadata[];
	inspection?: boolean;
	savedFile?: SavedFilePresentationDetails;
}): AgentBrowserSuccessCategory {
	if (options.inspection) return "inspection";
	if ((options.artifacts ?? []).length > 0) return hasUnverifiedFileArtifact(options.artifacts) ? "artifact-unverified" : "artifact-saved";
	if (options.savedFile) return "artifact-saved";
	return "completed";
}

export function classifyAgentBrowserFailureCategory(options: {
	args?: string[];
	command?: string;
	confirmationRequired?: boolean;
	errorText?: string;
	parseError?: string;
	spawnError?: string;
	stderr?: string;
	tabDrift?: boolean;
	timedOut?: boolean;
	validationError?: string;
}): AgentBrowserFailureCategory {
	const text = [options.errorText, options.validationError, options.parseError, options.spawnError, options.stderr].filter(Boolean).join("\n");
	const command = options.command ?? "";
	const usedRef = options.args?.some((arg) => /^@e\d+\b/.test(arg)) ?? false;
	// Explicit confirmation flag wins. Text-derived confirmation phrases come after locator-miss detection so a
	// missed control named "Confirmation required" still gets selector recovery.
	if (options.confirmationRequired) return "confirmation-required";
	// Upstream 0.32.4+ locator misses keep detail and may echo getByRole/getByText or Names seen lists.
	// Evaluate before text-derived timeout/confirmation so accessible-name substrings cannot suppress recovery.
	const isUpstreamLocatorMiss =
		/\bNo element found:\s*(?:getBy[A-Za-z]+|role=|text=|label=|placeholder=|alt=|title=|testid=)/i.test(text) ||
		// No trailing \b after ":" — colon is non-word, so "Element not found: text=…" would not match.
		(/\bElement not found:/i.test(text) && /\bVerify the selector, role, or name\b/i.test(text)) ||
		/\bnone match name\b/i.test(text) ||
		// Scope Names seen to role/name miss context (or find) so unrelated prose cannot trip selector-not-found.
		(/\bNames seen:/i.test(text) && (command === "find" || /\belement has role\b|\bnone match name\b|\bgetByRole\b/i.test(text))) ||
		/\belement has role\b[\s\S]*\bnone match\b/i.test(text);
	if (isUpstreamLocatorMiss) return "selector-not-found";
	if (/confirmation required|pending confirmation|requires confirmation/i.test(text)) return "confirmation-required";
	// Match real timeout phrasing only. Do not treat bare "timeout" as a hit — accessible names can include that word,
	// and `timed?\s*out` would also match the substring "timeout" as time+out.
	if (
		options.timedOut ||
		/\b(?:timed\s+out|timeout exceeded|watchdog|IPC read timeout)\b|must stay under its 30s IPC read timeout|Operation timed out/i.test(text)
	) {
		return "timeout";
	}
	if (/ENOENT|not found on PATH|could not find.*agent-browser|agent-browser is required but was not found/i.test(text)) return "missing-binary";
	if (options.parseError || /invalid JSON|missing boolean success|success field must be boolean|returned no JSON output/i.test(text)) return "parse-failure";
	if (/aborted/i.test(text)) return "aborted";
	if (/policy[- ]blocked|blocked by caller policy|caller deny policy|caller allow policy/i.test(text)) return "policy-blocked";
	if (/cleanup failed|cleanup.*partial|partial cleanup|remaining resources/i.test(text)) return "cleanup-failed";
	if (options.validationError) return "validation-error";
	if (options.tabDrift || /could not re-select the intended tab|about:blank|selected tab looks wrong|tab drift|tab.*wrong/i.test(text)) return "tab-drift";
	if (/\bUnknown ref\b|\bstale ref\b|@ref may be stale|\bref\b.*\b(?:not found|missing|expired)\b/i.test(text)) return "stale-ref";
	if (usedRef && /could not locate element|element not found|no element/i.test(text)) return "stale-ref";
	const mentionsPlaywrightSelectorDialect = /(?:\btext=|:has-text\(|\bgetByRole\b|\bgetByText\b)/i.test(text);
	const reportsSelectorMatchFailure =
		/\b(?:no elements? found|failed to find|could not find|unable to find)\b.*\b(?:selector|locator)\b/i.test(text) ||
		/\b(?:selector|locator)\b.*\b(?:no elements? found|not found|missing|failed to find|could not find|unable to find)\b/i.test(text);
	if (
		/\b(?:unsupported|unknown|invalid)\s+(?:selector|locator)\b/i.test(text) ||
		/\bfailed to parse selector\b/i.test(text) ||
		/\bselector\b.*\b(?:parse|syntax|unsupported|invalid)\b/i.test(text) ||
		(mentionsPlaywrightSelectorDialect && reportsSelectorMatchFailure)
	) {
		return "selector-unsupported";
	}
	if (command === "find" && /could not locate element|element not found|no elements? found|unable to find/i.test(text)) return "selector-not-found";
	if (reportsSelectorMatchFailure) return "selector-not-found";
	if ((command === "download" || text.includes("wait --download") || /\bdownload\b/i.test(text)) && /missing|not verified|not found|failed|timeout|timed out/i.test(text)) {
		return "download-not-verified";
	}
	return "upstream-error";
}


export function buildAgentBrowserResultCategoryDetails(options: {
	artifacts?: FileArtifactMetadata[];
	args?: string[];
	command?: string;
	confirmationRequired?: boolean;
	errorText?: string;
	failureCategory?: AgentBrowserFailureCategory;
	inspection?: boolean;
	parseError?: string;
	savedFile?: SavedFilePresentationDetails;
	spawnError?: string;
	succeeded: boolean;
	tabDrift?: boolean;
	timedOut?: boolean;
	validationError?: string;
}): AgentBrowserResultCategoryDetails {
	if (options.succeeded) {
		return {
			resultCategory: "success",
			successCategory: classifyAgentBrowserSuccessCategory(options),
		};
	}
	return {
		failureCategory: options.failureCategory ?? classifyAgentBrowserFailureCategory(options),
		resultCategory: "failure",
	};
}
