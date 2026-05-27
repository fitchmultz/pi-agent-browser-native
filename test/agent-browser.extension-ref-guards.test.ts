/**
 * Purpose: Verify extension entrypoint page-scoped ref guards and session target restoration.
 * Responsibilities: Assert stale-ref preflight, batch invalidation latches, snapshot ref recording, and diagnostic URL filtering.
 * Scope: Integration-style Node test-runner coverage for ref/page-state behavior split out of the broad extension-validation suite.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-ref-guards.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSecureTempDirectory } from "../extensions/agent-browser/lib/temp.js";
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

function pidIsAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("agentBrowserExtension blocks page-scoped ref reuse after navigation before upstream can recycle it", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-generation-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://first.example/",
    refs: { e1: { role: "button", name: "Old Search" } },
    snapshot: '- button "Old Search" [ref=e1]'
  } }));
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Second", url: "https://second.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "recycled ref" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);
			assert.deepEqual((snapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);

			const currentClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(currentClick.isError, false);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://second.example/"] });
			assert.equal(open.isError, false);

			const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(staleClick.isError, true);
			assert.equal(staleClick.details?.failureCategory, "stale-ref");
			assert.match((staleClick.content[0] as { text: string }).text, /came from a snapshot for https:\/\/first\.example\//);
			assert.match((staleClick.content[0] as { text: string }).text, /current session target is https:\/\/second\.example\//);
			const nextActions = staleClick.details?.nextActions as Array<{ params?: { args?: string[] } }> | undefined;
			assert.deepEqual(nextActions?.[0]?.params?.args, ["--session", staleClick.details?.sessionName as string, "snapshot", "-i"]);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rehydrates page-scoped refs from the current tree branch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-refs-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { clicked: true } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const firstTarget = { title: "First", url: "https://first.example/" };
			const secondTarget = { title: "Second", url: "https://second.example/" };
			const branchA = [
				createToolBranchEntry({
					details: {
						args: ["--session", "named", "snapshot", "-i"],
						command: "snapshot",
						refSnapshot: { refIds: ["e1"], refs: { e1: { name: "Old", role: "button" } }, target: firstTarget },
						sessionName: "named",
						sessionTabTarget: firstTarget,
					},
					isError: false,
				}),
			];
			const branchB = [
				createToolBranchEntry({
					details: {
						args: ["--session", "named", "snapshot", "-i"],
						command: "snapshot",
						refSnapshot: { refIds: ["e2"], refs: { e2: { name: "New", role: "button" } }, target: secondTarget },
						sessionName: "named",
						sessionTabTarget: secondTarget,
					},
					isError: false,
				}),
			];
			const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			harness.setBranch(branchB);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-b", oldLeafId: "branch-a" }, harness.ctx);

			const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "click", "@e1"] });
			assert.equal(staleClick.isError, true);
			assert.equal(staleClick.details?.failureCategory, "stale-ref");
			assert.match(staleClick.content[0]?.text ?? "", /@e1/);
			assert.equal((await readInvocationLog(logPath)).length, 0);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rehydrates managed browser session state from the current tree branch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-managed-session-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  const url = args[args.length - 1];
  process.stdout.write(JSON.stringify({ success: true, data: { title: url.includes("second") ? "Second" : "First", url } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://snapshot.example/", refs: {}, snapshot: "" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://first.example/"], sessionMode: "fresh" });
			const firstSessionName = firstOpen.details?.sessionName as string;
			const branchA = [createToolBranchEntry({ details: firstOpen.details ?? {}, isError: false })];
			const secondOpen = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://second.example/"], sessionMode: "fresh" });
			const secondSessionName = secondOpen.details?.sessionName as string;
			const branchB = [createToolBranchEntry({ details: secondOpen.details ?? {}, isError: false })];
			assert.notEqual(firstSessionName, secondSessionName);

			harness.setBranch(branchA);
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			harness.setBranch(branchB);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-b", oldLeafId: "branch-a" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.equal(snapshot.details?.sessionName, secondSessionName);
			const lastInvocation = (await readInvocationLog(logPath)).at(-1);
			assert.deepEqual(lastInvocation?.args.slice(0, 3), ["--json", "--session", secondSessionName]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rehydrates artifact manifest state from the current tree branch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-artifacts-"));
	const logPath = join(tempDir, "invocations.log");
	const firstArtifact = join(tempDir, "first.png");
	const secondArtifact = join(tempDir, "second.png");
	const basePath = process.env.PATH ?? "";
	await writeFile(firstArtifact, "first", "utf8");
	await writeFile(secondArtifact, "second", "utf8");
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));`,
	);

	const buildManifest = (artifactPath: string) => ({
		entries: [{
			absolutePath: artifactPath,
			command: "screenshot",
			createdAtMs: 1,
			cwd: tempDir,
			kind: "screenshot",
			path: artifactPath,
			retentionState: "live",
			storageScope: "explicit-path",
		}],
		evictedCount: 0,
		liveCount: 1,
		maxEntries: 100,
		updatedAtMs: 1,
		version: 1,
	});

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const branchA = [createToolBranchEntry({ details: { artifactManifest: buildManifest(firstArtifact), args: ["screenshot", firstArtifact], command: "screenshot", sessionName: "named" }, isError: false })];
			const branchB = [createToolBranchEntry({ details: { artifactManifest: buildManifest(secondArtifact), args: ["screenshot", secondArtifact], command: "screenshot", sessionName: "named" }, isError: false })];
			const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			harness.setBranch(branchB);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-b", oldLeafId: "branch-a" }, harness.ctx);

			const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "close"] });
			assert.equal(close.isError, false, JSON.stringify(close));
			assert.deepEqual((close.details?.artifactCleanup as { explicitArtifactPaths?: string[] } | undefined)?.explicitArtifactPaths, [secondArtifact]);
			assert.doesNotMatch(close.content[0]?.text ?? "", new RegExp(firstArtifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps Electron cleanup ownership after session_tree switches away from the launch branch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-electron-cleanup-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	let child: ChildProcess | undefined;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close") } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const userDataDir = await createSecureTempDirectory("electron-profile-");
			child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)", `--user-data-dir=${userDataDir}`], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			assert.ok(pidIsAlive(child.pid));
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron`;
			const electronRecord = {
				appName: "Test Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-branch-a",
				launchedByWrapper: true,
				pid: child.pid,
				port: 9,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const branchA = [createToolBranchEntry({
				details: {
					args: ["connect", "9"],
					command: "connect",
					electron: { action: "launch", launch: electronRecord, status: "attached" },
					exitCode: 0,
					managedSessionOutcome: {
						activeAfter: true,
						activeBefore: false,
						attemptedSessionName: electronSessionName,
						currentSessionName: electronSessionName,
						previousSessionName: electronSessionName,
						sessionMode: "fresh",
						status: "created",
						succeeded: true,
						summary: `Managed session ${electronSessionName} is now current.`,
					},
					resultCategory: "success",
					sessionMode: "fresh",
					sessionName: electronSessionName,
					usedImplicitSession: false,
				},
				isError: false,
			})];
			const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			harness.setBranch([]);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: null, oldLeafId: "branch-a" }, harness.ctx);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);

			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.join("\0") === ["--session", electronSessionName, "close"].join("\0")));
			assert.equal(pidIsAlive(child?.pid), false);
		});
	} finally {
		if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps network request diagnostics from replacing the active page target", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-request-target-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const appTarget = "https://app.example/";
const apiTarget = "https://app.example/api/data";
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: appTarget,
    refs: { e1: { role: "button", name: "Refresh data" } },
    snapshot: '- button "Refresh data" [ref=e1]'
  } }));
} else if (args.includes("network") && args.includes("request")) {
  process.stdout.write(JSON.stringify({ success: true, data: { id: "42", method: "GET", status: 500, url: apiTarget, error: "server error" } }));
} else if (args.includes("errors")) {
  process.stdout.write(JSON.stringify({ success: true, data: { errors: [], url: "https://cdn.example/app.js" } }));
} else if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  process.stdout.write(JSON.stringify(steps.map((step) => {
    if (step[0] === "network" && step[1] === "request") {
      return { command: step, success: true, result: { id: step[2], method: "GET", status: 500, url: apiTarget, error: "server error" } };
    }
    if (step[0] === "network" && step[1] === "requests") {
      return { command: step, success: true, result: { requests: [{ id: "42", method: "GET", status: 500, url: apiTarget, error: "server error" }] } };
    }
    return { command: step, success: true, result: { ok: step[0] } };
  })));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.deepEqual(snapshot.details?.sessionTabTarget, { title: undefined, url: "https://app.example/" });

			const networkRequest = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["network", "request", "42"] });
			assert.equal(networkRequest.isError, false, JSON.stringify(networkRequest));
			assert.deepEqual(networkRequest.details?.sessionTabTarget, { title: undefined, url: "https://app.example/" });
			assert.deepEqual((networkRequest.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);

			const pageErrors = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["errors"] });
			assert.equal(pageErrors.isError, false, JSON.stringify(pageErrors));
			assert.deepEqual(pageErrors.details?.sessionTabTarget, { title: undefined, url: "https://app.example/" });

			const clickAfterNetworkRequest = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(clickAfterNetworkRequest.isError, false, JSON.stringify(clickAfterNetworkRequest));
			assert.notEqual(clickAfterNetworkRequest.details?.failureCategory, "stale-ref");
			assert.equal((clickAfterNetworkRequest.details?.data as { clicked?: string } | undefined)?.clicked, "@e1");

			const networkSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, { networkSourceLookup: { requestId: "42" } });
			assert.equal(networkSourceLookup.isError, false, JSON.stringify(networkSourceLookup));
			assert.deepEqual(networkSourceLookup.details?.sessionTabTarget, { title: undefined, url: "https://app.example/" });
			assert.deepEqual((networkSourceLookup.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);

			const clickAfterNetworkSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(clickAfterNetworkSourceLookup.isError, false, JSON.stringify(clickAfterNetworkSourceLookup));
			assert.notEqual(clickAfterNetworkSourceLookup.details?.failureCategory, "stale-ref");

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 2);
			assert.equal(invocations.filter((entry) => entry.args.includes("network") && entry.args.includes("request")).length, 1);
			assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension ignores restored diagnostic session targets that contain request URLs", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-request-restore-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const appTarget = { title: undefined, url: "https://app.example/" };
			const harness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://app.example/"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: appTarget,
						},
						isError: false,
					}),
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "snapshot", "-i"],
							command: "snapshot",
							refSnapshot: { refIds: ["e1"], target: appTarget },
							sessionName: "named",
							sessionTabTarget: appTarget,
						},
						isError: false,
					}),
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "network", "request", "42"],
							command: "network",
							refSnapshot: { refIds: ["e1"], target: appTarget },
							sessionName: "named",
							sessionTabTarget: { title: undefined, url: "https://app.example/api/data" },
							subcommand: "request",
						},
						isError: false,
					}),
					createToolBranchEntry({
						details: {
							args: ["batch"],
							command: "batch",
							compiledNetworkSourceLookup: { args: ["batch"], query: { requestId: "42" }, steps: [], stdin: "[]" },
							data: [
								{
									command: ["network", "request", "42"],
									result: { error: "server error", id: "42", status: 500, url: "https://app.example/api/data" },
									success: true,
								},
							],
							refSnapshot: { refIds: ["e1"], target: appTarget },
							sessionName: "named",
							sessionTabTarget: { title: undefined, url: "https://app.example/api/data" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "click", "@e1"] });
			assert.equal(click.isError, false, JSON.stringify(click));
			assert.notEqual(click.details?.failureCategory, "stale-ref");
			assert.deepEqual(click.details?.sessionTabTarget, appTarget);
			assert.deepEqual((click.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);
			assert.equal("order" in ((click.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension restores empty successful batch snapshots as ref state", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-empty-ref-restore-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("click")) {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const appTarget = { title: undefined, url: "https://empty.example/" };
			const harness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "snapshot", "-i"],
							command: "snapshot",
							refSnapshotInvalidation: { reason: "no-active-page", summary: "The latest snapshot for this session reported No active page. Old page-scoped refs are invalid until snapshot -i succeeds." },
							sessionName: "named",
						},
						isError: true,
					}),
					createToolBranchEntry({
						details: {
							args: ["batch"],
							command: "batch",
							data: [{ command: ["snapshot", "-i"], result: { origin: appTarget.url, refs: {}, snapshot: "" }, success: true }],
							refSnapshot: { refIds: [], target: appTarget },
							sessionName: "named",
							sessionTabTarget: appTarget,
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", "named", "click", "@e1"] });
			assert.equal(click.isError, true);
			assert.equal(click.details?.failureCategory, "stale-ref");
			assert.deepEqual(click.details?.refIds, ["e1"]);
			assert.deepEqual((click.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, []);
			assert.equal(click.details?.refSnapshotInvalidation, undefined);
			assert.match((click.content[0] as { text: string }).text, /was not present in the latest snapshot/);

			const invocations = await readInvocationLog(logPath).catch(() => []);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 0);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension treats successful snapshots without refs as empty ref state", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-missing-refs-snapshot-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "snapshot-count.txt");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
	let count = 0;
	try { count = Number(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
	count += 1;
	fs.writeFileSync(${JSON.stringify(statePath)}, String(count));
	if (count === 1) {
	process.stdout.write(JSON.stringify({ success: true, data: {
		origin: "https://missing-refs.example/",
		refs: { e1: { role: "button", name: "Old Search" } },
		snapshot: '- button "Old Search" [ref=e1]'
	} }));
	} else {
	process.stdout.write(JSON.stringify({ success: true, data: {
		origin: "https://missing-refs.example/",
		snapshot: 'No interactive controls are visible.'
	} }));
	}
} else if (args.includes("click")) {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(firstSnapshot.isError, false, JSON.stringify(firstSnapshot));
			assert.deepEqual((firstSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);

			const emptySnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(emptySnapshot.isError, false, JSON.stringify(emptySnapshot));
			assert.deepEqual((emptySnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, []);

			const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(staleClick.isError, true, JSON.stringify(staleClick));
			assert.equal(staleClick.details?.failureCategory, "stale-ref");
			assert.match((staleClick.content[0] as { text: string }).text, /was not present in the latest snapshot/);
			assert.deepEqual((staleClick.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, []);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 0);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});


test("agentBrowserExtension blocks stale refs after page-changing steps inside a batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin: null }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://first.example/",
    refs: { e1: { role: "button", name: "Old Search" } },
    snapshot: '- button "Old Search" [ref=e1]'
  } }));
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([{ command: ["open", "https://second.example/"], success: true, result: { title: "Second", url: "https://second.example/" } }, { command: ["click", "@e1"], success: true, result: { clicked: "recycled" } }]));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);

			const staleBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["open", "https://second.example/"], ["click", "@e1"]]),
			});
			assert.equal(staleBatch.isError, true);
			assert.equal(staleBatch.details?.failureCategory, "stale-ref");
			assert.match((staleBatch.content[0] as { text: string }).text, /after an earlier batch step can navigate or mutate/);

			const staleScrollAliasBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["open", "https://second.example/"], ["scrollinto", "@e1"]]),
			});
			assert.equal(staleScrollAliasBatch.isError, true);
			assert.equal(staleScrollAliasBatch.details?.failureCategory, "stale-ref");
			assert.match((staleScrollAliasBatch.content[0] as { text: string }).text, /Batch step scrollinto uses page-scoped ref @e1/);

			const staleTapBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["open", "https://second.example/"], ["tap", "@e1"]]),
			});
			assert.equal(staleTapBatch.isError, true);
			assert.equal(staleTapBatch.details?.failureCategory, "stale-ref");
			assert.match((staleTapBatch.content[0] as { text: string }).text, /Batch step tap uses page-scoped ref @e1/);

			const staleKeydownBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["keydown", "Enter"], ["click", "@e1"]]),
			});
			assert.equal(staleKeydownBatch.isError, true);
			assert.equal(staleKeydownBatch.details?.failureCategory, "stale-ref");
			assert.match((staleKeydownBatch.content[0] as { text: string }).text, /Batch step click uses page-scoped ref @e1/);

			const staleScrollThenClickBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["scroll", "down"], ["click", "@e1"]]),
			});
			assert.equal(staleScrollThenClickBatch.isError, true);
			assert.equal(staleScrollThenClickBatch.details?.failureCategory, "stale-ref");
			assert.match((staleScrollThenClickBatch.content[0] as { text: string }).text, /Batch step click uses page-scoped ref @e1/);

			const staleScrollIntoThenClickBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["scrollintoview", "@e1"], ["click", "@e2"]]),
			});
			assert.equal(staleScrollIntoThenClickBatch.isError, true);
			assert.equal(staleScrollIntoThenClickBatch.details?.failureCategory, "stale-ref");
			assert.match((staleScrollIntoThenClickBatch.content[0] as { text: string }).text, /Batch step click uses page-scoped ref @e2/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 0);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allows same-snapshot form fills before a batch click", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-form-fills-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://login.example/",
    refs: {
      e3: { role: "button", name: "Login" },
      e4: { role: "textbox", name: "Username" },
      e5: { role: "textbox", name: "Password" }
    },
    snapshot: '- textbox "Username" [ref=e4]\\n- textbox "Password" [ref=e5]\\n- button "Login" [ref=e3]'
  } }));
} else if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  process.stdout.write(JSON.stringify(steps.map((step) => ({ command: step, success: true, result: { ok: step[0] } }))));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));

			const sameFormBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([
					["fill", "@e4", "standard_user"],
					["fill", "@e5", "secret_sauce"],
					["click", "@e3"],
				]),
			});
			assert.equal(sameFormBatch.isError, false, JSON.stringify(sameFormBatch));

			const clickThenFill = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([
					["click", "@e3"],
					["fill", "@e4", "standard_user"],
				]),
			});
			assert.equal(clickThenFill.isError, true);
			assert.equal(clickThenFill.details?.failureCategory, "stale-ref");
			assert.match((clickThenFill.content[0] as { text: string }).text, /after an earlier batch step can navigate or mutate/);

			const invocations = await readInvocationLog(logPath);
			const batchInvocations = invocations.filter((entry) => entry.args.includes("batch"));
			assert.equal(batchInvocations.length, 1);
			assert.deepEqual(JSON.parse(String(batchInvocations[0]?.stdin ?? "[]")), [
				["fill", "@e4", "standard_user"],
				["fill", "@e5", "secret_sauce"],
				["click", "@e3"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allows batch stdin ref steps after snapshot following an invalidating step", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-snapshot-reset-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["open", "https://second.example/"], success: true, result: { title: "Second", url: "https://second.example/" } },
    { command: ["snapshot", "-i"], success: true, result: {
      origin: "https://second.example/",
      refs: { e7: { role: "button", name: "Go" } },
      snapshot: '- button "Go" [ref=e7]'
    } },
    { command: ["click", "@e7"], success: true, result: { clicked: "ok" } }
  ]));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://first.example/",
    refs: { e1: { role: "button", name: "Old" } },
    snapshot: '- button "Old" [ref=e1]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);

			const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["open", "https://second.example/"], ["snapshot", "-i"], ["click", "@e7"]]),
			});
			assert.equal(batch.isError, false);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension records snapshot refs returned inside a successful batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-snapshot-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([{ command: ["snapshot", "-i"], success: true, result: {
    origin: "https://batched.example/",
    refs: { e7: { role: "button", name: "Batched" } },
    snapshot: '- button "Batched" [ref=e7]'
  } }]));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "batched ref" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const batchSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["snapshot", "-i"]]),
			});
			assert.equal(batchSnapshot.isError, false);
			assert.deepEqual((batchSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e7"]);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e7"] });
			assert.equal(click.isError, false);
			assert.equal((click.details?.data as { clicked?: string } | undefined)?.clicked, "batched ref");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects refs absent from the latest same-page snapshot", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-missing-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://same.example/",
    refs: { e2: { role: "button", name: "Current" } },
    snapshot: '- button "Current" [ref=e2]'
  } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "unexpected" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false);

			const missingRefClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(missingRefClick.isError, true);
			assert.equal(missingRefClick.details?.failureCategory, "stale-ref");
			assert.match((missingRefClick.content[0] as { text: string }).text, /was not present in the latest snapshot/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 0);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
