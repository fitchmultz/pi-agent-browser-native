
const MANAGED_SESSION_RESTORE_KEY_PATTERN = /piab-r(?:2)?-[a-f\d]{32}/gi;
const MANAGED_SESSION_RESTORE_KEY_EXACT_PATTERN = /^piab-r2-[a-f\d]{32}$/i;
const WRAPPER_MANAGED_SESSION_PREFIX = "piab-";

export function isWrapperManagedSessionName(value: string | null | undefined): value is string {
	return typeof value === "string" && value.toLowerCase().startsWith(WRAPPER_MANAGED_SESSION_PREFIX);
}

export function isManagedSessionRestoreKey(value: string | null | undefined): value is string {
	return typeof value === "string" && MANAGED_SESSION_RESTORE_KEY_EXACT_PATTERN.test(value);
}

export function extractManagedSessionRestoreKeys(value: string): string[] {
	return [...new Set(value.match(MANAGED_SESSION_RESTORE_KEY_PATTERN)?.map((key) => key.toLowerCase()) ?? [])];
}

export function containsManagedSessionRestoreKey(value: string): boolean {
	MANAGED_SESSION_RESTORE_KEY_PATTERN.lastIndex = 0;
	return MANAGED_SESSION_RESTORE_KEY_PATTERN.test(value);
}

export function redactManagedSessionRestoreKeys(value: string): string {
	MANAGED_SESSION_RESTORE_KEY_PATTERN.lastIndex = 0;
	return value.replace(MANAGED_SESSION_RESTORE_KEY_PATTERN, "[REDACTED MANAGED STATE]");
}
