/** Verify upstream capability pass-through and page-target correctness guards. */

import assert from "node:assert/strict";
import test from "node:test";

import { parseBatchCommandArgument } from "../extensions/agent-browser/lib/orchestration/batch-stdin.js";
import {
	commandRequiresLivePageVerification,
	getExplicitSessionPageVerificationRequirement,
	getResultingPageTargetState,
	getPageTargetValidationError,
} from "../extensions/agent-browser/lib/page-target-validation.js";

function validate(args: string[], stdin?: string, currentPageUrl?: string): string | undefined {
	return getPageTargetValidationError({ args, currentPageUrl, stdin });
}

test("upstream state, session, config, file, and browser launch capabilities pass through", () => {
	for (const args of [
		["--session", "piab-foreign", "snapshot", "-i"],
		["--restore", `piab-r2-${"a".repeat(32)}`, "open", "https://example.com"],
		["--state", "/tmp/foreign.json", "open", "https://example.com"],
		["state", "save", "/other/checkout/state.json"],
		["state", "load", "/other/checkout/state.json"],
		["state", "show", "/other/checkout/state.json"],
		["state", "rename", "old", "new"],
		["state", "clear", "--all"],
		["state", "clean", "--older-than", "30"],
		["--config", "/tmp/agent-browser.json", "open", "https://example.com"],
		["--allow-file-access", "true", "open", "file:///tmp/page.html"],
		["--args", "--disable-web-security", "open", "https://example.com"],
		["open", "file:///tmp/.agent-browser/sessions/auth.html"],
		["screenshot", "/tmp/.agent-browser/capture.png"],
	]) assert.equal(validate(args), undefined, args.join(" "));
	assert.equal(validate(["batch"], JSON.stringify([["state", "clear", "--all"], ["state", "save", "/other/checkout/state.json"]])), undefined);
});

test("unverified page transitions still require a live URL before content access", () => {
	assert.equal(getPageTargetValidationError({ args: ["get", "url"], pageUrlUnknown: true }), undefined);
	assert.equal(getPageTargetValidationError({ args: ["tab", "list"], pageUrlUnknown: true }), undefined);
	assert.equal(getPageTargetValidationError({ args: ["tab", "t2"], pageUrlUnknown: true }), undefined);
	assert.match(getPageTargetValidationError({ args: ["snapshot", "-i"], pageUrlUnknown: true }) ?? "", /active page became unverified/);
	assert.equal(getExplicitSessionPageVerificationRequirement({ args: ["--session", "external", "session", "info"] }), undefined);
	assert.match(getExplicitSessionPageVerificationRequirement({ args: ["--session", "external", "snapshot", "-i"] }) ?? "", /active page became unverified/);
});

test("WebMCP page tools require a verified target and may change it", () => {
	assert.match(getExplicitSessionPageVerificationRequirement({ args: ["--session", "external", "webmcp", "list"] }) ?? "", /active page became unverified/);
	assert.match(getExplicitSessionPageVerificationRequirement({ args: ["--session", "external", "webmcp", "invoke", "set_message"] }) ?? "", /active page became unverified/);
	assert.deepEqual(getResultingPageTargetState({ args: ["webmcp", "invoke", "set_message"], currentPageUrl: "https://example.com/start" }), {
		pageTargetMayHaveChanged: true,
		pageUrlUnknown: true,
	});
	assert.equal(getPageTargetValidationError({ args: ["webmcp", "result", "invocation-1"], pageUrlUnknown: true }), undefined);
	assert.equal(getPageTargetValidationError({ args: ["webmcp", "cancel", "invocation-1"], pageUrlUnknown: true }), undefined);
	const batchStdin = JSON.stringify([["webmcp", "invoke", "set_message"], ["get", "url"], ["snapshot", "-i"]]);
	assert.equal(getPageTargetValidationError({ args: ["batch", "--bail"], currentPageUrl: "https://example.com/start", stdin: batchStdin }), undefined);
	assert.match(getPageTargetValidationError({ args: ["batch"], currentPageUrl: "https://example.com/start", stdin: batchStdin }) ?? "", /--bail/);
	assert.deepEqual(getResultingPageTargetState({ args: ["batch", "--bail"], currentPageUrl: "https://example.com/start", stdin: batchStdin }), {
		currentPageUrl: undefined,
		pageTargetMayHaveChanged: true,
		pageUrlUnknown: false,
	});
	assert.match(
		getPageTargetValidationError({
			args: ["batch", "--bail"],
			currentPageUrl: "https://example.com/start",
			stdin: JSON.stringify([["webmcp", "invoke", "set_message"], ["snapshot", "-i"]]),
		}) ?? "",
		/get url/,
	);
});

test("non-bail batches preserve known prior-page behavior and guard unknown targets", () => {
	const stdin = JSON.stringify([["open", "https://safe.example/"], ["get", "html", "body"]]);
	assert.equal(getPageTargetValidationError({ args: ["--session", "external", "batch"], currentPageUrl: "https://initial.example/", stdin }), undefined);
	assert.equal(getPageTargetValidationError({ args: ["--session", "external", "batch", "--bail"], currentPageUrl: "https://initial.example/", stdin }), undefined);

	const bounded = JSON.stringify([
		...Array.from({ length: 10 }, (_value, index) => ["pushstate", `step-${index}/`]),
		["get", "html", "body"],
	]);
	assert.match(getPageTargetValidationError({ args: ["batch"], currentPageUrl: "https://initial.example/start/", stdin: bounded }) ?? "", /--bail/);
});

test("raw batch command arguments exclusively determine validation and resulting targets", () => {
	const ignoredStdin = JSON.stringify([["open", "file:///ignored.html"], ["snapshot", "-i"]]);
	assert.equal(getPageTargetValidationError({ args: ["batch", "get url"], pageUrlUnknown: true, stdin: ignoredStdin }), undefined);
	assert.equal(commandRequiresLivePageVerification(["batch", "get url"], JSON.stringify([["eval", "document.title"]])), false);
	assert.deepEqual(getResultingPageTargetState({
		args: ["batch", "open https://raw.example/"],
		stdin: ignoredStdin,
	}), {
		currentPageUrl: "https://raw.example/",
		pageTargetMayHaveChanged: true,
		pageUrlUnknown: false,
	});
});

test("page-state tracking survives capability pass-through", () => {
	assert.deepEqual(getResultingPageTargetState({ args: ["batch"], stdin: JSON.stringify([["connect", "9222"]]) }), {
		pageTargetMayHaveChanged: true,
		pageUrlUnknown: true,
	});
	assert.deepEqual(getResultingPageTargetState({ args: ["pushstate", "/spa/route"], currentPageUrl: "https://example.com/start" }), {
		currentPageUrl: "https://example.com/spa/route",
		pageTargetMayHaveChanged: true,
		pageUrlUnknown: false,
	});
	assert.deepEqual(getResultingPageTargetState({ args: ["batch"], stdin: JSON.stringify([["connect", "9222"], ["open", "file:///tmp/page.html"]]) }), {
		currentPageUrl: "file:///tmp/page.html",
		pageTargetMayHaveChanged: true,
		pageUrlUnknown: false,
	});
});

test("batch command strings match upstream ASCII-space and quoting rules", () => {
	assert.deepEqual(parseBatchCommandArgument("open https://example.com").step, ["open", "https://example.com"]);
	assert.deepEqual(parseBatchCommandArgument("open\thttps://example.com").step, ["open\thttps://example.com"]);
	assert.deepEqual(parseBatchCommandArgument("open\u00a0https://example.com").step, ["open\u00a0https://example.com"]);
	assert.deepEqual(parseBatchCommandArgument("get text 'main content'").step, ["get", "text", "main content"]);
	assert.deepEqual(parseBatchCommandArgument("type #name Ada\\ Lovelace").step, ["type", "#name", "Ada Lovelace"]);
	assert.match(parseBatchCommandArgument("''").error ?? "", /empty/);
});
