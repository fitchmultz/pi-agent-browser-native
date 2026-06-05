/**
 * Purpose: Own file artifact detection, verification, manifest merging, and inline image attachment for tool presentation.
 * Responsibilities: Build artifact metadata, verification summaries, saved-file details, artifact retention notices, and safe image content.
 * Scope: Artifact and image presentation only.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { isRecord, parsePositiveInteger } from "../../parsing.js";
import type { CommandInfo } from "../../runtime.js";
import {
	formatSessionArtifactRetentionSummary,
	mergeSessionArtifactManifest,
} from "../artifact-manifest.js";
import { isPendingRecordingArtifact } from "../artifact-state.js";
import { classifyAgentBrowserSuccessCategory } from "../categories.js";
import type {
	ArtifactVerificationEntry,
	ArtifactVerificationSummary,
	FileArtifactKind,
	FileArtifactMetadata,
	SavedFilePresentationDetails,
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
	ToolPresentation,
} from "../contracts.js";

const IMAGE_EXTENSION_TO_MIME_TYPE: Record<string, string> = {
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

const INLINE_IMAGE_MAX_BYTES_ENV = "PI_AGENT_BROWSER_INLINE_IMAGE_MAX_BYTES";

const DEFAULT_INLINE_IMAGE_MAX_BYTES = 5 * 1_024 * 1_024;

function getImageMimeType(filePath: string): string | undefined {
	const extension = extname(filePath).toLowerCase();
	return IMAGE_EXTENSION_TO_MIME_TYPE[extension];
}

function getInlineImageMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInteger(env[INLINE_IMAGE_MAX_BYTES_ENV]) ?? DEFAULT_INLINE_IMAGE_MAX_BYTES;
}

function formatByteCount(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
	return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function appendPresentationNotice(presentation: ToolPresentation, message: string): void {
	const existingText = presentation.content[0]?.type === "text" ? presentation.content[0].text : "";
	presentation.content[0] = {
		type: "text",
		text: existingText.length > 0 ? `${existingText}\n\n${message}` : message,
	};
}

function shouldAppendArtifactRetentionNotice(entries: SessionArtifactManifestEntry[]): boolean {
	return entries.some((entry) => entry.retentionState === "evicted" || entry.storageScope !== "explicit-path");
}

function getManifestEntryKey(entry: SessionArtifactManifestEntry): string {
	return entry.storageScope === "explicit-path" && entry.absolutePath ? `${entry.storageScope}:${entry.absolutePath}` : `${entry.storageScope}:${entry.path}`;
}

export function manifestHasNewNoticeWorthyEntries(base: SessionArtifactManifest | undefined, current: SessionArtifactManifest | undefined): boolean {
	if (!current) return false;
	const baseKeys = new Set((base?.entries ?? []).map(getManifestEntryKey));
	return current.entries.some((entry) => !baseKeys.has(getManifestEntryKey(entry)) && (entry.retentionState === "evicted" || entry.storageScope !== "explicit-path"));
}

export function applyArtifactManifest(presentation: ToolPresentation, baseManifest: SessionArtifactManifest | undefined, entries: SessionArtifactManifestEntry[]): ToolPresentation {
	if (entries.length === 0) return presentation;
	const artifactManifest = mergeSessionArtifactManifest({ base: baseManifest, entries });
	if (!artifactManifest) return presentation;
	presentation.artifactManifest = artifactManifest;
	presentation.artifactRetentionSummary = formatSessionArtifactRetentionSummary(artifactManifest);
	if (shouldAppendArtifactRetentionNotice(entries)) {
		appendPresentationNotice(presentation, presentation.artifactRetentionSummary);
	}
	return presentation;
}

export function getScreenshotSummary(data: Record<string, unknown>): string | undefined {
	return typeof data.path === "string" ? `Saved image: ${data.path}` : undefined;
}

const PATH_FIELD_CANDIDATES = [
	"path",
	"file",
	"filePath",
	"outputPath",
	"downloadPath",
	"diffPath",
	"harPath",
	"savedPath",
	"statePath",
	"tracePath",
	"profilePath",
	"videoPath",
] as const;

const ARTIFACT_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
	".cpuprofile": "application/json",
	".har": "application/json",
	".html": "text/html",
	".json": "application/json",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".webm": "video/webm",
	".zip": "application/zip",
	...IMAGE_EXTENSION_TO_MIME_TYPE,
};

function getArtifactKind(commandInfo: CommandInfo): FileArtifactKind | undefined {
	if (commandInfo.command === "screenshot") return "image";
	if (commandInfo.command === "diff" && commandInfo.subcommand === "screenshot") return "image";
	if (commandInfo.command === "pdf") return "pdf";
	if (commandInfo.command === "download") return "download";
	if (commandInfo.command === "wait" && commandInfo.subcommand === "--download") return "download";
	if (commandInfo.command === "state" && commandInfo.subcommand === "save") return "file";
	if (commandInfo.command === "trace") return "trace";
	if (commandInfo.command === "profiler") return "profile";
	if (commandInfo.command === "record") return "video";
	if (commandInfo.command === "network" && commandInfo.subcommand === "har") return "har";
	return undefined;
}

function isNonFileArtifactPathCandidate(path: string): boolean {
	return /^(?:data|blob|https?|javascript|mailto):/i.test(path.trim());
}

function extractPathStrings(data: unknown): string[] {
	if (typeof data === "string") {
		return data.trim().length > 0 && !isNonFileArtifactPathCandidate(data) ? [data] : [];
	}
	if (!isRecord(data)) {
		return [];
	}

	const paths: string[] = [];
	for (const key of PATH_FIELD_CANDIDATES) {
		const value = data[key];
		if (typeof value === "string" && value.trim().length > 0 && !isNonFileArtifactPathCandidate(value)) {
			paths.push(value);
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string" && item.trim().length > 0 && !isNonFileArtifactPathCandidate(item)) {
					paths.push(item);
				}
			}
		}
	}
	return [...new Set(paths)];
}

export interface ArtifactRequestContext {
	absolutePath: string;
	path: string;
	status?: FileArtifactMetadata["status"];
	tempPath?: string;
}

async function buildFileArtifactMetadata(options: {
	artifactRequest?: ArtifactRequestContext;
	commandInfo: CommandInfo;
	cwd: string;
	path: string;
	sessionName?: string;
}): Promise<FileArtifactMetadata | undefined> {
	const kind = getArtifactKind(options.commandInfo);
	if (!kind) {
		return undefined;
	}

	const absolutePath = options.artifactRequest?.absolutePath ?? resolve(options.cwd, options.path);
	const displayPath = options.artifactRequest?.path ?? options.path;
	const extension = extname(absolutePath || options.path).toLowerCase() || undefined;
	let exists: boolean | undefined;
	let sizeBytes: number | undefined;
	try {
		const fileStats = await stat(absolutePath);
		exists = true;
		sizeBytes = fileStats.size;
	} catch {
		exists = false;
	}

	return {
		absolutePath,
		artifactType: kind,
		command: options.commandInfo.command,
		cwd: options.cwd,
		exists,
		extension,
		kind,
		mediaType: extension ? ARTIFACT_EXTENSION_TO_MEDIA_TYPE[extension] : undefined,
		path: displayPath,
		requestedPath: options.artifactRequest?.path,
		session: options.sessionName,
		sizeBytes,
		status: options.artifactRequest?.status ?? (exists === false ? "missing" : "saved"),
		subcommand: options.commandInfo.subcommand,
		tempPath: options.artifactRequest?.tempPath,
	};
}

export async function extractFileArtifacts(options: {
	artifactRequest?: ArtifactRequestContext;
	commandInfo: CommandInfo;
	cwd: string;
	data: unknown;
	sessionName?: string;
}): Promise<FileArtifactMetadata[]> {
	const candidates = extractPathStrings(options.data);
	const artifacts = await Promise.all(candidates.map((path) => buildFileArtifactMetadata({ ...options, path })));
	return artifacts.filter((artifact): artifact is FileArtifactMetadata => artifact !== undefined);
}

export function buildManifestEntriesForFileArtifacts(artifacts: FileArtifactMetadata[], nowMs = Date.now()): SessionArtifactManifestEntry[] {
	return artifacts.map((artifact) => ({
		absolutePath: artifact.absolutePath,
		command: artifact.command,
		createdAtMs: nowMs,
		cwd: artifact.cwd,
		exists: artifact.exists,
		extension: artifact.extension,
		kind: artifact.kind,
		mediaType: artifact.mediaType,
		path: artifact.path,
		requestedPath: artifact.requestedPath,
		retentionState: artifact.exists === false ? "missing" : "live",
		session: artifact.session,
		sizeBytes: artifact.sizeBytes,
		storageScope: "explicit-path",
		subcommand: artifact.subcommand,
	}));
}

export function isManifestFileArtifact(artifact: FileArtifactMetadata): boolean {
	return !isPendingRecordingArtifact(artifact);
}

function getArtifactVerificationEntry(artifact: FileArtifactMetadata): ArtifactVerificationEntry {
	if (isPendingRecordingArtifact(artifact)) {
		return {
			absolutePath: artifact.absolutePath,
			exists: artifact.exists,
			kind: artifact.kind,
			limitation: "Recording output is pending until record stop completes.",
			mediaType: artifact.mediaType,
			path: artifact.path,
			requestedPath: artifact.requestedPath,
			retentionState: undefined,
			sizeBytes: artifact.sizeBytes,
			state: "pending",
			status: artifact.status,
			storageScope: undefined,
		};
	}
	const state = artifact.exists === true
		? "verified"
		: artifact.exists === false
			? "missing"
			: "unverified";
	return {
		absolutePath: artifact.absolutePath,
		exists: artifact.exists,
		kind: artifact.kind,
		limitation: state === "missing"
			? "The wrapper did not find the reported artifact at absolutePath. Treat the path as unverified until recovered or regenerated."
			: state === "unverified"
				? "The wrapper could not prove local filesystem existence for this artifact."
				: undefined,
		mediaType: artifact.mediaType,
		path: artifact.path,
		requestedPath: artifact.requestedPath,
		retentionState: artifact.exists === false ? "missing" : "live",
		sizeBytes: artifact.sizeBytes,
		state,
		status: artifact.status,
		storageScope: "explicit-path",
	};
}

function getManifestVerificationEntry(entry: SessionArtifactManifestEntry): ArtifactVerificationEntry | undefined {
	if (entry.storageScope === "explicit-path") return undefined;
	const state = entry.retentionState === "live"
		? "verified"
		: entry.retentionState === "missing" || entry.retentionState === "evicted"
			? "missing"
			: "unverified";
	return {
		absolutePath: entry.absolutePath,
		exists: entry.exists,
		kind: entry.kind,
		limitation: entry.retentionState === "ephemeral"
			? "This spill file is process-temporary and may not survive reload or restart."
			: entry.retentionState === "evicted"
				? "This persisted spill file was evicted from the bounded session artifact store."
				: undefined,
		mediaType: entry.mediaType,
		path: entry.path,
		requestedPath: entry.requestedPath,
		retentionState: entry.retentionState,
		sizeBytes: entry.sizeBytes,
		state,
		storageScope: entry.storageScope,
	};
}

export function buildArtifactVerificationSummary(
	artifacts: FileArtifactMetadata[],
	manifest?: SessionArtifactManifest,
	manifestPaths?: ReadonlySet<string>,
): ArtifactVerificationSummary | undefined {
	const entries = [
		...artifacts.map(getArtifactVerificationEntry),
		...(manifest?.entries.flatMap((entry) => {
			if (manifestPaths && !manifestPaths.has(entry.path)) return [];
			const verificationEntry = getManifestVerificationEntry(entry);
			return verificationEntry ? [verificationEntry] : [];
		}) ?? []),
	];
	if (entries.length === 0) return undefined;
	const verifiedCount = entries.filter((entry) => entry.state === "verified").length;
	const missingCount = entries.filter((entry) => entry.state === "missing").length;
	const pendingCount = entries.filter((entry) => entry.state === "pending").length;
	const unverifiedCount = entries.filter((entry) => entry.state === "unverified").length;
	return {
		artifacts: entries,
		missingCount,
		pendingCount,
		unverifiedCount,
		verified: entries.length > 0 && verifiedCount === entries.length,
		verifiedCount,
	};
}

export function hasMissingFileArtifact(artifacts: FileArtifactMetadata[] | undefined): boolean {
	return (artifacts ?? []).some((artifact) => !isPendingRecordingArtifact(artifact) && artifact.exists === false);
}

export function formatMissingArtifactFailureText(artifacts: FileArtifactMetadata[] | undefined): string | undefined {
	const missingArtifacts = (artifacts ?? []).filter((artifact) => !isPendingRecordingArtifact(artifact) && artifact.exists === false);
	if (missingArtifacts.length === 0) return undefined;
	if (missingArtifacts.length === 1) {
		const artifact = missingArtifacts[0];
		return `Artifact verification failed: requested ${artifact.kind} was not found at ${artifact.absolutePath}.`;
	}
	return `Artifact verification failed: ${missingArtifacts.length} requested artifacts were not found on disk.`;
}

export function classifyPresentationSuccessCategory(options: {
	artifactVerification?: ArtifactVerificationSummary;
	artifacts?: FileArtifactMetadata[];
	inspection?: boolean;
	savedFile?: SavedFilePresentationDetails;
}) {
	if ((options.artifactVerification?.missingCount ?? 0) > 0 || (options.artifactVerification?.unverifiedCount ?? 0) > 0) {
		return "artifact-unverified" as const;
	}
	return classifyAgentBrowserSuccessCategory(options);
}

function formatArtifactLabel(artifact: FileArtifactMetadata): string {
	switch (artifact.kind) {
		case "download":
			if (artifact.exists !== true) {
				return artifact.command === "wait" && artifact.subcommand === "--download" ? "Download event reported; file not verified" : "Download reported; file not verified";
			}
			return artifact.command === "wait" && artifact.subcommand === "--download" ? "Download saved and verified" : "Downloaded file verified";
		case "file":
			return artifact.command === "state" ? "State file" : "Saved file";
		case "har":
			return "Saved HAR";
		case "image":
			if (artifact.exists !== true) return artifact.command === "diff" && artifact.subcommand === "screenshot" ? "Diff image reported; file not verified" : "Image reported; file not verified";
			return artifact.command === "diff" && artifact.subcommand === "screenshot" ? "Saved diff image" : "Saved image";
		case "pdf":
			return "Saved PDF";
		case "profile":
			return "Saved profile";
		case "trace":
			return "Saved trace";
		case "video":
			return isPendingRecordingArtifact(artifact) ? "Recording started; output will be written on stop" : "Saved recording";
	}
}

export function formatArtifactSummary(artifacts: FileArtifactMetadata[]): string | undefined {
	if (artifacts.length === 0) {
		return undefined;
	}
	if (artifacts.length === 1) {
		const artifact = artifacts[0];
		return `${formatArtifactLabel(artifact)}: ${artifact.path}`;
	}
	return `Saved ${artifacts.length} artifacts: ${artifacts.map((artifact) => `${artifact.kind} ${artifact.path}`).join(", ")}`;
}

export function formatArtifactMetadataLines(artifacts: FileArtifactMetadata[]): string[] {
	return artifacts.map((artifact, index) => {
		if (isPendingRecordingArtifact(artifact)) {
			return [
				`${formatArtifactLabel(artifact)}: ${artifact.path}`,
				`Artifact type: ${artifact.kind}`,
				`Requested path: ${artifact.requestedPath ?? artifact.path}`,
				`Absolute path: ${artifact.absolutePath}`,
				`Exists: ${artifact.exists === true}`,
				`Status: ${artifact.status ?? (artifact.exists === false ? "missing" : "saved")}`,
				artifact.session ? `Session: ${artifact.session}` : undefined,
				artifact.cwd ? `CWD: ${artifact.cwd}` : undefined,
				`Machine data: details.artifacts[${index}]`,
			].filter((item): item is string => item !== undefined).join("\n");
		}

		return [
			`${formatArtifactLabel(artifact)}: ${artifact.path}`,
			`Artifact type: ${artifact.kind}`,
			`Requested path: ${artifact.requestedPath ?? artifact.path}`,
			`Absolute path: ${artifact.absolutePath}`,
			`Exists: ${artifact.exists === true}`,
			artifact.exists === false ? "not found on disk" : undefined,
			typeof artifact.sizeBytes === "number" ? `Size: ${formatByteCount(artifact.sizeBytes)}` : undefined,
			typeof artifact.sizeBytes === "number" ? `Size bytes: ${artifact.sizeBytes}` : undefined,
			`Status: ${artifact.status ?? (artifact.exists === false ? "missing" : "saved")}`,
			artifact.tempPath ? `Temp path: ${artifact.tempPath}` : undefined,
			artifact.mediaType ? `Media type: ${artifact.mediaType}` : undefined,
			artifact.session ? `Session: ${artifact.session}` : undefined,
			artifact.cwd ? `CWD: ${artifact.cwd}` : undefined,
			`Machine data: details.artifacts[${index}]`,
		].filter((item): item is string => item !== undefined).join("\n");
	});
}

function isDownloadWaitCommand(commandInfo: CommandInfo): boolean {
	return commandInfo.command === "wait" && commandInfo.subcommand === "--download";
}

function extractSavedFilePath(data: Record<string, unknown>): string | undefined {
	return typeof data.path === "string" && data.path.trim().length > 0 ? data.path : undefined;
}

export function getSavedFileDetails(commandInfo: CommandInfo, data: Record<string, unknown>): SavedFilePresentationDetails | undefined {
	const path = extractSavedFilePath(data);
	if (!path || isNonFileArtifactPathCandidate(path)) {
		return undefined;
	}
	const savedFileCommand = isDownloadWaitCommand(commandInfo)
		? "wait"
		: commandInfo.command === "download" || commandInfo.command === "pdf"
			? commandInfo.command
			: undefined;
	if (!savedFileCommand) {
		return undefined;
	}

	const { path: _path, ...metadata } = data;
	const details: SavedFilePresentationDetails = {
		command: savedFileCommand,
		kind: savedFileCommand === "pdf" ? "pdf" : "download",
		path,
	};
	if (Object.keys(metadata).length > 0) {
		details.metadata = metadata;
	}
	if (commandInfo.subcommand) {
		details.subcommand = commandInfo.subcommand;
	}
	return details;
}

function isTrustedScreenshotOutput(commandInfo: CommandInfo): boolean {
	return commandInfo.command === "screenshot";
}

export function extractImagePath(commandInfo: CommandInfo, cwd: string, data: unknown): string | undefined {
	if (!isTrustedScreenshotOutput(commandInfo)) {
		return undefined;
	}
	if (typeof data === "string") {
		const mimeType = getImageMimeType(data);
		return mimeType ? resolve(cwd, data) : undefined;
	}
	if (!isRecord(data) || typeof data.path !== "string") {
		return undefined;
	}
	const mimeType = getImageMimeType(data.path);
	return mimeType ? resolve(cwd, data.path) : undefined;
}

export async function attachInlineImage(presentation: ToolPresentation, imagePath: string): Promise<ToolPresentation> {
	const mimeType = getImageMimeType(imagePath);
	if (!mimeType) {
		return presentation;
	}

	try {
		const fileStats = await stat(imagePath);
		const inlineImageMaxBytes = getInlineImageMaxBytes();
		if (fileStats.size > inlineImageMaxBytes) {
			appendPresentationNotice(
				presentation,
				`Image attachment skipped: ${formatByteCount(fileStats.size)} exceeds the inline limit of ${formatByteCount(inlineImageMaxBytes)}.`,
			);
			presentation.imagePath = imagePath;
			return presentation;
		}

		const file = await readFile(imagePath);
		presentation.content.push({ type: "image", data: file.toString("base64"), mimeType });
		presentation.imagePath = imagePath;
		return presentation;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		appendPresentationNotice(presentation, `Image attachment failed: ${message}`);
		presentation.imagePath = imagePath;
		return presentation;
	}
}
