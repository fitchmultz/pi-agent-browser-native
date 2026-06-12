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
