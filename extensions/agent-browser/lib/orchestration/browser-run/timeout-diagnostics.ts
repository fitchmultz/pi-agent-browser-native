import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as sleepMs } from "node:timers/promises";

import { isOpenNavigationCommand } from "../../command-taxonomy.js";
import { isBrowserIndependentRead } from "../../command-policy.js";
import type { CompiledAgentBrowserJob } from "../../input-modes/types.js";
import { redactInvocationArgs, redactSensitiveText } from "../../runtime-redaction.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { getExplicitArtifactDestination } from "./artifact-paths.js";
import { extractStringResultField, runSessionCommandData } from "./session-state.js";
import {
	redactSensitivePathSegmentsForDiagnostic,
	sanitizeCurrentPageUrlForTimeoutDiagnostic,
	type TimeoutArtifactEvidence,
	type TimeoutPartialProgress,
	type TimeoutProgressStep,
} from "./timeout-progress.js";

interface PlannedTimeoutStep {
	readonly args: readonly string[];
	readonly generatedFrom?: string;
	readonly index: number;
}

interface TimeoutDiagnosticOptions {
	readonly commandTokens: readonly string[];
	readonly compiledJob?: CompiledAgentBrowserJob;
	readonly cwd: string;
	readonly operationCwd?: string;
	readonly namespace?: string;
	readonly sessionName?: string;
	readonly stdin?: string;
}

function getTimeoutProgressSteps(options: TimeoutDiagnosticOptions): TimeoutProgressStep[] {
	if (options.compiledJob) {
		return options.compiledJob.steps.map((step, index): TimeoutProgressStep => ({
			args: step.args,
			generatedFrom: step.generatedFrom,
			index: index + 1,
			status: "unknown",
			reason: "Upstream did not report this step's outcome before timeout.",
		}));
	}
	return getUpstreamEffectiveBatchSteps(options.commandTokens, options.stdin).map(
		(args, index): TimeoutProgressStep => ({
			args,
			index: index + 1,
			status: "unknown",
			reason: "Upstream did not report this step's outcome before timeout.",
		}),
	);
}

function getLastPositionalToken(args: readonly string[], startIndex = 1): string | undefined {
	for (let index = args.length - 1; index >= startIndex; index -= 1) {
		const token = args[index];
		if (token !== "" && !token.startsWith("-")) {
			return token;
		}
	}
	return undefined;
}

function getTimeoutStepArtifactPath(commandTokens: readonly string[]): string | undefined {
	return ["screenshot", "pdf", "download", "wait"].includes(commandTokens[0])
		? getExplicitArtifactDestination(commandTokens)
		: undefined;
}

async function statTimeoutArtifactPath(
	absolutePath: string,
): Promise<{ readonly exists: false } | { readonly exists: true; readonly sizeBytes: number }> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			// Retries observe a still-finishing native writer only after the prior stat settles.
			// oxlint-disable-next-line no-await-in-loop
			const stats = await stat(absolutePath);
			return { exists: true, sizeBytes: stats.size };
		} catch {
			if (attempt < 2) {
				// Backoff must complete before the next artifact observation.
				// oxlint-disable-next-line no-await-in-loop
				await sleepMs(25);
			}
		}
	}
	return { exists: false };
}

async function collectTimeoutArtifactEvidence(
	cwd: string,
	steps: readonly PlannedTimeoutStep[],
): Promise<TimeoutArtifactEvidence[]> {
	const paths = steps.flatMap((step) => {
		const path = getTimeoutStepArtifactPath(step.args);
		if (path === undefined || path === "") {
			return [];
		}
		const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
		return [{ absolutePath, path, stepIndex: step.index }];
	});
	// stat uses libuv's bounded filesystem pool, not one open file per observation.
	// Independent retry timers overlap; Promise.all retains native plan order.
	return Promise.all(
		paths.map(async ({ absolutePath, path, stepIndex }): Promise<TimeoutArtifactEvidence> => {
			const artifact = await statTimeoutArtifactPath(absolutePath);
			if (artifact.exists) {
				return {
					absolutePath,
					exists: true,
					path,
					sizeBytes: artifact.sizeBytes,
					state: "verified",
					stepIndex,
				};
			}
			return {
				absolutePath,
				exists: false,
				path,
				state: "missing",
				stepIndex,
			};
		}),
	);
}

function getPlannedCurrentPageUrl(steps: readonly PlannedTimeoutStep[]): string | undefined {
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		const args = steps.at(index)?.args ?? [];
		if (isOpenNavigationCommand(args[0]) || args[0] === "pushstate") {
			return getLastPositionalToken(args);
		}
	}
	return undefined;
}

const TIMEOUT_RETRYABLE_COMMANDS = new Set([
	"console",
	"diff",
	"errors",
	"get",
	"goto",
	"navigate",
	"network",
	"open",
	"pdf",
	"pushstate",
	"screenshot",
	"snapshot",
	"tab",
	"vitals",
	"wait",
]);

function getTimeoutStepRetry(step: TimeoutProgressStep): TimeoutProgressStep["retry"] {
	const command = step.args.at(0);
	return command !== undefined && command !== "" && TIMEOUT_RETRYABLE_COMMANDS.has(command)
		? { args: ["batch"], stdin: JSON.stringify([step.args]) }
		: undefined;
}

function timeoutRetryStep(steps: readonly TimeoutProgressStep[]): TimeoutProgressStep | undefined {
	const singleStep = steps.length === 1 ? steps.at(0) : undefined;
	const retry = singleStep ? getTimeoutStepRetry(singleStep) : undefined;
	return singleStep && retry ? { ...singleStep, retry } : undefined;
}

function currentPageSource(
	recoveredUrl: string | undefined,
	plannedUrl: string | undefined,
	title: string | undefined,
): "live" | "planned" | undefined {
	if ((recoveredUrl ?? "") !== "") {
		return "live";
	}
	if ((plannedUrl ?? "") !== "") {
		return "planned";
	}
	return (title ?? "") !== "" ? "live" : undefined;
}

interface TimeoutPageObservation {
	readonly currentPage?: TimeoutPartialProgress["currentPage"];
	readonly liveUrlRecovered: boolean;
	readonly summary: string;
}

async function probeTimeoutPage(options: TimeoutDiagnosticOptions): Promise<{
	readonly recoveredUrl?: string;
	readonly title?: string;
}> {
	const urlData = await runSessionCommandData({
		args: ["get", "url"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
	});
	const recoveredUrl =
		extractStringResultField(urlData, "result") ?? extractStringResultField(urlData, "url");
	const titleData =
		(recoveredUrl ?? "") !== ""
			? await runSessionCommandData({
					args: ["get", "title"],
					cwd: options.cwd,
					namespace: options.namespace,
					sessionName: options.sessionName,
				})
			: undefined;
	const title =
		extractStringResultField(titleData, "result") ?? extractStringResultField(titleData, "title");
	return { recoveredUrl, title };
}

function timeoutPageSummary(
	recoveredUrl: string | undefined,
	title: string | undefined,
	plannedUrl: string | undefined,
): string {
	if ((recoveredUrl ?? "") !== "" || (title ?? "") !== "") {
		return " and current page state";
	}
	return (plannedUrl ?? "") !== "" ? " and planned page URL" : "";
}

function buildTimeoutPage(
	observed: {
		readonly recoveredUrl?: string;
		readonly title?: string;
	},
	steps: readonly PlannedTimeoutStep[],
): TimeoutPageObservation {
	const { recoveredUrl, title } = observed;
	const plannedUrl = (recoveredUrl ?? "") !== "" ? undefined : getPlannedCurrentPageUrl(steps);
	const url = recoveredUrl ?? plannedUrl;
	const source = currentPageSource(recoveredUrl, plannedUrl, title);
	return {
		currentPage: (url ?? "") !== "" || (title ?? "") !== "" ? { source, title, url } : undefined,
		liveUrlRecovered: recoveredUrl !== undefined,
		summary: timeoutPageSummary(recoveredUrl, title, plannedUrl),
	};
}

function formatTimeoutSummary(
	stepCount: number,
	artifacts: readonly TimeoutArtifactEvidence[],
	pageSummary: string,
): string {
	const foundArtifacts = artifacts.filter((artifact) => artifact.exists).length;
	return `Timed out before upstream returned final results; ${stepCount} planned step outcome${stepCount === 1 ? " is" : "s are"} unknown. Found ${foundArtifacts}/${artifacts.length} declared artifact path${artifacts.length === 1 ? "" : "s"}${pageSummary}; these observations do not prove step execution.`;
}

export async function collectTimeoutPartialProgress(
	options: TimeoutDiagnosticOptions,
): Promise<TimeoutPartialProgress | undefined> {
	if (
		(options.commandTokens[0] === "session" && options.commandTokens[1] === "info") ||
		isBrowserIndependentRead(options.commandTokens, options.stdin)
	) {
		return undefined;
	}
	const rawSteps = getTimeoutProgressSteps(options);
	const artifacts = await collectTimeoutArtifactEvidence(
		options.operationCwd ?? options.cwd,
		rawSteps,
	);
	const page = buildTimeoutPage(await probeTimeoutPage(options), rawSteps);
	if (rawSteps.length === 0 && artifacts.length === 0 && !page.currentPage) {
		return undefined;
	}
	// A matching URL or existing file is current state, not an execution receipt.
	const steps = rawSteps;
	return {
		artifacts,
		currentPage: page.currentPage,
		liveUrlRecovered: page.liveUrlRecovered,
		retryStep: timeoutRetryStep(steps),
		steps: steps.length > 0 ? steps : undefined,
		summary: formatTimeoutSummary(steps.length, artifacts, page.summary),
	};
}

function formatTimeoutSteps(steps: readonly TimeoutProgressStep[] | undefined): string[] {
	if (!steps || steps.length === 0) {
		return [];
	}
	const shownSteps = steps.slice(0, 6);
	const lines = [
		"Planned steps:",
		...shownSteps.map((step) => {
			const commandText = redactSensitivePathSegmentsForDiagnostic(
				redactInvocationArgs(step.args).join(" "),
			);
			const generatedFrom =
				step.generatedFrom !== undefined && step.generatedFrom !== ""
					? `, generated from ${step.generatedFrom}`
					: "";
			const reason =
				step.reason !== undefined && step.reason !== ""
					? ` — ${redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(step.reason))}`
					: "";
			return `- Step ${step.index} [${step.status}${generatedFrom}]: ${commandText}${reason}`;
		}),
	];
	if (steps.length > shownSteps.length) {
		lines.push(
			`- ... ${steps.length - shownSteps.length} more step${steps.length - shownSteps.length === 1 ? "" : "s"} omitted`,
		);
	}
	return lines;
}

function formatTimeoutRetry(
	step: TimeoutProgressStep | undefined,
	pageTargetUnknown: boolean,
): string | undefined {
	if (!step?.retry) {
		return undefined;
	}
	const payload = JSON.stringify({
		...step.retry,
		stdin: JSON.stringify([redactInvocationArgs(step.args)]),
	});
	return pageTargetUnknown
		? `Retry candidate for step ${step.index}: ${payload}. Verify the current URL before running it.`
		: `Retry candidate for step ${step.index} (outcome unknown): ${payload}`;
}

function formatTimeoutArtifact(artifact: TimeoutArtifactEvidence): string {
	const size = typeof artifact.sizeBytes === "number" ? `, ${artifact.sizeBytes} bytes` : "";
	const state = artifact.exists ? `exists${size}` : "missing";
	return `Artifact from step ${artifact.stepIndex}: ${redactSensitivePathSegmentsForDiagnostic(artifact.path)} (${state})`;
}

function formatTimeoutCurrentPage(page: TimeoutPartialProgress["currentPage"]): string | undefined {
	if (!page) {
		return undefined;
	}
	const title = page.title ?? "";
	const url = page.url ?? "";
	if (title === "" && url === "") {
		return undefined;
	}
	const currentPageTitle =
		title !== "" ? redactSensitivePathSegmentsForDiagnostic(redactSensitiveText(title)) : undefined;
	const currentPageUrl = url !== "" ? sanitizeCurrentPageUrlForTimeoutDiagnostic(url) : undefined;
	return `Current page: ${[currentPageTitle, currentPageUrl].filter(Boolean).join(" — ")}`;
}

export function formatTimeoutPartialProgressText(
	progress: TimeoutPartialProgress,
	pageTargetUnknown = false,
): string {
	const lines = [`Timeout partial progress: ${progress.summary}`];
	const currentPage = formatTimeoutCurrentPage(progress.currentPage);
	if (currentPage !== undefined) {
		lines.push(currentPage);
	}
	lines.push(...formatTimeoutSteps(progress.steps));
	const retry = formatTimeoutRetry(progress.retryStep, pageTargetUnknown);
	if (retry !== undefined) {
		lines.push(retry);
	}
	lines.push(...progress.artifacts.map(formatTimeoutArtifact));
	return lines.join("\n");
}
