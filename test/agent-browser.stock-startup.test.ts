import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { withNativeSessionDefaults } from "../extensions/agent-browser/lib/orchestration/native-session-defaults.js";
import { resolveAgentBrowserInput } from "../extensions/agent-browser/lib/orchestration/input-plan.js";
import { getUpstreamEffectiveBatchSteps } from "../extensions/agent-browser/lib/orchestration/batch-stdin.js";
import { parseArgvDescriptor } from "../extensions/agent-browser/lib/argv-descriptor.js";
import { createExtensionHarness, executeRegisteredTool, readInvocationLog, startAgentBrowserContractFixtureServer, withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

async function cdp(url: string, method: string): Promise<any> {
	const socket = new WebSocket(url);
	try {
		return await new Promise((resolve, reject) => {
			socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method })));
			socket.addEventListener("error", reject);
			socket.addEventListener("message", event => {
				const response = JSON.parse(String(event.data));
				if (response.id === 1) response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result);
			});
		});
	} finally { socket.close(); }
}

const stockVersion = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1" ? execFileSync("agent-browser", ["--version"], { encoding: "utf8" }).trim() : undefined;

const resolve = (args: string[], stdin?: string) => resolveAgentBrowserInput({ params: { args, stdin }, getBatchPreflightValidationError: () => undefined });

test("URL-less open uses native lazy launch without inventing navigation or hiding effective commands", () => {
	const requested = ["--session", "existing", "open", "--headed", "false"];
	const result = resolve(requested);
	assert.deepEqual(result.redactedArgs, requested);
	assert.deepEqual(result.toolArgs, ["--session", "existing", "get", "url", "--headed", "false"]);
	assert.deepEqual(resolve(["open", "about:blank"]).toolArgs, ["open", "about:blank"]);
	assert.deepEqual(resolve(["goto"]).toolArgs, ["goto"]);
	assert.deepEqual(resolve(["open", "--help"]).toolArgs, ["open", "--help"]);
	const ignored = JSON.stringify([["open"]]);
	assert.equal(resolve(["batch", ""], ignored).toolStdin, ignored, "even an empty raw command displaces stdin");
	assert.equal(resolve(["open", "--no-sandbox"]).status, "invalid");
});

test("startup arguments follow native precedence and exclude external engines and attachments", async t => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "psa-"));
	await writeFakeAgentBrowserBinary(root, `console.log(JSON.stringify({success:true,data:{session:'default'}}));`);
	try {
		await writeFile(join(root, "agent-browser.json"), JSON.stringify({ args: "--config-argument" }));
		const cleared = Object.fromEntries(Object.keys(process.env).filter(name => name.startsWith("AGENT_BROWSER_")).map(name => [name, undefined]));
		await withPatchedEnv({ ...cleared, HOME: root, USERPROFILE: root, PATH: `${root}${delimiter}${process.env.PATH}` }, async () => {
			const check = async (args: string[], expected: string | undefined, stdin?: string, expectedRoot?: boolean) => {
				const input = resolve(args, stdin);
				assert.equal(input.status, "valid");
				if (input.status !== "valid") throw Error("invalid test input");
				await withNativeSessionDefaults(input, root, undefined, async (planned, withLaunchDefaults) => {
					assert.equal(planned.chromeStartupArgs, expected, args.join(" "));
					if (expectedRoot !== undefined) {
						assert.equal(planned.toolArgs[0] === "--session", expectedRoot, "automatic root identity follows native attachment selection");
						assert.equal(typeof withLaunchDefaults === "function", expectedRoot);
						if (expectedRoot) assert.match(planned.toolArgs[1], /^pi-root-[a-f0-9]{24}$/);
					}
					return { content: [], details: {} };
				}, expectedRoot === undefined ? undefined : { id: "startup-precedence" });
			};
			await check(["open"], "--no-startup-window,--config-argument");
			await withPatchedEnv({ AGENT_BROWSER_ARGS: "--env-argument" }, async () => {
				await check(["open"], "--no-startup-window,--env-argument");
				await check(["--args", "--argv-argument", "open"], "--no-startup-window,--argv-argument");
			});
			for (const args of [["connect", "9222"], ["--cdp", "9222", "open"], ["--auto-connect", "open"], ["--provider", "kernel", "open"], ["--engine", "lightpanda", "open"], ["batch", "batch 'connect 9222'"]]) await check(args, undefined);
			await withPatchedEnv({ AGENT_BROWSER_AUTO_CONNECT: "true" }, async () => {
				await check(["open"], undefined);
				await check(["--auto-connect", "false", "open"], "--no-startup-window,--config-argument");
			});
			await check(["batch", "batch open"], "--no-startup-window,--config-argument");
			await check(["batch"], undefined, JSON.stringify([["connect", "9222"]]));
			await writeFile(join(root, "agent-browser.json"), JSON.stringify({ args: "--config-argument", autoConnect: true }));
			await t.test("CLI false overrides configured and environment auto-connect and keeps the local root", async () => {
				await withPatchedEnv({ AGENT_BROWSER_AUTO_CONNECT: "true" }, () => check(["--auto-connect", "false", "open"], "--no-startup-window,--config-argument", undefined, true));
			});
			await t.test("environment false does not disable native configured auto-connect", async () => {
				await withPatchedEnv({ AGENT_BROWSER_AUTO_CONNECT: "false" }, () => check(["open"], undefined, undefined, false));
			});
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["stdin", "raw"] as const) test(`URL-less batch opens preserve ${mode} precedence and literal/nested commands`, () => {
	const rows = [["open"], ["fill", "#field", "open"], ["batch", "open"], ["open", "https://example.com"]];
	const stdin = JSON.stringify(mode === "stdin" ? rows : [["open", "ignored"]]);
	const args = mode === "stdin" ? ["batch", "--bail"] : ["batch", "--bail", "open", "fill '#field' open", "batch open", "open https://example.com"];
	const result = resolve(args, stdin);
	assert.equal(result.status, "valid");
	assert.deepEqual(getUpstreamEffectiveBatchSteps(parseArgvDescriptor(result.toolArgs).upstreamCommandTokens, result.toolStdin), [["get", "url"], rows[1], ["batch", "'get' 'url'"], rows[3]]);
	if (mode === "raw") assert.equal(result.toolStdin, stdin, "ignored stdin is unchanged");
});

for (const mode of ["root", "explicit", "fresh"] as const) test(`Chrome startup default is bootstrap-only for ${mode} and preserves custom arguments`, async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pss-"));
	const log = join(root, "calls.jsonl");
	await writeFakeAgentBrowserBinary(root, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const active = ${JSON.stringify(join(root, "active"))};
if (args.at(-1) === 'session') { console.log(JSON.stringify({success:true,data:{session:'default'}})); process.exit(0); }
if (args.includes('info')) { console.log(JSON.stringify({success:true,data:{active:fs.existsSync(active),runtime:{restoreKey:null}}})); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, launchArgs: args.includes('--args') ? args[args.lastIndexOf('--args') + 1] : null}) + '\\n');
fs.writeFileSync(active, '1');
console.log(JSON.stringify({success:true,data:{url:'https://fixture.test/', title:'Fixture'}}));
`);
	try {
		const cleared = Object.fromEntries(Object.keys(process.env).filter(name => name.startsWith("AGENT_BROWSER_") || name.startsWith("PI_AGENT_BROWSER_")).map(name => [name, undefined]));
		await writeFile(join(root, "agent-browser.json"), JSON.stringify({ args: "--disable-gpu" }));
		await withPatchedEnv({ ...cleared, HOME: root, USERPROFILE: root, PATH: `${root}${delimiter}${process.env.PATH}`, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1", PI_AGENT_BROWSER_TEST_PRESERVE_INTERNAL_LAUNCH_FLAGS: "1", PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0", PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_ROOT_SESSION_ID: undefined }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			const prefix = mode === "explicit" ? ["--session", "local"] : [];
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "open"], ...(mode === "fresh" ? { sessionMode: "fresh" as const } : {}) });
			assert.equal(opened.isError, false, opened.content[0]?.text);
			assert.ok((opened.details?.effectiveArgs as string[]).includes("url"));
			const first = (await readInvocationLog(log)).find(call => call.args.includes("url")) as { launchArgs?: string };
			assert.equal(first.launchArgs, "--no-startup-window,--disable-gpu");
			const followup = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "open"] });
			assert.equal(followup.isError, false, followup.content[0]?.text);
			const calls = (await readInvocationLog(log)).filter(call => call.args.includes("url")) as Array<{ launchArgs?: string | null }>;
			assert.equal(calls.at(-1)?.launchArgs, "--no-startup-window,--disable-gpu", "configured arguments remain consistent on active native launches");
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["root", "explicit", "fresh", "config", "env", "initial", "headless"] as const) test(`stock Chrome ${mode}: one page, stable browser/profile and URL-less opens`, { skip: process.env.PI_AGENT_BROWSER_REAL_UPSTREAM !== "1", timeout: 120_000 }, async () => {
	const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "psr-"));
	const fixture = await startAgentBrowserContractFixtureServer();
	const headed = mode !== "headless";
	const profile = join(root, "profile");
	const cleared = Object.fromEntries(Object.keys(process.env).filter(name => name.startsWith("AGENT_BROWSER_") || name.startsWith("PI_AGENT_BROWSER_")).map(name => [name, undefined]));
	try {
		if (mode === "config") await writeFile(join(root, "agent-browser.json"), JSON.stringify({ args: "--disable-gpu,--enable-automation", profile, headed }));
		await withPatchedEnv({ ...cleared, HOME: root, USERPROFILE: root, PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"), ...(mode === "env" ? { AGENT_BROWSER_ARGS: "--disable-gpu,--enable-automation", AGENT_BROWSER_PROFILE: profile, AGENT_BROWSER_HEADED: "true" } : {}), PI_SUBAGENT_CHILD: undefined, PI_SUBAGENT_ROOT_SESSION_ID: undefined }, async () => {
			const harness = createExtensionHarness({ cwd: root, sessionId: "stock-startup-parent", sessionFile: join(root, "fixture-session.jsonl") });
			const prefix = mode === "explicit" || mode === "config" ? ["--session", "stock-local"] : [];
			const call = async (args: string[], extra = {}) => {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, ...args], ...extra });
				assert.equal(result.isError, false, result.content[0]?.text);
				return result;
			};
			try {
				const launch = mode === "config" || mode === "env" ? [] : ["--profile", profile, ...(headed ? [...(mode === "initial" ? [] : ["--args", "--disable-gpu,--enable-automation"]), "--headed"] : [])];
				const opened = await call([...launch, "open", ...(mode === "initial" ? [fixture.baseUrl] : [])], mode === "fresh" ? { sessionMode: "fresh" } : {});
				assert.ok((opened.details?.effectiveArgs as string[]).includes(mode === "initial" ? "open" : "url"));
				assert.equal((opened.details?.data as { url: string }).url, mode === "initial" ? `${fixture.baseUrl}/` : "about:blank");
				const endpoint = ((await call(["get", "cdp-url"])).details?.data as { cdpUrl: string }).cdpUrl;
				const processes = await cdp(endpoint, "SystemInfo.getProcessInfo");
				const pid = processes.processInfo.find((entry: { type: string }) => entry.type === "browser").id;
				if (headed && mode !== "initial") {
					const argv = (await cdp(endpoint, "Browser.getBrowserCommandLine")).arguments as string[];
					assert.ok(argv.includes("--no-startup-window"));
					assert.ok(argv.includes("--disable-gpu"));
					assert.ok(!argv.some(value => value.startsWith("--headless")));
				} else assert.equal((await cdp(endpoint, "Browser.getVersion")).userAgent.includes("HeadlessChrome"), !headed);
				const pages = async () => (await cdp(endpoint, "Target.getTargets")).targetInfos.filter((entry: { type: string }) => entry.type === "page");
				assert.equal((await pages()).length, 1);
				await call(["open", fixture.baseUrl]);
				await call(["eval", "--stdin"], { stdin: "localStorage.setItem('startup-marker','retained'); 'marked'" });
				await call(["open"]);
				await call(["batch", "--bail"], { stdin: JSON.stringify([["open"], ["get", "url"]]) });
				await call(["batch", "--bail", "open", "get url"], { stdin: JSON.stringify([["open", "about:blank"]]) });
				assert.equal(((await call(["get", "url"])).details?.data as { url: string }).url, `${fixture.baseUrl}/`);
				if (mode === "root") await withPatchedEnv({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_ROOT_SESSION_ID: "stock-startup-parent" }, async () => {
					const child = createExtensionHarness({ cwd: root, sessionId: "stock-startup-child" });
					const result = await executeRegisteredTool(child.tool, child.ctx, { args: ["open"] });
					assert.equal(result.isError, false, result.content[0]?.text);
					assert.equal(result.details?.sessionName, opened.details?.sessionName);
				});
				assert.equal(((await call(["eval", "--stdin"], { stdin: "localStorage.getItem('startup-marker')" })).details?.data as { result: unknown }).result, "retained");
				assert.equal((await pages()).length, 1);
				assert.equal((await cdp(endpoint, "SystemInfo.getProcessInfo")).processInfo.find((entry: { type: string }) => entry.type === "browser").id, pid);
				if (mode === "headless") {
					const script = await executeRegisteredTool(harness.tool, harness.ctx, { script: `await browser({args:["open"]}); await browser({args:["open",${JSON.stringify(fixture.baseUrl)}]}); emit((await browser({args:["open"]})).data.url);` });
					assert.equal(script.isError, false, script.content[0]?.text);
					assert.equal(script.details?.data, `${fixture.baseUrl}/`);
					assert.equal((script.details?.scriptSession as { cleanup: string }).cleanup, "closed");
				}
				console.log(JSON.stringify({ mode, stockVersion, browserPid: pid, pageCount: 1, headed, customArgsRetained: !["initial", "headless"].includes(mode), storageRetained: true, url: `${fixture.baseUrl}/` }));
			} finally { await call(["close"]); }
		});
	} finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
