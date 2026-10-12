/**
 * Purpose: Lock semanticAction success presentation parity with direct ref commands.
 */

import assert from "node:assert/strict";
import { readRecord, readString } from "./helpers/assertions.js";
import test from "node:test";

import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
import { shouldCaptureSemanticActionNavigationSummary } from "../extensions/agent-browser/lib/results/presentation/semantic-action.js";

const semanticClick = {
	action: "click" as const,
	locator: "text" as const,
	args: ["find", "text", "Close", "click"],
};

test("shouldCaptureSemanticActionNavigationSummary probes find click without title or url", () => {
	assert.equal(
		shouldCaptureSemanticActionNavigationSummary(semanticClick, {
			clicked: "[data-agent-browser-located='true']",
		}),
		true,
	);
	assert.equal(
		shouldCaptureSemanticActionNavigationSummary(semanticClick, {
			clicked: true,
			title: "Example",
			url: "https://example.test/",
		}),
		false,
	);
	assert.equal(
		shouldCaptureSemanticActionNavigationSummary(
			{ ...semanticClick, action: "fill" },
			{ filled: true },
		),
		false,
	);
});

test("buildToolPresentation enriches semanticAction find click like direct click", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "find", subcommand: "text" },
		compiledSemanticAction: semanticClick,
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				clicked: "[data-agent-browser-located='true']",
				navigationSummary: {
					title: "Destination Docs",
					url: "https://example.com/docs",
					urlChanged: true,
				},
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = readRecord(presentation.content[0]).text;
	assert.match(readString(text), /Clicked: text "Close"/);
	assert.doesNotMatch(readString(text), /data-agent-browser-located/);
	assert.match(readString(text), /Current page:/);
	assert.match(readString(text), /Destination Docs/);
	assert.match(readString(text), /https:\/\/example.com\/docs/);
	assert.match(presentation.summary, /click → Destination Docs/);
	assert.equal(presentation.pageChangeSummary?.changeType, "navigation");
	assert.equal(presentation.pageChangeSummary.command, "click");
	assert.deepEqual(presentation.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);
});
