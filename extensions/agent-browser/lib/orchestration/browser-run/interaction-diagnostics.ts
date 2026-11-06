import { isRecord } from "../../parsing.js";
import type { CompiledAgentBrowserSemanticAction } from "../../input-modes/types.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import { withOptionalSessionArgs } from "../../results/next-actions.js";
import { redactSensitiveText } from "../../runtime-redaction.js";
import { runSessionCommandData } from "./session-state.js";
import { diagnosticResultRecord, rawNumberField, rawStringField } from "./diagnostic-values.js";
import type {
	ComboboxFocusDiagnostic,
	ScrollNoopDiagnostic,
	ScrollPositionSnapshot,
} from "./observation-types.js";

type ScrollMeasurements = Pick<
	ScrollPositionSnapshot,
	"scrollX" | "scrollY" | "innerHeight" | "innerWidth" | "scrollHeight" | "scrollWidth"
>;

function isScrollMeasurements(
	value: unknown,
): value is ScrollMeasurements & Readonly<Record<string, unknown>> {
	return (
		isRecord(value) &&
		["scrollX", "scrollY", "innerHeight", "innerWidth", "scrollHeight", "scrollWidth"].every(
			(field) => typeof value[field] === "number",
		)
	);
}

function parseScrollContainer(entry: unknown, index: number): ScrollPositionSnapshot["containers"] {
	if (!isRecord(entry)) {
		return [];
	}
	const rawId = rawStringField(entry, "id");
	const id =
		rawId !== undefined && rawId !== "" && /^\d+:[a-z][a-z0-9-]*(?:\[role=[a-z-]+\])?$/i.test(rawId)
			? rawId
			: `sample-${index}`;
	const scrollTop = rawNumberField(entry, "scrollTop");
	const scrollLeft = rawNumberField(entry, "scrollLeft");
	return scrollTop !== undefined && scrollLeft !== undefined ? [{ id, scrollLeft, scrollTop }] : [];
}

function extractScrollPositionSnapshot(data: unknown): ScrollPositionSnapshot | undefined {
	const result = diagnosticResultRecord(data);
	if (!result || !isScrollMeasurements(result)) {
		return undefined;
	}
	const containers = Array.isArray(result.containers)
		? result.containers.flatMap(parseScrollContainer)
		: [];
	return {
		containerCount: rawNumberField(result, "containerCount") ?? containers.length,
		containers,
		innerHeight: result.innerHeight,
		innerWidth: result.innerWidth,
		scrollHeight: result.scrollHeight,
		scrollWidth: result.scrollWidth,
		scrollX: result.scrollX,
		scrollY: result.scrollY,
	};
}

const SCROLL_POSITION_EVAL = `(() => {
  const viewport = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    scrollHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
    scrollWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
  };
  const describe = (element, index) => {
    const role = element.getAttribute("role") || "";
    const id = element.tagName.toLowerCase();
    return { id: String(index) + ":" + id + (role ? "[role=" + role + "]" : ""), scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, area: element.clientWidth * element.clientHeight };
  };
  const containers = Array.from(document.querySelectorAll("body *"))
    .filter((element) => element instanceof HTMLElement && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1))
    .map(describe)
    .sort((left, right) => right.area - left.area)
    .slice(0, 10)
    .map(({ area, ...entry }) => entry);
  return { ...viewport, containerCount: containers.length, containers };
})()`;

export async function collectScrollPositionSnapshot(options: {
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<ScrollPositionSnapshot | undefined> {
	return extractScrollPositionSnapshot(
		await runSessionCommandData({
			args: ["eval", "--stdin"],
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: options.signal,
			stdin: SCROLL_POSITION_EVAL,
		}),
	);
}

function sameScrollPositionSnapshot(
	left: ScrollPositionSnapshot,
	right: ScrollPositionSnapshot,
): boolean {
	return (
		left.scrollX === right.scrollX &&
		left.scrollY === right.scrollY &&
		left.scrollHeight === right.scrollHeight &&
		left.scrollWidth === right.scrollWidth &&
		left.containers.length === right.containers.length &&
		left.containers.every((container, index) => {
			const other = right.containers.at(index);
			return (
				other !== undefined &&
				other.id === container.id &&
				other.scrollTop === container.scrollTop &&
				other.scrollLeft === container.scrollLeft
			);
		})
	);
}

export function buildUnsupportedScrollIntoViewRecovery(options: {
	readonly commandTokens: readonly string[];
	readonly sessionName?: string | undefined;
}):
	| { readonly error: string; readonly nextActions: readonly AgentBrowserNextAction[] }
	| undefined {
	if (
		!["scrollintoview", "scrollinto"].includes(options.commandTokens.at(0) ?? "") ||
		options.commandTokens.some((token) => token === "--help" || token === "-h")
	) {
		return undefined;
	}
	const match = /^text=(.+)$/s.exec(options.commandTokens.at(1) ?? "")?.[1];
	if (match === undefined) {
		return undefined;
	}
	const text = redactSensitiveText(match);
	return {
		error:
			"scrollintoview accepts a CSS selector, xpath=..., or a current @e… ref; text=... is not supported and can falsely report success without moving the page.",
		nextActions: [
			{
				id: "scroll-semantic-text-target",
				params: {
					args: withOptionalSessionArgs(options.sessionName, ["find", "text", text, "hover"]),
				},
				reason:
					"Use the upstream semantic text locator; hover resolves and scrolls the matched element into view.",
				safety:
					"Hover may open a tooltip or menu. Use the snapshot/ref recovery instead when hover state could affect the workflow.",
				tool: "agent_browser",
			},
			{
				id: "refresh-refs-for-scroll-target",
				params: { args: withOptionalSessionArgs(options.sessionName, ["snapshot", "-i"]) },
				reason: "Capture a current element ref, then retry scrollintoview with that @e… ref.",
				safety: "Read-only snapshot; choose the intended current ref before retrying the scroll.",
				tool: "agent_browser",
			},
		],
	};
}

export function buildScrollNoopDiagnostic(
	before: ScrollPositionSnapshot | undefined,
	after: ScrollPositionSnapshot | undefined,
): ScrollNoopDiagnostic | undefined {
	if (!before || !after || !sameScrollPositionSnapshot(before, after)) {
		return undefined;
	}
	return {
		after,
		before,
		message:
			"Scroll reported success, but the viewport and sampled scrollable containers did not change position.",
		reason: "no-observed-scroll-position-change",
		recommendations: [
			"Run snapshot -i or screenshot to confirm what is visible before choosing the next action.",
			"On dashboards and panes with nested scrolling, use scrollintoview <@ref> for a visible target or target the actual scrollable region instead of repeating page scrolls.",
		],
	};
}

export function buildScrollNoopNextActions(
	sessionName: string | undefined,
): AgentBrowserNextAction[] {
	return [
		{
			id: "inspect-after-noop-scroll",
			params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) },
			reason:
				"Refresh interactive refs and inspect whether the intended target is inside a nested scroll container.",
			safety: "Do not assume repeated page scrolls will move dashboard panels or nested panes.",
			tool: "agent_browser",
		},
		{
			id: "verify-noop-scroll-visually",
			params: { args: withOptionalSessionArgs(sessionName, ["screenshot"]) },
			reason:
				"Capture the current viewport to verify whether the scroll actually changed visible content.",
			safety: "Use screenshot evidence before concluding a dense dashboard did or did not move.",
			tool: "agent_browser",
		},
	];
}

export function formatScrollNoopDiagnosticText(
	diagnostic: ScrollNoopDiagnostic | undefined,
): string | undefined {
	if (!diagnostic) {
		return undefined;
	}
	return [
		"Scroll diagnostic: no observed scroll movement.",
		`Reason: ${diagnostic.message}`,
		`Sampled scrollable containers: ${diagnostic.after.containers.length}/${diagnostic.after.containerCount}.`,
		...diagnostic.recommendations.map((recommendation) => `- ${recommendation}`),
	].join("\n");
}

const COMBOBOX_FOCUS_EVAL = `(() => {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  };
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const role = active?.getAttribute("role") || undefined;
  const hasPopup = active?.getAttribute("aria-haspopup") || undefined;
  const expanded = active?.getAttribute("aria-expanded") || undefined;
  const tagName = active?.tagName.toLowerCase();
  const name = (active?.getAttribute("aria-label") || active?.getAttribute("placeholder") || active?.getAttribute("title") || active?.textContent || "").trim().slice(0, 80) || undefined;
  const visibleListboxCount = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).filter(isVisible).length;
  const visibleOptionCount = Array.from(document.querySelectorAll('[role="option"], option, [role="menuitem"]')).filter(isVisible).length;
  const comboboxLike = role === "combobox" || hasPopup === "listbox" || hasPopup === "menu" || tagName === "select" || active?.getAttribute("aria-autocomplete") !== null;
  return { activeElement: active ? { expanded, hasPopup, name, role, tagName } : undefined, comboboxLike, visibleListboxCount, visibleOptionCount };
})()`;

function comboboxActiveElement(
	result: Readonly<Record<string, unknown>>,
	expanded: string,
): ComboboxFocusDiagnostic["activeElement"] {
	const name = rawStringField(result, "name");
	return {
		expanded,
		hasPopup: rawStringField(result, "hasPopup"),
		name: name === undefined ? undefined : redactSensitiveText(name),
		role: rawStringField(result, "role"),
		tagName: rawStringField(result, "tagName"),
	};
}

function extractComboboxFocusDiagnostic(data: unknown): ComboboxFocusDiagnostic | undefined {
	const result = diagnosticResultRecord(data);
	if (!result || result.comboboxLike !== true || !isRecord(result.activeElement)) {
		return undefined;
	}
	const visibleListboxCount = rawNumberField(result, "visibleListboxCount") ?? 0;
	const visibleOptionCount = rawNumberField(result, "visibleOptionCount") ?? 0;
	const expanded = rawStringField(result.activeElement, "expanded");
	if (
		(expanded !== "false" && expanded !== "true") ||
		visibleListboxCount > 0 ||
		visibleOptionCount > 0
	) {
		return undefined;
	}
	return {
		activeElement: comboboxActiveElement(result.activeElement, expanded),
		message:
			"A combobox-like control is focused, but no listbox or option elements are visibly open.",
		reason: "focused-combobox-without-visible-options",
		recommendations: [
			"Run snapshot -i to inspect whether options appeared under a different role or portal.",
			"Try ArrowDown or Enter to open the option list before selecting, or use select/visible option refs when available.",
		],
		visibleListboxCount,
		visibleOptionCount,
	};
}

function isComboboxFocusDiagnosticCommand(
	command: string | undefined,
	commandTokens: readonly string[],
): boolean {
	if (!commandTokens.some((token) => /^(?:combobox|listbox)$/i.test(token))) {
		return false;
	}
	if (command === "click" || command === "fill") {
		return true;
	}
	return command === "find" && commandTokens.some((token) => ["click", "fill"].includes(token));
}

function getCompiledSemanticActionRoleValue(
	compiled: CompiledAgentBrowserSemanticAction,
): string | undefined {
	if (compiled.locator !== "role") {
		return undefined;
	}
	const findIndex = compiled.args.indexOf("find");
	if (findIndex < 0 || compiled.args[findIndex + 1] !== "role") {
		return undefined;
	}
	return compiled.args[findIndex + 2];
}

function isComboboxFocusDiagnosticSemanticAction(
	compiled: CompiledAgentBrowserSemanticAction | undefined,
): boolean {
	return (
		compiled !== undefined &&
		["click", "fill"].includes(compiled.action) &&
		/^(?:combobox|listbox)$/i.test(getCompiledSemanticActionRoleValue(compiled) ?? "")
	);
}

export async function collectComboboxFocusDiagnostic(options: {
	readonly command?: string | undefined;
	readonly commandTokens: readonly string[];
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly semanticAction?: CompiledAgentBrowserSemanticAction | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<ComboboxFocusDiagnostic | undefined> {
	if (
		!isComboboxFocusDiagnosticCommand(options.command, options.commandTokens) &&
		!isComboboxFocusDiagnosticSemanticAction(options.semanticAction)
	) {
		return undefined;
	}
	return extractComboboxFocusDiagnostic(
		await runSessionCommandData({
			args: ["eval", "--stdin"],
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: options.signal,
			stdin: COMBOBOX_FOCUS_EVAL,
		}),
	);
}

export function buildComboboxFocusNextActions(
	sessionName: string | undefined,
): AgentBrowserNextAction[] {
	return [
		{
			id: "inspect-focused-combobox",
			params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) },
			reason: "Inspect the focused combobox and any portal/listbox refs before choosing an option.",
			safety:
				"Prefer visible option refs or select when a native/selectable option list is exposed.",
			tool: "agent_browser",
		},
		{
			id: "try-open-combobox-with-arrow",
			params: { args: withOptionalSessionArgs(sessionName, ["press", "ArrowDown"]) },
			reason: "Many searchable comboboxes open their option list with ArrowDown after focus.",
			safety:
				"Use only when the focused combobox is still the intended control, then re-snapshot before selecting.",
			tool: "agent_browser",
		},
		{
			id: "try-open-combobox-with-enter",
			params: { args: withOptionalSessionArgs(sessionName, ["press", "Enter"]) },
			reason: "Some comboboxes open or confirm their option list with Enter after focus.",
			safety:
				"Enter may select a highlighted/default option; prefer ArrowDown first unless Enter is the app's expected opener.",
			tool: "agent_browser",
		},
	];
}

export function formatComboboxFocusDiagnosticText(
	diagnostic: ComboboxFocusDiagnostic | undefined,
): string | undefined {
	if (!diagnostic) {
		return undefined;
	}
	const name = diagnostic.activeElement.name;
	const label = name !== undefined && name !== "" ? ` (${name})` : "";
	return [
		`Combobox diagnostic: focused combobox did not expose visible options${label}.`,
		`Reason: ${diagnostic.message}`,
		...diagnostic.recommendations.map((recommendation) => `- ${recommendation}`),
	].join("\n");
}
