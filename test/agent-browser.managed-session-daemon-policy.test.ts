import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { closeManagedSession, getRunningHeadedAutosavePolicyChangeError, inspectManagedSessionDaemon } from "../extensions/agent-browser/lib/orchestration/browser-run/managed-session-daemon-policy.js";
import { acquireManagedSessionPolicyLock } from "../extensions/agent-browser/lib/managed-session-policy-lock.js";
import { ManagedSessionRestoreState } from "../extensions/agent-browser/lib/managed-session-restore.js";
import { getImplicitSessionCloseTimeoutMs } from "../extensions/agent-browser/lib/runtime.js";
import { withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

test("getRunningHeadedAutosavePolicyChangeError rejects live timer changes but allows close", { concurrency: false }, async () => {
	await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: undefined }, async () => {
		assert.equal(getRunningHeadedAutosavePolicyChangeError("0"), undefined);
	});
	await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0" }, async () => {
		assert.equal(getRunningHeadedAutosavePolicyChangeError("0"), undefined);
	});
	await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "1000" }, async () => {
		assert.match(String(getRunningHeadedAutosavePolicyChangeError("0")), /cannot change a running wrapper-owned headed session/);
		assert.equal(getRunningHeadedAutosavePolicyChangeError("0", true), undefined);
		assert.equal(getRunningHeadedAutosavePolicyChangeError(undefined), undefined);
	});
	await withPatchedEnv({ AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0" }, async () => {
		assert.match(String(getRunningHeadedAutosavePolicyChangeError("1000")), /cannot change a running wrapper-owned headed session/);
	});
});

for (const stalledPhase of ["daemon inspection", "native close"]) {
	test(`cleanup reports its own deadline during ${stalledPhase} without retiring the session`, { concurrency: false }, async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-close-timeout-"));
		const logPath = join(tempDir, "calls.jsonl");
		const sessionName = `piab-timeout-${stalledPhase.replaceAll(" ", "-")}`;
		const restoreState = new ManagedSessionRestoreState();
		restoreState.disable(sessionName, "");
		restoreState.recordDaemonRestoreKey(sessionName, "", null);
		await writeFakeAgentBrowserBinary(tempDir, `
const args = process.argv.slice(2);
const inspection = args.includes("info");
require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (inspection === ${JSON.stringify(stalledPhase === "daemon inspection")}) {
  setTimeout(() => process.exit(1), 10000);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { active: true, runtime: { restoreKey: null } } }));
}
`);
		// Acquire normally before starting the command deadline, avoiding host process-probe startup in this phase-specific test.
		const policyLock = await acquireManagedSessionPolicyLock({ sessionName, namespace: "" });
		assert.ok(policyLock);
		try {
			const error = await withPatchedEnv({
				PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
				PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
			}, () => closeManagedSession({ cwd: tempDir, namespace: "", policyLock, restoreState, sessionName, timeoutMs: 1500 }));
			assert.match(error ?? "", new RegExp(`cleanup timed out after 1500 ms during ${stalledPhase}`));
			assert.equal(restoreState.isDisabled(sessionName, ""), true);
			assert.equal(restoreState.hasDaemonRestoreKey(sessionName, ""), true);
			const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
			assert.equal(calls.filter((args) => args.at(-1) === "close").length, stalledPhase === "native close" ? 1 : 0);
		} finally {
			await policyLock.release();
			await rm(tempDir, { force: true, recursive: true });
		}
	});
}

test("default cleanup allows the native five-second browser shutdown grace", { concurrency: false, timeout: 15_000 }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-close-grace-"));
	const restoreState = new ManagedSessionRestoreState();
	const sessionName = "piab-native-close-grace";
	restoreState.disable(sessionName, "");
	restoreState.recordDaemonRestoreKey(sessionName, "", null);
	await writeFakeAgentBrowserBinary(tempDir, `
// Native ChromeProcess.wait_or_kill permits five seconds before close can return.
setTimeout(() => process.stdout.write(JSON.stringify({ success: true, data: { closed: true } })), 5000);
`);
	try {
		const error = await withPatchedEnv({ PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}` }, () => closeManagedSession({
			cwd: tempDir, namespace: "", restoreState, sessionName, timeoutMs: getImplicitSessionCloseTimeoutMs({}),
		}));
		assert.equal(error, undefined);
		assert.equal(restoreState.hasDaemonRestoreKey(sessionName, ""), false);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("inspectManagedSessionDaemon waits through a temporarily busy daemon", { concurrency: false, timeout: 15_000 }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-daemon-policy-"));
	await writeFakeAgentBrowserBinary(tempDir, `
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5250);
process.stdout.write(JSON.stringify({ success: true, data: { active: false, runtime: null } }));
`);

	try {
		const result = await withPatchedEnv({
			PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
			PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "50",
			PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
		}, () => inspectManagedSessionDaemon({ cwd: tempDir, sessionName: "piab-slow" }));

		assert.deepEqual(result, { status: "inactive" });
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
