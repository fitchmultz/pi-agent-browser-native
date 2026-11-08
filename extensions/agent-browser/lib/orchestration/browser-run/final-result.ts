import {
	redactNetworkSourceLookupSurface,
	redactNetworkSourceLookupUrl,
} from "../../input-modes/lookups.js";
import { isRecord } from "../../parsing.js";
import { applyNamespaceToNextActions } from "../../results/next-actions.js";
import { extractAgentBrowserLifecycle } from "../../results/presentation/common.js";
import type { OpenResultTabCorrection } from "../../runtime-contracts.js";
import { buildResultNextActions } from "./final-result-actions.js";
import { buildFinalResultContent } from "./final-result-content.js";
import { buildAgentBrowserResultDetails } from "./final-result-details.js";
import { buildBrowserWindowStatus } from "./final-result-evidence.js";
import { redactToolDetails } from "./final-result-redaction.js";
import type {
	PublicationInput,
	PublicationToolResult as AgentBrowserToolResult,
} from "./final-result-contracts.js";

export {
	buildMissingBinaryMessage,
	isMissingAgentBrowserBinary,
	buildMissingBinaryFailureResult,
} from "./final-result-missing-binary.js";
export {
	buildElectronHostFailureResult,
	getElectronLaunchFailureCategory,
	formatElectronLaunchText,
	formatElectronTargetLines,
} from "./final-result-electron.js";
export {
	buildJsonVisibleContent,
	buildRedactedPresentationContent,
	redactExactSensitiveText,
	redactExactSensitiveValue,
	redactToolDetails,
	redactRecoveryHint,
} from "./final-result-redaction.js";
export { prepareFinalResultRecoveryState } from "./final-result-recovery.js";
export { formatAgentBrowserNextActionsText } from "./final-result-content.js";

export function buildWrapperRecoveryHint(
	options: Readonly<{ sessionTabCorrection?: OpenResultTabCorrection | undefined }>,
): string | undefined {
	return options.sessionTabCorrection
		? "Wrapper recovery hint: this call used session tab correction. Inspect details.effectiveArgs and details.sessionTabCorrection; if the selected tab looks wrong, run tab list for the same session before retrying."
		: undefined;
}

function redactNetworkLookupResult(
	result: Readonly<AgentBrowserToolResult & { isError: boolean }>,
): AgentBrowserToolResult {
	const details = redactNetworkSourceLookupSurface(result.details);
	if (!isRecord(details)) {
		throw new Error("Network lookup result details must remain an object after redaction.");
	}
	const content = result.content.map((item) => {
		if (item.type === "text") {
			return { type: "text" as const, text: redactNetworkSourceLookupUrl(item.text) ?? item.text };
		}
		return {
			type: "image" as const,
			data: redactNetworkSourceLookupUrl(item.data) ?? item.data,
			mimeType: redactNetworkSourceLookupUrl(item.mimeType) ?? item.mimeType,
		};
	});
	return { content, details, isError: result.isError };
}

export function buildFinalAgentBrowserToolResult(
	options: PublicationInput,
): AgentBrowserToolResult {
	const nextActions = applyNamespaceToNextActions(
		buildResultNextActions(options),
		options.executionPlan.namespace,
	);
	const lifecycle = extractAgentBrowserLifecycle(options.presentationEnvelope?.data);
	const browserWindow = buildBrowserWindowStatus(options, lifecycle);
	const details = redactToolDetails(
		buildAgentBrowserResultDetails(options, nextActions, lifecycle, browserWindow),
		options.exactSensitiveValues,
	);
	const rendered = buildFinalResultContent(options, details, nextActions, {
		lifecycle,
		browserWindow,
	});
	const result = {
		content: rendered.content,
		details:
			"warnings" in rendered && rendered.warnings !== undefined
				? { ...details, warnings: rendered.warnings }
				: details,
		isError: !options.succeeded,
	} satisfies AgentBrowserToolResult;
	return options.compiledNetworkSourceLookup ? redactNetworkLookupResult(result) : result;
}
