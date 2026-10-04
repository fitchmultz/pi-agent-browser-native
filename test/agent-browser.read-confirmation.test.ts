import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import { convertBrowserEntries } from "../extensions/agent-browser/lib/browser-session-conversion.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import { createExtensionHarness, createToolBranchEntry, executeRegisteredTool, readInvocationLog, runExtensionEvent, withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

async function withConfirmations(run: (options: { root: string; log: string; state: string; branch: unknown[]; harness: ReturnType<typeof createExtensionHarness> }) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "piab-read-confirm-"));
	const log = join(root, "calls.jsonl"), state = join(root, "native.json");
	await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args }) + '\\n');
const tokens = [];
for (let i = 0; i < args.length; i++) {
  if (['--session', '--namespace', '--confirm-actions', '--profile'].includes(args[i])) i++;
  else if (args[i] !== '--json') tokens.push(args[i]);
}
const sessionName = args.includes('--session') ? args[args.indexOf('--session') + 1] : process.env.AGENT_BROWSER_SESSION ?? 'default';
const namespace = args.includes('--namespace') ? args[args.indexOf('--namespace') + 1] : process.env.AGENT_BROWSER_NAMESPACE ?? '';
let state = { pending: null, browserTouches: 0, domConfirmed: false };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8')); } catch {}
const failedReadResult = { success: false, error: 'HTTP read failed: test response 500' };
function execute(tokens) {
let data, success = true, error;
if (tokens[0] === 'read' && tokens[1] === 'public.test/body') data = { content: JSON.stringify({ confirmation_required: true, confirmation_id: 'read-id', action: 'read', capabilities: { readRequiresConfirmation: true } }), source: 'http' };
else if (tokens[0] === 'read') { state.pending = { id: 'read-id', action: 'read', sessionName, namespace, failure: tokens[1]?.endsWith('failure') === true }; data = { confirmation_required: true, confirmation_id: 'read-id', action: 'read', ...(tokens[1]?.startsWith('public.test/legacy') ? {} : { capabilities: { readRequiresConfirmation: true } }) }; }
else if (tokens[0] === 'webmcp') data = { invocationId: 'pending-job', status: 'pending' };
else if (tokens[0] === 'click' && tokens[1] === '#dispatched') { state.url = 'https://fixture.test/after'; state.gateNextUrl = true; data = { clicked: '#dispatched' }; }
else if (tokens[0] === 'click' || tokens[0] === 'tab' && tokens[1] === 'new' || tokens[0] === 'close' || tokens[0] === 'eval' && tokens[1] === 'throw fixture') {
  const action = tokens[0] === 'tab' ? 'tab_new' : tokens[0] === 'eval' ? 'evaluate' : tokens[0];
  state.pending = { id: 'dom-id', action, sessionName, namespace, failure: action === 'evaluate' };
  data = { confirmation_required: true, confirmation_id: 'dom-id', action };
}
else if (['confirm', 'deny'].includes(tokens[0])) {
  if (!state.pending || state.pending.id !== tokens[1] || state.pending.sessionName !== sessionName || state.pending.namespace !== namespace) { success = false; error = 'Confirmation ID or session mismatch'; }
  else { const pending = state.pending; state.pending = null; if (tokens[0] === 'confirm') {
      if (pending.action === 'click') { state.domConfirmed = true; state.browserTouches++; state.url = 'https://clicked.test/'; }
      if (pending.action === 'tab_new') state.url = 'about:blank';
    }
    data = tokens[0] === 'confirm' ? { confirmed: true, action: pending.action, result: pending.failure ? failedReadResult : { success: true, data: pending.action === 'close' ? { closed: true } : pending.action === 'click' ? { clicked: '#guarded' } : pending.action === 'tab_new' ? { url: 'about:blank' } : { content: 'Confirmed markdown', source: 'http', url: 'https://public.test/' } } } : { denied: true, action: pending.action }; }
} else if (tokens[0] === 'eval') data = { confirmed: true, action: 'read', result: failedReadResult };
else if (tokens[0] === 'open') { state.url = tokens[1]; data = { url: state.url }; }
else if (tokens[0] === 'get' && tokens[1] === 'url' && state.gateNextUrl) { state.gateNextUrl = false; state.pending = { id: 'helper-id', action: 'url', sessionName, namespace }; data = { confirmation_required: true, confirmation_id: 'helper-id', action: 'url' }; }
else if (tokens[0] === 'get' || tokens[0] === 'tab') { state.browserTouches++; data = tokens[0] === 'tab' ? { tabs: [{ url: state.url ?? 'https://current.test/', title: 'Current', tabId: 't1', targetId: 'fixture-target', active: true }] } : { url: state.url ?? 'https://current.test/', title: 'Current' }; }
else data = { active: false, session: sessionName, namespace, runtime: null };
return { success, data, error };
}
const rawRows = tokens.slice(1).filter(token => token !== '--bail');
const rows = tokens[0] === 'batch' ? (rawRows.length ? rawRows.map(row => row.split(' ')) : JSON.parse(fs.readFileSync(0, 'utf8'))).map(command => { const { data, ...result } = execute(command); return { command, ...result, result: data }; }) : undefined;
const result = rows ? { success: rows.every(row => row.success), data: rows } : execute(tokens);
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
process.stdout.write(JSON.stringify(result)); process.exitCode = result.success ? 0 : 1;`);
	try {
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, HOME: root, USERPROFILE: root, AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			const branch: unknown[] = [], harness = createExtensionHarness({ cwd: root, branch, sessionFile: join(root, "session.jsonl") });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			try { await run({ root, log, state, branch, harness }); }
			finally { await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx); }
		});
	} finally { await rm(root, { recursive: true, force: true }); }
}

for (const shared of [false, true]) for (const command of ["confirm", "deny"]) {
	test(`URL-read ${command} stays browserless and targets the real native session (shared=${shared})`, { concurrency: false }, async () => {
		await withConfirmations(async ({ root, log, state, branch, harness }) => {
			const prefix = shared ? ["--namespace", "team", "--session", "shared"] : [];
			const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "--confirm-actions", "read", "read", "public.test/docs"] });
			assert.equal(read.details?.failureCategory, "confirmation-required");
			assert.equal(read.details?.managedSessionOutcome, undefined);
			const action = (read.details?.nextActions as Array<{ id: string; params: { args: string[] } }>).find(action => action.id === (command === "confirm" ? "approve-confirmation" : "deny-confirmation"));
			assert.deepEqual(action?.params.args, ["--namespace", shared ? "team" : "", "--session", shared ? "shared" : "default", command, "read-id"]);
			branch.push(createToolBranchEntry({ details: read.details!, isError: read.isError }));
			const pendingState = SessionPageState.fromBranch(convertBrowserEntries(branch));
			assert.ok(pendingState.findReadConfirmation(["confirm", "read-id"]), JSON.stringify(branch));
			assert.equal(pendingState.findReadConfirmation(["--session", "piab-script-isolated", command, "read-id"], ""), undefined, "an isolated script's explicit identity cannot select a shared read confirmation");
			assert.equal(pendingState.findReadConfirmation(["--namespace", "other", command, "read-id"], "other"), undefined);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "reload" }, harness.ctx);
			harness = createExtensionHarness({ cwd: root, branch });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			await writeFile(log, "");
			const beforeConfirm = structuredClone(harness.ctx.sessionManager.getBranch());
			const confirmed = await executeRegisteredTool(harness.tool, harness.ctx, { args: [command, "read-id"] });
			assert.equal(confirmed.isError, false, confirmed.content[0]?.text);
			assert.equal(confirmed.details?.sessionName, shared ? "shared" : "default");
			assert.equal(confirmed.details?.managedSessionOutcome, undefined);
			assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [[command, "read-id"]]);
			assert.equal(JSON.parse(await readFile(state, "utf8")).browserTouches, 0);
			branch.push(createToolBranchEntry({ details: confirmed.details!, isError: confirmed.isError }));
			assert.equal(SessionPageState.fromBranch(convertBrowserEntries(branch)).findReadConfirmation(["confirm", "read-id"]), undefined);
			assert.equal(SessionPageState.fromBranch(beforeConfirm).findReadConfirmation(["confirm", "read-id"])?.id, "read-id");
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	});
}

for (const command of ["confirm", "deny"]) test(`proven HTTP ${command} preserves an unknown DOM target without page probes`, { concurrency: false }, async () => {
	await withConfirmations(async ({ log, harness }) => {
		const prefix = ["--namespace", "team", "--session", "shared"];
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "click", "#guarded"] });
		const pending = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "webmcp", "invoke", "wait_for_navigation", "--detach"] });
		assert.equal(pending.details?.sessionTabTargetUnknown, true);
		for (const id of ["unproven-id"]) {
			await writeFile(log, "");
			const blocked = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, command, id] });
			assert.equal(blocked.isError, true);
			assert.deepEqual(await readInvocationLog(log), []);
		}
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "read", "public.test/legacy"] });
		await writeFile(log, "");
		const legacy = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, command, "read-id"] });
		assert.equal(legacy.isError, true);
		assert.deepEqual(await readInvocationLog(log), []);
		const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "read", "public.test/docs"] });
		assert.equal(read.details?.failureCategory, "confirmation-required");
		await writeFile(log, "");
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, command, "read-id"] });
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.deepEqual((await readInvocationLog(log)).map(call => call.args), [["--json", ...prefix, command, "read-id"]]);
		assert.equal(result.details?.sessionTabTargetUnknown, true);
		assert.equal(result.details?.sessionTabTarget, undefined);
		assert.equal(result.details?.managedSessionOutcome, undefined);
		await writeFile(log, "");
		const stillUnknown = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "click", "#guarded"] });
		assert.equal(stillUnknown.isError, true);
		assert.match(stillUnknown.content[0]?.text ?? "", /active page became unverified/);
		assert.deepEqual(await readInvocationLog(log), []);
	});
});

test("legacy read confirmation retains native-default routing without the browserless exemption", { concurrency: false }, async () => {
	await withConfirmations(async ({ log, harness }) => {
		const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["read", "public.test/legacy"] });
		assert.equal((read.details?.readConfirmation as { sessionName: string }).sessionName, "default");
		await writeFile(log, "");
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["confirm", "read-id"] });
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(result.details?.sessionName, "default");
		assert.equal(result.details?.managedSessionOutcome, undefined);
		assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["get", "url"], ["confirm", "read-id"]]);
	});
});

for (const legacy of [true, false]) for (const batch of [false, true]) {
	test(`failed confirmed HTTP reads fail truthfully (legacy=${legacy}, batch=${batch})`, { concurrency: false }, async () => {
		await withConfirmations(async ({ root, log, harness }) => {
			const prefix = ["--namespace", "team", "--session", "shared"];
			const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "read", legacy ? "public.test/legacy-failure" : "public.test/failure"] });
			assert.equal(read.details?.failureCategory, "confirmation-required");
			await writeFile(log, "");
			const outputPath = join(root, "failed-read.json");
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "--json", ...(batch ? ["batch"] : ["confirm", "read-id"])], ...(batch ? { stdin: JSON.stringify([["confirm", "read-id"]]) } : {}), outputPath });
			assert.equal(result.isError, true);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(JSON.parse(result.content[0]?.text ?? "").success, false);
			assert.match(result.content[0]?.text ?? "", /HTTP read failed: test response 500/);
			assert.equal((result.details?.readConfirmation as { state: string }).state, "cleared");
			if (batch) assert.equal((result.details?.batchSteps as Array<{ success: boolean }>)[0].success, false);
			assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [...(legacy || batch ? [["get", "url"]] : []), batch ? ["batch"] : ["confirm", "read-id"]]);
			assert.equal(result.details?.outputFile, undefined);
			await assert.rejects(readFile(outputPath), { code: "ENOENT" });
		});
	});
}

test("a stale read ID cannot consume a newer native DOM confirmation or acquire browser ownership", { concurrency: false }, async () => {
	await withConfirmations(async ({ log, state, harness }) => {
		const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "read", "public.test/docs"] });
		assert.equal(read.details?.failureCategory, "confirmation-required");
		const native = JSON.parse(await readFile(state, "utf8"));
		await writeFile(state, JSON.stringify({ ...native, pending: { id: "new-dom-id", action: "click", sessionName: "shared", namespace: "" } }));
		await writeFile(log, "");
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["confirm", "read-id"] });
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /mismatch/);
		assert.equal(result.details?.sessionName, "shared", "the stale ID must reach its original native session, not a newly generated one");
		assert.equal(result.details?.managedSessionOutcome, undefined);
		assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["confirm", "read-id"]]);
		const after = JSON.parse(await readFile(state, "utf8"));
		assert.equal(after.pending.id, "new-dom-id");
		assert.equal(after.domConfirmed, false);
		assert.equal(after.browserTouches, 0);
	});
});

test("native DOM decisions suppress overwriting helpers but page-shaped and unrelated decisions keep page checks", { concurrency: false }, async () => {
	await withConfirmations(async ({ log, branch, harness }) => {
		const body = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "read", "public.test/body"] });
		assert.equal(body.details?.readConfirmation, undefined);
		const pageJson = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "eval", "({ confirmed: true, action: 'read', result: { success: false, error: 'HTTP read failed: test response 500' } })"] });
		assert.equal(pageJson.isError, false, pageJson.content[0]?.text);
		assert.equal(pageJson.details?.readConfirmation, undefined);
		await writeFile(log, "");
		await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "confirm", "read-id"] });
		assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["get", "url"], ["confirm", "read-id"]]);
		const bare = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "read"] });
		assert.equal((bare.details?.readConfirmation as { source: string })?.source, "native-guarded-action", "a native current-page read is browser-backed, not explicit-URL provenance");
		assert.equal((bare.details?.readConfirmation as { capabilities?: unknown })?.capabilities, undefined);
		const legacy = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "read", "public.test/legacy"] });
		assert.equal((legacy.details?.readConfirmation as { capabilities?: unknown })?.capabilities, undefined, "legacy routing metadata does not prove native ID checking");
		await writeFile(log, "");
		await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "confirm", "read-id"] });
		assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["get", "url"], ["confirm", "read-id"]]);
		const pendingRead = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "read", "public.test/docs"] });
		branch.push(createToolBranchEntry({ details: pendingRead.details!, isError: pendingRead.isError }));
		const blocked = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "click", "#guarded"] });
		assert.equal(blocked.isError, true);
		assert.equal(blocked.details?.failureCategory, "confirmation-required");
		assert.equal((blocked.details?.readConfirmation as { state: string }).state, "pending");
		const actions = blocked.details?.nextActions as Array<{ params: { args: string[] } }>;
		assert.deepEqual(actions.map(action => action.params.args), [["--namespace", "", "--session", "shared", "confirm", "dom-id"], ["--namespace", "", "--session", "shared", "deny", "dom-id"]]);
		branch.push(createToolBranchEntry({ details: blocked.details!, isError: blocked.isError }));
		const replayed = SessionPageState.fromBranch(convertBrowserEntries(branch));
		assert.equal(replayed.findReadConfirmation(["--session", "shared", "confirm", "read-id"]), undefined);
		assert.equal(replayed.findReadConfirmation(["--session", "shared", "confirm", "dom-id"])?.source, "native-guarded-action");
		for (const args of [["--session", "shared", "confirm", "foreign-id"], ["--session", "other", "confirm", "dom-id"]]) {
			await writeFile(log, "");
			const unrelated = await executeRegisteredTool(harness.tool, harness.ctx, { args });
			assert.equal(unrelated.isError, true);
			assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["get", "url"], ["confirm", args.at(-1)!]]);
		}
		await writeFile(log, "");
		const dom = await executeRegisteredTool(harness.tool, harness.ctx, actions[0].params);
		assert.equal(dom.isError, false, dom.content[0]?.text);
		assert.equal((dom.details?.readConfirmation as { state: string }).state, "cleared");
		assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["confirm", "dom-id"], ["get", "url"], ["get", "title"], ["tab", "list"]]);
		assert.equal((dom.details?.sessionTabTarget as { url: string }).url, "https://clicked.test/", "completed native click reconciles its resulting target before follow-ups");
	});
});

for (const batch of [false, true]) test(`completed guarded decisions reconcile tabs, fail inner actions truthfully and retire confirmed close on replay (batch=${batch})`, { concurrency: false }, async () => {
	await withConfirmations(async ({ harness }) => {
		const prefix = ["--session", "shared"];
		const decide = async (args: string[]) => {
			const pending = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, ...args] });
			assert.equal(pending.details?.failureCategory, "confirmation-required");
			assert.doesNotMatch(pending.content[0]?.text ?? "", /Native helper|if dispatched/, "the requested action itself awaits confirmation");
			return await executeRegisteredTool(harness.tool, harness.ctx, batch
				? { args: [...prefix, "batch", "--bail"], stdin: JSON.stringify([["confirm", "dom-id"]]) }
				: { args: [...prefix, "confirm", "dom-id"] });
		};
		const failed = await decide(["eval", "throw fixture"]);
		assert.equal(failed.isError, true, failed.content[0]?.text);
		assert.match(failed.content[0]?.text ?? "", /HTTP read failed: test response 500/);
		assert.equal((failed.details?.readConfirmation as { state: string }).state, "cleared");
		const newTab = await decide(["tab", "new"]);
		assert.equal(newTab.isError, false, newTab.content[0]?.text);
		assert.equal((newTab.details?.sessionTabTarget as { url: string }).url, "about:blank");
		const closed = await decide(["close"]);
		assert.equal(closed.isError, false, closed.content[0]?.text);
		assert.equal(closed.details?.sessionTabTarget, undefined);
		assert.equal(SessionPageState.fromBranch(convertBrowserEntries(harness.ctx.sessionManager.getBranch())).get("shared").tabTarget, undefined);
	});
});

test("resumed batch confirmation reconciles click before an ordinary getter without discarding adjacent rows", { concurrency: false }, async () => {
	await withConfirmations(async ({ root, state, branch, harness }) => {
		await writeFile(state, JSON.stringify({ url: "https://fixture.test/before" }));
		const prefix = ["--session", "shared"];
		for (const args of [["get", "url"], ["click", "#guarded"]]) {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, ...args] });
			branch.push(createToolBranchEntry({ details: result.details!, isError: result.isError }));
		}
		const resumed = createExtensionHarness({ cwd: root, branch });
		await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
		const confirmed = await executeRegisteredTool(resumed.tool, resumed.ctx, {
			args: [...prefix, "batch", "--bail"],
			stdin: JSON.stringify([["get", "title"], ["confirm", "dom-id"], ["get", "title"]]),
		});
		assert.equal(confirmed.isError, false, confirmed.content[0]?.text);
		assert.equal((confirmed.details?.sessionTabTarget as { url: string }).url, "https://clicked.test/");
		assert.equal((confirmed.details?.batchSteps as unknown[]).length, 3);
		const title = await executeRegisteredTool(resumed.tool, resumed.ctx, { args: [...prefix, "get", "title"] });
		assert.equal(title.isError, false, title.content[0]?.text);
	});
});

test("early helper pending identifies the helper and the requested command is not dispatched", { concurrency: false }, async () => {
	await withConfirmations(async ({ state, log, harness }) => {
		await writeFile(state, JSON.stringify({ gateNextUrl: true }));
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "get", "title"] });
		assert.equal(result.details?.failureCategory, "confirmation-required");
		assert.equal(result.details?.agentBrowserStarted, false);
		assert.match(result.content[0]?.text ?? "", /Native helper get requires confirmation \(url\).*requested command was not dispatched/);
		assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["get", "url"]]);
	});
});

test("genuine post-command helper pending remains labelled and preserves the dispatched batch receipt", { concurrency: false }, async () => {
	await withConfirmations(async ({ harness }) => {
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "batch", "--bail"], stdin: JSON.stringify([["click", "#dispatched"]]) });
		assert.equal(result.details?.failureCategory, "confirmation-required");
		assert.equal(result.details?.agentBrowserStarted, true);
		assert.equal((result.details?.readConfirmation as { command: string }).command, "get");
		assert.match(result.content[0]?.text ?? "", /Native helper get requires confirmation/);
		assert.deepEqual((result.details?.data as Array<{ command: string[] }>)[0].command, ["click", "#dispatched"]);
	});
});

test("only the first effective matching batch decision suppresses helpers and later unknown-page checks remain", { concurrency: false }, async () => {
	await withConfirmations(async ({ log, state, harness }) => {
		const prefix = ["--session", "shared"];
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "url"] });
		for (const control of [
			{ session: "shared", rows: [["confirm", "dom-id"]], suppress: true },
			{ session: "shared", rows: [["confirm", "foreign-id"]], suppress: false },
			{ session: "other", rows: [["confirm", "dom-id"]], suppress: false },
			{ session: "shared", rows: [["get", "title"], ["confirm", "dom-id"]], suppress: false },
			{ session: "shared", rows: [["confirm", "dom-id"]], raw: "get title", suppress: false },
		]) {
			await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "click", "#guarded"] });
			await writeFile(log, "");
			await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", control.session, "batch", "--bail", ...(control.raw ? [control.raw] : [])], stdin: JSON.stringify(control.rows) });
			const commands = (await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args));
			assert.equal(commands[0][0] === "batch", control.suppress, JSON.stringify(control));
			if (control.raw) assert.equal(JSON.parse(await readFile(state, "utf8")).pending.id, "dom-id", "ignored stdin cannot settle the pending action");
		}
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "webmcp", "invoke", "pending"] });
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "close"] });
		await writeFile(log, "");
		const blocked = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "batch", "--bail"], stdin: JSON.stringify([["confirm", "dom-id"], ["get", "title"]]) });
		assert.equal(blocked.isError, true);
		assert.match(String(blocked.details?.validationError), /unverified|unknown|verified/i);
		assert.deepEqual(await readInvocationLog(log), [], "matching the first decision cannot bypass later unknown-page validation");
	});
});

for (const failedClose of [false, true]) test(`code confirmed close replays completed retirement or failed-close continuity (failed=${failedClose})`, { concurrency: false }, async () => {
	await withConfirmations(async ({ state, branch, harness }) => {
		const prefix = ["--session", "shared"];
		for (const args of [["--confirm-actions", "close", "get", "url"], ["close"]]) {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, ...args] });
			branch.push(createToolBranchEntry({ details: result.details!, isError: result.isError }));
		}
		if (failedClose) {
			const native = JSON.parse(await readFile(state, "utf8"));
			native.pending.failure = true;
			await writeFile(state, JSON.stringify(native));
		}
		const code = harness.getTool("agent_browser_code");
		assert.ok(code);
		const result = await executeRegisteredTool(code, harness.ctx, { session: "shared", code: 'emit((await browser({args:["confirm","dom-id"]})).success);' });
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(result.details?.data, !failedClose);
		const page = SessionPageState.fromBranch(convertBrowserEntries(harness.ctx.sessionManager.getBranch())).get("shared");
		assert.equal(page.tabTargetUnknown, undefined, "a completed close must retire the code intent's unknown target");
		assert.equal(page.pinningReason, failedClose ? "restore" : undefined);
		assert.equal(page.tabTarget?.url, failedClose ? "https://current.test/" : undefined);
		assert.equal(page.confirmActions, failedClose ? "close" : undefined);
	});
});
