import { extractUpstreamCommandTokens, type CommandInfo } from "../../argv-descriptor.js";
import { scanCommandPositionals } from "../../argv-grammar.js";
import { sanitizeRenderedSingleLine } from "../../display-sanitize.js";
import { isRecord } from "../../parsing.js";
import type { AgentBrowserFailureCategory, AgentBrowserNextAction } from "../contracts.js";
import { buildNextToolAction, withOptionalSessionArgs } from "../next-actions.js";
import { redactModelFacingText } from "./common.js";

const LIST_DOCUMENT_IFRAMES_SCRIPT =
	"Array.from(document.querySelectorAll('iframe')).map((frame, index) => ({ index, id: frame.id || null, name: frame.name || null, title: frame.title || null, src: frame.getAttribute('src') }))";

const NON_FRAME_FAILURE_CATEGORIES = new Set<AgentBrowserFailureCategory>([
	"aborted",
	"confirmation-required",
	"missing-binary",
	"page-wedged",
	"parse-failure",
	"policy-blocked",
	"tab-drift",
	"tab-gone",
	"validation-error",
]);

const FRAME_SELECTOR_HINT = [
	"Agent-browser frame hint: `frame <selector|@ref>` selects an iframe by CSS selector or current `@e…` ref, including cross-origin and nested iframes. CSS selectors are relative to the currently selected document.",
	"`snapshot -i` already includes interactive `@e…` refs inside cross-origin frames when present, so switching frames may not be required.",
	"Use `snapshot -i` to refresh refs or `eval --stdin` to list iframes in the current document. To retry a top-level selector, run `frame main` first.",
].join(" ");

const FRAME_MAIN_HINT = [
	"Agent-browser frame hint: switching back to `frame main` failed.",
	"Note that `snapshot -i` already includes interactive `@e…` refs inside accessible and cross-origin frames when present; inspect the active page with `snapshot -i` or list `<iframe>` elements with `eval --stdin`.",
].join(" ");

export interface FrameFailureRecovery {
	readonly actions: readonly AgentBrowserNextAction[];
	readonly hint: string;
}

function getFrameTarget(
	args: readonly string[] | undefined,
	commandInfo: CommandInfo,
): string | undefined {
	if (args !== undefined && args.length > 0) {
		const tokens = extractUpstreamCommandTokens(args);
		if (tokens[0] === "frame") {
			return scanCommandPositionals(tokens, 1)[0]?.token;
		}
	}
	return commandInfo.subcommand;
}

function sanitizeFrameText(value: string): string {
	return sanitizeRenderedSingleLine(redactModelFacingText(value)).trim();
}

function formatFrameEntry(entry: unknown): string | undefined {
	if (typeof entry === "string") {
		const text = sanitizeFrameText(entry);
		return text.length > 0 ? text : undefined;
	}
	if (!isRecord(entry)) {
		return undefined;
	}
	const parts: string[] = [];
	for (const key of ["selector", "id", "name", "title", "url", "src"] as const) {
		const raw = entry[key];
		if (typeof raw === "string") {
			const safe = sanitizeFrameText(raw);
			if (safe.length > 0) {
				parts.push(`${key}=${safe}`);
			}
		}
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function asUnknownArray(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const entries: readonly unknown[] = value;
	return entries;
}

function getReportedFramesList(errorData: unknown): readonly unknown[] | undefined {
	if (!isRecord(errorData)) {
		return undefined;
	}
	return asUnknownArray(errorData.frames) ?? asUnknownArray(errorData.availableFrames);
}

function formatReportedAvailableFrames(errorData: unknown): string | undefined {
	const rawFrames = getReportedFramesList(errorData);
	if (!rawFrames || rawFrames.length === 0) {
		return undefined;
	}
	const formatted = rawFrames
		.map(formatFrameEntry)
		.filter((item): item is string => item !== undefined);
	if (formatted.length === 0) {
		return undefined;
	}
	return `Available frames reported by upstream: ${formatted.join("; ")}.`;
}

function buildFrameFailureActions(
	targetingMain: boolean,
	sessionName: string | undefined,
): readonly AgentBrowserNextAction[] {
	const actions: AgentBrowserNextAction[] = [];
	if (!targetingMain) {
		actions.push(
			buildNextToolAction({
				args: withOptionalSessionArgs(sessionName, ["frame", "main"]),
				id: "switch-to-main-frame",
				reason:
					"Return to the main frame before inspecting iframes or retrying a top-level frame selector.",
				safety:
					"Changes only the active frame context in this session; does not mutate page content.",
			}),
		);
	}
	actions.push(
		buildNextToolAction({
			args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]),
			id: "inspect-frames-with-snapshot",
			reason:
				"Inspect current interactive refs; snapshot -i already surfaces interactive @refs inside accessible and cross-origin frames when present.",
			safety:
				"Read-only snapshot; use returned @refs directly before assuming a frame switch is required.",
		}),
		buildNextToolAction({
			args: withOptionalSessionArgs(sessionName, ["eval", "--stdin"]),
			id: "list-document-iframes",
			reason: "List iframe elements in the current document so you can verify exact selectors.",
			safety:
				"Read-only DOM inspection of the current frame; run frame main first to inspect top-level iframes.",
			stdin: LIST_DOCUMENT_IFRAMES_SCRIPT,
		}),
	);
	return actions;
}

export function buildFrameFailureRecovery(options: {
	readonly args?: readonly string[] | undefined;
	readonly commandInfo: CommandInfo;
	readonly errorData?: unknown;
	readonly failureCategory?: AgentBrowserFailureCategory | undefined;
	readonly sessionName?: string | undefined;
}): FrameFailureRecovery | undefined {
	if (options.commandInfo.command !== "frame") {
		return undefined;
	}
	if (
		options.failureCategory !== undefined &&
		NON_FRAME_FAILURE_CATEGORIES.has(options.failureCategory)
	) {
		return undefined;
	}
	const target = getFrameTarget(options.args, options.commandInfo);
	const targetingMain = target === "main";
	const reportedFrames = formatReportedAvailableFrames(options.errorData);
	const baseHint = targetingMain ? FRAME_MAIN_HINT : FRAME_SELECTOR_HINT;
	const hint = reportedFrames !== undefined ? `${baseHint} ${reportedFrames}` : baseHint;
	return {
		actions: buildFrameFailureActions(targetingMain, options.sessionName),
		hint,
	};
}
