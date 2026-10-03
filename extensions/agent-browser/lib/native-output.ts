import type { AgentToolResult, ToolNamespace } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { JsonSchema } from "./json-schema.js";
import { isRecord } from "./parsing.js";
import { isBooleanFlagEnabled } from "./argv-grammar.js";
import { finalizeAgentBrowserFailure } from "./pi-tool-rendering.js";
import { isPlainTextInspectionArgs } from "./runtime.js";
import { projectAgentBrowserObservation, OBSERVATION_INLINE_MAX_CHARS } from "./results/presentation/content.js";

export const AGENT_BROWSER_NAMESPACE: ToolNamespace = {
	name: "browser",
	description: "Browser commands, bounded browser code, advanced UI checks, Electron, and optional web search.",
	instructions: "Use agent_browser for native commands and batch --bail for fixed sequences. Use agent_browser_code for a fresh bounded JS cell with a persistent browser. Enable advanced direct tools with agent_browser_tools before calling them. Check success and nextActions; structured imageObservations are capture metadata, not inline images. Optional web search is available only when configured. Full browser instructions remain in the agent_browser prompt section.",
};

export const AGENT_BROWSER_OUTPUT_SCHEMA = JsonSchema.Object({
	success: JsonSchema.Boolean(),
	resultCategory: JsonSchema.Union([JsonSchema.Literal("success"), JsonSchema.Literal("failure")]),
	data: JsonSchema.Optional(JsonSchema.Unsafe<unknown>({})),
	error: JsonSchema.Optional(JsonSchema.Unsafe<unknown>({})),
	summary: JsonSchema.Optional(JsonSchema.String()),
	nextActions: JsonSchema.Optional(JsonSchema.Array(JsonSchema.Object({}))),
}, { additionalProperties: true });

/** Final public boundary, after execution, persistence, and any requested output export. */
export async function finalizeAgentBrowserNativeResult<T extends AgentToolResult<unknown>>(result: T, input: unknown): Promise<T> {
	const finalized = finalizeAgentBrowserFailure(result, input);
	// Native help/version stays plain text; the entrypoint intentionally skips observation rendering for it.
	if (isRecord(input) && Array.isArray(input.args) && isPlainTextInspectionArgs(input.args)) return finalized;
	const succeeded = finalized.isError !== true;
	// The normal entrypoint supplies the exact bounded projection, including its complete spill.
	if (isRecord(result.structuredContent) && result.structuredContent.success === succeeded) return finalized;
	const details = isRecord(result.details) ? result.details : {};
	const observation = projectAgentBrowserObservation(details, succeeded);
	if (JSON.stringify(observation).length > OBSERVATION_INLINE_MAX_CHARS) {
		const { renderAgentBrowserObservation } = await import("./results/presentation/large-output.js");
		const rendered = await renderAgentBrowserObservation({
			content: finalized.content, details, succeeded,
			json: isRecord(input) && ("code" in input || Array.isArray(input.args) && isBooleanFlagEnabled(input.args, "--json")),
			// The caller's exact visible output stays inline (for example formatted search results); only the structured field is bounded.
			preserveContent: true,
		});
		const { artifactManifest, ...renderedResult } = rendered;
		return finalizeAgentBrowserFailure({
			...finalized, ...renderedResult,
			details: artifactManifest ? { ...details, artifactManifest } : details,
		}, input);
	}
	return { ...finalized, structuredContent: JSON.parse(JSON.stringify(observation)) as JsonValue };
}
