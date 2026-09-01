/**
 * Purpose: Lock agent-browser command capability predicates so wrapper behaviors do not drift through broad set reuse.
 * Responsibilities: Assert alias normalization and independent capability dimensions for ref guards, mutation hints, summaries, and session-close behavior.
 * Scope: Unit tests for command-taxonomy.ts only.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	isCloseCommand,
	isOpenNavigationCommand,
	isPageChangeSummaryCommand,
	isPageMutationCommand,
	isRecordPageTransitionCommand,
	isRefGuardedCommand,
	isRefInvalidatingBatchCommand,
	isUnverifiedPageTransitionCommand,
	normalizeCommandName,
} from "../extensions/agent-browser/lib/command-taxonomy.js";

test("command taxonomy normalizes aliases once for capability predicates", () => {
	assert.equal(normalizeCommandName("quit"), "close");
	assert.equal(normalizeCommandName("exit"), "close");
	assert.equal(normalizeCommandName("goto"), "open");
	assert.equal(normalizeCommandName("navigate"), "open");
	assert.equal(normalizeCommandName("key"), "press");
	assert.equal(normalizeCommandName("scrollinto"), "scrollintoview");
	assert.equal(normalizeCommandName("unknown-command"), "unknown-command");

	assert.equal(isCloseCommand("quit"), true);
	assert.equal(isOpenNavigationCommand("navigate"), true);
});

test("command taxonomy keeps independent capability dimensions explicit", () => {
	assert.equal(isRefGuardedCommand("fill"), true);
	assert.equal(isPageMutationCommand("fill"), true);
	assert.equal(isPageChangeSummaryCommand("fill"), true);
	assert.equal(isRefInvalidatingBatchCommand(["fill"]), false);

	assert.equal(isRefGuardedCommand("download"), true);
	assert.equal(isPageMutationCommand("download"), false);
	assert.equal(isPageChangeSummaryCommand("download"), true);
	assert.equal(isRefInvalidatingBatchCommand(["download"]), false);

	assert.equal(isRefGuardedCommand("scrollintoview"), true);
	assert.equal(isPageMutationCommand("scrollintoview"), true);
	assert.equal(isPageChangeSummaryCommand("scrollintoview"), true);
	assert.equal(isRefInvalidatingBatchCommand(["scrollintoview"]), true);
});

test("command taxonomy guards exactly the upstream ref-resolving selector commands", () => {
	// diff guarding is deliberately command-level: diff screenshot resolves refs while diff snapshot's
	// selector is CSS-only, but the wrapper's stale-ref guidance is a clearer failure than upstream's
	// invalid-selector error and subcommand precision buys nothing observable.
	for (const command of ["diff", "frame", "highlight", "is", "screenshot", "scroll"]) {
		assert.equal(isRefGuardedCommand(command), true, command);
	}
	// Upstream passes these selectors/operands through literally and never resolves @e refs for them,
	// so guarding would falsely reject literal tokens such as `wait --text @e1` or `find text @e1 click`.
	for (const command of ["a11y", "find", "wait"]) {
		assert.equal(isRefGuardedCommand(command), false, command);
	}
});

test("WebMCP mutation commands invalidate refs while list remains read-only", () => {
	assert.equal(isPageMutationCommand("webmcp", "list"), false);
	assert.equal(isPageMutationCommand("webmcp", "invoke"), true);
	assert.equal(isPageChangeSummaryCommand("webmcp", "result"), true);
	assert.equal(isUnverifiedPageTransitionCommand("webmcp", "cancel"), true);
	assert.equal(isRefInvalidatingBatchCommand(["webmcp", "list"]), false);
	assert.equal(isRefInvalidatingBatchCommand(["webmcp", "invoke", "set_message"]), true);
});

test("record page transitions cover failed starts and navigating restarts", () => {
	assert.equal(isRecordPageTransitionCommand(["record", "start", "out.webm"]), true);
	assert.equal(isRecordPageTransitionCommand(["record", "restart", "out.webm"]), false);
	assert.equal(isRecordPageTransitionCommand(["record", "restart", "out.webm", "https://example.com"]), true);
	assert.equal(isRecordPageTransitionCommand(["record", "stop"]), false);
	assert.equal(isRefInvalidatingBatchCommand(["record", "start", "out.webm"]), true);
	assert.equal(isRefInvalidatingBatchCommand(["record", "restart", "out.webm"]), false);
	assert.equal(isRefInvalidatingBatchCommand(["record", "restart", "out.webm", "example.com"]), true);
});
