/**
 * Purpose: Verify extension entrypoint metadata, diagnostics, TUI rendering, and bash-blocking contracts.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { Theme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";

import {
	WEB_SEARCH_PROMPT_GUIDELINE,
	QUICK_START_GUIDELINES,
	RUNTIME_PROMPT_GUIDELINES,
	buildInstalledDocsGuideline,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	TOOL_PROMPT_GUIDELINES_PREFIX,
	TOOL_PROMPT_GUIDELINES_SUFFIX,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
} from "../extensions/agent-browser/lib/playbook.js";
import {
	discoverElectronApps,
	ELECTRON_DISCOVERY_MAX_RESULTS,
	type ElectronAppDiscovery,
} from "../extensions/agent-browser/lib/electron/discovery.js";
import {
	cleanupElectronLaunchResources,
} from "../extensions/agent-browser/lib/electron/cleanup.js";
import {
	cleanupSecureTempArtifacts,
	createSecureTempDirectory,
} from "../extensions/agent-browser/lib/temp.js";
import {
	TEST_SESSION_ID,
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	runExtensionEventResults,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
	type AgentBrowserToolParams,
	type AgentBrowserToolRenderContext,
} from "./helpers/agent-browser-harness.js";

import {
	PLAIN_RENDER_THEME,
	createRenderContext,
	electronAppNames,
	fakeAgentBrowserLifecycleScript,
	isTestPidAlive,
	readOptionalFakeElectronLaunchLog,
	stopTestPid,
	waitForTestPidExit,
	writeFakeLaunchableElectronApp,
	writeFakeLinuxElectronBinary,
	writeFakeMacElectronApp,
} from "./helpers/extension-validation-fixtures.js";

test("agentBrowserExtension names its tools in every prompt guideline", () => {
	const harness = createExtensionHarness({ cwd: process.cwd(), prompt: "Inspect a page." });
	assert.ok(harness.tool.promptGuidelines.length > 0);
	for (const guideline of harness.tool.promptGuidelines) {
		assert.match(guideline, /agent_browser/, guideline);
	}
	const webSearchTool = harness.getTool("agent_browser_web_search");
	if (webSearchTool) {
		for (const guideline of webSearchTool.promptGuidelines) {
			assert.match(guideline, /agent_browser_web_search/, guideline);
		}
	}
});

test("agentBrowserExtension keeps concise browser guidance plus installed doc pointers in tool metadata", async () => {
	const isolatedHome = await mkdtemp(join(tmpdir(), "pi-agent-browser-guidance-test-"));
	await withPatchedEnv({ BRAVE_API_KEY: "demo-key", EXA_API_KEY: undefined, HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: process.cwd() });
		assert.deepEqual([...harness.handlers.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start", "session_tree", "tool_call", "tool_result"]);
		assert.equal(harness.tool.name, "agent_browser");
		assert.match(harness.tool.description, /authenticated\/profile-based browser work/);
		assert.match(harness.tool.promptSnippet, /real web workflows/);
		const parameterSchema = harness.tool.parameters as { properties?: { args?: { description?: string } } };
		assert.match(parameterSchema.properties?.args?.description ?? "", /networkSourceLookup, or electron/);

		const docsGuideline = buildInstalledDocsGuideline({
			readmePath: join(process.cwd(), "README.md"),
			commandReferencePath: join(process.cwd(), "docs", "COMMAND_REFERENCE.md"),
			toolContractPath: join(process.cwd(), "docs", "TOOL_CONTRACT.md"),
		});
		const guidelineText = harness.tool.promptGuidelines.join("\n");
		const webSearchTool = harness.getTool("agent_browser_web_search");
		assert.ok(webSearchTool, "web search tool should register from BRAVE_API_KEY");
		assert.equal(webSearchTool.promptGuidelines.includes(WEB_SEARCH_PROMPT_GUIDELINE), true);
		const requiredGuidelines = [
			...TOOL_PROMPT_GUIDELINES_PREFIX,
			docsGuideline,
			...RUNTIME_PROMPT_GUIDELINES,
			TOOL_PROMPT_GUIDELINES_SUFFIX[0],
		];
		for (const guideline of requiredGuidelines) {
			assert.equal(
				harness.tool.promptGuidelines.includes(guideline),
				true,
				`missing concise runtime guideline: ${guideline}`,
			);
		}
		assert.match(guidelineText, /Use agent_browser with one input mode/);
		assert.match(guidelineText, /For agent_browser, use open → snapshot -i/);
		assert.match(guidelineText, /Stop before order\/post\/purchase\/submit/);
		assert.equal(
			RUNTIME_PROMPT_GUIDELINES.some((line) => line.includes("Stop before order/post/purchase/submit")),
			true,
		);
		assert.match(guidelineText, /sessionMode=fresh/);
		assert.match(guidelineText, /exact user paths/);
		assert.match(guidelineText, /requested\/configured profiles only/);
		assert.match(guidelineText, /Batch 3\+ reads/);
		assert.match(guidelineText, /get text\/html\/value\/count <selector>/);
		assert.match(guidelineText, /get attr <selector> <name>/);
		assert.doesNotMatch(guidelineText, /get title\/url\/text\/html\/value\/attr\/count/);
		assert.match(guidelineText, /never pass --json/);
		assert.match(harness.tool.description, /Input choice:/);
		assert.match(guidelineText, /record stop needs ffmpeg/);
		assert.match(guidelineText, /Dashboards: verify scroll/);
		assert.match(guidelineText, /When agent_browser details\.nextActions exists/);
		assert.equal(harness.tool.promptGuidelines.includes(SHARED_BROWSER_PLAYBOOK_GUIDELINES[12]), false);
		assert.equal(harness.tool.promptGuidelines.includes(QUICK_START_GUIDELINES[0]), false);
		assert.equal(
			SHARED_BROWSER_PLAYBOOK_GUIDELINES.some((line) => line.includes("evidence-only screenshots")),
			true,
		);
		const fullPlaybookText = [...QUICK_START_GUIDELINES, ...SHARED_BROWSER_PLAYBOOK_GUIDELINES].join("\n");
		assert.match(fullPlaybookText, /react inspect <fiberId>/);
		assert.doesNotMatch(fullPlaybookText, /react tree\/inspect\/renders\/suspense/);
		assert.match(fullPlaybookText, /network route <url>/);
		assert.match(fullPlaybookText, /diff screenshot --baseline <file>/);
		assert.doesNotMatch(fullPlaybookText, /diff snapshot\/screenshot\/url/);
		assert.match(fullPlaybookText, /clipboard write <text>/);
		assert.doesNotMatch(fullPlaybookText, /clipboard read\/write\/copy\/paste/);
		assert.ok(harness.tool.promptGuidelines.length <= 10, "promptGuidelines should stay bounded");
		const normalizedGuidelineText = guidelineText.split(process.cwd()).join("<cwd>");
		assert.ok(
			normalizedGuidelineText.length < 1_850,
			"promptGuidelines should point to docs instead of carrying the full command reference/playbook",
		);
		assert.equal(
			WRAPPER_TAB_RECOVERY_BEHAVIOR.some((line) => line.includes("target tab or ref snapshot")),
			true,
		);

		const [genericTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
			harness.handlers,
			"before_agent_start",
			{ prompt: "Please review the repository architecture.", systemPrompt: "Base system prompt" },
			harness.ctx,
		);
		assert.equal(genericTurn, undefined);

		const [browserTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
			harness.handlers,
			"before_agent_start",
			{ prompt: "Open https://example.com and take a snapshot.", systemPrompt: "Base system prompt" },
			harness.ctx,
		);
		assert.equal(typeof browserTurn?.systemPrompt, "string");
		assert.equal(browserTurn?.systemPrompt.includes("Base system prompt"), true);
		assert.equal(browserTurn?.systemPrompt.includes("Project rule: when browser automation is needed"), true);
		assert.equal(browserTurn?.systemPrompt.includes("Quick start:"), false);
		assert.equal(browserTurn?.systemPrompt.includes("Browser operating playbook:"), false);
	});
});

test("built extension prompt doc pointers resolve to package-root docs", { skip: !existsSync(resolve("dist/extensions/agent-browser/index.js")) }, async () => {
	const extension = await import(pathToFileURL(resolve("dist/extensions/agent-browser/index.js")).href);
	const tools: Array<{ name: string; promptGuidelines: string[] }> = [];
	const pi = {
		on: (..._args: unknown[]) => undefined,
		registerTool: (tool: { name: string; promptGuidelines?: string[] }) => tools.push({ name: tool.name, promptGuidelines: tool.promptGuidelines ?? [] }),
	};
	(extension.default as (api: typeof pi) => void)(pi);

	const guideline = tools.find((tool) => tool.name === "agent_browser")?.promptGuidelines.find((line) => line.includes("COMMAND_REFERENCE.md"));
	assert.ok(guideline);
	assert.doesNotMatch(guideline, /\/dist\/docs\//);
	for (const docsPath of [resolve("README.md"), resolve("docs/COMMAND_REFERENCE.md"), resolve("docs/TOOL_CONTRACT.md")]) {
		assert.match(guideline, new RegExp(docsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(existsSync(docsPath), true, `missing docs path ${docsPath}`);
	}
});

test("agentBrowserExtension includes configured browser executable guidance", async () => {
	const isolatedHome = await mkdtemp(join(tmpdir(), "pi-agent-browser-executable-guidance-test-"));
	const configPath = join(isolatedHome, ".pi", "config", "pi-agent-browser-native", "config.json");
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, JSON.stringify({
		version: 1,
		browser: {
			executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		},
	}, null, 2), "utf8");
	await withPatchedEnv({ HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
		const harness = createExtensionHarness({ cwd: process.cwd() });
		const guidelineText = harness.tool.promptGuidelines.join("\n");
		assert.match(guidelineText, /browser\.executablePath/);
		assert.match(guidelineText, /--executable-path/);
		assert.match(guidelineText, /profiles command still lists Chrome profiles only/);
	});
});

test("agentBrowserExtension uses project browser launch guidance when project config shadows global", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-project-shadow-guidance-test-"));
	try {
		const cwd = join(root, "repo");
		const isolatedHome = join(root, "home");
		const globalConfigPath = join(isolatedHome, ".pi", "config", "pi-agent-browser-native", "config.json");
		const projectConfigPath = join(cwd, ".pi", "config", "pi-agent-browser-native", "config.json");
		await mkdir(dirname(globalConfigPath), { recursive: true });
		await mkdir(dirname(projectConfigPath), { recursive: true });
		await writeFile(globalConfigPath, JSON.stringify({
			version: 1,
			browser: {
				defaultProfile: { name: "Global Profile", policy: "authenticated-only" },
				executablePath: "/Applications/Global Browser.app/Contents/MacOS/Global Browser",
			},
		}, null, 2), "utf8");
		await writeFile(projectConfigPath, JSON.stringify({
			version: 1,
			browser: {
				defaultProfile: { name: "Project Profile", policy: "authenticated-only" },
				executablePath: "/tmp/project-browser",
			},
		}, null, 2), "utf8");
		const previousCwd = process.cwd();
		process.chdir(cwd);
		try {
			await withPatchedEnv({ HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
				const harness = createExtensionHarness({ cwd });
				const staticGuidelineText = harness.tool.promptGuidelines.join("\n");
				assert.doesNotMatch(staticGuidelineText, /Project Profile/);
				assert.doesNotMatch(staticGuidelineText, /\/tmp\/project-browser/);
				assert.match(staticGuidelineText, /Global Profile/);
				const [browserTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
					harness.handlers,
					"before_agent_start",
					{ prompt: "Open https://example.com in the signed-in browser.", systemPrompt: "Base system prompt" },
					harness.ctx,
				);
				assert.match(browserTurn?.systemPrompt ?? "", /Project Profile/);
				assert.match(browserTurn?.systemPrompt ?? "", /\/tmp\/project-browser/);
			});
		} finally {
			process.chdir(previousCwd);
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("agentBrowserExtension includes project-local browser launch guidance", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-browser-project-guidance-test-"));
	try {
		const cwd = join(root, "repo");
		const isolatedHome = join(root, "home");
		const configPath = join(cwd, ".pi", "config", "pi-agent-browser-native", "config.json");
		await mkdir(dirname(configPath), { recursive: true });
		await mkdir(isolatedHome, { recursive: true });
		await writeFile(configPath, JSON.stringify({
			version: 1,
			browser: {
				defaultProfile: { name: "Project Profile", policy: "authenticated-only" },
				executablePath: "/tmp/project-browser",
			},
		}, null, 2), "utf8");
		const previousCwd = process.cwd();
		process.chdir(cwd);
		try {
			await withPatchedEnv({ HOME: isolatedHome, PI_AGENT_BROWSER_CONFIG: undefined }, async () => {
				const harness = createExtensionHarness({ cwd });
				const guidelineText = harness.tool.promptGuidelines.join("\n");
				assert.doesNotMatch(guidelineText, /Project Profile/);
				assert.doesNotMatch(guidelineText, /\/tmp\/project-browser/);
				const [browserTurn] = await runExtensionEventResults<{ systemPrompt: string }>(
					harness.handlers,
					"before_agent_start",
					{ prompt: "Open https://example.com with the configured browser profile.", systemPrompt: "Base system prompt" },
					harness.ctx,
				);
				assert.match(browserTurn?.systemPrompt ?? "", /Project Profile/);
				assert.match(browserTurn?.systemPrompt ?? "", /\/tmp\/project-browser/);
			});
		} finally {
			process.chdir(previousCwd);
		}
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects unsupported public schema fields", () => {
	const harness = createExtensionHarness({ cwd: process.cwd() });
	const schema = harness.tool.parameters;

	assert.equal(Check(schema, { args: ["open", "https://example.test/"], unknown: true }), false);
	assert.equal(Check(schema, { semanticAction: { action: "click", locator: "role", role: "button", name: "Open", unknown: true } }), false);
	assert.equal(Check(schema, { sourceLookup: { selector: "main", unknown: true } }), false);
	assert.equal(Check(schema, { networkSourceLookup: { url: "https://example.test/api", unknown: true } }), false);
	assert.equal(Check(schema, { job: { steps: [{ action: "open", url: "https://example.test/" }], unknown: true } }), false);
	assert.equal(Check(schema, { job: { steps: [{ action: "open", url: "https://example.test/", unknown: true }] } }), false);

	assert.equal(Check(schema, { args: ["open", "https://example.test/"], outputPath: "logs/page.json", timeoutMs: 35_000 }), true);
	assert.equal(Check(schema, { args: ["open", "https://example.test/"], outputPath: "" }), false);
	assert.equal(Check(schema, { args: ["open", "https://example.test/"], timeoutMs: 0 }), false);
	assert.equal(Check(schema, { semanticAction: { action: "click", locator: "role", role: "button", name: "Open" } }), true);
	assert.equal(Check(schema, { sourceLookup: { selector: "main" } }), true);
	assert.equal(Check(schema, { networkSourceLookup: { namespace: "review", url: "https://example.test/api" } }), true);
	assert.equal(Check(schema, { job: { steps: [{ action: "open", url: "https://example.test/" }] } }), true);
});

test("agentBrowserExtension rejects unsupported extra press/key args before upstream spawn", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-press-validation-"));
	try {
		const harness = createExtensionHarness({ cwd: tempDir });
		await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

		const topLevel = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["press", "@e1", "Enter"] });
		assert.equal(topLevel.isError, true);
		assert.match(topLevel.content[0]?.text ?? "", /accepts exactly one key argument/);
		assert.equal(topLevel.details?.validationError, topLevel.content[0]?.text);

		const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: ["batch"],
			stdin: JSON.stringify([["fill", "#todo", "alpha"], ["key", "#todo", "Return"]]),
		});
		assert.equal(batch.isError, true);
		assert.match(batch.content[0]?.text ?? "", /Unsupported batch step 2: agent-browser key\/press accepts exactly one key argument/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports no-op scroll diagnostics with recovery next actions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-noop-scroll-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "scroll-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device"]);
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
const amount = args[commandIndex + 2];
let state = { moved: false };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "scroll" && amount === "701") {
  state.moved = true;
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
const snapshot = {
  scrollX: 0,
  scrollY: state.moved ? 701 : 0,
  innerHeight: 600,
  innerWidth: 800,
  scrollHeight: 1600,
  scrollWidth: 800,
  containerCount: 1,
  containers: [{ id: "0:main.dashboard", scrollTop: state.moved ? 701 : 0, scrollLeft: 0 }]
};
const data = command === "eval" ? { result: snapshot } : { scrolled: true };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check scroll recovery diagnostics." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const noopResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "down", "700"], sessionMode: "fresh" });
			assert.equal(noopResult.isError, false);
			assert.match(noopResult.content[0]?.text ?? "", /Scroll diagnostic: no observed scroll movement/);
			const noopDetails = noopResult.details as {
				data: { noMovement?: boolean; scrolled?: boolean };
				nextActions: Array<{ id: string; params?: { args: string[] } }>;
				pageChangeSummary: { nextActionIds: string[] };
				scrollNoop: { before: { containers: Array<{ id: string }> }; reason: string };
			};
			assert.equal(noopDetails.data.scrolled, false);
			assert.equal(noopDetails.data.noMovement, true);
			assert.equal(noopDetails.scrollNoop.reason, "no-observed-scroll-position-change");
			assert.equal(noopDetails.scrollNoop.before.containers[0]?.id, "sample-0");
			assert.deepEqual(
				noopDetails.nextActions.map((action) => action.id).filter((id) => id.includes("noop-scroll")),
				["inspect-after-noop-scroll", "verify-noop-scroll-visually"],
			);
			const scrollRecoveryActions = noopDetails.nextActions.filter((action) => action.id.includes("noop-scroll"));
			assert.ok(scrollRecoveryActions.every((action) => action.params?.args[0] === "--session"));
			assert.deepEqual(
				noopDetails.pageChangeSummary.nextActionIds.filter((id) => id.includes("noop-scroll")),
				["inspect-after-noop-scroll", "verify-noop-scroll-visually"],
			);

			const movedResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "down", "701"] });
			assert.equal(movedResult.isError, false);
			const movedDetails = movedResult.details as { scrollNoop?: unknown };
			assert.equal(movedDetails.scrollNoop, undefined);
			assert.doesNotMatch(movedResult.content[0]?.text ?? "", /Scroll diagnostic/);

			const evalCallsBeforeLaunchScopedScroll = (await readInvocationLog(logPath)).filter((entry) => entry.args.includes("eval")).length;
			const launchScopedResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--profile", "Default", "scroll", "down", "700"], sessionMode: "fresh" });
			assert.equal(launchScopedResult.isError, false);
			assert.equal((launchScopedResult.details as { scrollNoop?: unknown }).scrollNoop, undefined);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, evalCallsBeforeLaunchScopedScroll);
			assert.ok(invocations.some((entry) => entry.args.includes("--profile") && entry.args.includes("scroll")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension bounds dialog recovery commands and exposes recovery actions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-dialog-timeout-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
if (args.includes("dialog") || (args.includes("eval") && stdin.includes("confirm"))) {
  setInterval(() => {}, 60_000);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_DIALOG_PROCESS_TIMEOUT_MS: "50", PI_AGENT_BROWSER_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS: "60" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["dialog", "status"] });
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "timeout");
			assert.equal(result.details?.timeoutMs, 50);
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[]; sessionMode?: string } }> | undefined;
			assert.ok(nextActions?.some((action) => action.id === "inspect-dialog-after-timeout"));
			assert.ok(nextActions?.some((action) => action.id === "dismiss-dialog-after-timeout"));
			assert.ok(nextActions?.some((action) => action.id === "recover-fresh-session-after-dialog-timeout" && action.params?.sessionMode === "fresh"));

			const explicitTimeoutResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["dialog", "status"], timeoutMs: 75 });
			assert.equal(explicitTimeoutResult.isError, true);
			assert.equal(explicitTimeoutResult.details?.timeoutMs, 75);

			const evalResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["eval", "--stdin"], stdin: "confirm('Continue?')" });
			assert.equal(evalResult.isError, true);
			assert.equal(evalResult.details?.failureCategory, "timeout");
			assert.equal(evalResult.details?.timeoutMs, 60);
			const evalNextActions = evalResult.details?.nextActions as Array<{ id?: string }> | undefined;
			assert.ok(evalNextActions?.some((action) => action.id === "inspect-dialog-after-timeout"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension scrolls explicit CSS containers before falling back to page scroll", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-container-scroll-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("eval") && stdin.includes("document.querySelector")) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: {
      status: "scrolled",
      selector: "#virtualList",
      direction: "down",
      before: { scrollTop: 0, scrollLeft: 0, scrollHeight: 2500, clientHeight: 210, scrollWidth: 400, clientWidth: 400 },
      after: { scrollTop: 168, scrollLeft: 0, scrollHeight: 2500, clientHeight: 210, scrollWidth: 400, clientWidth: 400 }
    } } }));
    return;
  }
  if (args.includes("scroll")) {
    process.stdout.write(JSON.stringify({ success: true, data: { scrolled: "unexpected-page-scroll" } }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "#virtualList", "down"] });
			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Scrolled container #virtualList down/);
			assert.equal((result.details?.data as { status?: string } | undefined)?.status, "scrolled");
			assert.equal((result.details?.scrollContainer as { request?: { selector?: string } } | undefined)?.request?.selector, "#virtualList");
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("scroll")), false);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension handles scroll to end before upstream page scroll", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-page-scroll-end-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("eval") && stdin.includes('target = "end"')) {
    process.stdout.write(JSON.stringify({ success: true, data: { result: {
      status: "scrolled",
      target: "end",
      before: { scrollTop: 0, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 },
      after: { scrollTop: 4500, scrollLeft: 0, scrollHeight: 5000, clientHeight: 500, scrollWidth: 800, clientWidth: 800 }
    } } }));
    return;
  }
  if (args.includes("scroll")) {
    process.stdout.write(JSON.stringify({ success: true, data: { scrolled: "unexpected-page-scroll" } }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["scroll", "to", "end"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /Scrolled page to end/);
			assert.equal((result.details?.data as { status?: string } | undefined)?.status, "scrolled");
			assert.equal((result.details?.scrollPage as { request?: { target?: string } } | undefined)?.request?.target, "end");
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("scroll")), false);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension filters snapshot refs with wrapper search and role flags", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-filter-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://dense.example/",
    refs: {
      e1: { role: "link", name: "Cart" },
      e2: { role: "button", name: "Checkout" },
      e3: { role: "combobox", name: "Theme" }
    },
    snapshot: ['- link "Cart" [ref=e1]', '- button "Checkout" [ref=e2]', '- combobox "Theme" [ref=e3]'].join('\\n')
  } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--search", "checkout"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /Snapshot filter: 1\/3 direct refs matched search "checkout"; 1 surrounding snapshot line shown\./);
			assert.match(result.content[0]?.text ?? "", /Checkout/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Theme/);
			assert.equal((result.details?.snapshotFilter as { search?: string; matchedRefs?: number } | undefined)?.search, "checkout");
			assert.equal((result.details?.snapshotFilter as { matchedRefs?: number } | undefined)?.matchedRefs, 1);
			assert.deepEqual((result.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1", "e2", "e3"]);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("--search")), false);
			assert.ok(invocations.some((entry) => entry.args.includes("snapshot") && entry.args.includes("-i")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports wrapper snapshot diffs against previous refs", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-diff-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const prior = fs.existsSync(${JSON.stringify(logPath)}) ? fs.readFileSync(${JSON.stringify(logPath)}, "utf8").trim().split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  const first = prior === 0;
  const data = first
    ? { origin: "https://dense.example/", refs: { e1: { role: "link", name: "Cart" }, e2: { role: "button", name: "Checkout" } }, snapshot: ['- link "Cart" [ref=e1]', '- button "Checkout" [ref=e2]'].join('\\n') }
    : { origin: "https://dense.example/", refs: { e1: { role: "link", name: "Basket" }, e3: { role: "button", name: "Pay" } }, snapshot: ['- link "Basket" [ref=e1]', '- button "Pay" [ref=e3]'].join('\\n') };
  process.stdout.write(JSON.stringify({ success: true, data }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const first = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--search", "Cart"] });
			assert.equal(first.isError, false, JSON.stringify(first));
			const second = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--diff"] });
			assert.equal(second.isError, false, JSON.stringify(second));
			assert.match(second.content[0]?.text ?? "", /Snapshot diff: \+1 \/ -1 \/ Δ1 refs/);
			const diff = second.details?.snapshotDiff as { addedRefs?: string[]; changedRefs?: string[]; removedRefs?: string[] } | undefined;
			assert.deepEqual(diff?.addedRefs, ["e3"]);
			assert.deepEqual(diff?.changedRefs, ["e1"]);
			assert.deepEqual(diff?.removedRefs, ["e2"]);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("--diff")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports wrapper snapshot viewport metadata", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-snapshot-viewport-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { scrollX: 0, scrollY: 240, innerHeight: 900, innerWidth: 1440, scrollHeight: 3000, scrollWidth: 1440, containerCount: 1, containers: [{ id: "0:main", scrollTop: 12, scrollLeft: 0 }] } } }));
  return;
}
if (args.includes("snapshot")) {
  const refs = Object.fromEntries(Array.from({ length: 90 }, (_, index) => ["e" + (index + 1), { role: "button", name: "Checkout " + (index + 1) }]));
  const snapshot = Array.from({ length: 90 }, (_, index) => '- button "Checkout ' + (index + 1) + '" [ref=e' + (index + 1) + ']').join('\\n');
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://dense.example/", refs, snapshot } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i", "--viewport"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /Viewport: 1440×900, scroll 0,240/);
			const viewport = result.details?.snapshotViewport as { innerHeight?: number; scrollY?: number } | undefined;
			assert.equal(viewport?.innerHeight, 900);
			assert.equal(viewport?.scrollY, 240);
			assert.equal(typeof result.details?.fullOutputPath, "string");
			assert.equal((result.details?.artifactManifest as { entries?: unknown[] } | undefined)?.entries?.length, 1);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("--viewport")), false);
			assert.ok(invocations.some((entry) => entry.args.includes("eval") && entry.args.includes("--stdin")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension filters network requests to the current page origin", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-filter-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://shop.example/products" } }));
  return;
}
if (args.includes("network") && args.includes("requests")) {
  process.stdout.write(JSON.stringify({ success: true, data: { requests: [
    { id: "1", method: "GET", status: 200, url: "https://shop.example/app.js" },
    { id: "2", method: "GET", status: 200, url: "https://cdn.example/lib.js" },
    { id: "3", method: "POST", status: 500, url: "https://shop.example/api/cart" }
  ] } }));
  return;
}
process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "review", "network", "requests", "--current-page"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /2\/3 rows matched/);
			assert.match(result.content[0]?.text ?? "", /shop\.example\/app\.js/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /cdn\.example/);
			assert.equal(result.details?.namespace, "review");
			const filter = result.details?.networkRequestsPageFilter as { matchedRows?: number; totalRows?: number } | undefined;
			assert.equal(filter?.matchedRows, 2);
			assert.equal(filter?.totalRows, 3);
			const data = result.details?.data as { requests?: Array<{ url?: string }> } | undefined;
			assert.deepEqual(data?.requests?.map((request) => request.url), ["https://shop.example/app.js", "https://shop.example/api/cart"]);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("--current-page")), false);
			assert.ok(invocations.every((entry) => entry.args.includes("--namespace") && entry.args.includes("review")));
			assert.ok(invocations.some((entry) => entry.args.includes("network") && entry.args.includes("requests")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports focused combobox diagnostics with option-opening next actions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-combobox-focus-"));
	const statePath = join(tempDir, "combobox-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
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
const target = args[commandIndex + 1];
const value = args[commandIndex + 2];
const action = args[commandIndex + 3];
const nameIndex = args.indexOf("--name");
const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
let state = { mode: "none" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "find" && target === "role" && value === "combobox" && action === "click") {
  state.mode = name === "MissingExpanded" ? "combo-missing" : name === "Open" ? "combo-open" : name === "OptionsVisible" ? "combo-options" : "combo";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
} else if (command === "click") {
  state.mode = "textbox";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
}
let result = { ok: true, command, target };
if (command === "eval") {
  result = state.mode === "combo"
    ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "false", hasPopup: "listbox", name: "Datasource", tagName: "input" } }
    : state.mode === "combo-missing"
      ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", hasPopup: "listbox", name: "MissingExpanded", tagName: "input" } }
      : state.mode === "combo-open"
        ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "true", hasPopup: "listbox", name: "Open", tagName: "input" } }
        : state.mode === "combo-options"
          ? { comboboxLike: true, visibleListboxCount: 1, visibleOptionCount: 2, activeElement: { role: "combobox", expanded: "false", hasPopup: "listbox", name: "OptionsVisible", tagName: "input" } }
          : { comboboxLike: false, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "textbox", name: "Search", tagName: "input" } };
}
process.stdout.write(JSON.stringify({ success: true, data: command === "eval" ? { result } : result }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check combobox recovery diagnostics." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const comboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "role", value: "combobox", name: "Datasource" }, sessionMode: "fresh" });
			assert.equal(comboboxResult.isError, false);
			assert.match(comboboxResult.content[0]?.text ?? "", /Combobox diagnostic: focused combobox did not expose visible options/);
			const details = comboboxResult.details as {
				comboboxFocus: { reason: string; activeElement: { name?: string; role?: string } };
				nextActions: Array<{ id: string; params?: { args: string[] } }>;
			};
			assert.equal(details.comboboxFocus.reason, "focused-combobox-without-visible-options");
			assert.equal(details.comboboxFocus.activeElement.role, "combobox");
			assert.equal(details.comboboxFocus.activeElement.name, "Datasource");
			const comboboxActionIds = details.nextActions.map((action) => action.id).filter((id) => id.includes("combobox"));
			assert.deepEqual(comboboxActionIds, ["inspect-focused-combobox", "try-open-combobox-with-arrow", "try-open-combobox-with-enter"]);
			assert.ok(details.nextActions.filter((action) => action.id.includes("combobox")).every((action) => action.params?.args[0] === "--session"));
			const openComboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "role", value: "combobox", name: "Open" } });
			assert.equal(openComboboxResult.isError, false);
			assert.match(openComboboxResult.content[0]?.text ?? "", /Combobox diagnostic: focused combobox did not expose visible options/);
			assert.equal((openComboboxResult.details as { comboboxFocus?: { activeElement?: { name?: string; expanded?: string } } }).comboboxFocus?.activeElement?.name, "Open");
			assert.equal((openComboboxResult.details as { comboboxFocus?: { activeElement?: { name?: string; expanded?: string } } }).comboboxFocus?.activeElement?.expanded, "true");

			for (const name of ["MissingExpanded", "OptionsVisible"]) {
				const negativeComboboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction: { action: "click", locator: "role", value: "combobox", name } });
				assert.equal(negativeComboboxResult.isError, false, name);
				assert.equal((negativeComboboxResult.details as { comboboxFocus?: unknown }).comboboxFocus, undefined, name);
				assert.doesNotMatch(negativeComboboxResult.content[0]?.text ?? "", /Combobox diagnostic/, name);
			}

			const textboxResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@text"] });
			assert.equal(textboxResult.isError, false);
			assert.equal((textboxResult.details as { comboboxFocus?: unknown }).comboboxFocus, undefined);
			assert.doesNotMatch(textboxResult.content[0]?.text ?? "", /Combobox diagnostic/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves combobox diagnostics after semanticAction visible-ref resolution", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-combobox-visible-ref-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "combobox-visible-ref-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session"]);
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
let state = { mode: "none" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (command === "open") {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Grafana", url: "https://grafana.example.test/" } }));
} else if (command === "snapshot") {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://grafana.example.test/",
    refs: { e65: { role: "combobox", name: "Job" } },
    snapshot: '- combobox "Job" [ref=e65]'
  } }));
} else if (command === "click") {
  state.mode = args[commandIndex + 1] === "@e65" ? "combo" : "other";
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[commandIndex + 1] } }));
} else if (command === "eval") {
  const result = state.mode === "combo"
    ? { comboboxLike: true, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "combobox", expanded: "true", hasPopup: "listbox", name: "Job", tagName: "input" } }
    : { comboboxLike: false, visibleListboxCount: 0, visibleOptionCount: 0, activeElement: { role: "textbox", name: "Other", tagName: "input" } };
  process.stdout.write(JSON.stringify({ success: true, data: { result } }));
} else if (command === "get" && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Grafana" } }));
} else if (command === "get" && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://grafana.example.test/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Check visible-ref combobox recovery diagnostics." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://grafana.example.test/"] });
			assert.equal(open.isError, false);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", value: "combobox", name: "Job" },
			});
			assert.equal(result.isError, false);
			assert.match(result.content[0]?.text ?? "", /Combobox diagnostic: focused combobox did not expose visible options/);
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-2), ["click", "@e65"]);
			assert.equal((result.details?.comboboxFocus as { activeElement?: { role?: string; name?: string } } | undefined)?.activeElement?.role, "combobox");
			assert.equal((result.details?.comboboxFocus as { activeElement?: { role?: string; name?: string } } | undefined)?.activeElement?.name, "Job");
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("snapshot")));
			assert.ok(invocations.some((entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e65"));
			assert.equal(invocations.some((entry) => entry.args.includes("find")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns after record start when ffmpeg is missing", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-recording-ffmpeg-"));
	const nodeBinDir = dirname(process.execPath);
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
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
process.stdout.write(JSON.stringify({ success: true, data: { command, subcommand, path: args[commandIndex + 2] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${nodeBinDir}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Record a browser workflow." });
			await mkdir(join(tempDir, "ffmpeg"));
			const missingResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "demo.webm"] });
			assert.equal(missingResult.isError, false);
			assert.match(missingResult.content[0]?.text ?? "", /Recording dependency warning: ffmpeg not found on PATH/);
			assert.match(missingResult.content[0]?.text ?? "", /Exists: pending until record stop/);
			assert.match(missingResult.content[0]?.text ?? "", /Status: pending/);
			assert.doesNotMatch(missingResult.content[0]?.text ?? "", /Status: missing/);
			const missingArtifacts = missingResult.details?.artifacts as Array<{ exists?: boolean; recordingState?: string; status?: string; willExistOnStop?: boolean }> | undefined;
			assert.equal(missingArtifacts?.[0]?.exists, undefined);
			assert.equal(missingArtifacts?.[0]?.status, "pending");
			assert.equal(missingArtifacts?.[0]?.recordingState, "openRecording");
			assert.equal(missingArtifacts?.[0]?.willExistOnStop, true);
			const missingVerification = missingResult.details?.artifactVerification as { artifacts?: Array<{ recordingState?: string; state?: string; status?: string; willExistOnStop?: boolean }>; missingCount?: number; pendingCount?: number } | undefined;
			assert.equal(missingVerification?.pendingCount, 1);
			assert.equal(missingVerification?.missingCount, 0);
			assert.equal(missingVerification?.artifacts?.[0]?.state, "pending");
			assert.equal(missingVerification?.artifacts?.[0]?.status, "pending");
			assert.equal(missingVerification?.artifacts?.[0]?.willExistOnStop, true);
			const missingDetails = missingResult.details as { recordingDependencyWarning?: { reason?: string; command?: string; dependency?: string } };
			assert.deepEqual(missingDetails.recordingDependencyWarning, {
				command: "record start",
				dependency: "ffmpeg",
				message: "record start can begin recording, but record stop needs ffmpeg on PATH to encode the WebM output.",
				reason: "ffmpeg-missing-for-recording",
				recommendations: [
					"Install ffmpeg before relying on this recording workflow; on macOS with Homebrew, brew install ffmpeg or brew install ffmpeg-full.",
					"If ffmpeg was just installed, restart pi or ensure the PATH visible to pi includes the ffmpeg binary before running record stop.",
				],
			});

			await rm(join(tempDir, "ffmpeg"), { recursive: true, force: true });
			await writeFile(join(tempDir, "ffmpeg"), "#!/bin/sh\nexit 0\n", "utf8");
			await chmod(join(tempDir, "ffmpeg"), 0o755);
			const presentResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "demo.webm"] });
			assert.equal(presentResult.isError, false);
			assert.equal((presentResult.details as { recordingDependencyWarning?: unknown }).recordingDependencyWarning, undefined);
			assert.doesNotMatch(presentResult.content[0]?.text ?? "", /Recording dependency warning/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension renders long TUI output compactly without changing model-facing content", async () => {
	const harness = createExtensionHarness({ cwd: process.cwd(), prompt: "Inspect a page." });
	const renderCall = harness.tool.renderCall;
	const renderResult = harness.tool.renderResult;
	assert.ok(renderCall, "expected agent_browser to register custom call rendering");
	assert.ok(renderResult, "expected agent_browser to register custom result rendering");

	const params: AgentBrowserToolParams = {
		args: ["eval", "--stdin"],
		sessionMode: "fresh",
		stdin: "document.body.innerText",
	};
	const callText = renderCall(params, PLAIN_RENDER_THEME, createRenderContext({ args: params })).render(200).join("\n");
	assert.match(callText, /<toolTitle>\*\*agent_browser\*\*<\/toolTitle>/);
	assert.match(callText, /<accent>eval --stdin<\/accent>/);
	assert.match(callText, /sessionMode=fresh/);
	assert.match(callText, /\+ stdin/);
	assert.doesNotMatch(callText, /document\.body/);

	const qaCallText = renderCall(
		{ qa: { url: "https://example.com", expectedText: "Example" } },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(200)
		.join("\n");
	assert.match(qaCallText, /<accent>qa<\/accent>/);
	assert.match(qaCallText, /<dim>→<\/dim> <accent>batch --bail<\/accent>/);

	const semanticActionCallText = renderCall(
		{ semanticAction: { action: "click", locator: "text", value: "Definitely Missing Button" } },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(200)
		.join("\n");
	assert.match(semanticActionCallText, /<accent>semanticAction<\/accent>/);
	assert.match(semanticActionCallText, /<dim>→<\/dim> <accent>find text Definitely Missing Button click<\/accent>/);

	const maliciousParams: AgentBrowserToolParams = {
		args: ["open", "\x1B]0;pwned\x07https://example.com/\x1B[31m"],
		stdin: "secret stdin must not render",
	};
	const maliciousCallText = renderCall(maliciousParams, PLAIN_RENDER_THEME, createRenderContext({ args: maliciousParams }))
		.render(200)
		.join("\n");
	assert.doesNotMatch(maliciousCallText, /[\x00\x07\x1B]/);
	assert.match(maliciousCallText, /https:\/\/example\.com\//);
	assert.doesNotMatch(maliciousCallText, /secret stdin/);

	const longText = JSON.stringify(
		{
			origin: "https://example.com/",
			result: Array.from({ length: 25 }, (_, index) => ({
				href: `https://example.com/${index}`,
				i: index,
				text: `item-${index}`,
			})),
		},
		null,
		2,
	);
	const longResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: longText }],
		details: { summary: "large JSON result" },
	};
	const collapsedComponent = renderResult(
		longResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	);
	const collapsedLines = collapsedComponent.render(80);
	const collapsedText = collapsedLines.join("\n");
	const wideCollapsedText = collapsedComponent.render(200).join("\n");
	assert.ok(collapsedLines.every((line) => visibleWidth(line) <= 80), "collapsed render lines must fit width");
	const narrowCollapsedLines = collapsedComponent.render(24);
	assert.ok(narrowCollapsedLines.every((line) => visibleWidth(line) <= 24), "narrow collapsed render lines must fit width");
	assert.match(collapsedText, /\.\.\. \(\d+ more lines, \d+ total,/);
	assert.match(wideCollapsedText, /<dim>ctrl\+o<\/dim> <muted>to expand<\/muted>/);
	assert.match(wideCollapsedText, /<syntaxVariable>"origin"<\/syntaxVariable>/);
	assert.match(wideCollapsedText, /<syntaxString>"https:\/\/example\.com\/"<\/syntaxString>/);
	assert.doesNotMatch(collapsedText, /item-24/);
	assert.match(longText, /item-24/, "renderer must not mutate model-facing content");

	const longFailureText = Array.from({ length: 20 }, (_, index) => `failure-line-${index}`).join("\n");
	const failedResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: longFailureText }],
		details: { failureCategory: "selector-not-found", resultCategory: "failure", summary: "selector miss" },
	};
	const failedCollapsedText = renderResult(
		failedResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(100)
		.join("\n");
	assert.match(failedCollapsedText, /Result category: failure; failureCategory: selector-not-found; Pi tool isError: true\./);
	assert.match(failedCollapsedText, /failure-line-0/);
	assert.doesNotMatch(failedCollapsedText, /failure-line-19/);
	assert.match(longFailureText, /failure-line-19/, "renderer must not mutate failed model-facing content");

	const expandedComponent = renderResult(
		longResult,
		{ expanded: true, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params, expanded: true, lastComponent: collapsedComponent }),
	);
	const expandedText = expandedComponent.render(80).join("\n");
	assert.match(expandedText, /item-24/);
	assert.doesNotMatch(expandedText, /\.\.\. \(\d+ more lines/);

	const scalarResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "Clicked: true\x1B[31m red\x1B[0m\nHref: https://example.com/next\x1B]0;pwned\x07\nNull\x00byte" }],
		details: { summary: "click completed" },
	};
	const scalarText = renderResult(
		scalarResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(120)
		.join("\n");
	assert.doesNotMatch(scalarText, /[\x00\x07\x1B]/);
	assert.match(scalarText, /<toolOutput>Clicked: true red<\/toolOutput>/);
	assert.match(scalarText, /Null�byte/);

	const fallbackResult: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "\x1B[31m\x1B[0m" }],
		details: { summary: "\x1B]0;pwned\x07summary ok" },
	};
	const fallbackText = renderResult(
		fallbackResult,
		{ expanded: false, isPartial: false },
		PLAIN_RENDER_THEME,
		createRenderContext({ args: params }),
	)
		.render(120)
		.join("\n");
	assert.doesNotMatch(fallbackText, /[\x00\x07\x1B]/);
	assert.match(fallbackText, /<success>summary ok<\/success>/);
});

test("agentBrowserExtension blocks direct and wrapped agent-browser bash unless the prompt, env, or package dev cwd explicitly allows it", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-bash-policy-"));
	const defaultHarness = createExtensionHarness({ cwd: tempDir, prompt: "Open a page and summarize it." });
	for (const command of [
		"agent-browser open https://example.com",
		"FOO=bar agent-browser --version",
		"FOO=\"bar baz\" agent-browser --version",
		"PATH=/tmp:$PATH agent-browser open https://example.com",
		"echo ready\nagent-browser open https://example.com",
		"which agent-browser && agent-browser open https://example.com",
		"cat <<'EOF'\nwhich agent-browser\nEOF\nagent-browser open https://example.com",
		"env agent-browser --version",
		"npx --yes agent-browser open https://example.com",
		"pnpm dlx agent-browser open https://example.com",
		"/opt/homebrew/bin/agent-browser open https://example.com",
	]) {
		const [blocked] = await runExtensionEventResults<{ block: boolean; reason?: string }>(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command } },
			defaultHarness.ctx,
		);
		assert.equal(blocked?.block, true, command);
		assert.match(blocked?.reason ?? "", /Use the native agent_browser tool instead of bash/i);
	}

	const inspectionAllowed = await runExtensionEventResults(
		defaultHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "which agent-browser" } },
		defaultHarness.ctx,
	);
	assert.deepEqual(inspectionAllowed, []);

	for (const command of [
		"echo agent-browser",
		"grep agent-browser README.md",
		"printf '%s\\n' agent-browser",
		"echo ok && grep agent-browser README.md",
		"cat <<'EOF'\nagent-browser open https://example.com\nEOF",
	]) {
		const innocuousResults = await runExtensionEventResults(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command } },
			defaultHarness.ctx,
		);
		assert.deepEqual(innocuousResults, [], command);
	}

	const debugHarness = createExtensionHarness({ cwd: tempDir, prompt: "Please debug the browser integration via bash." });
	const debugAllowed = await runExtensionEventResults(
		debugHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "npx --yes agent-browser open https://example.com" } },
		debugHarness.ctx,
	);
	assert.deepEqual(debugAllowed, []);

	await withPatchedEnv({ PI_AGENT_BROWSER_ALLOW_DIRECT_BASH: "1" }, async () => {
		const envAllowed = await runExtensionEventResults(
			defaultHarness.handlers,
			"tool_call",
			{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
			defaultHarness.ctx,
		);
		assert.deepEqual(envAllowed, []);
	});

	const packageDevDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-package-dev-"));
	await writeFile(join(packageDevDir, "package.json"), JSON.stringify({ name: "pi-agent-browser-native" }), "utf8");
	const packageDevHarness = createExtensionHarness({ cwd: packageDevDir, prompt: "Open a page and summarize it." });
	const packageDevAllowed = await runExtensionEventResults(
		packageDevHarness.handlers,
		"tool_call",
		{ toolName: "bash", input: { command: "agent-browser open https://example.com" } },
		packageDevHarness.ctx,
	);
	assert.deepEqual(packageDevAllowed, []);

	await rm(tempDir, { force: true, recursive: true });
	await rm(packageDevDir, { force: true, recursive: true });
});
