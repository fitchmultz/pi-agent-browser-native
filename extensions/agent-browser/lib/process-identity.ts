import { execFile } from "node:child_process";
import { dirname, join, win32 } from "node:path";

const WINDOWS_PROCESS_START_IDENTITY_PREFIX = "win32-powershell-ticks-v1:";
const PROCESS_START_IDENTITY_TIMEOUT_MS = 1_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

export interface ProcessStartIdentityCommand {
	args: string[];
	file: string;
}

export function buildProcessStartIdentityCommand(
	pid: number,
	platform: NodeJS.Platform = process.platform,
): ProcessStartIdentityCommand | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	const configuredSystemRoot = process.env.SystemRoot;
	const windowsSystemRoot = configuredSystemRoot && win32.isAbsolute(configuredSystemRoot)
		? configuredSystemRoot
		: DEFAULT_WINDOWS_SYSTEM_ROOT;
	return platform === "win32"
		? {
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$p = Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ("${WINDOWS_PROCESS_START_IDENTITY_PREFIX}" + $p.StartTime.ToUniversalTime().Ticks)`,
			],
			file: win32.join(windowsSystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		}
		: {
			args: ["-p", String(pid), "-o", "lstart="],
			file: platform === "android" ? join(dirname(process.execPath), "ps") : "/bin/ps",
		};
}

export function buildProcessStartIdentityCommands(
	pid: number,
	platform: NodeJS.Platform = process.platform,
): ProcessStartIdentityCommand[] {
	const primary = buildProcessStartIdentityCommand(pid, platform);
	if (!primary) return [];
	return platform === "win32"
		? [primary]
		: [primary, ...(platform === "android" ? [{ ...primary, file: "/bin/ps" }, { ...primary, file: "/usr/bin/ps" }] : [{ ...primary, file: "/usr/bin/ps" }])];
}

export function normalizeProcessStartIdentity(stdout: string): string | undefined {
	return stdout.trim().replace(/\s+/g, " ") || undefined;
}

let currentProcessStartIdentityPromise: Promise<string | undefined> | undefined;

async function executeProcessStartIdentityCommand(command: ProcessStartIdentityCommand): Promise<string | undefined> {
	return await new Promise((resolve) => {
		execFile(command.file, command.args, { timeout: PROCESS_START_IDENTITY_TIMEOUT_MS }, (error, stdout) => {
			resolve(error ? undefined : normalizeProcessStartIdentity(stdout));
		});
	});
}

export async function resolveProcessStartIdentityFromCommands(
	commands: readonly ProcessStartIdentityCommand[],
	execute: (command: ProcessStartIdentityCommand) => Promise<string | undefined> = executeProcessStartIdentityCommand,
): Promise<string | undefined> {
	for (const command of commands) {
		const identity = await execute(command);
		if (identity) return identity;
	}
	return undefined;
}

async function readUncachedProcessStartIdentity(pid: number, platform: NodeJS.Platform): Promise<string | undefined> {
	return await resolveProcessStartIdentityFromCommands(buildProcessStartIdentityCommands(pid, platform));
}

export async function readProcessStartIdentity(
	pid: number,
	platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
	if (pid !== process.pid || platform !== process.platform) return await readUncachedProcessStartIdentity(pid, platform);
	currentProcessStartIdentityPromise ??= readUncachedProcessStartIdentity(pid, platform).then((identity) => {
		if (!identity) currentProcessStartIdentityPromise = undefined;
		return identity;
	});
	return await currentProcessStartIdentityPromise;
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
