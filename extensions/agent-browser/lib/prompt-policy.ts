import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	extractPromptRequestedArtifacts,
	type PromptRequestedArtifact,
} from "./prompt-artifacts.js";
import { isRecord } from "./parsing.js";

export type { PromptRequestedArtifact };

export interface PromptPolicy {
	readonly requestedArtifacts: readonly PromptRequestedArtifact[];
}

export function buildPromptPolicy(prompt: string): PromptPolicy {
	return {
		requestedArtifacts: extractPromptRequestedArtifacts(prompt),
	};
}

export function getMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((item: unknown) => {
			if (!isRecord(item)) {
				return "";
			}
			return item.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

/** Raw prompt intent survives compaction/context edits; only restoration walks ancestry. */
export function getLatestUserMessage(
	manager: Pick<ExtensionContext["sessionManager"], "getLeafId" | "getEntry">,
): UserMessage | undefined {
	let id = manager.getLeafId();
	const seen = new Set<string>();
	while (id !== null) {
		if (typeof id !== "string" || seen.has(id)) {
			throw new Error("Latest user prompt ancestry is invalid or cyclic.");
		}
		seen.add(id);
		const entry = manager.getEntry(id);
		if (
			!entry ||
			entry.id !== id ||
			(entry.parentId !== null && typeof entry.parentId !== "string")
		) {
			throw new Error("Latest user prompt ancestry is incomplete.");
		}
		if (entry.type === "message" && entry.message.role === "user") {
			return entry.message;
		}
		id = entry.parentId;
	}
	return undefined;
}
