import { isRecord } from "../../parsing.js";
import {
	redactInvocationArgs,
	redactSensitiveText,
	redactSensitiveValue,
} from "../../runtime-redaction.js";
import { projectAgentBrowserObservation } from "../../results/presentation/content.js";
import type { AgentBrowserEnvelope } from "../../results/contracts.js";
import type { AgentBrowserExecutionPlan } from "./types.js";
import type { ToolPresentationObservation as AgentBrowserToolPresentation } from "../../results/presentation/observation-contracts.js";
import type {
	PublicationToolResult as AgentBrowserToolResult,
	PublicationContent,
} from "./final-result-contracts.js";

export function redactExactSensitiveText(text: string, sensitiveValues: readonly string[]): string {
	let redacted = text;
	for (const value of sensitiveValues) {
		redacted = redacted.split(value).join("[REDACTED]");
	}
	return redacted;
}

export function redactExactSensitiveValue(
	value: unknown,
	sensitiveValues: readonly string[],
): unknown {
	if (sensitiveValues.length === 0) {
		return value;
	}
	if (typeof value === "string") {
		return redactExactSensitiveText(value, sensitiveValues);
	}
	if (Array.isArray(value)) {
		const entries: unknown[] = value;
		return entries.map((item) => redactExactSensitiveValue(item, sensitiveValues));
	}
	if (!isRecord(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => [
			key,
			redactExactSensitiveValue(entryValue, sensitiveValues),
		]),
	);
}

export function redactToolDetails(
	details: Readonly<Record<string, unknown>>,
	sensitiveValues: readonly string[],
): Record<string, unknown> {
	const redacted = redactSensitiveValue(redactExactSensitiveValue(details, sensitiveValues));
	if (!isRecord(redacted)) {
		throw new Error("Browser result details must remain an object after redaction.");
	}
	return redacted;
}

export function redactRecoveryHint(
	recoveryHint: AgentBrowserExecutionPlan["recoveryHint"],
): AgentBrowserExecutionPlan["recoveryHint"] {
	if (!recoveryHint) {
		return undefined;
	}
	const exampleArgs = redactInvocationArgs(recoveryHint.exampleArgs);
	return {
		...recoveryHint,
		exampleArgs,
		exampleParams: { ...recoveryHint.exampleParams, args: exampleArgs },
	};
}

export function buildJsonVisibleContent(
	options: Readonly<{
		error: unknown;
		details?: Readonly<Record<string, unknown>>;
		presentation: AgentBrowserToolPresentation;
		succeeded: boolean;
		warnings?: readonly unknown[] | undefined;
	}>,
): AgentBrowserToolResult["content"] {
	const { error, presentation, succeeded, warnings } = options;
	const payload = projectAgentBrowserObservation(
		{
			...presentation,
			...options.details,
			error,
			warnings: warnings !== undefined && warnings.length > 0 ? warnings : undefined,
		},
		succeeded,
	);
	const images = presentation.content.filter((item) => item.type === "image");
	return [{ type: "text", text: JSON.stringify(payload, null, 2) }, ...images];
}

type RedactedContentInput = Readonly<{
	exactSensitiveValues: readonly string[];
	plainTextInspection: boolean;
	presentation: AgentBrowserToolPresentation;
	presentationEnvelope?: AgentBrowserEnvelope | undefined;
	succeeded: boolean;
	userRequestedJson: boolean;
	warningText?: string | undefined;
}>;

function warningLines(text: string | undefined): readonly string[] | undefined {
	return text === undefined || text.length === 0 ? undefined : [text];
}

function contentWithWarnings(options: RedactedContentInput): AgentBrowserToolResult["content"] {
	if (options.userRequestedJson && !options.plainTextInspection) {
		return buildJsonVisibleContent({
			error: options.presentationEnvelope?.error,
			presentation: options.presentation,
			succeeded: options.succeeded,
			warnings: warningLines(options.warningText),
		});
	}
	const content = [...options.presentation.content];
	if (
		options.warningText === undefined ||
		options.warningText.length === 0 ||
		options.userRequestedJson
	) {
		return content;
	}
	if (content[0]?.type === "text") {
		content[0] = { ...content[0], text: `${options.warningText}\n\n${content[0].text}` };
	} else {
		content.unshift({ type: "text", text: options.warningText });
	}
	return content;
}

export function buildRedactedPresentationContent(
	options: RedactedContentInput,
): AgentBrowserToolResult["content"] {
	return contentWithWarnings(options).map((item) => {
		if (item.type !== "text") {
			return item;
		}
		const text =
			options.userRequestedJson && !options.plainTextInspection
				? JSON.stringify(
						redactExactSensitiveValue(JSON.parse(item.text), options.exactSensitiveValues),
						null,
						2,
					)
				: redactSensitiveText(redactExactSensitiveText(item.text, options.exactSensitiveValues));
		return { type: "text", text };
	});
}

export function readJsonWarnings(content: PublicationContent): readonly unknown[] | undefined {
	if (content[0]?.type !== "text") {
		return undefined;
	}
	const prior: unknown = JSON.parse(content[0].text);
	if (!isRecord(prior) || !Array.isArray(prior.warnings)) {
		return undefined;
	}
	const warnings: readonly unknown[] = prior.warnings;
	return warnings;
}
