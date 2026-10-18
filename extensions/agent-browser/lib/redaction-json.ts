import { isSensitiveFieldName } from "./redaction-fields.js";

type RedactText = (text: string) => string;

function nextQuotePosition(options: {
	readonly char: string;
	readonly index: number;
	readonly quoteAtNext: number;
	readonly quoteAfterNext: number;
}): number {
	// Inside a string, backslash skips one character; outside, it is ordinary text.
	if (options.char === '"') {
		return options.index;
	}
	return options.char === "\\" ? options.quoteAfterNext : options.quoteAtNext;
}

function buildJsonBoundaries(text: string): Int32Array {
	// Resolve each suffix once: skip strings and balanced groups to its first unmatched closer.
	const boundaries = new Int32Array(text.length + 1).fill(-1);
	let quoteAtNext = -1;
	let quoteAfterNext = -1;
	for (let index = text.length - 1; index >= 0; index -= 1) {
		const char = text[index];
		switch (char) {
			case "}":
			case "]":
				boundaries[index] = index;
				break;
			case '"':
				boundaries[index] = quoteAtNext < 0 ? -1 : boundaries[quoteAtNext + 1];
				break;
			case "{":
			case "[": {
				const end = boundaries[index + 1];
				boundaries[index] =
					end >= 0 && text[end] === (char === "{" ? "}" : "]") ? boundaries[end + 1] : -1;
				break;
			}
			default:
				boundaries[index] = boundaries[index + 1];
		}
		const quote = nextQuotePosition({ char, index, quoteAtNext, quoteAfterNext });
		quoteAfterNext = quoteAtNext;
		quoteAtNext = quote;
	}
	return boundaries;
}

function createBalancedJsonEndFinder(text: string): (startIndex: number) => number | undefined {
	let boundaries: Int32Array | undefined;
	return (startIndex) => {
		const opener = text[startIndex];
		if (opener !== "{" && opener !== "[") {
			return;
		}
		boundaries ??= buildJsonBoundaries(text);
		const end = boundaries[startIndex + 1];
		return end >= 0 && text[end] === (opener === "{" ? "}" : "]") ? end : undefined;
	};
}

function parseJsonString(token: string): string {
	const value: unknown = JSON.parse(token);
	if (typeof value !== "string") {
		throw new Error("Expected a JSON string token");
	}
	return value;
}

function isSerializedJson(text: string): boolean {
	if (text === "[REDACTED]" || !/^\s*[[{"\d\-tfn]/.test(text)) {
		return false;
	}
	// Validate grammar only; rebuilding parsed values loses duplicates and numeric spelling.
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

function findJsonValueEnd(
	text: string,
	start: number,
	findEnd: (startIndex: number) => number | undefined,
): number | undefined {
	const balancedEnd = findEnd(start);
	if (balancedEnd !== undefined) {
		return balancedEnd + 1;
	}
	if (text[start] === '"') {
		const strings = /"(?:\\.|[^"\\])*"/g;
		strings.lastIndex = start;
		const fieldValue = strings.exec(text);
		if (fieldValue === null) {
			throw new Error("Expected a validated JSON string field value");
		}
		return parseJsonString(fieldValue[0]) === "[REDACTED]" ? undefined : strings.lastIndex;
	}
	let end = start;
	while (end < text.length && !/[\s,\]}]/.test(text[end])) {
		end += 1;
	}
	return end;
}

export function redactSerializedJson(text: string, redact: RedactText): string | undefined {
	if (!isSerializedJson(text)) {
		return;
	}
	let output = "";
	let cursor = 0;
	const findEnd = createBalancedJsonEndFinder(text);
	const strings = /"(?:\\.|[^"\\])*"/g;
	let match: RegExpExecArray | null;
	while ((match = strings.exec(text)) !== null) {
		const end = strings.lastIndex;
		const value = parseJsonString(match[0]);
		const redacted = redact(value);
		if (redacted !== value) {
			output += text.slice(cursor, match.index) + JSON.stringify(redacted);
			cursor = end;
		}
		const separator = /^\s*:\s*/.exec(text.slice(end));
		if (separator === null || !isSensitiveFieldName(value)) {
			continue;
		}
		const valueStart = end + separator[0].length;
		const valueEnd = findJsonValueEnd(text, valueStart, findEnd);
		if (valueEnd === undefined) {
			// Skip the already-redacted string as the original scanner did.
			strings.lastIndex = valueStart;
			strings.exec(text);
			continue;
		}
		output += text.slice(cursor, valueStart) + '"[REDACTED]"';
		cursor = valueEnd;
		strings.lastIndex = valueEnd;
	}
	return output + text.slice(cursor);
}

export function redactEmbeddedStructuredText(text: string, redact: RedactText): string {
	let output = "";
	let cursor = 0;
	const findEnd = createBalancedJsonEndFinder(text);
	const openers = /[[{]/g;
	let match: RegExpExecArray | null;
	while ((match = openers.exec(text)) !== null) {
		const endIndex = findEnd(match.index);
		if (endIndex === undefined) {
			continue;
		}
		const candidate = text.slice(match.index, endIndex + 1);
		const redacted = redactSerializedJson(candidate, redact) ?? candidate;
		if (redacted !== candidate) {
			output += text.slice(cursor, match.index) + redacted;
			cursor = endIndex + 1;
		}
		openers.lastIndex = endIndex + 1;
	}
	return cursor === 0 ? text : output + text.slice(cursor);
}
