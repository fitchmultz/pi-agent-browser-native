import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	isUpstreamGlobalFlagToken,
	projectUpstreamGlobalFlags,
	type IndexedArgvToken,
} from "../../argv-grammar.js";
import { pathExists } from "../../fs-utils.js";
import {
	extractCommandTokens,
	extractUpstreamCommandTokens,
	parseWaitCommandTokens,
} from "../../runtime.js";
import { getUpstreamEffectiveBatchSteps, parseBatchStdinJsonArray } from "../batch-stdin.js";
import { getScreenshotPathOperand } from "./artifact-paths.js";
import type {
	PreparedAgentBrowserArgs,
	ScreenshotArtifactRequest,
	ScreenshotPathRequest,
} from "./types.js";

function getArtifactParentPathTokenIndex(commandTokens: readonly string[]): number | undefined {
	if (commandTokens[0] === "download" && commandTokens.length >= 3) {
		return 2;
	}
	if (commandTokens[0] === "pdf" && commandTokens.length >= 2) {
		return 1;
	}
	if (commandTokens[0] === "state" && commandTokens[1] === "save" && commandTokens.length >= 3) {
		return 2;
	}
	if (commandTokens[0] === "wait") {
		return parseWaitCommandTokens(commandTokens).downloadPathIndex;
	}
	return undefined;
}

async function ensureArtifactParentDirectory(
	commandTokens: readonly string[],
	cwd: string,
): Promise<void> {
	const pathIndex = getArtifactParentPathTokenIndex(commandTokens);
	if (pathIndex === undefined) {
		return;
	}
	const requestedPath = commandTokens.at(pathIndex);
	if (requestedPath === undefined || requestedPath === "") {
		return;
	}
	await mkdir(dirname(resolve(cwd, requestedPath)), { recursive: true });
}

function screenshotPathOperand(
	commandTokens: readonly string[],
	batchStep: boolean,
): IndexedArgvToken | undefined {
	if (batchStep) {
		return getScreenshotPathOperand(commandTokens);
	}
	const projection = projectUpstreamGlobalFlags(commandTokens);
	const operand = getScreenshotPathOperand(projection.map(({ token }) => token));
	return operand === undefined ? undefined : projection[operand.index];
}

async function normalizeScreenshotPathInTokens(
	commandTokens: readonly string[],
	cwd: string,
	batchStep = false,
): Promise<{ request?: ScreenshotPathRequest; tokens: string[] }> {
	const operand = screenshotPathOperand(commandTokens, batchStep);
	// Upstream rejects a global flag inside a batch item; rewriting it into a path would hide that.
	if (operand === undefined || (batchStep && isUpstreamGlobalFlagToken(operand.token))) {
		return { tokens: [...commandTokens] };
	}
	const { index: pathIndex, token: requestedPath } = operand;
	const absolutePath = resolve(cwd, requestedPath);
	await mkdir(dirname(absolutePath), { recursive: true });
	const tokens = [...commandTokens];
	tokens[pathIndex] = absolutePath;
	const terminatorIndex = batchStep ? -1 : tokens.indexOf("--");
	if (terminatorIndex >= 0) {
		tokens.splice(terminatorIndex, 1);
	}
	return { request: { absolutePath, path: requestedPath }, tokens };
}

async function prepareRawBatchDirectories(
	steps: readonly (readonly string[])[],
	cwd: string,
): Promise<void> {
	for (const step of steps) {
		// Preserve native row ordering and fail at the first unwritable directory.
		await ensureArtifactParentDirectory(step, cwd);
		if (step[0] === "screenshot") {
			// Resolve only for mkdir: native raw row strings must remain unchanged.
			await normalizeScreenshotPathInTokens(step, cwd, true);
		}
	}
}

function isStringRow(value: unknown): value is string[] {
	if (!Array.isArray(value)) {
		return false;
	}
	const items: unknown[] = value;
	return items.every((item) => typeof item === "string");
}

async function prepareBatchScreenshotPaths(
	args: readonly string[],
	stdin: string | undefined,
	cwd: string,
): Promise<PreparedAgentBrowserArgs | undefined> {
	const commandTokens = extractUpstreamCommandTokens(args);
	if (commandTokens[0] !== "batch") {
		return undefined;
	}
	const argumentSteps = getUpstreamEffectiveBatchSteps(commandTokens);
	if (argumentSteps.length > 0) {
		await prepareRawBatchDirectories(argumentSteps, cwd);
		return undefined;
	}
	if (stdin === undefined) {
		return undefined;
	}
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error !== undefined && parsed.error !== "") {
		return undefined;
	}
	if (parsed.steps === undefined) {
		return undefined;
	}
	const batchScreenshotPathRequests: Array<ScreenshotPathRequest | undefined> = [];
	const preparedSteps = await Promise.all(
		parsed.steps.map(async (step, index) => {
			if (!isStringRow(step)) {
				return step;
			}
			await ensureArtifactParentDirectory(step, cwd);
			if (step[0] !== "screenshot") {
				return step;
			}
			const normalized = await normalizeScreenshotPathInTokens(step, cwd, true);
			batchScreenshotPathRequests[index] = normalized.request;
			return normalized.tokens;
		}),
	);
	if (!batchScreenshotPathRequests.some((request) => request !== undefined)) {
		return undefined;
	}
	return {
		args: [...args],
		batchScreenshotPathRequests: parsed.steps.flatMap((step, index) =>
			Array.isArray(step) && step.length === 0 ? [] : [batchScreenshotPathRequests[index]],
		),
		stdin: JSON.stringify(preparedSteps),
	};
}

export async function prepareAgentBrowserArgs(
	args: readonly string[],
	stdin: string | undefined,
	cwd: string,
): Promise<PreparedAgentBrowserArgs> {
	const preparedBatch = await prepareBatchScreenshotPaths(args, stdin, cwd);
	if (preparedBatch) {
		return preparedBatch;
	}
	const commandTokens = extractCommandTokens(args);
	await ensureArtifactParentDirectory(extractUpstreamCommandTokens(args), cwd);
	const normalized = await normalizeScreenshotPathInTokens(commandTokens, cwd);
	if (!normalized.request) {
		return { args: [...args] };
	}
	const commandStartIndex = args.length - commandTokens.length;
	return {
		args: [...args.slice(0, commandStartIndex), ...normalized.tokens],
		screenshotPathRequest: normalized.request,
	};
}

export async function repairScreenshotData(options: {
	readonly cwd: string;
	readonly data: Readonly<Record<string, unknown>>;
	readonly request: Readonly<ScreenshotPathRequest>;
}): Promise<{ data: Record<string, unknown>; request?: ScreenshotArtifactRequest }> {
	const { cwd, data, request } = options;
	if (data.changed === false) {
		return { data };
	}
	const reportedPath = typeof data.path === "string" ? data.path : undefined;
	const reportedAbsolutePath =
		reportedPath !== undefined && reportedPath !== "" ? resolve(cwd, reportedPath) : undefined;
	let status: ScreenshotArtifactRequest["status"] = (await pathExists(request.absolutePath))
		? "saved"
		: "missing";
	let tempPath: string | undefined;
	if (reportedAbsolutePath !== undefined && reportedAbsolutePath !== request.absolutePath) {
		tempPath = reportedAbsolutePath;
		if (status === "missing" && (await pathExists(reportedAbsolutePath))) {
			await mkdir(dirname(request.absolutePath), { recursive: true });
			await copyFile(reportedAbsolutePath, request.absolutePath);
			status = "repaired-from-temp";
		}
	}
	return {
		data: { ...data, path: request.absolutePath },
		request: { ...request, status, tempPath },
	};
}
