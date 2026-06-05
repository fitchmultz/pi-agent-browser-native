/**
 * Purpose: Compile constrained job and lightweight QA wrapper inputs to upstream batch commands.
 * Responsibilities: Validate job/QA fields, produce argv/stdin, and summarize QA diagnostic results.
 * Scope: Job and QA modes only.
 */

import type { ArtifactVerificationSummary } from "../results/contracts.js";
import { isRecord } from "../parsing.js";
import { summarizeNetworkFailures } from "../results/network.js";
import { getBatchResultItems, getCommandNameFromBatchItem, getSelectValues } from "./shared.js";
import { compileAgentBrowserSemanticAction } from "./semantic-action.js";
import {
	AGENT_BROWSER_JOB_STEP_ACTIONS,
	AGENT_BROWSER_QA_LOAD_STATES,
	type AgentBrowserJobStepAction,
	type AgentBrowserQaLoadState,
	type AgentBrowserQaPresetAnalysis,
	type CompiledAgentBrowserJob,
	type CompiledAgentBrowserJobStep,
	type CompiledAgentBrowserQaPreset,
} from "./types.js";

function getRequiredJobString(step: Record<string, unknown>, field: "path" | "selector" | "text" | "url", action: AgentBrowserJobStepAction): { value?: string; error?: string } {
	const value = step[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		return { error: `job step ${action} requires a non-empty ${field} string.` };
	}
	return { value };
}

function compileJobClickOrFillStep(step: Record<string, unknown>, action: "click" | "fill"): { args?: string[]; error?: string } {
	const hasSelector = typeof step.selector === "string" && step.selector.trim().length > 0;
	const hasLocator = step.locator !== undefined || step.role !== undefined || step.name !== undefined || step.value !== undefined;
	if (hasSelector && hasLocator) {
		return { error: `job step ${action} must use either selector or semantic locator fields, not both.` };
	}
	if (hasSelector) {
		if (action === "click") return { args: ["click", step.selector as string] };
		const text = getRequiredJobString(step, "text", action);
		if (text.error) return { error: text.error };
		return { args: ["fill", step.selector as string, text.value as string] };
	}
	if (!hasLocator) {
		return { error: `job step ${action} requires either a non-empty selector string or semantic locator fields.` };
	}
	const compiled = compileAgentBrowserSemanticAction({
		action,
		locator: step.locator,
		name: step.name,
		role: step.role,
		text: step.text,
		value: step.value,
	});
	if (compiled.error) return { error: compiled.error.replaceAll("semanticAction", `job step ${action}`) };
	return { args: compiled.compiled?.args };
}

export function compileAgentBrowserJob(input: unknown): { compiled?: CompiledAgentBrowserJob; error?: string } {
	if (!isRecord(input)) {
		return { error: "job must be an object." };
	}
	const rawSteps = input.steps;
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		return { error: "job.steps must be a non-empty array." };
	}
	const steps: CompiledAgentBrowserJobStep[] = [];
	for (const [index, rawStep] of rawSteps.entries()) {
		if (!isRecord(rawStep)) {
			return { error: `job.steps[${index}] must be an object.` };
		}
		const action = rawStep.action;
		if (typeof action !== "string" || !AGENT_BROWSER_JOB_STEP_ACTIONS.includes(action as AgentBrowserJobStepAction)) {
			return { error: `job.steps[${index}].action must be one of: ${AGENT_BROWSER_JOB_STEP_ACTIONS.join(", ")}.` };
		}
		const jobAction = action as AgentBrowserJobStepAction;
		let args: string[];
		if (jobAction === "open") {
			const result = getRequiredJobString(rawStep, "url", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["open", result.value as string];
		} else if (jobAction === "click" || jobAction === "fill") {
			const result = compileJobClickOrFillStep(rawStep, jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = result.args as string[];
		} else if (jobAction === "select") {
			const selector = getRequiredJobString(rawStep, "selector", jobAction);
			if (selector.error) return { error: `job.steps[${index}]: ${selector.error}` };
			const values = getSelectValues(rawStep, `job.steps[${index}]`);
			if (values.error) return { error: values.error };
			args = ["select", selector.value as string, ...(values.values as string[])];
		} else if (jobAction === "wait") {
			const milliseconds = rawStep.milliseconds;
			if (typeof milliseconds !== "number" || !Number.isInteger(milliseconds) || milliseconds <= 0) {
				return { error: `job.steps[${index}]: job step wait requires a positive integer milliseconds value.` };
			}
			args = ["wait", String(milliseconds)];
		} else if (jobAction === "assertText") {
			const result = getRequiredJobString(rawStep, "text", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["wait", "--text", result.value as string];
		} else if (jobAction === "assertUrl") {
			const result = getRequiredJobString(rawStep, "url", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["wait", "--url", result.value as string];
		} else if (jobAction === "waitForDownload") {
			const result = getRequiredJobString(rawStep, "path", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["wait", "--download", result.value as string];
		} else {
			const result = getRequiredJobString(rawStep, "path", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["screenshot", result.value as string];
		}
		steps.push({ action: jobAction, args });
	}
	return { compiled: { args: ["batch"], stdin: JSON.stringify(steps.map((step) => step.args)), steps } };
}

export function isHttpOrHttpsUrl(url: string): boolean {
	try {
		const protocol = new URL(url).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

function describeQaChecksRun(checks: CompiledAgentBrowserQaPreset["checks"]): string {
	const parts = [`load:${checks.loadState}`];
	if (checks.expectedText.length > 0) parts.push(`text×${checks.expectedText.length}`);
	if (checks.expectedSelector) parts.push("selector");
	if (checks.checkNetwork) parts.push("network");
	if (checks.checkConsole) parts.push("console");
	if (checks.checkErrors) parts.push("errors");
	parts.push(checks.diagnosticsResetAtStart ? "diagnostics-reset" : "attached-diagnostics-preserved");
	if (checks.screenshotPath) parts.push("screenshot");
	return parts.join(", ");
}

export function extractQaPageContext(options: {
	attachedTarget?: { title?: string; url?: string };
	batchData?: unknown;
	compiled?: CompiledAgentBrowserQaPreset;
}): { title?: string; url?: string } {
	if (options.attachedTarget?.title || options.attachedTarget?.url) {
		return { title: options.attachedTarget.title, url: options.attachedTarget.url };
	}
	for (const item of getBatchResultItems(options.batchData)) {
		if (getCommandNameFromBatchItem(item) !== "open" || !isRecord(item.result)) continue;
		const url = typeof item.result.url === "string" ? item.result.url : undefined;
		const title = typeof item.result.title === "string" ? item.result.title : undefined;
		if (url || title) return { title, url };
	}
	if (options.compiled?.checks.url) {
		return { url: options.compiled.checks.url };
	}
	return {};
}

export function buildQaCompactPassText(options: {
	artifactVerification?: ArtifactVerificationSummary;
	batchStepCount: number;
	checks: CompiledAgentBrowserQaPreset["checks"];
	page?: { title?: string; url?: string };
	qaPreset: AgentBrowserQaPresetAnalysis;
}): string {
	const lines = [options.qaPreset.summary];
	const pageParts = [options.page?.title, options.page?.url].filter((part): part is string => typeof part === "string" && part.length > 0);
	if (pageParts.length > 0) lines.push(`Page: ${pageParts.join(" — ")}`);
	lines.push(`Checks run: ${describeQaChecksRun(options.checks)} (${options.batchStepCount} batch step${options.batchStepCount === 1 ? "" : "s"})`);
	if (options.checks.attached && !options.checks.diagnosticsResetAtStart) {
		lines.push("Attached diagnostics: existing upstream session console/network/error buffers were preserved; rows may include events from before qa.attached started.");
	}
	if (options.checks.screenshotPath) {
		const verification = options.artifactVerification;
		lines.push(verification
			? `Screenshot: ${options.checks.screenshotPath} (${verification.verifiedCount}/${verification.artifacts.length} verified on disk)`
			: `Screenshot: ${options.checks.screenshotPath}`);
	}
	lines.push("Full diagnostic matrix: see details.qaPreset and details.batchSteps.");
	return lines.join("\n");
}

export function analyzeQaPresetResults(data: unknown): AgentBrowserQaPresetAnalysis | undefined {
	const items = getBatchResultItems(data);
	if (items.length === 0) return undefined;
	const failedChecks: string[] = [];
	const warnings: string[] = [];
	for (const item of items) {
		if (item.success === false) {
			failedChecks.push(`${getCommandNameFromBatchItem(item) ?? "step"} failed`);
		}
		const result = isRecord(item.result) ? item.result : undefined;
		const commandName = getCommandNameFromBatchItem(item);
		if (commandName === "errors" && Array.isArray(result?.errors) && result.errors.length > 0) {
			failedChecks.push(`${result.errors.length} page error(s)`);
		}
		if (commandName === "console" && Array.isArray(result?.messages)) {
			const errorCount = result.messages.filter((message) => isRecord(message) && /error/i.test(String(message.type ?? message.level ?? ""))).length;
			if (errorCount > 0) failedChecks.push(`${errorCount} console error message(s)`);
		}
		if (commandName === "network" && Array.isArray(result?.requests)) {
			const networkFailures = summarizeNetworkFailures(result.requests);
			if (networkFailures.actionableCount > 0) failedChecks.push(`${networkFailures.actionableCount} actionable failed network request(s)`);
			if (networkFailures.benignCount > 0) warnings.push(`${networkFailures.benignCount} benign network request failure(s) ignored`);
		}
	}
	const uniqueFailures = [...new Set(failedChecks)];
	const uniqueWarnings = [...new Set(warnings)];
	return {
		failedChecks: uniqueFailures,
		passed: uniqueFailures.length === 0,
		summary: uniqueFailures.length === 0
			? uniqueWarnings.length === 0 ? "QA preset passed." : `QA preset passed with warnings: ${uniqueWarnings.join("; ")}.`
			: `QA preset failed: ${uniqueFailures.join("; ")}.`,
		warnings: uniqueWarnings,
	};
}

export function compileAgentBrowserQaPreset(input: unknown): { compiled?: CompiledAgentBrowserQaPreset; error?: string } {
	if (!isRecord(input)) {
		return { error: "qa must be an object." };
	}
	const attached = input.attached === true;
	if (input.attached !== undefined && typeof input.attached !== "boolean") {
		return { error: "qa.attached must be a boolean when provided." };
	}
	const url = input.url;
	if (attached && url !== undefined) {
		return { error: "qa.url must be omitted when qa.attached is true." };
	}
	if (!attached && (typeof url !== "string" || url.trim().length === 0)) {
		return { error: "qa.url must be a non-empty string." };
	}
	const normalizedUrl = typeof url === "string" ? url.trim() : undefined;
	const expectedText = input.expectedText === undefined
		? []
		: typeof input.expectedText === "string"
			? [input.expectedText]
			: Array.isArray(input.expectedText)
				? input.expectedText
				: undefined;
	if (!expectedText || expectedText.some((text) => typeof text !== "string" || text.trim().length === 0)) {
		return { error: "qa.expectedText must be a non-empty string or array of non-empty strings when provided." };
	}
	const expectedSelector = input.expectedSelector;
	if (expectedSelector !== undefined && (typeof expectedSelector !== "string" || expectedSelector.trim().length === 0)) {
		return { error: "qa.expectedSelector must be a non-empty string when provided." };
	}
	const screenshotPath = input.screenshotPath;
	if (screenshotPath !== undefined && (typeof screenshotPath !== "string" || screenshotPath.trim().length === 0)) {
		return { error: "qa.screenshotPath must be a non-empty string when provided." };
	}
	for (const field of ["checkConsole", "checkErrors", "checkNetwork"] as const) {
		if (input[field] !== undefined && typeof input[field] !== "boolean") {
			return { error: `qa.${field} must be a boolean when provided.` };
		}
	}
	const rawLoadState = input.loadState;
	if (rawLoadState !== undefined && (typeof rawLoadState !== "string" || !AGENT_BROWSER_QA_LOAD_STATES.includes(rawLoadState as AgentBrowserQaLoadState))) {
		return { error: `qa.loadState must be one of: ${AGENT_BROWSER_QA_LOAD_STATES.join(", ")}.` };
	}
	const checkConsole = input.checkConsole !== false;
	const checkErrors = input.checkErrors !== false;
	const checkNetwork = input.checkNetwork !== false;
	const loadState = (rawLoadState as AgentBrowserQaLoadState | undefined) ?? "domcontentloaded";
	const diagnosticsResetAtStart = !attached;
	const steps: CompiledAgentBrowserJobStep[] = [];
	if (diagnosticsResetAtStart && checkNetwork) steps.push({ action: "wait", args: ["network", "requests", "--clear"] });
	if (diagnosticsResetAtStart && checkConsole) steps.push({ action: "wait", args: ["console", "--clear"] });
	if (diagnosticsResetAtStart && checkErrors) steps.push({ action: "wait", args: ["errors", "--clear"] });
	if (!attached && normalizedUrl) steps.push({ action: "open", args: ["open", normalizedUrl] });
	steps.push({ action: "wait", args: ["wait", "--load", loadState] });
	for (const text of expectedText) {
		steps.push({ action: "assertText", args: ["wait", "--text", text] });
	}
	if (typeof expectedSelector === "string") {
		steps.push({ action: "wait", args: ["wait", expectedSelector] });
	}
	if (checkNetwork) steps.push({ action: "wait", args: ["network", "requests"] });
	if (checkConsole) steps.push({ action: "wait", args: ["console"] });
	if (checkErrors) steps.push({ action: "wait", args: ["errors"] });
	if (typeof screenshotPath === "string") steps.push({ action: "screenshot", args: ["screenshot", screenshotPath] });
	return {
		compiled: {
			args: ["batch"],
			checks: { attached, checkConsole, checkErrors, checkNetwork, diagnosticsResetAtStart, expectedSelector, expectedText, loadState, screenshotPath, url: normalizedUrl },
			stdin: JSON.stringify(steps.map((step) => step.args)),
			steps,
		},
	};
}
