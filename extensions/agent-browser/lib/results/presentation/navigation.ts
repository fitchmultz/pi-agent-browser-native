import {
	isNavigationObservableCommandName,
	isOpenNavigationCommand,
	isPageChangeSummaryCommand,
} from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import type { CommandInfo } from "../../argv-descriptor.js";
import { detectConfirmationRequired } from "../confirmation.js";
import type { AgentBrowserPageChangeSummary, FileArtifactMetadata } from "../contracts.js";
import {
	firstLine,
	omitUpstreamLifecycle,
	redactModelFacingText,
	stringifyModelFacing,
} from "./common.js";

const NAVIGATION_SUMMARY_FIELD = "navigationSummary";

interface NavigationSummary {
	readonly title?: string | undefined;
	readonly url?: string | undefined;
	readonly urlChanged?: boolean;
}

const GET_RESULT_FIELDS: Readonly<Record<string, string>> = {
	attr: "value",
	count: "count",
	html: "html",
	text: "text",
	title: "title",
	url: "url",
	value: "value",
};

function getExtractionResultField(
	command: CommandInfo,
	data: Readonly<Record<string, unknown>>,
): string | undefined {
	if (Object.hasOwn(data, "result")) {
		return "result";
	}
	const field =
		command.command === "get" && command.subcommand !== undefined
			? GET_RESULT_FIELDS[command.subcommand]
			: undefined;
	return field !== undefined && field.length > 0 && Object.hasOwn(data, field) ? field : undefined;
}

function getScalarExtractionResult(
	command: CommandInfo,
	data: Readonly<Record<string, unknown>>,
): string | undefined {
	const field = getExtractionResultField(command, data);
	if (field === undefined) {
		return undefined;
	}
	const result = data[field];
	if (typeof result === "string") {
		return result.trim().length > 0 ? result : "(empty string)";
	}
	if (typeof result === "number" || typeof result === "boolean") {
		return String(result);
	}
	if (result === null || result === undefined) {
		return "null";
	}
	return typeof result === "object" ? JSON.stringify(result, null, 2) : undefined;
}

function getExtractionOrigin(data: Readonly<Record<string, unknown>>): string | undefined {
	if (typeof data.origin === "string" && data.origin.trim().length > 0) {
		return data.origin.trim();
	}
	return typeof data.url === "string" && data.url.trim().length > 0 ? data.url.trim() : undefined;
}

function formatGetSummaryLabel(subcommand: string | undefined): string {
	if (subcommand === undefined || subcommand.length === 0) {
		return "Get result";
	}
	return subcommand.toLowerCase() === "url"
		? "URL"
		: `${subcommand.slice(0, 1).toUpperCase()}${subcommand.slice(1)}`;
}

export function formatExtractionSummary(
	command: CommandInfo,
	data: Readonly<Record<string, unknown>>,
): string | undefined {
	const result = getScalarExtractionResult(command, data);
	if (result === undefined || result.length === 0) {
		return undefined;
	}
	const line = firstLine(redactModelFacingText(result));
	if (command.command === "get") {
		return `${formatGetSummaryLabel(command.subcommand)}: ${line}`;
	}
	return command.command === "eval" ? `Eval result: ${line}` : undefined;
}

export function formatExtractionText(
	command: CommandInfo,
	data: Readonly<Record<string, unknown>>,
): string | undefined {
	if (command.command !== "get" && command.command !== "eval") {
		return undefined;
	}
	const result = getScalarExtractionResult(command, data);
	if (result === undefined || result.length === 0) {
		return undefined;
	}
	const origin = getExtractionOrigin(data);
	const safeResult = redactModelFacingText(result);
	const safeOrigin = origin !== undefined ? redactModelFacingText(origin) : undefined;
	return safeOrigin !== undefined && safeOrigin.length > 0 && safeOrigin !== safeResult
		? `${safeResult}\n\nOrigin: ${safeOrigin}`
		: safeResult;
}

export function isNavigationObservableCommand(
	command: string | undefined,
	subcommand?: string,
): boolean {
	return isNavigationObservableCommandName(command, subcommand);
}

function isNavigationSummary(value: unknown): value is NavigationSummary {
	if (!isRecord(value)) {
		return false;
	}
	return (
		(typeof value.title === "string" || typeof value.url === "string") &&
		(value.title === undefined || typeof value.title === "string") &&
		(value.url === undefined || typeof value.url === "string") &&
		(value.urlChanged === undefined || typeof value.urlChanged === "boolean")
	);
}

export function getNavigationSummary(
	data: Readonly<Record<string, unknown>>,
): NavigationSummary | undefined {
	const value = data[NAVIGATION_SUMMARY_FIELD];
	return isNavigationSummary(value) ? value : undefined;
}

function getTopLevelNavigationSummary(
	data: Readonly<Record<string, unknown>>,
): NavigationSummary | undefined {
	return isNavigationSummary(data)
		? {
				title: typeof data.title === "string" ? data.title : undefined,
				url: typeof data.url === "string" ? data.url : undefined,
			}
		: undefined;
}

function getNavigationText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNormalizedNavigationSummary(
	summary: NavigationSummary | undefined,
): NavigationSummary | undefined {
	const title = getNavigationText(summary?.title);
	const url = getNavigationText(summary?.url);
	return title !== undefined || url !== undefined
		? {
				title,
				url,
				...(typeof summary?.urlChanged === "boolean" ? { urlChanged: summary.urlChanged } : {}),
			}
		: undefined;
}

export function formatNavigationSummary(summary: NavigationSummary): string | undefined {
	const normalized = getNormalizedNavigationSummary(summary);
	if (!normalized) {
		return undefined;
	}
	return normalized.title !== undefined && normalized.url !== undefined
		? `${normalized.title}\n${normalized.url}`
		: (normalized.title ?? normalized.url);
}

interface PageChangeOptions {
	readonly artifacts?: readonly FileArtifactMetadata[] | undefined;
	readonly commandInfo: CommandInfo;
	readonly data: unknown;
	readonly nextActions?: readonly { readonly id: string }[] | undefined;
	readonly savedFilePath?: string | undefined;
	readonly summary: string;
}

interface PageChangeEvidence {
	readonly artifactCount: number;
	readonly navigation?: NavigationSummary | undefined;
	readonly savedFilePath?: string | undefined;
}

function getPageNavigation(command: CommandInfo, data: unknown): NavigationSummary | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	const summary =
		getNavigationSummary(data) ??
		(isPageChangeSummaryCommand(command.command, command.subcommand)
			? getTopLevelNavigationSummary(data)
			: undefined);
	return getNormalizedNavigationSummary(summary);
}

function isNavigationObserved(
	command: CommandInfo,
	navigation: NavigationSummary | undefined,
): boolean {
	return (
		navigation !== undefined &&
		(navigation.urlChanged === true ||
			isOpenNavigationCommand(command.command) ||
			["back", "forward", "pushstate", "reload"].includes(command.command ?? ""))
	);
}

function getPageChangeKind(
	options: PageChangeOptions,
	evidence: PageChangeEvidence,
): AgentBrowserPageChangeSummary["changeType"] | undefined {
	if (evidence.savedFilePath !== undefined || evidence.artifactCount > 0) {
		return "artifact";
	}
	const navigation = evidence.navigation;
	if (isNavigationObserved(options.commandInfo, navigation)) {
		return "navigation";
	}
	if (detectConfirmationRequired(options.data) !== undefined) {
		return "confirmation";
	}
	return navigation ||
		isPageChangeSummaryCommand(options.commandInfo.command, options.commandInfo.subcommand)
		? "mutation"
		: undefined;
}

function getPageChangeTargetParts(evidence: PageChangeEvidence): string[] {
	const parts = [evidence.navigation?.title, evidence.navigation?.url].filter(
		(value) => value !== undefined,
	);
	if (evidence.savedFilePath !== undefined) {
		parts.push(evidence.savedFilePath);
	} else if (evidence.artifactCount > 0) {
		parts.push(`${evidence.artifactCount} artifact${evidence.artifactCount === 1 ? "" : "s"}`);
	}
	return parts;
}

function formatPageChangeText(
	command: CommandInfo,
	evidence: PageChangeEvidence,
	kind: AgentBrowserPageChangeSummary["changeType"],
): string {
	const observed = kind !== "mutation";
	const parts = [
		command.command ?? "agent-browser",
		observed ? kind : "action dispatched",
		...getPageChangeTargetParts(evidence),
	];
	return `${parts.join(" → ")}${observed ? "" : " → application change unverified"}`;
}

function getPageChangeIdentityFields(
	options: PageChangeOptions,
	evidence: PageChangeEvidence,
): Pick<
	AgentBrowserPageChangeSummary,
	"command" | "nextActionIds" | "savedFilePath" | "title" | "url"
> {
	return {
		...(options.commandInfo.command !== undefined && options.commandInfo.command.length > 0
			? { command: options.commandInfo.command }
			: {}),
		...(options.nextActions
			? { nextActionIds: options.nextActions.map((action) => action.id) }
			: {}),
		...(evidence.savedFilePath !== undefined ? { savedFilePath: evidence.savedFilePath } : {}),
		...(evidence.navigation?.title !== undefined ? { title: evidence.navigation.title } : {}),
		...(evidence.navigation?.url !== undefined ? { url: evidence.navigation.url } : {}),
	};
}

export function buildPageChangeSummary(
	options: PageChangeOptions,
): AgentBrowserPageChangeSummary | undefined {
	const evidence: PageChangeEvidence = {
		artifactCount: options.artifacts?.length ?? 0,
		navigation: getPageNavigation(options.commandInfo, options.data),
		savedFilePath: options.savedFilePath === "" ? undefined : options.savedFilePath,
	};
	const changeType = getPageChangeKind(options, evidence);
	if (changeType === undefined) {
		return undefined;
	}
	return {
		...getPageChangeIdentityFields(options, evidence),
		...(evidence.artifactCount > 0 ? { artifactCount: evidence.artifactCount } : {}),
		changeType,
		observed: changeType !== "mutation",
		summary: formatPageChangeText(options.commandInfo, evidence, changeType),
	};
}

function stripNavigationSummary(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const { [NAVIGATION_SUMMARY_FIELD]: _navigationSummary, ...rest } = data;
	return rest;
}

export function formatNavigationActionResult(
	data: Readonly<Record<string, unknown>>,
): string | undefined {
	const actionData = omitUpstreamLifecycle(stripNavigationSummary(data));
	const lines: string[] = [];
	if (typeof actionData.clicked === "string" || typeof actionData.clicked === "boolean") {
		lines.push(`Clicked: ${String(actionData.clicked)}`);
	}
	if (typeof actionData.href === "string") {
		lines.push(`Href: ${redactModelFacingText(actionData.href)}`);
	}
	if (typeof actionData.navigated === "boolean") {
		lines.push(`Navigated: ${actionData.navigated}`);
	}
	if (lines.length > 0) {
		return lines.join("\n");
	}
	const text = stringifyModelFacing(actionData).trim();
	return text.length === 0 || text === "{}" ? undefined : text;
}
