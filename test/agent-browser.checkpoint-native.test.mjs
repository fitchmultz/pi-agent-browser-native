// Opt-in, model-free integration with a checkpoint-capable native Pi SDK and
// stock agent-browser. Run in an isolated HOME (empty browser profiles only).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const sdkPath = process.env.PI_CHECKPOINT_TEST_SDK;
const extensionPath = resolve(process.env.PI_CHECKPOINT_TEST_EXTENSION ?? ".");
// Repeat the unchanged extension's root-restore path without asserting new hooks.
const baselineRestore = process.env.PI_CHECKPOINT_TEST_BASELINE_RESTORE === "1";

test("native idle checkpoint, active controls, and stable root restore", { skip: !sdkPath, timeout: 240_000 }, async (t) => {
 const sdk = await import(pathToFileURL(sdkPath).href);
 assert.equal(typeof sdk.createAgentSession, "function");
 assert.ok(process.env.PI_CHECKPOINT_TEST_BROWSER_DIR, "Supply an installed stock Chrome-for-Testing directory (binaries only)");
 const browserDir = resolve(process.env.PI_CHECKPOINT_TEST_BROWSER_DIR);
 const originalEnv = { ...process.env };
 const root = await mkdtemp(join(tmpdir(), "piab-cp-"));
 for (const key of Object.keys(process.env)) {
  if (/^(AGENT_BROWSER_|PI_AGENT_BROWSER_|PI_SUBAGENT_|EXA_API_KEY$|BRAVE_API_KEY$)/i.test(key) || /^(https?|all|no)_proxy$/i.test(key)) delete process.env[key];
 }
 process.env.HOME = join(root, "home");
 process.env.PI_AGENT_BROWSER_SOCKET_DIR = join(root, "sockets");
 process.env.PI_CODING_AGENT_DIR = join(root, "agent");
 process.env.PI_OFFLINE = "1";
 await mkdir(join(process.env.HOME, ".agent-browser", "browsers"), { recursive: true });
 await cp(browserDir, join(process.env.HOME, ".agent-browser", "browsers", browserDir.split(/[\\/]/).at(-1)), { recursive: true });
 const cwd = join(root, "checkout");
 const agentDir = join(root, "agent");
 await mkdir(join(cwd, ".git"), { recursive: true });
 await mkdir(agentDir);
 const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Checkpoint fixture</title><h1>Empty-profile fixture</h1>"); });
 await new Promise(done => server.listen(0, "127.0.0.1", done));
 const url = `http://127.0.0.1:${server.address().port}/fixture`;
 const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
 const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false, authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json") });
 let session, sm, result, callController, beforeResult;
 let callId = 0;
 const createLoader = () => new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [extensionPath],
  extensionFactories: [pi => pi.registerCommand("checkpoint-browser-test", { description: "Model-free test dispatch", handler: async args => {
   const tool = session.agent.state.tools.find(tool => tool.name === "agent_browser");
   assert.ok(tool);
   const id = `checkpoint-call-${++callId}`;
   result = await tool.execute(id, JSON.parse(args), callController?.signal);
   await beforeResult?.();
   // Real native entries from real tool results, without a model/provider call.
   sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "agent_browser", content: result.content, details: result.details, isError: result.isError === true, timestamp: Date.now() });
  } })],
 });
 let loader = createLoader();
 await loader.reload();
 assert.deepEqual(loader.getExtensions().errors, []);
 sm = sdk.SessionManager.create(cwd, join(root, "sessions"));
 ({ session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, resourceLoader: loader, settingsManager, sessionManager: sm, noTools: "builtin" }));
 await session.bindExtensions({ onError: e => { throw new Error(e.error); } });
 // Materialize the synthetic native journal without invoking a provider.
 sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic checkpoint fixture." }], api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
 const receipts = [];
 const call = async params => { await session.prompt(`/checkpoint-browser-test ${JSON.stringify(params)}`); return result; };
 const ok = async params => {
  const value = await call(params);
  assert.notEqual(value.isError, true, JSON.stringify(value));
  // Native close can acknowledge before its daemon finishes exiting (macOS).
  // Observe that exit independently; never weaken the checkpoint's live blocker.
  if (params.args?.at(-1) === "close") {
   const name = value.details.sessionName;
   assert.ok(name);
   let status;
   for (let i = 0; i < 100; i++) {
    status = JSON.parse(execFileSync("agent-browser", ["--json", "--namespace", "", "--session", name, "session", "info"], {
     encoding: "utf8", timeout: 5000, env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: process.env.PI_AGENT_BROWSER_SOCKET_DIR },
    }));
    if (status.data.active === false) break;
    await delay(50);
   }
   assert.equal(status.data.active, false, JSON.stringify(status));
  }
  return value;
 };
 const checkpoint = async (label, ready, reason) => {
  let released = 0;
  const hold = await session.acquireCheckpoint({ signal: AbortSignal.timeout(10_000), quiesce: () => () => released++ });
  try {
   receipts.push({ label, sleepReady: hold.sleepReady, sleepBlockers: hold.sleepBlockers });
   assert.equal(hold.sleepReady, baselineRestore ? false : ready, JSON.stringify(receipts.at(-1)));
   if (baselineRestore) assert.match(hold.sleepBlockers.join("\n"), /Extension requires shutdown/);
   else if (reason) assert.match(hold.sleepBlockers.join("\n"), reason);
   assert.equal(hold.signal.aborted, false);
   return hold.checkpoint;
  } finally { hold.release(); hold.release(); assert.equal(released, 1); assert.equal(hold.signal.aborted, true); }
 };
 const waitFor = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(25); } throw new Error("fixture did not reach expected state"); };
 let rootName;
 try {
  if (!baselineRestore) {
  await t.test("idle release, help, and reload remain usable", async () => {
   await checkpoint("initial idle", true);
   await ok({ args: ["--version"] });
   await checkpoint("inspection only", true);
   await session.reload();
   await checkpoint("idle after native reload", true);
  });
  await t.test("native journal repair owns capture and strict cold restore", async () => {
   const journal = sm.getSessionFile();
   const before = await readFile(journal);
   const leaf = sm.getLeafId();
   await chmod(journal, 0o400);
   try {
    assert.throws(() => sm.appendLabelChange(leaf, "accepted despite EACCES"), { code: "EACCES" });
    const accepted = sm.getEntries();
    let released = 0;
    await assert.rejects(session.acquireCheckpoint({ signal: AbortSignal.timeout(10_000), quiesce: () => () => released++ }), { code: "EACCES" });
    assert.equal(released, 1);
    assert.equal(session.isCheckpointHeld, false);
    assert.deepEqual(await readFile(journal), before);
    assert.deepEqual(sm.getEntries(), accepted);
    receipts.push({ label: "ongoing native journal failure", acquisition: "EACCES", priorBytesPreserved: true, acceptedEntriesPreserved: true });
   } finally { await chmod(journal, 0o600); }
   // No repeat append or extension reload: core flush runs AFTER the browser hook.
   sm.branch(leaf);
   const accepted = sm.getEntries();
   const revision = sm.getEntriesRevision();
   const hold = await session.acquireCheckpoint({ signal: AbortSignal.timeout(10_000), quiesce: () => () => {} });
   try {
    assert.deepEqual(sm.getEntries(), accepted);
    assert.equal(sm.getEntriesRevision(), revision);
    assert.equal(sm.getLeafId(), leaf);
    assert.deepEqual((await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse), [hold.checkpoint.header, ...hold.checkpoint.entries]);
    assert.equal(JSON.stringify(sdk.openSessionCheckpoint(hold.checkpoint).getEntries()), JSON.stringify(accepted));
    receipts.push({ label: "native repair before receipt", sleepReady: hold.sleepReady, sleepBlockers: hold.sleepBlockers, journalMatches: true, strictRestore: true });
    assert.equal(hold.sleepReady, true, JSON.stringify(receipts.at(-1)));
    const savedPath = join(root, "repaired-checkpoint.json");
    sdk.writeSessionCheckpoint(savedPath, hold.checkpoint);
    const cold = execFileSync(process.execPath, ["--input-type=module", "--eval", `
     import assert from "node:assert/strict";
     const sdk = await import(${JSON.stringify(pathToFileURL(sdkPath).href)});
     const saved = sdk.readSessionCheckpoint(${JSON.stringify(savedPath)});
     const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
     const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false, authPath: ${JSON.stringify(join(agentDir, "auth.json"))}, modelsPath: null });
     const resourceLoader = new sdk.DefaultResourceLoader({ cwd: saved.selection.cwd, agentDir: ${JSON.stringify(agentDir)}, settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [${JSON.stringify(extensionPath)}] });
     await resourceLoader.reload();
     const { session } = await sdk.createAgentSession({ checkpoint: saved, modelRuntime, resourceLoader, settingsManager });
     await session.bindExtensions({});
     assert.equal(session.sessionId, saved.selection.sessionId);
     assert.equal(session.sessionManager.getLeafId(), saved.selection.leafId);
     assert.deepEqual(session.sessionManager.getEntries(), saved.entries);
     assert.deepEqual(session.getActiveToolNames(), saved.selection.activeTools);
     assert.equal(session.model, undefined);
     session.dispose();
     console.log("strict cold restore passed");
    `], { encoding: "utf8", timeout: 30_000, env: process.env });
    assert.match(cold, /strict cold restore passed/);
    const mismatched = structuredClone(hold.checkpoint);
    mismatched.entries.at(-1).label = "not the saved label";
    assert.throws(() => sdk.openSessionCheckpoint(mismatched), /journal differs/);
    receipts.push({ label: "repaired journal separate-process restore", exactSelectionAndEntries: true, mismatchedArtifactRejected: true });
   } finally { hold.release(); }
  });
  await t.test("detached SDK script execution has an explicit extension blocker", async () => {
   const controller = new AbortController();
   const tool = session.agent.state.tools.find(tool => tool.name === "agent_browser");
   const running = tool.execute("detached-script", { script: "await new Promise(() => {});", timeoutMs: 10_000 }, controller.signal);
   try {
    await delay(200);
    await checkpoint("detached script", false, /script execution/);
   } finally { controller.abort(); await running; }
   await checkpoint("detached script released", true);
  });
  await t.test("root browser, branch navigation, routes, and traces remain blockers", async () => {
   const beforeBrowser = sm.getLeafId();
   const opened = await ok({ args: ["open", url] });
   rootName = opened.details.sessionName;
   assert.match(rootName, /^pi-root-/);
   await checkpoint("live root", false, /daemon/);
   const waiting = call({ args: ["wait", "1000"] });
   await delay(100);
   await assert.rejects(session.acquireCheckpoint({ signal: AbortSignal.timeout(100), quiesce: () => () => {} }), /cancel/i);
   await waiting;
   receipts.push({ label: "awaited browser command/queue", acquisition: "waited then cancelled" });
   await session.navigateTree(beforeBrowser, { summarize: false });
   await checkpoint("off-branch live root", false, /daemon/);
   await session.reload();
   await checkpoint("caller-owned root survives reload", false, /daemon/);
   await ok({ args: ["network", "route", "**/unused-fixture", "--abort"] });
   await checkpoint("route retained", false, /routes/);
   await ok({ args: ["network", "unroute", "**/unused-fixture"] });
   await ok({ args: ["trace", "start"] });
   await checkpoint("trace retained", false, /trace/);
   await ok({ args: ["trace", "stop", join(root, "trace.zip")] });
   await ok({ args: ["close"] });
   await checkpoint("explicitly closed root", true);
  });
  await t.test("caller-owned attachment survives reload and is not closed by checkpoint", async () => {
   await ok({ args: ["open", url] });
   const endpoint = await ok({ args: ["get", "cdp-url"] });
   const attached = `checkpoint-attached-${sm.getSessionId()}`;
   try {
    await ok({ args: ["--session", attached, "connect", endpoint.details.data.cdpUrl] });
    await checkpoint("caller-owned attachment", false, /Attached browser/);
    await session.reload();
    await checkpoint("attachment survives native reload", false, /Attached browser/);
    await ok({ args: ["--session", attached, "get", "url"] });
   } finally { await ok({ args: ["--session", attached, "close"] }); }
   await ok({ args: ["--session", rootName, "close"] });
   await checkpoint("attachments explicitly released", true);
  });
  await t.test("unnamed native launch behind an explicit URL read stays blocked", async () => {
   const profile = join(root, "empty-profile"); await mkdir(profile);
   try {
    const read = await ok({ args: ["--profile", profile, "read", url] });
    assert.equal(read.details.sessionName, undefined);
    const status = JSON.parse(execFileSync("agent-browser", ["--json", "--namespace", "", "--session", "default", "session", "info"], {
     encoding: "utf8", timeout: 5000, env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: process.env.PI_AGENT_BROWSER_SOCKET_DIR },
    }));
    assert.equal(status.data.active, true);
    assert.equal(status.data.runtime.browserLaunched, true);
    receipts.push({ label: "unnamed native browser observation", daemonActive: true, browserLaunched: true });
    await checkpoint("unnamed native launch", false, /daemon/);
   } finally { await ok({ args: ["--session", "default", "close"] }); }
   await checkpoint("unnamed native launch closed", true);
  });
  await t.test("managed fresh browser keeps ordinary ownership and cleanup", async () => {
   const opened = await ok({ args: ["open", url], sessionMode: "fresh" });
   assert.match(opened.details.sessionName, /^piab-/);
   await checkpoint("live managed fresh", false, /daemon/);
   await session.reload();
   await checkpoint("managed browser survives reload", false, /daemon/);
   await ok({ args: ["close"] });
   await checkpoint("managed browser explicitly closed", true);
  });
  await t.test("active recording and failed real journal append cannot qualify", async () => {
   await ok({ args: ["open", url] });
   await ok({ args: ["record", "start", join(root, "record.webm")] });
   await checkpoint("recording", false, /recording is pending/);
   await delay(12_000);
   await chmod(sm.getSessionFile(), 0o400);
   beforeResult = () => chmod(sm.getSessionFile(), 0o600);
   const stopped = await call({ args: ["record", "stop"] });
   beforeResult = undefined;
   assert.ok(stopped.details.recordingPersistenceWarning, "failed append must retain dirty state");
   await chmod(sm.getSessionFile(), 0o400);
   const beforeRetry = await readFile(sm.getSessionFile());
   await assert.rejects(session.acquireCheckpoint({ signal: AbortSignal.timeout(10_000), quiesce: () => () => {} }), { code: "EACCES" });
   assert.equal(session.isCheckpointHeld, false);
   assert.deepEqual(await readFile(sm.getSessionFile()), beforeRetry);
   receipts.push({ label: "failed recording journal retry", acquisition: "EACCES", priorBytesPreserved: true });
   await chmod(sm.getSessionFile(), 0o600);
   await checkpoint("journal repaired but browser live", false, /daemon/);
   await ok({ args: ["close"] });
   const repaired = await checkpoint("recording retired after native journal repair", true);
   assert.equal(JSON.stringify(sdk.openSessionCheckpoint(repaired).getEntries()), JSON.stringify(sm.getEntries()));
  });
  await t.test("native ownership waits for script; failed cleanup lease is retained", async () => {
   callController = new AbortController();
   const running = call({ script: 'await browser({args:["open","about:blank"]}); await new Promise(() => {});', timeoutMs: 30_000 });
   await waitFor(() => sm.getEntries().some(entry => entry.type === "custom" && entry.customType === "agent-browser-script-session"));
   await assert.rejects(session.acquireCheckpoint({ signal: AbortSignal.timeout(200), quiesce: () => () => {} }), /cancel/i);
   receipts.push({ label: "active script/native command", acquisition: "waited then cancelled" });
   await chmod(sm.getSessionFile(), 0o400);
   beforeResult = () => chmod(sm.getSessionFile(), 0o600);
   callController.abort();
   await running;
   beforeResult = undefined; callController = undefined;
   assert.equal(result.details.failureCategory, "cleanup-failed", JSON.stringify(result));
   await checkpoint("failed script cleanup lease", false, /lease/);
   await session.reload();
   const repaired = await checkpoint("startup lease recovery after native journal repair", true);
   assert.equal(JSON.stringify(sdk.openSessionCheckpoint(repaired).getEntries()), JSON.stringify(sm.getEntries()));
  });
  }
  await t.test("native root restore survives fresh checkout and state-directory inodes", async () => {
   // Independently qualify root save/reopen with a fresh native session.
   session.dispose();
   loader = createLoader(); await loader.reload();
   sm = sdk.SessionManager.create(cwd, join(root, "restore-sessions"));
   ({ session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, resourceLoader: loader, settingsManager, sessionManager: sm, noTools: "builtin" }));
   await session.bindExtensions({ onError: e => { throw new Error(e.error); } });
   const opened = await ok({ args: ["open", url] });
   rootName = opened.details.sessionName;
   assert.match(rootName, /^pi-root-/);
   const nativeStatus = await ok({ args: ["--session", rootName, "session", "info"] });
   assert.equal(nativeStatus.details.data.runtime.restoreKey, rootName);
   await ok({ args: ["eval", "--stdin"], stdin: 'document.cookie="checkpoint_fixture=synthetic;path=/;max-age=3600"; localStorage.setItem("fixture","local"); sessionStorage.setItem("fixture","session"); true' });
   await ok({ args: ["close"] });
   const checkpointPath = join(root, "native-checkpoint.json");
   sdk.writeSessionCheckpoint(checkpointPath, await checkpoint("root closed before cold restore", true));
   const saved = sdk.readSessionCheckpoint(checkpointPath);
   assert.equal(saved.selection.sessionId, sm.getSessionId());
   const stateDir = join(process.env.HOME, ".agent-browser", "sessions");
   const before = { cwd: (await stat(cwd)).ino, state: (await stat(stateDir)).ino };
   const marker = join(cwd, ".git", "fixture-marker"); await writeFile(marker, "stable synthetic checkout\n");
   for (const dir of [cwd, stateDir]) {
    await cp(dir, `${dir}.copy`, { recursive: true });
    await rename(dir, `${dir}.old`); await rename(`${dir}.copy`, dir);
    await rm(`${dir}.old`, { recursive: true });
   }
   assert.notEqual((await stat(cwd)).ino, before.cwd);
   assert.notEqual((await stat(stateDir)).ino, before.state);
   assert.equal(await readFile(marker, "utf8"), "stable synthetic checkout\n");
   // Cold extension instance through the actual native checkpoint factory path.
   session.dispose();
   loader = createLoader(); await loader.reload();
   ({ session } = await sdk.createAgentSession({ checkpoint: saved, cwd, agentDir, modelRuntime, resourceLoader: loader, settingsManager, noTools: "builtin" }));
   sm = session.sessionManager;
   await session.bindExtensions({ onError: e => { throw new Error(e.error); } });
   assert.equal(sm.getSessionId(), saved.selection.sessionId);
   assert.equal(sm.getLeafId(), saved.selection.leafId);
   assert.deepEqual(sm.getEntries(), saved.entries);
   assert.deepEqual(session.getActiveToolNames(), saved.selection.activeTools);
   await checkpoint("native checkpoint restored idle", true);
   const reopened = await ok({ args: ["open", url] });
   assert.equal(reopened.details.sessionName, rootName);
   const restoredStatus = await ok({ args: ["--session", rootName, "session", "info"] });
   assert.equal(restoredStatus.details.data.runtime.restoreKey, rootName);
   const observed = await ok({ args: ["eval", "--stdin"], stdin: '({checks:[document.cookie === "checkpoint_fixture=synthetic", localStorage.getItem("fixture") === "local", sessionStorage.getItem("fixture") === "session"]})' });
   assert.deepEqual(observed.details.data.result, { checks: [true, true, true] });
   receipts.push({ label: "stable root fresh filesystem restore", sessionName: rootName, cwdInodeChanged: true, stateInodeChanged: true, syntheticStateRestored: true });
   await checkpoint("restored live page still blocks", false, /daemon/);
   await ok({ args: ["close"] });
   await checkpoint("final idle", true);
  });
 } finally {
  await chmod(sm.getSessionFile(), 0o600).catch(() => {});
  beforeResult = undefined; callController?.abort();
  if (rootName) await call({ args: ["--session", rootName, "close"] }).catch(() => {});
  await session.reload().catch(() => {});
  session.dispose();
  await new Promise(done => server.close(done));
  console.log(JSON.stringify({ receipts }));
  await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
 }
});
