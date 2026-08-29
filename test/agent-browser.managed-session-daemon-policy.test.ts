import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { getRunningHeadedAutosavePolicyChangeError, inspectManagedSessionDaemon } from "../extensions/agent-browser/lib/orchestration/browser-run/managed-session-daemon-policy.js";
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
