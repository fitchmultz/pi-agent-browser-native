/**
 * Purpose: Verify pure helper behavior for the tmux-driven configured-source lifecycle harness (`npm run verify -- lifecycle`, `scripts/verify-lifecycle.mjs`).
 * Responsibilities: Assert CLI parsing, settings isolation, observed-page checks and JSONL result waits, sentinel source injection, direct-run guarding, and private tmux socket cleanup (against a fake tmux) without launching Pi or tmux.
 * Scope: Unit coverage for `scripts/verify-lifecycle.mjs`; the end-to-end lifecycle path runs only through the explicit `npm run verify -- lifecycle` maintainer command.
 * Usage: Run with `npm test` or as part of `npm run verify`.
 * Invariants/Assumptions: Normal tests must not mutate Pi settings, start tmux, or require a real browser/model configuration.
 */

import assert from "node:assert/strict";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { execFile as execFileCallback } from "node:child_process";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { TARGET_AGENT_BROWSER_VERSION_LABEL } from "../scripts/agent-browser-target.mjs";
import { killTmuxSession, launchPiInTmux } from "../scripts/lifecycle-tmux.mjs";

// Node's execFile has custom promisify semantics; its callback API returns ChildProcess,
// while promisify's ambient callback declaration returns void. Preserve the native adapter.
// oxlint-disable-next-line typescript/strict-void-return
const execFile = promisify(execFileCallback);

type LifecycleResult = {
	readonly toolCallId?: string;
	readonly isError?: boolean;
	readonly content?: readonly { readonly type: string; readonly text: string }[];
	readonly details?: {
		readonly command?: string;
		readonly resultCategory?: string;
		readonly failureCategory?: string;
		readonly data?: unknown;
		readonly sessionName?: string;
		readonly sessionTabTarget?: { readonly url: string };
	};
};

import * as lifecycleModule from "../scripts/verify-lifecycle.mjs";
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
	assert.deepEqual(
		parseCliArgs(["--model", "openai-codex/gpt-5.5:minimal"]).model,
		"openai-codex/gpt-5.5:minimal",
	);
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
			// Keep child execution and its stdout assertion paired before checking the next argv variant.
			// oxlint-disable-next-line no-await-in-loop
			const { stdout } = await execFile(process.execPath, [scriptPath, ...args], { env: {} });
			// Both fixed version argv variants must produce the same canonical native version.
			// oxlint-disable-next-line node-test/no-conditional-assertion
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
	assert.equal(
		paneLooksReady(
			"~/repo\n↑23k ↓362 R117k 12.0%/200k (auto)                         (zai) glm-5.2 • medium",
		),
		true,
	);
	assert.equal(
		paneLooksReady(
			"~/repo\n↑1k ↓2 R3k 0.0%/200k (auto)                         (zai) glm-5.2 • medium",
		),
		true,
	);
	assert.equal(
		paneLooksReady(
			"~/repo\n0.0%/1.0M (auto)                                          (zai) glm-5.2 • medium",
		),
		true,
	);
	assert.equal(paneLooksReady("Working…\n↑23k ↓362 R117k 12.0%/200k"), false);
});

test("tmuxActiveTarget uses the active window instead of a hard-coded pane index", () => {
	assert.equal(tmuxActiveTarget("piab-lifecycle-123"), "piab-lifecycle-123:");
});

// Models observed tmux 3.8 behavior: new-session starts the server, creates its socket and prints the
// socket path for -P; every other command fails once the server is gone; and the socket file remains
// both after kill-server and after the server exits on its own.
const FAKE_TMUX_SCRIPT = `#!/bin/sh
state=$(cat "$FAKE_TMUX_STATE" 2>/dev/null)
case " $* " in
*" new-session "*)
	: > "$FAKE_TMUX_SOCKET"
	echo running > "$FAKE_TMUX_STATE"
	case " $* " in *" -P "*) printf '%s\\n' "$FAKE_TMUX_SOCKET" ;; esac
	exit 0 ;;
esac
if [ "$state" != running ] && [ "$state" != stuck ]; then
	echo "no server running on $FAKE_TMUX_SOCKET" >&2
	exit 1
fi
case " $* " in
*" kill-server "*)
	[ "$state" = stuck ] && exit 1
	echo exited > "$FAKE_TMUX_STATE" ;;
*" display-message "*) printf '%s\\n' "$FAKE_TMUX_SOCKET" ;;
esac
exit 0
`;

for (const [index, scenario] of [
	{ when: "Pi exited and the server then exited on its own", state: "exited", removed: true },
	{ when: "the server is still running", state: "running", removed: true },
	{ when: "kill-server fails while the server still answers", state: "stuck", removed: false },
	{
		when: "the launch reported a socket not named for the private server",
		state: "exited",
		socketName: "default",
		removed: false,
	},
].entries()) {
	test(
		`lifecycle tmux cleanup ${scenario.removed ? "removes" : "keeps"} the launch-reported socket when ${scenario.when}`,
		{ skip: process.platform === "win32" },
		async (t) => {
			const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-tmux-"));
			const originalPath = process.env.PATH;
			t.after(async () => {
				process.env.PATH = originalPath;
				delete process.env.FAKE_TMUX_SOCKET;
				delete process.env.FAKE_TMUX_STATE;
				await rm(directory, { force: true, recursive: true });
			});
			await writeFile(join(directory, "tmux"), FAKE_TMUX_SCRIPT, "utf8");
			await chmod(join(directory, "tmux"), 0o755);
			const tmuxSession = `piab-lifecycle-test-${index}`;
			const socketPath = join(directory, scenario.socketName ?? tmuxSession);
			const statePath = join(directory, "state");
			process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
			process.env.FAKE_TMUX_SOCKET = socketPath;
			process.env.FAKE_TMUX_STATE = statePath;
			await launchPiInTmux({
				agentDir: directory,
				cwd: directory,
				fakeBinDir: directory,
				fakeStateDir: directory,
				model: "test/model",
				sessionId: tmuxSession,
				tmuxSession,
			});
			await writeFile(statePath, scenario.state, "utf8");
			await killTmuxSession(tmuxSession);
			const socketRemains = await stat(socketPath).then(
				() => true,
				() => false,
			);
			assert.equal(socketRemains, !scenario.removed);
		},
	);
}

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
	const entries = parseJsonl(
		[
			JSON.stringify({ type: "session", id: "piab-lifecycle-4242" }),
			JSON.stringify({
				type: "custom",
				customType: "piab-lifecycle-sentinel",
				data: { token: "v1" },
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "agent_browser",
					details: { sessionName: "s1", fullOutputPath: "/tmp/a.txt" },
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "agent_browser_code",
					details: { sessionName: "s1" },
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "agent_browser_qa",
					details: { sessionName: "s1" },
				},
			}),
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", toolName: "agent_browser_tools" },
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					details: { fullOutputPath: "/tmp/ignored.txt" },
				},
			}),
			JSON.stringify({
				type: "custom",
				customType: "piab-lifecycle-sentinel",
				data: { token: "v2" },
			}),
			"",
		].join("\n"),
	);

	assert.equal(sessionHeaderId(entries), "piab-lifecycle-4242");
	assert.deepEqual(sentinelTokens(entries), ["v1", "v2"]);
	const results = readArray(agentBrowserResults(entries)).map(readRecord);
	assert.deepEqual(
		results.map((result) => result.toolName),
		["agent_browser", "agent_browser_code", "agent_browser_qa"],
	);
	assert.equal(readRecord(results[0].details).sessionName, "s1");
	assert.deepEqual(collectFullOutputPaths(results), ["/tmp/a.txt"]);
});

const failedResumeSnapshot: LifecycleResult = {
	toolCallId: "call_1423577b6db24f3b9b3c6637",
	isError: true,
	content: [
		{
			type: "text",
			text: "agent-browser could not re-select and verify the intended tab before running the command.\nNext actions:\nInspect tabs for React at https://react.dev/ before continuing after tab drift.\nResult category: failure; failureCategory: tab-drift; Pi tool isError: true.",
		},
	],
	details: {
		sessionName: "piab-src-02ac2afca195-63810b22",
		resultCategory: "failure",
		failureCategory: "tab-drift",
	},
};

const successfulSnapshot: LifecycleResult = {
	toolCallId: "observed-snapshot",
	isError: false,
	details: {
		command: "snapshot",
		resultCategory: "success",
		data: {
			origin: "https://react.dev/",
			snapshot: '- heading "React" [ref=e1]',
			refs: { e1: { role: "heading", name: "React" } },
		},
	},
};

test("lifecycle page checks require successful expected-command observed data, not recovery text or remembered targets", () => {
	assert.equal(
		matchesSuccessfulPageResult(failedResumeSnapshot, "snapshot", "https://react.dev/"),
		false,
	);
	assert.equal(
		matchesSuccessfulPageResult(
			{
				...successfulSnapshot,
				content: [
					{
						type: "text",
						text: "Warning: active tab is about:blank; prior intended tab was https://react.dev/",
					},
				],
				details: {
					...successfulSnapshot.details,
					data: { origin: "about:blank" },
					sessionTabTarget: { url: "https://react.dev/" },
				},
			},
			"snapshot",
			"https://react.dev/",
		),
		false,
	);
	assert.equal(
		matchesSuccessfulPageResult(successfulSnapshot, "snapshot", "https://react.dev/#learn"),
		true,
	);
	assert.equal(
		matchesSuccessfulPageResult(
			{
				isError: false,
				details: {
					command: "open",
					resultCategory: "success",
					data: { title: "React", url: "https://react.dev" },
				},
			},
			"open",
			"https://react.dev/",
		),
		true,
	);
	for (const command of ["open", "snapshot"]) {
		const data =
			command === "open" ? { url: "https://react.dev/" } : { origin: "https://react.dev/" };
		const valid = { isError: false, details: { command, resultCategory: "success", data } };
		for (const result of [
			{ ...valid, isError: true },
			{ ...valid, isError: undefined },
			{ ...valid, details: { ...valid.details, resultCategory: "failure" } },
			{ ...valid, details: { ...valid.details, resultCategory: undefined } },
			{ ...valid, details: { ...valid.details, command: undefined } },
			{ ...valid, details: { ...valid.details, command: "get" } },
			{
				...valid,
				details: {
					...valid.details,
					data: undefined,
					sessionTabTarget: { url: "https://react.dev/" },
				},
			},
			{
				...valid,
				details: {
					...valid.details,
					data:
						command === "open" ? { origin: "https://react.dev/" } : { url: "https://react.dev/" },
				},
			},
			{
				...valid,
				details: {
					...valid.details,
					data:
						command === "open"
							? { url: "https://react.dev/learn" }
							: { origin: "https://react.dev/learn" },
				},
			},
		]) {
			// Every fixed malformed/mismatched page result must fail the lifecycle matcher.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(
				matchesSuccessfulPageResult(result, command, "https://react.dev/"),
				false,
				JSON.stringify(result),
			);
		}
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
			await writeFile(
				sessionFile,
				lifecycleResultLine(successfulSnapshot) +
					lifecycleResultLine(failedResumeSnapshot) +
					(laterSuccess ? lifecycleResultLine(successfulSnapshot) : ""),
			);
			await assert.rejects(
				waitForAgentBrowserResult({
					describe: "same-page snapshot",
					sessionFile,
					timeoutMs: 20,
					sinceCount: 1,
					predicate: (result: unknown) =>
						readRecord(result).toolCallId === successfulSnapshot.toolCallId,
				}),
				/Unexpected agent_browser result.*call_1423577b6db24f3b9b3c6637.*category failure\/tab-drift/,
			);
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
		await assert.rejects(
			waitForAgentBrowserResult({
				describe: "throwing assertion",
				sessionFile,
				timeoutMs: 20,
				sinceCount: 0,
				predicate: () => {
					throw new Error("stage assertion failed");
				},
			}),
			/^Error: stage assertion failed$/,
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("lifecycle wait discovers the initial transcript for observed open validation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-results-"));
	const sessionFile = join(directory, "session.jsonl");
	try {
		await writeFile(
			sessionFile,
			lifecycleResultLine({
				isError: false,
				details: {
					command: "open",
					resultCategory: "success",
					data: { url: "https://react.dev/" },
				},
			}),
		);
		const opened = readRecord(
			await waitForAgentBrowserResult({
				describe: "initial open",
				sessionDir: directory,
				timeoutMs: 2000,
				sinceCount: 0,
				predicate: (result: unknown) =>
					matchesSuccessfulPageResult(result, "open", "https://react.dev/"),
			}),
		);
		// Native find may return mixed separators; assert the discovered file's identity, not its spelling.
		assert.equal(await realpath(readString(opened.sessionFile)), await realpath(sessionFile));
		assert.equal(matchesSuccessfulPageResult(opened.result, "open", "https://react.dev/"), true);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("lifecycle wait accepts a newly appended expected QA failure using the original stage predicate", async () => {
	const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-results-"));
	const sessionFile = join(directory, "session.jsonl");
	try {
		await writeFile(sessionFile, "");
		const qaFailure = {
			toolCallId: "expected-qa-failure",
			isError: true,
			details: { resultCategory: "failure", failureCategory: "qa-failure" },
		};
		const waiting = waitForAgentBrowserResult({
			describe: "QA failure patch",
			sessionFile,
			timeoutMs: 2000,
			sinceCount: 0,
			predicate: (result: unknown) => {
				const row = readRecord(result);
				const details = readRecord(row.details);
				return (
					details.failureCategory === "qa-failure" &&
					details.resultCategory === "failure" &&
					row.isError === true
				);
			},
		});
		await appendFile(sessionFile, lifecycleResultLine(qaFailure));
		assert.equal(readRecord(readRecord(await waiting).result).toolCallId, qaFailure.toolCallId);
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
	assert.throws(() => {
		parseJsonl('{"ok":true}\nnot-json');
	}, /Invalid JSONL at line 2/);
});

test("injectLifecycleSentinelSource inserts and replaces one command inside the compiled extension factory", async () => {
	const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-sentinel-"));
	const checkPath = join(directory, "index.mjs");
	try {
		const source = await readFile(
			new URL("../dist/extensions/agent-browser/index.js", import.meta.url),
			"utf8",
		);
		const sentinelBlock =
			/\n\t\/\/ PIAB_LIFECYCLE_SENTINEL_START[\s\S]*?\n\t\/\/ PIAB_LIFECYCLE_SENTINEL_END\n/;
		let injected = source;
		for (const token of ["v1", "v2"]) {
			injected = readString(injectLifecycleSentinelSource(injected, token));
			// Both ordered sentinel revisions must register their own lifecycle command.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.match(
				injected,
				new RegExp(`pi\\.registerCommand\\("piab-lifecycle-sentinel-${token}"`),
			);
			// Both ordered sentinel revisions must persist their own exact token.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.match(
				injected,
				new RegExp(`pi\\.appendEntry\\("piab-lifecycle-sentinel", \\{ token: "${token}" \\}\\);`),
			);
			// Both sentinel replacements must preserve all unrelated compiled source bytes.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(injected.replace(sentinelBlock, ""), source);
			// Both ordered revisions must retain exactly one injected sentinel start marker.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal((injected.match(/PIAB_LIFECYCLE_SENTINEL_START/g) ?? []).length, 1);
			// Both ordered revisions must retain exactly one injected sentinel end marker.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal((injected.match(/PIAB_LIFECYCLE_SENTINEL_END/g) ?? []).length, 1);
			// The next sentinel revision reuses this path only after the current syntax check.
			// oxlint-disable-next-line no-await-in-loop
			await writeFile(checkPath, injected, "utf8");
			// Check the current revision before its file is replaced by the next injected token.
			// oxlint-disable-next-line no-await-in-loop
			await execFile(process.execPath, ["--check", checkPath]);
		}
		assert.doesNotMatch(injected, /piab-lifecycle-sentinel-v1|token: "v1"/);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
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

test("native lifecycle setup failure cleans its temporary root and retains diagnostics", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "piab-lifecycle-setup-fault-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const browserDir = join(directory, "browser");
	const artifactsDir = join(directory, "artifacts");
	const sdkPath = join(directory, "sdk.mjs");
	await mkdir(browserDir);
	await writeFile(
		sdkPath,
		`import { writeFileSync } from "node:fs";
const envSnapshot = () => JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)));
const originalEnv = envSnapshot();
process.on("exit", () => writeFileSync(${JSON.stringify(join(directory, "env-restored.json"))}, JSON.stringify({
	restored: envSnapshot() === originalEnv
})));
export function createAgentSession() {}
export const SettingsManager = { inMemory() { return {}; } };
export const ModelRuntime = { async create() { return {}; } };
export class DefaultResourceLoader {
	async reload() { throw new Error("injected lifecycle loader failure"); }
}
`,
	);
	const result = await execFile(
		process.execPath,
		[
			"--test",
			fileURLToPath(new URL("./agent-browser.native-lifecycle.test.mjs", import.meta.url)),
		],
		{
			env: {
				...process.env,
				NODE_TEST_CONTEXT: undefined,
				TMPDIR: directory,
				TMP: directory,
				TEMP: directory,
				PI_NATIVE_LIFECYCLE_REQUIRED: "0",
				PI_NATIVE_LIFECYCLE_SDK: sdkPath,
				PI_NATIVE_LIFECYCLE_BROWSER_DIR: browserDir,
				PI_NATIVE_LIFECYCLE_ARTIFACT_DIR: artifactsDir,
			},
			timeout: 10_000,
		},
	).then(
		({ stdout, stderr }) => {
			throw new Error(`The injected loader failure must fail qualification: ${stdout}\n${stderr}`);
		},
		(error: unknown) => readRecord(error),
	);
	assert.equal(result.code, 1);
	assert.match(readString(result.stdout), /injected lifecycle loader failure/);
	assert.deepEqual(
		(await readdir(directory)).filter((name) => name.startsWith("piab-lc-")),
		[],
	);
	assert.deepEqual(JSON.parse(await readFile(join(artifactsDir, "receipts.json"), "utf8")), {
		receipts: [],
	});
	assert.deepEqual(JSON.parse(await readFile(join(directory, "env-restored.json"), "utf8")), {
		restored: true,
	});
});
