import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { canonicalizeAgentBrowserNamespace } from "./argv-grammar.js";
import { isCloseCommand } from "./command-taxonomy.js";
import { MANAGED_SESSION_NAME_PREFIX } from "./managed-session-restore.js";
import type { ManagedSessionState } from "./runtime-contracts.js";

function namespaceFields(namespace: string | undefined): { readonly namespace?: string } {
	// Canonical namespaces have already collapsed the empty default to undefined.
	return namespace === undefined ? {} : { namespace };
}

export function resolveManagedSessionState(options: {
	readonly command?: string | undefined;
	readonly managedSessionName?: string | undefined;
	readonly managedSessionNamespace?: string | undefined;
	readonly priorActive: boolean;
	readonly priorNamespace?: string | undefined;
	readonly priorSessionName: string;
	readonly succeeded: boolean;
}): ManagedSessionState {
	const { command, managedSessionName, priorActive, priorSessionName, succeeded } = options;
	const managedNamespace = canonicalizeAgentBrowserNamespace(options.managedSessionNamespace);
	const priorNamespace = canonicalizeAgentBrowserNamespace(options.priorNamespace);
	const priorState = {
		active: priorActive,
		...namespaceFields(priorNamespace),
		sessionName: priorSessionName,
	};
	if (managedSessionName === undefined || managedSessionName.length === 0) {
		return priorState;
	}
	if (isCloseCommand(command)) {
		if (
			managedSessionName !== priorSessionName ||
			managedNamespace !== priorNamespace ||
			!succeeded
		) {
			return priorState;
		}
		return { active: false, sessionName: priorSessionName };
	}
	if (!succeeded) {
		return priorState;
	}
	return {
		active: true,
		...namespaceFields(managedNamespace),
		replacedSessionName:
			priorActive && priorSessionName !== managedSessionName ? priorSessionName : undefined,
		sessionName: managedSessionName,
	};
}

export function isRestorableManagedSessionName(
	sessionName: string,
	fallbackSessionName: string,
): boolean {
	return (
		sessionName === fallbackSessionName || sessionName.startsWith(`${fallbackSessionName}-fresh-`)
	);
}

export function getRestorableManagedSessionName(
	value: unknown,
	fallbackSessionName: string,
): string | undefined {
	return typeof value === "string" && isRestorableManagedSessionName(value, fallbackSessionName)
		? value
		: undefined;
}

export function createEphemeralSessionSeed(): string {
	return randomUUID();
}

export function createImplicitSessionName(
	sessionId: string | undefined,
	cwd: string,
	ephemeralSeed: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const normalizedSessionId = sessionId?.replaceAll("-", "").toLowerCase();
	const identity =
		normalizedSessionId !== undefined && normalizedSessionId.length > 0
			? `session:${normalizedSessionId}:cwd:${cwd}`
			: `ephemeral:${cwd}:${ephemeralSeed}`;
	if (platform === "android") {
		return `${MANAGED_SESSION_NAME_PREFIX}${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
	}
	const projectSlug = basename(cwd)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	const slug = projectSlug.length > 0 ? projectSlug : "project";
	const cwdHash = createHash("sha256").update(`cwd:${cwd}`).digest("hex").slice(0, 8);
	const sessionIdentity =
		normalizedSessionId !== undefined && normalizedSessionId.length > 0
			? `session:${normalizedSessionId}`
			: identity;
	const digest = createHash("sha256").update(sessionIdentity).digest("hex").slice(0, 12);
	return `${MANAGED_SESSION_NAME_PREFIX}${slug}-${digest}-${cwdHash}`;
}

export function createFreshSessionName(
	baseSessionName: string,
	ephemeralSeed: string,
	ordinal: number,
): string {
	const suffix = createHash("sha256")
		.update(`fresh:${baseSessionName}:${ephemeralSeed}:${ordinal}`)
		.digest("hex")
		.slice(0, 10);
	return `${baseSessionName}-fresh-${suffix}`;
}
