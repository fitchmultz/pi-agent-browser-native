/**
 * Purpose: Share small ToolPresentation content helpers used by batch and compaction code.
 * Responsibilities: Extract text/image/path fields and format batch step command labels.
 * Scope: Pure ToolPresentation content helpers only.
 */

import type { ToolPresentation } from "../contracts.js";

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function getPresentationText(presentation: ToolPresentation): string {
	return presentation.content
		.filter((part): part is Extract<ToolPresentation["content"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.text.trim())
		.filter((text) => text.length > 0)
		.join("\n\n");
}

export function getPresentationImages(presentation: ToolPresentation): Array<Extract<ToolPresentation["content"][number], { type: "image" }>> {
	return presentation.content.filter(
		(part): part is Extract<ToolPresentation["content"][number], { type: "image" }> => part.type === "image",
	);
}

export function getPresentationPaths(options: {
	primaryPath?: string;
	secondaryPaths?: string[];
}): string[] {
	return options.secondaryPaths ?? (options.primaryPath ? [options.primaryPath] : []);
}

export function formatBatchStepCommand(command: string[] | undefined, index: number): string {
	return command && command.length > 0 ? command.join(" ") : `step-${index + 1}`;
}
