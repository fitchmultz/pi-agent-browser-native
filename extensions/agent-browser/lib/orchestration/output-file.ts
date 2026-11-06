import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { isRecord } from "../parsing.js";
import { isStringArray } from "../input-modes/shared.js";
import { getBooleanFlagValue } from "../argv-grammar.js";
import { isSessionArtifactManifest } from "../results/artifact-manifest.js";
import type { SessionArtifactManifest } from "../results/contracts.js";
import { parseCommandInfo, redactSensitiveValue } from "../runtime.js";
import { stringifyUnknown } from "../results/text.js";
import type { AgentBrowserToolResult } from "./browser-run/types.js";

export interface AgentBrowserOutputFileDetails {
	readonly absolutePath: string;
	readonly bytes?: number;
	readonly error?: string;
	readonly path: string;
	readonly source: "content.text" | "details.data" | "recording-receipt";
	readonly status: "failed" | "saved";
}

type Details = Readonly<Record<string, unknown>>;

export function normalizeRequestedOutputPath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function getTextContent(result: AgentBrowserToolResult): string {
	return result.content
		.filter((item): item is { text: string; type: "text" } => item.type === "text")
		.map((item) => item.text)
		.join("\n\n");
}

function getResultCommand(details: Details | undefined): ReturnType<typeof parseCommandInfo> {
	return parseCommandInfo(isStringArray(details?.args) ? details.args : []);
}

function isRecordingReceiptResult(result: AgentBrowserToolResult): boolean {
	const details = isRecord(result.details) ? result.details : undefined;
	return (
		details?.command === "record" ||
		getResultCommand(details).command === "record" ||
		details?.recordingRecovery !== undefined ||
		(Array.isArray(details?.batchSteps) &&
			details.batchSteps.some(
				(step: unknown) =>
					isRecord(step) && Array.isArray(step.command) && step.command[0] === "record",
			))
	);
}

export function canWriteAgentBrowserOutput(result: AgentBrowserToolResult): boolean {
	return (
		isRecordingReceiptResult(result) ||
		(result.isError !== true &&
			!(isRecord(result.details) && result.details.resultCategory === "failure"))
	);
}

function getOutputSource(result: AgentBrowserToolResult): AgentBrowserOutputFileDetails["source"] {
	if (isRecordingReceiptResult(result)) {
		return "recording-receipt";
	}
	return isRecord(result.details) && result.details.data !== undefined
		? "details.data"
		: "content.text";
}

function preferredString(
	record: Details | undefined,
	primary: string,
	fallback?: string,
): string | undefined {
	const first = record?.[primary];
	if (typeof first === "string") {
		return first;
	}
	const second = fallback === undefined ? undefined : record?.[fallback];
	return typeof second === "string" ? second : undefined;
}

async function readCompactedSpill(
	path: string | undefined,
	manifest: SessionArtifactManifest | undefined,
): Promise<unknown> {
	const live = manifest?.entries.some(
		(entry) =>
			entry.kind === "spill" &&
			(entry.path === path || entry.absolutePath === path) &&
			(entry.storageScope === "persistent-session" || entry.storageScope === "process-temp") &&
			(entry.retentionState === "live" || entry.retentionState === "ephemeral"),
	);
	if (path === undefined || path.length === 0 || live !== true) {
		throw new Error(
			"Full compacted output is unavailable from the wrapper-managed spill; outputPath was not written.",
		);
	}
	const text = await readFile(path, "utf8");
	if (extname(path) !== ".json") {
		return text;
	}
	const parsed: unknown = JSON.parse(text);
	return parsed;
}

async function rehydrateCompactedData(
	data: unknown,
	details: Details,
	manifest: SessionArtifactManifest | undefined,
): Promise<unknown> {
	if (isRecord(data) && data.compacted === true) {
		return readCompactedSpill(preferredString(details, "fullOutputPath"), manifest);
	}
	if (!Array.isArray(data)) {
		return data;
	}
	const batchSteps = Array.isArray(details.batchSteps) ? details.batchSteps : [];
	return Promise.all(
		data.map(async (row: unknown, index) => {
			if (!isRecord(row) || !isRecord(row.result) || row.result.compacted !== true) {
				return row;
			}
			const rawStep: unknown = batchSteps[index];
			const step = isRecord(rawStep) ? rawStep : undefined;
			const path =
				preferredString(step, "fullOutputPath") ?? preferredString(row.result, "fullOutputPath");
			return { ...row, result: await readCompactedSpill(path, manifest) };
		}),
	);
}

function recordingAttempt(details: Details, success: boolean): Details {
	return {
		success,
		agentBrowserStarted: details.agentBrowserStarted ?? null,
		exitCode: details.exitCode ?? null,
		timedOut: details.timedOut === true,
		error: details.error ?? details.validationError ?? null,
		parseError: details.parseError ?? null,
	};
}

function recordingError(
	result: AgentBrowserToolResult,
	details: Details,
	success: boolean,
): unknown {
	return details.error ?? (success ? null : (details.summary ?? getTextContent(result)));
}

function recordingReceipt(
	result: AgentBrowserToolResult,
	data: unknown,
	details: Details,
): unknown {
	const success = result.isError !== true && details.resultCategory !== "failure";
	const recovery = isRecord(details.recordingRecovery) ? details.recordingRecovery : undefined;
	const command = getResultCommand(details);
	return redactSensitiveValue({
		success,
		error: recordingError(result, details, success),
		command: details.command ?? command.command,
		subcommand: details.subcommand ?? command.subcommand,
		sessionName: details.sessionName,
		namespace: details.namespace,
		attempt: recovery?.attempt ?? recordingAttempt(details, success),
		data: data ?? null,
		artifacts: details.artifacts,
		artifactVerification: details.artifactVerification,
		recordingRecovery: recovery,
	});
}

async function getOutputPayload(
	result: AgentBrowserToolResult,
): Promise<{ source: AgentBrowserOutputFileDetails["source"]; value: unknown }> {
	const details = isRecord(result.details) ? result.details : undefined;
	if (details === undefined) {
		return { source: "content.text", value: getTextContent(result) };
	}
	const manifest = isSessionArtifactManifest(details.artifactManifest)
		? details.artifactManifest
		: undefined;
	const data = await rehydrateCompactedData(details.data, details, manifest);
	if (isRecordingReceiptResult(result)) {
		return { source: "recording-receipt", value: recordingReceipt(result, data, details) };
	}
	return data === undefined
		? { source: "content.text", value: getTextContent(result) }
		: { source: "details.data", value: data };
}

function jsonOutputNotice(
	result: AgentBrowserToolResult,
	text: string,
	message: string,
	failed: boolean,
): string | undefined {
	const nativeText =
		isRecord(result.details) &&
		isStringArray(result.details.args) &&
		getBooleanFlagValue(result.details.args, "--json") === false;
	if (nativeText) {
		return undefined;
	}
	try {
		const json: unknown = JSON.parse(text);
		if (isRecord(json) && typeof json.success === "boolean") {
			return JSON.stringify(
				{
					...json,
					...(failed ? { success: false, error: message } : {}),
					outputFileNotice: message,
				},
				null,
				2,
			);
		}
	} catch {
		/* Non-JSON native text receives a prose notice instead. */
	}
	return undefined;
}

function appendOutputFileNotice(
	result: AgentBrowserToolResult,
	message: string,
	failed = false,
): AgentBrowserToolResult["content"] {
	const content = [...result.content];
	if (content[0]?.type === "text") {
		const json = jsonOutputNotice(result, content[0].text, message, failed);
		content[0] = { type: "text", text: json ?? `${content[0].text}\n\n${message}` };
		return content;
	}
	return [{ type: "text", text: message }, ...content];
}

function getArtifactPaths(result: AgentBrowserToolResult, cwd: string): string[] {
	const details = isRecord(result.details) ? result.details : undefined;
	if (details === undefined || !Array.isArray(details.artifacts)) {
		return [];
	}
	return details.artifacts.flatMap((artifact: unknown) => {
		if (!isRecord(artifact)) {
			return [];
		}
		const path = preferredString(artifact, "absolutePath", "path");
		return path !== undefined && path.length > 0
			? [isAbsolute(path) ? path : resolve(cwd, path)]
			: [];
	});
}

async function pathsReferToSameFile(left: string, right: string): Promise<boolean> {
	if (resolve(left) === resolve(right)) {
		return true;
	}
	try {
		const [leftPath, rightPath] = await Promise.all([realpath(left), realpath(right)]);
		if (leftPath === rightPath) {
			return true;
		}
	} catch {
		/* Missing paths can still be compared through stat when both resolve later. */
	}
	try {
		const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
		return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
}

async function overlapsArtifact(
	result: AgentBrowserToolResult,
	path: string,
	cwd: string,
): Promise<boolean> {
	for (const artifact of getArtifactPaths(result, cwd)) {
		// Stop on the first alias; never write while any browser artifact identity remains unchecked.
		if (await pathsReferToSameFile(path, artifact)) {
			return true;
		}
	}
	return false;
}

function failedOutputResult(
	result: AgentBrowserToolResult,
	outputFile: AgentBrowserOutputFileDetails,
	rejected: boolean,
): AgentBrowserToolResult {
	const details = isRecord(result.details) ? { ...result.details } : {};
	delete details.successCategory;
	const message = outputFile.error ?? "Output file failed.";
	return {
		...result,
		content: appendOutputFileNotice(
			result,
			rejected
				? `Output file rejected: ${message}`
				: `Output file failed: ${outputFile.path} (${message}).`,
			true,
		),
		details: {
			...details,
			error: message,
			summary: rejected ? "Output file rejected." : "Output file failed.",
			failureCategory: rejected
				? "validation-error"
				: (details.failureCategory ?? "upstream-error"),
			outputFile,
			resultCategory: "failure",
		},
		isError: true,
	};
}

async function saveOutput(
	result: AgentBrowserToolResult,
	destination: AgentBrowserOutputFileDetails,
	preserveText: boolean,
): Promise<AgentBrowserToolResult> {
	const payload = await getOutputPayload(result);
	const serialized =
		typeof payload.value === "string"
			? payload.value
			: `${JSON.stringify(payload.value, null, 2)}\n`;
	await mkdir(dirname(destination.absolutePath), { recursive: true });
	await writeFile(destination.absolutePath, serialized, "utf8");
	const bytes = Buffer.byteLength(serialized, "utf8");
	const outputFile: AgentBrowserOutputFileDetails = {
		...destination,
		bytes,
		source: payload.source,
		status: "saved",
	};
	const details = isRecord(result.details) ? { ...result.details, outputFile } : { outputFile };
	return {
		...result,
		content: preserveText
			? result.content
			: appendOutputFileNotice(
					result,
					`Output file: ${destination.path} (${bytes} bytes from ${payload.source}).`,
				),
		details,
	};
}

export async function applyAgentBrowserOutputPath(options: {
	readonly cwd: string;
	readonly outputPath?: string | undefined;
	readonly preserveTextContent?: boolean;
	readonly result: AgentBrowserToolResult;
}): Promise<AgentBrowserToolResult> {
	if (
		options.outputPath === undefined ||
		options.outputPath.length === 0 ||
		!canWriteAgentBrowserOutput(options.result)
	) {
		return options.result;
	}
	const path = normalizeRequestedOutputPath(options.outputPath);
	const destination: AgentBrowserOutputFileDetails = {
		absolutePath: isAbsolute(path) ? path : resolve(options.cwd, path),
		path,
		source: getOutputSource(options.result),
		status: "failed",
	};
	if (await overlapsArtifact(options.result, destination.absolutePath, options.cwd)) {
		return failedOutputResult(
			options.result,
			{
				...destination,
				error:
					"outputPath resolves to the same file as a browser artifact destination; choose a separate outputPath or omit it. The browser artifact was preserved.",
			},
			true,
		);
	}
	try {
		return await saveOutput(options.result, destination, options.preserveTextContent === true);
	} catch (error) {
		return failedOutputResult(
			options.result,
			{ ...destination, error: error instanceof Error ? error.message : stringifyUnknown(error) },
			false,
		);
	}
}
