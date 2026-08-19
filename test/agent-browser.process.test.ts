/**
 * Purpose: Verify the agent-browser subprocess wrapper and parent environment pass-through behavior.
 * Responsibilities: Assert stdout spill handling, temp-budget failure behavior, full-payload parsing, and environment forwarding constraints.
 * Scope: Node test-runner coverage for process wrapper helpers using local child-process fixtures.
 * Usage: Run with `npx tsx --test test/agent-browser.process.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake binaries and explicit child-process cleanup to avoid leaks.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";
import test from "node:test";

import {
	buildOwnedManagedSessionRestoreContext,
	createManagedSessionRestoreKey,
	getManagedSessionRestoreScope,
	ManagedSessionRestoreState,
	withOwnedManagedSessionContext,
} from "../extensions/agent-browser/lib/managed-session-restore.js";
import { buildProcessStartIdentityCommand, buildProcessStartIdentityCommands, normalizeProcessStartIdentity, processStartIdentitiesMatch, resolveProcessStartIdentityFromCommands } from "../extensions/agent-browser/lib/process-identity.js";
import {
	buildAgentBrowserProcessEnv,
	buildAgentBrowserSpawnCommand,
	extractWindowsCmdShimExe,
	ensureAgentBrowserSocketDir,
	getAgentBrowserProcessTimeoutMs,
	getAgentBrowserSocketDir,
	getAgentBrowserSocketPathValidationError,
	getWindowsExplicitDefaultNamespaceEnv,
	isTrustedSocketDirAncestor,
	isWindowsAgentBrowserCommandMissing,
	pinAgentBrowserFileAccessDisabled,
	reorderWindowsLeadingGlobalArgs,
	resolveSpawnedChildExitCode,
	shouldCommitManagedRestoreAfterWindowsProcess,
	runAgentBrowserProcess,
} from "../extensions/agent-browser/lib/process.js";
import { parseAgentBrowserEnvelope } from "../extensions/agent-browser/lib/results/envelope.js";
import {
	cleanupSecureTempArtifacts,
	getSecureTempDebugState,
} from "../extensions/agent-browser/lib/temp.js";
import {
	buildStdioLingerFakeScript,
	createExtensionHarness,
	executeRegisteredTool,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("resolveSpawnedChildExitCode prefers close, then timeout, then exit fallback", () => {
	assert.equal(
		resolveSpawnedChildExitCode({
			closeCode: 1,
			exitCode: 0,
			useExitFallback: true,
			timedOut: true,
			spawnError: undefined,
		}),
		1,
	);
	assert.equal(
		resolveSpawnedChildExitCode({
			closeCode: null,
			exitCode: 143,
			useExitFallback: true,
			timedOut: true,
			spawnError: undefined,
		}),
		124,
	);
	assert.equal(
		resolveSpawnedChildExitCode({
			closeCode: undefined,
			exitCode: 0,
			useExitFallback: true,
			timedOut: false,
			spawnError: undefined,
		}),
		0,
	);
	assert.equal(
		resolveSpawnedChildExitCode({
			closeCode: undefined,
			exitCode: undefined,
			useExitFallback: false,
			timedOut: false,
			spawnError: new Error("spawn failed"),
		}),
		127,
	);
});

test("reorderWindowsLeadingGlobalArgs preserves supported global flag values", () => {
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs([
			"--json",
			"--session",
			"managed-session",
			"--proxy",
			"http://127.0.0.1:8080",
			"--headers",
			'{"authorization":"Bearer token"}',
			"--max-output",
			"2000",
			"open",
			"https://example.com",
		]),
		[
			"open",
			"--json",
			"--session",
			"managed-session",
			"--proxy",
			"http://127.0.0.1:8080",
			"--headers",
			'{"authorization":"Bearer token"}',
			"--max-output",
			"2000",
			"https://example.com",
		],
	);
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs(["--json", "--headed", "false", "--download-path", "/tmp/downloads", "open", "https://example.com"]),
		["open", "--json", "--headed", "false", "--download-path", "/tmp/downloads", "https://example.com"],
	);
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs(["--restore", "login-state", "open", "https://example.com"]),
		["open", "--restore=login-state", "https://example.com"],
	);
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs(["--restore", "open", "https://example.com"]),
		["open", "--restore", "https://example.com"],
	);
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs(["--restore=login-state", "open", "https://example.com"]),
		["open", "--restore=login-state", "https://example.com"],
	);
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs(["--hide-scrollbars", "false", "open", "https://example.com"]),
		["open", "--hide-scrollbars", "false", "https://example.com"],
	);
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs(["--hide-scrollbars", "open", "https://example.com"]),
		["open", "--hide-scrollbars", "https://example.com"],
	);
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs(["--json", "--namespace", "", "--session", "managed", "session", "info"]),
		["session", "info", "--json", "--session", "managed"],
	);
	assert.deepEqual(getWindowsExplicitDefaultNamespaceEnv(["--namespace", "", "open", "https://example.com"], "prod", "win32"), { AGENT_BROWSER_NAMESPACE: "" });
	assert.deepEqual(getWindowsExplicitDefaultNamespaceEnv(["open", "https://example.com"], "prod", "win32"), {});
	assert.deepEqual(getWindowsExplicitDefaultNamespaceEnv(["--namespace", "", "open", "https://example.com"], "prod", "darwin"), {});
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs(["--json", "--args", "", "--allow-file-access", "false", "--session", "managed", "get", "url"]),
		["get", "url", "--json", "--allow-file-access", "false", "--session", "managed"],
	);
	assert.deepEqual(
		reorderWindowsLeadingGlobalArgs(["--json", "--session", "managed", "find", "role", "combobox", "select", "chocolate", "--name", "Flavor"]),
		["find", "role", "--json", "--session", "managed", "combobox", "select", "chocolate", "--name", "Flavor"],
	);
	for (const invalid of [
		["--json", "--body", "secret", "session", "list"],
		["--auto-connect", "FALSE", "open", "https://example.com"],
		["--auto-connect=false", "open", "https://example.com"],
		["--download-path=/tmp/downloads", "open", "https://example.com"],
	]) {
		assert.deepEqual(reorderWindowsLeadingGlobalArgs(invalid), invalid);
	}
});

test("pinAgentBrowserFileAccessDisabled forces the separated upstream false form without an empty launch override", () => {
	const pinned = ["--allow-file-access", "false", "open", "about:blank"];
	assert.deepEqual(pinAgentBrowserFileAccessDisabled(["open", "about:blank"]), pinned);
	assert.deepEqual(pinAgentBrowserFileAccessDisabled(["--allow-file-access", "false", "open", "about:blank"]), pinned);
	assert.deepEqual(pinAgentBrowserFileAccessDisabled(["--allow-file-access", "true", "--allow-file-access=false", "open", "about:blank"]), pinned);
	assert.deepEqual(pinAgentBrowserFileAccessDisabled(["--args", "--disable-gpu", "open", "about:blank"]), ["--allow-file-access", "false", "--args", "--disable-gpu", "open", "about:blank"]);
	assert.deepEqual(
		pinAgentBrowserFileAccessDisabled(["open", "about:blank"], "Chrome, not Headless\n"),
		["--args", "--user-agent=Chrome not Headless", "--allow-file-access", "false", "open", "about:blank"],
	);
	assert.deepEqual(
		pinAgentBrowserFileAccessDisabled(["--allow-file-access", "false", "get", "url"], undefined, true),
		["get", "url"],
	);
});

test("runAgentBrowserProcess neutralizes environment raw browser args and pins an empty upstream config", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-raw-args-"));
	const binaryPath = join(tempDir, "agent-browser");
	const basePath = process.env.PATH ?? "";
	await writeFile(binaryPath, `#!/usr/bin/env node
const config = process.env.AGENT_BROWSER_CONFIG;
process.stdout.write(JSON.stringify({ success: true, data: { allowFileAccessEnv: process.env.AGENT_BROWSER_ALLOW_FILE_ACCESS ?? null, args: process.argv.slice(2), config, configContent: config ? require("node:fs").readFileSync(config, "utf8") : null, envArgs: process.env.AGENT_BROWSER_ARGS ?? null } }));\n`, "utf8");
	await chmod(binaryPath, 0o755);
	try {
		await withPatchedEnv({ AGENT_BROWSER_ARGS: "--disable-gpu", PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const result = await runAgentBrowserProcess({ args: ["open", "about:blank"], cwd: tempDir });
			const parsed = await parseAgentBrowserEnvelope(result.stdout);
			const data = parsed.envelope?.data as { allowFileAccessEnv?: string | null; args?: string[]; config?: string; configContent?: string | null; envArgs?: string | null };
			assert.deepEqual(data.args?.slice(0, 2), ["--allow-file-access", "false"]);
			assert.equal(data.configContent, "{}\n");
			assert.match(data.config ?? "", /managed-restore-config/);
			assert.equal(data.envArgs, null);
		});
		await withPatchedEnv({ PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const result = await runAgentBrowserProcess({ args: ["--session", "caller-owned", "open", "file:///tmp/page.html"], cwd: tempDir });
			assert.equal(result.agentBrowserStarted, false);
			assert.match(result.spawnError?.message ?? "", /wrapper-managed local browser/);
		});
		await withPatchedEnv({ AGENT_BROWSER_ALLOW_FILE_ACCESS: "true", PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const result = await runAgentBrowserProcess({ args: ["--allow-file-access", "false", "get", "url"], cwd: tempDir, preserveAttachedBrowserSession: true });
			const parsed = await parseAgentBrowserEnvelope(result.stdout);
			const data = parsed.envelope?.data as { allowFileAccessEnv?: string | null; args?: string[] };
			assert.equal(data.allowFileAccessEnv, null);
			assert.deepEqual(data.args, ["get", "url"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});


test("buildAgentBrowserSpawnCommand prefers the native Windows binary and passes argv verbatim", () => {
	const nativeArgs = ["--json", "--namespace", "", "--session", "managed", "session", "info"];
	assert.deepEqual(
		buildAgentBrowserSpawnCommand(nativeArgs, "win32", { resolveWindowsNativeBinary: () => "C:\\fake-dir\\agent-browser-win32-x64.exe" }),
		{ command: "C:\\fake-dir\\agent-browser-win32-x64.exe", args: nativeArgs },
	);
	assert.deepEqual(buildAgentBrowserSpawnCommand(["--version"], "darwin"), { command: "agent-browser", args: ["--version"] });
});

test("buildAgentBrowserSpawnCommand keeps the empty namespace through the native Windows binary", () => {
	// Regression: PowerShell -> .cmd re-quoting drops the empty `--namespace ""`
	// operand and shifts `--session`'s value into the command position, so every
	// wrapper-owned probe and navigation on Windows failed. A direct native spawn
	// must preserve every operand, including empty strings, in argv position.
	const nativeArgs = ["--json", "--namespace", "", "--session", "managed", "session", "info"];
	assert.deepEqual(
		buildAgentBrowserSpawnCommand(nativeArgs, "win32", { resolveWindowsNativeBinary: () => "C:\\fake-dir\\agent-browser-win32-x64.exe" }).args,
		nativeArgs,
	);
});

test("buildAgentBrowserSpawnCommand falls back to the npm cmd shim via PowerShell when the native binary is unresolvable", () => {
	assert.deepEqual(
		buildAgentBrowserSpawnCommand(["--json", "--session", "managed", "open", "https://example.com"], "win32", { resolveWindowsNativeBinary: () => undefined }),
		{
			command: "powershell.exe",
			args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$agentBrowser = Get-Command agent-browser.cmd -ErrorAction SilentlyContinue; if (-not $agentBrowser) { [Console]::Error.WriteLine('PI_AGENT_BROWSER_COMMAND_NOT_FOUND:agent-browser.cmd'); exit 127 }; & $agentBrowser.Source 'open' '--json' '--session' 'managed' 'https://example.com'"],
		},
	);
});

test("extractWindowsCmdShimExe resolves the quoted native binary target from an npm cmd shim", { skip: process.platform !== "win32" }, () => {
	const shimDir = "C:\\Users\\test\\npm";
	assert.equal(
		extractWindowsCmdShimExe('@ECHO off\n"%~dp0node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe" %*', shimDir, "agent-browser-win32-x64.exe"),
		"C:\\Users\\test\\npm\\node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe",
	);
	assert.equal(extractWindowsCmdShimExe('@ECHO off\n"%~dp0node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe" %*', shimDir, "agent-browser-win32-arm64.exe"), undefined);
	assert.equal(extractWindowsCmdShimExe("echo not a shim", shimDir, "agent-browser-win32-x64.exe"), undefined);
});

test("process start identity commands use absolute POSIX fallbacks and native PowerShell on Windows", async () => {
	const posixCommands = buildProcessStartIdentityCommands(123, "linux");
	assert.deepEqual(posixCommands.map((command) => command.file), ["/bin/ps", "/usr/bin/ps"]);
	const attempts: string[] = [];
	assert.equal(await resolveProcessStartIdentityFromCommands(posixCommands, async (command) => {
		attempts.push(command.file);
		return command.file === "/usr/bin/ps" ? "fallback-identity" : undefined;
	}), "fallback-identity");
	assert.deepEqual(attempts, ["/bin/ps", "/usr/bin/ps"]);
	const windows = buildProcessStartIdentityCommand(123, "win32");
	assert.match(windows?.file ?? "", /(?:^|[\\/])powershell\.exe$/i);
	assert.equal(win32.isAbsolute(windows?.file ?? ""), true);
	assert.ok(windows?.args.includes("-NonInteractive"));
	assert.match(windows?.args.at(-1) ?? "", /Get-Process -Id 123/);
	assert.match(windows?.args.at(-1) ?? "", /win32-powershell-ticks-v1:/);
	assert.equal(buildProcessStartIdentityCommand(0, "win32"), undefined);
	assert.equal(normalizeProcessStartIdentity("  638000000000000000\r\n"), "638000000000000000");
	assert.equal(processStartIdentitiesMatch("Sun Aug 3 00:00:00 2026", "win32-powershell-ticks-v1:638000000000000000", "win32"), undefined);
	assert.equal(processStartIdentitiesMatch("win32-powershell-ticks-v1:1", "win32-powershell-ticks-v1:2", "win32"), false);
});

test("Windows managed restore commit excludes PowerShell command-not-found wrappers", () => {
	const missing = "& : The term 'agent-browser.cmd' is not recognized as the name of a cmdlet. CategoryInfo: ObjectNotFound CommandNotFoundException";
	assert.equal(isWindowsAgentBrowserCommandMissing(missing), true);
	assert.equal(isWindowsAgentBrowserCommandMissing("PI_AGENT_BROWSER_COMMAND_NOT_FOUND:agent-browser.cmd"), true);
	assert.equal(shouldCommitManagedRestoreAfterWindowsProcess({ exitCode: 1, stderr: missing }), false);
	assert.equal(shouldCommitManagedRestoreAfterWindowsProcess({ exitCode: 1, stderr: "selector not found" }), true);
	assert.equal(shouldCommitManagedRestoreAfterWindowsProcess({ exitCode: 0, stderr: "" }), true);
	assert.equal(shouldCommitManagedRestoreAfterWindowsProcess({ exitCode: 127, spawnError: new Error("spawn powershell ENOENT"), stderr: "" }), false);
});

test("writeFakeAgentBrowserBinary installs Windows cmd launcher when platform is win32", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-win32-launcher-"));

	try {
		const launcherPath = await writeFakeAgentBrowserBinary(
			tempDir,
			`process.stdout.write(JSON.stringify({ ok: true }));`,
			"win32",
		);
		const [cmdText, scriptText] = await Promise.all([
			readFile(join(tempDir, "agent-browser.cmd"), "utf8"),
			readFile(join(tempDir, "agent-browser-fake.cjs"), "utf8"),
		]);

		assert.equal(launcherPath, join(tempDir, "agent-browser.cmd"));
		assert.match(cmdText, /@ECHO OFF/i);
		assert.match(cmdText, /agent-browser-fake\.cjs/);
		assert.match(cmdText, /%*\r?\n/);
		assert.match(scriptText, /ok: true/);
		await assert.rejects(stat(join(tempDir, "agent-browser")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("process helpers clamp the upstream default operation timeout to the documented baseline", () => {
	assert.equal(getAgentBrowserProcessTimeoutMs({ PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "1234" }), 1234);
	assert.equal(getAgentBrowserProcessTimeoutMs({ PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "invalid" }), 35_000);

	assert.equal(buildAgentBrowserProcessEnv({ AGENT_BROWSER_DEFAULT_TIMEOUT: "45000" }).AGENT_BROWSER_DEFAULT_TIMEOUT, "25000");
	assert.equal(buildAgentBrowserProcessEnv({ AGENT_BROWSER_DEFAULT_TIMEOUT: "12000" }).AGENT_BROWSER_DEFAULT_TIMEOUT, "12000");
	assert.equal(buildAgentBrowserProcessEnv({}).AGENT_BROWSER_DEFAULT_TIMEOUT, "25000");
	const env = buildAgentBrowserProcessEnv({ OPENAI_API_KEY: "openai-secret", UNRELATED_API_KEY: "unrelated-secret" });
	assert.equal(env.OPENAI_API_KEY, "openai-secret");
	assert.equal(env.UNRELATED_API_KEY, "unrelated-secret");
});

test("root-owned sticky socket ancestors remain trusted for uid 0", () => {
	const directory = (uid: number, mode: number) => ({ uid, mode, isDirectory: () => true, isSymbolicLink: () => false });
	assert.equal(isTrustedSocketDirAncestor(directory(0, 0o41777), 0), true);
	assert.equal(isTrustedSocketDirAncestor(directory(0, 0o40777), 0), false);
	assert.equal(isTrustedSocketDirAncestor(directory(501, 0o40700), 0), false);
	assert.equal(isTrustedSocketDirAncestor(directory(501, 0o40700), 501), true);
});

test("agent-browser socket path preflight reports long configured roots before upstream spawn", () => {
	const socketDir = `/tmp/${"deep/".repeat(20)}sockets`;
	const error = getAgentBrowserSocketPathValidationError({
		args: ["--namespace", "team", "--session", "managed", "open", "https://example.com"],
		socketDir,
	});
	assert.match(error ?? "", /Unix socket path would be \d+ bytes \(max 103\)/);
	assert.match(error ?? "", /PI_AGENT_BROWSER_SOCKET_DIR/);
	assert.match(error ?? "", /retrying sessionMode "fresh" cannot shorten/);
	assert.equal(getAgentBrowserSocketPathValidationError({ args: ["--session", "s", "open", "https://example.com"], socketDir: "/tmp/piab" }), undefined);
	assert.equal(getAgentBrowserSocketPathValidationError({ args: ["--session", "s", "open", "https://example.com"], platform: "win32", socketDir }), undefined);
});

test("agent-browser socket storage rejects unsafe permissions, ancestry, symlinks, and ownership", async (context) => {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid === undefined) return context.skip("POSIX ownership metadata is unavailable");
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-socket-security-"));
	try {
		const insecureDir = join(tempDir, "insecure");
		await mkdir(insecureDir, { mode: 0o700 });
		await chmod(insecureDir, 0o777);
		assert.equal(await ensureAgentBrowserSocketDir(insecureDir, uid), false);
		assert.equal((await stat(insecureDir)).mode & 0o777, 0o777);

		const secureDir = join(tempDir, "secure");
		assert.equal(await ensureAgentBrowserSocketDir(secureDir, uid), true);
		assert.equal((await stat(secureDir)).mode & 0o777, 0o700);
		await symlink(insecureDir, join(secureDir, "planted"), "dir");
		assert.equal(await ensureAgentBrowserSocketDir(secureDir, uid), false);

		const symlinkPath = join(tempDir, "link");
		await symlink(insecureDir, symlinkPath, "dir");
		assert.equal(await ensureAgentBrowserSocketDir(symlinkPath, uid), false);
		assert.equal(await ensureAgentBrowserSocketDir(join(symlinkPath, "socket"), uid), false);

		const unsafeParent = join(tempDir, "unsafe-parent");
		await mkdir(unsafeParent, { mode: 0o700 });
		await chmod(unsafeParent, 0o777);
		assert.equal(await ensureAgentBrowserSocketDir(join(unsafeParent, "socket"), uid), false);

		const foreignDir = join(tempDir, "foreign");
		await mkdir(foreignDir, { mode: 0o700 });
		assert.equal(await ensureAgentBrowserSocketDir(foreignDir, uid + 1), false);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess uses the Pi-scoped socket directory without trusting ambient upstream configuration", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-socket-config-"));
	const socketPath = join(tempDir, "socket");
	try {
		await writeFakeAgentBrowserBinary(
			tempDir,
			`process.stdout.write(JSON.stringify({ success: true, data: { socketDir: process.env.AGENT_BROWSER_SOCKET_DIR ?? null } }));`,
		);
		await withPatchedEnv(
			{
				AGENT_BROWSER_SOCKET_DIR: join(tempDir, "ignored-upstream-value"),
				PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
				PI_AGENT_BROWSER_SOCKET_DIR: socketPath,
				PI_AGENT_BROWSER_TEST_CUSTOM_VERSION: "1",
			},
			async () => {
				const result = await runAgentBrowserProcess({ args: ["--version"], cwd: tempDir });
				assert.equal(result.agentBrowserStarted, true);
				assert.equal(result.spawnError, undefined);
				const parsed = await parseAgentBrowserEnvelope(result.stdout);
				assert.equal((parsed.envelope?.data as { socketDir?: string }).socketDir, socketPath);
				assert.equal((await stat(socketPath)).mode & 0o777, 0o700);
			},
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess fails before spawn for unsafe socket storage", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-socket-preflight-"));
	const markerPath = join(tempDir, "spawned.txt");
	const targetPath = join(tempDir, "target");
	const socketPath = join(tempDir, "socket-link");
	try {
		await mkdir(targetPath, { mode: 0o700 });
		await symlink(targetPath, socketPath, "dir");
		await writeFakeAgentBrowserBinary(tempDir, `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "spawned");`);
		await withPatchedEnv({ PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}` }, async () => {
			const result = await runAgentBrowserProcess({ args: ["--version"], cwd: tempDir, env: { AGENT_BROWSER_SOCKET_DIR: socketPath } });
			assert.equal(result.agentBrowserStarted, false);
			assert.match(result.spawnError?.message ?? "", /socket storage.*symlink/i);
			await assert.rejects(readFile(markerPath, "utf8"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess does not spawn already-aborted calls", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	const startedPath = join(tempDir, "started");
	await writeFakeAgentBrowserBinary(
		tempDir,
		`require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started"); process.stdin.resume(); setTimeout(() => process.stdout.write(JSON.stringify({ success: true, data: "late" })), 5000);`,
	);
	const controller = new AbortController();
	controller.abort();

	try {
		const processResult = await runAgentBrowserProcess({
			args: ["--session", "caller-owned", "open", "file:///tmp/page.html"],
			cwd: tempDir,
			env: { PATH: `${tempDir}${delimiter}${basePath}` },
			signal: controller.signal,
		});

		assert.equal(processResult.aborted, true);
		assert.equal(processResult.agentBrowserStarted, false);
		assert.equal(processResult.spawnError, undefined);
		await assert.rejects(stat(startedPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess stops a hung upstream client at the wrapper watchdog", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-timeout-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdin.resume(); setTimeout(() => process.stdout.write(JSON.stringify({ success: true, data: "late" })), 5000);`,
	);

	try {
		const startedAt = Date.now();
		const processResult = await runAgentBrowserProcess({
			args: ["wait", "5000"],
			cwd: tempDir,
			env: { PATH: `${tempDir}${delimiter}${basePath}` },
			timeoutMs: 100,
		});

		assert.equal(processResult.timedOut, true);
		assert.equal(processResult.timeoutMs, 100);
		assert.equal(processResult.aborted, false);
		assert.equal(processResult.exitCode, 124);
		assert.ok(Date.now() - startedAt < 2_000);
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess handles closed stdin pipe without an unhandled EPIPE", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `process.stdin.destroy(); setImmediate(() => process.exit(0));`);

	try {
		const processResult = await runAgentBrowserProcess({
			args: ["batch"],
			cwd: tempDir,
			env: { PATH: `${tempDir}${delimiter}${basePath}` },
			stdin: JSON.stringify([["fill", "#field", "x".repeat(4 * 1024 * 1024)]]),
		});

		assert.equal(processResult.aborted, false);
		assert.equal(processResult.spawnError, undefined);
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess handles abort during stdin-bearing command", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdin.resume(); setTimeout(() => process.stdout.write(JSON.stringify({ success: true })), 5000);`,
	);
	const controller = new AbortController();

	try {
		const resultPromise = runAgentBrowserProcess({
			args: ["eval", "--stdin"],
			cwd: tempDir,
			env: { PATH: `${tempDir}${delimiter}${basePath}` },
			signal: controller.signal,
			stdin: "document.title",
		});
		setImmediate(() => controller.abort());

		const processResult = await resultPromise;
		assert.equal(processResult.aborted, true);
		assert.equal(processResult.spawnError, undefined);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess resolves after exit when descendants keep stdio handles open", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stdio-"));
	const basePath = process.env.PATH ?? "";
	const lingerPidPath = join(tempDir, "linger.pid");
	await writeFakeAgentBrowserBinary(
		tempDir,
		buildStdioLingerFakeScript({
			afterSpawnBody:
				'process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }), () => process.exit(0));',
		}),
	);
	let lingerPid: number | undefined;

	try {
		const timeoutMs = 10_000;
		const startedAt = Date.now();
		const processResult = await runAgentBrowserProcess({
			args: ["open", "https://example.com"],
			cwd: tempDir,
			env: {
				PATH: `${tempDir}${delimiter}${basePath}`,
				PI_AGENT_BROWSER_TEST_LINGER_PID_PATH: lingerPidPath,
			},
			timeoutMs,
		});

		lingerPid = Number((await readFile(lingerPidPath, "utf8")).trim());
		const elapsedMs = Date.now() - startedAt;
		assert.ok(elapsedMs < timeoutMs / 2, `inherited-stdio fallback should resolve well before the process timeout; elapsed ${elapsedMs} ms of ${timeoutMs} ms`);
		assert.equal(processResult.exitCode, 0);
		assert.equal(processResult.timedOut, false);
		assert.equal(processResult.spawnError, undefined);
		assert.match(processResult.stdout, /"ok":true/);
		assert.doesNotThrow(() => process.kill(lingerPid as number, 0), "expected the inherited-stdio descendant to still be alive after process resolution");
	} finally {
		if (Number.isInteger(lingerPid)) {
			try {
				process.kill(lingerPid as number, "SIGTERM");
			} catch {
				// The linger process may have already exited.
			}
		}
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess returns timeout exit code when descendants keep stdio handles open", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stdio-timeout-"));
	const basePath = process.env.PATH ?? "";
	const lingerPidPath = join(tempDir, "linger.pid");
	await writeFakeAgentBrowserBinary(
		tempDir,
		buildStdioLingerFakeScript({
			afterSpawnBody: 'process.stdin.resume();\nsetTimeout(() => process.exit(0), 10000);',
		}),
	);
	let lingerPid: number | undefined;

	try {
		const startedAt = Date.now();
		const timeoutMs = 5_000;
		const processResult = await runAgentBrowserProcess({
			args: ["wait", "5000"],
			cwd: tempDir,
			env: {
				PATH: `${tempDir}${delimiter}${basePath}`,
				PI_AGENT_BROWSER_TEST_LINGER_PID_PATH: lingerPidPath,
			},
			timeoutMs,
		});
		const elapsedMs = Date.now() - startedAt;

		lingerPid = Number((await readFile(lingerPidPath, "utf8")).trim());
		assert.equal(processResult.timedOut, true);
		assert.equal(processResult.timeoutMs, timeoutMs);
		assert.equal(processResult.exitCode, 124);
		assert.equal(processResult.spawnError, undefined);
		assert.ok(
			elapsedMs < timeoutMs + 2_000,
			`expected inherited stdio handles not to delay timeout resolution, got ${elapsedMs}ms`,
		);
	} finally {
		if (Number.isInteger(lingerPid)) {
			try {
				process.kill(lingerPid as number, "SIGTERM");
			} catch {
				// The linger process may have already exited.
			}
		}
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess removes abort listeners after repeated successful runs with one shared signal", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);
	const controller = new AbortController();

	try {
		for (let index = 0; index < 5; index += 1) {
			const processResult = await runAgentBrowserProcess({
				args: ["snapshot"],
				cwd: tempDir,
				env: { PATH: `${tempDir}${delimiter}${basePath}` },
				signal: controller.signal,
			});

			assert.equal(processResult.exitCode, 0);
			assert.equal(processResult.agentBrowserStarted, true);
			assert.equal(processResult.spawnError, undefined);
			assert.equal(processResult.aborted, false);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		}
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess removes abort listeners after spawn errors", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const controller = new AbortController();

	try {
		const processResult = await runAgentBrowserProcess({
			args: ["snapshot"],
			cwd: tempDir,
			env: { PATH: tempDir },
			signal: controller.signal,
		});

		if (process.platform === "win32") {
			assert.equal(processResult.exitCode, 1);
			assert.match(processResult.stderr, /agent-browser|not recognized/);
		} else {
			assert.equal(processResult.exitCode, 127);
			assert.match(processResult.spawnError?.message ?? "", /ENOENT|agent-browser/);
		}
		assert.equal(processResult.aborted, false);
		assert.equal(processResult.agentBrowserStarted, false);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess spills oversized stdout while parseAgentBrowserEnvelope still sees the full payload", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const fakeAgentBrowserPath = join(tempDir, "agent-browser");
	const bigSnapshotRows = Array.from({ length: 7_000 }, (_, index) => {
		const ref = `e${index + 1}`;
		return `- generic \"Large process snapshot row ${index + 1} that forces stdout spilling without losing parseability\" [ref=${ref}] clickable [onclick]`;
	}).join("\\n");
	const refsLiteral = Array.from({ length: 80 }, (_, index) => `e${index + 1}: { name: "Action ${index + 1}", role: "button" }`).join(",");
	await writeFile(
		fakeAgentBrowserPath,
		`#!/usr/bin/env node
const envelope = {
  success: true,
  data: {
    origin: "https://example.com/process-large",
    refs: {${refsLiteral}},
    snapshot: ${JSON.stringify(bigSnapshotRows)}
  }
};
process.stdout.write(JSON.stringify(envelope));
`,
		"utf8",
	);
	if (process.platform === "win32") {
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const envelope = {
  success: true,
  data: {
    origin: "https://example.com/process-large",
    refs: {${refsLiteral}},
    snapshot: ${JSON.stringify(bigSnapshotRows)}
  }
};
process.stdout.write(JSON.stringify(envelope));`,
		);
	} else {
		await chmod(fakeAgentBrowserPath, 0o755);
	}

	try {
		const processResult = await runAgentBrowserProcess({
			args: ["snapshot", "-i"],
			cwd: tempDir,
			env: { PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}` },
		});

		assert.equal(processResult.exitCode, 0);
		assert.equal(typeof processResult.stdoutSpillPath, "string");
		assert.ok(processResult.stdout.length < bigSnapshotRows.length);

		const parsed = await parseAgentBrowserEnvelope({
			stdout: processResult.stdout,
			stdoutPath: processResult.stdoutSpillPath,
		});
		assert.equal(parsed.parseError, undefined);
		assert.equal(parsed.envelope?.success, true);
		const snapshotData = parsed.envelope?.data as { snapshot?: string } | undefined;
		assert.match(snapshotData?.snapshot ?? "", /Large process snapshot row 7000/);

		if (processResult.stdoutSpillPath) {
			await rm(processResult.stdoutSpillPath, { force: true, maxRetries: 5, retryDelay: 100 });
		}
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess stops spilling once the secure temp budget is exceeded", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	const oversizedPayload = JSON.stringify({ success: true, data: { snapshot: "x".repeat(700_000) } });
	await writeFakeAgentBrowserBinary(tempDir, `process.stdout.write(${JSON.stringify(oversizedPayload)});`);

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "100000" }, async () => {
			const processResult = await runAgentBrowserProcess({
				args: ["snapshot"],
				cwd: tempDir,
				env: { PATH: `${tempDir}${delimiter}${basePath}` },
			});

			assert.match(processResult.spawnError?.message ?? "", /temp spill budget exceeded/i);
			if (processResult.stdoutSpillPath) {
				const spillStats = await stat(processResult.stdoutSpillPath);
				assert.ok(spillStats.size <= 100000);
				await rm(processResult.stdoutSpillPath, { force: true, maxRetries: 5, retryDelay: 100 });
			}
		});
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
		await cleanupSecureTempArtifacts();
	}
});

test("agentBrowserExtension removes oversized close stdout spill after fresh-session rotation", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	const closeDebugPath = join(tempDir, "close-debug.json");
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const isClose = args.includes("close");
const sessionIndex = args.indexOf("--session");
const restoreKeyPath = path.join(${JSON.stringify(tempDir)}, "daemon-restore-key-" + encodeURIComponent(args[sessionIndex + 1] || "default"));
if (args.includes("session") && args.includes("info")) {
	process.stdout.write(JSON.stringify({ success: true, data: { active: false, runtime: null } }));
} else if (isClose) {
	const sessions = path.join(process.env.HOME, ".agent-browser", "sessions");
	const restoreKey = fs.readFileSync(restoreKeyPath, "utf8");
	const statePath = path.join(sessions, restoreKey + "-auto.json");
	fs.mkdirSync(sessions, { recursive: true });
	fs.writeFileSync(statePath, "{}");
	const config = process.env.AGENT_BROWSER_CONFIG;
	fs.writeFileSync(${JSON.stringify(closeDebugPath)}, JSON.stringify({ configContent: config ? fs.readFileSync(config, "utf8") : null, envRestore: process.env.AGENT_BROWSER_RESTORE ?? null, restoreKey, statePath }));
	if (process.env.AGENT_BROWSER_JSON === "1") process.stdout.write(JSON.stringify({ success: true, data: { closed: true, payload: "x".repeat(700000), statePath } }));
	else process.stdout.write("Browser closed");
} else {
	if (args.includes("open")) fs.writeFileSync(restoreKeyPath, process.env.AGENT_BROWSER_RESTORE || "disabled");
	process.stdout.write(JSON.stringify({ success: true, data: { title: "OK", url: "https://example.com/" } }));
}`,
	);

	execFileSync("git", ["init", "-q", tempDir], { stdio: "ignore" });
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com/one"],
			});
			assert.equal(firstOpen.isError, false, JSON.stringify(firstOpen));

			const freshOpen = await withPatchedEnv({ AGENT_BROWSER_RESTORE: "replacement-key" }, async () => await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/two"],
				sessionMode: "fresh",
			}));
			assert.equal(freshOpen.isError, false, JSON.stringify(freshOpen));

			const { currentTempRoot } = await getSecureTempDebugState();
			assert.equal(typeof currentTempRoot, "string");
			const entries = await readdir(currentTempRoot as string);
			assert.deepEqual(entries.filter((entry) => entry.startsWith("process-stdout-")), []);
			const closeDebug = JSON.parse(await readFile(closeDebugPath, "utf8")) as { configContent: string | null; envRestore: string | null; restoreKey: string; statePath: string };
			assert.equal(closeDebug.configContent, "{}\n");
			assert.equal(closeDebug.envRestore, null);
			const firstSessionName = firstOpen.details?.sessionName as string;
			assert.equal(closeDebug.restoreKey, createManagedSessionRestoreKey(tempDir, getManagedSessionRestoreScope(firstSessionName)));
			const sessions = join(tempDir, ".agent-browser", "sessions");
			const ownershipManifest = (await readdir(sessions)).find((entry) => entry.startsWith(".pi-agent-browser-owned-snapshots-v2-"));
			assert.ok(ownershipManifest);
			const ownershipDirectory = join(sessions, ownershipManifest);
			const ownershipRecord = (await readdir(ownershipDirectory)).find((entry) => entry.endsWith(".json"));
			assert.ok(ownershipRecord, JSON.stringify({ close: closeDebug, ownershipEntries: await readdir(ownershipDirectory) }));
			assert.match(await readFile(join(ownershipDirectory, ownershipRecord), "utf8"), /-auto\.json/);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("agentBrowserExtension removes oversized navigation-summary stdout spills after failed helper commands", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
const isNavigationSummaryHelper = args.includes("eval") || (args.includes("get") && (args.includes("title") || args.includes("url")));
if (isNavigationSummaryHelper) {
	process.stdout.write(JSON.stringify({ success: false, data: { payload: "x".repeat(700000) } }), () => process.exit(1));
} else if (args.includes("open")) {
	process.stdout.write(JSON.stringify({ success: true, data: { title: "OK", url: "https://example.com/" } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com/"],
			});
			assert.equal(firstOpen.isError, false, JSON.stringify(firstOpen));

			const click = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["click", "@e1"],
			});
			assert.equal(click.isError, false, JSON.stringify(click));

			const { currentTempRoot } = await getSecureTempDebugState();
			assert.equal(typeof currentTempRoot, "string");
			const entries = await readdir(currentTempRoot as string);
			assert.deepEqual(entries.filter((entry) => entry.startsWith("process-stdout-")), []);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess pins owned namespace and config after planning", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-namespace-env-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs"); const config = process.env.AGENT_BROWSER_CONFIG; process.stdout.write(JSON.stringify({ success: true, data: { args: process.argv.slice(2), config, configContent: config ? fs.readFileSync(config, "utf8") : null, encryptionKey: process.env.AGENT_BROWSER_ENCRYPTION_KEY ?? null, home: process.env.HOME ?? null, namespace: process.env.AGENT_BROWSER_NAMESPACE ?? null, restore: process.env.AGENT_BROWSER_RESTORE ?? null } }));`);
	execFileSync("git", ["init", "-q", tempDir], { stdio: "ignore" });
	try {
		await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "redirected", HOME: tempDir, PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const restoreState = new ManagedSessionRestoreState();
			const args = ["--session", "piab-managed", "snapshot", "-i"];
			const context = buildOwnedManagedSessionRestoreContext({
				args,
				cwd: tempDir,
				managedSessionName: "piab-managed",
				parentEnv: { AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64), HOME: tempDir, PATH: `${tempDir}${delimiter}${basePath}` },
				restoreState,
				sessionName: "piab-managed",
			});
			assert.equal(context?.restoreDecision, "enabled");
			const processResult = await withOwnedManagedSessionContext(context, () => runAgentBrowserProcess({
				args,
				cwd: tempDir,
				env: { AGENT_BROWSER_ENCRYPTION_KEY: "b".repeat(64), HOME: join(tempDir, "later-home-override") },
				managedSessionRestoreState: restoreState,
				ownedManagedSession: true,
			}));
			const parsed = await parseAgentBrowserEnvelope(processResult.stdout);
			const data = parsed.envelope?.data as { config?: string; configContent?: string; encryptionKey?: string; home?: string; namespace?: string; restore?: string };
			assert.equal(data.encryptionKey, "a".repeat(64));
			assert.equal(data.home, await realpath(tempDir));
			assert.equal(data.namespace, "");
			assert.equal(data.restore, createManagedSessionRestoreKey(tempDir, "piab-managed"));
			assert.equal(data.configContent, "{}\n");
			assert.ok(data.config);
			if (process.platform !== "win32") assert.equal((await stat(data.config)).mode & 0o777, 0o400);
			await stat(join(dirname(data.config), ".pi-agent-browser-owner.json"));
			assert.notEqual(data.config, join(tempDir, "agent-browser.json"));

			const closeResult = await withOwnedManagedSessionContext(context, () => runAgentBrowserProcess({
				args: ["--session", "piab-managed", "--config", join(tempDir, "agent-browser.json"), "--restore", "attacker-key", "close"],
				cwd: tempDir,
				env: { AGENT_BROWSER_CONFIG: join(tempDir, "agent-browser.json"), AGENT_BROWSER_RESTORE: "attacker-key" },
				managedSessionRestoreState: restoreState,
				ownedManagedSession: true,
			}));
			const closeParsed = await parseAgentBrowserEnvelope(closeResult.stdout);
			const closeData = closeParsed.envelope?.data as { args?: string[]; configContent?: string; restore?: string | null };
			assert.deepEqual(closeData.args, ["--json", "--namespace", "", "--session", "piab-managed", "close"]);
			assert.equal(closeData.configContent, "{}\n");
			assert.equal(closeData.restore, null);
			await cleanupSecureTempArtifacts();
			await assert.rejects(stat(data.config), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess refuses a changed checkout identity before spawning", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-identity-race-"));
	const basePath = process.env.PATH ?? "";
	const startedPath = join(tempDir, "started");
	await writeFakeAgentBrowserBinary(tempDir, `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");`);
	execFileSync("git", ["init", "-q", tempDir], { stdio: "ignore" });
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const restoreState = new ManagedSessionRestoreState();
			const args = ["--session", "piab-managed", "open", "https://example.com"];
			const context = buildOwnedManagedSessionRestoreContext({
				args,
				cwd: tempDir,
				managedSessionName: "piab-managed",
				restoreState,
				sessionName: "piab-managed",
			});
			assert.equal(context?.restoreDecision, "enabled");
			await chmod(join(tempDir, ".git", "pi-agent-browser-project-generation-v1.json"), 0o644);
			const result = await withOwnedManagedSessionContext(context, () => runAgentBrowserProcess({
				args,
				cwd: tempDir,
				managedSessionRestoreState: restoreState,
				ownedManagedSession: true,
			}));
			assert.equal(result.agentBrowserStarted, false);
			assert.match(result.spawnError?.message ?? "", /checkout identity changed/);
			await assert.rejects(stat(startedPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess refuses incompatible environment changes after planning", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-env-race-"));
	const basePath = process.env.PATH ?? "";
	const startedPath = join(tempDir, "started");
	await writeFakeAgentBrowserBinary(tempDir, `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");`);
	execFileSync("git", ["init", "-q", tempDir], { stdio: "ignore" });
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const restoreState = new ManagedSessionRestoreState();
			const args = ["--session", "piab-managed", "open", "https://example.com"];
			const context = buildOwnedManagedSessionRestoreContext({ args, cwd: tempDir, managedSessionName: "piab-managed", restoreState, sessionName: "piab-managed" });
			assert.equal(context?.restoreDecision, "enabled");
			const result = await withOwnedManagedSessionContext(context, () => runAgentBrowserProcess({
				args,
				cwd: tempDir,
				env: { HTTPS_PROXY: "http://127.0.0.1:9999" },
				managedSessionRestoreState: restoreState,
				ownedManagedSession: true,
			}));
			assert.equal(result.agentBrowserStarted, false);
			assert.match(result.spawnError?.message ?? "", /policy, storage, or checkout identity changed/);
			await assert.rejects(stat(startedPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess blocks foreign managed-state capabilities at the spawn boundary", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-state-boundary-"));
	const basePath = process.env.PATH ?? "";
	const startedPath = join(tempDir, "started");
	await writeFakeAgentBrowserBinary(tempDir, `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");`);
	execFileSync("git", ["init", "-q", tempDir], { stdio: "ignore" });
	try {
		await withPatchedEnv({ PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const currentKey = createManagedSessionRestoreKey(tempDir);
			const foreignKey = currentKey === `piab-r2-${"a".repeat(32)}` ? `piab-r2-${"b".repeat(32)}` : `piab-r2-${"a".repeat(32)}`;
			const result = await runAgentBrowserProcess({
				args: ["state", "show", `${foreignKey}-foreign.json`],
				cwd: tempDir,
			});
			assert.equal(result.agentBrowserStarted, false);
			assert.match(result.spawnError?.message ?? "", /outside the current checkout/);
			const foreignSession = await runAgentBrowserProcess({
				args: ["--session", "piab-foreign", "snapshot", "-i"],
				cwd: tempDir,
			});
			assert.equal(foreignSession.agentBrowserStarted, false);
			assert.match(foreignSession.spawnError?.message ?? "", /reserved for a browser managed by this extension instance/);
			const foreignEnvironmentSession = await runAgentBrowserProcess({
				args: ["session", "info"],
				cwd: tempDir,
				env: { AGENT_BROWSER_SESSION: "piab-foreign" },
			});
			assert.equal(foreignEnvironmentSession.agentBrowserStarted, false);
			assert.match(foreignEnvironmentSession.spawnError?.message ?? "", /reserved for a browser managed by this extension instance/);
			for (const options of [
				{ args: ["--allow-file-access", "true", "open", "https://example.com"] },
				{ args: ["--download-path", "-x/../.agent-browser/downloads", "open", "https://example.com"] },
				{ args: ["screenshot", join(tempDir, ".agent-browser", "capture.png")] },
				{ args: ["open", "https://example.com"], env: { AGENT_BROWSER_SCREENSHOT_DIR: join(tempDir, ".agent-browser", "screenshots") } },
				{ args: ["open", "https://example.com"], env: { AGENT_BROWSER_STATE: join(tempDir, ".agent-browser", "sessions", "auth.json") } },
				{ args: ["snapshot", "-i"], managedStatePageUrlUnknown: true },
			]) {
				const blocked = await runAgentBrowserProcess({ ...options, cwd: tempDir });
				assert.equal(blocked.agentBrowserStarted, false);
				assert.match(blocked.spawnError?.message ?? "", /authenticated|active page became unverified/);
			}
			await assert.rejects(stat(startedPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess reports protected restore-config setup failures before spawning", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-config-failure-"));
	const basePath = process.env.PATH ?? "";
	const startedPath = join(tempDir, "started");
	await writeFakeAgentBrowserBinary(tempDir, `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");`);
	execFileSync("git", ["init", "-q", tempDir], { stdio: "ignore" });
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}${delimiter}${basePath}`, PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "1" }, async () => {
			const restoreState = new ManagedSessionRestoreState();
			const args = ["--session", "piab-managed", "open", "https://example.com"];
			const context = buildOwnedManagedSessionRestoreContext({
				args,
				cwd: tempDir,
				managedSessionName: "piab-managed",
				restoreState,
				sessionName: "piab-managed",
			});
			assert.equal(context?.restoreDecision, "enabled");
			const result = await withOwnedManagedSessionContext(context, () => runAgentBrowserProcess({
				args,
				cwd: tempDir,
				managedSessionRestoreState: restoreState,
				ownedManagedSession: true,
			}));
			assert.equal(result.agentBrowserStarted, false);
			assert.match(result.spawnError?.message ?? "", /protected empty config/);
			await assert.rejects(stat(startedPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess suppresses visible restore autosave tabs for headed managed launches", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-headed-autosave-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `process.stdout.write(JSON.stringify({ success: true, data: { autosave: process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS ?? null } }));`);
	execFileSync("git", ["init", "-q", tempDir], { stdio: "ignore" });

	try {
		for (const [sessionName, launchArgs, parentAutosave, env, ownedManagedSession, expected, retainedHeadedDefault] of [
			["piab-headed-default", ["--headed"], undefined, undefined, true, "0", true],
			["piab-headed-followup", [], undefined, undefined, true, "0", true],
			["piab-headed-explicit-unset", ["--headed"], undefined, { AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined }, true, null, false],
			["piab-headed-explicit", ["--headed"], undefined, { AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "1000" }, true, "1000", false],
			["piab-headed-parent-explicit", ["--headed"], "2000", undefined, true, "2000", false],
			["piab-headed-env", [], undefined, { AGENT_BROWSER_HEADED: "true" }, true, "0", true],
			["piab-headless-explicit", ["--headed", "false"], undefined, { AGENT_BROWSER_HEADED: "true" }, true, null, false],
			["caller-headed", ["--headed"], undefined, undefined, false, null, false],
		] as const) {
			await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: parentAutosave, HOME: tempDir, PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
				const args = [...launchArgs, "--session", sessionName, "open", "https://example.com"];
				const restoreState = new ManagedSessionRestoreState();
				const context = buildOwnedManagedSessionRestoreContext({ args, cwd: tempDir, headedManagedAutosaveDisabled: retainedHeadedDefault, headedManagedAutosaveInterval: retainedHeadedDefault ? "0" : undefined, managedSessionName: sessionName, restoreState, sessionName });
				const run = () => runAgentBrowserProcess({ args, cwd: tempDir, env, managedSessionRestoreState: restoreState, ownedManagedSession });
				const result = context && ownedManagedSession ? await withOwnedManagedSessionContext(context, run) : await run();
				const parsed = await parseAgentBrowserEnvelope(result.stdout);
				assert.equal((parsed.envelope?.data as { autosave?: string | null } | undefined)?.autosave, expected);
			});
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("runAgentBrowserProcess forwards the parent environment while preserving wrapper overrides", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const readEnv = (name) => process.env[name] ?? null;
const envelope = {
  success: true,
  data: {
    args: process.argv.slice(2),
    agentBrowserActionPolicy: readEnv("AGENT_BROWSER_ACTION_POLICY"),
    agentBrowserAutosaveInterval: readEnv("AGENT_BROWSER_AUTOSAVE_INTERVAL_MS"),
    agentBrowserConfig: readEnv("AGENT_BROWSER_CONFIG"),
    agentBrowserConfirmActions: readEnv("AGENT_BROWSER_CONFIRM_ACTIONS"),
    agentBrowserDefaultTimeout: readEnv("AGENT_BROWSER_DEFAULT_TIMEOUT"),
    agentBrowserEncryptionKey: readEnv("AGENT_BROWSER_ENCRYPTION_KEY"),
    agentBrowserScreenshotDir: readEnv("AGENT_BROWSER_SCREENSHOT_DIR"),
    agentBrowserSession: readEnv("AGENT_BROWSER_SESSION"),
    agentBrowserIosDevice: readEnv("AGENT_BROWSER_IOS_DEVICE"),
    agentBrowserIosUdid: readEnv("AGENT_BROWSER_IOS_UDID"),
    agentBrowserNoXvfb: readEnv("AGENT_BROWSER_NO_XVFB"),
    agentBrowserSessionName: readEnv("AGENT_BROWSER_SESSION_NAME"),
    agentBrowserWebgpu: readEnv("AGENT_BROWSER_WEBGPU"),
    agentcoreApiKey: readEnv("AGENTCORE_API_KEY"),
    agentcoreRegion: readEnv("AGENTCORE_REGION"),
    aiGatewayApiKey: readEnv("AI_GATEWAY_API_KEY"),
    aiGatewayModel: readEnv("AI_GATEWAY_MODEL"),
    awsAccessKeyId: readEnv("AWS_ACCESS_KEY_ID"),
    awsDefaultRegion: readEnv("AWS_DEFAULT_REGION"),
    awsRegion: readEnv("AWS_REGION"),
    awsSecretAccessKey: readEnv("AWS_SECRET_ACCESS_KEY"),
    awsSessionToken: readEnv("AWS_SESSION_TOKEN"),
    browserbaseApiKey: readEnv("BROWSERBASE_API_KEY"),
    browserbaseProjectId: readEnv("BROWSERBASE_PROJECT_ID"),
    browserlessApiKey: readEnv("BROWSERLESS_API_KEY"),
    browserUseApiKey: readEnv("BROWSER_USE_API_KEY"),
    databaseUrl: readEnv("DATABASE_URL"),
    idleTimeout: readEnv("AGENT_BROWSER_IDLE_TIMEOUT_MS"),
    kernelApiKey: readEnv("KERNEL_API_KEY"),
    lang: readEnv("LANG"),
    openaiApiKey: readEnv("OPENAI_API_KEY"),
    secret: readEnv("PI_AGENT_BROWSER_TEST_SECRET"),
    socketDir: readEnv("AGENT_BROWSER_SOCKET_DIR"),
    unrelatedApiKey: readEnv("UNRELATED_API_KEY"),
    pathStartsWithTemp: ((process.env.PATH ?? process.env.Path ?? "").toLowerCase()).startsWith(${JSON.stringify(tempDir.toLowerCase())})
  }
};
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv(
			{
				AGENT_BROWSER_ACTION_POLICY: "/tmp/action-policy.json",
				AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "1000",
				AGENT_BROWSER_CONFIG: "/tmp/agent-browser.json",
				AGENT_BROWSER_CONFIRM_ACTIONS: "1",
				AGENT_BROWSER_DEFAULT_TIMEOUT: "45000",
				AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
				AGENT_BROWSER_SCREENSHOT_DIR: "/tmp/agent-browser-screenshots",
				AGENT_BROWSER_SESSION: "from-parent-session",
				AGENT_BROWSER_IOS_DEVICE: "iPhone 15 Pro",
				AGENT_BROWSER_IOS_UDID: "ios-udid-123",
				AGENT_BROWSER_NO_XVFB: "1",
				AGENT_BROWSER_SESSION_NAME: "from-parent-session-name",
				AGENT_BROWSER_WEBGPU: "true",
				AGENT_BROWSER_SOCKET_DIR: "/tmp/from-parent-should-not-leak",
				AGENTCORE_API_KEY: "agentcore-key",
				AGENTCORE_REGION: "us-west-2",
				AI_GATEWAY_API_KEY: "ai-gateway-key",
				AI_GATEWAY_MODEL: "anthropic/test-model",
				AWS_ACCESS_KEY_ID: "aws-access-key-id",
				AWS_DEFAULT_REGION: "us-east-1",
				AWS_REGION: "us-west-2",
				AWS_SECRET_ACCESS_KEY: "aws-secret-access-key",
				AWS_SESSION_TOKEN: "aws-session-token",
				BROWSERBASE_API_KEY: "browserbase-key",
				BROWSERBASE_PROJECT_ID: "browserbase-project",
				BROWSERLESS_API_KEY: "browserless-key",
				BROWSER_USE_API_KEY: "browser-use-key",
				DATABASE_URL: "postgres://should-not-leak",
				KERNEL_API_KEY: "kernel-key",
				LANG: "en_US.UTF-8",
				OPENAI_API_KEY: "openai-should-not-leak",
				PI_AGENT_BROWSER_TEST_SECRET: "should-not-leak",
				UNRELATED_API_KEY: "unrelated-should-not-leak",
			},
			async () => {
				const processResult = await runAgentBrowserProcess({
					args: ["doctor"],
					cwd: tempDir,
					env: {
						AGENT_BROWSER_IDLE_TIMEOUT_MS: "1234",
						PATH: `${tempDir}${delimiter}${basePath}`,
					},
				});

				assert.equal(processResult.exitCode, 0);
				const parsed = await parseAgentBrowserEnvelope(processResult.stdout);
				assert.equal(parsed.parseError, undefined);
				const data = parsed.envelope?.data as {
					args: string[];
					agentBrowserActionPolicy: string | null;
					agentBrowserAutosaveInterval: string | null;
					agentBrowserConfig: string | null;
					agentBrowserConfirmActions: string | null;
					agentBrowserDefaultTimeout: string | null;
					agentBrowserEncryptionKey: string | null;
					agentBrowserScreenshotDir: string | null;
					agentBrowserIosDevice: string | null;
					agentBrowserIosUdid: string | null;
					agentBrowserNoXvfb: string | null;
					agentBrowserSession: string | null;
					agentBrowserSessionName: string | null;
					agentBrowserWebgpu: string | null;
					agentcoreApiKey: string | null;
					agentcoreRegion: string | null;
					aiGatewayApiKey: string | null;
					aiGatewayModel: string | null;
					awsAccessKeyId: string | null;
					awsDefaultRegion: string | null;
					awsRegion: string | null;
					awsSecretAccessKey: string | null;
					awsSessionToken: string | null;
					browserbaseApiKey: string | null;
					browserbaseProjectId: string | null;
					browserlessApiKey: string | null;
					browserUseApiKey: string | null;
					databaseUrl: string | null;
					idleTimeout: string | null;
					kernelApiKey: string | null;
					lang: string | null;
					openaiApiKey: string | null;
					pathStartsWithTemp: boolean;
					secret: string | null;
					socketDir: string | null;
					unrelatedApiKey: string | null;
				};
				assert.equal(data.args.includes("--allow-file-access"), false);
				assert.equal(data.agentBrowserActionPolicy, "/tmp/action-policy.json");
				assert.equal(data.agentBrowserAutosaveInterval, "1000");
				assert.equal(data.agentBrowserConfig, "/tmp/agent-browser.json");
				assert.equal(data.agentBrowserConfirmActions, "1");
				assert.equal(data.agentBrowserDefaultTimeout, "25000");
				assert.equal(data.agentBrowserEncryptionKey, "a".repeat(64));
				assert.equal(data.agentBrowserScreenshotDir, "/tmp/agent-browser-screenshots");
				assert.equal(data.agentBrowserIosDevice, "iPhone 15 Pro");
				assert.equal(data.agentBrowserIosUdid, "ios-udid-123");
				assert.equal(data.agentBrowserNoXvfb, "1");
				assert.equal(data.agentBrowserSession, "from-parent-session");
				assert.equal(data.agentBrowserSessionName, "from-parent-session-name");
				assert.equal(data.agentBrowserWebgpu, "true");
				assert.equal(data.agentcoreApiKey, "agentcore-key");
				assert.equal(data.agentcoreRegion, "us-west-2");
				assert.equal(data.aiGatewayApiKey, "ai-gateway-key");
				assert.equal(data.aiGatewayModel, "anthropic/test-model");
				assert.equal(data.awsAccessKeyId, "aws-access-key-id");
				assert.equal(data.awsDefaultRegion, "us-east-1");
				assert.equal(data.awsRegion, "us-west-2");
				assert.equal(data.awsSecretAccessKey, "aws-secret-access-key");
				assert.equal(data.awsSessionToken, "aws-session-token");
				assert.equal(data.browserbaseApiKey, "browserbase-key");
				assert.equal(data.browserbaseProjectId, "browserbase-project");
				assert.equal(data.browserlessApiKey, "browserless-key");
				assert.equal(data.browserUseApiKey, "browser-use-key");
				assert.equal(data.databaseUrl, "postgres://should-not-leak");
				assert.equal(data.idleTimeout, "1234");
				assert.equal(data.kernelApiKey, "kernel-key");
				assert.equal(data.lang, "en_US.UTF-8");
				assert.equal(data.openaiApiKey, "openai-should-not-leak");
				assert.equal(data.secret, "should-not-leak");
				assert.equal(data.socketDir, getAgentBrowserSocketDir());
				if (data.socketDir) {
					assert.equal((await stat(data.socketDir)).isDirectory(), true);
				}
				assert.equal(data.unrelatedApiKey, "unrelated-should-not-leak");
				assert.equal(data.pathStartsWithTemp, true);
			},
		);
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

