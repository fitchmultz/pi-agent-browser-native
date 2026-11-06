import { getCompiledSemanticActionSessionPrefix } from "../../input-modes/semantic-action.js";
import type { CompiledAgentBrowserSemanticAction } from "../../input-modes/types.js";
import { resolveVisibleRefActionFromSnapshot } from "../../results/selector-recovery.js";
import { extractRefSnapshotFromData, normalizeComparableUrl } from "../../session-page-state.js";
import type { SessionRefSnapshot, SessionTabTarget } from "../../session-page-observation.js";
import { getGuardedRefUsage, runSessionCommandData } from "./session-state.js";
import type { SemanticActionVisibleRefResolution, StaleRefPreflight } from "./types.js";

function describeRef(snapshot: SessionRefSnapshot | undefined, refId: string): string {
	const ref = snapshot?.refs?.[refId];
	return ref ? `${ref.role} ${JSON.stringify(ref.name)}` : "not present";
}

function refChanged(
	previous: SessionRefSnapshot,
	current: SessionRefSnapshot,
	refId: string,
): boolean {
	const previousRef = previous.refs?.[refId];
	const currentRef = current.refs?.[refId];
	if (!current.refIds.includes(refId)) {
		return true;
	}
	if (!previousRef || !currentRef) {
		return previousRef !== currentRef;
	}
	return previousRef.role !== currentRef.role || previousRef.name !== currentRef.name;
}

function samePageFreshnessFailure(options: {
	readonly currentSnapshot: SessionRefSnapshot;
	readonly previousSnapshot: SessionRefSnapshot;
	readonly refIds: readonly string[];
}): { message: string; refIds: string[] } | undefined {
	const previousUrl = normalizeComparableUrl(options.previousSnapshot.target?.url);
	const currentUrl = normalizeComparableUrl(options.currentSnapshot.target?.url);
	if (
		previousUrl === undefined ||
		previousUrl === "" ||
		currentUrl === undefined ||
		currentUrl === "" ||
		previousUrl !== currentUrl ||
		currentUrl === "about:blank"
	) {
		return undefined;
	}
	const mismatchedRefs = options.refIds.filter((refId) =>
		refChanged(options.previousSnapshot, options.currentSnapshot, refId),
	);
	if (mismatchedRefs.length === 0) {
		return undefined;
	}
	const refText = mismatchedRefs.map((refId) => `@${refId}`).join(", ");
	const evidence = mismatchedRefs
		.map(
			(refId) =>
				`@${refId}: previous ${describeRef(options.previousSnapshot, refId)}, current ${describeRef(options.currentSnapshot, refId)}`,
		)
		.join("; ");
	return {
		message: `Ref ${refText} no longer matches the latest same-page snapshot. The page likely rerendered after the previous snapshot; run snapshot -i and retry with current refs. Evidence: ${evidence}.`,
		refIds: mismatchedRefs,
	};
}

function targetPrecludesFreshness(
	previousSnapshot: SessionRefSnapshot,
	currentTarget?: SessionTabTarget,
): boolean {
	const previousUrl = normalizeComparableUrl(previousSnapshot.target?.url);
	const currentUrl = normalizeComparableUrl(currentTarget?.url);
	if (currentUrl === "about:blank") {
		return true;
	}
	return (
		previousUrl !== undefined &&
		previousUrl !== "" &&
		currentUrl !== undefined &&
		currentUrl !== "" &&
		previousUrl !== currentUrl
	);
}

export async function collectSamePageRefFreshnessPreflight(options: {
	readonly commandTokens: readonly string[];
	readonly cwd: string;
	readonly currentTarget?: SessionTabTarget | undefined;
	readonly stdin?: string | undefined;
	readonly previousSnapshot?: SessionRefSnapshot | undefined;
	readonly namespace?: string | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<StaleRefPreflight | undefined> {
	const refIds = [...new Set(getGuardedRefUsage(options.commandTokens, options.stdin))];
	if (
		!options.previousSnapshot ||
		options.sessionName === undefined ||
		options.sessionName === "" ||
		refIds.length === 0
	) {
		return undefined;
	}
	if (targetPrecludesFreshness(options.previousSnapshot, options.currentTarget)) {
		return undefined;
	}
	const snapshotData = await runSessionCommandData({
		args: ["snapshot", "-i"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
	});
	const currentSnapshot = extractRefSnapshotFromData(snapshotData);
	if (!currentSnapshot) {
		return undefined;
	}
	const snapshotWithTarget = {
		...currentSnapshot,
		target: currentSnapshot.target ?? options.currentTarget,
	};
	const mismatch = samePageFreshnessFailure({
		currentSnapshot: snapshotWithTarget,
		previousSnapshot: options.previousSnapshot,
		refIds,
	});
	return mismatch
		? { message: mismatch.message, refIds: mismatch.refIds, snapshot: snapshotWithTarget }
		: undefined;
}

export function canResolveSemanticVisibleRef(
	compiled: CompiledAgentBrowserSemanticAction | undefined,
): compiled is CompiledAgentBrowserSemanticAction {
	if (compiled?.locator === undefined) {
		return false;
	}
	if (compiled.action === "select") {
		return true;
	}
	return compiled.locator === "role" && ["check", "click", "fill"].includes(compiled.action);
}

export function requiresResolvedSemanticVisibleRef(
	compiled: CompiledAgentBrowserSemanticAction | undefined,
): boolean {
	return compiled?.action === "select" && compiled.locator !== undefined;
}

export async function resolveSemanticActionVisibleRefArgs(options: {
	readonly compiled: CompiledAgentBrowserSemanticAction | undefined;
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly refSnapshot?: SessionRefSnapshot | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<SemanticActionVisibleRefResolution | undefined> {
	if (
		!canResolveSemanticVisibleRef(options.compiled) ||
		options.sessionName === undefined ||
		options.sessionName === ""
	) {
		return undefined;
	}
	const snapshotData = options.refSnapshot
		? undefined
		: await runSessionCommandData({
				args: ["snapshot", "-i"],
				cwd: options.cwd,
				namespace: options.namespace,
				sessionName: options.sessionName,
				signal: options.signal,
			});
	const resolution = resolveVisibleRefActionFromSnapshot({
		allowFill: true,
		compiledAction: options.compiled,
		refSnapshot: options.refSnapshot,
		snapshotData,
	});
	return resolution
		? {
				args: [...getCompiledSemanticActionSessionPrefix(options.compiled), ...resolution.args],
				snapshot: resolution.snapshot,
			}
		: undefined;
}
