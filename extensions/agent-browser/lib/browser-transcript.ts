import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./parsing.js";
import { redactSensitiveValue } from "./runtime.js";
import type { SessionPageStateView, SessionRefSnapshot, SessionRefSnapshotInvalidation, SessionTabTarget } from "./session-page-state.js";
import { buildPageTransitionRefSnapshotInvalidation, normalizeSessionTabTarget, targetsMatch } from "./session-page-state.js";
import { getSessionArtifactManifestEntryKey, isPendingRecordingArtifact, isSessionArtifactManifest } from "./results/artifact-manifest.js";
import type { SessionArtifactManifest, SessionArtifactManifestEntry } from "./results/contracts.js";
import { extractAgentBrowserLifecycle } from "./results/presentation/common.js";

export const BROWSER_TRANSITION_ENTRY = "agent-browser-transition";
const BROWSER_EVENT_VERSION = 1;
export const BROWSER_RESULT_TOOLS = new Set([
	"agent_browser", "agent_browser_code", "agent_browser_action", "agent_browser_qa", "agent_browser_electron",
	"agent_browser_source", "agent_browser_network_source",
]);

export interface BrowserSnapshot {
	id: string;
	refs: Record<string, { isContentEditable?: boolean; isEditable?: boolean; name?: string; role?: string }>;
	target?: SessionTabTarget;
	generation?: string;
}

export type BrowserRefDisposition =
	| { kind: "reuse"; snapshotId: string }
	| { kind: "replace"; snapshotId: string }
	| { kind: "invalidate"; invalidation?: SessionRefSnapshotInvalidation }
	| { kind: "unknown"; invalidation?: SessionRefSnapshotInvalidation };

export interface BrowserPageChange {
	key: string;
	confirmActions?: string | null;
	refs: BrowserRefDisposition;
	target?: SessionTabTarget;
	unknown?: true;
	reopenPending?: boolean;
	pinningReason?: "drift" | "restore";
	clear?: true;
}

export interface BrowserArtifactChanges {
	upserts: SessionArtifactManifestEntry[];
	removals: string[];
	maxEntries: number;
	updatedAtMs: number;
}

export interface BrowserEvent {
	version: 1;
	phase: "begin" | "finish" | "state";
	operationId: string;
	toolCallId: string;
	commandIndex: number;
	isError: boolean;
	state: Record<string, unknown>;
	pages?: BrowserPageChange[];
	artifacts?: BrowserArtifactChanges;
}

export interface BrowserRecord {
	event: BrowserEvent;
	snapshot?: BrowserSnapshot;
}

// These are small native lifecycle/ownership receipts, not rendered page data.
export const BROWSER_STATE_FIELDS = [
	"args", "command", "subcommand", "sessionName", "namespace", "sessionMode", "usedImplicitSession",
	"managedSessionSocketDir",
	"managedSessionDaemon", "ownerSessionId",
	"agentBrowserStarted", "resultCategory", "exitCode", "closeAllApplied", "attachedBrowserSession",
	"readConfirmation", "compatibilityWorkaround", "managedSessionHeadedAutosaveDisabled", "managedSessionHeadedAutosaveInterval",
	"managedSessionOutcome", "managedSessionCwd", "managedSessionRestoreDisabled",
	"nativeSucceeded",
] as const;

export function browserStateEffects(details: Record<string, unknown>): Record<string, unknown> {
	const state = Object.fromEntries(BROWSER_STATE_FIELDS.filter(key => details[key] !== undefined).map(key => [key, details[key]]));
	if (Array.isArray(details.batchSteps)) state.batchSteps = details.batchSteps.filter(isRecord).map(step => ({
		command: step.command, success: step.success, lifecycle: extractAgentBrowserLifecycle(step),
	}));
	if (isRecord(details.electron) && (details.electron.launch !== undefined || details.electron.cleanup !== undefined)) {
		state.electron = { launch: details.electron.launch, cleanup: details.electron.cleanup };
	}
	return state;
}

export function getBrowserRecord(entry: unknown): BrowserRecord | undefined {
	if (!isRecord(entry) || !isRecord(entry.data)) return undefined;
	if (entry.type !== "message" && !(entry.type === "custom" && entry.customType === BROWSER_TRANSITION_ENTRY)) return undefined;
	const event = entry.data.event;
	if (!isRecord(event) || event.version !== BROWSER_EVENT_VERSION) return undefined;
	if (!["begin", "finish", "state"].includes(String(event.phase)) || typeof event.operationId !== "string"
		|| typeof event.toolCallId !== "string" || !Number.isSafeInteger(event.commandIndex) || (event.commandIndex as number) < 0 || typeof event.isError !== "boolean" || !isRecord(event.state)) {
		throw new Error("Invalid browser event; inspect or convert the retained session before browser work.");
	}
	if (event.pages !== undefined && (!Array.isArray(event.pages) || !event.pages.every(page => isRecord(page)
		&& typeof page.key === "string" && isRecord(page.refs) && ["reuse", "replace", "invalidate", "unknown"].includes(String(page.refs.kind))
		&& (page.confirmActions === undefined || page.confirmActions === null || typeof page.confirmActions === "string")
		&& (!["reuse", "replace"].includes(String(page.refs.kind)) || typeof page.refs.snapshotId === "string" && page.refs.snapshotId.length > 0)
		&& (page.target === undefined || isRecord(page.target) && normalizeSessionTabTarget(page.target) !== undefined)
		&& (page.unknown === undefined || page.unknown === true) && (page.clear === undefined || page.clear === true)
		&& (page.reopenPending === undefined || typeof page.reopenPending === "boolean")
		&& (page.pinningReason === undefined || ["restore", "drift"].includes(String(page.pinningReason)))
		&& (page.refs.invalidation === undefined || isRecord(page.refs.invalidation) && ["page-transition", "no-active-page"].includes(String(page.refs.invalidation.reason)) && typeof page.refs.invalidation.summary === "string")))) {
		throw new Error("Invalid browser page disposition; refs cannot be restored.");
	}
	if (event.artifacts !== undefined) {
		const changes = event.artifacts;
		if (!isRecord(changes) || !Array.isArray(changes.removals) || !changes.removals.every(key => typeof key === "string")
			|| !isSessionArtifactManifest({ version: 1, entries: changes.upserts, maxEntries: changes.maxEntries, updatedAtMs: changes.updatedAtMs, liveCount: 0, evictedCount: 0 })) {
			throw new Error("Invalid browser artifact changes; inspect the retained journal.");
		}
	}
	return entry.data as unknown as BrowserRecord;
}

/** Only canonical receipts participate in live replay. Legacy shapes belong to the offline converter. */
export function getBrowserResultMessage(entry: unknown): Record<string, unknown> | undefined {
	const record = getBrowserRecord(entry);
	return record ? { details: record.event.state, isError: typeof record.event.state.nativeSucceeded === "boolean" ? !record.event.state.nativeSucceeded : record.event.isError } : undefined;
}

export function snapshotDefinition(snapshot: SessionRefSnapshot): BrowserSnapshot {
	if (!snapshot.snapshotId) throw new Error("A snapshot capture must have an identity before publication.");
	return {
		id: snapshot.snapshotId,
		refs: Object.fromEntries(snapshot.refIds.map(id => [id, snapshot.refs?.[id] ?? {}])),
		target: snapshot.target,
		generation: snapshot.generation,
	};
}

export function snapshotFromDefinition(definition: BrowserSnapshot): SessionRefSnapshot {
	if (!definition || typeof definition.id !== "string" || definition.id.length === 0 || !isRecord(definition.refs)
		|| definition.target !== undefined && normalizeSessionTabTarget(definition.target) === undefined
		|| definition.generation !== undefined && typeof definition.generation !== "string"
		|| !Object.entries(definition.refs).every(([id, ref]) => /^e\d+$/.test(id) && isRecord(ref)
			&& (ref.role === undefined || typeof ref.role === "string") && (ref.name === undefined || typeof ref.name === "string")
			&& (ref.isEditable === undefined || typeof ref.isEditable === "boolean") && (ref.isContentEditable === undefined || typeof ref.isContentEditable === "boolean"))) {
		throw new Error("Missing or invalid browser snapshot definition; take a new complete snapshot before using refs.");
	}
	const refs = Object.fromEntries(Object.entries(definition.refs).flatMap(([id, ref]) => typeof ref.name === "string" && typeof ref.role === "string" ? [[id, ref as NonNullable<SessionRefSnapshot["refs"]>[string]]] : []));
	return {
		snapshotId: definition.id,
		refIds: Object.keys(definition.refs),
		...(Object.keys(refs).length ? { refs } : {}),
		target: definition.target,
		generation: definition.generation,
	};
}

export function pageChange(key: string, page: SessionPageStateView, previousSnapshotId?: string): BrowserPageChange {
	return {
		key, confirmActions: page.confirmActions ?? null, target: page.tabTarget, unknown: page.tabTargetUnknown, reopenPending: page.tabReopenPending, pinningReason: page.pinningReason,
		refs: page.tabTargetUnknown ? { kind: "unknown", invalidation: page.refSnapshotInvalidation }
			: page.refSnapshot && !targetsMatch(page.refSnapshot.target, page.tabTarget) ? { kind: "invalidate", invalidation: buildPageTransitionRefSnapshotInvalidation(`The saved refs came from a snapshot for ${page.refSnapshot.target?.url}; the current session target is ${page.tabTarget?.url}. Take a fresh snapshot before using page-scoped refs.`) }
			: page.refSnapshot?.snapshotId ? { kind: page.refSnapshot.snapshotId === previousSnapshotId ? "reuse" : "replace", snapshotId: page.refSnapshot.snapshotId }
			: { kind: "invalidate", invalidation: page.refSnapshotInvalidation },
	};
}

export function artifactChanges(previous: SessionArtifactManifest | undefined, next: SessionArtifactManifest | undefined): BrowserArtifactChanges | undefined {
	if (previous === next) return undefined;
	const before = new Map((previous?.entries ?? []).map(row => [getSessionArtifactManifestEntryKey(row), row]));
	const after = new Map((next?.entries ?? []).map(row => [getSessionArtifactManifestEntryKey(row), row]));
	const upserts = [...after].filter(([key, row]) => JSON.stringify(before.get(key)) !== JSON.stringify(row)).map(([, row]) => redactSensitiveValue(row) as typeof row);
	const removals = [...before.keys()].filter(key => !after.has(key));
	return upserts.length || removals.length ? { upserts, removals, maxEntries: next?.maxEntries ?? previous?.maxEntries ?? 100, updatedAtMs: next?.updatedAtMs ?? Date.now() } : undefined;
}

export function applyArtifactChanges(previous: SessionArtifactManifest | undefined, changes: BrowserArtifactChanges | undefined): SessionArtifactManifest | undefined {
	if (!changes) return previous;
	const rows = new Map((previous?.entries ?? []).map(row => [getSessionArtifactManifestEntryKey(row), row]));
	for (const key of changes.removals) rows.delete(key);
	for (const row of changes.upserts) rows.set(getSessionArtifactManifestEntryKey(row), row);
	const entries = [...rows.values()].sort((a, b) => (b.evictedAtMs ?? b.createdAtMs) - (a.evictedAtMs ?? a.createdAtMs)
		|| Number(isPendingRecordingArtifact(b)) - Number(isPendingRecordingArtifact(a)) || a.path.localeCompare(b.path)).slice(0, changes.maxEntries);
	const manifest = { version: 1, entries, maxEntries: changes.maxEntries, updatedAtMs: changes.updatedAtMs,
		liveCount: entries.filter(row => row.retentionState === "live").length, evictedCount: entries.filter(row => row.retentionState === "evicted").length };
	if (!isSessionArtifactManifest(manifest)) throw new Error("Invalid browser artifact changes; inspect the retained journal.");
	return entries.length ? manifest : undefined;
}

export function appendBrowserTransition(pi: ExtensionAPI, record: BrowserRecord): void {
	pi.appendEntry(BROWSER_TRANSITION_ENTRY, record);
}
