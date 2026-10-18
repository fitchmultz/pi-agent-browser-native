import { getAgentBrowserSessionIdentityKey } from "../../argv-grammar.js";
import { isElectronPostCommandHealthCommand } from "../../command-taxonomy.js";
import type { ElectronLaunchStatus } from "../../electron/cleanup.js";
import type { ElectronCdpTarget, ElectronLaunchRecord } from "../../electron/launch.js";
import { buildAgentBrowserNextActions } from "../../results/action-recommendations.js";
import type { AgentBrowserNextAction } from "../../results/contracts.js";
import {
	isAboutBlankUrl,
	normalizeComparableUrl,
	type SessionTabTarget,
} from "../../session-page-state.js";
import { getGuardedRefUsage } from "./session-state-refs.js";
import { presentElectronManagedSessionTarget } from "./final-result-electron.js";
import type {
	ElectronManagedSessionTarget,
	ElectronPostCommandHealthDiagnostic,
	ElectronPostCommandHealthReason,
	ElectronRefFreshnessDiagnostic,
	ElectronSessionMismatch,
	ElectronSessionMismatchReason,
} from "./types.js";

export function isLiveElectronRendererTarget(target: Readonly<ElectronCdpTarget>): boolean {
	const normalizedUrl = normalizeComparableUrl(target.url);
	if (
		normalizedUrl === undefined ||
		normalizedUrl.length === 0 ||
		normalizedUrl === "about:blank" ||
		normalizedUrl.startsWith("devtools://")
	) {
		return false;
	}
	return target.type === undefined || target.type === "page" || target.type === "webview";
}

export function getLiveElectronRendererTargets(
	targets: readonly Readonly<ElectronCdpTarget>[],
): ElectronCdpTarget[] {
	return targets.filter(isLiveElectronRendererTarget);
}

export function electronTargetLabel(target: Readonly<ElectronCdpTarget> | undefined): string {
	if (!target) {
		return "unknown target";
	}
	return (
		[target.title, target.url, target.id].find(
			(value) => typeof value === "string" && value.trim().length > 0,
		) ?? "unknown target"
	);
}

export function getActiveElectronRecords(
	records: ReadonlyMap<string, Readonly<ElectronLaunchRecord>>,
): ElectronLaunchRecord[] {
	return [...records.values()].filter((record) =>
		["active", "dead", "partial", "failed"].includes(record.cleanupState),
	);
}

export function findElectronLaunchRecordForSession(
	sessionName: string | undefined,
	records: ReadonlyMap<string, Readonly<ElectronLaunchRecord>>,
	namespace?: string,
): ElectronLaunchRecord | undefined {
	if (sessionName === undefined || sessionName.length === 0) {
		return;
	}
	const sessionKey = getAgentBrowserSessionIdentityKey(sessionName, namespace);
	return getActiveElectronRecords(records).find(
		(record) =>
			(record.sessionName?.length ?? 0) > 0 &&
			getAgentBrowserSessionIdentityKey(record.sessionName ?? "", record.namespace) === sessionKey,
	);
}

function buildElectronReattachNextAction(
	record: Readonly<ElectronLaunchRecord>,
	liveTarget?: Readonly<ElectronCdpTarget>,
): AgentBrowserNextAction {
	const endpoint =
		liveTarget?.webSocketDebuggerUrl ?? record.webSocketDebuggerUrl ?? String(record.port);
	return {
		id: "reattach-electron-launch",
		params: { args: ["connect", endpoint], sessionMode: "fresh" },
		reason:
			"Attach a fresh managed session to the same wrapper-tracked Electron debug endpoint when the current session no longer matches the live renderer.",
		safety:
			"Creates a new managed browser session; it does not mutate the Electron app. Keep the launchId for later status and cleanup.",
		tool: "agent_browser",
	};
}

export function buildElectronLifecycleNextActions(
	record: Readonly<ElectronLaunchRecord>,
): readonly AgentBrowserNextAction[] {
	return (
		buildAgentBrowserNextActions({
			electron: {
				launchId: record.launchId,
				sessionName: record.sessionName,
				status: record.cleanupState,
			},
			resultCategory: "success",
			successCategory: "completed",
		}) ?? []
	);
}

export function buildElectronMismatchNextActions(
	record: Readonly<ElectronLaunchRecord>,
	liveTarget?: Readonly<ElectronCdpTarget>,
): AgentBrowserNextAction[] {
	const reattachAction = buildElectronReattachNextAction(record, liveTarget);
	const actions: AgentBrowserNextAction[] = [];
	for (const action of buildElectronLifecycleNextActions(record)) {
		actions.push(action);
		if (action.id === "probe-electron-launch") {
			actions.push(reattachAction);
		}
	}
	if (!actions.some((action) => action.id === reattachAction.id)) {
		actions.push(reattachAction);
	}
	return actions;
}

function getElectronMismatchReason(
	managedSession: ElectronManagedSessionTarget,
	recordSessionName: string | undefined,
): ElectronSessionMismatchReason | undefined {
	if (isAboutBlankUrl(managedSession.url)) {
		return "managed-session-about-blank-while-launch-target-live";
	}
	if ((recordSessionName?.length ?? 0) > 0 && recordSessionName !== managedSession.sessionName) {
		return "launch-session-not-current";
	}
	if ((normalizeComparableUrl(managedSession.url)?.length ?? 0) > 0) {
		return "managed-session-target-not-in-launch-status";
	}
	return;
}

function describeElectronMismatch(
	managedSession: ElectronManagedSessionTarget,
	record: Readonly<ElectronLaunchRecord>,
	liveTarget: Readonly<ElectronCdpTarget>,
	reason: ElectronSessionMismatchReason,
): string {
	const managedDescription =
		managedSession.url ?? managedSession.title ?? managedSession.sessionName;
	const liveDescription = electronTargetLabel(liveTarget);
	return reason === "launch-session-not-current"
		? `Electron session mismatch: current managed session ${managedSession.sessionName} is not the wrapper launch session ${record.sessionName ?? "unknown"}, while launch ${record.launchId} still has live target ${liveDescription}.`
		: `Electron session mismatch: managed session ${managedSession.sessionName} is on ${managedDescription}, but launch ${record.launchId} still has live target ${liveDescription}.`;
}

export function buildElectronSessionMismatch(options: {
	readonly managedSession: ElectronManagedSessionTarget;
	readonly record: Readonly<ElectronLaunchRecord>;
	readonly statusTargets: readonly Readonly<ElectronCdpTarget>[];
}): ElectronSessionMismatch | undefined {
	const liveTargets = getLiveElectronRendererTargets(options.statusTargets);
	if (liveTargets.length === 0) {
		return;
	}
	const managedUrl = normalizeComparableUrl(options.managedSession.url);
	const matchingLiveTarget =
		(managedUrl?.length ?? 0) > 0
			? liveTargets.find((target) => normalizeComparableUrl(target.url) === managedUrl)
			: undefined;
	if (matchingLiveTarget) {
		return;
	}
	const liveTarget = liveTargets[0];
	const reason = getElectronMismatchReason(options.managedSession, options.record.sessionName);
	if (reason === undefined) {
		return;
	}
	const nextActions = buildElectronMismatchNextActions(options.record, liveTarget);
	const managedSession = presentElectronManagedSessionTarget(options.managedSession);
	return {
		launchId: options.record.launchId,
		liveTarget,
		managedSession,
		nextActionIds: nextActions.map((action) => action.id),
		reason,
		sessionName: options.record.sessionName,
		statusTargets: options.statusTargets,
		summary: describeElectronMismatch(managedSession, options.record, liveTarget, reason),
	};
}

export function formatElectronSessionMismatchText(mismatch: ElectronSessionMismatch): string {
	return `${mismatch.summary}\nNext: run electron.status/electron.probe with launchId ${mismatch.launchId}, reattach with the reattach-electron-launch nextAction if needed, or cleanup when finished.`;
}

export function shouldInspectElectronPostCommandHealth(command: string | undefined): boolean {
	return isElectronPostCommandHealthCommand(command);
}

function getElectronHealthReason(
	status: ElectronLaunchStatus,
	targetUrl: string | undefined,
): ElectronPostCommandHealthReason | undefined {
	if (status.pidAlive === false) {
		return "process-dead";
	}
	if (!status.portAlive) {
		return "debug-port-dead";
	}
	if (isAboutBlankUrl(targetUrl) && getLiveElectronRendererTargets(status.targets).length === 0) {
		return "about-blank-no-live-target";
	}
	return;
}

function formatElectronHealthStatus(
	status: Readonly<Pick<ElectronLaunchStatus, "portAlive" | "pidAlive">>,
): string {
	const portText = status.portAlive ? "debug port alive" : "debug port dead";
	if (status.pidAlive === undefined) {
		return portText;
	}
	return `${portText}${status.pidAlive ? ", pid alive" : ", pid dead"}`;
}

export function buildElectronPostCommandHealthDiagnostic(options: {
	readonly command?: string;
	readonly record: Readonly<ElectronLaunchRecord>;
	readonly status: ElectronLaunchStatus;
	readonly target?: Readonly<SessionTabTarget>;
}): ElectronPostCommandHealthDiagnostic | undefined {
	const reason = getElectronHealthReason(options.status, options.target?.url);
	if (reason === undefined) {
		return;
	}
	const nextActions = buildElectronLifecycleNextActions(options.record);
	const commandText =
		(options.command?.length ?? 0) > 0 ? `${options.command ?? ""} command` : "command";
	return {
		appName: options.record.appName,
		command: options.command,
		launchId: options.record.launchId,
		nextActionIds: nextActions.map((action) => action.id),
		reason,
		sessionName: options.record.sessionName,
		status: options.status,
		summary: `Electron lifecycle warning: ${commandText} completed, but launch ${options.record.launchId} is no longer healthy (${formatElectronHealthStatus(options.status)}).`,
		target: options.target,
	};
}

export function formatElectronPostCommandHealthText(
	diagnostic: ElectronPostCommandHealthDiagnostic | undefined,
): string | undefined {
	if (!diagnostic) {
		return;
	}
	const lines = [diagnostic.summary];
	if ((diagnostic.target?.url.length ?? 0) > 0) {
		lines.push(`Current browser session target: ${diagnostic.target?.url ?? ""}.`);
	}
	lines.push(
		`Status: ${formatElectronHealthStatus(diagnostic.status)}; ${diagnostic.status.targets.length} CDP target(s).`,
		`Next: run electron.status/electron.probe with launchId ${diagnostic.launchId}, cleanup the wrapper-owned launch if dead, or relaunch the app.`,
	);
	return lines.join("\n");
}

export function buildElectronIdentifiers(record: Readonly<ElectronLaunchRecord>): {
	appName: string;
	launchId: string;
	sessionName?: string;
} {
	return { appName: record.appName, launchId: record.launchId, sessionName: record.sessionName };
}

export function buildElectronRefFreshnessNextActions(
	sessionName: string | undefined,
): AgentBrowserNextAction[] {
	return [
		{
			id: "refresh-electron-refs-after-rerender",
			params: {
				args:
					(sessionName?.length ?? 0) > 0
						? ["--session", sessionName ?? "", "snapshot", "-i"]
						: ["snapshot", "-i"],
			},
			reason:
				"Electron UIs often rerender without changing URL; refresh refs before using old @e handles again.",
			safety:
				"Read-only snapshot; avoids stale same-URL refs after quick-pick, modal, theme, or editor rerenders.",
			tool: "agent_browser",
		},
	];
}

export function buildElectronRefFreshnessDiagnostic(options: {
	readonly command?: string;
	readonly commandTokens: readonly string[];
	readonly record?: Readonly<ElectronLaunchRecord>;
	readonly sessionName?: string;
	readonly stdin?: string;
}): ElectronRefFreshnessDiagnostic | undefined {
	if (!options.record || !shouldInspectElectronPostCommandHealth(options.command)) {
		return;
	}
	if (getGuardedRefUsage(options.commandTokens, options.stdin).length === 0) {
		return;
	}
	const nextActions = buildElectronRefFreshnessNextActions(options.sessionName);
	return {
		command: options.command,
		launchId: options.record.launchId,
		nextActionIds: nextActions.map((action) => action.id),
		sessionName: options.sessionName,
		summary: `Electron ref freshness: ${options.command ?? "mutation"} used page-scoped refs in an Electron UI. Re-run snapshot -i before reusing old @e refs, even if the URL did not change.`,
	};
}

export function formatElectronRefFreshnessText(
	diagnostic: ElectronRefFreshnessDiagnostic | undefined,
): string | undefined {
	return diagnostic?.summary;
}
