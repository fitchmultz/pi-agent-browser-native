import type { AgentToolResult, ToolNamespace } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { JsonSchema } from "./json-schema.js";
import { isRecord } from "./parsing.js";
import { isJsonValue } from "./json-value.js";
import { isBooleanFlagEnabled } from "./argv-grammar.js";
import { finalizeAgentBrowserFailure, type FinalizedToolResult } from "./pi-tool-rendering.js";
import { isPlainTextInspectionArgs } from "./runtime.js";
import {
	projectAgentBrowserObservation,
	OBSERVATION_INLINE_MAX_CHARS,
	isStringArray,
} from "./results/presentation/content.js";
import { renderAgentBrowserObservation } from "./results/presentation/large-output.js";

export const AGENT_BROWSER_NAMESPACE: ToolNamespace = {
	name: "browser",
	description:
		"Browser commands, bounded browser code, advanced UI checks, Electron, and optional web search.",
	instructions:
		"Use agent_browser for native commands and batch --bail for fixed sequences. Use agent_browser_code for a fresh bounded JS cell with a persistent browser. Enable advanced direct tools with agent_browser_tools before calling them. Check success and nextActions; structured imageObservations are capture metadata, not inline images. Optional web search is available only when configured. Full browser instructions remain in the agent_browser prompt section.",
};

export const AGENT_BROWSER_OUTPUT_SCHEMA = JsonSchema.Object(
	{
		success: JsonSchema.Boolean(),
		resultCategory: JsonSchema.Union([
			JsonSchema.Literal("success"),
			JsonSchema.Literal("failure"),
		]),
		data: JsonSchema.Optional(JsonSchema.Unsafe<unknown>({})),
		error: JsonSchema.Optional(JsonSchema.Unsafe<unknown>({})),
		summary: JsonSchema.Optional(JsonSchema.String()),
		nextActions: JsonSchema.Optional(JsonSchema.Array(JsonSchema.Object({}))),
	},
	{ additionalProperties: true },
);

function inputArgs(input: unknown): readonly string[] | undefined {
	return isRecord(input) && isStringArray(input.args) ? input.args : undefined;
}

function isJsonRequest(input: unknown): boolean {
	return (
		isRecord(input) && ("code" in input || isBooleanFlagEnabled(inputArgs(input) ?? [], "--json"))
	);
}

function serializedObservation(value: unknown): JsonValue {
	// Serialization keeps native JSON omission/coercion semantics; validate the decoded unknown boundary.
	const decoded: unknown = JSON.parse(JSON.stringify(value));
	if (!isJsonValue(decoded)) {
		throw new Error("Browser observation did not serialize to a JSON value.");
	}
	return decoded;
}

/** Final public boundary, after execution, persistence, and any requested output export. */
export function finalizeAgentBrowserNativeResult(
	result: AgentToolResult<Record<string, unknown>>,
	input: unknown,
): Promise<FinalizedToolResult<Record<string, unknown>>>;
export function finalizeAgentBrowserNativeResult(
	result: AgentToolResult<unknown>,
	input: unknown,
): Promise<FinalizedToolResult>;
export async function finalizeAgentBrowserNativeResult(
	result: AgentToolResult<unknown>,
	input: unknown,
): Promise<FinalizedToolResult> {
	const finalized = finalizeAgentBrowserFailure(result, input);
	// Native help/version stays plain text; the entrypoint intentionally skips observation rendering for it.
	if (isPlainTextInspectionArgs(inputArgs(input) ?? [])) {
		return finalized;
	}
	const succeeded = !finalized.isError;
	// The normal entrypoint supplies the exact bounded projection, including its complete spill.
	if (isRecord(result.structuredContent) && result.structuredContent.success === succeeded) {
		return finalized;
	}
	const details = isRecord(result.details) ? result.details : {};
	const observation = projectAgentBrowserObservation(details, succeeded);
	if (JSON.stringify(observation).length > OBSERVATION_INLINE_MAX_CHARS) {
		const rendered = await renderAgentBrowserObservation({
			content: finalized.content,
			details,
			succeeded,
			json: isJsonRequest(input),
			// The caller's exact visible output stays inline (for example formatted search results); only the structured field is bounded.
			preserveContent: true,
		});
		const { artifactManifest, ...renderedResult } = rendered;
		return finalizeAgentBrowserFailure(
			{
				...finalized,
				...renderedResult,
				details: artifactManifest ? { ...details, artifactManifest } : details,
			},
			input,
		);
	}
	return { ...finalized, structuredContent: serializedObservation(observation) };
}
