/**
 * Purpose: Verify Electron branch ownership across restore, reload, shutdown, and cleanup.
 * Responsibilities: Assert replay tombstones, off-branch ownership, verified connection reuse, cleanup serialization, and session retirement.
 * Scope: Integration-style Node test-runner coverage for Electron branch lifecycle behavior.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-electron-branch-ownership.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { directoryExists } from "../extensions/agent-browser/lib/fs-utils.js";
import { createImplicitSessionName } from "../extensions/agent-browser/lib/runtime.js";
import { createSecureTempDirectory } from "../extensions/agent-browser/lib/temp.js";

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

function assertIsString(value: unknown): asserts value is string {
	assert.equal(typeof value, "string");
}

function pidIsAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function spawnElectronFixtureProcess(userDataDir: string): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${userDataDir}`], { detached: process.platform !== "win32", stdio: "ignore" });
	child.unref();
	return child;
}

async function listenOnLoopback(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return address.port;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function electronManagedSessionDetails(sessionName: string, electronRecord: Record<string, unknown>) {
	return {
		args: ["connect", String(electronRecord.port ?? "9")],
		command: "connect",
		electron: { action: "launch", launch: electronRecord, status: "attached" },
		exitCode: 0,
		managedSessionOutcome: {
			activeAfter: true,
			activeBefore: false,
			attemptedSessionName: sessionName,
			currentSessionName: sessionName,
			previousSessionName: sessionName,
			sessionMode: "fresh",
			status: "created",
			succeeded: true,
			summary: `Managed session ${sessionName} is now current.`,
		},
		resultCategory: "success",
		sessionMode: "fresh",
		sessionName,
		usedImplicitSession: false,
	};
}

function electronCleanupDetails(sessionName: string, electronRecord: Record<string, unknown>) {
	return {
		args: [],
		electron: {
			action: "cleanup",
			cleanup: {
				partial: false,
				records: [{ ...electronRecord, cleanupState: "cleaned", sessionName: undefined }],
				results: [{
					launchId: electronRecord.launchId,
					partial: false,
					record: { ...electronRecord, cleanupState: "cleaned", sessionName: undefined },
					remainingResources: [],
					steps: [
						{ resource: "managed-session", sessionName, state: "removed" },
						{ resource: "process", state: "removed" },
						{ resource: "debug-port", state: "already-gone" },
						{ resource: "user-data-dir", state: "removed" },
					],
					summary: `Electron cleanup for ${String(electronRecord.launchId)} completed.`,
				}],
			},
			status: "succeeded",
		},
		resultCategory: "success",
	};
}

for (const shutdownReason of ["quit", "reload"] as const) {
	test(`agentBrowserExtension keeps Electron cleanup ownership after session_tree switches away from the launch branch (${shutdownReason})`, { concurrency: false }, async () => {
		const tempDir = await mkdtemp(join(tmpdir(), `pi-agent-browser-tree-electron-cleanup-${shutdownReason}-`));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		let child: ChildProcess | undefined;
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, confirmActions: process.env.AGENT_BROWSER_CONFIRM_ACTIONS ?? null }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close") } }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const userDataDir = await createSecureTempDirectory("electron-profile-");
				child = spawnElectronFixtureProcess(userDataDir);
				assert.ok(pidIsAlive(child.pid));
				const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
				const electronSessionName = `${baseSessionName}-fresh-electron-${shutdownReason}`;
				const electronRecord = {
					appName: `Tree Electron ${shutdownReason}`,
					cleanupState: "active",
					createdAtMs: Date.now(),
					executablePath: process.execPath,
					launchId: `electron-branch-${shutdownReason}`,
					launchedByWrapper: true,
					pid: child.pid,
					port: 9,
					processGroupId: child.pid,
					sessionName: electronSessionName,
					userDataDir,
					version: 1,
				};
				const branchA = [createToolBranchEntry({ details: electronManagedSessionDetails(electronSessionName, electronRecord), isError: false })];
				const harness = createExtensionHarness({ cwd: tempDir });
				const selected = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", electronSessionName, "--confirm-actions", "navigate", "open", "about:blank"] });
				assert.equal(selected.isError, false, selected.content[0]?.text);
				harness.setBranch([...harness.ctx.sessionManager.getBranch(), ...branchA]);
				await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
				harness.setBranch([]);
				await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: null, oldLeafId: "branch-a" }, harness.ctx);
				await runExtensionEvent(harness.handlers, "session_shutdown", { reason: shutdownReason }, harness.ctx);

				const invocations = await readInvocationLog(logPath);
				assert.ok(invocations.some((entry) => entry.args.join("\0") === ["--session", electronSessionName, "close"].join("\0")));
				assert.ok((invocations as Array<{ args: string[]; confirmActions?: string }>).filter(entry => entry.args.includes("close")).every(entry => entry.confirmActions === "navigate"), "off-branch Electron cleanup keeps the native setting for its session");
				assert.equal(pidIsAlive(child?.pid), false);
			});
		} finally {
			if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
			await rm(tempDir, { force: true, recursive: true });
		}
	});
}

test("agentBrowserExtension does not double-clean a branch-restored Electron cleanup during shutdown", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-electron-cleaned-shutdown-"));
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
			const userDataDir = join(tempDir, "electron-profile-cleaned-shutdown");
			child = spawnElectronFixtureProcess(userDataDir);
			assert.ok(pidIsAlive(child.pid));
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron-cleaned-shutdown`;
			const electronRecord = {
				appName: "Cleaned Shutdown Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-cleaned-shutdown",
				launchedByWrapper: true,
				pid: child.pid,
				port: 9,
				processGroupId: child.pid,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const launchDetails = electronManagedSessionDetails(electronSessionName, electronRecord);
			const sourceBranch = [
				...Array.from({ length: 8 }, (_value, index) => createToolBranchEntry({
					details: { args: ["get", "title"], command: "get", exitCode: 0, resultCategory: "success", title: `noise-${index}` },
					isError: false,
				})),
				createToolBranchEntry({ details: launchDetails, isError: false }),
			];
			const cleanedBranch = [
				createToolBranchEntry({ details: launchDetails, isError: false }),
				createToolBranchEntry({ details: electronCleanupDetails(electronSessionName, electronRecord), isError: false }),
			];
			const harness = createExtensionHarness({
				branch: sourceBranch,
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			harness.setBranch(cleanedBranch);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-cleaned", oldLeafId: "branch-open" }, harness.ctx);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);

			const closeArgs = (await readInvocationLog(logPath)).map((entry) => entry.args).filter((args) => args.includes("close"));
			assert.deepEqual(closeArgs, []);
			assert.equal(pidIsAlive(child?.pid), true);
		});
	} finally {
		if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension clears namespaced attachment context after Electron cleanup replay", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-cleanup-attached-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { result: "https://safe.example/", url: "https://safe.example/" } }));`);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_PRESERVE_INTERNAL_LAUNCH_FLAGS: "1" }, async () => {
			const sessionName = "caller-owned-electron";
			const namespace = "team";
			const branch = [
				createToolBranchEntry({
					details: {
						args: ["--namespace", namespace, "--session", sessionName, "connect", "9222"],
						attachedBrowserSession: true,
						command: "connect",
						namespace,
						resultCategory: "success",
						sessionName,
					},
					isError: false,
				}),
				createToolBranchEntry({
					details: {
						args: [],
						electron: { cleanup: { results: [{ steps: [{ resource: "managed-session", sessionName, state: "removed" }] }] } },
						namespace,
						resultCategory: "success",
					},
					isError: false,
				}),
			];
			const harness = createExtensionHarness({ branch, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--namespace", namespace, "--session", sessionName, "get", "url"],
			});
			assert.equal(result.isError, false, result.content[0]?.text);
			const invocation = (await readInvocationLog(logPath)).find((entry) => entry.args.includes("get") && entry.args.at(-1) === "url");
			assert.equal(invocation?.args[invocation.args.indexOf("--args") + 1], "--no-startup-window");
			assert.equal(invocation?.args.includes("--allow-file-access"), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps same-process re-owned Electron resources despite stale branch cleanup evidence", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-electron-cleanup-stale-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	let child: ChildProcess | undefined;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
const data = args.includes("close")
  ? { closed: true }
  : { title: "Electron", url: "app://stale-cleanup", sessionName };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const userDataDir = await createSecureTempDirectory("electron-profile-");
			child = spawnElectronFixtureProcess(userDataDir);
			assert.ok(pidIsAlive(child.pid));
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron-stale-cleanup`;
			const electronRecord = {
				appName: "Stale Cleanup Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-stale-cleanup",
				launchedByWrapper: true,
				pid: child.pid,
				port: 9,
				processGroupId: child.pid,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const launchDetails = electronManagedSessionDetails(electronSessionName, electronRecord);
			const branchOpen = [createToolBranchEntry({ details: launchDetails, isError: false })];
			const branchCleaned = [
				createToolBranchEntry({ details: launchDetails, isError: false }),
				createToolBranchEntry({ details: electronCleanupDetails(electronSessionName, electronRecord), isError: false }),
			];
			const harness = createExtensionHarness({ branch: branchOpen, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			harness.setBranch(branchCleaned);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-cleaned", oldLeafId: "branch-open" }, harness.ctx);
			harness.setBranch(branchOpen);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-open", oldLeafId: "branch-cleaned" }, harness.ctx);

			const reactivation = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(reactivation.isError, false, JSON.stringify(reactivation));
			assert.equal(reactivation.details?.sessionName, electronSessionName);

			harness.setBranch([]);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: null, oldLeafId: "branch-open-reactivated" }, harness.ctx);
			harness.setBranch(branchOpen);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-open", oldLeafId: null }, harness.ctx);

			harness.setBranch(branchCleaned);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-cleaned", oldLeafId: "branch-open" }, harness.ctx);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);

			const closeArgs = (await readInvocationLog(logPath)).map((entry) => entry.args).filter((args) => args.includes("close"));
			assert.deepEqual(closeArgs, [["--session", electronSessionName, "close"]]);
			assert.equal(pidIsAlive(child?.pid), false);
		});
	} finally {
		if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves branch ownership of untouched Electron launch after targeted cleanup", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-untouched-cleanup-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	let childA: ChildProcess | undefined;
	let childB: ChildProcess | undefined;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
const data = args.includes("close")
  ? { closed: true }
  : { title: "Electron", url: "app://untouched", sessionName };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const userDataDirA = await createSecureTempDirectory("electron-profile-a-");
			const userDataDirB = await createSecureTempDirectory("electron-profile-b-");
			childA = spawnElectronFixtureProcess(userDataDirA);
			childB = spawnElectronFixtureProcess(userDataDirB);
			assert.ok(pidIsAlive(childA.pid));
			assert.ok(pidIsAlive(childB.pid));
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const sessionNameA = `${baseSessionName}-fresh-electron-a`;
			const sessionNameB = `${baseSessionName}-fresh-electron-b`;
			const recordA = {
				appName: "Electron A",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-a",
				launchedByWrapper: true,
				pid: childA.pid,
				port: 9,
				processGroupId: childA.pid,
				sessionName: sessionNameA,
				userDataDir: userDataDirA,
				version: 1,
			};
			const recordB = {
				appName: "Electron B",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-b",
				launchedByWrapper: true,
				pid: childB.pid,
				port: 10,
				processGroupId: childB.pid,
				sessionName: sessionNameB,
				userDataDir: userDataDirB,
				version: 1,
			};
			const launchDetailsA = electronManagedSessionDetails(sessionNameA, recordA);
			const launchDetailsB = electronManagedSessionDetails(sessionNameB, recordB);
			const branchBoth = [
				createToolBranchEntry({ details: launchDetailsA, isError: false }),
				createToolBranchEntry({ details: launchDetailsB, isError: false }),
			];
			const branchBCleaned = [
				createToolBranchEntry({ details: launchDetailsA, isError: false }),
				createToolBranchEntry({ details: launchDetailsB, isError: false }),
				createToolBranchEntry({ details: electronCleanupDetails(sessionNameB, recordB), isError: false }),
			];
			const harness = createExtensionHarness({ branch: branchBoth, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const cleanupA = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "cleanup", launchId: "electron-a", timeoutMs: 15_000 },
			});
			assert.equal(cleanupA.isError, false, JSON.stringify(cleanupA));
			assert.equal(pidIsAlive(childA?.pid), false);
			assert.equal(pidIsAlive(childB?.pid), true);

			harness.setBranch(branchBCleaned);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "b-cleaned", oldLeafId: "both-active" }, harness.ctx);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);

			const invocations = await readInvocationLog(logPath);
			const closeArgs = invocations.map((entry) => entry.args).filter((args) => args.includes("close"));
			const closedSessions = closeArgs.map((args) => {
				const idx = args.indexOf("--session");
				return idx >= 0 ? args[idx + 1] : undefined;
			}).filter((s): s is string => typeof s === "string");
			assert.ok(!closedSessions.includes(sessionNameB), `B should not be closed again after branch cleanup evidence, but got: ${JSON.stringify(closedSessions)}`);
			assert.equal(pidIsAlive(childB?.pid), true);
		});
	} finally {
		if (pidIsAlive(childA?.pid)) childA?.kill("SIGKILL");
		if (pidIsAlive(childB?.pid)) childB?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves branch ownership of Electron launch after failing explicit-session command", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-failed-cmd-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	let child: ChildProcess | undefined;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
if (args.includes("close")) {
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else if (sessionName) {
  process.stderr.write("upstream error");
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Electron", url: "app://failed-cmd", sessionName } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const userDataDir = await createSecureTempDirectory("electron-profile-failed-");
			child = spawnElectronFixtureProcess(userDataDir);
			assert.ok(pidIsAlive(child.pid));
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron-failed`;
			const electronRecord = {
				appName: "Failed Cmd Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-failed",
				launchedByWrapper: true,
				pid: child.pid,
				port: 9,
				processGroupId: child.pid,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const launchDetails = electronManagedSessionDetails(electronSessionName, electronRecord);
			const branchOpen = [createToolBranchEntry({ details: launchDetails, isError: false })];
			const branchCleaned = [
				createToolBranchEntry({ details: launchDetails, isError: false }),
				createToolBranchEntry({ details: electronCleanupDetails(electronSessionName, electronRecord), isError: false }),
			];
			const harness = createExtensionHarness({ branch: branchOpen, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const failedCmd = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", electronSessionName, "get", "url"],
			});
			assert.equal(failedCmd.isError, true, "Command should have failed");

			harness.setBranch(branchCleaned);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "cleaned", oldLeafId: "open" }, harness.ctx);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);

			const closeArgs = (await readInvocationLog(logPath)).map((entry) => entry.args).filter((args) => args.includes("close"));
			assert.deepEqual(closeArgs, [], `Should not have closed the session after branch cleanup evidence, but got: ${JSON.stringify(closeArgs)}`);
			assert.equal(pidIsAlive(child?.pid), true);
		});
	} finally {
		if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension exposes off-branch owned Electron records to status, probe, and cleanup by launchId", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-electron-status-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	let child: ChildProcess | undefined;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("title")) process.stdout.write(JSON.stringify({ success: true, data: { result: "Off Branch App" } }));
else if (args.includes("url")) process.stdout.write(JSON.stringify({ success: true, data: { result: "app://off-branch" } }));
else if (args.includes("tab") && args.includes("list")) process.stdout.write(JSON.stringify({ success: true, data: [{ active: true, title: "Off Branch App", url: "app://off-branch" }] }));
else if (args.includes("snapshot")) process.stdout.write(JSON.stringify({ success: true, data: { origin: "app://off-branch", refs: {}, snapshot: "" } }));
else process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close") } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const userDataDir = await createSecureTempDirectory("electron-profile-");
			child = spawnElectronFixtureProcess(userDataDir);
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron-status`;
			const electronRecord = {
				appName: "Off Branch Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-off-branch-status",
				launchedByWrapper: true,
				pid: child.pid,
				port: 9,
				processGroupId: child.pid,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const harness = createExtensionHarness({
				branch: [createToolBranchEntry({ details: electronManagedSessionDetails(electronSessionName, electronRecord), isError: false })],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			harness.setBranch([]);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: null, oldLeafId: "branch-a" }, harness.ctx);

			const status = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "status", launchId: electronRecord.launchId } });
			assert.equal(status.isError, false, JSON.stringify(status));
			assert.equal((status.details?.electron as { identifiers?: { launchId?: string } } | undefined)?.identifiers?.launchId, electronRecord.launchId);

			const probe = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", launchId: electronRecord.launchId } });
			assert.equal(probe.isError, false, JSON.stringify(probe));
			assert.equal((probe.details?.electron as { probeContext?: { launchId?: string } } | undefined)?.probeContext?.launchId, electronRecord.launchId);

			const cleanup = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: electronRecord.launchId } });
			assert.equal(cleanup.isError, false, JSON.stringify(cleanup));
			assert.equal(pidIsAlive(child?.pid), false);
		});
	} finally {
		if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension restores headed autosave policy for an off-current Electron session", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-resume-electron-headed-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	let child: ChildProcess | undefined;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, autosave: process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS ?? null }) + "\\n");
if (args.includes("session") && args.includes("info")) process.stdout.write(JSON.stringify({ success: true, data: { active: false, runtime: null } }));
else if (args.includes("title")) process.stdout.write(JSON.stringify({ success: true, data: { result: "Headed Electron" } }));
else if (args.includes("url")) process.stdout.write(JSON.stringify({ success: true, data: { result: "app://headed-electron" } }));
else if (args.includes("tab") && args.includes("list")) process.stdout.write(JSON.stringify({ success: true, data: [{ active: true, title: "Headed Electron", url: "app://headed-electron" }] }));
else if (args.includes("snapshot")) process.stdout.write(JSON.stringify({ success: true, data: { origin: "app://headed-electron", refs: {}, snapshot: "" } }));
else process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close") } }));`,
	);

	try {
		await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined, PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const userDataDir = await createSecureTempDirectory("electron-profile-");
			child = spawnElectronFixtureProcess(userDataDir);
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron-headed`;
			const replacementSessionName = `${baseSessionName}-fresh-replacement`;
			const electronRecord = {
				appName: "Headed Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-resumed-headed",
				launchedByWrapper: true,
				pid: child.pid,
				port: 9,
				processGroupId: child.pid,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const electronDetails = {
				...electronManagedSessionDetails(electronSessionName, electronRecord),
				managedSessionHeadedAutosaveDisabled: true,
			};
			const replacementDetails = {
				args: ["--session", replacementSessionName, "open", "https://example.com/replacement"],
				command: "open",
				exitCode: 0,
				managedSessionOutcome: {
					activeAfter: true,
					activeBefore: true,
					attemptedSessionName: replacementSessionName,
					currentSessionName: replacementSessionName,
					previousSessionName: electronSessionName,
					replacedSessionName: electronSessionName,
					sessionMode: "fresh",
					status: "replaced",
					succeeded: true,
					summary: `Managed session ${electronSessionName} was replaced by ${replacementSessionName}.`,
				},
				resultCategory: "success",
				sessionMode: "fresh",
				sessionName: replacementSessionName,
				usedImplicitSession: true,
			};
			const harness = createExtensionHarness({
				branch: [
					createToolBranchEntry({ details: electronDetails, isError: false }),
					createToolBranchEntry({ details: replacementDetails, isError: false }),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const status = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "status", launchId: electronRecord.launchId } });
			assert.equal(status.isError, false, JSON.stringify(status));
			const probe = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", launchId: electronRecord.launchId } });
			assert.equal(probe.isError, false, JSON.stringify(probe));
			assert.equal(probe.details?.managedSessionHeadedAutosaveDisabled, true, JSON.stringify(probe.details));

			const resumedHarness = createExtensionHarness({
				branch: harness.ctx.sessionManager.getBranch().slice(),
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);
			await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "1000" }, async () => {
				const blockedProbe = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, { electron: { action: "probe", launchId: electronRecord.launchId } });
				assert.equal(blockedProbe.isError, true, JSON.stringify(blockedProbe));
				assert.match(String(blockedProbe.details?.summary), /cannot change a running wrapper-owned headed session/);
			});
			const resumedProbe = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, { electron: { action: "probe", launchId: electronRecord.launchId } });
			assert.equal(resumedProbe.isError, false, JSON.stringify(resumedProbe));
			const cleanup = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, { electron: { action: "cleanup", launchId: electronRecord.launchId } });
			assert.equal(cleanup.isError, false, JSON.stringify(cleanup));

			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.length >= 13, JSON.stringify(invocations));
			assert.equal(invocations.every((entry) => entry.autosave === "0"), true, JSON.stringify(invocations));
			assert.equal(pidIsAlive(child?.pid), false);
		});
	} finally {
		if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not reuse current Electron managed session after cleanup", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-current-cleanup-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close"), result: "ok", url: "app://current-cleanup" } }));`,
	);
	const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
	const electronSessionName = `${baseSessionName}-fresh-electron-current-cleanup`;
	const electronRecord = {
		appName: "Current Cleanup Electron",
		cleanupState: "active",
		createdAtMs: Date.now(),
		executablePath: process.execPath,
		launchId: "electron-current-cleanup",
		launchedByWrapper: true,
		port: 9,
		sessionName: electronSessionName,
		userDataDir: join(tempDir, "electron-profile-current-cleanup"),
		version: 1,
	};

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({
				branch: [createToolBranchEntry({ details: electronManagedSessionDetails(electronSessionName, electronRecord), isError: false })],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			const cleanup = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: electronRecord.launchId } });
			assert.equal(cleanup.isError, false, JSON.stringify(cleanup));

			const followUp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(followUp.isError, false, JSON.stringify(followUp));
			const followUpSessionName = followUp.details?.sessionName;
			assertIsString(followUpSessionName);
			assert.match(followUpSessionName, new RegExp(`^${baseSessionName}-fresh-[a-f0-9]{10}$`));
			assert.notEqual(followUpSessionName, electronSessionName);
			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args, ["--session", electronSessionName, "close"]);
			assert.deepEqual(invocations.map((entry) => entry.sessionName), [electronSessionName, followUpSessionName, followUpSessionName]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps Electron cleanup post-close reservation across same-process session_tree restore", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-cleanup-tree-reserve-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close"), result: "ok", url: "app://tree-cleanup" } }));`,
	);
	const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
	const electronSessionName = `${baseSessionName}-fresh-electron-tree-cleanup`;
	const electronRecord = {
		appName: "Tree Cleanup Electron",
		cleanupState: "active",
		createdAtMs: Date.now(),
		executablePath: process.execPath,
		launchId: "electron-tree-cleanup",
		launchedByWrapper: true,
		port: 9,
		sessionName: electronSessionName,
		userDataDir: join(tempDir, "electron-profile-tree-cleanup"),
		version: 1,
	};

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const launchDetails = electronManagedSessionDetails(electronSessionName, electronRecord);
			const harness = createExtensionHarness({
				branch: [createToolBranchEntry({ details: launchDetails, isError: false })],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			const cleanup = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: electronRecord.launchId } });
			assert.equal(cleanup.isError, false, JSON.stringify(cleanup));
			const cleanupBranch = harness.ctx.sessionManager.getBranch().slice();

			harness.setBranch(cleanupBranch);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "cleanup", oldLeafId: "live" }, harness.ctx);
			const firstFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(firstFollowUp.isError, false, JSON.stringify(firstFollowUp));
			const firstFollowUpSessionName = firstFollowUp.details?.sessionName;
			assertIsString(firstFollowUpSessionName);
			assert.match(firstFollowUpSessionName, new RegExp(`^${baseSessionName}-fresh-[a-f0-9]{10}$`));
			assert.notEqual(firstFollowUpSessionName, electronSessionName);

			const closeFirstFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", firstFollowUpSessionName, "close"] });
			assert.equal(closeFirstFollowUp.isError, false, JSON.stringify(closeFirstFollowUp));
			const reservedAfterClose = (closeFirstFollowUp.details?.managedSessionOutcome as { currentSessionName?: string } | undefined)?.currentSessionName;
			assertIsString(reservedAfterClose);
			assert.notEqual(reservedAfterClose, firstFollowUpSessionName);

			harness.setBranch(cleanupBranch);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "cleanup", oldLeafId: "follow-up" }, harness.ctx);
			const secondFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(secondFollowUp.isError, false, JSON.stringify(secondFollowUp));
			assert.equal(secondFollowUp.details?.sessionName, reservedAfterClose);

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations.map((entry) => entry.sessionName), [
				electronSessionName,
				firstFollowUpSessionName,
				firstFollowUpSessionName,
				firstFollowUpSessionName,
				reservedAfterClose,
				reservedAfterClose,
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not restore Electron managed session after cleanup result", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-cleanup-restore-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { result: "ok", url: "app://restore-cleanup" } }));`,
	);
	const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
	const electronSessionName = `${baseSessionName}-fresh-electron-restore-cleanup`;
	const electronRecord = {
		appName: "Restore Cleanup Electron",
		cleanupState: "active",
		createdAtMs: Date.now(),
		executablePath: process.execPath,
		launchId: "electron-restore-cleanup",
		launchedByWrapper: true,
		port: 9,
		sessionName: electronSessionName,
		userDataDir: join(tempDir, "electron-profile-restore-cleanup"),
		version: 1,
	};
	const branch = [
		createToolBranchEntry({ details: electronManagedSessionDetails(electronSessionName, electronRecord), isError: false }),
		createToolBranchEntry({ details: electronCleanupDetails(electronSessionName, electronRecord), isError: false }),
	];

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ branch, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			const followUp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(followUp.isError, false, JSON.stringify(followUp));
			const restoredGeneratedSessionName = followUp.details?.sessionName;
			assertIsString(restoredGeneratedSessionName);
			assert.match(restoredGeneratedSessionName, new RegExp(`^${baseSessionName}-fresh-[a-f0-9]{10}$`));
			assert.notEqual(restoredGeneratedSessionName, electronSessionName);

			const closeRestoredGenerated = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--session", restoredGeneratedSessionName, "close"] });
			assert.equal(closeRestoredGenerated.isError, false, JSON.stringify(closeRestoredGenerated));
			const finalFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(finalFollowUp.isError, false, JSON.stringify(finalFollowUp));
			const finalSessionName = finalFollowUp.details?.sessionName;
			assertIsString(finalSessionName);
			assert.match(finalSessionName, new RegExp(`^${baseSessionName}-fresh-[a-f0-9]{10}$`));
			assert.notEqual(finalSessionName, electronSessionName);
			assert.notEqual(finalSessionName, restoredGeneratedSessionName);

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations.map((entry) => entry.sessionName), [restoredGeneratedSessionName, restoredGeneratedSessionName, restoredGeneratedSessionName, finalSessionName, finalSessionName]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension preserves active branch Electron launch across reload", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-reload-active-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	let child: ChildProcess | undefined;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionName = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, sessionName }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close"), result: "ok", url: "app://reload-active" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const userDataDir = await createSecureTempDirectory("electron-profile-");
			child = spawnElectronFixtureProcess(userDataDir);
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron-reload-active`;
			const electronRecord = {
				appName: "Reload Active Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-reload-active",
				launchedByWrapper: true,
				pid: child.pid,
				port: 9,
				processGroupId: child.pid,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const branch = [createToolBranchEntry({ details: electronManagedSessionDetails(electronSessionName, electronRecord), isError: false })];
			const harness = createExtensionHarness({ branch, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "reload" }, harness.ctx);
			assert.equal(pidIsAlive(child.pid), true);
			assert.equal(await directoryExists(userDataDir), true);
			assert.equal((await readInvocationLog(logPath)).some((entry) => entry.args.includes("close")), false);

			const reloadedHarness = createExtensionHarness({ branch, cwd: tempDir });
			await runExtensionEvent(reloadedHarness.handlers, "session_start", { reason: "reload" }, reloadedHarness.ctx);
			const followUp = await executeRegisteredTool(reloadedHarness.tool, reloadedHarness.ctx, { args: ["get", "url"] });
			assert.equal(followUp.isError, false, JSON.stringify(followUp));
			assert.equal(followUp.details?.sessionName, electronSessionName);
			await runExtensionEvent(reloadedHarness.handlers, "session_shutdown", { reason: "quit" }, reloadedHarness.ctx);
			assert.equal(pidIsAlive(child.pid), false);
			assert.equal(await directoryExists(userDataDir), false);
		});
	} finally {
		if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reuses only verified tracked Electron connections after reload", { concurrency: false }, async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "piab-electron-reload-"));
	const logPath = join(tempDir, "invocations.log");
	const connectionPath = join(tempDir, "connection.json");
	let child: ChildProcess | undefined;
	let userDataDir: string | undefined;
	let liveBrowserEndpoint: string;
	let pageEndpoint: string;
	const server = createServer((request, response) => {
		// Undici's parser timer can outlive this fixture when setTimeout is mocked below.
		response.writeHead(pidIsAlive(child?.pid) ? 200 : 503, { "content-type": "application/json", connection: "close" });
		response.end(JSON.stringify(request.url === "/json/version"
			? { Browser: "Electron/Test", webSocketDebuggerUrl: liveBrowserEndpoint }
			: [{ id: "page", type: "page", url: "app://reload-verified", webSocketDebuggerUrl: pageEndpoint }]));
	});
	const port = await listenOnLoopback(server);
	const browserEndpoint = `ws://127.0.0.1:${port}/devtools/browser/original`;
	liveBrowserEndpoint = browserEndpoint;
	pageEndpoint = `ws://127.0.0.1:${port}/devtools/page/page`;
	await writeFile(connectionPath, JSON.stringify({ active: true, cdpUrl: pageEndpoint }));
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
const connection = JSON.parse(fs.readFileSync(${JSON.stringify(connectionPath)}, "utf8"));
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("cdp-url") && connection.readyPath) {
  process.on("SIGTERM", () => process.exit(0));
  fs.writeFileSync(connection.readyPath, String(process.pid));
  setInterval(() => {}, 1000);
  return;
}
let data = { url: "app://reload-verified", title: "Verified Electron" };
if (args.includes("session") && args.includes("info")) data = { active: connection.active, runtime: { restoreKey: null } };
else if (args.includes("cdp-url")) data = { cdpUrl: connection.cdpUrl };
else if (args.includes("tab")) data = { tabs: [{ tabId: "t1", active: true, url: data.url, title: data.title }] };
else if (args.includes("snapshot")) data = { origin: data.url, snapshot: '- button "Run" [ref=e1]', refs: { e1: { role: "button", name: "Run" } } };
else if (args.includes("close")) { fs.writeFileSync(${JSON.stringify(connectionPath)}, JSON.stringify({ ...connection, active: false })); data = { closed: true }; }
process.stdout.write(JSON.stringify({ success: true, data }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}`, AGENT_BROWSER_NAMESPACE: "reload-team", PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			userDataDir = await createSecureTempDirectory("electron-profile-");
			child = spawnElectronFixtureProcess(userDataDir);
			const sessionName = `${createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed")}-fresh-electron-verified`;
			const record = { appName: "Verified Electron", cleanupState: "active", createdAtMs: Date.now(), executablePath: process.execPath, launchId: "electron-reload-verified", launchedByWrapper: true, namespace: "reload-team", pid: child.pid, port, processGroupId: child.pid, sessionName, userDataDir, version: 1, webSocketDebuggerUrl: browserEndpoint };
			const branch = (launch = record) => [createToolBranchEntry({ details: { ...electronManagedSessionDetails(sessionName, launch), attachedBrowserSession: true, managedSessionRestoreDisabled: true, namespace: "reload-team" }, isError: false })];
			const previous = createExtensionHarness({ branch: branch(), cwd: tempDir });
			await runExtensionEvent(previous.handlers, "session_start", { reason: "resume" }, previous.ctx);
			await runExtensionEvent(previous.handlers, "session_shutdown", { reason: "reload" }, previous.ctx);
			assert.equal(pidIsAlive(child.pid), true);
			assert.equal(await directoryExists(userDataDir), true);

			for (const mismatch of ["browser-instance", "connection", "namespace"]) {
				liveBrowserEndpoint = mismatch === "browser-instance" ? browserEndpoint + "-replaced" : browserEndpoint;
				await writeFile(connectionPath, JSON.stringify({ active: true, cdpUrl: mismatch === "connection" ? pageEndpoint + "-other" : pageEndpoint }));
				const harness = createExtensionHarness({ branch: branch(mismatch === "namespace" ? { ...record, namespace: "other" } : record), cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "reload" }, harness.ctx);
				const before = (await readInvocationLog(logPath)).length;
				for (let attempt = 0; attempt < 2; attempt += 1) {
					const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "title"] });
					assert.equal(result.isError, true, `${mismatch}: ${JSON.stringify(result)}`);
					assert.equal(result.details?.managedSessionCleanupOnlyReason, "restore-disabled-daemon-without-provenance");
				}
				assert.equal((await readInvocationLog(logPath)).slice(before).some((entry) => entry.args.includes("title")), false);
			}

			liveBrowserEndpoint = browserEndpoint;
			await writeFile(connectionPath, JSON.stringify({ active: true, cdpUrl: pageEndpoint }));
			let lastHarness = previous;
			for (const params of [
				{ args: ["get", "title"] },
				{ args: ["--namespace", "reload-team", "--session", sessionName, "get", "title"] },
				{ electron: { action: "status", launchId: record.launchId } },
				{ electron: { action: "probe", launchId: record.launchId } },
			]) {
				const harness = createExtensionHarness({ branch: branch(), cwd: tempDir });
				lastHarness = harness;
				await runExtensionEvent(harness.handlers, "session_start", { reason: "reload" }, harness.ctx);
				const before = (await readInvocationLog(logPath)).length;
				const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
				assert.equal(result.isError, false, JSON.stringify(result));
				assert.match(JSON.stringify(result.content), /Verified Electron/);
				assert.doesNotMatch(JSON.stringify(result.content), /Managed session warning/);
				const verification = (await readInvocationLog(logPath)).slice(before).filter((entry) => entry.args.includes("cdp-url"));
				assert.deepEqual(verification.map((entry) => entry.args), [["--json", "--namespace", "reload-team", "--session", sessionName, "get", "cdp-url"]]);
				assert.equal(pidIsAlive(child.pid), true);
			}
			for (const mode of ["timeout", "abort"]) {
				const marker = `cdp-${mode}-ready`;
				await writeFile(connectionPath, JSON.stringify({ active: true, cdpUrl: pageEndpoint, readyPath: join(tempDir, marker) }));
				const harness = createExtensionHarness({ branch: branch(), cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "reload" }, harness.ctx);
				const controller = new AbortController();
				const ready = (async () => {
					for await (const event of watch(tempDir, { signal: controller.signal })) {
						if (event.filename === marker) return;
					}
				})();
				const realSetTimeout = setTimeout;
				let guard: NodeJS.Timeout | undefined;
				t.mock.timers.enable({ apis: ["setTimeout"] });
				const pending = executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", launchId: record.launchId, timeoutMs: 500 } }, controller.signal);
				try {
					await Promise.race([ready, pending.then((result) => assert.fail(`Verification settled before its controlled read: ${JSON.stringify(result)}`))]);
					if (mode === "timeout") t.mock.timers.tick(500);
					else controller.abort();
					const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
						guard = realSetTimeout(() => reject(new Error(`Electron verification must honor the caller's ${mode}`)), 1000);
					})]);
					assert.equal(result.isError, true, JSON.stringify(result));
					const pid = Number(await readFile(join(tempDir, marker), "utf8"));
					assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
				} finally {
					t.mock.timers.reset();
					controller.abort();
					if (guard) clearTimeout(guard);
					await Promise.allSettled([pending, ready]);
				}
			}
			await runExtensionEvent(lastHarness.handlers, "session_shutdown", { reason: "quit" }, lastHarness.ctx);
			assert.equal(pidIsAlive(child.pid), false);
			assert.equal(await directoryExists(userDataDir), false);
		});
	} finally {
		if (child?.pid && child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
		await rm(tempDir, { recursive: true, force: true });
	}
});

for (const shutdownReason of ["reload", "quit"] as const) {
	test(`agentBrowserExtension preserves off-branch Electron profile when ${shutdownReason} cleanup is partial`, { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), `pi-agent-browser-electron-${shutdownReason}-partial-`));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	let child: ChildProcess | undefined;
	let preservedUserDataDir: string | undefined;
	let versionProbeCount = 0;
	const server = createServer((request, response) => {
		if (request.url === "/json/version") {
			versionProbeCount += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ Browser: "Electron/Test", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/test" }));
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify([]));
	});
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close") } }));`,
	);

	try {
		const port = await listenOnLoopback(server);
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const userDataDir = await createSecureTempDirectory("electron-profile-");
			preservedUserDataDir = userDataDir;
			child = spawnElectronFixtureProcess(userDataDir);
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron-${shutdownReason}-partial`;
			const electronRecord = {
				appName: `${shutdownReason} Partial Electron`,
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: `electron-${shutdownReason}-partial`,
				launchedByWrapper: true,
				pid: child.pid,
				port,
				processGroupId: child.pid,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const branchA = [createToolBranchEntry({ details: electronManagedSessionDetails(electronSessionName, electronRecord), isError: false })];
			const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			harness.setBranch([]);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-empty", oldLeafId: "branch-a" }, harness.ctx);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: shutdownReason }, harness.ctx);

			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.join("\0") === ["--session", electronSessionName, "close"].join("\0")));
			assert.ok(versionProbeCount > 0);
			assert.equal(pidIsAlive(child.pid), false);
			assert.equal(await directoryExists(userDataDir), true);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: shutdownReason }, harness.ctx);
			assert.equal(await directoryExists(userDataDir), true);
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
		if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
		if (preservedUserDataDir) await rm(preservedUserDataDir, { force: true, recursive: true }).catch(() => undefined);
		await rm(tempDir, { force: true, recursive: true });
	}
	});
}

test("agentBrowserExtension does not promote unrelated off-branch Electron launches after targeted cleanup", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-cleanup-promote-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	let childA: ChildProcess | undefined;
	let childB: ChildProcess | undefined;
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: args.includes("close"), result: "ok" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const userDataDirA = await createSecureTempDirectory("electron-profile-");
			const userDataDirB = await createSecureTempDirectory("electron-profile-");
			childA = spawnElectronFixtureProcess(userDataDirA);
			childB = spawnElectronFixtureProcess(userDataDirB);
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const sessionA = `${baseSessionName}-fresh-electron-a`;
			const sessionB = `${baseSessionName}-fresh-electron-b`;
			const recordA = {
				appName: "Target Cleanup Electron A",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-target-a",
				launchedByWrapper: true,
				pid: childA.pid,
				port: 9,
				processGroupId: childA.pid,
				sessionName: sessionA,
				userDataDir: userDataDirA,
				version: 1,
			};
			const recordB = {
				appName: "Unrelated Electron B",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-unrelated-b",
				launchedByWrapper: true,
				pid: childB.pid,
				port: 9,
				processGroupId: childB.pid,
				sessionName: sessionB,
				userDataDir: userDataDirB,
				version: 1,
			};
			const branchA = [createToolBranchEntry({ details: electronManagedSessionDetails(sessionA, recordA), isError: false })];
			const branchB = [createToolBranchEntry({ details: electronManagedSessionDetails(sessionB, recordB), isError: false })];
			const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			harness.setBranch(branchB);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-b", oldLeafId: "branch-a" }, harness.ctx);
			harness.setBranch([]);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "branch-empty", oldLeafId: "branch-b" }, harness.ctx);

			const cleanupA = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: "electron-target-a" } });
			assert.equal(cleanupA.isError, false, JSON.stringify(cleanupA));
			assert.equal(pidIsAlive(childA.pid), false);
			assert.equal(await directoryExists(userDataDirA), false);
			assert.equal(await directoryExists(userDataDirB), true);

			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "reload" }, harness.ctx);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.join("\0") === ["--session", sessionB, "close"].join("\0")));
			assert.equal(pidIsAlive(childB.pid), false);
			assert.equal(await directoryExists(userDataDirB), false);
		});
	} finally {
		if (pidIsAlive(childA?.pid)) childA?.kill("SIGKILL");
		if (pidIsAlive(childB?.pid)) childB?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension serializes explicit Electron cleanup behind in-flight managed commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-cleanup-queue-"));
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
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "app://slow", refs: {}, snapshot: "" } }));
} else if (args.includes("close")) {
  log("close");
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else {
  log("command");
  process.stdout.write(JSON.stringify({ success: true, data: { result: "ok" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const userDataDir = await createSecureTempDirectory("electron-profile-");
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron-queue`;
			const electronRecord = {
				appName: "Queued Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-cleanup-queue",
				launchedByWrapper: true,
				port: 9,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const harness = createExtensionHarness({
				branch: [createToolBranchEntry({ details: electronManagedSessionDetails(electronSessionName, electronRecord), isError: false })],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			const snapshotPromise = executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			while (!(await readInvocationLog(logPath)).some((entry) => entry.event === "snapshot-start")) await delay(10);

			const cleanupPromise = executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: electronRecord.launchId } });
			await delay(50);
			assert.equal((await readInvocationLog(logPath)).some((entry) => entry.event === "close"), false);
			await writeFile(releasePath, "go");
			const [snapshot, cleanup] = await Promise.all([snapshotPromise, cleanupPromise]);
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.equal(cleanup.isError, false, JSON.stringify(cleanup));
			const events = (await readInvocationLog(logPath)).map((entry) => entry.event);
			assert.ok(events.indexOf("snapshot-done") >= 0);
			assert.ok(events.indexOf("close") > events.indexOf("snapshot-done"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension untracks managed sessions after partial Electron cleanup closes the session", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-partial-close-"));
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
	const electronSessionName = `${baseSessionName}-fresh-electron-partial`;
	const electronRecord = {
		appName: "Partial Electron",
		cleanupState: "active",
		createdAtMs: Date.now(),
		executablePath: process.execPath,
		launchId: "electron-partial-close",
		launchedByWrapper: true,
		pid: process.pid,
		port: 9,
		sessionName: electronSessionName,
		userDataDir: join(tempDir, "not-owned-electron-profile"),
		version: 1,
	};

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({
				branch: [createToolBranchEntry({ details: electronManagedSessionDetails(electronSessionName, electronRecord), isError: false })],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			const cleanup = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: electronRecord.launchId } });
			assert.equal(cleanup.isError, true, JSON.stringify(cleanup));
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx);

			const closeArgs = (await readInvocationLog(logPath)).map((entry) => entry.args).filter((args) => args.includes("close"));
			assert.deepEqual(closeArgs, [["--session", electronSessionName, "close"]]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
