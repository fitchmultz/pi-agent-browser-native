import type { ChildProcess } from "node:child_process";
import type { ElectronCdpTarget, ElectronCdpVersion } from "./cdp.js";
import type { ElectronAppDiscovery } from "./discovery.js";

export const ELECTRON_LAUNCH_RECORD_VERSION = 1;
export const ELECTRON_PROFILE_DIR_PREFIX = "electron-profile-";

export interface ElectronDevToolsActivePortRead {
	readonly error?: string;
	readonly found: boolean;
	readonly path: string;
	readonly port?: number;
}

export interface ElectronLaunchFailureDiagnostics {
	readonly cdpVersionReached?: boolean;
	readonly devToolsActivePort?: ElectronDevToolsActivePortRead;
	readonly elapsedMs?: number;
	readonly exitCode?: number | null;
	readonly exitSignal?: NodeJS.Signals | null;
	readonly outputCaptured: boolean;
	readonly stdoutTail?: string;
	readonly stdoutTruncated?: boolean;
	readonly stdoutError?: string;
	readonly stderrTail?: string;
	readonly stderrTruncated?: boolean;
	readonly stderrError?: string;
	readonly pid?: number;
	readonly pidAlive?: boolean;
	readonly port?: number;
	readonly timeoutMs?: number;
	readonly userDataDir?: string;
}

export type ElectronLaunchCleanupState = "active" | "cleaned" | "dead" | "failed" | "partial";
export type ElectronLaunchFailureReason =
	| "aborted"
	| "non-electron-target"
	| "policy-blocked"
	| "port-not-found"
	| "single-instance-conflict"
	| "spawn-error"
	| "timeout";

export interface ElectronLaunchRecord {
	readonly ownerSessionId?: string;
	readonly appName: string;
	readonly appPath?: string;
	readonly bundleId?: string;
	readonly cleanupState: ElectronLaunchCleanupState;
	readonly createdAtMs: number;
	readonly desktopId?: string;
	readonly executablePath: string;
	readonly launchId: string;
	readonly launchedByWrapper: true;
	readonly namespace?: string;
	readonly packageSource?: string;
	readonly pid?: number;
	readonly platform?: string;
	readonly port: number;
	readonly processGroupId?: number;
	readonly sessionName?: string;
	readonly startIdentity?: string;
	readonly targetType?: "any" | "page" | "webview";
	readonly userDataDir: string;
	readonly version: typeof ELECTRON_LAUNCH_RECORD_VERSION;
	readonly webSocketDebuggerUrl?: string;
}

export interface ElectronPolicyBlock {
	readonly entry?: string;
	readonly list: "allow" | "deny";
	readonly message: string;
}

export interface ElectronLaunchSuccess {
	readonly appArgs: readonly string[];
	readonly child: ChildProcess;
	readonly connectArg: string;
	readonly record: ElectronLaunchRecord;
	readonly target: ElectronAppDiscovery;
	readonly targets: readonly ElectronCdpTarget[];
	readonly version: ElectronCdpVersion;
}

export interface ElectronLaunchFailure {
	readonly appArgs: readonly string[];
	readonly cleanupError?: string;
	readonly diagnostics?: ElectronLaunchFailureDiagnostics;
	readonly error: string;
	readonly policy?: ElectronPolicyBlock;
	readonly reason: ElectronLaunchFailureReason;
	readonly target?: ElectronAppDiscovery;
	readonly userDataDir?: string;
}

export type ElectronLaunchResult =
	| { readonly ok: true; readonly value: ElectronLaunchSuccess }
	| { readonly ok: false; readonly failure: ElectronLaunchFailure };

export interface ResolveElectronTargetOptions {
	readonly appName?: string;
	readonly appPath?: string;
	readonly bundleId?: string;
	readonly executablePath?: string;
}

export interface ElectronLaunchOptions extends ResolveElectronTargetOptions {
	readonly allow?: readonly string[];
	readonly appArgs?: readonly string[];
	readonly deny?: readonly string[];
	readonly targetType?: "any" | "page" | "webview";
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}
