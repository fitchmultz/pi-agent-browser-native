import { isRecord } from "../../../parsing.js";
import { buildAgentBrowserResultCategoryDetails } from "../../../results.js";
import type { CompatibilityWorkaround } from "../../../runtime.js";
import { buildScrollNoopNextActions } from "../diagnostics.js";
import { buildSessionDetailFields, runSessionCommandData } from "../session-state.js";
import type { AgentBrowserToolResult } from "../types.js";

const SCROLL_CONTAINER_DIRECTIONS = new Set(["down", "left", "right", "up"]);

function getContainerScrollRequest(commandTokens: string[]): { amount?: string; direction: string; selector: string } | undefined {
	if (commandTokens[0] !== "scroll" || commandTokens.length < 3) return undefined;
	const selector = commandTokens[1];
	const direction = commandTokens[2]?.toLowerCase();
	if (!selector || selector.startsWith("-") || selector.startsWith("@") || SCROLL_CONTAINER_DIRECTIONS.has(selector.toLowerCase())) return undefined;
	if (!SCROLL_CONTAINER_DIRECTIONS.has(direction)) return undefined;
	return { amount: commandTokens[3], direction, selector };
}

function buildContainerScrollScript(request: { amount?: string; direction: string; selector: string }): string {
	return `(() => {
  const selector = ${JSON.stringify(request.selector)};
  const direction = ${JSON.stringify(request.direction)};
  const amountToken = ${JSON.stringify(request.amount ?? "")};
  let element;
  try { element = document.querySelector(selector); } catch (error) { return { status: "invalid-selector", selector, error: String(error && error.message || error) }; }
  if (!(element instanceof HTMLElement)) return { status: "not-found", selector };
  const axis = direction === "left" || direction === "right" ? "x" : "y";
  const before = { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, clientWidth: element.clientWidth };
  const parseAmount = () => {
    const token = String(amountToken || "").trim().toLowerCase();
    const extent = axis === "x" ? element.clientWidth : element.clientHeight;
    if (!token) return Math.max(1, Math.floor(extent * 0.8));
    if (token.endsWith("%")) {
      const value = Number(token.slice(0, -1));
      return Number.isFinite(value) ? Math.max(1, Math.floor(extent * value / 100)) : Math.max(1, Math.floor(extent * 0.8));
    }
    const pixels = Number(token.replace(/px$/, ""));
    return Number.isFinite(pixels) && pixels > 0 ? Math.floor(pixels) : Math.max(1, Math.floor(extent * 0.8));
  };
  const delta = parseAmount() * (direction === "up" || direction === "left" ? -1 : 1);
  if (axis === "x") element.scrollLeft += delta;
  else element.scrollTop += delta;
  const after = { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, clientWidth: element.clientWidth };
  const moved = before.scrollLeft !== after.scrollLeft || before.scrollTop !== after.scrollTop;
  return { status: moved ? "scrolled" : "no-movement", selector, direction, amount: amountToken || undefined, before, after };
})()`;
}

function buildScrollResult(options: {
	command: "scroll";
	compatibilityWorkaround?: CompatibilityWorkaround;
	effectiveArgs: string[];
	message: string;
	redactedArgs: string[];
	result: Record<string, unknown>;
	scrollField: "scrollContainer" | "scrollPage";
	scrollValue: unknown;
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	succeeded: boolean;
	usedImplicitSession: boolean;
}): AgentBrowserToolResult {
	return {
		content: [{ type: "text", text: options.message }],
		details: {
			args: options.redactedArgs,
			command: options.command,
			compatibilityWorkaround: options.compatibilityWorkaround,
			data: options.result,
			effectiveArgs: options.effectiveArgs,
			nextActions: options.succeeded ? undefined : buildScrollNoopNextActions(options.sessionName),
			[options.scrollField]: options.scrollValue,
			sessionMode: options.sessionMode,
			...buildAgentBrowserResultCategoryDetails({ args: options.effectiveArgs, command: options.command, errorText: options.succeeded ? undefined : options.message, succeeded: options.succeeded, validationError: options.succeeded ? undefined : options.message }),
			...buildSessionDetailFields(options.sessionName, options.usedImplicitSession),
			summary: options.message,
			validationError: options.succeeded ? undefined : options.message,
		},
		isError: !options.succeeded,
	};
}

export async function tryContainerScroll(options: {
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	redactedArgs: string[];
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = getContainerScrollRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	const data = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: buildContainerScrollScript(request) });
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	if (!isRecord(result) || typeof result.status !== "string") return undefined;
	const succeeded = result.status === "scrolled";
	const message = succeeded
		? `Scrolled container ${request.selector} ${request.direction}${request.amount ? ` by ${request.amount}` : ""}.`
		: `Scroll container ${request.selector} did not move (${result.status}).`;
	return buildScrollResult({ ...options, command: "scroll", message, result, scrollField: "scrollContainer", scrollValue: { request, result }, succeeded });
}

function getPageScrollToRequest(commandTokens: string[]): { target: "end" | "top" } | undefined {
	if (commandTokens[0] !== "scroll" || commandTokens[1]?.toLowerCase() !== "to") return undefined;
	const target = commandTokens[2]?.toLowerCase();
	return target === "end" || target === "top" ? { target } : undefined;
}

function buildPageScrollToScript(request: { target: "end" | "top" }): string {
	return `(() => {
  const target = ${JSON.stringify(request.target)};
  const scroller = document.scrollingElement || document.documentElement || document.body;
  if (!scroller) return { status: "no-scroller", target };
  const before = { scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, scrollWidth: scroller.scrollWidth, clientHeight: scroller.clientHeight, clientWidth: scroller.clientWidth };
  const nextTop = target === "top" ? 0 : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const nextLeft = scroller.scrollLeft;
  scroller.scrollTop = nextTop;
  window.scrollTo(nextLeft, nextTop);
  const after = { scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, scrollWidth: scroller.scrollWidth, clientHeight: scroller.clientHeight, clientWidth: scroller.clientWidth };
  const moved = before.scrollLeft !== after.scrollLeft || before.scrollTop !== after.scrollTop;
  return { status: moved ? "scrolled" : "no-movement", target, before, after };
})()`;
}

export async function tryPageScrollTo(options: {
	commandTokens: string[];
	compatibilityWorkaround?: CompatibilityWorkaround;
	cwd: string;
	effectiveArgs: string[];
	redactedArgs: string[];
	sessionMode: "auto" | "fresh";
	sessionName?: string;
	signal?: AbortSignal;
	usedImplicitSession: boolean;
}): Promise<AgentBrowserToolResult | undefined> {
	const request = getPageScrollToRequest(options.commandTokens);
	if (!request || !options.sessionName) return undefined;
	const data = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, sessionName: options.sessionName, signal: options.signal, stdin: buildPageScrollToScript(request) });
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	if (!isRecord(result) || typeof result.status !== "string") return undefined;
	const succeeded = result.status === "scrolled";
	const message = succeeded ? `Scrolled page to ${request.target}.` : `Scroll to ${request.target} completed with no observed movement (${result.status}).`;
	return buildScrollResult({ ...options, command: "scroll", message, result, scrollField: "scrollPage", scrollValue: { request, result }, succeeded });
}
