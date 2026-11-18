import { replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";

const UNSAFE_DISPLAY_DIRECTIONAL_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Strip terminal escape sequences, control characters, and directional overrides from untrusted single-line text. */
export function sanitizeRenderedSingleLine(value: string): string {
	return replaceControlCharacters(stripTerminalSequences(value)).replace(
		UNSAFE_DISPLAY_DIRECTIONAL_PATTERN,
		"",
	);
}

/** Strip terminal escape sequences, control characters, and directional overrides on one TUI display line. */
export function sanitizeRenderedLine(line: string): string {
	return replaceControlCharacters(stripTerminalSequences(line.replaceAll("\t", "    "))).replace(
		UNSAFE_DISPLAY_DIRECTIONAL_PATTERN,
		"",
	);
}

/** Extract and sanitize only the first rendered line without folding later lines into it. */
export function sanitizeRenderedFirstLine(value: string): string {
	const cleaned = stripTerminalSequences(value).replace(/\r\n?/g, "\n");
	const line = cleaned.split("\n", 1)[0] ?? cleaned;
	return replaceControlCharacters(line).replace(UNSAFE_DISPLAY_DIRECTIONAL_PATTERN, "");
}
