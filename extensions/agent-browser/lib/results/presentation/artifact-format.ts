import { isPendingRecordingArtifact } from "../artifact-manifest.js";
import type { FileArtifactMetadata } from "../contracts.js";
import { formatRecordingReceipt } from "../recording.js";
import { isDownloadWaitSubcommand } from "./artifact-files.js";

export function formatByteCount(bytes: number): string {
	if (bytes < 1_024) {
		return `${bytes} B`;
	}
	if (bytes < 1_024 * 1_024) {
		return `${(bytes / 1_024).toFixed(1)} KiB`;
	}
	return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function formatPreviousRecordingLabel(artifact: FileArtifactMetadata): string {
	if (artifact.status === "stale") {
		return "Previous recording stale";
	}
	return artifact.exists === false ? "Previous recording missing" : "Previous recording saved";
}

function formatRecordingLabel(artifact: FileArtifactMetadata): string {
	const previous = artifact.subcommand === "restart-previous";
	if (artifact.status === "failed") {
		return previous ? "Previous recording failed" : "Recording failed";
	}
	if (artifact.status === "unverified") {
		return previous ? "Previous recording unverified" : "Recording unverified";
	}
	if (artifact.command === "record" && previous) {
		return formatPreviousRecordingLabel(artifact);
	}
	if (!isPendingRecordingArtifact(artifact)) {
		return artifact.status === "saved"
			? "Saved recording"
			: "Recording reported; file not verified";
	}
	return formatPendingRecordingLabel(artifact.subcommand);
}

function formatPendingRecordingLabel(subcommand: string | undefined): string {
	if (subcommand === "stop") {
		return "Recording finalization pending";
	}
	return subcommand === "restart"
		? "Recording restarted; output will be written on stop"
		: "Recording started; output will be written on stop";
}

function formatDownloadLabel(artifact: FileArtifactMetadata): string {
	const wait = artifact.command === "wait" && isDownloadWaitSubcommand(artifact.subcommand);
	if (artifact.exists !== true) {
		return wait
			? "Download event reported; file not verified"
			: "Download reported; file not verified";
	}
	return wait ? "Download saved and verified" : "Downloaded file verified";
}

function formatImageLabel(artifact: FileArtifactMetadata): string {
	const diff = artifact.command === "diff" && artifact.subcommand === "screenshot";
	if (artifact.exists !== true) {
		return diff ? "Diff image reported; file not verified" : "Image reported; file not verified";
	}
	return diff ? "Saved diff image" : "Saved image";
}

function formatArtifactLabel(artifact: FileArtifactMetadata): string {
	switch (artifact.kind) {
		case "download":
			return formatDownloadLabel(artifact);
		case "file":
			return artifact.command === "state" ? "State file" : "Saved file";
		case "har":
			return "Saved HAR";
		case "image":
			return formatImageLabel(artifact);
		case "pdf":
			return "Saved PDF";
		case "profile":
			return "Saved profile";
		case "trace":
			return "Saved trace";
		case "video":
			return formatRecordingLabel(artifact);
	}
}

export function formatArtifactSummary(
	artifacts: readonly FileArtifactMetadata[],
): string | undefined {
	const firstArtifact = artifacts[0];
	if (firstArtifact === undefined) {
		return undefined;
	}
	if (artifacts.length === 1) {
		return `${formatArtifactLabel(firstArtifact)}: ${firstArtifact.path}`;
	}
	const restartArtifact = artifacts.find(
		(artifact) => isPendingRecordingArtifact(artifact) && artifact.subcommand === "restart",
	);
	const previous = artifacts.filter(
		(artifact) => artifact.command === "record" && artifact.subcommand === "restart-previous",
	);
	if (restartArtifact && previous.length > 0) {
		return [...previous, restartArtifact]
			.map((artifact) => `${formatArtifactLabel(artifact)}: ${artifact.path}`)
			.join("\n");
	}
	return `${artifacts.every((artifact) => artifact.status === "saved") ? "Saved" : "Reported"} ${artifacts.length} artifacts: ${artifacts.map((artifact) => `${artifact.kind} ${artifact.path}`).join(", ")}`;
}

function optionalField(label: string, value: string | undefined): string | undefined {
	return value !== undefined && value.length > 0 ? `${label}: ${value}` : undefined;
}

function formatPendingDetails(artifact: FileArtifactMetadata): (string | undefined)[] {
	return [
		`Exists: ${artifact.exists ?? "pending until record stop"}`,
		`Status: ${artifact.status ?? "pending"}`,
		`Recording state: ${artifact.recordingState ?? "openRecording"}`,
		`Will exist on stop: ${artifact.willExistOnStop !== false}`,
	];
}

function formatFileDetails(artifact: FileArtifactMetadata): (string | undefined)[] {
	return [
		`Exists: ${artifact.exists ?? "unknown"}`,
		artifact.exists === false ? "not found on disk" : undefined,
		typeof artifact.sizeBytes === "number"
			? `Size: ${formatByteCount(artifact.sizeBytes)}`
			: undefined,
		typeof artifact.sizeBytes === "number" ? `Size bytes: ${artifact.sizeBytes}` : undefined,
		`Status: ${artifact.status ?? (artifact.exists === false ? "missing" : "saved")}`,
		optionalField("Reported path", artifact.tempPath),
		optionalField("Media type", artifact.mediaType),
	];
}

export function formatArtifactMetadataLines(artifacts: readonly FileArtifactMetadata[]): string[] {
	return artifacts.map((artifact, index) =>
		[
			`${formatArtifactLabel(artifact)}: ${artifact.path}`,
			`Artifact type: ${artifact.kind}`,
			optionalField("Requested path", artifact.requestedPath),
			`Absolute path: ${artifact.absolutePath}`,
			...(isPendingRecordingArtifact(artifact)
				? formatPendingDetails(artifact)
				: formatFileDetails(artifact)),
			optionalField("Session", artifact.session),
			optionalField("CWD", artifact.cwd),
			artifact.recording ? formatRecordingReceipt(artifact.recording) : undefined,
			`Machine data: details.artifacts[${index}]`,
		]
			.filter((item): item is string => item !== undefined)
			.join("\n"),
	);
}
