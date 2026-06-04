import { isRecord } from "../parsing.js";
import { redactSensitiveText } from "../runtime.js";
import type { NetworkRouteDiagnostic, NetworkRouteRecord } from "./contracts.js";

function getArrayField(data: Record<string, unknown>, key: string): unknown[] | undefined {
	const value = data[key];
	return Array.isArray(value) ? value : undefined;
}

function getStringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function networkRoutePatternMatchesUrl(pattern: string, url: string): boolean {
	if (pattern === url) return true;
	if (pattern.includes("*")) {
		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		return new RegExp(`^${escaped}$`).test(url);
	}
	return pattern.length >= 4 && url.includes(pattern);
}

function getNetworkRequestPath(item: Record<string, unknown>): string {
	const url = getStringField(item, "url");
	if (!url) return "";
	try {
		return new URL(url).pathname;
	} catch {
		return url.split(/[?#]/, 1)[0] ?? "";
	}
}

function isApiLikeNetworkRequest(item: Record<string, unknown>): boolean {
	const method = (getStringField(item, "method") ?? "GET").toUpperCase();
	const resourceType = (getStringField(item, "resourceType") ?? "").toLowerCase();
	const mimeType = (getStringField(item, "mimeType") ?? "").toLowerCase();
	const path = getNetworkRequestPath(item);
	return resourceType === "fetch" || resourceType === "xhr" || mimeType.includes("json") || /\/(?:api|graphql|rpc)(?:\/|$)/i.test(path) || !["GET", "HEAD"].includes(method);
}

function getSafeRequestId(item: Record<string, unknown>): string | undefined {
	const requestId = getStringField(item, "requestId") ?? getStringField(item, "id");
	if (!requestId || redactSensitiveText(requestId) !== requestId) return undefined;
	return requestId;
}

function getRouteDiagnosticReason(item: Record<string, unknown>): NetworkRouteDiagnostic["reason"] | undefined {
	const statusMissing = typeof item.status !== "number";
	const error = getStringField(item, "error") ?? getStringField(item, "failureText") ?? getStringField(item, "errorText");
	if (error && /(?:cors|cross-origin|preflight|access-control-allow-origin)/i.test(error)) return "cors-likely-routed-request";
	if (statusMissing && isApiLikeNetworkRequest(item)) return "pending-routed-request";
	return undefined;
}

export function getNetworkRouteMode(args: string[]): NetworkRouteRecord["mode"] {
	if (args.includes("--abort")) return "abort";
	if (args.includes("--body")) return "body";
	return "handler";
}

export function applyNetworkRouteRecords(routes: NetworkRouteRecord[] | undefined, commandTokens: string[] | undefined, succeeded: boolean): NetworkRouteRecord[] | undefined {
	if (!succeeded || commandTokens?.[0] !== "network") return routes;
	const subcommand = commandTokens[1];
	if (subcommand !== "route" && subcommand !== "unroute") return routes;
	const existing = routes ?? [];
	const pattern = commandTokens[2];
	if (subcommand === "route" && pattern) return [...existing.filter((route) => route.pattern !== pattern), { mode: getNetworkRouteMode(commandTokens), pattern }];
	if (!pattern) return undefined;
	const next = existing.filter((route) => route.pattern !== pattern);
	return next.length > 0 ? next : undefined;
}

export function buildNetworkRouteDiagnostics(data: unknown, routes: NetworkRouteRecord[] | undefined): NetworkRouteDiagnostic[] | undefined {
	if (!routes || routes.length === 0 || !isRecord(data)) return undefined;
	const requests = getArrayField(data, "requests");
	if (!requests) return undefined;
	const diagnostics: NetworkRouteDiagnostic[] = [];
	for (const item of requests) {
		if (!isRecord(item)) continue;
		const url = getStringField(item, "url");
		if (!url) continue;
		const reason = getRouteDiagnosticReason(item);
		if (!reason) continue;
		const route = routes.find((candidate) => networkRoutePatternMatchesUrl(candidate.pattern, url));
		if (!route) continue;
		const requestId = getSafeRequestId(item);
		const requestUrl = redactSensitiveText(url);
		const routePattern = redactSensitiveText(route.pattern);
		diagnostics.push({
			mode: route.mode,
			reason,
			...(requestId ? { requestId } : {}),
			requestUrl,
			routePattern,
			summary: reason === "cors-likely-routed-request"
				? `Routed request ${requestId ?? requestUrl} looks CORS/preflight-related for route ${routePattern}.`
				: `Routed request ${requestId ?? requestUrl} is still pending/no-status for route ${routePattern}.`,
		});
	}
	return diagnostics.length > 0 ? diagnostics.slice(0, 5) : undefined;
}
