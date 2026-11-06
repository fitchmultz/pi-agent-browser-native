import { isRecord } from "../parsing.js";
import type { CompiledAgentBrowserElectron } from "../input-modes/types.js";
import {
	findElectronLaunchRecordForSession,
	getActiveElectronRecords,
	getSessionContextKey,
} from "./browser-run/session-state.js";
import type { ElectronLaunchRecord } from "./electron-host/index.js";
import { untrackOwnedManagedSession } from "./extension-managed-ownership.js";
import type {
	OwnedManagedSessionStore,
	ElectronClosedManagedSessionIdentity,
} from "./extension-resource-contracts.js";
import type { ChildProcess } from "node:child_process";

type ElectronRecordMap = ReadonlyMap<string, Readonly<ElectronLaunchRecord>>;
interface ElectronMergeOptions {
	readonly markBranchOwned?: boolean;
	readonly ownerSessionId?: string;
	readonly touchedLaunchIds?: ReadonlySet<string> | undefined;
}

export function getTouchedElectronLaunchIds(
	sessionName: string | undefined,
	records: ElectronRecordMap,
	namespace?: string,
): Set<string> | undefined {
	const record = findElectronLaunchRecordForSession(sessionName, records, namespace);
	return record ? new Set([record.launchId]) : undefined;
}

/** Branch-visible launches, live cleanup ownership, and their native child handles. */
export class BrowserElectronResources {
	records = new Map<string, ElectronLaunchRecord>();
	ownedRecords = new Map<string, ElectronLaunchRecord>();
	branchOwnedIds = new Set<string>();
	childProcesses = new Map<string, ChildProcess>();
	mergeActive(source: ElectronRecordMap, options: ElectronMergeOptions = {}): void {
		const target = this.ownedRecords;
		const branchOwned = this.branchOwnedIds;
		for (const record of getActiveElectronRecords(source)) {
			if (
				options.ownerSessionId !== undefined &&
				record.ownerSessionId !== options.ownerSessionId
			) {
				continue;
			}
			const alreadyRuntimeOwned = target.has(record.launchId) && !branchOwned.has(record.launchId);
			target.set(record.launchId, record);
			if (alreadyRuntimeOwned) {
				continue;
			}
			if (options.markBranchOwned === true) {
				branchOwned.add(record.launchId);
			} else if (options.touchedLaunchIds?.has(record.launchId) === true) {
				branchOwned.delete(record.launchId);
			}
		}
	}

	removeInactive(
		source: ElectronRecordMap,
		activeRanks: ReadonlyMap<string, number>,
		cleanupRanks: ReadonlyMap<string, number>,
	): void {
		const target = this.ownedRecords;
		const branchOwned = this.branchOwnedIds;
		const activeIds = new Set(getActiveElectronRecords(source).map((record) => record.launchId));
		for (const id of new Set([...source.keys(), ...cleanupRanks.keys()])) {
			if (!target.has(id) || !branchOwned.has(id)) {
				continue;
			}
			const active = activeRanks.get(id),
				cleanup = cleanupRanks.get(id);
			const inactive = source.has(id) && !activeIds.has(id);
			const cleanupIsLatest = cleanup !== undefined && (active === undefined || cleanup > active);
			if (!inactive && !cleanupIsLatest) {
				continue;
			}
			target.delete(id);
			branchOwned.delete(id);
		}
	}

	replaceActive(source: ElectronRecordMap, cleanedLaunchIds?: ReadonlySet<string>): void {
		this.ownedRecords.clear();
		if (cleanedLaunchIds) {
			for (const id of cleanedLaunchIds) {
				this.branchOwnedIds.delete(id);
			}
		} else {
			this.branchOwnedIds.clear();
		}
		this.mergeActive(source);
	}
	forHostInput(options: {
		readonly compiledElectron: CompiledAgentBrowserElectron | undefined;
		readonly ownerSessionId: string;
	}): Map<string, ElectronLaunchRecord> {
		if (options.compiledElectron?.action === "cleanup") {
			return new Map(
				[...mergeElectronLaunchRecordMaps(this.records, this.ownedRecords)].filter(
					([, record]) => record.ownerSessionId === options.ownerSessionId,
				),
			);
		}
		if (
			options.compiledElectron?.action === "status" ||
			(options.compiledElectron?.action === "probe" &&
				options.compiledElectron.launchId !== undefined &&
				options.compiledElectron.launchId !== "")
		) {
			return mergeElectronLaunchRecordMaps(this.records, this.ownedRecords);
		}
		return this.records;
	}
	mergeCleanup(results: readonly unknown[]): void {
		for (const record of getCleanupResultsElectronRecords(results)) {
			this.records.set(record.launchId, record);
		}
	}
	resetOwnership(): void {
		this.ownedRecords = new Map();
		this.branchOwnedIds = new Set();
	}
	reset(): void {
		this.records = new Map();
		this.resetOwnership();
		this.childProcesses = new Map();
	}
}
export function mergeElectronLaunchRecordMaps(
	...maps: readonly ElectronRecordMap[]
): Map<string, ElectronLaunchRecord> {
	const merged = new Map<string, ElectronLaunchRecord>();
	for (const map of maps) {
		for (const [id, record] of map) {
			merged.set(id, record);
		}
	}
	return merged;
}
export function shouldSerializeElectronHostInput(
	compiledElectron: CompiledAgentBrowserElectron | undefined,
): boolean {
	return (
		compiledElectron?.action === "status" ||
		compiledElectron?.action === "probe" ||
		compiledElectron?.action === "cleanup"
	);
}

function cleanupIdentityField(
	step: Readonly<Record<string, unknown>>,
	record: Readonly<Record<string, unknown>> | undefined,
	field: "namespace" | "sessionName",
	fallback?: string,
): string | undefined {
	const value = step[field];
	if (typeof value === "string") {
		return value;
	}
	const retained = record?.[field];
	return typeof retained === "string" ? retained : fallback;
}

function isClosedManagedSessionStep(step: unknown): step is Readonly<Record<string, unknown>> {
	return (
		isRecord(step) &&
		step.resource === "managed-session" &&
		(step.state === "removed" || step.state === "already-gone")
	);
}
export function getCleanupResultClosedManagedSessionIdentities(
	result: unknown,
	fallbackNamespace?: string,
): ElectronClosedManagedSessionIdentity[] {
	if (!isRecord(result) || !Array.isArray(result.steps)) {
		return [];
	}
	const identities = new Map<string, ElectronClosedManagedSessionIdentity>();
	const record = isRecord(result.record) ? result.record : undefined;
	for (const step of result.steps) {
		if (!isClosedManagedSessionStep(step)) {
			continue;
		}
		const sessionName = cleanupIdentityField(step, record, "sessionName");
		if (sessionName === undefined || sessionName === "") {
			continue;
		}
		const namespace = cleanupIdentityField(step, record, "namespace", fallbackNamespace);
		identities.set(getSessionContextKey(sessionName, namespace) ?? sessionName, {
			namespace,
			sessionName,
		});
	}
	return [...identities.values()];
}

export function getCleanupResultsClosedManagedSessionIdentities(
	results: readonly unknown[],
	fallbackNamespace?: string,
): ElectronClosedManagedSessionIdentity[] {
	const identities = new Map<string, ElectronClosedManagedSessionIdentity>();
	for (const result of results) {
		for (const identity of getCleanupResultClosedManagedSessionIdentities(
			result,
			fallbackNamespace,
		)) {
			identities.set(
				getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName,
				identity,
			);
		}
	}
	return [...identities.values()];
}

function validElectronRecordIdentity(value: Readonly<Record<string, unknown>>): boolean {
	return (
		value.version === 1 &&
		(value.namespace === undefined || typeof value.namespace === "string") &&
		typeof value.launchId === "string" &&
		typeof value.appName === "string"
	);
}

export function isElectronLaunchRecord(value: unknown): value is ElectronLaunchRecord {
	if (!isRecord(value)) {
		return false;
	}
	return (
		validElectronRecordIdentity(value) &&
		value.launchedByWrapper === true &&
		typeof value.executablePath === "string" &&
		typeof value.userDataDir === "string" &&
		typeof value.port === "number" &&
		typeof value.createdAtMs === "number"
	);
}

export function getCleanupResultsElectronRecords(
	results: readonly unknown[],
): ElectronLaunchRecord[] {
	return results
		.map((result) => (isRecord(result) ? result.record : undefined))
		.filter(isElectronLaunchRecord);
}

export function getCleanupResultsPreservedUserDataDirs(results: readonly unknown[]): string[] {
	const dirs = new Set<string>();
	for (const result of results) {
		if (
			!isRecord(result) ||
			!Array.isArray(result.steps) ||
			!isElectronLaunchRecord(result.record)
		) {
			continue;
		}
		const step: unknown = result.steps.find(
			(row) => isRecord(row) && row.resource === "user-data-dir",
		);
		if (!isRecord(step)) {
			continue;
		}
		if (step.state === "skipped" || step.state === "failed") {
			dirs.add(result.record.userDataDir);
		}
	}
	return [...dirs];
}

export function syncElectronCleanupManagedSessions(
	sessions: OwnedManagedSessionStore,
	results: readonly unknown[],
	fallbackNamespace?: string,
): void {
	for (const identity of getCleanupResultsClosedManagedSessionIdentities(
		results,
		fallbackNamespace,
	)) {
		untrackOwnedManagedSession(sessions, identity.sessionName, identity.namespace);
	}
}

export function getOffBranchOwnedElectronLaunchRecords(
	ownedRecords: ElectronRecordMap,
	branchRecords: ElectronRecordMap,
): Map<string, ElectronLaunchRecord> {
	const activeIds = new Set(
		getActiveElectronRecords(branchRecords).map((record) => record.launchId),
	);
	const offBranch = new Map<string, ElectronLaunchRecord>();
	for (const record of getActiveElectronRecords(ownedRecords)) {
		if (!activeIds.has(record.launchId)) {
			offBranch.set(record.launchId, record);
		}
	}
	return offBranch;
}
