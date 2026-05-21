/**
 * Purpose: Inspect and clean wrapper-owned Electron launch resources.
 * Responsibilities: Report CDP liveness/targets without mutation and remove only tracked process/profile resources during explicit or shutdown cleanup.
 * Scope: Host-side Electron status and resource cleanup only; upstream managed-session close remains in the extension entrypoint.
 * Usage: Called by electron.status, electron.cleanup, and session_shutdown handling.
 * Invariants/Assumptions: Cleanup operates only on launch records produced by this wrapper and prefers partial cleanup reporting over killing or deleting untracked resources.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { ELECTRON_PROFILE_DIR_PREFIX, type ElectronCdpTarget, type ElectronCdpVersion, type ElectronLaunchRecord } from "./launch.js";
import { getSecureTempChildDirectoryValidationError } from "../temp.js";

const ELECTRON_STATUS_FETCH_TIMEOUT_MS = 1_000;
const ELECTRON_CLEANUP_DEFAULT_TIMEOUT_MS = 5_000;
const ELECTRON_CLEANUP_POLL_INTERVAL_MS = 100;
const RESTORED_PROCESS_COMMAND_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

export interface ElectronLaunchStatus {
	cleanupState: ElectronLaunchRecord["cleanupState"];
	launchId: string;
	pid?: number;
	pidAlive?: boolean;
	port: number;
	portAlive: boolean;
	targets: ElectronCdpTarget[];
	version?: ElectronCdpVersion;
}

export interface ElectronCleanupStep {
	error?: string;
	resource: "debug-port" | "managed-session" | "process" | "user-data-dir";
	state: "already-gone" | "failed" | "removed" | "skipped";
}

export interface ElectronCleanupResult {
	launchId: string;
	partial: boolean;
	record: ElectronLaunchRecord;
	remainingResources: string[];
	steps: ElectronCleanupStep[];
	summary: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseCdpVersion(value: unknown): ElectronCdpVersion | undefined {
	if (!isRecord(value)) return undefined;
	return {
		browser: asString(value.Browser) ?? asString(value.browser),
		protocolVersion: asString(value["Protocol-Version"]) ?? asString(value.protocolVersion),
		userAgent: asString(value["User-Agent"]) ?? asString(value.userAgent),
		v8Version: asString(value["V8-Version"]) ?? asString(value.v8Version),
		webKitVersion: asString(value["WebKit-Version"]) ?? asString(value.webKitVersion),
		webSocketDebuggerUrl: asString(value.webSocketDebuggerUrl),
	};
}

function parseCdpTargets(value: unknown): ElectronCdpTarget[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).map((target) => ({
		id: asString(target.id),
		title: asString(target.title),
		type: asString(target.type),
		url: asString(target.url),
		webSocketDebuggerUrl: asString(target.webSocketDebuggerUrl),
	}));
}

async function fetchJson(url: string): Promise<unknown | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), ELECTRON_STATUS_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) return undefined;
		return await response.json() as unknown;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function isPidAlive(pid: number | undefined): boolean | undefined {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EPERM" ? true : false;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function isPortAlive(port: number): Promise<{ targets: ElectronCdpTarget[]; version?: ElectronCdpVersion }> {
	const version = parseCdpVersion(await fetchJson(`http://127.0.0.1:${port}/json/version`));
	if (!version) return { targets: [] };
	const targets = parseCdpTargets(await fetchJson(`http://127.0.0.1:${port}/json/list`));
	return { targets, version };
}

export async function inspectElectronLaunchStatus(record: ElectronLaunchRecord): Promise<ElectronLaunchStatus> {
	const cdp = await isPortAlive(record.port);
	return {
		cleanupState: record.cleanupState,
		launchId: record.launchId,
		pid: record.pid,
		pidAlive: isPidAlive(record.pid),
		port: record.port,
		portAlive: cdp.version !== undefined,
		targets: cdp.targets,
		version: cdp.version,
	};
}

async function waitForProcessExit(child: ChildProcess | undefined, pid: number | undefined, deadlineMs: number): Promise<boolean> {
	while (Date.now() <= deadlineMs) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) return true;
		if (isPidAlive(pid) === false) return true;
		await sleep(ELECTRON_CLEANUP_POLL_INTERVAL_MS);
	}
	return isPidAlive(pid) === false;
}

async function readPidCommandLine(pid: number | undefined): Promise<string | undefined> {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		const { stdout } = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
			timeout: RESTORED_PROCESS_COMMAND_TIMEOUT_MS,
		});
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

function restoredLaunchCommandMatchesRecord(record: ElectronLaunchRecord, commandLine: string | undefined): boolean {
	return commandLine?.includes(`--user-data-dir=${record.userDataDir}`) === true;
}

async function getRestoredProcessVerificationError(record: ElectronLaunchRecord): Promise<string | undefined> {
	const commandLine = await readPidCommandLine(record.pid);
	if (!commandLine) {
		return `PID ${record.pid} is alive, but this session has no tracked child handle and its command line could not be inspected; refusing to signal a restored PID that may have been reused.`;
	}
	if (!restoredLaunchCommandMatchesRecord(record, commandLine)) {
		return `PID ${record.pid} is alive, but this session has no tracked child handle and its command line does not include wrapper-owned user data dir ${record.userDataDir}; refusing to signal a restored PID that may have been reused.`;
	}
	return undefined;
}

function killPid(pid: number | undefined, signal: NodeJS.Signals): boolean {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

function killProcessGroup(processGroupId: number | undefined, signal: NodeJS.Signals): boolean {
	if (process.platform === "win32" || !processGroupId || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) return false;
	try {
		process.kill(-processGroupId, signal);
		return true;
	} catch {
		return false;
	}
}

function signalRestoredLaunchProcess(record: ElectronLaunchRecord, signal: NodeJS.Signals): boolean {
	return killProcessGroup(record.processGroupId, signal) || killPid(record.pid, signal);
}

async function cleanupProcess(record: ElectronLaunchRecord, child: ChildProcess | undefined, deadlineMs: number): Promise<ElectronCleanupStep> {
	if (!record.pid) return { resource: "process", state: "skipped" };
	if (isPidAlive(record.pid) === false) return { resource: "process", state: "already-gone" };
	if (!child) {
		const verificationError = await getRestoredProcessVerificationError(record);
		if (verificationError) return { error: verificationError, resource: "process", state: "failed" };
		if (!signalRestoredLaunchProcess(record, "SIGTERM")) {
			return { error: `PID ${record.pid} matched wrapper launch metadata but could not be signaled.`, resource: "process", state: "failed" };
		}
		if (await waitForProcessExit(undefined, record.pid, deadlineMs)) return { resource: "process", state: "removed" };
		signalRestoredLaunchProcess(record, "SIGKILL");
		if (await waitForProcessExit(undefined, record.pid, Date.now() + 1_000)) return { resource: "process", state: "removed" };
		return { error: `PID ${record.pid} remained alive after SIGTERM/SIGKILL.`, resource: "process", state: "failed" };
	}
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	else killPid(record.pid, "SIGTERM");
	if (await waitForProcessExit(child, record.pid, deadlineMs)) return { resource: "process", state: "removed" };
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	else killPid(record.pid, "SIGKILL");
	if (await waitForProcessExit(child, record.pid, Date.now() + 1_000)) return { resource: "process", state: "removed" };
	return { error: `PID ${record.pid} remained alive after SIGTERM/SIGKILL.`, resource: "process", state: "failed" };
}

async function cleanupUserDataDir(record: ElectronLaunchRecord): Promise<ElectronCleanupStep> {
	if (!record.userDataDir) return { resource: "user-data-dir", state: "skipped" };
	if (!await pathExists(record.userDataDir)) return { resource: "user-data-dir", state: "already-gone" };
	const validationError = await getSecureTempChildDirectoryValidationError(record.userDataDir, ELECTRON_PROFILE_DIR_PREFIX);
	if (validationError) return { error: validationError, resource: "user-data-dir", state: "failed" };
	try {
		await rm(record.userDataDir, { force: true, recursive: true });
		return { resource: "user-data-dir", state: await pathExists(record.userDataDir) ? "failed" : "removed" };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error), resource: "user-data-dir", state: "failed" };
	}
}

function shouldSkipUserDataDirCleanup(processStep: ElectronCleanupStep, debugPortStep: ElectronCleanupStep): string | undefined {
	if (processStep.state === "failed") return `Skipped because process cleanup failed: ${processStep.error ?? "process state could not be verified"}.`;
	if (debugPortStep.state === "failed") return `Skipped because debug port cleanup is incomplete: ${debugPortStep.error ?? "debug port still responds"}.`;
	return undefined;
}

async function cleanupDebugPort(record: ElectronLaunchRecord): Promise<ElectronCleanupStep> {
	const cdp = await isPortAlive(record.port);
	return cdp.version ? { resource: "debug-port", state: "failed", error: `/json/version still responds on port ${record.port}.` } : { resource: "debug-port", state: "already-gone" };
}

function summarizeCleanup(launchId: string, steps: ElectronCleanupStep[]): { partial: boolean; remainingResources: string[]; summary: string } {
	const remainingResources = steps
		.filter((step) => step.state === "failed" || (step.resource === "user-data-dir" && step.state === "skipped" && step.error))
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
	child?: ChildProcess;
	record: ElectronLaunchRecord;
	timeoutMs?: number;
}): Promise<ElectronCleanupResult> {
	const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
		? options.timeoutMs as number
		: ELECTRON_CLEANUP_DEFAULT_TIMEOUT_MS;
	const deadlineMs = Date.now() + timeoutMs;
	const processStep = await cleanupProcess(options.record, options.child, deadlineMs);
	const debugPortStep = await cleanupDebugPort(options.record);
	const userDataDirSkipReason = shouldSkipUserDataDirCleanup(processStep, debugPortStep);
	const userDataDirStep = userDataDirSkipReason
		? { error: userDataDirSkipReason, resource: "user-data-dir" as const, state: "skipped" as const }
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
