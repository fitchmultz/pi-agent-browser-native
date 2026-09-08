import assert from "node:assert/strict";
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { prepareAgentBrowserArgs } from "../extensions/agent-browser/lib/orchestration/browser-run/prepare.js";
import type { FileArtifactMetadata } from "../extensions/agent-browser/lib/results/contracts.js";
import { buildToolPresentation } from "../extensions/agent-browser/lib/results/presentation.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

// Complete 1×1 images, independently decoded by macOS ImageIO when the fixtures were prepared.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const gif = Buffer.from("R0lGODdhAQABAJEAAAAAAP8AAP///wAAACH5BAkAAAMALAAAAAABAAEAAAICTAEAOw==", "base64");
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z", "base64");
const pageUrl = "https://artifact.example.test/current";

async function withFixture(run: (root: string, harness: ReturnType<typeof createExtensionHarness>, log: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "ad-"));
	const log = join(root, "calls.jsonl");
	await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), stdin = fs.readFileSync(0, 'utf8'), tokens = [];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + '\\n');
for (let i = 0; i < args.length; i++) {
  if (['--session', '--namespace', '--user-agent'].includes(args[i])) i++;
  else if (args[i] !== '--json') tokens.push(args[i]);
}
function execute(row) {
  const [command, subcommand] = row;
  if (command === 'wait' && row.includes('Never')) throw new Error('Timed out waiting for Never');
  if (command === 'record') {
    if (row[2]?.includes('fail')) throw new Error('Recording already active');
    return { path: row[2], restarted: subcommand === 'restart' };
  }
  if (command === 'screenshot' || command === 'download' || command === 'network') {
    const output = command === 'download' ? row[2] : command === 'network' ? row[3] : row[1];
    fs.writeFileSync(output, command === 'screenshot' ? Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64') : '{}');
    return { path: command === 'download' || output.includes('canonical') ? fs.realpathSync(output) : output };
  }
  if (command === 'snapshot') return { origin: ${JSON.stringify(pageUrl)}, snapshot: '- textbox "Name" [ref=e1]', refs: { e1: { role: 'textbox', name: 'Name' } } };
  if (command === 'eval') return { result: { status: 'no-anchor' } };
  if (command === 'close') return { closed: true };
  return { url: ${JSON.stringify(pageUrl)}, title: 'Current page', value: 'Name' };
}
if (tokens[0] === 'batch') {
  if (stdin.includes('unparseable.webm')) { process.stdout.write('not JSON'); process.exit(1); }
  if (stdin.includes('unidentified.webm')) { process.stdout.write(JSON.stringify([{ success: false, error: 'Unidentified failed row' }])); process.exit(1); }
  const raw = tokens.slice(1).filter(token => token !== '--bail');
  const steps = raw.length ? JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "raw-steps.json"))}, 'utf8')) : JSON.parse(stdin);
  const results = [];
  for (const command of steps) {
    try { results.push({ command, success: true, result: execute(command) }); }
    catch (error) { results.push({ command, success: false, error: error.message }); process.exitCode = 1; if (tokens.includes('--bail')) break; }
  }
  process.stdout.write(JSON.stringify(results));
} else {
  try { process.stdout.write(JSON.stringify({ success: true, data: execute(tokens) })); }
  catch (error) { process.stdout.write(JSON.stringify({ success: false, error: error.message })); process.exitCode = 1; }
}`);
	try {
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH ?? ""}` }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			try { await run(root, harness, log); }
			finally { await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx); }
		});
	} finally { await rm(root, { recursive: true, force: true }); }
}

for (const command of ["screenshot", "download"]) {
	for (const mode of ["direct", "stdin", "raw"]) {
		test(`artifact mkdir failure is structured before dispatch: ${command}/${mode}`, { concurrency: false }, async () => {
			await withFixture(async (root, harness, log) => {
				const parent = join(root, "not-a-directory");
				await writeFile(parent, "existing file");
				const step = command === "screenshot" ? [command, "not-a-directory/out.png"] : [command, "#download", "not-a-directory/out.txt"];
				const params = mode === "direct" ? { args: ["--json", ...step] } : mode === "stdin" ? { args: ["batch"], stdin: JSON.stringify([step]) } : { args: ["batch", step.join(" ")] };
				const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
				assert.equal(result.isError, true);
				assert.equal(result.details?.failureCategory, "validation-error");
				assert.equal(result.details?.agentBrowserStarted, false);
				assert.ok(String(result.details?.validationError).includes(parent));
				assert.match(result.content[0]?.text ?? "", /writable.*director/i);
				assert.deepEqual((result.details?.nextActions as Array<{ artifactPath?: string; id: string }>).map(({ artifactPath, id }) => ({ artifactPath, id })), [{ artifactPath: parent, id: "verify-artifact-path" }]);
				assert.deepEqual(await readInvocationLog(log), []);
				assert.equal(await readFile(parent, "utf8"), "existing file");
			});
		});
	}
}

test("artifact preparation errors keep credential-like path text redacted", { concurrency: false }, async () => {
	await withFixture(async (root, harness, log) => {
		const parent = join(root, "Bearer directory-secret");
		await writeFile(parent, "existing file");
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", join(parent, "out.png")] });
		assert.equal(result.details?.failureCategory, "validation-error");
		assert.doesNotMatch(JSON.stringify(result), /directory-secret/);
		assert.deepEqual(await readInvocationLog(log), []);
		assert.equal(await readFile(parent, "utf8"), "existing file");
	});
});

test("cancelled artifact preparation does not become a validation failure", { concurrency: false }, async () => {
	await withFixture(async (root, harness, log) => {
		await writeFile(join(root, "blocked"), "existing file");
		const controller = new AbortController();
		const reason = new Error("Cancelled artifact request");
		controller.abort(reason);
		await assert.rejects(executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", "blocked/out.png"] }, controller.signal), (error) => error === reason);
		assert.deepEqual(await readInvocationLog(log), []);
	});
});

test("raw artifact preparation preserves quoted argv and ignores displaced stdin", { concurrency: false }, async () => {
	await withFixture(async (root, harness, log) => {
		await writeFile(join(root, "blocked"), "existing file");
		const raw = 'screenshot "./raw dir/shot.png"';
		await writeFile(join(root, "raw-steps.json"), JSON.stringify([["screenshot", "./raw dir/shot.png"]]));
		const stdin = JSON.stringify([["screenshot", "blocked/ignored.png"], ["screenshot", "ignored/never.png"]]);
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch", "--bail", raw], stdin });
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.deepEqual(await readFile(join(root, "raw dir/shot.png")), png);
		await assert.rejects(readFile(join(root, "ignored/never.png")), { code: "ENOENT" });
		await assert.rejects(readFile(join(root, "ignored")), { code: "ENOENT" });
		const invocation = (await readInvocationLog(log)).find(({ args }) => args.includes("batch"));
		assert.deepEqual(invocation?.args.slice(-3), ["batch", "--bail", raw]);
		assert.equal(invocation?.stdin, stdin);
	});
});

for (const [name, bytes, mediaType] of [
	["ordinary.png", png, "image/png"], ["ordinary.jpg", jpeg, "image/jpeg"], ["ordinary.gif", gif, "image/gif"], ["ordinary.webp", webp, "image/webp"],
	["png.webm", png, "image/png"], ["gif.png", gif, "image/gif"], ["jpeg.png", jpeg, "image/jpeg"], ["webp.jpg", webp, "image/webp"],
	["unknown.png", Buffer.from("not an image"), undefined], ["truncated.png", png.subarray(0, 15), undefined],
	["truncated.jpg", jpeg.subarray(0, 2), undefined], ["truncated.gif", gif.subarray(0, 5), undefined], ["truncated.webp", webp.subarray(0, 11), undefined],
] as const) {
	test(`artifact MIME and inline image use bytes: ${name}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "ad-"));
		try {
			const path = join(root, name);
			await writeFile(path, bytes);
			const result = await buildToolPresentation({ args: ["screenshot", path], commandInfo: { command: "screenshot" }, cwd: root, envelope: { success: true, data: { path } } });
			assert.equal(result.resultCategory, "success");
			assert.equal(result.artifacts?.[0]?.mediaType, mediaType);
			assert.equal(result.artifactVerification?.artifacts[0]?.mediaType, mediaType);
			assert.equal(result.artifactManifest?.entries[0]?.mediaType, mediaType);
			const image = result.content.find((item) => item.type === "image");
			assert.equal(image?.mimeType, mediaType);
			if (mediaType) assert.deepEqual(Buffer.from(image?.data ?? "", "base64"), bytes);
			else assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /Media type:/);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}

test("image header inspection preserves the inline bound for a large misleading filename", async () => {
	const root = await mkdtemp(join(tmpdir(), "ad-"));
	try {
		const path = join(root, "large.webm");
		const file = await open(path, "w");
		try { await file.write(png); await file.truncate(64 * 1024 * 1024); }
		finally { await file.close(); }
		const result = await buildToolPresentation({ commandInfo: { command: "screenshot" }, cwd: root, envelope: { success: true, data: { path } } });
		assert.equal(result.artifacts?.[0]?.mediaType, "image/png");
		assert.equal(result.content.some((item) => item.type === "image"), false);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Image attachment skipped:.*inline limit/);
		assert.equal(result.imagePath, path);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct artifacts recover requested paths across native outer global flags", async () => {
	const root = await mkdtemp(join(tmpdir(), "ad-"));
	try {
		const path = join(root, "file.txt");
		await writeFile(path, "downloaded bytes");
		const result = await buildToolPresentation({
			args: ["--namespace", "tenant", "download", "--quiet", "#download", "./file.txt"],
			commandInfo: { command: "download" }, cwd: root, envelope: { success: true, data: { path } },
		});
		assert.equal(result.artifacts?.[0]?.requestedPath, "./file.txt");
		assert.equal(result.artifacts?.[0]?.absolutePath, path);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Requested path: \.\/file\.txt/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const [command, path] of [
	[["pdf", "--quick", "ignored/page.pdf"], "--quick"],
	[["download", "#download", "--quiet", "ignored/file.txt"], "--quiet"],
	[["screenshot", "body", "--screenshot-dir", "ignored/shot.png"], "--screenshot-dir"],
] as const) {
	test(`batch artifact presentation keeps literal global-looking operands: ${command[0]}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "ad-"));
		try {
			const absolutePath = join(root, path);
			await writeFile(absolutePath, "saved bytes");
			const result = await buildToolPresentation({ commandInfo: { command: "batch" }, cwd: root, envelope: { success: true, data: [
				{ command: [...command], success: true, result: { path: absolutePath } },
			] } });
			assert.equal(result.batchSteps?.[0]?.artifacts?.[0]?.requestedPath, path);
			assert.equal(result.batchSteps?.[0]?.artifacts?.[0]?.absolutePath, absolutePath);
			assert.equal(result.batchSteps?.[0]?.artifactVerification?.verifiedCount, 1);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test(`batch artifact preparation keeps native operands and leaves ignored directories absent: ${command[0]}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "ad-"));
		try {
			const stdin = JSON.stringify([command]);
			const prepared = await prepareAgentBrowserArgs(["batch"], stdin, root);
			const expected = command[0] === "screenshot" ? ["screenshot", "body", join(root, path), command[3]] : [...command];
			assert.deepEqual(JSON.parse(prepared.stdin ?? stdin), [expected]);
			await assert.rejects(stat(join(root, "ignored")), { code: "ENOENT" });
			const raw = ["batch", command.join(" ")];
			assert.deepEqual((await prepareAgentBrowserArgs(raw, stdin, root)).args, raw);
			await assert.rejects(stat(join(root, "ignored")), { code: "ENOENT" });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test(`batch artifact preflight reserves the literal native destination: ${command[0]}`, { concurrency: false }, async () => {
		await withFixture(async (_root, harness) => {
			for (const params of [{ args: ["batch"], stdin: JSON.stringify([command]) }, { args: ["batch", command.join(" ")] }]) {
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { ...params, outputPath: path });
				assert.equal(result.details?.failureCategory, "validation-error", JSON.stringify(result));
				assert.ok(result.content[0]?.text?.includes(`same destination as artifact path ${path}`));
			}
		});
	});
}

test("batch screenshot normalization preserves a literal double-dash selector", async () => {
	const root = await mkdtemp(join(tmpdir(), "ad-"));
	try {
		const prepared = await prepareAgentBrowserArgs(["batch"], JSON.stringify([["screenshot", "--", "nested/capture.png"]]), root);
		assert.deepEqual(JSON.parse(prepared.stdin ?? "[]"), [["screenshot", "--", join(root, "nested/capture.png")]]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("registered artifacts retain requested and reported paths without new argv normalization", { concurrency: false }, async () => {
	await withFixture(async (root, harness, log) => {
		const canonicalRoot = await realpath(root);
		const lexicalRoot = process.platform === "darwin" ? canonicalRoot.replace(/^\/private\/tmp\//, "/tmp/") : root;
		if (process.platform === "darwin") assert.notEqual(lexicalRoot, canonicalRoot, "exercise the native /tmp alias");
		for (const step of [["screenshot", "screen.png"], ["screenshot", "canonical.png"], ["screenshot", "png.webm"], ["download", "#download", "download.txt"], ["network", "har", "stop", "network.har"]]) {
			const requestedPath = join(lexicalRoot, step.at(-1)!);
			const args = [...step.slice(0, -1), requestedPath];
			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
			assert.equal(result.isError, false, result.content[0]?.text);
			const artifact = (result.details?.artifacts as FileArtifactMetadata[])[0];
			assert.equal(artifact.requestedPath, requestedPath);
			const reportedPath = step[0] === "download" || requestedPath.includes("canonical") ? await realpath(requestedPath) : requestedPath;
			assert.ok([artifact.absolutePath, artifact.tempPath].includes(reportedPath));
			assert.ok((result.content[0]?.text ?? "").includes(`Requested path: ${requestedPath}`));
			assert.ok((result.content[0]?.text ?? "").includes(reportedPath));
			if (step[0] === "screenshot") assert.match(JSON.stringify(result.content), /"mimeType":"image\/png"/);
			const invocation = (await readInvocationLog(log)).reverse().find((row) => row.args.includes(step[0]));
			assert.deepEqual(invocation?.args.slice(-args.length), args);
		}
	});
});

for (const batch of [false, true]) {
	for (const [subcommand, withUrl, fails] of [["start", false, false], ["start", false, true], ["restart", true, false], ["restart", true, true], ["restart", false, false], ["restart", false, true]] as const) {
		test(`recording transition warning follows dispatch: ${batch ? "batch" : "direct"}/${subcommand}/${withUrl}/${fails}`, { concurrency: false }, async () => {
			await withFixture(async (_root, harness) => {
				await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", pageUrl] });
				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
				assert.equal(snapshot.isError, false);
				const step = ["record", subcommand, fails ? "fail.webm" : "ok.webm", ...(withUrl ? [pageUrl] : [])];
				const result = await executeRegisteredTool(harness.tool, harness.ctx, batch ? { args: ["batch", "--bail"], stdin: JSON.stringify([step]) } : { args: step });
				assert.equal(result.isError, fails, result.content[0]?.text);
				const transitions = subcommand === "start" || withUrl;
				assert.equal((result.content[0]?.text?.match(/Page state:/g) ?? []).length, transitions ? 1 : 0);
				if (transitions) {
					assert.match(result.content[0]?.text ?? "", /fresh snapshot/i);
					assert.equal((result.details?.refSnapshotInvalidation as { reason?: string })?.reason, "page-transition");
				} else assert.deepEqual(result.details?.refSnapshot, snapshot.details?.refSnapshot);
				const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "value", "@e1"] });
				assert.equal(read.isError, transitions, read.content[0]?.text);
				if (transitions) assert.equal(read.details?.failureCategory, "stale-ref");
			});
		});
	}
}

test("recording transition warning stays parseable in explicit JSON failures", { concurrency: false }, async () => {
	await withFixture(async (_root, harness) => {
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--json", "record", "start", "fail.webm"] });
		const json = JSON.parse(result.content[0]?.text ?? "");
		assert.equal(json.success, false);
		assert.match(json.error, /Recording already active/);
		assert.equal(json.warnings?.length, 1);
		assert.match(json.warnings[0], /Page state:.*fresh snapshot/);
		const restarted = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--json", "record", "restart", "json-ok.webm", pageUrl] });
		const success = JSON.parse(restarted.content[0]?.text ?? "");
		assert.equal(success.success, true);
		assert.equal(success.warnings?.length, 1);
		assert.match(success.warnings[0], /Page state:.*fresh snapshot/);
	});
});

test("an unparseable recording batch retains conservative ref invalidation without a reached-row warning", { concurrency: false }, async () => {
	await withFixture(async (_root, harness) => {
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: JSON.stringify([["record", "start", "unparseable.webm"]]) });
		assert.equal(result.details?.failureCategory, "parse-failure");
		assert.equal((result.details?.refSnapshotInvalidation as { reason?: string })?.reason, "page-transition");
		assert.doesNotMatch(result.content[0]?.text ?? "", /Page state:/);
	});
});

test("unidentified batch result rows do not turn planned recording steps into navigation evidence", { concurrency: false }, async () => {
	await withFixture(async (_root, harness) => {
		const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: JSON.stringify([["record", "start", "unidentified.webm"]]) });
		assert.equal(result.isError, true);
		assert.equal((result.details?.batchSteps as Array<{ command?: string[] }>)[0]?.command, undefined);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Page state:/);
	});
});

test("recording warnings exclude unreached bail rows, preflight failures and a missing binary", { concurrency: false }, async () => {
	await withFixture(async (root, harness, log) => {
		const bailed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch", "--bail"], stdin: JSON.stringify([["wait", "--text", "Never"], ["record", "start", "unreached.webm"]]) });
		assert.equal(bailed.isError, true);
		assert.equal((bailed.details?.batchSteps as unknown[]).length, 1);
		assert.doesNotMatch(bailed.content[0]?.text ?? "", /Page state:/);
		const before = await readInvocationLog(log);
		const blocked = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: JSON.stringify([["close"], ["record", "start", "blocked.webm"]]) });
		assert.equal(blocked.details?.failureCategory, "validation-error");
		assert.doesNotMatch(blocked.content[0]?.text ?? "", /Page state:/);
		assert.deepEqual(await readInvocationLog(log), before);
		const help = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "--help"] });
		assert.equal(help.isError, false);
		assert.doesNotMatch(help.content[0]?.text ?? "", /Page state:/);
		await rm(join(root, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser"));
		await withPatchedEnv({ PATH: root }, async () => {
			const missing = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["record", "start", "missing.webm"] });
			assert.equal(missing.details?.failureCategory, "missing-binary");
			assert.doesNotMatch(missing.content[0]?.text ?? "", /Page state:/);
		});
	});
});
