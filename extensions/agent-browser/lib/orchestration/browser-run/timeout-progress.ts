import { isRecord } from "../../parsing.js";
import { redactSensitiveText } from "../../runtime-redaction.js";

export interface TimeoutArtifactEvidence {
	readonly absolutePath: string;
	readonly exists: boolean;
	readonly path: string;
	readonly sizeBytes?: number;
	readonly state: "missing" | "verified";
	readonly stepIndex: number;
}

export interface TimeoutProgressStep {
	readonly args: readonly string[];
	readonly generatedFrom?: string | undefined;
	readonly index: number;
	readonly reason?: string;
	readonly retry?: { readonly args: readonly string[]; readonly stdin: string };
	readonly status: "unknown";
}

export interface TimeoutPartialProgressDetails {
	readonly artifacts: readonly TimeoutArtifactEvidence[];
	readonly currentPage?:
		| {
				readonly source?: "live" | "planned" | undefined;
				readonly title?: string | undefined;
				readonly url?: string | undefined;
		  }
		| undefined;
	readonly liveUrlRecovered?: boolean;
	readonly retryStep?: TimeoutProgressStep | undefined;
	readonly steps?: readonly TimeoutProgressStep[] | undefined;
	readonly summary: string;
}

export type TimeoutPartialProgress = TimeoutPartialProgressDetails;

function isStringList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function optionalStringFields(
	value: Readonly<Record<string, unknown>>,
	fields: readonly string[],
): boolean {
	return fields.every((field) => value[field] === undefined || typeof value[field] === "string");
}

function isTimeoutArtifact(value: unknown): value is TimeoutArtifactEvidence {
	return (
		isRecord(value) &&
		typeof value.absolutePath === "string" &&
		typeof value.exists === "boolean" &&
		typeof value.path === "string" &&
		(value.sizeBytes === undefined || typeof value.sizeBytes === "number") &&
		(value.state === "missing" || value.state === "verified") &&
		typeof value.stepIndex === "number"
	);
}

function isTimeoutRetry(value: unknown): boolean {
	return (
		value === undefined ||
		(isRecord(value) && isStringList(value.args) && typeof value.stdin === "string")
	);
}

function isTimeoutStep(value: unknown): value is TimeoutProgressStep {
	return (
		isRecord(value) &&
		isStringList(value.args) &&
		typeof value.index === "number" &&
		value.status === "unknown" &&
		optionalStringFields(value, ["generatedFrom", "reason"]) &&
		isTimeoutRetry(value.retry)
	);
}

function isTimeoutCurrentPage(value: unknown): boolean {
	return (
		value === undefined ||
		(isRecord(value) &&
			(value.source === undefined || value.source === "live" || value.source === "planned") &&
			optionalStringFields(value, ["title", "url"]))
	);
}

function isTimeoutSteps(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every(isTimeoutStep));
}

export function isTimeoutPartialProgress(value: unknown): value is TimeoutPartialProgressDetails {
	if (
		!isRecord(value) ||
		!Array.isArray(value.artifacts) ||
		!value.artifacts.every(isTimeoutArtifact)
	) {
		return false;
	}
	return (
		typeof value.summary === "string" &&
		isTimeoutCurrentPage(value.currentPage) &&
		(value.liveUrlRecovered === undefined || typeof value.liveUrlRecovered === "boolean") &&
		(value.retryStep === undefined || isTimeoutStep(value.retryStep)) &&
		isTimeoutSteps(value.steps)
	);
}

export function redactSensitivePathSegmentsForDiagnostic(path: string): string {
	return path
		.split(/([/\\]+)/)
		.map((segment) => {
			if (segment === "/" || segment === "\\" || /^[/\\]+$/.test(segment)) {
				return segment;
			}
			return redactSensitiveText(segment) !== segment ||
				/(?:secret|token|password|passwd|credential|auth|api[-_]?key|bearer)/i.test(segment)
				? "[REDACTED]"
				: segment;
		})
		.join("");
}

export function sanitizeCurrentPageUrlForTimeoutDiagnostic(url: string): string {
	try {
		const parsedUrl = new URL(url);
		parsedUrl.pathname = parsedUrl.pathname
			.split("/")
			.map(redactSensitivePathSegmentsForDiagnostic)
			.join("/");
		for (const [key, value] of parsedUrl.searchParams.entries()) {
			if (
				redactSensitiveText(key) !== key ||
				redactSensitiveText(value) !== value ||
				/(?:secret|token|password|passwd|credential|auth|api[-_]?key|bearer)/i.test(
					`${key} ${value}`,
				)
			) {
				parsedUrl.searchParams.set(key, "[REDACTED]");
			}
		}
		if (parsedUrl.hash !== "") {
			parsedUrl.hash = redactSensitivePathSegmentsForDiagnostic(
				redactSensitiveText(parsedUrl.hash),
			);
		}
		return redactSensitiveText(parsedUrl.toString());
	} catch {
		return redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(url));
	}
}

function redactProgressValue(value: unknown): unknown {
	if (typeof value === "string") {
		return /^https?:\/\//i.test(value)
			? sanitizeCurrentPageUrlForTimeoutDiagnostic(value)
			: redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(value));
	}
	if (Array.isArray(value)) {
		return value.map(redactProgressValue);
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, redactProgressValue(item)]),
		);
	}
	return value;
}

export function redactTimeoutPartialProgress(
	progress: TimeoutPartialProgressDetails,
): TimeoutPartialProgressDetails {
	const redacted = redactProgressValue(progress);
	if (!isTimeoutPartialProgress(redacted)) {
		throw new Error("Invalid timeout partial-progress evidence.");
	}
	return redacted;
}
