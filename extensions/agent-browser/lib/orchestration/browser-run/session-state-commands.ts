import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "node:fs/promises";
import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { isBrowserIndependentRead, needsManagedSession } from "../../command-policy.js";
import { isRecord } from "../../parsing.js";
import { runAgentBrowserProcess, type ProcessRunResult } from "../../process.js";
import type { AgentBrowserEnvelope } from "../../results/contracts.js";
import { detectConfirmationRequired } from "../../results/confirmation.js";
import { parseAgentBrowserEnvelope } from "../../results/envelope.js";
import { observeNativeWebMcp } from "../../webmcp-observation.js";

export interface SessionCommandOptions {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env?: Readonly<NodeJS.ProcessEnv> | undefined;
	readonly namespace?: string | undefined;
	readonly onProcessResult?: (result: Readonly<ProcessRunResult>) => void;
	readonly pinNamespace?: boolean;
	readonly sessionName?: string | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly stdin?: string;
	readonly throwOnFailure?: boolean;
	readonly timeoutMs?: number | undefined;
}

interface SessionCommandObserver {
	readonly allow: (options: SessionCommandOptions) => boolean;
	readonly observe: (
		options: SessionCommandOptions,
		result: Readonly<ProcessRunResult>,
		envelope?: AgentBrowserEnvelope,
	) => void;
}
const sessionCommandObservation = new AsyncLocalStorage<SessionCommandObserver>();

export function withSessionCommandObservation<T>(
	observer: SessionCommandObserver,
	run: () => T,
): T {
	return sessionCommandObservation.run(observer, run);
}

function isNativeParseFailure(envelope: AgentBrowserEnvelope | undefined): boolean {
	if (
		envelope?.success !== false ||
		!isRecord(envelope.data) ||
		Object.keys(envelope.data).length !== 1
	) {
		return false;
	}
	return (
		typeof envelope.data.type === "string" &&
		[
			"unknown_command",
			"unknown_subcommand",
			"missing_arguments",
			"invalid_value",
			"invalid_session_name",
		].includes(envelope.data.type)
	);
}

function isSessionlessLocalCommand(commandTokens: readonly string[] | undefined): boolean {
	return (
		commandTokens !== undefined &&
		!needsManagedSession(parseArgvDescriptor(commandTokens)) &&
		!isBrowserIndependentRead(commandTokens)
	);
}

export function nativePolicyDefinitelyUnestablished(
	result: Readonly<ProcessRunResult>,
	envelope?: AgentBrowserEnvelope,
	commandTokens?: readonly string[],
): boolean {
	if (isSessionlessLocalCommand(commandTokens)) {
		return true;
	}
	if (!result.agentBrowserStarted) {
		return true;
	}
	if (
		result.aborted ||
		result.timedOut ||
		result.spawnError !== undefined ||
		result.exitCode !== 1
	) {
		return false;
	}
	// Native CLI parse/config failures precede ensure_daemon; a failed executed action does not.
	return (
		isNativeParseFailure(envelope) ||
		(result.stdout.trim() === "" &&
			/config file not found:|failed to load config from /.test(result.stderr))
	);
}

function processFailureReason(result: Readonly<ProcessRunResult>): string | undefined {
	if (result.aborted) {
		return "command was aborted";
	}
	if (result.spawnError !== undefined) {
		return "process could not start";
	}
	if (result.exitCode !== 0) {
		return `process exited with code ${result.exitCode}`;
	}
	return;
}

function structuredFailureReason(
	parsed: Readonly<Awaited<ReturnType<typeof parseAgentBrowserEnvelope>>>,
): string | undefined {
	if ((parsed.parseError?.length ?? 0) > 0) {
		return "returned invalid structured output";
	}
	if (parsed.envelope?.success === false || detectConfirmationRequired(parsed.envelope?.data)) {
		return "reported failure or requires confirmation";
	}
	return;
}

async function readSessionCommandResult(
	options: SessionCommandOptions,
	processResult: Readonly<ProcessRunResult>,
): Promise<unknown> {
	options.onProcessResult?.(processResult);
	const parsed = await parseAgentBrowserEnvelope({
		stdout: processResult.stdout,
		stdoutPath: processResult.stdoutSpillPath,
	});
	sessionCommandObservation.getStore()?.observe(options, processResult, parsed.envelope);
	const failure = processFailureReason(processResult) ?? structuredFailureReason(parsed);
	if (failure !== undefined) {
		if (options.throwOnFailure === true) {
			throw new Error(`agent-browser ${failure}`);
		}
		return;
	}
	observeNativeWebMcp(parsed.envelope?.data);
	return parsed.envelope?.data;
}

async function removeCommandSpill(path: string | undefined): Promise<void> {
	if (path === undefined || path.length === 0) {
		return;
	}
	try {
		await rm(path, { force: true });
	} catch {
		// The command result/parse error is authoritative. A private temporary stdout spill
		// is disposable; failing to unlink it must not turn success into failure or mask
		// the original exception. The process temp-root lifecycle also owns stale spills.
	}
}

export async function runSessionCommandData(options: SessionCommandOptions): Promise<unknown> {
	const { args, cwd, env, namespace, pinNamespace, sessionName, signal, stdin, timeoutMs } =
		options;
	if (
		sessionName === undefined ||
		sessionName.length === 0 ||
		sessionCommandObservation.getStore()?.allow(options) === false
	) {
		return;
	}
	const processResult = await runAgentBrowserProcess({
		args: [
			"--json",
			...(namespace !== undefined || pinNamespace === true ? ["--namespace", namespace ?? ""] : []),
			"--session",
			sessionName,
			...args,
		],
		cwd,
		env,
		signal,
		stdin,
		timeoutMs,
	});
	try {
		return await readSessionCommandResult(options, processResult);
	} finally {
		await removeCommandSpill(processResult.stdoutSpillPath);
	}
}
