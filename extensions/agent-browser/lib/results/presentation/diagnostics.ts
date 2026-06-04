/**
 * Purpose: Render diagnostic command families and safe redacted diagnostic data.
 * Responsibilities: Format sessions, profiles, auth/cookies/storage, network diagnostics, console/errors, stream/dashboard/chat, and build network follow-up actions.
 * Scope: Diagnostic/result-state command presentation only; core orchestration stays in presentation.ts.
 */

import { isRecord } from "../../parsing.js";
import { redactSensitiveText, redactSensitiveValue, type CommandInfo } from "../../runtime.js";
import type { AgentBrowserNextAction, NetworkRouteDiagnostic } from "../contracts.js";
import { classifyNetworkRequestFailure, summarizeNetworkFailures } from "../network.js";
import { withOptionalSessionArgs } from "../next-actions.js";
import { stringifyUnknown, truncateText } from "../text.js";
import {
	firstLine,
	formatCount,
	getArrayField,
	getStringField,
	parseJsonPreviewString,
	redactModelFacingText,
	redactModelFacingTextIfSensitive,
	stringifyModelFacing,
} from "./common.js";

const DIAGNOSTIC_REQUEST_PREVIEW_LIMIT = 40;

const DIAGNOSTIC_LOG_PREVIEW_LIMIT = 80;

const NETWORK_BODY_PREVIEW_MAX_CHARS = 280;

const NETWORK_ERROR_PREVIEW_MAX_CHARS = 220;

const NETWORK_NEXT_ACTION_LIMIT = 6;

const NETWORK_FILTER_MAX_CHARS = 160;

const STORAGE_VALUE_PREVIEW_MAX_CHARS = 160;

const STORAGE_SECRET_KEY_PATTERN = /(?:access(?:_|-)?token|account|api(?:_|-)?key|auth(?:orization)?|bearer|client(?:_|-)?secret|cookie|credential|csrf|email|id(?:_|-)?token|jwt|pass(?:word)?|private(?:_|-)?key|profile|refresh(?:_|-)?token|secret|session|sid|sig(?:nature)?|token|user(?:name)?|x(?:_|-)?api(?:_|-)?key|xsrf)/i;

const STORAGE_BENIGN_KEY_PATTERN = /^(?:(?:.*benign.*)|color(?:scheme)?|debug|dev|experiment|feature(?:flag)?|flag|issue74benignkey|language|layout|locale|mode|onboarding|qakey|sort|stresskey|tab|test|theme|timezone|tour|variant|view)$/i;

const STORAGE_TOKEN_VALUE_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~-]+|\bBasic\s+[A-Za-z0-9+/=]+|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$|(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_~+/=-]{32,})/;

const STORAGE_SECRET_VALUE_WORD_PATTERN = /(?:secret|token|password|passwd|bearer|credential|authorization|cookie|session[-_ ]?id)/i;

const STORAGE_EMAIL_VALUE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STORAGE_IDENTITY_VALUE_PATTERN = /(?:^|[\s:=/_-])(?:account|profile|session|sid|user(?:id|name)?)(?:[\s:=/_-]|$)/i;

const NETWORK_FILTER_SENSITIVE_SEGMENT_TERMS = [
	"apikey",
	"api-key",
	"api_key",
	"authentication",
	"authorization",
	"bearer",
	"credential",
	"credentials",
	"jwt",
	"passwd",
	"password",
	"reset",
	"secret",
	"session",
	"token",
] as const;

const SENSITIVE_PRESENTATION_FIELD_PATTERN = /^(?:access(?:_|-)?token|api(?:_|-)?key|auth(?:orization)?|bearer|client(?:_|-)?secret|cookie|id(?:_|-)?token|pass(?:word)?|proxy(?:_|-)?authorization|refresh(?:_|-)?token|secret|session(?:_|-)?id|set(?:_|-)?cookie|sig(?:nature)?|token|x(?:_|-)?api(?:_|-)?key)$/i;

const NETWORK_FILTER_OPAQUE_SEGMENT_PATTERN = /^(?:[A-Fa-f0-9]{16,}|(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{16,})$/;

const NETWORK_PREVIEW_FIELD_CANDIDATES = {
	request: ["postData"] as const,
	response: ["responseBody"] as const,
	error: ["error", "failureText", "errorText"] as const,
};

const AUTH_SHOW_SAFE_FIELDS = ["name", "profile", "url", "username", "createdAt", "updatedAt"] as const;

export function getTabSummary(data: Record<string, unknown>): string | undefined {
	const tabs = Array.isArray(data.tabs) ? data.tabs : undefined;
	if (!tabs) return undefined;

	const lines = tabs.map((tab, index) => {
		if (!isRecord(tab)) return `${index}: <invalid tab>`;
		const marker = tab.active === true ? "*" : "-";
		const title = typeof tab.title === "string" ? tab.title : "(untitled)";
		const url = typeof tab.url === "string" ? tab.url : "(no url)";
		const tabSelector =
			typeof tab.tabId === "string" && tab.tabId.trim().length > 0
				? tab.tabId.trim()
				: typeof tab.label === "string" && tab.label.trim().length > 0
					? tab.label.trim()
					: typeof tab.index === "number"
						? String(tab.index)
						: String(index);
		return `${marker} [${tabSelector}] ${title} — ${url}`;
	});
	return lines.join("\n");
}

export function getStreamSummary(data: Record<string, unknown>): string | undefined {
	if (data.alreadyEnabled === true) {
		const lines = ["Stream already enabled (idempotent no-op)."];
		if (typeof data.port === "number") {
			lines.push(`Port: ${data.port}`);
			lines.push(`WebSocket URL: ${getStreamWebSocketUrl(data.port)}`);
		}
		lines.push("Run stream status for current connection details or stream disable when streaming is no longer needed.");
		return lines.join("\n");
	}
	if (typeof data.enabled !== "boolean" || typeof data.connected !== "boolean") {
		return undefined;
	}

	const lines = [
		`Enabled: ${data.enabled}`,
		`Connected: ${data.connected}`,
		`Screencasting: ${data.screencasting === true}`,
	];
	if (typeof data.port === "number") {
		lines.push(`Port: ${data.port}`);
		lines.push(`WebSocket URL: ${getStreamWebSocketUrl(data.port)}`);
		lines.push(`Frame format: JSON messages with base64 JPEG frame data`);
	}
	return lines.join("\n");
}

function getStreamWebSocketUrl(port: number): string {
	return `ws://127.0.0.1:${port}`;
}

export function enrichStreamStatusData(commandInfo: CommandInfo, data: unknown): unknown {
	if (commandInfo.command !== "stream" || commandInfo.subcommand !== "status" || !isRecord(data) || typeof data.port !== "number") {
		return data;
	}
	return {
		...data,
		frameFormat: "JSON messages with base64 JPEG frame data",
		wsUrl: getStreamWebSocketUrl(data.port),
	};
}

export function formatDiagnosticSummary(commandInfo: CommandInfo, data: Record<string, unknown>): string | undefined {
	if (commandInfo.command === "session") {
		const sessions = getArrayField(data, "sessions");
		if (sessions) return `Sessions: ${sessions.length}`;
		const session = getStringField(data, "session");
		if (session) return `Session: ${session}`;
	}

	if (commandInfo.command === "profiles") {
		const profiles = getArrayField(data, "profiles");
		if (profiles) return `Chrome profiles: ${profiles.length}`;
	}

	if (commandInfo.command === "auth") {
		const profiles = getArrayField(data, "profiles");
		if (profiles) return `Auth profiles: ${profiles.length}`;
		const name = getStringField(data, "name") ?? getStringField(data, "profile") ?? commandInfo.subcommand;
		if (name && commandInfo.subcommand === "show") return `Auth profile: ${name}`;
		if (name && ["save", "login", "delete"].includes(commandInfo.subcommand ?? "")) return `Auth ${commandInfo.subcommand}: ${name}`;
	}

	if (commandInfo.command === "cookies") {
		const cookies = getArrayField(data, "cookies");
		if (cookies) return `Cookies: ${cookies.length}`;
		const name = getStringField(data, "name");
		if (name) return name;
		if (data.set === true) return "Cookie set";
		if (data.cleared === true || data.clear === true) return "Cookies cleared";
	}

	if (commandInfo.command === "storage") {
		const entries = getArrayField(data, "entries") ?? getArrayField(data, "items");
		if (entries) return `Storage entries: ${entries.length}`;
		const key = getStringField(data, "key");
		if (key && (commandInfo.subcommand === "set" || data.set === true || Object.hasOwn(data, "value"))) return `Storage set: ${key}`;
		if (data.cleared === true || data.clear === true) return "Storage cleared";
	}

	if (commandInfo.command === "dialog") {
		const open = typeof data.open === "boolean" ? data.open : undefined;
		if (open !== undefined) return open ? "Dialog open" : "No dialog open";
		if (data.accepted === true) return "Dialog accepted";
		if (data.dismissed === true) return "Dialog dismissed";
	}

	if (commandInfo.command === "frame") {
		const frame = getStringField(data, "frame") ?? getStringField(data, "name") ?? getStringField(data, "selector") ?? commandInfo.subcommand;
		if (frame) return `Frame: ${frame}`;
	}

	if (commandInfo.command === "state") {
		const states = getArrayField(data, "states") ?? getArrayField(data, "files");
		if (states) return `States: ${states.length}`;
		if (commandInfo.subcommand === "load") return undefined;
		const stateName = getStringField(data, "name") ?? getStringField(data, "file") ?? getStringField(data, "path") ?? commandInfo.subcommand;
		if (stateName) return `State ${commandInfo.subcommand ?? "result"}: ${stateName}`;
	}

	if (commandInfo.command === "network") {
		if (commandInfo.subcommand === "requests") {
			const requests = getArrayField(data, "requests");
			if (requests) return `Network requests: ${requests.length}`;
		}
		if (commandInfo.subcommand === "route") {
			const routed = getStringField(data, "routed") ?? getStringField(data, "url") ?? getStringField(data, "pattern");
			return routed ? `Network route: ${redactModelFacingTextIfSensitive(routed)}` : "Network route configured";
		}
		if (commandInfo.subcommand === "unroute") {
			const unrouted = getStringField(data, "unrouted") ?? getStringField(data, "url") ?? getStringField(data, "pattern");
			return unrouted ? `Network unroute: ${redactModelFacingTextIfSensitive(unrouted)}` : "Network route removed";
		}
		if (commandInfo.subcommand === "har") {
			const state = getStringField(data, "state") ?? getStringField(data, "status") ?? commandInfo.subcommand;
			return `Network HAR: ${state}`;
		}
	}

	if (commandInfo.command === "diff") {
		if (commandInfo.subcommand === "snapshot") return "Snapshot diff completed";
		if (commandInfo.subcommand === "url") return "URL diff completed";
	}

	if (["trace", "profiler"].includes(commandInfo.command ?? "")) {
		const state = getStringField(data, "state") ?? getStringField(data, "status") ?? commandInfo.subcommand;
		if (state) return `${commandInfo.command === "trace" ? "Trace" : "Profiler"}: ${state}`;
	}

	if (commandInfo.command === "highlight") return "Element highlighted";
	if (commandInfo.command === "inspect") return "DevTools inspect opened";
	if (commandInfo.command === "clipboard") return `Clipboard ${commandInfo.subcommand ?? "completed"}`;

	if (commandInfo.command === "stream") {
		if (commandInfo.subcommand === "enable") {
			if (data.alreadyEnabled === true) return "Stream already enabled";
			const port = typeof data.port === "number" ? ` on port ${data.port}` : "";
			return `Stream enabled${port}`;
		}
		if (commandInfo.subcommand === "disable") return "Stream disabled";
	}

	if (commandInfo.command === "chat") return "Chat response";

	if (commandInfo.command === "console") {
		const messages = getArrayField(data, "messages");
		if (messages) return `Console messages: ${messages.length}`;
	}

	if (commandInfo.command === "errors") {
		const errors = getArrayField(data, "errors");
		if (errors) return `Page errors: ${errors.length}`;
	}

	if (commandInfo.command === "dashboard") {
		if (typeof data.port === "number") return `Dashboard running on port ${data.port}`;
		if (data.stopped === true) return "Dashboard stopped";
		if (data.stopped === false) {
			const reason = getStringField(data, "reason");
			return reason ? `Dashboard not stopped: ${reason}` : "Dashboard not stopped";
		}
	}

	if (commandInfo.command === "doctor") {
		const status = getStringField(data, "status") ?? getStringField(data, "result");
		if (status) return `Doctor: ${status}`;
		const checks = getArrayField(data, "checks") ?? getArrayField(data, "issues") ?? getArrayField(data, "problems");
		if (checks) return `Doctor: ${formatCount(checks.length, "item")}`;
	}

	return undefined;
}

function formatSessionText(data: Record<string, unknown>): string | undefined {
	const sessions = getArrayField(data, "sessions");
	if (sessions) {
		if (sessions.length === 0) return "No active sessions.";
		return sessions
			.map((item, index) => {
				if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
				const name = redactModelFacingText(getStringField(item, "name") ?? getStringField(item, "session") ?? getStringField(item, "id") ?? `(session ${index + 1})`);
				const active = item.active === true ? " *active*" : "";
				const details = [getStringField(item, "url"), getStringField(item, "title")]
					.flatMap((detail) => (detail ? [redactModelFacingTextIfSensitive(detail)] : []))
					.join(" — ");
				return details ? `${index + 1}. ${name}${active} — ${details}` : `${index + 1}. ${name}${active}`;
			})
			.join("\n");
	}
	const session = getStringField(data, "session");
	return session ? `Current session: ${redactModelFacingText(session)}` : undefined;
}

export function formatProfilesText(profiles: unknown[], label: string): string {
	if (profiles.length === 0) return `No ${label}.`;
	return profiles
		.map((item, index) => {
			if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
			const name = redactModelFacingText(getStringField(item, "name") ?? getStringField(item, "profile") ?? `(unnamed ${index + 1})`);
			const directory = getStringField(item, "directory") ?? getStringField(item, "path");
			return directory ? `${index + 1}. ${name} (${redactModelFacingText(directory)})` : `${index + 1}. ${name}`;
		})
		.join("\n");
}

function formatAuthShowText(data: Record<string, unknown>): string | undefined {
	const lines = AUTH_SHOW_SAFE_FIELDS.flatMap((key) => {
		const value = data[key];
		return typeof value === "string" && value.trim().length > 0 ? [`${key}: ${redactModelFacingText(value.trim())}`] : [];
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function getPreviewCandidate(item: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		const value = item[key];
		if (value !== undefined && value !== null && value !== "") return value;
	}
	return undefined;
}

function formatNetworkPreviewValue(value: unknown, maxChars: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	const previewValue = typeof value === "string" ? parseJsonPreviewString(value) : value;
	const redacted = redactSensitiveValue(previewValue);
	const raw = typeof redacted === "string" ? redacted : stringifyUnknown(redacted);
	const normalized = raw.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return undefined;
	return truncateText(redactSensitiveText(normalized), maxChars);
}

function appendNetworkPreview(lines: string[], label: string, value: unknown, maxChars: number): void {
	const preview = formatNetworkPreviewValue(value, maxChars);
	if (!preview) return;
	lines.push(`   ${label}: ${preview}`);
}

function formatNetworkRequestLine(item: Record<string, unknown>, index: number): string[] {
	const method = getStringField(item, "method") ?? "GET";
	const status = typeof item.status === "number" ? String(item.status) : "pending";
	const type = getStringField(item, "resourceType") ?? getStringField(item, "mimeType");
	const url = getStringField(item, "url") ?? "(no url)";
	const requestId = getStringField(item, "requestId") ?? getStringField(item, "id");
	const idText = requestId ? ` [${redactSensitiveText(requestId)}]` : "";
	const failureClassification = classifyNetworkRequestFailure(item);
	const impactText = failureClassification ? ` [${failureClassification.impact}: ${failureClassification.reason}]` : "";
	const lines = [`${index + 1}. ${status} ${method} ${truncateText(redactSensitiveText(url), 180)}${type ? ` (${type})` : ""}${idText}${impactText}`];
	appendNetworkPreview(lines, "Payload", getPreviewCandidate(item, NETWORK_PREVIEW_FIELD_CANDIDATES.request), NETWORK_BODY_PREVIEW_MAX_CHARS);
	appendNetworkPreview(lines, "Response", getPreviewCandidate(item, NETWORK_PREVIEW_FIELD_CANDIDATES.response), NETWORK_BODY_PREVIEW_MAX_CHARS);
	appendNetworkPreview(lines, "Error", getPreviewCandidate(item, NETWORK_PREVIEW_FIELD_CANDIDATES.error), NETWORK_ERROR_PREVIEW_MAX_CHARS);
	return lines;
}

function formatNetworkRequestsText(data: Record<string, unknown>): string | undefined {
	const requests = getArrayField(data, "requests");
	if (!requests) return undefined;
	if (requests.length === 0) return "No network requests captured.";
	const networkFailureSummary = summarizeNetworkFailures(requests);
	const shown = networkFailureSummary.totalCount > 0
		? [`Network failure summary: ${networkFailureSummary.actionableCount} actionable, ${networkFailureSummary.benignCount} benign low-impact (${networkFailureSummary.totalCount} total).`]
		: [];
	const indexedRequests = requests.map((item, index) => ({ index, item }));
	const failedRequests: typeof indexedRequests = [];
	const normalRequests: typeof indexedRequests = [];
	for (const indexed of indexedRequests) {
		if (isRecord(indexed.item) && classifyNetworkRequestFailure(indexed.item)) failedRequests.push(indexed);
		else normalRequests.push(indexed);
	}
	failedRequests.sort((left, right) => {
		const leftClassification = isRecord(left.item) ? classifyNetworkRequestFailure(left.item) : undefined;
		const rightClassification = isRecord(right.item) ? classifyNetworkRequestFailure(right.item) : undefined;
		const leftRank = leftClassification?.impact === "actionable" ? 0 : 1;
		const rightRank = rightClassification?.impact === "actionable" ? 0 : 1;
		return leftRank - rightRank || left.index - right.index;
	});
	const prioritizedRequests = [...failedRequests, ...normalRequests];
	shown.push(...prioritizedRequests.slice(0, DIAGNOSTIC_REQUEST_PREVIEW_LIMIT).flatMap(({ item, index }) => {
		if (!isRecord(item)) return [`${index + 1}. ${stringifyModelFacing(item)}`];
		return formatNetworkRequestLine(item, index);
	}));
	if (requests.length > DIAGNOSTIC_REQUEST_PREVIEW_LIMIT) {
		shown.push(`... (${requests.length - DIAGNOSTIC_REQUEST_PREVIEW_LIMIT} additional requests omitted from preview; failed requests are shown first when present)`);
	}
	return shown.join("\n");
}

function formatNetworkRequestText(data: Record<string, unknown>): string | undefined {
	if (!getStringField(data, "url") && !getStringField(data, "requestId") && !getStringField(data, "id")) {
		return undefined;
	}
	return formatNetworkRequestLine(data, 0).join("\n");
}

interface NetworkRequestActionCandidate {
	filter?: string;
	item: Record<string, unknown>;
	kind: "actionable" | "api" | "benign" | "request";
	requestId: string;
}

function getSafeNetworkActionValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || redactSensitiveText(trimmed) !== trimmed) return undefined;
	return trimmed;
}

function getNetworkRequestId(item: Record<string, unknown>): string | undefined {
	return getSafeNetworkActionValue(getStringField(item, "requestId") ?? getStringField(item, "id"));
}

function isSensitiveNetworkPathSegment(segment: string): boolean {
	const normalized = segment.toLowerCase();
	return normalized === "auth" || NETWORK_FILTER_SENSITIVE_SEGMENT_TERMS.some((term) => normalized.includes(term));
}

function pathFilterMayExposeSensitiveSegment(filter: string): boolean {
	const decoded = (() => {
		try {
			return decodeURIComponent(filter);
		} catch {
			return filter;
		}
	})();
	return decoded.split("/").some((segment) => isSensitiveNetworkPathSegment(segment) || NETWORK_FILTER_OPAQUE_SEGMENT_PATTERN.test(segment));
}

function getNetworkRequestPathFilter(item: Record<string, unknown>): string | undefined {
	const url = getStringField(item, "url");
	if (!url) return undefined;
	let filter: string | undefined;
	try {
		filter = new URL(url).pathname;
	} catch {
		filter = url.split(/[?#]/, 1)[0];
	}
	filter = filter?.trim();
	if (!filter || filter === "/" || filter.length > NETWORK_FILTER_MAX_CHARS || pathFilterMayExposeSensitiveSegment(filter)) return undefined;
	return getSafeNetworkActionValue(filter);
}

function isApiLikeNetworkRequest(item: Record<string, unknown>): boolean {
	const method = (getStringField(item, "method") ?? "GET").toUpperCase();
	const resourceType = (getStringField(item, "resourceType") ?? "").toLowerCase();
	const mimeType = (getStringField(item, "mimeType") ?? "").toLowerCase();
	const filter = getNetworkRequestPathFilter(item) ?? "";
	return resourceType === "fetch" || resourceType === "xhr" || mimeType.includes("json") || /\/(?:api|graphql|rpc)(?:\/|$)/i.test(filter) || !["GET", "HEAD"].includes(method);
}

function getNetworkRequestActionCandidate(item: Record<string, unknown>): NetworkRequestActionCandidate | undefined {
	const requestId = getNetworkRequestId(item);
	if (!requestId) return undefined;
	const classification = classifyNetworkRequestFailure(item);
	const kind: NetworkRequestActionCandidate["kind"] = classification?.impact === "actionable"
		? "actionable"
		: classification?.impact === "benign"
			? "benign"
			: isApiLikeNetworkRequest(item)
				? "api"
				: "request";
	return { filter: getNetworkRequestPathFilter(item), item, kind, requestId };
}

function chooseNetworkRequestActionCandidate(candidates: NetworkRequestActionCandidate[]): NetworkRequestActionCandidate | undefined {
	return candidates.find((candidate) => candidate.kind === "actionable")
		?? candidates.find((candidate) => candidate.kind === "api")
		?? candidates.find((candidate) => candidate.kind === "benign")
		?? candidates[0];
}

function formatNetworkRequestActionDescriptor(candidate: NetworkRequestActionCandidate): string {
	const method = getStringField(candidate.item, "method") ?? "GET";
	const status = typeof candidate.item.status === "number" ? String(candidate.item.status) : "pending";
	const target = candidate.filter ? ` ${candidate.filter}` : "";
	return `${status} ${method}${target} [${candidate.requestId}]`;
}

function getNetworkRequestDetailActionId(candidate: NetworkRequestActionCandidate): string {
	if (candidate.kind === "actionable") return "inspect-actionable-network-request";
	if (candidate.kind === "benign") return "inspect-benign-network-request";
	return "inspect-network-request";
}

export function formatNetworkRouteDiagnosticsText(diagnostics: NetworkRouteDiagnostic[] | undefined): string | undefined {
	if (!diagnostics || diagnostics.length === 0) return undefined;
	const lines = ["Network route diagnostics:"];
	for (const diagnostic of diagnostics) {
		const target = diagnostic.requestId ? `[${diagnostic.requestId}] ${diagnostic.requestUrl ?? "request"}` : diagnostic.requestUrl ?? "request";
		lines.push(`- ${diagnostic.reason}: ${target} matched route ${diagnostic.routePattern} (${diagnostic.mode}).`);
	}
	lines.push("If this route is intended as a mock, verify the page origin/CORS headers and inspect the request before assuming the mock fulfilled normally.");
	return lines.join("\n");
}

export function buildNetworkRouteDiagnosticsNextActions(diagnostics: NetworkRouteDiagnostic[] | undefined, sessionName: string | undefined): AgentBrowserNextAction[] | undefined {
	const diagnostic = diagnostics?.find((item) => item.requestId) ?? diagnostics?.[0];
	if (!diagnostic) return undefined;
	const actions: AgentBrowserNextAction[] = [];
	if (diagnostic.requestId) {
		actions.push({
			id: "inspect-pending-routed-network-request",
			params: { args: withOptionalSessionArgs(sessionName, ["network", "request", diagnostic.requestId]) },
			reason: `Inspect the routed request ${diagnostic.requestId} before assuming the route mock fulfilled normally.`,
			safety: "Read-only request diagnostic; look for pending state, CORS/preflight errors, response status, and headers.",
			tool: "agent_browser",
		});
	}
	actions.push({
		id: "start-network-har-capture-for-route-mock",
		params: { args: withOptionalSessionArgs(sessionName, ["network", "har", "start"]) },
		reason: "Capture a HAR before reproducing the route mock so pending/CORS behavior has request and response headers.",
		safety: "HARs can contain URLs and headers; stop to an explicit path and avoid sharing sensitive captures.",
		tool: "agent_browser",
	});
	actions.push({
		id: "retry-route-mock-same-origin-fixture",
		reason: "Retry the mock against a same-origin HTTP fixture or add CORS headers if the routed request is cross-origin.",
		safety: "Guidance only; do not change the target origin without preserving the user-intended scenario.",
		tool: "agent_browser",
	});
	return actions;
}

export function buildNetworkRequestsNextActions(data: unknown, sessionName: string | undefined, routeDiagnostics?: NetworkRouteDiagnostic[]): AgentBrowserNextAction[] | undefined {
	if (!isRecord(data)) return undefined;
	const requests = getArrayField(data, "requests");
	if (!requests) return undefined;
	const candidates = requests.flatMap((item) => {
		if (!isRecord(item)) return [];
		const candidate = getNetworkRequestActionCandidate(item);
		return candidate ? [candidate] : [];
	});
	const selected = chooseNetworkRequestActionCandidate(candidates);
	if (!selected) return undefined;
	const descriptor = formatNetworkRequestActionDescriptor(selected);
	const actions: AgentBrowserNextAction[] = [
		{
			id: getNetworkRequestDetailActionId(selected),
			params: { args: withOptionalSessionArgs(sessionName, ["network", "request", selected.requestId]) },
			reason: `Inspect full request details for ${descriptor}.`,
			safety: "Read-only network diagnostic; request inspection must not replace the active page/ref context.",
			tool: "agent_browser",
		},
	];
	if (selected.kind === "actionable") {
		actions.push({
			id: "trace-actionable-network-source",
			params: { networkSourceLookup: { requestId: selected.requestId, ...(sessionName ? { session: sessionName } : {}) } },
			reason: `Look for local source candidates related to ${descriptor}.`,
			safety: "Read-only experimental helper; it reports bounded candidates and may miss bundled or dynamic call sites.",
			tool: "agent_browser",
		});
	}
	if (selected.filter) {
		actions.push({
			id: "filter-network-requests-by-path",
			params: { args: withOptionalSessionArgs(sessionName, ["network", "requests", "--filter", selected.filter]) },
			reason: `List captured requests matching ${selected.filter}.`,
			safety: "Read-only request-list filter; absence from a compact preview is not proof the request did not happen.",
			tool: "agent_browser",
		});
	}
	actions.push({
		id: "start-network-har-capture",
		params: { args: withOptionalSessionArgs(sessionName, ["network", "har", "start"]) },
		reason: "Start HAR capture before reproducing the network behavior again.",
		safety: "HARs can contain URLs and headers; stop to an explicit path, inspect metadata, and avoid sharing sensitive captures.",
		tool: "agent_browser",
	});
	return [...(buildNetworkRouteDiagnosticsNextActions(routeDiagnostics, sessionName) ?? []), ...actions].slice(0, NETWORK_NEXT_ACTION_LIMIT);
}

export function buildStreamNextActions(commandInfo: CommandInfo, data: unknown, sessionName: string | undefined): AgentBrowserNextAction[] | undefined {
	if (commandInfo.command !== "stream" || commandInfo.subcommand !== "enable" || !isRecord(data) || data.alreadyEnabled !== true) return undefined;
	return [
		{
			id: "check-stream-status-after-noop",
			params: { args: withOptionalSessionArgs(sessionName, ["stream", "status"]) },
			reason: "Read current stream port and connection details after the idempotent enable no-op.",
			safety: "Read-only stream diagnostic.",
			tool: "agent_browser",
		},
		{
			id: "disable-existing-stream-when-done",
			params: { args: withOptionalSessionArgs(sessionName, ["stream", "disable"]) },
			reason: "Disable the existing stream when it is no longer needed.",
			safety: "Only run when no other workflow is relying on the current stream.",
			tool: "agent_browser",
		},
	];
}

function formatConsoleText(data: Record<string, unknown>): string | undefined {
	const messages = getArrayField(data, "messages");
	if (!messages) return undefined;
	if (messages.length === 0) return "No console messages.";
	const shown = messages.slice(0, DIAGNOSTIC_LOG_PREVIEW_LIMIT).map((item, index) => {
		if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
		const type = redactModelFacingText(getStringField(item, "type") ?? "message");
		const text = getStringField(item, "text") ?? stringifyModelFacing(item);
		return `${index + 1}. [${type}] ${firstLine(redactModelFacingText(text).replace(/\s+/g, " ").trim(), 220)}`;
	});
	if (messages.length > shown.length) {
		shown.push(`... (${messages.length - shown.length} additional console messages omitted from preview)`);
	}
	return shown.join("\n");
}

function formatErrorsText(data: Record<string, unknown>): string | undefined {
	const errors = getArrayField(data, "errors");
	if (!errors) return undefined;
	if (errors.length === 0) return "No page errors.";
	const shown = errors.slice(0, DIAGNOSTIC_LOG_PREVIEW_LIMIT).map((item, index) => {
		if (!isRecord(item)) return `${index + 1}. ${stringifyModelFacing(item)}`;
		const text = getStringField(item, "text") ?? stringifyModelFacing(item);
		const location = [
			getStringField(item, "url"),
			typeof item.line === "number" ? `line ${item.line}` : undefined,
			typeof item.column === "number" ? `column ${item.column}` : undefined,
		]
			.filter(Boolean)
			.map((item) => redactModelFacingText(String(item)))
			.join(":");
		const safeText = firstLine(redactModelFacingText(text), 220);
		return location ? `${index + 1}. ${safeText} (${location})` : `${index + 1}. ${safeText}`;
	});
	if (errors.length > shown.length) {
		shown.push(`... (${errors.length - shown.length} additional errors omitted from preview)`);
	}
	return shown.join("\n");
}

function formatDashboardText(data: Record<string, unknown>): string | undefined {
	const lines: string[] = [];
	if (typeof data.port === "number") lines.push(`Port: ${data.port}`);
	if (typeof data.pid === "number") lines.push(`PID: ${data.pid}`);
	if (typeof data.stopped === "boolean") lines.push(`Stopped: ${data.stopped}`);
	const reason = getStringField(data, "reason");
	if (reason) lines.push(`Reason: ${redactModelFacingText(reason)}`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatChatText(data: Record<string, unknown>): string | undefined {
	const response = getStringField(data, "response") ?? getStringField(data, "message") ?? getStringField(data, "text") ?? getStringField(data, "result");
	if (response) return redactModelFacingText(response);
	const model = getStringField(data, "model");
	const provider = getStringField(data, "provider");
	const lines = [model ? `Model: ${redactModelFacingText(model)}` : undefined, provider ? `Provider: ${redactModelFacingText(provider)}` : undefined].filter(Boolean);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatDoctorText(data: Record<string, unknown>): string | undefined {
	const lines: string[] = [];
	const status = getStringField(data, "status") ?? getStringField(data, "result");
	if (status) lines.push(`Status: ${redactModelFacingText(status)}`);
	for (const key of ["checks", "issues", "problems"] as const) {
		const items = getArrayField(data, key);
		if (items) lines.push(`${key}: ${items.length}`);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatCookieRecordText(item: Record<string, unknown>, fallbackName: string): string {
	const name = redactModelFacingText(getStringField(item, "name") ?? fallbackName);
	const domain = getStringField(item, "domain");
	const path = getStringField(item, "path");
	const flags = [item.httpOnly === true ? "httpOnly" : undefined, item.secure === true ? "secure" : undefined].filter(Boolean).join(", ");
	const location = [domain, path].filter(Boolean).join("");
	return [name, location ? `(${redactModelFacingText(location)})` : undefined, flags ? `[${flags}]` : undefined].filter(Boolean).join(" ");
}

function formatCookiesText(data: Record<string, unknown>): string | undefined {
	const cookies = getArrayField(data, "cookies");
	if (cookies) {
		if (cookies.length === 0) return "No cookies.";
		return cookies
			.map((item, index) => (isRecord(item) ? formatCookieRecordText(item, `(cookie ${index + 1})`) : `${index + 1}. [REDACTED]`))
			.join("\n");
	}
	if (getStringField(data, "name") || getStringField(data, "domain") || getStringField(data, "path") || Object.hasOwn(data, "value")) {
		return formatCookieRecordText(data, "cookie");
	}
	if (data.set === true) return "Cookie set.";
	if (data.cleared === true || data.clear === true) return "Cookies cleared.";
	return undefined;
}

function valueContainsStorageSecret(value: unknown): boolean {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return false;
		if (STORAGE_TOKEN_VALUE_PATTERN.test(trimmed) || STORAGE_SECRET_VALUE_WORD_PATTERN.test(trimmed) || STORAGE_EMAIL_VALUE_PATTERN.test(trimmed) || STORAGE_IDENTITY_VALUE_PATTERN.test(trimmed)) return true;
		try {
			const url = new URL(trimmed);
			if (url.protocol === "http:" || url.protocol === "https:" || url.username || url.password || url.search) return true;
		} catch {}
		if (redactSensitiveText(trimmed) !== trimmed || redactModelFacingTextIfSensitive(trimmed) !== trimmed) return true;
		try {
			return valueContainsStorageSecret(JSON.parse(trimmed));
		} catch {
			return false;
		}
	}
	if (Array.isArray(value)) return value.some((item) => valueContainsStorageSecret(item));
	if (!isRecord(value)) return false;
	return Object.entries(value).some(([key, entryValue]) => STORAGE_SECRET_KEY_PATTERN.test(key) || valueContainsStorageSecret(entryValue));
}

function shouldRevealStorageValue(key: string | undefined, value: unknown): boolean {
	if (!key || STORAGE_SECRET_KEY_PATTERN.test(key) || !STORAGE_BENIGN_KEY_PATTERN.test(key)) return false;
	if (valueContainsStorageSecret(value)) return false;
	if (typeof value === "string") return value.length <= STORAGE_VALUE_PREVIEW_MAX_CHARS;
	return value === null || typeof value === "number" || typeof value === "boolean";
}

function formatStorageValue(key: string | undefined, value: unknown): string {
	if (!shouldRevealStorageValue(key, value)) return "[REDACTED]";
	if (typeof value === "string") return redactModelFacingText(value);
	return stringifyModelFacing(value);
}

function redactStorageEntryValue(item: Record<string, unknown>): Record<string, unknown> {
	if (!Object.hasOwn(item, "value")) return redactStructuredPresentationValue(item) as Record<string, unknown>;
	const key = getStringField(item, "key") ?? getStringField(item, "name");
	const value = item.value;
	if (shouldRevealStorageValue(key, value)) return redactStructuredPresentationValue(item) as Record<string, unknown>;
	return {
		...redactStructuredPresentationValue({ ...item, value: undefined }) as Record<string, unknown>,
		value: "[REDACTED]",
		valueRedacted: true,
		valueRedactionReason: key && STORAGE_SECRET_KEY_PATTERN.test(key) ? "sensitive-key" : "sensitive-value",
	};
}

function redactStorageData(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => redactStorageData(item));
	if (!isRecord(value)) return redactStructuredPresentationValue(value);
	const entries = Object.fromEntries(Object.entries(value).map(([key, entryValue]) => {
		if ((key === "entries" || key === "items") && Array.isArray(entryValue)) return [key, entryValue.map((item) => isRecord(item) ? redactStorageEntryValue(item) : redactStructuredPresentationValue(item))];
		if (key === "value") {
			const itemKey = getStringField(value, "key") ?? getStringField(value, "name");
			return [key, shouldRevealStorageValue(itemKey, entryValue) ? redactStructuredPresentationValue(entryValue) : "[REDACTED]"];
		}
		return [key, redactStructuredPresentationValue(entryValue)];
	}));
	if (Object.hasOwn(value, "value")) {
		const key = getStringField(value, "key") ?? getStringField(value, "name");
		if (!shouldRevealStorageValue(key, value.value)) {
			entries.valueRedacted = true;
			entries.valueRedactionReason = key && STORAGE_SECRET_KEY_PATTERN.test(key) ? "sensitive-key" : "sensitive-value";
		}
	}
	return entries;
}

function formatStorageText(data: Record<string, unknown>): string | undefined {
	const type = getStringField(data, "type") ?? getStringField(data, "storage") ?? "storage";
	const entries = getArrayField(data, "entries") ?? getArrayField(data, "items");
	if (entries) {
		if (entries.length === 0) return `${type}: no entries.`;
		return entries
			.map((item, index) => {
				if (!isRecord(item)) return `${index + 1}. [REDACTED]`;
				const rawKey = getStringField(item, "key") ?? getStringField(item, "name") ?? `(entry ${index + 1})`;
				const key = redactModelFacingText(rawKey);
				return Object.hasOwn(item, "value") ? `${key}: ${formatStorageValue(rawKey, item.value)}` : key;
			})
			.join("\n");
	}
	const key = getStringField(data, "key");
	if (key && Object.hasOwn(data, "value")) return `${type} ${redactModelFacingText(key)}: ${formatStorageValue(key, data.value)}`;
	if (key && data.set === true) return `${type} set: ${redactModelFacingText(key)}`;
	if (data.cleared === true || data.clear === true) return `${type} cleared.`;
	return undefined;
}

function formatDialogText(data: Record<string, unknown>): string | undefined {
	const lines: string[] = [];
	if (typeof data.open === "boolean") lines.push(data.open ? "Dialog open." : "No dialog open.");
	const type = getStringField(data, "type");
	if (type) lines.push(`Type: ${redactModelFacingText(type)}`);
	const message = getStringField(data, "message");
	if (message) lines.push(`Message: ${/(?:auth|authorization|bearer|cookie|pass(?:word)?|secret|session|token)/i.test(message) ? "[REDACTED]" : redactModelFacingText(message)}`);
	if (data.accepted === true) lines.push("Accepted.");
	if (data.dismissed === true) lines.push("Dismissed.");
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatFrameText(data: Record<string, unknown>): string | undefined {
	const frame = getStringField(data, "frame") ?? getStringField(data, "name") ?? getStringField(data, "selector");
	const url = getStringField(data, "url");
	const title = getStringField(data, "title");
	const lines = [frame ? `Frame: ${redactModelFacingText(frame)}` : undefined, title ? `Title: ${redactModelFacingText(title)}` : undefined, url ? `URL: ${redactModelFacingTextIfSensitive(url)}` : undefined].filter(Boolean);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatStateText(data: Record<string, unknown>): string | undefined {
	const states = getArrayField(data, "states") ?? getArrayField(data, "files");
	if (states) {
		if (states.length === 0) return "No saved states.";
		return states
			.map((item, index) => {
				if (!isRecord(item)) return `${index + 1}. ${redactModelFacingTextIfSensitive(stringifyModelFacing(item))}`;
				const name = getStringField(item, "name") ?? getStringField(item, "file") ?? getStringField(item, "path") ?? `(state ${index + 1})`;
				const url = getStringField(item, "url");
				return url ? `${index + 1}. ${redactModelFacingText(name)} — ${redactModelFacingTextIfSensitive(url)}` : `${index + 1}. ${redactModelFacingText(name)}`;
			})
			.join("\n");
	}
	if (data.loaded === true) return `State loaded: ${redactModelFacingText(getStringField(data, "path") ?? getStringField(data, "name") ?? "ok")}`;
	if (data.cleared === true || data.clear === true) return "State cleared.";
	return undefined;
}

function isSensitivePresentationField(key: string): boolean {
	return SENSITIVE_PRESENTATION_FIELD_PATTERN.test(key);
}

function redactStructuredPresentationValue(value: unknown): unknown {
	if (typeof value === "string") return redactModelFacingTextIfSensitive(value);
	if (Array.isArray(value)) return value.map((item) => redactStructuredPresentationValue(item));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => [
			key,
			isSensitivePresentationField(key) ? "[REDACTED]" : redactStructuredPresentationValue(entryValue),
		]),
	);
}

function redactStatefulValues(value: unknown, sensitiveKeys: Set<string>): unknown {
	if (Array.isArray(value)) return value.map((item) => redactStatefulValues(item, sensitiveKeys));
	if (!isRecord(value)) return redactStructuredPresentationValue(value);
	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => [
			key,
			sensitiveKeys.has(key.toLowerCase()) ? "[REDACTED]" : redactStatefulValues(entryValue, sensitiveKeys),
		]),
	);
}

export function redactPresentationData(commandInfo: CommandInfo, data: unknown): unknown {
	if (commandInfo.command === "cookies") return redactStatefulValues(data, new Set(["value"]));
	if (commandInfo.command === "storage") return redactStorageData(data);
	return redactStructuredPresentationValue(data);
}

export function formatDiagnosticText(commandInfo: CommandInfo, data: Record<string, unknown>): string | undefined {
	if (commandInfo.command === "session") return formatSessionText(data);
	if (commandInfo.command === "profiles") {
		const profiles = getArrayField(data, "profiles");
		if (profiles) return formatProfilesText(profiles, "Chrome profiles");
	}
	if (commandInfo.command === "auth") {
		const profiles = getArrayField(data, "profiles");
		if (profiles) return formatProfilesText(profiles, "auth profiles");
		if (commandInfo.subcommand === "show") return formatAuthShowText(data);
	}
	if (commandInfo.command === "cookies") return formatCookiesText(data);
	if (commandInfo.command === "storage") return formatStorageText(data);
	if (commandInfo.command === "dialog") return formatDialogText(data);
	if (commandInfo.command === "frame") return formatFrameText(data);
	if (commandInfo.command === "state") return formatStateText(data);
	if (commandInfo.command === "network" && commandInfo.subcommand === "requests") return formatNetworkRequestsText(data);
	if (commandInfo.command === "network" && commandInfo.subcommand === "request") return formatNetworkRequestText(data);
	if (commandInfo.command === "diff") return stringifyModelFacing(data);
	if (commandInfo.command === "clipboard") {
		const text = getStringField(data, "text") ?? getStringField(data, "value") ?? getStringField(data, "result");
		if (text) return redactModelFacingText(text);
	}
	if (commandInfo.command === "stream") {
		const streamSummary = getStreamSummary(data);
		if (streamSummary) return streamSummary;
	}
	if (commandInfo.command === "chat") return formatChatText(data);
	if (commandInfo.command === "console") return formatConsoleText(data);
	if (commandInfo.command === "errors") return formatErrorsText(data);
	if (commandInfo.command === "dashboard") return formatDashboardText(data);
	if (commandInfo.command === "doctor") return formatDoctorText(data);
	return undefined;
}
