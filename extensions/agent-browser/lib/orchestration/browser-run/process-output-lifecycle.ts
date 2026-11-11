import type {
	ObserveCloseLifecycleInput,
	RedactNativeEnvelopeInput,
	ClassifyNativeExecutionInput,
	ObserveInterruptedMutationInput,
	ApplyCloseAndTraceLifecycleInput,
	ObserveNativePolicyExecutionInput,
	NormalizeStreamEnableNoopInput,
	ClearReopenedTabLatchInput,
	ApplyOutputCloseScopeInput,
	RestoreConfirmActionsAfterRelaunchInput,
	FoldTraceOwnershipInput,
	FoldBatchTraceRowInput,
	PruneNamespaceNetworkRoutesInput,
} from "./process-output-lifecycle-contracts.js";
import type { NativeOutputPhase } from "./process-output-native-phase-contracts.js";
import { isStringArray } from "../../results/presentation/content.js";
import type { AgentBrowserEnvelope } from "../../results/contracts.js";
import { isBrowserIndependentRead } from "../../command-policy.js";
import {
	deleteIdentityKeysInNamespace,
	isAgentBrowserSessionIdentityKeyInNamespace,
} from "../../argv-grammar.js";
import {
	batchHasSuccessfulCloseAll,
	getSuccessfulBatchCloseLifecycle,
} from "../../batch-lifecycle.js";
import {
	isCloseAllCommand,
	isPageMutationStep,
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
export function observeCloseLifecycle(
	draft: ObserveCloseLifecycleInput,
): Pick<
	NativeOutputPhase,
	| "destinationTransition"
	| "nestedBatchClose"
	| "nestedBatchClosed"
	| "nestedBatchRemainsActive"
	| "nestedBatchClosesAll"
	| "directCloseAllRequested"
	| "rawCloseStatePath"
> {
	const destinationTransition = draft.dispatchedCommands.some((step) => {
		const [command, subcommand] = extractUpstreamCommandTokens(step);
		return isWindowOrDiffPageTransitionCommand(command, subcommand);
	});
	const nestedBatchClose =
		draft.input.prepared.executionPlan.commandInfo.command === "batch"
			? getSuccessfulBatchCloseLifecycle(draft.presentationEnvelope?.data, draft.batchCommandSteps)
			: undefined;
	return {
		destinationTransition,
		nestedBatchClose,
		nestedBatchClosed: nestedBatchClose?.endsClosed === true,
		nestedBatchRemainsActive: nestedBatchClose?.endsClosed === false,
		nestedBatchClosesAll:
			draft.input.prepared.executionPlan.commandInfo.command === "batch" &&
			batchHasSuccessfulCloseAll(draft.presentationEnvelope?.data, draft.batchCommandSteps),
		directCloseAllRequested: isCloseAllCommand(
			extractUpstreamCommandTokens(draft.input.prepared.commandTokens),
		),
		rawCloseStatePath: rawCloseStatePath(draft, nestedBatchClose),
	};
}

function rawCloseStatePath(
	draft: Pick<ObserveCloseLifecycleInput, "confirmedData" | "directClose" | "presentationEnvelope">,
	nestedBatchClose: NativeOutputPhase["nestedBatchClose"],
): string | undefined {
	const directCloseData: unknown = draft.confirmedData ?? draft.presentationEnvelope?.data;
	return draft.directClose &&
		isRecord(directCloseData) &&
		typeof directCloseData.statePath === "string"
		? directCloseData.statePath
		: nestedBatchClose?.statePath;
}

export function redactNativeEnvelope(
	draft: RedactNativeEnvelopeInput,
): Pick<NativeOutputPhase, "presentationEnvelope" | "parseFailureOutput"> {
	let presentationEnvelope = draft.presentationEnvelope;
	if (draft.presentationEnvelope && draft.input.prepared.exactSensitiveValues.length > 0) {
		const redacted = redactExactSensitiveValue(
			draft.presentationEnvelope,
			draft.input.prepared.exactSensitiveValues,
		);
		if (!isRecord(redacted) || typeof redacted.success !== "boolean") {
			throw new Error("Native envelope redaction did not preserve its success field.");
		}
		presentationEnvelope = { ...redacted, success: redacted.success };
	}
	const parseFailureOutput =
		draft.parseError !== undefined &&
		draft.parseError.length > 0 &&
		draft.input.processResult.stdoutSpillPath !== undefined &&
		draft.input.processResult.stdoutSpillPath.length > 0
			? {
					fullOutputUnavailable:
						"Malformed upstream output was discarded because it may contain sensitive browser data.",
				}
			: {};
	return { presentationEnvelope, parseFailureOutput };
}

export function observeInterruptedMutation(
	draft: ObserveInterruptedMutationInput,
): Pick<NativeOutputPhase, "unobservedMutation" | "sessionStateKey" | "closeAllApplied"> {
	const unobservedMutation =
		draft.input.processResult.agentBrowserStarted &&
		!draft.plainTextInspection &&
		(draft.input.processResult.aborted ||
			draft.input.processResult.timedOut ||
			!draft.parseSucceeded ||
			draft.presentationEnvelope === undefined) &&
		(draft.input.prepared.executionPlan.commandInfo.command === "batch"
			? draft.batchCommandSteps
			: [draft.input.prepared.commandTokens]
		).some(isPageMutationStep);
	const sessionStateKey = getSessionContextKey(
		draft.input.prepared.executionPlan.sessionName,
		draft.input.prepared.executionPlan.namespace,
	);
	return {
		unobservedMutation,
		sessionStateKey,
		closeAllApplied:
			draft.nestedBatchClosesAll || (draft.directCloseAllRequested && draft.succeeded),
	};
}

export function applyCloseAndTraceLifecycle(
	draft: ApplyCloseAndTraceLifecycleInput,
): NativeOutputPhase["networkRoutesBySession"] {
	clearReopenedTabLatch(draft);
	const networkRoutesBySession = applyOutputCloseScope(draft);
	restoreConfirmActionsAfterRelaunch(draft);
	foldTraceOwnership(draft);
	return networkRoutesBySession;
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

export function classifyNativeExecution(
	draft: ClassifyNativeExecutionInput,
): Pick<
	NativeOutputPhase,
	| "processSucceeded"
	| "plainTextInspection"
	| "parseSucceeded"
	| "presentationEnvelope"
	| "succeeded"
	| "inspectionText"
> {
	draft.input.state.recordConfirmationPolicy(draft.nativeCommandMayHaveExecuted);
	const processSucceeded =
		!draft.input.processResult.timedOut &&
		!draft.input.processResult.aborted &&
		!draft.input.processResult.spawnError &&
		draft.input.processResult.exitCode === 0;
	const plainTextInspection =
		draft.input.prepared.executionPlan.plainTextInspection && processSucceeded;
	const parseSucceeded = plainTextInspection || draft.parseError === undefined;
	const presentationEnvelope = normalizeStreamEnableNoop(draft, processSucceeded);
	const succeeded = resolveEnvelopeSuccess({
		processSucceeded,
		plainTextInspection,
		parseSucceeded,
		presentationEnvelope,
		recordingStopRecovery: draft.recordingStopRecovery,
	});
	return {
		processSucceeded,
		plainTextInspection,
		parseSucceeded,
		presentationEnvelope,
		succeeded,
		inspectionText: plainTextInspection ? draft.input.processResult.stdout.trim() : undefined,
	};
}

function resolveEnvelopeSuccess(
	observation: Pick<
		NativeOutputPhase,
		| "plainTextInspection"
		| "presentationEnvelope"
		| "processSucceeded"
		| "parseSucceeded"
		| "recordingStopRecovery"
	>,
): boolean {
	const envelopeSuccess = observation.plainTextInspection
		? true
		: observation.presentationEnvelope?.success !== false &&
			!detectConfirmationRequired(observation.presentationEnvelope?.data);
	return (
		(observation.processSucceeded && observation.parseSucceeded && envelopeSuccess) ||
		observation.recordingStopRecovery?.recovery.healed === true
	);
}

export function observeNativePolicyExecution(
	draft: ObserveNativePolicyExecutionInput,
): Pick<NativeOutputPhase, "browserIndependentRead" | "nativeCommandMayHaveExecuted"> {
	return {
		browserIndependentRead:
			isBrowserIndependentConfirmation(draft.input.prepared.readConfirmation) ||
			isBrowserIndependentRead(
				draft.input.prepared.commandTokens,
				draft.input.prepared.runtimeToolStdin,
			),
		nativeCommandMayHaveExecuted: !nativePolicyDefinitelyUnestablished(
			draft.input.processResult,
			draft.parsed.envelope,
			draft.input.prepared.commandTokens,
		),
	};
}

function normalizeStreamEnableNoop(
	draft: NormalizeStreamEnableNoopInput,
	processSucceeded: boolean,
): NativeOutputPhase["presentationEnvelope"] {
	if (
		isStreamEnableAlreadyEnabledNoop({
			command: draft.input.prepared.executionPlan.commandInfo.command,
			envelope: draft.presentationEnvelope,
			processSucceeded,
			subcommand: draft.input.prepared.executionPlan.commandInfo.subcommand,
		})
	) {
		return {
			success: true,
			data: {
				alreadyEnabled: true,
				enabled: true,
				message: getEnvelopeErrorString(draft.presentationEnvelope) ?? "Stream already enabled",
			},
		};
	}
	return draft.presentationEnvelope;
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

function applyOutputCloseScope(
	draft: ApplyOutputCloseScopeInput,
): NativeOutputPhase["networkRoutesBySession"] {
	if (draft.closeAllApplied) {
		const routes = pruneNamespaceNetworkRoutes(draft);
		deleteIdentityKeysInNamespace(
			draft.input.state.attachedSessionKeys,
			draft.input.prepared.executionPlan.namespace,
		);
		deleteIdentityKeysInNamespace(
			draft.input.state.traceOwners,
			draft.input.prepared.executionPlan.namespace,
		);
		draft.input.state.sessionPageState.clearNamespace(draft.input.prepared.executionPlan.namespace);
		const retainedSessionKey = draft.nestedBatchRemainsActive ? draft.sessionStateKey : undefined;
		for (const [key, owner] of draft.input.state.ownedManagedSessions) {
			if (
				!isAgentBrowserSessionIdentityKeyInNamespace(
					key,
					draft.input.prepared.executionPlan.namespace,
				) ||
				key === retainedSessionKey
			) {
				continue;
			}
			draft.input.state.closedManagedSessionNames.add(key);
			draft.input.state.managedSessionRestoreState.clear(owner.sessionName, owner.namespace);
		}
		return routes;
	} else if (
		draft.nestedBatchClose &&
		draft.sessionStateKey !== undefined &&
		draft.sessionStateKey.length > 0
	) {
		const routes = new Map(draft.networkRoutesBySession);
		routes.delete(draft.sessionStateKey);
		draft.input.state.sessionPageState.clearSession(draft.sessionStateKey);
		return routes;
	}
	return draft.networkRoutesBySession;
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

function pruneNamespaceNetworkRoutes(
	draft: PruneNamespaceNetworkRoutesInput,
): NativeOutputPhase["networkRoutesBySession"] {
	return new Map(
		[...draft.networkRoutesBySession].filter(
			([key]) =>
				!isAgentBrowserSessionIdentityKeyInNamespace(
					key,
					draft.input.prepared.executionPlan.namespace,
				),
		),
	);
}
