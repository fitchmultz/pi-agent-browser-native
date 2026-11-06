import type { ChildProcess } from "node:child_process";
import type { ElectronCdpTarget, ElectronCdpVersion } from "./cdp.js";
import type { ElectronAppDiscovery } from "./discovery.js";

export const ELECTRON_LAUNCH_RECORD_VERSION = 1;
export const ELECTRON_PROFILE_DIR_PREFIX = "electron-profile-";

export interface ElectronDevToolsActivePortRead {
	readonly error?: string | undefined;
	readonly found: boolean;
	readonly path: string;
	readonly port?: number | undefined;
}

export interface ElectronLaunchFailureDiagnostics {
	readonly cdpVersionReached?: boolean;
	readonly devToolsActivePort?: ElectronDevToolsActivePortRead | undefined;
	readonly elapsedMs?: number;
	readonly exitCode?: number | null;
	readonly exitSignal?: NodeJS.Signals | null;
	readonly outputCaptured: boolean;
	readonly stdoutTail?: string | undefined;
	readonly stdoutTruncated?: boolean | undefined;
	readonly stdoutError?: string | undefined;
	readonly stderrTail?: string | undefined;
	readonly stderrTruncated?: boolean | undefined;
	readonly stderrError?: string | undefined;
	readonly pid?: number | undefined;
	readonly pidAlive?: boolean | undefined;
	readonly port?: number | undefined;
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
	readonly ownerSessionId?: string | undefined;
	readonly appName: string;
	readonly appPath?: string | undefined;
	readonly bundleId?: string | undefined;
	readonly cleanupState: ElectronLaunchCleanupState;
	readonly createdAtMs: number;
	readonly desktopId?: string | undefined;
	readonly executablePath: string;
	readonly launchId: string;
	readonly launchedByWrapper: true;
	readonly namespace?: string | undefined;
	readonly packageSource?: string | undefined;
	readonly pid?: number | undefined;
	readonly platform?: string;
	readonly port: number;
	readonly processGroupId?: number | undefined;
	readonly sessionName?: string | undefined;
	readonly startIdentity?: string | undefined;
	readonly targetType?: "any" | "page" | "webview" | undefined;
	readonly userDataDir: string;
	readonly version: typeof ELECTRON_LAUNCH_RECORD_VERSION;
	readonly webSocketDebuggerUrl?: string | undefined;
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
	readonly cleanupError?: string | undefined;
	readonly diagnostics?: ElectronLaunchFailureDiagnostics;
	readonly error: string;
	readonly policy?: ElectronPolicyBlock;
	readonly reason: ElectronLaunchFailureReason;
	readonly target?: ElectronAppDiscovery | undefined;
	readonly userDataDir?: string;
}

export type ElectronLaunchResult =
	| { readonly ok: true; readonly value: ElectronLaunchSuccess }
	| { readonly ok: false; readonly failure: ElectronLaunchFailure };

export interface ResolveElectronTargetOptions {
	readonly appName?: string | undefined;
	readonly appPath?: string | undefined;
	readonly bundleId?: string | undefined;
	readonly executablePath?: string | undefined;
}

export interface ElectronLaunchOptions extends ResolveElectronTargetOptions {
	readonly allow?: readonly string[] | undefined;
	readonly appArgs?: readonly string[] | undefined;
	readonly deny?: readonly string[] | undefined;
	readonly targetType?: "any" | "page" | "webview";
	readonly timeoutMs?: number | undefined;
	readonly signal?: AbortSignal | undefined;
}
