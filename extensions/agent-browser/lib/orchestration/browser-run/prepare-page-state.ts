import { isCloseCommand } from "../../command-taxonomy.js";
import {
	buildPageTransitionRefSnapshotInvalidation,
	type SessionPageState,
} from "../../session-page-state.js";
import type {
	SessionRefSnapshot,
	SessionRefSnapshotInvalidation,
	SessionTabTarget,
} from "../../session-page-observation.js";
import { inspectManagedSessionDaemon } from "./managed-session-daemon-policy.js";
import { getSessionContextKey } from "./session-state.js";
import type { PreparationSessionPlan } from "./prepare-session-plan.js";
import type { PreparationProcessFacts } from "./prepare-contracts.js";
import type { BrowserRunState } from "./types.js";
import type { ExecutionPlan as AgentBrowserExecutionPlan } from "../../runtime-contracts.js";
import type { ManagedSessionDaemonInspection } from "./managed-session-daemon-inspection.js";

export interface PreparationPageState {
	readonly sessionStateKey?: string;
	readonly priorSessionTabTarget?: SessionTabTarget;
	readonly priorSessionTabTargetUnknown?: true;
	readonly sessionTabPinningReason?: string;
	readonly priorRefSnapshotState?: SessionRefSnapshot;
	readonly priorRefSnapshotInvalidation?: SessionRefSnapshotInvalidation;
	readonly reuseConfirmedCapture: boolean;
	readonly coldManagedSession: boolean;
}

export async function inspectPreparationGeneration(
	process: PreparationProcessFacts,
	identity: {
		readonly namespace?: string;
		readonly sessionName: string;
		readonly owned?: {
			readonly headedManagedAutosaveInterval?: string;
			readonly headedManagedAutosaveDisabled?: boolean;
		};
	},
	priorInspection?: ManagedSessionDaemonInspection,
): Promise<Awaited<ReturnType<typeof inspectManagedSessionDaemon>>> {
	return (
		priorInspection ??
		inspectManagedSessionDaemon({
			...process,
			namespace: identity.namespace,
			sessionName: identity.sessionName,
			includeGeneration: true,
			headedManagedAutosaveInterval:
				identity.owned?.headedManagedAutosaveInterval ??
				(identity.owned?.headedManagedAutosaveDisabled === true ? "0" : undefined),
		})
	);
}

function consumeConfirmedCapture(
	state: BrowserRunState,
	update: ReturnType<SessionPageState["beginUpdate"]>,
	key?: string,
): boolean {
	const confirmed =
		key !== undefined && key !== "" ? state.sessionPageState.getReadConfirmation(key) : undefined;
	if (confirmed?.refSnapshotFresh !== true) {
		return false;
	}
	// ponytail: reuse the approved capture for one call; DOM-only renames after that sample are not resampled on this use.
	const consumed = { ...confirmed };
	delete consumed.refSnapshotFresh;
	state.sessionPageState.applyReadConfirmation(consumed, update);
	state.observedBrowserEffects = { ...state.observedBrowserEffects, readConfirmation: consumed };
	return true;
}

function generationInspectionEligible(
	plan: AgentBrowserExecutionPlan,
	browserIndependent: boolean,
	page: PreparationPageState,
): boolean {
	if (browserIndependent || isCloseCommand(plan.commandInfo.command)) {
		return false;
	}
	return (
		(page.priorRefSnapshotState?.refIds.length ?? 0) > 0 &&
		page.sessionStateKey !== undefined &&
		page.sessionStateKey !== "" &&
		plan.sessionName !== undefined &&
		plan.sessionName !== ""
	);
}

async function reconcileGeneration(
	pageState: SessionPageState,
	process: PreparationProcessFacts,
	request: {
		readonly plan: AgentBrowserExecutionPlan;
		readonly session: PreparationSessionPlan;
		readonly page: PreparationPageState;
		readonly update: ReturnType<SessionPageState["beginUpdate"]>;
		readonly generationInspection?: ManagedSessionDaemonInspection;
	},
): Promise<PreparationPageState & { readonly nativeGenerationChanged: boolean }> {
	const { page, plan, session } = request;
	const snapshot = page.priorRefSnapshotState;
	const key = page.sessionStateKey;
	const name = plan.sessionName;
	if (
		!generationInspectionEligible(plan, session.browserIndependent, page) ||
		snapshot === undefined ||
		key === undefined ||
		name === undefined
	) {
		return { ...page, nativeGenerationChanged: false };
	}
	const daemon = await inspectPreparationGeneration(
		process,
		{
			namespace: plan.namespace,
			sessionName: name,
			owned: session.ownedManagedSession,
		},
		request.generationInspection,
	);
	pageState.bindSnapshotGeneration(key, daemon.status === "active" ? daemon.generation : undefined);
	const generationKnown = daemon.status === "active" && daemon.generation !== undefined;
	if (generationKnown && snapshot.generation === daemon.generation) {
		return { ...page, nativeGenerationChanged: false };
	}
	const nativeGenerationChanged = generationKnown && snapshot.generation !== undefined;
	const invalidation = buildPageTransitionRefSnapshotInvalidation(
		"The native browser generation changed or could not be verified. Take a new complete snapshot before using refs, even when the URL is unchanged.",
	);
	pageState.applyRefSnapshotInvalidation({
		invalidation,
		sessionName: key,
		update: request.update,
	});
	return {
		...page,
		nativeGenerationChanged,
		priorRefSnapshotState: undefined,
		priorRefSnapshotInvalidation: invalidation,
	};
}

function coldSessionEligible(request: {
	readonly browserIndependent: boolean;
	readonly restoreEligible: boolean;
	readonly inactive: boolean;
	readonly page: PreparationPageState & { readonly nativeGenerationChanged: boolean };
	readonly reopenPending: boolean;
	readonly preserveAttachedBrowserSession?: boolean;
}): boolean {
	const nativeCold =
		request.inactive || request.page.nativeGenerationChanged || request.reopenPending;
	return (
		!request.browserIndependent &&
		nativeCold &&
		request.restoreEligible &&
		request.preserveAttachedBrowserSession !== true
	);
}

export async function preparePageState(
	state: BrowserRunState,
	process: PreparationProcessFacts,
	request: {
		readonly plan: AgentBrowserExecutionPlan;
		readonly session: PreparationSessionPlan;
		readonly inactive: boolean;
		readonly preserveAttachedBrowserSession?: boolean;
		readonly update: ReturnType<SessionPageState["beginUpdate"]>;
		readonly generationInspection?: ManagedSessionDaemonInspection;
	},
): Promise<PreparationPageState> {
	const { plan, session, update } = request;
	const key = getSessionContextKey(plan.sessionName, plan.namespace);
	const pageState = state.sessionPageState;
	const prior = pageState.get(key);
	const page = await reconcileGeneration(pageState, process, {
		plan,
		session,
		update,
		generationInspection: request.generationInspection,
		page: {
			sessionStateKey: key,
			priorSessionTabTarget: prior.tabTarget,
			priorSessionTabTargetUnknown: prior.tabTargetUnknown,
			sessionTabPinningReason: prior.pinningReason,
			priorRefSnapshotState: prior.refSnapshot,
			priorRefSnapshotInvalidation: prior.refSnapshotInvalidation,
			reuseConfirmedCapture: consumeConfirmedCapture(state, update, key),
			coldManagedSession: false,
		},
	});
	const coldManagedSession = coldSessionEligible({
		browserIndependent: session.browserIndependent,
		...request,
		page,
		reopenPending: prior.tabReopenPending === true,
		restoreEligible:
			session.recordedOwnedSession !== undefined &&
			page.sessionTabPinningReason === "restore" &&
			session.ownedManagedSession?.restoreDecision === "enabled" &&
			!state.managedSessionRestoreState.isDisabled(plan.sessionName, plan.namespace),
	});
	if (!coldManagedSession || key === undefined || key === "") {
		return { ...page, coldManagedSession };
	}
	pageState.setTabReopenPending({ pending: true, sessionName: key, update });
	const invalidation = buildPageTransitionRefSnapshotInvalidation(
		"The managed browser shut down. Reopening its URL reloads the page; run snapshot -i before using page-scoped refs.",
	);
	pageState.applyRefSnapshotInvalidation({ invalidation, sessionName: key, update });
	return {
		...page,
		coldManagedSession,
		priorRefSnapshotState: undefined,
		priorRefSnapshotInvalidation: invalidation,
	};
}
