import {
	getCompiledSemanticActionCommandIndex,
	getCompiledSemanticActionSessionPrefix,
	isCompiledSemanticActionFindCommand,
} from "../../input-modes/semantic-action.js";
import type { CompiledAgentBrowserSemanticAction } from "../../input-modes/types.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import {
	appendUniqueAgentBrowserNextActions,
	isStandaloneSnapshotNextAction,
} from "../../results/next-actions.js";
import {
	buildConnectedSessionNextActions,
	buildNoActivePageNextActions,
	buildPendingWebMcpNextActions,
	buildUnverifiedPageNextActions,
	buildSessionAwareStaleRefNextActions,
	buildSessionTabRecoveryNextActions,
} from "../../results/recovery-next-actions.js";
import {
	buildRichInputRecoveryNextActions,
	buildVisibleRefFallbackNextActions,
} from "../../results/selector-recovery.js";
import { redactInvocationArgs } from "../../runtime-redaction.js";
import type { PublicationInput as FinalResultInput } from "./final-result-contracts.js";
import { leavesPageUnverified } from "./own-step-page-check.js";

type PageRecoveryInput = Pick<
	FinalResultInput,
	| "presentation"
	| "unsettledWebMcpMutation"
	| "currentSessionTabTargetUnknown"
	| "categoryDetails"
	| "executionPlan"
	| "electronLaunchRecord"
	| "noActivePageSnapshotFailure"
	| "aboutBlankSessionMismatch"
	| "sessionTabCorrection"
	| "openResultTabCorrection"
	| "currentSessionTabTarget"
	| "priorSessionTabTarget"
	| "ownStepPageCheck"
>;

function tabRecovery(
	options: Pick<
		PageRecoveryInput,
		| "aboutBlankSessionMismatch"
		| "executionPlan"
		| "sessionTabCorrection"
		| "openResultTabCorrection"
		| "categoryDetails"
		| "currentSessionTabTarget"
		| "priorSessionTabTarget"
	>,
): AgentBrowserNextAction[] {
	if (options.aboutBlankSessionMismatch) {
		return [
			...buildSessionTabRecoveryNextActions({
				kind: "about-blank",
				recoveryApplied: options.aboutBlankSessionMismatch.recoveryApplied,
				sessionName: options.executionPlan.sessionName,
				tabCorrection: options.aboutBlankSessionMismatch.recoveryApplied
					? options.sessionTabCorrection
					: undefined,
				target: {
					title: options.aboutBlankSessionMismatch.targetTitle,
					url: options.aboutBlankSessionMismatch.targetUrl,
				},
			}),
		];
	}
	if (
		options.categoryDetails.resultCategory === "success" &&
		(options.sessionTabCorrection || options.openResultTabCorrection)
	) {
		return [
			...buildSessionTabRecoveryNextActions({
				kind: "tab-drift",
				recoveryApplied: true,
				sessionName: options.executionPlan.sessionName,
				tabCorrection: options.sessionTabCorrection ?? options.openResultTabCorrection,
				target: options.currentSessionTabTarget ?? options.priorSessionTabTarget,
			}),
		];
	}
	return [];
}

function connectionRecovery(
	options: Pick<
		PageRecoveryInput,
		"categoryDetails" | "executionPlan" | "electronLaunchRecord" | "noActivePageSnapshotFailure"
	>,
): AgentBrowserNextAction[] {
	const actions: AgentBrowserNextAction[] = [];
	if (
		options.categoryDetails.resultCategory === "success" &&
		options.executionPlan.commandInfo.command === "connect" &&
		!options.electronLaunchRecord
	) {
		actions.push(...buildConnectedSessionNextActions(options.executionPlan.sessionName));
	}
	if (options.noActivePageSnapshotFailure) {
		actions.push(...buildNoActivePageNextActions(options.executionPlan.sessionName));
	}
	return actions;
}

export function buildPageRecoveryActions(options: PageRecoveryInput): AgentBrowserNextAction[] {
	let actions = [...(options.presentation.nextActions ?? [])];
	if (options.unsettledWebMcpMutation === true && options.currentSessionTabTargetUnknown === true) {
		actions = actions.filter((action) => !isStandaloneSnapshotNextAction(action));
		appendUniqueAgentBrowserNextActions(
			actions,
			buildPendingWebMcpNextActions(options.executionPlan.sessionName),
		);
	}
	if (leavesPageUnverified(options.ownStepPageCheck)) {
		actions = actions.filter((action) => !isStandaloneSnapshotNextAction(action));
		appendUniqueAgentBrowserNextActions(
			actions,
			buildUnverifiedPageNextActions(options.executionPlan.sessionName),
		);
	}
	appendUniqueAgentBrowserNextActions(actions, connectionRecovery(options));
	appendUniqueAgentBrowserNextActions(actions, tabRecovery(options));
	if (options.aboutBlankSessionMismatch?.recoveryApplied === false) {
		actions = actions.filter((action) => !isStandaloneSnapshotNextAction(action));
	}
	if (options.categoryDetails.failureCategory === "stale-ref") {
		actions = [...buildSessionAwareStaleRefNextActions(options.executionPlan.sessionName)];
	}
	return actions;
}

export function buildSelectorRecoveryActions(
	options: Pick<
		FinalResultInput,
		"visibleRefFallbackDiagnostic" | "visibleRefFallbackSessionName" | "richInputRecoveryDiagnostic"
	>,
): AgentBrowserNextAction[] {
	const actions: AgentBrowserNextAction[] = [];
	if (options.visibleRefFallbackDiagnostic) {
		actions.push(
			...buildVisibleRefFallbackNextActions({
				diagnostic: options.visibleRefFallbackDiagnostic,
				sessionName: options.visibleRefFallbackSessionName,
			}),
		);
	}
	if (options.richInputRecoveryDiagnostic) {
		actions.push(
			...buildRichInputRecoveryNextActions({
				diagnostic: options.richInputRecoveryDiagnostic,
				sessionName: options.visibleRefFallbackSessionName,
			}),
		);
	}
	return actions;
}

export function buildSemanticActionCandidateActions(
	compiled: CompiledAgentBrowserSemanticAction,
): AgentBrowserNextAction[] {
	const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
	if (commandIndex < 0 || compiled.args[commandIndex] !== "find") {
		return [];
	}
	const locator = compiled.args[commandIndex + 1];
	const value = compiled.args.at(commandIndex + 2);
	if (
		value === undefined ||
		value.length === 0 ||
		locator !== "text" ||
		compiled.action !== "click"
	) {
		return [];
	}
	const sessionPrefix = getCompiledSemanticActionSessionPrefix(compiled);
	return [
		{
			id: "try-button-name-candidate",
			params: {
				args: redactInvocationArgs([
					...sessionPrefix,
					"find",
					"role",
					"button",
					compiled.action,
					"--name",
					value,
				]),
			},
			reason: "Retry against a button with the same accessible name when text lookup misses.",
			safety:
				"Candidate locator fallback only; inspect the page if multiple elements could match the same accessible name.",
			tool: "agent_browser",
		},
		{
			id: "try-link-name-candidate",
			params: {
				args: redactInvocationArgs([
					...sessionPrefix,
					"find",
					"role",
					"link",
					compiled.action,
					"--name",
					value,
				]),
			},
			reason: "Retry against a link with the same accessible name when text lookup misses.",
			safety:
				"Candidate locator fallback only; inspect the page if multiple elements could match the same accessible name.",
			tool: "agent_browser",
		},
	];
}

export function buildStaleSemanticRetry(
	options: Pick<
		FinalResultInput,
		"categoryDetails" | "redactedCompiledSemanticAction" | "compiledSemanticAction"
	>,
): AgentBrowserNextAction[] {
	if (
		options.categoryDetails.failureCategory !== "stale-ref" ||
		!options.redactedCompiledSemanticAction ||
		!isCompiledSemanticActionFindCommand(options.compiledSemanticAction)
	) {
		return [];
	}
	return [
		{
			id: "retry-semantic-action-after-stale-ref",
			params: { args: options.redactedCompiledSemanticAction.args },
			reason:
				"Retry the same semantic target via its compiled find command after the upstream stale-ref failure proves the prior action did not execute.",
			safety:
				"Use only for the same intended target; direct stale @refs still require a fresh snapshot or stable locator before retrying.",
			tool: "agent_browser",
		},
	];
}
