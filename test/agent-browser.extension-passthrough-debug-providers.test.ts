import assert from "node:assert/strict";
import { readArray, readRecord, readString } from "./helpers/assertions.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
