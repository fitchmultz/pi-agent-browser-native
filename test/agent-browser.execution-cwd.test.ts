import { readArray, readNumber, readRecord, readString } from "./helpers/assertions.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

const clearedBrowserEnv = Object.fromEntries(
	Object.keys(process.env)
		.filter((name) => name.startsWith("AGENT_BROWSER_") || name.startsWith("PI_AGENT_BROWSER_"))
		.map((name) => [name, undefined]),
);

test("operation files follow the captured cwd while native config and session stay anchored", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "browser-cwd-")));
	const a = join(root, "a"),
		b = join(root, "b");
	const log = join(root, "calls.jsonl");
	await Promise.all([mkdir(a), mkdir(b)]);
	for (const directory of [a, b]) {
		execFileSync("git", ["init", "-q", directory]);
	}
	await writeFile(join(a, "OnlyA.ts"), 'export const Widget = "https://fixture.test/api/items";');
	await writeFile(join(b, "OnlyB.ts"), 'export const Widget = "https://fixture.test/api/items";');
	await writeFile(
		join(a, "agent-browser.json"),
		JSON.stringify({ session: "browser-a", profile: "Profile A" }),
	);
	await writeFile(
		join(b, "agent-browser.json"),
		JSON.stringify({ session: "browser-b", profile: "Profile B" }),
	);
	await writeFakeAgentBrowserBinary(
		root,
		`
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
`,
	);
	try {
		await withPatchedEnv(
			{
				...clearedBrowserEnv,
				HOME: root,
				USERPROFILE: root,
				PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
				PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			},
			async () => {
				let selected = a;
				let resolutions = 0;
				const harness = createExtensionHarness({
					cwd: a,
					sessionFile: join(root, "sessions", "one.jsonl"),
					onBusEvent(channel, request) {
						if (channel === "pi-change-working-dir:resolve-execution-cwd") {
							resolutions++;
							Object.assign(readRecord(request), { result: { cwd: selected } });
						}
					},
				});
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://fixture.test/"],
				});
				assert.equal(opened.isError, false, opened.content[0].text);
				const recording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "capture.webm"],
				});
				assert.equal(recording.isError, false, recording.content[0].text);
				selected = b;
				const pending = executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["screenshot", "shots/page.png"],
					outputPath: "results/page.json",
				});
				selected = a; // An await or queue must not re-resolve the operation root.
				const screenshot = await pending;
				const screenshotDetails = readRecord(screenshot.details);
				assert.equal(screenshot.isError, false, screenshot.content[0].text);
				assert.equal(screenshotDetails.sessionName, "browser-a");
				assert.equal(
					readArray(screenshotDetails.artifacts).map((value) => readRecord(value))[0].cwd,
					b,
				);
				assert.ok((await readFile(join(b, "shots/page.png"))).length > 0);
				assert.ok((await readFile(join(b, "results/page.json"))).length > 0);
				assert.equal(resolutions, 3);
				assert.equal(harness.ctx.cwd, a);
				selected = b;
				await Promise.all(
					[
						{
							name: "agent_browser_source",
							params: { componentName: "Widget", includeDomHints: false },
						},
						{
							name: "agent_browser_network_source",
							params: { url: "https://fixture.test/api/items" },
						},
					].map(async ({ name, params }) => {
						const tool = harness.getTool(name);
						assert.ok(tool, `${name} must be registered`);
						const result = await executeRegisteredTool(tool, harness.ctx, params);
						const resultDetails = readRecord(result.details);
						assert.equal(result.isError, false, result.content[0].text);
						assert.match(
							JSON.stringify(resultDetails.sourceLookup ?? resultDetails.networkSourceLookup),
							/OnlyB.ts/,
						);
						assert.doesNotMatch(
							JSON.stringify(resultDetails.sourceLookup ?? resultDetails.networkSourceLookup),
							/OnlyA.ts/,
						);
					}),
				);
				await writeFile(join(b, "input.txt"), "B input");
				const upload = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["upload", "#upload", "input.txt"],
				});
				const uploadDetails = readRecord(upload.details);
				assert.equal(upload.isError, false, upload.content[0].text);
				assert.match(JSON.stringify(uploadDetails.data), /B input/);
				const download = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["download", "#link", "downloads/report.txt"],
				});
				assert.equal(download.isError, false, download.content[0].text);
				assert.equal(await readFile(join(b, "downloads/report.txt"), "utf8"), "download fixture");
				const one = executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "--bail"],
					stdin: JSON.stringify([["screenshot", "jobs/one.png"]]),
				});
				const two = executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "--bail"],
					stdin: JSON.stringify([["screenshot", "jobs/two.png"]]),
				});
				selected = a;
				for (const result of await Promise.all([one, two])) {
					// Exhaustive fixture variant (await Promise.all([one, two])): this selected path must satisfy its own contract.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.isError, false, result.content[0].text);
				}
				assert.ok((await readFile(join(b, "jobs/one.png"))).length > 0);
				assert.ok((await readFile(join(b, "jobs/two.png"))).length > 0);
				selected = b;
				const stopped = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "stop"],
					outputPath: "receipts/stop.json",
				});
				assert.equal(stopped.isError, false, stopped.content[0].text);
				assert.equal(await readFile(join(a, "capture.webm"), "utf8"), "video fixture");
				assert.ok((await readFile(join(b, "receipts/stop.json"))).length > 0);
				const newRecording = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "new.webm"],
				});
				assert.equal(newRecording.isError, false, newRecording.content[0].text);
				selected = a;
				assert.equal(
					(await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "stop"] }))
						.isError,
					false,
				);
				assert.equal(await readFile(join(b, "new.webm"), "utf8"), "video fixture");
				selected = b;
				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const snapshotDetails = readRecord(snapshot.details);
				assert.equal(snapshot.isError, false, snapshot.content[0].text);
				assert.ok(
					readString(snapshotDetails.fullOutputPath).startsWith(
						join(root, "sessions", ".pi-agent-browser-artifacts"),
					),
				);
				const calls = readArray(await readInvocationLog(log)).map((value) => readRecord(value));
				assert.ok(calls.every((call) => call.cwd === a && call.profile === "Profile A"));
				assert.ok(
					calls.filter((call) => readNumber(call.launch) > 0).every((call) => call.launch === 1),
					"live browser never restarted",
				);
				const beforeScript = resolutions;
				const script = executeRegisteredTool(
					// Missing code-tool registration fails immediately rather than skipping cwd assertions.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					harness.getTool("agent_browser_code") ?? assert.fail("code tool must be registered"),
					harness.ctx,
					{
						code: 'await browser({args:["screenshot","code/one.png"]}); await browser({args:["screenshot","code/two.png"]}); emit("done");',
					},
				);
				selected = a;
				const scriptResult = await script;
				assert.equal(scriptResult.isError, false, scriptResult.content[0].text);
				assert.equal(resolutions, beforeScript + 1, "code calls inherit one outer cwd snapshot");
				assert.ok((await readFile(join(b, "code/one.png"))).length > 0);
				assert.ok((await readFile(join(b, "code/two.png"))).length > 0);
				assert.ok(
					(await readFile(readString(snapshotDetails.fullOutputPath))).length > 0,
					"cached artifact stays in the original store",
				);
				selected = b;
				const configured = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--config", "agent-browser.json", "get", "title"],
				});
				const configuredDetails = readRecord(configured.details);
				assert.equal(configured.isError, false, configured.content[0].text);
				assert.equal(configuredDetails.sessionName, "browser-b");
				await withPatchedEnv(
					{ AGENT_BROWSER_CONFIG: "agent-browser.json", AGENT_BROWSER_SESSION: "env-session" },
					async () => {
						const env = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["get", "title"],
						});
						const envDetails = readRecord(env.details);
						assert.equal(env.isError, false, env.content[0].text);
						assert.equal(envDetails.sessionName, "env-session");
						const explicit = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "per-call", "get", "title"],
						});
						const explicitDetails = readRecord(explicit.details);
						assert.equal(explicit.isError, false, explicit.content[0].text);
						assert.equal(explicitDetails.sessionName, "per-call");
					},
				);
				const unrelated = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "unused-target", "get", "title"],
				});
				const unrelatedDetails = readRecord(unrelated.details);
				assert.equal(unrelated.isError, false, unrelated.content[0].text);
				assert.equal(unrelatedDetails.sessionName, "unused-target");
				const restoredDefault = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "title"],
				});
				const restoredDefaultDetails = readRecord(restoredDefault.details);
				assert.equal(restoredDefaultDetails.sessionName, "browser-a");
				const laterCalls = readArray(await readInvocationLog(log)).map((value) =>
					readRecord(value),
				);
				assert.ok(
					laterCalls
						.filter(
							(call) =>
								call.session === "browser-b" ||
								call.session === "env-session" ||
								call.session === "per-call",
						)
						.every((call) => call.cwd === b && call.configPath === join(b, "agent-browser.json")),
				);
				assert.ok(
					laterCalls
						.filter((call) => call.session === "unused-target")
						.every((call) => call.cwd === a),
				);
				await rm(a, { recursive: true, force: true });
				const removedOrigin = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["screenshot", "after-removal.png"],
				});
				const removedOriginDetails = readRecord(removedOrigin.details);
				assert.equal(removedOrigin.isError, true);
				assert.equal(removedOriginDetails.failureCategory, "validation-error");
				assert.match(
					readString(removedOrigin.content[0].text ?? ""),
					/Browser launch directory is unavailable/,
				);
				assert.equal(
					(await readInvocationLog(log)).length,
					laterCalls.length,
					"removed native launch root never falls through to B's conflicting config",
				);
				for (const params of [
					{ args: ["screenshot", "recovered-fresh.png"], sessionMode: "fresh" as const },
					{ args: ["--config", "agent-browser.json", "screenshot", "recovered-config.png"] },
				]) {
					// These operations share browser/cwd state; finish the operation and its file readback before the next transition.
					// oxlint-disable-next-line no-await-in-loop
					const recovered = await executeRegisteredTool(harness.tool, harness.ctx, params);
					const recoveredDetails = readRecord(recovered.details);
					// Both fresh and configured recovery variants must select B and write the requested artifact.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(recovered.isError, false, recovered.content[0].text);
					// Both fresh and configured recovery variants must select B and write the requested artifact.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(recoveredDetails.sessionName, "browser-b");
					// These operations share browser/cwd state; finish the operation and its file readback before the next transition.
					// oxlint-disable-next-line no-await-in-loop
					const artifact = await readFile(join(b, readString(params.args.at(-1))));
					// Both fresh and configured recovery variants must select B and write the requested artifact.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(artifact.length > 0);
				}
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("initial fresh launch captures B before queued default browser selection and file output", async () => {
	const root = await realpath(
		await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "bcwf-")),
	);
	const a = join(root, "a"),
		b = join(root, "b");
	await Promise.all([mkdir(a), mkdir(b)]);
	for (const cwd of [a, b]) {
		execFileSync("git", ["init", "-q", cwd]);
	}
	await writeFakeAgentBrowserBinary(
		root,
		`
const args = process.argv.slice(2);
const data = args.includes("tab") ? { tabs: [{ tabId: "t1", active: true, url: "https://fixture.test/", title: "Fixture" }] } : { url: "https://fixture.test/", title: "Fixture" };
console.log(JSON.stringify({ success: true, data }));
`,
	);
	try {
		await withPatchedEnv(
			{
				...clearedBrowserEnv,
				HOME: root,
				USERPROFILE: root,
				AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
				PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			},
			async () => {
				let selected = b;
				const harness = createExtensionHarness({
					cwd: a,
					sessionFile: join(root, "one.jsonl"),
					onBusEvent(channel, request) {
						if (channel === "pi-change-working-dir:resolve-execution-cwd") {
							Object.assign(readRecord(request), { result: { cwd: selected } });
						}
					},
				});
				await runExtensionEvent(harness.handlers, "session_start", {}, harness.ctx);
				try {
					const first = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://fixture.test/"],
						sessionMode: "fresh",
					});
					const queued = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "title"],
						outputPath: "queued.json",
					});
					const queuedCode = executeRegisteredTool(
						// Missing code-tool registration fails immediately rather than skipping cwd assertions.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						harness.getTool("agent_browser_code") ?? assert.fail("code tool must be registered"),
						harness.ctx,
						{
							code: 'emit((await browser({args:["get","title"]})).data);',
							outputPath: "queued-code.json",
						},
					);
					selected = a;
					const [fresh, followup] = await Promise.all([first, queued]);
					assert.equal(fresh.isError, false, fresh.content[0].text);
					assert.equal(followup.isError, false, followup.content[0].text);
					assert.equal(
						followup.details?.sessionName,
						fresh.details?.sessionName,
						"queued default must follow the first fresh browser, not allocate a root browser",
					);
					assert.equal(fresh.details?.managedSessionCwd, b);
					assert.equal(followup.details?.managedSessionCwd, b);
					assert.equal(
						readRecord(followup.details.outputFile).absolutePath,
						join(b, "queued.json"),
					);
					assert.ok((await readFile(join(b, "queued.json"))).length > 0);
					await assert.rejects(readFile(join(a, "queued.json")), { code: "ENOENT" });
					const code = await queuedCode;
					const codeDetails = readRecord(code.details);
					assert.equal(code.isError, false, code.content[0].text);
					assert.equal(
						codeDetails.sessionName,
						fresh.details.sessionName,
						"queued code must follow the fresh browser",
					);
					assert.equal(
						readRecord(codeDetails.outputFile).absolutePath,
						join(b, "queued-code.json"),
					);
					assert.equal(
						readRecord(readRecord(readRecord(harness.appendedEntries.at(-1)?.data).event).state)
							.managedSessionCwd,
						b,
					);
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
		await rm(root, { recursive: true, force: true });
	}
});

test("managed launch and restore roots survive directory changes, fresh replacement and branch replay", async () => {
	const root = await realpath(
		await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "bcwm-")),
	);
	const a = join(root, "a"),
		b = join(root, "b"),
		log = join(root, "calls.jsonl");
	await Promise.all(
		[a, b].map(async (cwd) => {
			await mkdir(cwd);
			execFileSync("git", ["init", "-q", cwd]);
			await writeFile(
				join(cwd, "agent-browser.json"),
				JSON.stringify({ args: cwd === a ? "--disable-gpu" : "--disable-extensions" }),
			);
		}),
	);
	await writeFakeAgentBrowserBinary(
		root,
		`
const fs = require("node:fs"), args = process.argv.slice(2);
const session = args.includes("--session") ? args[args.indexOf("--session") + 1] : "default";
const configPath = process.env.AGENT_BROWSER_CONFIG ?? require("node:path").join(process.cwd(), "agent-browser.json");
const configArgs = JSON.parse(fs.readFileSync(configPath, "utf8")).args;
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
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd:process.cwd(), session, configPath, configArgs, environmentArgs:process.env.AGENT_BROWSER_ARGS ?? null, restore:process.env.AGENT_BROWSER_RESTORE, launches:state.launches}) + "\\n");
console.log(JSON.stringify({success:true, data}));
`,
	);
	try {
		await withPatchedEnv(
			{
				...clearedBrowserEnv,
				HOME: root,
				USERPROFILE: root,
				AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
				PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
				PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			},
			async () => {
				let selected = a;
				const branch: unknown[] = [];
				const options = {
					cwd: a,
					branch,
					onBusEvent(channel: string, request: unknown) {
						if (channel === "pi-change-working-dir:resolve-execution-cwd") {
							Object.assign(readRecord(request), { result: { cwd: selected } });
						}
					},
				};
				let harness = createExtensionHarness(options);
				await runExtensionEvent(harness.handlers, "session_start", {}, harness.ctx);
				const call = async (params: Parameters<typeof executeRegisteredTool>[2]) => {
					const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
					const resultDetails = readRecord(result.details);
					assert.equal(result.isError, false, result.content[0].text);
					branch.push(createToolBranchEntry({ details: readRecord(resultDetails) }));
					return result;
				};
				const first = await call({ args: ["open", "https://fixture.test/"], sessionMode: "fresh" });
				const firstDetails = readRecord(first.details);
				const firstSession = firstDetails.sessionName;
				assert.equal(firstDetails.managedSessionCwd, a);
				selected = b;
				const followup = await call({ args: ["get", "title"], outputPath: "title.json" });
				const followupDetails = readRecord(followup.details);
				assert.equal(followupDetails.sessionName, firstSession);
				assert.equal(followupDetails.managedSessionCwd, a);
				assert.ok((await readFile(join(b, "title.json"))).length > 0);
				let calls = readArray(await readInvocationLog(log)).map((value) => readRecord(value));
				const activeCalls = calls.filter(
					(row) =>
						row.session === firstSession && !readArray(row.args).map(readString).includes("info"),
				);
				const firstRestore = activeCalls[0].restore;
				assert.match(readString(firstRestore), /^piab-r2-/);
				assert.ok(
					activeCalls.every(
						(row) => row.cwd === a && row.restore === firstRestore && row.launches === 1,
					),
				);
				assert.ok(
					activeCalls.every(
						(row) =>
							row.configPath === join(a, "agent-browser.json") &&
							row.configArgs === "--disable-gpu" &&
							row.environmentArgs === null &&
							!readArray(row.args).map(readString).includes("--args"),
					),
					"native A configuration reaches initial and active calls unchanged",
				);
				const pendingFresh = call({
					args: ["open", "https://fixture.test/"],
					sessionMode: "fresh",
				});
				const queued = call({ args: ["get", "title"], outputPath: "queued-after-fresh.json" });
				selected = a;
				const fresh = await pendingFresh;
				const freshDetails = readRecord(fresh.details);
				const queuedResult = await queued;
				const queuedResultDetails = readRecord(queuedResult.details);
				assert.equal(queuedResultDetails.sessionName, freshDetails.sessionName);
				assert.equal(queuedResultDetails.managedSessionCwd, b);
				assert.ok((await readFile(join(b, "queued-after-fresh.json"))).length > 0);
				assert.notEqual(freshDetails.sessionName, firstSession);
				assert.equal(freshDetails.managedSessionCwd, b);
				const newSession = freshDetails.sessionName;
				selected = a;
				await call({ args: ["get", "title"], outputPath: "after-fresh.json" });
				await runExtensionEvent(
					harness.handlers,
					"session_shutdown",
					{ reason: "reload" },
					harness.ctx,
				);
				harness = createExtensionHarness(options);
				await runExtensionEvent(harness.handlers, "session_start", {}, harness.ctx);
				const replay = await call({ args: ["get", "title"], outputPath: "after-replay.json" });
				const replayDetails = readRecord(replay.details);
				assert.equal(replayDetails.sessionName, newSession);
				assert.equal(replayDetails.managedSessionCwd, b);
				assert.ok((await readFile(join(a, "after-replay.json"))).length > 0);
				calls = readArray(await readInvocationLog(log)).map(readRecord);
				const newCalls = calls.filter(
					(row) =>
						row.session === newSession && !readArray(row.args).map(readString).includes("info"),
				);
				assert.ok(newCalls.length >= 3);
				assert.match(readString(newCalls[0].restore), /^piab-r2-/);
				assert.notEqual(newCalls[0].restore, firstRestore, "fresh B gets B's Git restore identity");
				assert.ok(
					newCalls.every(
						(row) => row.cwd === b && row.restore === newCalls[0].restore && row.launches === 1,
					),
				);
				assert.ok(
					newCalls.every(
						(row) =>
							row.configPath === join(b, "agent-browser.json") &&
							row.configArgs === "--disable-extensions" &&
							row.environmentArgs === null &&
							!readArray(row.args).map(readString).includes("--args"),
					),
					"native B configuration remains stable without wrapper args overriding it",
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
});
