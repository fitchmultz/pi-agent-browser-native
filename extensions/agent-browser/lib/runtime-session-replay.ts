import {
	canonicalizeAgentBrowserNamespace,
	getAgentBrowserSessionIdentityKey,
	isAgentBrowserSessionIdentityKeyInNamespace,
} from "./argv-grammar.js";
import type { ManagedSessionState, RestoredManagedSessionState } from "./runtime-contracts.js";
import {
	decodeManagedReplayEvent,
	type ManagedReplayEvent,
	type ReplayIdentity,
} from "./runtime-replay-events.js";
import {
	isRestorableManagedSessionName,
	resolveManagedSessionState,
} from "./runtime-session-identity.js";

// One replay owns its ranks, active identity and sticky policies; no caller state is mutated.
class ManagedSessionReplay {
	readonly #fallbackSessionName: string;
	readonly #freshSessionRanks = new Map<string, number>();
	readonly #restoreDisabledIdentities = new Map<string, ReplayIdentity>();
	#state: ManagedSessionState;
	#activeRestoreRank = 0;
	#closedSessionName: string | undefined;
	#freshSessionOrdinal = 0;

	constructor(fallbackSessionName: string) {
		this.#fallbackSessionName = fallbackSessionName;
		this.#state = { active: false, sessionName: fallbackSessionName };
	}

	#rank(sessionName: string): number | undefined {
		if (sessionName === this.#fallbackSessionName) {
			return 0;
		}
		if (!isRestorableManagedSessionName(sessionName, this.#fallbackSessionName)) {
			return;
		}
		const existing = this.#freshSessionRanks.get(sessionName);
		if (existing !== undefined) {
			return existing;
		}
		const nextRank = this.#freshSessionRanks.size + 1;
		this.#freshSessionRanks.set(sessionName, nextRank);
		return nextRank;
	}

	#close(identity: ReplayIdentity): void {
		const namespace = canonicalizeAgentBrowserNamespace(identity.namespace);
		if (
			this.#rank(identity.sessionName) === undefined ||
			identity.sessionName !== this.#state.sessionName ||
			namespace !== this.#state.namespace
		) {
			return;
		}
		this.#state = { active: false, sessionName: this.#state.sessionName };
		this.#closedSessionName = identity.sessionName;
	}

	#closeAll(event: ManagedReplayEvent): void {
		if (!event.closeAllApplied || !this.#state.active) {
			return;
		}
		const restoredKey = getAgentBrowserSessionIdentityKey(
			this.#state.sessionName,
			this.#state.namespace,
		);
		if (isAgentBrowserSessionIdentityKeyInNamespace(restoredKey, event.namespace)) {
			this.#close(this.#state);
		}
	}

	#applyCompletion(event: ManagedReplayEvent, identity: ReplayIdentity, rank: number): void {
		if (event.closesSession) {
			if (event.closeSucceeded) {
				this.#restoreDisabledIdentities.delete(
					getAgentBrowserSessionIdentityKey(identity.sessionName, identity.namespace),
				);
				this.#close(identity);
			}
			return;
		}
		if (event.succeeded && rank < this.#activeRestoreRank) {
			return;
		}
		this.#state = resolveManagedSessionState({
			command: event.command,
			managedSessionName: identity.sessionName,
			managedSessionNamespace: identity.namespace,
			priorActive: this.#state.active,
			priorNamespace: this.#state.namespace,
			priorSessionName: this.#state.sessionName,
			succeeded: event.succeeded,
		});
		if (event.succeeded && this.#state.active) {
			this.#activeRestoreRank = rank;
			this.#closedSessionName = undefined;
		}
	}

	apply(event: ManagedReplayEvent): void {
		for (const identity of event.cleanupSessions) {
			this.#close(identity);
		}
		this.#closeAll(event);
		// Sticky restore policy includes explicit current-managed rows, even without lifecycle replay.
		if (event.restoreDisabled && event.detailSessionName !== undefined) {
			const identity = { namespace: event.namespace, sessionName: event.detailSessionName };
			this.#restoreDisabledIdentities.set(
				getAgentBrowserSessionIdentityKey(identity.sessionName, identity.namespace),
				identity,
			);
		}
		if (event.managedSessionName === undefined || event.managedSessionName.length === 0) {
			return;
		}
		const rank = this.#rank(event.managedSessionName);
		if (rank === undefined) {
			return;
		}
		this.#freshSessionOrdinal = Math.max(this.#freshSessionOrdinal, rank);
		this.#applyCompletion(
			event,
			{ namespace: event.namespace, sessionName: event.managedSessionName },
			rank,
		);
	}

	result(): RestoredManagedSessionState {
		const closedSessionName = this.#closedSessionName;
		return {
			...this.#state,
			...(closedSessionName !== undefined && closedSessionName.length > 0
				? { closedSessionName }
				: {}),
			freshSessionOrdinal: this.#freshSessionOrdinal,
			managedSessionRestoreDisabledIdentities: [...this.#restoreDisabledIdentities.values()],
		};
	}
}

export function restoreManagedSessionStateFromBranch(
	branch: readonly unknown[],
	fallbackSessionName: string,
): RestoredManagedSessionState {
	const replay = new ManagedSessionReplay(fallbackSessionName);
	for (const entry of branch) {
		const event = decodeManagedReplayEvent(entry, fallbackSessionName);
		if (event) {
			replay.apply(event);
		}
	}
	return replay.result();
}
