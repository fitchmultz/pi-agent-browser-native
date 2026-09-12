import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { extractUpstreamCommandTokens } from "../extensions/agent-browser/lib/argv-descriptor.js";
import { createExtensionHarness, createToolBranchEntry, executeRegisteredTool, readInvocationLog, runExtensionEvent, withPatchedEnv, writeFakeAgentBrowserBinary } from "./helpers/agent-browser-harness.js";

async function withRecorder(mode: string, run: (options: {
	root: string;
	logPath: string;
	harness: ReturnType<typeof createExtensionHarness>;
	prefix: string[];
	reload: () => Promise<ReturnType<typeof createExtensionHarness>>;
}) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "piab-recovery-"));
	const logPath = join(root, "calls.jsonl"), statePath = join(root, "state.json");
	await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs'), path = require('node:path');
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
    runtime: { recording: { current: state.current, last: state.last }, browser: { status: 'not-launched', alive: false, pid: null, userDataDir: null, ownership: 'none', tabs: [], error: null } } };
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
    state.last = { ...receipt, recordingId: mode === 'id-mismatch' ? 'unrelated-take' : receipt.recordingId, success: !['encode-failed', 'timeout-native-failed'].includes(mode), error: ['encode-failed', 'timeout-native-failed'].includes(mode) ? 'Encoder failed' : null,
      capture: { ...receipt.capture, endedAt: new Date(ended).toISOString() },
      output: { ...receipt.output, encodedFrames: 60, durationMs: 2000, encoderSucceeded: !['encode-failed', 'timeout-native-failed'].includes(mode) }, file: { exists: true, sizeBytes: mode === 'file-mismatch' ? 999 : 5 } };
    if (mode === 'path-mismatch') state.last.path = path.join(path.dirname(receipt.path), 'other.webm');
    if (mode === 'old-receipt') fs.utimesSync(receipt.path, new Date(ended), new Date(ended));
    if (mode === 'pending-reused-path') { state.last = { ...state.last, recordingId: 'older-take', capturedFrames: 999 }; state.current = { ...receipt, capturedFrames: 0 }; }
    else state.current = null;
    if (mode === 'no-receipt' || mode === 'no-recording-no-receipt') state.last = null;
    if (mode === 'stale-batch') state.last.capture.startedAt = new Date(Date.now() - 60000).toISOString();
    save();
    if (['no-recording', 'no-recording-no-receipt', 'old-receipt', 'mixed-failure'].includes(mode)) throw new Error('No recording in progress');
    if (mode === 'encode-failed') return state.last;
    setInterval(() => {}, 1000); return undefined;
  }
  return { url: 'https://recording.test/', title: 'Recording fixture' };
}
let output;
if (tokens[0] === 'batch') {
  const raw = tokens.slice(1).filter(value => value !== '--bail');
  const rows = raw.length ? raw.map(row => row.split(' ')) : JSON.parse(stdin);
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
else if (tokens[0] === 'batch' && !tokens.includes('record stop')) { /* a timed-out batch deliberately has no result rows */ }
`);
	try {
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, HOME: root, USERPROFILE: root, AGENT_BROWSER_SESSION: undefined, AGENT_BROWSER_NAMESPACE: undefined, PI_AGENT_BROWSER_TEST_CUSTOM_SESSION_INFO: "1" }, async () => {
			const branch: unknown[] = [];
			let harness = createExtensionHarness({ cwd: root, branch });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const prefix = ["--namespace", "scope", "--session", "recorder"];
			try {
				await run({ root, logPath, harness, prefix, reload: async () => {
					await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "reload" }, harness.ctx);
					harness = createExtensionHarness({ cwd: root, branch });
					await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);
					return harness;
				} });
			} finally { await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx); }
		});
	} finally { await rm(root, { recursive: true, force: true }); }
}

for (const mode of ["timeout", "no-recording", "no-recording-no-receipt", "old-receipt", "pending-reused-path", "id-mismatch", "namespace-mismatch", "path-mismatch", "file-mismatch", "no-receipt", "query-failed", "timeout-native-failed", "encode-failed"]) {
	test(`record stop receipt recovery: ${mode}`, { concurrency: false }, async () => {
		await withRecorder(mode, async ({ root, logPath, harness, prefix, reload }) => {
			const started = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "record", "start", join(root, "capture.webm")] });
			assert.equal(started.isError, false, started.content[0]?.text);
			if (mode === "old-receipt") {
				harness.ctx.sessionManager.getBranch().push(createToolBranchEntry({ details: started.details!, isError: started.isError }));
				harness = await reload();
			}
			await writeFile(logPath, "");
			const outputPath = join(root, "receipt.json");
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "--json", "record", "stop"], timeoutMs: 200, outputPath });
			const healed = ["timeout", "no-recording", "old-receipt"].includes(mode);
			assert.equal(result.isError, !healed, result.content[0]?.text);
			const visible = JSON.parse(result.content[0]?.text ?? "");
			assert.equal(visible.success, healed);
			const exported = JSON.parse(await readFile(outputPath, "utf8"));
			assert.equal(exported.success, healed);
			assert.equal(exported.attempt.success, false);
			assert.equal(exported.artifacts[0].exists, true);
			const recovery = exported.recordingRecovery;
			if (mode !== "encode-failed") {
				assert.equal(recovery.healed, healed);
				const calls = (await readInvocationLog(logPath)).map(row => extractUpstreamCommandTokens(row.args));
				assert.deepEqual(calls, [["record", "stop"], ["session", "info"]], "one bounded read-only recovery, no page probe or repeated stop");
			}
			if (healed) {
				assert.equal(exported.artifactVerification.verified, true);
				assert.equal(exported.artifacts[0].recording.recordingId, "new-take");
				assert.equal(exported.artifacts[0].recording.capture.averageFps, 1);
			}
			if (mode === "pending-reused-path") {
				assert.equal(recovery.status, "pending");
				assert.equal(exported.artifacts[0].recording.recordingId, "new-take");
				assert.equal(exported.artifacts[0].recording.capturedFrames, 0, "last receipt's frames cannot be attributed to the new take at the same path");
				assert.equal(exported.artifactVerification.pendingCount, 1);
			}
			if (["id-mismatch", "namespace-mismatch", "path-mismatch", "no-receipt", "query-failed"].includes(mode)) {
				assert.equal(exported.artifactVerification.verified, false);
				assert.equal(recovery.receipt, undefined);
				assert.equal(result.details?.failureCategory, "timeout");
			}
			if (mode === "no-recording-no-receipt") {
				assert.equal(exported.artifacts[0].status, "unverified");
				assert.equal(exported.artifacts[0].recording.success, null);
				const manifest = result.details?.artifactManifest as { entries: Array<{ path: string; exists?: boolean; status?: string }> };
				assert.equal(manifest.entries.find(entry => entry.path.endsWith("capture.webm"))?.exists, true);
			}
			if (mode === "file-mismatch") {
				assert.equal(recovery.status, "unverified");
				assert.equal(exported.artifactVerification.verified, false);
			}
			if (["encode-failed", "timeout-native-failed"].includes(mode)) assert.equal(exported.artifacts[0].recording.success, false);
		});
	});
}

test("a recovered later stop preserves the earlier failed batch step's repair action", { concurrency: false }, async () => {
	await withRecorder("mixed-failure", async ({ root, harness, prefix }) => {
		const started = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "record", "start", join(root, "mixed.webm")] });
		assert.equal(started.isError, false, started.content[0]?.text);
		const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "snapshot", "-i"] });
		assert.equal(snapshot.isError, false, snapshot.content[0]?.text);
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "batch"], stdin: JSON.stringify([["snapshot", "-i"], ["get", "text", "@e1"], ["record", "stop"]]) });
		assert.equal(result.isError, true);
		assert.equal(result.details?.failureCategory, "stale-ref");
		assert.equal((result.details?.recordingRecovery as { status: string }).status, "recovered");
		assert.equal((result.details?.recordingRecovery as { healed: boolean }).healed, false);
		assert.ok((result.details?.nextActions as Array<{ id: string }>).some(action => action.id === "refresh-interactive-refs"));
		assert.equal((result.details?.batchSteps as Array<{ success: boolean }>)[2].success, true);
	});
});

test("a no-recording failure without start metadata still exports an honest empty receipt", { concurrency: false }, async () => {
	await withRecorder("no-recording", async ({ root, harness, prefix }) => {
		const outputPath = join(root, "empty.json");
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "--json", "record", "stop"], outputPath });
		assert.equal(result.isError, true);
		const payload = JSON.parse(await readFile(outputPath, "utf8"));
		assert.equal(payload.success, false);
		assert.equal(payload.data, null);
		assert.equal(payload.recordingRecovery.receipt, undefined);
		assert.equal(payload.recordingRecovery.healed, false);
		assert.equal(JSON.parse(result.content[0]?.text ?? "").success, false);
	});
});

for (const mode of ["timeout", "stale-batch"]) {
	test(`timed-out raw recording batch keeps receipt evidence without claiming other steps succeeded: ${mode}`, { concurrency: false }, async () => {
		await withRecorder(mode, async ({ root, logPath, harness, prefix }) => {
			const path = join(root, "raw.webm"), outputPath = join(root, "batch-receipt.json");
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, "batch", `record start ${path}`, "record stop"], stdin: JSON.stringify([["record", "start", join(root, "ignored.webm")], ["record", "stop"]]), timeoutMs: 200, outputPath });
			assert.equal(result.isError, true, "a recording receipt cannot prove all timed-out batch steps succeeded");
			const exported = JSON.parse(await readFile(outputPath, "utf8"));
			assert.equal(exported.recordingRecovery.expected.absolutePath, path);
			assert.equal(exported.recordingRecovery.healed, false);
			assert.equal(exported.artifactVerification.verified, mode === "timeout");
			assert.equal((await readInvocationLog(logPath)).filter(row => extractUpstreamCommandTokens(row.args)[0] === "session").length, 1);
		});
	});
}
