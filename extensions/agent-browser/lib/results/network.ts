import { isRecord } from "../parsing.js";
import type { NetworkFailureClassification, NetworkFailureSummary } from "./contracts.js";

export function getStringRecordField(
	value: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const field = value[key];
	return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

export function getNetworkRequestId(
	request: Readonly<Record<string, unknown>>,
): string | undefined {
	return getStringRecordField(request, "requestId") ?? getStringRecordField(request, "id");
}

function getNetworkRequestUrlPath(url: string | undefined): string | undefined {
	if (url === undefined || url.length === 0) {
		return undefined;
	}
	try {
		return new URL(url).pathname;
	} catch {
		const [withoutQuery = ""] = url.split(/[?#]/, 1);
		return withoutQuery.length > 0 ? withoutQuery : undefined;
	}
}

export function isFailedNetworkRequest(request: Readonly<Record<string, unknown>>): boolean {
	return (
		(typeof request.status === "number" && request.status >= 400) ||
		request.failed === true ||
		typeof request.error === "string"
	);
}

export function isNetworkArtifactNoiseRequest(request: Readonly<Record<string, unknown>>): boolean {
	const url = getStringRecordField(request, "url") ?? "";
	const resourceType = (
		getStringRecordField(request, "resourceType") ??
		getStringRecordField(request, "mimeType") ??
		""
	).toLowerCase();
	return /^data:image\//i.test(url) || (url.startsWith("data:") && resourceType.includes("image"));
}

function isIconResourceType(resourceType: string | undefined): boolean {
	const normalized = resourceType?.toLowerCase() ?? "";
	return (
		normalized.length === 0 ||
		["image", "img", "other"].includes(normalized) ||
		normalized.startsWith("image/")
	);
}

function isBenignAssetFailure(
	request: Readonly<Record<string, unknown>>,
	url: string | undefined,
	resourceType: string | undefined,
): boolean {
	const path = getNetworkRequestUrlPath(url);
	if (path === undefined || path.length === 0) {
		return false;
	}
	return (
		/(?:^|\/)(?:favicon(?:[-.\w]*)?\.(?:ico|png|svg)|apple-touch-icon(?:[-.\w]*)?\.png)$/i.test(
			path,
		) &&
		(request.status === 404 || request.failed === true || typeof request.error === "string") &&
		isIconResourceType(resourceType)
	);
}

export function isApiLikeNetworkRequest(request: Readonly<Record<string, unknown>>): boolean {
	const method = (getStringRecordField(request, "method") ?? "GET").toUpperCase();
	const resourceType = (getStringRecordField(request, "resourceType") ?? "").toLowerCase();
	const mimeType = (getStringRecordField(request, "mimeType") ?? "").toLowerCase();
	const path = getNetworkRequestUrlPath(getStringRecordField(request, "url")) ?? "";
	return (
		resourceType === "fetch" ||
		resourceType === "xhr" ||
		mimeType.includes("json") ||
		/\/(?:api|graphql|rpc)(?:\/|$)/i.test(path) ||
		!["GET", "HEAD"].includes(method)
	);
}

export function classifyNetworkRequestFailure(
	request: Readonly<Record<string, unknown>>,
): NetworkFailureClassification | undefined {
	if (!isFailedNetworkRequest(request)) {
		return undefined;
	}
	const url = getStringRecordField(request, "url");
	const resourceType =
		getStringRecordField(request, "resourceType") ?? getStringRecordField(request, "mimeType");
	const status = typeof request.status === "number" ? request.status : undefined;
	if (isBenignAssetFailure(request, url, resourceType)) {
		return { impact: "benign", reason: "low-impact browser icon asset", resourceType, status, url };
	}
	return {
		impact: "actionable",
		reason: "document, script, API, or non-benign request failure",
		resourceType,
		status,
		url,
	};
}

export function summarizeNetworkFailures(requests: readonly unknown[]): NetworkFailureSummary {
	const failures = requests.flatMap((request) => {
		if (!isRecord(request) || isNetworkArtifactNoiseRequest(request)) {
			return [];
		}
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
