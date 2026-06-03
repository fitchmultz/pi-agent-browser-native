/**
 * Purpose: Verify skills adaptation and recovery hint presentation for agent-browser results.
 * Responsibilities: Assert native-tool skill guidance, getter shortcuts, selector/stale-ref hints, and related next actions.
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

test("buildToolPresentation suggests grouped getter commands for common unknown getter shortcuts", async () => {
	const titleFailure = await buildToolPresentation({
		args: ["--session", "work", "title"],
		commandInfo: { command: "title" },
		cwd: process.cwd(),
		errorText: "Unknown command: title",
		sessionName: "work",
	});

	assert.equal(titleFailure.content[0]?.type, "text");
	const titleText = (titleFailure.content[0] as { text: string }).text;
	assert.match(titleText, /getter shortcut/i);
	assert.match(titleText, /`get title`/);
	assert.deepEqual(titleFailure.nextActions?.[0], {
		id: "use-get-title",
		params: { args: ["--session", "work", "get", "title"] },
		reason: "Use `get title` to read the current page title.",
		safety: "Read-only getter command; safe to retry when you intended to inspect page state.",
		tool: "agent_browser",
	});

	const urlFailure = await buildToolPresentation({
		args: ["--session", "work", "url"],
		commandInfo: { command: "url" },
		cwd: process.cwd(),
		errorText: "Unknown command: url",
		sessionName: "work",
	});
	assert.deepEqual(urlFailure.nextActions?.[0]?.params?.args, ["--session", "work", "get", "url"]);

	const textFailure = await buildToolPresentation({
		args: ["text"],
		commandInfo: { command: "text" },
		cwd: process.cwd(),
		errorText: "Unknown command: text",
	});
	assert.match((textFailure.content[0] as { text: string }).text, /`get text <selector>`/);
	assert.equal(textFailure.nextActions, undefined);
});

test("buildToolPresentation explains browser profile config failures with diagnostics next actions", async () => {
	for (const errorText of [
		"No Chrome user data directory found. Cannot resolve profile name.",
		'Chrome profile "pi-agent-browser-nonexistent-dogfood-profile" not found. Available profiles:\n  Default (user)\nIf you meant a directory path, use a full path (e.g., /path/to/profile).',
	]) {
		const presentation = await buildToolPresentation({
			args: ["--profile", "Default", "open", "https://example.com"],
			commandInfo: { command: "open", subcommand: "https://example.com" },
			cwd: process.cwd(),
			errorText,
		});

		assert.equal(presentation.content[0]?.type, "text");
		const text = (presentation.content[0] as { text: string }).text;
		assert.match(text, /profile\/config hint/i);
		assert.match(text, /Do not keep retrying the same open\/profile call/);
		assert.match(text, /top-level `sessionMode: "fresh"` field/);
		assert.deepEqual(presentation.nextActions?.map((action) => ({ id: action.id, args: action.params?.args })), [
			{ id: "inspect-browser-profiles", args: ["profiles"] },
			{ id: "run-agent-browser-doctor", args: ["doctor"] },
		]);
	}
});

test("buildToolPresentation suppresses browser profile recovery self loops", async () => {
	const profilesFailure = await buildToolPresentation({
		args: ["profiles"],
		commandInfo: { command: "profiles" },
		cwd: process.cwd(),
		errorText: "No Chrome user data directory found. Cannot resolve profile name.",
	});
	assert.match((profilesFailure.content[0] as { text: string }).text, /profile\/config hint/i);
	assert.deepEqual(profilesFailure.nextActions?.map((action) => action.id), ["run-agent-browser-doctor"]);

	const doctorFailure = await buildToolPresentation({
		args: ["doctor"],
		commandInfo: { command: "doctor" },
		cwd: process.cwd(),
		errorText: "Chrome profile \"Missing\" not found. Available profiles: Default.",
	});
	assert.match((doctorFailure.content[0] as { text: string }).text, /profile\/config hint/i);
	assert.deepEqual(doctorFailure.nextActions?.map((action) => action.id), ["inspect-browser-profiles"]);
});

test("buildToolPresentation ignores unrelated profile text outside launch setup context", async () => {
	const presentation = await buildToolPresentation({
		args: ["get", "text", "#profile-card"],
		commandInfo: { command: "get", subcommand: "text" },
		cwd: process.cwd(),
		errorText: "Could not read profile card text from selector.",
	});
	assert.doesNotMatch((presentation.content[0] as { text: string }).text, /profile\/config hint/i);
	assert.equal(presentation.nextActions, undefined);
});

test("buildToolPresentation explains localhost navigation failures as browser-host reachability", async () => {
	const presentation = await buildToolPresentation({
		commandInfo: { command: "open", subcommand: "http://127.0.0.1:8766/page.html" },
		cwd: process.cwd(),
		errorText: "Navigation failed: net::ERR_EMPTY_RESPONSE",
	});

	assert.equal(presentation.content[0]?.type, "text");
	const text = (presentation.content[0] as { text: string }).text;
	assert.match(text, /^Navigation failed: net::ERR_EMPTY_RESPONSE/);
	assert.match(text, /browser process could not read a loopback URL/);
	assert.match(text, /curl works from the shell but browser navigation fails/);
	assert.match(text, /Use file:\/\/ only for static fallback fixtures/);
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
	assert.deepEqual(tabDrift.nextActions?.map((action) => action.params?.args), [["tab", "list"]]);
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
