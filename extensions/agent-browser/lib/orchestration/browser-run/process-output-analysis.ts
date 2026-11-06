import type {
	ProcessBrowserOutputInput,
	PreparedBrowserRun,
	BrowserRunState,
	NavigationSummary,
} from "./types.js";
import type { PublicationOutputPhase } from "./process-output-publication-phase-contracts.js";
import type { ToolPresentation } from "../../results/contracts.js";
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
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "processResult">> & {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledQaPreset">>;
	};
};
type CollectQaAttachmentInput = Readonly<
	Pick<PublicationOutputPhase, "currentSessionTabTarget">
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "cwd" | "signal">> & {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "compiledQaPreset" | "executionPlan" | "priorSessionTabTarget">
		>;
	};
};
type LookupSourceEvidenceInput = Readonly<
	Pick<PublicationOutputPhase, "currentSessionTabTarget" | "operationCwd" | "presentationEnvelope">
> & {
	readonly input: {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "compiledSourceLookup" | "executionPlan" | "priorSessionTabTarget">
		>;
		readonly state: BrowserRunState;
	};
};
type LookupNetworkSourceEvidenceInput = Readonly<
	Pick<PublicationOutputPhase, "operationCwd" | "presentationEnvelope">
> & {
	readonly input: {
		readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledNetworkSourceLookup">>;
	};
};
type QaSummaryInput = Readonly<
	Pick<
		PublicationOutputPhase,
		"presentationEnvelope" | "qaAttachedTarget" | "qaPreset" | "succeeded"
	>
> & {
	readonly presentation: ToolPresentationObservation;
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledQaPreset">> };
};
type AnalyzeOutputChecksInput = AnalyzeQaEvidenceInput &
	CollectQaAttachmentInput &
	LookupSourceEvidenceInput &
	LookupNetworkSourceEvidenceInput &
	Readonly<Pick<PublicationOutputPhase, "succeeded">>;
type AttachedDiagnosticsNoticeInput = {
	readonly input: { readonly prepared: Readonly<Pick<PreparedBrowserRun, "compiledQaPreset">> };
};
type RenderQaBannerInput = Readonly<Pick<PublicationOutputPhase, "qaAttachedTarget" | "qaPreset">> &
	AttachedDiagnosticsNoticeInput & { readonly presentation: ToolPresentationObservation };
type RenderAttachedQaBannerInput = RenderQaBannerInput &
	Readonly<Pick<PublicationOutputPhase, "managedSessionOutcome" | "succeeded">>;
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
> & {
	readonly input: Readonly<Pick<ProcessBrowserOutputInput, "sessionPageStateUpdate">> & {
		readonly prepared: Readonly<
			Pick<PreparedBrowserRun, "executionPlan" | "priorSessionTabTarget" | "runtimeToolStdin">
		>;
		readonly state: BrowserRunState;
	};
};

function analyzeQaEvidence(draft: AnalyzeQaEvidenceInput): PublicationOutputPhase["qaPreset"] {
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
	return qa;
}

async function collectQaAttachment(
	draft: CollectQaAttachmentInput,
): Promise<PublicationOutputPhase["qaAttachedTarget"]> {
	if (draft.input.prepared.compiledQaPreset?.checks.attached !== true) {
		return;
	}
	const { prepared, cwd, signal } = draft.input;
	return collectQaAttachedTarget({
		currentTarget: draft.currentSessionTabTarget ?? prepared.priorSessionTabTarget,
		cwd,
		namespace: prepared.executionPlan.namespace,
		sessionName: prepared.executionPlan.sessionName,
		signal,
	});
}

async function lookupSourceEvidence(
	draft: LookupSourceEvidenceInput,
): Promise<PublicationOutputPhase["sourceLookup"]> {
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
	return analyzeSourceLookupResults(
		draft.presentationEnvelope?.data,
		compiled,
		draft.operationCwd,
		{ electronContext, workspaceRoot: draft.operationCwd },
	);
}

async function lookupNetworkSourceEvidence(
	draft: LookupNetworkSourceEvidenceInput,
): Promise<PublicationOutputPhase["networkSourceLookup"]> {
	const compiled = draft.input.prepared.compiledNetworkSourceLookup;
	if (!compiled) {
		return;
	}
	return redactNetworkSourceLookupAnalysis(
		await analyzeNetworkSourceLookupResults(
			draft.presentationEnvelope?.data,
			compiled,
			draft.operationCwd,
		),
	);
}

function prependLookupSummary(
	content: ToolPresentationObservation["content"],
	text: string,
): ToolPresentation["content"] {
	const first = content.at(0);
	return first?.type === "text"
		? [{ ...first, text: `${text}\n\n${first.text}` }, ...content.slice(1)]
		: [{ type: "text", text }, ...content];
}

function compactFailedQa(
	draft: QaSummaryInput,
): Pick<ToolPresentation, "failureCategory" | "summary" | "content"> | undefined {
	const qa = draft.qaPreset;
	const compiled = draft.input.prepared.compiledQaPreset;
	if (!qa || qa.passed || !compiled || draft.presentation.failureCategory === "artifact-missing") {
		return;
	}
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
	return {
		failureCategory: "qa-failure",
		summary: qa.summary,
		content: [{ type: "text", text }, ...nonText],
	};
}

function compactPassedQa(
	draft: QaSummaryInput,
): Pick<ToolPresentation, "summary" | "content"> | undefined {
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
	const nonText = draft.presentation.content.filter((item) => item.type !== "text");
	return { summary: qa.summary, content: [{ type: "text", text }, ...nonText] };
}

export async function analyzeOutputChecks(draft: AnalyzeOutputChecksInput): Promise<
	Pick<
		PublicationOutputPhase,
		"qaPreset" | "qaAttachedTarget" | "sourceLookup" | "networkSourceLookup" | "succeeded"
	> & {
		readonly presentationUpdate: Partial<
			Pick<ToolPresentation, "failureCategory" | "summary" | "content">
		>;
	}
> {
	const qaPreset = analyzeQaEvidence(draft);
	const [qaAttachedTarget, sourceLookup, networkSourceLookup] = await Promise.all([
		collectQaAttachment(draft),
		lookupSourceEvidence(draft),
		lookupNetworkSourceEvidence(draft),
	]);
	let content: ToolPresentation["content"] | undefined;
	if (networkSourceLookup) {
		content = prependLookupSummary(draft.presentation.content, networkSourceLookup.summary);
	}
	if (sourceLookup) {
		content = prependLookupSummary(content ?? draft.presentation.content, sourceLookup.summary);
	}
	const qaInput = {
		input: draft.input,
		presentation: draft.presentation,
		presentationEnvelope: draft.presentationEnvelope,
		qaAttachedTarget,
		qaPreset,
		succeeded: draft.succeeded,
	};
	const failed = compactFailedQa(qaInput);
	return {
		qaPreset,
		qaAttachedTarget,
		sourceLookup,
		networkSourceLookup,
		succeeded: failed ? false : draft.succeeded,
		presentationUpdate: {
			...(content ? { content } : {}),
			...failed,
			...compactPassedQa(qaInput),
		},
	};
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

function renderQaBanner(draft: RenderQaBannerInput): ToolPresentation["content"] | undefined {
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
	return first?.type === "text"
		? [
				{
					...first,
					text:
						draft.qaPreset?.passed === false
							? `${first.text}\n\n${text}`
							: `${text}\n\n${first.text}`,
				},
				...draft.presentation.content.slice(1),
			]
		: [{ type: "text", text }, ...draft.presentation.content];
}

export function renderAttachedQaBanner(draft: RenderAttachedQaBannerInput): Pick<
	PublicationOutputPhase,
	"managedSessionOutcome"
> & {
	readonly content: ToolPresentation["content"] | undefined;
} {
	return {
		content: renderQaBanner(draft),
		managedSessionOutcome:
			draft.managedSessionOutcome && draft.managedSessionOutcome.succeeded !== draft.succeeded
				? { ...draft.managedSessionOutcome, succeeded: draft.succeeded }
				: draft.managedSessionOutcome,
	};
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

export function collectEvalGuidance(
	draft: CollectEvalGuidanceInput,
): Pick<PublicationOutputPhase, "evalStdinHint" | "evalResultWarning"> {
	const summary =
		draft.navigationSummary ?? extractNavigationSummaryFromData(draft.presentationEnvelope?.data);
	const { prepared } = draft.input;
	const evalStdinHint = getEvalStdinHint({
		command: prepared.executionPlan.commandInfo.command,
		data: draft.presentationEnvelope?.data,
		stdin: prepared.runtimeToolStdin,
	});
	const evalResultWarning = getEvalResultWarning({
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
	return { evalStdinHint, evalResultWarning };
}
