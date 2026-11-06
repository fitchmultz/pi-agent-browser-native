import { getExplicitSessionPageVerificationRequirement } from "../../page-target-validation.js";
import { buildExecutionPlan, extractUpstreamCommandTokens } from "../../runtime.js";
import type { SessionRefSnapshot } from "../../session-page-observation.js";
import type { PreparationProcessFacts, PreparationSessionFacts } from "./prepare-contracts.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { buildUnsupportedScrollIntoViewRecovery } from "./diagnostics.js";
import {
	canResolveSemanticVisibleRef,
	requiresResolvedSemanticVisibleRef,
	resolveSemanticActionVisibleRefArgs,
} from "./prepare-refs.js";
import {
	callerOwnedExplicitSession,
	requiresLivePageVerification,
	verifyPreparationLivePage,
	verifyCommandLivePage,
	type PreparationPageSelection,
	type PreparationPageFacts,
	type PreparationPageRouting,
} from "./prepare-page-selection.js";
import { planHasValidationError, withPlanValidationError } from "./prepare-session-plan.js";
import type {
	BrowserRunInputFields,
	PreparedAgentBrowserArgs,
	SemanticActionVisibleRefResolution,
} from "./types.js";

export interface PreparationSemanticResult {
	readonly selection: PreparationPageSelection;
	readonly commandTokens: readonly string[];
	readonly resolution?: SemanticActionVisibleRefResolution | undefined;
	readonly resolvedSnapshot?: SessionRefSnapshot | undefined;
	readonly scrollRecovery?: ReturnType<typeof buildUnsupportedScrollIntoViewRecovery>;
}

interface SemanticRequest {
	readonly selection: PreparationPageSelection;
	readonly input: BrowserRunInputFields;
	readonly freshSessionName: string;
	readonly sessionMode: "auto" | "fresh";
	readonly preparedArgs: PreparedAgentBrowserArgs;
	readonly stdin?: string | undefined;
}

function semanticLocatorError(request: SemanticRequest, active: boolean): string {
	if (request.selection.executionPlan.managedSessionName === request.freshSessionName) {
		return "semanticAction select with locator cannot resolve a current @ref in sessionMode fresh. Open the page first, then reuse that session, or pass selector plus value/values.";
	}
	return active
		? "semanticAction select with locator could not resolve to exactly one current visible combobox/listbox ref. Run snapshot -i and retry with selector or a more specific role/name."
		: "semanticAction select with locator requires an active browser session so the wrapper can resolve a current @ref; open a page first or pass selector plus value/values.";
}

function rebuildSemanticPlan(
	facts: PreparationSessionFacts,
	request: SemanticRequest,
	resolution: SemanticActionVisibleRefResolution,
): PreparationPageSelection {
	return {
		...request.selection,
		executionPlan: buildExecutionPlan(resolution.args, {
			freshSessionName: request.freshSessionName,
			managedSessionActive: facts.managedSessionActive,
			managedSessionCompatibilityWorkaround: facts.managedSessionCompatibilityWorkaround,
			managedSessionName: facts.managedSessionName,
			managedSessionNamespace: facts.managedSessionNamespace,
			sessionMode: request.sessionMode,
		}),
	};
}

function hasLiveSemanticSession(
	managedSessionActive: boolean,
	preserveAttachedBrowserSession: boolean | undefined,
	routing: PreparationPageRouting,
	selection: PreparationPageSelection,
): boolean {
	return (
		managedSessionActive ||
		selection.page.priorSessionTabTarget !== undefined ||
		callerOwnedExplicitSession(routing.ownsSession, selection.executionPlan) ||
		preserveAttachedBrowserSession === true
	);
}

async function currentSemanticRef(
	process: PreparationProcessFacts,
	request: SemanticRequest,
): Promise<SemanticActionVisibleRefResolution | undefined> {
	const { page, executionPlan: plan } = request.selection;
	return resolveSemanticActionVisibleRefArgs({
		compiled: request.input.compiledSemanticAction,
		cwd: process.cwd,
		namespace: plan.namespace,
		refSnapshot:
			page.reuseConfirmedCapture &&
			page.priorSessionTabTargetUnknown !== true &&
			!page.priorRefSnapshotInvalidation
				? page.priorRefSnapshotState
				: undefined,
		sessionName: plan.sessionName,
		signal: process.signal,
	});
}

function finalizeSemanticResolution(
	facts: PreparationSessionFacts,
	request: SemanticRequest,
	active: boolean,
	resolution?: SemanticActionVisibleRefResolution,
): PreparationPageSelection {
	if (resolution) {
		return rebuildSemanticPlan(facts, request, resolution);
	}
	if (
		!planHasValidationError(request.selection.executionPlan) &&
		requiresResolvedSemanticVisibleRef(request.input.compiledSemanticAction)
	) {
		return {
			...request.selection,
			executionPlan: {
				...request.selection.executionPlan,
				validationError: semanticLocatorError(request, active),
			},
		};
	}
	return request.selection;
}

async function resolveSemantic(
	process: PreparationPageFacts,
	facts: PreparationSessionFacts,
	routing: PreparationPageRouting,
	request: SemanticRequest,
): Promise<{
	readonly selection: PreparationPageSelection;
	readonly resolution?: SemanticActionVisibleRefResolution | undefined;
}> {
	let selection = request.selection;
	const active = hasLiveSemanticSession(
		facts.managedSessionActive,
		process.preserveAttachedBrowserSession,
		routing,
		selection,
	);
	const mayResolve =
		selection.executionPlan.managedSessionName !== request.freshSessionName &&
		active &&
		canResolveSemanticVisibleRef(request.input.compiledSemanticAction);
	if (
		!planHasValidationError(selection.executionPlan) &&
		mayResolve &&
		requiresLivePageVerification(process.preserveAttachedBrowserSession, routing, selection)
	) {
		selection = await verifyPreparationLivePage(process, selection, {
			args: ["snapshot", "-i"],
			requirement: getExplicitSessionPageVerificationRequirement({ args: ["snapshot", "-i"] }),
		});
	}
	let resolution: SemanticActionVisibleRefResolution | undefined;
	if (!planHasValidationError(selection.executionPlan) && mayResolve) {
		resolution = await currentSemanticRef(process, { ...request, selection });
	}
	selection = finalizeSemanticResolution(facts, { ...request, selection }, active, resolution);
	return { selection, resolution };
}

export async function prepareSemanticAction(
	process: PreparationPageFacts,
	facts: PreparationSessionFacts,
	routing: PreparationPageRouting,
	request: SemanticRequest,
): Promise<PreparationSemanticResult> {
	const semantic = await resolveSemantic(process, facts, routing, request);
	let selection = semantic.selection;
	const commandTokens = extractUpstreamCommandTokens(
		semantic.resolution ? semantic.resolution.args : request.preparedArgs.args,
	);
	const scrollRecovery =
		planHasValidationError(selection.executionPlan) || selection.executionPlan.plainTextInspection
			? undefined
			: [commandTokens, ...getUpstreamEffectiveBatchSteps(commandTokens, request.stdin)]
					.map((tokens) =>
						buildUnsupportedScrollIntoViewRecovery({
							commandTokens: tokens,
							sessionName: selection.executionPlan.sessionName,
						}),
					)
					.find((recovery) => recovery !== undefined);
	if (scrollRecovery) {
		selection = {
			...selection,
			executionPlan: withPlanValidationError(selection.executionPlan, scrollRecovery.error),
		};
	}
	const snapshot = semantic.resolution?.snapshot;
	const resolvedSnapshot = snapshot
		? { ...snapshot, target: snapshot.target ?? selection.page.priorSessionTabTarget }
		: undefined;
	selection = await verifyCommandLivePage(process, routing, selection, {
		commandTokens,
		resolvedSnapshot,
		stdin: request.stdin,
	});
	return {
		selection,
		commandTokens,
		resolution: semantic.resolution,
		resolvedSnapshot,
		scrollRecovery,
	};
}
