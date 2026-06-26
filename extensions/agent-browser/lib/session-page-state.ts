/**
 * Purpose: Own wrapper-known per-session browser page target, ref snapshot, invalidation, and pinning state.
 * Responsibilities: Restore state from persisted tool details, apply ordered tab/ref updates atomically, and expose order-free public state views to the extension entrypoint.
 * Scope: Session page state only; browser process execution, tab probing, and presentation policies stay in the extension entrypoint.
 * Usage: `index.ts` creates one store per Pi session lifecycle and records observations through update tokens.
 * Invariants/Assumptions: One tool-call update token must govern all page-state observations from that invocation; stale overlapping updates must not overwrite newer state.
 */

import { isCloseCommand, isReadOnlyDiagnosticSessionTargetCommand } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";
import { getEditableRefEvidence } from "./results/editable-ref-evidence.js";
import { enrichSnapshotRefEntries, getSnapshotRefEntries } from "./results/snapshot-refs.js";
import { parseSnapshotLines } from "./results/snapshot-segments.js";

export interface SessionTabTarget {
	title?: string;
	url: string;
}

interface OrderedSessionTabTarget {
	order: number;
	target: SessionTabTarget;
}

export interface SessionRefSnapshot {
	refIds: string[];
	refs?: Record<string, { isContentEditable?: boolean; isEditable?: boolean; name: string; role: string }>;
	target?: SessionTabTarget;
}

interface OrderedSessionRefSnapshot extends SessionRefSnapshot {
	order: number;
}

export interface SessionRefSnapshotInvalidation {
	reason: "no-active-page";
	summary: string;
}

interface OrderedSessionRefSnapshotInvalidation extends SessionRefSnapshotInvalidation {
	order: number;
}

export interface BatchRefSnapshotState {
	invalidation?: SessionRefSnapshotInvalidation;
	snapshot?: SessionRefSnapshot;
}

export type SessionTabPinningReason = "drift" | "restore";

export type SessionPageStateUpdateToken = number & { readonly __sessionPageStateUpdateToken: unique symbol };

export interface SessionPageStateView {
	pinningReason?: SessionTabPinningReason;
	refSnapshot?: SessionRefSnapshot;
	refSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	tabTarget?: SessionTabTarget;
}

export interface SessionPageStateUpdateResult extends SessionPageStateView {
	applied: boolean;
	stale?: boolean;
}

export function normalizeComparableUrl(url: string | undefined): string | undefined {
	const normalizedUrl = url?.trim();
	if (!normalizedUrl) {
		return undefined;
	}
	try {
		const parsedUrl = new URL(normalizedUrl);
		parsedUrl.hash = "";
		return parsedUrl.toString();
	} catch {
		return undefined;
	}
}

export function normalizeSessionTabTarget(target: { title?: string; url?: string } | undefined): SessionTabTarget | undefined {
	if (!target) {
		return undefined;
	}
	const url = normalizeComparableUrl(target.url);
	if (!url) {
		return undefined;
	}
	const title = target.title?.trim();
	return { title: title && title.length > 0 ? title : undefined, url };
}

export function isAboutBlankUrl(url: string | undefined): boolean {
	return normalizeComparableUrl(url) === "about:blank";
}

export function isAboutBlankSessionTabTarget(target: SessionTabTarget | undefined): boolean {
	return isAboutBlankUrl(target?.url);
}

export function commandExplicitlyTargetsAboutBlank(commandTokens: string[]): boolean {
	return commandTokens.some((token) => isAboutBlankUrl(token));
}

export function targetsMatch(left: SessionTabTarget | undefined, right: SessionTabTarget | undefined): boolean {
	if (!left || !right) return true;
	return normalizeComparableUrl(left.url) === normalizeComparableUrl(right.url);
}

function extractStringResultField(data: unknown, fieldName: "result" | "title" | "url" | "value"): string | undefined {
	if (typeof data === "string") {
		if (fieldName === "value") return data;
		const text = data.trim();
		return text.length > 0 ? text : undefined;
	}
	if (!isRecord(data) || typeof data[fieldName] !== "string") {
		return undefined;
	}
	if (fieldName === "value") return data[fieldName];
	const text = data[fieldName].trim();
	return text.length > 0 ? text : undefined;
}

export function extractSessionTabTargetFromData(data: unknown): SessionTabTarget | undefined {
	const directTarget = normalizeSessionTabTarget({
		title: extractStringResultField(data, "title"),
		url: extractStringResultField(data, "url"),
	});
	if (directTarget) {
		return directTarget;
	}
	if (isRecord(data) && typeof data.origin === "string") {
		return normalizeSessionTabTarget({ url: data.origin });
	}
	return undefined;
}

function extractBatchResultCommand(item: Record<string, unknown>): string[] {
	return Array.isArray(item.command) ? item.command.filter((token): token is string => typeof token === "string") : [];
}

export function extractSessionTabTargetFromCommandData(commandTokens: string[], data: unknown): SessionTabTarget | undefined {
	const [command, subcommand] = commandTokens;
	return isReadOnlyDiagnosticSessionTargetCommand(command, subcommand) ? undefined : extractSessionTabTargetFromData(data);
}

export function extractSessionTabTargetFromBatchResults(data: unknown): SessionTabTarget | undefined {
	if (!Array.isArray(data)) {
		return undefined;
	}

	let currentTarget: SessionTabTarget | undefined;
	let pendingTitle: string | undefined;
	for (const item of data) {
		if (!isRecord(item) || item.success === false) {
			continue;
		}
		const [name, subcommand] = extractBatchResultCommand(item);
		const result = item.result;

		if (name === "get" && subcommand === "title") {
			pendingTitle = extractStringResultField(result, "title");
			continue;
		}
		if (name === "get" && subcommand === "url") {
			const url = extractStringResultField(result, "url");
			const target = normalizeSessionTabTarget({ title: pendingTitle, url });
			if (target) {
				currentTarget = target;
			}
			pendingTitle = undefined;
			continue;
		}
		const resultTarget = extractSessionTabTargetFromCommandData([name, subcommand].filter((token): token is string => token !== undefined), result);
		if (resultTarget) {
			currentTarget = resultTarget;
		}
		pendingTitle = undefined;
	}
	return currentTarget;
}

export function deriveSessionTabTarget(options: {
	command?: string;
	data: unknown;
	navigationSummary?: { title?: string; url?: string };
	previousTarget?: SessionTabTarget;
	subcommand?: string;
}): SessionTabTarget | undefined {
	if (isCloseCommand(options.command)) {
		return undefined;
	}
	const commandDataTarget = isReadOnlyDiagnosticSessionTargetCommand(options.command, options.subcommand)
		? undefined
		: extractSessionTabTargetFromData(options.data);
	return (
		normalizeSessionTabTarget(options.navigationSummary) ??
		extractSessionTabTargetFromBatchResults(options.data) ??
		commandDataTarget ??
		options.previousTarget
	);
}

function batchContainsOnlyReadOnlyDiagnosticTargets(data: unknown): boolean {
	if (!Array.isArray(data) || data.length === 0) {
		return false;
	}
	return data.every((item) => {
		if (!isRecord(item)) return false;
		const [command, subcommand] = extractBatchResultCommand(item);
		return isReadOnlyDiagnosticSessionTargetCommand(command, subcommand);
	});
}

function getRestoredSessionTabTarget(details: Record<string, unknown>, command: string | undefined, subcommand: string | undefined): SessionTabTarget | undefined {
	if (isReadOnlyDiagnosticSessionTargetCommand(command, subcommand)) {
		return undefined;
	}
	const storedTarget = isRecord(details.sessionTabTarget)
		? normalizeSessionTabTarget({
			title: typeof details.sessionTabTarget.title === "string" ? details.sessionTabTarget.title : undefined,
			url: typeof details.sessionTabTarget.url === "string" ? details.sessionTabTarget.url : undefined,
		  })
		: undefined;
	if (command !== "batch") {
		return storedTarget;
	}
	const batchTarget = extractSessionTabTargetFromBatchResults(details.data);
	if (batchTarget) {
		return batchTarget;
	}
	if (isRecord(details.compiledNetworkSourceLookup) || batchContainsOnlyReadOnlyDiagnosticTargets(details.data)) {
		return undefined;
	}
	return storedTarget;
}

function extractRefSnapshotRefs(data: unknown): Record<string, { isContentEditable?: boolean; isEditable?: boolean; name: string; role: string }> | undefined {
	if (!isRecord(data) || !isRecord(data.refs)) return undefined;
	const snapshotLines = typeof data.snapshot === "string" ? parseSnapshotLines(data.snapshot) : [];
	const lineByRef = new Map(snapshotLines.flatMap((line) => line.ref ? [[line.ref, line.raw] as const] : []));
	const entries = enrichSnapshotRefEntries(getSnapshotRefEntries(data), snapshotLines);
	const refs = Object.fromEntries(entries.flatMap((entry) => {
		if (!/^e\d+$/.test(entry.id) || entry.role.length === 0) return [];
		const isContentEditable = getEditableRefEvidence({ ref: entry.refData, text: lineByRef.get(entry.id) });
		return [[entry.id, { ...(isContentEditable === true ? { isContentEditable: true } : {}), ...(entry.isEditable !== undefined ? { isEditable: entry.isEditable } : {}), name: entry.name, role: entry.role }] as const];
	}));
	return Object.keys(refs).length > 0 ? refs : undefined;
}

export function extractRefSnapshotFromData(data: unknown): SessionRefSnapshot | undefined {
	if (!isRecord(data)) return undefined;
	const refs = extractRefSnapshotRefs(data);
	return {
		refIds: isRecord(data.refs) ? Object.keys(data.refs).filter((refId) => /^e\d+$/.test(refId)) : [],
		...(refs ? { refs } : {}),
		target: extractSessionTabTargetFromData(data),
	};
}

function getBatchResultFailureText(item: Record<string, unknown>): string | undefined {
	const result = isRecord(item.result) ? item.result : undefined;
	const parts = [item.error, result?.error, typeof item.result === "string" ? item.result : undefined]
		.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
	return parts.length > 0 ? parts.join("\n") : undefined;
}

export function buildNoActivePageRefSnapshotInvalidation(): SessionRefSnapshotInvalidation {
	return {
		reason: "no-active-page",
		summary: "The latest snapshot for this session reported No active page. Old page-scoped refs are invalid until snapshot -i succeeds.",
	};
}

export function isNoActivePageSnapshotFailure(command: string | undefined, text: string | undefined): boolean {
	return command === "snapshot" && /\bno active page\b/i.test(text ?? "");
}

export function extractLatestRefSnapshotStateFromBatchResults(data: unknown): BatchRefSnapshotState | undefined {
	if (!Array.isArray(data)) return undefined;
	let latestState: BatchRefSnapshotState | undefined;
	for (const item of data) {
		if (!isRecord(item)) continue;
		const [name] = extractBatchResultCommand(item);
		if (name !== "snapshot") continue;
		if (item.success === false) {
			if (isNoActivePageSnapshotFailure(name, getBatchResultFailureText(item))) {
				latestState = { invalidation: buildNoActivePageRefSnapshotInvalidation() };
			}
			continue;
		}
		const snapshot = extractRefSnapshotFromData(item.result);
		if (snapshot) {
			latestState = { snapshot };
		}
	}
	return latestState;
}

function getRestoredRefSnapshotInvalidation(details: Record<string, unknown>, command: string | undefined): SessionRefSnapshotInvalidation | undefined {
	const invalidation = isRecord(details.refSnapshotInvalidation) ? details.refSnapshotInvalidation : undefined;
	if (invalidation && invalidation.reason === "no-active-page") {
		return buildNoActivePageRefSnapshotInvalidation();
	}
	const errorText = typeof details.error === "string"
		? details.error
		: typeof details.summary === "string"
			? details.summary
			: undefined;
	return isNoActivePageSnapshotFailure(command, errorText) ? buildNoActivePageRefSnapshotInvalidation() : undefined;
}

function getRestoredRefSnapshot(details: Record<string, unknown>): SessionRefSnapshot | undefined {
	const refSnapshot = isRecord(details.refSnapshot) ? details.refSnapshot : undefined;
	if (!refSnapshot || !Array.isArray(refSnapshot.refIds)) return undefined;
	const refIds = refSnapshot.refIds.filter((refId): refId is string => typeof refId === "string" && /^e\d+$/.test(refId));
	const refRecord = isRecord(refSnapshot.refs) ? refSnapshot.refs : undefined;
	const refEntries = refRecord
		? Object.fromEntries(refIds.flatMap((refId) => {
			const entry = refRecord[refId];
			if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.role !== "string") return [];
			const isContentEditable = typeof entry.isContentEditable === "boolean" ? entry.isContentEditable : undefined;
			const isEditable = typeof entry.isEditable === "boolean" ? entry.isEditable : undefined;
			return [[refId, { ...(isContentEditable !== undefined ? { isContentEditable } : {}), ...(isEditable !== undefined ? { isEditable } : {}), name: entry.name, role: entry.role }] as const];
		}))
		: undefined;
	return {
		refIds,
		...(refEntries && Object.keys(refEntries).length > 0 ? { refs: refEntries } : {}),
		target: isRecord(refSnapshot.target)
			? normalizeSessionTabTarget({
				title: typeof refSnapshot.target.title === "string" ? refSnapshot.target.title : undefined,
				url: typeof refSnapshot.target.url === "string" ? refSnapshot.target.url : undefined,
			  })
			: undefined,
	};
}

function getLatestTabTargetOrder(targets: Map<string, OrderedSessionTabTarget>): number {
	let latestOrder = 0;
	for (const target of targets.values()) {
		latestOrder = Math.max(latestOrder, target.order);
	}
	return latestOrder;
}

function getLatestRefStateOrder(
	snapshots: Map<string, OrderedSessionRefSnapshot>,
	invalidations: Map<string, OrderedSessionRefSnapshotInvalidation>,
): number {
	let latestOrder = 0;
	for (const snapshot of snapshots.values()) latestOrder = Math.max(latestOrder, snapshot.order);
	for (const invalidation of invalidations.values()) latestOrder = Math.max(latestOrder, invalidation.order);
	return latestOrder;
}

function shouldApplyTabTargetUpdate(current: { order: number } | undefined, updateOrder: number): boolean {
	return !current || updateOrder >= current.order;
}

function shouldApplyRefStateUpdate(options: {
	currentInvalidation?: { order: number };
	currentSnapshot?: { order: number };
	updateOrder: number;
}): boolean {
	const currentOrder = Math.max(options.currentSnapshot?.order ?? 0, options.currentInvalidation?.order ?? 0);
	return options.updateOrder >= currentOrder;
}

function stripRefSnapshotOrder(snapshot: OrderedSessionRefSnapshot | SessionRefSnapshot | undefined): SessionRefSnapshot | undefined {
	return snapshot ? { refIds: snapshot.refIds, ...(snapshot.refs ? { refs: snapshot.refs } : {}), target: snapshot.target } : undefined;
}

function stripRefSnapshotInvalidationOrder(invalidation: OrderedSessionRefSnapshotInvalidation | SessionRefSnapshotInvalidation | undefined): SessionRefSnapshotInvalidation | undefined {
	return invalidation ? { reason: invalidation.reason, summary: invalidation.summary } : undefined;
}

export function getSessionPageStateKey(sessionName: string | undefined, namespace?: string): string | undefined {
	if (!sessionName) return undefined;
	return namespace ? `${namespace}\u0000${sessionName}` : sessionName;
}

export class SessionPageState {
	private refSnapshotInvalidations = new Map<string, OrderedSessionRefSnapshotInvalidation>();
	private refSnapshots = new Map<string, OrderedSessionRefSnapshot>();
	private tabPinningReasons = new Map<string, SessionTabPinningReason>();
	private tabTargets = new Map<string, OrderedSessionTabTarget>();
	private updateOrder = 0;

	static fromBranch(branch: unknown[]): SessionPageState {
		const state = new SessionPageState();
		let restoredOrder = 0;
		for (const entry of branch) {
			if (!isRecord(entry) || entry.type !== "message") continue;
			const message = isRecord(entry.message) ? entry.message : undefined;
			if (!message || message.toolName !== "agent_browser") continue;
			const details = isRecord(message.details) ? message.details : undefined;
			if (!details) continue;
			const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
			const namespace = typeof details.namespace === "string" ? details.namespace : undefined;
			const sessionKey = getSessionPageStateKey(sessionName, namespace);
			if (!sessionKey) continue;
			const command = typeof details.command === "string" ? details.command : undefined;
			const subcommand = typeof details.subcommand === "string" ? details.subcommand : undefined;
			if (isCloseCommand(command) && message.isError !== true) {
				restoredOrder += 1;
				state.clearSession(sessionKey);
				continue;
			}
			const tabTarget = getRestoredSessionTabTarget(details, command, subcommand);
			const refSnapshotInvalidation = getRestoredRefSnapshotInvalidation(details, command);
			const refSnapshot = refSnapshotInvalidation ? undefined : getRestoredRefSnapshot(details);
			if (!tabTarget && !refSnapshotInvalidation && !refSnapshot) continue;
			restoredOrder += 1;
			if (tabTarget) state.tabTargets.set(sessionKey, { order: restoredOrder, target: tabTarget });
			if (refSnapshotInvalidation) {
				state.refSnapshots.delete(sessionKey);
				state.refSnapshotInvalidations.set(sessionKey, { ...refSnapshotInvalidation, order: restoredOrder });
			} else if (refSnapshot) {
				state.refSnapshotInvalidations.delete(sessionKey);
				state.refSnapshots.set(sessionKey, { ...refSnapshot, order: restoredOrder });
			}
		}
		state.updateOrder = Math.max(
			restoredOrder,
			getLatestTabTargetOrder(state.tabTargets),
			getLatestRefStateOrder(state.refSnapshots, state.refSnapshotInvalidations),
		);
		state.tabPinningReasons = new Map([...state.tabTargets.keys()].map((sessionName) => [sessionName, "restore"]));
		return state;
	}

	beginUpdate(): SessionPageStateUpdateToken {
		this.updateOrder += 1;
		return this.updateOrder as SessionPageStateUpdateToken;
	}

	reset(): void {
		this.refSnapshotInvalidations = new Map<string, OrderedSessionRefSnapshotInvalidation>();
		this.refSnapshots = new Map<string, OrderedSessionRefSnapshot>();
		this.tabPinningReasons = new Map<string, SessionTabPinningReason>();
		this.tabTargets = new Map<string, OrderedSessionTabTarget>();
		this.updateOrder = 0;
	}

	get(sessionName: string | undefined): SessionPageStateView {
		if (!sessionName) return {};
		return {
			pinningReason: this.tabPinningReasons.get(sessionName),
			refSnapshot: stripRefSnapshotOrder(this.refSnapshots.get(sessionName)),
			refSnapshotInvalidation: stripRefSnapshotInvalidationOrder(this.refSnapshotInvalidations.get(sessionName)),
			tabTarget: this.tabTargets.get(sessionName)?.target,
		};
	}

	applyTabTarget(options: {
		sessionName: string;
		target: SessionTabTarget;
		update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		const current = this.tabTargets.get(options.sessionName);
		if (!shouldApplyTabTargetUpdate(current, options.update)) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		this.tabTargets.set(options.sessionName, { order: options.update, target: options.target });
		return { ...this.get(options.sessionName), applied: true };
	}

	applyRefSnapshot(options: {
		fallbackTarget?: SessionTabTarget;
		sessionName: string;
		snapshot: SessionRefSnapshot;
		update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		if (!shouldApplyRefStateUpdate({
			currentInvalidation: this.refSnapshotInvalidations.get(options.sessionName),
			currentSnapshot: this.refSnapshots.get(options.sessionName),
			updateOrder: options.update,
		})) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		const snapshot = { ...options.snapshot, target: options.snapshot.target ?? options.fallbackTarget };
		this.refSnapshotInvalidations.delete(options.sessionName);
		this.refSnapshots.set(options.sessionName, { ...snapshot, order: options.update });
		return { ...this.get(options.sessionName), applied: true };
	}

	applyRefSnapshotInvalidation(options: {
		invalidation: SessionRefSnapshotInvalidation;
		sessionName: string;
		update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		if (!shouldApplyRefStateUpdate({
			currentInvalidation: this.refSnapshotInvalidations.get(options.sessionName),
			currentSnapshot: this.refSnapshots.get(options.sessionName),
			updateOrder: options.update,
		})) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		this.refSnapshots.delete(options.sessionName);
		this.refSnapshotInvalidations.set(options.sessionName, { ...options.invalidation, order: options.update });
		return { ...this.get(options.sessionName), applied: true };
	}

	clearSession(sessionName: string): void {
		this.refSnapshotInvalidations.delete(sessionName);
		this.refSnapshots.delete(sessionName);
		this.tabPinningReasons.delete(sessionName);
		this.tabTargets.delete(sessionName);
	}

	markPinning(sessionName: string, reason: SessionTabPinningReason): void {
		this.tabPinningReasons.set(sessionName, reason);
	}

	clearRestorePinning(sessionName: string): void {
		if (this.tabPinningReasons.get(sessionName) === "restore") {
			this.tabPinningReasons.delete(sessionName);
		}
	}
}
