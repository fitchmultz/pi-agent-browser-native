const READ_VALUE_OPTIONS = new Set(["--filter", "--llms", "--timeout"]);
const READ_BOOLEAN_OPTIONS = new Set(["--raw", "--require-md", "--outline", "--json"]);

function validReadOption(flag: string, value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}
	if (flag === "--llms") {
		return ["index", "full"].includes(value);
	}
	if (flag === "--timeout") {
		return /^\+?\d+$/.test(value) && BigInt(value) > 0n && BigInt(value) <= 18446744073709551615n;
	}
	return true;
}

// undefined is a valid DOM read; null is invalid native syntax, which must not trigger page helpers.
export function getExplicitReadUrl(commandTokens: readonly string[]): string | null | undefined {
	if (commandTokens[0] !== "read") {
		return undefined;
	}
	let url: string | undefined;
	const options = new Set<string>();
	const tokens = commandTokens.values();
	tokens.next();
	for (const token of tokens) {
		if (READ_VALUE_OPTIONS.has(token)) {
			if (!validReadOption(token, tokens.next().value)) {
				return null;
			}
			options.add(token);
		} else if (READ_BOOLEAN_OPTIONS.has(token)) {
			options.add(token);
		} else if (token.startsWith("--") || url !== undefined) {
			return null;
		} else {
			url = token;
		}
	}
	return options.has("--llms") && options.has("--outline") ? null : url;
}
