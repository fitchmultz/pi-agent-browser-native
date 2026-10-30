import {
	extractUpstreamCommandTokens,
	parseCommandInfo,
	type CommandInfo,
} from "../../argv-descriptor.js";
import { isRecord } from "../../parsing.js";
import { nextReadConfirmation } from "../../read-confirmation.js";
import { redactInvocationArgs } from "../../runtime-redaction.js";
import { detectConfirmationRequired } from "../confirmation.js";
import type { AgentBrowserBatchResult, ToolPresentation } from "../contracts.js";
import type { ReadConfirmation } from "../evidence-contracts.js";
import { buildSnapshotPresentation } from "../snapshot.js";
import { formatArtifactMetadataLines, formatArtifactSummary } from "./artifacts.js";
import type { FileArtifactMetadata } from "../artifact-contracts.js";
import {
	buildBatchPresentation,
	isAgentBrowserBatchResultArray,
	redactBatchStepErrorData,
} from "./batch.js";
import type { BuildNestedToolPresentation } from "./batch-contracts.js";
import { isStringArray } from "./content.js";
import { enrichStreamStatusData, redactPresentationData } from "./diagnostics.js";
import type { BuildToolPresentationOptions } from "./input-contracts.js";
import { formatPresentationContentText, formatPresentationSummary } from "./registry.js";
import { resolvePresentationCommandInfo } from "./semantic-action.js";

export interface PresentationSource {
	readonly commandInfo: CommandInfo;
	readonly presentationCommandInfo: CommandInfo;
	readonly data: unknown;
	readonly presentationData: unknown;
	readonly recordingCommand: boolean;
	readonly recordingBatch: boolean;
	readonly readConfirmation?: ReadConfirmation;
	readonly confirmationRequired?: ReturnType<typeof detectConfirmationRequired>;
}

export function resolvePresentationCommands(options: BuildToolPresentationOptions): {
	readonly commandInfo: CommandInfo;
	readonly presentationCommandInfo: CommandInfo;
} {
	const commandInfo =
		options.commandInfo.commandTokens || !options.args
			? options.commandInfo
			: { ...options.commandInfo, commandTokens: extractUpstreamCommandTokens(options.args) };
	return {
		commandInfo,
		presentationCommandInfo: resolvePresentationCommandInfo(
			commandInfo,
			options.compiledSemanticAction,
		),
	};
}

function redactBatchSpillData(
	data: readonly AgentBrowserBatchResult[],
): readonly AgentBrowserBatchResult[] {
	return data.map((row) => {
		const command = isStringArray(row.command) ? row.command : undefined;
		return {
			...row,
			command: row.index === undefined && command ? redactInvocationArgs(command) : undefined,
			error: row.error === undefined ? undefined : redactBatchStepErrorData(command, row.error),
			result:
				row.result === undefined
					? undefined
					: redactPresentationData(parseCommandInfo(command ?? []), row.result),
		};
	});
}

export function buildPresentationSource(
	options: BuildToolPresentationOptions,
	commands: {
		readonly commandInfo: CommandInfo;
		readonly presentationCommandInfo: CommandInfo;
	},
): PresentationSource {
	const { commandInfo } = commands;
	const data = enrichPresentationSource(options, commandInfo);
	return {
		...commands,
		data,
		presentationData:
			commandInfo.command === "batch" && isAgentBrowserBatchResultArray(data)
				? redactBatchSpillData(data)
				: redactPresentationData(commandInfo, data),
		recordingCommand: commandInfo.command === "record",
		recordingBatch: isRecordingBatch(commandInfo, data),
		confirmationRequired: detectConfirmationRequired(data),
		readConfirmation: nextReadConfirmation({
			commandTokens: commandInfo.commandTokens ?? [],
			data,
			namespace: options.namespace,
			sessionName: options.sessionName ?? "default",
			succeeded: options.envelope?.success !== false,
		}),
	};
}

function enrichPresentationSource(
	options: BuildToolPresentationOptions,
	commandInfo: CommandInfo,
): unknown {
	const data = enrichStreamStatusData(commandInfo, options.envelope?.data);
	return commandInfo.command === "session" && commandInfo.subcommand === "info" && isRecord(data)
		? { ...data, piCleanupOwnership: options.piCleanupOwnership ?? "unknown" }
		: data;
}

function isRecordingBatch(command: CommandInfo, data: unknown): boolean {
	return (
		command.command === "batch" &&
		isAgentBrowserBatchResultArray(data) &&
		data.some((row) => row.command?.[0] === "record")
	);
}

function buildNativeContent(
	options: BuildToolPresentationOptions,
	source: PresentationSource,
	artifacts: readonly FileArtifactMetadata[],
): ToolPresentation["content"] {
	if (options.modelVisible === false) {
		return [];
	}
	const text =
		artifacts.length > 0
			? formatArtifactMetadataLines(artifacts).join("\n")
			: formatPresentationContentText(
					source.commandInfo,
					source.data,
					options.compiledSemanticAction,
				);
	return [{ type: "text", text }];
}

export async function buildSourcePresentation(
	options: BuildToolPresentationOptions,
	source: PresentationSource,
	artifacts: readonly FileArtifactMetadata[],
	buildNestedToolPresentation: BuildNestedToolPresentation,
): Promise<ToolPresentation> {
	const summary =
		formatArtifactSummary(artifacts) ??
		formatPresentationSummary(source.commandInfo, source.data, options.compiledSemanticAction);
	if (source.commandInfo.command === "batch" && isAgentBrowserBatchResultArray(source.data)) {
		return buildBatchPresentation({
			artifactManifest: options.artifactManifest,
			artifactMaxUpdatedAtMs: options.artifactMaxUpdatedAtMs,
			artifactMinUpdatedAtMs: options.artifactMinUpdatedAtMs,
			artifactRequests: options.batchArtifactRequests,
			buildNestedToolPresentation,
			modelVisible: options.modelVisible,
			cwd: options.cwd,
			data: source.data,
			namespace: options.namespace,
			networkRoutes: options.networkRoutes,
			persistentArtifactStore: options.persistentArtifactStore,
			piCleanupOwnership: options.piCleanupOwnership,
			sessionName: options.sessionName,
			summary,
		});
	}
	if (
		options.modelVisible !== false &&
		source.commandInfo.command === "snapshot" &&
		isRecord(source.data) &&
		!source.confirmationRequired
	) {
		return buildSnapshotPresentation(
			source.data,
			options.persistentArtifactStore,
			options.artifactManifest,
		);
	}
	return {
		artifacts: artifacts.length > 0 ? artifacts : undefined,
		content: buildNativeContent(options, source, artifacts),
		data: source.presentationData,
		summary,
	};
}
