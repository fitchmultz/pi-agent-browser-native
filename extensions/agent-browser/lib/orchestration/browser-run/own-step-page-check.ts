import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { isPageMutationStep, isPageReportingTransitionCommand } from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import {
	commandMayChangePageTarget,
	commandVerifiesPageTarget,
} from "../../page-target-navigation.js";
import {
	extractReplacedPageWedgedTarget,
	extractSessionTabTargetFromBatchResults,
	normalizeComparableUrl,
	normalizeSessionTabTarget,
} from "../../session-page-state.js";
import type { OwnStepPageCheck } from "./observation-types.js";
import { processCannotVerifyPage } from "./process-output-navigation.js";
import type { PageOutputPhase } from "./process-output-page-phase-contracts.js";
import type { ProcessBrowserOutputInput, PreparedBrowserRun } from "./types.js";

type CheckPageAfterOwnStepInput = Readonly<
	Pick<
		PageOutputPhase,
		| "currentSessionTabTarget"
		| "directClose"
		| "dispatchedCommands"
		| "nativeCommandMayHaveExecuted"
		| "navigationSummary"
		| "nestedBatchClosed"
		| "presentationEnvelope"
		| "readConfirmation"
		| "resultingPageState"
		| "unobservedMutation"
		| "unsettledWebMcpMutation"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "priorSessionTabTarget">>;
	};
};

interface TrailingOwnStep {
	readonly command: OwnStepPageCheck["command"];
	readonly index: number;
	/**
	 * A script can start a navigation that commits after it returns, so a run that ends with eval
	 * needs the later live read. A reload replaces that document and reports the URL it ended on.
	 */
	readonly needsLiveRead: boolean;
}

/** Chromium shows its own document at this scheme when a navigation fails. */
function isBrowserErrorPageUrl(url: string): boolean {
	return url.startsWith("chrome-error://");
}

function ownStepCommand(step: readonly string[]): OwnStepPageCheck["command"] | undefined {
	const { command } = parseArgvDescriptor(step).commandInfo;
	return isPageReportingTransitionCommand(command) ? command : undefined;
}

/** A step that can leave the browser on another page: a transition, or any step that acts on the page. */
function mayMovePage(step: readonly string[]): boolean {
	return commandMayChangePageTarget(step, false) || isPageMutationStep(step);
}

/**
 * Finds the eval or reload run whose result is the last page-target evidence of the call. A later
 * get url row or another step that can move the page takes over, so that evidence keeps its rule.
 * The run starts at `index`; `command` is its last step, the one that left the observed page.
 */
function findTrailingOwnStep(steps: readonly (readonly string[])[]): TrailingOwnStep | undefined {
	let index: number | undefined;
	for (const [stepIndex, step] of steps.entries()) {
		if (ownStepCommand(step) !== undefined) {
			index ??= stepIndex;
		} else if (mayMovePage(step) || commandVerifiesPageTarget(step)) {
			index = undefined;
		}
	}
	if (index === undefined) {
		return undefined;
	}
	const commands = steps.slice(index).flatMap((step) => ownStepCommand(step) ?? []);
	const command = commands.at(-1);
	return command === undefined ? undefined : { command, index, needsLiveRead: command === "eval" };
}

/**
 * The URL the own step started from: the page known before the call, or the one that a row reported
 * at or after the last earlier step that can move the page. Unknown when that step reported none.
 */
function urlBeforeOwnStep(draft: CheckPageAfterOwnStepInput, index: number): string | undefined {
	const data: unknown = draft.presentationEnvelope?.data;
	const earlierRows = Array.isArray(data) ? data.filter(isRecord).slice(0, index) : [];
	const lastMove = draft.dispatchedCommands.slice(0, index).findLastIndex(mayMovePage);
	const reported = extractSessionTabTargetFromBatchResults(
		earlierRows.slice(Math.max(lastMove, 0)),
	);
	if (reported) {
		return reported.url;
	}
	return lastMove === -1 ? draft.input.prepared.priorSessionTabTarget?.url : undefined;
}

function canCheckPage(draft: CheckPageAfterOwnStepInput): boolean {
	return (
		draft.resultingPageState.pageTargetMayHaveChanged &&
		extractReplacedPageWedgedTarget(draft.presentationEnvelope) === undefined &&
		!processCannotVerifyPage(draft) &&
		!draft.unobservedMutation &&
		!draft.unsettledWebMcpMutation &&
		!draft.nestedBatchClosed &&
		!draft.directClose &&
		draft.readConfirmation?.state !== "pending"
	);
}

/**
 * Judges the page the wrapper observed after its own eval or reload. An error page or an unreadable
 * URL withholds the target so the page stays unverified; a changed URL is reported and kept.
 */
export function checkPageAfterOwnStep(
	draft: CheckPageAfterOwnStepInput,
): Pick<PageOutputPhase, "currentSessionTabTarget" | "ownStepPageCheck"> {
	const { currentSessionTabTarget } = draft;
	const ownStep = canCheckPage(draft) ? findTrailingOwnStep(draft.dispatchedCommands) : undefined;
	if (!ownStep) {
		return { currentSessionTabTarget, ownStepPageCheck: undefined };
	}
	const { command } = ownStep;
	const liveRead = normalizeSessionTabTarget(draft.navigationSummary);
	const url = ownStep.needsLiveRead && !liveRead ? undefined : currentSessionTabTarget?.url;
	if (url === undefined) {
		return {
			currentSessionTabTarget: undefined,
			ownStepPageCheck: { command, status: "unreadable" },
		};
	}
	if (isBrowserErrorPageUrl(url)) {
		return {
			currentSessionTabTarget: undefined,
			ownStepPageCheck: { command, status: "error-page", url },
		};
	}
	const priorUrl = urlBeforeOwnStep(draft, ownStep.index);
	const changed =
		priorUrl !== undefined && normalizeComparableUrl(priorUrl) !== normalizeComparableUrl(url);
	return {
		currentSessionTabTarget,
		ownStepPageCheck: changed ? { command, priorUrl, status: "changed", url } : undefined,
	};
}

export function formatOwnStepPageCheckText(check: OwnStepPageCheck): string {
	switch (check.status) {
		case "changed":
			return `Page URL changed during this call: ${check.priorUrl} -> ${check.url}. Later page commands act on the new page.`;
		case "error-page":
			return `Page not verified: the browser shows an error page (${check.url}) after ${check.command}. Run get url or navigate explicitly before page-content inspection.`;
		case "unreadable":
			return `Page not verified: the current URL could not be read after ${check.command}. Run get url or navigate explicitly before page-content inspection.`;
		default:
			return check satisfies never;
	}
}

export function leavesPageUnverified(check: OwnStepPageCheck | undefined): boolean {
	return check !== undefined && check.status !== "changed";
}
