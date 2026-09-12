import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
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
let data, success = true, error;
if (tokens[0] === 'read' && tokens[1] === 'public.test/body') data = { content: JSON.stringify({ confirmation_required: true, confirmation_id: 'read-id', action: 'read', capabilities: { readRequiresConfirmation: true } }), source: 'http' };
else if (tokens[0] === 'read') { state.pending = { id: 'read-id', action: 'read', sessionName, namespace }; data = { confirmation_required: true, confirmation_id: 'read-id', action: 'read', ...(tokens[1] === 'public.test/legacy' ? {} : { capabilities: { readRequiresConfirmation: true } }) }; }
else if (tokens[0] === 'click') { state.pending = { id: 'dom-id', action: 'click', sessionName, namespace }; data = { confirmation_required: true, confirmation_id: 'dom-id', action: 'click' }; }
else if (['confirm', 'deny'].includes(tokens[0])) {
  if (!state.pending || state.pending.id !== tokens[1] || state.pending.sessionName !== sessionName || state.pending.namespace !== namespace) { success = false; error = 'Confirmation ID or session mismatch'; }
  else { const pending = state.pending; state.pending = null; if (pending.action === 'click' && tokens[0] === 'confirm') { state.domConfirmed = true; state.browserTouches++; }
    data = tokens[0] === 'confirm' ? { confirmed: true, action: pending.action, result: { success: true, data: { content: 'Confirmed markdown', source: 'http', url: 'https://public.test/' } } } : { denied: true, action: pending.action }; }
} else if (tokens[0] === 'get' || tokens[0] === 'tab') { state.browserTouches++; data = { url: 'https://current.test/', title: 'Current' }; }
else data = { active: false, session: sessionName, namespace, runtime: null };
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
process.stdout.write(JSON.stringify({ success, data, error })); process.exitCode = success ? 0 : 1;`);
	try {
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, HOME: root, USERPROFILE: root, AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined }, async () => {
			const branch: unknown[] = [], harness = createExtensionHarness({ cwd: root, branch });
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
			const pendingState = SessionPageState.fromBranch(branch);
			assert.equal(pendingState.findReadConfirmation(["--session", "piab-script-isolated", command, "read-id"], ""), undefined, "an isolated script's explicit identity cannot select a shared read confirmation");
			assert.equal(pendingState.findReadConfirmation(["--namespace", "other", command, "read-id"], "other"), undefined);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "reload" }, harness.ctx);
			harness = createExtensionHarness({ cwd: root, branch });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			await writeFile(log, "");
			const confirmed = await executeRegisteredTool(harness.tool, harness.ctx, { args: [command, "read-id"] });
			assert.equal(confirmed.isError, false, confirmed.content[0]?.text);
			assert.equal(confirmed.details?.sessionName, shared ? "shared" : "default");
			assert.equal(confirmed.details?.managedSessionOutcome, undefined);
			assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [[command, "read-id"]]);
			assert.equal(JSON.parse(await readFile(state, "utf8")).browserTouches, 0);
			branch.push(createToolBranchEntry({ details: confirmed.details!, isError: confirmed.isError }));
			assert.equal(SessionPageState.fromBranch(branch).findReadConfirmation(["confirm", "read-id"]), undefined);
			assert.equal(SessionPageState.fromBranch(branch.slice(0, -1)).findReadConfirmation(["confirm", "read-id"])?.id, "read-id");
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
		});
	});
}

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

test("DOM and page-content-shaped confirmations keep their existing page checks", { concurrency: false }, async () => {
	await withConfirmations(async ({ log, harness }) => {
		const body = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "read", "public.test/body"] });
		assert.equal(body.details?.readConfirmation, undefined);
		await writeFile(log, "");
		await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "confirm", "read-id"] });
		assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["get", "url"], ["confirm", "read-id"]]);
		const bare = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "read"] });
		assert.equal(bare.details?.readConfirmation, undefined, "a capability-shaped DOM read response is not explicit-URL provenance");
		const legacy = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "read", "public.test/legacy"] });
		assert.equal((legacy.details?.readConfirmation as { capabilities?: unknown })?.capabilities, undefined, "legacy routing metadata does not prove native ID checking");
		await writeFile(log, "");
		await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "confirm", "read-id"] });
		assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["get", "url"], ["confirm", "read-id"]]);
		await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "click", "#guarded"] });
		await writeFile(log, "");
		const dom = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "shared", "confirm", "dom-id"] });
		assert.equal(dom.isError, false, dom.content[0]?.text);
		assert.equal(dom.details?.readConfirmation, undefined);
		assert.deepEqual((await readInvocationLog(log)).map(call => extractUpstreamCommandTokens(call.args)), [["get", "url"], ["confirm", "dom-id"]]);
	});
});
