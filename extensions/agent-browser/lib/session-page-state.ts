import { isRecord } from "./parsing.js";
import { randomUUID } from "node:crypto";
import {
	getAgentBrowserSessionIdentityKey,
	isAgentBrowserSessionIdentityKeyInNamespace,
} from "./argv-grammar.js";
import {
	getBrowserRecord,
	snapshotFromDefinition,
	type BrowserRecord,
	type BrowserPageChange,
} from "./browser-transcript.js";
import {
	findReadConfirmation as findPendingReadConfirmation,
	parseReadConfirmation,
	type ReadConfirmation,
} from "./read-confirmation.js";
import {
	buildPageTransitionRefSnapshotInvalidation,
	stripRefSnapshotOrder,
	stripRefSnapshotInvalidationOrder,
	shouldApplyOrderedUpdate,
	type OrderedSessionRefSnapshot,
	type SessionTabTarget,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
	type SessionTabPinningReason,
	type SessionPageStateUpdateToken,
	type SessionPageStateView,
	type SessionPageStateUpdateResult,
} from "./session-page-observation.js";
import type {
	SessionRefSnapshotState,
	SessionRefState,
	SessionTabTargetState,
} from "./session-page-types.js";
export * from "./session-page-observation.js";

type RefView = Pick<SessionPageStateView, "refSnapshot" | "refSnapshotInvalidation">;
type TabView = Pick<SessionPageStateView, "tabReopenPending" | "tabTarget" | "tabTargetUnknown">;

// refSnapshot, refSnapshotInvalidation, and tabTarget stay named even when empty; the state suite pins that shape.

function refView(state: SessionRefState | undefined): RefView {
	if (state?.kind === "snapshot") {
		return { refSnapshot: stripRefSnapshotOrder(state), refSnapshotInvalidation: undefined };
	}
	return state?.kind === "invalidated"
		? { refSnapshot: undefined, refSnapshotInvalidation: stripRefSnapshotInvalidationOrder(state) }
		: { refSnapshot: undefined, refSnapshotInvalidation: undefined };
}

function tabView(state: SessionTabTargetState | undefined): TabView {
	if (state?.kind === "target") {
		return {
			...(state.reopenPending !== undefined ? { tabReopenPending: state.reopenPending } : {}),
			tabTarget: state.target,
		};
	}
	return { tabTarget: undefined, ...(state?.kind === "unknown" ? { tabTargetUnknown: true } : {}) };
}

export class SessionPageState {
	private confirmActions = new Map<string, string>();
	private readConfirmations = new Map<string, { order: number; value: ReadConfirmation }>();
	private refStates = new Map<string, SessionRefState>();
	private tabPinningReasons = new Map<string, SessionTabPinningReason>();
	private tabStates = new Map<string, SessionTabTargetState>();
	private updateOrder = 0;
	private nativeGenerations = new Map<string, string>();
	private pending = new Map<
		string,
		{ operationId: string; snapshot?: OrderedSessionRefSnapshot | undefined }
	>();

	static fromBranch(branch: readonly unknown[]): SessionPageState {
		const state = new SessionPageState();
		for (const entry of branch) {
			const record = getBrowserRecord(entry);
			if (record) {
				state.applyBrowserRecord(record);
			}
		}
		for (const [key, value] of state.tabStates) {
			if (value.kind === "target") {
				state.tabPinningReasons.set(key, "restore");
			}
		}
		return state;
	}

	/** A command operates on its admitted state while the committed view is unavailable. */
	fork(): SessionPageState {
		const state = new SessionPageState();
		state.confirmActions = new Map(this.confirmActions);
		state.readConfirmations = new Map(this.readConfirmations);
		state.refStates = new Map(this.refStates);
		state.tabPinningReasons = new Map(this.tabPinningReasons);
		state.tabStates = new Map([...this.tabStates].map(([key, value]) => [key, { ...value }]));
		state.pending = new Map(this.pending);
		state.nativeGenerations = new Map(this.nativeGenerations);
		state.updateOrder = this.updateOrder;
		return state;
	}

	views(): Map<string, SessionPageStateView> {
		return new Map(
			[
				...new Set([
					...this.confirmActions.keys(),
					...this.refStates.keys(),
					...this.tabStates.keys(),
				]),
			].map((key) => [key, this.get(key)]),
		);
	}

	/** The same reducer commits live observations and replays selected journal envelopes. */
	applyBrowserRecord({ event, snapshot }: BrowserRecord): void {
		const update = this.beginUpdate();
		const confirmation = parseReadConfirmation(event.state.readConfirmation);
		for (const page of event.pages ?? []) {
			this.applyPageRecord({ page, event, snapshot, update });
		}
		if (confirmation) {
			this.applyReadConfirmation(confirmation, update);
		}
	}

	private applyPageRecord(options: {
		readonly page: BrowserPageChange;
		readonly event: BrowserRecord["event"];
		readonly snapshot?: unknown;
		readonly update: SessionPageStateUpdateToken;
	}): void {
		const { page, event, snapshot, update } = options;
		const key = page.key;
		if (page.clear === true) {
			this.clearSession(key);
			return;
		}
		const pending = this.pending.get(key);
		if (event.phase === "finish" && pending && pending.operationId !== event.operationId) {
			return;
		}
		if (page.confirmActions !== undefined) {
			this.setConfirmActions(key, page.confirmActions ?? undefined);
		}
		if (this.applyUnknownPageRecord(page, event, update)) {
			return;
		}
		this.applyPageTargetRecord(page, update);
		this.applyPageRefsRecord({
			page,
			snapshot,
			candidate: pending?.snapshot ?? this.currentSnapshot(key),
			update,
		});
		this.pending.delete(key);
	}

	private applyUnknownPageRecord(
		page: BrowserPageChange,
		event: BrowserRecord["event"],
		update: SessionPageStateUpdateToken,
	): boolean {
		const key = page.key;
		if (event.phase === "begin") {
			this.pending.set(key, {
				operationId: event.operationId,
				snapshot: this.currentSnapshot(key) ?? this.pending.get(key)?.snapshot,
			});
			this.invalidateUnknownPage(
				key,
				update,
				buildPageTransitionRefSnapshotInvalidation(
					"This browser operation has no persisted finish. Inspect the current URL and take a fresh snapshot before using refs; changes may already have happened.",
				),
			);
			return true;
		}
		if (page.unknown === true || page.refs.kind === "unknown") {
			this.invalidateUnknownPage(
				key,
				update,
				page.refs.kind === "unknown" && page.refs.invalidation
					? page.refs.invalidation
					: buildPageTransitionRefSnapshotInvalidation(
							"The browser target or operation outcome is unknown. Verify the current URL and take a fresh snapshot before using refs.",
						),
			);
			return true;
		}
		return false;
	}

	private invalidateUnknownPage(
		key: string,
		update: SessionPageStateUpdateToken,
		invalidation: SessionRefSnapshotInvalidation,
	): void {
		this.markTabTargetUnknown({ sessionName: key, update });
		this.applyRefSnapshotInvalidation({ sessionName: key, update, invalidation });
	}

	private applyPageTargetRecord(
		page: BrowserPageChange,
		update: SessionPageStateUpdateToken,
	): void {
		if (page.target) {
			this.applyTabTarget({ sessionName: page.key, target: page.target, update });
		} else {
			this.tabStates.delete(page.key);
		}
		if (page.reopenPending !== undefined) {
			this.setTabReopenPending({ pending: page.reopenPending, sessionName: page.key, update });
		}
		if (page.pinningReason !== undefined) {
			this.markPinning(page.key, page.pinningReason);
		} else {
			this.tabPinningReasons.delete(page.key);
		}
	}

	private applyPageRefsRecord(options: {
		readonly page: BrowserPageChange;
		readonly snapshot?: unknown;
		readonly candidate?: OrderedSessionRefSnapshot | undefined;
		readonly update: SessionPageStateUpdateToken;
	}): void {
		const { page, snapshot, candidate, update } = options;
		const key = page.key;
		if (page.refs.kind === "replace") {
			const definition =
				isRecord(snapshot) && snapshot.id === page.refs.snapshotId && Boolean(snapshot.refs)
					? snapshotFromDefinition(snapshot)
					: { snapshotId: page.refs.snapshotId, refIds: [] };
			this.applyRefSnapshot({
				sessionName: key,
				snapshot: definition,
				fallbackTarget: page.target,
				update,
			});
		} else if (page.refs.kind === "reuse") {
			if (candidate?.snapshotId === page.refs.snapshotId) {
				this.applyRefSnapshot({
					sessionName: key,
					snapshot: candidate,
					fallbackTarget: page.target,
					update,
				});
			} else {
				this.applyRefSnapshotInvalidation({
					sessionName: key,
					update,
					invalidation: buildPageTransitionRefSnapshotInvalidation(
						"The ancestral snapshot definition is unavailable. Take a new complete snapshot before using refs.",
					),
				});
			}
		} else {
			this.refStates.delete(key);
			if (page.refs.invalidation) {
				this.applyRefSnapshotInvalidation({
					sessionName: key,
					invalidation: page.refs.invalidation,
					update,
				});
			}
		}
	}

	/** The session's usable snapshot; undefined when its refs are invalidated, absent, or unknown. */
	private currentSnapshot(sessionKey: string): SessionRefSnapshotState | undefined {
		const state = this.refStates.get(sessionKey);
		return state?.kind === "snapshot" ? state : undefined;
	}

	beginUpdate(): SessionPageStateUpdateToken {
		this.updateOrder += 1;
		return { sessionPageStateUpdateOrder: this.updateOrder };
	}

	reset(): void {
		this.confirmActions.clear();
		this.readConfirmations.clear();
		this.pending.clear();
		this.nativeGenerations.clear();
		this.refStates = new Map();
		this.tabPinningReasons = new Map();
		this.tabStates = new Map();
		this.updateOrder = 0;
	}

	get(sessionName: string | undefined): SessionPageStateView {
		if (sessionName === undefined || sessionName.length === 0) {
			return {};
		}
		const refState = this.refStates.get(sessionName);
		const tabState = this.tabStates.get(sessionName);
		const confirmActions = this.confirmActions.get(sessionName);
		return {
			...(confirmActions !== undefined ? { confirmActions } : {}),
			pinningReason: this.tabPinningReasons.get(sessionName),
			...refView(refState),
			...tabView(tabState),
		};
	}

	findReadConfirmation(
		args: readonly string[],
		namespace?: string,
		stdin?: string,
	): ReadConfirmation | undefined {
		return findPendingReadConfirmation(
			args,
			[...this.readConfirmations.values()].map((entry) => entry.value),
			namespace,
			stdin,
		);
	}
	setConfirmActions(sessionName: string, value: string | undefined): void {
		if (value !== undefined) {
			this.confirmActions.set(sessionName, value);
		} else {
			this.confirmActions.delete(sessionName);
		}
	}
	getReadConfirmation(sessionKey: string): ReadConfirmation | undefined {
		return this.readConfirmations.get(sessionKey)?.value;
	}
	/**
	 * Takes the one-use fresh capture for a session. The flag is cleared on the stored value and the
	 * cleared confirmation is returned for persistence, so a caller cannot read the flag and leave it set.
	 */
	takeFreshConfirmationCapture(
		sessionKey: string,
		update: SessionPageStateUpdateToken,
	): ReadConfirmation | undefined {
		const current = this.readConfirmations.get(sessionKey)?.value;
		if (current?.refSnapshotFresh !== true) {
			return undefined;
		}
		const consumed = { ...current };
		delete consumed.refSnapshotFresh;
		this.applyReadConfirmation(consumed, update);
		return consumed;
	}
	applyReadConfirmation(value: ReadConfirmation, update: SessionPageStateUpdateToken): void {
		const key = getAgentBrowserSessionIdentityKey(value.sessionName, value.namespace);
		if (update.sessionPageStateUpdateOrder >= (this.readConfirmations.get(key)?.order ?? 0)) {
			this.readConfirmations.set(key, { value, order: update.sessionPageStateUpdateOrder });
		}
	}
	applyTabTarget(options: {
		readonly sessionName: string;
		readonly target: SessionTabTarget;
		readonly update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		const current = this.tabStates.get(options.sessionName);
		if (!shouldApplyOrderedUpdate(current, options.update.sessionPageStateUpdateOrder)) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		this.tabStates.set(options.sessionName, {
			kind: "target",
			order: options.update.sessionPageStateUpdateOrder,
			reopenPending: current?.kind === "target" ? current.reopenPending : undefined,
			target: options.target,
		});
		return { ...this.get(options.sessionName), applied: true };
	}
	setTabReopenPending(options: {
		readonly pending: boolean;
		readonly sessionName: string;
		readonly update: SessionPageStateUpdateToken;
	}): void {
		const current = this.tabStates.get(options.sessionName);
		if (
			current?.kind !== "target" ||
			!shouldApplyOrderedUpdate(current, options.update.sessionPageStateUpdateOrder)
		) {
			return;
		}
		this.tabStates.set(options.sessionName, {
			...current,
			order: options.update.sessionPageStateUpdateOrder,
			reopenPending: options.pending,
		});
	}
	applyRefSnapshot(options: {
		readonly fallbackTarget?: SessionTabTarget | undefined;
		readonly sessionName: string;
		readonly snapshot: SessionRefSnapshot;
		readonly update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		if (
			!shouldApplyOrderedUpdate(
				this.refStates.get(options.sessionName),
				options.update.sessionPageStateUpdateOrder,
			)
		) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		const snapshot = {
			...options.snapshot,
			generation: options.snapshot.generation ?? this.nativeGenerations.get(options.sessionName),
			snapshotId: options.snapshot.snapshotId ?? randomUUID(),
			target: options.snapshot.target ?? options.fallbackTarget,
		};
		this.refStates.set(options.sessionName, {
			...snapshot,
			kind: "snapshot",
			order: options.update.sessionPageStateUpdateOrder,
		});
		return { ...this.get(options.sessionName), applied: true };
	}
	bindSnapshotGeneration(sessionName: string, generation: string | undefined): void {
		if (generation !== undefined && generation.length > 0) {
			this.nativeGenerations.set(sessionName, generation);
		} else {
			this.nativeGenerations.delete(sessionName);
		}
		const snapshot = this.currentSnapshot(sessionName);
		if (snapshot) {
			this.refStates.set(sessionName, { ...snapshot, generation });
		}
	}
	applyRefSnapshotInvalidation(options: {
		readonly invalidation: SessionRefSnapshotInvalidation;
		readonly sessionName: string;
		readonly update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		if (
			!shouldApplyOrderedUpdate(
				this.refStates.get(options.sessionName),
				options.update.sessionPageStateUpdateOrder,
			)
		) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		this.refStates.set(options.sessionName, {
			...options.invalidation,
			kind: "invalidated",
			order: options.update.sessionPageStateUpdateOrder,
		});
		return { ...this.get(options.sessionName), applied: true };
	}
	markTabTargetUnknown(options: {
		readonly sessionName: string;
		readonly update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		if (
			!shouldApplyOrderedUpdate(
				this.tabStates.get(options.sessionName),
				options.update.sessionPageStateUpdateOrder,
			)
		) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		this.refStates.delete(options.sessionName);
		this.tabPinningReasons.delete(options.sessionName);
		this.tabStates.set(options.sessionName, {
			kind: "unknown",
			order: options.update.sessionPageStateUpdateOrder,
		});
		return { ...this.get(options.sessionName), applied: true };
	}
	clearSession(sessionName: string): void {
		this.confirmActions.delete(sessionName);
		this.pending.delete(sessionName);
		this.nativeGenerations.delete(sessionName);
		this.readConfirmations.delete(sessionName);
		this.refStates.delete(sessionName);
		this.tabPinningReasons.delete(sessionName);
		this.tabStates.delete(sessionName);
	}
	clearNamespace(namespace?: string): void {
		const sessionKeys = new Set([
			...this.confirmActions.keys(),
			...this.readConfirmations.keys(),
			...this.refStates.keys(),
			...this.tabPinningReasons.keys(),
			...this.tabStates.keys(),
		]);
		for (const sessionKey of sessionKeys) {
			if (isAgentBrowserSessionIdentityKeyInNamespace(sessionKey, namespace)) {
				this.clearSession(sessionKey);
			}
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
