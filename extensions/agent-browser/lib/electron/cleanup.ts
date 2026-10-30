import type { ChildProcess } from "node:child_process";
import { lstat, rm } from "node:fs/promises";

import {
	fetchCdpJson,
	parseCdpTargets,
	parseCdpVersion,
	type ElectronCdpTarget,
	type ElectronCdpVersion,
} from "./cdp.js";
import { ELECTRON_PROFILE_DIR_PREFIX, type ElectronLaunchRecord } from "./launch-types.js";
import { pathExists } from "../fs-utils.js";
import { isRecord } from "../parsing.js";
import { readProcessStartIdentity, processStartIdentitiesMatch } from "../process-identity.js";
import { stringifyUnknown } from "../results/text.js";
import { getSecureTempChildDirectoryValidationError } from "../temp.js";

const ELECTRON_CLEANUP_DEFAULT_TIMEOUT_MS = 5_000;
const ELECTRON_CLEANUP_POLL_INTERVAL_MS = 100;

export interface ElectronLaunchStatus {
	readonly cleanupState: ElectronLaunchRecord["cleanupState"];
	readonly launchId: string;
	readonly pid?: number;
	readonly pidAlive?: boolean;
	readonly port: number;
	readonly portAlive: boolean;
	readonly targets: readonly ElectronCdpTarget[];
	readonly userDataDirState: "present" | "absent" | "unknown";
	readonly version?: ElectronCdpVersion;
}

export interface ElectronCleanupStep {
	readonly error?: string;
	readonly resource: "debug-port" | "managed-session" | "process" | "user-data-dir";
	readonly sessionName?: string;
	readonly state: "already-gone" | "failed" | "removed" | "skipped";
}

export interface ElectronCleanupResult {
	readonly launchId: string;
	readonly partial: boolean;
	readonly record: ElectronLaunchRecord;
	readonly remainingResources: readonly string[];
	readonly steps: readonly ElectronCleanupStep[];
	readonly summary: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function isPidAlive(pid: number | undefined): boolean | undefined {
	if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

async function isPortAlive(
	port: number,
	signal?: AbortSignal,
): Promise<{ targets: ElectronCdpTarget[]; version?: ElectronCdpVersion }> {
	const version = parseCdpVersion(
		await fetchCdpJson(`http://127.0.0.1:${port}/json/version`, signal),
	);
	if (!version) {
		return { targets: [] };
	}
	const targets = parseCdpTargets(await fetchCdpJson(`http://127.0.0.1:${port}/json/list`, signal));
	return { targets, version };
}

export async function inspectElectronLaunchStatus(
	record: ElectronLaunchRecord,
	signal?: AbortSignal,
): Promise<ElectronLaunchStatus> {
	const cdp = await isPortAlive(record.port, signal);
	let userDataDirState: ElectronLaunchStatus["userDataDirState"];
	try {
		await lstat(record.userDataDir);
		userDataDirState = "present";
	} catch (error) {
		userDataDirState = isRecord(error) && error.code === "ENOENT" ? "absent" : "unknown";
	}
	return {
		cleanupState: record.cleanupState,
		launchId: record.launchId,
		pid: record.pid,
		pidAlive: isPidAlive(record.pid),
		port: record.port,
		portAlive: cdp.version !== undefined,
		targets: cdp.targets,
		userDataDirState,
		version: cdp.version,
	};
}

function hasProcessExited(child: ChildProcess | undefined, pid: number | undefined): boolean {
	// A Windows PID probe can report ESRCH during termination, before the
	// tracked process has exited and released its executable/resources.
	return child ? child.exitCode !== null || child.signalCode !== null : isPidAlive(pid) === false;
}

async function waitForProcessExit(
	child: ChildProcess | undefined,
	pid: number | undefined,
	deadlineMs: number,
): Promise<boolean> {
	while (Date.now() <= deadlineMs) {
		if (hasProcessExited(child, pid)) {
			return true;
		}
		// Polling observes exit between sleeps; parallel waits cannot preserve the deadline.
		// oxlint-disable-next-line no-await-in-loop
		await sleep(ELECTRON_CLEANUP_POLL_INTERVAL_MS);
	}
	return hasProcessExited(child, pid);
}

async function getRestoredProcessVerificationError(
	record: ElectronLaunchRecord,
): Promise<string | undefined> {
	if (record.startIdentity === undefined || record.startIdentity.length === 0) {
		return `PID ${String(record.pid)} is alive, but this session has no tracked child handle or recorded start identity; refusing to signal a restored PID that may have been reused.`;
	}
	const currentIdentity =
		record.pid === undefined ? undefined : await readProcessStartIdentity(record.pid);
	if (currentIdentity === undefined) {
		return `PID ${String(record.pid)} is alive, but its current start identity could not be inspected; refusing to signal a restored PID that may have been reused.`;
	}
	if (processStartIdentitiesMatch(record.startIdentity, currentIdentity) !== true) {
		return `PID ${String(record.pid)} is alive, but its start identity does not match the wrapper launch record; refusing to signal a restored PID that may have been reused.`;
	}
	return undefined;
}

function killPid(pid: number | undefined, signal: NodeJS.Signals): boolean {
	if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

function killProcessGroup(processGroupId: number | undefined, signal: NodeJS.Signals): boolean {
	if (
		process.platform === "win32" ||
		processGroupId === undefined ||
		!Number.isSafeInteger(processGroupId) ||
		processGroupId <= 0
	) {
		return false;
	}
	try {
		process.kill(-processGroupId, signal);
		return true;
	} catch {
		return false;
	}
}

function signalRestoredLaunchProcess(
	record: ElectronLaunchRecord,
	signal: NodeJS.Signals,
): boolean {
	return killProcessGroup(record.processGroupId, signal) || killPid(record.pid, signal);
}

async function cleanupProcess(
	record: ElectronLaunchRecord,
	child: ChildProcess | undefined,
	deadlineMs: number,
): Promise<ElectronCleanupStep> {
	if (record.pid === undefined || record.pid === 0 || Number.isNaN(record.pid)) {
		return { resource: "process", state: "skipped" };
	}
	if (hasProcessExited(child, record.pid)) {
		return { resource: "process", state: "already-gone" };
	}
	return child === undefined
		? cleanupRestoredProcess(record, deadlineMs)
		: cleanupTrackedProcess(record, child, deadlineMs);
}

async function cleanupRestoredProcess(
	record: ElectronLaunchRecord,
	deadlineMs: number,
): Promise<ElectronCleanupStep> {
	const verificationError = await getRestoredProcessVerificationError(record);
	if (verificationError !== undefined) {
		return { error: verificationError, resource: "process", state: "failed" };
	}
	if (!signalRestoredLaunchProcess(record, "SIGTERM")) {
		return {
			error: `PID ${String(record.pid)} matched wrapper launch metadata but could not be signaled.`,
			resource: "process",
			state: "failed",
		};
	}
	if (await waitForProcessExit(undefined, record.pid, deadlineMs)) {
		return { resource: "process", state: "removed" };
	}
	const killVerificationError = await getRestoredProcessVerificationError(record);
	if (killVerificationError !== undefined) {
		return { error: killVerificationError, resource: "process", state: "failed" };
	}
	signalRestoredLaunchProcess(record, "SIGKILL");
	if (await waitForProcessExit(undefined, record.pid, Date.now() + 1_000)) {
		return { resource: "process", state: "removed" };
	}
	return {
		error: `PID ${String(record.pid)} remained alive after SIGTERM/SIGKILL.`,
		resource: "process",
		state: "failed",
	};
}

async function cleanupTrackedProcess(
	record: ElectronLaunchRecord,
	child: ChildProcess,
	deadlineMs: number,
): Promise<ElectronCleanupStep> {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
	} else {
		killPid(record.pid, "SIGTERM");
	}
	if (await waitForProcessExit(child, record.pid, deadlineMs)) {
		return { resource: "process", state: "removed" };
	}
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	} else {
		killPid(record.pid, "SIGKILL");
	}
	if (await waitForProcessExit(child, record.pid, Date.now() + 1_000)) {
		return { resource: "process", state: "removed" };
	}
	return {
		error: `PID ${String(record.pid)} remained alive after SIGTERM/SIGKILL.`,
		resource: "process",
		state: "failed",
	};
}

async function cleanupUserDataDir(record: ElectronLaunchRecord): Promise<ElectronCleanupStep> {
	if (record.userDataDir.length === 0) {
		return { resource: "user-data-dir", state: "skipped" };
	}
	if (!(await pathExists(record.userDataDir))) {
		return { resource: "user-data-dir", state: "already-gone" };
	}
	const validationError = await getSecureTempChildDirectoryValidationError(
		record.userDataDir,
		ELECTRON_PROFILE_DIR_PREFIX,
	);
	if (validationError !== undefined) {
		return { error: validationError, resource: "user-data-dir", state: "failed" };
	}
	try {
		await rm(record.userDataDir, { force: true, recursive: true });
		return {
			resource: "user-data-dir",
			state: (await pathExists(record.userDataDir)) ? "failed" : "removed",
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : stringifyUnknown(error),
			resource: "user-data-dir",
			state: "failed",
		};
	}
}

function shouldSkipUserDataDirCleanup(
	processStep: ElectronCleanupStep,
	debugPortStep: ElectronCleanupStep,
): string | undefined {
	if (processStep.state === "failed") {
		return `Skipped because process cleanup failed: ${processStep.error ?? "process state could not be verified"}.`;
	}
	if (debugPortStep.state === "failed") {
		return `Skipped because debug port cleanup is incomplete: ${debugPortStep.error ?? "debug port still responds"}.`;
	}
	return undefined;
}

async function cleanupDebugPort(record: ElectronLaunchRecord): Promise<ElectronCleanupStep> {
	const cdp = await isPortAlive(record.port);
	return cdp.version
		? {
				resource: "debug-port",
				state: "failed",
				error: `/json/version still responds on port ${record.port}.`,
			}
		: { resource: "debug-port", state: "already-gone" };
}

function summarizeCleanup(
	launchId: string,
	steps: readonly ElectronCleanupStep[],
): { partial: boolean; remainingResources: string[]; summary: string } {
	const remainingResources = steps
		.filter(
			(step) =>
				step.state === "failed" ||
				(step.resource === "user-data-dir" &&
					step.state === "skipped" &&
					step.error !== undefined &&
					step.error.length > 0),
		)
		.map((step) => step.resource);
	const partial = remainingResources.length > 0;
	return {
		partial,
		remainingResources,
		summary: partial
			? `Electron cleanup for ${launchId} is partial; remaining resources: ${remainingResources.join(", ")}.`
			: `Electron cleanup for ${launchId} completed.`,
	};
}

export async function cleanupElectronLaunchResources(options: {
	readonly child?: ChildProcess;
	readonly record: ElectronLaunchRecord;
	readonly timeoutMs?: number;
}): Promise<ElectronCleanupResult> {
	const timeoutMs =
		typeof options.timeoutMs === "number" &&
		Number.isSafeInteger(options.timeoutMs) &&
		options.timeoutMs > 0
			? options.timeoutMs
			: ELECTRON_CLEANUP_DEFAULT_TIMEOUT_MS;
	const deadlineMs = Date.now() + timeoutMs;
	const processStep = await cleanupProcess(options.record, options.child, deadlineMs);
	const debugPortStep = await cleanupDebugPort(options.record);
	const userDataDirSkipReason = shouldSkipUserDataDirCleanup(processStep, debugPortStep);
	const userDataDirStep =
		userDataDirSkipReason !== undefined
			? {
					error: userDataDirSkipReason,
					resource: "user-data-dir" as const,
					state: "skipped" as const,
				}
			: await cleanupUserDataDir(options.record);
	const steps = [processStep, debugPortStep, userDataDirStep];
	const summary = summarizeCleanup(options.record.launchId, steps);
	return {
		launchId: options.record.launchId,
		partial: summary.partial,
		record: {
			...options.record,
			cleanupState: summary.partial ? "partial" : "cleaned",
		},
		remainingResources: summary.remainingResources,
		steps,
		summary: summary.summary,
	};
}
