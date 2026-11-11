import { buildAgentBrowserNextActions } from "../../results/action-recommendations.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import {
	appendUniqueAgentBrowserNextActions,
	isStandaloneSnapshotNextAction,
	withOptionalSessionArgs,
} from "../../results/next-actions.js";
import {
	buildElectronLifecycleNextActions,
	buildElectronMismatchNextActions,
	buildElectronRefFreshnessNextActions,
	buildManagedSessionFreshFailureNextActions,
} from "./session-state.js";
import { buildOverlayBlockerNextActions } from "./overlay-diagnostics.js";
import { buildFillVerificationNextActions } from "./fill-diagnostics.js";
import { buildSelectorTextVisibilityNextActions } from "./text-visibility-diagnostics.js";
import {
	buildElectronBroadGetTextScopeNextActions,
	buildSourceLookupElectronNextActions,
} from "./electron-text-diagnostics.js";
import { buildClickDispatchNextActions } from "./click-dispatch.js";
import {
	buildComboboxFocusNextActions,
	buildScrollNoopNextActions,
} from "./interaction-diagnostics.js";
import {
	buildPageRecoveryActions,
	buildSelectorRecoveryActions,
	buildSemanticActionCandidateActions,
	buildStaleSemanticRetry,
} from "./final-result-action-recovery.js";
import {
	buildDialogTimeoutNextActions,
	buildTimeoutPartialProgressNextActions,
} from "./final-result-timeout.js";
import type { PublicationInput as FinalResultInput } from "./final-result-contracts.js";

export type ResultActionsInput = Pick<
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
	| "visibleRefFallbackDiagnostic"
	| "visibleRefFallbackSessionName"
	| "richInputRecoveryDiagnostic"
	| "electronPostCommandHealth"
	| "electronSessionMismatch"
	| "electronLaunchRecords"
	| "redactedCompiledSemanticAction"
	| "compiledSemanticAction"
	| "overlayBlockerDiagnostic"
	| "fillVerificationDiagnostic"
	| "electronRefFreshnessDiagnostic"
	| "selectorTextVisibilityDiagnostics"
	| "electronBroadGetTextScopeDiagnostics"
	| "sourceLookup"
	| "clickDispatchDiagnostic"
	| "commandTokens"
	| "scrollNoopDiagnostic"
	| "comboboxFocusDiagnostic"
	| "managedSessionOutcome"
	| "processResult"
	| "timeoutPartialProgress"
	| "sessionMode"
>;

function addElectronRecovery(
	prior: readonly AgentBrowserNextAction[],
	options: Pick<
		ResultActionsInput,
		"electronPostCommandHealth" | "electronSessionMismatch" | "electronLaunchRecords"
	>,
): AgentBrowserNextAction[] {
	const actions = [...prior];
	const healthRecord = options.electronPostCommandHealth
		? options.electronLaunchRecords.get(options.electronPostCommandHealth.launchId)
		: undefined;
	if (healthRecord) {
		appendUniqueAgentBrowserNextActions(actions, buildElectronLifecycleNextActions(healthRecord));
	}
	const mismatchRecord = options.electronSessionMismatch
		? options.electronLaunchRecords.get(options.electronSessionMismatch.launchId)
		: undefined;
	if (mismatchRecord) {
		appendUniqueAgentBrowserNextActions(
			actions,
			buildElectronMismatchNextActions(mismatchRecord, options.electronSessionMismatch?.liveTarget),
		);
	}
	return actions;
}

function addObservationRecovery(
	prior: readonly AgentBrowserNextAction[],
	options: Pick<
		ResultActionsInput,
		| "executionPlan"
		| "overlayBlockerDiagnostic"
		| "fillVerificationDiagnostic"
		| "electronRefFreshnessDiagnostic"
		| "selectorTextVisibilityDiagnostics"
		| "electronBroadGetTextScopeDiagnostics"
		| "sourceLookup"
	>,
): AgentBrowserNextAction[] {
	const actions = [...prior];
	const sessionName = options.executionPlan.sessionName;
	if (options.overlayBlockerDiagnostic) {
		actions.push(
			...buildOverlayBlockerNextActions({
				diagnostic: options.overlayBlockerDiagnostic,
				sessionName,
			}),
		);
	}
	if (options.fillVerificationDiagnostic) {
		appendUniqueAgentBrowserNextActions(
			actions,
			buildFillVerificationNextActions(options.fillVerificationDiagnostic, sessionName),
		);
	}
	if (options.electronRefFreshnessDiagnostic) {
		appendUniqueAgentBrowserNextActions(actions, buildElectronRefFreshnessNextActions(sessionName));
	}
	if (options.selectorTextVisibilityDiagnostics.length > 0) {
		actions.push(
			...buildSelectorTextVisibilityNextActions({
				diagnostics: options.selectorTextVisibilityDiagnostics,
				sessionName,
			}),
		);
	}
	if (options.electronBroadGetTextScopeDiagnostics.length > 0) {
		actions.push(
			...buildElectronBroadGetTextScopeNextActions({
				diagnostics: options.electronBroadGetTextScopeDiagnostics,
				sessionName,
			}),
		);
	}
	if (options.sourceLookup?.electronContext) {
		appendUniqueAgentBrowserNextActions(
			actions,
			buildSourceLookupElectronNextActions(options.sourceLookup),
		);
	}
	return actions;
}

function addInteractionRecovery(
	prior: readonly AgentBrowserNextAction[],
	options: Pick<
		ResultActionsInput,
		| "executionPlan"
		| "clickDispatchDiagnostic"
		| "commandTokens"
		| "scrollNoopDiagnostic"
		| "comboboxFocusDiagnostic"
		| "managedSessionOutcome"
	>,
): AgentBrowserNextAction[] {
	const actions = [...prior];
	const sessionName = options.executionPlan.sessionName;
	if (options.clickDispatchDiagnostic) {
		actions.push(
			...buildClickDispatchNextActions({
				commandTokens: options.commandTokens,
				diagnostic: options.clickDispatchDiagnostic,
				sessionName,
			}),
		);
	}
	if (options.scrollNoopDiagnostic) {
		actions.push(...buildScrollNoopNextActions(sessionName));
	}
	if (options.comboboxFocusDiagnostic) {
		actions.push(...buildComboboxFocusNextActions(sessionName));
	}
	if (options.managedSessionOutcome) {
		appendUniqueAgentBrowserNextActions(
			actions,
			buildManagedSessionFreshFailureNextActions(options.managedSessionOutcome),
		);
	}
	return actions;
}

function addInterruptionRecovery(
	prior: readonly AgentBrowserNextAction[],
	options: Pick<
		ResultActionsInput,
		| "categoryDetails"
		| "currentSessionTabTargetUnknown"
		| "executionPlan"
		| "processResult"
		| "sessionMode"
		| "timeoutPartialProgress"
	>,
): AgentBrowserNextAction[] {
	let actions = [...prior];
	if (
		options.currentSessionTabTargetUnknown === true &&
		["aborted", "parse-failure"].includes(options.categoryDetails.failureCategory ?? "")
	) {
		actions = actions.filter((action) => !isStandaloneSnapshotNextAction(action));
		appendUniqueAgentBrowserNextActions(actions, [
			{
				id: "verify-page-target-after-interruption",
				tool: "agent_browser",
				params: {
					args: withOptionalSessionArgs(options.executionPlan.sessionName, ["batch", "--bail"]),
					stdin: JSON.stringify([
						["get", "url"],
						["snapshot", "-i"],
					]),
				},
				reason: "Verify the current URL and inspect the page after an interrupted operation.",
				safety:
					"Read-only recovery. The mutation may already have happened; inspect before deciding whether to retry.",
			},
		]);
	}
	if (options.categoryDetails.failureCategory === "timeout" && options.processResult.timedOut) {
		if (options.currentSessionTabTargetUnknown === true) {
			actions = actions.filter((action) => !isStandaloneSnapshotNextAction(action));
		}
		appendUniqueAgentBrowserNextActions(actions, buildTimeoutPartialProgressNextActions(options));
		appendUniqueAgentBrowserNextActions(
			actions,
			buildDialogTimeoutNextActions({
				command: options.executionPlan.commandInfo.command,
				sessionName: options.executionPlan.sessionName,
			}),
		);
	}
	return actions;
}

export function buildResultNextActions(
	options: ResultActionsInput,
): AgentBrowserNextAction[] | undefined {
	if (options.presentation.recordingRecovery || options.presentation.readConfirmation) {
		return options.presentation.nextActions === undefined
			? undefined
			: [...options.presentation.nextActions];
	}
	let actions = buildPageRecoveryActions(options);
	actions.push(...buildSelectorRecoveryActions(options));
	actions = addElectronRecovery(actions, options);
	if (
		options.categoryDetails.failureCategory === "selector-not-found" &&
		options.redactedCompiledSemanticAction
	) {
		actions.push(...buildSemanticActionCandidateActions(options.redactedCompiledSemanticAction));
	}
	actions = addObservationRecovery(actions, options);
	actions = addInteractionRecovery(actions, options);
	actions = addInterruptionRecovery(actions, options);
	actions.push(...buildStaleSemanticRetry(options));
	if (options.electronLaunchRecord) {
		actions.push(
			...(buildAgentBrowserNextActions({
				electron: {
					launchId: options.electronLaunchRecord.launchId,
					sessionName: options.electronLaunchRecord.sessionName,
					status: options.electronLaunchRecord.cleanupState,
				},
				failureCategory: options.categoryDetails.failureCategory,
				resultCategory: options.categoryDetails.resultCategory,
				successCategory: options.categoryDetails.successCategory,
			}) ?? []),
		);
	}
	return actions.length > 0 ? actions : undefined;
}
