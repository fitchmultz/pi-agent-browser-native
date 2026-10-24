import type { ProcessBrowserOutputInput, PreparedBrowserRun, BrowserRunState } from "./types.js";
import type { PageOutputPhase } from "./process-output-page-phase-contracts.js";
import type { LifecycleOutputPhase } from "./process-output-lifecycle-phase-contracts.js";
import {
	buildPageTransitionRefSnapshotInvalidation,
	getCommandRefSnapshotInvalidation,
	extractLatestRefSnapshotStateFromBatchResults,
	extractRefSnapshotFromData,
	type SessionRefSnapshot,
	type SessionRefSnapshotInvalidation,
} from "../../session-page-state.js";
import { isRecord } from "../../parsing.js";
import { runSessionCommandData } from "./session-state.js";

type BatchSnapshotDataInput = Readonly<
	Pick<PageOutputPhase, "confirmedEffects" | "presentationEnvelope">
>;
type GetTransitionInvalidationInput = Readonly<
	Pick<
		PageOutputPhase,
		| "batchCommandSteps"
		| "batchRefSnapshotState"
		| "failedTransitionReverification"
		| "nativeCommandMayHaveExecuted"
		| "presentationEnvelope"
		| "unobservedMutation"
		| "unsettledWebMcpMutation"
	>
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "callerColdLaunch" | "commandTokens">>;
	};
};
type ObservedTransitionInvalidationInput = Readonly<
	Pick<
		PageOutputPhase,
		"batchRefSnapshotState" | "failedTransitionReverification" | "nativeCommandMayHaveExecuted"
	>
> & { readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> };
type ApplyOutputTabTargetInput = Readonly<
	Pick<
		PageOutputPhase,
		"currentSessionTabTarget" | "resultingPageState" | "succeeded" | "unobservedMutation"
	>
> & {
	readonly input: Readonly<
		Pick<ProcessBrowserOutputInput, "processResult" | "sessionPageStateUpdate">
	> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens">>;
		readonly state: BrowserRunState;
	};
};
type OutputSnapshotInput = Readonly<
	Pick<
		PageOutputPhase,
		| "batchRefSnapshotState"
		| "confirmedCommand"
		| "confirmedData"
		| "diagnostics"
		| "presentationEnvelope"
		| "succeeded"
		| "unobservedMutation"
		| "unsettledWebMcpMutation"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "resolvedSemanticActionRefSnapshot">
		>;
	};
};
type SnapshotRefreshArgsInput = Readonly<
	Pick<PageOutputPhase, "batchRefSnapshotState" | "presentationEnvelope" | "succeeded">
> & { readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens">> } };
type RefreshCompleteRefsInput = Readonly<
	Pick<
		PageOutputPhase,
		| "batchRefSnapshotState"
		| "presentationEnvelope"
		| "readConfirmation"
		| "succeeded"
		| "unobservedMutation"
		| "unsettledWebMcpMutation"
	>
> & {
	readonly input: Readonly<
		Pick<ProcessBrowserOutputInput, "cwd" | "sessionPageStateUpdate" | "signal">
	> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "commandTokens" | "executionPlan">>;
		readonly state: BrowserRunState;
	};
};
type ApplyOutputSnapshotInput = Readonly<Pick<PageOutputPhase, "currentSessionTabTarget">> &
	Pick<PageOutputPhase, "currentRefSnapshot" | "currentRefSnapshotInvalidation"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "sessionPageStateUpdate">> & {
			readonly state: BrowserRunState;
		};
	};
type ReconcileOutputRefsInput = Readonly<
	Pick<
		PageOutputPhase,
		| "batchCommandSteps"
		| "browserIndependentRead"
		| "confirmedCommand"
		| "confirmedData"
		| "confirmedEffects"
		| "currentSessionTabTarget"
		| "directClose"
		| "failedTransitionReverification"
		| "nativeCommandMayHaveExecuted"
		| "nestedBatchClosed"
		| "diagnostics"
		| "presentationEnvelope"
		| "readConfirmation"
		| "resultingPageState"
		| "sessionStateKey"
		| "succeeded"
		| "unobservedMutation"
		| "unsettledWebMcpMutation"
	>
> &
	Pick<
		PageOutputPhase,
		| "batchRefSnapshotState"
		| "currentRefSnapshot"
		| "currentRefSnapshotInvalidation"
		| "networkRoutesBySession"
	> & {
		readonly input: Readonly<
			Pick<ProcessBrowserOutputInput, "cwd" | "processResult" | "sessionPageStateUpdate" | "signal">
		> & {
			readonly prepared: Readonly<
				Pick<
					PreparedBrowserRun,
					| "callerColdLaunch"
					| "commandTokens"
					| "executionPlan"
					| "resolvedSemanticActionRefSnapshot"
				>
			>;
			readonly state: BrowserRunState;
		};
	};
type RetireOutputSessionInput = Pick<PageOutputPhase, "networkRoutesBySession"> & {
	readonly input: { readonly state: BrowserRunState };
};
type ReconcileOutputPinningInput = Readonly<
	Pick<
		LifecycleOutputPhase,
		| "aboutBlankSessionMismatch"
		| "observedSessionTabTarget"
		| "openResultTabCorrection"
		| "sessionStateKey"
		| "sessionTabCorrection"
		| "succeeded"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "sessionTabPinningReason">>;
		readonly state: BrowserRunState;
	};
};
type DirectOutputSnapshotInput = Readonly<
	Pick<
		PageOutputPhase,
		"confirmedCommand" | "confirmedData" | "diagnostics" | "presentationEnvelope"
	>
> & {
	readonly input: {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "resolvedSemanticActionRefSnapshot">
		>;
	};
};

function batchSnapshotData(draft: BatchSnapshotDataInput): unknown {
	const data: unknown = draft.presentationEnvelope?.data;
	if (!Array.isArray(data)) {
		return data;
	}
	const rows: unknown[] = [];
	for (const [index, row] of data.entries()) {
		const snapshot = draft.confirmedEffects.find(
			(effect) => effect.index === index && effect.command === "snapshot",
		);
		if (snapshot && isRecord(row)) {
			rows.push({
				...row,
				command: ["snapshot"],
				result: snapshot.data,
				success: snapshot.succeeded,
			});
		} else {
			rows.push(row);
		}
	}
	return rows;
}

function getTransitionInvalidation(
	draft: GetTransitionInvalidationInput,
): SessionRefSnapshotInvalidation | undefined {
	// Missing native rows can hide a recording swap or WebMCP mutation. Planned steps are conservative fallback evidence.
	const direct = getCommandRefSnapshotInvalidation(draft.input.prepared.commandTokens);
	const planned = !Array.isArray(draft.presentationEnvelope?.data)
		? draft.batchCommandSteps
				.map(getCommandRefSnapshotInvalidation)
				.find((value) => value !== undefined)
		: undefined;
	if (draft.unobservedMutation && !draft.failedTransitionReverification) {
		return buildPageTransitionRefSnapshotInvalidation(
			"A dispatched mutation was interrupted without a final outcome. Verify the current URL and take a fresh snapshot before deciding whether to retry.",
		);
	}
	if (draft.unsettledWebMcpMutation) {
		return buildPageTransitionRefSnapshotInvalidation(
			"A detached WebMCP invocation is still pending or failed to settle and can mutate, rerender, or navigate the page, so prior snapshot refs remain invalid after URL verification. Run webmcp result or cancel, then take a fresh snapshot before using page-scoped refs.",
		);
	}
	if (
		draft.input.prepared.callerColdLaunch === true &&
		draft.input.processResult.agentBrowserStarted
	) {
		return buildPageTransitionRefSnapshotInvalidation(
			"The previous caller-owned browser stopped. Take a fresh complete snapshot before using page-scoped refs.",
		);
	}
	return observedTransitionInvalidation(draft, direct ?? planned);
}

function observedTransitionInvalidation(
	draft: ObservedTransitionInvalidationInput,
	commandInvalidation: SessionRefSnapshotInvalidation | undefined,
): SessionRefSnapshotInvalidation | undefined {
	if (
		draft.input.processResult.agentBrowserStarted &&
		draft.nativeCommandMayHaveExecuted &&
		commandInvalidation
	) {
		return commandInvalidation;
	}
	if (draft.failedTransitionReverification) {
		return buildPageTransitionRefSnapshotInvalidation(
			"A failed page transition may still have changed the page, so the prior snapshot refs were invalidated. Run snapshot -i before using page-scoped refs.",
		);
	}
	return draft.batchRefSnapshotState?.invalidation?.reason === "page-transition"
		? draft.batchRefSnapshotState.invalidation
		: undefined;
}

function applyOutputTabTarget(draft: ApplyOutputTabTargetInput, sessionName: string): void {
	const { state, sessionPageStateUpdate } = draft.input;
	if (draft.currentSessionTabTarget) {
		const tabUpdate = state.sessionPageState.applyTabTarget({
			sessionName,
			target: draft.currentSessionTabTarget,
			update: sessionPageStateUpdate,
		});
		if (!tabUpdate.applied && draft.succeeded) {
			state.sessionPageState.markPinning(sessionName, "drift");
		}
		return;
	}
	const { commandTokens } = draft.input.prepared;
	const canHaveChanged =
		draft.unobservedMutation ||
		draft.resultingPageState.pageUrlUnknown ||
		draft.resultingPageState.pageTargetMayHaveChanged;
	if (
		draft.input.processResult.agentBrowserStarted &&
		canHaveChanged &&
		!(commandTokens[0] === "session" && commandTokens[1] === "info")
	) {
		state.sessionPageState.markTabTargetUnknown({ sessionName, update: sessionPageStateUpdate });
	}
}

function outputSnapshot(draft: OutputSnapshotInput): SessionRefSnapshot | undefined {
	if (draft.unsettledWebMcpMutation || draft.unobservedMutation) {
		return;
	}
	const { prepared } = draft.input;
	if (prepared.executionPlan.commandInfo.command === "batch") {
		return draft.batchRefSnapshotState?.snapshot;
	}
	if (!draft.succeeded) {
		return;
	}
	return directOutputSnapshot(draft);
}

function snapshotRefreshArgs(
	draft: SnapshotRefreshArgsInput,
	snapshot: SessionRefSnapshot | undefined,
): readonly string[] | undefined {
	if (draft.batchRefSnapshotState?.refreshArgs) {
		return draft.batchRefSnapshotState.refreshArgs;
	}
	const { commandTokens } = draft.input.prepared;
	const data = draft.presentationEnvelope?.data;
	if (
		!draft.succeeded ||
		commandTokens[0] !== "snapshot" ||
		!isRecord(data) ||
		!isRecord(data.snapshot) ||
		snapshot
	) {
		return;
	}
	return commandTokens.filter((token) => token !== "--delta" && token !== "--full");
}

async function refreshCompleteRefs(
	draft: RefreshCompleteRefsInput,
	sessionName: string,
	snapshot: SessionRefSnapshot | undefined,
): Promise<SessionRefSnapshot | undefined> {
	const args = snapshotRefreshArgs(draft, snapshot);
	if (
		!args ||
		draft.readConfirmation?.state === "pending" ||
		draft.unsettledWebMcpMutation ||
		draft.unobservedMutation
	) {
		return snapshot;
	}
	// Native owns delta baselines; read complete refs without advancing that baseline.
	const refreshed = extractRefSnapshotFromData(
		await runSessionCommandData({
			args,
			cwd: draft.input.cwd,
			namespace: draft.input.prepared.executionPlan.namespace,
			sessionName: draft.input.prepared.executionPlan.sessionName,
			signal: draft.input.signal,
		}),
	);
	if (!refreshed) {
		draft.input.state.sessionPageState.applyRefSnapshotInvalidation({
			sessionName,
			update: draft.input.sessionPageStateUpdate,
			invalidation: buildPageTransitionRefSnapshotInvalidation(
				"The native snapshot delta did not include complete refs and the full ref read failed. Run snapshot -i before using refs.",
			),
		});
	}
	return refreshed;
}

function applyOutputSnapshot(
	draft: ApplyOutputSnapshotInput,
	sessionName: string,
	snapshot: SessionRefSnapshot | undefined,
	invalidation: SessionRefSnapshotInvalidation | undefined,
): void {
	const { sessionPageState } = draft.input.state;
	let view: {
		readonly refSnapshot?: SessionRefSnapshot;
		readonly refSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	} = sessionPageState.get(sessionName);
	if (snapshot) {
		view = sessionPageState.applyRefSnapshot({
			sessionName,
			snapshot,
			fallbackTarget: draft.currentSessionTabTarget,
			update: draft.input.sessionPageStateUpdate,
		});
	} else if (invalidation) {
		view = sessionPageState.applyRefSnapshotInvalidation({
			sessionName,
			invalidation,
			update: draft.input.sessionPageStateUpdate,
		});
	}
	draft.currentRefSnapshot = view.refSnapshot;
	draft.currentRefSnapshotInvalidation = view.refSnapshotInvalidation;
}

export async function reconcileOutputRefs(draft: ReconcileOutputRefsInput): Promise<void> {
	if (draft.input.prepared.executionPlan.commandInfo.command === "batch") {
		draft.batchRefSnapshotState = extractLatestRefSnapshotStateFromBatchResults(
			batchSnapshotData(draft),
		);
	}
	const sessionName = draft.sessionStateKey;
	if (sessionName === undefined || sessionName.length === 0 || draft.browserIndependentRead) {
		return;
	}
	if ((draft.directClose && draft.succeeded) || draft.nestedBatchClosed) {
		retireOutputSession(draft, sessionName);
		return;
	}
	const invalidation = getTransitionInvalidation(draft);
	applyOutputTabTarget(draft, sessionName);
	const snapshot = await refreshCompleteRefs(draft, sessionName, outputSnapshot(draft));
	applyOutputSnapshot(draft, sessionName, snapshot, invalidation);
}

export function retireOutputSession(draft: RetireOutputSessionInput, sessionName: string): void {
	draft.input.state.attachedSessionKeys.delete(sessionName);
	const routes = new Map(draft.networkRoutesBySession);
	routes.delete(sessionName);
	draft.networkRoutesBySession = routes;
	draft.input.state.sessionPageState.clearSession(sessionName);
	draft.input.state.closedManagedSessionNames.add(sessionName);
}

export function reconcileOutputPinning(draft: ReconcileOutputPinningInput): void {
	const sessionName = draft.sessionStateKey;
	if (sessionName === undefined || sessionName.length === 0 || !draft.succeeded) {
		return;
	}
	if (
		draft.openResultTabCorrection ||
		draft.sessionTabCorrection ||
		draft.aboutBlankSessionMismatch?.recoveryApplied === true
	) {
		draft.input.state.sessionPageState.markPinning(sessionName, "drift");
	} else if (
		draft.input.prepared.sessionTabPinningReason === "restore" &&
		draft.observedSessionTabTarget
	) {
		draft.input.state.sessionPageState.clearRestorePinning(sessionName);
	}
}

function directOutputSnapshot(draft: DirectOutputSnapshotInput): SessionRefSnapshot | undefined {
	const { prepared } = draft.input;
	if (
		prepared.executionPlan.commandInfo.command === "snapshot" ||
		draft.confirmedCommand === "snapshot"
	) {
		return extractRefSnapshotFromData(draft.confirmedData ?? draft.presentationEnvelope?.data);
	}
	return (
		prepared.resolvedSemanticActionRefSnapshot ??
		draft.diagnostics.overlayBlockerDiagnostic?.snapshot
	);
}
