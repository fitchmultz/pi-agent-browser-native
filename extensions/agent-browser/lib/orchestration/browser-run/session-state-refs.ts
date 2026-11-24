import { beforeEndOfOptions, END_OF_OPTIONS, scanCommandPositionals } from "../../argv-grammar.js";
import { isRefGuardedCommand, isRefInvalidatingBatchCommand } from "../../command-taxonomy.js";
import { parseRefId } from "../../parsing.js";
import {
	targetsMatch,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
	type SessionTabTarget,
} from "../../session-page-state.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { getScreenshotOperands } from "./artifact-paths.js";
import type { StaleRefPreflight } from "./types.js";

const CLICK_BOOLEAN_FLAGS = new Set(["--human", "--new-tab"]);
const DBLCLICK_BOOLEAN_FLAGS = new Set(["--human"]);
const CLICK_VALUE_FLAGS = new Set(["--button", "--modifiers"]);
const DRAG_BOOLEAN_FLAGS = new Set(["--human"]);
const SELECT_VALUE_FLAGS = new Set(["--by"]);
const SINGLE_SELECTOR_SCANNER_COMMANDS = new Set([
	"check",
	"download",
	"focus",
	"highlight",
	"hover",
	"scrollinto",
	"scrollintoview",
	"tap",
	"uncheck",
]);

export function getClickSelectorOperand(tokens: readonly string[]): string | undefined {
	if (tokens[0] !== "click" && tokens[0] !== "dblclick") {
		return undefined;
	}
	return scanCommandPositionals(tokens, 1, {
		booleanFlags: tokens[0] === "click" ? CLICK_BOOLEAN_FLAGS : DBLCLICK_BOOLEAN_FLAGS,
		valueFlags: CLICK_VALUE_FLAGS,
	})[0]?.token;
}

export function hasNonPlainClickOption(commandTokens: readonly string[]): boolean {
	if (commandTokens[0] !== "click") {
		return false;
	}
	const options = beforeEndOfOptions(commandTokens.slice(1));
	for (let index = 0; index < options.length; index += 1) {
		const token = options[index];
		if (token === "--new-tab" || token === "--modifiers") {
			return true;
		}
		if (token === "--button") {
			if (options[index + 1]?.toLowerCase() !== "left") {
				return true;
			}
			index += 1;
		}
	}
	return false;
}

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
	const operands = tokens.slice(tokens[0] === "diff" ? 2 : 1).values();
	for (const token of operands) {
		if (token === END_OF_OPTIONS) {
			break;
		}
		if (token === "--selector" || token === "-s") {
			selector = operands.next().value;
		} else if (
			tokens[0] === "diff" &&
			["--baseline", "-b", "--output", "-o", "--threshold", "-t", "--depth", "-d"].includes(token)
		) {
			operands.next();
		}
	}
	return selector;
}

function getTokenAfterOptionalSeparator(
	tokens: readonly string[],
	startIndex: number,
): string | undefined {
	return tokens[startIndex] === END_OF_OPTIONS ? tokens[startIndex + 1] : tokens[startIndex];
}

function getSubcommandSelectorOperand(tokens: readonly string[]): string | undefined {
	if (tokens[0] === "get" && ["url", "title", "cdp-url", "count"].includes(tokens[1] ?? "")) {
		return undefined;
	}
	return getTokenAfterOptionalSeparator(tokens, 2);
}

function getSelectorOperands(tokens: readonly string[]): readonly (string | undefined)[] {
	const command = tokens[0];
	if (command !== undefined && SINGLE_SELECTOR_SCANNER_COMMANDS.has(command)) {
		return [scanCommandPositionals(tokens, 1)[0]?.token];
	}
	switch (command) {
		case "click":
		case "dblclick":
			return [getClickSelectorOperand(tokens)];
		case "drag":
			return scanCommandPositionals(tokens, 1, { booleanFlags: DRAG_BOOLEAN_FLAGS })
				.slice(0, 2)
				.map(({ token }) => token);
		case "select":
			return [
				scanCommandPositionals(tokens, 1, {
					equalsValueFlags: SELECT_VALUE_FLAGS,
					valueFlags: SELECT_VALUE_FLAGS,
				})[0]?.token,
			];
		case "get":
		case "is":
			return [getSubcommandSelectorOperand(tokens)];
		case "screenshot":
			return [getScreenshotOperands(tokens)[0]?.token];
		case "diff":
		case "scroll":
			return [getFlaggedSelector(tokens)];
		case undefined:
		default:
			return [getTokenAfterOptionalSeparator(tokens, 1)];
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
		case undefined:
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
				message: `Batch step ${String(step[0])} uses page-scoped ref ${refIds.map((refId) => `@${refId}`).join(", ")} after an earlier batch step can navigate or mutate the page. Split the batch, run snapshot -i after the page-changing step, then retry with current refs.`,
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
	readonly currentTarget?: SessionTabTarget | undefined;
	readonly requireExactTargetUrl?: boolean;
	readonly refSnapshot?: SessionRefSnapshot | undefined;
	readonly refSnapshotInvalidation?: SessionRefSnapshotInvalidation | undefined;
	readonly stdin?: string | undefined;
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
