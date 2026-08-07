import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Check } from "typebox/value";

import { AGENT_BROWSER_PARAMS } from "../extensions/agent-browser/lib/input-modes/params.js";
import {
	AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_MAX_CALLS,
	compileAgentBrowserScript,
	runAgentBrowserScript,
	validateAgentBrowserScriptBrowserParams,
	type AgentBrowserScriptBrowserEnvelope,
} from "../extensions/agent-browser/lib/input-modes/script.js";
import { resolveAgentBrowserInput } from "../extensions/agent-browser/lib/orchestration/input-plan.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const successEnvelope = (data: unknown, summary = "Browser call completed."): AgentBrowserScriptBrowserEnvelope => ({
	data,
	ok: true,
	resultCategory: "success",
	successCategory: "inspection",
	summary,
	text: summary,
});

const resolveInput = (params: Parameters<typeof resolveAgentBrowserInput>[0]["params"]) => resolveAgentBrowserInput({
	getBatchPreflightValidationError: () => undefined,
	managedSessionActive: false,
	params,
});

test("script input schema and runtime validation enforce one top-level mode", () => {
	assert.equal(Check(AGENT_BROWSER_PARAMS, { script: "emit(1)" }), true);
	assert.equal(Check(AGENT_BROWSER_PARAMS, { script: 1 }), false);
	assert.equal(Check(AGENT_BROWSER_PARAMS, { script: "x".repeat(AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES + 1) }), false);
	assert.equal(resolveInput({ script: "emit(1)" }).kind, "script");
	const invalidInputs: Array<[Parameters<typeof resolveAgentBrowserInput>[0]["params"], RegExp]> = [
		[{ args: ["get", "title"], script: "emit(1)" }, /exactly one/],
		[{ script: "emit(1)", stdin: "no" }, /Do not provide stdin with script/],
		[{ script: "emit(1)", sessionMode: "fresh" }, /Do not provide sessionMode with script/],
		[{ script: "emit(1)", timeoutMs: 300_001 }, /300000 or less/],
	];
	for (const [params, expected] of invalidInputs) {
		const input = resolveInput(params);
		assert.equal(input.status, "invalid");
		assert.match(input.validationError, expected);
	}
	assert.match(compileAgentBrowserScript("💥".repeat(AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES / 2)).error ?? "", /65536 bytes or less/);
});

test("script runner supports loops, conditionals, emit, and serialized Promise.all", async () => {
	let active = 0;
	let maxActive = 0;
	const calls: string[] = [];
	const result = await runAgentBrowserScript({
		code: `
const kept = [];
for (const name of ["one", "skip", "two"]) {
  const result = await browser({ args: ["get", name] });
  if (result.ok && name !== "skip") kept.push(result.data.value);
}
const parallel = await Promise.all([
  browser({ args: ["get", "three"] }),
  browser({ args: ["get", "four"] }),
]);
emit({ kept, parallel: parallel.map((item) => item.data.value) });`,
		dispatch: async (params) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			calls.push(params.args[1] ?? "");
			await delay(5);
			active -= 1;
			return successEnvelope({ value: params.args[1] });
		},
	});
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.data, { kept: ["one", "two"], parallel: ["three", "four"] });
	assert.deepEqual(calls, ["one", "skip", "two", "three", "four"]);
	assert.equal(maxActive, 1);
	assert.equal(result.steps.length, 5);
});

test("script browser envelopes expose actionable rejected-call errors and emit aggregation is deterministic", async () => {
	const rejected = await runAgentBrowserScript({
		code: `const result = await browser({ args: ["close"] }); emit({ error: result.error, failureCategory: result.details.failureCategory });`,
		dispatch: async () => { throw new Error("rejected calls must not dispatch"); },
	});
	assert.deepEqual(rejected.data, {
		error: "script browser calls cannot close, quit, or exit their isolated session.",
		failureCategory: "policy-blocked",
	});
	assert.equal(rejected.rejectedCallCount, 1);

	const emissions = await runAgentBrowserScript({
		code: `emit("first"); emit("second"); return "ignored";`,
		dispatch: async () => successEnvelope(null),
	});
	assert.deepEqual(emissions.data, ["first", "second"]);
	assert.equal(emissions.emitCount, 2);

	const returned = await runAgentBrowserScript({
		code: `return { returned: true };`,
		dispatch: async () => successEnvelope(null),
	});
	assert.deepEqual(returned.data, { returned: true });
});

test("script sandbox exposes only context-native wrappers and blocks constructor escapes", async () => {
	const result = await runAgentBrowserScript({
		code: `
const blocked = (fn) => { try { fn(); return false; } catch { return true; } };
const promise = browser({ args: ["get", "title"] });
const browserResult = await promise;
const AsyncFunction = (async function () {}).constructor;
const GeneratorFunction = (function* () {}).constructor;
emit({
  browserPrototypeIsNull: Object.getPrototypeOf(browser) === null,
  emitPrototypeIsNull: Object.getPrototypeOf(emit) === null,
  browserConstructorType: typeof browser.constructor,
  emitConstructorType: typeof emit.constructor,
  promiseIsNative: promise.constructor === Promise,
  resultIsNative: Object.getPrototypeOf(browserResult) === Object.prototype,
  functionBlocked: blocked(() => Function("return globalThis")()),
  asyncFunctionBlocked: blocked(() => AsyncFunction("return globalThis")()),
  generatorFunctionBlocked: blocked(() => GeneratorFunction("return globalThis")()),
  directHostEscapeBlocked: blocked(() => browser.constructor.constructor("return process")()),
  processType: typeof process,
  requireType: typeof require,
  fetchType: typeof fetch,
  timerType: typeof setTimeout,
  webSocketType: typeof WebSocket,
});`,
		dispatch: async () => successEnvelope({ title: "Sandbox" }),
	});
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.data, {
		browserPrototypeIsNull: true,
		emitPrototypeIsNull: true,
		browserConstructorType: "undefined",
		emitConstructorType: "undefined",
		promiseIsNative: true,
		resultIsNative: true,
		functionBlocked: true,
		asyncFunctionBlocked: true,
		generatorFunctionBlocked: true,
		directHostEscapeBlocked: true,
		processType: "undefined",
		requireType: "undefined",
		fetchType: "undefined",
		timerType: "undefined",
		webSocketType: "undefined",
	});

	const dynamicImport = await runAgentBrowserScript({
		code: `await import("node:fs"); emit("unreachable");`,
		dispatch: async () => successEnvelope(null),
	});
	assert.equal(dynamicImport.ok, false);
	assert.match(dynamicImport.error ?? "", /sandbox exited before completion|dynamic import callback/i);
});

test("script runner enforces call, output, IPC, timeout, and abort limits", async () => {
	let dispatchCount = 0;
	const callLimit = await runAgentBrowserScript({
		code: `for (let index = 0; index < ${AGENT_BROWSER_SCRIPT_MAX_CALLS + 1}; index += 1) await browser({ args: ["get", String(index)] });`,
		dispatch: async () => {
			dispatchCount += 1;
			return successEnvelope(null);
		},
	});
	assert.equal(callLimit.ok, false);
	assert.match(callLimit.error ?? "", /call limit exceeded/);
	assert.equal(dispatchCount, AGENT_BROWSER_SCRIPT_MAX_CALLS);

	const outputLimit = await runAgentBrowserScript({
		code: `emit("x".repeat(${AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES + 1}));`,
		dispatch: async () => successEnvelope(null),
	});
	assert.equal(outputLimit.ok, false);
	assert.match(outputLimit.error ?? "", /Final script output exceeds/);

	const requestLimit = await runAgentBrowserScript({
		code: `await browser({ args: ["get", "x".repeat(${AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES})] });`,
		dispatch: async () => {
			throw new Error("oversized request must not dispatch");
		},
	});
	assert.equal(requestLimit.ok, false);
	assert.match(requestLimit.error ?? "", /IPC limit exceeded/);

	const responseLimit = await runAgentBrowserScript({
		code: `await browser({ args: ["get", "title"] });`,
		dispatch: async () => successEnvelope("x".repeat(AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES)),
	});
	assert.equal(responseLimit.ok, false);
	assert.match(responseLimit.error ?? "", /Unable to return a browser result/);

	const timedOut = await runAgentBrowserScript({
		code: "while (true) {}",
		dispatch: async () => successEnvelope(null),
		timeoutMs: 100,
	});
	assert.equal(timedOut.ok, false);
	assert.equal(timedOut.timedOut, true);
	assert.equal(timedOut.failureCategory, "timeout");

	const controller = new AbortController();
	let activeCallAborted = false;
	let started!: () => void;
	const activeCallStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let abortedDispatchCount = 0;
	const abortedPromise = runAgentBrowserScript({
		code: `await browser({ args: ["get", "slow"] }); await browser({ args: ["get", "late"] });`,
		dispatch: async (_params, signal) => {
			abortedDispatchCount += 1;
			started();
			return await new Promise<AgentBrowserScriptBrowserEnvelope>((resolve) => {
				signal.addEventListener("abort", () => {
					activeCallAborted = true;
					resolve({ data: null, failureCategory: "aborted", ok: false, resultCategory: "failure", summary: "aborted", text: "aborted" });
				}, { once: true });
			});
		},
		signal: controller.signal,
	});
	await activeCallStarted;
	controller.abort();
	const aborted = await abortedPromise;
	assert.equal(aborted.aborted, true);
	assert.equal(activeCallAborted, true);
	assert.equal(abortedDispatchCount, 1, "no browser call should dispatch after abort");
});

test("script inner policy rejects identity, lifecycle, batch, local, and persistent launch controls", () => {
	for (const args of [
		["--session", "other", "get", "title"],
		["--namespace", "other", "get", "title"],
		["close"],
		["quit"],
		["connect", "9222"],
		["attach", "9222"],
		["batch"],
		["session", "list"],
		["state", "save", "saved.json"],
		["auth", "login", "example"],
		["--profile", "Default", "open", "https://example.test"],
		["--state", "state.json", "open", "https://example.test"],
		["--restore", "open", "https://example.test"],
		["--cdp", "9222", "get", "title"],
		["--provider", "browserbase", "get", "title"],
	]) {
		const result = validateAgentBrowserScriptBrowserParams({ args });
		assert.equal(result.params, undefined, `unexpected policy success for ${JSON.stringify(args)}`);
		assert.equal(result.policyBlocked, true);
	}
	assert.deepEqual(validateAgentBrowserScriptBrowserParams({ args: ["--allowed-domains", "example.test", "open", "https://example.test"] }).params?.args, ["--allowed-domains", "example.test", "open", "https://example.test"]);
	assert.match(validateAgentBrowserScriptBrowserParams({ args: ["get", "title"], job: {} }).error ?? "", /does not support job/);
});

test("script mode fails closed when Pi session persistence is disabled", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-script-no-session-"));
	try {
		const harness = createExtensionHarness({ cwd: tempDir });
		await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { script: "emit('no')" });
		assert.equal(result.isError, true);
		assert.equal(result.details?.failureCategory, "validation-error");
		assert.match(result.content[0]?.text ?? "", /requires a persisted Pi session/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("session_shutdown aborts and reaps an active sandbox child", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-script-shutdown-"));
	try {
		const harness = createExtensionHarness({ cwd: tempDir, sessionFile: join(tempDir, "session.jsonl") });
		await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
		const pendingResult = executeRegisteredTool(harness.tool, harness.ctx, { script: "while (true) {}", timeoutMs: 10_000 });
		await delay(50);
		await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		const result = await pendingResult;
		assert.equal(result.isError, true);
		assert.equal(result.details?.failureCategory, "aborted");
		assert.equal((result.details?.scriptRun as { aborted?: boolean } | undefined)?.aborted, true);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension injects an isolated script session, persists its lease before spawn, and closes it", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-script-extension-"));
	const logPath = join(tempDir, "invocations.log");
	const leaseMarkerPath = join(tempDir, "lease-active");
	const outputPath = join(tempDir, "script-output.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, leasePresent: fs.existsSync(${JSON.stringify(leaseMarkerPath)}) }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: false, runtime: null } }));
} else if (args.includes("close")) {
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else if (args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.test/", url: "https://example.test/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { password: "secret-value", result: "Script title", title: "Script title" } }));
}`);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const harness = createExtensionHarness({
				cwd: tempDir,
				sessionFile: join(tempDir, "session.jsonl"),
				onAppendEntry(customType, data) {
					if (customType === "agent-browser-script-session" && (data as { cleanup?: string }).cleanup === "active") writeFileSync(leaseMarkerPath, "active");
				},
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const beforeScript = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"] });
			assert.equal(beforeScript.isError, false);
			const implicitSessionName = beforeScript.details?.sessionName;
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				outputPath,
				script: `
const values = [];
for (let index = 0; index < 2; index += 1) {
  const result = await browser({ args: ["get", "title"] });
  if (result.ok) values.push({ title: result.data.title, password: result.data.password });
}
emit(values);`,
			});
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.deepEqual(result.details?.data, [
				{ title: "Script title", password: "[REDACTED]" },
				{ title: "Script title", password: "[REDACTED]" },
			]);
			assert.equal((result.details?.scriptSteps as unknown[])?.length, 2);
			const scriptSession = result.details?.scriptSession as { cleanup?: string; sessionName?: string } | undefined;
			assert.equal(scriptSession?.cleanup, "closed");
			assert.match(scriptSession?.sessionName ?? "", /^piab-script-[0-9a-f-]{36}$/);
			const closeCommandArgs = ["--namespace", "", "--session", scriptSession?.sessionName, "close"];
			assert.deepEqual(harness.appendedEntries.map((entry) => entry.data), [
				{ cleanup: "active", closeCommandArgs, launchAttempted: true, sessionName: scriptSession?.sessionName },
				{ cleanup: "closed", closeCommandArgs, launchAttempted: true, sessionName: scriptSession?.sessionName },
			]);
			assert.deepEqual(scriptSession, { cleanup: "closed", closeCommandArgs, launchAttempted: true, sessionName: scriptSession?.sessionName });
			const secondResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				script: `emit((await browser({ args: ["get", "title"] })).data.title);`,
			});
			const secondSessionName = (secondResult.details?.scriptSession as { sessionName?: string } | undefined)?.sessionName;
			assert.notEqual(secondSessionName, scriptSession?.sessionName, "every script call must receive a unique isolated session");
			const afterScript = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"] });
			assert.equal(afterScript.details?.sessionName, implicitSessionName, "script must not replace the current implicit session");
			const invocations = await readInvocationLog(logPath) as Array<{ args: string[]; leasePresent?: boolean }>;
			assert.ok(invocations.length > 0);
			const scriptInvocations = invocations.filter((entry) => entry.args.includes(scriptSession?.sessionName ?? "missing"));
			assert.ok(scriptInvocations.every((entry) => entry.leasePresent === true), "lease must exist before every isolated-session fake upstream spawn");
			const contentInvocations = scriptInvocations.filter((entry) => entry.args.includes("get") && entry.args.includes("title"));
			assert.ok(contentInvocations.length >= 2);
			for (const invocation of contentInvocations) {
				assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--namespace"), invocation.args.indexOf("--namespace") + 4), ["--namespace", "", "--session", scriptSession?.sessionName]);
			}
			assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result.details?.data);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension closes its isolated session after a script timeout", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-script-timeout-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: args.includes("close") ? { closed: true } : { title: "ok" } }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionFile: join(tempDir, "session.jsonl") });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				script: `await browser({ args: ["get", "title"] }); while (true) {}`,
				timeoutMs: 150,
			});
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "timeout");
			assert.equal((result.details?.scriptSession as { cleanup?: string } | undefined)?.cleanup, "closed");
			assert.deepEqual(harness.appendedEntries.map((entry) => (entry.data as { cleanup?: string }).cleanup), ["active", "closed"]);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("close")));

			const thrown = await executeRegisteredTool(harness.tool, harness.ctx, {
				script: `await browser({ args: ["get", "title"] }); throw new Error("intentional cleanup probe");`,
			});
			assert.equal(thrown.isError, true);
			assert.equal(thrown.details?.failureCategory, "script-error");
			assert.match((thrown.content[0] as { text: string }).text, /Script failed: Error: intentional cleanup probe/);
			assert.match((thrown.content[0] as { text: string }).text, /Isolated script session closed/);
			assert.deepEqual(thrown.details?.scriptRun, {
				aborted: undefined,
				callCount: 1,
				emitCount: 0,
				failedCallCount: 0,
				preDispatchRejectedCallCount: 0,
				successfulCallCount: 1,
				timedOut: undefined,
			});
			assert.equal((thrown.details?.scriptSession as { cleanup?: string } | undefined)?.cleanup, "closed");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rehydrates only its verified compact spill for script logic", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-script-spill-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const args = process.argv.slice(2);
if (args.includes("close")) process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
else process.stdout.write(JSON.stringify({ success: true, data: Array.from({ length: 700 }, (_, index) => ({ index, text: "row-" + index + "-" + "x".repeat(30) })) }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionFile: join(tempDir, "session.jsonl") });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				script: `const result = await browser({ args: ["eval", "--stdin"], stdin: "() => []" }); emit({ length: result.data.length, last: result.data.at(-1).index });`,
			});
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.deepEqual(result.details?.data, { length: 700, last: 699 });
			assert.ok((result.details?.artifactManifest as { entries?: Array<{ kind?: string }> } | undefined)?.entries?.some((entry) => entry.kind === "spill"));
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("script cleanup failure is durable and exposes the exact close action", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-script-cleanup-fail-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const args = process.argv.slice(2);
if (args.includes("close")) { process.stderr.write("close failed"); process.exit(1); }
process.stdout.write(JSON.stringify({ success: true, data: { title: "ok" } }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, sessionFile: join(tempDir, "session.jsonl") });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { script: `emit((await browser({ args: ["get", "title"] })).data.title);` });
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "cleanup-failed");
			const scriptSession = result.details?.scriptSession as { cleanup?: string; sessionName?: string } | undefined;
			assert.equal(scriptSession?.cleanup, "failed");
			const closeAction = (result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }>)[0];
			assert.equal(closeAction?.id, "close-script-session-after-cleanup-failure");
			assert.deepEqual(closeAction?.params?.args, ["--namespace", "", "--session", scriptSession?.sessionName, "close"]);
			assert.equal((harness.appendedEntries.at(-1)?.data as { cleanup?: string }).cleanup, "failed");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("session_start restores failed script leases and retries close in a new extension process", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-script-restore-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	const sessionName = "piab-script-12345678-1234-4123-8123-123456789abc";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs"); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n"); process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({
				branch: [
					{ type: "custom", customType: "agent-browser-script-session", data: { cleanup: "failed", closeCommandArgs: ["--namespace", "", "--session", sessionName, "close"], launchAttempted: true, sessionName } },
					{ type: "custom", customType: "agent-browser-script-session", data: { cleanup: "active", closeCommandArgs: ["--session", "other", "close"], launchAttempted: true, sessionName } },
					{ type: "custom", customType: "agent-browser-script-session", data: { sessionName: "piab-script-not-a-uuid", cleanup: "active", args: ["secret"] } },
				],
				cwd: tempDir,
				sessionFile: join(tempDir, "session.jsonl"),
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			assert.deepEqual(harness.appendedEntries.map((entry) => entry.data), [{ cleanup: "closed", closeCommandArgs: ["--namespace", "", "--session", sessionName, "close"], launchAttempted: true, sessionName }]);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("close") && entry.args.includes(sessionName)));
			assert.equal(invocations.some((entry) => entry.args.includes("piab-script-not-a-uuid")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
