import { isCloseCommand } from "../command-taxonomy.js";
import { isRecord } from "../parsing.js";
import { redactSensitiveText } from "../runtime-redaction.js";
import type { NetworkRouteDiagnostic, NetworkRouteRecord } from "./contracts.js";
import { getStringRecordField, isApiLikeNetworkRequest } from "./network.js";

function getArrayField(
	data: Readonly<Record<string, unknown>>,
	key: string,
): unknown[] | undefined {
	const value = data[key];
	return Array.isArray(value) ? value : undefined;
}

function networkRoutePatternMatchesUrl(pattern: string, url: string): boolean {
	if (pattern === url) {
		return true;
	}
	if (pattern.includes("*")) {
		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		return new RegExp(`^${escaped}$`).test(url);
	}
	return pattern.length >= 4 && url.includes(pattern);
}

function getSafeRequestId(item: Readonly<Record<string, unknown>>): string | undefined {
	const requestId = getStringRecordField(item, "requestId") ?? getStringRecordField(item, "id");
	if (
		requestId === undefined ||
		requestId.length === 0 ||
		redactSensitiveText(requestId) !== requestId
	) {
		return undefined;
	}
	return requestId;
}

function routedRequestFailed(
	item: Readonly<Record<string, unknown>>,
	error: string | undefined,
): boolean {
	return (
		(typeof item.status === "number" && item.status >= 400) ||
		item.failed === true ||
		error !== undefined
	);
}

function getRouteDiagnosticReason(
	item: Readonly<Record<string, unknown>>,
	route: NetworkRouteRecord,
): NetworkRouteDiagnostic["reason"] | undefined {
	const statusMissing = typeof item.status !== "number";
	const error =
		getStringRecordField(item, "error") ??
		getStringRecordField(item, "failureText") ??
		getStringRecordField(item, "errorText");
	if (
		error !== undefined &&
		/(?:cors|cross-origin|preflight|access-control-allow-origin)/i.test(error)
	) {
		return "cors-likely-routed-request";
	}
	if (statusMissing && isApiLikeNetworkRequest(item)) {
		return "pending-routed-request";
	}
	if (route.mode !== "abort" && routedRequestFailed(item, error)) {
		return "unfulfilled-routed-request";
	}
	return undefined;
}

function getNetworkRouteMode(args: readonly string[]): NetworkRouteRecord["mode"] {
	if (args.includes("--abort")) {
		return "abort";
	}
	if (args.includes("--body")) {
		return "body";
	}
	return "handler";
}

export function applyNetworkRouteRecords(
	routes: readonly NetworkRouteRecord[] | undefined,
	commandTokens: readonly string[] | undefined,
	succeeded: boolean,
): readonly NetworkRouteRecord[] | undefined {
	if (!succeeded || commandTokens?.[0] !== "network") {
		return routes;
	}
	const subcommand = commandTokens[1];
	if (subcommand !== "route" && subcommand !== "unroute") {
		return routes;
	}
	return updateNetworkRoutes(routes, commandTokens);
}

/** Ordered batch row: a successful close retires earlier rows' routes; later route rows rebuild them. */
export function applyBatchRowNetworkRouteRecords(
	routes: readonly NetworkRouteRecord[] | undefined,
	commandTokens: readonly string[] | undefined,
	succeeded: boolean,
): readonly NetworkRouteRecord[] | undefined {
	return succeeded && isCloseCommand(commandTokens?.[0])
		? undefined
		: applyNetworkRouteRecords(routes, commandTokens, succeeded);
}

function updateNetworkRoutes(
	routes: readonly NetworkRouteRecord[] | undefined,
	commandTokens: readonly string[],
): readonly NetworkRouteRecord[] | undefined {
	const existing = routes ?? [];
	const pattern = commandTokens.at(2);
	if (commandTokens[1] === "route" && pattern !== undefined && pattern.length > 0) {
		return [
			...existing.filter((route) => route.pattern !== pattern),
			{ mode: getNetworkRouteMode(commandTokens), pattern },
		];
	}
	if (pattern === undefined || pattern.length === 0) {
		return undefined;
	}
	const next = existing.filter((route) => route.pattern !== pattern);
	return next.length > 0 ? next : undefined;
}

function formatNetworkRouteDiagnosticSummary(
	reason: NetworkRouteDiagnostic["reason"],
	request: string,
	pattern: string,
): string {
	switch (reason) {
		case "cors-likely-routed-request":
			return `Routed request ${request} looks CORS/preflight-related for route ${pattern}.`;
		case "unfulfilled-routed-request":
			return `Routed request ${request} failed instead of returning the configured route ${pattern}.`;
		case "pending-routed-request":
			return `Routed request ${request} is still pending/no-status for route ${pattern}.`;
	}
}

function buildRoutedRequestDiagnostic(
	item: unknown,
	routes: readonly NetworkRouteRecord[],
): NetworkRouteDiagnostic | undefined {
	if (!isRecord(item)) {
		return undefined;
	}
	const url = getStringRecordField(item, "url");
	if (url === undefined) {
		return undefined;
	}
	const route = routes.find((candidate) => networkRoutePatternMatchesUrl(candidate.pattern, url));
	if (!route) {
		return undefined;
	}
	const reason = getRouteDiagnosticReason(item, route);
	if (reason === undefined) {
		return undefined;
	}
	const requestId = getSafeRequestId(item);
	const requestUrl = redactSensitiveText(url);
	const routePattern = redactSensitiveText(route.pattern);
	return {
		mode: route.mode,
		reason,
		...(requestId !== undefined ? { requestId } : {}),
		requestUrl,
		routePattern,
		summary: formatNetworkRouteDiagnosticSummary(reason, requestId ?? requestUrl, routePattern),
	};
}

export function buildNetworkRouteDiagnostics(
	data: unknown,
	routes: readonly NetworkRouteRecord[] | undefined,
): NetworkRouteDiagnostic[] | undefined {
	if (!routes || routes.length === 0 || !isRecord(data)) {
		return undefined;
	}
	const requests = getArrayField(data, "requests");
	if (!requests) {
		return undefined;
	}
	const diagnostics = requests
		.map((item) => buildRoutedRequestDiagnostic(item, routes))
		.filter((item) => item !== undefined);
	return diagnostics.length > 0 ? diagnostics.slice(0, 5) : undefined;
}
