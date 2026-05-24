/**
 * Purpose: Verify command parsing, envelope parsing, tab-correction selection, and error-text rendering helpers.
 * Responsibilities: Assert stable result facade behavior for valid envelopes, malformed output, fallback failures, command extraction, and tab list presentation.
 * Scope: Unit-style Node test-runner coverage for result/runtime helpers; richer presentation formatting lives in `agent-browser.presentation.test.ts`.
 * Usage: Run with `npx tsx --test test/agent-browser.results.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests avoid real subprocesses and use deterministic fixture payloads.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS,
	AGENT_BROWSER_RICH_INPUT_RECOVERY_NEXT_ACTION_IDS,
	buildAgentBrowserNextActions,
	buildToolPresentation,
	classifyAgentBrowserFailureCategory,
	classifyAgentBrowserSuccessCategory,
	getAgentBrowserErrorText,
	getAgentBrowserRichInputRecoveryNextActionId,
	getAgentBrowserRichInputRecoveryNextActionIds,
	parseAgentBrowserEnvelope,
} from "../extensions/agent-browser/lib/results.js";
import {
	AgentBrowserNextActionCollector,
	alignPageChangeSummaryNextActionIds,
	isStandaloneSnapshotNextAction,
	type AgentBrowserNextAction,
} from "../extensions/agent-browser/lib/results/next-actions.js";
import {
	chooseOpenResultTabCorrection,
	extractCommandTokens,
	parseCommandInfo
} from "../extensions/agent-browser/lib/runtime.js";

const MISSING_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: missing boolean success field.";
const NON_BOOLEAN_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: success field must be boolean.";

test("AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS locks documented recovery action ids", () => {
	assert.deepEqual(AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS, {
		aboutBlankListTabs: "list-tabs-for-about-blank-recovery",
		connectedSessionListTabs: "list-connected-session-tabs",
		genericTabDriftListTabs: "list-tabs-for-recovery",
		noActivePageListTabs: "list-tabs-after-no-active-page",
		selectIntendedTabAfterDrift: "select-intended-tab-after-drift",
		snapshotAfterTabRecovery: "snapshot-after-tab-recovery",
		tabDriftListTabs: "list-tabs-for-tab-drift-recovery",
	});
});

test("rich input recovery nextAction id helpers lock exact ids", () => {
	assert.deepEqual(AGENT_BROWSER_RICH_INPUT_RECOVERY_NEXT_ACTION_IDS, {
		click: "click-current-editable-ref",
		focus: "focus-current-editable-ref",
	});
	assert.equal(getAgentBrowserRichInputRecoveryNextActionId("focus", 0, 1), "focus-current-editable-ref");
	assert.equal(getAgentBrowserRichInputRecoveryNextActionId("click", 0, 1), "click-current-editable-ref");
	assert.deepEqual(getAgentBrowserRichInputRecoveryNextActionIds(3), [
		"focus-current-editable-ref-1",
		"click-current-editable-ref-1",
		"focus-current-editable-ref-2",
		"click-current-editable-ref-2",
		"focus-current-editable-ref-3",
		"click-current-editable-ref-3",
	]);
});

test("AgentBrowserNextActionCollector preserves order, first-id wins, replacement, and snapshot removal", () => {
	const action = (id: string, args?: string[], stdin?: string): AgentBrowserNextAction => ({
		id,
		params: args ? { args, ...(stdin ? { stdin } : {}) } : undefined,
		reason: id,
		tool: "agent_browser",
	});
	const collector = new AgentBrowserNextActionCollector([action("a")]);
	collector.appendUnique([action("b"), action("a", ["ignored"])]);
	collector.append([action("a", ["kept-when-not-unique"])]);
	assert.deepEqual(collector.toArray()?.map((item) => [item.id, item.params?.args?.[0]]), [
		["a", undefined],
		["b", undefined],
		["a", "kept-when-not-unique"],
	]);

	collector.replace([action("snapshot", ["snapshot", "-i"]), action("session-snapshot", ["--session", "s1", "snapshot", "-i"]), action("batched-snapshot", ["batch"], JSON.stringify([["snapshot", "-i"]]))]);
	collector.removeWhere(isStandaloneSnapshotNextAction);
	assert.deepEqual(collector.toArray()?.map((item) => item.id), ["batched-snapshot"]);
});

test("alignPageChangeSummaryNextActionIds keeps only emitted action ids", () => {
	assert.deepEqual(
		alignPageChangeSummaryNextActionIds(
			{ changeType: "mutation" as const, nextActionIds: ["keep", "drop"], summary: "changed" },
			[{ id: "keep", reason: "keep", tool: "agent_browser" }],
		),
		{ changeType: "mutation", nextActionIds: ["keep"], summary: "changed" },
	);
	assert.deepEqual(
		alignPageChangeSummaryNextActionIds(
			{ changeType: "mutation" as const, nextActionIds: ["drop"], summary: "changed" },
			[{ id: "keep", reason: "keep", tool: "agent_browser" }],
		),
		{ changeType: "mutation", nextActionIds: undefined, summary: "changed" },
	);
});

test("classifyAgentBrowserFailureCategory locks common machine-readable failure categories", () => {
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Unknown ref: e4", args: ["click", "@e4"] }), "stale-ref");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Failed to parse selector text=Close" }), "selector-unsupported");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Unable to find selector text=Close", command: "find" }), "selector-unsupported");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Element not found", command: "find" }), "selector-not-found");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "No elements found for selector .missing" }), "selector-not-found");
	assert.equal(classifyAgentBrowserFailureCategory({ timedOut: true }), "timeout");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Download not verified: file missing", command: "download" }), "download-not-verified");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "agent-browser is required but was not found on PATH" }), "missing-binary");
	assert.equal(classifyAgentBrowserFailureCategory({ parseError: "agent-browser returned invalid JSON" }), "parse-failure");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Confirmation required: c_demo" }), "confirmation-required");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Electron launch blocked by caller deny policy." }), "policy-blocked");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Electron cleanup partial: remaining resources detected." }), "cleanup-failed");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "agent-browser could not re-select the intended tab before running the command." }), "tab-drift");
	assert.equal(classifyAgentBrowserFailureCategory({
		errorText: 'qa.attached requires an http(s) page URL; the current attached URL is "about:blank".',
		validationError: 'qa.attached requires an http(s) page URL; the current attached URL is "about:blank".',
	}), "validation-error");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Navigation failed: net::ERR_BLOCKED_BY_CLIENT" }), "upstream-error");
});

test("classifyAgentBrowserSuccessCategory locks common machine-readable success categories", () => {
	assert.equal(classifyAgentBrowserSuccessCategory({}), "completed");
	assert.equal(classifyAgentBrowserSuccessCategory({ inspection: true }), "inspection");
	assert.equal(classifyAgentBrowserSuccessCategory({ artifacts: [{ absolutePath: "/tmp/a.png", exists: true, kind: "image", path: "/tmp/a.png" }] }), "artifact-saved");
	assert.equal(classifyAgentBrowserSuccessCategory({ artifacts: [{ absolutePath: "/tmp/a.png", exists: false, kind: "image", path: "/tmp/a.png" }] }), "artifact-unverified");
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
	assert.deepEqual(
		buildAgentBrowserNextActions({ resultCategory: "failure", failureCategory: "tab-drift" })?.map((action) => ({ id: action.id, args: action.params?.args })),
		[{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.genericTabDriftListTabs, args: ["tab", "list"] }],
	);
	assert.deepEqual(
		buildAgentBrowserNextActions({ recovery: { kind: "connected-session", sessionName: "named" }, resultCategory: "success", successCategory: "completed" })?.map((action) => ({ id: action.id, args: action.params?.args })),
		[
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.connectedSessionListTabs, args: ["--session", "named", "tab", "list"] },
		],
	);
	assert.deepEqual(
		buildAgentBrowserNextActions({ recovery: { kind: "no-active-page", sessionName: "named" }, resultCategory: "failure" })?.map((action) => ({ id: action.id, args: action.params?.args })),
		[
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.noActivePageListTabs, args: ["--session", "named", "tab", "list"] },
		],
	);
	assert.deepEqual(
		buildAgentBrowserNextActions({ recovery: { kind: "no-active-page", selectedTab: "t2", sessionName: "named" }, resultCategory: "failure" })?.map((action) => ({ id: action.id, args: action.params?.args, stdin: action.params?.stdin })),
		[
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.noActivePageListTabs, args: ["--session", "named", "tab", "list"], stdin: undefined },
		],
	);
	assert.deepEqual(
		buildAgentBrowserNextActions({
			failureCategory: "tab-drift",
			recovery: { kind: "about-blank", selectedTab: "t2", sessionName: "named", targetTitle: "Canvas", targetUrl: "app://canvas" },
			resultCategory: "failure",
		})?.map((action) => ({ id: action.id, args: action.params?.args, stdin: action.params?.stdin })),
		[
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.aboutBlankListTabs, args: ["--session", "named", "tab", "list"], stdin: undefined },
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.selectIntendedTabAfterDrift, args: ["--session", "named", "tab", "t2"], stdin: undefined },
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.snapshotAfterTabRecovery, args: ["--session", "named", "batch"], stdin: '[["tab","t2"],["snapshot","-i"]]' },
		],
	);
	assert.deepEqual(
		buildAgentBrowserNextActions({
			failureCategory: "tab-drift",
			recovery: { kind: "about-blank", recoveryApplied: true, selectedTab: "t2", sessionName: "named", targetTitle: "Canvas", targetUrl: "app://canvas" },
			resultCategory: "failure",
		})?.map((action) => ({ id: action.id, args: action.params?.args, stdin: action.params?.stdin })),
		[
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.aboutBlankListTabs, args: ["--session", "named", "tab", "list"], stdin: undefined },
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.selectIntendedTabAfterDrift, args: ["--session", "named", "tab", "t2"], stdin: undefined },
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.snapshotAfterTabRecovery, args: ["--session", "named", "snapshot", "-i"], stdin: undefined },
		],
	);
	assert.deepEqual(
		buildAgentBrowserNextActions({
			failureCategory: "tab-drift",
			recovery: { kind: "tab-drift", selectedTab: "target", sessionName: "named", targetTitle: "Canvas", targetUrl: "app://canvas" },
			resultCategory: "failure",
		})?.map((action) => ({ id: action.id, args: action.params?.args })),
		[
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabDriftListTabs, args: ["--session", "named", "tab", "list"] },
		],
	);
	assert.deepEqual(buildAgentBrowserNextActions({ args: ["wait", "--download", "/tmp/export.csv"], resultCategory: "failure", failureCategory: "download-not-verified" })?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
	assert.deepEqual(buildAgentBrowserNextActions({ args: ["download", "@e1", "/tmp/export.csv"], resultCategory: "failure", failureCategory: "download-not-verified" })?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
	assert.equal(buildAgentBrowserNextActions({ artifacts: [{ absolutePath: "/tmp/page.png", kind: "image", path: "/tmp/page.png" }], resultCategory: "success", successCategory: "artifact-saved" })?.[0]?.artifactPath, "/tmp/page.png");
	assert.deepEqual(buildAgentBrowserNextActions({ artifacts: [{ absolutePath: "/tmp/export.csv", exists: false, kind: "download", path: "/tmp/export.csv" }], resultCategory: "success", savedFilePath: "/tmp/export.csv", successCategory: "artifact-saved" })?.map((action) => action.id), ["wait-for-download"]);
	assert.equal(buildAgentBrowserNextActions({ artifacts: [{ absolutePath: "/tmp/state.json", exists: false, kind: "file", path: "/tmp/state.json" }], resultCategory: "success", successCategory: "artifact-saved" })?.[0]?.id, "verify-artifact-path");
	assert.deepEqual(
		buildAgentBrowserNextActions({
			electron: { launchId: "el_123", sessionName: "pi-agent-browser-electron-el_123", status: "active" },
			resultCategory: "success",
			successCategory: "completed",
		})?.map((action) => ({ id: action.id, params: action.params })),
		[
			{ id: "status-electron-launch", params: { electron: { action: "status", launchId: "el_123" } } },
			{ id: "probe-electron-launch", params: { electron: { action: "probe", launchId: "el_123" } } },
			{ id: "cleanup-electron-launch", params: { electron: { action: "cleanup", launchId: "el_123" } } },
			{ id: "list-electron-tabs", params: { args: ["--session", "pi-agent-browser-electron-el_123", "tab", "list"] } },
			{ id: "snapshot-electron-session", params: { args: ["--session", "pi-agent-browser-electron-el_123", "snapshot", "-i"] } },
		],
	);
	assert.deepEqual(
		buildAgentBrowserNextActions({
			electron: { launchId: "el_456", status: "partial" },
			failureCategory: "cleanup-failed",
			resultCategory: "failure",
		})?.map((action) => ({ id: action.id, params: action.params })),
		[
			{ id: "status-electron-launch", params: { electron: { action: "status", launchId: "el_456" } } },
			{ id: "retry-electron-cleanup", params: { electron: { action: "cleanup", launchId: "el_456" } } },
		],
	);
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

test("isHttpOrHttpsUrl accepts http(s) only", async () => {
	const { buildQaCompactPassText, isHttpOrHttpsUrl } = await import("../extensions/agent-browser/lib/input-modes/job.js");
	assert.equal(isHttpOrHttpsUrl("https://example.test/"), true);
	assert.equal(isHttpOrHttpsUrl("http://127.0.0.1/"), true);
	assert.equal(isHttpOrHttpsUrl("about:blank"), false);
	assert.equal(isHttpOrHttpsUrl("app://demo"), false);
	assert.equal(isHttpOrHttpsUrl("not-a-url"), false);
	const compact = buildQaCompactPassText({
		batchStepCount: 8,
		checks: {
			attached: false,
			checkConsole: true,
			checkErrors: true,
			checkNetwork: true,
			expectedText: ["Welcome"],
			loadState: "domcontentloaded",
		},
		page: { title: "Example", url: "https://example.test/" },
		qaPreset: {
			failedChecks: [],
			passed: true,
			summary: "QA preset passed.",
			warnings: [],
		},
	});
	assert.match(compact, /Page: Example — https:\/\/example\.test\//);
	assert.match(compact, /Checks run: load:domcontentloaded, text×1, network, console, errors \(8 batch steps\)/);
	assert.match(compact, /Full diagnostic matrix: see details\.qaPreset and details\.batchSteps\./);
});

