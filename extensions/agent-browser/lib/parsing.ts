/**
 * Purpose: Centralize low-level boundary parsing helpers shared by runtime planning, temp-artifact lifecycle, and result rendering.
 * Responsibilities: Identify non-null object records and normalize positive-integer string configuration values.
 * Scope: Tiny generic parsing predicates only; module-specific validation and error handling stay with their owning modules.
 * Usage: Imported by agent-browser wrapper modules that parse untyped JSON, persisted state, or environment variables.
 * Invariants/Assumptions: Arrays intentionally count as records to preserve existing object-boundary semantics, and positive integers must be safe base-10 integer strings greater than zero.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parsePositiveInteger(rawValue: string | undefined): number | undefined {
	if (typeof rawValue !== "string") return undefined;
	const normalizedValue = rawValue.trim();
	if (!/^\d+$/.test(normalizedValue)) return undefined;
	const parsedValue = Number(normalizedValue);
	if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) return undefined;
	return parsedValue;
}
