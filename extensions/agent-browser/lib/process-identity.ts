import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { debugPolicyFailure } from "./browser-execution-policy-debug.js";

export function getCurrentProcessUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

const WINDOWS_PROCESS_START_IDENTITY_PREFIX = "win32-powershell-ticks-v1:";
const POSIX_PROCESS_START_IDENTITY_PREFIX = "posix-ps-utc-v1:";
const LINUX_PROCESS_START_IDENTITY_PREFIX = "linux-proc-boot-ticks-v1:";
const PROCESS_START_IDENTITY_FORMATS = [
	WINDOWS_PROCESS_START_IDENTITY_PREFIX,
	POSIX_PROCESS_START_IDENTITY_PREFIX,
	LINUX_PROCESS_START_IDENTITY_PREFIX,
] as const;
// Native Windows PowerShell startup can exhaust the former five-second probe budget.
const PROCESS_START_IDENTITY_TIMEOUT_MS = process.platform === "win32" ? 10_000 : 5_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";
// The kernel formats its per-boot UUID once per boot (drivers/char/random.c proc_do_uuid).
const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const LINUX_BOOT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// proc_pid_stat(5): starttime is field 22, and field 3 is the first field after comm's final ")".
const LINUX_STAT_START_TICKS_INDEX = 22 - 3;

export interface ProcessStartIdentityCommand {
	readonly args: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly file: string;
}

export function buildProcessStartIdentityCommand(
	pid: number,
	platform: NodeJS.Platform = process.platform,
): ProcessStartIdentityCommand | undefined {
	// Linux reads its kernel identity from procfs and needs no native helper.
	if (!Number.isSafeInteger(pid) || pid <= 0 || platform === "linux") {
		return undefined;
	}
	const configuredSystemRoot = process.env.SystemRoot;
	const windowsSystemRoot =
		configuredSystemRoot !== undefined &&
		configuredSystemRoot.length > 0 &&
		win32.isAbsolute(configuredSystemRoot)
			? configuredSystemRoot
			: DEFAULT_WINDOWS_SYSTEM_ROOT;
	return platform === "win32"
		? {
				args: [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`$ErrorActionPreference = 'Stop'; $p = $null; try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); [long]$ticks = $p.StartTime.ToUniversalTime().Ticks; if ($ticks -le 0) { throw 'Process start ticks unavailable' }; [Console]::Out.WriteLine("${WINDOWS_PROCESS_START_IDENTITY_PREFIX}" + $ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) } finally { if ($null -ne $p) { $p.Dispose() } }`,
				],
				file: win32.join(
					windowsSystemRoot,
					"System32",
					"WindowsPowerShell",
					"v1.0",
					"powershell.exe",
				),
			}
		: {
				args: ["-p", String(pid), "-o", "lstart="],
				env: { ...process.env, TZ: "UTC0", LC_ALL: "C" },
				file: platform === "android" ? join(dirname(process.execPath), "ps") : "/bin/ps",
			};
}

export function buildProcessStartIdentityCommands(
	pid: number,
	platform: NodeJS.Platform = process.platform,
): ProcessStartIdentityCommand[] {
	const primary = buildProcessStartIdentityCommand(pid, platform);
	if (!primary) {
		return [];
	}
	return platform === "win32"
		? [primary]
		: [
				primary,
				...(platform === "android"
					? [
							{ ...primary, file: "/bin/ps" },
							{ ...primary, file: "/usr/bin/ps" },
						]
					: [
							{ ...primary, file: "/usr/bin/ps" },
							{ ...primary, file: "ps" },
						]),
			];
}

export function normalizeProcessStartIdentity(stdout: string): string | undefined {
	const trimmed = stdout.trim();
	if (trimmed.length === 0 || trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
		return undefined;
	}
	return trimmed.replace(/\s+/g, " ");
}

let currentProcessStartIdentityPromise: Promise<string | undefined> | undefined;
let currentProcessStartIdentity: string | undefined;

interface ProcessIdentityBudget {
	readonly signal?: AbortSignal;
	/** A performance.now() timestamp, unaffected by wall-clock steps. */
	readonly deadline?: number;
}

function debugIdentityBudget(budget: ProcessIdentityBudget | undefined): void {
	debugPolicyFailure("probe.budget", budget?.signal?.aborted === true ? "cancelled" : "deadline");
}

async function executeProcessStartIdentityCommand(
	command: ProcessStartIdentityCommand,
	budget: ProcessIdentityBudget = {},
): Promise<string | undefined> {
	if (
		budget.signal?.aborted === true ||
		(budget.deadline !== undefined && performance.now() >= budget.deadline)
	) {
		debugIdentityBudget(budget);
		return undefined;
	}
	// execFile takes whole milliseconds, and 0 would disable its timeout.
	const timeout = Math.max(
		1,
		Math.ceil(
			Math.min(
				PROCESS_START_IDENTITY_TIMEOUT_MS,
				(budget.deadline ?? Infinity) - performance.now(),
			),
		),
	);
	return await new Promise((resolve) => {
		execFile(
			command.file,
			command.args,
			{ env: command.env, timeout, signal: budget.signal },
			(error, stdout) => {
				const identity = error ? undefined : normalizeProcessStartIdentity(stdout);
				if (identity === undefined) {
					debugPolicyFailure("probe.execute", error ? "native-error" : "invalid-output", error);
				}
				resolve(identity);
			},
		);
	});
}

export async function resolveProcessStartIdentityFromCommands(
	commands: readonly ProcessStartIdentityCommand[],
	execute: (
		command: ProcessStartIdentityCommand,
	) => Promise<string | undefined> = executeProcessStartIdentityCommand,
): Promise<string | undefined> {
	for (const command of commands) {
		// Fallback commands run only after the prior identity probe has failed.
		// oxlint-disable-next-line no-await-in-loop
		const identity = await execute(command);
		if (identity !== undefined && identity.length > 0) {
			return identity;
		}
	}
	return undefined;
}

async function readLinuxProcfsText(
	path: string,
	budget: ProcessIdentityBudget,
): Promise<string | undefined> {
	if (identityBudgetExpired(budget)) {
		debugIdentityBudget(budget);
		return undefined;
	}
	try {
		// Node's readFile honors the caller's AbortSignal between its native operations.
		return await readFile(path, { encoding: "latin1", signal: budget.signal });
	} catch (error) {
		debugPolicyFailure("probe.read", "native-error", error);
		return undefined;
	}
}

async function readLinuxBootId(budget: ProcessIdentityBudget): Promise<string | undefined> {
	const bootId = (await readLinuxProcfsText(LINUX_BOOT_ID_PATH, budget))?.replace(/\n$/, "");
	if (bootId === undefined || !LINUX_BOOT_ID_PATTERN.test(bootId)) {
		debugPolicyFailure("probe.boot-id", bootId === undefined ? "unavailable" : "invalid-output");
		return undefined;
	}
	return bootId;
}

function parseLinuxStartTicks(stat: string, pid: number): string | undefined {
	const header = `${String(pid)} (`;
	// comm can contain spaces, newlines and parentheses; only the final ")" closes it.
	const commEnd = stat.lastIndexOf(")");
	if (!stat.startsWith(header) || commEnd < header.length || stat[commEnd + 1] !== " ") {
		return undefined;
	}
	const ticks = stat
		.slice(commEnd + 2)
		.replace(/\n$/, "")
		.split(" ")
		.at(LINUX_STAT_START_TICKS_INDEX);
	// Keep the kernel's unsigned decimal exactly; Number conversion could lose precision.
	return ticks !== undefined && /^[0-9]+$/.test(ticks) ? ticks : undefined;
}

async function readLinuxProcessStartIdentity(
	pid: number,
	budget: ProcessIdentityBudget = {},
): Promise<string | undefined> {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return undefined;
	}
	const bootId = await readLinuxBootId(budget);
	if (bootId === undefined) {
		return undefined;
	}
	const stat = await readLinuxProcfsText(`/proc/${String(pid)}/stat`, budget);
	if (stat === undefined) {
		return undefined;
	}
	const ticks = parseLinuxStartTicks(stat, pid);
	if (ticks === undefined) {
		debugPolicyFailure("probe.stat", "invalid-output");
		return undefined;
	}
	// The kernel records boot-relative start time once at fork; wall-clock steps cannot change it.
	return `${LINUX_PROCESS_START_IDENTITY_PREFIX}${bootId}:${ticks}`;
}

async function readUncachedProcessStartIdentity(
	pid: number,
	platform: NodeJS.Platform,
	budget?: ProcessIdentityBudget,
): Promise<string | undefined> {
	if (platform === "linux") {
		return await readLinuxProcessStartIdentity(pid, budget);
	}
	const identity = await resolveProcessStartIdentityFromCommands(
		buildProcessStartIdentityCommands(pid, platform),
		(command) => executeProcessStartIdentityCommand(command, budget),
	);
	return identity === undefined || platform === "win32"
		? identity
		: `${POSIX_PROCESS_START_IDENTITY_PREFIX}${identity}`;
}

function identityBudgetExpired(budget: ProcessIdentityBudget | undefined): boolean {
	return (
		budget?.signal?.aborted === true ||
		(budget?.deadline !== undefined && performance.now() >= budget.deadline)
	);
}

export async function readProcessStartIdentity(
	pid: number,
	platform: NodeJS.Platform = process.platform,
	budget?: ProcessIdentityBudget,
): Promise<string | undefined> {
	if (identityBudgetExpired(budget)) {
		debugIdentityBudget(budget);
		return undefined;
	}
	if (pid !== process.pid || platform !== process.platform) {
		return await readUncachedProcessStartIdentity(pid, platform, budget);
	}
	if (currentProcessStartIdentity !== undefined && currentProcessStartIdentity.length > 0) {
		return currentProcessStartIdentity;
	}
	if (budget) {
		const identity = await readUncachedProcessStartIdentity(pid, platform, budget);
		if (identity !== undefined && identity.length > 0) {
			currentProcessStartIdentity = identity;
		}
		return identity;
	}
	return await readCachedProcessStartIdentity(pid, platform);
}

async function readCachedProcessStartIdentity(
	pid: number,
	platform: NodeJS.Platform,
): Promise<string | undefined> {
	currentProcessStartIdentityPromise ??= readUncachedProcessStartIdentity(pid, platform).then(
		(identity) => {
			if (identity === undefined || identity.length === 0) {
				currentProcessStartIdentityPromise = undefined;
			} else {
				currentProcessStartIdentity = identity;
			}
			return identity;
		},
	);
	return await currentProcessStartIdentityPromise;
}

export function processStartIdentitiesMatch(
	recorded: string,
	current: string,
): boolean | undefined {
	// Only identities read through the same native format are comparable. Untagged local times
	// and other formats can neither prove PID reuse nor authorize cleanup.
	const format = PROCESS_START_IDENTITY_FORMATS.find((prefix) => current.startsWith(prefix));
	if (format === undefined || !recorded.startsWith(format)) {
		return undefined;
	}
	return recorded === current;
}
