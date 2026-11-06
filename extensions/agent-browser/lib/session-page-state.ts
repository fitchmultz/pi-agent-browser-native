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
	shouldApplyTabTargetUpdate,
	shouldApplyRefStateUpdate,
	type OrderedSessionTabTarget,
	type OrderedSessionRefSnapshot,
	type OrderedSessionRefSnapshotInvalidation,
	type SessionTabTarget,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
	type SessionTabPinningReason,
	type SessionPageStateUpdateToken,
	type SessionPageStateView,
	type SessionPageStateUpdateResult,
} from "./session-page-observation.js";
export * from "./session-page-observation.js";

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
		for (const key of state.tabTargets.keys()) {
			state.tabPinningReasons.set(key, "restore");
		}
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
		return new Map(
			[
				...new Set([
					...this.confirmActions.keys(),
					...this.tabTargets.keys(),
					...this.tabTargetUnknownOrders.keys(),
					...this.refSnapshots.keys(),
					...this.refSnapshotInvalidations.keys(),
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
			candidate: pending?.snapshot ?? this.refSnapshots.get(key),
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
				snapshot: this.refSnapshots.get(key) ?? this.pending.get(key)?.snapshot,
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
			this.tabTargets.delete(page.key);
			this.tabTargetUnknownOrders.delete(page.key);
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
			this.refSnapshots.delete(key);
			if (page.refs.invalidation) {
				this.applyRefSnapshotInvalidation({
					sessionName: key,
					invalidation: page.refs.invalidation,
					update,
				});
			} else {
				this.refSnapshotInvalidations.delete(key);
			}
		}
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
		this.refSnapshotInvalidations = new Map();
		this.refSnapshots = new Map();
		this.tabPinningReasons = new Map();
		this.tabTargetUnknownOrders = new Map();
		this.tabTargets = new Map();
		this.updateOrder = 0;
	}

	get(sessionName: string | undefined): SessionPageStateView {
		if (sessionName === undefined || sessionName.length === 0) {
			return {};
		}
		return {
			...(this.confirmActions.has(sessionName)
				? { confirmActions: this.confirmActions.get(sessionName) }
				: {}),
			pinningReason: this.tabPinningReasons.get(sessionName),
			...(this.tabTargets.get(sessionName)?.reopenPending !== undefined
				? { tabReopenPending: this.tabTargets.get(sessionName)?.reopenPending }
				: {}),
			refSnapshot: stripRefSnapshotOrder(this.refSnapshots.get(sessionName)),
			refSnapshotInvalidation: stripRefSnapshotInvalidationOrder(
				this.refSnapshotInvalidations.get(sessionName),
			),
			...(this.tabTargetUnknownOrders.has(sessionName) ? { tabTargetUnknown: true as const } : {}),
			tabTarget: this.tabTargets.get(sessionName)?.target,
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
		const current = this.tabTargets.get(options.sessionName);
		if (
			!shouldApplyTabTargetUpdate(
				current,
				this.tabTargetUnknownOrders.get(options.sessionName),
				options.update.sessionPageStateUpdateOrder,
			)
		) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		this.tabTargetUnknownOrders.delete(options.sessionName);
		this.tabTargets.set(options.sessionName, {
			order: options.update.sessionPageStateUpdateOrder,
			reopenPending: current?.reopenPending,
			target: options.target,
		});
		return { ...this.get(options.sessionName), applied: true };
	}
	setTabReopenPending(options: {
		readonly pending: boolean;
		readonly sessionName: string;
		readonly update: SessionPageStateUpdateToken;
	}): void {
		const current = this.tabTargets.get(options.sessionName);
		if (
			!current ||
			!shouldApplyTabTargetUpdate(
				current,
				this.tabTargetUnknownOrders.get(options.sessionName),
				options.update.sessionPageStateUpdateOrder,
			)
		) {
			return;
		}
		this.tabTargets.set(options.sessionName, {
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
			!shouldApplyRefStateUpdate({
				currentInvalidation: this.refSnapshotInvalidations.get(options.sessionName),
				currentSnapshot: this.refSnapshots.get(options.sessionName),
				updateOrder: options.update.sessionPageStateUpdateOrder,
			})
		) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		const snapshot = {
			...options.snapshot,
			generation: options.snapshot.generation ?? this.nativeGenerations.get(options.sessionName),
			snapshotId: options.snapshot.snapshotId ?? randomUUID(),
			target: options.snapshot.target ?? options.fallbackTarget,
		};
		this.refSnapshotInvalidations.delete(options.sessionName);
		this.refSnapshots.set(options.sessionName, {
			...snapshot,
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
		const snapshot = this.refSnapshots.get(sessionName);
		if (snapshot) {
			this.refSnapshots.set(sessionName, { ...snapshot, generation });
		}
	}
	applyRefSnapshotInvalidation(options: {
		readonly invalidation: SessionRefSnapshotInvalidation;
		readonly sessionName: string;
		readonly update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		if (
			!shouldApplyRefStateUpdate({
				currentInvalidation: this.refSnapshotInvalidations.get(options.sessionName),
				currentSnapshot: this.refSnapshots.get(options.sessionName),
				updateOrder: options.update.sessionPageStateUpdateOrder,
			})
		) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		this.refSnapshots.delete(options.sessionName);
		this.refSnapshotInvalidations.set(options.sessionName, {
			...options.invalidation,
			order: options.update.sessionPageStateUpdateOrder,
		});
		return { ...this.get(options.sessionName), applied: true };
	}
	markTabTargetUnknown(options: {
		readonly sessionName: string;
		readonly update: SessionPageStateUpdateToken;
	}): SessionPageStateUpdateResult {
		const current = this.tabTargets.get(options.sessionName);
		if (
			!shouldApplyTabTargetUpdate(
				current,
				this.tabTargetUnknownOrders.get(options.sessionName),
				options.update.sessionPageStateUpdateOrder,
			)
		) {
			return { ...this.get(options.sessionName), applied: false, stale: true };
		}
		this.refSnapshotInvalidations.delete(options.sessionName);
		this.refSnapshots.delete(options.sessionName);
		this.tabPinningReasons.delete(options.sessionName);
		this.tabTargets.delete(options.sessionName);
		this.tabTargetUnknownOrders.set(
			options.sessionName,
			options.update.sessionPageStateUpdateOrder,
		);
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
