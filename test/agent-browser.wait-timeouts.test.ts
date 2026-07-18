import assert from "node:assert/strict";
import test from "node:test";

import { commandTimeoutNeedsActivePageUrl, getCommandAwareProcessTimeoutMs } from "../extensions/agent-browser/lib/orchestration/browser-run/prepare/wait-timeouts.js";
import { withPatchedEnv } from "./helpers/agent-browser-harness.js";

function batch(steps: string[][]): string {
	return JSON.stringify(steps);
}

test("getCommandAwareProcessTimeoutMs extends process timeout for explicit wait and read budgets", async () => {
	await withPatchedEnv({ PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "10000" }, async () => {
		assert.equal(getCommandAwareProcessTimeoutMs(["open", "https://example.com"], undefined), undefined);
		assert.equal(getCommandAwareProcessTimeoutMs(["wait", "4000"], undefined), undefined);
		assert.equal(getCommandAwareProcessTimeoutMs(["wait", "6000"], undefined), 11000);
		assert.equal(getCommandAwareProcessTimeoutMs(["wait", "--timeout", "7000"], undefined), 12000);
		assert.equal(getCommandAwareProcessTimeoutMs(["wait", "--timeout=8000"], undefined), 13000);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "https://example.com", "--timeout", "7000"], undefined), 33000);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "--timeout", "8000", "https://example.com"], undefined), 37000);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "https://example.com/a/b", "--timeout", "7000"], undefined), 47000);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "--session", "custom", "--timeout", "8000", "https://example.com/a/b"], undefined), 53000);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "--restore", "https://example.com/a/b", "--timeout", "8000"], undefined), 53000);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "--session", "custom", "--require-md", "--timeout", "8000"], undefined, "https://example.com/a/b"), 53000);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "https://example.com/a/b", "--raw", "--timeout", "7000"], undefined), 12000);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "https://example.com/a/b", "--llms", "index", "--timeout", "7000"], undefined), 26000);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "--require-md", "--timeout=8000"], undefined, "https://example.com/a/b"), 53000);

		assert.equal(
			getCommandAwareProcessTimeoutMs(["batch"], batch([
				["wait", "2000"],
				["get", "url"],
				["wait", "3000"],
			])),
			undefined,
		);
		assert.equal(
			getCommandAwareProcessTimeoutMs(["batch"], batch([
				["wait", "4000"],
				["read", "https://example.com", "--timeout", "3000"],
			])),
			21000,
		);
		for (const navigationCommand of ["open", "goto", "navigate"]) {
			for (const navigationFlags of [["--session", "custom"], ["--restore"]]) {
				assert.equal(
					getCommandAwareProcessTimeoutMs(["batch"], batch([
						[navigationCommand, ...navigationFlags, "https://example.com/a/b"],
						["read", "--require-md", "--timeout", "3000"],
					])),
					23000,
				);
			}
		}
		assert.equal(getCommandAwareProcessTimeoutMs(["batch"], batch([["get", "title"], ["snapshot", "-i"]])), undefined);
		assert.equal(commandTimeoutNeedsActivePageUrl(["read", "--require-md", "--timeout", "8000"], undefined), true);
		assert.equal(commandTimeoutNeedsActivePageUrl(["read", "--session", "custom", "--require-md", "--timeout", "8000"], undefined), true);
		assert.equal(commandTimeoutNeedsActivePageUrl(["read", "--restore", "https://example.com", "--require-md", "--timeout", "8000"], undefined), false);
		assert.equal(commandTimeoutNeedsActivePageUrl(["read", "--require-md", "--timeout", "8000", "https://example.com"], undefined), false);
		assert.equal(commandTimeoutNeedsActivePageUrl(["batch"], batch([["read", "--llms", "index", "--timeout", "8000"]])), true);
		assert.equal(commandTimeoutNeedsActivePageUrl(["batch"], batch([["goto", "https://example.com/a"], ["read", "--llms", "index", "--timeout", "8000"]])), false);

		assert.equal(getCommandAwareProcessTimeoutMs(["wait", "not-a-number"], undefined), undefined);
		assert.equal(getCommandAwareProcessTimeoutMs(["wait", "--timeout", "bad"], undefined), undefined);
		assert.equal(getCommandAwareProcessTimeoutMs(["read", "https://example.com", "--timeout", "bad"], undefined), undefined);
		assert.equal(getCommandAwareProcessTimeoutMs(["batch"], batch([["wait", "bad"], ["read", "https://example.com", "--timeout=bad"]])), undefined);
	});
});
