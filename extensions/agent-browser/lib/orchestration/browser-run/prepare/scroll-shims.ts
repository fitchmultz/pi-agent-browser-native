import { isRecord } from "../../../parsing.js";
import { buildAgentBrowserResultCategoryDetails } from "../../../results/categories.js";
import { applyNamespaceToNextActions } from "../../../results/next-actions.js";
import type { CompatibilityWorkaround } from "../../../runtime-contracts.js";
import { buildScrollNoopNextActions } from "../interaction-diagnostics.js";
import { buildSessionDetailFields, runSessionCommandData } from "../session-state.js";
import type { AgentBrowserToolResult } from "../types.js";

interface ScrollPreparationOptions {
	readonly commandTokens: readonly string[];
	readonly compatibilityWorkaround?: CompatibilityWorkaround;
	readonly cwd: string;
	readonly effectiveArgs: readonly string[];
	readonly managedSessionRestoreDisabled: () => boolean;
	readonly redactedArgs: readonly string[];
	readonly sessionMode: "auto" | "fresh";
	readonly namespace?: string;
	readonly sessionName?: string;
	readonly signal?: AbortSignal;
	readonly usedImplicitSession: boolean;
}

const SCROLL_CONTAINER_DIRECTIONS = new Set(["down", "left", "right", "up"]);

function getContainerScrollRequest(
	commandTokens: readonly string[],
): { amount?: string; direction: string; selector: string } | undefined {
	if (commandTokens[0] !== "scroll" || commandTokens.length < 3 || commandTokens.length > 4) {
		return undefined;
	}
	const selector = commandTokens[1];
	const direction = commandTokens[2]?.toLowerCase();
	if (
		selector === "" ||
		selector.startsWith("-") ||
		selector.startsWith("@") ||
		SCROLL_CONTAINER_DIRECTIONS.has(selector.toLowerCase())
	) {
		return undefined;
	}
	if (!SCROLL_CONTAINER_DIRECTIONS.has(direction)) {
		return undefined;
	}
	return { amount: commandTokens[3], direction, selector };
}

function buildContainerScrollScript(request: {
	readonly amount?: string;
	readonly direction: string;
	readonly selector: string;
}): string {
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
  element.scrollBy({ [axis === "x" ? "left" : "top"]: delta, behavior: "instant" });
  const after = { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, clientWidth: element.clientWidth };
  const moved = before.scrollLeft !== after.scrollLeft || before.scrollTop !== after.scrollTop;
  return { status: moved ? "scrolled" : "no-movement", selector, direction, amount: amountToken || undefined, before, after };
})()`;
}

function buildScrollResult(options: {
	readonly command: "scroll";
	readonly compatibilityWorkaround?: CompatibilityWorkaround;
	readonly effectiveArgs: readonly string[];
	readonly managedSessionRestoreDisabled: () => boolean;
	readonly message: string;
	readonly redactedArgs: readonly string[];
	readonly result: Readonly<Record<string, unknown>>;
	readonly scrollField: "scrollContainer" | "scrollPage";
	readonly scrollValue: unknown;
	readonly sessionMode: "auto" | "fresh";
	readonly namespace?: string;
	readonly sessionName?: string;
	readonly succeeded: boolean;
	readonly usedImplicitSession: boolean;
}): AgentBrowserToolResult {
	return {
		content: [{ type: "text", text: options.message }],
		details: {
			args: options.redactedArgs,
			command: options.command,
			compatibilityWorkaround: options.compatibilityWorkaround,
			data: options.result,
			effectiveArgs: options.effectiveArgs,
			exitCode: options.succeeded ? 0 : 1,
			nextActions: options.succeeded
				? undefined
				: applyNamespaceToNextActions(
						buildScrollNoopNextActions(options.sessionName),
						options.namespace,
					),
			[options.scrollField]: options.scrollValue,
			sessionMode: options.sessionMode,
			...buildAgentBrowserResultCategoryDetails({
				args: options.effectiveArgs,
				command: options.command,
				errorText: options.succeeded ? undefined : options.message,
				succeeded: options.succeeded,
				validationError: options.succeeded ? undefined : options.message,
			}),
			...buildSessionDetailFields(
				options.sessionName,
				options.usedImplicitSession,
				options.namespace,
				options.managedSessionRestoreDisabled(),
			),
			summary: options.message,
			validationError: options.succeeded ? undefined : options.message,
		},
		isError: !options.succeeded,
	};
}

function getScrollResult(
	data: unknown,
): (Readonly<Record<string, unknown>> & { readonly status: string }) | undefined {
	const result = isRecord(data) && isRecord(data.result) ? data.result : data;
	return isRecord(result) && typeof result.status === "string"
		? { ...result, status: result.status }
		: undefined;
}

function describeScrollAmount(amount: string | undefined): string {
	return amount !== undefined && amount !== "" ? ` by ${amount}` : "";
}

export async function tryContainerScroll(
	options: ScrollPreparationOptions,
): Promise<AgentBrowserToolResult | undefined> {
	const request = getContainerScrollRequest(options.commandTokens);
	if (!request || (options.sessionName ?? "") === "") {
		return undefined;
	}
	const data = await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: buildContainerScrollScript(request),
	});
	const result = getScrollResult(data);
	if (!result) {
		return undefined;
	}
	const succeeded = result.status === "scrolled";
	const message = succeeded
		? `Scrolled container ${request.selector} ${request.direction}${describeScrollAmount(request.amount)}.`
		: `Scroll container ${request.selector} did not move (${result.status}).`;
	return buildScrollResult({
		...options,
		command: "scroll",
		message,
		result,
		scrollField: "scrollContainer",
		scrollValue: { request, result },
		succeeded,
	});
}

type PageScrollRequest =
	| { readonly target: "end" | "top" }
	| { readonly amount?: string; readonly direction: "down" | "left" | "right" | "up" };

function isPageScrollDirection(direction: string): direction is "down" | "left" | "right" | "up" {
	return (
		direction === "down" || direction === "left" || direction === "right" || direction === "up"
	);
}

function isValidScrollAmount(amount: string | undefined): boolean {
	if (amount === undefined || amount === "") {
		return true;
	}
	return /^\d+(?:\.\d+)?(?:px|%)?$/.test(amount) && Number(amount.replace(/(?:px|%)$/, "")) > 0;
}

function describePageScroll(request: PageScrollRequest): string {
	if ("target" in request) {
		return `to ${request.target}`;
	}
	return `${request.direction}${describeScrollAmount(request.amount)}`;
}

function getPageScrollToRequest(commandTokens: readonly string[]): PageScrollRequest | undefined {
	if (commandTokens[0] !== "scroll") {
		return undefined;
	}
	if (commandTokens[1]?.toLowerCase() === "to") {
		return commandTokens.length === 3 ? getPageScrollTarget(commandTokens.at(2)) : undefined;
	}
	const direction = commandTokens[1]?.toLowerCase();
	if (!isPageScrollDirection(direction) || commandTokens.length > 3) {
		return undefined;
	}
	const amount = commandTokens.at(2);
	if (!isValidScrollAmount(amount)) {
		return undefined;
	}
	return { amount, direction };
}

function getPageScrollTarget(token: string | undefined): PageScrollRequest | undefined {
	const target = token?.toLowerCase();
	return target === "end" || target === "top" ? { target } : undefined;
}

function buildPageScrollToScript(request: PageScrollRequest): string {
	return `(() => {
  const target = ${JSON.stringify("target" in request ? request.target : undefined)};
  const direction = ${JSON.stringify("direction" in request ? request.direction : undefined)};
  const amountToken = ${JSON.stringify("amount" in request ? (request.amount ?? "") : "")};
  const request = target ? { target } : { direction, amount: amountToken || undefined };
  const scroller = document.scrollingElement || document.documentElement || document.body;
  if (!scroller) return { status: "no-scroller", ...request };
  const before = { scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, scrollWidth: scroller.scrollWidth, clientHeight: scroller.clientHeight, clientWidth: scroller.clientWidth };
  const axis = direction === "left" || direction === "right" ? "x" : "y";
  const extent = axis === "x" ? scroller.clientWidth : scroller.clientHeight;
  const parseAmount = () => {
    if (!amountToken) return Math.max(1, Math.floor(extent * 0.8));
    if (amountToken.endsWith("%")) {
      const value = Number(amountToken.slice(0, -1));
      return Number.isFinite(value) ? Math.max(1, Math.floor(extent * value / 100)) : Math.max(1, Math.floor(extent * 0.8));
    }
    const pixels = Number(amountToken.replace(/px$/, ""));
    return Number.isFinite(pixels) && pixels > 0 ? Math.floor(pixels) : Math.max(1, Math.floor(extent * 0.8));
  };
  const delta = parseAmount() * (direction === "up" || direction === "left" ? -1 : 1);
  const nextTop = target === "top" ? 0 : target === "end" ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : axis === "y" ? scroller.scrollTop + delta : scroller.scrollTop;
  const nextLeft = axis === "x" ? scroller.scrollLeft + delta : scroller.scrollLeft;
  const priorBehavior = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = "auto";
  window.scrollTo(nextLeft, nextTop);
  scroller.scrollLeft = nextLeft;
  scroller.scrollTop = nextTop;
  const after = { scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, scrollWidth: scroller.scrollWidth, clientHeight: scroller.clientHeight, clientWidth: scroller.clientWidth };
  scroller.style.scrollBehavior = priorBehavior;
  const moved = before.scrollLeft !== after.scrollLeft || before.scrollTop !== after.scrollTop;
  return { status: moved ? "scrolled" : "no-movement", ...request, before, after };
})()`;
}

export async function tryPageScrollTo(
	options: ScrollPreparationOptions,
): Promise<AgentBrowserToolResult | undefined> {
	const request = getPageScrollToRequest(options.commandTokens);
	if (!request || (options.sessionName ?? "") === "") {
		return undefined;
	}
	const data = await runSessionCommandData({
		args: ["eval", "--stdin"],
		cwd: options.cwd,
		namespace: options.namespace,
		sessionName: options.sessionName,
		signal: options.signal,
		stdin: buildPageScrollToScript(request),
	});
	const result = getScrollResult(data);
	if (!result) {
		return undefined;
	}
	const succeeded = result.status === "scrolled";
	if (!succeeded && "direction" in request) {
		return undefined;
	}
	const description = describePageScroll(request);
	const message = succeeded
		? `Scrolled page ${description}.`
		: `Scroll ${description} completed with no observed movement (${result.status}).`;
	return buildScrollResult({
		...options,
		command: "scroll",
		message,
		result,
		scrollField: "scrollPage",
		scrollValue: { request, result },
		succeeded,
	});
}
