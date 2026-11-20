import type { CommandInfo } from "../../argv-descriptor.js";
import { sanitizeRenderedSingleLine } from "../../display-sanitize.js";
import { redactSensitiveText } from "../../runtime.js";
import {
	getArrayField,
	getStringField,
	redactModelFacingText,
	stringifyModelFacing,
} from "./common.js";
import { omitUpstreamLifecycle } from "./lifecycle.js";
import { formatA11yText } from "./diagnostic-a11y.js";
import { formatDashboardText, formatDoctorText } from "./diagnostic-health.js";
import {
	formatAuthShowText,
	formatProfilesText,
	formatSessionText,
	formatStateText,
} from "./diagnostic-identity.js";
import { formatConsoleText, formatErrorsText } from "./diagnostic-logs.js";
import { formatNetworkRequestText, formatNetworkRequestsText } from "./diagnostic-network.js";
import { formatCookiesText, formatStorageText } from "./diagnostic-storage.js";
import { getStreamSummary } from "./diagnostic-stream.js";

export { getTabSummary, formatProfilesText } from "./diagnostic-identity.js";
export {
	buildNetworkRequestsNextActions,
	formatNetworkRouteDiagnosticsText,
} from "./diagnostic-network-actions.js";
export { redactPresentationData } from "./diagnostic-redaction.js";
export {
	buildStreamNextActions,
	enrichStreamStatusData,
	getStreamSummary,
} from "./diagnostic-stream.js";
export { formatDiagnosticSummary } from "./diagnostic-summary.js";

type Data = Readonly<Record<string, unknown>>;

function formatProfileCommand(command: CommandInfo, data: Data): string | undefined {
	const profiles = getArrayField(data, "profiles");
	if (profiles) {
		return formatProfilesText(
			profiles,
			command.command === "profiles" ? "Chrome profiles" : "auth profiles",
		);
	}
	return command.command === "auth" && command.subcommand === "show"
		? formatAuthShowText(data)
		: undefined;
}

function formatDialogText(data: Data): string | undefined {
	const lines: string[] = [];
	if (typeof data.open === "boolean") {
		lines.push(data.open ? "Dialog open." : "No dialog open.");
	}
	const type = getStringField(data, "type");
	if (type !== undefined) {
		lines.push(`Type: ${sanitizeRenderedSingleLine(redactModelFacingText(type))}`);
	}
	const message = getStringField(data, "message");
	if (message !== undefined) {
		lines.push(`Message: ${sanitizeRenderedSingleLine(redactModelFacingText(message))}`);
	}
	if (data.accepted === true) {
		lines.push("Accepted.");
	}
	if (data.dismissed === true) {
		lines.push("Dismissed.");
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatFrameText(data: Data): string | undefined {
	const frame =
		getStringField(data, "frame") ??
		getStringField(data, "name") ??
		getStringField(data, "selector");
	const url = getStringField(data, "url");
	const title = getStringField(data, "title");
	const lines = [
		frame === undefined
			? undefined
			: `Frame: ${sanitizeRenderedSingleLine(redactModelFacingText(frame))}`,
		title === undefined
			? undefined
			: `Title: ${sanitizeRenderedSingleLine(redactModelFacingText(title))}`,
		url === undefined ? undefined : `URL: ${sanitizeRenderedSingleLine(redactSensitiveText(url))}`,
	].filter(Boolean);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatChatText(data: Data): string | undefined {
	const response =
		getStringField(data, "response") ??
		getStringField(data, "message") ??
		getStringField(data, "text") ??
		getStringField(data, "result");
	if (response !== undefined) {
		return redactModelFacingText(response);
	}
	const model = getStringField(data, "model");
	const provider = getStringField(data, "provider");
	const lines = [
		model === undefined ? undefined : `Model: ${redactModelFacingText(model)}`,
		provider === undefined ? undefined : `Provider: ${redactModelFacingText(provider)}`,
	].filter(Boolean);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatClipboardText(data: Data): string | undefined {
	const text =
		getStringField(data, "text") ?? getStringField(data, "value") ?? getStringField(data, "result");
	return text === undefined ? undefined : redactModelFacingText(text);
}

function formatNetworkText(command: CommandInfo, data: Data): string | undefined {
	if (command.subcommand === "requests") {
		return formatNetworkRequestsText(data, command);
	}
	return command.subcommand === "request" ? formatNetworkRequestText(data) : undefined;
}

export function formatDiagnosticText(command: CommandInfo, data: Data): string | undefined {
	switch (command.command ?? "") {
		case "session":
			return formatSessionText(data);
		case "profiles":
		case "auth":
			return formatProfileCommand(command, data);
		case "cookies":
			return formatCookiesText(data);
		case "storage":
			return formatStorageText(data);
		case "dialog":
			return formatDialogText(data);
		case "frame":
			return formatFrameText(data);
		case "state":
			return formatStateText(data, command.subcommand);
		case "network":
			return formatNetworkText(command, data);
		case "diff":
			return stringifyModelFacing(omitUpstreamLifecycle(data));
		case "clipboard":
			return formatClipboardText(data);
		case "stream":
			return getStreamSummary(data);
		case "chat":
			return formatChatText(data);
		case "console":
			return formatConsoleText(data, command);
		case "errors":
			return formatErrorsText(data, command);
		case "a11y":
			return formatA11yText(data);
		case "dashboard":
			return formatDashboardText(data);
		case "doctor":
			return formatDoctorText(data);
		default:
			return undefined;
	}
}
