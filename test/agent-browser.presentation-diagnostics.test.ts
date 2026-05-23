/**
 * Purpose: Verify diagnostic and extraction presentation for agent-browser results.
 * Responsibilities: Assert get/eval extraction, session/profile/auth/state, network, console/errors, dashboard, doctor, and large diagnostic compaction formatting.
 * Scope: Unit-style Node test-runner coverage for `buildToolPresentation`; extension lifecycle presentation integration lives in focused extension suites.
 * Usage: Run with `npx tsx --test test/agent-browser.presentation.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests isolate temp artifacts and preserve existing cleanup for secure temp roots.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildToolPresentation
} from "../extensions/agent-browser/lib/results.js";
import type {
	SessionArtifactManifest,
	SessionArtifactManifestEntry,
} from "../extensions/agent-browser/lib/results/contracts.js";
import {
	DEFAULT_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES,
	getSessionArtifactManifestMaxEntries,
	mergeSessionArtifactManifest,
} from "../extensions/agent-browser/lib/results/artifact-manifest.js";
import {
	withPatchedEnv
} from "./helpers/agent-browser-harness.js";

test("buildToolPresentation redacts scalar extraction results for eval and get commands", async () => {
	const evalPresentation = await buildToolPresentation({
		commandInfo: { command: "eval", subcommand: "--stdin" },
		cwd: process.cwd(),
		envelope: { success: true, data: { origin: "https://example.com/?token=origin-secret", result: '{"token":"scalar-secret","ok":true}' } },
	});
	const evalText = (evalPresentation.content[0] as { text: string }).text;
	assert.doesNotMatch(evalText, /scalar-secret|origin-secret/);
	assert.match(evalText, /\[REDACTED\]/);
	assert.doesNotMatch(evalPresentation.summary, /scalar-secret/);

	const getPresentation = await buildToolPresentation({
		commandInfo: { command: "get", subcommand: "text" },
		cwd: process.cwd(),
		envelope: { success: true, data: { result: "Cookie: sid=get-secret" } },
	});
	const getText = (getPresentation.content[0] as { text: string }).text;
	assert.doesNotMatch(getText, /get-secret/);
	assert.match(getText, /\[REDACTED\]/);
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

test("buildToolPresentation formats stateful browser-context results without leaking credentials", async () => {
	const cases = [
		{
			commandInfo: { command: "cookies", subcommand: "get" },
			data: { cookies: [{ domain: "example.test", httpOnly: true, name: "session_id", path: "/", value: "cookie-secret" }] },
			summary: "Cookies: 1",
			matches: [/session_id/, /example\.test/],
			missing: /cookie-secret/,
		},
		{
			commandInfo: { command: "cookies", subcommand: "set" },
			data: { domain: "example.test", name: "sid", path: "/", value: "cookie-set-secret" },
			summary: "sid",
			matches: [/sid/, /example\.test/],
			missing: /cookie-set-secret/,
		},
		{
			commandInfo: { command: "storage", subcommand: "local" },
			data: { entries: [{ key: "theme", value: "dark" }, { key: "jwt", value: "eyJhbGciOiJIUzI1NiJ9.supersecret.signature" }, { key: "authToken", value: "storage-secret-token" }], type: "local" },
			summary: "Storage entries: 3",
			matches: [/theme: \[REDACTED\]/, /jwt: \[REDACTED\]/, /authToken: \[REDACTED\]/],
			missing: /dark|supersecret|storage-secret-token|eyJhbGci/,
		},
		{
			commandInfo: { command: "storage", subcommand: "local" },
			data: { key: "sessionToken", type: "local", value: "direct-storage-secret" },
			summary: "Storage set: sessionToken",
			matches: [/local sessionToken: \[REDACTED\]/],
			missing: /direct-storage-secret/,
		},
		{
			commandInfo: { command: "dialog", subcommand: "status" },
			data: { message: "Authorization: Bearer dialog-secret", open: true, type: "prompt" },
			summary: "Dialog open",
			matches: [/Dialog open/, /Type: prompt/, /Message: \[REDACTED\]/],
			missing: /dialog-secret/,
		},
		{
			commandInfo: { command: "frame", subcommand: "main" },
			data: { frame: "main", title: "Main Frame", url: "https://example.test/frame" },
			summary: "Frame: main",
			matches: [/Frame: main/, /Main Frame/],
			missing: undefined,
		},
		{
			commandInfo: { command: "state", subcommand: "list" },
			data: { states: [{ name: "prod-state.json", url: "https://example.test/?token=state-secret" }] },
			summary: "States: 1",
			matches: [/prod-state\.json/, /REDACTED/],
			missing: /state-secret/,
		},
	] as const;

	for (const testCase of cases) {
		const presentation = await buildToolPresentation({
			commandInfo: testCase.commandInfo,
			cwd: process.cwd(),
			envelope: { success: true, data: testCase.data },
		});
		assert.equal(presentation.summary, testCase.summary);
		const text = (presentation.content[0] as { text: string }).text;
		for (const pattern of testCase.matches) assert.match(text, pattern);
		if (testCase.missing) {
			assert.doesNotMatch(text, testCase.missing);
			assert.doesNotMatch(JSON.stringify(presentation.data), testCase.missing);
		}
	}
});

test("buildToolPresentation redacts stateful batch details", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [
				{
					command: ["cookies", "set", "sid", "cookie-secret"],
					result: { domain: "example.test", name: "sid", value: "cookie-secret" },
					success: true,
				},
				{
					command: ["storage", "local", "set", "authToken", "storage-secret"],
					result: { entries: [{ key: "authToken", value: "storage-secret" }], type: "local" },
					success: true,
				},
			],
		},
	});

	const serialized = JSON.stringify({ batchSteps: presentation.batchSteps, data: presentation.data });
	assert.doesNotMatch((presentation.content[0] as { text: string }).text, /cookie-secret|storage-secret/);
	assert.doesNotMatch(serialized, /cookie-secret|storage-secret/);
	assert.match(serialized, /\[REDACTED\]/);
});

test("buildToolPresentation redacts failed stateful batch details", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "batch" },
		cwd: process.cwd(),
		envelope: {
			success: false,
			data: [
				{
					command: ["cookies", "set", "sid", "cookie-secret"],
					error: { message: "failed cookie-secret", value: "cookie-secret" },
					success: false,
				},
			],
		},
	});

	const serialized = JSON.stringify({ batchFailure: presentation.batchFailure, batchSteps: presentation.batchSteps, data: presentation.data });
	assert.doesNotMatch((presentation.content[0] as { text: string }).text, /cookie-secret/);
	assert.doesNotMatch(serialized, /cookie-secret/);
	assert.match(serialized, /\[REDACTED\]/);
});

test("buildToolPresentation formats redacted network payload, response, and error previews", async () => {
	const longResponse = `{"items":["${"x".repeat(400)}"],"token":"response-secret"}`;
	const presentation = await buildToolPresentation({
		commandInfo: { command: "network", subcommand: "requests" },
		cwd: process.cwd(),
		sessionName: "work",
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
						url: "https://api.example.test/items?token=url-secret&sentry_key=sentry-secret&writeKey=write-secret",
					},
				],
			},
		},
	});

	assert.equal(presentation.summary, "Network requests: 2");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Network failure summary: 1 actionable, 0 benign low-impact \(1 total\)\./);
	assert.match(text, /2\. 201 POST https:\/\/api\.example\.test\/items\?token=%5BREDACTED%5D&sentry_key=%5BREDACTED%5D&writeKey=%5BREDACTED%5D \(Fetch\) \[req-2\] \[actionable: document, script, API, or non-benign request failure\]/);
	assert.match(text, /1\. 200 GET https:\/\/example.com\/ \(Document\) \[req-1\]/);
	assert.ok(text.indexOf("2. 201 POST") < text.indexOf("1. 200 GET"));
	assert.match(text, /Payload: .*name.*demo/);
	assert.match(text, /Payload: .*\[REDACTED\]/);
	assert.match(text, /Payload: .*https:\/\/api\.example\.test\/callback\?token=%5BREDACTED%5D/);
	assert.match(text, /Response: /);
	assert.match(text, /Response: .*…/);
	assert.match(text, /Error: net::ERR_FAILED Authorization: Bearer \[REDACTED\]/);
	assert.doesNotMatch(text, /User-Agent|secret-agent|body-secret|response-secret|header-secret|url-secret|nested-url-secret|error-secret|sentry-secret|write-secret|Set-Cookie/);
	assert.deepEqual(presentation.nextActions?.map((action) => action.id), [
		"inspect-actionable-network-request",
		"trace-actionable-network-source",
		"filter-network-requests-by-path",
		"start-network-har-capture",
	]);
	assert.deepEqual(presentation.nextActions?.[0]?.params?.args, ["--session", "work", "network", "request", "req-2"]);
	assert.deepEqual(presentation.nextActions?.[1]?.params?.networkSourceLookup, { requestId: "req-2", session: "work" });
	assert.deepEqual(presentation.nextActions?.[2]?.params?.args, ["--session", "work", "network", "requests", "--filter", "/items"]);
	assert.deepEqual(presentation.nextActions?.[3]?.params?.args, ["--session", "work", "network", "har", "start"]);
	assert.doesNotMatch(JSON.stringify(presentation.nextActions), /url-secret|nested-url-secret|error-secret|sentry-secret|write-secret/);
});

test("buildToolPresentation returns bounded network request next actions for benign and successful API rows", async () => {
	const benignPresentation = await buildToolPresentation({
		commandInfo: { command: "network", subcommand: "requests" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				requests: [
					{ method: "GET", mimeType: "image/x-icon", requestId: "icon-1", resourceType: "image", status: 404, url: "https://example.test/favicon.ico" },
				],
			},
		},
	});
	assert.deepEqual(benignPresentation.nextActions?.map((action) => action.id), [
		"inspect-benign-network-request",
		"filter-network-requests-by-path",
		"start-network-har-capture",
	]);
	assert.deepEqual(benignPresentation.nextActions?.[0]?.params?.args, ["network", "request", "icon-1"]);
	assert.equal(benignPresentation.nextActions?.some((action) => action.id.includes("source")), false);

	const apiPresentation = await buildToolPresentation({
		commandInfo: { command: "network", subcommand: "requests" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				requests: [
					{ method: "GET", requestId: "api-1", resourceType: "fetch", status: 200, url: "https://example.test/api/items?token=url-secret" },
				],
			},
		},
		sessionName: "work",
	});
	assert.deepEqual(apiPresentation.nextActions?.map((action) => action.id), [
		"inspect-network-request",
		"filter-network-requests-by-path",
		"start-network-har-capture",
	]);
	assert.deepEqual(apiPresentation.nextActions?.[0]?.params?.args, ["--session", "work", "network", "request", "api-1"]);
	assert.deepEqual(apiPresentation.nextActions?.[1]?.params?.args, ["--session", "work", "network", "requests", "--filter", "/api/items"]);
	assert.deepEqual(apiPresentation.nextActions?.[2]?.params?.args, ["--session", "work", "network", "har", "start"]);
	assert.equal(apiPresentation.nextActions?.some((action) => action.id.includes("source")), false);
	assert.doesNotMatch(JSON.stringify(apiPresentation.nextActions), /url-secret/);

	for (const [requestId, url, forbiddenPattern] of [
		["reset-1", "https://example.test/reset/token/abc123?code=url-secret", /reset\/token|abc123|url-secret/],
		["reset-2", "https://example.test/reset-password/abc123?code=url-secret", /reset-password|abc123|url-secret/],
		["session-1", "https://example.test/accounts/session-id/abc123?code=url-secret", /session-id|abc123|url-secret/],
		["camel-1", "https://example.test/account/passwordReset/abc123?code=url-secret", /passwordReset|abc123|url-secret/],
		["camel-2", "https://example.test/account/resetToken/abc123?code=url-secret", /resetToken|abc123|url-secret/],
		["camel-3", "https://example.test/account/sessionId/abc123?code=url-secret", /sessionId|abc123|url-secret/],
		["camel-4", "https://example.test/account/apiKey/abc123?code=url-secret", /apiKey|abc123|url-secret/],
		["opaque-1", "https://example.test/files/0123456789abcdef?code=url-secret", /0123456789abcdef|url-secret/],
	] as const) {
		const sensitivePathPresentation = await buildToolPresentation({
			commandInfo: { command: "network", subcommand: "requests" },
			cwd: process.cwd(),
			envelope: {
				success: true,
				data: {
					requests: [
						{ method: "GET", requestId, status: 200, url },
					],
				},
			},
		});
		assert.deepEqual(sensitivePathPresentation.nextActions?.map((action) => action.id), ["inspect-network-request", "start-network-har-capture"]);
		assert.deepEqual(sensitivePathPresentation.nextActions?.[0]?.params?.args, ["network", "request", requestId]);
		assert.doesNotMatch(JSON.stringify(sensitivePathPresentation.nextActions), forbiddenPattern);
	}
});

test("buildToolPresentation keeps failed network rows visible when successful rows would fill the preview", async () => {
	const requests = Array.from({ length: 45 }, (_, index) => ({
		method: "GET",
		requestId: `ok-${index}`,
		resourceType: "Script",
		status: 200,
		url: `https://example.test/static/${index}.js`,
	}));
	requests.push({
		method: "GET",
		requestId: "late-failure",
		resourceType: "Script",
		status: 404,
		url: "https://example.test/missing.js",
	});
	const presentation = await buildToolPresentation({
		commandInfo: { command: "network", subcommand: "requests" },
		cwd: process.cwd(),
		envelope: { success: true, data: { requests } },
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /46\. 404 GET https:\/\/example\.test\/missing\.js \(Script\) \[late-failure\] \[actionable: document, script, API, or non-benign request failure\]/);
	assert.ok(text.indexOf("46. 404 GET") < text.indexOf("1. 200 GET"));
	assert.match(text, /failed requests are shown first when present/);
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

test("buildToolPresentation redacts dashboard and doctor diagnostic strings", async () => {
	const dashboardPresentation = await buildToolPresentation({
		commandInfo: { command: "dashboard" },
		cwd: process.cwd(),
		envelope: { success: true, data: { port: 9222, reason: "Authorization: Bearer dash-secret Cookie: sid=dash-cookie" } },
	});
	const dashboardText = (dashboardPresentation.content[0] as { text: string }).text;
	assert.doesNotMatch(dashboardText, /dash-secret|dash-cookie/);
	assert.doesNotMatch(dashboardPresentation.summary, /dash-secret|dash-cookie/);
	assert.match(dashboardText, /\[REDACTED\]/);

	const doctorPresentation = await buildToolPresentation({
		commandInfo: { command: "doctor" },
		cwd: process.cwd(),
		envelope: { success: true, data: { status: "Authorization: Bearer doctor-secret Cookie: sid=doctor-cookie" } },
	});
	const doctorText = (doctorPresentation.content[0] as { text: string }).text;
	assert.doesNotMatch(doctorText, /doctor-secret|doctor-cookie/);
	assert.doesNotMatch(doctorPresentation.summary, /doctor-secret|doctor-cookie/);
	assert.match(doctorText, /\[REDACTED\]/);
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

test("buildToolPresentation summarizes non-core command families and redacts diagnostic data", async () => {
	const cases = [
		{
			commandInfo: { command: "network", subcommand: "route" },
			data: { body: { token: "route-secret" }, routed: "https://api.example.test/**?token=route-url-secret" },
			expectedSummary: "Network route: https://api.example.test/**?token=%5BREDACTED%5D",
			expectedText: /routed.*api\.example\.test/,
			forbidden: /route-secret|route-url-secret/,
		},
		{
			commandInfo: { command: "network", subcommand: "unroute" },
			data: { unrouted: "**/*.js" },
			expectedSummary: "Network unroute: **/*.js",
			expectedText: /unrouted.*\*\*\/\*\.js/,
			forbidden: /never-match-secret/,
		},
		{
			commandInfo: { command: "diff", subcommand: "snapshot" },
			data: { added: 1, removed: 0, token: "diff-secret" },
			expectedSummary: "Snapshot diff completed",
			expectedText: /added.*1/,
			forbidden: /diff-secret/,
		},
		{
			commandInfo: { command: "diff", subcommand: "url" },
			data: { differenceCount: 2, url: "https://example.test/?token=diff-url-secret" },
			expectedSummary: "URL diff completed",
			expectedText: /differenceCount.*2/,
			forbidden: /diff-url-secret/,
		},
		{
			commandInfo: { command: "trace", subcommand: "start" },
			data: { status: "started" },
			expectedSummary: "Trace: started",
			expectedText: /started/,
			forbidden: /never-match-secret/,
		},
		{
			commandInfo: { command: "profiler", subcommand: "start" },
			data: { status: "started" },
			expectedSummary: "Profiler: started",
			expectedText: /started/,
			forbidden: /never-match-secret/,
		},
		{
			commandInfo: { command: "highlight", subcommand: "#pay" },
			data: { highlighted: "#pay" },
			expectedSummary: "Element highlighted",
			expectedText: /highlighted.*#pay/,
			forbidden: /never-match-secret/,
		},
		{
			commandInfo: { command: "inspect" },
			data: { opened: true },
			expectedSummary: "DevTools inspect opened",
			expectedText: /opened.*true/,
			forbidden: /never-match-secret/,
		},
		{
			commandInfo: { command: "clipboard", subcommand: "read" },
			data: { text: "clipboard Authorization: Bearer clipboard-secret" },
			expectedSummary: "Clipboard read",
			expectedText: /\[REDACTED\]/,
			forbidden: /clipboard-secret/,
		},
		{
			commandInfo: { command: "stream", subcommand: "enable" },
			data: { connected: true, enabled: true, port: 7788, screencasting: true },
			expectedSummary: "Stream enabled on port 7788",
			expectedText: /WebSocket URL: ws:\/\/127\.0\.0\.1:7788/,
			forbidden: /never-match-secret/,
		},
		{
			commandInfo: { command: "stream", subcommand: "disable" },
			data: { connected: false, enabled: false, screencasting: false },
			expectedSummary: "Stream disabled",
			expectedText: /Enabled: false/,
			forbidden: /never-match-secret/,
		},
		{
			commandInfo: { command: "chat", subcommand: "summarize" },
			data: { model: "anthropic/claude", response: "Done with Bearer chat-secret" },
			expectedSummary: "Chat response",
			expectedText: /Bearer \[REDACTED\]/,
			forbidden: /chat-secret/,
		},
	] as const;

	for (const item of cases) {
		const presentation = await buildToolPresentation({
			commandInfo: item.commandInfo,
			cwd: process.cwd(),
			envelope: { success: true, data: item.data },
		});
		const text = (presentation.content[0] as { text: string }).text;
		const serialized = JSON.stringify({ data: presentation.data, summary: presentation.summary, text });
		const label = `${item.commandInfo.command} ${"subcommand" in item.commandInfo ? item.commandInfo.subcommand : ""}`;
		assert.equal(presentation.summary, item.expectedSummary, label);
		assert.match(text, item.expectedText, label);
		assert.doesNotMatch(serialized, item.forbidden, label);
	}
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

