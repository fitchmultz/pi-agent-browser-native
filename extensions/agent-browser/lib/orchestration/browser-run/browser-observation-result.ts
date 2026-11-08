import { isBooleanFlagEnabled } from "../../argv-grammar.js";
import { isRecord } from "../../parsing.js";
import { redactSensitiveValue } from "../../runtime-redaction.js";
import { getNativeWebMcpCatalog } from "../../webmcp-observation.js";
import { formatWebMcpCatalogUpdate } from "../../results/presentation/common.js";
import { getSessionContextKey } from "./session-state.js";
import type { AgentBrowserToolResult } from "./types.js";
import type { SessionPageState } from "../../session-page-state.js";

export interface BrowserObservationState {
	readonly observedBrowserEffects?: Readonly<Record<string, unknown>>;
	readonly sessionPageState: { readonly get: SessionPageState["get"] };
}

function appendCatalogNotice(
	result: AgentBrowserToolResult,
	catalog: Readonly<Record<string, unknown>>,
	data: unknown,
	args: readonly string[],
): AgentBrowserToolResult {
	if (
		isBooleanFlagEnabled(args, "--json") ||
		JSON.stringify(getNativeWebMcpCatalog(data)) === JSON.stringify(catalog)
	) {
		return result;
	}
	const notice = formatWebMcpCatalogUpdate(catalog);
	const content = [...result.content];
	const first = content.at(0);
	if (first?.type === "text") {
		content[0] = { ...first, text: `${first.text}\n\n${notice}` };
	} else {
		content.push({ type: "text", text: notice });
	}
	return { ...result, content };
}

function addCatalog(
	result: AgentBrowserToolResult,
	catalog: Readonly<Record<string, unknown>> | undefined,
	args: readonly string[],
): AgentBrowserToolResult {
	if (!catalog) {
		return result;
	}
	const redacted = redactSensitiveValue(catalog);
	if (!isRecord(redacted)) {
		throw new Error("Browser catalog redaction did not preserve its object shape.");
	}
	const details = isRecord(result.details) ? result.details : undefined;
	return appendCatalogNotice(
		{ ...result, details: { ...details, webMcpCatalog: redacted } },
		redacted,
		details?.data,
		args,
	);
}

function addFailureError(result: AgentBrowserToolResult): AgentBrowserToolResult {
	const details = isRecord(result.details) ? result.details : undefined;
	if (result.isError !== true || details?.error !== undefined) {
		return result;
	}
	return {
		...result,
		details: {
			...details,
			error:
				details?.validationError ??
				details?.summary ??
				result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
		},
	};
}

function addPendingPageState(
	result: AgentBrowserToolResult,
	state: BrowserObservationState,
): AgentBrowserToolResult {
	const details = isRecord(result.details) ? result.details : undefined;
	const key = getSessionContextKey(
		typeof details?.sessionName === "string" ? details.sessionName : undefined,
		typeof details?.namespace === "string" ? details.namespace : undefined,
	);
	const page = state.sessionPageState.get(key);
	if (page.tabReopenPending === undefined) {
		return result;
	}
	return {
		...result,
		details: {
			...details,
			sessionTabReopenPending: page.tabReopenPending,
			...(page.refSnapshotInvalidation
				? { refSnapshotInvalidation: page.refSnapshotInvalidation }
				: {}),
		},
	};
}

export function projectBrowserObservationResult(options: {
	readonly result: AgentBrowserToolResult;
	readonly catalog?: Readonly<Record<string, unknown>> | undefined;
	readonly args: readonly string[];
	readonly state: BrowserObservationState;
}): AgentBrowserToolResult {
	let result = options.result;
	const details = isRecord(result.details) ? result.details : undefined;
	const confirmation = options.state.observedBrowserEffects?.readConfirmation;
	if (details?.readConfirmation === undefined && Boolean(confirmation)) {
		result = { ...result, details: { ...details, readConfirmation: confirmation } };
	}
	result = addFailureError(addCatalog(result, options.catalog, options.args));
	return addPendingPageState(result, options.state);
}
