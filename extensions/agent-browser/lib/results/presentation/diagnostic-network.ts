import type { CommandInfo } from "../../argv-descriptor.js";
import { isRecord } from "../../parsing.js";
import { redactSensitiveText, redactSensitiveValue } from "../../runtime.js";
import {
	classifyNetworkRequestFailure,
	getNetworkRequestId,
	isNetworkArtifactNoiseRequest,
	summarizeNetworkFailures,
} from "../network.js";
import { stringifyUnknown, truncateText } from "../text.js";
import { getArrayField, getStringField, stringifyModelFacing } from "./common.js";
import { isClearDiagnosticCommand } from "./diagnostic-summary.js";

type Data = Readonly<Record<string, unknown>>;
interface IndexedRequest {
	readonly item: unknown;
	readonly index: number;
}
const REQUEST_PREVIEW_LIMIT = 40;
const PREVIEW_FIELDS = {
	request: ["postData"],
	response: ["responseBody"],
	error: ["error", "failureText", "errorText"],
};

function previewCandidate(item: Data, keys: readonly string[]): unknown {
	for (const key of keys) {
		const value = item[key];
		if (value !== undefined && value !== null && value !== "") {
			return value;
		}
	}
	return undefined;
}

function networkPreview(
	item: Data,
	keys: readonly string[],
	label: string,
	maxChars: number,
): string[] {
	const value = previewCandidate(item, keys);
	if (value === undefined || value === null) {
		return [];
	}
	const redacted = redactSensitiveValue(value);
	const raw = typeof redacted === "string" ? redacted : stringifyUnknown(redacted);
	const normalized = raw.replace(/\s+/g, " ").trim();
	return normalized.length === 0
		? []
		: [`   ${label}: ${truncateText(redactSensitiveText(normalized), maxChars)}`];
}

function networkRequestLine(item: Data, index: number): string[] {
	const method = getStringField(item, "method") ?? "GET";
	const status = typeof item.status === "number" ? String(item.status) : "pending";
	const type = getStringField(item, "resourceType") ?? getStringField(item, "mimeType");
	const url = getStringField(item, "url") ?? "(no url)";
	const requestId = getNetworkRequestId(item);
	const idText = requestId === undefined ? "" : ` [${redactSensitiveText(requestId)}]`;
	const classification = classifyNetworkRequestFailure(item);
	const impactText = classification ? ` [${classification.impact}: ${classification.reason}]` : "";
	return [
		`${index + 1}. ${status} ${method} ${truncateText(redactSensitiveText(url), 180)}${type === undefined ? "" : ` (${type})`}${idText}${impactText}`,
		...networkPreview(item, PREVIEW_FIELDS.request, "Payload", 280),
		...networkPreview(item, PREVIEW_FIELDS.response, "Response", 280),
		...networkPreview(item, PREVIEW_FIELDS.error, "Error", 220),
	];
}

function failureRank(request: IndexedRequest): number {
	const classification = isRecord(request.item)
		? classifyNetworkRequestFailure(request.item)
		: undefined;
	return classification?.impact === "actionable" ? 0 : 1;
}

function prioritizeRequests(requests: readonly IndexedRequest[]): IndexedRequest[] {
	const failed: IndexedRequest[] = [];
	const normal: IndexedRequest[] = [];
	for (const request of requests) {
		if (isRecord(request.item) && classifyNetworkRequestFailure(request.item)) {
			failed.push(request);
		} else {
			normal.push(request);
		}
	}
	failed.sort((left, right) => {
		const rankDifference = failureRank(left) - failureRank(right);
		return rankDifference === 0 ? left.index - right.index : rankDifference;
	});
	return [...failed, ...normal];
}

function requestPreview(request: IndexedRequest): string[] {
	return isRecord(request.item)
		? networkRequestLine(request.item, request.index)
		: [`${request.index + 1}. ${stringifyModelFacing(request.item)}`];
}

function networkRequestsPreview(requests: readonly unknown[]): string {
	const shown = [
		"Scope: upstream session aggregate unless the upstream command output says it was cleared or filtered for this page; do not attribute old requests to the current page without URL/time evidence.",
	];
	const indexed = requests.map((item, index) => ({ index, item }));
	const preview = indexed.filter(
		({ item }) => !(isRecord(item) && isNetworkArtifactNoiseRequest(item)),
	);
	const noiseCount = indexed.length - preview.length;
	const summary = summarizeNetworkFailures(preview.map(({ item }) => item));
	if (summary.totalCount > 0) {
		shown.push(
			`Network failure summary: ${summary.actionableCount} actionable, ${summary.benignCount} benign low-impact (${summary.totalCount} total).`,
		);
	}
	if (noiseCount > 0) {
		shown.push(
			`Diagnostic noise hidden from preview: ${noiseCount} data:image/artifact request row${noiseCount === 1 ? "" : "s"}; raw rows remain in details.data.requests.`,
		);
	}
	const prioritized = prioritizeRequests(preview);
	shown.push(...prioritized.slice(0, REQUEST_PREVIEW_LIMIT).flatMap(requestPreview));
	const omittedCount = Math.max(0, prioritized.length - REQUEST_PREVIEW_LIMIT);
	if (omittedCount > 0) {
		shown.push(
			`... (${omittedCount} additional non-noise requests omitted from preview; failed requests are shown first when present)`,
		);
	}
	return shown.join("\n");
}

export function formatNetworkRequestsText(data: Data, command: CommandInfo): string | undefined {
	const requests = getArrayField(data, "requests");
	if (isClearDiagnosticCommand(command) && data.cleared === true && !requests) {
		return "Network request buffer cleared.";
	}
	if (!requests) {
		return undefined;
	}
	if (isClearDiagnosticCommand(command)) {
		return requests.length === 0
			? "Network request buffer cleared; no prior request rows were returned. This reset output is not evidence of current-page network activity."
			: `Network request buffer cleared; upstream returned ${requests.length} cleared/stale row${requests.length === 1 ? "" : "s"}. Treat these as reset output, not current-page request failures.`;
	}
	return requests.length === 0
		? "No network requests captured. Scope: upstream session aggregate unless the upstream command output says it was cleared or filtered for this page."
		: networkRequestsPreview(requests);
}

export function formatNetworkRequestText(data: Data): string | undefined {
	if (getStringField(data, "url") === undefined && getNetworkRequestId(data) === undefined) {
		return undefined;
	}
	return networkRequestLine(data, 0).join("\n");
}
