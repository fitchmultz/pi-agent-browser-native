/**
 * Purpose: Verify extension entrypoint validation-error and diagnostic contracts.
 * Responsibilities: Assert malformed args/envelopes, timeout progress, managed-session, selector visibility, overlay, prompt guards, and tab-drift diagnostics.
 * Scope: Integration-style Node test-runner coverage split out of the broad extension-validation suite.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-errors-artifacts.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { readArray, readRecord, readString } from "./helpers/assertions.js";
import { withAgentBrowserProcessEnvironment } from "../extensions/agent-browser/lib/process-environment.js";
import { execFileSync } from "node:child_process";
import {
	access,
	link,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	utimes,
	watch,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { compileAgentBrowserQaPreset } from "../extensions/agent-browser/lib/input-modes/job.js";
import { getAgentBrowserSocketDir } from "../extensions/agent-browser/lib/process.js";
import {
	applyArtifactChanges,
	getBrowserRecord,
} from "../extensions/agent-browser/lib/browser-transcript.js";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import type { SessionArtifactManifest } from "../extensions/agent-browser/lib/results/contracts.js";

function initializeGitProject(cwd: string): void {
	execFileSync("git", ["init", "-q", cwd], { stdio: "ignore" });
}
import {
	createManagedSessionRestoreKey,
	getManagedSessionRestoreScope,
} from "../extensions/agent-browser/lib/managed-session-restore.js";
import {
	collectTimeoutPartialProgress,
	formatTimeoutPartialProgressText,
} from "../extensions/agent-browser/lib/orchestration/browser-run/diagnostics.js";
import { applyAgentBrowserOutputPath } from "../extensions/agent-browser/lib/orchestration/output-file.js";
import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test(
	"agentBrowserExtension rejects dangling value-taking flags before spawning agent-browser",
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
process.stdout.write(JSON.stringify({ success: true, data: { args } }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session"],
				});
				assert.ok(result.details);

				assert.equal(result.isError, true);
				assert.equal(result.content[0]?.type, "text");
				assert.match(
					readString(readRecord(result.content[0]).text),
					/requires a value immediately after it/i,
				);
				assert.equal(readRecord(result.details.invalidValueFlag).flag, "--session");
				assert.equal(readRecord(result.details.invalidValueFlag).reason, "missing-value");
				assert.equal(result.details.resultCategory, "failure");
				assert.equal(result.details.failureCategory, "validation-error");
				assert.deepEqual(await readInvocationLog(logPath), []);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension passes through managed state capabilities and list rows",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-managed-state-access-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		const restoreKey = `piab-r2-${"a".repeat(32)}`;
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { files: [{ filename: ${JSON.stringify(`${restoreKey}-managed.json`)}, path: ${JSON.stringify(`/tmp/${restoreKey}-managed.json`)} }] } }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const listed = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--json", "state", "list"],
				});
				assert.equal(listed.isError, false, JSON.stringify(listed));
				assert.match(JSON.stringify(listed), new RegExp(restoreKey));
				for (const args of [
					["state", "show", `/other/checkout/${restoreKey}-managed.json`],
					["state", "clear", "--all"],
					["--restore", restoreKey, "open", "https://example.com"],
				]) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
					// All three literal state/restore commands check passthrough success and visible details.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(result.details);
					// All three literal state/restore commands check passthrough success and visible details.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.isError, false, JSON.stringify(result));
				}
				assert.ok((await readInvocationLog(logPath)).length >= 4);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension passes through file access, local navigation, and protected-looking paths",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-file-access-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		const localUrl = pathToFileURL(join(tempDir, ".agent-browser", "sessions", "auth.html")).href;
		const artifactPath = join(tempDir, ".agent-browser", "capture.png");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, allowFileAccess: process.env.AGENT_BROWSER_ALLOW_FILE_ACCESS ?? null, rawArgs: process.env.AGENT_BROWSER_ARGS ?? null, config: process.env.AGENT_BROWSER_CONFIG ?? null }) + "\\n");
if (args.includes("screenshot")) {
  const path = args[args.indexOf("screenshot") + 1];
  fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
  fs.writeFileSync(path, "image");
  process.stdout.write(JSON.stringify({ success: true, data: { path } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Local", url: args.find((arg) => arg.startsWith("file:")) } }));
}`,
		);
		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_ALLOW_FILE_ACCESS: "true",
					AGENT_BROWSER_ARGS: "--disable-web-security",
					AGENT_BROWSER_CONFIG: join(tempDir, "agent-browser.json"),
					PI_AGENT_BROWSER_TEST_PAGE_URL: localUrl,
					PATH: `${tempDir}:${basePath}`,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					for (const args of [
						["--allow-file-access", "true", "open", localUrl],
						["screenshot", artifactPath],
						["--config", "/tmp/explicit-agent-browser.json", "open", "https://example.com"],
					]) {
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
						// All three literal local/config/artifact commands check passthrough success and details.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(result.details);
						// All three literal local/config/artifact commands check passthrough success and details.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(result.isError, false, JSON.stringify(result));
					}
					const invocations = await readInvocationLog(logPath);
					assert.deepEqual(
						invocations
							.filter((entry) => !entry.args.includes("eval"))
							.map((entry) => entry.args.slice(-2)),
						[
							["open", localUrl],
							["tab", "list"],
							["screenshot", artifactPath],
							["open", "https://example.com"],
						],
					);
					assert.equal(
						invocations.filter((entry) => entry.args.includes("eval")).length,
						2,
						"screenshot geometry uses the same invocation environment",
					);
					assert.ok(
						invocations.every(
							(entry) =>
								readRecord(entry).allowFileAccess === "true" &&
								readRecord(entry).rawArgs === "--disable-web-security",
						),
					);
					assert.equal(readRecord(invocations[0]).allowFileAccess, "true");
					assert.equal(readRecord(invocations[0]).rawArgs, "--disable-web-security");
					assert.equal(readRecord(invocations[0]).config, join(tempDir, "agent-browser.json"));
					assert.ok(invocations.some((entry) => entry.args.includes(artifactPath)));
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension live-verifies caller-owned explicit sessions before content reads",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-live-url-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args[args.indexOf("--session") + 1];
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
if (args.includes("url")) {
  if (sessionName === "caller-failed") { process.stdout.write(JSON.stringify({ success: false, error: "No active page" })); process.exit(1); }
  const url = sessionName === "caller-local" ? "file:///tmp/.agent-browser/sessions/auth.html" : "https://safe.example/";
  process.stdout.write(JSON.stringify({ success: true, data: { url } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { html: sessionName === "caller-local" ? "LOCAL CONTENT" : "SAFE CONTENT" } }));
}`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				for (const [sessionName, content] of [
					["caller-local", "LOCAL CONTENT"],
					["caller-safe", "SAFE CONTENT"],
				]) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", sessionName, "get", "html", "body"],
					});
					// Both literal local/remote caller sessions check successful reads of their expected content.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(result.details);
					// Both literal local/remote caller sessions check successful reads of their expected content.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.isError, false, JSON.stringify(result));
					// Both literal local/remote caller sessions check successful reads of their expected content.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(result.content[0]?.text ?? "", new RegExp(content));
				}
				const failed = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "caller-failed", "get", "html", "body"],
				});
				assert.ok(failed.details);
				assert.equal(failed.isError, true, JSON.stringify(failed));
				assert.match(failed.content[0]?.text ?? "", /active page became unverified/);
				const invocations = await readInvocationLog(logPath);
				for (const sessionName of ["caller-local", "caller-safe"]) {
					const calls = invocations.filter((entry) => entry.args.includes(sessionName));
					// Both literal successful caller sessions check exact live-verification/read order.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.deepEqual(
						calls.map((entry) => (entry.args.includes("url") ? "url" : "html")),
						["url", "html"],
					);
				}
				assert.equal(invocations.filter((entry) => entry.args.includes("caller-failed")).length, 1);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension serializes caller-owned live verification with same-session commands",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-live-race-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "active-page.txt");
		const liveProbePath = join(tempDir, "live-probe-started");
		const releaseLiveProbePath = join(tempDir, "release-live-probe");
		const basePath = process.env.PATH ?? "";
		await writeFile(statePath, "safe", "utf8");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
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
}`,
		);
		try {
			await withPatchedEnv(
				{ AGENT_BROWSER_NAMESPACE: "Review Space", PATH: `${tempDir}:${basePath}` },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const controller = new AbortController();
					const liveProbeReady = (async () => {
						for await (const event of watch(tempDir, { signal: controller.signal })) {
							if (event.filename === "live-probe-started") {
								return;
							}
						}
					})();
					const contentPromise = executeRegisteredTool(
						harness.tool,
						harness.ctx,
						{
							args: ["--session", "caller-race", "get", "html", "body"],
						},
						controller.signal,
					);
					const pendingCalls = [contentPromise];
					try {
						await Promise.race([
							liveProbeReady,
							contentPromise.then((result) =>
								assert.fail(
									`Live probe did not become ready before the content call settled: ${JSON.stringify(result)}`,
								),
							),
						]);
						const tabPromise = executeRegisteredTool(
							harness.tool,
							harness.ctx,
							{
								args: ["--namespace", "review-space", "--session", "caller-race", "tab", "t2"],
							},
							controller.signal,
						);
						const otherSessionPromise = executeRegisteredTool(
							harness.tool,
							harness.ctx,
							{
								args: ["--session", "caller-other", "open", "https://other.example"],
							},
							controller.signal,
						);
						pendingCalls.push(tabPromise, otherSessionPromise);
						await Promise.race([
							otherSessionPromise,
							contentPromise.then((result) =>
								assert.fail(
									`Content call must remain blocked while the other session completes: ${JSON.stringify(result)}`,
								),
							),
						]);
						const beforeRelease = await readInvocationLog(logPath);
						assert.equal(
							beforeRelease.some((entry) => entry.args.includes("caller-other")),
							true,
						);
						assert.equal(
							beforeRelease.some(
								(entry) => entry.args.includes("caller-race") && entry.args.includes("tab"),
							),
							false,
						);
						await writeFile(releaseLiveProbePath, "release", "utf8");
						const [contentResult, tabResult, otherSessionResult] = await Promise.all([
							contentPromise,
							tabPromise,
							otherSessionPromise,
						]);
						assert.equal(contentResult.isError, false, JSON.stringify(contentResult));
						assert.match(contentResult.content[0]?.text ?? "", /SAFE CONTENT/);
						assert.doesNotMatch(JSON.stringify(contentResult), /SECRET_RACE_FROM_PROTECTED_FILE/);
						assert.equal(tabResult.isError, false, JSON.stringify(tabResult));
						assert.equal(otherSessionResult.isError, false, JSON.stringify(otherSessionResult));
						const invocations = await readInvocationLog(logPath);
						const callerRaceInvocations = invocations.filter((entry) =>
							entry.args.includes("caller-race"),
						);
						assert.deepEqual(
							callerRaceInvocations.map((entry) => entry.args.slice(-2)),
							[
								["get", "url"],
								["html", "body"],
								["tab", "t2"],
								["get", "url"],
								["get", "title"],
								["tab", "list"],
							],
						);
						const otherOpenIndex = invocations.findIndex(
							(entry) => entry.args.includes("caller-other") && entry.args.includes("open"),
						);
						const raceContentIndex = invocations.findIndex(
							(entry) => entry.args.includes("caller-race") && entry.args.includes("html"),
						);
						assert.equal(otherOpenIndex > 0 && otherOpenIndex < raceContentIndex, true);
					} finally {
						controller.abort();
						await Promise.allSettled([...pendingCalls, liveProbeReady]);
					}
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension keeps failed navigation targets unverified",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-failed-navigation-state-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		const localUrl = pathToFileURL(join(tempDir, "local.html")).href;
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("pushstate")) {
  process.stdout.write(JSON.stringify({ success: false, error: "SecurityError: cross-origin pushState" }));
  process.exitCode = 1;
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: ${JSON.stringify(localUrl)}, snapshot: "SECRET LOCAL CONTENT" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Local", url: ${JSON.stringify(localUrl)} } }));
}`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", localUrl],
				});
				assert.ok(opened.details);
				assert.equal(opened.isError, false, JSON.stringify(opened));
				const failedNavigation = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["pushstate", "https://safe.example/"],
				});
				assert.ok(failedNavigation.details);
				assert.equal(failedNavigation.isError, true, JSON.stringify(failedNavigation));
				assert.equal(failedNavigation.details.sessionTabTarget, undefined);
				assert.equal(failedNavigation.details.sessionTabTargetUnknown, true);
				const invocationCount = (await readInvocationLog(logPath)).length;
				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.ok(snapshot.details);
				assert.equal(snapshot.isError, true, JSON.stringify(snapshot));
				assert.match(snapshot.content[0]?.text ?? "", /active page became unverified/);
				assert.doesNotMatch(JSON.stringify(snapshot), /SECRET LOCAL CONTENT/);
				assert.equal((await readInvocationLog(logPath)).length, invocationCount);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports local-page navigation and continues normally",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-local-navigation-helper-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "page-state.txt");
		const basePath = process.env.PATH ?? "";
		const protectedUrl = pathToFileURL(
			join(tempDir, ".agent-browser", "sessions", "auth.html"),
		).href;
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
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
}`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				for (const transitionArgs of [
					["back"],
					["eval", "location.href='file:///tmp/.agent-browser/auth.html'"],
				]) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://safe.example/"],
					});
					// Both literal history/eval transitions check reconciliation before their next snapshot.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(opened.details);
					// Both literal history/eval transitions check reconciliation before their next snapshot.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(opened.isError, false, JSON.stringify(opened));
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const beforeTransition = (await readInvocationLog(logPath)).length;
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const transitioned = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: transitionArgs,
					});
					// Both literal history/eval transitions check reconciliation before their next snapshot.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(transitioned.isError, false, JSON.stringify(transitioned));
					// Both literal history/eval transitions check reconciliation before their next snapshot.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(JSON.stringify(transitioned), /SECRET COOKIE TITLE/);
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const invocations = await readInvocationLog(logPath);
					const transitionIndex = invocations.findIndex(
						(entry, index) => index >= beforeTransition && entry.args.includes(transitionArgs[0]),
					);
					// Both literal history/eval transitions check reconciliation before their next snapshot.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(transitionIndex >= beforeTransition);
					// Both literal history/eval transitions check reconciliation before their next snapshot.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						invocations
							.slice(transitionIndex + 1)
							.some((entry) => entry.args.includes("get") && entry.args.includes("url")),
						true,
					);
					// Both literal history/eval transitions check reconciliation before their next snapshot.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						invocations
							.slice(transitionIndex + 1)
							.some((entry) => entry.args.includes("get") && entry.args.includes("title")),
						true,
					);

					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					// Both literal history/eval transitions check reconciliation before their next snapshot.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(snapshot.details);
					// Both literal history/eval transitions check reconciliation before their next snapshot.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension exposes and targets wrapper-prefixed live sessions",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-managed-session-access-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://private.example" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { sessions: [
    { name: "piab-foreign-live", active: true, url: "https://private.example" },
    { name: "caller-owned", active: false, url: "https://example.com" }
  ] } }));
}`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const listed = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--json", "session", "list"],
				});
				assert.equal(listed.isError, false, JSON.stringify(listed));
				assert.match(JSON.stringify(listed), /caller-owned/);
				assert.match(JSON.stringify(listed), /piab-foreign-live|private\.example/);

				for (const sessionName of ["piab-foreign-live", "PIAB-foreign-live"]) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", sessionName, "get", "url"],
					});
					// Both literal wrapper-looking session names must remain targetable without reservation gates.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(result.details);
					// Both literal wrapper-looking session names must remain targetable without reservation gates.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(result.isError, false, JSON.stringify(result));
				}
				assert.deepEqual(
					(await readInvocationLog(logPath)).map((entry) => entry.args),
					[
						["--json", "session", "list"],
						["--json", "--session", "piab-foreign-live", "get", "url"],
						["--json", "--session", "piab-foreign-live", "tab", "list"],
						["--json", "--session", "PIAB-foreign-live", "get", "url"],
						["--json", "--session", "PIAB-foreign-live", "tab", "list"],
					],
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rejects incompatible launch reuse of an active restore-enabled managed daemon",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "rp-"));
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
			await withPatchedEnv(
				{
					AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
					HOME: tempDir,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
						sessionMode: "fresh",
						args: ["--namespace", "Team", "open", "https://dash.cloudflare.com"],
					});
					assert.ok(opened.details);
					assert.equal(opened.isError, false, JSON.stringify(opened));
					assert.equal(opened.details.namespace, "team");
					const sessionName = readString(opened.details.sessionName ?? "");
					assert.match(sessionName, /^piab-/);
					const openInvocations = await readInvocationLog(logPath);
					assert.equal(readRecord(openInvocations[0]).ownedMarker, undefined);
					assert.equal(readRecord(openInvocations[0]).stateExpireDays, undefined);

					assert.equal(
						readRecord(opened.details.compatibilityWorkaround ?? {}).id,
						"cloudflare-headless-user-agent",
					);
					const afterCloudflareOpen = await readInvocationLog(logPath);
					const daemonProbes = afterCloudflareOpen.filter(
						(entry) => entry.args.includes("session") && entry.args.includes("info"),
					);
					assert.equal(
						daemonProbes.length,
						2,
						"inspect before launch and capture the resulting daemon generation",
					);
					assert.ok(
						afterCloudflareOpen.indexOf(daemonProbes[0]) <
							afterCloudflareOpen.findIndex((entry) => entry.args.includes("open")),
					);
					assert.ok(
						afterCloudflareOpen.indexOf(daemonProbes[1]) >
							afterCloudflareOpen.findIndex((entry) => entry.args.includes("open")),
					);
					const cloudflareInvocation = afterCloudflareOpen.find((entry) =>
						entry.args.includes("https://dash.cloudflare.com"),
					);
					assert.ok(cloudflareInvocation?.args.includes("--user-agent") === true);
					const cloudflareBrowserArgs =
						cloudflareInvocation.args[cloudflareInvocation.args.indexOf("--args") + 1] ?? "";
					assert.match(
						cloudflareBrowserArgs,
						/^--no-startup-window,--user-agent=.*Chrome\/\d+\.0\.0\.0/,
					);
					assert.doesNotMatch(
						cloudflareBrowserArgs.slice("--no-startup-window,".length),
						/[,\r\n]/,
					);
					assert.match(
						readString(readRecord(cloudflareInvocation).userAgent),
						/Chrome\/\d+\.0\.0\.0/,
					);
					assert.equal(
						readRecord(cloudflareInvocation).restore,
						createManagedSessionRestoreKey(tempDir, getManagedSessionRestoreScope(sessionName)),
					);

					const cloudflareFollowup = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.ok(cloudflareFollowup.details);
					assert.equal(cloudflareFollowup.isError, false, JSON.stringify(cloudflareFollowup));
					assert.equal(
						readRecord(cloudflareFollowup.details.compatibilityWorkaround ?? {}).id,
						"cloudflare-headless-user-agent",
					);
					const afterCloudflareFollowup = await readInvocationLog(logPath);
					const followupInvocation = afterCloudflareFollowup
						.slice()
						.reverse()
						.find((entry) => entry.args.includes("snapshot"));
					assert.equal(followupInvocation?.args.includes("--user-agent"), false);
					assert.equal(followupInvocation.args.includes("--args"), false);
					assert.equal(readRecord(followupInvocation).userAgent, undefined);

					await writeFile(
						join(tempDir, "daemon-state.json"),
						JSON.stringify({ active: false, restoreKey: null }),
					);
					const relaunched = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "title"],
					});
					assert.equal(relaunched.isError, false, JSON.stringify(relaunched));
					const relaunchInvocation = (await readInvocationLog(logPath))
						.slice()
						.reverse()
						.find((entry) => entry.args.includes("get") && entry.args.includes("title"));
					assert.ok(relaunchInvocation?.args.includes("--user-agent") === true);
					assert.match(
						readString(readRecord(relaunchInvocation).userAgent),
						/Chrome\/\d+\.0\.0\.0/,
					);
					await writeFile(
						join(tempDir, "daemon-state.json"),
						JSON.stringify({
							active: true,
							restoreKey: createManagedSessionRestoreKey(
								tempDir,
								getManagedSessionRestoreScope(sessionName),
							),
						}),
					);
					const userInvocationCount = async () =>
						(await readInvocationLog(logPath)).filter(
							(entry) => !(entry.args.includes("session") && entry.args.includes("info")),
						).length;
					const invocationCount = await userInvocationCount();

					const abortController = new AbortController();
					abortController.abort();
					const aborted = await executeRegisteredTool(
						harness.tool,
						harness.ctx,
						{
							args: ["--proxy", "http://127.0.0.1:8080", "open", "https://example.com"],
						},
						abortController.signal,
					);
					assert.ok(aborted.details);
					assert.equal(aborted.isError, true);
					assert.equal(aborted.details.validationError, undefined);
					assert.equal(await userInvocationCount(), invocationCount);

					for (const params of [
						{
							args: ["batch"],
							stdin: JSON.stringify([
								["connect", "wss://remote.example/devtools/browser/test"],
								["snapshot", "-i"],
							]),
						},
						{ args: ["batch", "connect wss://remote.example/devtools/browser/test"] },
					]) {
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						const blockedBatch = await executeRegisteredTool(harness.tool, harness.ctx, params);
						// Both literal raw/stdin connect batches must fail without increasing user dispatch count.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(blockedBatch.details);
						// Both literal raw/stdin connect batches must fail without increasing user dispatch count.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(blockedBatch.isError, true);
						// Both literal raw/stdin connect batches must fail without increasing user dispatch count.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(
							readString(blockedBatch.details.validationError ?? ""),
							/does not match the requested managed-restore policy|active page became unverified/,
						);
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						const afterBatchInvocationCount = await userInvocationCount();
						// Both literal raw/stdin connect batches must fail without increasing user dispatch count.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(afterBatchInvocationCount, invocationCount);
					}

					const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [
							"--namespace",
							"team",
							"--session",
							sessionName,
							"--cdp",
							"http://127.0.0.1:9222",
							"open",
							"https://example.com",
						],
					});
					assert.ok(blocked.details);
					assert.equal(blocked.isError, true);
					assert.equal(blocked.details.failureCategory, "validation-error");
					assert.match(readString(blocked.details.validationError ?? ""), /launch-scoped flags/);
					assert.equal(await userInvocationCount(), invocationCount);
					assert.equal(blocked.details.managedSessionRestoreDisabled, undefined);

					const sessionsDir = join(tempDir, ".agent-browser", "sessions");
					const restoreKey = createManagedSessionRestoreKey(
						tempDir,
						getManagedSessionRestoreScope(sessionName),
					);
					await mkdir(sessionsDir, { recursive: true });
					for (const [index, suffix] of ["old", "middle", "new"].entries()) {
						const path = join(sessionsDir, `${restoreKey}-${suffix}.json`);
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						await writeFile(path, "{}");
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						await utimes(path, index + 1, index + 1);
					}
					const callerState = join(sessionsDir, "caller-owned.json");
					await writeFile(callerState, "{}");
					await writeFile(
						join(tempDir, "daemon-state.json"),
						JSON.stringify({ active: true, restoreKey }),
					);

					const restoredHarness = createExtensionHarness({
						cwd: tempDir,
						branch: harness.ctx.sessionManager.getBranch().slice(),
					});
					await runExtensionEvent(
						restoredHarness.handlers,
						"session_start",
						{ reason: "new" },
						restoredHarness.ctx,
					);
					const restoredDaemonReuse = await executeRegisteredTool(
						restoredHarness.tool,
						restoredHarness.ctx,
						{
							args: [
								"--namespace",
								"TEAM",
								"--proxy",
								"http://127.0.0.1:8080",
								"open",
								"https://example.com",
							],
						},
					);
					assert.ok(restoredDaemonReuse.details);
					assert.equal(restoredDaemonReuse.isError, true);
					assert.match(
						readString(restoredDaemonReuse.details.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);
					assert.equal(await userInvocationCount(), invocationCount);

					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						harness.ctx,
					);
					await access(join(sessionsDir, `${restoreKey}-old.json`));
					await access(join(sessionsDir, `${restoreKey}-middle.json`));
					await access(join(sessionsDir, `${restoreKey}-new.json`));
					await access(callerState);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension revalidates daemon policy after cross-instance lock contention",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-policy-race-"));
		initializeGitProject(tempDir);
		const statePath = join(tempDir, "daemon-state.json");
		const startedPath = join(tempDir, "compatible-started");
		const allowPath = join(tempDir, "allow-compatible");
		const mainLogPath = join(tempDir, "main.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else if (args.includes("--profile") || process.env.AGENT_BROWSER_PROFILE) {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, "incompatible-main\\n");
  process.stdout.write(JSON.stringify({ success: true, data: { title: "unsafe", url: "https://example.com/unsafe" } }));
} else if (args.includes("open")) {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, "compatible-main\\n");
  fs.writeFileSync(${JSON.stringify(startedPath)}, "started");
  while (!fs.existsSync(${JSON.stringify(allowPath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null }));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "safe", url: "https://example.com/safe" } }));
} else {
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null }));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "safe", url: "https://example.com/safe" } }));
}`,
		);
		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
					HOME: tempDir,
					USERPROFILE: tempDir,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const first = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(first.handlers, "session_start", { reason: "new" }, first.ctx);
					const seeded = await executeRegisteredTool(first.tool, first.ctx, {
						args: ["get", "url"],
						sessionMode: "fresh",
					});
					assert.equal(seeded.isError, false, JSON.stringify(seeded));
					const second = createExtensionHarness({
						cwd: tempDir,
						branch: first.ctx.sessionManager.getBranch().slice(),
					});
					await runExtensionEvent(
						second.handlers,
						"session_start",
						{ reason: "resume" },
						second.ctx,
					);
					await writeFile(statePath, JSON.stringify({ active: false, restoreKey: null }));
					const compatible = executeRegisteredTool(first.tool, first.ctx, {
						args: ["open", "https://example.com/safe"],
					});
					for (let attempt = 0; attempt < 100; attempt += 1) {
						try {
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							await access(startedPath);
							break;
						} catch {
							if (attempt === 99) {
								// This is a fail-closed polling deadline: exhausting all 100 attempts fails the test.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.fail("compatible call did not reach the fake upstream process");
							}
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							await new Promise((resolveDelay) => {
								setTimeout(resolveDelay, 10);
							});
						}
					}
					const incompatible = withAgentBrowserProcessEnvironment(
						{ AGENT_BROWSER_PROFILE: "Default" },
						() =>
							executeRegisteredTool(second.tool, second.ctx, {
								args: ["open", "https://example.com/unsafe"],
							}),
					);
					await new Promise((resolveDelay) => {
						setTimeout(resolveDelay, 50);
					});
					await writeFile(allowPath, "allow");
					const compatibleResult = await compatible;
					assert.equal(compatibleResult.isError, false, JSON.stringify(compatibleResult));
					const daemonState = readRecord(JSON.parse(await readFile(statePath, "utf8")));
					assert.match(readString(daemonState.restoreKey ?? ""), /^piab-r2-/);
					const blocked = await incompatible;
					assert.equal(blocked.isError, true, JSON.stringify(blocked));
					assert.match(
						readString(blocked.details?.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);
					assert.equal(await readFile(mainLogPath, "utf8"), "compatible-main\n");
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension re-inspects a locally known daemon after an external restart",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-restart-"));
		initializeGitProject(tempDir);
		const statePath = join(tempDir, "daemon-state.json");
		const mainLogPath = join(tempDir, "main.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, JSON.stringify({ args, restore: process.env.AGENT_BROWSER_RESTORE ?? "disabled" }) + "\\n");
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null }));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "safe", url: "https://example.com/safe" } }));
}`,
		);
		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
					HOME: tempDir,
					USERPROFILE: tempDir,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const initial = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com/safe"],
						sessionMode: "fresh",
					});
					assert.ok(initial.details);
					assert.equal(initial.isError, false, JSON.stringify(initial));
					const initialInvocations = await readInvocationLog(mainLogPath);
					assert.deepEqual(
						initialInvocations.map((entry) => entry.args.slice(-2)),
						[
							["open", "https://example.com/safe"],
							["tab", "list"],
						],
					);
					const restoreKey = createManagedSessionRestoreKey(
						tempDir,
						getManagedSessionRestoreScope(readString(initial.details.sessionName)),
					);
					assert.deepEqual(
						initialInvocations.map((entry) => readRecord(entry).restore),
						[restoreKey, restoreKey],
					);
					await writeFile(statePath, JSON.stringify({ active: true, restoreKey: null }));

					const restarted = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.ok(restarted.details);
					assert.equal(restarted.isError, true, JSON.stringify(restarted));
					assert.match(
						readString(restarted.details.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);
					assert.deepEqual(await readInvocationLog(mainLogPath), initialInvocations);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension serializes caller-owned artifact writes and preserves their aggregate manifest",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-artifact-concurrent-"));
		const startedPath = join(tempDir, "slow-started");
		const slowPath = join(tempDir, "slow.png");
		const fastPath = join(tempDir, "fast.png");
		const finalPath = join(tempDir, "final.png");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
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
}`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "2",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const slowScreenshot = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "slow", "screenshot", slowPath],
					});
					for (let attempt = 0; attempt < 3_000; attempt += 1) {
						try {
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							await access(startedPath);
							break;
						} catch {
							if (attempt === 2_999) {
								// This is a fail-closed startup deadline: exhausting all 3000 attempts fails the test.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.fail("slow caller-owned screenshot did not start");
							}
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							await new Promise((resolveDelay) => {
								setTimeout(resolveDelay, 5);
							});
						}
					}
					const fastScreenshot = executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "fast", "screenshot", fastPath],
					});
					const concurrentResults = await Promise.all([slowScreenshot, fastScreenshot]);
					assert.equal(
						concurrentResults.every((result) => result.isError === false),
						true,
						JSON.stringify(concurrentResults),
					);
					const recentEntries = () => {
						let manifest: SessionArtifactManifest | undefined;
						for (const entry of harness.ctx.sessionManager.getBranch()) {
							manifest = applyArtifactChanges(manifest, getBrowserRecord(entry)?.event.artifacts);
						}
						return manifest?.entries ?? [];
					};
					const ownReceipts =
						readRecord(concurrentResults[1].details?.artifactManifest).entries ?? [];
					assert.deepEqual(
						new Set(
							readArray(ownReceipts)
								.map(readRecord)
								.map((entry) => entry.absolutePath ?? entry.path),
						),
						new Set([fastPath]),
					);
					const aggregateEntries = recentEntries();
					assert.deepEqual(
						new Set(aggregateEntries.map((entry) => entry.absolutePath ?? entry.path)),
						new Set([slowPath, fastPath]),
					);

					const persistedBranch = harness.ctx.sessionManager.getBranch().slice();
					harness.setBranch([]);
					await runExtensionEvent(
						harness.handlers,
						"session_tree",
						{ newLeafId: null, oldLeafId: "artifact-branch" },
						harness.ctx,
					);
					harness.setBranch(persistedBranch);
					await runExtensionEvent(
						harness.handlers,
						"session_tree",
						{ newLeafId: "artifact-branch", oldLeafId: null },
						harness.ctx,
					);
					const restored = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "restored", "get", "title"],
					});
					assert.ok(restored.details);
					assert.equal(
						restored.details.artifactManifest,
						undefined,
						"ordinary reads do not repeat prior receipts",
					);
					const restoredEntries = recentEntries();
					assert.deepEqual(
						new Set(restoredEntries.map((entry) => entry.absolutePath ?? entry.path)),
						new Set([slowPath, fastPath]),
					);

					const finalScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", "final", "screenshot", finalPath],
					});
					assert.equal(finalScreenshot.isError, false, JSON.stringify(finalScreenshot));
					const entries = recentEntries();
					const retainedPaths = new Set(entries.map((entry) => entry.absolutePath ?? entry.path));
					assert.equal(retainedPaths.size, 2);
					assert.equal(retainedPaths.has(finalPath), true);
					assert.equal(retainedPaths.has(slowPath) || retainedPaths.has(fastPath), true);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rejects an externally replaced restore-disabled daemon",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-disabled-restore-restart-"));
		initializeGitProject(tempDir);
		const statePath = join(tempDir, "daemon-state.json");
		const mainLogPath = join(tempDir, "main.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
let state = { active: false, restoreKey: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: state.active ? { restoreKey: state.restoreKey } : null } }));
} else {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, JSON.stringify({ args, restore: process.env.AGENT_BROWSER_RESTORE ?? "disabled" }) + "\\n");
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ active: true, restoreKey: process.env.AGENT_BROWSER_RESTORE ?? null }));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "safe", url: "https://example.com/safe" } }));
}`,
		);
		try {
			await withPatchedEnv(
				{
					HOME: tempDir,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const initial = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--proxy", "http://127.0.0.1:8080", "open", "https://example.com/safe"],
						sessionMode: "fresh",
					});
					assert.ok(initial.details);
					assert.equal(initial.isError, false, JSON.stringify(initial));
					assert.equal(initial.details.managedSessionRestoreDisabled, true);
					const initialInvocations = await readInvocationLog(mainLogPath);
					assert.deepEqual(
						initialInvocations.map((entry) => entry.args.slice(-2)),
						[
							["open", "https://example.com/safe"],
							["tab", "list"],
						],
					);
					assert.deepEqual(
						initialInvocations.map((entry) => readRecord(entry).restore),
						["disabled", "disabled"],
					);
					await writeFile(
						statePath,
						JSON.stringify({ active: true, restoreKey: `piab-r2-${"c".repeat(32)}` }),
					);

					const restarted = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.ok(restarted.details);
					assert.equal(restarted.isError, true, JSON.stringify(restarted));
					assert.match(
						readString(restarted.details.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);
					const retried = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.ok(retried.details);
					assert.equal(retried.isError, true, JSON.stringify(retried));
					assert.match(
						readString(retried.details.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);
					assert.deepEqual(await readInvocationLog(mainLogPath), initialInvocations);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rejects an unproven restore-disabled daemon",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-unproven-disabled-daemon-"));
		initializeGitProject(tempDir);
		const statePath = join(tempDir, "daemon-state.json");
		const mainLogPath = join(tempDir, "main.log");
		const basePath = process.env.PATH ?? "";
		await writeFile(statePath, JSON.stringify({ active: true, restoreKey: null }));
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: state.active, runtime: { restoreKey: state.restoreKey } } }));
} else {
  fs.appendFileSync(${JSON.stringify(mainLogPath)}, "spawned\\n");
  process.stdout.write(JSON.stringify({ success: true, data: { title: "unsafe" } }));
}`,
		);
		try {
			await withPatchedEnv(
				{
					HOME: tempDir,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--proxy", "http://127.0.0.1:8080", "open", "https://example.com/unsafe"],
						sessionMode: "fresh",
					});
					assert.ok(result.details);
					assert.equal(result.isError, true, JSON.stringify(result));
					assert.match(
						readString(result.details.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);
					await assert.rejects(() => readFile(mainLogPath, "utf8"), /ENOENT/);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension blocks a prior checkout generation daemon after path reuse",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-path-reuse-"));
		initializeGitProject(tempDir);
		const statePath = join(tempDir, "daemon-state.json");
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
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
}`,
		);
		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
					HOME: tempDir,
					USERPROFILE: tempDir,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const first = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(first.handlers, "session_start", { reason: "new" }, first.ctx);
					const opened = await executeRegisteredTool(first.tool, first.ctx, {
						args: ["open", "https://example.com"],
						sessionMode: "fresh",
					});
					assert.ok(opened.details);
					assert.equal(opened.isError, false, JSON.stringify(opened));
					const priorKey = readString(
						readRecord(JSON.parse(await readFile(statePath, "utf8"))).restoreKey,
					);
					const managedSessionName = readString(opened.details.sessionName);

					await rm(join(tempDir, ".git"), { force: true, recursive: true });
					const sameInstanceBlocked = await executeRegisteredTool(first.tool, first.ctx, {
						args: ["open", "https://example.com"],
					});
					assert.ok(sameInstanceBlocked.details);
					assert.equal(sameInstanceBlocked.isError, true);
					assert.match(
						readString(sameInstanceBlocked.details.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);

					const resumedWithoutGit = createExtensionHarness({
						cwd: tempDir,
						branch: first.ctx.sessionManager.getBranch().slice(),
					});
					await runExtensionEvent(
						resumedWithoutGit.handlers,
						"session_start",
						{ reason: "new" },
						resumedWithoutGit.ctx,
					);
					const resumedWithoutGitBlocked = await executeRegisteredTool(
						resumedWithoutGit.tool,
						resumedWithoutGit.ctx,
						{ args: ["open", "https://example.com"] },
					);
					assert.ok(resumedWithoutGitBlocked.details);
					assert.equal(resumedWithoutGitBlocked.isError, true);
					assert.match(
						readString(resumedWithoutGitBlocked.details.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);

					initializeGitProject(tempDir);
					assert.notEqual(createManagedSessionRestoreKey(tempDir), priorKey);
					const sameInstanceReplacementBlocked = await executeRegisteredTool(
						first.tool,
						first.ctx,
						{ args: ["open", "https://example.com"] },
					);
					assert.ok(sameInstanceReplacementBlocked.details);
					assert.equal(
						sameInstanceReplacementBlocked.isError,
						true,
						JSON.stringify(sameInstanceReplacementBlocked),
					);
					assert.match(
						readString(sameInstanceReplacementBlocked.details.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);

					const replacementHarness = createExtensionHarness({
						cwd: tempDir,
						branch: first.ctx.sessionManager.getBranch().slice(),
					});
					await runExtensionEvent(
						replacementHarness.handlers,
						"session_start",
						{ reason: "new" },
						replacementHarness.ctx,
					);
					const replacementBlocked = await executeRegisteredTool(
						replacementHarness.tool,
						replacementHarness.ctx,
						{ args: ["open", "https://example.com"] },
					);
					assert.ok(replacementBlocked.details);
					assert.equal(replacementBlocked.isError, true);
					assert.match(
						readString(replacementBlocked.details.validationError ?? ""),
						/does not match the requested managed-restore policy/,
					);
					assert.equal(
						(await readInvocationLog(logPath)).filter((entry) => entry.args.includes("open"))
							.length,
						1,
					);

					const attackerConfigPath = join(tempDir, "attacker-agent-browser.json");
					await writeFile(attackerConfigPath, JSON.stringify({ restore: "attacker-key" }));
					const closed = await executeRegisteredTool(first.tool, first.ctx, {
						args: [
							"--session",
							managedSessionName,
							"--config",
							attackerConfigPath,
							"--restore",
							"attacker-key",
							"close",
						],
					});
					assert.equal(closed.isError, false, JSON.stringify(closed));
					await runExtensionEvent(
						first.handlers,
						"session_shutdown",
						{ reason: "quit" },
						first.ctx,
					);
					const closeInvocation = (await readInvocationLog(logPath)).find((entry) =>
						entry.args.includes("close"),
					);
					assert.ok(closeInvocation);
					assert.deepEqual(closeInvocation.args, [
						"--json",
						"--session",
						managedSessionName,
						"--config",
						attackerConfigPath,
						"--restore",
						"attacker-key",
						"close",
					]);
					assert.equal(readRecord(closeInvocation).restore, undefined);
					const sessions = join(tempDir, ".agent-browser", "sessions");
					const ownershipDirectoryName = (await readdir(sessions)).find(
						(name) => name === `.pi-agent-browser-owned-snapshots-v2-${priorKey}`,
					);
					assert.ok(ownershipDirectoryName !== undefined);
					const ownershipRecords = (await readdir(join(sessions, ownershipDirectoryName))).filter(
						(name) => name.endsWith(".json"),
					);
					assert.equal(ownershipRecords.length, 1);
					assert.match(
						await readFile(join(sessions, ownershipDirectoryName, ownershipRecords[0]), "utf8"),
						new RegExp(`${priorKey}-`),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension blocks incompatible reuse when an explicit restore key remains active",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-restore-reuse-"));
		initializeGitProject(tempDir);
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "daemon-state.json");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
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
}`,
		);
		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
					HOME: tempDir,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
						sessionMode: "fresh",
						args: ["--restore", "caller-key", "open", "https://example.com"],
					});
					assert.ok(opened.details);
					assert.equal(opened.isError, false, JSON.stringify(opened));
					assert.equal(opened.details.managedSessionRestoreDisabled, true);
					const sessionName = readString(opened.details.sessionName ?? "");
					const mainOpenCount = (await readInvocationLog(logPath)).filter((entry) =>
						entry.args.includes("open"),
					).length;

					const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", sessionName, "--auto-connect", "open", "https://example.com"],
					});
					assert.ok(blocked.details);
					assert.equal(blocked.isError, true);
					assert.match(readString(blocked.details.validationError ?? ""), /launch-scoped flags/);
					assert.equal(
						(await readInvocationLog(logPath)).filter((entry) => entry.args.includes("open"))
							.length,
						mainOpenCount,
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

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
	test(
		`agentBrowserExtension reuses restore-disabled managed sessions with ${testCase.name}`,
		{ concurrency: false },
		async () => {
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
				await withPatchedEnv(
					{
						AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
						// Clear case aliases before applying the selected uppercase value on Windows.
						all_proxy: undefined,
						http_proxy: undefined,
						https_proxy: undefined,
						ALL_PROXY: undefined,
						HTTP_PROXY: undefined,
						HTTPS_PROXY: undefined,
						PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
						PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
						...testCase.env,
						HOME: tempDir,
						PATH: `${tempDir}:${basePath}`,
					},
					async () => {
						const harness = createExtensionHarness({ cwd: tempDir });
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["open", "https://example.com/"],
							sessionMode: "fresh",
						});
						assert.ok(opened.details);
						assert.equal(opened.isError, false, JSON.stringify(opened));
						assert.equal(opened.details.managedSessionRestoreDisabled, true);
						const sessionName = opened.details.sessionName;
						const branch = harness.ctx.sessionManager.getBranch().slice();
						harness.setBranch(branch);
						await runExtensionEvent(
							harness.handlers,
							"session_tree",
							{ newLeafId: "restore-disabled", oldLeafId: null },
							harness.ctx,
						);

						const followedUp = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["get", "url"],
						});
						assert.ok(followedUp.details);
						assert.equal(followedUp.isError, false, JSON.stringify(followedUp));
						assert.equal(followedUp.details.sessionName, sessionName);
						assert.equal(followedUp.details.managedSessionRestoreDisabled, true);
						const invocations = await readInvocationLog(logPath);
						assert.ok(invocations.length >= 2);
						assert.equal(
							readRecord(invocations.at(-1)).restore,
							"AGENT_BROWSER_RESTORE" in testCase.env
								? testCase.env.AGENT_BROWSER_RESTORE
								: undefined,
						);

						if (testCase.name === "documented restore opt-out") {
							const resumed = createExtensionHarness({ cwd: tempDir });
							resumed.setBranch(branch);
							await runExtensionEvent(
								resumed.handlers,
								"session_start",
								{ reason: "resume" },
								resumed.ctx,
							);
							const blockedAfterReload = await executeRegisteredTool(resumed.tool, resumed.ctx, {
								args: ["get", "url"],
							});
							// The registered restore-opt-out fixture runs these reload and idle-restart assertions.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(blockedAfterReload.details);
							// The registered restore-opt-out fixture runs these reload and idle-restart assertions.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(blockedAfterReload.isError, true, JSON.stringify(blockedAfterReload));
							// The registered restore-opt-out fixture runs these reload and idle-restart assertions.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(
								readString(blockedAfterReload.details.validationError ?? ""),
								/does not match the requested managed-restore policy/,
							);

							await writeFile(daemonStatePath, JSON.stringify({ active: false, restoreKey: null }));
							const restartedAfterIdle = await executeRegisteredTool(resumed.tool, resumed.ctx, {
								electron: { action: "probe" },
							});
							// The registered restore-opt-out fixture runs these reload and idle-restart assertions.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(restartedAfterIdle.isError, false, JSON.stringify(restartedAfterIdle));
							const reusedAfterIdleRestart = await executeRegisteredTool(
								resumed.tool,
								resumed.ctx,
								{ args: ["get", "url"] },
							);
							// The registered restore-opt-out fixture runs these reload and idle-restart assertions.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(reusedAfterIdleRestart.details);
							// The registered restore-opt-out fixture runs these reload and idle-restart assertions.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								reusedAfterIdleRestart.isError,
								false,
								JSON.stringify(reusedAfterIdleRestart),
							);
							// The registered restore-opt-out fixture runs these reload and idle-restart assertions.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(reusedAfterIdleRestart.details.managedSessionRestoreDisabled, true);
						}
					},
				);
			} finally {
				await rm(tempDir, { force: true, recursive: true });
			}
		},
	);
}

test(
	"agentBrowserExtension does not sticky-disable restore when a suppressed spawn fails",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-restore-spawn-failure-"));
		initializeGitProject(tempDir);
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		try {
			await withPatchedEnv(
				{
					all_proxy: undefined,
					http_proxy: undefined,
					https_proxy: undefined,
					ALL_PROXY: undefined,
					HTTP_PROXY: undefined,
					HTTPS_PROXY: "http://127.0.0.1:8080",
					AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
					USERPROFILE: tempDir,
					PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
					HOME: tempDir,
					PATH: "",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const failed = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com/"],
						sessionMode: "fresh",
					});
					assert.ok(failed.details);
					assert.equal(failed.isError, true);
					assert.notEqual(failed.details.managedSessionRestoreDisabled, true);

					delete process.env.HTTPS_PROXY;
					process.env.PATH = `${tempDir}${delimiter}${basePath}`;
					await writeFakeAgentBrowserBinary(
						tempDir,
						`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), restore: process.env.AGENT_BROWSER_RESTORE }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com/" } }));`,
					);

					const retried = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com/"],
					});
					assert.ok(retried.details);
					assert.equal(retried.isError, false, JSON.stringify(retried));
					assert.notEqual(retried.details.managedSessionRestoreDisabled, true);
					const [invocation] = await readInvocationLog(logPath);
					assert.equal(
						readRecord(invocation).restore,
						createManagedSessionRestoreKey(
							tempDir,
							getManagedSessionRestoreScope(readString(retried.details.sessionName)),
						),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension exposes killed CLI diagnostics without leaking stderr secrets",
	{ concurrency: false, skip: process.platform === "win32" },
	async (t) => {
		for (const { name, script, exitSignal } of [
			{
				name: "signal without output",
				script: "process.kill(process.pid, 'SIGKILL');",
				exitSignal: "SIGKILL",
			},
			{
				name: "launcher exit 137 without output",
				script: "process.exit(137);",
				exitSignal: undefined,
			},
			{
				name: "signal with secret stderr",
				script:
					"process.stderr.write('Authorization: Bearer browser-failure-secret\\n', () => process.kill(process.pid, 'SIGKILL'));",
				exitSignal: "SIGKILL",
			},
		]) {
			// Each child fixture owns its PATH and lifecycle until completion.
			// oxlint-disable-next-line no-await-in-loop
			await t.test(name, async () => {
				const tempDir = await mkdtemp(join(tmpdir(), "pi-browser-signal-"));
				try {
					await writeFakeAgentBrowserBinary(tempDir, script);
					await withPatchedEnv(
						{ PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}` },
						async () => {
							const harness = createExtensionHarness({ cwd: tempDir });
							await runExtensionEvent(
								harness.handlers,
								"session_start",
								{ reason: "new" },
								harness.ctx,
							);
							const result = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["open", "https://fixture.test/"],
							});
							assert.equal(result.isError, true);
							assert.equal(result.details?.exitCode, 137);
							assert.equal(result.details?.exitSignal, exitSignal);
							assert.equal(result.details?.failureCategory, "upstream-error");
							assert.match(JSON.stringify(result), /OOM kill/);
							assert.match(JSON.stringify(result), /no JSON output/);
							assert.doesNotMatch(JSON.stringify(result), /browser-failure-secret/);
						},
					);
				} finally {
					await rm(tempDir, { recursive: true, force: true });
				}
			});
		}
	},
);

const MISSING_SUCCESS_PARSE_ERROR =
	"agent-browser returned an invalid JSON envelope: missing boolean success field.";

test(
	"agentBrowserExtension rejects malformed JSON envelopes that omit success",
	{ concurrency: false },
	async () => {
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
				assert.ok(result.details);

				assert.equal(result.isError, true);
				assert.equal(result.content[0]?.type, "text");
				assert.equal(
					readString(readRecord(result.content[0]).text).split("\n")[0],
					MISSING_SUCCESS_PARSE_ERROR,
				);
				assert.match(
					readString(readRecord(result.content[0]).text),
					/"failureCategory":"parse-failure"/,
				);
				assert.equal(result.details.parseError, MISSING_SUCCESS_PARSE_ERROR);
				assert.equal(result.details.summary, MISSING_SUCCESS_PARSE_ERROR);
				assert.doesNotMatch(readString(result.details.summary), /^open completed$/i);
				assert.equal(result.details.error, MISSING_SUCCESS_PARSE_ERROR);
				assert.equal(result.details.resultCategory, "failure");
				assert.equal(result.details.failureCategory, "parse-failure");
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension forwards long waits and extends the subprocess watchdog from explicit wait timeouts",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-wait-timeout-"));
		const logPath = join(tempDir, "invocations.log");
		const releasePath = join(tempDir, "release");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
const watcher = fs.watch(${JSON.stringify(tempDir)}, () => {
  if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
  watcher.close();
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
});
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), stdin, defaultTimeout: process.env.AGENT_BROWSER_DEFAULT_TIMEOUT }) + "\\n");`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/",
					PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "50",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const batchWaitStdin = JSON.stringify([
						["wait", "--text", "42", "--timeout", "1000"],
						["wait", "1000"],
					]);
					const cases = [
						{ params: { args: ["wait", "31000"] }, elapsed: 100 },
						{
							params: { args: ["wait", "--download", "/tmp/export.csv", "--timeout", "30000"] },
							elapsed: 100,
						},
						{ params: { args: ["batch"], stdin: batchWaitStdin }, elapsed: 6500 },
					];
					const realSetTimeout = setTimeout;
					for (const [index, { params, elapsed }] of cases.entries()) {
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						await rm(releasePath, { force: true });
						const controller = new AbortController();
						t.mock.timers.enable({ apis: ["setTimeout"] });
						const pending = executeRegisteredTool(
							harness.tool,
							harness.ctx,
							params,
							controller.signal,
						);
						try {
							// Preflight and native process startup use real I/O. Advance the
							// watchdog only once the requested command is running and held.
							const deadline = Date.now() + 5000;
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							while ((await readInvocationLog(logPath)).length <= index) {
								// This polling guard fails stalled startup; an already-started child needs no polling iteration.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(Date.now() < deadline, "controlled wait child must start");
								// Fixture transitions and their assertions run in order against this test's shared state.
								// oxlint-disable-next-line no-await-in-loop
								await new Promise((resolveDelay) => {
									realSetTimeout(resolveDelay, 5);
								});
							}
							t.mock.timers.tick(elapsed);
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							await writeFile(releasePath, "release");
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							const result = await pending;
							// All three literal wait plans check success after their controlled watchdog advancement.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(result.isError, false, JSON.stringify(result));
							// All three literal wait plans check success after their controlled watchdog advancement.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(result.details?.resultCategory, "success");
						} finally {
							t.mock.timers.reset();
							controller.abort();
							// Fixture transitions and their assertions run in order against this test's shared state.
							// oxlint-disable-next-line no-await-in-loop
							await Promise.allSettled([pending]);
						}
					}
					const invocations = await readInvocationLog(logPath);
					assert.deepEqual(
						invocations.map((entry) => entry.args.slice(-4)),
						[
							["--session", invocations[0].args[2], "wait", "31000"],
							["--download", "/tmp/export.csv", "--timeout", "30000"],
							["--json", "--session", invocations[2].args[2], "batch"],
						],
					);
					assert.equal(invocations[2].stdin, batchWaitStdin);
					assert.deepEqual(
						invocations.map((entry) => entry.defaultTimeout),
						["25000", "25000", "25000"],
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension warns when eval stdin returns an empty object from a function-shaped snippet",
	{ concurrency: false },
	async () => {
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
				assert.ok(functionResult.details);
				assert.equal(functionResult.isError, false);
				assert.match(readString(readRecord(functionResult.content[0]).text), /Eval stdin hint:/);
				assert.match(
					readString(readRecord(functionResult.content[0]).text),
					/\(\{ title: document\.title \}\)/,
				);
				assert.deepEqual(functionResult.details.evalStdinHint, {
					reason:
						"eval --stdin received a function-shaped snippet and the upstream JSON result was an empty object, which often means the function itself was returned or serialized instead of invoked.",
					suggestion:
						"Pass a plain expression such as `({ title: document.title })`, or invoke the function explicitly, for example `(() => ({ title: document.title }))()`.",
				});

				const jsonFunctionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--json", "eval", "--stdin"],
					stdin: "() => ({ title: document.title })",
				});
				assert.ok(jsonFunctionResult.details);
				assert.equal(jsonFunctionResult.isError, false);
				const jsonFunctionText = readRecord(jsonFunctionResult.content[0]).text;
				assert.doesNotMatch(readString(jsonFunctionText), /Eval stdin hint:/);
				const jsonFunctionObservation = readRecord(JSON.parse(readString(jsonFunctionText)));
				assert.deepEqual(jsonFunctionObservation.data, {
					origin: "https://example.com/",
					result: {},
				});
				assert.equal(jsonFunctionObservation.success, true);
				assert.equal(jsonFunctionObservation.resultCategory, "success");
				assert.deepEqual(
					jsonFunctionObservation.evalStdinHint,
					functionResult.details.evalStdinHint,
				);
				assert.deepEqual(
					jsonFunctionObservation.nextActions,
					jsonFunctionResult.details.nextActions,
				);
				assert.deepEqual(
					jsonFunctionResult.details.evalStdinHint,
					functionResult.details.evalStdinHint,
				);

				const emptyArrayIifeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["eval", "--stdin"],
					stdin: "(() => [])()",
				});
				assert.ok(emptyArrayIifeResult.details);
				assert.equal(emptyArrayIifeResult.isError, false);
				assert.doesNotMatch(
					readString(readRecord(emptyArrayIifeResult.content[0]).text),
					/Eval stdin hint:/,
				);
				assert.equal(emptyArrayIifeResult.details.evalStdinHint, undefined);

				const nonEmptyArrayIifeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["eval", "--stdin"],
					stdin: "(() => [1])()",
				});
				assert.ok(nonEmptyArrayIifeResult.details);
				assert.equal(nonEmptyArrayIifeResult.isError, false);
				assert.doesNotMatch(
					readString(readRecord(nonEmptyArrayIifeResult.content[0]).text),
					/Eval stdin hint:/,
				);
				assert.equal(nonEmptyArrayIifeResult.details.evalStdinHint, undefined);

				const expressionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["eval", "--stdin"],
					stdin: "({ title: document.title })",
				});
				assert.ok(expressionResult.details);
				assert.equal(expressionResult.isError, false);
				assert.doesNotMatch(
					readString(readRecord(expressionResult.content[0]).text),
					/Eval stdin hint:/,
				);
				assert.equal(expressionResult.details.evalStdinHint, undefined);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension normalizes eval --stdin scripts misplaced in args",
	{ concurrency: false },
	async () => {
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
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.invalid/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["eval", "--stdin", "document.title"],
					});
					assert.ok(result.details);

					assert.equal(result.isError, false);
					assert.equal(
						readString(readRecord(result.content[0]).text).split("\n")[0],
						"Fixture Title",
					);
					const [invocation] = await readInvocationLog(logPath);
					assert.deepEqual(invocation.args.slice(-2), ["eval", "--stdin"]);
					assert.equal(invocation.stdin, "document.title");
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

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
			const openResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "file:///tmp/fixture.html"],
			});
			assert.ok(openResult.details);
			assert.equal(openResult.isError, false);
			assert.equal(readRecord(openResult.details.sessionTabTarget).url, "file:///tmp/fixture.html");

			const nullEvalResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "document.getElementById('missing')?.textContent",
			});
			assert.equal(nullEvalResult.isError, false, JSON.stringify(nullEvalResult));
			assert.equal(
				(await readInvocationLog(logPath)).some((entry) => entry.args.includes("eval")),
				true,
			);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test(
	"agentBrowserExtension retains and closes a fresh daemon when its first non-batch command fails",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-failed-fresh-daemon-"));
		initializeGitProject(tempDir);
		const statePath = join(tempDir, "daemon-state.json");
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
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
}`,
		);
		try {
			await withPatchedEnv(
				{
					HOME: tempDir,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const failed = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["click", "#missing"],
						sessionMode: "fresh",
					});
					assert.ok(failed.details);
					assert.equal(failed.isError, true);
					const outcome = readRecord(failed.details.managedSessionOutcome);
					assert.equal(
						outcome.status,
						"created",
						JSON.stringify({ failed, invocations: await readInvocationLog(logPath) }),
					);
					assert.equal(outcome.activeAfter, true);
					assert.equal(outcome.succeeded, false);
					assert.ok(
						typeof outcome.currentSessionName === "string" && outcome.currentSessionName.length > 0,
					);
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						harness.ctx,
					);
					const invocations = await readInvocationLog(logPath);
					assert.ok(
						invocations.some(
							(entry) =>
								entry.args.includes("close") &&
								entry.args.includes(readString(outcome.currentSessionName)),
						),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports managed-session outcomes after failed fresh launches",
	{ concurrency: false },
	async (context) => {
		const shortTempRoot = dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab"));
		const tempDir = await mkdtemp(join(shortTempRoot, "a-"));
		const socketDir = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "p-"));
		context.after(async () => {
			await rm(socketDir, { force: true, recursive: true });
		});
		initializeGitProject(tempDir);
		const basePath = process.env.PATH ?? "";
		// Windows searches cwd even with an empty PATH: keep the fixture shim only on PATH.
		const binaryDir = join(tempDir, "bin");
		await mkdir(binaryDir);
		await writeFakeAgentBrowserBinary(
			binaryDir,
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
			await withPatchedEnv(
				{ PATH: `${binaryDir}${delimiter}${basePath}`, PI_AGENT_BROWSER_SOCKET_DIR: socketDir },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const firstResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--namespace", "previous", "open", "https://previous.test"],
						sessionMode: "fresh",
					});
					assert.ok(firstResult.details);
					assert.equal(firstResult.isError, false, JSON.stringify(firstResult));
					const previousSessionName = readString(firstResult.details.sessionName);
					assert.ok(previousSessionName.length > 0);

					const failedFreshResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--namespace", "next", "open", "https://fail.test"],
						sessionMode: "fresh",
					});
					assert.ok(failedFreshResult.details);
					assert.equal(failedFreshResult.isError, true);
					const preservedOutcome = readRecord(failedFreshResult.details.managedSessionOutcome);
					assert.equal(preservedOutcome.status, "preserved");
					assert.equal(preservedOutcome.activeBefore, true);
					assert.equal(preservedOutcome.activeAfter, true);
					assert.equal(preservedOutcome.currentSessionName, previousSessionName);
					assert.equal(preservedOutcome.currentSessionNamespace, "previous");
					assert.equal(preservedOutcome.previousSessionName, previousSessionName);
					assert.equal(preservedOutcome.sessionMode, "fresh");
					assert.match(readString(preservedOutcome.attemptedSessionName ?? ""), /-fresh-/);
					assert.equal(preservedOutcome.succeeded, false);
					assert.match(
						readString(readRecord(failedFreshResult.content[0]).text),
						/Managed session outcome: Fresh launch failed; your previous browser session is still active\./,
					);
					assert.match(readString(readRecord(failedFreshResult.content[0]).text), /Recovery:/);
					assert.match(
						readString(readRecord(failedFreshResult.content[0]).text),
						/details\.managedSessionOutcome/,
					);
					const preservedNextActions = readArray(failedFreshResult.details.nextActions).map(
						readRecord,
					);
					assert.ok(
						preservedNextActions.some((action) => action.id === "run-agent-browser-doctor"),
					);
					assert.ok(
						preservedNextActions.some(
							(action) =>
								action.id === "verify-current-managed-session" &&
								readArray(readRecord(action.params).args).map(readString).join(" ") ===
									`--namespace previous --session ${previousSessionName} get url`,
						),
					);

					await withPatchedEnv({ PATH: missingBinaryDir }, async () => {
						const missingBinaryResult = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--namespace", "next", "open", "https://missing-binary.test"],
							sessionMode: "fresh",
						});
						assert.ok(missingBinaryResult.details);
						assert.equal(missingBinaryResult.isError, true);
						assert.equal(
							missingBinaryResult.details.failureCategory,
							"missing-binary",
							JSON.stringify(missingBinaryResult),
						);
						assert.equal(missingBinaryResult.details.agentBrowserStarted, false);
						const missingBinaryOutcome = readRecord(
							missingBinaryResult.details.managedSessionOutcome,
						);
						assert.equal(missingBinaryOutcome.status, "preserved");
						assert.equal(missingBinaryOutcome.activeBefore, true);
						assert.equal(missingBinaryOutcome.activeAfter, true);
						assert.equal(missingBinaryOutcome.currentSessionName, previousSessionName);
						assert.equal(missingBinaryOutcome.currentSessionNamespace, "previous");
						assert.equal(missingBinaryOutcome.previousSessionName, previousSessionName);
						assert.equal(missingBinaryOutcome.sessionMode, "fresh");
						assert.match(
							readString(readRecord(missingBinaryResult.content[0]).text),
							/Managed session outcome: Fresh launch failed; your previous browser session is still active\./,
						);
						const missingBinaryNextActions = readArray(missingBinaryResult.details.nextActions).map(
							readRecord,
						);
						assert.ok(
							missingBinaryNextActions.some((action) => action.id === "run-agent-browser-doctor"),
						);
						assert.ok(
							missingBinaryNextActions.some(
								(action) =>
									action.id === "verify-current-managed-session" &&
									readArray(readRecord(action.params).args).map(readString).join(" ") ===
										`--namespace previous --session ${previousSessionName} get url`,
							),
						);

						const abandonedMissingBinaryHarness = createExtensionHarness({ cwd: tempDir });
						await runExtensionEvent(
							abandonedMissingBinaryHarness.handlers,
							"session_start",
							{ reason: "new" },
							abandonedMissingBinaryHarness.ctx,
						);
						const abandonedMissingBinary = await executeRegisteredTool(
							abandonedMissingBinaryHarness.tool,
							abandonedMissingBinaryHarness.ctx,
							{
								args: ["--namespace", "next", "open", "https://missing-binary.test"],
								sessionMode: "fresh",
							},
						);
						assert.ok(abandonedMissingBinary.details);
						assert.equal(abandonedMissingBinary.isError, true);
						assert.equal(abandonedMissingBinary.details.managedSessionRestoreDisabled, undefined);
						const abandonedMissingBinaryNextActions = readArray(
							abandonedMissingBinary.details.nextActions,
						).map(readRecord);
						assert.ok(
							abandonedMissingBinaryNextActions.some(
								(action) =>
									action.id === "retry-fresh-managed-session" &&
									readArray(readRecord(action.params).args).map(readString).join(" ") ===
										"--namespace next open about:blank",
							),
						);
					});

					const followupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "url"],
					});
					assert.ok(followupResult.details);
					assert.equal(followupResult.isError, false);
					assert.equal(followupResult.details.sessionName, previousSessionName);

					const abandonedHarness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						abandonedHarness.handlers,
						"session_start",
						{ reason: "new" },
						abandonedHarness.ctx,
					);
					const abandonedResult = await executeRegisteredTool(
						abandonedHarness.tool,
						abandonedHarness.ctx,
						{ args: ["open", "https://fail.test"], sessionMode: "fresh" },
					);
					assert.ok(abandonedResult.details);
					assert.equal(abandonedResult.isError, true);
					const abandonedOutcome = readRecord(abandonedResult.details.managedSessionOutcome);
					assert.equal(abandonedOutcome.status, "abandoned");
					assert.equal(abandonedOutcome.activeBefore, false);
					assert.equal(abandonedOutcome.activeAfter, false);
					assert.match(
						readString(readRecord(abandonedResult.content[0]).text),
						/no managed browser session is current/,
					);
					const abandonedNextActions = readArray(abandonedResult.details.nextActions).map(
						readRecord,
					);
					assert.ok(
						abandonedNextActions.some((action) => action.id === "retry-fresh-managed-session"),
					);

					const incompatibleFailure = await executeRegisteredTool(
						abandonedHarness.tool,
						abandonedHarness.ctx,
						{
							args: ["--profile", "Default", "open", "https://fail.test"],
							sessionMode: "fresh",
						},
					);
					assert.ok(incompatibleFailure.details);
					const incompatibleOutcome = readRecord(incompatibleFailure.details.managedSessionOutcome);
					assert.ok(
						typeof incompatibleOutcome.attemptedSessionName === "string" &&
							incompatibleOutcome.attemptedSessionName.length > 0,
					);
					assert.equal(
						incompatibleFailure.details.managedSessionRestoreDisabled,
						undefined,
						JSON.stringify(incompatibleFailure),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension writes eval and get output data to requested files",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-output-file-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const command = args.find((arg) => !arg.startsWith("-") && arg !== "piab-test");
if (args.includes("batch")) {
  const commands = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(commands.map((command) => ({
    command,
    success: true,
    result: command[0] === "cookies"
      ? { cookies: [{ domain: "example.com", name: "session", value: "raw-cookie-secret" }] }
      : { content: "Large batch documentation " + "x".repeat(9000) + " BATCH-END-SENTINEL Authorization: Bearer batch-secret", source: "raw" }
  }))));
} else if (args.includes("read")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    content: "Large documentation " + "x".repeat(9000) + " END-SENTINEL Authorization: Bearer read-secret",
    contentType: "text/markdown; charset=utf-8",
    finalUrl: "https://example.com/docs?SAMLRequest=saml-secret&state=oauth-secret",
    lifecycle: { effectiveLaunch: { browserLaunched: false }, launched: false, reused: false },
    source: "raw",
    status: 200,
    truncated: false,
    url: "https://example.com/docs?RelayState=relay-secret&nonce=nonce-secret"
  } }));
} else if (args.includes("eval")) {
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
				assert.ok(evalResult.details);
				assert.equal(evalResult.isError, false);
				assert.deepEqual(
					JSON.parse(await readFile(join(tempDir, "logs/eval-state.json"), "utf8")),
					{ result: { title: "Example", rows: [1, 2, 3] } },
				);
				assert.match(
					readString(readRecord(evalResult.content[0]).text),
					/Output file: logs\/eval-state\.json/,
				);
				assert.deepEqual(evalResult.details.outputFile, {
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
				assert.equal(
					await readFile(join(tempDir, "logs/terminal-state.final.txt"), "utf8"),
					JSON.stringify({ result: "visible terminal text" }, null, 2) + "\n",
				);
				assert.match(
					readString(readRecord(getResult.content[0]).text),
					/Output file: logs\/terminal-state\.final\.txt/,
				);

				const largeReadResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["read", "https://example.com/docs"],
					outputPath: "logs/full-read.json",
				});
				assert.ok(largeReadResult.details);
				assert.equal(largeReadResult.isError, false, JSON.stringify(largeReadResult));
				assert.equal(readRecord(largeReadResult.details.data).compacted, true);
				assert.equal(largeReadResult.details.agentBrowserStarted, true);
				assert.equal(largeReadResult.details.readSource, "raw");
				assert.deepEqual(largeReadResult.details.lifecycle, {
					effectiveLaunch: { browserLaunched: false },
				});
				assert.match(
					readString(readRecord(largeReadResult.content[0]).text),
					/Read execution: source raw; CLI started: yes; reported browserLaunched: false; managed session outcome: not managed\./,
				);
				assert.equal(largeReadResult.details.managedSessionOutcome, undefined);
				const fullReadText = await readFile(join(tempDir, "logs/full-read.json"), "utf8");
				const fullRead = readRecord(JSON.parse(fullReadText));
				assert.match(
					readString(fullRead.content),
					/END-SENTINEL Authorization: Bearer \[REDACTED\]$/,
				);
				assert.equal(fullRead.contentType, "text/markdown; charset=utf-8");
				assert.equal(fullRead.source, "raw");
				assert.equal(fullRead.status, 200);
				assert.equal(fullRead.truncated, false);
				assert.match(
					readString(fullRead.finalUrl),
					/SAMLRequest=%5BREDACTED%5D&state=%5BREDACTED%5D/,
				);
				assert.match(readString(fullRead.url), /RelayState=%5BREDACTED%5D&nonce=%5BREDACTED%5D/);
				assert.doesNotMatch(
					fullReadText,
					/read-secret|saml-secret|oauth-secret|relay-secret|nonce-secret|"compacted"/,
				);
				const fullReadPath = largeReadResult.details.fullOutputPath;
				assert.equal(typeof fullReadPath, "string");
				assert.equal(
					readArray(readRecord(largeReadResult.details.artifactManifest).entries)
						.map(readRecord)
						.some((entry) => entry.kind === "spill" && entry.path === fullReadPath),
					true,
				);
				assert.deepEqual(largeReadResult.details.outputFile, {
					absolutePath: join(tempDir, "logs/full-read.json"),
					bytes: Buffer.byteLength(fullReadText),
					path: "logs/full-read.json",
					source: "details.data",
					status: "saved",
				});

				const largeBatchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "--bail"],
					stdin: JSON.stringify([
						["cookies"],
						...Array.from({ length: 24 }, () => ["read", "https://example.com/docs"]),
					]),
					outputPath: "logs/full-batch.json",
				});
				assert.ok(largeBatchResult.details);
				assert.equal(largeBatchResult.isError, false, JSON.stringify(largeBatchResult));
				assert.equal(readRecord(largeBatchResult.details.data).compacted, true);
				const fullBatchText = await readFile(join(tempDir, "logs/full-batch.json"), "utf8");
				const fullBatch = readArray(JSON.parse(fullBatchText)).map(readRecord);
				assert.equal(
					readArray(readRecord(fullBatch[0]?.result).cookies).map(readRecord)[0].value,
					"[REDACTED]",
				);
				assert.match(
					readString(readRecord(fullBatch.at(-1)?.result).content),
					/BATCH-END-SENTINEL Authorization: Bearer \[REDACTED\]$/,
				);
				assert.doesNotMatch(fullBatchText, /raw-cookie-secret|batch-secret|"compacted"/);

				const jsonResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["stream", "status", "--json"],
					outputPath: "logs/stream-status.json",
				});
				assert.equal(jsonResult.isError, false);
				const jsonText = readString(readRecord(jsonResult.content[0]).text);
				assert.doesNotMatch(jsonText, /Output file:/);
				assert.doesNotThrow(() => readRecord(JSON.parse(jsonText)));
				const savedJsonText = await readFile(join(tempDir, "logs/stream-status.json"), "utf8");
				assert.doesNotThrow(() => readRecord(JSON.parse(savedJsonText)));

				const screenshotPath = join(tempDir, "captures/same-path.png");
				const collidingOutput = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["screenshot", screenshotPath],
					outputPath: screenshotPath,
				});
				assert.ok(collidingOutput.details);
				assert.equal(collidingOutput.isError, true);
				assert.equal(collidingOutput.details.resultCategory, "failure");
				assert.equal(collidingOutput.details.failureCategory, "validation-error");
				assert.equal(collidingOutput.details.outputFile, undefined);
				assert.equal(collidingOutput.details.artifacts, undefined);
				assert.match(
					readString(readRecord(collidingOutput.content[0]).text),
					/outputPath.*same destination as artifact path/i,
				);
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
					// Hardlink collision is checked on supported hosts; all platforms check direct path collision.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(hardlinkedOutput.isError, true);
					// Hardlink collision is checked on supported hosts; all platforms check direct path collision.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(hardlinkedOutput.content[0]).text),
						/outputPath.*same destination as artifact path/i,
					);
					// Hardlink collision is checked on supported hosts; all platforms check direct path collision.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(await readFile(hardlinkedScreenshotPath, "utf8"), "seed");
				}

				const titleCalls = async () =>
					(await readFile(logPath, "utf8"))
						.trim()
						.split("\n")
						.map((line) => readArray(JSON.parse(line)).map(readString))
						.filter((args) => args.slice(-2).join(" ") === "get title").length;
				const beforeProtectedOutput = await titleCalls();
				const protectedOutput = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "title"],
					outputPath: ".agent-browser/states/overwrite.json",
				});
				assert.equal(protectedOutput.isError, false, JSON.stringify(protectedOutput));
				assert.equal(await titleCalls(), beforeProtectedOutput + 1);
				assert.deepEqual(
					JSON.parse(await readFile(join(tempDir, ".agent-browser/states/overwrite.json"), "utf8")),
					{ result: "Example", title: "Example" },
				);

				await writeFile(join(tempDir, "blocked-output-parent"), "not a directory");
				const writeFailureResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["eval", "--stdin"],
					stdin: "() => ({ ok: true })",
					outputPath: "blocked-output-parent/result.json",
				});
				assert.ok(writeFailureResult.details);
				assert.equal(writeFailureResult.isError, true);
				assert.equal(writeFailureResult.details.resultCategory, "failure");
				assert.equal(writeFailureResult.details.failureCategory, "upstream-error");
				assert.equal(writeFailureResult.details.successCategory, undefined);
				assert.equal(readRecord(writeFailureResult.details.outputFile).status, "failed");

				const failedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "#fail"],
					outputPath: "logs/failed-action.txt",
				});
				assert.ok(failedResult.details);
				assert.equal(failedResult.isError, true);
				assert.equal(failedResult.details.outputFile, undefined);
				await assert.rejects(readFile(join(tempDir, "logs/failed-action.txt"), "utf8"));
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("applyAgentBrowserOutputPath refuses compact metadata without a live wrapper-managed spill", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-output-missing-spill-"));
	const arbitraryPath = join(tempDir, "arbitrary.json");
	const outputPath = join(tempDir, "result.json");
	try {
		await writeFile(arbitraryPath, '{"secret":"must-not-copy"}');
		const result = await applyAgentBrowserOutputPath({
			cwd: tempDir,
			outputPath,
			result: {
				content: [{ type: "text", text: "Large output compacted" }],
				details: {
					artifactManifest: {
						entries: [],
						evictedCount: 0,
						liveCount: 0,
						maxEntries: 10,
						updatedAtMs: Date.now(),
						version: 1,
					},
					data: { compacted: true },
					fullOutputPath: arbitraryPath,
					resultCategory: "success",
				},
				isError: false,
			},
		});
		assert.equal(result.isError, true);
		const details = readRecord(result.details);
		assert.equal(details.resultCategory, "failure");
		assert.match(readString(readRecord(details.outputFile).error), /wrapper-managed spill/);
		await assert.rejects(readFile(outputPath, "utf8"));
		assert.equal(await readFile(arbitraryPath, "utf8"), '{"secret":"must-not-copy"}');
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("applyAgentBrowserOutputPath rehydrates compacted batch rows from live wrapper spills", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-output-batch-spill-"));
	const spillPath = join(tempDir, "batch-spill.json");
	const outputPath = join(tempDir, "batch-output.json");
	const fullRead = {
		content: `Long documentation ${"x".repeat(9_000)} END-SENTINEL`,
		source: "raw",
	};
	const now = Date.now();
	try {
		await writeFile(spillPath, JSON.stringify(fullRead));
		const result = await applyAgentBrowserOutputPath({
			cwd: tempDir,
			outputPath,
			result: {
				content: [{ type: "text", text: "Batch output compacted" }],
				details: {
					artifactManifest: {
						entries: [
							{
								createdAtMs: now,
								kind: "spill",
								path: spillPath,
								retentionState: "live",
								storageScope: "process-temp",
							},
						],
						evictedCount: 0,
						liveCount: 1,
						maxEntries: 10,
						updatedAtMs: now,
						version: 1,
					},
					batchSteps: [{ fullOutputPath: spillPath }, {}],
					data: [
						{
							command: ["read", "https://example.test/docs"],
							result: { compacted: true, fullOutputPath: spillPath },
							success: true,
						},
						{ command: ["get", "title"], result: { title: "Docs" }, success: true },
					],
					resultCategory: "success",
				},
				isError: false,
			},
		});
		assert.equal(result.isError, false, JSON.stringify(result));
		const saved = readArray(JSON.parse(await readFile(outputPath, "utf8"))).map(readRecord);
		assert.deepEqual(saved[0]?.result, fullRead);
		assert.deepEqual(saved[1]?.result, { title: "Docs" });
		assert.doesNotMatch(await readFile(outputPath, "utf8"), /"compacted"/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("timeout observations do not prove planned steps ran", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "piab-timeout-evidence-"));
	const logPath = join(tempDir, "executed.log");
	await writeFile(join(tempDir, "receipt.png"), "old receipt");
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("batch")) {
  const steps = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(steps[0]) + "\\n");
  setInterval(() => {}, 60000);
} else if (args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://example.test/start" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Start" } }));
}`,
	);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			for (const lastStep of [
				["screenshot", "receipt.png"],
				["open", "https://example.test/start"],
			]) {
				// Fixture transitions and their assertions run in order against this test's shared state.
				// oxlint-disable-next-line no-await-in-loop
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "timeout-proof", "batch", "--bail"],
					stdin: JSON.stringify([
						["wait", "60000"],
						["fill", "#amount", "100"],
						["click", "#submit"],
						lastStep,
					]),
					timeoutMs: 2000,
				});
				// Both literal timeout endings check unknown steps rather than inferring completed work.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(result.details);
				// Both literal timeout endings check unknown steps rather than inferring completed work.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(result.isError, true);
				const progress = readRecord(result.details.timeoutPartialProgress);
				// Both literal timeout endings check unknown steps rather than inferring completed work.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(
					readArray(progress.steps)
						.map(readRecord)
						.map((step) => step.status),
					["unknown", "unknown", "unknown", "unknown"],
				);
				// Both literal timeout endings check unknown steps rather than inferring completed work.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(progress.retryStep, undefined);
				// Both literal timeout endings check unknown steps rather than inferring completed work.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(progress.openedButPostOpenTimedOut, undefined);
				if (lastStep[0] === "screenshot") {
					// The literal screenshot-ending case verifies its old receipt without claiming execution.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readArray(progress.artifacts).map(readRecord)[0].exists, true);
				}
				// Both literal timeout endings check unknown steps rather than inferring completed work.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(
					readArray(result.details.nextActions)
						.map(readRecord)
						.some((action) => action.id === "retry-timeout-step"),
					false,
				);
			}
			assert.deepEqual(
				(await readFile(logPath, "utf8"))
					.trim()
					.split("\n")
					.map((line) => readArray(JSON.parse(line))),
				[
					["wait", "60000"],
					["wait", "60000"],
				],
			);
			assert.equal(await readFile(join(tempDir, "receipt.png"), "utf8"), "old receipt");
		});
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test(
	"agentBrowserExtension reports partial progress and artifacts after native batch timeout",
	{ concurrency: false },
	async () => {
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
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "2000" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "--bail"],
						stdin: JSON.stringify([
							["open", "https://example.test"],
							["fill", "#search", "export"],
							["screenshot", "dogfood/secret-token/filled.png"],
							["wait", "--download", "dogfood/export.csv"],
							["wait", "500"],
						]),
					});
					assert.ok(result.details);

					assert.equal(result.isError, true);
					assert.equal(result.details.failureCategory, "timeout");
					assert.equal(result.details.timedOut, true);
					const timeoutProgress = readRecord(result.details.timeoutPartialProgress);
					assert.ok(
						readRecord(timeoutProgress.currentPage).url ===
							"https://example.test/secret-token/results?token=%5BREDACTED%5D" ||
							readRecord(timeoutProgress.currentPage).url === "https://example.test/",
						`unexpected timeout current page URL: ${readString(readRecord(timeoutProgress.currentPage).url ?? "")}`,
					);
					if (
						typeof readRecord(timeoutProgress.currentPage).title === "string" &&
						readString(readRecord(timeoutProgress.currentPage).title).length > 0
					) {
						// Title recovery is optional after timeout; URL/artifact checks and both display variants remain required.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(timeoutProgress.currentPage).title,
							"Results page export secret-token Authorization: Bearer [REDACTED]",
						);
					}
					assert.deepEqual(
						readArray(timeoutProgress.artifacts)
							.map(readRecord)
							.map((artifact) => ({
								exists: artifact.exists,
								path: artifact.path,
								state: artifact.state,
								stepIndex: artifact.stepIndex,
							})),
						[
							{
								exists: true,
								path: "dogfood/secret-token/filled.png",
								state: "verified",
								stepIndex: 3,
							},
							{ exists: false, path: "dogfood/export.csv", state: "missing", stepIndex: 4 },
						],
					);
					assert.deepEqual(
						readArray(timeoutProgress.steps)
							.map(readRecord)
							.map((step) => [readArray(step.args).map(readString)[0], step.status]),
						[
							["open", "unknown"],
							["fill", "unknown"],
							["screenshot", "unknown"],
							["wait", "unknown"],
							["wait", "unknown"],
						],
					);
					assert.equal(timeoutProgress.openedButPostOpenTimedOut, undefined);
					assert.equal(timeoutProgress.retryStep, undefined);
					const text = readRecord(result.content[0]).text;
					assert.match(readString(text), /Timeout partial progress:/);
					if (
						typeof readRecord(timeoutProgress.currentPage).title === "string" &&
						readString(readRecord(timeoutProgress.currentPage).title).length > 0
					) {
						// Both observed title-present/absent variants assert their corresponding visible page summary.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(
							readString(text),
							/Current page: \[REDACTED\] — https:\/\/example.test\/\[REDACTED\]\/results\?token=%5BREDACTED%5D/,
						);
					} else {
						// Both observed title-present/absent variants assert their corresponding visible page summary.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(readString(text), /Current page: https:\/\/example.test\//);
					}
					assert.match(
						readString(text),
						/Artifact from step 3: dogfood\/\[REDACTED\]\/filled\.png \(exists, 10 bytes\)/,
					);
					assert.doesNotMatch(readString(text), /url-secret|title-secret|secret-token/);
					assert.match(readString(text), /Step 2 \[unknown\]: fill #search export/);
					assert.match(
						readString(text),
						/Step 4 \[unknown\]: wait --download dogfood\/export\.csv/,
					);
					assert.doesNotMatch(readString(text), /Retry candidate|Retry failed step/);
					assert.match(readString(text), /Artifact from step 4: dogfood\/export\.csv \(missing\)/);
					assert.equal(
						readArray(result.details.nextActions)
							.map(readRecord)
							.some((action) => action.id === "retry-timeout-step"),
						false,
					);

					const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([
							["screenshot", "--full-page", "dogfood/option-full-page.png"],
							["wait", "--download", "dogfood/download.csv", "--timeout", "1000"],
						]),
					});
					assert.ok(batchResult.details);
					assert.equal(batchResult.isError, true);
					const batchProgress = readRecord(batchResult.details.timeoutPartialProgress);
					assert.deepEqual(
						readArray(batchProgress.artifacts)
							.map(readRecord)
							.map((artifact) => ({
								exists: artifact.exists,
								path: artifact.path,
								stepIndex: artifact.stepIndex,
							})),
						[
							{ exists: true, path: "dogfood/option-full-page.png", stepIndex: 1 },
							{ exists: false, path: "dogfood/download.csv", stepIndex: 2 },
						],
					);

					const waitNoPathResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([["wait", "--download", "--timeout", "1000"]]),
					});
					assert.ok(waitNoPathResult.details);
					assert.equal(waitNoPathResult.isError, true);
					const waitNoPathProgress = readRecord(waitNoPathResult.details.timeoutPartialProgress);
					assert.deepEqual(waitNoPathProgress.artifacts, []);

					const openBeforeMutatingTimeout = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.test"],
						timeoutMs: 10_000,
					});
					assert.equal(openBeforeMutatingTimeout.isError, false);
					const mutatingTimeoutResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "--bail"],
						stdin: JSON.stringify([
							["fill", "#search", "export"],
							["wait", "500"],
						]),
					});
					assert.ok(mutatingTimeoutResult.details);
					assert.equal(mutatingTimeoutResult.isError, true);
					const mutatingProgress = readRecord(mutatingTimeoutResult.details.timeoutPartialProgress);
					assert.equal(mutatingProgress.retryStep, undefined);
					const mutatingNextActions = readArray(mutatingTimeoutResult.details.nextActions).map(
						readRecord,
					);
					assert.equal(
						mutatingNextActions.some((action) => action.id === "retry-timeout-step"),
						false,
					);
					assert.deepEqual(
						readArray(
							readRecord(
								mutatingNextActions.find(
									(action) => action.id === "inspect-current-page-after-timeout",
								)?.params,
							).args,
						)
							.map(readString)
							.slice(-2),
						["snapshot", "-i"],
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"timeout recovery verifies an unknown page target before snapshotting",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-timeout-target-recovery-"));
		const failUrlPath = join(tempDir, "fail-url");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("batch")) {
  const steps = JSON.parse(fs.readFileSync(0, "utf8"));
  if (steps[0]?.[0] === "get" && steps[0]?.[1] === "url") {
    fs.rmSync(${JSON.stringify(failUrlPath)}, { force: true });
    process.stdout.write(JSON.stringify([
      { command: ["get", "url"], success: true, result: { result: "https://example.test/recovered", url: "https://example.test/recovered" } },
      { command: ["snapshot", "-i"], success: true, result: { origin: "https://example.test/recovered", refs: {}, snapshot: "- heading Recovered" } }
    ]));
  } else {
    fs.writeFileSync(${JSON.stringify(failUrlPath)}, "1");
    setInterval(() => {}, 60_000);
  }
} else if (args.includes("get") && args.includes("url")) {
  if (fs.existsSync(${JSON.stringify(failUrlPath)})) { process.stdout.write(JSON.stringify({ success: false, error: "page unavailable" })); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.test/start", url: "https://example.test/start" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Start", title: "Start" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Start", url: "https://example.test/start" } }));
}`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["open", "https://example.test/start"],
						})
					).isError,
					false,
				);
				const timedOut = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "--bail"],
					stdin: JSON.stringify([
						["open", "https://example.test/next"],
						["fill", "#search", "query"],
					]),
					timeoutMs: 1000,
				});
				assert.ok(timedOut.details);
				assert.equal(timedOut.isError, true);
				assert.equal(timedOut.details.timedOut, true);
				await access(failUrlPath);
				assert.equal(timedOut.details.sessionTabTargetUnknown, true);
				const actions = readArray(timedOut.details.nextActions).map(readRecord);
				assert.equal(
					actions.some(
						(action) =>
							readArray(readRecord(action.params).args).map(readString).slice(-2).join(" ") ===
							"snapshot -i",
					),
					false,
				);
				const recovery = actions.find((action) => action.id === "verify-page-target-after-timeout");
				assert.deepEqual(readArray(readRecord(recovery?.params).args).map(readString).slice(-2), [
					"batch",
					"--bail",
				]);
				assert.equal(
					readRecord(recovery?.params).stdin,
					JSON.stringify([
						["get", "url"],
						["snapshot", "-i"],
					]),
				);
				assert.doesNotMatch(timedOut.content[0]?.text ?? "", /Retry candidate/);
				assert.match(
					timedOut.content[0]?.text ?? "",
					/verify-page-target-after-timeout.*batch.*--bail.*get.*url.*snapshot.*-i/,
				);
				assert.ok(recovery?.params !== undefined);
				const recovered = await executeRegisteredTool(harness.tool, harness.ctx, recovery.params);
				assert.ok(recovered.details);
				assert.equal(recovered.isError, false, JSON.stringify(recovered));
				assert.equal(recovered.details.sessionTabTargetUnknown, undefined);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension retries fresh timed-out navigation in a new session when no live URL is recovered",
	{ concurrency: false },
	async () => {
		// Fresh-session names plus the namespace must fit Darwin's Unix socket limit.
		const tempDir = await mkdtemp(join(tmpdir(), "fr-"));
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
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "200" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "--bail"],
						stdin: JSON.stringify([["open", "https://example.test/fresh-timeout"]]),
						sessionMode: "fresh",
					});
					assert.ok(result.details);

					assert.equal(result.isError, true);
					const progress = readRecord(result.details.timeoutPartialProgress);
					assert.equal(
						readRecord(progress.currentPage).source,
						"planned",
						JSON.stringify(result.details),
					);
					assert.equal(progress.liveUrlRecovered, false);
					assert.deepEqual(readRecord(progress.retryStep).args, [
						"open",
						"https://example.test/fresh-timeout",
					]);
					const retryAction = readArray(result.details.nextActions)
						.map(readRecord)
						.find((action) => action.id === "retry-timeout-step");
					assert.deepEqual(retryAction?.params, {
						args: ["batch"],
						stdin: JSON.stringify([["open", "https://example.test/fresh-timeout"]]),
						sessionMode: "fresh",
					});
					const namespaced = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--namespace", "r", "batch"],
						stdin: JSON.stringify([["open", "https://example.test/fresh-timeout"]]),
						sessionMode: "fresh",
					});
					assert.ok(namespaced.details);
					const namespacedRetry = readArray(namespaced.details.nextActions)
						.map(readRecord)
						.find((action) => action.id === "retry-timeout-step");
					assert.deepEqual(
						namespacedRetry?.params,
						{
							args: ["--namespace", "r", "batch"],
							stdin: JSON.stringify([["open", "https://example.test/fresh-timeout"]]),
							sessionMode: "fresh",
						},
						JSON.stringify(namespaced),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("timeout retries preserve native row semantics in visible and structured payloads", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "timeout-retry-"));
	try {
		const step = ["pdf", "--quick", "ignored.pdf"];
		const progress = await collectTimeoutPartialProgress({
			commandTokens: ["batch"],
			cwd,
			stdin: JSON.stringify([step]),
		});
		assert.ok(progress);
		const retry = { args: ["batch"], stdin: JSON.stringify([step]) };
		assert.deepEqual(progress.retryStep?.retry, retry);
		assert.ok(
			formatTimeoutPartialProgressText(progress).includes(
				`Retry candidate for step 1 (outcome unknown): ${JSON.stringify(retry)}`,
			),
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("timeout artifact evidence follows native operands, not ignored tails or outer globals", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "timeout-argv-"));
	const paths = ["actual.pdf", "-actual.bin", "--quick", "--screenshot-dir", "capture.csv"];
	try {
		for (const path of paths) {
			// Fixture transitions and their assertions run in order against this test's shared state.
			// oxlint-disable-next-line no-await-in-loop
			await writeFile(join(cwd, path), "saved bytes");
		}
		const progress = await collectTimeoutPartialProgress({
			commandTokens: ["batch"],
			cwd,
			stdin: JSON.stringify([
				["pdf", paths[0], "ignored.pdf"],
				["download", "#link", paths[1], "ignored.bin"],
				["pdf", paths[2], "ignored.pdf"],
				["screenshot", "body", paths[3], "ignored.png"],
				["wait", "--download", "--timeout", "30000", paths[4], "ignored.csv"],
				["state", "save", "not-a-timeout-family.json"],
			]),
		});
		assert.deepEqual(
			progress?.artifacts.map(({ path, exists, stepIndex }) => ({ path, exists, stepIndex })),
			paths.map((path, index) => ({ path, exists: true, stepIndex: index + 1 })),
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test(
	"collectTimeoutPartialProgress recovers live page state when session probes succeed",
	{ concurrency: false },
	async () => {
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
					commandTokens: ["batch"],
					cwd: tempDir,
					sessionName: "named",
					stdin: JSON.stringify([
						["open", "https://example.test"],
						["screenshot", "dogfood/secret-token/filled.png"],
						["wait", "--download", "dogfood/export.csv"],
					]),
				});

				assert.ok(progress);
				assert.equal(
					progress.currentPage?.url,
					"https://example.test/secret-token/results?token=url-secret",
				);
				assert.equal(
					progress.currentPage.title,
					"Results page export secret-token Authorization: Bearer title-secret",
				);
				assert.deepEqual(
					progress.artifacts.map((artifact) => ({
						exists: artifact.exists,
						path: artifact.path,
						stepIndex: artifact.stepIndex,
					})),
					[
						{ exists: true, path: "dogfood/secret-token/filled.png", stepIndex: 2 },
						{ exists: false, path: "dogfood/export.csv", stepIndex: 3 },
					],
				);
				const text = formatTimeoutPartialProgressText(progress);
				assert.match(
					text,
					/Current page: \[REDACTED\] — https:\/\/example.test\/\[REDACTED\]\/results\?token=%5BREDACTED%5D/,
				);
				assert.doesNotMatch(text, /url-secret|title-secret|secret-token/);

				const compiledJob = compileAgentBrowserQaPreset({
					url: "https://example.test",
					checkConsole: false,
					checkErrors: false,
					checkNetwork: false,
				}).compiled;
				const generatedProgress = await collectTimeoutPartialProgress({
					commandTokens: ["batch"],
					compiledJob,
					cwd: tempDir,
					sessionName: "named",
				});
				assert.deepEqual(generatedProgress?.steps?.[1]?.args, [
					"wait",
					"--load",
					"domcontentloaded",
				]);
				assert.match(
					formatTimeoutPartialProgressText(generatedProgress),
					/Step 2 \[unknown\]: wait --load domcontentloaded/,
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"collectTimeoutPartialProgress reads page context for local URLs",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-timeout-local-page-"));
		const logPath = join(tempDir, "agent-browser.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const subcommand = args.at(-1);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const data = subcommand === "url"
  ? { result: "file:///tmp/local-timeout-page.html" }
  : { result: "SECRET LOCAL TITLE" };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const progress = await collectTimeoutPartialProgress({
					commandTokens: ["batch"],
					cwd: tempDir,
					sessionName: "named",
					stdin: "[]",
				});
				assert.equal(progress?.currentPage?.url, "file:///tmp/local-timeout-page.html");
				assert.equal(progress.currentPage.title, "SECRET LOCAL TITLE");
				assert.deepEqual(
					(await readInvocationLog(logPath)).map((entry) => entry.args.at(-1)),
					["url", "title"],
				);
				assert.match(JSON.stringify(progress), /SECRET LOCAL TITLE/);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"collectTimeoutPartialProgress falls back to the planned page URL when live page recovery is unavailable",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		try {
			for (const command of ["open", "goto", "navigate"] as const) {
				// Fixture transitions and their assertions run in order against this test's shared state.
				// oxlint-disable-next-line no-await-in-loop
				const progress = await collectTimeoutPartialProgress({
					commandTokens: ["batch"],
					cwd: tempDir,
					stdin: JSON.stringify([
						[command, `https://example.test/${command}-planned`],
						["screenshot", `${command}-planned.png`],
						["wait", "--download", `${command}-download.csv`],
					]),
				});

				// All three literal navigation aliases check planned-URL fallback and missing artifact receipts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(progress, command);
				// All three literal navigation aliases check planned-URL fallback and missing artifact receipts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(progress.currentPage?.url, `https://example.test/${command}-planned`, command);
				// All three literal navigation aliases check planned-URL fallback and missing artifact receipts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(progress.currentPage.source, "planned", command);
				// All three literal navigation aliases check planned-URL fallback and missing artifact receipts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(progress.liveUrlRecovered, false, command);
				// All three literal navigation aliases check planned-URL fallback and missing artifact receipts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(progress.currentPage.title, undefined, command);
				// All three literal navigation aliases check planned-URL fallback and missing artifact receipts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.match(progress.summary, /planned page URL/, command);
				// All three literal navigation aliases check planned-URL fallback and missing artifact receipts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(
					progress.artifacts.map((artifact) => ({
						exists: artifact.exists,
						path: artifact.path,
						stepIndex: artifact.stepIndex,
					})),
					[
						{ exists: false, path: `${command}-planned.png`, stepIndex: 2 },
						{ exists: false, path: `${command}-download.csv`, stepIndex: 3 },
					],
					command,
				);
				// All three literal navigation aliases check planned-URL fallback and missing artifact receipts.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.match(
					formatTimeoutPartialProgressText(progress),
					new RegExp(`Current page: https://example\\.test/${command}-planned`),
					command,
				);
			}
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension forwards wait --download saved-file metadata in details",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-wait-download-"));
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`process.stdout.write(JSON.stringify({ success: true, data: { path: "/tmp/export.csv", elapsedMs: 64 } }));`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["wait", "--download", "/tmp/export.csv"],
					});
					assert.ok(result.details);

					assert.equal(result.isError, true);
					assert.equal(result.content[0]?.type, "text");
					assert.ok(
						readString(readRecord(result.content[0]).text).includes(
							`Artifact verification failed: requested download was not found at ${resolve(tempDir, "/tmp/export.csv")}.`,
						),
					);
					assert.match(
						readString(readRecord(result.content[0]).text),
						/Download event reported; file not verified: \/tmp\/export\.csv/,
					);
					assert.equal(result.details.savedFilePath, "/tmp/export.csv");
					assert.deepEqual(result.details.savedFile, {
						command: "wait",
						kind: "download",
						metadata: { elapsedMs: 64 },
						path: "/tmp/export.csv",
						subcommand: "--download",
					});
					assert.equal(result.details.resultCategory, "failure");
					assert.equal(result.details.failureCategory, "artifact-missing");
					assert.equal(result.details.successCategory, undefined);
					assert.equal(readRecord(result.details.artifactVerification).missingCount, 1);
					assert.equal(readRecord(result.details.artifactVerification).verified, false);
					assert.deepEqual(
						readRecord(readArray(result.details.nextActions).map(readRecord)[0].params).args,
						["--session", result.details.sessionName, "wait", "--download", "/tmp/export.csv"],
					);
					assert.equal(readRecord(result.details.pageChangeSummary).changeType, "artifact");
					assert.equal(
						readRecord(result.details.pageChangeSummary).savedFilePath,
						"/tmp/export.csv",
					);

					const shortResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["wait", "-d", "/tmp/export.csv"],
					});
					assert.ok(shortResult.details);
					assert.equal(shortResult.isError, true);
					assert.match(
						shortResult.content[0]?.text ?? "",
						/Download event reported; file not verified: \/tmp\/export\.csv/,
					);
					assert.equal(shortResult.details.savedFilePath, "/tmp/export.csv");
					assert.equal(readRecord(shortResult.details.savedFile).subcommand, "-d");
					assert.equal(readRecord(shortResult.details.artifactVerification).missingCount, 1);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports artifact lifecycle guidance on close",
	{ concurrency: false },
	async () => {
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

				const screenshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["screenshot", screenshotPath],
				});
				assert.equal(screenshot.isError, false);
				const deletedScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["screenshot", deletedScreenshotPath],
				});
				assert.ok(deletedScreenshot.details);
				assert.equal(deletedScreenshot.isError, false);
				await rm(deletedScreenshotPath, { force: true });
				assert.equal(
					readRecord(deletedScreenshot.details.artifactManifest).liveCount,
					1,
					"an invocation reports its own receipt, while close checks the retained recent view",
				);

				const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
				assert.ok(close.details);
				assert.equal(close.isError, false);
				const text = readRecord(close.content[0]).text;
				assert.match(
					readString(text),
					/Artifact lifecycle: 1 explicit artifact remains; expand or inspect details\.artifactCleanup\.explicitArtifactPaths for paths\./,
				);
				assert.match(readString(text), /Browser close does not delete explicit screenshots/);
				assert.doesNotMatch(readString(text), /artifact\.png/);
				assert.doesNotMatch(readString(text), /deleted-artifact\.png/);
				assert.deepEqual(close.details.artifactCleanup, {
					explicitArtifactPaths: [screenshotPath],
					note: "Closing the browser session does not delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings; clean existing paths with host file tools when no longer needed.",
					owner: "host-file-tools",
					summary: readString(close.details.artifactRetentionSummary),
				});

				await writeFile(failClosePath, "fail");
				const failedClose = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["close"],
				});
				assert.ok(failedClose.details);
				assert.equal(failedClose.isError, true);
				assert.doesNotMatch(
					readString(readRecord(failedClose.content[0]).text),
					/Artifact lifecycle:/,
				);
				assert.equal(failedClose.details.artifactCleanup, undefined);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension warns when get text may read hidden selector matches",
	{ concurrency: false },
	async () => {
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

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "text", ".language-bash"],
				});
				assert.ok(result.details);
				assert.equal(result.isError, false);
				assert.match(readString(readRecord(result.content[0]).text), /npm init playwright@latest/);
				assert.match(
					readString(readRecord(result.content[0]).text),
					/Selector text visibility warning:/,
				);
				assert.match(
					readString(readRecord(result.content[0]).text),
					/Next action: use details\.nextActions inspect-visible-text-candidates before trusting this selector text\./,
				);
				assert.match(readString(readRecord(result.content[0]).text), /yarn create playwright/);
				assert.doesNotMatch(
					readString(readRecord(result.content[0]).text),
					/visible-secret|page-secret/,
				);
				assert.deepEqual(result.details.selectorTextVisibility, {
					firstMatchVisible: false,
					firstVisibleTextPreview: "yarn create playwright Authorization: Bearer [REDACTED]",
					matchCount: 2,
					selector: ".language-bash",
					summary:
						'Selector ".language-bash" matched 2 elements; the first match is hidden while 1 visible match exists.',
					visibleCandidates: [
						{
							index: 1,
							tagName: "code",
							textPreview: "yarn create playwright Authorization: Bearer [REDACTED]",
						},
					],
					visibleCount: 1,
				});
				assert.match(
					readString(readRecord(result.content[0]).text),
					/Visible candidates \(1 shown, querySelectorAll index\):/,
				);
				assert.match(
					readString(readRecord(result.content[0]).text),
					/\[1\] code: "yarn create playwright Authorization: Bearer \[REDACTED\]"/,
				);
				const nextActions = readArray(result.details.nextActions).map(readRecord);
				assert.equal(nextActions.at(-1)?.id, "inspect-visible-text-candidates");
				assert.deepEqual(readRecord(nextActions.at(-1)?.params).args, [
					"--session",
					readString(result.details.sessionName),
					"eval",
					"--stdin",
				]);
				assert.match(
					readString(readRecord(nextActions.at(-1)?.params).stdin ?? ""),
					/querySelectorAll/,
				);

				const secretSelectorResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "text", '[href*="token=visible-secret"]'],
				});
				assert.ok(secretSelectorResult.details);
				assert.equal(secretSelectorResult.isError, false);
				assert.doesNotMatch(
					readString(readRecord(secretSelectorResult.content[0]).text),
					/Selector text visibility warning|visible-secret/,
				);
				assert.equal(secretSelectorResult.details.selectorTextVisibility, undefined);
				const unquotedSecretSelectorResult = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["get", "text", "[data-token=visible-secret]"] },
				);
				assert.ok(unquotedSecretSelectorResult.details);
				assert.equal(unquotedSecretSelectorResult.isError, false);
				assert.doesNotMatch(
					readString(readRecord(unquotedSecretSelectorResult.content[0]).text),
					/Selector text visibility warning|visible-secret/,
				);
				assert.equal(unquotedSecretSelectorResult.details.selectorTextVisibility, undefined);
				let invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);

				const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["get", "text", ".ambiguous-language-bash"],
						["get", "text", ".language-bash"],
					]),
				});
				assert.ok(batchResult.details);
				assert.equal(batchResult.isError, false);
				assert.match(
					readString(readRecord(batchResult.content[0]).text),
					/Selector text visibility warning:/,
				);
				assert.match(
					readString(readRecord(batchResult.content[0]).text),
					/Selector "\.language-bash" matched 2 elements; the first match is hidden/,
				);
				assert.match(
					readString(readRecord(batchResult.content[0]).text),
					/Selector "\.ambiguous-language-bash" matched 2 elements; get text reads the first upstream match/,
				);
				assert.match(
					readString(readRecord(batchResult.content[0]).text),
					/Next action: use details\.nextActions inspect-visible-text-candidates before trusting this selector text\./,
				);
				assert.match(
					readString(readRecord(batchResult.content[0]).text),
					/Next action: use details\.nextActions inspect-visible-text-candidates-2 before trusting this selector text\./,
				);
				assert.equal(
					readRecord(batchResult.details.selectorTextVisibility).selector,
					".language-bash",
				);
				assert.deepEqual(
					readArray(batchResult.details.selectorTextVisibilityAll)
						.map(readRecord)
						.map((entry) => entry.selector),
					[".language-bash", ".ambiguous-language-bash"],
				);
				invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 3);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension surfaces overlay blockers in snapshot actionability metadata",
	{ concurrency: false },
	async () => {
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

				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.ok(snapshot.details);
				assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
				assert.match(snapshot.content[0]?.text ?? "", /Possible overlay blockers:/);
				const overlayBlockers = readRecord(snapshot.details.overlayBlockers);
				assert.equal(readArray(overlayBlockers.candidates).map(readRecord)[0].ref, "@e5");
				assert.ok(
					readArray(snapshot.details.nextActions)
						.map(readRecord)
						.some((action) => action.id === "try-overlay-blocker-candidate-1"),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension surfaces likely overlay blockers after a no-op click",
	{ concurrency: false },
	async () => {
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

				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://blocked.example/"],
				});
				assert.equal(open.isError, false);

				const click = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e9"],
				});
				assert.ok(click.details);
				assert.equal(click.isError, false);
				const text = readRecord(click.content[0]);
				assert.match(readString(text.text), /Possible overlay blockers:/);
				assert.match(readString(text.text), /Action dispatched; application change unverified/);
				assert.match(readString(text.text), /@e5 button "×"/);
				assert.equal(readRecord(click.details.pageChangeSummary).observed, false);
				assert.doesNotMatch(readString(text.text), /Agent-browser candidate fallbacks:/);
				const overlayBlockers = readRecord(click.details.overlayBlockers);
				assert.equal(readArray(overlayBlockers.candidates).map(readRecord)[0].ref, "@e5");
				assert.equal(click.details.refSnapshot, undefined);
				assert.deepEqual(
					SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch()).get(
						readString(click.details.sessionName),
					).refSnapshot?.refIds,
					["e5", "e6", "e7"],
				);
				const nextActions = readArray(click.details.nextActions).map(readRecord);
				assert.deepEqual(
					nextActions.map((action) => action.id),
					["inspect-after-mutation", "inspect-overlay-state", "try-overlay-blocker-candidate-1"],
				);
				assert.deepEqual(readRecord(nextActions[1].params).args, [
					"--session",
					readString(click.details.sessionName),
					"snapshot",
					"-i",
				]);
				assert.deepEqual(readRecord(nextActions[2].params).args, [
					"--session",
					readString(click.details.sessionName),
					"click",
					"@e5",
				]);

				const closeCandidateArgs = readRecord(nextActions[2].params).args;
				assert.ok(closeCandidateArgs !== undefined);
				const closeCandidate = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: closeCandidateArgs,
				});
				assert.ok(closeCandidate.details);
				assert.equal(closeCandidate.isError, false);
				assert.notEqual(closeCandidate.details.failureCategory, "stale-ref");
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension does not report overlay blockers from unrelated page chrome after a successful same-page click",
	{ concurrency: false },
	async () => {
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

				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://repo.example/"],
				});
				assert.equal(open.isError, false);
				const click = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e9"],
				});
				assert.ok(click.details);
				assert.equal(click.isError, false);
				const text = readRecord(click.content[0]);
				assert.doesNotMatch(readString(text.text), /Possible overlay blockers:/);
				assert.equal(click.details.overlayBlockers, undefined);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension returns tab-drift next actions for early tab re-selection failures",
	{ concurrency: false },
	async () => {
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
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "named", "eval", "--stdin"],
					stdin: "document.title",
				});
				assert.ok(result.details);

				assert.equal(result.isError, true);
				assert.equal(result.details.failureCategory, "tab-drift");
				const nextActions = readArray(result.details.nextActions).map(readRecord);
				assert.deepEqual(
					nextActions.map((action) => action.id),
					["list-tabs-for-tab-drift-recovery"],
				);
				assert.deepEqual(
					nextActions.map((action) => readRecord(action.params).args),
					[["--session", "named", "tab", "list"]],
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
