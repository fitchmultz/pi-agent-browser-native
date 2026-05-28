/**
 * Purpose: Verify extension entrypoint page-scoped ref guards and session target restoration.
 * Responsibilities: Assert stale-ref preflight, batch invalidation latches, snapshot ref recording, and diagnostic URL filtering.
 * Scope: Integration-style Node test-runner coverage for ref/page-state behavior split out of the broad extension-validation suite.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-ref-guards.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

async function directoryExists(path: string): Promise<boolean> {
	return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}

function spawnElectronFixtureProcess(userDataDir: string): ChildProcess {
	const child = spawn("/bin/sh", ["-c", "while true; do sleep 1; done", "pi-agent-browser-electron-fixture", `--user-data-dir=${userDataDir}`], { detached: true, stdio: "ignore" });
	child.unref();
	return child;
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
			child = spawnElectronFixtureProcess(userDataDir);
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
				processGroupId: child.pid,
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
			assert.notEqual(followUp.details?.sessionName, electronSessionName);
			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args, ["--session", electronSessionName, "close"]);
			assert.notEqual(invocations.at(-1)?.sessionName, electronSessionName);
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
			assert.notEqual(followUp.details?.sessionName, electronSessionName);
			const invocations = await readInvocationLog(logPath);
			assert.notEqual(invocations[0]?.sessionName, electronSessionName);
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

test("agentBrowserExtension cleans off-branch Electron launches during reload", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-reload-offbranch-"));
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
			child = spawnElectronFixtureProcess(userDataDir);
			const baseSessionName = createImplicitSessionName(TEST_SESSION_ID, tempDir, "test-seed");
			const electronSessionName = `${baseSessionName}-fresh-electron-reload-offbranch`;
			const electronRecord = {
				appName: "Reload Offbranch Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-reload-offbranch",
				launchedByWrapper: true,
				pid: child.pid,
				port: 9,
				processGroupId: child.pid,
				sessionName: electronSessionName,
				userDataDir,
				version: 1,
			};
			const branchA = [createToolBranchEntry({ details: electronManagedSessionDetails(electronSessionName, electronRecord), isError: false })];
			const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
			harness.setBranch([]);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: null, oldLeafId: "branch-a" }, harness.ctx);
			await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "reload" }, harness.ctx);

			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.join("\0") === ["--session", electronSessionName, "close"].join("\0")));
			assert.equal(pidIsAlive(child.pid), false);
		});
	} finally {
		if (pidIsAlive(child?.pid)) child?.kill("SIGKILL");
		await rm(tempDir, { force: true, recursive: true });
	}
});

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
