/**
 * Purpose: Verify pure helper behavior for the tmux-driven configured-source lifecycle harness (`npm run verify -- lifecycle`, `scripts/verify-lifecycle.mjs`).
 * Responsibilities: Assert CLI parsing, settings isolation, observed-page checks and JSONL result waits, sentinel source injection, and direct-run guarding without launching Pi or tmux.
 * Scope: Unit coverage for `scripts/verify-lifecycle.mjs`; the end-to-end lifecycle path runs only through the explicit `npm run verify -- lifecycle` maintainer command.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: Normal tests must not mutate Pi settings, start tmux, or require a real browser/model configuration.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { TARGET_AGENT_BROWSER_VERSION_LABEL } from "../scripts/agent-browser-target.mjs";

const execFile = promisify(execFileCallback);

type LifecycleResult = {
	toolCallId?: string;
	isError?: boolean;
	content?: Array<{ type: string; text: string }>;
	details?: { command?: string; resultCategory?: string; failureCategory?: string; data?: unknown; sessionName?: string; sessionTabTarget?: { url: string } };
};

const lifecycleModule = (await import("../scripts/verify-lifecycle.mjs") as unknown) as {
	agentBrowserResults: (entries: unknown[]) => Array<{
		content?: Array<{ text?: string; type?: string }>;
		details?: { fullOutputPath?: string; fullOutputPaths?: string[]; sessionName?: string };
		toolName?: string;
	}>;
	buildPiLaunchArgs: (options: { model: string; sessionId: string }) => string[];
	buildSettingsPayload: (options: { packageDir: string; sessionDir: string }) => {
		enableInstallTelemetry: boolean;
		extensions: string[];
		packages: string[];
		prompts: string[];
		quietStartup: boolean;
		sessionDir: string;
		skills: string[];
		themes: string[];
	};
	collectFullOutputPaths: (results: unknown[]) => string[];
	createLifecycleSessionId: (pid?: number) => string;
	fakeAgentBrowserScript: () => string;
	injectLifecycleSentinelSource: (source: string, token: string) => string;
	isDirectRun: (metaUrl: string, argv?: string[]) => boolean;
	matchesSuccessfulPageResult: (result: unknown, command: string, expectedUrl: string) => boolean;
	waitForAgentBrowserResult: (options: {
		describe: string;
		sessionFile?: string;
		sessionDir?: string;
		timeoutMs: number;
		sinceCount: number;
		predicate: (result: LifecycleResult) => boolean;
	}) => Promise<{ result: LifecycleResult; sessionFile: string }>;
	paneLooksReady: (pane: string) => boolean;
	parseCliArgs: (argv?: string[]) => {
		keepArtifacts: boolean;
		model: string;
		showHelp: boolean;
		timeoutMs: number;
		verbose: boolean;
	};
	parseJsonl: (text: string) => unknown[];
	sentinelTokens: (entries: unknown[]) => string[];
	sessionHeaderId: (entries: unknown[]) => string | undefined;
	tmuxActiveTarget: (tmuxSession: string) => string;
};

const {
	agentBrowserResults,
	buildPiLaunchArgs,
	buildSettingsPayload,
	collectFullOutputPaths,
	createLifecycleSessionId,
	injectLifecycleSentinelSource,
	isDirectRun,
	matchesSuccessfulPageResult,
	waitForAgentBrowserResult,
	paneLooksReady,
	parseCliArgs,
	parseJsonl,
	sentinelTokens,
	sessionHeaderId,
	tmuxActiveTarget,
} = lifecycleModule;

test("parseCliArgs supports lifecycle harness options", () => {
	assert.deepEqual(parseCliArgs([]), {
		keepArtifacts: false,
		model: "zai/glm-5.2",
		showHelp: false,
		timeoutMs: 180_000,
		verbose: false,
	});
	assert.deepEqual(parseCliArgs(["--keep-artifacts", "--verbose", "--timeout-ms", "42"]), {
		keepArtifacts: true,
		model: "zai/glm-5.2",
		showHelp: false,
		timeoutMs: 42,
		verbose: true,
	});
	assert.deepEqual(parseCliArgs(["--model", "openai-codex/gpt-5.5:minimal"]).model, "openai-codex/gpt-5.5:minimal");
	assert.equal(parseCliArgs(["--help"]).showHelp, true);
	assert.equal(parseCliArgs(["-h"]).showHelp, true);
});

test("parseCliArgs rejects invalid lifecycle options", () => {
	assert.throws(() => parseCliArgs(["--wat"]), /Unknown option/);
	assert.throws(() => parseCliArgs(["--model"]), /requires/);
	assert.throws(() => parseCliArgs(["--model", "--verbose"]), /requires/);
	assert.throws(() => parseCliArgs(["--timeout-ms"]), /requires/);
	assert.throws(() => parseCliArgs(["--timeout-ms", "0"]), /positive integer/);
	assert.throws(() => parseCliArgs(["--timeout-ms", "1.5"]), /positive integer/);
});

test("fake lifecycle agent-browser reports the canonical upstream version without runtime state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-fake-version-"));
	const scriptPath = join(directory, "agent-browser");
	try {
		await writeFile(scriptPath, lifecycleModule.fakeAgentBrowserScript(), "utf8");
		for (const args of [["--version"], ["--allow-file-access", "false", "--version"]]) {
			const { stdout } = await execFile(process.execPath, [scriptPath, ...args], { env: {} });
			assert.equal(stdout, TARGET_AGENT_BROWSER_VERSION_LABEL);
		}
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("createLifecycleSessionId returns an exact-session-safe id", () => {
	const id = createLifecycleSessionId(4242);
	assert.equal(id, "piab-lifecycle-4242");
	assert.match(id, /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
});

test("buildPiLaunchArgs approves project trust and pins lifecycle launches to the exact session id", () => {
	assert.deepEqual(buildPiLaunchArgs({ model: "zai/glm-5.2", sessionId: "piab-lifecycle-4242" }), [
		"--approve",
		"--model",
		"zai/glm-5.2",
		"--session-id",
		"piab-lifecycle-4242",
	]);
});

test("paneLooksReady accepts exact-session relaunches with non-zero context usage", () => {
	assert.equal(paneLooksReady("~/repo\n↑23k ↓362 R117k 12.0%/200k (auto)                         (zai) glm-5.2 • medium"), true);
	assert.equal(paneLooksReady("~/repo\n↑1k ↓2 R3k 0.0%/200k (auto)                         (zai) glm-5.2 • medium"), true);
	assert.equal(paneLooksReady("~/repo\n0.0%/1.0M (auto)                                          (zai) glm-5.2 • medium"), true);
	assert.equal(paneLooksReady("Working…\n↑23k ↓362 R117k 12.0%/200k"), false);
});

test("tmuxActiveTarget uses the active window instead of a hard-coded pane index", () => {
	assert.equal(tmuxActiveTarget("piab-lifecycle-123"), "piab-lifecycle-123:");
});

test("buildSettingsPayload isolates the configured package source", () => {
	const settings = buildSettingsPayload({ packageDir: "/tmp/pkg", sessionDir: "/tmp/sessions" });

	assert.equal(settings.quietStartup, false);
	assert.equal(settings.sessionDir, "/tmp/sessions");
	assert.deepEqual(settings.packages, ["/tmp/pkg"]);
	assert.deepEqual(settings.extensions, []);
	assert.deepEqual(settings.skills, []);
	assert.deepEqual(settings.prompts, []);
	assert.deepEqual(settings.themes, []);
	assert.equal(settings.enableInstallTelemetry, false);
});

test("parseJsonl and extraction helpers read agent_browser results and sentinel entries", () => {
	const entries = parseJsonl([
		JSON.stringify({ type: "session", id: "piab-lifecycle-4242" }),
		JSON.stringify({ type: "custom", customType: "piab-lifecycle-sentinel", data: { token: "v1" } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "agent_browser", details: { sessionName: "s1", fullOutputPath: "/tmp/a.txt" } } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash", details: { fullOutputPath: "/tmp/ignored.txt" } } }),
		JSON.stringify({ type: "custom", customType: "piab-lifecycle-sentinel", data: { token: "v2" } }),
		"",
	].join("\n"));

	assert.equal(sessionHeaderId(entries), "piab-lifecycle-4242");
	assert.deepEqual(sentinelTokens(entries), ["v1", "v2"]);
	const results = agentBrowserResults(entries);
	assert.equal(results.length, 1);
	assert.equal(results[0]?.details?.sessionName, "s1");
	assert.deepEqual(collectFullOutputPaths(results), ["/tmp/a.txt"]);
});

const failedResumeSnapshot: LifecycleResult = {
	toolCallId: "call_1423577b6db24f3b9b3c6637",
	isError: true,
	content: [{ type: "text", text: "agent-browser could not re-select and verify the intended tab before running the command.\nNext actions:\nInspect tabs for React at https://react.dev/ before continuing after tab drift.\nResult category: failure; failureCategory: tab-drift; Pi tool isError: true." }],
	details: {
		sessionName: "piab-src-02ac2afca195-63810b22",
		resultCategory: "failure",
		failureCategory: "tab-drift",
	},
};

const successfulSnapshot: LifecycleResult = {
	toolCallId: "observed-snapshot",
	isError: false,
	details: { command: "snapshot", resultCategory: "success", data: { origin: "https://react.dev/", snapshot: '- heading "React" [ref=e1]', refs: { e1: { role: "heading", name: "React" } } } },
};

test("lifecycle page checks require successful expected-command observed data, not recovery text or remembered targets", () => {
	assert.equal(matchesSuccessfulPageResult(failedResumeSnapshot, "snapshot", "https://react.dev/"), false);
	assert.equal(matchesSuccessfulPageResult({
		...successfulSnapshot,
		content: [{ type: "text", text: "Warning: active tab is about:blank; prior intended tab was https://react.dev/" }],
		details: { ...successfulSnapshot.details, data: { origin: "about:blank" }, sessionTabTarget: { url: "https://react.dev/" } },
	}, "snapshot", "https://react.dev/"), false);
	assert.equal(matchesSuccessfulPageResult(successfulSnapshot, "snapshot", "https://react.dev/#learn"), true);
	assert.equal(matchesSuccessfulPageResult({ isError: false, details: { command: "open", resultCategory: "success", data: { title: "React", url: "https://react.dev" } } }, "open", "https://react.dev/"), true);
	for (const command of ["open", "snapshot"]) {
		const data = command === "open" ? { url: "https://react.dev/" } : { origin: "https://react.dev/" };
		const valid = { isError: false, details: { command, resultCategory: "success", data } };
		for (const result of [
			{ ...valid, isError: true },
			{ ...valid, isError: undefined },
			{ ...valid, details: { ...valid.details, resultCategory: "failure" } },
			{ ...valid, details: { ...valid.details, resultCategory: undefined } },
			{ ...valid, details: { ...valid.details, command: undefined } },
			{ ...valid, details: { ...valid.details, command: "get" } },
			{ ...valid, details: { ...valid.details, data: undefined, sessionTabTarget: { url: "https://react.dev/" } } },
			{ ...valid, details: { ...valid.details, data: command === "open" ? { origin: "https://react.dev/" } : { url: "https://react.dev/" } } },
			{ ...valid, details: { ...valid.details, data: command === "open" ? { url: "https://react.dev/learn" } : { origin: "https://react.dev/learn" } } },
		]) assert.equal(matchesSuccessfulPageResult(result, command, "https://react.dev/"), false, JSON.stringify(result));
	}
});

function lifecycleResultLine(result: LifecycleResult): string {
	return `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "agent_browser", ...result } })}\n`;
}

for (const laterSuccess of [false, true]) {
	test(`lifecycle wait rejects the first completed mismatch instead of ${laterSuccess ? "choosing a later success" : "timing out"}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-results-"));
		const sessionFile = join(directory, "session.jsonl");
		try {
			await writeFile(sessionFile, lifecycleResultLine(successfulSnapshot) + lifecycleResultLine(failedResumeSnapshot) + (laterSuccess ? lifecycleResultLine(successfulSnapshot) : ""));
			await assert.rejects(waitForAgentBrowserResult({
				describe: "same-page snapshot", sessionFile, timeoutMs: 20, sinceCount: 1,
				predicate: (result) => result.toolCallId === successfulSnapshot.toolCallId,
			}), /Unexpected agent_browser result.*call_1423577b6db24f3b9b3c6637.*category failure\/tab-drift/);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
}

test("lifecycle wait validates the completed row outside polling's exception handler", async () => {
	const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-results-"));
	const sessionFile = join(directory, "session.jsonl");
	try {
		await writeFile(sessionFile, lifecycleResultLine(failedResumeSnapshot));
		await assert.rejects(waitForAgentBrowserResult({
			describe: "throwing assertion", sessionFile, timeoutMs: 20, sinceCount: 0,
			predicate: () => { throw new Error("stage assertion failed"); },
		}), /^Error: stage assertion failed$/);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("lifecycle wait discovers the initial transcript for observed open validation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-results-"));
	const sessionFile = join(directory, "session.jsonl");
	try {
		await writeFile(sessionFile, lifecycleResultLine({ isError: false, details: { command: "open", resultCategory: "success", data: { url: "https://react.dev/" } } }));
		const opened = await waitForAgentBrowserResult({
			describe: "initial open", sessionDir: directory, timeoutMs: 2000, sinceCount: 0,
			predicate: (result) => matchesSuccessfulPageResult(result, "open", "https://react.dev/"),
		});
		assert.equal(opened.sessionFile, sessionFile);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("lifecycle wait accepts a newly appended expected QA failure using the original stage predicate", async () => {
	const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-results-"));
	const sessionFile = join(directory, "session.jsonl");
	try {
		await writeFile(sessionFile, "");
		const qaFailure = { toolCallId: "expected-qa-failure", isError: true, details: { resultCategory: "failure", failureCategory: "qa-failure" } };
		const waiting = waitForAgentBrowserResult({
			describe: "QA failure patch", sessionFile, timeoutMs: 2000, sinceCount: 0,
			predicate: (result) => result?.details?.failureCategory === "qa-failure" && result?.details?.resultCategory === "failure" && result?.isError === true,
		});
		await appendFile(sessionFile, lifecycleResultLine(qaFailure));
		assert.equal((await waiting).result.toolCallId, qaFailure.toolCallId);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("collectFullOutputPaths de-duplicates primary and secondary spill paths", () => {
	assert.deepEqual(
		collectFullOutputPaths([
			{ details: { fullOutputPath: "/tmp/a.txt", fullOutputPaths: ["/tmp/a.txt", "/tmp/b.txt"] } },
			{ details: { fullOutputPath: "/tmp/b.txt" } },
		]),
		["/tmp/a.txt", "/tmp/b.txt"],
	);
});

test("parseJsonl reports malformed session transcript lines", () => {
	assert.throws(() => parseJsonl('{"ok":true}\nnot-json'), /Invalid JSONL at line 2/);
});

test("injectLifecycleSentinelSource inserts and replaces deterministic command token", () => {
	const source = 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nexport default function agentBrowserExtension(pi: ExtensionAPI) {\n\tpi.registerTool({ name: "agent_browser" });\n}\n';
	const v1 = injectLifecycleSentinelSource(source, "v1");
	assert.match(v1, /registerCommand\("piab-lifecycle-sentinel-v1"/);
	assert.match(v1, /token: "v1"/);

	const v2 = injectLifecycleSentinelSource(v1, "v2");
	assert.doesNotMatch(v2, /token: "v1"/);
	assert.match(v2, /registerCommand\("piab-lifecycle-sentinel-v2"/);
	assert.match(v2, /token: "v2"/);
	assert.equal((v2.match(/PIAB_LIFECYCLE_SENTINEL_START/g) ?? []).length, 1);
});

test("injectLifecycleSentinelSource requires the extension factory marker", () => {
	assert.throws(() => injectLifecycleSentinelSource("export default {}", "v1"), /factory marker/);
});

test("isDirectRun matches file URL for argv[1] only", () => {
	const scriptPath = "/tmp/verify-lifecycle.mjs";
	assert.equal(isDirectRun(pathToFileURL(scriptPath).href, ["node", scriptPath]), true);
	assert.equal(isDirectRun(pathToFileURL(scriptPath).href, ["node", "/tmp/other.mjs"]), false);
	assert.equal(isDirectRun(pathToFileURL(scriptPath).href, ["node"]), false);
});
