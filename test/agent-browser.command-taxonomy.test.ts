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
	isRefGuardedCommand,
	isRefInvalidatingBatchCommand,
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
	assert.equal(isRefInvalidatingBatchCommand("fill"), false);

	assert.equal(isRefGuardedCommand("download"), true);
	assert.equal(isPageMutationCommand("download"), false);
	assert.equal(isPageChangeSummaryCommand("download"), true);
	assert.equal(isRefInvalidatingBatchCommand("download"), false);

	assert.equal(isRefGuardedCommand("scrollintoview"), true);
	assert.equal(isPageMutationCommand("scrollintoview"), true);
	assert.equal(isPageChangeSummaryCommand("scrollintoview"), true);
	assert.equal(isRefInvalidatingBatchCommand("scrollintoview"), true);
});
