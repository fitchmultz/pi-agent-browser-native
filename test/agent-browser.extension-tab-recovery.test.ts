/**
 * Purpose: Verify extension tab recovery and focus-drift behavior.
 * Responsibilities: Assert restored-tab selection, pinned follow-up commands, about:blank recovery, and overlapping explicit-session target ordering.
 * Scope: Focused integration-style Node test-runner coverage around fake agent-browser tab/session executions.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-tab-recovery.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests patch PATH around fake agent-browser binaries and do not require a real browser.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInvocation(
	logPath: string,
	predicate: (entry: Awaited<ReturnType<typeof readInvocationLog>>[number]) => boolean,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await readInvocationLog(logPath)).some(predicate)) return;
		await delay(5);
	}
	assert.fail(`Timed out waiting for invocation in ${logPath}`);
}

test("agentBrowserExtension re-selects the navigated tab after profiled opens when restored tabs steal focus", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
    { tabId: "t2", title: "Grok", url: "https://grok.com/", active: true }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", title: "Example Domain", url: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "--profile", "Default", "open", "https://example.com"],
			});
			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.openResultTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.deepEqual(invocations[0]?.args, [
				"--json",
				"--session",
				"named",
				"--profile",
				"Default",
				"open",
				"https://example.com",
			]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "t1"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension pins the intended tab inside a follow-up command when reconnect drift would otherwise steal focus", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  let active = gemini;
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? exampleSite : gemini;
      return { command: step, success: true, result: active };
    }
    if (command === "click") {
      return { command: step, success: true, result: { clicked: rest[0] } };
    }
    if (command === "eval") {
      return { command: step, success: true, result: { title: active.title, url: active.url } };
    }
    return { command: step, success: true, result: active };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: false },
    { tabId: "t2", title: gemini.title, url: gemini.url, active: true }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: exampleSite }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.indexOf("click") + 1] } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: gemini.title }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: gemini.url }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: gemini }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const initialOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "--profile", "Default", "open", "https://example.com"],
			});
			assert.equal(initialOpen.isError, false, JSON.stringify(initialOpen));

			const clickedSelector = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(clickedSelector.isError, false);
			assert.equal(
				(clickedSelector.details?.navigationSummary as { title?: string } | undefined)?.title,
				"Example Domain",
			);
			assert.equal(
				(clickedSelector.details?.navigationSummary as { url?: string } | undefined)?.url,
				"https://example.com/",
			);
			assert.deepEqual(clickedSelector.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});
			const tabRecoveryActions = (clickedSelector.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined)
				?.filter((action) => ["list-tabs-for-tab-drift-recovery", "select-intended-tab-after-drift", "snapshot-after-tab-recovery"].includes(action.id));
			assert.deepEqual(tabRecoveryActions?.map((action) => action.id), ["list-tabs-for-tab-drift-recovery", "select-intended-tab-after-drift", "snapshot-after-tab-recovery"]);
			assert.deepEqual(tabRecoveryActions?.map((action) => action.params?.args), [
				["--session", "named", "tab", "list"],
				["--session", "named", "tab", "t1"],
				["--session", "named", "snapshot", "-i"],
			]);
			assert.match((clickedSelector.content[0] as { text: string }).text, /Current page:/);
			assert.match((clickedSelector.content[0] as { text: string }).text, /Example Domain/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 6);
			assert.deepEqual(invocations[0]?.args, [
				"--json",
				"--session",
				"named",
				"--profile",
				"Default",
				"open",
				"https://example.com",
			]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "t1"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "get", "url"]);
			assert.deepEqual(invocations[4]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[5]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[5]?.stdin ?? "[]")), [
				["tab", "t1"],
				["click", "@e9"],
				["eval", "({ title: document.title, url: location.href })"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension recovers and preserves the prior target when a command returns about:blank", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-about-blank-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "tab-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
let state = { active: "blank", tabListCount: 0 };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  const results = steps.map((step) => {
    const [command, selectedTab] = step;
    if (command === "tab") {
      state.active = selectedTab === "t1" ? "example" : "blank";
      save();
      return { command: step, success: true, result: { tabId: selectedTab, ...exampleSite } };
    }
    if (command === "click") {
      state.active = "blank";
      save();
      return { command: step, success: true, result: { clicked: selectedTab } };
    }
    if (command === "eval") return { command: step, success: true, result: { title: "", url: "about:blank" } };
    return { command: step, success: true, result: {} };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  state.tabListCount += 1;
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "blank", title: "", url: "about:blank", active: state.active === "blank" },
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: state.active === "example" }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  state.active = "example";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else {
  save();
  process.stdout.write(JSON.stringify({ success: true, data: exampleSite }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const result = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match((result.content[0] as { text: string }).text, /^Warning: agent_browser detected that this session returned about:blank/);
			assert.match((result.content[0] as { text: string }).text, /https:\/\/example\.com\//);
			assert.deepEqual(result.details?.aboutBlankSessionMismatch, {
				activeUrl: "about:blank",
				recoveryApplied: true,
				recoveryHint: "agent_browser detected that the active tab became about:blank while this session still had a prior intended tab. Run tab list for this session and re-select the intended tab, or retry with sessionMode=fresh if the tab is gone.",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});
			assert.deepEqual(result.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});
			const aboutBlankRecoveryActions = (result.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined)
				?.filter((action) => ["list-tabs-for-about-blank-recovery", "select-intended-tab-after-drift", "snapshot-after-tab-recovery"].includes(action.id));
			assert.deepEqual(aboutBlankRecoveryActions?.map((action) => action.id), ["list-tabs-for-about-blank-recovery", "select-intended-tab-after-drift", "snapshot-after-tab-recovery"]);
			assert.deepEqual(aboutBlankRecoveryActions?.map((action) => action.params?.args), [
				["--session", "named", "tab", "list"],
				["--session", "named", "tab", "t1"],
				["--session", "named", "snapshot", "-i"],
			]);
			assert.deepEqual(result.details?.sessionTabTarget, {
				title: "Example Domain",
				url: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 5);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "get", "url"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[2]?.stdin ?? "[]")), [
				["tab", "t1"],
				["click", "@e9"],
				["eval", "({ title: document.title, url: location.href })"],
			]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[4]?.args, ["--json", "--session", "named", "tab", "t1"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension records about:blank and blocks stale refs when about:blank has no recoverable tab", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-about-blank-missing-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "tab-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
let state = { targetGone: false };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  const results = steps.map((step) => {
    const [command, value] = step;
    if (command === "tab") return { command: step, success: true, result: { tabId: value, ...exampleSite } };
    if (command === "click") {
      state.targetGone = true;
      save();
      return { command: step, success: true, result: { clicked: value } };
    }
    if (command === "eval") return { command: step, success: true, result: { title: "", url: "about:blank" } };
    return { command: step, success: true, result: {} };
  });
  save();
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  const tabs = state.targetGone
    ? [{ tabId: "blank", title: "", url: "about:blank", active: true }]
    : [
        { tabId: "blank", title: "", url: "about:blank", active: true },
        { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: false }
      ];
  process.stdout.write(JSON.stringify({ success: true, data: { tabs } }));
} else {
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { title: "", url: "about:blank" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "snapshot", "-i"],
							command: "snapshot",
							refSnapshot: {
								refIds: ["e9"],
								target: { title: "Example Domain", url: "https://example.com/" },
							},
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const result = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match((result.content[0] as { text: string }).text, /No matching tab could be re-selected/);
			assert.match((result.content[0] as { text: string }).text, /sessionMode=fresh/);
			assert.equal((result.details?.aboutBlankSessionMismatch as { recoveryApplied?: boolean } | undefined)?.recoveryApplied, false);
			assert.deepEqual(result.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});
			assert.deepEqual(result.details?.sessionTabTarget, {
				title: undefined,
				url: "about:blank",
			});
			const nextActions = result.details?.nextActions as Array<{ id: string; params?: { args?: string[]; stdin?: string } }> | undefined;
			const recoveryActions = nextActions
				?.filter((action) => ["list-tabs-for-about-blank-recovery", "select-intended-tab-after-drift", "snapshot-after-tab-recovery"].includes(action.id));
			assert.deepEqual(recoveryActions?.map((action) => action.id), ["list-tabs-for-about-blank-recovery"]);
			assert.deepEqual(recoveryActions?.[0]?.params?.args, ["--session", "named", "tab", "list"]);
			assert.equal(nextActions?.some((action) => action.id === "inspect-after-mutation" || (action.params?.args?.at(-2) === "snapshot" && action.params?.stdin === undefined)), false);
			const pageChangeSummary = result.details?.pageChangeSummary as { nextActionIds?: string[] } | undefined;
			assert.equal(pageChangeSummary?.nextActionIds, undefined);

			const staleRefRetry = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(staleRefRetry.isError, true, JSON.stringify(staleRefRetry));
			assert.equal(staleRefRetry.details?.failureCategory, "stale-ref");
			assert.match((staleRefRetry.content[0] as { text: string }).text, /current session target is about:blank/);
			assert.deepEqual((staleRefRetry.details?.refSnapshot as { target?: unknown } | undefined)?.target, {
				title: "Example Domain",
				url: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 5);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "get", "url"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "snapshot", "-i"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[3]?.stdin ?? "[]")), [
				["tab", "t1"],
				["click", "@e9"],
				["eval", "({ title: document.title, url: location.href })"],
			]);
			assert.deepEqual(invocations[4]?.args, ["--json", "--session", "named", "tab", "list"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension accepts about:blank after a batch close reactivates the session", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-about-blank-after-close-"));
	const statePath = join(tempDir, "relaunched");
	const recordingPath = join(tempDir, "recording.webm");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const relaunched = fs.existsSync(${JSON.stringify(statePath)});
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  fs.writeFileSync(${JSON.stringify(statePath)}, "1");
  if (steps.some((step) => step[0] === "record" && step[1] === "stop")) fs.writeFileSync(${JSON.stringify(recordingPath)}, "recording");
  process.stdout.write(JSON.stringify(steps.map((step) => ({
    command: step,
    success: true,
    result: {
      lifecycle: { effectiveLaunch: { browserLaunched: step[0] !== "close" } },
      ...(step[0] === "record" && step[1] === "stop" ? { path: ${JSON.stringify(recordingPath)} } : {})
    }
  }))));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ tabId: "blank", title: "", url: "about:blank", active: true }] } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: relaunched ? "about:blank" : "https://example.com/" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: relaunched ? "" : "Example Domain" } }));
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com"],
			});
			assert.equal(opened.isError, false, JSON.stringify(opened));
			assert.deepEqual(opened.details?.sessionTabTarget, { title: "Example Domain", url: "https://example.com/" });

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["close"], ["record", "stop"]]),
			});
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.equal(result.details?.aboutBlankSessionMismatch, undefined);
			assert.equal(result.details?.sessionTabCorrection, undefined);
			assert.equal(result.details?.sessionTabTarget, undefined);
			assert.doesNotMatch((result.content[0] as { text: string }).text, /^Warning:/);

			const getUrl = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(getUrl.isError, false, JSON.stringify(getUrl));
			assert.equal(getUrl.details?.aboutBlankSessionMismatch, undefined);
			assert.deepEqual(getUrl.details?.sessionTabTarget, { title: undefined, url: "about:blank" });
			assert.doesNotMatch((getUrl.content[0] as { text: string }).text, /^Warning:/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allows explicit navigation to about:blank", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-about-blank-explicit-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "blank", title: "", url: "about:blank", active: true }
  ] } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "about:blank", snapshot: "Origin: about:blank" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "", url: "about:blank" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const result = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "open", "about:blank"],
			});
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.equal(result.details?.aboutBlankSessionMismatch, undefined);
			assert.equal(result.details?.sessionTabCorrection, undefined);
			assert.deepEqual(result.details?.sessionTabTarget, { title: undefined, url: "about:blank" });
			assert.doesNotMatch((result.content[0] as { text: string }).text, /^Warning:/);
			const explicitAboutBlankActionIds = ((result.details?.nextActions as Array<{ id: string }> | undefined) ?? []).map((action) => action.id);
			assert.equal(explicitAboutBlankActionIds.some((id) => ["list-tabs-for-about-blank-recovery", "select-intended-tab-after-drift", "snapshot-after-tab-recovery"].includes(id)), false);

			const snapshot = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "snapshot", "-i"],
			});
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.equal(snapshot.details?.aboutBlankSessionMismatch, undefined);
			assert.equal(snapshot.details?.sessionTabCorrection, undefined);
			assert.deepEqual(snapshot.details?.sessionTabTarget, { title: undefined, url: "about:blank" });
			assert.doesNotMatch((snapshot.content[0] as { text: string }).text, /^Warning:/);
			const snapshotActionIds = ((snapshot.details?.nextActions as Array<{ id: string }> | undefined) ?? []).map((action) => action.id);
			assert.equal(snapshotActionIds.some((id) => ["list-tabs-for-about-blank-recovery", "select-intended-tab-after-drift", "snapshot-after-tab-recovery"].includes(id)), false);

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "open", "about:blank"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "get", "url"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "snapshot", "-i"]);
			assert.equal(
				invocations.some((invocation) => JSON.stringify(invocation.args) === JSON.stringify(["--json", "--session", "named", "tab", "blank"])),
				false,
			);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension serializes overlapping same-session opens and keeps the newer target", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const slow = { title: "Slow First", url: "https://example.com/slow-first" };
const fast = { title: "Fast Second", url: "https://example.com/fast-second" };
if (args.includes("https://example.com/slow-first")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  process.stdout.write(JSON.stringify({ success: true, data: slow }));
} else if (args.includes("https://example.com/fast-second")) {
  process.stdout.write(JSON.stringify({ success: true, data: fast }));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: slow.title, url: slow.url, active: true },
    { tabId: "t2", title: fast.title, url: fast.url, active: false }
  ] } }));
} else if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  const results = steps.map((step) => {
    const [command, subcommand] = step;
    if (command === "tab") {
      return { command: step, success: true, result: subcommand === "t2" ? fast : slow };
    }
    if (command === "click") {
      return { command: step, success: true, result: { clicked: subcommand } };
    }
    if (command === "eval") {
      return { command: step, success: true, result: { title: fast.title, url: fast.url } };
    }
    return { command: step, success: true, result: fast };
  });
  process.stdout.write(JSON.stringify(results));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: fast }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const slowOpenPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "open", "https://example.com/slow-first"],
			});
			await waitForInvocation(logPath, (entry) => entry.args.includes("https://example.com/slow-first"));
			const fastOpenPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "open", "https://example.com/fast-second"],
			});

			const [slowOpen, fastOpen] = await Promise.all([slowOpenPromise, fastOpenPromise]);
			assert.equal(slowOpen.isError, false, JSON.stringify(slowOpen));
			assert.equal(fastOpen.isError, false, JSON.stringify(fastOpen));
			assert.deepEqual(slowOpen.details?.sessionTabTarget, { title: "Slow First", url: "https://example.com/slow-first" });
			assert.deepEqual(fastOpen.details?.sessionTabTarget, { title: "Fast Second", url: "https://example.com/fast-second" });
			assert.equal(fastOpen.details?.sessionTabTargetUnknown, undefined);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "open", "https://example.com/slow-first"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "open", "https://example.com/fast-second"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension serializes a newer unverified target after prior navigation", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-stale-unverified-target-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("https://example.com/slow")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  process.stdout.write(JSON.stringify({ success: true, data: { title: "First", url: "https://example.com/slow" } }));
} else if (args.includes("connect")) {
  process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { snapshot: "SECRET UNVERIFIED CONTENT" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const slowOpenPromise = executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "open", "https://example.com/slow"] });
			await waitForInvocation(logPath, (entry) => entry.args.includes("https://example.com/slow"));
			const connectPromise = executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "connect", "9222"] });
			const [firstOpen, connected] = await Promise.all([slowOpenPromise, connectPromise]);
			assert.equal(firstOpen.isError, false, JSON.stringify(firstOpen));
			assert.deepEqual(firstOpen.details?.sessionTabTarget, { title: "First", url: "https://example.com/slow" });
			assert.equal(connected.isError, false, JSON.stringify(connected));
			assert.equal(connected.details?.sessionTabTargetUnknown, true);
			const invocationCount = (await readInvocationLog(logPath)).length;
			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "snapshot", "-i"] });
			assert.equal(snapshot.isError, true, JSON.stringify(snapshot));
			assert.match(snapshot.content[0]?.text ?? "", /active page became unverified/);
			assert.doesNotMatch(JSON.stringify(snapshot), /SECRET UNVERIFIED CONTENT/);
			assert.equal((await readInvocationLog(logPath)).length, invocationCount);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension serializes case-alias session and namespace identities on case-insensitive hosts", {
	concurrency: false,
	skip: process.platform === "darwin" || process.platform === "win32" ? false : "session daemon paths are case-sensitive on this host",
}, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-session-case-alias-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "shared-session-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
const namespaceIndex = args.indexOf("--namespace");
const namespace = namespaceIndex >= 0 ? args[namespaceIndex + 1] : "";
const sessionIndex = args.indexOf("--session");
const session = sessionIndex >= 0 ? args[sessionIndex + 1] : "";
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
let state = { url: "about:blank" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (args.includes("open")) {
  state = { url: args.at(-1) };
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Page", url: state.url } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: state.url } }));
} else if (args.includes("snapshot")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: ["snapshot-finished", namespace, session] }) + "\\n");
  process.stdout.write(JSON.stringify({ success: true, data: { snapshot: state.url.includes("-secret") ? "SECRET CONTENT" : "SAFE CONTENT" } }));
}`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const runAliasRace = async (readIdentityArgs: string[], writeIdentityArgs: string[], label: string): Promise<void> => {
				const session = readIdentityArgs[readIdentityArgs.indexOf("--session") + 1]!;
				const nextUrl = `https://example.com/${label}-secret`;
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...readIdentityArgs, "open", "https://example.com/"] });
				assert.equal(opened.isError, false, JSON.stringify(opened));

				const snapshotPromise = executeRegisteredTool(harness.tool, harness.ctx, { args: [...readIdentityArgs, "snapshot", "-i"] });
				await waitForInvocation(logPath, (entry) => entry.args.includes("snapshot") && entry.args.includes(session));
				const nextOpenPromise = executeRegisteredTool(harness.tool, harness.ctx, { args: [...writeIdentityArgs, "open", nextUrl] });
				const [snapshot, nextOpen] = await Promise.all([snapshotPromise, nextOpenPromise]);
				assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
				assert.doesNotMatch(JSON.stringify(snapshot), /SECRET CONTENT/);
				assert.equal(nextOpen.isError, false, JSON.stringify(nextOpen));

				const invocations = await readInvocationLog(logPath);
				const snapshotFinishedIndex = invocations.findIndex((entry) => entry.args[0] === "snapshot-finished" && entry.args[2] === session);
				const nextOpenIndex = invocations.findIndex((entry) => entry.args.includes(nextUrl));
				assert.ok(snapshotFinishedIndex >= 0 && nextOpenIndex > snapshotFinishedIndex, JSON.stringify(invocations));
			};
			await runAliasRace(["--session", "Foo"], ["--session", "foo"], "session-case");
			await runAliasRace(["--namespace", "Straße", "--session", "namespace-sharp-s"], ["--namespace", "STRASSE", "--session", "namespace-sharp-s"], "namespace-sharp-s");
			await runAliasRace(["--namespace", "Σ", "--session", "namespace-sigma"], ["--namespace", "ς", "--session", "namespace-sigma"], "namespace-sigma");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension propagates caller aborts during live page verification", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-live-page-abort-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("get") && args.includes("url")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.com/" } }));
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { snapshot: "SHOULD NOT RUN" } }));
}`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const controller = new AbortController();
			const snapshot = executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "snapshot", "-i"] }, controller.signal);
			await waitForInvocation(logPath, (entry) => entry.args.includes("get") && entry.args.includes("url"));
			controller.abort(new Error("caller cancelled"));
			await assert.rejects(snapshot, /caller cancelled/);

			const reopened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "open", "https://example.com/"] });
			assert.equal(reopened.isError, false, JSON.stringify(reopened));
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.includes("snapshot")), false);
			assert.equal(invocations.some((entry) => entry.args.includes("open")), true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension re-selects the intended tab after a successful command when focus drifts afterward", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "tab-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
let state = { active: "example", tabListCount: 0 };
try {
  state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
} catch {}
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
if (args.includes("tab") && args.includes("list")) {
  state.tabListCount += 1;
  const activeKey = state.tabListCount === 1 ? "example" : state.active;
  const activeSite = activeKey === "example" ? exampleSite : gemini;
  const inactiveSite = activeKey === "example" ? gemini : exampleSite;
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: activeKey === "example" ? "t1" : "t2", title: activeSite.title, url: activeSite.url, active: true },
    { tabId: activeKey === "example" ? "t2" : "t1", title: inactiveSite.title, url: inactiveSite.url, active: false }
  ] } }));
} else if (args.includes("click")) {
  state.active = "gemini";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.indexOf("click") + 1], title: exampleSite.title, url: exampleSite.url } }));
} else if (args.includes("tab") && args.includes("t1")) {
  state.active = "example";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else {
  save();
  process.stdout.write(JSON.stringify({ success: true, data: exampleSite }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const clickedSelector = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(clickedSelector.isError, false, JSON.stringify(clickedSelector));
			assert.deepEqual(clickedSelector.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 5);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "get", "url"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "click", "@e9"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[4]?.args, ["--json", "--session", "named", "tab", "t1"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
