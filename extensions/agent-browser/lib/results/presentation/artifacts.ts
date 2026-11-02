import { isRecord } from "../../parsing.js";
import {
	formatSessionArtifactRetentionSummary,
	getSessionArtifactManifestEntryKey,
	isPendingRecordingArtifact,
	mergeSessionArtifactManifest,
} from "../artifact-manifest.js";
import { getRecordingReceipt } from "../recording.js";
import type { RecordingReceipt } from "../evidence-contracts.js";
import type {
	FileArtifactMetadata,
	SavedFilePresentationDetails,
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
	ToolPresentation,
} from "../contracts.js";
import {
	type ArtifactCommand,
	type ArtifactExtractionOptions,
	buildFileArtifactMetadata,
	buildPreviousRestartRecordingArtifact,
	extractPathStrings,
	isDownloadWaitSubcommand,
	isNonFileArtifactPathCandidate,
} from "./artifact-files.js";
import { appendPresentationNotice } from "./artifact-images.js";

export type { ArtifactRequestContext } from "../artifact-contracts.js";
export { attachInlineImage, extractImagePath, getScreenshotSummary } from "./artifact-images.js";
export { formatArtifactMetadataLines, formatArtifactSummary } from "./artifact-format.js";
export {
	buildArtifactVerificationSummary,
	classifyPresentationSuccessCategory,
	formatMissingArtifactFailureText,
	hasMissingFileArtifact,
} from "./artifact-verification.js";

function noticeWorthy(entry: SessionArtifactManifestEntry): boolean {
	return entry.retentionState === "evicted" || entry.storageScope !== "explicit-path";
}

export function manifestHasNewNoticeWorthyEntries(
	base: SessionArtifactManifest | undefined,
	current: SessionArtifactManifest | undefined,
): boolean {
	if (!current) {
		return false;
	}
	const baseKeys = new Set((base?.entries ?? []).map(getSessionArtifactManifestEntryKey));
	return current.entries.some(
		(entry) => !baseKeys.has(getSessionArtifactManifestEntryKey(entry)) && noticeWorthy(entry),
	);
}

export function applyArtifactManifest(
	presentation: ToolPresentation,
	baseManifest: SessionArtifactManifest | undefined,
	entries: readonly SessionArtifactManifestEntry[],
): ToolPresentation {
	if (entries.length === 0) {
		return presentation;
	}
	const artifactManifest = mergeSessionArtifactManifest({
		base: baseManifest,
		entries: [...entries],
	});
	if (!artifactManifest) {
		return presentation;
	}
	presentation.artifactManifest = artifactManifest;
	presentation.artifactRetentionSummary = formatSessionArtifactRetentionSummary(artifactManifest);
	if (entries.some(noticeWorthy)) {
		appendPresentationNotice(presentation, presentation.artifactRetentionSummary);
	}
	return presentation;
}

function getRecordingPending(
	options: ArtifactExtractionOptions,
	recording: RecordingReceipt | undefined,
): boolean | undefined {
	return (
		options.recordingPending ??
		(recording?.success === null &&
			isRecord(options.data) &&
			isRecord(options.data.capture) &&
			recording.capture.endedAt === null)
	);
}

async function extractContactSheet(
	options: ArtifactExtractionOptions,
	recordingPending: boolean | undefined,
): Promise<FileArtifactMetadata | undefined> {
	if (options.commandInfo.command !== "record" || !isRecord(options.data)) {
		return undefined;
	}
	const path = options.data.contactSheetPath;
	if (
		typeof path !== "string" ||
		path.trim().length === 0 ||
		isNonFileArtifactPathCandidate(path)
	) {
		return undefined;
	}
	const sheet = await buildFileArtifactMetadata({
		...options,
		artifactRequest: undefined,
		kind: "image",
		path,
		recordingPending:
			recordingPending === true ||
			["start", "restart"].includes(options.commandInfo.subcommand ?? ""),
	});
	return sheet ? { ...sheet, requestedPath: undefined } : undefined;
}

async function extractPreviousContactSheet(
	options: ArtifactExtractionOptions,
): Promise<FileArtifactMetadata | undefined> {
	if (
		options.commandInfo.command !== "record" ||
		options.commandInfo.subcommand !== "restart" ||
		options.recordingOutcome !== true
	) {
		return undefined;
	}
	const path = options.previousRecordingContactSheetPath;
	if (path === undefined || path.length === 0) {
		return undefined;
	}
	const sheet = await buildFileArtifactMetadata({
		...options,
		artifactRequest: undefined,
		commandInfo: { command: "record", subcommand: "restart-previous" },
		kind: "image",
		path,
		recordingPending: false,
	});
	// Native restart omits the previous sheet's terminal receipt. Disk presence isn't finalization proof.
	return sheet
		? { ...sheet, status: sheet.status === "saved" ? "unverified" : sheet.status }
		: undefined;
}

export async function extractFileArtifacts(
	options: ArtifactExtractionOptions,
): Promise<FileArtifactMetadata[]> {
	if (
		options.commandInfo.command === "screenshot" &&
		isRecord(options.data) &&
		options.data.changed === false
	) {
		return [];
	}
	const recording =
		options.commandInfo.command === "record"
			? getRecordingReceipt(
					options.data,
					options.commandInfo.subcommand === "stop" ? options.recordingOutcome : undefined,
				)
			: undefined;
	const recordingPending = getRecordingPending(options, recording);
	const [currentArtifacts, sheet, previousSheet, previous] = await Promise.all([
		Promise.all(
			extractPathStrings(options.data).map((path) =>
				buildFileArtifactMetadata({ ...options, path, recording, recordingPending }),
			),
		),
		extractContactSheet(options, recordingPending),
		extractPreviousContactSheet(options),
		buildPreviousRestartRecordingArtifact(options),
	]);
	const current = currentArtifacts.filter(
		(artifact): artifact is FileArtifactMetadata => artifact !== undefined,
	);
	if (sheet) {
		current.push(sheet);
	}
	if (previousSheet) {
		current.unshift(previousSheet);
	}
	return previous ? [previous, ...current] : current;
}

export function buildManifestEntriesForFileArtifacts(
	artifacts: readonly FileArtifactMetadata[],
	nowMs = Date.now(),
): SessionArtifactManifestEntry[] {
	return artifacts.map((artifact) => ({
		absolutePath: artifact.absolutePath,
		command: artifact.command,
		createdAtMs: nowMs,
		cwd: artifact.cwd,
		exists: artifact.exists,
		extension: artifact.extension,
		kind: artifact.kind,
		mediaType: artifact.mediaType,
		namespace: artifact.namespace,
		path: artifact.path,
		recording: artifact.recording,
		recordingStartedAtMs: artifact.recordingStartedAtMs,
		recordingState: artifact.recordingState,
		status: artifact.status,
		requestedPath: artifact.requestedPath,
		retentionState: artifact.exists === false || artifact.status === "stale" ? "missing" : "live",
		session: artifact.session,
		sizeBytes: artifact.sizeBytes,
		storageScope: "explicit-path",
		subcommand: artifact.subcommand,
	}));
}

export function isManifestFileArtifact(artifact: FileArtifactMetadata): boolean {
	return artifact.kind === "video" && artifact.command === "record"
		? true
		: artifact.status !== "stale" && !isPendingRecordingArtifact(artifact);
}

function getSavedFileCommand(
	commandInfo: ArtifactCommand,
): SavedFilePresentationDetails["command"] | undefined {
	if (commandInfo.command === "wait" && isDownloadWaitSubcommand(commandInfo.subcommand)) {
		return "wait";
	}
	return commandInfo.command === "download" || commandInfo.command === "pdf"
		? commandInfo.command
		: undefined;
}

export function getSavedFileDetails(
	commandInfo: ArtifactCommand,
	data: Readonly<Record<string, unknown>>,
): SavedFilePresentationDetails | undefined {
	const path = typeof data.path === "string" && data.path.trim().length > 0 ? data.path : undefined;
	if (path === undefined || isNonFileArtifactPathCandidate(path)) {
		return undefined;
	}
	const command = getSavedFileCommand(commandInfo);
	if (command === undefined) {
		return undefined;
	}
	const { path: _path, ...metadata } = data;
	return {
		command,
		kind: command === "pdf" ? "pdf" : "download",
		path,
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		...(commandInfo.subcommand !== undefined && commandInfo.subcommand.length > 0
			? { subcommand: commandInfo.subcommand }
			: {}),
	};
}
