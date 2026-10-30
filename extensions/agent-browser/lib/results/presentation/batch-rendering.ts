import type { BatchPresentedStepObservation } from "./observation-contracts.js";
import { getPresentationImages } from "./content.js";

interface TypingRun {
	readonly nextIndex: number;
	readonly typedCharCount: number;
	readonly delayMs?: string;
}

function getTypedTextLength(command: readonly string[] | undefined): number | undefined {
	return command?.[0] === "keyboard" && command[1] === "type" && typeof command.at(2) === "string"
		? Array.from(command[2]).length
		: undefined;
}

function getWaitDelayMs(command: readonly string[] | undefined): string | undefined {
	const delay = command?.at(1);
	return command?.[0] === "wait" && delay !== undefined && /^\d+$/.test(delay) ? delay : undefined;
}

function getTypingDelayBetween(
	steps: readonly BatchPresentedStepObservation[],
	index: number,
): string | undefined {
	const delay = steps.at(index + 1)?.details;
	const next = steps.at(index + 2)?.details;
	if (
		!delay ||
		!next ||
		!delay.success ||
		!next.success ||
		getTypedTextLength(next.command) === undefined
	) {
		return undefined;
	}
	return getWaitDelayMs(delay.command);
}

function getTypedPulse(
	steps: readonly BatchPresentedStepObservation[],
	index: number,
): { readonly chars: number; readonly delay?: string; readonly nextIndex: number } | undefined {
	const step = steps.at(index)?.details;
	if (!step || !step.success) {
		return undefined;
	}
	const chars = getTypedTextLength(step.command);
	if (chars === undefined) {
		return undefined;
	}
	const delay = getTypingDelayBetween(steps, index);
	return { chars, delay, nextIndex: index + (delay === undefined ? 1 : 2) };
}

function scanTypingRun(
	steps: readonly BatchPresentedStepObservation[],
	start: number,
): TypingRun | undefined {
	let index = start;
	let typedCharCount = 0;
	let typedStepCount = 0;
	let delayMs: string | undefined;
	while (index < steps.length) {
		const pulse = getTypedPulse(steps, index);
		if (!pulse) {
			break;
		}
		typedCharCount += pulse.chars;
		typedStepCount += 1;
		if (pulse.delay !== undefined) {
			if (delayMs !== undefined && delayMs !== pulse.delay) {
				return undefined;
			}
			delayMs = pulse.delay;
		}
		index = pulse.nextIndex;
	}
	return typedStepCount >= 2 ? { nextIndex: index, typedCharCount, delayMs } : undefined;
}

function getTypingStart(
	steps: readonly BatchPresentedStepObservation[],
	index: number,
):
	| { readonly firstIndex: number; readonly typingIndex: number; readonly target?: string }
	| undefined {
	if (steps.at(index)?.nativeIndex !== undefined) {
		return undefined;
	}
	const details = steps.at(index)?.details;
	if (!details || !details.success) {
		return undefined;
	}
	if (details.command?.[0] === "focus" && typeof details.command.at(1) === "string") {
		return { firstIndex: details.index, typingIndex: index + 1, target: details.command[1] };
	}
	return { firstIndex: details.index, typingIndex: index };
}

function getPressAfterTyping(
	steps: readonly BatchPresentedStepObservation[],
	index: number,
): string | undefined {
	const details = steps.at(index)?.details;
	if (!details || !details.success || details.command?.[0] !== "press") {
		return undefined;
	}
	return details.command.at(1);
}

function formatTypedSequenceSummary(
	steps: readonly BatchPresentedStepObservation[],
	startIndex: number,
): { readonly nextIndex: number; readonly text: string } | undefined {
	const start = getTypingStart(steps, startIndex);
	if (!start) {
		return undefined;
	}
	const run = scanTypingRun(steps, start.typingIndex);
	if (!run) {
		return undefined;
	}
	const pressedKey = getPressAfterTyping(steps, run.nextIndex);
	const nextIndex = run.nextIndex + (pressedKey !== undefined ? 1 : 0);
	const firstStep = start.firstIndex + 1;
	const lastIndex = steps.at(nextIndex - 1)?.details.index;
	const lastStep = lastIndex === undefined ? undefined : lastIndex + 1;
	const range =
		lastStep !== undefined && lastStep > firstStep ? `${firstStep}-${lastStep}` : String(firstStep);
	return { nextIndex, text: formatTypingSummaryText(range, start.target, run, pressedKey) };
}

function formatTypingSummaryText(
	range: string,
	target: string | undefined,
	run: Pick<TypingRun, "typedCharCount" | "delayMs">,
	pressedKey: string | undefined,
): string {
	const label = target !== undefined && target.length > 0 ? `type ${target}` : "keyboard type";
	const lines = [
		`Step ${range} — ${label} (succeeded)`,
		`Typed ${run.typedCharCount} char${run.typedCharCount === 1 ? "" : "s"}${run.delayMs !== undefined ? ` with delayMs=${run.delayMs}` : ""}.`,
	];
	if (pressedKey !== undefined && pressedKey.length > 0) {
		lines.push(`Pressed ${pressedKey}.`);
	}
	return lines.join("\n");
}

function formatBatchStepDetails(step: BatchPresentedStepObservation): string {
	const details = step.details;
	const images = getPresentationImages(step.presentation).length;
	const lines = [
		`Step ${details.index + 1} — ${details.commandText} (${details.success ? "succeeded" : "failed"})`,
	];
	if (details.text.length > 0) {
		lines.push(details.text);
	}
	if (images > 0) {
		lines.push(`(${images} inline image attachment${images === 1 ? "" : "s"} below)`);
	}
	return lines.join("\n");
}

export function formatBatchStepsText(steps: readonly BatchPresentedStepObservation[]): string {
	if (steps.length === 0) {
		return "(no batch steps)";
	}
	const lines: string[] = [];
	for (let index = 0; index < steps.length;) {
		const sequence = formatTypedSequenceSummary(steps, index);
		if (sequence) {
			lines.push(sequence.text);
			index = sequence.nextIndex;
			continue;
		}
		const step = steps.at(index);
		if (step) {
			lines.push(formatBatchStepDetails(step));
		}
		index += 1;
	}
	return lines.join("\n\n");
}
