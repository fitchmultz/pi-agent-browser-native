import { rm } from "node:fs/promises";

import { isRecord } from "../../parsing.js";
import { resolveExplicitAutosaveInterval } from "../../managed-session-restore.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { processStartIdentitiesMatch, readProcessStartIdentity } from "../../process-identity.js";
import { runAgentBrowserProcess } from "../../process.js";
import { parseAgentBrowserEnvelope } from "../../results/envelope.js";

const MANAGED_SESSION_DAEMON_INSPECTION_TIMEOUT_MS = 35_000;
const RUNNING_HEADED_AUTOSAVE_POLICY_CHANGE_ERROR =
	'AGENT_BROWSER_AUTOSAVE_INTERVAL_MS cannot change a running wrapper-owned headed session\'s launch-time periodic autosave interval. Close that session first, then retry with sessionMode: "fresh" so the new daemon starts with the requested interval.';

export function getRunningHeadedAutosavePolicyChangeError(
	recordedInterval: string | undefined,
	closeCommand = false,
): string | undefined {
	const explicitInterval = resolveExplicitAutosaveInterval(
		getAgentBrowserProcessEnvironment().AGENT_BROWSER_AUTOSAVE_INTERVAL_MS,
	);
	return recordedInterval !== undefined &&
		!closeCommand &&
		explicitInterval !== undefined &&
		explicitInterval !== recordedInterval
		? RUNNING_HEADED_AUTOSAVE_POLICY_CHANGE_ERROR
		: undefined;
}

export function getHeadedManagedAutosaveEnv(
	interval: string | undefined,
): NodeJS.ProcessEnv | undefined {
	return interval !== undefined ? { AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: interval } : undefined;
}

export type ManagedSessionDaemonInspection =
	| { readonly restoreKey: string | null; readonly status: "active"; readonly generation?: string }
	| { readonly status: "inactive" | "missing-binary" | "unknown" };

export interface PreparationDaemonObservation {
	readonly identity: string;
	readonly daemon: ManagedSessionDaemonInspection;
	readonly generationInspected: boolean;
}

export interface ManagedSessionDaemonInspectionOptions {
	readonly cwd: string;
	readonly includeGeneration?: boolean;
	readonly headedManagedAutosaveInterval?: string;
	readonly namespace?: string;
	readonly preserveAttachedBrowserSession?: boolean;
	readonly sessionName: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

interface DaemonGeneration {
	readonly pid: number;
	readonly start: string;
	readonly socketDir: string;
}

function isDaemonGeneration(value: unknown): value is DaemonGeneration {
	return (
		isRecord(value) &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		typeof value.start === "string" &&
		value.start !== "" &&
		typeof value.socketDir === "string"
	);
}

export function managedSessionDaemonGenerationsMatch(
	recorded: string | undefined,
	current: string | undefined,
): boolean | undefined {
	if (recorded === undefined || current === undefined) {
		return undefined;
	}
	try {
		const previous: unknown = JSON.parse(recorded);
		const observed: unknown = JSON.parse(current);
		if (!isDaemonGeneration(previous) || !isDaemonGeneration(observed)) {
			return undefined;
		}
		return previous.pid !== observed.pid || previous.socketDir !== observed.socketDir
			? false
			: processStartIdentitiesMatch(previous.start, observed.start);
	} catch {
		return undefined;
	}
}

async function readDaemonGeneration(
	runtime: Readonly<Record<string, unknown>>,
	options: ManagedSessionDaemonInspectionOptions,
): Promise<string | undefined> {
	if (
		options.includeGeneration !== true ||
		typeof runtime.backgroundPid !== "number" ||
		!Number.isSafeInteger(runtime.backgroundPid) ||
		runtime.backgroundPid <= 0 ||
		typeof runtime.socketDir !== "string" ||
		runtime.browserLaunched === false
	) {
		return undefined;
	}
	const start = await readProcessStartIdentity(runtime.backgroundPid, process.platform, {
		signal: options.signal,
		deadline: Date.now() + (options.timeoutMs ?? 5_000),
	});
	return start !== undefined && start !== ""
		? JSON.stringify({
				pid: runtime.backgroundPid,
				start,
				socketDir: runtime.socketDir,
			})
		: undefined;
}

async function parseDaemonInspection(
	data: unknown,
	options: ManagedSessionDaemonInspectionOptions,
): Promise<ManagedSessionDaemonInspection> {
	if (!isRecord(data) || typeof data.active !== "boolean") {
		return { status: "unknown" };
	}
	if (!data.active) {
		return { status: "inactive" };
	}
	if (!isRecord(data.runtime)) {
		return { status: "unknown" };
	}
	const generation = await readDaemonGeneration(data.runtime, options);
	if (typeof data.runtime.restoreKey === "string" && data.runtime.restoreKey.length > 0) {
		return { restoreKey: data.runtime.restoreKey, status: "active", generation };
	}
	return data.runtime.restoreKey === null
		? { restoreKey: null, status: "active", generation }
		: { status: "unknown" };
}

type DaemonProcessResult = Awaited<ReturnType<typeof runAgentBrowserProcess>>;

function daemonProcessFailure(
	processResult: DaemonProcessResult,
): ManagedSessionDaemonInspection | undefined {
	if (
		processResult.spawnError &&
		"code" in processResult.spawnError &&
		processResult.spawnError.code === "ENOENT"
	) {
		return { status: "missing-binary" };
	}
	return processResult.aborted || processResult.spawnError || processResult.exitCode !== 0
		? { status: "unknown" }
		: undefined;
}

async function readDaemonInfo(processResult: DaemonProcessResult): Promise<unknown> {
	const parsed = await parseAgentBrowserEnvelope({
		stdout: processResult.stdout,
		stdoutPath: processResult.stdoutSpillPath,
	});
	return (parsed.parseError ?? "") !== "" || parsed.envelope?.success === false
		? undefined
		: parsed.envelope?.data;
}

export async function inspectManagedSessionDaemon(
	options: ManagedSessionDaemonInspectionOptions,
): Promise<ManagedSessionDaemonInspection> {
	const processResult = await runAgentBrowserProcess({
		args: [
			"--json",
			"--namespace",
			options.namespace ?? "",
			"--session",
			options.sessionName,
			"session",
			"info",
		],
		cwd: options.cwd,
		env: getHeadedManagedAutosaveEnv(options.headedManagedAutosaveInterval),
		preserveAttachedBrowserSession: options.preserveAttachedBrowserSession,
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? MANAGED_SESSION_DAEMON_INSPECTION_TIMEOUT_MS,
	});
	try {
		const failure = daemonProcessFailure(processResult);
		return failure ?? (await parseDaemonInspection(await readDaemonInfo(processResult), options));
	} finally {
		if (processResult.stdoutSpillPath !== undefined && processResult.stdoutSpillPath !== "") {
			await rm(processResult.stdoutSpillPath, { force: true }).catch(() => {
				// Spill cleanup is best-effort and must not change the daemon inspection result.
			});
		}
	}
}
