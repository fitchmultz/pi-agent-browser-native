import { isRecord } from "../parsing.js";
import { redactSensitiveText } from "../runtime.js";
import type { NetworkRouteDiagnostic, NetworkRouteRecord } from "./contracts.js";
import { getStringRecordField, isApiLikeNetworkRequest } from "./network.js";

function getArrayField(data: Record<string, unknown>, key: string): unknown[] | undefined {
	const value = data[key];
	return Array.isArray(value) ? value : undefined;
}

function networkRoutePatternMatchesUrl(pattern: string, url: string): boolean {
	if (pattern === url) return true;
	if (pattern.includes("*")) {
		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		return new RegExp(`^${escaped}$`).test(url);
	}
	return pattern.length >= 4 && url.includes(pattern);
}

function getSafeRequestId(item: Record<string, unknown>): string | undefined {
	const requestId = getStringRecordField(item, "requestId") ?? getStringRecordField(item, "id");
	if (!requestId || redactSensitiveText(requestId) !== requestId) return undefined;
	return requestId;
}

function getRouteDiagnosticReason(item: Record<string, unknown>, route: NetworkRouteRecord): NetworkRouteDiagnostic["reason"] | undefined {
	const statusMissing = typeof item.status !== "number";
	const error = getStringRecordField(item, "error") ?? getStringRecordField(item, "failureText") ?? getStringRecordField(item, "errorText");
	if (error && /(?:cors|cross-origin|preflight|access-control-allow-origin)/i.test(error)) return "cors-likely-routed-request";
	if (statusMissing && isApiLikeNetworkRequest(item)) return "pending-routed-request";
	if (route.mode !== "abort" && ((typeof item.status === "number" && item.status >= 400) || item.failed === true || typeof error === "string")) return "unfulfilled-routed-request";
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
		const url = getStringRecordField(item, "url");
		if (!url) continue;
		const route = routes.find((candidate) => networkRoutePatternMatchesUrl(candidate.pattern, url));
		if (!route) continue;
		const reason = getRouteDiagnosticReason(item, route);
		if (!reason) continue;
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
				: reason === "unfulfilled-routed-request"
					? `Routed request ${requestId ?? requestUrl} failed instead of returning the configured route ${routePattern}.`
					: `Routed request ${requestId ?? requestUrl} is still pending/no-status for route ${routePattern}.`,
		});
	}
	return diagnostics.length > 0 ? diagnostics.slice(0, 5) : undefined;
}
