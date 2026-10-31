import { isRecord } from "../parsing.js";
import {
	extractExplicitNamespace,
	extractExplicitSessionName,
	scanUpstreamGlobalFlagOccurrences,
} from "../argv-grammar.js";
import { extractUpstreamCommandTokens } from "../argv-descriptor.js";
import { isCloseAllCommand } from "../command-taxonomy.js";
import { validateToolArgs } from "../runtime.js";
import type { AgentBrowserScriptBrowserParams } from "./script-types.js";

import { isStringArray } from "./shared.js";

function isOptionalTimeout(value: unknown): value is number | undefined {
	return (
		value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
	);
}

export function validateAgentBrowserScriptBrowserParams(input: unknown): {
	params?: AgentBrowserScriptBrowserParams;
	error?: string;
} {
	if (!isRecord(input)) {
		return { error: "script browser(params) requires an object." };
	}
	const unsupportedField = Object.keys(input).find(
		(field) => !["args", "stdin", "timeoutMs"].includes(field),
	);
	if (unsupportedField !== undefined) {
		return {
			error: `script browser(params) does not support ${unsupportedField}; use only args, stdin, and timeoutMs.`,
		};
	}
	const { args, stdin, timeoutMs } = input;
	if (!isStringArray(args) || args.length === 0) {
		return { error: "script browser(params).args must be a non-empty string array." };
	}
	if (stdin !== undefined && typeof stdin !== "string") {
		return { error: "script browser(params).stdin must be a string when provided." };
	}
	if (!isOptionalTimeout(timeoutMs)) {
		return { error: "script browser(params).timeoutMs must be a positive integer when provided." };
	}
	const error = validateToolArgs(args);
	return error !== undefined ? { error } : { params: { args, stdin, timeoutMs } };
}

function normalizeNamespace(namespace: string | undefined): string | undefined {
	return namespace === "" ? undefined : namespace;
}

export function bindBrowserCodeCall(
	params: AgentBrowserScriptBrowserParams,
	identity: { readonly sessionName: string; readonly namespace?: string },
): { args: string[]; stdin?: string; timeoutMs?: number } {
	const args = [...params.args];
	const explicitSession = extractExplicitSessionName(args);
	const namespaceFlags = scanUpstreamGlobalFlagOccurrences(args, "--namespace");
	const explicitNamespace = extractExplicitNamespace(args);
	if (
		(explicitSession !== undefined && explicitSession !== identity.sessionName) ||
		(namespaceFlags.length > 0 &&
			normalizeNamespace(explicitNamespace) !== normalizeNamespace(identity.namespace))
	) {
		throw new Error(
			"A code call uses one browser identity. Set session/namespace on agent_browser_code to choose another browser.",
		);
	}
	// A batch close --all row closes only this cell's own session, like a close row.
	if (isCloseAllCommand(extractUpstreamCommandTokens(args))) {
		throw new Error(
			"Run namespace-wide close --all directly with agent_browser, outside a session-scoped code call.",
		);
	}
	return {
		...params,
		args: [
			...(namespaceFlags.length === 0 ? ["--namespace", identity.namespace ?? ""] : []),
			...(explicitSession === undefined ? ["--session", identity.sessionName] : []),
			...args,
		],
	};
}
