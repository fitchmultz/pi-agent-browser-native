/**
 * Purpose: Verify the thin planning and formatting helpers that power the pi-agent-browser extension.
 * Responsibilities: Assert deterministic implicit session naming, argument injection behavior, command parsing, and high-value result formatting.
 * Scope: Pure unit coverage for helper logic only; interactive pi/tmux validation remains the primary end-to-end test path.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: These tests intentionally cover the stable thin-wrapper behavior rather than the full upstream agent-browser feature surface.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildToolPresentation, parseAgentBrowserEnvelope } from "../extensions/agent-browser/lib/results.js";
import { buildExecutionPlan, createImplicitSessionName, parseCommandInfo } from "../extensions/agent-browser/lib/runtime.js";

test("createImplicitSessionName is stable for a persisted pi session", () => {
	const sessionId = "12345678-1234-5678-9abc-def012345678";
	const cwd = "/Users/example/Projects/pi-agent-browser";
	const one = createImplicitSessionName(sessionId, cwd, "ignored-a");
	const two = createImplicitSessionName(sessionId, cwd, "ignored-b");

	assert.equal(one, two);
	assert.equal(one, "piab-pi-agent-browser-123456781234");
});

test("buildExecutionPlan injects --json and the implicit session when needed", () => {
	const plan = buildExecutionPlan(["open", "https://example.com"], {
		implicitSessionName: "piab-demo-123",
		useActiveSession: true,
	});

	assert.deepEqual(plan.effectiveArgs, ["--json", "--session", "piab-demo-123", "open", "https://example.com"]);
	assert.equal(plan.sessionName, "piab-demo-123");
	assert.equal(plan.usedImplicitSession, true);
});

test("buildExecutionPlan respects explicit upstream sessions", () => {
	const plan = buildExecutionPlan(["--session", "custom", "snapshot", "-i"], {
		implicitSessionName: "piab-demo-123",
		useActiveSession: true,
	});

	assert.deepEqual(plan.effectiveArgs, ["--json", "--session", "custom", "snapshot", "-i"]);
	assert.equal(plan.sessionName, "custom");
	assert.equal(plan.usedImplicitSession, false);
});

test("parseCommandInfo skips global flags with values", () => {
	const commandInfo = parseCommandInfo(["--session", "named", "--profile", "./profile", "tab", "list"]);
	assert.deepEqual(commandInfo, { command: "tab", subcommand: "list" });
});

test("parseAgentBrowserEnvelope reports invalid JSON clearly", () => {
	const parsed = parseAgentBrowserEnvelope("not-json");
	assert.match(parsed.parseError ?? "", /invalid JSON/i);
});

test("parseAgentBrowserEnvelope accepts batch JSON arrays", () => {
	const parsed = parseAgentBrowserEnvelope(
		JSON.stringify([
			{ command: ["open", "https://developer.mozilla.org"], success: true, result: { title: "MDN Web Docs" } },
			{ command: ["get", "title"], success: true, result: { title: "MDN Web Docs" } },
		]),
	);

	assert.equal(parsed.parseError, undefined);
	assert.equal(Array.isArray(parsed.envelope?.data), true);
	assert.equal(parsed.envelope?.success, true);
});

test("buildToolPresentation formats snapshot output for the model", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/",
				refs: {
					e1: { name: "Example Domain", role: "heading" },
					e2: { name: "More", role: "link" },
				},
				snapshot: '- heading "Example Domain" [level=1, ref=e1]\n- link "More" [ref=e2]',
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Origin: https:\/\/example.com\//);
	assert.match((presentation.content[0] as { text: string }).text, /Refs: 2/);
	assert.match(presentation.summary, /Snapshot: 2 refs/);
});

test("buildToolPresentation formats batch output for the model", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{ command: ["open", "https://developer.mozilla.org"], success: true, result: { title: "MDN Web Docs" } },
				{ command: ["get", "title"], success: true, result: { title: "MDN Web Docs" } },
			],
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /open https:\/\/developer.mozilla.org/);
	assert.match((presentation.content[0] as { text: string }).text, /MDN Web Docs/);
	assert.match(presentation.summary, /Batch: 2\/2 succeeded/);
});
