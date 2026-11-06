import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { finalizeAgentBrowserFailure } from "../extensions/agent-browser/lib/pi-tool-rendering.js";
import { finalizeAgentBrowserNativeResult } from "../extensions/agent-browser/lib/native-output.js";

const input: AgentToolResult<{ label: string; artifactManifest: string }> & { isError: false } = {
	content: [],
	details: { label: "original", artifactManifest: "unverified input" },
	isError: false,
};
const failure = finalizeAgentBrowserFailure(input, {});
export const preservedLabel: string = failure.details.label;
export const normalizedError: boolean = failure.isError;
// @ts-expect-error: failure finalization can change a literal false flag to true
export const unchangedError: false = failure.isError;

const native = await finalizeAgentBrowserNativeResult(input, {});
export const recordDetails: Readonly<Record<string, unknown>> = native.details;
export const nativeError: boolean = native.isError;
// @ts-expect-error: native finalization does not preserve a literal false error flag
export const unchangedNativeError: false = native.isError;
// @ts-expect-error: observation compaction can replace artifactManifest with a verified receipt
export const unchangedDetails: { artifactManifest: string } = native.details;
