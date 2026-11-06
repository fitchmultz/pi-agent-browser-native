import type { AgentBrowserNextAction } from "../../results/contracts.js";
import {
	formatVisibleRefFallbackText,
	formatRichInputRecoveryText,
} from "../../results/selector-recovery.js";
import { redactSensitiveText } from "../../runtime-redaction.js";
import { formatClickDispatchDiagnosticText } from "./click-dispatch.js";
import { formatOverlayBlockerText } from "./overlay-diagnostics.js";
import { formatFillVerificationText } from "./fill-diagnostics.js";
import { formatSelectorTextVisibilityText } from "./text-visibility-diagnostics.js";
import { formatElectronBroadGetTextScopeText } from "./electron-text-diagnostics.js";
import { formatTimeoutPartialProgressText } from "./timeout-diagnostics.js";
import {
	formatArtifactCleanupGuidanceText,
	formatComboboxFocusDiagnosticText,
	formatEvalResultWarningText,
	formatEvalStdinHintText,
	formatRecordingDependencyWarningText,
	formatScrollNoopDiagnosticText,
} from "./diagnostics.js";
import {
	formatElectronRefFreshnessText,
	formatManagedSessionOutcomeText,
} from "./session-state.js";
import { formatBrowserWindowText, formatReadExecutionText } from "./final-result-evidence.js";
import { formatElectronLaunchText } from "./final-result-electron.js";
import {
	buildJsonVisibleContent,
	readJsonWarnings,
	redactExactSensitiveText,
} from "./final-result-redaction.js";
import type {
	PublicationInput as FinalResultInput,
	PublicationToolResult as AgentBrowserToolResult,
	PublicationLifecycle as AgentBrowserLifecycle,
	PublicationWindow as AgentBrowserWindow,
	PublicationContent,
} from "./final-result-contracts.js";

const SEMANTIC_ACTION_CANDIDATE_ACTION_IDS = new Set([
	"try-button-name-candidate",
	"try-link-name-candidate",
]);

function formatSemanticActionCandidateText(
	actions: readonly AgentBrowserNextAction[] | undefined,
): string | undefined {
	const candidates =
		actions?.filter(
			(action) =>
				SEMANTIC_ACTION_CANDIDATE_ACTION_IDS.has(action.id) && action.params?.args !== undefined,
		) ?? [];
	if (candidates.length === 0) {
		return undefined;
	}
	return [
		"Agent-browser candidate fallbacks:",
		...candidates.map(
			(action) =>
				`- ${action.id}: agent_browser ${JSON.stringify({ args: action.params?.args })} — ${action.reason}`,
		),
	].join("\n");
}

export function formatAgentBrowserNextActionsText(
	nextActions: readonly AgentBrowserNextAction[] | undefined,
): string | undefined {
	if (!nextActions || nextActions.length === 0) {
		return undefined;
	}
	const lines = nextActions.map((action) => {
		const payload =
			action.artifactPath !== undefined && action.artifactPath.length > 0
				? { artifactPath: action.artifactPath }
				: action.params;
		return `- ${action.id}${payload ? ` ${redactSensitiveText(JSON.stringify(payload))}` : ""}: ${redactSensitiveText(action.reason)}`;
	});
	return ["Next actions:", ...lines].join("\n");
}

type InteractionTextInput = Pick<
	FinalResultInput,
	| "visibleRefFallbackDiagnostic"
	| "richInputRecoveryDiagnostic"
	| "clickDispatchDiagnostic"
	| "overlayBlockerDiagnostic"
	| "fillVerificationDiagnostic"
	| "electronRefFreshnessDiagnostic"
	| "selectorTextVisibilityDiagnostics"
	| "electronBroadGetTextScopeDiagnostics"
	| "scrollNoopDiagnostic"
	| "comboboxFocusDiagnostic"
>;

function interactionDiagnosticText(
	options: InteractionTextInput,
	nextActions: readonly AgentBrowserNextAction[] | undefined,
): (string | undefined)[] {
	return [
		formatVisibleRefFallbackText(options.visibleRefFallbackDiagnostic),
		formatRichInputRecoveryText(options.richInputRecoveryDiagnostic),
		formatSemanticActionCandidateText(nextActions),
		options.clickDispatchDiagnostic
			? formatClickDispatchDiagnosticText(options.clickDispatchDiagnostic)
			: undefined,
		options.overlayBlockerDiagnostic
			? formatOverlayBlockerText(options.overlayBlockerDiagnostic)
			: undefined,
		formatFillVerificationText(options.fillVerificationDiagnostic),
		formatElectronRefFreshnessText(options.electronRefFreshnessDiagnostic),
		formatSelectorTextVisibilityText(options.selectorTextVisibilityDiagnostics),
		formatElectronBroadGetTextScopeText(options.electronBroadGetTextScopeDiagnostics),
		formatScrollNoopDiagnosticText(options.scrollNoopDiagnostic),
		formatComboboxFocusDiagnosticText(options.comboboxFocusDiagnostic),
	];
}

function timeoutText(
	options: Pick<
		FinalResultInput,
		"timeoutPartialProgress" | "currentSessionTabTargetUnknown" | "sessionMode"
	>,
): string | undefined {
	return options.timeoutPartialProgress
		? formatTimeoutPartialProgressText(
				options.timeoutPartialProgress,
				options.currentSessionTabTargetUnknown === true &&
					!(
						options.sessionMode === "fresh" &&
						options.timeoutPartialProgress.liveUrlRecovered !== true
					),
			)
		: undefined;
}

type DiagnosticTextInput = InteractionTextInput &
	Pick<
		FinalResultInput,
		| "recordingDependencyWarning"
		| "evalStdinHint"
		| "evalResultWarning"
		| "artifactCleanup"
		| "timeoutPartialProgress"
		| "currentSessionTabTargetUnknown"
		| "sessionMode"
		| "managedSessionOutcome"
		| "executionPlan"
		| "presentationEnvelope"
		| "processResult"
		| "categoryDetails"
		| "exactSensitiveValues"
	>;

function appendedDiagnosticText(
	options: DiagnosticTextInput,
	nextActions: readonly AgentBrowserNextAction[] | undefined,
	lifecycle: AgentBrowserLifecycle | undefined,
	browserWindow: AgentBrowserWindow | undefined,
): string {
	const text = [
		...interactionDiagnosticText(options, nextActions),
		formatRecordingDependencyWarningText(options.recordingDependencyWarning),
		formatEvalStdinHintText(options.evalStdinHint),
		formatEvalResultWarningText(options.evalResultWarning),
		formatArtifactCleanupGuidanceText(options.artifactCleanup),
		timeoutText(options),
		formatManagedSessionOutcomeText(options.managedSessionOutcome),
		formatReadExecutionText(options, lifecycle),
		formatBrowserWindowText(browserWindow),
		options.categoryDetails.resultCategory === "failure"
			? formatAgentBrowserNextActionsText(nextActions)
			: undefined,
	]
		.filter((item): item is string => item !== undefined)
		.join("\n\n");
	return redactSensitiveText(redactExactSensitiveText(text, options.exactSensitiveValues));
}

function withAppendedText(
	content: PublicationContent,
	text: string,
): AgentBrowserToolResult["content"] {
	if (text.length === 0 || content[0]?.type !== "text") {
		return [...content];
	}
	return [{ ...content[0], text: `${content[0].text}\n\n${text}` }, ...content.slice(1)];
}

function withElectronHandoff(
	content: PublicationContent,
	options: Pick<
		FinalResultInput,
		| "electronLaunchRecord"
		| "succeeded"
		| "userRequestedJson"
		| "electronHandoff"
		| "electronLaunch"
	>,
): AgentBrowserToolResult["content"] {
	if (
		!options.electronLaunchRecord ||
		!options.succeeded ||
		options.userRequestedJson ||
		content[0]?.type !== "text"
	) {
		return [...content];
	}
	const text = redactSensitiveText(
		formatElectronLaunchText({
			handoff: options.electronHandoff,
			record: options.electronLaunchRecord,
			targets: options.electronLaunch?.targets ?? [],
			upstreamText: content[0].text,
		}),
	);
	return [{ ...content[0], text }, ...content.slice(1)];
}

type ContentInput = DiagnosticTextInput &
	Pick<
		FinalResultInput,
		| "userRequestedJson"
		| "plainTextInspection"
		| "redactedContent"
		| "electronLaunchRecord"
		| "succeeded"
		| "electronHandoff"
		| "electronLaunch"
		| "presentation"
	>;

export function buildFinalResultContent(
	options: ContentInput,
	details: Readonly<Record<string, unknown>>,
	nextActions: readonly AgentBrowserNextAction[] | undefined,
	evidence: Readonly<{
		lifecycle?: AgentBrowserLifecycle | undefined;
		browserWindow?: AgentBrowserWindow | undefined;
	}>,
): Readonly<{
	content: AgentBrowserToolResult["content"];
	warnings?: readonly unknown[] | undefined;
}> {
	if (options.userRequestedJson && !options.plainTextInspection) {
		const warnings = readJsonWarnings(options.redactedContent);
		return {
			content: buildJsonVisibleContent({
				error: details.error,
				details: { ...details, ...(warnings === undefined ? {} : { warnings }) },
				presentation: options.presentation,
				succeeded: options.succeeded,
				warnings,
			}),
			warnings,
		};
	}
	const diagnosticText = appendedDiagnosticText(
		options,
		nextActions,
		evidence.lifecycle,
		evidence.browserWindow,
	);
	const content = withAppendedText(options.redactedContent, diagnosticText);
	return { content: withElectronHandoff(content, options) };
}
