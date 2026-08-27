/**
 * Purpose: Verify core model-facing tool presentation formatting for agent-browser results.
 * Responsibilities: Assert snapshot, navigation, confirmation, generic redaction, and basic page-change summaries.
 * Scope: Unit-style Node test-runner coverage for `buildToolPresentation`; extension lifecycle presentation integration lives in focused extension suites.
 * Usage: Run with `npx tsx --test test/agent-browser.presentation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use deterministic envelopes and do not launch a browser.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
test("buildToolPresentation rejects a pre-existing artifact that the command did not update", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piab-stale-artifact-"));
	const artifactPath = join(cwd, "screenshot.png");
	try {
		await writeFile(artifactPath, "old screenshot");
		await utimes(artifactPath, new Date(1_000), new Date(1_000));
		const presentation = await buildToolPresentation({
			artifactMinUpdatedAtMs: Date.now(),
			commandInfo: { command: "screenshot", commandTokens: ["screenshot", artifactPath] },
			cwd,
			envelope: { success: true, data: { path: artifactPath } },
		});
		assert.equal(presentation.resultCategory, "failure");
		assert.equal(presentation.failureCategory, "artifact-missing");
		assert.equal(presentation.artifacts?.[0]?.status, "stale");
		assert.equal(presentation.artifactVerification?.artifacts[0]?.state, "unverified");
		assert.match((presentation.content[0] as { text: string }).text, /outside the current command window/);
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("buildToolPresentation rejects future-dated artifacts outside the command window", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piab-future-artifact-"));
	const artifactPath = join(cwd, "screenshot.png");
	try {
		const now = Date.now();
		await writeFile(artifactPath, "future screenshot");
		await utimes(artifactPath, new Date(now + 60_000), new Date(now + 60_000));
		const presentation = await buildToolPresentation({
			artifactMaxUpdatedAtMs: now + 100,
			artifactMinUpdatedAtMs: now,
			commandInfo: { command: "screenshot", commandTokens: ["screenshot", artifactPath] },
			cwd,
			envelope: { success: true, data: { path: artifactPath } },
		});
		assert.equal(presentation.resultCategory, "failure");
		assert.equal(presentation.artifacts?.[0]?.status, "stale");
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("buildToolPresentation tolerates coarse filesystem mtimes near command start", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piab-coarse-artifact-"));
	const artifactPath = join(cwd, "screenshot.png");
	try {
		const now = Date.now();
		await writeFile(artifactPath, "coarse screenshot");
		await utimes(artifactPath, new Date(now - 1_000), new Date(now - 1_000));
		const presentation = await buildToolPresentation({
			artifactMaxUpdatedAtMs: now + 100,
			artifactMinUpdatedAtMs: now,
			commandInfo: { command: "screenshot", commandTokens: ["screenshot", artifactPath] },
			cwd,
			envelope: { success: true, data: { path: artifactPath } },
		});
		assert.equal(presentation.resultCategory, "success");
		assert.equal(presentation.artifacts?.[0]?.status, "saved");
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("buildToolPresentation accepts a completed download that wait began observing after the file arrived", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "piab-wait-download-artifact-"));
	const artifactPath = join(cwd, "download.txt");
	try {
		await writeFile(artifactPath, "completed download");
		await utimes(artifactPath, new Date(1_000), new Date(1_000));
		const presentation = await buildToolPresentation({
			artifactMinUpdatedAtMs: Date.now(),
			commandInfo: { command: "wait", subcommand: "--download", commandTokens: ["wait", "--download", artifactPath] },
			cwd,
			envelope: { success: true, data: { path: artifactPath } },
		});
		assert.equal(presentation.resultCategory, "success");
		assert.equal(presentation.artifacts?.[0]?.status, "saved");
		assert.equal(presentation.artifactVerification?.artifacts[0]?.state, "verified");
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("buildToolPresentation formats snapshot output for the model", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/",
				refs: {
					e1: { name: "Example Domain", role: "heading" },
					e2: { name: "More", role: "link" },
				},
				snapshot: '- heading "Example Domain" [level=1, ref=e1]\n- link "More" [ref=e2]',
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Origin: https:\/\/example.com\//);
	assert.match((presentation.content[0] as { text: string }).text, /Refs: 2/);
	assert.match(presentation.summary, /Snapshot: 2 refs/);
});

test("buildToolPresentation renders agent-readable content before read metadata", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "read", subcommand: "https://example.com/docs" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				content: "# Docs\n\nUse the current API.",
				contentType: "text/markdown",
				finalUrl: "https://example.com/docs.md",
				source: "path-markdown",
				status: 200,
				url: "https://example.com/docs",
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.equal((presentation.content[0] as { text: string }).text, "# Docs\n\nUse the current API.");
	assert.equal(presentation.summary, "Read: https://example.com/docs.md");
	assert.equal(presentation.pageChangeSummary, undefined);
});

test("buildToolPresentation omits page-change summaries for read-only inspection results", async () => {
	const snapshot = await buildToolPresentation({
		commandInfo: { command: "snapshot", subcommand: "-i" },
		cwd: process.cwd(),
		envelope: { success: true, data: { origin: "https://example.com/", snapshot: "- button [ref=e1]" } },
	});
	assert.equal(snapshot.pageChangeSummary, undefined);

	const getTitle = await buildToolPresentation({
		commandInfo: { command: "get", subcommand: "title" },
		cwd: process.cwd(),
		envelope: { success: true, data: { title: "Example Domain" } },
	});
	assert.equal(getTitle.pageChangeSummary, undefined);

	const batch = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: { success: true, data: [
			{ command: ["snapshot", "-i"], result: { origin: "https://example.com/", snapshot: "- button [ref=e1]" }, success: true },
			{ command: ["get", "title"], result: { title: "Example Domain" }, success: true },
		] },
	});
	assert.equal(batch.pageChangeSummary, undefined);
});

test("buildToolPresentation enriches open results with a compact page-change summary", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "open", subcommand: "https://example.com" },
		cwd: process.cwd(),
		envelope: { success: true, data: { title: "Example Domain", url: "https://example.com/" } },
	});

	assert.equal(presentation.pageChangeSummary?.changeType, "navigation");
	assert.equal(presentation.pageChangeSummary?.observed, true);
	assert.equal(presentation.pageChangeSummary?.title, "Example Domain");
	assert.equal(presentation.pageChangeSummary?.url, "https://example.com/");
	assert.deepEqual(presentation.pageChangeSummary?.nextActionIds, ["inspect-opened-page"]);
});

test("buildToolPresentation treats upstream aliases as page-changing commands", async () => {
	for (const command of ["key", "keydown", "keyboard", "keyup", "scrollinto", "tap"] as const) {
		const presentation = await buildToolPresentation({
			commandInfo: { command },
			cwd: process.cwd(),
			envelope: { success: true, data: { ok: true } },
		});

		assert.equal(presentation.nextActions?.[0]?.id, "inspect-after-mutation", command);
		assert.deepEqual(presentation.pageChangeSummary, {
			changeType: "mutation",
			command,
			nextActionIds: ["inspect-after-mutation"],
			observed: false,
			summary: `${command} → action dispatched → application change unverified`,
		}, command);
		assert.match((presentation.content[0] as { text: string }).text, /Action dispatched; application change unverified/, command);
	}
});

test("buildToolPresentation enriches click results with a current-page navigation summary", async () => {
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
					urlChanged: true,
				},
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Clicked: true/);
	assert.match((presentation.content[0] as { text: string }).text, /Href: https:\/\/example.com\/docs/);
	assert.match((presentation.content[0] as { text: string }).text, /Current page:/);
	assert.match((presentation.content[0] as { text: string }).text, /Destination Docs/);
	assert.match((presentation.content[0] as { text: string }).text, /https:\/\/example.com\/docs/);
	assert.match(presentation.summary, /click → Destination Docs/);
	assert.deepEqual(presentation.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);
	assert.deepEqual(presentation.pageChangeSummary, {
		changeType: "navigation",
		command: "click",
		nextActionIds: ["inspect-after-mutation"],
		observed: true,
		summary: "click → navigation → Destination Docs → https://example.com/docs",
		title: "Destination Docs",
		url: "https://example.com/docs",
	});
});

test("buildToolPresentation renders pending confirmations with approve and deny recovery calls", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "click", subcommand: "@e7" },
		cwd: process.cwd(),
		envelope: {
			success: false,
			data: {
				action: "click @e7",
				confirmation_id: "c_8f3a1234",
				confirmation_required: true,
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Confirmation required\./);
	assert.match(text, /Pending confirmation id: c_8f3a1234/);
	assert.match(text, /Action: click @e7/);
	assert.match(text, /\{ "args": \["confirm", "c_8f3a1234"\] \}/);
	assert.match(text, /\{ "args": \["deny", "c_8f3a1234"\] \}/);
	assert.deepEqual(presentation.nextActions?.map((action) => action.params?.args), [["confirm", "c_8f3a1234"], ["deny", "c_8f3a1234"]]);
	assert.equal(presentation.summary, "Confirmation required: c_8f3a1234");
});

test("buildToolPresentation renders nested pending confirmations without stringifying sensitive nested context", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "click", subcommand: "@danger" },
		cwd: process.cwd(),
		envelope: {
			success: false,
			data: {
				context: "https://user:pass@example.com/delete?token=secret Authorization: Bearer raw-token",
				pendingConfirmation: {
					confirmationRequired: true,
					confirmationId: "c_nested",
				},
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Pending confirmation id: c_nested/);
	assert.match(text, /\["confirm", "c_nested"\]/);
	assert.match(text, /\["deny", "c_nested"\]/);
	assert.doesNotMatch(text, /user:pass|raw-token|token=secret/);
	assert.equal(presentation.summary, "Confirmation required: c_nested");
});

test("buildToolPresentation does not classify confirmation-like records without an id", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "click", subcommand: "@e7" },
		cwd: process.cwd(),
		envelope: {
			success: false,
			data: {
				confirmation_required: true,
				message: "confirmation id omitted by upstream",
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.doesNotMatch(text, /Pending confirmation id:/);
	assert.match(text, /confirmation id omitted by upstream/);
	assert.notEqual(presentation.summary, "Confirmation required: undefined");
});

test("buildToolPresentation redacts sensitive generic string summaries", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "eval", subcommand: "--stdin" },
		cwd: process.cwd(),
		envelope: { success: true, data: "Cookie: sid=summary-secret" },
	});

	assert.doesNotMatch(presentation.summary, /summary-secret/);
	assert.match(presentation.summary, /\[REDACTED\]/);

	const urlPresentation = await buildToolPresentation({
		commandInfo: { command: "get", subcommand: "url" },
		cwd: process.cwd(),
		envelope: { success: true, data: "https://example.com/data?key=abc123" },
	});
	assert.doesNotMatch(urlPresentation.summary, /abc123/);
	assert.match(urlPresentation.summary, /\[REDACTED\]|%5BREDACTED%5D/);
});

test("buildToolPresentation redacts structured secrets in generic fallback text", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "eval", subcommand: "--stdin" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				cookie: "sid=secret-cookie",
				message: "Authorization: Bearer raw-token Cookie: sid=raw-cookie https://example.com/?private_key=details-private-secret&ok=1",
				nested: { token: "secret-token", url: "https://example.com/?api_key=secret-key" },
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /\[REDACTED\]/);
	assert.doesNotMatch(text, /secret-cookie|raw-token|raw-cookie|secret-token|secret-key|details-private-secret/);
	assert.doesNotMatch(JSON.stringify(presentation.data), /secret-cookie|raw-token|raw-cookie|secret-token|secret-key|details-private-secret/);
});

test("buildToolPresentation redacts console and page error diagnostics", async () => {
	const consolePresentation = await buildToolPresentation({
		commandInfo: { command: "console" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				messages: [
					{ type: "log", text: 'payload:\n{\n  "outer": { "token":"console-secret" },\n  "ok":true\n}' },
					{ type: "log", text: 'payload: {"message":"Cookie: sid=json-cookie","other":1}' },
				],
			},
		},
	});
	const consoleText = (consolePresentation.content[0] as { text: string }).text;
	assert.doesNotMatch(consoleText, /console-secret|json-cookie/);
	assert.match(consoleText, /\[REDACTED\]/);
	assert.match(consoleText, /other/);

	const errorsPresentation = await buildToolPresentation({
		commandInfo: { command: "errors" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				errors: [{ text: "Cookie: sid=error-secret", url: "https://example.com/app?token=url-secret" }],
			},
		},
	});
	const errorsText = (errorsPresentation.content[0] as { text: string }).text;
	assert.doesNotMatch(errorsText, /error-secret|url-secret/);
	assert.match(errorsText, /\[REDACTED\]/);
});


function presentationText(presentation: Awaited<ReturnType<typeof buildToolPresentation>>): string {
	return presentation.content.map((entry) => ("text" in entry ? entry.text : "")).join("\n");
}

test("buildToolPresentation renders empty page titles instead of dumping raw upstream JSON", async () => {

	const getTitle = await buildToolPresentation({
		commandInfo: { command: "get", subcommand: "title" },
		cwd: process.cwd(),
		envelope: { success: true, data: { lifecycle: { launched: false, reused: true }, title: "" } },
	});
	assert.equal(presentationText(getTitle), "(empty string)");

	const opened = await buildToolPresentation({
		commandInfo: { command: "open", subcommand: "https://shop.example/blank" },
		cwd: process.cwd(),
		envelope: { success: true, data: { lifecycle: { launched: true, reused: false }, title: "", url: "https://shop.example/blank" } },
	});
	assert.equal(presentationText(opened), "https://shop.example/blank");

	const titled = await buildToolPresentation({
		commandInfo: { command: "open", subcommand: "https://shop.example/" },
		cwd: process.cwd(),
		envelope: { success: true, data: { title: "Shop", url: "https://shop.example/" } },
	});
	assert.equal(presentationText(titled), "Shop\nhttps://shop.example/");
});

test("buildToolPresentation renders structured and empty eval results instead of dumping raw upstream JSON", async () => {
	const evalPresentation = async (result: unknown) =>
		buildToolPresentation({
			commandInfo: { command: "eval" },
			cwd: process.cwd(),
			envelope: { success: true, data: { lifecycle: { launched: false, reused: true }, origin: "https://shop.example/", result } },
		});

	assert.equal(presentationText(await evalPresentation([1, 2, 3])), "[\n  1,\n  2,\n  3\n]\n\nOrigin: https://shop.example/");
	assert.equal(presentationText(await evalPresentation({ a: 1 })), '{\n  "a": 1\n}\n\nOrigin: https://shop.example/');
	assert.equal(presentationText(await evalPresentation([])), "[]\n\nOrigin: https://shop.example/");
	assert.equal(presentationText(await evalPresentation(null)), "null\n\nOrigin: https://shop.example/");
	assert.equal(presentationText(await evalPresentation("")), "(empty string)\n\nOrigin: https://shop.example/");
	assert.equal(presentationText(await evalPresentation(0)), "0\n\nOrigin: https://shop.example/");
	assert.equal(presentationText(await evalPresentation(false)), "false\n\nOrigin: https://shop.example/");

	for (const result of [[1, 2, 3], {}, [], null, ""]) {
		assert.doesNotMatch(presentationText(await evalPresentation(result)), /lifecycle/);
	}
});

test("buildToolPresentation keeps upstream lifecycle bookkeeping out of model-facing content", async () => {
	const lifecycle = { effectiveLaunch: { browserLaunched: true, engine: "chrome" }, launched: false, reused: true };

	const box = await buildToolPresentation({
		commandInfo: { command: "get", subcommand: "box" },
		cwd: process.cwd(),
		envelope: { success: true, data: { height: 28, lifecycle, width: 768, x: 256, y: 94 } },
	});
	assert.doesNotMatch(presentationText(box), /lifecycle|browserLaunched/);
	assert.match(presentationText(box), /"height": 28/);

	const checked = await buildToolPresentation({
		commandInfo: { command: "is", subcommand: "checked" },
		cwd: process.cwd(),
		envelope: { success: true, data: { checked: false, lifecycle } },
	});
	assert.doesNotMatch(presentationText(checked), /lifecycle/);
	assert.match(presentationText(checked), /"checked": false/);

	const scroll = await buildToolPresentation({
		commandInfo: { command: "scroll", subcommand: "down" },
		cwd: process.cwd(),
		envelope: { success: true, data: { lifecycle } },
	});
	assert.doesNotMatch(presentationText(scroll), /lifecycle/);
	assert.equal(presentationText(scroll), "scroll completed\n\nAction dispatched; application change unverified. Verify the expected URL, text, state, or external receipt before relying on it.");

	const back = await buildToolPresentation({
		commandInfo: { command: "back" },
		cwd: process.cwd(),
		envelope: { success: true, data: { lifecycle, navigationSummary: { title: "Example Domain", url: "https://example.com/" } } },
	});
	assert.doesNotMatch(presentationText(back), /lifecycle/);
	assert.match(presentationText(back), /https:\/\/example.com\//);
});
