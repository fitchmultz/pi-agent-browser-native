import { isRecord } from "../../parsing.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import { withOptionalSessionArgs } from "../../results/next-actions.js";
import { redactSensitiveText } from "../../runtime-redaction.js";
import type { CommandInfo } from "../../argv-descriptor.js";
import {
	getRefRetiringTransition,
	isCloseCommand,
	isOpenNavigationCommand,
	isPageMutationStep,
	isUnverifiedPageTransitionCommand,
} from "../../command-taxonomy.js";
import { extractBatchResultCommand, extractStringResultField } from "../../session-page-state.js";
import { getExplicitNavigationTarget } from "../../page-target-navigation.js";
import { runSessionCommandData } from "./session-state.js";
import { rawNumberField, rawStringField } from "./diagnostic-values.js";
import type {
	SelectorTextVisibilityCandidate,
	SelectorTextVisibilityDiagnostic,
} from "./observation-types.js";

const SELECTOR_TEXT_VISIBILITY_CANDIDATE_LIMIT = 8;

function buildVisibleTextProbeScript(selector: string): string {
	return `(() => {\n  const selector = ${JSON.stringify(selector)};\n  const isVisible = (element) => {\n    const style = window.getComputedStyle(element);\n    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;\n    return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);\n  };\n  let matches = [];\n  try {\n    matches = Array.from(document.querySelectorAll(selector));\n  } catch (error) {\n    return JSON.stringify({ selector, error: error instanceof Error ? error.message : String(error) });\n  }\n  const visible = matches.filter(isVisible);\n  const trim = (value) => typeof value === 'string' ? value.trim().replace(/\\s+/g, ' ').slice(0, 200) : undefined;\n  const describeCandidate = (element) => {\n    const index = matches.indexOf(element);\n    const role = element.getAttribute('role');\n    const candidate = { index, tagName: element.tagName.toLowerCase(), textPreview: trim(element.textContent) };\n    if (role) candidate.role = role;\n    return candidate;\n  };\n  const visibleCandidates = visible.slice(0, ${SELECTOR_TEXT_VISIBILITY_CANDIDATE_LIMIT}).map(describeCandidate);\n  return JSON.stringify({ selector, matchCount: matches.length, visibleCount: visible.length, firstMatchVisible: matches[0] ? isVisible(matches[0]) : undefined, firstTextPreview: trim(matches[0]?.textContent), firstVisibleTextPreview: trim(visible[0]?.textContent), visibleCandidates });\n})()`;
}

function parseVisibleTextCandidate(entry: unknown): SelectorTextVisibilityCandidate[] {
	if (!isRecord(entry) || typeof entry.index !== "number" || typeof entry.tagName !== "string") {
		return [];
	}
	const role = rawStringField(entry, "role");
	const text = rawStringField(entry, "textPreview");
	const textPreview = text !== undefined && text !== "" ? redactSensitiveText(text) : undefined;
	return [
		{
			index: entry.index,
			tagName: entry.tagName,
			...(role !== undefined && role !== "" ? { role } : {}),
			...(textPreview !== undefined && textPreview !== "" ? { textPreview } : {}),
		},
	];
}

function parseSelectorTextVisibilityCandidates(
	value: unknown,
): SelectorTextVisibilityDiagnostic["visibleCandidates"] {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const candidates = value.flatMap(parseVisibleTextCandidate);
	return candidates.length > 0 ? candidates : undefined;
}

function parseSelectorTextVisibilityProbe(
	data: unknown,
	selector: string,
): Omit<SelectorTextVisibilityDiagnostic, "summary"> | undefined {
	const result = extractStringResultField(data, "result");
	if (result === undefined) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.error === "string") {
		return undefined;
	}
	const matchCount = rawNumberField(parsed, "matchCount");
	const visibleCount = rawNumberField(parsed, "visibleCount");
	if (matchCount === undefined || visibleCount === undefined) {
		return undefined;
	}
	const preview = rawStringField(parsed, "firstVisibleTextPreview");
	return {
		firstMatchVisible:
			typeof parsed.firstMatchVisible === "boolean" ? parsed.firstMatchVisible : undefined,
		firstVisibleTextPreview:
			preview !== undefined && preview !== "" ? redactSensitiveText(preview) : undefined,
		matchCount,
		selector,
		visibleCandidates: parseSelectorTextVisibilityCandidates(parsed.visibleCandidates),
		visibleCount,
	};
}

export function selectorMayExposeSensitiveLiteral(selector: string): boolean {
	return (
		redactSensitiveText(selector) !== selector ||
		/\[[^\]]*[~|^$*]?=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+)\s*(?:[is]\s*)?\]/.test(selector)
	);
}

function canProbeVisibleText(selector: string | undefined): selector is string {
	return (
		selector !== undefined &&
		selector !== "" &&
		!/^@e\d+$/.test(selector) &&
		!/^#[A-Za-z_][\w-]*$/.test(selector) &&
		!selectorMayExposeSensitiveLiteral(selector)
	);
}

function selectorVisibilitySummary(
	parsed: Omit<SelectorTextVisibilityDiagnostic, "summary">,
): string {
	const visibleMatchNoun = `visible match${parsed.visibleCount === 1 ? "" : "es"}`;
	const visibleMatchVerb = parsed.visibleCount === 1 ? "exists" : "exist";
	return parsed.firstMatchVisible === false
		? `Selector ${JSON.stringify(parsed.selector)} matched ${parsed.matchCount} elements; the first match is hidden while ${parsed.visibleCount} ${visibleMatchNoun} ${visibleMatchVerb}.`
		: `Selector ${JSON.stringify(parsed.selector)} matched ${parsed.matchCount} elements; get text reads the first upstream match, which may not be the intended visible tab/panel.`;
}

async function collectSelectorTextVisibilityDiagnosticForSelector(options: {
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly selector: string | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<SelectorTextVisibilityDiagnostic | undefined> {
	const { selector } = options;
	if (!canProbeVisibleText(selector)) {
		return undefined;
	}
	const probe = await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: buildVisibleTextProbeScript(selector),
	});
	const parsed = parseSelectorTextVisibilityProbe(probe, selector);
	if (
		!parsed ||
		(parsed.matchCount <= 1 && parsed.firstMatchVisible !== false) ||
		parsed.visibleCount === 0
	) {
		return undefined;
	}
	return { ...parsed, summary: selectorVisibilitySummary(parsed) };
}

function getBatchGetTextSelectors(data: unknown): string[] {
	if (!Array.isArray(data)) {
		return [];
	}
	return data.flatMap((item: unknown) => {
		if (!isRecord(item) || item.success === false) {
			return [];
		}
		const tokens = extractBatchResultCommand(item);
		const selector = tokens.at(2);
		return tokens[0] === "get" && tokens[1] === "text" && selector !== undefined && selector !== ""
			? [selector]
			: [];
	});
}

function getGetTextSelector(tokens: readonly string[]): string | undefined {
	const selector = tokens.at(2);
	return tokens[0] === "get" && tokens[1] === "text" && selector !== undefined && selector !== ""
		? selector
		: undefined;
}

/**
 * A later batch row that can navigate, mutate the DOM, switch the active target, or close the
 * session ends the probe window: the probe must evaluate the same document the `get text` row
 * read. A later row whose command cannot be read proves nothing either way, so it also ends it.
 */
function batchStepInvalidatesGetTextProbe(step: readonly string[]): boolean {
	if (step.length === 0) {
		return true;
	}
	const [command, subcommand] = step;
	return (
		isCloseCommand(command) ||
		isOpenNavigationCommand(command) ||
		// `tab new` and tab switches move the active target even though their own result
		// reports it; `tab list` only reads. Bare `tab` conservatively ends the window.
		(command === "tab" && subcommand !== "list") ||
		// Optional-URL commands (a11y, vitals, web-vitals) navigate before measuring when a
		// URL operand is present; the bare forms stay on the current page.
		getExplicitNavigationTarget(step) !== undefined ||
		isUnverifiedPageTransitionCommand(command, subcommand) ||
		isPageMutationStep(step) ||
		getRefRetiringTransition(step) !== undefined
	);
}

function getProbeableGetTextSelectors(options: {
	readonly commandInfo: CommandInfo;
	readonly commandTokens: readonly string[];
	readonly data: unknown;
}): string[] {
	if (options.commandInfo.command === "get" && options.commandInfo.subcommand === "text") {
		// A direct read probes the page it just read; no later step can intervene.
		return getSuccessfulGetTextSelectors(options);
	}
	if (options.commandInfo.command !== "batch" || !Array.isArray(options.data)) {
		return [];
	}
	const rows: readonly unknown[] = options.data;
	return rows.flatMap((item: unknown, index: number) => {
		if (!isRecord(item) || item.success === false) {
			return [];
		}
		const selector = getGetTextSelector(extractBatchResultCommand(item));
		if (selector === undefined) {
			return [];
		}
		const invalidatedByLaterRow = rows
			.slice(index + 1)
			.some((later: unknown) =>
				isRecord(later) ? batchStepInvalidatesGetTextProbe(extractBatchResultCommand(later)) : true,
			);
		return invalidatedByLaterRow ? [] : [selector];
	});
}

export function getSuccessfulGetTextSelectors(options: {
	readonly commandInfo: CommandInfo;
	readonly commandTokens: readonly string[];
	readonly data: unknown;
}): string[] {
	if (options.commandInfo.command === "get" && options.commandInfo.subcommand === "text") {
		return [options.commandTokens.at(2)].filter(
			(selector): selector is string => typeof selector === "string" && selector.length > 0,
		);
	}
	return options.commandInfo.command === "batch" ? getBatchGetTextSelectors(options.data) : [];
}

export async function collectSelectorTextVisibilityDiagnostics(options: {
	readonly commandInfo: CommandInfo;
	readonly commandTokens: readonly string[];
	readonly cwd: string;
	readonly data: unknown;
	readonly namespace?: string | undefined;
	readonly sessionClosedByCommand: boolean;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<SelectorTextVisibilityDiagnostic[]> {
	if (options.sessionClosedByCommand) {
		// The command already closed the session; a helper would relaunch the browser.
		return [];
	}
	const selectors = getProbeableGetTextSelectors(options);
	const diagnostics: SelectorTextVisibilityDiagnostic[] = [];
	for (const selector of selectors) {
		// Native helper decisions and selector observations must remain in session order.
		const diagnostic = await collectSelectorTextVisibilityDiagnosticForSelector({
			cwd: options.cwd,
			namespace: options.namespace,
			selector,
			sessionName: options.sessionName,
			signal: options.signal,
		});
		if (diagnostic) {
			diagnostics.push(diagnostic);
		}
	}
	return diagnostics.sort(
		(left, right) =>
			Number(right.firstMatchVisible === false) - Number(left.firstMatchVisible === false),
	);
}

function formatVisibleCandidate(candidate: SelectorTextVisibilityCandidate): string {
	const role =
		candidate.role !== undefined && candidate.role !== "" ? ` role=${candidate.role}` : "";
	const preview =
		candidate.textPreview !== undefined && candidate.textPreview !== ""
			? `: ${JSON.stringify(candidate.textPreview)}`
			: "";
	return `- [${candidate.index}] ${candidate.tagName}${role}${preview}`;
}

function formatSelectorVisibilityDiagnostic(
	diagnostic: SelectorTextVisibilityDiagnostic,
	index: number,
): string[] {
	const actionId =
		index === 0
			? "inspect-visible-text-candidates"
			: `inspect-visible-text-candidates-${index + 1}`;
	const lines = [`Selector text visibility warning: ${diagnostic.summary}`];
	if (
		diagnostic.firstVisibleTextPreview !== undefined &&
		diagnostic.firstVisibleTextPreview !== ""
	) {
		lines.push(`First visible text preview: ${JSON.stringify(diagnostic.firstVisibleTextPreview)}`);
	}
	if (diagnostic.visibleCandidates && diagnostic.visibleCandidates.length > 0) {
		lines.push(
			`Visible candidates (${diagnostic.visibleCandidates.length} shown, querySelectorAll index):`,
			...diagnostic.visibleCandidates.map(formatVisibleCandidate),
		);
	}
	lines.push(
		`Next action: use details.nextActions ${actionId} before trusting this selector text.`,
	);
	return lines;
}

export function formatSelectorTextVisibilityText(
	diagnostics: readonly SelectorTextVisibilityDiagnostic[],
): string | undefined {
	return diagnostics.length === 0
		? undefined
		: diagnostics.flatMap(formatSelectorVisibilityDiagnostic).join("\n");
}

export function buildSelectorTextVisibilityNextActions(options: {
	readonly diagnostics: readonly SelectorTextVisibilityDiagnostic[];
	readonly sessionName?: string | undefined;
}): AgentBrowserNextAction[] {
	return options.diagnostics.map((diagnostic, index): AgentBrowserNextAction => ({
		id:
			index === 0
				? "inspect-visible-text-candidates"
				: `inspect-visible-text-candidates-${index + 1}`,
		params: {
			args: withOptionalSessionArgs(options.sessionName, ["eval", "--stdin"]),
			stdin: buildVisibleTextProbeScript(diagnostic.selector),
		},
		reason:
			"Inspect selector match count and visible text before trusting get text on tabbed or hidden DOM content.",
		safety:
			"Read-only DOM inspection; use a more specific visible selector or current @ref before acting on hidden-tab text.",
		tool: "agent_browser",
	}));
}
