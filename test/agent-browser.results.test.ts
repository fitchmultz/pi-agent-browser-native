/**
 * Purpose: Verify command parsing, envelope parsing, tab-correction selection, and error-text rendering helpers.
 * Responsibilities: Assert stable result facade behavior for valid envelopes, malformed output, fallback failures, command extraction, and tab list presentation.
 * Scope: Unit-style Node test-runner coverage for result/runtime helpers; richer presentation formatting lives in `agent-browser.presentation.test.ts`.
 * Usage: Run with `npm test -- test/agent-browser.results.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests avoid real subprocesses and use deterministic fixture payloads.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	buildAgentBrowserNextActions,
	buildToolPresentation,
	classifyAgentBrowserFailureCategory,
	classifyAgentBrowserSuccessCategory,
	getAgentBrowserErrorText,
	parseAgentBrowserEnvelope,
} from "../extensions/agent-browser/lib/results.js";
import {
	chooseOpenResultTabCorrection,
	extractCommandTokens,
	parseCommandInfo
} from "../extensions/agent-browser/lib/runtime.js";

const MISSING_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: missing boolean success field.";
const NON_BOOLEAN_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: success field must be boolean.";

test("classifyAgentBrowserFailureCategory locks common machine-readable failure categories", () => {
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Unknown ref: e4", args: ["click", "@e4"] }), "stale-ref");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Failed to parse selector text=Close" }), "selector-unsupported");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "No elements found for selector .missing" }), "selector-not-found");
	assert.equal(classifyAgentBrowserFailureCategory({ timedOut: true }), "timeout");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Download not verified: file missing", command: "download" }), "download-not-verified");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "agent-browser is required but was not found on PATH" }), "missing-binary");
	assert.equal(classifyAgentBrowserFailureCategory({ parseError: "agent-browser returned invalid JSON" }), "parse-failure");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Confirmation required: c_demo" }), "confirmation-required");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "agent-browser could not re-select the intended tab before running the command." }), "tab-drift");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Navigation failed: net::ERR_BLOCKED_BY_CLIENT" }), "upstream-error");
});

test("classifyAgentBrowserSuccessCategory locks common machine-readable success categories", () => {
	assert.equal(classifyAgentBrowserSuccessCategory({}), "completed");
	assert.equal(classifyAgentBrowserSuccessCategory({ inspection: true }), "inspection");
	assert.equal(classifyAgentBrowserSuccessCategory({ artifacts: [{ absolutePath: "/tmp/a.png", kind: "image", path: "/tmp/a.png" }] }), "artifact-saved");
});

test("buildAgentBrowserNextActions returns exact native-tool recommendations for common states", () => {
	assert.deepEqual(buildAgentBrowserNextActions({ command: "open", resultCategory: "success", successCategory: "completed" }), [
		{
			id: "inspect-opened-page",
			params: { args: ["snapshot", "-i"] },
			reason: "Inspect the opened page before choosing interactive refs.",
			tool: "agent_browser",
		},
	]);
	assert.deepEqual(buildAgentBrowserNextActions({ command: "click", resultCategory: "failure", failureCategory: "stale-ref" })?.[0]?.params?.args, ["snapshot", "-i"]);
	assert.deepEqual(buildAgentBrowserNextActions({ resultCategory: "failure", failureCategory: "confirmation-required", confirmationId: "c_demo" })?.map((action) => action.params?.args), [["confirm", "c_demo"], ["deny", "c_demo"]]);
	assert.deepEqual(buildAgentBrowserNextActions({ resultCategory: "failure", failureCategory: "tab-drift" })?.map((action) => action.params?.args), [["tab", "list"], ["snapshot", "-i"]]);
	assert.deepEqual(buildAgentBrowserNextActions({ args: ["wait", "--download", "/tmp/export.csv"], resultCategory: "failure", failureCategory: "download-not-verified" })?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
	assert.deepEqual(buildAgentBrowserNextActions({ args: ["download", "@e1", "/tmp/export.csv"], resultCategory: "failure", failureCategory: "download-not-verified" })?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
	assert.equal(buildAgentBrowserNextActions({ artifacts: [{ absolutePath: "/tmp/page.png", kind: "image", path: "/tmp/page.png" }], resultCategory: "success", successCategory: "artifact-saved" })?.[0]?.artifactPath, "/tmp/page.png");
	assert.equal(buildAgentBrowserNextActions({ resultCategory: "success", successCategory: "completed" }), undefined);
});

test("parseCommandInfo skips global flags with values", () => {
	const commandInfo = parseCommandInfo(["--session", "named", "--profile", "./profile", "tab", "list"]);
	assert.deepEqual(commandInfo, { command: "tab", subcommand: "list" });
});

test("parseCommandInfo treats compatibility and launch flag values as non-command tokens", () => {
	const commandInfo = parseCommandInfo([
		"--user-agent",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
		"--args",
		"--disable-gpu,--lang=en-US",
		"open",
		"https://example.com",
	]);
	assert.deepEqual(commandInfo, { command: "open", subcommand: "https://example.com" });
});

test("extractCommandTokens strips wrapper-level global flags and keeps the command tail intact", () => {
	assert.deepEqual(extractCommandTokens(["--session", "named", "snapshot", "-i"]), ["snapshot", "-i"]);
	assert.deepEqual(
		extractCommandTokens([
			"--session",
			"named",
			"--user-agent",
			"Mozilla/5.0",
			"click",
			"@e9",
		]),
		["click", "@e9"],
	);
});

test("chooseOpenResultTabCorrection targets the navigated tab without disturbing already-correct active tabs", () => {
	assert.deepEqual(
		chooseOpenResultTabCorrection({
			tabs: [
				{ active: false, tabId: "t1", title: "Example Domain", url: "https://example.com/" },
				{ active: true, tabId: "t2", title: "Grok", url: "https://grok.com/" },
			],
			targetTitle: "Example Domain",
			targetUrl: "https://example.com",
		}),
		{ selectedTab: "t1", selectionKind: "tabId", targetTitle: "Example Domain", targetUrl: "https://example.com/" },
	);
	assert.deepEqual(
		chooseOpenResultTabCorrection({
			tabs: [
				{ active: true, tabId: "blank", title: "", url: "about:blank" },
				{ active: false, tabId: "app", title: "Example Domain", url: "https://example.com/" },
			],
			targetTitle: "Example Domain",
			targetUrl: "https://example.com/",
		}),
		{ selectedTab: "app", selectionKind: "tabId", targetTitle: "Example Domain", targetUrl: "https://example.com/" },
	);
	assert.equal(
		chooseOpenResultTabCorrection({
			tabs: [{ active: true, tabId: "t1", title: "Example Domain", url: "https://example.com/" }],
			targetTitle: "Example Domain",
			targetUrl: "https://example.com/",
		}),
		undefined,
	);
});

test("buildToolPresentation renders stable tab ids from tab list output", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "tab", subcommand: "list" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				tabs: [
					{ active: false, tabId: "t1", title: "ChatGPT", url: "https://chatgpt.com/" },
					{ active: true, tabId: "t2", title: "Grok", url: "https://grok.com/" },
				],
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /- \[t1\] ChatGPT — https:\/\/chatgpt\.com\//);
	assert.match((presentation.content[0] as { text: string }).text, /\* \[t2\] Grok — https:\/\/grok\.com\//);
	assert.equal(presentation.summary, "Tabs: 2");
});

test("parseAgentBrowserEnvelope reports invalid JSON clearly", async () => {
	const parsed = await parseAgentBrowserEnvelope("not-json");
	assert.match(parsed.parseError ?? "", /invalid JSON/i);
});

test("parseAgentBrowserEnvelope accepts batch JSON arrays", async () => {
	const parsed = await parseAgentBrowserEnvelope(
		JSON.stringify([
			{ command: ["open", "https://developer.mozilla.org"], success: true, result: { title: "MDN Web Docs" } },
			{ command: ["get", "title"], success: true, result: { title: "MDN Web Docs" } },
		]),
	);

	assert.equal(parsed.parseError, undefined);
	assert.equal(Array.isArray(parsed.envelope?.data), true);
	assert.equal(parsed.envelope?.success, true);
});

test("parseAgentBrowserEnvelope rejects object envelopes without boolean success", async () => {
	const parsed = await parseAgentBrowserEnvelope(JSON.stringify({ error: "boom" }));

	assert.equal(parsed.envelope, undefined);
	assert.equal(parsed.parseError, MISSING_SUCCESS_PARSE_ERROR);
});

test("parseAgentBrowserEnvelope rejects object envelopes with non-boolean success", async () => {
	const parsed = await parseAgentBrowserEnvelope(JSON.stringify({ success: "true", data: { title: "ok" } }));

	assert.equal(parsed.envelope, undefined);
	assert.equal(parsed.parseError, NON_BOOLEAN_SUCCESS_PARSE_ERROR);
});

test("parseAgentBrowserEnvelope accepts valid object envelopes with boolean success", async () => {
	const parsed = await parseAgentBrowserEnvelope(JSON.stringify({ success: true, data: { title: "ok" } }));

	assert.equal(parsed.parseError, undefined);
	assert.equal(parsed.envelope?.success, true);
});

test("getAgentBrowserErrorText explains wrapper watchdog timeouts", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		exitCode: 124,
		plainTextInspection: false,
		stderr: "",
		timedOut: true,
		timeoutMs: 28000,
	});

	assert.match(errorText ?? "", /28000ms wrapper watchdog/);
	assert.match(errorText ?? "", /30s IPC retry path/);
});

test("getAgentBrowserErrorText explains upstream IPC read timeouts", () => {
	for (const upstreamError of [
		"Failed to read: Resource temporarily unavailable (os error 35) (after 5 retries - daemon may be busy or unresponsive)",
		"Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)",
	]) {
		const errorText = getAgentBrowserErrorText({
			aborted: false,
			envelope: {
				success: false,
				error: upstreamError,
			},
			exitCode: 1,
			plainTextInspection: false,
			stderr: "",
		});

		assert.match(errorText ?? "", /30s IPC read timeout/);
		assert.match(errorText ?? "", /daemon may still be alive/);
	}
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

test("getAgentBrowserErrorText adds stale-ref recovery guidance for failed @refs", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		effectiveArgs: ["--json", "--session", "named", "get", "text", "@e4"],
		envelope: { success: false, error: "Could not locate element with role=heading name=Old page" },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.match(errorText ?? "", /Could not locate element/);
	assert.match(errorText ?? "", /@ref may be stale/);
	assert.match(errorText ?? "", /snapshot/);
});

test("getAgentBrowserErrorText extracts nested envelope error messages", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		envelope: { success: false, error: { details: { message: "Profile directory is locked" } } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, "Profile directory is locked");
});

test("getAgentBrowserErrorText falls back to stderr or an invocation-aware message when a failed envelope has no simple error field", () => {
	const stderrFallback = getAgentBrowserErrorText({
		aborted: false,
		command: "open",
		effectiveArgs: ["--json", "open", "https://example.com"],
		envelope: { success: false, data: { title: "Wrong page" } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "Navigation failed upstream",
	});
	const invocationFallback = getAgentBrowserErrorText({
		aborted: false,
		command: "open",
		effectiveArgs: ["--json", "open", "https://example.com"],
		envelope: { success: false, data: { title: "Wrong page" } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(stderrFallback, "Navigation failed upstream");
	assert.equal(invocationFallback, "agent-browser --json open https://example.com reported failure (exit code 1).");
});

test("getAgentBrowserErrorText falls back to command-aware exit codes when no envelope error exists", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		command: "snapshot",
		envelope: { success: true, data: null },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, "agent-browser snapshot exited with code 1.");
});

test("getAgentBrowserErrorText appends wrapper recovery hints only to fallback messages", () => {
	const wrapperRecoveryHint = "Wrapper recovery hint: inspect details.effectiveArgs and run tab list before retrying.";
	const fallbackErrorText = getAgentBrowserErrorText({
		aborted: false,
		command: "batch",
		effectiveArgs: ["--json", "--session", "named", "batch"],
		envelope: { success: false, data: { title: "Wrong page" } },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
		wrapperRecoveryHint,
	});
	const explicitErrorText = getAgentBrowserErrorText({
		aborted: false,
		command: "batch",
		effectiveArgs: ["--json", "--session", "named", "batch"],
		envelope: { success: false, error: "Upstream failure" },
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
		wrapperRecoveryHint,
	});

	assert.equal(
		fallbackErrorText,
		"agent-browser --json --session named batch reported failure (exit code 1).\nWrapper recovery hint: inspect details.effectiveArgs and run tab list before retrying.",
	);
	assert.equal(explicitErrorText, "Upstream failure");
});

test("getAgentBrowserErrorText defers mixed batch failures to batch rendering", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		envelope: {
			success: false,
			data: [
				{ command: ["open", "https://example.com"], result: { title: "Example Domain" }, success: true },
				{ command: ["click", "@zzz"], error: "Unknown ref: zzz", success: false },
			],
		},
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});

	assert.equal(errorText, undefined);
});

test("getAgentBrowserErrorText prefers spill/write failures over downstream parse errors", () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		exitCode: 0,
		parseError: "agent-browser returned invalid JSON: Unexpected end of JSON input",
		plainTextInspection: false,
		spawnError: new Error("pi-agent-browser temp spill budget exceeded"),
		stderr: "",
	});

	assert.equal(errorText, "pi-agent-browser temp spill budget exceeded");
});

