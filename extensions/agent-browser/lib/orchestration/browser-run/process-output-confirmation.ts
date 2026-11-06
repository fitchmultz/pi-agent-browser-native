import type { PreparedBrowserRun, BrowserRunState } from "./types.js";
import type { NativeOutputPhase } from "./process-output-native-phase-contracts.js";
import type { PageOutputPhase } from "./process-output-page-phase-contracts.js";
import type { LifecycleOutputPhase } from "./process-output-lifecycle-phase-contracts.js";
import { isStringArray } from "../../results/presentation/content.js";
import { getAgentBrowserSessionIdentityKey } from "../../argv-grammar.js";
import { isCloseCommand } from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import { detectConfirmationRequired } from "../../results/confirmation.js";
import type { AgentBrowserEnvelope } from "../../results/contracts.js";
import {
	isSuccessfulNativeConfirmedClose,
	nextReadConfirmation,
	parseReadConfirmation,
	type ReadConfirmation,
} from "../../read-confirmation.js";

type ConfirmationRowsInput = Readonly<
	Pick<NativeOutputPhase, "batchCommandSteps" | "presentationEnvelope">
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
	};
};
type FoldReadConfirmationsInput = Readonly<
	Pick<
		NativeOutputPhase,
		"batchCommandSteps" | "confirmedEffects" | "presentationEnvelope" | "readConfirmationEvent"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
		readonly state: BrowserRunState;
	};
};
type ObserveHelperConfirmationInput = Readonly<
	Pick<
		PageOutputPhase,
		"confirmationFromHelper" | "readConfirmation" | "readConfirmationEvent" | "succeeded"
	>
> & { readonly input: { readonly state: BrowserRunState } };
type ObserveFinalHelperConfirmationInput = Readonly<
	Pick<LifecycleOutputPhase, "confirmationFromHelper" | "readConfirmationEvent" | "succeeded">
> & { readonly input: { readonly state: BrowserRunState } };

interface ConfirmationRow {
	readonly tokens: readonly string[];
	readonly data: unknown;
	readonly index: number;
	readonly response: AgentBrowserEnvelope | Readonly<Record<string, unknown>> | undefined;
	readonly succeeded: boolean;
}

function confirmationRows(draft: ConfirmationRowsInput): ConfirmationRow[] {
	const { prepared } = draft.input;
	if (
		prepared.executionPlan.commandInfo.command !== "batch" ||
		!Array.isArray(draft.presentationEnvelope?.data)
	) {
		return [
			{
				tokens: prepared.commandTokens,
				data: draft.presentationEnvelope?.data,
				index: 0,
				response: draft.presentationEnvelope,
				succeeded: draft.presentationEnvelope?.success === true,
			},
		];
	}
	return draft.presentationEnvelope.data.flatMap((row, index) => {
		if (!isRecord(row)) {
			return [];
		}
		const tokens = isStringArray(row.command)
			? row.command
			: (draft.batchCommandSteps[index] ?? []);
		return [{ tokens, data: row.result, index, response: row, succeeded: row.success === true }];
	});
}

function matchesConfirmationDecision(row: ConfirmationRow, id: string): boolean {
	return row.tokens.length === 2 && row.tokens[0] === "confirm" && row.tokens[1] === id;
}

function matchingGuardedConfirmation(
	current: ReadConfirmation | undefined,
	row: ConfirmationRow,
): { readonly command: string; readonly data: Readonly<Record<string, unknown>> } | undefined {
	if (
		current?.state !== "pending" ||
		current.source !== "native-guarded-action" ||
		typeof current.command !== "string"
	) {
		return;
	}
	if (!matchesConfirmationDecision(row, current.id)) {
		return;
	}
	if (!isRecord(row.data) || row.data.confirmed !== true || row.data.action !== current.action) {
		return;
	}
	return { command: current.command, data: row.data };
}

function readConfirmedEffect(
	confirmation: ReadConfirmation | undefined,
	row: ConfirmationRow,
): NativeOutputPhase["confirmedEffects"][number] | undefined {
	const current = matchingGuardedConfirmation(confirmation, row);
	if (!current || !isRecord(current.data.result) || detectConfirmationRequired(current.data)) {
		return;
	}
	return {
		command: current.command,
		data: current.data.result.data,
		index: row.index,
		succeeded: row.succeeded && current.data.result.success === true,
	};
}

function applyConfirmedFailure(
	envelope: AgentBrowserEnvelope | undefined,
	row: ConfirmationRow,
): AgentBrowserEnvelope | undefined {
	if (row.tokens.length !== 2 || row.tokens[0] !== "confirm" || !isRecord(row.data)) {
		return envelope;
	}
	if (
		row.data.confirmed !== true ||
		!isRecord(row.data.result) ||
		row.data.result.success !== false
	) {
		return envelope;
	}
	return failedConfirmationEnvelope(envelope, row.response, row.data.result.error);
}

function failedConfirmationEnvelope(
	envelope: AgentBrowserEnvelope | undefined,
	response: ConfirmationRow["response"],
	error: unknown,
): AgentBrowserEnvelope | undefined {
	if (!envelope || !response) {
		return envelope;
	}
	if (response === envelope) {
		return { ...envelope, success: false, error };
	}
	const data: unknown = envelope.data;
	if (!Array.isArray(data)) {
		return envelope;
	}
	const rows: unknown[] = [];
	for (const item of data) {
		rows.push(item === response ? { ...response, success: false, error } : item);
	}
	return { ...envelope, success: false, data: rows };
}

export function foldReadConfirmations(
	draft: FoldReadConfirmationsInput,
): Pick<
	NativeOutputPhase,
	| "readConfirmation"
	| "readConfirmationEvent"
	| "confirmedEffects"
	| "presentationEnvelope"
	| "confirmedData"
	| "confirmedCommand"
	| "directClose"
> {
	const { prepared, state } = draft.input;
	const sessionName = prepared.executionPlan.sessionName ?? "default";
	let readConfirmation = state.sessionPageState.getReadConfirmation(
		getAgentBrowserSessionIdentityKey(sessionName, prepared.executionPlan.namespace),
	);
	let readConfirmationEvent = draft.readConfirmationEvent;
	const newEffects: NativeOutputPhase["confirmedEffects"][number][] = [];
	let presentationEnvelope = draft.presentationEnvelope;
	for (const row of confirmationRows(draft)) {
		const effect = readConfirmedEffect(readConfirmation, row);
		if (effect) {
			newEffects.push(effect);
		}
		const transition = nextReadConfirmation({
			commandTokens: row.tokens,
			current: readConfirmation,
			data: row.data,
			namespace: prepared.executionPlan.namespace,
			sessionName,
			succeeded: row.succeeded,
		});
		if (transition) {
			readConfirmationEvent = transition;
			readConfirmation = transition;
		}
		presentationEnvelope = applyConfirmedFailure(presentationEnvelope, row);
	}
	const confirmedEffects =
		newEffects.length === 0 ? draft.confirmedEffects : [...draft.confirmedEffects, ...newEffects];
	const direct = directConfirmationEffect(prepared, confirmedEffects, presentationEnvelope);
	if (readConfirmationEvent?.state === "pending") {
		state.recordReadConfirmation(readConfirmationEvent);
	}
	return {
		readConfirmation,
		readConfirmationEvent,
		confirmedEffects,
		presentationEnvelope,
		...direct,
	};
}

export function observeHelperConfirmation(
	draft: ObserveHelperConfirmationInput,
): Pick<
	PageOutputPhase,
	"confirmationFromHelper" | "readConfirmation" | "readConfirmationEvent" | "succeeded"
> {
	const helperConfirmation = parseReadConfirmation(
		draft.input.state.observedBrowserEffects?.readConfirmation,
	);
	// Main pending installs this object; helpers can replace it while their awaits are pending.
	const confirmationFromHelper =
		draft.input.state.observedBrowserEffects?.readConfirmation !== draft.readConfirmationEvent;
	if (confirmationFromHelper && helperConfirmation?.state === "pending") {
		return {
			confirmationFromHelper,
			readConfirmationEvent: helperConfirmation,
			readConfirmation: helperConfirmation,
			succeeded: false,
		};
	}
	return {
		confirmationFromHelper,
		readConfirmationEvent: draft.readConfirmationEvent,
		readConfirmation: draft.readConfirmation,
		succeeded: draft.succeeded,
	};
}

export function observeFinalHelperConfirmation(
	draft: ObserveFinalHelperConfirmationInput,
):
	| Pick<LifecycleOutputPhase, "confirmationFromHelper" | "readConfirmationEvent" | "succeeded">
	| undefined {
	const finalHelperConfirmation = parseReadConfirmation(
		draft.input.state.observedBrowserEffects?.readConfirmation,
	);
	if (finalHelperConfirmation?.state !== "pending") {
		return undefined;
	}
	return {
		confirmationFromHelper:
			draft.confirmationFromHelper ||
			draft.input.state.observedBrowserEffects?.readConfirmation !== draft.readConfirmationEvent,
		readConfirmationEvent: finalHelperConfirmation,
		succeeded: false,
	};
}

function directConfirmationEffect(
	prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>,
	effects: NativeOutputPhase["confirmedEffects"],
	envelope: AgentBrowserEnvelope | undefined,
): Pick<NativeOutputPhase, "confirmedData" | "confirmedCommand" | "directClose"> {
	return {
		confirmedData: prepared.commandTokens[0] === "confirm" ? effects[0]?.data : undefined,
		confirmedCommand: prepared.commandTokens[0] === "confirm" ? effects[0]?.command : undefined,
		directClose:
			isCloseCommand(prepared.executionPlan.commandInfo.command) ||
			isSuccessfulNativeConfirmedClose(prepared.commandTokens, envelope?.data),
	};
}
