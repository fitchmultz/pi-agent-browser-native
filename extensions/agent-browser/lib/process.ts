import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { env as processEnv, platform as processPlatform } from "node:process";

import { parseArgvDescriptor } from "./argv-descriptor.js";
import { isKnownCommandToken } from "./command-taxonomy.js";
import {
	extractExplicitSessionName,
	getFlagName,
	GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
	GLOBAL_VALUE_FLAGS,
	optionalGlobalValueFlagConsumesNext,
	resolveAgentBrowserNamespace,
} from "./argv-grammar.js";
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
import {
	getPageTargetValidationError,
} from "./page-target-validation.js";
import { getImplicitSessionIdleTimeoutMs } from "./runtime.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";
import { openSecureTempFile, writeSecureTempChunk } from "./temp.js";

const MAX_BUFFERED_STDOUT_BYTES = 512 * 1_024;
const MAX_BUFFERED_STDERR_CHARS = 32_000;
const MAX_BUFFERED_STDOUT_TAIL_CHARS = 32_000;
const PROCESS_STDOUT_SPILL_FILE_PREFIX = "process-stdout";
const AGENT_BROWSER_SOCKET_DIR_ENV = "AGENT_BROWSER_SOCKET_DIR";
const AGENT_BROWSER_DEFAULT_TIMEOUT_ENV = "AGENT_BROWSER_DEFAULT_TIMEOUT";
const AGENT_BROWSER_IDLE_TIMEOUT_ENV = "AGENT_BROWSER_IDLE_TIMEOUT_MS";
const PI_AGENT_BROWSER_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS";
const PI_AGENT_BROWSER_SOCKET_DIR_ENV = "PI_AGENT_BROWSER_SOCKET_DIR";
const DEFAULT_AGENT_BROWSER_SOCKET_DIR_PREFIX = "/tmp/piab";
const TERMUX_PACKAGE_NAME_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;
export const SAFE_AGENT_BROWSER_OPERATION_TIMEOUT_MS = 25_000;
const DEFAULT_AGENT_BROWSER_PROCESS_TIMEOUT_MS = 35_000;
/** Grace period after `exit` before resolving when `close` is delayed by inherited stdio handles. */
const EXIT_STDIO_GRACE_MS = 100;
const WINDOWS_AGENT_BROWSER_MISSING_MARKER = "PI_AGENT_BROWSER_COMMAND_NOT_FOUND:agent-browser.cmd";
const attachedBrowserSessionContext = new AsyncLocalStorage<boolean>();
const WINDOWS_COMMANDS_WITH_ADJACENT_SUBCOMMAND = new Set([
	"auth", "clipboard", "cookies", "dashboard", "device", "dialog", "diff", "find", "get", "is", "keyboard",
	"mouse", "network", "plugin", "profiler", "react", "record", "session", "set", "skills", "state", "storage",
	"stream", "tab", "trace", "webmcp", "window",
]);

export function withAttachedBrowserSessionContext<T>(preserve: boolean, run: () => Promise<T>): Promise<T> {
	return attachedBrowserSessionContext.run(preserve || attachedBrowserSessionContext.getStore() === true, run);
}

export function getWindowsExplicitDefaultNamespaceEnv(
	args: string[],
	parentNamespace: string | undefined,
	platform: NodeJS.Platform = processPlatform,
): NodeJS.ProcessEnv {
	return platform === "win32" && resolveAgentBrowserNamespace(args, parentNamespace) === ""
		? { AGENT_BROWSER_NAMESPACE: "" }
		: {};
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
			if (index === 0) return args;
			const firstPositional = args[index + 1];
			return WINDOWS_COMMANDS_WITH_ADJACENT_SUBCOMMAND.has(token) && firstPositional && !firstPositional.startsWith("-")
				? [token, firstPositional, ...leadingGlobals, ...args.slice(index + 2)]
				: [token, ...leadingGlobals, ...args.slice(index + 1)];
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
			// PowerShell -> .cmd drops empty argv values. Planning rejects empty
			// caller --args; keep this defensive skip so an unexpected empty value
			// cannot turn the next flag into its accidental value on native Windows.
			if (value === "" && (flag === "--args" || flag === "--namespace")) {
				index += 1;
				continue;
			}
			leadingGlobals.push(token, value);
			index += 1;
			continue;
		}
		return args;
	}
	return args;
}

export function prepareAgentBrowserSpawnArgs(args: string[], wrapperCompatibilityUserAgent?: string, preserveAttachedBrowserSession = false): string[] {
	if (preserveAttachedBrowserSession || !wrapperCompatibilityUserAgent) return args;
	return ["--args", `--user-agent=${wrapperCompatibilityUserAgent.replaceAll(/[\r\n,]/g, "")}`, ...args];
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
	termuxPackageName: string | undefined = processEnv.TERMUX_APP__PACKAGE_NAME,
): string | undefined {
	if (platform === "win32") {
		return undefined;
	}
	const termuxAppRoot = platform === "android" && termuxPackageName && TERMUX_PACKAGE_NAME_PATTERN.test(termuxPackageName);
	const prefix = platform === "darwin"
		? "/private/tmp/piab"
		: termuxAppRoot
			? `/data/data/${termuxPackageName}/piab`
			: DEFAULT_AGENT_BROWSER_SOCKET_DIR_PREFIX;
	return `${prefix}${!termuxAppRoot && typeof uid === "number" ? `-${uid}` : ""}`;
}

export function isTrustedAndroidAppDataRoot(
	path: string,
	metadata: { isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number },
	uid: number,
	platform: NodeJS.Platform = processPlatform,
): boolean {
	if (platform !== "android" || metadata.uid !== uid || metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) return false;
	const parent = dirname(path);
	return parent === "/data/data" || /^\/data\/user\/\d+$/.test(parent);
}

export function isTrustedSocketDirAncestor(
	metadata: { gid: number; isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number },
	uid: number,
	platform: NodeJS.Platform = processPlatform,
): boolean {
	if (metadata.isSymbolicLink()) return metadata.uid === 0;
	if (!metadata.isDirectory()) return false;
	const mode = metadata.mode & 0o7777;
	if (platform === "android" && uid !== 0 && metadata.uid === uid && metadata.gid === uid) return (mode & 0o002) === 0;
	if (metadata.uid === uid && uid !== 0) return (mode & 0o022) === 0;
	return metadata.uid === 0 && ((mode & 0o022) === 0 || (mode & 0o1000) !== 0);
}

async function hasTrustedSocketDirAncestry(socketDir: string, uid: number): Promise<boolean> {
	for (let current = dirname(socketDir);;) {
		const metadata = await lstat(current);
		if (isTrustedAndroidAppDataRoot(current, metadata, uid)) return true;
		if (!isTrustedSocketDirAncestor(metadata, uid)) return false;
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

export async function getAgentBrowserSocketDirValidationError(
	socketDir: string,
	uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): Promise<string | undefined> {
	if (!isAbsolute(socketDir)) return "the path is not absolute";
	if (typeof uid !== "number") return "POSIX ownership metadata is unavailable";
	try {
		if (!await hasTrustedSocketDirAncestry(socketDir, uid)) return "an ancestor is writable, foreign-owned, a non-directory, or an untrusted symlink";
		try {
			await mkdir(socketDir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return `the directory could not be created (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
		}
		const metadata = await lstat(socketDir);
		if (!metadata.isDirectory()) return "the path is not a directory";
		if (metadata.isSymbolicLink()) return "the directory is a symlink";
		if (metadata.uid !== uid) return `the directory is owned by uid ${metadata.uid}, not uid ${uid}`;
		if ((metadata.mode & 0o777) !== 0o700) return `the directory mode is ${(metadata.mode & 0o777).toString(8)}, not 700`;
		if (!await hasTrustedSocketDirAncestry(socketDir, uid)) return "an ancestor became untrusted during validation";
		if (!await socketDirEntriesAreOwned(socketDir, uid)) return "the directory contains a foreign-owned, symlink, special, or excessively deep entry";
		return undefined;
	} catch (error) {
		return `the directory could not be inspected (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
	}
}

export async function ensureAgentBrowserSocketDir(
	socketDir: string,
	uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): Promise<boolean> {
	return await getAgentBrowserSocketDirValidationError(socketDir, uid) === undefined;
}

export function getAgentBrowserSocketPathValidationError(options: {
	args: string[];
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	socketDir: string;
}): string | undefined {
	if ((options.platform ?? processPlatform) === "win32") return undefined;
	const descriptor = parseArgvDescriptor(options.args);
	const { command } = descriptor.commandInfo;
	// Preflight commands that can start or navigate a browser. Follow-up reads and
	// cleanup may target a daemon created by an earlier wrapper version, so let
	// upstream inspect those identities instead of rejecting them from path math.
	if (!command || !["batch", "connect", "goto", "navigate", "open", "visit"].includes(command)) return undefined;
	const sessionName = extractExplicitSessionName(options.args);
	if (!sessionName) return undefined;
	const namespace = resolveAgentBrowserNamespace(options.args, options.env?.AGENT_BROWSER_NAMESPACE);
	const socketRoot = namespace ? join(options.socketDir, "namespaces", namespace, "run") : options.socketDir;
	const socketPath = join(socketRoot, `${sessionName}.sock`);
	const pathBytes = Buffer.byteLength(socketPath);
	if (pathBytes <= 103) return undefined;
	return `Agent-browser Unix socket path would be ${pathBytes} bytes (max 103) for session ${JSON.stringify(sessionName)} under ${JSON.stringify(options.socketDir)}. Set PI_AGENT_BROWSER_SOCKET_DIR to a shorter absolute private directory such as /tmp/piab-<uid> with mode 0700; retrying sessionMode \"fresh\" cannot shorten this configured root.`;
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
	currentPageUrl?: string,
	pageUrlUnknown = false,
	trustedFirstBatchTabSelection = false,
): string | undefined {
	if (!validateManagedSessionRestoreContextForSpawn(options)) {
		return "Managed session restore policy, storage, or checkout identity changed after planning; refusing to start agent-browser.";
	}
	return getPageTargetValidationError({
		args: options.args,
		currentPageUrl,
		pageUrlUnknown,
		stdin: options.stdin,
		trustedFirstBatchTabSelection,
	});
}

export async function runAgentBrowserProcess(options: {
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
	const { cwd, env, managedSessionRestoreState, managedStateCurrentPageUrl, managedStatePageUrlUnknown, signal, stdin, trustedFirstBatchTabSelection } = options;
	const preserveAttachedBrowserSession = options.preserveAttachedBrowserSession === true || attachedBrowserSessionContext.getStore() === true;
	const ownedManagedSession = options.ownedManagedSession === true || isOwnedManagedSessionTarget(options.args);
	const args = options.args;
	const timeoutMs = options.timeoutMs ?? getAgentBrowserProcessTimeoutMs();
	if (signal?.aborted) {
		return { aborted: true, agentBrowserStarted: false, exitCode: 1, stderr: "", stdout: "", timedOut: false };
	}
	const parentEnv = getAgentBrowserProcessEnvironment();
	const managedSessionRestoreOptions = {
		args,
		cwd,
		env,
		ownedManagedSession,
		parentEnv,
		restoreState: managedSessionRestoreState,
		stdin,
	};
	const planningPolicyError = getManagedPreSpawnPolicyError(managedSessionRestoreOptions, managedStateCurrentPageUrl, managedStatePageUrlUnknown, trustedFirstBatchTabSelection);
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
	const ownedManagedSessionCompatibilityEnv = getOwnedManagedSessionCompatibilityEnv(managedSessionRestoreOptions);
	const processOverrides: NodeJS.ProcessEnv = {
		[AGENT_BROWSER_IDLE_TIMEOUT_ENV]: String(getImplicitSessionIdleTimeoutMs()),
		...managedSessionRestoreEnv,
		...env,
		...getManagedSessionRestoreProtectedEnv(managedSessionRestoreOptions, managedSessionRestoreEnv),
		...getOwnedManagedSessionNamespaceEnv(managedSessionRestoreOptions),
		...getWindowsExplicitDefaultNamespaceEnv(args, parentEnv.AGENT_BROWSER_NAMESPACE),
		...ownedManagedSessionCompatibilityEnv,
	};
	const explicitSocketDir = processOverrides[AGENT_BROWSER_SOCKET_DIR_ENV];
	let effectiveEnv = explicitSocketDir === undefined ? { ...processOverrides, [AGENT_BROWSER_SOCKET_DIR_ENV]: undefined } : processOverrides;
	const requestedSocketDir = explicitSocketDir ?? parentEnv[PI_AGENT_BROWSER_SOCKET_DIR_ENV] ?? getAgentBrowserSocketDir();
	if (requestedSocketDir !== undefined) {
		const socketDirError = requestedSocketDir.length > 0
			? await getAgentBrowserSocketDirValidationError(requestedSocketDir)
			: "the configured path is empty";
		if (signal?.aborted) {
			return { aborted: true, agentBrowserStarted: false, exitCode: 1, stderr: "", stdout: "", timedOut: false };
		}
		const socketPathError = socketDirError ? undefined : getAgentBrowserSocketPathValidationError({ args, env: effectiveEnv, socketDir: requestedSocketDir });
		if (socketDirError || socketPathError) {
			return {
				aborted: false,
				agentBrowserStarted: false,
				exitCode: 1,
				spawnError: new Error(socketPathError ?? `Agent-browser socket storage ${JSON.stringify(requestedSocketDir)} is unusable: ${socketDirError}. Use an absolute directory owned by the current uid with mode 0700 and remove foreign, symlink, or special entries.`),
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
		let stdoutSpillPending = false;
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
			if (!stdoutSpillPending && !stdoutSpillPath && stdoutBufferedBytes + buffer.length <= MAX_BUFFERED_STDOUT_BYTES) {
				stdoutBuffers.push(buffer);
				stdoutBufferedBytes += buffer.length;
				return;
			}

			stdoutSpillPending = true;
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

		const childEnv = buildAgentBrowserProcessEnv(parentEnv, effectiveEnv);
		const spawnPolicyError = getManagedPreSpawnPolicyError(managedSessionRestoreOptions, managedStateCurrentPageUrl, managedStatePageUrlUnknown, trustedFirstBatchTabSelection);
		if (spawnPolicyError) {
			resolve({ aborted: false, agentBrowserStarted: false, exitCode: 1, spawnError: new Error(spawnPolicyError), stderr: "", stdout: "", timedOut: false });
			return;
		}
		const spawnCommand = buildAgentBrowserSpawnCommand(prepareAgentBrowserSpawnArgs(args, ownedManagedSessionCompatibilityEnv.AGENT_BROWSER_USER_AGENT, preserveAttachedBrowserSession));
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
