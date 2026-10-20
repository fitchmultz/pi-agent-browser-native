/**
 * Purpose: Verify common input validation and high-level compilation at the extension entrypoint.
 * Responsibilities: Assert mode exclusivity, lookup shapes/stdin, semanticAction, visible-ref semantic resolution, native batch, and lightweight QA contracts.
 * Scope: Integration-style Node test-runner coverage; source/network lookup execution and semantic recovery retain focused owners.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-input-modes.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { readRecord, readString, readArray } from "./helpers/assertions.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { Check } from "typebox/value";

import {
	analyzeQaPresetResults,
	analyzeQaPresetTimeout,
	compileAgentBrowserQaPreset,
} from "../extensions/agent-browser/lib/input-modes/job.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
	type AgentBrowserToolParams,
} from "./helpers/agent-browser-harness.js";

test(
	"agentBrowserExtension rejects invalid lookup shapes, mixed input modes, and caller stdin before dispatch",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-input-modes-invalid-"));
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
				const exclusiveModeMessage =
					/Provide exactly one of args, semanticAction, qa, sourceLookup, networkSourceLookup, or electron/;
				const lookupStdinMessage =
					/Do not provide stdin with qa, sourceLookup, or networkSourceLookup/;
				const cases: Array<{
					label: string;
					params: AgentBrowserToolParams;
					message: RegExp;
					excludedMessage?: RegExp;
				}> = [
					{
						label: "args with semanticAction",
						params: {
							args: ["click", "@e1"],
							semanticAction: { action: "click", locator: "text", value: "Export" },
						},
						message: exclusiveModeMessage,
					},
					{
						label: "empty sourceLookup",
						params: { sourceLookup: {} },
						message: /sourceLookup requires selector, reactFiberId, or componentName/,
					},
					{
						label: "oversized sourceLookup",
						params: { sourceLookup: { componentName: "Panel", maxWorkspaceFiles: 5001 } },
						message: /maxWorkspaceFiles must be 5000 or less/,
					},
					{
						label: "sourceLookup with args",
						params: { args: ["react", "tree"], sourceLookup: { componentName: "Panel" } },
						message: exclusiveModeMessage,
					},
					{
						label: "qa with stdin",
						params: { qa: { url: "https://example.com" }, stdin: "[]" },
						message: lookupStdinMessage,
					},
					{
						label: "sourceLookup with stdin",
						params: { sourceLookup: { componentName: "Panel" }, stdin: "[]" },
						message: lookupStdinMessage,
					},
					{
						label: "networkSourceLookup with args",
						params: { args: ["network", "requests"], networkSourceLookup: { url: "/api/fail" } },
						message: exclusiveModeMessage,
					},
					{
						label: "networkSourceLookup with stdin",
						params: { networkSourceLookup: { url: "/api/fail" }, stdin: "[]" },
						message: lookupStdinMessage,
					},
					{
						label: "empty networkSourceLookup",
						params: { networkSourceLookup: {} },
						message: /networkSourceLookup requires requestId, filter, or url/,
					},
					{
						label: "electron with args",
						params: { args: ["open", "https://example.test/"], electron: { action: "list" } },
						message: exclusiveModeMessage,
					},
					{
						label: "electron with semanticAction",
						params: {
							semanticAction: { action: "click", locator: "text", value: "Export" },
							electron: { action: "list" },
						},
						message: exclusiveModeMessage,
					},
					{
						label: "electron with qa",
						params: { qa: { url: "https://example.test/" }, electron: { action: "list" } },
						message: exclusiveModeMessage,
					},
					{
						label: "electron with sourceLookup",
						params: { sourceLookup: { componentName: "Panel" }, electron: { action: "list" } },
						message: exclusiveModeMessage,
					},
					{
						label: "electron with networkSourceLookup",
						params: { networkSourceLookup: { url: "/api" }, electron: { action: "list" } },
						message: exclusiveModeMessage,
					},
					{
						label: "electron with stdin",
						params: { electron: { action: "list" }, stdin: "[]" },
						message:
							/Do not provide stdin with electron; electron mode is host-only or manages its own input\./,
						excludedMessage: /job, qa, sourceLookup, or networkSourceLookup/,
					},
				];
				for (const { label, params, message, excludedMessage } of cases) {
					// Cases share the dispatch log; validate one no-dispatch outcome before advancing.
					// oxlint-disable-next-line no-await-in-loop
					await t.test(label, async () => {
						const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
						assert.equal(result.isError, true, label);
						assert.match(readString(readRecord(result.content.at(0)).text), message, label);
						if (excludedMessage) {
							// Each fixed failure checks its required message; this variant also forbids misleading copy.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.doesNotMatch(
								readString(readRecord(result.content.at(0)).text),
								excludedMessage,
								label,
							);
						}
						assert.equal(readRecord(result.details).resultCategory, "failure", label);
						assert.equal(readRecord(result.details).failureCategory, "validation-error", label);
						assert.deepEqual(
							await readInvocationLog(logPath),
							[],
							`${label}: upstream must not dispatch`,
						);
					});
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("analyzeQaPresetTimeout reports unverified expected-text timeouts as QA failures", () => {
	const compiled = compileAgentBrowserQaPreset({
		url: "https://example.test/",
		expectedText: "Definitely Not On This Page",
	}).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetTimeout(compiled);
	assert.ok(analysis);
	assert.equal(analysis.passed, false);
	assert.deepEqual(analysis.failedChecks, [
		'expected text was not verified before timeout: "Definitely Not On This Page"',
	]);
	assert.deepEqual(analysis.notRunChecks, []);
	assert.match(analysis.summary, /QA preset failed/);
});

test("QA visible-text predicates follow computed visibility without requiring ancestor boxes", async (t) => {
	class Element {
		readonly tagName: string;
		readonly parentElement: Readonly<Element> | null;
		readonly value: string;
		readonly style: {
			readonly display: string;
			readonly visibility: string;
			readonly opacity: string;
		};
		constructor(
			value: string,
			parentElement: Readonly<Element> | null = null,
			style: Partial<Element["style"]> = {},
			tagName = "INPUT",
		) {
			this.tagName = tagName;
			this.parentElement = parentElement;
			this.value = value;
			this.style = { display: "block", visibility: "visible", opacity: "1", ...style };
		}
		getClientRects() {
			return this.style.display === "contents" || this.style.display === "none" ? [] : [{}];
		}
	}
	const root = new Element("", null, {}, "BODY");
	const transparentParent = new Element("", root, { opacity: "0" }, "DIV");
	const contentsParent = new Element("", root, { display: "contents" }, "DIV");
	const invisibleParent = new Element("", root, { visibility: "hidden" }, "DIV");
	const undisplayedParent = new Element("", root, { display: "none" }, "DIV");
	const visibleInput = new Element("Visible control", root);
	const hiddenInput = new Element("Hidden control", transparentParent);
	const contentsInput = new Element("Contents control", contentsParent);
	const overriddenInput = new Element("Overridden control", invisibleParent, {
		visibility: "visible",
	});
	const undisplayedInput = new Element("Undisplayed control", undisplayedParent);
	const nodes = [
		{ parentElement: root, nodeValue: "Visible   heading" },
		{ parentElement: transparentParent, nodeValue: "Hidden heading" },
		{ parentElement: contentsParent, nodeValue: "Contents text" },
		{ parentElement: invisibleParent, nodeValue: "Invisible text" },
		{ parentElement: undisplayedParent, nodeValue: "Undisplayed text" },
		{ parentElement: new Element("", root, {}, "SCRIPT"), nodeValue: "Script text" },
		{ parentElement: new Element("", root, {}, "STYLE"), nodeValue: "Style text" },
		{ parentElement: new Element("", root, {}, "SVG"), nodeValue: "Svg text" },
	];
	const elements = [visibleInput, hiddenInput, contentsInput, overriddenInput, undisplayedInput];
	const context = {
		HTMLElement: Element,
		NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
		window: { getComputedStyle: (element: Readonly<Element>) => element.style },
		document: {
			body: root,
			createTreeWalker: (_root: unknown, whatToShow: number) => {
				const iterator = (whatToShow === 4 ? nodes : elements)[Symbol.iterator]();
				return { nextNode: () => iterator.next().value ?? null };
			},
		},
	};
	const cases = [
		{ text: "Visible heading", visible: true },
		{ text: "Visible control", visible: true },
		{ text: "Hidden heading", visible: false },
		{ text: "Hidden control", visible: false },
		{ text: "Contents control", visible: true },
		{ text: "Overridden control", visible: true },
		{ text: "Contents text", visible: true },
		{ text: "Invisible text", visible: false },
		{ text: "Undisplayed control", visible: false },
		{ text: "Undisplayed text", visible: false },
		{ text: "Script text", visible: false },
		{ text: "Style text", visible: false },
		{ text: "Svg text", visible: false },
	];
	const compiled = compileAgentBrowserQaPreset({
		attached: true,
		expectedText: cases.map(({ text }) => text),
	}).compiled;
	assert.ok(compiled);
	const predicates = compiled.steps.filter((step) => step.action === "assertText");
	assert.equal(predicates.length, cases.length);
	await Promise.all(
		cases.map(({ text, visible }, index) =>
			t.test(text, () => {
				const observed: unknown = runInNewContext(predicates[index].args[2], context);
				assert.equal(observed, visible);
			}),
		),
	);
});

test("analyzeQaPresetResults reports missing expected text as QA failure", () => {
	const compiled = compileAgentBrowserQaPreset({
		url: "https://example.test/",
		expectedText: "Definitely Not On This Page",
		checkConsole: false,
		checkErrors: false,
		checkNetwork: false,
	}).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetResults(
		[
			{
				command: ["open", "https://example.test/"],
				success: true,
				result: { title: "Example", url: "https://example.test/" },
			},
			{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
			{ command: compiled.steps[2]?.args, success: true, result: { result: false } },
		],
		compiled,
	);
	assert.ok(analysis);
	assert.equal(analysis.passed, false);
	assert.deepEqual(analysis.failedChecks, [
		'expected text not found: "Definitely Not On This Page"',
	]);
	assert.deepEqual(analysis.notRunChecks, []);
});

test("analyzeQaPresetResults reports checks after a fail-fast open failure as not run", () => {
	const compiled = compileAgentBrowserQaPreset({
		url: "https://example.test/",
		expectedText: ["First expected text", "Second expected text", "Third expected text"],
	}).compiled;
	assert.ok(compiled);
	assert.equal(compiled.steps.length, 13);
	const analysis = analyzeQaPresetResults(
		[
			{ command: ["network", "requests", "--clear"], success: true, result: { requests: [] } },
			{ command: ["console", "--clear"], success: true, result: { messages: [] } },
			{ command: ["errors", "--clear"], success: true, result: { errors: [] } },
			{ command: ["errors"], success: true, result: { errors: [] } },
			{ command: ["open", "https://example.test/"], success: false, error: "Navigation failed" },
		],
		compiled,
	);
	assert.ok(analysis);
	assert.deepEqual(analysis.failedChecks, ["open failed"]);
	assert.deepEqual(analysis.notRunChecks, [
		"load state: domcontentloaded",
		'expected text: "First expected text"',
		'expected text: "Second expected text"',
		'expected text: "Third expected text"',
		"network diagnostics",
		"console diagnostics",
		"page error diagnostics",
	]);
	assert.equal(analysis.summary, "QA preset failed: open failed.");
});

test("analyzeQaPresetResults distinguishes an executed text assertion from later checks not run", () => {
	const compiled = compileAgentBrowserQaPreset({
		url: "https://example.test/",
		expectedText: "Missing text",
		expectedSelector: "main",
		screenshotPath: "qa.png",
	}).compiled;
	assert.ok(compiled);
	const assertionStep = compiled.steps.find((step) => step.action === "assertText");
	assert.ok(assertionStep);
	const analysis = analyzeQaPresetResults(
		[
			{ command: ["network", "requests", "--clear"], success: true, result: { requests: [] } },
			{ command: ["console", "--clear"], success: true, result: { messages: [] } },
			{ command: ["errors", "--clear"], success: true, result: { errors: [] } },
			{ command: ["errors"], success: true, result: { errors: [] } },
			{
				command: ["open", "https://example.test/"],
				success: true,
				result: { url: "https://example.test/" },
			},
			{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
			{ command: ["wait", "150"], success: true, result: { ok: true } },
			{ command: assertionStep.args, success: false, error: "Timed out waiting for text" },
		],
		compiled,
	);
	assert.ok(analysis);
	assert.deepEqual(analysis.failedChecks, [
		"wait failed",
		'expected text not found: "Missing text"',
	]);
	assert.deepEqual(analysis.notRunChecks, [
		'expected selector: "main"',
		"network diagnostics",
		"console diagnostics",
		"page error diagnostics",
		'screenshot: "qa.png"',
	]);
});

test("analyzeQaPresetResults does not infer unreached checks from incomplete successful receipts", () => {
	const compiled = compileAgentBrowserQaPreset({
		url: "https://example.test/",
		expectedText: "Welcome",
	}).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetResults(
		[{ command: ["network", "requests", "--clear"], success: true, result: { requests: [] } }],
		compiled,
	);
	assert.ok(analysis);
	assert.equal(analysis.passed, false);
	assert.deepEqual(analysis.notRunChecks, []);
	assert.deepEqual(analysis.failedChecks, [
		"QA execution could not be verified (incomplete batch results)",
	]);
});

test("analyzeQaPresetResults ignores reset-phase diagnostic rows for URL QA", () => {
	const compiled = compileAgentBrowserQaPreset({
		url: "https://example.test/",
		expectedText: "Example Domain",
	}).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetResults(
		[
			{
				command: ["network", "requests", "--clear"],
				success: true,
				result: { requests: [{ method: "GET", status: 500, url: "https://old.example.test/api" }] },
			},
			{
				command: ["console", "--clear"],
				success: true,
				result: { messages: [{ text: "old console boom", type: "error" }] },
			},
			{
				command: ["errors", "--clear"],
				success: true,
				result: { errors: [{ text: "old ReferenceError" }] },
			},
			{ command: ["errors"], success: true, result: { errors: [] } },
			{
				command: ["open", "https://example.test/"],
				success: true,
				result: { title: "Example", url: "https://example.test/" },
			},
			{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
			{ command: ["wait", "150"], success: true, result: { ok: true } },
			{
				command: [
					"wait",
					"--fn",
					compiled.steps.find((step) => step.action === "assertText")?.args[2] ?? "",
					"--timeout",
					"5000",
				],
				success: true,
				result: true,
			},
			{ command: ["network", "requests"], success: true, result: { requests: [] } },
			{ command: ["console"], success: true, result: { messages: [] } },
			{ command: ["errors"], success: true, result: { errors: [] } },
		],
		compiled,
	);
	assert.ok(analysis);
	assert.equal(analysis.passed, true);
	assert.deepEqual(analysis.failedChecks, []);
});

test("analyzeQaPresetResults treats failed reset-phase diagnostic rows as step failures only", () => {
	const compiled = compileAgentBrowserQaPreset({ url: "https://example.test/" }).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetResults(
		[
			{
				command: ["network", "requests", "--clear"],
				error: "clear failed",
				success: false,
				result: { requests: [{ method: "GET", status: 500, url: "https://old.example.test/api" }] },
			},
			{
				command: ["console", "--clear"],
				error: "clear failed",
				success: false,
				result: { messages: [{ text: "old console boom", type: "error" }] },
			},
			{
				command: ["errors", "--clear"],
				error: "clear failed",
				success: false,
				result: { errors: [{ text: "old ReferenceError" }] },
			},
			{ command: ["errors"], success: true, result: { errors: [{ text: "old ReferenceError" }] } },
			{
				command: ["open", "https://example.test/"],
				success: true,
				result: { title: "Example", url: "https://example.test/" },
			},
			{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
			{ command: ["wait", "150"], success: true, result: { ok: true } },
			{ command: ["network", "requests"], success: true, result: { requests: [] } },
			{ command: ["console"], success: true, result: { messages: [] } },
			{ command: ["errors"], success: true, result: { errors: [] } },
		],
		compiled,
	);
	assert.ok(analysis);
	assert.equal(analysis.passed, false);
	assert.deepEqual(analysis.failedChecks, ["network failed", "console failed", "errors failed"]);
});

test("analyzeQaPresetResults still reports post-open page errors", () => {
	const compiled = compileAgentBrowserQaPreset({ url: "https://example.test/" }).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetResults(
		[
			{ command: ["network", "requests", "--clear"], success: true, result: { requests: [] } },
			{ command: ["console", "--clear"], success: true, result: { messages: [] } },
			{
				command: ["errors", "--clear"],
				success: true,
				result: { errors: [{ text: "old ReferenceError" }] },
			},
			{ command: ["errors"], success: true, result: { errors: [] } },
			{
				command: ["open", "https://example.test/"],
				success: true,
				result: { title: "Example", url: "https://example.test/" },
			},
			{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
			{ command: ["wait", "150"], success: true, result: { ok: true } },
			{ command: ["network", "requests"], success: true, result: { requests: [] } },
			{ command: ["console"], success: true, result: { messages: [] } },
			{ command: ["errors"], success: true, result: { errors: [{ text: "current page boom" }] } },
		],
		compiled,
	);
	assert.ok(analysis);
	assert.equal(analysis.passed, false);
	assert.deepEqual(analysis.failedChecks, ["1 page error(s)"]);
});

test("analyzeQaPresetResults fails unverified matched page-error evidence when clear is a no-op", () => {
	const compiled = compileAgentBrowserQaPreset({
		url: "https://clean.example.test/",
		checkConsole: false,
		checkNetwork: false,
	}).compiled;
	assert.ok(compiled);
	const staleError = {
		message: "old ReferenceError",
		stack: "at https://old.example.test/app.js:1:1",
	};
	const analysis = analyzeQaPresetResults(
		[
			{ command: ["errors", "--clear"], success: true, result: { errors: [staleError] } },
			{ command: ["errors"], success: true, result: { errors: [staleError] } },
			{
				command: ["open", "https://clean.example.test/"],
				success: true,
				result: { url: "https://clean.example.test/" },
			},
			{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
			{ command: ["wait", "150"], success: true, result: { ok: true } },
			{ command: ["errors"], success: true, result: { errors: [staleError] } },
		],
		compiled,
	);
	assert.ok(analysis);
	assert.equal(analysis.passed, false);
	assert.deepEqual(analysis.failedChecks, [
		"page-error check could not be verified (1 row(s) matched the post-clear baseline; old residue and identical new errors are indistinguishable)",
	]);
	assert.deepEqual(analysis.warnings, []);
	assert.doesNotMatch(analysis.summary, /passed|unchanged|1 page error\(s\)/);
});

test("analyzeQaPresetResults separates novel page errors from ambiguous matching rows", () => {
	const compiled = compileAgentBrowserQaPreset({
		url: "https://target.example.test/",
		checkConsole: false,
		checkNetwork: false,
	}).compiled;
	assert.ok(compiled);
	const error = { text: "repeated error" };
	const analysis = analyzeQaPresetResults(
		compiled.steps.map((step) => ({
			command: step.args,
			success: true,
			result:
				step.args[0] === "errors"
					? {
							errors:
								step.args.includes("--clear") || step.generatedFrom === "qa.errorBaselineAfterClear"
									? [error]
									: [error, error],
						}
					: { ok: true },
		})),
		compiled,
	);
	assert.ok(analysis);
	assert.equal(analysis.passed, false);
	assert.deepEqual(analysis.failedChecks, [
		"1 page error(s)",
		"page-error check could not be verified (1 row(s) matched the post-clear baseline; old residue and identical new errors are indistinguishable)",
	]);
	assert.deepEqual(analysis.warnings, []);
});

test("analyzeQaPresetResults reports a new matching error after a successful clear", () => {
	const compiled = compileAgentBrowserQaPreset({
		url: "https://target.example.test/",
		checkConsole: false,
		checkNetwork: false,
	}).compiled;
	assert.ok(compiled);
	const repeatedError = {
		message: "ReferenceError",
		stack: "at https://shared.example/app.js:1:1",
	};
	const analysis = analyzeQaPresetResults(
		[
			{ command: ["errors", "--clear"], success: true, result: { errors: [repeatedError] } },
			{ command: ["errors"], success: true, result: { errors: [] } },
			{
				command: ["open", "https://target.example.test/"],
				success: true,
				result: { url: "https://target.example.test/" },
			},
			{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
			{ command: ["wait", "150"], success: true, result: { ok: true } },
			{ command: ["errors"], success: true, result: { errors: [repeatedError] } },
		],
		compiled,
	);
	assert.ok(analysis);
	assert.equal(analysis.passed, false);
	assert.deepEqual(analysis.failedChecks, ["1 page error(s)"]);
});

test(
	"agentBrowserExtension compiles semantic actions to upstream find commands",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-action-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { args, title: "Clicked", url: "https://example.test/" } }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const sessionClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					semanticAction: { action: "click", locator: "text", value: "Close", session: "named" },
				});
				assert.equal(sessionClickResult.isError, false);
				assert.deepEqual(readRecord(sessionClickResult.details).compiledSemanticAction, {
					action: "click",
					locator: "text",
					args: ["--session", "named", "find", "text", "Close", "click"],
				});
				assert.equal(readRecord(sessionClickResult.details).sessionName, "named");

				const selectorFillResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					semanticAction: { action: "fill", selector: "@e1", text: "selector text" },
				});
				assert.equal(selectorFillResult.isError, false);
				assert.deepEqual(readRecord(selectorFillResult.details).compiledSemanticAction, {
					action: "fill",
					selector: "@e1",
					args: ["fill", "@e1", "selector text"],
				});

				const selectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					semanticAction: {
						action: "select",
						selector: "#flavor-select",
						value: "chocolate",
						session: "named",
					},
				});
				assert.equal(selectResult.isError, false);
				assert.deepEqual(readRecord(selectResult.details).compiledSemanticAction, {
					action: "select",
					selector: "#flavor-select",
					values: ["chocolate"],
					args: ["--session", "named", "select", "#flavor-select", "chocolate"],
				});
				assert.equal(readRecord(selectResult.details).sessionName, "named");

				const invocationLog = await readInvocationLog(logPath);
				assert.deepEqual(
					invocationLog
						.filter((entry) => entry.args.includes("find"))
						.map((entry) => entry.args.slice(-6)),
					[["--session", "named", "find", "text", "Close", "click"]],
				);
				assert.deepEqual(
					invocationLog
						.find((entry) => entry.args.at(-3) === "fill" && entry.args.at(-2) === "@e1")
						?.args.slice(-3),
					["fill", "@e1", "selector text"],
				);
				const selectInvocation = invocationLog.find((entry) => entry.args.includes("select"));
				assert.deepEqual(selectInvocation?.args.slice(-5), [
					"--session",
					"named",
					"select",
					"#flavor-select",
					"chocolate",
				]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension warns when contenteditable fill does not replace existing text",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-contenteditable-fill-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const command = args.find((arg) => ["open", "snapshot", "fill", "get"].includes(arg));
if (command === "open") {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Editor", url: "https://editor.example.test/" } }));
} else if (command === "snapshot") {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://editor.example.test/",
    refs: { e1: { role: "generic", name: "Composer", contenteditable: true } },
    snapshot: '- generic "Composer" [ref=e1] contenteditable=true'
  } }));
} else if (command === "fill") {
  process.stdout.write(JSON.stringify({ success: true, data: { filled: "@e1" } }));
} else if (command === "get") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "contenteditable replacededit me" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://editor.example.test/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					assert.equal(
						(
							await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["open", "https://editor.example.test/"],
							})
						).isError,
						false,
					);
					assert.equal(
						(await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] }))
							.isError,
						false,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["fill", "@e1", "contenteditable replaced"],
					});
					assert.equal(result.isError, false, JSON.stringify(result));
					assert.match(
						readString(readRecord(result.content.at(0)).text),
						/Contenteditable fill may append or prepend/,
					);
					assert.deepEqual(readRecord(result.details).fillVerification, {
						actual: "contenteditable replacededit me",
						expected: "contenteditable replaced",
						method: "text",
						nextActionIds: ["inspect-after-fill-verification", "verify-filled-value"],
						reason: "contenteditable-fill-mismatch",
						selector: "@e1",
						status: "mismatch",
						summary:
							'Fill verification warning: fill @e1 reported success, but get text returned "contenteditable replacededit me".',
					});
					assert.ok(
						readArray(readRecord(result.details).nextActions)
							.map(readRecord)
							.some((action) => action.id === "verify-filled-value"),
					);
					const invocations = await readInvocationLog(logPath);
					assert.ok(
						invocations.some(
							(entry) =>
								entry.args.includes("get") &&
								entry.args.includes("text") &&
								entry.args.includes("@e1"),
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
	"agentBrowserExtension resolves semantic role clicks through current visible snapshot refs when available",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-visible-ref-"));
		const logPath = join(tempDir, "invocations.log");
		const snapshotCountPath = join(tempDir, "snapshot-count.txt");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Docs", url: "https://docs.example.test/" } }));
} else if (args.includes("snapshot")) {
  const statePath = ${JSON.stringify(snapshotCountPath)};
  const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
  fs.writeFileSync(statePath, String(count + 1));
  const refs = count === 0
    ? { e2: { role: "button", name: "Old Search Documentation" } }
    : { e17: { role: "button", name: "Search Documentation" } };
  const snapshot = count === 0
    ? '- button "Old Search Documentation" [ref=e2]'
    : '- button "Search Documentation" [ref=e17]';
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://docs.example.test/",
    refs,
    snapshot
  } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e17" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Docs" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://docs.example.test/" } }));
} else if (args.includes("find")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "[data-agent-browser-located='true']" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://docs.example.test/"],
				});
				assert.equal(open.isError, false);
				const oldSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(oldSnapshot.isError, false);
				assert.deepEqual(readRecord(readRecord(oldSnapshot.details).refSnapshot).refIds, ["e2"]);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					semanticAction: {
						action: "click",
						locator: "role",
						value: "button",
						name: "Search Documentation",
					},
				});
				assert.equal(result.isError, false);
				assert.deepEqual(readRecord(result.details).compiledSemanticAction, {
					action: "click",
					locator: "role",
					args: ["find", "role", "button", "click", "--name", "Search Documentation"],
				});
				assert.deepEqual(readArray(readRecord(result.details).effectiveArgs).slice(-2), [
					"click",
					"@e17",
				]);
				const invocations = await readInvocationLog(logPath);
				assert.ok(invocations.some((entry) => entry.args.includes("snapshot")));
				assert.ok(
					invocations.some(
						(entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e17",
					),
				);
				assert.equal(
					invocations.some((entry) => entry.args.includes("find")),
					false,
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension resolves semantic locator select through current visible combobox refs",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-select-ref-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Shop", url: "https://shop.example.test/" } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://shop.example.test/",
    refs: { e4: { role: "combobox", name: "Flavor" } },
    snapshot: '- combobox "Flavor" [ref=e4]'
  } }));
} else if (args.includes("select")) {
  process.stdout.write(JSON.stringify({ success: true, data: { selected: args.at(-1) } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://shop.example.test/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					assert.equal(
						(
							await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["open", "https://shop.example.test/"],
							})
						).isError,
						false,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: {
							action: "select",
							locator: "role",
							role: "combobox",
							name: "Flavor",
							value: "chocolate",
						},
					});
					assert.equal(result.isError, false);
					assert.deepEqual(readRecord(result.details).compiledSemanticAction, {
						action: "select",
						locator: "role",
						values: ["chocolate"],
						args: ["select", "@e4", "chocolate"],
					});
					assert.deepEqual(readArray(readRecord(result.details).effectiveArgs).slice(-3), [
						"select",
						"@e4",
						"chocolate",
					]);
					const dashOption = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: {
							action: "select",
							locator: "role",
							role: "combobox",
							name: "Flavor",
							value: "-1",
						},
					});
					assert.equal(dashOption.isError, false, JSON.stringify(dashOption));
					assert.deepEqual(readArray(readRecord(dashOption.details).effectiveArgs).slice(-3), [
						"select",
						"@e4",
						"-1",
					]);
					const invocations = await readInvocationLog(logPath);
					assert.ok(
						invocations.some(
							(entry) =>
								entry.args.at(-3) === "select" &&
								entry.args.at(-2) === "@e4" &&
								entry.args.at(-1) === "chocolate",
						),
					);
					assert.ok(
						invocations.some(
							(entry) =>
								entry.args.at(-3) === "select" &&
								entry.args.at(-2) === "@e4" &&
								entry.args.at(-1) === "-1",
						),
					);
					assert.equal(
						invocations.some((entry) => entry.args.includes("find")),
						false,
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension resolves semantic role fills through fresh refs instead of the stored snapshot",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-fill-fresh-ref-"));
		const logPath = join(tempDir, "invocations.log");
		const snapshotCountPath = join(tempDir, "snapshot-count.txt");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Docs", url: "https://docs.example.test/" } }));
} else if (args.includes("snapshot")) {
  const statePath = ${JSON.stringify(snapshotCountPath)};
  const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
  fs.writeFileSync(statePath, String(count + 1));
  const refs = count === 0
    ? { e2: { role: "textbox", name: "Old Search Documentation" } }
    : { e17: { role: "textbox", name: "Search Documentation" } };
  const snapshot = count === 0
    ? '- textbox "Old Search Documentation" [ref=e2]'
    : '- textbox "Search Documentation" [ref=e17]';
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://docs.example.test/", refs, snapshot } }));
} else if (args.includes("fill")) {
  process.stdout.write(JSON.stringify({ success: true, data: { filled: "@e17" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://docs.example.test/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					assert.equal(
						(
							await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["open", "https://docs.example.test/"],
							})
						).isError,
						false,
					);
					assert.equal(
						(await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] }))
							.isError,
						false,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: {
							action: "fill",
							locator: "role",
							role: "textbox",
							name: "Search Documentation",
							text: "query",
						},
					});
					assert.equal(result.isError, false, JSON.stringify(result));
					assert.deepEqual(readRecord(result.details).compiledSemanticAction, {
						action: "fill",
						locator: "role",
						args: ["find", "role", "textbox", "fill", "query", "--name", "Search Documentation"],
					});
					assert.deepEqual(readArray(readRecord(result.details).effectiveArgs).slice(-3), [
						"fill",
						"@e17",
						"query",
					]);
					const invocations = await readInvocationLog(logPath);
					assert.equal(invocations.filter((entry) => entry.args.includes("snapshot")).length, 2);
					assert.equal(
						invocations.some((entry) => entry.args.includes("find")),
						false,
					);
					assert.ok(
						invocations.some(
							(entry) =>
								entry.args.at(-3) === "fill" &&
								entry.args.at(-2) === "@e17" &&
								entry.args.at(-1) === "query",
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
	"native batch preserves form fills, delayed keyboard input, condition waits, and artifacts",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-"));
		const logPath = join(tempDir, "invocations.log");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); let stdin='';
process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>stdin+=chunk); process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify({args,stdin})+'\\n');
 const rows=JSON.parse(stdin).map(command=>{const file=command[0]==='screenshot'?command[1]:command[0]==='wait'&&command[1]==='--download'?command[2]:undefined;
 if(file){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'artifact');}
 return {command,success:true,result:file?{path:file}:{command}};}); process.stdout.write(JSON.stringify(rows));
});`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const steps = [
					["open", "https://example.test/"],
					["wait", "--load", "domcontentloaded"],
					["fill", "#email", "user@example.test"],
					["focus", "#prompt"],
					["keyboard", "type", "g"],
					["wait", "20"],
					["keyboard", "type", "o"],
					["press", "Enter"],
					["select", "#theme", "dark", "compact"],
					["click", "#submit"],
					["wait", "--text", "Welcome"],
					["wait", "--url", "**/dashboard"],
					["wait", "250"],
					["wait", "--download", "report.csv"],
					["snapshot", "-i"],
					["screenshot", "batch.png"],
				];
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "--bail"],
					stdin: JSON.stringify(steps),
				});
				assert.equal(result.isError, false, JSON.stringify(result));
				assert.equal(readRecord(result.details).compiledJob, undefined);
				const invocation = (await readInvocationLog(logPath)).find((call) =>
					call.args.includes("batch"),
				);
				assert.ok(invocation);
				assert.deepEqual(invocation.args.slice(-2), ["batch", "--bail"]);
				const dispatched = readArray(JSON.parse(invocation.stdin ?? "[]"));
				assert.deepEqual(dispatched.slice(0, 15), steps.slice(0, 15));
				assert.equal(readArray(dispatched[15])[1], join(tempDir, "batch.png"));
				const redacted = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "--bail"],
					stdin: JSON.stringify([
						["open", "https://user:secret@example.test/path?token=abc&ok=1#access_token=xyz"],
					]),
				});
				assert.doesNotMatch(JSON.stringify(redacted), /user:secret|token=abc|access_token=xyz/);
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	},
);

test(
	"agentBrowserExtension reports failed fresh batches as post-launch failures",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-fresh-job-failure-"));
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
  const command = args.includes("batch") ? "batch" : args.at(-1);
  if (command === "open") {
    process.stdout.write(JSON.stringify({ success: true, data: { title: "GitHub", url: "https://github.com/vercel-labs/agent-browser" } }));
    return;
  }
  if (command === "batch") {
    const steps = JSON.parse(stdin);
    process.stdout.write(JSON.stringify(steps.map((step, index) => {
      if (step[0] === "open") return { command: step, success: true, result: { title: "Wikipedia", url: step[1] } };
      if (step[0] === "screenshot") { fs.writeFileSync(step[1], "wiki-shot"); return { command: step, success: true, result: { path: step[1] } }; }
      if (index === 2) return { command: step, success: false, error: "Could not locate Search button" };
      return { command: step, success: true, result: { ok: true } };
    })));
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://wikipedia.org/", refs: {}, snapshot: "" } }));
});`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const prior = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://github.com/vercel-labs/agent-browser"],
					sessionMode: "fresh",
				});
				assert.equal(prior.isError, false);

				const screenshotPath = join(tempDir, "wiki.png");
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["open", "https://www.wikipedia.org/"],
						["fill", "input[name='search']", "agent-browser"],
						["click", "button[type='submit']"],
						["screenshot", screenshotPath],
					]),
					sessionMode: "fresh",
				});

				assert.equal(result.isError, true);
				assert.match(
					readString(readRecord(result.content.at(0)).text),
					/Batch failed: 3\/4 succeeded/,
				);
				assert.match(
					readString(readRecord(result.content.at(0)).text),
					/Managed session outcome: Fresh launch became current, but this tool call failed after launch\./,
				);
				const outcome = readRecord(readRecord(result.details).managedSessionOutcome);
				assert.equal(outcome.activeAfter, true);
				assert.equal(outcome.status, "replaced");
				assert.equal(outcome.succeeded, false);
				assert.equal(
					readArray(readRecord(result.details).nextActions)
						.map(readRecord)
						.some((action) => action.id === "run-agent-browser-doctor"),
					false,
				);
				assert.equal(await readFile(screenshotPath, "utf8"), "wiki-shot");
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension compiles lightweight QA presets and fails diagnostics",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-qa-"));
		const logPath = join(tempDir, "invocations.log");
		const qaModeBefore = process.env.AGENT_BROWSER_FAKE_QA_MODE;
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let stdin = "";
let mode = "clean";
let staleNetwork = true;
let staleConsole = true;
let staleErrors = true;
const statePath = path.join(${JSON.stringify(tempDir)}, "fake-session-state.json");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device", "--user-agent"]);
function getSessionKey() {
  const index = args.indexOf("--session");
  return index >= 0 ? args[index + 1] : "default";
}
function readSessionState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed[getSessionKey()] ?? { title: "QA Page", url: "https://example.test/" };
  } catch {
    return { title: "QA Page", url: "https://example.test/" };
  }
}
function writeSessionState(nextState) {
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
  parsed[getSessionKey()] = { ...nextState, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? parsed[getSessionKey()]?.restoreKey ?? null };
  fs.writeFileSync(statePath, JSON.stringify(parsed));
}
function findCommandStartIndex(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") continue;
    if (valueFlags.has(token)) { i += 1; continue; }
    if (token.startsWith("--")) continue;
    return i;
  }
  return -1;
}
function writeStandaloneResult(data) {
  process.stdout.write(JSON.stringify({ success: true, data }));
}
function handleStandaloneCommand() {
  const commandIndex = findCommandStartIndex(args);
  const command = args[commandIndex];
  const subcommand = args[commandIndex + 1];
  const sessionState = readSessionState();
  if (command === "session" && subcommand === "info") {
    const active = sessionState.restoreKey !== undefined;
    writeStandaloneResult({ active, runtime: active ? { restoreKey: sessionState.restoreKey } : null });
    return true;
  }
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (command === "get" && subcommand === "url") {
    if (process.env.QA_ATTACHED_GET_URL_FAIL === "1") {
      process.stderr.write("get url failed");
      process.exit(1);
    }
    writeStandaloneResult({ result: sessionState.url, url: sessionState.url });
    return true;
  }
  if (command === "get" && subcommand === "title") {
    writeStandaloneResult({ result: sessionState.title, title: sessionState.title });
    return true;
  }
  if (command === "open") {
    const url = String(subcommand || "about:blank");
    const title = url.includes("blank") ? "Blank Page" : "QA Page";
    writeSessionState({ title, url });
    writeStandaloneResult({ title, url });
    return true;
  }
  return false;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (handleStandaloneCommand()) return;
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const steps = JSON.parse(stdin);
  function executeStep(command) {
    const name = command[0];
    if (name === "open") {
      const url = String(command[1] || "");
      const title = url.includes("blank") ? "Blank Page" : "QA Page";
      if (process.env.AGENT_BROWSER_FAKE_QA_MODE === "open-bail") {
        return { command, success: false, error: "Navigation failed: net::ERR_CERT_AUTHORITY_INVALID at https://qa.example.test/?token=secret" };
      }
      writeSessionState({ title, url });
      mode = url.includes("fail") ? "fail" : url.includes("favicon") ? "favicon" : "clean";
      return { command, success: true, result: { title, url } };
    }
    if (name === "network") {
      if (command.includes("--clear")) { staleNetwork = false; return { command, success: true, result: { requests: [] } }; }
      if (staleNetwork || mode === "fail") return { command, success: true, result: { requests: [{ method: "GET", resourceType: "fetch", status: 500, url: "https://example.test/api" }] } };
      if (mode === "favicon") return { command, success: true, result: { requests: [{ method: "GET", mimeType: "image/x-icon", status: 404, url: "https://example.test/favicon.ico" }] } };
      return { command, success: true, result: { requests: [] } };
    }
    if (name === "console") {
      if (command.includes("--clear")) { staleConsole = false; return { command, success: true, result: { messages: [] } }; }
      return { command, success: true, result: staleConsole || mode === "fail" ? { messages: [{ type: "error", text: "boom" }] } : { messages: [] } };
    }
    if (name === "errors") {
      if (command.includes("--clear") && process.env.AGENT_BROWSER_FAKE_QA_MODE !== "residue") staleErrors = false;
      const errors = [];
      if (staleErrors) errors.push({ text: "stale page boom" });
      if (mode === "fail") errors.push({ text: "current page boom" });
      return { command, success: true, result: { errors } };
    }
    if (name === "get" && command[1] === "text") {
      return { command, success: true, result: { result: mode === "blank" ? "" : "Welcome to the QA Page" } };
    }
    if (name === "wait" && (process.env.AGENT_BROWSER_FAKE_QA_MODE === "wait-fail" || (process.env.AGENT_BROWSER_FAKE_QA_MODE === "assertion-fail" && command[1] === "--fn"))) {
      return { command, success: false, error: "Timed out waiting for QA assertion" };
    }
    if (name === "screenshot" && typeof command[1] === "string" && !command[1].includes("missing-qa-screenshot")) {
      fs.writeFileSync(command[1], "fake screenshot");
      return { command, success: true, result: { path: command[1] } };
    }
    return { command, success: true, result: { ok: true } };
  }
  const results = [];
  for (const command of steps) {
    const row = executeStep(command);
    results.push(row);
    if (args.includes("--bail") && row.success === false) break;
  }
  process.stdout.write(JSON.stringify(results));
});`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					AGENT_BROWSER_FAKE_QA_MODE: undefined,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const qaTool = harness.getTool("agent_browser_qa");
					assert.ok(qaTool);
					assert.equal(
						Check(qaTool.parameters, {
							attached: true,
							expectedText: "Welcome",
						}),
						true,
					);
					assert.equal(
						Check(qaTool.parameters, {
							attached: true,
							url: "https://example.test/",
						}),
						false,
					);
					assert.equal(Check(qaTool.parameters, { expectedText: "Welcome" }), false);
					const attachedWithoutSession = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: { attached: true, expectedText: "Welcome" },
					});
					assert.equal(attachedWithoutSession.isError, true);
					assert.match(
						readString(readRecord(attachedWithoutSession.content.at(0)).text),
						/qa\.attached requires an active attached session/,
					);
					assert.equal(
						readRecord(attachedWithoutSession.details).failureCategory,
						"validation-error",
					);

					const cleanResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: {
							url: "https://example.test/",
							expectedText: ["Welcome"],
						},
					});
					assert.equal(cleanResult.isError, false);
					assert.equal(readRecord(readRecord(cleanResult.details).qaPreset).passed, true);
					assert.deepEqual(readRecord(readRecord(cleanResult.details).qaPreset).failedChecks, []);
					assert.deepEqual(readRecord(readRecord(cleanResult.details).qaPreset).warnings, []);
					assert.match(readString(readRecord(cleanResult.content[0]).text), /QA preset passed\./);
					assert.match(
						readString(readRecord(cleanResult.content[0]).text),
						/Page: QA Page — https:\/\/example\.test\//,
					);
					assert.match(readString(readRecord(cleanResult.content[0]).text), /Checks run:/);
					assert.match(
						readString(readRecord(cleanResult.content[0]).text),
						/Full diagnostic matrix: see details\.qaPreset and details\.batchSteps\./,
					);
					assert.doesNotMatch(readString(readRecord(cleanResult.content[0]).text), /Step 1 —/);
					assert.ok(
						Array.isArray(readRecord(cleanResult.details).batchSteps) &&
							readArray(readRecord(cleanResult.details).batchSteps).length > 0,
					);

					await withPatchedEnv({ AGENT_BROWSER_FAKE_QA_MODE: "residue" }, async () => {
						const ambiguous = await executeRegisteredTool(harness.tool, harness.ctx, {
							qa: { url: "https://example.test/" },
						});
						assert.equal(readRecord(readRecord(ambiguous.details).qaPreset).passed, false);
						assert.equal(ambiguous.isError, true);
						assert.equal(readRecord(ambiguous.details).resultCategory, "failure");
						assert.equal(readRecord(ambiguous.details).failureCategory, "qa-failure");
						assert.deepEqual(readRecord(readRecord(ambiguous.details).qaPreset).failedChecks, [
							"page-error check could not be verified (1 row(s) matched the post-clear baseline; old residue and identical new errors are indistinguishable)",
						]);
						assert.match(
							readString(readRecord(ambiguous.content.at(0)).text),
							/page-error check could not be verified/,
						);
						assert.doesNotMatch(
							readString(readRecord(ambiguous.content.at(0)).text),
							/QA preset passed|unchanged|1 page error\(s\)/,
						);
						// Canonical failure projection: the returned result itself carries isError and the notice.
						assert.match(
							readString(readRecord(ambiguous.content.at(0)).text),
							/Result category: failure; failureCategory: qa-failure; Pi tool isError: true\./,
						);

						const disabled = await executeRegisteredTool(harness.tool, harness.ctx, {
							qa: { url: "https://example.test/", checkErrors: false },
						});
						assert.equal(readRecord(readRecord(disabled.details).qaPreset).passed, true);
						assert.equal(disabled.isError, false);
						assert.equal(readRecord(disabled.details).resultCategory, "success");
						const disabledSteps = readArray(
							readRecord(readRecord(disabled.details).compiledQaPreset).steps,
						).map(readRecord);
						assert.equal(
							disabledSteps.some((step) => readArray(step.args)[0] === "errors"),
							false,
						);
						const invocation = [...(await readInvocationLog(logPath))]
							.reverse()
							.find((entry) => entry.args.includes("batch"));
						assert.ok(invocation);
						assert.equal(
							readArray(JSON.parse(invocation.stdin ?? "[]")).some(
								(step) => readArray(step)[0] === "errors",
							),
							false,
						);
					});

					const benignNetworkResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: {
							url: "https://favicon.example.test/",
							expectedText: ["Welcome"],
						},
					});
					assert.equal(benignNetworkResult.isError, false);
					assert.deepEqual(
						readRecord(readRecord(benignNetworkResult.details).qaPreset).failedChecks,
						[],
					);
					assert.deepEqual(readRecord(readRecord(benignNetworkResult.details).qaPreset).warnings, [
						"1 benign network request failure(s) ignored",
					]);
					assert.match(
						readString(readRecord(benignNetworkResult.content[0]).text),
						/QA preset passed with warnings: 1 benign network request failure\(s\) ignored\./,
					);
					assert.match(
						readString(readRecord(benignNetworkResult.content[0]).text),
						/Full diagnostic matrix: see details\.qaPreset and details\.batchSteps\./,
					);
					assert.doesNotMatch(
						readString(readRecord(benignNetworkResult.content[0]).text),
						/Network failure summary:/,
					);
					assert.doesNotMatch(
						readString(readRecord(benignNetworkResult.content[0]).text),
						/Step 1 —/,
					);

					process.env.AGENT_BROWSER_FAKE_QA_MODE = "open-bail";
					const openBailHarness = createExtensionHarness({
						cwd: tempDir,
						sessionId: "qa-open-bail-session",
					});
					await runExtensionEvent(
						openBailHarness.handlers,
						"session_start",
						{ reason: "new" },
						openBailHarness.ctx,
					);
					const openBailResult = await executeRegisteredTool(
						openBailHarness.tool,
						openBailHarness.ctx,
						{
							qa: {
								url: "https://qa.example.test/?token=secret",
								expectedText: [
									"First expected text",
									"Second expected text",
									"Third expected text",
								],
							},
						},
					);
					const openBailText = readString(readRecord(openBailResult.content.at(0)).text);
					assert.equal(openBailResult.isError, true);
					assert.match(openBailText, /^Error: Navigation failed: net::ERR_CERT_AUTHORITY_INVALID/);
					assert.match(openBailText, /Not run:\n- load state: domcontentloaded/);
					assert.match(openBailText, /expected text: "First expected text"/);
					assert.match(openBailText, /Execution: 5\/13 batch steps/);
					assert.doesNotMatch(openBailText, /expected text not found/);
					assert.doesNotMatch(openBailText, /token=secret/);
					assert.deepEqual(readRecord(readRecord(openBailResult.details).qaPreset).failedChecks, [
						"open failed",
					]);
					assert.equal(
						readArray(readRecord(readRecord(openBailResult.details).qaPreset).notRunChecks).length,
						7,
					);

					process.env.AGENT_BROWSER_FAKE_QA_MODE = "wait-fail";
					const failedWaitQaResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: {
							url: "https://example.test/",
							expectedText: ["Missing text"],
						},
					});
					assert.equal(failedWaitQaResult.isError, true);
					assert.equal(
						readRecord(failedWaitQaResult.details).failureCategory,
						"qa-failure",
						failedWaitQaResult.content.at(0)?.text,
					);
					assert.match(
						readString(readRecord(failedWaitQaResult.content[0]).text),
						/^Error: Timed out waiting for QA assertion/,
					);
					assert.match(
						readString(readRecord(failedWaitQaResult.content[0]).text),
						/Failed checks:/,
					);
					assert.match(
						readString(readRecord(failedWaitQaResult.content[0]).text),
						/Full diagnostic matrix: see details\.qaPreset and details\.batchSteps/,
					);
					assert.doesNotMatch(
						readString(readRecord(failedWaitQaResult.content[0]).text),
						/Step 1 —/,
					);
					process.env.AGENT_BROWSER_FAKE_QA_MODE = "pass";

					const missingQaScreenshotPath = join(tempDir, "missing-qa-screenshot.png");
					const missingQaScreenshotResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: {
							url: "https://example.test/",
							expectedText: ["Welcome"],
							screenshotPath: missingQaScreenshotPath,
						},
					});
					assert.equal(missingQaScreenshotResult.isError, true);
					assert.equal(
						readRecord(missingQaScreenshotResult.details).failureCategory,
						"artifact-missing",
					);
					assert.equal(
						readRecord(readRecord(missingQaScreenshotResult.details).qaPreset).passed,
						false,
					);
					assert.match(
						readString(readRecord(missingQaScreenshotResult.content[0]).text),
						/Artifact verification failed/,
					);
					assert.doesNotMatch(
						readString(readRecord(missingQaScreenshotResult.content[0]).text),
						/QA preset passed/,
					);
					delete process.env.AGENT_BROWSER_FAKE_QA_MODE;

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: {
							url: "https://fail.example.test/",
							expectedText: ["Welcome"],
							expectedSelector: "main",
							screenshotPath: "qa.png",
						},
						sessionMode: "fresh",
					});

					assert.equal(result.isError, true);
					assert.equal(readRecord(result.details).failureCategory, "qa-failure");
					assert.match(
						readString(readRecord(result.content.at(0)).text),
						/Result category: failure; failureCategory: qa-failure; Pi tool isError: true\./,
					);

					const managedSessionOutcome = readRecord(
						readRecord(result.details).managedSessionOutcome,
					);
					assert.equal(managedSessionOutcome.sessionMode, "fresh");
					assert.equal(managedSessionOutcome.status, "created");
					assert.equal(managedSessionOutcome.succeeded, false);
					assert.match(
						readString(readRecord(result.content[0]).text),
						/Managed session outcome: Fresh launch became current, but this tool call failed after launch\./,
					);
					assert.match(
						readString(readRecord(result.content[0]).text),
						/failureCategory \/ qaPreset/,
					);
					const qaFailureNextActions = readArray(readRecord(result.details).nextActions).map(
						readRecord,
					);
					assert.equal(
						qaFailureNextActions.some((action) => action.id === "run-agent-browser-doctor"),
						false,
					);
					assert.ok(
						qaFailureNextActions.some(
							(action) =>
								action.id === "verify-current-managed-session" &&
								/current managed session/.test(readString(action.reason ?? "")),
						),
					);
					assert.match(readString(readRecord(result.content[0]).text), /Failed checks:/);
					assert.doesNotMatch(readString(readRecord(result.content[0]).text), /Step 1 —/);
					assert.deepEqual(readRecord(readRecord(result.details).qaPreset).failedChecks, [
						"1 actionable failed network request(s)",
						"1 console error message(s)",
						"1 page error(s)",
					]);
					const compiledQaPreset = readRecord(readRecord(result.details).compiledQaPreset);
					assert.deepEqual(compiledQaPreset.args, ["batch", "--bail"]);
					assert.equal(compiledQaPreset.failFast, true);
					const compiledQaSteps = readArray(compiledQaPreset.steps).map((step) =>
						readArray(readRecord(step).args),
					);
					assert.deepEqual(compiledQaSteps.slice(0, 7), [
						["network", "requests", "--clear"],
						["console", "--clear"],
						["errors", "--clear"],
						["errors"],
						["open", "https://fail.example.test/"],
						["wait", "--load", "domcontentloaded"],
						["wait", "150"],
					]);
					assert.equal(compiledQaSteps[7][0], "wait");
					assert.equal(compiledQaSteps[7][1], "--fn");
					assert.match(readString(compiledQaSteps[7][2]), /Welcome/);
					assert.deepEqual(compiledQaSteps[7].slice(3), ["--timeout", "5000"]);
					assert.deepEqual(compiledQaSteps.slice(8), [
						["wait", "main"],
						["network", "requests"],
						["console"],
						["errors"],
						["screenshot", "qa.png"],
					]);
					const invocations = await readInvocationLog(logPath);
					assert.ok(
						invocations.filter(
							(entry) => entry.args.at(-2) === "batch" && entry.args.at(-1) === "--bail",
						).length >= 3,
					);

					const firstRunFailureHarness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						firstRunFailureHarness.handlers,
						"session_start",
						{ reason: "new" },
						firstRunFailureHarness.ctx,
					);
					const firstRunFailure = await executeRegisteredTool(
						firstRunFailureHarness.tool,
						firstRunFailureHarness.ctx,
						{
							qa: {
								url: "https://fail.example.test/",
								expectedText: "Welcome",
							},
							sessionMode: "fresh",
						},
					);
					assert.equal(firstRunFailure.isError, true);
					const firstRunOutcome = readRecord(
						readRecord(firstRunFailure.details).managedSessionOutcome,
					);
					assert.equal(firstRunOutcome.status, "created");
					assert.equal(firstRunOutcome.succeeded, false);
					assert.match(
						readString(readRecord(firstRunFailure.content[0]).text),
						/Managed session outcome: Fresh launch became current, but this tool call failed after launch\./,
					);
					const firstRunNextActions = readArray(
						readRecord(firstRunFailure.details).nextActions,
					).map(readRecord);
					assert.equal(
						firstRunNextActions.some((action) => action.id === "run-agent-browser-doctor"),
						false,
					);
					assert.ok(
						firstRunNextActions.some(
							(action) =>
								action.id === "verify-current-managed-session" &&
								/current managed session/.test(readString(action.reason ?? "")),
						),
					);

					const attachedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: {
							attached: true,
							expectedText: "Welcome",
							expectedSelector: "main",
						},
					});
					assert.equal(attachedResult.isError, false, JSON.stringify(attachedResult));
					assert.match(readString(readRecord(attachedResult.content[0]).text), /QA preset passed/);
					assert.doesNotMatch(
						readString(readRecord(attachedResult.content[0]).text),
						/Attached diagnostics: existing upstream session console\/network\/error buffers were preserved/,
					);
					assert.equal(
						readRecord(readRecord(attachedResult.details).qaAttachedTarget).title,
						"QA Page",
					);
					assert.equal(
						readRecord(readRecord(attachedResult.details).qaAttachedTarget).url,
						"https://fail.example.test/",
					);
					assert.deepEqual(
						readRecord(readRecord(attachedResult.details).qaPreset).failedChecks,
						[],
					);
					const attachedCompiledQaPreset = readRecord(
						readRecord(attachedResult.details).compiledQaPreset,
					);
					const attachedChecks = readRecord(attachedCompiledQaPreset.checks);
					assert.equal(attachedChecks.attached, true);
					assert.equal(attachedChecks.checkNetwork, false);
					assert.equal(attachedChecks.checkConsole, false);
					assert.equal(attachedChecks.checkErrors, false);
					assert.equal(attachedChecks.diagnosticsResetAtStart, false);
					assert.equal(attachedChecks.url, undefined);
					const attachedCompiledQaSteps = readArray(attachedCompiledQaPreset.steps).map((step) =>
						readArray(readRecord(step).args),
					);
					assert.deepEqual(attachedCompiledQaSteps.slice(0, 1), [
						["wait", "--load", "domcontentloaded"],
					]);
					assert.equal(attachedCompiledQaSteps[1][0], "wait");
					assert.equal(attachedCompiledQaSteps[1][1], "--fn");
					assert.match(readString(attachedCompiledQaSteps[1][2]), /Welcome/);
					assert.deepEqual(attachedCompiledQaSteps[1].slice(3), ["--timeout", "5000"]);
					assert.deepEqual(attachedCompiledQaSteps.slice(2), [["wait", "main"]]);
					const attachedInvocation = [...(await readInvocationLog(logPath))]
						.reverse()
						.find(
							(entry) =>
								entry.args.at(-2) === "batch" &&
								entry.args.at(-1) === "--bail" &&
								(entry.stdin ?? "").trim().startsWith("["),
						);
					assert.ok(attachedInvocation);
					const attachedSteps = readArray(JSON.parse(attachedInvocation.stdin ?? "[]")).map(
						readArray,
					);
					assert.equal(
						attachedSteps.some((step) => step[0] === "open"),
						false,
					);

					const attachedCheckedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: {
							attached: true,
							checkConsole: true,
							checkErrors: true,
							checkNetwork: true,
							expectedText: "Welcome",
							expectedSelector: "main",
						},
					});
					assert.equal(attachedCheckedResult.isError, true);
					assert.equal(readRecord(attachedCheckedResult.details).failureCategory, "qa-failure");
					assert.match(
						readString(readRecord(attachedCheckedResult.content[0]).text),
						/^QA preset failed/,
					);
					assert.match(
						readString(readRecord(attachedCheckedResult.content[0]).text),
						/Attached diagnostics: existing upstream session console\/network\/error buffers were preserved/,
					);
					assert.deepEqual(
						readRecord(readRecord(attachedCheckedResult.details).qaPreset).failedChecks,
						[
							"1 actionable failed network request(s)",
							"1 console error message(s)",
							"1 page error(s)",
						],
					);

					process.env.AGENT_BROWSER_FAKE_QA_MODE = "assertion-fail";
					const attachedAssertionFailure = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: {
							attached: true,
							expectedText: "Missing text",
							expectedSelector: "main",
							screenshotPath: join(tempDir, "not-run.png"),
						},
					});
					assert.equal(attachedAssertionFailure.isError, true);
					assert.match(
						readString(readRecord(attachedAssertionFailure.content.at(0)).text),
						/^Error: Timed out waiting for QA assertion/,
					);
					assert.match(
						readString(readRecord(attachedAssertionFailure.content.at(0)).text),
						/Not run:\n- expected selector: "main"/,
					);
					assert.match(
						readString(readRecord(attachedAssertionFailure.content.at(0)).text),
						/QA attached target:/,
					);

					await assert.rejects(readFile(join(tempDir, "not-run.png")), { code: "ENOENT" });

					const attachedFreshResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: { attached: true, expectedText: "Welcome" },
						sessionMode: "fresh",
					});
					assert.equal(attachedFreshResult.isError, true);
					assert.match(
						readString(readRecord(attachedFreshResult.content.at(0)).text),
						/qa\.attached cannot be used with sessionMode=fresh/,
					);
					assert.equal(readRecord(attachedFreshResult.details).failureCategory, "validation-error");

					const attachedWithUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
						qa: { attached: true, url: "https://example.test/" },
					});
					assert.equal(attachedWithUrl.isError, true);
					assert.match(
						readString(readRecord(attachedWithUrl.content.at(0)).text),
						/qa\.url must be omitted when qa\.attached is true/,
					);
					assert.equal(readRecord(attachedWithUrl.details).failureCategory, "validation-error");
				},
			);
			assert.equal(process.env.AGENT_BROWSER_FAKE_QA_MODE, qaModeBefore);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension admits qa.attached across page URL schemes without title preflight",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-qa-attached-precondition-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let stdin = "";
const statePath = path.join(${JSON.stringify(tempDir)}, "fake-session-state.json");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device", "--user-agent"]);
function getSessionKey() {
  const index = args.indexOf("--session");
  return index >= 0 ? args[index + 1] : "default";
}
function readSessionState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed[getSessionKey()] ?? { title: "Attached App", url: process.env.FAKE_ATTACHED_URL || "file:///tmp/app.html" };
  } catch {
    return { title: "Attached App", url: process.env.FAKE_ATTACHED_URL || "file:///tmp/app.html" };
  }
}
function findCommandStartIndex(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") continue;
    if (valueFlags.has(token)) { i += 1; continue; }
    if (token.startsWith("--")) continue;
    return i;
  }
  return -1;
}
function writeStandaloneResult(data) {
  process.stdout.write(JSON.stringify({ success: true, data }));
}
function handleStandaloneCommand() {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const commandIndex = findCommandStartIndex(args);
  const command = args[commandIndex];
  const subcommand = args[commandIndex + 1];
  const sessionState = readSessionState();
  if (command === "get" && subcommand === "url") {
    writeStandaloneResult({ result: sessionState.url, url: sessionState.url });
    return true;
  }
  if (command === "get" && subcommand === "title") {
    process.stderr.write("get title failed");
    process.exit(1);
  }
  if (command === "connect") {
    writeStandaloneResult({ connected: true, endpoint: subcommand });
    return true;
  }
  return false;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (handleStandaloneCommand()) return;
  const steps = JSON.parse(stdin);
  const results = steps.map((command) => command[0] === "get" && command[1] === "text"
    ? { command, success: true, result: { result: "Welcome" } }
    : { command, success: true, result: { ok: true } });
  process.stdout.write(JSON.stringify(results));
});`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, FAKE_ATTACHED_URL: "file:///tmp/app.html" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					await executeRegisteredTool(harness.tool, harness.ctx, { args: ["connect", "9222"] });
					for (const url of ["https://example.test/", "file:///tmp/app.html", "app://shell/home"]) {
						// Verify attached targets in order using the same native session.
						// oxlint-disable-next-line no-await-in-loop
						await withPatchedEnv({ FAKE_ATTACHED_URL: url }, async () => {
							const before = (await readInvocationLog(logPath)).length;
							const verifiedUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["get", "url"],
							});
							// Every fixed URL scheme must permit explicit URL verification.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(verifiedUrl.isError, false, JSON.stringify(verifiedUrl));
							const attachedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
								qa: { attached: true, expectedText: "Welcome" },
							});
							// Every fixed URL scheme must remain usable for attached QA.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(attachedResult.isError, false, JSON.stringify(attachedResult));
							// Each carried scenario must retain the QA pass, not merely a successful preflight.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(attachedResult.content.at(0)?.text ?? "", /QA preset passed\./);
							const calls = (await readInvocationLog(logPath)).slice(before);
							const batchIndex = calls.findIndex(
								(entry) => entry.args.at(-2) === "batch" && entry.args.at(-1) === "--bail",
							);
							// Every URL variant must reach a native QA batch after its preflight.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(batchIndex >= 0);
							const preflight = calls.slice(0, batchIndex);
							// The failing title fixture must not be consulted before admitting any URL scheme.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								preflight.some(
									(entry) => entry.args.includes("get") && entry.args.includes("title"),
								),
								false,
							);
						});
					}
					const invocations = await readInvocationLog(logPath);
					assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 3);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
