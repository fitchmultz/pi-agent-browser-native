import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./parsing.js";
import { redactSensitiveValue } from "./runtime-redaction.js";
import {
	type SessionPageStateView,
	type SessionRefSnapshot,
	buildPageTransitionRefSnapshotInvalidation,
	targetsMatch,
} from "./session-page-observation.js";
import {
	getSessionArtifactManifestEntryKey,
	isPendingRecordingArtifact,
	isSessionArtifactManifest,
} from "./results/artifact-manifest.js";
import type { SessionArtifactManifest, SessionArtifactManifestEntry } from "./results/contracts.js";
import { extractAgentBrowserLifecycle } from "./results/presentation/common.js";

import {
	BROWSER_TRANSITION_ENTRY,
	BROWSER_STATE_FIELDS,
	type BrowserSnapshot,
	type BrowserRecord,
	type BrowserPageChange,
	type BrowserArtifactChanges,
} from "./browser-transcript-contracts.js";
export {
	BROWSER_TRANSITION_ENTRY,
	BROWSER_STATE_FIELDS,
	BROWSER_RESULT_TOOLS,
} from "./browser-transcript-contracts.js";
const BROWSER_EVENT_VERSION = 1;

export type {
	BrowserSnapshot,
	BrowserRefDisposition,
	BrowserPageChange,
	BrowserArtifactChanges,
	BrowserEvent,
	BrowserRecord,
} from "./browser-transcript-contracts.js";
import {
	parseBrowserEvent,
	decodeBrowserTarget,
	isBrowserSnapshotReference,
	isNamedBrowserSnapshotReference,
} from "./browser-transcript-validation.js";

export function browserStateEffects(
	details: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const state = Object.fromEntries(
		BROWSER_STATE_FIELDS.filter((key) => details[key] !== undefined).map((key) => [
			key,
			details[key],
		]),
	);
	if (Array.isArray(details.batchSteps)) {
		state.batchSteps = details.batchSteps.filter(isRecord).map((step) => ({
			command: step.command,
			success: step.success,
			lifecycle: extractAgentBrowserLifecycle(step),
		}));
	}
	if (
		isRecord(details.electron) &&
		(details.electron.launch !== undefined || details.electron.cleanup !== undefined)
	) {
		state.electron = { launch: details.electron.launch, cleanup: details.electron.cleanup };
	}
	return state;
}

export function getBrowserRecord(entry: unknown): BrowserRecord | undefined {
	if (!isRecord(entry) || !isRecord(entry.data)) {
		return undefined;
	}
	if (
		entry.type !== "message" &&
		!(entry.type === "custom" && entry.customType === BROWSER_TRANSITION_ENTRY)
	) {
		return undefined;
	}
	const event = entry.data.event;
	if (!isRecord(event) || event.version !== BROWSER_EVENT_VERSION) {
		return undefined;
	}
	return { ...entry.data, event: parseBrowserEvent(event) };
}

/** Replay boundaries normalize legacy receipts before this canonical reducer reads them. */
export function getBrowserResultMessage(entry: unknown): Record<string, unknown> | undefined {
	const record = getBrowserRecord(entry);
	return record
		? {
				details: record.event.state,
				isError:
					typeof record.event.state.nativeSucceeded === "boolean"
						? !record.event.state.nativeSucceeded
						: record.event.isError,
			}
		: undefined;
}

export function snapshotDefinition(snapshot: SessionRefSnapshot): BrowserSnapshot {
	if (snapshot.snapshotId === undefined || snapshot.snapshotId.length === 0) {
		throw new Error("A snapshot capture must have an identity before publication.");
	}
	return {
		id: snapshot.snapshotId,
		refs: Object.fromEntries(snapshot.refIds.map((id) => [id, snapshot.refs?.[id] ?? {}])),
		target: snapshot.target,
		generation: snapshot.generation,
	};
}

function snapshotMetadataValid(definition: Readonly<Record<string, unknown>>): boolean {
	return (
		(definition.target === undefined || decodeBrowserTarget(definition.target) !== undefined) &&
		(definition.generation === undefined || typeof definition.generation === "string")
	);
}

const SNAPSHOT_REF_ID = /^e\d+$/;

function snapshotReferencesValid(refs: Readonly<Record<string, unknown>>): boolean {
	return Object.keys(refs).every(
		(id) => SNAPSHOT_REF_ID.test(id) && isBrowserSnapshotReference(refs[id]),
	);
}

/** Validates a once-stored definition in one ordered own-key pass without building its ref map. */
export function assertSnapshotDefinition(
	definition: unknown,
): asserts definition is BrowserSnapshot {
	if (
		!isRecord(definition) ||
		typeof definition.id !== "string" ||
		definition.id.length === 0 ||
		!isRecord(definition.refs) ||
		!snapshotMetadataValid(definition) ||
		!snapshotReferencesValid(definition.refs)
	) {
		throw new Error(
			"Missing or invalid browser snapshot definition; take a new complete snapshot before using refs.",
		);
	}
}

export function snapshotFromDefinition(definition: unknown): SessionRefSnapshot {
	assertSnapshotDefinition(definition);
	const refIds = Object.keys(definition.refs);
	const refs: Record<string, NonNullable<SessionRefSnapshot["refs"]>[string]> = {};
	let named = false;
	for (const id of refIds) {
		const ref = definition.refs[id];
		if (isNamedBrowserSnapshotReference(ref)) {
			refs[id] = ref;
			named = true;
		}
	}
	return {
		snapshotId: definition.id,
		refIds,
		...(named ? { refs } : {}),
		target: definition.target === undefined ? undefined : decodeBrowserTarget(definition.target),
		generation: typeof definition.generation === "string" ? definition.generation : undefined,
	};
}

function driftedRefDisposition(page: SessionPageStateView): BrowserPageChange["refs"] {
	return {
		kind: "invalidate",
		invalidation: buildPageTransitionRefSnapshotInvalidation(
			`The saved refs came from a snapshot for ${page.refSnapshot?.target?.url ?? "unknown"}; the current session target is ${page.tabTarget?.url ?? "unknown"}. Take a fresh snapshot before using page-scoped refs.`,
		),
	};
}
function pageRefDisposition(
	page: SessionPageStateView,
	previousSnapshotId: string | undefined,
): BrowserPageChange["refs"] {
	if (page.tabTargetUnknown === true) {
		return { kind: "unknown", invalidation: page.refSnapshotInvalidation };
	}
	if (page.refSnapshot && !targetsMatch(page.refSnapshot.target, page.tabTarget)) {
		return driftedRefDisposition(page);
	}
	const id = page.refSnapshot?.snapshotId;
	if (id !== undefined && id.length > 0) {
		return { kind: id === previousSnapshotId ? "reuse" : "replace", snapshotId: id };
	}
	return { kind: "invalidate", invalidation: page.refSnapshotInvalidation };
}

export function pageChange(
	key: string,
	page: SessionPageStateView,
	previousSnapshotId?: string,
): BrowserPageChange {
	return {
		key,
		confirmActions: page.confirmActions ?? null,
		target: page.tabTarget,
		unknown: page.tabTargetUnknown,
		reopenPending: page.tabReopenPending,
		pinningReason: page.pinningReason,
		refs: pageRefDisposition(page, previousSnapshotId),
	};
}

function indexedArtifacts(
	manifest: SessionArtifactManifest | undefined,
): Map<string, SessionArtifactManifestEntry> {
	return new Map(
		(manifest?.entries ?? []).map((row) => [getSessionArtifactManifestEntryKey(row), row]),
	);
}

function redactedArtifact(row: SessionArtifactManifestEntry): SessionArtifactManifestEntry {
	const manifest = {
		version: 1,
		entries: [redactSensitiveValue(row)],
		maxEntries: 1,
		updatedAtMs: row.createdAtMs,
		liveCount: 0,
		evictedCount: 0,
	};
	if (!isSessionArtifactManifest(manifest)) {
		throw new Error("Redacted browser artifact has no valid manifest receipt.");
	}
	return manifest.entries[0];
}

export function artifactChanges(
	previous: SessionArtifactManifest | undefined,
	next: SessionArtifactManifest | undefined,
): BrowserArtifactChanges | undefined {
	if (previous === next) {
		return undefined;
	}
	const before = indexedArtifacts(previous);
	const after = indexedArtifacts(next);
	const upserts = [...after]
		.filter(([key, row]) => JSON.stringify(before.get(key)) !== JSON.stringify(row))
		.map(([, row]) => redactedArtifact(row));
	const removals = [...before.keys()].filter((key) => !after.has(key));
	return upserts.length > 0 || removals.length > 0
		? {
				upserts,
				removals,
				maxEntries: (next ?? previous)?.maxEntries ?? 100,
				updatedAtMs: next?.updatedAtMs ?? Date.now(),
			}
		: undefined;
}

export function applyArtifactChanges(
	previous: SessionArtifactManifest | undefined,
	changes: BrowserArtifactChanges | undefined,
): SessionArtifactManifest | undefined {
	if (!changes) {
		return previous;
	}
	const rows = new Map(
		(previous?.entries ?? []).map((row) => [getSessionArtifactManifestEntryKey(row), row]),
	);
	for (const key of changes.removals) {
		rows.delete(key);
	}
	for (const row of changes.upserts) {
		rows.set(getSessionArtifactManifestEntryKey(row), row);
	}
	const entries = [...rows.values()]
		.sort((a, b) => {
			const age = (b.evictedAtMs ?? b.createdAtMs) - (a.evictedAtMs ?? a.createdAtMs);
			if (age !== 0) {
				return age;
			}
			const pending = Number(isPendingRecordingArtifact(b)) - Number(isPendingRecordingArtifact(a));
			return pending !== 0 ? pending : a.path.localeCompare(b.path);
		})
		.slice(0, changes.maxEntries);
	const manifest = {
		version: 1,
		entries,
		maxEntries: changes.maxEntries,
		updatedAtMs: changes.updatedAtMs,
		liveCount: entries.filter((row) => row.retentionState === "live").length,
		evictedCount: entries.filter((row) => row.retentionState === "evicted").length,
	};
	if (!isSessionArtifactManifest(manifest)) {
		throw new Error("Invalid browser artifact changes; inspect the retained journal.");
	}
	return entries.length > 0 ? manifest : undefined;
}

export function appendBrowserTransition(pi: ExtensionAPI, record: BrowserRecord): void {
	pi.appendEntry(BROWSER_TRANSITION_ENTRY, record);
}
