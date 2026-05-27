import { isRecord } from "../../parsing.js";
import { redactSensitiveText } from "../../runtime.js";
import type { SessionRefSnapshot } from "../../session-page-state.js";
import { runSessionCommandData } from "./session-state.js";
import type { ClickDispatchDiagnostic, ClickDispatchProbe, ClickDispatchProbeTarget } from "./types.js";

const CLICK_DISPATCH_MARKER_PREFIX = "__piAgentBrowserClickDispatchProbe_";

function parseClickRefId(selector: string): string | undefined {
	const trimmed = selector.trim();
	const candidate = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed.startsWith("ref=") ? trimmed.slice(4) : trimmed;
	return /^e\d+$/.test(candidate) ? candidate : undefined;
}

function getSortedClickRefs(refs: Record<string, { name: string; role: string }> | undefined): Array<[string, { name: string; role: string }]> {
	if (!refs) return [];
	return Object.entries(refs).sort(([left], [right]) => Number(left.slice(1)) - Number(right.slice(1)));
}

function getClickDispatchRefTarget(refSnapshot: SessionRefSnapshot | undefined, refId: string): ClickDispatchProbeTarget | undefined {
	const refs = getSortedClickRefs(refSnapshot?.refs);
	const targetEntry = refs.find(([ref]) => ref === refId)?.[1];
	if (!targetEntry) return undefined;
	const nth = refs.filter(([, entry]) => entry.role === targetEntry.role && entry.name === targetEntry.name).findIndex(([ref]) => ref === refId);
	return {
		kind: "ref",
		name: targetEntry.name,
		nth: Math.max(0, nth),
		ref: `@${refId}`,
		role: targetEntry.role,
	};
}

function getClickDispatchSelectorTarget(commandTokens: string[]): ClickDispatchProbeTarget | undefined {
	if (commandTokens[0] !== "click" || commandTokens.includes("--new-tab")) return undefined;
	const selector = commandTokens[1];
	if (!selector || selector.startsWith("-")) return undefined;
	if (parseClickRefId(selector)) return undefined;
	if (selector.startsWith("xpath=")) return { kind: "xpath", selector: selector.slice("xpath=".length) };
	return { kind: "selector", selector };
}

function getEvalResultRecord(data: unknown): Record<string, unknown> | undefined {
	return isRecord(data) && isRecord(data.result) ? data.result : undefined;
}

function buildClickDispatchResolverScript(target: ClickDispatchProbeTarget): string {
	return `
const target = ${JSON.stringify(target)};
const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
const getImplicitRole = (element) => {
  const explicitRole = normalize(element.getAttribute("role")).split(/\\s+/, 1)[0];
  if (explicitRole) return explicitRole.toLowerCase();
  const tagName = element.tagName.toLowerCase();
  if (tagName === "button") return "button";
  if (tagName === "a" && element.hasAttribute("href")) return "link";
  if (tagName === "select") return "combobox";
  if (tagName === "textarea") return "textbox";
  if (tagName === "summary") return "button";
  if (tagName === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    return "textbox";
  }
  return "";
};
const getLabelledByName = (element) => normalize((element.getAttribute("aria-labelledby") || "").split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
const getAccessibleName = (element) => normalize(element.getAttribute("aria-label") || getLabelledByName(element) || element.getAttribute("alt") || element.getAttribute("title") || (element.tagName.toLowerCase() === "input" ? element.getAttribute("value") || element.value || element.getAttribute("placeholder") : "") || element.textContent || "");
const describeElement = (element) => ({ role: getImplicitRole(element) || undefined, name: getAccessibleName(element) || undefined, tagName: element.tagName.toLowerCase() });
const resolveTarget = () => {
  if (target.kind === "selector") {
    try { return document.querySelector(target.selector); } catch { return null; }
  }
  if (target.kind === "xpath") {
    try { return document.evaluate(target.selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch { return null; }
  }
  const role = normalize(target.role).toLowerCase();
  const name = normalize(target.name);
  const nth = Number.isInteger(target.nth) ? target.nth : 0;
  const candidates = Array.from(document.querySelectorAll("button, a[href], input, select, textarea, summary, [role], [onclick], [tabindex]")).filter((element) => getImplicitRole(element) === role && getAccessibleName(element) === name);
  return candidates[nth] || null;
};`;
}

function buildClickDispatchProbeInstallScript(probe: ClickDispatchProbe): string {
	return `(() => {
${buildClickDispatchResolverScript(probe.target)}
const marker = ${JSON.stringify(probe.marker)};
const element = resolveTarget();
if (!element) return { status: "target-not-found", marker };
const state = { events: [], target: describeElement(element) };
const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
const listeners = eventTypes.map((type) => {
  const listener = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const eventTarget = event.target;
    const targetMatched = path.includes(element) || eventTarget === element || (eventTarget instanceof Node && element.contains(eventTarget));
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
	return `(() => new Promise((resolve) => {
${buildClickDispatchResolverScript(probe.target)}
const marker = ${JSON.stringify(probe.marker)};
const state = window[marker];
const finish = (payload) => {
  if (state && typeof state.cleanup === "function") state.cleanup();
  try { delete window[marker]; } catch {}
  resolve(payload);
};
if (!state || !Array.isArray(state.events)) return finish({ status: "probe-missing", nativeEventCount: 0 });
const nativeEventCount = state.events.filter((event) => event && event.isTrusted === true && event.targetMatched === true).length;
if (nativeEventCount > 0) return finish({ status: "native-event-observed", nativeEventCount });
const element = resolveTarget();
if (!element) return finish({ status: "target-missing-after-native", nativeEventCount });
const beforeFallbackEventCount = state.events.length;
try {
  element.click();
} catch (error) {
  return finish({ status: "fallback-failed", nativeEventCount, error: error instanceof Error ? error.message : String(error), target: describeElement(element) });
}
setTimeout(() => {
  const fallbackEventCount = state.events.slice(beforeFallbackEventCount).filter((event) => event && event.targetMatched === true).length;
  finish({ status: "fallback-applied", nativeEventCount, fallbackEventCount, target: describeElement(element) });
}, 50);
}))()`;
}

function redactClickDispatchTarget(target: ClickDispatchProbeTarget): ClickDispatchProbeTarget {
	return {
		...target,
		...(target.name ? { name: redactSensitiveText(target.name) } : {}),
		...(target.role ? { role: redactSensitiveText(target.role) } : {}),
		...(target.selector ? { selector: redactSensitiveText(target.selector) } : {}),
	};
}

export function formatClickDispatchDiagnosticText(diagnostic: ClickDispatchDiagnostic): string {
	return `Click dispatch fallback: ${diagnostic.summary}`;
}

export async function prepareClickDispatchProbe(options: { commandTokens: string[]; cwd: string; refSnapshot?: SessionRefSnapshot; sessionName?: string; signal?: AbortSignal }): Promise<ClickDispatchProbe | undefined> {
	if (!options.sessionName || options.commandTokens[0] !== "click" || options.commandTokens.includes("--new-tab")) return undefined;
	const selector = options.commandTokens[1];
	if (!selector || selector.startsWith("-")) return undefined;
	const refId = parseClickRefId(selector);
	const target = refId ? getClickDispatchRefTarget(options.refSnapshot, refId) : getClickDispatchSelectorTarget(options.commandTokens);
	if (!target) return undefined;
	const probe: ClickDispatchProbe = { marker: `${CLICK_DISPATCH_MARKER_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`, target };
	const installData = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: buildClickDispatchProbeInstallScript(probe) });
	const installResult = getEvalResultRecord(installData);
	return installResult?.status === "installed" ? probe : undefined;
}

export async function collectClickDispatchDiagnostic(options: { cwd: string; probe?: ClickDispatchProbe; sessionName?: string; signal?: AbortSignal }): Promise<ClickDispatchDiagnostic | undefined> {
	if (!options.probe || !options.sessionName) return undefined;
	const data = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: buildClickDispatchProbeCheckScript(options.probe) });
	const result = getEvalResultRecord(data);
	if (!result) return undefined;
	const status = typeof result.status === "string" ? result.status : undefined;
	if (status !== "fallback-applied" && status !== "fallback-failed") return undefined;
	const nativeEventCount = typeof result.nativeEventCount === "number" ? result.nativeEventCount : 0;
	const fallbackEventCount = typeof result.fallbackEventCount === "number" ? result.fallbackEventCount : undefined;
	const error = typeof result.error === "string" ? redactSensitiveText(result.error) : undefined;
	const summary = status === "fallback-applied"
		? "Native click reported success but no DOM event reached the selected element; the wrapper replayed the same element activation in-page."
		: `Native click reported success but no DOM event reached the selected element, and the wrapper could not replay the activation${error ? `: ${error}` : "."}`;
	return {
		error,
		fallbackEventCount,
		nativeEventCount,
		reason: "native-click-produced-no-target-dom-event",
		status,
		summary,
		target: redactClickDispatchTarget(options.probe.target),
	};
}
