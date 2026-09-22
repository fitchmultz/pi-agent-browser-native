import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { createExtensionHarness, createToolBranchEntry, executeRegisteredTool, readInvocationLog, runExtensionEvent, withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

const clearedBrowserEnv = Object.fromEntries(Object.keys(process.env)
	.filter(name => name.startsWith("AGENT_BROWSER_") || name.startsWith("PI_AGENT_BROWSER_"))
	.map(name => [name, undefined]));

test("operation files follow the captured cwd while native config and session stay anchored", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "browser-cwd-")));
	const a = join(root, "a"), b = join(root, "b");
	const log = join(root, "calls.jsonl");
	await Promise.all([mkdir(a), mkdir(b)]);
	for (const directory of [a, b]) execFileSync("git", ["init", "-q", directory]);
	await writeFile(join(a, "OnlyA.ts"), 'export const Widget = "https://fixture.test/api/items";');
	await writeFile(join(b, "OnlyB.ts"), 'export const Widget = "https://fixture.test/api/items";');
	await writeFile(join(a, "agent-browser.json"), JSON.stringify({ session: "browser-a", profile: "Profile A" }));
	await writeFile(join(b, "agent-browser.json"), JSON.stringify({ session: "browser-b", profile: "Profile B" }));
	await writeFakeAgentBrowserBinary(root, `
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);
const configPath = args.includes("--config") ? args[args.indexOf("--config") + 1] : process.env.AGENT_BROWSER_CONFIG ?? path.join(process.cwd(), "agent-browser.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const session = args.includes("--session") ? args[args.indexOf("--session") + 1] : process.env.AGENT_BROWSER_SESSION ?? config.session ?? "default";
const stdin = fs.readFileSync(0, "utf8");
const statePath = ${JSON.stringify(join(root, "browser-state.json"))};
let sessions = {}; try { sessions = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
const state = sessions[session] ??= { active: false, launches: 0, url: "https://fixture.test/" };
let start = 0; while (args[start]?.startsWith("--")) start += args[start] === "--json" ? 1 : 2;
const tokens = args.slice(start);
const saveFile = (target, content) => { target = path.resolve(target); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target; };
function execute(row) {
  if (row[0] === "session") return row[1] === "info" ? { active: state.active, runtime: { restoreKey: state.restore ?? null } } : { session };
  if (row[0] === "close") { state.active = false; return { closed: true }; }
  if (!state.active) { state.active = true; state.launches++; state.restore = process.env.AGENT_BROWSER_RESTORE; state.profile = config.profile; state.launchCwd = process.cwd(); }
  if (row[0] === "open") state.url = row[1];
  if (row[0] === "screenshot") return { path: saveFile(row[1], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=", "base64")) };
  if (row[0] === "download") return { path: saveFile(row[2], "download fixture") };
  if (row[0] === "upload") return { files: row.slice(2).map(file => fs.readFileSync(file, "utf8")) };
  if (row[0] === "record" && row[1] === "start") { state.recording = path.resolve(row[2]); return { started: true, path: state.recording }; }
  if (row[0] === "record" && row[1] === "stop") { const target = saveFile(state.recording, "video fixture"); delete state.recording; return { stopped: true, path: target }; }
  if (row[0] === "snapshot") return { url: state.url, snapshot: "x".repeat(200000), refs: {} };
  if (row[0] === "network") return { requests: [{ url: "https://fixture.test/api/items", status: 500, failed: true }] };
  if (row[0] === "react") return { components: [] };
  if (row[0] === "tab") return { tabs: [{ tabId: "t1", active: true, url: state.url, title: "Fixture" }] };
  return { session, title: "Fixture", url: state.url };
}
const data = tokens[0] === "batch" ? JSON.parse(stdin).map(row => ({ command: row, success: true, result: execute(row) })) : execute(tokens);
if (tokens[0] !== "session") fs.writeFileSync(statePath, JSON.stringify(sessions));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, cwd: process.cwd(), session, profile: config.profile, configPath, restore: process.env.AGENT_BROWSER_RESTORE, launch: state.launches }) + "\\n");
console.log(JSON.stringify({ success: true, data }));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1", PATH: `${root}${delimiter}${process.env.PATH}` }, async () => {
			let selected = a;
			let resolutions = 0;
			const harness = createExtensionHarness({ cwd: a, sessionFile: join(a, "sessions", "one.jsonl"), onBusEvent(channel, request) {
				if (channel === "pi-change-working-dir:resolve-execution-cwd") {
					resolutions++;
					(request as { result: { cwd: string } }).result = { cwd: selected };
				}
			} });
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://fixture.test/"] });
			assert.equal(opened.isError, false, opened.content[0]?.text);
			const recording = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "capture.webm"] });
			assert.equal(recording.isError, false, recording.content[0]?.text);
			selected = b;
			const pending = executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", "shots/page.png"], outputPath: "results/page.json" });
			selected = a; // An await or queue must not re-resolve the operation root.
			const screenshot = await pending;
			assert.equal(screenshot.isError, false, screenshot.content[0]?.text);
			assert.equal(screenshot.details?.sessionName, "browser-a");
			assert.equal((screenshot.details?.artifacts as Array<{ cwd: string }>)[0].cwd, b);
			assert.ok((await readFile(join(b, "shots/page.png"))).length > 0);
			assert.ok((await readFile(join(b, "results/page.json"))).length > 0);
			assert.equal(resolutions, 3);
			assert.equal(harness.ctx.cwd, a);
			selected = b;
			for (const params of [
				{ sourceLookup: { componentName: "Widget", includeDomHints: false } },
				{ networkSourceLookup: { url: "https://fixture.test/api/items" } },
			]) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
				assert.equal(result.isError, false, result.content[0]?.text);
				assert.match(JSON.stringify(result.details?.sourceLookup ?? result.details?.networkSourceLookup), /OnlyB.ts/);
				assert.doesNotMatch(JSON.stringify(result.details?.sourceLookup ?? result.details?.networkSourceLookup), /OnlyA.ts/);
			}
			await writeFile(join(b, "input.txt"), "B input");
			const upload = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["upload", "#upload", "input.txt"] });
			assert.equal(upload.isError, false, upload.content[0]?.text);
			assert.match(JSON.stringify(upload.details?.data), /B input/);
			const download = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["download", "#link", "downloads/report.txt"] });
			assert.equal(download.isError, false, download.content[0]?.text);
			assert.equal(await readFile(join(b, "downloads/report.txt"), "utf8"), "download fixture");
			const one = executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch", "--bail"], stdin: JSON.stringify([["screenshot", "jobs/one.png"]]) });
			const two = executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch", "--bail"], stdin: JSON.stringify([["screenshot", "jobs/two.png"]]) });
			selected = a;
			for (const result of await Promise.all([one, two])) assert.equal(result.isError, false, result.content[0]?.text);
			assert.ok((await readFile(join(b, "jobs/one.png"))).length > 0);
			assert.ok((await readFile(join(b, "jobs/two.png"))).length > 0);
			selected = b;
			const stopped = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "stop"], outputPath: "receipts/stop.json" });
			assert.equal(stopped.isError, false, stopped.content[0]?.text);
			assert.equal(await readFile(join(a, "capture.webm"), "utf8"), "video fixture");
			assert.ok((await readFile(join(b, "receipts/stop.json"))).length > 0);
			const newRecording = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "new.webm"] });
			assert.equal(newRecording.isError, false, newRecording.content[0]?.text);
			selected = a;
			assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "stop"] })).isError, false);
			assert.equal(await readFile(join(b, "new.webm"), "utf8"), "video fixture");
			selected = b;
			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, snapshot.content[0]?.text);
			assert.ok(String(snapshot.details?.fullOutputPath).startsWith(join(a, "sessions", ".pi-agent-browser-artifacts")));
			const calls = await readInvocationLog(log) as Array<{ args: string[]; cwd: string; profile: string; launch: number }>;
			assert.ok(calls.every(call => call.cwd === a && call.profile === "Profile A"));
			assert.ok(calls.filter(call => call.launch > 0).every(call => call.launch === 1), "live browser never restarted");
			const beforeScript = resolutions;
			const script = executeRegisteredTool(harness.getTool("agent_browser_code")!, harness.ctx, { code: 'await browser({args:["screenshot","code/one.png"]}); await browser({args:["screenshot","code/two.png"]}); emit("done");' });
			selected = a;
			const scriptResult = await script;
			assert.equal(scriptResult.isError, false, scriptResult.content[0]?.text);
			assert.equal(resolutions, beforeScript + 1, "code calls inherit one outer cwd snapshot");
			assert.ok((await readFile(join(b, "code/one.png"))).length > 0);
			assert.ok((await readFile(join(b, "code/two.png"))).length > 0);
			assert.ok((await readFile(String(snapshot.details?.fullOutputPath))).length > 0, "cached artifact stays in the original store");
			selected = b;
			const configured = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--config", "agent-browser.json", "get", "title"] });
			assert.equal(configured.isError, false, configured.content[0]?.text);
			assert.equal(configured.details?.sessionName, "browser-b");
			await withPatchedEnv({ AGENT_BROWSER_CONFIG: "agent-browser.json", AGENT_BROWSER_SESSION: "env-session" }, async () => {
				const env = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"] });
				assert.equal(env.details?.sessionName, "env-session");
				const explicit = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "per-call", "get", "title"] });
				assert.equal(explicit.details?.sessionName, "per-call");
			});
			const unrelated = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "unused-target", "get", "title"] });
			assert.equal(unrelated.isError, false, unrelated.content[0]?.text);
			assert.equal(unrelated.details?.sessionName, "unused-target");
			const restoredDefault = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"] });
			assert.equal(restoredDefault.details?.sessionName, "browser-a");
			const laterCalls = await readInvocationLog(log) as Array<{ args: string[]; cwd: string; session: string; configPath: string }>;
			assert.ok(laterCalls.filter(call => call.session === "browser-b" || call.session === "env-session" || call.session === "per-call").every(call => call.cwd === b && call.configPath === join(b, "agent-browser.json")));
			assert.ok(laterCalls.filter(call => call.session === "unused-target").every(call => call.cwd === a));
			await rm(a, { recursive: true, force: true });
			const removedOrigin = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", "after-removal.png"] });
			assert.equal(removedOrigin.isError, true);
			assert.equal(removedOrigin.details?.failureCategory, "validation-error");
			assert.match(removedOrigin.content[0]?.text ?? "", /Browser launch directory is unavailable/);
			assert.equal((await readInvocationLog(log)).length, laterCalls.length, "removed native launch root never falls through to B's conflicting config");
			for (const params of [
				{ args: ["screenshot", "recovered-fresh.png"], sessionMode: "fresh" as const },
				{ args: ["--config", "agent-browser.json", "screenshot", "recovered-config.png"] },
			]) {
				const recovered = await executeRegisteredTool(harness.tool, harness.ctx, params);
				assert.equal(recovered.isError, false, recovered.content[0]?.text);
				assert.equal(recovered.details?.sessionName, "browser-b");
				assert.ok((await readFile(join(b, params.args.at(-1)!))).length > 0);
			}
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("initial fresh launch captures B before queued default browser selection and file output", async () => {
	const root = await realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "bcwf-")));
	const a = join(root, "a"), b = join(root, "b");
	await Promise.all([mkdir(a), mkdir(b)]);
	for (const cwd of [a, b]) execFileSync("git", ["init", "-q", cwd]);
	await writeFakeAgentBrowserBinary(root, `
const args = process.argv.slice(2);
const data = args.includes("tab") ? { tabs: [{ tabId: "t1", active: true, url: "https://fixture.test/", title: "Fixture" }] } : { url: "https://fixture.test/", title: "Fixture" };
console.log(JSON.stringify({ success: true, data }));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64), PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PATH: `${root}${delimiter}${process.env.PATH}` }, async () => {
			let selected = b;
			const harness = createExtensionHarness({ cwd: a, sessionFile: join(root, "one.jsonl"), onBusEvent(channel, request) {
				if (channel === "pi-change-working-dir:resolve-execution-cwd") Object.assign(request as object, { result: { cwd: selected } });
			} });
			await runExtensionEvent(harness.handlers, "session_start", {}, harness.ctx);
			try {
				const first = executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://fixture.test/"], sessionMode: "fresh" });
				const queued = executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"], outputPath: "queued.json" });
				const queuedCode = executeRegisteredTool(harness.getTool("agent_browser_code")!, harness.ctx, { code: 'emit((await browser({args:["get","title"]})).data);', outputPath: "queued-code.json" });
				selected = a;
				const [fresh, followup] = await Promise.all([first, queued]);
				assert.equal(fresh.isError, false, fresh.content[0]?.text);
				assert.equal(followup.isError, false, followup.content[0]?.text);
				assert.equal(followup.details?.sessionName, fresh.details?.sessionName, "queued default must follow the first fresh browser, not allocate a root browser");
				assert.equal(fresh.details?.managedSessionCwd, b);
				assert.equal(followup.details?.managedSessionCwd, b);
				assert.equal((followup.details?.outputFile as { absolutePath: string }).absolutePath, join(b, "queued.json"));
				assert.ok((await readFile(join(b, "queued.json"))).length > 0);
				await assert.rejects(readFile(join(a, "queued.json")), { code: "ENOENT" });
				const code = await queuedCode;
				assert.equal(code.isError, false, code.content[0]?.text);
				assert.equal(code.details?.sessionName, fresh.details?.sessionName, "queued code must follow the fresh browser");
				assert.equal((code.details?.outputFile as { absolutePath: string }).absolutePath, join(b, "queued-code.json"));
				assert.equal((harness.appendedEntries.at(-1)?.data as { details: { managedSessionCwd: string } }).details.managedSessionCwd, b);
			} finally { await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx); }
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("managed launch and restore roots survive directory changes, fresh replacement and branch replay", async () => {
	const root = await realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "bcwm-")));
	const a = join(root, "a"), b = join(root, "b"), log = join(root, "calls.jsonl");
	for (const cwd of [a, b]) {
		await mkdir(cwd);
		execFileSync("git", ["init", "-q", cwd]);
		await writeFile(join(cwd, "agent-browser.json"), JSON.stringify({ args: cwd === a ? "--disable-gpu" : "--disable-extensions" }));
	}
	await writeFakeAgentBrowserBinary(root, `
const fs = require("node:fs"), args = process.argv.slice(2);
const session = args.includes("--session") ? args[args.indexOf("--session") + 1] : "default";
const statePath = ${JSON.stringify(join(root, "state.json"))};
let sessions = {}; try { sessions = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
const state = sessions[session] ??= { active: false, restoreKey: null, launches: 0 };
let start = 0; while (args[start]?.startsWith("--")) start += args[start] === "--json" ? 1 : 2;
const tokens = args.slice(start);
let data;
if (tokens[0] === "session") data = tokens[1] === "info" ? { active: state.active, runtime: { restoreKey: state.restoreKey } } : { session };
else if (tokens[0] === "close") { state.active = false; data = { closed: true }; }
else {
  if (!state.active) { state.active = true; state.launches++; state.restoreKey = process.env.AGENT_BROWSER_RESTORE ?? null; }
  data = tokens[0] === "tab" ? { tabs: [{ tabId: "t1", active: true, url: "https://fixture.test/", title: "Fixture" }] } : { url: "https://fixture.test/", title: "Fixture" };
}
if (tokens[0] !== "session") fs.writeFileSync(statePath, JSON.stringify(sessions));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd:process.cwd(), session, restore:process.env.AGENT_BROWSER_RESTORE, launches:state.launches}) + "\\n");
console.log(JSON.stringify({success:true, data}));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64), PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1", PATH: `${root}${delimiter}${process.env.PATH}` }, async () => {
			let selected = a;
			const branch: unknown[] = [];
			const options = { cwd: a, branch, onBusEvent(channel: string, request: unknown) {
				if (channel === "pi-change-working-dir:resolve-execution-cwd") Object.assign(request as object, { result: { cwd: selected } });
			} };
			let harness = createExtensionHarness(options);
			await runExtensionEvent(harness.handlers, "session_start", {}, harness.ctx);
			const call = async (params: Parameters<typeof executeRegisteredTool>[2]) => {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
				assert.equal(result.isError, false, result.content[0]?.text);
				branch.push(createToolBranchEntry({ details: result.details! }));
				return result;
			};
			const first = await call({ args: ["open", "https://fixture.test/"], sessionMode: "fresh" });
			const firstSession = first.details?.sessionName;
			assert.equal(first.details?.managedSessionCwd, a);
			selected = b;
			const followup = await call({ args: ["get", "title"], outputPath: "title.json" });
			assert.equal(followup.details?.sessionName, firstSession);
			assert.equal(followup.details?.managedSessionCwd, a);
			assert.ok((await readFile(join(b, "title.json"))).length > 0);
			let calls = await readInvocationLog(log) as Array<{args: string[]; cwd: string; session: string; restore: string; launches: number}>;
			const activeCalls = calls.filter(row => row.session === firstSession && !row.args.includes("info"));
			const firstRestore = activeCalls[0].restore;
			assert.match(firstRestore, /^piab-r2-/);
			assert.ok(activeCalls.every(row => row.cwd === a && row.restore === firstRestore && row.launches === 1));
			const pendingFresh = call({ args: ["open", "https://fixture.test/"], sessionMode: "fresh" });
			const queued = call({ args: ["get", "title"], outputPath: "queued-after-fresh.json" });
			selected = a;
			const fresh = await pendingFresh;
			const queuedResult = await queued;
			assert.equal(queuedResult.details?.sessionName, fresh.details?.sessionName);
			assert.equal(queuedResult.details?.managedSessionCwd, b);
			assert.ok((await readFile(join(b, "queued-after-fresh.json"))).length > 0);
			assert.notEqual(fresh.details?.sessionName, firstSession);
			assert.equal(fresh.details?.managedSessionCwd, b);
			const newSession = fresh.details?.sessionName;
			selected = a;
			await call({ args: ["get", "title"], outputPath: "after-fresh.json" });
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "reload" }, harness.ctx);
			harness = createExtensionHarness(options);
			await runExtensionEvent(harness.handlers, "session_start", {}, harness.ctx);
			const replay = await call({ args: ["get", "title"], outputPath: "after-replay.json" });
			assert.equal(replay.details?.sessionName, newSession);
			assert.equal(replay.details?.managedSessionCwd, b);
			assert.ok((await readFile(join(a, "after-replay.json"))).length > 0);
			calls = await readInvocationLog(log) as typeof calls;
			const newCalls = calls.filter(row => row.session === newSession && !row.args.includes("info"));
			assert.ok(newCalls.length >= 3);
			assert.match(newCalls[0].restore, /^piab-r2-/);
			assert.notEqual(newCalls[0].restore, firstRestore, "fresh B gets B's Git restore identity");
			assert.ok(newCalls.every(row => row.cwd === b && row.restore === newCalls[0].restore && row.launches === 1));
			assert.ok(newCalls.every(row => row.args.includes("--no-startup-window,--disable-extensions")), "native B launch settings remain stable");
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});
