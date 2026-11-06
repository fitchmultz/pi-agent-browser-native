import { getAgentBrowserSessionIdentityKey } from "./argv-grammar.js";
import { isRecord } from "./parsing.js";

import type { AgentBrowserSessionIdentity } from "./session-identity.js";

export type ManagedSessionRestoreIdentity = AgentBrowserSessionIdentity;
/** Per-extension sticky restore decisions and current-process daemon provenance. */
export class ManagedSessionRestoreState {
	readonly #daemonRestoreKeys = new Map<
		string,
		{ restoreKey: string | null; generation?: string | undefined; restored?: true }
	>();
	readonly #disabled = new Set<string>();
	clear(sessionName?: string, namespace?: string): void {
		if (sessionName !== undefined && sessionName.length > 0) {
			const identity = getAgentBrowserSessionIdentityKey(sessionName, namespace);
			this.#daemonRestoreKeys.delete(identity);
			this.#disabled.delete(identity);
		} else {
			this.#daemonRestoreKeys.clear();
			this.#disabled.clear();
		}
	}
	disable(sessionName: string | undefined, namespace?: string): void {
		if (sessionName !== undefined && sessionName.length > 0) {
			this.#disabled.add(getAgentBrowserSessionIdentityKey(sessionName, namespace));
		}
	}
	getDaemonRestoreKey(
		sessionName: string | undefined,
		namespace?: string,
	): string | null | undefined {
		return typeof sessionName === "string"
			? this.#daemonRestoreKeys.get(getAgentBrowserSessionIdentityKey(sessionName, namespace))
					?.restoreKey
			: undefined;
	}
	hasDaemonRestoreKey(sessionName: string | undefined, namespace?: string): boolean {
		return (
			typeof sessionName === "string" &&
			this.#daemonRestoreKeys.get(getAgentBrowserSessionIdentityKey(sessionName, namespace))
				?.restored !== true &&
			this.#daemonRestoreKeys.has(getAgentBrowserSessionIdentityKey(sessionName, namespace))
		);
	}
	forgetDaemonRestoreKey(sessionName: string | undefined, namespace?: string): void {
		if (sessionName !== undefined && sessionName.length > 0) {
			this.#daemonRestoreKeys.delete(getAgentBrowserSessionIdentityKey(sessionName, namespace));
		}
	}
	isDisabled(sessionName: string | undefined, namespace?: string): boolean {
		return (
			typeof sessionName === "string" &&
			this.#disabled.has(getAgentBrowserSessionIdentityKey(sessionName, namespace))
		);
	}
	recordDaemonRestoreKey(
		sessionName: string | undefined,
		namespace: string | undefined,
		restoreKey: string | null,
		generation?: string,
	): void {
		if (sessionName !== undefined && sessionName.length > 0) {
			const key = getAgentBrowserSessionIdentityKey(sessionName, namespace);
			const previous = this.#daemonRestoreKeys.get(key);
			this.#daemonRestoreKeys.set(key, {
				restoreKey,
				generation:
					generation ?? (previous?.restoreKey === restoreKey ? previous.generation : undefined),
			});
		}
	}
	getDaemonReceipt(
		sessionName: string | undefined,
		namespace?: string,
	): { restoreKey: string | null; generation: string } | undefined {
		const receipt =
			sessionName !== undefined && sessionName.length > 0
				? this.#daemonRestoreKeys.get(getAgentBrowserSessionIdentityKey(sessionName, namespace))
				: undefined;
		return receipt?.generation !== undefined && receipt.generation.length > 0
			? { restoreKey: receipt.restoreKey, generation: receipt.generation }
			: undefined;
	}
	restoreDaemonReceipt(sessionName: string, namespace: string | undefined, receipt: unknown): void {
		if (
			isRecord(receipt) &&
			typeof receipt.generation === "string" &&
			receipt.generation.length > 0 &&
			(receipt.restoreKey === null || typeof receipt.restoreKey === "string")
		) {
			this.#daemonRestoreKeys.set(getAgentBrowserSessionIdentityKey(sessionName, namespace), {
				restoreKey: receipt.restoreKey,
				generation: receipt.generation,
				restored: true,
			});
		}
	}
	replace(
		identities: readonly ManagedSessionRestoreIdentity[] = [],
		options: { readonly preserveDaemonRestoreKeys?: boolean } = {},
	): void {
		if (options.preserveDaemonRestoreKeys !== true) {
			this.#daemonRestoreKeys.clear();
		}
		this.#disabled.clear();
		for (const identity of identities) {
			this.disable(identity.sessionName, identity.namespace);
		}
	}
}
