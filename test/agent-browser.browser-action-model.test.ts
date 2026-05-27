import assert from "node:assert/strict";
import test from "node:test";

import {
	collectBrowserFinalizingActions,
	findBlockedFinalizingAction,
	matchesFinalActionLabel,
	shouldBlockFinalizingAction,
} from "../extensions/agent-browser/lib/orchestration/browser-run/browser-action-model.js";

test("browser action model detects click-like and keyboard-submit finalizing actions", () => {
	const actions = collectBrowserFinalizingActions({
		commandTokens: ["batch"],
		stdin: JSON.stringify([
			["click", "#finish"],
			["press", "Enter"],
			["fill", "#notes", "done"],
		]),
	});
	assert.equal(actions.length, 2);
	assert.equal(actions[0]?.kind, "click-like");
	assert.equal(actions[1]?.kind, "keyboard-submit");
});

test("findBlockedFinalizingAction honors ref snapshot labels for @e refs", () => {
	const blocked = findBlockedFinalizingAction({
		commandTokens: ["click", "@e3"],
		refSnapshot: { refIds: ["e3"], refs: { e3: { role: "button", name: "Finish" } }, target: { url: "https://shop.example/checkout" } },
	});
	assert.equal(blocked?.targetLabel, "button Finish");
	assert.ok(matchesFinalActionLabel(blocked?.targetLabel));
});

test("shouldBlockFinalizingAction blocks Enter and Return keyboard submits without final-action label match", () => {
	const enterAction = collectBrowserFinalizingActions({ commandTokens: ["press", "Enter"] })[0];
	const returnAction = collectBrowserFinalizingActions({ commandTokens: ["key", "Return"] })[0];
	assert.equal(enterAction?.kind, "keyboard-submit");
	assert.equal(returnAction?.kind, "keyboard-submit");
	assert.ok(shouldBlockFinalizingAction(enterAction!));
	assert.ok(shouldBlockFinalizingAction(returnAction!));
	assert.equal(findBlockedFinalizingAction({ commandTokens: ["press", "Enter"] })?.kind, "keyboard-submit");
	assert.equal(findBlockedFinalizingAction({ commandTokens: ["key", "Return"] })?.kind, "keyboard-submit");
});

test("findBlockedFinalizingAction blocks Enter and Return in batch stdin", () => {
	const blockedEnter = findBlockedFinalizingAction({
		commandTokens: ["batch"],
		stdin: JSON.stringify([["fill", "#notes", "done"], ["press", "Enter"]]),
	});
	assert.equal(blockedEnter?.kind, "keyboard-submit");
	assert.equal(blockedEnter?.stepIndex, 1);

	const blockedReturn = findBlockedFinalizingAction({
		commandTokens: ["batch"],
		stdin: JSON.stringify([["fill", "#notes", "done"], ["key", "Return"]]),
	});
	assert.equal(blockedReturn?.kind, "keyboard-submit");
	assert.equal(blockedReturn?.stepIndex, 1);
});

test("findBlockedFinalizingAction ignores non-submit keyboard keys and keyboard type text", () => {
	assert.equal(findBlockedFinalizingAction({ commandTokens: ["press", "Tab"] }), undefined);
	assert.equal(findBlockedFinalizingAction({ commandTokens: ["key", "Escape"] }), undefined);
	assert.equal(findBlockedFinalizingAction({ commandTokens: ["keyboard", "type", "Enter"] }), undefined);
});
