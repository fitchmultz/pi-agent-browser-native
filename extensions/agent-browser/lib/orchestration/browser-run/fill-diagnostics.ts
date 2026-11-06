import { boundElectronProbeString } from "../../electron/cdp.js";
import { isRecord } from "../../parsing.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import { withOptionalSessionArgs } from "../../results/next-actions.js";
import type { SessionRefSnapshot } from "../../session-page-state.js";
import { runSessionCommandData } from "./session-state.js";
import type { FillVerificationDiagnostic } from "./observation-types.js";

const ELECTRON_FILL_VERIFICATION_TIMEOUT_MS = 2_000;

interface FillInvocation {
	readonly expected: string;
	readonly refId?: string;
	readonly selector: string;
}

function getTopLevelFillInvocation(commandTokens: readonly string[]): FillInvocation | undefined {
	if (commandTokens[0] !== "fill" || commandTokens.length < 3) {
		return undefined;
	}
	const selector = commandTokens.at(1);
	const expected = commandTokens.slice(2).join(" ");
	if (selector === undefined || selector === "" || expected.length === 0) {
		return undefined;
	}
	const refId = selector.match(/^@?(e\d+)$/)?.at(1);
	return { expected, ...(refId !== undefined && refId !== "" ? { refId } : {}), selector };
}

function shouldVerifyContenteditableFill(
	fill: FillInvocation,
	refSnapshot: SessionRefSnapshot | undefined,
): boolean {
	if (fill.refId === undefined || fill.refId === "") {
		return false;
	}
	const ref = refSnapshot?.refs?.[fill.refId];
	return (
		ref !== undefined &&
		ref.isContentEditable === true &&
		(ref.role === "generic" || ref.role === "unknown" || ref.role === "textbox")
	);
}

export function buildFillVerificationNextActions(
	diagnostic: FillVerificationDiagnostic,
	sessionName: string | undefined,
): AgentBrowserNextAction[] {
	return [
		{
			id: "inspect-after-fill-verification",
			params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) },
			reason:
				"Refresh the UI after a fill that reported success but did not appear to update the target.",
			safety: "Read-only snapshot; use current refs before retrying.",
			tool: "agent_browser",
		},
		{
			id: "verify-filled-value",
			params: {
				args: withOptionalSessionArgs(sessionName, ["get", diagnostic.method, diagnostic.selector]),
			},
			reason: `Check the target ${diagnostic.method} directly before submitting or creating files.`,
			safety: "Read-only check; selector may still be stale if the UI rerendered.",
			tool: "agent_browser",
		},
	];
}

function extractFillVerificationValue(data: unknown): string | undefined {
	if (typeof data === "string") {
		return data;
	}
	if (!isRecord(data)) {
		return undefined;
	}
	if (typeof data.value === "string") {
		return data.value;
	}
	return typeof data.result === "string" ? data.result : undefined;
}

function buildFillMismatch(
	fill: FillInvocation,
	actual: string,
	method: "text" | "value",
	sessionName: string,
): FillVerificationDiagnostic {
	const reason = method === "text" ? "contenteditable-fill-mismatch" : "value-fill-mismatch";
	const actualPreview =
		actual.length > 0
			? `"${boundElectronProbeString(actual, 80) ?? "undefined"}"`
			: `an empty ${method}`;
	const diagnostic: FillVerificationDiagnostic = {
		actual: actual.length > 0 ? boundElectronProbeString(actual, 160) : "",
		expected: boundElectronProbeString(fill.expected, 160) ?? fill.expected,
		method,
		nextActionIds: [],
		reason,
		selector: fill.selector,
		status: "mismatch",
		summary: `Fill verification warning: fill ${fill.selector} reported success, but get ${method} returned ${actualPreview}.`,
	};
	return {
		...diagnostic,
		nextActionIds: buildFillVerificationNextActions(diagnostic, sessionName).map(
			(action) => action.id,
		),
	};
}

export async function collectFillVerificationDiagnostic(options: {
	readonly commandTokens: readonly string[];
	readonly cwd: string;
	readonly forceValueVerification?: boolean;
	readonly namespace?: string | undefined;
	readonly refSnapshot?: SessionRefSnapshot | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<FillVerificationDiagnostic | undefined> {
	const fill = getTopLevelFillInvocation(options.commandTokens);
	if (!fill || options.sessionName === undefined || options.sessionName === "") {
		return undefined;
	}
	const contenteditable = shouldVerifyContenteditableFill(fill, options.refSnapshot);
	if (!contenteditable && options.forceValueVerification !== true) {
		return undefined;
	}
	const method = contenteditable ? "text" : "value";
	let valueData: unknown;
	try {
		valueData = await runSessionCommandData({
			args: ["get", method, fill.selector],
			cwd: options.cwd,
			namespace: options.namespace,
			sessionName: options.sessionName,
			signal: options.signal,
			timeoutMs: ELECTRON_FILL_VERIFICATION_TIMEOUT_MS,
		});
	} catch {
		return undefined;
	}
	const actual = extractFillVerificationValue(valueData);
	return actual === undefined || actual === fill.expected
		? undefined
		: buildFillMismatch(fill, actual, method, options.sessionName);
}

export function formatFillVerificationText(
	diagnostic: FillVerificationDiagnostic | undefined,
): string | undefined {
	if (!diagnostic) {
		return undefined;
	}
	const actual =
		diagnostic.actual !== undefined
			? `actual "${diagnostic.actual}"`
			: `actual ${diagnostic.method} unavailable`;
	const recovery =
		diagnostic.reason === "contenteditable-fill-mismatch"
			? "Contenteditable fill may append or prepend instead of replacing. Re-run snapshot -i, then prefer focus/click plus keyboard shortcut selection or direct keyboard insertion only after verifying the editor state."
			: "Re-run snapshot -i, then prefer click/focus plus keyboard type for custom quick-input controls before submitting.";
	return `${diagnostic.summary}\nExpected: "${diagnostic.expected}"; ${actual}.\nNext: ${recovery}`;
}
