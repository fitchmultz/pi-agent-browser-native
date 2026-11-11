import { isCloseCommand } from "./command-taxonomy.js";
import { deleteIdentityKeysInNamespace } from "./session-identity.js";

export type TraceOwner = "profiler" | "trace";

export interface TraceCommandFacts {
	readonly command: string | undefined;
	readonly sessionKey: string | undefined;
	readonly subcommand: string | undefined;
}

function getTraceOwner(command: string | undefined): TraceOwner | undefined {
	return command === "trace" || command === "profiler" ? command : undefined;
}

/**
 * The recording tool the wrapper believes owns a session: none, `trace`, or `profiler`.
 *
 * Ownership moves only through `applyTransition`: a successful `start` takes the session,
 * a successful `stop` releases it when the recorded owner matches, and a successful close
 * clears it. `transitionError` reports the one illegal pair — starting a tool while the
 * other already owns the session, and stopping a tool that does not own it. Keeping the
 * guard with the data makes the recorded owner and its rejection indivisible.
 */
export class TraceOwnership {
	private readonly owners = new Map<string, TraceOwner>();

	/** Explains a start or stop that contradicts the recorded owner; undefined when it may proceed. */
	transitionError(facts: TraceCommandFacts): string | undefined {
		const owner = getTraceOwner(facts.command);
		const sessionKey = facts.sessionKey;
		if (
			owner === undefined ||
			sessionKey === undefined ||
			sessionKey.length === 0 ||
			(facts.subcommand !== "start" && facts.subcommand !== "stop")
		) {
			return undefined;
		}
		const activeOwner = this.owners.get(sessionKey);
		if (activeOwner === undefined || activeOwner === owner) {
			return undefined;
		}
		return facts.subcommand === "start"
			? `Wrapper believes ${activeOwner} tracing is active for session ${sessionKey}; stop ${activeOwner} before starting ${owner}.`
			: `Wrapper believes tracing for session ${sessionKey} is owned by ${activeOwner}; run ${activeOwner} stop instead of ${owner} stop.`;
	}

	/** Applies one completed call; failed calls and unrelated commands leave ownership unchanged. */
	applyTransition(facts: TraceCommandFacts & { readonly succeeded: boolean }): void {
		const sessionKey = facts.sessionKey;
		if (sessionKey === undefined || sessionKey.length === 0 || !facts.succeeded) {
			return;
		}
		if (isCloseCommand(facts.command)) {
			this.owners.delete(sessionKey);
			return;
		}
		const owner = getTraceOwner(facts.command);
		if (owner === undefined) {
			return;
		}
		if (facts.subcommand === "start") {
			this.owners.set(sessionKey, owner);
		}
		if (facts.subcommand === "stop" && this.owners.get(sessionKey) === owner) {
			this.owners.delete(sessionKey);
		}
	}

	clearSession(sessionKey: string): void {
		this.owners.delete(sessionKey);
	}

	clearNamespace(namespace?: string): void {
		deleteIdentityKeysInNamespace(this.owners, namespace);
	}

	reset(): void {
		this.owners.clear();
	}
}
