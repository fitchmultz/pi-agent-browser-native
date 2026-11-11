import { getAgentBrowserSessionIdentityKey } from "./argv-grammar.js";
import { isRecord } from "./parsing.js";

import type { AgentBrowserSessionIdentity } from "./session-identity.js";

export type ManagedSessionRestoreIdentity = AgentBrowserSessionIdentity;

/**
 * What this process knows about one wrapper-owned session's native daemon restore identity.
 *
 * `recorded` came from a planned or observed launch and has not been replayed from the journal.
 * `restored` was replayed from journal ancestry, so it carries the generation the running daemon
 * must still match before refs are trusted. Recording again replaces either kind.
 */
type DaemonRestoreRecord =
	| {
			readonly generation?: string | undefined;
			readonly kind: "recorded";
			readonly restoreKey: string | null;
	  }
	| { readonly generation: string; readonly kind: "restored"; readonly restoreKey: string | null };

/** Per-extension sticky restore decisions and current-process daemon provenance. */
export class ManagedSessionRestoreState {
	readonly #daemonRestoreKeys = new Map<string, DaemonRestoreRecord>();
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
		return this.#record(sessionName, namespace)?.restoreKey;
	}
	/** True only for a launch record; a journal-replayed identity is restored, not this. */
	hasUnrestoredDaemonRestoreKey(sessionName: string | undefined, namespace?: string): boolean {
		return this.#record(sessionName, namespace)?.kind === "recorded";
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
				generation:
					generation ?? (previous?.restoreKey === restoreKey ? previous.generation : undefined),
				kind: "recorded",
				restoreKey,
			});
		}
	}
	getDaemonReceipt(
		sessionName: string | undefined,
		namespace?: string,
	): { restoreKey: string | null; generation: string } | undefined {
		const record = this.#record(sessionName, namespace);
		const generation = record?.generation;
		return record !== undefined && generation !== undefined && generation.length > 0
			? { restoreKey: record.restoreKey, generation }
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
				generation: receipt.generation,
				kind: "restored",
				restoreKey: receipt.restoreKey,
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
	#record(sessionName: string | undefined, namespace?: string): DaemonRestoreRecord | undefined {
		return typeof sessionName === "string" && sessionName.length > 0
			? this.#daemonRestoreKeys.get(getAgentBrowserSessionIdentityKey(sessionName, namespace))
			: undefined;
	}
}
