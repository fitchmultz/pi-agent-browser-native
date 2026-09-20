// Real native SDK workers: no model/provider, fake upstream, or fabricated ownership.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

async function worker(options) {
 const sdk = await import(pathToFileURL(options.sdkPath).href);
 const { cwd, agentDir } = options;
 const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
 const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false, authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json") });
 let session, result, callId = 0;
 const sm = options.journal ? sdk.SessionManager.open(options.journal) : sdk.SessionManager.create(cwd, join(options.root, "crash-sessions"));
 const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [options.extensionPath],
  extensionFactories: [pi => pi.registerCommand("offbranch-test", { description: "Model-free real tool dispatch", handler: async args => {
   const id = `offbranch-${++callId}`;
   result = await session.agent.state.tools.find(tool => tool.name === "agent_browser").execute(id, JSON.parse(args));
   // Persist only the actual executed tool's result.
   sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "agent_browser", content: result.content, details: result.details, isError: result.isError === true, timestamp: Date.now() });
  } })],
 });
 await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
 ({ session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: sm, noTools: "builtin" }));
 await session.bindExtensions({ onError: e => { throw new Error(e.error); } });
 assert.equal(session.model, undefined);
 if (!options.journal) {
  // Journal materialization only; this marker contains no browser ownership.
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Model-free crash fixture." }], api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
 }
 const state = () => ({ pid: process.pid, journal: sm.getSessionFile(), leaf: sm.getLeafId(), branch: sm.getBranch().map(e => e.id), entries: sm.getEntries().map(e => e.id) });
 process.on("message", async ({ action, params }) => {
  try {
   if (action === "call") { await session.prompt(`/offbranch-test ${JSON.stringify(params)}`); process.send({ result, ...state() }); }
   else if (action === "branch") {
    assert.equal((await session.navigateTree(params, { summarize: false })).cancelled, false);
    sm.appendMessage({ role: "user", content: "Branch B without browser work", timestamp: Date.now() });
    process.send(state());
   } else if (action === "checkpoint") {
    const hold = await session.acquireCheckpoint({ signal: AbortSignal.timeout(10_000), quiesce: () => () => {} });
    try { process.send({ sleepReady: hold.sleepReady, sleepBlockers: hold.sleepBlockers, ...state() }); }
    finally { hold.release(); }
   } else if (action === "reload") { await session.reload(); process.send(state()); }
   else if (action === "dispose") { session.dispose(); process.send(state()); process.disconnect(); }
  } catch (error) { process.send({ error: error.stack }); }
 });
 process.send(state());
}

export async function qualifyOffbranchRouting(options) {
 const ambient = await mkdtemp(join(tmpdir(), "p-")); // Short enough for namespaced stock sockets.
 const owned = `${process.platform === "darwin" ? "/private/tmp" : "/tmp"}/piab-${process.getuid()}`;
 const env = { ...process.env, AGENT_BROWSER_SOCKET_DIR: ambient };
 delete env.PI_AGENT_BROWSER_SOCKET_DIR;
 const children = [], identities = [];
 const receive = child => new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(new Error("native fixture worker timed out")), 30_000);
  const exited = (code, signal) => finish(new Error(`native fixture worker exited: ${code}/${signal}`));
  const message = value => finish(value.error ? new Error(value.error) : undefined, value);
  function finish(error, value) { clearTimeout(timer); child.off("exit", exited); child.off("message", message); error ? reject(error) : resolve(value); }
  child.once("exit", exited); child.once("message", message);
 });
 const start = async journal => {
  const child = fork(fileURLToPath(import.meta.url), ["worker", JSON.stringify({ ...options, receipts: undefined, journal })], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  children.push(child);
  return { child, state: await receive(child) };
 };
 const request = async (child, action, params) => { const response = receive(child); child.send({ action, params }); return await response; };
 const call = async (child, params) => { const value = await request(child, "call", params); assert.notEqual(value.result.isError, true, JSON.stringify(value)); return value; };
 const native = (identity, args) => JSON.parse(execFileSync("agent-browser", ["--json", "--namespace", identity.namespace ?? "", "--session", identity.name, ...args], {
  encoding: "utf8", timeout: 10_000, env: { ...env, AGENT_BROWSER_SOCKET_DIR: identity.socketDir },
 })).data;
 const status = identity => native(identity, ["session", "info"]);
 const close = async identity => {
  native(identity, ["close"]);
  for (let i = 0; i < 100 && status(identity).active; i++) await delay(50);
  assert.equal(status(identity).active, false);
 };
 const checkpoint = async (child, label, ready) => {
  const value = await request(child, "checkpoint");
  options.receipts.push({ label, ...value });
  assert.equal(value.sleepReady, ready, JSON.stringify(value));
  if (!ready) assert.match(value.sleepBlockers.join("\n"), /daemon/);
 };
 try {
  const first = await start();
  const opened = await call(first.child, { args: ["open", "about:blank"], sessionMode: "fresh" });
  const fresh = { name: opened.result.details.sessionName, socketDir: owned };
  identities.push(fresh);
  const live = status(fresh);
  assert.equal(live.active, true); assert.equal(live.runtime.browserLaunched, true); assert.equal(live.runtime.pageCount, 1);
  assert.equal(status({ ...fresh, socketDir: ambient }).active, false);
  await checkpoint(first.child, "owned before branch/crash", false);
  const branch = await request(first.child, "branch", first.state.leaf);
  assert.equal(branch.branch.includes(opened.leaf), false); assert.equal(branch.entries.includes(opened.leaf), true);
  await checkpoint(first.child, "off-branch still runtime-owned", false);
  const exited = once(first.child, "exit");
  first.child.kill("SIGKILL"); // Exact owned SDK PID only; never the daemon/process group.
  assert.deepEqual(await exited, [null, "SIGKILL"]);
  assert.equal(status(fresh).pid, live.pid);

  const second = await start(branch.journal);
  assert.notEqual(second.state.pid, first.state.pid); assert.equal(second.state.leaf, branch.leaf);
  assert.equal(second.state.branch.includes(opened.leaf), false); assert.equal(second.state.entries.includes(opened.leaf), true);
  options.receipts.push({ label: "real crash/reopen provenance", firstPiPid: first.state.pid, secondPiPid: second.state.pid, live, ambient: status({ ...fresh, socketDir: ambient }), actualOpenDetails: opened.result.details });
  await checkpoint(second.child, "historical owned browser after abnormal restart", false);
  assert.equal(status(fresh).pid, live.pid);
  await request(second.child, "reload");
  assert.equal(status(fresh).pid, live.pid, "inspection must not acquire off-branch cleanup ownership");
  await checkpoint(second.child, "historical browser survives ordinary reload", false);
  await close(fresh);
  await checkpoint(second.child, "historical daemon explicitly closed", true);

  // Exact wrapper base/fresh pattern is not provenance. Explicit fresh is still caller-owned.
  // Reusing the real historical name in another namespace must not inherit its routing either.
  for (const identity of [
   { name: fresh.name.replace(/fresh-.+$/, "fresh-caller"), socketDir: ambient },
   { name: fresh.name, namespace: "c", socketDir: ambient },
  ]) {
   identities.push(identity);
   const args = ["--namespace", identity.namespace ?? "", "--session", identity.name];
   await call(second.child, { args: [...args, "open", "about:blank"], sessionMode: "fresh" });
   const caller = status(identity); assert.equal(caller.active, true);
   assert.equal(status({ ...identity, socketDir: owned }).active, false);
   await checkpoint(second.child, "explicit managed-looking caller retains ambient routing", false);
   await request(second.child, "reload");
   assert.equal(status(identity).pid, caller.pid);
   await checkpoint(second.child, "caller survives reload without cleanup ownership", false);
   await call(second.child, { args: [...args, "close"] });
   await close(identity);
   await checkpoint(second.child, "caller explicitly closed", true);
  }
  const done = once(second.child, "exit"); await request(second.child, "dispose"); assert.deepEqual(await done, [0, null]);
 } finally {
  for (const child of children) {
   if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; }
  }
  for (const identity of identities) await close(identity);
  await rm(ambient, { recursive: true, force: true });
 }
}

if (process.argv[2] === "worker") await worker(JSON.parse(process.argv[3]));
