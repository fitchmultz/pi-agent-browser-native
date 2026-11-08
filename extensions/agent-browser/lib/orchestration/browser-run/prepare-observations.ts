import { isRecord } from "../../parsing.js";
import { trySnapshotFilter } from "./prepare/snapshot-filter.js";
import { tryNetworkRequestsPageFilter } from "./prepare/network-page-filter.js";
import { tryContainerScroll, tryPageScrollTo } from "./prepare/scroll-shims.js";
import { inspectPreparationGeneration } from "./prepare-page-state.js";
import type { PreparationProcessFacts } from "./prepare-contracts.js";
import type { SessionPageState } from "../../session-page-state.js";
import type { ManagedSessionRestoreState } from "../../managed-session-restore.js";
import type { PersistentSessionArtifactStore } from "../../temp.js";
import type { SessionArtifactManifest } from "../../results/contracts.js";

export interface PreparationObservationOwners {
	readonly pageState: SessionPageState;
	readonly restoreState: ManagedSessionRestoreState;
	readonly update: ReturnType<SessionPageState["beginUpdate"]>;
	readonly artifactManifest?: SessionArtifactManifest | undefined;
	readonly artifactStore?: PersistentSessionArtifactStore | undefined;
}

import type { PreparationGuardContext, PreparationGuardEvidence } from "./prepare-guards.js";
import type { PrepareBrowserRunResult } from "./types.js";

function observationRequest(
	process: PreparationProcessFacts,
	restoreDisabled: () => boolean,
	context: Pick<PreparationGuardContext, "semantic" | "input" | "sessionMode">,
	evidence: PreparationGuardEvidence,
): Parameters<typeof tryNetworkRequestsPageFilter>[0] {
	const plan = context.semantic.selection.executionPlan;
	return {
		commandTokens: [...context.semantic.commandTokens],
		compatibilityWorkaround: plan.compatibilityWorkaround,
		cwd: process.cwd,
		effectiveArgs: [...evidence.redactedEffectiveArgs],
		managedSessionRestoreDisabled: restoreDisabled,
		redactedArgs: context.input.redactedArgs,
		sessionMode: context.sessionMode,
		namespace: plan.namespace,
		sessionName: plan.sessionName,
		signal: process.signal,
		usedImplicitSession: plan.usedImplicitSession,
	};
}

async function bindFilteredSnapshotGeneration(
	owners: Pick<PreparationObservationOwners, "pageState" | "restoreState">,
	process: PreparationProcessFacts,
	context: PreparationGuardContext,
): Promise<
	{ readonly refSnapshot?: PreparationGuardContext["semantic"]["resolvedSnapshot"] } | undefined
> {
	const { page, executionPlan: plan } = context.semantic.selection;
	const key = page.sessionStateKey;
	if (
		key === undefined ||
		key === "" ||
		plan.sessionName === undefined ||
		plan.sessionName === ""
	) {
		return;
	}
	const daemon = await inspectPreparationGeneration(process, {
		namespace: plan.namespace,
		sessionName: plan.sessionName,
		owned: context.session.ownedManagedSession,
	});
	owners.pageState.bindSnapshotGeneration(
		key,
		daemon.status === "active" ? daemon.generation : undefined,
	);
	if (
		context.session.ownedManagedSession &&
		daemon.status === "active" &&
		daemon.generation !== undefined &&
		daemon.generation !== ""
	) {
		owners.restoreState.recordDaemonRestoreKey(
			plan.sessionName,
			plan.namespace,
			daemon.restoreKey,
			daemon.generation,
		);
	}
	return { refSnapshot: owners.pageState.get(key).refSnapshot };
}

async function filteredSnapshot(
	owners: PreparationObservationOwners,
	process: PreparationProcessFacts,
	context: PreparationGuardContext,
	evidence: PreparationGuardEvidence,
): Promise<PrepareBrowserRunResult | undefined> {
	const { page } = context.semantic.selection;
	const result = await trySnapshotFilter({
		...observationRequest(
			process,
			() =>
				owners.restoreState.isDisabled(
					context.semantic.selection.executionPlan.sessionName,
					context.semantic.selection.executionPlan.namespace,
				),
			context,
			evidence,
		),
		artifactManifest: owners.artifactManifest,
		persistentArtifactStore: owners.artifactStore,
		previousRefSnapshot: page.priorRefSnapshotState,
		sessionStateKey: page.sessionStateKey,
		sessionPageState: owners.pageState,
		sessionPageStateUpdate: owners.update,
	});
	if (!result) {
		return undefined;
	}
	const generation = await bindFilteredSnapshotGeneration(owners, process, context);
	const toolResult =
		generation && isRecord(result.result.details)
			? { ...result.result, details: { ...result.result.details, ...generation } }
			: result.result;
	return {
		kind: "early-result",
		statePatch: {
			...evidence.statePatch,
			artifactManifest: result.artifactManifest ?? evidence.statePatch.artifactManifest,
		},
		result: toolResult,
	};
}

export async function prepareObservations(
	owners: PreparationObservationOwners,
	process: PreparationProcessFacts,
	context: PreparationGuardContext,
	evidence: PreparationGuardEvidence,
): Promise<PrepareBrowserRunResult | undefined> {
	const snapshot = await filteredSnapshot(owners, process, context, evidence);
	if (snapshot) {
		return snapshot;
	}
	const request = observationRequest(
		process,
		() =>
			owners.restoreState.isDisabled(
				context.semantic.selection.executionPlan.sessionName,
				context.semantic.selection.executionPlan.namespace,
			),
		context,
		evidence,
	);
	const network = await tryNetworkRequestsPageFilter(request);
	if (network) {
		return { kind: "early-result", statePatch: evidence.statePatch, result: network };
	}
	if (context.semantic.selection.executionPlan.startupScopedFlags.length !== 0) {
		return undefined;
	}
	const container = await tryContainerScroll(request);
	if (container) {
		return { kind: "early-result", statePatch: evidence.statePatch, result: container };
	}
	const page = await tryPageScrollTo(request);
	return page ? { kind: "early-result", statePatch: evidence.statePatch, result: page } : undefined;
}
