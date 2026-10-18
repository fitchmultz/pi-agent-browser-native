import { createHash } from "node:crypto";
import {
	snapshotDefinition,
	type BrowserSnapshot,
	type BrowserRecord,
	type BrowserPageChange,
} from "./browser-transcript.js";
import { browserStringArray } from "./browser-value-parsing.js";
import { isRecord } from "./parsing.js";
import { isReadOnlyDiagnosticSessionTargetCommand } from "./command-taxonomy.js";
import {
	normalizeSessionTabTarget,
	extractSessionTabTargetFromBatchResults,
	isNoActivePageSnapshotFailure,
	buildNoActivePageRefSnapshotInvalidation,
} from "./session-page-observation.js";
import type { SessionTabTarget, SessionRefSnapshotInvalidation } from "./session-page-types.js";
import type { LegacyPage, LegacyContext, LegacySnapshot } from "./browser-legacy-types.js";

function legacyTarget(value: Readonly<Record<string, unknown>>): SessionTabTarget | undefined {
	return normalizeSessionTabTarget({
		url: typeof value.url === "string" ? value.url : undefined,
		title: typeof value.title === "string" ? value.title : undefined,
		targetId: typeof value.targetId === "string" ? value.targetId : undefined,
	});
}
export function legacySnapshot(value: unknown, id: string): BrowserSnapshot | undefined {
	if (!isRecord(value) || !Array.isArray(value.refIds)) {
		return undefined;
	}
	const refIds = browserStringArray(value.refIds).filter((ref) => /^e\d+$/.test(ref));
	const sourceRefs = isRecord(value.refs) ? value.refs : {};
	return snapshotDefinition({
		snapshotId: typeof value.snapshotId === "string" ? value.snapshotId : id,
		refIds,
		generation: typeof value.generation === "string" ? value.generation : undefined,
		refs: Object.fromEntries(
			refIds.flatMap((refId) => {
				const ref = sourceRefs[refId];
				if (!isRecord(ref) || typeof ref.name !== "string" || typeof ref.role !== "string") {
					return [];
				}
				return [
					[
						refId,
						{
							name: ref.name,
							role: ref.role,
							...(typeof ref.isEditable === "boolean" ? { isEditable: ref.isEditable } : {}),
							...(typeof ref.isContentEditable === "boolean"
								? { isContentEditable: ref.isContentEditable }
								: {}),
						},
					],
				];
			}),
		),
		target: isRecord(value.target) ? legacyTarget(value.target) : undefined,
	});
}
function snapshotDigest(
	definition: Readonly<{ refs?: unknown; target?: unknown; generation?: unknown }>,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				refs: definition.refs,
				target: definition.target,
				generation: definition.generation,
			}),
		)
		.digest("hex");
}
export function canonicalPage(
	prior: LegacyPage,
	canonical: BrowserRecord,
	page: BrowserPageChange,
): LegacyPage {
	const definition = isRecord(canonical.snapshot) ? canonical.snapshot : undefined;
	const digest =
		definition !== undefined && Boolean(definition.refs)
			? snapshotDigest(definition)
			: (prior.snapshot?.digest ?? "");
	let snapshot: LegacySnapshot | undefined;
	if (page.refs.kind === "replace" || page.refs.kind === "reuse") {
		snapshot = { id: page.refs.snapshotId, digest, usable: true, candidate: false };
	} else if (prior.snapshot) {
		snapshot = { ...prior.snapshot, usable: false, candidate: canonical.event.phase === "begin" };
	}
	return {
		target: page.target,
		unknown: page.unknown,
		reopenPending: page.reopenPending,
		snapshot,
		pending:
			canonical.event.phase === "begin"
				? {
						operationId: canonical.event.operationId,
						toolCallId: canonical.event.toolCallId,
						index: canonical.event.commandIndex,
					}
				: undefined,
	};
}
function parseInvalidation(
	value: unknown,
	fallbackSummary: boolean,
): SessionRefSnapshotInvalidation | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.reason !== "no-active-page" && value.reason !== "page-transition") {
		throw new Error("Invalid legacy browser ref invalidation.");
	}
	if (typeof value.summary === "string") {
		return { reason: value.reason, summary: value.summary };
	}
	if (fallbackSummary) {
		return {
			reason: value.reason,
			summary: "The prior refs were invalidated; take a fresh snapshot.",
		};
	}
	throw new Error("Invalid legacy browser ref invalidation summary.");
}
function observedInvalidation(ctx: LegacyContext): SessionRefSnapshotInvalidation | undefined {
	const value = ctx.details.refSnapshotInvalidation;
	if (
		isRecord(value) &&
		(value.reason === "no-active-page" || value.reason === "page-transition")
	) {
		return parseInvalidation(value, true);
	}
	let error: string | undefined;
	if (typeof ctx.details.error === "string") {
		error = ctx.details.error;
	} else if (typeof ctx.details.summary === "string") {
		error = ctx.details.summary;
	}
	return isNoActivePageSnapshotFailure(ctx.command, error)
		? buildNoActivePageRefSnapshotInvalidation()
		: undefined;
}
function snapshotReusable(
	page: LegacyPage,
	details: Readonly<Record<string, unknown>>,
	digest: string,
): boolean {
	return (
		page.snapshot?.digest === digest &&
		(page.snapshot.usable || page.snapshot.candidate) &&
		(!isRecord(details.refSnapshot) ||
			typeof details.refSnapshot.snapshotId !== "string" ||
			details.refSnapshot.snapshotId === page.snapshot.id)
	);
}
type MutableLegacyPage = { -readonly [K in keyof LegacyPage]: LegacyPage[K] };
/** One legacy entry owns a shallow page draft; previous snapshots and parent views are never mutated. */
export class LegacyPageConversion {
	readonly page: MutableLegacyPage;
	definition: BrowserSnapshot | undefined;
	constructor(
		private readonly ctx: LegacyContext,
		prior: LegacyPage,
	) {
		this.page = { ...prior };
	}
	private knownTarget(): void {
		const { details, command, subcommand } = this.ctx;
		if (
			!isRecord(details.compiledNetworkSourceLookup) &&
			!isReadOnlyDiagnosticSessionTargetCommand(command, subcommand) &&
			isRecord(details.sessionTabTarget)
		) {
			this.page.target = legacyTarget(details.sessionTabTarget) ?? this.page.target;
		} else if (command === "batch" && !isRecord(details.compiledNetworkSourceLookup)) {
			this.page.target = extractSessionTabTargetFromBatchResults(details.data) ?? this.page.target;
		}
		if (this.page.target) {
			this.page.unknown = undefined;
		}
		if (typeof details.sessionTabReopenPending === "boolean") {
			this.page.reopenPending = details.sessionTabReopenPending;
		}
	}
	private knownRefs(): BrowserPageChange["refs"] {
		const invalidation = observedInvalidation(this.ctx);
		const candidate = invalidation
			? undefined
			: legacySnapshot(this.ctx.details.refSnapshot, `snapshot-${this.ctx.nativeId}`);
		if (candidate) {
			const digest = snapshotDigest(candidate);
			let refs: BrowserPageChange["refs"];
			if (snapshotReusable(this.page, this.ctx.details, digest) && this.page.snapshot) {
				refs = { kind: "reuse", snapshotId: this.page.snapshot.id };
			} else {
				this.definition = candidate;
				refs = { kind: "replace", snapshotId: candidate.id };
			}
			this.page.snapshot = { id: refs.snapshotId, digest, usable: true, candidate: false };
			return refs;
		}
		if (invalidation) {
			this.disableSnapshot(false);
			return { kind: "invalidate", invalidation };
		}
		return this.page.snapshot?.usable === true
			? { kind: "reuse", snapshotId: this.page.snapshot.id }
			: { kind: "invalidate" };
	}
	private disableSnapshot(candidate: boolean): void {
		if (this.page.snapshot) {
			this.page.snapshot = { ...this.page.snapshot, usable: false, candidate };
		}
	}
	change(key: string): BrowserPageChange {
		return {
			...this.pageChange(key),
			...(typeof this.ctx.details.sessionConfirmActions === "string" ||
			this.ctx.details.sessionConfirmActions === null
				? { confirmActions: this.ctx.details.sessionConfirmActions }
				: {}),
		};
	}
	private pageChange(key: string): BrowserPageChange {
		const ctx = this.ctx;
		if (ctx.begin) {
			this.page.target = undefined;
			this.page.unknown = true;
			this.page.snapshot = ctx.prior.snapshot
				? { ...ctx.prior.snapshot, usable: false, candidate: true }
				: undefined;
			this.page.pending = {
				toolCallId: ctx.toolCallId,
				operationId: ctx.operationId,
				index: ctx.commandIndex,
			};
			return { key, refs: { kind: "unknown" }, unknown: true };
		}
		if (ctx.details.sessionTabTargetUnknown === true) {
			this.page.target = undefined;
			this.page.unknown = true;
			this.page.pending = undefined;
			this.disableSnapshot(false);
			return {
				key,
				refs: {
					kind: "unknown",
					invalidation: parseInvalidation(ctx.details.refSnapshotInvalidation, false),
				},
				unknown: true,
			};
		}
		this.knownTarget();
		const refs = this.knownRefs();
		this.page.pending = undefined;
		return {
			key,
			target: this.page.target,
			unknown: this.page.unknown,
			reopenPending: this.page.reopenPending,
			refs,
		};
	}
}
