import { isRecord } from "../../parsing.js";
import { redactSensitiveText } from "../../runtime.js";
import { withOptionalSessionArgs, type AgentBrowserNextAction } from "../../results/next-actions.js";
import type { SessionRefSnapshot } from "../../session-page-state.js";
import { runSessionCommandData } from "./session-state.js";
import type { ClickDispatchDiagnostic, ClickDispatchProbe, ClickDispatchProbeTarget } from "./types.js";

const CLICK_DISPATCH_MARKER_PREFIX = "__piAgentBrowserClickDispatchProbe_";
const CLICK_DISPATCH_CLEANUP_TIMEOUT_MS = 2_000;
const ACCESSIBLE_REF_CLICK_DISPATCH_ROLES = new Set(["button", "checkbox", "menuitem", "radio", "switch", "tab"]);

function parseClickRefId(selector: string): string | undefined {
	const trimmed = selector.trim();
	const candidate = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed.startsWith("ref=") ? trimmed.slice(4) : trimmed;
	return /^e\d+$/.test(candidate) ? candidate : undefined;
}

function normalizeAccessibleName(name: string): string {
	return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function getAccessibleRefDuplicateIndex(refSnapshot: SessionRefSnapshot | undefined, refId: string, role: string, name: string): number | undefined {
	if (!refSnapshot?.refs) return undefined;
	const normalizedRole = role.toLowerCase();
	const normalizedName = normalizeAccessibleName(name);
	const matchingRefIds = refSnapshot.refIds.filter((candidateRefId) => {
		const candidate = refSnapshot.refs?.[candidateRefId];
		return candidate?.role.toLowerCase() === normalizedRole && normalizeAccessibleName(candidate.name) === normalizedName;
	});
	if (matchingRefIds.length <= 1) return undefined;
	const duplicateIndex = matchingRefIds.indexOf(refId);
	return duplicateIndex >= 0 ? duplicateIndex : undefined;
}

function getFindClickDispatchProbeTarget(commandTokens: string[]): ClickDispatchProbeTarget | undefined {
	const findIndex = commandTokens[0] === "--session" ? 2 : 0;
	if (commandTokens[findIndex] !== "find") return undefined;
	const locator = commandTokens[findIndex + 1];
	const value = commandTokens[findIndex + 2];
	const action = commandTokens[findIndex + 3];
	if (!locator || !value || action !== "click") return undefined;
	const nameFlagIndex = commandTokens.indexOf("--name", findIndex + 4);
	const name = nameFlagIndex >= 0 ? commandTokens[nameFlagIndex + 1] : undefined;
	return {
		action: "click",
		kind: "locator",
		locator,
		...(name && !name.startsWith("-") ? { name } : {}),
		value,
	};
}

function getClickDispatchProbeTarget(commandTokens: string[], refSnapshot?: SessionRefSnapshot): ClickDispatchProbeTarget | undefined {
	if (commandTokens[0] === "find" || (commandTokens[0] === "--session" && commandTokens[2] === "find")) return getFindClickDispatchProbeTarget(commandTokens);
	if (commandTokens[0] !== "click" || commandTokens.includes("--new-tab")) return undefined;
	const selector = commandTokens[1];
	if (!selector || selector.startsWith("-")) return undefined;
	const refId = parseClickRefId(selector);
	if (refId) {
		const ref = refSnapshot?.refs?.[refId];
		if (!ref || !ACCESSIBLE_REF_CLICK_DISPATCH_ROLES.has(ref.role)) return undefined;
		const duplicateIndex = getAccessibleRefDuplicateIndex(refSnapshot, refId, ref.role, ref.name);
		return { ...(duplicateIndex === undefined ? {} : { duplicateIndex }), kind: "accessible", name: ref.name, refId, role: ref.role };
	}
	if (selector.startsWith("xpath=")) return { kind: "xpath", selector: selector.slice("xpath=".length) };
	return { kind: "selector", selector };
}

function getEvalResultRecord(data: unknown): Record<string, unknown> | undefined {
	return isRecord(data) && isRecord(data.result) ? data.result : undefined;
}

function buildClickDispatchProbeInstallScript(probe: ClickDispatchProbe): string {
	const target = probe.target;
	const resolveTarget = target.kind === "selector"
		? `(() => { try { return document.querySelector(${JSON.stringify(target.selector)}); } catch { return null; } })()`
		: target.kind === "xpath"
			? `(() => { try { return document.evaluate(${JSON.stringify(target.selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch { return null; } })()`
			: target.kind === "locator"
				? "null"
				: `(() => {
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const expectedRole = ${JSON.stringify(target.role)};
  const expectedName = normalize(${JSON.stringify(target.name)});
  const duplicateIndex = ${JSON.stringify(target.duplicateIndex)};
  const inferRole = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button" || tagName === "select" || tagName === "textarea") return tagName;
    if (tagName === "a" && element.hasAttribute("href")) return "link";
    if (tagName === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return "";
  };
  const inferName = (element) => normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.value || element.textContent || "");
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  };
  const candidates = Array.from(document.querySelectorAll("button,a[href],input,select,textarea,summary,[role],[onclick],[tabindex]")).filter((element) => inferRole(element) === expectedRole && inferName(element) === expectedName && isVisible(element));
  if (typeof duplicateIndex === "number") return candidates[duplicateIndex] || null;
  return candidates.length === 1 ? candidates[0] : null;
})()`;
	return `(() => {
const marker = ${JSON.stringify(probe.marker)};
const element = ${resolveTarget};
const targetRequiresElement = ${JSON.stringify(target.kind !== "locator")};
if (!element && targetRequiresElement) return { status: "target-not-found", marker };
const cssEscape = (value) => {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
};
const getSelector = (node) => {
  if (!(node instanceof Element)) return undefined;
  if (node.id) return "#" + cssEscape(node.id);
  const testId = node.getAttribute("data-testid") || node.getAttribute("data-test-id");
  if (testId) return '[data-testid="' + cssEscape(testId) + '"]';
  const parts = [];
  let current = node;
  while (current && current !== document.body && parts.length < 4) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) break;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
    current = parent;
  }
  return parts.length > 0 ? parts.join(" > ") : undefined;
};
const rectInfo = (rect) => ({ bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top });
const targetRect = element ? element.getBoundingClientRect() : undefined;
const targetOutsideViewport = targetRect ? targetRect.bottom < 0 || targetRect.right < 0 || targetRect.top > window.innerHeight || targetRect.left > window.innerWidth : undefined;
let nearestScrollContainer;
if (element && targetRect) {
  for (let current = element.parentElement; current && current !== document.body; current = current.parentElement) {
    if (current.scrollHeight > current.clientHeight + 1 || current.scrollWidth > current.clientWidth + 1) {
      const containerRect = current.getBoundingClientRect();
      nearestScrollContainer = {
        selector: getSelector(current),
        tagName: current.tagName.toLowerCase(),
        targetOutsideContainer: targetRect.bottom < containerRect.top || targetRect.top > containerRect.bottom || targetRect.right < containerRect.left || targetRect.left > containerRect.right,
        targetOutsideViewport,
        rect: rectInfo(containerRect),
        scrollLeft: current.scrollLeft,
        scrollTop: current.scrollTop,
      };
      break;
    }
  }
}
const state = { events: [], target: element && targetRect ? { tagName: element.tagName.toLowerCase(), nearestScrollContainer, rect: rectInfo(targetRect), targetOutsideViewport } : { locator: true } };
const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
const listeners = eventTypes.map((type) => {
  const listener = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const eventTarget = event.target;
    const targetMatched = element ? path.includes(element) || eventTarget === element || (eventTarget instanceof Node && element.contains(eventTarget)) : true;
    state.events.push({ type: event.type, isTrusted: event.isTrusted === true, targetMatched });
  };
  document.addEventListener(type, listener, true);
  return [type, listener];
});
state.cleanup = () => listeners.forEach(([type, listener]) => document.removeEventListener(type, listener, true));
window[marker] = state;
return { status: "installed", marker, target: state.target };
})()`;
}

function buildClickDispatchProbeCheckScript(probe: ClickDispatchProbe): string {
	return `(() => {
const marker = ${JSON.stringify(probe.marker)};
const state = window[marker];
const finish = (payload) => {
  if (state && typeof state.cleanup === "function") state.cleanup();
  try { delete window[marker]; } catch {}
  return payload;
};
if (!state || !Array.isArray(state.events)) return finish({ status: "probe-missing", nativeEventCount: 0 });
const nativeEventCount = state.events.filter((event) => event && event.isTrusted === true && event.targetMatched === true).length;
if (nativeEventCount > 0) return finish({ status: "native-event-observed", nativeEventCount, target: state.target });
return finish({ status: "no-native-event-observed", nativeEventCount, target: state.target });
})()`;
}

function buildClickDispatchProbeCleanupScript(probe: ClickDispatchProbe): string {
	return `(() => {
const marker = ${JSON.stringify(probe.marker)};
const state = window[marker];
if (state && typeof state.cleanup === "function") state.cleanup();
try { delete window[marker]; } catch {}
return { status: "cleaned-up" };
})()`;
}

function redactClickDispatchTarget(target: ClickDispatchProbeTarget): ClickDispatchProbeTarget {
	if (target.kind === "selector" || target.kind === "xpath") {
		return { ...target, selector: redactSensitiveText(target.selector) };
	}
	if (target.kind === "locator") {
		return { ...target, ...(target.name ? { name: redactSensitiveText(target.name) } : {}), value: redactSensitiveText(target.value) };
	}
	return { ...target, name: redactSensitiveText(target.name) };
}

export function formatClickDispatchDiagnosticText(diagnostic: ClickDispatchDiagnostic): string {
	return `Click dispatch diagnostic: ${diagnostic.summary}`;
}

export function buildClickDispatchNextActions(options: { commandTokens: string[]; diagnostic?: ClickDispatchDiagnostic; sessionName?: string }): AgentBrowserNextAction[] {
	const retryArgs = options.commandTokens[0] === "click" || options.commandTokens[0] === "find" ? options.commandTokens : ["click", ...options.commandTokens];
	const actions: AgentBrowserNextAction[] = [
		{
			id: "inspect-click-dispatch-miss",
			params: { args: withOptionalSessionArgs(options.sessionName, ["snapshot", "-i"]) },
			reason: "Refresh interactive refs and verify the intended click target before retrying upstream click.",
			safety: "Read-only snapshot; the wrapper does not replay clicks in-page when upstream reports success without DOM events.",
			tool: "agent_browser",
		},
	];
	if (options.diagnostic?.scrollContainer) {
		actions.push({
			id: "scroll-target-into-view-after-dispatch-miss",
			params: { args: withOptionalSessionArgs(options.sessionName, ["scrollintoview", retryArgs[1]].filter((item): item is string => typeof item === "string")) },
			reason: options.diagnostic.scrollContainer.selector
				? `The target may be outside nested scroll container ${options.diagnostic.scrollContainer.selector}; scroll the target into view before retrying the click.`
				: "The target may be inside an offscreen nested scroll container; scroll the target into view before retrying the click.",
			safety: "Use only for the same current page and target; run snapshot -i again if the page rerendered.",
			tool: "agent_browser",
		});
	}
	actions.push({
		id: "retry-click-after-dispatch-miss",
		params: { args: withOptionalSessionArgs(options.sessionName, retryArgs) },
		reason: "Retry the same upstream click after confirming the target is visible; do not assume the prior success mutated the page.",
		safety: "Only retry when the target is still intended; use page-change evidence or a fresh snapshot before continuing the workflow.",
		tool: "agent_browser",
	});
	return actions;
}

export async function prepareClickDispatchProbe(options: { commandTokens: string[]; cwd: string; refSnapshot?: SessionRefSnapshot; sessionName?: string; signal?: AbortSignal }): Promise<ClickDispatchProbe | undefined> {
	if (!options.sessionName || !["click", "find"].includes(options.commandTokens[0] ?? "") || options.commandTokens.includes("--new-tab")) return undefined;
	const target = getClickDispatchProbeTarget(options.commandTokens, options.refSnapshot);
	if (!target) return undefined;
	const probe: ClickDispatchProbe = { marker: `${CLICK_DISPATCH_MARKER_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`, target };
	const installData = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: buildClickDispatchProbeInstallScript(probe) });
	const installResult = getEvalResultRecord(installData);
	return installResult?.status === "installed" ? probe : undefined;
}

function getClickDispatchScrollContainerDiagnostic(result: Record<string, unknown>): ClickDispatchDiagnostic["scrollContainer"] {
	const target = isRecord(result.target) ? result.target : undefined;
	const scrollContainer = isRecord(target?.nearestScrollContainer) ? target.nearestScrollContainer : undefined;
	const targetOutsideViewport = typeof target?.targetOutsideViewport === "boolean" ? target.targetOutsideViewport : undefined;
	const targetOutsideContainer = typeof scrollContainer?.targetOutsideContainer === "boolean" ? scrollContainer.targetOutsideContainer : undefined;
	if (!scrollContainer && !targetOutsideViewport) return undefined;
	if (targetOutsideContainer !== true && targetOutsideViewport !== true) return undefined;
	const selector = typeof scrollContainer?.selector === "string" ? redactSensitiveText(scrollContainer.selector) : undefined;
	const summary = selector
		? `Target appears outside nested scroll container ${selector}; use scrollintoview on the target or scroll that container before retrying.`
		: "Target appears outside the viewport or a nested scroll container; use scrollintoview on the target before retrying.";
	return { selector, summary, targetOutsideContainer, targetOutsideViewport };
}

export async function collectClickDispatchDiagnostic(options: { cwd: string; probe?: ClickDispatchProbe; sessionName?: string; signal?: AbortSignal }): Promise<ClickDispatchDiagnostic | undefined> {
	if (!options.probe || !options.sessionName) return undefined;
	const data = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: buildClickDispatchProbeCheckScript(options.probe) });
	const result = getEvalResultRecord(data);
	if (!result) return undefined;
	const status = typeof result.status === "string" ? result.status : undefined;
	if (status !== "no-native-event-observed") return undefined;
	const nativeEventCount = typeof result.nativeEventCount === "number" ? result.nativeEventCount : 0;
	const scrollContainer = getClickDispatchScrollContainerDiagnostic(result);
	const targetLabel = options.probe.target.kind === "locator" ? "no trusted DOM click event was observed for the successful locator click" : "no trusted DOM event reached the selected element";
	const summary = scrollContainer
		? `Upstream click reported success but ${targetLabel}. ${scrollContainer.summary}`
		: `Upstream click reported success but ${targetLabel}. Gather evidence with snapshot or page-change checks, then retry upstream click or report the workflow issue; the wrapper does not replay clicks in-page.`;
	return {
		nativeEventCount,
		reason: "native-click-produced-no-target-dom-event",
		...(scrollContainer ? { scrollContainer } : {}),
		status,
		summary,
		target: redactClickDispatchTarget(options.probe.target),
	};
}

export async function cleanupClickDispatchProbe(options: { cwd: string; probe?: ClickDispatchProbe; sessionName?: string }): Promise<void> {
	if (!options.probe || !options.sessionName) return;
	await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		sessionName: options.sessionName,
		stdin: buildClickDispatchProbeCleanupScript(options.probe),
		timeoutMs: CLICK_DISPATCH_CLEANUP_TIMEOUT_MS,
	}).catch(() => undefined);
}
