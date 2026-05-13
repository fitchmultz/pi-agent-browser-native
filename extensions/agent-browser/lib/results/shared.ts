/**
 * Purpose: Share stable result-rendering types and small data-shaping helpers across the focused result modules.
 * Responsibilities: Define upstream envelope/presentation types, provide safe string utilities, and expose lightweight text helpers used by envelope parsing, snapshot compaction, and presentation rendering.
 * Scope: Shared result helpers only; higher-level parsing, snapshot compaction, and image attachment orchestration live in neighboring modules.
 * Usage: Imported by the focused result modules that back the public `lib/results.ts` facade.
 * Invariants/Assumptions: Helpers stay generic, side-effect free, and small enough to reuse without reintroducing a new god module.
 */

export interface AgentBrowserEnvelope {
	data?: unknown;
	error?: unknown;
	success: boolean;
}

export interface AgentBrowserBatchResult {
	command?: string[];
	error?: unknown;
	result?: unknown;
	success?: boolean;
}

export type AgentBrowserResultCategory = "failure" | "success";

export type AgentBrowserSuccessCategory = "artifact-saved" | "completed" | "inspection";

export type AgentBrowserFailureCategory =
	| "aborted"
	| "confirmation-required"
	| "download-not-verified"
	| "missing-binary"
	| "parse-failure"
	| "selector-not-found"
	| "selector-unsupported"
	| "stale-ref"
	| "tab-drift"
	| "timeout"
	| "upstream-error"
	| "validation-error";

export interface AgentBrowserResultCategoryDetails {
	failureCategory?: AgentBrowserFailureCategory;
	resultCategory: AgentBrowserResultCategory;
	successCategory?: AgentBrowserSuccessCategory;
}

export type FileArtifactKind = "download" | "file" | "har" | "image" | "pdf" | "profile" | "trace" | "video";

export type FileArtifactStatus = "missing" | "repaired-from-temp" | "saved" | "upstream-temp-only";

export interface FileArtifactMetadata {
	absolutePath: string;
	artifactType?: FileArtifactKind;
	command?: string;
	cwd?: string;
	exists?: boolean;
	extension?: string;
	kind: FileArtifactKind;
	mediaType?: string;
	path: string;
	requestedPath?: string;
	session?: string;
	sizeBytes?: number;
	status?: FileArtifactStatus;
	subcommand?: string;
	tempPath?: string;
}

export interface SavedFilePresentationDetails {
	command: "download" | "pdf" | "wait";
	kind: "download" | "pdf";
	metadata?: Record<string, unknown>;
	path: string;
	subcommand?: string;
}

export type ArtifactRetentionState = "evicted" | "ephemeral" | "live" | "missing";

export type ArtifactStorageScope = "explicit-path" | "persistent-session" | "process-temp";

export interface SessionArtifactManifestEntry {
	absolutePath?: string;
	command?: string;
	createdAtMs: number;
	cwd?: string;
	evictedAtMs?: number;
	exists?: boolean;
	extension?: string;
	kind: FileArtifactKind | "spill";
	mediaType?: string;
	path: string;
	requestedPath?: string;
	retentionState: ArtifactRetentionState;
	session?: string;
	sizeBytes?: number;
	storageScope: ArtifactStorageScope;
	subcommand?: string;
}

export interface SessionArtifactManifest {
	entries: SessionArtifactManifestEntry[];
	evictedCount: number;
	liveCount: number;
	maxEntries: number;
	updatedAtMs: number;
	version: 1;
}

export const SESSION_ARTIFACT_MANIFEST_VERSION = 1;
export const SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES_ENV = "PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES";
export const DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES = 100;

function parsePositiveSafeInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
	return parsed;
}

export function getSessionArtifactManifestMaxEntries(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveSafeInteger(env[SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES_ENV]) ?? DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isManifestEntry(value: unknown): value is SessionArtifactManifestEntry {
	if (!isRecord(value)) return false;
	if (typeof value.path !== "string" || value.path.trim().length === 0) return false;
	if (typeof value.createdAtMs !== "number" || !Number.isFinite(value.createdAtMs)) return false;
	if (!["evicted", "ephemeral", "live", "missing"].includes(String(value.retentionState))) return false;
	if (!["explicit-path", "persistent-session", "process-temp"].includes(String(value.storageScope))) return false;
	if (typeof value.kind !== "string" || value.kind.trim().length === 0) return false;
	return true;
}

export function isSessionArtifactManifest(value: unknown): value is SessionArtifactManifest {
	if (!isRecord(value)) return false;
	if (value.version !== SESSION_ARTIFACT_MANIFEST_VERSION) return false;
	if (!Array.isArray(value.entries) || !value.entries.every(isManifestEntry)) return false;
	if (typeof value.updatedAtMs !== "number" || !Number.isFinite(value.updatedAtMs)) return false;
	if (typeof value.maxEntries !== "number" || !Number.isSafeInteger(value.maxEntries) || value.maxEntries <= 0) return false;
	if (typeof value.liveCount !== "number" || !Number.isSafeInteger(value.liveCount) || value.liveCount < 0) return false;
	if (typeof value.evictedCount !== "number" || !Number.isSafeInteger(value.evictedCount) || value.evictedCount < 0) return false;
	return true;
}

export function buildEvictedSessionArtifactEntries(
	evictedArtifacts: Array<{ mtimeMs: number; path: string; sizeBytes: number }>,
	nowMs: number,
): SessionArtifactManifestEntry[] {
	return evictedArtifacts.map((artifact) => ({
		createdAtMs: artifact.mtimeMs,
		evictedAtMs: nowMs,
		kind: "spill",
		path: artifact.path,
		retentionState: "evicted",
		sizeBytes: artifact.sizeBytes,
		storageScope: "persistent-session",
	}));
}

export function formatSessionArtifactRetentionSummary(manifest: SessionArtifactManifest): string {
	const ephemeralCount = manifest.entries.filter((entry) => entry.retentionState === "ephemeral").length;
	const missingCount = manifest.entries.filter((entry) => entry.retentionState === "missing").length;
	const parts = [`${manifest.liveCount} live`, `${manifest.evictedCount} evicted`];
	if (ephemeralCount > 0) parts.push(`${ephemeralCount} ephemeral`);
	if (missingCount > 0) parts.push(`${missingCount} missing`);
	return `Session artifacts: ${parts.join(", ")} (${manifest.entries.length}/${manifest.maxEntries} recent).`;
}

export function mergeSessionArtifactManifest(options: {
	base?: SessionArtifactManifest;
	entries?: SessionArtifactManifestEntry[];
	nowMs?: number;
}): SessionArtifactManifest | undefined {
	const nowMs = options.nowMs ?? Date.now();
	const maxEntries = getSessionArtifactManifestMaxEntries();
	const getEntryKey = (entry: SessionArtifactManifestEntry) =>
		entry.storageScope === "explicit-path" && entry.absolutePath ? `${entry.storageScope}:${entry.absolutePath}` : `${entry.storageScope}:${entry.path}`;
	const byPath = new Map<string, SessionArtifactManifestEntry>();
	for (const entry of options.base?.entries ?? []) {
		byPath.set(getEntryKey(entry), entry);
	}
	for (const entry of options.entries ?? []) {
		const key = getEntryKey(entry);
		const existing = byPath.get(key);
		byPath.set(key, {
			...existing,
			...entry,
			createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
			evictedAtMs: entry.retentionState === "evicted" ? (entry.evictedAtMs ?? nowMs) : entry.evictedAtMs,
		});
	}
	if (byPath.size === 0) return undefined;
	const entries = [...byPath.values()]
		.sort((left, right) => {
			const leftTime = left.evictedAtMs ?? left.createdAtMs;
			const rightTime = right.evictedAtMs ?? right.createdAtMs;
			return rightTime - leftTime || left.path.localeCompare(right.path);
		})
		.slice(0, maxEntries);
	return {
		entries,
		evictedCount: entries.filter((entry) => entry.retentionState === "evicted").length,
		liveCount: entries.filter((entry) => entry.retentionState === "live").length,
		maxEntries,
		updatedAtMs: nowMs,
		version: SESSION_ARTIFACT_MANIFEST_VERSION,
	};
}

export interface BatchStepPresentationDetails {
	artifacts?: FileArtifactMetadata[];
	command?: string[];
	commandText: string;
	data?: unknown;
	failureCategory?: AgentBrowserFailureCategory;
	fullOutputPath?: string;
	fullOutputPaths?: string[];
	imagePath?: string;
	imagePaths?: string[];
	index: number;
	resultCategory: AgentBrowserResultCategory;
	savedFile?: SavedFilePresentationDetails;
	savedFilePath?: string;
	success: boolean;
	successCategory?: AgentBrowserSuccessCategory;
	summary: string;
	text: string;
}

export interface BatchFailurePresentationDetails {
	failedStep: BatchStepPresentationDetails;
	failureCount: number;
	successCount: number;
	totalCount: number;
}

export interface ToolPresentation {
	artifactManifest?: SessionArtifactManifest;
	artifactRetentionSummary?: string;
	artifacts?: FileArtifactMetadata[];
	batchFailure?: BatchFailurePresentationDetails;
	batchSteps?: BatchStepPresentationDetails[];
	content: Array<{ text: string; type: "text" } | { data: string; mimeType: string; type: "image" }>;
	data?: unknown;
	failureCategory?: AgentBrowserFailureCategory;
	fullOutputPath?: string;
	fullOutputPaths?: string[];
	imagePath?: string;
	imagePaths?: string[];
	resultCategory?: AgentBrowserResultCategory;
	savedFile?: SavedFilePresentationDetails;
	savedFilePath?: string;
	successCategory?: AgentBrowserSuccessCategory;
	summary: string;
}

export function classifyAgentBrowserSuccessCategory(options: {
	artifacts?: FileArtifactMetadata[];
	inspection?: boolean;
	savedFile?: SavedFilePresentationDetails;
}): AgentBrowserSuccessCategory {
	if (options.inspection) return "inspection";
	if (options.savedFile || (options.artifacts ?? []).length > 0) return "artifact-saved";
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
	if (options.confirmationRequired || /confirmation required|pending confirmation|requires confirmation/i.test(text)) return "confirmation-required";
	if (options.timedOut || /timeout|timed out|watchdog|IPC read timeout|must stay under its 30s IPC read timeout/i.test(text)) return "timeout";
	if (/ENOENT|not found on PATH|could not find.*agent-browser|agent-browser is required but was not found/i.test(text)) return "missing-binary";
	if (options.parseError || /invalid JSON|missing boolean success|success field must be boolean|returned no JSON output/i.test(text)) return "parse-failure";
	if (/aborted/i.test(text)) return "aborted";
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
	if (reportsSelectorMatchFailure) return "selector-not-found";
	if ((command === "download" || text.includes("wait --download") || /\bdownload\b/i.test(text)) && /missing|not verified|not found|failed|timeout|timed out/i.test(text)) {
		return "download-not-verified";
	}
	if (options.validationError) return "validation-error";
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

export function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function compareRefIds(left: string, right: string): number {
	const leftMatch = left.match(/^(?:[a-zA-Z]+)?(\d+)$/);
	const rightMatch = right.match(/^(?:[a-zA-Z]+)?(\d+)$/);
	if (leftMatch && rightMatch) {
		return Number(leftMatch[1]) - Number(rightMatch[1]);
	}
	return left.localeCompare(right);
}
