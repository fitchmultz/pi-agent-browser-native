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
	type SessionArtifactManifest,
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
	assert.equal(presentation.pageChangeSummary?.title, "Example Domain");
	assert.equal(presentation.pageChangeSummary?.url, "https://example.com/");
	assert.deepEqual(presentation.pageChangeSummary?.nextActionIds, ["inspect-opened-page"]);
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
	assert.deepEqual(presentation.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);
	assert.deepEqual(presentation.pageChangeSummary, {
		changeType: "navigation",
		command: "click",
		nextActionIds: ["inspect-after-mutation"],
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
				message: "Authorization: Bearer raw-token Cookie: sid=raw-cookie",
				nested: { token: "secret-token", url: "https://example.com/?api_key=secret-key" },
			},
		},
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /\[REDACTED\]/);
	assert.doesNotMatch(text, /secret-cookie|raw-token|raw-cookie|secret-token|secret-key/);
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

test("buildToolPresentation renders agent-browser skills as native-tool guidance", async () => {
	const listPresentation = await buildToolPresentation({
		commandInfo: { command: "skills", subcommand: "list" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [{ name: "core", description: "Core usage guide" }],
		},
	});
	assert.equal((listPresentation.content[0] as { text: string }).text, "1. core — Core usage guide");
	assert.equal(listPresentation.summary, "agent-browser skills: 1");

	const getPresentation = await buildToolPresentation({
		commandInfo: { command: "skills", subcommand: "get" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [{ content: "---\nallowed-tools: Bash(agent-browser:*)\n---\n# Core\n\n```bash\nagent-browser snapshot -i\n```" }],
		},
	});
	const text = (getPresentation.content[0] as { text: string }).text;
	assert.match(text, /Pi native-tool note/);
	assert.match(text, /# Core/);
	assert.match(text, /agent_browser \{ "args": \["snapshot","-i"\] \}/);
	assert.doesNotMatch(text, /allowed-tools: Bash|```bash|^\[/m);

	const stringSkillPresentation = await buildToolPresentation({
		commandInfo: { command: "skills", subcommand: "get" },
		cwd: process.cwd(),
		envelope: { success: true, data: "# Core\n\n```bash\nagent-browser snapshot -i\n```" },
	});
	assert.match((stringSkillPresentation.content[0] as { text: string }).text, /Pi native-tool note/);
	assert.match((stringSkillPresentation.content[0] as { text: string }).text, /agent_browser \{ "args": \["snapshot","-i"\] \}/);

	const pathPresentation = await buildToolPresentation({
		commandInfo: { command: "skills", subcommand: "path" },
		cwd: process.cwd(),
		envelope: { success: true, data: "/tmp/agent-browser-skills/core" },
	});
	assert.equal(pathPresentation.summary, "agent-browser skill path");
	assert.equal((pathPresentation.content[0] as { text: string }).text, "/tmp/agent-browser-skills/core");
});

test("buildToolPresentation compacts large full skill payloads while preserving native guidance", async () => {
	const largeSkill = [
		"# Full Skill",
		"",
		"```bash",
		"agent-browser snapshot -i",
		"```",
		...Array.from({ length: 260 }, (_, index) => `Skill reference row ${index + 1}: ${"x".repeat(80)}`),
	].join("\n");
	const presentation = await buildToolPresentation({
		commandInfo: { command: "skills", subcommand: "get" },
		cwd: process.cwd(),
		envelope: { success: true, data: { content: largeSkill } },
	});

	assert.equal(presentation.summary, "agent-browser skill loaded (compact)");
	assert.equal(typeof presentation.fullOutputPath, "string");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Full output path:/);
	assert.match(text, /Pi native-tool note/);
	assert.match(text, /agent_browser \{ "args": \["snapshot","-i"\] \}/);
	const fullOutput = await readFile(String(presentation.fullOutputPath), "utf8");
	assert.match(fullOutput, /Skill reference row 260/);
	await rm(String(presentation.fullOutputPath), { force: true });
});

test("buildToolPresentation adapts quoted and heredoc skill examples to native tool calls", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "skills", subcommand: "get" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				content: [
					"# Skill",
					"",
					"```bash",
					'agent-browser open "https://example.com/a b?q=hello world" --profile "Default Profile"',
					"agent-browser eval --stdin <<JS",
					"document.title",
					"JS",
					"agent-browser eval --stdin <<-EOF",
					"\tdocument.body.innerText",
					"\tEOF",
					"```",
				].join("\n"),
			},
		},
	});
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /agent_browser \{ "args": \["open","https:\/\/example\.com\/a b\?q=hello world","--profile","Default Profile"\] \}/);
	assert.match(text, /agent_browser \{ "args": \["eval","--stdin"\], "stdin": "document\.title" \}/);
	assert.match(text, /agent_browser \{ "args": \["eval","--stdin"\], "stdin": "document\.body\.innerText" \}/);
	assert.doesNotMatch(text, /<<JS|<<-EOF|\nJS\n|\n\tEOF\n/);
});

test("buildToolPresentation drops shell comments from adapted skill command args", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "skills", subcommand: "get" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				content: [
					"# Skill",
					"",
					"```bash",
					"agent-browser open https://example.com # 1. Open a page",
					"agent-browser snapshot -i       # 2. See what's on it",
					"```",
				].join("\n"),
			},
		},
	});
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /agent_browser \{ "args": \["open","https:\/\/example\.com\/?"\] \}/);
	assert.match(text, /agent_browser \{ "args": \["snapshot","-i"\] \}/);
	assert.doesNotMatch(text, /"#"/);
	assert.doesNotMatch(text, /"1\."|"2\."/);
});

test("buildToolPresentation preserves benign Basic docs prose while redacting Basic credentials", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "skills", subcommand: "get" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: [{ content: "# Basic Auth Flow\n\nHTTP Basic Authentication\n\nAuthorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==" }],
		},
	});
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Basic Auth Flow/);
	assert.match(text, /HTTP Basic Authentication/);
	assert.doesNotMatch(text, /QWxhZGRpbjpvcGVuIHNlc2FtZQ==/);
	assert.match(text, /Basic \[REDACTED\]/);

	const consolePresentation = await buildToolPresentation({
		commandInfo: { command: "console" },
		cwd: process.cwd(),
		envelope: { success: true, data: { messages: [{ text: "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==" }] } },
	});
	assert.doesNotMatch((consolePresentation.content[0] as { text: string }).text, /QWxhZGRpbjpvcGVuIHNlc2FtZQ==/);
});

test("artifact manifest keeps explicit files with the same relative path but different absolute paths", () => {
	const manifest = mergeSessionArtifactManifest({
		entries: [
			{
				absolutePath: "/tmp/worktree-a/download.txt",
				createdAtMs: 1_000,
				kind: "download",
				path: "download.txt",
				retentionState: "live",
				storageScope: "explicit-path",
			},
			{
				absolutePath: "/tmp/worktree-b/download.txt",
				createdAtMs: 1_001,
				kind: "download",
				path: "download.txt",
				retentionState: "live",
				storageScope: "explicit-path",
			},
		],
		nowMs: 2_000,
	});

	assert.deepEqual(
		manifest?.entries.map((entry) => entry.absolutePath).sort(),
		["/tmp/worktree-a/download.txt", "/tmp/worktree-b/download.txt"],
	);
	assert.equal(manifest?.liveCount, 2);
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

test("buildToolPresentation returns exact next actions for selector failures and tab drift", async () => {
	const selectorFailure = await buildToolPresentation({
		commandInfo: { command: "click", subcommand: "text=Close" },
		cwd: process.cwd(),
		errorText: "Failed to parse selector text=Close",
	});
	assert.equal(selectorFailure.failureCategory, "selector-unsupported");
	assert.deepEqual(selectorFailure.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);

	const tabDrift = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		errorText: "agent-browser could not re-select the intended tab before running the command.",
	});
	assert.equal(tabDrift.failureCategory, "tab-drift");
	assert.deepEqual(tabDrift.nextActions?.map((action) => action.params?.args), [["tab", "list"], ["snapshot", "-i"]]);
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
	assert.match(text, /Network failure summary: 1 actionable, 0 benign low-impact \(1 total\)\./);
	assert.match(text, /1\. 200 GET https:\/\/example.com\/ \(Document\) \[req-1\]/);
	assert.match(text, /2\. 201 POST https:\/\/api\.example\.test\/items\?token=%5BREDACTED%5D \(Fetch\) \[req-2\] \[actionable: document, script, API, or non-benign request failure\]/);
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
		{
			commandInfo: { command: "state", subcommand: "save" },
			data: { path: "auth-state.json" },
			expectedKind: "file",
			expectedMediaType: "application/json",
			expectedText: "State file: auth-state.json",
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
		assert.equal(presentation.artifactVerification?.missingCount, 1);
		assert.equal(presentation.artifactVerification?.verified, false);
		assert.equal(presentation.artifactVerification?.artifacts[0]?.state, "missing");
		assert.equal(presentation.artifactVerification?.artifacts[0]?.absolutePath, join("/tmp/pi-agent-browser-artifact-tests", item.data.path));
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

test("buildToolPresentation does not classify state load paths as saved artifacts", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "state", subcommand: "load" },
		cwd: "/tmp/pi-agent-browser-artifact-tests",
		envelope: { success: true, data: { path: "auth-state.json" } },
	});

	assert.equal(presentation.artifacts, undefined);
	assert.equal(presentation.artifactManifest, undefined);
	assert.equal(presentation.artifactVerification, undefined);
	assert.equal(presentation.summary, "state completed");
	assert.match((presentation.content[0] as { text: string }).text, /auth-state\.json/);
});

test("buildToolPresentation records path-bearing diff screenshots without inlining them as trusted screenshots", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "diff", subcommand: "screenshot" },
		cwd: "/tmp/pi-agent-browser-artifact-tests",
		envelope: { success: true, data: { baselinePath: "baseline.png", diffPath: "diff.png", mismatchPixels: 12 } },
	});

	assert.equal(presentation.summary, "Saved diff image: diff.png");
	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Saved diff image: diff\.png/);
	assert.match(text, /Artifact type: image/);
	assert.doesNotMatch(text, /baseline\.png/);
	assert.equal(presentation.artifacts?.length, 1);
	assert.equal(presentation.artifacts?.[0]?.kind, "image");
	assert.equal(presentation.artifacts?.[0]?.path, "diff.png");
	assert.equal(presentation.artifacts?.[0]?.absolutePath, join("/tmp/pi-agent-browser-artifact-tests", "diff.png"));
	assert.equal(presentation.artifactVerification?.artifacts[0]?.state, "missing");
	assert.equal(presentation.artifactVerification?.artifacts[0]?.path, "diff.png");
	assert.equal(presentation.imagePath, undefined);
	assert.equal(presentation.imagePaths, undefined);
});

test("buildToolPresentation renders record start as a lifecycle state without missing-file copy", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "record", subcommand: "start" },
		cwd: "/tmp/pi-agent-browser-artifact-tests",
		envelope: { success: true, data: { path: "recording.webm" } },
	});

	assert.equal(presentation.summary, "Recording started; output will be written on stop: recording.webm");
	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Recording started; output will be written on stop: recording\.webm/);
	assert.doesNotMatch(text, /Saved recording/);
	assert.doesNotMatch(text, /not found on disk/);
	assert.doesNotMatch(text, /Session artifacts:/);
	assert.equal(presentation.artifacts?.length, 1);
	assert.equal(presentation.artifacts?.[0]?.kind, "video");
	assert.equal(presentation.artifacts?.[0]?.path, "recording.webm");
	assert.equal(presentation.artifacts?.[0]?.absolutePath, join("/tmp/pi-agent-browser-artifact-tests", "recording.webm"));
	assert.equal(presentation.artifacts?.[0]?.mediaType, "video/webm");
	assert.equal(presentation.artifacts?.[0]?.exists, false);
	assert.equal(presentation.artifactManifest, undefined);
	assert.equal(presentation.artifactRetentionSummary, undefined);
	assert.equal(presentation.artifactVerification?.pendingCount, 1);
	assert.equal(presentation.artifactVerification?.verified, false);
	assert.equal(presentation.artifactVerification?.artifacts[0]?.state, "pending");
	assert.equal(presentation.nextActions, undefined);
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
		assert.doesNotMatch((presentation.content[0] as { text: string }).text, /Session artifacts: 1 live, 0 evicted/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("buildToolPresentation scopes artifact verification to current-result artifacts and spills", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-verification-scope-"));
	const downloadPath = join(tempDir, "download.txt");
	await writeFile(downloadPath, "verified artifact");
	try {
		const artifactManifest: SessionArtifactManifest = {
			entries: [{ createdAtMs: Date.now() - 1, kind: "spill", path: "/tmp/old-spill.txt", retentionState: "evicted", storageScope: "persistent-session" }],
			evictedCount: 1,
			liveCount: 0,
			maxEntries: 100,
			updatedAtMs: Date.now(),
			version: 1,
		};
		const presentation = await buildToolPresentation({
			artifactManifest,
			commandInfo: { command: "download" },
			cwd: tempDir,
			envelope: { success: true, data: { path: "download.txt" } },
		});

		assert.equal(presentation.artifactVerification?.verified, true);
		assert.equal(presentation.artifactVerification?.verifiedCount, 1);
		assert.equal(presentation.artifactVerification?.missingCount, 0);
		assert.equal(presentation.artifactVerification?.artifacts.length, 1);
		assert.equal(presentation.artifactVerification?.artifacts[0]?.path, "download.txt");
		assert.equal(presentation.successCategory, "artifact-saved");
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
		assert.doesNotMatch((presentation.content[0] as { text: string }).text, /Session artifacts: .*\(1\/3 recent\)/);
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
	assert.equal(presentation.successCategory, "artifact-unverified");
	assert.equal(presentation.artifactVerification?.unverifiedCount, 1);
	assert.equal(presentation.artifactVerification?.artifacts[0]?.kind, "spill");

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
	assert.equal(presentation.resultCategory, "failure");
	assert.equal(presentation.failureCategory, "stale-ref");
	assert.equal(presentation.batchFailure?.failedStep.index, 1);
	assert.equal(presentation.batchFailure?.failedStep.commandText, "click @zzz");
	assert.equal(presentation.batchFailure?.failedStep.resultCategory, "failure");
	assert.equal(presentation.batchFailure?.failedStep.failureCategory, "stale-ref");
	assert.deepEqual(presentation.batchFailure?.failedStep.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);
	assert.deepEqual(presentation.nextActions?.[0]?.params?.args, ["snapshot", "-i"]);
	assert.equal(presentation.batchFailure?.failureCount, 1);
	assert.equal(presentation.batchFailure?.successCount, 1);
	assert.equal(presentation.batchFailure?.totalCount, 2);
	assert.match(presentation.summary, /Batch failed: 1\/2 succeeded/);
	assert.equal(presentation.pageChangeSummary?.changeType, "mutation");
	assert.equal(presentation.pageChangeSummary?.command, "batch");
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
	assert.equal(presentation.batchSteps?.[1]?.artifactVerification?.missingCount, 1);
	assert.equal(presentation.artifactVerification?.missingCount, 1);
	assert.deepEqual(presentation.batchSteps?.[1]?.nextActions?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
	assert.equal(presentation.batchSteps?.[1]?.pageChangeSummary?.changeType, "artifact");
	assert.equal(presentation.batchSteps?.[1]?.pageChangeSummary?.savedFilePath, "/tmp/export.csv");
});

test("buildToolPresentation does not re-append old artifact retention noise for routine explicit batch files", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-explicit-noise-"));
	const downloadPath = join(tempDir, "export.csv");
	await writeFile(downloadPath, "a,b\n1,2\n");
	const baseManifest: SessionArtifactManifest = {
		entries: [
			{
				createdAtMs: 1_000,
				evictedAtMs: 2_000,
				kind: "spill",
				path: "/tmp/old-spill.json",
				retentionState: "evicted",
				storageScope: "persistent-session",
			},
		],
		evictedCount: 1,
		liveCount: 0,
		maxEntries: 100,
		updatedAtMs: 2_000,
		version: 1,
	};
	try {
		const presentation = await buildToolPresentation({
			artifactManifest: baseManifest,
			commandInfo: { command: "batch" },
			cwd: tempDir,
			envelope: {
				success: true,
				data: [{ command: ["download", "@e1", "export.csv"], result: { path: "export.csv" }, success: true }],
			},
		});
		const text = (presentation.content[0] as { text: string }).text;
		assert.match(text, /Downloaded file: export\.csv/);
		assert.doesNotMatch(text, /Session artifacts:/);
		assert.match(presentation.artifactRetentionSummary ?? "", /1 live, 1 evicted/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
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
				{ command: ["record", "start", "recording.webm"], result: { path: "recording.webm" }, success: true },
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
	assert.match(text, /Step 3 — record start recording\.webm/);
	assert.match(text, /Recording started; output will be written on stop: recording\.webm/);
	assert.doesNotMatch(presentation.batchSteps?.[2]?.text ?? "", /Saved recording|not found on disk/);
	assert.match(text, /Step 4 — record stop/);
	assert.match(text, /Saved recording: recording\.webm/);
	assert.match(text, /Step 5 — network har stop network\.har/);
	assert.match(text, /Saved HAR: network\.har/);
	assert.deepEqual(presentation.artifacts?.map((artifact) => artifact.kind), ["trace", "profile", "video", "video", "har"]);
	assert.deepEqual(presentation.batchSteps?.map((step) => step.artifacts?.[0]?.kind), ["trace", "profile", "video", "video", "har"]);
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

test("buildToolPresentation surfaces omitted high-value controls in compact snapshots", async () => {
	const refs = Object.fromEntries(
		Array.from({ length: 100 }, (_, index) => {
			const id = `e${index + 1}`;
			if (id === "e2") return [id, { name: "Search", role: "button" }];
			if (id === "e3") return [id, { name: "Search docs", role: "searchbox" }];
			if (["e4", "e5", "e6", "e7", "e8", "e9"].includes(id)) {
				return [id, { name: `Package tab ${id.slice(1)}`, role: "tab" }];
			}
			return [id, { name: `Article link ${index + 1}`, role: "link" }];
		}),
	);
	const snapshot = [
		'- heading "Docs Home" [level=1, ref=e1]',
		...Array.from({ length: 80 }, (_, index) => `  - link "Article link ${index + 10}" [ref=e${index + 10}]`),
		'- navigation "Top navigation"',
		'  - button "Search" [ref=e2]',
		'  - searchbox "Search docs" [ref=e3]',
		'- tablist "Package managers"',
		'  - tab "Package tab 4" [ref=e4]',
		'  - tab "Package tab 5" [ref=e5]',
		'  - tab "Package tab 6" [ref=e6]',
		'  - tab "Package tab 7" [ref=e7]',
		'  - tab "Package tab 8" [ref=e8]',
		'  - tab "Package tab 9" [ref=e9]',
	].join("\n");

	const presentation = await buildToolPresentation({
		commandInfo: { command: "snapshot" },
		cwd: process.cwd(),
		envelope: {
			success: true,
			data: {
				origin: "https://example.com/docs",
				refs,
				snapshot,
			},
		},
	});

	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /Other refs:/);
	assert.match(text, /e3 searchbox "Search docs"/);
	assert.match(text, /e2 button "Search"/);
	assert.match(text, /Omitted high-value controls:/);
	assert.match(text, /e6 tab "Package tab 6"/);
	assert.match(text, /e9 tab "Package tab 9"/);
	assert.deepEqual((presentation.data as { highValueControlRefIds?: string[] }).highValueControlRefIds, ["e6", "e7", "e8", "e9"]);

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

