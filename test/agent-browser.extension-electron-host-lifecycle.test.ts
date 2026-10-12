/**
 * Purpose: Verify Electron host launch, handoff, capture, and restored cleanup.
 * Responsibilities: Assert handoff modes, policy/abort failures, startup output and handle lifetimes, profile status, and restored host ownership.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-electron-host-lifecycle.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { readRecord, readString, readNumber, readArray } from "./helpers/assertions.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import fsPromises, {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
	type FileHandle,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
	cleanupElectronLaunchResources,
	inspectElectronLaunchStatus,
} from "../extensions/agent-browser/lib/electron/cleanup.js";
import {
	launchElectronApp,
	type ElectronLaunchRecord,
} from "../extensions/agent-browser/lib/electron/launch.js";
import { createSecureTempDirectory } from "../extensions/agent-browser/lib/temp.js";
import { readProcessStartIdentity } from "../extensions/agent-browser/lib/process-identity.js";
import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	readChildStdoutJsonLine,
	runExtensionEvent,
	stopChildProcess,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

import {
	fakeAgentBrowserLifecycleScript,
	isTestPidAlive,
	readOptionalFakeElectronLaunchLog,
	stopTestPid,
	waitForTestPidExit,
	writeFakeLaunchableElectronApp,
	writeFakeElectronProcessApp,
} from "./helpers/extension-validation-fixtures.js";

async function waitForLoggedCommand(
	logPath: string,
	command: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// Poll the observed dispatch/exit state before waiting again; parallel polls would race cancellation.
		// oxlint-disable-next-line no-await-in-loop
		if ((await readInvocationLog(logPath)).some((entry) => entry.args.includes(command))) {
			return;
		}
		// Poll the observed dispatch/exit state before waiting again; parallel polls would race cancellation.
		// oxlint-disable-next-line no-await-in-loop
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 10);
		});
	}
	throw new Error(`Timed out waiting for ${command} invocation.`);
}

function assertPostHostExitLogLifetime(beforeSize: number, afterSize: number): void {
	if (process.platform === "win32") {
		assert.equal(
			afterSize,
			beforeSize,
			"host-owned app has stopped, but its protected logs remain",
		);
	} else {
		assert.ok(afterSize > beforeSize, "detached app must still write after the host exits");
	}
}

async function cleanupLoggedElectronApps(logPath: string): Promise<void> {
	const launches = await readOptionalFakeElectronLaunchLog(logPath);
	await Promise.all(
		launches.map(async (launch) => {
			await stopTestPid(launch.pid);
			await rm(launch.userDataDir, { force: true, recursive: true });
		}),
	);
}

test(
	"agentBrowserExtension cleans Electron after post-launch managed policy rejection",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-policy-reject-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		let launchPid: number | undefined;
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.PolicyReject",
				launchLogPath,
				name: "Policy Reject",
			});
			await writeFakeAgentBrowserBinary(
				tempDir,
				`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(upstreamLogPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: true, runtime: { restoreKey: "foreign-policy" } } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "unexpected", url: "about:blank" } }));
}`,
			);
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs },
					});
					assert.equal(result.isError, true, JSON.stringify(result));
					assert.match(
						readString(readRecord(result.content[0]).text),
						/does not match the requested managed-restore policy/,
					);
					const launch = readRecord(JSON.parse((await readFile(launchLogPath, "utf8")).trim()));
					launchPid = readNumber(launch.pid);
					await waitForTestPidExit(readNumber(launch.pid));
					await assert.rejects(stat(readString(launch.userDataDir)));
					const invocations = await readInvocationLog(upstreamLogPath);
					assert.equal(
						invocations.some((entry) => entry.args.includes("connect")),
						false,
					);
				},
			);
		} finally {
			if (launchPid !== undefined && launchPid !== 0) {
				await stopTestPid(launchPid);
			}
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension allows local Electron snapshot handoff",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-protected-handoff-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const protectedUrl = `file://${join(tempDir, ".agent-browser", "sessions", "auth.html")}`;
		const basePath = process.env.PATH ?? "";
		let launchPid: number | undefined;
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.ProtectedHandoff",
				launchLogPath,
				name: "Protected Handoff",
			});
			await writeFakeAgentBrowserBinary(
				tempDir,
				fakeAgentBrowserLifecycleScript(upstreamLogPath, {
					sessionUrl: protectedUrl,
					snapshotTitle: "SECRET LOCAL CONTENT",
					snapshotUrl: protectedUrl,
				}),
			);
			await withPatchedEnv(
				{ AGENT_BROWSER_SESSION: "shared-default", PATH: `${tempDir}:${basePath}` },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs },
					});
					assert.equal(result.isError, false, JSON.stringify(result));
					assert.match(JSON.stringify(result), /SECRET LOCAL CONTENT/);
					const invocations = await readInvocationLog(upstreamLogPath);
					assert.equal(
						invocations.some(
							(entry) => entry.args.includes("snapshot") || entry.args.includes("tab"),
						),
						true,
					);
					const launch = readRecord(JSON.parse((await readFile(launchLogPath, "utf8")).trim()));
					launchPid = readNumber(launch.pid);
					assert.match(readString(readRecord(result.details).sessionName), /^piab-/);
					assert.equal(
						invocations.some((entry) => entry.args.includes("shared-default")),
						false,
						"Electron's owned launch must not attach the shared default browser session",
					);
					const launchId = readRecord(
						readRecord(readRecord(result.details).electron).identifiers,
					).launchId;
					assert.ok(typeof launchId === "string" && launchId.length > 0);
					const cleanup = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "cleanup", launchId },
					});
					assert.equal(cleanup.isError, false, JSON.stringify(cleanup));
					assert.equal(await waitForTestPidExit(readNumber(launch.pid)), true);
					await assert.rejects(stat(readString(launch.userDataDir)));
				},
			);
		} finally {
			if (launchPid !== undefined && launchPid !== 0) {
				await stopTestPid(launchPid);
			}
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension cleans an Electron launch canceled during snapshot handoff",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-canceled-handoff-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		let launchPid: number | undefined;
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.CanceledHandoff",
				launchLogPath,
				name: "Canceled Handoff",
			});
			await writeFakeAgentBrowserBinary(
				tempDir,
				`const fs = require("node:fs");
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
}`,
			);
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const controller = new AbortController();
				const resultPromise = executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs } },
					controller.signal,
				);
				await waitForLoggedCommand(upstreamLogPath, "snapshot");
				controller.abort();
				const result = await resultPromise;
				assert.equal(result.isError, true, JSON.stringify(result));
				assert.equal(readRecord(result.details).failureCategory, "aborted");
				const launch = readRecord(JSON.parse((await readFile(launchLogPath, "utf8")).trim()));
				launchPid = readNumber(launch.pid);
				assert.equal(await waitForTestPidExit(readNumber(launch.pid)), true);
				await assert.rejects(stat(readString(launch.userDataDir)));
			});
		} finally {
			if (launchPid !== undefined && launchPid !== 0) {
				await stopTestPid(launchPid);
			}
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

for (const terminateBeforeCleanup of [false, true]) {
	test(
		`Electron cleanup awaits tracked child exit before removing owned resources (already signaled: ${terminateBeforeCleanup})`,
		{ concurrency: false },
		async () => {
			const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-exit-"));
			let child: ChildProcess | undefined;
			try {
				const app = await writeFakeLaunchableElectronApp({
					applicationsDir: tempDir,
					bundleId: "com.example.CleanupExit",
					launchLogPath: join(tempDir, "launch.json"),
					name: "Cleanup Exit",
				});
				const launched = await launchElectronApp({ appPath: app.appPath, appArgs: app.appArgs });
				assert.equal(launched.ok, true, launched.ok ? undefined : JSON.stringify(launched.failure));
				child = launched.value.child;
				let exited = false;
				child.once("exit", () => {
					exited = true;
				});
				if (terminateBeforeCleanup) {
					child.kill("SIGTERM");
				}
				const cleanup = await cleanupElectronLaunchResources({
					child,
					record: launched.value.record,
				});
				assert.equal(cleanup.partial, false, JSON.stringify(cleanup));
				assert.equal(
					exited,
					true,
					"tracked process must exit before cleanup returns, not merely stop responding to PID probes",
				);
				assert.throws(() => process.kill(readNumber(launched.value.record.pid), 0), {
					code: "ESRCH",
				});
				await assert.rejects(stat(launched.value.record.userDataDir), { code: "ENOENT" });
				// In particular, Windows must release the running executable without rm retries.
				await rm(app.executablePath);
			} finally {
				if (child && child.exitCode === null && child.signalCode === null) {
					const exited = once(child, "exit", { signal: AbortSignal.timeout(2_000) });
					child.kill("SIGKILL");
					await exited;
				}
				await rm(tempDir, { force: true, recursive: true });
			}
		},
	);
}

test(
	"agentBrowserExtension supports Electron launch handoff modes",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-handoff-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.HandoffElectron",
				launchLogPath,
				name: "Handoff Electron",
			});
			await writeFakeAgentBrowserBinary(
				tempDir,
				fakeAgentBrowserLifecycleScript(upstreamLogPath).replace(
					"JSON.stringify({ args, autosave:",
					"JSON.stringify({ args, confirmActions: process.env.AGENT_BROWSER_CONFIRM_ACTIONS ?? null, autosave:",
				),
			);
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, AGENT_BROWSER_CONFIRM_ACTIONS: "click" },
				async () => {
					for (const [handoff, expectedCommands] of [
						["connect", ["connect"]],
						["tabs", ["connect", "tab"]],
					] as const) {
						// Handoff cases share one native executable and invocation log.
						// oxlint-disable-next-line no-await-in-loop
						await t.test(handoff, async (handoffTest) => {
							await rm(upstreamLogPath, { force: true });
							const harness = createExtensionHarness({ cwd: tempDir });
							await runExtensionEvent(
								harness.handlers,
								"session_start",
								{ reason: "new" },
								harness.ctx,
							);
							const result = await executeRegisteredTool(harness.tool, harness.ctx, {
								electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs, handoff },
							});
							assert.equal(result.isError, false, handoff);
							assert.match(
								result.content.at(0)?.text ?? "",
								handoff === "tabs"
									? /safer diagnostic starting point; no interactive refs were captured/
									: /Connect handoff completed: run snapshot -i before using interactive refs/,
							);
							const commands = (await readInvocationLog(upstreamLogPath))
								.map((entry) =>
									entry.args.find((token) => ["connect", "tab", "snapshot"].includes(token)),
								)
								.filter(Boolean);
							assert.deepEqual(commands, expectedCommands, handoff);
							const launchId = readString(
								readRecord(readRecord(readRecord(result.details).electron).launch).launchId,
							);
							assert.ok(launchId.length > 0);
							assert.ok(
								(await readInvocationLog(upstreamLogPath)).every(
									(call) => call.confirmActions === "click",
								),
								"Electron connect inherits the ambient setting on first admission",
							);
							const selected = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["get", "url"],
							});
							assert.equal(selected.isError, false, selected.content.at(0)?.text);
							if (handoff === "connect") {
								await handoffTest.test(
									"packaged source lookup preserves launch context and recovery",
									async () => {
										const launch = readRecord(
											readRecord(readRecord(result.details).electron).launch,
										);
										assert.equal(launch.appPath, app.appPath);
										const lookup = await executeRegisteredTool(harness.tool, harness.ctx, {
											sourceLookup: {
												componentName: "MissingPackagedComponent",
												selector: "#save",
											},
										});
										assert.equal(lookup.isError, false, JSON.stringify(lookup));
										const text = lookup.content[0].text ?? "";
										assert.match(text, /Source lookup found no candidate locations/);
										assert.match(text, /workspace scan was limited/);
										assert.match(text, /packaged Electron app code may live outside/);
										const source = readRecord(lookup.details?.sourceLookup);
										assert.equal(source.status, "no-candidates");
										assert.equal(source.workspaceRoot, tempDir);
										assert.deepEqual(source.electronContext, {
											appName: "Handoff Electron",
											appPath: app.appPath,
											executablePath: launch.executablePath,
											launchId,
											sessionName: launch.sessionName,
											url: "app://demo",
										});
										const limitations = readArray(source.limitations).map(readString).join("\n");
										assert.match(limitations, /captured execution directory/);
										assert.match(limitations, /app\.asar/);
										const actions = readArray(lookup.details?.nextActions).map(readRecord);
										assert.deepEqual(
											actions
												.filter((action) =>
													[
														"snapshot-electron-session",
														"probe-electron-launch",
														"list-electron-tabs",
													].includes(readString(action.id)),
												)
												.map(({ id, params }) => ({ id, params })),
											[
												{
													id: "snapshot-electron-session",
													params: {
														args: ["--session", launch.sessionName, "snapshot", "-i"],
													},
												},
												{ id: "probe-electron-launch", params: { action: "probe", launchId } },
												{
													id: "list-electron-tabs",
													params: {
														args: ["--session", launch.sessionName, "tab", "list"],
													},
												},
											],
										);
									},
								);
							}
							await writeFile(upstreamLogPath, "");
							await withPatchedEnv({ AGENT_BROWSER_CONFIRM_ACTIONS: "tab_new" }, async () => {
								const inspections =
									handoff === "connect"
										? ([
												{ action: "status", launchId },
												{ action: "probe", launchId },
												{ action: "probe" },
											] as const)
										: [];
								for (const electron of inspections) {
									// Status/probe calls share one launch before its final cleanup.
									// oxlint-disable-next-line no-await-in-loop
									const inspected = await executeRegisteredTool(harness.tool, harness.ctx, {
										electron,
									});
									// All three fixed selectors must succeed before cleanup.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.equal(inspected.isError, false, inspected.content.at(0)?.text);
								}
								const cleaned = await executeRegisteredTool(harness.tool, harness.ctx, {
									electron: { action: "cleanup", launchId },
								});
								assert.equal(cleaned.isError, false, cleaned.content.at(0)?.text);
							});
							const helpers = await readInvocationLog(upstreamLogPath);
							assert.ok(helpers.length > 0);
							assert.ok(helpers.some((call) => call.args.includes("close")));
							assert.ok(
								helpers.every((call) => call.confirmActions === "click"),
								"status, both probe selectors, and cleanup retain the target's selected setting",
							);
						});
					}
				},
			);
		} finally {
			await cleanupLoggedElectronApps(launchLogPath);
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension compares full Electron URLs while keeping status and probe displays bounded",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-long-url-"));
		const launchLogPath = join(tempDir, "electron-launch.log");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const url = `app://demo/${"path".repeat(100)}?target=one`;
		const otherUrl = url.replace("target=one", "target=two");
		const displayUrl = `${url.slice(0, 297)}...`;
		const basePath = process.env.PATH ?? "";
		try {
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir: tempDir,
				bundleId: "com.example.LongUrl",
				launchLogPath,
				name: "Long URL Electron",
			});
			await writeFile(
				app.scriptPath,
				(await readFile(app.scriptPath, "utf8")).replace('"app://demo"', JSON.stringify(url)),
			);
			const upstream = fakeAgentBrowserLifecycleScript(upstreamLogPath, {
				sessionUrl: url,
				snapshotUrl: url,
				tabUrl: url,
			});
			await writeFakeAgentBrowserBinary(tempDir, upstream);
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const launched = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs },
				});
				assert.equal(launched.isError, false, launched.content[0].text);
				const record = readRecord(readRecord(launched.details?.electron).launch);
				const launchId = readString(record.launchId);
				const status = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "status", launchId },
				});
				assert.equal(status.isError, false);
				const statusElectron = readRecord(status.details?.electron);
				assert.equal(statusElectron.sessionMismatch, undefined, status.content[0].text);
				assert.equal(readRecord(statusElectron.managedSession).url, displayUrl);
				assert.equal(
					readArray(status.details?.nextActions)
						.map(readRecord)
						.some((action) => action.id === "reattach-electron-launch"),
					false,
				);
				const probe = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "probe", launchId },
				});
				assert.equal(probe.isError, false);
				const probeElectron = readRecord(probe.details?.electron);
				assert.equal(probeElectron.sessionMismatch, undefined, probe.content[0].text);
				assert.equal(readRecord(probeElectron.probe).url, displayUrl);
				assert.equal(
					readString(readRecord(readRecord(probeElectron.probe).activeTab).url).length,
					240,
				);
				assert.equal(readRecord(probe.details?.sessionTabTarget).url, url);
				const followup = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "title"],
				});
				assert.equal(followup.isError, false, followup.content[0].text);
				await writeFakeAgentBrowserBinary(tempDir, upstream.replaceAll(url, otherUrl));
				const drifted = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "status", launchId },
				});
				const mismatch = readRecord(readRecord(drifted.details?.electron).sessionMismatch);
				assert.equal(mismatch.reason, "managed-session-target-not-in-launch-status");
				assert.equal(readRecord(mismatch.managedSession).url, displayUrl);
				assert.equal(readRecord(mismatch.liveTarget).url, url);
				assert.ok(
					readArray(drifted.details?.nextActions)
						.map(readRecord)
						.some((action) => action.id === "reattach-electron-launch"),
				);
				const cleaned = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "cleanup", launchId },
				});
				assert.equal(cleaned.isError, false, cleaned.content[0].text);
				assert.equal(await waitForTestPidExit(readNumber(record.pid)), true);
				await assert.rejects(stat(readString(record.userDataDir)), { code: "ENOENT" });
			});
		} finally {
			await cleanupLoggedElectronApps(launchLogPath);
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension targets Electron webviews and keeps host cleanup after close failures",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-webview-close-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.WebviewElectron",
				includeWebview: true,
				launchLogPath,
				name: "Webview Electron",
			});
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
				const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: {
						action: "launch",
						appPath: app.appPath,
						appArgs: app.appArgs,
						handoff: "connect",
						targetType: "webview",
					},
				});
				assert.equal(launchResult.isError, false);
				const launchDetails = readRecord(launchResult.details);
				const launchRecord = readRecord(readRecord(launchDetails.electron).launch);
				assert.match(
					readString(readArray(launchDetails.effectiveArgs).at(-1)),
					/\/devtools\/page\/webview-1$/,
				);

				const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: {
						action: "cleanup",
						launchId: readString(launchRecord.launchId),
						timeoutMs: 1_000,
					},
				});
				assert.equal(cleanupResult.isError, true);
				assert.equal(cleanupResult.details?.failureCategory, "cleanup-failed");
				assert.match(cleanupResult.content.at(0)?.text ?? "", /managed-session: failed/);
				await assert.rejects(stat(readString(launchRecord.userDataDir)));
				assert.equal(isTestPidAlive(readNumber(launchRecord.pid)), false);
			});
		} finally {
			await cleanupLoggedElectronApps(launchLogPath);
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension aborts Electron launch before and during app startup",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-abort-"));
		let midLaunch: AbortController | undefined;
		let pendingResult: ReturnType<typeof executeRegisteredTool> | undefined;
		const applicationsDir = join(tempDir, "Applications");
		const launchLogPath = join(tempDir, "electron-launch.log");
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.AbortElectron",
				launchLogPath,
				mode: "no-port-file",
				name: "Abort Electron",
			});
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const alreadyAborted = new AbortController();
			alreadyAborted.abort();
			const preLaunchResult = await executeRegisteredTool(
				harness.tool,
				harness.ctx,
				{ electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs } },
				alreadyAborted.signal,
			);
			assert.equal(preLaunchResult.isError, true);
			assert.equal(preLaunchResult.details?.failureCategory, "aborted");
			assert.deepEqual(await readOptionalFakeElectronLaunchLog(launchLogPath), []);

			midLaunch = new AbortController();
			pendingResult = executeRegisteredTool(
				harness.tool,
				harness.ctx,
				{
					electron: {
						action: "launch",
						appPath: app.appPath,
						appArgs: app.appArgs,
						timeoutMs: 30_000,
					},
				},
				midLaunch.signal,
			);
			let launch = (await readOptionalFakeElectronLaunchLog(launchLogPath)).at(0);
			for (let attempt = 0; launch === undefined && attempt < 750; attempt += 1) {
				// Wait between native launch-receipt observations.
				// oxlint-disable-next-line no-await-in-loop
				await delay(20);
				// Observe the receipt before another retry or mid-launch abort.
				// oxlint-disable-next-line no-await-in-loop
				launch = (await readOptionalFakeElectronLaunchLog(launchLogPath)).at(0);
			}
			assert.ok(launch, "fake Electron app should start before mid-launch abort");
			midLaunch.abort();
			const midLaunchResult = await pendingResult;
			assert.equal(midLaunchResult.isError, true);
			assert.equal(midLaunchResult.details?.failureCategory, "aborted");
			assert.doesNotMatch(
				midLaunchResult.content.at(0)?.text ?? "",
				/increase electron\.timeoutMs/,
			);
			await assert.rejects(stat(launch.userDataDir));
			assert.equal(isTestPidAlive(launch.pid), false);
		} finally {
			midLaunch?.abort();
			await pendingResult;
			await cleanupLoggedElectronApps(launchLogPath);
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension blocks Electron launch by caller policy without spawning",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-policy-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.PolicyElectron",
				launchLogPath,
				name: "Policy Electron",
			});
			await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: {
						action: "launch",
						appPath: app.appPath,
						appArgs: app.appArgs,
						deny: ["Policy Electron"],
					},
				});
				assert.equal(result.isError, true);
				assert.equal(result.details?.failureCategory, "policy-blocked");
				assert.match(result.content.at(0)?.text ?? "", /deny policy: Policy Electron/);
				assert.deepEqual(await readInvocationLog(upstreamLogPath), []);
				await assert.rejects(readFile(launchLogPath, "utf8"));
			});
		} finally {
			await cleanupLoggedElectronApps(launchLogPath);
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension cleans Electron resources when launch fails before upstream attach",
	{ concurrency: false },
	async (t) => {
		for (const { expectedCategory, mode, jsonBody, timeoutMs, writeLaunchLog } of [
			{
				expectedCategory: "timeout",
				mode: "no-port-file",
				jsonBody: undefined,
				timeoutMs: 500,
				writeLaunchLog: false,
			},
			{
				expectedCategory: "upstream-error",
				mode: "invalid-cdp",
				jsonBody: undefined,
				timeoutMs: 5_000,
				writeLaunchLog: true,
			},
			{
				expectedCategory: "upstream-error",
				mode: "invalid-cdp",
				jsonBody: "{}",
				timeoutMs: 5_000,
				writeLaunchLog: true,
			},
		] as const) {
			// Native timer and filesystem mocks must be restored before the next launch.
			// oxlint-disable-next-line no-await-in-loop
			await t.test(jsonBody === undefined ? mode : "invalid-cdp-object", async () => {
				const tempDir = await mkdtemp(join(tmpdir(), `pi-agent-browser-electron-failed-${mode}-`));
				const applicationsDir = join(tempDir, "Applications");
				const launchLogPath = join(tempDir, "electron-launch.log");
				try {
					await mkdir(applicationsDir, { recursive: true });
					const app = await writeFakeLaunchableElectronApp({
						applicationsDir,
						bundleId: `com.example.${mode}`,
						launchLogPath,
						mode,
						name: `Failed ${mode}`,
						writeLaunchLog,
					});
					if (jsonBody !== undefined) {
						await writeFile(
							app.scriptPath,
							(await readFile(app.scriptPath, "utf8")).replace(
								'response.end("not-json");',
								`response.end(${JSON.stringify(jsonBody)});`,
							),
						);
					}
					t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
					if (mode === "no-port-file") {
						// This case tests a missing port file, not how quickly native spawn/capture
						// setup completes. Expire the unchanged budget after the first real read.
						const nativeReadFile = fsPromises.readFile;
						t.mock.method(
							fsPromises,
							"readFile",
							async (...args: Readonly<Parameters<typeof readFile>>) => {
								try {
									return await nativeReadFile(...args);
								} finally {
									if (
										basename(args[0] instanceof URL ? args[0].pathname : readString(args[0])) ===
										"DevToolsActivePort"
									) {
										t.mock.timers.tick(timeoutMs + 1);
									}
								}
							},
						);
						syncBuiltinESMExports();
					} else {
						const nativeFetch = globalThis.fetch;
						t.mock.method(
							globalThis,
							"fetch",
							async (...args: Readonly<Parameters<typeof fetch>>) => {
								const response = await nativeFetch(...args);
								const input = args[0];
								const url = input instanceof Request ? input.url : String(input);
								if (url.endsWith("/json/version")) {
									const nativeJson = response.json.bind(response);
									t.mock.method(response, "json", async () => {
										try {
											return (await nativeJson()) as unknown;
										} finally {
											// Only a real response from the launched app's port expires readiness.
											t.mock.timers.tick(timeoutMs + 1);
										}
									});
								}
								return response;
							},
						);
					}
					await withPatchedEnv({ PATH: dirname(process.execPath) }, async () => {
						const harness = createExtensionHarness({ cwd: tempDir });
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						const result = await executeRegisteredTool(harness.tool, harness.ctx, {
							electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs, timeoutMs },
						});
						assert.equal(result.isError, true, mode);
						assert.equal(result.details?.failureCategory, expectedCategory, mode);
						assert.match(result.content.at(0)?.text ?? "", /Electron launch diagnostics:/, mode);
						assert.match(
							result.content.at(0)?.text ?? "",
							/Retry guidance: increase electron\.timeoutMs/,
							mode,
						);
						const diagnostics = readRecord(
							readRecord(readRecord(readRecord(result.details).electron).failure).diagnostics,
						);
						const diagnosticPid = diagnostics.pid;
						const diagnosticUserDataDir = diagnostics.userDataDir;
						assert.ok(typeof diagnosticPid === "number", mode);
						assert.equal(diagnostics.pidAlive, true, mode);
						assert.equal(diagnostics.timeoutMs, timeoutMs, mode);
						assert.ok(typeof diagnosticUserDataDir === "string", mode);
						const launchLogs = await readOptionalFakeElectronLaunchLog(launchLogPath);
						const launchLog = launchLogs.find((entry) => entry.pid === diagnosticPid);
						if (mode === "no-port-file") {
							// This exhaustive variant deliberately produces no launch receipt.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(launchLogs.length, 0, mode);
							// This variant must diagnose the missing port file.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(diagnostics.devToolsActivePort).found, false, mode);
							// The same missing-port evidence must be model-visible.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(result.content.at(0)?.text ?? "", /DevToolsActivePort: missing/, mode);
						} else {
							// The other fixed variant must produce a native launch receipt.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(launchLog, mode);
							// Hard receipt narrowing above requires the matching profile.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(diagnostics.userDataDir, launchLog.userDataDir, mode);
							// The invalid-CDP variant must still find its native port file.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(diagnostics.devToolsActivePort).found, true, mode);
							// That port must match the asserted native launch receipt.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(diagnostics.devToolsActivePort).port, launchLog.port, mode);
							// This exhaustive variant fails at CDP version validation.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(diagnostics.cdpVersionReached, false, mode);
							// The invalid-CDP evidence must be model-visible.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(
								result.content.at(0)?.text ?? "",
								/CDP \/json\/version: did not return a valid payload/,
								mode,
							);
						}
						await assert.rejects(stat(diagnosticUserDataDir));
						assert.equal(isTestPidAlive(diagnosticPid), false, mode);
					});
				} finally {
					t.mock.restoreAll();
					t.mock.timers.reset();
					syncBuiltinESMExports();
					await rm(tempDir, { force: true, recursive: true });
				}
			});
		}
	},
);

test(
	"agentBrowserExtension returns bounded redacted Electron startup output and preserves empty-output failures",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-output-"));
		const launchLogPath = join(tempDir, "launch.json");
		const stdoutEnd = "\nstdout-end\nAuthorization: Bearer fixture-output-secret\n";
		const stderrEnd = "\nstderr-end\nAPI_KEY=fixture-error-secret\n";
		try {
			const app = await writeFakeElectronProcessApp({
				applicationsDir: tempDir,
				bundleId: "com.example.StartupOutput",
				name: "Startup Output",
			});
			await writeFile(
				app.scriptPath,
				`#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(launchLogPath)}, JSON.stringify([1, 2].map((fd) => {
	const stats = fs.fstatSync(fd);
	return { regular: stats.isFile(), mode: stats.mode & 0o777 };
})));
if (!process.argv.includes("--quiet")) {
	fs.writeSync(1, "dropped-stdout-start\\n" + "O".repeat(262144) + ${JSON.stringify(stdoutEnd)});
	fs.writeSync(2, "dropped-stderr-start\\n" + "E".repeat(262144) + ${JSON.stringify(stderrEnd)});
}
process.exit(42);
`,
			);
			const harness = createExtensionHarness({ cwd: tempDir });
			for (const quiet of [false, true]) {
				// Both captures write the same launch receipt and use the same harness.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(quiet ? "quiet" : "full output", async () => {
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: {
							action: "launch",
							appPath: app.appPath,
							appArgs: [...app.appArgs, ...(quiet ? ["--quiet"] : [])],
							timeoutMs: 5_000,
						},
					});
					assert.equal(result.isError, true);
					assert.equal(result.details?.failureCategory, "upstream-error");
					const failure = readRecord(readRecord(readRecord(result.details).electron).failure);
					assert.equal(failure.reason, "spawn-error");
					assert.equal(failure.cleanupError, undefined);
					assert.equal(readRecord(failure.diagnostics).exitCode, 42);
					assert.equal(readRecord(failure.diagnostics).pidAlive, false);
					assert.equal(readRecord(failure.diagnostics).outputCaptured, true);
					const text = result.content.map((item) => item.text ?? "").join("\n");
					for (const [stream, fill, end, secret] of [
						["stdout", "O", stdoutEnd, "fixture-output-secret"],
						["stderr", "E", stderrEnd, "fixture-error-secret"],
					] as const) {
						const expected = quiet
							? ""
							: (fill.repeat(4096 - Buffer.byteLength(end)) + end).replace(secret, "[REDACTED]");
						// Both fixed streams must preserve their exact redacted tail.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(failure.diagnostics)[`${stream}Tail`], expected);
						// Both fixed streams must retain their native truncation evidence.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(failure.diagnostics)[`${stream}Truncated`], !quiet);
						// Both streams' expected tails or empty status must be visible.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(text.includes(quiet ? `App ${stream}: (empty)` : expected));
					}
					assert.doesNotMatch(
						JSON.stringify(result),
						/fixture-output-secret|fixture-error-secret|dropped-stdout-start|dropped-stderr-start|not captured/,
					);
					const nativeMode = process.platform === "win32" ? 0o666 : 0o600;
					assert.deepEqual(JSON.parse(await readFile(launchLogPath, "utf8")), [
						{ regular: true, mode: nativeMode },
						{ regular: true, mode: nativeMode },
					]);
					assert.ok(typeof failure.userDataDir === "string" && failure.userDataDir.length > 0);
					await assert.rejects(stat(failure.userDataDir), { code: "ENOENT" });
					assert.equal(isTestPidAlive(readNumber(readRecord(failure.diagnostics).pid)), false);
				});
			}
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"failed Electron startup preserves a live writer after kill denial and temp cleanup, with native host-exit lifetime",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-live-output-"));
		const launchLogPath = join(tempDir, "launch.json");
		const app = await writeFakeElectronProcessApp({
			applicationsDir: tempDir,
			bundleId: "com.example.LiveOutput",
			name: "Live Output",
		});
		// Windows executable discovery canonicalizes short temp ancestry; macOS bundle discovery may retain it.
		const launchedExecutablePath = await realpath(app.executablePath);
		await writeFile(
			app.scriptPath,
			`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const userDataDir = process.argv.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
if (process.argv.includes("--break-marker")) {
	const marker = path.join(path.dirname(userDataDir), ".pi-agent-browser-owner.json");
	fs.unlinkSync(marker);
	fs.mkdirSync(marker);
}
// Publish atomically after any marker damage: the host's denied kill and the test both wait for this receipt.
fs.writeFileSync(${JSON.stringify(`${launchLogPath}.tmp`)}, JSON.stringify({ pid: process.pid, userDataDir }));
fs.renameSync(${JSON.stringify(`${launchLogPath}.tmp`)}, ${JSON.stringify(launchLogPath)});
setInterval(() => { fs.writeSync(1, "stdout-live\\n"); fs.writeSync(2, "stderr-live\\n"); }, 20);
`,
		);
		try {
			for (const breakMarker of [false, true]) {
				// Each writer must be reaped and its shared receipt removed before the next case.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(
					breakMarker ? "broken ownership marker" : "valid ownership marker",
					async () => {
						const script = `
				import { ChildProcess } from "node:child_process";
				import { existsSync } from "node:fs";
				import { stat } from "node:fs/promises";
				import { launchElectronApp } from "./extensions/agent-browser/lib/electron/launch.ts";
				import { cleanupSecureTempArtifacts, writeSecureTempFile } from "./extensions/agent-browser/lib/temp.ts";
				// Keep the host alive until the parent verifies the denied-kill writer.
				process.once("message", () => process.disconnect());
				const sibling = await writeSecureTempFile({ content: "keep until sweep", prefix: "sibling", suffix: ".txt" });
				const kill = ChildProcess.prototype.kill;
				// The process is real; only its kill request is denied at the OS boundary.
				ChildProcess.prototype.kill = function (signal) {
					if ([${JSON.stringify(app.executablePath)}, ${JSON.stringify(launchedExecutablePath)}].includes(this.spawnfile)) {
						// Deny only a started writer, so the short launch timeout cannot outrun a slow app spawn.
						const pause = new Int32Array(new SharedArrayBuffer(4));
						for (let waited = 0; !existsSync(${JSON.stringify(launchLogPath)}) && waited < 15_000; waited += 10) Atomics.wait(pause, 0, 0, 10);
						throw new Error("fixture: child.kill denied");
					}
					return kill.call(this, signal);
				};
				const result = await launchElectronApp({ appPath: ${JSON.stringify(app.appPath)}, appArgs: ${JSON.stringify([...app.appArgs, ...(breakMarker ? ["--break-marker"] : [])])}, timeoutMs: 500 });
				ChildProcess.prototype.kill = kill;
				const siblingKept = await stat(sibling).then(() => true, () => false);
				await cleanupSecureTempArtifacts();
				console.log(JSON.stringify({ result, siblingKept, sibling }));
			`;
						const host = spawn(
							process.execPath,
							["--import", "tsx", "--input-type=module", "-e", script],
							{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"] },
						);
						let launch: { pid: number; userDataDir: string } | undefined;
						// The app writes its own receipt independently of the short launch timeout.
						const readLaunchReceipt = async () => {
							for (let attempt = 0; attempt < 100; attempt++) {
								// Observe the independently writing child's receipt before retrying.
								// oxlint-disable-next-line no-await-in-loop
								const receipt: unknown = await readFile(launchLogPath, "utf8").then(
									JSON.parse,
									() => {
										// The independently writing child may not have created its receipt yet.
									},
								);
								if (receipt !== undefined) {
									const record = readRecord(receipt);
									return {
										pid: readNumber(record.pid),
										userDataDir: readString(record.userDataDir),
									};
								}
								// Delay each missing-receipt retry within the original bounded budget.
								// oxlint-disable-next-line no-await-in-loop
								await delay(20);
							}
							return;
						};
						try {
							const receipt = readRecord(await readChildStdoutJsonLine(host));
							const receiptResult = readRecord(receipt.result);
							const receiptFailure = readRecord(receiptResult.failure);
							launch = await readLaunchReceipt();
							assert.ok(
								launch,
								`fixture app must record its pid and profile: ${JSON.stringify(receipt)}`,
							);
							assert.equal(receiptResult.ok, false);
							assert.equal(receiptFailure.reason, "timeout");
							assert.match(
								readString(receiptFailure.cleanupError ?? ""),
								/fixture: child\.kill denied/,
							);
							assert.equal(
								receipt.siblingKept,
								true,
								"preserving a profile must not sweep siblings",
							);
							assert.equal(isTestPidAlive(launch.pid), true);
							const profile = launch.userDataDir;
							const paths = ["stdout", "stderr"].map((stream) => join(profile, `${stream}.log`));
							const before = await Promise.all(paths.map((path) => stat(path)));
							await delay(60);
							const after = await Promise.all(paths.map((path) => stat(path)));
							assert.ok(
								after.every((stats, index) => stats.size > before[index].size),
								"both live logs must grow after kill denial and temp cleanup",
							);
							const exited = once(host, "exit", { signal: AbortSignal.timeout(5_000) });
							host.send("exit");
							assert.equal((await exited)[0], 0, "preserved output must not wedge host exit");
							// Node/libuv puts non-detached Windows children in a kill-on-host-exit job.
							// POSIX launches are detached; neither lifetime is an output-pipe contract.
							if (process.platform === "win32") {
								// Native Windows host-exit jobs terminate non-detached children.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(await waitForTestPidExit(launch.pid), true);
							} else {
								// POSIX detached children must outlive their native host.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(isTestPidAlive(launch.pid), true);
							}
							const beforeExit = await Promise.all(paths.map((path) => stat(path)));
							await delay(60);
							const afterExit = await Promise.all(paths.map((path) => stat(path)));
							afterExit.forEach((stats, index) =>
								assertPostHostExitLogLifetime(beforeExit[index].size, stats.size),
							);
							const markerPath = join(dirname(launch.userDataDir), ".pi-agent-browser-owner.json");
							if (breakMarker) {
								// The fixed broken-marker variant must report preservation.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.match(readString(receiptFailure.cleanupError ?? ""), /preserv/i);
							} else {
								// The fixed valid-marker variant must retain its child ownership entry.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.deepEqual(
									readRecord(JSON.parse(await readFile(markerPath, "utf8"))).protectedChildNames,
									[basename(launch.userDataDir)],
								);
							}
							await assert.rejects(stat(readString(receipt.sibling)), { code: "ENOENT" });
						} finally {
							await stopChildProcess(host);
							launch ??= await readLaunchReceipt();
							await stopTestPid(launch?.pid);
							assert.equal(isTestPidAlive(launch?.pid), false);
							if (launch) {
								await rm(dirname(launch.userDataDir), { force: true, recursive: true });
							}
							await rm(launchLogPath, { force: true });
						}
					},
				);
			}
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"Electron capture closes real file handles and retains startup errors when capture or spawn fails",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-capture-errors-"));
		const app = await writeFakeElectronProcessApp({
			applicationsDir: tempDir,
			bundleId: "com.example.CaptureErrors",
			name: "Capture Errors",
		});
		const nativeOpen = fsPromises.open;
		const handles: FileHandle[] = [];
		let fault: "open-stderr" | "spawn-sync" | "spawn-async" | "read-stdout";
		t.mock.method(fsPromises, "open", async (...args: Readonly<Parameters<typeof nativeOpen>>) => {
			const path = String(args[0]);
			if (fault === "open-stderr" && path.endsWith("stderr.log") && args[1] === "wx") {
				throw new Error("fixture: cannot open stderr capture");
			}
			if (fault === "read-stdout" && path.endsWith("stdout.log") && args[1] === "r") {
				throw new Error("fixture: cannot read stdout capture");
			}
			const handle = await nativeOpen(...args);
			if (path.endsWith("stdout.log") || path.endsWith("stderr.log")) {
				handles.push(handle);
			}
			// Remove the verified executable only after discovery, before native spawn.
			if (fault === "spawn-async" && path.endsWith("stderr.log") && args[1] === "wx") {
				await rename(app.executablePath, `${app.executablePath}.held`);
			}
			return handle;
		});
		syncBuiltinESMExports();
		try {
			for (fault of ["open-stderr", "spawn-sync", "spawn-async", "read-stdout"] as const) {
				// The native mock reads the selected fault and mutates one shared executable.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(fault, async () => {
					handles.length = 0;
					await writeFile(app.scriptPath, "process.exit(42);\n");
					const harness = createExtensionHarness({ cwd: tempDir });
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: {
							action: "launch",
							appPath: app.appPath,
							appArgs: [...app.appArgs, ...(fault === "spawn-sync" ? ["bad\0argument"] : [])],
							timeoutMs: 5_000,
						},
					});
					assert.equal(result.isError, true, fault);
					const failure = readRecord(readRecord(readRecord(result.details).electron).failure);
					assert.equal(failure.reason, "spawn-error", fault);
					assert.equal(failure.cleanupError, undefined, fault);
					assert.ok(handles.length > 0, fault);
					assert.ok(
						handles.every((handle) => handle.fd === -1),
						`${fault}: all acquired native capture/read handles must close`,
					);
					if (fault === "open-stderr") {
						// This exhaustive fault must identify the failed capture open.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(readString(failure.error), /cannot open stderr capture/);
					}
					if (fault === "spawn-sync") {
						// This exhaustive fault must identify the invalid native argv.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(readString(failure.error), /null bytes/);
					}
					if (fault === "spawn-async") {
						await rename(`${app.executablePath}.held`, app.executablePath);
						// This exhaustive fault must identify the missing executable.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(readString(failure.error), /ENOENT/);
					}
					if (fault === "read-stdout") {
						// This exhaustive capture-read failure must preserve the app's actual exit.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(failure.diagnostics).exitCode, 42);
						// A failed stdout read must not fabricate a tail.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(failure.diagnostics).stdoutTail, undefined);
						// The same fixed fault must preserve its explicit read error.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(failure.diagnostics).stdoutError,
							"fixture: cannot read stdout capture",
						);
						// This fault must not corrupt the independently readable stderr.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(failure.diagnostics).stderrTail, "");
						// This capture-read error must also be model-visible.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(
							result.content.at(0)?.text ?? "",
							/App stdout capture error: fixture: cannot read stdout capture/,
						);
					}
					assert.ok(typeof failure.userDataDir === "string" && failure.userDataDir.length > 0);
					await assert.rejects(stat(failure.userDataDir), { code: "ENOENT" });
				});
			}
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension cleans Electron resources when upstream connect cannot spawn",
	{ concurrency: false },
	async () => {
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
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.MissingUpstreamElectron",
				launchLogPath,
				name: "Missing Upstream Electron",
			});
			// Put a `node` shim on PATH so the fake Electron `#!/usr/bin/env node` launcher can start, but keep
			// `agent-browser` off PATH so upstream `connect` fails with ENOENT (missing-binary) instead of picking up
			// a real binary from the Node install directory.
			const pathSeparator = process.platform === "win32" ? ";" : ":";
			const isolatedPath = `${nodeOnlyBinDir}${pathSeparator}${emptyBinDir}`;
			await withPatchedEnv({ PATH: isolatedPath }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs },
				});
				assert.equal(result.isError, true);
				assert.equal(result.details?.failureCategory, "missing-binary");
				assert.match(result.content.at(0)?.text ?? "", /Electron cleanup after failed attach/);
				const launchLogs = (await readFile(launchLogPath, "utf8"))
					.trim()
					.split("\n")
					.map((line) => {
						const record = readRecord(JSON.parse(line));
						return { pid: readNumber(record.pid), userDataDir: readString(record.userDataDir) };
					});
				const launchLog = launchLogs.at(0);
				assert.ok(launchLog !== undefined);
				await assert.rejects(stat(launchLog.userDataDir));
				assert.equal(isTestPidAlive(launchLog.pid), false);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("Electron profile status measures the current path without changing the launch record", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-profile-status-"));
	const present = join(tempDir, "present");
	const absent = join(tempDir, "removed");
	const dangling = join(tempDir, "dangling");
	const parentFile = join(tempDir, "not-a-directory");
	// Windows reports ENOENT for a file used as a parent; a NUL path instead
	// exercises a genuine non-ENOENT native path error on that host.
	const unknown = process.platform === "win32" ? `${parentFile}\0` : join(parentFile, "profile");
	try {
		await mkdir(present);
		await mkdir(absent);
		await rm(absent, { recursive: true });
		await writeFile(parentFile, "file");
		await assert.rejects(lstat(unknown), {
			code: process.platform === "win32" ? "ERR_INVALID_ARG_VALUE" : "ENOTDIR",
		});
		if (process.platform !== "win32") {
			await symlink(absent, dangling);
			// Verify the POSIX-only dangling-symlink fixture before status inspection.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal((await lstat(dangling)).isSymbolicLink(), true);
		}
		for (const [state, userDataDir] of [
			["present", present],
			["absent", absent],
			["unknown", unknown],
			["present", dangling],
		] as const) {
			// Profile-state cases mutate the same directory; finish each before the next state.
			// oxlint-disable-next-line no-await-in-loop
			await t.test(
				`${state}: ${userDataDir === dangling ? "dangling symlink" : state}`,
				{ skip: userDataDir === dangling && process.platform === "win32" },
				async () => {
					const record: ElectronLaunchRecord = Object.freeze({
						appName: "Profile status",
						cleanupState: "cleaned",
						createdAtMs: 1,
						executablePath: process.execPath,
						launchId: "electron-profile-status",
						launchedByWrapper: true,
						pid: process.pid,
						port: 9,
						userDataDir,
						version: 1,
					});
					const status = await inspectElectronLaunchStatus(record);
					assert.equal(status.cleanupState, "cleaned");
					assert.equal(status.pidAlive, true);
					assert.equal(status.portAlive, false);
					assert.equal(status.userDataDirState, state);
					assert.equal("userDataDirState" in record, false);
					if (userDataDir === present) {
						await rm(present, { recursive: true });
						// The fixed present-profile case must observe removal.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal((await inspectElectronLaunchStatus(record)).userDataDirState, "absent");
						await mkdir(present);
						// The same case must observe recreation.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal((await inspectElectronLaunchStatus(record)).userDataDirState, "present");
					}
				},
			);
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("Electron status requires browser version metadata from a live HTTP endpoint", async (t) => {
	let payload: unknown;
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "application/json", connection: "close" });
		response.end(JSON.stringify(request.url === "/json/version" ? payload : []));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const record: ElectronLaunchRecord = {
		appName: "Metadata status",
		cleanupState: "active",
		createdAtMs: Date.now(),
		executablePath: process.execPath,
		launchId: "electron-metadata-status",
		launchedByWrapper: true,
		port: address.port,
		userDataDir: "",
		version: 1,
	};
	try {
		for (const [name, body, portAlive] of [
			["empty object", {}, false],
			["unrelated JSON", { ok: true }, false],
			["blank browser", { Browser: " " }, false],
			["minimal browser", { Browser: "Electron/Test" }, true],
			["lowercase browser", { browser: "Electron/Test" }, true],
		] as const) {
			payload = body;
			// Each real HTTP response must finish before changing the server's metadata.
			// oxlint-disable-next-line no-await-in-loop
			await t.test(name, async () => {
				const status = await inspectElectronLaunchStatus(record);
				assert.equal(status.portAlive, portAlive);
				assert.equal(status.version?.browser, portAlive ? "Electron/Test" : undefined);
			});
		}
	} finally {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}
});

for (const identityMode of ["missing", "mismatched"] as const) {
	test(`restored Electron cleanup refuses a ${identityMode} start identity despite an exact profile operand`, async () => {
		const userDataDir = await createSecureTempDirectory("electron-profile-pid-reuse-");
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${userDataDir}`],
			{ stdio: "ignore" },
		);
		try {
			await once(child, "spawn");
			assert.ok(child.pid !== undefined && child.pid > 0);
			const currentIdentity = await readProcessStartIdentity(child.pid);
			assert.ok(currentIdentity !== undefined && currentIdentity.length > 0);
			const record: ElectronLaunchRecord = {
				appName: "PID reuse",
				cleanupState: "active",
				createdAtMs: Date.now(),
				executablePath: process.execPath,
				launchId: `electron-${identityMode}-identity`,
				launchedByWrapper: true,
				pid: child.pid,
				port: 9,
				userDataDir,
				version: 1,
				...(identityMode === "mismatched" ? { startIdentity: `${currentIdentity}-stale` } : {}),
			};
			const refused = await cleanupElectronLaunchResources({ record });
			assert.equal(isTestPidAlive(child.pid), true, "unverified PID must not be signaled");
			assert.equal(refused.partial, true);
			assert.equal(refused.steps.find((step) => step.resource === "process")?.state, "failed");
			assert.match(
				refused.steps.find((step) => step.resource === "process")?.error ?? "",
				/start identity.*refusing to signal a restored PID/i,
			);
			assert.equal(
				refused.steps.find((step) => step.resource === "user-data-dir")?.state,
				"skipped",
			);
			await stat(userDataDir);
		} finally {
			await stopChildProcess(child);
			await rm(userDataDir, { force: true, recursive: true });
		}
	});
}

test("restored Electron cleanup round-trips a matching start identity and removes a spaces-and-Unicode profile", async () => {
	const userDataDir = await createSecureTempDirectory("electron-profile-space é-");
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	try {
		await once(child, "spawn");
		assert.ok(child.pid !== undefined && child.pid > 0);
		const startIdentity = await readProcessStartIdentity(child.pid);
		assert.ok(startIdentity !== undefined && startIdentity.length > 0);
		const record: ElectronLaunchRecord = {
			appName: "Start identity ownership",
			cleanupState: "active",
			createdAtMs: Date.now(),
			executablePath: process.execPath,
			launchId: "electron-matching-start-identity",
			launchedByWrapper: true,
			pid: child.pid,
			port: 9,
			userDataDir,
			version: 1,
			startIdentity,
		};
		const harness = createExtensionHarness({
			cwd: userDataDir,
			branch: [
				createToolBranchEntry({ details: { electron: { launch: record } }, isError: false }),
			],
		});
		await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
		const cleaned = await executeRegisteredTool(harness.tool, harness.ctx, {
			electron: { action: "cleanup", launchId: record.launchId },
		});
		assert.equal(cleaned.isError, false, JSON.stringify(cleaned));
		const cleanup = readRecord(readRecord(cleaned.details?.electron).cleanup);
		const restoredRecord = readRecord(readArray(cleanup.records)[0]);
		assert.equal(restoredRecord.startIdentity, startIdentity);
		assert.equal(restoredRecord.cleanupState, "cleaned");
		assert.equal(await waitForTestPidExit(child.pid), true);
		await assert.rejects(stat(userDataDir), { code: "ENOENT" });
	} finally {
		await stopChildProcess(child);
		await rm(userDataDir, { force: true, recursive: true });
	}
});

test("Electron transcript restore rejects a malformed start identity", async () => {
	const record = {
		appName: "Malformed identity",
		cleanupState: "active",
		createdAtMs: Date.now(),
		executablePath: process.execPath,
		launchId: "electron-malformed-start-identity",
		launchedByWrapper: true,
		port: 9,
		userDataDir: "",
		version: 1,
		startIdentity: 42,
	};
	const harness = createExtensionHarness({
		cwd: process.cwd(),
		branch: [createToolBranchEntry({ details: { electron: { launch: record } }, isError: false })],
	});
	await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
	const status = await executeRegisteredTool(harness.tool, harness.ctx, {
		electron: { action: "status", launchId: record.launchId },
	});
	assert.equal(status.isError, true);
	assert.match(
		status.content.at(0)?.text ?? "",
		/No wrapper-tracked Electron launch found for launchId electron-malformed-start-identity/,
	);
});

test(
	"agentBrowserExtension restores Electron launch records and cleans them on shutdown",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-restore-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		let launchedPid: number | undefined;
		let firstHarness: ReturnType<typeof createExtensionHarness> | undefined;
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.RestoreElectron",
				launchLogPath,
				name: "Restore Electron",
			});
			await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				firstHarness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(
					firstHarness.handlers,
					"session_start",
					{ reason: "new" },
					firstHarness.ctx,
				);
				const launchResult = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
					electron: {
						action: "launch",
						appPath: app.appPath,
						appArgs: app.appArgs,
						handoff: "connect",
					},
				});
				assert.equal(launchResult.isError, false);
				const record = readRecord(readRecord(launchResult.details?.electron).launch);
				assert.equal(record.cleanupState, "active");
				assert.equal(record.launchedByWrapper, true);
				assert.equal(record.version, 1);
				const launch: ElectronLaunchRecord = {
					appName: readString(record.appName),
					cleanupState: "active",
					createdAtMs: readNumber(record.createdAtMs),
					executablePath: readString(record.executablePath),
					launchId: readString(record.launchId),
					launchedByWrapper: true,
					pid: readNumber(record.pid),
					port: readNumber(record.port),
					userDataDir: readString(record.userDataDir),
					version: 1,
				};
				launchedPid = launch.pid;

				const restoredHarness = createExtensionHarness({
					cwd: tempDir,
					branch: firstHarness.ctx.sessionManager.getBranch().slice(),
				});
				await runExtensionEvent(
					restoredHarness.handlers,
					"session_start",
					{ reason: "resume" },
					restoredHarness.ctx,
				);
				const statusResult = await executeRegisteredTool(
					restoredHarness.tool,
					restoredHarness.ctx,
					{ electron: { action: "status", launchId: launch.launchId } },
				);
				assert.equal(statusResult.isError, false);
				assert.match(statusResult.content.at(0)?.text ?? "", /debug port alive/);

				await runExtensionEvent(
					restoredHarness.handlers,
					"session_shutdown",
					{ reason: "quit" },
					restoredHarness.ctx,
				);
				await assert.rejects(stat(launch.userDataDir));
				assert.equal(
					await waitForTestPidExit(launch.pid),
					true,
					"restored shutdown cleanup should terminate the wrapper-owned Electron process",
				);
				const stopped = await inspectElectronLaunchStatus(launch);
				assert.equal(stopped.pidAlive, false);
				assert.equal(stopped.portAlive, false);
				assert.equal(stopped.userDataDirState, "absent");
			});
		} finally {
			// The assertions above use only the restored harness. Before deleting the
			// fixture executable, also reap the original tracked child's actual exit:
			// Windows kill(pid, 0) can report ESRCH while its image is still in use.
			const originalHarness = firstHarness;
			if (originalHarness) {
				await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
					await runExtensionEvent(
						originalHarness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						originalHarness.ctx,
					);
				});
			}
			await stopTestPid(launchedPid);
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
