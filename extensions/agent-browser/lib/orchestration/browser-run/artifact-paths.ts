import { extname, isAbsolute } from "node:path";

import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, VALUE_FLAGS } from "../../argv-grammar.js";

const SCREENSHOT_BOOLEAN_FLAGS = new Set(["--annotate", "--full", "-f"]);
const SCREENSHOT_VALUE_FLAGS = new Set(["--screenshot-dir", "--screenshot-format", "--screenshot-quality"]);
const SCREENSHOT_IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);

function isImagePathToken(token: string): boolean {
	const extension = extname(token).toLowerCase();
	return SCREENSHOT_IMAGE_EXTENSIONS.has(extension);
}

export function getScreenshotPathTokenIndex(commandTokens: string[]): number | undefined {
	if (commandTokens[0] !== "screenshot") {
		return undefined;
	}

	const positionalIndices: number[] = [];
	for (let index = 1; index < commandTokens.length; index += 1) {
		const token = commandTokens[index];
		if (token === "--") {
			for (let positionalIndex = index + 1; positionalIndex < commandTokens.length; positionalIndex += 1) {
				positionalIndices.push(positionalIndex);
			}
			break;
		}
		if (token.startsWith("-")) {
			const normalizedToken = token.split("=", 1)[0] ?? token;
			if ((SCREENSHOT_VALUE_FLAGS.has(normalizedToken) || VALUE_FLAGS.has(normalizedToken)) && !token.includes("=")) {
				index += 1;
				continue;
			}
			if (SCREENSHOT_BOOLEAN_FLAGS.has(normalizedToken) || GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(normalizedToken)) {
				if (["true", "false"].includes(commandTokens[index + 1] ?? "")) index += 1;
				continue;
			}
		}
		positionalIndices.push(index);
	}

	if (positionalIndices.length === 0) {
		return undefined;
	}
	const candidateIndex = positionalIndices[positionalIndices.length - 1];
	const candidate = commandTokens[candidateIndex];
	if (positionalIndices.length >= 2 || isImagePathToken(candidate) || isAbsolute(candidate) || candidate.startsWith("./") || candidate.startsWith("../")) {
		return candidateIndex;
	}
	return undefined;
}
