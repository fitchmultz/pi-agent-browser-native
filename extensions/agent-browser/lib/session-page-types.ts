export interface SessionTabTarget {
	readonly targetId?: string | undefined;
	readonly title?: string | undefined;
	readonly url: string;
}
export interface OrderedSessionTabTarget {
	readonly order: number;
	readonly reopenPending?: boolean | undefined;
	readonly target: SessionTabTarget;
}
export interface SessionRefSnapshot {
	readonly snapshotId?: string;
	readonly generation?: string | undefined;
	readonly refIds: readonly string[];
	readonly refs?: Readonly<
		Record<
			string,
			{
				readonly isContentEditable?: boolean;
				readonly isEditable?: boolean;
				readonly name: string;
				readonly role: string;
			}
		>
	>;
	readonly target?: SessionTabTarget | undefined;
}
export interface OrderedSessionRefSnapshot extends SessionRefSnapshot {
	readonly order: number;
}
export interface SessionRefSnapshotInvalidation {
	readonly reason: "no-active-page" | "page-transition";
	readonly summary: string;
}
export interface OrderedSessionRefSnapshotInvalidation extends SessionRefSnapshotInvalidation {
	readonly order: number;
}
export interface BatchRefSnapshotState {
	readonly invalidation?: SessionRefSnapshotInvalidation;
	readonly refreshArgs?: readonly string[];
	readonly snapshot?: SessionRefSnapshot;
}
export type SessionTabPinningReason = "drift" | "restore";
export interface SessionPageStateUpdateToken {
	readonly sessionPageStateUpdateOrder: number;
}
export interface SessionPageStateView {
	readonly confirmActions?: string | undefined;
	readonly pinningReason?: SessionTabPinningReason | undefined;
	readonly tabReopenPending?: boolean | undefined;
	readonly tabTargetUnknown?: true;
	readonly refSnapshot?: SessionRefSnapshot | undefined;
	readonly refSnapshotInvalidation?: SessionRefSnapshotInvalidation | undefined;
	readonly tabTarget?: SessionTabTarget | undefined;
}
export interface SessionPageStateUpdateResult extends SessionPageStateView {
	readonly applied: boolean;
	readonly stale?: boolean;
}

/** One session's usable ref snapshot. */
export type SessionRefSnapshotState = OrderedSessionRefSnapshot & { readonly kind: "snapshot" };

/** One session's ref state. A usable snapshot and an invalidation are alternatives, never both. */
export type SessionRefState =
	| SessionRefSnapshotState
	| (OrderedSessionRefSnapshotInvalidation & { readonly kind: "invalidated" });

/** One session's tab target: the ordered target, or the order at which it became unknown. */
export type SessionTabTargetState =
	| (OrderedSessionTabTarget & { readonly kind: "target" })
	| { readonly kind: "unknown"; readonly order: number };
