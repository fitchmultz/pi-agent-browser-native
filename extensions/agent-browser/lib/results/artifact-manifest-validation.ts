import { isRecord } from "../parsing.js";
import type { ArtifactReceiptKey } from "./artifact-contracts.js";
import type { SessionArtifactManifest, SessionArtifactManifestEntry } from "./contracts.js";

type EvidenceRow = Readonly<Record<string, unknown>>;
const ARTIFACT_RECEIPT_KEY = /^sha256:[0-9a-f]{64}$/;

/** Persisted artifact identities are SHA-256 digests of complete private row keys. */
export function isArtifactReceiptKey(value: unknown): value is ArtifactReceiptKey {
	return typeof value === "string" && ARTIFACT_RECEIPT_KEY.test(value);
}

function finiteNonnegative(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeCount(value: unknown): boolean {
	return finiteNonnegative(value) && Number.isSafeInteger(value);
}

function optionalStrings(value: EvidenceRow, keys: readonly string[]): boolean {
	return keys.every((key) => value[key] === undefined || typeof value[key] === "string");
}

function nullableStrings(value: EvidenceRow, keys: readonly string[]): boolean {
	return keys.every((key) => value[key] === null || typeof value[key] === "string");
}

function nullableNumbers(value: EvidenceRow, keys: readonly string[]): boolean {
	return keys.every((key) => value[key] === null || finiteNonnegative(value[key]));
}

function nullableBoolean(value: unknown): boolean {
	return value === null || typeof value === "boolean";
}

function captureIsValid(value: EvidenceRow): boolean {
	return (
		nullableStrings(value, [
			"startedAt",
			"endedAt",
			"firstFrameAt",
			"lastFrameAt",
			"timestampSource",
		]) &&
		nullableNumbers(value, [
			"durationMs",
			"firstFrameAfterMs",
			"lastFrameAfterMs",
			"averageFps",
			"maxFrameGapMs",
		])
	);
}

function outputIsValid(value: EvidenceRow): boolean {
	return (
		nullableStrings(value, ["durationSource"]) &&
		nullableNumbers(value, [
			"frames",
			"fps",
			"encodedFrames",
			"durationMs",
			"heldFrames",
			"droppedFrames",
			"skippedFrames",
		]) &&
		nullableBoolean(value.encoderSucceeded)
	);
}

function recordingIsValid(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!isRecord(value.capture) ||
		!isRecord(value.output) ||
		!isRecord(value.file)
	) {
		return false;
	}
	return (
		recordingScalarsAreValid(value) &&
		captureIsValid(value.capture) &&
		outputIsValid(value.output) &&
		nullableBoolean(value.file.exists) &&
		nullableNumbers(value.file, ["sizeBytes"])
	);
}

function recordingScalarsAreValid(value: EvidenceRow): boolean {
	return (
		typeof value.warning === "string" &&
		typeof value.path === "string" &&
		nullableStrings(value, ["recordingId", "error"]) &&
		nullableBoolean(value.success) &&
		nullableNumbers(value, ["frames", "capturedFrames", "fps"])
	);
}

function optionalNumbersAreValid(value: EvidenceRow): boolean {
	return (
		["evictedAtMs", "recordingStartedAtMs"].every(
			(key) =>
				value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key])),
		) &&
		(value.sizeBytes === undefined || finiteNonnegative(value.sizeBytes))
	);
}

function optionalRecordingIsValid(value: EvidenceRow): boolean {
	return (
		(value.recordingState === undefined || value.recordingState === "openRecording") &&
		(value.recording === undefined || recordingIsValid(value.recording)) &&
		(value.status === undefined ||
			[
				"failed",
				"missing",
				"pending",
				"repaired-from-temp",
				"saved",
				"stale",
				"unverified",
				"upstream-temp-only",
			].some((status) => status === value.status))
	);
}

function optionalEvidenceIsValid(value: EvidenceRow): boolean {
	return (
		optionalStrings(value, [
			"absolutePath",
			"command",
			"cwd",
			"extension",
			"mediaType",
			"namespace",
			"requestedPath",
			"session",
			"subcommand",
		]) &&
		(value.exists === undefined || typeof value.exists === "boolean") &&
		(value.receiptKey === undefined || isArtifactReceiptKey(value.receiptKey)) &&
		optionalNumbersAreValid(value) &&
		optionalRecordingIsValid(value)
	);
}

function isManifestEntry(value: unknown): value is SessionArtifactManifestEntry {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.path === "string" &&
		value.path.trim().length > 0 &&
		typeof value.createdAtMs === "number" &&
		Number.isFinite(value.createdAtMs) &&
		["evicted", "ephemeral", "live", "missing"].some((state) => state === value.retentionState) &&
		["explicit-path", "persistent-session", "process-temp"].some(
			(scope) => scope === value.storageScope,
		) &&
		["download", "file", "har", "image", "pdf", "profile", "trace", "video", "spill"].some(
			(kind) => kind === value.kind,
		) &&
		optionalEvidenceIsValid(value)
	);
}

function manifestCountsAreValid(value: EvidenceRow): boolean {
	return (
		safeCount(value.maxEntries) &&
		value.maxEntries !== 0 &&
		safeCount(value.liveCount) &&
		safeCount(value.evictedCount)
	);
}

export function isSessionArtifactManifest(value: unknown): value is SessionArtifactManifest {
	if (!isRecord(value)) {
		return false;
	}
	return (
		value.version === 1 &&
		Array.isArray(value.entries) &&
		value.entries.every(isManifestEntry) &&
		typeof value.updatedAtMs === "number" &&
		Number.isFinite(value.updatedAtMs) &&
		manifestCountsAreValid(value)
	);
}
