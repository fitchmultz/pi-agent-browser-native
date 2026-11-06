import type { CommandInfo } from "../../argv-descriptor.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import type { SessionArtifactManifest, ToolPresentation } from "../contracts.js";
import { countLines, stringifyUnknown, truncateText } from "../text.js";
import { applyArtifactManifest } from "./artifacts.js";
import { getPresentationText } from "./content.js";
import type { ToolPresentationObservation } from "./observation-contracts.js";
import {
	buildSpillArtifactEntries,
	writeLargeOutputSpillFile,
	type LargeOutputSpillWriteResult,
} from "./output-spill.js";

export { OBSERVATION_INLINE_MAX_CHARS } from "./content.js";
export { renderAgentBrowserObservation } from "./observation-rendering.js";

function shouldCompactLargeOutput(text: string): boolean {
	return text.length > 8_000 || countLines(text) > 120;
}

function buildLargeOutputPreview(text: string): {
	readonly omittedLineCount: number;
	readonly previewText: string;
} {
	const lines = text.split("\n");
	const previewLines: string[] = [];
	let previewChars = 0;
	for (const line of lines) {
		if (previewLines.length >= 40 || previewChars >= 2_500) {
			break;
		}
		const remainingChars = 2_500 - previewChars;
		const previewLine = truncateText(line, Math.min(Math.max(40, remainingChars), 240));
		previewLines.push(previewLine);
		previewChars += previewLine.length + 1;
	}
	return {
		omittedLineCount: Math.max(0, lines.length - previewLines.length),
		previewText: previewLines.join("\n"),
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
	readonly error?: string;
}

async function tryWritePresentationSpill(options: {
	readonly data: unknown;
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore> | undefined;
	readonly text: string;
}): Promise<PresentationSpill> {
	try {
		return { spill: await writeLargeOutputSpillFile(options) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : stringifyUnknown(error) };
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
	const { omittedLineCount, previewText } = buildLargeOutputPreview(text);
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
	return persisted.spill
		? {
				...update,
				...applyArtifactManifest(
					{ ...options.presentation, ...update },
					options.presentation.artifactManifest ?? options.artifactManifest,
					buildSpillArtifactEntries({ ...persisted.spill, commandInfo: options.commandInfo }),
				),
			}
		: update;
}
