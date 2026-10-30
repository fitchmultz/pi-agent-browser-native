import type { JsonValue } from "@earendil-works/pi-ai";
import { isRecord } from "../../parsing.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import { isSessionArtifactManifest } from "../artifact-manifest-validation.js";
import type {
	ProjectedAgentBrowserObservation,
	SessionArtifactManifest,
	ToolPresentation,
} from "../contracts.js";
import { stringifyUnknown, truncateText } from "../text.js";
import { applyArtifactManifest } from "./artifacts.js";
import { redactModelFacingText } from "./common.js";
import { OBSERVATION_INLINE_MAX_CHARS, projectAgentBrowserObservation } from "./content.js";
import type { ToolPresentationObservation } from "./observation-contracts.js";
import {
	buildSpillArtifactEntries,
	writeLargeOutputSpillFile,
	type LargeOutputSpillWriteResult,
} from "./output-spill.js";

interface RenderObservationOptions {
	readonly content: ToolPresentationObservation["content"];
	readonly details: Readonly<Record<string, unknown>>;
	readonly json: boolean;
	readonly succeeded: boolean;
	/** Keep exact caller text; bound structured output and spill the complete observation. */
	readonly preserveContent?: boolean;
	readonly persistentArtifactStore?: Readonly<PersistentSessionArtifactStore>;
	readonly withArtifactWrite?: <T>(write: () => Promise<T>) => Promise<T>;
}

interface ObservationSpill {
	readonly spill?: LargeOutputSpillWriteResult;
	readonly error?: string;
	readonly manifest?: SessionArtifactManifest;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function toJsonValue(value: unknown): JsonValue {
	const parsed: unknown = JSON.parse(JSON.stringify(value));
	if (!isJsonValue(parsed)) {
		throw new Error("Serialized browser observation must be JSON.");
	}
	return parsed;
}

function getCompactSummary(observation: ProjectedAgentBrowserObservation): string | undefined {
	if (typeof observation.summary === "string") {
		return truncateText(observation.summary, 700);
	}
	return typeof observation.error === "string" ? truncateText(observation.error, 700) : undefined;
}

function buildCompactObservation(
	observation: ProjectedAgentBrowserObservation,
	persisted: ObservationSpill,
): Record<string, unknown> {
	const compact: Record<string, unknown> = {
		success: observation.success,
		resultCategory: observation.resultCategory,
		failureCategory: observation.failureCategory,
		successCategory: observation.successCategory,
		summary: getCompactSummary(observation),
		compacted: true,
		...(persisted.spill
			? {
					observationPath: persisted.spill.path,
					retrieve:
						"Read observationPath for the complete redacted observation, including exact recovery actions and requested data.",
				}
			: {
					observationUnavailable: truncateText(
						redactModelFacingText(
							persisted.error ?? "Spill could not be written; request a smaller result.",
						),
						1_000,
					),
				}),
	};
	for (const key of [
		"sessionName",
		"namespace",
		"codeRun",
		// A requested outputPath receipt is small and confirms the caller's side effect; keep it ahead of bulky fields.
		"outputFile",
		"error",
		"failures",
		"nextActions",
		"artifactVerification",
		"imageObservations",
		"data",
		"fullOutputPath",
		"fullOutputPaths",
	]) {
		if (
			observation[key] !== undefined &&
			JSON.stringify({ ...compact, [key]: observation[key] }, null, 2).length <=
				OBSERVATION_INLINE_MAX_CHARS - 500
		) {
			compact[key] = observation[key];
		}
	}
	return compact;
}

async function persistObservation(
	options: RenderObservationOptions,
	observation: ProjectedAgentBrowserObservation,
	prose: string,
	text: string,
): Promise<ObservationSpill> {
	const manifest = isSessionArtifactManifest(options.details.artifactManifest)
		? options.details.artifactManifest
		: undefined;
	try {
		const write = () =>
			writeLargeOutputSpillFile({
				data: { ...observation, ...(!options.json ? { text: prose } : {}) },
				persistentArtifactStore: options.persistentArtifactStore,
				text,
			});
		const spill = await (options.withArtifactWrite ? options.withArtifactWrite(write) : write());
		return {
			spill,
			manifest: applyArtifactManifest(
				{ content: [], summary: "" },
				manifest,
				buildSpillArtifactEntries({
					...spill,
					commandInfo: {
						command:
							typeof options.details.command === "string" ? options.details.command : undefined,
					},
				}),
			).artifactManifest,
		};
	} catch (error) {
		return { manifest, error: error instanceof Error ? error.message : stringifyUnknown(error) };
	}
}

/** Bound final model-visible output after recovery assembly; never truncate executable actions. */
export async function renderAgentBrowserObservation(options: RenderObservationOptions): Promise<{
	content: ToolPresentation["content"];
	artifactManifest?: SessionArtifactManifest;
	structuredContent: JsonValue;
}> {
	const observation = projectAgentBrowserObservation(options.details, options.succeeded);
	let structuredContent: Readonly<Record<string, unknown>> = observation;
	const images = options.content.filter((part) => part.type === "image");
	const prose = options.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n\n");
	const { data: _data, error: _error, summary: _summary, ...metadata } = observation;
	let text = options.json
		? JSON.stringify(observation, null, 2)
		: `${prose}\n\nObservation: ${JSON.stringify(metadata)}`;
	let manifest = isSessionArtifactManifest(options.details.artifactManifest)
		? options.details.artifactManifest
		: undefined;
	if (
		text.length > OBSERVATION_INLINE_MAX_CHARS ||
		JSON.stringify(observation).length > OBSERVATION_INLINE_MAX_CHARS
	) {
		const persisted = await persistObservation(options, observation, prose, text);
		manifest = persisted.manifest;
		structuredContent = buildCompactObservation(observation, persisted);
		text = options.preserveContent === true ? prose : JSON.stringify(structuredContent, null, 2);
		if (options.preserveContent !== true && !options.json) {
			text = `Browser observation compacted.\n${text}`;
		}
	}
	return {
		content: [{ type: "text", text }, ...images],
		artifactManifest: manifest,
		structuredContent: toJsonValue(structuredContent),
	};
}
