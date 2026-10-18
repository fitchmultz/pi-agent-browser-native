import { getBrowserResultMessage } from "../../browser-transcript.js";
import type { ElectronLaunchRecord } from "../../electron/launch.js";
import type { CompiledAgentBrowserElectron } from "../../input-modes/types.js";
import { isRecord } from "../../parsing.js";
import { getActiveElectronRecords } from "../browser-run/session-state.js";
import type { ElectronHostLaunchRecords } from "./contracts.js";

function isLaunchIdentity(value: Readonly<Record<string, unknown>>): boolean {
	return (
		value.version === 1 &&
		value.launchedByWrapper === true &&
		typeof value.launchId === "string" &&
		typeof value.appName === "string" &&
		typeof value.executablePath === "string" &&
		typeof value.userDataDir === "string" &&
		typeof value.port === "number" &&
		typeof value.createdAtMs === "number"
	);
}
function hasValidOptionalFields(value: Readonly<Record<string, unknown>>): boolean {
	const strings = [
		"ownerSessionId",
		"appPath",
		"bundleId",
		"desktopId",
		"namespace",
		"packageSource",
		"platform",
		"sessionName",
		"startIdentity",
		"webSocketDebuggerUrl",
	];
	return (
		strings.every((field) => value[field] === undefined || typeof value[field] === "string") &&
		["pid", "processGroupId"].every(
			(field) => value[field] === undefined || typeof value[field] === "number",
		)
	);
}
function isCleanupState(value: unknown): boolean {
	return (
		typeof value === "string" && ["active", "cleaned", "dead", "failed", "partial"].includes(value)
	);
}
function isTargetType(value: unknown): boolean {
	return value === undefined || value === "any" || value === "page" || value === "webview";
}
function isElectronLaunchRecord(value: unknown): value is ElectronLaunchRecord {
	if (!isRecord(value) || !isLaunchIdentity(value) || !hasValidOptionalFields(value)) {
		return false;
	}
	return isCleanupState(value.cleanupState) && isTargetType(value.targetType);
}
function cleanupLaunchRecords(electron: Readonly<Record<string, unknown>>): readonly unknown[] {
	return isRecord(electron.cleanup) && Array.isArray(electron.cleanup.records)
		? electron.cleanup.records
		: [];
}
function restoredRecords(entry: unknown): readonly ElectronLaunchRecord[] {
	const message = getBrowserResultMessage(entry);
	if (!message) {
		return [];
	}
	const details = isRecord(message.details) ? message.details : undefined;
	const electron = isRecord(details?.electron) ? details.electron : undefined;
	if (!electron) {
		return [];
	}
	const namespace = typeof details?.namespace === "string" ? details.namespace : undefined;
	const cleanupRecords = cleanupLaunchRecords(electron);
	const records: ElectronLaunchRecord[] = [];
	for (const record of [electron.launch, ...cleanupRecords].filter(isElectronLaunchRecord)) {
		records.push({ ...record, namespace: record.namespace ?? namespace });
	}
	return records;
}
export function restoreElectronLaunchRecordsFromBranch(
	branch: readonly unknown[],
): ElectronHostLaunchRecords {
	const records: ElectronHostLaunchRecords = new Map();
	for (const entry of branch) {
		for (const record of restoredRecords(entry)) {
			records.set(record.launchId, record);
		}
	}
	return records;
}
export function selectElectronRecords(
	compiledElectron: Extract<CompiledAgentBrowserElectron, { action: "cleanup" | "status" }>,
	records: ReadonlyMap<string, ElectronLaunchRecord>,
): { readonly error?: string; readonly records?: readonly ElectronLaunchRecord[] } {
	if (compiledElectron.launchId !== undefined && compiledElectron.launchId.length > 0) {
		const record = records.get(compiledElectron.launchId);
		return record
			? { records: [record] }
			: {
					error: `No wrapper-tracked Electron launch found for launchId ${compiledElectron.launchId}.`,
				};
	}
	if (compiledElectron.all === true) {
		return { records: getActiveElectronRecords(records) };
	}
	const activeRecords = getActiveElectronRecords(records);
	if (activeRecords.length > 1) {
		return {
			error:
				"Multiple wrapper-tracked Electron launches are active; pass electron.launchId or electron.all.",
		};
	}
	return { records: activeRecords };
}
