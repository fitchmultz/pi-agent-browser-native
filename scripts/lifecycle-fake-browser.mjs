/** Deterministic native-browser subprocess fixture used only by configured-source lifecycle verification. */
import { TARGET_AGENT_BROWSER_VERSION_LABEL } from "./agent-browser-target.mjs";

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const versionArgs = args[0] === "--allow-file-access" && args[1] === "false" ? args.slice(2) : args;
if (versionArgs.length === 1 && versionArgs[0] === "--version") {
  process.stdout.write(${JSON.stringify(TARGET_AGENT_BROWSER_VERSION_LABEL)});
  process.exit(0);
}
const stateDir = process.env.AGENT_BROWSER_PIAB_LIFECYCLE_FAKE_STATE_DIR;
if (!stateDir) {
  console.error("AGENT_BROWSER_PIAB_LIFECYCLE_FAKE_STATE_DIR is required");
  process.exit(64);
}
const stdin = fs.readFileSync(0, "utf8");
fs.mkdirSync(stateDir, { recursive: true });
function valueAfter(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function commandTokens() {
  const tokens = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (["--allow-file-access", "--args", "--namespace", "--session"].includes(arg)) { index += 1; continue; }
    tokens.push(arg);
  }
  return tokens;
}
const sessionName = valueAfter("--session") || "default";
const statePath = path.join(stateDir, encodeURIComponent(sessionName) + ".json");
function load() { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { title: "Blank", url: "about:blank", activeTab: "t1" }; } }
function save(state) { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }
function tabList(state) { return { tabs: [{ tabId: "t1", label: "t1", index: 0, title: state.title, url: state.url, active: true }] }; }
function execute(tokens) {
  let state = load();
  const [command, ...rest] = tokens;
  if (command === "session" && rest[0] === "info") {
    const active = fs.existsSync(statePath);
    return { result: { active, runtime: active ? {
      restoreKey: state.restoreKey ?? null,
      backgroundPid: Number(process.env.AGENT_BROWSER_PIAB_LIFECYCLE_FAKE_DAEMON_PID),
      socketDir: process.env.AGENT_BROWSER_SOCKET_DIR ?? "",
      browserLaunched: true,
    } : null } };
  }
  if (command === "open") {
    const url = rest[rest.length - 1] || "about:blank";
    state = { ...state, title: url.includes("react.dev") ? "React" : "Lifecycle Page", url, activeTab: "t1", restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null };
    save(state);
    return { result: { title: state.title, url: state.url } };
  }
  if (command === "snapshot") {
    return { result: { origin: state.url, refs: { e1: { role: "heading", name: state.title } }, snapshot: '- heading "' + state.title + '" [ref=e1]' } };
  }
  if (command === "get" && rest.includes("url")) return { result: state.url };
  if (command === "get" && rest.includes("title")) return { result: state.title };
  if (command === "eval") return { result: "PIAB-LIFECYCLE-LARGE-OUTPUT\\n" + "x".repeat(700 * 1024) };
  if (command === "tab" && rest.includes("list")) return { result: tabList(state) };
  if (command === "tab") return { result: { selectedTab: rest[0] || "t1", ...state } };
  if (command === "close") {
    try { fs.unlinkSync(statePath); } catch {}
    return { result: { closed: true, sessionName } };
  }
  return { result: { ok: true, command, args: rest, stdin, state } };
}
function executeBatch(steps) {
  let mode = "clean";
  let staleNetwork = true;
  let staleConsole = true;
  let staleErrors = true;
  return steps.map((step) => {
    const name = step[0];
    if (name === "open") {
      const url = String(step[1] || "about:blank");
      const title = url.includes("react.dev") ? "React" : "Lifecycle QA Page";
      save({ title, url, activeTab: "t1", restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null });
      mode = url.includes("fail") ? "fail" : "clean";
      return { command: step, success: true, result: { title, url } };
    }
    if (name === "network") {
      if (step.includes("--clear")) { staleNetwork = false; return { command: step, success: true, result: { requests: [] } }; }
      if (staleNetwork || mode === "fail") return { command: step, success: true, result: { requests: [{ method: "GET", resourceType: "fetch", status: 500, url: "https://fail.example.test/api" }] } };
      return { command: step, success: true, result: { requests: [] } };
    }
    if (name === "console") {
      if (step.includes("--clear")) { staleConsole = false; return { command: step, success: true, result: { messages: [] } }; }
      return { command: step, success: true, result: staleConsole || mode === "fail" ? { messages: [{ type: "error", text: "lifecycle console boom" }] } : { messages: [] } };
    }
    if (name === "errors") {
      if (step.includes("--clear")) { staleErrors = false; return { command: step, success: true, result: { errors: [] } }; }
      return { command: step, success: true, result: staleErrors || mode === "fail" ? { errors: [{ text: "lifecycle page boom" }] } : { errors: [] } };
    }
    return { command: step, success: true, result: { ok: true } };
  });
}
const tokens = commandTokens();
let data;
if (tokens[0] === "batch") {
  let steps;
  try { steps = JSON.parse(stdin || "[]"); } catch (error) { throw new Error("Invalid batch stdin: " + error.message); }
  data = executeBatch(steps);
} else {
  data = execute(tokens).result;
}
process.stdout.write(JSON.stringify({ success: true, data }));
`;

export function fakeAgentBrowserScript() {
	return SCRIPT;
}
