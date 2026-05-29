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

function getClickDispatchProbeTarget(commandTokens: string[], refSnapshot?: SessionRefSnapshot): ClickDispatchProbeTarget | undefined {
	if (commandTokens[0] !== "click" || commandTokens.includes("--new-tab")) return undefined;
	const selector = commandTokens[1];
	if (!selector || selector.startsWith("-")) return undefined;
	const refId = parseClickRefId(selector);
	if (refId) {
		const ref = refSnapshot?.refs?.[refId];
		if (!ref || !ACCESSIBLE_REF_CLICK_DISPATCH_ROLES.has(ref.role)) return undefined;
		return { kind: "accessible", name: ref.name, refId, role: ref.role };
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
			: `(() => {
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const expectedRole = ${JSON.stringify(target.role)};
  const expectedName = normalize(${JSON.stringify(target.name)});
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
  return candidates.length === 1 ? candidates[0] : null;
})()`;
	return `(() => {
const marker = ${JSON.stringify(probe.marker)};
const element = ${resolveTarget};
if (!element) return { status: "target-not-found", marker };
const state = { events: [], target: { tagName: element.tagName.toLowerCase() } };
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
	return { ...target, name: redactSensitiveText(target.name) };
}

export function formatClickDispatchDiagnosticText(diagnostic: ClickDispatchDiagnostic): string {
	return `Click dispatch diagnostic: ${diagnostic.summary}`;
}

export function buildClickDispatchNextActions(options: { commandTokens: string[]; sessionName?: string }): AgentBrowserNextAction[] {
	const retryArgs = options.commandTokens[0] === "click" ? options.commandTokens : ["click", ...options.commandTokens];
	return [
		{
			id: "inspect-click-dispatch-miss",
			params: { args: withOptionalSessionArgs(options.sessionName, ["snapshot", "-i"]) },
			reason: "Refresh interactive refs and verify the intended click target before retrying upstream click.",
			safety: "Read-only snapshot; the wrapper does not replay clicks in-page when upstream reports success without DOM events.",
			tool: "agent_browser",
		},
		{
			id: "retry-click-after-dispatch-miss",
			params: { args: withOptionalSessionArgs(options.sessionName, retryArgs) },
			reason: "Retry the same upstream click after confirming the target is visible; do not assume the prior success mutated the page.",
			safety: "Only retry when the target is still intended; use page-change evidence or a fresh snapshot before continuing the workflow.",
			tool: "agent_browser",
		},
	];
}

export async function prepareClickDispatchProbe(options: { commandTokens: string[]; cwd: string; refSnapshot?: SessionRefSnapshot; sessionName?: string; signal?: AbortSignal }): Promise<ClickDispatchProbe | undefined> {
	if (!options.sessionName || options.commandTokens[0] !== "click" || options.commandTokens.includes("--new-tab")) return undefined;
	const target = getClickDispatchProbeTarget(options.commandTokens, options.refSnapshot);
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
	if (status !== "no-native-event-observed") return undefined;
	const nativeEventCount = typeof result.nativeEventCount === "number" ? result.nativeEventCount : 0;
	const summary = "Upstream click reported success but no trusted DOM event reached the selected element. Gather evidence with snapshot or page-change checks, then retry upstream click or report the workflow issue; the wrapper does not replay clicks in-page.";
	return {
		nativeEventCount,
		reason: "native-click-produced-no-target-dom-event",
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
