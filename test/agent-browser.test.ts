/**
 * Purpose: Verify the thin planning and formatting helpers that power the pi-agent-browser extension.
 * Responsibilities: Assert deterministic implicit session naming, argument injection behavior, command parsing, and high-value result formatting.
 * Scope: Pure unit coverage for helper logic only; interactive pi/tmux validation remains the primary end-to-end test path.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: These tests intentionally cover the stable thin-wrapper behavior rather than the full upstream agent-browser feature surface.
 */

import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";

import {
	buildToolPresentation,
	getAgentBrowserErrorText,
	parseAgentBrowserEnvelope,
} from "../extensions/agent-browser/lib/results.js";
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

test("getAgentBrowserErrorText prefers envelope errors over generic exit codes", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		envelope: { success: false, error: "Navigation failed: net::ERR_BLOCKED_BY_CLIENT" },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, "Navigation failed: net::ERR_BLOCKED_BY_CLIENT");
});

test("getAgentBrowserErrorText falls back to generic exit codes when no envelope error exists", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		envelope: { success: true, data: null },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, "agent-browser exited with code 1.");
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

test("buildToolPresentation compacts oversized snapshots and spills the raw snapshot to a temp file", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Actionable control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => {
		const ref = `e${index + 1}`;
		return `- generic \"Large snapshot row ${index + 1} with lots of repeated visible text that should not all stay inline\" [ref=${ref}] clickable [onclick]`;
	}).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/huge",
				refs,
				snapshot,
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Compact snapshot view/);
	assert.match((presentation.content[0] as { text: string }).text, /Key refs:/);
	assert.match((presentation.content[0] as { text: string }).text, /Full raw snapshot:/);
	assert.match(presentation.summary, /Snapshot: 90 refs on https:\/\/example.com\/huge \(compact\)/);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal((presentation.data as { compacted: boolean }).compacted, true);

	const spillPath = presentation.fullOutputPath;
	assert.ok(spillPath);
	const spillText = await readFile(spillPath, "utf8");
	assert.match(spillText, /Large snapshot row 120/);
	assert.match(spillText, /Actionable control 1/);
	await rm(spillPath, { force: true });
});

test("buildToolPresentation prefers main content sections over top-of-page chrome in compact snapshots", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e1") return [id, { name: "Skip to main content", role: "link" }];
			if (id === "e2") return [id, { name: "AD", role: "link" }];
			if (id === "e3") return [id, { name: "JavaScript", role: "heading" }];
			if (id === "e4") return [id, { name: "Beginner's tutorials", role: "region" }];
			if (id === "e5") return [id, { name: "Intermediate", role: "region" }];
			if (id === "e6") return [id, { name: "Reference", role: "region" }];
			return [id, { name: `Content item ${index + 1}`, role: index % 6 === 0 ? "link" : "generic" }];
		}),
	);
	const snapshot = [
		'- link "Skip to main content" [ref=e1]',
		'- link "AD" [ref=e2]',
		'- heading "JavaScript" [level=1, ref=e3]',
		...Array.from({ length: 18 }, (_, index) => `- link "Overview topic ${index + 1}" [ref=e${index + 10}]`),
		'- region "Beginner\'s tutorials" [ref=e4]',
		'  - link "Your first website: Adding interactivity" [ref=e40]',
		'  - link "Dynamic scripting with JavaScript" [ref=e41]',
		'- region "Intermediate" [ref=e5]',
		'  - link "Asynchronous JavaScript" [ref=e42]',
		'  - link "Client-side web APIs" [ref=e43]',
		'- region "Reference" [ref=e6]',
		...Array.from({ length: 70 }, (_, index) => `  - link "Reference entry ${index + 1}" [ref=e${index + 50}]`),
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/docs/javascript",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Primary content:/);
	assert.match(text, /heading "JavaScript"/);
	assert.match(text, /Additional sections:/);
	assert.match(text, /region "Beginner's tutorials"/);
	assert.doesNotMatch(text, /Skip to main content/);
	assert.doesNotMatch(text, /^- AD$/m);

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});
