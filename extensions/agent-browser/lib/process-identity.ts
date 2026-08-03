/**
 * Purpose: Describe the native command used to read a process start identity for PID-reuse-safe ownership checks.
 * Responsibilities: Keep POSIX and native-Windows process identity probes aligned across synchronous locks and asynchronous temp cleanup.
 * Scope: Command construction and output normalization only; callers choose sync or async execution and failure policy.
 */

const WINDOWS_PROCESS_START_IDENTITY_PREFIX = "win32-powershell-ticks-v1:";

export interface ProcessStartIdentityCommand {
	args: string[];
	file: string;
}

export function buildProcessStartIdentityCommand(
	pid: number,
	platform: NodeJS.Platform = process.platform,
): ProcessStartIdentityCommand | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	return platform === "win32"
		? {
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$p = Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ("${WINDOWS_PROCESS_START_IDENTITY_PREFIX}" + $p.StartTime.ToUniversalTime().Ticks)`,
			],
			file: "powershell.exe",
		}
		: {
			args: ["-p", String(pid), "-o", "lstart="],
			file: "ps",
		};
}

export function normalizeProcessStartIdentity(stdout: string): string | undefined {
	return stdout.trim().replace(/\s+/g, " ") || undefined;
}

/** Return undefined when a native-Windows marker predates the versioned PowerShell identity format. */
export function processStartIdentitiesMatch(
	recorded: string,
	current: string,
	platform: NodeJS.Platform = process.platform,
): boolean | undefined {
	if (platform === "win32") {
		const recordedIsCurrentFormat = recorded.startsWith(WINDOWS_PROCESS_START_IDENTITY_PREFIX);
		const currentIsCurrentFormat = current.startsWith(WINDOWS_PROCESS_START_IDENTITY_PREFIX);
		if (recordedIsCurrentFormat !== currentIsCurrentFormat) return undefined;
	}
	return recorded === current;
}
