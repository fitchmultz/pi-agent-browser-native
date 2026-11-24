export const END_OF_OPTIONS = "--";

export interface IndexedArgvToken {
	readonly index: number;
	readonly token: string;
}

export interface CommandPositionalScanOptions {
	readonly booleanFlags?: ReadonlySet<string>;
	readonly equalsValueFlags?: ReadonlySet<string>;
	readonly valueFlags?: ReadonlySet<string>;
}

function isEqualsValueFlag(
	token: string,
	equalsValueFlags: ReadonlySet<string> | undefined,
): boolean {
	if (equalsValueFlags === undefined) {
		return false;
	}
	const equalsIndex = token.indexOf("=");
	return equalsIndex > 0 && equalsValueFlags.has(token.slice(0, equalsIndex));
}

function isInvalidValueToken(
	value: string | undefined,
	options: CommandPositionalScanOptions,
): boolean {
	if (value === undefined || value === END_OF_OPTIONS) {
		return true;
	}
	return (
		options.booleanFlags?.has(value) === true ||
		options.valueFlags?.has(value) === true ||
		(value.length > 1 && value.startsWith("-"))
	);
}

/** Return 1 for a consumed unary flag, 2 for a flag+value pair, or 0 for an unrecognized/incomplete flag. */
function consumeCommandFlag(
	tokens: readonly string[],
	index: number,
	options: CommandPositionalScanOptions,
): number {
	const token = tokens[index] ?? "";
	if (
		options.booleanFlags?.has(token) === true ||
		isEqualsValueFlag(token, options.equalsValueFlags)
	) {
		return 1;
	}
	if (options.valueFlags?.has(token) !== true) {
		return 0;
	}
	return isInvalidValueToken(tokens[index + 1], options) ? 0 : 2;
}

/** Mirror upstream ArgScanner: consume declared local flags before `--`, reject unknown flags, and collect literal positionals. */
export function scanCommandPositionals(
	tokens: readonly string[],
	startIndex: number,
	options: CommandPositionalScanOptions = {},
): IndexedArgvToken[] {
	const positionals: IndexedArgvToken[] = [];
	let literal = false;
	for (let index = startIndex; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (literal) {
			positionals.push({ index, token });
			continue;
		}
		if (token === END_OF_OPTIONS) {
			literal = true;
			continue;
		}
		if (token.length > 1 && token.startsWith("-")) {
			const width = consumeCommandFlag(tokens, index, options);
			if (width === 0) {
				return [];
			}
			index += width - 1;
			continue;
		}
		positionals.push({ index, token });
	}
	return positionals;
}
