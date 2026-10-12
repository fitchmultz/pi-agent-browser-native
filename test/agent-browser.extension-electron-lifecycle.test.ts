/**
 * Purpose: Verify Electron launch, handoff, probe, and post-command health contracts.
 * Responsibilities: Assert Electron launch, handoff, probe, post-command health, and cleanup.
 * Scope: Integration-style Node test-runner coverage around the extension harness before result presentation and tab lifecycle suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-electron-lifecycle.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readRecord, readArray, readString, readNumber } from "./helpers/assertions.js";

import { Check } from "typebox/value";

import { compileAgentBrowserElectron } from "../extensions/agent-browser/lib/input-modes/electron.js";

import { getBrowserRecord } from "../extensions/agent-browser/lib/browser-transcript.js";
import { isRecord } from "../extensions/agent-browser/lib/parsing.js";
import {
	createManagedSessionRestoreKey,
	getManagedSessionRestoreScope,
} from "../extensions/agent-browser/lib/managed-session-restore.js";
import {
	getSessionPageStateKey,
	SessionPageState,
} from "../extensions/agent-browser/lib/session-page-state.js";
import {
	createExtensionHarness,
	createToolBranchEntry,
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

test(
	"agentBrowserExtension accepts action-specific electron schema and routes list without upstream spawn",
	{ concurrency: false },
	async () => {
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
			await writeFakeMacElectronApp({
				applicationsDir: join(tempDir, "Applications"),
				bundleId: "md.obsidian",
				name: "Obsidian",
			});
		} else if (process.platform === "linux") {
			const executablePath = await writeFakeLinuxElectronBinary(tempDir, "obsidian");
			const desktopDir = join(tempDir, ".local", "share", "applications");
			await mkdir(desktopDir, { recursive: true });
			await writeFile(
				join(desktopDir, "obsidian.desktop"),
				`[Desktop Entry]\nType=Application\nName=Obsidian\nExec=${executablePath}\n`,
				"utf8",
			);
		}

		try {
			await withPatchedEnv({ HOME: tempDir, PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				const tool = harness.getTool("agent_browser_electron");
				assert.ok(tool !== undefined);
				const schema = tool.parameters;
				assert.equal(Check(schema, { action: "list" }), true);
				assert.equal(Check(schema, { action: "list", maxResults: 10, query: "code" }), true);
				assert.equal(
					Check(schema, {
						action: "launch",
						allow: ["Code"],
						appArgs: ["--safe-mode"],
						appName: "Code",
						deny: ["Slack"],
						handoff: "tabs",
						targetType: "webview",
						timeoutMs: 1_000,
					}),
					true,
				);
				assert.equal(
					Check(schema, { action: "status", launchId: "launch-1", timeoutMs: 1_000 }),
					true,
				);
				assert.equal(Check(schema, { action: "status", timeoutMs: 1_000 }), true);
				assert.equal(Check(schema, { action: "cleanup", all: true, timeoutMs: 1_000 }), true);
				assert.equal(Check(schema, { action: "status", all: true, launchId: "launch-1" }), false);
				assert.equal(Check(schema, { action: "cleanup", all: true, launchId: "launch-1" }), false);
				assert.equal(Check(schema, { action: "status", all: false }), false);
				assert.equal(Check(schema, { action: "cleanup", all: false }), false);
				assert.equal(Check(schema, {}), false);
				assert.equal(Check(schema, { action: "probe" }), true);
				assert.equal(
					Check(schema, { action: "probe", launchId: "launch-1", timeoutMs: 1_000 }),
					true,
				);
				assert.equal(Check(schema, { action: "probe", timeoutMs: 0 }), false);
				assert.equal(Check(schema, { action: "probe", handoff: "tabs" }), false);
				assert.equal(Check(schema, { action: "status", handoff: "tabs" }), false);
				assert.equal(Check(schema, { action: "cleanup", handoff: "tabs" }), false);
				assert.equal(Check(schema, { action: "list", launchId: "launch-1" }), false);
				assert.equal(Check(schema, { action: "list", query: 42 }), false);
				assert.equal(Check(schema, { action: "list", query: "" }), false);
				assert.equal(Check(schema, { action: "list", maxResults: "10" }), false);
				assert.equal(Check(schema, { action: "list", maxResults: 1.5 }), false);
				assert.equal(Check(schema, { action: "launch", allow: [""] }), false);
				assert.equal(
					Check(schema, {
						action: "launch",
						appName: "Code",
						appPath: "/Applications/Visual Studio Code.app",
					}),
					true,
				);
				assert.equal(
					Check(schema, { action: "launch", appName: "Code", launchId: "launch-1" }),
					false,
				);

				const listResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "list", maxResults: 1, query: "__piab_no_matching_electron_app__" },
				});
				assert.equal(listResult.isError, false);
				assert.match(
					readString(readRecord(listResult.content[0]).text),
					/Electron apps \(0 found\):/,
				);
				assert.deepEqual(readRecord(listResult.details).compiledElectron, {
					action: "list",
					maxResults: 1,
					query: "__piab_no_matching_electron_app__",
				});
				assert.equal(readRecord(readRecord(listResult.details).electron).action, "list");
				assert.equal(readRecord(readRecord(listResult.details).electron).status, "succeeded");
				assert.equal(readRecord(listResult.details).resultCategory, "success");
				if (process.platform === "darwin" || process.platform === "linux") {
					const sensitiveListResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "list", maxResults: 5, query: "Obsidian" },
					});
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(sensitiveListResult.isError, false);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(sensitiveListResult.content[0]).text),
						/Obsidian.*\[likely sensitive: notes\]/,
					);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(sensitiveListResult.content[0]).text),
						/Review likely-sensitive apps and use caller-owned allow\/deny policy before launch\./,
					);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(sensitiveListResult.content[0]).text),
						/Profile note: electron\.launch starts an isolated temporary profile/,
					);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(sensitiveListResult.content[0]).text),
						/For already-authenticated desktop app content, do not stop here/,
					);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(sensitiveListResult.content[0]).text),
						/launch the normal app with --remote-debugging-port=<port>/,
					);
					const electronDetails = readRecord(readRecord(sensitiveListResult.details).electron);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(readNumber(electronDetails.sensitiveAppCount ?? 0) >= 1);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						readRecord(electronDetails.profileIsolation).reusesExistingSignedInProfile,
						false,
					);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						readRecord(electronDetails.profileIsolation).attachesToAlreadyRunningApp,
						false,
					);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(electronDetails.profileIsolation).hostDebugLaunchExample ?? ""),
						/open -a <App Name> --args --remote-debugging-port=9222/,
					);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.ok(
						readArray(electronDetails.apps).some(
							(app) =>
								readRecord(app).name === "Obsidian" &&
								readRecord(readRecord(app).sensitivity).level === "likely-sensitive" &&
								readArray(readRecord(readRecord(app).sensitivity).categories).includes("notes"),
						),
					);
				}
				assert.deepEqual(await readInvocationLog(logPath), []);

				const missingAction = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: {},
				});
				assert.equal(missingAction.isError, true);
				assert.match(
					readString(readRecord(missingAction.content[0]).text),
					/electron\.action must be one of: list, launch, status, cleanup, probe/,
				);
				assert.equal(readRecord(missingAction.details).failureCategory, "validation-error");

				const unknownAction = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "bogus" },
				});
				assert.equal(unknownAction.isError, true);
				assert.match(
					readString(readRecord(unknownAction.content[0]).text),
					/electron\.action must be one of/,
				);

				const statusWithHandoff = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "status", handoff: "tabs" },
				});
				assert.equal(statusWithHandoff.isError, true);
				assert.match(
					readString(readRecord(statusWithHandoff.content[0]).text),
					/electron\.status does not support electron\.handoff/,
				);

				for (const action of ["status", "cleanup"] as const) {
					// Complete each replay/status subtest before changing the shared live Electron launch state.
					// oxlint-disable-next-line no-await-in-loop
					const allFalse = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action, all: false },
					});
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(allFalse.isError, true, action);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(
						readString(readRecord(allFalse.content[0]).text),
						/electron\.all must be true when provided/,
					);
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(allFalse.details).failureCategory, "validation-error");
				}

				const probeWithListField = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "probe", query: "demo" },
				});
				assert.equal(probeWithListField.isError, true);
				assert.match(
					readString(readRecord(probeWithListField.content[0]).text),
					/electron\.probe only supports action, launchId, and timeoutMs; remove electron\.query/,
				);

				const probeWithoutSession = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "probe", launchId: "launch-1" },
				});
				assert.equal(probeWithoutSession.isError, true);
				assert.deepEqual(readRecord(probeWithoutSession.details).compiledElectron, {
					action: "probe",
					launchId: "launch-1",
				});
				assert.match(
					readString(readRecord(probeWithoutSession.content[0]).text),
					/No wrapper-tracked Electron launch found for launchId launch-1/,
				);
				assert.equal(readRecord(probeWithoutSession.details).failureCategory, "validation-error");

				const badQuery = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "list", query: 7 },
				});
				assert.equal(badQuery.isError, true);
				assert.match(
					readString(readRecord(badQuery.content[0]).text),
					/electron\.query must be a non-empty string/,
				);

				const listWithLaunchField = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "list", appName: "Code" },
				});
				assert.equal(listWithLaunchField.isError, true);
				assert.match(
					readString(readRecord(listWithLaunchField.content[0]).text),
					/electron\.list only supports query and maxResults; remove electron\.appName/,
				);

				const missingLaunchTarget = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "launch" },
				});
				assert.equal(missingLaunchTarget.isError, true);
				assert.match(
					readString(readRecord(missingLaunchTarget.content[0]).text),
					/electron\.launch requires exactly one of appPath, appName, bundleId, or executablePath/,
				);
				assert.equal(readRecord(missingLaunchTarget.details).failureCategory, "validation-error");
				const ambiguousLaunchTarget = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: {
						action: "launch",
						appName: "Code",
						appPath: "/Applications/Visual Studio Code.app",
					},
				});
				assert.equal(ambiguousLaunchTarget.isError, true);
				assert.match(
					readString(readRecord(ambiguousLaunchTarget.content[0]).text),
					/electron\.launch requires exactly one of appPath, appName, bundleId, or executablePath/,
				);

				const reservedAppArg = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: {
						action: "launch",
						appPath: "/Applications/Demo.app",
						appArgs: ["--remote-debugging-port=9222"],
					},
				});
				assert.equal(reservedAppArg.isError, true);
				assert.match(
					readString(readRecord(reservedAppArg.content[0]).text),
					/electron\.appArgs must not include wrapper-owned launch flag --remote-debugging-port=9222/,
				);
				assert.equal(readRecord(reservedAppArg.details).failureCategory, "validation-error");
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("Electron list timeout guidance never recommends an unsupported nested timeout", async () => {
	for (const action of ["launch", "status", "cleanup", "probe"] as const) {
		const result = compileAgentBrowserElectron({
			action,
			timeoutMs: 1_000,
			...(action === "launch" ? { appName: "Demo" } : {}),
		});
		// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(result.error, undefined, action);
		// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.ok(result.compiled && result.compiled.action !== "list");
		// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(result.compiled.timeoutMs, 1_000, action);
	}
	const harness = createExtensionHarness({ cwd: process.cwd() });
	const nested = await executeRegisteredTool(harness.tool, harness.ctx, {
		electron: { action: "list", timeoutMs: 1_000 },
	});
	assert.equal(readRecord(nested.details).failureCategory, "validation-error");
	assert.match(
		readString(readRecord(nested.content[0]).text),
		/list only supports query and maxResults; remove electron\.timeoutMs/,
	);
	const top = await executeRegisteredTool(harness.tool, harness.ctx, {
		electron: { action: "list" },
		timeoutMs: 1_000,
	});
	assert.equal(top.isError, true);
	assert.equal(readRecord(top.details).failureCategory, "validation-error");
	assert.match(
		readString(readRecord(top.content[0]).text),
		/electron\.list has no configurable timeout/,
	);
	assert.doesNotMatch(readString(readRecord(top.content[0]).text), /Use electron\.timeoutMs/);
	const status = await executeRegisteredTool(harness.tool, harness.ctx, {
		electron: { action: "status" },
		timeoutMs: 1_000,
	});
	assert.equal(status.isError, true);
	assert.match(readString(readRecord(status.content[0]).text), /Use electron\.timeoutMs/);
});

test(
	"Electron status separates cleanup history from live resources and preserves replay selection",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-status-history-"));
		const basePath = process.env.PATH ?? "";
		try {
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir: tempDir,
				bundleId: "com.example.StatusHistory",
				launchLogPath: join(tempDir, "launch.log"),
				name: "Status History",
			});
			await writeFakeAgentBrowserBinary(
				tempDir,
				fakeAgentBrowserLifecycleScript(join(tempDir, "upstream.log")),
			);
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const owner = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(owner.handlers, "session_start", { reason: "new" }, owner.ctx);
				try {
					const launched = await executeRegisteredTool(owner.tool, owner.ctx, {
						electron: {
							action: "launch",
							appPath: app.appPath,
							appArgs: app.appArgs,
							handoff: "connect",
						},
					});
					assert.equal(launched.isError, false, JSON.stringify(launched));
					const launch = readRecord(readRecord(launched.details).electron).launch;
					for (const cleanupState of ["active", "partial", "dead", "failed", "cleaned"] as const) {
						// Complete each replay/status subtest before changing the shared live Electron launch state.
						// oxlint-disable-next-line no-await-in-loop
						await t.test(`${cleanupState} history with a currently live PID and port`, async () => {
							// Replay old cleanup history while the fixture's PID and port are independently live.
							const record = { ...readRecord(launch), cleanupState, sessionName: undefined };
							const replay = createExtensionHarness({
								cwd: tempDir,
								branch: [
									createToolBranchEntry({ details: readRecord(launched.details) }),
									createToolBranchEntry({
										details: { electron: { cleanup: { records: [record] } } },
									}),
								],
							});
							await runExtensionEvent(
								replay.handlers,
								"session_start",
								{ reason: "resume" },
								replay.ctx,
							);
							const result = await executeRegisteredTool(replay.tool, replay.ctx, {
								electron: { action: "status", launchId: readRecord(launch).launchId },
							});
							assert.equal(result.isError, false, JSON.stringify(result));
							const details = readRecord(readRecord(result.details).electron);
							assert.equal(readRecord(readArray(details.statuses)[0]).cleanupState, cleanupState);
							assert.equal(readRecord(readArray(details.statuses)[0]).pidAlive, true);
							assert.equal(readRecord(readArray(details.statuses)[0]).portAlive, true);
							assert.match(
								readString(readRecord(result.content[0]).text),
								/debug port alive, pid alive/,
							);
							for (const all of [undefined, true]) {
								// Complete each replay/status subtest before changing the shared live Electron launch state.
								// oxlint-disable-next-line no-await-in-loop
								const selected = await executeRegisteredTool(replay.tool, replay.ctx, {
									electron: { action: "status", ...(all === true ? { all } : {}) },
								});
								// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(selected.isError, false, JSON.stringify(selected));
								// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									readArray(readRecord(readRecord(selected.details).electron).statuses).length,
									cleanupState === "cleaned" ? 0 : 1,
								);
							}
							assert.deepEqual(
								readArray(readRecord(result.details).nextActions ?? []).map(
									(action) => readRecord(action).id,
								),
								cleanupState === "cleaned"
									? []
									: ["status-electron-launch", "probe-electron-launch", "cleanup-electron-launch"],
							);
							if (cleanupState === "cleaned") {
								// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.match(
									readString(readRecord(result.content[0]).text),
									/historical cleaned launch record/,
								);
							} else {
								// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.doesNotMatch(
									readString(readRecord(result.content[0]).text),
									/historical|cleaned launch record/,
								);
							}
							assert.equal(readRecord(readArray(details.statuses)[0]).userDataDirState, "present");
							assert.match(
								readString(readRecord(result.content[0]).text),
								/Tracked profile path: present/,
							);
							assert.equal("userDataDirState" in readRecord(readArray(details.launches)[0]), false);
						});
					}
					const cleaned = await executeRegisteredTool(owner.tool, owner.ctx, {
						electron: { action: "cleanup", launchId: readRecord(launch).launchId },
					});
					assert.equal(cleaned.isError, false, JSON.stringify(cleaned));
					await t.test(
						"real cleanup and transcript replay freshly report an absent profile",
						async () => {
							const replay = createExtensionHarness({
								cwd: tempDir,
								branch: owner.ctx.sessionManager.getBranch().slice(),
							});
							await runExtensionEvent(
								replay.handlers,
								"session_start",
								{ reason: "resume" },
								replay.ctx,
							);
							const result = await executeRegisteredTool(replay.tool, replay.ctx, {
								electron: { action: "status", launchId: readRecord(launch).launchId },
							});
							assert.equal(result.isError, false);
							const status = readArray(readRecord(readRecord(result.details).electron).statuses)[0];
							assert.equal(readRecord(status).cleanupState, "cleaned");
							assert.equal(readRecord(status).pidAlive, false);
							assert.equal(readRecord(status).portAlive, false);
							assert.equal(readRecord(status).userDataDirState, "absent");
							assert.match(
								readString(readRecord(result.content[0]).text),
								/historical cleaned launch record/,
							);
							assert.match(
								readString(readRecord(result.content[0]).text),
								/Tracked profile path: absent/,
							);
						},
					);
				} finally {
					await runExtensionEvent(
						owner.handlers,
						"session_shutdown",
						{ reason: "quit" },
						owner.ctx,
					);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension launches Electron with isolated profile, snapshot handoff, status, and cleanup",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-launch-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.DemoElectron",
				launchLogPath,
				name: "Demo Electron",
			});
			await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
			await withPatchedEnv(
				{ AGENT_BROWSER_NAMESPACE: "ambient-at-launch", PATH: `${tempDir}:${basePath}` },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: {
							action: "launch",
							appArgs: [...app.appArgs, "--fixture-mode"],
							appPath: app.appPath,
						},
					});
					assert.equal(launchResult.isError, false);
					assert.match(
						readString(readRecord(launchResult.content[0]).text),
						/Electron launch: Demo Electron attached/,
					);
					assert.match(
						readString(readRecord(launchResult.content[0]).text),
						/Identifiers: launchId .* sessionName .* for browser snapshot\/tab commands/,
					);
					assert.match(
						readString(readRecord(launchResult.content[0]).text),
						/Profile note: electron\.launch starts an isolated temporary profile/,
					);
					assert.match(
						readString(readRecord(launchResult.content[0]).text),
						/does not reuse the app's normal signed-in profile/,
					);
					assert.match(
						readString(readRecord(launchResult.content[0]).text),
						/do not stop here: if host tools are allowed/,
					);
					assert.match(
						readString(readRecord(launchResult.content[0]).text),
						/then run agent_browser connect <port>/,
					);
					assert.match(
						readString(readRecord(launchResult.content[0]).text),
						/Snapshot handoff: 1 interactive ref/,
					);
					assert.match(
						readString(readRecord(launchResult.content[0]).text),
						/Cleanup: use details\.nextActions cleanup-electron-launch or call electron\.cleanup with launchId/,
					);
					const launchDetails = readRecord(launchResult.details);
					const launchRecord = readRecord(readRecord(launchDetails.electron).launch);
					assert.equal(launchDetails.sessionMode, "fresh");
					assert.deepEqual(readRecord(launchDetails.electron).identifiers, {
						appName: "Demo Electron",
						launchId: launchRecord.launchId,
						sessionName: launchRecord.sessionName,
					});
					assert.equal(
						readRecord(readRecord(launchDetails.electron).profileIsolation)
							.reusesExistingSignedInProfile,
						false,
					);
					assert.equal(
						readRecord(readRecord(launchDetails.electron).profileIsolation)
							.attachesToAlreadyRunningApp,
						false,
					);
					assert.match(
						readString(
							readRecord(readRecord(launchDetails.electron).profileIsolation)
								.hostDebugLaunchExample ?? "",
						),
						/agent_browser connect 9222/,
					);
					assert.equal(readArray(launchDetails.effectiveArgs).at(-2), "connect");
					assert.match(
						readString(readArray(launchDetails.effectiveArgs).at(-1) ?? ""),
						/\/devtools\/page\/page-1$/,
					);
					assert.deepEqual(readRecord(launchDetails.refSnapshot).refIds, ["e1"]);
					assert.deepEqual(
						readRecord(readRecord(readRecord(launchDetails.electron).handoff).refSnapshot).refIds,
						["e1"],
					);
					assert.ok(
						readArray(launchDetails.nextActions).some(
							(action) =>
								readRecord(action).id === "cleanup-electron-launch" &&
								readRecord(readRecord(action).params).launchId === launchRecord.launchId,
						),
					);
					assert.ok(
						readArray(launchDetails.nextActions).some(
							(action) =>
								readRecord(action).id === "snapshot-electron-session" &&
								readArray(readRecord(readRecord(action).params).args).includes("snapshot"),
						),
					);

					const launchLog = (await readFile(launchLogPath, "utf8"))
						.trim()
						.split("\n")
						.map((line) => readRecord(JSON.parse(line)));
					assert.equal(launchLog.length, 1);
					assert.equal(readArray(launchLog[0].args).includes("--remote-debugging-port=0"), true);
					assert.equal(readArray(launchLog[0].args).includes("--fixture-mode"), true);
					assert.equal(launchLog[0].userDataDir, launchRecord.userDataDir);
					assert.match(readString(launchRecord.userDataDir), /electron-profile-/);
					await stat(readString(launchRecord.userDataDir));

					const invocationsAfterLaunch = await readInvocationLog(upstreamLogPath);
					assert.deepEqual(
						invocationsAfterLaunch.map((entry) => entry.args.at(-2)),
						["connect", "get", "tab", "snapshot"],
					);
					assert.equal(invocationsAfterLaunch[1].args.at(-1), "url");
					assert.equal(invocationsAfterLaunch[0].args.includes("--session"), true);

					const snapshotResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(snapshotResult.isError, false, JSON.stringify(snapshotResult));
					assert.equal(readRecord(snapshotResult.details).sessionName, launchRecord.sessionName);
					assert.equal(readRecord(snapshotResult.details).namespace, undefined);
					assert.equal(readRecord(snapshotResult.details).usedImplicitSession, true);
					assert.equal(readRecord(snapshotResult.details).attachedBrowserSession, true);
					const snapshotInvocations = (await readInvocationLog(upstreamLogPath)).slice(
						invocationsAfterLaunch.length,
					);
					const snapshotCommandIndex = snapshotInvocations.findIndex(
						(entry) => entry.args.at(-2) === "snapshot",
					);
					assert.ok(snapshotCommandIndex > 0);
					assert.ok(
						snapshotInvocations
							.slice(0, snapshotCommandIndex)
							.some((entry) => entry.args.at(-2) === "get" && entry.args.at(-1) === "url"),
					);
					assert.equal(
						snapshotInvocations.every(
							(entry) =>
								entry.args[entry.args.indexOf("--session") + 1] === launchRecord.sessionName,
						),
						true,
					);

					await rm(upstreamLogPath, { force: true });
					const statusResult = await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "redirected" }, () =>
						executeRegisteredTool(harness.tool, harness.ctx, {
							electron: {
								action: "status",
								launchId: launchRecord.launchId,
							},
						}),
					);
					assert.equal(statusResult.isError, false);
					assert.match(readString(readRecord(statusResult.content[0]).text), /debug port alive/);
					assert.match(
						readString(readRecord(statusResult.content[0]).text),
						/Identifiers: launchId .*; sessionName/,
					);
					assert.deepEqual(
						readRecord(readRecord(statusResult.details).electron).identifiers,
						readRecord(launchDetails.electron).identifiers,
					);
					assert.equal(
						readArray(readRecord(readRecord(statusResult.details).electron).targets ?? []).length,
						1,
					);
					const statusInvocations = await readInvocationLog(upstreamLogPath);
					assert.equal(statusInvocations.length, 2);
					assert.deepEqual(
						statusInvocations.map((entry) => entry.args.at(-1)),
						["url", "title"],
					);
					assert.equal(
						statusInvocations.every(
							(entry) => entry.args[entry.args.indexOf("--namespace") + 1] === "",
						),
						true,
					);
					assert.equal(
						statusInvocations.every((entry) => readRecord(entry).restore === null),
						true,
					);

					await rm(upstreamLogPath, { force: true });
					const probeResult = await withPatchedEnv({ AGENT_BROWSER_NAMESPACE: "redirected" }, () =>
						executeRegisteredTool(harness.tool, harness.ctx, {
							electron: { action: "probe", timeoutMs: 10_000 },
						}),
					);
					assert.equal(probeResult.isError, false);
					assert.match(
						readString(readRecord(probeResult.content[0]).text),
						/Electron probe: Demo Electron — app:\/\/demo/,
					);
					assert.match(
						readString(readRecord(probeResult.content[0]).text),
						/Focused: button\/button "Run" \(#run-button\)/,
					);
					assert.match(
						readString(readRecord(probeResult.content[0]).text),
						/Snapshot: 1 interactive ref\(s\)/,
					);
					const probeDetails = readRecord(probeResult.details);
					assert.deepEqual(readRecord(probeResult.details).compiledElectron, {
						action: "probe",
						timeoutMs: 10_000,
					});
					assert.equal(readRecord(probeDetails.electron).action, "probe");
					assert.deepEqual(
						readRecord(probeDetails.electron).identifiers,
						readRecord(launchDetails.electron).identifiers,
					);
					assert.equal(readRecord(readRecord(probeDetails.electron).probe).title, "Demo Electron");
					assert.equal(readRecord(readRecord(probeDetails.electron).probe).url, "app://demo");
					assert.equal(
						readRecord(readRecord(readRecord(probeDetails.electron).probe).focusedElement).id,
						"run-button",
					);
					assert.deepEqual(
						readRecord(readRecord(readRecord(probeDetails.electron).probe).snapshot).refIds,
						["e1"],
					);
					assert.equal(readRecord(readRecord(probeDetails.electron).probe).refSnapshot, undefined);
					assert.deepEqual(readRecord(probeDetails.refSnapshot).refIds, ["e1"]);
					assert.equal(probeDetails.sessionName, launchRecord.sessionName);
					assert.deepEqual(probeDetails.sessionTabTarget, {
						title: "Demo Electron",
						url: "app://demo",
					});
					const probeInvocations = await readInvocationLog(upstreamLogPath);
					assert.deepEqual(
						probeInvocations.map((entry) => entry.args.at(-2)),
						["get", "get", "eval", "tab", "snapshot"],
					);
					assert.deepEqual(
						probeInvocations.slice(0, 2).map((entry) => entry.args.at(-1)),
						["url", "title"],
					);
					assert.equal(
						probeInvocations.every(
							(entry) => entry.args[entry.args.indexOf("--namespace") + 1] === "",
						),
						true,
					);
					assert.equal(
						probeInvocations.every((entry) => readRecord(entry).restore === null),
						true,
					);

					const namespacedBranch = harness.ctx.sessionManager.getBranch().map((entry) => {
						const record = getBrowserRecord(entry);
						if (!record || !isRecord(entry)) {
							return entry;
						}
						const state = record.event.state;
						const { id: _id, parentId: _parentId, ...newEntry } = entry;
						return Object.assign(newEntry, {
							data: {
								...record,
								event: {
									...record.event,
									state: {
										...state,
										namespace: "team",
										...(isRecord(state.managedSessionOutcome)
											? {
													managedSessionOutcome: {
														...state.managedSessionOutcome,
														currentSessionNamespace: "team",
													},
												}
											: {}),
										...(isRecord(state.electron) && isRecord(state.electron.launch)
											? {
													electron: {
														...state.electron,
														launch: { ...state.electron.launch, namespace: "team" },
													},
												}
											: {}),
									},
									pages: record.event.pages?.map((page) =>
										Object.assign({}, page, {
											key: readString(
												getSessionPageStateKey(readString(launchRecord.sessionName), "team"),
											),
										}),
									),
								},
							},
						});
					});
					harness.setBranch(namespacedBranch);
					await runExtensionEvent(
						harness.handlers,
						"session_tree",
						{ newLeafId: "namespaced", oldLeafId: null },
						harness.ctx,
					);
					const namespacedProbe = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "probe" },
					});
					assert.equal(namespacedProbe.isError, false, JSON.stringify(namespacedProbe));
					assert.equal(readRecord(namespacedProbe.details).namespace, "team");
					assert.deepEqual(readRecord(readRecord(namespacedProbe.details).refSnapshot).refIds, [
						"e1",
					]);
					const restoredPageState = SessionPageState.fromBranch(
						harness.ctx.sessionManager.getBranch(),
					);
					const namespacedPageStateKey = getSessionPageStateKey(
						readString(readRecord(namespacedProbe.details).sessionName),
						"team",
					);
					assert.ok(
						typeof namespacedPageStateKey === "string" && namespacedPageStateKey.length > 0,
					);
					assert.deepEqual(restoredPageState.get(namespacedPageStateKey).refSnapshot?.refIds, [
						"e1",
					]);
					assert.equal(
						restoredPageState.get(readString(readRecord(namespacedProbe.details).sessionName))
							.refSnapshot,
						undefined,
					);

					await rm(upstreamLogPath, { force: true });
					const namespacedLaunchIdProbe = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: {
							action: "probe",
							launchId: launchRecord.launchId,
						},
					});
					assert.equal(
						namespacedLaunchIdProbe.isError,
						false,
						JSON.stringify(namespacedLaunchIdProbe),
					);
					assert.equal(readRecord(namespacedLaunchIdProbe.details).namespace, "team");
					const namespacedLaunchIdProbeInvocations = await readInvocationLog(upstreamLogPath);
					assert.equal(namespacedLaunchIdProbeInvocations.length, 5);
					assert.equal(
						namespacedLaunchIdProbeInvocations.every(
							(entry) => entry.args[entry.args.indexOf("--namespace") + 1] === "team",
						),
						true,
					);

					const broadTextResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "text", "body"],
					});
					assert.equal(broadTextResult.isError, false);
					assert.match(
						readString(readRecord(broadTextResult.content[0]).text),
						/Broad Electron get text selector warning: selector "body" may read the entire app shell/,
					);
					const broadTextDetails = readRecord(broadTextResult.details);
					assert.equal(readRecord(broadTextDetails.electronGetTextScopeWarning).selector, "body");
					assert.deepEqual(
						readRecord(broadTextDetails.electronGetTextScopeWarning).electronContext,
						{
							launchId: launchRecord.launchId,
							sessionName: launchRecord.sessionName,
							url: "app://demo",
						},
					);
					assert.ok(
						readArray(broadTextDetails.nextActions).some(
							(action) =>
								readRecord(action).id === "snapshot-for-electron-text-scope" &&
								readArray(readRecord(readRecord(action).params).args).includes("snapshot"),
						),
					);

					const recordingResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["record", "start", "electron-cleanup.webm"],
					});
					assert.equal(recordingResult.isError, false, JSON.stringify(recordingResult));
					const blockedCleanup = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: {
							action: "cleanup",
							launchId: launchRecord.launchId,
						},
						outputPath: "electron-cleanup.webm",
					});
					assert.equal(blockedCleanup.isError, true);
					assert.match(
						readString(readRecord(blockedCleanup.content[0]).text),
						/electron-cleanup\.webm is reserved by an active recording/,
					);
					const stillActive = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: {
							action: "status",
							launchId: launchRecord.launchId,
						},
					});
					assert.equal(stillActive.isError, false);
					assert.equal(
						readRecord(readArray(readRecord(readRecord(stillActive.details).electron).statuses)[0])
							.portAlive,
						true,
					);
					const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: {
							action: "cleanup",
							launchId: launchRecord.launchId,
						},
					});
					assert.equal(cleanupResult.isError, false);
					assert.match(readString(readRecord(cleanupResult.content[0]).text), /fully cleaned/);
					const cleanupManifest = readRecord(readRecord(cleanupResult.details).artifactManifest);
					assert.equal(
						readArray(cleanupManifest.entries ?? []).some(
							(entry) => readRecord(entry).subcommand === "start",
						),
						false,
					);
					const releasedRecordingPath = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["pdf", "electron-cleanup.webm"],
					});
					assert.doesNotMatch(
						readString(readRecord(releasedRecordingPath.content[0]).text),
						/reserved by an active recording/,
					);
					await assert.rejects(stat(readString(launchRecord.userDataDir)));
					const finalInvocations = await readInvocationLog(upstreamLogPath);
					const cleanupClose = finalInvocations.find((entry) => entry.args.at(-1) === "close");
					assert.ok(cleanupClose);
					assert.equal(cleanupClose.args[cleanupClose.args.indexOf("--namespace") + 1], "team");
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension retains headed autosave policy for Electron cleanup close",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-headed-cleanup-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		let launchedPid: number | undefined;
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.HeadedCleanup",
				launchLogPath,
				name: "Headed Cleanup",
			});
			await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
			await withPatchedEnv(
				{
					AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined,
					AGENT_BROWSER_HEADED: "1",
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
					const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: {
							action: "launch",
							appPath: app.appPath,
							appArgs: app.appArgs,
							handoff: "snapshot",
						},
					});
					assert.equal(launchResult.isError, false, JSON.stringify(launchResult));
					assert.equal(readRecord(launchResult.details).managedSessionHeadedAutosaveDisabled, true);
					const launch = readRecord(readRecord(launchResult.details).electron).launch;
					assert.equal(typeof readRecord(launch).launchId, "string");
					launchedPid = readNumber(readRecord(launch).pid);

					const fork = createExtensionHarness({
						cwd: tempDir,
						sessionId: "ordinary-electron-fork",
						branch: harness.ctx.sessionManager.getBranch(),
					});
					await runExtensionEvent(fork.handlers, "session_start", { reason: "fork" }, fork.ctx);
					const beforeForkQuit = (await readInvocationLog(upstreamLogPath)).length;
					const foreignCleanup = await executeRegisteredTool(fork.tool, fork.ctx, {
						electron: { action: "cleanup", all: true },
					});
					assert.equal(
						readArray(
							readRecord(readRecord(readRecord(foreignCleanup.details).electron).cleanup).records ??
								[],
						).length,
						0,
					);
					await runExtensionEvent(fork.handlers, "session_shutdown", { reason: "quit" }, fork.ctx);
					assert.equal(
						(await readInvocationLog(upstreamLogPath))
							.slice(beforeForkQuit)
							.some((entry) => entry.args.includes("close")),
						false,
						"copied launch facts cannot give a new Pi UUID cleanup ownership",
					);
					assert.equal(typeof launchedPid, "number");
					process.kill(launchedPid, 0);
					assert.ok(
						(await stat(readString(readRecord(launch).userDataDir))).isDirectory(),
						"the parent's live profile survives fork quit",
					);

					await rm(upstreamLogPath, { force: true });
					const statusResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "status", launchId: readRecord(launch).launchId },
					});
					assert.equal(statusResult.isError, false, JSON.stringify(statusResult));
					const probeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "probe", launchId: readRecord(launch).launchId },
					});
					assert.equal(probeResult.isError, false, JSON.stringify(probeResult));
					const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "cleanup", launchId: readRecord(launch).launchId },
					});
					assert.equal(cleanupResult.isError, false, JSON.stringify(cleanupResult));
					const helperInvocations = await readInvocationLog(upstreamLogPath);
					assert.ok(helperInvocations.length >= 7, JSON.stringify(helperInvocations));
					assert.equal(
						helperInvocations.every((entry) => entry.autosave === "0"),
						true,
						JSON.stringify(helperInvocations),
					);
					if (
						typeof readRecord(launch).userDataDir === "string" &&
						readRecord(launch).userDataDir !== ""
					) {
						// The profile was validated as present before cleanup; this branch verifies removal of that same tracked path.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						await assert.rejects(stat(readString(readRecord(launch).userDataDir)));
					}
				},
			);
		} finally {
			if (launchedPid !== undefined && launchedPid !== 0) {
				await stopTestPid(launchedPid);
			}
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension applies managed restore policy to every current-session electron.probe helper",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-probe-restore-"));
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const basePath = process.env.PATH ?? "";
		execFileSync("git", ["init", "-q", tempDir], { stdio: "ignore" });
		await writeFakeAgentBrowserBinary(tempDir, fakeAgentBrowserLifecycleScript(upstreamLogPath));
		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_ENCRYPTION_KEY: "a".repeat(64),
					USERPROFILE: tempDir,
					ALL_PROXY: undefined,
					HTTP_PROXY: undefined,
					HTTPS_PROXY: undefined,
					HOME: tempDir,
					PATH: `${tempDir}:${basePath}`,
					all_proxy: undefined,
					http_proxy: undefined,
					https_proxy: undefined,
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
					assert.equal(opened.isError, false, JSON.stringify(opened));
					await rm(upstreamLogPath, { force: true });

					const probe = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "probe" },
					});
					assert.equal(probe.isError, false, JSON.stringify(probe));
					const invocations = readArray(await readInvocationLog(upstreamLogPath));
					assert.deepEqual(
						invocations.map((entry) => readArray(readRecord(entry).args).at(-2)),
						["get", "get", "eval", "tab", "snapshot"],
					);
					const restoreKey = createManagedSessionRestoreKey(
						tempDir,
						getManagedSessionRestoreScope(readString(readRecord(opened.details).sessionName)),
					);
					assert.equal(
						invocations.every((entry) => readRecord(entry).restore === restoreKey),
						true,
					);

					await writeFakeAgentBrowserBinary(
						tempDir,
						`const args = process.argv.slice(2);
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: true, runtime: { restoreKey: process.env.AGENT_BROWSER_RESTORE } } }));
} else {
  process.stdout.write(JSON.stringify({ success: false, error: "probe failed" }));
  process.exitCode = 2;
}`,
					);
					const failedProbe = await executeRegisteredTool(harness.tool, harness.ctx, {
						electron: { action: "probe" },
					});
					assert.equal(failedProbe.isError, true, JSON.stringify(failedProbe));
					assert.equal(readRecord(failedProbe.details).failureCategory, "upstream-error");
					assert.match(
						readString(readRecord(failedProbe.content[0]).text),
						/Electron probe failed/,
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension allows follow-up inspection on local file pages",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-normal-file-text-scope-"));
		const localUrl = pathToFileURL(join(tempDir, "normal-browser-fixture.html")).href;
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const args = process.argv.slice(2);
const commandIndex = args.findIndex((arg) => arg === "open" || arg === "get" || arg === "close");
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
const data = command === "open"
  ? { title: "Normal file page", url: ${JSON.stringify(localUrl)} }
  : command === "get" && subcommand === "text"
    ? { origin: ${JSON.stringify(localUrl)}, text: "normal page text" }
    : command === "get" && subcommand === "url"
      ? { result: ${JSON.stringify(localUrl)}, url: ${JSON.stringify(localUrl)} }
      : { closed: true };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt: "Read a normal file page.",
				});
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const openResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", localUrl],
					sessionMode: "fresh",
				});
				assert.equal(openResult.isError, false);

				const textResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "text", "body"],
				});
				assert.equal(textResult.isError, false, JSON.stringify(textResult));
				assert.match(readString(readRecord(textResult.content[0]).text), /normal page text/);
				const probeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "probe" },
				});
				assert.equal(probeResult.isError, false, JSON.stringify(probeResult));
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension follows a live Electron probe onto local pages",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-probe-local-drift-"));
		const localUrl = pathToFileURL(join(tempDir, "drifted-local-page.html")).href;
		const logPath = join(tempDir, "agent-browser.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const commandIndex = args.findIndex((arg) => ["close", "get", "open"].includes(arg));
const command = args[commandIndex];
const subcommand = args[commandIndex + 1];
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ command, subcommand }) + "\\n");
const data = command === "open"
  ? { title: "Safe page", url: "https://fixture.invalid/" }
  : command === "get" && subcommand === "url"
    ? { result: ${JSON.stringify(localUrl)}, url: ${JSON.stringify(localUrl)} }
    : command === "get" && subcommand === "title"
      ? { result: "SECRET LOCAL TITLE", title: "SECRET LOCAL TITLE" }
      : { closed: true };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const openResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://fixture.invalid/"],
					sessionMode: "fresh",
				});
				assert.equal(openResult.isError, false, JSON.stringify(openResult));
				await rm(logPath, { force: true });

				const probeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "probe" },
				});
				assert.equal(probeResult.isError, false, JSON.stringify(probeResult));
				assert.match(JSON.stringify(probeResult), /SECRET LOCAL TITLE/);
				const invocations = (await readFile(logPath, "utf8"))
					.trim()
					.split("\n")
					.map((line) => readRecord(JSON.parse(line)));
				assert.deepEqual(
					invocations
						.slice(0, 2)
						.map((entry) => [readRecord(entry).command, readRecord(entry).subcommand]),
					[
						["get", "url"],
						["get", "title"],
					],
				);
				assert.equal(invocations.length, 5);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reports Electron session mismatch and launchId-aware probe",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-mismatch-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const basePath = process.env.PATH ?? "";
		let launchedPid: number | undefined;
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.MismatchElectron",
				launchLogPath,
				name: "Mismatch Electron",
			});
			await writeFakeAgentBrowserBinary(
				tempDir,
				fakeAgentBrowserLifecycleScript(upstreamLogPath, {
					sessionTitle: "Blank Page",
					sessionUrl: "about:blank",
					tabTitle: "Blank Page",
					tabUrl: "about:blank",
				}),
			);
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs },
				});
				assert.equal(launchResult.isError, false);
				const launchDetails = readRecord(launchResult.details);
				const launchRecord = readRecord(readRecord(launchDetails.electron).launch);
				launchedPid = readNumber(launchRecord.pid);
				const launch = launchRecord;
				const launchId = readString(launch.launchId);
				const sessionName = readString(launch.sessionName);

				await rm(upstreamLogPath, { force: true });
				const currentUrlResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(currentUrlResult.isError, false);
				assert.match(
					readString(readRecord(currentUrlResult.content[0]).text),
					/Electron session mismatch: managed session .* is on about:blank, but launch .* still has live target Demo Electron/,
				);
				const currentUrlDetails = readRecord(currentUrlResult.details);
				assert.equal(readRecord(currentUrlDetails.electronSessionMismatch).launchId, launchId);
				assert.equal(
					readRecord(currentUrlDetails.electronSessionMismatch).reason,
					"managed-session-about-blank-while-launch-target-live",
				);
				assert.equal(
					readRecord(readRecord(currentUrlDetails.electronSessionMismatch).managedSession).url,
					"about:blank",
				);
				assert.equal(
					readRecord(readRecord(currentUrlDetails.electronSessionMismatch).liveTarget).url,
					"app://demo",
				);
				const currentUrlActionIds = new Set(
					readArray(currentUrlDetails.nextActions).map((action) => readRecord(action).id),
				);
				for (const actionId of [
					"status-electron-launch",
					"probe-electron-launch",
					"reattach-electron-launch",
					"cleanup-electron-launch",
					"snapshot-electron-session",
				]) {
					// Fixed Electron platform/action/status variants require their applicable assertions; common schema/outcome checks remain unconditional.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(currentUrlActionIds.has(actionId), true, actionId);
				}
				assert.ok(
					readArray(currentUrlDetails.nextActions).some(
						(action) =>
							readRecord(action).id === "reattach-electron-launch" &&
							readRecord(readRecord(action).params).sessionMode === "fresh" &&
							readArray(readRecord(readRecord(action).params).args)[0] === "connect",
					),
				);

				const statusResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "status", launchId },
				});
				assert.equal(statusResult.isError, false);
				assert.match(
					readString(readRecord(statusResult.content[0]).text),
					/Electron session mismatch: managed session .* is on about:blank, but launch .* still has live target Demo Electron/,
				);
				const statusDetails = readRecord(statusResult.details);
				assert.equal(
					readRecord(readRecord(statusDetails.electron).managedSession).url,
					"about:blank",
				);
				assert.equal(
					readRecord(readRecord(statusDetails.electron).sessionMismatch).reason,
					"managed-session-about-blank-while-launch-target-live",
				);
				assert.equal(
					readRecord(readRecord(readRecord(statusDetails.electron).sessionMismatch).liveTarget).url,
					"app://demo",
				);
				assert.ok(
					readArray(statusDetails.nextActions).some(
						(action) =>
							readRecord(action).id === "probe-electron-launch" &&
							readRecord(readRecord(action).params).launchId === launchId,
					),
				);
				assert.ok(
					readArray(statusDetails.nextActions).some(
						(action) => readRecord(action).id === "reattach-electron-launch",
					),
				);
				const statusActionIds = readArray(statusDetails.nextActions ?? []).map(
					(action) => readRecord(action).id,
				);
				assert.deepEqual(statusActionIds.slice(0, 3), [
					"status-electron-launch",
					"probe-electron-launch",
					"reattach-electron-launch",
				]);
				assert.ok(
					statusActionIds.indexOf("reattach-electron-launch") <
						statusActionIds.indexOf("snapshot-electron-session"),
				);

				await rm(upstreamLogPath, { force: true });
				const currentProbeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "probe", timeoutMs: 5_000 },
				});
				assert.equal(currentProbeResult.isError, false);
				assert.match(
					readString(readRecord(currentProbeResult.content[0]).text),
					/Probe context: current managed session .* maps to Electron launch/,
				);
				assert.match(
					readString(readRecord(currentProbeResult.content[0]).text),
					/Electron session mismatch: managed session .* is on about:blank, but launch .* still has live target Demo Electron/,
				);
				const currentProbeDetails = readRecord(currentProbeResult.details);
				assert.equal(
					readRecord(readRecord(currentProbeDetails.electron).probeContext).mode,
					"current-managed-session",
				);
				assert.equal(
					readRecord(readRecord(currentProbeDetails.electron).probeContext).launchId,
					launchId,
				);
				assert.equal(
					readRecord(readRecord(currentProbeDetails.electron).probeContext).sessionName,
					sessionName,
				);
				assert.equal(
					readRecord(readRecord(currentProbeDetails.electron).sessionMismatch).reason,
					"managed-session-about-blank-while-launch-target-live",
				);

				await rm(upstreamLogPath, { force: true });
				const launchProbeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "probe", launchId, timeoutMs: 5_000 },
				});
				assert.equal(launchProbeResult.isError, false);
				assert.match(
					readString(readRecord(launchProbeResult.content[0]).text),
					/Probe context: wrapper launch .* session/,
				);
				const launchProbeDetails = readRecord(launchProbeResult.details);
				assert.deepEqual(launchProbeDetails.compiledElectron, {
					action: "probe",
					launchId,
					timeoutMs: 5_000,
				});
				assert.equal(
					readRecord(readRecord(launchProbeDetails.electron).probeContext).mode,
					"launchId",
				);
				assert.equal(
					readRecord(readRecord(launchProbeDetails.electron).probeContext).sessionName,
					sessionName,
				);
				assert.equal(launchProbeDetails.usedImplicitSession, false);
				const launchProbeInvocations = await readInvocationLog(upstreamLogPath);
				assert.equal(
					launchProbeInvocations.every(
						(entry) => entry.args.includes("--session") && entry.args.includes(sessionName),
					),
					true,
				);

				const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "cleanup", launchId },
				});
				assert.equal(cleanupResult.isError, false);
				await assert.rejects(stat(readString(launchRecord.userDataDir)));
				assert.equal(
					await waitForTestPidExit(readNumber(launchRecord.pid)),
					true,
					"electron.cleanup should terminate the launched fake Electron process",
				);
			});
		} finally {
			await stopTestPid(launchedPid);
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension surfaces Electron post-command death and fill verification",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-post-command-health-"));
		const applicationsDir = join(tempDir, "Applications");
		const upstreamLogPath = join(tempDir, "agent-browser.log");
		const launchLogPath = join(tempDir, "electron-launch.log");
		const statePath = join(tempDir, "agent-browser-state.json");
		const basePath = process.env.PATH ?? "";
		let launchedPid: number | undefined;
		try {
			await mkdir(applicationsDir, { recursive: true });
			const app = await writeFakeLaunchableElectronApp({
				applicationsDir,
				bundleId: "com.example.HealthElectron",
				launchLogPath,
				name: "Health Electron",
			});
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
else if (command === "snapshot") write({ origin: currentPage().url, title: currentPage().title, url: currentPage().url, refs: { e1: { role: "textbox", name: "File name" } }, snapshot: "- textbox \\"File name\\" [ref=e1]" });
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
				const launchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "launch", appPath: app.appPath, appArgs: app.appArgs },
				});
				assert.equal(launchResult.isError, false);
				const launch = readRecord(readRecord(launchResult.details).electron).launch;
				launchedPid = readNumber(readRecord(launch).pid);

				const fillResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["fill", "@e1", "agent-browser-smoke.txt"],
				});
				assert.equal(fillResult.isError, false);
				assert.match(
					readString(readRecord(fillResult.content[0]).text),
					/Fill verification warning: fill @e1 reported success/,
				);
				assert.match(readString(readRecord(fillResult.content[0]).text), /Electron ref freshness:/);
				const fillDetails = readRecord(fillResult.details);
				assert.deepEqual(fillDetails.fillVerification, {
					actual: "",
					expected: "agent-browser-smoke.txt",
					method: "value",
					nextActionIds: ["inspect-after-fill-verification", "verify-filled-value"],
					reason: "value-fill-mismatch",
					selector: "@e1",
					status: "mismatch",
					summary:
						"Fill verification warning: fill @e1 reported success, but get value returned an empty value.",
				});
				assert.equal(
					readRecord(fillDetails.electronRefFreshness).launchId,
					readRecord(launch).launchId,
				);
				assert.ok(
					readArray(fillDetails.nextActions).some(
						(action) =>
							readRecord(action).id === "inspect-after-fill-verification" &&
							readArray(readRecord(readRecord(action).params).args).includes("snapshot"),
					),
				);
				assert.ok(
					readArray(fillDetails.nextActions).some(
						(action) => readRecord(action).id === "refresh-electron-refs-after-rerender",
					),
				);

				const clickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				assert.equal(clickResult.isError, true);
				assert.equal(readRecord(clickResult.details).failureCategory, "tab-drift");
				assert.match(
					readString(readRecord(clickResult.content[0]).text),
					/Electron lifecycle warning: click command completed, but launch .* is no longer healthy/,
				);
				assert.match(
					readString(readRecord(clickResult.content[0]).text),
					/debug port dead, pid dead/,
				);
				const clickDetails = readRecord(clickResult.details);
				assert.equal(
					readRecord(clickDetails.electronPostCommandHealth).launchId,
					readRecord(launch).launchId,
				);
				assert.equal(readRecord(clickDetails.electronPostCommandHealth).reason, "process-dead");
				assert.equal(
					readRecord(readRecord(clickDetails.electronPostCommandHealth).status).pidAlive,
					false,
				);
				assert.equal(
					readRecord(readRecord(clickDetails.electronPostCommandHealth).status).portAlive,
					false,
				);
				assert.ok(
					readArray(clickDetails.nextActions).some(
						(action) =>
							readRecord(action).id === "status-electron-launch" &&
							readRecord(readRecord(action).params).launchId === readRecord(launch).launchId,
					),
				);
				assert.ok(
					readArray(clickDetails.nextActions).some(
						(action) =>
							readRecord(action).id === "cleanup-electron-launch" &&
							readRecord(readRecord(action).params).launchId === readRecord(launch).launchId,
					),
				);

				const cleanupResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					electron: { action: "cleanup", launchId: readRecord(launch).launchId },
				});
				assert.equal(cleanupResult.isError, false);
				await assert.rejects(stat(readString(readRecord(launch).userDataDir)));
			});
		} finally {
			await stopTestPid(launchedPid);
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension applies electron.probe timeoutMs to bounded subprocess probes",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-electron-probe-timeout-"));
		const logPath = join(tempDir, "agent-browser.log");
		const readyPath = join(tempDir, "url-ready");
		const releasePath = join(tempDir, "release-url");
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
if (args.includes("get") && args.includes("url")) {
	fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));
	while (!fs.existsSync(${JSON.stringify(releasePath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	process.stdout.write(JSON.stringify({ success: true, data: { result: "late" } }));
	return;
}
process.stdout.write(JSON.stringify({ success: true, data: { result: "late" } }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const connectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["connect", "9222"],
				});
				assert.equal(connectResult.isError, false);
				const connectNextActions = readArray(readRecord(connectResult.details).nextActions);
				const connectedSessionName = readString(readRecord(connectResult.details).sessionName);
				assert.ok(typeof connectedSessionName === "string" && connectedSessionName.length > 0);
				assert.deepEqual(
					connectNextActions.map((action) => readRecord(action).id),
					["verify-connected-session-url", "list-connected-session-tabs"],
				);
				assert.deepEqual(
					connectNextActions.map((action) => readRecord(readRecord(action).params).args),
					[
						["--session", connectedSessionName, "get", "url"],
						["--session", connectedSessionName, "tab", "list"],
					],
				);
				const safeOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://safe.example/"],
				});
				assert.equal(safeOpen.isError, false, JSON.stringify(safeOpen));

				const realSetTimeout = setTimeout;
				const realClearTimeout = clearTimeout;
				const controlledProbe = async (timeoutMs: number, expire: boolean) => {
					await rm(readyPath, { force: true });
					await rm(releasePath, { force: true });
					const controller = new AbortController();
					const ready = (async () => {
						for await (const event of watch(tempDir, {
							signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
						})) {
							if (event.filename === "url-ready") {
								return;
							}
						}
					})();
					t.mock.timers.enable({ apis: ["setTimeout"] });
					const pending = executeRegisteredTool(
						harness.tool,
						harness.ctx,
						{ electron: { action: "probe", timeoutMs } },
						controller.signal,
					);
					let guard: NodeJS.Timeout | undefined;
					try {
						await Promise.race([
							ready,
							pending.then((result) => {
								throw new Error(
									`Probe settled before get url dispatched: ${JSON.stringify(result)}`,
								);
							}),
						]);
						if (expire) {
							t.mock.timers.tick(timeoutMs);
						} else {
							await writeFile(releasePath, "go");
						}
						return await Promise.race([
							pending,
							new Promise<never>((_resolve, reject) => {
								guard = realSetTimeout(
									() => reject(new Error("Probe ignored its controlled URL read")),
									10_000,
								);
							}),
						]);
					} finally {
						t.mock.timers.reset();
						controller.abort();
						if (guard) {
							realClearTimeout(guard);
						}
						await writeFile(releasePath, "go");
						await Promise.allSettled([pending, ready]);
					}
				};
				// Start the native child before advancing its unchanged caller watchdog.
				const probeResult = await controlledProbe(1_000, true);
				assert.equal(probeResult.isError, true, JSON.stringify(probeResult));
				assert.deepEqual(
					readRecord(probeResult.details).compiledElectron,
					{ action: "probe", timeoutMs: 1_000 },
					JSON.stringify(probeResult),
				);
				assert.equal(
					readRecord(probeResult.details).failureCategory,
					"upstream-error",
					JSON.stringify(probeResult),
				);
				assert.equal(readRecord(readRecord(probeResult.details).electron).status, "failed");
				assert.match(
					readString(readRecord(probeResult.content[0]).text),
					/Electron probe failed: get url: agent-browser process exited with code 124/,
				);

				// Control: the same fixture under a generous timeout must succeed, proving the
				// bounded failure above comes from the applied timeoutMs, not any other failure.
				const controlResult = await controlledProbe(5_000, false);
				assert.equal(controlResult.isError, false, JSON.stringify(controlResult));
				assert.deepEqual(readRecord(controlResult.details).compiledElectron, {
					action: "probe",
					timeoutMs: 5_000,
				});
				const controlElectron = readRecord(readRecord(controlResult.details).electron);
				assert.equal(readRecord(controlElectron.probe).status, "succeeded");
				assert.equal(readRecord(controlElectron.probe).url, "late");
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
