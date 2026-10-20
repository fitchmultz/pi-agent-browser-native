import { isRefGuardedCommand, isRefInvalidatingBatchCommand } from "../../command-taxonomy.js";
import { parseRefId } from "../../parsing.js";
import {
	targetsMatch,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
	type SessionTabTarget,
} from "../../session-page-state.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { getScreenshotPositionalIndices } from "./artifact-paths.js";
import type { StaleRefPreflight } from "./types.js";

export function getStaleRefArgs(
	commandTokens: readonly string[],
	stdin?: string,
): readonly string[] {
	if (commandTokens[0] !== "batch") {
		return commandTokens;
	}
	const steps = getUpstreamEffectiveBatchSteps(commandTokens, stdin);
	return steps.length > 0 ? steps.flatMap((step) => step) : commandTokens;
}

function getFlaggedSelector(tokens: readonly string[]): string | undefined {
	let selector: string | undefined;
	for (let index = tokens[0] === "diff" ? 2 : 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--selector" || token === "-s") {
			selector = tokens[++index];
		} else if (
			tokens[0] === "diff" &&
			["--baseline", "-b", "--output", "-o", "--threshold", "-t", "--depth", "-d"].includes(token)
		) {
			index += 1;
		}
	}
	return selector;
}

function getSelectorOperands(tokens: readonly string[]): readonly (string | undefined)[] {
	switch (tokens[0]) {
		case "click":
			return [tokens.slice(1).find((token) => token !== "--new-tab" && token !== "--human")];
		case "drag":
			return tokens.slice(1, 3);
		case "get":
			return [!["url", "title", "cdp-url", "count"].includes(tokens[1]) ? tokens[2] : undefined];
		case "is":
			return [tokens[2]];
		case "screenshot":
			return [tokens[getScreenshotPositionalIndices(tokens)[0]]];
		case "diff":
		case "scroll":
			return [getFlaggedSelector(tokens)];
		default:
			return [tokens[1]];
	}
}

// Inspect only upstream's selector slots: fill text, file paths and key data are not refs.
function collectRefsFromTokens(tokens: readonly string[]): string[] {
	if (!isRefGuardedCommand(tokens[0]) || (tokens[0] === "diff" && tokens[1] !== "screenshot")) {
		return [];
	}
	return getSelectorOperands(tokens).flatMap((selector) => {
		const ref = selector === undefined ? undefined : parseRefId(selector);
		return ref === undefined ? [] : [ref];
	});
}

export function getGuardedRefUsage(
	commandTokens: readonly string[],
	stdin?: string,
	options: { readonly includeRefsAfterBatchSnapshot?: boolean } = {},
): string[] {
	if (commandTokens[0] !== "batch") {
		return collectRefsFromTokens(commandTokens);
	}
	const refs: string[] = [];
	for (const step of getUpstreamEffectiveBatchSteps(commandTokens, stdin)) {
		if (options.includeRefsAfterBatchSnapshot !== true && (step[0] ?? "") === "snapshot") {
			break;
		}
		refs.push(...collectRefsFromTokens(step));
	}
	return refs;
}

function isSafeSameSnapshotFormBatchStep(
	step: readonly string[],
	refSnapshot: SessionRefSnapshot | undefined,
): boolean {
	const refIds = collectRefsFromTokens(step);
	if (refIds.length === 0 || !refSnapshot) {
		return false;
	}
	const roles = refIds.map((refId) => refSnapshot.refs?.[refId]?.role.toLowerCase());
	if (roles.some((role) => role === undefined)) {
		return false;
	}
	switch (step[0]) {
		case "check":
		case "uncheck":
		case "click":
		case "tap":
			return roles.every((role) => role === "checkbox" || role === "radio");
		case "select":
			return roles.every((role) => role === "combobox");
		default:
			return false;
	}
}

function getBatchRefInvalidationFailure(
	commandTokens: readonly string[],
	stdin: string | undefined,
	refSnapshot: SessionRefSnapshot | undefined,
): StaleRefPreflight | undefined {
	if (commandTokens[0] !== "batch") {
		return;
	}
	let priorStepInvalidatesRefs = false;
	for (const step of getUpstreamEffectiveBatchSteps(commandTokens, stdin)) {
		if ((step[0] ?? "") === "snapshot") {
			priorStepInvalidatesRefs = false;
		}
		const refIds = collectRefsFromTokens(step);
		if (refIds.length > 0 && isRefGuardedCommand(step[0]) && priorStepInvalidatesRefs) {
			return {
				message: `Batch step ${step[0]} uses page-scoped ref ${refIds.map((refId) => `@${refId}`).join(", ")} after an earlier batch step can navigate or mutate the page. Split the batch, run snapshot -i after the page-changing step, then retry with current refs.`,
				refIds,
				snapshot: refSnapshot,
			};
		}
		if (
			isRefInvalidatingBatchCommand(step) &&
			!isSafeSameSnapshotFormBatchStep(step, refSnapshot)
		) {
			priorStepInvalidatesRefs = true;
		}
	}
	return;
}

interface RefPreflightFacts {
	readonly commandTokens: readonly string[];
	readonly currentTarget?: SessionTabTarget;
	readonly requireExactTargetUrl?: boolean;
	readonly refSnapshot?: SessionRefSnapshot;
	readonly refSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	readonly stdin?: string;
}

function invalidatedRefFailure(
	invalidation: Readonly<SessionRefSnapshotInvalidation>,
	refIds: readonly string[],
): StaleRefPreflight {
	return {
		message:
			invalidation.reason === "page-transition"
				? `Ref ${refIds.map((refId) => `@${refId}`).join(", ")} cannot be used yet. ${invalidation.summary}`
				: `Ref ${refIds.map((refId) => `@${refId}`).join(", ")} cannot be used because the latest snapshot for this session reported No active page. Run snapshot -i successfully before using page-scoped refs.`,
		refIds,
		snapshotInvalidation: invalidation,
	};
}

function snapshotTargetChanged(
	snapshotTarget: SessionTabTarget | undefined,
	currentTarget: SessionTabTarget | undefined,
	requireExactTargetUrl: boolean,
): boolean {
	const exactUrlMismatch =
		requireExactTargetUrl &&
		snapshotTarget !== undefined &&
		currentTarget !== undefined &&
		snapshotTarget.url !== currentTarget.url;
	return !targetsMatch(snapshotTarget, currentTarget) || exactUrlMismatch;
}

function snapshotRefFailure(
	facts: Pick<RefPreflightFacts, "currentTarget" | "requireExactTargetUrl">,
	snapshot: SessionRefSnapshot,
	usedRefIds: readonly string[],
): StaleRefPreflight | undefined {
	if (
		snapshotTargetChanged(
			snapshot.target,
			facts.currentTarget,
			facts.requireExactTargetUrl === true,
		)
	) {
		return {
			message: `Ref ${usedRefIds.map((refId) => `@${refId}`).join(", ")} came from a snapshot for ${snapshot.target?.url ?? "a prior page"}, but the current session target is ${facts.currentTarget?.url ?? "unknown"}. Run snapshot -i again before using page-scoped refs.`,
			refIds: usedRefIds,
			snapshot,
		};
	}
	const knownRefs = new Set(snapshot.refIds);
	const missingRefs = usedRefIds.filter((refId) => !knownRefs.has(refId));
	if (missingRefs.length > 0) {
		return {
			message: `Ref ${missingRefs.map((refId) => `@${refId}`).join(", ")} was not present in the latest snapshot for this session. Run snapshot -i again before using page-scoped refs.`,
			refIds: missingRefs,
			snapshot,
		};
	}
	return;
}

export function buildStaleRefPreflight(facts: RefPreflightFacts): StaleRefPreflight | undefined {
	const guardedRefIds = [...new Set(getGuardedRefUsage(facts.commandTokens, facts.stdin))];
	const usedRefIds = facts.refSnapshotInvalidation
		? [
				...new Set(
					getGuardedRefUsage(facts.commandTokens, facts.stdin, {
						includeRefsAfterBatchSnapshot: true,
					}),
				),
			]
		: guardedRefIds;
	const batchInvalidationFailure = getBatchRefInvalidationFailure(
		facts.commandTokens,
		facts.stdin,
		facts.refSnapshot,
	);
	if (batchInvalidationFailure) {
		return batchInvalidationFailure;
	}
	if (usedRefIds.length === 0) {
		return;
	}
	if (facts.refSnapshotInvalidation) {
		return invalidatedRefFailure(facts.refSnapshotInvalidation, usedRefIds);
	}
	return facts.refSnapshot ? snapshotRefFailure(facts, facts.refSnapshot, usedRefIds) : undefined;
}
