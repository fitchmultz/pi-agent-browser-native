import { getScreenshotCapture } from "../../orchestration/browser-run/screenshot-capture.js";
import { isRecord } from "../../parsing.js";
import type { FileArtifactMetadata } from "../artifact-contracts.js";
import type { ToolPresentation } from "../contracts.js";
import type { ToolPresentationObservation } from "./observation-contracts.js";
import {
	applyArtifactManifest,
	attachInlineImage,
	buildArtifactVerificationSummary,
	buildManifestEntriesForFileArtifacts,
	extractFileArtifacts,
	extractImagePath,
	isManifestFileArtifact,
} from "./artifacts.js";
import { getPresentationPaths } from "./content.js";
import type { BuildToolPresentationOptions } from "./input-contracts.js";
import { compactLargePresentationOutput } from "./large-output.js";
import type { PresentationSource } from "./source.js";

type OutputOptions = Pick<
	BuildToolPresentationOptions,
	| "artifactManifest"
	| "artifactRequest"
	| "commandInfo"
	| "cwd"
	| "modelVisible"
	| "persistentArtifactStore"
>;
type ArtifactExtractionOptions = Pick<
	BuildToolPresentationOptions,
	| "artifactManifest"
	| "artifactMaxUpdatedAtMs"
	| "artifactMinUpdatedAtMs"
	| "artifactRequest"
	| "cwd"
	| "envelope"
	| "namespace"
	| "recordingPending"
	| "previousRecordingContactSheetPath"
	| "sessionName"
>;

export async function extractPresentationArtifacts(
	options: ArtifactExtractionOptions,
	source: PresentationSource,
): Promise<readonly FileArtifactMetadata[]> {
	return extractFileArtifacts({
		artifactManifest: options.artifactManifest,
		artifactMaxUpdatedAtMs: options.artifactMaxUpdatedAtMs,
		artifactMinUpdatedAtMs: options.artifactMinUpdatedAtMs,
		artifactRequest: options.artifactRequest,
		commandInfo: source.presentationCommandInfo,
		cwd: options.cwd,
		data: source.data,
		namespace: options.namespace,
		recordingOutcome: source.recordingCommand ? options.envelope?.success : undefined,
		recordingPending: options.recordingPending,
		previousRecordingContactSheetPath: options.previousRecordingContactSheetPath,
		sessionName: options.sessionName,
	});
}

function getAttachableImage(
	options: OutputOptions,
	source: PresentationSource,
	artifacts: readonly FileArtifactMetadata[],
): string | undefined {
	const path = getImagePath(options, source, artifacts);
	if (
		path === undefined ||
		path.length === 0 ||
		(isRecord(source.data) && source.data.changed === false)
	) {
		return undefined;
	}
	return artifacts.some(
		(artifact) =>
			artifact.absolutePath === path &&
			["missing", "stale", "failed"].includes(artifact.status ?? ""),
	)
		? undefined
		: path;
}

function getImagePath(
	options: OutputOptions,
	source: PresentationSource,
	artifacts: readonly FileArtifactMetadata[],
): string | undefined {
	return (
		options.artifactRequest?.absolutePath ??
		extractImagePath(options.commandInfo, options.cwd, source.data) ??
		(source.recordingCommand
			? artifacts.find((artifact) => artifact.kind === "image" && artifact.status === "saved")
					?.absolutePath
			: undefined)
	);
}

async function attachPresentationImage(
	draft: ToolPresentationObservation,
	options: OutputOptions,
	source: PresentationSource,
	artifacts: readonly FileArtifactMetadata[],
): Promise<Partial<ToolPresentation>> {
	const imagePath = getAttachableImage(options, source, artifacts);
	const update: Partial<ToolPresentation> =
		imagePath === undefined ? {} : await attachInlineImage(draft, imagePath, options.modelVisible);
	const observations = update.imageObservations ?? draft.imageObservations;
	if (options.commandInfo.command === "screenshot" && observations) {
		const capture = getScreenshotCapture(source.commandInfo.commandTokens ?? []).kind;
		update.imageObservations = observations.map((image) => Object.assign({}, image, { capture }));
	}
	return update;
}

export async function completePresentationOutput(
	draft: ToolPresentationObservation,
	options: OutputOptions,
	source: PresentationSource,
	artifacts: readonly FileArtifactMetadata[],
): Promise<Partial<ToolPresentation>> {
	const update: Partial<ToolPresentation> = {};
	if (artifacts.length > 0 && !draft.artifacts) {
		update.artifacts = artifacts;
	}
	update.artifactVerification =
		draft.artifactVerification ?? buildArtifactVerificationSummary(artifacts);
	Object.assign(update, await attachPresentationImage(draft, options, source, artifacts));
	if (options.modelVisible !== false) {
		Object.assign(
			update,
			await compactLargePresentationOutput({
				artifactManifest: options.artifactManifest,
				commandInfo: options.commandInfo,
				data: source.presentationData,
				persistentArtifactStore: options.persistentArtifactStore,
				presentation: { ...draft, ...update },
			}),
		);
	}
	const compacted = { ...draft, ...update };
	const manifest = applyArtifactManifest(
		compacted,
		compacted.artifactManifest ?? options.artifactManifest,
		buildManifestEntriesForFileArtifacts(artifacts.filter(isManifestFileArtifact)),
	);
	Object.assign(update, manifest);
	const withManifest = { ...compacted, ...manifest };
	const currentSpillPaths = new Set(
		getPresentationPaths({
			primaryPath: withManifest.fullOutputPath,
			secondaryPaths: withManifest.fullOutputPaths,
		}),
	);
	update.artifactVerification =
		buildArtifactVerificationSummary(artifacts, withManifest.artifactManifest, currentSpillPaths) ??
		withManifest.artifactVerification;
	return update;
}
