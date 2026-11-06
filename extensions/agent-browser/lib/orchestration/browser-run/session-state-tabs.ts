import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { isBrowserIndependentRead, needsManagedSession } from "../../command-policy.js";
import {
	getRecordCommandOperands,
	isCloseCommand,
	isOpenNavigationCommand,
	isSessionTabPinningExcludedCommand,
	isSessionTabPostCommandCorrectionExcludedCommand,
	isWindowOrDiffPageTransitionCommand,
} from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import type { OpenResultTabCorrection } from "../../runtime-contracts.js";
import { chooseOpenResultTabCorrection } from "../../runtime-tab-correction.js";
import {
	extractStringResultField,
	normalizeComparableUrl,
	type SessionTabTarget,
} from "../../session-page-state.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { findFirstPositionalArgument } from "./prepare/wait-timeouts.js";
import { runSessionCommandData } from "./session-state-commands.js";

function hasExplicitNavigationOperand(tokens: readonly string[]): boolean {
	const command = tokens[0];
	return (
		(command === "a11y" && findFirstPositionalArgument(tokens) !== undefined) ||
		((command === "vitals" || command === "web-vitals") &&
			tokens.slice(1).some((token) => !token.startsWith("--"))) ||
		getRecordCommandOperands(tokens).url !== undefined
	);
}

export function commandChoosesSessionTabTarget(args: readonly string[]): boolean {
	const tokens = parseArgvDescriptor(args).upstreamCommandTokens;
	const command = tokens[0];
	const subcommand = tokens.at(1);
	return (
		isOpenNavigationCommand(command) ||
		isCloseCommand(command) ||
		command === "connect" ||
		(command === "state" && subcommand === "load") ||
		(command === "tab" && subcommand !== undefined && subcommand !== "list") ||
		isWindowOrDiffPageTransitionCommand(command, subcommand) ||
		hasExplicitNavigationOperand(tokens)
	);
}

function isNonTargetProbe(tokens: readonly string[], reopenPending: boolean): boolean {
	const [command, subcommand] = tokens;
	if (command === "get" && subcommand === "url" && !reopenPending) {
		return true;
	}
	if (command === "record" && subcommand === "stop") {
		return true;
	}
	if (command === "console" || command === "errors") {
		return true;
	}
	return (
		command === "network" &&
		!(
			subcommand === "requests" &&
			tokens.some((token) =>
				["--current-page", "--current-origin", "--current-url"].includes(token),
			)
		)
	);
}

function classifyTabPinningStep(
	step: readonly string[],
	reopenPending: boolean,
): "destination" | "page" | "excluded" {
	const descriptor = parseArgvDescriptor(step);
	const tokens = descriptor.upstreamCommandTokens;
	if (commandChoosesSessionTabTarget(tokens)) {
		return "destination";
	}
	if (
		!needsManagedSession(descriptor) ||
		isSessionTabPinningExcludedCommand(tokens[0]) ||
		isNonTargetProbe(tokens, reopenPending)
	) {
		return "excluded";
	}
	return "page";
}

interface TabPinningFacts {
	readonly command?: string | undefined;
	readonly commandTokens: readonly string[];
	readonly pinningRequired?: boolean;
	readonly reopenPending?: boolean;
	readonly sessionName?: string | undefined;
	readonly stdin?: string | undefined;
}

function hasTabPinningContext(
	facts: Pick<TabPinningFacts, "command" | "sessionName" | "pinningRequired">,
): boolean {
	return (
		facts.pinningRequired === true &&
		(facts.sessionName ?? "").length > 0 &&
		(facts.command ?? "").length > 0
	);
}

export function shouldPinSessionTabForCommand(options: TabPinningFacts): boolean {
	if (
		!hasTabPinningContext(options) ||
		isBrowserIndependentRead(options.commandTokens, options.stdin)
	) {
		return false;
	}
	const steps =
		options.command === "batch"
			? getUpstreamEffectiveBatchSteps(options.commandTokens, options.stdin)
			: [options.commandTokens];
	for (const step of steps) {
		const requirement = classifyTabPinningStep(step, options.reopenPending === true);
		// A later page action uses the explicit destination, not the remembered tab.
		if (requirement === "destination") {
			return false;
		}
		if (requirement === "page") {
			return true;
		}
	}
	return false;
}

export function shouldCorrectSessionTabAfterCommand(options: {
	readonly command?: string | undefined;
	readonly pinningRequired?: boolean;
	readonly sessionName?: string | undefined;
}): boolean {
	return (
		options.pinningRequired === true &&
		options.sessionName !== undefined &&
		options.command !== undefined &&
		!isSessionTabPostCommandCorrectionExcludedCommand(options.command)
	);
}

interface SessionTab {
	readonly active?: boolean;
	readonly index?: number;
	readonly label?: string | undefined;
	readonly tabId?: string | undefined;
	readonly targetId?: string | undefined;
	readonly title?: string | undefined;
	readonly url?: string | undefined;
}
interface TabSession {
	readonly cwd: string;
	readonly namespace?: string | undefined;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}
interface TargetTabSession extends TabSession {
	readonly target: Readonly<SessionTabTarget>;
}

function getTabSelection(
	tab: SessionTab,
): Pick<OpenResultTabCorrection, "selectedTab" | "selectionKind"> | undefined {
	if ((tab.targetId?.length ?? 0) > 0) {
		return { selectedTab: tab.targetId ?? "", selectionKind: "targetId" };
	}
	if (typeof tab.tabId === "string" && tab.tabId.trim().length > 0) {
		return { selectedTab: tab.tabId.trim(), selectionKind: "tabId" };
	}
	if (typeof tab.label === "string" && tab.label.trim().length > 0) {
		return { selectedTab: tab.label.trim(), selectionKind: "label" };
	}
	return typeof tab.index === "number"
		? { selectedTab: String(tab.index), selectionKind: "index" }
		: undefined;
}

function selectPreferredTab(tabs: readonly SessionTab[], title: string): SessionTab | undefined {
	const titledTabs = title.length > 0 ? tabs.filter((tab) => tab.title?.trim() === title) : [];
	return (
		titledTabs.find((tab) => tab.active === true) ??
		titledTabs.at(0) ??
		tabs.find((tab) => tab.active === true) ??
		tabs.at(0)
	);
}

function selectAnySessionTargetTab(
	tabs: readonly SessionTab[],
	target: Readonly<SessionTabTarget>,
): OpenResultTabCorrection | undefined {
	const targetUrl = typeof target.url === "string" ? normalizeComparableUrl(target.url) : undefined;
	if (targetUrl === undefined || targetUrl.length === 0) {
		return;
	}
	const matchingTabs = tabs.filter((tab) =>
		(target.targetId?.length ?? 0) > 0
			? tab.targetId === target.targetId
			: normalizeComparableUrl(tab.url ?? "") === targetUrl,
	);
	const targetTitle = target.title?.trim() ?? "";
	const selectedTab = selectPreferredTab(matchingTabs, targetTitle);
	const selection = selectedTab ? getTabSelection(selectedTab) : undefined;
	return selection
		? {
				...selection,
				...(targetTitle.length > 0 ? { targetTitle } : {}),
				targetUrl,
			}
		: undefined;
}

function selectSessionTargetTab(
	tabs: readonly SessionTab[],
	target: Readonly<SessionTabTarget>,
): OpenResultTabCorrection | undefined {
	if ((target.targetId?.length ?? 0) > 0) {
		const correction = selectAnySessionTargetTab(tabs, target);
		return correction && tabs.find((tab) => tab.targetId === target.targetId)?.active !== true
			? correction
			: undefined;
	}
	return chooseOpenResultTabCorrection({ tabs, targetTitle: target.title, targetUrl: target.url });
}

function mapTabData(data: unknown): SessionTab[] | undefined {
	if (!isRecord(data) || !Array.isArray(data.tabs)) {
		return;
	}
	return data.tabs.filter(isRecord).map((tab, index) => ({
		active: tab.active === true,
		index: typeof tab.index === "number" ? tab.index : index,
		label: typeof tab.label === "string" ? tab.label : undefined,
		tabId: typeof tab.tabId === "string" ? tab.tabId : undefined,
		targetId: typeof tab.targetId === "string" ? tab.targetId : undefined,
		title: typeof tab.title === "string" ? tab.title : undefined,
		url: typeof tab.url === "string" ? tab.url : undefined,
	}));
}

export async function collectOpenResultTabCorrection(
	options: TabSession & {
		readonly targetTitle?: string | undefined;
		readonly targetUrl?: string | undefined;
	},
): Promise<OpenResultTabCorrection | undefined> {
	const { cwd, namespace, sessionName, signal, targetTitle, targetUrl } = options;
	const tabs = mapTabData(
		await runSessionCommandData({ args: ["tab", "list"], cwd, namespace, sessionName, signal }),
	);
	return tabs ? chooseOpenResultTabCorrection({ tabs, targetTitle, targetUrl }) : undefined;
}

function tabMetadataDisagreesWithObservedUrl(
	tabs: readonly SessionTab[] | undefined,
	active: SessionTab | undefined,
	observedUrl: string | undefined,
): boolean {
	return (
		normalizeComparableUrl(active?.url) !== observedUrl &&
		tabs?.some((tab) => normalizeComparableUrl(tab.url) === observedUrl) === true
	);
}

export async function collectSessionTabTarget(
	options: TargetTabSession,
): Promise<SessionTabTarget> {
	const tabs = mapTabData(await runSessionCommandData({ ...options, args: ["tab", "list"] }));
	const active = tabs?.find((tab) => tab.active === true);
	const observedUrl = normalizeComparableUrl(options.target.url);
	if (tabMetadataDisagreesWithObservedUrl(tabs, active, observedUrl)) {
		return options.target;
	}
	return (active?.targetId?.length ?? 0) > 0
		? { ...options.target, targetId: active?.targetId }
		: options.target;
}

export async function collectSessionTabSelection(
	options: TargetTabSession,
): Promise<OpenResultTabCorrection | undefined> {
	const { cwd, namespace, sessionName, signal, target } = options;
	const tabs = mapTabData(
		await runSessionCommandData({ args: ["tab", "list"], cwd, namespace, sessionName, signal }),
	);
	return tabs ? selectSessionTargetTab(tabs, target) : undefined;
}

async function verifySelectedTabUrl(
	session: TabSession,
	tab: SessionTab,
	targetUrl: string,
): Promise<boolean> {
	if (normalizeComparableUrl(tab.url) === normalizeComparableUrl(targetUrl)) {
		return true;
	}
	// Native tab metadata can retain the attempted URL while get url reports Chrome's error page.
	const data = await runSessionCommandData({ ...session, args: ["get", "url"] });
	return (
		normalizeComparableUrl(extractStringResultField(data, "url")) ===
		normalizeComparableUrl(targetUrl)
	);
}

const TAB_VERIFICATION_ERROR =
	"agent-browser could not re-select and verify the intended tab before running the command. Run tab list and select the intended tab, then snapshot -i before retrying.";

function isSelectedTab(tab: SessionTab | undefined, selectedTab: string): boolean {
	return tab !== undefined && getTabSelection(tab)?.selectedTab === selectedTab;
}

async function verifyTargetTab(
	session: TabSession,
	tab: SessionTab | undefined,
	selectedTab: string,
	targetUrl: string,
): Promise<boolean> {
	if (!tab || !isSelectedTab(tab, selectedTab)) {
		return false;
	}
	return verifySelectedTabUrl(session, tab, targetUrl);
}

export async function ensureSessionTabTarget(
	options: TargetTabSession,
): Promise<{ correction?: OpenResultTabCorrection; error?: string }> {
	const { cwd, namespace, sessionName, signal, target } = options;
	const session = { cwd, namespace, sessionName, signal };
	const tabs = mapTabData(await runSessionCommandData({ ...session, args: ["tab", "list"] }));
	const active = tabs?.find((tab) => tab.active === true);
	const correction = tabs && selectAnySessionTargetTab(tabs, target);
	if (!correction) {
		return { error: TAB_VERIFICATION_ERROR };
	}
	// Native tab selection clears refs and frame scope even when selecting the current tab.
	if (isSelectedTab(active, correction.selectedTab)) {
		return (await verifyTargetTab(session, active, correction.selectedTab, target.url))
			? {}
			: { error: TAB_VERIFICATION_ERROR };
	}
	if (!(await applyOpenResultTabCorrection({ ...session, correction }))) {
		return { correction, error: TAB_VERIFICATION_ERROR };
	}
	const selected = mapTabData(
		await runSessionCommandData({ ...session, args: ["tab", "list"] }),
	)?.find((tab) => tab.active === true);
	const verified = await verifyTargetTab(session, selected, correction.selectedTab, target.url);
	return verified ? { correction } : { correction, error: TAB_VERIFICATION_ERROR };
}

export async function applyOpenResultTabCorrection(
	options: TabSession & { readonly correction: Readonly<OpenResultTabCorrection> },
): Promise<OpenResultTabCorrection | undefined> {
	const { correction, cwd, namespace, sessionName, signal } = options;
	const result = await runSessionCommandData({
		args: ["tab", correction.selectedTab],
		cwd,
		namespace,
		sessionName,
		signal,
	});
	return result === undefined ? undefined : correction;
}
