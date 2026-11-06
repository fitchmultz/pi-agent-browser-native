import { randomUUID } from "node:crypto";
import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import {
	getAgentBrowserSessionIdentityKey,
	isAgentBrowserSessionIdentityKeyInNamespace,
} from "./argv-grammar.js";
import { batchHasSuccessfulCloseAll, getSuccessfulBatchCloseLifecycle } from "./batch-lifecycle.js";
import {
	BROWSER_RESULT_TOOLS,
	BROWSER_TRANSITION_ENTRY,
	applyArtifactChanges,
	artifactChanges,
	browserStateEffects,
	parseBrowserRecord,
	persistedBrowserRecord,
	type BrowserPageChange,
	type BrowserRecord,
	type BrowserSnapshot,
} from "./browser-transcript.js";
import { isCloseAllCommand, isCloseCommand } from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";
import { isSessionArtifactManifest } from "./results/artifact-manifest.js";
import { isSuccessfulNativeConfirmedClose } from "./native-confirmation.js";

import { browserStringArray } from "./browser-value-parsing.js";

import { canonicalPage, LegacyPageConversion } from "./browser-legacy-pages.js";
import type {
	LegacyProjection,
	LegacyProjectionState,
	LegacyContext,
} from "./browser-legacy-types.js";
import { BrowserConversionBranches } from "./browser-conversion-branches.js";
export type { LegacyProjection } from "./browser-legacy-types.js";
export const emptyProjection = (): LegacyProjectionState => ({ pages: new Map(), nextIndex: 0 });

class LegacyBrowserConversion {
	private readonly current: LegacyProjectionState;

	constructor(private readonly parent: LegacyProjection) {
		this.current = {
			pages: new Map(parent.pages),
			manifest: parent.manifest,
			nextIndex: parent.nextIndex,
		};
	}

	convert(
		entry: Readonly<Record<string, unknown>>,
		ownerSessionId: string | undefined,
	): { record?: BrowserRecord; projection: LegacyProjection } {
		const canonical = parseBrowserRecord(entry);
		if (canonical) {
			this.applyCanonical(canonical);
			return { projection: this.current };
		}
		const script = scriptRecord(
			entry,
			typeof entry.id === "string" ? entry.id : randomUUID(),
			ownerSessionId,
		);
		if (script) {
			return { record: script, projection: this.current };
		}
		const message = legacyMessage(entry);
		if (!message || !isRecord(message.details)) {
			return { projection: this.parent };
		}
		return {
			record: this.convertMessage(this.context(entry, message, message.details), ownerSessionId),
			projection: this.current,
		};
	}

	private applyCanonical(canonical: BrowserRecord): void {
		this.current.manifest = applyArtifactChanges(this.parent.manifest, canonical.event.artifacts);
		for (const page of canonical.event.pages ?? []) {
			if (page.clear === true) {
				this.current.pages.delete(page.key);
				continue;
			}
			this.current.pages.set(
				page.key,
				canonicalPage(this.current.pages.get(page.key) ?? {}, canonical, page),
			);
		}
	}
	private operationIdentity(options: {
		readonly entry: Readonly<Record<string, unknown>>;
		readonly details: Readonly<Record<string, unknown>>;
		readonly key?: string | undefined;
		readonly toolCallId: string;
		readonly nativeId: string;
	}): Pick<LegacyContext, "prior" | "begin" | "phase" | "commandIndex" | "operationId"> {
		const prior = legacyPrior(options.key, this.current);
		const begin = isLegacyBegin(options.entry, options.details);
		const pending = prior.pending?.toolCallId === options.toolCallId ? prior.pending : undefined;
		let phase: LegacyContext["phase"] = "state";
		if (begin) {
			phase = "begin";
		} else if (pending) {
			phase = "finish";
		}
		let commandIndex = pending?.index ?? 0;
		if (begin) {
			commandIndex = this.current.nextIndex;
			this.current.nextIndex++;
		}
		return {
			prior,
			begin,
			phase,
			commandIndex,
			operationId: pending?.operationId ?? `legacy-${options.nativeId}`,
		};
	}
	private context(
		entry: Readonly<Record<string, unknown>>,
		message: Readonly<Record<string, unknown>>,
		details: Readonly<Record<string, unknown>>,
	): LegacyContext {
		const nativeId = typeof entry.id === "string" ? entry.id : randomUUID();
		const toolCallId =
			typeof message.toolCallId === "string" ? message.toolCallId : `legacy-${nativeId}`;
		const replayDetails = normalizeLegacyDetails(details, message.isError === true);
		const identity = legacyIdentity(replayDetails);
		const operation = this.operationIdentity({
			entry,
			details: replayDetails,
			key: identity.key,
			toolCallId,
			nativeId,
		});
		return {
			...identity,
			...operation,
			nativeId,
			details: replayDetails,
			isError: message.isError === true,
			toolCallId,
		};
	}
	private closePages(
		ctx: LegacyContext,
	): ReturnType<typeof closingLifecycle> & { readonly pages: BrowserPageChange[] } {
		const closing = closingLifecycle(ctx);
		const pages: BrowserPageChange[] = [];
		if (closing.closeAll) {
			for (const key of this.current.pages.keys()) {
				if (isAgentBrowserSessionIdentityKeyInNamespace(key, ctx.namespace)) {
					this.current.pages.delete(key);
					pages.push({ key, clear: true, refs: { kind: "invalidate" } });
				}
			}
		} else if (ctx.key !== undefined && closing.lifecycleReset) {
			this.current.pages.delete(ctx.key);
			pages.push({ key: ctx.key, clear: true, refs: { kind: "invalidate" } });
		}
		return { ...closing, pages };
	}
	private updateManifest(
		details: Readonly<Record<string, unknown>>,
	): ReturnType<typeof artifactChanges> {
		if (
			isSessionArtifactManifest(details.artifactManifest) &&
			(!this.parent.manifest ||
				details.artifactManifest.updatedAtMs >= this.parent.manifest.updatedAtMs)
		) {
			this.current.manifest = details.artifactManifest;
		}
		const changes = artifactChanges(this.parent.manifest, this.current.manifest);
		if (!changes) {
			this.current.manifest = this.parent.manifest;
		}
		return changes;
	}
	private convertMessage(ctx: LegacyContext, ownerSessionId: string | undefined): BrowserRecord {
		const closing = this.closePages(ctx);
		const pages = closing.pages;
		let definition: BrowserSnapshot | undefined;
		const suppressPage =
			(closing.closeAll || closing.lifecycleReset) &&
			(isCloseCommand(ctx.command) || closing.endsClosed);
		if (ctx.key !== undefined && hasPageEffects(ctx) && !suppressPage) {
			const conversion = new LegacyPageConversion(ctx, this.current.pages.get(ctx.key) ?? {});
			pages.push(conversion.change(ctx.key));
			this.current.pages.set(ctx.key, conversion.page);
			definition = conversion.definition;
		}
		const artifacts = this.updateManifest(ctx.details);
		// Synthesized records publish receipts; `this.current.manifest` keeps the retained comparison rows.
		return persistedBrowserRecord({
			event: {
				version: 1,
				phase: ctx.phase,
				operationId: ctx.operationId,
				toolCallId: ctx.toolCallId,
				commandIndex: ctx.commandIndex,
				isError: ctx.isError,
				state: stampElectronState(browserStateEffects(ctx.details), ownerSessionId),
				pages,
				artifacts,
			},
			...(definition ? { snapshot: definition } : {}),
		});
	}
}

function legacyMessage(
	entry: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
	if (
		entry.type === "custom" &&
		entry.customType === BROWSER_TRANSITION_ENTRY &&
		isRecord(entry.data) &&
		isRecord(entry.data.details)
	) {
		return entry.data;
	}
	const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
	return isLegacyToolMessage(message) ? message : undefined;
}
function isLegacyToolMessage(message: Readonly<Record<string, unknown>> | undefined): boolean {
	return (
		message !== undefined &&
		typeof message.toolName === "string" &&
		BROWSER_RESULT_TOOLS.has(message.toolName) &&
		isRecord(message.details) &&
		message.details.browserEventVersion !== 1
	);
}
function scriptRecord(
	entry: Readonly<Record<string, unknown>>,
	nativeId: string,
	ownerSessionId: string | undefined,
): BrowserRecord | undefined {
	if (
		entry.type !== "custom" ||
		entry.customType !== "agent-browser-script-session" ||
		!isRecord(entry.data)
	) {
		return undefined;
	}
	return {
		event: {
			version: 1,
			phase: "state",
			operationId: `legacy-${nativeId}`,
			toolCallId: `legacy-${nativeId}`,
			commandIndex: 0,
			isError: entry.data.cleanup !== "closed",
			state: {
				scriptLease: { ...entry.data, ownerSessionId: entry.data.ownerSessionId ?? ownerSessionId },
			},
		},
	};
}
function isLegacyBegin(
	entry: Readonly<Record<string, unknown>>,
	details: Readonly<Record<string, unknown>>,
): boolean {
	return (
		entry.type === "custom" &&
		details.sessionTabTargetUnknown === true &&
		details.command === undefined &&
		details.exitCode === undefined &&
		details.agentBrowserStarted === undefined
	);
}
function legacyIdentity(
	details: Readonly<Record<string, unknown>>,
): Pick<LegacyContext, "key" | "namespace" | "tokens" | "command" | "subcommand"> {
	const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
	const namespace = typeof details.namespace === "string" ? details.namespace : undefined;
	const key =
		sessionName !== undefined && sessionName.length > 0
			? getAgentBrowserSessionIdentityKey(sessionName, namespace)
			: undefined;
	const tokens = extractUpstreamCommandTokens(browserStringArray(details.args));
	return {
		key,
		namespace,
		tokens,
		command: typeof details.command === "string" ? details.command : tokens[0],
		subcommand: typeof details.subcommand === "string" ? details.subcommand : tokens[1],
	};
}
function legacyPrior(key: string | undefined, current: LegacyProjection): LegacyContext["prior"] {
	return key === undefined ? {} : (current.pages.get(key) ?? {});
}
function normalizeLegacyBatchStep(
	step: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return step.success === true &&
		isSuccessfulNativeConfirmedClose(browserStringArray(step.command), step.data)
		? { ...step, command: ["close"] }
		: step;
}
function normalizeLegacyDetails(
	details: Readonly<Record<string, unknown>>,
	isError: boolean,
): Readonly<Record<string, unknown>> {
	const closed =
		!isError &&
		isSuccessfulNativeConfirmedClose(
			extractUpstreamCommandTokens(browserStringArray(details.args)),
			details.data,
		);
	const batchSteps = Array.isArray(details.batchSteps)
		? details.batchSteps.filter(isRecord).map(normalizeLegacyBatchStep)
		: undefined;
	return {
		...details,
		...(closed ? { command: "close", subcommand: undefined } : {}),
		...(batchSteps !== undefined ? { batchSteps } : {}),
	};
}
function closingLifecycle(ctx: LegacyContext): {
	readonly closeAll: boolean;
	readonly lifecycleReset: boolean;
	readonly endsClosed: boolean;
} {
	const close = getSuccessfulBatchCloseLifecycle(ctx.details.batchSteps);
	const closeAll =
		ctx.details.closeAllApplied === true ||
		(!ctx.isError && isCloseAllCommand(ctx.tokens)) ||
		batchHasSuccessfulCloseAll(ctx.details.batchSteps);
	return {
		closeAll,
		lifecycleReset: (!ctx.isError && isCloseCommand(ctx.command)) || close !== undefined,
		endsClosed: close?.endsClosed === true,
	};
}
function hasPageEffects(ctx: LegacyContext): boolean {
	return (
		ctx.begin ||
		[
			"sessionTabTargetUnknown",
			"sessionTabTarget",
			"sessionTabReopenPending",
			"sessionConfirmActions",
			"refSnapshot",
			"refSnapshotInvalidation",
		].some((field) => ctx.details[field] !== undefined) ||
		(ctx.command === "batch" && Array.isArray(ctx.details.data))
	);
}
function stampElectronState(
	state: Readonly<Record<string, unknown>>,
	ownerSessionId: string | undefined,
): Record<string, unknown> {
	if (!isRecord(state.electron)) {
		return state;
	}
	const stamp = (value: unknown) =>
		isRecord(value) ? { ...value, ownerSessionId: value.ownerSessionId ?? ownerSessionId } : value;
	const cleanup = isRecord(state.electron.cleanup) ? state.electron.cleanup : undefined;
	return {
		...state,
		electron: {
			...state.electron,
			launch: stamp(state.electron.launch),
			...(cleanup
				? {
						cleanup: {
							...cleanup,
							records: Array.isArray(cleanup.records)
								? cleanup.records.map(stamp)
								: cleanup.records,
							results: Array.isArray(cleanup.results)
								? cleanup.results.map((row: unknown) =>
										isRecord(row) ? { ...row, record: stamp(row.record) } : row,
									)
								: cleanup.results,
						},
					}
				: {}),
		},
	};
}
/**
 * Ownerless legacy cleanup records fall back to the native session UUID. A legacy fork without an
 * explicit cleanup owner cannot acquire its parent's leases.
 */
export function legacyCleanupOwner(
	header: Readonly<{ id: string; parentSession?: unknown }>,
): string | undefined {
	return header.parentSession === undefined ? header.id : undefined;
}

/** Normalize old receipts into the canonical reducer along their actual parent ancestry. */
export function convertLegacyBrowserEntry(
	entry: Readonly<Record<string, unknown>>,
	parent: LegacyProjection = emptyProjection(),
	ownerSessionId?: string,
): { record?: BrowserRecord; projection: LegacyProjection } {
	return new LegacyBrowserConversion(parent).convert(entry, ownerSessionId);
}
function archiveParent(
	value: Readonly<Record<string, unknown>>,
	branches: Readonly<Pick<BrowserConversionBranches, "get">>,
	linear: LegacyProjection,
): LegacyProjection {
	if (typeof value.parentId === "string") {
		return branches.get(value.parentId) ?? emptyProjection();
	}
	return Object.hasOwn(value, "parentId") ? emptyProjection() : linear;
}
/** Read-only normalization; callers choose whether to replay or publish a separate archive copy. */
export function convertBrowserEntries(
	entries: readonly unknown[],
	ownerSessionId?: string,
): unknown[] {
	const branches = new BrowserConversionBranches(
		entries.map((value) => (isRecord(value) ? value.parentId : undefined)),
	);
	let linear: LegacyProjection = emptyProjection();
	return entries.map((value, index) => {
		if (!isRecord(value)) {
			return value;
		}
		const entry: Record<string, unknown> & { id: string } = {
			...value,
			id: typeof value.id === "string" ? value.id : `archive-${index}`,
			parentId: value.parentId ?? null,
		};
		const converted = convertLegacyBrowserEntry(
			entry,
			archiveParent(value, branches, linear),
			ownerSessionId,
		);
		branches.advance(entry.id, value.parentId, converted.projection);
		linear = converted.projection;
		return converted.record
			? {
					...entry,
					...(entry.type === "custom" ? { customType: BROWSER_TRANSITION_ENTRY } : {}),
					data: converted.record,
				}
			: entry;
	});
}
