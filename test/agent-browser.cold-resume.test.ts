import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

type ResumedPage = {
	branch: unknown[];
	harness: ReturnType<typeof createExtensionHarness>;
	logPath: string;
	statePath: string;
	sessionName: string;
	url: string;
};

async function withResumedPage(run: (page: ResumedPage) => Promise<void>, options: { live?: boolean; restoreDisabled?: boolean; explicit?: boolean; attached?: boolean } = {}): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "cold-"));
	const cwd = join(root, "g");
	const home = join(root, "h");
	const logPath = join(root, "calls.jsonl");
	const statePath = join(root, "browser.json");
	const url = "http://127.0.0.1:43210/remembered/page";
	await Promise.all([cwd, home].map((path) => mkdir(path, { mode: 0o700 })));
	execFileSync("git", ["init", "-q", cwd]);
	await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin, namespace: process.env.AGENT_BROWSER_NAMESPACE }) + '\\n');
let state = { active: false, url: 'about:blank', restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8')); } catch {}
let start = 0;
while (args[start]?.startsWith('--')) start += args[start] === '--json' ? 1 : 2;
const tokens = args.slice(start);
function execute(tokens) {
  if (tokens[0] === 'session') return tokens[1] === 'info' ? { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } : { sessions: [] };
  if (tokens[0] === 'close') { state = { active: false, url: 'about:blank', restoreKey: null }; return { closed: true }; }
  if (tokens[0] === 'read' && tokens.some((token) => token.startsWith('http:'))) return { content: 'Fetched page', source: 'http', url: tokens.at(-1) };
  if (!state.active) { state.active = true; state.restoreKey = process.env.AGENT_BROWSER_RESTORE ?? null; }
  if (tokens[0] === 'open' || tokens[0] === 'vitals') state.url = state.redirectUrl ?? tokens[1] ?? 'about:blank';
  if (tokens[0] === 'connect') state.url = ${JSON.stringify(url)};
  if (tokens[0] === 'tab') return { tabs: [{ tabId: 't1', active: true, url: state.url, title: 'Page' }] };
  if (tokens[0] === 'snapshot') return { origin: state.url, snapshot: '- textbox "Name" [ref=e1]', refs: { e1: { role: 'textbox', name: 'Name' } } };
  if (tokens[0] === 'network') return { requests: [] };
  if (tokens[0] === 'console') return { messages: [] };
  if (tokens[0] === 'errors') return { errors: [] };
  if (tokens[0] === 'get' && tokens[1] === 'value') return { value: 'current field' };
  return { url: state.url, title: 'Page' };
}
const data = tokens[0] === 'batch' ? JSON.parse(stdin).map((step) => ({ command: step, success: true, result: execute(step) })) : execute(tokens);
fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
process.stdout.write(JSON.stringify({ success: true, data }));`);
	try {
		await withPatchedEnv({
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			HOME: home,
			USERPROFILE: home,
			AGENT_BROWSER_NAMESPACE: "",
			AGENT_BROWSER_CONFIG: undefined,
			PI_AGENT_BROWSER_SOCKET_DIR: join(root, "s"),
			PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: options.restoreDisabled ? "0" : undefined,
			PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
		}, async () => {
			const branch: unknown[] = [];
			const prefix = ["--namespace", "cold", ...(options.explicit ? ["--session", "caller"] : [])];
			const first = createExtensionHarness({ branch, cwd });
			await runExtensionEvent(first.handlers, "session_start", { reason: "new" }, first.ctx);
			for (const args of [
				[...prefix, ...(options.attached ? ["connect", "9222"] : ["open", url])],
				...(options.attached ? [[...prefix, "get", "url"]] : []),
				[...prefix, "snapshot", "-i"],
			]) {
				const result = await executeRegisteredTool(first.tool, first.ctx, { args });
				assert.equal(result.isError, false, result.content[0]?.text);
				branch.push(createToolBranchEntry({ details: result.details!, isError: result.isError }));
			}
			const sessionName = (branch[0] as { message: { details: { sessionName: string } } }).message.details.sessionName;
			await runExtensionEvent(first.handlers, "session_shutdown", { reason: options.live ? "reload" : "quit" }, first.ctx);
			const harness = createExtensionHarness({ branch: structuredClone(branch), cwd });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			await writeFile(logPath, "");
			try {
				await run({ branch, harness, logPath, statePath, sessionName, url });
			} finally {
				await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
			}
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

for (const params of [
	{ args: ["get", "url"] },
	{ args: ["get", "title"] },
	{ args: ["read"] },
	{ args: ["batch", "--bail"], stdin: JSON.stringify([["get", "url"], ["get", "title"]]) },
]) {
	test(`cold resume reopens before ${params.args.join(" ")} and discards old refs`, { concurrency: false }, async () => {
		await withResumedPage(async ({ harness, logPath, sessionName, url }) => {
			const result = await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "unrelated" }, () => executeRegisteredTool(harness.tool, harness.ctx, params));
			assert.equal(result.isError, false, result.content[0]?.text);
			assert.equal(result.details?.sessionName, sessionName);
			assert.equal(result.details?.namespace, "cold");
			assert.equal((result.details?.sessionTabTarget as { url?: string }).url, url);
			assert.equal(result.details?.refSnapshot, undefined);
			assert.equal((result.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "page-transition");
			const stale = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "value", "@e1"] });
			assert.equal(stale.isError, true);
			assert.equal(stale.details?.failureCategory, "stale-ref");
			const fresh = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(fresh.isError, false, fresh.content[0]?.text);
			assert.equal(fresh.details?.refSnapshotInvalidation, undefined);
			const current = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "value", "@e1"] });
			assert.equal(current.isError, false, current.content[0]?.text);
			const opens = (await readInvocationLog(logPath)).filter((row) => row.args.includes("open"));
			assert.equal(opens.length, 1, "only the first cold read reopens the page");
			assert.deepEqual(opens[0]?.args, ["--json", "--namespace", "cold", "--session", sessionName, "open", url]);
		});
	});
}

test("cold resume preserves explicit navigation and sessionless intent", { concurrency: false }, async (t) => {
	for (const params of [
		{ args: ["open", "http://127.0.0.1:43210/chosen"] },
		{ qa: { url: "http://127.0.0.1:43210/chosen" } },
		{ args: ["batch", "--bail"], stdin: JSON.stringify([["open", "http://127.0.0.1:43210/chosen"], ["snapshot", "-i"]]) },
		{ args: ["read", "--timeout", "100", "http://127.0.0.1:43210/chosen"] },
		{ args: ["vitals", "http://127.0.0.1:43210/chosen"] },
		{ args: ["record", "start", "chosen.webm", "http://127.0.0.1:43210/chosen"] },
		{ args: ["diff", "url", "http://127.0.0.1:43210/one", "http://127.0.0.1:43210/two"] },
		{ args: ["state", "load", "/fixture/state.json"] },
		{ args: ["connect", "9223"] },
		{ args: ["tab", "new"] },
		{ args: ["window", "new"] },
		{ args: ["session", "list"] },
		{ args: ["--version"] },
	]) {
		await t.test(JSON.stringify(params), async () => withResumedPage(async ({ harness, logPath, statePath, url }) => {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
			assert.equal(result.isError, false, result.content[0]?.text);
			assert.equal((await readInvocationLog(logPath)).some((row) => row.args.includes("open") && row.args.includes(url)), false, "the old URL must not be opened ahead of explicit intent");
			if (["read", "session", "--version"].includes(params.args?.[0] ?? "")) {
				assert.equal(JSON.parse(await readFile(statePath, "utf8")).active, false, "a sessionless or explicit HTTP read must not launch a browser");
			}
		}));
	}
});

test("cold resume verifies the reopened page before a read and retains ref invalidation on failure", { concurrency: false }, async () => {
	await withResumedPage(async ({ branch, harness, logPath, statePath }) => {
		const state = JSON.parse(await readFile(statePath, "utf8"));
		await writeFile(statePath, JSON.stringify({ ...state, redirectUrl: "http://127.0.0.1:43210/unexpected" }));
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"] });
		assert.equal(result.isError, true);
		assert.equal(result.details?.resultCategory, "failure");
		assert.equal(result.details?.failureCategory, "tab-drift");
		assert.equal(result.details?.data, undefined);
		assert.equal((result.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "page-transition");
		harness.setBranch([...branch, createToolBranchEntry({ details: result.details!, isError: true })]);
		await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
		const stale = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "value", "@e1"] });
		assert.equal(stale.details?.failureCategory, "stale-ref");
		const retry = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
		assert.equal(retry.details?.failureCategory, "tab-drift");
		const calls = await readInvocationLog(logPath);
		assert.equal(calls.filter((row) => row.args.includes("open")).length, 1, "a failed reopen is not permission to navigate a now-live browser again");
		assert.equal(calls.some((row) => row.args.at(-1) === "title" || row.args.includes("snapshot")), false);
	});
});

test("a live missing tab is not permission to reopen", { concurrency: false }, async () => {
	await withResumedPage(async ({ harness, logPath, statePath }) => {
		const state = JSON.parse(await readFile(statePath, "utf8"));
		assert.equal(state.active, true);
		await writeFile(statePath, JSON.stringify({ ...state, url: "http://127.0.0.1:43210/other" }));
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
		assert.equal(result.isError, true);
		assert.equal(result.details?.failureCategory, "tab-drift");
		assert.equal((await readInvocationLog(logPath)).some((row) => row.args.includes("open") || row.args.includes("snapshot")), false);
	}, { live: true });
});

for (const options of [{ restoreDisabled: true }, { explicit: true }, { attached: true }]) {
	test(`cold resume does not reopen outside automatic managed restore: ${JSON.stringify(options)}`, { concurrency: false }, async () => {
		await withResumedPage(async ({ harness, logPath, sessionName }) => {
			await executeRegisteredTool(harness.tool, harness.ctx, { args: options.explicit ? ["--namespace", "cold", "--session", sessionName, "snapshot", "-i"] : ["snapshot", "-i"] });
			assert.equal((await readInvocationLog(logPath)).some((row) => row.args.includes("open")), false);
		}, options);
	});
}

test("explicit close keeps the recorded URL retired on resume", { concurrency: false }, async () => {
	await withResumedPage(async ({ branch, harness, logPath, sessionName, url }) => {
		const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "cold", "--session", sessionName, "close"] });
		assert.equal(closed.isError, false, closed.content[0]?.text);
		branch.push(createToolBranchEntry({ details: closed.details!, isError: false }));
		harness.setBranch(branch);
		await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
		const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
		assert.equal(read.isError, false, read.content[0]?.text);
		assert.notEqual(read.details?.sessionName, sessionName);
		assert.equal((await readInvocationLog(logPath)).some((row) => row.args.includes("open") && row.args.includes(url)), false);
	});
});
