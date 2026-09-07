import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import {
	type AgentBrowserToolParams,
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const rememberedUrl = "http://127.0.0.1:43210/remembered/page";
const chosenUrl = "http://127.0.0.1:43210/chosen";
const hashRouteUrl = "http://127.0.0.1:43210/app#/reports/weekly?range=7d";

type Page = {
	call: (params: AgentBrowserToolParams) => ReturnType<typeof executeRegisteredTool>;
	calls: () => ReturnType<typeof readInvocationLog>;
	patch: (patch: Record<string, unknown>) => Promise<void>;
	reload: () => Promise<void>;
	state: () => Promise<{ active: boolean; browser: boolean; url: string }>;
	tree: () => Promise<void>;
	url: string;
};

async function withPage(run: (page: Page) => Promise<void>, options: { live?: boolean; url?: string; explicit?: boolean; attached?: boolean; restoreDisabled?: boolean } = {}): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "cb-"));
	const cwd = join(root, "g");
	const home = join(root, "h");
	const logPath = join(root, "calls.jsonl");
	const statePath = join(root, "browser.json");
	const url = options.url ?? rememberedUrl;
	await Promise.all([cwd, home].map((path) => mkdir(path, { mode: 0o700 })));
	execFileSync("git", ["init", "-q", cwd]);
	// Native 0.36: session info is local, HTTP read starts only the daemon, tab list launches the browser.
	await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
const args = process.argv.slice(2), stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + '\\n');
let state = { active: false, browser: false, url: 'about:blank', restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8')); } catch {}
const tokens = [];
for (let i = 0; i < args.length; i++) {
  if (['--session', '--namespace', '--headers', '--user-agent'].includes(args[i])) i++;
  else if (!['--json', '--no-pin-tab'].includes(args[i])) tokens.push(args[i]);
}
function urlOperand(row) {
  for (let i = 1; i < row.length; i++) {
    if (['--filter', '--timeout', '--llms', '--tags', '--selector', '-s'].includes(row[i])) i++;
    else if (!row[i].startsWith('--')) return row[i];
  }
}
function execute(row) {
  const [command, subcommand] = row;
  if (command === 'session') return { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null };
  if (['close', 'quit', 'exit'].includes(command)) { state = { ...state, active: false, browser: false, url: 'about:blank', restoreKey: null }; return { closed: true }; }
  if (!state.active) { state.active = true; state.restoreKey = process.env.AGENT_BROWSER_RESTORE ?? null; }
  const explicitRead = command === 'read' && urlOperand(row) !== undefined;
  if (!explicitRead && !state.browser) { state.browser = true; state.url = ${JSON.stringify(new URL(url).origin + "/")}; }
  if (state.failNext === command) { delete state.failNext; throw new Error('Fixture command failed'); }
  if (command === 'not-a-command') throw new Error('Unknown command: not-a-command');
  if (explicitRead) return { content: 'HTTP-only read', source: 'http', url: urlOperand(row) };
  if (['open', 'goto', 'navigate', 'a11y', 'vitals', 'web-vitals'].includes(command)) state.url = urlOperand(row) ?? (command === 'open' ? 'about:blank' : state.url);
  if (command === 'connect' || (command === 'state' && subcommand === 'load')) { state.url = ${JSON.stringify(chosenUrl)}; return { connected: true }; }
  if (command === 'pushstate') state.url = new URL(row[1], state.url).href;
  if (command === 'diff' && subcommand === 'url') { state.url = row[3]; return { url1: row[2], url2: row[3], diff: 'Different pages' }; }
  if (command === 'window' && subcommand === 'new') { state.url = 'about:blank'; return { tabId: 't2', total: 2 }; }
  if (command === 'tab') {
    if (subcommand === undefined || subcommand === 'list') return { tabs: [{ tabId: 't1', active: true, title: 'Page', url: state.url }] };
    state.url = subcommand === 'new' ? row[2] ?? 'about:blank' : ${JSON.stringify(chosenUrl)};
    return { tabId: 't2' };
  }
  if (command === 'record') { if (row[3] !== undefined) state.url = row[3]; return { path: row[2], started: true }; }
  if (command === 'snapshot') return { origin: state.url, snapshot: '- textbox "' + (state.refName ?? 'Name') + '" [ref=e1]', refs: { e1: { role: 'textbox', name: state.refName ?? 'Name' } } };
  if (command === 'read') return { content: 'Rendered page', source: 'browser', url: state.url };
  if (command === 'network') return { requests: [] };
  if (command === 'console') return { messages: [] };
  if (command === 'errors') return { errors: [] };
  if (command === 'fill') { state.value = row[2]; return { filled: row[1] }; }
  if (command === 'get' && subcommand === 'value') return { value: state.value ?? '' };
  if (command === 'get' && subcommand === 'title') return { title: 'Page' };
  return { title: 'Page', url: state.url };
}
function result(row) {
  try { return { command: row, success: true, result: { ...execute(row), lifecycle: { effectiveLaunch: { browserLaunched: state.browser } } } }; }
  catch (error) { return { command: row, success: false, error: error.message }; }
}
let output, failed;
if (tokens[0] === 'batch') {
  const raw = tokens.slice(1).filter((token) => token !== '--bail');
  const rows = raw.length ? raw.map((row) => row.split(' ')) : JSON.parse(stdin);
  output = [];
  for (const row of rows) { const entry = result(row); output.push(entry); if (!entry.success && tokens.includes('--bail')) break; }
  failed = output.some((entry) => !entry.success);
} else { const entry = result(tokens); output = { success: entry.success, data: entry.result, error: entry.error }; failed = !entry.success; }
fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
process.stdout.write(JSON.stringify(output));
process.exitCode = failed ? 1 : 0;`);
	try {
		await withPatchedEnv({
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			HOME: home, USERPROFILE: home, AGENT_BROWSER_NAMESPACE: "",
			PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
			PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: options.restoreDisabled ? "0" : undefined,
			PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
		}, async () => {
			const branch: unknown[] = [];
			const prefix = ["--namespace", "cold", ...(options.explicit ? ["--session", "caller"] : [])];
			let harness = createExtensionHarness({ branch, cwd });
			const call = async (params: AgentBrowserToolParams) => {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
				branch.push(createToolBranchEntry({ details: result.details!, isError: result.isError }));
				return result;
			};
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			for (const args of [[...prefix, ...(options.attached ? ["connect", "9222"] : ["open", url])], ...(options.attached ? [[...prefix, "get", "url"]] : []), [...prefix, "snapshot", "-i"]]) {
				const result = await call({ args });
				assert.equal(result.isError, false, result.content[0]?.text);
			}
			const restore = async (reason: "quit" | "reload") => {
				await runExtensionEvent(harness.handlers, "session_shutdown", { reason }, harness.ctx);
				harness = createExtensionHarness({ branch: structuredClone(branch), cwd });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			};
			await restore(options.live ? "reload" : "quit");
			await writeFile(logPath, "");
			try {
				await run({
					call: options.explicit ? (params) => call({ ...params, args: [...prefix, ...params.args!] }) : call,
					calls: () => readInvocationLog(logPath),
					patch: async (patch) => writeFile(statePath, JSON.stringify({ ...JSON.parse(await readFile(statePath, "utf8")), ...patch })),
					reload: () => restore("reload"),
					state: async () => JSON.parse(await readFile(statePath, "utf8")),
					tree: async () => { harness.setBranch(structuredClone(branch)); await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx); },
					url,
				});
			} finally {
				await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
			}
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

for (const prefix of [["tab", "list"], ["read", chosenUrl]]) {
	test(`cold reopen survives ${prefix.join(" ")} daemon startup before snapshot`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			const first = await page.call({ args: prefix });
			assert.equal(first.isError, false, first.content[0]?.text);
			assert.equal((await page.state()).active, true);
			assert.equal((await page.state()).browser, prefix[0] === "tab");
			assert.equal((await page.state()).url, prefix[0] === "tab" ? new URL(page.url).origin + "/" : "about:blank");
			assert.equal((await page.calls()).some((row) => row.args.includes("open")), false);
			const snapshot = await page.call({ args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, snapshot.content[0]?.text);
			assert.equal((snapshot.details?.data as { origin: string }).origin, page.url);
			assert.deepEqual((await page.calls()).filter((row) => row.args.includes("open")).map((row) => extractUpstreamCommandTokens(row.args)), [["open", page.url]]);
		});
	});
}

for (const args of [["get", "url"], ["get", "title"], ["reload"], ["back"], ["forward"], ["pushstate", "/route"]]) {
	test(`cold current-page command reopens before ${args.join(" ")}`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			const result = await page.call({ args });
			assert.equal(result.isError, false, result.content[0]?.text);
			const commands = (await page.calls()).map((row) => extractUpstreamCommandTokens(row.args));
			assert.ok(commands.findIndex((row) => row[0] === "open") < commands.findIndex((row) => JSON.stringify(row) === JSON.stringify(args)), JSON.stringify(commands));
			assert.deepEqual(commands.filter((row) => row[0] === "open"), [["open", page.url]]);
		});
	});
}

for (const prefix of [["tab", "list"], ["read", "--timeout", "100", chosenUrl], ["console", "--clear"]]) {
	test(`cold reopen persists through non-page ${prefix.join(" ")} and transcript replay`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			const first = await page.call({ args: prefix });
			assert.equal(first.isError, false, first.content[0]?.text);
			assert.equal((await page.state()).active, true, "non-page calls may start the daemon");
			assert.equal((await page.calls()).some((row) => row.args.includes("open")), false);
			await page.tree();
			await page.reload();
			const result = await page.call({ args: ["get", "url"] });
			assert.equal(result.isError, false, result.content[0]?.text);
			assert.equal((result.details?.data as { url: string }).url, page.url);
			const snapshot = await page.call({ args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, snapshot.content[0]?.text);
			assert.equal((snapshot.details?.data as { origin: string }).origin, page.url);
			assert.deepEqual((await page.calls()).filter((row) => row.args.includes("open")).map((row) => extractUpstreamCommandTokens(row.args)), [["open", page.url]]);
		});
	});
}

for (const prefix of [["tab", "list"], ["read", "--timeout", "100", chosenUrl], ["session", "info"], ["console", "--clear"]]) {
	test(`cold batch finds the page dependency after ${prefix.join(" ")}`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			const stdin = JSON.stringify([prefix, ["snapshot", "-i"]]);
			const result = await page.call({ args: ["batch", "--bail"], stdin });
			assert.equal(result.isError, false, result.content[0]?.text);
			assert.equal((result.details?.data as Array<{ result: { origin?: string } }>).at(-1)?.result.origin, page.url);
			const calls = await page.calls();
			assert.equal(calls.filter((row) => row.args.includes("batch")).length, 1);
			assert.equal(calls.find((row) => row.args.includes("batch"))?.stdin, stdin);
			assert.deepEqual(calls.filter((row) => row.args.includes("open")).map((row) => extractUpstreamCommandTokens(row.args)), [["open", page.url]]);
		});
	});
}

for (const boundary of [["open", chosenUrl], ["close"], ["tab", "new", chosenUrl], ["state", "load", "fixture.json"]]) {
	test(`cold batch respects non-page prefixes before ${boundary.join(" ")}`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			const stdin = JSON.stringify([["tab", "list"], boundary, ["get", "url"]]);
			const result = await page.call({ args: ["batch", "--bail"], stdin });
			assert.equal(result.isError, false, result.content[0]?.text);
			const calls = await page.calls();
			assert.equal(calls.some((row) => extractUpstreamCommandTokens(row.args)[0] === "open"), false, "do not reopen ahead of explicit context changes");
			assert.equal(calls.find((row) => row.args.includes("batch"))?.stdin, stdin);
		});
	});
}

for (const bail of [false, true]) {
	test(`cold preparation preserves native batch error continuation (bail=${bail})`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			const args = ["batch", ...(bail ? ["--bail"] : [])];
			const stdin = JSON.stringify([["tab", "list"], ["not-a-command"], ["snapshot", "-i"]]);
			const result = await page.call({ args, stdin });
			assert.equal(result.isError, true);
			const rows = result.details?.batchSteps as Array<{ command: string[]; success: boolean }>;
			assert.deepEqual(rows.map((row) => row.success), bail ? [true, false] : [true, false, true]);
			const batches = (await page.calls()).filter((row) => row.args.includes("batch"));
			assert.equal(batches.length, 1);
			assert.deepEqual(extractUpstreamCommandTokens(batches[0].args), args);
			assert.equal(batches[0].stdin, stdin);
			if (!bail) assert.equal((result.details?.data as Array<{ result?: { origin?: string } }>).at(-1)?.result?.origin, page.url);
		});
	});
}

for (const params of [{ args: ["snapshot", "-i"] }, { args: ["batch", "--bail"], stdin: JSON.stringify([["tab", "list"], ["snapshot", "-i"]]) }]) {
	test(`cold hash-router URL is reopened intact for ${params.args.join(" ")}`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			const result = await page.call(params);
			assert.equal(result.isError, false, result.content[0]?.text);
			assert.equal((await page.state()).url, hashRouteUrl);
			assert.deepEqual((await page.calls()).filter((row) => extractUpstreamCommandTokens(row.args)[0] === "open").map((row) => extractUpstreamCommandTokens(row.args)), [["open", hashRouteUrl]]);
			assert.equal((result.details?.refSnapshot as { target: { url: string } }).target.url, hashRouteUrl);
		}, { url: hashRouteUrl });
	});
}

test("live hash-only changes retain fragment-insensitive ref freshness checks", { concurrency: false }, async () => {
	await withPage(async (page) => {
		await page.patch({ url: "http://127.0.0.1:43210/app#/other", refName: "Different field" });
		const result = await page.call({ args: ["get", "value", "@e1"] });
		assert.equal(result.details?.failureCategory, "stale-ref");
		assert.equal((await page.calls()).some((row) => row.args.includes("open") || row.args.includes("value")), false);
	}, { live: true, url: hashRouteUrl });
});

test("cold current-URL network filtering reopens before its helper and persists ref invalidation", { concurrency: false }, async () => {
	await withPage(async (page) => {
		const result = await page.call({ args: ["network", "requests", "--current-url"] });
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal((result.details?.networkRequestsPageFilter as { currentUrl: string }).currentUrl, page.url);
		await page.reload();
		const stale = await page.call({ args: ["get", "value", "@e1"] });
		assert.equal(stale.details?.failureCategory, "stale-ref");
		assert.equal((await page.calls()).some((row) => row.args.includes("value")), false);
	});
});

const explicitDestinations = [
	["read", "--timeout", "100", "--filter", "needle", chosenUrl],
	["read", "--llms", "full", chosenUrl],
	["a11y", "--tags", "wcag2a", "-s", "main", chosenUrl],
	["vitals", chosenUrl],
	["web-vitals", chosenUrl],
	["diff", "url", rememberedUrl, chosenUrl, "--selector", "main", "--wait-until", "load"],
	["window", "new"],
	["record", "start", "chosen.webm", chosenUrl],
];
for (const command of explicitDestinations) {
	for (const batch of [false, true]) {
		test(`live missing tab permits explicit destination ${command.join(" ")} (batch=${batch})`, { concurrency: false }, async () => {
			await withPage(async (page) => {
				await page.patch({ url: "http://127.0.0.1:43210/other" });
				const args = batch ? ["batch"] : command;
				const stdin = batch ? JSON.stringify([command]) : undefined;
				const result = await page.call({ args, stdin });
				assert.equal(result.isError, false, result.content[0]?.text);
				const calls = await page.calls();
				const userCalls = calls.filter((row) => extractUpstreamCommandTokens(row.args)[0] === args[0]);
				assert.equal(userCalls.length, 1, "the requested command must actually dispatch");
				assert.deepEqual(extractUpstreamCommandTokens(userCalls[0].args), args);
				if (batch) assert.equal(userCalls[0].stdin, stdin);
				assert.equal(calls.some((row) => extractUpstreamCommandTokens(row.args)[0] === "open"), false);
			}, { live: true });
		});
	}
}

test("live raw explicit URL read ignores unused stdin without old-tab recovery", { concurrency: false }, async () => {
	await withPage(async (page) => {
		await page.patch({ url: "http://127.0.0.1:43210/other" });
		const raw = `read --timeout 100 ${chosenUrl}`;
		const stdin = JSON.stringify([["snapshot", "-i"]]);
		const args = ["--headers", '{"x-fixture":"boundary"}', "--no-pin-tab", "batch", raw];
		const result = await page.call({ args, stdin });
		assert.equal(result.isError, false, result.content[0]?.text);
		const batch = (await page.calls()).find((row) => row.args.includes("batch"));
		assert.ok(batch);
		assert.deepEqual(batch.args.slice(-args.length), args);
		assert.equal(batch.stdin, stdin);
		assert.deepEqual((result.details?.batchSteps as Array<{ command: string[] }>).map((row) => row.command), [["read", "--timeout", "100", chosenUrl]]);
		assert.equal((await page.calls()).some((row) => ["open", "tab", "snapshot"].includes(extractUpstreamCommandTokens(row.args)[0])), false);
	}, { live: true, explicit: true });
});

for (const command of [["network", "requests", "--current-url"], ["read", "--filter", chosenUrl], ["read", "--llms", "full"], ["a11y", "--selector", chosenUrl], ["a11y", "--tags", "wcag2a"], ["vitals"], ["diff", "snapshot"], ["record", "start", "chosen.webm"], ["reload"], ["pushstate", "/route"], ["fill", "#name", "text"]]) {
	test(`live page-dependent ${command.join(" ")} still protects a missing tab`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			await page.patch({ url: "http://127.0.0.1:43210/other" });
			for (const params of [{ args: command }, { args: ["batch"], stdin: JSON.stringify([["read", chosenUrl], command]) }]) {
				const result = await page.call(params);
				assert.equal(result.details?.failureCategory, "tab-drift");
			}
			assert.equal((await page.calls()).some((row) => !["session", "tab"].includes(extractUpstreamCommandTokens(row.args)[0])), false, "neither page actions nor unsolicited navigation may run");
		}, { live: true });
	});
}

for (const options of [{ explicit: true }, { attached: true }, { restoreDisabled: true }]) {
	test(`cold boundary does not navigate outside automatic restore: ${JSON.stringify(options)}`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			await page.call({ args: ["tab", "list"] });
			await page.call({ args: ["snapshot", "-i"] });
			assert.equal((await page.calls()).some((row) => extractUpstreamCommandTokens(row.args)[0] === "open"), false);
		}, options);
	});
}

for (const reachedNavigation of [false, true]) {
	test(`cold pending reopen follows executed batch rows (navigation reached=${reachedNavigation})`, { concurrency: false }, async () => {
		await withPage(async (page) => {
			const tabs = await page.call({ args: ["tab", "list"] });
			assert.equal(tabs.isError, false, tabs.content[0]?.text);
			await page.patch({ failNext: reachedNavigation ? "open" : "console" });
			const result = await page.call({ args: ["batch", "--bail"], stdin: JSON.stringify([["console", "--clear"], ["open", chosenUrl]]) });
			assert.equal(result.isError, true);
			await page.reload();
			await page.call({ args: ["snapshot", "-i"] });
			assert.equal((await page.calls()).filter((row) => extractUpstreamCommandTokens(row.args)[0] === "open").length, reachedNavigation ? 0 : 1, "unreached navigation must not consume the obligation; attempted navigation must not trigger an unsolicited retry");
		});
	});
}
