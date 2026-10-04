import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness, executeRegisteredTool, readInvocationLog, runExtensionEvent,
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
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null, actionPolicy: process.env.AGENT_BROWSER_ACTION_POLICY ?? null, confirmActions: process.env.AGENT_BROWSER_CONFIRM_ACTIONS ?? null, debug: process.env.AGENT_BROWSER_DEBUG ?? null, noAutoDialog: process.env.AGENT_BROWSER_NO_AUTO_DIALOG ?? null }) + "\\n");
const data = args.includes("snapshot") ? { snapshot: "- button \\"Continue\\" [ref=e1]", refs: { e1: { role: "button", name: "Continue" } }, url: "https://fixture.test/" } : { title: "Fixture", url: "https://fixture.test/" };
console.log(JSON.stringify({ success: true, data }));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PATH: `${root}${delimiter}${process.env.PATH}`, AGENT_BROWSER_SESSION: "shared", AGENT_BROWSER_NAMESPACE: "Team Work", AGENT_BROWSER_DEBUG: "1", AGENT_BROWSER_NO_AUTO_DIALOG: "0", PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" }, async () => {
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
			const override = await executeRegisteredTool(two.tool, two.ctx, { args: ["--namespace", "", "--session", "override", "--idle-timeout", "42", "--action-policy", "old.json", "--action-policy", "policy.json", "--confirm-actions", "click", "--confirm-actions", "navigate", "--debug", "true", "--debug", "false", "--no-auto-dialog", "false", "--no-auto-dialog", "true", "get", "title"] });
			assert.equal(override.isError, false, override.content[0]?.text);
			assert.equal(override.details?.sessionName, "override");
			assert.equal(override.details?.namespace, "");
			assert.equal((await executeRegisteredTool(one.tool, one.ctx, { args: ["get", "title"] })).isError, false);
			await runExtensionEvent(one.handlers, "session_shutdown", { reason: "quit" }, one.ctx);
			await runExtensionEvent(two.handlers, "session_shutdown", { reason: "quit" }, two.ctx);
			const calls = await readInvocationLog(log) as Array<{ args: string[]; idleTimeout: string | null; actionPolicy: string | null; confirmActions: string | null; debug: string | null; noAutoDialog: string | null }>;
			assert.ok(calls.some((call) => call.args.includes("url")), "caller-owned live target helpers run");
			assert.ok(calls.every((call) => call.idleTimeout === (call.args.includes("override") ? "42" : null)), "native idle selection is consistent across caller-owned helpers and main calls");
			assert.ok(calls.filter(call => call.args.includes("override")).some(call => call.args.includes("url")), "explicit policy call reaches its live page helper");
			assert.ok(calls.every(call => call.actionPolicy === (call.args.includes("override") ? "policy.json" : null) && call.confirmActions === (call.args.includes("override") ? "navigate" : null)), "last explicit policy values reach every helper without leaking into later calls");
			assert.ok(calls.every(call => call.debug === (call.args.includes("override") ? null : "1") && call.noAutoDialog === (call.args.includes("override") ? "1" : "0")), "explicit last-wins booleans reach helpers; later calls keep inherited values");
			assert.ok(calls.every((call) => !call.args.includes("close")), "Pi quit leaves shared caller-owned browser alone");
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit fresh sessions retain ownership and idle cleanup", async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbs-owned-"));
	const log = join(root, "calls.jsonl");
	await writeFakeAgentBrowserBinary(root, `
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null, confirmActions: process.env.AGENT_BROWSER_CONFIRM_ACTIONS ?? null }) + "\\n");
console.log(JSON.stringify({ success: true, data: { title: "Fixture", url: "about:blank" } }));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PATH: `${root}${delimiter}${process.env.PATH}`, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--confirm-actions", "navigate", "open", "about:blank"], sessionMode: "fresh" });
			assert.equal(result.isError, false, result.content[0]?.text);
			assert.equal((result.details?.managedSessionOutcome as { activeAfter?: boolean })?.activeAfter, true);
			const fresh = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "about:blank"], sessionMode: "fresh" });
			assert.equal(fresh.isError, false, fresh.content[0]?.text);
			assert.notEqual(fresh.details?.sessionName, result.details?.sessionName, "fresh still rotates unconfigured implicit sessions");
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
			const calls = await readInvocationLog(log) as Array<{ args: string[]; idleTimeout: string; confirmActions: string | null }>;
			assert.ok(calls.some((call) => call.args.includes("close")));
			assert.ok(calls.every((call) => call.idleTimeout === "900000"));
			assert.deepEqual(calls.filter(call => call.args.includes("open")).map(call => call.confirmActions), ["navigate", null], "replacement starts a new policy lifecycle");
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("confirmation policy follows canonical session lifecycle, replay and native precedence", async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbs-confirm-"));
	const log = join(root, "calls.jsonl");
	const config = join(root, "native.json");
	await writeFile(config, JSON.stringify({ confirmActions: "tab_new" }));
	await writeFakeAgentBrowserBinary(root, `
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, confirmActions: process.env.AGENT_BROWSER_CONFIRM_ACTIONS ?? null }) + "\\n");
const page = { title: "Fixture", url: "https://fixture.test/" };
const data = args.includes("tab") && args.includes("list") ? { tabs: [{ ...page, active: true, index: 0, tabId: "t1" }] } : { ...page, session: "default" };
console.log(JSON.stringify({ success: !(args.includes("close") && process.env.FAIL_CLOSE === "1"), data }));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PATH: `${root}${delimiter}${process.env.PATH}`, PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" }, async () => {
			const one = createExtensionHarness({ cwd: root, sessionId: "confirmation-owner" });
			const prefix = ["--namespace", "Team Space", "--session", "selected"];
			const check = async (harness: typeof one, args: string[], expected: string | null) => {
				await writeFile(log, "");
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
				const calls = await readInvocationLog(log) as Array<{ args: string[]; confirmActions: string | null }>;
				const browserCalls = calls.filter(call => !call.args.includes("--version") && !(call.args.includes("session") && call.args.includes("--config")));
				assert.ok(browserCalls.length > 0, result.content[0]?.text);
				assert.ok(browserCalls.every(call => call.confirmActions === expected), JSON.stringify(browserCalls));
				return result;
			};
			assert.equal((await check(one, [...prefix, "--confirm-actions", "click", "--confirm-actions", "navigate", "get", "title"], "navigate")).isError, false);
			assert.ok((await readInvocationLog(log)).some(call => call.args.includes("url")), "settings reach the hidden live-page helper");
			await check(one, ["--namespace", "team-space", "--session", "selected", "get", "title"], "navigate");
			const resumed = createExtensionHarness({ cwd: root, sessionId: "confirmation-owner", branch: one.ctx.sessionManager.getBranch().slice() });
			await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
			await check(resumed, [...prefix, "get", "title"], "navigate");
			await check(resumed, ["--namespace", "other", "--session", "selected", "get", "title"], null);
			await check(resumed, ["--namespace", "other", "--session", "selected", "--confirm-actions", "tab_new", "get", "title"], "tab_new");
			await check(resumed, [...prefix.slice(0, 2), "--session", "unrelated", "get", "title"], null);
			await check(resumed, [...prefix, "--config", config, "get", "title"], "tab_new");
			await withPatchedEnv({ AGENT_BROWSER_CONFIRM_ACTIONS: "recording_restart" }, async () => {
				await check(resumed, [...prefix, "get", "title"], "tab_new");
				await check(resumed, [...prefix, "--config", config, "get", "title"], "recording_restart");
				await check(resumed, [...prefix, "--confirm-actions", "", "get", "title"], "");
			});
			await check(resumed, [...prefix, "get", "title"], "");
			await check(resumed, [...prefix, "--confirm-actions", "navigate", "get", "title"], "navigate");
			await writeFile(log, "");
			const code = await executeRegisteredTool(resumed.getTool("agent_browser_code")!, resumed.ctx, {
				session: "selected", namespace: "team-space", code: 'emit((await browser({args:["get","title"]})).success);',
			});
			assert.equal(code.isError, false, code.content[0]?.text);
			assert.ok((await readInvocationLog(log) as Array<{ args: string[]; confirmActions: string }>).every(call => call.confirmActions === "navigate"));
			await writeFile(log, "");
			const qa = await withPatchedEnv({ AGENT_BROWSER_SESSION: "selected", AGENT_BROWSER_NAMESPACE: "team-space" }, () =>
				executeRegisteredTool(resumed.getTool("agent_browser_qa")!, resumed.ctx, { attached: true, checkErrors: false, checkConsole: false, checkNetwork: false }));
			assert.equal(qa.isError, false, qa.content[0]?.text);
			assert.ok((await readInvocationLog(log) as Array<{ args: string[]; confirmActions: string }>).every(call => call.confirmActions === "navigate"));
			await withPatchedEnv({ FAIL_CLOSE: "1" }, async () => assert.equal((await check(resumed, [...prefix, "close"], "navigate")).isError, true));
			await check(resumed, [...prefix, "get", "title"], "navigate");
			assert.equal((await check(resumed, [...prefix, "close"], "navigate")).isError, false);
			await check(resumed, [...prefix, "get", "title"], null);
			await check(resumed, [...prefix, "--confirm-actions", "navigate", "get", "title"], "navigate");
			await check(resumed, [...prefix, "close", "--all"], "navigate");
			await check(resumed, [...prefix, "get", "title"], null);
			await check(resumed, ["--namespace", "other", "--session", "selected", "get", "title"], "tab_new");
			await check(resumed, [...prefix, "--confirm-actions", "navigate", "get", "title"], "navigate");
			resumed.setBranch([]);
			await runExtensionEvent(resumed.handlers, "session_tree", {}, resumed.ctx);
			await check(resumed, [...prefix, "get", "title"], null);
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const [enabled, oppositeDefaults] of [[true, true], [false, true], [false, false]]) {
	test(`real native helper booleans preserve the page and daemon: ${enabled} (${oppositeDefaults ? "opposite defaults" : "clean"})`, { skip: process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1", timeout: 120_000 }, async () => {
		const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbs-bool-"));
		const fixture = await startAgentBrowserContractFixtureServer();
		const socketDir = join(root, "s");
		const config = join(root, "native.json");
		await writeFile(config, JSON.stringify({ debug: oppositeDefaults && !enabled, noAutoDialog: oppositeDefaults && !enabled }));
		const flags = ["--config", config, "--session", "booleans", "--debug", String(enabled), "--no-auto-dialog", String(enabled)];
		try {
			await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_DEBUG: oppositeDefaults ? enabled ? "0" : "1" : undefined, AGENT_BROWSER_NO_AUTO_DIALOG: oppositeDefaults ? enabled ? "0" : "1" : undefined }, async () => {
				const harness = createExtensionHarness({ cwd: root });
				try {
					const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...flags, "open", fixture.baseUrl] });
					assert.equal(opened.isError, false, opened.content[0]?.text);
					const pidPath = join(socketDir, "booleans.pid");
					const pid = await readFile(pidPath, "utf8");
					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...flags, "snapshot", "-i"] });
					assert.equal(snapshot.isError, false, snapshot.content[0]?.text);
					assert.match(JSON.stringify(snapshot.details?.data), /Mark ready|Name input/);
					assert.equal((snapshot.details?.data as { origin?: string }).origin, fixture.baseUrl + "/");
					assert.equal(await readFile(pidPath, "utf8"), pid, "helper calls retain the exact CLI fingerprint even over opposite config/environment booleans");
					assert.equal(await stat(join(socketDir, "booleans.log")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), enabled, "explicit false disables native debug logging even when env/config defaults enable it");
					const inherited = ["--config", config, "--session", "inherited"];
					assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: [...inherited, "open", fixture.baseUrl] })).isError, false);
					const inheritedPid = await readFile(join(socketDir, "inherited.pid"), "utf8");
					const inheritedSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...inherited, "snapshot", "-i"] });
					assert.match(JSON.stringify(inheritedSnapshot.details?.data), /Mark ready|Name input/);
					assert.equal(await readFile(join(socketDir, "inherited.pid"), "utf8"), inheritedPid, "later calls retain native env/config inheritance without leaked CLI overrides");
					assert.equal(await stat(join(socketDir, "inherited.log")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), oppositeDefaults, "later logging follows native variable-presence semantics, without leaked overrides");
				} finally {
					await executeRegisteredTool(harness.tool, harness.ctx, { args: [...flags, "close"] });
					await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--config", config, "--session", "inherited", "close"] });
				}
			});
		} finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
	});
}

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
			const bootstraps = calls.filter(call => call.args.includes("get") && call.args.includes("title") && call.profile === "Default");
			assert.equal(bootstraps.length, 2, "each root launches with its profile once; active daemons retain their own launch settings");
			for (const call of calls) {
				assert.ok(!call.args.includes("close"), "neither parent nor child exit owns group teardown");
				const name = call.args[call.args.indexOf("--session") + 1];
				assert.equal(call.restore, name === "unrelated" ? null : name);
				if (name === "unrelated") assert.equal(call.profile, null);
			}
			const profiled = await executeRegisteredTool(one.tool, one.ctx, { args: ["--profile", "Profile 1", "open", "https://fixture.test/"] });
			assert.equal(profiled.isError, false, profiled.content[0]?.text);
			assert.equal(profiled.details?.sessionName, a.details?.sessionName, "profile flags do not split a root group");
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("root Chrome bootstrap defaults follow effective engine without replacing native launch settings", async t => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pbs-engine-"));
	const log = join(root, "calls.jsonl");
	const packageConfig = join(root, "package-config.json");
	const nativeConfig = join(root, "agent-browser.json");
	await writeFile(packageConfig, JSON.stringify({ browser: { defaultProfile: { name: "Default", policy: "always" }, executablePath: "/wrapper/chrome" } }));
	await writeFakeAgentBrowserBinary(root, `
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, profile: process.env.AGENT_BROWSER_PROFILE ?? null, executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? null, engine: process.env.AGENT_BROWSER_ENGINE ?? null, config: JSON.parse(require("node:fs").readFileSync(${JSON.stringify(nativeConfig)}, "utf8")) }) + "\\n");
console.log(JSON.stringify({ success: true, data: { session: "default", title: "Fixture", url: "https://fixture.test/" } }));
`);
	try {
		await withPatchedEnv({ ...clearedBrowserEnv, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PATH: `${root}${delimiter}${process.env.PATH}`, PI_AGENT_BROWSER_CONFIG: packageConfig, PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_ROOT_SESSION_ID: undefined }, async () => {
			for (const scenario of [
				{ name: "default Chrome", args: [], config: {}, env: {}, defaults: true },
				{ name: "CLI Lightpanda", args: ["--engine", "lightpanda"], config: {}, env: {} },
				{ name: "environment Lightpanda", args: [], config: {}, env: { AGENT_BROWSER_ENGINE: "lightpanda" } },
				{ name: "native config Lightpanda", args: [], config: { engine: "lightpanda" }, env: {} },
				{ name: "CLI Chrome beats environment Lightpanda", args: ["--engine", "chrome"], config: {}, env: { AGENT_BROWSER_ENGINE: "lightpanda" }, defaults: true },
				{ name: "environment Chrome beats config Lightpanda", args: [], config: { engine: "lightpanda" }, env: { AGENT_BROWSER_ENGINE: "chrome" }, defaults: true },
				{ name: "CLI Lightpanda beats environment Chrome", args: ["--engine", "lightpanda"], config: {}, env: { AGENT_BROWSER_ENGINE: "chrome" } },
				{ name: "last CLI engine wins", args: ["--engine", "chrome", "--engine", "lightpanda"], config: {}, env: {} },
				{ name: "caller CLI settings", args: ["--engine", "lightpanda", "--profile", "Caller", "--executable-path", "/caller/browser"], config: {}, env: {}, caller: true },
				{ name: "caller environment settings", args: [], config: {}, env: { AGENT_BROWSER_ENGINE: "lightpanda", AGENT_BROWSER_PROFILE: "Caller", AGENT_BROWSER_EXECUTABLE_PATH: "/caller/browser" }, caller: true },
				{ name: "caller native config settings", args: [], config: { engine: "lightpanda", profile: "Caller", executablePath: "/caller/browser" }, env: {} },
				{ name: "unrelated explicit Chrome session", args: ["--session", "unrelated"], config: {}, env: {} },
			]) {
				await t.test(scenario.name, async () => {
					await writeFile(nativeConfig, JSON.stringify(scenario.config));
					await writeFile(log, "");
					await withPatchedEnv({ AGENT_BROWSER_ENGINE: undefined, AGENT_BROWSER_PROFILE: undefined, AGENT_BROWSER_EXECUTABLE_PATH: undefined, ...scenario.env }, async () => {
						const harness = createExtensionHarness({ cwd: root, sessionId: scenario.name });
						const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...scenario.args, "open", "https://fixture.test/"] });
						assert.equal(result.isError, false, result.content[0]?.text);
						const calls = await readInvocationLog(log) as Array<{ args: string[]; profile: string | null; executablePath: string | null; engine: string | null; config: unknown }>;
						const main = calls.find(call => call.args.includes("open"));
						assert.ok(main, "the requested browser call reached upstream");
						assert.equal(main.profile, scenario.defaults ? "Default" : scenario.caller ? "Caller" : null);
						assert.equal(main.executablePath, scenario.defaults ? "/wrapper/chrome" : scenario.caller ? "/caller/browser" : null);
						assert.equal(main.engine, scenario.env.AGENT_BROWSER_ENGINE ?? null, "caller engine environment is unchanged");
						assert.deepEqual(main.config, scenario.config, "native configuration remains unchanged");
						assert.deepEqual(main.args.slice(-scenario.args.length - 2), [...scenario.args, "open", "https://fixture.test/"], "caller argv remains unchanged");
						if (!scenario.defaults && !scenario.caller) assert.ok(calls.every(call => call.profile === null && call.executablePath === null), "helpers do not receive wrapper Chrome defaults either");
						await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
					});
				});
			}
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
				two.setBranch(one.ctx.sessionManager.getBranch().slice());
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
