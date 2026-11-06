import { AsyncLocalStorage } from "node:async_hooks";
import { env as processEnv } from "node:process";

import { runBrowserChild, type ProcessRunResult } from "./process-child.js";
export { resolveSpawnedChildExitCode, type ProcessRunResult } from "./process-child.js";
import { scanUpstreamGlobalFlagOccurrences } from "./argv-grammar.js";
import {
	commitManagedSessionRestoreSuppression,
	getManagedSessionRestoreEnv,
	getManagedSessionRestoreProtectedEnv,
	getOwnedManagedSessionCompatibilityEnv,
	getOwnedManagedSessionNamespaceEnv,
	isOwnedManagedSessionTarget,
	validateManagedSessionRestoreContextForSpawn,
	type ManagedSessionRestoreEnvOptions,
	type ManagedSessionRestoreState,
} from "./managed-session-restore.js";
import { getPageTargetValidationError } from "./page-target-validation.js";
import { getImplicitSessionIdleTimeoutMs } from "./runtime-timeouts.js";
import {
	getAgentBrowserProcessArgs,
	getAgentBrowserProcessEnvironment,
} from "./process-environment.js";
import { resolveWindowsStockLauncher } from "./windows-stock-launcher.js";

const AGENT_BROWSER_SOCKET_DIR_ENV = "AGENT_BROWSER_SOCKET_DIR";
const AGENT_BROWSER_DEFAULT_TIMEOUT_ENV = "AGENT_BROWSER_DEFAULT_TIMEOUT";
const AGENT_BROWSER_IDLE_TIMEOUT_ENV = "AGENT_BROWSER_IDLE_TIMEOUT_MS";
const PI_AGENT_BROWSER_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS";
import {
	getAgentBrowserSocketDirValidationError,
	getAgentBrowserSocketPathValidationError,
	resolveAgentBrowserSocketDir,
} from "./process-socket-storage.js";
export {
	getAgentBrowserSocketDir,
	getAgentBrowserSocketDirValidationError,
	getAgentBrowserSocketPathValidationError,
	isTrustedAndroidAppDataRoot,
	isTrustedSocketDirAncestor,
	resolveAgentBrowserSocketDir,
} from "./process-socket-storage.js";
export const SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS = 25_000;
const DEFAULT_AGENT_BROWSER_PROCESS_TIMEOUT_MS = 35_000;
const attachedBrowserSessionContext = new AsyncLocalStorage<boolean>();
const chromeStartupArgsContext = new AsyncLocalStorage<string | undefined>();

export function withChromeStartupArgs<T>(
	args: string | undefined,
	run: () => Promise<T>,
): Promise<T> {
	return chromeStartupArgsContext.run(args ?? chromeStartupArgsContext.getStore(), run);
}

export function withAttachedBrowserSessionContext<T>(
	preserve: boolean,
	run: () => Promise<T>,
): Promise<T> {
	return attachedBrowserSessionContext.run(
		preserve || attachedBrowserSessionContext.getStore() === true,
		run,
	);
}

export function prepareAgentBrowserSpawnArgs(
	args: readonly string[],
	wrapperCompatibilityUserAgent?: string,
	preserveAttachedBrowserSession = false,
	startupArgs?: string,
): readonly string[] {
	if (preserveAttachedBrowserSession) {
		return args;
	}
	const occurrence = scanUpstreamGlobalFlagOccurrences(args, "--args").at(-1);
	const customArgs =
		wrapperCompatibilityUserAgent !== undefined &&
		wrapperCompatibilityUserAgent.length > 0 &&
		!occurrence
			? `${startupArgs ?? "--no-startup-window"},--user-agent=${wrapperCompatibilityUserAgent.replaceAll(/[\r\n,]/g, "")}`
			: startupArgs;
	if (customArgs === undefined) {
		return args;
	}
	if (!occurrence) {
		return ["--args", customArgs, ...args];
	}
	const normalized = [...args];
	normalized[occurrence.index + 1] = customArgs;
	return normalized;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) {
		return undefined;
	}
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function getAgentBrowserProcessTimeoutMs(env: NodeJS.ProcessEnv = processEnv): number {
	return (
		parsePositiveIntegerEnv(env[PI_AGENT_BROWSER_PROCESS_TIMEOUT_ENV]) ??
		DEFAULT_AGENT_BROWSER_PROCESS_TIMEOUT_MS
	);
}

export function buildAgentBrowserProcessEnv(
	baseEnv: NodeJS.ProcessEnv = processEnv,
	overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(baseEnv)) {
		if (value !== undefined) {
			childEnv[name] = value;
		}
	}

	for (const [name, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) {
			delete childEnv[name];
		} else {
			childEnv[name] = value;
		}
	}
	const requestedTimeout = parsePositiveIntegerEnv(childEnv[AGENT_BROWSER_DEFAULT_TIMEOUT_ENV]);
	if (
		requestedTimeout === undefined ||
		requestedTimeout > SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS
	) {
		childEnv[AGENT_BROWSER_DEFAULT_TIMEOUT_ENV] = String(SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS);
	}
	return childEnv;
}

function getManagedPreSpawnPolicyError(
	options: ManagedSessionRestoreEnvOptions,
	currentPageUrl?: string,
	pageUrlUnknown = false,
	nativeConfirmationDecision = false,
): string | undefined {
	if (!validateManagedSessionRestoreContextForSpawn(options)) {
		return "Managed session restore policy, storage, or checkout identity changed after planning; refusing to start agent-browser.";
	}
	if (nativeConfirmationDecision) {
		return undefined;
	}
	return getPageTargetValidationError({
		args: options.args,
		currentPageUrl,
		pageUrlUnknown,
		stdin: options.stdin,
	});
}

export interface AgentBrowserProcessOptions {
	readonly args: readonly string[];
	readonly nativeConfirmationDecision?: boolean;
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv | undefined;
	readonly managedSessionRestoreState?: ManagedSessionRestoreState;
	readonly managedStateCurrentPageUrl?: string | undefined;
	readonly managedStatePageUrlUnknown?: boolean;
	readonly ownedManagedSession?: boolean;
	readonly preserveAttachedBrowserSession?: boolean | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly stdin?: string | undefined;
	readonly timeoutMs?: number | undefined;
}

function failureResult(error: string): ProcessRunResult {
	return {
		aborted: false,
		agentBrowserStarted: false,
		exitCode: 1,
		spawnError: new Error(error),
		stderr: "",
		stdout: "",
		timedOut: false,
	};
}

async function prepareProcessEnvironment(options: ManagedSessionRestoreEnvOptions): Promise<{
	readonly env: NodeJS.ProcessEnv;
	readonly userAgent?: string | undefined;
	readonly error?: string;
}> {
	const restoreEnv = getManagedSessionRestoreEnv(options);
	const compatibilityEnv = getOwnedManagedSessionCompatibilityEnv(options);
	const overrides: NodeJS.ProcessEnv = {
		...(options.ownedManagedSession === true
			? { [AGENT_BROWSER_IDLE_TIMEOUT_ENV]: String(getImplicitSessionIdleTimeoutMs()) }
			: {}),
		...restoreEnv,
		...options.env,
		...getManagedSessionRestoreProtectedEnv(options, restoreEnv),
		...getOwnedManagedSessionNamespaceEnv(options),
		...compatibilityEnv,
	};
	let effectiveEnv =
		overrides[AGENT_BROWSER_SOCKET_DIR_ENV] === undefined
			? { ...overrides, [AGENT_BROWSER_SOCKET_DIR_ENV]: undefined }
			: overrides;
	const socketDir = resolveAgentBrowserSocketDir({
		env: overrides,
		ownedManagedSession: options.ownedManagedSession,
		parentEnv: options.parentEnv,
	});
	if (socketDir !== undefined) {
		const directoryError =
			socketDir.length > 0
				? await getAgentBrowserSocketDirValidationError(socketDir)
				: "the configured path is empty";
		const pathError =
			directoryError === undefined
				? getAgentBrowserSocketPathValidationError({
						args: options.args,
						env: effectiveEnv,
						socketDir,
					})
				: undefined;
		if (directoryError !== undefined || pathError !== undefined) {
			return {
				env: effectiveEnv,
				error:
					pathError ??
					`Agent-browser socket storage ${JSON.stringify(socketDir)} is unusable: ${directoryError ?? "unknown error"}. Use an absolute directory owned by the current uid with mode 0700 and remove foreign, symlink, or special entries.`,
			};
		}
		effectiveEnv = { ...effectiveEnv, [AGENT_BROWSER_SOCKET_DIR_ENV]: socketDir };
	}
	return {
		env: buildAgentBrowserProcessEnv(options.parentEnv, effectiveEnv),
		userAgent: compatibilityEnv.AGENT_BROWSER_USER_AGENT,
	};
}

function restoreOptionsForProcess(
	options: Pick<
		AgentBrowserProcessOptions,
		"args" | "cwd" | "env" | "ownedManagedSession" | "managedSessionRestoreState" | "stdin"
	>,
): ManagedSessionRestoreEnvOptions {
	return {
		args: options.args,
		cwd: options.cwd,
		env: options.env,
		ownedManagedSession:
			options.ownedManagedSession === true || isOwnedManagedSessionTarget(options.args),
		parentEnv: getAgentBrowserProcessEnvironment(),
		restoreState: options.managedSessionRestoreState,
		stdin: options.stdin,
	};
}

function effectiveBrowserSpawnArgs(
	args: readonly string[],
	userAgent: string | undefined,
	preserveAttached: boolean | undefined,
): readonly string[] {
	return prepareAgentBrowserSpawnArgs(
		getAgentBrowserProcessArgs(args),
		userAgent,
		preserveAttached === true || attachedBrowserSessionContext.getStore() === true,
		chromeStartupArgsContext.getStore(),
	);
}

export async function runAgentBrowserProcess(
	options: AgentBrowserProcessOptions,
): Promise<ProcessRunResult> {
	const { signal } = options;
	const timeoutMs = options.timeoutMs ?? getAgentBrowserProcessTimeoutMs();
	const deadlineExpired = () =>
		signal?.reason instanceof Error && signal.reason.name === "TimeoutError";
	const cancelledResult = (): ProcessRunResult => ({
		aborted: !deadlineExpired(),
		agentBrowserStarted: false,
		exitCode: deadlineExpired() ? 124 : 1,
		stderr: "",
		stdout: "",
		timedOut: deadlineExpired(),
		timeoutMs: deadlineExpired() ? timeoutMs : undefined,
	});
	if (signal?.aborted === true) {
		return cancelledResult();
	}
	const restoreOptions = restoreOptionsForProcess(options);
	const policyError = () =>
		getManagedPreSpawnPolicyError(
			restoreOptions,
			options.managedStateCurrentPageUrl,
			options.managedStatePageUrlUnknown,
			options.nativeConfirmationDecision,
		);
	const planningError = policyError();
	if (planningError !== undefined) {
		return failureResult(planningError);
	}
	const prepared = await prepareProcessEnvironment(restoreOptions);
	// oxlint-disable-next-line typescript/no-unnecessary-condition -- QX-005: AbortSignal can change while filesystem validation is suspended.
	if (signal && signal.aborted) {
		return cancelledResult();
	}
	if (prepared.error !== undefined) {
		return failureResult(prepared.error);
	}
	const stockLauncher = resolveWindowsStockLauncher(options.cwd, prepared.env);
	// oxlint-disable-next-line typescript/no-unnecessary-condition -- QX-005: Reentrant launch preparation can abort the signal.
	if (signal && signal.aborted) {
		return cancelledResult();
	}
	return await runBrowserChild({
		args: effectiveBrowserSpawnArgs(
			options.args,
			prepared.userAgent,
			options.preserveAttachedBrowserSession,
		),
		cwd: options.cwd,
		env: prepared.env,
		stockLauncher,
		signal,
		stdin: options.stdin,
		timeoutMs,
		deadlineExpired,
		policyError,
		onStarted: () => {
			commitManagedSessionRestoreSuppression(restoreOptions);
		},
	});
}
