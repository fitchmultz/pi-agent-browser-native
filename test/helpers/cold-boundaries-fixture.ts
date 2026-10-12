import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { readRecord, readArray, readString, readBoolean } from "./assertions.js";
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
} from "./agent-browser-harness.js";

export const rememberedUrl = "http://127.0.0.1:43210/remembered/page";

export const chosenUrl = "http://127.0.0.1:43210/chosen";

export const hashRouteUrl = "http://127.0.0.1:43210/app#/reports/weekly?range=7d";

type Page = {
	readonly call: (
		params: AgentBrowserToolParams,
		signal?: AbortSignal,
	) => ReturnType<typeof executeRegisteredTool>;
	readonly calls: () => ReturnType<typeof readInvocationLog>;
	readonly patch: (patch: Readonly<Record<string, unknown>>) => Promise<void>;
	readonly reload: () => Promise<void>;
	readonly state: () => Promise<{
		readonly active: boolean;
		readonly browser: boolean;
		readonly url: string;
	}>;
	readonly tree: () => Promise<void>;
	readonly url: string;
};

export async function withPages(
	run: (row: (run: (page: Page) => Promise<void>) => Promise<void>) => Promise<void>,
	options: {
		readonly live?: boolean;
		readonly url?: string;
		readonly explicit?: boolean;
		readonly attached?: boolean;
		readonly restoreDisabled?: boolean;
	} = {},
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "cb-"));
	const socketDir = createShortPrivateSocketDir(root);
	const cwd = join(root, "g");
	const home = join(root, "h");
	const logPath = join(root, "calls.jsonl");
	const statePath = join(root, "browser.json");
	const url = options.url ?? rememberedUrl;
	await Promise.all([cwd, home].map((path) => mkdir(path, { mode: 0o700 })));
	execFileSync("git", ["init", "-q", cwd]);
	// Native HTTP reads and session info leave cold browsers untouched; tab list launches the browser.
	await writeFakeAgentBrowserBinary(
		root,
		`const fs = require('node:fs');
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
  const explicitRead = command === 'read' && urlOperand(row) !== undefined;
  if (explicitRead) return { content: 'HTTP-only read', source: 'http', url: urlOperand(row) };
  if (!state.active) { state.active = true; state.restoreKey = process.env.AGENT_BROWSER_RESTORE ?? null; }
  if (!state.browser) { state.browser = true; state.url = ${JSON.stringify(new URL(url).origin + "/")}; }
  if (state.failNext === command) { delete state.failNext; throw new Error('Fixture command failed'); }
  if (command === 'not-a-command') throw new Error('Unknown command: not-a-command');
  if (['open', 'goto', 'navigate', 'a11y', 'vitals', 'web-vitals'].includes(command)) state.url = urlOperand(row) ?? (command === 'open' ? 'about:blank' : state.url);
  if (command === 'connect' || (command === 'state' && subcommand === 'load')) { state.url = ${JSON.stringify(chosenUrl)}; return { connected: true }; }
  if (command === 'webmcp') return { invocationId: 'pending-job', status: 'pending' };
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
if (tokens[0] === 'session' && tokens[1] === 'info' && state.timeoutInfo) setInterval(() => {}, 1000);
else {
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
process.exitCode = failed ? 1 : 0;
}`,
	);
	try {
		await withPatchedEnv(
			{
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
				HOME: home,
				USERPROFILE: home,
				AGENT_BROWSER_NAMESPACE: "",
				// Automatic restore requires upstream encryption on Windows; this is fixture data only.
				AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
				PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
				PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE:
					options.restoreDisabled === true ? "0" : undefined,
				PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
			},
			async () => {
				const bootstrapBranch: unknown[] = [];
				const prefix = [
					"--namespace",
					"cold",
					...(options.explicit === true ? ["--session", "caller"] : []),
				];
				const bootstrap = createExtensionHarness({ branch: bootstrapBranch, cwd });
				const bootstrapCall = async (params: AgentBrowserToolParams) => {
					const result = await executeRegisteredTool(bootstrap.tool, bootstrap.ctx, params);
					bootstrapBranch.push(
						createToolBranchEntry({ details: readRecord(result.details), isError: result.isError }),
					);
					return result;
				};
				await runExtensionEvent(
					bootstrap.handlers,
					"session_start",
					{ reason: "new" },
					bootstrap.ctx,
				);
				for (const args of [
					[...prefix, ...(options.attached === true ? ["connect", "9222"] : ["open", url])],
					...(options.attached === true ? [[...prefix, "get", "url"]] : []),
					[...prefix, "snapshot", "-i"],
				]) {
					// These dependent calls reuse the same page, restore state, and shutdown ownership.
					// oxlint-disable-next-line no-await-in-loop
					const result = await bootstrapCall({
						args,
						...(args.includes("open") ? { sessionMode: "fresh" as const } : {}),
					});
					assert.equal(result.isError, false, readString(readRecord(result.content[0]).text));
				}
				await runExtensionEvent(
					bootstrap.handlers,
					"session_shutdown",
					{ reason: options.live === true ? "reload" : "quit" },
					bootstrap.ctx,
				);
				const baselineBranch = structuredClone(bootstrap.ctx.sessionManager.getBranch());
				const baselineNative = await readFile(statePath, "utf8");
				await run(async (runRow) => {
					let branch = structuredClone(baselineBranch);
					await writeFile(statePath, baselineNative);
					let harness = createExtensionHarness({ branch, cwd });
					const call = async (params: AgentBrowserToolParams, signal?: AbortSignal) => {
						const result = await executeRegisteredTool(harness.tool, harness.ctx, params, signal);
						branch.push(
							createToolBranchEntry({
								details: readRecord(result.details),
								isError: result.isError,
							}),
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
						{ reason: "resume" },
						harness.ctx,
					);
					await writeFile(logPath, "");
					try {
						await runRow({
							call:
								options.explicit === true
									? (params, signal) =>
											call(
												{
													...params,
													args: [...prefix, ...readArray(params.args).map(readString)],
												},
												signal,
											)
									: call,
							calls: () => readInvocationLog(logPath),
							patch: async (patch) =>
								writeFile(
									statePath,
									JSON.stringify({
										...readRecord(JSON.parse(await readFile(statePath, "utf8"))),
										...patch,
									}),
								),
							reload: () => restore("reload"),
							state: async () => {
								const state = readRecord(JSON.parse(await readFile(statePath, "utf8")));
								return {
									...state,
									active: readBoolean(state.active),
									browser: readBoolean(state.browser),
									url: readString(state.url),
								};
							},
							tree: async () => {
								harness.setBranch(structuredClone(branch));
								await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
							},
							url,
						});
					} finally {
						await runExtensionEvent(
							harness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							harness.ctx,
						);
					}
				});
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(socketDir, { recursive: true, force: true });
	}
}

export async function withPage(
	run: (page: Page) => Promise<void>,
	options: {
		readonly live?: boolean;
		readonly url?: string;
		readonly explicit?: boolean;
		readonly attached?: boolean;
		readonly restoreDisabled?: boolean;
	} = {},
): Promise<void> {
	await withPages((row) => row(run), options);
}
