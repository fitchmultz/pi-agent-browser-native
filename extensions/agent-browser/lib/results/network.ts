/**
 * Purpose: Classify failed network requests into actionable vs benign diagnostics.
 * Responsibilities: Recognize failed request rows, de-prioritize browser icon misses, and summarize failure counts.
 * Scope: Network diagnostic classification only.
 * Usage: QA preset analysis and presentation network summaries.
 * Invariants/Assumptions: Browser favicon/apple-touch icon misses are warnings; API/document/script failures are actionable.
 */

import { isRecord } from "../parsing.js";
import type { NetworkFailureClassification, NetworkFailureSummary } from "./contracts.js";

export function getStringRecordField(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

export function getNetworkRequestUrlPath(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).pathname;
	} catch {
		const withoutQuery = url.split(/[?#]/, 1)[0];
		return withoutQuery.length > 0 ? withoutQuery : undefined;
	}
}

function isFailedNetworkRequest(request: Record<string, unknown>): boolean {
	return (typeof request.status === "number" && request.status >= 400) || request.failed === true || typeof request.error === "string";
}

function isBenignAssetFailure(request: Record<string, unknown>, url: string | undefined, resourceType: string | undefined): boolean {
	const path = getNetworkRequestUrlPath(url);
	if (!path) return false;
	const normalizedResourceType = resourceType?.toLowerCase();
	return /(?:^|\/)(?:favicon(?:[-.\w]*)?\.(?:ico|png|svg)|apple-touch-icon(?:[-.\w]*)?\.png)$/i.test(path)
		&& (request.status === 404 || request.failed === true || typeof request.error === "string")
		&& (!normalizedResourceType || ["image", "img", "other"].includes(normalizedResourceType) || normalizedResourceType.startsWith("image/"));
}

export function isApiLikeNetworkRequest(request: Record<string, unknown>): boolean {
	const method = (getStringRecordField(request, "method") ?? "GET").toUpperCase();
	const resourceType = (getStringRecordField(request, "resourceType") ?? "").toLowerCase();
	const mimeType = (getStringRecordField(request, "mimeType") ?? "").toLowerCase();
	const path = getNetworkRequestUrlPath(getStringRecordField(request, "url")) ?? "";
	return resourceType === "fetch" || resourceType === "xhr" || mimeType.includes("json") || /\/(?:api|graphql|rpc)(?:\/|$)/i.test(path) || !["GET", "HEAD"].includes(method);
}

export function classifyNetworkRequestFailure(request: Record<string, unknown>): NetworkFailureClassification | undefined {
	if (!isFailedNetworkRequest(request)) return undefined;
	const url = getStringRecordField(request, "url");
	const resourceType = getStringRecordField(request, "resourceType") ?? getStringRecordField(request, "mimeType");
	const status = typeof request.status === "number" ? request.status : undefined;
	if (isBenignAssetFailure(request, url, resourceType)) {
		return { impact: "benign", reason: "low-impact browser icon asset", resourceType, status, url };
	}
	return { impact: "actionable", reason: "document, script, API, or non-benign request failure", resourceType, status, url };
}

export function summarizeNetworkFailures(requests: unknown[]): NetworkFailureSummary {
	const failures = requests.flatMap((request) => {
		if (!isRecord(request)) return [];
		const classification = classifyNetworkRequestFailure(request);
		return classification ? [classification] : [];
	});
	const benignCount = failures.filter((failure) => failure.impact === "benign").length;
	return {
		actionableCount: failures.length - benignCount,
		benignCount,
		failures,
		totalCount: failures.length,
	};
}
