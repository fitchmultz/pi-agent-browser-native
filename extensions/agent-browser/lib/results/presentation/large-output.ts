import type { CommandInfo } from "../../runtime.js";
import {
	type PersistentSessionArtifactEviction,
	type PersistentSessionArtifactStore,
	writePersistentSessionArtifactFile,
	writeSecureTempFile,
} from "../../temp.js";
import { buildEvictedSessionArtifactEntries } from "../artifact-manifest.js";
import type { ArtifactStorageScope, SessionArtifactManifest, SessionArtifactManifestEntry, ToolPresentation } from "../contracts.js";
import { countLines, truncateText } from "../text.js";
import { applyArtifactManifest } from "./artifacts.js";
import { getPresentationText, projectAgentBrowserObservation } from "./content.js";
import { redactModelFacingText, stringifyModelFacing } from "./common.js";

const LARGE_OUTPUT_INLINE_MAX_CHARS = 8_000;

const LARGE_OUTPUT_INLINE_MAX_LINES = 120;

const LARGE_OUTPUT_PREVIEW_MAX_CHARS = 2_500;

const LARGE_OUTPUT_PREVIEW_MAX_LINES = 40;

const LARGE_OUTPUT_PREVIEW_MAX_LINE_CHARS = 240;

const LARGE_OUTPUT_FAILURE_COMMAND_MAX_CHARS = 240;

const LARGE_OUTPUT_FILE_PREFIX = "pi-agent-browser-output";

function shouldCompactLargeOutput(text: string): boolean {
	return text.length > LARGE_OUTPUT_INLINE_MAX_CHARS || countLines(text) > LARGE_OUTPUT_INLINE_MAX_LINES;
}

function buildLargeOutputPreview(text: string): { omittedLineCount: number; previewText: string } {
	const lines = text.split("\n");
	const previewLines: string[] = [];
	let previewChars = 0;
	for (const line of lines) {
		if (previewLines.length >= LARGE_OUTPUT_PREVIEW_MAX_LINES || previewChars >= LARGE_OUTPUT_PREVIEW_MAX_CHARS) {
			break;
		}
		const remainingChars = LARGE_OUTPUT_PREVIEW_MAX_CHARS - previewChars;
		const previewLine = truncateText(line, Math.min(Math.max(40, remainingChars), LARGE_OUTPUT_PREVIEW_MAX_LINE_CHARS));
		previewLines.push(previewLine);
		previewChars += previewLine.length + 1;
	}
	return {
		omittedLineCount: Math.max(0, lines.length - previewLines.length),
		previewText: previewLines.join("\n"),
	};
}

function buildLargeOutputFailureContext(presentation: ToolPresentation): string[] {
	const failure = presentation.batchFailure;
	if (!failure) return [];
	const failedStep = failure.failedStep;
	const commandText = truncateText(failedStep.commandText, LARGE_OUTPUT_FAILURE_COMMAND_MAX_CHARS);
	const lines = [
		"Failure context:",
		`- First failing step: ${failedStep.index + 1} — ${commandText}`,
		`- Batch result: ${failure.successCount}/${failure.totalCount} succeeded${failure.failureCount > 1 ? `; ${failure.failureCount} failed` : ""}`,
	];
	if (failedStep.failureCategory) lines.push(`- Failure category: ${failedStep.failureCategory}`);
	const failureText = (failedStep.text || failedStep.summary).replace(/\s+/g, " ").trim();
	if (failureText) lines.push(`- Failure detail: ${truncateText(failureText, 700)}`);
	const stepPaths = [failedStep.fullOutputPath, ...(failedStep.fullOutputPaths ?? [])].filter((path, index, paths): path is string => typeof path === "string" && path.length > 0 && paths.indexOf(path) === index);
	if (stepPaths.length > 0) lines.push(`- Failed-step spill path${stepPaths.length === 1 ? "" : "s"}: ${stepPaths.join(", ")}`);
	return lines;
}

interface LargeOutputSpillWriteResult {
	evictedArtifacts: PersistentSessionArtifactEviction[];
	path: string;
	storageScope: ArtifactStorageScope;
}

async function writeLargeOutputSpillFile(options: {
	data: unknown;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	text: string;
}): Promise<LargeOutputSpillWriteResult> {
	const payload =
		typeof options.data === "string"
			? redactModelFacingText(options.data)
			: typeof options.data === "number" || typeof options.data === "boolean"
				? String(options.data)
				: options.data === undefined
					? redactModelFacingText(options.text)
					: stringifyModelFacing(options.data);
	const isStructuredPayload = typeof options.data !== "string" && typeof options.data !== "number" && typeof options.data !== "boolean";
	const fileOptions = {
		content: payload,
		prefix: LARGE_OUTPUT_FILE_PREFIX,
		suffix: isStructuredPayload ? ".json" : ".txt",
	};
	if (options.persistentArtifactStore) {
		const result = await writePersistentSessionArtifactFile({ ...fileOptions, store: options.persistentArtifactStore });
		return { ...result, storageScope: "persistent-session" };
	}
	return { evictedArtifacts: [], path: await writeSecureTempFile(fileOptions), storageScope: "process-temp" };
}

function buildSpillArtifactEntries(options: {
	commandInfo: CommandInfo;
	evictedArtifacts: PersistentSessionArtifactEviction[];
	path: string;
	storageScope: ArtifactStorageScope;
}): SessionArtifactManifestEntry[] {
	const nowMs = Date.now();
	return [
		{
			command: options.commandInfo.command,
			createdAtMs: nowMs,
			kind: "spill",
			path: options.path,
			retentionState: options.storageScope === "persistent-session" ? "live" : "ephemeral",
			storageScope: options.storageScope,
			subcommand: options.commandInfo.subcommand,
		},
		...buildEvictedSessionArtifactEntries(options.evictedArtifacts, nowMs),
	];
}

export const OBSERVATION_INLINE_MAX_CHARS = 16_000;

/** Bound the final model-visible result, after recovery/diagnostic assembly. Never truncate executable actions. */
export async function renderAgentBrowserObservation(options: {
	content: ToolPresentation["content"];
	details: Record<string, unknown>;
	json: boolean;
	succeeded: boolean;
	persistentArtifactStore?: PersistentSessionArtifactStore;
}): Promise<{ content: ToolPresentation["content"]; artifactManifest?: SessionArtifactManifest }> {
	const observation = projectAgentBrowserObservation(options.details, options.succeeded);
	const images = options.content.filter(part => part.type === "image");
	const prose = options.content.filter(part => part.type === "text").map(part => part.text).join("\n\n");
	const { data: _data, error: _error, summary: _summary, ...metadata } = observation;
	let text = options.json ? JSON.stringify(observation, null, 2) : `${prose}\n\nObservation: ${JSON.stringify(metadata)}`;
	let artifactManifest = options.details.artifactManifest as SessionArtifactManifest | undefined;
	if (text.length > OBSERVATION_INLINE_MAX_CHARS) {
		let spill: LargeOutputSpillWriteResult | undefined;
		let spillError: string | undefined;
		try {
			spill = await writeLargeOutputSpillFile({ data: { ...observation, ...(!options.json ? { text: prose } : {}) }, persistentArtifactStore: options.persistentArtifactStore, text });
			artifactManifest = applyArtifactManifest({ content: [], summary: "" }, artifactManifest, buildSpillArtifactEntries({
				commandInfo: { command: typeof options.details.command === "string" ? options.details.command : undefined },
				evictedArtifacts: spill.evictedArtifacts, path: spill.path, storageScope: spill.storageScope,
			})).artifactManifest;
		} catch (error) {
			spillError = error instanceof Error ? error.message : String(error);
		}
		const compact: Record<string, unknown> = {
			success: options.succeeded, resultCategory: observation.resultCategory,
			failureCategory: observation.failureCategory, successCategory: observation.successCategory,
			summary: typeof observation.summary === "string" ? truncateText(observation.summary, 700) : undefined,
			compacted: true,
			...(spill ? { observationPath: spill.path, retrieve: "Read observationPath for the complete redacted observation, including exact recovery actions and requested data." }
				: { observationUnavailable: truncateText(redactModelFacingText(spillError ?? "Spill could not be written; request a smaller result."), 1_000) }),
		};
		for (const key of ["sessionName", "namespace", "codeRun", "error", "failures", "nextActions", "artifactVerification", "imageObservations", "data", "fullOutputPath", "fullOutputPaths"]) {
			if (observation[key] !== undefined && JSON.stringify({ ...compact, [key]: observation[key] }, null, 2).length <= OBSERVATION_INLINE_MAX_CHARS - 500) compact[key] = observation[key];
		}
		text = JSON.stringify(compact, null, 2);
		if (!options.json) text = `Browser observation compacted.\n${text}`;
	}
	return { content: [{ type: "text", text }, ...images], artifactManifest };
}

export async function compactLargePresentationOutput(options: {
	artifactManifest?: SessionArtifactManifest;
	commandInfo: CommandInfo;
	data: unknown;
	persistentArtifactStore?: PersistentSessionArtifactStore;
	presentation: ToolPresentation;
}): Promise<ToolPresentation> {
	const text = getPresentationText(options.presentation);
	if (text.length === 0 || !shouldCompactLargeOutput(text)) {
		return options.presentation;
	}

	let fullOutputPath: string | undefined;
	let spill: LargeOutputSpillWriteResult | undefined;
	let spillErrorText: string | undefined;
	try {
		spill = await writeLargeOutputSpillFile({
			data: options.data,
			persistentArtifactStore: options.persistentArtifactStore,
			text,
		});
		fullOutputPath = spill.path;
	} catch (error) {
		spillErrorText = error instanceof Error ? error.message : String(error);
	}

	const { omittedLineCount, previewText } = buildLargeOutputPreview(text);
	const commandLabel = options.commandInfo.command ?? "agent-browser";
	const failureContext = buildLargeOutputFailureContext(options.presentation);
	const lines = [
		`Large ${commandLabel} output compacted.`,
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
		fullOutputPath
			? `Full output path: ${fullOutputPath}`
			: `Full output unavailable: ${spillErrorText ?? "spill file could not be created."}`,
	);

	const firstTextIndex = options.presentation.content.findIndex((part) => part.type === "text");
	const compactedText = lines.join("\n");
	if (firstTextIndex >= 0) {
		options.presentation.content[firstTextIndex] = { type: "text", text: compactedText };
	} else {
		options.presentation.content.unshift({ type: "text", text: compactedText });
	}
	options.presentation.data = {
		compacted: true,
		fullOutputPath,
		outputCharCount: text.length,
		outputLineCount: countLines(text),
		previewCharCount: previewText.length,
		previewLineCount: countLines(previewText),
		spillError: spillErrorText,
	};
	options.presentation.fullOutputPath = fullOutputPath;
	options.presentation.summary = `${options.presentation.summary} (compact)`;
	if (fullOutputPath && spill) {
		return applyArtifactManifest(
			options.presentation,
			options.presentation.artifactManifest ?? options.artifactManifest,
			buildSpillArtifactEntries({
				commandInfo: options.commandInfo,
				evictedArtifacts: spill.evictedArtifacts,
				path: fullOutputPath,
				storageScope: spill.storageScope,
			}),
		);
	}
	return options.presentation;
}
