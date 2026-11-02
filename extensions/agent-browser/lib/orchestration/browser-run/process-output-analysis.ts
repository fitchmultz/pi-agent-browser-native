import type {
	ProcessBrowserOutputInput,
	PreparedBrowserRun,
	BrowserRunState,
	NavigationSummary,
} from "./types.js";
import type { PublicationOutputPhase } from "./process-output-publication-phase-contracts.js";
import type { ToolPresentationObservation } from "../../results/presentation/observation-contracts.js";
import {
	analyzeNetworkSourceLookupResults,
	analyzeSourceLookupResults,
	redactNetworkSourceLookupAnalysis,
} from "../../input-modes/lookups.js";
import {
	analyzeQaPresetResults,
	analyzeQaPresetTimeout,
	buildQaCompactFailureText,
	buildQaCompactPassText,
	extractQaPageContext,
} from "../../input-modes/job.js";
import { extractNavigationSummaryFromData } from "./session-state.js";
import {
	collectQaAttachedTarget,
	formatQaAttachedTargetText,
	getEvalResultWarning,
	getEvalStdinHint,
	getSourceLookupElectronContext,
} from "./diagnostics.js";

type AnalyzeQaEvidenceInput = Readonly<Pick<PublicationOutputPhase, "presentationEnvelope">> & {
	readonly presentation: ToolPresentationObservation;
} & Pick<PublicationOutputPhase, "qaPreset"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
			readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledQaPreset">>;
		};
	};
type CollectQaAttachmentInput = Readonly<Pick<PublicationOutputPhase, "currentSessionTabTarget">> &
	Pick<PublicationOutputPhase, "qaAttachedTarget"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
			readonly prepared: Readonly<
				Pick<PreparedBrowserRun, "compiledQaPreset" | "executionPlan" | "priorSessionTabTarget">
			>;
		};
	};
type LookupSourceEvidenceInput = Readonly<
	Pick<PublicationOutputPhase, "currentSessionTabTarget" | "operationCwd" | "presentationEnvelope">
> &
	Pick<PublicationOutputPhase, "sourceLookup"> & {
		readonly input: {
			readonly prepared: Readonly<
				Pick<PreparedBrowserRun, "compiledSourceLookup" | "executionPlan" | "priorSessionTabTarget">
			>;
			readonly state: BrowserRunState;
		};
	};
type LookupNetworkSourceEvidenceInput = Readonly<
	Pick<PublicationOutputPhase, "operationCwd" | "presentationEnvelope">
> &
	Pick<PublicationOutputPhase, "networkSourceLookup"> & {
		readonly input: {
			readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledNetworkSourceLookup">>;
		};
	};
type PrependLookupSummaryInput = Readonly<Pick<PublicationOutputPhase, "presentation">>;
type CompactFailedQaInput = Readonly<
	Pick<PublicationOutputPhase, "presentationEnvelope" | "qaAttachedTarget" | "qaPreset">
> &
	Pick<PublicationOutputPhase, "presentation" | "succeeded"> & {
		readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledQaPreset">> };
	};
type CompactPassedQaInput = Readonly<
	Pick<
		PublicationOutputPhase,
		"presentationEnvelope" | "qaAttachedTarget" | "qaPreset" | "succeeded"
	>
> &
	Pick<PublicationOutputPhase, "presentation"> & {
		readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledQaPreset">> };
	};
type AnalyzeOutputChecksInput = Readonly<
	Pick<PublicationOutputPhase, "currentSessionTabTarget" | "operationCwd" | "presentationEnvelope">
> &
	Pick<
		PublicationOutputPhase,
		| "networkSourceLookup"
		| "presentation"
		| "qaAttachedTarget"
		| "qaPreset"
		| "sourceLookup"
		| "succeeded"
	> & {
		readonly input: Readonly<
			Pick<ProcessBrowserOutputInput, "cwd" | "processResult" | "signal">
		> & {
			readonly prepared: Readonly<
				Pick<
					PreparedBrowserRun,
					| "compiledNetworkSourceLookup"
					| "compiledQaPreset"
					| "compiledSourceLookup"
					| "executionPlan"
					| "priorSessionTabTarget"
				>
			>;
			readonly state: BrowserRunState;
		};
	};
type AttachedDiagnosticsNoticeInput = {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledQaPreset">> };
};
type RenderQaBannerInput = Readonly<
	Pick<PublicationOutputPhase, "presentation" | "qaAttachedTarget" | "qaPreset">
> &
	AttachedDiagnosticsNoticeInput;
type RenderAttachedQaBannerInput = Readonly<
	Pick<PublicationOutputPhase, "presentation" | "qaAttachedTarget" | "qaPreset" | "succeeded">
> &
	Pick<PublicationOutputPhase, "managedSessionOutcome"> &
	AttachedDiagnosticsNoticeInput;
type EvalPageUrlInput = Readonly<
	Pick<PublicationOutputPhase, "currentSessionTabTarget" | "sessionStateKey">
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "priorSessionTabTarget">>;
		readonly state: BrowserRunState;
	};
};
type CollectEvalGuidanceInput = Readonly<
	Pick<
		PublicationOutputPhase,
		| "currentSessionTabTarget"
		| "navigationSummary"
		| "presentationEnvelope"
		| "readConfirmationEvent"
		| "sessionStateKey"
	>
> &
	Pick<PublicationOutputPhase, "evalResultWarning" | "evalStdinHint"> & {
		readonly input: Readonly<Pick<ProcessBrowserOutputInput, "sessionPageStateUpdate">> & {
			readonly prepared: Readonly<
				Pick<PreparedBrowserRun, "executionPlan" | "priorSessionTabTarget" | "runtimeToolStdin">
			>;
			readonly state: BrowserRunState;
		};
	};

function analyzeQaEvidence(draft: AnalyzeQaEvidenceInput): void {
	const compiled = draft.input.prepared.compiledQaPreset;
	if (!compiled) {
		return;
	}
	let qa = draft.input.processResult.timedOut ? analyzeQaPresetTimeout(compiled) : undefined;
	qa ??= analyzeQaPresetResults(draft.presentationEnvelope?.data, compiled);
	if (qa?.passed === true && draft.presentation.resultCategory === "failure") {
		qa = {
			...qa,
			passed: false,
			summary: draft.presentation.summary,
			failedChecks: [...qa.failedChecks, draft.presentation.summary],
		};
	}
	draft.qaPreset = qa;
}

async function collectQaAttachment(draft: CollectQaAttachmentInput): Promise<void> {
	if (draft.input.prepared.compiledQaPreset?.checks.attached !== true) {
		return;
	}
	const { prepared, cwd, signal } = draft.input;
	draft.qaAttachedTarget = await collectQaAttachedTarget({
		currentTarget: draft.currentSessionTabTarget ?? prepared.priorSessionTabTarget,
		cwd,
		namespace: prepared.executionPlan.namespace,
		sessionName: prepared.executionPlan.sessionName,
		signal,
	});
}

async function lookupSourceEvidence(draft: LookupSourceEvidenceInput): Promise<void> {
	const { prepared } = draft.input;
	const compiled = prepared.compiledSourceLookup;
	if (!compiled) {
		return;
	}
	const electronContext = getSourceLookupElectronContext({
		currentTarget: draft.currentSessionTabTarget,
		electronLaunchRecords: draft.input.state.electronLaunchRecords,
		namespace: prepared.executionPlan.namespace,
		priorTarget: prepared.priorSessionTabTarget,
		sessionName: prepared.executionPlan.sessionName,
	});
	draft.sourceLookup = await analyzeSourceLookupResults(
		draft.presentationEnvelope?.data,
		compiled,
		draft.operationCwd,
		{ electronContext, workspaceRoot: draft.operationCwd },
	);
}

async function lookupNetworkSourceEvidence(draft: LookupNetworkSourceEvidenceInput): Promise<void> {
	const compiled = draft.input.prepared.compiledNetworkSourceLookup;
	if (!compiled) {
		return;
	}
	draft.networkSourceLookup = redactNetworkSourceLookupAnalysis(
		await analyzeNetworkSourceLookupResults(
			draft.presentationEnvelope?.data,
			compiled,
			draft.operationCwd,
		),
	);
}

function prependLookupSummary(draft: PrependLookupSummaryInput, text: string): void {
	const first = draft.presentation.content.at(0);
	if (first?.type === "text") {
		draft.presentation.content[0] = { ...first, text: `${text}\n\n${first.text}` };
	} else {
		draft.presentation.content.unshift({ type: "text", text });
	}
}

function compactFailedQa(draft: CompactFailedQaInput): void {
	const qa = draft.qaPreset;
	const compiled = draft.input.prepared.compiledQaPreset;
	if (!qa || qa.passed || !compiled || draft.presentation.failureCategory === "artifact-missing") {
		return;
	}
	draft.succeeded = false;
	draft.presentation.failureCategory = "qa-failure";
	draft.presentation.summary = qa.summary;
	const text = buildQaCompactFailureText({
		causalError: draft.presentation.batchFailure?.failedStep.text,
		executedStepCount: draft.presentation.batchSteps?.length,
		page: extractQaPageContext({
			attachedTarget: draft.qaAttachedTarget,
			batchData: draft.presentationEnvelope?.data,
			compiled,
		}),
		plannedStepCount: compiled.steps.length,
		qaPreset: qa,
	});
	const nonText = draft.presentation.content.filter((item) => item.type !== "text");
	draft.presentation.content = [{ type: "text", text }, ...nonText];
}

function compactPassedQa(draft: CompactPassedQaInput): void {
	const qa = draft.qaPreset;
	const compiled = draft.input.prepared.compiledQaPreset;
	if (qa?.passed !== true || !compiled || !draft.succeeded) {
		return;
	}
	const text = buildQaCompactPassText({
		artifactVerification: draft.presentation.artifactVerification,
		batchStepCount: draft.presentation.batchSteps?.length ?? compiled.steps.length,
		checks: compiled.checks,
		page: extractQaPageContext({
			attachedTarget: draft.qaAttachedTarget,
			batchData: draft.presentationEnvelope?.data,
			compiled,
		}),
		qaPreset: qa,
	});
	draft.presentation.summary = qa.summary;
	const nonText = draft.presentation.content.filter((item) => item.type !== "text");
	draft.presentation.content = [{ type: "text", text }, ...nonText];
}

export async function analyzeOutputChecks(draft: AnalyzeOutputChecksInput): Promise<void> {
	analyzeQaEvidence(draft);
	await Promise.all([
		collectQaAttachment(draft),
		lookupSourceEvidence(draft),
		lookupNetworkSourceEvidence(draft),
	]);
	if (draft.networkSourceLookup) {
		prependLookupSummary(draft, draft.networkSourceLookup.summary);
	}
	if (draft.sourceLookup) {
		prependLookupSummary(draft, draft.sourceLookup.summary);
	}
	compactFailedQa(draft);
	compactPassedQa(draft);
}

function attachedDiagnosticsNotice(draft: AttachedDiagnosticsNoticeInput): string | undefined {
	const checks = draft.input.prepared.compiledQaPreset?.checks;
	if (checks?.attached !== true || checks.diagnosticsResetAtStart) {
		return;
	}
	if (!checks.checkNetwork && !checks.checkConsole && !checks.checkErrors) {
		return;
	}
	return "Attached diagnostics: existing upstream session console/network/error buffers were preserved; rows may include events from before qa.attached started.";
}

function renderQaBanner(draft: RenderQaBannerInput): void {
	const text = [
		formatQaAttachedTargetText(draft.qaAttachedTarget),
		attachedDiagnosticsNotice(draft),
	]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join("\n");
	if (
		(draft.qaPreset?.passed === true &&
			draft.input.prepared.compiledQaPreset?.checks.attached === true) ||
		text.length === 0
	) {
		return;
	}
	const first = draft.presentation.content.at(0);
	if (first?.type === "text") {
		draft.presentation.content[0] = {
			...first,
			text:
				draft.qaPreset?.passed === false ? `${first.text}\n\n${text}` : `${text}\n\n${first.text}`,
		};
	} else {
		draft.presentation.content.unshift({ type: "text", text });
	}
}

export function renderAttachedQaBanner(draft: RenderAttachedQaBannerInput): void {
	renderQaBanner(draft);
	if (draft.managedSessionOutcome && draft.managedSessionOutcome.succeeded !== draft.succeeded) {
		draft.managedSessionOutcome = { ...draft.managedSessionOutcome, succeeded: draft.succeeded };
	}
}

function evalPageUrl(
	draft: EvalPageUrlInput,
	summary: NavigationSummary | undefined,
): string | undefined {
	const key = draft.sessionStateKey;
	const sessionUrl =
		key !== undefined && key.length > 0
			? draft.input.state.sessionPageState.get(key).tabTarget?.url
			: undefined;
	return (
		summary?.url ??
		draft.currentSessionTabTarget?.url ??
		draft.input.prepared.priorSessionTabTarget?.url ??
		sessionUrl
	);
}

export function collectEvalGuidance(draft: CollectEvalGuidanceInput): void {
	const summary =
		draft.navigationSummary ?? extractNavigationSummaryFromData(draft.presentationEnvelope?.data);
	const { prepared } = draft.input;
	draft.evalStdinHint = getEvalStdinHint({
		command: prepared.executionPlan.commandInfo.command,
		data: draft.presentationEnvelope?.data,
		stdin: prepared.runtimeToolStdin,
	});
	draft.evalResultWarning = getEvalResultWarning({
		command: prepared.executionPlan.commandInfo.command,
		data: draft.presentationEnvelope?.data,
		navigationSummary: summary,
		pageUrl: evalPageUrl(draft, summary),
		stdin: prepared.runtimeToolStdin,
	});
	if (draft.readConfirmationEvent) {
		draft.input.state.sessionPageState.applyReadConfirmation(
			draft.readConfirmationEvent,
			draft.input.sessionPageStateUpdate,
		);
	}
}
