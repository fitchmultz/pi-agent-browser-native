import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	createExtensionHarness,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./agent-browser-harness.js";

// The callback shares the harness's live transcript array so appends and replay keep the same identity.
interface ConfirmationFixture {
	readonly root: string;
	readonly log: string;
	readonly state: string;
	readonly branch: unknown[];
	readonly harness: ReturnType<typeof createExtensionHarness>;
}

export async function withConfirmations(
	run: (options: ConfirmationFixture) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "piab-read-confirm-"));
	const log = join(root, "calls.jsonl"),
		state = join(root, "native.json");
	await writeFakeAgentBrowserBinary(
		root,
		`const fs = require('node:fs');
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
if (tokens[0] === 'read' && tokens[1] === 'public.test/body') data = { content: JSON.stringify({ confirmation_required: true, confirmation_id: 'read-id', action: 'read', capabilities: { readRequiresConfirmation: true }, ...state.tabMetadata }), source: 'http' };
else if (tokens[0] === 'read') { state.pending = { id: 'read-id', action: 'read', sessionName, namespace, failure: tokens[1]?.endsWith('failure') === true }; data = { confirmation_required: true, confirmation_id: 'read-id', action: 'read', ...(tokens[1]?.startsWith('public.test/legacy') ? {} : { capabilities: { readRequiresConfirmation: true } }) }; }
else if (tokens[0] === 'webmcp') data = { invocationId: 'pending-job', status: 'pending' };
else if (tokens[0] === 'snapshot') { state.pending = { id: 'snapshot-id', action: 'snapshot', sessionName, namespace }; data = { confirmation_required: true, confirmation_id: 'snapshot-id', action: 'snapshot' }; }
else if (state.semanticSnapshot && ['click', 'check', 'fill', 'select'].includes(tokens[0]) && tokens[1]?.startsWith('@')) { state.actions = [...(state.actions ?? []), tokens]; data = { acted: true }; }
else if (state.semanticSnapshot && tokens[0] === 'find') { success = false; error = 'Unexpected native find fallback'; }
else if (tokens[0] === 'click' && tokens[1] === '#dispatched') { state.url = 'https://fixture.test/after'; state.gateNextUrl = true; data = { clicked: '#dispatched' }; }
else if (tokens[0] === 'click' || tokens[0] === 'tab' && tokens[1] === 'new' || tokens[0] === 'close' || tokens[0] === 'eval' && tokens[1] === 'throw fixture') {
  const action = tokens[0] === 'tab' ? 'tab_new' : tokens[0] === 'eval' ? 'evaluate' : tokens[0];
  state.pending = { id: 'dom-id', action, sessionName, namespace, failure: action === 'evaluate' };
  data = { confirmation_required: true, confirmation_id: 'dom-id', action, ...(action === 'tab_new' ? state.tabMetadata : {}) };
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
} else if (tokens[0] === 'eval' && tokens[1] === 'transport-page') data = { result: { confirmation_required: true, confirmation_id: 'dom-id', action: 'tab_new', ...state.tabMetadata } };
else if (tokens[0] === 'eval') data = { confirmed: true, action: 'read', result: failedReadResult };
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
process.stdout.write(JSON.stringify(result)); process.exitCode = result.success ? 0 : 1;`,
	);
	try {
		await withPatchedEnv(
			{
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
				HOME: root,
				USERPROFILE: root,
				AGENT_BROWSER_SESSION: undefined,
				AGENT_BROWSER_NAMESPACE: undefined,
			},
			async () => {
				const branch: unknown[] = [],
					harness = createExtensionHarness({
						cwd: root,
						branch,
						sessionFile: join(root, "session.jsonl"),
					});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				try {
					await run({ root, log, state, branch, harness });
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
}
