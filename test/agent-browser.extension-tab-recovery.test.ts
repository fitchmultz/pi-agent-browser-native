/**
 * Purpose: Verify extension tab recovery and focus-drift behavior.
 * Responsibilities: Assert restored-tab selection, pinned follow-up commands, about:blank recovery, and overlapping explicit-session target ordering.
 * Scope: Focused integration-style Node test-runner coverage around fake agent-browser tab/session executions.
 * Usage: Run with `npm test -- test/agent-browser.extension-tab-recovery.test.ts` or via `npm run verify`.
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
			assert.equal(invocations.length, 5);
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
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[4]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[4]?.stdin ?? "[]")), [
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
			assert.equal(invocations.length, 4);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[1]?.stdin ?? "[]")), [
				["tab", "t1"],
				["click", "@e9"],
				["eval", "({ title: document.title, url: location.href })"],
			]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "tab", "t1"]);
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
			assert.equal(invocations.length, 3);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[1]?.stdin ?? "[]")), [
				["tab", "t1"],
				["click", "@e9"],
				["eval", "({ title: document.title, url: location.href })"],
			]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "list"]);
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
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "snapshot", "-i"]);
			assert.equal(
				invocations.some((invocation) => JSON.stringify(invocation.args) === JSON.stringify(["--json", "--session", "named", "tab", "blank"])),
				false,
			);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps newer explicit-session tab target after overlapping opens", { concurrency: false }, async () => {
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
			await delay(5);
			const fastOpenPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "open", "https://example.com/fast-second"],
			});

			const [slowOpen, fastOpen] = await Promise.all([slowOpenPromise, fastOpenPromise]);
			assert.equal(slowOpen.isError, false, JSON.stringify(slowOpen));
			assert.equal(fastOpen.isError, false, JSON.stringify(fastOpen));

			const clickedSelector = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "click", "@e9"],
			});
			assert.equal(clickedSelector.isError, false, JSON.stringify(clickedSelector));
			assert.deepEqual(clickedSelector.details?.sessionTabCorrection, {
				selectedTab: "t2",
				selectionKind: "tabId",
				targetTitle: "Fast Second",
				targetUrl: "https://example.com/fast-second",
			});
			assert.equal(
				(clickedSelector.details?.navigationSummary as { title?: string; url?: string } | undefined)?.title,
				"Fast Second",
			);
			assert.equal(
				(clickedSelector.details?.navigationSummary as { title?: string; url?: string } | undefined)?.url,
				"https://example.com/fast-second",
			);

			const invocations = await readInvocationLog(logPath);
			assert.equal(
				invocations.some((entry) =>
					entry.args.join("\u0000") === ["--json", "--session", "named", "open", "https://example.com/slow-first"].join("\u0000"),
				),
				true,
			);
			assert.equal(
				invocations.some((entry) =>
					entry.args.join("\u0000") === ["--json", "--session", "named", "open", "https://example.com/fast-second"].join("\u0000"),
				),
				true,
			);
			assert.deepEqual(invocations.at(-2)?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations.at(-1)?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations.at(-1)?.stdin ?? "[]")), [
				["tab", "t2"],
				["click", "@e9"],
				["eval", "({ title: document.title, url: location.href })"],
			]);
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
			assert.equal(invocations.length, 4);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "click", "@e9"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "tab", "t1"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
