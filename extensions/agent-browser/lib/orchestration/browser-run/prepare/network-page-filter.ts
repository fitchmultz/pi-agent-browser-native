import { isRecord } from "../../../parsing.js";
import { buildAgentBrowserResultCategoryDetails } from "../../../results/categories.js";
import { redactPresentationData } from "../../../results/presentation/diagnostics.js";
import { redactInvocationArgs, redactSensitiveText } from "../../../runtime-redaction.js";
import type { CompatibilityWorkaround } from "../../../runtime-contracts.js";
import { buildSessionDetailFields, runSessionCommandData } from "../session-state.js";

import type { AgentBrowserToolResult } from "../types.js";

interface NetworkRequestsPageFilterRequest {
	readonly cleanArgs: readonly string[];
	readonly mode: "origin" | "url";
}

function parseNetworkRequestsPageFilterRequest(
	commandTokens: readonly string[],
): NetworkRequestsPageFilterRequest | undefined {
	if (commandTokens[0] !== "network" || commandTokens[1] !== "requests") {
		return undefined;
	}
	const cleanArgs: string[] = [];
	let mode: NetworkRequestsPageFilterRequest["mode"] | undefined;
	for (const token of commandTokens) {
		if (token === "--current-page" || token === "--current-origin") {
			mode = "origin";
			continue;
		}
		if (token === "--current-url") {
			mode = "url";
			continue;
		}
		cleanArgs.push(token);
	}
	if (mode === undefined) {
		return undefined;
	}
	return { cleanArgs, mode };
}

function extractCurrentUrl(data: unknown): string | undefined {
	if (typeof data === "string") {
		return data;
	}
	if (!isRecord(data)) {
		return undefined;
	}
	const candidates = [data.url, data.currentUrl, data.href, data.result];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

function getRequestUrl(row: unknown): string | undefined {
	if (!isRecord(row)) {
		return undefined;
	}
	const candidate = row.url ?? row.requestUrl ?? row.href;
	return typeof candidate === "string" ? candidate : undefined;
}

function requestMatchesCurrentPage(
	row: unknown,
	currentUrl: string,
	mode: NetworkRequestsPageFilterRequest["mode"],
): boolean {
	const requestUrl = getRequestUrl(row);
	if (requestUrl === undefined || requestUrl === "") {
		return false;
	}
	try {
		const current = new URL(currentUrl);
		const request = new URL(requestUrl, current);
		if (mode === "origin") {
			return current.origin === request.origin;
		}
		const currentComparable = `${current.origin}${current.pathname}`;
		const requestComparable = `${request.origin}${request.pathname}`;
		return requestComparable === currentComparable;
	} catch {
		return mode === "url" ? requestUrl === currentUrl : requestUrl.startsWith(currentUrl);
	}
}

function filterNetworkRequestsData(
	data: unknown,
	currentUrl: string,
	request: NetworkRequestsPageFilterRequest,
):
	| { data: Record<string, unknown>; matchedRows: number; totalRows: number; rows: unknown[] }
	| undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	const key = ["requests", "items", "entries"].find((name) => Array.isArray(data[name]));
	if (key === undefined) {
		return undefined;
	}
	const requestRows: unknown = data[key];
	if (!Array.isArray(requestRows)) {
		return undefined;
	}
	const rows = requestRows.filter((row) =>
		requestMatchesCurrentPage(row, currentUrl, request.mode),
	);
	return {
		data: { ...data, [key]: rows },
		matchedRows: rows.length,
		rows,
		totalRows: requestRows.length,
	};
}

function formatNetworkRequestRow(row: unknown): string {
	if (!isRecord(row)) {
		return redactSensitiveText(formatNetworkValue(row));
	}
	const status = row.status ?? row.statusCode ?? row.responseStatus ?? "?";
	const method = [row.method, row.requestMethod].find((value) => typeof value === "string") ?? "?";
	const identifier = [row.id, row.requestId].find((value) => typeof value === "string");
	const id = identifier === undefined ? "" : ` id=${identifier}`;
	const url = getRequestUrl(row) ?? "(no url)";
	return redactSensitiveText(`- ${formatNetworkValue(status)} ${method}${id} ${url}`);
}

function formatNetworkValue(value: unknown): string {
	switch (typeof value) {
		case "string":
		case "number":
		case "bigint":
		case "boolean":
		case "undefined":
		case "symbol":
		case "function":
			return String(value);
		case "object":
			if (value === null) {
				return "null";
			}
			return Array.isArray(value)
				? value.map(formatNetworkArrayElement).join(",")
				: Object.prototype.toString.call(value);
	}
}

function formatNetworkArrayElement(value: unknown): string {
	return value === null || value === undefined ? "" : formatNetworkValue(value);
}

function formatFilteredNetworkText(options: {
	readonly summary: string;
	readonly currentUrl: string;
	readonly rows: readonly unknown[];
}): string {
	const preview = options.rows.slice(0, 12).map(formatNetworkRequestRow);
	const omitted =
		options.rows.length > preview.length
			? [`- …${options.rows.length - preview.length} more matching rows omitted`]
			: [];
	return [
		redactSensitiveText(options.summary),
		`Current page: ${redactSensitiveText(options.currentUrl)}`,
		...preview,
		...omitted,
	].join("\n");
}

export async function tryNetworkRequestsPageFilter(options: {
	readonly commandTokens: readonly string[];
	readonly compatibilityWorkaround?: CompatibilityWorkaround | undefined;
	readonly cwd: string;
	readonly effectiveArgs: readonly string[];
	readonly managedSessionRestoreDisabled: () => boolean;
	readonly redactedArgs: readonly string[];
	readonly sessionMode: "auto" | "fresh";
	readonly namespace?: string | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = parseNetworkRequestsPageFilterRequest(options.commandTokens);
	if (!request || options.sessionName === undefined || options.sessionName === "") {
		return undefined;
	}
	const currentUrl = extractCurrentUrl(
		await runSessionCommandData({
			args: ["get", "url"],
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: options.signal,
		}),
	);
	if (currentUrl === undefined || currentUrl === "") {
		return undefined;
	}
	const networkData = await runSessionCommandData({
		args: request.cleanArgs,
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
	});
	const filtered = filterNetworkRequestsData(networkData, currentUrl, request);
	if (!filtered) {
		return undefined;
	}
	const summary = `Network requests filtered to current ${request.mode === "origin" ? "origin" : "URL"}: ${filtered.matchedRows}/${filtered.totalRows} rows matched.`;
	return {
		content: [
			{
				type: "text",
				text: formatFilteredNetworkText({ summary, currentUrl, rows: filtered.rows }),
			},
		],
		details: {
			args: options.redactedArgs,
			command: "network",
			compatibilityWorkaround: options.compatibilityWorkaround,
			data: redactPresentationData({ command: "network", subcommand: "requests" }, filtered.data),
			effectiveArgs: options.effectiveArgs,
			networkRequestsPageFilter: {
				cleanArgs: redactInvocationArgs(request.cleanArgs),
				currentUrl: redactSensitiveText(currentUrl),
				matchedRows: filtered.matchedRows,
				mode: request.mode,
				totalRows: filtered.totalRows,
			},
			sessionMode: options.sessionMode,
			...buildAgentBrowserResultCategoryDetails({
				args: options.effectiveArgs,
				command: "network",
				succeeded: true,
			}),
			...buildSessionDetailFields(
				options.sessionName,
				options.usedImplicitSession,
				options.namespace,
				options.managedSessionRestoreDisabled(),
			),
			summary,
		},
		isError: false,
	};
}
