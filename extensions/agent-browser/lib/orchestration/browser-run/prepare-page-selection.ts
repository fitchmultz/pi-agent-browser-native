import { isRecord } from "../../parsing.js";
import { extractUpstreamCommandTokens } from "../../runtime.js";
import { redactInvocationArgs } from "../../runtime-redaction.js";
import type { ExecutionPlan as AgentBrowserExecutionPlan } from "../../runtime-contracts.js";
import {
	getExplicitSessionPageVerificationRequirement,
	getPageTargetValidationError,
} from "../../page-target-validation.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import {
	buildStaleRefPreflight,
	ensureSessionTabTarget,
	extractStringResultField,
	runSessionCommandData,
	shouldPinSessionTabForCommand,
} from "./session-state.js";
import { validateStdinCommandContract } from "./prepare-input.js";
import { preparationFailure, preparationSessionDetails } from "./prepare-failure.js";
import { planHasValidationError, withPlanValidationError } from "./prepare-session-plan.js";
import type { PreparationPageState } from "./prepare-page-state.js";
import type { SessionPageState } from "../../session-page-state.js";
import type { PreparationProcessFacts } from "./prepare-contracts.js";

export interface PreparationPageFacts extends PreparationProcessFacts {
	readonly preserveAttachedBrowserSession?: boolean;
	readonly establishAttachedBrowserSession?: boolean;
	/** Resolves true when the caller's launch flags target a caller-owned daemon that is not running. */
	readonly callerColdLaunch?: () => Promise<boolean>;
}
import type {
	BrowserRunInputFields,
	PreparedAgentBrowserArgs,
	PreparedBrowserRun,
	PrepareBrowserRunResult,
} from "./types.js";

export interface PreparationPageRouting {
	readonly hasReadConfirmation: boolean;
	readonly ownsSession: boolean;
}

export interface PreparationPageSelection {
	readonly page: PreparationPageState;
	readonly executionPlan: AgentBrowserExecutionPlan;
	readonly sessionTabCorrection?: PreparedBrowserRun["sessionTabCorrection"];
	readonly sessionTabSelectionError?: string;
	readonly livePageVerified: boolean;
}

interface SelectionRequest {
	readonly page: PreparationPageState;
	readonly preparedArgs: PreparedAgentBrowserArgs;
	readonly stdin?: string;
	readonly input: BrowserRunInputFields;
	readonly sessionMode: "auto" | "fresh";
}

function shouldSelectRememberedTab(
	plan: AgentBrowserExecutionPlan,
	hasReadConfirmation: boolean,
	request: SelectionRequest,
): boolean {
	const tokens = extractUpstreamCommandTokens(request.preparedArgs.args);
	const knownStaleRef = buildStaleRefPreflight({
		commandTokens: tokens,
		currentTarget: request.page.priorSessionTabTarget,
		refSnapshot: request.page.priorRefSnapshotState,
		refSnapshotInvalidation: request.page.priorRefSnapshotInvalidation,
		stdin: request.stdin,
	});
	const invalidStdin = validateStdinCommandContract({
		command: plan.commandInfo.command,
		commandTokens: tokens,
		stdin: request.stdin,
	});
	const pin = shouldPinSessionTabForCommand({
		command: plan.commandInfo.command,
		commandTokens: tokens,
		pinningRequired:
			!hasReadConfirmation &&
			request.page.sessionTabPinningReason !== undefined &&
			request.input.compiledQaPreset?.checks.url === undefined,
		reopenPending: request.page.coldManagedSession,
		sessionName: plan.sessionName,
		stdin: request.stdin,
	});
	return (
		!planHasValidationError(plan) &&
		!plan.plainTextInspection &&
		!knownStaleRef &&
		invalidStdin === undefined &&
		request.page.priorSessionTabTarget !== undefined &&
		pin
	);
}

async function reopenRememberedTab(
	pageState: SessionPageState,
	process: PreparationProcessFacts,
	plan: AgentBrowserExecutionPlan,
	request: {
		readonly page: PreparationPageState;
		readonly update: ReturnType<SessionPageState["beginUpdate"]>;
	},
): Promise<{ readonly page: PreparationPageState; readonly reopened: boolean }> {
	const page = request.page;
	const target = page.priorSessionTabTarget;
	if (!page.coldManagedSession || !target) {
		return { page, reopened: true };
	}
	const data = await runSessionCommandData({
		args: ["open", target.url],
		cwd: process.cwd,
		namespace: plan.namespace,
		sessionName: plan.sessionName,
		signal: process.signal,
		timeoutMs: process.timeoutMs,
		onProcessResult: ({ agentBrowserStarted }) => {
			// A started open may navigate even when its CLI is aborted before replying.
			if (
				agentBrowserStarted &&
				page.sessionStateKey !== undefined &&
				page.sessionStateKey !== ""
			) {
				pageState.setTabReopenPending({
					pending: false,
					sessionName: page.sessionStateKey,
					update: request.update,
				});
			}
		},
	});
	if (data === undefined) {
		return { page, reopened: false };
	}
	return {
		page: {
			...page,
			priorSessionTabTarget: {
				...target,
				targetId: isRecord(data) && typeof data.targetId === "string" ? data.targetId : undefined,
			},
		},
		reopened: true,
	};
}

function abortedReopenResult(
	restoreDisabled: boolean,
	plan: AgentBrowserExecutionPlan,
	request: SelectionRequest,
): PrepareBrowserRunResult {
	const errorText =
		"agent_browser was aborted while reopening the remembered page. The requested command did not run.";
	return preparationFailure({
		message: errorText,
		details: {
			aborted: true,
			args: request.input.redactedArgs,
			command: plan.commandInfo.command,
			effectiveArgs: redactInvocationArgs(plan.effectiveArgs),
			sessionMode: request.sessionMode,
			...preparationSessionDetails(restoreDisabled, plan),
			...buildAgentBrowserResultCategoryDetails({
				args: request.input.redactedArgs,
				command: plan.commandInfo.command,
				errorText,
				failureCategory: "aborted",
				succeeded: false,
			}),
		},
	});
}

async function selectReopenedTab(
	process: PreparationProcessFacts,
	plan: AgentBrowserExecutionPlan,
	reopened: Awaited<ReturnType<typeof reopenRememberedTab>>,
): Promise<Awaited<ReturnType<typeof ensureSessionTabTarget>> | undefined> {
	if (process.signal?.aborted === true) {
		return undefined;
	}
	if (!reopened.reopened) {
		return {
			error:
				"agent-browser could not reopen the remembered URL after the managed browser shut down. Navigate explicitly, then run snapshot -i before retrying.",
		};
	}
	const target = reopened.page.priorSessionTabTarget;
	if (!target) {
		return undefined;
	}
	return ensureSessionTabTarget({
		cwd: process.cwd,
		namespace: plan.namespace,
		sessionName: plan.sessionName,
		signal: process.signal,
		target,
	});
}

function reconcileTabSelection(
	base: PreparationPageSelection,
	reopened: Awaited<ReturnType<typeof reopenRememberedTab>>,
	selection: Readonly<Awaited<ReturnType<typeof ensureSessionTabTarget>>> | undefined,
): PreparationPageSelection {
	const error = selection?.error;
	return {
		...base,
		page: reopened.page,
		sessionTabCorrection: selection?.correction,
		sessionTabSelectionError: error,
		executionPlan:
			error !== undefined && error !== ""
				? withPlanValidationError(base.executionPlan, error)
				: base.executionPlan,
	};
}

export async function preparePageSelection(
	pageState: SessionPageState,
	process: PreparationPageFacts,
	hasReadConfirmation: boolean,
	request: SelectionRequest & {
		readonly plan: AgentBrowserExecutionPlan;
		readonly restoreDisabled: boolean;
		readonly update: ReturnType<SessionPageState["beginUpdate"]>;
	},
): Promise<PreparationPageSelection | { readonly earlyResult: PrepareBrowserRunResult }> {
	const base: PreparationPageSelection = {
		page: request.page,
		executionPlan: request.plan,
		livePageVerified: false,
	};
	if (
		!shouldSelectRememberedTab(request.plan, hasReadConfirmation, request) ||
		(await probeWouldDropLaunchFlags(process))
	) {
		return base;
	}
	process.signal?.throwIfAborted();
	const reopened = await reopenRememberedTab(pageState, process, request.plan, request);
	const selection = await selectReopenedTab(process, request.plan, reopened);
	if (request.page.coldManagedSession && process.signal?.aborted === true) {
		return {
			earlyResult: abortedReopenResult(request.restoreDisabled, request.plan, request),
		};
	}
	process.signal?.throwIfAborted();
	return reconcileTabSelection(base, reopened, selection);
}

export function callerOwnedExplicitSession(
	ownsSession: boolean,
	plan: AgentBrowserExecutionPlan,
): boolean {
	return plan.sessionName !== undefined && !plan.usedImplicitSession && !ownsSession;
}

export function requiresLivePageVerification(
	preserveAttachedBrowserSession: boolean | undefined,
	routing: PreparationPageRouting,
	selection: PreparationPageSelection,
): boolean {
	return (
		!routing.hasReadConfirmation &&
		(selection.page.reuseConfirmedCapture ||
			callerOwnedExplicitSession(routing.ownsSession, selection.executionPlan) ||
			preserveAttachedBrowserSession === true)
	);
}

async function readLiveUrl(
	process: PreparationProcessFacts,
	plan: AgentBrowserExecutionPlan,
): Promise<string | undefined> {
	try {
		const data = await runSessionCommandData({
			args: ["get", "url"],
			cwd: process.cwd,
			namespace: plan.namespace,
			sessionName: plan.sessionName,
			signal: process.signal,
			throwOnFailure: true,
		});
		return extractStringResultField(data, "result") ?? extractStringResultField(data, "url");
	} catch (error) {
		if (process.signal?.aborted === true) {
			process.signal.throwIfAborted();
			throw error;
		}
		// A failed read cannot establish the target; the caller retains the requirement error.
	}
	return undefined;
}

function verifiedLivePage(
	selection: PreparationPageSelection,
	url: string,
): PreparationPageSelection {
	const target = selection.page.priorSessionTabTarget;
	return {
		...selection,
		livePageVerified: true,
		page: {
			...selection.page,
			priorSessionTabTarget: target?.url === url ? { ...target, url } : { url },
			priorSessionTabTargetUnknown: undefined,
		},
	};
}

/**
 * A cold caller-owned daemon has no page to verify. Tab selection or a `get url` probe would start
 * it without the caller's launch flags, which upstream then ignores on the requested command.
 */
async function probeWouldDropLaunchFlags(process: PreparationPageFacts): Promise<boolean> {
	return (
		process.preserveAttachedBrowserSession !== true && (await process.callerColdLaunch?.()) === true
	);
}

export async function verifyPreparationLivePage(
	process: PreparationPageFacts,
	selection: PreparationPageSelection,
	request: {
		readonly args: readonly string[];
		readonly requirement?: string;
		readonly stdin?: string;
	},
): Promise<PreparationPageSelection> {
	const plan = selection.executionPlan;
	if (
		request.requirement === undefined ||
		request.requirement === "" ||
		plan.sessionName === undefined ||
		plan.sessionName === ""
	) {
		return selection;
	}
	if (process.establishAttachedBrowserSession === true) {
		return { ...selection, executionPlan: withPlanValidationError(plan, request.requirement) };
	}
	if (await probeWouldDropLaunchFlags(process)) {
		return selection;
	}
	const url = await readLiveUrl(process, plan);
	if (url === undefined) {
		return { ...selection, executionPlan: withPlanValidationError(plan, request.requirement) };
	}
	const error = getPageTargetValidationError({
		args: request.args,
		currentPageUrl: url,
		pageUrlUnknown: false,
		stdin: request.stdin,
	});
	if (error !== undefined && error !== "") {
		return { ...selection, executionPlan: withPlanValidationError(plan, error) };
	}
	return verifiedLivePage(selection, url);
}

export async function verifyCommandLivePage(
	process: PreparationPageFacts,
	routing: PreparationPageRouting,
	selection: PreparationPageSelection,
	request: {
		readonly commandTokens: readonly string[];
		readonly resolvedSnapshot?: PreparationPageState["priorRefSnapshotState"];
		readonly stdin?: string;
	},
): Promise<PreparationPageSelection> {
	const { page, executionPlan: plan } = selection;
	const stale = buildStaleRefPreflight({
		commandTokens: request.commandTokens,
		currentTarget: page.priorSessionTabTarget,
		refSnapshot: request.resolvedSnapshot ?? page.priorRefSnapshotState,
		refSnapshotInvalidation: request.resolvedSnapshot
			? undefined
			: page.priorRefSnapshotInvalidation,
		stdin: request.stdin,
	});
	const invalidStdin = validateStdinCommandContract({
		command: plan.commandInfo.command,
		commandTokens: request.commandTokens,
		stdin: request.stdin,
	});
	const eligible =
		!planHasValidationError(plan) &&
		stale === undefined &&
		invalidStdin === undefined &&
		requiresLivePageVerification(process.preserveAttachedBrowserSession, routing, selection);
	const requirement =
		eligible && !selection.livePageVerified
			? getExplicitSessionPageVerificationRequirement({
					args: plan.effectiveArgs,
					stdin: request.stdin,
				})
			: undefined;
	return verifyPreparationLivePage(process, selection, {
		args: plan.effectiveArgs,
		requirement,
		stdin: request.stdin,
	});
}
