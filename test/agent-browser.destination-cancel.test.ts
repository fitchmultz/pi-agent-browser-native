import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import {
	createExtensionHarness,
	createShortPrivateSocketDir,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	type AgentBrowserToolParams,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";
import {
	readRecord,
	readArray,
	readString,
	readBoolean,
	hasErrorCode,
} from "./helpers/assertions.js";

const rememberedUrl = "http://127.0.0.1:43210/remembered/page#/report";
const requestedUrl = "http://127.0.0.1:43210/redirect";
const redirectedUrl = "http://127.0.0.1:43210/actual/destination#/loaded";
const namespace = "dc";
const destinations = [
	["window", "new"],
	["diff", "url", rememberedUrl, requestedUrl],
];

type BrowserState = {
	readonly active: boolean;
	readonly pages: readonly {
		readonly tabId: string;
		readonly title: string;
		readonly url: string;
	}[];
	readonly selected: string;
};
type Page = {
	readonly call: (
		params: AgentBrowserToolParams,
		signal?: AbortSignal,
	) => ReturnType<typeof executeRegisteredTool>;
	readonly calls: () => ReturnType<typeof readInvocationLog>;
	readonly marker: string;
	readonly patch: (patch: Readonly<Record<string, unknown>>) => Promise<void>;
	readonly reload: () => Promise<void>;
	readonly sessionName: string;
	readonly state: () => Promise<BrowserState>;
};

type WarmSeed = {
	readonly root: string;
	readonly socketDir: string;
	readonly branch: readonly unknown[];
	readonly nativeState: string;
	readonly sessionName: string;
};
let warmSeed: WarmSeed | undefined;
after(async () => {
	await Promise.all(
		[warmSeed?.root, warmSeed?.socketDir]
			.filter((path) => path !== undefined)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function withPage(
	run: (page: Page) => Promise<void>,
	options: { readonly cold?: boolean; readonly callerOwned?: boolean } = {},
): Promise<void> {
	const reusable = options.cold !== true && options.callerOwned !== true;
	const cached = reusable ? warmSeed : undefined;
	const root = cached?.root ?? (await mkdtemp(join(tmpdir(), "dc-")));
	const socketDir = cached?.socketDir ?? createShortPrivateSocketDir(root);
	const cwd = join(root, "g"),
		home = join(root, "h");
	const statePath = join(root, "browser.json"),
		logPath = join(root, "calls.jsonl"),
		marker = join(root, "open-started");
	if (!cached) {
		await Promise.all([cwd, home].map((path) => mkdir(path, { mode: 0o700 })));
		execFileSync("git", ["init", "-q", cwd]);
		// Native-shaped replies: window-new activates a separate blank page; URL diff reports inputs, not the redirected URL.
		await writeFakeAgentBrowserBinary(
			root,
			`const fs = require('node:fs');
const args = process.argv.slice(2), stdin = fs.readFileSync(0, 'utf8'), tokens = [];
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + '\\n');
for (let i = 0; i < args.length; i++) {
  if (['--session', '--namespace', '--headers', '--user-agent'].includes(args[i])) i++;
  else if (!['--json', '--no-pin-tab'].includes(args[i])) tokens.push(args[i]);
}
let state = { active: false, restoreKey: null, pages: [], selected: 't1', refs: {} };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8')); } catch {}
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
const current = () => state.pages.find(page => page.tabId === state.selected);
const navigate = url => { current().url = url === ${JSON.stringify(requestedUrl)} ? state.redirectedUrl ?? ${JSON.stringify(redirectedUrl)} : url; current().title = 'Page'; state.refs = {}; };
function execute(row) {
  const [command, subcommand] = row;
  if (command === 'not-a-command') throw new Error('Unknown command: not-a-command');
  if (command === 'session') return { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey, backgroundPid: ${process.pid}, socketDir: process.env.AGENT_BROWSER_SOCKET_DIR, browserLaunched: true } : null };
  if (command === 'close') { state.active = false; state.pages = []; state.restoreKey = null; return { closed: true }; }
  if (!state.active) { state.active = true; state.restoreKey = process.env.AGENT_BROWSER_RESTORE ?? null; state.pages = [{ tabId: 't1', title: 'Page', url: 'http://127.0.0.1:43210/' }]; state.selected = 't1'; }
  if (command === 'open') {
    navigate(row[1]);
    if (state.holdNextOpen) { delete state.holdNextOpen; save(); fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); }
    return { title: current().title, url: current().url };
  }
  if (command === 'window' && subcommand === 'new') {
    state.selected = 't' + (state.pages.length + 1);
    state.pages.push({ tabId: state.selected, title: '', url: 'about:blank' }); state.refs = {};
    if (state.failDestination) throw new Error('Fixture destination failed after changing page');
    return { tabId: state.selected, total: state.pages.length };
  }
  if (command === 'diff' && subcommand === 'url') {
    navigate(row[2]);
    if (state.failDestination) throw new Error('Fixture destination failed after first navigation');
    navigate(row[3]);
    return { diff: '- old\\n+ new', url1: row[2], url2: row[3], snapshot1: 'old', snapshot2: 'new' };
  }
  if (command === 'tab') {
    if (!subcommand || subcommand === 'list') return { tabs: state.pages.map(page => ({ ...page, active: page.tabId === state.selected })) };
    if (!state.pages.some(page => page.tabId === subcommand)) throw new Error('Tab not found');
    state.selected = subcommand; state.refs = {}; return { tabId: subcommand };
  }
  if (command === 'snapshot') {
    const ref = current().url === ${JSON.stringify(rememberedUrl)} ? 'e1' : 'e2';
    state.refs = current().url === 'about:blank' ? {} : { [ref]: { role: 'textbox', name: 'Name' } };
    return { origin: current().url, refs: state.refs, snapshot: Object.keys(state.refs).length ? '- textbox "Name" [ref=' + ref + ']' : '(no interactive elements)' };
  }
  if (command === 'get' && subcommand === 'url') { if (state.failUrlProbe) throw new Error('Fixture URL probe unavailable'); return { url: current().url }; }
  if (command === 'get' && subcommand === 'title') return { title: current().title };
  if (command === 'get' && subcommand === 'value') {
    if (!state.refs[row[2].replace('@', '')]) throw new Error('Invalid ref');
    return { value: 'fixture value' };
  }
  if (command === 'console') return { messages: [] };
  throw new Error('Unexpected fixture command: ' + row.join(' '));
}
function result(row) {
  try { return { command: row, success: true, result: execute(row), error: null }; }
  catch (error) { return { command: row, success: false, result: null, error: error.message }; }
}
let output, failed;
if (tokens[0] === 'batch') {
  const raw = tokens.slice(1).filter(token => token !== '--bail');
  const rows = raw.length ? raw.map(row => row.split(' ')) : JSON.parse(stdin);
  output = [];
  for (const row of rows) { if (!row.length) continue; const entry = result(row); output.push(entry); if (!entry.success && tokens.includes('--bail')) break; }
  failed = output.some(entry => !entry.success);
} else { const entry = result(tokens); output = { success: entry.success, data: entry.result, error: entry.error }; failed = !entry.success; }
save(); process.stdout.write(JSON.stringify(output)); process.exitCode = failed ? 1 : 0;`,
		);
	}
	try {
		await withPatchedEnv(
			{
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
				HOME: home,
				USERPROFILE: home,
				// Enabled-restore scenarios need the native Windows storage prerequisite too.
				AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
				PI_CODING_AGENT_DIR: join(root, "pi"),
				PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
				AGENT_BROWSER_NAMESPACE: "",
				PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
			},
			async () => {
				// Reuse only owner-generated warm state. Every scenario gets a separate
				// branch copy and reset native state; cold/caller-owned setup stays real.
				let branch: unknown[] = structuredClone([...(cached?.branch ?? [])]);
				if (cached) {
					await writeFile(statePath, cached.nativeState);
				}
				let harness = createExtensionHarness({ branch, cwd });
				const call: Page["call"] = async (params, signal) => {
					let result: Awaited<ReturnType<typeof executeRegisteredTool>>;
					try {
						result = await executeRegisteredTool(
							harness.tool,
							harness.ctx,
							options.callerOwned === true
								? {
										...params,
										args: ["--namespace", namespace, "--session", "caller", ...(params.args ?? [])],
									}
								: params,
							signal,
						);
					} catch (error) {
						// Pi 0.84 persists empty details when execute throws; replay must see that same failure, not invented metadata.
						result = {
							content: [
								{
									type: "text",
									text: error instanceof Error ? error.toString() : readString(error),
								},
							],
							details: {},
							isError: true,
						};
					}
					branch.push(
						createToolBranchEntry({ details: result.details ?? {}, isError: result.isError }),
					);
					return result;
				};
				const restore = async (reason: "quit" | "reload") => {
					await runExtensionEvent(harness.handlers, "session_shutdown", { reason }, harness.ctx);
					branch = structuredClone(harness.ctx.sessionManager.getBranch());
					harness = createExtensionHarness({ branch, cwd });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "resume" },
						harness.ctx,
					);
				};
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: cached ? "resume" : "new" },
					harness.ctx,
				);
				let sessionName = cached?.sessionName ?? "";
				if (!cached) {
					const opened = await call({
						args: [
							...(options.callerOwned === true ? [] : ["--namespace", namespace]),
							"open",
							rememberedUrl,
						],
						sessionMode: "fresh",
					});
					assert.equal(opened.isError, false, opened.content[0].text);
					assert.equal(typeof opened.details?.sessionName, "string");
					sessionName = readString(readRecord(opened.details).sessionName);
					const snapshot = await call({ args: ["snapshot", "-i"] });
					assert.equal(snapshot.isError, false, snapshot.content[0].text);
					await restore(options.cold === true ? "quit" : "reload");
					if (reusable) {
						warmSeed = {
							root,
							socketDir,
							sessionName,
							branch: structuredClone(harness.ctx.sessionManager.getBranch()),
							nativeState: await readFile(statePath, "utf8"),
						};
					}
				}
				await writeFile(logPath, "");
				try {
					await run({
						call,
						calls: () => readInvocationLog(logPath),
						marker,
						patch: async (patch) =>
							writeFile(
								statePath,
								JSON.stringify({
									...readRecord(JSON.parse(await readFile(statePath, "utf8"))),
									...patch,
								}),
							),
						reload: () => restore("reload"),
						sessionName,
						state: async () => {
							const state = readRecord(JSON.parse(await readFile(statePath, "utf8")));
							return {
								active: readBoolean(state.active),
								selected: readString(state.selected),
								pages: readArray(state.pages).map((value) => {
									const page = readRecord(value);
									return {
										tabId: readString(page.tabId),
										title: readString(page.title),
										url: readString(page.url),
									};
								}),
							};
						},
					});
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
		if (!reusable || !warmSeed) {
			await rm(root, { recursive: true, force: true });
			await rm(socketDir, { recursive: true, force: true });
		}
	}
}

for (const command of destinations) {
	for (const batch of [false, true]) {
		test(
			`explicit ${command[0]} destination owns the next snapshot after resume (batch=${batch})`,
			{ concurrency: false },
			async () => {
				await withPage(async (page) => {
					const args = batch ? ["batch"] : command;
					const stdin = batch ? JSON.stringify([command]) : undefined;
					const changed = await page.call({ args, stdin });
					assert.equal(changed.isError, false, JSON.stringify(changed));
					const stale = await page.call({ args: ["get", "value", "@e1"] });
					await page.reload();
					const snapshot = await page.call({ args: ["snapshot", "-i"] });
					const expected = command[0] === "window" ? "about:blank" : redirectedUrl;
					assert.equal(snapshot.isError, false, snapshot.content[0].text);
					assert.equal(
						readRecord(snapshot.details?.data).origin,
						expected,
						"follow-up must not reselect the remembered page",
					);
					assert.equal(readRecord(changed.details?.sessionTabTarget).url, expected);
					assert.equal(changed.details?.aboutBlankSessionMismatch, undefined);
					assert.equal(
						readRecord(changed.details?.refSnapshotInvalidation).reason,
						"page-transition",
					);
					assert.equal(stale.details?.failureCategory, "stale-ref");
					const refs = readRecord(snapshot.details?.refSnapshot);
					assert.deepEqual(refs.refIds, command[0] === "window" ? [] : ["e2"]);
					assert.equal(
						(await page.calls()).some((row) => row.args.includes("value")),
						false,
						"old refs must be rejected before dispatch",
					);
					if (command[0] === "diff") {
						// This enumerated fixture branch (command[0] === "diff") has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal((await page.call({ args: ["get", "value", "@e2"] })).isError, false);
					}
					const calls = await page.calls();
					assert.equal(
						calls.some((row) => extractUpstreamCommandTokens(row.args)[0] === "open"),
						false,
					);
					assert.equal(
						calls.some(
							(row) => JSON.stringify(extractUpstreamCommandTokens(row.args)) === '["tab","t1"]',
						),
						false,
					);
					const dispatched = calls.filter(
						(row) => extractUpstreamCommandTokens(row.args)[0] === args[0],
					);
					assert.equal(dispatched.length, 1);
					assert.deepEqual(extractUpstreamCommandTokens(dispatched[0].args), args);
					if (batch) {
						// This enumerated fixture branch (batch) has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(dispatched[0].stdin, stdin);
					}
					if (command[0] === "window") {
						// This enumerated fixture branch (command[0] === "window") has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							(await page.state()).pages[0].url,
							rememberedUrl,
							"the old tab still exists but must not be selected",
						);
					}
				});
			},
		);
	}
}

for (const command of destinations) {
	for (const batch of [false, true]) {
		test(
			`failed ${command[0]} observes partial navigation and invalidates refs (batch=${batch})`,
			{ concurrency: false },
			async () => {
				await withPage(async (page) => {
					const firstUrl = "http://127.0.0.1:43210/first";
					const failingCommand =
						command[0] === "diff" ? ["diff", "url", firstUrl, requestedUrl] : command;
					await page.patch({ failDestination: true });
					const result = await page.call(
						batch
							? { args: ["batch"], stdin: JSON.stringify([failingCommand]) }
							: { args: failingCommand },
					);
					assert.equal(result.isError, true);
					const expected = command[0] === "window" ? "about:blank" : firstUrl;
					assert.equal(readRecord(result.details?.sessionTabTarget).url, expected);
					assert.equal(
						readRecord(result.details?.refSnapshotInvalidation).reason,
						"page-transition",
					);
					const snapshot = await page.call({ args: ["snapshot", "-i"] });
					assert.equal(snapshot.isError, false, snapshot.content[0].text);
					assert.equal(readRecord(snapshot.details?.data).origin, expected);
					assert.equal(
						(await page.calls()).some(
							(row) => extractUpstreamCommandTokens(row.args)[0] === "open",
						),
						false,
					);
				});
			},
		);
	}
	for (const bail of [false, true]) {
		test(
			`native batch folds only reached ${command[0]} rows (bail=${bail})`,
			{ concurrency: false },
			async () => {
				await withPage(async (page) => {
					const args = ["batch", ...(bail ? ["--bail"] : [])];
					const planned = [["console", "--clear"], ["not-a-command"], command];
					const destinationUrl = command[0] === "window" ? "about:blank" : redirectedUrl;
					const stdin = JSON.stringify(planned);
					const result = await page.call({ args, stdin });
					assert.equal(result.isError, true);
					const rows = readArray(result.details?.batchSteps).map(readRecord);
					assert.deepEqual(
						rows.map((row) => row.command),
						bail ? planned.slice(0, 2) : planned,
					);
					assert.deepEqual(
						rows.map((row) => row.success),
						bail ? [true, false] : [true, false, true],
					);
					const snapshot = await page.call({ args: ["snapshot", "-i"] });
					assert.equal(snapshot.isError, false, snapshot.content[0].text);
					assert.equal(
						readRecord(snapshot.details?.data).origin,
						bail ? rememberedUrl : destinationUrl,
					);
					const batches = (await page.calls()).filter(
						(row) => extractUpstreamCommandTokens(row.args)[0] === "batch",
					);
					assert.equal(batches.length, 1);
					assert.deepEqual(extractUpstreamCommandTokens(batches[0].args), args);
					assert.equal(batches[0].stdin, stdin);
					if (bail) {
						// This enumerated fixture branch (bail) has variant-specific assertions; common assertions cover every case.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							result.details?.refSnapshotInvalidation,
							undefined,
							"unreached transitions cannot invalidate the old snapshot",
						);
					}
				});
			},
		);
	}
	test(
		`native ${command[0]} batch keeps a later snapshot without requiring bail or get url`,
		{ concurrency: false },
		async () => {
			await withPage(async (page) => {
				const stdin = JSON.stringify([command, ["snapshot", "-i"], ["not-a-command"]]);
				const result = await page.call({ args: ["batch"], stdin });
				assert.equal(result.isError, true, "the native trailing error must still fail the call");
				assert.deepEqual(
					readArray(result.details?.batchSteps)
						.map(readRecord)
						.map((row) => row.success),
					[true, true, false],
				);
				assert.equal(
					result.details?.refSnapshotInvalidation,
					undefined,
					"the later fresh snapshot clears the transition invalidation",
				);
				assert.equal(
					readRecord(readRecord(result.details?.refSnapshot).target).url,
					command[0] === "window" ? "about:blank" : redirectedUrl,
				);
				const batches = (await page.calls()).filter(
					(row) => extractUpstreamCommandTokens(row.args)[0] === "batch",
				);
				assert.equal(batches.length, 1);
				assert.deepEqual(extractUpstreamCommandTokens(batches[0].args), ["batch"]);
				assert.equal(batches[0].stdin, stdin);
			});
		},
	);
	test(
		`unobserved ${command[0]} batch retires earlier snapshot targets instead of guessing`,
		{ concurrency: false },
		async () => {
			await withPage(async (page) => {
				await page.patch({ failUrlProbe: true });
				const result = await page.call({
					args: ["batch"],
					stdin: JSON.stringify([["snapshot", "-i"], command]),
				});
				assert.equal(result.isError, false, result.content[0].text);
				assert.equal(result.details?.sessionTabTarget, undefined);
				assert.equal(result.details?.sessionTabTargetUnknown, true);
				assert.equal(result.details.refSnapshot, undefined);
				await page.reload();
				const guarded = await page.call({ args: ["snapshot", "-i"] });
				assert.equal(
					guarded.isError,
					true,
					"without an observed URL the old page cannot be trusted",
				);
				await page.patch({ failUrlProbe: false });
				assert.equal((await page.call({ args: ["get", "url"] })).isError, false);
				const snapshot = await page.call({ args: ["snapshot", "-i"] });
				assert.equal(snapshot.isError, false, snapshot.content[0].text);
				assert.equal(
					readRecord(snapshot.details?.data).origin,
					command[0] === "window" ? "about:blank" : redirectedUrl,
				);
			});
		},
	);
}

for (const batch of [false, true]) {
	test(
		`URL-diff blank redirect does not reselect a remembered duplicate tab (batch=${batch})`,
		{ concurrency: false },
		async () => {
			await withPage(async (page) => {
				await page.patch({
					pages: ["t1", "t2"].map((tabId) => ({ tabId, title: "Page", url: rememberedUrl })),
					selected: "t2",
					redirectedUrl: "about:blank",
				});
				const result = await page.call(
					batch
						? { args: ["batch"], stdin: JSON.stringify([destinations[1]]) }
						: { args: destinations[1] },
				);
				assert.equal(result.isError, false, result.content[0].text);
				const snapshot = await page.call({ args: ["snapshot", "-i"] });
				assert.equal(snapshot.isError, false, snapshot.content[0].text);
				assert.equal(readRecord(snapshot.details?.data).origin, "about:blank");
				assert.equal(readRecord(result.details?.sessionTabTarget).url, "about:blank");
				assert.equal(result.details?.aboutBlankSessionMismatch, undefined);
				assert.equal((await page.state()).selected, "t2");
				assert.equal(
					(await page.calls()).some(
						(row) => JSON.stringify(extractUpstreamCommandTokens(row.args)) === '["tab","t1"]',
					),
					false,
				);
			});
		},
	);
}

test(
	"raw URL-diff batch preserves argv and ignores the stdin window destination",
	{ concurrency: false },
	async () => {
		await withPage(
			async (page) => {
				const args = ["batch", `diff url ${rememberedUrl} ${requestedUrl}`];
				const stdin = JSON.stringify([["window", "new"]]);
				const result = await page.call({ args, stdin });
				assert.equal(result.isError, false, result.content[0].text);
				assert.equal(readRecord(result.details?.sessionTabTarget).url, redirectedUrl);
				assert.equal((await page.state()).pages.length, 1);
				const batch = (await page.calls()).find((row) => row.args.includes("batch"));
				assert.ok(batch);
				assert.deepEqual(batch.args.slice(-args.length), args);
				assert.equal(batch.stdin, stdin);
				assert.deepEqual(
					readArray(result.details?.batchSteps)
						.map(readRecord)
						.map((row) => row.command),
					[destinations[1]],
				);
			},
			{ callerOwned: true },
		);
	},
);

test(
	"cancellation before a cold reopen preserves the obligation without navigation",
	{ concurrency: false },
	async () => {
		await withPage(
			async (page) => {
				const prefix = await page.call({ args: ["tab", "list"] });
				assert.equal(prefix.details?.sessionTabReopenPending, true);
				const controller = new AbortController();
				controller.abort(new Error("cancel before cold reopen"));
				assert.equal(
					(await page.call({ args: ["snapshot", "-i"] }, controller.signal)).isError,
					true,
				);
				assert.equal(
					(await page.calls()).some((row) => extractUpstreamCommandTokens(row.args)[0] === "open"),
					false,
				);
				const snapshot = await page.call({ args: ["snapshot", "-i"] });
				assert.equal(snapshot.isError, false, snapshot.content[0].text);
				assert.equal(readRecord(snapshot.details?.data).origin, rememberedUrl);
				await page.reload();
				assert.equal((await page.call({ args: ["snapshot", "-i"] })).isError, false);
				assert.deepEqual(
					(await page.calls())
						.filter((row) => extractUpstreamCommandTokens(row.args)[0] === "open")
						.map((row) => extractUpstreamCommandTokens(row.args)),
					[["open", rememberedUrl]],
				);
			},
			{ cold: true },
		);
	},
);

test(
	"cancellation after a cold reopen persists the consumed identity through replay",
	{ concurrency: false },
	async () => {
		await withPage(
			async (page) => {
				const prefix = await page.call({ args: ["tab", "list"] });
				assert.equal(prefix.details?.sessionTabReopenPending, true);
				await page.patch({ holdNextOpen: true });
				const controller = new AbortController();
				const pending = page.call({ args: ["snapshot", "-i"] }, controller.signal);
				let pid = 0;
				let aborted: Awaited<ReturnType<Page["call"]>>;
				try {
					const deadline = Date.now() + 5000;
					while (pid === 0 || Number.isNaN(pid)) {
						try {
							// Observe the current fixture receipt before deciding whether the next poll or state transition may proceed.
							// oxlint-disable-next-line no-await-in-loop
							pid = Number(await readFile(page.marker, "utf8"));
						} catch (error) {
							if (!hasErrorCode(error, "ENOENT")) {
								throw error;
							}
						}
						// The cancellation fixture starts with no PID; every receipt poll must meet the original deadline before abort.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(
							Date.now() < deadline,
							"cold open must reach its native navigation before cancellation",
						);
						if (pid === 0 || Number.isNaN(pid)) {
							// Wait between receipt polls so the fixture process can advance before the next observation.
							// oxlint-disable-next-line no-await-in-loop
							await delay(5);
						}
					}
				} finally {
					controller.abort(new Error("cancel after native cold navigation"));
					aborted = await pending;
				}
				const abortedDetails = readRecord(aborted.details);
				assert.throws(
					() => process.kill(pid, 0),
					{ code: "ESRCH" },
					"the aborted CLI process must be reaped",
				);
				const state = await page.state();
				assert.equal(state.active, true, "native navigation may finish while the CLI is aborted");
				assert.equal(state.pages.find((tab) => tab.tabId === state.selected)?.url, rememberedUrl);
				assert.deepEqual(
					extractUpstreamCommandTokens(
						readArray(readRecord((await page.calls()).at(-1)).args).map(readString),
					),
					["open", rememberedUrl],
					"no browser helper or main command may run after cancellation",
				);
				await page.reload();
				const snapshot = await page.call({ args: ["snapshot", "-i"] });
				assert.equal(snapshot.isError, false, snapshot.content[0].text);
				assert.equal(readRecord(snapshot.details?.data).origin, rememberedUrl);
				assert.deepEqual(
					{
						isError: aborted.isError,
						aborted: abortedDetails.aborted,
						resultCategory: abortedDetails.resultCategory,
						failureCategory: abortedDetails.failureCategory,
						sessionName: abortedDetails.sessionName,
						namespace: abortedDetails.namespace,
						usedImplicitSession: abortedDetails.usedImplicitSession,
						sessionTabReopenPending: abortedDetails.sessionTabReopenPending,
						refInvalidation: readRecord(abortedDetails.refSnapshotInvalidation).reason,
						openAttempts: (await page.calls()).filter(
							(row) => extractUpstreamCommandTokens(row.args)[0] === "open",
						).length,
					},
					{
						isError: true,
						aborted: true,
						resultCategory: "failure",
						failureCategory: "aborted",
						sessionName: page.sessionName,
						namespace,
						usedImplicitSession: true,
						sessionTabReopenPending: false,
						refInvalidation: "page-transition",
						openAttempts: 1,
					},
				);
			},
			{ cold: true },
		);
	},
);
