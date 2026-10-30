import { execFile } from "node:child_process";
import { dirname, join, win32 } from "node:path";
import { debugPolicyFailure } from "./browser-execution-policy-debug.js";

export function getCurrentProcessUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

const WINDOWS_PROCESS_START_IDENTITY_PREFIX = "win32-powershell-ticks-v1:";
const POSIX_PROCESS_START_IDENTITY_PREFIX = "posix-ps-utc-v1:";
// Native Windows PowerShell startup can exhaust the former five-second probe budget.
const PROCESS_START_IDENTITY_TIMEOUT_MS = process.platform === "win32" ? 10_000 : 5_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

export interface ProcessStartIdentityCommand {
	readonly args: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
	readonly file: string;
}

export function buildProcessStartIdentityCommand(
	pid: number,
	platform: NodeJS.Platform = process.platform,
): ProcessStartIdentityCommand | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
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
		(budget.deadline !== undefined && Date.now() >= budget.deadline)
	) {
		debugIdentityBudget(budget);
		return undefined;
	}
	const timeout = Math.max(
		1,
		Math.min(PROCESS_START_IDENTITY_TIMEOUT_MS, (budget.deadline ?? Infinity) - Date.now()),
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

async function readUncachedProcessStartIdentity(
	pid: number,
	platform: NodeJS.Platform,
	budget?: ProcessIdentityBudget,
): Promise<string | undefined> {
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
		(budget?.deadline !== undefined && Date.now() >= budget.deadline)
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
	// Persisted local-time identities have no timezone/locale provenance. A mismatch
	// with a qualified UTC identity cannot establish PID reuse or authorize cleanup.
	if (
		recorded.startsWith(POSIX_PROCESS_START_IDENTITY_PREFIX) !==
		current.startsWith(POSIX_PROCESS_START_IDENTITY_PREFIX)
	) {
		return undefined;
	}
	return recorded === current;
}
