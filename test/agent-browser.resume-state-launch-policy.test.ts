import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";
import { readRecord, readString } from "./helpers/assertions.js";

function assertIsString(value: unknown): asserts value is string {
	assert.equal(typeof value, "string");
}

test(
	"agentBrowserExtension reconstructs managed session state on session_start and keeps startup-scoped flags blocked after resume",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("session") && args.includes("info")) { process.stdout.write(JSON.stringify({ success: true, data: { active: false, runtime: null } })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, userAgent: process.env.AGENT_BROWSER_USER_AGENT }) + "\\n");
const envelope = args.includes("tab") && args.includes("list")
  ? { success: true, data: { tabs: [{ tabId: "t1", url: "https://dash.cloudflare.com/", active: true }] } }
  : args.includes("close") ? { success: true, data: { closed: true } }
  : args.includes("snapshot") ? { success: true, data: { origin: "https://dash.cloudflare.com/", refs: {}, snapshot: "" } }
  : { success: true, data: { url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
		);

		try {
			await withPatchedEnv(
				{ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" },
				async () => {
					const firstHarness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						firstHarness.handlers,
						"session_start",
						{ reason: "new" },
						firstHarness.ctx,
					);

					const firstOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
						sessionMode: "fresh",
						args: ["open", "https://dash.cloudflare.com"],
					});
					assert.equal(firstOpen.isError, false);
					assert.equal(
						readRecord(firstOpen.details?.compatibilityWorkaround).id,
						"cloudflare-headless-user-agent",
					);
					const sessionName = readString(firstOpen.details?.sessionName ?? "");
					assert.match(sessionName, /^piab-/);
					await runExtensionEvent(firstHarness.handlers, "session_shutdown", { reason: "resume" });
					assert.equal((await readInvocationLog(logPath)).length, 2);

					const resumedBranch = [
						...firstHarness.ctx.sessionManager.getBranch(),
						createToolBranchEntry({
							details: {
								...firstOpen.details,
								exitCode: 1,
								managedSessionOutcome: {
									...readRecord(firstOpen.details?.managedSessionOutcome),
									activeAfter: true,
									status: "created",
									succeeded: true,
								},
								resultCategory: "failure",
							},
							isError: true,
						}),
						createToolBranchEntry({
							details: {
								...firstOpen.details,
								compatibilityWorkaround: undefined,
								exitCode: 1,
								managedSessionOutcome: undefined,
							},
						}),
					];
					const resumedHarness = createExtensionHarness({ branch: resumedBranch, cwd: tempDir });
					await runExtensionEvent(
						resumedHarness.handlers,
						"session_start",
						{ reason: "resume" },
						resumedHarness.ctx,
					);

					const snapshot = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
						args: ["--session", sessionName, "snapshot", "-i"],
					});
					assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
					assert.equal(
						readRecord(snapshot.details?.compatibilityWorkaround).id,
						"cloudflare-headless-user-agent",
					);
					const snapshotInvocation = (await readInvocationLog(logPath))
						.reverse()
						.find((row) => row.args.includes("snapshot"));
					assert.ok(snapshotInvocation);
					assert.ok(snapshotInvocation.args.includes("--user-agent"));
					assert.match(
						readString(readRecord(snapshotInvocation).userAgent ?? ""),
						/Chrome\/\d+\.0\.0\.0/,
					);

					const explicitOptOut = await executeRegisteredTool(
						resumedHarness.tool,
						resumedHarness.ctx,
						{
							args: ["--session", sessionName, "--user-agent", "Custom/1", "snapshot", "-i"],
						},
					);
					assert.equal(explicitOptOut.isError, true, JSON.stringify(explicitOptOut));
					assert.match(
						readString(explicitOptOut.details?.validationError ?? ""),
						/launch-scoped flags.*--user-agent/i,
					);
					const afterOptOut = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(afterOptOut.isError, false, JSON.stringify(afterOptOut));
					assert.equal(
						readRecord(afterOptOut.details?.compatibilityWorkaround).id,
						"cloudflare-headless-user-agent",
					);
					const afterOptOutInvocation = (await readInvocationLog(logPath))
						.reverse()
						.find((entry) => entry.args.includes("snapshot"));
					assert.ok(afterOptOutInvocation);
					assert.ok(afterOptOutInvocation.args.includes("--user-agent"));
					assert.match(
						readString(readRecord(afterOptOutInvocation).userAgent ?? ""),
						/Chrome\/\d+\.0\.0\.0/,
					);

					const invocationCount = (await readInvocationLog(logPath)).length;
					const blocked = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/profiled"],
					});
					assert.equal(blocked.isError, true);
					assert.match(readString(blocked.details?.validationError ?? ""), /launch-scoped flags/i);
					assert.equal((await readInvocationLog(logPath)).length, invocationCount);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension retains headed autosave policy across follow-ups and session_tree restore",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-headed-autosave-state-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, autosave: process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS ?? null }) + "\\n");
const command = args.find((arg) => ["close", "get", "open", "snapshot"].includes(arg));
const data = args.includes("tab") && args.includes("list") ? { tabs: [{ tabId: "t1", url: "https://example.com/headed", active: true }] }
  : command === "get" ? { result: "https://example.com/headed", url: "https://example.com/headed" }
  : command === "snapshot" ? { snapshot: "- heading \\"Headed\\" [ref=e1]" }
  : command === "close" ? { closed: true }
  : { title: "Headed", url: "https://example.com/headed", lifecycle: { effectiveLaunch: { browserLaunched: true } } };
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined,
					AGENT_BROWSER_HEADED: undefined,
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
					const open = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--headed", "open", "https://example.com/headed"],
						sessionMode: "fresh",
					});
					assert.equal(open.isError, false, JSON.stringify(open));
					assert.equal(open.details?.managedSessionHeadedAutosaveDisabled, true);
					assert.deepEqual(open.details.browserWindow, {
						mode: "headed",
						ownership: "wrapper-managed",
						sessionName: open.details.sessionName,
						visibility: "unverified",
					});
					assert.deepEqual(open.details.lifecycle, { effectiveLaunch: { browserLaunched: true } });
					assert.match(
						open.content[0].text ?? "",
						/Headed browser handoff:.*desktop visibility unverified/,
					);
					assert.ok(
						!(open.content[0].text ?? "")
							.split("\n\nObservation:")[0]
							.includes(readString(open.details.sessionName)),
					);

					const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "url"],
					});
					assert.equal(followUp.isError, false, JSON.stringify(followUp));
					assert.equal(followUp.details?.managedSessionHeadedAutosaveDisabled, true);
					assert.equal(followUp.details.browserWindow, undefined);
					assert.doesNotMatch(followUp.content[0].text ?? "", /Headed browser handoff/);

					harness.setBranch(harness.ctx.sessionManager.getBranch().slice());
					await runExtensionEvent(
						harness.handlers,
						"session_tree",
						{ newLeafId: "headed", oldLeafId: "live" },
						harness.ctx,
					);
					const restoredFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(restoredFollowUp.isError, false, JSON.stringify(restoredFollowUp));
					assert.equal(restoredFollowUp.details?.managedSessionHeadedAutosaveDisabled, true);

					const sessionlessDoctor = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["doctor"],
					});
					assert.equal(sessionlessDoctor.isError, false, JSON.stringify(sessionlessDoctor));
					assert.equal(sessionlessDoctor.details?.managedSessionHeadedAutosaveDisabled, undefined);

					const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
					assert.equal(close.isError, false, JSON.stringify(close));
					assert.equal(close.details?.managedSessionHeadedAutosaveDisabled, undefined);

					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						harness.ctx,
					);
					const invocations = await readInvocationLog(logPath);
					const doctorInvocation = invocations.find((entry) => entry.args.includes("doctor"));
					const managedInvocations = invocations.filter((entry) => !entry.args.includes("doctor"));
					assert.ok(managedInvocations.length >= 4);
					assert.equal(
						managedInvocations.every((entry) => entry.autosave === "0"),
						true,
						JSON.stringify(invocations),
					);
					assert.equal(doctorInvocation?.autosave, null);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension exposes the headed handoff for a first-launch batch but not attachments or providers",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-headed-batch-"));
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("batch")) {
  const commands = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(commands.map((command) => ({ command, success: true, result: { title: "Headed batch", url: "https://example.com/headed-batch", lifecycle: { effectiveLaunch: { browserLaunched: true } } } }))));
} else if (args.includes("close")) process.stdout.write(JSON.stringify({ success: true, data: { closed: true, lifecycle: { effectiveLaunch: { browserLaunched: false } } } }));
else process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.com/headed-batch", url: "https://example.com/headed-batch", lifecycle: { effectiveLaunch: { browserLaunched: true } } } }));`,
		);
		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined,
					AGENT_BROWSER_HEADED: undefined,
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
					const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
						sessionMode: "fresh",
						args: ["--headed", "batch", "--bail"],
						stdin: JSON.stringify([["open", "https://example.com/headed-batch"]]),
					});
					assert.equal(batch.isError, false, JSON.stringify(batch));
					assert.deepEqual(batch.details?.lifecycle, {
						effectiveLaunch: { browserLaunched: true },
					});
					assert.deepEqual(batch.details.browserWindow, {
						mode: "headed",
						ownership: "wrapper-managed",
						sessionName: batch.details.sessionName,
						visibility: "unverified",
					});
					assert.match(
						batch.content[0].text ?? "",
						/Headed browser handoff:.*desktop visibility unverified/,
					);
					assert.equal(
						(await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] })).isError,
						false,
					);

					const attachedHarness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						attachedHarness.handlers,
						"session_start",
						{ reason: "new" },
						attachedHarness.ctx,
					);
					const attached = await executeRegisteredTool(attachedHarness.tool, attachedHarness.ctx, {
						args: ["--headed", "--cdp", "9222", "open", "https://example.com/headed-batch"],
					});
					assert.equal(attached.isError, false, JSON.stringify(attached));
					assert.equal(attached.details?.attachedBrowserSession, true);
					assert.equal(attached.details.browserWindow, undefined);
					assert.doesNotMatch(attached.content[0].text ?? "", /Headed browser handoff/);
					assert.equal(
						(
							await executeRegisteredTool(attachedHarness.tool, attachedHarness.ctx, {
								args: ["close"],
							})
						).isError,
						false,
					);

					for (const provider of [
						{
							args: [
								"--headed",
								"--provider",
								"browserbase",
								"open",
								"https://example.com/headed-batch",
							],
							env: undefined,
						},
						{
							args: ["--headed", "-p", "browserbase", "open", "https://example.com/headed-batch"],
							env: undefined,
						},
						{ args: ["--headed", "open", "https://example.com/headed-batch"], env: "browserbase" },
					]) {
						// Restore scenarios share environment and browser ownership; complete each transition and cleanup in order.
						// oxlint-disable-next-line no-await-in-loop
						await withPatchedEnv({ AGENT_BROWSER_PROVIDER: provider.env }, async () => {
							const providerHarness = createExtensionHarness({ cwd: tempDir });
							await runExtensionEvent(
								providerHarness.handlers,
								"session_start",
								{ reason: "new" },
								providerHarness.ctx,
							);
							const launched = await executeRegisteredTool(
								providerHarness.tool,
								providerHarness.ctx,
								{ args: provider.args },
							);
							// The nonempty provider fixture matrix exhaustively verifies each case; any failed assertion fails the test.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(launched.isError, false, JSON.stringify(launched));
							// The nonempty provider fixture matrix exhaustively verifies each case; any failed assertion fails the test.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.deepEqual(launched.details?.lifecycle, {
								effectiveLaunch: { browserLaunched: true },
							});
							// The nonempty provider fixture matrix exhaustively verifies each case; any failed assertion fails the test.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(launched.details.browserWindow, undefined);
							// The nonempty provider fixture matrix exhaustively verifies each case; any failed assertion fails the test.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.doesNotMatch(launched.content[0].text ?? "", /Headed browser handoff/);
							// The nonempty provider fixture matrix exhaustively verifies each case; any failed assertion fails the test.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								(
									await executeRegisteredTool(providerHarness.tool, providerHarness.ctx, {
										args: ["close"],
									})
								).isError,
								false,
							);
						});
					}
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension requires a fresh daemon before changing a resumed headed autosave interval",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(
			join(tmpdir(), "pi-agent-browser-headed-autosave-explicit-resume-"),
		);
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, autosave: process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS ?? null }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: false } }));
} else {
  const command = args.find((arg) => ["close", "get", "open"].includes(arg));
  const data = args.includes("tab") && args.includes("list") ? { tabs: [{ tabId: "t1", url: "https://example.com/headed", active: true }] }
  : command === "get" ? { result: "https://example.com/headed", url: "https://example.com/headed" }
    : command === "close" ? { closed: true }
    : { title: "Headed", url: "https://example.com/headed" };
  process.stdout.write(JSON.stringify({ success: true, data }));
}`,
		);

		try {
			let branch: unknown[] = [];
			await withPatchedEnv(
				{ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined, PATH: `${tempDir}:${basePath}` },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const open = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--headed", "open", "https://example.com/headed"],
						sessionMode: "fresh",
					});
					assert.equal(open.isError, false, JSON.stringify(open));
					assert.equal(open.details?.managedSessionHeadedAutosaveDisabled, true);
					assert.equal(open.details.managedSessionHeadedAutosaveInterval, "0");
					branch = harness.ctx.sessionManager.getBranch().slice();
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "reload" },
						harness.ctx,
					);
				},
			);

			await withPatchedEnv(
				{ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "1000", PATH: `${tempDir}:${basePath}` },
				async () => {
					const harness = createExtensionHarness({ branch, cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "resume" },
						harness.ctx,
					);
					const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "url"],
					});
					assert.equal(followUp.isError, true, JSON.stringify(followUp));
					assert.match(
						readString(followUp.details?.validationError),
						/cannot change a running wrapper-owned headed session/,
					);

					const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
					assert.equal(close.isError, false, JSON.stringify(close));
					const freshOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--headed", "open", "https://example.com/headed-fresh"],
						sessionMode: "fresh",
					});
					assert.equal(freshOpen.isError, false, JSON.stringify(freshOpen));
					assert.equal(freshOpen.details?.managedSessionHeadedAutosaveDisabled, undefined);
					assert.equal(freshOpen.details?.managedSessionHeadedAutosaveInterval, "1000");
					branch = harness.ctx.sessionManager.getBranch().slice();
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "reload" },
						harness.ctx,
					);
				},
			);

			await withPatchedEnv(
				{ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0", PATH: `${tempDir}:${basePath}` },
				async () => {
					const harness = createExtensionHarness({ branch, cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "resume" },
						harness.ctx,
					);
					const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "url"],
					});
					assert.equal(followUp.isError, true, JSON.stringify(followUp));
					assert.match(
						readString(followUp.details?.validationError),
						/cannot change a running wrapper-owned headed session/,
					);
					const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
					assert.equal(close.isError, false, JSON.stringify(close));
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						harness.ctx,
					);
				},
			);

			const invocations = await readInvocationLog(logPath);
			assert.equal(
				invocations.some((entry) => entry.args.includes("get") && entry.args.includes("url")),
				false,
				JSON.stringify(invocations),
			);
			const closeIntervals = new Set(
				invocations.filter((entry) => entry.args.at(-1) === "close").map((entry) => entry.autosave),
			);
			const freshOpen = invocations.find(
				(entry) =>
					entry.args.includes("open") && entry.args.includes("https://example.com/headed-fresh"),
			);
			assert.ok(closeIntervals.has("0"), JSON.stringify(invocations));
			assert.ok(closeIntervals.has("1000"), JSON.stringify(invocations));
			assert.equal(freshOpen?.autosave, "1000", JSON.stringify(invocations));
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension omits headed autosave detail when a failed fresh launch is abandoned",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-headed-autosave-abandoned-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, autosave: process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS ?? null }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: false } }));
} else {
  process.stdout.write(JSON.stringify({ success: false, error: "intentional fresh launch failure" }));
  process.exit(1);
}`,
		);

		try {
			await withPatchedEnv(
				{ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined, PATH: `${tempDir}:${basePath}` },
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const failedOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--headed", "open", "https://fail.example"],
						sessionMode: "fresh",
					});
					assert.equal(failedOpen.isError, true, JSON.stringify(failedOpen));
					assert.equal(readRecord(failedOpen.details?.managedSessionOutcome).activeAfter, false);
					assert.equal(readRecord(failedOpen.details?.managedSessionOutcome).status, "abandoned");
					assert.equal(failedOpen.details?.managedSessionHeadedAutosaveDisabled, undefined);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension retains headed autosave policy for an older owned session after replacement close fails",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-headed-autosave-replaced-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, autosave: process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS ?? null }) + "\\n");
const sessionIndex = args.indexOf("--session");
const sessionName = sessionIndex >= 0 ? args[sessionIndex + 1] : "default";
const activePath = path.join(${JSON.stringify(tempDir)}, sessionName + ".active");
const command = args.find((arg) => ["close", "get", "open", "session"].includes(arg));
if (command === "session") {
  const active = fs.existsSync(activePath);
  process.stdout.write(JSON.stringify({ success: true, data: { active, runtime: active ? { restoreKey: null } : null } }));
} else if (command === "close") {
  process.stdout.write(JSON.stringify({ success: false, error: "forced close failure" }));
  process.exit(1);
} else {
  if (command === "open") fs.writeFileSync(activePath, "active");
  const data = args.includes("tab") && args.includes("list") ? { tabs: [{ tabId: "t1", url: "https://example.com/headed", active: true }] }
  : command === "get" ? { result: "https://example.com/headed", url: "https://example.com/headed" }
    : { title: "Headed", url: args[args.length - 1] };
  process.stdout.write(JSON.stringify({ success: true, data }));
}`,
		);

		try {
			await withPatchedEnv(
				{
					AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined,
					AGENT_BROWSER_HEADED: undefined,
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0",
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
					const headedOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						sessionMode: "fresh",
						args: ["--headed", "open", "https://example.com/headed"],
					});
					assert.equal(headedOpen.isError, false, JSON.stringify(headedOpen));
					assert.equal(headedOpen.details?.managedSessionHeadedAutosaveDisabled, true);
					const headedSessionName = headedOpen.details.sessionName;
					assertIsString(headedSessionName);

					const replacement = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com/replacement"],
						sessionMode: "fresh",
					});
					assert.equal(replacement.isError, false, JSON.stringify(replacement));
					assert.notEqual(replacement.details?.sessionName, headedSessionName);
					assert.equal(replacement.details?.managedSessionHeadedAutosaveDisabled, undefined);
					assert.equal(
						readRecord(replacement.details?.managedSessionOutcome).replacedSessionClosed,
						false,
					);
					assert.match(
						readString(readRecord(replacement.content[0]).text),
						/Automatic close of the previous wrapper-managed session failed/,
					);

					const blockedProfileChange = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: [
							"--session",
							headedSessionName,
							"--profile",
							"Default",
							"open",
							"https://example.com/profiled",
						],
					});
					assert.equal(blockedProfileChange.isError, true, JSON.stringify(blockedProfileChange));
					assert.match(
						readString(blockedProfileChange.details?.validationError),
						/launch-scoped flags --profile/i,
					);
					await rm(join(tempDir, `${headedSessionName}.active`), { force: true });

					const oldSessionFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", headedSessionName, "get", "url"],
					});
					assert.equal(oldSessionFollowUp.isError, false, JSON.stringify(oldSessionFollowUp));
					assert.equal(oldSessionFollowUp.details?.managedSessionHeadedAutosaveDisabled, true);

					const resumedHarness = createExtensionHarness({
						branch: harness.ctx.sessionManager.getBranch().slice(),
						cwd: tempDir,
					});
					await runExtensionEvent(
						resumedHarness.handlers,
						"session_start",
						{ reason: "resume" },
						resumedHarness.ctx,
					);
					const resumedOldSessionFollowUp = await executeRegisteredTool(
						resumedHarness.tool,
						resumedHarness.ctx,
						{
							args: ["--session", headedSessionName, "get", "url"],
						},
					);
					assert.equal(
						resumedOldSessionFollowUp.isError,
						false,
						JSON.stringify(resumedOldSessionFollowUp),
					);
					assert.equal(
						resumedOldSessionFollowUp.details?.managedSessionHeadedAutosaveDisabled,
						true,
					);

					const invocations = await readInvocationLog(logPath);
					const replacementOpen = invocations.find((entry) =>
						entry.args.includes("https://example.com/replacement"),
					);
					const explicitOldSessionFollowUps = invocations.filter(
						(entry) =>
							entry.args.includes(headedSessionName) &&
							entry.args.includes("get") &&
							entry.args.includes("url"),
					);
					assert.equal(replacementOpen?.autosave, null, JSON.stringify(invocations));
					assert.equal(
						invocations.some((entry) => entry.args.includes("--profile")),
						false,
						JSON.stringify(invocations),
					);
					assert.equal(explicitOldSessionFollowUps.length, 2, JSON.stringify(invocations));
					assert.equal(
						explicitOldSessionFollowUps.every((entry) => entry.autosave === "0"),
						true,
						JSON.stringify(invocations),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension reapplies compatibility policy for an inactive older owned session",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-compat-replaced-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, userAgent: process.env.AGENT_BROWSER_USER_AGENT ?? null }) + "\\n");
if (args.includes("session") && args.includes("info")) {
  process.stdout.write(JSON.stringify({ success: true, data: { active: false, runtime: null } }));
} else if (args.includes("close")) {
  process.stdout.write(JSON.stringify({ success: false, error: "forced close failure" }));
  process.exit(1);
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://dash.cloudflare.com", url: "https://dash.cloudflare.com" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Page", url: args[args.length - 1] } }));
}`,
		);

		try {
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
					const compatOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://dash.cloudflare.com"],
						sessionMode: "fresh",
					});
					assert.equal(compatOpen.isError, false, JSON.stringify(compatOpen));
					assert.equal(
						readRecord(compatOpen.details?.compatibilityWorkaround).id,
						"cloudflare-headless-user-agent",
					);
					const compatSessionName = readString(compatOpen.details?.sessionName ?? "");

					const replacement = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com/replacement"],
						sessionMode: "fresh",
					});
					assert.equal(replacement.isError, false, JSON.stringify(replacement));
					assert.equal(
						readRecord(replacement.details?.managedSessionOutcome).replacedSessionClosed,
						false,
					);

					const oldFollowUp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--session", compatSessionName, "get", "url"],
					});
					assert.equal(oldFollowUp.isError, false, JSON.stringify(oldFollowUp));
					assert.equal(
						readRecord(oldFollowUp.details?.compatibilityWorkaround).id,
						"cloudflare-headless-user-agent",
					);

					const resumedHarness = createExtensionHarness({
						branch: [...harness.ctx.sessionManager.getBranch()],
						cwd: tempDir,
					});
					await runExtensionEvent(
						resumedHarness.handlers,
						"session_start",
						{ reason: "resume" },
						resumedHarness.ctx,
					);
					const resumedOldFollowUp = await executeRegisteredTool(
						resumedHarness.tool,
						resumedHarness.ctx,
						{ args: ["--session", compatSessionName, "get", "url"] },
					);
					assert.equal(resumedOldFollowUp.isError, false, JSON.stringify(resumedOldFollowUp));
					assert.equal(
						readRecord(resumedOldFollowUp.details?.compatibilityWorkaround).id,
						"cloudflare-headless-user-agent",
					);

					const oldFollowUps = (await readInvocationLog(logPath)).filter(
						(entry) =>
							entry.args.includes(compatSessionName) &&
							entry.args.includes("get") &&
							entry.args.includes("url"),
					);
					assert.equal(oldFollowUps.length, 2);
					assert.equal(
						oldFollowUps.every((entry) => {
							const userAgent = readRecord(entry).userAgent;
							return (
								entry.args.includes("--user-agent") &&
								typeof userAgent === "string" &&
								/Chrome\/\d+\.0\.0\.0/.test(userAgent)
							);
						}),
						true,
						JSON.stringify(oldFollowUps),
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension only blocks startup-scoped flags after a successful implicit launch and resets after close",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: "Example Domain", url: args[args.length - 1], idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null } };
process.stdout.write(JSON.stringify(envelope));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1234",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						sessionMode: "fresh",
						args: ["open", "https://example.com"],
					});
					assert.equal(firstOpen.isError, false);
					assert.equal(readRecord(firstOpen.details?.data).idleTimeout, "1234");

					const afterFirstOpen = await readInvocationLog(logPath);
					assert.equal(afterFirstOpen.length, 2);
					assert.equal(afterFirstOpen[0].args.includes("--session"), true);
					assert.equal(afterFirstOpen[0].idleTimeout, "1234");

					for (const args of [
						["--profile", "Default", "open", "https://example.com/profile"],
						["--state", join(tempDir, "auth.json"), "open", "https://example.com/state"],
						["--auto-connect", "open", "https://example.com/auto"],
					]) {
						// Ordered rejection rows share the same active browser; none may dispatch.
						// oxlint-disable-next-line no-await-in-loop
						const blocked = await executeRegisteredTool(harness.tool, harness.ctx, { args });
						// Every launch-flag variant must return the same recovery contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(blocked.isError, true, `expected ${args[0]} to be blocked`);
						// Every launch-flag variant must return the same recovery contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(
							readString(blocked.details?.validationError ?? ""),
							/launch-scoped flags/i,
						);
						// Every launch-flag variant must return the same recovery contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(blocked.details?.sessionMode, "auto");
						// Every launch-flag variant must return the same recovery contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(blocked.details.sessionRecoveryHint).recommendedSessionMode,
							"fresh",
						);
						// Rejection receipts must be observed before the next variant runs.
						// oxlint-disable-next-line no-await-in-loop
						const invocationCount = (await readInvocationLog(logPath)).length;
						// Every launch-flag variant must be rejected before spawning.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(invocationCount, 2);
					}

					const closeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["close"],
					});
					assert.equal(closeResult.isError, false);
					assert.equal((await readInvocationLog(logPath)).length, 3);

					const reopened = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/profile"],
					});
					assert.equal(reopened.isError, false);

					const finalInvocations = await readInvocationLog(logPath);
					assert.equal(finalInvocations.length, 6);
					assert.equal(finalInvocations[3].args.includes("--profile"), true);
					assert.deepEqual(finalInvocations[4].args, [
						"--json",
						"--session",
						readString(reopened.details?.sessionName),
						"tab",
						"list",
					]);
					assert.deepEqual(finalInvocations[5].args, [
						"--json",
						"--session",
						readString(reopened.details?.sessionName),
						"tab",
						"list",
					]);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
