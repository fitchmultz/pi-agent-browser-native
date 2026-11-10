import type {
	VerifyClickDispatchInput,
	ResolveResultingPageStateInput,
	HasNativeNavigationEvidenceInput,
	NavigationObservationRequestedInput,
	CanObserveSuccessfulNavigationInput,
	HasFailedPageTransitionInput,
	CanReverifyFailedNavigationInput,
	MergeObservedNavigationInput,
	ObserveNavigationTargetInput,
	CorrectRestoredOpenTabInput,
	VerifiesCurrentUrlInput,
	HasFailedWebMcpSettlementInput,
	ObserveWebMcpTargetInput,
	ObservedPageTargetInput,
	ReportedPageTargetInput,
	ResolveObservedTargetIdentityInput,
	FallbackPageTargetInput,
	ResolveObservedPageTargetInput,
	ProcessCannotVerifyPageInput,
} from "./process-output-navigation-contracts.js";
import type { PageOutputPhase } from "./process-output-page-phase-contracts.js";
import { isStringArray } from "../../results/presentation/content.js";
import {
	isNavigationObservableCommandName,
	isOpenNavigationCommand,
	isUnverifiedPageTransitionCommand,
} from "../../command-taxonomy.js";
import { OPEN_RESULT_TAB_CORRECTION_FLAGS } from "../../launch-scoped-flags.js";
import {
	getResultingPageTargetState,
	commandRequiresLivePageVerification,
} from "../../page-target-validation.js";
import { detectConfirmationRequired } from "../../results/confirmation.js";
import { shouldCaptureSemanticActionNavigationSummary } from "../../results/presentation/semantic-action.js";
import {
	commandExplicitlyTargetsAboutBlank,
	deriveSessionTabTarget,
	extractSessionTabTargetFromBatchResults,
	extractSessionTabTargetFromCommandData,
	extractStringResultField,
	normalizeSessionTabTarget,
	type SessionTabTarget,
} from "../../session-page-state.js";
import { isRecord } from "../../parsing.js";
import { extractUpstreamCommandTokens } from "../../argv-descriptor.js";
import { isPendingWebMcpMutation } from "../../webmcp-observation.js";
import {
	applyOpenResultTabCorrection,
	collectOpenResultTabCorrection,
	collectSessionTabTarget,
	mergeNavigationSummaryIntoData,
	shouldCaptureNavigationSummary,
} from "./session-state.js";
import { collectClickDispatchDiagnostic } from "./click-dispatch.js";
import { collectNavigationSummary } from "./diagnostics.js";
export async function verifyClickDispatch(
	draft: VerifyClickDispatchInput,
): Promise<
	| Pick<PageOutputPhase, "clickDispatchDiagnostic" | "succeeded" | "presentationEnvelope">
	| undefined
> {
	if (!draft.succeeded || !draft.input.prepared.clickDispatchProbe) {
		return undefined;
	}
	const clickDispatchDiagnostic = await collectClickDispatchDiagnostic({
		cwd: draft.input.cwd,
		namespace: draft.input.prepared.executionPlan.namespace,
		probe: draft.input.prepared.clickDispatchProbe,
		sessionName: draft.input.prepared.executionPlan.sessionName,
		signal: draft.input.signal,
	});
	return {
		clickDispatchDiagnostic,
		succeeded: clickDispatchDiagnostic ? false : draft.succeeded,
		presentationEnvelope: clickDispatchDiagnostic
			? { ...draft.presentationEnvelope, error: clickDispatchDiagnostic.summary, success: false }
			: draft.presentationEnvelope,
	};
}

export function resolveResultingPageState(
	draft: ResolveResultingPageStateInput,
): Pick<PageOutputPhase, "tabTransition" | "resultingPageState"> {
	const { prepared, state } = draft.input;
	const tabTransition =
		draft.confirmedEffects.some((effect) => effect.command === "tab") ||
		draft.dispatchedCommands.some((step) => {
			const tokens = extractUpstreamCommandTokens(step);
			const command = tokens[0];
			const subcommand = tokens.at(1);
			return command === "tab" && subcommand !== undefined && subcommand !== "list";
		});
	const preservePriorTarget =
		!draft.nativeCommandMayHaveExecuted ||
		detectConfirmationRequired(draft.presentationEnvelope?.data) !== undefined ||
		state.sessionPageState.get(draft.sessionStateKey).tabReopenPending === true;
	const resultingPageState = preservePriorTarget
		? {
				currentPageUrl: prepared.priorSessionTabTarget?.url,
				pageTargetMayHaveChanged: false,
				pageUrlUnknown: prepared.priorSessionTabTargetUnknown === true,
			}
		: getResultingPageTargetState({
				args: prepared.executionPlan.effectiveArgs,
				executedBatchSteps: draft.dispatchedCommands,
				batchResults: draft.presentationEnvelope?.data,
				currentPageUrl: prepared.priorSessionTabTarget?.url,
				pageUrlUnknown: prepared.priorSessionTabTargetUnknown === true,
			});
	return { tabTransition, resultingPageState };
}

function hasNativeNavigationEvidence(draft: HasNativeNavigationEvidenceInput): boolean {
	const { commandInfo } = draft.input.prepared.executionPlan;
	return (
		draft.confirmedEffects.some((effect) =>
			shouldCaptureNavigationSummary(effect.command, effect.data),
		) ||
		shouldCaptureNavigationSummary(
			commandInfo.command,
			draft.presentationEnvelope?.data,
			commandInfo.subcommand,
		) ||
		(commandInfo.command === "batch" &&
			draft.dispatchedCommands.some(([command, subcommand]) =>
				isNavigationObservableCommandName(command, subcommand),
			))
	);
}

function navigationObservationRequested(draft: NavigationObservationRequestedInput): boolean {
	const { prepared } = draft.input;
	return (
		hasNativeNavigationEvidence(draft) ||
		shouldCaptureSemanticActionNavigationSummary(
			prepared.compiledSemanticAction,
			draft.presentationEnvelope?.data,
		) ||
		commandRequiresLivePageVerification(
			prepared.executionPlan.effectiveArgs,
			prepared.runtimeToolStdin,
		) ||
		draft.destinationTransition ||
		draft.tabTransition
	);
}

function canObserveSuccessfulNavigation(draft: CanObserveSuccessfulNavigationInput): boolean {
	const observedSuccess =
		draft.succeeded ||
		(draft.processSucceeded && draft.confirmedEffects.some((effect) => effect.succeeded));
	return (
		observedSuccess &&
		draft.readConfirmation?.state !== "pending" &&
		!draft.nestedBatchClosed &&
		!draft.directClose
	);
}

function hasFailedPageTransition(draft: HasFailedPageTransitionInput): boolean {
	return (
		draft.confirmedEffects.some((effect) => isUnverifiedPageTransitionCommand(effect.command)) ||
		draft.dispatchedCommands.some((step) => {
			const [command, subcommand] = extractUpstreamCommandTokens(step);
			return (
				(draft.input.prepared.executionPlan.commandInfo.command === "batch" &&
					isOpenNavigationCommand(command)) ||
				isUnverifiedPageTransitionCommand(command, subcommand)
			);
		})
	);
}

function canReverifyFailedNavigation(
	draft: CanReverifyFailedNavigationInput,
	navigationSummary: PageOutputPhase["navigationSummary"],
): boolean {
	if (
		draft.succeeded ||
		navigationSummary !== undefined ||
		draft.readConfirmation?.state === "pending"
	) {
		return false;
	}
	if (processCannotVerifyPage(draft)) {
		return false;
	}
	return !draft.nestedBatchClosed && !draft.directClose && hasFailedPageTransition(draft);
}

function mergeObservedNavigation(
	draft: MergeObservedNavigationInput,
	navigationSummary: PageOutputPhase["navigationSummary"],
): PageOutputPhase["presentationEnvelope"] {
	if (draft.textOutput || !navigationSummary || !draft.presentationEnvelope) {
		return draft.presentationEnvelope;
	}
	if (
		draft.input.prepared.executionPlan.commandInfo.command === "eval" ||
		Array.isArray(draft.presentationEnvelope.data)
	) {
		return draft.presentationEnvelope;
	}
	return {
		...draft.presentationEnvelope,
		data: mergeNavigationSummaryIntoData(draft.presentationEnvelope.data, navigationSummary),
	};
}

export async function observeNavigationTarget(
	draft: ObserveNavigationTargetInput,
): Promise<
	Pick<
		PageOutputPhase,
		"navigationSummary" | "failedTransitionReverification" | "presentationEnvelope"
	>
> {
	const { prepared, cwd, signal } = draft.input;
	const navigationRequested = navigationObservationRequested(draft);
	const coldTargetObservation =
		prepared.callerColdLaunch === true &&
		!isOpenNavigationCommand(prepared.executionPlan.commandInfo.command);
	let navigationSummary = draft.navigationSummary;
	let failedTransitionReverification = draft.failedTransitionReverification;
	if (canObserveSuccessfulNavigation(draft) && (navigationRequested || coldTargetObservation)) {
		navigationSummary = await collectNavigationSummary({
			cwd,
			namespace: prepared.executionPlan.namespace,
			priorTarget: prepared.priorSessionTabTarget,
			reusePriorTitle: !draft.tabTransition,
			sessionName: prepared.executionPlan.sessionName,
			signal,
		});
	}
	// A failed transition may have changed the page. Its live URL cannot make prior refs valid.
	if (canReverifyFailedNavigation(draft, navigationSummary)) {
		navigationSummary = await collectNavigationSummary({
			cwd,
			namespace: prepared.executionPlan.namespace,
			priorTarget: prepared.priorSessionTabTarget,
			sessionName: prepared.executionPlan.sessionName,
			signal,
		});
		failedTransitionReverification = navigationSummary !== undefined;
	}
	return {
		navigationSummary,
		failedTransitionReverification,
		presentationEnvelope:
			navigationRequested || failedTransitionReverification
				? mergeObservedNavigation(draft, navigationSummary)
				: draft.presentationEnvelope,
	};
}

export async function correctRestoredOpenTab(
	draft: CorrectRestoredOpenTabInput,
): Promise<PageOutputPhase["openResultTabCorrection"]> {
	const { prepared, cwd, signal } = draft.input;
	const sessionName = prepared.executionPlan.sessionName;
	if (!draft.succeeded || sessionName === undefined || sessionName.length === 0) {
		return draft.openResultTabCorrection;
	}
	if (
		!prepared.executionPlan.startupScopedFlags.some((flag) =>
			OPEN_RESULT_TAB_CORRECTION_FLAGS.has(flag),
		) ||
		!isOpenNavigationCommand(prepared.executionPlan.commandInfo.command) ||
		commandExplicitlyTargetsAboutBlank(prepared.commandTokens)
	) {
		return draft.openResultTabCorrection;
	}
	const correction = await collectOpenResultTabCorrection({
		cwd,
		namespace: prepared.executionPlan.namespace,
		sessionName,
		signal,
		targetTitle: extractStringResultField(draft.presentationEnvelope?.data, "title"),
		targetUrl: extractStringResultField(draft.presentationEnvelope?.data, "url"),
	});
	if (correction) {
		return await applyOpenResultTabCorrection({
			correction,
			cwd,
			namespace: prepared.executionPlan.namespace,
			sessionName,
			signal,
		});
	}
	return draft.openResultTabCorrection;
}

function verifiesCurrentUrl(draft: VerifiesCurrentUrlInput): boolean {
	const { prepared } = draft.input;
	const { commandInfo } = prepared.executionPlan;
	return (
		(commandInfo.command === "get" && commandInfo.subcommand === "url") ||
		(draft.readConfirmationEvent?.state === "cleared" &&
			prepared.readConfirmation?.source === "native-guarded-action" &&
			extractSessionTabTargetFromCommandData(
				prepared.commandTokens,
				draft.presentationEnvelope?.data,
			) !== undefined)
	);
}

function hasFailedWebMcpSettlement(draft: HasFailedWebMcpSettlementInput): boolean {
	const { prepared } = draft.input;
	const { commandInfo } = prepared.executionPlan;
	return (
		prepared.priorSessionTabTargetUnknown === true &&
		((!draft.succeeded && isWebMcpSettlementCommand(commandInfo.command, commandInfo.subcommand)) ||
			(commandInfo.command === "batch" &&
				batchHasFailedWebMcpSettlement(draft.presentationEnvelope?.data)))
	);
}

export function observeWebMcpTarget(
	draft: ObserveWebMcpTargetInput,
): Pick<PageOutputPhase, "trustsReportedPageTarget" | "unsettledWebMcpMutation"> {
	const trustsReportedPageTarget =
		!draft.resultingPageState.pageUrlUnknown || verifiesCurrentUrl(draft);
	const { commandInfo } = draft.input.prepared.executionPlan;
	const pending =
		isPendingWebMcpMutation(
			commandInfo.command,
			commandInfo.subcommand,
			draft.presentationEnvelope?.data,
		) ||
		(commandInfo.command === "batch" &&
			batchHasPendingWebMcpMutation(draft.presentationEnvelope?.data));
	return {
		trustsReportedPageTarget,
		unsettledWebMcpMutation: pending || hasFailedWebMcpSettlement(draft),
	};
}

function observedPageTarget(
	draft: ObservedPageTargetInput,
	data: unknown,
): SessionTabTarget | undefined {
	if (
		draft.unsettledWebMcpMutation ||
		(draft.unobservedMutation && !draft.failedTransitionReverification)
	) {
		return;
	}
	const navigation = normalizeSessionTabTarget(draft.navigationSummary);
	if (navigation) {
		return navigation;
	}
	if (!draft.trustsReportedPageTarget) {
		return;
	}
	const batchTarget = extractSessionTabTargetFromBatchResults(data);
	if (batchTarget) {
		return batchTarget;
	}
	return draft.succeeded
		? extractSessionTabTargetFromCommandData(draft.input.prepared.commandTokens, data)
		: undefined;
}

function reportedPageTarget(
	draft: ReportedPageTargetInput,
	data: unknown,
): SessionTabTarget | undefined {
	const { prepared } = draft.input;
	if (prepared.executionPlan.commandInfo.command === "batch") {
		return extractSessionTabTargetFromBatchResults(data);
	}
	if (prepared.commandTokens[0] === "tab" && prepared.commandTokens[1] === "close") {
		return;
	}
	return extractSessionTabTargetFromCommandData(prepared.commandTokens, data);
}

async function resolveObservedTargetIdentity(
	draft: ResolveObservedTargetIdentityInput,
	data: unknown,
	target: SessionTabTarget | undefined,
): Promise<SessionTabTarget | undefined> {
	if (
		!target ||
		draft.readConfirmation?.state === "pending" ||
		draft.browserIndependentRead ||
		draft.nestedBatchClosed ||
		draft.directClose
	) {
		return target;
	}
	const reported = reportedPageTarget(draft, data);
	if (reported?.targetId !== undefined && reported.targetId.length > 0) {
		return {
			...target,
			targetId: reported.targetId,
		};
	}
	return await collectSessionTabTarget({
		cwd: draft.input.cwd,
		namespace: draft.input.prepared.executionPlan.namespace,
		sessionName: draft.input.prepared.executionPlan.sessionName,
		signal: draft.input.signal,
		target,
	});
}

function fallbackPageTarget(
	draft: FallbackPageTargetInput,
	data: unknown,
): SessionTabTarget | undefined {
	// Window/diff URL2 is intent, not redirect evidence.
	if (draft.resultingPageState.pageTargetMayHaveChanged) {
		return draft.succeeded && !draft.destinationTransition
			? normalizeSessionTabTarget({ url: draft.resultingPageState.currentPageUrl })
			: undefined;
	}
	const { prepared } = draft.input;
	return deriveSessionTabTarget({
		command: draft.directClose ? "close" : prepared.executionPlan.commandInfo.command,
		data,
		navigationSummary: draft.navigationSummary,
		previousTarget: prepared.priorSessionTabTarget,
		subcommand: prepared.executionPlan.commandInfo.subcommand,
	});
}

export async function resolveObservedPageTarget(
	draft: ResolveObservedPageTargetInput,
): Promise<Pick<PageOutputPhase, "observedSessionTabTarget" | "currentSessionTabTarget">> {
	const data: unknown = draft.textOutput ? undefined : draft.presentationEnvelope?.data;
	const observedSessionTabTarget = await resolveObservedTargetIdentity(
		draft,
		data,
		observedPageTarget(draft, data),
	);
	let currentSessionTabTarget = observedSessionTabTarget;
	if (
		!currentSessionTabTarget &&
		draft.nestedBatchClose === undefined &&
		!draft.unobservedMutation
	) {
		currentSessionTabTarget = fallbackPageTarget(draft, data);
	}
	return { observedSessionTabTarget, currentSessionTabTarget };
}

function isWebMcpSettlementCommand(
	command: string | undefined,
	subcommand: string | undefined,
): boolean {
	return command === "webmcp" && ["result", "cancel"].includes(subcommand ?? "");
}

function batchHasPendingWebMcpMutation(data: unknown): boolean {
	if (!Array.isArray(data)) {
		return false;
	}
	return data.some((row: unknown) => {
		if (!isRecord(row) || row.success === false || !isStringArray(row.command)) {
			return false;
		}
		const [command, subcommand] = extractUpstreamCommandTokens(row.command);
		return isPendingWebMcpMutation(command, subcommand, row.result);
	});
}

function batchHasFailedWebMcpSettlement(data: unknown): boolean {
	if (!Array.isArray(data)) {
		return false;
	}
	return data.some((row: unknown) => {
		if (!isRecord(row) || row.success !== false || !isStringArray(row.command)) {
			return false;
		}
		const [command, subcommand] = extractUpstreamCommandTokens(row.command);
		return isWebMcpSettlementCommand(command, subcommand);
	});
}

export function processCannotVerifyPage(draft: ProcessCannotVerifyPageInput): boolean {
	const { processResult } = draft.input;
	return (
		!processResult.agentBrowserStarted ||
		!draft.nativeCommandMayHaveExecuted ||
		processResult.aborted ||
		processResult.timedOut
	);
}
