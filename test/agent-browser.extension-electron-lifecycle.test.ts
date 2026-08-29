/**
 * Purpose: Verify Electron launch, handoff, probe, post-command health, and no-active-page lifecycle contracts.
 * Responsibilities: Assert Electron launch, handoff, probe, post-command health, and no-active-page lifecycle contracts.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-electron-lifecycle.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Check } from "typebox/value";

import { createManagedSessionRestoreKey, getManagedSessionRestoreScope } from "../extensions/agent-browser/lib/managed-session-restore.js";
import { getSessionPageStateKey, SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

import {
	fakeAgentBrowserLifecycleScript,
	stopTestPid,
	waitForTestPidExit,
	writeFakeLaunchableElectronApp,
	writeFakeLinuxElectronBinary,
	writeFakeMacElectronApp,
} from "./helpers/extension-validation-fixtures.js";

async function waitForLoggedCommand(logPath: string, command: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await readInvocationLog(logPath)).some((entry) => entry.args.includes(command))) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${command} invocation.`);
}

test("agentBrowserExtension accepts action-specific electron schema and routes list without upstream spawn", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-schema-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: "should not run" }));`,
	);
	if (process.platform === "darwin") {
		await mkdir(join(tempDir, "Applications"), { recursive: true });
		await writeFakeMacElectronApp({ applicationsDir: join(tempDir, "Applications"), bundleId: "md.obsidian", name: "Obsidian" });
	} else if (process.platform === "linux") {
		const executablePath = await writeFakeLinuxElectronBinary(tempDir, "obsidian");
		const desktopDir = join(tempDir, ".local", "share", "applications");
		await mkdir(desktopDir, { recursive: true });
		await writeFile(join(desktopDir, "obsidian.desktop"), `[Desktop Entry]\nType=Application\nName=Obsidian\nExec=${executablePath}\n`, "utf8");
	}

	try {
		await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list" } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", maxResults: 10, query: "code" } }), true);
			assert.equal(Check(harness.tool.parameters, {
				electron: {
					action: "launch",
					allow: ["Code"],
					appArgs: ["--safe-mode"],
					appName: "Code",
					deny: ["Slack"],
					handoff: "tabs",
					targetType: "webview",
					timeoutMs: 1_000,
				},
			}), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", launchId: "launch-1", timeoutMs: 1_000 } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", timeoutMs: 1_000 } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "cleanup", all: true, timeoutMs: 1_000 } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", all: true, launchId: "launch-1" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "cleanup", all: true, launchId: "launch-1" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", all: false } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "cleanup", all: false } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: {} }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "probe" } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "probe", launchId: "launch-1", timeoutMs: 1_000 } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "probe", timeoutMs: 0 } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "probe", handoff: "tabs" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "status", handoff: "tabs" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "cleanup", handoff: "tabs" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", launchId: "launch-1" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", query: 42 } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", query: "" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", maxResults: "10" } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "list", maxResults: 1.5 } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "launch", allow: [""] } }), false);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "launch", appName: "Code", appPath: "/Applications/Visual Studio Code.app" } }), true);
			assert.equal(Check(harness.tool.parameters, { electron: { action: "launch", appName: "Code", launchId: "launch-1" } }), false);

			const listResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "list", maxResults: 1, query: "__piab_no_matching_electron_app__" },
			});
			assert.equal(listResult.isError, false);
			assert.match(listResult.content[0]?.text ?? "", /Electron apps \(0 found\):/);
			assert.deepEqual(listResult.details?.compiledElectron, { action: "list", maxResults: 1, query: "__piab_no_matching_electron_app__" });
			assert.equal((listResult.details?.electron as { action?: string; status?: string } | undefined)?.action, "list");
			assert.equal((listResult.details?.electron as { action?: string; status?: string } | undefined)?.status, "succeeded");
			assert.equal(listResult.details?.resultCategory, "success");
			if (process.platform === "darwin" || process.platform === "linux") {
				const sensitiveListResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "list", maxResults: 5, query: "Obsidian" },
				});
				assert.equal(sensitiveListResult.isError, false);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /Obsidian.*\[likely sensitive: notes\]/);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /Review likely-sensitive apps and use caller-owned allow\/deny policy before launch\./);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /Profile note: electron\.launch starts an isolated temporary profile/);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /For already-authenticated desktop app content, do not stop here/);
				assert.match(sensitiveListResult.content[0]?.text ?? "", /launch the normal app with --remote-debugging-port=<port>/);
				const electronDetails = sensitiveListResult.details?.electron as { apps?: Array<{ name?: string; sensitivity?: { categories?: string[]; level?: string } }>; profileIsolation?: { reusesExistingSignedInProfile?: boolean; attachesToAlreadyRunningApp?: boolean; hostDebugLaunchExample?: string }; sensitiveAppCount?: number } | undefined;
				assert.ok((electronDetails?.sensitiveAppCount ?? 0) >= 1);
				assert.equal(electronDetails?.profileIsolation?.reusesExistingSignedInProfile, false);
				assert.equal(electronDetails?.profileIsolation?.attachesToAlreadyRunningApp, false);
				assert.match(electronDetails?.profileIsolation?.hostDebugLaunchExample ?? "", /open -a <App Name> --args --remote-debugging-port=9222/);
				assert.ok(electronDetails?.apps?.some((app) => app.name === "Obsidian" && app.sensitivity?.level === "likely-sensitive" && app.sensitivity.categories?.includes("notes")));
			}
			assert.deepEqual(await readInvocationLog(logPath), []);

			const missingAction = await executeRegisteredTool(harness.tool, harness.ctx, { electron: {} });
			assert.equal(missingAction.isError, true);
			assert.match(missingAction.content[0]?.text ?? "", /electron\.action must be one of: list, launch, status, cleanup, probe/);
			assert.equal(missingAction.details?.failureCategory, "validation-error");

			const unknownAction = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "bogus" } });
			assert.equal(unknownAction.isError, true);
			assert.match(unknownAction.content[0]?.text ?? "", /electron\.action must be one of/);

			const statusWithHandoff = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "status", handoff: "tabs" } });
			assert.equal(statusWithHandoff.isError, true);
			assert.match(statusWithHandoff.content[0]?.text ?? "", /electron\.status does not support electron\.handoff/);

			for (const action of ["status", "cleanup"] as const) {
				const allFalse = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action, all: false } });
				assert.equal(allFalse.isError, true, action);
				assert.match(allFalse.content[0]?.text ?? "", /electron\.all must be true when provided/);
				assert.equal(allFalse.details?.failureCategory, "validation-error");
			}

			const probeWithListField = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", query: "demo" } });
			assert.equal(probeWithListField.isError, true);
			assert.match(probeWithListField.content[0]?.text ?? "", /electron\.probe only supports action, launchId, and timeoutMs; remove electron\.query/);

			const probeWithoutSession = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", launchId: "launch-1" } });
			assert.equal(probeWithoutSession.isError, true);
			assert.deepEqual(probeWithoutSession.details?.compiledElectron, { action: "probe", launchId: "launch-1" });
			assert.match(probeWithoutSession.content[0]?.text ?? "", /No wrapper-tracked Electron launch found for launchId launch-1/);
			assert.equal(probeWithoutSession.details?.failureCategory, "validation-error");

			const badQuery = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "list", query: 7 } });
			assert.equal(badQuery.isError, true);
			assert.match(badQuery.content[0]?.text ?? "", /electron\.query must be a non-empty string/);

			const listWithLaunchField = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "list", appName: "Code" } });
			assert.equal(listWithLaunchField.isError, true);
			assert.match(listWithLaunchField.content[0]?.text ?? "", /electron\.list only supports query and maxResults; remove electron\.appName/);

			const missingLaunchTarget = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch" } });
			assert.equal(missingLaunchTarget.isError, true);
			assert.match(missingLaunchTarget.content[0]?.text ?? "", /electron\.launch requires exactly one of appPath, appName, bundleId, or executablePath/);
			assert.equal(missingLaunchTarget.details?.failureCategory, "validation-error");
			const ambiguousLaunchTarget = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appName: "Code", appPath: "/Applications/Visual Studio Code.app" } });
			assert.equal(ambiguousLaunchTarget.isError, true);
			assert.match(ambiguousLaunchTarget.content[0]?.text ?? "", /electron\.launch requires exactly one of appPath, appName, bundleId, or executablePath/);

			const reservedAppArg = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: "/Applications/Demo.app", appArgs: ["--remote-debugging-port=9222"] } });
			assert.equal(reservedAppArg.isError, true);
			assert.match(reservedAppArg.content[0]?.text ?? "", /electron\.appArgs must not include wrapper-owned launch flag --remote-debugging-port=9222/);
			assert.equal(reservedAppArg.details?.failureCategory, "validation-error");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension cleans Electron after post-launch managed policy rejection", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-policy-reject-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	let launchPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.PolicyReject", launchLogPath, name: "Policy Reject" });
		await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(upstreamLogPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: true, runtime: { restoreKey: "foreign-policy" } } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "unexpected", url: "about:blank" } }));
}`);
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "launch", appPath: app.appPath },
			});
			assert.equal(result.isError, true, JSON.stringify(result));
			assert.match(result.content[0]?.text ?? "", /does not match the requested managed-restore policy/);
			const launch = JSON.parse((await readFile(launchLogPath, "utf8")).trim()) as { pid: number; userDataDir: string };
			launchPid = launch.pid;
			await waitForTestPidExit(launch.pid);
			await assert.rejects(stat(launch.userDataDir));
			const invocations = await readInvocationLog(upstreamLogPath);
			assert.equal(invocations.some((entry) => entry.args.includes("connect")), false);
		});
	} finally {
		if (launchPid) await stopTestPid(launchPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allows local Electron snapshot handoff", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-protected-handoff-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const protectedUrl = `file://${join(tempDir, ".agent-browser", "sessions", "auth.html")}`;
	const basePath = process.env.PATH ?? "";
	let launchPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.ProtectedHandoff", launchLogPath, name: "Protected Handoff" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath, { sessionUrl: protectedUrl, snapshotTitle: "SECRET LOCAL CONTENT", snapshotUrl: protectedUrl }));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } });
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.match(JSON.stringify(result), /SECRET LOCAL CONTENT/);
			const invocations = await readInvocationLog(upstreamLogPath);
			assert.equal(invocations.some((entry) => entry.args.includes("snapshot") || entry.args.includes("tab")), true);
			const launch = JSON.parse((await readFile(launchLogPath, "utf8")).trim()) as { pid: number; userDataDir: string };
			launchPid = launch.pid;
			const launchId = (result.details?.electron as { identifiers?: { launchId?: string } } | undefined)?.identifiers?.launchId;
			assert.ok(launchId);
			const cleanup = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId } });
			assert.equal(cleanup.isError, false, JSON.stringify(cleanup));
			assert.equal(await waitForTestPidExit(launch.pid), true);
			await assert.rejects(stat(launch.userDataDir));
		});
	} finally {
		if (launchPid) await stopTestPid(launchPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});


test("agentBrowserExtension cleans an Electron launch canceled during snapshot handoff", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-canceled-handoff-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	let launchPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.CanceledHandoff", launchLogPath, name: "Canceled Handoff" });
		await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(upstreamLogPath)}, JSON.stringify({ args }) + "\\n");
const commandIndex = args.findIndex((arg) => ["close", "connect", "get", "snapshot", "tab"].includes(arg));
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
if (command === "snapshot") setInterval(() => {}, 1000);
else {
  const data = command === "get" && subcommand === "url"
    ? { result: "app://safe", url: "app://safe" }
    : command === "tab" ? { tabs: [{ active: true, tabId: "t1", url: "app://safe" }] }
      : command === "connect" ? { connected: true } : { closed: true };
  process.stdout.write(JSON.stringify({ success: true, data }));
}`);
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const controller = new AbortController();
			const resultPromise = executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } }, controller.signal);
			await waitForLoggedCommand(upstreamLogPath, "snapshot");
			controller.abort();
			const result = await resultPromise;
			assert.equal(result.isError, true, JSON.stringify(result));
			assert.equal(result.details?.failureCategory, "aborted");
			const launch = JSON.parse((await readFile(launchLogPath, "utf8")).trim()) as { pid: number; userDataDir: string };
			launchPid = launch.pid;
			assert.equal(await waitForTestPidExit(launch.pid), true);
			await assert.rejects(stat(launch.userDataDir));
		});
	} finally {
		if (launchPid) await stopTestPid(launchPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});


test("agentBrowserExtension launches Electron with isolated profile, snapshot handoff, status, and cleanup", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-launch-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.DemoElectron", launchLogPath, name: "Demo Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "launch", appArgs: ["--fixture-mode"], appPath: app.appPath },
			});
			assert.equal(launchResult.isError, false);
			assert.match(launchResult.content[0]?.text ?? "", /Electron launch: Demo Electron attached/);
			assert.match(launchResult.content[0]?.text ?? "", /Identifiers: launchId .* sessionName .* for browser snapshot\/tab commands/);
			assert.match(launchResult.content[0]?.text ?? "", /Profile note: electron\.launch starts an isolated temporary profile/);
			assert.match(launchResult.content[0]?.text ?? "", /does not reuse the app's normal signed-in profile/);
			assert.match(launchResult.content[0]?.text ?? "", /do not stop here: if host tools are allowed/);
			assert.match(launchResult.content[0]?.text ?? "", /then run agent_browser connect <port>/);
			assert.match(launchResult.content[0]?.text ?? "", /Snapshot handoff: 1 interactive ref/);
			assert.match(launchResult.content[0]?.text ?? "", /Cleanup: use details\.nextActions cleanup-electron-launch or call electron\.cleanup with launchId/);
			const launchDetails = launchResult.details as {
				effectiveArgs: string[];
				electron: { handoff?: { refSnapshot?: { refIds: string[] } }; identifiers?: { appName?: string; launchId?: string; sessionName?: string }; launch: { launchId: string; port: number; sessionName: string; userDataDir: string }; profileIsolation?: { reusesExistingSignedInProfile?: boolean; attachesToAlreadyRunningApp?: boolean; hostDebugLaunchExample?: string } };
				nextActions: Array<{ id: string; params?: { args?: string[]; electron?: { action: string; launchId?: string } } }>;
				refSnapshot: { refIds: string[] };
				sessionMode: string;
			};
			assert.equal(launchDetails.sessionMode, "fresh");
			assert.deepEqual(launchDetails.electron.identifiers, { appName: "Demo Electron", launchId: launchDetails.electron.launch.launchId, sessionName: launchDetails.electron.launch.sessionName });
			assert.equal(launchDetails.electron.profileIsolation?.reusesExistingSignedInProfile, false);
			assert.equal(launchDetails.electron.profileIsolation?.attachesToAlreadyRunningApp, false);
			assert.match(launchDetails.electron.profileIsolation?.hostDebugLaunchExample ?? "", /agent_browser connect 9222/);
			assert.equal(launchDetails.effectiveArgs.at(-2), "connect");
			assert.match(launchDetails.effectiveArgs.at(-1) ?? "", /\/devtools\/page\/page-1$/);
			assert.deepEqual(launchDetails.refSnapshot.refIds, ["e1"]);
			assert.deepEqual(launchDetails.electron.handoff?.refSnapshot?.refIds, ["e1"]);
			assert.ok(launchDetails.nextActions.some((action) => action.id === "cleanup-electron-launch" && action.params?.electron?.launchId === launchDetails.electron.launch.launchId));
			assert.ok(launchDetails.nextActions.some((action) => action.id === "snapshot-electron-session" && action.params?.args?.includes("snapshot")));

			const launchLog = (await readFile(launchLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; userDataDir: string });
			assert.equal(launchLog.length, 1);
			assert.equal(launchLog[0]?.args.includes("--remote-debugging-port=0"), true);
			assert.equal(launchLog[0]?.args.includes("--fixture-mode"), true);
			assert.equal(launchLog[0]?.userDataDir, launchDetails.electron.launch.userDataDir);
			assert.match(launchDetails.electron.launch.userDataDir, /electron-profile-/);
			await stat(launchDetails.electron.launch.userDataDir);

			const invocationsAfterLaunch = await readInvocationLog(upstreamLogPath);
			assert.deepEqual(invocationsAfterLaunch.map((entry) => entry.args.at(-2)), ["connect", "get", "tab", "snapshot"]);
			assert.equal(invocationsAfterLaunch[1]?.args.at(-1), "url");
			assert.equal(invocationsAfterLaunch[0]?.args.includes("--session"), true);

			await rm(upstreamLogPath, { force: true });
			const statusResult = await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "redirected" }, () =>
				executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "status", launchId: launchDetails.electron.launch.launchId },
				}));
			assert.equal(statusResult.isError, false);
			assert.match(statusResult.content[0]?.text ?? "", /debug port alive/);
			assert.match(statusResult.content[0]?.text ?? "", /Identifiers: launchId .*; sessionName/);
			assert.deepEqual((statusResult.details?.electron as { identifiers?: unknown } | undefined)?.identifiers, launchDetails.electron.identifiers);
			assert.equal(((statusResult.details?.electron as { targets?: unknown[] } | undefined)?.targets ?? []).length, 1);
			const statusInvocations = await readInvocationLog(upstreamLogPath);
			assert.equal(statusInvocations.length, 2);
			assert.deepEqual(statusInvocations.map((entry) => entry.args.at(-1)), ["url", "title"]);
			assert.equal(statusInvocations.every((entry) => entry.args[entry.args.indexOf("--namespace") + 1] === ""), true);
			assert.equal(statusInvocations.every((entry) => (entry as { restore?: string | null }).restore === null), true);

			await rm(upstreamLogPath, { force: true });
			const probeResult = await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "redirected" }, () =>
				executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", timeoutMs: 10_000 } }));
			assert.equal(probeResult.isError, false);
			assert.match(probeResult.content[0]?.text ?? "", /Electron probe: Demo Electron — app:\/\/demo/);
			assert.match(probeResult.content[0]?.text ?? "", /Focused: button\/button "Run" \(#run-button\)/);
			assert.match(probeResult.content[0]?.text ?? "", /Snapshot: 1 interactive ref\(s\)/);
			const probeDetails = probeResult.details as {
				electron: { action?: string; identifiers?: { appName?: string; launchId?: string; sessionName?: string }; probe?: { focusedElement?: { id?: string }; refSnapshot?: unknown; snapshot?: { refIds?: string[] }; title?: string; url?: string } };
				namespace?: string;
				refSnapshot?: { refIds?: string[] };
				sessionName?: string;
				sessionTabTarget?: { title?: string; url?: string };
			};
			assert.deepEqual(probeResult.details?.compiledElectron, { action: "probe", timeoutMs: 10_000 });
			assert.equal(probeDetails.electron.action, "probe");
			assert.deepEqual(probeDetails.electron.identifiers, launchDetails.electron.identifiers);
			assert.equal(probeDetails.electron.probe?.title, "Demo Electron");
			assert.equal(probeDetails.electron.probe?.url, "app://demo");
			assert.equal(probeDetails.electron.probe?.focusedElement?.id, "run-button");
			assert.deepEqual(probeDetails.electron.probe?.snapshot?.refIds, ["e1"]);
			assert.equal(probeDetails.electron.probe?.refSnapshot, undefined);
			assert.deepEqual(probeDetails.refSnapshot?.refIds, ["e1"]);
			assert.equal(probeDetails.sessionName, launchDetails.electron.launch.sessionName);
			assert.deepEqual(probeDetails.sessionTabTarget, { title: "Demo Electron", url: "app://demo" });
			const probeInvocations = await readInvocationLog(upstreamLogPath);
			assert.deepEqual(probeInvocations.map((entry) => entry.args.at(-2)), ["get", "get", "eval", "tab", "snapshot"]);
			assert.deepEqual(probeInvocations.slice(0, 2).map((entry) => entry.args.at(-1)), ["url", "title"]);
			assert.equal(probeInvocations.every((entry) => entry.args[entry.args.indexOf("--namespace") + 1] === ""), true);
			assert.equal(probeInvocations.every((entry) => (entry as { restore?: string | null }).restore === null), true);

			harness.setBranch([{ type: "message", message: { details: { ...launchResult.details, namespace: "team" }, isError: false, toolName: "agent_browser" } }]);
			await runExtensionEvent(harness.handlers, "session_tree", { newLeafId: "namespaced", oldLeafId: null }, harness.ctx);
			const namespacedProbe = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe" } });
			assert.equal(namespacedProbe.isError, false, JSON.stringify(namespacedProbe));
			assert.equal(namespacedProbe.details?.namespace, "team");
			assert.deepEqual((namespacedProbe.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);
			const restoredPageState = SessionPageState.fromBranch([{ type: "message", message: { details: namespacedProbe.details, isError: false, toolName: "agent_browser" } }]);
			const namespacedPageStateKey = getSessionPageStateKey(String(namespacedProbe.details?.sessionName), "team");
			assert.ok(namespacedPageStateKey);
			assert.deepEqual(restoredPageState.get(namespacedPageStateKey).refSnapshot?.refIds, ["e1"]);
			assert.equal(restoredPageState.get(String(namespacedProbe.details?.sessionName)).refSnapshot, undefined);

			await rm(upstreamLogPath, { force: true });
			const namespacedLaunchIdProbe = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "probe", launchId: launchDetails.electron.launch.launchId },
			});
			assert.equal(namespacedLaunchIdProbe.isError, false, JSON.stringify(namespacedLaunchIdProbe));
			assert.equal(namespacedLaunchIdProbe.details?.namespace, "team");
			const namespacedLaunchIdProbeInvocations = await readInvocationLog(upstreamLogPath);
			assert.equal(namespacedLaunchIdProbeInvocations.length, 5);
			assert.equal(namespacedLaunchIdProbeInvocations.every((entry) => entry.args[entry.args.indexOf("--namespace") + 1] === "team"), true);

			const broadTextResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", "body"] });
			assert.equal(broadTextResult.isError, false);
			assert.match(broadTextResult.content[0]?.text ?? "", /Broad Electron get text selector warning: selector "body" may read the entire app shell/);
			const broadTextDetails = broadTextResult.details as { electronGetTextScopeWarning?: { electronContext?: { launchId?: string; sessionName?: string }; selector?: string }; nextActions?: Array<{ id?: string; params?: { args?: string[] } }> };
			assert.equal(broadTextDetails.electronGetTextScopeWarning?.selector, "body");
			assert.deepEqual(broadTextDetails.electronGetTextScopeWarning?.electronContext, { launchId: launchDetails.electron.launch.launchId, sessionName: launchDetails.electron.launch.sessionName, url: "app://demo" });
			assert.ok(broadTextDetails.nextActions?.some((action) => action.id === "snapshot-for-electron-text-scope" && action.params?.args?.includes("snapshot")));

			const recordingResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "electron-cleanup.webm"] });
			assert.equal(recordingResult.isError, false, JSON.stringify(recordingResult));
			const blockedCleanup = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "cleanup", launchId: launchDetails.electron.launch.launchId },
				outputPath: "electron-cleanup.webm",
			});
			assert.equal(blockedCleanup.isError, true);
			assert.match(blockedCleanup.content[0]?.text ?? "", /electron-cleanup\.webm is reserved by an active recording/);
			const stillActive = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "status", launchId: launchDetails.electron.launch.launchId } });
			assert.equal(stillActive.isError, false);
			assert.equal((stillActive.details?.electron as { statuses?: Array<{ portAlive?: boolean }> } | undefined)?.statuses?.[0]?.portAlive, true);
			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "cleanup", launchId: launchDetails.electron.launch.launchId },
			});
			assert.equal(cleanupResult.isError, false);
			assert.match(cleanupResult.content[0]?.text ?? "", /fully cleaned/);
			const cleanupManifest = cleanupResult.details?.artifactManifest as { entries?: Array<{ subcommand?: string }> } | undefined;
			assert.equal(cleanupManifest?.entries?.some((entry) => entry.subcommand === "start"), false);
			const releasedRecordingPath = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["pdf", "electron-cleanup.webm"] });
			assert.doesNotMatch(releasedRecordingPath.content[0]?.text ?? "", /reserved by an active recording/);
			await assert.rejects(stat(launchDetails.electron.launch.userDataDir));
			const finalInvocations = await readInvocationLog(upstreamLogPath);
			const cleanupClose = finalInvocations.find((entry) => entry.args.at(-1) === "close");
			assert.ok(cleanupClose);
			assert.equal(cleanupClose.args[cleanupClose.args.indexOf("--namespace") + 1], "team");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension retains headed autosave policy for Electron cleanup close", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-headed-cleanup-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	let launchedPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.HeadedCleanup", launchLogPath, name: "Headed Cleanup" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		await withPatchedEnv({
			AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined,
			AGENT_BROWSER_HEADED: "1",
			PATH: `${tempDir}:${basePath}`,
		}, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "launch", appPath: app.appPath, handoff: "snapshot" },
			});
			assert.equal(launchResult.isError, false, JSON.stringify(launchResult));
			assert.equal(launchResult.details?.managedSessionHeadedAutosaveDisabled, true);
			const launch = (launchResult.details?.electron as { launch?: { launchId?: string; pid?: number; userDataDir?: string } } | undefined)?.launch;
			assert.equal(typeof launch?.launchId, "string");
			launchedPid = launch?.pid;

			await rm(upstreamLogPath, { force: true });
			const statusResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "status", launchId: launch?.launchId },
			});
			assert.equal(statusResult.isError, false, JSON.stringify(statusResult));
			const probeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "probe", launchId: launch?.launchId },
			});
			assert.equal(probeResult.isError, false, JSON.stringify(probeResult));
			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "cleanup", launchId: launch?.launchId },
			});
			assert.equal(cleanupResult.isError, false, JSON.stringify(cleanupResult));
			const helperInvocations = await readInvocationLog(upstreamLogPath);
			assert.ok(helperInvocations.length >= 7, JSON.stringify(helperInvocations));
			assert.equal(helperInvocations.every((entry) => entry.autosave === "0"), true, JSON.stringify(helperInvocations));
			if (launch?.userDataDir) await assert.rejects(stat(launch.userDataDir));
		});
	} finally {
		if (launchedPid) await stopTestPid(launchedPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension applies managed restore policy to every current-session electron.probe helper", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-probe-restore-"));
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const basePath = process.env.PATH ?? "";
	execFileSync("git", ["init", "-q", tempDir], { stdio: "ignore" });
	await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
	try {
		await withPatchedEnv({
			ALL_PROXY: undefined,
			HTTP_PROXY: undefined,
			HTTPS_PROXY: undefined,
			HOME: tempDir,
			PATH: `${tempDir}:${basePath}`,
			all_proxy: undefined,
			http_proxy: undefined,
			https_proxy: undefined,
		}, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.com/"] });
			assert.equal(opened.isError, false, JSON.stringify(opened));
			await rm(upstreamLogPath, { force: true });

			const probe = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe" } });
			assert.equal(probe.isError, false, JSON.stringify(probe));
			const invocations = await readInvocationLog(upstreamLogPath) as Array<{ args: string[]; restore?: string | null }>;
			assert.deepEqual(invocations.map((entry) => entry.args.at(-2)), ["get", "get", "eval", "tab", "snapshot"]);
			const restoreKey = createManagedSessionRestoreKey(tempDir, getManagedSessionRestoreScope(opened.details?.sessionName as string));
			assert.equal(invocations.every((entry) => entry.restore === restoreKey), true);

			await writeFakeAgentBrowserBinary(tempDir, `const args = process.argv.slice(2);
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: true, runtime: { restoreKey: process.env.AGENT_BROWSER_RESTORE } } }));
} else {
  process.stdout.write(JSON.stringify({ success: false, error: "probe failed" }));
  process.exitCode = 2;
}`);
			const failedProbe = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe" } });
			assert.equal(failedProbe.isError, true, JSON.stringify(failedProbe));
			assert.equal(failedProbe.details?.failureCategory, "upstream-error");
			assert.match(failedProbe.content[0]?.text ?? "", /Electron probe failed/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allows follow-up inspection on local file pages", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-normal-file-text-scope-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
const commandIndex = args.findIndex((arg) => arg === "open" || arg === "get" || arg === "close");
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
const data = command === "open"
  ? { title: "Normal file page", url: "file:///tmp/normal-browser-fixture.html" }
  : command === "get" && subcommand === "text"
    ? { origin: "file:///tmp/normal-browser-fixture.html", text: "normal page text" }
    : command === "get" && subcommand === "url"
      ? { result: "file:///tmp/normal-browser-fixture.html", url: "file:///tmp/normal-browser-fixture.html" }
      : { closed: true };
process.stdout.write(JSON.stringify({ success: true, data }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Read a normal file page." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const openResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "file:///tmp/normal-browser-fixture.html"], sessionMode: "fresh" });
			assert.equal(openResult.isError, false);

			const textResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", "body"] });
			assert.equal(textResult.isError, false, JSON.stringify(textResult));
			assert.match(textResult.content[0]?.text ?? "", /normal page text/);
			const probeResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe" } });
			assert.equal(probeResult.isError, false, JSON.stringify(probeResult));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension follows a live Electron probe onto local pages", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-probe-local-drift-"));
	const logPath = join(tempDir, "agent-browser.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(tempDir, `const fs = require("node:fs");
const args = process.argv.slice(2);
const commandIndex = args.findIndex((arg) => ["close", "get", "open"].includes(arg));
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ command, subcommand }) + "\\n");
const data = command === "open"
  ? { title: "Safe page", url: "https://fixture.invalid/" }
  : command === "get" && subcommand === "url"
    ? { result: "file:///tmp/drifted-local-page.html", url: "file:///tmp/drifted-local-page.html" }
    : command === "get" && subcommand === "title"
      ? { result: "SECRET LOCAL TITLE", title: "SECRET LOCAL TITLE" }
      : { closed: true };
process.stdout.write(JSON.stringify({ success: true, data }));`);
	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const openResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://fixture.invalid/"] });
			assert.equal(openResult.isError, false, JSON.stringify(openResult));
			await rm(logPath, { force: true });

			const probeResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe" } });
			assert.equal(probeResult.isError, false, JSON.stringify(probeResult));
			assert.match(JSON.stringify(probeResult), /SECRET LOCAL TITLE/);
			const invocations = await readInvocationLog(logPath) as Array<{ command?: string; subcommand?: string }>;
			assert.deepEqual(invocations.slice(0, 2).map((entry) => [entry.command, entry.subcommand]), [["get", "url"], ["get", "title"]]);
			assert.equal(invocations.length, 5);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});


test("agentBrowserExtension reports Electron session mismatch and launchId-aware probe", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-mismatch-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	let launchedPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.MismatchElectron", launchLogPath, name: "Mismatch Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath, {
			sessionTitle: "Blank Page",
			sessionUrl: "about:blank",
			tabTitle: "Blank Page",
			tabUrl: "about:blank",
		}));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } });
			assert.equal(launchResult.isError, false);
			const launchDetails = launchResult.details as {
				electron: { launch: { launchId: string; pid: number; sessionName: string; userDataDir: string } };
			};
			launchedPid = launchDetails.electron.launch.pid;
			const { launchId, sessionName } = launchDetails.electron.launch;

			await rm(upstreamLogPath, { force: true });
			const currentUrlResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(currentUrlResult.isError, false);
			assert.match(currentUrlResult.content[0]?.text ?? "", /Electron session mismatch: managed session .* is on about:blank, but launch .* still has live target Demo Electron/);
			const currentUrlDetails = currentUrlResult.details as {
				electronSessionMismatch?: { launchId?: string; reason?: string; managedSession?: { url?: string }; liveTarget?: { url?: string } };
				nextActions?: Array<{ id: string; params?: { args?: string[]; electron?: { action?: string; launchId?: string }; sessionMode?: string } }>;
			};
			assert.equal(currentUrlDetails.electronSessionMismatch?.launchId, launchId);
			assert.equal(currentUrlDetails.electronSessionMismatch?.reason, "managed-session-about-blank-while-launch-target-live");
			assert.equal(currentUrlDetails.electronSessionMismatch?.managedSession?.url, "about:blank");
			assert.equal(currentUrlDetails.electronSessionMismatch?.liveTarget?.url, "app://demo");
			const currentUrlActionIds = new Set(currentUrlDetails.nextActions?.map((action) => action.id));
			for (const actionId of ["status-electron-launch", "probe-electron-launch", "reattach-electron-launch", "cleanup-electron-launch", "snapshot-electron-session"]) {
				assert.equal(currentUrlActionIds.has(actionId), true, actionId);
			}
			assert.ok(currentUrlDetails.nextActions?.some((action) => action.id === "reattach-electron-launch" && action.params?.sessionMode === "fresh" && action.params?.args?.[0] === "connect"));

			const statusResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "status", launchId } });
			assert.equal(statusResult.isError, false);
			assert.match(statusResult.content[0]?.text ?? "", /Electron session mismatch: managed session .* is on about:blank, but launch .* still has live target Demo Electron/);
			const statusDetails = statusResult.details as {
				electron?: { managedSession?: { url?: string }; sessionMismatch?: { reason?: string; liveTarget?: { url?: string } } };
				nextActions?: Array<{ id: string; params?: { electron?: { action?: string; launchId?: string } } }>;
			};
			assert.equal(statusDetails.electron?.managedSession?.url, "about:blank");
			assert.equal(statusDetails.electron?.sessionMismatch?.reason, "managed-session-about-blank-while-launch-target-live");
			assert.equal(statusDetails.electron?.sessionMismatch?.liveTarget?.url, "app://demo");
			assert.ok(statusDetails.nextActions?.some((action) => action.id === "probe-electron-launch" && action.params?.electron?.launchId === launchId));
			assert.ok(statusDetails.nextActions?.some((action) => action.id === "reattach-electron-launch"));
			const statusActionIds = statusDetails.nextActions?.map((action) => action.id) ?? [];
			assert.deepEqual(statusActionIds.slice(0, 3), ["status-electron-launch", "probe-electron-launch", "reattach-electron-launch"]);
			assert.ok(statusActionIds.indexOf("reattach-electron-launch") < statusActionIds.indexOf("snapshot-electron-session"));

			await rm(upstreamLogPath, { force: true });
			const currentProbeResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", timeoutMs: 5_000 } });
			assert.equal(currentProbeResult.isError, false);
			assert.match(currentProbeResult.content[0]?.text ?? "", /Probe context: current managed session .* maps to Electron launch/);
			assert.match(currentProbeResult.content[0]?.text ?? "", /Electron session mismatch: managed session .* is on about:blank, but launch .* still has live target Demo Electron/);
			const currentProbeDetails = currentProbeResult.details as {
				electron?: { probeContext?: { launchId?: string; mode?: string; sessionName?: string }; sessionMismatch?: { reason?: string } };
			};
			assert.equal(currentProbeDetails.electron?.probeContext?.mode, "current-managed-session");
			assert.equal(currentProbeDetails.electron?.probeContext?.launchId, launchId);
			assert.equal(currentProbeDetails.electron?.probeContext?.sessionName, sessionName);
			assert.equal(currentProbeDetails.electron?.sessionMismatch?.reason, "managed-session-about-blank-while-launch-target-live");

			await rm(upstreamLogPath, { force: true });
			const launchProbeResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", launchId, timeoutMs: 5_000 } });
			assert.equal(launchProbeResult.isError, false);
			assert.match(launchProbeResult.content[0]?.text ?? "", /Probe context: wrapper launch .* session/);
			const launchProbeDetails = launchProbeResult.details as {
				compiledElectron?: { action?: string; launchId?: string; timeoutMs?: number };
				electron?: { probeContext?: { launchId?: string; mode?: string; sessionName?: string } };
				usedImplicitSession?: boolean;
			};
			assert.deepEqual(launchProbeDetails.compiledElectron, { action: "probe", launchId, timeoutMs: 5_000 });
			assert.equal(launchProbeDetails.electron?.probeContext?.mode, "launchId");
			assert.equal(launchProbeDetails.electron?.probeContext?.sessionName, sessionName);
			assert.equal(launchProbeDetails.usedImplicitSession, false);
			const launchProbeInvocations = await readInvocationLog(upstreamLogPath);
			assert.equal(launchProbeInvocations.every((entry) => entry.args.includes("--session") && entry.args.includes(sessionName)), true);

			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId } });
			assert.equal(cleanupResult.isError, false);
			await assert.rejects(stat(launchDetails.electron.launch.userDataDir));
			assert.equal(await waitForTestPidExit(launchDetails.electron.launch.pid), true, "electron.cleanup should terminate the launched fake Electron process");
		});
	} finally {
		await stopTestPid(launchedPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension surfaces Electron post-command death and fill verification", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-post-command-health-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const statePath = join(tempDir, "agent-browser-state.json");
	const basePath = process.env.PATH ?? "";
	let launchedPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.HealthElectron", launchLogPath, name: "Health Electron" });
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(upstreamLogPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session", "--namespace", "--profile", "--state", "--session-name", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--cdp", "--provider", "-p", "--device", "--user-agent"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
	const token = args[i];
	if (token === "--json") continue;
	if (valueFlags.has(token)) { i += 1; continue; }
	if (token.startsWith("--")) continue;
	commandIndex = i;
	break;
}
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
const readState = () => {
	try { return JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch { return { blank: false }; }
};
const write = (data) => process.stdout.write(JSON.stringify({ success: true, data }));
const currentPage = () => readState().blank ? { title: "Blank Page", url: "about:blank" } : { title: "Demo Electron", url: "app://demo" };
const readLaunch = () => fs.readFileSync(${JSON.stringify(launchLogPath)}, "utf8").trim().split("\\n").map((line) => JSON.parse(line)).at(-1);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (command === "connect") write({ connected: true, endpoint: subcommand });
else if (command === "get" && subcommand === "title") write({ result: currentPage().title, title: currentPage().title });
else if (command === "get" && subcommand === "url") write({ result: currentPage().url, url: currentPage().url });
else if (command === "get" && subcommand === "value") write({ result: "" });
else if (command === "eval") write({ result: { focusedElement: { id: "name-input", role: "textbox", tagName: "input", valueLength: 0 } } });
else if (command === "tab" && subcommand === "list") write({ tabs: [{ active: true, index: 0, tabId: "page-1", title: currentPage().title, type: "page", url: currentPage().url }] });
else if (command === "snapshot") write({ origin: currentPage().url, title: currentPage().title, url: currentPage().url, refs: { e1: { role: "textbox", name: "File name" } }, snapshot: "- textbox \\\"File name\\\" [ref=e1]" });
else if (command === "fill") write({ filled: subcommand, title: "Demo Electron", url: "app://demo" });
else if (command === "click") {
	const launch = readLaunch();
	fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ blank: true }));
	try { process.kill(launch.pid, "SIGTERM"); } catch {}
	const deadline = Date.now() + 1000;
	const finish = () => {
		if (!pidAlive(launch.pid) || Date.now() > deadline) write({ clicked: subcommand, title: "Blank Page", url: "about:blank" });
		else setTimeout(finish, 25);
	};
	finish();
}
else if (command === "close") write({ closed: true });
else write({ ok: true, title: currentPage().title, url: currentPage().url });`,
		);
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } });
			assert.equal(launchResult.isError, false);
			const launch = (launchResult.details?.electron as { launch: { launchId: string; pid: number; sessionName: string; userDataDir: string } }).launch;
			launchedPid = launch.pid;

			const fillResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["fill", "@e1", "agent-browser-smoke.txt"] });
			assert.equal(fillResult.isError, false);
			assert.match(fillResult.content[0]?.text ?? "", /Fill verification warning: fill @e1 reported success/);
			assert.match(fillResult.content[0]?.text ?? "", /Electron ref freshness:/);
			const fillDetails = fillResult.details as {
				fillVerification?: { actual?: string; expected?: string; selector?: string; status?: string };
				electronRefFreshness?: { launchId?: string };
				nextActions?: Array<{ id: string; params?: { args?: string[] } }>;
			};
			assert.deepEqual(fillDetails.fillVerification, {
				actual: "",
				expected: "agent-browser-smoke.txt",
				method: "value",
				nextActionIds: ["inspect-after-fill-verification", "verify-filled-value"],
				reason: "value-fill-mismatch",
				selector: "@e1",
				status: "mismatch",
				summary: "Fill verification warning: fill @e1 reported success, but get value returned an empty value.",
			});
			assert.equal(fillDetails.electronRefFreshness?.launchId, launch.launchId);
			assert.ok(fillDetails.nextActions?.some((action) => action.id === "inspect-after-fill-verification" && action.params?.args?.includes("snapshot")));
			assert.ok(fillDetails.nextActions?.some((action) => action.id === "refresh-electron-refs-after-rerender"));

			const clickResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(clickResult.isError, true);
			assert.equal(clickResult.details?.failureCategory, "tab-drift");
			assert.match(clickResult.content[0]?.text ?? "", /Electron lifecycle warning: click command completed, but launch .* is no longer healthy/);
			assert.match(clickResult.content[0]?.text ?? "", /debug port dead, pid dead/);
			const clickDetails = clickResult.details as {
				electronPostCommandHealth?: { launchId?: string; reason?: string; status?: { pidAlive?: boolean; portAlive?: boolean } };
				nextActions?: Array<{ id: string; params?: { electron?: { action?: string; launchId?: string } } }>;
			};
			assert.equal(clickDetails.electronPostCommandHealth?.launchId, launch.launchId);
			assert.equal(clickDetails.electronPostCommandHealth?.reason, "process-dead");
			assert.equal(clickDetails.electronPostCommandHealth?.status?.pidAlive, false);
			assert.equal(clickDetails.electronPostCommandHealth?.status?.portAlive, false);
			assert.ok(clickDetails.nextActions?.some((action) => action.id === "status-electron-launch" && action.params?.electron?.launchId === launch.launchId));
			assert.ok(clickDetails.nextActions?.some((action) => action.id === "cleanup-electron-launch" && action.params?.electron?.launchId === launch.launchId));

			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: launch.launchId } });
			assert.equal(cleanupResult.isError, false);
			await assert.rejects(stat(launch.userDataDir));
		});
	} finally {
		await stopTestPid(launchedPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension applies electron.probe timeoutMs to bounded subprocess probes", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-probe-timeout-"));
	const logPath = join(tempDir, "agent-browser.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
	const token = args[i];
	if (token === "--json") continue;
	if (valueFlags.has(token)) { i += 1; continue; }
	if (token.startsWith("--")) continue;
	commandIndex = i;
	break;
}
const command = args[commandIndex];
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, command }) + "\\n");
if (command === "connect") {
	process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
	return;
}
if (command === "open") {
	process.stdout.write(JSON.stringify({ success: true, data: { title: "Safe", url: "https://safe.example/" } }));
	return;
}
setTimeout(() => {
	process.stdout.write(JSON.stringify({ success: true, data: { result: "late" } }));
}, 200);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const connectResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["connect", "9222"] });
			assert.equal(connectResult.isError, false);
			const connectNextActions = connectResult.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined;
			const connectedSessionName = connectResult.details?.sessionName as string | undefined;
			assert.ok(connectedSessionName);
			assert.deepEqual(connectNextActions?.map((action) => action.id), ["verify-connected-session-url", "list-connected-session-tabs"]);
			assert.deepEqual(connectNextActions?.map((action) => action.params?.args), [
				["--session", connectedSessionName, "get", "url"],
				["--session", connectedSessionName, "tab", "list"],
			]);
			const safeOpen = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://safe.example/"] });
			assert.equal(safeOpen.isError, false, JSON.stringify(safeOpen));

			const probeResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "probe", timeoutMs: 25 } });
			assert.equal(probeResult.isError, true, JSON.stringify(probeResult));
			assert.deepEqual(probeResult.details?.compiledElectron, { action: "probe", timeoutMs: 25 });
			assert.equal(probeResult.details?.failureCategory, "upstream-error");
			assert.equal((probeResult.details?.electron as { status?: string } | undefined)?.status, "failed");
			assert.match(probeResult.content[0]?.text ?? "", /Electron probe failed/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension recommends tab recovery after No active page snapshot failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-no-active-page-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, command }) + "\\n");
const snapshotStatePath = ${JSON.stringify(join(tempDir, "snapshot-count.txt"))};
function nextSnapshotCount() {
  let count = 0;
  try { count = Number(fs.readFileSync(snapshotStatePath, "utf8")) || 0; } catch {}
  count += 1;
  fs.writeFileSync(snapshotStatePath, String(count));
  return count;
}
if (command === "connect") {
  process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
} else if (command === "get" && args[commandIndex + 1] === "url") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://active.example/" } }));
} else if (command === "snapshot") {
  const snapshotCount = nextSnapshotCount();
  if (snapshotCount === 1) {
    process.stdout.write(JSON.stringify({ success: true, data: {
      origin: "https://active.example/",
      refs: { e1: { role: "button", name: "Old action" } },
      snapshot: '- button "Old action" [ref=e1]'
    } }));
  } else if (snapshotCount === 2) {
    process.stdout.write(JSON.stringify({ success: false, error: "No active page" }));
    process.exit(1);
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: {
      origin: "https://active.example/",
      refs: { e2: { role: "button", name: "Fresh action" } },
      snapshot: '- button "Fresh action" [ref=e2]'
    } }));
  }
} else if (command === "click") {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const connectResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["connect", "9222"] });
			assert.equal(connectResult.isError, false);
			const sessionName = connectResult.details?.sessionName as string | undefined;
			assert.ok(sessionName);
			const verifiedUrl = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(verifiedUrl.isError, false, JSON.stringify(verifiedUrl));

			const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));
			assert.deepEqual((initialSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);
			assert.equal("order" in ((initialSnapshot.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const snapshotResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshotResult.isError, true);
			assert.equal(snapshotResult.details?.command, "snapshot");
			assert.equal(snapshotResult.details?.failureCategory, "upstream-error");
			assert.equal(snapshotResult.details?.refSnapshot, undefined);
			assert.equal((snapshotResult.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "no-active-page");
			assert.equal("order" in ((snapshotResult.details?.refSnapshotInvalidation as Record<string, unknown> | undefined) ?? {}), false);
			const nextActions = snapshotResult.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["list-tabs-after-no-active-page"]);
			assert.deepEqual(nextActions?.map((action) => action.params?.args), [
				["--session", sessionName, "tab", "list"],
			]);

			const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(staleClick.isError, true);
			assert.equal(staleClick.details?.failureCategory, "stale-ref");
			assert.deepEqual(staleClick.details?.refIds, ["e1"]);
			assert.equal((staleClick.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "no-active-page");
			assert.equal("order" in ((staleClick.details?.refSnapshotInvalidation as Record<string, unknown> | undefined) ?? {}), false);
			assert.match((staleClick.content[0] as { text: string }).text, /latest snapshot for this session reported No active page/);
			const staleNextActions = staleClick.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(staleNextActions?.map((action) => action.id), ["refresh-interactive-refs"]);
			assert.deepEqual(staleNextActions?.map((action) => action.params?.args), [
				["--session", sessionName, "snapshot", "-i"],
			]);

			const batchWithInlineSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["snapshot", "-i"], ["click", "@e1"]]),
			});
			assert.equal(batchWithInlineSnapshot.isError, true);
			assert.equal(batchWithInlineSnapshot.details?.failureCategory, "stale-ref");
			assert.deepEqual(batchWithInlineSnapshot.details?.refIds, ["e1"]);
			assert.match((batchWithInlineSnapshot.content[0] as { text: string }).text, /latest snapshot for this session reported No active page/);

			const freshSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(freshSnapshot.isError, false, JSON.stringify(freshSnapshot));
			assert.equal(freshSnapshot.details?.refSnapshotInvalidation, undefined);
			assert.deepEqual((freshSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e2"]);
			assert.equal("order" in ((freshSnapshot.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const freshClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e2"] });
			assert.equal(freshClick.isError, false, JSON.stringify(freshClick));
			assert.equal((freshClick.details?.data as { clicked?: string } | undefined)?.clicked, "@e2");

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(
				invocations
					.map((entry) => entry.args.find((token) => ["connect", "snapshot", "click"].includes(token)))
					.filter((command): command is string => command !== undefined),
				["connect", "snapshot", "snapshot", "snapshot", "snapshot", "click"],
			);
			assert.equal(invocations.filter((entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e2").length, 1);
			assert.equal(invocations.filter((entry) => entry.args.includes("@e1")).length, 0);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension invalidates refs after No active page snapshot failures inside batch", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-no-active-page-batch-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
	const token = args[i];
	if (token === "--json") continue;
	if (valueFlags.has(token)) { i += 1; continue; }
	if (token.startsWith("--")) continue;
	commandIndex = i;
	break;
}
const command = args[commandIndex];
const recoveredPath = ${JSON.stringify(join(tempDir, "recovered.flag"))};
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, command, stdin }) + "\\n");
if (command === "connect") {
	process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
} else if (command === "get" && args[commandIndex + 1] === "url") {
	process.stdout.write(JSON.stringify({ success: true, data: { result: "https://active.example/" } }));
} else if (command === "snapshot") {
	const recovered = fs.existsSync(recoveredPath);
	process.stdout.write(JSON.stringify({ success: true, data: recovered ? {
	origin: "https://active.example/",
	refs: { e2: { role: "button", name: "Recovered action" } },
	snapshot: '- button "Recovered action" [ref=e2]'
	} : {
	origin: "https://active.example/",
	refs: { e1: { role: "button", name: "Old action" } },
	snapshot: '- button "Old action" [ref=e1]'
	} }));
} else if (command === "batch") {
	const steps = JSON.parse(stdin || "[]");
	process.stdout.write(JSON.stringify(steps.map((step) => {
		if (step[0] === "snapshot" && step.includes("--recover")) {
			fs.writeFileSync(recoveredPath, "1");
			return { command: step, success: true, result: {
				origin: "https://active.example/",
				refs: { e2: { role: "button", name: "Recovered action" } },
				snapshot: '- button "Recovered action" [ref=e2]'
			} };
		}
		return step[0] === "snapshot"
			? { command: step, success: false, error: "No active page" }
			: { command: step, success: true, result: { ok: true } };
	})));
	process.exit(1);
} else if (command === "click") {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const connectResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["connect", "9222"] });
			assert.equal(connectResult.isError, false);
			const sessionName = connectResult.details?.sessionName as string | undefined;
			assert.ok(sessionName);
			const verifiedUrl = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(verifiedUrl.isError, false, JSON.stringify(verifiedUrl));

			const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));
			assert.deepEqual((initialSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e1"]);
			assert.equal("order" in ((initialSnapshot.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const batchSnapshotFailure = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["snapshot", "-i"]]),
			});
			assert.equal(batchSnapshotFailure.isError, true, JSON.stringify(batchSnapshotFailure));
			assert.equal(batchSnapshotFailure.details?.refSnapshot, undefined);
			assert.equal((batchSnapshotFailure.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "no-active-page");
			assert.equal("order" in ((batchSnapshotFailure.details?.refSnapshotInvalidation as Record<string, unknown> | undefined) ?? {}), false);
			const nextActions = batchSnapshotFailure.details?.nextActions as Array<{ id: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["list-tabs-after-no-active-page"]);
			assert.deepEqual(nextActions?.map((action) => action.params?.args), [
				["--session", sessionName, "tab", "list"],
			]);

			const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e1"] });
			assert.equal(staleClick.isError, true);
			assert.equal(staleClick.details?.failureCategory, "stale-ref");
			assert.deepEqual(staleClick.details?.refIds, ["e1"]);
			assert.equal((staleClick.details?.refSnapshotInvalidation as { reason?: string } | undefined)?.reason, "no-active-page");
			assert.equal("order" in ((staleClick.details?.refSnapshotInvalidation as Record<string, unknown> | undefined) ?? {}), false);

			const batchSnapshotRecovery = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["snapshot", "-i"], ["snapshot", "-i", "--recover"]]),
			});
			assert.equal(batchSnapshotRecovery.isError, true, JSON.stringify(batchSnapshotRecovery));
			assert.equal(batchSnapshotRecovery.details?.refSnapshotInvalidation, undefined);
			assert.deepEqual((batchSnapshotRecovery.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e2"]);
			assert.equal("order" in ((batchSnapshotRecovery.details?.refSnapshot as Record<string, unknown> | undefined) ?? {}), false);

			const recoveredClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e2"] });
			assert.equal(recoveredClick.isError, false, JSON.stringify(recoveredClick));
			assert.equal((recoveredClick.details?.data as { clicked?: string } | undefined)?.clicked, "@e2");

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(
				invocations
					.map((entry) => entry.args.find((token) => ["connect", "snapshot", "batch", "click"].includes(token)))
					.filter((command): command is string => command !== undefined),
				["connect", "snapshot", "batch", "batch", "snapshot", "click"],
			);
			assert.equal(invocations.filter((entry) => entry.args.includes("@e1")).length, 0);
			assert.equal(invocations.filter((entry) => entry.args.includes("@e2")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
