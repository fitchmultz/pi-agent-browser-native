#!/usr/bin/env node
// Temporary CI evidence, not a replacement gate or a performance-budget change.
// Run AFTER default/native verification, with both builds and identical native deps.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { cpus, release } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = realpathSync(process.argv[2]);
const out = join(root, "logs/startup-diagnostic");
mkdirSync(out); // Refuse to overwrite an earlier receipt / retry until green.
const trees = { B: join(root, "startup-baseline"), H: join(root, "extension") };
const startupFile = "test/agent-browser.startup.test.ts";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
assert.equal(process.version, "v26.9.0");
assert.notEqual(process.getuid(), 0);
assert.equal(realpathSync(process.env.HOME), join(root, "home"));
assert.equal(process.env.PI_OFFLINE, "1");
assert.equal(git(trees.B, "rev-parse", "HEAD"), "b1e083e345d0ed9c2c2f9f20953c657a2e0da8a8");

// Only known loader controls, never the ambient environment / credentials.
function loaderContext() {
  const keys = ["NODE_OPTIONS", "NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE", "NODE_PATH", "NODE_V8_COVERAGE", "NODE_TEST_CONTEXT", "TSX_DISABLE_CACHE", "TSX_TSCONFIG_PATH", "TSX_DEBUG"];
  return { pid: process.pid, ppid: process.ppid, execPath: process.execPath,
    execArgv: process.execArgv.map((v, i, a) => a[i - 1] === "-e" ? "<measurement script>" : v),
    env: Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])) };
}
json("host.json", { node: process.version, nodeSha256: hash(readFileSync(process.execPath)),
  diagnosticSha256: hash(readFileSync(new URL(import.meta.url))), platform: process.platform, arch: process.arch,
  release: release(), cpus: cpus().map(({ model, speed }) => ({ model, speed })),
  context: loaderContext(), note: "Fresh JS processes, NOT flushed OS caches. No hosted claim on macOS." });
// env -i CI has no hidden preload/coverage/cache settings. Fail visibly if that changes.
for (const [key, value] of Object.entries(loaderContext().env)) assert.equal(value, null, key);

function manifest(directory) {
  const entries = [];
  function walk(relative) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else entries.push([name, entry.isSymbolicLink() ? `link:${readlinkSync(join(directory, name))}` : hash(readFileSync(join(directory, name)))]);
    }
  }
  walk("");
  return entries;
}

const scripts = {};
const launchers = {};
const identities = {};
for (const [label, cwd] of Object.entries(trees)) {
  assert.ok(!cwd.startsWith(process.env.HOME + "/"));
  const source = readFileSync(join(cwd, startupFile), "utf8");
  copyFileSync(join(cwd, startupFile), join(out, `${label}-original.test.ts.txt`));
  const matches = [...source.matchAll(/const script = `([\s\S]*?)`;/g)];
  assert.equal(matches.length, 1, "Extract exactly the existing child clock, not a rewritten benchmark");
  const entrypoint = JSON.parse(readFileSync(join(cwd, "package.json"))).pi.extensions[0];
  assert.equal(entrypoint, "./dist/extensions/agent-browser/index.js");
  scripts[label] = matches[0][1].replace('${JSON.stringify(entrypoint)}', JSON.stringify(entrypoint));
  assert.ok(!scripts[label].includes("${"));
  writeFileSync(join(out, `${label}-measurement.txt`), scripts[label]);
  // Ask the unchanged facade for its actual launcher, rather than substituting node --import tsx.
  const { verifySteps } = await import(pathToFileURL(join(cwd, "scripts/project.mjs")));
  const previous = process.cwd();
  process.chdir(cwd);
  const step = verifySteps({ mode: "default", passthrough: [] }).find((s) => s.args.includes("test/**/*.test.ts"));
  process.chdir(previous);
  assert.deepEqual(step.args, ["--test", "--test-concurrency=1", "test/**/*.test.ts"]);
  assert.equal(step.command, join(cwd, "node_modules/.bin/tsx"));
  launchers[label] = step.command;
  const deps = manifest(join(cwd, "node_modules"));
  const dist = manifest(join(cwd, "dist"));
  json(`${label}-dependencies.json`, deps);
  json(`${label}-dist.json`, dist);
  identities[label] = { commit: git(cwd, "rev-parse", "HEAD"),
    lock: hash(readFileSync(join(cwd, "package-lock.json"))),
    package: hash(readFileSync(join(cwd, "package.json"))),
    startup: hash(source), measurement: hash(scripts[label]),
    tsxVersion: JSON.parse(readFileSync(join(cwd, "node_modules/tsx/package.json"))).version,
    dependencies: hash(JSON.stringify(deps)), dist: hash(JSON.stringify(dist)), launcher: step };
  // Preserve the exact installed outer-launcher implementation for later inspection.
  for (const file of ["cli.mjs", "preflight.cjs", "loader.mjs"]) {
    copyFileSync(join(cwd, "node_modules/tsx/dist", file), join(out, `${label}-tsx-${file}.txt`));
  }
}
json("identities.json", identities);
for (const field of ["lock", "package", "startup", "measurement", "dependencies"]) {
  assert.equal(identities.B[field], identities.H[field], `baseline/head ${field} parity`);
}

let status = 0;
const results = [];
async function run(label, phase, round, file) {
  const prefix = `${phase}-${round}-${label}`;
  const stdout = openSync(join(out, `${prefix}.stdout.log`), "wx");
  const stderr = openSync(join(out, `${prefix}.stderr.log`), "wx");
  const args = ["--test", "--test-concurrency=1", file];
  const child = spawn(launchers[label], args, { cwd: trees[label], env: process.env,
    detached: true, stdio: ["ignore", stdout, stderr] });
  closeSync(stdout);
  closeSync(stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
  }, 60_000);
  const result = await new Promise((done) => {
    child.on("error", (error) => done({ error: error.message }));
    child.on("close", (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  const receipt = { phase, round, label, launcher: launchers[label], args, pid: child.pid, timedOut, ...result };
  results.push(receipt);
  appendFileSync(join(out, "results.jsonl"), JSON.stringify(receipt) + "\n");
  console.log(JSON.stringify(receipt));
  if (result.code !== 0 || timedOut) status = 1;
}

// First, unmodified original tests. Passing originals do not print raw triples;
// those are collected separately below, never passed off as the original test.
const order = ["B", "H", "H", "B"];
for (const [round, label] of order.entries()) await run(label, "original", round, startupFile);

function runner(label, phase, round) {
  const directory = join(out, `${phase}-${round}-${label}`);
  mkdirSync(directory);
  const flags = phase === "cpu" ? ["--cpu-prof", "--cpu-prof-interval=100", `--cpu-prof-dir=${directory}`]
    : phase === "graph" ? ["--import", pathToFileURL(join(directory, "graph.mjs")).href] : [];
  if (phase === "graph") writeFileSync(join(directory, "graph.mjs"), `
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const rows = [];
registerHooks({
  resolve(specifier, context, next) {
    const start = performance.now(); const result = next(specifier, context);
    rows.push({ kind: 'resolve', specifier, parent: context.parentURL, url: result.url, ms: performance.now() - start });
    return result;
  },
  load(url, context, next) {
    const start = performance.now(); const result = next(url, context);
    rows.push({ kind: 'load', url, format: result.format, ms: performance.now() - start, bytes: result.source?.byteLength ?? result.source?.length ?? 0 });
    return result;
  }
});
process.on('exit', () => writeFileSync(${JSON.stringify(directory)} + '/' + process.pid + '.graph.json', JSON.stringify(rows)));
`);
  // Parity observation is its own phase AFTER all uninstrumented measurements.
  const script = scripts[label] + (phase === "parity" ? `\nconsole.error(JSON.stringify((${loaderContext.toString()})()));\n` : "");
  const file = join(directory, "runner.mjs");
  writeFileSync(file, `
import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
const execFile = promisify(callback);
test(${JSON.stringify(`DIAGNOSTIC ONLY ${phase} ${label} ${round}; not the original budget assertion`)}, async () => {
  ${phase === "parity" ? `console.log('outer-context', JSON.stringify((${loaderContext.toString()})()));` : ""}
  const samples = await Promise.all([0, 1, 2].map(async () => {
    const pending = execFile(process.execPath, ${JSON.stringify([...flags, "--input-type=module", "-e", script])}, { cwd: process.cwd(), timeout: 10000 });
    const result = await pending;
    const measurement = JSON.parse(result.stdout.trim());
    assert.ok(measurement.events > 0 && measurement.tools.includes('agent_browser'));
    assert.ok(Number.isFinite(measurement.totalMs) && Number.isFinite(measurement.importMs));
    return { pid: pending.child.pid, measurement, stderr: result.stderr };
  }));
  console.log(JSON.stringify({ phase: ${JSON.stringify(phase)}, label: ${JSON.stringify(label)}, round: ${round}, samples }));
});
`);
  return file;
}
for (const [round, label] of order.entries()) await run(label, "extracted", round, runner(label, "extracted", round));
// Separate fresh triples for environment observation, CPU sampling and import graph.
// None of these instrumented clocks is a budget number. No repeat-until-green.
for (const phase of ["parity", "cpu", "graph"]) {
  for (const [round, label] of ["B", "H"].entries()) await run(label, phase, round, runner(label, phase, round));
}
json("summary.json", { status, order, results,
  limitations: "Focused tsx test, not a second full suite. Extracted triples are diagnostics, not original assertions. CPU includes bootstrap; graph hooks add overhead. No OS cache flush." });
console.log(`Startup diagnostic exit: ${status} (original failures retained; cannot clear either earlier gate)`);
process.exitCode = status;
