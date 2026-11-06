import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type { AgentBrowserSourceLookupAnalysis } from "../../input-modes/types.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import { withOptionalSessionArgs } from "../../results/next-actions.js";
import type { SessionTabTarget } from "../../session-page-state.js";
import type { CommandInfo } from "../../argv-descriptor.js";
import { findElectronLaunchRecordForSession } from "./session-state.js";
import {
	getSuccessfulGetTextSelectors,
	selectorMayExposeSensitiveLiteral,
} from "./text-visibility-diagnostics.js";
import type { ElectronBroadGetTextScopeDiagnostic } from "./observation-types.js";

const BROAD_TEXT_SELECTORS = new Set([
	"body",
	"html",
	":root",
	"*",
	"main",
	"div",
	"section",
	"article",
]);

function isBroadGetTextSelector(selector: string | undefined): selector is string {
	if (
		selector === undefined ||
		selector === "" ||
		/^@e\d+$/.test(selector) ||
		selectorMayExposeSensitiveLiteral(selector)
	) {
		return false;
	}
	const normalized = selector.trim().replace(/\s+/g, " ").toLowerCase();
	return (
		BROAD_TEXT_SELECTORS.has(normalized) ||
		/^\[role=(?:"application"|'application'|application)\]$/i.test(normalized)
	);
}

interface ElectronTextContextOptions {
	readonly currentTarget?: SessionTabTarget | undefined;
	readonly electronLaunchRecords: ReadonlyMap<string, ElectronLaunchRecord>;
	readonly namespace?: string | undefined;
	readonly priorTarget?: SessionTabTarget | undefined;
	readonly sessionName?: string | undefined;
}

export function getSourceLookupElectronContext(
	options: ElectronTextContextOptions,
): AgentBrowserSourceLookupAnalysis["electronContext"] | undefined {
	const record = findElectronLaunchRecordForSession(
		options.sessionName,
		options.electronLaunchRecords,
		options.namespace,
	);
	if (!record) {
		return undefined;
	}
	const url = options.currentTarget?.url ?? options.priorTarget?.url;
	return {
		appName: record.appName,
		appPath: record.appPath,
		executablePath: record.executablePath,
		launchId: record.launchId,
		sessionName: record.sessionName ?? options.sessionName,
		url,
	};
}

export function buildSourceLookupElectronNextActions(
	sourceLookup: AgentBrowserSourceLookupAnalysis | undefined,
): AgentBrowserNextAction[] {
	if (sourceLookup?.status !== "no-candidates" || !sourceLookup.electronContext) {
		return [];
	}
	const actions: AgentBrowserNextAction[] = [];
	const { launchId, sessionName } = sourceLookup.electronContext;
	const hasSession = sessionName !== undefined && sessionName !== "";
	if (hasSession) {
		actions.push({
			id: "snapshot-electron-session",
			params: { args: withOptionalSessionArgs(sessionName, ["snapshot", "-i"]) },
			reason:
				"Refresh interactive refs in the attached Electron session before retrying source lookup with a narrower target.",
			safety: "Read-only snapshot; no app mutation.",
			tool: "agent_browser",
		});
	}
	if (launchId !== undefined && launchId !== "") {
		actions.push({
			id: "probe-electron-launch",
			params: { action: "probe", launchId },
			reason:
				"Collect bounded wrapper/session context for the packaged Electron launch after sourceLookup found no candidates.",
			safety: "Read-only probe of title, URL, focus, tabs, and compact snapshot metadata.",
			tool: "agent_browser_electron",
		});
	}
	if (hasSession) {
		actions.push({
			id: "list-electron-tabs",
			params: { args: withOptionalSessionArgs(sessionName, ["tab", "list"]) },
			reason: "Check current Electron tabs/targets before choosing a narrower selector or @ref.",
			safety: "Read-only tab listing.",
			tool: "agent_browser",
		});
	}
	return actions;
}

export function collectElectronBroadGetTextScopeDiagnostics(
	options: ElectronTextContextOptions & {
		readonly commandInfo: CommandInfo;
		readonly commandTokens: readonly string[];
		readonly data: unknown;
	},
): ElectronBroadGetTextScopeDiagnostic[] {
	const context = getSourceLookupElectronContext(options);
	if (!context) {
		return [];
	}
	const electronContext = {
		launchId: context.launchId,
		sessionName: context.sessionName,
		url: context.url,
	};
	return getSuccessfulGetTextSelectors(options)
		.filter(isBroadGetTextSelector)
		.map((selector) => ({
			electronContext,
			selector,
			summary: `Broad Electron get text selector warning: selector ${JSON.stringify(selector)} may read the entire app shell; prefer snapshot -i and a current @ref or a narrower panel selector.`,
		}));
}

export function formatElectronBroadGetTextScopeText(
	diagnostics: readonly ElectronBroadGetTextScopeDiagnostic[],
): string | undefined {
	return diagnostics.length > 0
		? diagnostics.map((diagnostic) => diagnostic.summary).join("\n")
		: undefined;
}

export function buildElectronBroadGetTextScopeNextActions(options: {
	readonly diagnostics: readonly ElectronBroadGetTextScopeDiagnostic[];
	readonly sessionName?: string | undefined;
}): AgentBrowserNextAction[] {
	return options.diagnostics.map((diagnostic, index): AgentBrowserNextAction => ({
		id:
			index === 0
				? "snapshot-for-electron-text-scope"
				: `snapshot-for-electron-text-scope-${index + 1}`,
		params: { args: withOptionalSessionArgs(options.sessionName, ["snapshot", "-i"]) },
		reason: `Refresh Electron refs before trusting broad get text selector ${JSON.stringify(diagnostic.selector)}.`,
		safety:
			"Read-only snapshot; prefer a current @ref or narrower selector before extracting app-shell text.",
		tool: "agent_browser",
	}));
}
