import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { setImmediate } from "node:timers/promises";
import { createImplicitSessionName } from "../extensions/agent-browser/lib/runtime.js";
import { readBrowserEntries } from "../extensions/agent-browser/lib/browser-journal.js";
import { getAgentBrowserSessionIdentityKey } from "../extensions/agent-browser/lib/argv-grammar.js";
import {
	TEST_SESSION_ID,
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";
import { readDefined, readRecord, readArray, readString } from "./helpers/assertions.js";
import {
	withConcurrencyTestTimeout,
	waitForInvocation,
	ownedSessionDetails,
} from "./helpers/resume-state-fixture.js";

for (const reason of ["reload", "quit"] as const) {
	nodeTest(
		`agentBrowserExtension recovers failed off-branch managed shutdown in a new instance (${reason})`,
		{ concurrency: false },
		async () => {
			const tempDir = await mkdtemp(join(tmpdir(), "piab-shutdown-retry-"));
			const logPath = join(tempDir, "invocations.log");
			const failurePath = join(tempDir, "fail");
			const socketDir = join(tempDir, "socket");
			await mkdir(socketDir, { mode: 0o700 });
			await writeFile(failurePath, "");
			await writeFakeAgentBrowserBinary(
				tempDir,
				`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd(), confirm: process.env.AGENT_BROWSER_CONFIRM_ACTIONS, socket: process.env.AGENT_BROWSER_SOCKET_DIR, autosave: process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS }) + "\\n");
const failed = args.includes("close") && fs.existsSync(${JSON.stringify(failurePath)});
process.stdout.write(JSON.stringify(failed ? { success: false, error: "close refused" } : { success: true, data: { closed: true } }));
process.exitCode = failed ? 1 : 0;`,
			);
			try {
				await withPatchedEnv(
					{
						PATH: `${tempDir}:${process.env.PATH ?? ""}`,
						AGENT_BROWSER_NAMESPACE: "unrelated",
						AGENT_BROWSER_CONFIRM_ACTIONS: "none",
					},
					async () => {
						const sessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
						const namespace = "cleanup-owner";
						const key = getAgentBrowserSessionIdentityKey(sessionName, namespace);
						const branch = [
							{
								type: "custom",
								customType: "agent-browser-transition",
								data: {
									event: {
										version: 1,
										phase: "state",
										operationId: "owned",
										toolCallId: "owned",
										commandIndex: 0,
										isError: false,
										state: {
											...ownedSessionDetails(sessionName),
											namespace,
											attachedBrowserSession: true,
											managedSessionSocketDir: socketDir,
											managedSessionCwd: tempDir,
											managedSessionHeadedAutosaveInterval: "0",
										},
										pages: [
											{ key, confirmActions: "all", refs: { kind: "unknown" }, unknown: true },
										],
									},
								},
							},
						];
						const harness = createExtensionHarness({ branch, cwd: tempDir });
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "resume" },
							harness.ctx,
						);
						harness.setBranch([]);
						await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
						const notifications: string[] = [];
						const ctx = {
							...harness.ctx,
							hasUI: true,
							ui: { notify: (message: string) => notifications.push(message) },
						};
						await runExtensionEvent(harness.handlers, "session_shutdown", { reason }, ctx);
						const persisted = await readBrowserEntries(harness.ctx.sessionManager);
						await rm(failurePath);
						const recovered = createExtensionHarness({ branch: [...persisted], cwd: tempDir });
						await runExtensionEvent(
							recovered.handlers,
							"session_start",
							{ reason: "reload" },
							recovered.ctx,
						);
						const closes = (await readInvocationLog(logPath)).filter((row) =>
							row.args.includes("close"),
						);
						assert.equal(closes.length, 2, "new runtime retries the failed off-branch close once");
						assert.ok(
							notifications.some(
								(message) =>
									message.includes(sessionName) &&
									message.includes(namespace) &&
									message.includes("close refused"),
							),
						);
						assert.deepEqual(
							closes.map((row) => row.args),
							Array.from({ length: 2 }, () => [
								"--namespace",
								namespace,
								"--session",
								sessionName,
								"close",
							]),
						);
						const expectedCwd = await realpath(tempDir);
						assert.deepEqual(
							closes.map((close) => ({
								confirm: readRecord(close).confirm,
								socket: readRecord(close).socket,
								autosave: close.autosave,
								cwd: readRecord(close).cwd,
							})),
							Array.from({ length: 2 }, () => ({
								confirm: "all",
								socket: socketDir,
								autosave: "0",
								cwd: expectedCwd,
							})),
						);
						await runExtensionEvent(
							recovered.handlers,
							"session_shutdown",
							{ reason: "quit" },
							recovered.ctx,
						);
						const again = createExtensionHarness({
							branch: [...(await readBrowserEntries(recovered.ctx.sessionManager))],
							cwd: tempDir,
						});
						await runExtensionEvent(
							again.handlers,
							"session_start",
							{ reason: "reload" },
							again.ctx,
						);
						assert.equal(
							(await readInvocationLog(logPath)).filter((row) => row.args.includes("close")).length,
							2,
							"terminal cleanup survives another reload",
						);
					},
				);
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		},
	);
}

for (const closeFails of [false, true]) {
	nodeTest(
		`agentBrowserExtension keeps cleanup best effort when journal publication fails (closeFails=${String(closeFails)})`,
		{ concurrency: false },
		async () => {
			const tempDir = await mkdtemp(join(tmpdir(), "piab-shutdown-append-"));
			const logPath = join(tempDir, "invocations.log");
			const appendError = new Error("shutdown append fault");
			const failurePath = join(tempDir, "fail-close");
			await writeFile(failurePath, String(closeFails));
			let rejectAppend = true;
			const notifications: string[] = [];
			await writeFakeAgentBrowserBinary(
				tempDir,
				`const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n"); const failed = fs.existsSync(${JSON.stringify(failurePath)}) && fs.readFileSync(${JSON.stringify(failurePath)}, "utf8") === "true"; process.stdout.write(JSON.stringify(failed ? { success: false, error: "native close refused" } : { success: true, data: { closed: true } })); process.exitCode = failed ? 1 : 0;`,
			);
			try {
				await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
					const name = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
					const harness = createExtensionHarness({
						cwd: tempDir,
						branch: [createToolBranchEntry({ details: ownedSessionDetails(name), isError: false })],
						onAppendEntry: () => {
							if (rejectAppend) {
								throw appendError;
							}
						},
					});
					await runExtensionEvent(harness.handlers, "session_start", {}, harness.ctx);
					harness.setBranch([]);
					await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
					const ctx = {
						...harness.ctx,
						hasUI: true,
						ui: { notify: (message: string) => notifications.push(message) },
					};
					await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, ctx);
					assert.equal(
						(await readInvocationLog(logPath)).length,
						1,
						"journal faults never gate cleanup of a proven live owner",
					);
					assert.ok(
						notifications.some(
							(message) =>
								message.includes(name) &&
								message.includes(appendError.message) &&
								message.includes("not confirmed"),
						),
					);
					await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, ctx);
					assert.equal((await readInvocationLog(logPath)).length, closeFails ? 2 : 1);
					assert.equal(
						notifications.some((message) => message.includes("could not read the journal")),
						closeFails,
						"unreadable journals use live owners; no owners need no journal read",
					);
					rejectAppend = false;
					await rm(failurePath);
					// Discard the failed native in-memory append; the published journal still has an empty branch.
					harness.setBranch([]);
					await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, ctx);
					assert.deepEqual(
						(await readInvocationLog(logPath)).map((row) => row.args),
						Array.from({ length: closeFails ? 3 : 1 }, () => ["--session", name, "close"]),
						"failed native cleanup retains live ownership for retry; successful cleanup retires it",
					);
				});
			} finally {
				await rm(tempDir, { force: true, recursive: true });
			}
		},
	);
}

for (const branchVisible of [false, true]) {
	nodeTest(
		`agentBrowserExtension classifies selected live branch after journal read failure (branchVisible=${String(branchVisible)})`,
		{ concurrency: false },
		async (t) => {
			const root = await mkdtemp(join(tmpdir(), "piab-shutdown-read-repair-"));
			const log = join(root, "calls.jsonl");
			let failNextAppend = true;
			const warnings: string[] = [];
			t.mock.method(console, "warn", (message: string) => warnings.push(message));
			await writeFakeAgentBrowserBinary(
				root,
				`require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n"); process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));`,
			);
			try {
				await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
					const name = createImplicitSessionName(TEST_SESSION_ID, root, "test-seed");
					const harness = createExtensionHarness({
						cwd: root,
						branch: [createToolBranchEntry({ details: ownedSessionDetails(name), isError: false })],
						onAppendEntry: () => {
							if (failNextAppend) {
								failNextAppend = false;
								throw new Error("one append fault");
							}
						},
					});
					await runExtensionEvent(harness.handlers, "session_start", {}, harness.ctx);
					if (!branchVisible) {
						harness.setBranch([]);
						await runExtensionEvent(harness.handlers, "session_tree", {}, harness.ctx);
					}
					const fault = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "fault-probe", "open", "https://example.com/unused"],
					});
					assert.equal(fault.isError, true);
					const missing = harness.ctx.sessionManager.getEntry(
						readString(harness.ctx.sessionManager.getLeafId()),
					);
					await assert.rejects(readBrowserEntries(harness.ctx.sessionManager), /not persisted/);
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: branchVisible ? "quit" : "reload" },
						harness.ctx,
					);
					assert.equal(
						(await readInvocationLog(log)).filter((row) => row.args.includes("close")).length,
						1,
					);
					assert.ok(warnings.some((message) => message.includes("could not read the journal")));
					await appendFile(
						readString(harness.ctx.sessionManager.getSessionFile()),
						`${JSON.stringify(missing)}\n`,
					);
					const recovered = createExtensionHarness({
						cwd: root,
						branch: [...(await readBrowserEntries(harness.ctx.sessionManager))],
					});
					await runExtensionEvent(
						recovered.handlers,
						"session_start",
						{ reason: "resume" },
						recovered.ctx,
					);
					await runExtensionEvent(
						recovered.handlers,
						"session_shutdown",
						{ reason: "quit" },
						recovered.ctx,
					);
					assert.equal(
						(await readInvocationLog(log)).filter((row) => row.args.includes("close")).length,
						branchVisible ? 2 : 1,
						"only selected-branch owners remain cold-resumable after repairing the journal",
					);
				});
			} finally {
				await rm(root, { force: true, recursive: true });
			}
		},
	);
}

function closedSessionDetails(sessionName: string) {
	return {
		args: ["--session", sessionName, "close"],
		command: "close",
		exitCode: 0,
		managedSessionOutcome: {
			activeAfter: false,
			activeBefore: true,
			attemptedSessionName: sessionName,
			currentSessionName: sessionName,
			previousSessionName: sessionName,
			sessionMode: "auto",
			status: "closed",
			succeeded: true,
			summary: `Managed session ${sessionName} was closed.`,
		},
		resultCategory: "success",
		sessionMode: "auto",
		sessionName,
		usedImplicitSession: false,
	};
}

function failedReplacementDetails(currentSessionName: string, replacedSessionName: string) {
	return {
		args: ["open", "https://example.com/current"],
		command: "open",
		exitCode: 0,
		managedSessionOutcome: {
			activeAfter: true,
			activeBefore: true,
			attemptedSessionName: currentSessionName,
			currentSessionName,
			previousSessionName: replacedSessionName,
			replacedSessionClosed: false,
			replacedSessionName,
			sessionMode: "fresh",
			status: "replaced",
			succeeded: true,
			summary: `Managed session ${replacedSessionName} was replaced by ${currentSessionName}. Previous session ${replacedSessionName} remains wrapper-owned because automatic close failed; retry an explicit close.`,
		},
		resultCategory: "success",
		sessionMode: "fresh",
		sessionName: currentSessionName,
		usedImplicitSession: false,
	};
}

nodeTest(
	"agentBrowserExtension closes all branch-owned managed sessions on quit",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-owned-multi-cleanup-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close") } }));`,
		);
		const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
		const branchASessionName = baseSessionName;
		const branchBSessionName = `${baseSessionName}-fresh-branch-b`;
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					branch: [
						createToolBranchEntry({
							details: ownedSessionDetails(branchASessionName, "auto"),
							isError: false,
						}),
					],
					cwd: tempDir,
				});
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);
				harness.setBranch([
					createToolBranchEntry({
						details: ownedSessionDetails(branchBSessionName, "fresh"),
						isError: false,
					}),
				]);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-b", oldLeafId: "branch-a" },
					harness.ctx,
				);
				await runExtensionEvent(
					harness.handlers,
					"session_shutdown",
					{ reason: "quit" },
					harness.ctx,
				);

				const closeArgs = (await readInvocationLog(logPath))
					.map((entry) => entry.args)
					.filter((args) => args.includes("close"));
				const sortCloseArgs = (rows: readonly (readonly string[])[]) =>
					rows.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
				assert.deepEqual(
					sortCloseArgs(closeArgs),
					sortCloseArgs([
						["--session", branchASessionName, "close"],
						["--session", branchBSessionName, "close"],
					]),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension closes off-branch owned managed sessions during reload",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-reload-cleanup-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close") } }));`,
		);
		const branchASessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const firstHarness = createExtensionHarness({
					branch: [
						createToolBranchEntry({
							details: ownedSessionDetails(branchASessionName),
							isError: false,
						}),
					],
					cwd: tempDir,
				});
				await runExtensionEvent(
					firstHarness.handlers,
					"session_start",
					{ reason: "resume" },
					firstHarness.ctx,
				);
				firstHarness.setBranch([]);
				await runExtensionEvent(
					firstHarness.handlers,
					"session_tree",
					{ newLeafId: null, oldLeafId: "branch-a" },
					firstHarness.ctx,
				);
				await runExtensionEvent(
					firstHarness.handlers,
					"session_shutdown",
					{ reason: "reload" },
					firstHarness.ctx,
				);

				let closeArgs = (await readInvocationLog(logPath))
					.map((entry) => entry.args)
					.filter((args) => args.includes("close"));
				assert.deepEqual(closeArgs, [["--session", branchASessionName, "close"]]);

				const reloadedHarness = createExtensionHarness({ branch: [], cwd: tempDir });
				await runExtensionEvent(
					reloadedHarness.handlers,
					"session_start",
					{ reason: "reload" },
					reloadedHarness.ctx,
				);
				await runExtensionEvent(
					reloadedHarness.handlers,
					"session_shutdown",
					{ reason: "quit" },
					reloadedHarness.ctx,
				);
				closeArgs = (await readInvocationLog(logPath))
					.map((entry) => entry.args)
					.filter((args) => args.includes("close"));
				assert.deepEqual(closeArgs, [["--session", branchASessionName, "close"]]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

for (const { label, shutdown, shutdownCloses } of [
	{ label: "reload", shutdown: { reason: "reload" }, shutdownCloses: ["off-branch", "leftover"] },
	{
		label: "managed restart handoff",
		shutdown: { reason: "quit", disposition: "handoff" },
		shutdownCloses: ["off-branch"],
	},
	{
		label: "provisional managed restart",
		shutdown: { reason: "quit", disposition: "provisional" },
		shutdownCloses: ["off-branch"],
	},
] as const) {
	nodeTest(
		`agentBrowserExtension retires only untransferable managed sessions on ${label}`,
		{ concurrency: false },
		async () => {
			const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restart-transfer-"));
			const logPath = join(tempDir, "invocations.log");
			const basePath = process.env.PATH ?? "";
			await writeFakeAgentBrowserBinary(
				tempDir,
				`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close") } }));`,
			);
			const baseName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const names = {
				current: `${baseName}-fresh-current`,
				leftover: `${baseName}-fresh-leftover`,
				"off-branch": baseName,
			};
			const closedNames = async () =>
				(await readInvocationLog(logPath))
					.map((entry) => entry.args)
					.filter((args) => args.includes("close"))
					.map((args) => readString(args[1]));
			try {
				await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
					const harness = createExtensionHarness({
						branch: [
							createToolBranchEntry({
								details: ownedSessionDetails(names["off-branch"]),
								isError: false,
							}),
						],
						cwd: tempDir,
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "resume" },
						harness.ctx,
					);
					const activeBranch = [
						createToolBranchEntry({
							details: ownedSessionDetails(names.leftover, "fresh"),
							isError: false,
						}),
						createToolBranchEntry({
							details: failedReplacementDetails(names.current, names.leftover),
							isError: false,
						}),
					];
					harness.setBranch(activeBranch);
					await runExtensionEvent(
						harness.handlers,
						"session_tree",
						{ newLeafId: "branch-b", oldLeafId: "branch-a" },
						harness.ctx,
					);
					await runExtensionEvent(harness.handlers, "session_shutdown", shutdown, harness.ctx);
					assert.deepEqual(
						(await closedNames()).toSorted(),
						shutdownCloses.map((name) => names[name]).toSorted(),
					);

					await writeFile(logPath, "");
					const nextHarness = createExtensionHarness({ branch: activeBranch, cwd: tempDir });
					await runExtensionEvent(
						nextHarness.handlers,
						"session_start",
						{ reason: "resume" },
						nextHarness.ctx,
					);
					await runExtensionEvent(
						nextHarness.handlers,
						"session_shutdown",
						{ reason: "quit", disposition: "release" },
						nextHarness.ctx,
					);
					assert.deepEqual(
						(await closedNames()).toSorted(),
						[names.current, names.leftover].toSorted(),
					);
				});
			} finally {
				await rm(tempDir, { force: true, recursive: true });
			}
		},
	);
}

nodeTest(
	"agentBrowserExtension does not double-close a branch-restored explicit close during shutdown",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-close-tree-owned-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close") } }));`,
		);
		const ownedName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
		const freshName = `${ownedName}-fresh-later-active`;

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				for (const laterActive of [false, true]) {
					await t.test(laterActive ? "later active owner" : "closed only", async () => {
						await writeFile(logPath, "");
						const sourceBranch = [
							...Array.from({ length: 8 }, (_value, index) =>
								createToolBranchEntry({
									details: {
										args: ["get", "title"],
										command: "get",
										exitCode: 0,
										resultCategory: "success",
										title: `noise-${index}`,
									},
									isError: false,
								}),
							),
							createToolBranchEntry({ details: ownedSessionDetails(ownedName), isError: false }),
						];
						const harness = createExtensionHarness({ branch: sourceBranch, cwd: tempDir });
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "resume" },
							harness.ctx,
						);
						harness.setBranch([
							createToolBranchEntry({ details: ownedSessionDetails(ownedName), isError: false }),
							createToolBranchEntry({ details: closedSessionDetails(ownedName), isError: false }),
							...(laterActive
								? [
										createToolBranchEntry({
											details: ownedSessionDetails(freshName, "fresh"),
											isError: false,
										}),
									]
								: []),
						]);
						await runExtensionEvent(
							harness.handlers,
							"session_tree",
							{ newLeafId: "branch-closed", oldLeafId: "branch-open" },
							harness.ctx,
						);
						await runExtensionEvent(
							harness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							harness.ctx,
						);
						const closeArgs = (await readInvocationLog(logPath))
							.map((entry) => entry.args)
							.filter((args) => args.includes("close"));
						assert.deepEqual(closeArgs, laterActive ? [["--session", freshName, "close"]] : []);
					});
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension keeps same-process re-owned sessions despite stale branch close evidence",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-close-tree-stale-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
const data = args.includes("close")
  ? { closed: true }
  : { title: "Example Domain", url: "https://example.com/", sessionName };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);
		const sessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
		const branchOpen = [
			createToolBranchEntry({ details: ownedSessionDetails(sessionName), isError: false }),
		];
		const branchClosed = [
			createToolBranchEntry({ details: ownedSessionDetails(sessionName), isError: false }),
			createToolBranchEntry({ details: closedSessionDetails(sessionName), isError: false }),
		];

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ branch: branchOpen, cwd: tempDir });
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);
				harness.setBranch(branchClosed);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-closed", oldLeafId: "branch-open" },
					harness.ctx,
				);
				harness.setBranch(branchOpen);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-open", oldLeafId: "branch-closed" },
					harness.ctx,
				);

				const reactivation = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(reactivation.isError, false, JSON.stringify(reactivation));
				assert.equal(reactivation.details?.sessionName, sessionName);

				harness.setBranch([]);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: null, oldLeafId: "branch-open-reactivated" },
					harness.ctx,
				);
				harness.setBranch(branchOpen);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-open", oldLeafId: null },
					harness.ctx,
				);

				harness.setBranch(branchClosed);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-closed", oldLeafId: "branch-open" },
					harness.ctx,
				);
				await runExtensionEvent(
					harness.handlers,
					"session_shutdown",
					{ reason: "quit" },
					harness.ctx,
				);

				const closeArgs = (await readInvocationLog(logPath))
					.map((entry) => entry.args)
					.filter((args) => args.includes("close"));
				assert.deepEqual(closeArgs, [["--session", sessionName, "close"]]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension rotates away from the current managed session after explicit close",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-close-current-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
const data = args.includes("close")
  ? { closed: true }
  : { title: "Example Domain", url: "https://example.com/", sessionName };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://example.com/first"],
					sessionMode: "fresh",
				});
				assert.equal(open.isError, false, JSON.stringify(open));
				const firstSessionName = readString(open.details?.sessionName);

				const close = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", firstSessionName, "close"],
				});
				assert.equal(close.isError, false, JSON.stringify(close));
				assert.equal(readRecord(close.details?.managedSessionOutcome).status, "closed");
				assert.match(
					readDefined(close.content[0]).text ?? "",
					/Managed session outcome: The wrapper-managed browser session was closed; no managed browser session is current\./,
				);
				const rotatedSessionName = readString(
					readRecord(close.details?.managedSessionOutcome).currentSessionName,
				);
				assert.notEqual(rotatedSessionName, firstSessionName);
				assert.match(
					rotatedSessionName,
					new RegExp(
						`^${firstSessionName.replace(/-fresh-[a-f0-9]{10}$/, "")}-fresh-[a-f0-9]{10}$`,
					),
				);

				const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(followUp.isError, false, JSON.stringify(followUp));
				const firstFreshSessionName = readString(followUp.details?.sessionName);
				assert.match(
					firstFreshSessionName,
					new RegExp(
						`^${firstSessionName.replace(/-fresh-[a-f0-9]{10}$/, "")}-fresh-[a-f0-9]{10}$`,
					),
				);
				assert.equal(
					rotatedSessionName,
					firstFreshSessionName,
					"the close outcome must name the reserved rotated session the follow-up call reuses",
				);

				const closeFresh = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", firstFreshSessionName, "close"],
				});
				assert.equal(closeFresh.isError, false, JSON.stringify(closeFresh));
				const reservedAfterTree = readString(
					readRecord(closeFresh.details?.managedSessionOutcome).currentSessionName,
				);
				harness.setBranch(harness.ctx.sessionManager.getBranch().slice());
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "closed-fresh", oldLeafId: "live" },
					harness.ctx,
				);

				const finalFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(finalFollowUp.isError, false, JSON.stringify(finalFollowUp));
				const finalFreshSessionName = readString(finalFollowUp.details?.sessionName);
				assert.equal(finalFreshSessionName, reservedAfterTree);
				assert.match(
					finalFreshSessionName,
					new RegExp(
						`^${firstSessionName.replace(/-fresh-[a-f0-9]{10}$/, "")}-fresh-[a-f0-9]{10}$`,
					),
				);
				assert.notEqual(finalFreshSessionName, firstFreshSessionName);

				const invocations = await readInvocationLog(logPath);
				assert.deepEqual(readDefined(invocations[1]).args, [
					"--json",
					"--session",
					firstSessionName,
					"tab",
					"list",
				]);
				assert.deepEqual(readDefined(invocations[2]).args, [
					"--json",
					"--session",
					firstSessionName,
					"close",
				]);
				assert.equal(readDefined(invocations[3]).sessionName, firstFreshSessionName);
				assert.deepEqual(readDefined(invocations[4]).args, [
					"--json",
					"--session",
					firstFreshSessionName,
					"tab",
					"list",
				]);
				assert.deepEqual(readDefined(invocations[5]).args, [
					"--json",
					"--session",
					firstFreshSessionName,
					"close",
				]);
				assert.equal(readDefined(invocations[6]).sessionName, finalFreshSessionName);
				assert.deepEqual(readDefined(invocations[7]).args, [
					"--json",
					"--session",
					finalFreshSessionName,
					"tab",
					"list",
				]);
				await runExtensionEvent(
					harness.handlers,
					"session_shutdown",
					{ reason: "quit" },
					harness.ctx,
				);
				assert.deepEqual(
					(await readInvocationLog(logPath))
						.filter((entry) => entry.args.includes("close"))
						.map((entry) => entry.args),
					[
						["--json", "--session", firstSessionName, "close"],
						["--json", "--session", firstFreshSessionName, "close"],
						["--session", finalFreshSessionName, "close"],
					],
					"explicitly closed owners must not be closed again at quit",
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension reserves the rotated generated session after an explicit close before reuse",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-close-reserve-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
const data = args.includes("close")
  ? { closed: true }
  : { title: "Example Domain", url: "https://example.com/", sessionName };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://example.com/base"],
					sessionMode: "fresh",
				});
				assert.equal(open.isError, false, JSON.stringify(open));
				const baseSessionName = readString(open.details?.sessionName);

				const closeBase = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", baseSessionName, "close"],
				});
				assert.equal(closeBase.isError, false, JSON.stringify(closeBase));
				const rotatedSessionName = readString(
					readRecord(closeBase.details?.managedSessionOutcome).currentSessionName,
				);
				assert.notEqual(rotatedSessionName, baseSessionName);

				const closeRotated = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", rotatedSessionName, "close"],
				});
				assert.equal(closeRotated.isError, false, JSON.stringify(closeRotated));
				const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(followUp.isError, false, JSON.stringify(followUp));
				const followUpSessionName = readString(followUp.details?.sessionName);
				assert.match(
					rotatedSessionName,
					new RegExp(`^${baseSessionName.replace(/-fresh-[a-f0-9]{10}$/, "")}-fresh-[a-f0-9]{10}$`),
				);
				assert.match(
					followUpSessionName,
					new RegExp(`^${baseSessionName.replace(/-fresh-[a-f0-9]{10}$/, "")}-fresh-[a-f0-9]{10}$`),
				);
				assert.notEqual(followUpSessionName, rotatedSessionName);

				const invocations = await readInvocationLog(logPath);
				assert.deepEqual(
					invocations.map((entry) => entry.sessionName),
					[
						baseSessionName,
						baseSessionName,
						baseSessionName,
						rotatedSessionName,
						followUpSessionName,
						followUpSessionName,
					],
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension does not restore a managed session after an explicit close row",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-close-restore-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/", sessionName } }));`,
		);
		const ownedName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
		const branch = [
			createToolBranchEntry({ details: ownedSessionDetails(ownedName), isError: false }),
			createToolBranchEntry({
				details: {
					args: ["--session", ownedName, "close"],
					command: "close",
					exitCode: 0,
					managedSessionOutcome: {
						activeAfter: false,
						activeBefore: true,
						attemptedSessionName: ownedName,
						currentSessionName: ownedName,
						previousSessionName: ownedName,
						sessionMode: "auto",
						status: "closed",
						succeeded: true,
						summary: `Managed session ${ownedName} was closed.`,
					},
					resultCategory: "success",
					sessionMode: "auto",
					sessionName: ownedName,
					usedImplicitSession: false,
				},
				isError: false,
			}),
		];

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ branch, cwd: tempDir });
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);
				const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(followUp.isError, false, JSON.stringify(followUp));
				assert.notEqual(followUp.details?.sessionName, ownedName);
				const invocations = await readInvocationLog(logPath);
				assert.notEqual(readDefined(invocations[0]).sessionName, ownedName);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension restores explicit-close generated fresh ordinal before default auto calls",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(
			join(tmpdir(), "pi-agent-browser-explicit-close-restore-ordinal-"),
		);
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
const data = args.includes("close")
  ? { closed: true }
  : { title: "Example Domain", url: "https://example.com/", sessionName };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const baseOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://example.com/base"],
					sessionMode: "fresh",
				});
				assert.equal(baseOpen.isError, false, JSON.stringify(baseOpen));
				const baseSessionName = readString(baseOpen.details?.sessionName);
				const closeBase = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", baseSessionName, "close"],
				});
				assert.equal(closeBase.isError, false, JSON.stringify(closeBase));
				const freshUse = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(freshUse.isError, false, JSON.stringify(freshUse));
				const firstFreshSessionName = readString(freshUse.details?.sessionName);
				assert.match(
					firstFreshSessionName,
					new RegExp(`^${baseSessionName.replace(/-fresh-[a-f0-9]{10}$/, "")}-fresh-[a-f0-9]{10}$`),
				);
				const closeFresh = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", firstFreshSessionName, "close"],
				});
				assert.equal(closeFresh.isError, false, JSON.stringify(closeFresh));

				harness.setBranch(harness.ctx.sessionManager.getBranch().slice());
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);

				const restoredFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(restoredFollowUp.isError, false, JSON.stringify(restoredFollowUp));
				const restoredGeneratedSessionName = readString(restoredFollowUp.details?.sessionName);
				assert.match(
					restoredGeneratedSessionName,
					new RegExp(`^${baseSessionName.replace(/-fresh-[a-f0-9]{10}$/, "")}-fresh-[a-f0-9]{10}$`),
				);
				assert.notEqual(restoredGeneratedSessionName, firstFreshSessionName);

				const closeRestoredGenerated = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", restoredGeneratedSessionName, "close"],
				});
				assert.equal(closeRestoredGenerated.isError, false, JSON.stringify(closeRestoredGenerated));
				const finalFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(finalFollowUp.isError, false, JSON.stringify(finalFollowUp));
				const finalSessionName = readString(finalFollowUp.details?.sessionName);
				assert.match(
					finalSessionName,
					new RegExp(`^${baseSessionName.replace(/-fresh-[a-f0-9]{10}$/, "")}-fresh-[a-f0-9]{10}$`),
				);
				assert.notEqual(finalSessionName, firstFreshSessionName);
				assert.notEqual(finalSessionName, restoredGeneratedSessionName);

				const invocations = await readInvocationLog(logPath);
				assert.deepEqual(
					invocations.map((entry) => entry.sessionName),
					[
						baseSessionName,
						baseSessionName,
						baseSessionName,
						firstFreshSessionName,
						firstFreshSessionName,
						firstFreshSessionName,
						restoredGeneratedSessionName,
						restoredGeneratedSessionName,
						restoredGeneratedSessionName,
						finalSessionName,
						finalSessionName,
					],
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension preserves the active managed session across reload shutdown",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: args[args.length - 1] } }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://example.com/reload-preserve"],
				});
				assert.equal(open.isError, false, JSON.stringify(open));

				await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "reload" });

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 2);
				assert.equal(
					invocations.some((entry) => entry.args.includes("close")),
					false,
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension does not restore a replaced session after successful close and post-launch failure",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(
			join(tmpdir(), "pi-agent-browser-replaced-close-post-launch-failure-"),
		);
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, autosave: process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS ?? null }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: false } }));
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["open", "https://example.com/fresh"], result: { title: "Fresh", url: "https://example.com/fresh" }, success: true },
    { command: ["wait", "--text", "missing"], error: "missing", success: false }
  ]));
} else if (args.at(-1) === "close") {
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Old", url: "https://example.com/old" } }));
}`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined,
					AGENT_BROWSER_HEADED: undefined,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const oldOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--headed", "open", "https://example.com/old"],
						sessionMode: "fresh",
					});
					assert.equal(oldOpen.isError, false, JSON.stringify(oldOpen));
					assert.equal(oldOpen.details?.managedSessionHeadedAutosaveInterval, "0");
					const oldSessionName = readString(oldOpen.details.sessionName);
					const freshFailure = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "--bail"],
						stdin: JSON.stringify([
							["open", "https://example.com/fresh"],
							["wait", "--text", "missing"],
						]),
						sessionMode: "fresh",
					});
					assert.equal(freshFailure.isError, true, JSON.stringify(freshFailure));
					assert.equal(readRecord(freshFailure.details?.managedSessionOutcome).status, "replaced");
					assert.equal(
						readRecord(freshFailure.details?.managedSessionOutcome).replacedSessionClosed,
						true,
					);

					const replacementSessionName = readString(freshFailure.details?.sessionName);
					assert.notEqual(replacementSessionName, oldSessionName);
					assert.deepEqual(
						readArray(freshFailure.details?.batchSteps).map((row) => readRecord(row).command),
						[
							["open", "https://example.com/fresh"],
							["wait", "--text", "missing"],
						],
					);
					const resumedHarness = createExtensionHarness({
						branch: harness.ctx.sessionManager.getBranch().slice(),
						cwd: tempDir,
					});
					await runExtensionEvent(
						resumedHarness.handlers,
						"session_start",
						{ reason: "resume" },
						resumedHarness.ctx,
					);
					const oldFollowUp = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
						args: ["--session", oldSessionName, "get", "url"],
					});
					assert.equal(oldFollowUp.isError, false, JSON.stringify(oldFollowUp));
					assert.equal(oldFollowUp.details?.managedSessionHeadedAutosaveInterval, undefined);
					const inspection = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
						args: ["--session", oldSessionName, "session", "info"],
					});
					assert.equal(inspection.isError, false, inspection.content[0]?.text);
					assert.equal(readRecord(inspection.details?.data).piCleanupOwnership, "caller-owned");
					const current = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
						args: ["get", "url"],
					});
					assert.equal(current.isError, false, current.content[0]?.text);
					assert.equal(current.details?.sessionName, replacementSessionName);
					await runExtensionEvent(
						resumedHarness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						resumedHarness.ctx,
					);
					const invocations = await readInvocationLog(logPath);
					const oldGetter = invocations.find(
						(entry) => entry.args.includes(oldSessionName) && entry.args.includes("get"),
					);
					assert.ok(oldGetter, "the retired identity remains available as a caller-owned session");
					assert.equal(
						oldGetter.autosave,
						null,
						"retired managed launch policy must not be reapplied",
					);
					assert.deepEqual(
						invocations.filter((entry) => entry.args.includes("close")).map((entry) => entry.args),
						[
							["--session", oldSessionName, "close"],
							["--session", replacementSessionName, "close"],
						],
						"resume must not reconstruct the replaced owner or close it twice",
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension does not restore a managed session from a different cwd/worktree on resume",
	{ concurrency: false },
	async () => {
		const firstParent = await mkdtemp(join(tmpdir(), "pi-agent-browser-first-"));
		const secondParent = await mkdtemp(join(tmpdir(), "pi-agent-browser-second-"));
		const firstDir = join(firstParent, "checkout");
		const secondDir = join(secondParent, "checkout");
		const binDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-bin-"));
		const logPath = join(binDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await mkdir(firstDir, { recursive: true });
		await mkdir(secondDir, { recursive: true });
		await writeFakeAgentBrowserBinary(
			binDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { url: args[args.length - 1] } }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${binDir}:${basePath}` }, async () => {
				const firstHarness = createExtensionHarness({ cwd: firstDir });
				await runExtensionEvent(
					firstHarness.handlers,
					"session_start",
					{ reason: "new" },
					firstHarness.ctx,
				);
				const firstOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
					sessionMode: "fresh",
					args: ["open", "https://example.com/first"],
				});
				assert.equal(firstOpen.isError, false);
				const firstSessionName = firstOpen.details?.sessionName;
				assert.equal(typeof firstSessionName, "string");

				const resumedHarness = createExtensionHarness({
					branch: firstHarness.ctx.sessionManager.getBranch().slice(),
					cwd: secondDir,
				});
				await runExtensionEvent(
					resumedHarness.handlers,
					"session_start",
					{ reason: "resume" },
					resumedHarness.ctx,
				);

				const profiledOpen = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
					args: ["--profile", "Default", "open", "https://example.com/profiled"],
				});
				assert.equal(profiledOpen.isError, false);
				assert.equal(
					readArray(profiledOpen.details?.effectiveArgs).map(readString).includes("--profile"),
					true,
				);
				assert.notEqual(profiledOpen.details?.sessionName, firstSessionName);
				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 5);
				assert.deepEqual(readDefined(invocations[1]).args, [
					"--json",
					"--session",
					readString(firstSessionName),
					"tab",
					"list",
				]);
				assert.equal(readDefined(invocations[2]).args.includes("--profile"), true);
				assert.equal(
					readDefined(invocations[2]).args.includes(readString(firstSessionName)),
					false,
				);
				assert.deepEqual(readDefined(invocations[3]).args, [
					"--json",
					"--session",
					readString(profiledOpen.details?.sessionName),
					"tab",
					"list",
				]);
				assert.deepEqual(readDefined(invocations[4]).args, [
					"--json",
					"--session",
					readString(profiledOpen.details?.sessionName),
					"tab",
					"list",
				]);
			});
		} finally {
			await rm(firstParent, { force: true, recursive: true });
			await rm(secondParent, { force: true, recursive: true });
			await rm(binDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension restores the rotated fresh managed session across resume and reuses it on follow-up auto calls",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
const envelope = args.includes("tab") && args.includes("list")
  ? { success: true, data: { tabs: [{ tabId: "t1", title: "Profiled", url: "https://example.com/profile", active: true }] } }
  : args.includes("close") ? { success: true, data: { closed: true } }
  : args.includes("snapshot") ? { success: true, data: { origin: "https://example.com/profile", refs: {}, snapshot: "" } }
  : { success: true, data: { title: args.includes("--profile") ? "Profiled" : "Public", url: args[args.length - 1], idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null } };
process.stdout.write(JSON.stringify(envelope));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1234",
				},
				async () => {
					const firstHarness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						firstHarness.handlers,
						"session_start",
						{ reason: "new" },
						firstHarness.ctx,
					);

					const firstOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
						sessionMode: "fresh",
						args: ["open", "https://example.com"],
					});
					assert.equal(firstOpen.isError, false);
					const firstSessionName = firstOpen.details?.sessionName;
					assert.equal(typeof firstSessionName, "string");

					const profiledOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/profile"],
						sessionMode: "fresh",
					});
					assert.equal(profiledOpen.isError, false);
					assert.equal(profiledOpen.details?.sessionMode, "fresh");
					assert.equal(profiledOpen.details.usedImplicitSession, false);
					const freshSessionName = profiledOpen.details.sessionName;
					assert.equal(typeof freshSessionName, "string");
					assert.notEqual(freshSessionName, firstSessionName);
					assert.equal(
						readArray(profiledOpen.details.effectiveArgs)
							.map(readString)
							.includes(readString(freshSessionName)),
						true,
					);
					await runExtensionEvent(firstHarness.handlers, "session_shutdown");

					const resumedHarness = createExtensionHarness({
						branch: [...firstHarness.ctx.sessionManager.getBranch()],
						cwd: tempDir,
					});
					await runExtensionEvent(
						resumedHarness.handlers,
						"session_start",
						{ reason: "resume" },
						resumedHarness.ctx,
					);

					const followUpSnapshot = await executeRegisteredTool(
						resumedHarness.tool,
						resumedHarness.ctx,
						{
							args: ["snapshot", "-i"],
						},
					);
					assert.equal(followUpSnapshot.isError, false);
					assert.equal(followUpSnapshot.details?.sessionName, freshSessionName);
					assert.equal(followUpSnapshot.details?.usedImplicitSession, true);

					const invocations = await readInvocationLog(logPath);
					assert.equal(invocations.length, 10);
					assert.deepEqual(readDefined(invocations[0]).args, [
						"--json",
						"--session",
						readString(firstSessionName),
						"open",
						"https://example.com",
					]);
					assert.equal(readDefined(invocations[0]).idleTimeout, "1234");
					assert.deepEqual(readDefined(invocations[1]).args, [
						"--json",
						"--session",
						readString(firstSessionName),
						"tab",
						"list",
					]);
					assert.deepEqual(readDefined(invocations[2]).args, [
						"--json",
						"--session",
						readString(freshSessionName),
						"--profile",
						"Default",
						"open",
						"https://example.com/profile",
					]);
					assert.equal(readDefined(invocations[2]).idleTimeout, "1234");
					assert.deepEqual(readDefined(invocations[3]).args, [
						"--json",
						"--session",
						readString(freshSessionName),
						"tab",
						"list",
					]);
					assert.deepEqual(readDefined(invocations[4]).args, [
						"--json",
						"--session",
						readString(freshSessionName),
						"tab",
						"list",
					]);
					assert.deepEqual(readDefined(invocations[5]).args, [
						"--session",
						readString(firstSessionName),
						"close",
					]);
					assert.deepEqual(readDefined(invocations[6]).args, [
						"--json",
						"--session",
						readString(freshSessionName),
						"tab",
						"list",
					]);
					assert.deepEqual(readDefined(invocations[7]).args, [
						"--json",
						"--session",
						readString(freshSessionName),
						"snapshot",
						"-i",
					]);
					assert.equal(readDefined(invocations[7]).idleTimeout, "1234");
					assert.deepEqual(
						invocations.slice(8).map((row) => row.args.slice(-2)),
						[
							["tab", "list"],
							["tab", "list"],
						],
						"post-capture binding checks stay on the restored session",
					);
					assert.equal(
						invocations.slice(8).every((row) => row.idleTimeout === "1234"),
						true,
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension keeps fresh session allocation monotonic across session_tree branch restores",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-fresh-ordinal-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: "Fresh", url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const firstFresh = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://example.com/fresh-1"],
					sessionMode: "fresh",
				});
				assert.equal(firstFresh.isError, false, JSON.stringify(firstFresh));
				const firstFreshSessionName = firstFresh.details?.sessionName;
				assert.equal(typeof firstFreshSessionName, "string");
				const firstBranch = structuredClone(harness.ctx.sessionManager.getBranch());
				const secondFresh = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://example.com/fresh-2"],
					sessionMode: "fresh",
				});
				assert.equal(secondFresh.isError, false, JSON.stringify(secondFresh));
				const secondFreshSessionName = secondFresh.details?.sessionName;
				assert.equal(typeof secondFreshSessionName, "string");
				assert.notEqual(secondFreshSessionName, firstFreshSessionName);

				harness.setBranch(firstBranch);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-first", oldLeafId: "branch-current" },
					harness.ctx,
				);

				const thirdFresh = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://example.com/fresh-3"],
					sessionMode: "fresh",
				});
				assert.equal(thirdFresh.isError, false, JSON.stringify(thirdFresh));
				const thirdFreshSessionName = thirdFresh.details?.sessionName;
				assert.equal(typeof thirdFreshSessionName, "string");
				assert.notEqual(thirdFreshSessionName, secondFreshSessionName);
				assert.notEqual(thirdFreshSessionName, firstFreshSessionName);
				const invocations = await readInvocationLog(logPath);
				assert.ok(
					invocations.some(
						(entry) =>
							entry.args.includes(readString(secondFreshSessionName)) &&
							entry.args.includes("https://example.com/fresh-2"),
					),
				);
				assert.ok(
					invocations.some(
						(entry) =>
							entry.args.includes(readString(thirdFreshSessionName)) &&
							entry.args.includes("https://example.com/fresh-3"),
					),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension serializes overlapping base and fresh calls so fresh remains authoritative",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const gatePath = join(tempDir, "release-base");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("https://example.com/slow-base")) {
  while (!fs.existsSync(${JSON.stringify(gatePath)})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (args.includes("https://example.com/slow-base")) fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, event: "first-done" }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: args.includes("--profile") ? "Profiled" : "Base", url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const pending: Promise<unknown>[] = [];
				try {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const basePromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com/slow-base"],
					});
					pending.push(basePromise);
					await waitForInvocation(logPath, (entry) =>
						entry.args.includes("https://example.com/slow-base"),
					);
					const freshPromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/fast-fresh"],
						sessionMode: "fresh",
					});
					pending.push(freshPromise);
					await setImmediate();
					const invocationsBeforeRelease = await readInvocationLog(logPath);
					assert.equal(
						invocationsBeforeRelease.some((entry) =>
							entry.args.includes("https://example.com/fast-fresh"),
						),
						false,
					);

					await writeFile(gatePath, "go", "utf8");
					const [baseResult, freshResult] = await withConcurrencyTestTimeout(
						Promise.all([basePromise, freshPromise]),
						"overlapping base/fresh calls did not complete after releasing the base gate",
					);
					assert.equal(baseResult.isError, false, JSON.stringify(baseResult));
					assert.equal(freshResult.isError, false, JSON.stringify(freshResult));

					const freshSessionName = freshResult.details?.sessionName;
					assert.equal(typeof freshSessionName, "string");

					const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(followUp.isError, false, JSON.stringify(followUp));
					assert.equal(followUp.details?.sessionName, freshSessionName);

					const invocations = await readInvocationLog(logPath);
					const firstDone = invocations.findIndex((entry) => entry.event === "first-done");
					assert.ok(
						firstDone >= 0 &&
							firstDone <
								invocations.findIndex((entry) =>
									entry.args.includes("https://example.com/fast-fresh"),
								),
						"the second launch must dispatch only after the first native command finished",
					);
					assert.equal(
						invocations.some(
							(entry) =>
								entry.args[0] === "--session" &&
								entry.args[1] === readString(freshSessionName) &&
								entry.args[2] === "close",
						),
						false,
					);
					assert.deepEqual(invocations.at(-1)?.args, [
						"--json",
						"--session",
						readString(freshSessionName),
						"snapshot",
						"-i",
					]);
				} finally {
					await writeFile(gatePath, "go", "utf8");
					await Promise.allSettled(pending);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension does not close an overlapping auto call's session mid-command",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const snapshotGatePath = join(tempDir, "release-snapshot");
		const closedDir = join(tempDir, "closed-sessions");
		const basePath = process.env.PATH ?? "";
		await mkdir(closedDir, { recursive: true });
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const sessionName = sessionIndex >= 0 ? args[sessionIndex + 1] : "none";
const closedPath = path.join(${JSON.stringify(closedDir)}, encodeURIComponent(sessionName) + ".closed");
const log = (event) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ event, args, sessionName }) + "\\n");
log("start");
if (args.includes("snapshot")) {
  while (!fs.existsSync(${JSON.stringify(snapshotGatePath)})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (fs.existsSync(closedPath)) {
    process.stdout.write(JSON.stringify({ success: false, error: "session was closed mid-command" }));
    process.exit(1);
  }
  log("snapshot-done");
}
if (args.includes("close")) {
  fs.writeFileSync(closedPath, "closed");
  log("close-done");
}
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: args.includes("--profile") ? "Fresh" : "Base", url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const pending: Promise<unknown>[] = [];
				try {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com/base"],
						sessionMode: "fresh",
					});
					assert.equal(firstOpen.isError, false, JSON.stringify(firstOpen));
					const baseSessionName = firstOpen.details?.sessionName;
					assert.equal(typeof baseSessionName, "string");

					const snapshotPromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					pending.push(snapshotPromise);
					await waitForInvocation(logPath, (entry) => entry.args.includes("snapshot"));
					const freshPromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/fresh"],
						sessionMode: "fresh",
					});
					pending.push(freshPromise);
					await setImmediate();
					const invocationsBeforeRelease = await readInvocationLog(logPath);
					assert.equal(
						invocationsBeforeRelease.some(
							(entry) => entry.event === "close-done" && entry.sessionName === baseSessionName,
						),
						false,
						"fresh rotation must not close the base session while the snapshot is still gated",
					);

					await writeFile(snapshotGatePath, "go", "utf8");
					const [snapshotResult, freshResult] = await withConcurrencyTestTimeout(
						Promise.all([snapshotPromise, freshPromise]),
						"overlapping snapshot/fresh calls did not complete after releasing the snapshot gate",
					);
					assert.equal(snapshotResult.isError, false, JSON.stringify(snapshotResult));
					assert.equal(freshResult.isError, false, JSON.stringify(freshResult));

					const invocations = await readInvocationLog(logPath);
					const snapshotDoneIndex = invocations.findIndex(
						(entry) => entry.event === "snapshot-done" && entry.sessionName === baseSessionName,
					);
					const closeBaseIndex = invocations.findIndex(
						(entry) => entry.event === "close-done" && entry.sessionName === baseSessionName,
					);
					assert.ok(
						snapshotDoneIndex >= 0,
						"snapshot should finish against the original managed session",
					);
					assert.ok(
						closeBaseIndex > snapshotDoneIndex,
						"base close should happen after the overlapping snapshot finishes",
					);
				} finally {
					await writeFile(snapshotGatePath, "go", "utf8");
					await Promise.allSettled(pending);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension allocates distinct managed sessions for overlapping fresh launches",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const firstGatePath = join(tempDir, "release-first-fresh");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("https://example.com/fresh-a")) {
  while (!fs.existsSync(${JSON.stringify(firstGatePath)})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (args.includes("https://example.com/fresh-a")) fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, event: "first-done" }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: "Fresh", url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const pending: Promise<unknown>[] = [];
				try {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const firstFreshPromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/fresh-a"],
						sessionMode: "fresh",
					});
					pending.push(firstFreshPromise);
					await waitForInvocation(logPath, (entry) =>
						entry.args.includes("https://example.com/fresh-a"),
					);
					const secondFreshPromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/fresh-b"],
						sessionMode: "fresh",
					});
					pending.push(secondFreshPromise);
					await setImmediate();
					const invocationsBeforeRelease = await readInvocationLog(logPath);
					assert.equal(
						invocationsBeforeRelease.some((entry) =>
							entry.args.includes("https://example.com/fresh-b"),
						),
						false,
					);

					await writeFile(firstGatePath, "go", "utf8");
					const [firstFresh, secondFresh] = await withConcurrencyTestTimeout(
						Promise.all([firstFreshPromise, secondFreshPromise]),
						"overlapping fresh calls did not complete after releasing the first fresh gate",
					);
					assert.equal(firstFresh.isError, false, JSON.stringify(firstFresh));
					assert.equal(secondFresh.isError, false, JSON.stringify(secondFresh));
					assert.equal(typeof firstFresh.details?.sessionName, "string");
					assert.equal(typeof secondFresh.details?.sessionName, "string");
					assert.notEqual(firstFresh.details?.sessionName, secondFresh.details?.sessionName);

					const firstSessionName = readString(firstFresh.details?.sessionName);
					const secondSessionName = readString(secondFresh.details?.sessionName);
					const invocations = await readInvocationLog(logPath);
					const firstDone = invocations.findIndex((entry) => entry.event === "first-done");
					assert.ok(
						firstDone >= 0 &&
							firstDone <
								invocations.findIndex((entry) =>
									entry.args.includes("https://example.com/fresh-b"),
								),
						"the second launch must dispatch only after the first native command finished",
					);
					assert.ok(
						invocations.some(
							(entry) =>
								entry.args.includes(firstSessionName) &&
								entry.args.includes("https://example.com/fresh-a"),
						),
					);
					assert.ok(
						invocations.some(
							(entry) =>
								entry.args.includes(secondSessionName) &&
								entry.args.includes("https://example.com/fresh-b"),
						),
					);
				} finally {
					await writeFile(firstGatePath, "go", "utf8");
					await Promise.allSettled(pending);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

nodeTest(
	"agentBrowserExtension does not mark a failed first implicit command as active",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const shouldFail = args.includes("https://fail.example");
process.stdout.write(JSON.stringify(shouldFail ? { success: false, error: "intentional failure" } : { success: true, data: { title: "Recovered" } }));
process.exit(shouldFail ? 1 : 0);`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const failedOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://fail.example"],
				});
				assert.equal(failedOpen.isError, true);
				assert.equal((await readInvocationLog(logPath)).length, 1);

				const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--profile", "Default", "open", "https://example.com/recovered"],
				});
				assert.equal(followUp.isError, false);
				assert.equal(followUp.details?.validationError, undefined);
				assert.equal(
					readArray(followUp.details?.effectiveArgs).map(readString).includes("--profile"),
					true,
				);

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 3);
				assert.equal(readDefined(invocations[1]).args.includes("--profile"), true);
				assert.deepEqual(readDefined(invocations[2]).args, [
					"--json",
					"--session",
					readString(followUp.details?.sessionName),
					"tab",
					"list",
				]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
