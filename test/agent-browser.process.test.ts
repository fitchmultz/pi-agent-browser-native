/**
 * Purpose: Verify the agent-browser subprocess wrapper and curated process environment behavior.
 * Responsibilities: Assert stdout spill handling, temp-budget failure behavior, full-payload parsing, and environment forwarding constraints.
 * Scope: Node test-runner coverage for process wrapper helpers using local child-process fixtures.
 * Usage: Run with `npx tsx --test test/agent-browser.process.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake binaries and explicit child-process cleanup to avoid leaks.
 */

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
	buildAgentBrowserProcessEnv,
	getAgentBrowserProcessTimeoutMs,
	getAgentBrowserSocketDir,
	reorderWindowsLeadingGlobalArgs,
	resolveSpawnedChildExitCode,
	runAgentBrowserProcess,
} from "../extensions/agent-browser/lib/process.js";
import {
	parseAgentBrowserEnvelope
} from "../extensions/agent-browser/lib/results.js";
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
		reorderWindowsLeadingGlobalArgs(["--json", "--headed", "false", "--download-path=/tmp/downloads", "open", "https://example.com"]),
		["open", "--json", "--headed", "false", "--download-path=/tmp/downloads", "https://example.com"],
	);
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

test("process helpers clamp upstream operation timeouts below the CLI IPC read timeout", () => {
	assert.equal(getAgentBrowserProcessTimeoutMs({ PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "1234" }), 1234);
	assert.equal(getAgentBrowserProcessTimeoutMs({ PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "invalid" }), 35_000);

	assert.equal(buildAgentBrowserProcessEnv({ AGENT_BROWSER_DEFAULT_TIMEOUT: "45000" }).AGENT_BROWSER_DEFAULT_TIMEOUT, "25000");
	assert.equal(buildAgentBrowserProcessEnv({ AGENT_BROWSER_DEFAULT_TIMEOUT: "12000" }).AGENT_BROWSER_DEFAULT_TIMEOUT, "12000");
	assert.equal(buildAgentBrowserProcessEnv({}).AGENT_BROWSER_DEFAULT_TIMEOUT, "25000");
});

test("runAgentBrowserProcess skips stdin writes for already-aborted stdin calls", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdin.resume(); setTimeout(() => process.stdout.write(JSON.stringify({ success: true, data: "late" })), 5000);`,
	);
	const controller = new AbortController();
	controller.abort();

	try {
		const processResult = await runAgentBrowserProcess({
			args: ["eval", "--stdin"],
			cwd: tempDir,
			env: { PATH: `${tempDir}${delimiter}${basePath}` },
			signal: controller.signal,
			stdin: "console.log(1)",
		});

		assert.equal(processResult.aborted, true);
		assert.equal(processResult.spawnError, undefined);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

test("runAgentBrowserProcess stops a hung upstream client before the upstream IPC retry path", async () => {
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
			stdin: "x".repeat(4 * 1024 * 1024),
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
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
const isClose = args.includes("close");
if (isClose) {
	process.stdout.write(JSON.stringify({ success: true, data: { closed: true, payload: "x".repeat(700000) } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: { title: "OK", url: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}${delimiter}${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com/one"],
			});
			assert.equal(firstOpen.isError, false, JSON.stringify(firstOpen));

			const freshOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/two"],
				sessionMode: "fresh",
			});
			assert.equal(freshOpen.isError, false, JSON.stringify(freshOpen));

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

test("runAgentBrowserProcess forwards a curated environment instead of the full parent env", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const readEnv = (name) => process.env[name] ?? null;
const envelope = {
  success: true,
  data: {
    agentBrowserActionPolicy: readEnv("AGENT_BROWSER_ACTION_POLICY"),
    agentBrowserConfig: readEnv("AGENT_BROWSER_CONFIG"),
    agentBrowserConfirmActions: readEnv("AGENT_BROWSER_CONFIRM_ACTIONS"),
    agentBrowserDefaultTimeout: readEnv("AGENT_BROWSER_DEFAULT_TIMEOUT"),
    agentBrowserEncryptionKey: readEnv("AGENT_BROWSER_ENCRYPTION_KEY"),
    agentBrowserScreenshotDir: readEnv("AGENT_BROWSER_SCREENSHOT_DIR"),
    agentBrowserSession: readEnv("AGENT_BROWSER_SESSION"),
    agentBrowserIosDevice: readEnv("AGENT_BROWSER_IOS_DEVICE"),
    agentBrowserIosUdid: readEnv("AGENT_BROWSER_IOS_UDID"),
    agentBrowserSessionName: readEnv("AGENT_BROWSER_SESSION_NAME"),
    agentcoreApiKey: readEnv("AGENTCORE_API_KEY"),
    agentcoreRegion: readEnv("AGENTCORE_REGION"),
    aiGatewayApiKey: readEnv("AI_GATEWAY_API_KEY"),
    aiGatewayModel: readEnv("AI_GATEWAY_MODEL"),
    awsAccessKeyId: readEnv("AWS_ACCESS_KEY_ID"),
    awsSecretAccessKey: readEnv("AWS_SECRET_ACCESS_KEY"),
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
				AGENT_BROWSER_CONFIG: "/tmp/agent-browser.json",
				AGENT_BROWSER_CONFIRM_ACTIONS: "1",
				AGENT_BROWSER_DEFAULT_TIMEOUT: "45000",
				AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
				AGENT_BROWSER_SCREENSHOT_DIR: "/tmp/agent-browser-screenshots",
				AGENT_BROWSER_SESSION: "from-parent-session",
				AGENT_BROWSER_IOS_DEVICE: "iPhone 15 Pro",
				AGENT_BROWSER_IOS_UDID: "ios-udid-123",
				AGENT_BROWSER_SESSION_NAME: "from-parent-session-name",
				AGENT_BROWSER_SOCKET_DIR: "/tmp/from-parent-should-not-leak",
				AGENTCORE_API_KEY: "agentcore-key",
				AGENTCORE_REGION: "us-west-2",
				AI_GATEWAY_API_KEY: "ai-gateway-key",
				AI_GATEWAY_MODEL: "anthropic/test-model",
				AWS_ACCESS_KEY_ID: "aws-access-key-id",
				AWS_SECRET_ACCESS_KEY: "aws-secret-access-key",
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
					args: ["session"],
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
					agentBrowserActionPolicy: string | null;
					agentBrowserConfig: string | null;
					agentBrowserConfirmActions: string | null;
					agentBrowserDefaultTimeout: string | null;
					agentBrowserEncryptionKey: string | null;
					agentBrowserScreenshotDir: string | null;
					agentBrowserIosDevice: string | null;
					agentBrowserIosUdid: string | null;
					agentBrowserSession: string | null;
					agentBrowserSessionName: string | null;
					agentcoreApiKey: string | null;
					agentcoreRegion: string | null;
					aiGatewayApiKey: string | null;
					aiGatewayModel: string | null;
					awsAccessKeyId: string | null;
					awsSecretAccessKey: string | null;
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
				assert.equal(data.agentBrowserActionPolicy, "/tmp/action-policy.json");
				assert.equal(data.agentBrowserConfig, "/tmp/agent-browser.json");
				assert.equal(data.agentBrowserConfirmActions, "1");
				assert.equal(data.agentBrowserDefaultTimeout, "25000");
				assert.equal(data.agentBrowserEncryptionKey, "a".repeat(64));
				assert.equal(data.agentBrowserScreenshotDir, "/tmp/agent-browser-screenshots");
				assert.equal(data.agentBrowserIosDevice, "iPhone 15 Pro");
				assert.equal(data.agentBrowserIosUdid, "ios-udid-123");
				assert.equal(data.agentBrowserSession, "from-parent-session");
				assert.equal(data.agentBrowserSessionName, "from-parent-session-name");
				assert.equal(data.agentcoreApiKey, "agentcore-key");
				assert.equal(data.agentcoreRegion, "us-west-2");
				assert.equal(data.aiGatewayApiKey, "ai-gateway-key");
				assert.equal(data.aiGatewayModel, "anthropic/test-model");
				assert.equal(data.awsAccessKeyId, "aws-access-key-id");
				assert.equal(data.awsSecretAccessKey, "aws-secret-access-key");
				assert.equal(data.browserbaseApiKey, "browserbase-key");
				assert.equal(data.browserbaseProjectId, "browserbase-project");
				assert.equal(data.browserlessApiKey, "browserless-key");
				assert.equal(data.browserUseApiKey, "browser-use-key");
				assert.equal(data.databaseUrl, null);
				assert.equal(data.idleTimeout, "1234");
				assert.equal(data.kernelApiKey, "kernel-key");
				assert.equal(data.lang, "en_US.UTF-8");
				assert.equal(data.openaiApiKey, null);
				assert.equal(data.secret, null);
				assert.equal(data.socketDir, getAgentBrowserSocketDir());
				if (data.socketDir) {
					assert.equal((await stat(data.socketDir)).isDirectory(), true);
				}
				assert.equal(data.unrelatedApiKey, null);
				assert.equal(data.pathStartsWithTemp, true);
			},
		);
	} finally {
		await rm(tempDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
});

