/**
 * Purpose: Share stable result-rendering types and small data-shaping helpers across the focused result modules.
 * Responsibilities: Define upstream envelope/presentation types, provide safe string utilities, and expose lightweight text helpers used by envelope parsing, snapshot compaction, and presentation rendering.
 * Scope: Shared result helpers only; higher-level parsing, snapshot compaction, and image attachment orchestration live in neighboring modules.
 * Usage: Imported by the focused result modules that back the public `lib/results.ts` facade.
 * Invariants/Assumptions: Helpers stay generic, side-effect free, and small enough to reuse without reintroducing a new god module.
 */

export interface AgentBrowserEnvelope {
	data?: unknown;
	error?: unknown;
	success: boolean;
}

export interface AgentBrowserBatchResult {
	command?: string[];
	error?: unknown;
	result?: unknown;
	success?: boolean;
}

export type FileArtifactKind = "download" | "file" | "har" | "image" | "pdf" | "profile" | "trace" | "video";

export interface FileArtifactMetadata {
	absolutePath: string;
	command?: string;
	exists?: boolean;
	extension?: string;
	kind: FileArtifactKind;
	mediaType?: string;
	path: string;
	sizeBytes?: number;
	subcommand?: string;
}

export interface SavedFilePresentationDetails {
	command: "download" | "pdf" | "wait";
	kind: "download" | "pdf";
	metadata?: Record<string, unknown>;
	path: string;
	subcommand?: string;
}

export interface BatchStepPresentationDetails {
	artifacts?: FileArtifactMetadata[];
	command?: string[];
	commandText: string;
	data?: unknown;
	fullOutputPath?: string;
	fullOutputPaths?: string[];
	imagePath?: string;
	imagePaths?: string[];
	index: number;
	savedFile?: SavedFilePresentationDetails;
	savedFilePath?: string;
	success: boolean;
	summary: string;
	text: string;
}

export interface BatchFailurePresentationDetails {
	failedStep: BatchStepPresentationDetails;
	failureCount: number;
	successCount: number;
	totalCount: number;
}

export interface ToolPresentation {
	artifacts?: FileArtifactMetadata[];
	batchFailure?: BatchFailurePresentationDetails;
	batchSteps?: BatchStepPresentationDetails[];
	content: Array<{ text: string; type: "text" } | { data: string; mimeType: string; type: "image" }>;
	data?: unknown;
	fullOutputPath?: string;
	fullOutputPaths?: string[];
	imagePath?: string;
	imagePaths?: string[];
	savedFile?: SavedFilePresentationDetails;
	savedFilePath?: string;
	summary: string;
}

export function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function compareRefIds(left: string, right: string): number {
	const leftMatch = left.match(/^(?:[a-zA-Z]+)?(\d+)$/);
	const rightMatch = right.match(/^(?:[a-zA-Z]+)?(\d+)$/);
	if (leftMatch && rightMatch) {
		return Number(leftMatch[1]) - Number(rightMatch[1]);
	}
	return left.localeCompare(right);
}
