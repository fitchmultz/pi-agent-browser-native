import { isRecord, parseRefId } from "../../parsing.js";
import { redactSensitiveText } from "../../runtime-redaction.js";
import {
	withOptionalSessionArgs,
	type AgentBrowserNextAction,
} from "../../results/next-actions.js";
import { normalizeAccessibleName } from "../../results/snapshot-refs.js";
import type { SessionRefSnapshot } from "../../session-page-state.js";
import { runSessionCommandData } from "./session-state.js";
import { getAgentBrowserProcessTimeoutMs } from "../../process.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import type {
	ClickDispatchDiagnostic,
	ClickDispatchProbe,
	ClickDispatchProbeTarget,
} from "./types.js";

const CLICK_DISPATCH_MARKER_PREFIX = "__piAgentBrowserClickDispatchProbe_";
const CLICK_DISPATCH_CLEANUP_TIMEOUT_MS = 2_000;
const ACCESSIBLE_REF_CLICK_DISPATCH_ROLES = new Set([
	"button",
	"checkbox",
	"menuitem",
	"radio",
	"switch",
	"tab",
]);

function getClickDispatchProbeTarget(
	commandTokens: readonly string[],
	refSnapshot?: SessionRefSnapshot,
): ClickDispatchProbeTarget | undefined {
	if (commandTokens[0] !== "click" || commandTokens.includes("--new-tab")) {
		return undefined;
	}
	const selector = commandTokens.slice(1).find((token) => token !== "--human");
	if (selector === undefined || selector === "" || selector.startsWith("-")) {
		return undefined;
	}
	const refId = parseRefId(selector);
	if (refId !== undefined && refId !== "") {
		return getAccessibleProbeTarget(refId, refSnapshot);
	}
	if (selector.startsWith("xpath=")) {
		return { kind: "xpath", selector: selector.slice("xpath=".length) };
	}
	return undefined;
}

function getAccessibleProbeTarget(
	refId: string,
	refSnapshot: SessionRefSnapshot | undefined,
): ClickDispatchProbeTarget | undefined {
	const refs: Readonly<Partial<SessionRefSnapshot["refs"]>> = refSnapshot?.refs ?? {};
	const ref = refs[refId];
	if (!ref || !ACCESSIBLE_REF_CLICK_DISPATCH_ROLES.has(ref.role)) {
		return undefined;
	}
	const matchingRefs = Object.values(refs).filter(
		(candidate) =>
			candidate !== undefined &&
			candidate.role.toLowerCase() === ref.role.toLowerCase() &&
			normalizeAccessibleName(candidate.name) === normalizeAccessibleName(ref.name),
	);
	return matchingRefs.length === 1
		? { kind: "accessible", name: ref.name, refId, role: ref.role }
		: undefined;
}

function getEvalResultRecord(data: unknown): Readonly<Record<string, unknown>> | undefined {
	return isRecord(data) && isRecord(data.result) ? data.result : undefined;
}

function getClickDispatchIdentityAttribute(probe: Readonly<ClickDispatchProbe>): string {
	return `data-pi-click-dispatch-${probe.marker.toLowerCase()}`;
}

function buildClickTargetResolutionScript(target: ClickDispatchProbeTarget): string {
	if (target.kind === "selector") {
		return `(() => { try { return document.querySelector(${JSON.stringify(target.selector)}); } catch { return null; } })()`;
	}
	if (target.kind === "xpath") {
		return `(() => { try { return document.evaluate(${JSON.stringify(target.selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch { return null; } })()`;
	}
	return `(() => {
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
}

function buildClickDispatchProbeInstallScript(
	probe: Readonly<ClickDispatchProbe>,
	timeoutMs: number,
): string {
	return `(() => {
const marker = ${JSON.stringify(probe.marker)};
const element = ${buildClickTargetResolutionScript(probe.target)};
if (!element) return { status: "target-not-found", marker };
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
const state = { events: [], target: { tagName: element.tagName.toLowerCase(), nearestScrollContainer, rect: rectInfo(targetRect), targetOutsideViewport } };
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
const identityAttribute = ${JSON.stringify(getClickDispatchIdentityAttribute(probe))};
state.removeIdentityMarker = () => element.removeAttribute(identityAttribute);
let cleanupTimer;
state.cleanup = () => {
  clearTimeout(cleanupTimer);
  state.removeIdentityMarker();
  listeners.forEach(([type, listener]) => document.removeEventListener(type, listener, true));
  try { delete window[marker]; } catch {}
};
// A native pending decision can forbid cleanup eval; expire without another command.
cleanupTimer = setTimeout(state.cleanup, ${timeoutMs + CLICK_DISPATCH_CLEANUP_TIMEOUT_MS});
window[marker] = state;
element.setAttribute(identityAttribute, marker);
return { status: "installed", marker, target: state.target };
})()`;
}

function buildClickDispatchProbeCheckScript(probe: Readonly<ClickDispatchProbe>): string {
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

function buildClickDispatchProbeCleanupScript(probe: Readonly<ClickDispatchProbe>): string {
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

export function buildClickDispatchNextActions(options: {
	readonly commandTokens: readonly string[];
	readonly diagnostic?: ClickDispatchDiagnostic;
	readonly sessionName?: string | undefined;
}): AgentBrowserNextAction[] {
	const retryArgs =
		options.commandTokens[0] === "click" || options.commandTokens[0] === "find"
			? options.commandTokens
			: ["click", ...options.commandTokens];
	const actions: AgentBrowserNextAction[] = [
		{
			id: "inspect-click-dispatch-miss",
			params: { args: withOptionalSessionArgs(options.sessionName, ["snapshot", "-i"]) },
			reason:
				"Refresh interactive refs and verify the intended click target before retrying upstream click.",
			safety:
				"Read-only snapshot; the wrapper does not replay clicks in-page when upstream reports success without DOM events.",
			tool: "agent_browser",
		},
	];
	if (options.diagnostic?.scrollContainer) {
		actions.push({
			id: "scroll-target-into-view-after-dispatch-miss",
			params: {
				args: withOptionalSessionArgs(
					options.sessionName,
					["scrollintoview", retryArgs.at(1)].filter((item) => typeof item === "string"),
				),
			},
			reason:
				options.diagnostic.scrollContainer.selector !== undefined &&
				options.diagnostic.scrollContainer.selector !== ""
					? `The target may be outside nested scroll container ${options.diagnostic.scrollContainer.selector}; scroll the target into view before retrying the click.`
					: "The target may be inside an offscreen nested scroll container; scroll the target into view before retrying the click.",
			safety:
				"Use only for the same current page and target; run snapshot -i again if the page rerendered.",
			tool: "agent_browser",
		});
	}
	actions.push({
		id: "retry-click-after-dispatch-miss",
		params: { args: withOptionalSessionArgs(options.sessionName, retryArgs) },
		reason:
			"Retry the same upstream click after confirming the target is visible; do not assume the prior success mutated the page.",
		safety:
			"Only retry when the target is still intended; use page-change evidence or a fresh snapshot before continuing the workflow.",
		tool: "agent_browser",
	});
	return actions;
}

interface ClickDispatchProbeOptions {
	readonly commandTokens: readonly string[];
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly refSnapshot?: SessionRefSnapshot | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly timeoutMs?: number | undefined;
}

function nativeProbeSelector(target: ClickDispatchProbeTarget): string {
	if (target.kind === "accessible") {
		return `@${target.refId}`;
	}
	return target.kind === "xpath" ? `xpath=${target.selector}` : target.selector;
}

async function verifyClickDispatchProbeIdentity(
	options: ClickDispatchProbeOptions,
	probe: Readonly<ClickDispatchProbe>,
): Promise<boolean> {
	const identity = await runSessionCommandData({
		args: [
			"get",
			"attr",
			nativeProbeSelector(probe.target),
			getClickDispatchIdentityAttribute(probe),
		],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
	});
	if (!isRecord(identity) || identity.value !== probe.marker) {
		return false;
	}
	const removed = await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: `(() => {
const state = window[${JSON.stringify(probe.marker)}];
if (!state || typeof state.removeIdentityMarker !== "function") return { status: "probe-missing" };
state.removeIdentityMarker();
return { status: "identity-marker-removed" };
})()`,
	});
	return getEvalResultRecord(removed)?.status === "identity-marker-removed";
}

function canPrepareClickDispatchProbe(options: ClickDispatchProbeOptions): boolean {
	if (
		(options.sessionName ?? "") === "" ||
		options.commandTokens[0] !== "click" ||
		options.commandTokens.includes("--new-tab")
	) {
		return false;
	}
	// This optional diagnostic must not require approving a fresh eval on every click retry.
	if (
		getAgentBrowserProcessEnvironment()
			.AGENT_BROWSER_CONFIRM_ACTIONS?.split(",")
			.some((action) => action.trim().toLowerCase() === "evaluate") === true
	) {
		return false;
	}
	return true;
}

class ClickDispatchProbeState implements ClickDispatchProbe {
	declare cleaned?: boolean;
	readonly marker = `${CLICK_DISPATCH_MARKER_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
	readonly target: ClickDispatchProbeTarget;

	constructor(target: ClickDispatchProbeTarget) {
		this.target = target;
	}
	markCleaned(): void {
		this.cleaned = true;
	}
}

export async function prepareClickDispatchProbe(
	options: ClickDispatchProbeOptions,
): Promise<ClickDispatchProbe | undefined> {
	if (!canPrepareClickDispatchProbe(options)) {
		return undefined;
	}
	const target = getClickDispatchProbeTarget(options.commandTokens, options.refSnapshot);
	if (!target) {
		return undefined;
	}
	const probe = new ClickDispatchProbeState(target);
	let prepared = false;
	try {
		const installData = await runSessionCommandData({
			args: ["eval", "--stdin"],
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: options.signal,
			stdin: buildClickDispatchProbeInstallScript(
				probe,
				options.timeoutMs ?? getAgentBrowserProcessTimeoutMs(),
			),
		});
		if (getEvalResultRecord(installData)?.status !== "installed") {
			return undefined;
		}
		// Name matching and in-page XPath only find candidates. Native resolution
		// must prove identity, including frame scope, before missing events mean failure.
		if (!(await verifyClickDispatchProbeIdentity(options, probe))) {
			return undefined;
		}
		prepared = options.signal?.aborted !== true;
		return prepared ? probe : undefined;
	} finally {
		// Even a lost/aborted install response may have left listeners in-page.
		if (!prepared) {
			await cleanupClickDispatchProbe({ ...options, probe });
		}
	}
}

function optionalBoolean(
	value: Readonly<Record<string, unknown>> | undefined,
	key: string,
): boolean | undefined {
	return typeof value?.[key] === "boolean" ? value[key] : undefined;
}

function nearestScrollContainer(
	target: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
	return isRecord(target?.nearestScrollContainer) ? target.nearestScrollContainer : undefined;
}

function getClickDispatchScrollContainerDiagnostic(
	result: Readonly<Record<string, unknown>>,
): ClickDispatchDiagnostic["scrollContainer"] {
	const target = isRecord(result.target) ? result.target : undefined;
	const scrollContainer = nearestScrollContainer(target);
	const targetOutsideViewport = optionalBoolean(target, "targetOutsideViewport");
	const targetOutsideContainer = optionalBoolean(scrollContainer, "targetOutsideContainer");
	if (!scrollContainer && targetOutsideViewport !== true) {
		return undefined;
	}
	if (targetOutsideContainer !== true && targetOutsideViewport !== true) {
		return undefined;
	}
	const selector =
		typeof scrollContainer?.selector === "string"
			? redactSensitiveText(scrollContainer.selector)
			: undefined;
	const summary = describeClickScrollContainer(selector);
	return { selector, summary, targetOutsideContainer, targetOutsideViewport };
}

function describeClickScrollContainer(selector: string | undefined): string {
	return selector !== undefined && selector !== ""
		? `Target appears outside nested scroll container ${selector}; use scrollintoview on the target or scroll that container before retrying.`
		: "Target appears outside the viewport or a nested scroll container; use scrollintoview on the target before retrying.";
}

export async function collectClickDispatchDiagnostic(options: {
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly probe?: ClickDispatchProbe | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<ClickDispatchDiagnostic | undefined> {
	if (!options.probe || (options.sessionName ?? "") === "") {
		return undefined;
	}
	const data = await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: buildClickDispatchProbeCheckScript(options.probe),
	});
	const result = getEvalResultRecord(data);
	if (!result) {
		return undefined;
	}
	options.probe.markCleaned();
	const status = typeof result.status === "string" ? result.status : undefined;
	if (status !== "no-native-event-observed") {
		return undefined;
	}
	const nativeEventCount =
		typeof result.nativeEventCount === "number" ? result.nativeEventCount : 0;
	const scrollContainer = getClickDispatchScrollContainerDiagnostic(result);
	const targetLabel = "no trusted DOM event reached the selected element";
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

export async function cleanupClickDispatchProbe(options: {
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly probe?: Readonly<ClickDispatchProbe> | undefined;
	readonly sessionName?: string | undefined;
}): Promise<void> {
	if (!options.probe || options.probe.cleaned === true || (options.sessionName ?? "") === "") {
		return;
	}
	await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		stdin: buildClickDispatchProbeCleanupScript(options.probe),
		timeoutMs: CLICK_DISPATCH_CLEANUP_TIMEOUT_MS,
	}).catch(() => {
		// Probe expiry also removes listeners; cleanup failure must not replace the caller's result.
	});
}
