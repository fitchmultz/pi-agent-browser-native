import { isRecord } from "../parsing.js";
import { summarizeNetworkFailures } from "../results/network.js";
import { stringifyUnknown } from "../results/text.js";
import { getBatchResultItems, getCommandNameFromBatchItem, isStringArray } from "./shared.js";
import type {
	AgentBrowserQaPresetAnalysis,
	CompiledAgentBrowserJobStep,
	CompiledAgentBrowserQaPreset,
} from "./types.js";

type BatchItem = Readonly<Record<string, unknown>>;

function expectedTextPreview(text: string): string {
	return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

function visibleTextWaitPassed(
	item: BatchItem,
	step: CompiledAgentBrowserJobStep,
): boolean | undefined {
	if (step.args[0] !== "wait" || step.args[1] !== "--fn") {
		return undefined;
	}
	if (item.success === false) {
		return false;
	}
	if (typeof item.result === "boolean") {
		return item.result;
	}
	if (isRecord(item.result) && typeof item.result.result === "boolean") {
		return item.result.result;
	}
	return true;
}

function textAssertionResult(item: BatchItem): string | undefined {
	if (item.success === false) {
		return undefined;
	}
	const result = item.result;
	if (typeof result === "string") {
		return result;
	}
	if (!isRecord(result)) {
		return undefined;
	}
	for (const key of ["result", "text", "value"]) {
		if (typeof result[key] === "string") {
			return result[key];
		}
	}
	return undefined;
}

function subtractBaselineErrors(
	errors: readonly unknown[],
	baseline: readonly unknown[],
): { matchedCount: number; novelErrors: unknown[] } {
	const counts = new Map<string, number>();
	for (const error of baseline) {
		const signature = stringifyUnknown(error);
		counts.set(signature, (counts.get(signature) ?? 0) + 1);
	}
	let matchedCount = 0;
	const novelErrors = errors.filter((error) => {
		const signature = stringifyUnknown(error);
		const count = counts.get(signature) ?? 0;
		if (count === 0) {
			return true;
		}
		counts.set(signature, count - 1);
		matchedCount++;
		return false;
	});
	return { matchedCount, novelErrors };
}

function isResetCommand(item: BatchItem): boolean {
	const command = item.command;
	if (!isStringArray(command)) {
		return false;
	}
	const [name, subcommand] = command;
	return (
		command.includes("--clear") &&
		(name === "console" || name === "errors" || (name === "network" && subcommand === "requests"))
	);
}

function describeDiagnosticCheck(step: CompiledAgentBrowserJobStep): string | undefined {
	if (step.args.includes("--clear")) {
		return undefined;
	}
	switch (step.args[0]) {
		case "network":
			return "network diagnostics";
		case "console":
			return "console diagnostics";
		case "errors":
			return step.generatedFrom === "qa.errorBaselineAfterClear"
				? undefined
				: "page error diagnostics";
		case undefined:
		default:
			return undefined;
	}
}

function describePlannedCheck(
	step: CompiledAgentBrowserJobStep,
	checks: CompiledAgentBrowserQaPreset["checks"],
): string | undefined {
	if (step.args[0] === "wait" && step.args[1] === "--load") {
		return `load state: ${String(step.args[2])}`;
	}
	const selector = checks.expectedSelector;
	if (
		selector !== undefined &&
		selector.length > 0 &&
		step.args[0] === "wait" &&
		step.args[1] === selector
	) {
		return `expected selector: ${expectedTextPreview(selector)}`;
	}
	if (step.action === "screenshot") {
		return `screenshot: ${expectedTextPreview(step.args[1] ?? "")}`;
	}
	return describeDiagnosticCheck(step);
}

function describeNotRunChecks(compiled: CompiledAgentBrowserQaPreset, count: number): string[] {
	let textIndex = 0;
	const descriptions = compiled.steps.map((step) => {
		if (step.action !== "assertText") {
			return describePlannedCheck(step, compiled.checks);
		}
		const text = compiled.checks.expectedText.at(textIndex++);
		return text === undefined || text.length === 0
			? undefined
			: `expected text: ${expectedTextPreview(text)}`;
	});
	return descriptions
		.slice(count)
		.filter(
			(description): description is string => description !== undefined && description.length > 0,
		);
}

function baselineIndex(compiled: CompiledAgentBrowserQaPreset | undefined): number {
	if (compiled?.checks.diagnosticsResetAtStart !== true || !compiled.checks.checkErrors) {
		return -1;
	}
	return compiled.steps.findIndex((step) => step.generatedFrom === "qa.errorBaselineAfterClear");
}

/** Owns one QA verdict; native diagnostic rows remain observations, not mutable state. */
class QaVerdict {
	private readonly failures: string[] = [];
	private readonly warnings: string[] = [];

	observeDiagnostic(item: BatchItem, baseline: readonly unknown[]): void {
		const result = item.result;
		if (!isRecord(result)) {
			return;
		}
		switch (getCommandNameFromBatchItem(item)) {
			case "errors":
				this.observeErrors(result.errors, baseline);
				break;
			case "console":
				this.observeConsole(result.messages);
				break;
			case "network":
				this.observeNetwork(result.requests);
				break;
			case undefined:
				break;
			default:
				break;
		}
	}

	private observeErrors(value: unknown, baseline: readonly unknown[]): void {
		if (!Array.isArray(value) || value.length === 0) {
			return;
		}
		const { matchedCount, novelErrors } = subtractBaselineErrors(value, baseline);
		if (novelErrors.length > 0) {
			this.failures.push(`${novelErrors.length} page error(s)`);
		}
		if (matchedCount > 0) {
			this.failures.push(
				`page-error check could not be verified (${matchedCount} row(s) matched the post-clear baseline; old residue and identical new errors are indistinguishable)`,
			);
		}
	}

	private observeConsole(value: unknown): void {
		if (!Array.isArray(value)) {
			return;
		}
		const errors = value.filter(
			(message: unknown) =>
				isRecord(message) && /error/i.test(stringifyUnknown(message.type ?? message.level ?? "")),
		).length;
		if (errors > 0) {
			this.failures.push(`${errors} console error message(s)`);
		}
	}

	private observeNetwork(value: unknown): void {
		if (!Array.isArray(value)) {
			return;
		}
		const network = summarizeNetworkFailures(value);
		if (network.actionableCount > 0) {
			this.failures.push(`${network.actionableCount} actionable failed network request(s)`);
		}
		if (network.benignCount > 0) {
			this.warnings.push(`${network.benignCount} benign network request failure(s) ignored`);
		}
	}

	observeBatch(
		items: readonly BatchItem[],
		compiled: CompiledAgentBrowserQaPreset | undefined,
	): void {
		const baselineErrorIndex = baselineIndex(compiled);
		const baselineResult =
			baselineErrorIndex >= 0 ? items.at(baselineErrorIndex)?.result : undefined;
		const baseline =
			isRecord(baselineResult) && Array.isArray(baselineResult.errors) ? baselineResult.errors : [];
		items.forEach((item, index) => {
			if (item.success === false) {
				this.failures.push(`${getCommandNameFromBatchItem(item) ?? "step"} failed`);
			}
			if (
				index === baselineErrorIndex ||
				(compiled?.checks.diagnosticsResetAtStart === true && isResetCommand(item))
			) {
				return;
			}
			this.observeDiagnostic(item, baseline);
		});
	}

	observeExpectedText(items: readonly BatchItem[], compiled: CompiledAgentBrowserQaPreset): void {
		let textIndex = 0;
		compiled.steps.forEach((step, index) => {
			if (step.action !== "assertText") {
				return;
			}
			const expected = compiled.checks.expectedText.at(textIndex++);
			const item = items.at(index);
			if (expected === undefined || expected.length === 0 || item === undefined) {
				return;
			}
			if (visibleTextWaitPassed(item, step) === true) {
				return;
			}
			const actual = textAssertionResult(item);
			if (actual === undefined || !actual.includes(expected)) {
				this.failures.push(`expected text not found: ${expectedTextPreview(expected)}`);
			}
		});
	}

	finish(
		items: readonly BatchItem[],
		compiled: CompiledAgentBrowserQaPreset | undefined,
	): AgentBrowserQaPresetAnalysis {
		const stoppedEarly = compiled !== undefined && items.length < compiled.steps.length;
		const failedFast = stoppedEarly && items.at(-1)?.success === false;
		if (stoppedEarly && !failedFast) {
			this.failures.push("QA execution could not be verified (incomplete batch results)");
		}
		const failedChecks = [...new Set(this.failures)];
		const warnings = [...new Set(this.warnings)];
		const notRunChecks =
			compiled !== undefined && failedFast ? describeNotRunChecks(compiled, items.length) : [];
		return {
			failedChecks,
			warnings,
			notRunChecks,
			passed: failedChecks.length === 0,
			summary: verdictSummary(failedChecks, warnings),
		};
	}
}

function verdictSummary(failures: readonly string[], warnings: readonly string[]): string {
	if (failures.length > 0) {
		return `QA preset failed: ${failures.join("; ")}.`;
	}
	return warnings.length === 0
		? "QA preset passed."
		: `QA preset passed with warnings: ${warnings.join("; ")}.`;
}

export function analyzeQaPresetResults(
	data: unknown,
	compiled?: CompiledAgentBrowserQaPreset,
): AgentBrowserQaPresetAnalysis | undefined {
	const items = getBatchResultItems(data);
	if (items.length === 0) {
		return undefined;
	}
	const verdict = new QaVerdict();
	verdict.observeBatch(items, compiled);
	if (compiled !== undefined && compiled.checks.expectedText.length > 0) {
		verdict.observeExpectedText(items, compiled);
	}
	return verdict.finish(items, compiled);
}

export function analyzeQaPresetTimeout(
	compiled: CompiledAgentBrowserQaPreset,
): AgentBrowserQaPresetAnalysis | undefined {
	if (compiled.checks.expectedText.length === 0) {
		return undefined;
	}
	const failedChecks = compiled.checks.expectedText.map(
		(text) => `expected text was not verified before timeout: ${expectedTextPreview(text)}`,
	);
	return {
		failedChecks,
		notRunChecks: [],
		passed: false,
		summary: `QA preset failed: ${failedChecks.join("; ")}.`,
		warnings: [
			"The wrapper timed out before expected-text evidence could be verified; inspect timeoutPartialProgress and retry with a narrower readiness condition if the page was still loading.",
		],
	};
}
