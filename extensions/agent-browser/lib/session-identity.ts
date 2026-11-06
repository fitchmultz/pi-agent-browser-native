export interface AgentBrowserSessionIdentity {
	readonly namespace?: string | undefined;
	readonly sessionName: string;
}

const SESSION_COMPONENT_ALPHANUMERIC = /^[\p{Alphabetic}\p{Number}]$/u;

/** Mirror upstream sanitize_session_component for namespace/socket/state identity. */
export function canonicalizeAgentBrowserNamespace(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	let normalized = "";
	let lastWasSeparator = false;
	for (const character of value) {
		if (SESSION_COMPONENT_ALPHANUMERIC.test(character)) {
			normalized += character.toLowerCase();
			lastWasSeparator = false;
			continue;
		}
		if (normalized.length > 0 && !lastWasSeparator) {
			normalized += character === "_" ? "_" : "-";
			lastWasSeparator = true;
		}
	}
	const result = normalized.replace(/[-_]+$/u, "");
	return result.length > 0 ? result : undefined;
}

export function foldAgentBrowserFilesystemIdentity(
	value: string,
	platform: NodeJS.Platform,
): string {
	if (platform !== "darwin" && platform !== "win32") {
		return value;
	}
	// APFS aliases include full Unicode folds such as ß/SS and ς/Σ, not just ASCII case.
	return value.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}

export function getAgentBrowserSessionIdentityKey(
	sessionName: string,
	namespace?: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const canonicalNamespace = canonicalizeAgentBrowserNamespace(namespace);
	const canonicalSessionName = foldAgentBrowserFilesystemIdentity(sessionName, platform);
	return canonicalNamespace !== undefined
		? `${foldAgentBrowserFilesystemIdentity(canonicalNamespace, platform)}\0${canonicalSessionName}`
		: canonicalSessionName;
}

export function isAgentBrowserSessionIdentityKeyInNamespace(
	identityKey: string,
	namespace?: string,
): boolean {
	const prefix = getAgentBrowserSessionIdentityKey("", namespace);
	return prefix.length > 0 ? identityKey.startsWith(prefix) : !identityKey.includes("\0");
}

/** Namespace close retires keys in the caller's ownership index, not a copy. */
export function deleteIdentityKeysInNamespace(
	// Caller-owned identity indexes deliberately mutate under the namespace execution barrier.
	entries: Set<string> | Map<string, unknown>,
	namespace?: string,
): void {
	for (const key of entries.keys()) {
		if (isAgentBrowserSessionIdentityKeyInNamespace(key, namespace)) {
			entries.delete(key);
		}
	}
}
