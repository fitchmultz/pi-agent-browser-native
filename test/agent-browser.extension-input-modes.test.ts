/**
 * Purpose: Verify high-level agent_browser input-mode compilation at the extension entrypoint.
 * Responsibilities: Assert semanticAction, visible-ref semantic resolution, constrained job, and lightweight QA compile/result contracts.
 * Scope: Integration-style Node test-runner coverage split out of the broad extension-validation suite; source/network lookup and validation-error tails remain in their focused suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-input-modes.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Check } from "typebox/value";

import { analyzeQaPresetResults, analyzeQaPresetTimeout, compileAgentBrowserJob, compileAgentBrowserQaPreset } from "../extensions/agent-browser/lib/input-modes/job.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	runExtensionEventResults,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

function getAssertUrlRegexSource(args: string[] | undefined): string {
	assert.ok(args);
	assert.deepEqual(args.slice(0, 2), ["wait", "--fn"]);
	const expression = args[2] ?? "";
	const prefix = "new RegExp(";
	const suffix = ").test(location.href)";
	assert.ok(expression.startsWith(prefix));
	assert.ok(expression.endsWith(suffix));
	return JSON.parse(expression.slice(prefix.length, -suffix.length)) as string;
}

test("analyzeQaPresetTimeout reports unverified expected-text timeouts as QA failures", () => {
	const compiled = compileAgentBrowserQaPreset({ url: "https://example.test/", expectedText: "Definitely Not On This Page" }).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetTimeout(compiled);
	assert.equal(analysis?.passed, false);
	assert.deepEqual(analysis?.failedChecks, ['expected text was not verified before timeout: "Definitely Not On This Page"']);
	assert.match(analysis?.summary ?? "", /QA preset failed/);
});

test("analyzeQaPresetResults reports missing expected text as QA failure", () => {
	const compiled = compileAgentBrowserQaPreset({ url: "https://example.test/", expectedText: "Definitely Not On This Page" }).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetResults([
		{ command: ["open", "https://example.test/"], success: true, result: { title: "Example", url: "https://example.test/" } },
		{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
		{ command: ["get", "text", "body"], success: true, result: { result: "Example Domain" } },
	], compiled);
	assert.equal(analysis?.passed, false);
	assert.deepEqual(analysis?.failedChecks, ['expected text not found: "Definitely Not On This Page"']);
});

test("analyzeQaPresetResults ignores reset-phase diagnostic rows for URL QA", () => {
	const compiled = compileAgentBrowserQaPreset({ url: "https://example.test/", expectedText: "Example Domain" }).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetResults([
		{ command: ["network", "requests", "--clear"], success: true, result: { requests: [{ method: "GET", status: 500, url: "https://old.example.test/api" }] } },
		{ command: ["console", "--clear"], success: true, result: { messages: [{ text: "old console boom", type: "error" }] } },
		{ command: ["errors", "--clear"], success: true, result: { errors: [{ text: "old ReferenceError" }] } },
		{ command: ["open", "https://example.test/"], success: true, result: { title: "Example", url: "https://example.test/" } },
		{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
		{ command: ["wait", "--fn", compiled.steps.find((step) => step.action === "assertText")?.args[2] ?? "", "--timeout", "5000"], success: true, result: true },
		{ command: ["network", "requests"], success: true, result: { requests: [] } },
		{ command: ["console"], success: true, result: { messages: [] } },
		{ command: ["errors"], success: true, result: { errors: [] } },
	], compiled);
	assert.equal(analysis?.passed, true);
	assert.deepEqual(analysis?.failedChecks, []);
});

test("analyzeQaPresetResults treats failed reset-phase diagnostic rows as step failures only", () => {
	const compiled = compileAgentBrowserQaPreset({ url: "https://example.test/" }).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetResults([
		{ command: ["network", "requests", "--clear"], error: "clear failed", success: false, result: { requests: [{ method: "GET", status: 500, url: "https://old.example.test/api" }] } },
		{ command: ["console", "--clear"], error: "clear failed", success: false, result: { messages: [{ text: "old console boom", type: "error" }] } },
		{ command: ["errors", "--clear"], error: "clear failed", success: false, result: { errors: [{ text: "old ReferenceError" }] } },
		{ command: ["open", "https://example.test/"], success: true, result: { title: "Example", url: "https://example.test/" } },
		{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
		{ command: ["network", "requests"], success: true, result: { requests: [] } },
		{ command: ["console"], success: true, result: { messages: [] } },
		{ command: ["errors"], success: true, result: { errors: [] } },
	], compiled);
	assert.equal(analysis?.passed, false);
	assert.deepEqual(analysis?.failedChecks, ["network failed", "console failed", "errors failed"]);
});

test("analyzeQaPresetResults still reports post-open page errors", () => {
	const compiled = compileAgentBrowserQaPreset({ url: "https://example.test/" }).compiled;
	assert.ok(compiled);
	const analysis = analyzeQaPresetResults([
		{ command: ["network", "requests", "--clear"], success: true, result: { requests: [] } },
		{ command: ["console", "--clear"], success: true, result: { messages: [] } },
		{ command: ["errors", "--clear"], success: true, result: { errors: [{ text: "old ReferenceError" }] } },
		{ command: ["open", "https://example.test/"], success: true, result: { title: "Example", url: "https://example.test/" } },
		{ command: ["wait", "--load", "domcontentloaded"], success: true, result: { ok: true } },
		{ command: ["network", "requests"], success: true, result: { requests: [] } },
		{ command: ["console"], success: true, result: { messages: [] } },
		{ command: ["errors"], success: true, result: { errors: [{ text: "current page boom" }] } },
	], compiled);
	assert.equal(analysis?.passed, false);
	assert.deepEqual(analysis?.failedChecks, ["1 page error(s)"]);
});

test("compileAgentBrowserJob preserves explicit assertUrl and assertText immediately after click", () => {
	const semanticJob = compileAgentBrowserJob({
		steps: [
			{ action: "open", url: "https://www.wikipedia.org/" },
			{ action: "fill", locator: "role", role: "searchbox", name: "Search", text: "agent browser" },
			{ action: "click", locator: "role", role: "button", name: "Search" },
		],
	});
	assert.equal(semanticJob.error, undefined);
	assert.deepEqual(semanticJob.compiled?.steps.map((step) => step.args), [
		["open", "https://www.wikipedia.org/"],
		["find", "role", "searchbox", "fill", "agent browser", "--name", "Search"],
		["find", "role", "button", "click", "--name", "Search"],
	]);
	assert.match(compileAgentBrowserJob({ steps: [{ action: "click", selector: "button", locator: "text", value: "Search" }] }).error ?? "", /either selector or semantic locator fields/);

	const { compiled, error } = compileAgentBrowserJob({
		steps: [
			{ action: "open", url: "https://shop.example/checkout" },
			{ action: "fill", selector: "#email", text: "user@example.com" },
			{ action: "click", selector: "#continue" },
			{ action: "assertUrl", url: "**/shipping" },
			{ action: "assertText", text: "Shipping address" },
			{ action: "screenshot", path: ".dogfood/shipping.png" },
		],
	});
	assert.equal(error, undefined);
	assert.deepEqual(
		compiled?.steps?.map((step) => step.action),
		["open", "fill", "click", "assertUrl", "assertText", "screenshot"],
	);
	assert.deepEqual(compiled?.steps?.map((step) => step.args), [
		["open", "https://shop.example/checkout"],
		["fill", "#email", "user@example.com"],
		["click", "#continue"],
		["wait", "--fn", 'new RegExp("^.*/shipping$").test(location.href)'],
		["wait", "--text", "Shipping address"],
		["screenshot", ".dogfood/shipping.png"],
	]);

	const exactUrlJob = compileAgentBrowserJob({ steps: [{ action: "assertUrl", url: "https://shop.example/shipping" }] });
	assert.deepEqual(exactUrlJob.compiled?.steps?.[0]?.args, ["wait", "--url", "https://shop.example/shipping"]);
	const exactQueryUrlJob = compileAgentBrowserJob({ steps: [{ action: "assertUrl", url: "https://shop.example/shipping?step=1&ref=a?b" }] });
	assert.deepEqual(exactQueryUrlJob.compiled?.steps?.[0]?.args, ["wait", "--url", "https://shop.example/shipping?step=1&ref=a?b"]);
	assert.deepEqual(JSON.parse(compiled?.stdin ?? "[]"), compiled?.steps?.map((step) => step.args));
});

test("compileAgentBrowserJob rejects unsupported fields for every constrained job action", () => {
	const invalidSteps = [
		[{ action: "open", url: "https://example.test/", path: "ignored.png" }, /job step open does not support path/],
		[{ action: "click", selector: "#submit", text: "ignored" }, /job step click does not support text/],
		[{ action: "fill", selector: "#email", text: "user@example.test", values: ["ignored"] }, /job step fill does not support values/],
		[{ action: "type", selector: "#prompt", text: "go", url: "https://example.test/" }, /job step type does not support url/],
		[{ action: "select", selector: "#theme", values: ["dark"], text: "ignored" }, /job step select does not support text/],
		[{ action: "wait", milliseconds: 250, selector: "#spinner" }, /job step wait does not support selector/],
		[{ action: "assertText", text: "Welcome", url: "https://example.test/" }, /job step assertText does not support url/],
		[{ action: "assertUrl", url: "**/dashboard", text: "Welcome" }, /job step assertUrl does not support text/],
		[{ action: "waitForDownload", path: "report.csv", url: "https://example.test/report.csv" }, /job step waitForDownload does not support url/],
		[{ action: "snapshot", selector: "body" }, /job step snapshot does not support selector/],
		[{ action: "screenshot", path: "job.png", url: "https://example.test/" }, /job step screenshot does not support url/],
	] as const;

	for (const [step, expectedError] of invalidSteps) {
		const result = compileAgentBrowserJob({ steps: [step] });
		assert.equal(result.compiled, undefined, `unexpected compile success for ${JSON.stringify(step)}`);
		assert.match(result.error ?? "", expectedError);
	}

	const validJob = compileAgentBrowserJob({
		steps: [
			{ action: "open", url: "https://example.test/", loadState: "domcontentloaded" },
			{ action: "click", locator: "role", role: "button", name: "Search" },
			{ action: "fill", selector: "#email", text: "user@example.test" },
			{ action: "select", selector: "#theme", values: ["dark"] },
			{ action: "wait", milliseconds: 250 },
			{ action: "assertText", text: "Welcome" },
			{ action: "assertUrl", url: "**/dashboard" },
			{ action: "waitForDownload", path: "report.csv" },
			{ action: "snapshot" },
			{ action: "screenshot", path: "job.png" },
		],
	});
	assert.equal(validJob.error, undefined);
	assert.deepEqual(validJob.compiled?.steps.map((step) => step.action), [
		"open",
		"wait",
		"click",
		"fill",
		"select",
		"wait",
		"assertText",
		"assertUrl",
		"waitForDownload",
		"snapshot",
		"screenshot",
	]);
});

test("compileAgentBrowserJob assertUrl glob semantics are deliberate", () => {
	const exactQueryUrlJob = compileAgentBrowserJob({ steps: [{ action: "assertUrl", url: "https://shop.example/shipping?step=1&ref=a?b" }] });
	assert.deepEqual(exactQueryUrlJob.compiled?.steps?.[0]?.args, ["wait", "--url", "https://shop.example/shipping?step=1&ref=a?b"]);

	const nestedShippingJob = compileAgentBrowserJob({ steps: [{ action: "assertUrl", url: "**/shipping" }] });
	const nestedShippingRegex = new RegExp(getAssertUrlRegexSource(nestedShippingJob.compiled?.steps?.[0]?.args));
	assert.equal(nestedShippingRegex.test("https://shop.example/checkout/shipping"), true);
	assert.equal(nestedShippingRegex.test("https://shop.example/account/checkout/shipping"), true);
	assert.equal(nestedShippingRegex.test("https://shop.example/account/checkout/billing"), false);
	const longerStarRunRegex = new RegExp(getAssertUrlRegexSource(compileAgentBrowserJob({ steps: [{ action: "assertUrl", url: "***/shipping" }] }).compiled?.steps?.[0]?.args));
	assert.equal(longerStarRunRegex.test("https://shop.example/account/checkout/shipping"), true);
	assert.equal(longerStarRunRegex.test("https://shop.example/account/checkout/billing"), false);

	const oneSegmentShippingJob = compileAgentBrowserJob({ steps: [{ action: "assertUrl", url: "https://shop.example/*/shipping" }] });
	const oneSegmentShippingRegex = new RegExp(getAssertUrlRegexSource(oneSegmentShippingJob.compiled?.steps?.[0]?.args));
	assert.equal(oneSegmentShippingRegex.test("https://shop.example/cart/shipping"), true);
	assert.equal(oneSegmentShippingRegex.test("https://shop.example/cart/nested/shipping"), false);

	const literalMetacharactersJob = compileAgentBrowserJob({ steps: [{ action: "assertUrl", url: "https://shop.example/file.v1+?q=[x]$*" }] });
	const literalMetacharactersRegex = new RegExp(getAssertUrlRegexSource(literalMetacharactersJob.compiled?.steps?.[0]?.args));
	assert.equal(literalMetacharactersRegex.test("https://shop.example/file.v1+?q=[x]$tail"), true);
	assert.equal(literalMetacharactersRegex.test("https://shopXexample/file.v1+?q=[x]$tail"), false);
	assert.equal(literalMetacharactersRegex.test("https://shop.example/fileAv1+?q=[x]$tail"), false);
	assert.equal(literalMetacharactersRegex.test("https://shop.example/file.v1+Zq=[x]$tail"), false);
	assert.equal(literalMetacharactersRegex.test("https://shop.example/file.v1+?q=x$tail"), false);
});

test("agentBrowserExtension compiles semantic actions to upstream find commands", { concurrency: false }, async () => {
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

			const clickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", value: "button", name: "Export" },
			});
			assert.equal(clickResult.isError, false);
			assert.deepEqual(clickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "role",
				args: ["find", "role", "button", "click", "--name", "Export"],
			});

			const roleOnlyClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", role: "button", name: "Continue without Signing In" },
			});
			assert.equal(roleOnlyClickResult.isError, false);
			assert.deepEqual(roleOnlyClickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "role",
				args: ["find", "role", "button", "click", "--name", "Continue without Signing In"],
			});

			const fillResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "label", value: "Email", text: "user@example.test" },
			});
			assert.equal(fillResult.isError, false);
			assert.deepEqual(fillResult.details?.compiledSemanticAction, {
				action: "fill",
				locator: "label",
				args: ["find", "label", "Email", "fill", "user@example.test"],
			});

			const selectorFillResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", selector: "@e1", text: "selector text" },
			});
			assert.equal(selectorFillResult.isError, false);
			assert.deepEqual(selectorFillResult.details?.compiledSemanticAction, {
				action: "fill",
				selector: "@e1",
				args: ["fill", "@e1", "selector text"],
			});

			const selectorClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", selector: "#submit" },
			});
			assert.equal(selectorClickResult.isError, false);
			assert.deepEqual(selectorClickResult.details?.compiledSemanticAction, {
				action: "click",
				selector: "#submit",
				args: ["click", "#submit"],
			});

			const selectorSessionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "check", selector: "@e4", session: "named" },
			});
			assert.equal(selectorSessionResult.isError, false);
			assert.deepEqual(selectorSessionResult.details?.compiledSemanticAction, {
				action: "check",
				selector: "@e4",
				args: ["--session", "named", "check", "@e4"],
			});

			const textClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Close" },
			});
			assert.equal(textClickResult.isError, false);
			assert.deepEqual(textClickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "text",
				args: ["find", "text", "Close", "click"],
			});

			const sessionClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Close", session: "named" },
			});
			assert.equal(sessionClickResult.isError, false);
			assert.deepEqual(sessionClickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "text",
				args: ["--session", "named", "find", "text", "Close", "click"],
			});
			assert.equal(sessionClickResult.details?.sessionName, "named");

			const selectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", selector: "#flavor-select", value: "chocolate", session: "named" },
			});
			assert.equal(selectResult.isError, false);
			assert.deepEqual(selectResult.details?.compiledSemanticAction, {
				action: "select",
				selector: "#flavor-select",
				values: ["chocolate"],
				args: ["--session", "named", "select", "#flavor-select", "chocolate"],
			});
			assert.equal(selectResult.details?.sessionName, "named");

			const invocationLog = await readInvocationLog(logPath);
			const invocations = invocationLog.filter((entry) => entry.args.includes("find"));
			assert.deepEqual(invocations[0]?.args.slice(-6), ["find", "role", "button", "click", "--name", "Export"]);
			assert.deepEqual(invocations[1]?.args.slice(-6), ["find", "role", "button", "click", "--name", "Continue without Signing In"]);
			assert.deepEqual(invocations[2]?.args.slice(-5), ["find", "label", "Email", "fill", "user@example.test"]);
			assert.deepEqual(invocationLog.find((entry) => entry.args.at(-3) === "fill" && entry.args.at(-2) === "@e1")?.args.slice(-3), ["fill", "@e1", "selector text"]);
			assert.deepEqual(invocationLog.find((entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "#submit")?.args.slice(-2), ["click", "#submit"]);
			assert.deepEqual(invocationLog.find((entry) => entry.args.at(-2) === "check" && entry.args.at(-1) === "@e4")?.args.slice(-4), ["--session", "named", "check", "@e4"]);
			assert.deepEqual(invocations[3]?.args.slice(-4), ["find", "text", "Close", "click"]);
			assert.deepEqual(invocations[4]?.args.slice(-6), ["--session", "named", "find", "text", "Close", "click"]);
			const selectInvocation = invocationLog.find((entry) => entry.args.includes("select"));
			assert.deepEqual(selectInvocation?.args.slice(-5), ["--session", "named", "select", "#flavor-select", "chocolate"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension resolves semantic role fills through one exact current editable ref", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-fill-visible-ref-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Search", url: "https://search.example.test/" } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://search.example.test/",
    refs: { e17: { role: "combobox", name: "Search" } },
    snapshot: '- combobox "Search" [ref=e17]'
  } }));
} else if (args.includes("fill")) {
  process.stdout.write(JSON.stringify({ success: true, data: { filled: "@e17" } }));
} else if (args.includes("find")) {
  process.stdout.write(JSON.stringify({ success: false, error: "selector not found" }));
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://search.example.test/"] });
			assert.equal(open.isError, false);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "role", role: "combobox", name: "Search", text: "pi issue 70 search" },
			});
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.deepEqual(result.details?.compiledSemanticAction, {
				action: "fill",
				locator: "role",
				args: ["find", "role", "combobox", "fill", "pi issue 70 search", "--name", "Search"],
			});
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-3), ["fill", "@e17", "pi issue 70 search"]);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("snapshot")));
			assert.ok(invocations.some((entry) => entry.args.at(-3) === "fill" && entry.args.at(-2) === "@e17" && entry.args.at(-1) === "pi issue 70 search"));
			assert.equal(invocations.some((entry) => entry.args.includes("find")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns when contenteditable fill does not replace existing text", { concurrency: false }, async () => {
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
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://editor.example.test/"] })).isError, false);
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] })).isError, false);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["fill", "@e1", "contenteditable replaced"] });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /Contenteditable fill may append or prepend/);
			assert.deepEqual(result.details?.fillVerification, {
				actual: "contenteditable replacededit me",
				expected: "contenteditable replaced",
				method: "text",
				nextActionIds: ["inspect-after-fill-verification", "verify-filled-value"],
				reason: "contenteditable-fill-mismatch",
				selector: "@e1",
				status: "mismatch",
				summary: 'Fill verification warning: fill @e1 reported success, but get text returned "contenteditable replacededit me".',
			});
			assert.ok((result.details?.nextActions as Array<{ id?: string }> | undefined)?.some((action) => action.id === "verify-filled-value"));
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("get") && entry.args.includes("text") && entry.args.includes("@e1")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension resolves semantic role clicks through current visible snapshot refs when available", { concurrency: false }, async () => {
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

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://docs.example.test/"] });
			assert.equal(open.isError, false);
			const oldSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(oldSnapshot.isError, false);
			assert.deepEqual((oldSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e2"]);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", value: "button", name: "Search Documentation" },
			});
			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.compiledSemanticAction, {
				action: "click",
				locator: "role",
				args: ["find", "role", "button", "click", "--name", "Search Documentation"],
			});
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-2), ["click", "@e17"]);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("snapshot")));
			assert.ok(invocations.some((entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e17"));
			assert.equal(invocations.some((entry) => entry.args.includes("find")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension compiles constrained jobs to upstream batch commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-job-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const steps = JSON.parse(stdin);
  process.stdout.write(JSON.stringify(steps.map((command) => {
    const artifactPath = command[0] === "screenshot" ? command[1] : command[0] === "wait" && command[1] === "--download" ? command[2] : undefined;
    if (artifactPath) {
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, "artifact");
    }
    return { command, success: true, result: artifactPath ? { command, path: artifactPath } : { command } };
  })));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: {
					steps: [
						{ action: "open", url: "https://example.test/", loadState: "domcontentloaded" },
						{ action: "fill", selector: "#email", text: "user@example.test" },
						{ action: "type", selector: "#prompt", text: "go", delayMs: 20, press: "Enter" },
						{ action: "select", selector: "#theme", values: ["dark", "compact"] },
						{ action: "click", selector: "#submit" },
						{ action: "assertText", text: "Welcome" },
						{ action: "assertUrl", url: "**/dashboard" },
						{ action: "wait", milliseconds: 250 },
						{ action: "waitForDownload", path: "report.csv" },
						{ action: "snapshot" },
						{ action: "screenshot", path: "job.png" },
					],
				},
			});

			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.args, ["batch", "--bail"]);
			const effectiveArgs = result.details?.effectiveArgs as string[] | undefined;
			assert.deepEqual(effectiveArgs?.slice(0, 2), ["--json", "--session"]);
			assert.match(effectiveArgs?.[2] ?? "", /^piab-pi-agent-browser-job-/);
			assert.equal(effectiveArgs?.[3], "batch");
			assert.equal(effectiveArgs?.[4], "--bail");
			const compiledJob = result.details?.compiledJob as { args?: string[]; failFast?: boolean; stdin?: string; steps?: Array<{ action: string; args: string[]; generatedFrom?: string }> } | undefined;
			assert.deepEqual(compiledJob?.args, ["batch", "--bail"]);
			assert.equal(compiledJob?.failFast, true);
			const compiledStepArgs = compiledJob?.steps?.map((step) => step.args);
			assert.deepEqual(compiledStepArgs?.slice(0, 11), [
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
			]);
			const dashboardRegex = new RegExp(getAssertUrlRegexSource(compiledStepArgs?.[11]));
			assert.equal(dashboardRegex.test("https://example.test/account/dashboard"), true);
			assert.equal(dashboardRegex.test("https://example.test/account/settings"), false);
			assert.deepEqual(compiledStepArgs?.slice(12), [
				["wait", "250"],
				["wait", "--download", "report.csv"],
				["snapshot", "-i"],
				["screenshot", "job.png"],
			]);
			assert.equal(compiledJob?.steps?.[1]?.generatedFrom, "open.loadState");
			assert.equal(compiledJob?.steps?.[3]?.generatedFrom, "type.selector");
			assert.equal(compiledJob?.steps?.[4]?.generatedFrom, "type.delayMs");
			assert.equal(compiledJob?.steps?.[7]?.generatedFrom, "type.press");
			assert.deepEqual(JSON.parse(compiledJob?.stdin ?? "[]"), compiledStepArgs);
			assert.match(result.content[0]?.text ?? "", /Step 4-8 — type #prompt \(succeeded\)\nTyped 2 chars with delayMs=20\.\nPressed Enter\./);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Step 5 — keyboard type g/);
			const redactedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://user:secret@example.test/path?token=abc&ok=1#access_token=xyz" }] },
			});
			const redactedCompiledJob = redactedResult.details?.compiledJob as { stdin?: string; steps?: Array<{ args: string[] }> } | undefined;
			assert.match(redactedCompiledJob?.stdin ?? "", /%5BREDACTED%5D/);
			assert.doesNotMatch(redactedCompiledJob?.stdin ?? "", /secret|token=abc|access_token=xyz/);
			assert.deepEqual(JSON.parse(redactedCompiledJob?.stdin ?? "[]"), redactedCompiledJob?.steps?.map((step) => step.args));

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-2), ["batch", "--bail"]);
			const upstreamSteps = JSON.parse(invocations[0]?.stdin ?? "[]") as string[][];
			assert.deepEqual(upstreamSteps.slice(0, 15), compiledJob?.steps?.slice(0, 15).map((step) => step.args));
			assert.equal(upstreamSteps[15]?.[0], "screenshot");
			assert.match(upstreamSteps[15]?.[1] ?? "", /job\.png$/);

			const invalidTypeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "type", selector: "#prompt", text: "go", url: "https://example.test" }] },
			});
			assert.equal(invalidTypeResult.isError, true);
			assert.match(invalidTypeResult.content[0]?.text ?? "", /job step type does not support url/);

			const longDelayedTypeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "type", text: "x".repeat(201), delayMs: 1 }] },
			});
			assert.equal(longDelayedTypeResult.isError, true);
			assert.match(longDelayedTypeResult.content[0]?.text ?? "", /delayMs supports at most 200 characters/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports failed fresh jobs as post-launch failures", { concurrency: false }, async () => {
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
			const prior = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://github.com/vercel-labs/agent-browser"] });
			assert.equal(prior.isError, false);

			const screenshotPath = join(tempDir, "wiki.png");
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: {
					failFast: false,
					steps: [
						{ action: "open", url: "https://www.wikipedia.org/" },
						{ action: "fill", selector: "input[name='search']", text: "agent-browser" },
						{ action: "click", selector: "button[type='submit']" },
						{ action: "screenshot", path: screenshotPath },
					],
				},
				sessionMode: "fresh",
			});

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Batch failed: 3\/4 succeeded/);
			assert.match(result.content[0]?.text ?? "", /Managed session outcome: Fresh launch became current, but this tool call failed after launch\./);
			const outcome = result.details?.managedSessionOutcome as { activeAfter?: boolean; status?: string; succeeded?: boolean } | undefined;
			assert.equal(outcome?.activeAfter, true);
			assert.equal(outcome?.status, "replaced");
			assert.equal(outcome?.succeeded, false);
			assert.equal((result.details?.nextActions as Array<{ id?: string }> | undefined)?.some((action) => action.id === "run-agent-browser-doctor"), false);
			assert.equal(await readFile(screenshotPath, "utf8"), "wiki-shot");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension compiles lightweight QA presets and fails diagnostics", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-qa-"));
	const logPath = join(tempDir, "invocations.log");
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
const valueFlags = new Set(["--session", "--profile", "--state", "--session-name", "--cdp", "--provider", "-p", "--device", "--user-agent"]);
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
  parsed[getSessionKey()] = nextState;
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
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const commandIndex = findCommandStartIndex(args);
  const command = args[commandIndex];
  const subcommand = args[commandIndex + 1];
  const sessionState = readSessionState();
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
  const results = steps.map((command) => {
    const name = command[0];
    if (name === "open") {
      const url = String(command[1] || "");
      const title = url.includes("blank") ? "Blank Page" : "QA Page";
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
      if (command.includes("--clear")) { staleErrors = false; return { command, success: true, result: { errors: [] } }; }
      return { command, success: true, result: staleErrors || mode === "fail" ? { errors: [{ text: "page boom" }] } : { errors: [] } };
    }
    if (name === "get" && command[1] === "text") {
      return { command, success: true, result: { result: mode === "blank" ? "" : "Welcome to the QA Page" } };
    }
    if (name === "wait" && process.env.AGENT_BROWSER_FAKE_QA_MODE === "wait-fail") {
      return { command, success: false, error: "Timed out waiting for QA assertion" };
    }
    if (name === "screenshot" && typeof command[1] === "string" && !command[1].includes("missing-qa-screenshot")) {
      fs.writeFileSync(command[1], "fake screenshot");
      return { command, success: true, result: { path: command[1] } };
    }
    return { command, success: true, result: { ok: true } };
  });
  process.stdout.write(JSON.stringify(results));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			assert.equal(Check(harness.tool.parameters, { qa: { attached: true, expectedText: "Welcome" } }), true);
			assert.equal(Check(harness.tool.parameters, { qa: { attached: true, url: "https://example.test/" } }), false);
			assert.equal(Check(harness.tool.parameters, { qa: { expectedText: "Welcome" } }), false);
			const attachedWithoutSession = await executeRegisteredTool(harness.tool, harness.ctx, { qa: { attached: true, expectedText: "Welcome" } });
			assert.equal(attachedWithoutSession.isError, true);
			assert.match(attachedWithoutSession.content[0]?.text ?? "", /qa\.attached requires an active attached session/);
			assert.equal(attachedWithoutSession.details?.failureCategory, "validation-error");

			const cleanResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://example.test/",
					expectedText: ["Welcome"],
				},
			});
			assert.equal(cleanResult.isError, false);
			assert.deepEqual((cleanResult.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, []);
			assert.match((cleanResult.content[0] as { text: string }).text, /QA preset passed\./);
			assert.match((cleanResult.content[0] as { text: string }).text, /Page: QA Page — https:\/\/example\.test\//);
			assert.match((cleanResult.content[0] as { text: string }).text, /Checks run:/);
			assert.match((cleanResult.content[0] as { text: string }).text, /Full diagnostic matrix: see details\.qaPreset and details\.batchSteps\./);
			assert.doesNotMatch((cleanResult.content[0] as { text: string }).text, /Step 1 —/);
			assert.ok(Array.isArray(cleanResult.details?.batchSteps) && (cleanResult.details?.batchSteps as unknown[]).length > 0);

			const benignNetworkResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://favicon.example.test/",
					expectedText: ["Welcome"],
				},
			});
			assert.equal(benignNetworkResult.isError, false);
			assert.deepEqual((benignNetworkResult.details?.qaPreset as { failedChecks?: string[]; warnings?: string[] } | undefined)?.failedChecks, []);
			assert.deepEqual((benignNetworkResult.details?.qaPreset as { warnings?: string[] } | undefined)?.warnings, ["1 benign network request failure(s) ignored"]);
			assert.match((benignNetworkResult.content[0] as { text: string }).text, /QA preset passed with warnings: 1 benign network request failure\(s\) ignored\./);
			assert.match((benignNetworkResult.content[0] as { text: string }).text, /Full diagnostic matrix: see details\.qaPreset and details\.batchSteps\./);
			assert.doesNotMatch((benignNetworkResult.content[0] as { text: string }).text, /Network failure summary:/);
			assert.doesNotMatch((benignNetworkResult.content[0] as { text: string }).text, /Step 1 —/);

			process.env.AGENT_BROWSER_FAKE_QA_MODE = "wait-fail";
			const failedWaitQaResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://example.test/",
					expectedText: ["Missing text"],
				},
			});
			assert.equal(failedWaitQaResult.isError, true);
			assert.equal(failedWaitQaResult.details?.failureCategory, "qa-failure");
			assert.match((failedWaitQaResult.content[0] as { text: string }).text, /QA preset failed/);
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
			assert.equal(missingQaScreenshotResult.details?.failureCategory, "artifact-missing");
			assert.equal((missingQaScreenshotResult.details?.qaPreset as { passed?: boolean } | undefined)?.passed, true);
			assert.match((missingQaScreenshotResult.content[0] as { text: string }).text, /Artifact verification failed/);
			assert.doesNotMatch((missingQaScreenshotResult.content[0] as { text: string }).text, /QA preset passed/);
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
			assert.equal(result.details?.failureCategory, "qa-failure");
			const [realPiFailurePatch] = await runExtensionEventResults<{ content?: Array<{ text?: string; type: string }>; isError?: boolean }>(
				harness.handlers,
				"tool_result",
				{ content: result.content, details: result.details, isError: false, toolName: "agent_browser" },
			);
			assert.equal(realPiFailurePatch?.isError, true);
			assert.match(realPiFailurePatch?.content?.[0]?.text ?? "", /Result category: failure; failureCategory: qa-failure; Pi tool isError: true\./);

			const jsonFailureText = JSON.stringify({ error: "boom", success: false }, null, 2);
			const [jsonFailurePatch] = await runExtensionEventResults<{ content?: Array<{ text?: string; type: string }>; isError?: boolean }>(
				harness.handlers,
				"tool_result",
				{
					content: [{ type: "text", text: jsonFailureText }],
					details: { args: ["--json", "get", "url"], failureCategory: "upstream-error", resultCategory: "failure" },
					input: { args: ["--json", "get", "url"] },
					isError: false,
					toolName: "agent_browser",
				},
			);
			assert.equal(jsonFailurePatch?.isError, true);
			assert.equal(jsonFailurePatch?.content, undefined);
			assert.deepEqual(JSON.parse(jsonFailureText), { error: "boom", success: false });

			const [proseJsonArgsFailurePatch] = await runExtensionEventResults<{ content?: Array<{ text?: string; type: string }>; isError?: boolean }>(
				harness.handlers,
				"tool_result",
				{
					content: [{ type: "text", text: "Wrapper validation failed before upstream JSON output was available." }],
					details: { args: ["--json", "get", "url"], failureCategory: "validation-error", resultCategory: "failure" },
					input: { args: ["--json", "get", "url"] },
					isError: false,
					toolName: "agent_browser",
				},
			);
			assert.equal(proseJsonArgsFailurePatch?.isError, true);
			assert.match(proseJsonArgsFailurePatch?.content?.[0]?.text ?? "", /Result category: failure; failureCategory: validation-error; Pi tool isError: true\./);

			const managedSessionOutcome = result.details?.managedSessionOutcome as { sessionMode?: string; status?: string; succeeded?: boolean } | undefined;
			assert.equal(managedSessionOutcome?.sessionMode, "fresh");
			assert.equal(managedSessionOutcome?.status, "replaced");
			assert.equal(managedSessionOutcome?.succeeded, false);
			assert.match((result.content[0] as { text: string }).text, /Managed session outcome: Fresh launch became current, but this tool call failed after launch\./);
			assert.match((result.content[0] as { text: string }).text, /failureCategory \/ qaPreset/);
			const qaFailureNextActions = result.details?.nextActions as Array<{ id?: string; reason?: string }> | undefined;
			assert.equal(qaFailureNextActions?.some((action) => action.id === "run-agent-browser-doctor"), false);
			assert.ok(qaFailureNextActions?.some((action) => action.id === "verify-current-managed-session" && /current managed session/.test(action.reason ?? "")));
			assert.match((result.content[0] as { text: string }).text, /Step 1 —/);
			assert.deepEqual((result.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, [
				"1 actionable failed network request(s)",
				"1 console error message(s)",
				"1 page error(s)",
			]);
			const compiledQaPreset = result.details?.compiledQaPreset as { args?: string[]; failFast?: boolean; steps?: Array<{ args: string[] }> } | undefined;
			assert.deepEqual(compiledQaPreset?.args, ["batch", "--bail"]);
			assert.equal(compiledQaPreset?.failFast, true);
			const compiledQaSteps = compiledQaPreset?.steps?.map((step) => step.args) ?? [];
			assert.deepEqual(compiledQaSteps.slice(0, 5), [
				["network", "requests", "--clear"],
				["console", "--clear"],
				["errors", "--clear"],
				["open", "https://fail.example.test/"],
				["wait", "--load", "domcontentloaded"],
			]);
			assert.equal(compiledQaSteps[5]?.[0], "wait");
			assert.equal(compiledQaSteps[5]?.[1], "--fn");
			assert.match(compiledQaSteps[5]?.[2] ?? "", /Welcome/);
			assert.deepEqual(compiledQaSteps[5]?.slice(3), ["--timeout", "5000"]);
			assert.deepEqual(compiledQaSteps.slice(6), [
				["wait", "main"],
				["network", "requests"],
				["console"],
				["errors"],
				["screenshot", "qa.png"],
			]);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.filter((entry) => entry.args.at(-2) === "batch" && entry.args.at(-1) === "--bail").length >= 3);

			const firstRunFailureHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(firstRunFailureHarness.handlers, "session_start", { reason: "new" }, firstRunFailureHarness.ctx);
			const firstRunFailure = await executeRegisteredTool(firstRunFailureHarness.tool, firstRunFailureHarness.ctx, {
				qa: {
					url: "https://fail.example.test/",
					expectedText: "Welcome",
				},
				sessionMode: "fresh",
			});
			assert.equal(firstRunFailure.isError, true);
			const firstRunOutcome = firstRunFailure.details?.managedSessionOutcome as { status?: string; succeeded?: boolean } | undefined;
			assert.equal(firstRunOutcome?.status, "created");
			assert.equal(firstRunOutcome?.succeeded, false);
			assert.match((firstRunFailure.content[0] as { text: string }).text, /Managed session outcome: Fresh launch became current, but this tool call failed after launch\./);
			const firstRunNextActions = firstRunFailure.details?.nextActions as Array<{ id?: string; reason?: string }> | undefined;
			assert.equal(firstRunNextActions?.some((action) => action.id === "run-agent-browser-doctor"), false);
			assert.ok(firstRunNextActions?.some((action) => action.id === "verify-current-managed-session" && /current managed session/.test(action.reason ?? "")));

			const attachedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					attached: true,
					expectedText: "Welcome",
					expectedSelector: "main",
				},
			});
			assert.equal(attachedResult.isError, false, JSON.stringify(attachedResult));
			assert.match((attachedResult.content[0] as { text: string }).text, /QA preset passed/);
			assert.doesNotMatch((attachedResult.content[0] as { text: string }).text, /Attached diagnostics: existing upstream session console\/network\/error buffers were preserved/);
			assert.equal((attachedResult.details?.qaAttachedTarget as { title?: string; url?: string } | undefined)?.title, "QA Page");
			assert.equal((attachedResult.details?.qaAttachedTarget as { title?: string; url?: string } | undefined)?.url, "https://fail.example.test/");
			assert.deepEqual((attachedResult.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, []);
			const attachedCompiledQaPreset = attachedResult.details?.compiledQaPreset as { checks?: { attached?: boolean; checkConsole?: boolean; checkErrors?: boolean; checkNetwork?: boolean; diagnosticsResetAtStart?: boolean; url?: string }; steps?: Array<{ args: string[] }> } | undefined;
			assert.equal(attachedCompiledQaPreset?.checks?.attached, true);
			assert.equal(attachedCompiledQaPreset?.checks?.checkNetwork, false);
			assert.equal(attachedCompiledQaPreset?.checks?.checkConsole, false);
			assert.equal(attachedCompiledQaPreset?.checks?.checkErrors, false);
			assert.equal(attachedCompiledQaPreset?.checks?.diagnosticsResetAtStart, false);
			assert.equal(attachedCompiledQaPreset?.checks?.url, undefined);
			const attachedCompiledQaSteps = attachedCompiledQaPreset?.steps?.map((step) => step.args) ?? [];
			assert.deepEqual(attachedCompiledQaSteps.slice(0, 1), [["wait", "--load", "domcontentloaded"]]);
			assert.equal(attachedCompiledQaSteps[1]?.[0], "wait");
			assert.equal(attachedCompiledQaSteps[1]?.[1], "--fn");
			assert.match(attachedCompiledQaSteps[1]?.[2] ?? "", /Welcome/);
			assert.deepEqual(attachedCompiledQaSteps[1]?.slice(3), ["--timeout", "5000"]);
			assert.deepEqual(attachedCompiledQaSteps.slice(2), [["wait", "main"]]);
			const attachedInvocation = [...await readInvocationLog(logPath)].reverse().find((entry) => entry.args.at(-2) === "batch" && entry.args.at(-1) === "--bail" && entry.stdin?.trim().startsWith("["));
			assert.ok(attachedInvocation);
			const attachedSteps = JSON.parse(attachedInvocation.stdin ?? "[]") as string[][];
			assert.equal(attachedSteps.some((step) => step[0] === "open"), false);

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
			assert.equal(attachedCheckedResult.details?.failureCategory, "qa-failure");
			assert.match((attachedCheckedResult.content[0] as { text: string }).text, /QA preset failed/);
			assert.match((attachedCheckedResult.content[0] as { text: string }).text, /Attached diagnostics: existing upstream session console\/network\/error buffers were preserved/);
			assert.deepEqual((attachedCheckedResult.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, [
				"1 actionable failed network request(s)",
				"1 console error message(s)",
				"1 page error(s)",
			]);

			const attachedFreshResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: { attached: true, expectedText: "Welcome" },
				sessionMode: "fresh",
			});
			assert.equal(attachedFreshResult.isError, true);
			assert.match(attachedFreshResult.content[0]?.text ?? "", /qa\.attached cannot be used with sessionMode=fresh/);
			assert.equal(attachedFreshResult.details?.failureCategory, "validation-error");

			const attachedWithUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: { attached: true, url: "https://example.test/" },
			});
			assert.equal(attachedWithUrl.isError, true);
			assert.match(attachedWithUrl.content[0]?.text ?? "", /qa\.url must be omitted when qa\.attached is true/);
			assert.equal(attachedWithUrl.details?.failureCategory, "validation-error");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allows qa.attached preflight when get title fails but get url succeeds", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-qa-attached-title-fail-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let stdin = "";
const statePath = path.join(${JSON.stringify(tempDir)}, "fake-session-state.json");
const valueFlags = new Set(["--session", "--profile", "--state", "--session-name", "--cdp", "--provider", "-p", "--device", "--user-agent"]);
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
  if (command === "get" && subcommand === "title") {
    process.stderr.write("get title failed");
    process.exit(1);
  }
  if (command === "get" && subcommand === "url") {
    writeStandaloneResult({ result: sessionState.url, url: sessionState.url });
    return true;
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
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["connect", "9222"] });
			const attachedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: { attached: true, expectedText: "Welcome" },
			});
			assert.equal(attachedResult.isError, false);
			assert.match(attachedResult.content[0]?.text ?? "", /QA preset passed\./);
			const invocations = await readInvocationLog(logPath);
			const batchIndex = invocations.findIndex((entry) => entry.args.at(-2) === "batch" && entry.args.at(-1) === "--bail");
			assert.ok(batchIndex >= 0);
			const preflightInvocations = invocations.slice(0, batchIndex);
			assert.ok(preflightInvocations.some((entry) => entry.args.includes("get") && entry.args.includes("url")));
			assert.equal(preflightInvocations.some((entry) => entry.args.includes("get") && entry.args.includes("title")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects qa.attached when attached URL is not http(s)", { concurrency: false }, async () => {
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
const valueFlags = new Set(["--session", "--profile", "--state", "--session-name", "--cdp", "--provider", "-p", "--device", "--user-agent"]);
function getSessionKey() {
  const index = args.indexOf("--session");
  return index >= 0 ? args[index + 1] : "default";
}
function readSessionState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed[getSessionKey()] ?? { title: "Blank Page", url: "about:blank" };
  } catch {
    return { title: "Blank Page", url: "about:blank" };
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
    writeStandaloneResult({ result: sessionState.title, title: sessionState.title });
    return true;
  }
  if (command === "open") {
    const url = String(subcommand || "about:blank");
    writeStandaloneResult({ title: "Blank Page", url });
    return true;
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
  process.stdout.write(JSON.stringify([]));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["connect", "9222"] });
			const attachedBlankResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: { attached: true, expectedText: "Welcome" },
			});
			assert.equal(attachedBlankResult.isError, true);
			assert.match(attachedBlankResult.content[0]?.text ?? "", /qa\.attached requires an http\(s\) page URL/);
			assert.equal(attachedBlankResult.details?.failureCategory, "validation-error");
			assert.deepEqual((attachedBlankResult.details?.nextActions as Array<{ id: string }> | undefined)?.map((action) => action.id), [
				"list-tabs-before-qa-attached",
				"snapshot-before-qa-attached",
			]);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.some((entry) => entry.args.at(-1) === "batch"), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
