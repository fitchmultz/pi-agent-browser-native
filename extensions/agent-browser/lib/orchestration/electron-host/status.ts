import { inspectElectronLaunchStatus, type ElectronLaunchStatus } from "../../electron/cleanup.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type { CompiledAgentBrowserElectron } from "../../input-modes/types.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { buildAgentBrowserNextActions } from "../../results/action-recommendations.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { appendUniqueAgentBrowserNextActions } from "../../results/next-actions.js";
import { redactSensitiveText } from "../../runtime-redaction.js";
import { getSessionPageStateKey } from "../../session-page-state.js";
import {
	buildElectronHostFailureResult,
	formatElectronTargetLines,
	redactToolDetails,
} from "../browser-run/final-result.js";
import {
	buildElectronIdentifiers,
	buildElectronMismatchNextActions,
	buildElectronSessionMismatch,
	formatElectronSessionMismatchText,
} from "../browser-run/session-state.js";
import type {
	AgentBrowserToolResult,
	ElectronManagedSessionTarget,
	ElectronSessionMismatch,
} from "../browser-run/types.js";
import { selectElectronRecords } from "./branch.js";
import type { ElectronHostObservationInput } from "./contracts.js";
import { collectOwnedElectronManagedSessionTarget } from "./policy.js";
import { presentElectronManagedSessionTarget } from "../browser-run/final-result-electron.js";

function pidStatusText(pidAlive: boolean | undefined): string {
	if (pidAlive === undefined) {
		return "";
	}
	return pidAlive ? ", pid alive" : ", pid dead";
}
function formatLaunchHeadline(
	status: Pick<
		ElectronLaunchStatus,
		"launchId" | "portAlive" | "pidAlive" | "port" | "cleanupState"
	>,
	record: Pick<ElectronLaunchRecord, "sessionName" | "appName"> | undefined,
): string {
	const sessionName = record?.sessionName;
	const sessionText =
		sessionName !== undefined && sessionName.length > 0 ? `, sessionName ${sessionName}` : "";
	const historyText = status.cleanupState === "cleaned" ? "; historical cleaned launch record" : "";
	return `- ${status.launchId}: ${record?.appName ?? "Electron launch"}${sessionText}${historyText}; ${status.portAlive ? "debug port alive" : "debug port dead"}${pidStatusText(status.pidAlive)} (port ${status.port})`;
}
function formatLaunchStatus(
	status: ElectronLaunchStatus,
	record: ElectronLaunchRecord | undefined,
	managedSession: Readonly<ElectronManagedSessionTarget> | undefined,
): readonly string[] {
	const sessionName = record?.sessionName;
	const lines = [
		formatLaunchHeadline(status, record),
		`  Tracked profile path: ${status.userDataDirState}.`,
		`  Identifiers: launchId ${status.launchId}; sessionName ${sessionName ?? "not attached"}.`,
		...formatElectronTargetLines(status.targets, 4).map((line) => `  ${line}`),
	];
	if (managedSession?.error !== undefined && managedSession.error.length > 0) {
		lines.push(`  Managed session warning: ${managedSession.error}`);
	}
	return lines;
}
interface StatusObservation {
	readonly compiledElectron: CompiledAgentBrowserElectron;
	readonly managedSessions: readonly Readonly<ElectronManagedSessionTarget>[];
	readonly mismatches: readonly ElectronSessionMismatch[];
	readonly records: readonly ElectronLaunchRecord[];
	readonly statuses: readonly ElectronLaunchStatus[];
}
function formatElectronStatusVisibleText(options: StatusObservation): string {
	if (options.statuses.length === 0) {
		return "Electron status: no active wrapper-tracked launches.";
	}
	const recordsByLaunchId = new Map(options.records.map((record) => [record.launchId, record]));
	const sessionsByName = new Map(
		options.managedSessions.map((session) => [session.sessionName, session]),
	);
	const lines = [`Electron status: ${options.statuses.length} wrapper-tracked launch(es).`];
	for (const status of options.statuses) {
		const record = recordsByLaunchId.get(status.launchId);
		const name = record?.sessionName;
		const session = name !== undefined && name.length > 0 ? sessionsByName.get(name) : undefined;
		lines.push(...formatLaunchStatus(status, record, session));
	}
	for (const mismatch of options.mismatches) {
		lines.push("", formatElectronSessionMismatchText(mismatch));
	}
	return lines.join("\n");
}
function statusNextActions(
	options: StatusObservation,
): ReturnType<typeof appendUniqueAgentBrowserNextActions> {
	const base = options.records.flatMap(
		(record) =>
			buildAgentBrowserNextActions({
				electron: {
					launchId: record.launchId,
					sessionName: record.sessionName,
					status: record.cleanupState,
				},
				resultCategory: "success",
				successCategory: "completed",
			}) ?? [],
	);
	const mismatch = options.mismatches.flatMap((row) => {
		const record = options.records.find((candidate) => candidate.launchId === row.launchId);
		return record ? buildElectronMismatchNextActions(record, row.liveTarget) : [];
	});
	return options.mismatches.length > 0
		? appendUniqueAgentBrowserNextActions([...mismatch], base)
		: appendUniqueAgentBrowserNextActions([...base], mismatch);
}
function buildElectronStatusResult(options: StatusObservation): AgentBrowserToolResult {
	const nextActions = statusNextActions(options);
	const managedSessions = options.managedSessions.map(presentElectronManagedSessionTarget);
	const soleRecord = options.records.length === 1 ? options.records[0] : undefined;
	const details = {
		args: [],
		compiledElectron: options.compiledElectron,
		electron: {
			action: "status" as const,
			identifierList:
				options.records.length > 1 ? options.records.map(buildElectronIdentifiers) : undefined,
			identifiers: soleRecord ? buildElectronIdentifiers(soleRecord) : undefined,
			launches: options.records,
			managedSession: managedSessions.length === 1 ? managedSessions[0] : undefined,
			managedSessions: managedSessions.length > 0 ? managedSessions : undefined,
			sessionMismatch: options.mismatches.length === 1 ? options.mismatches[0] : undefined,
			sessionMismatches: options.mismatches.length > 1 ? options.mismatches : undefined,
			status: "succeeded" as const,
			statuses: options.statuses,
			targets: options.statuses.flatMap((status) => status.targets),
		},
		nextActions: nextActions.length > 0 ? nextActions : undefined,
		...buildAgentBrowserResultCategoryDetails({ args: [], succeeded: true }),
		summary:
			options.statuses.length === 0
				? "Electron status found no active wrapper-tracked launches."
				: `Electron status inspected ${options.statuses.length} launch(es).`,
	};
	return {
		content: [
			{ type: "text", text: redactSensitiveText(formatElectronStatusVisibleText(options)) },
		],
		details: redactToolDetails(details, []),
		isError: false,
	};
}
function collectStatusManagedSessions(
	options: Pick<
		ElectronHostObservationInput,
		"sessionPageState" | "ownedManagedSessions" | "managedSessionRestoreState" | "cwd" | "signal"
	>,
	records: readonly ElectronLaunchRecord[],
	timeoutMs: number | undefined,
): Promise<ElectronManagedSessionTarget[]> {
	return Promise.all(
		records
			.filter(
				(record): record is ElectronLaunchRecord & { readonly sessionName: string } =>
					typeof record.sessionName === "string",
			)
			.map((record) => {
				const key =
					getSessionPageStateKey(record.sessionName, record.namespace) ?? record.sessionName;
				const owner = options.ownedManagedSessions.get(key);
				return collectOwnedElectronManagedSessionTarget({
					confirmActions:
						options.sessionPageState.get(key).confirmActions ??
						getAgentBrowserProcessEnvironment().AGENT_BROWSER_CONFIRM_ACTIONS,
					cwd: options.cwd,
					electronLaunchRecord: record,
					headedManagedAutosaveDisabled: owner?.headedManagedAutosaveDisabled,
					headedManagedAutosaveInterval: owner?.headedManagedAutosaveInterval,
					namespace: record.namespace,
					restoreState: options.managedSessionRestoreState,
					sessionName: record.sessionName,
					signal: options.signal,
					timeoutMs,
				});
			}),
	);
}
function statusMismatches(
	records: readonly ElectronLaunchRecord[],
	statuses: readonly ElectronLaunchStatus[],
	managedSessions: readonly Readonly<ElectronManagedSessionTarget>[],
): ElectronSessionMismatch[] {
	return managedSessions
		.map((session) => {
			const record = records.find(
				(candidate) =>
					candidate.sessionName === session.sessionName &&
					candidate.namespace === session.namespace,
			);
			const status = record
				? statuses.find((candidate) => candidate.launchId === record.launchId)
				: undefined;
			return record && status
				? buildElectronSessionMismatch({
						managedSession: session,
						record,
						statusTargets: status.targets,
					})
				: undefined;
		})
		.filter((mismatch): mismatch is ElectronSessionMismatch => mismatch !== undefined);
}
export async function inspectElectronHostLaunches(
	options: Pick<
		ElectronHostObservationInput,
		| "electronLaunchRecords"
		| "sessionPageState"
		| "ownedManagedSessions"
		| "managedSessionRestoreState"
		| "cwd"
		| "signal"
	>,
	compiledElectron: Extract<CompiledAgentBrowserElectron, { action: "cleanup" | "status" }>,
	visibleInput: CompiledAgentBrowserElectron,
): Promise<AgentBrowserToolResult> {
	const selection = selectElectronRecords(compiledElectron, options.electronLaunchRecords);
	if (selection.error !== undefined && selection.error.length > 0) {
		return buildElectronHostFailureResult({
			compiledElectron: visibleInput,
			errorText: selection.error,
			failureCategory: "validation-error",
		});
	}
	const records = selection.records ?? [];
	const statuses = await Promise.all(records.map((record) => inspectElectronLaunchStatus(record)));
	const managedSessions = await collectStatusManagedSessions(
		options,
		records,
		compiledElectron.timeoutMs,
	);
	const mismatches = statusMismatches(records, statuses, managedSessions);
	return buildElectronStatusResult({
		compiledElectron: visibleInput,
		managedSessions,
		mismatches,
		records,
		statuses,
	});
}
