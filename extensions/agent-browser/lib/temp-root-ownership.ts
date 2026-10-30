import { chmod, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isRecord } from "./parsing.js";
import { processStartIdentitiesMatch, readProcessStartIdentity } from "./process-identity.js";

import { getErrorCode } from "./process-errors.js";

export const TEMP_ROOT_MARKER_FILE_NAME = ".pi-agent-browser-owner.json";
const TEMP_ROOT_MARKER_KIND = "pi-agent-browser-temp-root";
const TEMP_ROOT_MARKER_VERSION = 2;

export interface TempRootOwnershipRecord {
	readonly createdAtMs: number;
	readonly kind: string;
	readonly leaseUpdatedAtMs?: number;
	readonly ownerPid?: number;
	readonly ownerProcessStartIdentity?: string;
	readonly ownerUid?: number;
	readonly protectedChildNames?: readonly string[];
	readonly version: number;
}

export interface TempRootOwnershipMarkerOptions {
	readonly createdAtMs?: number;
	readonly leaseUpdatedAtMs?: number;
	readonly ownerPid?: number;
	readonly ownerProcessStartIdentity?: string;
}

type ProcessLiveness = "alive" | "dead" | "unknown";

export function getCurrentProcessUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isProtectedTempChildName(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}
	if (value === "" || value === "." || value === ".." || value === TEMP_ROOT_MARKER_FILE_NAME) {
		return false;
	}
	if (value.includes("/") || value.includes("\\")) {
		return false;
	}
	return basename(value) === value;
}

function isTempRootOwnershipRecord(value: unknown): value is TempRootOwnershipRecord {
	if (!isRecord(value)) {
		return false;
	}
	if (value.kind !== TEMP_ROOT_MARKER_KIND || value.version !== TEMP_ROOT_MARKER_VERSION) {
		return false;
	}
	if (!isPositiveFiniteNumber(value.createdAtMs)) {
		return false;
	}
	return validLeaseAndProcess(value) && validOwnershipAndChildren(value);
}
function validLeaseAndProcess(value: Readonly<Record<string, unknown>>): boolean {
	if (value.leaseUpdatedAtMs !== undefined && !isPositiveFiniteNumber(value.leaseUpdatedAtMs)) {
		return false;
	}
	if (
		value.ownerPid !== undefined &&
		(typeof value.ownerPid !== "number" ||
			!Number.isSafeInteger(value.ownerPid) ||
			value.ownerPid <= 0)
	) {
		return false;
	}
	return (
		value.ownerProcessStartIdentity === undefined ||
		(typeof value.ownerProcessStartIdentity === "string" &&
			value.ownerProcessStartIdentity.trim() !== "")
	);
}
function validOwnershipAndChildren(value: Readonly<Record<string, unknown>>): boolean {
	if (
		value.ownerUid !== undefined &&
		(typeof value.ownerUid !== "number" ||
			!Number.isSafeInteger(value.ownerUid) ||
			value.ownerUid < 0)
	) {
		return false;
	}
	if (value.protectedChildNames === undefined) {
		return true;
	}
	if (!Array.isArray(value.protectedChildNames)) {
		return false;
	}
	const names: readonly unknown[] = value.protectedChildNames;
	return names.every(isProtectedTempChildName);
}

export async function readTempRootOwnershipMarker(
	tempRoot: string,
): Promise<TempRootOwnershipRecord | undefined> {
	try {
		const markerText = await readFile(join(tempRoot, TEMP_ROOT_MARKER_FILE_NAME), "utf8");
		const parsed = JSON.parse(markerText) as unknown;
		return isTempRootOwnershipRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function getProtectedTempChildName(tempRoot: string, childPath: string): string | undefined {
	const normalizedTempRoot = resolve(tempRoot);
	const normalizedChildPath = resolve(childPath);
	if (dirname(normalizedChildPath) !== normalizedTempRoot) {
		return undefined;
	}
	const childName = basename(normalizedChildPath);
	// A string can still be an unsafe child name; validation checks separators and reserved names.
	// oxlint-disable-next-line typescript/no-unnecessary-condition
	return isProtectedTempChildName(childName) ? childName : undefined;
}

function normalizeProtectedChildNames(names: readonly string[]): string[] {
	return [...new Set([...names].filter(isProtectedTempChildName))].sort();
}

export function getPersistedProtectedChildPaths(
	tempRoot: string,
	ownershipMarker: TempRootOwnershipRecord | undefined,
): Set<string> {
	const normalizedTempRoot = resolve(tempRoot);
	return new Set(
		(ownershipMarker?.protectedChildNames ?? []).map((childName) =>
			resolve(join(normalizedTempRoot, childName)),
		),
	);
}

async function writeTempRootOwnershipMarkerRecord(
	tempRoot: string,
	markerRecord: TempRootOwnershipRecord,
	options: { readonly flag?: "wx" } = {},
): Promise<string> {
	const markerPath = join(tempRoot, TEMP_ROOT_MARKER_FILE_NAME);
	await writeFile(markerPath, JSON.stringify(markerRecord, null, 2), {
		encoding: "utf8",
		flag: options.flag,
		mode: 0o600,
	});
	await chmod(markerPath, 0o600).catch(() => undefined);
	return markerPath;
}

export async function persistProtectedTempChildren(
	tempRoot: string,
	protectedChildren: ReadonlySet<string>,
): Promise<void> {
	if (protectedChildren.size === 0) {
		return;
	}
	const ownershipMarker = await readTempRootOwnershipMarker(tempRoot);
	if (!ownershipMarker) {
		return;
	}
	const childNames = normalizeProtectedChildNames([
		...(ownershipMarker.protectedChildNames ?? []),
		...[...protectedChildren]
			.map((path) => getProtectedTempChildName(tempRoot, path))
			.filter((childName): childName is string => childName !== undefined),
	]);
	if (childNames.length === 0) {
		return;
	}
	await writeTempRootOwnershipMarkerRecord(tempRoot, {
		...ownershipMarker,
		leaseUpdatedAtMs: Date.now(),
		protectedChildNames: childNames,
		version: TEMP_ROOT_MARKER_VERSION,
	});
}

export async function getExistingProtectedChildren(
	tempRoot: string,
	protectedChildren: ReadonlySet<string>,
): Promise<Set<string>> {
	const normalizedTempRoot = resolve(tempRoot);
	const existingChildren = new Set<string>();
	for (const path of protectedChildren) {
		const normalizedPath = resolve(path);
		if (dirname(normalizedPath) !== normalizedTempRoot) {
			continue;
		}
		if (
			// Scan in bounded sequence instead of opening an unbounded number of filesystem requests.
			// oxlint-disable-next-line no-await-in-loop
			await stat(normalizedPath).then(
				(stats) => stats.isDirectory(),
				() => false,
			)
		) {
			existingChildren.add(normalizedPath);
		}
	}
	return existingChildren;
}

export async function removeTempRootChildrenExcept(
	tempRoot: string,
	protectedChildren: ReadonlySet<string>,
): Promise<void> {
	const entries = await readdir(tempRoot, { withFileTypes: true }).catch(() => []);
	await Promise.all(
		entries.map(async (entry) => {
			if (entry.name === TEMP_ROOT_MARKER_FILE_NAME) {
				return;
			}
			const entryPath = join(tempRoot, entry.name);
			if (protectedChildren.has(resolve(entryPath))) {
				return;
			}
			await rm(entryPath, { force: true, recursive: true }).catch(() => undefined);
		}),
	);
}

async function getProcessStartIdentity(pid: number | undefined): Promise<string | undefined> {
	return pid === undefined ? undefined : await readProcessStartIdentity(pid);
}

export async function writeSecureTempRootOwnershipMarker(
	tempRoot: string,
	options: TempRootOwnershipMarkerOptions = {},
): Promise<string> {
	const createdAtMs = options.createdAtMs ?? Date.now();
	const ownerPid = options.ownerPid ?? process.pid;
	const markerRecord: TempRootOwnershipRecord = {
		createdAtMs,
		kind: TEMP_ROOT_MARKER_KIND,
		leaseUpdatedAtMs: options.leaseUpdatedAtMs ?? createdAtMs,
		ownerPid,
		ownerProcessStartIdentity:
			options.ownerProcessStartIdentity ?? (await getProcessStartIdentity(ownerPid)),
		ownerUid: getCurrentProcessUid(),
		version: TEMP_ROOT_MARKER_VERSION,
	};
	return await writeTempRootOwnershipMarkerRecord(tempRoot, markerRecord, { flag: "wx" });
}

export async function refreshSecureTempRootLease(tempRoot: string): Promise<void> {
	const ownershipMarker = await readTempRootOwnershipMarker(tempRoot);
	if (!ownershipMarker) {
		return;
	}
	if (ownershipMarker.ownerPid !== process.pid) {
		return;
	}
	const currentUid = getCurrentProcessUid();
	if (
		currentUid !== undefined &&
		ownershipMarker.ownerUid !== undefined &&
		ownershipMarker.ownerUid !== currentUid
	) {
		return;
	}
	const currentProcessStartIdentity = await getProcessStartIdentity(process.pid);
	if (
		ownershipMarker.ownerProcessStartIdentity !== undefined &&
		currentProcessStartIdentity !== undefined
	) {
		const identitiesMatch = processStartIdentitiesMatch(
			ownershipMarker.ownerProcessStartIdentity,
			currentProcessStartIdentity,
		);
		if (identitiesMatch !== true) {
			return;
		}
	}
	const refreshedMarker: TempRootOwnershipRecord = {
		...ownershipMarker,
		leaseUpdatedAtMs: Date.now(),
		ownerPid: process.pid,
		ownerProcessStartIdentity:
			currentProcessStartIdentity ?? ownershipMarker.ownerProcessStartIdentity,
		ownerUid: currentUid,
		version: TEMP_ROOT_MARKER_VERSION,
	};
	await writeTempRootOwnershipMarkerRecord(tempRoot, refreshedMarker);
}

export async function getMarkerOwnerLiveness(
	ownershipMarker: TempRootOwnershipRecord,
): Promise<ProcessLiveness> {
	const pid = ownershipMarker.ownerPid;
	if (pid === undefined) {
		return "unknown";
	}
	try {
		process.kill(pid, 0);
	} catch (error) {
		const code = getErrorCode(error);
		if (code === "ESRCH") {
			return "dead";
		}
		if (code !== "EPERM") {
			return "unknown";
		}
	}

	const currentProcessStartIdentity = await getProcessStartIdentity(pid);
	if (
		ownershipMarker.ownerProcessStartIdentity === undefined ||
		currentProcessStartIdentity === undefined
	) {
		return "unknown";
	}
	const identitiesMatch = processStartIdentitiesMatch(
		ownershipMarker.ownerProcessStartIdentity,
		currentProcessStartIdentity,
	);
	if (identitiesMatch === undefined) {
		return "unknown";
	}
	return identitiesMatch ? "alive" : "dead";
}
