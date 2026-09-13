import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import { isRecord } from "../parsing.js";
import { isSessionArtifactManifest } from "../results/artifact-manifest.js";
import type { SessionArtifactManifest } from "../results/contracts.js";
import { parseCommandInfo, redactSensitiveValue } from "../runtime.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";

export interface AgentBrowserOutputFileDetails {
	absolutePath: string;
	bytes?: number;
	error?: string;
	path: string;
	source: "content.text" | "details.data" | "recording-receipt";
	status: "failed" | "saved";
}

export function normalizeRequestedOutputPath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function getTextContent(result: AgentBrowserToolResult): string {
	return result.content
		?.filter((item): item is { text: string; type: "text" } => item.type === "text")
		.map((item) => item.text)
		.join("\n\n") ?? "";
}

function getResultCommand(details: Record<string, unknown> | undefined) {
	const args = Array.isArray(details?.args) && details.args.every(value => typeof value === "string") ? details.args : [];
	return parseCommandInfo(args);
}

function isRecordingReceiptResult(result: AgentBrowserToolResult): boolean {
	const details = isRecord(result.details) ? result.details : undefined;
	return details?.command === "record" || getResultCommand(details).command === "record" || details?.recordingRecovery !== undefined
		|| (Array.isArray(details?.batchSteps) && details.batchSteps.some((step) => isRecord(step) && Array.isArray(step.command) && step.command[0] === "record"));
}

export function canWriteAgentBrowserOutput(result: AgentBrowserToolResult): boolean {
	return isRecordingReceiptResult(result) || (!result.isError && !(isRecord(result.details) && result.details.resultCategory === "failure"));
}

function getOutputSource(result: AgentBrowserToolResult): AgentBrowserOutputFileDetails["source"] {
	if (isRecordingReceiptResult(result)) return "recording-receipt";
	return isRecord(result.details) && result.details.data !== undefined ? "details.data" : "content.text";
}

async function readCompactedSpill(path: string | undefined, manifest: SessionArtifactManifest | undefined): Promise<unknown> {
	if (!path || !manifest?.entries.some((entry) =>
		entry.kind === "spill"
			&& (entry.path === path || entry.absolutePath === path)
			&& (entry.storageScope === "persistent-session" || entry.storageScope === "process-temp")
			&& (entry.retentionState === "live" || entry.retentionState === "ephemeral")
	)) throw new Error("Full compacted output is unavailable from the wrapper-managed spill; outputPath was not written.");
	const text = await readFile(path, "utf8");
	return extname(path) === ".json" ? JSON.parse(text) as unknown : text;
}

async function rehydrateCompactedData(data: unknown, details: Record<string, unknown>, manifest: SessionArtifactManifest | undefined): Promise<unknown> {
	if (isRecord(data) && data.compacted === true) {
		return readCompactedSpill(typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined, manifest);
	}
	if (!Array.isArray(data)) return data;
	const batchSteps = Array.isArray(details.batchSteps) ? details.batchSteps : [];
	return Promise.all(data.map(async (row, index) => {
		if (!isRecord(row) || !isRecord(row.result) || row.result.compacted !== true) return row;
		const step = isRecord(batchSteps[index]) ? batchSteps[index] : undefined;
		const path = typeof step?.fullOutputPath === "string"
			? step.fullOutputPath
			: typeof row.result.fullOutputPath === "string" ? row.result.fullOutputPath : undefined;
		return { ...row, result: await readCompactedSpill(path, manifest) };
	}));
}

async function getOutputPayload(result: AgentBrowserToolResult): Promise<{ source: AgentBrowserOutputFileDetails["source"]; value: unknown }> {
	const details = isRecord(result.details) ? result.details : undefined;
	if (!details) return { source: "content.text", value: getTextContent(result) };
	const manifest = isSessionArtifactManifest(details.artifactManifest) ? details.artifactManifest : undefined;
	const data = await rehydrateCompactedData(details.data, details, manifest);
	if (isRecordingReceiptResult(result)) {
		const success = !result.isError && details.resultCategory !== "failure";
		const recovery = isRecord(details.recordingRecovery) ? details.recordingRecovery : undefined;
		const commandInfo = getResultCommand(details);
		return { source: "recording-receipt", value: redactSensitiveValue({
			success, error: details.error ?? (success ? null : details.summary ?? getTextContent(result)),
			command: details.command ?? commandInfo.command, subcommand: details.subcommand ?? commandInfo.subcommand, sessionName: details.sessionName, namespace: details.namespace,
			attempt: recovery?.attempt ?? { success, agentBrowserStarted: details.agentBrowserStarted ?? null, exitCode: details.exitCode ?? null, timedOut: details.timedOut === true, error: details.error ?? details.validationError ?? null, parseError: details.parseError ?? null },
			data: data ?? null, artifacts: details.artifacts, artifactVerification: details.artifactVerification, recordingRecovery: recovery,
		}) };
	}
	return data === undefined ? { source: "content.text", value: getTextContent(result) } : { source: "details.data", value: data };
}

function serializeOutputPayload(value: unknown): string {
	return typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
}

function appendOutputFileNotice(result: AgentBrowserToolResult, message: string, failed = false): AgentBrowserToolResult["content"] {
	const content = [...(result.content ?? [])] as AgentBrowserToolResult["content"];
	if (content[0]?.type === "text") {
		try {
			const json = JSON.parse(content[0].text);
			if (isRecord(json) && typeof json.success === "boolean") {
				content[0] = { type: "text", text: JSON.stringify({ ...json, ...(failed ? { success: false, error: message } : {}), outputFileNotice: message }, null, 2) };
				return content;
			}
		} catch {}
		content[0] = { ...content[0], text: `${content[0].text}\n\n${message}` };
		return content;
	}
	return [{ type: "text", text: message }, ...content];
}

function getArtifactPaths(result: AgentBrowserToolResult, cwd: string): string[] {
	const details = isRecord(result.details) ? result.details : undefined;
	if (!details || !Array.isArray(details.artifacts)) return [];
	return details.artifacts.flatMap((artifact) => {
		if (!isRecord(artifact)) return [];
		const path = typeof artifact.absolutePath === "string" ? artifact.absolutePath : typeof artifact.path === "string" ? artifact.path : undefined;
		return path ? [isAbsolute(path) ? path : resolve(cwd, path)] : [];
	});
}

async function pathsReferToSameFile(left: string, right: string): Promise<boolean> {
	if (resolve(left) === resolve(right)) return true;
	try {
		if (await realpath(left) === await realpath(right)) return true;
	} catch {}
	try {
		const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
		return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
}

export async function applyAgentBrowserOutputPath(options: {
	cwd: string;
	outputPath?: string;
	preserveTextContent?: boolean;
	result: AgentBrowserToolResult;
}): Promise<AgentBrowserToolResult> {
	if (!options.outputPath) return options.result;
	if (!canWriteAgentBrowserOutput(options.result)) return options.result;
	const requestedPath = normalizeRequestedOutputPath(options.outputPath);
	const absolutePath = isAbsolute(requestedPath) ? requestedPath : resolve(options.cwd, requestedPath);
	const source = getOutputSource(options.result);
	for (const artifactPath of getArtifactPaths(options.result, options.cwd)) {
		if (!await pathsReferToSameFile(absolutePath, artifactPath)) continue;
		const message = "outputPath resolves to the same file as a browser artifact destination; choose a separate outputPath or omit it. The browser artifact was preserved.";
		const outputFile: AgentBrowserOutputFileDetails = { absolutePath, error: message, path: requestedPath, source, status: "failed" };
		const details = isRecord(options.result.details) ? { ...options.result.details } : {};
		delete details.successCategory;
		return {
			...options.result,
			content: appendOutputFileNotice(options.result, `Output file rejected: ${message}`, true),
			details: { ...details, failureCategory: "validation-error", outputFile, resultCategory: "failure" },
			isError: true,
		};
	}
	try {
		const payload = await getOutputPayload(options.result);
		const serialized = serializeOutputPayload(payload.value);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, serialized, "utf8");
		const bytes = Buffer.byteLength(serialized, "utf8");
		const outputFile: AgentBrowserOutputFileDetails = { absolutePath, bytes, path: requestedPath, source: payload.source, status: "saved" };
		const details = isRecord(options.result.details) ? { ...options.result.details, outputFile } : { outputFile };
		return {
			...options.result,
			content: options.preserveTextContent ? options.result.content : appendOutputFileNotice(options.result, `Output file: ${requestedPath} (${bytes} bytes from ${payload.source}).`),
			details,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const outputFile: AgentBrowserOutputFileDetails = { absolutePath, error: message, path: requestedPath, source, status: "failed" };
		const details = isRecord(options.result.details)
			? (() => {
				const rest = { ...options.result.details };
				delete rest.successCategory;
				return { ...rest, failureCategory: rest.failureCategory ?? "upstream-error", outputFile, resultCategory: "failure" };
			})()
			: { failureCategory: "upstream-error", outputFile, resultCategory: "failure" };
		return {
			...options.result,
			content: appendOutputFileNotice(options.result, `Output file failed: ${requestedPath} (${message}).`, true),
			details,
			isError: true,
		};
	}
}
