/**
 * Purpose: Verify prompt-derived policy helpers for the pi-agent-browser extension.
 * Responsibilities: Assert legacy bash allowance, browser-prompt detection, stop boundaries, and requested artifact extraction.
 * Scope: Unit-style Node test-runner coverage for pure prompt-policy helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { WEB_SEARCH_PROMPT_GUIDELINE } from "../extensions/agent-browser/lib/playbook.js";
import { buildPromptPolicy, getLatestUserPrompt, shouldAppendBrowserSystemPrompt } from "../extensions/agent-browser/lib/prompt-policy.js";

test("buildPromptPolicy and getLatestUserPrompt derive legacy bash policy from prompt text without globals", () => {
	const prompt = getLatestUserPrompt([
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Not relevant" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Please debug the browser integration via bash." }] } },
	]);
	const policy = buildPromptPolicy(prompt);

	assert.equal(prompt, "Please debug the browser integration via bash.");
	assert.equal(policy.allowLegacyAgentBrowserBash, true);
});

test("buildPromptPolicy does not allow legacy bash for generic docs prompts unrelated to agent-browser", () => {
	const policy = buildPromptPolicy("Please review the repo docs and summarize the architecture.");

	assert.equal(policy.allowLegacyAgentBrowserBash, false);
});

test("buildPromptPolicy allows explicit tool-specific legacy bash inspection requests", () => {
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
Capture screenshots at /tmp/fifth.png /tmp/sixth.png`);

	assert.deepEqual(policy.requestedArtifacts, [
		{ kind: "screenshot", path: "/tmp/first.png", required: true },
		{ kind: "screenshot", path: "/tmp/second.png", required: true },
		{ kind: "screenshot", path: "/tmp/third.png", required: true },
		{ kind: "screenshot", path: "/tmp/fourth.png", required: true },
		{ kind: "screenshot", path: "/tmp/fifth.png", required: true },
		{ kind: "screenshot", path: "/tmp/sixth.png", required: true },
	]);
});

test("buildPromptPolicy scopes optional recording qualifiers to their artifact list", () => {
	const policy = buildPromptPolicy(`Save recordings here if recording is available:
/tmp/optional-first.webm
/tmp/optional-second.webm
Save a recording to /tmp/required.webm`);

	assert.deepEqual(policy.requestedArtifacts, [
		{ kind: "recording", path: "/tmp/optional-first.webm", required: false },
		{ kind: "recording", path: "/tmp/optional-second.webm", required: false },
		{ kind: "recording", path: "/tmp/required.webm", required: true },
	]);
});

test("buildPromptPolicy associates output intent with its path and rejects negated intent", () => {
	assert.deepEqual(
		buildPromptPolicy("Review /tmp/input.png and save a screenshot to /tmp/output.png").requestedArtifacts,
		[{ kind: "screenshot", path: "/tmp/output.png", required: true }],
	);
	assert.deepEqual(buildPromptPolicy("Do not save this screenshot: /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Do not screenshot the page at /tmp/input.png").requestedArtifacts, []);
	assert.deepEqual(buildPromptPolicy("Do not try to save a screenshot at /tmp/input.png").requestedArtifacts, []);
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
	assert.match(WEB_SEARCH_PROMPT_GUIDELINE, /public search-engine forms/);
	assert.match(WEB_SEARCH_PROMPT_GUIDELINE, /anti-bot\/CAPTCHA-gated/);
	assert.match(WEB_SEARCH_PROMPT_GUIDELINE, /after you have a target URL/);
});
