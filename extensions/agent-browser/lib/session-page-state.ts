import { randomUUID } from "node:crypto";

import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import { getAgentBrowserSessionIdentityKey, isAgentBrowserSessionIdentityKeyInNamespace } from "./argv-grammar.js";
import { getBrowserRecord, snapshotFromDefinition, type BrowserRecord } from "./browser-transcript.js";
import { isCloseCommand, isOpenNavigationCommand, isReadOnlyDiagnosticSessionTargetCommand, isRecordPageTransitionCommand, isUnverifiedPageTransitionCommand, isWebMcpPageMutationCommand, isWindowOrDiffPageTransitionCommand } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";
import { detectConfirmationRequired } from "./results/confirmation.js";
import { findReadConfirmation as findPendingReadConfirmation, isSuccessfulNativeConfirmedClose, parseReadConfirmation, type ReadConfirmation } from "./read-confirmation.js";
import { getEditableRefEvidence } from "./results/editable-ref-evidence.js";
import { enrichSnapshotRefEntries, getFullSnapshotData, getSnapshotRefEntries } from "./results/snapshot-refs.js";
import { parseSnapshotLines } from "./results/snapshot-segments.js";

export interface SessionTabTarget {
	targetId?: string;
	title?: string;
	url: string;
}

interface OrderedSessionTabTarget {
	order: number;
	reopenPending?: boolean;
	target: SessionTabTarget;
}

export interface SessionRefSnapshot {
	snapshotId?: string;
	generation?: string;
	refIds: string[];
	refs?: Record<string, { isContentEditable?: boolean; isEditable?: boolean; name: string; role: string }>;
	target?: SessionTabTarget;
}

interface OrderedSessionRefSnapshot extends SessionRefSnapshot {
	order: number;
}

export interface SessionRefSnapshotInvalidation {
	reason: "no-active-page" | "page-transition";
	summary: string;
}

interface OrderedSessionRefSnapshotInvalidation extends SessionRefSnapshotInvalidation {
	order: number;
}

export interface BatchRefSnapshotState {
	invalidation?: SessionRefSnapshotInvalidation;
	refreshArgs?: string[];
	snapshot?: SessionRefSnapshot;
}

export type SessionTabPinningReason = "drift" | "restore";

export type SessionPageStateUpdateToken = number & { readonly __sessionPageStateUpdateToken: unique symbol };

export interface SessionPageStateView {
	confirmActions?: string;
	pinningReason?: SessionTabPinningReason;
	tabReopenPending?: boolean;
	tabTargetUnknown?: true;
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

export function normalizeSessionTabTarget(target: { targetId?: string; title?: string; url?: string } | undefined): SessionTabTarget | undefined {
	if (!target) {
		return undefined;
	}
	const url = target.url?.trim();
	if (!url || normalizeComparableUrl(url) === undefined) {
		return undefined;
	}
	const title = target.title?.trim();
	return { ...(target.targetId?.trim() ? { targetId: target.targetId.trim() } : {}), title: title && title.length > 0 ? title : undefined, url };
}

export function isAboutBlankUrl(url: string | undefined): boolean {
	return normalizeComparableUrl(url) === "about:blank";
}

export function isAboutBlankSessionTabTarget(target: SessionTabTarget | undefined): boolean {
	return isAboutBlankUrl(target?.url);
}

export function commandExplicitlyTargetsAboutBlank(commandTokens: string[]): boolean {
	return (commandTokens[0] === "window" && commandTokens[1] === "new") || commandTokens.some((token) => isAboutBlankUrl(token));
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

function extractSessionTabTargetFromData(data: unknown): SessionTabTarget | undefined {
	const directTarget = normalizeSessionTabTarget({
		targetId: isRecord(data) && typeof data.targetId === "string" ? data.targetId : undefined,
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
	if (command === "confirm" && isRecord(data) && data.confirmed === true && ["navigate", "url"].includes(String(data.action))
		&& isRecord(data.result) && data.result.success === true && !detectConfirmationRequired(data)) {
		return extractSessionTabTargetFromData(data.result.data);
	}
	if (command === "get" && subcommand === "url") {
		return normalizeSessionTabTarget({ url: extractStringResultField(data, "url") ?? extractStringResultField(data, "result") });
	}
	return isReadOnlyDiagnosticSessionTargetCommand(command, subcommand) ? undefined : extractSessionTabTargetFromData(data);
}

export function extractSessionTabTargetFromBatchResults(data: unknown): SessionTabTarget | undefined {
	if (!Array.isArray(data)) {
		return undefined;
	}

	let currentTarget: SessionTabTarget | undefined;
	let pendingTitle: string | undefined;
	for (const item of data) {
		if (!isRecord(item) || detectConfirmationRequired(item.result)) continue;
		// Only this row's native identity can describe the active tab after it ran.
		if (currentTarget?.targetId) currentTarget = normalizeSessionTabTarget({ title: currentTarget.title, url: currentTarget.url });
		const commandTokens = extractUpstreamCommandTokens(extractBatchResultCommand(item));
		const [name, subcommand] = commandTokens;
		if (isOpenNavigationCommand(name) || isUnverifiedPageTransitionCommand(name, subcommand)
			|| (name === "click" && commandTokens.includes("--new-tab"))) {
			currentTarget = undefined;
			pendingTitle = undefined;
		}
		if (item.success === false) continue;
		const result = item.result;

		if (isCloseCommand(name) || isSuccessfulNativeConfirmedClose(commandTokens, result)) {
			currentTarget = undefined;
			pendingTitle = undefined;
			continue;
		}
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
	const commandDataTarget = extractSessionTabTargetFromCommandData(
		[options.command, options.subcommand].filter((token): token is string => token !== undefined), options.data,
	);
	const observedTarget = normalizeSessionTabTarget(options.navigationSummary)
		?? extractSessionTabTargetFromBatchResults(options.data)
		?? commandDataTarget;
	if (observedTarget || !isUnverifiedPageTransitionCommand(options.command, options.subcommand)) return observedTarget ?? options.previousTarget;
	return undefined;
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

export function extractRefSnapshotFromData(value: unknown): SessionRefSnapshot | undefined {
	const data = getFullSnapshotData(value);
	if (!data) return undefined;
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

export function buildPageTransitionRefSnapshotInvalidation(summary?: string): SessionRefSnapshotInvalidation {
	return {
		reason: "page-transition",
		summary: summary ?? "Recording starts and URL-bearing restarts conservatively invalidate earlier page-scoped refs. Run snapshot -i before using refs; this is not evidence of a page change.",
	};
}

export function getCommandRefSnapshotInvalidation(commandTokens: readonly string[]): SessionRefSnapshotInvalidation | undefined {
	if (isRecordPageTransitionCommand(commandTokens)) return buildPageTransitionRefSnapshotInvalidation();
	if (isWindowOrDiffPageTransitionCommand(commandTokens[0], commandTokens[1])) {
		return buildPageTransitionRefSnapshotInvalidation("A window new or diff url command replaced or navigated the active page and invalidated prior refs. Run snapshot -i before using page-scoped refs.");
	}
	if (isWebMcpPageMutationCommand(commandTokens)) {
		return buildPageTransitionRefSnapshotInvalidation("A WebMCP invoke, result, or cancel command can mutate, rerender, or navigate the page, so the prior snapshot refs were invalidated. Run snapshot -i before using page-scoped refs.");
	}
	return undefined;
}

export function isNoActivePageSnapshotFailure(command: string | undefined, text: string | undefined): boolean {
	return command === "snapshot" && /\bno active page\b/i.test(text ?? "");
}

export function extractLatestRefSnapshotStateFromBatchResults(data: unknown): BatchRefSnapshotState | undefined {
	if (!Array.isArray(data)) return undefined;
	let latestState: BatchRefSnapshotState | undefined;
	for (const item of data) {
		if (!isRecord(item)) continue;
		const commandTokens = extractUpstreamCommandTokens(extractBatchResultCommand(item));
		const [name] = commandTokens;
		if (item.success !== false && !detectConfirmationRequired(item.result) && (isCloseCommand(name) || isSuccessfulNativeConfirmedClose(commandTokens, item.result))) {
			latestState = undefined;
			continue;
		}
		const transitionInvalidation = getCommandRefSnapshotInvalidation(commandTokens);
		if (transitionInvalidation) {
			latestState = { invalidation: transitionInvalidation };
			continue;
		}
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
		} else if (isRecord(item.result) && isRecord(item.result.snapshot)) {
			latestState = { refreshArgs: commandTokens.filter((token) => token !== "--delta" && token !== "--full") };
		}
	}
	return latestState;
}

function shouldApplyTabTargetUpdate(current: { order: number } | undefined, unknownOrder: number | undefined, updateOrder: number): boolean {
	return updateOrder >= Math.max(current?.order ?? 0, unknownOrder ?? 0);
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
	return snapshot ? { ...(snapshot.snapshotId ? { snapshotId: snapshot.snapshotId } : {}), ...(snapshot.generation ? { generation: snapshot.generation } : {}), refIds: snapshot.refIds, ...(snapshot.refs ? { refs: snapshot.refs } : {}), target: snapshot.target } : undefined;
}

function stripRefSnapshotInvalidationOrder(invalidation: OrderedSessionRefSnapshotInvalidation | SessionRefSnapshotInvalidation | undefined): SessionRefSnapshotInvalidation | undefined {
	return invalidation ? { reason: invalidation.reason, summary: invalidation.summary } : undefined;
}

export function getSessionPageStateKey(sessionName: string | undefined, namespace?: string): string | undefined {
	return sessionName ? getAgentBrowserSessionIdentityKey(sessionName, namespace) : undefined;
}

export class SessionPageState {
	private confirmActions = new Map<string, string>();
	private readConfirmations = new Map<string, { order: number; value: ReadConfirmation }>();
	private refSnapshotInvalidations = new Map<string, OrderedSessionRefSnapshotInvalidation>();
	private refSnapshots = new Map<string, OrderedSessionRefSnapshot>();
	private tabPinningReasons = new Map<string, SessionTabPinningReason>();
	private tabTargetUnknownOrders = new Map<string, number>();
	private tabTargets = new Map<string, OrderedSessionTabTarget>();
	private updateOrder = 0;
	private nativeGenerations = new Map<string, string>();

	private pending = new Map<string, { operationId: string; snapshot?: OrderedSessionRefSnapshot }>();

	static fromBranch(branch: unknown[]): SessionPageState {
		const state = new SessionPageState();
		for (const entry of branch) {
			const record = getBrowserRecord(entry);
			if (record) state.applyBrowserRecord(record);
		}
		for (const key of state.tabTargets.keys()) state.tabPinningReasons.set(key, "restore");
		return state;
	}

	/** A command operates on its admitted state while the committed view is unavailable. */
	fork(): SessionPageState {
		const state = new SessionPageState();
		state.confirmActions = new Map(this.confirmActions);
		state.readConfirmations = new Map(this.readConfirmations);
		state.refSnapshotInvalidations = new Map(this.refSnapshotInvalidations);
		state.refSnapshots = new Map(this.refSnapshots);
		state.tabPinningReasons = new Map(this.tabPinningReasons);
		state.tabTargetUnknownOrders = new Map(this.tabTargetUnknownOrders);
		state.tabTargets = new Map([...this.tabTargets].map(([key, value]) => [key, { ...value }]));
		state.pending = new Map(this.pending);
		state.nativeGenerations = new Map(this.nativeGenerations);
		state.updateOrder = this.updateOrder;
		return state;
	}

	views(): Map<string, SessionPageStateView> {
		return new Map([...new Set([...this.confirmActions.keys(), ...this.tabTargets.keys(), ...this.tabTargetUnknownOrders.keys(), ...this.refSnapshots.keys(), ...this.refSnapshotInvalidations.keys()])].map(key => [key, this.get(key)]));
	}

	/** The same reducer commits live observations and replays selected journal envelopes. */
	applyBrowserRecord({ event, snapshot }: BrowserRecord): void {
		const update = this.beginUpdate();
		const confirmation = parseReadConfirmation(event.state.readConfirmation);
		for (const page of event.pages ?? []) {
			const key = page.key;
			if (page.clear) { this.clearSession(key); continue; }
			const pending = this.pending.get(key);
			if (event.phase === "finish" && pending && pending.operationId !== event.operationId) continue;
			if (page.confirmActions !== undefined) this.setConfirmActions(key, page.confirmActions ?? undefined);
			if (event.phase === "begin") {
				this.pending.set(key, { operationId: event.operationId, snapshot: this.refSnapshots.get(key) ?? this.pending.get(key)?.snapshot });
				this.markTabTargetUnknown({ sessionName: key, update });
				this.applyRefSnapshotInvalidation({ sessionName: key, update, invalidation: buildPageTransitionRefSnapshotInvalidation("This browser operation has no persisted finish. Inspect the current URL and take a fresh snapshot before using refs; changes may already have happened.") });
				continue;
			}
			if (page.unknown || page.refs.kind === "unknown") {
				this.markTabTargetUnknown({ sessionName: key, update });
				this.applyRefSnapshotInvalidation({ sessionName: key, update, invalidation: page.refs.kind === "unknown" && page.refs.invalidation
					? page.refs.invalidation : buildPageTransitionRefSnapshotInvalidation("The browser target or operation outcome is unknown. Verify the current URL and take a fresh snapshot before using refs.") });
				continue;
			}
			if (page.target) this.applyTabTarget({ sessionName: key, target: page.target, update });
			else { this.tabTargets.delete(key); this.tabTargetUnknownOrders.delete(key); }
			if (page.reopenPending !== undefined) this.setTabReopenPending({ pending: page.reopenPending, sessionName: key, update });
			if (page.pinningReason) this.markPinning(key, page.pinningReason);
			else this.tabPinningReasons.delete(key);
			if (page.refs.kind === "replace") {
				const definition = snapshot?.id === page.refs.snapshotId && snapshot.refs ? snapshotFromDefinition(snapshot)
					: { snapshotId: page.refs.snapshotId, refIds: [] };
				this.applyRefSnapshot({ sessionName: key, snapshot: definition, fallbackTarget: page.target, update });
			} else if (page.refs.kind === "reuse") {
				const candidate = pending?.snapshot ?? this.refSnapshots.get(key);
				if (candidate?.snapshotId === page.refs.snapshotId) this.applyRefSnapshot({ sessionName: key, snapshot: candidate, fallbackTarget: page.target, update });
				else this.applyRefSnapshotInvalidation({ sessionName: key, update, invalidation: buildPageTransitionRefSnapshotInvalidation("The ancestral snapshot definition is unavailable. Take a new complete snapshot before using refs.") });
			} else {
				this.refSnapshots.delete(key);
				if (page.refs.invalidation) this.applyRefSnapshotInvalidation({ sessionName: key, invalidation: page.refs.invalidation, update });
				else this.refSnapshotInvalidations.delete(key);
			}
			this.pending.delete(key);
		}
		if (confirmation) this.applyReadConfirmation(confirmation, update);
	}

	beginUpdate(): SessionPageStateUpdateToken {
		this.updateOrder += 1;
		return this.updateOrder as SessionPageStateUpdateToken;
	}

	reset(): void {
		this.confirmActions.clear();
		this.readConfirmations.clear();
		this.pending.clear();
		this.nativeGenerations.clear();
		this.refSnapshotInvalidations = new Map<string, OrderedSessionRefSnapshotInvalidation>();
		this.refSnapshots = new Map<string, OrderedSessionRefSnapshot>();
		this.tabPinningReasons = new Map<string, SessionTabPinningReason>();
		this.tabTargetUnknownOrders = new Map<string, number>();
		this.tabTargets = new Map<string, OrderedSessionTabTarget>();
		this.updateOrder = 0;
	}

	get(sessionName: string | undefined): SessionPageStateView {
		if (!sessionName) return {};
		return {
			...(this.confirmActions.has(sessionName) ? { confirmActions: this.confirmActions.get(sessionName) } : {}),
			pinningReason: this.tabPinningReasons.get(sessionName),
			...(this.tabTargets.get(sessionName)?.reopenPending !== undefined ? { tabReopenPending: this.tabTargets.get(sessionName)?.reopenPending } : {}),
			refSnapshot: stripRefSnapshotOrder(this.refSnapshots.get(sessionName)),
			refSnapshotInvalidation: stripRefSnapshotInvalidationOrder(this.refSnapshotInvalidations.get(sessionName)),
			...(this.tabTargetUnknownOrders.has(sessionName) ? { tabTargetUnknown: true as const } : {}),
			tabTarget: this.tabTargets.get(sessionName)?.target,
		};
	}

	findReadConfirmation(args: string[], namespace?: string): ReadConfirmation | undefined {
		return findPendingReadConfirmation(args, [...this.readConfirmations.values()].map(entry => entry.value), namespace);
	}

	setConfirmActions(sessionName: string, value: string | undefined): void {
		if (value !== undefined) this.confirmActions.set(sessionName, value);
		else this.confirmActions.delete(sessionName);
	}

	getReadConfirmation(sessionKey: string): ReadConfirmation | undefined {
		return this.readConfirmations.get(sessionKey)?.value;
	}

	applyReadConfirmation(value: ReadConfirmation, update: SessionPageStateUpdateToken): void {
		const key = getAgentBrowserSessionIdentityKey(value.sessionName, value.namespace);
		if (update >= (this.readConfirmations.get(key)?.order ?? 0)) this.readConfirmations.set(key, { value, order: update });
	}

	applyTabTarget(options: {
		sessionName: string;
		target: SessionTabTarget;
		update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		const current = this.tabTargets.get(options.sessionName);
		if (!shouldApplyTabTargetUpdate(current, this.tabTargetUnknownOrders.get(options.sessionName), options.update)) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		this.tabTargetUnknownOrders.delete(options.sessionName);
		this.tabTargets.set(options.sessionName, { order: options.update, reopenPending: current?.reopenPending, target: options.target });
		return { ...this.get(options.sessionName), applied: true };
	}

	setTabReopenPending(options: { pending: boolean; sessionName: string; update: SessionPageStateUpdateToken }): void {
		const current = this.tabTargets.get(options.sessionName);
		if (!current || !shouldApplyTabTargetUpdate(current, this.tabTargetUnknownOrders.get(options.sessionName), options.update)) return;
		this.tabTargets.set(options.sessionName, { ...current, order: options.update, reopenPending: options.pending });
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
		const snapshot = { ...options.snapshot, generation: options.snapshot.generation ?? this.nativeGenerations.get(options.sessionName), snapshotId: options.snapshot.snapshotId ?? randomUUID(), target: options.snapshot.target ?? options.fallbackTarget };
		this.refSnapshotInvalidations.delete(options.sessionName);
		this.refSnapshots.set(options.sessionName, { ...snapshot, order: options.update });
		return { ...this.get(options.sessionName), applied: true };
	}

	bindSnapshotGeneration(sessionName: string, generation: string | undefined): void {
		if (generation) this.nativeGenerations.set(sessionName, generation);
		else this.nativeGenerations.delete(sessionName);
		const snapshot = this.refSnapshots.get(sessionName);
		if (snapshot) this.refSnapshots.set(sessionName, { ...snapshot, generation });
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

	markTabTargetUnknown(options: { sessionName: string; update: SessionPageStateUpdateToken }): SessionPageStateUpdateResult {
		const current = this.tabTargets.get(options.sessionName);
		if (!shouldApplyTabTargetUpdate(current, this.tabTargetUnknownOrders.get(options.sessionName), options.update)) return { ...this.get(options.sessionName), applied: false, stale: true };
		this.refSnapshotInvalidations.delete(options.sessionName);
		this.refSnapshots.delete(options.sessionName);
		this.tabPinningReasons.delete(options.sessionName);
		this.tabTargets.delete(options.sessionName);
		this.tabTargetUnknownOrders.set(options.sessionName, options.update);
		return { ...this.get(options.sessionName), applied: true };
	}

	clearSession(sessionName: string): void {
		this.confirmActions.delete(sessionName);
		this.pending.delete(sessionName);
		this.nativeGenerations.delete(sessionName);
		this.readConfirmations.delete(sessionName);
		this.refSnapshotInvalidations.delete(sessionName);
		this.refSnapshots.delete(sessionName);
		this.tabPinningReasons.delete(sessionName);
		this.tabTargetUnknownOrders.delete(sessionName);
		this.tabTargets.delete(sessionName);
	}

	clearNamespace(namespace?: string): void {
		const sessionKeys = new Set([
			...this.confirmActions.keys(),
			...this.readConfirmations.keys(),
			...this.refSnapshotInvalidations.keys(),
			...this.refSnapshots.keys(),
			...this.tabPinningReasons.keys(),
			...this.tabTargetUnknownOrders.keys(),
			...this.tabTargets.keys(),
		]);
		for (const sessionKey of sessionKeys) {
			if (isAgentBrowserSessionIdentityKeyInNamespace(sessionKey, namespace)) this.clearSession(sessionKey);
		}
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
