import { isRecord } from "../parsing.js";
import { getLookupResultPayload, sourceCandidatesFromValue } from "./lookup-source-evidence.js";
import { getBatchResultItems } from "./shared.js";
import type {
	AgentBrowserNetworkSourceLookupCandidate,
	AgentBrowserNetworkSourceLookupRequest,
} from "./types.js";

function networkRequestMatchesQuery(
	url: string | undefined,
	queryText: string | undefined,
): boolean {
	return (
		queryText === undefined ||
		url === undefined ||
		url.includes(queryText) ||
		queryText.includes(url)
	);
}

function isFailedNetworkRecord(request: Readonly<Record<string, unknown>>): boolean {
	const status = typeof request.status === "number" ? request.status : undefined;
	const error = typeof request.error === "string" ? request.error : undefined;
	return request.failed === true || error !== undefined || (status !== undefined && status >= 400);
}

function requestId(request: Readonly<Record<string, unknown>>): string | undefined {
	if (typeof request.id === "string") {
		return request.id;
	}
	return typeof request.requestId === "string" ? request.requestId : undefined;
}

function failedRequestValues(payload: unknown): readonly unknown[] {
	if (isRecord(payload) && Array.isArray(payload.requests)) {
		return payload.requests;
	}
	if (Array.isArray(payload)) {
		return payload;
	}
	return isRecord(payload) ? [payload] : [];
}

export function getFailedNetworkRequests(
	data: unknown,
	queryText?: string,
): AgentBrowserNetworkSourceLookupRequest[] {
	const failed: AgentBrowserNetworkSourceLookupRequest[] = [];
	for (const item of getBatchResultItems(data)) {
		for (const request of failedRequestValues(getLookupResultPayload(item))) {
			if (!isRecord(request)) {
				continue;
			}
			const url = typeof request.url === "string" ? request.url : undefined;
			if (!networkRequestMatchesQuery(url, queryText) || !isFailedNetworkRecord(request)) {
				continue;
			}
			failed.push({
				error: typeof request.error === "string" ? request.error : undefined,
				method: typeof request.method === "string" ? request.method : undefined,
				requestId: requestId(request),
				status: typeof request.status === "number" ? request.status : undefined,
				url,
			});
		}
	}
	const seenRequestIds = new Set<string>();
	return failed.filter(({ requestId: id }) => {
		if (id === undefined) {
			return true;
		}
		if (seenRequestIds.has(id)) {
			return false;
		}
		seenRequestIds.add(id);
		return true;
	});
}

export function distinctNetworkCandidates(
	candidates: readonly AgentBrowserNetworkSourceLookupCandidate[],
): AgentBrowserNetworkSourceLookupCandidate[] {
	const keys = new Set<string>();
	return candidates.filter((candidate) => {
		const key = [
			candidate.source,
			candidate.file ?? "",
			candidate.line ?? "",
			candidate.requestUrl ?? "",
		].join(":");
		if (keys.has(key)) {
			return false;
		}
		keys.add(key);
		return true;
	});
}

function initiatorCandidates(
	request: Readonly<Record<string, unknown>>,
): AgentBrowserNetworkSourceLookupCandidate[] {
	const requestUrl = typeof request.url === "string" ? request.url : undefined;
	return [request.initiator, request.stack, request.source, request.trace].flatMap((field) =>
		sourceCandidatesFromValue(field, {
			source: "dom-attribute",
			evidence: ["failed network request included source-like initiator metadata"],
		}).map((candidate) => ({
			confidence: "medium",
			evidence: candidate.evidence,
			file: candidate.file,
			line: candidate.line,
			requestUrl,
			source: "initiator",
		})),
	);
}

function correlatesWithFailure(
	value: Readonly<Record<string, unknown>>,
	failedIds: ReadonlySet<string>,
	failedUrls: ReadonlySet<string>,
): boolean {
	const id = requestId(value);
	const url = typeof value.url === "string" ? value.url : undefined;
	return (id !== undefined && failedIds.has(id)) || (url !== undefined && failedUrls.has(url));
}

export function observeInitiatorCandidates(
	data: unknown,
	failedRequests: readonly AgentBrowserNetworkSourceLookupRequest[],
	queryText?: string,
): AgentBrowserNetworkSourceLookupCandidate[] {
	const failedIds = new Set(
		failedRequests.map((request) => request.requestId).filter((value) => value !== undefined),
	);
	const failedUrls = new Set(
		failedRequests.map((request) => request.url).filter((value) => value !== undefined),
	);
	const candidates: AgentBrowserNetworkSourceLookupCandidate[] = [];
	for (const item of getBatchResultItems(data)) {
		const payload = getLookupResultPayload(item);
		const values: readonly unknown[] =
			isRecord(payload) && Array.isArray(payload.requests) ? payload.requests : [payload];
		for (const value of values) {
			if (!isRecord(value)) {
				continue;
			}
			const url = typeof value.url === "string" ? value.url : undefined;
			if (
				networkRequestMatchesQuery(url, queryText) &&
				(correlatesWithFailure(value, failedIds, failedUrls) || isFailedNetworkRecord(value))
			) {
				candidates.push(...initiatorCandidates(value));
			}
		}
	}
	return distinctNetworkCandidates(candidates);
}
