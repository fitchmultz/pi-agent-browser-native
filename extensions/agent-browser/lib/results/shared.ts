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

export type AgentBrowserSuccessCategory = "artifact-saved" | "artifact-unverified" | "completed" | "inspection";

export type AgentBrowserFailureCategory =
	| "aborted"
	| "cleanup-failed"
	| "confirmation-required"
	| "download-not-verified"
	| "missing-binary"
	| "parse-failure"
	| "policy-blocked"
	| "qa-failure"
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

export interface AgentBrowserPageChangeSummary {
	artifactCount?: number;
	changeType: "artifact" | "confirmation" | "mutation" | "navigation";
	command?: string;
	nextActionIds?: string[];
	savedFilePath?: string;
	summary: string;
	title?: string;
	url?: string;
}

export interface AgentBrowserNextAction {
	artifactPath?: string;
	id: string;
	params?: {
		args?: string[];
		electron?: {
			action: "cleanup" | "list" | "launch" | "probe" | "status";
			all?: boolean;
			handoff?: "connect" | "snapshot" | "tabs";
			launchId?: string;
		};
		networkSourceLookup?: {
			filter?: string;
			requestId?: string;
			session?: string;
			url?: string;
		};
		sessionMode?: "auto" | "fresh";
		stdin?: string;
	};
	reason: string;
	safety?: string;
	tool: "agent_browser";
}

export type AgentBrowserRecoveryKind = "about-blank" | "connected-session" | "no-active-page" | "tab-drift";

export interface AgentBrowserRecoveryContext {
	kind: AgentBrowserRecoveryKind;
	recoveryApplied?: boolean;
	selectedTab?: string;
	sessionName?: string;
	targetTitle?: string;
	targetUrl?: string;
}

// Runtime source of truth for recovery-oriented nextAction ids. Docs and tests should mirror these registries/helpers instead of inventing ids in prose.
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

const EDITABLE_REF_EVIDENCE_KEYS = ["editable", "contentEditable", "contenteditable", "isContentEditable"] as const;
const EDITABLE_FALSE_TEXT_PATTERN = /\b(?:contenteditable|editable)\s*=\s*["']?(?:false|0)["']?/i;
const EDITABLE_ASSIGNMENT_TEXT_PATTERN = /\b(contenteditable|editable)\s*=\s*("[^"]*"|'[^']*'|[^\s,\]]+)/gi;
const EDITABLE_BARE_TEXT_PATTERN = /\b(?:contenteditable|editable)\b(?!\s*=)/i;

function parseEditableEvidenceValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return undefined;
	}
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().replace(/^["']|["']$/g, "").toLowerCase();
	if (["false", "0", "no"].includes(normalized)) return false;
	if (["", "true", "1", "yes", "plaintext-only"].includes(normalized)) return true;
	return undefined;
}

function stripLeadingSnapshotAccessibleName(text: string): string {
	return text.replace(/^(\s*[-*]\s+\S+\s+)(?:"[^"]*"|'[^']*')/, "$1");
}

function parseEditableEvidenceText(text: string | undefined): boolean | undefined {
	if (!text) return undefined;
	const markerText = stripLeadingSnapshotAccessibleName(text);
	if (EDITABLE_FALSE_TEXT_PATTERN.test(markerText)) return false;
	let hasPositiveAssignment = false;
	for (const match of markerText.matchAll(EDITABLE_ASSIGNMENT_TEXT_PATTERN)) {
		const key = match[1]?.toLowerCase();
		const evidence = parseEditableEvidenceValue(match[2]);
		if (evidence === false) return false;
		if (evidence === true && (key === "contenteditable" || key === "editable")) {
			hasPositiveAssignment = true;
		}
	}
	if (hasPositiveAssignment) return true;
	return EDITABLE_BARE_TEXT_PATTERN.test(markerText) ? true : undefined;
}

export function getEditableRefEvidence(options: {
	ref?: Record<string, unknown>;
	text?: string;
}): boolean | undefined {
	let hasPositiveEvidence = false;
	if (options.ref) {
		for (const key of EDITABLE_REF_EVIDENCE_KEYS) {
			const evidence = parseEditableEvidenceValue(options.ref[key]);
			if (evidence === false) return false;
			if (evidence === true) hasPositiveEvidence = true;
		}
	}
	const textEvidence = parseEditableEvidenceText(options.text);
	if (textEvidence === false) return false;
	if (textEvidence === true) hasPositiveEvidence = true;
	return hasPositiveEvidence ? true : undefined;
}

export function hasPositiveEditableRefEvidence(options: {
	ref?: Record<string, unknown>;
	text?: string;
}): boolean {
	return getEditableRefEvidence(options) === true;
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

export type ArtifactVerificationState = "missing" | "pending" | "unverified" | "verified";

export interface ArtifactVerificationEntry {
	absolutePath?: string;
	exists?: boolean;
	kind: FileArtifactKind | "spill";
	limitation?: string;
	mediaType?: string;
	path: string;
	requestedPath?: string;
	retentionState?: ArtifactRetentionState;
	sizeBytes?: number;
	state: ArtifactVerificationState;
	status?: FileArtifactStatus;
	storageScope?: ArtifactStorageScope;
}

export interface ArtifactVerificationSummary {
	artifacts: ArtifactVerificationEntry[];
	missingCount: number;
	pendingCount: number;
	unverifiedCount: number;
	verified: boolean;
	verifiedCount: number;
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
	artifactVerification?: ArtifactVerificationSummary;
	artifacts?: FileArtifactMetadata[];
	command?: string[];
	commandText: string;
	data?: unknown;
	failureCategory?: AgentBrowserFailureCategory;
	nextActions?: AgentBrowserNextAction[];
	pageChangeSummary?: AgentBrowserPageChangeSummary;
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
	artifactVerification?: ArtifactVerificationSummary;
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
	nextActions?: AgentBrowserNextAction[];
	pageChangeSummary?: AgentBrowserPageChangeSummary;
	resultCategory?: AgentBrowserResultCategory;
	savedFile?: SavedFilePresentationDetails;
	savedFilePath?: string;
	successCategory?: AgentBrowserSuccessCategory;
	summary: string;
}

function isPendingFileArtifact(artifact: FileArtifactMetadata): boolean {
	return artifact.command === "record" && artifact.subcommand === "start" && artifact.kind === "video";
}

function hasUnverifiedFileArtifact(artifacts: FileArtifactMetadata[] | undefined): boolean {
	return (artifacts ?? []).some((artifact) => !isPendingFileArtifact(artifact) && artifact.exists !== true);
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
	if (options.confirmationRequired || /confirmation required|pending confirmation|requires confirmation/i.test(text)) return "confirmation-required";
	if (options.timedOut || /timeout|timed out|watchdog|IPC read timeout|must stay under its 30s IPC read timeout/i.test(text)) return "timeout";
	if (/ENOENT|not found on PATH|could not find.*agent-browser|agent-browser is required but was not found/i.test(text)) return "missing-binary";
	if (options.parseError || /invalid JSON|missing boolean success|success field must be boolean|returned no JSON output/i.test(text)) return "parse-failure";
	if (/aborted/i.test(text)) return "aborted";
	if (/policy[- ]blocked|blocked by caller policy|caller deny policy|caller allow policy/i.test(text)) return "policy-blocked";
	if (/cleanup failed|cleanup.*partial|partial cleanup|remaining resources/i.test(text)) return "cleanup-failed";
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
	if (options.validationError) return "validation-error";
	return "upstream-error";
}

function buildNextToolAction(options: {
	args: string[];
	id: string;
	reason: string;
	safety?: string;
	sessionMode?: "auto" | "fresh";
	stdin?: string;
}): AgentBrowserNextAction {
	return {
		id: options.id,
		params: {
			args: options.args,
			...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
			...(options.stdin ? { stdin: options.stdin } : {}),
		},
		reason: options.reason,
		...(options.safety ? { safety: options.safety } : {}),
		tool: "agent_browser",
	};
}

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

function withSessionPrefix(sessionName: string | undefined, args: string[]): string[] {
	return sessionName && args[0] !== "--session" ? ["--session", sessionName, ...args] : args;
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

function buildRecoveryNextActions(recovery: AgentBrowserRecoveryContext): AgentBrowserNextAction[] {
	const sessionArgs = (args: string[]) => withSessionPrefix(recovery.sessionName, args);
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

const MUTATING_COMMANDS = new Set([
	"back",
	"check",
	"click",
	"dblclick",
	"dialog",
	"fill",
	"forward",
	"hover",
	"press",
	"pushstate",
	"reload",
	"scroll",
	"scrollintoview",
	"select",
	"swipe",
	"tap",
	"type",
	"uncheck",
]);

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
		if (options.command === "open") {
			actions.push(buildNextToolAction({
				args: ["snapshot", "-i"],
				id: "inspect-opened-page",
				reason: "Inspect the opened page before choosing interactive refs.",
			}));
		} else if (options.command && MUTATING_COMMANDS.has(options.command)) {
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
			if (isPendingFileArtifact(artifact)) {
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

export type NetworkFailureImpact = "actionable" | "benign";

export interface NetworkFailureClassification {
	impact: NetworkFailureImpact;
	reason: string;
	resourceType?: string;
	status?: number;
	url?: string;
}

export interface NetworkFailureSummary {
	actionableCount: number;
	benignCount: number;
	failures: NetworkFailureClassification[];
	totalCount: number;
}

function getStringRecordField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function getNetworkRequestUrlPath(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).pathname;
	} catch {
		const withoutQuery = url.split(/[?#]/, 1)[0];
		return withoutQuery.length > 0 ? withoutQuery : undefined;
	}
}

function isFailedNetworkRequest(request: Record<string, unknown>): boolean {
	return (typeof request.status === "number" && request.status >= 400) || request.failed === true || typeof request.error === "string";
}

function isBenignAssetFailure(request: Record<string, unknown>, url: string | undefined, resourceType: string | undefined): boolean {
	const path = getNetworkRequestUrlPath(url);
	if (!path) return false;
	const normalizedResourceType = resourceType?.toLowerCase();
	return /(?:^|\/)(?:favicon(?:[-.\w]*)?\.(?:ico|png|svg)|apple-touch-icon(?:[-.\w]*)?\.png)$/i.test(path)
		&& (request.status === 404 || request.failed === true || typeof request.error === "string")
		&& (!normalizedResourceType || ["image", "img", "other"].includes(normalizedResourceType) || normalizedResourceType.startsWith("image/"));
}

export function classifyNetworkRequestFailure(request: Record<string, unknown>): NetworkFailureClassification | undefined {
	if (!isFailedNetworkRequest(request)) return undefined;
	const url = getStringRecordField(request, "url");
	const resourceType = getStringRecordField(request, "resourceType") ?? getStringRecordField(request, "mimeType");
	const status = typeof request.status === "number" ? request.status : undefined;
	if (isBenignAssetFailure(request, url, resourceType)) {
		return { impact: "benign", reason: "low-impact browser icon asset", resourceType, status, url };
	}
	return { impact: "actionable", reason: "document, script, API, or non-benign request failure", resourceType, status, url };
}

export function summarizeNetworkFailures(requests: unknown[]): NetworkFailureSummary {
	const failures = requests.flatMap((request) => {
		if (!isRecord(request)) return [];
		const classification = classifyNetworkRequestFailure(request);
		return classification ? [classification] : [];
	});
	const benignCount = failures.filter((failure) => failure.impact === "benign").length;
	return {
		actionableCount: failures.length - benignCount,
		benignCount,
		failures,
		totalCount: failures.length,
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
