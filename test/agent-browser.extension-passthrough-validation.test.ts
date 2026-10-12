/**
 * Purpose: Verify extension pass-through, artifact-path normalization, JSON, missing-binary, and trace/profiler validation contracts.
 * Responsibilities: Assert pass-through argv, artifact paths, JSON output, missing binaries, and trace/profiler validation.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-passthrough-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { readArray, readRecord, readString } from "./helpers/assertions.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const stripWrapperPrefix = (args: readonly string[]) => {
	const stripped = [...args];
	if (stripped[0] === "--allow-file-access") {
		stripped.splice(0, 2);
	}
	if (stripped[0] === "--json") {
		stripped.shift();
	}
	if (stripped[0] === "--namespace") {
		stripped.splice(0, 2);
	}
	if (stripped[0] === "--session") {
		stripped.splice(0, 2);
	}
	return stripped;
};

// The wrapper resolves the implicit root Pi session to a native named session and live-verifies the
// active page URL with a `get url` probe before page-content access. Explicit navigation, history or
// attachment transitions that themselves re-establish the target, tab selection/close, lifecycle
// closes, dialogs, and `get url` itself are exempt; everything else is probed first.
const needsRootSessionPageCheck = (args: readonly string[]) => {
	const command = args[0];
	const subcommand = args[1];
	if (command === "get") {
		return subcommand !== "url";
	}
	if (
		[
			"open",
			"goto",
			"navigate",
			"pushstate",
			"vitals",
			"web-vitals",
			"back",
			"forward",
			"reload",
			"connect",
			"close",
			"quit",
			"exit",
			"dialog",
		].includes(command)
	) {
		return false;
	}
	if (command === "state") {
		return subcommand !== "load";
	}
	if (command === "tab") {
		return subcommand === "new";
	}
	if (command === "diff") {
		return subcommand !== "url";
	}
	if (command === "record") {
		return subcommand !== "stop";
	}
	return true;
};

test(
	"agentBrowserExtension exposes native session-info facts in model-visible content",
	{ concurrency: false },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-si-"));
		const home = join(root, "home");
		const temp = join(root, "tmp");
		const sockets = join(root, "s");
		const logPath = join(root, "calls.jsonl");
		const dataPath = join(root, "data.json");
		await Promise.all([home, temp, sockets].map((path) => mkdir(path, { mode: 0o700 })));
		await writeFakeAgentBrowserBinary(
			root,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (!args.includes("session") || !args.includes("info")) throw new Error("Unexpected browser command");
process.stdout.write(JSON.stringify({ success: true, data: JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, "utf8")) }));`,
		);
		const clearedEnv = Object.fromEntries(
			Object.keys(process.env)
				.filter((key) => /^(?:PI_)?AGENT_BROWSER_/.test(key))
				.map((key) => [key, undefined]),
		);
		try {
			await withPatchedEnv(
				{
					...clearedEnv,
					HOME: home,
					USERPROFILE: home,
					TMPDIR: temp,
					TMP: temp,
					TEMP: temp,
					PATH: `${root}${delimiter}${dirname(process.execPath)}`,
					PI_AGENT_BROWSER_SOCKET_DIR: sockets,
					AGENT_BROWSER_SOCKET_DIR: sockets,
					AGENT_BROWSER_NAMESPACE: "fixture",
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: root });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					try {
						for (const status of [
							{ active: false, pid: null, version: null, runtime: null, runtimeError: null },
							{
								active: true,
								pid: 1234,
								version: "0.37.1",
								runtime: {
									browserLaunched: true,
									engine: "chromium",
									launchHash: "launch-identity",
									restoreKey: "shared-auth",
								},
								runtimeError: null,
							},
							{
								active: true,
								pid: 1234,
								version: "0.37.1",
								runtime: null,
								runtimeError: "Runtime info unavailable",
							},
						]) {
							const data = {
								session: "fixture",
								namespace: "fixture",
								socketDir: sockets,
								...status,
							};
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							await writeFile(dataPath, JSON.stringify(data));
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							const result = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["--session", "fixture", "session", "info"],
							});
							// All three literal daemon states must preserve native receipts and caller ownership.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(result.details);
							// All three literal daemon states must preserve native receipts and caller ownership.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(result.isError, false);
							const text = result.content[0]?.text ?? "";
							// All three literal daemon states must preserve native receipts and caller ownership.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(
								text.startsWith(
									`Daemon: ${status.active ? "active" : "inactive"}; PID: ${status.pid ?? "unknown"}\n`,
								),
							);
							// All three literal daemon states must preserve native receipts and caller ownership.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(
								text,
								/\nBrowser: unknown; alive: unknown; Chrome PID: unknown\nExact profile: unknown\nNative browser ownership: unknown; Pi cleanup ownership: caller-owned\n\n/,
							);
							// All three literal daemon states must preserve native receipts and caller ownership.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.deepEqual(
								JSON.parse(text.slice(text.indexOf("\n\n") + 2).split("\n\nObservation:")[0]),
								data,
							);
							// All three literal daemon states must preserve native receipts and caller ownership.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.deepEqual(result.details.data, {
								...data,
								piCleanupOwnership: "caller-owned",
							});
						}
						await writeFile(dataPath, JSON.stringify({ session: "fixture" }));
						const legacy = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "fixture", "session", "info"],
						});
						assert.match(
							legacy.content[0]?.text ?? "",
							/^Current session: fixture\n\nObservation:/,
						);
						assert.equal((await readInvocationLog(logPath)).length, 4);
					} finally {
						await runExtensionEvent(harness.handlers, "session_shutdown", {}, harness.ctx);
					}
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"agentBrowserExtension keeps successful plain-text inspection stateless and machine-readable",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("--version")) {
  process.stdout.write("agent-browser 9.9.9\\n");
} else {
  process.stdout.write("Usage: agent-browser " + args.join(" ") + "\\nExample: agent-browser open https://example.com\\n");
}`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_VERSION: "1" },
				async () => {
					const harness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Open a page and summarize it.",
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const version = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--headed=false", "--version"],
					});
					assert.ok(version.details);
					const rootHelp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--args=demo", "--help"],
					});
					assert.ok(rootHelp.details);
					const commandHelp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "--help"],
					});
					assert.ok(commandHelp.details);

					assert.equal(version.isError, false);
					assert.equal(version.content[0]?.type, "text");
					assert.match(readString(readRecord(version.content[0]).text), /agent-browser 9\.9\.9/);
					assert.equal(version.details.inspection, true);
					assert.equal(version.details.stdout, "agent-browser 9.9.9");
					assert.equal(version.details.parseError, undefined);
					assert.equal(version.details.sessionName, undefined);
					assert.equal(version.details.usedImplicitSession, undefined);
					assert.equal(rootHelp.isError, false);
					assert.equal(rootHelp.details.inspection, true);
					assert.equal(rootHelp.details.sessionName, undefined);
					assert.match(
						readString(readRecord(rootHelp.content[0]).text),
						/Usage: agent-browser --args=demo --help/,
					);
					assert.equal(commandHelp.isError, false);
					assert.equal(commandHelp.details.inspection, true);
					assert.equal(commandHelp.details.sessionName, undefined);
					assert.match(
						readString(readRecord(commandHelp.content[0]).text),
						/Usage: agent-browser snapshot --help/,
					);
					assert.deepEqual(await readInvocationLog(logPath), [
						{ args: ["--headed=false", "--version"] },
						{ args: ["--args=demo", "--help"] },
						{ args: ["snapshot", "--help"] },
					]);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rejects unsupported global equals assignments before upstream dispatch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-equals-flags-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: {} }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				for (const args of [
					["--args=--user-agent=TARS", "open", "https://example.com/"],
					["screenshot", "page.png", "--user-agent=TARS"],
				]) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
					// Both literal unsupported global-equals variants must fail before upstream dispatch.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(result.details);
					// Both literal unsupported global-equals variants must fail before upstream dispatch.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.isError, true, args.join(" "));
					// Both literal unsupported global-equals variants must fail before upstream dispatch.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(result.details.validationError),
						/does not support `--(?:args|user-agent)=<value>`/,
					);
				}

				for (const params of [
					{ args: ["batch", "screenshot page.png --user-agent=TARS"] },
					{
						args: ["batch"],
						stdin: JSON.stringify([["screenshot", "page.png", "--user-agent=TARS", "--help"]]),
					},
					{ args: ["batch", "screenshot page.png --restore=auth"] },
				]) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
					// All three literal batch-global variants must fail before upstream dispatch.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(result.details);
					// All three literal batch-global variants must fail before upstream dispatch.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.isError, true, params.args.join(" "));
					// All three literal batch-global variants must fail before upstream dispatch.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(readString(result.details.validationError), /before `batch`/);
				}
				assert.deepEqual(await readInvocationLog(logPath), []);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rejects per-call idle timeout changes that would restart the browser",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-idle-timeout-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1234",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const mismatch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--idle-timeout", "5000", "open", "https://example.com/"],
						sessionMode: "fresh",
					});
					assert.ok(mismatch.details);
					assert.equal(mismatch.isError, true);
					assert.match(
						readString(mismatch.details.validationError),
						/conflicts with this Pi process's managed-session idle timeout/,
					);
					assert.match(
						readString(mismatch.details.validationError),
						/PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS=5000/,
					);
					assert.deepEqual(await readInvocationLog(logPath), []);

					const inlineAligned = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--idle-timeout=1234", "open", "https://example.com/"],
						sessionMode: "fresh",
					});
					assert.ok(inlineAligned.details);
					assert.equal(inlineAligned.isError, true);
					assert.match(
						readString(inlineAligned.details.validationError),
						/does not support `--idle-timeout=<value>`/,
					);
					assert.deepEqual(await readInvocationLog(logPath), []);

					const aligned = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--idle-timeout", "1234", "open", "https://example.com/"],
						sessionMode: "fresh",
					});
					assert.equal(aligned.isError, false);
					const alignedInvocations = await readInvocationLog(logPath);
					assert.deepEqual(
						alignedInvocations.map((entry) => entry.args.slice(-2)),
						[
							["open", "https://example.com/"],
							["tab", "list"],
						],
					);
					assert.deepEqual(
						alignedInvocations.map((entry) => entry.idleTimeout),
						["1234", "1234"],
					);

					const activeSessionMismatch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--idle-timeout", "5000", "open", "https://example.com/next"],
					});
					assert.ok(activeSessionMismatch.details);
					assert.equal(activeSessionMismatch.isError, true);
					assert.match(
						readString(activeSessionMismatch.details.validationError),
						/PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS=5000/,
					);
					assert.equal(activeSessionMismatch.details.sessionRecoveryHint, undefined);
					assert.deepEqual(await readInvocationLog(logPath), alignedInvocations);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension passes through plugin list/show and blocks bare mcp one-shots",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-plugin-mcp-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const commandIndex = args.indexOf("plugin");
const command = commandIndex >= 0 ? "plugin" : args.includes("mcp") ? "mcp" : "unknown";
const subcommand = command === "plugin" ? (args[commandIndex + 1] || "list") : undefined;
if (command === "mcp" && args.includes("--help")) {
  process.stdout.write("agent-browser mcp - Start an MCP stdio server\\nUsage: agent-browser mcp [--tools <profiles>]\\n");
} else if (subcommand === "list") {
  process.stdout.write(JSON.stringify({ plugins: [{ name: "demo", capabilities: ["command.run"] }] }));
} else if (subcommand === "show") {
  process.stdout.write(JSON.stringify({ plugin: { name: args[commandIndex + 2], capabilities: ["command.run"] } }));
} else {
  process.stdout.write(JSON.stringify({ success: false, error: "unexpected command" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Exercise plugin and MCP passthrough.",
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const pluginList = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["plugin", "list"],
				});
				assert.ok(pluginList.details);
				const pluginShow = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["plugin", "show", "demo"],
				});
				assert.ok(pluginShow.details);
				const bareMcp = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["mcp", "--tools", "core"],
				});
				const mcpHelp = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["mcp", "--help"],
				});
				assert.ok(mcpHelp.details);
				const mcpHelpWord = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["mcp", "help"],
				});

				assert.equal(pluginList.isError, false);
				assert.deepEqual(pluginList.details.data, {
					plugins: [{ name: "demo", capabilities: ["command.run"] }],
				});
				assert.equal(pluginList.details.sessionName, undefined);
				assert.equal(pluginList.details.usedImplicitSession, undefined);
				assert.equal(pluginShow.isError, false);
				assert.deepEqual(pluginShow.details.data, {
					plugin: { name: "demo", capabilities: ["command.run"] },
				});
				assert.equal(pluginShow.details.sessionName, undefined);
				assert.equal(bareMcp.isError, true);
				assert.match(bareMcp.content[0]?.text ?? "", /external MCP clients/);
				assert.equal(mcpHelp.isError, false);
				assert.equal(mcpHelp.details.inspection, true);
				assert.match(mcpHelp.content[0]?.text ?? "", /Start an MCP stdio server/);
				assert.equal(mcpHelpWord.isError, true);
				assert.match(mcpHelpWord.content[0]?.text ?? "", /external MCP clients/);

				assert.deepEqual(await readInvocationLog(logPath), [
					{ args: ["--json", "plugin", "list"] },
					{ args: ["--json", "plugin", "show", "demo"] },
					{ args: ["mcp", "--help"] },
				]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension keeps skills inspection flows stateless and useful",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-skills-inspection-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const commandStart = args.indexOf("skills");
const subcommand = args[commandStart + 1];
if (subcommand === "list") {
  process.stdout.write(JSON.stringify({ success: true, data: [{ name: "core", description: "Core usage guide" }] }));
} else if (subcommand === "get") {
  process.stdout.write(JSON.stringify({ success: true, data: { content: ${JSON.stringify("# Core\n\n```bash\nagent-browser snapshot -i\n```")} } }));
} else if (subcommand === "path") {
  process.stdout.write(JSON.stringify({ success: true, data: "/tmp/agent-browser-skills/core" }));
} else {
  process.stdout.write(JSON.stringify({ success: false, error: "unexpected skills command" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Inspect agent-browser skills.",
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const list = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["skills", "list"],
				});
				assert.ok(list.details);
				const get = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["skills", "get", "core", "--full"],
				});
				const path = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["skills", "path", "core"],
				});
				assert.ok(path.details);

				assert.equal(list.isError, false);
				assert.match(readString(readRecord(list.content[0]).text), /1\. core — Core usage guide/);
				assert.equal(list.details.sessionName, undefined);
				assert.equal(list.details.usedImplicitSession, undefined);
				assert.equal(get.isError, false);
				assert.match(
					readString(readRecord(get.content[0]).text),
					/agent_browser \{ "args": \["snapshot","-i"\] \}/,
				);
				assert.equal(path.isError, false);
				assert.equal(path.details.summary, "agent-browser skill path");
				assert.match(
					readString(readRecord(path.content[0]).text),
					/\/tmp\/agent-browser-skills\/core/,
				);

				assert.deepEqual(await readInvocationLog(logPath), [
					{ args: ["--json", "skills", "list"] },
					{ args: ["--json", "skills", "get", "core", "--full"] },
					{ args: ["--json", "skills", "path", "core"] },
				]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension passes through provider workflows",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-provider-matrix-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  agentcoreApiKey: process.env.AGENTCORE_API_KEY || null,
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY || null,
  browserlessApiKey: process.env.BROWSERLESS_API_KEY || null,
  browserUseApiKey: process.env.BROWSER_USE_API_KEY || null,
  iosDevice: process.env.AGENT_BROWSER_IOS_DEVICE || null,
  kernelApiKey: process.env.KERNEL_API_KEY || null
}) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { ok: true, args } }));`,
		);

		const providerCommands = [
			["-p", "ios", "device", "list"],
			["-p", "ios", "--device", "iPhone 15 Pro", "tap", "@e1"],
			["--provider", "browserbase", "open", "https://example.com"],
			["--provider", "kernel", "open", "https://example.com"],
			["--provider", "browseruse", "open", "https://example.com"],
			["--provider", "browserless", "open", "https://example.com"],
			["--provider", "agentcore", "open", "https://example.com"],
		] as const;

		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_IOS_DEVICE: "iPhone 15 Pro",
					AGENTCORE_API_KEY: "agentcore-key",
					BROWSERBASE_API_KEY: "browserbase-key",
					BROWSERLESS_API_KEY: "browserless-key",
					BROWSER_USE_API_KEY: "browser-use-key",
					KERNEL_API_KEY: "kernel-key",
					PATH: `${tempDir}:${basePath}`,
				},
				async () => {
					const harness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Exercise provider passthrough.",
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					for (const args of providerCommands) {
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						const result = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: [...args],
							sessionMode: "fresh",
						});
						// Every command in the fixed nonempty provider table checks success and credential redaction.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(result.details);
						// Every command in the fixed nonempty provider table checks success and credential redaction.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							result.isError,
							false,
							`${args.join(" ")}: ${result.content[0]?.type === "text" ? readString(result.content[0].text) : ""}`,
						);
						// Every command in the fixed nonempty provider table checks success and credential redaction.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.doesNotMatch(
							JSON.stringify(result.details),
							/agentcore-key|browserbase-key|browserless-key|browser-use-key|kernel-key/,
						);
					}

					const invocations = await readInvocationLog(logPath);
					const providerInvocations = invocations.filter((entry) => {
						const userArgs = stripWrapperPrefix(entry.args);
						return entry.args[1] === "--session" && userArgs.length > 0 && userArgs[0] !== "close";
					});
					const sessionfulProviderCommands = providerCommands.filter(
						(args) => !(args[0] === "-p" && args.at(1) === "ios" && args[2] === "device"),
					);
					assert.deepEqual(
						providerInvocations.map((entry) => stripWrapperPrefix(entry.args)),
						sessionfulProviderCommands.map((args) => args.slice()),
					);
					assert.deepEqual(
						invocations.find(
							(entry) => entry.args.includes("device") && entry.args.includes("list"),
						)?.args,
						["--json", "-p", "ios", "device", "list"],
					);
					assert.ok(
						providerInvocations.every(
							(entry) => entry.args[0] === "--json" && entry.args[1] === "--session",
						),
					);
					assert.ok(providerInvocations.some((entry) => entry.iosDevice === "iPhone 15 Pro"));
					assert.ok(providerInvocations.some((entry) => entry.agentcoreApiKey === "agentcore-key"));
					assert.ok(
						providerInvocations.some((entry) => entry.browserbaseApiKey === "browserbase-key"),
					);
					assert.ok(
						providerInvocations.some((entry) => entry.browserlessApiKey === "browserless-key"),
					);
					assert.ok(
						providerInvocations.some((entry) => entry.browserUseApiKey === "browser-use-key"),
					);
					assert.ok(providerInvocations.some((entry) => entry.kernelApiKey === "kernel-key"));
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension preserves one attached Chrome connection across explicit-session follow-ups",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-attached-session-"));
		const logPath = join(tempDir, "invocations.log");
		const failedDaemonPath = join(tempDir, "failed-daemon-active");
		const unsafeTargetPath = join(tempDir, "unsafe-target");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--allow-file-access", "--args", "--cdp", "--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const command = args[commandIndex] || "unknown";
const subcommand = args[commandIndex + 1];
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
if (process.env.PI_AGENT_BROWSER_TEST_FAIL_ATTACHED_GET_URL === "1" && command === "get" && subcommand === "url" && args.includes("--cdp")) {
  fs.writeFileSync(${JSON.stringify(failedDaemonPath)}, "active");
  process.stdout.write(JSON.stringify({ success: false, error: "attached get url failed after launch" }));
  process.exit(1);
}
const currentUrl = fs.existsSync(${JSON.stringify(unsafeTargetPath)}) ? "file:///tmp/private.html" : "https://dash.cloudflare.com/";
const sessionActive = sessionName === "cloudflare-live" || fs.existsSync(${JSON.stringify(failedDaemonPath)});
const batchInput = command === "batch" ? fs.readFileSync(0, "utf8") : "";
const data = command === "batch"
  ? JSON.parse(batchInput).map((step) => ({
      command: step,
      result: step[0] === "open"
        ? { url: step[1] }
        : step[0] === "snapshot"
          ? { refs: { e1: {} }, snapshot: "- heading \\"Cloudflare Dashboard\\" [ref=e1]", title: "Cloudflare Dashboard", url: currentUrl }
          : step[0] === "network" && step[1] === "route"
            ? { routed: step[2] }
            : {},
      success: true,
    }))
  : command === "tab" && subcommand === "list"
  ? { tabs: [{ tabId: "t1", url: currentUrl, active: true }] }
  : command === "session" && subcommand === "info"
  ? { active: sessionActive, runtime: sessionActive ? { restoreKey: null } : null }
  : command === "get" && subcommand === "url"
  ? { result: currentUrl, url: currentUrl }
  : command === "snapshot"
    ? { snapshot: "- heading \\"Cloudflare Dashboard\\" [ref=e1]", origin: currentUrl }
    : command === "network" && subcommand === "requests"
      ? { requests: [{ method: "GET", requestId: "after-close", resourceType: "fetch", url: "https://dash.cloudflare.com/api/test" }] }
      : { connected: command === "connect" };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					PI_AGENT_BROWSER_TEST_PRESERVE_INTERNAL_LAUNCH_FLAGS: "1",
				},
				async () => {
					const harness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Inspect the attached Cloudflare tab.",
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const connect = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "connect", "9222"],
					});
					const url = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "get", "url"],
					});
					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "snapshot", "-i"],
					});
					const attachedBranch = harness.ctx.sessionManager.getBranch().slice();
					const attachedCloseThenOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "batch"],
						stdin: JSON.stringify([["close"], ["open", "https://dash.cloudflare.com/"]]),
					});
					const snapshotAfterNestedClose = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "snapshot", "-i"],
					});
					assert.ok(snapshotAfterNestedClose.details);
					const freshLabeledUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "get", "url"],
						sessionMode: "fresh",
					});

					assert.equal(connect.isError, false, readString(readRecord(connect.content[0]).text));
					assert.equal(url.isError, false, readString(readRecord(url.content[0]).text));
					assert.equal(snapshot.isError, false, readString(readRecord(snapshot.content[0]).text));
					assert.equal(
						attachedCloseThenOpen.isError,
						false,
						readString(readRecord(attachedCloseThenOpen.content[0]).text),
					);
					assert.equal(
						snapshotAfterNestedClose.isError,
						false,
						readString(readRecord(snapshotAfterNestedClose.content[0]).text),
					);
					assert.equal(snapshotAfterNestedClose.details.attachedBrowserSession, true);
					assert.equal(
						freshLabeledUrl.isError,
						false,
						readString(readRecord(freshLabeledUrl.content[0]).text),
					);
					const attachedInvocations = (await readInvocationLog(logPath)).filter((entry) =>
						entry.args.includes("cloudflare-live"),
					);
					assert.ok(attachedInvocations.some((entry) => entry.args.includes("connect")));
					assert.ok(attachedInvocations.some((entry) => entry.args.includes("snapshot")));
					assert.ok(
						attachedInvocations.some(
							(entry) => entry.args.includes("get") && entry.args.includes("url"),
						),
					);
					assert.ok(
						attachedInvocations.every(
							(entry) =>
								!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
						),
					);

					const terminalCloseInvocationCount = (await readInvocationLog(logPath)).length;
					const attachedTerminalClose = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "cloudflare-live", "batch"],
						stdin: JSON.stringify([
							["network", "route", "**/api/**", "--body", "{}"],
							["snapshot", "-i"],
							["close"],
						]),
					});
					assert.ok(attachedTerminalClose.details);
					assert.equal(
						attachedTerminalClose.isError,
						false,
						readString(readRecord(attachedTerminalClose.content[0]).text),
					);
					assert.equal(attachedTerminalClose.details.refSnapshot, undefined);
					const terminalBranch = harness.ctx.sessionManager.getBranch().slice();
					const requestsAfterTerminalClose = await executeRegisteredTool(
						harness.tool,
						harness.ctx,
						{ args: ["--session", "cloudflare-live", "network", "requests"] },
					);
					assert.ok(requestsAfterTerminalClose.details);
					assert.equal(
						requestsAfterTerminalClose.isError,
						false,
						readString(readRecord(requestsAfterTerminalClose.content[0]).text),
					);
					assert.equal(requestsAfterTerminalClose.details.attachedBrowserSession, undefined);
					assert.equal(requestsAfterTerminalClose.details.networkRouteDiagnostics, undefined);
					const postCloseInvocations = (await readInvocationLog(logPath)).slice(
						terminalCloseInvocationCount,
					);
					const postCloseRequests = postCloseInvocations.find(
						(entry) => entry.args.includes("network") && entry.args.includes("requests"),
					);
					assert.equal(postCloseRequests?.args.includes("--args"), false);
					assert.equal(postCloseRequests.args.includes("--allow-file-access"), false);

					const terminalResumeInvocationCount = (await readInvocationLog(logPath)).length;
					const terminalResumeHarness = createExtensionHarness({
						branch: terminalBranch,
						cwd: tempDir,
						prompt: "Resume after the attached session was closed by a batch.",
					});
					await runExtensionEvent(
						terminalResumeHarness.handlers,
						"session_start",
						{ reason: "resume" },
						terminalResumeHarness.ctx,
					);
					const requestsAfterTerminalResume = await executeRegisteredTool(
						terminalResumeHarness.tool,
						terminalResumeHarness.ctx,
						{ args: ["--session", "cloudflare-live", "network", "requests"] },
					);
					assert.ok(requestsAfterTerminalResume.details);
					assert.equal(
						requestsAfterTerminalResume.isError,
						false,
						readString(readRecord(requestsAfterTerminalResume.content[0]).text),
					);
					assert.equal(requestsAfterTerminalResume.details.attachedBrowserSession, undefined);
					assert.equal(requestsAfterTerminalResume.details.networkRouteDiagnostics, undefined);
					const postResumeRequests = (await readInvocationLog(logPath))
						.slice(terminalResumeInvocationCount)
						.find((entry) => entry.args.includes("network") && entry.args.includes("requests"));
					assert.equal(postResumeRequests?.args.includes("--args"), false);
					assert.equal(postResumeRequests.args.includes("--allow-file-access"), false);

					const invocationCount = (await readInvocationLog(logPath)).length;
					const resumedHarness = createExtensionHarness({
						branch: attachedBranch,
						cwd: tempDir,
						prompt: "Resume the attached Cloudflare tab.",
					});
					await runExtensionEvent(
						resumedHarness.handlers,
						"session_start",
						{ reason: "resume" },
						resumedHarness.ctx,
					);
					const resumedSnapshot = await executeRegisteredTool(
						resumedHarness.tool,
						resumedHarness.ctx,
						{ args: ["--session", "cloudflare-live", "snapshot", "-i"] },
					);
					assert.equal(
						resumedSnapshot.isError,
						false,
						readString(readRecord(resumedSnapshot.content[0]).text),
					);
					const resumedInvocations = (await readInvocationLog(logPath)).slice(invocationCount);
					assert.ok(resumedInvocations.length > 0);
					assert.ok(
						resumedInvocations.every(
							(entry) =>
								!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
						),
					);

					await writeFile(unsafeTargetPath, "unsafe", "utf8");
					const driftInvocationCount = (await readInvocationLog(logPath)).length;
					const localDriftSnapshot = await executeRegisteredTool(
						resumedHarness.tool,
						resumedHarness.ctx,
						{ args: ["--session", "cloudflare-live", "snapshot", "-i"] },
					);
					assert.equal(localDriftSnapshot.isError, false, JSON.stringify(localDriftSnapshot));
					const driftInvocations = (await readInvocationLog(logPath)).slice(driftInvocationCount);
					assert.ok(
						driftInvocations.some(
							(entry) => entry.args.includes("get") && entry.args.includes("url"),
						),
					);
					assert.ok(driftInvocations.some((entry) => entry.args.includes("snapshot")));

					const implicitHarness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Reject content capture before the attached page URL is verified.",
					});
					await runExtensionEvent(
						implicitHarness.handlers,
						"session_start",
						{ reason: "new" },
						implicitHarness.ctx,
					);
					const implicitInvocationCount = (await readInvocationLog(logPath)).length;
					const blockedFirstUse = await executeRegisteredTool(
						implicitHarness.tool,
						implicitHarness.ctx,
						{ args: ["--cdp", "9222", "snapshot", "-i"], sessionMode: "fresh" },
					);
					assert.equal(blockedFirstUse.isError, true);
					assert.match(readString(readRecord(blockedFirstUse.content[0]).text), /unverified/i);
					assert.ok(
						(await readInvocationLog(logPath))
							.slice(implicitInvocationCount)
							.every((entry) => !entry.args.includes("snapshot")),
					);

					await rm(unsafeTargetPath, { force: true });
					const managedHarness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Attach a managed session, verify it, then close it safely.",
					});
					await runExtensionEvent(
						managedHarness.handlers,
						"session_start",
						{ reason: "new" },
						managedHarness.ctx,
					);
					const managedUrl = await executeRegisteredTool(managedHarness.tool, managedHarness.ctx, {
						args: ["--cdp", "9222", "get", "url"],
						sessionMode: "fresh",
					});
					assert.ok(managedUrl.details);
					assert.equal(managedUrl.isError, false);
					const managedBranch = managedHarness.ctx.sessionManager.getBranch().slice();
					const managedSessionName = managedUrl.details.sessionName;
					assert.equal(typeof managedSessionName, "string");
					await writeFile(unsafeTargetPath, "unsafe", "utf8");
					const localManagedSnapshot = await executeRegisteredTool(
						managedHarness.tool,
						managedHarness.ctx,
						{ args: ["snapshot", "-i"] },
					);
					assert.equal(localManagedSnapshot.isError, false, JSON.stringify(localManagedSnapshot));
					await rm(unsafeTargetPath, { force: true });
					await runExtensionEvent(
						managedHarness.handlers,
						"session_tree",
						{ newLeafId: null, oldLeafId: "attached-branch" },
						managedHarness.ctx,
					);
					await runExtensionEvent(
						managedHarness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						managedHarness.ctx,
					);
					const managedInvocations = (await readInvocationLog(logPath)).filter((entry) =>
						entry.args.includes(readString(managedSessionName)),
					);
					assert.ok(managedInvocations.some((entry) => entry.args.includes("close")));
					assert.ok(
						managedInvocations.every(
							(entry) =>
								!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
						),
					);

					const namespaceResumeInvocationCount = (await readInvocationLog(logPath)).length;
					await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "changed-after-attach" }, async () => {
						const namespaceResumeHarness = createExtensionHarness({
							branch: managedBranch,
							cwd: tempDir,
							prompt:
								"Close the default-namespace attachment after the process environment namespace changes.",
						});
						await runExtensionEvent(
							namespaceResumeHarness.handlers,
							"session_start",
							{ reason: "resume" },
							namespaceResumeHarness.ctx,
						);
						await runExtensionEvent(
							namespaceResumeHarness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							namespaceResumeHarness.ctx,
						);
					});
					const namespaceResumeInvocations = (await readInvocationLog(logPath))
						.slice(namespaceResumeInvocationCount)
						.filter((entry) => entry.args.includes(readString(managedSessionName)));
					assert.ok(namespaceResumeInvocations.some((entry) => entry.args.includes("close")));
					assert.ok(
						namespaceResumeInvocations.every(
							(entry) =>
								!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
						),
					);

					await withPatchedEnv({ PI_AGENT_BROWSER_TEST_FAIL_ATTACHED_GET_URL: "1" }, async () => {
						const failedHarness = createExtensionHarness({
							cwd: tempDir,
							prompt: "Clean up a failed attachment that still started its daemon.",
						});
						await runExtensionEvent(
							failedHarness.handlers,
							"session_start",
							{ reason: "new" },
							failedHarness.ctx,
						);
						const failedAttach = await executeRegisteredTool(
							failedHarness.tool,
							failedHarness.ctx,
							{ args: ["--cdp", "9222", "get", "url"], sessionMode: "fresh" },
						);
						assert.ok(failedAttach.details);
						assert.equal(failedAttach.isError, true);
						assert.equal(readRecord(failedAttach.details.managedSessionOutcome).activeAfter, true);
						assert.equal(failedAttach.details.attachedBrowserSession, true);
						const failedSessionName = failedAttach.details.sessionName;
						assert.equal(typeof failedSessionName, "string");
						const failedInvocationCount = (await readInvocationLog(logPath)).length;
						const failedResumeHarness = createExtensionHarness({
							branch: failedHarness.ctx.sessionManager.getBranch().slice(),
							cwd: tempDir,
							prompt: "Resume and clean up the failed attachment that retained an active daemon.",
						});
						await runExtensionEvent(
							failedResumeHarness.handlers,
							"session_start",
							{ reason: "resume" },
							failedResumeHarness.ctx,
						);
						await runExtensionEvent(
							failedResumeHarness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							failedResumeHarness.ctx,
						);
						const failedInvocations = (await readInvocationLog(logPath))
							.slice(failedInvocationCount)
							.filter((entry) => entry.args.includes(readString(failedSessionName)));
						assert.ok(failedInvocations.some((entry) => entry.args.includes("close")));
						assert.ok(
							failedInvocations.every(
								(entry) =>
									!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
							),
						);
					});

					await withPatchedEnv({ AGENT_BROWSER_CDP: "9222" }, async () => {
						const envHarness = createExtensionHarness({
							cwd: tempDir,
							prompt: "Reuse the CDP endpoint configured in the environment.",
						});
						await runExtensionEvent(
							envHarness.handlers,
							"session_start",
							{ reason: "new" },
							envHarness.ctx,
						);
						const envUrl = await executeRegisteredTool(envHarness.tool, envHarness.ctx, {
							args: ["--session", "env-cdp", "get", "url"],
						});
						const envSnapshot = await executeRegisteredTool(envHarness.tool, envHarness.ctx, {
							args: ["--session", "env-cdp", "snapshot", "-i"],
						});
						assert.ok(envSnapshot.details);
						assert.equal(envUrl.isError, false);
						assert.equal(envSnapshot.isError, false);
						assert.equal(envSnapshot.details.attachedBrowserSession, true);
						const envInvocations = (await readInvocationLog(logPath)).filter((entry) =>
							entry.args.includes("env-cdp"),
						);
						assert.ok(
							envInvocations.every(
								(entry) =>
									!entry.args.includes("--args") && !entry.args.includes("--allow-file-access"),
							),
						);
						await withPatchedEnv({ AGENT_BROWSER_CDP: undefined }, async () => {
							const resumedEnvHarness = createExtensionHarness({
								branch: envHarness.ctx.sessionManager.getBranch().slice(),
								cwd: tempDir,
								prompt:
									"Resume the environment-attached session without the original environment flag.",
							});
							await runExtensionEvent(
								resumedEnvHarness.handlers,
								"session_start",
								{ reason: "resume" },
								resumedEnvHarness.ctx,
							);
							const resumedEnvSnapshot = await executeRegisteredTool(
								resumedEnvHarness.tool,
								resumedEnvHarness.ctx,
								{ args: ["--session", "env-cdp", "snapshot", "-i"] },
							);
							assert.equal(resumedEnvSnapshot.isError, false);
						});
					});
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension passes through core command coverage fallback matrix",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-core-matrix-"));
		const logPath = join(tempDir, "invocations.log");
		const downloadPath = join(tempDir, "download.txt");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--allow-file-access", "--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const command = args[commandIndex] || "unknown";
const subcommand = args[commandIndex + 1];
const artifactPath = command === "download" || command === "screenshot" || command === "pdf" || (command === "wait" && args.includes("--download")) ? args[args.length - 1] : undefined;
if (artifactPath) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, "artifact");
}
const data = artifactPath ? { path: artifactPath }
  : command === "get" && subcommand === "url" ? { result: "https://example.test/current", url: "https://example.test/current" }
  : command === "get" && subcommand === "title" ? { result: "Example", title: "Example" }
  : { ok: true, command };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		const commands = [
			["open", "https://example.test"],
			["goto", "https://example.test/next"],
			["navigate", "https://example.test/again"],
			["back"],
			["forward"],
			["reload"],
			["click", "#button", "--new-tab"],
			["dblclick", "#button"],
			["fill", "#name", "Ada"],
			["type", "#name", " Lovelace"],
			["press", "Enter"],
			["key", "Escape"],
			["keydown", "Shift"],
			["keyup", "Shift"],
			["keyboard", "type", "hello"],
			["keyboard", "inserttext", "raw text"],
			["hover", "#button"],
			["focus", "#name"],
			["check", "#agree"],
			["uncheck", "#agree"],
			["select", "#flavor", "vanilla"],
			["drag", "#source", "#target"],
			["upload", "#file", join(tempDir, "upload.txt")],
			["scroll", "down", "250", "--selector", "#panel"],
			["scrollintoview", "#target"],
			["scrollinto", "#target"],
			["wait", "#ready"],
			["wait", "--url", "**/ready"],
			["wait", "--load", "networkidle"],
			["wait", "--fn", "window.ready === true"],
			["wait", "--text", "Ready"],
			["wait", "--download", downloadPath],
			["screenshot", join(tempDir, "screen.png")],
			["pdf", join(tempDir, "page.pdf")],
			["snapshot", "--compact", "--depth", "3", "--urls"],
			["snapshot", "--interactive", "--selector", "main", "--cursor"],
			["eval", "document.title"],
			["eval", "-b", "ZG9jdW1lbnQudGl0bGU="],
			["--session", "connector", "connect", "9222"],
			["get", "url"],
			["get", "cdp-url"],
			["get", "box", "#button"],
			["get", "styles", "#button"],
			["is", "visible", "#button"],
			["find", "role", "button", "click", "--name", "Submit"],
			["find", "first", ".item", "click"],
			["find", "last", ".item", "hover"],
			["find", "nth", "2", ".card", "click", "--exact"],
			["mouse", "move", "10", "20"],
			["mouse", "wheel", "100"],
			["set", "media", "dark", "reduced-motion"],
			["tap", "#button"],
			["swipe", "up", "200"],
			["pushstate", "/spa/route"],
			["removeinitscript", "init-1"],
			["download", "#direct-download", downloadPath],
			["tab", "new"],
			["tab", "t1"],
			["tab", "close"],
			["close"],
			["open", "https://example.test/reopened"],
			["quit"],
			["open", "https://example.test/reopened-again"],
			["exit"],
		] as const;

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Exercise core browser commands.",
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				for (const args of commands) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...args],
					});
					// Every row in the fixed nonempty core-command sequence checks dispatch success.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(result.details);
					// Every row in the fixed nonempty core-command sequence checks dispatch success.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						result.isError,
						false,
						`${args.join(" ")}: ${result.content[0]?.type === "text" ? readString(result.content[0].text) : ""}`,
					);
					if (args[0] === "get" && args.at(1) === "url") {
						// The literal get-url row runs these payload checks; every command also checks success.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.deepEqual(result.details.args, ["get", "url"]);
						// The literal get-url row runs these payload checks; every command also checks success.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(result.details.data).url, "https://example.test/current");
					}
				}

				const invocations = await readInvocationLog(logPath);
				const commandInvocations = invocations
					.map((entry) => stripWrapperPrefix(entry.args))
					.filter((args) => !(args.length === 2 && args[0] === "eval" && args[1] === "--stdin"));
				// The navigation-summary helper reuses an already-observed title for ordinary same-URL probes. Tab
				// creation, selection and close always verify the active target title because same-URL tabs can have different titles.
				let navigationSummaryTitleObserved = false;
				const expectedInvocations = commands.flatMap((args) => {
					const normalizedArgs = stripWrapperPrefix(args);
					const command = normalizedArgs[0];
					const tabAction =
						command === "tab" &&
						normalizedArgs.at(1) !== undefined &&
						normalizedArgs.at(1) !== "list";
					const probesSummary =
						command === "click" ||
						tabAction ||
						command === "back" ||
						command === "forward" ||
						command === "reload" ||
						command === "dblclick" ||
						command === "eval";
					const pageCheck = needsRootSessionPageCheck(normalizedArgs) ? [["get", "url"]] : [];
					if (!probesSummary) {
						return command === "get" && normalizedArgs[1] === "url"
							? [normalizedArgs, ["tab", "list"]]
							: pageCheck.concat([normalizedArgs]);
					}
					const titleProbe = !navigationSummaryTitleObserved || tabAction;
					navigationSummaryTitleObserved = true;
					return titleProbe
						? pageCheck.concat([normalizedArgs, ["get", "url"], ["get", "title"], ["tab", "list"]])
						: pageCheck.concat([normalizedArgs, ["get", "url"], ["tab", "list"]]);
				});
				// Exact argv and order including the root-session `get url` page checks: a missing or
				// spurious URL probe fails here instead of being filtered away.
				assert.deepEqual(commandInvocations, expectedInvocations);
				assert.ok(
					invocations.every(
						(entry) => entry.args[0] === "--json" && entry.args.includes("--session"),
					),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension passes through stateful browser-context workflow commands",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stateful-matrix-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "state.json");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--allow-file-access", "--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
if (command === "state" && subcommand === "save") fs.writeFileSync(args[commandIndex + 2], "{}");
const data = command === "get" && subcommand === "url" ? { result: "https://example.test/current", url: "https://example.test/current" }
  : command === "auth" && subcommand === "list" ? { profiles: [{ name: "demo" }] }
  : command === "auth" && subcommand === "show" ? { name: "demo", url: "https://example.test", username: "user@example.test" }
  : command === "cookies" && (subcommand === undefined || subcommand === "get") ? { cookies: [{ name: "sid", domain: "example.test", path: "/", value: "cookie-get-secret" }] }
  : command === "cookies" && subcommand === "set" ? { name: args[commandIndex + 2], value: args[commandIndex + 3], domain: "example.test" }
  : command === "storage" ? { type: args[commandIndex + 1], entries: [{ key: args[commandIndex + 3] || "theme", value: args[commandIndex + 4] || "storage-secret" }] }
  : command === "dialog" ? { open: subcommand === "status", accepted: subcommand === "accept", dismissed: subcommand === "dismiss" }
  : command === "frame" ? { frame: subcommand }
  : command === "state" && subcommand === "list" ? { states: [{ name: "state.json" }] }
  : command === "state" ? { path: args[commandIndex + 2], loaded: subcommand === "load" }
  : { ok: true, command, subcommand };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		const commands = [
			["auth", "save", "demo", "--url", "https://example.test", "--username", "user@example.test"],
			["auth", "login", "demo"],
			["auth", "list"],
			["auth", "show", "demo"],
			["auth", "delete", "demo"],
			["auth", "remove", "demo"],
			["state", "save", statePath],
			["state", "load", statePath],
			["get", "url"],
			["state", "list"],
			["state", "clear", "caller-owned"],
			["cookies", "get"],
			["cookies", "set", "sid", "cookie-secret", "--url", "https://example.test"],
			["cookies", "clear"],
			["storage", "local", "set", "theme", "dark"],
			["storage", "session", "get", "theme"],
			["storage", "local", "clear"],
			["dialog", "status"],
			["dialog", "accept", "prompt text"],
			["dialog", "dismiss"],
			["frame", "#child-frame"],
			["frame", "main"],
			["confirm", "c_demo"],
			["deny", "c_demo"],
		] as const;

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Exercise stateful browser workflows.",
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				let storageSetResult: Awaited<ReturnType<typeof executeRegisteredTool>> | undefined;
				for (const args of commands) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [...args],
					});
					// Every row in the fixed nonempty stateful sequence checks success and secret redaction.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(result.details);
					// Every row in the fixed nonempty stateful sequence checks success and secret redaction.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						result.isError,
						false,
						`${args.join(" ")}: ${readString(readRecord(result.content[0]).text)}`,
					);
					// Every row in the fixed nonempty stateful sequence checks success and secret redaction.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.doesNotMatch(
						readString(readRecord(result.content[0]).text),
						/cookie-secret|cookie-get-secret|storage-secret/,
					);
					// Every row in the fixed nonempty stateful sequence checks success and secret redaction.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.doesNotMatch(
						JSON.stringify(result.details),
						/cookie-secret|cookie-get-secret|storage-secret/,
					);
					if (args[0] === "storage" && args[1] === "local" && args[2] === "set") {
						storageSetResult = result;
					}
					if (args[0] === "get" && args.at(1) === "url") {
						// The literal get-url row checks routing/payload; every stateful row also checks success.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.deepEqual(result.details.args, ["get", "url"]);
						// The literal get-url row checks routing/payload; every stateful row also checks success.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(result.details.data).url, "https://example.test/current");
					}
				}
				assert.match(readString(readRecord(storageSetResult?.content[0]).text), /theme: dark/);
				assert.match(JSON.stringify(storageSetResult?.details), /"value":"dark"/);

				const jsonResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [
						"--json",
						"cookies",
						"set",
						"sid",
						"json-cookie-secret",
						"--url",
						"https://example.test",
					],
				});
				assert.equal(jsonResult.isError, false);
				const textItems = jsonResult.content.filter((item) => item.type === "text");
				assert.ok(textItems.length > 0, "JSON cookie result must expose visible text");
				for (const item of textItems) {
					// The asserted nonempty text-result set checks every visible item for the cookie secret.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.doesNotMatch(item.text, /json-cookie-secret/);
				}

				const invocations = await readInvocationLog(logPath);
				const isSessionlessAuthRow = (args: readonly string[]) =>
					args[0] === "auth" &&
					["save", "list", "show", "delete", "remove"].includes(args[1] ?? "");
				const isSessionlessStateRow = (args: readonly string[]) =>
					args[0] === "state" &&
					(args[1] === "list" || (args[1] === "clear" && args[2] === "caller-owned"));
				// Exact argv and order including the root-session `get url` page checks and the explicit
				// --json follow-up; sessionless auth/state rows and page-transition/dialog/get-url rows stay
				// unprobed, so a missing or spurious URL probe fails here instead of being filtered away.
				assert.deepEqual(
					invocations.map((entry) => stripWrapperPrefix(entry.args)),
					[
						...commands.flatMap((args): string[][] => {
							const normalizedArgs = args.slice();
							const pageCheck =
								!isSessionlessAuthRow(normalizedArgs) &&
								!isSessionlessStateRow(normalizedArgs) &&
								needsRootSessionPageCheck(normalizedArgs)
									? [["get", "url"]]
									: [];
							return normalizedArgs[0] === "get" && normalizedArgs[1] === "url"
								? [normalizedArgs, ["tab", "list"]]
								: pageCheck.concat([normalizedArgs]);
						}),
						["get", "url"],
						[
							"--json",
							"cookies",
							"set",
							"sid",
							"json-cookie-secret",
							"--url",
							"https://example.test",
						],
					],
				);
				assert.ok(invocations.every((entry) => entry.args.includes("--json")));
				assert.ok(
					invocations.every((entry) => {
						const userArgs = stripWrapperPrefix(entry.args);
						return isSessionlessAuthRow(userArgs) || isSessionlessStateRow(userArgs)
							? !entry.args.includes("--session")
							: entry.args.includes("--session");
					}),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension passes through non-core network debug diff stream dashboard and chat families",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-non-core-matrix-"));
		const logPath = join(tempDir, "invocations.log");
		const harPath = join(tempDir, "network.har");
		const tracePath = join(tempDir, "trace.zip");
		const profilePath = join(tempDir, "profile.cpuprofile");
		const recordingPath = join(tempDir, "recording.webm");
		const diffPath = join(tempDir, "diff.png");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, model: process.env.AI_GATEWAY_MODEL || null, apiKey: process.env.AI_GATEWAY_API_KEY || null }) + "\\n");
const valueFlags = new Set(["--allow-file-access", "--session", "--model", "--port", "--body", "--resource-type", "--baseline"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
function ensureFile(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
let data = { ok: true, command, subcommand };
if (command === "network" && subcommand === "route") data = { routed: args[commandIndex + 2] };
if (command === "network" && subcommand === "unroute") data = { unrouted: args[commandIndex + 2] || "all" };
if (command === "network" && subcommand === "requests") data = { requests: [{ method: "GET", requestId: "n1", status: 200, url: "https://example.test/app.js" }] };
if (command === "network" && subcommand === "request") data = { requestId: args[commandIndex + 2], status: 200, url: "https://example.test/app.js", responseBody: "ok" };
if (command === "network" && subcommand === "har") {
  const action = args[commandIndex + 2];
  data = action === "stop" ? { path: args[commandIndex + 3] || ${JSON.stringify(harPath)}, requestCount: 1, state: "stopped" } : { state: "started" };
  if (data.path) ensureFile(data.path, "{}");
}
if (command === "diff" && subcommand === "snapshot") data = { added: 1, removed: 0 };
if (command === "diff" && subcommand === "screenshot") { data = { diffPath: ${JSON.stringify(diffPath)}, mismatchPixels: 0 }; ensureFile(data.diffPath, "fake-png"); }
if (command === "diff" && subcommand === "url") data = { differenceCount: 0 };
if (command === "get" && subcommand === "url") data = { url: "https://example.test/b" };
if (command === "get" && subcommand === "title") data = { title: "Example B" };
if (command === "trace") { data = subcommand === "stop" ? { path: args[commandIndex + 2] || ${JSON.stringify(tracePath)}, state: "stopped" } : { state: "started" }; if (data.path) ensureFile(data.path, "trace"); }
if (command === "profiler") { data = subcommand === "stop" ? { path: args[commandIndex + 2] || ${JSON.stringify(profilePath)}, state: "stopped" } : { state: "started" }; if (data.path) ensureFile(data.path, "profile"); }
if (command === "record") { data = subcommand === "start" ? { path: args[commandIndex + 2] || ${JSON.stringify(recordingPath)} } : { path: ${JSON.stringify(recordingPath)} }; if (subcommand === "stop") ensureFile(data.path, "video"); }
if (command === "console") data = { messages: [{ text: "hello", type: "log" }] };
if (command === "a11y") data = { axeVersion: "4.12.1", counts: { violations: 1, incomplete: 0, passes: 2, inapplicable: 0 }, violations: [{ id: "image-alt", impact: "critical", help: "Images must have alternative text", nodeCount: 1, nodes: [{ target: ["img"], html: "<img>" }] }], incomplete: [] };
if (command === "errors") data = { errors: [{ text: "boom", url: "https://example.test/app.js", line: 1 }] };
if (command === "highlight") data = { highlighted: subcommand };
if (command === "inspect") data = { opened: true };
if (command === "clipboard") data = { text: subcommand === "read" ? "clipboard text" : "written" };
if (command === "stream") data = { connected: subcommand === "enable" || subcommand === "status", enabled: subcommand !== "disable", port: 7777, screencasting: subcommand === "enable" };
if (command === "react") data = { ok: true, subcommand, components: [] };
if (command === "vitals" || command === "web-vitals") data = { lcp: 123, cls: 0, command };
if (command === "dashboard") data = subcommand === "stop" ? { stopped: true } : { pid: 123, port: 4848 };
if (command === "chat") data = { response: "chat done", model: args[args.indexOf("--model") + 1] || process.env.AI_GATEWAY_MODEL || "default" };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		const commands = [
			[
				"network",
				"route",
				"**/api",
				"--body",
				'{"token":"route-secret"}',
				"--resource-type",
				"fetch",
			],
			["network", "unroute", "**/api"],
			["network", "requests", "--filter", "example"],
			["network", "request", "n1"],
			["network", "har", "start"],
			["network", "har", "start", "--content", "all"],
			["network", "har", "stop", harPath],
			["diff", "snapshot"],
			["diff", "screenshot", "--baseline", join(tempDir, "baseline.png")],
			["diff", "url", "https://example.test/a", "https://example.test/b"],
			["trace", "start"],
			["trace", "stop", tracePath],
			["profiler", "start"],
			["profiler", "stop", profilePath],
			["record", "start", recordingPath],
			["record", "stop"],
			["console"],
			["console", "--clear"],
			["a11y"],
			["a11y", "--tags", "wcag2a,wcag2aa"],
			["a11y", "--selector", "#main"],
			["errors"],
			["errors", "--clear"],
			["highlight", "#target"],
			["inspect"],
			["clipboard", "write", "Authorization: Bearer clipboard-secret"],
			["clipboard", "read"],
			["clipboard", "copy"],
			["clipboard", "paste"],
			["stream", "enable", "--port", "7777"],
			["stream", "status", "--json"],
			["stream", "disable"],
			["react", "tree"],
			["react", "inspect", "fiber-1"],
			["react", "renders", "start"],
			["react", "renders", "stop", "--json"],
			["react", "suspense", "--only-dynamic", "--json"],
			["vitals", "https://example.test", "--json"],
			["web-vitals", "https://example.test", "--json"],
			["--model", "anthropic/model-flag", "dashboard", "start", "--port", "4848"],
			["dashboard", "stop"],
			["chat", "Summarize Authorization: Bearer chat-secret", "--model", "anthropic/chat-flag"],
		] as const;

		try {
			await withPatchedEnv(
				{
					AI_GATEWAY_API_KEY: "ai-gateway-key",
					AI_GATEWAY_MODEL: "anthropic/env-model",
					PATH: `${tempDir}:${basePath}`,
				},
				async () => {
					const harness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Exercise non-core browser workflows.",
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					let networkRequestsResult: Awaited<ReturnType<typeof executeRegisteredTool>> | undefined;
					let streamStatusResult: Awaited<ReturnType<typeof executeRegisteredTool>> | undefined;
					for (const args of commands) {
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						const result = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: [...args],
						});
						// Every command in the fixed nonempty non-core sequence checks success and secret redaction.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(result.details);
						// Every command in the fixed nonempty non-core sequence checks success and secret redaction.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							result.isError,
							false,
							`${args.join(" ")}: ${result.content[0]?.type === "text" ? readString(result.content[0].text) : ""}`,
						);
						// Every command in the fixed nonempty non-core sequence checks success and secret redaction.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.doesNotMatch(
							result.content[0]?.text ?? "",
							/route-secret|clipboard-secret|chat-secret/,
						);
						// Every command in the fixed nonempty non-core sequence checks success and secret redaction.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.doesNotMatch(
							JSON.stringify(result.details),
							/route-secret|clipboard-secret|chat-secret/,
						);
						if (args[0] === "network" && args[1] === "requests") {
							networkRequestsResult = result;
						}
						if (args[0] === "stream" && args[1] === "status") {
							streamStatusResult = result;
						}
					}
					assert.ok(streamStatusResult);
					const streamJson = readRecord(
						JSON.parse(
							streamStatusResult.content
								.filter((item) => item.type === "text")
								.map((item) => item.text)
								.join("\n"),
						),
					);
					assert.equal(streamJson.success, true);
					assert.deepEqual(readRecord(streamJson.data), {
						connected: true,
						enabled: true,
						port: 7777,
						screencasting: false,
						wsUrl: "ws://127.0.0.1:7777",
						frameFormat: "JSON messages with base64 JPEG frame data",
					});

					const networkNextActions = readArray(networkRequestsResult?.details?.nextActions).map(
						readRecord,
					);
					assert.deepEqual(
						networkNextActions.map((action) => action.id),
						[
							"inspect-network-request",
							"filter-network-requests-by-path",
							"clear-network-requests-before-repro",
							"start-network-har-capture",
						],
					);
					assert.deepEqual(
						readArray(readRecord(networkNextActions[0].params).args).map(readString).slice(-3),
						["network", "request", "n1"],
					);
					assert.deepEqual(
						readArray(readRecord(networkNextActions[1].params).args).map(readString).slice(-4),
						["network", "requests", "--filter", "/app.js"],
					);
					assert.deepEqual(
						readArray(readRecord(networkNextActions[2].params).args).map(readString).slice(-3),
						["network", "requests", "--clear"],
					);

					const invocations = await readInvocationLog(logPath);
					const userInvocations = invocations.map((entry) => stripWrapperPrefix(entry.args));
					// Exact argv and order including the root-session `get url` page checks; diff url is a page
					// transition that re-verifies the new target afterwards, so a missing or spurious URL probe
					// fails here instead of being filtered away.
					assert.deepEqual(
						userInvocations,
						commands.flatMap((args): string[][] => {
							const normalizedArgs = stripWrapperPrefix(args);
							if (normalizedArgs[0] === "diff" && normalizedArgs[1] === "url") {
								return [normalizedArgs, ["get", "url"], ["get", "title"], ["tab", "list"]];
							}
							const command =
								normalizedArgs[0] === "--model" ? normalizedArgs[2] : normalizedArgs[0];
							const pageCheck =
								command !== "dashboard" && needsRootSessionPageCheck(normalizedArgs)
									? [["get", "url"]]
									: [];
							return pageCheck.concat([normalizedArgs]);
						}),
					);
					assert.ok(invocations.every((entry) => entry.args.includes("--json")));
					assert.ok(
						invocations.every((entry) => {
							const userArgs = stripWrapperPrefix(entry.args);
							const commandIndex = userArgs.findIndex((arg, index) => {
								if (arg.startsWith("--")) {
									return false;
								}
								return userArgs[index - 1] !== "--model" && userArgs[index - 1] !== "--port";
							});
							const command = userArgs[commandIndex];
							return command === "dashboard"
								? !entry.args.includes("--session")
								: entry.args.includes("--session");
						}),
					);
					assert.ok(
						invocations.some(
							(entry) =>
								entry.args.includes("chat") &&
								entry.args.includes("--model") &&
								entry.model === "anthropic/env-model",
						),
					);
					assert.ok(
						invocations.some(
							(entry) => entry.args.includes("dashboard") && entry.apiKey === "ai-gateway-key",
						),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension treats stream enable already-enabled as idempotent no-op",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stream-idempotent-"));
		const replyPath = join(tempDir, "reply.txt");
		await writeFile(replyPath, "Streaming is already enabled for this session");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
process.stdout.write(JSON.stringify({ success: false, error: fs.readFileSync(${JSON.stringify(replyPath)}, "utf8") }));`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir, prompt: "Enable stream." });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["stream", "enable"],
					});
					assert.ok(result.details);
					assert.equal(result.isError, false);
					assert.equal(result.details.resultCategory, "success");
					assert.equal(result.details.successCategory, "completed");
					assert.equal(readRecord(result.details.data).alreadyEnabled, true);
					assert.match(result.content[0]?.text ?? "", /idempotent no-op/);
					assert.deepEqual(
						readArray(result.details.nextActions)
							.map(readRecord)
							.map((action) => action.id),
						["check-stream-status-after-noop", "disable-existing-stream-when-done"],
					);
					await writeFile(replyPath, "Streaming is already enabled but health check failed");
					const failed = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["stream", "enable"],
					});
					assert.ok(failed.details);
					assert.equal(failed.isError, true);
					assert.equal(failed.details.failureCategory, "upstream-error");
					assert.match(failed.content[0]?.text ?? "", /health check failed/);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports unfulfilled routed network mocks",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-route-diagnostics-"));
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const args = process.argv.slice(2);
const commandIndex = args.findIndex((arg, index) => arg === "network" && args[index + 1]);
const subcommand = args[commandIndex + 1];
const data = subcommand === "route"
  ? { routed: args[commandIndex + 2] }
  : { requests: [{ method: "GET", requestId: "mock-1", resourceType: "fetch", status: 404, url: "https://example.test/api/mock" }] };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://example.test/" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir, prompt: "Mock network route." });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const routeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["network", "route", "**/api/**", "--body", "{}", "--resource-type", "fetch"],
					});
					assert.equal(routeResult.isError, false);

					const requestsResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["network", "requests"],
					});
					assert.ok(requestsResult.details);
					assert.equal(requestsResult.isError, false);
					assert.match(requestsResult.content[0]?.text ?? "", /Network route diagnostics/);
					assert.deepEqual(
						readArray(requestsResult.details.networkRouteDiagnostics)
							.map(readRecord)
							.map((item) => item.reason),
						["unfulfilled-routed-request"],
					);
					assert.deepEqual(
						readArray(requestsResult.details.nextActions)
							.map(readRecord)
							.slice(0, 2)
							.map((action) => action.id),
						["inspect-routed-network-request", "start-network-har-capture-for-route-mock"],
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports routed network mocks inside and after batch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-route-diagnostics-"));
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", () => {
  const commandIndex = args.findIndex((arg) => arg === "batch" || arg === "network");
  const command = args[commandIndex];
  if (command === "batch") {
    const steps = JSON.parse(stdin);
    const data = steps.map((step) => step[0] === "network" && step[1] === "route"
      ? { command: step, success: true, result: { routed: step[2] } }
      : { command: step, success: true, result: { requests: [{ method: "GET", requestId: "batch-mock-1", resourceType: "fetch", url: "https://example.test/api/batch" }] } });
    process.stdout.write(JSON.stringify({ success: true, data }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { requests: [{ method: "GET", requestId: "later-mock-1", resourceType: "fetch", url: "https://example.test/api/batch" }] } }));
});`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://example.test/" },
				async () => {
					const harness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Mock network route in a batch.",
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([
							["network", "route", "**/api/**", "--body", "{}"],
							["network", "requests"],
						]),
					});
					assert.ok(batchResult.details);
					assert.equal(batchResult.isError, false);
					const batchSteps = readArray(batchResult.details.batchSteps).map(readRecord);
					assert.deepEqual(
						readArray(batchSteps[1].networkRouteDiagnostics)
							.map(readRecord)
							.map((item) => item.reason),
						["pending-routed-request"],
					);

					const requestsResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["network", "requests"],
					});
					assert.ok(requestsResult.details);
					assert.equal(requestsResult.isError, false);
					assert.deepEqual(
						readArray(requestsResult.details.networkRouteDiagnostics)
							.map(readRecord)
							.map((item) => item.reason),
						["pending-routed-request"],
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension normalizes and repairs explicit screenshot artifact paths",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-screenshot-path-"));
		const logPath = join(tempDir, "invocations.log");
		const upstreamTempPath = join(tempDir, "upstream-temp.png");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://safe.example/" } }));
} else {
  const commandIndex = args.indexOf("screenshot");
  const requestedPath = args[commandIndex + 1];
  fs.mkdirSync(path.dirname(${JSON.stringify(upstreamTempPath)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(upstreamTempPath)}, "fake-png");
  process.stdout.write(JSON.stringify({ success: true, data: { path: ${JSON.stringify(upstreamTempPath)} }, error: null }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir, prompt: "Take a screenshot." });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "warden-vfr", "screenshot", ".dogfood/run/foo.png"],
				});
				assert.ok(result.details);

				const expectedPath = join(tempDir, ".dogfood/run/foo.png");
				assert.equal(result.isError, false);
				assert.equal(await readFile(expectedPath, "utf8"), "fake-png");
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				assert.match(text, /Saved image: \.dogfood\/run\/foo\.png/);
				assert.match(text, /Artifact type: image/);
				assert.match(text, /Requested path: \.dogfood\/run\/foo\.png/);
				assert.match(
					text,
					new RegExp(`Absolute path: ${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
				);
				assert.match(text, /Exists: true/);
				assert.match(text, /Status: repaired-from-temp/);
				assert.match(
					text,
					new RegExp(`Reported path: ${upstreamTempPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
				);
				assert.match(text, /Session: warden-vfr/);
				assert.match(text, new RegExp(`CWD: ${tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

				const artifacts = readArray(result.details.artifacts).map(readRecord);
				assert.equal(artifacts[0].requestedPath, ".dogfood/run/foo.png");
				assert.equal(artifacts[0].absolutePath, expectedPath);
				assert.equal(artifacts[0].cwd, tempDir);
				assert.equal(artifacts[0].session, "warden-vfr");
				assert.equal(artifacts[0].status, "repaired-from-temp");
				assert.equal(artifacts[0].tempPath, upstreamTempPath);

				const invocations = await readInvocationLog(logPath);
				assert.deepEqual(invocations[0]?.args.at(-2), "get");
				assert.equal(
					invocations.find((entry) => entry.args.includes("screenshot"))?.args.at(-1),
					expectedPath,
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension creates parent directories for state save artifacts",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-state-save-path-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const path = args[args.length - 1];
fs.writeFileSync(path, JSON.stringify({ ok: true }));
process.stdout.write(JSON.stringify({ success: true, data: { path } }));`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir, prompt: "Save browser state." });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const statePath = join(tempDir, "missing", "parents", "fixture-state.json");
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["state", "save", statePath],
					});
					assert.ok(result.details);

					assert.equal(result.isError, false, JSON.stringify(result));
					assert.equal(await readFile(statePath, "utf8"), JSON.stringify({ ok: true }));
					const [invocation] = await readInvocationLog(logPath);
					assert.equal(invocation.args.at(-1), statePath);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("agentBrowserExtension blocks per-step batch screenshot annotation foot-guns", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "piab-batch-annotation-"));
	t.after(async () => await rm(tempDir, { force: true, recursive: true }));
	const harness = createExtensionHarness({
		cwd: tempDir,
		prompt: "Take annotated screenshots.",
	});
	const result = await executeRegisteredTool(harness.tool, harness.ctx, {
		args: ["batch"],
		stdin: JSON.stringify([["screenshot", "--annotate", join(tempDir, "foo.png")]]),
	});
	assert.ok(result.details);

	assert.equal(result.isError, true);
	assert.match(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		/put --annotate in top-level args/i,
	);
});

test(
	"agentBrowserExtension normalizes and repairs batch screenshot artifact paths",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-screenshot-path-"));
		const logPath = join(tempDir, "invocations.log");
		const upstreamTempPath = join(tempDir, "upstream-batch-temp.png");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  fs.mkdirSync(path.dirname(${JSON.stringify(upstreamTempPath)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(upstreamTempPath)}, "fake-batch-png");
  process.stdout.write(JSON.stringify([{ command: ["screenshot", ".dogfood/run/good-batch.png"], success: true, error: null, result: { path: ${JSON.stringify(upstreamTempPath)} } }]));
});`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({
						cwd: tempDir,
						prompt: "Take a batch screenshot.",
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--annotate", "batch"],
						stdin: '[["screenshot",".dogfood/run/good-batch.png"]]',
					});
					assert.ok(result.details);

					const expectedPath = join(tempDir, ".dogfood/run/good-batch.png");
					assert.equal(result.isError, false);
					assert.equal(await readFile(expectedPath, "utf8"), "fake-batch-png");
					const text = result.content[0]?.type === "text" ? result.content[0].text : "";
					assert.match(text, /Step 1 — screenshot/);
					assert.match(text, /Saved image: \.dogfood\/run\/good-batch\.png/);
					assert.match(text, /Requested path: \.dogfood\/run\/good-batch\.png/);
					assert.match(text, /Status: repaired-from-temp/);
					assert.match(
						text,
						new RegExp(`Reported path: ${upstreamTempPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
					);

					const artifacts = readArray(result.details.artifacts).map(readRecord);
					assert.equal(artifacts[0].requestedPath, ".dogfood/run/good-batch.png");
					assert.equal(artifacts[0].absolutePath, expectedPath);
					assert.equal(artifacts[0].status, "repaired-from-temp");
					assert.equal(artifacts[0].tempPath, upstreamTempPath);

					const [invocation] = await readInvocationLog(logPath);
					assert.deepEqual(readArray(JSON.parse(readString(invocation.stdin))), [
						["screenshot", expectedPath],
					]);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension guards wrapper-known trace and profiler ownership",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-trace-owner-"));
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("batch")) {
  const steps = JSON.parse(fs.readFileSync(0, "utf8") || "[]");
  process.stdout.write(JSON.stringify({ success: true, data: steps.map((step) => ({
    command: step,
    success: true,
    result: { lifecycle: { effectiveLaunch: { browserLaunched: step[0] !== "close" } } }
  })) }));
} else {
  const data = args.includes("get") && args.includes("url") ? { url: "https://safe.example/" } : { started: true };
  process.stdout.write(JSON.stringify({ success: true, data, error: null }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir, prompt: "Capture a trace." });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const traceStart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "trace", "start"],
				});
				assert.equal(traceStart.isError, false);

				const profilerStart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "profiler", "start"],
				});
				assert.equal(profilerStart.isError, true);
				assert.match(
					profilerStart.content[0]?.type === "text" ? profilerStart.content[0].text : "",
					/Wrapper believes trace tracing is active/,
				);

				const directClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "close"],
				});
				assert.equal(directClose.isError, false);
				const profilerAfterClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "profiler", "start"],
				});
				assert.equal(profilerAfterClose.isError, false);
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "close"],
				});
				const traceBeforeBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "trace", "start"],
				});
				assert.equal(traceBeforeBatchClose.isError, false);
				const closeThenRelaunch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "batch"],
					stdin: JSON.stringify([["close"], ["open", "https://safe.example/"]]),
				});
				assert.ok(closeThenRelaunch.details);
				assert.equal(closeThenRelaunch.isError, false);
				const verifiedAfterBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "get", "url"],
				});
				assert.equal(verifiedAfterBatchClose.isError, false);
				const profilerAfterBatchClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "debug-session", "profiler", "start"],
				});
				assert.ok(profilerAfterBatchClose.details);
				assert.equal(
					profilerAfterBatchClose.isError,
					false,
					JSON.stringify({
						closeThenRelaunch: closeThenRelaunch.details,
						profilerAfterBatchClose: profilerAfterBatchClose.details,
					}),
				);

				const otherNamespaceTrace = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "other", "--session", "other-a", "trace", "start"],
				});
				assert.equal(otherNamespaceTrace.isError, false);
				const traceA = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "all-a", "trace", "start"],
				});
				const profilerB = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "all-b", "profiler", "start"],
				});
				assert.equal(traceA.isError, false);
				assert.equal(profilerB.isError, false);
				const closeAll = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["close", "--all"],
				});
				assert.ok(closeAll.details);
				assert.equal(closeAll.isError, false);
				assert.equal(closeAll.details.closeAllApplied, true);
				const profilerAAfterCloseAll = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "all-a", "profiler", "start"],
				});
				assert.equal(profilerAAfterCloseAll.isError, false);
				const profilerOtherAfterCloseAll = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "other", "--session", "other-a", "profiler", "start"],
				});
				assert.equal(profilerOtherAfterCloseAll.isError, true);
				assert.match(
					profilerOtherAfterCloseAll.content[0]?.type === "text"
						? profilerOtherAfterCloseAll.content[0].text
						: "",
					/Wrapper believes trace tracing is active/,
				);
				await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--namespace", "other", "--session", "other-a", "close"],
				});
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
