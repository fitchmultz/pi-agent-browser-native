import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tracePolicyFilesystem } from "./helpers/policy-filesystem-trace.js";
import { setImmediate } from "node:timers/promises";
import { createImplicitSessionName } from "../extensions/agent-browser/lib/runtime.js";
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
import { readRecord, readArray, readString, readBoolean } from "./helpers/assertions.js";
import {
	CONCURRENCY_TEST_TIMEOUT_MS,
	withConcurrencyTestTimeout,
	waitForInvocation,
	ownedSessionDetails,
} from "./helpers/resume-state-fixture.js";

function assertIsString(value: unknown): asserts value is string {
	assert.equal(typeof value, "string");
}

test(
	"agentBrowserExtension preserves branch-restored managed state after session_tree waits for in-flight commands",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-race-"));
		const logPath = join(tempDir, "invocations.log");
		const releasePath = join(tempDir, "release-snapshot");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args[args.indexOf("--session") + 1];
function log(event) { fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, event, sessionName }) + "\\n"); }
if (args.includes("snapshot")) {
  log("snapshot-start");
  while (!fs.existsSync(${JSON.stringify(releasePath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  log("snapshot-done");
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://stale.example/", refs: {}, snapshot: "" } }));
} else if (args.includes("close")) {
  log("close");
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else {
  log("command");
  process.stdout.write(JSON.stringify({ success: true, data: { title: "ok", url: args[args.length - 1] } }));
}`,
		);
		const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
		const branchFreshOne = `${baseSessionName}-fresh-one`;
		const branchFreshTwo = `${baseSessionName}-fresh-two`;
		const branchA = [
			createToolBranchEntry({
				details: ownedSessionDetails(branchFreshOne, "fresh"),
				isError: false,
			}),
			createToolBranchEntry({
				details: ownedSessionDetails(branchFreshTwo, "fresh"),
				isError: false,
			}),
		];
		const branchB = [
			createToolBranchEntry({
				details: ownedSessionDetails(branchFreshOne, "fresh"),
				isError: false,
			}),
		];

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const pending: Promise<unknown>[] = [];
				try {
					const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "resume" },
						harness.ctx,
					);
					const completionOrder: string[] = [];
					const snapshotPromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					}).then((result) => {
						completionOrder.push("snapshot");
						return result;
					});
					pending.push(snapshotPromise);
					await waitForInvocation(logPath, (entry) => entry.event === "snapshot-start");

					harness.setBranch(branchB);
					const treePromise = runExtensionEvent(
						harness.handlers,
						"session_tree",
						{ newLeafId: "branch-b", oldLeafId: "branch-a" },
						harness.ctx,
					).then(() => completionOrder.push("tree"));
					pending.push(treePromise);
					await setImmediate();
					assert.deepEqual(
						completionOrder,
						[],
						"branch restore must remain queued while the managed command is gated",
					);
					await writeFile(releasePath, "go");
					const [snapshot] = await withConcurrencyTestTimeout(
						Promise.all([snapshotPromise, treePromise]),
						"session_tree did not wait for the in-flight snapshot to finish",
					);
					assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
					assert.deepEqual(completionOrder, ["snapshot", "tree"]);

					const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "url"],
					});
					assert.equal(followUp.isError, false, JSON.stringify(followUp));
					assert.equal(followUp.details?.sessionName, branchFreshOne);

					const nextFresh = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com/fresh-after-tree"],
						sessionMode: "fresh",
					});
					assert.equal(nextFresh.isError, false, JSON.stringify(nextFresh));
					assert.notEqual(nextFresh.details?.sessionName, branchFreshOne);
					assert.notEqual(nextFresh.details?.sessionName, branchFreshTwo);
				} finally {
					await writeFile(releasePath, "go", "utf8");
					await Promise.allSettled(pending);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension keeps session_tree authoritative after a slow explicit-session command",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-tree-race-"));
		const logPath = join(tempDir, "invocations.log");
		const releasePath = join(tempDir, "release-explicit-snapshot");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args[args.indexOf("--session") + 1];
function log(event) { fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, event, sessionName }) + "\\n"); }
if (args.includes("snapshot") && sessionName === "named-user-session") {
  log("explicit-snapshot-start");
  while (!fs.existsSync(${JSON.stringify(releasePath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  log("explicit-snapshot-done");
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://named.example/", refs: {}, snapshot: "" } }));
} else {
  log("command");
  process.stdout.write(JSON.stringify({ success: true, data: { result: "ok", url: "https://branch.example/" } }));
}`,
		);
		const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
		const branchASession = `${baseSessionName}-fresh-a`;
		const branchBSession = `${baseSessionName}-fresh-b`;
		const branchA = [
			createToolBranchEntry({
				details: ownedSessionDetails(branchASession, "fresh"),
				isError: false,
			}),
		];
		const branchB = [
			createToolBranchEntry({
				details: ownedSessionDetails(branchBSession, "fresh"),
				isError: false,
			}),
		];

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const pending: Promise<unknown>[] = [];
				try {
					const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "resume" },
						harness.ctx,
					);
					const explicitSnapshotPromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "named-user-session", "snapshot", "-i"],
					});
					pending.push(explicitSnapshotPromise);
					await waitForInvocation(logPath, (entry) => entry.event === "explicit-snapshot-start");

					harness.setBranch(branchB);
					const treePromise = runExtensionEvent(
						harness.handlers,
						"session_tree",
						{ newLeafId: "branch-b", oldLeafId: "branch-a" },
						harness.ctx,
					);
					pending.push(treePromise);
					await withConcurrencyTestTimeout(
						treePromise,
						"branch restore was blocked by an unrelated caller-owned command",
					);
					assert.equal(
						(await readInvocationLog(logPath)).some(
							(entry) => entry.event === "explicit-snapshot-done",
						),
						false,
						"the branch switch must finish while the old explicit command is still gated",
					);
					await writeFile(releasePath, "go");
					const [explicitSnapshot] = await withConcurrencyTestTimeout(
						Promise.all([explicitSnapshotPromise, treePromise]),
						"explicit command and session_tree branch switch did not settle",
					);
					assert.equal(explicitSnapshot.isError, false, JSON.stringify(explicitSnapshot));

					const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "url"],
					});
					assert.equal(followUp.isError, false, JSON.stringify(followUp));
					assert.equal(followUp.details?.sessionName, branchBSession);
				} finally {
					await writeFile(releasePath, "go", "utf8");
					await Promise.allSettled(pending);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension does not resurrect a managed session when explicit close follows a slow implicit command",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-close-race-"));
		const logPath = join(tempDir, "invocations.log");
		const releasePath = join(tempDir, "release-implicit-snapshot");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args[args.indexOf("--session") + 1];
function log(event) { fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, event, sessionName }) + "\\n"); }
if (args.includes("snapshot")) {
  log("snapshot-start");
  while (!fs.existsSync(${JSON.stringify(releasePath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  log("snapshot-done");
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://current.example/", refs: {}, snapshot: "" } }));
} else if (args.includes("close")) {
  log("close");
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else {
  log("command");
  process.stdout.write(JSON.stringify({ success: true, data: { result: "ok", url: "https://next.example/" } }));
}`,
		);
		const currentSession = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const pending: Promise<unknown>[] = [];
				try {
					const harness = createExtensionHarness({
						branch: [
							createToolBranchEntry({
								details: ownedSessionDetails(currentSession),
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
					const snapshotPromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					pending.push(snapshotPromise);
					await waitForInvocation(logPath, (entry) => entry.event === "snapshot-start");

					const closePromise = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", currentSession, "close"],
					});
					pending.push(closePromise);
					await writeFile(releasePath, "go");
					const [snapshot, close] = await withConcurrencyTestTimeout(
						Promise.all([snapshotPromise, closePromise]),
						"explicit close did not wait behind in-flight managed command",
					);
					assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
					assert.equal(close.isError, false, JSON.stringify(close));

					const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "url"],
					});
					assert.equal(followUp.isError, false, JSON.stringify(followUp));
					assert.notEqual(followUp.details?.sessionName, currentSession);
					const events = (await readInvocationLog(logPath)).map((entry) => entry.event);
					assert.ok(events.indexOf("close") > events.indexOf("snapshot-done"));
				} finally {
					await writeFile(releasePath, "go", "utf8");
					await Promise.allSettled(pending);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension preserves named older owned dispatch, semantic replanning, and queue ordering after replacement close fails",
	{ concurrency: false },
	async (t) => {
		const trace = tracePolicyFilesystem(t);
		const tempDir = await mkdtemp(join(tmpdir(), "piab-owned-namespace-"));
		const cwd = join(tempDir, "p");
		const home = join(tempDir, "home");
		const logPath = join(tempDir, "invocations.log");
		const waitGate = join(tempDir, "release-wait");
		const closeGate = join(tempDir, "allow-close");
		const basePath = process.env.PATH ?? "";
		await mkdir(home, { mode: 0o700 });
		execFileSync("git", ["init", "-q", cwd], { stdio: "ignore" });
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const namespaceIndex = args.indexOf("--namespace");
const namespace = (namespaceIndex >= 0 ? args[namespaceIndex + 1] : process.env.AGENT_BROWSER_NAMESPACE ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const sessionName = args[args.indexOf("--session") + 1];
const command = args.find((arg) => ["close", "get", "open", "select", "session", "snapshot", "tab", "wait"].includes(arg));
const activePath = path.join(${JSON.stringify(tempDir)}, encodeURIComponent(namespace + ":" + sessionName) + ".json");
const active = fs.existsSync(activePath) ? JSON.parse(fs.readFileSync(activePath, "utf8")) : null;
const restoreKey = process.env.AGENT_BROWSER_RESTORE ?? null;
const log = (event) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, event, namespace, namespaceEnv: process.env.AGENT_BROWSER_NAMESPACE ?? null, sessionName, restoreKey, observedRestoreKey: active?.restoreKey, active: active !== null }) + "\\n");
log("start");
if (command === "session") {
  process.stdout.write(JSON.stringify({ success: true, data: { active: active !== null, runtime: active ? { restoreKey: active.restoreKey, backgroundPid: ${process.pid}, socketDir: ${JSON.stringify(tempDir)}, browserLaunched: true } : null } }));
} else if (command === "close" && namespace === "review-space" && !fs.existsSync(${JSON.stringify(closeGate)})) {
  process.stdout.write(JSON.stringify({ success: false, error: "forced old-session close failure" }));
  process.exit(1);
} else {
  if (command === "open") fs.writeFileSync(activePath, JSON.stringify({ namespace, sessionName, restoreKey, url: args.at(-1) }));
  if (command === "close") fs.rmSync(activePath, { force: true });
  if (command === "wait") {
    log("wait-start");
    const deadline = Date.now() + ${CONCURRENCY_TEST_TIMEOUT_MS};
    while (!fs.existsSync(${JSON.stringify(waitGate)})) {
      if (Date.now() > deadline) throw new Error("owned wait gate was not released");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    log("wait-end");
  }
  const url = command === "open" ? args.at(-1) : active?.url ?? "https://shop.example.test/";
  const data = command === "snapshot" ? { origin: url, refs: { e4: { role: "combobox", name: "Flavor" } }, snapshot: '- combobox "Flavor" [ref=e4]' }
    : command === "get" ? { result: args.at(-1) === "title" ? "Shop" : url, url }
    : command === "tab" ? { tabs: [{ tabId: "t1", url, active: true }] }
    : command === "select" ? { selected: args.at(-1) }
    : command === "close" ? { closed: true }
    : { title: "Shop", url };
  process.stdout.write(JSON.stringify({ success: true, data }));
}`,
		);
		const readEvents = async () => await readInvocationLog(logPath);
		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
					AGENT_BROWSER_NAMESPACE: undefined,
					HOME: home,
					USERPROFILE: home,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const harness = createExtensionHarness({ cwd });
					let cleanupHarness = harness;
					const pending: Array<ReturnType<typeof executeRegisteredTool>> = [];
					try {
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						const open = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--namespace", "Review Space", "open", "https://shop.example.test/"],
							sessionMode: "fresh",
						});
						assert.equal(open.isError, false, JSON.stringify(open));
						assert.equal(open.details?.namespace, "review-space");
						assert.notEqual(open.details.managedSessionRestoreDisabled, true);
						const oldSession = open.details.sessionName;
						assertIsString(oldSession);
						const launched = (await readEvents()).find(
							(entry) => entry.args.includes("open") && entry.sessionName === oldSession,
						);
						assert.ok(launched);
						assert.equal(readRecord(launched).namespace, "review-space");
						assert.match(readString(readRecord(launched).restoreKey ?? ""), /^piab-r2-/);

						const replacement = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["open", "https://shop.example.test/replacement"],
							sessionMode: "fresh",
						});
						assert.equal(replacement.isError, false, JSON.stringify(replacement));
						assert.equal(
							readRecord(replacement.details?.managedSessionOutcome).replacedSessionClosed,
							false,
						);
						const currentSession = replacement.details?.sessionName;
						assertIsString(currentSession);
						assert.notEqual(currentSession, oldSession);
						const replacementLaunch = (await readEvents()).find(
							(entry) => entry.args.includes("open") && entry.sessionName === currentSession,
						);
						assert.equal(readRecord(replacementLaunch).namespace, "");
						assert.match(readString(readRecord(replacementLaunch).restoreKey ?? ""), /^piab-r2-/);

						await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "Review Space" }, async () => {
							const beforeRead = (await readEvents()).length;
							const read = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["--session", oldSession, "read", "https://public.test/"],
							});
							assert.equal(read.isError, false, read.content[0].text);
							assert.equal(read.details?.managedSessionOutcome, undefined);
							const readCalls = (await readEvents()).slice(beforeRead);
							assert.equal(readCalls.length, 1);
							assert.equal(readRecord(readCalls[0]).namespaceEnv, "review-space");
							assert.equal(readRecord(readCalls[0]).restoreKey, readRecord(launched).restoreKey);
							const before = (await readEvents()).length;
							const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["--session", oldSession, "snapshot", "-i"],
							});
							assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
							assert.equal(snapshot.details?.namespace, "review-space");
							assert.notEqual(snapshot.details.managedSessionRestoreDisabled, true);
							assert.deepEqual(snapshot.details.effectiveArgs, [
								"--json",
								"--session",
								oldSession,
								"snapshot",
								"-i",
							]);
							const selected = await executeRegisteredTool(harness.tool, harness.ctx, {
								semanticAction: {
									action: "select",
									locator: "role",
									role: "combobox",
									name: "Flavor",
									value: "chocolate",
									session: oldSession,
								},
							});
							assert.equal(selected.isError, false, JSON.stringify(selected));
							assert.equal(selected.details?.namespace, "review-space");
							assert.deepEqual(selected.details.effectiveArgs, [
								"--json",
								"--session",
								oldSession,
								"select",
								"@e4",
								"chocolate",
							]);
							const dispatched = (await readEvents()).slice(before);
							const inspections = dispatched.filter(
								(entry) => entry.args.includes("session") && entry.args.includes("info"),
							);
							assert.equal(
								inspections.length,
								4,
								`one owned-policy inspection per call plus separate post-capture receipts: ${JSON.stringify(dispatched.map((entry) => entry.args))}`,
							);
							assert.equal(
								inspections.every(
									(entry) =>
										readBoolean(readRecord(entry).active) &&
										readRecord(entry).observedRestoreKey === readRecord(launched).restoreKey,
								),
								true,
								JSON.stringify(inspections),
							);
							assert.equal(
								dispatched.every(
									(entry) =>
										entry.sessionName === oldSession &&
										readRecord(entry).namespace === "review-space",
								),
								true,
								JSON.stringify(dispatched),
							);
							const content = dispatched.filter((entry) => !entry.args.includes("session"));
							assert.ok(
								content.filter((entry) => entry.args.includes("snapshot")).length >= 2,
								JSON.stringify(content),
							);
							assert.ok(
								content.some((entry) => entry.args.includes("select")),
								JSON.stringify(content),
							);
							assert.equal(
								content.every(
									(entry) =>
										readRecord(entry).namespaceEnv === "review-space" &&
										readRecord(entry).restoreKey === readRecord(launched).restoreKey,
								),
								true,
								JSON.stringify(content),
							);

							const beforeQueue = (await readEvents()).length;
							const wait = executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["--session", oldSession, "wait", "1"],
							});
							pending.push(wait);
							await waitForInvocation(logPath, (entry) => entry.event === "wait-start");
							const current = executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["snapshot", "-i"],
							});
							pending.push(current);
							const unrelatedCall = executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["--namespace", "unrelated", "--session", "caller", "tab", "list"],
							});
							pending.push(unrelatedCall);
							const unrelated = await withConcurrencyTestTimeout(
								unrelatedCall,
								"unrelated caller was blocked by the older owned wait",
							);
							assert.equal(unrelated.isError, false, JSON.stringify(unrelated));
							const heldEvents = (await readEvents()).slice(beforeQueue);
							assert.equal(
								heldEvents.some((entry) => entry.sessionName === currentSession),
								false,
								JSON.stringify(heldEvents),
							);
							await writeFile(waitGate, "go");
							const [waitResult, currentResult] = await withConcurrencyTestTimeout(
								Promise.all([wait, current]),
								"owned commands did not complete after wait release",
							);
							assert.equal(waitResult.isError, false, JSON.stringify(waitResult));
							assert.equal(currentResult.isError, false, JSON.stringify(currentResult));
							assert.equal(currentResult.details?.sessionName, currentSession);
							const events = (await readEvents()).slice(beforeQueue);
							const waitEnd = events.findIndex((entry) => entry.event === "wait-end");
							assert.ok(
								waitEnd >= 0 &&
									events.findIndex((entry) => entry.sessionName === currentSession) > waitEnd,
								JSON.stringify(events),
							);
							const currentStart = events.findIndex(
								(entry) => entry.sessionName === currentSession && entry.args.includes("snapshot"),
							);
							assert.ok(waitEnd >= 0 && currentStart > waitEnd, JSON.stringify(events));
							assert.equal(readRecord(events[currentStart]).namespace, "");

							await runExtensionEvent(
								harness.handlers,
								"session_shutdown",
								{ reason: "reload" },
								harness.ctx,
							);
							const resumed = createExtensionHarness({
								branch: [...harness.ctx.sessionManager.getBranch()],
								cwd,
							});
							cleanupHarness = resumed;
							await runExtensionEvent(
								resumed.handlers,
								"session_start",
								{ reason: "resume" },
								resumed.ctx,
							);
							const beforeResumedRead = (await readEvents()).length;
							const resumedRead = await executeRegisteredTool(resumed.tool, resumed.ctx, {
								args: ["--session", oldSession, "read", "https://public.test/"],
							});
							assert.equal(resumedRead.isError, false, resumedRead.content[0].text);
							const resumedReadCalls = (await readEvents()).slice(beforeResumedRead);
							assert.equal(resumedReadCalls.length, 1);
							assert.equal(readRecord(resumedReadCalls[0]).namespaceEnv, "review-space");
							assert.equal(
								readRecord(resumedReadCalls[0]).restoreKey,
								readRecord(launched).restoreKey,
							);
							const resumedOld = await executeRegisteredTool(resumed.tool, resumed.ctx, {
								args: ["--session", oldSession, "snapshot", "-i"],
							});
							assert.equal(resumedOld.isError, false, trace.failureMessage(resumedOld));
							assert.equal(resumedOld.details?.namespace, "review-space");
							assert.notEqual(resumedOld.details.managedSessionRestoreDisabled, true);
							const resumedCurrent = await executeRegisteredTool(resumed.tool, resumed.ctx, {
								args: ["snapshot", "-i"],
							});
							assert.equal(resumedCurrent.isError, false, JSON.stringify(resumedCurrent));
							assert.equal(resumedCurrent.details?.sessionName, currentSession);
							const resumedEvents = await readEvents();
							assert.equal(
								resumedEvents
									.filter(
										(entry) => entry.sessionName === oldSession && entry.args.includes("snapshot"),
									)
									.every(
										(entry) =>
											readRecord(entry).namespace === "review-space" &&
											readRecord(entry).restoreKey === readRecord(launched).restoreKey,
									),
								true,
								JSON.stringify(resumedEvents),
							);
							await writeFile(closeGate, "go");
							for (const args of [
								["--namespace", "review-space", "--session", oldSession, "close"],
								["close"],
							]) {
								// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
								// oxlint-disable-next-line no-await-in-loop
								const closed = await executeRegisteredTool(resumed.tool, resumed.ctx, { args });
								// The nonempty args fixture matrix exhaustively verifies each case; any failed assertion fails the test.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(closed.isError, false, JSON.stringify(closed));
							}
						});
					} finally {
						await writeFile(waitGate, "go");
						await writeFile(closeGate, "go");
						await Promise.allSettled(pending);
						await runExtensionEvent(
							cleanupHarness.handlers,
							"session_shutdown",
							{ reason: "quit" },
							cleanupHarness.ctx,
						);
					}
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension restores pinned tab targets across resume for explicit sessions",
	{ concurrency: false },
	async () => {
		for (const wrongUrl of ["https://other.example/", "about:blank"]) {
			// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
			// oxlint-disable-next-line no-await-in-loop
			const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-resume-pin-"));
			const logPath = join(tempDir, "invocations.log");
			const selectedPath = join(tempDir, "selected");
			const basePath = process.env.PATH ?? "";
			// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
			// oxlint-disable-next-line no-await-in-loop
			await writeFakeAgentBrowserBinary(
				tempDir,
				`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("tab") && args.includes("t1")) fs.writeFileSync(${JSON.stringify(selectedPath)}, "selected");
const selected = fs.existsSync(${JSON.stringify(selectedPath)});
const url = selected ? "https://example.com/" : ${JSON.stringify(wrongUrl)};
let data = { url };
if (args.includes("tab") && args.includes("list")) data = { tabs: [
  { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: selected },
  { tabId: "t2", url: ${JSON.stringify(wrongUrl)}, active: !selected }
] };
if (args.includes("snapshot")) data = { origin: url, refs: { e1: { name: selected ? "Example Domain" : "Wrong", role: "heading" } }, snapshot: selected ? '- heading "Example Domain" [ref=e1]' : 'Wrong page' };
process.stdout.write(JSON.stringify({ success: true, data }));`,
			);
			try {
				// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
				// oxlint-disable-next-line no-await-in-loop
				await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
					const harness = createExtensionHarness({
						cwd: tempDir,
						branch: [
							createToolBranchEntry({
								details: {
									args: ["--session", "named", "open", "https://example.com"],
									command: "open",
									sessionName: "named",
									sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
								},
								isError: false,
							}),
						],
					});
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "resume" },
						harness.ctx,
					);
					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "named", "snapshot", "-i"],
					});
					// The nonempty wrongUrl fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
					// The nonempty wrongUrl fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(snapshot.details?.sessionTabCorrection).selectedTab, "t1");
					// The nonempty wrongUrl fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(snapshot.content[0].text ?? "", /Example Domain/);
					// The nonempty wrongUrl fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.doesNotMatch(snapshot.content[0].text ?? "", /Wrong page|Origin: about:blank/);
					const invocations = await readInvocationLog(logPath);
					// The nonempty wrongUrl fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.deepEqual(
						invocations.slice(0, 3).map((entry) => entry.args.slice(3)),
						[
							["tab", "list"],
							["tab", "t1"],
							["tab", "list"],
						],
					);
					// The nonempty wrongUrl fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(invocations.filter((entry) => entry.args.includes("snapshot")).length, 1);
					// The nonempty wrongUrl fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						invocations.some((entry) => entry.args.includes("batch")),
						false,
					);
				});
			} finally {
				// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
				// oxlint-disable-next-line no-await-in-loop
				await rm(tempDir, { force: true, recursive: true });
			}
		}
	},
);

test(
	"agentBrowserExtension resumes the native target when duplicate tabs share URL and title",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-same-url-"));
		const statePath = join(tempDir, "active");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let active = fs.existsSync(${JSON.stringify(statePath)}) ? fs.readFileSync(${JSON.stringify(statePath)}, "utf8") : "FIRST";
if (args.includes("FIRST") || args.includes("t1")) active = "FIRST";
if (args.includes("SECOND") || args.includes("t2") || args.includes("--new-tab") || args.includes("#popup")) active = "SECOND";
const url = active === "DRIFTED" ? "https://other.example/" : "https://example.com/";
fs.writeFileSync(${JSON.stringify(statePath)}, active);
let data = { title: "Same Page", url };
if (args.includes("open")) data.targetId = active;
if (args.includes("tab") && args.includes("list")) data = { tabs: [
  ...(active === "GONE" ? [] : [{ tabId: "t1", targetId: "FIRST", title: "Same Page", url, active: ["FIRST", "DRIFTED"].includes(active) }]),
  { tabId: "t2", targetId: "SECOND", title: "Same Page", url, active: !["FIRST", "DRIFTED"].includes(active) }
] };
if (args.includes("click")) data = { clicked: active, ...(args.includes("--new-tab") ? { targetId: active } : {}) };
if (args.includes("batch")) data = [{ command: ["get", "url"], success: true, result: { url } }];
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
				const initial = createExtensionHarness({ cwd: tempDir });
				const opened = await executeRegisteredTool(initial.tool, initial.ctx, {
					args: ["--session", "named", "open", "https://example.com/"],
				});
				assert.equal(readRecord(opened.details?.sessionTabTarget).targetId, "FIRST");
				const snapshot = await executeRegisteredTool(initial.tool, initial.ctx, {
					args: ["--session", "named", "snapshot", "-i"],
				});
				assert.equal(readRecord(snapshot.details?.sessionTabTarget).targetId, "FIRST");
				await writeFile(statePath, "SECOND");
				const branch = initial.ctx.sessionManager.getBranch().slice();
				const resumed = createExtensionHarness({ cwd: tempDir, branch: branch.slice() });
				await runExtensionEvent(
					resumed.handlers,
					"session_start",
					{ reason: "resume" },
					resumed.ctx,
				);
				const clicked = await executeRegisteredTool(resumed.tool, resumed.ctx, {
					args: ["--session", "named", "click", "#save"],
				});
				assert.equal(clicked.isError, false, JSON.stringify(clicked));
				assert.equal(readRecord(clicked.details?.data).clicked, "FIRST");
				assert.equal(readRecord(clicked.details?.sessionTabTarget).targetId, "FIRST");
				const newTab = await executeRegisteredTool(resumed.tool, resumed.ctx, {
					args: ["--session", "named", "click", "#save", "--new-tab"],
				});
				assert.equal(readRecord(newTab.details?.sessionTabTarget).targetId, "SECOND");
				await writeFile(statePath, "FIRST");
				const observed = await executeRegisteredTool(resumed.tool, resumed.ctx, {
					args: ["--session", "named", "get", "url"],
				});
				assert.equal(readRecord(observed.details?.sessionTabTarget).targetId, "FIRST");
				await writeFile(statePath, "SECOND");
				const batchObserved = await executeRegisteredTool(resumed.tool, resumed.ctx, {
					args: ["--session", "named", "batch", "--bail"],
					stdin: JSON.stringify([["get", "url"]]),
				});
				assert.equal(readRecord(batchObserved.details?.sessionTabTarget).targetId, "SECOND");
				await writeFile(statePath, "FIRST");
				const popup = await executeRegisteredTool(initial.tool, initial.ctx, {
					args: ["--session", "named", "click", "#popup"],
				});
				assert.equal(readRecord(popup.details?.sessionTabTarget).targetId, "SECOND");
				await writeFile(statePath, "GONE");
				const closedTarget = createExtensionHarness({ cwd: tempDir, branch: branch.slice() });
				await runExtensionEvent(
					closedTarget.handlers,
					"session_start",
					{ reason: "resume" },
					closedTarget.ctx,
				);
				const rejected = await executeRegisteredTool(closedTarget.tool, closedTarget.ctx, {
					args: ["--session", "named", "click", "#save"],
				});
				assert.equal(rejected.isError, true);
				assert.match(rejected.content[0].text ?? "", /could not re-select/);
				await writeFile(statePath, "DRIFTED");
				const drifted = await executeRegisteredTool(closedTarget.tool, closedTarget.ctx, {
					args: ["--session", "named", "click", "#save"],
				});
				assert.equal(drifted.isError, true);
				assert.match(drifted.content[0].text ?? "", /could not re-select/);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension verifies reached failed batch navigation live and after replay",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-failed-batch-"));
		const statePath = join(tempDir, "failed");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const good = "https://example.com/good";
const errorUrl = "chrome-error://chromewebdata/";
let failed = fs.existsSync(${JSON.stringify(statePath)});
let data = { url: failed ? errorUrl : good };
let success = true;
if (args.includes("batch")) {
  const raw = args.slice(args.indexOf("batch") + 1).filter(x => x !== "--bail");
  const steps = raw.length ? raw.map(x => x.split(" ")) : JSON.parse(stdin);
  fs.writeFileSync(${JSON.stringify(statePath)}, "failed");
  success = false;
  data = [
    { command: steps[0], success: true, result: { url: good, targetId: "FIRST" } },
    { command: steps[1], success: false, error: "net::ERR_EMPTY_RESPONSE" }
  ];
}
if (args.includes("tab") && args.includes("list")) data = { tabs: [
  { tabId: "t1", targetId: "FIRST", url: failed ? "https://example.com/abort" : good, active: true },
  { tabId: "t2", targetId: "SECOND", url: good, active: false }
] };
if (args.includes("get") && args.includes("title")) data = { title: failed ? "Error" : "Good" };
if (args.includes("snapshot")) data = { url: failed ? errorUrl : good, refs: {}, snapshot: failed ? "Error page" : "Good page" };
process.stdout.write(JSON.stringify({ success, data }));
if (!success) process.exitCode = 1;`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
				for (const raw of [false, true]) {
					// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
					// oxlint-disable-next-line no-await-in-loop
					await rm(statePath, { force: true });
					const branch = [
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "open", "https://example.com/good"],
								command: "open",
								sessionName: "named",
								sessionTabTarget: {
									title: "Good",
									url: "https://example.com/good",
									targetId: "FIRST",
								},
							},
							isError: false,
						}),
					];
					const live = createExtensionHarness({ cwd: tempDir, branch });
					// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
					// oxlint-disable-next-line no-await-in-loop
					await runExtensionEvent(live.handlers, "session_start", { reason: "resume" }, live.ctx);
					// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
					// oxlint-disable-next-line no-await-in-loop
					const failed = await executeRegisteredTool(live.tool, live.ctx, {
						args: [
							"--session",
							"named",
							"batch",
							"--bail",
							...(raw ? ["open https://example.com/good", "open https://example.com/abort"] : []),
						],
						stdin: JSON.stringify(
							raw
								? [["open", "https://ignored.example/"]]
								: [
										["open", "https://example.com/good"],
										["open", "https://example.com/abort"],
									],
						),
					});
					// The nonempty raw fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(failed.isError, true);
					// The nonempty raw fixture matrix exhaustively verifies each case; any failed assertion fails the test.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.deepEqual(failed.details?.sessionTabTarget, {
						title: "Error",
						url: "chrome-error://chromewebdata/",
						targetId: "FIRST",
					});
					const replay = createExtensionHarness({
						cwd: tempDir,
						branch: live.ctx.sessionManager.getBranch().slice(),
					});
					// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
					// oxlint-disable-next-line no-await-in-loop
					await runExtensionEvent(
						replay.handlers,
						"session_start",
						{ reason: "resume" },
						replay.ctx,
					);
					for (const harness of [live, replay]) {
						// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
						// oxlint-disable-next-line no-await-in-loop
						const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "named", "snapshot", "-i"],
						});
						// The nonempty harness fixture matrix exhaustively verifies each case; any failed assertion fails the test.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
						// The nonempty harness fixture matrix exhaustively verifies each case; any failed assertion fails the test.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(snapshot.content[0].text ?? "", /Error page/);
					}
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension pre-pins resumed explicit-session eval stdin before execution",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "tab-state.json");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
let state = { active: "gemini" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
const activeSite = () => state.active === "example" ? exampleSite : gemini;
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: state.active === "example" },
    { tabId: "t2", title: gemini.title, url: gemini.url, active: state.active !== "example" }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  state.active = "example";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: activeSite().title }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: activeSite() }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const resumedHarness = createExtensionHarness({
					branch: [
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "open", "https://example.com"],
								command: "open",
								sessionName: "named",
								sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
							},
							isError: false,
						}),
					],
					cwd: tempDir,
				});
				await runExtensionEvent(
					resumedHarness.handlers,
					"session_start",
					{ reason: "resume" },
					resumedHarness.ctx,
				);

				const evalResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
					args: ["--session", "named", "eval", "--stdin"],
					stdin: "document.title",
				});
				assert.equal(evalResult.isError, false, JSON.stringify(evalResult));
				assert.match(readString(readRecord(evalResult.content[0]).text), /Example Domain/);
				assert.deepEqual(evalResult.details?.sessionTabTarget, {
					title: "Example Domain",
					url: "https://example.com/",
				});

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 7);
				assert.deepEqual(invocations[0].args, ["--json", "--session", "named", "tab", "list"]);
				assert.deepEqual(invocations[1].args, ["--json", "--session", "named", "tab", "t1"]);
				assert.deepEqual(invocations[2].args, ["--json", "--session", "named", "tab", "list"]);
				assert.deepEqual(invocations[3].args, ["--json", "--session", "named", "get", "url"]);
				assert.deepEqual(invocations[4].args, ["--json", "--session", "named", "eval", "--stdin"]);
				assert.equal(invocations[4].stdin, "document.title");
				assert.deepEqual(invocations[5].args, ["--json", "--session", "named", "get", "url"]);
				assert.deepEqual(invocations[6].args, ["--json", "--session", "named", "tab", "list"]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rejects unsupported or malformed stdin before resumed explicit-session tab planning",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Wrong", url: "https://wrong.example/" } }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const resumedHarness = createExtensionHarness({
					branch: [
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "open", "https://example.com"],
								command: "open",
								sessionName: "named",
								sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
							},
							isError: false,
						}),
					],
					cwd: tempDir,
				});
				await runExtensionEvent(
					resumedHarness.handlers,
					"session_start",
					{ reason: "resume" },
					resumedHarness.ctx,
				);
				const scenarios = [
					{
						name: "unsupported stdin",
						command: ["click", "@e9"],
						stdin: "oops",
						errorPatterns: [/stdin/i, /batch/i, /eval --stdin/i, /auth save --password-stdin/i],
					},
					{
						name: "invalid JSON",
						command: ["batch"],
						stdin: "not-json",
						errorPatterns: [/could not be parsed as JSON/i],
					},
					{
						name: "non-array step",
						command: ["batch"],
						stdin: JSON.stringify([{ oops: 1 }]),
						errorPatterns: [/step 0 must be an array of string command tokens/i],
					},
					{
						name: "non-string token",
						command: ["batch"],
						stdin: JSON.stringify([["click", 123]]),
						errorPatterns: [/step 0 token 1 must be a string/i],
					},
				];
				for (const scenario of scenarios) {
					// Every rejected input shares the unchanged resumed branch and must finish before advancing.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
						args: ["--session", "named", ...scenario.command],
						stdin: scenario.stdin,
					});
					// Each existing invalid-input row must reject for its specific error, not a later page guard.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.isError, true, `${scenario.name}: ${JSON.stringify(result)}`);
					for (const pattern of scenario.errorPatterns) {
						// Every row's existing error guidance remains required.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(readString(result.details?.validationError ?? ""), pattern, scenario.name);
					}
					if (scenario.name === "unsupported stdin") {
						// Carry the unsupported-command case's existing visible error and identity assertions.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(readString(readRecord(result.content[0]).text ?? ""), /stdin/i);
						// Carry the unsupported-command case's existing visible error and identity assertions.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(result.details?.sessionName, "named");
					}
					// Observe no helper/action dispatch before the next invalid-input row.
					// oxlint-disable-next-line no-await-in-loop
					const invocations = await readInvocationLog(logPath);
					// Every existing row rejects before tab planning or execution.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.deepEqual(invocations, [], scenario.name);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension preserves explicit navigation in a resumed user batch and derives the resulting target",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const sites = {
  example: { title: "Example Domain", url: "https://example.com/" },
  gemini: { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" },
  org: { title: "Example Org", url: "https://example.org/" }
};
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  let active = sites.gemini;
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? sites.example : sites.gemini;
      return { command: step, success: true, result: { tabId: rest[0], ...active } };
    }
    if (command === "open") {
      active = sites.org;
      return { command: step, success: true, result: active };
    }
    if (command === "get" && rest[0] === "title") {
      return { command: step, success: true, result: active.title };
    }
    if (command === "get" && rest[0] === "url") {
      return { command: step, success: true, result: active.url };
    }
    return { command: step, success: true, result: active };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: sites.example.title, url: sites.example.url, active: false },
    { tabId: "t2", title: sites.gemini.title, url: sites.gemini.url, active: true }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: sites.gemini }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const resumedHarness = createExtensionHarness({
					branch: [
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "open", "https://example.com"],
								command: "open",
								sessionName: "named",
								sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
							},
							isError: false,
						}),
					],
					cwd: tempDir,
				});
				await runExtensionEvent(
					resumedHarness.handlers,
					"session_start",
					{ reason: "resume" },
					resumedHarness.ctx,
				);

				const batchResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
					args: ["--session", "named", "batch"],
					stdin: JSON.stringify([
						["open", "https://example.org"],
						["get", "title"],
						["get", "url"],
					]),
				});
				assert.equal(batchResult.isError, false, JSON.stringify(batchResult));
				assert.match(readString(readRecord(batchResult.content[0]).text), /Example Org/);
				assert.deepEqual(batchResult.details?.sessionTabTarget, {
					title: "Example Org",
					url: "https://example.org/",
				});
				const batchSteps = readArray(batchResult.details.batchSteps).map(readRecord);
				assert.deepEqual(
					batchSteps.map((step) => step.command),
					[
						["open", "https://example.org"],
						["get", "title"],
						["get", "url"],
					],
				);

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 3);
				assert.deepEqual(invocations[2].args, ["--json", "--session", "named", "tab", "list"]);
				assert.deepEqual(invocations[0].args, ["--json", "--session", "named", "get", "url"]);
				assert.deepEqual(invocations[1].args, ["--json", "--session", "named", "batch"]);
				assert.deepEqual(JSON.parse(readString(invocations[1].stdin ?? "[]")), [
					["open", "https://example.org"],
					["get", "title"],
					["get", "url"],
				]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension does not combine stale batch title with a later url after intervening commands",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const example = { title: "Example Domain", url: "https://example.com/" };
let active = example;
const org = { title: "Example Org", url: "https://example.org/" };
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? example : active;
      return { command: step, success: true, result: { tabId: rest[0], ...active } };
    }
    if (command === "get" && rest[0] === "title") {
      return { command: step, success: true, result: active.title };
    }
    if (command === "open") {
      active = org;
      return { command: step, success: true, result: { status: "navigated" } };
    }
    if (command === "get" && rest[0] === "url") {
      return { command: step, success: true, result: active.url };
    }
    return { command: step, success: true, result: { status: "ok" } };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: example.title, url: example.url, active: true },
    { tabId: "t2", title: "Other", url: "https://other.example/", active: false }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: active }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const resumedHarness = createExtensionHarness({
					branch: [
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "open", "https://example.com"],
								command: "open",
								sessionName: "named",
								sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
							},
							isError: false,
						}),
					],
					cwd: tempDir,
				});
				await runExtensionEvent(
					resumedHarness.handlers,
					"session_start",
					{ reason: "resume" },
					resumedHarness.ctx,
				);

				const batchResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
					args: ["--session", "named", "batch"],
					stdin: JSON.stringify([
						["get", "title"],
						["open", "https://example.org"],
						["get", "url"],
					]),
				});
				assert.equal(batchResult.isError, false, JSON.stringify(batchResult));
				assert.deepEqual(batchResult.details?.sessionTabTarget, {
					title: undefined,
					url: "https://example.org/",
				});

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 4);
				assert.deepEqual(invocations[3].args, ["--json", "--session", "named", "tab", "list"]);
				assert.deepEqual(invocations[0].args, ["--json", "--session", "named", "tab", "list"]);
				assert.deepEqual(JSON.parse(readString(invocations[2].stdin ?? "[]")), [
					["get", "title"],
					["open", "https://example.org"],
					["get", "url"],
				]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension re-selects the navigated tab after --session-name fresh opens when restored tabs steal focus",
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
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
    { tabId: "t2", title: "Restored Tab", url: "https://restored.example.com/", active: true }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", title: "Example Domain", url: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session-name", "saved-auth", "open", "https://example.com"],
					sessionMode: "fresh",
				});
				assert.equal(result.isError, false);
				assert.deepEqual(result.details?.openResultTabCorrection, {
					selectedTab: "t1",
					selectionKind: "tabId",
					targetTitle: "Example Domain",
					targetUrl: "https://example.com/",
				});

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 4);
				assert.deepEqual(invocations[3].args.slice(-2), ["tab", "list"]);
				assert.equal(invocations[0].args.includes("--session-name"), true);
				assert.deepEqual(invocations[1].args.slice(-2), ["tab", "list"]);
				assert.deepEqual(invocations[2].args.slice(-2), ["tab", "t1"]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
