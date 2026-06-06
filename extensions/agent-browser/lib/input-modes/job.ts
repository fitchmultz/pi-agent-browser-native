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
	AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS,
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

function getUnsupportedJobStepField(step: Record<string, unknown>, allowedFields: ReadonlySet<string>): string | undefined {
	return Object.keys(step).find((field) => !allowedFields.has(field));
}

const JOB_TYPE_ALLOWED_FIELDS = new Set(["action", "delayMs", "press", "selector", "text"]);

function compileJobTypeSteps(step: Record<string, unknown>): { error?: string; steps?: CompiledAgentBrowserJobStep[] } {
	const unsupportedField = getUnsupportedJobStepField(step, JOB_TYPE_ALLOWED_FIELDS);
	if (unsupportedField) return { error: `job step type does not support ${unsupportedField}; supported fields are selector, text, delayMs, and press.` };
	const text = getRequiredJobString(step, "text", "type");
	if (text.error) return { error: text.error };
	const selector = step.selector;
	if (selector !== undefined && (typeof selector !== "string" || selector.trim().length === 0)) {
		return { error: "job step type selector must be a non-empty string when provided." };
	}
	if (step.locator !== undefined || step.role !== undefined || step.name !== undefined || step.value !== undefined || step.values !== undefined) {
		return { error: "job step type supports selector, text, delayMs, and press only; focus the target first or use click/fill semantic locator fields in a separate step." };
	}
	const delayMs = step.delayMs;
	if (delayMs !== undefined && (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs <= 0)) {
		return { error: "job step type delayMs must be a positive integer when provided." };
	}
	const press = step.press;
	if (press !== undefined && (typeof press !== "string" || press.trim().length === 0)) {
		return { error: "job step type press must be a non-empty key string when provided." };
	}
	const typedText = text.value as string;
	const typedChars = Array.from(typedText);
	if (typedChars.length === 0) return { error: "job step type requires non-empty text." };
	if (delayMs !== undefined && typedChars.length > AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS) {
		return { error: `job step type delayMs supports at most ${AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS} characters; split longer text into shorter calls or omit delayMs.` };
	}
	const compiledSteps: CompiledAgentBrowserJobStep[] = [];
	if (delayMs === undefined) {
		compiledSteps.push({ action: "type", args: typeof selector === "string" ? ["type", selector, typedText] : ["keyboard", "type", typedText] });
	} else {
		if (typeof selector === "string") compiledSteps.push({ action: "type", args: ["focus", selector], generatedFrom: "type.selector" });
		for (const [index, char] of typedChars.entries()) {
			compiledSteps.push({ action: "type", args: ["keyboard", "type", char], generatedFrom: "type.delayMs" });
			if (index < typedChars.length - 1) compiledSteps.push({ action: "wait", args: ["wait", String(delayMs)], generatedFrom: "type.delayMs" });
		}
	}
	if (typeof press === "string") compiledSteps.push({ action: "type", args: ["press", press], generatedFrom: "type.press" });
	return { steps: compiledSteps };
}

export function compileAgentBrowserJob(input: unknown): { compiled?: CompiledAgentBrowserJob; error?: string } {
	if (!isRecord(input)) {
		return { error: "job must be an object." };
	}
	const rawFailFast = input.failFast;
	if (rawFailFast !== undefined && typeof rawFailFast !== "boolean") {
		return { error: "job.failFast must be a boolean when provided." };
	}
	const failFast = rawFailFast !== false;
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
		let generatedFrom: string | undefined;
		let extraSteps: CompiledAgentBrowserJobStep[] = [];
		if (jobAction === "open") {
			const result = getRequiredJobString(rawStep, "url", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["open", result.value as string];
			if (rawStep.loadState !== undefined) {
				if (typeof rawStep.loadState !== "string" || !AGENT_BROWSER_QA_LOAD_STATES.includes(rawStep.loadState as AgentBrowserQaLoadState)) {
					return { error: `job.steps[${index}].loadState must be one of: ${AGENT_BROWSER_QA_LOAD_STATES.join(", ")}.` };
				}
				extraSteps = [{ action: "wait", args: ["wait", "--load", rawStep.loadState], generatedFrom: "open.loadState" }];
			}
		} else if (jobAction === "click" || jobAction === "fill") {
			const result = compileJobClickOrFillStep(rawStep, jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = result.args as string[];
		} else if (jobAction === "type") {
			const result = compileJobTypeSteps(rawStep);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			const [firstStep, ...restSteps] = result.steps as CompiledAgentBrowserJobStep[];
			args = firstStep.args;
			generatedFrom = firstStep.generatedFrom;
			extraSteps = restSteps;
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
		} else if (jobAction === "snapshot") {
			args = ["snapshot", "-i"];
		} else {
			const result = getRequiredJobString(rawStep, "path", jobAction);
			if (result.error) return { error: `job.steps[${index}]: ${result.error}` };
			args = ["screenshot", result.value as string];
		}
		steps.push({ action: jobAction, args, generatedFrom }, ...extraSteps);
	}
	return { compiled: { args: failFast ? ["batch", "--bail"] : ["batch"], failFast, stdin: JSON.stringify(steps.map((step) => step.args)), steps } };
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
	if (checks.diagnosticsResetAtStart) parts.push("diagnostics-reset");
	else if (checks.checkNetwork || checks.checkConsole || checks.checkErrors) parts.push("attached-diagnostics-preserved");
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
	if (options.checks.attached && !options.checks.diagnosticsResetAtStart && (options.checks.checkNetwork || options.checks.checkConsole || options.checks.checkErrors)) {
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

const QA_VISIBLE_TEXT_TIMEOUT_MS = 5_000;

function formatQaExpectedTextPreview(text: string): string {
	return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

function buildQaVisibleTextPredicate(text: string): string {
	return `(() => {
  const expected = ${JSON.stringify(text)}.replace(/\\s+/g, " ").trim();
  if (!expected) return false;
  const root = document.body || document.documentElement;
  if (!root) return false;
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG"]);
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const isVisibleElement = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (skipTags.has(element.tagName)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  };
  const hasVisibleAncestors = (node) => {
    for (let element = node.parentElement; element; element = element.parentElement) {
      if (!isVisibleElement(element)) return false;
      if (element === root) break;
    }
    return true;
  };
  const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let visitedText = 0;
  for (let node = textWalker.nextNode(); node && visitedText < 6000; node = textWalker.nextNode(), visitedText += 1) {
    if (!hasVisibleAncestors(node)) continue;
    if (normalize(node.nodeValue).includes(expected)) return true;
  }
  const elementWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let visitedElements = 0;
  for (let node = elementWalker.nextNode(); node && visitedElements < 3000; node = elementWalker.nextNode(), visitedElements += 1) {
    const element = node;
    if (!isVisibleElement(element) || !("value" in element)) continue;
    if (normalize(element.value).includes(expected)) return true;
  }
  return false;
})()`;
}

function qaVisibleTextWaitPassed(item: ReturnType<typeof getBatchResultItems>[number] | undefined, step: CompiledAgentBrowserJobStep): boolean | undefined {
	if (step.args[0] !== "wait" || step.args[1] !== "--fn") return undefined;
	if (!item || item.success === false) return false;
	if (typeof item.result === "boolean") return item.result;
	if (isRecord(item.result) && typeof item.result.result === "boolean") return item.result.result;
	return true;
}

function extractQaTextAssertionResultText(item: ReturnType<typeof getBatchResultItems>[number] | undefined): string | undefined {
	if (!item || item.success === false) return undefined;
	const result = item.result;
	if (typeof result === "string") return result;
	if (!isRecord(result)) return undefined;
	for (const key of ["result", "text", "value"] as const) {
		const value = result[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

export function analyzeQaPresetTimeout(compiled: CompiledAgentBrowserQaPreset): AgentBrowserQaPresetAnalysis | undefined {
	if (compiled.checks.expectedText.length === 0) return undefined;
	const failedChecks = compiled.checks.expectedText.map((text) => `expected text was not verified before timeout: ${formatQaExpectedTextPreview(text)}`);
	return {
		failedChecks,
		passed: false,
		summary: `QA preset failed: ${failedChecks.join("; ")}.`,
		warnings: ["The wrapper timed out before expected-text evidence could be verified; inspect timeoutPartialProgress and retry with a narrower readiness condition if the page was still loading."],
	};
}

export function analyzeQaPresetResults(data: unknown, compiled?: CompiledAgentBrowserQaPreset): AgentBrowserQaPresetAnalysis | undefined {
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
	if (compiled?.checks.expectedText.length) {
		let expectedTextIndex = 0;
		compiled.steps.forEach((step, index) => {
			if (step.action !== "assertText") return;
			const expected = compiled.checks.expectedText[expectedTextIndex++];
			if (!expected) return;
			const visibleTextPassed = qaVisibleTextWaitPassed(items[index], step);
			if (visibleTextPassed === true) return;
			const actual = extractQaTextAssertionResultText(items[index]);
			if (!actual || !actual.includes(expected)) failedChecks.push(`expected text not found: ${formatQaExpectedTextPreview(expected)}`);
		});
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
	const checkConsole = typeof input.checkConsole === "boolean" ? input.checkConsole : !attached;
	const checkErrors = typeof input.checkErrors === "boolean" ? input.checkErrors : !attached;
	const checkNetwork = typeof input.checkNetwork === "boolean" ? input.checkNetwork : !attached;
	const loadState = (rawLoadState as AgentBrowserQaLoadState | undefined) ?? "domcontentloaded";
	const diagnosticsResetAtStart = !attached;
	const steps: CompiledAgentBrowserJobStep[] = [];
	if (diagnosticsResetAtStart && checkNetwork) steps.push({ action: "wait", args: ["network", "requests", "--clear"] });
	if (diagnosticsResetAtStart && checkConsole) steps.push({ action: "wait", args: ["console", "--clear"] });
	if (diagnosticsResetAtStart && checkErrors) steps.push({ action: "wait", args: ["errors", "--clear"] });
	if (!attached && normalizedUrl) steps.push({ action: "open", args: ["open", normalizedUrl] });
	steps.push({ action: "wait", args: ["wait", "--load", loadState] });
	for (const text of expectedText) {
		steps.push({ action: "assertText", args: ["wait", "--fn", buildQaVisibleTextPredicate(text), "--timeout", String(QA_VISIBLE_TEXT_TIMEOUT_MS)] });
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
			args: ["batch", "--bail"],
			checks: { attached, checkConsole, checkErrors, checkNetwork, diagnosticsResetAtStart, expectedSelector, expectedText, loadState, screenshotPath, url: normalizedUrl },
			failFast: true,
			stdin: JSON.stringify(steps.map((step) => step.args)),
			steps,
		},
	};
}
