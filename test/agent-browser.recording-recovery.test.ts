import assert from "node:assert/strict";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";

import { recoverRecordingStop } from "../extensions/agent-browser/lib/orchestration/browser-run/recording-recovery.js";
import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import type { SessionArtifactManifest } from "../extensions/agent-browser/lib/results/contracts.js";
import {
	applyArtifactChanges,
	getBrowserRecord,
} from "../extensions/agent-browser/lib/browser-transcript.js";
import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

async function withRecorder(
	mode: string,
	run: (options: {
		readonly root: string;
		readonly logPath: string;
		readonly harness: Readonly<Pick<ReturnType<typeof createExtensionHarness>, "tool" | "ctx">>;
		readonly prefix: readonly string[];
		readonly reload: () => Promise<
			Readonly<Pick<ReturnType<typeof createExtensionHarness>, "tool" | "ctx">>
		>;
	}) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "piab-recovery-"));
	const logPath = join(root, "calls.jsonl"),
		statePath = join(root, "state.json");
	await writeFakeAgentBrowserBinary(
		root,
		`const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + '\\n');
const tokens = [];
for (let i = 0; i < args.length; i++) {
  if (['--session', '--namespace'].includes(args[i])) i++;
  else if (args[i] !== '--json') tokens.push(args[i]);
}
let state = { current: null, last: null };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8')); } catch {}
const mode = ${JSON.stringify(mode)};
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
function execute(row) {
  if (row[0] === 'session' && mode === 'query-failed') throw new Error('Native session info unavailable');
  if (row[0] === 'get' && row[1] === 'text' && mode === 'mixed-failure') throw new Error('Unknown ref @e1');
  if (row[0] === 'snapshot') return { url: 'https://recording.test/', snapshot: '- button "Old button" [ref=e1]', refs: { e1: { role: 'button', name: 'Old button' } } };
  if (row[0] === 'session') return { session: 'recorder', namespace: mode === 'namespace-mismatch' ? 'other' : 'scope', active: true, pid: 123,
    runtime: { backgroundPid: process.ppid, socketDir: 'recording-fixture', browserLaunched: true, restoreKey: null, recording: { current: state.current, last: state.last }, browser: { status: 'not-launched', alive: false, pid: null, userDataDir: null, ownership: 'none', tabs: [], error: null } } };
  if (row[0] === 'record' && row[1] === 'start') {
    const started = Date.now() - (mode === 'old-receipt' ? 60000 : 0);
    state.current = { recordingId: 'new-take', path: path.resolve(row[2]), success: null, error: null, frames: 60, capturedFrames: 2, fps: 30,
      capture: { startedAt: new Date(started).toISOString(), endedAt: null, durationMs: 2000, firstFrameAt: new Date(started + 1800).toISOString(), lastFrameAt: new Date(started + 1950).toISOString(), firstFrameAfterMs: 1800, lastFrameAfterMs: 1950, averageFps: 1, maxFrameGapMs: 1800, timestampSource: 'local-receive' },
      output: { frames: 60, fps: 30, encodedFrames: null, durationMs: null, durationSource: 'encoded-frames/fps', heldFrames: 58, droppedFrames: 0, skippedFrames: 0, encoderSucceeded: null }, file: { exists: false, sizeBytes: null } };
    save(); return { started: true, path: state.current.path, recordingId: state.current.recordingId, fps: 30 };
  }
  if (row[0] === 'record' && row[1] === 'stop') {
    const receipt = state.current;
    if (!receipt) throw new Error('No recording in progress');
    fs.writeFileSync(receipt.path, 'video');
    const ended = Date.now() - (mode === 'old-receipt' ? 58000 : 0);
    state.last = { ...receipt, recordingId: mode === 'id-mismatch' ? 'unrelated-take' : receipt.recordingId, success: !['encode-failed', 'timeout-native-failed'].includes(mode), error: ['encode-failed', 'timeout-native-failed'].includes(mode) ? 'Encoder failed: https://recording.test/?authorization_session_id=RECORDING_AUTH_SECRET&state=RECORDING_STATE_SECRET' : null,
      capture: { ...receipt.capture, endedAt: new Date(ended).toISOString() },
      output: { ...receipt.output, encodedFrames: 60, durationMs: 2000, encoderSucceeded: !['encode-failed', 'timeout-native-failed'].includes(mode) }, file: { exists: true, sizeBytes: mode === 'file-mismatch' ? 999 : 5 } };
    if (mode === 'path-mismatch') state.last.path = path.join(path.dirname(receipt.path), 'other.webm');
    if (mode === 'old-receipt') fs.utimesSync(receipt.path, new Date(ended), new Date(ended));
    if (mode === 'pending-reused-path') { state.last = { ...state.last, recordingId: 'older-take', capturedFrames: 999 }; state.current = { ...receipt, capturedFrames: 0 }; }
    else state.current = null;
    if (mode === 'no-recording-no-receipt') state.last = null;
    if (mode === 'stale-batch') state.last.capture.startedAt = new Date(Date.now() - 60000).toISOString();
    save();
    // Publish atomically: a directory watcher can fire on file creation before its content lands.
    fs.writeFileSync(${JSON.stringify(join(root, "stop-ready.tmp"))}, 'ready');
    fs.renameSync(${JSON.stringify(join(root, "stop-ready.tmp"))}, ${JSON.stringify(join(root, "stop-ready"))});
    if (mode === 'encode-failed') return state.last;
    if (!['timeout', 'timeout-native-failed', 'stale-batch'].includes(mode)) throw new Error('No recording in progress');
    setInterval(() => {}, 1000); return undefined;
  }
  return { url: 'https://recording.test/', title: 'Recording fixture' };
}
let output;
if (tokens[0] === 'batch') {
  const raw = tokens.slice(1).filter(value => value !== '--bail');
  const rows = raw.length ? raw.map(row => {
    const quotedStart = /^record start (".*")$/.exec(row);
    return quotedStart ? ['record', 'start', JSON.parse(quotedStart[1])] : row.split(' ');
  }) : JSON.parse(stdin);
  output = [];
  for (const command of rows) {
    try { const result = execute(command); if (result === undefined) break; output.push({ command, success: true, result }); }
    catch (error) { output.push({ command, success: false, error: error.message }); }
  }
} else {
  try { const data = execute(tokens); if (data !== undefined) output = { success: data.success !== false, data, error: data.error }; }
  catch (error) { output = { success: false, error: error.message }; }
}
if (output !== undefined && (tokens[0] !== 'batch' || mode === 'mixed-failure')) { process.stdout.write(JSON.stringify(output)); process.exitCode = Array.isArray(output) ? Number(output.some(row => row.success === false)) : output.success === false ? 1 : 0; }
`,
	);
	try {
		await withPatchedEnv(
			{
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
				HOME: root,
				USERPROFILE: root,
				AGENT_BROWSER_SESSION: undefined,
				AGENT_BROWSER_NAMESPACE: undefined,
				PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1",
			},
			async () => {
				const branch: unknown[] = [];
				let harness = createExtensionHarness({ cwd: root, branch });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const prefix = ["--namespace", "scope", "--session", "recorder"];
				try {
					await run({
						root,
						logPath,
						harness,
						prefix,
						reload: async () => {
							await runExtensionEvent(
								harness.handlers,
								"session_shutdown",
								{ reason: "reload" },
								harness.ctx,
							);
							harness = createExtensionHarness({ cwd: root, branch });
							await runExtensionEvent(
								harness.handlers,
								"session_start",
								{ reason: "resume" },
								harness.ctx,
							);
							return harness;
						},
					});
				} finally {
					await runExtensionEvent(
						harness.handlers,
						"session_shutdown",
						{ reason: "quit" },
						harness.ctx,
					);
				}
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function executeWithRecordingTimeout(
	t: TestContext,
	root: string,
	harness: Readonly<Pick<ReturnType<typeof createExtensionHarness>, "tool" | "ctx">>,
	params: {
		readonly args: readonly string[];
		readonly stdin?: string;
		readonly outputPath: string;
	},
): Promise<Awaited<ReturnType<typeof executeRegisteredTool>>> {
	const controller = new AbortController();
	let markReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	const watcher = watch(root, (_event, filename) => {
		if (filename === "stop-ready") {
			markReady();
		}
	});
	let timeout: NodeJS.Timeout | undefined;
	const watchdog = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error("record stop must reach native dispatch")), 5_000);
	});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = executeRegisteredTool(
		harness.tool,
		harness.ctx,
		{ ...params, timeoutMs: 200 },
		controller.signal,
	);
	try {
		await Promise.race([
			ready,
			watchdog,
			pending.then(() => {
				throw new Error("record stop completed before the controlled timeout");
			}),
		]);
		assert.equal(await readFile(join(root, "stop-ready"), "utf8"), "ready");
		t.mock.timers.tick(200);
		return await pending;
	} finally {
		t.mock.timers.reset();
		watcher.close();
		clearTimeout(timeout);
		controller.abort();
		await Promise.allSettled([pending]);
	}
}

test("code-mode recording recovery retains receipt data without rendering", async () => {
	await withRecorder("no-recording", async ({ root, harness, prefix }) => {
		const path = join(root, "code.webm");
		const started = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: [...prefix, "record", "start", path],
		});
		assert.equal(started.isError, false);
		const processResult = await runAgentBrowserProcess({
			args: ["--json", ...prefix, "record", "stop"],
			cwd: root,
		});
		const result = await recoverRecordingStop({
			modelVisible: false,
			artifactRunStartedAtMs: Date.now() - 1000,
			commandTokens: ["record", "stop"],
			cwd: root,
			namespace: "scope",
			sessionName: "recorder",
			processResult,
			envelope: { success: false, error: "No recording in progress" },
			reservation: {
				absolutePath: path,
				cwd: root,
				path,
				namespace: "scope",
				sessionName: "recorder",
				recordingId: "new-take",
			},
		});
		assert.ok(result);
		assert.equal(result.recovery.healed, true);
		assert.deepEqual(result.presentation.content, []);
		assert.equal(result.presentation.fullOutputPath, undefined);
		assert.equal(readRecord(result.presentation.data).recordingId, "new-take");
	});
});

test("record stop rejects recording outputPath aliases without dispatch", async (t) => {
	await withRecorder("no-recording", async ({ root, logPath, harness, prefix }) => {
		const path = join(root, "capture.webm"),
			media = "recording bytes written before stop";
		const started = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: [...prefix, "record", "start", path],
		});
		assert.equal(started.isError, false, started.content[0]?.text);
		await writeFile(path, media);
		for (const outputPrefix of ["", "@"]) {
			// Both alias rejections share an unchanged live reservation; finish each no-dispatch proof before the next.
			// oxlint-disable-next-line no-await-in-loop
			await t.test(outputPrefix.length === 0 ? "exact" : outputPrefix, async () => {
				await writeFile(logPath, "");
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...prefix, "record", "stop"],
					outputPath: `${outputPrefix}${path}`,
				});
				assert.equal(result.isError, true);
				assert.match(result.content[0]?.text ?? "", /reserved by an active recording/);
				assert.deepEqual(await readInvocationLog(logPath), []);
				assert.equal(await readFile(path, "utf8"), media);
				assert.equal(readRecord(result.details).outputFile, undefined);
			});
		}
	});
});

for (const mode of [
	"timeout",
	"no-recording",
	"no-recording-no-receipt",
	"old-receipt",
	"pending-reused-path",
	"id-mismatch",
	"namespace-mismatch",
	"path-mismatch",
	"file-mismatch",
	"query-failed",
	"timeout-native-failed",
	"encode-failed",
]) {
	test(`record stop receipt recovery: ${mode}`, { concurrency: false }, async (t) => {
		await withRecorder(mode, async ({ root, logPath, harness: initialHarness, prefix, reload }) => {
			let harness = initialHarness;
			const started = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "record", "start", join(root, "capture.webm")],
			});
			assert.equal(started.isError, false, started.content[0]?.text);
			if (mode === "old-receipt") {
				harness.ctx.sessionManager.getBranch().push(
					createToolBranchEntry({
						details: readRecord(started.details),
						isError: started.isError,
					}),
				);
				harness = await reload();
			}
			await writeFile(logPath, "");
			const outputPath = join(root, "receipt.json");
			const params = {
				args: [...prefix, "--json", "record", "stop"],
				outputPath,
			};
			const timedOut = ["timeout", "timeout-native-failed"].includes(mode);
			const result = timedOut
				? await executeWithRecordingTimeout(t, root, harness, params)
				: await executeRegisteredTool(harness.tool, harness.ctx, params);
			const healed = ["timeout", "no-recording", "old-receipt"].includes(mode);
			const text = readString(readRecord(result.content[0]).text);
			assert.equal(result.isError, !healed, text);
			const visible = readRecord(JSON.parse(text));
			assert.equal(visible.success, healed);
			const exported = readRecord(JSON.parse(await readFile(outputPath, "utf8")));
			assert.equal(exported.success, healed);
			assert.equal(readRecord(exported.attempt).success, false);
			assert.equal(readRecord(exported.attempt).timedOut, timedOut);
			assert.equal(readRecord(readArray(exported.artifacts)[0]).exists, true);
			const recovery = exported.recordingRecovery;
			const artifact = readRecord(readArray(exported.artifacts)[0]);
			const verification = readRecord(exported.artifactVerification);
			if (mode !== "encode-failed") {
				// All receipt-recovery variants require this evidence; common outcomes are asserted above.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(recovery).healed, healed);
				const calls = (await readInvocationLog(logPath)).map((row) =>
					extractUpstreamCommandTokens(row.args),
				);
				// Every receipt-recovery variant must perform exactly one bounded recovery lookup.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(
					calls,
					[
						["session", "info"],
						["record", "stop"],
						["session", "info"],
					],
					"one bootstrap inspection and one bounded receipt recovery, no page probe or repeated stop",
				);
			}
			if (healed) {
				// The healed fixture must verify its matched receipt; other variants assert failure below.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(verification.verified, true);
				// This declared recovery variant must retain the new take's identity.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(artifact.recording).recordingId, "new-take");
				// The healed fixture must retain independently supplied native capture measurements.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(readRecord(artifact.recording).capture).averageFps, 1);
			}
			if (mode === "pending-reused-path") {
				// The pending reused-path fixture must not attribute the last receipt to this take.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(recovery).status, "pending");
				// This declared recovery variant must retain the new take's identity.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(artifact.recording).recordingId, "new-take");
				// The pending reused-path fixture must retain zero new-take frames.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(
					readRecord(artifact.recording).capturedFrames,
					0,
					"last receipt's frames cannot be attributed to the new take at the same path",
				);
				// The pending reused-path fixture must remain pending, not verified.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(verification.pendingCount, 1);
			}
			if (
				[
					"id-mismatch",
					"namespace-mismatch",
					"path-mismatch",
					"no-recording-no-receipt",
					"query-failed",
				].includes(mode)
			) {
				// Each declared mismatched-receipt variant must remain unverified.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(verification.verified, false);
				// Each declared missing/mismatched identity variant must reject the unrelated receipt.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(recovery).receipt, undefined);
				// Each mismatched-receipt fixture must retain the original native no-recording failure.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(result.details).failureCategory, "upstream-error");
			}
			if (mode === "no-recording-no-receipt") {
				// The no-recording/no-receipt fixture cannot prove an existing file is a valid take.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(artifact.status, "unverified");
				// The no-receipt fixture must retain its explicitly unknown encoder outcome.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(artifact.recording).success, null);
				const manifest = readRecord(readRecord(result.details).artifactManifest);
				// The no-receipt fixture still records on-disk presence without claiming verification.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(
					readArray(manifest.entries)
						.map(readRecord)
						.find((entry) => readString(entry.path).endsWith("capture.webm"))?.exists,
					true,
				);
			}
			if (mode === "file-mismatch") {
				// The file-mismatch fixture must reject the receipt's incompatible artifact evidence.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(recovery).status, "unverified");
				// Each declared mismatched-receipt variant must remain unverified.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(verification.verified, false);
			}
			if (["encode-failed", "timeout-native-failed"].includes(mode)) {
				// Both explicitly failed-encoder variants must retain native failure evidence.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(readRecord(artifact.recording).success, false);
			}
		});
	});
}

test(
	"recording failure secrets stay redacted in retained public manifests",
	{ concurrency: false },
	async () => {
		await withRecorder("encode-failed", async ({ root, harness, prefix }) => {
			const path = join(root, "capture.webm");
			const started = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "record", "start", path],
			});
			assert.equal(started.isError, false, started.content[0]?.text);
			const stopped = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "record", "stop"],
			});
			assert.equal(stopped.isError, true);
			const followup = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "get", "url"],
			});
			assert.equal(followup.isError, false, followup.content[0]?.text);
			for (const result of [stopped, followup]) {
				// Both fixed stop/follow-up results must redact the credential canary.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(JSON.stringify(result).includes("RECORDING_AUTH_SECRET"), false);
				// Both fixed stop/follow-up results must redact the auth-state canary.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(JSON.stringify(result).includes("RECORDING_STATE_SECRET"), false);
			}
			assert.equal(
				followup.details?.artifactManifest,
				undefined,
				"an unrelated read does not copy recording history",
			);
			let retained: SessionArtifactManifest | undefined;
			for (const entry of harness.ctx.sessionManager.getBranch()) {
				retained = applyArtifactChanges(retained, getBrowserRecord(entry)?.event.artifacts);
			}
			for (const manifest of [
				readRecord(stopped.details?.artifactManifest),
				readRecord(retained),
			]) {
				// Both live and replayed manifests must redact the same credential canary.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(JSON.stringify(manifest).includes("RECORDING_AUTH_SECRET"), false);
				// Both live and replayed manifests must redact the same auth-state canary.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(JSON.stringify(manifest).includes("RECORDING_STATE_SECRET"), false);
				const artifact = readArray(manifest.entries)
					.map(readRecord)
					.find((entry) => entry.absolutePath === path);
				// Both fixed manifest variants must contain the captured artifact before payload checks.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(artifact);
				const recording = readRecord(artifact.recording);
				// Both live and replayed manifests must retain the exact take identity.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(recording.recordingId, "new-take");
				// Both live and replayed manifests must retain the exact artifact path.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(recording.path, path);
				// Both live and replayed manifests must retain independently checked file presence.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(artifact.exists, true);
				// Both fixed manifest variants must preserve the useful error with secrets redacted.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(
					decodeURIComponent(readString(recording.error)),
					"Encoder failed: https://recording.test/?authorization_session_id=[REDACTED]&state=[REDACTED]",
				);
			}
			assert.equal(await readFile(path, "utf8"), "video");
		});
	},
);

test(
	"a recovered later stop preserves the earlier failed batch step's repair action",
	{ concurrency: false },
	async () => {
		await withRecorder("mixed-failure", async ({ root, harness, prefix }) => {
			const started = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "record", "start", join(root, "mixed.webm")],
			});
			assert.equal(started.isError, false, started.content[0]?.text);
			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "snapshot", "-i"],
			});
			assert.equal(snapshot.isError, false, snapshot.content[0]?.text);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "batch"],
				stdin: JSON.stringify([
					["snapshot", "-i"],
					["get", "text", "@e1"],
					["record", "stop"],
				]),
			});
			assert.equal(result.isError, true);
			assert.equal(readRecord(result.details).failureCategory, "stale-ref");
			assert.equal(readRecord(readRecord(result.details).recordingRecovery).status, "recovered");
			assert.equal(readRecord(readRecord(result.details).recordingRecovery).healed, false);
			assert.ok(
				readArray(readRecord(result.details).nextActions)
					.map(readRecord)
					.some((action) => action.id === "refresh-interactive-refs"),
			);
			assert.equal(readRecord(readArray(readRecord(result.details).batchSteps)[2]).success, true);
		});
	},
);

test(
	"a no-recording failure without start metadata still exports an honest empty receipt",
	{ concurrency: false },
	async () => {
		await withRecorder("no-recording", async ({ root, harness, prefix }) => {
			const outputPath = join(root, "empty.json");
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: [...prefix, "--json", "record", "stop"],
				outputPath,
			});
			assert.equal(result.isError, true);
			const payload = readRecord(JSON.parse(await readFile(outputPath, "utf8")));
			assert.equal(payload.success, false);
			assert.equal(payload.data, null);
			assert.equal(readRecord(payload.recordingRecovery).receipt, undefined);
			assert.equal(readRecord(payload.recordingRecovery).healed, false);
			assert.equal(readRecord(JSON.parse(result.content[0]?.text ?? "")).success, false);
		});
	},
);

for (const mode of ["timeout", "stale-batch"]) {
	test(
		`timed-out raw recording batch keeps receipt evidence without claiming other steps succeeded: ${mode}`,
		{ concurrency: false },
		async (t) => {
			await withRecorder(mode, async ({ root, logPath, harness, prefix }) => {
				const path = join(root, "raw.webm"),
					outputPath = join(root, "batch-receipt.json");
				const result = await executeWithRecordingTimeout(t, root, harness, {
					args: [...prefix, "batch", `record start ${JSON.stringify(path)}`, "record stop"],
					stdin: JSON.stringify([
						["record", "start", join(root, "ignored.webm")],
						["record", "stop"],
					]),
					outputPath,
				});
				assert.equal(
					result.isError,
					true,
					"a recording receipt cannot prove all timed-out batch steps succeeded",
				);
				assert.equal(
					readRecord(readRecord(result.details).outputFile).status,
					"saved",
					JSON.stringify(result),
				);
				const exported = readRecord(JSON.parse(await readFile(outputPath, "utf8")));
				assert.equal(readRecord(exported.attempt).timedOut, true);
				assert.equal(
					readRecord(readRecord(exported.recordingRecovery).expected).absolutePath,
					path,
				);
				assert.equal(readRecord(exported.recordingRecovery).healed, false);
				assert.equal(readRecord(exported.artifactVerification).verified, mode === "timeout");
				assert.equal(
					(await readInvocationLog(logPath)).filter(
						(row) => extractUpstreamCommandTokens(row.args)[0] === "session",
					).length,
					2,
					"bootstrap inspection plus receipt recovery",
				);
			});
		},
	);
}
