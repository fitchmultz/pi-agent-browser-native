import assert from "node:assert/strict";
import test from "node:test";

import { getWaitAwareProcessTimeoutMs } from "../extensions/agent-browser/lib/orchestration/browser-run/prepare/wait-timeouts.js";
import { withPatchedEnv } from "./helpers/agent-browser-harness.js";

function batch(steps: string[][]): string {
	return JSON.stringify(steps);
}

test("getWaitAwareProcessTimeoutMs extends process timeout when wait budget plus grace exceeds the baseline", async () => {
	await withPatchedEnv({ PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "10000" }, async () => {
		assert.equal(getWaitAwareProcessTimeoutMs(["open", "https://example.com"], undefined), undefined);
		assert.equal(getWaitAwareProcessTimeoutMs(["wait", "4000"], undefined), undefined);
		assert.equal(getWaitAwareProcessTimeoutMs(["wait", "6000"], undefined), 11000);
		assert.equal(getWaitAwareProcessTimeoutMs(["wait", "--timeout", "7000"], undefined), 12000);
		assert.equal(getWaitAwareProcessTimeoutMs(["wait", "--timeout=8000"], undefined), 13000);

		assert.equal(
			getWaitAwareProcessTimeoutMs(["batch"], batch([
				["wait", "2000"],
				["get", "url"],
				["wait", "3000"],
			])),
			undefined,
		);
		assert.equal(
			getWaitAwareProcessTimeoutMs(["batch"], batch([
				["wait", "4000"],
				["wait", "--timeout", "3000"],
			])),
			12000,
		);
		assert.equal(getWaitAwareProcessTimeoutMs(["batch"], batch([["get", "title"], ["snapshot", "-i"]])), undefined);

		assert.equal(getWaitAwareProcessTimeoutMs(["wait", "not-a-number"], undefined), undefined);
		assert.equal(getWaitAwareProcessTimeoutMs(["wait", "--timeout", "bad"], undefined), undefined);
		assert.equal(getWaitAwareProcessTimeoutMs(["wait", "--timeout=bad"], undefined), undefined);
		assert.equal(getWaitAwareProcessTimeoutMs(["batch"], batch([["wait", "bad"], ["wait", "--timeout=bad"]])), undefined);
	});
});
