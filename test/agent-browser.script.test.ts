import assert from "node:assert/strict";
import { readRecord, readString, readArray } from "./helpers/assertions.js";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
	AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES,
	AGENT_BROWSER_SCRIPT_MAX_CALLS,
	bindBrowserCodeCall,
	runAgentBrowserScript,
	validateAgentBrowserScriptBrowserParams,
	resolveScriptChildNodePath,
	type AgentBrowserScriptBrowserEnvelope,
} from "../extensions/agent-browser/lib/input-modes/script.js";
import { createBrowserCodeOutput } from "../extensions/agent-browser/lib/orchestration/script-mode.js";
import { convertBrowserEntries } from "../extensions/agent-browser/lib/browser-session-conversion.js";
import {
	BROWSER_TRANSITION_ENTRY,
	getBrowserRecord,
} from "../extensions/agent-browser/lib/browser-transcript.js";
import { getAgentBrowserSessionIdentityKey } from "../extensions/agent-browser/lib/argv-grammar.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("code child resolves a real Node runtime on Bun binaries and fails clearly without one", () => {
	assert.equal(
		resolveScriptChildNodePath({
			runtime: {},
			execPath: "/usr/bin/node",
			whichNode: () => "/usr/bin/node",
		}),
		"/usr/bin/node",
	);
	assert.equal(
		resolveScriptChildNodePath({
			runtime: { bun: "1.2.0" },
			execPath: "/usr/local/bin/pi",
			whichNode: () => "/opt/node/bin/node",
		}),
		"/opt/node/bin/node",
	);
	assert.throws(
		() =>
			resolveScriptChildNodePath({
				runtime: { bun: "1.2.0" },
				execPath: "/usr/local/bin/pi",
				whichNode: () => null,
			}),
		/requires a `node` runtime on PATH when pi runs on a Bun binary/,
	);
});

const successEnvelope = (data: unknown): AgentBrowserScriptBrowserEnvelope => ({
	data,
	success: true,
	resultCategory: "success",
	successCategory: "inspection",
	summary: "Browser call completed.",
});

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4L8AAAAASUVORK5CYII=",
	"base64",
);

test("code runner uses branches and native batch while serializing concurrent inner calls", async () => {
	let active = 0;
	let maxActive = 0;
	const calls: string[][] = [];
	const result = await runAgentBrowserScript({
		code: `const kept=[]; for (const name of ["one","skip","two"]) { const r=await browser({args:["get",name]}); if(r.success && name!=="skip") kept.push(r.data.value); }
const parallel=await Promise.all([browser({args:["get","three"]}),browser({args:["get","four"]})]);
const batch=await browser({args:["batch","--bail"],stdin:JSON.stringify([["get","title"],["get","url"]])});
emit({kept,parallel:parallel.map(r=>r.data.value),batch:batch.data.value});`,
		dispatch: async (params) => {
			active += 1;
			maxActive = Math.max(active, maxActive);
			calls.push([...params.args]);
			await Promise.resolve();
			active -= 1;
			return successEnvelope({ value: params.args[1] });
		},
	});
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.data, {
		kept: ["one", "two"],
		parallel: ["three", "four"],
		batch: "--bail",
	});
	assert.equal(maxActive, 1);
	assert.equal(calls.length, 6);
	assert.deepEqual(calls.at(-1), ["batch", "--bail"]);
});

test("code validates JSON calls without restricting native commands or local authority", async () => {
	for (const args of [
		["close"],
		["connect", "9222"],
		["state", "save", "saved.json"],
		["auth", "login", "example"],
		["--profile", "Default", "open", "https://example.test"],
		["batch", "--bail"],
	]) {
		// Every fixed allowed native command must preserve its validated argv.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(validateAgentBrowserScriptBrowserParams({ args }).params?.args, args);
	}
	assert.match(
		validateAgentBrowserScriptBrowserParams({ args: ["get", "title"], job: {} }).error ?? "",
		/does not support job/,
	);
	const oversize = await runAgentBrowserScript({
		code: "💥".repeat(AGENT_BROWSER_SCRIPT_CODE_MAX_BYTES / 2),
		dispatch: async () => ({ success: true, data: {}, resultCategory: "success" as const }),
	});
	assert.equal(oversize.failureCategory, "validation-error");
	assert.match(oversize.error ?? "", /65536 bytes or less/);
	assert.deepEqual(
		bindBrowserCodeCall(
			{ args: ["--namespace", "", "--session", "chosen", "get", "url"] },
			{ sessionName: "chosen" },
		).args,
		["--namespace", "", "--session", "chosen", "get", "url"],
	);
	// Native batch rows run in the batch's session, so this row closes only the code call's browser.
	assert.deepEqual(
		bindBrowserCodeCall({ args: ["batch", "close --all"] }, { sessionName: "chosen" }).args,
		["--namespace", "", "--session", "chosen", "batch", "close --all"],
	);
});

test("code observations carry failures and exact recoveries without duplicated text/details", async () => {
	const result = await runAgentBrowserScript({
		code: `const failed=await browser({args:["click","#missing"]}); emit({success:failed.success,retry:failed.nextActions[0].params,text:typeof failed.text,details:typeof failed.details});`,
		dispatch: async () => ({
			success: false,
			data: null,
			resultCategory: "failure",
			failureCategory: "selector-not-found",
			error: "Missing selector",
			nextActions: [
				{
					id: "inspect",
					params: { args: ["snapshot", "-i"] },
					reason: "Inspect the current page",
					tool: "agent_browser",
				},
			],
		}),
	});
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.data, {
		success: false,
		retry: { args: ["snapshot", "-i"] },
		text: "undefined",
		details: "undefined",
	});
	const failure = readRecord(readArray(result.failures)[0]);
	assert.equal(failure.failureCategory, "selector-not-found");
	assert.deepEqual(readRecord(readArray(failure.nextActions)[0]).params, {
		args: ["snapshot", "-i"],
	});
	const failedInput = await runAgentBrowserScript({
		code: `emit(await browser());`,
		dispatch: async () => assert.fail("invalid input must not dispatch"),
	});
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
	assert.deepEqual(result.data, {
		nullPrototypes: true,
		promise: true,
		result: true,
		functionBlocked: true,
		asyncBlocked: true,
		generatorBlocked: true,
		escapeBlocked: true,
		host: Array(5).fill("undefined"),
	});
	const next = await runAgentBrowserScript({
		code: `emit(typeof previousCell);`,
		dispatch: async () => successEnvelope(null),
	});
	assert.equal(next.data, "undefined");
	const imported = await runAgentBrowserScript({
		code: `await import("node:fs");`,
		dispatch: async () => successEnvelope(null),
	});
	assert.equal(imported.ok, false);
	assert.match(imported.error ?? "", /sandbox exited before completion|dynamic import callback/i);
});

test("code enforces call, output, IPC and time limits and retains partial emissions", async (t) => {
	let dispatched = 0;
	const calls = await runAgentBrowserScript({
		code: `for(let i=0;i<${AGENT_BROWSER_SCRIPT_MAX_CALLS + 1};i++) await browser({args:["get","title"]});`,
		dispatch: async () => {
			dispatched++;
			return successEnvelope(null);
		},
	});
	assert.equal(calls.ok, false);
	assert.equal(dispatched, AGENT_BROWSER_SCRIPT_MAX_CALLS);
	assert.match(calls.error ?? "", /call limit exceeded/);
	const output = await runAgentBrowserScript({
		code: `emit("x".repeat(${AGENT_BROWSER_SCRIPT_FINAL_OUTPUT_MAX_BYTES + 1}));`,
		dispatch: async () => successEnvelope(null),
	});
	assert.equal(output.ok, false);
	assert.match(output.error ?? "", /output exceeds/);
	const request = await runAgentBrowserScript({
		code: `await browser({args:["get","x".repeat(${AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES})]});`,
		dispatch: async () => assert.fail("oversized request must not dispatch"),
	});
	assert.equal(request.ok, false);
	assert.match(request.error ?? "", /IPC limit exceeded/);
	const response = await runAgentBrowserScript({
		code: `await browser({args:["get","title"]});`,
		dispatch: async () => successEnvelope("x".repeat(AGENT_BROWSER_SCRIPT_IPC_MESSAGE_MAX_BYTES)),
	});
	assert.equal(response.ok, false);
	assert.match(response.error ?? "", /Unable to return a browser result/);
	const raw = await runAgentBrowserScript({
		code: `const r=await browser({args:["eval","--stdin"],stdin:"[]"}); emit(r.data.length);`,
		dispatch: async () => successEnvelope("x".repeat(512 * 1_024)),
	});
	assert.equal(raw.data, 512 * 1_024);
	const loopEntered = Promise.withResolvers<true>();
	const controller = new AbortController();
	const realSetTimeout = setTimeout;
	const realClearTimeout = clearTimeout;
	let watchdogTimer: NodeJS.Timeout | undefined;
	const watchdog = new Promise<never>((_resolve, reject) => {
		watchdogTimer = realSetTimeout(
			() => reject(new Error("Code timeout fixture stalled.")),
			15_000,
		);
	});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const spawned = t.mock.method(childProcess, "spawn");
	syncBuiltinESMExports();
	let settled = false;
	const pending = runAgentBrowserScript({
		// Flush the prefix first; the second call is sent from the unbounded loop.
		code: `emit("completed prefix");
await browser({args:["get","title"]});
let reported = false;
while(true) {
  if (!reported) { reported = true; void browser({args:["get","url"]}); }
}`,
		timeoutMs: 200,
		signal: controller.signal,
		dispatch: async (params) => {
			if (params.args[1] === "url") {
				loopEntered.resolve(true);
			}
			return successEnvelope(null);
		},
	}).then((result) => {
		settled = true;
		return result;
	});
	const child = spawned.mock.calls[0]?.result;
	try {
		assert.ok(child, "the permissioned worker must be spawned");
		const childHasExited = () => child.exitCode !== null || child.signalCode !== null;
		await Promise.race([
			loopEntered.promise,
			watchdog,
			pending.then((result) =>
				assert.fail(`Worker stopped before loop entry: ${JSON.stringify(result)}`),
			),
		]);
		// The parent drains the prefix before the loop's call; let that dispatch finish.
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		t.mock.timers.tick(199);
		assert.equal(settled, false);
		assert.equal(childHasExited(), false);
		t.mock.timers.tick(1);
		const timedOut = await Promise.race([pending, watchdog]);
		assert.equal(timedOut.ok, false);
		assert.equal(timedOut.failureCategory, "timeout");
		assert.equal(timedOut.timedOut, true);
		assert.equal(timedOut.data, "completed prefix");
		assert.equal(timedOut.emitCount, 1);
		assert.equal(timedOut.callCount, 2);
		assert.equal(timedOut.steps.length, 2);
		assert.equal(childHasExited(), true, "the worker must be reaped");
	} finally {
		realClearTimeout(watchdogTimer);
		t.mock.timers.reset();
		controller.abort();
		if (child?.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
		await Promise.allSettled([pending]);
		spawned.mock.restore();
		syncBuiltinESMExports();
	}
	for (const code of ["emit(undefined);", "emit(()=>1);"]) {
		// Finish each serialization attempt before launching the next permissioned child.
		// oxlint-disable-next-line no-await-in-loop
		const invalid = await runAgentBrowserScript({
			code,
			dispatch: async () => successEnvelope(null),
		});
		// Both fixed non-JSON values must fail emission.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(invalid.ok, false);
		// Both failures must identify serialization rather than another child failure.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.match(invalid.error ?? "", /JSON-serializable value/);
	}
});

test("abort waits for the dispatched operation and does not start queued siblings", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const controller = new AbortController();
	let started!: () => void;
	const active = new Promise<void>((resolve) => {
		started = resolve;
	});
	const aborted = Promise.withResolvers<undefined>();
	const release = Promise.withResolvers<undefined>();
	let settled = false;
	let drained = false;
	let calls = 0;
	const pending = runAgentBrowserScript({
		code: `await Promise.all([browser({args:["get","slow"]}),browser({args:["get","late"]})]);`,
		signal: controller.signal,
		dispatch: async (_params, signal) => {
			calls++;
			started();
			signal.addEventListener("abort", () => aborted.resolve(undefined), { once: true });
			await release.promise;
			drained = true;
			return {
				success: false,
				resultCategory: "failure",
				failureCategory: "aborted",
				error: "aborted",
			};
		},
	});
	const observed = pending.finally(() => {
		settled = true;
	});
	await active;
	controller.abort();
	try {
		await aborted.promise;
		// Dispatch has entered and received abort; allow child-reaping deadlines to expire
		// without releasing the unresolved browser operation.
		t.mock.timers.tick(1000);
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		assert.equal(settled, false, "abort cannot finish before the active effect drains");
		assert.equal(calls, 1, "queued siblings must not dispatch during abort");
	} finally {
		release.resolve(undefined);
	}
	const result = await observed;
	assert.equal(result.aborted, true);
	assert.equal(drained, true);
	assert.equal(calls, 1);
	assert.equal(result.steps.length, 1);
	assert.equal(result.failures?.[0]?.failureCategory, "aborted");
});

test("selected image emission forwards real bytes once and rejects stale or invented handles", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "piab-code-image-"));
	try {
		const path = join(dir, "capture.png");
		await writeFile(path, PNG);
		const output = createBrowserCodeOutput();
		const observation = await output.observe({
			content: [],
			details: {
				resultCategory: "success",
				data: { path },
				imageObservations: [
					{
						path,
						mimeType: "image/png",
						pixels: { width: 1, height: 1 },
						capture: "unknown",
						geometry: { status: "unknown", reason: "Fixture" },
					},
				],
			},
		});
		const result = await runAgentBrowserScript({
			code: `const r=await browser({args:["screenshot"]}); emitImage(r.imageObservations[0]); emitImage(r.imageObservations[0]); emit({visible:true});`,
			dispatch: async () => observation,
			emitImage: output.emitImage.bind(output),
		});
		assert.equal(result.ok, true, result.error);
		const final = await output.finish(result, "persistent");
		assert.equal(final.content.filter((item) => item.type === "image").length, 1);
		const image = final.content.find((item) => item.type === "image");
		assert.ok(image?.type === "image");
		assert.deepEqual(Buffer.from(image.data, "base64"), PNG);
		const validImage = readRecord(observation.imageObservations?.[0]);
		const malformedImages = [
			["pixel width type", { pixels: { width: "1", height: 1 } }],
			["non-finite pixels", { pixels: { width: 1, height: Infinity } }],
			["geometry container", { geometry: "measured" }],
			["geometry status", { geometry: { status: "invented", reason: "Fixture" } }],
			["geometry reason", { geometry: { status: "unknown", reason: 1 } }],
			[
				"partial sample",
				{ geometry: { status: "measured", reason: "Fixture", before: { dpr: 1 } } },
			],
			[
				"crop dimensions",
				{
					geometry: {
						status: "measured",
						reason: "Fixture",
						crop: { x: 0, y: 0, width: "1", height: 1 },
					},
				},
			],
			[
				"CSS mapping",
				{
					geometry: { status: "measured", reason: "Fixture", pixelsPerCssPixel: { x: "1", y: 1 } },
				},
			],
		] as const;
		await Promise.all(
			malformedImages.map(([name, malformed]) =>
				t.test(`rejects malformed ${name} without publishing an image handle`, async () => {
					const invalid = createBrowserCodeOutput();
					await assert.rejects(
						invalid.observe({
							content: [],
							details: {
								resultCategory: "success",
								imageObservations: [{ ...validImage, ...malformed }],
							},
						}),
						/invalid image observation geometry/,
					);
					await assert.rejects(
						invalid.emitImage({ id: "image-1", path }),
						/handle returned by browser/,
					);
					const rejected = await invalid.finish(result, "persistent");
					assert.deepEqual(readRecord(rejected.details).imageObservations, []);
					assert.equal(
						rejected.content.some((part) => part.type === "image"),
						false,
					);
				}),
			),
		);
		await t.test(
			"unknown geometry with absent pixels remains a usable verified handle",
			async () => {
				const unknown = createBrowserCodeOutput();
				const captured = await unknown.observe({
					content: [],
					details: {
						resultCategory: "success",
						imageObservations: [
							{
								path,
								mimeType: "image/png",
								capture: "unknown",
								geometry: { status: "unknown", reason: "No geometry evidence" },
							},
						],
					},
				});
				await unknown.emitImage({ id: captured.imageObservations?.[0]?.id });
				const selected = await unknown.finish(result, "persistent");
				assert.equal(selected.content.filter((part) => part.type === "image").length, 1);
				const metadata = readRecord(readArray(readRecord(selected.details).imageObservations)[0]);
				assert.equal(metadata.pixels, undefined);
				assert.equal(readRecord(metadata.geometry).status, "unknown");
				assert.equal(readRecord(metadata.geometry).pixelsPerCssPixel, undefined);
			},
		);
		await assert.rejects(output.emitImage({ id: "not-captured" }), /handle returned by browser/);
		const staleOutput = createBrowserCodeOutput();
		const stale = await staleOutput.observe({
			content: [],
			details: { imageObservations: observation.imageObservations, resultCategory: "success" },
		});
		await writeFile(path, Buffer.concat([PNG, Buffer.from("changed")]));
		await assert.rejects(
			staleOutput.emitImage(stale.imageObservations?.[0]),
			/changed since capture/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("missing compiled worker returns a setup failure", async (t) => {
	const consumer = await mkdtemp(join(tmpdir(), "piab-missing-worker-"));
	t.after(() => rm(consumer, { recursive: true, force: true }));
	await cp(join(process.cwd(), "dist"), join(consumer, "dist"), { recursive: true });
	await rm(join(consumer, "dist/extensions/agent-browser/script-worker.js"));
	await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
	await symlink(
		join(process.cwd(), "node_modules"),
		join(consumer, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const runnerUrl = pathToFileURL(
		join(consumer, "dist/extensions/agent-browser/lib/input-modes/script.js"),
	).href;
	const output = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`const {runAgentBrowserScript}=await import(${JSON.stringify(runnerUrl)}); process.stdout.write(JSON.stringify(await runAgentBrowserScript({ code: "emit(1)", dispatch: async () => { throw new Error("missing worker must not dispatch"); } })));`,
		],
		{ encoding: "utf8" },
	);
	const result = readRecord(JSON.parse(output));
	assert.equal(result.failureCategory, "missing-binary");
	assert.match(readString(result.error), /Compiled script worker is missing/);
});

type CodeHarnessView = Pick<
	ReturnType<typeof createExtensionHarness>,
	"ctx" | "getTool" | "tool"
> & {
	readonly appendedEntries: readonly Readonly<
		ReturnType<typeof createExtensionHarness>["appendedEntries"][number]
	>[];
};

async function withCodeHarness(
	run: (harness: CodeHarnessView, logPath: string, dir: string) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "piab-code-integration-"));
	const logPath = join(dir, "calls.jsonl");
	const statePath = join(dir, "page.json");
	await writeFakeAgentBrowserBinary(
		dir,
		`const fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify({args})+'\\n');
let url='about:blank'; try{url=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8')).url}catch{}
const command=args.find(arg=>['open','get','snapshot','eval','close','batch'].includes(arg)); let data;
if(command==='open'){url=args[args.indexOf('open')+1]; fs.writeFileSync(${JSON.stringify(statePath)},JSON.stringify({url})); data={url,title:'Fixture'};}
else if(command==='close') data={closed:true};
else if(command==='snapshot') data={url,refs:{e1:{role:'button',name:'Submit'}},snapshot:'- button "Submit" [ref=e1]'};
else if(command==='eval' && fs.readFileSync(0,'utf8')==='hold') {const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(dir, "release"))})){clearInterval(timer); process.stdout.write(JSON.stringify({success:true,data:{result:'released'}}));}},10); return;}
else if(command==='eval') data={result:'x'.repeat(30000)+'END'};
else if(command==='batch') data=args.slice(args.indexOf('batch')+1).filter(arg=>arg!=='--bail').map(row=>({command:row.split(' '),success:true,result:{}}));
else data=args.includes('url')?{url}:{title:'Fixture'};
process.stdout.write(JSON.stringify({success:true,data}));`,
	);
	try {
		await withPatchedEnv(
			{
				PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
				AGENT_BROWSER_SESSION: undefined,
				AGENT_BROWSER_NAMESPACE: undefined,
			},
			async () => {
				const harness = createExtensionHarness({
					cwd: dir,
					sessionFile: join(dir, "session.jsonl"),
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				try {
					await run(harness, logPath, dir);
				} finally {
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						harness.ctx,
					);
				}
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test(
	"code shares the selected persistent browser with direct calls and persists ordered resume state",
	{ concurrency: false },
	async () => {
		await withCodeHarness(async (harness, logPath) => {
			const code = harness.getTool("agent_browser_code");
			assert.ok(code);
			const direct = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://fixture.test/start"],
			});
			assert.equal(direct.isError, false, JSON.stringify(direct));
			const first = await executeRegisteredTool(code, harness.ctx, {
				code: `await browser({args:["open","https://fixture.test/one"]}); await browser({args:["snapshot","-i"]}); emit((await browser({args:["open","https://fixture.test/two"]})).data.url);`,
			});
			assert.equal(first.isError, false, JSON.stringify(first));
			assert.equal(readRecord(first.details).data, "https://fixture.test/two");
			assert.equal(readRecord(first.details).sessionName, readRecord(direct.details).sessionName);
			const second = await executeRegisteredTool(code, harness.ctx, {
				code: `emit((await browser({args:["get","url"]})).data.url);`,
			});
			assert.equal(readRecord(second.details).data, "https://fixture.test/two");
			assert.equal(readRecord(second.details).sessionName, readRecord(first.details).sessionName);
			assert.equal(
				(await readInvocationLog(logPath)).some((call) => call.args.includes("close")),
				false,
				"code completion must preserve the browser",
			);
			const transitions = harness.appendedEntries.filter(
				(entry) => entry.customType === BROWSER_TRANSITION_ENTRY,
			);
			assert.equal(
				transitions.length,
				10,
				"direct and inner commands each persist a begin/finish pair",
			);
			assert.ok(
				transitions.every(
					(entry) => !("data" in readRecord(readRecord(readRecord(entry.data).event).state)),
				),
				"state journal must not copy page output",
			);
			const state = SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch());
			const key = getAgentBrowserSessionIdentityKey(
				readString(readRecord(first.details).sessionName),
			);
			assert.equal(state.get(key).tabTarget?.url, "https://fixture.test/two");
			const resumed = createExtensionHarness({
				cwd: harness.ctx.cwd,
				sessionFile: join(harness.ctx.cwd, "session.jsonl"),
				branch: harness.ctx.sessionManager.getBranch(),
			});
			await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
			const resumedCode = resumed.getTool("agent_browser_code");
			assert.ok(resumedCode);
			const inspected = await executeRegisteredTool(resumedCode, resumed.ctx, {
				code: `emit((await browser({args:["get","url"]})).data.url);`,
			});
			assert.equal(inspected.details?.data, "https://fixture.test/two");
		});
	},
);

test(
	"code raw data remains available for reduction without presentation spills",
	{ concurrency: false },
	async () => {
		await withCodeHarness(async (harness) => {
			const code = harness.getTool("agent_browser_code");
			assert.ok(code);
			const result = await executeRegisteredTool(code, harness.ctx, {
				session: "selection",
				namespace: "code-tests",
				code: `const r=await browser({args:["eval","--stdin"],stdin:"[]"}); emit({length:r.data.result.length,end:r.data.result.slice(-3)});`,
			});
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.deepEqual(readRecord(result.details).data, { length: 30003, end: "END" });
			assert.equal(readRecord(result.details).sessionName, "selection");
			assert.equal(readRecord(result.details).namespace, "code-tests");
			const entries =
				readRecord(result.details).artifactManifest === undefined
					? []
					: readArray(readRecord(readRecord(result.details).artifactManifest).entries);
			assert.equal(
				entries.map(readRecord).some((entry) => entry.kind === "spill"),
				false,
			);
		});
	},
);

test(
	"code cannot silently switch its leased identity or close another session",
	{ concurrency: false },
	async () => {
		await withCodeHarness(async (harness, logPath) => {
			const code = harness.getTool("agent_browser_code");
			assert.ok(code);
			const result = await executeRegisteredTool(code, harness.ctx, {
				session: "selected",
				code: `emit(await browser({args:["--session","other","open","https://fixture.test/other"]})); emit(await browser({args:["close","--all"]}));`,
			});
			const values = readArray(readRecord(result.details).data).map(readRecord);
			assert.equal(values[0].success, false);
			assert.match(readString(values[0].error), /one browser identity/);
			assert.equal(values[1].success, false);
			assert.match(readString(values[1].error), /namespace-wide close/);
			assert.equal(
				(await readInvocationLog(logPath)).some(
					(call) => call.args.includes("other") || call.args.includes("close"),
				),
				false,
			);
			const recovery = readRecord(
				JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}"),
			);
			assert.equal(
				readArray(recovery.failures).length,
				2,
				"unemitted errors must still be visible",
			);
		});
	},
);

test(
	"a code deadline expires while waiting behind another local code cell",
	{ concurrency: false, timeout: 10_000 },
	async () => {
		await withCodeHarness(async (harness, logPath, dir) => {
			const tool = harness.getTool("agent_browser_code");
			assert.ok(tool);
			const first = executeRegisteredTool(tool, harness.ctx, {
				code: 'await browser({args:["eval","--stdin"],stdin:"hold"}); emit("first");',
			});
			let watchdog: ReturnType<typeof setTimeout> | undefined;
			let second: ReturnType<typeof executeRegisteredTool> | undefined;
			try {
				// Wait for the actual upstream dispatch receipt, not a cold-child deadline.
				// oxlint-disable-next-line no-await-in-loop
				while (!(await readInvocationLog(logPath)).some((call) => call.args.includes("eval"))) {
					// Receipt observations must stay ordered.
					// oxlint-disable-next-line no-await-in-loop
					await delay(10);
				}
				second = executeRegisteredTool(tool, harness.ctx, {
					code: 'await browser({args:["get","title"]}); emit("second");',
					timeoutMs: 50,
				});
				const result = await Promise.race([
					second,
					new Promise<never>((_resolve, reject) => {
						watchdog = setTimeout(
							() =>
								reject(new Error("queued code must time out before the first cell is released")),
							500,
						);
					}),
				]);
				assert.equal(result.isError, true);
				assert.equal(readRecord(result.details).failureCategory, "timeout");
				assert.equal(
					(await readInvocationLog(logPath)).some((call) => call.args.includes("title")),
					false,
					"expired queued cell cannot dispatch",
				);
			} finally {
				clearTimeout(watchdog);
				await writeFile(join(dir, "release"), "released");
				await Promise.all([first, second]);
			}
		});
	},
);

test(
	"code export failures preserve partial data and render one truthful observation",
	{ concurrency: false },
	async () => {
		await withCodeHarness(async (harness, _log, dir) => {
			await writeFile(join(dir, "blocked"), "existing file");
			const tool = harness.getTool("agent_browser_code");
			assert.ok(tool);
			const result = await executeRegisteredTool(tool, harness.ctx, {
				code: "emit({done:true});",
				outputPath: join(dir, "blocked", "out.json"),
			});
			const observation = readRecord(
				JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}"),
			);
			assert.equal(result.isError, true);
			assert.equal(observation.success, false);
			assert.equal(observation.resultCategory, "failure");
			assert.equal(observation.failureCategory, "upstream-error");
			assert.match(readString(observation.error), /ENOTDIR|EEXIST/);
			assert.deepEqual(observation.data, { done: true });
			assert.doesNotMatch(readString(observation.summary), /completed/);
		});
	},
);

test(
	"session_tree joins oversized code observation finalization without publishing A artifacts onto independent B",
	{ concurrency: false, timeout: 15_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "piab-code-finalization-race-"));
		try {
			const marker = join(root, "effect-started"),
				file = join(root, "session.jsonl");
			await writeFakeAgentBrowserBinary(
				root,
				`const fs=require('node:fs'), args=process.argv.slice(2);
if(args.includes('eval')) {fs.writeFileSync(${JSON.stringify(marker)},'started'); setInterval(()=>{},1000);}
else process.stdout.write(JSON.stringify({success:true,data:{url:'https://fixture.test/'}}));`,
			);
			await withPatchedEnv(
				{
					PATH: `${root}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
					AGENT_BROWSER_SESSION: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
				},
				async () => {
					const branch = (id: string) => [
						{
							type: "message",
							id,
							parentId: null,
							message: { role: "user", content: [{ type: "text", text: `Branch ${id}` }] },
						},
					];
					const harness = createExtensionHarness({
						cwd: root,
						sessionFile: file,
						branch: branch("a"),
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const tool = harness.getTool("agent_browser_code");
					assert.ok(tool);
					const pending = executeRegisteredTool(tool, harness.ctx, {
						session: "finalization-race",
						code: 'emit("x".repeat(24000)); await browser({args:["eval","--stdin"],stdin:"1"});',
					});
					const deadline = Date.now() + 10_000;
					while (true) {
						try {
							// Observe the real child effect before triggering branch navigation.
							// oxlint-disable-next-line no-await-in-loop
							await readFile(marker);
							break;
						} catch {
							// Missing markers must stay within the deadline; a successful read ends polling.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(
								Date.now() < deadline,
								"code must reach the real fake-upstream effect before tree navigation",
							);
							// Wait between missing-marker observations rather than overlapping reads.
							// oxlint-disable-next-line no-await-in-loop
							await delay(10);
						}
					}
					harness.setBranch(branch("b"));
					await runExtensionEvent(
						harness.handlers,
						"session_tree",
						{ newLeafId: "b", oldLeafId: "a" },
						harness.ctx,
					);
					const result = await pending;
					assert.equal(result.isError, true);
					assert.equal(readRecord(readRecord(result.details).codeRun).aborted, true);
					assert.equal(
						readRecord(result.details).data,
						"x".repeat(24000),
						"the caller retains complete selected output after interruption",
					);
					const observation = readRecord(
						JSON.parse(result.content.find((part) => part.type === "text")?.text ?? "{}"),
					);
					assert.equal(
						readRecord(JSON.parse(await readFile(readString(observation.observationPath), "utf8")))
							.data,
						"x".repeat(24000),
					);
					assert.deepEqual(
						harness.ctx.sessionManager.getBranch().map((entry) => readRecord(entry).id),
						["b"],
						"outer finalization cannot append A's artifact state beneath B",
					);
					const all = (await readFile(file, "utf8"))
						.trim()
						.split("\n")
						.map((line) => {
							const value: unknown = JSON.parse(line);
							return value;
						});
					const begins = all
						.map(getBrowserRecord)
						.filter((record) => record?.event.phase === "begin");
					assert.equal(begins.length, 1);
					assert.equal(
						SessionPageState.fromBranch(all).get("finalization-race").tabTargetUnknown,
						true,
						"the unfinished effect remains uncertain",
					);
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						harness.ctx,
					);
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test(
	"raw batch credentials are absent from code intent and completion journals",
	{ concurrency: false },
	async () => {
		await withCodeHarness(async (harness, logPath) => {
			const rows = [
				"cookies set session synthetic-cookie-value",
				"storage local set token synthetic-storage-value",
				"clipboard write synthetic-clipboard-value",
			];
			const tool = harness.getTool("agent_browser_code");
			assert.ok(tool);
			const result = await executeRegisteredTool(tool, harness.ctx, {
				code: `await browser({args:["batch","--bail",...${JSON.stringify(rows)}]}); emit("done");`,
			});
			assert.equal(result.isError, false, JSON.stringify(result));
			const journal = JSON.stringify(
				harness.appendedEntries.filter((entry) => entry.customType === BROWSER_TRANSITION_ENTRY),
			);
			assert.doesNotMatch(journal, /synthetic-(?:cookie|storage|clipboard)-value/);
			assert.match(journal, /REDACTED/);
			const invocation = (await readInvocationLog(logPath)).find((call) =>
				call.args.includes("batch"),
			);
			assert.deepEqual(invocation?.args.slice(-3), rows, "execution argv remains unchanged");
		});
	},
);

test("converted legacy explicit unknown-target outcomes invalidate restored refs", () => {
	const key = getAgentBrowserSessionIdentityKey("selected");
	const state = SessionPageState.fromBranch(
		convertBrowserEntries([
			{
				type: "custom",
				customType: BROWSER_TRANSITION_ENTRY,
				data: {
					isError: false,
					details: {
						args: ["snapshot", "-i"],
						sessionName: "selected",
						sessionTabTarget: { url: "https://fixture.test/old" },
						refSnapshot: { refIds: ["e1"] },
					},
				},
			},
			{
				type: "custom",
				customType: BROWSER_TRANSITION_ENTRY,
				data: {
					isError: true,
					details: {
						args: ["click", "@e1"],
						sessionName: "selected",
						sessionTabTargetUnknown: true,
					},
				},
			},
		]),
	);
	assert.equal(state.get(key).tabTargetUnknown, true);
	assert.equal(state.get(key).refSnapshot, undefined);
});

test(
	"pre-0.7 script cleanup leases remain recoverable after upgrade",
	{ concurrency: false },
	async () => {
		await withCodeHarness(async (harness, logPath) => {
			const sessionName = "piab-script-12345678-1234-4123-8123-123456789abc";
			const legacy = [
				{
					type: "custom",
					customType: "agent-browser-script-session",
					data: {
						cleanup: "failed",
						closeCommandArgs: ["--namespace", "", "--session", sessionName, "close"],
						launchAttempted: true,
						sessionName,
					},
				},
			];
			const canonical = convertBrowserEntries(legacy, harness.ctx.sessionManager.getSessionId());
			const fork = createExtensionHarness({
				cwd: harness.ctx.cwd,
				sessionId: "ordinary-fork",
				branch: canonical,
			});
			await runExtensionEvent(fork.handlers, "session_start", { reason: "fork" }, fork.ctx);
			await runExtensionEvent(fork.handlers, "session_shutdown", { reason: "quit" }, fork.ctx);
			assert.equal(
				(await readInvocationLog(logPath)).some(
					(call) => call.args.includes(sessionName) && call.args.includes("close"),
				),
				false,
				"a new Pi UUID never inherits the parent's cleanup lease",
			);
			const resumed = createExtensionHarness({
				cwd: harness.ctx.cwd,
				sessionFile: join(harness.ctx.cwd, "session.jsonl"),
				branch: canonical,
			});
			await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
			assert.ok(
				(await readInvocationLog(logPath)).some(
					(call) => call.args.includes(sessionName) && call.args.includes("close"),
				),
			);
			assert.equal(
				readRecord(
					readRecord(readRecord(readRecord(resumed.appendedEntries.at(-1)?.data).event).state)
						.scriptLease,
				).cleanup,
				"closed",
			);
		});
	},
);
