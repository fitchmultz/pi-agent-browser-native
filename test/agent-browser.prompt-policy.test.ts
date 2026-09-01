/**
 * Purpose: Verify prompt-derived policy helpers for the pi-agent-browser extension.
 * Responsibilities: Assert direct agent-browser bash allowance, browser-prompt detection, stop boundaries, and requested artifact extraction.
 * Scope: Unit-style Node test-runner coverage for pure prompt-policy helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { WEB_SEARCH_PROMPT_GUIDELINE } from "../extensions/agent-browser/lib/playbook.js";
import { buildPromptPolicy, getLatestUserPrompt, shouldAppendBrowserSystemPrompt } from "../extensions/agent-browser/lib/prompt-policy.js";

test("buildPromptPolicy and getLatestUserPrompt derive direct agent-browser bash policy from prompt text without globals", () => {
	const prompt = getLatestUserPrompt([
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Not relevant" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Please debug the browser integration via bash." }] } },
	]);
	const policy = buildPromptPolicy(prompt);

	assert.equal(prompt, "Please debug the browser integration via bash.");
	assert.equal(policy.allowLegacyAgentBrowserBash, true);
});

test("buildPromptPolicy does not allow direct agent-browser bash for generic docs prompts unrelated to agent-browser", () => {
	const policy = buildPromptPolicy("Please review the repo docs and summarize the architecture.");

	assert.equal(policy.allowLegacyAgentBrowserBash, false);
});

test("buildPromptPolicy allows explicit tool-specific direct agent-browser bash inspection requests", () => {
	const policy = buildPromptPolicy("Show me the agent-browser docs and explain agent-browser --help output.");

	assert.equal(policy.allowLegacyAgentBrowserBash, true);
});

test("buildPromptPolicy detects requested artifact paths without deriving semantic action blockers", () => {
	const policy = buildPromptPolicy(`Stop on the checkout overview page; do not place the order.
Save a screenshot here: /tmp/pi-smoke/page.png
Save a short screen recording here if recording is available: /tmp/pi-smoke/run.webm`);

	assert.equal("stopBoundary" in policy, false);
	assert.deepEqual(policy.requestedArtifacts, [
		{ kind: "screenshot", path: "/tmp/pi-smoke/page.png", required: true },
		{ kind: "recording", path: "/tmp/pi-smoke/run.webm", required: false },
	]);
});

test("buildPromptPolicy detects relative requested artifact paths", () => {
	const policy = buildPromptPolicy(`Save a screenshot here: ./release-smoke.png
Save another screenshot here: ../artifacts/checkout.webp
Save a screenshot here: final-state.jpg
Save a short screen recording here if recording is available: recordings/run.webm`);

	assert.deepEqual(policy.requestedArtifacts, [
		{ kind: "screenshot", path: "./release-smoke.png", required: true },
		{ kind: "screenshot", path: "../artifacts/checkout.webp", required: true },
		{ kind: "screenshot", path: "final-state.jpg", required: true },
		{ kind: "recording", path: "recordings/run.webm", required: false },
	]);
});

test("buildPromptPolicy keeps recording paths distinct when prompts are collapsed to one line", () => {
	const policy = buildPromptPolicy("Save a screenshot here: /tmp/page.png Save a short screen recording here if recording is available: /tmp/run.webm");

	assert.deepEqual(policy.requestedArtifacts, [
		{ kind: "screenshot", path: "/tmp/page.png", required: true },
		{ kind: "recording", path: "/tmp/run.webm", required: false },
	]);
});

test("buildPromptPolicy does not treat inbound media descriptions as requested output artifacts", () => {
	for (const prompt of [
		"/var/folders/xx/T/pi-clipboard-0d4ba22f-adae-471c-9c31-99186a57e2bc.png",
		"Save a screenshot to /var/folders/xx/T/pi-clipboard-0d4ba22f-adae-471c-9c31-99186a57e2bc.png",
		"/tmp/screenshot.png",
		"/tmp/screen-recording.mp4",
		"Review this screenshot: /tmp/input.png",
		"Analyze this video: /tmp/input.mp4",
		"Save time by reviewing this screenshot: /tmp/input.png",
		"Capture details from this screenshot: /tmp/input.png",
		"Save this screenshot for later: /tmp/input.png",
		"Save a screenshot here and then review this input: /tmp/input.png",
		"Take a screenshot like the reference at /tmp/input.png",
		"No need to save a screenshot at /tmp/input.png",
		"Take this screenshot: /tmp/input.png",
	]) {
		assert.deepEqual(buildPromptPolicy(prompt).requestedArtifacts, []);
	}
});

test("buildPromptPolicy scans large path lists linearly", () => {
	const inbound = Array.from({ length: 10_000 }, (_, index) => `/tmp/input-${index}.png`).join(" ");
	const output = Array.from({ length: 10_000 }, (_, index) => `/tmp/output-${index}.png`).join(", ");

	assert.deepEqual(buildPromptPolicy(`Review these screenshots: ${inbound}`).requestedArtifacts, []);
	assert.equal(buildPromptPolicy(`Capture screenshots at ${output}`).requestedArtifacts.length, 10_000);
	const multilineStartedAt = performance.now();
	const multiline = Array.from({ length: 32_000 }, (_, index) => `- /tmp/multiline-${index}.png`).join("\n");
	assert.equal(buildPromptPolicy(`${"Context ".repeat(2_000)}. Capture screenshots at:\n${multiline}`).requestedArtifacts.length, 32_000);
	const multilineElapsedMs = performance.now() - multilineStartedAt;
	assert.ok(multilineElapsedMs < 500, `multiline path lists should remain linear; took ${multilineElapsedMs.toFixed(1)}ms`);
	const repeatedIntents = Array.from({ length: 4_000 }, (_, index) => `save a screenshot to /tmp/repeated-${index}.png`).join(". ");
	assert.equal(buildPromptPolicy(repeatedIntents).requestedArtifacts.length, 4_000);
	const slashHeavyStartedAt = performance.now();
	assert.deepEqual(buildPromptPolicy(`see a${"/a".repeat(26)}!`).requestedArtifacts, []);
	assert.ok(performance.now() - slashHeavyStartedAt < 500, "slash-heavy non-path token should not trigger pathological backtracking");
});

test("buildPromptPolicy detects requested artifact paths on the following line", () => {
	const policy = buildPromptPolicy("Take a screenshot and save it to:\n/tmp/final.png\nStart a recording at:\n/tmp/run.webm");

	assert.deepEqual(policy.requestedArtifacts, [
		{ kind: "screenshot", path: "/tmp/final.png", required: true },
		{ kind: "recording", path: "/tmp/run.webm", required: true },
	]);
});

test("buildPromptPolicy carries output intent across contiguous artifact path lists", () => {
	const policy = buildPromptPolicy(`Capture screenshots at:
/tmp/first.png
/tmp/second.png
Capture screenshots at:
/tmp/third.png and /tmp/fourth.png
Capture screenshots at /tmp/fifth.png /tmp/sixth.png
Capture screenshots at:
- /tmp/seventh.png
* /tmp/eighth.png
Capture screenshots at:
1. /tmp/ninth.png
2. /tmp/tenth.png`);

	assert.deepEqual(policy.requestedArtifacts, [
		{ kind: "screenshot", path: "/tmp/first.png", required: true },
		{ kind: "screenshot", path: "/tmp/second.png", required: true },
		{ kind: "screenshot", path: "/tmp/third.png", required: true },
		{ kind: "screenshot", path: "/tmp/fourth.png", required: true },
		{ kind: "screenshot", path: "/tmp/fifth.png", required: true },
		{ kind: "screenshot", path: "/tmp/sixth.png", required: true },
		{ kind: "screenshot", path: "/tmp/seventh.png", required: true },
		{ kind: "screenshot", path: "/tmp/eighth.png", required: true },
		{ kind: "screenshot", path: "/tmp/ninth.png", required: true },
		{ kind: "screenshot", path: "/tmp/tenth.png", required: true },
	]);
});

test("buildPromptPolicy scopes optional recording qualifiers to their artifact list", () => {
	const policy = buildPromptPolicy(`Save recordings here if recording is available:
/tmp/optional-first.webm
/tmp/optional-second.webm
Save a recording to /tmp/trailing.webm if recording is available
Save recordings at /tmp/list-first.webm and /tmp/list-second.webm if recordings are available
Save recordings here:
- /tmp/item-qualified-first.webm if recording is available
- /tmp/item-qualified-second.webm
Save recordings here:
- /tmp/following-qualified-first.webm
- /tmp/following-qualified-second.webm
If recording is available.

If recording is available.
Save recordings here:
- /tmp/preceding-qualified-first.webm
- /tmp/preceding-qualified-second.webm
Optionally save a recording to /tmp/explicitly-optional.webm
Save a screenshot to /tmp/optional-screenshot.png if possible
Save a recording to /tmp/required.webm`);

	assert.deepEqual(policy.requestedArtifacts, [
		{ kind: "recording", path: "/tmp/optional-first.webm", required: false },
		{ kind: "recording", path: "/tmp/optional-second.webm", required: false },
		{ kind: "recording", path: "/tmp/trailing.webm", required: false },
		{ kind: "recording", path: "/tmp/list-first.webm", required: false },
		{ kind: "recording", path: "/tmp/list-second.webm", required: false },
		{ kind: "recording", path: "/tmp/item-qualified-first.webm", required: false },
		{ kind: "recording", path: "/tmp/item-qualified-second.webm", required: false },
		{ kind: "recording", path: "/tmp/following-qualified-first.webm", required: false },
		{ kind: "recording", path: "/tmp/following-qualified-second.webm", required: false },
		{ kind: "recording", path: "/tmp/preceding-qualified-first.webm", required: false },
		{ kind: "recording", path: "/tmp/preceding-qualified-second.webm", required: false },
		{ kind: "recording", path: "/tmp/required.webm", required: true },
	]);
});

test("buildPromptPolicy scopes per-path availability and keeps duplicate requirements", () => {
	assert.deepEqual(
		buildPromptPolicy("Save a recording to /tmp/optional-clause.webm if recording is available. Save a recording to /tmp/required-clause.webm").requestedArtifacts,
		[
			{ kind: "recording", path: "/tmp/optional-clause.webm", required: false },
			{ kind: "recording", path: "/tmp/required-clause.webm", required: true },
		],
	);
	assert.deepEqual(
		buildPromptPolicy("Save a recording to /tmp/run.webm if recording is available\nSave a recording to /tmp/run.webm").requestedArtifacts,
		[{ kind: "recording", path: "/tmp/run.webm", required: true }],
	);
});

test("buildPromptPolicy associates output intent with its path and rejects negated intent", () => {
	assert.deepEqual(
		buildPromptPolicy("Review /tmp/input.png and save a screenshot to /tmp/output.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/output.png", required: true }],
	);
	assert.deepEqual(buildPromptPolicy("Do not save this screenshot: /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Do not screenshot the page at /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Do not try to save a screenshot at /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Do not accidentally save a screenshot at /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("I can't save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("I cannot save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("You may not save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("You may save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("You might save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("You are allowed to save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("If you want, save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("The docs say, save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Reference example:\n```text\nSave a screenshot to /tmp/input.png\n```").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Reference example:\n~~~text\nSave a screenshot to /tmp/input.png\n~~~").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("If the page errors, save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("If needed, save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Rather than save a screenshot to /tmp/input.png, continue").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Save a screenshot to /tmp/input.png if desired").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("You should not save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("You should not accidentally save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Don’t save a screenshot to /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(
		buildPromptPolicy("Do not close the browser until you save a screenshot to /tmp/output.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/output.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Don't finish until you save a screenshot to /tmp/finish.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/finish.png", required: true }],
	);
	assert.deepEqual(buildPromptPolicy("Take a look at this screenshot: /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(
		buildPromptPolicy("Take a screenshot of the checkout page. Save it at /tmp/checkout.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/checkout.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Take a screenshot: /tmp/colon.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/colon.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Capture a screenshot directly to /tmp/direct.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/direct.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Screenshot the page at /tmp/checkout.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/checkout.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Take a screenshot of react.dev, save to .dogfood/react.png").requestedArtifacts,
		[{ kind: "screenshot", path: ".dogfood/react.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Do not save the input; instead save a screenshot to /tmp/output.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/output.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Capture screenshots at /tmp/first.png and /tmp/second.png").requestedArtifacts,
		[
			{ kind: "screenshot", path: "/tmp/first.png", required: true },
			{ kind: "screenshot", path: "/tmp/second.png", required: true },
		],
	);
	assert.deepEqual(
		buildPromptPolicy("Save a screenshot to (/tmp/parenthesized.png).").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/parenthesized.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Save a screenshot to [output](/tmp/markdown.png)").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/markdown.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Save a screenshot to /tmp/exclamation.png!").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/exclamation.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Could you save a screenshot to /tmp/question.png?").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/question.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("I need you to save a screenshot to /tmp/needed.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/needed.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Then please save a screenshot to /tmp/then-please.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/then-please.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("And please save a screenshot to /tmp/and-please.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/and-please.png", required: true }],
	);
	assert.deepEqual(
		buildPromptPolicy("Make sure to save a screenshot to /tmp/make-sure.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/make-sure.png", required: true }],
	);
	for (const prompt of [
		"Take the screenshot at /tmp/baseline.png",
		"Take the screenshot at /tmp/baseline.png and compare",
		"Take the screenshot at /tmp/baseline.png, then compare it",
		"Take the screenshot at /tmp/baseline.png; review it",
		"Take the screenshot at /tmp/baseline.png — tell me what is broken",
		"Take the screenshot at /tmp/baseline.png (reference)",
	]) {
		assert.deepEqual(buildPromptPolicy(prompt).requestedArtifacts, []);
	}
	assert.deepEqual(
		buildPromptPolicy("Save a screenshot here:\n/tmp/output.png\n/var/folders/xx/T/pi-clipboard-input.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/output.png", required: true }],
	);
});

test("shouldAppendBrowserSystemPrompt only targets clearly browser-oriented prompts", () => {
	assert.equal(shouldAppendBrowserSystemPrompt("Open https://example.com and take a snapshot."), true);
	assert.equal(shouldAppendBrowserSystemPrompt("Do web research and read the live docs for this API."), true);
	assert.equal(shouldAppendBrowserSystemPrompt("Search online for the current browser automation docs."), true);
	assert.equal(shouldAppendBrowserSystemPrompt("Please review browser compatibility docs."), false);
	assert.equal(shouldAppendBrowserSystemPrompt("Summarize the article at https://example.com/blog/post for the changelog."), false);
	assert.equal(shouldAppendBrowserSystemPrompt("Please review the repository architecture."), false);
});

test("web-search prompt guidance warns about anti-bot search form automation", () => {
	assert.match(WEB_SEARCH_PROMPT_GUIDELINE, /Prefer agent_browser_web_search for current or external web facts/);
	assert.match(WEB_SEARCH_PROMPT_GUIDELINE, /public search-engine forms/);
	assert.match(WEB_SEARCH_PROMPT_GUIDELINE, /anti-bot\/CAPTCHA-gated/);
	assert.match(WEB_SEARCH_PROMPT_GUIDELINE, /searchType: deep-lite/);
	assert.match(WEB_SEARCH_PROMPT_GUIDELINE, /omit it for everyday lookups/);
	assert.match(WEB_SEARCH_PROMPT_GUIDELINE, /after you have a target URL/);
	assert.doesNotMatch(WEB_SEARCH_PROMPT_GUIDELINE, /one query, one follow-up max/);
});
