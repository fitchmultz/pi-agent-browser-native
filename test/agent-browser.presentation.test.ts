/**
 * Purpose: Verify model-facing tool presentation formatting for agent-browser results.
 * Responsibilities: Assert snapshot compaction, scalar extraction, download summaries, batch rendering, inline screenshot handling, persisted spills, and temp-budget degradation.
 * Scope: Unit-style Node test-runner coverage for `buildToolPresentation`; extension lifecycle presentation integration lives in focused extension suites.
 * Usage: Run with `npm test -- test/agent-browser.presentation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests isolate temp artifacts and preserve existing cleanup for secure temp roots.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
	buildToolPresentation
} from "../extensions/agent-browser/lib/results.js";
import {
	DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES,
	getSessionArtifactManifestMaxEntries,
	mergeSessionArtifactManifest,
	type SessionArtifactManifestEntry,
} from "../extensions/agent-browser/lib/results/shared.js";
import {
	cleanupSecureTempArtifacts
} from "../extensions/agent-browser/lib/temp.js";
import {
	TEST_SESSION_ID,
	withPatchedEnv
} from "./helpers/agent-browser-harness.js";

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

test("buildToolPresentation appends stale-ref recovery guidance to direct command failures", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "click", subcommand: "@zzz" },
		cwd: process.cwd(),
		errorText: "Unknown ref: zzz",
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /^Unknown ref: zzz/);
	assert.match(text, /snapshot -i/);
	assert.match(text, /find role\|text\|label/);
	assert.match(text, /scrollintoview/);
	assert.equal(presentation.summary, text);
});

test("buildToolPresentation appends selector-dialect guidance to unsupported selector failures", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "click", subcommand: "button:has-text('Close')" },
		cwd: process.cwd(),
		errorText: "Failed to parse selector: button:has-text('Close')",
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /^Failed to parse selector: button:has-text\('Close'\)/);
	assert.match(text, /unsupported selector dialect/i);
	assert.match(text, /snapshot -i/);
	assert.match(text, /find role\|text\|label/);
	assert.match(text, /scrollintoview/);
	assert.equal(presentation.summary, text);
});

test("buildToolPresentation appends selector-dialect guidance to Playwright-style selector match failures", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "click", subcommand: "text=Close" },
		cwd: process.cwd(),
		errorText: "No elements found for selector: text=Close",
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /^No elements found for selector: text=Close/);
	assert.match(text, /unsupported selector dialect/i);
	assert.match(text, /snapshot -i/);
	assert.match(text, /find role\|text\|label/);
	assert.match(text, /scrollintoview/);
});

test("buildToolPresentation does not append selector guidance to unrelated errors", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "open", subcommand: "https://example.com" },
		cwd: process.cwd(),
		errorText: "Navigation failed: net::ERR_BLOCKED_BY_CLIENT",
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.equal((presentation.content[0] as { text: string }).text, "Navigation failed: net::ERR_BLOCKED_BY_CLIENT");
	assert.equal(presentation.summary, "Navigation failed: net::ERR_BLOCKED_BY_CLIENT");
});

test("buildToolPresentation does not append selector guidance to non-dialect selector-token errors", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "click", subcommand: "button" },
		cwd: process.cwd(),
		errorText: "Element not visible: getByRole('button', { name: 'Submit' })",
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.equal(
		(presentation.content[0] as { text: string }).text,
		"Element not visible: getByRole('button', { name: 'Submit' })",
	);
	assert.equal(presentation.summary, "Element not visible: getByRole('button', { name: 'Submit' })");
});

test("buildToolPresentation formats scalar extraction results for eval and get commands", async () => {
	const evalPresentation = await buildToolPresentation({
		commandInfo: { command: "eval", subcommand: "--stdin" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/",
				result: "Example Domain",
			},
		},
	});
	assert.equal(evalPresentation.content[0]?.type, "text");
	assert.equal((evalPresentation.content[0] as { text: string }).text, "Example Domain\n\nOrigin: https://example.com/");
	assert.equal(evalPresentation.summary, "Eval result: Example Domain");

	const getPresentation = await buildToolPresentation({
		commandInfo: { command: "get", subcommand: "title" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/",
				result: "Example Domain",
			},
		},
	});
	assert.equal(getPresentation.content[0]?.type, "text");
	assert.equal((getPresentation.content[0] as { text: string }).text, "Example Domain\n\nOrigin: https://example.com/");
	assert.equal(getPresentation.summary, "Title: Example Domain");
});

test("buildToolPresentation formats session status and session list", async () => {
	const current = await buildToolPresentation({
		commandInfo: { command: "session" },
		cwd: process.cwd(),
		envelope: { success: true, data: { session: "demo-session" } },
	});
	assert.equal(current.summary, "Session: demo-session");
	assert.equal((current.content[0] as { text: string }).text, "Current session: demo-session");

	const list = await buildToolPresentation({
		commandInfo: { command: "session", subcommand: "list" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				sessions: [{ active: true, name: "work", title: "Example", url: "https://example.com" }],
			},
		},
	});
	assert.equal(list.summary, "Sessions: 1");
	assert.equal((list.content[0] as { text: string }).text, "1. work *active* — https://example.com — Example");
});

test("buildToolPresentation formats Chrome profile arrays", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "profiles" },
		cwd: process.cwd(),
		envelope: { success: true, data: [{ directory: "Default", name: "Default" }] },
	});

	assert.equal(presentation.summary, "Chrome profiles: 1");
	assert.equal((presentation.content[0] as { text: string }).text, "1. Default (Default)");
});

test("buildToolPresentation formats auth profile lists and show output without expanding secrets", async () => {
	const list = await buildToolPresentation({
		commandInfo: { command: "auth", subcommand: "list" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: { profiles: [{ name: "prod", password: "secret", username: "user@example.com" }] },
		},
	});
	assert.equal(list.summary, "Auth profiles: 1");
	const listText = (list.content[0] as { text: string }).text;
	assert.match(listText, /prod/);
	assert.doesNotMatch(listText, /secret|password/);

	const show = await buildToolPresentation({
		commandInfo: { command: "auth", subcommand: "show" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: { name: "prod", password: "secret", token: "bearer-token", url: "https://example.com", username: "user@example.com" },
		},
	});
	assert.equal(show.summary, "Auth profile: prod");
	const showText = (show.content[0] as { text: string }).text;
	assert.match(showText, /name: prod/);
	assert.match(showText, /url: https:\/\/example.com/);
	assert.match(showText, /username: user@example.com/);
	assert.doesNotMatch(showText, /secret|password|bearer-token|token/);
});

test("buildToolPresentation formats redacted network payload, response, and error previews", async () => {
	const longResponse = `{"items":["${"x".repeat(400)}"],"token":"response-secret"}`;
	const presentation = await buildToolPresentation({
		commandInfo: { command: "network", subcommand: "requests" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				requests: [
					{ headers: { "User-Agent": "secret-agent" }, method: "GET", requestId: "req-1", resourceType: "Document", status: 200, url: "https://example.com/" },
					{
						error: "net::ERR_FAILED Authorization: Bearer error-secret",
						method: "POST",
						postData: { name: "demo", token: "body-secret", url: "https://api.example.test/callback?token=nested-url-secret" },
						requestId: "req-2",
						resourceType: "Fetch",
						responseBody: longResponse,
						responseHeaders: { "Set-Cookie": "session=header-secret" },
						status: 201,
						url: "https://api.example.test/items?token=url-secret",
					},
				],
			},
		},
	});

	assert.equal(presentation.summary, "Network requests: 2");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /1\. 200 GET https:\/\/example.com\/ \(Document\) \[req-1\]/);
	assert.match(text, /2\. 201 POST https:\/\/api\.example\.test\/items\?token=%5BREDACTED%5D \(Fetch\) \[req-2\]/);
	assert.match(text, /Payload: .*name.*demo/);
	assert.match(text, /Payload: .*\[REDACTED\]/);
	assert.match(text, /Payload: .*https:\/\/api\.example\.test\/callback\?token=%5BREDACTED%5D/);
	assert.match(text, /Response: /);
	assert.match(text, /Response: .*…/);
	assert.match(text, /Error: net::ERR_FAILED Authorization: Bearer \[REDACTED\]/);
	assert.doesNotMatch(text, /User-Agent|secret-agent|body-secret|response-secret|header-secret|url-secret|nested-url-secret|error-secret|Set-Cookie/);
});

test("buildToolPresentation formats singular network request details without expanding headers", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "network", subcommand: "request" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				headers: { Authorization: "Bearer header-secret" },
				method: "POST",
				mimeType: "application/json",
				postData: "{\"name\":\"demo\",\"token\":\"payload-secret\"}",
				requestId: "detail-1",
				resourceType: "Fetch",
				responseBody: "{\"ok\":true,\"secret\":\"response-secret\"}",
				responseHeaders: { "Set-Cookie": "session=header-secret" },
				status: 200,
				url: "https://api.example.test/items?token=url-secret",
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /1\. 200 POST https:\/\/api\.example\.test\/items\?token=%5BREDACTED%5D \(Fetch\) \[detail-1\]/);
	assert.match(text, /Payload: .*\[REDACTED\]/);
	assert.match(text, /Response: .*\[REDACTED\]/);
	assert.doesNotMatch(text, /Authorization|Set-Cookie|header-secret|payload-secret|response-secret|url-secret/);
});

test("buildToolPresentation formats console and errors previews", async () => {
	const consolePresentation = await buildToolPresentation({
		commandInfo: { command: "console" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: { messages: [{ args: [{ secret: true }], text: "hello", type: "log" }, { text: "boom", type: "error" }] },
		},
	});
	assert.equal(consolePresentation.summary, "Console messages: 2");
	const consoleText = (consolePresentation.content[0] as { text: string }).text;
	assert.match(consoleText, /\[log\] hello/);
	assert.match(consoleText, /\[error\] boom/);
	assert.doesNotMatch(consoleText, /secret|args/);

	const errorsPresentation = await buildToolPresentation({
		commandInfo: { command: "errors" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: { errors: [{ column: 5, line: 10, text: "Error: delayed\n    at stack", url: "https://example.com/app.js" }] },
		},
	});
	assert.equal(errorsPresentation.summary, "Page errors: 1");
	assert.equal(
		(errorsPresentation.content[0] as { text: string }).text,
		"1. Error: delayed (https://example.com/app.js:line 10:column 5)",
	);
});

test("buildToolPresentation formats dashboard and doctor status", async () => {
	const dashboard = await buildToolPresentation({
		commandInfo: { command: "dashboard", subcommand: "start" },
		cwd: process.cwd(),
		envelope: { success: true, data: { pid: 123, port: 4848 } },
	});
	assert.equal(dashboard.summary, "Dashboard running on port 4848");
	assert.equal((dashboard.content[0] as { text: string }).text, "Port: 4848\nPID: 123");

	const stopped = await buildToolPresentation({
		commandInfo: { command: "dashboard", subcommand: "stop" },
		cwd: process.cwd(),
		envelope: { success: true, data: { reason: "not running", stopped: false } },
	});
	assert.equal(stopped.summary, "Dashboard not stopped: not running");
	assert.match((stopped.content[0] as { text: string }).text, /Reason: not running/);

	const doctor = await buildToolPresentation({
		commandInfo: { command: "doctor" },
		cwd: process.cwd(),
		envelope: { success: true, data: { checks: [{ name: "binary" }], environment: { token: "secret" }, status: "ok" } },
	});
	assert.equal(doctor.summary, "Doctor: ok");
	assert.equal((doctor.content[0] as { text: string }).text, "Status: ok\nchecks: 1");
});

test("buildToolPresentation compacts large diagnostic output and preserves spill path", async () => {
	const messages = Array.from({ length: 180 }, (_, index) => ({ text: `diagnostic console row ${index + 1} ${"x".repeat(120)}`, type: "log" }));
	const presentation = await buildToolPresentation({
		commandInfo: { command: "console" },
		cwd: process.cwd(),
		envelope: { success: true, data: { messages } },
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Large console output compacted/);
	assert.match(text, /Full output path: /);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal((presentation.data as { compacted: boolean }).compacted, true);

	const spillPath = presentation.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(await readFile(String(spillPath), "utf8"), /diagnostic console row 180/);
	await rm(String(spillPath), { force: true });
});

test("buildToolPresentation formats download results as saved-file summaries", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "download", subcommand: "@e5" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				path: "/tmp/report.pdf",
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Downloaded file: \/tmp\/report\.pdf/);
	assert.match((presentation.content[0] as { text: string }).text, /application\/pdf/);
	assert.match((presentation.content[0] as { text: string }).text, /not found on disk/);
	assert.equal(presentation.summary, "Downloaded file: /tmp/report.pdf");
	assert.equal(presentation.artifacts?.[0]?.kind, "download");
	assert.equal(presentation.artifacts?.[0]?.path, "/tmp/report.pdf");
	assert.equal(presentation.artifacts?.[0]?.absolutePath, "/tmp/report.pdf");
	assert.equal(presentation.artifacts?.[0]?.mediaType, "application/pdf");
	assert.equal(presentation.artifacts?.[0]?.exists, false);
	assert.equal(presentation.savedFilePath, "/tmp/report.pdf");
	assert.deepEqual(presentation.savedFile, {
		command: "download",
		kind: "download",
		path: "/tmp/report.pdf",
		subcommand: "@e5",
	});
});

test("buildToolPresentation renders metadata-first summaries for file artifact commands", async () => {
	const cases = [
		{
			commandInfo: { command: "pdf" },
			data: { path: "page.pdf" },
			expectedKind: "pdf",
			expectedMediaType: "application/pdf",
			expectedText: "Saved PDF: page.pdf",
		},
		{
			commandInfo: { command: "wait", subcommand: "--download" },
			data: { path: "download.txt" },
			expectedKind: "download",
			expectedMediaType: "text/plain",
			expectedText: "Download completed: download.txt",
		},
		{
			commandInfo: { command: "trace", subcommand: "stop" },
			data: { eventCount: 382, path: "trace.zip" },
			expectedKind: "trace",
			expectedMediaType: "application/zip",
			expectedText: "Saved trace: trace.zip",
		},
		{
			commandInfo: { command: "profiler", subcommand: "stop" },
			data: { eventCount: 350, path: "profile.cpuprofile" },
			expectedKind: "profile",
			expectedMediaType: "application/json",
			expectedText: "Saved profile: profile.cpuprofile",
		},
		{
			commandInfo: { command: "record", subcommand: "stop" },
			data: { frames: 6, path: "recording.webm" },
			expectedKind: "video",
			expectedMediaType: "video/webm",
			expectedText: "Saved recording: recording.webm",
		},
		{
			commandInfo: { command: "network", subcommand: "har" },
			data: { path: "network.har", requestCount: 0 },
			expectedKind: "har",
			expectedMediaType: "application/json",
			expectedText: "Saved HAR: network.har",
		},
	] as const;

	for (const item of cases) {
		const presentation = await buildToolPresentation({
			commandInfo: item.commandInfo,
			cwd: "/tmp/pi-agent-browser-artifact-tests",
			envelope: { success: true, data: item.data },
		});

		assert.equal(presentation.content[0]?.type, "text");
		assert.match((presentation.content[0] as { text: string }).text, new RegExp(item.expectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(presentation.summary, item.expectedText);
		assert.equal(presentation.artifacts?.length, 1);
		assert.equal(presentation.artifacts?.[0]?.kind, item.expectedKind);
		assert.equal(presentation.artifacts?.[0]?.path, item.data.path);
		assert.equal(presentation.artifacts?.[0]?.absolutePath, join("/tmp/pi-agent-browser-artifact-tests", item.data.path));
		assert.equal(presentation.artifacts?.[0]?.mediaType, item.expectedMediaType);
		assert.equal(presentation.artifacts?.[0]?.exists, false);
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
		if (item.commandInfo.command === "pdf") {
			assert.equal(presentation.savedFilePath, "page.pdf");
			assert.equal(presentation.savedFile?.kind, "pdf");
		}
		if (item.commandInfo.command === "wait") {
			assert.equal(presentation.savedFilePath, "download.txt");
			assert.deepEqual(presentation.savedFile, {
				command: "wait",
				kind: "download",
				path: "download.txt",
				subcommand: "--download",
			});
		}
	}
});

test("buildToolPresentation records explicit saved files in the bounded session artifact manifest", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-explicit-manifest-"));
	const downloadPath = join(tempDir, "download.txt");
	await writeFile(downloadPath, "manifest download");
	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "download" },
			cwd: tempDir,
			envelope: { success: true, data: { path: "download.txt" } },
		});

		assert.equal(presentation.artifactManifest?.version, 1);
		assert.equal(presentation.artifactManifest?.liveCount, 1);
		assert.equal(presentation.artifactManifest?.evictedCount, 0);
		assert.equal(presentation.artifactManifest?.entries[0]?.path, "download.txt");
		assert.equal(presentation.artifactManifest?.entries[0]?.absolutePath, downloadPath);
		assert.equal(presentation.artifactManifest?.entries[0]?.kind, "download");
		assert.equal(presentation.artifactManifest?.entries[0]?.storageScope, "explicit-path");
		assert.equal(presentation.artifactManifest?.entries[0]?.retentionState, "live");
		assert.match(presentation.artifactRetentionSummary ?? "", /1 live, 0 evicted/);
		assert.match((presentation.content[0] as { text: string }).text, /Session artifacts: 1 live, 0 evicted/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("artifact manifest defaults to a QA-friendly recent window", () => {
	assert.equal(getSessionArtifactManifestMaxEntries({}), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	assert.equal(DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES, 100);
});

test("artifact manifest recent window is configurable and ignores invalid values", async () => {
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), 3);
	});
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "0" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	});
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "-1" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	});
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3.5" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	});
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "not-a-number" }, async () => {
		assert.equal(getSessionArtifactManifestMaxEntries(), DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES);
	});
});

test("artifact manifest evicts oldest metadata entries at the configured recent window", async () => {
	const entries: SessionArtifactManifestEntry[] = Array.from({ length: 5 }, (_, index) => ({
		createdAtMs: 1_000 + index,
		kind: "image",
		path: `screenshot-${index + 1}.png`,
		retentionState: "live",
		storageScope: "explicit-path",
	}));

	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3" }, async () => {
		const manifest = mergeSessionArtifactManifest({ entries, nowMs: 2_000 });
		assert.equal(manifest?.maxEntries, 3);
		assert.deepEqual(
			manifest?.entries.map((entry) => entry.path),
			["screenshot-5.png", "screenshot-4.png", "screenshot-3.png"],
		);
		assert.equal(manifest?.liveCount, 3);
		assert.equal(manifest?.evictedCount, 0);
	});
});

test("buildToolPresentation reports the configured artifact manifest recent window", async () => {
	await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "3" }, async () => {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "screenshot" },
			cwd: process.cwd(),
			envelope: { success: true, data: { path: "dogfood-shot.png" } },
		});

		assert.equal(presentation.artifactManifest?.maxEntries, 3);
		assert.match(presentation.artifactRetentionSummary ?? "", /\(1\/3 recent\)/);
		assert.match((presentation.content[0] as { text: string }).text, /Session artifacts: .*\(1\/3 recent\)/);
	});
});

test("buildToolPresentation compacts oversized generic outputs and prints the actual spill path", async () => {
	const largeText = Array.from({ length: 220 }, (_, index) => `Large eval row ${index + 1}: ${"x".repeat(80)}`).join("\n");
	const presentation = await buildToolPresentation({
		commandInfo: { command: "eval", subcommand: "--stdin" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/large-eval",
				result: largeText,
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Large eval output compacted/);
	assert.match(text, /Full output path: /);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal((presentation.data as { compacted: boolean }).compacted, true);

	const spillPath = presentation.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(await readFile(String(spillPath), "utf8"), /Large eval row 220/);
	await rm(String(spillPath), { force: true });
});

test("buildToolPresentation formats batch output for the model", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{ command: ["open", "https://developer.mozilla.org"], success: true, result: { title: "MDN Web Docs" } },
				{ command: ["get", "title"], success: true, result: { title: "MDN Web Docs" } },
			],
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Step 1 — open https:\/\/developer.mozilla.org/);
	assert.match((presentation.content[0] as { text: string }).text, /MDN Web Docs/);
	assert.equal(Array.isArray(presentation.data), true);
	assert.equal(presentation.batchSteps?.length, 2);
	assert.equal(presentation.batchSteps?.[0]?.commandText, "open https://developer.mozilla.org");
	assert.match(presentation.summary, /Batch: 2\/2 succeeded/);
});

test("buildToolPresentation preserves partial batch results when a later step fails", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: false,
			data: [
				{ command: ["open", "https://example.com"], success: true, result: { title: "Example Domain", url: "https://example.com/" } },
				{ command: ["click", "@zzz"], success: false, error: "Unknown ref: zzz" },
			],
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	assert.match((presentation.content[0] as { text: string }).text, /Batch failed: 1\/2 succeeded/);
	assert.match((presentation.content[0] as { text: string }).text, /First failing step: 2 — click @zzz/);
	assert.match((presentation.content[0] as { text: string }).text, /Step 1 — open https:\/\/example.com \(succeeded\)/);
	assert.match((presentation.content[0] as { text: string }).text, /Example Domain/);
	assert.match((presentation.content[0] as { text: string }).text, /Step 2 — click @zzz \(failed\)/);
	assert.match((presentation.content[0] as { text: string }).text, /Error: Unknown ref: zzz/);
	assert.match((presentation.content[0] as { text: string }).text, /snapshot -i/);
	assert.match((presentation.content[0] as { text: string }).text, /find role\|text\|label/);
	assert.match((presentation.content[0] as { text: string }).text, /scrollintoview/);
	assert.equal(presentation.batchFailure?.failedStep.index, 1);
	assert.equal(presentation.batchFailure?.failedStep.commandText, "click @zzz");
	assert.equal(presentation.batchFailure?.failureCount, 1);
	assert.equal(presentation.batchFailure?.successCount, 1);
	assert.equal(presentation.batchFailure?.totalCount, 2);
	assert.match(presentation.summary, /Batch failed: 1\/2 succeeded/);
});

test("buildToolPresentation keeps eval image-like string results text-only", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-untrusted-image-"));
	const imagePath = join(tempDir, "secret.png");
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "eval", subcommand: "--stdin" },
			cwd: tempDir,
			envelope: { success: true, data: "secret.png" },
		});

		assert.equal(presentation.content.length, 1);
		assert.equal(presentation.content[0]?.type, "text");
		assert.equal((presentation.content[0] as { text: string }).text, "secret.png");
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation keeps non-artifact path-like scalar results text-only", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "eval", subcommand: "--stdin" },
		cwd: process.cwd(),
		envelope: { success: true, data: "/tmp/debug.har" },
	});

	assert.equal(presentation.content.length, 1);
	assert.equal(presentation.content[0]?.type, "text");
	assert.equal((presentation.content[0] as { text: string }).text, "/tmp/debug.har");
	assert.equal(presentation.artifacts, undefined);
	assert.equal(presentation.imagePath, undefined);
	assert.equal(presentation.imagePaths, undefined);
});

test("buildToolPresentation keeps get absolute image path results text-only", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-untrusted-absolute-image-"));
	const imagePath = join(tempDir, "secret.jpg");
	await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "get", subcommand: "text" },
			cwd: process.cwd(),
			envelope: { success: true, data: imagePath },
		});

		assert.equal(presentation.content.length, 1);
		assert.equal(presentation.content[0]?.type, "text");
		assert.equal((presentation.content[0] as { text: string }).text, imagePath);
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation does not inline non-screenshot path records with image extensions", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-download-image-"));
	const imagePath = join(tempDir, "downloaded.png");
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "download", subcommand: "@e5" },
			cwd: tempDir,
			envelope: { success: true, data: { path: "downloaded.png" } },
		});

		assert.equal(presentation.content.length, 1);
		assert.equal(presentation.content[0]?.type, "text");
		assert.match((presentation.content[0] as { text: string }).text, /Downloaded file: downloaded\.png/);
		assert.match((presentation.content[0] as { text: string }).text, /image\/png/);
		assert.equal(presentation.summary, "Downloaded file: downloaded.png");
		assert.equal(presentation.artifacts?.[0]?.kind, "download");
		assert.equal(presentation.artifacts?.[0]?.path, "downloaded.png");
		assert.equal(presentation.artifacts?.[0]?.absolutePath, imagePath);
		assert.equal(presentation.artifacts?.[0]?.mediaType, "image/png");
		assert.equal(presentation.artifacts?.[0]?.exists, true);
		assert.equal(presentation.artifacts?.[0]?.sizeBytes, 4);
		assert.equal(presentation.imagePath, undefined);
		assert.equal(presentation.imagePaths, undefined);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation preserves wait --download saved-file metadata inside batch output", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{ command: ["click", "#export"], result: { clicked: true }, success: true },
				{ command: ["wait", "--download", "/tmp/export.csv"], result: { path: "/tmp/export.csv", elapsedMs: 75 }, success: true },
			],
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Step 1 — click #export/);
	assert.match(text, /Step 2 — wait --download \/tmp\/export\.csv/);
	assert.match(text, /Download completed: \/tmp\/export\.csv/);
	assert.equal(presentation.batchSteps?.[1]?.artifacts?.[0]?.kind, "download");
	assert.equal(presentation.batchSteps?.[1]?.savedFilePath, "/tmp/export.csv");
	assert.deepEqual(presentation.batchSteps?.[1]?.savedFile, {
		command: "wait",
		kind: "download",
		metadata: { elapsedMs: 75 },
		path: "/tmp/export.csv",
		subcommand: "--download",
	});
});

test("buildToolPresentation reuses standalone inline screenshot rendering inside batch output", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-image-"));
	const imagePath = join(tempDir, "batched.png");
	await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "batch" },
			cwd: tempDir,
			envelope: {
				success: true,
				data: [
					{
						command: ["open", "https://example.com"],
						result: { title: "Example Domain", url: "https://example.com/" },
						success: true,
					},
					{ command: ["screenshot"], result: { path: "batched.png" }, success: true },
				],
			},
		});

		const text = (presentation.content[0] as { text: string }).text;
		assert.match(text, /Step 1 — open https:\/\/example.com/);
		assert.match(text, /Example Domain/);
		assert.match(text, /Step 2 — screenshot/);
		assert.match(text, /Saved image: batched.png/);
		assert.match(text, /1 inline image attachment below/);
		assert.equal(presentation.content[1]?.type, "image");
		assert.equal(presentation.imagePath, imagePath);
		assert.deepEqual(presentation.imagePaths, [imagePath]);
		assert.equal(presentation.artifacts?.[0]?.kind, "image");
		assert.equal(presentation.artifacts?.[0]?.path, "batched.png");
		assert.equal(presentation.artifacts?.[0]?.absolutePath, imagePath);
		assert.equal(presentation.artifacts?.[0]?.mediaType, "image/png");
		assert.equal(presentation.artifacts?.[0]?.exists, true);
		assert.equal(presentation.batchSteps?.[1]?.imagePath, imagePath);
		assert.equal(presentation.batchSteps?.[1]?.artifacts?.[0]?.kind, "image");
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation preserves non-screenshot file artifacts inside batch output", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: "/tmp/pi-agent-browser-batch-artifacts",
		envelope: {
			success: true,
			data: [
				{ command: ["trace", "stop", "trace.zip"], result: { eventCount: 1, path: "trace.zip" }, success: true },
				{ command: ["profiler", "stop", "profile.cpuprofile"], result: { eventCount: 2, path: "profile.cpuprofile" }, success: true },
				{ command: ["record", "stop"], result: { frames: 3, path: "recording.webm" }, success: true },
				{ command: ["network", "har", "stop", "network.har"], result: { path: "network.har", requestCount: 0 }, success: true },
			],
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Step 1 — trace stop trace\.zip/);
	assert.match(text, /Saved trace: trace\.zip/);
	assert.match(text, /Step 2 — profiler stop profile\.cpuprofile/);
	assert.match(text, /Saved profile: profile\.cpuprofile/);
	assert.match(text, /Step 3 — record stop/);
	assert.match(text, /Saved recording: recording\.webm/);
	assert.match(text, /Step 4 — network har stop network\.har/);
	assert.match(text, /Saved HAR: network\.har/);
	assert.deepEqual(presentation.artifacts?.map((artifact) => artifact.kind), ["trace", "profile", "video", "har"]);
	assert.deepEqual(presentation.batchSteps?.map((step) => step.artifacts?.[0]?.kind), ["trace", "profile", "video", "har"]);
	assert.equal(presentation.imagePath, undefined);
	assert.equal(presentation.imagePaths, undefined);
});

test("buildToolPresentation reuses compact snapshot rendering inside batch output", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Actionable control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => {
		const ref = `e${index + 1}`;
		return `- generic \"Large batched snapshot row ${index + 1} that should compact inside batch output\" [ref=${ref}] clickable [onclick]`;
	}).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{
					command: ["snapshot", "-i"],
					result: {
						origin: "https://example.com/batched-huge",
						refs,
						snapshot,
					},
					success: true,
				},
			],
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Step 1 — snapshot -i/);
	assert.match(text, /Compact snapshot view/);
	assert.match(text, /Key refs:/);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal(presentation.batchSteps?.length, 1);
	assert.equal(typeof presentation.batchSteps?.[0]?.fullOutputPath, "string");
	assert.match(presentation.batchSteps?.[0]?.text ?? "", /Compact snapshot view/);

	const spillPath = presentation.batchSteps?.[0]?.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	if (spillPath) {
		await rm(spillPath, { force: true });
	}
});

test("buildToolPresentation compacts oversized snapshots and spills the raw snapshot to a private temp file", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Actionable control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => {
		const ref = `e${index + 1}`;
		return `- generic \"Large snapshot row ${index + 1} with lots of repeated visible text that should not all stay inline\" [ref=${ref}] clickable [onclick]`;
	}).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/huge",
				refs,
				snapshot,
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Compact snapshot view/);
	assert.match(text, /Key refs:/);
	assert.match(presentation.summary, /Snapshot: 90 refs on https:\/\/example.com\/huge \(compact\)/);
	assert.equal(typeof presentation.fullOutputPath, "string");
	assert.equal((presentation.data as { compacted: boolean }).compacted, true);

	const spillPath = presentation.fullOutputPath;
	assert.ok(spillPath);
	assert.match(text, new RegExp(spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const spillText = await readFile(spillPath, "utf8");
	const spillStats = await stat(spillPath);
	const spillDirStats = await stat(dirname(spillPath));
	assert.match(spillText, /Large snapshot row 120/);
	assert.match(spillText, /Actionable control 1/);
	assert.equal(spillStats.mode & 0o777, 0o600);
	assert.equal(spillDirStats.mode & 0o777, 0o700);
	await rm(spillPath, { force: true });
});

test("buildToolPresentation keeps compact snapshot spill files in the persisted session artifact directory when available", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-store-"));
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Persisted control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => `- generic \"Persisted snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n");

	try {
		const presentation = await buildToolPresentation({
			commandInfo: { command: "snapshot" },
			cwd: process.cwd(),
			envelope: {
				success: true,
				data: {
					origin: "https://example.com/persisted",
					refs,
					snapshot,
				},
			},
			persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
		});

		const spillPath = presentation.fullOutputPath;
		assert.equal(typeof spillPath, "string");
		assert.equal(spillPath?.startsWith(join(sessionDir, ".pi-agent-browser-artifacts", TEST_SESSION_ID)), true);
		await cleanupSecureTempArtifacts();
		assert.match(await readFile(String(spillPath), "utf8"), /Persisted snapshot row 120/);
		assert.equal((await stat(String(spillPath))).mode & 0o777, 0o600);
		assert.equal((await stat(dirname(String(spillPath)))).mode & 0o777, 0o700);
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation evicts the oldest persisted snapshot spill files when the per-session artifact budget is exceeded", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-budget-"));
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Budgeted control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const buildData = (label: string) => ({
		origin: `https://example.com/${label}`,
		refs,
		snapshot: Array.from({ length: 120 }, (_, index) => `- generic \"${label} snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n"),
	});
	const firstData = buildData("first");
	const secondData = buildData("second");
	const budgetBytes = Math.max(
		Buffer.byteLength(JSON.stringify(firstData, null, 2)),
		Buffer.byteLength(JSON.stringify(secondData, null, 2)),
	) + 512;

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: String(budgetBytes) }, async () => {
			const firstPresentation = await buildToolPresentation({
				commandInfo: { command: "snapshot" },
				cwd: process.cwd(),
				envelope: { success: true, data: firstData },
				persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
			});
			const secondPresentation = await buildToolPresentation({
				artifactManifest: firstPresentation.artifactManifest,
				commandInfo: { command: "snapshot" },
				cwd: process.cwd(),
				envelope: { success: true, data: secondData },
				persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
			});

			assert.equal(typeof firstPresentation.fullOutputPath, "string");
			assert.equal(typeof secondPresentation.fullOutputPath, "string");
			assert.equal(await readFile(String(firstPresentation.fullOutputPath), "utf8").then(() => true, () => false), false);
			assert.match(await readFile(String(secondPresentation.fullOutputPath), "utf8"), /second snapshot row 120/);
			assert.equal(secondPresentation.artifactManifest?.liveCount, 1);
			assert.equal(secondPresentation.artifactManifest?.evictedCount, 1);
			assert.equal(
				secondPresentation.artifactManifest?.entries.some(
					(entry) => entry.path === firstPresentation.fullOutputPath && entry.retentionState === "evicted",
				),
				true,
			);
			assert.equal(
				secondPresentation.artifactManifest?.entries.some(
					(entry) => entry.path === secondPresentation.fullOutputPath && entry.retentionState === "live",
				),
				true,
			);
			assert.match(secondPresentation.artifactRetentionSummary ?? "", /1 live, 1 evicted/);
			assert.match((secondPresentation.content[0] as { text: string }).text, /Session artifacts: 1 live, 1 evicted/);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation keeps earlier batch snapshot spill paths live when a later persisted spill exceeds the budget", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-batch-budget-"));
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [
			`e${index + 1}`,
			{ name: index % 3 === 0 ? `Batch control ${index + 1}` : "", role: index % 5 === 0 ? "button" : "generic" },
		]),
	);
	const buildSnapshotData = (label: string) => ({
		origin: `https://example.com/${label}`,
		refs,
		snapshot: Array.from({ length: 120 }, (_, index) => `- generic \"${label} batch snapshot row ${index + 1}\" [ref=e${index + 1}] clickable [onclick]`).join("\n"),
	});
	const firstData = buildSnapshotData("first");
	const secondData = buildSnapshotData("second");
	const budgetBytes = Buffer.byteLength(JSON.stringify(firstData, null, 2)) + 512;

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: String(budgetBytes) }, async () => {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: process.cwd(),
				envelope: {
					success: true,
					data: [
						{ command: ["snapshot", "-i"], result: firstData, success: true },
						{ command: ["snapshot", "-i"], result: secondData, success: true },
					],
				},
				persistentArtifactStore: { sessionDir, sessionId: TEST_SESSION_ID },
			});
			const firstPath = presentation.batchSteps?.[0]?.fullOutputPath;
			const secondPath = presentation.batchSteps?.[1]?.fullOutputPath;
			assert.equal(typeof firstPath, "string");
			assert.equal(secondPath, undefined);
			assert.match(await readFile(String(firstPath), "utf8"), /first batch snapshot row 120/);
			assert.match(presentation.batchSteps?.[1]?.text ?? "", /persisted spill budget exceeded/i);
		});
	} finally {
		await cleanupSecureTempArtifacts();
		await rm(sessionDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation prefers main content sections over top-of-page chrome in compact snapshots", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e1") return [id, { name: "Skip to main content", role: "link" }];
			if (id === "e2") return [id, { name: "AD", role: "link" }];
			if (id === "e3") return [id, { name: "JavaScript", role: "heading" }];
			if (id === "e4") return [id, { name: "Beginner's tutorials", role: "region" }];
			if (id === "e5") return [id, { name: "Intermediate", role: "region" }];
			if (id === "e6") return [id, { name: "Reference", role: "region" }];
			return [id, { name: `Content item ${index + 1}`, role: index % 6 === 0 ? "link" : "generic" }];
		}),
	);
	const snapshot = [
		'- link "Skip to main content" [ref=e1]',
		'- link "AD" [ref=e2]',
		'- heading "JavaScript" [level=1, ref=e3]',
		...Array.from({ length: 18 }, (_, index) => `- link "Overview topic ${index + 1}" [ref=e${index + 10}]`),
		'- region "Beginner\'s tutorials" [ref=e4]',
		'  - link "Your first website: Adding interactivity" [ref=e40]',
		'  - link "Dynamic scripting with JavaScript" [ref=e41]',
		'- region "Intermediate" [ref=e5]',
		'  - link "Asynchronous JavaScript" [ref=e42]',
		'  - link "Client-side web APIs" [ref=e43]',
		'- region "Reference" [ref=e6]',
		...Array.from({ length: 70 }, (_, index) => `  - link "Reference entry ${index + 1}" [ref=e${index + 50}]`),
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/docs/javascript",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Primary content:/);
	assert.match(text, /heading "JavaScript"/);
	assert.match(text, /Additional sections:/);
	assert.match(text, /region "Beginner's tutorials"/);
	assert.doesNotMatch(text, /Skip to main content/);
	assert.doesNotMatch(text, /^- AD$/m);
	assert.equal((presentation.data as { previewMode?: string }).previewMode, "structured");

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation falls back to an outline when the raw snapshot format is unfamiliar", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 90 }, (_, index) => [`e${index + 1}`, { name: `Action ${index + 1}`, role: "button" }]),
	);
	const snapshot = Array.from({ length: 120 }, (_, index) => `node e${index + 1}: Action ${index + 1} -> click target`).join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/unfamiliar",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Compact outline:/);
	assert.doesNotMatch(text, /Primary content:/);
	assert.match(text, /node e1: Action 1 -> click target/);
	assert.match(text, /Key refs:/);
	assert.match(text, /Action 1/);
	assert.equal((presentation.data as { previewMode?: string }).previewMode, "outline");

	if (presentation.fullOutputPath) {
		await rm(presentation.fullOutputPath, { force: true });
	}
});

test("buildToolPresentation degrades gracefully when snapshot spill creation exceeds the temp budget", { concurrency: false }, async () => {
	await cleanupSecureTempArtifacts();
	const refs = Object.fromEntries(Array.from({ length: 90 }, (_, index) => [`e${index + 1}`, { name: `Action ${index + 1}`, role: "button" }]));
	const snapshot = Array.from({ length: 120 }, (_, index) => `- button "Budget row ${index + 1}" [ref=e${index + 1}]`).join("\n");

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_TEMP_ROOT_MAX_BYTES: "1024" }, async () => {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "snapshot" },
				cwd: process.cwd(),
				envelope: {
					success: true,
					data: {
						origin: "https://example.com/budgeted",
						refs,
						snapshot,
					},
				},
			});

			assert.equal(presentation.fullOutputPath, undefined);
			assert.match((presentation.content[0] as { text: string }).text, /Full raw snapshot unavailable:/);
			assert.match((presentation.content[0] as { text: string }).text, /temp spill budget exceeded/i);
		});
	} finally {
		await cleanupSecureTempArtifacts();
	}
});

test("buildToolPresentation skips oversized inline image attachments", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-image-"));
	const imagePath = join(tempDir, "large.png");
	await writeFile(imagePath, Buffer.alloc(256, 1));

	try {
		await withPatchedEnv({ PI_AGENT_BROWSER_INLINE_IMAGE_MAX_BYTES: "128" }, async () => {
			const presentation = await buildToolPresentation({
				commandInfo: { command: "screenshot" },
				cwd: tempDir,
				envelope: { success: true, data: { path: "large.png" } },
			});

			assert.equal(presentation.content.length, 1);
			assert.equal(presentation.content[0]?.type, "text");
			assert.match((presentation.content[0] as { text: string }).text, /Saved image: large\.png/);
			assert.match((presentation.content[0] as { text: string }).text, /Image attachment skipped:/);
			assert.equal(presentation.imagePath, imagePath);
			assert.equal(presentation.artifacts?.[0]?.kind, "image");
			assert.equal(presentation.artifacts?.[0]?.path, "large.png");
			assert.equal(presentation.artifacts?.[0]?.absolutePath, imagePath);
			assert.equal(presentation.artifacts?.[0]?.sizeBytes, 256);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

