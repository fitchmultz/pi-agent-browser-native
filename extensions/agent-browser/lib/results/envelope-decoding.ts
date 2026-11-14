import { isRecord } from "../parsing.js";
import type { AgentBrowserEnvelope } from "./contracts.js";

export interface EnvelopeParseResult {
	readonly envelope?: AgentBrowserEnvelope;
	readonly parseError?: string;
}

function decodePluginList(
	value: Readonly<Record<string, unknown>>,
): AgentBrowserEnvelope | undefined {
	const keys = Object.keys(value);
	if (keys.length !== 1) {
		return undefined;
	}
	if (keys[0] === "plugins" && Array.isArray(value.plugins)) {
		return { success: true, data: { plugins: value.plugins } };
	}
	if (keys[0] === "plugin" && isRecord(value.plugin) && !Array.isArray(value.plugin)) {
		return { success: true, data: { plugin: value.plugin } };
	}
	return undefined;
}

export function decodeAgentBrowserEnvelope(value: unknown): EnvelopeParseResult {
	if (Array.isArray(value)) {
		return {
			envelope: {
				success: value.every((item: unknown) => !isRecord(item) || item.success !== false),
				data: value,
			},
		};
	}
	if (!isRecord(value)) {
		return { parseError: "agent-browser returned JSON, but it was not an object envelope." };
	}
	const plugin = decodePluginList(value);
	if (plugin) {
		return { envelope: plugin };
	}
	if (!("success" in value)) {
		return {
			parseError: "agent-browser returned an invalid JSON envelope: missing boolean success field.",
		};
	}
	if (typeof value.success !== "boolean") {
		return {
			parseError: "agent-browser returned an invalid JSON envelope: success field must be boolean.",
		};
	}
	if (!Object.hasOwn(value, "data")) {
		const { success, error, code, warning, ...topLevelData } = value;
		if (Object.keys(topLevelData).length > 0) {
			return {
				envelope: {
					error,
					success,
					data: topLevelData,
					...(code !== undefined ? { code } : {}),
					...(warning !== undefined ? { warning } : {}),
				},
			};
		}
	}
	return { envelope: { ...value, success: value.success } };
}
