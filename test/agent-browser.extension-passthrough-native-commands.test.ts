import assert from "node:assert/strict";
import { readRecord, readString } from "./helpers/assertions.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { stripWrapperPrefix, needsRootSessionPageCheck } from "./helpers/passthrough-fixture.js";

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
