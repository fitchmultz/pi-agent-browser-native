import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import { launchElectronApp, type ElectronLaunchSuccess } from "../../electron/launch.js";
import { pathExists } from "../../fs-utils.js";
import { getCompiledSemanticActionSessionPrefix, type CompiledAgentBrowserSemanticAction } from "../../input-modes.js";
import { getAgentBrowserProcessTimeoutMs } from "../../process.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results.js";
import { buildSnapshotPresentation } from "../../results/snapshot.js";
import { buildSessionAwareStaleRefNextActions, buildSessionTabRecoveryNextActions } from "../../results/recovery-next-actions.js";
import { resolveVisibleRefActionFromSnapshot } from "../../results/selector-recovery.js";
import { extractRefSnapshotFromData, type SessionRefSnapshot, type SessionTabTarget } from "../../session-page-state.js";
import {
	buildExecutionPlan,
	createFreshSessionName,
	extractCommandTokens,
	redactInvocationArgs,
	redactSensitiveText,
	type CompatibilityWorkaround,
} from "../../runtime.js";
import {
	applyOpenResultTabCorrection,
	buildManagedSessionOutcome,
	buildPinnedBatchPlan,
	buildSessionDetailFields,
	buildStaleRefPreflight,
	collectSessionTabSelection,
	getGuardedRefUsage,
	getTraceOwnerGuardMessage,
	runSessionCommandData,
	shouldPinSessionTabForCommand,
} from "./session-state.js";
import { isRecord } from "../../parsing.js";
import { parseBatchStdinJsonArray, parseValidBatchStepEntries } from "../batch-stdin.js";
import { buildElectronHostFailureResult, getElectronLaunchFailureCategory, redactRecoveryHint } from "./final-result.js";
import { prepareClickDispatchProbe } from "./click-dispatch.js";
import { buildScrollNoopNextActions, collectScrollPositionSnapshot, validateQaAttachedPrecondition } from "./diagnostics.js";
import { findRequestedArtifactCloseViolation } from "./prompt-guards.js";

import type {
	AgentBrowserToolResult,
	BrowserRunInputFields,
	BrowserRunOptions,
	PreparedAgentBrowserArgs,
	PreparedBrowserRun,
	PrepareBrowserRunResult,
	ScreenshotArtifactRequest,
	ScreenshotPathRequest,
	SemanticActionVisibleRefResolution,
	StaleRefPreflight,
} from "./types.js";

const DIRECT_ANCHOR_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024;
const SCREENSHOT_VALUE_FLAGS = new Set(["--screenshot-dir", "--screenshot-format", "--screenshot-quality"]);
const SCREENSHOT_IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);

export function normalizeRunInput(input: BrowserRunOptions["input"]): BrowserRunInputFields {
	const base = { redactedArgs: input.redactedArgs, toolArgs: input.toolArgs, toolStdin: input.toolStdin };
	switch (input.kind) {
		case "electron":
			return { ...base, compiledElectron: input.compiledElectron, redactedCompiledElectron: input.redactedCompiledElectron };
		case "job":
			return { ...base, compiledJob: input.compiledJob, redactedCompiledJob: input.redactedCompiledJob };
		case "networkSourceLookup":
			return { ...base, compiledNetworkSourceLookup: input.compiledNetworkSourceLookup, redactedCompiledNetworkSourceLookup: input.redactedCompiledNetworkSourceLookup };
		case "qa":
			return { ...base, compiledJob: input.compiledJob, compiledQaPreset: input.compiledQaPreset, redactedCompiledJob: input.redactedCompiledJob, redactedCompiledQaPreset: input.redactedCompiledQaPreset };
		case "semanticAction":
			return { ...base, compiledSemanticAction: input.compiledSemanticAction, redactedCompiledSemanticAction: input.redactedCompiledSemanticAction };
		case "sourceLookup":
			return { ...base, compiledSourceLookup: input.compiledSourceLookup, redactedCompiledSourceLookup: input.redactedCompiledSourceLookup };
		case "args":
			return base;
	}
}

export function buildInvocationPreview(effectiveArgs: string[]): string {
	const preview = effectiveArgs.join(" ");
	return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

function isImagePathToken(token: string): boolean {
	const extension = extname(token).toLowerCase();
	return SCREENSHOT_IMAGE_EXTENSIONS.has(extension);
}

export function getScreenshotPathTokenIndex(commandTokens: string[]): number | undefined {
	if (commandTokens[0] !== "screenshot") {
		return undefined;
	}

	const positionalIndices: number[] = [];
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--") {
			for (let positionalIndex = index + 1; positionalIndex < commandTokens.length; positionalIndex += 1) {
				positionalIndices.push(positionalIndex);
			}
			break;
		}
		if (token.startsWith("-")) {
			const normalizedToken = token.split("=", 1)[0] ?? token;
			if (SCREENSHOT_VALUE_FLAGS.has(normalizedToken) && !token.includes("=")) {
				index += 1;
			}
			continue;
		}
		positionalIndices.push(index);
	}

	if (positionalIndices.length === 0) {
		return undefined;
	}
	const candidateIndex = positionalIndices[positionalIndices.length - 1];
	const candidate = commandTokens[candidateIndex];
	if (positionalIndices.length >= 2 || isImagePathToken(candidate) || isAbsolute(candidate) || candidate.startsWith("./") || candidate.startsWith("../")) {
		return candidateIndex;
	}
	return undefined;
}

function getArtifactParentPathTokenIndex(commandTokens: string[]): number | undefined {
	if (commandTokens[0] === "download" && commandTokens.length >= 3) return 2;
	if (commandTokens[0] === "pdf" && commandTokens.length >= 2) return 1;
	if (commandTokens[0] === "state" && commandTokens[1] === "save" && commandTokens.length >= 3) return 2;
	if (commandTokens[0] === "wait") {
		const downloadIndex = commandTokens.findIndex((token) => token === "--download");
		const pathIndex = downloadIndex >= 0 ? downloadIndex + 1 : -1;
		if (pathIndex > 0 && typeof commandTokens[pathIndex] === "string" && !commandTokens[pathIndex].startsWith("-")) return pathIndex;
	}
	return undefined;
}

async function ensureArtifactParentDirectory(commandTokens: string[], cwd: string): Promise<void> {
	const pathIndex = getArtifactParentPathTokenIndex(commandTokens);
	if (pathIndex === undefined) return;
	const requestedPath = commandTokens[pathIndex];
	if (!requestedPath) return;
	await mkdir(dirname(resolve(cwd, requestedPath)), { recursive: true });
}

function getDirectDownloadRequest(commandTokens: string[]): { path: string; selector: string } | undefined {
	if (commandTokens[0] !== "download" || commandTokens.length !== 3) return undefined;
	const selector = commandTokens[1];
	const path = commandTokens[2];
	if (!selector || !path || selector.startsWith("@")) return undefined;
	return { path, selector };
}

function buildAnchorDownloadProbe(selector: string): string {
	return `(async () => {\n  const selector = ${JSON.stringify(selector)};\n  const maxBytes = ${DIRECT_ANCHOR_DOWNLOAD_MAX_BYTES};\n  const isLoopbackHttpUrl = (url) => (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]");\n  const element = document.querySelector(selector);\n  const anchor = element?.closest?.("a[href]");\n  const pageUrl = location.href;\n  const page = new URL(pageUrl);\n  if (!anchor) return { status: "no-anchor", pageUrl };\n  const href = anchor.href;\n  const anchorUrl = new URL(href, pageUrl);\n  if (!isLoopbackHttpUrl(page)) return { download: anchor.getAttribute("download") || "", href, pageUrl, status: "not-loopback-page" };\n  if (anchorUrl.origin !== page.origin) return { download: anchor.getAttribute("download") || "", href, pageUrl, status: "not-same-origin" };\n  if (!isLoopbackHttpUrl(anchorUrl)) return { download: anchor.getAttribute("download") || "", href, pageUrl, status: "not-loopback-href" };\n  const response = await fetch(anchorUrl.href, { credentials: "include", redirect: "manual" });\n  if (!response.ok) return { download: anchor.getAttribute("download") || "", href, pageUrl, responseUrl: response.url, status: "fetch-failed", statusCode: response.status };\n  const responseUrl = new URL(response.url);\n  if (!isLoopbackHttpUrl(responseUrl) || responseUrl.origin !== page.origin) return { download: anchor.getAttribute("download") || "", href, pageUrl, responseUrl: response.url, status: "not-loopback-response" };\n  const buffer = await response.arrayBuffer();\n  if (buffer.byteLength > maxBytes) return { download: anchor.getAttribute("download") || "", href, pageUrl, responseUrl: response.url, sizeBytes: buffer.byteLength, status: "too-large" };\n  const bytes = new Uint8Array(buffer);\n  let binary = "";\n  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));\n  return { bodyBase64: btoa(binary), contentType: response.headers.get("content-type") || "", download: anchor.getAttribute("download") || "", href, pageUrl, responseUrl: response.url, sizeBytes: buffer.byteLength, status: "fetched-anchor" };\n})()`;
}

function isLoopbackHttpUrl(url: URL): boolean {
	return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]");
}

async function tryDirectAnchorDownload(options: {
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	redactedArgs: string[];
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = getDirectDownloadRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	try {
		const probeData = await runSessionCommandData({
			args: ["eval", "--stdin"],
			cwd: options.cwd,
			sessionName: options.sessionName,
			signal: options.signal,
			stdin: buildAnchorDownloadProbe(request.selector),
		});
		const probe = isRecord(probeData) && isRecord(probeData.result) ? probeData.result : probeData;
		if (!isRecord(probe) || probe.status !== "fetched-anchor" || typeof probe.href !== "string" || typeof probe.pageUrl !== "string" || typeof probe.bodyBase64 !== "string") return undefined;
		const href = new URL(probe.href);
		const pageUrl = new URL(probe.pageUrl);
		const responseUrl = typeof probe.responseUrl === "string" ? new URL(probe.responseUrl) : href;
		if (!isLoopbackHttpUrl(pageUrl) || !isLoopbackHttpUrl(href) || !isLoopbackHttpUrl(responseUrl) || href.origin !== pageUrl.origin || responseUrl.origin !== pageUrl.origin) return undefined;
		const body = Buffer.from(probe.bodyBase64, "base64");
		if (body.byteLength > DIRECT_ANCHOR_DOWNLOAD_MAX_BYTES) return undefined;
		if (typeof probe.sizeBytes === "number" && probe.sizeBytes !== body.byteLength) return undefined;
		const absolutePath = resolve(options.cwd, request.path);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, body);
		const fileStat = await stat(absolutePath);
		const mediaType = typeof probe.contentType === "string" && probe.contentType.length > 0 ? probe.contentType : undefined;
		const artifact = {
			absolutePath,
			artifactType: "download" as const,
			command: "download",
			cwd: options.cwd,
			exists: true,
			kind: "download" as const,
			mediaType,
			path: absolutePath,
			requestedPath: request.path,
			session: options.sessionName,
			sizeBytes: fileStat.size,
			status: "saved" as const,
		};
		const artifactVerification = {
			artifacts: [{
				absolutePath,
				exists: true,
				kind: "download" as const,
				mediaType,
				path: absolutePath,
				requestedPath: request.path,
				sizeBytes: fileStat.size,
				state: "verified" as const,
				status: "saved" as const,
			}],
			missingCount: 0,
			pendingCount: 0,
			unverifiedCount: 0,
			verified: true,
			verifiedCount: 1,
		};
		const savedFile = { command: "download" as const, kind: "download" as const, metadata: { download: probe.download, href: redactSensitiveText(href.href), method: "direct-anchor-fetch" }, path: absolutePath };
		return {
			content: [{
				type: "text",
				text: [
					`Download completed: ${absolutePath}`,
					`Requested path: ${request.path}`,
					`Source: ${redactSensitiveText(href.href)}`,
					`Size: ${fileStat.size} bytes`,
					"Method: direct anchor fetch before upstream download fallback.",
				].join("\n"),
			}],
			details: {
				args: options.redactedArgs,
				artifacts: [artifact],
				artifactVerification,
				command: "download",
				compatibilityWorkaround: options.compatibilityWorkaround,
				downloadRecovery: { href: redactSensitiveText(href.href), method: "direct-anchor-fetch", selector: request.selector },
				effectiveArgs: options.effectiveArgs,
				savedFile,
				savedFilePath: absolutePath,
				sessionMode: options.sessionMode,
				...buildAgentBrowserResultCategoryDetails({ artifacts: [artifact], args: options.effectiveArgs, command: "download", savedFile, succeeded: true }),
				...buildSessionDetailFields(options.sessionName, options.usedImplicitSession),
				summary: `Download completed: ${absolutePath}`,
			},
			isError: false,
		};
	} catch {
		return undefined;
	}
}

async function normalizeScreenshotPathInTokens(commandTokens: string[], cwd: string): Promise<{
	request?: ScreenshotPathRequest;
	tokens: string[];
}> {
	const screenshotPathTokenIndex = getScreenshotPathTokenIndex(commandTokens);
	if (screenshotPathTokenIndex === undefined) {
		return { tokens: commandTokens };
	}

	const requestedPath = commandTokens[screenshotPathTokenIndex];
	const absolutePath = resolve(cwd, requestedPath);
	await mkdir(dirname(absolutePath), { recursive: true });

	const tokens = [...commandTokens];
	tokens[screenshotPathTokenIndex] = absolutePath;
	const terminatorIndex = tokens.indexOf("--");
	if (terminatorIndex >= 0) {
		tokens.splice(terminatorIndex, 1);
	}

	return {
		request: {
			absolutePath,
			path: requestedPath,
		},
		tokens,
	};
}

async function prepareBatchScreenshotPaths(args: string[], stdin: string | undefined, cwd: string): Promise<PreparedAgentBrowserArgs | undefined> {
	const commandTokens = extractCommandTokens(args);
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return undefined;
	}
	const parsed = parseBatchStdinJsonArray(stdin);
	if (parsed.error || parsed.steps === undefined) {
		return undefined;
	}

	let changed = false;
	const batchScreenshotPathRequests: Array<ScreenshotPathRequest | undefined> = [];
	const preparedSteps = await Promise.all(parsed.steps.map(async (step, index) => {
		if (!Array.isArray(step) || !step.every((item) => typeof item === "string")) {
			return step;
		}
		await ensureArtifactParentDirectory(step, cwd);
		if (step[0] !== "screenshot") {
			return step;
		}
		const normalized = await normalizeScreenshotPathInTokens(step, cwd);
		batchScreenshotPathRequests[index] = normalized.request;
		if (normalized.request) {
			changed = true;
		}
		return normalized.tokens;
	}));

	return changed
		? {
				args,
				batchScreenshotPathRequests,
				stdin: JSON.stringify(preparedSteps),
		  }
		: undefined;
}

export async function prepareAgentBrowserArgs(args: string[], stdin: string | undefined, cwd: string): Promise<PreparedAgentBrowserArgs> {
	const preparedBatch = await prepareBatchScreenshotPaths(args, stdin, cwd);
	if (preparedBatch) {
		return preparedBatch;
	}

	const commandTokens = extractCommandTokens(args);
	await ensureArtifactParentDirectory(commandTokens, cwd);
	const normalized = await normalizeScreenshotPathInTokens(commandTokens, cwd);
	if (!normalized.request) {
		return { args };
	}

	const commandStartIndex = args.length - commandTokens.length;
	return {
		args: [...args.slice(0, commandStartIndex), ...normalized.tokens],
		screenshotPathRequest: normalized.request,
	};
}

async function repairScreenshotData(options: {
	cwd: string;
	data: Record<string, unknown>;
	request: ScreenshotPathRequest;
}): Promise<{ data: Record<string, unknown>; request: ScreenshotArtifactRequest }> {
	const { cwd, data, request } = options;
	const reportedPath = typeof data.path === "string" ? data.path : undefined;
	const reportedAbsolutePath = reportedPath ? resolve(cwd, reportedPath) : undefined;
	let status: ScreenshotArtifactRequest["status"] = await pathExists(request.absolutePath) ? "saved" : "missing";
	let tempPath: string | undefined;

	if (reportedAbsolutePath && reportedAbsolutePath !== request.absolutePath) {
		tempPath = reportedAbsolutePath;
		if (status === "missing" && await pathExists(reportedAbsolutePath)) {
			await mkdir(dirname(request.absolutePath), { recursive: true });
			await copyFile(reportedAbsolutePath, request.absolutePath);
			status = "repaired-from-temp";
		}
	}

	return {
		data: {
			...data,
			path: request.absolutePath,
		},
		request: {
			...request,
			status,
			tempPath,
		},
	};
}

export { repairScreenshotData };

function parseMillisecondsToken(token: string | undefined): number | undefined {
	if (token === undefined || !/^\d+$/.test(token)) {
		return undefined;
	}
	const parsed = Number(token);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function findWaitTimeoutMs(commandTokens: string[]): { timeoutMs: number; source: string } | undefined {
	if (commandTokens[0] !== "wait") {
		return undefined;
	}
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--timeout") {
			const timeoutMs = parseMillisecondsToken(commandTokens[index + 1]);
			return timeoutMs === undefined ? undefined : { source: "wait --timeout", timeoutMs };
		}
		if (token.startsWith("--timeout=")) {
			const timeoutMs = parseMillisecondsToken(token.slice("--timeout=".length));
			return timeoutMs === undefined ? undefined : { source: "wait --timeout", timeoutMs };
		}
	}
	const firstWaitArgument = commandTokens[1];
	if (firstWaitArgument && !firstWaitArgument.startsWith("-")) {
		const timeoutMs = parseMillisecondsToken(firstWaitArgument);
		if (timeoutMs !== undefined) {
			return { source: "wait", timeoutMs };
		}
	}
	return undefined;
}

const WAIT_PROCESS_TIMEOUT_GRACE_MS = 5_000;

function findWaitTimeoutBudgetMs(commandTokens: string[], stdin: string | undefined): number | undefined {
	const directWaitTimeout = findWaitTimeoutMs(commandTokens);
	if (directWaitTimeout) {
		return directWaitTimeout.timeoutMs;
	}
	if (commandTokens[0] !== "batch" || stdin === undefined) {
		return undefined;
	}
	let batchWaitTimeoutTotal = 0;
	for (const { step } of parseValidBatchStepEntries(stdin)) {
		const waitTimeout = findWaitTimeoutMs(step);
		if (waitTimeout) {
			batchWaitTimeoutTotal += waitTimeout.timeoutMs;
		}
	}
	return batchWaitTimeoutTotal === 0 ? undefined : batchWaitTimeoutTotal;
}

function getWaitAwareProcessTimeoutMs(commandTokens: string[], stdin: string | undefined): number | undefined {
	const waitTimeoutBudgetMs = findWaitTimeoutBudgetMs(commandTokens, stdin);
	if (waitTimeoutBudgetMs === undefined) return undefined;
	const neededTimeoutMs = waitTimeoutBudgetMs + WAIT_PROCESS_TIMEOUT_GRACE_MS;
	const defaultProcessTimeoutMs = getAgentBrowserProcessTimeoutMs();
	return neededTimeoutMs > defaultProcessTimeoutMs ? neededTimeoutMs : undefined;
}

const DIALOG_COMMAND_PROCESS_TIMEOUT_MS = 5_000;
const DIALOG_COMMAND_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_DIALOG_PROCESS_TIMEOUT_MS";
const LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS = 8_000;
const LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS";
const DIALOG_TRIGGER_TEXT_PATTERN = /\b(?:alert|confirm|dialog|prompt)\b/i;

function getPositiveIntegerEnv(name: string): number | undefined {
	const value = process.env[name];
	if (!value || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getRefIdsFromDirectCommand(commandTokens: string[]): string[] {
	return [...new Set(getGuardedRefUsage(commandTokens))];
}

function commandTextLooksLikeDialogTrigger(commandTokens: string[], refSnapshot?: SessionRefSnapshot): boolean {
	if (commandTokens.some((token) => DIALOG_TRIGGER_TEXT_PATTERN.test(token))) return true;
	for (const refId of getRefIdsFromDirectCommand(commandTokens)) {
		const ref = refSnapshot?.refs?.[refId];
		if (ref && DIALOG_TRIGGER_TEXT_PATTERN.test(`${ref.role} ${ref.name}`)) return true;
	}
	return false;
}

function getDialogAwareProcessTimeoutMs(commandTokens: string[], refSnapshot?: SessionRefSnapshot, stdin?: string): number | undefined {
	const command = commandTokens[0];
	if (command === "dialog") return getPositiveIntegerEnv(DIALOG_COMMAND_PROCESS_TIMEOUT_ENV) ?? DIALOG_COMMAND_PROCESS_TIMEOUT_MS;
	if (command === "eval" && typeof stdin === "string" && DIALOG_TRIGGER_TEXT_PATTERN.test(stdin)) return getPositiveIntegerEnv(LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_ENV) ?? LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS;
	if ((command === "click" || command === "tap" || (command === "find" && commandTokens.includes("click"))) && commandTextLooksLikeDialogTrigger(commandTokens, refSnapshot)) return getPositiveIntegerEnv(LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_ENV) ?? LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS;
	return undefined;
}

function describeRef(refSnapshot: SessionRefSnapshot | undefined, refId: string): string {
	const ref = refSnapshot?.refs?.[refId];
	return ref ? `${ref.role} ${JSON.stringify(ref.name)}` : "not present";
}

function getSamePageFreshnessPreflightFailure(options: {
	commandTokens: string[];
	currentSnapshot: SessionRefSnapshot;
	previousSnapshot: SessionRefSnapshot;
}): { message: string; refIds: string[] } | undefined {
	if (options.commandTokens[0] === "batch") return undefined;
	const refIds = getRefIdsFromDirectCommand(options.commandTokens);
	if (refIds.length === 0) return undefined;
	const previousUrl = options.previousSnapshot.target?.url;
	const currentUrl = options.currentSnapshot.target?.url;
	if (!previousUrl || !currentUrl || previousUrl !== currentUrl || currentUrl === "about:blank") return undefined;
	const mismatchedRefs = refIds.filter((refId) => {
		const previous = options.previousSnapshot.refs?.[refId];
		const current = options.currentSnapshot.refs?.[refId];
		if (!options.currentSnapshot.refIds.includes(refId)) return true;
		if (!previous || !current) return previous !== current;
		return previous.role !== current.role || previous.name !== current.name;
	});
	if (mismatchedRefs.length === 0) return undefined;
	const refText = mismatchedRefs.map((refId) => `@${refId}`).join(", ");
	const evidence = mismatchedRefs.map((refId) => `@${refId}: previous ${describeRef(options.previousSnapshot, refId)}, current ${describeRef(options.currentSnapshot, refId)}`).join("; ");
	return {
		message: `Ref ${refText} no longer matches the latest same-page snapshot. The page likely rerendered after the previous snapshot; run snapshot -i and retry with current refs. Evidence: ${evidence}.`,
		refIds: mismatchedRefs,
	};
}

async function collectSamePageRefFreshnessPreflight(options: {
	commandTokens: string[];
	cwd: string;
	currentTarget?: SessionTabTarget;
	previousSnapshot?: SessionRefSnapshot;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<StaleRefPreflight | undefined> {
	if (!options.previousSnapshot || !options.sessionName || options.commandTokens[0] === "batch" || getRefIdsFromDirectCommand(options.commandTokens).length === 0) return undefined;
	const previousUrl = options.previousSnapshot.target?.url;
	const currentTargetUrl = options.currentTarget?.url;
	if (currentTargetUrl === "about:blank" || (previousUrl && currentTargetUrl && previousUrl !== currentTargetUrl)) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	const currentSnapshot = extractRefSnapshotFromData(snapshotData);
	if (!currentSnapshot) return undefined;
	const snapshotWithTarget = { ...currentSnapshot, target: currentSnapshot.target ?? options.currentTarget };
	const mismatch = getSamePageFreshnessPreflightFailure({ commandTokens: options.commandTokens, currentSnapshot: snapshotWithTarget, previousSnapshot: options.previousSnapshot });
	if (!mismatch) return undefined;
	return { message: mismatch.message, refIds: mismatch.refIds, snapshot: snapshotWithTarget };
}

const SCROLL_CONTAINER_DIRECTIONS = new Set(["down", "left", "right", "up"]);

function getContainerScrollRequest(commandTokens: string[]): { amount?: string; direction: string; selector: string } | undefined {
	if (commandTokens[0] !== "scroll" || commandTokens.length < 3) return undefined;
	const selector = commandTokens[1];
	const direction = commandTokens[2]?.toLowerCase();
	if (!selector || selector.startsWith("-") || selector.startsWith("@") || SCROLL_CONTAINER_DIRECTIONS.has(selector.toLowerCase())) return undefined;
	if (!SCROLL_CONTAINER_DIRECTIONS.has(direction)) return undefined;
	return { amount: commandTokens[3], direction, selector };
}

function buildContainerScrollScript(request: { amount?: string; direction: string; selector: string }): string {
	return `(() => {
  const selector = ${JSON.stringify(request.selector)};
  const direction = ${JSON.stringify(request.direction)};
  const amountToken = ${JSON.stringify(request.amount ?? "")};
  let element;
  try { element = document.querySelector(selector); } catch (error) { return { status: "invalid-selector", selector, error: String(error && error.message || error) }; }
  if (!(element instanceof HTMLElement)) return { status: "not-found", selector };
  const axis = direction === "left" || direction === "right" ? "x" : "y";
  const before = { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, clientWidth: element.clientWidth };
  const parseAmount = () => {
    const token = String(amountToken || "").trim().toLowerCase();
    const extent = axis === "x" ? element.clientWidth : element.clientHeight;
    if (!token) return Math.max(1, Math.floor(extent * 0.8));
    if (token.endsWith("%")) {
      const value = Number(token.slice(0, -1));
      return Number.isFinite(value) ? Math.max(1, Math.floor(extent * value / 100)) : Math.max(1, Math.floor(extent * 0.8));
    }
    const pixels = Number(token.replace(/px$/, ""));
    return Number.isFinite(pixels) && pixels > 0 ? Math.floor(pixels) : Math.max(1, Math.floor(extent * 0.8));
  };
  const delta = parseAmount() * (direction === "up" || direction === "left" ? -1 : 1);
  if (axis === "x") element.scrollLeft += delta;
  else element.scrollTop += delta;
  const after = { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, clientWidth: element.clientWidth };
  const moved = before.scrollLeft !== after.scrollLeft || before.scrollTop !== after.scrollTop;
  return { status: moved ? "scrolled" : "no-movement", selector, direction, amount: amountToken || undefined, before, after };
})()`;
}

function buildScrollResult(options: {
	command: "scroll";
	compatibilityWorkaround?: CompatibilityWorkaround;
	effectiveArgs: string[];
	message: string;
	redactedArgs: string[];
	result: Record<string, unknown>;
	scrollField: "scrollContainer" | "scrollPage";
	scrollValue: unknown;
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	succeeded: boolean;
	usedImplicitSession: boolean;
}): AgentBrowserToolResult {
	return {
		content: [{ type: "text", text: options.message }],
		details: {
			args: options.redactedArgs,
			command: options.command,
			compatibilityWorkaround: options.compatibilityWorkaround,
			data: options.result,
			effectiveArgs: options.effectiveArgs,
			nextActions: options.succeeded ? undefined : buildScrollNoopNextActions(options.sessionName),
			[options.scrollField]: options.scrollValue,
			sessionMode: options.sessionMode,
			...buildAgentBrowserResultCategoryDetails({ args: options.effectiveArgs, command: options.command, errorText: options.succeeded ? undefined : options.message, succeeded: options.succeeded, validationError: options.succeeded ? undefined : options.message }),
			...buildSessionDetailFields(options.sessionName, options.usedImplicitSession),
			summary: options.message,
			validationError: options.succeeded ? undefined : options.message,
		},
		isError: !options.succeeded,
	};
}

async function tryContainerScroll(options: {
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	redactedArgs: string[];
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = getContainerScrollRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	const data = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: buildContainerScrollScript(request) });
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	if (!isRecord(result) || typeof result.status !== "string") return undefined;
	const succeeded = result.status === "scrolled";
	const message = succeeded
		? `Scrolled container ${request.selector} ${request.direction}${request.amount ? ` by ${request.amount}` : ""}.`
		: `Scroll container ${request.selector} did not move (${result.status}).`;
	return buildScrollResult({ ...options, command: "scroll", message, result, scrollField: "scrollContainer", scrollValue: { request, result }, succeeded });
}

function getPageScrollToRequest(commandTokens: string[]): { target: "end" | "top" } | undefined {
	if (commandTokens[0] !== "scroll" || commandTokens[1]?.toLowerCase() !== "to") return undefined;
	const target = commandTokens[2]?.toLowerCase();
	return target === "end" || target === "top" ? { target } : undefined;
}

function buildPageScrollToScript(request: { target: "end" | "top" }): string {
	return `(() => {
  const target = ${JSON.stringify(request.target)};
  const scroller = document.scrollingElement || document.documentElement || document.body;
  if (!scroller) return { status: "no-scroller", target };
  const before = { scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, scrollWidth: scroller.scrollWidth, clientHeight: scroller.clientHeight, clientWidth: scroller.clientWidth };
  const nextTop = target === "top" ? 0 : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const nextLeft = scroller.scrollLeft;
  scroller.scrollTop = nextTop;
  window.scrollTo(nextLeft, nextTop);
  const after = { scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, scrollWidth: scroller.scrollWidth, clientHeight: scroller.clientHeight, clientWidth: scroller.clientWidth };
  const moved = before.scrollLeft !== after.scrollLeft || before.scrollTop !== after.scrollTop;
  return { status: moved ? "scrolled" : "no-movement", target, before, after };
})()`;
}

async function tryPageScrollTo(options: {
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	redactedArgs: string[];
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = getPageScrollToRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	const data = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: buildPageScrollToScript(request) });
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	if (!isRecord(result) || typeof result.status !== "string") return undefined;
	const succeeded = result.status === "scrolled";
	const message = succeeded ? `Scrolled page to ${request.target}.` : `Scroll to ${request.target} completed with no observed movement (${result.status}).`;
	return buildScrollResult({ ...options, command: "scroll", message, result, scrollField: "scrollPage", scrollValue: { request, result }, succeeded });
}

interface SnapshotFilterRequest {
	cleanArgs: string[];
	diff?: boolean;
	role?: string;
	search?: string;
	viewport?: boolean;
}

function parseSnapshotFilterRequest(commandTokens: string[]): SnapshotFilterRequest | undefined {
	if (commandTokens[0] !== "snapshot") return undefined;
	const cleanArgs: string[] = [];
	let role: string | undefined;
	let search: string | undefined;
	for (let index = 0; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--viewport") continue;
		if (token === "--diff") continue;
		if (token === "--search") {
			const value = commandTokens[index + 1];
			if (typeof value === "string" && !value.startsWith("-")) {
				search = value;
				index += 1;
				continue;
			}
		}
		if (token === "--filter") {
			const value = commandTokens[index + 1];
			if (typeof value === "string" && !value.startsWith("-")) {
				const roleMatch = /^role=(.+)$/i.exec(value.trim());
				if (roleMatch?.[1]) role = roleMatch[1].trim().toLowerCase();
				index += 1;
				continue;
			}
		}
		cleanArgs.push(token);
	}
	const viewport = commandTokens.includes("--viewport");
	const diff = commandTokens.includes("--diff");
	if (!search && !role && !viewport && !diff) return undefined;
	return { cleanArgs, diff, role, search, viewport };
}

interface SnapshotDiffSummary {
	addedRefs: string[];
	changedRefs: string[];
	removedRefs: string[];
	summary: string;
	unchangedRefs: number;
}

function buildSnapshotDiff(previous: SessionRefSnapshot | undefined, current: SessionRefSnapshot | undefined): SnapshotDiffSummary | undefined {
	if (!current) return undefined;
	const currentRefs = current.refs ?? {};
	const previousRefs = previous?.refs ?? {};
	if (!previous) return { addedRefs: Object.keys(currentRefs), changedRefs: [], removedRefs: [], summary: `Snapshot diff: no previous snapshot; ${Object.keys(currentRefs).length} current refs recorded.`, unchangedRefs: 0 };
	const addedRefs: string[] = [];
	const removedRefs: string[] = [];
	const changedRefs: string[] = [];
	let unchangedRefs = 0;
	for (const refId of Object.keys(currentRefs)) {
		const currentRef = currentRefs[refId];
		const previousRef = previousRefs[refId];
		if (!previousRef) {
			addedRefs.push(refId);
			continue;
		}
		if (previousRef.role !== currentRef.role || previousRef.name !== currentRef.name) changedRefs.push(refId);
		else unchangedRefs += 1;
	}
	for (const refId of Object.keys(previousRefs)) if (!currentRefs[refId]) removedRefs.push(refId);
	return { addedRefs, changedRefs, removedRefs, summary: `Snapshot diff: +${addedRefs.length} / -${removedRefs.length} / Δ${changedRefs.length} refs versus previous snapshot.`, unchangedRefs };
}

function filterSnapshotData(data: unknown, request: SnapshotFilterRequest): { data: Record<string, unknown>; matchedRefs: number; totalRefs: number; totalLines: number; visibleLines: number } | undefined {
	if (!isRecord(data)) return undefined;
	const refs = isRecord(data.refs) ? data.refs : {};
	const snapshot = typeof data.snapshot === "string" ? data.snapshot : "";
	const normalizedSearch = request.search?.trim().toLowerCase();
	const matchingRefIds = new Set<string>();
	for (const [refId, refValue] of Object.entries(refs)) {
		if (!isRecord(refValue)) continue;
		const role = typeof refValue.role === "string" ? refValue.role.toLowerCase() : "";
		const name = typeof refValue.name === "string" ? refValue.name : "";
		const roleMatches = request.role ? role === request.role : true;
		const searchMatches = normalizedSearch ? `${role} ${name}`.toLowerCase().includes(normalizedSearch) : true;
		if (roleMatches && searchMatches) matchingRefIds.add(refId);
	}
	const lines = snapshot.split(/\r?\n/);
	const visibleLines = lines.filter((line) => {
		const normalizedLine = line.toLowerCase();
		if (normalizedSearch && normalizedLine.includes(normalizedSearch)) return true;
		return [...matchingRefIds].some((refId) => line.includes(`[ref=${refId}]`) || line.includes(`ref=${refId}`));
	});
	const filteredRefs = Object.fromEntries(Object.entries(refs).filter(([refId]) => matchingRefIds.has(refId)));
	const description = [request.role ? `role=${request.role}` : undefined, request.search ? `search=${JSON.stringify(request.search)}` : undefined].filter((part): part is string => part !== undefined).join(", ");
	const filteredSnapshot = visibleLines.length > 0 ? visibleLines.join("\n") : `(no snapshot lines matched ${description})`;
	return {
		data: { ...data, refs: filteredRefs, snapshot: filteredSnapshot },
		matchedRefs: Object.keys(filteredRefs).length,
		totalRefs: Object.keys(refs).length,
		totalLines: lines.filter((line) => line.length > 0).length,
		visibleLines: visibleLines.length,
	};
}

async function trySnapshotFilter(options: {
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	redactedArgs: string[];
	previousRefSnapshot?: SessionRefSnapshot;
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	sessionPageState: BrowserRunOptions["state"]["sessionPageState"];
	sessionPageStateUpdate: ReturnType<BrowserRunOptions["state"]["sessionPageState"]["beginUpdate"]>;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = parseSnapshotFilterRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	const snapshotData = await runSessionCommandData({ args: request.cleanArgs, cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	const filtered = request.role || request.search ? filterSnapshotData(snapshotData, request) : isRecord(snapshotData) ? { data: snapshotData, matchedRefs: isRecord(snapshotData.refs) ? Object.keys(snapshotData.refs).length : 0, totalLines: typeof snapshotData.snapshot === "string" ? snapshotData.snapshot.split(/\r?\n/).filter((line) => line.length > 0).length : 0, totalRefs: isRecord(snapshotData.refs) ? Object.keys(snapshotData.refs).length : 0, visibleLines: typeof snapshotData.snapshot === "string" ? snapshotData.snapshot.split(/\r?\n/).filter((line) => line.length > 0).length : 0 } : undefined;
	if (!filtered) return undefined;
	const viewport = request.viewport ? await collectScrollPositionSnapshot({ cwd: options.cwd, sessionName: options.sessionName, signal: options.signal }) : undefined;
	const fullSnapshot = extractRefSnapshotFromData(snapshotData);
	const diff = request.diff ? buildSnapshotDiff(options.previousRefSnapshot, fullSnapshot) : undefined;
	if (fullSnapshot) options.sessionPageState.applyRefSnapshot({ sessionName: options.sessionName, snapshot: fullSnapshot, update: options.sessionPageStateUpdate });
	const presentation = await buildSnapshotPresentation(filtered.data);
	const summary = request.role || request.search
		? `Snapshot filter: ${filtered.matchedRefs}/${filtered.totalRefs} direct refs matched${request.role ? ` role=${request.role}` : ""}${request.search ? ` search ${JSON.stringify(request.search)}` : ""}; ${filtered.visibleLines} surrounding snapshot line${filtered.visibleLines === 1 ? "" : "s"} shown.`
		: request.diff
			? diff?.summary ?? "Snapshot diff unavailable."
			: "Snapshot viewport metadata collected.";
	const viewportText = viewport ? `Viewport: ${viewport.innerWidth}×${viewport.innerHeight}, scroll ${viewport.scrollX},${viewport.scrollY}, document ${viewport.scrollWidth}×${viewport.scrollHeight}, sampled scroll containers ${viewport.containers.length}/${viewport.containerCount}.` : undefined;
	const diffText = diff && (request.role || request.search) ? diff.summary : undefined;
	const prefix = [summary, diffText, viewportText].filter((line): line is string => line !== undefined).join("\n");
	if (presentation.content[0]?.type === "text") presentation.content[0] = { ...presentation.content[0], text: `${prefix}\n\n${presentation.content[0].text}` };
	return {
		content: presentation.content,
		details: {
			args: options.redactedArgs,
			command: "snapshot",
			compatibilityWorkaround: options.compatibilityWorkaround,
			data: presentation.data,
			effectiveArgs: options.effectiveArgs,
			refSnapshot: fullSnapshot,
			sessionMode: options.sessionMode,
			snapshotDiff: diff,
			snapshotFilter: request.role || request.search ? { cleanArgs: request.cleanArgs, matchedRefs: filtered.matchedRefs, role: request.role, search: request.search, totalLines: filtered.totalLines, totalRefs: filtered.totalRefs, visibleLines: filtered.visibleLines } : undefined,
			snapshotViewport: viewport,
			...buildAgentBrowserResultCategoryDetails({ args: options.effectiveArgs, command: "snapshot", succeeded: true }),
			...buildSessionDetailFields(options.sessionName, options.usedImplicitSession),
			summary,
		},
		isError: false,
	};
}

interface NetworkRequestsPageFilterRequest {
	cleanArgs: string[];
	mode: "origin" | "url";
}

function parseNetworkRequestsPageFilterRequest(commandTokens: string[]): NetworkRequestsPageFilterRequest | undefined {
	if (commandTokens[0] !== "network" || commandTokens[1] !== "requests") return undefined;
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
	if (!mode) return undefined;
	return { cleanArgs, mode };
}

function extractCurrentUrl(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (!isRecord(data)) return undefined;
	const candidates = [data.url, data.currentUrl, data.href, data.result];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.length > 0) return candidate;
	return undefined;
}

function getRequestUrl(row: unknown): string | undefined {
	if (!isRecord(row)) return undefined;
	const candidate = row.url ?? row.requestUrl ?? row.href;
	return typeof candidate === "string" ? candidate : undefined;
}

function requestMatchesCurrentPage(row: unknown, currentUrl: string, mode: NetworkRequestsPageFilterRequest["mode"]): boolean {
	const requestUrl = getRequestUrl(row);
	if (!requestUrl) return false;
	try {
		const current = new URL(currentUrl);
		const request = new URL(requestUrl, current);
		if (mode === "origin") return current.origin === request.origin;
		const currentComparable = `${current.origin}${current.pathname}`;
		const requestComparable = `${request.origin}${request.pathname}`;
		return requestComparable === currentComparable;
	} catch {
		return mode === "url" ? requestUrl === currentUrl : requestUrl.startsWith(currentUrl);
	}
}

function filterNetworkRequestsData(data: unknown, currentUrl: string, request: NetworkRequestsPageFilterRequest): { data: Record<string, unknown>; matchedRows: number; totalRows: number; rows: unknown[] } | undefined {
	if (!isRecord(data)) return undefined;
	const requestRows = Array.isArray(data.requests) ? data.requests : Array.isArray(data.items) ? data.items : Array.isArray(data.entries) ? data.entries : undefined;
	if (!requestRows) return undefined;
	const rows = requestRows.filter((row) => requestMatchesCurrentPage(row, currentUrl, request.mode));
	const key = Array.isArray(data.requests) ? "requests" : Array.isArray(data.items) ? "items" : "entries";
	return { data: { ...data, [key]: rows }, matchedRows: rows.length, rows, totalRows: requestRows.length };
}

function formatNetworkRequestRow(row: unknown): string {
	if (!isRecord(row)) return redactSensitiveText(String(row));
	const status = row.status ?? row.statusCode ?? row.responseStatus ?? "?";
	const method = typeof row.method === "string" ? row.method : typeof row.requestMethod === "string" ? row.requestMethod : "?";
	const id = typeof row.id === "string" ? ` id=${row.id}` : typeof row.requestId === "string" ? ` id=${row.requestId}` : "";
	const url = getRequestUrl(row) ?? "(no url)";
	return redactSensitiveText(`- ${status} ${method}${id} ${url}`);
}

async function tryNetworkRequestsPageFilter(options: {
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	redactedArgs: string[];
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = parseNetworkRequestsPageFilterRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	const currentUrl = extractCurrentUrl(await runSessionCommandData({ args: ["get", "url"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal }));
	if (!currentUrl) return undefined;
	const networkData = await runSessionCommandData({ args: request.cleanArgs, cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	const filtered = filterNetworkRequestsData(networkData, currentUrl, request);
	if (!filtered) return undefined;
	const summary = `Network requests filtered to current ${request.mode === "origin" ? "origin" : "URL"}: ${filtered.matchedRows}/${filtered.totalRows} rows matched.`;
	const preview = filtered.rows.slice(0, 12).map(formatNetworkRequestRow);
	const omitted = filtered.rows.length > preview.length ? [`- …${filtered.rows.length - preview.length} more matching rows omitted`] : [];
	return {
		content: [{ type: "text", text: [redactSensitiveText(summary), `Current page: ${redactSensitiveText(currentUrl)}`, ...preview, ...omitted].join("\n") }],
		details: {
			args: options.redactedArgs,
			command: "network",
			compatibilityWorkaround: options.compatibilityWorkaround,
			data: filtered.data,
			effectiveArgs: options.effectiveArgs,
			networkRequestsPageFilter: { cleanArgs: request.cleanArgs, currentUrl: redactSensitiveText(currentUrl), matchedRows: filtered.matchedRows, mode: request.mode, totalRows: filtered.totalRows },
			sessionMode: options.sessionMode,
			...buildAgentBrowserResultCategoryDetails({ args: options.effectiveArgs, command: "network", succeeded: true }),
			...buildSessionDetailFields(options.sessionName, options.usedImplicitSession),
			summary,
		},
		isError: false,
	};
}

function isPasswordStdinAuthSave(options: { command?: string; commandTokens: string[] }): boolean {
	return options.command === "auth" && options.commandTokens[1] === "save" && options.commandTokens.includes("--password-stdin");
}

export function getExactSensitiveStdinValues(options: { command?: string; commandTokens: string[]; stdin?: string }): string[] {
	if (options.stdin === undefined || !isPasswordStdinAuthSave(options)) {
		return [];
	}
	return [...new Set([options.stdin, options.stdin.trimEnd(), options.stdin.trim()].filter((value) => value.length > 0))];
}

export function validateStdinCommandContract(options: { command?: string; commandTokens: string[]; stdin?: string }): string | undefined {
	if (options.stdin === undefined) {
		return undefined;
	}
	if (options.command === "batch") {
		return undefined;
	}
	if (options.command === "eval" && options.commandTokens.includes("--stdin")) {
		return undefined;
	}
	if (isPasswordStdinAuthSave(options)) {
		return undefined;
	}
	const commandLabel = options.command ? `\`${options.command}\`` : "the requested command";
	return `agent_browser stdin is only supported for \`batch\`, \`eval --stdin\`, and \`auth save --password-stdin\`; remove stdin from ${commandLabel} or use one of those command forms.`;
}

export async function resolveSemanticActionVisibleRefArgs(options: {
	compiled: CompiledAgentBrowserSemanticAction | undefined;
	cwd: string;
	sessionName?: string;
	signal?: AbortSignal;
}): Promise<SemanticActionVisibleRefResolution | undefined> {
	if (!options.compiled || !options.sessionName || options.compiled.locator !== "role" || !["check", "click", "fill"].includes(options.compiled.action)) return undefined;
	const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal });
	const resolution = resolveVisibleRefActionFromSnapshot({ allowFill: true, compiledAction: options.compiled, snapshotData });
	if (!resolution) return undefined;
	return { args: [...getCompiledSemanticActionSessionPrefix(options.compiled), ...resolution.args], snapshot: resolution.snapshot };
}

export async function prepareBrowserRun(options: BrowserRunOptions): Promise<PrepareBrowserRunResult> {
	const { cwd, implicitSessionIdleTimeoutMs, onUpdate, params, signal, state } = options;
	const { sessionPageState, traceOwners, managedSessionBaseName, ephemeralSessionSeed } = state;
	let freshSessionOrdinal = state.freshSessionOrdinal;
	const {
		compiledElectron,
		compiledJob,
		compiledNetworkSourceLookup,
		compiledQaPreset,
		compiledSemanticAction,
		compiledSourceLookup,
		redactedArgs,
		redactedCompiledElectron,
		redactedCompiledJob,
		redactedCompiledNetworkSourceLookup,
		redactedCompiledQaPreset,
		redactedCompiledSemanticAction,
		redactedCompiledSourceLookup,
		toolArgs,
		toolStdin,
	} = normalizeRunInput(options.input);
	let runtimeToolArgs = toolArgs;
	let runtimeToolStdin = toolStdin;
	let electronLaunch: ElectronLaunchSuccess | undefined;
	const sessionMode = compiledElectron?.action === "launch" ? "fresh" : params.sessionMode ?? "auto";
	const freshSessionName = createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal + 1);
	if (compiledElectron?.action === "launch") {
		const launchResult = await launchElectronApp(compiledElectron);
		if (!launchResult.ok) {
			const managedSessionOutcome = buildManagedSessionOutcome({
				activeAfter: state.managedSessionActive,
				activeBefore: state.managedSessionActive,
				attemptedSessionName: freshSessionName,
				command: "connect",
				currentSessionName: state.managedSessionName,
				previousSessionName: state.managedSessionName,
				sessionMode: "fresh",
				succeeded: false,
			});
			return { kind: "early-result", result: buildElectronHostFailureResult({
				compiledElectron: redactedCompiledElectron ?? compiledElectron,
				errorText: launchResult.failure.error,
				failureCategory: getElectronLaunchFailureCategory(launchResult.failure),
				launchFailure: launchResult.failure,
				managedSessionOutcome,
				status: launchResult.failure.reason,
			}) };
		}
		electronLaunch = launchResult.value;
		runtimeToolArgs = ["connect", electronLaunch.connectArg];
		runtimeToolStdin = undefined;
	}
	const preparedArgs = await prepareAgentBrowserArgs(runtimeToolArgs, runtimeToolStdin, cwd);
	const userRequestedJson = runtimeToolArgs.includes("--json");
	let executionPlan = buildExecutionPlan(preparedArgs.args, {
		freshSessionName,
		managedSessionActive: state.managedSessionActive,
		managedSessionName: state.managedSessionName,
		sessionMode,
	});
	let semanticActionVisibleRefResolution: SemanticActionVisibleRefResolution | undefined;
	if (!executionPlan.validationError && executionPlan.managedSessionName !== freshSessionName) {
		semanticActionVisibleRefResolution = await resolveSemanticActionVisibleRefArgs({
			compiled: compiledSemanticAction,
			cwd,
			sessionName: executionPlan.sessionName,
			signal,
		});
		if (semanticActionVisibleRefResolution) {
			executionPlan = buildExecutionPlan(semanticActionVisibleRefResolution.args, {
				freshSessionName,
				managedSessionActive: state.managedSessionActive,
				managedSessionName: state.managedSessionName,
				sessionMode,
			});
		}
	}
	const redactedEffectiveArgs = redactInvocationArgs(executionPlan.effectiveArgs);
	const redactedRecoveryHint = redactRecoveryHint(executionPlan.recoveryHint);
	const compatibilityWorkaround: CompatibilityWorkaround | undefined = executionPlan.compatibilityWorkaround;
	const statePatch = executionPlan.managedSessionName === freshSessionName
		? { freshSessionOrdinal: freshSessionOrdinal + 1 }
		: {};
	if (executionPlan.managedSessionName === freshSessionName) {
		freshSessionOrdinal += 1;
	}

	if (executionPlan.validationError) {
		return { kind: "early-result", statePatch, result: {
			content: [{ type: "text", text: executionPlan.validationError }],
			details: {
				args: redactedArgs,
				compiledElectron: redactedCompiledElectron,
				compiledJob: redactedCompiledJob,
				compiledQaPreset: redactedCompiledQaPreset,
				compiledSourceLookup: redactedCompiledSourceLookup,
				compiledNetworkSourceLookup: redactedCompiledNetworkSourceLookup,
				invalidValueFlag: executionPlan.invalidValueFlag,
				sessionMode,
				sessionRecoveryHint: redactedRecoveryHint,
				startupScopedFlags: executionPlan.startupScopedFlags,
				...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, command: executionPlan.commandInfo.command, errorText: executionPlan.validationError, succeeded: false, validationError: executionPlan.validationError }),
				validationError: executionPlan.validationError,
			},
			isError: true,
		} };
	}

	const commandTokens = semanticActionVisibleRefResolution ? extractCommandTokens(semanticActionVisibleRefResolution.args) : extractCommandTokens(preparedArgs.args);
	const exactSensitiveValues = getExactSensitiveStdinValues({
		command: executionPlan.commandInfo.command,
		commandTokens,
		stdin: runtimeToolStdin,
	});
	const traceOwnerGuardMessage = getTraceOwnerGuardMessage({
		command: executionPlan.commandInfo.command,
		sessionName: executionPlan.sessionName,
		subcommand: executionPlan.commandInfo.subcommand,
		traceOwners,
	});
	if (traceOwnerGuardMessage) {
		return { kind: "early-result", statePatch, result: {
			content: [{ type: "text", text: traceOwnerGuardMessage }],
			details: {
				args: redactedArgs,
				command: executionPlan.commandInfo.command,
				compatibilityWorkaround,
				effectiveArgs: redactedEffectiveArgs,
				sessionMode,
				...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: traceOwnerGuardMessage, succeeded: false, validationError: traceOwnerGuardMessage }),
				validationError: traceOwnerGuardMessage,
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
			},
			isError: true,
		} };
	}
	const stdinValidationError = validateStdinCommandContract({
		command: executionPlan.commandInfo.command,
		commandTokens,
		stdin: runtimeToolStdin,
	});
	if (stdinValidationError) {
		return { kind: "early-result", statePatch, result: {
			content: [{ type: "text", text: stdinValidationError }],
			details: {
				args: redactedArgs,
				command: executionPlan.commandInfo.command,
				compatibilityWorkaround,
				effectiveArgs: redactedEffectiveArgs,
				sessionMode,
				...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: stdinValidationError, succeeded: false, validationError: stdinValidationError }),
				validationError: stdinValidationError,
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
			},
			isError: true,
		} };
	}
	const priorSessionPageState = sessionPageState.get(executionPlan.sessionName);
	const priorSessionTabTarget = priorSessionPageState.tabTarget;
	const sessionTabPinningReason = priorSessionPageState.pinningReason;
	const priorRefSnapshotState = priorSessionPageState.refSnapshot;
	const priorRefSnapshotInvalidation = priorSessionPageState.refSnapshotInvalidation;
	const resolvedSemanticActionRefSnapshot: SessionRefSnapshot | undefined = semanticActionVisibleRefResolution?.snapshot
		? { ...semanticActionVisibleRefResolution.snapshot, target: semanticActionVisibleRefResolution.snapshot.target ?? priorSessionTabTarget }
		: undefined;
	const promptRefSnapshot = resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState;
	const requestedArtifactCloseViolation = await findRequestedArtifactCloseViolation({ artifactManifest: state.artifactManifest, command: executionPlan.commandInfo.command, cwd, promptPolicy: options.promptPolicy });
	if (requestedArtifactCloseViolation) {
		return { kind: "early-result", statePatch, result: {
			content: [{ type: "text", text: requestedArtifactCloseViolation.message }],
			details: {
				args: redactedArgs,
				command: executionPlan.commandInfo.command,
				compatibilityWorkaround,
				effectiveArgs: redactedEffectiveArgs,
				promptGuard: requestedArtifactCloseViolation,
				sessionMode,
				...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: requestedArtifactCloseViolation.message, failureCategory: "policy-blocked", succeeded: false, validationError: requestedArtifactCloseViolation.message }),
				validationError: requestedArtifactCloseViolation.message,
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
			},
			isError: true,
		} };
	}
	const staleRefPreflight = buildStaleRefPreflight({
		commandTokens,
		currentTarget: priorSessionTabTarget,
		refSnapshot: resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState,
		refSnapshotInvalidation: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotInvalidation,
		stdin: runtimeToolStdin,
	});
	if (staleRefPreflight) {
		return { kind: "early-result", statePatch, result: {
			content: [{ type: "text", text: staleRefPreflight.message }],
			details: {
				args: redactedArgs,
				command: executionPlan.commandInfo.command,
				compatibilityWorkaround,
				effectiveArgs: redactedEffectiveArgs,
				nextActions: buildSessionAwareStaleRefNextActions(executionPlan.sessionName),
				refIds: staleRefPreflight.refIds,
				refSnapshot: staleRefPreflight.snapshot,
				refSnapshotInvalidation: staleRefPreflight.snapshotInvalidation,
				sessionMode,
				...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: staleRefPreflight.message, failureCategory: "stale-ref", succeeded: false }),
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
			},
			isError: true,
		} };
	}
	const samePageRefFreshnessPreflight = await collectSamePageRefFreshnessPreflight({
		commandTokens,
		cwd,
		currentTarget: priorSessionTabTarget,
		previousSnapshot: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotState,
		sessionName: executionPlan.sessionName,
		signal,
	});
	if (samePageRefFreshnessPreflight) {
		if (samePageRefFreshnessPreflight.snapshot && executionPlan.sessionName) {
			sessionPageState.applyRefSnapshot({ fallbackTarget: priorSessionTabTarget, sessionName: executionPlan.sessionName, snapshot: samePageRefFreshnessPreflight.snapshot, update: options.sessionPageStateUpdate });
		}
		return { kind: "early-result", statePatch, result: {
			content: [{ type: "text", text: samePageRefFreshnessPreflight.message }],
			details: {
				args: redactedArgs,
				command: executionPlan.commandInfo.command,
				compatibilityWorkaround,
				effectiveArgs: redactedEffectiveArgs,
				nextActions: buildSessionAwareStaleRefNextActions(executionPlan.sessionName),
				refIds: samePageRefFreshnessPreflight.refIds,
				refSnapshot: samePageRefFreshnessPreflight.snapshot,
				sessionMode,
				...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: samePageRefFreshnessPreflight.message, failureCategory: "stale-ref", succeeded: false }),
				...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
			},
			isError: true,
		} };
	}

	if (compiledQaPreset?.checks.attached) {
		const qaAttachedPrecondition = await validateQaAttachedPrecondition({
			cwd,
			sessionName: executionPlan.sessionName,
			signal,
		});
		if (qaAttachedPrecondition) {
			return { kind: "early-result", statePatch, result: {
				content: [{ type: "text", text: qaAttachedPrecondition.error }],
				details: {
					args: redactedArgs,
					compiledQaPreset: redactedCompiledQaPreset,
					compatibilityWorkaround,
					effectiveArgs: redactedEffectiveArgs,
					nextActions: qaAttachedPrecondition.nextActions,
					sessionMode,
					...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: qaAttachedPrecondition.error, succeeded: false, validationError: qaAttachedPrecondition.error }),
					validationError: qaAttachedPrecondition.error,
					...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
				},
				isError: true,
			} };
		}
	}

	const snapshotFilter = await trySnapshotFilter({
		commandTokens,
		compatibilityWorkaround,
		cwd,
		effectiveArgs: redactedEffectiveArgs,
		previousRefSnapshot: priorRefSnapshotState,
		redactedArgs,
		sessionMode,
		sessionName: executionPlan.sessionName,
		sessionPageState,
		sessionPageStateUpdate: options.sessionPageStateUpdate,
		signal,
		usedImplicitSession: executionPlan.usedImplicitSession,
	});
	if (snapshotFilter) return { kind: "early-result", statePatch, result: snapshotFilter };

	const networkRequestsPageFilter = await tryNetworkRequestsPageFilter({
		commandTokens,
		compatibilityWorkaround,
		cwd,
		effectiveArgs: redactedEffectiveArgs,
		redactedArgs,
		sessionMode,
		sessionName: executionPlan.sessionName,
		signal,
		usedImplicitSession: executionPlan.usedImplicitSession,
	});
	if (networkRequestsPageFilter) return { kind: "early-result", statePatch, result: networkRequestsPageFilter };

	const containerScroll = await tryContainerScroll({
		commandTokens,
		compatibilityWorkaround,
		cwd,
		effectiveArgs: redactedEffectiveArgs,
		redactedArgs,
		sessionMode,
		sessionName: executionPlan.sessionName,
		signal,
		usedImplicitSession: executionPlan.usedImplicitSession,
	});
	if (containerScroll) return { kind: "early-result", statePatch, result: containerScroll };
	const pageScrollTo = await tryPageScrollTo({
		commandTokens,
		compatibilityWorkaround,
		cwd,
		effectiveArgs: redactedEffectiveArgs,
		redactedArgs,
		sessionMode,
		sessionName: executionPlan.sessionName,
		signal,
		usedImplicitSession: executionPlan.usedImplicitSession,
	});
	if (pageScrollTo) return { kind: "early-result", statePatch, result: pageScrollTo };

	const directAnchorDownload = await tryDirectAnchorDownload({
		commandTokens,
		compatibilityWorkaround,
		cwd,
		effectiveArgs: redactedEffectiveArgs,
		redactedArgs,
		sessionMode,
		sessionName: executionPlan.sessionName,
		signal,
		usedImplicitSession: executionPlan.usedImplicitSession,
	});
	if (directAnchorDownload) return { kind: "early-result", statePatch, result: directAnchorDownload };

	let pinnedBatchUnwrapMode: PreparedBrowserRun["pinnedBatchUnwrapMode"];
	let includePinnedNavigationSummary = false;
	let sessionTabCorrection: PreparedBrowserRun["sessionTabCorrection"];
	let processArgs = executionPlan.effectiveArgs;
	let processStdin = preparedArgs.stdin ?? runtimeToolStdin;
	if (
		priorSessionTabTarget &&
		shouldPinSessionTabForCommand({
			command: executionPlan.commandInfo.command,
			commandTokens,
			pinningRequired: sessionTabPinningReason !== undefined,
			sessionName: executionPlan.sessionName,
			stdin: runtimeToolStdin,
		})
	) {
		const plannedSessionTabSelection = await collectSessionTabSelection({
			cwd,
			sessionName: executionPlan.sessionName,
			signal,
			target: priorSessionTabTarget,
		});
		if (plannedSessionTabSelection && executionPlan.sessionName) {
			if (executionPlan.commandInfo.command === "eval" && runtimeToolStdin !== undefined) {
				const appliedSessionTabSelection = await applyOpenResultTabCorrection({
					correction: plannedSessionTabSelection,
					cwd,
					sessionName: executionPlan.sessionName,
					signal,
				});
				if (!appliedSessionTabSelection) {
					const error = "agent-browser could not re-select the intended tab before running the command.";
					return { kind: "early-result", statePatch, result: {
						content: [{ type: "text", text: error }],
						details: {
							args: redactedArgs,
							command: executionPlan.commandInfo.command,
							compatibilityWorkaround,
							effectiveArgs: redactedEffectiveArgs,
							sessionMode,
							sessionTabCorrection: plannedSessionTabSelection,
							...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: error, failureCategory: "tab-drift", succeeded: false, tabDrift: true, validationError: error }),
							nextActions: buildSessionTabRecoveryNextActions({
								kind: "tab-drift",
								resultCategory: "failure",
								sessionName: executionPlan.sessionName,
								tabCorrection: plannedSessionTabSelection,
								target: priorSessionTabTarget,
							}),
							validationError: error,
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						},
						isError: true,
					} };
				}
				sessionTabCorrection = appliedSessionTabSelection;
			} else {
				const pinnedBatchPlan = buildPinnedBatchPlan({
					command: executionPlan.commandInfo.command,
					commandTokens,
					selectedTab: plannedSessionTabSelection.selectedTab,
					stdin: runtimeToolStdin,
				});
				if (pinnedBatchPlan && "error" in pinnedBatchPlan) {
					return { kind: "early-result", statePatch, result: {
						content: [{ type: "text", text: pinnedBatchPlan.error }],
						details: {
							args: redactedArgs,
							command: executionPlan.commandInfo.command,
							compatibilityWorkaround,
							effectiveArgs: redactedEffectiveArgs,
							sessionMode,
							sessionTabCorrection: plannedSessionTabSelection,
							...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: pinnedBatchPlan.error, failureCategory: "tab-drift", succeeded: false, tabDrift: true, validationError: pinnedBatchPlan.error }),
							nextActions: buildSessionTabRecoveryNextActions({
								kind: "tab-drift",
								resultCategory: "failure",
								sessionName: executionPlan.sessionName,
								tabCorrection: plannedSessionTabSelection,
								target: priorSessionTabTarget,
							}),
							validationError: pinnedBatchPlan.error,
							...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
						},
						isError: true,
					} };
				}
				if (pinnedBatchPlan) {
					sessionTabCorrection = plannedSessionTabSelection;
					processArgs = ["--json", "--session", executionPlan.sessionName, "batch"];
					processStdin = JSON.stringify(pinnedBatchPlan.steps);
					includePinnedNavigationSummary = pinnedBatchPlan.includeNavigationSummary;
					pinnedBatchUnwrapMode = pinnedBatchPlan.unwrapMode;
				}
			}
		}
	}
	const clickDispatchProbe = pinnedBatchUnwrapMode === undefined && compiledElectron === undefined
		? await prepareClickDispatchProbe({ commandTokens, cwd, refSnapshot: promptRefSnapshot, sessionName: executionPlan.sessionName, signal })
		: undefined;
	const processTimeoutMs = options.params.timeoutMs ?? getDialogAwareProcessTimeoutMs(commandTokens, promptRefSnapshot, processStdin) ?? getWaitAwareProcessTimeoutMs(commandTokens, processStdin);
	const redactedProcessArgs = redactInvocationArgs(processArgs);
	const shouldProbeScrollNoop = executionPlan.commandInfo.command === "scroll" && executionPlan.startupScopedFlags.length === 0;
	const scrollPositionBefore = shouldProbeScrollNoop
		? await collectScrollPositionSnapshot({ cwd, sessionName: executionPlan.sessionName, signal })
		: undefined;

	onUpdate?.({
		content: [{ type: "text", text: `Running agent-browser ${buildInvocationPreview(redactedProcessArgs)}` }],
		details: {
			compatibilityWorkaround,
			effectiveArgs: redactedProcessArgs,
			sessionMode,
			sessionTabCorrection,
			...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession),
		},
	});

	return { kind: "ready", prepared: {
		commandTokens,
		compiledElectron,
		compiledJob,
		compiledNetworkSourceLookup,
		compiledQaPreset,
		compiledSemanticAction,
		compiledSourceLookup,
		compatibilityWorkaround,
		clickDispatchProbe,
		electronLaunch,
		exactSensitiveValues,
		executionPlan,
		includePinnedNavigationSummary,
		pinnedBatchUnwrapMode,
		preparedArgs,
		priorRefSnapshotState,
		priorSessionTabTarget,
		processArgs,
		processStdin,
		processTimeoutMs,
		redactedArgs,
		redactedCompiledElectron,
		redactedCompiledJob,
		redactedCompiledNetworkSourceLookup,
		redactedCompiledQaPreset,
		redactedCompiledSemanticAction,
		redactedCompiledSourceLookup,
		redactedEffectiveArgs,
		redactedProcessArgs,
		redactedRecoveryHint,
		resolvedSemanticActionRefSnapshot,
		runtimeToolArgs,
		runtimeToolStdin,
		scrollPositionBefore,
		sessionMode,
		sessionTabCorrection,
		sessionTabPinningReason,
		shouldProbeScrollNoop,
		statePatch,
		userRequestedJson,
	} };
}
