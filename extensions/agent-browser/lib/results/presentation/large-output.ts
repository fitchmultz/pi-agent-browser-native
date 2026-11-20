import { extractUpstreamCommandTokens, type CommandInfo } from "../../argv-descriptor.js";
import { isRecord } from "../../parsing.js";
import {
	PersistentSessionArtifactWriteError,
	type PersistentSessionArtifactStore,
} from "../../temp.js";
import { buildEvictedSessionArtifactEntries } from "../artifact-manifest.js";
import type {
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
	ToolPresentation,
} from "../contracts.js";
import { countLines, stringifyUnknown, truncateText } from "../text.js";
import { applyArtifactManifest } from "./artifacts.js";
import { formatBatchMutationEvidenceText } from "./batch-summary.js";
import { getPresentationText, getReadContentPointer } from "./content.js";
import type {
	BatchStepPresentationObservation,
	ToolPresentationObservation,
} from "./observation-contracts.js";
import {
	buildSpillArtifactEntries,
	writeLargeOutputSpillFile,
	type LargeOutputSpillWriteResult,
} from "./output-spill.js";

export { OBSERVATION_INLINE_MAX_CHARS } from "./content.js";
export { renderAgentBrowserObservation } from "./observation-rendering.js";

const LARGE_OUTPUT_MAX_CHARS = 8_000;
const LARGE_OUTPUT_MAX_LINES = 120;
const PREVIEW_MAX_LINES = 40;
const PREVIEW_MAX_CHARS = 2_500;
const PREVIEW_LINE_MAX_CHARS = 240;
const PREVIEW_MIN_LINE_CHARS = 40;
const SUBSTANTIVE_BATCH_COMMANDS = new Set(["eval", "get", "errors", "console", "screenshot"]);

function shouldCompactLargeOutput(text: string): boolean {
	return text.length > LARGE_OUTPUT_MAX_CHARS || countLines(text) > LARGE_OUTPUT_MAX_LINES;
}

function buildLargeOutputPreview(text: string): {
	readonly omittedLineCount: number;
	readonly previewText: string;
} {
	const lines = text.split("\n");
	const previewLines: string[] = [];
	let previewChars = 0;
	for (const line of lines) {
		if (previewLines.length >= PREVIEW_MAX_LINES || previewChars >= PREVIEW_MAX_CHARS) {
			break;
		}
		const remainingChars = PREVIEW_MAX_CHARS - previewChars;
		const previewLine = truncateText(
			line,
			Math.min(Math.max(PREVIEW_MIN_LINE_CHARS, remainingChars), PREVIEW_LINE_MAX_CHARS),
		);
		previewLines.push(previewLine);
		previewChars += previewLine.length + 1;
	}
	return {
		omittedLineCount: Math.max(0, lines.length - previewLines.length),
		previewText: previewLines.join("\n"),
	};
}

function getBatchStepCommandName(step: BatchStepPresentationObservation): string | undefined {
	if (step.command && step.command.length > 0) {
		return extractUpstreamCommandTokens(step.command)[0];
	}
	return undefined;
}

function hasBatchStepArtifact(step: BatchStepPresentationObservation): boolean {
	return (
		step.imagePath !== undefined ||
		(step.imagePaths !== undefined && step.imagePaths.length > 0) ||
		step.savedFilePath !== undefined ||
		(step.artifacts !== undefined && step.artifacts.length > 0)
	);
}

function isSubstantiveBatchStep(step: BatchStepPresentationObservation): boolean {
	if (!step.success || hasBatchStepArtifact(step) || step.summary.startsWith("Eval result:")) {
		return true;
	}
	const command = getBatchStepCommandName(step);
	if (command !== undefined && SUBSTANTIVE_BATCH_COMMANDS.has(command)) {
		return true;
	}
	return isRecord(step.data) && Object.hasOwn(step.data, "result");
}

function formatBatchStepPreviewLines(step: BatchStepPresentationObservation): readonly string[] {
	const header = `Step ${step.index + 1} — ${step.commandText} (${step.success ? "succeeded" : "failed"})`;
	const body = step.text.length > 0 ? step.text : step.summary;
	return body.length > 0 ? [header, ...body.split("\n")] : [header];
}

interface PreviewBudget {
	readonly chars: number;
	readonly lines: readonly string[];
}

function appendPreviewSeparator(budget: PreviewBudget): PreviewBudget {
	if (
		budget.lines.length > 0 &&
		budget.lines.length + 1 < PREVIEW_MAX_LINES &&
		budget.chars + 1 < PREVIEW_MAX_CHARS
	) {
		return { chars: budget.chars + 1, lines: [...budget.lines, ""] };
	}
	return budget;
}

function appendBoundedStepLines(
	budget: PreviewBudget,
	stepLines: readonly string[],
	maxLines: number,
	maxChars: number,
): PreviewBudget {
	const lines = [...budget.lines];
	let chars = budget.chars;
	let addedLines = 0;
	let addedChars = 0;
	for (const line of stepLines) {
		if (
			lines.length >= PREVIEW_MAX_LINES ||
			chars >= PREVIEW_MAX_CHARS ||
			addedLines >= maxLines ||
			addedChars >= maxChars
		) {
			break;
		}
		const remainingBudget = Math.min(PREVIEW_MAX_CHARS - chars, maxChars - addedChars);
		const previewLine = truncateText(
			line,
			Math.min(Math.max(PREVIEW_MIN_LINE_CHARS, remainingBudget), PREVIEW_LINE_MAX_CHARS),
		);
		lines.push(previewLine);
		const lineCost = previewLine.length + 1;
		chars += lineCost;
		addedLines += 1;
		addedChars += lineCost;
	}
	return { chars, lines };
}

function appendBatchPreviewGroup(
	initial: PreviewBudget,
	steps: readonly BatchStepPresentationObservation[],
	fairShare: boolean,
): PreviewBudget {
	let current = initial;
	for (const [offset, step] of steps.entries()) {
		const remainingLines = PREVIEW_MAX_LINES - current.lines.length;
		const remainingChars = PREVIEW_MAX_CHARS - current.chars;
		if (remainingLines <= 0 || remainingChars <= 0) {
			break;
		}
		current = appendPreviewSeparator(current);
		const remainingSteps = steps.length - offset;
		const maxLines = fairShare
			? Math.max(2, Math.floor((PREVIEW_MAX_LINES - current.lines.length) / remainingSteps))
			: PREVIEW_MAX_LINES - current.lines.length;
		const maxChars = fairShare
			? Math.max(
					PREVIEW_MIN_LINE_CHARS * 3,
					Math.floor((PREVIEW_MAX_CHARS - current.chars) / remainingSteps),
				)
			: PREVIEW_MAX_CHARS - current.chars;
		current = appendBoundedStepLines(
			current,
			formatBatchStepPreviewLines(step),
			maxLines,
			maxChars,
		);
	}
	return current;
}

function buildBatchLargeOutputPreview(
	text: string,
	batchSteps: readonly BatchStepPresentationObservation[],
): {
	readonly omittedLineCount: number;
	readonly previewText: string;
} {
	const substantiveSteps = batchSteps.filter(isSubstantiveBatchStep);
	if (substantiveSteps.length === 0) {
		return buildLargeOutputPreview(text);
	}
	const mutationEvidenceText = formatBatchMutationEvidenceText(batchSteps);
	const initialBudget: PreviewBudget =
		mutationEvidenceText !== undefined
			? appendBoundedStepLines(
					{ chars: 0, lines: [] },
					[mutationEvidenceText],
					1,
					PREVIEW_LINE_MAX_CHARS,
				)
			: { chars: 0, lines: [] };
	const routineSteps = batchSteps.filter((step) => !isSubstantiveBatchStep(step));
	const afterSubstantive = appendBatchPreviewGroup(initialBudget, substantiveSteps, true);
	const finalBudget = appendBatchPreviewGroup(afterSubstantive, routineSteps, false);
	return {
		omittedLineCount: Math.max(0, countLines(text) - finalBudget.lines.length),
		previewText: finalBudget.lines.join("\n"),
	};
}

function buildLargeOutputFailureContext(
	presentation: ToolPresentationObservation,
): readonly string[] {
	const failure = presentation.batchFailure;
	if (!failure) {
		return [];
	}
	const failedStep = failure.failedStep;
	const commandText = truncateText(failedStep.commandText, 240);
	const lines = [
		"Failure context:",
		`- First failing step: ${failedStep.index + 1} — ${commandText}`,
		`- Batch result: ${failure.successCount}/${failure.totalCount} succeeded${failure.failureCount > 1 ? `; ${failure.failureCount} failed` : ""}`,
	];
	if (failedStep.failureCategory !== undefined) {
		lines.push(`- Failure category: ${failedStep.failureCategory}`);
	}
	const failureText = (failedStep.text.length > 0 ? failedStep.text : failedStep.summary)
		.replace(/\s+/g, " ")
		.trim();
	if (failureText.length > 0) {
		lines.push(`- Failure detail: ${truncateText(failureText, 700)}`);
	}
	const stepPaths = [failedStep.fullOutputPath, ...(failedStep.fullOutputPaths ?? [])].filter(
		(path, index, paths): path is string =>
			typeof path === "string" && path.length > 0 && paths.indexOf(path) === index,
	);
	if (stepPaths.length > 0) {
		lines.push(
			`- Failed-step spill path${stepPaths.length === 1 ? "" : "s"}: ${stepPaths.join(", ")}`,
		);
	}
	return lines;
}

interface PresentationSpill {
	readonly spill?: LargeOutputSpillWriteResult;
	readonly contentPointer?: ReturnType<typeof getReadContentPointer>;
	readonly error?: string;
	readonly evictionEntries?: readonly SessionArtifactManifestEntry[];
}

async function tryWritePresentationSpill(options: {
	readonly command: string | undefined;
	readonly data: unknown;
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore> | undefined;
	readonly text: string;
}): Promise<PresentationSpill> {
	try {
		const spill = await writeLargeOutputSpillFile(options);
		return { spill, contentPointer: getReadContentPointer(options.command, options.data) };
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : stringifyUnknown(error),
			evictionEntries: buildEvictedSessionArtifactEntries(
				error instanceof PersistentSessionArtifactWriteError ? error.evictedArtifacts : [],
				Date.now(),
			),
		};
	}
}

function buildCompactedText(
	command: string | undefined,
	text: string,
	presentation: ToolPresentationObservation,
	persisted: PresentationSpill,
): {
	readonly compactedText: string;
	readonly previewText: string;
} {
	const { omittedLineCount, previewText } =
		command === "batch" &&
		presentation.batchSteps !== undefined &&
		presentation.batchSteps.length > 0
			? buildBatchLargeOutputPreview(text, presentation.batchSteps)
			: buildLargeOutputPreview(text);
	const failureContext = buildLargeOutputFailureContext(presentation);
	const lines = [
		`Large ${command ?? "agent-browser"} output compacted.`,
		...(failureContext.length > 0 ? ["", ...failureContext] : []),
		"",
		"Preview:",
		previewText,
	];
	if (omittedLineCount > 0) {
		lines.push(`- ... (${omittedLineCount} additional lines omitted)`);
	}
	lines.push(
		"",
		persisted.spill
			? `Full output path: ${persisted.spill.path}`
			: `Full output unavailable: ${persisted.error ?? "spill file could not be created."}`,
	);
	if (persisted.contentPointer !== undefined) {
		lines.push(`Read the document at JSON Pointer ${persisted.contentPointer} in that file.`);
	}
	return { compactedText: lines.join("\n"), previewText };
}

function applyCompactedPresentation(
	draft: ToolPresentationObservation,
	text: string,
	rendered: { readonly compactedText: string; readonly previewText: string },
	persisted: PresentationSpill,
): Pick<ToolPresentation, "content" | "data" | "fullOutputPath" | "summary"> {
	const firstTextIndex = draft.content.findIndex((part) => part.type === "text");
	const content: ToolPresentation["content"] =
		firstTextIndex >= 0
			? [
					...draft.content.slice(0, firstTextIndex),
					{ type: "text", text: rendered.compactedText },
					...draft.content.slice(firstTextIndex + 1),
				]
			: [{ type: "text", text: rendered.compactedText }, ...draft.content];
	return {
		content,
		data: {
			compacted: true,
			fullOutputPath: persisted.spill?.path,
			...(persisted.contentPointer === undefined
				? {}
				: { contentPointer: persisted.contentPointer }),
			outputCharCount: text.length,
			outputLineCount: countLines(text),
			previewCharCount: rendered.previewText.length,
			previewLineCount: countLines(rendered.previewText),
			spillError: persisted.error,
		},
		fullOutputPath: persisted.spill?.path,
		summary: `${draft.summary} (compact)`,
	};
}

export async function compactLargePresentationOutput(options: {
	readonly artifactManifest?: SessionArtifactManifest | undefined;
	readonly commandInfo: CommandInfo;
	readonly data: unknown;
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore> | undefined;
	readonly presentation: ToolPresentationObservation;
}): Promise<Partial<ToolPresentation>> {
	const text = getPresentationText(options.presentation);
	if (text.length === 0 || !shouldCompactLargeOutput(text)) {
		return {};
	}
	const persisted = await tryWritePresentationSpill({
		command: options.commandInfo.command,
		data: options.data,
		persistentArtifactStore: options.persistentArtifactStore,
		text,
	});
	const rendered = buildCompactedText(
		options.commandInfo.command,
		text,
		options.presentation,
		persisted,
	);
	const update = applyCompactedPresentation(options.presentation, text, rendered, persisted);
	return {
		...update,
		...applyArtifactManifest(
			{ ...options.presentation, ...update },
			options.presentation.artifactManifest ?? options.artifactManifest,
			persisted.spill
				? buildSpillArtifactEntries({ ...persisted.spill, commandInfo: options.commandInfo })
				: (persisted.evictionEntries ?? []),
		),
	};
}
