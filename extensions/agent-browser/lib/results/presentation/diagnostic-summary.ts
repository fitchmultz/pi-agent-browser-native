import type { CommandInfo } from "../../argv-descriptor.js";
import { sanitizeRenderedSingleLine } from "../../display-sanitize.js";
import { redactSensitiveText } from "../../runtime.js";
import { formatCount, getArrayField, getStringField } from "./common.js";

type Data = Readonly<Record<string, unknown>>;

export function isClearDiagnosticCommand(commandInfo: CommandInfo): boolean {
	return (
		commandInfo.subcommand === "--clear" || commandInfo.commandTokens?.includes("--clear") === true
	);
}

function sessionSummary(data: Data): string | undefined {
	const sessions = getArrayField(data, "sessions");
	if (sessions) {
		return `Sessions: ${sessions.length}`;
	}
	const session = getStringField(data, "session");
	return session === undefined ? undefined : `Session: ${sanitizeRenderedSingleLine(session)}`;
}

function authSummary(command: CommandInfo, data: Data): string | undefined {
	const profiles = getArrayField(data, "profiles");
	if (profiles) {
		return `Auth profiles: ${profiles.length}`;
	}
	const rawName =
		getStringField(data, "name") ?? getStringField(data, "profile") ?? command.subcommand;
	if (rawName === undefined || rawName.length === 0) {
		return undefined;
	}
	const name = sanitizeRenderedSingleLine(rawName);
	if (command.subcommand === "show") {
		return `Auth profile: ${name}`;
	}
	if (["save", "login", "delete"].includes(command.subcommand ?? "")) {
		return `Auth ${command.subcommand ?? ""}: ${name}`;
	}
	return undefined;
}

function cookiesSummary(data: Data): string | undefined {
	const cookies = getArrayField(data, "cookies");
	if (cookies) {
		return `Cookies: ${cookies.length}`;
	}
	const name = getStringField(data, "name");
	if (name !== undefined) {
		return sanitizeRenderedSingleLine(name);
	}
	if (data.set === true) {
		return "Cookie set";
	}
	return data.cleared === true || data.clear === true ? "Cookies cleared" : undefined;
}

function storageSummary(command: CommandInfo, data: Data): string | undefined {
	const entries = getArrayField(data, "entries") ?? getArrayField(data, "items");
	if (entries) {
		return `Storage entries: ${entries.length}`;
	}
	const key = getStringField(data, "key");
	if (
		key !== undefined &&
		(command.subcommand === "set" || data.set === true || Object.hasOwn(data, "value"))
	) {
		return `Storage set: ${sanitizeRenderedSingleLine(key)}`;
	}
	return data.cleared === true || data.clear === true ? "Storage cleared" : undefined;
}

function dialogSummary(data: Data): string | undefined {
	if (typeof data.open === "boolean") {
		return data.open ? "Dialog open" : "No dialog open";
	}
	if (data.accepted === true) {
		return "Dialog accepted";
	}
	return data.dismissed === true ? "Dialog dismissed" : undefined;
}

function stateName(command: CommandInfo, data: Data): string | undefined {
	return (
		getStringField(data, "name") ??
		getStringField(data, "file") ??
		getStringField(data, "filename") ??
		getStringField(data, "path") ??
		command.subcommand
	);
}

function stateSummary(command: CommandInfo, data: Data): string | undefined {
	const states = getArrayField(data, "states") ?? getArrayField(data, "files");
	if (states) {
		return `States: ${states.length}`;
	}
	if (command.subcommand === "load") {
		return undefined;
	}
	const name = stateName(command, data);
	return name === undefined || name.length === 0
		? undefined
		: `State ${command.subcommand ?? "result"}: ${sanitizeRenderedSingleLine(name)}`;
}

function bufferSummary(
	command: CommandInfo,
	data: Data,
	field: string,
	label: string,
): string | undefined {
	const rows = getArrayField(data, field);
	if (!rows) {
		return undefined;
	}
	return isClearDiagnosticCommand(command)
		? `${field === "messages" ? "Console" : label} reset: ${rows.length} cleared`
		: `${label}: ${rows.length}`;
}

function networkRouteSummary(data: Data, operation: "route" | "unroute"): string {
	const target =
		getStringField(data, operation === "route" ? "routed" : "unrouted") ??
		getStringField(data, "url") ??
		getStringField(data, "pattern");
	if (target !== undefined) {
		return `Network ${operation}: ${sanitizeRenderedSingleLine(redactSensitiveText(target))}`;
	}
	return operation === "route" ? "Network route configured" : "Network route removed";
}

function networkSummary(command: CommandInfo, data: Data): string | undefined {
	switch (command.subcommand ?? "") {
		case "requests":
			return bufferSummary(command, data, "requests", "Network requests");
		case "route":
			return networkRouteSummary(data, "route");
		case "unroute":
			return networkRouteSummary(data, "unroute");
		case "har":
			return `Network HAR: ${getStringField(data, "state") ?? getStringField(data, "status") ?? "har"}`;
		default:
			return undefined;
	}
}

function streamSummary(command: CommandInfo, data: Data): string | undefined {
	if (command.subcommand === "disable") {
		return "Stream disabled";
	}
	if (command.subcommand !== "enable") {
		return undefined;
	}
	if (data.alreadyEnabled === true) {
		return "Stream already enabled";
	}
	return `Stream enabled${typeof data.port === "number" ? ` on port ${data.port}` : ""}`;
}

function dashboardSummary(data: Data): string | undefined {
	if (typeof data.port === "number") {
		return `Dashboard running on port ${data.port}`;
	}
	if (data.stopped === true) {
		return "Dashboard stopped";
	}
	if (data.stopped !== false) {
		return undefined;
	}
	const reason = getStringField(data, "reason");
	return reason === undefined
		? "Dashboard not stopped"
		: `Dashboard not stopped: ${sanitizeRenderedSingleLine(reason)}`;
}

function doctorSummary(data: Data): string | undefined {
	const status = getStringField(data, "status") ?? getStringField(data, "result");
	if (status !== undefined) {
		return `Doctor: ${sanitizeRenderedSingleLine(status)}`;
	}
	const checks =
		getArrayField(data, "checks") ??
		getArrayField(data, "issues") ??
		getArrayField(data, "problems");
	return checks ? `Doctor: ${formatCount(checks.length, "item")}` : undefined;
}

function profilesSummary(data: Data): string | undefined {
	const profiles = getArrayField(data, "profiles");
	return profiles ? `Chrome profiles: ${profiles.length}` : undefined;
}

function frameSummary(command: CommandInfo, data: Data): string | undefined {
	const frame =
		getStringField(data, "frame") ??
		getStringField(data, "name") ??
		getStringField(data, "selector") ??
		command.subcommand;
	return frame === undefined || frame.length === 0
		? undefined
		: `Frame: ${sanitizeRenderedSingleLine(frame)}`;
}

function diffSummary(command: CommandInfo): string | undefined {
	if (command.subcommand === "snapshot") {
		return "Snapshot diff completed";
	}
	return command.subcommand === "url" ? "URL diff completed" : undefined;
}

function traceSummary(command: CommandInfo, data: Data): string | undefined {
	const state =
		getStringField(data, "state") ?? getStringField(data, "status") ?? command.subcommand;
	return state === undefined || state.length === 0
		? undefined
		: `${command.command === "trace" ? "Trace" : "Profiler"}: ${state}`;
}

export function formatDiagnosticSummary(command: CommandInfo, data: Data): string | undefined {
	switch (command.command ?? "") {
		case "session":
			return sessionSummary(data);
		case "profiles":
			return profilesSummary(data);
		case "auth":
			return authSummary(command, data);
		case "cookies":
			return cookiesSummary(data);
		case "storage":
			return storageSummary(command, data);
		case "dialog":
			return dialogSummary(data);
		case "frame":
			return frameSummary(command, data);
		case "state":
			return stateSummary(command, data);
		case "network":
			return networkSummary(command, data);
		case "diff":
			return diffSummary(command);
		case "trace":
		case "profiler":
			return traceSummary(command, data);
		case "highlight":
			return "Element highlighted";
		case "inspect":
			return "DevTools inspect opened";
		case "clipboard":
			return `Clipboard ${command.subcommand ?? "completed"}`;
		case "stream":
			return streamSummary(command, data);
		case "chat":
			return "Chat response";
		case "console":
			return bufferSummary(command, data, "messages", "Console messages");
		case "errors":
			return bufferSummary(command, data, "errors", "Page errors");
		case "dashboard":
			return dashboardSummary(data);
		case "doctor":
			return doctorSummary(data);
		default:
			return undefined;
	}
}
