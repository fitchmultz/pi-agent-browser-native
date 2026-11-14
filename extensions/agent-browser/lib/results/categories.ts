import type {
	AgentBrowserFailureCategory,
	AgentBrowserResultCategoryDetails,
	AgentBrowserSuccessCategory,
	FileArtifactMetadata,
	SavedFilePresentationDetails,
} from "./contracts.js";
import { isPendingRecordingArtifact } from "./artifact-manifest.js";

interface SuccessCategoryOptions {
	readonly artifacts?: readonly FileArtifactMetadata[] | undefined;
	readonly inspection?: boolean;
	readonly savedFile?: SavedFilePresentationDetails | undefined;
}

interface FailureCategoryOptions {
	readonly args?: readonly string[] | undefined;
	readonly command?: string | undefined;
	readonly confirmationRequired?: boolean;
	readonly errorText?: string | undefined;
	readonly parseError?: string | undefined;
	readonly spawnError?: string | undefined;
	readonly stderr?: string;
	readonly tabDrift?: boolean;
	readonly timedOut?: boolean;
	readonly validationError?: string | undefined;
}

interface FailureContext {
	readonly options: FailureCategoryOptions;
	readonly text: string;
	readonly command: string;
}

function hasUnverifiedFileArtifact(
	artifacts: readonly FileArtifactMetadata[] | undefined,
): boolean {
	return (artifacts ?? []).some(
		(artifact) =>
			!isPendingRecordingArtifact(artifact) &&
			(artifact.exists !== true ||
				["failed", "stale", "unverified"].includes(artifact.status ?? "")),
	);
}

export function classifyAgentBrowserSuccessCategory(
	options: SuccessCategoryOptions,
): AgentBrowserSuccessCategory {
	if (options.inspection === true) {
		return "inspection";
	}
	if (hasUnverifiedFileArtifact(options.artifacts)) {
		return "artifact-unverified";
	}
	if ((options.artifacts ?? []).some(isPendingRecordingArtifact)) {
		return "artifact-pending";
	}
	return (options.artifacts ?? []).length > 0 || options.savedFile !== undefined
		? "artifact-saved"
		: "completed";
}

function hasScopedNamesSeen(text: string, command: string): boolean {
	return (
		/\bNames seen:/i.test(text) &&
		(command === "find" || /\belement has role\b|\bnone match name\b|\bgetByRole\b/i.test(text))
	);
}

function isUpstreamLocatorMiss(text: string, command: string): boolean {
	return (
		/\bNo element found:\s*(?:getBy[A-Za-z]+|role=|text=|label=|placeholder=|alt=|title=|testid=)/i.test(
			text,
		) ||
		(/\bElement not found:/i.test(text) && /\bVerify the selector, role, or name\b/i.test(text)) ||
		/\bnone match name\b/i.test(text) ||
		hasScopedNamesSeen(text, command) ||
		/\belement has role\b[\s\S]*\bnone match\b/i.test(text)
	);
}

function classifyNativeFailure(context: FailureContext): AgentBrowserFailureCategory | undefined {
	const { options, text, command } = context;
	// Explicit native flags and prefixes win over accessible-name text and lastUrl substrings.
	if (options.confirmationRequired === true) {
		return "confirmation-required";
	}
	if (/\btab_gone:/i.test(text)) {
		return "tab-gone";
	}
	if (/\bpage_wedged:/i.test(text)) {
		return "page-wedged";
	}
	if (isUpstreamLocatorMiss(text, command)) {
		return "selector-not-found";
	}
	if (/confirmation required|pending confirmation|requires confirmation/i.test(text)) {
		return "confirmation-required";
	}
	return undefined;
}

function classifyProcessFailure(context: FailureContext): AgentBrowserFailureCategory | undefined {
	const { options, text } = context;
	// Bare "timeout" may be an accessible name; require actual timeout phrasing.
	if (
		options.timedOut === true ||
		/\b(?:timed\s+out|timeout exceeded|watchdog|IPC read timeout)\b|must stay under its 30s IPC read timeout|Operation timed out/i.test(
			text,
		)
	) {
		return "timeout";
	}
	if (
		/ENOENT|not found on PATH|could not find.*agent-browser|agent-browser is required but was not found/i.test(
			text,
		)
	) {
		return "missing-binary";
	}
	if (
		(options.parseError ?? "") !== "" ||
		/invalid JSON|missing boolean success|success field must be boolean|returned no JSON output/i.test(
			text,
		)
	) {
		return "parse-failure";
	}
	if (/aborted/i.test(text)) {
		return "aborted";
	}
	return undefined;
}

function classifyLifecycleFailure(
	context: FailureContext,
): AgentBrowserFailureCategory | undefined {
	const { options, text } = context;
	if (
		/policy[- ]blocked|blocked by caller policy|caller deny policy|caller allow policy/i.test(text)
	) {
		return "policy-blocked";
	}
	if (/cleanup failed|cleanup.*partial|partial cleanup|remaining resources/i.test(text)) {
		return "cleanup-failed";
	}
	if (
		(options.validationError ?? "") !== "" ||
		/Agent-browser Unix socket path would be|Agent-browser socket storage .* is unusable/i.test(
			text,
		)
	) {
		return "validation-error";
	}
	if (
		options.tabDrift === true ||
		/could not re-select the intended tab|about:blank|selected tab looks wrong|tab drift|tab.*wrong/i.test(
			text,
		)
	) {
		return "tab-drift";
	}
	return undefined;
}

function reportsSelectorMatchFailure(text: string): boolean {
	return (
		/\b(?:no elements? found|failed to find|could not find|unable to find)\b.*\b(?:selector|locator)\b/i.test(
			text,
		) ||
		/\b(?:selector|locator)\b.*\b(?:no elements? found|not found|missing|failed to find|could not find|unable to find)\b/i.test(
			text,
		)
	);
}

function reportsUnsupportedSelector(text: string): boolean {
	return (
		/\b(?:unsupported|unknown|invalid)\s+(?:selector|locator)\b/i.test(text) ||
		/\bfailed to parse selector\b/i.test(text) ||
		/\bselector\b.*\b(?:parse|syntax|unsupported|invalid)\b/i.test(text) ||
		(/(?:\btext=|:has-text\(|\bgetByRole\b|\bgetByText\b)/i.test(text) &&
			reportsSelectorMatchFailure(text))
	);
}

/**
 * Whether failure text warrants selector-dialect guidance. Locator-detail misses keep the
 * classifier's selector-not-found precedence: they echo supported native locators such as getByRole.
 */
export function reportsUnsupportedSelectorDialect(options: {
	readonly command: string | undefined;
	readonly errorText: string;
}): boolean {
	return (
		!isUpstreamLocatorMiss(options.errorText, options.command ?? "") &&
		reportsUnsupportedSelector(options.errorText)
	);
}

function classifySelectorFailure(context: FailureContext): AgentBrowserFailureCategory | undefined {
	const { options, text, command } = context;
	if (
		/\bUnknown ref\b|\bstale ref\b|@ref may be stale|\bref\b.*\b(?:not found|missing|expired)\b/i.test(
			text,
		)
	) {
		return "stale-ref";
	}
	const usedRef = options.args?.some((arg) => /^@e\d+\b/.test(arg)) ?? false;
	if (usedRef && /could not locate element|element not found|no element/i.test(text)) {
		return "stale-ref";
	}
	if (reportsUnsupportedSelector(text)) {
		return "selector-unsupported";
	}
	if (
		command === "find" &&
		/could not locate element|element not found|no elements? found|unable to find/i.test(text)
	) {
		return "selector-not-found";
	}
	return reportsSelectorMatchFailure(text) ? "selector-not-found" : undefined;
}

function classifyDownloadFailure(context: FailureContext): AgentBrowserFailureCategory {
	const { text, command } = context;
	return (command === "download" ||
		text.includes("wait --download") ||
		/\bdownload\b/i.test(text)) &&
		/missing|not verified|not found|failed|timeout|timed out/i.test(text)
		? "download-not-verified"
		: "upstream-error";
}

export function classifyAgentBrowserFailureCategory(
	options: FailureCategoryOptions,
): AgentBrowserFailureCategory {
	const text = [
		options.errorText,
		options.validationError,
		options.parseError,
		options.spawnError,
		options.stderr,
	]
		.filter(Boolean)
		.join("\n");
	const context = { options, text, command: options.command ?? "" };
	return (
		classifyNativeFailure(context) ??
		classifyProcessFailure(context) ??
		classifyLifecycleFailure(context) ??
		classifySelectorFailure(context) ??
		classifyDownloadFailure(context)
	);
}

export function buildAgentBrowserResultCategoryDetails(
	options: SuccessCategoryOptions &
		FailureCategoryOptions & {
			readonly failureCategory?: AgentBrowserFailureCategory | undefined;
			readonly succeeded: boolean;
		},
): AgentBrowserResultCategoryDetails {
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
