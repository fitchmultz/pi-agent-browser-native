import assert from "node:assert/strict";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	createShortPrivateSocketDir,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

type ResumedPage = {
	readonly branch: readonly unknown[];
	readonly harness: Readonly<
		Pick<ReturnType<typeof createExtensionHarness>, "tool" | "ctx" | "setBranch">
	> & { readonly handlers: Parameters<typeof runExtensionEvent>[0] };
	readonly logPath: string;
	readonly statePath: string;
	readonly sessionName: string;
	readonly url: string;
};

async function withResumedPages(
	run: (row: (run: (page: ResumedPage) => Promise<void>) => Promise<void>) => Promise<void>,
	options: { readonly confirmActions?: string } = {},
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "cold-"));
	const socketDir = createShortPrivateSocketDir(root);
	const cwd = join(root, "g");
	const home = join(root, "h");
	const logPath = join(root, "calls.jsonl");
	const statePath = join(root, "browser.json");
	const url = "http://127.0.0.1:43210/remembered/page";
	await Promise.all([cwd, home].map((path) => mkdir(path, { mode: 0o700 })));
	execFileSync("git", ["init", "-q", cwd]);
	await writeFakeAgentBrowserBinary(
		root,
		`const fs = require('node:fs');
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin, namespace: process.env.AGENT_BROWSER_NAMESPACE }) + '\\n');
let state = { active: false, url: 'about:blank', restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8')); } catch {}
let start = 0;
while (args[start]?.startsWith('--')) start += args[start] === '--json' ? 1 : 2;
const tokens = args.slice(start);
function execute(tokens) {
  if (tokens[0] === 'session') return tokens[1] === 'info' ? { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey, backgroundPid: ${process.pid}, socketDir: process.env.AGENT_BROWSER_SOCKET_DIR, browserLaunched: true } : null } : { sessions: [] };
  if (tokens[0] === 'close') { state = { active: false, url: 'about:blank', restoreKey: null }; return { closed: true }; }
  if (tokens[0] === 'read' && tokens.some((token) => token.startsWith('http:'))) return { content: 'Fetched page', source: 'http', url: tokens.at(-1) };
  if (!state.active) { state.active = true; state.restoreKey = process.env.AGENT_BROWSER_RESTORE ?? null; }
  if (tokens[0] === 'open' && state.requireConfirmation) { state.pendingUrl = tokens[1]; return { confirmation_required: true, confirmation_id: 'cold-open', action: 'navigate' }; }
  if (tokens[0] === 'confirm' && tokens[1] === 'cold-open' && state.pendingUrl) { state.url = state.pendingUrl; delete state.pendingUrl; return { confirmed: true, action: 'navigate', result: { success: true, data: { url: state.url, title: 'Page' } } }; }
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
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);
	try {
		await withPatchedEnv(
			{
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
				HOME: home,
				USERPROFILE: home,
				// Exercise enabled automatic restore on Windows as well as POSIX.
				AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
				AGENT_BROWSER_NAMESPACE: "",
				AGENT_BROWSER_CONFIG: undefined,
				PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
				PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
				PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
			},
			async () => {
				const bootstrapBranch: unknown[] = [];
				const prefix = ["--namespace", "cold"];
				const first = createExtensionHarness({ branch: bootstrapBranch, cwd });
				await runExtensionEvent(first.handlers, "session_start", { reason: "new" }, first.ctx);
				let sessionName = "";
				for (const args of [
					[...prefix, "open", url],
					[...prefix, "snapshot", "-i"],
				]) {
					// The snapshot must observe the preceding open and its persisted session identity.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(first.tool, first.ctx, {
						args:
							args.includes("open") && options.confirmActions !== undefined
								? ["--confirm-actions", options.confirmActions, ...args]
								: args,
						...(args.includes("open") ? { sessionMode: "fresh" as const } : {}),
					});
					assert.equal(result.isError, false, result.content[0]?.text);
					if (sessionName.length === 0) {
						assert.equal(typeof readRecord(result.details).sessionName, "string");
						sessionName = readString(readRecord(result.details).sessionName);
					}
					bootstrapBranch.push(
						createToolBranchEntry({ details: readRecord(result.details), isError: result.isError }),
					);
				}
				await runExtensionEvent(first.handlers, "session_shutdown", { reason: "quit" }, first.ctx);
				const baselineBranch = structuredClone(first.ctx.sessionManager.getBranch());
				const baselineNative = await readFile(statePath, "utf8");
				await run(async (runRow) => {
					const branch = structuredClone(baselineBranch);
					await writeFile(statePath, baselineNative);
					const harness = createExtensionHarness({ branch, cwd });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "resume" },
						harness.ctx,
					);
					await writeFile(logPath, "");
					try {
						await runRow({ branch, harness, logPath, statePath, sessionName, url });
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

async function withResumedPage(
	run: (page: ResumedPage) => Promise<void>,
	options: { readonly confirmActions?: string } = {},
): Promise<void> {
	await withResumedPages((row) => row(run), options);
}

test(
	"cold resume reopens before page reads and discards old refs",
	{ concurrency: false },
	async () => {
		await withResumedPages(async (withRow) => {
			const check = (params: { readonly args: readonly string[]; readonly stdin?: string }) =>
				withRow(async ({ harness, logPath, sessionName, url }) => {
					const result = await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "unrelated" }, () =>
						executeRegisteredTool(harness.tool, harness.ctx, params),
					);
					assert.equal(result.isError, false, result.content[0]?.text);
					assert.equal(readRecord(result.details).sessionName, sessionName);
					assert.equal(readRecord(result.details).namespace, "cold");
					assert.equal(readRecord(readRecord(result.details).sessionTabTarget).url, url);
					assert.equal(readRecord(result.details).refSnapshot, undefined);
					assert.equal(
						readRecord(readRecord(result.details).refSnapshotInvalidation).reason,
						"page-transition",
					);
					const initialCalls = await readInvocationLog(logPath);
					const openIndex = initialCalls.findIndex((row) => row.args.includes("open"));
					const commandIndex = initialCalls.findIndex(
						(row) => row.args.slice(-params.args.length).join("\\0") === params.args.join("\\0"),
					);
					assert.ok(openIndex >= 0 && commandIndex > openIndex, JSON.stringify(initialCalls));
					const stale = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "value", "@e1"],
					});
					assert.equal(stale.isError, true);
					assert.equal(stale.details?.failureCategory, "stale-ref");
					const fresh = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(fresh.isError, false, fresh.content[0]?.text);
					assert.equal(fresh.details?.refSnapshotInvalidation, undefined);
					const current = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "value", "@e1"],
					});
					assert.equal(current.isError, false, current.content[0]?.text);
					const opens = (await readInvocationLog(logPath)).filter((row) =>
						row.args.includes("open"),
					);
					assert.equal(opens.length, 1, "only the first cold read reopens the page");
					assert.deepEqual(opens[0]?.args, [
						"--json",
						"--namespace",
						"cold",
						"--session",
						sessionName,
						"open",
						url,
					]);
				});
			for (const params of [
				{ args: ["get", "url"] },
				{ args: ["get", "title"] },
				{ args: ["read"] },
				{
					args: ["batch", "--bail"],
					stdin: JSON.stringify([
						["get", "url"],
						["get", "title"],
					]),
				},
			]) {
				// Each row resets branch/native state and completes shutdown before the next.
				// oxlint-disable-next-line no-await-in-loop
				await check(params);
			}
		});
	},
);

test(
	"cold resume preserves explicit navigation and sessionless intent",
	{ concurrency: false },
	async (t) => {
		await withResumedPages(async (withRow) => {
			for (const params of [
				{ args: ["open", "http://127.0.0.1:43210/chosen"] },
				{ qa: { url: "http://127.0.0.1:43210/chosen" } },
				{
					args: ["batch", "--bail"],
					stdin: JSON.stringify([
						["open", "http://127.0.0.1:43210/chosen"],
						["snapshot", "-i"],
					]),
				},
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
				// Each subtest owns a process-global environment and must complete cleanup before the next.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(JSON.stringify(params), async () =>
					withRow(async ({ harness, logPath, statePath, url }) => {
						const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
						assert.equal(result.isError, false, result.content[0]?.text);
						assert.equal(
							(await readInvocationLog(logPath)).some(
								(row) => row.args.includes("open") && row.args.includes(url),
							),
							false,
							"the old URL must not be opened ahead of explicit intent",
						);
						if (["read", "session", "--version"].includes(params.args?.[0] ?? "")) {
							// The explicitly sessionless fixture variants must stay closed; all variants assert success above.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								readRecord(JSON.parse(await readFile(statePath, "utf8"))).active,
								false,
								"a sessionless or explicit HTTP read must not launch a browser",
							);
						}
					}),
				);
			}
		});
	},
);

test(
	"cold resume verifies the reopened page before a read and retains ref invalidation on failure",
	{ concurrency: false },
	async () => {
		await withResumedPage(async ({ harness, logPath, statePath }) => {
			const state = readRecord(JSON.parse(await readFile(statePath, "utf8")));
			await writeFile(
				statePath,
				JSON.stringify({ ...state, redirectUrl: "http://127.0.0.1:43210/unexpected" }),
			);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["get", "title"],
			});
			assert.equal(result.isError, true);
			assert.equal(readRecord(result.details).resultCategory, "failure");
			assert.equal(readRecord(result.details).failureCategory, "tab-drift");
			assert.equal(readRecord(result.details).data, undefined);
			assert.equal(
				readRecord(readRecord(result.details).refSnapshotInvalidation).reason,
				"page-transition",
			);
			harness.setBranch(harness.ctx.sessionManager.getBranch().slice());
			await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
			const stale = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["get", "value", "@e1"],
			});
			assert.equal(stale.details?.failureCategory, "stale-ref");
			const retry = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["snapshot", "-i"],
			});
			assert.equal(retry.details?.failureCategory, "tab-drift");
			const calls = await readInvocationLog(logPath);
			assert.equal(
				calls.filter((row) => row.args.includes("open")).length,
				1,
				"a failed reopen is not permission to navigate a now-live browser again",
			);
			assert.equal(
				calls.some((row) => row.args.at(-1) === "title" || row.args.includes("snapshot")),
				false,
			);
		});
	},
);

test(
	"cold retained-policy reopen exposes its native decision and exact confirm without replaying open",
	{ concurrency: false },
	async () => {
		await withResumedPage(
			async ({ harness, statePath, logPath, sessionName, url }) => {
				await writeFile(
					statePath,
					JSON.stringify({
						...readRecord(JSON.parse(await readFile(statePath, "utf8"))),
						requireConfirmation: true,
					}),
				);
				const pending = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "title"],
				});
				assert.equal(
					readRecord(pending.details).failureCategory,
					"confirmation-required",
					pending.content[0]?.text,
				);
				assert.equal(
					readRecord(pending.details).agentBrowserStarted,
					false,
					"the requested getter did not dispatch",
				);
				assert.equal(readRecord(pending.details).sessionTabTargetUnknown, true);
				assert.notEqual(
					readRecord(pending.details).sessionTabReopenPending,
					true,
					"the started reopen is consumed, not silently replayed",
				);
				const approval = readArray(readRecord(pending.details).nextActions)
					.map(readRecord)
					.find((action) => action.id === "approve-confirmation");
				assert.ok(approval);
				assert.deepEqual(readRecord(approval.params).args, [
					"--namespace",
					"cold",
					"--session",
					sessionName,
					"confirm",
					"cold-open",
				]);
				harness.setBranch(harness.ctx.sessionManager.getBranch().slice());
				await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
				await writeFile(logPath, "");
				const confirmed = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: readArray(readRecord(approval.params).args).map(readString),
				});
				assert.equal(confirmed.isError, false, confirmed.content[0]?.text);
				const title = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "title"],
				});
				assert.equal(title.isError, false, title.content[0]?.text);
				assert.equal(readRecord(title.details?.sessionTabTarget).url, url);
				const calls = await readInvocationLog(logPath);
				const firstBrowserCall = calls.find((call) => !call.args.includes("session"));
				assert.equal(
					firstBrowserCall?.args.at(-2),
					"confirm",
					"no pre-confirm page helper can overwrite the native slot",
				);
				assert.equal(
					calls.some((call) => call.args.includes("open")),
					false,
				);
			},
			{ confirmActions: "navigate" },
		);
	},
);

test(
	"explicit close keeps the recorded URL retired on resume",
	{ concurrency: false },
	async () => {
		await withResumedPage(async ({ branch, harness, logPath, sessionName, url }) => {
			const closed = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--namespace", "cold", "--session", sessionName, "close"],
			});
			assert.equal(closed.isError, false, closed.content[0]?.text);
			harness.setBranch([
				...branch,
				createToolBranchEntry({ details: readRecord(closed.details), isError: false }),
			]);
			await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
			const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(read.isError, false, read.content[0]?.text);
			assert.notEqual(read.details?.sessionName, sessionName);
			assert.equal(
				(await readInvocationLog(logPath)).some(
					(row) => row.args.includes("open") && row.args.includes(url),
				),
				false,
			);
		});
	},
);
