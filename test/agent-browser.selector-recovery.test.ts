/**
 * Purpose: Verify pure selector-miss recovery helpers without spawning agent-browser.
 * Responsibilities: Lock visible-ref fallback matching, rich-input recovery actions, fill-text redaction, and excluded selector shapes.
 * Scope: Unit coverage for extensions/agent-browser/lib/results/selector-recovery.ts; integration probing stays in extension-validation tests.
 * Usage: Run with `npx tsx --test test/agent-browser.selector-recovery.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Fill recovery must focus/click current editable refs only and never echo the intended fill text.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	buildRichInputRecoveryDiagnostic,
	buildRichInputRecoveryNextActions,
	buildVisibleRefFallbackDiagnosticFromSnapshot,
	buildVisibleRefFallbackNextActions,
	formatRichInputRecoveryText,
	formatVisibleRefFallbackText,
	getVisibleRefFallbackTarget,
	resolveVisibleRefActionFromSnapshot,
	sanitizeVisibleRefFallbackDiagnostic,
} from "../extensions/agent-browser/lib/results/selector-recovery.js";

const snapshotData = {
	origin: "https://example.test/form",
	refs: {
		e1: { name: "Email", role: "textbox" },
		e2: { name: "Email", role: "generic" },
		e3: { name: "Submit", role: "button" },
		e4: { name: "Submit", role: "link" },
		e5: { name: "Other email", role: "textbox", disabled: true },
	},
	snapshot: [
		'- textbox "Email" [ref=e1] editable',
		'- generic "Email" [ref=e2] contenteditable=true',
		'- button "Submit" [ref=e3]',
		'- link "Submit" [ref=e4]',
		'- textbox "Other email" [ref=e5] disabled',
	].join("\n"),
};

test("visible ref fallback excludes direct fill args and rich input recovery never echoes fill text", () => {
	const target = getVisibleRefFallbackTarget({ commandTokens: ["find", "label", "Email", "fill", "super-secret"] });
	assert.deepEqual(target, { action: "fill", roles: ["textbox"], targetName: "Email", text: "super-secret" });

	const diagnostic = buildVisibleRefFallbackDiagnosticFromSnapshot({ snapshotData, target: target! });
	assert.equal(diagnostic?.candidates.length, 2);
	assert.deepEqual(diagnostic?.candidates.map((candidate) => candidate.ref), ["@e1", "@e2"]);
	assert.deepEqual(diagnostic?.candidates.map((candidate) => candidate.args), [undefined, undefined]);
	assert.equal(diagnostic?.candidates[1]?.role, "textbox");

	const visibleActions = diagnostic ? buildVisibleRefFallbackNextActions({ diagnostic, sessionName: "s1" }) : [];
	assert.deepEqual(visibleActions, []);

	const publicDiagnostic = diagnostic ? sanitizeVisibleRefFallbackDiagnostic(diagnostic) : undefined;
	assert.equal("editableEvidence" in (publicDiagnostic?.candidates[0] ?? {}), false);
	assert.equal(JSON.stringify(publicDiagnostic).includes("super-secret"), false);

	const richInput = buildRichInputRecoveryDiagnostic(diagnostic);
	assert.deepEqual(richInput?.nextActionIds, [
		"focus-current-editable-ref-1",
		"click-current-editable-ref-1",
		"focus-current-editable-ref-2",
		"click-current-editable-ref-2",
	]);
	const richActions = richInput ? buildRichInputRecoveryNextActions({ diagnostic: richInput, sessionName: "s1" }) : [];
	assert.deepEqual(richActions.map((action) => action.params?.args), [
		["--session", "s1", "focus", "@e1"],
		["--session", "s1", "click", "@e1"],
		["--session", "s1", "focus", "@e2"],
		["--session", "s1", "click", "@e2"],
	]);
	assert.equal(JSON.stringify(richActions).includes("super-secret"), false);
	assert.equal(formatVisibleRefFallbackText(diagnostic)?.includes("super-secret"), false);
	assert.equal(formatRichInputRecoveryText(richInput)?.includes("super-secret"), false);
});

test("visible ref fallback builds direct current-ref actions for non-fill text clicks", () => {
	const target = getVisibleRefFallbackTarget({ commandTokens: ["find", "text", "Submit", "click"] });
	assert.deepEqual(target, { action: "click", roles: ["button", "link"], targetName: "Submit" });

	const diagnostic = buildVisibleRefFallbackDiagnosticFromSnapshot({ snapshotData, target: target! });
	assert.deepEqual(diagnostic?.candidates.map((candidate) => [candidate.ref, candidate.role, candidate.args]), [
		["@e3", "button", ["click", "@e3"]],
		["@e4", "link", ["click", "@e4"]],
	]);
	assert.deepEqual(diagnostic ? buildVisibleRefFallbackNextActions({ diagnostic }).map((action) => action.id) : [], [
		"try-current-visible-ref-1",
		"try-current-visible-ref-2",
	]);
});

test("selector recovery excludes select actions and non-exact names", () => {
	assert.equal(getVisibleRefFallbackTarget({ commandTokens: ["find", "text", "Email", "select", "value"] }), undefined);
	const target = getVisibleRefFallbackTarget({ commandTokens: ["find", "label", "Email address", "fill", "value"] });
	assert.ok(target);
	assert.equal(buildVisibleRefFallbackDiagnosticFromSnapshot({ snapshotData, target: target! }), undefined);
});

test("semantic visible-ref resolution requires exact role/name matches", () => {
	const resolution = resolveVisibleRefActionFromSnapshot({
		compiledAction: {
			action: "click",
			args: ["find", "role", "button", "click", "--name", "Submit"],
			locator: "role",
		},
		snapshotData,
	});
	assert.deepEqual(resolution?.args, ["click", "@e3"]);

	const prefixOnly = resolveVisibleRefActionFromSnapshot({
		compiledAction: {
			action: "click",
			args: ["find", "role", "button", "click", "--name", "Sub"],
			locator: "role",
		},
		snapshotData,
	});
	assert.equal(prefixOnly, undefined);
});

test("semantic fill visible-ref resolution is internal-only and requires one exact editable ref", () => {
	const comboboxSnapshot = {
		origin: "https://example.test/search",
		refs: {
			e17: { name: "Search", role: "combobox" },
		},
		snapshot: '- combobox "Search" [ref=e17]',
	};
	const compiledAction = {
		action: "fill" as const,
		args: ["find", "role", "combobox", "fill", "private search", "--name", "Search"],
		locator: "role" as const,
	};

	assert.equal(resolveVisibleRefActionFromSnapshot({ compiledAction, snapshotData: comboboxSnapshot }), undefined);
	assert.deepEqual(resolveVisibleRefActionFromSnapshot({ allowFill: true, compiledAction, snapshotData: comboboxSnapshot })?.args, ["fill", "@e17", "private search"]);

	const target = getVisibleRefFallbackTarget({ commandTokens: compiledAction.args });
	const diagnostic = buildVisibleRefFallbackDiagnosticFromSnapshot({ snapshotData: comboboxSnapshot, target: target! });
	assert.deepEqual(diagnostic?.candidates.map((candidate) => candidate.args), [undefined]);
	assert.equal(JSON.stringify(sanitizeVisibleRefFallbackDiagnostic(diagnostic!)).includes("private search"), false);

	const ambiguousSnapshot = {
		...comboboxSnapshot,
		refs: {
			e17: { name: "Search", role: "combobox" },
			e18: { name: "Search", role: "combobox" },
		},
		snapshot: '- combobox "Search" [ref=e17]\n- combobox "Search" [ref=e18]',
	};
	assert.equal(resolveVisibleRefActionFromSnapshot({ allowFill: true, compiledAction, snapshotData: ambiguousSnapshot }), undefined);

	const nonEditableSnapshot = {
		...comboboxSnapshot,
		refs: {
			e17: { editable: false, name: "Search", role: "combobox" },
		},
		snapshot: '- combobox "Search" [editable=false, ref=e17]',
	};
	assert.equal(resolveVisibleRefActionFromSnapshot({ allowFill: true, compiledAction, snapshotData: nonEditableSnapshot }), undefined);
});
