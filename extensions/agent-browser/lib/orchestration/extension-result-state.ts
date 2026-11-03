import { format } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SessionPageState, SessionPageStateView } from "../session-page-state.js";
import {
	applyArtifactChanges,
	artifactChanges,
	artifactReceipt,
	getBrowserRecord,
	pageChange,
	snapshotDefinition,
	type BrowserRecord,
} from "../browser-transcript.js";
import { redactSensitiveText } from "../runtime.js";
import { isRecord } from "../parsing.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";
import type {
	AgentBrowserFailureCategory,
	FileArtifactMetadata,
	SessionArtifactManifest,
} from "../results/contracts.js";
import { getSessionArtifactManifestEntryKey } from "../results/artifact-manifest.js";

export function browserExecutionFailure(
	error: unknown,
	signal?: AbortSignal,
	fallbackCategory: AgentBrowserFailureCategory = "upstream-error",
): AgentBrowserToolResult {
	const timeout = error instanceof Error && error.name === "TimeoutError";
	const summary = redactSensitiveText(error instanceof Error ? error.message : format("%s", error));
	let failureCategory = fallbackCategory;
	if (signal?.aborted === true) {
		failureCategory = "aborted";
	}
	if (timeout) {
		failureCategory = "timeout";
	}
	return {
		content: [{ type: "text", text: summary }],
		details: { error: summary, summary, resultCategory: "failure", failureCategory },
		isError: true,
	};
}

export function isResultFileArtifact(artifact: unknown): artifact is FileArtifactMetadata {
	return (
		isRecord(artifact) &&
		typeof artifact.absolutePath === "string" &&
		typeof artifact.kind === "string" &&
		typeof artifact.path === "string"
	);
}

export function getResultFileArtifacts(result: AgentToolResult<unknown>): FileArtifactMetadata[] {
	const details = isRecord(result.details) ? result.details : undefined;
	return Array.isArray(details?.artifacts) ? details.artifacts.filter(isResultFileArtifact) : [];
}

function rowArtifactPaths(row: Readonly<Record<string, unknown>>): string[] {
	const paths: string[] = [];
	if (typeof row.fullOutputPath === "string") {
		paths.push(row.fullOutputPath);
	}
	for (const path of Array.isArray(row.fullOutputPaths) ? row.fullOutputPaths : []) {
		if (typeof path === "string") {
			paths.push(path);
		}
	}
	for (const artifact of Array.isArray(row.artifacts) ? row.artifacts.filter(isRecord) : []) {
		if (typeof artifact.absolutePath === "string") {
			paths.push(artifact.absolutePath);
		}
		if (typeof artifact.path === "string") {
			paths.push(artifact.path);
		}
	}
	return paths;
}

export function invocationArtifactManifest(
	current: SessionArtifactManifest | undefined,
	previous: SessionArtifactManifest | undefined,
	details: Readonly<Record<string, unknown>>,
	retainedReceipts?: SessionArtifactManifest,
): SessionArtifactManifest | undefined {
	if (!current) {
		return undefined;
	}
	const rows = [
		details,
		...(Array.isArray(details.batchSteps) ? details.batchSteps.filter(isRecord) : []),
	];
	const paths = new Set(rows.flatMap(rowArtifactPaths));
	const changed = new Set(
		(artifactChanges(previous, current)?.upserts ?? []).map(getSessionArtifactManifestEntryKey),
	);
	for (const row of retainedReceipts?.entries ?? []) {
		changed.add(getSessionArtifactManifestEntryKey(row));
	}
	const entries = current.entries.filter(
		(row) =>
			changed.has(getSessionArtifactManifestEntryKey(row)) ||
			paths.has(row.path) ||
			(row.absolutePath !== undefined && paths.has(row.absolutePath)),
	);
	if (entries.length === 0) {
		return undefined;
	}
	// Returned receipts keep identities, so later observation selection reaches the private rows.
	return {
		...current,
		entries: entries.map(artifactReceipt),
		liveCount: entries.filter((row) => row.retentionState === "live").length,
		evictedCount: entries.filter((row) => row.retentionState === "evicted").length,
	};
}

export function restoreArtifactManifestFromBranch(
	branch: readonly unknown[],
): SessionArtifactManifest | undefined {
	let restoredManifest: SessionArtifactManifest | undefined;
	for (const entry of branch) {
		restoredManifest = applyArtifactChanges(
			restoredManifest,
			getBrowserRecord(entry)?.event.artifacts,
		);
	}
	return restoredManifest;
}

function pageViewChanged(
	key: string,
	page: Readonly<SessionPageStateView>,
	before: Readonly<SessionPageStateView> | undefined,
): boolean {
	return (
		JSON.stringify(pageChange(key, page, before?.refSnapshot?.snapshotId)) !==
		JSON.stringify(pageChange(key, before ?? {}, before?.refSnapshot?.snapshotId))
	);
}
export function browserPageChanges(
	working: SessionPageState,
	prior: ReadonlyMap<string, SessionPageStateView>,
	touched: readonly string[],
): {
	readonly snapshot?: ReturnType<typeof snapshotDefinition>;
	readonly pages: NonNullable<BrowserRecord["event"]["pages"]>;
} {
	const pages = working.views();
	const keys = new Set(touched);
	for (const [key, page] of pages) {
		const before = prior.get(key);
		if (pageViewChanged(key, page, before)) {
			keys.add(key);
		}
	}
	for (const key of prior.keys()) {
		if (!pages.has(key)) {
			keys.add(key);
		}
	}
	const changes = [...keys].map((key) => {
		const page = pages.get(key);
		return page
			? pageChange(key, page, prior.get(key)?.refSnapshot?.snapshotId)
			: { key, refs: { kind: "invalidate" as const }, clear: true as const };
	});
	const capture = changes.find((page) => page.refs.kind === "replace");
	const snapshot = capture ? pages.get(capture.key)?.refSnapshot : undefined;
	return { pages: changes, ...(snapshot ? { snapshot: snapshotDefinition(snapshot) } : {}) };
}
