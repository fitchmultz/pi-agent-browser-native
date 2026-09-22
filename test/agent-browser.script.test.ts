import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
	AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_MAX_CALLS,
	bindBrowserCodeCall,
	validateAgentBrowserScriptSource,
	runAgentBrowserScript,
	validateAgentBrowserScriptBrowserParams,
	type AgentBrowserScriptBrowserEnvelope,
} from "../extensions/agent-browser/lib/input-modes/script.js";
import { createBrowserCodeOutput } from "../extensions/agent-browser/lib/orchestration/script-mode.js";
import { BROWSER_TRANSITION_ENTRY } from "../extensions/agent-browser/lib/browser-transcript.js";
import { getAgentBrowserSessionIdentityKey } from "../extensions/agent-browser/lib/argv-grammar.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import { createExtensionHarness, executeRegisteredTool, readInvocationLog, runExtensionEvent, withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

const successEnvelope = (data: unknown): AgentBrowserScriptBrowserEnvelope => ({
	data, success: true, resultCategory: "success", successCategory: "inspection", summary: "Browser call completed.",
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4L8AAAAASUVORK5CYII=", "base64");

test("code runner uses branches and native batch while serializing concurrent inner calls", async () => {
	let active = 0;
	let maxActive = 0;
	const calls: string[][] = [];
	const result = await runAgentBrowserScript({
		code: `const kept=[]; for (const name of ["one","skip","two"]) { const r=await browser({args:["get",name]}); if(r.success && name!=="skip") kept.push(r.data.value); }
const parallel=await Promise.all([browser({args:["get","three"]}),browser({args:["get","four"]})]);
const batch=await browser({args:["batch","--bail"],stdin:JSON.stringify([["get","title"],["get","url"]])});
emit({kept,parallel:parallel.map(r=>r.data.value),batch:batch.data.value});`,
		dispatch: async params => {
			active += 1; maxActive = Math.max(active, maxActive); calls.push(params.args);
			await delay(5); active -= 1;
			return successEnvelope({ value: params.args[1] });
		},
	});
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.data, { kept: ["one", "two"], parallel: ["three", "four"], batch: "--bail" });
	assert.equal(maxActive, 1);
	assert.equal(calls.length, 6);
	assert.deepEqual(calls.at(-1), ["batch", "--bail"]);
});

test("code validates JSON calls without restricting native commands or local authority", () => {
	for (const args of [["close"], ["connect", "9222"], ["state", "save", "saved.json"], ["auth", "login", "example"], ["--profile", "Default", "open", "https://example.test"], ["batch", "--bail"]]) {
		assert.deepEqual(validateAgentBrowserScriptBrowserParams({ args }).params?.args, args);
	}
	assert.match(validateAgentBrowserScriptBrowserParams({ args: ["get", "title"], job: {} }).error ?? "", /does not support job/);
	assert.match(validateAgentBrowserScriptSource("💥".repeat(AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES / 2)).error ?? "", /65536 bytes or less/);
	assert.deepEqual(bindBrowserCodeCall({ args: ["--namespace", "", "--session", "chosen", "get", "url"] }, { sessionName: "chosen" }).args, ["--namespace", "", "--session", "chosen", "get", "url"]);
	assert.throws(() => bindBrowserCodeCall({ args: ["batch", "close --all"] }, { sessionName: "chosen" }), /namespace-wide close/);
});

test("code observations carry failures and exact recoveries without duplicated text/details", async () => {
	const result = await runAgentBrowserScript({
		code: `const failed=await browser({args:["click","#missing"]}); emit({success:failed.success,retry:failed.nextActions[0].params,text:typeof failed.text,details:typeof failed.details});`,
		dispatch: async () => ({ success: false, data: null, resultCategory: "failure", failureCategory: "selector-not-found", error: "Missing selector", nextActions: [{ id: "inspect", params: { args: ["snapshot", "-i"] }, reason: "Inspect the current page", tool: "agent_browser" }] }),
	});
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.data, { success: false, retry: { args: ["snapshot", "-i"] }, text: "undefined", details: "undefined" });
	assert.equal(result.failures?.[0]?.failureCategory, "selector-not-found");
	assert.deepEqual(result.failures?.[0]?.nextActions?.[0]?.params, { args: ["snapshot", "-i"] });
	const failedInput = await runAgentBrowserScript({ code: `emit(await browser());`, dispatch: async () => assert.fail("invalid input must not dispatch") });
	assert.equal(failedInput.rejectedCallCount, 1);
	assert.equal(failedInput.failures?.[0]?.failureCategory, "validation-error");
});

test("permissioned fresh contexts expose only native JSON bridge functions", async () => {
	const result = await runAgentBrowserScript({
		code: `const blocked=fn=>{try{fn();return false}catch{return true}}; const promise=browser({args:["get","title"]}); const r=await promise;
emit({nullPrototypes:[browser,emit,emitImage].every(fn=>Object.getPrototypeOf(fn)===null), promise:promise.constructor===Promise, result:Object.getPrototypeOf(r)===Object.prototype,
functionBlocked:blocked(()=>Function("return globalThis")()), asyncBlocked:blocked(()=>(async function(){}).constructor("return globalThis")()), generatorBlocked:blocked(()=>(function*(){}).constructor("return globalThis")()), escapeBlocked:blocked(()=>browser.constructor.constructor("return process")()),
host:[typeof process,typeof require,typeof fetch,typeof setTimeout,typeof WebSocket]}); globalThis.previousCell=1;`,
		dispatch: async () => successEnvelope({ title: "Sandbox" }),
	});
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.data, { nullPrototypes: true, promise: true, result: true, functionBlocked: true, asyncBlocked: true, generatorBlocked: true, escapeBlocked: true, host: Array(5).fill("undefined") });
	const next = await runAgentBrowserScript({ code: `emit(typeof previousCell);`, dispatch: async () => successEnvelope(null) });
	assert.equal(next.data, "undefined");
	const imported = await runAgentBrowserScript({ code: `await import("node:fs");`, dispatch: async () => successEnvelope(null) });
	assert.equal(imported.ok, false);
	assert.match(imported.error ?? "", /sandbox exited before completion|dynamic import callback/i);
});

test("code enforces call, output, IPC and time limits and retains partial emissions", async () => {
	let dispatched = 0;
	const calls = await runAgentBrowserScript({ code: `for(let i=0;i<${AGENT_BROWSER_SCRIPT_MAX_CALLS + 1};i++) await browser({args:["get","title"]});`, dispatch: async () => { dispatched++; return successEnvelope(null); } });
	assert.equal(calls.ok, false); assert.equal(dispatched, AGENT_BROWSER_SCRIPT_MAX_CALLS);
	assert.match(calls.error ?? "", /call limit exceeded/);
	const output = await runAgentBrowserScript({ code: `emit("x".repeat(${AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES + 1}));`, dispatch: async () => successEnvelope(null) });
	assert.equal(output.ok, false); assert.match(output.error ?? "", /output exceeds/);
	const request = await runAgentBrowserScript({ code: `await browser({args:["get","x".repeat(${AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES})]});`, dispatch: async () => assert.fail("oversized request must not dispatch") });
	assert.equal(request.ok, false); assert.match(request.error ?? "", /IPC limit exceeded/);
	const response = await runAgentBrowserScript({ code: `await browser({args:["get","title"]});`, dispatch: async () => successEnvelope("x".repeat(AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES)) });
	assert.equal(response.ok, false); assert.match(response.error ?? "", /Unable to return a browser result/);
	const raw = await runAgentBrowserScript({ code: `const r=await browser({args:["eval","--stdin"],stdin:"[]"}); emit(r.data.length);`, dispatch: async () => successEnvelope("x".repeat(512 * 1_024)) });
	assert.equal(raw.data, 512 * 1_024);
	const timedOut = await runAgentBrowserScript({ code: `emit("completed prefix"); while(true){}`, timeoutMs: 200, dispatch: async () => successEnvelope(null) });
	assert.equal(timedOut.timedOut, true); assert.equal(timedOut.data, "completed prefix");
	for (const code of ["emit(undefined);", "emit(()=>1);"]) {
		const invalid = await runAgentBrowserScript({ code, dispatch: async () => successEnvelope(null) });
		assert.equal(invalid.ok, false); assert.match(invalid.error ?? "", /JSON-serializable value/);
	}
});

test("abort waits for the dispatched operation and does not start queued siblings", async () => {
	const controller = new AbortController();
	let started!: () => void;
	const active = new Promise<void>(resolve => { started = resolve; });
	let drained = false;
	let calls = 0;
	const pending = runAgentBrowserScript({
		code: `await Promise.all([browser({args:["get","slow"]}),browser({args:["get","late"]})]);`,
		signal: controller.signal,
		dispatch: async (_params, signal) => {
			calls++; started();
			await new Promise<void>(resolve => signal.addEventListener("abort", () => { setTimeout(resolve, 40); }, { once: true }));
			drained = true;
			return { success: false, resultCategory: "failure", failureCategory: "aborted", error: "aborted" };
		},
	});
	await active; controller.abort();
	const result = await pending;
	assert.equal(result.aborted, true); assert.equal(drained, true); assert.equal(calls, 1);
	assert.equal(result.steps.length, 1); assert.equal(result.failures?.[0]?.failureCategory, "aborted");
});

test("selected image emission forwards real bytes once and rejects stale or invented handles", async () => {
	const dir = await mkdtemp(join(tmpdir(), "piab-code-image-"));
	try {
		const path = join(dir, "capture.png"); await writeFile(path, PNG);
		const output = createBrowserCodeOutput();
		const observation = await output.observe({ content: [], details: { resultCategory: "success", data: { path }, imageObservations: [{ path, mimeType: "image/png", pixels: { width: 1, height: 1 }, capture: "unknown", geometry: { status: "unknown", reason: "Fixture" } }] } });
		const result = await runAgentBrowserScript({ code: `const r=await browser({args:["screenshot"]}); emitImage(r.imageObservations[0]); emitImage(r.imageObservations[0]); emit({visible:true});`, dispatch: async () => observation, emitImage: output.emitImage });
		assert.equal(result.ok, true, result.error);
		const final = await output.finish(result, "persistent");
		assert.equal(final.content.filter(item => item.type === "image").length, 1);
		const image = final.content.find(item => item.type === "image");
		assert.ok(image?.type === "image"); assert.deepEqual(Buffer.from(image.data, "base64"), PNG);
		await assert.rejects(output.emitImage({ id: "not-captured" }), /handle returned by browser/);
		const staleOutput = createBrowserCodeOutput();
		const stale = await staleOutput.observe({ content: [], details: { imageObservations: observation.imageObservations, resultCategory: "success" } });
		await writeFile(path, Buffer.concat([PNG, Buffer.from("changed")]));
		await assert.rejects(staleOutput.emitImage(stale.imageObservations?.[0]), /changed since capture/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing compiled worker returns a setup failure", { concurrency: false }, async () => {
	const worker = join(process.cwd(), "dist/extensions/agent-browser/script-worker.js");
	const backup = `${worker}.test-backup`; await rename(worker, backup);
	try {
		const result = await runAgentBrowserScript({ code: "emit(1)", dispatch: async () => successEnvelope(null) });
		assert.equal(result.failureCategory, "missing-binary"); assert.match(result.error ?? "", /Compiled script worker is missing/);
	} finally { await rename(backup, worker); }
});

async function withCodeHarness(run: (harness: ReturnType<typeof createExtensionHarness>, logPath: string, dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "piab-code-integration-"));
	const logPath = join(dir, "calls.jsonl");
	const statePath = join(dir, "page.json");
	await writeFakeAgentBrowserBinary(dir, `const fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify({args})+'\\n');
let url='about:blank'; try{url=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8')).url}catch{}
const command=args.find(arg=>['open','get','snapshot','eval','close','batch'].includes(arg)); let data;
if(command==='open'){url=args[args.indexOf('open')+1]; fs.writeFileSync(${JSON.stringify(statePath)},JSON.stringify({url})); data={url,title:'Fixture'};}
else if(command==='close') data={closed:true};
else if(command==='snapshot') data={url,refs:{e1:{role:'button',name:'Submit'}},snapshot:'- button "Submit" [ref=e1]'};
else if(command==='eval') data={result:'x'.repeat(30000)+'END'};
else data=args.includes('url')?{url}:{title:'Fixture'};
process.stdout.write(JSON.stringify({success:true,data}));`);
	try {
		await withPatchedEnv({ PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			const harness = createExtensionHarness({ cwd: dir, sessionFile: join(dir, "session.jsonl") });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			try { await run(harness, logPath, dir); }
			finally { await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx); }
		});
	} finally { await rm(dir, { recursive: true, force: true }); }
}

test("code shares the selected persistent browser with direct calls and persists ordered resume state", { concurrency: false }, async () => {
	await withCodeHarness(async (harness, logPath) => {
		const code = harness.getTool("agent_browser_code"); assert.ok(code);
		const direct = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://fixture.test/start"] });
		assert.equal(direct.isError, false, JSON.stringify(direct));
		const first = await executeRegisteredTool(code, harness.ctx, { code: `await browser({args:["open","https://fixture.test/one"]}); await browser({args:["snapshot","-i"]}); emit((await browser({args:["open","https://fixture.test/two"]})).data.url);` });
		assert.equal(first.isError, false, JSON.stringify(first)); assert.equal(first.details?.data, "https://fixture.test/two");
		assert.equal(first.details?.sessionName, direct.details?.sessionName);
		const second = await executeRegisteredTool(code, harness.ctx, { code: `emit((await browser({args:["get","url"]})).data.url);` });
		assert.equal(second.details?.data, "https://fixture.test/two");
		assert.equal(second.details?.sessionName, first.details?.sessionName);
		assert.equal((await readInvocationLog(logPath)).some(call => call.args.includes("close")), false, "code completion must preserve the browser");
		const transitions = harness.appendedEntries.filter(entry => entry.customType === BROWSER_TRANSITION_ENTRY);
		assert.equal(transitions.length, 8, "each dispatched inner command has an intent and completed transition");
		assert.ok(transitions.every(entry => !("data" in (entry.data as { details: object }).details)), "state journal must not copy page output");
		const state = SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch());
		const key = getAgentBrowserSessionIdentityKey(String(first.details?.sessionName));
		assert.equal(state.get(key).tabTarget?.url, "https://fixture.test/two");
		const resumed = createExtensionHarness({ cwd: harness.ctx.cwd, sessionFile: join(harness.ctx.cwd, "session.jsonl"), branch: harness.ctx.sessionManager.getBranch() });
		await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
		const resumedCode = resumed.getTool("agent_browser_code"); assert.ok(resumedCode);
		const inspected = await executeRegisteredTool(resumedCode, resumed.ctx, { code: `emit((await browser({args:["get","url"]})).data.url);` });
		assert.equal(inspected.details?.data, "https://fixture.test/two");
	});
});

test("code raw data remains available for reduction without presentation spills", { concurrency: false }, async () => {
	await withCodeHarness(async harness => {
		const code = harness.getTool("agent_browser_code"); assert.ok(code);
		const result = await executeRegisteredTool(code, harness.ctx, { session: "selection", namespace: "code-tests", code: `const r=await browser({args:["eval","--stdin"],stdin:"[]"}); emit({length:r.data.result.length,end:r.data.result.slice(-3)});` });
		assert.equal(result.isError, false, JSON.stringify(result));
		assert.deepEqual(result.details?.data, { length: 30003, end: "END" });
		assert.equal(result.details?.sessionName, "selection"); assert.equal(result.details?.namespace, "code-tests");
		const manifest = result.details?.artifactManifest as { entries?: Array<{ kind?: string }> } | undefined;
		assert.equal(manifest?.entries?.some(entry => entry.kind === "spill") ?? false, false);
	});
});

test("code cannot silently switch its leased identity or close another session", { concurrency: false }, async () => {
	await withCodeHarness(async (harness, logPath) => {
		const code = harness.getTool("agent_browser_code"); assert.ok(code);
		const result = await executeRegisteredTool(code, harness.ctx, { session: "selected", code: `emit(await browser({args:["--session","other","open","https://fixture.test/other"]})); emit(await browser({args:["close","--all"]}));` });
		const values = result.details?.data as Array<{ success: boolean; error: string }>;
		assert.equal(values[0]?.success, false); assert.match(values[0]?.error ?? "", /one browser identity/);
		assert.equal(values[1]?.success, false); assert.match(values[1]?.error ?? "", /namespace-wide close/);
		assert.equal((await readInvocationLog(logPath)).some(call => call.args.includes("other") || call.args.includes("close")), false);
		const recovery = JSON.parse(result.content.find(item => item.type === "text")?.text ?? "{}");
		assert.equal(recovery.failures.length, 2, "unemitted errors must still be visible");
	});
});

test("a code deadline expires while waiting behind another local code cell", { concurrency: false, timeout: 10_000 }, async () => {
	await withCodeHarness(async (harness, logPath) => {
		const tool = harness.getTool("agent_browser_code")!;
		const first = executeRegisteredTool(tool, harness.ctx, { code: 'await browser({args:["get","url"]}); const end=Date.now()+1500; while(Date.now()<end) {} emit("first");' });
		while (!(await readInvocationLog(logPath)).some(call => call.args.includes("get"))) await delay(10);
		const second = executeRegisteredTool(tool, harness.ctx, { code: 'emit("second");', timeoutMs: 50 });
		try {
			const result = await Promise.race([second, delay(500).then(() => undefined)]);
			assert.ok(result, "queued code must time out without waiting for the first cell to finish");
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "timeout");
		} finally { await Promise.all([first, second]); }
	});
});

test("code export failures preserve partial data and render one truthful observation", { concurrency: false }, async () => {
	await withCodeHarness(async (harness, _log, dir) => {
		await writeFile(join(dir, "blocked"), "existing file");
		const result = await executeRegisteredTool(harness.getTool("agent_browser_code")!, harness.ctx, { code: 'emit({done:true});', outputPath: join(dir, "blocked", "out.json") });
		const observation = JSON.parse(result.content.find(item => item.type === "text")?.text ?? "{}");
		assert.equal(result.isError, true);
		assert.equal(observation.success, false);
		assert.equal(observation.resultCategory, "failure");
		assert.equal(observation.failureCategory, "upstream-error");
		assert.match(observation.error, /ENOTDIR|EEXIST/);
		assert.deepEqual(observation.data, { done: true });
		assert.doesNotMatch(observation.summary, /completed/);
	});
});

test("raw batch credentials are absent from code intent and completion journals", { concurrency: false }, async () => {
	await withCodeHarness(async (harness, logPath) => {
		const rows = ['cookies set session synthetic-cookie-value', 'storage local set token synthetic-storage-value', 'clipboard write synthetic-clipboard-value'];
		const result = await executeRegisteredTool(harness.getTool("agent_browser_code")!, harness.ctx, { code: `await browser({args:["batch","--bail",...${JSON.stringify(rows)}]}); emit("done");` });
		assert.equal(result.isError, false, JSON.stringify(result));
		const journal = JSON.stringify(harness.appendedEntries.filter(entry => entry.customType === BROWSER_TRANSITION_ENTRY));
		assert.doesNotMatch(journal, /synthetic-(?:cookie|storage|clipboard)-value/);
		assert.match(journal, /REDACTED/);
		const invocation = (await readInvocationLog(logPath)).find(call => call.args.includes("batch"));
		assert.deepEqual(invocation?.args.slice(-3), rows, "execution argv remains unchanged");
	});
});

test("pending inner transitions restore unknown target after interruption", () => {
	const key = getAgentBrowserSessionIdentityKey("selected");
	const state = SessionPageState.fromBranch([
		{ type: "custom", customType: BROWSER_TRANSITION_ENTRY, data: { isError: false, details: { args: ["snapshot", "-i"], sessionName: "selected", sessionTabTarget: { url: "https://fixture.test/old" }, refSnapshot: { refIds: ["e1"] } } } },
		{ type: "custom", customType: BROWSER_TRANSITION_ENTRY, data: { isError: true, details: { args: ["click", "@e1"], sessionName: "selected", sessionTabTargetUnknown: true } } },
	]);
	assert.equal(state.get(key).tabTargetUnknown, true); assert.equal(state.get(key).refSnapshot, undefined);
});

test("pre-0.7 script cleanup leases remain recoverable after upgrade", { concurrency: false }, async () => {
	await withCodeHarness(async (harness, logPath) => {
		const sessionName = "piab-script-12345678-1234-4123-8123-123456789abc";
		const resumed = createExtensionHarness({ cwd: harness.ctx.cwd, sessionFile: join(harness.ctx.cwd, "session.jsonl"), branch: [{ type: "custom", customType: "agent-browser-script-session", data: { cleanup: "failed", closeCommandArgs: ["--namespace", "", "--session", sessionName, "close"], launchAttempted: true, sessionName } }] });
		await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
		assert.ok((await readInvocationLog(logPath)).some(call => call.args.includes(sessionName) && call.args.includes("close")));
		assert.equal((resumed.appendedEntries.at(-1)?.data as { cleanup?: string }).cleanup, "closed");
	});
});
