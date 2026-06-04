/**
 * Purpose: Launch wrapper-owned Electron applications and discover their CDP endpoint.
 * Responsibilities: Resolve Electron targets, enforce caller-owned allow/deny policy, create isolated userDataDir profiles, launch with remote debugging on an OS-chosen port, poll DevToolsActivePort, and read bounded CDP version/target metadata.
 * Scope: Host-side Electron lifecycle setup only; upstream agent-browser attach/presentation stays in the extension entrypoint.
 * Usage: Called by the agent_browser electron.launch shorthand before routing through upstream `connect`.
 * Invariants/Assumptions: The wrapper only launches targets with Electron framework evidence, always uses an isolated temp profile, and never accepts a caller-supplied remote debugging port.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
	fetchCdpJson,
	parseCdpTargets,
	parseCdpVersion,
	type ElectronCdpTarget,
	type ElectronCdpVersion,
} from "./cdp.js";
import {
	discoverElectronApps,
	inspectElectronAppPath,
	inspectElectronExecutablePath,
	type ElectronAppDiscovery,
} from "./discovery.js";
import { createSecureTempDirectory } from "../temp.js";

export type { ElectronCdpTarget, ElectronCdpVersion } from "./cdp.js";

export const ELECTRON_LAUNCH_RECORD_VERSION = 1;
export const ELECTRON_LAUNCH_DEFAULT_TIMEOUT_MS = 15_000;
export const ELECTRON_LAUNCH_MAX_TIMEOUT_MS = 120_000;

const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";
export const ELECTRON_PROFILE_DIR_PREFIX = "electron-profile-";
const ELECTRON_DEFAULT_APP_ARGS = ["--disable-extensions", "--no-first-run", "--no-default-browser-check"] as const;
const ELECTRON_DEVTOOLS_POLL_INTERVAL_MS = 100;

export interface ElectronDevToolsActivePortRead {
	error?: string;
	found: boolean;
	path: string;
	port?: number;
}

export interface ElectronLaunchFailureDiagnostics {
	cdpVersionReached?: boolean;
	devToolsActivePort?: ElectronDevToolsActivePortRead;
	elapsedMs?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	outputCaptured: false;
	pid?: number;
	pidAlive?: boolean;
	port?: number;
	timeoutMs?: number;
	userDataDir?: string;
}

export type ElectronLaunchCleanupState = "active" | "cleaned" | "dead" | "failed" | "partial";
export type ElectronLaunchFailureReason =
	| "non-electron-target"
	| "policy-blocked"
	| "port-not-found"
	| "single-instance-conflict"
	| "spawn-error"
	| "timeout";

export interface ElectronLaunchRecord {
	appName: string;
	appPath?: string;
	bundleId?: string;
	cleanupState: ElectronLaunchCleanupState;
	createdAtMs: number;
	desktopId?: string;
	executablePath: string;
	launchId: string;
	launchedByWrapper: true;
	packageSource?: string;
	pid?: number;
	platform?: string;
	port: number;
	processGroupId?: number;
	sessionName?: string;
	targetType?: "any" | "page" | "webview";
	userDataDir: string;
	version: typeof ELECTRON_LAUNCH_RECORD_VERSION;
	webSocketDebuggerUrl?: string;
}

export interface ElectronPolicyBlock {
	entry?: string;
	list: "allow" | "deny";
	message: string;
}

export interface ElectronLaunchSuccess {
	appArgs: string[];
	child: ChildProcess;
	connectArg: string;
	record: ElectronLaunchRecord;
	target: ElectronAppDiscovery;
	targets: ElectronCdpTarget[];
	version: ElectronCdpVersion;
}

export interface ElectronLaunchFailure {
	appArgs: string[];
	cleanupError?: string;
	diagnostics?: ElectronLaunchFailureDiagnostics;
	error: string;
	policy?: ElectronPolicyBlock;
	reason: ElectronLaunchFailureReason;
	target?: ElectronAppDiscovery;
	userDataDir?: string;
}

export type ElectronLaunchResult = { ok: true; value: ElectronLaunchSuccess } | { ok: false; failure: ElectronLaunchFailure };

export interface ResolveElectronTargetOptions {
	appName?: string;
	appPath?: string;
	bundleId?: string;
	executablePath?: string;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
	if (!Number.isSafeInteger(timeoutMs) || (timeoutMs ?? 0) <= 0) return ELECTRON_LAUNCH_DEFAULT_TIMEOUT_MS;
	return Math.min(timeoutMs as number, ELECTRON_LAUNCH_MAX_TIMEOUT_MS);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeIdentifier(value: string | undefined): string | undefined {
	const trimmed = value?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function appIdentifiers(app: ElectronAppDiscovery): string[] {
	return [app.name, app.bundleId, app.desktopId, app.appPath, app.executablePath]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function policyEntryMatchesApp(entry: string, app: ElectronAppDiscovery): boolean {
	const normalizedEntry = normalizeIdentifier(entry);
	if (!normalizedEntry) return false;
	return appIdentifiers(app).some((identifier) => identifier.toLowerCase().includes(normalizedEntry));
}

export function evaluateElectronLaunchPolicy(options: {
	allow?: string[];
	deny?: string[];
	target: ElectronAppDiscovery;
}): ElectronPolicyBlock | undefined {
	const denyEntry = options.deny?.find((entry) => policyEntryMatchesApp(entry, options.target));
	if (denyEntry) {
		return {
			entry: denyEntry,
			list: "deny",
			message: `Electron launch blocked by caller deny policy: ${denyEntry}`,
		};
	}
	if (options.allow && options.allow.length > 0) {
		const allowEntry = options.allow.find((entry) => policyEntryMatchesApp(entry, options.target));
		if (!allowEntry) {
			return {
				list: "allow",
				message: "Electron launch blocked because the resolved app did not match caller allow policy.",
			};
		}
	}
	return undefined;
}

export async function resolveElectronLaunchTarget(options: ResolveElectronTargetOptions): Promise<ElectronAppDiscovery | undefined> {
	if (options.appPath) return inspectElectronAppPath(options.appPath);
	if (options.executablePath) return inspectElectronExecutablePath(options.executablePath);
	const query = options.bundleId ?? options.appName;
	const discovery = await discoverElectronApps({ maxResults: 200, query });
	if (options.bundleId) {
		const normalizedBundleId = normalizeIdentifier(options.bundleId);
		return discovery.apps.find((app) => normalizeIdentifier(app.bundleId) === normalizedBundleId);
	}
	if (options.appName) {
		const normalizedName = normalizeIdentifier(options.appName);
		return discovery.apps.find((app) => normalizeIdentifier(app.name) === normalizedName) ?? discovery.apps[0];
	}
	return undefined;
}

function targetMatchesType(target: ElectronCdpTarget, targetType: "any" | "page" | "webview" | undefined): boolean {
	return targetType === undefined || targetType === "any" || target.type === targetType;
}

function selectElectronConnectArg(options: {
	port: number;
	targets: ElectronCdpTarget[];
	targetType?: "any" | "page" | "webview";
	version: ElectronCdpVersion;
}): string {
	const targetWebSocket = options.targets.find((target) => targetMatchesType(target, options.targetType) && target.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
	return targetWebSocket ?? options.version.webSocketDebuggerUrl ?? String(options.port);
}

async function readDevToolsActivePort(userDataDir: string): Promise<ElectronDevToolsActivePortRead> {
	const path = `${userDataDir}/${DEVTOOLS_ACTIVE_PORT_FILE}`;
	try {
		const text = await readFile(path, "utf8");
		const [portLine] = text.split(/\r?\n/);
		const port = Number(portLine?.trim());
		return {
			found: true,
			path,
			port: Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : undefined,
			...(Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? {} : { error: "DevToolsActivePort did not contain a valid TCP port." }),
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			error: code && code !== "ENOENT" ? `${code}: ${error instanceof Error ? error.message : String(error)}` : undefined,
			found: false,
			path,
		};
	}
}

async function pollDevToolsActivePort(options: {
	deadlineMs: number;
	getChildExit: () => { code: number | null; signal: NodeJS.Signals | null };
	getSpawnError: () => Error | undefined;
	userDataDir: string;
}): Promise<{ devToolsActivePort?: ElectronDevToolsActivePortRead; failure?: ElectronLaunchFailureReason; port?: number; spawnError?: Error }> {
	let devToolsActivePort: ElectronDevToolsActivePortRead | undefined;
	while (Date.now() <= options.deadlineMs) {
		const spawnError = options.getSpawnError();
		if (spawnError) return { devToolsActivePort, failure: "spawn-error", spawnError };
		devToolsActivePort = await readDevToolsActivePort(options.userDataDir);
		if (devToolsActivePort.port) return { devToolsActivePort, port: devToolsActivePort.port };
		const exit = options.getChildExit();
		if (exit.code !== null || exit.signal !== null) {
			return { devToolsActivePort, failure: exit.code === 0 ? "single-instance-conflict" : "spawn-error" };
		}
		await sleep(ELECTRON_DEVTOOLS_POLL_INTERVAL_MS);
	}
	return { devToolsActivePort, failure: "timeout" };
}

async function pollCdpMetadata(port: number, deadlineMs: number): Promise<{ targets: ElectronCdpTarget[]; version: ElectronCdpVersion } | undefined> {
	while (Date.now() <= deadlineMs) {
		const version = parseCdpVersion(await fetchCdpJson(`http://127.0.0.1:${port}/json/version`));
		if (version) {
			const targets = parseCdpTargets(await fetchCdpJson(`http://127.0.0.1:${port}/json/list`));
			return { targets, version };
		}
		await sleep(ELECTRON_DEVTOOLS_POLL_INTERVAL_MS);
	}
	return undefined;
}

function buildLaunchArgs(userDataDir: string, appArgs: string[]): string[] {
	return [
		...appArgs,
		`--user-data-dir=${userDataDir}`,
		"--remote-debugging-port=0",
		...ELECTRON_DEFAULT_APP_ARGS,
	];
}

async function waitForLaunchChildExit(child: ChildProcess, deadlineMs: number): Promise<boolean> {
	while (Date.now() <= deadlineMs) {
		if (child.exitCode !== null || child.signalCode !== null) return true;
		await sleep(50);
	}
	return child.exitCode !== null || child.signalCode !== null;
}

function isLaunchChildPidAlive(child: ChildProcess): boolean | undefined {
	if (!child.pid) return undefined;
	if (child.exitCode !== null || child.signalCode !== null) return false;
	try {
		process.kill(child.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function terminateLaunchChild(child: ChildProcess): Promise<string | undefined> {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return undefined;
	try {
		child.kill("SIGTERM");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (await waitForLaunchChildExit(child, Date.now() + 1_000)) return undefined;
	try {
		child.kill("SIGKILL");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (await waitForLaunchChildExit(child, Date.now() + 1_000)) return undefined;
	return `PID ${child.pid} remained alive after failed Electron launch cleanup.`;
}

function buildLaunchRecord(options: {
	createdAtMs: number;
	pid?: number;
	port: number;
	target: ElectronAppDiscovery;
	targetType?: "any" | "page" | "webview";
	userDataDir: string;
	version: ElectronCdpVersion;
}): ElectronLaunchRecord {
	return {
		appName: options.target.name,
		appPath: options.target.appPath,
		bundleId: options.target.bundleId,
		cleanupState: "active",
		createdAtMs: options.createdAtMs,
		desktopId: options.target.desktopId,
		executablePath: options.target.executablePath,
		launchId: `electron-${randomUUID()}`,
		launchedByWrapper: true,
		packageSource: options.target.packageSource,
		pid: options.pid,
		platform: options.target.platform,
		port: options.port,
		processGroupId: process.platform === "win32" ? undefined : options.pid,
		targetType: options.targetType,
		userDataDir: options.userDataDir,
		version: ELECTRON_LAUNCH_RECORD_VERSION,
		webSocketDebuggerUrl: options.version.webSocketDebuggerUrl,
	};
}

function launchFailureMessage(reason: ElectronLaunchFailureReason, target: ElectronAppDiscovery | undefined, detail?: string): string {
	const label = target ? `${target.name} (${target.appPath ?? target.executablePath})` : "target";
	switch (reason) {
		case "non-electron-target":
			return `Electron launch rejected: ${label} does not have Electron framework evidence.`;
		case "policy-blocked":
			return detail ?? `Electron launch blocked by caller policy for ${label}.`;
		case "single-instance-conflict":
			return `Electron launch did not expose a debug port for ${label}; the app may already be running as a single-instance Electron app. Quit the running app and retry.`;
		case "port-not-found":
			return `Electron launch found a DevToolsActivePort for ${label}, but /json/version never returned a valid CDP payload.`;
		case "spawn-error":
			return `Electron launch failed while starting ${label}${detail ? `: ${detail}` : "."}`;
		case "timeout":
			return `Electron launch timed out waiting for DevToolsActivePort for ${label}.`;
	}
}

export async function launchElectronApp(options: {
	allow?: string[];
	appArgs?: string[];
	deny?: string[];
	appName?: string;
	appPath?: string;
	bundleId?: string;
	executablePath?: string;
	targetType?: "any" | "page" | "webview";
	timeoutMs?: number;
}): Promise<ElectronLaunchResult> {
	const appArgs = options.appArgs ?? [];
	const target = await resolveElectronLaunchTarget(options);
	if (!target) {
		return {
			ok: false,
			failure: {
				appArgs,
				error: launchFailureMessage("non-electron-target", undefined),
				reason: "non-electron-target",
			},
		};
	}

	const policy = evaluateElectronLaunchPolicy({ allow: options.allow, deny: options.deny, target });
	if (policy) {
		return {
			ok: false,
			failure: {
				appArgs,
				error: launchFailureMessage("policy-blocked", target, policy.message),
				policy,
				reason: "policy-blocked",
				target,
			},
		};
	}

	const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
	const startedAtMs = Date.now();
	const deadlineMs = startedAtMs + timeoutMs;
	const userDataDir = await createSecureTempDirectory(ELECTRON_PROFILE_DIR_PREFIX);
	let cleanupError: string | undefined;
	let spawnError: Error | undefined;
	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	const args = buildLaunchArgs(userDataDir, appArgs);
	const child = spawn(target.executablePath, args, {
		cwd: dirname(target.executablePath),
		detached: process.platform !== "win32",
		stdio: "ignore",
	});
	child.once("error", (error) => {
		spawnError = error;
	});
	child.once("exit", (code, signal) => {
		exitCode = code;
		exitSignal = signal;
	});
	child.unref();

	const buildFailureDiagnostics = (options: {
		cdpVersionReached?: boolean;
		devToolsActivePort?: ElectronDevToolsActivePortRead;
		port?: number;
	} = {}): ElectronLaunchFailureDiagnostics => ({
		cdpVersionReached: options.cdpVersionReached,
		devToolsActivePort: options.devToolsActivePort,
		elapsedMs: Math.max(0, Date.now() - startedAtMs),
		exitCode,
		exitSignal,
		outputCaptured: false,
		pid: child.pid,
		pidAlive: isLaunchChildPidAlive(child),
		port: options.port ?? options.devToolsActivePort?.port,
		timeoutMs,
		userDataDir,
	});

	const fail = async (reason: ElectronLaunchFailureReason, detail?: string, diagnosticOptions?: Parameters<typeof buildFailureDiagnostics>[0]): Promise<ElectronLaunchResult> => {
		const diagnostics = buildFailureDiagnostics(diagnosticOptions);
		const processCleanupError = await terminateLaunchChild(child);
		try {
			await rm(userDataDir, { force: true, recursive: true });
		} catch (error) {
			cleanupError = error instanceof Error ? error.message : String(error);
		}
		cleanupError = [processCleanupError, cleanupError].filter((value): value is string => value !== undefined).join("; ") || undefined;
		return {
			ok: false,
			failure: {
				appArgs,
				cleanupError,
				diagnostics,
				error: launchFailureMessage(reason, target, detail),
				reason,
				target,
				userDataDir,
			},
		};
	};

	const portResult = await pollDevToolsActivePort({
		deadlineMs,
		getChildExit: () => ({ code: exitCode, signal: exitSignal }),
		getSpawnError: () => spawnError,
		userDataDir,
	});
	if (!portResult.port) {
		return fail(portResult.failure ?? "timeout", portResult.spawnError?.message, { devToolsActivePort: portResult.devToolsActivePort });
	}
	const metadata = await pollCdpMetadata(portResult.port, deadlineMs);
	if (!metadata) {
		return fail("port-not-found", undefined, { cdpVersionReached: false, devToolsActivePort: portResult.devToolsActivePort, port: portResult.port });
	}
	const record = buildLaunchRecord({
		createdAtMs: Date.now(),
		pid: child.pid,
		port: portResult.port,
		target,
		targetType: options.targetType,
		userDataDir,
		version: metadata.version,
	});
	const connectArg = selectElectronConnectArg({
		port: portResult.port,
		targets: metadata.targets,
		targetType: options.targetType,
		version: metadata.version,
	});
	return {
		ok: true,
		value: {
			appArgs,
			child,
			connectArg,
			record,
			target,
			targets: metadata.targets,
			version: metadata.version,
		},
	};
}
