export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Upstream native element::parse_ref accepts @eN, ref=eN and bare eN. */
export function parseRefId(selector: string): string | undefined {
	const trimmed = selector.trim();
	const prefixed = trimmed.startsWith("@") || trimmed.startsWith("ref=");
	let candidate = trimmed;
	if (trimmed.startsWith("@")) {
		candidate = trimmed.slice(1);
	} else if (trimmed.startsWith("ref=")) {
		candidate = trimmed.slice(4);
	}
	return (prefixed ? /^e\d*$/ : /^e\d+$/).test(candidate) ? candidate : undefined;
}

export function parsePositiveInteger(rawValue?: string): number | undefined {
	if (typeof rawValue !== "string") {
		return undefined;
	}
	const normalizedValue = rawValue.trim();
	if (!/^\d+$/.test(normalizedValue)) {
		return undefined;
	}
	const parsedValue = Number(normalizedValue);
	if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
		return undefined;
	}
	return parsedValue;
}
