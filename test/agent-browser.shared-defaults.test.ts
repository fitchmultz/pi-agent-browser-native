import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness, createToolBranchEntry, executeRegisteredTool, readInvocationLog, runExtensionEvent,
	startAgentBrowserContractFixtureServer, withPatchedEnv, writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const clearedBrowserEnv = Object.fromEntries(Object.keys(process.env)
	.filter((name) => name.startsWith("AGENT_BROWSER_") || name.startsWith("PI_AGENT_BROWSER_"))
	.map((name) => [name, undefined]));

test("native environment defaults share caller ownership across Pi sessions and helpers", async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbs-shared-"));
	const log = join(root, "calls.jsonl");
	await writeFakeAgentBrowserBinary(root, `
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
const data = args.includes("snapshot") ? { snapshot: "- button \\"Continue\\" [ref=e1]", refs: { e1: { role: "button", name: "Continue" } }, url: "https://fixture.test/" } : { title: "Fixture", url: "https://fixture.test/" };
console.log(JSON.stringify({ success: true, data }));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PATH: `${root}${delimiter}${process.env.PATH}`, AGENT_BROWSER_SESSION: "shared", AGENT_BROWSER_NAMESPACE: "Team Work", PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" }, async () => {
			const one = createExtensionHarness({ cwd: root, sessionId: "pi-one" });
			const two = createExtensionHarness({ cwd: root, sessionId: "pi-two" });
			for (const harness of [one, two]) {
				await runExtensionEvent(harness.handlers, "session_start", {}, harness.ctx);
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
				assert.equal(result.isError, false, result.content[0]?.text);
				assert.equal(result.details?.sessionName, "shared");
				assert.equal(result.details?.namespace, "team-work");
				assert.equal(result.details?.usedImplicitSession, false);
				assert.equal(result.details?.managedSessionOutcome, undefined);
			}
			const override = await executeRegisteredTool(two.tool, two.ctx, { args: ["--namespace", "", "--session", "override", "--idle-timeout", "42", "get", "title"] });
			assert.equal(override.isError, false, override.content[0]?.text);
			assert.equal(override.details?.sessionName, "override");
			assert.equal(override.details?.namespace, "");
			await runExtensionEvent(one.handlers, "session_shutdown", { reason: "quit" }, one.ctx);
			await runExtensionEvent(two.handlers, "session_shutdown", { reason: "quit" }, two.ctx);
			const calls = await readInvocationLog(log);
			assert.ok(calls.some((call) => call.args.includes("url")), "caller-owned live target helpers run");
			assert.ok(calls.every((call) => call.idleTimeout === (call.args.includes("override") ? "42" : null)), "native idle selection is consistent across caller-owned helpers and main calls");
			assert.ok(calls.every((call) => !call.args.includes("close")), "Pi quit leaves shared caller-owned browser alone");
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit fresh sessions retain ownership and idle cleanup", async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbs-owned-"));
	const log = join(root, "calls.jsonl");
	await writeFakeAgentBrowserBinary(root, `
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
console.log(JSON.stringify({ success: true, data: { title: "Fixture", url: "about:blank" } }));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PATH: `${root}${delimiter}${process.env.PATH}`, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "about:blank"], sessionMode: "fresh" });
			assert.equal(result.isError, false, result.content[0]?.text);
			assert.equal((result.details?.managedSessionOutcome as { activeAfter?: boolean })?.activeAfter, true);
			const fresh = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "about:blank"], sessionMode: "fresh" });
			assert.equal(fresh.isError, false, fresh.content[0]?.text);
			assert.notEqual(fresh.details?.sessionName, result.details?.sessionName, "fresh still rotates unconfigured implicit sessions");
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
			const calls = await readInvocationLog(log);
			assert.ok(calls.some((call) => call.args.includes("close")));
			assert.ok(calls.every((call) => call.idleTimeout === "900000"));
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("root defaults isolate roots, share descendants, and keep bootstrap settings on helpers without claiming quit ownership", async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbs-root-"));
	const log = join(root, "calls.jsonl");
	await mkdir(join(root, ".pi", "config", "pi-agent-browser-native"), { recursive: true });
	await writeFile(join(root, ".pi", "config", "pi-agent-browser-native", "config.json"), JSON.stringify({ browser: { defaultProfile: { name: "Default", policy: "always" } } }));
	await writeFakeAgentBrowserBinary(root, `
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, restore: process.env.AGENT_BROWSER_RESTORE ?? null, profile: process.env.AGENT_BROWSER_PROFILE ?? null }) + "\\n");
console.log(JSON.stringify({ success: true, data: { title: "Fixture", url: "https://fixture.test/" } }));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PATH: `${root}${delimiter}${process.env.PATH}`, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_ROOT_SESSION_ID: undefined }, async () => {
			const one = createExtensionHarness({ cwd: root, sessionId: "root-one" });
			const two = createExtensionHarness({ cwd: root, sessionId: "root-two" });
			const read = (h: typeof one) => executeRegisteredTool(h.tool, h.ctx, { args: ["get", "title"] });
			const [a, b] = await Promise.all([read(one), read(two)]);
			assert.equal(a.isError, false, a.content[0]?.text);
			assert.equal(b.isError, false, b.content[0]?.text);
			assert.equal(typeof a.details?.sessionName, "string");
			assert.notEqual(a.details?.sessionName, b.details?.sessionName);
			const followup = await executeRegisteredTool(one.tool, one.ctx, { args: ["--session", String(a.details?.sessionName), "get", "title"] });
			assert.equal(followup.isError, false, followup.content[0]?.text);
			await withPatchedEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_ROOT_SESSION_ID: "root-one" }, async () => {
				const child = createExtensionHarness({ cwd: root, sessionId: "child-id" });
				assert.equal((await read(child)).details?.sessionName, a.details?.sessionName);
				await runExtensionEvent(child.handlers, "session_shutdown", { reason: "quit" }, child.ctx);
			});
			await mkdir(join(root, "other-cwd"));
			const resumed = createExtensionHarness({ cwd: join(root, "other-cwd"), sessionId: "root-one" });
			assert.equal((await read(resumed)).details?.sessionName, a.details?.sessionName);
			const explicit = await executeRegisteredTool(one.tool, one.ctx, { args: ["--session", "unrelated", "get", "title"] });
			assert.equal(explicit.details?.sessionName, "unrelated");
			for (const h of [one, two, resumed]) await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
			const calls = (await readInvocationLog(log)) as Array<{ args: string[]; restore: string | null; profile: string | null }>;
			assert.ok(calls.some((call) => call.args.includes("url")), "real helper routing is covered");
			for (const call of calls) {
				assert.ok(!call.args.includes("close"), "neither parent nor child exit owns group teardown");
				const name = call.args[call.args.indexOf("--session") + 1];
				assert.equal(call.restore, name === "unrelated" ? null : name);
				assert.equal(call.profile, name === "unrelated" ? null : "Default");
			}
			const profiled = await executeRegisteredTool(one.tool, one.ctx, { args: ["--profile", "Profile 1", "open", "https://fixture.test/"] });
			assert.equal(profiled.isError, false, profiled.content[0]?.text);
			assert.equal(profiled.details?.sessionName, a.details?.sessionName, "profile flags do not split a root group");
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("real root group retains explicit profile across child helpers and persistent-profile restart", { skip: process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1", timeout: 120_000 }, async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbr-"));
	const fixture = await startAgentBrowserContractFixtureServer();
	const profile = join(root, "profile");
	const configDir = join(root, ".pi", "config", "pi-agent-browser-native");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({ browser: { defaultProfile: { name: "Unavailable Fixture Source", policy: "always" } } }));
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_ROOT_SESSION_ID: undefined }, async () => {
			const parent = createExtensionHarness({ cwd: root, sessionId: "persistent-root" });
			try {
				const opened = await executeRegisteredTool(parent.tool, parent.ctx, { args: ["--profile", profile, "open", fixture.baseUrl] });
				assert.equal(opened.isError, false, opened.content[0]?.text);
				const name = opened.details?.sessionName;
				assert.ok(typeof name === "string" && name.length > 0);
				const pidPath = join(root, "s", `${name}.pid`);
				const pid = await readFile(pidPath, "utf8");
				const marked = await executeRegisteredTool(parent.tool, parent.ctx, { args: ["eval", "--stdin"], stdin: `new Promise((resolve,reject)=>{const r=indexedDB.open('root-profile-marker',1);r.onupgradeneeded=()=>r.result.createObjectStore('auth');r.onsuccess=()=>{const db=r.result;const t=db.transaction('auth','readwrite');t.objectStore('auth').put('kept','marker');t.oncomplete=()=>{db.close();resolve(true)}};r.onerror=()=>reject(r.error)})` });
				assert.equal(marked.isError, false, marked.content[0]?.text);
				await withPatchedEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_ROOT_SESSION_ID: "persistent-root" }, async () => {
					const child = createExtensionHarness({ cwd: root, sessionId: "child-uuid" });
					try {
						const shared = await executeRegisteredTool(child.tool, child.ctx, { args: ["get", "title"] });
						assert.equal(shared.isError, false, shared.content[0]?.text);
						assert.equal(shared.details?.sessionName, name);
						const result = await executeRegisteredTool(child.tool, child.ctx, { args: ["--session", name, "get", "title"] });
						assert.equal(result.isError, false, result.content[0]?.text);
						assert.equal(result.details?.sessionName, name);
						const qa = await executeRegisteredTool(child.tool, child.ctx, { qa: { attached: true, expectedText: "Agent Browser Contract Fixture" } });
						assert.equal(qa.isError, false, qa.content[0]?.text);
					} finally { await runExtensionEvent(child.handlers, "session_shutdown", { reason: "quit" }, child.ctx); }
				});
				assert.equal(await readFile(pidPath, "utf8"), pid, "child follow-ups neither apply the unavailable default profile nor restart the daemon");
				await executeRegisteredTool(parent.tool, parent.ctx, { args: ["close"] });
				const resumed = createExtensionHarness({ cwd: root, sessionId: "persistent-root" });
				const reopened = await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["--profile", profile, "open", fixture.baseUrl] });
				assert.equal(reopened.isError, false, reopened.content[0]?.text);
				assert.equal(reopened.details?.sessionName, name);
				assert.notEqual(await readFile(pidPath, "utf8"), pid);
				const retained = await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["eval", "--stdin"], stdin: `new Promise((resolve,reject)=>{const r=indexedDB.open('root-profile-marker');r.onsuccess=()=>{const db=r.result;const t=db.transaction('auth');const get=t.objectStore('auth').get('marker');get.onsuccess=()=>{db.close();resolve(get.result)}};r.onerror=()=>reject(r.error)})` });
				assert.equal(retained.isError, false, retained.content[0]?.text);
				assert.equal((retained.details?.data as { result?: unknown })?.result, "kept");
			} finally { await executeRegisteredTool(parent.tool, parent.ctx, { args: ["close"] }); }
		});
	} finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("real native config identity follows file, environment and argv precedence", { skip: process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1" }, async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbs-config-"));
	await mkdir(join(root, ".agent-browser"));
	const global = join(root, ".agent-browser", "config.json");
	const project = join(root, "agent-browser.json");
	const explicit = join(root, "explicit.json");
	await writeFile(global, JSON.stringify({ session: "global", namespace: "Global Space" }));
	await writeFile(project, JSON.stringify({ session: "project" }));
	await writeFile(explicit, JSON.stringify({ session: "default", namespace: "" }));
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s") }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			const inspect = async (args: string[], session: string, namespace?: string) => {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args, "session"] });
				assert.equal(result.isError, false, result.content[0]?.text);
				assert.equal(result.details?.sessionName, session);
				assert.equal((result.details?.data as { session?: string })?.session, session);
				assert.equal(result.details?.namespace, namespace);
				assert.equal(result.details?.usedImplicitSession, false);
			};
			await inspect([], "project", "global-space");
			await withPatchedEnv({ AGENT_BROWSER_SESSION: "--shared" }, () => inspect([], "--shared", "global-space"));
			await inspect(["--session", "--shared"], "--shared", "global-space");
			await withPatchedEnv({ AGENT_BROWSER_SESSION: "env", AGENT_BROWSER_NAMESPACE: "Env Space" }, async () => {
				await inspect([], "env", "env-space");
				await inspect(["--session", "argv", "--namespace", ""], "argv", "");
			});
			await withPatchedEnv({ AGENT_BROWSER_CONFIG: explicit }, async () => {
				await inspect([], "default");
				await inspect(["--config", global], "global", "global-space");
			});
			await inspect(["--config", "explicit.json", "--config", global], "default");
			await writeFile(project, JSON.stringify({ session: "discarded", headed: "invalid-native-type" }));
			await inspect([], "global", "global-space");
			await writeFile(project, JSON.stringify({ session: null, namespace: null }));
			await inspect([], "global", "global-space");
			const bad = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--config", "absent.json", "session"] });
			assert.equal(bad.isError, true);
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("real native config shares a persistent fixture profile with fresh code contexts", { skip: process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1", timeout: 120_000 }, async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbs-"));
	const socketDir = join(root, "s");
	await mkdir(socketDir, { mode: 0o700 });
	await mkdir(join(root, "second"));
	await mkdir(join(root, ".agent-browser"), { mode: 0o700 });
	const config = { session: "shared", namespace: "team", profile: join(root, "profile"), executablePath: process.env.PI_AGENT_BROWSER_TEST_CHROME, headed: false };
	await writeFile(join(root, ".agent-browser", "config.json"), JSON.stringify(config));
	const fixture = await startAgentBrowserContractFixtureServer();
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, AGENT_BROWSER_SOCKET_DIR: socketDir, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" }, async () => {
			const one = createExtensionHarness({ cwd: root, sessionId: "pi-one", sessionFile: join(root, "one.jsonl") });
			const two = createExtensionHarness({ cwd: join(root, "second"), sessionId: "pi-two", sessionFile: join(root, "two.jsonl") });
			try {
				const opened = await executeRegisteredTool(one.tool, one.ctx, { args: ["open", fixture.baseUrl] });
				assert.equal(opened.isError, false, opened.content[0]?.text);
				assert.equal(opened.details?.sessionName, "shared");
				assert.equal(opened.details?.usedImplicitSession, false);
				const marked = await executeRegisteredTool(one.tool, one.ctx, { args: ["eval", "--stdin"], stdin: 'localStorage.setItem("fixture-marker", "kept"); "marked"' });
				assert.equal(marked.isError, false, marked.content[0]?.text);
				const pidPath = join(socketDir, "namespaces", "team", "run", "shared.pid");
				const pid = await readFile(pidPath, "utf8");
				await runExtensionEvent(one.handlers, "session_shutdown", { reason: "quit" }, one.ctx);
				two.setBranch([createToolBranchEntry({ details: opened.details ?? {} })]);
				await runExtensionEvent(two.handlers, "session_start", { reason: "resume" }, two.ctx);
				const reused = await executeRegisteredTool(two.tool, two.ctx, { args: ["eval", "--stdin"], stdin: 'localStorage.getItem("fixture-marker")' });
				assert.equal(reused.isError, false, reused.content[0]?.text);
				assert.equal(reused.details?.sessionName, "shared");
				assert.match(JSON.stringify(reused.details?.data), /kept/);
				const fresh = await executeRegisteredTool(two.tool, two.ctx, { args: ["get", "title"], sessionMode: "fresh" });
				assert.equal(fresh.isError, false, fresh.content[0]?.text);
				assert.equal(fresh.details?.sessionName, "shared", "configured native session wins just like explicit --session");
				assert.equal(fresh.details?.managedSessionOutcome, undefined);
				assert.equal(await readFile(pidPath, "utf8"), pid, "fresh must not restart the configured shared browser");
				const qa = await executeRegisteredTool(two.getTool("agent_browser_qa")!, two.ctx, { attached: true, expectedText: "Agent Browser Contract Fixture" });
				assert.equal(qa.isError, false, qa.content[0]?.text);
				assert.equal(qa.details?.sessionName, "shared");
				const semantic = await executeRegisteredTool(two.getTool("agent_browser_action")!, two.ctx, { action: "fill", locator: "role", value: "textbox", name: "Name", text: "shared value" });
				assert.equal(semantic.isError, false, semantic.content[0]?.text);
				assert.equal(semantic.details?.sessionName, "shared");
				assert.equal(semantic.details?.namespace, "team");
				assert.ok((semantic.details?.effectiveArgs as string[]).some((arg) => /^@e\d+$/.test(arg)), "semantic re-planning uses a live ref and retains native defaults");
				const batch = await executeRegisteredTool(two.tool, two.ctx, { args: ["batch", "--bail"], stdin: JSON.stringify([["wait", "--text", "Agent Browser Contract Fixture"]]) });
				assert.equal(batch.isError, false, batch.content[0]?.text);
				assert.equal(batch.details?.sessionName, "shared");
				const lookup = await executeRegisteredTool(two.getTool("agent_browser_source")!, two.ctx, { selector: "#name-input" });
				assert.equal(lookup.isError, false, lookup.content[0]?.text);
				assert.equal(lookup.details?.sessionName, "shared");
				const network = await executeRegisteredTool(two.getTool("agent_browser_network_source")!, two.ctx, { filter: "fixture" });
				assert.equal(network.isError, false, network.content[0]?.text);
				assert.equal(network.details?.sessionName, "shared");
				const code = await executeRegisteredTool(two.getTool("agent_browser_code")!, two.ctx, { code: `const marker = await browser({args:["eval","--stdin"],stdin:'localStorage.getItem("fixture-marker")'}); emit({success:marker.success, data:marker.data});` });
				assert.equal(code.isError, false, code.content[0]?.text);
				assert.match(JSON.stringify(code.details?.data), /kept/);
				assert.equal(code.details?.sessionName, "shared");
				assert.equal(await readFile(pidPath, "utf8"), pid, "helpers and code must not restart or close the shared daemon");
				await runExtensionEvent(two.handlers, "session_shutdown", { reason: "quit" }, two.ctx);
				assert.equal(await readFile(pidPath, "utf8"), pid, "transcript replay must not claim shared-browser quit ownership");
			} finally {
				await executeRegisteredTool(two.tool, two.ctx, { args: ["--namespace", "team", "--session", "shared", "close"] });
				await runExtensionEvent(one.handlers, "session_shutdown", { reason: "quit" }, one.ctx);
				await runExtensionEvent(two.handlers, "session_shutdown", { reason: "quit" }, two.ctx);
			}
		});
	} finally {
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	}
});
