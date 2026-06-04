/**
 * Purpose: Keep small Electron presentation string helpers in one place.
 * Responsibilities: Trim optional probe strings and bound them to model-visible lengths.
 * Scope: Electron diagnostics/probe text helpers only; redaction and result formatting stay with their owning modules.
 * Usage: Imported by Electron host probes and browser-run Electron diagnostics.
 * Invariants/Assumptions: Empty or whitespace-only strings stay omitted, and truncation keeps the prior ellipsis behavior.
 */

export function boundElectronProbeString(value: string | undefined, maxLength = 240): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.length > maxLength ? `${trimmed.slice(0, Math.max(0, maxLength - 3))}...` : trimmed;
}
