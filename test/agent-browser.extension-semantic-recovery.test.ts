/**
 * Purpose: Verify semanticAction validation and current-ref recovery contracts.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Theme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import {
	WEB_SEARCH_PROMPT_GUIDELINE,
	QUICK_START_GUIDELINES,
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

test("agentBrowserExtension rejects ambiguous or incomplete semantic actions before spawning agent-browser", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-action-invalid-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: "should not run" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const ambiguous = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["click", "@e1"],
				semanticAction: { action: "click", locator: "text", value: "Export" },
			});
			assert.equal(ambiguous.isError, true);
			assert.match((ambiguous.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);
			assert.equal(ambiguous.details?.resultCategory, "failure");
			assert.equal(ambiguous.details?.failureCategory, "validation-error");

			const jobWithStdin = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/" }] },
				stdin: "[]",
			});
			assert.equal(jobWithStdin.isError, true);
			assert.match((jobWithStdin.content[0] as { text: string }).text, /Do not provide stdin with job/);
			assert.equal(jobWithStdin.details?.failureCategory, "validation-error");

			const ambiguousJobArgs = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.test/"],
				job: { steps: [{ action: "open", url: "https://example.test/" }] },
			});
			assert.equal(ambiguousJobArgs.isError, true);
			assert.match((ambiguousJobArgs.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);

			const ambiguousJobSemanticAction = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/" }] },
				semanticAction: { action: "click", locator: "text", value: "Export" },
			});
			assert.equal(ambiguousJobSemanticAction.isError, true);
			assert.match((ambiguousJobSemanticAction.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);

			const invalidJobAction = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "unknown" }] },
			});
			assert.equal(invalidJobAction.isError, true);
			assert.match((invalidJobAction.content[0] as { text: string }).text, /action must be one of/);

			const missingJobText = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/" }, { action: "assertText" }] },
			});
			assert.equal(missingJobText.isError, true);
			assert.match((missingJobText.content[0] as { text: string }).text, /job step assertText requires a non-empty text string/);

			const invalidJobWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "wait", milliseconds: 0 }] },
			});
			assert.equal(invalidJobWait.isError, true);
			assert.match((invalidJobWait.content[0] as { text: string }).text, /wait requires a positive integer milliseconds/);

			const invalidJobSelect = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "select", selector: "#flavor" }] },
			});
			assert.equal(invalidJobSelect.isError, true);
			assert.match((invalidJobSelect.content[0] as { text: string }).text, /job\.steps\[0\]\.value or job\.steps\[0\]\.values is required for select/);

			const invalidSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: {},
			});
			assert.equal(invalidSourceLookup.isError, true);
			assert.match((invalidSourceLookup.content[0] as { text: string }).text, /sourceLookup requires selector, reactFiberId, or componentName/);

			const oversizedSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: { componentName: "Panel", maxWorkspaceFiles: 5001 },
			});
			assert.equal(oversizedSourceLookup.isError, true);
			assert.match((oversizedSourceLookup.content[0] as { text: string }).text, /maxWorkspaceFiles must be 5000 or less/);

			const sourceLookupWithArgs = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["react", "tree"],
				sourceLookup: { componentName: "Panel" },
			});
			assert.equal(sourceLookupWithArgs.isError, true);
			assert.match((sourceLookupWithArgs.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);

			const sourceLookupWithStdin = await executeRegisteredTool(harness.tool, harness.ctx, {
				sourceLookup: { componentName: "Panel" },
				stdin: "[]",
			});
			assert.equal(sourceLookupWithStdin.isError, true);
			assert.match((sourceLookupWithStdin.content[0] as { text: string }).text, /Do not provide stdin with job, qa, sourceLookup, or networkSourceLookup/);

			const networkSourceLookupWithArgs = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["network", "requests"],
				networkSourceLookup: { url: "/api/fail" },
			});
			assert.equal(networkSourceLookupWithArgs.isError, true);
			assert.match((networkSourceLookupWithArgs.content[0] as { text: string }).text, /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);

			const networkSourceLookupWithStdin = await executeRegisteredTool(harness.tool, harness.ctx, {
				networkSourceLookup: { url: "/api/fail" },
				stdin: "[]",
			});
			assert.equal(networkSourceLookupWithStdin.isError, true);
			assert.match((networkSourceLookupWithStdin.content[0] as { text: string }).text, /Do not provide stdin with job, qa, sourceLookup, or networkSourceLookup/);

			const emptyNetworkSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, {
				networkSourceLookup: {},
			});
			assert.equal(emptyNetworkSourceLookup.isError, true);
			assert.match((emptyNetworkSourceLookup.content[0] as { text: string }).text, /networkSourceLookup requires requestId, filter, or url/);

			const missingText = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "label", value: "Email" },
			});
			assert.equal(missingText.isError, true);
			assert.match((missingText.content[0] as { text: string }).text, /semanticAction\.text is required for fill/);
			assert.equal(missingText.details?.failureCategory, "validation-error");

			const unsupportedUncheck = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "uncheck", locator: "label", value: "Agree terms" },
			});
			assert.equal(unsupportedUncheck.isError, true);
			assert.match((unsupportedUncheck.content[0] as { text: string }).text, /semanticAction\.action must be one of: check, click, fill, select/);
			assert.equal(unsupportedUncheck.details?.failureCategory, "validation-error");

			const unsupportedRoleName = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Export", name: "Export" },
			});
			assert.equal(unsupportedRoleName.isError, true);
			assert.match((unsupportedRoleName.content[0] as { text: string }).text, /semanticAction\.name is only supported/);
			assert.equal(unsupportedRoleName.details?.failureCategory, "validation-error");

			const mismatchedRoleValue = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", role: "button", value: "link" },
			});
			assert.equal(mismatchedRoleValue.isError, true);
			assert.match((mismatchedRoleValue.content[0] as { text: string }).text, /semanticAction\.role must match value/);
			assert.equal(mismatchedRoleValue.details?.failureCategory, "validation-error");

			const emptySession = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Export", session: "" },
			});
			assert.equal(emptySession.isError, true);
			assert.match((emptySession.content[0] as { text: string }).text, /semanticAction\.session must be a non-empty string/);
			assert.equal(emptySession.details?.failureCategory, "validation-error");

			const selectWithoutSelector = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", value: "chocolate" },
			});
			assert.equal(selectWithoutSelector.isError, true);
			assert.match((selectWithoutSelector.content[0] as { text: string }).text, /semanticAction\.selector is required for select/);
			assert.equal(selectWithoutSelector.details?.failureCategory, "validation-error");

			const selectWithoutValue = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", selector: "#flavor" },
			});
			assert.equal(selectWithoutValue.isError, true);
			assert.match((selectWithoutValue.content[0] as { text: string }).text, /semanticAction\.value or semanticAction\.values is required for select/);
			assert.equal(selectWithoutValue.details?.failureCategory, "validation-error");

			const selectWithLocator = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", locator: "placeholder", selector: "#flavor", value: "chocolate" },
			});
			assert.equal(selectWithLocator.isError, true);
			assert.match((selectWithLocator.content[0] as { text: string }).text, /locator, role, and name are not supported for select/);
			assert.equal(selectWithLocator.details?.failureCategory, "validation-error");

			const invocations = await readInvocationLog(logPath).catch(() => []);
			assert.deepEqual(invocations.filter((entry) => entry.args.includes("find")), []);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns rich input recovery when semanticAction fill misses current editable refs", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-candidates-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://search.example/",
    refs: {
      e6: { role: "searchbox", name: "Search Wikipedia", editable: false },
      e7: { role: "searchbox", name: "Search Wikipedia" },
      e8: { role: "generic", name: "Search Wikipedia", contentEditable: true },
      e9: { role: "textbox", name: "Search Wikipedia advanced" },
      e10: { role: "button", name: "Search Wikipedia" },
      e11: { role: "textbox", name: "Composer" },
      e12: { role: "button", name: "Composer" },
      e13: { role: "unknown", name: "Search Wikipedia", editable: true },
      e14: { role: "generic", name: "Search Wikipedia", contenteditable: false }
    },
    snapshot: '- searchbox "Search Wikipedia" [ref=e6] editable=false\\n- searchbox "Search Wikipedia" [ref=e7]\\n- generic "Search Wikipedia" [ref=e8] contenteditable=true\\n- textbox "Search Wikipedia advanced" [ref=e9]\\n- button "Search Wikipedia" [ref=e10]\\n- textbox "Composer" [ref=e11]\\n- button "Composer" [ref=e12]\\n- generic "Search Wikipedia" [ref=e13] editable\\n- generic "Search Wikipedia" [ref=e14] contenteditable=false'
  } }));
  process.exit(0);
} else if (args.includes("find") || args.includes("select")) {
  process.stdout.write(JSON.stringify({ success: false, error: "selector not found" }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: "ok" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "placeholder", value: "Search Wikipedia", text: "- [ ] item" },
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "selector-not-found");
			const text = result.content[0] as { text: string };
			assert.match(text.text, /Current snapshot ref fallback:/);
			assert.match(text.text, /@e7 searchbox "Search Wikipedia"/);
			assert.doesNotMatch(text.text, /@e6/);
			assert.match(text.text, /@e8 textbox "Search Wikipedia"/);
			assert.match(text.text, /@e13 textbox "Search Wikipedia"/);
			assert.doesNotMatch(text.text, /@e9/);
			assert.doesNotMatch(text.text, /@e14/);
			assert.match(text.text, /Rich input recovery:/);
			assert.doesNotMatch(text.text, /Agent-browser candidate fallbacks:/);
			assert.doesNotMatch(text.text, /- \[ \] item/);
			const visibleRefFallback = result.details?.visibleRefFallback as { candidates?: Array<{ args?: string[]; editableEvidence?: boolean }>; target?: { text?: string } } | undefined;
			assert.equal(visibleRefFallback?.target?.text, undefined);
			assert.ok(visibleRefFallback?.candidates?.every((candidate) => candidate.args === undefined));
			assert.ok(visibleRefFallback?.candidates?.every((candidate) => candidate.editableEvidence === undefined));
			const richInputRecovery = result.details?.richInputRecovery as { candidates?: Array<{ clickArgs?: string[]; focusArgs?: string[]; ref?: string; role?: string }>; inputMethodHint?: string; nextActionIds?: string[] } | undefined;
			assert.deepEqual(richInputRecovery?.candidates?.map((candidate) => ({ clickArgs: candidate.clickArgs, focusArgs: candidate.focusArgs, ref: candidate.ref, role: candidate.role })), [
				{ clickArgs: ["click", "@e7"], focusArgs: ["focus", "@e7"], ref: "@e7", role: "searchbox" },
				{ clickArgs: ["click", "@e8"], focusArgs: ["focus", "@e8"], ref: "@e8", role: "textbox" },
				{ clickArgs: ["click", "@e13"], focusArgs: ["focus", "@e13"], ref: "@e13", role: "textbox" },
			]);
			assert.match(richInputRecovery?.inputMethodHint ?? "", /keyboard inserttext or keyboard type/);
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] }; reason?: string; safety?: string }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), [
				"refresh-interactive-refs",
				"focus-current-editable-ref-1",
				"click-current-editable-ref-1",
				"focus-current-editable-ref-2",
				"click-current-editable-ref-2",
				"focus-current-editable-ref-3",
				"click-current-editable-ref-3",
			]);
			assert.deepEqual(nextActions?.[1]?.params?.args?.slice(-2), ["focus", "@e7"]);
			assert.deepEqual(nextActions?.[2]?.params?.args?.slice(-2), ["click", "@e7"]);
			assert.deepEqual(nextActions?.[3]?.params?.args?.slice(-2), ["focus", "@e8"]);
			assert.deepEqual(nextActions?.[4]?.params?.args?.slice(-2), ["click", "@e8"]);
			assert.deepEqual(nextActions?.[5]?.params?.args?.slice(-2), ["focus", "@e13"]);
			assert.deepEqual(nextActions?.[6]?.params?.args?.slice(-2), ["click", "@e13"]);
			assert.match(nextActions?.[1]?.safety ?? "", /Several editable refs share/);
			const invocationsAfterFirstMiss = await readInvocationLog(logPath);
			assert.equal(invocationsAfterFirstMiss.length, 3);
			assert.deepEqual(invocationsAfterFirstMiss.map((entry) => entry.args.slice(3)), [
				["snapshot", "-i"],
				["find", "placeholder", "Search Wikipedia", "fill", "- [ ] item"],
				["snapshot", "-i"],
			]);
			for (const action of nextActions ?? []) {
				assert.ok(!action.params?.args?.includes("- [ ] item"));
				assert.ok(!action.params?.args?.includes("Enter"));
				assert.doesNotMatch(action.id ?? "", /submit/i);
				assert.doesNotMatch(action.reason ?? "", /agent browser/);
			}

			const rawDashFillMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["find", "placeholder", "Search Wikipedia", "fill", "- [ ] item"],
			});
			assert.equal(rawDashFillMiss.isError, true);
			assert.equal(rawDashFillMiss.details?.failureCategory, "selector-not-found");
			assert.match((rawDashFillMiss.content[0] as { text: string }).text, /Current snapshot ref fallback:/);
			assert.match((rawDashFillMiss.content[0] as { text: string }).text, /Rich input recovery:/);
			assert.match((rawDashFillMiss.content[0] as { text: string }).text, /@e7 searchbox "Search Wikipedia"/);
			assert.doesNotMatch((rawDashFillMiss.content[0] as { text: string }).text, /- \[ \] item/);
			const rawVisibleRefFallback = rawDashFillMiss.details?.visibleRefFallback as { candidates?: Array<{ args?: string[]; editableEvidence?: boolean }>; target?: { text?: string } } | undefined;
			assert.equal(rawVisibleRefFallback?.target?.text, undefined);
			assert.ok(rawVisibleRefFallback?.candidates?.every((candidate) => candidate.args === undefined));
			assert.ok(rawVisibleRefFallback?.candidates?.every((candidate) => candidate.editableEvidence === undefined));
			const rawNextActions = rawDashFillMiss.details?.nextActions as Array<{ params?: { args?: string[] } }> | undefined;
			for (const action of rawNextActions ?? []) {
				assert.ok(!action.params?.args?.includes("- [ ] item"));
			}

			const clickMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Search Wikipedia" },
			});
			assert.equal(clickMiss.isError, true);
			assert.equal(clickMiss.details?.failureCategory, "selector-not-found");
			assert.equal(clickMiss.details?.richInputRecovery, undefined);
			assert.match((clickMiss.content[0] as { text: string }).text, /Agent-browser candidate fallbacks:/);
			assert.doesNotMatch((clickMiss.content[0] as { text: string }).text, /try-searchbox-name-candidate|try-textbox-name-candidate|try-labeled-textbox-candidate/);
			const clickNextActions = clickMiss.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(clickNextActions?.map((action) => action.id), [
				"refresh-interactive-refs",
				"try-current-visible-ref",
				"try-button-name-candidate",
				"try-link-name-candidate",
			]);
			assert.deepEqual(clickNextActions?.[1]?.params?.args?.slice(-2), ["click", "@e10"]);
			assert.deepEqual(clickNextActions?.[2]?.params?.args, ["find", "role", "button", "click", "--name", "Search Wikipedia"]);
			assert.deepEqual(clickNextActions?.[3]?.params?.args, ["find", "role", "link", "click", "--name", "Search Wikipedia"]);
			assert.ok(!JSON.stringify(clickNextActions).includes("agent browser"));

			const textFillMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "text", value: "Composer", text: "private smoke prompt" },
			});
			assert.equal(textFillMiss.isError, true);
			assert.equal(textFillMiss.details?.failureCategory, "selector-not-found");
			assert.match((textFillMiss.content[0] as { text: string }).text, /Rich input recovery:/);
			assert.match((textFillMiss.content[0] as { text: string }).text, /@e11 textbox "Composer"/);
			assert.doesNotMatch((textFillMiss.content[0] as { text: string }).text, /private smoke prompt/);
			const textFillRecovery = textFillMiss.details?.richInputRecovery as { candidates?: Array<{ clickArgs?: string[]; focusArgs?: string[]; ref?: string; role?: string }> } | undefined;
			assert.deepEqual(textFillRecovery?.candidates?.map((candidate) => ({ clickArgs: candidate.clickArgs, focusArgs: candidate.focusArgs, ref: candidate.ref, role: candidate.role })), [
				{ clickArgs: ["click", "@e11"], focusArgs: ["focus", "@e11"], ref: "@e11", role: "textbox" },
			]);
			const textFillNextActions = textFillMiss.details?.nextActions as Array<{ id?: string; params?: { args?: string[] }; reason?: string; safety?: string }> | undefined;
			assert.deepEqual(textFillNextActions?.map((action) => action.id), ["refresh-interactive-refs", "focus-current-editable-ref", "click-current-editable-ref"]);
			for (const action of textFillNextActions ?? []) {
				assert.ok(!action.params?.args?.includes("private smoke prompt"));
				assert.ok(!action.params?.args?.includes("Enter"));
				assert.doesNotMatch(action.id ?? "", /submit/i);
				assert.doesNotMatch(action.reason ?? "", /private smoke prompt/);
			}

			const selectMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", selector: "find", values: ["role", "button", "click", "--name", "Search Wikipedia"] },
			});
			assert.equal(selectMiss.isError, true);
			assert.equal(selectMiss.details?.failureCategory, "selector-not-found");
			assert.doesNotMatch((selectMiss.content[0] as { text: string }).text, /Current snapshot ref fallback|Agent-browser candidate fallbacks|@e10/);
			const selectMissNextActions = selectMiss.details?.nextActions as Array<{ id?: string }> | undefined;
			assert.deepEqual(selectMissNextActions?.map((action) => action.id), ["refresh-interactive-refs"]);

			const rawSelectMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["select", "find", "role", "button", "click", "--name", "Search Wikipedia"],
			});
			assert.equal(rawSelectMiss.isError, true);
			assert.equal(rawSelectMiss.details?.failureCategory, "selector-not-found");
			assert.doesNotMatch((rawSelectMiss.content[0] as { text: string }).text, /Current snapshot ref fallback|@e10/);
			const rawSelectMissNextActions = rawSelectMiss.details?.nextActions as Array<{ id?: string }> | undefined;
			assert.deepEqual(rawSelectMissNextActions?.map((action) => action.id), ["refresh-interactive-refs"]);

		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension suggests current snapshot refs when raw find role locators miss", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-find-ref-fallback-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://login.example/",
    refs: {
      e3: { role: "button", name: "Login" },
      e4: { role: "button", name: "Cancel" },
      e5: { role: "link", name: "Login" },
      e6: { role: "button", name: "Login later" }
    },
    snapshot: '- button "Login" [ref=e3]\\n- button "Cancel" [ref=e4]\\n- link "Login" [ref=e5]\\n- button "Login later" [ref=e6]'
  } }));
} else if (args.includes("find")) {
  process.stdout.write(JSON.stringify({ success: false, error: "Element not found" }));
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["find", "role", "button", "click", "--name", "Login"],
			});
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "selector-not-found");
			assert.match((result.content[0] as { text: string }).text, /Current snapshot ref fallback:/);
			assert.match((result.content[0] as { text: string }).text, /@e3 button "Login"/);
			assert.doesNotMatch((result.content[0] as { text: string }).text, /@e5 link "Login"/);
			assert.doesNotMatch((result.content[0] as { text: string }).text, /@e6 button "Login later"/);

			const visibleRefFallback = result.details?.visibleRefFallback as { candidates?: Array<{ ref?: string; role?: string; name?: string }> } | undefined;
			assert.deepEqual(visibleRefFallback?.candidates, [
				{
					action: "click",
					args: ["click", "@e3"],
					name: "Login",
					reason: 'Current snapshot shows button "Login" at @e3, matching the failed click locator exactly.',
					ref: "@e3",
					role: "button",
				},
			]);
			assert.deepEqual((result.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e3", "e4", "e5", "e6"]);

			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] }; safety?: string }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["refresh-interactive-refs", "try-current-visible-ref"]);
			assert.deepEqual(nextActions?.[1]?.params?.args?.slice(-2), ["click", "@e3"]);
			assert.match(nextActions?.[1]?.safety ?? "", /current snapshot/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("find")).length, 1);
			assert.equal(invocations.filter((entry) => entry.args.includes("snapshot")).length, 2);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns a safe semantic retry action only for stale-ref find shorthand failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-stale-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("find") || args.includes("select")) {
  process.stdout.write(JSON.stringify({ success: false, error: "Unknown ref @e4 while resolving locator" }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: "ok" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Export" },
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "stale-ref");
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] }; safety?: string }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["refresh-interactive-refs", "retry-semantic-action-after-stale-ref"]);
			assert.deepEqual(nextActions?.[1]?.params?.args, ["find", "text", "Export", "click"]);
			assert.match(nextActions?.[1]?.safety ?? "", /prior action did not execute|direct stale @refs/);

			const selectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", selector: "@e4", value: "find" },
			});
			assert.equal(selectResult.isError, true);
			assert.equal(selectResult.details?.failureCategory, "stale-ref");
			const selectNextActions = selectResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(selectNextActions?.map((action) => action.id), ["refresh-interactive-refs"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
