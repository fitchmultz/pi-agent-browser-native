/**
 * Purpose: Verify pure helper behavior for the tmux-driven configured-source lifecycle harness (`npm run verify -- lifecycle`, `scripts/verify-lifecycle.mjs`).
 * Responsibilities: Assert CLI parsing, settings isolation shape, JSONL extraction helpers, sentinel source injection, and direct-run guarding without launching Pi or tmux.
 * Scope: Unit coverage for `scripts/verify-lifecycle.mjs`; the end-to-end lifecycle path runs only through the explicit `npm run verify -- lifecycle` maintainer command.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: Normal tests must not mutate Pi settings, start tmux, or require a real browser/model configuration.
 */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

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
	injectLifecycleSentinelSource: (source: string, token: string) => string;
	isDirectRun: (metaUrl: string, argv?: string[]) => boolean;
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
		model: "zai/glm-5.1",
		showHelp: false,
		timeoutMs: 180_000,
		verbose: false,
	});
	assert.deepEqual(parseCliArgs(["--keep-artifacts", "--verbose", "--timeout-ms", "42"]), {
		keepArtifacts: true,
		model: "zai/glm-5.1",
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

test("createLifecycleSessionId returns a Pi 0.79 exact-session-safe id", () => {
	const id = createLifecycleSessionId(4242);
	assert.equal(id, "piab-lifecycle-4242");
	assert.match(id, /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
});

test("buildPiLaunchArgs approves project trust and pins lifecycle launches to the exact session id", () => {
	assert.deepEqual(buildPiLaunchArgs({ model: "zai/glm-5.1", sessionId: "piab-lifecycle-4242" }), [
		"--approve",
		"--model",
		"zai/glm-5.1",
		"--session-id",
		"piab-lifecycle-4242",
	]);
});

test("paneLooksReady accepts exact-session relaunches with non-zero context usage", () => {
	assert.equal(paneLooksReady("~/repo\n↑23k ↓362 R117k 12.0%/200k (auto)                         (zai) glm-5.1 • medium"), true);
	assert.equal(paneLooksReady("~/repo\n↑1k ↓2 R3k 0.0%/200k (auto)                         (zai) glm-5.1 • medium"), true);
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
