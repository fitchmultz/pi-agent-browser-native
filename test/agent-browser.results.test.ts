import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS, AGENT_BROWSER_RICH_INPUT_RECOVERY_NEXT_ACTION_IDS, getAgentBrowserRichInputRecoveryNextActionId, getAgentBrowserRichInputRecoveryNextActionIds } from "../extensions/agent-browser/lib/results/recovery-actions.js";
import { buildAgentBrowserNextActions } from "../extensions/agent-browser/lib/results/action-recommendations.js";
import { buildAgentBrowserResultCategoryDetails, classifyAgentBrowserFailureCategory, classifyAgentBrowserSuccessCategory } from "../extensions/agent-browser/lib/results/categories.js";
import { mergeSessionArtifactManifest, retirePendingRecordingManifestEntries } from "../extensions/agent-browser/lib/results/artifact-manifest.js";
import type { SessionArtifactManifest } from "../extensions/agent-browser/lib/results/contracts.js";
import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
import { getAgentBrowserErrorText, parseAgentBrowserEnvelope } from "../extensions/agent-browser/lib/results/envelope.js";
import {
	alignPageChangeSummaryNextActionIds,
	appendUniqueAgentBrowserNextActions,
	applyNamespaceToNextActions,
	applySessionToNextActions,
	isStandaloneSnapshotNextAction,
	type AgentBrowserNextAction,
} from "../extensions/agent-browser/lib/results/next-actions.js";
import {
	chooseOpenResultTabCorrection,
	extractCommandTokens,
	parseCommandInfo,
	validateToolArgs,
} from "../extensions/agent-browser/lib/runtime.js";

const MISSING_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: missing boolean success field.";
const NON_BOOLEAN_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: success field must be boolean.";

test("retirePendingRecordingManifestEntries retires only the closed session recording", () => {
	const manifest: SessionArtifactManifest = {
		entries: [
			{ command: "record", createdAtMs: 1, kind: "video", path: "a.webm", retentionState: "live", session: "a", storageScope: "explicit-path", subcommand: "start" },
			{ command: "record", createdAtMs: 2, kind: "video", path: "b.webm", retentionState: "live", session: "b", storageScope: "explicit-path", subcommand: "restart" },
			{ command: "screenshot", createdAtMs: 3, kind: "image", path: "a.png", retentionState: "live", session: "a", storageScope: "explicit-path" },
		],
		evictedCount: 0,
		liveCount: 3,
		maxEntries: 100,
		updatedAtMs: 3,
		version: 1,
	};
	const retired = retirePendingRecordingManifestEntries(manifest, "a", undefined, 4);
	assert.deepEqual(retired.entries.map((entry) => entry.path), ["a.webm", "b.webm", "a.png"]);
	assert.equal(retired.entries[0]?.subcommand, "close-abandoned");
	assert.equal(retired.entries[0]?.retentionState, "missing");
	assert.equal(retired.liveCount, 2);
	assert.equal(retired.updatedAtMs, 4);
});

test("recording manifests keep namespace identities distinct on the same path", () => {
	const manifest = mergeSessionArtifactManifest({
		entries: [
			{ absolutePath: "/tmp/shared.webm", command: "record", createdAtMs: 1, kind: "video", namespace: "one", path: "shared.webm", retentionState: "live", session: "shared", storageScope: "explicit-path", subcommand: "start" },
			{ absolutePath: "/tmp/shared.webm", command: "record", createdAtMs: 2, kind: "video", namespace: "two", path: "shared.webm", retentionState: "live", session: "shared", storageScope: "explicit-path", subcommand: "start" },
		],
		nowMs: 3,
	});
	assert.equal(manifest?.entries.length, 2);
	const retired = retirePendingRecordingManifestEntries(manifest!, "shared", "one", 4);
	assert.equal(retired.entries.find((entry) => entry.namespace === "one")?.subcommand, "close-abandoned");
	assert.equal(retired.entries.find((entry) => entry.namespace === "two")?.subcommand, "start");
});

test("AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS locks documented recovery action ids", () => {
	assert.deepEqual(AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS, {
		aboutBlankListTabs: "list-tabs-for-about-blank-recovery",
		connectedSessionGetUrl: "verify-connected-session-url",
		connectedSessionListTabs: "list-connected-session-tabs",
		genericTabDriftListTabs: "list-tabs-for-recovery",
		noActivePageListTabs: "list-tabs-after-no-active-page",
		selectIntendedTabAfterDrift: "select-intended-tab-after-drift",
		snapshotAfterTabRecovery: "snapshot-after-tab-recovery",
		tabDriftListTabs: "list-tabs-for-tab-drift-recovery",
		tabGoneListTabs: "list-tabs-after-tab-gone",
		tabGoneNewTab: "open-tab-after-tab-gone",
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

test("applyNamespaceToNextActions preserves namespaced follow-up context", () => {
	const namespaced = applyNamespaceToNextActions([
		{ id: "snapshot", params: { args: ["--session", "work", "snapshot", "-i"] }, reason: "r", tool: "agent_browser" },
		{ id: "network-source", params: { networkSourceLookup: { requestId: "req-1", session: "work" } }, reason: "r", tool: "agent_browser" },
		{ id: "status", params: { electron: { action: "status", launchId: "l1" } }, reason: "r", tool: "agent_browser" },
	], "review");
	assert.deepEqual(namespaced?.[0]?.params?.args, ["--namespace", "review", "--session", "work", "snapshot", "-i"]);
	assert.deepEqual(namespaced?.[1]?.params?.networkSourceLookup, { namespace: "review", requestId: "req-1", session: "work" });
	assert.deepEqual(namespaced?.[2]?.params, { electron: { action: "status", launchId: "l1" } });
	assert.deepEqual(applyNamespaceToNextActions(namespaced, "review")?.[0]?.params?.args, namespaced?.[0]?.params?.args);

	const defaultNamespaced = applyNamespaceToNextActions([
		{ id: "snapshot", params: { args: ["--session", "work", "snapshot", "-i"] }, reason: "r", tool: "agent_browser" },
		{ id: "network-source", params: { networkSourceLookup: { requestId: "req-1", session: "work" } }, reason: "r", tool: "agent_browser" },
	], "");
	assert.deepEqual(defaultNamespaced?.[0]?.params?.args, ["--namespace", "", "--session", "work", "snapshot", "-i"]);
	assert.deepEqual(defaultNamespaced?.[1]?.params?.networkSourceLookup, { namespace: "", requestId: "req-1", session: "work" });
	assert.deepEqual(applyNamespaceToNextActions(defaultNamespaced, "")?.[0]?.params?.args, defaultNamespaced?.[0]?.params?.args);
});

test("applySessionToNextActions preserves session-scoped follow-up context", () => {
	const sessionScoped = applySessionToNextActions([
		{ id: "snapshot", params: { args: ["snapshot", "-i"] }, reason: "r", tool: "agent_browser" },
		{ id: "namespaced", params: { args: ["--namespace", "review", "snapshot", "-i"] }, reason: "r", tool: "agent_browser" },
		{ id: "network-source", params: { networkSourceLookup: { requestId: "req-1" } }, reason: "r", tool: "agent_browser" },
		{ id: "status", params: { electron: { action: "status", launchId: "l1" } }, reason: "r", tool: "agent_browser" },
	], "work");
	assert.deepEqual(sessionScoped?.[0]?.params?.args, ["--session", "work", "snapshot", "-i"]);
	assert.deepEqual(sessionScoped?.[1]?.params?.args, ["--namespace", "review", "--session", "work", "snapshot", "-i"]);
	assert.deepEqual(sessionScoped?.[2]?.params?.networkSourceLookup, { requestId: "req-1" });
	assert.deepEqual(sessionScoped?.[3]?.params, { electron: { action: "status", launchId: "l1" } });
	const repeated = applySessionToNextActions(sessionScoped, "work");
	assert.deepEqual(repeated?.[0]?.params?.args, sessionScoped?.[0]?.params?.args);
	assert.deepEqual(repeated?.[1]?.params?.args, sessionScoped?.[1]?.params?.args);
});

test("appendUniqueAgentBrowserNextActions preserves order and first-id wins", () => {
	const action = (id: string, args?: string[], stdin?: string): AgentBrowserNextAction => ({
		id,
		params: args ? { args, ...(stdin ? { stdin } : {}) } : undefined,
		reason: id,
		tool: "agent_browser",
	});
	const actions = [action("a")];
	appendUniqueAgentBrowserNextActions(actions, [action("b"), action("a", ["ignored"])]);
	actions.push(action("a", ["kept-when-not-unique"]));
	assert.deepEqual(actions.map((item) => [item.id, item.params?.args?.[0]]), [
		["a", undefined],
		["b", undefined],
		["a", "kept-when-not-unique"],
	]);

	const replaced = [action("snapshot", ["snapshot", "-i"]), action("session-snapshot", ["--session", "s1", "snapshot", "-i"]), action("namespaced-snapshot", ["--namespace", "", "--session", "s1", "snapshot", "-i"]), action("batched-snapshot", ["batch"], JSON.stringify([["snapshot", "-i"]]))];
	assert.deepEqual(replaced.filter((item) => !isStandaloneSnapshotNextAction(item)).map((item) => item.id), ["batched-snapshot"]);
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

test("validateToolArgs rejects wrapper fields passed as upstream argv", () => {
	assert.equal(validateToolArgs(["open", "https://example.com"]), undefined);
	assert.match(validateToolArgs(["open", "https://example.com", "--session-mode", "fresh"]) ?? "", /top-level agent_browser `sessionMode` field/);
	assert.match(validateToolArgs(["open", "https://example.com", "--session-mode=fresh"]) ?? "", /Do not pass `--session-mode` in args/);
});

test("classifyAgentBrowserFailureCategory locks common machine-readable failure categories", () => {
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Unknown ref: e4", args: ["click", "@e4"] }), "stale-ref");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Failed to parse selector text=Close" }), "selector-unsupported");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Unable to find selector text=Close", command: "find" }), "selector-unsupported");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Element not found", command: "find" }), "selector-not-found");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "No elements found for selector .missing" }), "selector-not-found");
	assert.equal(
		classifyAgentBrowserFailureCategory({
			command: "find",
			errorText: '1 element has role "button", but none match name "Nope". Names seen: "Submit"',
			args: ["find", "role", "button", "click", "--name", "Nope"],
		}),
		"selector-not-found",
	);
	assert.equal(
		classifyAgentBrowserFailureCategory({
			command: "find",
			errorText:
				"No element found: getByRole('dialog', { name: 'X' }). Verify the selector, role, or name is correct and the element exists in the DOM.",
			args: ["find", "role", "dialog", "click", "--name", "X"],
		}),
		"selector-not-found",
	);
	assert.equal(
		classifyAgentBrowserFailureCategory({
			command: "click",
			errorText: "Element not found: text=Nope. Verify the selector, role, or name is correct and the element exists in the DOM.",
			args: ["click", "text=Nope"],
		}),
		"selector-not-found",
	);
	assert.equal(
		classifyAgentBrowserFailureCategory({
			command: "find",
			errorText: '1 element has role "button", but none match name "timeout missing". Names seen: "Save timeout report"',
			args: ["find", "role", "button", "click", "--name", "timeout missing"],
		}),
		"selector-not-found",
	);
	assert.equal(
		classifyAgentBrowserFailureCategory({
			command: "find",
			errorText: '1 element has role "button", but none match name "Operation timed out". Names seen: "Submit"',
			args: ["find", "role", "button", "click", "--name", "Operation timed out"],
		}),
		"selector-not-found",
	);
	assert.equal(
		classifyAgentBrowserFailureCategory({
			command: "eval",
			errorText: 'debug dump Names seen: "not a locator miss"',
		}),
		"upstream-error",
	);
	assert.equal(
		classifyAgentBrowserFailureCategory({
			command: "find",
			errorText: '1 element has role "button", but none match name "Confirmation required". Names seen: "Submit"',
			args: ["find", "role", "button", "click", "--name", "Confirmation required"],
		}),
		"selector-not-found",
	);
	assert.equal(classifyAgentBrowserFailureCategory({ confirmationRequired: true, errorText: "ok" }), "confirmation-required");
	assert.equal(
		classifyAgentBrowserFailureCategory({
			confirmationRequired: true,
			command: "find",
			errorText: '1 element has role "button", but none match name "Nope". Names seen: "Submit"',
			args: ["find", "role", "button", "click", "--name", "Nope"],
		}),
		"confirmation-required",
	);
	assert.equal(classifyAgentBrowserFailureCategory({ timedOut: true }), "timeout");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Download not verified: file missing", command: "download" }), "download-not-verified");
	assert.equal(buildAgentBrowserResultCategoryDetails({ failureCategory: "artifact-missing", succeeded: false }).failureCategory, "artifact-missing");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "agent-browser is required but was not found on PATH" }), "missing-binary");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Agent-browser Unix socket path would be 140 bytes (max 103)." }), "validation-error");
	assert.equal(classifyAgentBrowserFailureCategory({ parseError: "agent-browser returned invalid JSON" }), "parse-failure");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Confirmation required: c_demo" }), "confirmation-required");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Electron launch blocked by caller deny policy." }), "policy-blocked");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "Electron cleanup partial: remaining resources detected." }), "cleanup-failed");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "agent-browser could not re-select the intended tab before running the command." }), "tab-drift");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "tab_gone: bound tab is gone (target ABC). Run `agent-browser tab new <url>` to bind a new tab, or `agent-browser tab list` to pick an existing one" }), "tab-gone");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "tab_gone: bound tab is gone (target ABC, last url https://example.com/aborted). Run `agent-browser tab new <url>` to bind a new tab, or `agent-browser tab list` to pick an existing one" }), "tab-gone");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "tab_gone: bound tab is gone (target ABC, last url https://example.com/policy-blocked). Run `agent-browser tab new <url>` to bind a new tab, or `agent-browser tab list` to pick an existing one" }), "tab-gone");
	assert.equal(classifyAgentBrowserFailureCategory({
		errorText: "tab_gone: bound tab is gone (target ABC, last url about:blank). Run `agent-browser tab new <url>` to bind a new tab, or `agent-browser tab list` to pick an existing one",
		tabDrift: true,
	}), "tab-gone");
	assert.equal(classifyAgentBrowserFailureCategory({ errorText: "eval failed: help says commands fail with a `tab_gone` error instead of adopting another tab" }), "upstream-error");
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
	assert.equal(classifyAgentBrowserSuccessCategory({ artifacts: [{ absolutePath: "/tmp/demo.webm", command: "record", kind: "video", path: "/tmp/demo.webm", recordingState: "openRecording", status: "pending", subcommand: "start" }] }), "artifact-pending");
	assert.equal(classifyAgentBrowserSuccessCategory({ artifacts: [{ absolutePath: "/tmp/a.png", exists: false, kind: "image", path: "/tmp/a.png" }] }), "artifact-unverified");
});

test("buildAgentBrowserNextActions returns exact native-tool recommendations for common states", () => {
	for (const command of ["open", "goto", "navigate"] as const) {
		assert.deepEqual(buildAgentBrowserNextActions({ command, resultCategory: "success", successCategory: "completed" }), [
			{
				id: "inspect-opened-page",
				params: { args: ["snapshot", "-i"] },
				reason: "Inspect the opened page before choosing interactive refs.",
				tool: "agent_browser",
			},
		], command);
	}
	assert.deepEqual(buildAgentBrowserNextActions({ command: "click", resultCategory: "failure", failureCategory: "stale-ref" })?.[0]?.params?.args, ["snapshot", "-i"]);
	assert.equal(buildAgentBrowserNextActions({ command: "wait", resultCategory: "failure", failureCategory: "timeout" })?.[0]?.id, "inspect-after-timeout");
	assert.deepEqual(buildAgentBrowserNextActions({ args: ["wait", "--url", "**/cart.html"], command: "wait", resultCategory: "failure", failureCategory: "timeout" })?.map((action) => action.id), ["inspect-after-timeout", "fresh-session-after-url-wait-timeout"]);
	assert.deepEqual(buildAgentBrowserNextActions({ args: ["wait", "--url", "**/cart.html"], command: "wait", resultCategory: "failure", failureCategory: "timeout" })?.[1]?.params, { args: ["open", "about:blank"], sessionMode: "fresh" });
	// Fresh-session recovery must stay unprefixed: the planner ignores sessionMode when --session is explicit.
	assert.deepEqual(buildAgentBrowserNextActions({ args: ["wait", "--url", "**/cart.html"], command: "wait", resultCategory: "failure", failureCategory: "timeout", sessionName: "named" })?.map((action) => action.params), [
		{ args: ["--session", "named", "snapshot", "-i"] },
		{ args: ["open", "about:blank"], sessionMode: "fresh" },
	]);
	assert.deepEqual(buildAgentBrowserNextActions({ args: ["wait", "--text", "Done"], command: "wait", resultCategory: "failure", failureCategory: "timeout" })?.map((action) => action.id), ["inspect-after-text-assertion-failure"]);
	assert.equal(buildAgentBrowserNextActions({ command: "open", resultCategory: "failure", failureCategory: "upstream-error" })?.[0]?.id, "inspect-page-after-navigation-error");
	assert.deepEqual(buildAgentBrowserNextActions({ command: "wait", resultCategory: "failure", failureCategory: "timeout", sessionName: "named" })?.[0]?.params?.args, ["--session", "named", "snapshot", "-i"]);
	assert.deepEqual(buildAgentBrowserNextActions({ command: "open", resultCategory: "failure", failureCategory: "upstream-error", sessionName: "named" })?.[0]?.params?.args, ["--session", "named", "get", "url"]);
	for (const command of ["key", "keydown", "keyboard", "keyup", "scrollinto", "tap"] as const) {
		assert.equal(buildAgentBrowserNextActions({ command, resultCategory: "success", successCategory: "completed" })?.[0]?.id, "inspect-after-mutation", command);
	}
	assert.deepEqual(buildAgentBrowserNextActions({ resultCategory: "failure", failureCategory: "confirmation-required", confirmationId: "c_demo" })?.map((action) => action.params?.args), [["confirm", "c_demo"], ["deny", "c_demo"]]);
	assert.deepEqual(
		buildAgentBrowserNextActions({ resultCategory: "failure", failureCategory: "tab-drift" })?.map((action) => ({ id: action.id, args: action.params?.args })),
		[{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.genericTabDriftListTabs, args: ["tab", "list"] }],
	);
	assert.deepEqual(
		buildAgentBrowserNextActions({ resultCategory: "failure", failureCategory: "tab-gone" })?.map((action) => ({ id: action.id, args: action.params?.args })),
		[
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabGoneListTabs, args: ["tab", "list"] },
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabGoneNewTab, args: ["tab", "new"] },
		],
	);
	assert.deepEqual(
		buildAgentBrowserNextActions({ recovery: { kind: "connected-session", sessionName: "named" }, resultCategory: "success", successCategory: "completed" })?.map((action) => ({ id: action.id, args: action.params?.args })),
		[
			{ id: AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.connectedSessionGetUrl, args: ["--session", "named", "get", "url"] },
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
	assert.deepEqual(buildAgentBrowserNextActions({ artifacts: [{ absolutePath: "/tmp/export.csv", exists: false, kind: "download", path: "/tmp/export.csv" }], resultCategory: "failure", failureCategory: "artifact-missing" })?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
	assert.equal(buildAgentBrowserNextActions({ artifacts: [{ absolutePath: "/tmp/page.png", kind: "image", path: "/tmp/page.png" }], resultCategory: "success", successCategory: "artifact-saved" })?.[0]?.artifactPath, "/tmp/page.png");
	assert.deepEqual(buildAgentBrowserNextActions({ artifacts: [{ absolutePath: "/tmp/export.csv", exists: false, kind: "download", path: "/tmp/export.csv" }], resultCategory: "success", savedFilePath: "/tmp/export.csv", successCategory: "artifact-saved" })?.map((action) => action.id), ["wait-for-download"]);
	assert.equal(buildAgentBrowserNextActions({ artifacts: [{ absolutePath: "/tmp/state.json", exists: false, kind: "file", path: "/tmp/state.json" }], resultCategory: "success", successCategory: "artifact-saved" })?.[0]?.id, "verify-artifact-path");
	assert.deepEqual(
		buildAgentBrowserNextActions({ artifacts: [{ absolutePath: "/tmp/demo.webm", command: "record", kind: "video", path: "/tmp/demo.webm", recordingState: "openRecording", status: "pending", subcommand: "start" }], resultCategory: "success", sessionName: "named", successCategory: "artifact-pending" })?.[0],
		{
			id: "stop-pending-recording",
			params: { args: ["--session", "named", "record", "stop"] },
			reason: "Stop the active recording so the requested video can be finalized and verified on disk.",
			safety: "The file remains pending until record stop succeeds; verify details.artifactVerification afterward.",
			tool: "agent_browser",
		},
	);
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
					{ active: false, label: "chat", tabId: "t1", targetId: "4A0B7C4E1F2D3A4B5C6D7E8F90A1B2C3", title: "ChatGPT", url: "https://chatgpt.com/" },
					{ active: true, label: "grok", tabId: "t2", title: "Grok", url: "https://grok.com/" },
				],
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /- \[t1\] label=chat target=4A0B7C4E1F2D3A4B5C6D7E8F90A1B2C3 ChatGPT — https:\/\/chatgpt\.com\//);
	assert.match((presentation.content[0] as { text: string }).text, /\* \[t2\] label=grok Grok — https:\/\/grok\.com\//);
	assert.equal(presentation.summary, "Tabs: 2");
});

test("buildToolPresentation classifies tab_gone envelopes and recommends tab recovery", async () => {
	const errorText = getAgentBrowserErrorText({
		aborted: false,
		envelope: {
			success: false,
			error: "tab_gone: bound tab is gone (target ABC, last url https://example.com/aborted). Run `agent-browser tab new <url>` to bind a new tab, or `agent-browser tab list` to pick an existing one",
		},
		exitCode: 1,
		plainTextInspection: false,
		stderr: "",
	});
	assert.match(errorText ?? "", /^tab_gone:/);

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot", subcommand: "-i" },
		cwd: process.cwd(),
		errorText,
	});

	assert.equal(presentation.failureCategory, "tab-gone");
	assert.deepEqual(presentation.nextActions?.map((action) => action.id), [
		AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabGoneListTabs,
		AGENT_BROWSER_RECOVERY_NEXT_ACTION_IDS.tabGoneNewTab,
	]);
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

test("parseAgentBrowserEnvelope accepts exact plugin list and show success envelopes", async () => {
	const list = await parseAgentBrowserEnvelope(JSON.stringify({ plugins: [] }));
	const show = await parseAgentBrowserEnvelope(JSON.stringify({ plugin: { capabilities: ["command.run"], name: "demo" } }));

	assert.equal(list.parseError, undefined);
	assert.equal(list.envelope?.success, true);
	assert.deepEqual(list.envelope?.data, { plugins: [] });
	assert.equal(show.parseError, undefined);
	assert.equal(show.envelope?.success, true);
	assert.deepEqual(show.envelope?.data, { plugin: { capabilities: ["command.run"], name: "demo" } });
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

test("parseAgentBrowserEnvelope treats top-level success responses as data when data is omitted", async () => {
	const parsed = await parseAgentBrowserEnvelope(JSON.stringify({ checks: [{ message: "ok", status: "pass" }], success: true, summary: { fail: 0, pass: 1 } }));

	assert.equal(parsed.parseError, undefined);
	assert.equal(parsed.envelope?.success, true);
	assert.deepEqual(parsed.envelope?.data, { checks: [{ message: "ok", status: "pass" }], summary: { fail: 0, pass: 1 } });
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
	assert.match(errorText ?? "", /before the upstream CLI entered its 30s IPC retry path/);

	const longerErrorText = getAgentBrowserErrorText({
		aborted: false,
		exitCode: 124,
		plainTextInspection: false,
		stderr: "",
		timedOut: true,
		timeoutMs: 35000,
	});
	assert.match(longerErrorText ?? "", /35000ms wrapper watchdog/);
	assert.match(longerErrorText ?? "", /after waiting beyond the upstream CLI's 30s IPC retry window/);
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

test("extractQaPageContext prefers batch open title over compiled checks url", async () => {
	const { extractQaPageContext } = await import("../extensions/agent-browser/lib/input-modes/job.js");
	const page = extractQaPageContext({
		batchData: [
			{
				command: ["open", "https://example.test/"],
				success: true,
				result: { title: "Open Title", url: "https://example.test/" },
			},
		],
		compiled: {
			checks: {
				attached: false,
				checkConsole: true,
				checkErrors: true,
				checkNetwork: true,
				diagnosticsResetAtStart: true,
				expectedText: [],
				loadState: "domcontentloaded",
				url: "https://example.test/",
			},
			steps: [],
			args: ["batch"],
			failFast: false,
			stdin: "[]",
		},
	});
	assert.equal(page.title, "Open Title");
	assert.equal(page.url, "https://example.test/");
});

test("isHttpOrHttpsUrl accepts http(s) only", async () => {
	const { buildQaCompactPassText, isHttpOrHttpsUrl } = await import("../extensions/agent-browser/lib/input-modes/job.js");
	assert.equal(isHttpOrHttpsUrl("https://example.test/"), true);
	assert.equal(isHttpOrHttpsUrl("http://127.0.0.1/"), true);
	assert.equal(isHttpOrHttpsUrl("about:blank"), false);
	assert.equal(isHttpOrHttpsUrl("app://demo"), false);
	assert.equal(isHttpOrHttpsUrl("not-a-url"), false);
	const compact = buildQaCompactPassText({
		batchStepCount: 9,
		checks: {
			attached: false,
			checkConsole: true,
			checkErrors: true,
			checkNetwork: true,
			diagnosticsResetAtStart: true,
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
	assert.match(compact, /Checks run: load:domcontentloaded, text×1, network, console, errors, diagnostics-reset \(9 batch steps\)/);
	assert.match(compact, /Diagnostic isolation: URL QA clears enabled network\/console buffers, then snapshots any page-error residue/);
	assert.match(compact, /Full diagnostic matrix: see details\.qaPreset and details\.batchSteps\./);
});

