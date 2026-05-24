/**
 * Purpose: Lock semanticAction success presentation parity with direct ref commands.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
import {
	formatSemanticActionCompactLine,
	formatSemanticActionPresentationText,
	shouldCaptureSemanticActionNavigationSummary,
} from "../extensions/agent-browser/lib/results/presentation/semantic-action.js";

const semanticClick = {
	action: "click" as const,
	locator: "text" as const,
	args: ["find", "text", "Close", "click"],
};

test("formatSemanticActionCompactLine avoids raw located-selector clicked tokens", () => {
	const line = formatSemanticActionCompactLine(semanticClick);
	assert.match(line, /Clicked: text "Close"/);
	assert.doesNotMatch(line, /data-agent-browser-located/);
});

test("formatSemanticActionPresentationText prefers compact action line over located selector", () => {
	const text = formatSemanticActionPresentationText(semanticClick, {
		clicked: "[data-agent-browser-located='true']",
	});
	assert.match(text ?? "", /Clicked: text "Close"/);
	assert.doesNotMatch(text ?? "", /data-agent-browser-located/);
});

test("shouldCaptureSemanticActionNavigationSummary probes find click without title or url", () => {
	assert.equal(
		shouldCaptureSemanticActionNavigationSummary(semanticClick, { clicked: "[data-agent-browser-located='true']" }),
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
	assert.equal(shouldCaptureSemanticActionNavigationSummary({ ...semanticClick, action: "fill" }, { filled: true }), false);
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
				},
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Clicked: text "Close"/);
	assert.match(text, /Current page:/);
	assert.match(text, /Destination Docs/);
	assert.match(text, /https:\/\/example.com\/docs/);
	assert.match(presentation.summary, /click → Destination Docs/);
	assert.equal(presentation.pageChangeSummary?.changeType, "navigation");
	assert.equal(presentation.pageChangeSummary?.command, "click");
	assert.deepEqual(presentation.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);
});

test("buildToolPresentation preserves direct click presentation", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "click" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				clicked: true,
				href: "https://example.com/docs",
				navigationSummary: {
					title: "Destination Docs",
					url: "https://example.com/docs",
				},
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Clicked: true/);
	assert.match(text, /Href: https:\/\/example.com\/docs/);
	assert.match(text, /Current page:/);
	assert.match(presentation.summary, /click → Destination Docs/);
});
