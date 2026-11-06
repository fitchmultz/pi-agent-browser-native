import type { ProcessBrowserOutputInput, PreparedBrowserRun } from "./types.js";
import type { LifecycleOutputPhase } from "./process-output-lifecycle-phase-contracts.js";
import { extractEnvelopeErrorText, getAgentBrowserErrorText } from "../../results/envelope.js";
import {
	getClipboardWritePayloadCandidates,
	redactClipboardPermissionEcho,
	redactClipboardPermissionErrorValue,
} from "../../results/presentation/errors.js";
import { getStaleRefArgs } from "./session-state.js";
import { buildWrapperRecoveryHint } from "./final-result.js";

type ResolveOutputErrorInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "commandClosesSession"
		| "managedSessionOutcome"
		| "parseError"
		| "presentationEnvelope"
		| "plainTextInspection"
		| "plainTextUpgrade"
		| "recordingStopRecovery"
		| "sessionTabCorrection"
		| "succeeded"
		| "textOutput"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				| "commandTokens"
				| "executionPlan"
				| "ownedManagedSessionContext"
				| "redactedProcessArgs"
				| "runtimeToolStdin"
			>
		>;
	};
};
type ResolveNativeErrorTextInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "parseError"
		| "plainTextInspection"
		| "presentationEnvelope"
		| "recordingStopRecovery"
		| "sessionTabCorrection"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<
			Pick<
				PreparedBrowserRun,
				"commandTokens" | "executionPlan" | "redactedProcessArgs" | "runtimeToolStdin"
			>
		>;
	};
};
type ApplyErrorEnvelopeFallbackInput = Readonly<
	Pick<LifecycleOutputPhase, "errorText" | "presentationEnvelope">
>;
type RedactClipboardErrorInput = Readonly<
	Pick<LifecycleOutputPhase, "errorText" | "presentationEnvelope">
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
	};
};
type ApplyTextErrorEnvelopeInput = Readonly<
	Pick<LifecycleOutputPhase, "errorText" | "plainTextUpgrade" | "textOutput">
> &
	Readonly<Pick<LifecycleOutputPhase, "presentationEnvelope">>;
type ObserveResultLaunchPolicyInput = Readonly<
	Pick<LifecycleOutputPhase, "commandClosesSession" | "managedSessionOutcome" | "succeeded">
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "ownedManagedSessionContext">>;
	};
};
type PreparedSessionRetainedInput = Readonly<Pick<LifecycleOutputPhase, "managedSessionOutcome">>;

export function resolveOutputError(
	draft: ResolveOutputErrorInput,
): Pick<
	LifecycleOutputPhase,
	| "errorText"
	| "presentationEnvelope"
	| "resultHeadedManagedAutosaveDisabled"
	| "resultHeadedManagedAutosaveInterval"
> {
	const errorText = resolveNativeErrorText(draft);
	const fallback = applyErrorEnvelopeFallback({
		errorText,
		presentationEnvelope: draft.presentationEnvelope,
	});
	const redacted = redactClipboardError({
		input: draft.input,
		errorText,
		presentationEnvelope: fallback,
	});
	return {
		...redacted,
		presentationEnvelope: applyTextErrorEnvelope({
			...redacted,
			plainTextUpgrade: draft.plainTextUpgrade,
			textOutput: draft.textOutput,
		}),
		...observeResultLaunchPolicy(draft),
	};
}

function resolveNativeErrorText(draft: ResolveNativeErrorTextInput): string | undefined {
	return draft.recordingStopRecovery?.recovery.healed === true
		? undefined
		: getAgentBrowserErrorText({
				aborted: draft.input.processResult.aborted,
				command: draft.input.prepared.executionPlan.commandInfo.command,
				effectiveArgs: draft.input.prepared.redactedProcessArgs,
				envelope: draft.presentationEnvelope,
				exitCode: draft.input.processResult.exitCode,
				exitSignal: draft.input.processResult.exitSignal,
				parseError: draft.parseError,
				plainTextInspection: draft.plainTextInspection,
				staleRefArgs: getStaleRefArgs(
					draft.input.prepared.commandTokens,
					draft.input.prepared.runtimeToolStdin,
				),
				spawnError: draft.input.processResult.spawnError,
				stderr: draft.input.processResult.stderr,
				timedOut: draft.input.processResult.timedOut,
				timeoutMs: draft.input.processResult.timeoutMs,
				wrapperRecoveryHint: buildWrapperRecoveryHint({
					sessionTabCorrection: draft.sessionTabCorrection,
				}),
			});
}

function applyErrorEnvelopeFallback(
	draft: ApplyErrorEnvelopeFallbackInput,
): LifecycleOutputPhase["presentationEnvelope"] {
	if (
		draft.errorText !== undefined &&
		draft.errorText.length > 0 &&
		draft.presentationEnvelope?.success === false &&
		extractEnvelopeErrorText(draft.presentationEnvelope.error) === undefined
	) {
		return { ...draft.presentationEnvelope, error: draft.errorText };
	}
	return draft.presentationEnvelope;
}

function redactClipboardError(
	draft: RedactClipboardErrorInput,
): Pick<LifecycleOutputPhase, "errorText" | "presentationEnvelope"> {
	if (draft.errorText === undefined || draft.errorText.length === 0) {
		return { errorText: draft.errorText, presentationEnvelope: draft.presentationEnvelope };
	}
	const clipboardWritePayloadCandidates = getClipboardWritePayloadCandidates(
		draft.input.prepared.commandTokens,
	);
	const errorText = redactClipboardPermissionEcho(
		draft.input.prepared.executionPlan.commandInfo,
		draft.errorText,
	);
	const presentationEnvelope =
		draft.presentationEnvelope?.error !== undefined
			? {
					...draft.presentationEnvelope,
					error: redactClipboardPermissionErrorValue(
						draft.input.prepared.executionPlan.commandInfo,
						draft.presentationEnvelope.error,
						clipboardWritePayloadCandidates,
					),
				}
			: draft.presentationEnvelope;
	return { errorText, presentationEnvelope };
}

function applyTextErrorEnvelope(
	draft: ApplyTextErrorEnvelopeInput,
): LifecycleOutputPhase["presentationEnvelope"] {
	return (draft.plainTextUpgrade || draft.textOutput) &&
		draft.errorText !== undefined &&
		draft.errorText.length > 0
		? { ...draft.presentationEnvelope, success: false, error: draft.errorText }
		: draft.presentationEnvelope;
}

function observeResultLaunchPolicy(
	draft: ObserveResultLaunchPolicyInput,
): Pick<
	LifecycleOutputPhase,
	"resultHeadedManagedAutosaveDisabled" | "resultHeadedManagedAutosaveInterval"
> {
	const resultRetainsPreparedManagedSession = preparedSessionRetained(draft);
	return {
		resultHeadedManagedAutosaveDisabled:
			draft.input.prepared.ownedManagedSessionContext?.headedManagedAutosaveDisabled === true &&
			resultRetainsPreparedManagedSession &&
			!(draft.commandClosesSession && draft.succeeded),
		resultHeadedManagedAutosaveInterval:
			resultRetainsPreparedManagedSession && !(draft.commandClosesSession && draft.succeeded)
				? draft.input.prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval
				: undefined,
	};
}

function preparedSessionRetained(draft: PreparedSessionRetainedInput): boolean {
	return (
		!draft.managedSessionOutcome ||
		(draft.managedSessionOutcome.activeAfter &&
			draft.managedSessionOutcome.attemptedSessionName ===
				draft.managedSessionOutcome.currentSessionName)
	);
}
