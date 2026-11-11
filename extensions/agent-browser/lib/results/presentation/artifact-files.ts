import { open, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { getAgentBrowserSessionIdentityKey } from "../../argv-grammar.js";
import type { CommandInfo } from "../../argv-descriptor.js";
import { getExplicitArtifactDestination } from "../../orchestration/browser-run/artifact-paths.js";
import { isRecord } from "../../parsing.js";
import { isPendingRecordingCommand } from "../artifact-manifest.js";
import type {
	ArtifactRequestContext,
	FileArtifactKind,
	FileArtifactMetadata,
	SessionArtifactManifest,
} from "../artifact-contracts.js";
import type { RecordingReceipt } from "../evidence-contracts.js";
import { getRecordingReceipt } from "../recording.js";

export type ArtifactCommand = CommandInfo;
export type { ArtifactRequestContext } from "../artifact-contracts.js";

export interface ArtifactExtractionOptions {
	readonly artifactManifest?: SessionArtifactManifest | undefined;
	readonly artifactMaxUpdatedAtMs?: number | undefined;
	readonly artifactMinUpdatedAtMs?: number | undefined;
	readonly artifactRequest?: ArtifactRequestContext | undefined;
	readonly commandInfo: ArtifactCommand;
	readonly cwd: string;
	readonly data: unknown;
	readonly namespace?: string | undefined;
	readonly recordingOutcome?: boolean | undefined;
	readonly recordingPending?: boolean | undefined;
	readonly previousRecordingContactSheetPath?: string | undefined;
	readonly sessionName?: string | undefined;
}

interface FileArtifactOptions extends ArtifactExtractionOptions {
	readonly kind?: FileArtifactKind;
	readonly path: string;
	readonly recording?: RecordingReceipt | undefined;
}

interface DiskEvidence {
	readonly exists?: boolean | undefined;
	readonly sizeBytes?: number;
	readonly mediaType?: string | undefined;
	readonly updatedAtMs?: number;
}

const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const ARTIFACT_MTIME_TOLERANCE_MS = 2_000;

export function getImageMimeType(bytes: Buffer): string | undefined {
	if (bytes.length < 16) {
		return undefined;
	}
	if (bytes.subarray(0, 16).equals(PNG_HEADER)) {
		return "image/png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] !== 0xf7) {
		return "image/jpeg";
	}
	if (["GIF87a", "GIF89a"].includes(bytes.toString("utf8", 0, 6))) {
		return "image/gif";
	}
	if (bytes.toString("utf8", 0, 4) === "RIFF" && bytes.toString("utf8", 8, 12) === "WEBP") {
		return "image/webp";
	}
	return undefined;
}

export async function readImageHeader(path: string, length: number): Promise<Buffer> {
	const file = await open(path, "r");
	try {
		const bytes = Buffer.alloc(length);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		return bytes.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
}

async function getFileImageMimeType(path: string): Promise<string | undefined> {
	try {
		return getImageMimeType(await readImageHeader(path, 16));
	} catch {
		return undefined;
	}
}

function isMissingFileError(error: unknown): boolean {
	return (
		isRecord(error) && typeof error.code === "string" && ["ENOENT", "ENOTDIR"].includes(error.code)
	);
}

async function readDiskEvidence(absolutePath: string): Promise<DiskEvidence> {
	try {
		const fileStats = await stat(absolutePath);
		return {
			exists: fileStats.isFile(),
			sizeBytes: fileStats.size,
			updatedAtMs: fileStats.mtimeMs,
			mediaType: fileStats.isFile() ? await getFileImageMimeType(absolutePath) : undefined,
		};
	} catch (error) {
		return { exists: isMissingFileError(error) ? false : undefined };
	}
}

export function isDownloadWaitSubcommand(subcommand: string | undefined): boolean {
	return subcommand === "--download" || subcommand === "-d";
}

function getArtifactKind(info: ArtifactCommand): FileArtifactKind | undefined {
	switch (info.command) {
		case "screenshot":
			return "image";
		case "diff":
			return info.subcommand === "screenshot" ? "image" : undefined;
		case "pdf":
			return "pdf";
		case "download":
			return "download";
		case "wait":
			return isDownloadWaitSubcommand(info.subcommand) ? "download" : undefined;
		case "state":
			return info.subcommand === "save" ? "file" : undefined;
		case "trace":
			return "trace";
		case "profiler":
			return "profile";
		case "record":
			return "video";
		case "network":
			return info.subcommand === "har" ? "har" : undefined;
		case undefined:
			return undefined;
		default:
			return undefined;
	}
}

export function isNonFileArtifactPathCandidate(path: string): boolean {
	return /^(?:data|blob|https?|javascript|mailto):/i.test(path.trim());
}

function validPath(value: unknown): value is string {
	return (
		typeof value === "string" && value.trim().length > 0 && !isNonFileArtifactPathCandidate(value)
	);
}

const PATH_FIELDS = [
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

export function extractPathStrings(data: unknown): string[] {
	if (typeof data === "string") {
		return data.trim().length > 0 && !isNonFileArtifactPathCandidate(data) ? [data] : [];
	}
	if (!isRecord(data)) {
		return [];
	}
	return [
		...new Set(
			PATH_FIELDS.flatMap((key) => {
				const value: unknown = data[key];
				if (Array.isArray(value)) {
					return value.filter(validPath);
				}
				return validPath(value) ? [value] : [];
			}),
		),
	];
}

function artifactMtimeIsOutsideCommandWindow(
	updatedAtMs: number | undefined,
	options: ArtifactExtractionOptions,
	minUpdatedAtMs = options.artifactMinUpdatedAtMs,
): boolean {
	if (updatedAtMs === undefined || minUpdatedAtMs === undefined) {
		return false;
	}
	return (
		updatedAtMs < minUpdatedAtMs - ARTIFACT_MTIME_TOLERANCE_MS ||
		(options.artifactMaxUpdatedAtMs !== undefined &&
			updatedAtMs > options.artifactMaxUpdatedAtMs + ARTIFACT_MTIME_TOLERANCE_MS)
	);
}

function isPendingRecording(options: FileArtifactOptions, kind: FileArtifactKind): boolean {
	return (
		options.recordingPending === true ||
		(isPendingRecordingCommand(options.commandInfo.command, options.commandInfo.subcommand, kind) &&
			options.recordingOutcome !== false &&
			options.recording?.success !== false)
	);
}

function getRecordingStartedAtMs(options: FileArtifactOptions): number | undefined {
	const startedAt = options.recording?.capture.startedAt;
	const captureStartedAtMs =
		startedAt !== undefined && startedAt !== null && startedAt.length > 0
			? Date.parse(startedAt)
			: NaN;
	return Number.isFinite(captureStartedAtMs) ? captureStartedAtMs : options.artifactMinUpdatedAtMs;
}

function nativeRecordingFailed(options: FileArtifactOptions): boolean {
	const receipt = options.recording;
	return (
		receipt?.success === false ||
		receipt?.output.encoderSucceeded === false ||
		(options.recordingOutcome === false && receipt?.success !== null)
	);
}

function recordingSizeMismatch(
	options: FileArtifactOptions,
	sizeBytes: number | undefined,
): boolean {
	const recordedSize = options.recording?.file.sizeBytes;
	return recordedSize !== undefined && recordedSize !== null && recordedSize !== sizeBytes;
}

function getRecordingStatus(
	options: FileArtifactOptions,
	sizeBytes: number | undefined,
): FileArtifactMetadata["status"] {
	const receipt = options.recording;
	if (nativeRecordingFailed(options)) {
		return "failed";
	}
	if (
		(receipt?.success !== true && options.recordingOutcome !== true) ||
		recordingSizeMismatch(options, sizeBytes)
	) {
		return "unverified";
	}
	return options.artifactRequest?.status ?? "saved";
}

function getArtifactStatus(
	options: FileArtifactOptions,
	evidence: DiskEvidence,
	kind: FileArtifactKind,
	state: { readonly pending: boolean; readonly stale: boolean },
): FileArtifactMetadata["status"] {
	if (state.pending) {
		return "pending";
	}
	if (evidence.exists === false) {
		return "missing";
	}
	if (evidence.exists !== true) {
		return "unverified";
	}
	if (options.artifactRequest?.status === "missing") {
		return "missing";
	}
	if (state.stale) {
		return "stale";
	}
	return kind === "video"
		? getRecordingStatus(options, evidence.sizeBytes)
		: (options.artifactRequest?.status ?? "saved");
}

function buildArtifactIdentity(
	options: FileArtifactOptions,
	kind: FileArtifactKind,
): FileArtifactMetadata {
	const {
		absolutePath = resolve(options.cwd, options.path),
		path: requestedPath,
		tempPath,
	} = options.artifactRequest ?? {};
	const extension = extname(absolutePath.length > 0 ? absolutePath : options.path).toLowerCase();
	return {
		absolutePath,
		artifactType: kind,
		command: options.commandInfo.command,
		cwd: options.cwd,
		extension: extension.length > 0 ? extension : undefined,
		kind,
		namespace: options.namespace,
		path: requestedPath ?? options.path,
		requestedPath:
			requestedPath ??
			getExplicitArtifactDestination([...(options.commandInfo.commandTokens ?? [])]),
		session: options.sessionName,
		subcommand: options.commandInfo.subcommand,
		tempPath,
	};
}

function artifactIsStale(
	options: FileArtifactOptions,
	evidence: DiskEvidence,
	kind: FileArtifactKind,
	recordingStartedAtMs: number | undefined,
): boolean {
	if (
		options.commandInfo.command === "wait" &&
		isDownloadWaitSubcommand(options.commandInfo.subcommand)
	) {
		return false;
	}
	return artifactMtimeIsOutsideCommandWindow(
		evidence.updatedAtMs,
		options,
		kind === "video" ? recordingStartedAtMs : options.artifactMinUpdatedAtMs,
	);
}

export async function buildFileArtifactMetadata(
	options: FileArtifactOptions,
): Promise<FileArtifactMetadata | undefined> {
	const kind = options.kind ?? getArtifactKind(options.commandInfo);
	if (kind === undefined) {
		return undefined;
	}
	const identity = buildArtifactIdentity(options, kind);
	const pending = isPendingRecording(options, kind);
	const recordingStartedAtMs = getRecordingStartedAtMs(options);
	const evidence: DiskEvidence =
		!pending || options.commandInfo.subcommand === "stop"
			? await readDiskEvidence(identity.absolutePath)
			: {};
	const stale = artifactIsStale(options, evidence, kind, recordingStartedAtMs);
	return {
		...identity,
		exists: evidence.exists,
		sizeBytes: evidence.sizeBytes,
		mediaType: evidence.mediaType,
		updatedAtMs: evidence.updatedAtMs,
		recording: options.recording,
		recordingStartedAtMs: kind === "video" ? recordingStartedAtMs : undefined,
		recordingState: pending ? "openRecording" : undefined,
		status: getArtifactStatus(options, evidence, kind, { pending, stale }),
		willExistOnStop: pending ? true : undefined,
	};
}

function findPreviousRecording(options: ArtifactExtractionOptions) {
	const sessionKey =
		options.sessionName !== undefined && options.sessionName.length > 0
			? getAgentBrowserSessionIdentityKey(options.sessionName, options.namespace)
			: undefined;
	return options.artifactManifest?.entries.find((entry) => {
		if (
			entry.command !== "record" ||
			!["start", "restart"].includes(entry.subcommand ?? "") ||
			entry.kind !== "video"
		) {
			return false;
		}
		if (sessionKey === undefined || sessionKey.length === 0) {
			return true;
		}
		return (
			entry.session !== undefined &&
			entry.session.length > 0 &&
			getAgentBrowserSessionIdentityKey(entry.session, entry.namespace) === sessionKey
		);
	});
}

function buildPreviousIdentity(
	previous: SessionArtifactManifest["entries"][number],
	options: ArtifactExtractionOptions,
): FileArtifactMetadata {
	const absolutePath = previous.absolutePath ?? resolve(options.cwd, previous.path);
	const extension = extname(absolutePath).toLowerCase();
	return {
		absolutePath,
		artifactType: "video",
		command: "record",
		cwd: previous.cwd ?? options.cwd,
		extension: previous.extension ?? (extension.length > 0 ? extension : undefined),
		kind: "video",
		namespace: previous.namespace ?? options.namespace,
		path: previous.path,
		requestedPath: previous.requestedPath,
		session: previous.session ?? options.sessionName,
		subcommand: "restart-previous",
	};
}

async function buildPreviousDiskRecording(
	options: ArtifactExtractionOptions,
): Promise<FileArtifactMetadata | undefined> {
	const previous = findPreviousRecording(options);
	if (!previous) {
		return undefined;
	}
	const identity = buildPreviousIdentity(previous, options);
	const evidence = await readDiskEvidence(identity.absolutePath);
	const stale = artifactMtimeIsOutsideCommandWindow(evidence.updatedAtMs, options);
	let status: FileArtifactMetadata["status"] = "unverified";
	if (stale) {
		status = "stale";
	}
	if (evidence.exists === false && evidence.updatedAtMs === undefined) {
		status = "missing";
	}
	// Restart's path and disk evidence alone never prove native finalization.
	return {
		...identity,
		...evidence,
		exists: evidence.updatedAtMs !== undefined ? true : evidence.exists,
		status,
	};
}

export async function buildPreviousRestartRecordingArtifact(
	options: ArtifactExtractionOptions,
): Promise<FileArtifactMetadata | undefined> {
	if (options.commandInfo.command !== "record" || options.commandInfo.subcommand !== "restart") {
		return undefined;
	}
	if (isRecord(options.data) && "previousRecording" in options.data) {
		const recording = getRecordingReceipt(options.data.previousRecording);
		return recording
			? buildFileArtifactMetadata({
					...options,
					commandInfo: { command: "record", subcommand: "restart-previous" },
					path: recording.path,
					recording,
				})
			: undefined;
	}
	// A rejected or pending restart has not acknowledged replacement of the active take.
	if (!isRecord(options.data) || options.data.restarted !== true) {
		return undefined;
	}
	return buildPreviousDiskRecording(options);
}
