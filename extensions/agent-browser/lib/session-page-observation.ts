import { browserStringArray } from "./browser-value-parsing.js";
import { extractUpstreamCommandTokens } from "./argv-descriptor.js";
import { getAgentBrowserSessionIdentityKey } from "./argv-grammar.js";
import {
	isCloseCommand,
	isOpenNavigationCommand,
	isReadOnlyDiagnosticSessionTargetCommand,
	isRecordPageTransitionCommand,
	isUnverifiedPageTransitionCommand,
	isWebMcpPageMutationCommand,
	isWindowOrDiffPageTransitionCommand,
} from "./command-taxonomy.js";
import { isRecord } from "./parsing.js";
import { detectConfirmationRequired } from "./results/confirmation.js";
import { isSuccessfulNativeConfirmedClose } from "./read-confirmation.js";
import { getEditableRefEvidence } from "./results/editable-ref-evidence.js";
import {
	enrichSnapshotRefEntries,
	getFullSnapshotData,
	getSnapshotRefEntries,
} from "./results/snapshot-refs.js";
import { parseSnapshotLines } from "./results/snapshot-segments.js";

import type {
	SessionTabTarget,
	SessionRefSnapshot,
	OrderedSessionRefSnapshot,
	OrderedSessionRefSnapshotInvalidation,
	SessionRefSnapshotInvalidation,
	BatchRefSnapshotState,
} from "./session-page-types.js";
export type {
	SessionTabTarget,
	OrderedSessionTabTarget,
	SessionRefSnapshot,
	OrderedSessionRefSnapshot,
	SessionRefSnapshotInvalidation,
	OrderedSessionRefSnapshotInvalidation,
	BatchRefSnapshotState,
	SessionTabPinningReason,
	SessionPageStateUpdateToken,
	SessionPageStateView,
	SessionPageStateUpdateResult,
} from "./session-page-types.js";

export function normalizeComparableUrl(url: string | undefined): string | undefined {
	const normalizedUrl = url?.trim();
	if (normalizedUrl === undefined || normalizedUrl.length === 0) {
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

function trimmedOptionalValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeSessionTabTarget(
	target:
		| {
				readonly targetId?: string | undefined;
				readonly title?: string | undefined;
				readonly url?: string | undefined;
		  }
		| undefined,
): SessionTabTarget | undefined {
	if (!target) {
		return undefined;
	}
	const url = trimmedOptionalValue(target.url);
	if (url === undefined || normalizeComparableUrl(url) === undefined) {
		return undefined;
	}
	const targetId = trimmedOptionalValue(target.targetId);
	return {
		...(targetId !== undefined ? { targetId } : {}),
		title: trimmedOptionalValue(target.title),
		url,
	};
}

export function isAboutBlankUrl(url: string | undefined): boolean {
	return normalizeComparableUrl(url) === "about:blank";
}

export function isAboutBlankSessionTabTarget(target: SessionTabTarget | undefined): boolean {
	return isAboutBlankUrl(target?.url);
}

export function commandExplicitlyTargetsAboutBlank(commandTokens: readonly string[]): boolean {
	return (
		(commandTokens[0] === "window" && commandTokens[1] === "new") ||
		commandTokens.some((token) => isAboutBlankUrl(token))
	);
}

export function targetsMatch(
	left: SessionTabTarget | undefined,
	right: SessionTabTarget | undefined,
): boolean {
	if (!left || !right) {
		return true;
	}
	return normalizeComparableUrl(left.url) === normalizeComparableUrl(right.url);
}

/** Native getter text from bare data or one string field: `value` is verbatim, others trimmed or undefined when blank. */
export function extractStringResultField(
	data: unknown,
	fieldName: "result" | "title" | "url" | "value",
): string | undefined {
	if (typeof data === "string") {
		if (fieldName === "value") {
			return data;
		}
		const text = data.trim();
		return text.length > 0 ? text : undefined;
	}
	if (!isRecord(data) || typeof data[fieldName] !== "string") {
		return undefined;
	}
	if (fieldName === "value") {
		return data[fieldName];
	}
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

export function extractBatchResultCommand(item: Readonly<Record<string, unknown>>): string[] {
	return browserStringArray(item.command);
}

function confirmedNavigationResult(
	command: string | undefined,
	data: unknown,
): Readonly<Record<string, unknown>> | undefined {
	if (
		command === "confirm" &&
		isRecord(data) &&
		data.confirmed === true &&
		(data.action === "navigate" || data.action === "url") &&
		isRecord(data.result) &&
		data.result.success === true &&
		!detectConfirmationRequired(data)
	) {
		return data.result;
	}
	return undefined;
}

export function extractSessionTabTargetFromCommandData(
	commandTokens: readonly string[],
	data: unknown,
): SessionTabTarget | undefined {
	const [command, subcommand] = commandTokens;
	const confirmed = confirmedNavigationResult(command, data);
	if (confirmed) {
		return extractSessionTabTargetFromData(confirmed.data);
	}
	if (command === "get" && subcommand === "url") {
		return normalizeSessionTabTarget({
			url: extractStringResultField(data, "url") ?? extractStringResultField(data, "result"),
		});
	}
	return isReadOnlyDiagnosticSessionTargetCommand(command, subcommand)
		? undefined
		: extractSessionTabTargetFromData(data);
}

class BatchTargetObservation {
	target: SessionTabTarget | undefined;
	private pendingTitle: string | undefined;
	observe(item: Readonly<Record<string, unknown>>): void {
		if (detectConfirmationRequired(item.result)) {
			return;
		}
		// Only this native row can describe the active tab's identity.
		if (this.target?.targetId !== undefined && this.target.targetId.length > 0) {
			this.target = normalizeSessionTabTarget({ title: this.target.title, url: this.target.url });
		}
		const tokens = extractUpstreamCommandTokens(extractBatchResultCommand(item));
		this.invalidateTransition(tokens);
		if (item.success === false) {
			return;
		}
		this.observeResult(tokens, item.result);
	}
	private invalidateTransition(tokens: readonly string[]): void {
		const [name, subcommand] = tokens;
		if (
			isOpenNavigationCommand(name) ||
			isUnverifiedPageTransitionCommand(name, subcommand) ||
			(name === "click" && tokens.includes("--new-tab"))
		) {
			this.target = undefined;
			this.pendingTitle = undefined;
		}
	}
	private observeResult(tokens: readonly string[], result: unknown): void {
		const [name, subcommand] = tokens;
		if (isCloseCommand(name) || isSuccessfulNativeConfirmedClose(tokens, result)) {
			this.target = undefined;
			this.pendingTitle = undefined;
			return;
		}
		if (name === "get" && subcommand === "title") {
			this.pendingTitle = extractStringResultField(result, "title");
			return;
		}
		if (name === "get" && subcommand === "url") {
			const target = normalizeSessionTabTarget({
				title: this.pendingTitle,
				url: extractStringResultField(result, "url"),
			});
			if (target) {
				this.target = target;
			}
		} else {
			const target = extractSessionTabTargetFromCommandData(tokens.slice(0, 2), result);
			if (target) {
				this.target = target;
			}
		}
		this.pendingTitle = undefined;
	}
}

export function extractSessionTabTargetFromBatchResults(
	data: unknown,
): SessionTabTarget | undefined {
	if (!Array.isArray(data)) {
		return undefined;
	}
	const observation = new BatchTargetObservation();
	for (const item of data) {
		if (isRecord(item)) {
			observation.observe(item);
		}
	}
	return observation.target;
}

export function deriveSessionTabTarget(options: {
	readonly command?: string | undefined;
	readonly data: unknown;
	readonly navigationSummary?:
		| { readonly title?: string | undefined; readonly url?: string | undefined }
		| undefined;
	readonly previousTarget?: SessionTabTarget | undefined;
	readonly subcommand?: string | undefined;
}): SessionTabTarget | undefined {
	if (isCloseCommand(options.command)) {
		return undefined;
	}
	const commandDataTarget = extractSessionTabTargetFromCommandData(
		[options.command, options.subcommand].filter((token): token is string => token !== undefined),
		options.data,
	);
	const observedTarget =
		normalizeSessionTabTarget(options.navigationSummary) ??
		extractSessionTabTargetFromBatchResults(options.data) ??
		commandDataTarget;
	if (observedTarget || !isUnverifiedPageTransitionCommand(options.command, options.subcommand)) {
		return observedTarget ?? options.previousTarget;
	}
	return undefined;
}

function extractRefSnapshotRefs(
	data: unknown,
):
	| Record<
			string,
			{ isContentEditable?: boolean; isEditable?: boolean; name: string; role: string }
	  >
	| undefined {
	if (!isRecord(data) || !isRecord(data.refs)) {
		return undefined;
	}
	const snapshotLines = typeof data.snapshot === "string" ? parseSnapshotLines(data.snapshot) : [];
	const lineByRef = new Map(
		snapshotLines.flatMap((line) =>
			line.ref !== undefined && line.ref.length > 0 ? [[line.ref, line.raw] as const] : [],
		),
	);
	const entries = enrichSnapshotRefEntries(getSnapshotRefEntries(data), snapshotLines);
	const refs = Object.fromEntries(
		entries.flatMap((entry) => {
			if (!/^e\d+$/.test(entry.id) || entry.role.length === 0) {
				return [];
			}
			const isContentEditable = getEditableRefEvidence({
				ref: entry.refData,
				text: lineByRef.get(entry.id),
			});
			return [
				[
					entry.id,
					{
						...(isContentEditable === true ? { isContentEditable: true } : {}),
						...(entry.isEditable !== undefined ? { isEditable: entry.isEditable } : {}),
						name: entry.name,
						role: entry.role,
					},
				] as const,
			];
		}),
	);
	return Object.keys(refs).length > 0 ? refs : undefined;
}

export function extractRefSnapshotFromData(value: unknown): SessionRefSnapshot | undefined {
	if (detectConfirmationRequired(value)) {
		return undefined;
	}
	const data = getFullSnapshotData(value);
	if (!data) {
		return undefined;
	}
	const refs = extractRefSnapshotRefs(data);
	return {
		refIds: isRecord(data.refs)
			? Object.keys(data.refs).filter((refId) => /^e\d+$/.test(refId))
			: [],
		...(refs ? { refs } : {}),
		target: extractSessionTabTargetFromData(data),
	};
}

function getBatchResultFailureText(item: Readonly<Record<string, unknown>>): string | undefined {
	const result = isRecord(item.result) ? item.result : undefined;
	const parts = [
		item.error,
		result?.error,
		typeof item.result === "string" ? item.result : undefined,
	].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
	return parts.length > 0 ? parts.join("\n") : undefined;
}

export function buildNoActivePageRefSnapshotInvalidation(): SessionRefSnapshotInvalidation {
	return {
		reason: "no-active-page",
		summary:
			"The latest snapshot for this session reported No active page. Old page-scoped refs are invalid until snapshot -i succeeds.",
	};
}

export function buildPageTransitionRefSnapshotInvalidation(
	summary?: string,
): SessionRefSnapshotInvalidation {
	return {
		reason: "page-transition",
		summary:
			summary ??
			"Recording starts and URL-bearing restarts conservatively invalidate earlier page-scoped refs. Run snapshot -i before using refs; this is not evidence of a page change.",
	};
}

export function getCommandRefSnapshotInvalidation(
	commandTokens: readonly string[],
): SessionRefSnapshotInvalidation | undefined {
	if (isRecordPageTransitionCommand(commandTokens)) {
		return buildPageTransitionRefSnapshotInvalidation();
	}
	if (isWindowOrDiffPageTransitionCommand(commandTokens[0], commandTokens[1])) {
		return buildPageTransitionRefSnapshotInvalidation(
			"A window new or diff url command replaced or navigated the active page and invalidated prior refs. Run snapshot -i before using page-scoped refs.",
		);
	}
	if (isWebMcpPageMutationCommand(commandTokens)) {
		return buildPageTransitionRefSnapshotInvalidation(
			"A WebMCP invoke, result, or cancel command can mutate, rerender, or navigate the page, so the prior snapshot refs were invalidated. Run snapshot -i before using page-scoped refs.",
		);
	}
	return undefined;
}

export function isNoActivePageSnapshotFailure(
	command: string | undefined,
	text: string | undefined,
): boolean {
	return command === "snapshot" && /\bno active page\b/i.test(text ?? "");
}

function batchResultClosed(
	item: Readonly<Record<string, unknown>>,
	tokens: readonly string[],
): boolean {
	return (
		item.success !== false &&
		!detectConfirmationRequired(item.result) &&
		(isCloseCommand(tokens[0]) || isSuccessfulNativeConfirmedClose(tokens, item.result))
	);
}

function nextBatchRefState(
	item: Readonly<Record<string, unknown>>,
	previous: BatchRefSnapshotState | undefined,
): BatchRefSnapshotState | undefined {
	const tokens = extractUpstreamCommandTokens(extractBatchResultCommand(item));
	if (batchResultClosed(item, tokens)) {
		return undefined;
	}
	const invalidation = getCommandRefSnapshotInvalidation(tokens);
	if (invalidation) {
		return { invalidation };
	}
	if (tokens[0] !== "snapshot") {
		return previous;
	}
	if (item.success === false) {
		return isNoActivePageSnapshotFailure(tokens[0], getBatchResultFailureText(item))
			? { invalidation: buildNoActivePageRefSnapshotInvalidation() }
			: previous;
	}
	const snapshot = extractRefSnapshotFromData(item.result);
	if (snapshot) {
		return { snapshot };
	}
	if (isRecord(item.result) && isRecord(item.result.snapshot)) {
		return { refreshArgs: tokens.filter((token) => token !== "--delta" && token !== "--full") };
	}
	return previous;
}

export function extractLatestRefSnapshotStateFromBatchResults(
	data: unknown,
): BatchRefSnapshotState | undefined {
	if (!Array.isArray(data)) {
		return undefined;
	}
	let latest: BatchRefSnapshotState | undefined;
	for (const item of data) {
		if (isRecord(item)) {
			latest = nextBatchRefState(item, latest);
		}
	}
	return latest;
}

export function shouldApplyTabTargetUpdate(
	current: { readonly order: number } | undefined,
	unknownOrder: number | undefined,
	updateOrder: number,
): boolean {
	return updateOrder >= Math.max(current?.order ?? 0, unknownOrder ?? 0);
}

export function shouldApplyRefStateUpdate(options: {
	readonly currentInvalidation?: { readonly order: number } | undefined;
	readonly currentSnapshot?: { readonly order: number } | undefined;
	readonly updateOrder: number;
}): boolean {
	const currentOrder = Math.max(
		options.currentSnapshot?.order ?? 0,
		options.currentInvalidation?.order ?? 0,
	);
	return options.updateOrder >= currentOrder;
}

export function stripRefSnapshotOrder(
	snapshot: OrderedSessionRefSnapshot | SessionRefSnapshot | undefined,
): SessionRefSnapshot | undefined {
	return snapshot
		? {
				...(snapshot.snapshotId !== undefined && snapshot.snapshotId.length > 0
					? { snapshotId: snapshot.snapshotId }
					: {}),
				...(snapshot.generation !== undefined && snapshot.generation.length > 0
					? { generation: snapshot.generation }
					: {}),
				refIds: snapshot.refIds,
				...(snapshot.refs ? { refs: snapshot.refs } : {}),
				target: snapshot.target,
			}
		: undefined;
}

export function stripRefSnapshotInvalidationOrder(
	invalidation: OrderedSessionRefSnapshotInvalidation | SessionRefSnapshotInvalidation | undefined,
): SessionRefSnapshotInvalidation | undefined {
	return invalidation ? { reason: invalidation.reason, summary: invalidation.summary } : undefined;
}

export function getSessionPageStateKey(
	sessionName: string | undefined,
	namespace?: string,
): string | undefined {
	return sessionName !== undefined && sessionName.length > 0
		? getAgentBrowserSessionIdentityKey(sessionName, namespace)
		: undefined;
}
