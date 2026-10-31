import type {
	ObserveCloseLifecycleInput,
	RedactNativeEnvelopeInput,
	ClassifyNativeExecutionInput,
	ObserveInterruptedMutationInput,
	ApplyCloseAndTraceLifecycleInput,
	ObserveCloseStatePathInput,
	ClassifyNativeEnvelopeInput,
	ObserveNativePolicyExecutionInput,
	ObserveNativeConfirmationPolicyInput,
	NormalizeStreamEnableNoopInput,
	ClearReopenedTabLatchInput,
	ApplyOutputCloseScopeInput,
	RestoreConfirmActionsAfterRelaunchInput,
	FoldTraceOwnershipInput,
	ResolveEnvelopeSuccessInput,
	FoldBatchTraceRowInput,
	PruneNamespaceNetworkRoutesInput,
} from "./process-output-lifecycle-contracts.js";
import { isStringArray } from "../../results/presentation/content.js";
import type { AgentBrowserEnvelope } from "../../results/contracts.js";
import { isBrowserIndependentRead } from "../../command-policy.js";
import {
	deleteIdentityKeysInNamespace,
	isAgentBrowserSessionIdentityKeyInNamespace,
} from "../../argv-grammar.js";
import { getSuccessfulBatchCloseLifecycle } from "../../batch-lifecycle.js";
import {
	isCloseAllCommand,
	isPageMutationCommand,
	isWindowOrDiffPageTransitionCommand,
} from "../../command-taxonomy.js";
import { detectConfirmationRequired } from "../../results/confirmation.js";
import { isRecord } from "../../parsing.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { isBrowserIndependentConfirmation } from "../../read-confirmation.js";
import { extractUpstreamCommandTokens } from "../../argv-descriptor.js";
import {
	commandChoosesSessionTabTarget,
	getSessionContextKey,
	updateTraceOwnerState,
	nativePolicyDefinitelyUnestablished,
} from "./session-state.js";
import { redactExactSensitiveValue } from "./final-result.js";
export function observeCloseLifecycle(draft: ObserveCloseLifecycleInput): void {
	draft.destinationTransition = draft.dispatchedCommands.some((step) => {
		const [command, subcommand] = extractUpstreamCommandTokens(step);
		return isWindowOrDiffPageTransitionCommand(command, subcommand);
	});
	draft.nestedBatchClose =
		draft.input.prepared.executionPlan.commandInfo.command === "batch"
			? getSuccessfulBatchCloseLifecycle(draft.presentationEnvelope?.data, draft.batchCommandSteps)
			: undefined;
	draft.nestedBatchClosed = draft.nestedBatchClose?.endsClosed === true;
	draft.nestedBatchRemainsActive = draft.nestedBatchClose?.endsClosed === false;
	// Native batch rows run in the batch's own session; only a direct close --all closes a namespace.
	draft.directCloseAllRequested = isCloseAllCommand(
		extractUpstreamCommandTokens(draft.input.prepared.commandTokens),
	);
	observeCloseStatePath(draft);
}

export function redactNativeEnvelope(draft: RedactNativeEnvelopeInput): void {
	if (draft.presentationEnvelope && draft.input.prepared.exactSensitiveValues.length > 0) {
		const redacted = redactExactSensitiveValue(
			draft.presentationEnvelope,
			draft.input.prepared.exactSensitiveValues,
		);
		if (!isRecord(redacted) || typeof redacted.success !== "boolean") {
			throw new Error("Native envelope redaction did not preserve its success field.");
		}
		draft.presentationEnvelope = { ...redacted, success: redacted.success };
	}
	draft.parseFailureOutput =
		draft.parseError !== undefined &&
		draft.parseError.length > 0 &&
		draft.input.processResult.stdoutSpillPath !== undefined &&
		draft.input.processResult.stdoutSpillPath.length > 0
			? {
					fullOutputUnavailable:
						"Malformed upstream output was discarded because it may contain sensitive browser data.",
				}
			: {};
}

export function classifyNativeExecution(draft: ClassifyNativeExecutionInput): void {
	observeNativePolicyExecution(draft);
	classifyNativeEnvelope(draft);
}

export function observeInterruptedMutation(draft: ObserveInterruptedMutationInput): void {
	draft.unobservedMutation =
		draft.input.processResult.agentBrowserStarted &&
		!draft.plainTextInspection &&
		(draft.input.processResult.aborted ||
			draft.input.processResult.timedOut ||
			!draft.parseSucceeded ||
			draft.presentationEnvelope === undefined) &&
		(draft.input.prepared.executionPlan.commandInfo.command === "batch"
			? draft.batchCommandSteps
			: [draft.input.prepared.commandTokens]
		).some((step) => {
			const action = step[0] === "find" ? (step[step[1] === "nth" ? 4 : 3] ?? "click") : step[0];
			return isPageMutationCommand(action, step[1]);
		});
	draft.sessionStateKey = getSessionContextKey(
		draft.input.prepared.executionPlan.sessionName,
		draft.input.prepared.executionPlan.namespace,
	);
	draft.closeAllApplied = draft.directCloseAllRequested && draft.succeeded;
}

export function applyCloseAndTraceLifecycle(draft: ApplyCloseAndTraceLifecycleInput): void {
	clearReopenedTabLatch(draft);
	applyOutputCloseScope(draft);
	restoreConfirmActionsAfterRelaunch(draft);
	foldTraceOwnership(draft);
}

function nativePrimitiveErrorMessage(error: unknown): string | undefined {
	if (typeof error === "number") {
		return error !== 0 && !Number.isNaN(error) ? String(error) : undefined;
	}
	return error === true ? "true" : undefined;
}

function getEnvelopeErrorString(
	envelope: Readonly<AgentBrowserEnvelope> | undefined,
): string | undefined {
	if (!envelope) {
		return;
	}
	const error: unknown = envelope.error;
	if (typeof error === "string") {
		return error.length > 0 ? error : undefined;
	}
	if (isRecord(error) && typeof error.message === "string") {
		return error.message;
	}
	// Arbitrary browser error objects may contain credentials and have no useful public message.
	return nativePrimitiveErrorMessage(error);
}

function isStreamEnableAlreadyEnabledNoop(options: {
	readonly command: string | undefined;
	readonly envelope: Readonly<AgentBrowserEnvelope> | undefined;
	readonly processSucceeded: boolean;
	readonly subcommand: string | undefined;
}): boolean {
	if (
		!options.processSucceeded ||
		options.command !== "stream" ||
		options.subcommand !== "enable" ||
		options.envelope?.success !== false
	) {
		return false;
	}
	const message = (getEnvelopeErrorString(options.envelope) ?? "")
		.trim()
		.replace(/[.!]+$/, "")
		.toLowerCase();
	return (
		message === "streaming is already enabled for this session" ||
		message === "streaming is already enabled" ||
		message === "stream already enabled"
	);
}

function observeCloseStatePath(draft: ObserveCloseStatePathInput): void {
	const directCloseData: unknown = draft.confirmedData ?? draft.presentationEnvelope?.data;
	draft.rawCloseStatePath =
		draft.directClose && isRecord(directCloseData) && typeof directCloseData.statePath === "string"
			? directCloseData.statePath
			: draft.nestedBatchClose?.statePath;
}

function classifyNativeEnvelope(draft: ClassifyNativeEnvelopeInput): void {
	observeNativeConfirmationPolicy(draft);
	draft.processSucceeded =
		!draft.input.processResult.timedOut &&
		!draft.input.processResult.aborted &&
		!draft.input.processResult.spawnError &&
		draft.input.processResult.exitCode === 0;
	draft.plainTextInspection =
		draft.input.prepared.executionPlan.plainTextInspection && draft.processSucceeded;
	draft.parseSucceeded = draft.plainTextInspection || draft.parseError === undefined;
	normalizeStreamEnableNoop(draft);
	resolveEnvelopeSuccess(draft);
	draft.inspectionText = draft.plainTextInspection
		? draft.input.processResult.stdout.trim()
		: undefined;
}

function observeNativePolicyExecution(draft: ObserveNativePolicyExecutionInput): void {
	draft.browserIndependentRead =
		isBrowserIndependentConfirmation(draft.input.prepared.readConfirmation) ||
		isBrowserIndependentRead(
			draft.input.prepared.commandTokens,
			draft.input.prepared.runtimeToolStdin,
		);
	draft.nativeCommandMayHaveExecuted = !nativePolicyDefinitelyUnestablished(
		draft.input.processResult,
		draft.parsed.envelope,
		draft.input.prepared.commandTokens,
	);
}

function observeNativeConfirmationPolicy(draft: ObserveNativeConfirmationPolicyInput): void {
	if (draft.input.state.confirmationPolicyMayBeEstablished !== true) {
		draft.input.state.confirmationPolicyMayBeEstablished = draft.nativeCommandMayHaveExecuted;
	}
}

function normalizeStreamEnableNoop(draft: NormalizeStreamEnableNoopInput): void {
	if (
		isStreamEnableAlreadyEnabledNoop({
			command: draft.input.prepared.executionPlan.commandInfo.command,
			envelope: draft.presentationEnvelope,
			processSucceeded: draft.processSucceeded,
			subcommand: draft.input.prepared.executionPlan.commandInfo.subcommand,
		})
	) {
		draft.presentationEnvelope = {
			success: true,
			data: {
				alreadyEnabled: true,
				enabled: true,
				message: getEnvelopeErrorString(draft.presentationEnvelope) ?? "Stream already enabled",
			},
		};
	}
}

function clearReopenedTabLatch(draft: ClearReopenedTabLatchInput): void {
	if (
		draft.sessionStateKey !== undefined &&
		draft.sessionStateKey.length > 0 &&
		draft.input.processResult.agentBrowserStarted &&
		draft.input.state.sessionPageState.get(draft.sessionStateKey).tabReopenPending === true
	) {
		if (draft.dispatchedCommands.some(commandChoosesSessionTabTarget)) {
			draft.input.state.sessionPageState.setTabReopenPending({
				pending: false,
				sessionName: draft.sessionStateKey,
				update: draft.input.sessionPageStateUpdate,
			});
		}
	}
}

function applyOutputCloseScope(draft: ApplyOutputCloseScopeInput): void {
	if (draft.closeAllApplied) {
		pruneNamespaceNetworkRoutes(draft);
		deleteIdentityKeysInNamespace(
			draft.input.state.attachedSessionKeys,
			draft.input.prepared.executionPlan.namespace,
		);
		deleteIdentityKeysInNamespace(
			draft.input.state.traceOwners,
			draft.input.prepared.executionPlan.namespace,
		);
		draft.input.state.sessionPageState.clearNamespace(draft.input.prepared.executionPlan.namespace);
		for (const [key, owner] of draft.input.state.ownedManagedSessions) {
			if (
				!isAgentBrowserSessionIdentityKeyInNamespace(
					key,
					draft.input.prepared.executionPlan.namespace,
				)
			) {
				continue;
			}
			draft.input.state.closedManagedSessionNames.add(key);
			draft.input.state.managedSessionRestoreState.clear(owner.sessionName, owner.namespace);
		}
	} else if (
		draft.nestedBatchClose &&
		draft.sessionStateKey !== undefined &&
		draft.sessionStateKey.length > 0
	) {
		const routes = new Map(draft.networkRoutesBySession);
		routes.delete(draft.sessionStateKey);
		draft.networkRoutesBySession = routes;
		draft.input.state.sessionPageState.clearSession(draft.sessionStateKey);
	}
}

function restoreConfirmActionsAfterRelaunch(draft: RestoreConfirmActionsAfterRelaunchInput): void {
	if (
		draft.sessionStateKey !== undefined &&
		draft.sessionStateKey.length > 0 &&
		draft.nestedBatchRemainsActive
	) {
		const confirmActions = getAgentBrowserProcessEnvironment().AGENT_BROWSER_CONFIRM_ACTIONS;
		if (confirmActions !== undefined) {
			draft.input.state.sessionPageState.setConfirmActions(draft.sessionStateKey, confirmActions);
		}
	}
}

function foldTraceOwnership(draft: FoldTraceOwnershipInput): void {
	if (
		draft.input.prepared.executionPlan.commandInfo.command === "batch" &&
		Array.isArray(draft.presentationEnvelope?.data)
	) {
		for (const [index, row] of draft.presentationEnvelope.data.entries()) {
			foldBatchTraceRow(draft, row, index);
		}
	} else {
		updateTraceOwnerState({
			command: draft.directClose ? "close" : draft.input.prepared.executionPlan.commandInfo.command,
			sessionName: draft.sessionStateKey,
			subcommand: draft.input.prepared.executionPlan.commandInfo.subcommand,
			succeeded: draft.succeeded,
			traceOwners: draft.input.state.traceOwners,
		});
	}
}

function resolveEnvelopeSuccess(draft: ResolveEnvelopeSuccessInput): void {
	const envelopeSuccess: boolean = draft.plainTextInspection
		? true
		: draft.presentationEnvelope?.success !== false &&
			!detectConfirmationRequired(draft.presentationEnvelope?.data);
	draft.succeeded =
		(draft.processSucceeded && draft.parseSucceeded && envelopeSuccess) ||
		draft.recordingStopRecovery?.recovery.healed === true;
}

function foldBatchTraceRow(draft: FoldBatchTraceRowInput, row: unknown, index: number): void {
	if (!isRecord(row)) {
		return;
	}
	const rowCommand = isStringArray(row.command) ? row.command : draft.batchCommandSteps.at(index);
	if (!rowCommand) {
		return;
	}
	const [command, subcommand] = extractUpstreamCommandTokens(rowCommand);
	updateTraceOwnerState({
		command,
		sessionName: draft.sessionStateKey,
		subcommand,
		succeeded: row.success === true && !detectConfirmationRequired(row.result),
		traceOwners: draft.input.state.traceOwners,
	});
}

function pruneNamespaceNetworkRoutes(draft: PruneNamespaceNetworkRoutesInput): void {
	draft.networkRoutesBySession = new Map(
		[...draft.networkRoutesBySession].filter(
			([key]) =>
				!isAgentBrowserSessionIdentityKeyInNamespace(
					key,
					draft.input.prepared.executionPlan.namespace,
				),
		),
	);
}
