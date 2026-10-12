import { isRecord } from "../parsing.js";
import { isStringArray } from "./shared.js";
import {
	AGENT_BROWSER_QA_LOAD_STATES,
	type CompiledAgentBrowserJobStep,
	type CompiledAgentBrowserQaPreset,
} from "./types.js";
export { analyzeQaPresetResults, analyzeQaPresetTimeout } from "./qa-analysis.js";
export {
	extractQaPageContext,
	buildQaCompactPassText,
	buildQaCompactFailureText,
} from "./qa-presentation.js";

const QA_VISIBLE_TEXT_TIMEOUT_MS = 5_000;

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
    if (!isVisibleElement(element) || !hasVisibleAncestors(element) || !("value" in element)) continue;
    if (normalize(element.value).includes(expected)) return true;
  }
  return false;
})()`;
}

type QaChecks = CompiledAgentBrowserQaPreset["checks"];
type ValidatedQa =
	| { readonly checks: QaChecks; readonly error?: never }
	| { readonly checks?: never; readonly error: string };

function validateQaIdentity(input: Readonly<Record<string, unknown>>): string | undefined {
	if (input.attached !== undefined && typeof input.attached !== "boolean") {
		return "qa.attached must be a boolean when provided.";
	}
	if (input.attached === true) {
		return input.url === undefined ? undefined : "qa.url must be omitted when qa.attached is true.";
	}
	return typeof input.url !== "string" || input.url.trim().length === 0
		? "qa.url must be a non-empty string."
		: undefined;
}

function validateQaOptions(input: Readonly<Record<string, unknown>>): string | undefined {
	for (const field of ["expectedSelector", "screenshotPath"]) {
		const value = input[field];
		if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
			return `qa.${field} must be a non-empty string when provided.`;
		}
	}
	for (const field of ["checkConsole", "checkErrors", "checkNetwork"]) {
		const value = input[field];
		if (value !== undefined && typeof value !== "boolean") {
			return `qa.${field} must be a boolean when provided.`;
		}
	}
	return undefined;
}

function normalizeExpectedText(value: unknown): unknown {
	if (value === undefined) {
		return [];
	}
	return typeof value === "string" ? [value] : value;
}

function validateQa(input: unknown): ValidatedQa {
	if (!isRecord(input)) {
		return { error: "qa must be an object." };
	}
	const identityError = validateQaIdentity(input);
	if (identityError !== undefined) {
		return { error: identityError };
	}
	const expectedText = normalizeExpectedText(input.expectedText);
	if (!isStringArray(expectedText) || expectedText.some((text) => text.trim().length === 0)) {
		return {
			error:
				"qa.expectedText must be a non-empty string or array of non-empty strings when provided.",
		};
	}
	const optionsError = validateQaOptions(input);
	if (optionsError !== undefined) {
		return { error: optionsError };
	}
	const loadState = AGENT_BROWSER_QA_LOAD_STATES.find((value) => value === input.loadState);
	if (input.loadState !== undefined && loadState === undefined) {
		return { error: `qa.loadState must be one of: ${AGENT_BROWSER_QA_LOAD_STATES.join(", ")}.` };
	}
	return { checks: qaChecks(input, expectedText, loadState ?? "domcontentloaded") };
}

function qaChecks(
	input: Readonly<Record<string, unknown>>,
	expectedText: readonly string[],
	loadState: QaChecks["loadState"],
): QaChecks {
	const attached = input.attached === true;
	return {
		attached,
		checkConsole: typeof input.checkConsole === "boolean" ? input.checkConsole : !attached,
		checkErrors: typeof input.checkErrors === "boolean" ? input.checkErrors : !attached,
		checkNetwork: typeof input.checkNetwork === "boolean" ? input.checkNetwork : !attached,
		diagnosticsResetAtStart: !attached,
		expectedSelector:
			typeof input.expectedSelector === "string" ? input.expectedSelector : undefined,
		expectedText,
		loadState,
		screenshotPath: typeof input.screenshotPath === "string" ? input.screenshotPath : undefined,
		url: typeof input.url === "string" ? input.url.trim() : undefined,
	};
}

function diagnosticResetSteps(checks: QaChecks): CompiledAgentBrowserJobStep[] {
	const steps: CompiledAgentBrowserJobStep[] = [];
	if (!checks.diagnosticsResetAtStart) {
		return steps;
	}
	if (checks.checkNetwork) {
		steps.push({ action: "wait", args: ["network", "requests", "--clear"] });
	}
	if (checks.checkConsole) {
		steps.push({ action: "wait", args: ["console", "--clear"] });
	}
	if (checks.checkErrors) {
		steps.push({ action: "wait", args: ["errors", "--clear"] });
		steps.push({ action: "wait", args: ["errors"], generatedFrom: "qa.errorBaselineAfterClear" });
	}
	return steps;
}

function readinessSteps(checks: QaChecks): CompiledAgentBrowserJobStep[] {
	const steps: CompiledAgentBrowserJobStep[] = [];
	if (!checks.attached && checks.url !== undefined && checks.url.length > 0) {
		steps.push({ action: "open", args: ["open", checks.url] });
	}
	steps.push({ action: "wait", args: ["wait", "--load", checks.loadState] });
	if (checks.checkConsole || checks.checkErrors) {
		steps.push({ action: "wait", args: ["wait", "150"], generatedFrom: "qa.diagnosticSettle" });
	}
	for (const text of checks.expectedText) {
		steps.push({
			action: "assertText",
			args: [
				"wait",
				"--fn",
				buildQaVisibleTextPredicate(text),
				"--timeout",
				String(QA_VISIBLE_TEXT_TIMEOUT_MS),
			],
		});
	}
	if (checks.expectedSelector !== undefined) {
		steps.push({ action: "wait", args: ["wait", checks.expectedSelector] });
	}
	return steps;
}

function diagnosticReadSteps(checks: QaChecks): CompiledAgentBrowserJobStep[] {
	const steps: CompiledAgentBrowserJobStep[] = [];
	if (checks.checkNetwork) {
		steps.push({ action: "wait", args: ["network", "requests"] });
	}
	if (checks.checkConsole) {
		steps.push({ action: "wait", args: ["console"] });
	}
	if (checks.checkErrors) {
		steps.push({ action: "wait", args: ["errors"] });
	}
	if (checks.screenshotPath !== undefined) {
		steps.push({ action: "screenshot", args: ["screenshot", checks.screenshotPath] });
	}
	return steps;
}

export function compileAgentBrowserQaPreset(input: unknown): {
	compiled?: CompiledAgentBrowserQaPreset;
	error?: string;
} {
	const validation = validateQa(input);
	if (validation.error !== undefined) {
		return { error: validation.error };
	}
	const checks = validation.checks;
	const steps = [
		...diagnosticResetSteps(checks),
		...readinessSteps(checks),
		...diagnosticReadSteps(checks),
	];
	return {
		compiled: {
			args: ["batch", "--bail"],
			checks,
			failFast: true,
			stdin: JSON.stringify(steps.map((step) => step.args)),
			steps,
		},
	};
}
