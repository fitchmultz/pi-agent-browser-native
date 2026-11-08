import { isRecord } from "../../parsing.js";
import { redactSensitiveText } from "../../runtime.js";
import type { AgentBrowserNextAction } from "../action-contracts.js";
import type { NetworkRouteDiagnostic } from "../contracts.js";
import {
	classifyNetworkRequestFailure,
	getNetworkRequestId,
	isApiLikeNetworkRequest,
	isNetworkArtifactNoiseRequest,
} from "../network.js";
import { withOptionalSessionArgs } from "../next-actions.js";
import { getArrayField, getStringField } from "./common.js";

type Data = Readonly<Record<string, unknown>>;
interface Candidate {
	readonly filter?: string | undefined;
	readonly item: Data;
	readonly kind: "actionable" | "api" | "benign" | "request";
	readonly requestId: string;
}
const SENSITIVE_SEGMENT_TERMS = [
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
];
const OPAQUE_SEGMENT_PATTERN = /^(?:[A-Fa-f0-9]{16,}|(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{16,})$/;

function safeActionValue(value: string | undefined): string | undefined {
	if (value === undefined || value.length === 0) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 || redactSensitiveText(trimmed) !== trimmed ? undefined : trimmed;
}

function sensitivePathSegment(segment: string): boolean {
	const normalized = segment.toLowerCase();
	return normalized === "auth" || SENSITIVE_SEGMENT_TERMS.some((term) => normalized.includes(term));
}

function decodePath(filter: string): string {
	try {
		return decodeURIComponent(filter);
	} catch {
		return filter;
	} // Malformed native escapes still undergo literal segment checks.
}

function requestPath(url: string): string | undefined {
	try {
		return new URL(url).pathname;
	} catch {
		return url.split(/[?#]/, 1)[0];
	} // Native patterns need not be absolute URLs.
}

function requestPathFilter(item: Data): string | undefined {
	const url = getStringField(item, "url");
	if (url === undefined) {
		return undefined;
	}
	const filter = requestPath(url)?.trim();
	if (filter === undefined || filter.length === 0 || filter === "/" || filter.length > 160) {
		return undefined;
	}
	if (
		decodePath(filter)
			.split("/")
			.some((segment) => sensitivePathSegment(segment) || OPAQUE_SEGMENT_PATTERN.test(segment))
	) {
		return undefined;
	}
	return safeActionValue(filter);
}

function candidateKind(item: Data): Candidate["kind"] {
	const classification = classifyNetworkRequestFailure(item);
	if (classification?.impact === "actionable") {
		return "actionable";
	}
	if (classification?.impact === "benign") {
		return "benign";
	}
	return isApiLikeNetworkRequest(item) ? "api" : "request";
}

function requestCandidate(item: unknown): Candidate[] {
	if (!isRecord(item) || isNetworkArtifactNoiseRequest(item)) {
		return [];
	}
	const requestId = safeActionValue(getNetworkRequestId(item));
	return requestId === undefined
		? []
		: [{ filter: requestPathFilter(item), item, kind: candidateKind(item), requestId }];
}

function chooseCandidate(candidates: readonly Candidate[]): Candidate | undefined {
	return (
		candidates.find((candidate) => candidate.kind === "actionable") ??
		candidates.find((candidate) => candidate.kind === "api") ??
		candidates.find((candidate) => candidate.kind === "benign") ??
		candidates[0]
	);
}

function actionDescriptor(candidate: Candidate): string {
	const method = getStringField(candidate.item, "method") ?? "GET";
	const status =
		typeof candidate.item.status === "number" ? String(candidate.item.status) : "pending";
	return `${status} ${method}${candidate.filter === undefined ? "" : ` ${candidate.filter}`} [${candidate.requestId}]`;
}

function detailActionId(candidate: Candidate): string {
	if (candidate.kind === "actionable") {
		return "inspect-actionable-network-request";
	}
	return candidate.kind === "benign" ? "inspect-benign-network-request" : "inspect-network-request";
}

export function formatNetworkRouteDiagnosticsText(
	diagnostics: readonly NetworkRouteDiagnostic[] | undefined,
): string | undefined {
	if (!diagnostics || diagnostics.length === 0) {
		return undefined;
	}
	const lines = ["Network route diagnostics:"];
	for (const diagnostic of diagnostics) {
		const target =
			diagnostic.requestId !== undefined && diagnostic.requestId.length > 0
				? `[${diagnostic.requestId}] ${diagnostic.requestUrl ?? "request"}`
				: (diagnostic.requestUrl ?? "request");
		lines.push(
			`- ${diagnostic.reason}: ${target} matched route ${diagnostic.routePattern} (${diagnostic.mode}).`,
		);
	}
	lines.push(
		"If this route is intended as a mock, inspect the request/headers and treat failed, pending, or CORS-looking rows as unfulfilled until a mocked response is observed.",
	);
	return lines.join("\n");
}

function routeActions(
	diagnostics: readonly NetworkRouteDiagnostic[] | undefined,
	sessionName: string | undefined,
): AgentBrowserNextAction[] {
	const diagnostic =
		diagnostics?.find((item) => item.requestId !== undefined && item.requestId.length > 0) ??
		diagnostics?.[0];
	if (!diagnostic) {
		return [];
	}
	const actions: AgentBrowserNextAction[] = [];
	if (diagnostic.requestId !== undefined && diagnostic.requestId.length > 0) {
		actions.push({
			id: "inspect-routed-network-request",
			params: {
				args: withOptionalSessionArgs(sessionName, ["network", "request", diagnostic.requestId]),
			},
			reason: `Inspect the routed request ${diagnostic.requestId} before assuming the route mock fulfilled normally.`,
			safety:
				"Read-only request diagnostic; look for failed status, pending state, CORS/preflight errors, response body, and headers.",
			tool: "agent_browser",
		});
	}
	actions.push({
		id: "start-network-har-capture-for-route-mock",
		params: { args: withOptionalSessionArgs(sessionName, ["network", "har", "start"]) },
		reason:
			"Capture a HAR before reproducing the route mock so pending/CORS behavior has request and response headers.",
		safety:
			"HARs can contain URLs and headers; stop to an explicit path and avoid sharing sensitive captures.",
		tool: "agent_browser",
	});
	return actions;
}

function candidateActions(
	selected: Candidate,
	sessionName: string | undefined,
): AgentBrowserNextAction[] {
	const descriptor = actionDescriptor(selected);
	const actions: AgentBrowserNextAction[] = [
		{
			id: detailActionId(selected),
			params: {
				args: withOptionalSessionArgs(sessionName, ["network", "request", selected.requestId]),
			},
			reason: `Inspect full request details for ${descriptor}.`,
			safety:
				"Read-only network diagnostic; request inspection must not replace the active page/ref context.",
			tool: "agent_browser",
		},
	];
	if (selected.kind === "actionable") {
		actions.push({
			id: "trace-actionable-network-source",
			params: {
				requestId: selected.requestId,
				...(sessionName !== undefined && sessionName.length > 0 ? { session: sessionName } : {}),
			},
			reason: `Look for local source candidates related to ${descriptor}.`,
			safety:
				"Read-only experimental helper; load it with tool_search or call it from codemode when it is not declared. It reports bounded candidates and may miss bundled or dynamic call sites.",
			tool: "agent_browser_network_source",
		});
	}
	if (selected.filter !== undefined && selected.filter.length > 0) {
		actions.push({
			id: "filter-network-requests-by-path",
			params: {
				args: withOptionalSessionArgs(sessionName, [
					"network",
					"requests",
					"--filter",
					selected.filter,
				]),
			},
			reason: `List captured requests matching ${selected.filter}.`,
			safety:
				"Read-only request-list filter; absence from a compact preview is not proof the request did not happen.",
			tool: "agent_browser",
		});
	}
	actions.push({
		id: "clear-network-requests-before-repro",
		params: { args: withOptionalSessionArgs(sessionName, ["network", "requests", "--clear"]) },
		reason:
			"Clear the aggregate request buffer before reproducing the current-page network behavior.",
		safety:
			"This mutates only diagnostic buffers for the session; capture or inspect needed old rows first.",
		tool: "agent_browser",
	});
	actions.push({
		id: "start-network-har-capture",
		params: { args: withOptionalSessionArgs(sessionName, ["network", "har", "start"]) },
		reason: "Start HAR capture before reproducing the network behavior again.",
		safety:
			"HARs can contain URLs and headers; stop to an explicit path, inspect metadata, and avoid sharing sensitive captures.",
		tool: "agent_browser",
	});
	return actions;
}

export function buildNetworkRequestsNextActions(
	data: unknown,
	sessionName: string | undefined,
	routeDiagnostics?: readonly NetworkRouteDiagnostic[],
): AgentBrowserNextAction[] | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	const requests = getArrayField(data, "requests");
	if (!requests) {
		return undefined;
	}
	const selected = chooseCandidate(requests.flatMap(requestCandidate));
	return selected
		? [
				...routeActions(routeDiagnostics, sessionName),
				...candidateActions(selected, sessionName),
			].slice(0, 6)
		: undefined;
}
