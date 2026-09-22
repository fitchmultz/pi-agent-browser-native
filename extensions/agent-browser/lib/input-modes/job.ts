import type { ArtifactVerificationSummary } from "../results/contracts.js";
import { isRecord } from "../parsing.js";
import { summarizeNetworkFailures } from "../results/network.js";
import { getBatchResultItems, getCommandNameFromBatchItem } from "./shared.js";
import {
	AGENT_BROWSER_QA_LOAD_STATES,
	type AgentBrowserQaLoadState,
	type AgentBrowserQaPresetAnalysis,
	type CompiledAgentBrowserJobStep,
	type CompiledAgentBrowserQaPreset,
} from "./types.js";

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
	if (options.checks.diagnosticsResetAtStart && (options.checks.checkNetwork || options.checks.checkConsole || options.checks.checkErrors)) {
		lines.push("Diagnostic isolation: URL QA requests clears of enabled diagnostic buffers before opening the target.");
	}
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

export function buildQaCompactFailureText(options: {
	batchStepCount: number;
	checks: CompiledAgentBrowserQaPreset["checks"];
	page?: { title?: string; url?: string };
	qaPreset: AgentBrowserQaPresetAnalysis;
}): string {
	const lines = [options.qaPreset.summary];
	const pageParts = [options.page?.title, options.page?.url].filter((part): part is string => typeof part === "string" && part.length > 0);
	if (pageParts.length > 0) lines.push(`Page: ${pageParts.join(" — ")}`);
	if (options.qaPreset.failedChecks.length > 0) lines.push("Failed checks:", ...options.qaPreset.failedChecks.map((failure) => `- ${failure}`));
	if (options.qaPreset.warnings.length > 0) lines.push("Warnings:", ...options.qaPreset.warnings.map((warning) => `- ${warning}`));
	lines.push(`Checks run: ${describeQaChecksRun(options.checks)} (${options.batchStepCount} batch step${options.batchStepCount === 1 ? "" : "s"})`);
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

function qaErrorSignature(error: unknown): string {
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function subtractQaBaselineErrors(errors: unknown[], baselineErrors: unknown[]): { matchedCount: number; novelErrors: unknown[] } {
	const baselineCounts = new Map<string, number>();
	for (const error of baselineErrors) {
		const signature = qaErrorSignature(error);
		baselineCounts.set(signature, (baselineCounts.get(signature) ?? 0) + 1);
	}
	let matchedCount = 0;
	const novelErrors = errors.filter((error) => {
		const signature = qaErrorSignature(error);
		const count = baselineCounts.get(signature) ?? 0;
		if (count === 0) return true;
		baselineCounts.set(signature, count - 1);
		matchedCount += 1;
		return false;
	});
	return { matchedCount, novelErrors };
}

function isDiagnosticResetCommand(item: Record<string, unknown>): boolean {
	const command = item.command;
	if (!Array.isArray(command) || !command.every((token): token is string => typeof token === "string")) return false;
	const [name, subcommand] = command;
	return command.includes("--clear") && (name === "console" || name === "errors" || (name === "network" && subcommand === "requests"));
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
	const baselineErrorIndex = compiled?.checks.diagnosticsResetAtStart && compiled.checks.checkErrors
		? compiled.steps.findIndex((step) => step.generatedFrom === "qa.errorBaselineAfterClear")
		: -1;
	const baselineErrorItem = baselineErrorIndex >= 0 ? items[baselineErrorIndex] : undefined;
	const baselineErrorResult = isRecord(baselineErrorItem?.result) ? baselineErrorItem.result : undefined;
	const baselineErrors = Array.isArray(baselineErrorResult?.errors) ? baselineErrorResult.errors : [];
	for (const [index, item] of items.entries()) {
		if (item.success === false) {
			failedChecks.push(`${getCommandNameFromBatchItem(item) ?? "step"} failed`);
		}
		if (index === baselineErrorIndex) continue;
		const result = isRecord(item.result) ? item.result : undefined;
		const commandName = getCommandNameFromBatchItem(item);
		if (compiled?.checks.diagnosticsResetAtStart && isDiagnosticResetCommand(item)) {
			continue;
		}
		if (commandName === "errors" && Array.isArray(result?.errors) && result.errors.length > 0) {
			const { matchedCount, novelErrors } = subtractQaBaselineErrors(result.errors, baselineErrors);
			if (novelErrors.length > 0) failedChecks.push(`${novelErrors.length} page error(s)`);
			if (matchedCount > 0) failedChecks.push(`page-error check could not be verified (${matchedCount} row(s) matched the post-clear baseline; old residue and identical new errors are indistinguishable)`);
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
	if (diagnosticsResetAtStart && checkErrors) {
		steps.push({ action: "wait", args: ["errors", "--clear"] });
		steps.push({ action: "wait", args: ["errors"], generatedFrom: "qa.errorBaselineAfterClear" });
	}
	if (!attached && normalizedUrl) steps.push({ action: "open", args: ["open", normalizedUrl] });
	steps.push({ action: "wait", args: ["wait", "--load", loadState] });
	if (checkConsole || checkErrors) steps.push({ action: "wait", args: ["wait", "150"], generatedFrom: "qa.diagnosticSettle" });
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
