/**
 * Purpose: Verify semanticAction validation and current-ref recovery contracts.
 * Responsibilities: Assert semanticAction validation and exact current-ref recovery.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-semantic-recovery.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";

import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test(
	"agentBrowserExtension rejects incomplete semantic actions before spawning agent-browser",
	{ concurrency: false },
	async () => {
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

				for (const { semanticAction, error } of [
					{
						semanticAction: { action: "fill", locator: "label", value: "Email" },
						error: /semanticAction\.text is required for fill/,
					},
					{
						semanticAction: { action: "uncheck", locator: "label", value: "Agree terms" },
						error: /semanticAction\.action must be one of: check, click, fill, select/,
					},
					{
						semanticAction: { action: "click", locator: "text", value: "Export", name: "Export" },
						error: /semanticAction\.name is only supported/,
					},
					{
						semanticAction: { action: "click", locator: "role", role: "button", value: "link" },
						error: /semanticAction\.role must match value/,
					},
					{
						semanticAction: { action: "click", locator: "text", value: "Export", session: "" },
						error: /semanticAction\.session must be a non-empty string/,
					},
					{
						semanticAction: { action: "select", value: "chocolate" },
						error: /semanticAction\.selector or semanticAction\.locator is required for select/,
					},
					{
						semanticAction: { action: "select", selector: "#flavor" },
						error: /semanticAction\.value or semanticAction\.values is required for select/,
					},
					{
						semanticAction: {
							action: "select",
							locator: "placeholder",
							selector: "#flavor",
							value: "chocolate",
						},
						error: /selector cannot be combined with locator, role, or name for select/,
					},
				]) {
					// Validate each input before the next case; the final log asserts none dispatched.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, { semanticAction });
					// All eight literal invalid inputs must fail for their own compiler validation reason.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.isError, true, JSON.stringify(semanticAction));
					// All eight literal invalid inputs must fail for their own compiler validation reason.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(readString(readRecord(result.content[0]).text), error);
					// All eight literal invalid inputs must fail for their own compiler validation reason.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(result.details).failureCategory, "validation-error");
				}

				const invocations = await readInvocationLog(logPath);
				assert.deepEqual(invocations, []);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension returns rich input recovery when semanticAction fill misses current editable refs",
	{ concurrency: false },
	async () => {
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
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://search.example/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: {
							action: "fill",
							locator: "placeholder",
							value: "Search Wikipedia",
							text: "- [ ] item",
						},
					});

					assert.equal(result.isError, true);
					assert.equal(readRecord(result.details).failureCategory, "selector-not-found");
					const text = readRecord(result.content[0]);
					assert.match(readString(text.text), /Current snapshot ref fallback:/);
					assert.match(readString(text.text), /@e7 searchbox "Search Wikipedia"/);
					assert.doesNotMatch(readString(text.text), /@e6/);
					assert.match(readString(text.text), /@e8 textbox "Search Wikipedia"/);
					assert.match(readString(text.text), /@e13 textbox "Search Wikipedia"/);
					assert.doesNotMatch(readString(text.text), /@e9/);
					assert.doesNotMatch(readString(text.text), /@e14/);
					assert.match(readString(text.text), /Rich input recovery:/);
					assert.doesNotMatch(readString(text.text), /Agent-browser candidate fallbacks:/);
					assert.doesNotMatch(readString(text.text), /- \[ \] item/);
					const visibleRefFallback = readRecord(readRecord(result.details).visibleRefFallback);
					assert.equal(readRecord(visibleRefFallback.target).text, undefined);
					assert.ok(
						readArray(visibleRefFallback.candidates).every(
							(candidate) => readRecord(candidate).args === undefined,
						),
					);
					assert.ok(
						readArray(visibleRefFallback.candidates).every(
							(candidate) => readRecord(candidate).editableEvidence === undefined,
						),
					);
					const richInputRecovery = readRecord(readRecord(result.details).richInputRecovery);
					assert.deepEqual(
						readArray(richInputRecovery.candidates).map((candidate) => ({
							clickArgs: readRecord(candidate).clickArgs,
							focusArgs: readRecord(candidate).focusArgs,
							ref: readRecord(candidate).ref,
							role: readRecord(candidate).role,
						})),
						[
							{
								clickArgs: ["click", "@e7"],
								focusArgs: ["focus", "@e7"],
								ref: "@e7",
								role: "searchbox",
							},
							{
								clickArgs: ["click", "@e8"],
								focusArgs: ["focus", "@e8"],
								ref: "@e8",
								role: "textbox",
							},
							{
								clickArgs: ["click", "@e13"],
								focusArgs: ["focus", "@e13"],
								ref: "@e13",
								role: "textbox",
							},
						],
					);
					assert.match(
						readString(richInputRecovery.inputMethodHint ?? ""),
						/keyboard type when a framework-controlled editor requires real key events/,
					);
					assert.match(
						readString(richInputRecovery.inputMethodHint ?? ""),
						/keyboard inserttext is paste-like/,
					);
					const nextActions = readArray(readRecord(result.details).nextActions);
					assert.deepEqual(
						nextActions.map((action) => readRecord(action).id),
						[
							"refresh-interactive-refs",
							"focus-current-editable-ref-1",
							"click-current-editable-ref-1",
							"focus-current-editable-ref-2",
							"click-current-editable-ref-2",
							"focus-current-editable-ref-3",
							"click-current-editable-ref-3",
						],
					);
					assert.deepEqual(
						readArray(readRecord(readRecord(nextActions[1]).params).args).slice(-2),
						["focus", "@e7"],
					);
					assert.deepEqual(
						readArray(readRecord(readRecord(nextActions[2]).params).args).slice(-2),
						["click", "@e7"],
					);
					assert.deepEqual(
						readArray(readRecord(readRecord(nextActions[3]).params).args).slice(-2),
						["focus", "@e8"],
					);
					assert.deepEqual(
						readArray(readRecord(readRecord(nextActions[4]).params).args).slice(-2),
						["click", "@e8"],
					);
					assert.deepEqual(
						readArray(readRecord(readRecord(nextActions[5]).params).args).slice(-2),
						["focus", "@e13"],
					);
					assert.deepEqual(
						readArray(readRecord(readRecord(nextActions[6]).params).args).slice(-2),
						["click", "@e13"],
					);
					assert.match(
						readString(readRecord(nextActions[1]).safety ?? ""),
						/Several editable refs share/,
					);
					const invocationsAfterFirstMiss = await readInvocationLog(logPath);
					assert.equal(invocationsAfterFirstMiss.length, 4);
					assert.deepEqual(
						invocationsAfterFirstMiss.map((entry) => entry.args.slice(3)),
						[
							["snapshot", "-i"],
							["tab", "list"],
							["find", "placeholder", "Search Wikipedia", "fill", "- [ ] item"],
							["snapshot", "-i"],
						],
					);
					for (const action of nextActions) {
						// The preceding exact action-ID assertion proves this recovery list is nonempty before validating every payload.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(
							!readArray(readRecord(readRecord(action).params).args).includes("- [ ] item"),
						);
						// The preceding exact action-ID assertion proves this recovery list is nonempty before validating every payload.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(!readArray(readRecord(readRecord(action).params).args).includes("Enter"));
						// The preceding exact action-ID assertion proves this recovery list is nonempty before validating every payload.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.doesNotMatch(readString(readRecord(action).id ?? ""), /submit/i);
						// The preceding exact action-ID assertion proves this recovery list is nonempty before validating every payload.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.doesNotMatch(readString(readRecord(action).reason ?? ""), /agent browser/);
					}

					const rawDashFillMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["find", "placeholder", "Search Wikipedia", "fill", "- [ ] item"],
					});
					assert.equal(rawDashFillMiss.isError, true);
					assert.equal(readRecord(rawDashFillMiss.details).failureCategory, "selector-not-found");
					assert.match(
						readString(readRecord(rawDashFillMiss.content[0]).text),
						/Current snapshot ref fallback:/,
					);
					assert.match(
						readString(readRecord(rawDashFillMiss.content[0]).text),
						/Rich input recovery:/,
					);
					assert.match(
						readString(readRecord(rawDashFillMiss.content[0]).text),
						/@e7 searchbox "Search Wikipedia"/,
					);
					assert.doesNotMatch(
						readString(readRecord(rawDashFillMiss.content[0]).text),
						/- \[ \] item/,
					);
					const rawVisibleRefFallback = readRecord(
						readRecord(rawDashFillMiss.details).visibleRefFallback,
					);
					assert.equal(readRecord(rawVisibleRefFallback.target).text, undefined);
					assert.ok(
						readArray(rawVisibleRefFallback.candidates).every(
							(candidate) => readRecord(candidate).args === undefined,
						),
					);
					assert.ok(
						readArray(rawVisibleRefFallback.candidates).every(
							(candidate) => readRecord(candidate).editableEvidence === undefined,
						),
					);
					const rawNextActions = readArray(readRecord(rawDashFillMiss.details).nextActions);
					assert.ok(rawNextActions.length > 0);
					for (const action of rawNextActions) {
						// The nonempty raw recovery list is asserted above; validate every payload without skipping an empty list.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(
							!readArray(readRecord(readRecord(action).params).args).includes("- [ ] item"),
						);
					}

					const clickMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: { action: "click", locator: "text", value: "Search Wikipedia" },
					});
					assert.equal(clickMiss.isError, true);
					assert.equal(readRecord(clickMiss.details).failureCategory, "selector-not-found");
					assert.equal(readRecord(clickMiss.details).richInputRecovery, undefined);
					assert.match(
						readString(readRecord(clickMiss.content[0]).text),
						/Agent-browser candidate fallbacks:/,
					);
					assert.match(readString(readRecord(clickMiss.content[0]).text), /Next actions:/);
					assert.match(
						readString(readRecord(clickMiss.content[0]).text),
						/refresh-interactive-refs.*snapshot.*-i/,
					);
					assert.doesNotMatch(
						readString(readRecord(clickMiss.content[0]).text),
						/try-searchbox-name-candidate|try-textbox-name-candidate|try-labeled-textbox-candidate/,
					);
					const clickNextActions = readArray(readRecord(clickMiss.details).nextActions);
					assert.deepEqual(
						clickNextActions.map((action) => readRecord(action).id),
						[
							"refresh-interactive-refs",
							"try-current-visible-ref",
							"try-button-name-candidate",
							"try-link-name-candidate",
						],
					);
					assert.deepEqual(
						readArray(readRecord(readRecord(clickNextActions[1]).params).args).slice(-2),
						["click", "@e10"],
					);
					assert.deepEqual(readRecord(readRecord(clickNextActions[2]).params).args, [
						"find",
						"role",
						"button",
						"click",
						"--name",
						"Search Wikipedia",
					]);
					assert.deepEqual(readRecord(readRecord(clickNextActions[3]).params).args, [
						"find",
						"role",
						"link",
						"click",
						"--name",
						"Search Wikipedia",
					]);
					assert.ok(!JSON.stringify(clickNextActions).includes("agent browser"));

					const textFillMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: {
							action: "fill",
							locator: "text",
							value: "Composer",
							text: "private smoke prompt",
						},
					});
					assert.equal(textFillMiss.isError, true);
					assert.equal(readRecord(textFillMiss.details).failureCategory, "selector-not-found");
					assert.match(
						readString(readRecord(textFillMiss.content[0]).text),
						/Rich input recovery:/,
					);
					assert.match(
						readString(readRecord(textFillMiss.content[0]).text),
						/@e11 textbox "Composer"/,
					);
					assert.doesNotMatch(
						readString(readRecord(textFillMiss.content[0]).text),
						/private smoke prompt/,
					);
					const textFillRecovery = readRecord(readRecord(textFillMiss.details).richInputRecovery);
					assert.deepEqual(
						readArray(textFillRecovery.candidates).map((candidate) => ({
							clickArgs: readRecord(candidate).clickArgs,
							focusArgs: readRecord(candidate).focusArgs,
							ref: readRecord(candidate).ref,
							role: readRecord(candidate).role,
						})),
						[
							{
								clickArgs: ["click", "@e11"],
								focusArgs: ["focus", "@e11"],
								ref: "@e11",
								role: "textbox",
							},
						],
					);
					const textFillNextActions = readArray(readRecord(textFillMiss.details).nextActions);
					assert.deepEqual(
						textFillNextActions.map((action) => readRecord(action).id),
						[
							"refresh-interactive-refs",
							"focus-current-editable-ref",
							"click-current-editable-ref",
						],
					);
					for (const action of textFillNextActions) {
						// The preceding exact action-ID assertion proves this recovery list is nonempty before validating every payload.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(
							!readArray(readRecord(readRecord(action).params).args).includes(
								"private smoke prompt",
							),
						);
						// The preceding exact action-ID assertion proves this recovery list is nonempty before validating every payload.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(!readArray(readRecord(readRecord(action).params).args).includes("Enter"));
						// The preceding exact action-ID assertion proves this recovery list is nonempty before validating every payload.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.doesNotMatch(readString(readRecord(action).id ?? ""), /submit/i);
						// The preceding exact action-ID assertion proves this recovery list is nonempty before validating every payload.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.doesNotMatch(
							readString(readRecord(action).reason ?? ""),
							/private smoke prompt/,
						);
					}

					const selectMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: {
							action: "select",
							selector: "find",
							values: ["role", "button", "click", "--name", "Search Wikipedia"],
						},
					});
					assert.equal(selectMiss.isError, true);
					assert.equal(readRecord(selectMiss.details).failureCategory, "selector-not-found");
					assert.doesNotMatch(
						readString(readRecord(selectMiss.content[0]).text),
						/Current snapshot ref fallback|Agent-browser candidate fallbacks|@e10/,
					);
					const selectMissNextActions = readArray(readRecord(selectMiss.details).nextActions);
					assert.deepEqual(
						selectMissNextActions.map((action) => readRecord(action).id),
						["refresh-interactive-refs"],
					);

					const rawSelectMiss = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["select", "find", "role", "button", "click", "--name", "Search Wikipedia"],
					});
					assert.equal(rawSelectMiss.isError, true);
					assert.equal(readRecord(rawSelectMiss.details).failureCategory, "selector-not-found");
					assert.doesNotMatch(
						readString(readRecord(rawSelectMiss.content[0]).text),
						/Current snapshot ref fallback|@e10/,
					);
					const rawSelectMissNextActions = readArray(readRecord(rawSelectMiss.details).nextActions);
					assert.deepEqual(
						rawSelectMissNextActions.map((action) => readRecord(action).id),
						["refresh-interactive-refs"],
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension suggests current snapshot refs when raw find role locators miss",
	{ concurrency: false },
	async () => {
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
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://login.example/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["find", "role", "button", "click", "--name", "Login"],
					});
					assert.equal(result.isError, true);
					assert.equal(readRecord(result.details).failureCategory, "selector-not-found");
					assert.match(
						readString(readRecord(result.content[0]).text),
						/Current snapshot ref fallback:/,
					);
					assert.match(readString(readRecord(result.content[0]).text), /@e3 button "Login"/);
					assert.doesNotMatch(readString(readRecord(result.content[0]).text), /@e5 link "Login"/);
					assert.doesNotMatch(
						readString(readRecord(result.content[0]).text),
						/@e6 button "Login later"/,
					);

					const visibleRefFallback = readRecord(readRecord(result.details).visibleRefFallback);
					assert.deepEqual(visibleRefFallback.candidates, [
						{
							action: "click",
							args: ["click", "@e3"],
							name: "Login",
							reason:
								'Current snapshot shows button "Login" at @e3, matching the failed click locator exactly.',
							ref: "@e3",
							role: "button",
						},
					]);
					assert.equal(readRecord(result.details).refSnapshot, undefined);
					assert.deepEqual(
						SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch()).get(
							readString(readRecord(result.details).sessionName),
						).refSnapshot?.refIds,
						["e3", "e4", "e5", "e6"],
					);

					const nextActions = readArray(readRecord(result.details).nextActions);
					assert.deepEqual(
						nextActions.map((action) => readRecord(action).id),
						["refresh-interactive-refs", "try-current-visible-ref"],
					);
					assert.deepEqual(
						readArray(readRecord(readRecord(nextActions[1]).params).args).slice(-2),
						["click", "@e3"],
					);
					assert.match(readString(readRecord(nextActions[1]).safety ?? ""), /current snapshot/);

					const invocations = await readInvocationLog(logPath);
					assert.equal(invocations.filter((entry) => entry.args.includes("find")).length, 1);
					assert.equal(invocations.filter((entry) => entry.args.includes("snapshot")).length, 2);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension offers current ref fallback for failed semantic find steps inside batch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-semantic-ref-fallback-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("snapshot")) {
    process.stdout.write(JSON.stringify({ success: true, data: {
      origin: "file:///stress.html",
      refs: { e18: { role: "button", name: "Shadow action" }, e107: { role: "button", name: "Frame button" } },
      snapshot: '- button "Shadow action" [ref=e18]\\n- button "Frame button" [ref=e107]'
    } }));
    return;
  }
  if (args.includes("batch")) {
    const steps = JSON.parse(stdin);
    process.stdout.write(JSON.stringify({ success: false, data: steps.map((command, index) => index === 0 ? { command, success: false, error: "Element not found" } : { command, success: true, result: { ok: true } }) }));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
});`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([["find", "role", "button", "click", "--name", "Shadow action"]]),
				});

				assert.equal(result.isError, true);
				assert.equal(readRecord(result.details).failureCategory, "selector-not-found");
				assert.match(
					readString(readRecord(result.content[0]).text),
					/Current snapshot ref fallback:/,
				);
				assert.match(readString(readRecord(result.content[0]).text), /@e18 button "Shadow action"/);
				const nextActions = readArray(readRecord(result.details).nextActions);
				assert.ok(
					nextActions.some(
						(action) =>
							readRecord(action).id === "try-current-visible-ref" &&
							readArray(readRecord(readRecord(action).params).args).at(-1) === "@e18",
					),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension returns a safe semantic retry action only for stale-ref find shorthand failures",
	{ concurrency: false },
	async () => {
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
				assert.equal(readRecord(result.details).failureCategory, "stale-ref");
				const nextActions = readArray(readRecord(result.details).nextActions);
				assert.deepEqual(
					nextActions.map((action) => readRecord(action).id),
					["refresh-interactive-refs", "retry-semantic-action-after-stale-ref"],
				);
				assert.deepEqual(readRecord(readRecord(nextActions[1]).params).args, [
					"find",
					"text",
					"Export",
					"click",
				]);
				assert.match(
					readString(readRecord(nextActions[1]).safety ?? ""),
					/prior action did not execute|direct stale @refs/,
				);

				const selectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					semanticAction: { action: "select", selector: "@e4", value: "find" },
				});
				assert.equal(selectResult.isError, true);
				assert.equal(readRecord(selectResult.details).failureCategory, "stale-ref");
				const selectNextActions = readArray(readRecord(selectResult.details).nextActions);
				assert.deepEqual(
					selectNextActions.map((action) => readRecord(action).id),
					["refresh-interactive-refs"],
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
