import { isRecord } from "../../parsing.js";
import type { CommandInfo } from "../../argv-descriptor.js";
import type { ToolPresentation } from "../contracts.js";
import type { ToolPresentationObservation } from "./observation-contracts.js";
import { getSavedFileDetails } from "./artifacts.js";
import { formatWebMcpCatalogUpdate } from "./common.js";
import { formatNetworkRouteDiagnosticsText } from "./diagnostics.js";
import { buildErrorPresentation } from "./errors.js";
import type { BuildToolPresentationOptions } from "./input-contracts.js";
import type { PresentationSource } from "./source.js";

type NoticeOptions = Pick<
	BuildToolPresentationOptions,
	"args" | "commandInfo" | "errorText" | "networkRouteDiagnostics" | "sessionName"
>;

function appendNotice(
	content: ToolPresentationObservation["content"],
	text: string | undefined,
): ToolPresentation["content"] | undefined {
	const first = content.at(0);
	if (text === undefined || text.length === 0 || first?.type !== "text") {
		return;
	}
	return [{ ...first, text: `${first.text}\n\n${text}` }, ...content.slice(1)];
}

function getKeyboardInsertTextWarning(commandInfo: CommandInfo): string | undefined {
	if (commandInfo.command !== "keyboard" || commandInfo.subcommand !== "inserttext") {
		return;
	}
	return "Input dispatch warning: keyboard inserttext skips key events. A DOM value change does not prove a framework-controlled editor accepted it; verify application state before saving, or use keyboard type when real key events are required.";
}

function applyRecordingError(
	draft: ToolPresentationObservation,
	options: NoticeOptions,
	source: PresentationSource,
):
	| Pick<ToolPresentation, "resultCategory" | "failureCategory" | "summary" | "content">
	| undefined {
	if (
		options.errorText === undefined ||
		options.errorText.length === 0 ||
		(!source.recordingCommand && !source.recordingBatch)
	) {
		return;
	}
	const failure = buildErrorPresentation({
		args: options.args,
		commandInfo: options.commandInfo,
		errorText: options.errorText,
		presentationCommand: source.presentationCommandInfo.command,
		sessionName: options.sessionName,
	});
	return {
		resultCategory: "failure",
		failureCategory: failure.failureCategory,
		summary: failure.summary,
		content: [
			{
				type: "text",
				text: `${failure.content[0]?.type === "text" ? failure.content[0].text : options.errorText}\n\n${draft.content[0]?.type === "text" ? draft.content[0].text : ""}`,
			},
		],
	};
}

function applyNetworkNotices(
	content: ToolPresentationObservation["content"],
	options: NoticeOptions,
):
	| (Pick<ToolPresentation, "networkRouteDiagnostics"> & Partial<Pick<ToolPresentation, "content">>)
	| undefined {
	const diagnostics = options.networkRouteDiagnostics;
	const first = content.at(0);
	if (!diagnostics || diagnostics.length === 0 || first?.type !== "text") {
		return;
	}
	const text = formatNetworkRouteDiagnosticsText(diagnostics);
	return {
		networkRouteDiagnostics: diagnostics,
		...(text !== undefined && text.length > 0
			? { content: [{ ...first, text: `${text}\n\n${first.text}` }, ...content.slice(1)] }
			: {}),
	};
}

function applySavedFile(
	source: PresentationSource,
	commandInfo: CommandInfo,
): Pick<ToolPresentation, "savedFile" | "savedFilePath"> | undefined {
	if (!isRecord(source.data)) {
		return;
	}
	const savedFile = getSavedFileDetails(commandInfo, source.data);
	return savedFile ? { savedFile, savedFilePath: savedFile.path } : undefined;
}

function sourceNotices(
	options: NoticeOptions,
	source: PresentationSource,
): readonly (string | undefined)[] {
	const notices: (string | undefined)[] = [];
	const data = source.presentationData;
	if (
		isRecord(data) &&
		isRecord(data.webmcp) &&
		(Array.isArray(data.webmcp.tools) || data.webmcp.status === "unavailable")
	) {
		notices.push(formatWebMcpCatalogUpdate(data.webmcp));
	}
	if (
		options.commandInfo.command === "screenshot" &&
		(options.args?.includes("--annotate") ?? false)
	) {
		notices.push(
			"Annotated screenshot note: dense pages can produce overlapping labels. If the labels are noisy, capture a scoped element screenshot, take a non-annotated screenshot, or use snapshot -i high-value refs as the machine-readable map.",
		);
	}
	notices.push(getKeyboardInsertTextWarning(source.commandInfo));
	return notices;
}

export function applyPresentationNotices(
	draft: ToolPresentationObservation,
	options: NoticeOptions,
	source: PresentationSource,
): Partial<ToolPresentation> {
	const recording = applyRecordingError(draft, options, source);
	const network = applyNetworkNotices(recording?.content ?? draft.content, options);
	const savedFile = applySavedFile(source, options.commandInfo);
	let content = network?.content ?? recording?.content;
	for (const notice of sourceNotices(options, source)) {
		content = appendNotice(content ?? draft.content, notice) ?? content;
	}
	return { ...recording, ...network, ...savedFile, ...(content ? { content } : {}) };
}
