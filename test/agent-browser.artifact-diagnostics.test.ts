import assert from "node:assert/strict";
import { readRecord, readArray, readString } from "./helpers/assertions.js";
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { getExplicitArtifactDestination } from "../extensions/agent-browser/lib/orchestration/browser-run/artifact-paths.js";
import { prepareAgentBrowserArgs } from "../extensions/agent-browser/lib/orchestration/browser-run/prepare.js";

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
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);
const gif = Buffer.from(
	"R0lGODdhAQABAJEAAAAAAP8AAP///wAAACH5BAkAAAMALAAAAAABAAEAAAICTAEAOw==",
	"base64",
);
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const jpeg = Buffer.from(
	"/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z",
	"base64",
);
const pageUrl = "https://artifact.example.test/current";

async function withFixture(
	run: (
		root: string,
		harness: Readonly<Pick<ReturnType<typeof createExtensionHarness>, "tool" | "ctx">>,
		log: string,
	) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ad-"));
	const log = join(root, "calls.jsonl");
	await writeFakeAgentBrowserBinary(
		root,
		`const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), stdin = fs.readFileSync(0, 'utf8'), tokens = [];
const activeTake = ${JSON.stringify(join(root, "active-take"))};
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
    // Native restart finalizes the active take now, so its file must change inside this command window.
    if (subcommand === 'restart' && fs.existsSync(activeTake)) fs.writeFileSync(fs.readFileSync(activeTake, 'utf8'), 'recording bytes');
    fs.writeFileSync(row[2], 'recording bytes');
    fs.writeFileSync(activeTake, path.resolve(row[2]));
    return { path: row[2], restarted: subcommand === 'restart' };
  }
  if (command === 'screenshot' || command === 'download' || command === 'network') {
    const output = command === 'download' ? row[2] : command === 'network' ? row[3] : row[2] ?? row[1];
    fs.writeFileSync(output, command === 'screenshot' ? Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64') : '{}');
    return { path: command === 'download' || output.includes('canonical') ? fs.realpathSync.native(output) : output };
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
    if (command.length === 0) continue; // Native skips empty rows without a result placeholder.
    try { results.push({ command, success: true, result: execute(command) }); }
    catch (error) { results.push({ command, success: false, error: error.message }); process.exitCode = 1; if (tokens.includes('--bail')) break; }
  }
  process.stdout.write(JSON.stringify(results));
} else {
  try { process.stdout.write(JSON.stringify({ success: true, data: execute(tokens) })); }
  catch (error) { process.stdout.write(JSON.stringify({ success: false, error: error.message })); process.exitCode = 1; }
}`,
	);
	try {
		await withPatchedEnv({ PATH: `${root}${delimiter}${process.env.PATH ?? ""}` }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			try {
				await run(root, harness, log);
			} finally {
				await runExtensionEvent(
					harness.handlers,
					"session_shutdown",
					{ reason: "quit" },
					harness.ctx,
				);
			}
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("artifact mkdir failures reject direct, stdin and raw commands before dispatch", async (t) => {
	await withFixture(async (root, harness, log) => {
		const parent = join(root, "not-a-directory");
		await writeFile(parent, "existing file");
		for (const command of ["screenshot", "download"]) {
			for (const mode of ["direct", "stdin", "raw"]) {
				// Each subtest observes the same protected file only after the preceding preflight finishes.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(
					`artifact mkdir failure is structured before dispatch: ${command}/${mode}`,
					async () => {
						const step =
							command === "screenshot"
								? [command, "not-a-directory/out.png"]
								: [command, "#download", "not-a-directory/out.txt"];
						let params: { readonly args: readonly string[]; readonly stdin?: string };
						if (mode === "direct") {
							params = { args: ["--json", ...step] };
						} else if (mode === "stdin") {
							params = { args: ["batch"], stdin: JSON.stringify([step]) };
						} else {
							params = { args: ["batch", step.join(" ")] };
						}
						const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
						assert.equal(result.isError, true);
						assert.equal(readRecord(result.details).failureCategory, "validation-error");
						assert.equal(readRecord(result.details).agentBrowserStarted, false);
						assert.ok(readString(readRecord(result.details).validationError).includes(parent));
						assert.match(result.content[0]?.text ?? "", /writable.*director/i);
						assert.deepEqual(
							readArray(readRecord(result.details).nextActions)
								.map(readRecord)
								.map(({ artifactPath, id }) => ({ artifactPath, id })),
							[{ artifactPath: parent, id: "verify-artifact-path" }],
						);
						assert.deepEqual(await readInvocationLog(log), []);
						assert.equal(await readFile(parent, "utf8"), "existing file");
					},
				);
			}
		}
	});
});

test(
	"artifact preparation errors keep credential-like path text redacted",
	{ concurrency: false },
	async () => {
		await withFixture(async (root, harness, log) => {
			const parent = join(root, "Bearer directory-secret");
			await writeFile(parent, "existing file");
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["screenshot", join(parent, "out.png")],
			});
			assert.equal(readRecord(result.details).failureCategory, "validation-error");
			assert.doesNotMatch(JSON.stringify(result), /directory-secret/);
			assert.deepEqual(await readInvocationLog(log), []);
			assert.equal(await readFile(parent, "utf8"), "existing file");
		});
	},
);

test(
	"cancelled artifact preparation does not become a validation failure",
	{ concurrency: false },
	async () => {
		await withFixture(async (root, harness, log) => {
			await writeFile(join(root, "blocked"), "existing file");
			const controller = new AbortController();
			const reason = new Error("Cancelled artifact request");
			controller.abort(reason);
			const result = await executeRegisteredTool(
				harness.tool,
				harness.ctx,
				{ args: ["screenshot", "blocked/out.png"] },
				controller.signal,
			);
			assert.equal(result.isError, true);
			assert.equal(readRecord(result.details).failureCategory, "aborted");
			assert.match(result.content[0]?.text ?? "", /Cancelled artifact request/);
			assert.deepEqual(await readInvocationLog(log), []);
		});
	},
);

test(
	"raw artifact preparation preserves quoted argv and ignores displaced stdin",
	{ concurrency: false },
	async () => {
		await withFixture(async (root, harness, log) => {
			await writeFile(join(root, "blocked"), "existing file");
			const raw = 'screenshot "./raw dir/shot.png"';
			await writeFile(
				join(root, "raw-steps.json"),
				JSON.stringify([["screenshot", "./raw dir/shot.png"]]),
			);
			const stdin = JSON.stringify([
				["screenshot", "blocked/ignored.png"],
				["screenshot", "ignored/never.png"],
			]);
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch", "--bail", raw],
				stdin,
			});
			assert.equal(result.isError, false, result.content[0]?.text);
			assert.deepEqual(await readFile(join(root, "raw dir/shot.png")), png);
			await assert.rejects(readFile(join(root, "ignored/never.png")), { code: "ENOENT" });
			await assert.rejects(readFile(join(root, "ignored")), { code: "ENOENT" });
			const invocation = (await readInvocationLog(log)).find(({ args }) => args.includes("batch"));
			assert.deepEqual(invocation?.args.slice(-3), ["batch", "--bail", raw]);
			assert.equal(invocation.stdin, stdin);
		});
	},
);

for (const [name, bytes, mediaType] of [
	["ordinary.png", png, "image/png"],
	["ordinary.jpg", jpeg, "image/jpeg"],
	["ordinary.gif", gif, "image/gif"],
	["ordinary.webp", webp, "image/webp"],
	["png.webm", png, "image/png"],
	["gif.png", gif, "image/gif"],
	["jpeg.png", jpeg, "image/jpeg"],
	["webp.jpg", webp, "image/webp"],
	["unknown.png", Buffer.from("not an image"), undefined],
	["truncated.png", png.subarray(0, 15), undefined],
	["truncated.jpg", jpeg.subarray(0, 2), undefined],
	["truncated.gif", gif.subarray(0, 5), undefined],
	["truncated.webp", webp.subarray(0, 11), undefined],
] as const) {
	test(`artifact MIME and inline image use bytes: ${name}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "ad-"));
		try {
			const path = join(root, name);
			await writeFile(path, bytes);
			const result = await buildToolPresentation({
				args: ["screenshot", path],
				commandInfo: { command: "screenshot" },
				cwd: root,
				envelope: { success: true, data: { path } },
			});
			assert.equal(result.resultCategory, "success");
			assert.equal(result.artifacts?.[0]?.mediaType, mediaType);
			assert.equal(result.artifactVerification?.artifacts[0]?.mediaType, mediaType);
			assert.equal(result.artifactManifest?.entries[0]?.mediaType, mediaType);
			const image = result.content.find((item) => item.type === "image");
			assert.equal(image?.mimeType, mediaType);
			if (mediaType !== undefined) {
				// Image-bearing fixtures must retain exact bytes; every fixture checks MIME and classification above.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(Buffer.from(image?.data ?? "", "base64"), bytes);
			} else {
				// The unknown-media fixture must not invent a MIME label; common outcomes are asserted above.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.doesNotMatch(
					result.content[0]?.type === "text" ? result.content[0].text : "",
					/Media type:/,
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("image header inspection preserves the inline bound for a large misleading filename", async () => {
	const root = await mkdtemp(join(tmpdir(), "ad-"));
	try {
		const path = join(root, "large.webm");
		const file = await open(path, "w");
		try {
			await file.write(png);
			await file.truncate(64 * 1024 * 1024);
		} finally {
			await file.close();
		}
		const result = await buildToolPresentation({
			commandInfo: { command: "screenshot" },
			cwd: root,
			envelope: { success: true, data: { path } },
		});
		assert.equal(result.artifacts?.[0]?.mediaType, "image/png");
		assert.equal(
			result.content.some((item) => item.type === "image"),
			false,
		);
		assert.match(
			result.content[0]?.type === "text" ? result.content[0].text : "",
			/Image attachment skipped:.*inline limit/,
		);
		assert.equal(result.imagePath, path);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("direct artifacts recover requested paths across native outer global flags", async () => {
	const root = await mkdtemp(join(tmpdir(), "ad-"));
	try {
		const path = join(root, "file.txt");
		await writeFile(path, "downloaded bytes");
		const result = await buildToolPresentation({
			args: ["--namespace", "tenant", "download", "--quiet", "#download", "./file.txt"],
			commandInfo: { command: "download" },
			cwd: root,
			envelope: { success: true, data: { path } },
		});
		assert.equal(result.artifacts?.[0]?.requestedPath, "./file.txt");
		assert.equal(readRecord(readArray(result.artifacts)[0]).absolutePath, path);
		assert.match(
			result.content[0]?.type === "text" ? result.content[0].text : "",
			/Requested path: \.\/file\.txt/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
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
			const result = await buildToolPresentation({
				commandInfo: { command: "batch" },
				cwd: root,
				envelope: {
					success: true,
					data: [{ command: [...command], success: true, result: { path: absolutePath } }],
				},
			});
			assert.equal(result.batchSteps?.[0]?.artifacts?.[0]?.requestedPath, path);
			assert.equal(
				readRecord(readArray(readRecord(readArray(result.batchSteps)[0]).artifacts)[0])
					.absolutePath,
				absolutePath,
			);
			assert.equal(
				readRecord(readRecord(readArray(result.batchSteps)[0]).artifactVerification).verifiedCount,
				1,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test(`batch artifact preparation keeps native operands and leaves ignored directories absent: ${command[0]}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "ad-"));
		try {
			const stdin = JSON.stringify([command]);
			const prepared = await prepareAgentBrowserArgs(["batch"], stdin, root);
			const expected =
				command[0] === "screenshot"
					? ["screenshot", "body", join(root, path), command[3]]
					: [...command];
			assert.deepEqual(JSON.parse(prepared.stdin ?? stdin), [expected]);
			await assert.rejects(stat(join(root, "ignored")), { code: "ENOENT" });
			const raw = ["batch", command.join(" ")];
			assert.deepEqual((await prepareAgentBrowserArgs(raw, stdin, root)).args, raw);
			await assert.rejects(stat(join(root, "ignored")), { code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test(
		`batch artifact preflight reserves the literal native destination: ${command[0]}`,
		{ concurrency: false },
		async () => {
			await withFixture(async (_root, harness) => {
				for (const params of [
					{ args: ["batch"], stdin: JSON.stringify([command]) },
					{ args: ["batch", command.join(" ")] },
				]) {
					// Preflight checks share native fixture state and retain fail-before-dispatch ordering.
					// oxlint-disable-next-line no-await-in-loop
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						...params,
						outputPath: path,
					});
					// Both fixed raw/stdin batch variants must reject artifact/output destination collisions.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						readRecord(result.details).failureCategory,
						"validation-error",
						JSON.stringify(result),
					);
					// Both batch variants must identify the actual colliding destination.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						result.content[0]?.text?.includes(`same destination as artifact path ${path}`),
						true,
					);
				}
			});
		},
	);
}

test("recording destinations follow FPS operands without consuming literal or ignored values", () => {
	for (const [operands, expected] of [
		[["--fps", "30", "take.webm"], "take.webm"],
		[["--fps", "+24", "take.webm", "--fps", "12", "https://example.com"], "take.webm"],
		[["--fps", "0", "take.webm"], "take.webm"], // Native, not the path reader, validates the range.
		[["take.webm", "https://example.com", "--fps", "30", "ignored"], "take.webm"],
		[["./--fps.webm", "https://example.com/--fps"], "./--fps.webm"],
		[["--fps"], "--fps"],
		[["--fps", "literal.webm"], "--fps"],
		[["--fps", "30"], "--fps"],
	] as const) {
		for (const subcommand of ["start", "restart"]) {
			// Every fixed FPS/operand fixture is checked for both recording subcommands.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(getExplicitArtifactDestination(["record", subcommand, ...operands]), expected);
		}
	}
	assert.equal(getExplicitArtifactDestination(["record", "stop"]), undefined);
});

for (const subcommand of ["start", "restart"]) {
	for (const mode of ["direct", "stdin", "raw"]) {
		test(
			`recording FPS artifact collisions fail before dispatch: ${subcommand}/${mode}`,
			{ concurrency: false },
			async () => {
				await withFixture(async (root, harness, log) => {
					const path = join(root, "capture.webm");
					const step = ["record", subcommand, "--fps", "30", path];
					if (mode === "raw") {
						await writeFile(join(root, "raw-steps.json"), JSON.stringify([step]));
					}
					let params: { readonly args: readonly string[]; readonly stdin?: string };
					if (mode === "direct") {
						params = { args: step };
					} else if (mode === "stdin") {
						params = { args: ["batch"], stdin: JSON.stringify([step]) };
					} else {
						params = { args: ["batch", step.map((value) => JSON.stringify(value)).join(" ")] };
					}
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						...params,
						outputPath: path,
					});
					assert.equal(result.isError, true);
					assert.equal(readRecord(result.details).failureCategory, "validation-error");
					assert.match(result.content[0]?.text ?? "", /same destination as artifact path/);
					assert.equal(readRecord(result.details).exitCode, undefined);
					assert.deepEqual(await readInvocationLog(log), []);
					await assert.rejects(stat(path), { code: "ENOENT" });
				});
			},
		);
	}
}

test("batch screenshot normalization preserves a literal double-dash selector", async () => {
	const root = await mkdtemp(join(tmpdir(), "ad-"));
	try {
		const prepared = await prepareAgentBrowserArgs(
			["batch"],
			JSON.stringify([["screenshot", "--", "nested/capture.png"]]),
			root,
		);
		assert.deepEqual(JSON.parse(prepared.stdin ?? "[]"), [
			["screenshot", "--", join(root, "nested/capture.png")],
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const bail of [false, true]) {
	test(
		`batch screenshot requests track executed rows after empty rows: bail=${bail}`,
		{ concurrency: false },
		async () => {
			await withFixture(async (root, harness, log) => {
				const steps = [
					[],
					["screenshot", "first.png"],
					[],
					bail ? ["wait", "--text", "Never"] : ["get", "title"],
					["screenshot", "second.png"],
					[],
					["screenshot", "third.png"],
				];
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", ...(bail ? ["--bail"] : [])],
					stdin: JSON.stringify(steps),
				});
				assert.equal(result.isError, bail, result.content[0]?.text);
				const rows = readArray(readRecord(result.details).batchSteps).map(readRecord);
				assert.equal(rows.length, bail ? 2 : 4);
				assert.equal(rows[1].artifacts, undefined, "nonscreenshot rows keep their placeholder");
				for (const [index, name] of bail
					? ([[0, "first.png"]] as const)
					: ([
							[0, "first.png"],
							[2, "second.png"],
							[3, "third.png"],
						] as const)) {
					// Every expected screenshot row must retain its request; row count is asserted above.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(readArray(rows[index].artifacts)[0]).requestedPath, name);
					// Every expected screenshot row must resolve into this fixture's artifact directory.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						readRecord(readArray(rows[index].artifacts)[0]).absolutePath,
						join(root, name),
					);
					// Every expected screenshot row must report saved, including the bail-truncated variant.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(readArray(rows[index].artifacts)[0]).status, "saved");
				}
				const invocation = (await readInvocationLog(log)).find((row) => row.args.includes("batch"));
				assert.deepEqual(
					JSON.parse(invocation?.stdin ?? "[]"),
					steps.map((row) => (row[0] === "screenshot" ? [row[0], join(root, row[1])] : row)),
					"preparation preserves original empty rows and native positions",
				);
			});
		},
	);
}

test(
	"registered artifacts retain requested and reported paths without new argv normalization",
	{ concurrency: false },
	async () => {
		await withFixture(async (root, harness, log) => {
			const canonicalRoot = await realpath(root);
			const lexicalRoot =
				process.platform === "darwin" ? canonicalRoot.replace(/^\/private\/tmp\//, "/tmp/") : root;
			if (process.platform === "darwin") {
				// Only native macOS has this /tmp alias precondition; artifact outcomes run on every platform.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.notEqual(lexicalRoot, canonicalRoot, "exercise the native /tmp alias");
			}
			// Native screenshot's two-operand form disambiguates a non-image extension on Windows.
			for (const step of [
				["screenshot", "screen.png"],
				["screenshot", "canonical.png"],
				["screenshot", "body", "png.webm"],
				["download", "#download", "download.txt"],
				["network", "har", "stop", "network.har"],
			]) {
				const requestedPath = join(lexicalRoot, readString(step.at(-1)));
				const args = [...step.slice(0, -1), requestedPath];
				// The next native command reuses the session only after this artifact is verified.
				// oxlint-disable-next-line no-await-in-loop
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
				// Every fixed artifact-command variant must succeed before its path checks.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(result.isError, false, result.content[0]?.text);
				const artifact = readRecord(readArray(readRecord(result.details).artifacts)[0]);
				// Every fixed artifact command must retain its exact lexical caller path.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(artifact.requestedPath, requestedPath);
				const reportedPath =
					step[0] === "download" || requestedPath.includes("canonical")
						? // Resolve the artifact produced by the preceding native command before its assertions.
							// oxlint-disable-next-line no-await-in-loop
							await realpath(requestedPath)
						: requestedPath;
				// Every fixed artifact command must retain the independently observed native path.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok(
					[artifact.absolutePath, artifact.tempPath].includes(reportedPath),
					JSON.stringify({ artifact, reportedPath, args }),
				);
				// Every fixed artifact command must make its caller path visible.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok((result.content[0]?.text ?? "").includes(`Requested path: ${requestedPath}`));
				// Every fixed artifact command must make its native reported path visible.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.ok((result.content[0]?.text ?? "").includes(reportedPath));
				if (step[0] === "screenshot") {
					// The screenshot variants additionally require an image attachment; common paths are checked above.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(JSON.stringify(result.content), /"mimeType":"image\/png"/);
				}
				// Read the log before another native command can become its last matching row.
				// oxlint-disable-next-line no-await-in-loop
				const invocation = (await readInvocationLog(log))
					.reverse()
					.find((row) => row.args.includes(step[0]));
				// Every fixed artifact command must preserve its actual upstream argv.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.deepEqual(invocation?.args.slice(-args.length), args);
			}
		});
	},
);

test("recording transition warnings and ref lifecycles follow all reached native variants", async (t) => {
	await withFixture(async (_root, harness) => {
		const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
			args: ["open", pageUrl],
		});
		assert.equal(opened.isError, false, opened.content[0]?.text);
		for (const batch of [false, true]) {
			for (const [subcommand, withUrl, fails] of [
				["start", false, false],
				["start", false, true],
				["restart", true, false],
				["restart", true, true],
				["restart", false, false],
				["restart", false, true],
			] as const) {
				// Fresh native snapshots and unique recording paths isolate each ordered lifecycle variant.
				// oxlint-disable-next-line no-await-in-loop
				await t.test(
					`recording transition warning follows dispatch: ${batch ? "batch" : "direct"}/${subcommand}/${withUrl}/${fails}`,
					async () => {
						const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["snapshot", "-i"],
						});
						assert.equal(snapshot.isError, false);
						const step = [
							"record",
							subcommand,
							`take-${batch}-${subcommand}-${withUrl}-${fails ? "fail" : "ok"}.webm`,
							...(withUrl ? [pageUrl] : []),
						];
						const result = await executeRegisteredTool(
							harness.tool,
							harness.ctx,
							batch ? { args: ["batch", "--bail"], stdin: JSON.stringify([step]) } : { args: step },
						);
						const text = readString(readRecord(result.content[0]).text);
						assert.equal(result.isError, fails, text);
						const transitions = subcommand === "start" || withUrl;
						assert.equal((text.match(/Page state:/g) ?? []).length, transitions ? 1 : 0);
						if (transitions) {
							// Transitioning recording fixtures require conservative ref invalidation; all variants check page-state count above.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(text, /conservatively.*fresh snapshot/i);
							const invalidation = readRecord(readRecord(result.details).refSnapshotInvalidation);
							// Each declared transitioning recording fixture must retain structured invalidation.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(invalidation.reason, "page-transition");
							// Each transitioning fixture must distinguish conservative invalidation from observed navigation.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(readString(invalidation.summary), /conservatively/);
							// Each transitioning fixture must avoid claiming unobserved page replacement.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.doesNotMatch(
								`${text}\n${readString(invalidation.summary)}`,
								/replaced or navigated|fresh active page|state may not carry over/,
							);
						}
						const read = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["get", "value", "@e1"],
						});
						assert.equal(read.isError, transitions, read.content[0]?.text);
						if (transitions) {
							// Transitioning fixtures must classify the guarded follow-up; all variants check its error flag above.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(read.details?.failureCategory, "stale-ref");
						}
					},
				);
			}
		}
	});
});

test(
	"recording transition warning stays parseable in explicit JSON failures",
	{ concurrency: false },
	async () => {
		await withFixture(async (_root, harness) => {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--json", "record", "start", "fail.webm"],
			});
			const json = readRecord(JSON.parse(result.content[0]?.text ?? ""));
			assert.equal(json.success, false);
			assert.match(readString(json.error), /Recording already active/);
			assert.equal(readArray(json.warnings).length, 1);
			assert.match(readString(readArray(json.warnings)[0]), /Page state:.*fresh snapshot/);
			const restarted = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--json", "record", "restart", "json-ok.webm", pageUrl],
			});
			const success = readRecord(JSON.parse(restarted.content[0]?.text ?? ""));
			assert.equal(success.success, true);
			assert.equal(readArray(success.warnings).length, 1);
			assert.match(readString(readArray(success.warnings)[0]), /Page state:.*fresh snapshot/);
		});
	},
);

test(
	"an unparseable recording batch retains conservative ref invalidation without a reached-row warning",
	{ concurrency: false },
	async () => {
		await withFixture(async (_root, harness) => {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["record", "start", "unparseable.webm"]]),
			});
			const details = readRecord(result.details);
			assert.equal(result.isError, true);
			assert.equal(details.exitCode, 1);
			assert.equal(details.failureCategory, "upstream-error");
			assert.match(readString(details.parseError), /invalid JSON/);
			assert.equal(readRecord(details.refSnapshotInvalidation).reason, "page-transition");
			assert.doesNotMatch(result.content[0]?.text ?? "", /Page state:/);
		});
	},
);

test(
	"unidentified batch result rows do not turn planned recording steps into navigation evidence",
	{ concurrency: false },
	async () => {
		await withFixture(async (_root, harness) => {
			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["record", "start", "unidentified.webm"]]),
			});
			assert.equal(result.isError, true);
			assert.equal(
				readRecord(readArray(readRecord(result.details).batchSteps)[0]).command,
				undefined,
			);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Page state:/);
		});
	},
);

test(
	"recording warnings exclude unreached bail rows, preflight failures and a missing binary",
	{ concurrency: false },
	async () => {
		await withFixture(async (root, harness, log) => {
			const bailed = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch", "--bail"],
				stdin: JSON.stringify([
					["wait", "--text", "Never"],
					["record", "start", "unreached.webm"],
				]),
			});
			assert.equal(bailed.isError, true);
			assert.equal(readArray(bailed.details?.batchSteps).length, 1);
			assert.doesNotMatch(bailed.content[0]?.text ?? "", /Page state:/);
			const before = await readInvocationLog(log);
			const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["close"], ["record", "start", "blocked.webm"]]),
			});
			assert.equal(blocked.details?.failureCategory, "validation-error");
			assert.doesNotMatch(blocked.content[0]?.text ?? "", /Page state:/);
			assert.deepEqual(await readInvocationLog(log), before);
			const help = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["record", "start", "--help"],
			});
			assert.equal(help.isError, false);
			assert.doesNotMatch(help.content[0]?.text ?? "", /Page state:/);
			await rm(join(root, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser"));
			await withPatchedEnv({ PATH: root }, async () => {
				const missing = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", "missing.webm"],
				});
				assert.equal(missing.details?.failureCategory, "missing-binary");
				assert.doesNotMatch(missing.content[0]?.text ?? "", /Page state:/);
			});
		});
	},
);
