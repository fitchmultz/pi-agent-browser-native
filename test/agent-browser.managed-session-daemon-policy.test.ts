import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
	hasErrorCode,
	readArray,
	readNumber,
	readRecord,
	readString,
} from "./helpers/assertions.js";

import {
	closeManagedSession,
	getRunningHeadedAutosavePolicyChangeError,
	inspectManagedSessionDaemon,
} from "../extensions/agent-browser/lib/orchestration/browser-run/managed-session-daemon-policy.js";
import { acquireManagedSessionPolicyLock } from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import { ManagedSessionRestoreState } from "../extensions/agent-browser/lib/managed-session-restore.js";
import { getImplicitSessionCloseTimeoutMs } from "../extensions/agent-browser/lib/runtime.js";
import { withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

test("virtual daemon generation belongs to the fixture owner, not a transient CLI launcher", async () => {
	const root = await mkdtemp(join(tmpdir(), "piab-fake-launcher-"));
	try {
		await writeFakeAgentBrowserBinary(
			root,
			"process.stdout.write(JSON.stringify({ success: true, data: { launcherPid: process.ppid } }));",
		);
		const intermediary = `const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, [${JSON.stringify(join(root, "agent-browser-fake.cjs"))}, ...process.argv.slice(1)], { encoding: "utf8" });
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);`;
		const invoke = (args: readonly string[]) =>
			readRecord(
				JSON.parse(
					execFileSync(process.execPath, ["-e", intermediary, "--", ...args], {
						encoding: "utf8",
					}),
				),
			);
		const first = readRecord(invoke(["--session", "fixture", "open"]).data);
		const firstLauncher = readNumber(first.launcherPid);
		assert.notEqual(firstLauncher, process.pid);
		const opened = readRecord(invoke(["--session", "fixture", "session", "info"]).data);
		assert.equal(opened.active, true);
		assert.equal(readRecord(opened.runtime).backgroundPid, process.pid);
		const snapshot = readRecord(invoke(["--session", "fixture", "snapshot"]).data);
		assert.notEqual(snapshot.launcherPid, firstLauncher);
		const observed = readRecord(invoke(["--session", "fixture", "session", "info"]).data);
		assert.equal(readRecord(observed.runtime).backgroundPid, process.pid);
		invoke(["--session", "fixture", "close"]);
		const closed = readRecord(invoke(["--session", "fixture", "session", "info"]).data);
		assert.equal(closed.active, false);
		assert.equal(closed.runtime, null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const realSetTimeout = setTimeout;
async function waitForDispatch(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			// Advance parent deadlines only after the real child publishes readiness.
			// oxlint-disable-next-line no-await-in-loop
			await readFile(path);
			return;
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT") || Date.now() >= deadline) {
				throw error;
			}
			// Child startup/filesystem polling stays on the real clock.
			// oxlint-disable-next-line no-await-in-loop
			await new Promise((resolve) => {
				realSetTimeout(resolve, 5);
			});
		}
	}
}
function heldChild(tempDir: string, data: Readonly<Record<string, unknown>>): string {
	return `const fs = require("node:fs");
fs.readFileSync(0, "utf8");
const watcher = fs.watch(${JSON.stringify(tempDir)}, () => {
  if (!fs.existsSync(${JSON.stringify(join(tempDir, "release"))})) return;
  watcher.close();
  process.stdout.write(JSON.stringify({ success: true, data: ${JSON.stringify(data)} }));
});
fs.writeFileSync(${JSON.stringify(join(tempDir, "ready"))}, String(process.pid));`;
}

test(
	"getRunningHeadedAutosavePolicyChangeError rejects live timer changes but allows close",
	{ concurrency: false },
	async () => {
		await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined }, async () => {
			assert.equal(getRunningHeadedAutosavePolicyChangeError("0"), undefined);
		});
		await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0" }, async () => {
			assert.equal(getRunningHeadedAutosavePolicyChangeError("0"), undefined);
		});
		await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "1000" }, async () => {
			assert.match(
				String(getRunningHeadedAutosavePolicyChangeError("0")),
				/cannot change a running wrapper-owned headed session/,
			);
			assert.equal(getRunningHeadedAutosavePolicyChangeError("0", true), undefined);
			assert.equal(getRunningHeadedAutosavePolicyChangeError(undefined), undefined);
		});
		await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0" }, async () => {
			assert.match(
				String(getRunningHeadedAutosavePolicyChangeError("1000")),
				/cannot change a running wrapper-owned headed session/,
			);
		});
	},
);

for (const stalledPhase of ["daemon inspection", "native close"]) {
	test(
		`cleanup reports its own deadline during ${stalledPhase} without retiring the session`,
		{ concurrency: false },
		async (t) => {
			const tempDir = await mkdtemp(join(tmpdir(), "pd-"));
			const logPath = join(tempDir, "calls.jsonl");
			const sessionName = `t-${process.pid}-${stalledPhase === "native close" ? "c" : "i"}`;
			const restoreState = new ManagedSessionRestoreState();
			restoreState.disable(sessionName, "");
			restoreState.recordDaemonRestoreKey(sessionName, "", null);
			await writeFakeAgentBrowserBinary(
				tempDir,
				`
const args = process.argv.slice(2);
const inspection = args.includes("info");
require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (inspection === ${JSON.stringify(stalledPhase === "daemon inspection")}) {
  require("node:fs").writeFileSync(${JSON.stringify(join(tempDir, "ready"))}, String(process.pid));
  setTimeout(() => process.exit(1), 10000);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { active: true, runtime: { restoreKey: null } } }));
}
`,
			);
			try {
				await withPatchedEnv(
					{
						PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
						PI_AGENT_BROWSER_SOCKET_DIR: tempDir,
						PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					},
					async () => {
						// Acquire normally so process identity discovery is outside the controlled command budget.
						const policyLock = await acquireManagedSessionPolicyLock({
							sessionName,
							namespace: "",
						});
						assert.ok(policyLock);
						t.mock.timers.enable({ apis: ["setTimeout"] });
						const pending = closeManagedSession({
							cwd: tempDir,
							namespace: "",
							policyLock,
							restoreState,
							sessionName,
							timeoutMs: 1500,
						});
						try {
							await waitForDispatch(join(tempDir, "ready"));
							t.mock.timers.tick(1500);
							// Native exit/close and subprocess drain stay real after the parent deadline fires.
							t.mock.timers.reset();
							const error = await pending;
							assert.match(
								error ?? "",
								new RegExp(`cleanup timed out after 1500 ms during ${stalledPhase}`),
							);
							assert.equal(restoreState.isDisabled(sessionName, ""), true);
							assert.equal(restoreState.hasDaemonRestoreKey(sessionName, ""), true);
							const calls = (await readFile(logPath, "utf8"))
								.trim()
								.split("\n")
								.map((line) => readArray(JSON.parse(line)).map(readString));
							assert.equal(
								calls.filter((args) => args.at(-1) === "close").length,
								stalledPhase === "native close" ? 1 : 0,
							);
						} finally {
							t.mock.timers.reset();
							await pending;
							await policyLock.release();
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
	"default cleanup allows the native five-second browser shutdown grace",
	{ concurrency: false, timeout: 15_000 },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pd-"));
		const restoreState = new ManagedSessionRestoreState();
		const sessionName = `g-${process.pid}`;
		restoreState.disable(sessionName, "");
		restoreState.recordDaemonRestoreKey(sessionName, "", null);
		await writeFakeAgentBrowserBinary(tempDir, heldChild(tempDir, { closed: true }));
		try {
			const error = await withPatchedEnv(
				{
					PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
					PI_AGENT_BROWSER_SOCKET_DIR: tempDir,
				},
				async () => {
					const policyLock = await acquireManagedSessionPolicyLock({ sessionName, namespace: "" });
					assert.ok(policyLock);
					t.mock.timers.enable({ apis: ["setTimeout"] });
					const pending = closeManagedSession({
						cwd: tempDir,
						namespace: "",
						restoreState,
						sessionName,
						policyLock,
						timeoutMs: getImplicitSessionCloseTimeoutMs({}),
					});
					try {
						await waitForDispatch(join(tempDir, "ready"));
						// ChromeProcess.wait_or_kill permits five seconds before native close returns.
						t.mock.timers.tick(5250);
						await writeFile(join(tempDir, "release"), "release");
						return await pending;
					} finally {
						t.mock.timers.reset();
						await writeFile(join(tempDir, "release"), "release");
						await pending;
						await policyLock.release();
					}
				},
			);
			assert.equal(error, undefined);
			assert.equal(restoreState.hasDaemonRestoreKey(sessionName, ""), false);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"pending native cleanup keeps the managed restore identity",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pd-"));
		const restoreState = new ManagedSessionRestoreState();
		const sessionName = `p-${process.pid}`;
		restoreState.disable(sessionName, "");
		restoreState.recordDaemonRestoreKey(sessionName, "", null);
		await writeFakeAgentBrowserBinary(
			tempDir,
			`
const data = process.argv.includes("info")
  ? { active: true, runtime: { restoreKey: null } }
  : { confirmation_required: true, confirmation_id: "close-decision", action: "close" };
console.log(JSON.stringify({ success: true, data }));
`,
		);
		try {
			const error = await withPatchedEnv(
				{
					PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
					PI_AGENT_BROWSER_SOCKET_DIR: tempDir,
				},
				() =>
					closeManagedSession({
						cwd: tempDir,
						namespace: "",
						restoreState,
						sessionName,
						timeoutMs: 5000,
					}),
			);
			assert.match(error ?? "", /requires confirmation \(close-decision\)/);
			assert.equal(restoreState.isDisabled(sessionName, ""), true);
			assert.equal(restoreState.hasDaemonRestoreKey(sessionName, ""), true);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"inspectManagedSessionDaemon waits through a temporarily busy daemon",
	{ concurrency: false, timeout: 15_000 },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pd-"));
		await writeFakeAgentBrowserBinary(
			tempDir,
			heldChild(tempDir, { active: false, runtime: null }),
		);
		try {
			const result = await withPatchedEnv(
				{
					PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
					PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "50",
					PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
					PI_AGENT_BROWSER_SOCKET_DIR: tempDir,
				},
				async () => {
					t.mock.timers.enable({ apis: ["setTimeout"] });
					const controller = new AbortController();
					const pending = inspectManagedSessionDaemon({
						cwd: tempDir,
						sessionName: `i-${process.pid}`,
						signal: controller.signal,
					});
					try {
						await waitForDispatch(join(tempDir, "ready"));
						t.mock.timers.tick(5250);
						await writeFile(join(tempDir, "release"), "release");
						return await pending;
					} finally {
						t.mock.timers.reset();
						controller.abort();
						await pending;
					}
				},
			);
			assert.deepEqual(result, { status: "inactive" });
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
