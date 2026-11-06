import {
	getAgentBrowserSessionIdentityKey,
	resolveAgentBrowserNamespace,
} from "../../argv-grammar.js";
import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { isBrowserIndependentRead, needsManagedSession } from "../../command-policy.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import type { ProcessRunResult } from "../../process.js";
import { nextReadConfirmation, parseReadConfirmation } from "../../read-confirmation.js";
import type { AgentBrowserEnvelope } from "../../results/contracts.js";
import {
	nativePolicyDefinitelyUnestablished,
	type SessionCommandOptions,
} from "./session-state.js";
import type { BrowserRunState, BrowserRunOptions } from "./types.js";

interface HelperObservation {
	readonly helper: SessionCommandOptions;
	readonly processResult: ProcessRunResult;
	readonly envelope?: AgentBrowserEnvelope | undefined;
}

export interface NativeHelperObserver {
	readonly allow: (helper: SessionCommandOptions) => boolean;
	readonly observe: (
		helper: SessionCommandOptions,
		result: ProcessRunResult,
		envelope?: AgentBrowserEnvelope,
	) => void;
}

function helperNamespace(helper: SessionCommandOptions): string | undefined {
	return resolveAgentBrowserNamespace(
		[],
		helper.namespace ?? getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE,
	);
}

function helperMayRun(
	helper: SessionCommandOptions,
	effects: Readonly<Record<string, unknown>> | undefined,
): boolean {
	const pending = parseReadConfirmation(effects?.readConfirmation);
	return (
		(!needsManagedSession(parseArgvDescriptor(helper.args), helper.stdin) &&
			!isBrowserIndependentRead(helper.args, helper.stdin)) ||
		pending?.state !== "pending" ||
		getAgentBrowserSessionIdentityKey(helper.sessionName ?? "default", helperNamespace(helper)) !==
			getAgentBrowserSessionIdentityKey(pending.sessionName, pending.namespace)
	);
}

function helperSucceeded(observation: HelperObservation): boolean {
	return (
		observation.envelope?.success === true &&
		observation.processResult.exitCode === 0 &&
		!observation.processResult.aborted &&
		!observation.processResult.timedOut
	);
}

function markPendingOpenTargetUnknown(
	state: BrowserRunState,
	update: BrowserRunOptions["sessionPageStateUpdate"],
	key: string,
): void {
	const invalidation = state.sessionPageState.get(key).refSnapshotInvalidation;
	state.sessionPageState.markTabTargetUnknown({ sessionName: key, update });
	if (invalidation) {
		state.sessionPageState.applyRefSnapshotInvalidation({ sessionName: key, update, invalidation });
	}
}

function applyHelperConfirmation(
	state: BrowserRunState,
	update: BrowserRunOptions["sessionPageStateUpdate"],
	observation: HelperObservation,
): void {
	const { helper, envelope, processResult } = observation;
	const namespace = helperNamespace(helper);
	const sessionName = helper.sessionName ?? "default";
	const key = getAgentBrowserSessionIdentityKey(sessionName, namespace);
	if (
		key === state.confirmationPolicyIdentity &&
		!nativePolicyDefinitelyUnestablished(processResult, envelope, helper.args)
	) {
		state.recordConfirmationPolicy(true);
	}
	const confirmation = nextReadConfirmation({
		commandTokens: helper.args,
		current: state.sessionPageState.getReadConfirmation(key),
		data: envelope?.data,
		namespace,
		sessionName,
		succeeded: helperSucceeded(observation),
	});
	if (!confirmation) {
		return;
	}
	state.sessionPageState.applyReadConfirmation(confirmation, update);
	if (helper.args[0] === "open" && confirmation.state === "pending") {
		markPendingOpenTargetUnknown(state, update, key);
	}
	state.recordReadConfirmation(confirmation);
}

export function createNativeHelperObserver(
	state: BrowserRunState,
	update: BrowserRunOptions["sessionPageStateUpdate"],
): NativeHelperObserver {
	return {
		allow: (helper) => helperMayRun(helper, state.observedBrowserEffects),
		observe: (helper, processResult, envelope) =>
			applyHelperConfirmation(state, update, { helper, processResult, envelope }),
	};
}
