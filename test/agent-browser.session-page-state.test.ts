/**
 * Purpose: Verify the session-page-state owner for tab targets, page-scoped refs, invalidations, and pinning.
 * Responsibilities: Lock restore, ordered update, clear, and batch snapshot extraction behavior outside the extension entrypoint.
 * Scope: Unit tests for `lib/session-page-state.ts`; extension integration stays in tab-recovery and validation suites.
 * Usage: Run with `npx tsx --test test/agent-browser.session-page-state.test.ts` or via targeted PR #48 remediation gates.
 * Invariants/Assumptions: Public state views never expose internal ordering metadata.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	SessionPageState,
	buildNoActivePageRefSnapshotInvalidation,
	extractLatestRefSnapshotStateFromBatchResults,
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

test("SessionPageState.fromBranch restores tab targets, ref snapshots, invalidations, and restore pinning", () => {
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

test("extractLatestRefSnapshotStateFromBatchResults records empty snapshots and no-active-page invalidations", () => {
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
});
