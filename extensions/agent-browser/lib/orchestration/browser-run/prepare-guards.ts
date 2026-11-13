import { prepareAgentBrowserSpawnArgs } from "../../process.js";
import { redactInvocationArgs } from "../../runtime-redaction.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { applyNamespaceToNextActions } from "../../results/next-actions.js";
import {
	buildSessionAwareStaleRefNextActions,
	buildSessionTabRecoveryNextActions,
} from "../../results/recovery-next-actions.js";
import { buildStaleRefPreflight } from "./session-state.js";
import type { TraceOwnership } from "../../trace-ownership.js";
import { formatAgentBrowserNextActionsText, redactRecoveryHint } from "./final-result.js";
import { validateQaAttachedPrecondition } from "./diagnostics.js";
import { findRequestedArtifactCloseViolation } from "./prompt-guards.js";
import { collectSamePageRefFreshnessPreflight } from "./prepare-refs.js";
import { getExactSensitiveStdinValues, validateStdinCommandContract } from "./prepare-input.js";
import {
	categorizedGuardFailure,
	preparationFailure,
	preparationSessionDetails,
	type PreparationStatePatch,
} from "./prepare-failure.js";
import type { PreparationSemanticResult } from "./prepare-semantic.js";
import type { PreparationDaemonPolicy } from "./prepare-daemon.js";
import type { PreparationSessionPlan } from "./prepare-session-plan.js";
import type { PreparationProcessFacts } from "./prepare-contracts.js";
import type { SessionPageState } from "../../session-page-state.js";
import type { SessionArtifactManifest } from "../../results/contracts.js";
import type { PromptPolicy } from "../../prompt-policy.js";

export interface PreparationGuardFacts extends PreparationProcessFacts {
	readonly isRestoreDisabled: () => boolean;
	readonly preserveAttachedBrowserSession?: boolean | undefined;
	readonly promptPolicy: PromptPolicy;
}

export interface PreparationGuardOwners {
	readonly pageState: SessionPageState;
	readonly update: ReturnType<SessionPageState["beginUpdate"]>;
	readonly traceOwnership: TraceOwnership;
	readonly artifactManifest?: SessionArtifactManifest | undefined;
}
import type { BrowserRunInputFields, PrepareBrowserRunResult, StaleRefPreflight } from "./types.js";

export interface PreparationGuardContext {
	readonly input: BrowserRunInputFields;
	readonly semantic: PreparationSemanticResult;
	readonly policy: PreparationDaemonPolicy;
	readonly session: PreparationSessionPlan;
	readonly chromeStartupArgs?: string | undefined;
	readonly sessionMode: "auto" | "fresh";
	readonly freshSessionName: string;
	readonly freshSessionOrdinal: number;
	readonly stdin?: string | undefined;
}

export interface PreparationGuardEvidence {
	readonly redactedEffectiveArgs: readonly string[];
	readonly redactedRecoveryHint: ReturnType<typeof redactRecoveryHint>;
	readonly statePatch: PreparationStatePatch;
	readonly exactSensitiveValues: readonly string[];
}

export function prepareGuardEvidence(
	preserveAttachedBrowserSession: boolean | undefined,
	context: Pick<
		PreparationGuardContext,
		"semantic" | "freshSessionName" | "freshSessionOrdinal" | "stdin" | "chromeStartupArgs"
	>,
): PreparationGuardEvidence {
	const plan = context.semantic.selection.executionPlan;
	return {
		redactedEffectiveArgs: redactInvocationArgs(
			prepareAgentBrowserSpawnArgs(
				plan.effectiveArgs,
				undefined,
				preserveAttachedBrowserSession,
				context.chromeStartupArgs,
			),
		),
		redactedRecoveryHint: redactRecoveryHint(plan.recoveryHint),
		statePatch:
			plan.managedSessionName === context.freshSessionName
				? { freshSessionOrdinal: context.freshSessionOrdinal + 1 }
				: {},
		exactSensitiveValues: getExactSensitiveStdinValues({
			command: plan.commandInfo.command,
			commandTokens: context.semantic.commandTokens,
			stdin: context.stdin,
		}),
	};
}

function guardRequest(
	context: Pick<PreparationGuardContext, "semantic" | "input" | "sessionMode">,
	evidence: PreparationGuardEvidence,
): Parameters<typeof categorizedGuardFailure>[1] {
	return {
		plan: context.semantic.selection.executionPlan,
		redactedArgs: context.input.redactedArgs,
		effectiveArgs: evidence.redactedEffectiveArgs,
		sessionMode: context.sessionMode,
		statePatch: evidence.statePatch,
	};
}

function planRecoveryActions(
	context: Pick<PreparationGuardContext, "semantic">,
	tabError: boolean,
): ReturnType<typeof applyNamespaceToNextActions> {
	const { selection, scrollRecovery } = context.semantic;
	const plan = selection.executionPlan;
	return applyNamespaceToNextActions(
		tabError
			? buildSessionTabRecoveryNextActions({
					kind: "tab-drift",
					resultCategory: "failure",
					sessionName: plan.sessionName,
					tabCorrection: selection.sessionTabCorrection,
					target: selection.page.priorSessionTabTarget,
				})
			: scrollRecovery?.nextActions,
		plan.namespace,
	);
}

function planFailure(
	restoreDisabled: boolean,
	context: Pick<PreparationGuardContext, "input" | "semantic" | "sessionMode">,
	evidence: PreparationGuardEvidence,
	cleanup: {
		readonly reason?: PreparationDaemonPolicy["cleanupOnlyReason"];
		readonly namespace?: string | undefined;
	},
): PrepareBrowserRunResult | undefined {
	const { selection } = context.semantic;
	const { executionPlan: plan, page } = selection;
	const error = plan.validationError;
	if (error === undefined || error === "") {
		return undefined;
	}
	const tabError =
		selection.sessionTabSelectionError !== undefined && selection.sessionTabSelectionError !== "";
	const nextActions = planRecoveryActions(context, tabError);
	const nextActionsText = formatAgentBrowserNextActionsText(nextActions);
	const input = context.input;
	return preparationFailure({
		message: [error, nextActionsText]
			.filter((text): text is string => text !== undefined)
			.join("\n\n"),
		statePatch: evidence.statePatch,
		details: {
			args: input.redactedArgs,
			compiledElectron: input.redactedCompiledElectron,
			compiledJob: input.redactedCompiledQaPreset,
			compiledQaPreset: input.redactedCompiledQaPreset,
			compiledSourceLookup: input.redactedCompiledSourceLookup,
			compiledNetworkSourceLookup: input.redactedCompiledNetworkSourceLookup,
			invalidValueFlag: plan.invalidValueFlag,
			managedSessionCleanupOnlyReason: cleanup.reason,
			...preparationSessionDetails(restoreDisabled, plan),
			...(cleanup.reason !== undefined ? { namespace: cleanup.namespace ?? "" } : {}),
			nextActions,
			sessionMode: context.sessionMode,
			sessionRecoveryHint: evidence.redactedRecoveryHint,
			startupScopedFlags: plan.startupScopedFlags,
			...(tabError
				? {
						effectiveArgs: evidence.redactedEffectiveArgs,
						sessionTabCorrection: selection.sessionTabCorrection,
					}
				: {}),
			...(page.coldManagedSession
				? { refSnapshotInvalidation: page.priorRefSnapshotInvalidation }
				: {}),
			...buildAgentBrowserResultCategoryDetails({
				args: input.redactedArgs,
				command: plan.commandInfo.command,
				errorText: error,
				failureCategory: tabError ? "tab-drift" : undefined,
				succeeded: false,
				validationError: error,
			}),
			validationError: error,
		},
	});
}

function synchronousGuards(
	traceOwnership: TraceOwnership,
	restoreDisabled: boolean,
	context: Pick<PreparationGuardContext, "input" | "semantic" | "sessionMode" | "stdin">,
	evidence: PreparationGuardEvidence,
): PrepareBrowserRunResult | undefined {
	const plan = context.semantic.selection.executionPlan;
	const traceError = traceOwnership.transitionError({
		command: plan.commandInfo.command,
		sessionKey: context.semantic.selection.page.sessionStateKey,
		subcommand: plan.commandInfo.subcommand,
	});
	const error =
		traceError !== undefined && traceError !== ""
			? traceError
			: validateStdinCommandContract({
					command: plan.commandInfo.command,
					commandTokens: context.semantic.commandTokens,
					stdin: context.stdin,
				});
	return error !== undefined && error !== ""
		? categorizedGuardFailure(restoreDisabled, guardRequest(context, evidence), {
				message: error,
				validationError: error,
			})
		: undefined;
}

async function artifactCloseGuard(
	artifactManifest: SessionArtifactManifest | undefined,
	facts: PreparationGuardFacts,
	context: Pick<PreparationGuardContext, "input" | "semantic" | "sessionMode" | "stdin">,
	evidence: PreparationGuardEvidence,
): Promise<PrepareBrowserRunResult | undefined> {
	const violation = await findRequestedArtifactCloseViolation({
		artifactManifest,
		command: context.semantic.selection.executionPlan.commandInfo.command,
		cwd: facts.cwd,
		promptPolicy: facts.promptPolicy,
	});
	return violation
		? categorizedGuardFailure(facts.isRestoreDisabled(), guardRequest(context, evidence), {
				message: violation.message,
				validationError: violation.message,
				failureCategory: "policy-blocked",
				details: { promptGuard: violation },
			})
		: undefined;
}

function staleRefFailure(
	restoreDisabled: boolean,
	context: Pick<PreparationGuardContext, "semantic" | "input" | "sessionMode">,
	evidence: PreparationGuardEvidence,
	request: { readonly stale: StaleRefPreflight; readonly includeInvalidation: boolean },
): PrepareBrowserRunResult {
	const plan = context.semantic.selection.executionPlan;
	return categorizedGuardFailure(restoreDisabled, guardRequest(context, evidence), {
		message: request.stale.message,
		failureCategory: "stale-ref",
		details: {
			nextActions: applyNamespaceToNextActions(
				buildSessionAwareStaleRefNextActions(plan.sessionName),
				plan.namespace,
			),
			refIds: request.stale.refIds,
			refSnapshot: request.stale.snapshot,
			...(request.includeInvalidation
				? { refSnapshotInvalidation: request.stale.snapshotInvalidation }
				: {}),
		},
	});
}

async function refGuards(
	owners: PreparationGuardOwners,
	facts: PreparationGuardFacts,
	context: Pick<PreparationGuardContext, "input" | "semantic" | "sessionMode" | "stdin">,
	evidence: PreparationGuardEvidence,
): Promise<PrepareBrowserRunResult | undefined> {
	const { commandTokens, resolvedSnapshot, selection } = context.semantic;
	const { page, executionPlan: plan } = selection;
	const stale = buildStaleRefPreflight({
		commandTokens,
		currentTarget: page.priorSessionTabTarget,
		requireExactTargetUrl: page.reuseConfirmedCapture,
		refSnapshot: resolvedSnapshot ?? page.priorRefSnapshotState,
		refSnapshotInvalidation: resolvedSnapshot ? undefined : page.priorRefSnapshotInvalidation,
		stdin: context.stdin,
	});
	if (stale) {
		return staleRefFailure(facts.isRestoreDisabled(), context, evidence, {
			stale,
			includeInvalidation: true,
		});
	}
	const freshness = await collectSamePageRefFreshnessPreflight({
		commandTokens,
		cwd: facts.cwd,
		currentTarget: page.priorSessionTabTarget,
		previousSnapshot:
			resolvedSnapshot || page.reuseConfirmedCapture ? undefined : page.priorRefSnapshotState,
		stdin: context.stdin,
		namespace: plan.namespace,
		sessionName: plan.sessionName,
		signal: facts.signal,
	});
	if (!freshness) {
		return undefined;
	}
	if (freshness.snapshot && page.sessionStateKey !== undefined && page.sessionStateKey !== "") {
		owners.pageState.applyRefSnapshot({
			fallbackTarget: page.priorSessionTabTarget,
			sessionName: page.sessionStateKey,
			snapshot: freshness.snapshot,
			update: owners.update,
		});
	}
	return staleRefFailure(facts.isRestoreDisabled(), context, evidence, {
		stale: freshness,
		includeInvalidation: false,
	});
}

async function qaAttachedGuard(
	facts: PreparationGuardFacts,
	context: Pick<PreparationGuardContext, "input" | "semantic" | "sessionMode" | "stdin">,
	evidence: PreparationGuardEvidence,
): Promise<PrepareBrowserRunResult | undefined> {
	if (context.input.compiledQaPreset?.checks.attached !== true) {
		return undefined;
	}
	const plan = context.semantic.selection.executionPlan;
	const failure = await validateQaAttachedPrecondition({
		cwd: facts.cwd,
		namespace: plan.namespace,
		sessionName: plan.sessionName,
		signal: facts.signal,
	});
	return failure
		? categorizedGuardFailure(facts.isRestoreDisabled(), guardRequest(context, evidence), {
				omitCommand: true,
				message: failure.error,
				validationError: failure.error,
				details: {
					compiledQaPreset: context.input.redactedCompiledQaPreset,
					nextActions: applyNamespaceToNextActions(failure.nextActions, plan.namespace),
				},
			})
		: undefined;
}

export async function validatePreparationGuards(
	owners: PreparationGuardOwners,
	facts: PreparationGuardFacts,
	context: PreparationGuardContext,
	evidence: PreparationGuardEvidence,
): Promise<PrepareBrowserRunResult | undefined> {
	const invalidPlan = planFailure(facts.isRestoreDisabled(), context, evidence, {
		reason: context.policy.cleanupOnlyReason,
		namespace: context.session.ownedManagedSession?.namespace,
	});
	if (invalidPlan) {
		return invalidPlan;
	}
	const synchronous = synchronousGuards(
		owners.traceOwnership,
		facts.isRestoreDisabled(),
		context,
		evidence,
	);
	if (synchronous) {
		return synchronous;
	}
	const artifact = await artifactCloseGuard(owners.artifactManifest, facts, context, evidence);
	if (artifact) {
		return artifact;
	}
	const refs = await refGuards(owners, facts, context, evidence);
	if (refs) {
		return refs;
	}
	return qaAttachedGuard(facts, context, evidence);
}
