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
else if (tokens[0] === 'snapshot') { state.pending = { id: 'snapshot-id', action: 'snapshot', sessionName, namespace }; data = { confirmation_required: true, confirmation_id: 'snapshot-id', action: 'snapshot' }; }
else if (state.semanticSnapshot && ['click', 'check', 'fill', 'select'].includes(tokens[0]) && tokens[1]?.startsWith('@')) { state.actions = [...(state.actions ?? []), tokens]; data = { acted: true }; }
else if (state.semanticSnapshot && tokens[0] === 'find') { success = false; error = 'Unexpected native find fallback'; }
else if (tokens[0] === 'click' && tokens[1] === '#dispatched') { state.url = 'https://fixture.test/after'; state.gateNextUrl = true; data = { clicked: '#dispatched' }; }
else if (tokens[0] === 'click' || tokens[0] === 'tab' && tokens[1] === 'new' || tokens[0] === 'close' || tokens[0] === 'eval' && tokens[1] === 'throw fixture') {
  const action = tokens[0] === 'tab' ? 'tab_new' : tokens[0] === 'eval' ? 'evaluate' : tokens[0];
  state.pending = { id: 'dom-id', action, sessionName, namespace, failure: action === 'evaluate' };
  data = { confirmation_required: true, confirmation_id: 'dom-id', action };
}
else if (['confirm', 'deny'].includes(tokens[0])) {
  if (!state.pending || state.pending.id !== tokens[1] || state.pending.sessionName !== sessionName || state.pending.namespace !== namespace) { success = false; error = 'Confirmation ID or session mismatch'; }
  else if (state.pending.nested && tokens[0] === 'confirm') { delete state.pending.nested; data = { confirmed: true, action: state.pending.action, result: { success: true, data: { confirmation_required: true, confirmation_id: state.pending.id, action: state.pending.action } } }; }
  else { const pending = state.pending; state.pending = null; if (tokens[0] === 'confirm') {
      if (pending.action === 'click') { state.domConfirmed = true; state.browserTouches++; state.url = 'https://clicked.test/'; }
      if (pending.action === 'tab_new') state.url = 'about:blank';
    }
    if (tokens[0] === 'confirm' && pending.action === 'snapshot') state.captures = (state.captures ?? 0) + 1;
    data = tokens[0] === 'confirm' ? { confirmed: true, action: pending.action, result: pending.failure === 'no-active-page' ? { success: false, error: 'No active page' } : pending.failure ? failedReadResult : { success: true, data: pending.action === 'snapshot' ? state.semanticSnapshot ?? { origin: 'https://current.test/', snapshot: '- button "Current" [ref=e' + state.captures + ']', refs: { ['e' + state.captures]: { role: 'button', name: 'Current' } } } : pending.action === 'close' ? { closed: true } : pending.action === 'click' ? { clicked: '#guarded' } : pending.action === 'tab_new' ? { url: 'about:blank' } : { content: 'Confirmed markdown', source: 'http', url: 'https://public.test/' } } } : { denied: true, action: pending.action }; }
} else if (tokens[0] === 'eval') data = { confirmed: true, action: 'read', result: failedReadResult };
else if (tokens[0] === 'open') { state.url = tokens[1]; data = { url: state.url }; }
else if (tokens[0] === 'get' && tokens[1] === 'url' && state.gateNextUrl) { state.gateNextUrl = false; state.pending = { id: 'helper-id', action: 'url', sessionName, namespace }; data = { confirmation_required: true, confirmation_id: 'helper-id', action: 'url' }; }
else if (tokens[0] === 'get' && tokens[1] === 'text') { if (tokens[2]?.startsWith('@') && !state.captures) { success = false; error = 'Ref not found: no complete snapshot has captured this element'; } else data = { text: 'Current' }; }
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

for (const after of ["none", "failed-row", "pending", "invalidation", "capture", "failed-snapshot"] as const) test(`confirmed batch snapshots replace refs in row order (${after})`, { concurrency: false }, async () => {
	await withConfirmations(async ({ state, log, branch, harness }) => {
		const prefix = ["--session", "shared"];
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "--confirm-actions", "snapshot", "open", "https://current.test/"] });
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "snapshot", "-i"] });
		const first = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "confirm", "snapshot-id"] });
		assert.equal(first.isError, false);
		branch.push(createToolBranchEntry({ details: first.details!, isError: first.isError }));
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "snapshot", "-i"] });
		if (after === "failed-snapshot") {
			const native = JSON.parse(await readFile(state, "utf8"));
			native.pending.failure = "no-active-page";
			await writeFile(state, JSON.stringify(native));
		}
		const later = after === "failed-row" ? [["confirm", "missing"]]
			: after === "pending" ? [["snapshot", "-i"]]
			: after === "invalidation" ? [["webmcp", "invoke", "pending"]]
			: after === "capture" ? [["snapshot", "-i"], ["confirm", "snapshot-id"]] : [];
		const batch = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "batch"], stdin: JSON.stringify([["confirm", "snapshot-id"], ...later]) });
		branch.push(createToolBranchEntry({ details: batch.details!, isError: batch.isError }));
		const replay = SessionPageState.fromBranch(convertBrowserEntries(branch)).get("shared");
		const invalidated = after === "invalidation" || after === "failed-snapshot";
		const current = after === "capture" ? "e3" : "e2";
		if (invalidated) {
			assert.equal(replay.refSnapshot, undefined);
			assert.equal(replay.refSnapshotInvalidation?.reason, after === "failed-snapshot" ? "no-active-page" : "page-transition");
		} else assert.deepEqual(replay.refSnapshot?.refIds, [current]);
		await writeFile(log, "");
		const getter = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "text", `@${current}`] });
		const fresh = after === "none" || after === "capture";
		assert.equal(getter.isError, !fresh, getter.content[0]?.text);
		assert.equal((await readInvocationLog(log)).some(call => extractUpstreamCommandTokens(call.args).join(" ") === `get text @${current}`), fresh);
		if (!invalidated && !fresh) assert.equal(getter.details?.failureCategory, "confirmation-required", "later rows retire one-use freshness, not the completed snapshot's membership");
	});
});

for (const action of [
	{ action: "click", locator: "role", role: "button", name: "Save", expected: ["click", "@e5"] },
	{ action: "check", locator: "role", role: "checkbox", name: "Terms", expected: ["check", "@e6"] },
	{ action: "fill", locator: "role", role: "textbox", name: "Name", text: "-kept verbatim", expected: ["fill", "@e7", "-kept verbatim"] },
	{ action: "select", locator: "role", role: "combobox", name: "Flavor", values: ["-1", "chocolate"], expected: ["select", "@e8", "-1", "chocolate"] },
	{ action: "select", locator: "label", value: "Flavor", values: ["vanilla"], expected: ["select", "@e8", "vanilla"] },
]) test(`semantic ${action.action}/${action.locator} uses a confirmed capture once across resume`, { concurrency: false }, async () => {
	await withConfirmations(async ({ root, state, log, harness }) => {
		await writeFile(state, JSON.stringify({ semanticSnapshot: {
			origin: "https://current.test/",
			refs: { e5: { role: "button", name: "Save" }, e6: { role: "checkbox", name: "Terms" }, e7: { role: "textbox", name: "Name" }, e8: { role: "combobox", name: "Flavor" } },
			snapshot: '- button "Save" [ref=e5]\n- checkbox "Terms" [ref=e6]\n- textbox "Name" [ref=e7]\n- combobox "Flavor" [ref=e8]',
		} }));
		const prefix = ["--session", "shared"];
		assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "--confirm-actions", "snapshot", "open", "https://current.test/"] })).isError, false);
		const { expected, ...params } = action;
		const request = { ...params, session: "shared" };
		const pending = await executeRegisteredTool(harness.getTool("agent_browser_action")!, harness.ctx, request);
		assert.equal(pending.details?.failureCategory, "confirmation-required");
		assert.match(pending.content[0]?.text ?? "", /requested command was not dispatched/);
		const approval = (pending.details?.nextActions as Array<{ id: string; params: { args: string[] } }>).find(row => row.id === "approve-confirmation")!;
		assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, approval.params)).isError, false);
		harness = createExtensionHarness({ cwd: root, branch: structuredClone(harness.ctx.sessionManager.getBranch()) });
		await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
		await writeFile(log, "");
		const result = await executeRegisteredTool(harness.getTool("agent_browser_action")!, harness.ctx, request);
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.deepEqual(JSON.parse(await readFile(state, "utf8")).actions, [expected]);
		assert.equal((await readInvocationLog(log)).some(call => extractUpstreamCommandTokens(call.args)[0] === "snapshot"), false, "reuse must not acquire another gated snapshot");
		const second = await executeRegisteredTool(harness.getTool("agent_browser_action")!, harness.ctx, request);
		assert.equal(second.details?.failureCategory, "confirmation-required", "the next operation must acquire its own sample");
		assert.deepEqual(JSON.parse(await readFile(state, "utf8")).actions, [expected]);
	});
});

for (const route of ["path", "hash"]) for (const semantic of [false, true]) for (const drift of [false, true]) test(`warm confirmed capture checks the live page without resume (route=${route}, semantic=${semantic}, drift=${drift})`, { concurrency: false }, async () => {
	await withConfirmations(async ({ state, log, harness }) => {
		const prefix = ["--session", "shared"];
		const url = route === "hash" ? "https://current.test/#/contract" : "https://current.test/contract";
		const movedUrl = route === "hash" ? "https://current.test/#/other" : "https://current.test/other";
		await writeFile(state, JSON.stringify({ semanticSnapshot: {
			origin: url,
			refs: { e8: { role: "combobox", name: "Flavor" } }, snapshot: '- combobox "Flavor" [ref=e8]',
		} }));
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "--confirm-actions", "snapshot", "open", url] });
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "snapshot", "-i"] });
		assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "confirm", "snapshot-id"] })).isError, false);
		if (drift) {
			const native = JSON.parse(await readFile(state, "utf8"));
			native.url = movedUrl;
			native.semanticSnapshot.refs.e8.name = "Renamed";
			await writeFile(state, JSON.stringify(native));
		}
		await writeFile(log, "");
		const result = await executeRegisteredTool(semantic ? harness.getTool("agent_browser_action")! : harness.tool, harness.ctx,
			semantic ? { action: "select", locator: "role", role: "combobox", name: "Flavor", value: "chocolate", session: "shared" }
				: { args: [...prefix, "select", "@e8", "chocolate"] });
		assert.equal(result.isError, drift, result.content[0]?.text);
		if (drift) {
			assert.equal(result.details?.failureCategory, "stale-ref");
			assert.ok(result.content[0]?.text?.includes(`current session target is ${movedUrl}`));
		}
		const calls = (await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args));
		assert.equal(calls.some(tokens => tokens.join(" ") === "get url"), true, "the live URL must be observed on this warm call");
		assert.equal(calls.some(tokens => tokens[0] === "snapshot"), false, "one-use freshness must not acquire another gated capture");
		assert.deepEqual(JSON.parse(await readFile(state, "utf8")).actions ?? [], drift ? [] : [["select", "@e8", "chocolate"]]);
	});
});

for (const mode of ["absent", "ambiguous", "drift", "intervening"] as const) test(`confirmed semantic select retains its guards (${mode})`, { concurrency: false }, async () => {
	await withConfirmations(async ({ root, state, log, harness }) => {
		const refs = mode === "absent" ? { e5: { role: "button", name: "Save" } }
			: { e8: { role: "combobox", name: "Flavor" }, ...(mode === "ambiguous" ? { e9: { role: "combobox", name: "Flavor" } } : {}) };
		await writeFile(state, JSON.stringify({ semanticSnapshot: { origin: "https://current.test/", refs, snapshot: "" } }));
		const prefix = ["--session", "shared"];
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "--confirm-actions", "snapshot", "open", "https://current.test/"] });
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "snapshot", "-i"] });
		assert.equal((await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "confirm", "snapshot-id"] })).isError, false);
		harness = createExtensionHarness({ cwd: root, branch: structuredClone(harness.ctx.sessionManager.getBranch()) });
		await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
		if (mode === "intervening") await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "title"] });
		if (mode === "drift") {
			const native = JSON.parse(await readFile(state, "utf8"));
			await writeFile(state, JSON.stringify({ ...native, url: "https://external.test/" }));
		}
		await writeFile(log, "");
		const result = await executeRegisteredTool(harness.getTool("agent_browser_action")!, harness.ctx, { action: "select", locator: "role", role: "combobox", name: "Flavor", value: "chocolate", session: "shared" });
		assert.equal(result.isError, true);
		if (mode === "absent" || mode === "ambiguous") assert.match(String(result.details?.validationError), /exactly one current visible/);
		if (mode === "drift") assert.equal(result.details?.failureCategory, "tab-drift");
		if (mode === "intervening") assert.equal(result.details?.failureCategory, "confirmation-required");
		assert.equal((await readInvocationLog(log)).some(call => ["select", "find"].includes(extractUpstreamCommandTokens(call.args)[0])), false);
	});
});

test("pending snapshots preserve explicit JSON and executable identity-qualified actions", { concurrency: false }, async () => {
	await withConfirmations(async ({ harness }) => {
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "team", "--session", "shared", "--json", "snapshot", "-i"] });
		assert.equal(result.details?.failureCategory, "confirmation-required");
		assert.equal(JSON.parse(result.content[0]?.text ?? "").data.confirmation_required, true);
		assert.doesNotMatch(result.content[0]?.text ?? "", /no interactive elements|Refs: 0/);
		assert.deepEqual((result.details?.nextActions as Array<{ params: { args: string[] } }>).map(row => row.params.args), [
			["--namespace", "team", "--session", "shared", "confirm", "snapshot-id"],
			["--namespace", "team", "--session", "shared", "deny", "snapshot-id"],
		]);
	});
});

for (const mode of ["direct", "batch", "code", "intervening", "absent", "drift", "deny", "nested"] as const) test(`confirmed capture is one-use across resume (${mode})`, { concurrency: false }, async () => {
	await withConfirmations(async ({ root, state, log, harness }) => {
		const prefix = ["--session", "shared"];
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "--confirm-actions", "snapshot", "open", "https://current.test/"] });
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "snapshot", "-i"] });
		if (mode === "nested") {
			const native = JSON.parse(await readFile(state, "utf8"));
			native.pending.nested = true;
			await writeFile(state, JSON.stringify(native));
		}
		const confirmed = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, mode === "deny" ? "deny" : "confirm", "snapshot-id"] });
		assert.equal(confirmed.isError, mode === "nested", confirmed.content[0]?.text);
		const branch = structuredClone(harness.ctx.sessionManager.getBranch());
		harness = createExtensionHarness({ cwd: root, branch });
		await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
		if (mode === "intervening") await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "title"] });
		if (mode === "drift") {
			const native = JSON.parse(await readFile(state, "utf8"));
			native.url = "https://external.test/";
			await writeFile(state, JSON.stringify(native));
		}
		await writeFile(log, "");
		const getterArgs = ["get", "text", mode === "absent" ? "@e99" : "@e1"];
		const code = harness.getTool("agent_browser_code")!;
		const getter = await executeRegisteredTool(mode === "code" ? code : harness.tool, harness.ctx,
			mode === "code" ? { session: "shared", code: `emit((await browser({args:${JSON.stringify(getterArgs)}})).success);` }
				: mode === "batch" ? { args: [...prefix, "batch", "--bail"], stdin: JSON.stringify([getterArgs]) }
					: { args: [...prefix, ...getterArgs] });
		const fresh = ["direct", "batch", "code"].includes(mode);
		if (mode === "code") assert.equal(getter.details?.data, true, getter.content[0]?.text);
		else assert.equal(getter.isError, !fresh, getter.content[0]?.text);
		const commands = (await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args));
		assert.equal(commands.some(tokens => tokens[0] === "snapshot"), mode === "intervening", "only an eligible next call can reuse the approved capture");
		if (!fresh) {
			assert.equal(commands.some(tokens => tokens.join(" ") === getterArgs.join(" ")), mode === "deny" || mode === "nested", "without a completed capture, native still owns ref resolution; unconfirmed results must not grant freshness");
			if (mode === "deny" || mode === "nested") assert.equal((confirmed.details?.readConfirmation as { refSnapshotFresh?: true })?.refSnapshotFresh, undefined);
			return;
		}
		const consumedBranch = structuredClone(harness.ctx.sessionManager.getBranch());
		harness = createExtensionHarness({ cwd: root, branch: consumedBranch });
		await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
		await writeFile(log, "");
		const second = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, ...getterArgs] });
		assert.equal(second.details?.failureCategory, "confirmation-required", second.content[0]?.text);
		assert.equal(second.details?.agentBrowserStarted, false);
		assert.equal((await readInvocationLog(log)).some(call => extractUpstreamCommandTokens(call.args).join(" ") === getterArgs.join(" ")), false);
		const approve = (second.details?.nextActions as Array<{ id: string; params: { args: string[] } }>).find(action => action.id === "approve-confirmation");
		assert.ok(approve);
		const helper = await executeRegisteredTool(harness.tool, harness.ctx, approve.params);
		assert.equal(helper.isError, false, helper.content[0]?.text);
		const third = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "text", "@e2"] });
		assert.equal(third.isError, false, third.content[0]?.text);
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

for (const mode of ["direct", "batch", "code", "code-batch"] as const) for (const failedClose of [false, true]) test(`confirmed close retires attachment on live and replay paths (${mode}, failed=${failedClose})`, { concurrency: false }, async () => {
	await withConfirmations(async ({ root, state, branch, harness }) => {
		const prefix = ["--session", "shared"];
		await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "connect", "9222"] });
		for (const args of [["--confirm-actions", "close", "get", "url"], ["close"]]) {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, ...args] });
			branch.push(createToolBranchEntry({ details: result.details!, isError: result.isError }));
		}
		if (failedClose) {
			const native = JSON.parse(await readFile(state, "utf8"));
			native.pending.failure = true;
			await writeFile(state, JSON.stringify(native));
		}
		const decision = mode.endsWith("batch") ? { args: ["batch", "--bail"], stdin: JSON.stringify([["confirm", "dom-id"]]) } : { args: ["confirm", "dom-id"] };
		const code = mode.startsWith("code");
		const result = await executeRegisteredTool(code ? harness.getTool("agent_browser_code")! : harness.tool, harness.ctx,
			code ? { session: "shared", code: `emit((await browser(${JSON.stringify(decision)})).success);` } : { ...decision, args: [...prefix, ...decision.args] });
		assert.equal(result.isError, code ? false : failedClose, result.content[0]?.text);
		if (code) assert.equal(result.details?.data, !failedClose);
		const page = SessionPageState.fromBranch(convertBrowserEntries(harness.ctx.sessionManager.getBranch())).get("shared");
		assert.equal(page.tabTargetUnknown, undefined, "a completed close must retire the code intent's unknown target");
		assert.equal(page.pinningReason, failedClose ? "restore" : undefined);
		assert.equal(page.tabTarget?.url, failedClose ? "https://current.test/" : undefined);
		assert.equal(page.confirmActions, failedClose ? "close" : undefined);
		const live = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "get", "title"] });
		assert.equal(live.isError, false, live.content[0]?.text);
		assert.equal(live.details?.attachedBrowserSession, failedClose ? true : undefined);
		const resumed = createExtensionHarness({ cwd: root, branch: structuredClone(harness.ctx.sessionManager.getBranch()) });
		await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
		const restored = await executeRegisteredTool(resumed.tool, resumed.ctx, { args: [...prefix, "get", "title"] });
		assert.equal(restored.isError, false, restored.content[0]?.text);
		assert.equal(restored.details?.attachedBrowserSession, failedClose ? true : undefined, "confirmed-close retirement must survive compact direct/code/batch replay; failed close must retain attachment");
	});
});
