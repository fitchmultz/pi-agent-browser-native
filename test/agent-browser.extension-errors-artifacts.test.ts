/**
 * Purpose: Verify extension entrypoint validation-error and diagnostic contracts.
 * Responsibilities: Assert malformed args/envelopes, timeout progress, managed-session, selector visibility, overlay, prompt guards, and tab-drift diagnostics.
 * Scope: Integration-style Node test-runner coverage split out of the broad extension-validation suite.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-errors-artifacts.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { compileAgentBrowserJob } from "../extensions/agent-browser/lib/input-modes/job.js";
import { getAgentBrowserSocketDir } from "../extensions/agent-browser/lib/process.js";

function initializeGitProject(cwd: string): void {
	execFileSync("git", ["init", "-q", cwd], { stdio: "ignore" });
}
import { createManagedSessionRestoreKey, getManagedSessionRestoreScope } from "../extensions/agent-browser/lib/managed-session-restore.js";
import {
	collectTimeoutPartialProgress,
	formatTimeoutPartialProgressText,
} from "../extensions/agent-browser/lib/orchestration/browser-run/diagnostics.js";
import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension rejects dangling value-taking flags before spawning agent-browser", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { args } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /requires a value immediately after it/i);
			assert.equal(
				(result.details?.invalidValueFlag as { flag?: string; reason?: string } | undefined)?.flag,
				"--session",
			);
			assert.equal(
				(result.details?.invalidValueFlag as { flag?: string; reason?: string } | undefined)?.reason,
				"missing-value",
			);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "validation-error");
			assert.deepEqual(await readInvocationLog(logPath), []);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension passes through managed state capabilities and list rows", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-managed-state-access-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	const restoreKey = `piab-r2-${"a".repeat(32)}`;
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { files: [{ filename: ${JSON.stringify(`${restoreKey}-managed.json`)}, path: ${JSON.stringify(`/tmp/${restoreKey}-managed.json`)} }] } }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const listed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--json", "state", "list"] });
			assert.equal(listed.isError, false, JSON.stringify(listed));
			assert.match(JSON.stringify(listed), new RegExp(restoreKey));
			for (const args of [
				["state", "show", `/other/checkout/${restoreKey}-managed.json`],
				["state", "clear", "--all"],
				["--restore", restoreKey, "open", "https://example.com"],
			]) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
				assert.equal(result.isError, false, JSON.stringify(result));
			}
			assert.ok((await readInvocationLog(logPath)).length >= 4);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension passes through file access, local navigation, and protected-looking paths", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-file-access-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	const localUrl = pathToFileURL(join(tempDir, ".agent-browser", "sessions", "auth.html")).href;
	const artifactPath = join(tempDir, ".agent-browser", "capture.png");
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, allowFileAccess: process.env.AGENT_BROWSER_ALLOW_FILE_ACCESS ?? null, rawArgs: process.env.AGENT_BROWSER_ARGS ?? null, config: process.env.AGENT_BROWSER_CONFIG ?? null }) + "\\n");
if (args.includes("screenshot")) {
  const path = args[args.indexOf("screenshot") + 1];
  fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
  fs.writeFileSync(path, "image");
  process.stdout.write(JSON.stringify({ success: true, data: { path } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Local", url: args.find((arg) => arg.startsWith("file:")) } }));
}`);
	try {
		await withPatchedEnv({
			AGENT_BROWSER_ALLOW_FILE_ACCESS: "true",
			AGENT_BROWSER_ARGS: "--disable-web-security",
			AGENT_BROWSER_CONFIG: "/tmp/agent-browser.json",
			PATH: `${tempDir}:${basePath}`,
		}, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			for (const args of [
				["--allow-file-access", "true", "open", localUrl],
				["screenshot", artifactPath],
				["--config", "/tmp/explicit-agent-browser.json", "open", "https://example.com"],
			]) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
				assert.equal(result.isError, false, JSON.stringify(result));
			}
			const invocations = await readInvocationLog(logPath) as Array<{ allowFileAccess?: string; args: string[]; config?: string; rawArgs?: string }>;
			assert.equal(invocations.length, 3);
			assert.equal(invocations[0]?.allowFileAccess, "true");
			assert.equal(invocations[0]?.rawArgs, "--disable-web-security");
			assert.equal(invocations[0]?.config, "/tmp/agent-browser.json");
			assert.ok(invocations.some((entry) => entry.args.includes(artifactPath)));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension live-verifies caller-owned explicit sessions before content reads", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-live-url-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args[args.indexOf("--session") + 1];
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
if (args.includes("url")) {
  if (sessionName === "caller-failed") { process.stdout.write(JSON.stringify({ success: false, error: "No active page" })); process.exit(1); }
  const url = sessionName === "caller-local" ? "file:///tmp/.agent-browser/sessions/auth.html" : "https://safe.example/";
  process.stdout.write(JSON.stringify({ success: true, data: { url } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { html: sessionName === "caller-local" ? "LOCAL CONTENT" : "SAFE CONTENT" } }));
}`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			for (const [sessionName, content] of [["caller-local", "LOCAL CONTENT"], ["caller-safe", "SAFE CONTENT"]]) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", sessionName, "get", "html", "body"] });
				assert.equal(result.isError, false, JSON.stringify(result));
				assert.match(result.content[0]?.text ?? "", new RegExp(content));
			}
			const failed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "caller-failed", "get", "html", "body"] });
			assert.equal(failed.isError, true, JSON.stringify(failed));
			assert.match(failed.content[0]?.text ?? "", /active page became unverified/);
			const invocations = await readInvocationLog(logPath);
			for (const sessionName of ["caller-local", "caller-safe"]) {
				const calls = invocations.filter((entry) => entry.args.includes(sessionName));
				assert.deepEqual(calls.map((entry) => entry.args.includes("url") ? "url" : "html"), ["url", "html"]);
			}
			assert.equal(invocations.filter((entry) => entry.args.includes("caller-failed")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension serializes caller-owned live verification with same-session commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-live-race-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "active-page.txt");
	const liveProbePath = join(tempDir, "live-probe-started");
	const releaseLiveProbePath = join(tempDir, "release-live-probe");
	const basePath = process.env.PATH ?? "";
	await writeFile(statePath, "safe", "utf8");
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const readState = () => fs.readFileSync(${JSON.stringify(statePath)}, "utf8");
if (args.includes("get") && args.includes("url")) {
  const observedState = readState();
  fs.writeFileSync(${JSON.stringify(liveProbePath)}, "started");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(${JSON.stringify(releaseLiveProbePath)}) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const url = observedState === "safe" ? "https://safe.example/" : "file:///tmp/.agent-browser/sessions/auth.html";
  process.stdout.write(JSON.stringify({ success: true, data: { url } }));
} else if (args.includes("tab") && args.includes("t2")) {
  fs.writeFileSync(${JSON.stringify(statePath)}, "protected");
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t2" } }));
} else if (args.includes("get") && args.includes("html")) {
  const html = readState() === "safe" ? "SAFE CONTENT" : "SECRET_RACE_FROM_PROTECTED_FILE";
  process.stdout.write(JSON.stringify({ success: true, data: { html } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`);
	try {
		await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "Review Space", PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const contentPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "caller-race", "get", "html", "body"],
			});
			// Spawn-visibility wait matching the sibling contention test's budget; the queue contract is
			// asserted below, not by this latency window.
			for (let attempt = 0; attempt < 100; attempt += 1) {
				try {
					await access(liveProbePath);
					break;
				} catch {
					if (attempt === 99) assert.fail("live probe did not reach the fake upstream process");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
			const tabPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--namespace", "review-space", "--session", "caller-race", "tab", "t2"],
			});
			const otherSessionPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "caller-other", "open", "https://other.example"],
			});
			let beforeRelease = await readInvocationLog(logPath);
			// Spawn-visibility wait matching the sibling contention test's budget; the queue contract is
			// asserted below, not by this latency window.
			for (let attempt = 0; attempt < 100 && !beforeRelease.some((entry) => entry.args.includes("caller-other")); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				beforeRelease = await readInvocationLog(logPath);
			}
			assert.equal(beforeRelease.some((entry) => entry.args.includes("caller-other")), true);
			assert.equal(beforeRelease.some((entry) => entry.args.includes("caller-race") && entry.args.includes("tab")), false);
			await writeFile(releaseLiveProbePath, "release", "utf8");
			const [contentResult, tabResult, otherSessionResult] = await Promise.all([contentPromise, tabPromise, otherSessionPromise]);
			assert.equal(contentResult.isError, false, JSON.stringify(contentResult));
			assert.match(contentResult.content[0]?.text ?? "", /SAFE CONTENT/);
			assert.doesNotMatch(JSON.stringify(contentResult), /SECRET_RACE_FROM_PROTECTED_FILE/);
			assert.equal(tabResult.isError, false, JSON.stringify(tabResult));
			assert.equal(otherSessionResult.isError, false, JSON.stringify(otherSessionResult));
			const invocations = await readInvocationLog(logPath);
			const callerRaceInvocations = invocations.filter((entry) => entry.args.includes("caller-race"));
			assert.deepEqual(callerRaceInvocations.map((entry) => entry.args.slice(-2)), [
				["get", "url"],
				["html", "body"],
				["tab", "t2"],
			]);
			const otherOpenIndex = invocations.findIndex((entry) => entry.args.includes("caller-other") && entry.args.includes("open"));
			const raceContentIndex = invocations.findIndex((entry) => entry.args.includes("caller-race") && entry.args.includes("html"));
			assert.equal(otherOpenIndex > 0 && otherOpenIndex < raceContentIndex, true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps failed navigation targets unverified", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-failed-navigation-state-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	const localUrl = pathToFileURL(join(tempDir, "local.html")).href;
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("pushstate")) {
  process.stdout.write(JSON.stringify({ success: false, error: "SecurityError: cross-origin pushState" }));
  process.exitCode = 1;
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: ${JSON.stringify(localUrl)}, snapshot: "SECRET LOCAL CONTENT" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Local", url: ${JSON.stringify(localUrl)} } }));
}`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", localUrl] });
			assert.equal(opened.isError, false, JSON.stringify(opened));
			const failedNavigation = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pushstate", "https://safe.example/"] });
			assert.equal(failedNavigation.isError, true, JSON.stringify(failedNavigation));
			assert.equal(failedNavigation.details?.sessionTabTarget, undefined);
			assert.equal(failedNavigation.details?.sessionTabTargetUnknown, true);
			const invocationCount = (await readInvocationLog(logPath)).length;
			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, true, JSON.stringify(snapshot));
			assert.match(snapshot.content[0]?.text ?? "", /active page became unverified/);
			assert.doesNotMatch(JSON.stringify(snapshot), /SECRET LOCAL CONTENT/);
			assert.equal((await readInvocationLog(logPath)).length, invocationCount);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});


test("agentBrowserExtension reports local-page navigation and continues normally", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-local-navigation-helper-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "page-state.txt");
	const basePath = process.env.PATH ?? "";
	const protectedUrl = pathToFileURL(join(tempDir, ".agent-browser", "sessions", "auth.html")).href;
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("back")) {
  fs.writeFileSync(${JSON.stringify(statePath)}, "local");
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
} else if (args.includes("eval")) {
  fs.writeFileSync(${JSON.stringify(statePath)}, "local");
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true, url: "https://spoofed.example/" } }));
} else if (args.includes("open")) {
  try { fs.unlinkSync(${JSON.stringify(statePath)}); } catch {}
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Safe", url: "https://safe.example/" } }));
} else if (args.includes("get") && args.includes("url")) {
  const local = fs.existsSync(${JSON.stringify(statePath)});
  const url = local ? ${JSON.stringify(protectedUrl)} : "https://safe.example/";
  process.stdout.write(JSON.stringify({ success: true, data: { result: url, url } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "SECRET COOKIE TITLE", title: "SECRET COOKIE TITLE" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Safe", url: "https://safe.example/" } }));
}`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			for (const transitionArgs of [["back"], ["eval", "location.href='file:///tmp/.agent-browser/auth.html'"]]) {
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://safe.example/"] });
				assert.equal(opened.isError, false, JSON.stringify(opened));
				const beforeTransition = (await readInvocationLog(logPath)).length;
				const transitioned = await executeRegisteredTool(harness.tool, harness.ctx, { args: transitionArgs });
				assert.equal(transitioned.isError, false, JSON.stringify(transitioned));
				assert.match(JSON.stringify(transitioned), /SECRET COOKIE TITLE/);
				const invocations = await readInvocationLog(logPath);
				const transitionIndex = invocations.findIndex((entry, index) => index >= beforeTransition && entry.args.includes(transitionArgs[0]));
				assert.ok(transitionIndex >= beforeTransition);
				assert.equal(invocations.slice(transitionIndex + 1).some((entry) => entry.args.includes("get") && entry.args.includes("url")), true);
				assert.equal(invocations.slice(transitionIndex + 1).some((entry) => entry.args.includes("get") && entry.args.includes("title")), true);

				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
				assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			}
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension exposes and targets wrapper-prefixed live sessions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-managed-session-access-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://private.example" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { sessions: [
    { name: "piab-foreign-live", active: true, url: "https://private.example" },
    { name: "caller-owned", active: false, url: "https://example.com" }
  ] } }));
}`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const listed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--json", "session", "list"] });
			assert.equal(listed.isError, false, JSON.stringify(listed));
			assert.match(JSON.stringify(listed), /caller-owned/);
			assert.match(JSON.stringify(listed), /piab-foreign-live|private\.example/);

			for (const sessionName of ["piab-foreign-live", "PIAB-foreign-live"]) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", sessionName, "get", "url"] });
				assert.equal(result.isError, false, JSON.stringify(result));
			}
			assert.equal((await readInvocationLog(logPath)).length, 3);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects incompatible launch reuse of an active restore-enabled managed daemon", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-reuse-"));
	initializeGitProject(tempDir);
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(join(tempDir, "daemon-state.json"))};
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, ownedMarker: process.env.PI_AGENT_BROWSER_OWNED_MANAGED_SESSION, restore: process.env.AGENT_BROWSER_RESTORE, stateExpireDays: process.env.AGENT_BROWSER_STATE_EXPIRE_DAYS, userAgent: process.env.AGENT_BROWSER_USER_AGENT }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else {
  if (args.includes("open")) {
    state = { active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null };
    fs.writeFileSync(statePath, JSON.stringify(state));
  } else if (args.includes("close")) {
    state.active = false;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com" } }));
}`,
	);

	try {
		await withPatchedEnv({ AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64), HOME: tempDir, PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--namespace", "Team", "open", "https://dash.cloudflare.com"],
			});
			assert.equal(opened.isError, false, JSON.stringify(opened));
			assert.equal(opened.details?.namespace, "team");
			const sessionName = String(opened.details?.sessionName ?? "");
			assert.match(sessionName, /^piab-/);
			const openInvocations = await readInvocationLog(logPath);
			assert.equal((openInvocations[0] as { ownedMarker?: string }).ownedMarker, undefined);
			assert.equal((openInvocations[0] as { stateExpireDays?: string }).stateExpireDays, undefined);

			assert.equal((opened.details?.compatibilityWorkaround as { id?: string } | undefined)?.id, "cloudflare-headless-user-agent");
			const afterCloudflareOpen = await readInvocationLog(logPath);
			assert.equal(afterCloudflareOpen.filter((entry) => entry.args.includes("session") && entry.args.includes("info")).length, 1);
			const cloudflareInvocation = afterCloudflareOpen.find((entry) => entry.args.includes("https://dash.cloudflare.com"));
			assert.ok(cloudflareInvocation?.args.includes("--user-agent"));
			const cloudflareBrowserArgs = cloudflareInvocation?.args[cloudflareInvocation.args.indexOf("--args") + 1] ?? "";
			assert.match(cloudflareBrowserArgs, /^--user-agent=.*Chrome\/\d+\.0\.0\.0/);
			assert.doesNotMatch(cloudflareBrowserArgs, /[,\r\n]/);
			assert.match(String((cloudflareInvocation as { userAgent?: string } | undefined)?.userAgent), /Chrome\/\d+\.0\.0\.0/);
			assert.equal((cloudflareInvocation as { restore?: string } | undefined)?.restore, createManagedSessionRestoreKey(tempDir, getManagedSessionRestoreScope(sessionName)));

			const cloudflareFollowup = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(cloudflareFollowup.isError, false, JSON.stringify(cloudflareFollowup));
			assert.equal((cloudflareFollowup.details?.compatibilityWorkaround as { id?: string } | undefined)?.id, "cloudflare-headless-user-agent");
			const afterCloudflareFollowup = await readInvocationLog(logPath);
			const followupInvocation = afterCloudflareFollowup.filter((entry) => entry.args.includes("snapshot")).at(-1);
			assert.equal(followupInvocation?.args.includes("--user-agent"), false);
			assert.equal(followupInvocation?.args.includes("--args"), false);
			assert.equal((followupInvocation as { userAgent?: string } | undefined)?.userAgent, undefined);

			await writeFile(join(tempDir, "daemon-state.json"), JSON.stringify({ active: false, restoreKey: null }));
			const relaunched = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"] });
			assert.equal(relaunched.isError, false, JSON.stringify(relaunched));
			const relaunchInvocation = (await readInvocationLog(logPath)).filter((entry) => entry.args.includes("get") && entry.args.includes("title")).at(-1);
			assert.ok(relaunchInvocation?.args.includes("--user-agent"));
			assert.match(String((relaunchInvocation as { userAgent?: string } | undefined)?.userAgent), /Chrome\/\d+\.0\.0\.0/);
			await writeFile(join(tempDir, "daemon-state.json"), JSON.stringify({
				active: true,
				restoreKey: createManagedSessionRestoreKey(tempDir, getManagedSessionRestoreScope(sessionName)),
			}));
			const userInvocationCount = async () => (await readInvocationLog(logPath))
				.filter((entry) => !(entry.args.includes("session") && entry.args.includes("info"))).length;
			const invocationCount = await userInvocationCount();

			const abortController = new AbortController();
			abortController.abort();
			const aborted = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--proxy", "http://127.0.0.1:8080", "open", "https://example.com"],
			}, abortController.signal);
			assert.equal(aborted.isError, true);
			assert.equal(aborted.details?.validationError, undefined);
			assert.equal(await userInvocationCount(), invocationCount);

			for (const params of [
				{
					args: ["batch"],
					stdin: JSON.stringify([["connect", "wss://remote.example/devtools/browser/test"], ["snapshot", "-i"]]),
				},
				{ args: ["batch", "connect wss://remote.example/devtools/browser/test"] },
			]) {
				const blockedBatch = await executeRegisteredTool(harness.tool, harness.ctx, params);
				assert.equal(blockedBatch.isError, true);
				assert.match(String(blockedBatch.details?.validationError ?? ""), /does not match the requested managed-restore policy|active page became unverified/);
				assert.equal(await userInvocationCount(), invocationCount);
			}

			const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--namespace", "team", "--session", sessionName, "--cdp", "http://127.0.0.1:9222", "open", "https://example.com"],
			});
			assert.equal(blocked.isError, true);
			assert.equal(blocked.details?.failureCategory, "validation-error");
			assert.match(String(blocked.details?.validationError ?? ""), /launch-scoped flags/);
			assert.equal(await userInvocationCount(), invocationCount);
			assert.equal(blocked.details?.managedSessionRestoreDisabled, undefined);

			const sessionsDir = join(tempDir, ".agent-browser", "sessions");
			const restoreKey = createManagedSessionRestoreKey(tempDir, getManagedSessionRestoreScope(sessionName));
			await mkdir(sessionsDir, { recursive: true });
			for (const [index, suffix] of ["old", "middle", "new"].entries()) {
				const path = join(sessionsDir, `${restoreKey}-${suffix}.json`);
				await writeFile(path, "{}");
				await utimes(path, index + 1, index + 1);
			}
			const callerState = join(sessionsDir, "caller-owned.json");
			await writeFile(callerState, "{}");
			await writeFile(join(tempDir, "daemon-state.json"), JSON.stringify({ active: true, restoreKey }));

			const orphanHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(orphanHarness.handlers, "session_start", { reason: "new" }, orphanHarness.ctx);
			const orphanedDaemonReuse = await executeRegisteredTool(orphanHarness.tool, orphanHarness.ctx, {
				args: ["--namespace", "TEAM", "--proxy", "http://127.0.0.1:8080", "open", "https://example.com"],
			});
			assert.equal(orphanedDaemonReuse.isError, true);
			assert.match(String(orphanedDaemonReuse.details?.validationError ?? ""), /does not match the requested managed-restore policy/);
			assert.equal(await userInvocationCount(), invocationCount);

			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
			await access(join(sessionsDir, `${restoreKey}-old.json`));
			await access(join(sessionsDir, `${restoreKey}-middle.json`));
			await access(join(sessionsDir, `${restoreKey}-new.json`));
			await access(callerState);
		});
	} finally {
			await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension revalidates daemon policy after cross-instance lock contention", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-policy-race-"));
	initializeGitProject(tempDir);
	const statePath = join(tempDir, "daemon-state.json");
	const startedPath = join(tempDir, "compatible-started");
	const allowPath = join(tempDir, "allow-compatible");
	const mainLogPath = join(tempDir, "main.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else if (args.includes("--profile")) {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, "incompatible-main\\n");
  process.stdout.write(JSON.stringify({ success: true, data: { title: "unsafe", url: "https://example.com/unsafe" } }));
} else if (args.includes("open")) {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, "compatible-main\\n");
  fs.writeFileSync(${JSON.stringify(startedPath)}, "started");
  while (!fs.existsSync(${JSON.stringify(allowPath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null }));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "safe", url: "https://example.com/safe" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "safe", url: "https://example.com/safe" } }));
}`);
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const first = createExtensionHarness({ cwd: tempDir });
			const second = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(first.handlers, "session_start", { reason: "new" }, first.ctx);
			await runExtensionEvent(second.handlers, "session_start", { reason: "new" }, second.ctx);
			const compatible = executeRegisteredTool(first.tool, first.ctx, { args: ["open", "https://example.com/safe"] });
			for (let attempt = 0; attempt < 100; attempt += 1) {
				try { await access(startedPath); break; } catch {
					if (attempt === 99) assert.fail("compatible call did not reach the fake upstream process");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
			const incompatible = executeRegisteredTool(second.tool, second.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/unsafe"],
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			await writeFile(allowPath, "allow");
			const compatibleResult = await compatible;
			assert.equal(compatibleResult.isError, false, JSON.stringify(compatibleResult));
			const daemonState = JSON.parse(await readFile(statePath, "utf8")) as { restoreKey?: string | null };
			assert.match(daemonState.restoreKey ?? "", /^piab-r2-/);
			const blocked = await incompatible;
			assert.equal(blocked.isError, true, JSON.stringify(blocked));
			assert.match(String(blocked.details?.validationError ?? ""), /does not match the requested managed-restore policy/);
			assert.equal(await readFile(mainLogPath, "utf8"), "compatible-main\n");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension re-inspects a locally known daemon after an external restart", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-restart-"));
	initializeGitProject(tempDir);
	const statePath = join(tempDir, "daemon-state.json");
	const mainLogPath = join(tempDir, "main.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, String(process.env.AGENT_BROWSER_RESTORE ?? "disabled") + "\\n");
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null }));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "safe", url: "https://example.com/safe" } }));
}`);
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const initial = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.com/safe"] });
			assert.equal(initial.isError, false, JSON.stringify(initial));
			await writeFile(statePath, JSON.stringify({ active: true, restoreKey: null }));

			const restarted = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(restarted.isError, true, JSON.stringify(restarted));
			assert.match(String(restarted.details?.validationError ?? ""), /does not match the requested managed-restore policy/);
			assert.equal((await readFile(mainLogPath, "utf8")).trim().split("\n").length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension serializes caller-owned artifact writes and preserves their aggregate manifest", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-artifact-concurrent-"));
	const startedPath = join(tempDir, "slow-started");
	const slowPath = join(tempDir, "slow.png");
	const fastPath = join(tempDir, "fast.png");
	const finalPath = join(tempDir, "final.png");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const session = sessionIndex >= 0 ? args[sessionIndex + 1] : "default";
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.com/", url: "https://example.com/" } }));
} else if (args.includes("screenshot")) {
  if (session === "slow") {
    fs.writeFileSync(${JSON.stringify(startedPath)}, "started");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  const outputPath = args.at(-1);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from("89504e470d0a1a0a", "hex"));
  process.stdout.write(JSON.stringify({ success: true, data: { path: outputPath } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com/" } }));
}`);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "2" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const slowScreenshot = executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "slow", "screenshot", slowPath] });
			for (let attempt = 0; attempt < 3_000; attempt += 1) {
				try { await access(startedPath); break; } catch {
					if (attempt === 2_999) assert.fail("slow caller-owned screenshot did not start");
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			}
			const fastScreenshot = executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "fast", "screenshot", fastPath] });
			const concurrentResults = await Promise.all([slowScreenshot, fastScreenshot]);
			assert.equal(concurrentResults.every((result) => result.isError === false), true, JSON.stringify(concurrentResults));
			const aggregateEntries = (concurrentResults[1]?.details?.artifactManifest as { entries?: Array<{ absolutePath?: string; path: string }> } | undefined)?.entries ?? [];
			assert.deepEqual(new Set(aggregateEntries.map((entry) => entry.absolutePath ?? entry.path)), new Set([slowPath, fastPath]));

			harness.setBranch([concurrentResults[0], concurrentResults[1]].map((result) => ({
				type: "message",
				message: { details: result?.details, isError: result?.isError, toolName: "agent_browser" },
			})));
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "artifact-branch", oldLeafId: null }, harness.ctx);
			const restored = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "restored", "get", "title"] });
			const restoredEntries = (restored.details?.artifactManifest as { entries?: Array<{ absolutePath?: string; path: string }> } | undefined)?.entries ?? [];
			assert.deepEqual(new Set(restoredEntries.map((entry) => entry.absolutePath ?? entry.path)), new Set([slowPath, fastPath]));

			const finalScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "final", "screenshot", finalPath] });
			assert.equal(finalScreenshot.isError, false, JSON.stringify(finalScreenshot));
			const entries = (finalScreenshot.details?.artifactManifest as { entries?: Array<{ absolutePath?: string; path: string }> } | undefined)?.entries ?? [];
			const retainedPaths = new Set(entries.map((entry) => entry.absolutePath ?? entry.path));
			assert.equal(retainedPaths.size, 2);
			assert.equal(retainedPaths.has(finalPath), true);
			assert.equal(retainedPaths.has(slowPath) || retainedPaths.has(fastPath), true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects an externally replaced restore-disabled daemon", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-disabled-restore-restart-"));
	initializeGitProject(tempDir);
	const statePath = join(tempDir, "daemon-state.json");
	const mainLogPath = join(tempDir, "main.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, String(process.env.AGENT_BROWSER_RESTORE ?? "disabled") + "\\n");
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null }));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "safe", url: "https://example.com/safe" } }));
}`);
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const initial = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--proxy", "http://127.0.0.1:8080", "open", "https://example.com/safe"] });
			assert.equal(initial.isError, false, JSON.stringify(initial));
			assert.equal(initial.details?.managedSessionRestoreDisabled, true);
			await writeFile(statePath, JSON.stringify({ active: true, restoreKey: `piab-r2-${"c".repeat(32)}` }));

			const restarted = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(restarted.isError, true, JSON.stringify(restarted));
			assert.match(String(restarted.details?.validationError ?? ""), /does not match the requested managed-restore policy/);
			const retried = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(retried.isError, true, JSON.stringify(retried));
			assert.match(String(retried.details?.validationError ?? ""), /does not match the requested managed-restore policy/);
			assert.equal((await readFile(mainLogPath, "utf8")).trim().split("\n").length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects an unproven restore-disabled daemon", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-unproven-disabled-daemon-"));
	initializeGitProject(tempDir);
	const statePath = join(tempDir, "daemon-state.json");
	const mainLogPath = join(tempDir, "main.log");
	const basePath = process.env.PATH ?? "";
	await writeFile(statePath, JSON.stringify({ active: true, restoreKey: null }));
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: { restoreKey: state.restoreKey } } }));
} else {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, "spawned\\n");
  process.stdout.write(JSON.stringify({ success: true, data: { title: "unsafe" } }));
}`);
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--proxy", "http://127.0.0.1:8080", "open", "https://example.com/unsafe"],
			});
			assert.equal(result.isError, true, JSON.stringify(result));
			assert.match(String(result.details?.validationError ?? ""), /does not match the requested managed-restore policy/);
			await assert.rejects(() => readFile(mainLogPath, "utf8"), /ENOENT/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks a prior checkout generation daemon after path reuse", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-path-reuse-"));
	initializeGitProject(tempDir);
	const statePath = join(tempDir, "daemon-state.json");
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, restore: process.env.AGENT_BROWSER_RESTORE }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else if (args.includes("close")) {
  const sessions = require("node:path").join(process.env.HOME, ".agent-browser", "sessions");
  const sessionIndex = args.indexOf("--session");
  const snapshotPath = require("node:path").join(sessions, state.restoreKey + "-" + args[sessionIndex + 1] + ".json");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(snapshotPath, "{}");
  state.active = false;
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true, statePath: snapshotPath } }));
} else {
  if (args.includes("open")) {
    state = { active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null };
    fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  }
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com" } }));
}`);
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const first = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(first.handlers, "session_start", { reason: "new" }, first.ctx);
			const opened = await executeRegisteredTool(first.tool, first.ctx, { args: ["open", "https://example.com"] });
			assert.equal(opened.isError, false, JSON.stringify(opened));
			const priorKey = (JSON.parse(await readFile(statePath, "utf8")) as { restoreKey: string }).restoreKey;
			const managedSessionName = String(opened.details?.sessionName);

			await rm(join(tempDir, ".git"), { force: true, recursive: true });
			const sameInstanceBlocked = await executeRegisteredTool(first.tool, first.ctx, { args: ["open", "https://example.com"] });
			assert.equal(sameInstanceBlocked.isError, true);
			assert.match(String(sameInstanceBlocked.details?.validationError ?? ""), /does not match the requested managed-restore policy/);

			const noIdentityHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(noIdentityHarness.handlers, "session_start", { reason: "new" }, noIdentityHarness.ctx);
			const noIdentityBlocked = await executeRegisteredTool(noIdentityHarness.tool, noIdentityHarness.ctx, { args: ["open", "https://example.com"] });
			assert.equal(noIdentityBlocked.isError, true);
			assert.match(String(noIdentityBlocked.details?.validationError ?? ""), /does not match the requested managed-restore policy/);

			initializeGitProject(tempDir);
			assert.notEqual(createManagedSessionRestoreKey(tempDir), priorKey);
			const sameInstanceReplacementBlocked = await executeRegisteredTool(first.tool, first.ctx, { args: ["open", "https://example.com"] });
			assert.equal(sameInstanceReplacementBlocked.isError, true, JSON.stringify(sameInstanceReplacementBlocked));
			assert.match(String(sameInstanceReplacementBlocked.details?.validationError ?? ""), /does not match the requested managed-restore policy/);

			const replacementHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(replacementHarness.handlers, "session_start", { reason: "new" }, replacementHarness.ctx);
			const replacementBlocked = await executeRegisteredTool(replacementHarness.tool, replacementHarness.ctx, { args: ["open", "https://example.com"] });
			assert.equal(replacementBlocked.isError, true);
			assert.match(String(replacementBlocked.details?.validationError ?? ""), /does not match the requested managed-restore policy/);
			assert.equal((await readInvocationLog(logPath)).filter((entry) => entry.args.includes("open")).length, 1);

			const attackerConfigPath = join(tempDir, "attacker-agent-browser.json");
			await writeFile(attackerConfigPath, JSON.stringify({ restore: "attacker-key" }));
			const closed = await executeRegisteredTool(first.tool, first.ctx, {
				args: ["--session", managedSessionName, "--config", attackerConfigPath, "--restore", "attacker-key", "close"],
			});
			assert.equal(closed.isError, false, JSON.stringify(closed));
			await runExtensionEvent(first.handlers, "session_shutdown", { reason: "quit" }, first.ctx);
			const closeInvocation = (await readInvocationLog(logPath)).find((entry) => entry.args.includes("close"));
			assert.ok(closeInvocation);
			assert.deepEqual(closeInvocation.args, ["--json", "--session", managedSessionName, "--config", attackerConfigPath, "--restore", "attacker-key", "close"]);
			assert.equal((closeInvocation as { restore?: string }).restore, undefined);
			const sessions = join(tempDir, ".agent-browser", "sessions");
			const ownershipDirectoryName = (await readdir(sessions)).find((name) => name === `.pi-agent-browser-owned-snapshots-v2-${priorKey}`);
			assert.ok(ownershipDirectoryName);
			const ownershipRecords = (await readdir(join(sessions, ownershipDirectoryName))).filter((name) => name.endsWith(".json"));
			assert.equal(ownershipRecords.length, 1);
			assert.match(await readFile(join(sessions, ownershipDirectoryName, ownershipRecords[0] as string), "utf8"), new RegExp(`${priorKey}-`));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks incompatible reuse when an explicit restore key remains active", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-restore-reuse-"));
	initializeGitProject(tempDir);
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "daemon-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else {
  if (args.includes("open")) {
    const restoreIndex = args.indexOf("--restore");
    state = { active: true, restoreKey: restoreIndex >= 0 ? args[restoreIndex + 1] : process.env.AGENT_BROWSER_RESTORE ?? null };
    fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  }
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com" } }));
}`);
	try {
		await withPatchedEnv({ AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64), HOME: tempDir, PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--restore", "caller-key", "open", "https://example.com"],
			});
			assert.equal(opened.isError, false, JSON.stringify(opened));
			assert.equal(opened.details?.managedSessionRestoreDisabled, true);
			const sessionName = String(opened.details?.sessionName ?? "");
			const mainOpenCount = (await readInvocationLog(logPath)).filter((entry) => entry.args.includes("open")).length;

			const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", sessionName, "--auto-connect", "open", "https://example.com"],
			});
			assert.equal(blocked.isError, true);
			assert.match(String(blocked.details?.validationError ?? ""), /launch-scoped flags/);
			assert.equal((await readInvocationLog(logPath)).filter((entry) => entry.args.includes("open")).length, mainOpenCount);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

for (const testCase of [
	{
		name: "documented restore opt-out",
		env: { PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0" },
	},
	{
		name: "proxy environment",
		env: { HTTPS_PROXY: "http://127.0.0.1:8080" },
	},
	{
		name: "caller restore environment",
		env: { AGENT_BROWSER_RESTORE: "caller-key" },
	},
] as const) {
	test(`agentBrowserExtension reuses restore-disabled managed sessions with ${testCase.name}`, { concurrency: false }, async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-disabled-reuse-"));
		initializeGitProject(tempDir);
		const logPath = join(tempDir, "invocations.log");
		const daemonStatePath = join(tempDir, "daemon-state.json");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(daemonStatePath)};
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, restore: process.env.AGENT_BROWSER_RESTORE }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else {
  const command = args.find((arg) => ["get", "open"].includes(arg));
  if (!state.active) {
    state = { active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null };
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  process.stdout.write(JSON.stringify({ success: true, data: command === "get" ? "https://example.com/" : { title: "Example", url: "https://example.com/" } }));
}`,
		);

		try {
			await withPatchedEnv({
				AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
				ALL_PROXY: undefined,
				HTTP_PROXY: undefined,
				HTTPS_PROXY: undefined,
				PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
				PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				all_proxy: undefined,
				http_proxy: undefined,
				https_proxy: undefined,
				...testCase.env,
				HOME: tempDir,
				PATH: `${tempDir}:${basePath}`,
			}, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.com/"] });
				assert.equal(opened.isError, false, JSON.stringify(opened));
				assert.equal(opened.details?.managedSessionRestoreDisabled, true);
				const sessionName = opened.details?.sessionName;
				const branch = [{ type: "message", message: { details: opened.details, isError: false, toolName: "agent_browser" } }];
				harness.setBranch(branch);
				await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "restore-disabled", oldLeafId: null }, harness.ctx);

				const followedUp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
				assert.equal(followedUp.isError, false, JSON.stringify(followedUp));
				assert.equal(followedUp.details?.sessionName, sessionName);
				assert.equal(followedUp.details?.managedSessionRestoreDisabled, true);
				const invocations = await readInvocationLog(logPath);
				assert.ok(invocations.length >= 2);
				assert.equal(
					(invocations.at(-1) as { restore?: string } | undefined)?.restore,
					"AGENT_BROWSER_RESTORE" in testCase.env ? testCase.env.AGENT_BROWSER_RESTORE : undefined,
				);

				if (testCase.name === "documented restore opt-out") {
					const resumed = createExtensionHarness({ cwd: tempDir });
					resumed.setBranch(branch);
					await runExtensionEvent(resumed.handlers, "session_start", { reason: "resume" }, resumed.ctx);
					const blockedAfterReload = await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["get", "url"] });
					assert.equal(blockedAfterReload.isError, true, JSON.stringify(blockedAfterReload));
					assert.match(String(blockedAfterReload.details?.validationError ?? ""), /does not match the requested managed-restore policy/);

					await writeFile(daemonStatePath, JSON.stringify({ active: false, restoreKey: null }));
					const restartedAfterIdle = await executeRegisteredTool(resumed.tool, resumed.ctx, { electron: { action: "probe" } });
					assert.equal(restartedAfterIdle.isError, false, JSON.stringify(restartedAfterIdle));
					const reusedAfterIdleRestart = await executeRegisteredTool(resumed.tool, resumed.ctx, { args: ["get", "url"] });
					assert.equal(reusedAfterIdleRestart.isError, false, JSON.stringify(reusedAfterIdleRestart));
					assert.equal(reusedAfterIdleRestart.details?.managedSessionRestoreDisabled, true);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	});
}

test("agentBrowserExtension does not sticky-disable restore when a suppressed spawn fails", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-spawn-failure-"));
	initializeGitProject(tempDir);
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	try {
		await withPatchedEnv({
			ALL_PROXY: undefined,
			HTTP_PROXY: undefined,
			HTTPS_PROXY: "http://127.0.0.1:8080",
			PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
			all_proxy: undefined,
			http_proxy: undefined,
			https_proxy: undefined,
			HOME: tempDir,
			PATH: "",
		}, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const failed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.com/"] });
			assert.equal(failed.isError, true);
			assert.notEqual(failed.details?.managedSessionRestoreDisabled, true);

			delete process.env.HTTPS_PROXY;
			process.env.PATH = `${tempDir}:${basePath}`;
			await writeFakeAgentBrowserBinary(
				tempDir,
				`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), restore: process.env.AGENT_BROWSER_RESTORE }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com/" } }));`,
			);

			const retried = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.com/"] });
			assert.equal(retried.isError, false, JSON.stringify(retried));
			assert.notEqual(retried.details?.managedSessionRestoreDisabled, true);
			const [invocation] = await readInvocationLog(logPath);
			assert.equal((invocation as { restore?: string } | undefined)?.restore, createManagedSessionRestoreKey(tempDir, getManagedSessionRestoreScope(retried.details?.sessionName as string)));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

const MISSING_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: missing boolean success field.";

test("agentBrowserExtension rejects malformed JSON envelopes that omit success", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ error: "boom" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.equal((result.content[0] as { text: string }).text, MISSING_SUCCESS_PARSE_ERROR);
			assert.equal(result.details?.parseError, MISSING_SUCCESS_PARSE_ERROR);
			assert.equal(result.details?.summary, MISSING_SUCCESS_PARSE_ERROR);
			assert.doesNotMatch(String(result.details?.summary ?? ""), /^open completed$/i);
			assert.equal(result.details?.error, undefined);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "parse-failure");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension forwards long waits and extends the subprocess watchdog from explicit wait timeouts", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-wait-timeout-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), stdin, defaultTimeout: process.env.AGENT_BROWSER_DEFAULT_TIMEOUT }) + "\\n");
let delay = 100;
try {
  const parsed = JSON.parse(stdin);
  const waitCount = Array.isArray(parsed) ? parsed.filter((step) => Array.isArray(step) && step[0] === "wait").length : 0;
  if (waitCount > 1) delay = 6500;
} catch {}
setTimeout(() => process.stdout.write(JSON.stringify({ success: true, data: { ok: true } })), delay);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "50" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const directWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "31000"],
			});
			const downloadWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "--download", "/tmp/export.csv", "--timeout", "30000"],
			});
			const batchWaitStdin = JSON.stringify([["wait", "--text", "42", "--timeout", "1000"], ["wait", "1000"]]);
			const batchWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: batchWaitStdin,
			});

			for (const result of [directWait, downloadWait, batchWait]) {
				assert.equal(result.isError, false);
				assert.equal(result.details?.resultCategory, "success");
			}
			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations.map((entry) => entry.args.slice(-4)), [
				["--session", invocations[0].args[2], "wait", "31000"],
				["--download", "/tmp/export.csv", "--timeout", "30000"],
				["--json", "--session", invocations[2].args[2], "batch"],
			]);
			assert.equal(invocations[2].stdin, batchWaitStdin);
			assert.deepEqual(invocations.map((entry) => entry.defaultTimeout), ["25000", "25000", "25000"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns when eval stdin returns an empty object from a function-shaped snippet", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-eval-stdin-hint-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const trimmed = stdin.trim();
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.com/", url: "https://example.com/" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Example Domain", title: "Example Domain" } }));
} else if (trimmed === "(() => [])()") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: [], origin: "https://example.com/" } }));
} else if (trimmed === "(() => [1])()") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: [1], origin: "https://example.com/" } }));
} else if (trimmed.startsWith("() =>")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: {}, origin: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Example Domain" }, origin: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const functionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "() => ({ title: document.title })",
			});
			assert.equal(functionResult.isError, false);
			assert.match((functionResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.match((functionResult.content[0] as { text: string }).text, /\(\{ title: document\.title \}\)/);
			assert.deepEqual(functionResult.details?.evalStdinHint, {
				reason: "eval --stdin received a function-shaped snippet and the upstream JSON result was an empty object, which often means the function itself was returned or serialized instead of invoked.",
				suggestion: "Pass a plain expression such as `({ title: document.title })`, or invoke the function explicitly, for example `(() => ({ title: document.title }))()`.",
			});

			const jsonFunctionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--json", "eval", "--stdin"],
				stdin: "() => ({ title: document.title })",
			});
			assert.equal(jsonFunctionResult.isError, false);
			const jsonFunctionText = (jsonFunctionResult.content[0] as { text: string }).text;
			assert.doesNotMatch(jsonFunctionText, /Eval stdin hint:/);
			assert.deepEqual(JSON.parse(jsonFunctionText), {
				data: { origin: "https://example.com/", result: {} },
				success: true,
			});
			assert.deepEqual(jsonFunctionResult.details?.evalStdinHint, functionResult.details?.evalStdinHint);

			const emptyArrayIifeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "(() => [])()",
			});
			assert.equal(emptyArrayIifeResult.isError, false);
			assert.doesNotMatch((emptyArrayIifeResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.equal(emptyArrayIifeResult.details?.evalStdinHint, undefined);

			const nonEmptyArrayIifeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "(() => [1])()",
			});
			assert.equal(nonEmptyArrayIifeResult.isError, false);
			assert.doesNotMatch((nonEmptyArrayIifeResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.equal(nonEmptyArrayIifeResult.details?.evalStdinHint, undefined);

			const expressionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "({ title: document.title })",
			});
			assert.equal(expressionResult.isError, false);
			assert.doesNotMatch((expressionResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.equal(expressionResult.details?.evalStdinHint, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension normalizes eval --stdin scripts misplaced in args", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-eval-stdin-args-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { result: stdin.trim() === "document.title" ? "Fixture Title" : null, origin: "https://fixture.invalid/" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin", "document.title"],
			});

			assert.equal(result.isError, false);
			assert.equal((result.content[0] as { text: string }).text.split("\n")[0], "Fixture Title");
			const [invocation] = await readInvocationLog(logPath);
			assert.deepEqual(invocation?.args.slice(-2), ["eval", "--stdin"]);
			assert.equal(invocation?.stdin, "document.title");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allows eval on local file pages", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-eval-file-null-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "fixture", url: args.at(-1) || "about:blank" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "file:///tmp/fixture.html" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: null } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const openResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "file:///tmp/fixture.html"] });
			assert.equal(openResult.isError, false);
			assert.equal((openResult.details?.sessionTabTarget as { url?: string } | undefined)?.url, "file:///tmp/fixture.html");

			const nullEvalResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "document.getElementById('missing')?.textContent",
			});
			assert.equal(nullEvalResult.isError, false, JSON.stringify(nullEvalResult));
			assert.equal((await readInvocationLog(logPath)).some((entry) => entry.args.includes("eval")), true);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension retains and closes a fresh daemon when its first non-batch command fails", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-failed-fresh-daemon-"));
	initializeGitProject(tempDir);
	const statePath = join(tempDir, "daemon-state.json");
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, restore: process.env.AGENT_BROWSER_RESTORE }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else if (args.includes("close")) {
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ active: false, restoreKey: null }));
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else if (args.includes("click")) {
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null }));
  process.stdout.write(JSON.stringify({ success: false, error: "selector not found" }));
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "ok", url: "about:blank" } }));
}`);
	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const failed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "#missing"], sessionMode: "fresh" });
			assert.equal(failed.isError, true);
			const outcome = failed.details?.managedSessionOutcome as { activeAfter?: boolean; currentSessionName?: string; status?: string; succeeded?: boolean } | undefined;
			assert.equal(outcome?.status, "created", JSON.stringify({ failed, invocations: await readInvocationLog(logPath) }));
			assert.equal(outcome?.activeAfter, true);
			assert.equal(outcome?.succeeded, false);
			assert.ok(outcome?.currentSessionName);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("close") && entry.args.includes(outcome?.currentSessionName as string)));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports managed-session outcomes after failed fresh launches", { concurrency: false }, async (context) => {
	const shortTempRoot = dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab"));
	const tempDir = await mkdtemp(join(shortTempRoot, "a-"));
	const socketDir = join(shortTempRoot, `p${(process.pid % 36).toString(36)}`);
	await rm(socketDir, { force: true, recursive: true });
	await mkdir(socketDir, { mode: 0o700 });
	context.after(async () => {
		await rm(socketDir, { force: true, recursive: true });
	});
	initializeGitProject(tempDir);
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: false, runtime: null } }));
  process.exit(0);
} else if (args.includes("https://fail.test")) {
  console.error("simulated launch failure");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ success: true, data: { title: "ok", url: args.at(-1) || "about:blank" } }));`,
	);

	try {
		const missingBinaryDir = await mkdtemp(join(tempDir, "missing-agent-browser-"));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_SOCKET_DIR: socketDir }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "previous", "open", "https://previous.test"] });
			assert.equal(firstResult.isError, false, JSON.stringify(firstResult));
			const previousSessionName = firstResult.details?.sessionName as string;
			assert.ok(previousSessionName);

			const failedFreshResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "next", "open", "https://fail.test"], sessionMode: "fresh" });
			assert.equal(failedFreshResult.isError, true);
			const preservedOutcome = failedFreshResult.details?.managedSessionOutcome as { activeAfter?: boolean; activeBefore?: boolean; attemptedSessionName?: string; currentSessionName?: string; currentSessionNamespace?: string; previousSessionName?: string; sessionMode?: string; status?: string; succeeded?: boolean; summary?: string } | undefined;
			assert.equal(preservedOutcome?.status, "preserved");
			assert.equal(preservedOutcome?.activeBefore, true);
			assert.equal(preservedOutcome?.activeAfter, true);
			assert.equal(preservedOutcome?.currentSessionName, previousSessionName);
			assert.equal(preservedOutcome?.currentSessionNamespace, "previous");
			assert.equal(preservedOutcome?.previousSessionName, previousSessionName);
			assert.equal(preservedOutcome?.sessionMode, "fresh");
			assert.match(preservedOutcome?.attemptedSessionName ?? "", /-fresh-/);
			assert.equal(preservedOutcome?.succeeded, false);
			assert.match((failedFreshResult.content[0] as { text: string }).text, /Managed session outcome: Fresh launch failed; your previous browser session is still active\./);
			assert.match((failedFreshResult.content[0] as { text: string }).text, /Recovery:/);
			assert.match((failedFreshResult.content[0] as { text: string }).text, /details\.managedSessionOutcome/);
			const preservedNextActions = failedFreshResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.ok(preservedNextActions?.some((action) => action.id === "run-agent-browser-doctor"));
			assert.ok(preservedNextActions?.some((action) => action.id === "verify-current-managed-session" && action.params?.args?.join(" ") === `--namespace previous --session ${previousSessionName} get url`));

			await withPatchedEnv({ PATH: missingBinaryDir }, async () => {
				const missingBinaryResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "next", "open", "https://missing-binary.test"], sessionMode: "fresh" });
				assert.equal(missingBinaryResult.isError, true);
				assert.equal(missingBinaryResult.details?.failureCategory, "missing-binary", JSON.stringify(missingBinaryResult));
			assert.equal(missingBinaryResult.details?.agentBrowserStarted, false);
				const missingBinaryOutcome = missingBinaryResult.details?.managedSessionOutcome as { activeAfter?: boolean; activeBefore?: boolean; currentSessionName?: string; currentSessionNamespace?: string; previousSessionName?: string; sessionMode?: string; status?: string } | undefined;
				assert.equal(missingBinaryOutcome?.status, "preserved");
				assert.equal(missingBinaryOutcome?.activeBefore, true);
				assert.equal(missingBinaryOutcome?.activeAfter, true);
				assert.equal(missingBinaryOutcome?.currentSessionName, previousSessionName);
				assert.equal(missingBinaryOutcome?.currentSessionNamespace, "previous");
				assert.equal(missingBinaryOutcome?.previousSessionName, previousSessionName);
				assert.equal(missingBinaryOutcome?.sessionMode, "fresh");
				assert.match((missingBinaryResult.content[0] as { text: string }).text, /Managed session outcome: Fresh launch failed; your previous browser session is still active\./);
				const missingBinaryNextActions = missingBinaryResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
				assert.ok(missingBinaryNextActions?.some((action) => action.id === "run-agent-browser-doctor"));
				assert.ok(missingBinaryNextActions?.some((action) => action.id === "verify-current-managed-session" && action.params?.args?.join(" ") === `--namespace previous --session ${previousSessionName} get url`));

				const abandonedMissingBinaryHarness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(abandonedMissingBinaryHarness.handlers, "session_start", { reason: "new" }, abandonedMissingBinaryHarness.ctx);
				const abandonedMissingBinary = await executeRegisteredTool(abandonedMissingBinaryHarness.tool, abandonedMissingBinaryHarness.ctx, { args: ["--namespace", "next", "open", "https://missing-binary.test"], sessionMode: "fresh" });
				assert.equal(abandonedMissingBinary.isError, true);
				assert.equal(abandonedMissingBinary.details?.managedSessionRestoreDisabled, undefined);
				const abandonedMissingBinaryNextActions = abandonedMissingBinary.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
				assert.ok(abandonedMissingBinaryNextActions?.some((action) => action.id === "retry-fresh-managed-session" && action.params?.args?.join(" ") === "--namespace next open about:blank"));
			});

			const followupResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(followupResult.isError, false);
			assert.equal(followupResult.details?.sessionName, previousSessionName);

			const abandonedHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(abandonedHarness.handlers, "session_start", { reason: "new" }, abandonedHarness.ctx);
			const abandonedResult = await executeRegisteredTool(abandonedHarness.tool, abandonedHarness.ctx, { args: ["open", "https://fail.test"], sessionMode: "fresh" });
			assert.equal(abandonedResult.isError, true);
			const abandonedOutcome = abandonedResult.details?.managedSessionOutcome as { activeAfter?: boolean; activeBefore?: boolean; status?: string; summary?: string } | undefined;
			assert.equal(abandonedOutcome?.status, "abandoned");
			assert.equal(abandonedOutcome?.activeBefore, false);
			assert.equal(abandonedOutcome?.activeAfter, false);
			assert.match((abandonedResult.content[0] as { text: string }).text, /no managed browser session is current/);
			const abandonedNextActions = abandonedResult.details?.nextActions as Array<{ id?: string }> | undefined;
			assert.ok(abandonedNextActions?.some((action) => action.id === "retry-fresh-managed-session"));

			const incompatibleFailure = await executeRegisteredTool(abandonedHarness.tool, abandonedHarness.ctx, {
				args: ["--profile", "Default", "open", "https://fail.test"],
				sessionMode: "fresh",
			});
			const incompatibleOutcome = incompatibleFailure.details?.managedSessionOutcome as { attemptedSessionName?: string } | undefined;
			assert.ok(incompatibleOutcome?.attemptedSessionName);
			assert.equal(incompatibleFailure.details?.managedSessionRestoreDisabled, undefined);
		});
	} finally {
			await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension writes eval and get output data to requested files", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-output-file-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const command = args.find((arg) => !arg.startsWith("-") && arg !== "piab-test");
if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Example", rows: [1, 2, 3] } } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.com/", url: "https://example.com/" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Example", title: "Example" } }));
} else if (args.includes("get")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "visible terminal text" } }));
} else if (args.includes("screenshot")) {
  const output = args[args.indexOf("screenshot") + 1];
  fs.mkdirSync(require("node:path").dirname(output), { recursive: true });
  fs.writeFileSync(output, "browser-image");
  process.stdout.write(JSON.stringify({ success: true, data: { path: output } }));
} else if (args.includes("#fail")) {
  process.stdout.write(JSON.stringify({ success: false, error: "button failed" }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { command } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const evalResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "({ title: document.title })",
				outputPath: "logs/eval-state.json",
			});
			assert.equal(evalResult.isError, false);
			assert.deepEqual(JSON.parse(await readFile(join(tempDir, "logs/eval-state.json"), "utf8")), { result: { title: "Example", rows: [1, 2, 3] } });
			assert.match(evalResult.content[0]?.text ?? "", /Output file: logs\/eval-state\.json/);
			assert.deepEqual((evalResult.details?.outputFile as { path?: string; source?: string; status?: string } | undefined), {
				path: "logs/eval-state.json",
				source: "details.data",
				status: "saved",
				absolutePath: join(tempDir, "logs/eval-state.json"),
				bytes: 92,
			});

			const getResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["get", "text", "@e1"],
				outputPath: "@logs/terminal-state.final.txt",
			});
			assert.equal(getResult.isError, false);
			assert.equal(await readFile(join(tempDir, "logs/terminal-state.final.txt"), "utf8"), JSON.stringify({ result: "visible terminal text" }, null, 2) + "\n");
			assert.match(getResult.content[0]?.text ?? "", /Output file: logs\/terminal-state\.final\.txt/);

			const jsonResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["stream", "status", "--json"],
				outputPath: "logs/stream-status.json",
			});
			assert.equal(jsonResult.isError, false);
			const jsonText = jsonResult.content[0]?.type === "text" ? jsonResult.content[0].text ?? "" : "";
			assert.doesNotMatch(jsonText, /Output file:/);
			assert.doesNotThrow(() => JSON.parse(jsonText));
			const savedJsonText = await readFile(join(tempDir, "logs/stream-status.json"), "utf8");
			assert.doesNotThrow(() => JSON.parse(savedJsonText));

			const screenshotPath = join(tempDir, "captures/same-path.png");
			const collidingOutput = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["screenshot", screenshotPath],
				outputPath: screenshotPath,
			});
			assert.equal(collidingOutput.isError, true);
			assert.equal(collidingOutput.details?.resultCategory, "failure");
			assert.equal(collidingOutput.details?.failureCategory, "validation-error");
			assert.equal(collidingOutput.details?.outputFile, undefined);
			assert.equal(collidingOutput.details?.artifacts, undefined);
			assert.match(collidingOutput.content[0]?.text ?? "", /outputPath.*same destination as artifact path/i);
			await assert.rejects(access(screenshotPath));

			if (process.platform !== "android") {
				const hardlinkedScreenshotPath = join(tempDir, "captures/hardlinked.png");
				const hardlinkedOutputPath = join(tempDir, "captures/hardlinked-result.json");
				await mkdir(join(tempDir, "captures"), { recursive: true });
				await writeFile(hardlinkedScreenshotPath, "seed");
				await link(hardlinkedScreenshotPath, hardlinkedOutputPath);
				const hardlinkedOutput = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["screenshot", hardlinkedScreenshotPath],
					outputPath: hardlinkedOutputPath,
				});
				assert.equal(hardlinkedOutput.isError, true);
				assert.match(hardlinkedOutput.content[0]?.text ?? "", /outputPath.*same destination as artifact path/i);
				assert.equal(await readFile(hardlinkedScreenshotPath, "utf8"), "seed");
			}

			const beforeProtectedOutput = (await readFile(logPath, "utf8")).trim().split("\n").length;
			const protectedOutput = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["get", "title"],
				outputPath: ".agent-browser/states/overwrite.json",
			});
			assert.equal(protectedOutput.isError, false, JSON.stringify(protectedOutput));
			assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length, beforeProtectedOutput + 1);
			assert.deepEqual(JSON.parse(await readFile(join(tempDir, ".agent-browser/states/overwrite.json"), "utf8")), { result: "Example", title: "Example" });

			await writeFile(join(tempDir, "blocked-output-parent"), "not a directory");
			const writeFailureResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "() => ({ ok: true })",
				outputPath: "blocked-output-parent/result.json",
			});
			assert.equal(writeFailureResult.isError, true);
			assert.equal(writeFailureResult.details?.resultCategory, "failure");
			assert.equal(writeFailureResult.details?.failureCategory, "upstream-error");
			assert.equal(writeFailureResult.details?.successCategory, undefined);
			assert.equal((writeFailureResult.details?.outputFile as { status?: string } | undefined)?.status, "failed");

			const failedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["click", "#fail"],
				outputPath: "logs/failed-action.txt",
			});
			assert.equal(failedResult.isError, true);
			assert.equal(failedResult.details?.outputFile, undefined);
			await assert.rejects(readFile(join(tempDir, "logs/failed-action.txt"), "utf8"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports partial progress and artifacts after job timeout", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-job-timeout-progress-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.test/secret-token/results?token=url-secret" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Results page export secret-token Authorization: Bearer title-secret" } }));
} else if (args.includes("batch")) {
  const stdin = fs.readFileSync(0, "utf8");
  const steps = JSON.parse(stdin);
  const screenshotStep = steps.find((step) => step[0] === "screenshot");
  const screenshot = screenshotStep?.filter((token) => !String(token).startsWith('-')).at(-1);
  if (screenshot && screenshot !== 'screenshot') {
    fs.mkdirSync(path.dirname(path.resolve(screenshot)), { recursive: true });
    fs.writeFileSync(path.resolve(screenshot), "fake image");
  }
  setInterval(() => {}, 1000);
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.test/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		// The timed-out fake upstream normally writes this before hanging, but pre-create it
		// so this diagnostic test is about wrapper timeout progress instead of Node process
		// startup timing under full-suite load.
		await mkdir(join(tempDir, "dogfood/secret-token"), { recursive: true });
		await writeFile(join(tempDir, "dogfood/secret-token/filled.png"), "fake image");
		await mkdir(join(tempDir, "dogfood"), { recursive: true });
		await writeFile(join(tempDir, "dogfood/option-full-page.png"), "fake image");
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "2000" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: {
					steps: [
						{ action: "open", url: "https://example.test" },
						{ action: "fill", selector: "#search", text: "export" },
						{ action: "screenshot", path: "dogfood/secret-token/filled.png" },
						{ action: "waitForDownload", path: "dogfood/export.csv" },
						{ action: "wait", milliseconds: 500 },
					],
				},
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "timeout");
			assert.equal(result.details?.timedOut, true);
			const timeoutProgress = result.details?.timeoutPartialProgress as { artifacts?: Array<{ exists?: boolean; path?: string; sizeBytes?: number; state?: string; stepIndex?: number }>; currentPage?: { source?: string; title?: string; url?: string }; openedButPostOpenTimedOut?: boolean; retryStep?: { args?: string[]; index?: number; status?: string }; steps?: Array<{ args?: string[]; index?: number; status?: string }> } | undefined;
			assert.ok(
				timeoutProgress?.currentPage?.url === "https://example.test/secret-token/results?token=%5BREDACTED%5D" ||
					timeoutProgress?.currentPage?.url === "https://example.test/",
				`unexpected timeout current page URL: ${timeoutProgress?.currentPage?.url}`,
			);
			if (timeoutProgress?.currentPage?.title) {
				assert.equal(timeoutProgress.currentPage.title, "Results page export secret-token Authorization: Bearer [REDACTED]");
			}
			assert.deepEqual(timeoutProgress?.artifacts?.map((artifact) => ({ exists: artifact.exists, path: artifact.path, state: artifact.state, stepIndex: artifact.stepIndex })), [
				{ exists: true, path: "dogfood/secret-token/filled.png", state: "verified", stepIndex: 3 },
				{ exists: false, path: "dogfood/export.csv", state: "missing", stepIndex: 4 },
			]);
			assert.deepEqual(timeoutProgress?.steps?.map((step) => [step.args?.[0], step.status]), [["open", "completed"], ["fill", "completed"], ["screenshot", "completed"], ["wait", "failed"], ["wait", "pending"]]);
			assert.equal(timeoutProgress?.openedButPostOpenTimedOut, true);
			assert.deepEqual(timeoutProgress?.retryStep?.args, ["wait", "--download", "dogfood/export.csv"]);
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /Timeout partial progress:/);
			if (timeoutProgress?.currentPage?.title) {
				assert.match(text, /Current page: \[REDACTED\] — https:\/\/example.test\/\[REDACTED\]\/results\?token=%5BREDACTED%5D/);
			} else {
				assert.match(text, /Current page: https:\/\/example.test\//);
			}
			assert.match(text, /Artifact from step 3: dogfood\/\[REDACTED\]\/filled\.png \(exists, 10 bytes\)/);
			assert.doesNotMatch(text, /url-secret|title-secret|secret-token/);
			assert.match(text, /Step 2 \[completed\]: fill #search export/);
			assert.match(text, /Step 4 \[failed\]: wait --download dogfood\/export\.csv/);
			assert.match(text, /Retry failed step: \{"args":\["wait","--download","dogfood\/export\.csv"\]\}/);
			assert.match(text, /Artifact from step 4: dogfood\/export\.csv \(missing\)/);
			assert.deepEqual((result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined)?.find((action) => action.id === "retry-timeout-step")?.params?.args?.slice(-3), ["wait", "--download", "dogfood/export.csv"]);

			const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["screenshot", "--full-page", "dogfood/option-full-page.png"], ["wait", "--download", "dogfood/download.csv", "--timeout", "1000"]]),
			});
			assert.equal(batchResult.isError, true);
			const batchProgress = batchResult.details?.timeoutPartialProgress as { artifacts?: Array<{ exists?: boolean; path?: string; stepIndex?: number }>; retryStep?: { args?: string[]; index?: number; status?: string }; steps?: Array<{ status?: string }> } | undefined;
			assert.deepEqual(batchProgress?.artifacts?.map((artifact) => ({ exists: artifact.exists, path: artifact.path, stepIndex: artifact.stepIndex })), [
				{ exists: true, path: "dogfood/option-full-page.png", stepIndex: 1 },
				{ exists: false, path: "dogfood/download.csv", stepIndex: 2 },
			]);

			const waitNoPathResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["wait", "--download", "--timeout", "1000"]]),
			});
			assert.equal(waitNoPathResult.isError, true);
			const waitNoPathProgress = waitNoPathResult.details?.timeoutPartialProgress as { artifacts?: Array<{ path?: string }> } | undefined;
			assert.deepEqual(waitNoPathProgress?.artifacts, []);

			const openBeforeMutatingTimeout = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.test"], timeoutMs: 10_000 });
			assert.equal(openBeforeMutatingTimeout.isError, false);
			const mutatingTimeoutResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "fill", selector: "#search", text: "export" }, { action: "wait", milliseconds: 500 }] },
			});
			assert.equal(mutatingTimeoutResult.isError, true);
			const mutatingProgress = mutatingTimeoutResult.details?.timeoutPartialProgress as { retryStep?: { args?: string[]; retry?: { args?: string[] }; status?: string } } | undefined;
			assert.deepEqual(mutatingProgress?.retryStep?.args, ["fill", "#search", "export"]);
			assert.equal(mutatingProgress?.retryStep?.retry, undefined);
			const mutatingNextActions = (mutatingTimeoutResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined) ?? [];
			assert.equal(mutatingNextActions.some((action) => action.id === "retry-timeout-step"), false);
			assert.deepEqual(mutatingNextActions.find((action) => action.id === "inspect-current-page-after-timeout")?.params?.args?.slice(-2), ["snapshot", "-i"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension retries fresh timed-out navigation in a new session when no live URL is recovered", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-fresh-timeout-retry-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("batch")) {
  setInterval(() => {}, 60_000);
} else {
  process.stdout.write(JSON.stringify({ success: false, error: "no live page" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "200" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/fresh-timeout" }, { action: "wait", milliseconds: 100 }] },
				sessionMode: "fresh",
			});

			assert.equal(result.isError, true);
			const progress = result.details?.timeoutPartialProgress as { currentPage?: { source?: string; url?: string }; liveUrlRecovered?: boolean; retryStep?: { args?: string[] } } | undefined;
			assert.equal(progress?.currentPage?.source, "planned", JSON.stringify(result.details));
			assert.equal(progress?.liveUrlRecovered, false);
			assert.deepEqual(progress?.retryStep?.args, ["open", "https://example.test/fresh-timeout"]);
			const retryAction = (result.details?.nextActions as Array<{ id?: string; params?: { args?: string[]; sessionMode?: string } }> | undefined)?.find((action) => action.id === "retry-timeout-step");
			assert.deepEqual(retryAction?.params, { args: ["open", "https://example.test/fresh-timeout"], sessionMode: "fresh" });
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("collectTimeoutPartialProgress recovers live page state when session probes succeed", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.test/secret-token/results?token=url-secret" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Results page export secret-token Authorization: Bearer title-secret" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await mkdir(join(tempDir, "dogfood/secret-token"), { recursive: true });
		await writeFile(join(tempDir, "dogfood/secret-token/filled.png"), "fake image");
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const progress = await collectTimeoutPartialProgress({
				command: "batch",
				cwd: tempDir,
				sessionName: "named",
				stdin: JSON.stringify([
					["open", "https://example.test"],
					["screenshot", "dogfood/secret-token/filled.png"],
					["wait", "--download", "dogfood/export.csv"],
				]),
			});

			assert.ok(progress);
			assert.equal(progress.currentPage?.url, "https://example.test/secret-token/results?token=url-secret");
			assert.equal(progress.currentPage?.title, "Results page export secret-token Authorization: Bearer title-secret");
			assert.deepEqual(progress.artifacts.map((artifact) => ({ exists: artifact.exists, path: artifact.path, stepIndex: artifact.stepIndex })), [
				{ exists: true, path: "dogfood/secret-token/filled.png", stepIndex: 2 },
				{ exists: false, path: "dogfood/export.csv", stepIndex: 3 },
			]);
			const text = formatTimeoutPartialProgressText(progress);
			assert.match(text, /Current page: \[REDACTED\] — https:\/\/example.test\/\[REDACTED\]\/results\?token=%5BREDACTED%5D/);
			assert.doesNotMatch(text, /url-secret|title-secret|secret-token/);

			const compiledJob = compileAgentBrowserJob({
				steps: [
					{ action: "open", url: "https://example.test", loadState: "domcontentloaded" },
					{ action: "wait", milliseconds: 500 },
				],
			}).compiled;
			const generatedProgress = await collectTimeoutPartialProgress({ command: "batch", compiledJob, cwd: tempDir, sessionName: "named" });
			assert.equal(generatedProgress?.steps?.[1]?.generatedFrom, "open.loadState");
			assert.match(formatTimeoutPartialProgressText(generatedProgress as NonNullable<typeof generatedProgress>), /Step 2 \[failed, generated from open\.loadState\]: wait --load domcontentloaded/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("collectTimeoutPartialProgress reads page context for local URLs", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-timeout-local-page-"));
	const logPath = join(tempDir, "agent-browser.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
const subcommand = args.at(-1);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const data = subcommand === "url"
  ? { result: "file:///tmp/local-timeout-page.html" }
  : { result: "SECRET LOCAL TITLE" };
process.stdout.write(JSON.stringify({ success: true, data }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const progress = await collectTimeoutPartialProgress({ command: "batch", cwd: tempDir, sessionName: "named", stdin: "[]" });
			assert.equal(progress?.currentPage?.url, "file:///tmp/local-timeout-page.html");
			assert.equal(progress?.currentPage?.title, "SECRET LOCAL TITLE");
			assert.deepEqual((await readInvocationLog(logPath)).map((entry) => entry.args.at(-1)), ["url", "title"]);
			assert.match(JSON.stringify(progress), /SECRET LOCAL TITLE/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});


test("collectTimeoutPartialProgress falls back to the planned page URL when live page recovery is unavailable", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	try {
		for (const command of ["open", "goto", "navigate"] as const) {
			const progress = await collectTimeoutPartialProgress({
				command: "batch",
				cwd: tempDir,
				stdin: JSON.stringify([
					[command, `https://example.test/${command}-planned`],
					["screenshot", `${command}-planned.png`],
					["wait", "--download", `${command}-download.csv`],
				]),
			});

			assert.ok(progress, command);
			assert.equal(progress.currentPage?.url, `https://example.test/${command}-planned`, command);
			assert.equal(progress.currentPage?.source, "planned", command);
			assert.equal(progress.liveUrlRecovered, false, command);
			assert.equal(progress.currentPage?.title, undefined, command);
			assert.match(progress.summary, /planned page URL/, command);
			assert.deepEqual(progress.artifacts.map((artifact) => ({ exists: artifact.exists, path: artifact.path, stepIndex: artifact.stepIndex })), [
				{ exists: false, path: `${command}-planned.png`, stepIndex: 2 },
				{ exists: false, path: `${command}-download.csv`, stepIndex: 3 },
			], command);
			assert.match(formatTimeoutPartialProgressText(progress), new RegExp(`Current page: https://example\\.test/${command}-planned`), command);
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension forwards wait --download saved-file metadata in details", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-wait-download-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: { path: "/tmp/export.csv", elapsedMs: 64 } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "--download", "/tmp/export.csv"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Artifact verification failed: requested download was not found at \/tmp\/export\.csv/);
			assert.match((result.content[0] as { text: string }).text, /Download event reported; file not verified: \/tmp\/export\.csv/);
			assert.equal(result.details?.savedFilePath, "/tmp/export.csv");
			assert.deepEqual(result.details?.savedFile, {
				command: "wait",
				kind: "download",
				metadata: { elapsedMs: 64 },
				path: "/tmp/export.csv",
				subcommand: "--download",
			});
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "artifact-missing");
			assert.equal(result.details?.successCategory, undefined);
			assert.equal((result.details?.artifactVerification as { missingCount?: number; verified?: boolean } | undefined)?.missingCount, 1);
			assert.equal((result.details?.artifactVerification as { missingCount?: number; verified?: boolean } | undefined)?.verified, false);
			assert.deepEqual((result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined)?.[0]?.params?.args, ["--session", result.details?.sessionName, "wait", "--download", "/tmp/export.csv"]);
			assert.equal((result.details?.pageChangeSummary as { changeType?: string; savedFilePath?: string } | undefined)?.changeType, "artifact");
			assert.equal((result.details?.pageChangeSummary as { changeType?: string; savedFilePath?: string } | undefined)?.savedFilePath, "/tmp/export.csv");

			const shortResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "-d", "/tmp/export.csv"],
			});
			assert.equal(shortResult.isError, true);
			assert.match(shortResult.content[0]?.text ?? "", /Download event reported; file not verified: \/tmp\/export\.csv/);
			assert.equal(shortResult.details?.savedFilePath, "/tmp/export.csv");
			assert.equal((shortResult.details?.savedFile as { subcommand?: string } | undefined)?.subcommand, "-d");
			assert.equal((shortResult.details?.artifactVerification as { missingCount?: number } | undefined)?.missingCount, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports artifact lifecycle guidance on close", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-artifact-cleanup-"));
	const screenshotPath = join(tempDir, "artifact.png");
	const deletedScreenshotPath = join(tempDir, "deleted-artifact.png");
	const failClosePath = join(tempDir, "fail-close");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("screenshot")) {
  const outputPath = args[args.length - 1];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from("89504e470d0a1a0a", "hex"));
  process.stdout.write(JSON.stringify({ success: true, data: { path: outputPath } }));
} else if (args.includes("close")) {
  if (fs.existsSync(${JSON.stringify(failClosePath)})) {
    process.stdout.write(JSON.stringify({ success: false, error: "close failed" }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
  }
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const screenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", screenshotPath] });
			assert.equal(screenshot.isError, false);
			const deletedScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", deletedScreenshotPath] });
			assert.equal(deletedScreenshot.isError, false);
			await rm(deletedScreenshotPath, { force: true });
			assert.equal((deletedScreenshot.details?.artifactManifest as { liveCount?: number } | undefined)?.liveCount, 2);

			const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(close.isError, false);
			const text = (close.content[0] as { text: string }).text;
			assert.match(text, /Artifact lifecycle: 1 explicit artifact remains; expand or inspect details\.artifactCleanup\.explicitArtifactPaths for paths\./);
			assert.match(text, /Browser close does not delete explicit screenshots/);
			assert.doesNotMatch(text, /artifact\.png/);
			assert.doesNotMatch(text, /deleted-artifact\.png/);
			assert.deepEqual(close.details?.artifactCleanup, {
				explicitArtifactPaths: [screenshotPath],
				note: "Closing the browser session does not delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings; clean existing paths with host file tools when no longer needed.",
				owner: "host-file-tools",
				summary: String(close.details?.artifactRetentionSummary),
			});

			await writeFile(failClosePath, "fail");
			const failedClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(failedClose.isError, true);
			assert.doesNotMatch((failedClose.content[0] as { text: string }).text, /Artifact lifecycle:/);
			assert.equal(failedClose.details?.artifactCleanup, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns when get text may read hidden selector matches", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-get-text-visibility-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("get") && args.includes("text")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "npm init playwright@latest", origin: "https://docs.example/" } }));
} else if (args.includes("eval")) {
  const isAmbiguous = stdin.includes('.ambiguous-language-bash');
  process.stdout.write(JSON.stringify({ success: true, data: { result: JSON.stringify(isAmbiguous
    ? { selector: '.ambiguous-language-bash', matchCount: 2, visibleCount: 2, firstMatchVisible: true, firstTextPreview: "first visible", firstVisibleTextPreview: "first visible", visibleCandidates: [{ index: 0, tagName: "code", role: "tab", textPreview: "first visible" }, { index: 1, tagName: "code", textPreview: "second visible" }] }
    : { selector: '[href*="token=page-secret"]', matchCount: 2, visibleCount: 1, firstMatchVisible: false, firstTextPreview: "npm init playwright@latest", firstVisibleTextPreview: "yarn create playwright Authorization: Bearer visible-secret", visibleCandidates: [{ index: 1, tagName: "code", textPreview: "yarn create playwright Authorization: Bearer visible-secret" }] }) } }));
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify({ success: true, data: [{ command: ["get", "text", ".ambiguous-language-bash"], success: true, result: { result: "first visible" } }, { command: ["get", "text", ".language-bash"], success: true, result: { result: "npm init playwright@latest" } }] }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", ".language-bash"] });
			assert.equal(result.isError, false);
			assert.match((result.content[0] as { text: string }).text, /npm init playwright@latest/);
			assert.match((result.content[0] as { text: string }).text, /Selector text visibility warning:/);
			assert.match((result.content[0] as { text: string }).text, /Next action: use details\.nextActions inspect-visible-text-candidates before trusting this selector text\./);
			assert.match((result.content[0] as { text: string }).text, /yarn create playwright/);
			assert.doesNotMatch((result.content[0] as { text: string }).text, /visible-secret|page-secret/);
			assert.deepEqual(result.details?.selectorTextVisibility, {
				firstMatchVisible: false,
				firstVisibleTextPreview: "yarn create playwright Authorization: Bearer [REDACTED]",
				matchCount: 2,
				selector: ".language-bash",
				summary: 'Selector ".language-bash" matched 2 elements; the first match is hidden while 1 visible match exists.',
				visibleCandidates: [{ index: 1, tagName: "code", textPreview: "yarn create playwright Authorization: Bearer [REDACTED]" }],
				visibleCount: 1,
			});
			assert.match((result.content[0] as { text: string }).text, /Visible candidates \(1 shown, querySelectorAll index\):/);
			assert.match((result.content[0] as { text: string }).text, /\[1\] code: "yarn create playwright Authorization: Bearer \[REDACTED\]"/);
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[]; stdin?: string } }> | undefined;
			assert.equal(nextActions?.at(-1)?.id, "inspect-visible-text-candidates");
			assert.deepEqual(nextActions?.at(-1)?.params?.args, ["--session", result.details?.sessionName as string, "eval", "--stdin"]);
			assert.match(nextActions?.at(-1)?.params?.stdin ?? "", /querySelectorAll/);

			const secretSelectorResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", '[href*="token=visible-secret"]'] });
			assert.equal(secretSelectorResult.isError, false);
			assert.doesNotMatch((secretSelectorResult.content[0] as { text: string }).text, /Selector text visibility warning|visible-secret/);
			assert.equal(secretSelectorResult.details?.selectorTextVisibility, undefined);
			const unquotedSecretSelectorResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", "[data-token=visible-secret]"] });
			assert.equal(unquotedSecretSelectorResult.isError, false);
			assert.doesNotMatch((unquotedSecretSelectorResult.content[0] as { text: string }).text, /Selector text visibility warning|visible-secret/);
			assert.equal(unquotedSecretSelectorResult.details?.selectorTextVisibility, undefined);
			let invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);

			const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: JSON.stringify([["get", "text", ".ambiguous-language-bash"], ["get", "text", ".language-bash"]]) });
			assert.equal(batchResult.isError, false);
			assert.match((batchResult.content[0] as { text: string }).text, /Selector text visibility warning:/);
			assert.match((batchResult.content[0] as { text: string }).text, /Selector "\.language-bash" matched 2 elements; the first match is hidden/);
			assert.match((batchResult.content[0] as { text: string }).text, /Selector "\.ambiguous-language-bash" matched 2 elements; get text reads the first upstream match/);
			assert.match((batchResult.content[0] as { text: string }).text, /Next action: use details\.nextActions inspect-visible-text-candidates before trusting this selector text\./);
			assert.match((batchResult.content[0] as { text: string }).text, /Next action: use details\.nextActions inspect-visible-text-candidates-2 before trusting this selector text\./);
			assert.equal((batchResult.details?.selectorTextVisibility as { selector?: string } | undefined)?.selector, ".language-bash");
			assert.deepEqual((batchResult.details?.selectorTextVisibilityAll as Array<{ selector?: string }> | undefined)?.map((entry) => entry.selector), [".language-bash", ".ambiguous-language-bash"]);
			invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 3);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension surfaces overlay blockers in snapshot actionability metadata", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-overlay-snapshot-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://blocked.example/",
    refs: {
      e5: { role: "button", name: "×" },
      e6: { role: "button", name: "Donate now" },
      e7: { role: "dialog", name: "Donation banner" }
    },
    snapshot: '- dialog "Donation banner" [ref=e7]\\n  - button "×" [ref=e5]\\n  - button "Donate now" [ref=e6]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Blocked Search", url: "https://blocked.example/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.match(snapshot.content[0]?.text ?? "", /Possible overlay blockers:/);
			const overlayBlockers = snapshot.details?.overlayBlockers as { candidates?: Array<{ ref?: string }> } | undefined;
			assert.equal(overlayBlockers?.candidates?.[0]?.ref, "@e5");
			assert.ok((snapshot.details?.nextActions as Array<{ id?: string }> | undefined)?.some((action) => action.id === "try-overlay-blocker-candidate-1"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension surfaces likely overlay blockers after a no-op click", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-overlay-blocker-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Blocked Search", url: "https://blocked.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e9" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://blocked.example/", url: "https://blocked.example/" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Blocked Search", title: "Blocked Search" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Blocked Search", url: "https://blocked.example/" } } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://blocked.example/",
    refs: {
      e5: { role: "button", name: "×" },
      e6: { role: "button", name: "Donate now" },
      e7: { role: "dialog", name: "Donation banner" }
    },
    snapshot: '- dialog "Donation banner" [ref=e7]\\n  - button "×" [ref=e5]\\n  - button "Donate now" [ref=e6]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://blocked.example/"] });
			assert.equal(open.isError, false);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e9"] });
			assert.equal(click.isError, false);
			const text = click.content[0] as { text: string };
			assert.match(text.text, /Possible overlay blockers:/);
			assert.match(text.text, /Action dispatched; application change unverified/);
			assert.match(text.text, /@e5 button "×"/);
			assert.equal((click.details?.pageChangeSummary as { observed?: boolean } | undefined)?.observed, false);
			assert.doesNotMatch(text.text, /Agent-browser candidate fallbacks:/);
			const overlayBlockers = click.details?.overlayBlockers as { candidates?: Array<{ ref?: string; args?: string[] }> } | undefined;
			assert.equal(overlayBlockers?.candidates?.[0]?.ref, "@e5");
			assert.deepEqual((click.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e5", "e6", "e7"]);
			const nextActions = click.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["inspect-after-mutation", "inspect-overlay-state", "try-overlay-blocker-candidate-1"]);
			assert.deepEqual(nextActions?.[1]?.params?.args, ["--session", click.details?.sessionName as string, "snapshot", "-i"]);
			assert.deepEqual(nextActions?.[2]?.params?.args, ["--session", click.details?.sessionName as string, "click", "@e5"]);

			const closeCandidateArgs = nextActions?.[2]?.params?.args;
			assert.ok(closeCandidateArgs);
			const closeCandidate = await executeRegisteredTool(harness.tool, harness.ctx, { args: closeCandidateArgs });
			assert.equal(closeCandidate.isError, false);
			assert.notEqual(closeCandidate.details?.failureCategory, "stale-ref");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not report overlay blockers from unrelated page chrome after a successful same-page click", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-overlay-noise-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Repo", url: "https://repo.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e9" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://repo.example/", url: "https://repo.example/" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Repo", title: "Repo" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Repo", url: "https://repo.example/" } } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://repo.example/",
    refs: {
      e1: { role: "link", name: "Skip to content" },
      e2: { role: "button", name: "Privacy choices" },
      e3: { role: "button", name: "Close banner" }
    },
    snapshot: '- link "Skip to content" [ref=e1]\\n- button "Privacy choices" [ref=e2]\\n- button "Close banner" [ref=e3]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://repo.example/"] });
			assert.equal(open.isError, false);
			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e9"] });
			assert.equal(click.isError, false);
			const text = click.content[0] as { text: string };
			assert.doesNotMatch(text.text, /Possible overlay blockers:/);
			assert.equal(click.details?.overlayBlockers, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns tab-drift next actions for early tab re-selection failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tab-drift-next-actions-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "target", title: "Example Domain", url: "https://example.com/", active: false }
  ] } }));
} else if (args.includes("tab") && args.includes("target")) {
  process.stdout.write(JSON.stringify({ success: false, error: "tab vanished" }));
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({
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
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "eval", "--stdin"],
				stdin: "document.title",
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "tab-drift");
			const nextActions = result.details?.nextActions as Array<{ id: string; params?: { args: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["list-tabs-for-tab-drift-recovery"]);
			assert.deepEqual(nextActions?.map((action) => action.params?.args), [
				["--session", "named", "tab", "list"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
