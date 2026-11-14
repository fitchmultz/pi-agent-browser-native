import type { CommandInfo } from "../../argv-descriptor.js";
import type { ToolPresentation } from "../contracts.js";
import { isAgentBrowserBatchResultArray } from "./batch.js";
import { redactModelFacingText } from "./common.js";
import { redactPresentationData } from "./diagnostics.js";
import { buildErrorPresentation } from "./errors.js";
import type { BuildToolPresentationOptions } from "./input-contracts.js";
import { compactLargePresentationOutput } from "./large-output.js";
import { stringifyUnknown } from "../text.js";
import type { ToolPresentationObservation } from "./observation-contracts.js";

function getNativeTextSummary(text: string): string {
	const first = text.split("\n", 1).at(0);
	return first !== undefined && first.length > 0 ? first : "Native text command completed.";
}

export function sanitizeModelFacingPresentation(
	presentation: ToolPresentationObservation,
): ToolPresentation {
	return {
		...presentation,
		content: presentation.content.map((item) =>
			item.type === "text" ? { ...item, text: redactModelFacingText(item.text) } : item,
		),
		summary: redactModelFacingText(presentation.summary),
	};
}

async function buildNativeTextPresentation(
	options: BuildToolPresentationOptions,
	commandInfo: CommandInfo,
): Promise<ToolPresentation> {
	const value = redactPresentationData(
		commandInfo,
		typeof options.envelope?.data === "string" ? options.envelope.data : "",
		options.stdin,
	);
	const text = typeof value === "string" ? value : stringifyUnknown(value);
	const failure =
		options.errorText !== undefined && options.errorText.length > 0
			? buildErrorPresentation({
					args: options.args,
					commandInfo: options.commandInfo,
					errorText: options.errorText,
					sessionName: options.sessionName,
				})
			: undefined;
	const presentation: ToolPresentation = {
		...failure,
		content: [{ type: "text", text: [options.errorText, text].filter(Boolean).join("\n\n") }],
		data: text,
		summary: failure?.summary ?? getNativeTextSummary(text),
	};
	Object.assign(
		presentation,
		await compactLargePresentationOutput({
			artifactManifest: options.artifactManifest,
			commandInfo: options.commandInfo,
			data: presentation.data,
			persistentArtifactStore: options.persistentArtifactStore,
			presentation,
		}),
	);
	return sanitizeModelFacingPresentation(presentation);
}

function isRecordingBatchEnvelope(options: BuildToolPresentationOptions): boolean {
	const data = options.envelope?.data;
	return (
		options.commandInfo.command === "batch" &&
		isAgentBrowserBatchResultArray(data) &&
		data.some((row) => row.command?.[0] === "record")
	);
}

export async function buildEarlyPresentation(
	options: BuildToolPresentationOptions,
	commands: {
		readonly commandInfo: CommandInfo;
		readonly presentationCommandInfo: CommandInfo;
	},
): Promise<ToolPresentation | undefined> {
	if (options.textOutput === true) {
		return buildNativeTextPresentation(options, commands.commandInfo);
	}
	const envelopeData = options.envelope?.data;
	if (
		options.errorText !== undefined &&
		options.errorText.length > 0 &&
		options.commandInfo.command !== "record" &&
		!isRecordingBatchEnvelope(options)
	) {
		return {
			...buildErrorPresentation({
				args: options.args,
				commandInfo: options.commandInfo,
				errorData: envelopeData,
				errorText: options.errorText,
				presentationCommand: commands.presentationCommandInfo.command,
				sessionName: options.sessionName,
			}),
			data: redactPresentationData(commands.commandInfo, envelopeData),
		};
	}
	return undefined;
}
