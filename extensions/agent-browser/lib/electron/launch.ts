import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
	discoverElectronApps,
	inspectElectronAppPath,
	inspectElectronExecutablePath,
	type ElectronAppDiscovery,
} from "./discovery.js";
import type { ElectronCdpTarget, ElectronCdpVersion } from "./cdp.js";
import { createSecureTempDirectory, preserveSecureTempDirectory } from "../temp.js";
import { stringifyUnknown } from "../results/text.js";
import { readProcessStartIdentity } from "../process-identity.js";
import {
	isElectronLaunchAborted,
	pollCdpMetadata,
	pollDevToolsActivePort,
	type ElectronLaunchMetadata,
} from "./launch-monitor.js";
import { ElectronLaunchProcess } from "./launch-process.js";
import {
	ELECTRON_LAUNCH_RECORD_VERSION,
	ELECTRON_PROFILE_DIR_PREFIX,
	type ElectronLaunchFailureDiagnostics,
	type ElectronLaunchFailureReason,
	type ElectronLaunchOptions,
	type ElectronLaunchRecord,
	type ElectronLaunchResult,
	type ElectronPolicyBlock,
	type ResolveElectronTargetOptions,
} from "./launch-types.js";

export type { ElectronCdpTarget, ElectronCdpVersion } from "./cdp.js";
export { ELECTRON_LAUNCH_RECORD_VERSION, ELECTRON_PROFILE_DIR_PREFIX } from "./launch-types.js";
export type {
	ElectronDevToolsActivePortRead,
	ElectronLaunchFailureDiagnostics,
	ElectronLaunchCleanupState,
	ElectronLaunchFailureReason,
	ElectronLaunchRecord,
	ElectronPolicyBlock,
	ElectronLaunchSuccess,
	ElectronLaunchFailure,
	ElectronLaunchResult,
	ResolveElectronTargetOptions,
} from "./launch-types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_APP_ARGS = ["--disable-extensions", "--no-first-run", "--no-default-browser-check"];

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
	if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		return DEFAULT_TIMEOUT_MS;
	}
	return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

function normalizeIdentifier(value: string | undefined): string | undefined {
	const trimmed = value?.trim().toLowerCase();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function policyEntryMatchesApp(entry: string, app: ElectronAppDiscovery): boolean {
	const normalized = normalizeIdentifier(entry);
	if (normalized === undefined) {
		return false;
	}
	const identifiers = [
		app.name,
		app.bundleId,
		app.desktopId,
		app.appPath,
		app.executablePath,
	].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	return identifiers.some((identifier) => identifier.toLowerCase().includes(normalized));
}

function evaluateLaunchPolicy(
	options: ElectronLaunchOptions,
	target: ElectronAppDiscovery,
): ElectronPolicyBlock | undefined {
	const denyEntry = options.deny?.find((entry) => policyEntryMatchesApp(entry, target));
	if (denyEntry !== undefined && denyEntry.length > 0) {
		return {
			entry: denyEntry,
			list: "deny",
			message: `Electron launch blocked by caller deny policy: ${denyEntry}`,
		};
	}
	if (options.allow !== undefined && options.allow.length > 0) {
		const allowEntry = options.allow.find((entry) => policyEntryMatchesApp(entry, target));
		if (allowEntry === undefined || allowEntry.length === 0) {
			return {
				list: "allow",
				message:
					"Electron launch blocked because the resolved app did not match caller allow policy.",
			};
		}
	}
	return undefined;
}

async function resolveLaunchTarget(
	options: ResolveElectronTargetOptions,
): Promise<ElectronAppDiscovery | undefined> {
	if (options.appPath !== undefined && options.appPath.length > 0) {
		return inspectElectronAppPath(options.appPath);
	}
	if (options.executablePath !== undefined && options.executablePath.length > 0) {
		return inspectElectronExecutablePath(options.executablePath);
	}
	const discovery = await discoverElectronApps({
		maxResults: 200,
		query: options.bundleId ?? options.appName,
	});
	return selectDiscoveredTarget(discovery.apps, options);
}

function selectDiscoveredTarget(
	apps: readonly ElectronAppDiscovery[],
	options: ResolveElectronTargetOptions,
): ElectronAppDiscovery | undefined {
	if ((options.bundleId ?? "").length > 0) {
		const bundleId = normalizeIdentifier(options.bundleId);
		return apps.find((app) => normalizeIdentifier(app.bundleId) === bundleId);
	}
	if ((options.appName ?? "").length > 0) {
		const name = normalizeIdentifier(options.appName);
		return apps.find((app) => normalizeIdentifier(app.name) === name) ?? apps.at(0);
	}
	return undefined;
}

function targetMatchesType(
	target: ElectronCdpTarget,
	type: ElectronLaunchOptions["targetType"],
): boolean {
	return type === undefined || type === "any" || target.type === type;
}

function selectConnectArg(
	port: number,
	metadata: ElectronLaunchMetadata,
	type: ElectronLaunchOptions["targetType"],
): string {
	const targetSocket = metadata.targets.find(
		(target) =>
			targetMatchesType(target, type) &&
			target.webSocketDebuggerUrl !== undefined &&
			target.webSocketDebuggerUrl.length > 0,
	)?.webSocketDebuggerUrl;
	return targetSocket ?? metadata.version.webSocketDebuggerUrl ?? String(port);
}

function launchFailureMessage(
	reason: ElectronLaunchFailureReason,
	target: ElectronAppDiscovery | undefined,
	detail?: string,
): string {
	const label = target ? `${target.name} (${target.appPath ?? target.executablePath})` : "target";
	switch (reason) {
		case "aborted":
			return `Electron launch was aborted${target ? ` before ${label} finished starting` : " before the app started"}.`;
		case "non-electron-target":
			return `Electron launch rejected: ${label} does not have Electron framework evidence.`;
		case "policy-blocked":
			return detail ?? `Electron launch blocked by caller policy for ${label}.`;
		case "single-instance-conflict":
			return `Electron launch did not expose a debug port for ${label}; the app may already be running as a single-instance Electron app. Quit the running app and retry.`;
		case "port-not-found":
			return `Electron launch found a DevToolsActivePort for ${label}, but /json/version never returned a valid CDP payload.`;
		case "spawn-error":
			return `Electron launch failed while starting ${label}${detail !== undefined && detail.length > 0 ? `: ${detail}` : "."}`;
		case "timeout":
			return `Electron launch timed out waiting for DevToolsActivePort for ${label}.`;
	}
}

type FailureObservation = Pick<
	ElectronLaunchFailureDiagnostics,
	"cdpVersionReached" | "devToolsActivePort" | "port"
>;

/** Owns one profile and process attempt; only a successful result transfers them to the host. */
class ElectronLaunchAttempt {
	private readonly process: ElectronLaunchProcess;
	private readonly startedAtMs: number;
	private readonly timeoutMs: number;
	private readonly deadlineMs: number;
	private readonly appArgs: readonly string[];
	private startIdentity: string | undefined;

	constructor(
		private readonly options: ElectronLaunchOptions,
		private readonly target: ElectronAppDiscovery,
		private readonly userDataDir: string,
		timing: { readonly timeoutMs: number; readonly startedAtMs: number },
	) {
		this.process = new ElectronLaunchProcess(userDataDir);
		this.startedAtMs = timing.startedAtMs;
		this.timeoutMs = timing.timeoutMs;
		this.deadlineMs = timing.startedAtMs + timing.timeoutMs;
		this.appArgs = options.appArgs ?? [];
	}

	private diagnostics(observation: FailureObservation): ElectronLaunchFailureDiagnostics {
		return {
			...observation,
			elapsedMs: Math.max(0, Date.now() - this.startedAtMs),
			exitCode: this.process.exitCode,
			exitSignal: this.process.exitSignal,
			outputCaptured: this.process.outputCaptured,
			pid: this.process.child?.pid,
			pidAlive: this.process.child === undefined ? undefined : this.process.pidAlive(),
			port: observation.port ?? observation.devToolsActivePort?.port,
			timeoutMs: this.timeoutMs,
			userDataDir: this.userDataDir,
		};
	}

	private async cleanupProfile(processError: string | undefined): Promise<string | undefined> {
		try {
			if (processError !== undefined && processError.length > 0) {
				await preserveSecureTempDirectory(this.userDataDir);
			} else {
				await rm(this.userDataDir, { force: true, recursive: true });
			}
			return undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : stringifyUnknown(error);
			return processError !== undefined && processError.length > 0
				? `Profile preservation failed: ${message}`
				: message;
		}
	}

	private async fail(
		reason: ElectronLaunchFailureReason,
		detail?: string,
		observation: FailureObservation = {},
	): Promise<ElectronLaunchResult> {
		const diagnostics = this.diagnostics(observation);
		const processError = await this.process.terminate();
		const output = await this.process.readOutput();
		const profileError = await this.cleanupProfile(processError);
		const cleanupErrors = [processError, this.process.cleanupError, profileError].filter(
			(value) => value !== undefined,
		);
		const cleanupError = cleanupErrors.join("; ");
		return {
			ok: false,
			failure: {
				appArgs: this.appArgs,
				cleanupError: cleanupError.length === 0 ? undefined : cleanupError,
				diagnostics: { ...diagnostics, ...output.evidence },
				error: [launchFailureMessage(reason, this.target, detail), ...output.lines].join("\n"),
				reason,
				target: this.target,
				userDataDir: this.userDataDir,
			},
		};
	}

	private record(port: number, version: ElectronCdpVersion): ElectronLaunchRecord {
		const pid = this.process.child?.pid;
		return {
			appName: this.target.name,
			appPath: this.target.appPath,
			bundleId: this.target.bundleId,
			cleanupState: "active",
			createdAtMs: Date.now(),
			desktopId: this.target.desktopId,
			executablePath: this.target.executablePath,
			launchId: `electron-${randomUUID()}`,
			launchedByWrapper: true,
			packageSource: this.target.packageSource,
			pid,
			platform: this.target.platform,
			port,
			processGroupId: process.platform === "win32" ? undefined : pid,
			startIdentity: this.startIdentity,
			targetType: this.options.targetType,
			userDataDir: this.userDataDir,
			version: ELECTRON_LAUNCH_RECORD_VERSION,
			webSocketDebuggerUrl: version.webSocketDebuggerUrl,
		};
	}

	async run(): Promise<ElectronLaunchResult> {
		const args = [
			...this.appArgs,
			`--user-data-dir=${this.userDataDir}`,
			"--remote-debugging-port=0",
			...DEFAULT_APP_ARGS,
		];
		await this.process.spawn(this.target.executablePath, args, this.options.signal);
		if (this.process.child === undefined) {
			return this.fail(
				isElectronLaunchAborted(this.options.signal) ? "aborted" : "spawn-error",
				this.process.spawnError?.message,
			);
		}
		const pid = this.process.child.pid;
		this.startIdentity =
			pid === undefined
				? undefined
				: await readProcessStartIdentity(pid, process.platform, {
						deadline: this.deadlineMs,
						signal: this.options.signal,
					});
		const portResult = await pollDevToolsActivePort({
			deadlineMs: this.deadlineMs,
			getChildExit: this.process.childExit,
			getSpawnError: this.process.childSpawnError,
			signal: this.options.signal,
			userDataDir: this.userDataDir,
		});
		if (portResult.port === undefined) {
			return this.fail(portResult.failure ?? "timeout", portResult.spawnError?.message, {
				devToolsActivePort: portResult.devToolsActivePort,
			});
		}
		return this.connect(portResult.port, portResult.devToolsActivePort);
	}

	private async connect(
		port: number,
		devToolsActivePort: FailureObservation["devToolsActivePort"],
	): Promise<ElectronLaunchResult> {
		const metadataResult = await pollCdpMetadata(port, this.deadlineMs, this.options.signal);
		if (metadataResult.aborted) {
			return this.fail("aborted", undefined, { devToolsActivePort, port });
		}
		const metadata = metadataResult.metadata;
		if (metadata === undefined) {
			return this.fail("port-not-found", undefined, {
				cdpVersionReached: false,
				devToolsActivePort,
				port,
			});
		}
		const child = this.process.child;
		if (child === undefined) {
			throw new Error("Electron launch lost its child handle before handoff.");
		}
		return {
			ok: true,
			value: {
				appArgs: this.appArgs,
				child,
				connectArg: selectConnectArg(port, metadata, this.options.targetType),
				record: this.record(port, metadata.version),
				target: this.target,
				targets: metadata.targets,
				version: metadata.version,
			},
		};
	}
}

async function abortedProfileResult(
	userDataDir: string,
	options: ElectronLaunchOptions,
	target: ElectronAppDiscovery,
): Promise<ElectronLaunchResult> {
	let cleanupError: string | undefined;
	try {
		await rm(userDataDir, { force: true, recursive: true });
	} catch (error) {
		cleanupError = error instanceof Error ? error.message : stringifyUnknown(error);
	}
	return {
		ok: false,
		failure: {
			appArgs: options.appArgs ?? [],
			cleanupError,
			error: launchFailureMessage("aborted", target),
			reason: "aborted",
			target,
			userDataDir,
		},
	};
}

export async function launchElectronApp(
	options: ElectronLaunchOptions,
): Promise<ElectronLaunchResult> {
	const appArgs = options.appArgs ?? [];
	if (isElectronLaunchAborted(options.signal)) {
		return {
			ok: false,
			failure: { appArgs, error: launchFailureMessage("aborted", undefined), reason: "aborted" },
		};
	}
	const target = await resolveLaunchTarget(options);
	if (isElectronLaunchAborted(options.signal)) {
		return {
			ok: false,
			failure: {
				appArgs,
				error: launchFailureMessage("aborted", target),
				reason: "aborted",
				target,
			},
		};
	}
	if (target === undefined) {
		return {
			ok: false,
			failure: {
				appArgs,
				error: launchFailureMessage("non-electron-target", undefined),
				reason: "non-electron-target",
			},
		};
	}
	const policy = evaluateLaunchPolicy(options, target);
	if (policy !== undefined) {
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
	const userDataDir = await createSecureTempDirectory(ELECTRON_PROFILE_DIR_PREFIX);
	if (isElectronLaunchAborted(options.signal)) {
		return abortedProfileResult(userDataDir, options, target);
	}
	return new ElectronLaunchAttempt(options, target, userDataDir, { timeoutMs, startedAtMs }).run();
}
