import { extractExplicitSessionName } from "../../argv-grammar.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { buildRichInputRecoveryDiagnostic } from "../../results/selector-recovery.js";
import {
	buildNoActivePageRefSnapshotInvalidation,
	isNoActivePageSnapshotFailure,
	type SessionPageState,
	type SessionPageStateUpdateResult,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
} from "../../session-page-state.js";
import { collectVisibleRefFallbackDiagnostic } from "./diagnostics.js";
import { getSessionContextKey } from "./session-state.js";
import type { FinalRecoveryState } from "./types.js";
import type { PublicationInput as FinalResultInput } from "./final-result-contracts.js";

type RecoveryInput = Pick<
	FinalResultInput,
	| "aboutBlankSessionMismatch"
	| "commandTokens"
	| "compiledSemanticAction"
	| "currentRefSnapshot"
	| "currentRefSnapshotInvalidation"
	| "currentSessionTabTarget"
	| "electronPostCommandHealth"
	| "errorText"
	| "executionPlan"
	| "parseError"
	| "plainTextInspection"
	| "presentation"
	| "processResult"
	| "redactedProcessArgs"
	| "sessionTabCorrection"
	| "succeeded"
> &
	Readonly<{
		batchRefSnapshotState?:
			| Readonly<{
					snapshot?: SessionRefSnapshot;
					invalidation?: SessionRefSnapshotInvalidation;
			  }>
			| undefined;
		cwd: string;
		runtimeToolArgs: readonly string[];
		// Recovery commits through this branch-token-guarded state owner, never borrowed analysis.
		sessionPageState: SessionPageState;
		sessionPageStateUpdate: ReturnType<SessionPageState["beginUpdate"]>;
		signal?: AbortSignal | undefined;
	}>;

function recoveryFailureCategory(
	options: Pick<RecoveryInput, "presentation" | "electronPostCommandHealth">,
): FinalRecoveryState["categoryDetails"]["failureCategory"] {
	return (
		options.presentation.failureCategory ??
		options.presentation.batchFailure?.failedStep.failureCategory ??
		(options.electronPostCommandHealth ? "tab-drift" : undefined)
	);
}

function classifyRecovery(
	options: Pick<
		RecoveryInput,
		| "presentation"
		| "redactedProcessArgs"
		| "executionPlan"
		| "errorText"
		| "electronPostCommandHealth"
		| "plainTextInspection"
		| "parseError"
		| "processResult"
		| "succeeded"
		| "aboutBlankSessionMismatch"
		| "sessionTabCorrection"
	>,
): FinalRecoveryState["categoryDetails"] {
	return buildAgentBrowserResultCategoryDetails({
		artifacts: options.presentation.artifacts,
		args: options.redactedProcessArgs,
		command: options.executionPlan.commandInfo.command,
		confirmationRequired: options.presentation.summary.startsWith("Confirmation required"),
		errorText: options.errorText ?? options.presentation.summary,
		failureCategory: recoveryFailureCategory(options),
		inspection: options.plainTextInspection,
		parseError: options.parseError,
		savedFile: options.presentation.savedFile,
		spawnError: options.processResult.spawnError?.message,
		succeeded: options.succeeded,
		tabDrift:
			!options.succeeded &&
			(options.aboutBlankSessionMismatch !== undefined ||
				options.electronPostCommandHealth !== undefined ||
				options.sessionTabCorrection !== undefined),
		timedOut: options.processResult.timedOut,
		validationError: undefined,
	});
}

function applyFallbackSnapshot(
	options: Pick<
		RecoveryInput,
		"sessionPageState" | "sessionPageStateUpdate" | "currentSessionTabTarget"
	>,
	snapshot: SessionRefSnapshot | undefined,
	sessionKey: string | undefined,
): SessionPageStateUpdateResult | undefined {
	if (!snapshot || sessionKey === undefined || sessionKey.length === 0) {
		return undefined;
	}
	return options.sessionPageState.applyRefSnapshot({
		fallbackTarget: options.currentSessionTabTarget,
		sessionName: sessionKey,
		snapshot,
		update: options.sessionPageStateUpdate,
	});
}

function invalidateNoActivePage(
	options: Pick<RecoveryInput, "sessionPageState" | "sessionPageStateUpdate" | "executionPlan">,
): SessionPageStateUpdateResult | undefined {
	const sessionKey = getSessionContextKey(
		options.executionPlan.sessionName,
		options.executionPlan.namespace,
	);
	if (sessionKey === undefined || sessionKey.length === 0) {
		return undefined;
	}
	return options.sessionPageState.applyRefSnapshotInvalidation({
		invalidation: buildNoActivePageRefSnapshotInvalidation(),
		sessionName: sessionKey,
		update: options.sessionPageStateUpdate,
	});
}

function hasNoActivePage(
	options: Pick<
		RecoveryInput,
		"executionPlan" | "errorText" | "presentation" | "batchRefSnapshotState"
	>,
	category: Readonly<FinalRecoveryState["categoryDetails"]>,
): boolean {
	return (
		category.resultCategory === "failure" &&
		(isNoActivePageSnapshotFailure(
			options.executionPlan.commandInfo.command,
			options.errorText ?? options.presentation.summary,
		) ||
			options.batchRefSnapshotState?.invalidation?.reason === "no-active-page")
	);
}

export async function prepareFinalResultRecoveryState(
	options: RecoveryInput,
): Promise<FinalRecoveryState> {
	const categoryDetails = classifyRecovery(options);
	let { currentRefSnapshot, currentRefSnapshotInvalidation } = options;
	let visibleRefFallbackDiagnostic: FinalRecoveryState["visibleRefFallbackDiagnostic"];
	const visibleRefFallbackSessionName =
		options.executionPlan.sessionName ?? extractExplicitSessionName(options.runtimeToolArgs);
	if (categoryDetails.failureCategory === "selector-not-found") {
		visibleRefFallbackDiagnostic = await collectVisibleRefFallbackDiagnostic({
			commandTokens: options.presentation.batchFailure?.failedStep.command ?? options.commandTokens,
			compiledSemanticAction: options.compiledSemanticAction,
			cwd: options.cwd,
			namespace: options.executionPlan.namespace,
			sessionName: visibleRefFallbackSessionName,
			signal: options.signal,
		});
		const update = applyFallbackSnapshot(
			options,
			visibleRefFallbackDiagnostic?.snapshot,
			getSessionContextKey(visibleRefFallbackSessionName, options.executionPlan.namespace),
		);
		if (update) {
			currentRefSnapshot = update.refSnapshot;
			currentRefSnapshotInvalidation = update.refSnapshotInvalidation;
		}
	}
	const noActivePageSnapshotFailure = hasNoActivePage(options, categoryDetails);
	if (noActivePageSnapshotFailure) {
		const update = invalidateNoActivePage(options);
		if (update) {
			currentRefSnapshot = update.refSnapshot;
			currentRefSnapshotInvalidation = update.refSnapshotInvalidation;
		}
	}
	return {
		categoryDetails,
		currentRefSnapshot,
		currentRefSnapshotInvalidation,
		noActivePageSnapshotFailure,
		richInputRecoveryDiagnostic: buildRichInputRecoveryDiagnostic(visibleRefFallbackDiagnostic),
		visibleRefFallbackDiagnostic,
		visibleRefFallbackSessionName,
	};
}
