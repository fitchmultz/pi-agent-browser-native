/**
 * Purpose: Verify Electron handoff variants, cleanup failure paths, restored records, schema rejection, and discovery contracts.
 * Responsibilities: Assert metadata, prompt injection, bash blocking, CLI validation, missing binary, malformed envelope, fallback error, and oversized parse-failure behavior.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-validation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { Theme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import {
	BRAVE_SEARCH_PROMPT_GUIDELINE,
	QUICK_START_GUIDELINES,
	buildInstalledDocsGuideline,
	SHARED_BROWSER_PLAYBOOK_GUIDELINES,
	TOOL_PROMPT_GUIDELINES_PREFIX,
	TOOL_PROMPT_GUIDELINES_SUFFIX,
	WRAPPER_TAB_RECOVERY_BEHAVIOR,
} from "../extensions/agent-browser/lib/playbook.js";
import {
	discoverElectronApps,
	ELECTRON_DISCOVERY_MAX_RESULTS,
	type ElectronAppDiscovery,
} from "../extensions/agent-browser/lib/electron/discovery.js";
import {
	cleanupElectronLaunchResources,
} from "../extensions/agent-browser/lib/electron/cleanup.js";
import {
	cleanupSecureTempArtifacts,
	createSecureTempDirectory,
} from "../extensions/agent-browser/lib/temp.js";
import {
	TEST_SESSION_ID,
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	runExtensionEventResults,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
	type AgentBrowserToolParams,
	type AgentBrowserToolRenderContext,
} from "./helpers/agent-browser-harness.js";

import {
	PLAIN_RENDER_THEME,
	createRenderContext,
	electronAppNames,
	fakeAgentBrowserLifecycleScript,
	isTestPidAlive,
	readOptionalFakeElectronLaunchLog,
	stopTestPid,
	waitForTestPidExit,
	writeFakeLaunchableElectronApp,
	writeFakeLinuxElectronBinary,
	writeFakeMacElectronApp,
} from "./helpers/extension-validation-fixtures.js";

test("agentBrowserExtension supports Electron launch handoff modes", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-handoff-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.HandoffElectron", launchLogPath, name: "Handoff Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			for (const [handoff, expectedCommands] of [["connect", ["connect"]], ["tabs", ["connect", "tab"]]] as const) {
				await rm(upstreamLogPath, { force: true });
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath, handoff } });
				assert.equal(result.isError, false, handoff);
				assert.match(result.content[0]?.text ?? "", handoff === "tabs" ? /safer diagnostic starting point; no interactive refs were captured/ : /Connect handoff completed: run snapshot -i before using interactive refs/);
				const commands = (await readInvocationLog(upstreamLogPath)).map((entry) => entry.args.find((token) => ["connect", "tab", "snapshot"].includes(token))).filter(Boolean);
				assert.deepEqual(commands, expectedCommands, handoff);
				const launchId = ((result.details?.electron as { launch?: { launchId: string } } | undefined)?.launch?.launchId);
				assert.ok(launchId);
				await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId } });
			}
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension targets Electron webviews and keeps host cleanup after close failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-webview-close-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.WebviewElectron", includeWebview: true, launchLogPath, name: "Webview Electron" });
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(upstreamLogPath)}, JSON.stringify({ args }) + "\\n");
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
if (command === "close") {
	process.stdout.write(JSON.stringify({ success: false, error: "close boom" }));
	process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));`,
		);
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath, handoff: "connect", targetType: "webview" } });
			assert.equal(launchResult.isError, false);
			const launchDetails = launchResult.details as { effectiveArgs: string[]; electron: { launch: { launchId: string; pid: number; userDataDir: string } } };
			assert.match(launchDetails.effectiveArgs.at(-1) ?? "", /\/devtools\/page\/webview-1$/);

			const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "cleanup", launchId: launchDetails.electron.launch.launchId, timeoutMs: 1_000 } });
			assert.equal(cleanupResult.isError, true);
			assert.equal(cleanupResult.details?.failureCategory, "cleanup-failed");
			assert.match(cleanupResult.content[0]?.text ?? "", /managed-session: failed/);
			await assert.rejects(stat(launchDetails.electron.launch.userDataDir));
			assert.equal(isTestPidAlive(launchDetails.electron.launch.pid), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks Electron launch by caller policy without spawning", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-policy-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.PolicyElectron", launchLogPath, name: "Policy Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				electron: { action: "launch", appPath: app.appPath, deny: ["Policy Electron"] },
			});
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "policy-blocked");
			assert.match(result.content[0]?.text ?? "", /deny policy: Policy Electron/);
			assert.deepEqual(await readInvocationLog(upstreamLogPath), []);
			await assert.rejects(readFile(launchLogPath, "utf8"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension cleans Electron resources when launch fails before upstream attach", { concurrency: false }, async () => {
	for (const { expectedCategory, mode, timeoutMs, writeLaunchLog } of [
		{ expectedCategory: "timeout", mode: "no-port-file", timeoutMs: 500, writeLaunchLog: false },
		{ expectedCategory: "upstream-error", mode: "invalid-cdp", timeoutMs: 1_500, writeLaunchLog: true },
	] as const) {
		const tempDir = await mkdtemp(join(tmpdir(), `pi-agent-browser-electron-failed-${mode}-`));
		const applicationsDir = join(tempDir, "Applications");
		const launchLogPath = join(tempDir, "electron-launch.log");
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: `com.example.${mode}`, launchLogPath, mode, name: `Failed ${mode}`, writeLaunchLog });
			await withPatchedEnv({ PATH: dirname(process.execPath) }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "launch", appPath: app.appPath, timeoutMs },
				});
				assert.equal(result.isError, true, mode);
				assert.equal(result.details?.failureCategory, expectedCategory, mode);
				assert.match(result.content[0]?.text ?? "", /Electron launch diagnostics:/, mode);
				assert.match(result.content[0]?.text ?? "", /Retry guidance: increase electron\.timeoutMs/, mode);
				const diagnostics = ((result.details?.electron as { failure?: { diagnostics?: { cdpVersionReached?: boolean; devToolsActivePort?: { found?: boolean; port?: number }; pid?: number; pidAlive?: boolean; timeoutMs?: number; userDataDir?: string } } } | undefined)?.failure?.diagnostics);
				const diagnosticPid = diagnostics?.pid;
				const diagnosticUserDataDir = diagnostics?.userDataDir;
				assert.ok(typeof diagnosticPid === "number", mode);
				assert.equal(diagnostics?.pidAlive, true, mode);
				assert.equal(diagnostics?.timeoutMs, timeoutMs, mode);
				assert.ok(typeof diagnosticUserDataDir === "string", mode);
				const launchLogs = await readOptionalFakeElectronLaunchLog(launchLogPath);
				const launchLog = launchLogs.find((entry) => entry.pid === diagnosticPid);
				if (mode === "no-port-file") {
					assert.equal(launchLogs.length, 0, mode);
					assert.equal(diagnostics?.devToolsActivePort?.found, false, mode);
					assert.match(result.content[0]?.text ?? "", /DevToolsActivePort: missing/, mode);
				} else {
					assert.ok(launchLog, mode);
					assert.equal(diagnostics?.userDataDir, launchLog.userDataDir, mode);
					assert.equal(diagnostics?.devToolsActivePort?.found, true, mode);
					assert.equal(diagnostics?.devToolsActivePort?.port, launchLog.port, mode);
					assert.equal(diagnostics?.cdpVersionReached, false, mode);
					assert.match(result.content[0]?.text ?? "", /CDP \/json\/version: did not return a valid payload/, mode);
				}
				await assert.rejects(stat(diagnosticUserDataDir));
				assert.equal(isTestPidAlive(diagnosticPid), false, mode);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	}
});

test("agentBrowserExtension cleans Electron resources when upstream connect cannot spawn", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-missing-upstream-"));
	const applicationsDir = join(tempDir, "Applications");
	const emptyBinDir = join(tempDir, "empty-bin");
	const nodeOnlyBinDir = join(tempDir, "node-only-bin");
	const launchLogPath = join(tempDir, "electron-launch.log");
	try {
		await mkdir(applicationsDir, { recursive: true });
		await mkdir(emptyBinDir, { recursive: true });
		await mkdir(nodeOnlyBinDir, { recursive: true });
		await symlink(process.execPath, join(nodeOnlyBinDir, "node"), "file");
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.MissingUpstreamElectron", launchLogPath, name: "Missing Upstream Electron" });
		// Put a `node` shim on PATH so the fake Electron `#!/usr/bin/env node` launcher can start, but keep
		// `agent-browser` off PATH so upstream `connect` fails with ENOENT (missing-binary) instead of picking up
		// a real binary from the Node install directory.
		const pathSeparator = process.platform === "win32" ? ";" : ":";
		const isolatedPath = `${nodeOnlyBinDir}${pathSeparator}${emptyBinDir}`;
		await withPatchedEnv({ PATH: isolatedPath }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { electron: { action: "launch", appPath: app.appPath } });
			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "missing-binary");
			assert.match(result.content[0]?.text ?? "", /Electron cleanup after failed attach/);
			const [launchLog] = (await readFile(launchLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number; userDataDir: string });
			assert.ok(launchLog);
			await assert.rejects(stat(launchLog.userDataDir));
			assert.equal(isTestPidAlive(launchLog.pid), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension keeps restored Electron profile when process ownership is unverified", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const userDataDir = await createSecureTempDirectory("electron-profile-");
	try {
		const cleanupResult = await cleanupElectronLaunchResources({
			record: {
				appName: "Unverified Electron",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: "electron-unverified-test",
				launchedByWrapper: true,
				pid: process.pid,
				port: 9,
				userDataDir,
				version: 1,
			},
			timeoutMs: 50,
		});
		assert.equal(cleanupResult.partial, true);
		assert.equal(cleanupResult.steps.find((step) => step.resource === "process")?.state, "failed");
		assert.equal(cleanupResult.steps.find((step) => step.resource === "user-data-dir")?.state, "skipped");
		assert.deepEqual(cleanupResult.remainingResources.sort(), ["process", "user-data-dir"]);
		await stat(userDataDir);
	} finally {
		await cleanupSecureTempArtifacts();
	}
});


test("agentBrowserExtension restores Electron launch records and cleans them on shutdown", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-restore-"));
	const applicationsDir = join(tempDir, "Applications");
	const upstreamLogPath = join(tempDir, "agent-browser.log");
	const launchLogPath = join(tempDir, "electron-launch.log");
	const basePath = process.env.PATH ?? "";
	let launchedPid: number | undefined;
	try {
		await mkdir(applicationsDir, { recursive: true });
		const app = await writeFakeLaunchableElectronApp({ applicationsDir, bundleId: "com.example.RestoreElectron", launchLogPath, name: "Restore Electron" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const firstHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);
			const launchResult = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, { electron: { action: "launch", appPath: app.appPath, handoff: "connect" } });
			assert.equal(launchResult.isError, false);
			const launch = (launchResult.details?.electron as { launch: { launchId: string; pid: number; userDataDir: string } }).launch;
			launchedPid = launch.pid;

			const restoredHarness = createExtensionHarness({ cwd: tempDir, branch: [createToolBranchEntry({ details: launchResult.details as Record<string, unknown> })] });
			await runExtensionEvent(restoredHarness.handlers, "session_start", { reason: "resume" }, restoredHarness.ctx);
			const statusResult = await executeRegisteredTool(restoredHarness.tool, restoredHarness.ctx, { electron: { action: "status", launchId: launch.launchId as string } });
			assert.equal(statusResult.isError, false);
			assert.match(statusResult.content[0]?.text ?? "", /debug port alive/);

			await runExtensionEvent(restoredHarness.handlers, "session_shutdown", { reason: "reload" }, restoredHarness.ctx);
			await assert.rejects(stat(launch.userDataDir));
			assert.equal(await waitForTestPidExit(launch.pid), true, "restored shutdown cleanup should terminate the wrapper-owned Electron process");
		});
	} finally {
		await stopTestPid(launchedPid);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects electron mixed with other input modes and caller stdin", async () => {
	const harness = createExtensionHarness({ cwd: process.cwd() });
	const conflicts: Array<{ label: string; params: AgentBrowserToolParams }> = [
		{ label: "args", params: { args: ["open", "https://example.test/"], electron: { action: "list" } } },
		{ label: "semanticAction", params: { semanticAction: { action: "click", locator: "text", value: "Export" }, electron: { action: "list" } } },
		{ label: "job", params: { job: { steps: [{ action: "open", url: "https://example.test/" }] }, electron: { action: "list" } } },
		{ label: "qa", params: { qa: { url: "https://example.test/" }, electron: { action: "list" } } },
		{ label: "sourceLookup", params: { sourceLookup: { componentName: "Panel" }, electron: { action: "list" } } },
		{ label: "networkSourceLookup", params: { networkSourceLookup: { url: "/api" }, electron: { action: "list" } } },
	];
	for (const conflict of conflicts) {
		const result = await executeRegisteredTool(harness.tool, harness.ctx, conflict.params);
		assert.equal(result.isError, true, conflict.label);
		assert.match(result.content[0]?.text ?? "", /Provide exactly one of args, semanticAction, job, qa, sourceLookup, networkSourceLookup, or electron/);
		assert.equal(result.details?.failureCategory, "validation-error");
	}

	const stdinResult = await executeRegisteredTool(harness.tool, harness.ctx, {
		electron: { action: "list" },
		stdin: "[]",
	});
	assert.equal(stdinResult.isError, true);
	assert.match(stdinResult.content[0]?.text ?? "", /Do not provide stdin with electron; electron mode is host-only or manages its own input\./);
	assert.doesNotMatch(stdinResult.content[0]?.text ?? "", /job, qa, sourceLookup, or networkSourceLookup/);
	assert.equal(stdinResult.details?.failureCategory, "validation-error");
});

test("electron discovery finds macOS Electron app bundles with query filtering", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-macos-"));
	try {
		const applicationsDir = join(tempDir, "Applications");
		await mkdir(applicationsDir, { recursive: true });
		const alpha = await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.example.Alpha", executableName: "AlphaBin", name: "Alpha App" });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.example.Beta", executableName: "BetaBin", name: "Beta App" });
		const nonElectronPath = join(applicationsDir, "Plain App.app");
		await mkdir(join(nonElectronPath, "Contents", "Resources"), { recursive: true });
		await writeFile(join(nonElectronPath, "Contents", "Resources", "app.asar"), "asar", "utf8");

		const all = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
		});
		assert.deepEqual(electronAppNames(all.apps), ["Alpha App", "Beta App"]);
		assert.equal(all.omittedCount, 0);
		assert.equal(all.apps.find((app) => app.name === "Alpha App")?.bundleId, "com.example.Alpha");
		assert.equal(all.apps.find((app) => app.name === "Alpha App")?.appPath, alpha.appPath);
		assert.equal(all.apps.find((app) => app.name === "Alpha App")?.executablePath, alpha.executablePath);
		assert.equal(all.apps.every((app) => app.platform === "darwin"), true);

		const byName = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
			query: "beta",
		});
		assert.deepEqual(electronAppNames(byName.apps), ["Beta App"]);
		const byBundleId = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
			query: "com.example.alpha",
		});
		assert.deepEqual(electronAppNames(byBundleId.apps), ["Alpha App"]);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("electron discovery annotates likely sensitive apps without blocking discovery", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-sensitive-"));
	try {
		const applicationsDir = join(tempDir, "Applications");
		await mkdir(applicationsDir, { recursive: true });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "md.obsidian", executableName: "Obsidian", name: "Obsidian" });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.tinyspeck.slackmacgap", executableName: "Slack", name: "Slack" });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.microsoft.VSCode", executableName: "Code", name: "Visual Studio Code" });
		await writeFakeMacElectronApp({ applicationsDir, bundleId: "com.example.Plain", executableName: "Plain", name: "Plain Electron" });

		const result = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			platform: "darwin",
		});

		assert.equal(result.apps.length, 4);
		const byName = new Map(result.apps.map((app) => [app.name, app]));
		assert.deepEqual(byName.get("Obsidian")?.sensitivity, {
			categories: ["notes"],
			level: "likely-sensitive",
			reason: "App name, bundle id, desktop id, or path matched common private-data app patterns; discovery still does not enforce policy.",
		});
		assert.deepEqual(byName.get("Slack")?.sensitivity?.categories, ["chat"]);
		assert.deepEqual(byName.get("Visual Studio Code")?.sensitivity?.categories, ["developer-workspace"]);
		assert.equal(byName.get("Plain Electron")?.sensitivity, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("electron discovery scans Linux desktop files and applies Electron evidence gates", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-linux-"));
	try {
		const desktopDir = join(tempDir, "applications");
		const appRoot = join(tempDir, "opt");
		await mkdir(desktopDir, { recursive: true });
		const electronExecutable = await writeFakeLinuxElectronBinary(appRoot, "demo-electron");
		const realElectronExecutable = await realpath(electronExecutable);
		const plainExecutable = join(appRoot, "plain", "plain");
		await mkdir(dirname(plainExecutable), { recursive: true });
		await writeFile(plainExecutable, "#!/bin/sh\n", "utf8");
		await chmod(plainExecutable, 0o755);

		await writeFile(join(desktopDir, "demo.desktop"), `[Desktop Entry]
Type=Application
Name=Demo Electron
Comment=Demo comment
Exec=${electronExecutable} %U --ignored-field-code %F
Icon=demo-icon
`, "utf8");
		await writeFile(join(desktopDir, "plain.desktop"), `[Desktop Entry]
Type=Application
Name=Plain Binary
Exec=${plainExecutable} %U
`, "utf8");
		await writeFile(join(desktopDir, "hidden.desktop"), `[Desktop Entry]
Type=Application
Name=Hidden Electron
Hidden=true
Exec=${electronExecutable}
`, "utf8");
		await writeFile(join(desktopDir, "nodisplay.desktop"), `[Desktop Entry]
Type=Application
Name=No Display Electron
NoDisplay=true
Exec=${electronExecutable}
`, "utf8");
		await writeFile(join(desktopDir, "link.desktop"), `[Desktop Entry]
Type=Link
Name=Link Electron
Exec=${electronExecutable}
`, "utf8");

		const result = await discoverElectronApps({
			locations: { linuxDesktopDirectories: [desktopDir], pathEnv: "" },
			platform: "linux",
		});
		assert.deepEqual(electronAppNames(result.apps), ["Demo Electron"]);
		const app = result.apps[0];
		assert.equal(app?.platform, "linux");
		assert.equal(app?.executablePath, realElectronExecutable);
		assert.equal(app?.comment, "Demo comment");
		assert.equal(app?.icon, "demo-icon");
		assert.equal(app?.desktopId, "demo");
		assert.equal(app?.packageSource, "desktop");

		const binDir = join(tempDir, "bin");
		await mkdir(binDir, { recursive: true });
		const symlinkPath = join(binDir, "demo-link");
		await symlink(electronExecutable, symlinkPath);
		await writeFile(join(desktopDir, "symlink.desktop"), `[Desktop Entry]
Type=Application
Name=Symlink Electron
Exec=${symlinkPath}
`, "utf8");
		const symlinkResult = await discoverElectronApps({
			locations: { linuxDesktopDirectories: [desktopDir], pathEnv: "" },
			platform: "linux",
			query: "symlink",
		});
		assert.deepEqual(electronAppNames(symlinkResult.apps), ["Symlink Electron"]);
		assert.equal(symlinkResult.apps[0]?.executablePath, realElectronExecutable);

		const flatpakUserAppDirectory = join(tempDir, "flatpak", "app");
		const flatpakExecutable = await writeFakeLinuxElectronBinary(join(flatpakUserAppDirectory, "com.example.Flat", "current", "active", "files"), "flat-electron");
		const realFlatpakExecutable = await realpath(flatpakExecutable);
		await writeFile(join(desktopDir, "com.example.Flat.desktop"), `[Desktop Entry]
Type=Application
Name=Flatpak Electron
Exec=/usr/bin/flatpak run com.example.Flat
`, "utf8");
		const flatpakResult = await discoverElectronApps({
			locations: { flatpakUserAppDirectory, linuxDesktopDirectories: [desktopDir], pathEnv: "" },
			platform: "linux",
			query: "flatpak",
		});
		assert.deepEqual(electronAppNames(flatpakResult.apps), ["Flatpak Electron"]);
		assert.equal(flatpakResult.apps[0]?.executablePath, realFlatpakExecutable);
		assert.equal(flatpakResult.apps[0]?.packageSource, "flatpak");
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("electron discovery caps results, clamps maxResults, and reports omittedCount", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-cap-"));
	try {
		const applicationsDir = join(tempDir, "Applications");
		await mkdir(applicationsDir, { recursive: true });
		for (let index = 0; index < ELECTRON_DISCOVERY_MAX_RESULTS + 2; index += 1) {
			const suffix = String(index).padStart(3, "0");
			await writeFakeMacElectronApp({ applicationsDir, bundleId: `com.example.Cap${suffix}`, executableName: `Cap${suffix}`, name: `Cap App ${suffix}` });
		}

		const clamped = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			maxResults: ELECTRON_DISCOVERY_MAX_RESULTS + 1_000,
			platform: "darwin",
		});
		assert.equal(clamped.maxResults, ELECTRON_DISCOVERY_MAX_RESULTS);
		assert.equal(clamped.apps.length, ELECTRON_DISCOVERY_MAX_RESULTS);
		assert.equal(clamped.omittedCount, 2);

		const smallCap = await discoverElectronApps({
			locations: { darwinApplicationDirectories: [applicationsDir] },
			maxResults: 3,
			platform: "darwin",
		});
		assert.equal(smallCap.apps.length, 3);
		assert.equal(smallCap.omittedCount, ELECTRON_DISCOVERY_MAX_RESULTS - 1);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

