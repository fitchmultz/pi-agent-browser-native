/**
 * Purpose: Verify the session-page-state owner for tab targets, page-scoped refs, invalidations, and pinning.
 * Responsibilities: Lock restore, ordered update, clear, and batch snapshot extraction behavior outside the extension entrypoint.
 * Scope: Unit tests for `lib/session-page-state.ts`; extension integration stays in tab-recovery and validation suites.
 * Usage: Run with `npx tsx --test test/agent-browser.session-page-state.test.ts` or via targeted PR #48 remediation gates.
 * Invariants/Assumptions: Public state views never expose internal ordering metadata.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getAgentBrowserSessionIdentityKey } from "../extensions/agent-browser/lib/argv-grammar.js";
import { batchHasSuccessfulCloseAll, getSuccessfulBatchCloseLifecycle } from "../extensions/agent-browser/lib/batch-lifecycle.js";
import { shouldCaptureNavigationSummary } from "../extensions/agent-browser/lib/orchestration/browser-run/session-state.js";
import {
	SessionPageState,
	buildNoActivePageRefSnapshotInvalidation,
	buildPageTransitionRefSnapshotInvalidation,
	deriveSessionTabTarget,
	extractLatestRefSnapshotStateFromBatchResults,
	extractRefSnapshotFromData,
	extractSessionTabTargetFromBatchResults,
	extractSessionTabTargetFromCommandData,
	getSessionPageStateKey,
} from "../extensions/agent-browser/lib/session-page-state.js";

function toolEntry(details: Record<string, unknown>, isError = false): unknown {
	return {
		type: "message",
		message: {
			details,
			isError,
			toolName: "agent_browser",
		},
	};
}

test("getSuccessfulBatchCloseLifecycle treats unidentified transcript rows conservatively", () => {
	assert.equal(batchHasSuccessfulCloseAll([{ command: ["quit", "--all"], success: true }]), true);
	assert.equal(batchHasSuccessfulCloseAll([{ command: ["close", "--all"], success: false }]), false);
	assert.equal(getSuccessfulBatchCloseLifecycle([{ success: true }]), undefined);
	assert.deepEqual(getSuccessfulBatchCloseLifecycle([
		{ command: ["close"], result: { statePath: "/tmp/state.json" }, success: true },
		{ success: true },
	]), { endsClosed: false, recordingClosedAfterBatch: false, statePath: "/tmp/state.json" });
	assert.deepEqual(getSuccessfulBatchCloseLifecycle([
		{ command: ["close"], success: true },
		{ command: ["record", "start", "ignored.webm"], success: true },
	]), { endsClosed: false, recordingClosedAfterBatch: false, statePath: undefined });
	assert.deepEqual(getSuccessfulBatchCloseLifecycle([
		{ command: ["close"], success: true },
		{ command: ["stream", "status"], result: { lifecycle: { effectiveLaunch: { browserLaunched: false } } }, success: true },
	]), { endsClosed: true, recordingClosedAfterBatch: true, statePath: undefined });
	assert.deepEqual(getSuccessfulBatchCloseLifecycle([
		{ command: ["close"], success: true },
		{ command: ["record", "stop"], result: { lifecycle: { effectiveLaunch: { browserLaunched: true } } }, success: true },
	]), { endsClosed: false, recordingClosedAfterBatch: true, statePath: undefined });
	assert.deepEqual(getSuccessfulBatchCloseLifecycle([
		{ command: ["close"], success: true },
		{ command: ["record", "stop"], success: true },
	]), { endsClosed: false, recordingClosedAfterBatch: true, statePath: undefined });
	assert.deepEqual(getSuccessfulBatchCloseLifecycle([
		{ command: ["close"], success: true },
		{ command: ["open", "https://example.test"], lifecycle: { effectiveLaunch: { browserLaunched: true } }, success: false },
	]), { endsClosed: false, recordingClosedAfterBatch: true, statePath: undefined });
	assert.deepEqual(getSuccessfulBatchCloseLifecycle([
		{ command: ["close"], success: true },
		{ command: ["open", "https://example.test"], success: false },
	]), { endsClosed: false, recordingClosedAfterBatch: true, statePath: undefined });
	assert.deepEqual(getSuccessfulBatchCloseLifecycle([
		{ command: ["close"], success: true },
		{ command: ["open", "https://example.test"], lifecycle: { effectiveLaunch: { browserLaunched: false } }, success: false },
	]), { endsClosed: true, recordingClosedAfterBatch: true, statePath: undefined });
	assert.deepEqual(getSuccessfulBatchCloseLifecycle([
		{ command: ["close"], success: true },
		{ command: ["open", "https://example.test"], result: { lifecycle: { effectiveLaunch: { browserLaunched: true } } }, success: true },
		{ command: ["record", "start", "active.webm"], success: true },
	]), { endsClosed: false, recordingClosedAfterBatch: false, statePath: undefined });
});

test("SessionPageState.fromBranch restores tab targets, ref snapshots, invalidations, and restore pinning", () => {
	assert.equal(getSessionPageStateKey("session", "Team"), getSessionPageStateKey("session", "team"));
	assert.equal(getAgentBrowserSessionIdentityKey("Session", undefined, "darwin"), getAgentBrowserSessionIdentityKey("session", undefined, "darwin"));
	assert.equal(getAgentBrowserSessionIdentityKey("Straße", undefined, "darwin"), getAgentBrowserSessionIdentityKey("STRASSE", undefined, "darwin"));
	assert.equal(getAgentBrowserSessionIdentityKey("Σ", undefined, "darwin"), getAgentBrowserSessionIdentityKey("ς", undefined, "darwin"));
	assert.equal(getAgentBrowserSessionIdentityKey("session", "Straße", "darwin"), getAgentBrowserSessionIdentityKey("session", "STRASSE", "darwin"));
	assert.equal(getAgentBrowserSessionIdentityKey("session", "Σ", "darwin"), getAgentBrowserSessionIdentityKey("session", "ς", "darwin"));
	assert.equal(getAgentBrowserSessionIdentityKey("Session", undefined, "win32"), getAgentBrowserSessionIdentityKey("session", undefined, "win32"));
	assert.equal(getAgentBrowserSessionIdentityKey("session", "Straße", "win32"), getAgentBrowserSessionIdentityKey("session", "STRASSE", "win32"));
	assert.notEqual(getAgentBrowserSessionIdentityKey("Session", undefined, "linux"), getAgentBrowserSessionIdentityKey("session", undefined, "linux"));
	assert.notEqual(getAgentBrowserSessionIdentityKey("session", "Straße", "linux"), getAgentBrowserSessionIdentityKey("session", "STRASSE", "linux"));
	const state = SessionPageState.fromBranch([
		toolEntry({
			command: "snapshot",
			refSnapshot: { refIds: ["e1", "not-a-ref"], target: { title: "Example", url: "https://example.com/page#old" } },
			sessionName: "s1",
			sessionTabTarget: { title: "Example", url: "https://example.com/page#current" },
		}),
		toolEntry({
			command: "snapshot",
			refSnapshotInvalidation: buildNoActivePageRefSnapshotInvalidation(),
			sessionName: "s2",
		}),
	]);

	const restoredSession = state.get("s1");
	assert.deepEqual(restoredSession, {
		pinningReason: "restore",
		refSnapshot: { refIds: ["e1"], target: { title: "Example", url: "https://example.com/page" } },
		refSnapshotInvalidation: undefined,
		tabTarget: { title: "Example", url: "https://example.com/page" },
	});
	assert.ok(restoredSession.refSnapshot);
	assert.equal("order" in restoredSession.refSnapshot, false);
	assert.deepEqual(state.get("s2"), {
		pinningReason: undefined,
		refSnapshot: undefined,
		refSnapshotInvalidation: buildNoActivePageRefSnapshotInvalidation(),
		tabTarget: undefined,
	});
});

test("SessionPageState.fromBranch preserves a custom page-transition invalidation summary", () => {
	const custom = buildPageTransitionRefSnapshotInvalidation("A failed eval may still have changed the page.");
	const state = SessionPageState.fromBranch([
		toolEntry({
			command: "eval",
			refSnapshotInvalidation: custom,
			sessionName: "s1",
		}),
	]);
	assert.deepEqual(state.get("s1").refSnapshotInvalidation, custom);
});

test("SessionPageState.fromBranch clears restored page state on upstream close aliases", () => {
	for (const command of ["close", "quit", "exit"] as const) {
		const state = SessionPageState.fromBranch([
			toolEntry({
				command: "snapshot",
				refSnapshot: { refIds: ["e1"], target: { title: "Example", url: "https://example.com/" } },
				sessionName: "s1",
				sessionTabTarget: { title: "Example", url: "https://example.com/" },
			}),
			toolEntry({ command, sessionName: "s1" }),
		]);

		assert.deepEqual(state.get("s1"), {
			pinningReason: undefined,
			refSnapshot: undefined,
			refSnapshotInvalidation: undefined,
			tabTarget: undefined,
		}, command);
	}

	const nestedClose = SessionPageState.fromBranch([
		toolEntry({
			command: "snapshot",
			refSnapshot: { refIds: ["e1"], target: { title: "Example", url: "https://example.com/" } },
			sessionName: "s1",
			sessionTabTarget: { title: "Example", url: "https://example.com/" },
		}),
		toolEntry({
			batchSteps: [
				{ command: ["snapshot", "-i"], success: true },
				{ command: ["close"], success: true },
			],
			command: "batch",
			sessionName: "s1",
		}, true),
	]);
	assert.deepEqual(nestedClose.get("s1"), {
		pinningReason: undefined,
		refSnapshot: undefined,
		refSnapshotInvalidation: undefined,
		tabTarget: undefined,
	});

	const closeThenRecord = SessionPageState.fromBranch([
		toolEntry({ command: "snapshot", refSnapshot: { refIds: ["e1"] }, sessionName: "s1", sessionTabTarget: { url: "https://before.example/" } }),
		toolEntry({
			batchSteps: [
				{ command: ["close"], success: true },
				{ command: ["record", "start", "capture.webm"], success: true },
			],
			command: "batch",
			sessionName: "s1",
		}),
	]);
	assert.equal(closeThenRecord.get("s1").tabTarget, undefined);
	assert.equal(closeThenRecord.get("s1").refSnapshot, undefined);

	const closeThenOpen = SessionPageState.fromBranch([
		toolEntry({ command: "snapshot", refSnapshot: { refIds: ["e1"] }, sessionName: "s1", sessionTabTarget: { url: "https://before.example/" } }),
		toolEntry({
			batchSteps: [
				{ command: ["close"], success: true },
				{ command: ["open", "https://after.example/"], success: true },
			],
			command: "batch",
			sessionName: "s1",
			sessionTabTarget: { url: "https://after.example/" },
		}),
	]);
	assert.deepEqual(closeThenOpen.get("s1").tabTarget, { title: undefined, url: "https://after.example/" });
	assert.equal(closeThenOpen.get("s1").refSnapshot, undefined);

	const closeAll = SessionPageState.fromBranch([
		toolEntry({ command: "snapshot", refSnapshot: { refIds: ["e1"] }, sessionName: "s1", sessionTabTarget: { url: "https://one.example/" } }),
		toolEntry({ command: "snapshot", refSnapshot: { refIds: ["e2"] }, sessionName: "s2", sessionTabTarget: { url: "https://two.example/" } }),
		toolEntry({ command: "snapshot", namespace: "other", refSnapshot: { refIds: ["e3"] }, sessionName: "s3", sessionTabTarget: { url: "https://three.example/" } }),
		toolEntry({ args: ["--session", "s1", "close", "--all"], closeAllApplied: true, command: "close", sessionName: "s1" }),
	]);
	assert.equal(closeAll.get("s1").tabTarget, undefined);
	assert.equal(closeAll.get("s2").tabTarget, undefined);
	assert.deepEqual(closeAll.get(getAgentBrowserSessionIdentityKey("s3", "other")).tabTarget, { title: undefined, url: "https://three.example/" });
});

test("SessionPageState restores unverified page transitions", () => {
	const restored = SessionPageState.fromBranch([
		toolEntry({ command: "snapshot", refSnapshot: { refIds: ["e1"] }, sessionName: "s1", sessionTabTarget: { url: "https://example.com/" } }),
		toolEntry({ command: "connect", refSnapshot: { refIds: ["stale"] }, sessionName: "s1", sessionTabTarget: { url: "https://stale.example/" }, sessionTabTargetUnknown: true }),
	]);
	assert.deepEqual(restored.get("s1"), {
		pinningReason: undefined,
		refSnapshot: undefined,
		refSnapshotInvalidation: undefined,
		tabTargetUnknown: true,
		tabTarget: undefined,
	});

	const recordStart = SessionPageState.fromBranch([
		toolEntry({ command: "snapshot", refSnapshot: { refIds: ["e1"] }, sessionName: "s1", sessionTabTarget: { url: "https://example.com/" } }),
		toolEntry({ command: "record", refSnapshotInvalidation: buildPageTransitionRefSnapshotInvalidation(), sessionName: "s1", sessionTabTargetUnknown: true, subcommand: "start" }),
	]);
	assert.deepEqual(recordStart.get("s1"), {
		pinningReason: undefined,
		refSnapshot: undefined,
		refSnapshotInvalidation: buildPageTransitionRefSnapshotInvalidation(),
		tabTargetUnknown: true,
		tabTarget: undefined,
	});
});

test("SessionPageState clears tab targets, refs, invalidations, and pinning together", () => {
	const state = new SessionPageState();
	const update = state.beginUpdate();
	state.applyTabTarget({ sessionName: "s1", target: { title: "Example", url: "https://example.com/" }, update });
	state.applyRefSnapshot({ sessionName: "s1", snapshot: { refIds: ["e1"] }, update });
	state.markPinning("s1", "drift");

	state.clearSession("s1");
	assert.deepEqual(state.get("s1"), {
		pinningReason: undefined,
		refSnapshot: undefined,
		refSnapshotInvalidation: undefined,
		tabTarget: undefined,
	});
});

test("SessionPageState rejects stale tab and ref updates after a newer token", () => {
	const state = new SessionPageState();
	const older = state.beginUpdate();
	const newer = state.beginUpdate();
	assert.equal(state.applyTabTarget({ sessionName: "s1", target: { url: "https://new.example/" }, update: newer }).applied, true);
	const staleTab = state.applyTabTarget({ sessionName: "s1", target: { url: "https://old.example/" }, update: older });
	assert.deepEqual({ applied: staleTab.applied, stale: staleTab.stale, tabTarget: staleTab.tabTarget }, {
		applied: false,
		stale: true,
		tabTarget: { url: "https://new.example/" },
	});

	assert.equal(state.applyRefSnapshot({ sessionName: "s1", snapshot: { refIds: ["e2"] }, update: newer }).applied, true);
	const staleRefs = state.applyRefSnapshotInvalidation({ invalidation: buildNoActivePageRefSnapshotInvalidation(), sessionName: "s1", update: older });
	assert.equal(staleRefs.applied, false);
	assert.equal(staleRefs.stale, true);
	assert.deepEqual(staleRefs.refSnapshot?.refIds, ["e2"]);
	assert.equal(staleRefs.refSnapshotInvalidation, undefined);
	assert.equal(state.markTabTargetUnknown({ sessionName: "s1", update: older }).applied, false);
	const unknown = state.markTabTargetUnknown({ sessionName: "s1", update: state.beginUpdate() });
	assert.equal(unknown.applied, true);
	assert.equal(unknown.tabTarget, undefined);
	assert.equal(unknown.tabTargetUnknown, true);
	assert.equal(unknown.refSnapshot, undefined);
	const observed = state.applyTabTarget({ sessionName: "s1", target: { url: "https://observed.example/" }, update: state.beginUpdate() });
	assert.equal(observed.tabTargetUnknown, undefined);
	assert.deepEqual(observed.tabTarget, { url: "https://observed.example/" });
});

test("deriveSessionTabTarget discards stale targets after unobserved history navigation", () => {
	const previousTarget = { url: "https://before.example/" };
	for (const command of ["back", "connect", "forward", "reload"]) {
		assert.equal(deriveSessionTabTarget({ command, data: {}, previousTarget }), undefined);
	}
	assert.equal(deriveSessionTabTarget({ command: "state", data: {}, previousTarget, subcommand: "load" }), undefined);
	assert.equal(deriveSessionTabTarget({ command: "tab", data: {}, previousTarget, subcommand: "t2" }), undefined);
	assert.deepEqual(deriveSessionTabTarget({ command: "back", data: {}, navigationSummary: { url: "https://after.example/" }, previousTarget }), { title: undefined, url: "https://after.example/" });
	assert.deepEqual(deriveSessionTabTarget({ command: "click", data: {}, previousTarget }), previousTarget);
	assert.equal(shouldCaptureNavigationSummary("click", { clicked: "#login-button" }), true);
	assert.equal(shouldCaptureNavigationSummary("click", { clicked: ".shopping_cart_link" }), true);
	assert.equal(shouldCaptureNavigationSummary("click", { clicked: "@e1" }), true);
	assert.equal(shouldCaptureNavigationSummary("click", { clicked: "#next", url: "https://after.example/" }), false);
	assert.equal(shouldCaptureNavigationSummary("webmcp", { status: "completed" }, "invoke"), true);
	assert.equal(shouldCaptureNavigationSummary("webmcp", { tools: [] }, "list"), false);
	assert.equal(extractSessionTabTargetFromBatchResults([
		{ command: ["get", "url"], result: { url: "https://before.example/" }, success: true },
		{ command: ["close"], result: {}, success: true },
		{ command: ["record", "start", "capture.webm"], result: { path: "capture.webm" }, success: true },
	]), undefined);
	assert.deepEqual(extractSessionTabTargetFromBatchResults([
		{ command: ["get", "url"], result: { url: "https://before.example/" }, success: true },
		{ command: ["close"], result: {}, success: true },
		{ command: ["open", "https://after.example/"], result: { url: "https://after.example/" }, success: true },
	]), { title: undefined, url: "https://after.example/" });
});

test("extractRefSnapshotFromData preserves editable evidence from snapshot text", () => {
	const snapshot = extractRefSnapshotFromData({
		refs: { e1: { name: "Editor", role: "generic" }, e2: { name: "Disabled", role: "generic" } },
		snapshot: '- generic "Editor" [ref=e1] contenteditable=true\n- generic "Disabled" [ref=e2] contenteditable=false',
		url: "https://example.test/editor",
	});

	assert.deepEqual(snapshot?.refs?.e1, { isContentEditable: true, isEditable: true, name: "Editor", role: "textbox" });
	assert.deepEqual(snapshot?.refs?.e2, { isEditable: false, name: "Disabled", role: "generic" });
});

test("read fetch metadata does not replace the active browser tab target", () => {
	assert.deepEqual(extractSessionTabTargetFromCommandData(["get", "url"], { result: "https://active.example/" }), { title: undefined, url: "https://active.example/" });
	assert.equal(
		extractSessionTabTargetFromCommandData(["read", "https://docs.example.com"], {
			finalUrl: "https://docs.example.com/index.md",
			url: "https://docs.example.com",
		}),
		undefined,
	);
});

test("SessionPageState invalidation replaces snapshots and later snapshots clear invalidations", () => {
	const state = new SessionPageState();
	state.applyRefSnapshot({ sessionName: "s1", snapshot: { refIds: ["e1"] }, update: state.beginUpdate() });
	const invalidated = state.applyRefSnapshotInvalidation({ invalidation: buildNoActivePageRefSnapshotInvalidation(), sessionName: "s1", update: state.beginUpdate() });
	assert.equal(invalidated.refSnapshot, undefined);
	assert.equal(invalidated.refSnapshotInvalidation?.reason, "no-active-page");

	const restored = state.applyRefSnapshot({ sessionName: "s1", snapshot: { refIds: [] }, update: state.beginUpdate() });
	assert.deepEqual(restored.refSnapshot?.refIds, []);
	assert.equal(restored.refSnapshotInvalidation, undefined);
});

test("extractLatestRefSnapshotStateFromBatchResults records empty snapshots and page invalidations", () => {
	assert.deepEqual(
		extractLatestRefSnapshotStateFromBatchResults([
			{ command: ["snapshot", "-i"], result: { refs: {}, title: "Empty", url: "https://example.com/" }, success: true },
		]),
		{ snapshot: { refIds: [], target: { title: "Empty", url: "https://example.com/" } } },
	);
	assert.deepEqual(
		extractLatestRefSnapshotStateFromBatchResults([
			{ command: ["snapshot", "-i"], result: { refs: { e1: {} }, title: "Old", url: "https://example.com/" }, success: true },
			{ command: ["snapshot", "-i"], error: "No active page", success: false },
		]),
		{ invalidation: buildNoActivePageRefSnapshotInvalidation() },
	);
	assert.deepEqual(
		extractLatestRefSnapshotStateFromBatchResults([
			{ command: ["snapshot", "-i"], result: { refs: { e1: {} }, title: "Old", url: "https://example.com/" }, success: true },
			{ command: ["record", "start", "capture.webm"], result: { path: "capture.webm" }, success: true },
		]),
		{ invalidation: buildPageTransitionRefSnapshotInvalidation() },
	);
	assert.deepEqual(
		extractLatestRefSnapshotStateFromBatchResults([
			{ command: ["snapshot", "-i"], result: { refs: { e1: {} }, title: "Old", url: "https://example.com/" }, success: true },
			{ command: ["record", "start", "capture.webm"], error: "Recording already active", success: false },
		]),
		{ invalidation: buildPageTransitionRefSnapshotInvalidation() },
	);
	assert.deepEqual(
		extractLatestRefSnapshotStateFromBatchResults([
			{ command: ["snapshot", "-i"], result: { refs: { e1: {} }, title: "Old", url: "https://example.com/" }, success: true },
			{ command: ["record", "restart", "capture.webm", "https://example.test/"], result: { restarted: true }, success: true },
		]),
		{ invalidation: buildPageTransitionRefSnapshotInvalidation() },
	);
	assert.deepEqual(
		extractLatestRefSnapshotStateFromBatchResults([
			{ command: ["snapshot", "-i"], result: { refs: { e1: {} }, title: "Old", url: "https://example.com/" }, success: true },
			{ command: ["record", "restart", "capture.webm"], result: { restarted: true }, success: true },
		]),
		{ snapshot: { refIds: ["e1"], refs: { e1: { isEditable: false, name: "", role: "unknown" } }, target: { title: "Old", url: "https://example.com/" } } },
	);
	const webMcpInvalidation = extractLatestRefSnapshotStateFromBatchResults([
		{ command: ["snapshot", "-i"], result: { refs: { e1: {} }, title: "Old", url: "https://example.com/" }, success: true },
		{ command: ["webmcp", "invoke", "set_message"], result: { status: "completed" }, success: true },
	]);
	assert.equal(webMcpInvalidation?.invalidation?.reason, "page-transition");
	assert.match(webMcpInvalidation?.invalidation?.summary ?? "", /WebMCP/);
	assert.equal(
		extractLatestRefSnapshotStateFromBatchResults([
			{ command: ["snapshot", "-i"], result: { refs: { e1: {} }, title: "Old", url: "https://example.com/" }, success: true },
			{ command: ["close"], result: {}, success: true },
		]),
		undefined,
	);
	assert.deepEqual(
		extractLatestRefSnapshotStateFromBatchResults([
			{ command: ["snapshot", "-i"], result: { refs: { e1: {} }, title: "Old", url: "https://example.com/" }, success: true },
			{ command: ["close"], result: {}, success: true },
			{ command: ["snapshot", "-i"], result: { refs: { e2: {} }, title: "New", url: "https://example.test/" }, success: true },
		]),
		{ snapshot: { refIds: ["e2"], refs: { e2: { isEditable: false, name: "", role: "unknown" } }, target: { title: "New", url: "https://example.test/" } } },
	);
});
