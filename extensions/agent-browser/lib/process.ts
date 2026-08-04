/**
 * Purpose: Execute the upstream agent-browser binary for the pi-agent-browser extension.
 * Responsibilities: Validate POSIX socket storage, spawn the agent-browser subprocess, forward parent environment variables plus wrapper overrides, stream optional stdin, bound in-memory output buffering, spill oversized stdout safely to a private temp file under a disk budget, and honor abort signals.
 * Scope: Process execution only; argument planning, output formatting, and pi tool registration live elsewhere.
 * Usage: Called by the extension tool after argument validation and session planning are complete.
 * Invariants/Assumptions: The binary name is always `agent-browser`; Windows routes through PowerShell to invoke npm launchers with escaped argv; callers handle semantic success/error interpretation.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { env as processEnv, platform as processPlatform } from "node:process";

import { parseArgvDescriptor } from "./argv-descriptor.js";
import { needsManagedSession } from "./command-policy.js";
import { isKnownCommandToken } from "./command-taxonomy.js";
import {
	getFlagName,
	GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
	GLOBAL_VALUE_FLAGS,
	optionalGlobalValueFlagConsumesNext,
} from "./argv-grammar.js";
import {
	canonicalizeOwnedManagedSessionCloseArgs,
	commitManagedSessionRestoreSuppression,
	getManagedSessionRestoreConfigEnv,
	getManagedSessionRestoreEnv,
	getManagedSessionRestoreProtectedEnv,
	getOwnedManagedSessionCompatibilityEnv,
	getOwnedManagedSessionNamespaceEnv,
	isOwnedManagedSessionTarget,
	shouldOmitOwnedManagedSessionRestoreEnv,
	validateManagedSessionRestoreContextForSpawn,
	type ManagedSessionRestoreEnvOptions,
	type ManagedSessionRestoreState,
} from "./managed-session-restore.js";
import {
	getManagedSessionStateAccessValidationError,
	getManagedSessionTargetAccessValidationError,
} from "./managed-session-state-policy.js";
import { getImplicitSessionIdleTimeoutMs, isPlainTextInspectionArgs } from "./runtime.js";
import { openSecureTempFile, writeSecureTempChunk } from "./temp.js";

const MAX_BUFFERED_STDOUT_BYTES = 512 * 1_024;
const MAX_BUFFERED_STDERR_CHARS = 32_000;
const MAX_BUFFERED_STDOUT_TAIL_CHARS = 32_000;
const PROCESS_STDOUT_SPILL_FILE_PREFIX = "process-stdout";
const AGENT_BROWSER_SOCKET_DIR_ENV = "AGENT_BROWSER_SOCKET_DIR";
const AGENT_BROWSER_ARGS_ENV = "AGENT_BROWSER_ARGS";
const AGENT_BROWSER_DEFAULT_TIMEOUT_ENV = "AGENT_BROWSER_DEFAULT_TIMEOUT";
const AGENT_BROWSER_IDLE_TIMEOUT_ENV = "AGENT_BROWSER_IDLE_TIMEOUT_MS";
const PI_AGENT_BROWSER_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS";
const DEFAULT_AGENT_BROWSER_SOCKET_DIR_PREFIX = "/tmp/piab";
export const SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS = 25_000;
const DEFAULT_AGENT_BROWSER_PROCESS_TIMEOUT_MS = 35_000;
/** Grace period after `exit` before resolving when `close` is delayed by inherited stdio handles. */
const EXIT_STDIO_GRACE_MS = 100;
const WINDOWS_AGENT_BROWSER_MISSING_MARKER = "PI_AGENT_BROWSER_COMMAND_NOT_FOUND:agent-browser.cmd";
const attachedBrowserSessionContext = new AsyncLocalStorage<boolean>();

export function withAttachedBrowserSessionContext<T>(preserve: boolean, run: () => Promise<T>): Promise<T> {
	return attachedBrowserSessionContext.run(preserve || attachedBrowserSessionContext.getStore() === true, run);
}

export interface ProcessRunResult {
	aborted: boolean;
	/** True once the native agent-browser executable, not merely the Windows PowerShell launcher, started. */
	agentBrowserStarted: boolean;
	exitCode: number;
	spawnError?: Error;
	stderr: string;
	stdout: string;
	stdoutSpillPath?: string;
	timedOut: boolean;
	timeoutMs?: number;
}

function appendTail(text: string, addition: string, maxChars: number): string {
	const combined = text + addition;
	return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

function quoteWindowsPowerShellArg(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** Exported for unit tests that lock Windows launcher argv ordering. */
export function reorderWindowsLeadingGlobalArgs(args: string[]): string[] {
	const leadingGlobals: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] as string;
		if (isKnownCommandToken(token)) {
			return index === 0 ? args : [token, ...leadingGlobals, ...args.slice(index + 1)];
		}
		if (!token.startsWith("-")) return args;
		if (token.startsWith("--restore=")) {
			leadingGlobals.push(token);
			continue;
		}
		if (token === "--restore") {
			const value = args[index + 1];
			if (optionalGlobalValueFlagConsumesNext(token, value)) {
				leadingGlobals.push(`--restore=${value}`);
				index += 1;
			} else {
				leadingGlobals.push(token);
			}
			continue;
		}
		if (token.includes("=")) return args;
		const flag = getFlagName(token);
		if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(flag)) {
			leadingGlobals.push(token);
			if (["true", "false"].includes(args[index + 1] ?? "")) {
				leadingGlobals.push(args[index + 1] as string);
				index += 1;
			}
			continue;
		}
		if (GLOBAL_VALUE_FLAGS.includes(flag as typeof GLOBAL_VALUE_FLAGS[number])) {
			const value = args[index + 1];
			if (value === undefined) return args;
			leadingGlobals.push(token, value);
			index += 1;
			continue;
		}
		return args;
	}
	return args;
}

export function pinAgentBrowserFileAccessDisabled(args: string[], wrapperCompatibilityUserAgent?: string, preserveAttachedBrowserSession = false): string[] {
	const filtered: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token.startsWith("--allow-file-access=")) continue;
		if (token === "--allow-file-access") {
			if (["false", "true"].includes(args[index + 1] ?? "")) index += 1;
			continue;
		}
		filtered.push(token);
	}
	// These are launch-only controls. Sending them on an attached-session follow-up makes upstream replace the CDP connection with a local browser.
	if (preserveAttachedBrowserSession) return filtered;
	// Upstream's flag overrides only the active CDP target; the Chrome arg covers new tabs. Its --args parser splits commas/newlines.
	const browserArgs = wrapperCompatibilityUserAgent
		? `--user-agent=${wrapperCompatibilityUserAgent.replaceAll(/[\r\n,]/g, "")}`
		: "";
	return ["--args", browserArgs, "--allow-file-access", "false", ...filtered];
}

export function buildAgentBrowserSpawnCommand(args: string[], platform: NodeJS.Platform = processPlatform): { command: string; args: string[] } {
	if (platform !== "win32") {
		return { command: "agent-browser", args };
	}
	const invocationArgs = reorderWindowsLeadingGlobalArgs(args).map(quoteWindowsPowerShellArg).join(" ");
	const commandLine = [
		"$agentBrowser = Get-Command agent-browser.cmd -ErrorAction SilentlyContinue;",
		`if (-not $agentBrowser) { [Console]::Error.WriteLine('${WINDOWS_AGENT_BROWSER_MISSING_MARKER}'); exit 127 };`,
		`& $agentBrowser.Source ${invocationArgs}`.trimEnd(),
	].join(" ");
	return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", commandLine] };
}

export function isWindowsAgentBrowserCommandMissing(stderr: string): boolean {
	const normalized = stderr.toLowerCase();
	return normalized.includes(WINDOWS_AGENT_BROWSER_MISSING_MARKER.toLowerCase()) || (normalized.includes("agent-browser.cmd") && (
		normalized.includes("commandnotfoundexception") ||
		normalized.includes("not recognized as the name of a cmdlet") ||
		normalized.includes("not recognized as an internal or external command")
	));
}

export function shouldCommitManagedRestoreAfterWindowsProcess(input: {
	exitCode: number;
	spawnError?: Error;
	stderr: string;
}): boolean {
	return !input.spawnError && !(input.exitCode !== 0 && isWindowsAgentBrowserCommandMissing(input.stderr));
}

function terminateSpawnedChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (processPlatform === "win32" && child.pid) {
		const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		killer.on("error", () => undefined);
		killer.unref();
	}
	child.kill(signal);
}

/** Exported for unit tests that lock subprocess exit-code precedence. */
export function resolveSpawnedChildExitCode(input: {
	closeCode?: number | null;
	exitCode?: number | null;
	useExitFallback: boolean;
	timedOut: boolean;
	spawnError?: Error;
}): number {
	// Precedence: observed `close` code when present, then wrapper timeout (124), then
	// post-`exit` fallback when inherited stdio delays `close`, then spawn failure (127).
	if (input.closeCode !== null && input.closeCode !== undefined) {
		return input.closeCode;
	}
	if (input.timedOut) {
		return 124;
	}
	if (input.useExitFallback && input.exitCode !== null && input.exitCode !== undefined) {
		return input.exitCode;
	}
	return input.spawnError ? 127 : 0;
}

interface SpawnedChildCompletionWatcher {
	clear: () => void;
}

function watchSpawnedChildCompletion(
	child: ChildProcessWithoutNullStreams,
	options: {
		graceMs: number;
		onComplete: (exitCode: number) => void;
		getContext: () => { timedOut: boolean; spawnError?: Error };
	},
): SpawnedChildCompletionWatcher {
	let exited = false;
	let exitCode: number | null = null;
	let postExitTimer: NodeJS.Timeout | undefined;
	// `completed` suppresses duplicate exit/close callbacks; `settled` in `finish` guards async spill cleanup.
	let completed = false;

	const complete = (closeCode?: number | null) => {
		if (completed) return;
		completed = true;
		if (postExitTimer) {
			clearTimeout(postExitTimer);
			postExitTimer = undefined;
		}
		const context = options.getContext();
		options.onComplete(
			resolveSpawnedChildExitCode({
				closeCode,
				exitCode,
				useExitFallback: exited,
				timedOut: context.timedOut,
				spawnError: context.spawnError,
			}),
		);
	};

	child.once("exit", (code) => {
		exited = true;
		exitCode = code;
		postExitTimer = setTimeout(() => {
			destroySpawnedChildStreams(child);
			complete(undefined);
		}, options.graceMs);
		postExitTimer.unref?.();
	});
	child.once("close", (code) => {
		complete(code);
	});

	return {
		clear: () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
		},
	};
}

function destroySpawnedChildStreams(child: ChildProcessWithoutNullStreams): void {
	child.stdin?.destroy();
	child.stdout?.destroy();
	child.stderr?.destroy();
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) {
		return undefined;
	}
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function clampUpstreamDefaultTimeout(childEnv: NodeJS.ProcessEnv): void {
	const requestedTimeout = parsePositiveIntegerEnv(childEnv[AGENT_BROWSER_DEFAULT_TIMEOUT_ENV]);
	if (requestedTimeout === undefined || requestedTimeout > SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS) {
		childEnv[AGENT_BROWSER_DEFAULT_TIMEOUT_ENV] = String(SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS);
	}
}

export function getAgentBrowserProcessTimeoutMs(env: NodeJS.ProcessEnv = processEnv): number {
	return parsePositiveIntegerEnv(env[PI_AGENT_BROWSER_PROCESS_TIMEOUT_ENV]) ?? DEFAULT_AGENT_BROWSER_PROCESS_TIMEOUT_MS;
}

export function getAgentBrowserSocketDir(
	platform: NodeJS.Platform = processPlatform,
	uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): string | undefined {
	if (platform === "win32") {
		return undefined;
	}
	const prefix = platform === "darwin" ? "/private/tmp/piab" : DEFAULT_AGENT_BROWSER_SOCKET_DIR_PREFIX;
	return `${prefix}${typeof uid === "number" ? `-${uid}` : ""}`;
}

async function hasTrustedSocketDirAncestry(socketDir: string, uid: number): Promise<boolean> {
	for (let current = dirname(socketDir);;) {
		const metadata = await lstat(current);
		if (metadata.isSymbolicLink()) {
			if (metadata.uid !== 0) return false;
		} else if (!metadata.isDirectory()) {
			return false;
		}
		if (!metadata.isSymbolicLink()) {
			const mode = metadata.mode & 0o7777;
			if (metadata.uid === uid) {
				if ((mode & 0o022) !== 0) return false;
			} else if (metadata.uid !== 0 || ((mode & 0o022) !== 0 && (mode & 0o1000) === 0)) {
				return false;
			}
		}
		const parent = dirname(current);
		if (parent === current) return true;
		current = parent;
	}
}

async function socketDirEntriesAreOwned(socketDir: string, uid: number, visited = { count: 0 }): Promise<boolean> {
	for (const name of await readdir(socketDir)) {
		if ((visited.count += 1) > 16_384) return false;
		try {
			const path = join(socketDir, name);
			const metadata = await lstat(path);
			if (metadata.uid !== uid || metadata.isSymbolicLink()) return false;
			if (metadata.isDirectory()) {
				if (!await socketDirEntriesAreOwned(path, uid, visited)) return false;
			} else if (!metadata.isFile() && !metadata.isSocket()) {
				return false;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
	}
	return true;
}

export async function ensureAgentBrowserSocketDir(
	socketDir: string,
	uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): Promise<boolean> {
	if (!isAbsolute(socketDir) || typeof uid !== "number") return false;
	try {
		if (!await hasTrustedSocketDirAncestry(socketDir, uid)) return false;
		try {
			await mkdir(socketDir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		}
		const metadata = await lstat(socketDir);
		if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700) return false;
		return await hasTrustedSocketDirAncestry(socketDir, uid) && await socketDirEntriesAreOwned(socketDir, uid);
	} catch {
		return false;
	}
}

export function buildAgentBrowserProcessEnv(
	baseEnv: NodeJS.ProcessEnv = processEnv,
	overrides: NodeJS.ProcessEnv | undefined = undefined,
): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(baseEnv)) {
		if (value !== undefined) childEnv[name] = value;
	}

	for (const [name, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) {
			delete childEnv[name];
		} else {
			childEnv[name] = value;
		}
	}
	clampUpstreamDefaultTimeout(childEnv);
	return childEnv;
}

function getManagedPreSpawnPolicyError(
	options: ManagedSessionRestoreEnvOptions,
	effectiveEnv?: NodeJS.ProcessEnv,
	allowManagedSessionTarget = false,
	currentPageUrl?: string,
	pageUrlUnknown = false,
	trustedFirstBatchTabSelection = false,
	trustedPinnedEmptyConfig = false,
): string | undefined {
	const policyEnv = effectiveEnv ?? { ...(options.parentEnv ?? processEnv), ...options.env };
	const managedSessionTargetError = getManagedSessionTargetAccessValidationError(
		options.args,
		allowManagedSessionTarget || options.ownedManagedSession === true || isOwnedManagedSessionTarget(options.args),
		policyEnv,
	);
	if (managedSessionTargetError) return managedSessionTargetError;
	if (!validateManagedSessionRestoreContextForSpawn(options)) {
		return "Managed session restore policy, storage, or checkout identity changed after planning; refusing to start agent-browser.";
	}
	return getManagedSessionStateAccessValidationError({
		args: options.args,
		currentPageUrl,
		cwd: options.cwd,
		env: effectiveEnv ?? options.env,
		pageUrlUnknown,
		parentEnv: effectiveEnv ? {} : options.parentEnv ?? processEnv,
		stdin: options.stdin,
		trustedFirstBatchTabSelection,
		trustedPinnedEmptyConfig,
	});
}

export async function runAgentBrowserProcess(options: {
	allowManagedSessionTarget?: boolean;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	managedSessionRestoreState?: ManagedSessionRestoreState;
	managedStateCurrentPageUrl?: string;
	managedStatePageUrlUnknown?: boolean;
	ownedManagedSession?: boolean;
	preserveAttachedBrowserSession?: boolean;
	signal?: AbortSignal;
	stdin?: string;
	timeoutMs?: number;
	trustedFirstBatchTabSelection?: boolean;
}): Promise<ProcessRunResult> {
	const { allowManagedSessionTarget, cwd, env, managedSessionRestoreState, managedStateCurrentPageUrl, managedStatePageUrlUnknown, signal, stdin, trustedFirstBatchTabSelection } = options;
	const preserveAttachedBrowserSession = options.preserveAttachedBrowserSession === true || attachedBrowserSessionContext.getStore() === true;
	const ownedManagedSession = options.ownedManagedSession === true || isOwnedManagedSessionTarget(options.args);
	const args = canonicalizeOwnedManagedSessionCloseArgs({
		args: options.args,
		cwd,
		env,
		ownedManagedSession,
		restoreState: managedSessionRestoreState,
		stdin,
	});
	const timeoutMs = options.timeoutMs ?? getAgentBrowserProcessTimeoutMs();
	if (signal?.aborted) {
		return { aborted: true, agentBrowserStarted: false, exitCode: 1, stderr: "", stdout: "", timedOut: false };
	}
	const managedSessionRestoreOptions = {
		args,
		cwd,
		env,
		ownedManagedSession,
		restoreState: managedSessionRestoreState,
		stdin,
	};
	const planningPolicyError = getManagedPreSpawnPolicyError(managedSessionRestoreOptions, undefined, allowManagedSessionTarget, managedStateCurrentPageUrl, managedStatePageUrlUnknown, trustedFirstBatchTabSelection);
	if (planningPolicyError) {
		return {
			aborted: false,
			agentBrowserStarted: false,
			exitCode: 1,
			spawnError: new Error(planningPolicyError),
			stderr: "",
			stdout: "",
			timedOut: false,
		};
	}
	const managedSessionRestoreEnv = getManagedSessionRestoreEnv(managedSessionRestoreOptions);
	const ownedManagedSessionClose = shouldOmitOwnedManagedSessionRestoreEnv(managedSessionRestoreOptions);
	const browserConfigPinRequired = !isPlainTextInspectionArgs(args) && needsManagedSession(parseArgvDescriptor(args));
	const managedSessionRestoreConfigEnv = await getManagedSessionRestoreConfigEnv(managedSessionRestoreEnv, ownedManagedSessionClose || browserConfigPinRequired);
	if (managedSessionRestoreConfigEnv === undefined) {
		return {
			aborted: false,
			agentBrowserStarted: false,
			exitCode: 1,
			spawnError: new Error("Browser-backed agent-browser commands require a protected empty config, but secure temp storage was unavailable."),
			stderr: "",
			stdout: "",
			timedOut: false,
		};
	}
	const ownedManagedSessionCompatibilityEnv = getOwnedManagedSessionCompatibilityEnv(managedSessionRestoreOptions);
	const processOverrides: NodeJS.ProcessEnv = {
		[AGENT_BROWSER_IDLE_TIMEOUT_ENV]: String(getImplicitSessionIdleTimeoutMs()),
		...managedSessionRestoreEnv,
		...env,
		...managedSessionRestoreConfigEnv,
		...getManagedSessionRestoreProtectedEnv(managedSessionRestoreOptions, managedSessionRestoreEnv),
		...getOwnedManagedSessionNamespaceEnv(managedSessionRestoreOptions),
		...ownedManagedSessionCompatibilityEnv,
		AGENT_BROWSER_ALLOW_FILE_ACCESS: undefined,
		[AGENT_BROWSER_ARGS_ENV]: undefined,
	};
	const explicitSocketDir = processOverrides[AGENT_BROWSER_SOCKET_DIR_ENV];
	let effectiveEnv = explicitSocketDir === undefined ? { ...processOverrides, [AGENT_BROWSER_SOCKET_DIR_ENV]: undefined } : processOverrides;
	if (ownedManagedSessionClose) effectiveEnv = { ...effectiveEnv, AGENT_BROWSER_RESTORE: undefined };
	const requestedSocketDir = explicitSocketDir ?? getAgentBrowserSocketDir();
	if (requestedSocketDir !== undefined) {
		const socketDirIsSecure = requestedSocketDir.length > 0 && await ensureAgentBrowserSocketDir(requestedSocketDir);
		if (signal?.aborted) {
			return { aborted: true, agentBrowserStarted: false, exitCode: 1, stderr: "", stdout: "", timedOut: false };
		}
		if (!socketDirIsSecure) {
			return {
				aborted: false,
				agentBrowserStarted: false,
				exitCode: 1,
				spawnError: new Error("Agent-browser socket storage must be an absolute, non-symlink directory owned by the current user with mode 0700."),
				stderr: "",
				stdout: "",
				timedOut: false,
			};
		}
		effectiveEnv = { ...effectiveEnv, [AGENT_BROWSER_SOCKET_DIR_ENV]: requestedSocketDir };
	}
	if (signal?.aborted) {
		return { aborted: true, agentBrowserStarted: false, exitCode: 1, stderr: "", stdout: "", timedOut: false };
	}
	return await new Promise<ProcessRunResult>((resolve) => {
		let aborted = false;
		let agentBrowserStarted = false;
		let settled = false;
		let spawnError: Error | undefined;
		let stderr = "";
		let stdoutBuffers: Buffer[] = [];
		let stdoutBufferedBytes = 0;
		let stdoutTail = "";
		let stdoutSpillHandle: Awaited<ReturnType<typeof openSecureTempFile>>["fileHandle"] | undefined;
		let stdoutSpillPath: string | undefined;
		let pendingStdoutWrite = Promise.resolve();
		let stdoutSpillError: Error | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;
		let timedOut = false;
		let completionWatcher: SpawnedChildCompletionWatcher | undefined;

		const queueStdoutChunk = (buffer: Buffer) => {
			stdoutTail = appendTail(stdoutTail, buffer.toString("utf8"), MAX_BUFFERED_STDOUT_TAIL_CHARS);
			if (stdoutSpillError) return;
			if (!stdoutSpillPath && stdoutBufferedBytes + buffer.length <= MAX_BUFFERED_STDOUT_BYTES) {
				stdoutBuffers.push(buffer);
				stdoutBufferedBytes += buffer.length;
				return;
			}

			pendingStdoutWrite = pendingStdoutWrite
				.then(async () => {
					if (stdoutSpillError) return;
					if (!stdoutSpillHandle || !stdoutSpillPath) {
						const tempFile = await openSecureTempFile(PROCESS_STDOUT_SPILL_FILE_PREFIX, ".json");
						stdoutSpillHandle = tempFile.fileHandle;
						stdoutSpillPath = tempFile.path;
						if (stdoutBuffers.length > 0) {
							await writeSecureTempChunk({
								content: Buffer.concat(stdoutBuffers),
								fileHandle: stdoutSpillHandle,
								path: stdoutSpillPath,
							});
							stdoutBuffers = [];
							stdoutBufferedBytes = 0;
						}
					}
					await writeSecureTempChunk({ content: buffer, fileHandle: stdoutSpillHandle, path: stdoutSpillPath });
				})
				.catch((error) => {
					stdoutSpillError = error instanceof Error ? error : new Error(String(error));
				});
		};

		const removeAbortListener = () => {
			if (!signal || !abortListener) return;
			signal.removeEventListener("abort", abortListener);
			abortListener = undefined;
		};

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			void pendingStdoutWrite.finally(async () => {
				removeAbortListener();
				if (killTimer) {
					clearTimeout(killTimer);
				}
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
				}
				completionWatcher?.clear();
				if (stdoutSpillHandle) {
					await stdoutSpillHandle.close().catch(() => undefined);
				}
				const windowsMissingBinary = processPlatform === "win32" && exitCode !== 0 && isWindowsAgentBrowserCommandMissing(stderr);
				if (processPlatform === "win32" && !windowsMissingBinary && !spawnError) agentBrowserStarted = true;
				if (windowsMissingBinary && !spawnError) {
					spawnError = Object.assign(new Error("spawn agent-browser ENOENT"), { code: "ENOENT" });
				} else if (processPlatform === "win32" && shouldCommitManagedRestoreAfterWindowsProcess({ exitCode, spawnError, stderr })) {
					commitManagedSessionRestoreSuppression(managedSessionRestoreOptions);
				}
				if (!spawnError && stdoutSpillError) {
					spawnError = stdoutSpillError;
				}
				// Idempotent teardown: streams may already be destroyed by the post-`exit` fallback.
				destroySpawnedChildStreams(child);
				resolve({
					aborted,
					agentBrowserStarted,
					exitCode,
					spawnError,
					stderr,
					stdout: stdoutSpillPath ? stdoutTail : Buffer.concat(stdoutBuffers).toString("utf8"),
					stdoutSpillPath,
					timedOut,
					timeoutMs: timedOut ? timeoutMs : undefined,
				});
			});
		};

		const childEnv = buildAgentBrowserProcessEnv(processEnv, effectiveEnv);
		const spawnPolicyError = getManagedPreSpawnPolicyError(managedSessionRestoreOptions, childEnv, allowManagedSessionTarget, managedStateCurrentPageUrl, managedStatePageUrlUnknown, trustedFirstBatchTabSelection, managedSessionRestoreConfigEnv.AGENT_BROWSER_CONFIG !== undefined);
		if (spawnPolicyError) {
			resolve({ aborted: false, agentBrowserStarted: false, exitCode: 1, spawnError: new Error(spawnPolicyError), stderr: "", stdout: "", timedOut: false });
			return;
		}
		const spawnCommand = buildAgentBrowserSpawnCommand(pinAgentBrowserFileAccessDisabled(args, ownedManagedSessionCompatibilityEnv.AGENT_BROWSER_USER_AGENT, preserveAttachedBrowserSession));
		const child = spawn(spawnCommand.command, spawnCommand.args, {
			cwd,
			env: childEnv,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (processPlatform !== "win32") {
			child.once("spawn", () => {
				agentBrowserStarted = true;
				commitManagedSessionRestoreSuppression(managedSessionRestoreOptions);
			});
		}

		const terminateChild = (reason: "abort" | "timeout") => {
			if (settled) return;
			if (reason === "abort") {
				aborted = true;
			} else {
				timedOut = true;
			}
			terminateSpawnedChild(child, "SIGTERM");
			killTimer = setTimeout(() => {
				terminateSpawnedChild(child, "SIGKILL");
			}, 2_000);
		};
		const recordStdinError = (error: unknown) => {
			const stdinError = error instanceof Error ? error : new Error(String(error));
			const errorCode = (stdinError as NodeJS.ErrnoException).code;
			if (errorCode === "EPIPE" || errorCode === "EOF" || errorCode === "ERR_STREAM_DESTROYED") {
				return;
			}
			if (!spawnError) {
				spawnError = stdinError;
			}
		};
		const writeChildStdin = () => {
			if (aborted || signal?.aborted) {
				child.stdin.destroy();
				return;
			}
			try {
				if (stdin) {
					child.stdin.write(stdin);
				}
				child.stdin.end();
			} catch (error) {
				recordStdinError(error);
				child.stdin.destroy();
			}
		};

		child.stdin.on("error", recordStdinError);
		child.once("error", (error) => {
			spawnError = error instanceof Error ? error : new Error(String(error));
			finish(
				resolveSpawnedChildExitCode({
					useExitFallback: false,
					timedOut,
					spawnError,
				}),
			);
		});
		completionWatcher = watchSpawnedChildCompletion(child, {
			graceMs: EXIT_STDIO_GRACE_MS,
			onComplete: finish,
			getContext: () => ({ timedOut, spawnError }),
		});
		child.stdout.on("data", (chunk: Buffer | string) => {
			queueStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr = appendTail(stderr, chunk.toString(), MAX_BUFFERED_STDERR_CHARS);
		});

		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => terminateChild("timeout"), timeoutMs);
			timeoutTimer.unref?.();
		}

		if (signal) {
			abortListener = () => terminateChild("abort");
			signal.addEventListener("abort", abortListener, { once: true });
			if (signal.aborted) terminateChild("abort");
		}

		writeChildStdin();
	});
}
